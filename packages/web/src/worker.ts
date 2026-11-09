/**
 * One engine task's worker: drives a persistent goal on a console-owned agent
 * session, fully unattended inside the project container.
 *
 * The session itself is created by SentinelRuntime.acquireTaskSession, in the
 * project's normal session directory: the task conversation appears in the 对话
 * list like any other, can be watched live while it runs, and stays available
 * after the task ends. This driver owns only the goal machinery — the same pure
 * state machine the console uses (goal.ts + goal-tool.ts): rounds close on
 * `agent_settled`, continuations are injected with `triggerTurn`, and the fuses
 * (round budget, no-progress, blocked streak) behave exactly like a console
 * goal. Every step is mirrored to the engine store for the 工程页 task view.
 */

import type { AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	advanceGoal,
	blockGoal,
	buildGoalContract,
	clampRoundLimit,
	completeGoal,
	createGoal,
	diffUsage,
	emptyUsage,
	extractRoundSummary,
	finishRound,
	GOAL_MESSAGE_CUSTOM_TYPE,
	GOAL_STATE_CUSTOM_TYPE,
	readGoalState,
	recordBlocker,
	recordRoundProgress,
	recordSubmission,
	resumeGoal,
	startRound,
} from "./goal.ts";
import type { GoalPort } from "./goal-tool.ts";
import { t } from "./i18n.ts";
import type {
	SentinelEngineEvent,
	SentinelEngineTask,
	SentinelEngineTaskContinue,
	SentinelGoal,
	SentinelGoalUsage,
} from "./protocol.ts";
import { messageText } from "./transcript.ts";

export interface WorkerSession {
	prompt(text: string, options?: unknown): Promise<unknown>;
	sendCustomMessage(message: unknown, options?: unknown): Promise<unknown>;
	abort(): Promise<unknown>;
	subscribe(handler: (event: AgentSessionEvent) => void): () => void;
	isStreaming: boolean;
	/** Not running and not compacting: an abort would have nothing to stop. */
	isIdle: boolean;
	messages: readonly unknown[];
	getSessionStats(): { tokens: { input: number; output: number; total: number }; cost?: number } | undefined;
}

/** How the engine acquires the console-owned session for one task. */
export type AcquireTaskSession = (input: {
	taskSessionId: string | null;
	/** Reopen the task's existing conversation instead of creating a new one. */
	reopen: boolean;
	goalPort: GoalPort;
	onFinding(): void;
}) => Promise<{ session: WorkerSession; manager: SessionManager; release(): void }>;

/** Terminal outcome the engine reacts to. */
export interface WorkerOutcome {
	status: "done" | "failed" | "blocked" | "aborted";
	summary: string;
	usage: SentinelGoalUsage;
}

/** A step before the engine assigns its sequence number. */
export type WorkerEventStep = Omit<SentinelEngineEvent, "seq">;

export interface WorkerHooks {
	/** The session exists; its id is durable, so resume can find the file. */
	onStarted(sessionId: string): void;
	/** One mirrored step; the engine assigns `seq`. */
	onEvent(event: WorkerEventStep): void;
	/** The task reached a terminal state (also fires for aborted). */
	onSettled(outcome: WorkerOutcome): void;
	/** Live state changed (round counter, usage); the engine refreshes the board. */
	onProgress(): void;
}

/** Appended to the system prompt so the worker knows its engineering role. */
export const WORKER_APPEND_PROMPT = [
	"You are running as the worker agent of a Full Chain Sentinel engineering run. Your instructions come from the commanding agent, not from the operator directly.",
	"Work autonomously inside the assigned working directory, keep every command inside the target scope stated in the objective, and finish with a concise, evidence-backed conclusion the commander can act on.",
	"Do not ask questions; state assumptions instead and keep going. Submit every validated finding to the vulnerability hub with vuln_submit before finishing.",
	"Report every asset you actually touch with asset_report, and record each test with asset_note before finishing.",
].join("\n");

export class EngineWorker {
	readonly task: SentinelEngineTask;
	private readonly acquire: AcquireTaskSession;
	private readonly hooks: WorkerHooks;
	private session: WorkerSession | undefined;
	private manager: SessionManager | undefined;
	private releaseSession: (() => void) | undefined;
	private unsubscribeWorker: () => void = () => {};
	private goal: SentinelGoal | undefined;
	private roundUsageStart: SentinelGoalUsage = emptyUsage();
	private roundToolCalls = 0;
	private submitted = 0;
	private settled = false;
	/**
	 * Set by `abort()` and `dispose()`. The session may not exist yet when a pause
	 * lands (it is still being acquired), so settling alone cannot stop the work:
	 * every path that would start or continue a round checks this first.
	 */
	private cancelled = false;
	private disposed = false;
	private starting = false;
	private timeLimitTimer: NodeJS.Timeout | undefined;
	/** Per-task fuses the engine derived from its limits. */
	private readonly limits: { tokenLimit: number | null; timeLimitMin: number | null };

	constructor(
		task: SentinelEngineTask,
		acquire: AcquireTaskSession,
		hooks: WorkerHooks,
		limits: { tokenLimit: number | null; timeLimitMin: number | null },
	) {
		this.task = task;
		this.acquire = acquire;
		this.hooks = hooks;
		this.limits = limits;
	}

	get sessionId(): string | null {
		return this.manager?.getSessionId() ?? this.task.sessionId ?? null;
	}

	get isRunning(): boolean {
		return (this.starting || this.session !== undefined) && !this.settled && !this.cancelled;
	}

	/** The engine uses this to keep a paused/aborted state from being overwritten. */
	get isCancelled(): boolean {
		return this.cancelled;
	}

	/** Usage of the worker session so far, relative to the task goal baseline when present. */
	currentUsage(): SentinelGoalUsage {
		if (!this.session) return this.task.usage ?? emptyUsage();
		const usage = usageOf(this.session.getSessionStats());
		return this.goal ? diffUsage(usage, this.goal.baseline) : usage;
	}

	/** Live round counters for the board. */
	goalState(): { roundsUsed: number; roundLimit: number; status: string } | null {
		return this.goal
			? { roundsUsed: this.goal.roundsUsed, roundLimit: this.goal.roundLimit, status: this.goal.status }
			: null;
	}

	/**
	 * Acquire (or reattach to) the session and start the first round.
	 *
	 * Acquisition is slow (session creation, extensions, MCP), and a pause can
	 * land inside it. In that case the worker was already cancelled before it had
	 * a session to abort; it must record the conversation for a later resume and
	 * then stop without prompting, or the task would run a whole untracked round
	 * under a paused engine.
	 */
	async start(): Promise<void> {
		this.starting = true;
		const continuation = this.task.pendingContinue;
		const { session, manager, release } = await this.acquire({
			taskSessionId: this.task.sessionId,
			// A task with a session id is always continued in that conversation,
			// whether it is a restart resume, a commander continuation, or a task the
			// operator reopened after it ended.
			reopen: this.task.sessionId !== null,
			goalPort: this.goalPort(),
			onFinding: () => this.noteFinding(),
		});
		this.session = session;
		this.manager = manager;
		this.releaseSession = release;
		this.hooks.onStarted(manager.getSessionId());
		if (this.disposed) {
			this.releaseSession = undefined;
			release();
			return;
		}
		if (this.stopped()) return;
		this.unsubscribeWorker = session.subscribe((event) => this.onEvent(event));

		if (continuation) {
			await this.continueGoal(continuation);
			return;
		}
		if (this.task.status === "paused" && this.task.sessionId !== null) {
			this.resumeGoal();
			return;
		}
		await this.startFreshGoal();
	}

	/** Fresh task: create the goal, write the contract, run the objective. */
	private async startFreshGoal(): Promise<void> {
		const session = this.requireSession();
		if (this.stopped()) return;
		const baseline = usageOf(session.getSessionStats());
		this.goal = startRound(
			createGoal({
				id: `goal-${this.task.id}`,
				objective: this.task.objective,
				criteria: this.task.criteria,
				roundLimit: this.task.roundLimit,
				baseline,
				at: Date.now(),
			}),
			"initial",
			Date.now(),
		);
		this.roundUsageStart = baseline;
		this.roundToolCalls = 0;
		this.submitted = 0;
		this.persistGoal();
		await session.sendCustomMessage(
			{ customType: GOAL_MESSAGE_CUSTOM_TYPE, content: buildGoalContract(this.goal, "initial"), display: true },
			{ triggerTurn: false },
		);
		// The contract write is an await: a pause can land here, after the session
		// exists but before the run has started. The goal state stays in the file
		// so a later continuation still resumes it.
		if (this.stopped()) return;
		this.armTimeLimit();
		this.hooks.onProgress();
		try {
			await session.prompt(this.task.objective, {});
		} catch (error) {
			this.settle("failed", t("启动失败：{error}", { error: errorText(error) }), this.currentUsage());
		}
	}

	/** Resumed task: bring the goal back from the session file and continue. */
	private resumeGoal(): void {
		if (this.stopped()) return;
		const session = this.requireSession();
		const restored = readGoalState(this.manager?.getBranch() ?? []);
		if (!restored || restored.status === "completed") {
			this.settle(
				"done",
				restored?.completion?.summary ?? t("任务会话已结束（恢复时未发现未完成目标）"),
				this.currentUsage(),
			);
			return;
		}
		const at = Date.now();
		this.goal = startRound(resumeGoal(restored, 1, at), "continue", at);
		this.roundUsageStart = usageOf(session.getSessionStats());
		this.roundToolCalls = 0;
		this.submitted = restored.submitted;
		this.persistGoal();
		this.armTimeLimit();
		this.hooks.onProgress();
		void session
			.sendCustomMessage(
				{ customType: GOAL_MESSAGE_CUSTOM_TYPE, content: buildGoalContract(this.goal, "continue"), display: true },
				{ triggerTurn: true },
			)
			.catch((error: unknown) => {
				this.settle("failed", t("恢复失败：{error}", { error: errorText(error) }), this.currentUsage());
			});
	}

	/**
	 * Commander continuation: reopen the task's own conversation and either revive
	 * its goal (paused, failed, blocked, or completed) or, for a conversation that
	 * predates goals, start a new goal on top of it. The old transcript stays in
	 * context; only the goal counters are extended.
	 */
	private async continueGoal(continuation: SentinelEngineTaskContinue): Promise<void> {
		if (this.stopped()) return;
		const session = this.requireSession();
		const restored = readGoalState(this.manager?.getBranch() ?? []);
		const criteria = continuation.criteria.map((item) => item.trim()).filter(Boolean);
		const at = Date.now();
		if (restored) {
			const base = criteria.length > 0 ? { ...restored, criteria } : restored;
			this.goal = startRound(resumeGoal(base, continuation.roundLimit, at), "continue", at);
			this.submitted = restored.submitted;
		} else {
			this.goal = startRound(
				createGoal({
					id: `goal-${this.task.id}-c${at}`,
					objective: this.task.objective,
					criteria: criteria.length > 0 ? criteria : this.task.criteria,
					roundLimit: clampRoundLimit(continuation.roundLimit),
					baseline: emptyUsage(),
					at,
				}),
				"initial",
				at,
			);
			this.submitted = 0;
		}
		this.roundUsageStart = usageOf(session.getSessionStats());
		this.roundToolCalls = 0;
		this.persistGoal();
		this.armTimeLimit();
		this.hooks.onProgress();
		try {
			await session.sendCustomMessage(
				{
					customType: GOAL_MESSAGE_CUSTOM_TYPE,
					content: buildGoalContract(this.goal, "continue", continuation.instruction),
					display: true,
				},
				{ triggerTurn: true },
			);
		} catch (error) {
			this.settle("failed", t("续跑启动失败：{error}", { error: errorText(error) }), this.currentUsage());
		}
	}

	/** Stop the run in flight; settles as aborted unless already terminal. */
	async abort(reason: string): Promise<void> {
		// Marked before the settled check: a worker that already settled still has
		// to refuse any continuation the SDK may have queued for it.
		this.cancelled = true;
		if (this.settled) return;
		if (this.timeLimitTimer) clearTimeout(this.timeLimitTimer);
		// Not just the visible streaming case: a session that is compacting has no
		// active run but must be aborted all the same, or the run resumes after it.
		if (this.session && !this.session.isIdle) await this.session.abort();
		this.settle("aborted", reason, this.currentUsage());
	}

	/** Queue an instruction into the running worker (steer / intel injection). */
	async steer(text: string): Promise<boolean> {
		const session = this.session;
		if (!session || this.settled || this.cancelled || !session.isStreaming) return false;
		await session.prompt(text, { streamingBehavior: "steer" });
		return true;
	}

	/** Release the live session; its persisted conversation remains reopenable. */
	dispose(): void {
		this.disposed = true;
		this.cancelled = true;
		if (this.timeLimitTimer) clearTimeout(this.timeLimitTimer);
		this.unsubscribeWorker();
		const release = this.releaseSession;
		this.releaseSession = undefined;
		release?.();
	}

	/** No round may start or continue once the worker was stopped. */
	private stopped(): boolean {
		return this.cancelled || this.settled;
	}

	// --- goal port ---------------------------------------------------------

	private goalPort(): GoalPort {
		return {
			current: () => this.goal,
			submitted: () => this.submitted,
			progress: (progress) => {
				if (!this.goal) return;
				this.goal = recordRoundProgress(this.goal, progress, Date.now());
				this.persistGoal();
				this.hooks.onProgress();
			},
			complete: (completion) => {
				if (!this.goal) return;
				this.goal = completeGoal(this.goal, completion);
				this.persistGoal();
			},
			blocked: (reason, evidence) => {
				if (!this.goal) return { streak: 0, accepted: false };
				const at = Date.now();
				const result = recordBlocker(this.goal, reason, at);
				this.goal = result.accepted ? blockGoal(result.goal, reason, evidence, result.streak, at) : result.goal;
				this.persistGoal();
				return { streak: result.streak, accepted: result.accepted };
			},
		};
	}

	private noteFinding(): void {
		this.submitted += 1;
		if (this.goal) {
			this.goal = recordSubmission(this.goal, Date.now());
			this.persistGoal();
		}
		this.hooks.onProgress();
	}

	// --- driver ------------------------------------------------------------

	private onEvent(event: AgentSessionEvent): void {
		if (event.type === "message_end") {
			if ((event.message as { role?: string }).role !== "assistant") return;
			for (const block of messageBlocks(event.message)) {
				if (block.type === "text" && block.text?.trim()) this.push({ kind: "text", text: block.text });
				else if (block.type === "thinking" && block.thinking?.trim())
					this.push({ kind: "thinking", text: block.thinking });
			}
		} else if (event.type === "tool_execution_start") {
			if (this.goal) this.roundToolCalls += 1;
			this.push({ kind: "tool_start", toolName: event.toolName, toolCallId: event.toolCallId, args: event.args });
		} else if (event.type === "tool_execution_end") {
			this.push({
				kind: "tool_end",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				isError: event.isError,
				output: toolResultText(event.result),
			});
		} else if (event.type === "agent_settled") {
			this.afterRoundSettled(event.aborted);
		}
	}

	/**
	 * Close the settled round and decide the next one. Mirrors the console's
	 * afterRoundSettled: fuses pause the goal, completions end it, and otherwise
	 * one continuation carries the recorded progress.
	 */
	private afterRoundSettled(aborted: boolean): void {
		if (this.stopped() || !this.goal || !this.session) return;
		const session = this.session;
		const at = Date.now();
		const usage = diffUsage(usageOf(session.getSessionStats()), this.roundUsageStart);
		const round = this.goal.rounds[this.goal.rounds.length - 1];
		const summary =
			round?.summaryFromTool === true ? undefined : extractRoundSummary(lastAssistantText(session.messages));
		const stoppedWithError = lastStopReason(session.messages) === "error";
		const providerError = stoppedWithError ? lastAssistantErrorMessage(session.messages) : undefined;
		const outcome = aborted
			? ("aborted" as const)
			: this.goal.status === "completed"
				? ("completed" as const)
				: this.goal.status === "blocked"
					? ("blocked" as const)
					: stoppedWithError
						? ("error" as const)
						: ("continued" as const);
		let goal = finishRound(this.goal, {
			at,
			toolCalls: this.roundToolCalls,
			usage,
			...(summary ? { summary } : {}),
			outcome,
		});
		this.roundToolCalls = 0;
		if (this.goal.status === "completed") {
			this.settle("done", this.goal.completion?.summary ?? t("任务完成"), this.currentUsage());
			return;
		}
		if (this.goal.status === "blocked") {
			this.settle("blocked", this.goal.blocked?.reason ?? t("任务阻塞"), this.currentUsage());
			return;
		}
		if (aborted) {
			this.settle("aborted", t("任务被中止"), this.currentUsage());
			return;
		}
		if (this.overTokenLimit()) {
			this.settle(
				"failed",
				t("任务超出 token 上限（已用 {total}）", { total: this.currentUsage().total }),
				this.currentUsage(),
			);
			return;
		}
		if (outcome === "error") {
			// The provider already exhausted its own retries. Another round starts the
			// same request again, so the decision belongs to the commander: it sees the
			// error and can continue on this conversation when the endpoint recovers.
			this.goal = goal;
			this.persistGoal();
			this.hooks.onProgress();
			this.settle(
				"failed",
				t("模型请求中断：{reason}（可用 continue_task 在原会话上续跑）", {
					reason: providerError ?? t("原因未知"),
				}),
				this.currentUsage(),
			);
			return;
		}
		const decision = advanceGoal(goal, at);
		goal = decision.goal;
		this.goal = goal;
		this.persistGoal();
		this.hooks.onProgress();
		if (decision.action === "stop") {
			// The round budget or the no-progress fuse tripped: the task has nothing
			// more to give on its own, so it goes back to the commander.
			this.settle(
				"failed",
				t("{note}（可用 continue_task 在原会话上续跑）", { note: goal.pauseNote ?? t("自动续跑停止") }),
				this.currentUsage(),
			);
			return;
		}
		const next = startRound(goal, "continue", at);
		this.goal = next;
		this.roundUsageStart = usageOf(session.getSessionStats());
		this.persistGoal();
		void session
			.sendCustomMessage(
				{ customType: GOAL_MESSAGE_CUSTOM_TYPE, content: buildGoalContract(next, "continue"), display: true },
				{ triggerTurn: true },
			)
			.catch((error: unknown) => {
				this.settle("failed", t("续跑启动失败：{error}", { error: errorText(error) }), this.currentUsage());
			});
	}

	/** Wall-clock fuse: a task that outlives its minutes is aborted by the engine. */
	private armTimeLimit(): void {
		if (this.limits.timeLimitMin === null) return;
		this.timeLimitTimer = setTimeout(() => {
			void this.abort(t("超出任务时间上限（{minutes} 分钟）", { minutes: String(this.limits.timeLimitMin) }));
		}, this.limits.timeLimitMin * 60_000);
	}

	/** Token fuse, checked between rounds: over budget means the task goes back to the commander. */
	private overTokenLimit(): boolean {
		return this.limits.tokenLimit !== null && this.currentUsage().total > this.limits.tokenLimit;
	}

	private settle(status: WorkerOutcome["status"], summary: string, usage: SentinelGoalUsage): void {
		if (this.settled) return;
		this.settled = true;
		if (this.timeLimitTimer) clearTimeout(this.timeLimitTimer);
		this.push({
			kind: "status",
			status: status === "done" ? "done" : status === "aborted" ? "aborted" : "error",
			note: summary,
		});
		this.hooks.onSettled({ status, summary, usage });
	}

	private persistGoal(): void {
		this.manager?.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, this.goal ?? null);
	}

	private requireSession(): WorkerSession {
		if (!this.session) throw new Error("worker session not started");
		return this.session;
	}

	private push(step: Omit<SentinelEngineEvent, "seq" | "at">): void {
		this.hooks.onEvent({ ...step, at: Date.now() });
	}
}

/** Token and cost counters of a session, in the shape a goal stores them. */
function usageOf(stats: ReturnType<WorkerSession["getSessionStats"]> | undefined): SentinelGoalUsage {
	if (!stats) return emptyUsage();
	return {
		input: stats.tokens.input,
		output: stats.tokens.output,
		total: stats.tokens.total,
		cost: typeof stats.cost === "number" ? stats.cost : null,
	};
}

interface MessageBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

function messageBlocks(message: unknown): MessageBlock[] {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) ? (content as MessageBlock[]) : [];
}

function toolResultText(result: unknown): string {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return "";
	return (content as MessageBlock[])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function lastAssistantText(messages: readonly unknown[]): string | undefined {
	const last = [...messages].reverse().find((message) => (message as { role?: string }).role === "assistant");
	return last ? messageText(last) : undefined;
}

function lastStopReason(messages: readonly unknown[]): string | undefined {
	const last = [...messages].reverse().find((message) => (message as { role?: string }).role === "assistant");
	return (last as { stopReason?: string } | undefined)?.stopReason;
}

function lastAssistantErrorMessage(messages: readonly unknown[]): string | undefined {
	const last = [...messages].reverse().find((message) => (message as { role?: string }).role === "assistant");
	const error = (last as { errorMessage?: unknown } | undefined)?.errorMessage;
	return typeof error === "string" && error.trim() ? error.trim() : undefined;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Parse `target [note]` lines; used by both the engine and the commander brief. */
export function parseTargetLines(text: string): { target: string; note?: string }[] {
	const targets: { target: string; note?: string }[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const separator = trimmed.search(/[\s,，]/);
		if (separator === -1) {
			targets.push({ target: trimmed });
			continue;
		}
		const target = trimmed.slice(0, separator).trim();
		const note = trimmed.slice(separator + 1).trim();
		if (target) targets.push(note ? { target, note } : { target });
	}
	return targets;
}
