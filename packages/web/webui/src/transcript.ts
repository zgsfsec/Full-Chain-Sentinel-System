/**
 * Transcript shape for the chat page: how messages group into runs, and when a
 * run folds into its single "过程" row.
 *
 * This is separate from the rendering so it can be tested without a DOM, and so
 * the rules are readable in one place. The transcript is the session's full
 * branch (see the server's `transcript.ts`), which means a compaction shows up
 * as a marker row in the middle of the conversation instead of replacing
 * everything above it.
 */

import { t } from "./i18n.ts";
import type { AgentMessageView } from "./types.ts";

/**
 * Identity of one transcript message. The event stream and the snapshot carry the
 * same objects, so role plus timestamp matches them; a message without a
 * timestamp falls back to its content.
 */
export function messageKey(message: { role?: string; timestamp?: number }): string {
	return `${message.role ?? "?"}:${message.timestamp ?? JSON.stringify(message)}`;
}

/** What a custom message says: its type and its content, which is how its two copies are matched. */
export function customStamp(message: Extract<AgentMessageView, { role: "custom" }>): string {
	return `${message.customType}:${JSON.stringify(message.content)}`;
}

/**
 * Whether a message that arrived through the event stream is already carried by
 * the snapshot, and so must stop being rendered from the event-built list.
 *
 * A message is matched by role plus timestamp. A custom message is the
 * exception: the SDK stamps the event with the time the message was sent at, and
 * the session entry — which is what the snapshot is built from — with the time
 * it was appended, a few milliseconds later, so the two never share a key. Left
 * alone, the event's copy outlived its run at the end of the transcript, and a
 * folded run shows its last message: a modeling run ended on a second「已启动」
 * card and its closing summary never appeared. Those are matched by what they
 * say instead. Two custom messages can say the same thing, so only as many
 * pending copies are matched as the snapshot holds; `pending` is the list the
 * message sits in, which is what lets the copies be counted one by one.
 */
export function isInSnapshot(
	message: AgentMessageView,
	snapshot: readonly AgentMessageView[],
	pending: readonly AgentMessageView[],
): boolean {
	const key = messageKey(message);
	if (snapshot.some((entry) => messageKey(entry) === key)) return true;
	if (message.role !== "custom") return false;
	const stamp = customStamp(message);
	const sameWords = (entry: AgentMessageView) => entry.role === "custom" && customStamp(entry) === stamp;
	const held = snapshot.filter(sameWords).length;
	// Copies of the same message ahead of this one in the pending list are matched first.
	const position = pending.indexOf(message);
	const ahead = position < 0 ? 0 : pending.slice(0, position).filter(sameWords).length;
	return ahead < held;
}

/** Text blocks of a message or content list, ignoring thinking and tool calls. */
export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" && block !== null && (block as { type: string }).type === "text",
		)
		.map((block) => block.text)
		.join("");
}

/** Timestamp of a message, for messages that carry one. */
function messageTimestamp(message: AgentMessageView | undefined): number | undefined {
	if (!message || !("timestamp" in message)) return undefined;
	return typeof message.timestamp === "number" ? message.timestamp : undefined;
}

/** Timestamp of the first message in a stretch that has one. */
function firstTimestamp(messages: readonly AgentMessageView[]): number | undefined {
	for (const message of messages) {
		const timestamp = messageTimestamp(message);
		if (timestamp !== undefined) return timestamp;
	}
	return undefined;
}

/** Elapsed time of a run, as the fold row reports it. */
function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	// Rounded to the second before it is split: rounding the remainder on its own
	// turns 119.6 seconds into "1m60s".
	const seconds = Math.round(ms / 1000);
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/** What a folded run did, for its one-line row: tool calls, thinking rounds, elapsed. */
export function runDigest(prompt: AgentMessageView | undefined, body: readonly AgentMessageView[]): string {
	const tools = body.filter((message) => message.role === "toolResult" || message.role === "bashExecution").length;
	const thinking = body.filter(
		(message) =>
			message.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some((block) => (block as { type?: string }).type === "thinking"),
	).length;
	const parts: string[] = [];
	if (tools > 0) parts.push(t("{count} 次工具调用", { count: tools }));
	if (thinking > 0) parts.push(t("{count} 段思考", { count: thinking }));
	const compactions = body.filter((message) => isSummaryMessage(message)).length;
	if (compactions > 0) parts.push(t("{count} 次压缩", { count: compactions }));
	// A stretch with no prompt of its own (what a compaction kept) still reports
	// its elapsed time, measured from its own first timestamped message.
	const started = messageTimestamp(prompt) ?? firstTimestamp(body);
	const ended = messageTimestamp(body[body.length - 1]);
	if (typeof started === "number" && typeof ended === "number" && ended > started) {
		parts.push(formatDuration(ended - started));
	}
	return parts.join(" · ");
}

/** Token counts, in the short form the stats and the summary row both use. */
export function formatTokens(count: number): string {
	if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

/** Byte sizes, for the file panel and the composer's attachment chips. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Whether a message is a summary that marks where the context was cut. Summaries
 * are part of the run they happened in — the fold row reports them as 压缩 —
 * they just render as their own folded card when the run is expanded.
 */
export function isSummaryMessage(message: AgentMessageView): boolean {
	return message.role === "compactionSummary" || message.role === "branchSummary";
}

/**
 * Whether a message is a goal row: the contract injected when a goal starts, or
 * the one injected for each automatic continuation. It is a boundary like a
 * prompt, so the round it starts folds under it instead of being appended to the
 * previous round's body.
 */
export function isGoalMessage(message: AgentMessageView): boolean {
	return message.role === "custom" && message.customType === "zg-goal";
}

/** How the line that closes a modeling run opens: 【… · 结束】. */
const CLOSING_RUN = /^【[^【】]* · 结束】/;

/**
 * Whether a message is a marker the console injects on the operator's action
 * rather than during a run: the briefing that starts a modeling run. Like a goal
 * row it is a boundary: the run a briefing starts folds under it, so its card
 * stays in view, and a second run started in the same conversation is a stretch
 * of its own, not folded into the first with the idle time in between counted as
 * work. The line that closes a run is not a boundary: it is a notice inside the run.
 */
export function isModelingBoundary(message: AgentMessageView): boolean {
	if (message.role !== "custom" || message.customType !== "zg-modeling") return false;
	return !CLOSING_RUN.test(textFromContent(message.content).trimStart());
}

export interface RunGroup {
	key: string;
	/** The operator instruction this run answers; absent for a kept stretch with no prompt. */
	prompt?: AgentMessageView;
	body: AgentMessageView[];
}

/**
 * Group the transcript into runs: a prompt and everything it produced, up to the
 * next prompt. Grouping is what lets a finished run fold into one row, and it
 * also gives the run's tool calls their shared timeline rail.
 *
 * A compaction summary stays inside the run it happened in: it is process, not a
 * boundary — one task that went through N compactions folds into ONE row (the
 * digest reports 压缩), and the summaries render as their own cards only when
 * the run is expanded. A goal row and a modeling marker are boundaries: each
 * automatic round is its own stretch, and folding one round into another would
 * hide where the agent continued on its own.
 */
export function groupRuns(messages: readonly AgentMessageView[]): RunGroup[] {
	const groups: RunGroup[] = [];
	for (const message of messages) {
		if (message.role === "user" || isGoalMessage(message) || isModelingBoundary(message)) {
			groups.push({ key: `run-${messageKey(message)}`, prompt: message, body: [] });
			continue;
		}
		const last = groups[groups.length - 1];
		if (last) last.body.push(message);
		else groups.push({ key: `head-${messageKey(message)}`, body: [message] });
	}
	return groups;
}

/**
 * Whether a message is a notice the console folds into its own card: loop-guard
 * aborts, modeling start/close rows, and supervisor advice. The loop guard
 * lands at the END of a run (the nudge is injected once the run has settled),
 * so a run may legitimately end on one — and it must still fold, because the
 * card already says why the run was cut. Supervisor advice is also a notice:
 * it can land after an aborted turn, and must not leave the run open.
 */
export function isNoticeMessage(message: AgentMessageView): boolean {
	return (
		message.role === "custom" &&
		(message.customType === "zg-loop-guard" || message.customType === "zg-modeling")
	);
}

/**
 * Whether a run may fold, and whether it is folded right now. Only a run whose
 * last word is prose can fold: a failure, an abort or a turn cut off mid-tool
 * has to stay visible, because the error is the point. The run in flight never
 * folds either, so the operator watches it happen.
 *
 * A trailing notice (输出重复已中止 and friends) does not block the fold: it is
 * itself a folded card, and without this allowance every stutter abort would
 * leave its whole run — every tool call and thinking block — stuck expanded.
 */
export function runFoldState(options: {
	groups: readonly RunGroup[];
	index: number;
	streaming: boolean;
	expanded: ReadonlySet<string>;
}): { collapsed: boolean; digest: string } | undefined {
	const { groups, index, streaming, expanded } = options;
	const group = groups[index];
	if (!group || group.body.length === 0) return undefined;
	if (streaming && index === groups.length - 1) return undefined;
	const last = group.body[group.body.length - 1];
	// Skip a trailing notice and judge the run by its substantive last word; a
	// deliberate cut (the notice) is explanation enough for the aborted assistant
	// message in front of it, which on its own would keep the run open.
	const notice = isNoticeMessage(last);
	const lastWord = notice ? group.body[group.body.length - 2] : last;
	if (!lastWord) return undefined;
	// A settled run that ends on a tool result was cut mid-step — a stutter abort
	// or a compaction landed between the tool call and the model's next word. The
	// tool card already shows its own outcome, so the stretch folds; the live run
	// is exempt through the streaming check above.
	if (lastWord.role === "toolResult" || lastWord.role === "bashExecution") {
		return { collapsed: !expanded.has(group.key), digest: runDigest(group.prompt, group.body) };
	}
	if (lastWord.role !== "assistant") return undefined;
	if (lastWord.errorMessage) return undefined;
	if (!notice && (lastWord.stopReason === "error" || lastWord.stopReason === "aborted")) return undefined;
	// A thinking-only ending (the model was cut by a compaction boundary before
	// saying anything) is still a finished process step: the fold row reports the
	// thinking rounds. Only silence — no text, no thinking — stays open.
	const content = Array.isArray(lastWord.content) ? lastWord.content : [];
	const saidAnything =
		content.some((block) => (block as { type?: string }).type === "thinking") ||
		textFromContent(lastWord.content).length > 0;
	if (!notice && !saidAnything) return undefined;
	return { collapsed: !expanded.has(group.key), digest: runDigest(group.prompt, group.body) };
}
