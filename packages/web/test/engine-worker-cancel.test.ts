/**
 * Regression: pause/abort has to be a hard interrupt. A worker whose session was
 * still being acquired (or whose first prompt had not started yet) was settled as
 * "aborted" but then kept going: it acquired the session, wrote the goal contract,
 * and ran the whole objective — an untracked "zombie" conversation under a paused
 * engine, with ungated container commands and no board state.
 */

import type { AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import type { SentinelEngineTask } from "../src/protocol.ts";
import { type AcquireTaskSession, EngineWorker, type WorkerSession } from "../src/worker.ts";

interface FakeSession extends WorkerSession {
	prompts: string[];
	customMessages: { triggerTurn?: boolean }[];
	abortCalls: number;
	emit(event: AgentSessionEvent): void;
}

function fakeSession(options: { gateCustomMessage?: Promise<void> } = {}): FakeSession {
	const listeners: ((event: AgentSessionEvent) => void)[] = [];
	const session: FakeSession = {
		prompts: [],
		customMessages: [],
		abortCalls: 0,
		isStreaming: false,
		isIdle: true,
		prompt: async (text: string) => {
			session.prompts.push(text);
			session.isStreaming = true;
			session.isIdle = false;
		},
		sendCustomMessage: async (_message: unknown, raw?: unknown) => {
			session.customMessages.push((raw ?? {}) as { triggerTurn?: boolean });
			if (options.gateCustomMessage) await options.gateCustomMessage;
		},
		abort: async () => {
			session.abortCalls += 1;
			session.isStreaming = false;
			session.isIdle = true;
		},
		subscribe: (handler) => {
			listeners.push(handler);
			return () => {
				const index = listeners.indexOf(handler);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		messages: [],
		getSessionStats: () => ({ tokens: { input: 0, output: 0, total: 0 } }),
		emit: (event) => {
			for (const listener of [...listeners]) listener(event);
		},
	};
	return session;
}

function task(overrides: Partial<SentinelEngineTask> = {}): SentinelEngineTask {
	return {
		id: "t1",
		engineId: "e1",
		title: "侦察",
		objective: "扫描目标",
		target: "10.0.0.1",
		workspace: "w",
		status: "queued",
		attempt: 1,
		criteria: [],
		roundLimit: 3,
		pendingContinue: null,
		presetId: null,
		presetName: null,
		sessionId: null,
		startedAt: null,
		endedAt: null,
		summary: null,
		error: null,
		usage: null,
		vulns: 0,
		autoResume: false,
		...overrides,
	};
}

function managerOf(): SessionManager {
	return {
		getSessionId: () => "s1",
		appendCustomEntry: () => {},
		getBranch: () => [],
	} as unknown as SessionManager;
}

function workerFor(acquire: AcquireTaskSession, settled: string[] = []): EngineWorker {
	return new EngineWorker(
		task(),
		async (input) => acquire(input),
		{
			onStarted: () => {},
			onEvent: () => {},
			onSettled: (outcome) => settled.push(outcome.status),
			onProgress: () => {},
		},
		{ tokenLimit: null, timeLimitMin: null },
	);
}

const immediateFor = (session: FakeSession) => async () => ({ session, manager: managerOf(), release: () => {} });

test("abort while the session is being acquired leaves the objective unstarted", async () => {
	const session = fakeSession();
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const settled: string[] = [];
	const worker = workerFor(async () => {
		await gate;
		return { session, manager: managerOf(), release: () => {} };
	}, settled);

	const started = worker.start();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await worker.abort("操作员暂停");
	expect(settled).toEqual(["aborted"]);
	release();
	await started;

	expect(worker.isCancelled).toBe(true);
	expect(session.prompts).toEqual([]);
	expect(session.abortCalls).toBe(0);
});

test("abort between the goal contract and the first prompt leaves the objective unstarted", async () => {
	const session = fakeSession();
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	session.sendCustomMessage = async (_message: unknown, raw?: unknown) => {
		session.customMessages.push((raw ?? {}) as { triggerTurn?: boolean });
		await gate;
	};
	const settled: string[] = [];
	const worker = workerFor(immediateFor(session), settled);

	const started = worker.start();
	// Let acquisition finish so the worker is inside the contract write.
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(session.customMessages).toHaveLength(1);
	await worker.abort("操作员暂停");
	release();
	await started;

	expect(settled).toEqual(["aborted"]);
	expect(session.prompts).toEqual([]);
});

test("a worker that is not cancelled still runs its objective", async () => {
	const session = fakeSession();
	const settled: string[] = [];
	const worker = workerFor(immediateFor(session), settled);

	await worker.start();

	expect(session.prompts).toEqual(["扫描目标"]);
	expect(settled).toEqual([]);
});

test("dispose stops a settled round from queueing its continuation", async () => {
	const session = fakeSession();
	const worker = workerFor(immediateFor(session));

	await worker.start();
	expect(session.prompts).toEqual(["扫描目标"]);
	expect(session.customMessages).toHaveLength(1);

	// The engine disposed the worker (pause already settled it, manager shutdown,
	// or slot cleanup) and then the SDK reports the round boundary.
	worker.dispose();
	session.emit({ type: "agent_settled", aborted: false } as AgentSessionEvent);

	expect(session.customMessages).toHaveLength(1);
});

test("abort of a compacting session still aborts it", async () => {
	const session = fakeSession();
	// Compaction has no active run, so isStreaming stays false while isIdle is false.
	const worker = workerFor(immediateFor(session));
	await worker.start();
	session.isStreaming = false;
	session.isIdle = false;

	await worker.abort("操作员暂停");

	expect(session.abortCalls).toBe(1);
});

test("a worker reserves its concurrency slot while acquiring its session", async () => {
	let acquired: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		acquired = resolve;
	});
	const worker = workerFor(async () => {
		await gate;
		return { session: fakeSession(), manager: managerOf(), release: () => {} };
	});
	expect(worker.isRunning).toBe(false);
	const started = worker.start();
	expect(worker.isRunning).toBe(true);
	await worker.abort("stop");
	expect(worker.isRunning).toBe(false);
	acquired();
	await started;
	worker.dispose();
});

test("disposing during acquisition releases the eventual session exactly once", async () => {
	let acquired: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		acquired = resolve;
	});
	const session = fakeSession();
	let releases = 0;
	const worker = workerFor(async () => {
		await gate;
		return {
			session,
			manager: managerOf(),
			release: () => {
				releases += 1;
			},
		};
	});
	const started = worker.start();
	worker.dispose();
	acquired();
	await started;
	worker.dispose();
	expect(releases).toBe(1);
	expect(session.prompts).toEqual([]);
});

test("disposing an acquired worker returns ownership to the runtime once", async () => {
	let releases = 0;
	const worker = workerFor(async () => ({
		session: fakeSession(),
		manager: managerOf(),
		release: () => {
			releases += 1;
		},
	}));
	await worker.start();
	worker.dispose();
	worker.dispose();
	expect(releases).toBe(1);
});
