/**
 * Unit tests for the worker's continuation paths.
 *
 * The commander can only control a task if the worker actually reopens the
 * same conversation: a continuation that quietly started a fresh session would
 * lose every conclusion the task had produced. A provider error is the other
 * half — it must stop and hand the decision back instead of spending the round
 * budget on the same failing request.
 */

import type { AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { completeGoal, createGoal, GOAL_STATE_CUSTOM_TYPE, readGoalState, startRound } from "../src/goal.ts";
import type { SentinelEngineTask, SentinelGoal } from "../src/protocol.ts";
import { EngineWorker, type WorkerOutcome } from "../src/worker.ts";

function task(over: Partial<SentinelEngineTask>): SentinelEngineTask {
	return {
		id: "task-1",
		engineId: "engine-1",
		title: "继续侦察",
		objective: "对 10.0.0.5 完成侦察",
		target: "10.0.0.5",
		workspace: "w",
		status: "failed",
		attempt: 1,
		criteria: ["端口已确认"],
		roundLimit: 3,
		presetId: null,
		presetName: null,
		pendingContinue: null,
		sessionId: null,
		startedAt: null,
		endedAt: null,
		summary: null,
		error: null,
		usage: null,
		vulns: 0,
		autoResume: false,
		...over,
	};
}

function finishedGoal(): SentinelGoal {
	return completeGoal(
		startRound(
			createGoal({
				id: "goal-1",
				objective: "对 10.0.0.5 完成侦察",
				criteria: ["端口已确认"],
				roundLimit: 3,
				baseline: { input: 0, output: 0, total: 0, cost: null },
				at: 1000,
			}),
			"initial",
			1000,
		),
		{
			summary: "完成",
			evidence: ["nmap"],
			submitted: 0,
			findingsNote: "",
			criteria: [],
			at: 2000,
		},
	);
}

interface FakeSession {
	readonly sent: Array<{ message: { content: string; display: boolean }; options?: unknown }>;
	readonly prompts: string[];
	messages: unknown[];
	isStreaming: boolean;
	isIdle: boolean;
	prompt(text: string, options?: unknown): Promise<void>;
	sendCustomMessage(message: unknown, options?: unknown): Promise<void>;
	abort(): Promise<void>;
	subscribe(handler: (event: AgentSessionEvent) => void): () => void;
	getSessionStats(): { tokens: { input: number; output: number; total: number }; cost: number };
	settle(aborted?: boolean): void;
}

function fakeSession(): FakeSession {
	let handler: ((event: AgentSessionEvent) => void) | undefined;
	return {
		sent: [],
		prompts: [],
		messages: [],
		isStreaming: false,
		isIdle: true,
		async prompt(text) {
			this.prompts.push(text);
		},
		async sendCustomMessage(message, options) {
			const custom = message as { content: unknown };
			this.sent.push({ message: { content: String(custom.content), display: true }, options });
		},
		async abort() {},
		subscribe(next) {
			handler = next;
			return () => {
				handler = undefined;
			};
		},
		getSessionStats() {
			return { tokens: { input: 10, output: 5, total: 15 }, cost: 0 };
		},
		settle(aborted = false) {
			handler?.({ type: "agent_settled", aborted } as unknown as AgentSessionEvent);
		},
	};
}

function fakeManager(sessionId: string, branch: unknown[]): { manager: SessionManager; entries: unknown[] } {
	const entries = [...branch];
	const manager = {
		getSessionId: () => sessionId,
		getBranch: () => entries,
		appendCustomEntry: (type: string, data: unknown) => {
			entries.push({ type: "custom", customType: type, data });
		},
	};
	return { manager: manager as unknown as SessionManager, entries };
}

test("a continuation reopens the same session and injects the commander instruction", async () => {
	const session = fakeSession();
	const branch = [{ type: "custom", customType: GOAL_STATE_CUSTOM_TYPE, data: finishedGoal() }];
	const { manager, entries } = fakeManager("session-1", branch);
	let reopen: boolean | undefined;
	let taskSessionId: string | null | undefined;
	const worker = new EngineWorker(
		task({
			sessionId: "session-1",
			pendingContinue: {
				instruction: "重试被 429 中断的端口扫描",
				criteria: ["端口已确认", "问题已提交"],
				roundLimit: 2,
				requestedAt: 3000,
			},
		}),
		async (input) => {
			reopen = input.reopen;
			taskSessionId = input.taskSessionId;
			return { session, manager, release: () => {} };
		},
		{ onStarted: () => {}, onEvent: () => {}, onSettled: () => {}, onProgress: () => {} },
		{ tokenLimit: null, timeLimitMin: null },
	);

	await worker.start();

	expect(reopen).toBe(true);
	expect(taskSessionId).toBe("session-1");
	// The objective is not re-sent as a new prompt; the continuation rides on the
	// reopened transcript.
	expect(session.prompts).toEqual([]);
	expect(session.sent).toHaveLength(1);
	expect(session.sent[0].options).toEqual({ triggerTurn: true });
	expect(session.sent[0].message.content).toContain("【持续目标续跑】");
	expect(session.sent[0].message.content).toContain("重试被 429 中断的端口扫描");
	expect(session.sent[0].message.content).toContain("1. 端口已确认");
	// The completed goal is active again with the requested extra rounds.
	const goal = readGoalState(entries);
	expect(goal?.status).toBe("active");
	expect(goal?.completion).toBeUndefined();
	expect(goal?.roundLimit).toBe(5);
	expect(goal?.roundsUsed).toBe(1);
	expect(goal?.criteria).toEqual(["端口已确认", "问题已提交"]);
	worker.dispose();
});

test("a provider error hands the task back instead of burning another round", async () => {
	const session = fakeSession();
	const { manager, entries } = fakeManager("session-2", []);
	const outcomes: WorkerOutcome[] = [];
	const worker = new EngineWorker(
		task({ status: "queued", criteria: [], sessionId: null }),
		async () => ({ session, manager, release: () => {} }),
		{ onStarted: () => {}, onEvent: () => {}, onSettled: (outcome) => outcomes.push(outcome), onProgress: () => {} },
		{ tokenLimit: null, timeLimitMin: null },
	);

	await worker.start();
	session.messages = [{ role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests" }];
	session.settle();

	expect(outcomes).toHaveLength(1);
	expect(outcomes[0].status).toBe("failed");
	expect(outcomes[0].summary).toContain("模型请求中断");
	expect(outcomes[0].summary).toContain("429 Too Many Requests");
	expect(outcomes[0].summary).toContain("continue_task");
	// One initial contract, and no continuation turn after the error.
	expect(session.sent).toHaveLength(1);
	// The failed round is on record, so a later continuation starts from it.
	const goal = readGoalState(entries);
	expect(goal?.status).toBe("active");
	expect(goal?.rounds[goal.rounds.length - 1]?.outcome).toBe("error");
	worker.dispose();
});

test("a normal round still continues on its own", async () => {
	const session = fakeSession();
	const { manager, entries } = fakeManager("session-3", []);
	const outcomes: WorkerOutcome[] = [];
	const worker = new EngineWorker(
		task({ status: "queued", criteria: [], sessionId: null }),
		async () => ({ session, manager, release: () => {} }),
		{ onStarted: () => {}, onEvent: () => {}, onSettled: (outcome) => outcomes.push(outcome), onProgress: () => {} },
		{ tokenLimit: null, timeLimitMin: null },
	);

	await worker.start();
	session.messages = [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "端口已扫完" }] }];
	session.settle();

	expect(outcomes).toEqual([]);
	expect(session.sent).toHaveLength(2);
	expect(session.sent[1].options).toEqual({ triggerTurn: true });
	expect(session.sent[1].message.content).toContain("上一轮结论：端口已扫完");
	const goal = readGoalState(entries);
	expect(goal?.roundsUsed).toBe(1);
	expect(goal?.rounds).toHaveLength(2);
	worker.dispose();
});
