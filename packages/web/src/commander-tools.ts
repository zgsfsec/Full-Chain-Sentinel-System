/**
 * The commander's tool set: pure scheduling, no execution. The commander may
 * dispatch tasks, steer or abort them, inspect the task board, and close the
 * engine with a final report — and that is all. There is deliberately no bash,
 * read, or edit: the commander assigns work, it never does the work.
 */

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CodeReproductionResult } from "./code-reproduction.ts";
import type { SentinelEngineTask, SentinelEngineTaskStatus } from "./protocol.ts";

/** Dispatch outcome the commander sees as the tool result. */
interface DispatchDetails {
	ok: boolean;
	taskId?: string;
	position?: number;
	attempt?: number;
	error?: string;
}

/** What the engine has to provide for the commander's tools to act. */
type MaybePromise<T> = T | Promise<T>;

export interface CommanderPort {
	/**
	 * Whether a task may run without a preset. Read once, when the commander's tools
	 * are built: like the brief, a mid-run flip reaches the commander on resume.
	 */
	presetOptional: boolean;
	/** Queue a task; the engine assigns id, attempt, workspace, and turn order. */
	dispatch(input: {
		title: string;
		objective: string;
		target: string | null;
		criteria: string[];
		roundLimit: number | null;
		/** Preset agent id to run the task as; null uses the default agent. */
		presetId: string | null;
	}): { task?: SentinelEngineTask; position?: number; error?: string };
	/** Stop one task (queued or running) with a reason. */
	abortTask(taskId: string, reason: string): MaybePromise<{ ok: boolean; error?: string }>;
	/** Queue an instruction into a running task (intel injection, mid-course correction). */
	steerTask(taskId: string, instruction: string): MaybePromise<{ ok: boolean; error?: string }>;
	/**
	 * Continue a non-running task in its own conversation. Used for recovery from
	 * provider errors and for new phases on top of finished work.
	 */
	continueTask(
		taskId: string,
		input: { instruction: string; criteria: string[]; roundLimit: number | null },
	): MaybePromise<{ task?: SentinelEngineTask; position?: number; error?: string }>;
	/** The task board right now, for `list_tasks`. */
	board(): SentinelEngineTask[];
	/** Declare the engine finished; refused while work is outstanding. */
	finish(report: string, reproduction?: CodeReproductionResult): MaybePromise<{ ok: boolean; error?: string }>;
}

const TASK_STATUS_LABELS: Record<SentinelEngineTaskStatus, string> = {
	queued: "排队中",
	running: "运行中",
	done: "已完成",
	failed: "失败",
	blocked: "已阻塞",
	aborted: "已中止",
	paused: "已暂停",
};

/** Render the board compactly: the commander reads this, not the console. */
export function formatTaskBoard(tasks: readonly SentinelEngineTask[]): string {
	if (tasks.length === 0) return "（当前没有任务）";
	return tasks
		.map(
			(task) =>
				`- [${TASK_STATUS_LABELS[task.status]}] ${task.id}「${task.title}」目标：${task.target ?? "（未指定）"}，第 ${task.attempt} 次派发` +
				// The preset is part of what a re-dispatch must decide: a failed task
				// re-dispatched as the same preset is the same attempt twice.
				`，预设：${task.presetName ?? "默认 Agent"}` +
				(task.summary ? `，结论：${task.summary}` : "") +
				(task.error ? `，错误：${task.error}` : "") +
				// Terminal and paused tasks keep their conversation; saying so here is
				// what makes continue_task discoverable at the moment it is needed.
				(task.status === "queued" || task.status === "running" ? "" : "；可 continue_task 续跑"),
		)
		.join("\n");
}

/**
 * `list_tasks` gets polled in a tight loop by some models while they wait for
 * a task to finish, which burns tokens and clutters the decision log. The
 * window refuses calls beyond the budget and tells the commander to end its
 * turn instead — task results are pushed to it, it does not need to watch.
 */
const POLL_WINDOW_MS = 60_000;
const POLL_MAX_CALLS = 6;

function createPollGuard(): () => string | null {
	const calls: number[] = [];
	return () => {
		const now = Date.now();
		while (calls.length > 0 && now - calls[0] > POLL_WINDOW_MS) calls.shift();
		if (calls.length >= POLL_MAX_CALLS) {
			return "轮询过于频繁：任务结束时你会自动收到结果摘要，无需盯着看板。请直接结束本轮回复（不再调用任何工具），等待下一条任务摘要。";
		}
		calls.push(now);
		return null;
	};
}

/**
 * Retry accounting for one dispatch. Decomposition is free: any number of
 * successful tasks may share a target (recon, then web depth, then
 * post-exploit...). Only failed, blocked, or aborted tasks count against the
 * retry budget — those are the re-dispatches the limit exists for.
 */
export function retryDecision(
	priorTasks: ReadonlyArray<{ status: string }>,
	maxRetries: number,
	target: string,
): { allowed: boolean; attempt: number; failures: number; error?: string } {
	const failures = priorTasks.filter((task) => ["failed", "blocked", "aborted"].includes(task.status)).length;
	const attempt = priorTasks.length + 1;
	if (failures > maxRetries) {
		return {
			allowed: false,
			attempt,
			failures,
			error: `目标 ${target} 已有 ${failures} 次失败派发，超过重试上限（${maxRetries} 次重试）；成功的多阶段任务不受此限，可继续派发新阶段`,
		};
	}
	return { allowed: true, attempt, failures };
}

export function createCommanderTools(port: CommanderPort): ToolDefinition[] {
	const pollGuard = createPollGuard();
	const dispatch = defineTool({
		name: "dispatch_task",
		label: "Dispatch task",
		description:
			"Queue one task for a worker agent. The objective must be fully self-contained: the worker cannot ask questions and does not see this conversation. Split a target into as many focused tasks as needed; one task = one clear objective.",
		promptSnippet: "Dispatch one self-contained task to a worker agent",
		promptGuidelines: [
			"Write objectives that stand alone: target, scope, method hints, and what counts as done",
			"Dispatch parallel-friendly tasks instead of one giant task per target",
			"When re-dispatching a failed target, change the approach and say what to do differently",
			port.presetOptional
				? "Set `preset` to the listed preset agent whose description and tags fit the task; omit it when none fits and let the task run as the default agent"
				: "Every task must name a `preset` from the listed preset agents; a dispatch without one is refused, so pick the closest match",
		],
		parameters: Type.Object({
			title: Type.String({
				minLength: 1,
				maxLength: 120,
				description: "Short task title, e.g. 「10.0.0.1 Web 侦察」",
			}),
			objective: Type.String({
				minLength: 1,
				description:
					"Complete instructions for the worker: target, scope, constraints, expected output, and acceptance criteria in prose.",
			}),
			target: Type.Optional(
				Type.String({
					description:
						"The target this task belongs to (host/URL). Required for retry accounting; omit for target-wide work.",
				}),
			),
			criteria: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Acceptance criteria, one per line item; the worker must answer each before declaring done.",
				}),
			),
			round_limit: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 99,
					description: "Automatic continuation rounds for this task; omit to use the engine default.",
				}),
			),
			preset: Type.Optional(
				Type.String({
					description: port.presetOptional
						? "Preset agent id this task should run as, from the 「可用预设 Agent」 list. Omit to use the default agent. An id outside that list is refused."
						: "Preset agent id this task must run as, from the 「可用预设 Agent」 list. Required here: a dispatch without one is refused, as is an id outside that list.",
				}),
			),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<DispatchDetails>> {
			const result = port.dispatch({
				title: params.title.trim(),
				objective: params.objective.trim(),
				target: params.target?.trim() || null,
				criteria: (params.criteria ?? []).map((item) => item.trim()).filter(Boolean),
				roundLimit: params.round_limit ?? null,
				presetId: params.preset?.trim() || null,
			});
			if (result.error || !result.task) {
				return {
					content: [{ type: "text", text: `派发失败：${result.error ?? "未知错误"}` }],
					details: { ok: false, error: result.error },
					isError: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `任务已派发：${result.task.id}「${result.task.title}」第 ${result.task.attempt} 次派发，当前排队位置 ${result.position}。任务结束后会收到结果摘要。`,
					},
				],
				details: { ok: true, taskId: result.task.id, position: result.position, attempt: result.task.attempt },
			};
		},
	});

	const listTasks = defineTool({
		name: "list_tasks",
		label: "Task board",
		description:
			"List every task of this engine with its current status, attempt, and last conclusion. Read this before deciding what to dispatch next.",
		parameters: Type.Object({}),
		async execute(): Promise<AgentToolResult> {
			const throttled = pollGuard();
			if (throttled) {
				return { content: [{ type: "text", text: throttled }], details: undefined, isError: true };
			}
			return { content: [{ type: "text", text: formatTaskBoard(port.board()) }], details: undefined };
		},
	});

	const abortTask = defineTool({
		name: "abort_task",
		label: "Abort task",
		description:
			"Abort one queued or running task. Use for tasks that are pointless now (scope change, duplicate work, hopelessly stuck) so they stop consuming rounds.",
		parameters: Type.Object({
			task_id: Type.String({ description: "The task id from dispatch_task or list_tasks." }),
			reason: Type.String({ description: "Why the task is being aborted; recorded on the task." }),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult> {
			const result = await port.abortTask(params.task_id.trim(), params.reason.trim());
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `中止失败：${result.error}` }],
					details: undefined,
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `任务 ${params.task_id} 已中止：${params.reason.trim()}` }],
				details: undefined,
			};
		},
	});

	const steerTask = defineTool({
		name: "steer_task",
		label: "Steer task",
		description:
			"Send an instruction into a running task. Use to inject intelligence from other tasks (verified credentials, fingerprints, working techniques) or to correct course mid-run.",
		parameters: Type.Object({
			task_id: Type.String({ description: "The running task to steer." }),
			instruction: Type.String({ description: "The instruction or intelligence to deliver, self-contained." }),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult> {
			const result = await port.steerTask(params.task_id.trim(), params.instruction.trim());
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `注入失败：${result.error}` }],
					details: undefined,
					isError: true,
				};
			}
			return { content: [{ type: "text", text: `指令已注入任务 ${params.task_id}。` }], details: undefined };
		},
	});

	const continueTask = defineTool({
		name: "continue_task",
		label: "Continue task",
		description:
			"Continue a task that ended (done, failed, blocked, aborted) or was paused, reusing its existing conversation and conclusions. Use after a transient model failure (429, timeout), when its round budget ran out, or to start a new phase on top of finished work. Not for queued/running tasks: use steer_task for those.",
		promptSnippet: "Continue an ended task in its existing conversation",
		promptGuidelines: [
			"Use this for recovery: the worker already has the transcript, so tell it what to do next rather than restating the whole objective",
			"Use dispatch_task instead when the work should start from a clean context or on a different target",
			"One continuation adds one more run; it does not rewrite the task's original objective unless you provide new criteria",
		],
		parameters: Type.Object({
			task_id: Type.String({ description: "The ended or paused task to continue, from list_tasks." }),
			instruction: Type.String({
				minLength: 1,
				description:
					"What to do next, written as a continuation: account for what the worker already found and state the new goal.",
			}),
			criteria: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Acceptance criteria for this continuation; when given they replace the original criteria for the goal.",
				}),
			),
			round_limit: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 99,
					description: "Additional automatic continuation rounds to grant; omit to use the engine default.",
				}),
			),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult> {
			const result = await port.continueTask(params.task_id.trim(), {
				instruction: params.instruction.trim(),
				criteria: (params.criteria ?? []).map((item) => item.trim()).filter(Boolean),
				roundLimit: params.round_limit ?? null,
			});
			if (result.error || !result.task) {
				return {
					content: [{ type: "text", text: `续跑失败：${result.error ?? "未知错误"}` }],
					details: undefined,
					isError: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `任务已重新排队续跑：${result.task.id}「${result.task.title}」，当前排队位置 ${result.position ?? 0}。它会带着原有会话继续，结束后会收到结果摘要。`,
					},
				],
				details: undefined,
			};
		},
	});

	const engineDone = defineTool({
		name: "engine_done",
		label: "Finish engine",
		description:
			"Archive the final Markdown report and its local images in the project report center, then finish the engineering run. Relative image paths use /work. Download remote images into the project first. If archiving fails, correct the report and retry. Refused while tasks are queued or running: settle those first.",
		parameters: Type.Object({
			report: Type.String({
				description:
					"Final markdown report: per-target outcomes, findings summary (hub labels), failures and why, and what the operator should review next.",
			}),
			reproduction: Type.Optional(
				Type.Object({
					outcome: Type.Union(
						[
							Type.Literal("confirmed"),
							Type.Literal("not_reproduced"),
							Type.Literal("inconclusive"),
							Type.Literal("failed"),
						],
						{
							description:
								"For security-fix reproduction: confirmed requires actual vulnerable/fixed version comparison; not_reproduced means the test ran but did not trigger; inconclusive means insufficient evidence; failed means environment/build/execution failed. Required for oss-1day-repro engines.",
						},
					),
					summary: Type.String({
						minLength: 1,
						maxLength: 4000,
						description:
							"Evidence-based conclusion or the concrete blocker. A completed task alone does not prove reproduction.",
					}),
					pocPath: Type.Optional(
						Type.String({
							maxLength: 8000,
							description: "PoC path in the project container. Required for confirmed.",
						}),
					),
					vulnerableEvidence: Type.Optional(
						Type.String({
							maxLength: 8000,
							description: "Actual command and observed vulnerable-version output. Required for confirmed.",
						}),
					),
					fixedEvidence: Type.Optional(
						Type.String({
							maxLength: 8000,
							description: "Same test's command and observed fixed-version output. Required for confirmed.",
						}),
					),
				}),
			),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult> {
			const result = await port.finish(params.report.trim(), params.reproduction);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `不能结束工程：${result.error}` }],
					details: undefined,
					isError: true,
				};
			}
			return { content: [{ type: "text", text: "工程已结束，总报告已归档。" }], details: undefined };
		},
	});

	return [dispatch, listTasks, abortTask, steerTask, continueTask, engineDone];
}
