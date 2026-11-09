/**
 * Loop hygiene as a built-in extension: cut a run short when it stops making
 * progress instead of letting it burn the token budget.
 *
 * Two guards, both injected as one synthetic message so the operator sees what
 * happened in the transcript:
 *
 * - Stuttering output. The stream repeats one line or a short cycle; the
 *   extension aborts the request at the repetition, trims the degenerate tail so
 *   it does not re-enter the context, and starts the next run with a nudge to try
 *   something else. After a few nudges it stops continuing, because a model that
 *   keeps stuttering needs the operator, not another round.
 * - Repeated tool calls: the same tool with the same arguments, counted per
 *   session, reported at 3, 5 and 8 consecutive calls. The chain is advisory; it
 *   never aborts. A new operator prompt resets it, and tools outside the tracked
 *   set are transparent.
 *
 * Both reminders are `custom_message` entries, which is also how goal mode injects
 * its contract: the model reads them as a user message, and the console folds them
 * as a notice rather than an operator prompt. A tool reminder is committed at the
 * turn boundary; a stutter nudge is sent once the run has settled, because an
 * aborted run cannot be continued from a boundary.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { CustomMessageEntryDraft, ExtensionFactory } from "../../core/extensions/types.ts";
import { RepeatChain, type RepeatThresholdHit, StutterDetector, type StutterSignal } from "./detect.ts";

/** `customType` of every message this extension injects. */
export const LOOP_GUARD_CUSTOM_TYPE = "zg-loop-guard";

/** How many stutters one prompt may be nudged through before the guard gives up. */
const MAX_STUTTER_NUDGES = 3;
/** Characters of the repeated arguments quoted in a tool reminder. */
const ARGUMENTS_PREVIEW_CHARS = 500;

const STUTTER_PREFIX = "【输出重复】";
const REPEAT_PREFIX = "【重复工具调用】";
const TRIM_MARKER = "\n\n[输出因重复被中止，尾部已截断]";

export function createLoopGuardExtension(): ExtensionFactory {
	return (pi) => {
		const stutter = new StutterDetector();
		const repeat = new RepeatChain();
		/** Tool reminders waiting for the turn boundary they belong to. */
		let toolReminders: CustomMessageEntryDraft[] = [];
		/**
		 * A stutter nudge, delivered once the run has stopped. Aborting ends the run
		 * for good: the agent loop returns as soon as a message comes back `aborted`
		 * and ignores any `continue` from the turn boundary, so the reminder has to
		 * arrive through `sendMessage` at settle, which starts the next run itself.
		 */
		let stutterNudge: { draft: CustomMessageEntryDraft; continueRun: boolean } | undefined;
		let stutterNudges = 0;
		/** Whether the current message is still worth watching: false once it has tripped. */
		let armed = true;
		/**
		 * Set when a message trips, so its tail is trimmed as it ends. The flag is not
		 * the message object: `message_update` emits a shallow copy, so the object that
		 * reaches `message_end` is never the one the detector saw.
		 */
		let trimPending = false;
		let trippedOffset = 0;

		pi.on("message_start", (event) => {
			if (event.message.role === "assistant") {
				stutter.reset();
				armed = true;
				return;
			}
			if (event.message.role !== "user") return;
			// A new operator prompt is new context: repetition across it is not a loop.
			repeat.reset();
			stutterNudges = 0;
		});

		pi.on("message_update", (event, ctx) => {
			// Updates keep arriving until the abort reaches the provider; the message
			// already tripped, so the rest is the same repetition.
			if (!armed || event.message.role !== "assistant") return;
			const signal = stutter.push(messageText(event.message));
			if (!signal) return;
			armed = false;
			stutter.reset();
			trimPending = true;
			trippedOffset = signal.offset;
			const exhausted = stutterNudges >= MAX_STUTTER_NUDGES;
			stutterNudges += 1;
			stutterNudge = { draft: stutterDraft(signal, exhausted), continueRun: !exhausted };
			ctx.abort();
		});

		pi.on("message_end", (event) => {
			if (!trimPending || event.message.role !== "assistant") return;
			trimPending = false;
			// Keep what came before the repetition; that is the part worth reading.
			return { message: trimStutter(event.message, trippedOffset) };
		});

		pi.on("tool_execution_start", (event) => {
			const hit = repeat.observe(event.toolName, event.args);
			if (!hit) return;
			toolReminders = [...toolReminders, repeatDraft(event.toolName, hit)];
		});

		// The turn boundary is where a draft becomes a session entry the model reads
		// on the next request. Tool reminders are advisory, so they need no `continue`:
		// a message with tool calls already keeps the run going by itself.
		pi.on("turn_end", (event) => {
			if (toolReminders.length === 0) return;
			const entries = [...event.entries, ...toolReminders];
			toolReminders = [];
			return { entries };
		});

		// `pi.sendMessage` is the only way to reach the model after the run has ended:
		// a turn-boundary draft is committed, but its `continue` is ignored once the
		// message came back aborted, so the nudge is sent at settle instead. Sending it
		// while the session settles defers the prompt, which then starts the next run.
		pi.on("agent_settled", () => {
			const nudge = stutterNudge;
			if (!nudge) return;
			stutterNudge = undefined;
			pi.sendMessage(
				{
					customType: nudge.draft.customType,
					content: nudge.draft.content,
					display: nudge.draft.display,
					details: nudge.draft.details,
				},
				{ triggerTurn: nudge.continueRun },
			);
		});
	};
}

/** The text a stutter is visible in: prose and reasoning both stream token by token. */
function messageText(message: AssistantMessage): string {
	let text = "";
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
		else if (block.type === "thinking") text += block.thinking;
	}
	return text;
}

/**
 * Drop the degenerate tail of an aborted message. The repeated text is what the
 * model would read back on the next request, so keeping it invites the same loop.
 */
function trimStutter(message: AssistantMessage, keep: number): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	let budget = keep;
	for (const block of message.content) {
		if (block.type === "text" || block.type === "thinking") {
			if (budget <= 0) continue;
			if (block.type === "text") {
				const text = block.text.length > budget ? block.text.slice(0, budget) : block.text;
				budget -= text.length;
				content.push({ ...block, text });
			} else {
				const thinking = block.thinking.length > budget ? block.thinking.slice(0, budget) : block.thinking;
				budget -= thinking.length;
				content.push({ ...block, thinking });
			}
			continue;
		}
		content.push(block);
	}
	content.push({ type: "text", text: TRIM_MARKER });
	return { ...message, content };
}

function stutterDraft(signal: StutterSignal, exhausted: boolean): CustomMessageEntryDraft {
	const repeated =
		signal.kind === "lines"
			? `同一行连续出现 ${signal.count} 次`
			: signal.kind === "lines_total"
				? `同一行在近期输出中反复出现 ${signal.count} 次`
				: `同一段内容重复约 ${signal.count} 次`;
	const next = exhausted
		? "重复已经连续发生多次，本轮不再自动继续。请检查上下文（必要时压缩上下文或换一个模型）后重新下达指令。"
		: "请换一种方式继续：先用一两句话说明目前的进展和下一步打算，然后执行下一步，不要重复已经输出过的内容。";
	return {
		type: "custom_message",
		customType: LOOP_GUARD_CUSTOM_TYPE,
		display: true,
		content: `${STUTTER_PREFIX}上一次输出陷入了重复（${repeated}，片段：${signal.preview}），已被提前中止。\n${next}`,
		details: { kind: "stutter", signal: signal.kind, count: signal.count, preview: signal.preview, exhausted },
	};
}

function repeatDraft(toolName: string, hit: RepeatThresholdHit): CustomMessageEntryDraft {
	const args =
		hit.canonical.length > ARGUMENTS_PREVIEW_CHARS
			? `${hit.canonical.slice(0, ARGUMENTS_PREVIEW_CHARS)}…（还有 ${hit.canonical.length - ARGUMENTS_PREVIEW_CHARS} 个字符）`
			: hit.canonical;
	const content = hit.detailed
		? `${REPEAT_PREFIX}同一个工具调用已经连续重复 ${hit.count} 次：\n- 工具：${toolName}\n- 参数：${args}\n这些重复没有带来进展。不要再用完全相同的参数调用这个工具：先看最新一次的结果，然后换一种方法、换一组参数，或者如果证据已经足够就结束任务。`
		: `${REPEAT_PREFIX}同一个工具调用（${toolName}）已经连续重复 ${hit.count} 次，参数完全一样。再次调用前先仔细分析上一次的结果：如果任务还没完成，换一种方法或换一组参数。`;
	return {
		type: "custom_message",
		customType: LOOP_GUARD_CUSTOM_TYPE,
		display: true,
		content,
		details: { kind: "repeat", tool: toolName, count: hit.count, arguments: args },
	};
}

export default createLoopGuardExtension();
