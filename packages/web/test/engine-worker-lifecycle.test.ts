import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSessionEvent, createLoopGuardExtension, type SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { createHarness } from "../../coding-agent/test/suite/harness.ts";
import { type EngineHooks, EngineManager, type RuntimeAcquireTaskSession } from "../src/engine.ts";
import { EngineStore } from "../src/engine-store.ts";
import { readGoalState } from "../src/goal.ts";
import { createGoalTools } from "../src/goal-tool.ts";
import type { SentinelEngine, SentinelEngineTaskStatus } from "../src/protocol.ts";
import type { EngineWorker, WorkerSession } from "../src/worker.ts";

interface LiveEntry {
	engine: SentinelEngine;
	workers: Map<string, EngineWorker>;
}

/** Exercise the real scheduler and SQLite store without a commander/provider. */
interface ManagerInternals {
	store: EngineStore;
	live: Map<string, LiveEntry>;
	startTask(entry: LiveEntry, taskId: string): Promise<void>;
	promptCommander(entry: LiveEntry, text: string): Promise<void>;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
});

function setup(acquire: RuntimeAcquireTaskSession, hookOverrides: Partial<EngineHooks> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-engine-lifecycle-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify({
			projects: [{ id: "p1", name: "Test", container: "fake-container", workDir: dir, createdAt: "" }],
		}),
	);
	const seed = new EngineStore(join(dir, "engines.db"));
	const engine = seed.createEngine({
		projectId: "p1",
		projectName: "Test",
		name: "Lifecycle",
		targets: [{ target: "example.test" }],
		doctrines: [],
		gateMode: "auto",
		limits: { concurrency: 1, roundLimit: 3, tokenLimit: null, timeLimitMin: null, maxRetries: 0 },
	});
	seed.close();
	const hooks = { onChange: vi.fn(), onCommanderEvent: vi.fn(), onTaskEvent: vi.fn(), ...hookOverrides };
	const manager = new EngineManager(dir, hooks, acquire);
	cleanups.push(() => manager.dispose());
	const internals = manager as unknown as ManagerInternals;
	vi.spyOn(internals, "promptCommander").mockResolvedValue();
	const entry = internals.live.get(engine.id);
	if (!entry) throw new Error("Missing live engine");
	internals.store.setEngineStatus(engine.id, "running", null, null);
	entry.engine = internals.store.getEngine(engine.id) ?? engine;
	const addTask = () =>
		internals.store.createTask({
			engineId: engine.id,
			title: "Task",
			objective: "Inspect example.test",
			target: null,
			workspace: "test",
			roundLimit: 3,
			attempt: 1,
		});
	return { manager, internals, entry, hooks, addTask };
}

function fakeSession() {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session: WorkerSession = {
		isStreaming: false,
		isIdle: true,
		messages: [],
		prompt: vi.fn(async () => {
			session.isStreaming = true;
			session.isIdle = false;
		}),
		sendCustomMessage: vi.fn(async () => {}),
		abort: vi.fn(async () => {
			session.isStreaming = false;
			session.isIdle = true;
			emit({ type: "agent_settled", aborted: true });
		}),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSessionStats: () => ({ tokens: { input: 1, output: 2, total: 3 } }),
	};
	const manager = {
		getSessionId: () => "fake-session",
		getBranch: () => [],
		appendCustomEntry: () => {},
	} as unknown as SessionManager;
	return { session, manager, emit, release: vi.fn() };
}

// Full-Chain-Sentinel-System #6: startup exceptions must not leave running rows without workers.
test("acquisition failure records a terminal state and starts the next queued task", async () => {
	const next = fakeSession();
	const acquire = vi
		.fn<RuntimeAcquireTaskSession>()
		.mockRejectedValueOnce(new Error("session acquisition failed"))
		.mockResolvedValue(next);
	const { internals, entry, addTask, hooks } = setup(acquire);
	const first = addTask();
	const second = addTask();
	await internals.startTask(entry, first.id);
	expect(internals.store.getTask(first.id)).toMatchObject({
		status: "failed",
		endedAt: expect.any(Number),
		error: expect.stringContaining("session acquisition failed"),
	});
	expect(entry.workers.has(first.id)).toBe(false);
	expect(internals.store.getTask(second.id)?.status).toBe("running");
	expect(acquire).toHaveBeenCalledTimes(2);
	expect(hooks.onChange).toHaveBeenCalled();
});

// Full-Chain-Sentinel-System #6: notification failures cannot prevent task settlement.
test("an aborted event still finalizes the task when its live event hook throws", async () => {
	const fake = fakeSession();
	fake.session.prompt = async () => {
		fake.emit({ type: "agent_settled", aborted: true });
	};
	const { internals, entry, addTask } = setup(async () => fake, {
		onTaskEvent: (_id, event) => {
			if (event.status === "aborted") throw new Error("live event delivery failed");
		},
	});
	const task = addTask();
	await internals.startTask(entry, task.id);
	expect(internals.store.getTask(task.id)).toMatchObject({ status: "aborted", summary: "任务被中止" });
	expect(entry.workers.has(task.id)).toBe(false);
});

test("a loop-guard abort keeps the worker slot while recovery is pending", async () => {
	const first = fakeSession();
	const second = fakeSession();
	first.session.prompt = async () => {
		first.session.messages = [
			{
				role: "assistant",
				stopReason: "aborted",
				content: [
					{
						type: "text",
						text: "[输出因重复被中止，尾部已截断]",
					},
				],
			},
		];
		first.emit({ type: "agent_settled", aborted: true });
	};
	const acquire = vi.fn<RuntimeAcquireTaskSession>().mockResolvedValueOnce(first).mockResolvedValue(second);
	const { internals, entry, addTask } = setup(acquire);
	const recovering = addTask();
	const queued = addTask();
	await internals.startTask(entry, recovering.id);
	expect(internals.store.getTask(recovering.id)).toMatchObject({ status: "running", endedAt: null });
	expect(internals.store.getTask(queued.id)?.status).toBe("queued");
	expect(entry.workers.get(recovering.id)?.isRunning).toBe(true);
	expect(acquire).toHaveBeenCalledOnce();
});

test.each([1, 3, 4])("%i stutters recover under the real worker or stop at the guard's limit", async (trips) => {
	const next = fakeSession();
	let taskHarness: Awaited<ReturnType<typeof createHarness>> | undefined;
	const { internals, entry, addTask } = setup(async (input) => {
		if (input.taskSessionId === "next") return next;
		const harness = await createHarness({
			extensionFactories: [
				createLoopGuardExtension(),
				(pi) => {
					for (const tool of createGoalTools(input.goalPort)) pi.registerTool(tool);
				},
			],
		});
		taskHarness = harness;
		cleanups.push(harness.cleanup);
		const taskId = input.taskId;
		harness.setResponses([
			...Array.from({ length: trips }, () => fauxAssistantMessage(`分析如下：\n${"Kingston.\n\n".repeat(40)}`)),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("【输出重复】");
				expect(internals.store.getTask(taskId)?.status).toBe("running");
				expect(entry.workers.get(taskId)?.isRunning).toBe(true);
				expect(internals.store.getTask(queued.id)?.status).toBe("queued");
				expect(readGoalState(harness.sessionManager.getBranch())).toMatchObject({
					status: "active",
					roundsUsed: 0,
					noProgressStreak: 0,
				});
				return fauxAssistantMessage(
					fauxToolCall("goal_complete", {
						summary: "恢复后完成",
						evidence: ["隔离测试结果"],
						findings: { submitted: 0, note: "测试目标无漏洞" },
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("恢复后完成。"),
		]);
		return { session: harness.session, manager: harness.sessionManager, release: () => {} };
	});
	const task = addTask();
	const queued = addTask();
	internals.store.updateTask(queued.id, { sessionId: "next" });
	await internals.startTask(entry, task.id);
	if (trips === 4) {
		expect(internals.store.getTask(task.id)).toMatchObject({
			status: "failed",
			summary: expect.stringContaining("输出重复，自动恢复次数已用尽"),
		});
		expect(taskHarness?.getPendingResponseCount()).toBe(2);
		expect(readGoalState(taskHarness?.sessionManager.getBranch() ?? [])).toMatchObject({
			status: "paused",
			pauseReason: "loop-guard",
			roundsUsed: 0,
		});
	} else {
		expect(internals.store.getTask(task.id)).toMatchObject({ status: "done", summary: "恢复后完成" });
		expect(taskHarness?.getPendingResponseCount()).toBe(0);
	}
	expect(entry.workers.has(task.id)).toBe(false);
	expect(internals.store.getTask(queued.id)?.status).toBe("running");
});

test("an operator can abort a real worker during loop-guard recovery", async () => {
	let recoveryStarted: () => void = () => {};
	const recovering = new Promise<void>((resolve) => {
		recoveryStarted = resolve;
	});
	const { manager, internals, entry, addTask } = setup(async () => {
		const harness = await createHarness({ extensionFactories: [createLoopGuardExtension()] });
		cleanups.push(harness.cleanup);
		harness.setResponses([
			fauxAssistantMessage(`分析如下：\n${"Kingston.\n\n".repeat(40)}`),
			async (_context, options) => {
				recoveryStarted();
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("已停止", { stopReason: "aborted" });
			},
		]);
		return { session: harness.session, manager: harness.sessionManager, release: () => {} };
	});
	const task = addTask();
	const started = internals.startTask(entry, task.id);
	await recovering;
	expect(internals.store.getTask(task.id)?.status).toBe("running");
	expect(await manager.abortTask(task.id, "operator stop during recovery")).toEqual({ ok: true });
	await started;
	expect(internals.store.getTask(task.id)).toMatchObject({
		status: "aborted",
		summary: expect.stringContaining("operator stop during recovery"),
	});
	expect(entry.workers.has(task.id)).toBe(false);
});

// Full-Chain-Sentinel-System #6: an already orphaned row must be recoverable without a restart.
test("abort recovers a running task with no worker and fills the freed slot", async () => {
	const acquire = vi.fn<RuntimeAcquireTaskSession>().mockResolvedValue(fakeSession());
	const { manager, internals, entry, addTask } = setup(acquire);
	const orphan = addTask();
	const next = addTask();
	internals.store.updateTask(orphan.id, { status: "running", sessionId: "old-session" });
	internals.store.appendEvent(orphan.id, { seq: 1, at: Date.now(), kind: "text", text: "previous output" });
	expect(await manager.abortTask(orphan.id, "stop orphan")).toEqual({ ok: true });
	expect(internals.store.getTask(orphan.id)).toMatchObject({
		status: "aborted",
		endedAt: expect.any(Number),
		sessionId: "old-session",
		error: expect.stringContaining("stop orphan"),
	});
	expect(internals.store.getTask(next.id)?.status).toBe("running");
	expect(entry.workers.has(orphan.id)).toBe(false);
	expect(manager.taskEvents(orphan.id)[0]).toMatchObject({ kind: "text", text: "previous output" });
	expect(manager.taskEvents(orphan.id).at(-1)).toMatchObject({ kind: "status", status: "aborted" });
});

// Full-Chain-Sentinel-System #6: failed persistence must leave a settled worker recoverable.
test("abort recovers a settled worker after its terminal state could not be saved", async () => {
	const first = fakeSession();
	const acquire = vi.fn<RuntimeAcquireTaskSession>().mockResolvedValueOnce(first).mockResolvedValue(fakeSession());
	const { manager, internals, entry, addTask } = setup(acquire);
	const task = addTask();
	const next = addTask();
	await internals.startTask(entry, task.id);
	const worker = entry.workers.get(task.id);
	const updateTask = internals.store.updateTask.bind(internals.store);
	let failOnce = true;
	vi.spyOn(internals.store, "updateTask").mockImplementation((id, patch) => {
		if (id === task.id && patch.status === "aborted" && failOnce) {
			failOnce = false;
			throw new Error("temporary storage failure");
		}
		return updateTask(id, patch);
	});
	expect(() => first.emit({ type: "agent_settled", aborted: true })).toThrow("temporary storage failure");
	expect(internals.store.getTask(task.id)?.status).toBe("running");
	expect(entry.workers.get(task.id)).toBe(worker);
	expect(worker?.isRunning).toBe(false);
	expect(await manager.abortTask(task.id, "recover stopped worker")).toEqual({ ok: true });
	expect(internals.store.getTask(task.id)?.status).toBe("aborted");
	expect(entry.workers.has(task.id)).toBe(false);
	expect(internals.store.getTask(next.id)?.status).toBe("running");
});

// Full-Chain-Sentinel-System #6: a live board notification cannot stall queued work.
test("a board notification failure still schedules the next task after settlement", async () => {
	const first = fakeSession();
	const acquire = vi.fn<RuntimeAcquireTaskSession>().mockResolvedValueOnce(first).mockResolvedValue(fakeSession());
	let failOnce = true;
	const { internals, entry, addTask } = setup(acquire, {
		onChange: (engine) => {
			if (failOnce && engine.tasks.some((task) => task.status === "aborted")) {
				failOnce = false;
				throw new Error("live board delivery failed");
			}
		},
	});
	const task = addTask();
	const next = addTask();
	await internals.startTask(entry, task.id);
	expect(() => first.emit({ type: "agent_settled", aborted: true })).toThrow("live board delivery failed");
	expect(internals.store.getTask(task.id)?.status).toBe("aborted");
	expect(internals.store.getTask(next.id)?.status).toBe("running");
});

// Full-Chain-Sentinel-System #6: preserve an operator cancellation when late startup fails.
test("a late acquisition failure does not overwrite an explicit abort", async () => {
	let rejectAcquisition: (error: Error) => void = () => {};
	const acquisition = new Promise<Awaited<ReturnType<RuntimeAcquireTaskSession>>>((_resolve, reject) => {
		rejectAcquisition = reject;
	});
	const { manager, internals, entry, addTask } = setup(() => acquisition);
	const task = addTask();
	const started = internals.startTask(entry, task.id);
	await manager.abortTask(task.id, "operator stop");
	rejectAcquisition(new Error("late acquisition failure"));
	await started;
	expect(internals.store.getTask(task.id)).toMatchObject({
		status: "aborted",
		error: expect.stringContaining("operator stop"),
	});
});

// Full-Chain-Sentinel-System #6: recovery applies only to stale running rows.
// A paused task is not kept: it is one a pause interrupted, and aborting it is
// how it is dropped (engine-pause-resume.test.ts).
test.each<SentinelEngineTaskStatus>(["done", "failed", "blocked", "aborted"])(
	"abort preserves an inactive %s task",
	async (status) => {
		const { manager, internals, addTask } = setup(async () => {
			throw new Error("Unexpected acquisition");
		});
		const task = addTask();
		internals.store.updateTask(task.id, { status, summary: "original result" });
		expect((await manager.abortTask(task.id, "stop")).ok).toBe(false);
		expect(internals.store.getTask(task.id)).toMatchObject({ status, summary: "original result" });
	},
);
