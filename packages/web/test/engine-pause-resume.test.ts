/**
 * Pause and 继续 of an engineering run, at the manager level.
 *
 * A pause interrupts work, and what it interrupted is not finished. These tests
 * pin what 继续 owes that work: the task that was running goes back to its own
 * conversation, the one that had not started simply starts, and a run that
 * cannot be resumed says so on the board instead of sitting on 运行中 with
 * nothing driving it.
 *
 * The real manager, scheduler and store; a fake session per task; no commander.
 * Its start is replaced, so what it would be told is read from the text handed
 * to `promptCommander`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSessionEvent, getSessionDirPath, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { type CommanderPort, formatTaskBoard } from "../src/commander-tools.ts";
import { EngineManager, engineHasWorkInFlight, type RuntimeAcquireTaskSession } from "../src/engine.ts";
import { EngineStore } from "../src/engine-store.ts";
import { readGoalState } from "../src/goal.ts";
import type { SentinelEngine, SentinelEngineTask } from "../src/protocol.ts";
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
	startCommander(entry: LiveEntry, kind: "initial" | "resume"): Promise<void>;
	promptCommander(entry: LiveEntry, text: string): Promise<void>;
	afterCommanderSettled(entry: LiveEntry): void;
	commanderPort(entry: LiveEntry): CommanderPort;
}

/** One entry of a conversation, as the session file keeps it. */
interface FakeEntry {
	type: string;
	customType: string;
	data: unknown;
}

interface FakeSession {
	/** The conversation's id. */
	id: string;
	manager: SessionManager;
	session: WorkerSession;
	/** What the run wrote into the conversation: the goal state, at each change. */
	entries: FakeEntry[];
}

/** A task session whose round runs until something aborts it. */
function fakeSession(id: string): FakeSession {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const entries: FakeEntry[] = [];
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
			for (const listener of listeners) listener({ type: "agent_settled", aborted: true });
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
		getSessionId: () => id,
		// A task reopened after a pause reads its goal back from what its first run wrote.
		getBranch: () => entries,
		appendCustomEntry: (customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as SessionManager;
	return { id, manager, session, entries };
}

/** The last goal contract shown in a conversation. A continuation's instruction is in it. */
function lastContract(fake: FakeSession): string {
	const message = vi.mocked(fake.session.sendCustomMessage).mock.calls.at(-1)?.[0] as
		| { content?: unknown }
		| undefined;
	return typeof message?.content === "string" ? message.content : "";
}

/** A task conversation on disk, where a continuation can find it. */
function taskConversation(dir: string): { id: string; file: string } {
	const session = SessionManager.create(dir, getSessionDirPath(dir, dir));
	session.appendMessage({ role: "user", content: "检查 example.test", timestamp: Date.now() });
	const file = session.getSessionFile();
	if (!file) throw new Error("the new conversation was not given a file");
	return { id: session.getSessionId(), file };
}

/**
 * The host side of a task session. Each task gets the fake registered under its
 * title, so a task reopened after a pause writes into the same conversation as
 * its first run.
 */
function fakeAcquire() {
	const fakes = new Map<string, FakeSession>();
	const acquire = vi.fn<RuntimeAcquireTaskSession>().mockImplementation(async (input) => {
		let fake = fakes.get(input.taskTitle);
		if (!fake) {
			fake = fakeSession(`session-${input.taskTitle}`);
			fakes.set(input.taskTitle, fake);
		}
		return { session: fake.session, manager: fake.manager, release: () => {} };
	});
	return { acquire, fakes };
}

/** What the host was asked for, one line per task session: the task, and whether its own conversation is reopened. */
function asks(acquire: { mock: { calls: Array<[Parameters<RuntimeAcquireTaskSession>[0]]> } }): unknown[][] {
	return acquire.mock.calls.map(([input]) => [input.taskTitle, input.taskSessionId, input.reopen]);
}

function statuses(engine: SentinelEngine): string[] {
	return engine.tasks.map((task) => task.status);
}

interface Harness {
	/** The agent directory: the store, the project and the task conversations are in it. */
	dir: string;
	manager: EngineManager;
	internals: ManagerInternals;
	/** The live entry of the engine `setup` created. */
	entry: LiveEntry;
	engineId: string;
	/** A queued task on a board. */
	addTask(engineId: string, title: string): SentinelEngineTask;
	/** An engine as it is stored right now. */
	board(engineId: string): SentinelEngine;
	/** Everything handed to the engine's commander so far, oldest first. */
	prompts(): string[];
}

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/**
 * One agent directory with a project and a running engine of two slots.
 *
 * `seed` adds rows the way a previous process would have left them. The engine
 * then comes back the way a restart brings it back, paused, instead of running.
 */
function setup(
	acquire: RuntimeAcquireTaskSession,
	options: {
		concurrency?: number;
		seed?: (store: EngineStore, engine: SentinelEngine, dir: string) => void;
	} = {},
): Harness {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-engine-pause-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify({
			projects: [{ id: "p1", name: "Test", container: "fake-container", workDir: dir, createdAt: "" }],
		}),
	);
	const seedStore = new EngineStore(join(dir, "engines.db"));
	const engine = seedStore.createEngine({
		projectId: "p1",
		projectName: "Test",
		name: "暂停与继续",
		targets: [{ target: "example.test" }],
		doctrines: [],
		gateMode: "auto",
		limits: {
			concurrency: options.concurrency ?? 2,
			roundLimit: 3,
			tokenLimit: null,
			timeLimitMin: null,
			maxRetries: 0,
		},
	});
	options.seed?.(seedStore, engine, dir);
	seedStore.close();
	const manager = new EngineManager(
		dir,
		{ onChange: vi.fn(), onCommanderEvent: vi.fn(), onTaskEvent: vi.fn() },
		acquire,
	);
	cleanups.push(() => manager.dispose());
	const internals = manager as unknown as ManagerInternals;
	vi.spyOn(internals, "startCommander").mockResolvedValue();
	vi.spyOn(internals, "promptCommander").mockResolvedValue();
	const entry = internals.live.get(engine.id);
	if (!entry) throw new Error("Missing live engine");
	if (!options.seed) {
		internals.store.setEngineStatus(engine.id, "running", null, null);
		entry.engine = internals.store.getEngine(engine.id) ?? engine;
	}
	const board = (id: string): SentinelEngine => {
		const stored = manager.getEngine(id);
		if (!stored) throw new Error("Missing engine");
		return stored;
	};
	return {
		dir,
		manager,
		internals,
		entry,
		engineId: engine.id,
		board,
		addTask: (id, title) =>
			internals.store.createTask({
				engineId: id,
				title,
				objective: `检查 ${title}`,
				target: null,
				workspace: "test",
				roundLimit: 3,
				attempt: 1,
			}),
		prompts: () => vi.mocked(internals.promptCommander).mock.calls.map(([, text]) => text),
	};
}

test("a pause pauses the tasks that had not started as well, so nothing is left in flight", async () => {
	const { acquire } = fakeAcquire();
	const { manager, internals, entry, engineId, addTask, board } = setup(acquire);
	const running = addTask(engineId, "运行中的任务");
	const waiting = addTask(engineId, "排队中的任务");
	await internals.startTask(entry, running.id);
	expect(internals.store.getTask(waiting.id)?.status).toBe("queued");
	expect(engineHasWorkInFlight(board(engineId))).toBe(true);

	await manager.pauseEngine(engineId);

	const paused = board(engineId);
	expect(paused.status).toBe("paused");
	// 排队中 under a paused engine read as work about to start; nothing would have started it.
	expect(statuses(paused)).toEqual(["paused", "paused"]);
	// The console reads this before it lets the project container stop.
	expect(engineHasWorkInFlight(paused)).toBe(false);
	expect(entry.workers.size).toBe(0);
});

test("继续 puts back what the pause interrupted: the started task continues in its conversation, the other starts", async () => {
	const { acquire, fakes } = fakeAcquire();
	const { manager, internals, entry, engineId, addTask, board, dir, prompts } = setup(acquire);
	// The started task owns a conversation on disk: that is what a continuation reopens.
	const started = fakeSession(taskConversation(dir).id);
	fakes.set("运行中的任务", started);
	const running = addTask(engineId, "运行中的任务");
	addTask(engineId, "排队中的任务");
	await internals.startTask(entry, running.id);
	await manager.pauseEngine(engineId);

	await manager.resumeEngine(engineId);

	const resumed = board(engineId);
	expect(resumed.status).toBe("running");
	expect(resumed.tasks.map((task) => [task.status, task.endedAt])).toEqual([
		["running", null],
		["running", null],
	]);
	expect(asks(acquire)).toEqual([
		["运行中的任务", null, false],
		["运行中的任务", started.id, true],
		["排队中的任务", null, false],
	]);
	// The workers were started a moment ago and open their rounds in their own time.
	const waiting = fakes.get("排队中的任务");
	if (!waiting) throw new Error("the waiting task never got a session");
	await vi.waitFor(() => {
		expect(lastContract(started)).toContain("工程恢复：此前任务因暂停被中断");
		expect(lastContract(waiting)).toContain("【持续目标已启动】第 0 轮");
	});
	// It is told to carry on from where it stopped, and its goal is revived, not begun again.
	expect(readGoalState(started.entries)).toMatchObject({ status: "active", roundsUsed: 1 });
	expect(readGoalState(started.entries)?.rounds).toHaveLength(2);
	// A task that never started has no conversation to continue: it begins.
	expect(lastContract(waiting)).not.toContain("工程恢复");
	// Work is in flight. An idle commander is left to wait for it, not nudged toward closing the run.
	internals.afterCommanderSettled(entry);
	expect(prompts()).toEqual([]);
	expect(board(engineId).status).toBe("running");
});

test("a 继续 whose commander cannot start leaves the run paused, with the reason on the board", async () => {
	const { acquire, fakes } = fakeAcquire();
	const { manager, internals, entry, engineId, addTask, board, dir } = setup(acquire);
	fakes.set("运行中的任务", fakeSession(taskConversation(dir).id));
	const running = addTask(engineId, "运行中的任务");
	addTask(engineId, "排队中的任务");
	await internals.startTask(entry, running.id);
	await manager.pauseEngine(engineId);
	vi.mocked(internals.startCommander).mockRejectedValue(new Error("指挥官模型未配置"));

	await expect(manager.resumeEngine(engineId)).rejects.toThrow("指挥官模型未配置");

	// Marked running and with nothing driving it, the run would have sat on 运行中 for good.
	const after = board(engineId);
	expect(after.status).toBe("paused");
	expect(after.pauseNote).toBe("继续失败：指挥官模型未配置");
	// The task put back in the meantime is stopped again with the engine.
	expect(statuses(after)).toEqual(["paused", "paused"]);
	expect(entry.workers.size).toBe(0);

	// Nothing was lost: with the commander available, the next 继续 puts the work back.
	vi.mocked(internals.startCommander).mockResolvedValue();
	await manager.resumeEngine(engineId);
	expect(statuses(board(engineId))).toEqual(["running", "running"]);
});

test("after a service restart, 继续 puts back the task that was running and the one that had not started", async () => {
	const { acquire, fakes } = fakeAcquire();
	let conversation = { id: "", file: "" };
	const { manager, engineId, board } = setup(acquire, {
		seed: (store, engine, dir) => {
			conversation = taskConversation(dir);
			fakes.set("重启前运行的任务", fakeSession(conversation.id));
			const running = store.createTask({
				engineId: engine.id,
				title: "重启前运行的任务",
				objective: "检查 example.test",
				target: null,
				workspace: "test",
				roundLimit: 3,
				attempt: 1,
			});
			store.updateTask(running.id, { status: "running", sessionId: conversation.id });
			store.createTask({
				engineId: engine.id,
				title: "重启前排队的任务",
				objective: "检查 example.test",
				target: null,
				workspace: "test",
				roundLimit: 3,
				attempt: 1,
			});
		},
	});
	// Nothing of the old run is live, so a restart never resumes it on its own.
	expect(board(engineId).status).toBe("paused");
	expect(statuses(board(engineId))).toEqual(["paused", "paused"]);

	await manager.resumeEngine(engineId);

	expect(board(engineId).status).toBe("running");
	expect(statuses(board(engineId))).toEqual(["running", "running"]);
	expect(asks(acquire)).toEqual([
		["重启前运行的任务", conversation.id, true],
		["重启前排队的任务", null, false],
	]);
});

test("a continuation the commander had already asked for keeps its instruction", async () => {
	const { acquire, fakes } = fakeAcquire();
	const { manager, internals, entry, engineId, addTask, board, dir } = setup(acquire, { concurrency: 1 });
	const failed = fakeSession(taskConversation(dir).id);
	fakes.set("失败的任务", failed);
	// It is the one the pause interrupts mid-run, so it needs a conversation a continuation can reopen.
	fakes.set("占住并发的任务", fakeSession(taskConversation(dir).id));
	const task = addTask(engineId, "失败的任务");
	await internals.startTask(entry, task.id);
	await manager.abortTask(task.id, "不需要了");
	// The commander asks for a continuation while the only slot is taken, so it waits in the queue.
	addTask(engineId, "占住并发的任务");
	await internals.startTask(entry, board(engineId).tasks[1].id);
	expect(manager.continueTask(task.id, { instruction: "换个端口再试", criteria: [], roundLimit: 2 })).toMatchObject({
		task: { status: "queued", pendingContinue: { instruction: "换个端口再试" } },
	});

	await manager.pauseEngine(engineId);
	expect(internals.store.getTask(task.id)).toMatchObject({
		status: "paused",
		pendingContinue: { instruction: "换个端口再试" },
	});
	await manager.resumeEngine(engineId);

	// The continuation runs as the commander wrote it. The task the pause interrupted is the one told to carry on.
	await vi.waitFor(() => expect(lastContract(failed)).toContain("换个端口再试"));
	expect(lastContract(failed)).not.toContain("工程恢复");
	expect(statuses(board(engineId))).toEqual(["running", "queued"]);
	expect(board(engineId).tasks[1].pendingContinue?.instruction).toContain("工程恢复");
	expect(asks(acquire).at(-1)).toEqual(["失败的任务", failed.id, true]);
});

test("a task a pause caught before it started can be dropped, and the board offers no conversation to continue", async () => {
	const { acquire, fakes } = fakeAcquire();
	const { manager, internals, entry, engineId, addTask, board, dir } = setup(acquire);
	fakes.set("运行中的任务", fakeSession(taskConversation(dir).id));
	const running = addTask(engineId, "运行中的任务");
	const waiting = addTask(engineId, "排队中的任务");
	await internals.startTask(entry, running.id);
	await manager.pauseEngine(engineId);

	// The commander reads the board: one task can be continued, the other only dispatched again or dropped.
	const lines = formatTaskBoard(board(engineId).tasks).split("\n");
	expect(lines[0]).toMatch(/「运行中的任务」.*；可 continue_task 续跑$/);
	expect(lines[1]).toMatch(/「排队中的任务」.*；尚未开始，没有可续跑的会话$/);

	expect(await manager.abortTask(waiting.id, "放弃")).toEqual({ ok: true });
	expect(internals.store.getTask(waiting.id)).toMatchObject({ status: "aborted", error: "放弃" });
	expect(internals.store.getTask(running.id)?.status).toBe("paused");
});

test("a run cannot be closed over an interrupted task: it is continued or dropped first", async () => {
	const { acquire, fakes } = fakeAcquire();
	const { manager, internals, entry, engineId, addTask, board, dir } = setup(acquire);
	const conversation = taskConversation(dir);
	fakes.set("运行中的任务", fakeSession(conversation.id));
	const running = addTask(engineId, "运行中的任务");
	const waiting = addTask(engineId, "排队中的任务");
	await internals.startTask(entry, running.id);
	await manager.pauseEngine(engineId);
	// The operator deleted the task's conversation while the run was paused.
	rmSync(conversation.file);

	await manager.resumeEngine(engineId);

	// Nothing can resume it by itself, so it stays interrupted, and the decision log says why.
	expect(statuses(board(engineId))).toEqual(["paused", "running"]);
	const notes = manager
		.commanderEvents(engineId)
		.filter((event) => event.kind === "status" && event.status === "error")
		.map((event) => event.note);
	expect(notes.some((note) => note?.includes("自动续跑失败") && note.includes("会话文件不存在"))).toBe(true);

	const finish = async (): Promise<{ ok: boolean; error?: string }> => internals.commanderPort(entry).finish("# 报告");
	// The running task is the refusal there always was.
	expect(await finish()).toMatchObject({ ok: false, error: expect.stringContaining("还有 1 个任务未结束") });
	expect(await manager.abortTask(waiting.id, "不需要了")).toEqual({ ok: true });
	expect(await finish()).toMatchObject({
		ok: false,
		error: "还有 1 个任务因暂停而中断，尚未处理：用 continue_task 在原会话上续跑，或用 abort_task 放弃",
	});
	expect(board(engineId).status).toBe("running");

	// Dropped for good, the report is accepted.
	expect(await manager.abortTask(running.id, "目标已不需要")).toEqual({ ok: true });
	expect(internals.store.getTask(running.id)).toMatchObject({ status: "aborted", error: "目标已不需要" });
	expect(await finish()).toEqual({ ok: true });
	expect(board(engineId)).toMatchObject({ status: "completed", report: "# 报告" });
});

test("an idle commander is pointed at the interrupted tasks, not at closing the run", async () => {
	const { acquire, fakes } = fakeAcquire();
	const { manager, internals, entry, engineId, addTask, board, dir, prompts } = setup(acquire);
	const conversation = taskConversation(dir);
	fakes.set("中断的任务", fakeSession(conversation.id));
	const task = addTask(engineId, "中断的任务");
	await internals.startTask(entry, task.id);
	await manager.pauseEngine(engineId);
	rmSync(conversation.file);
	await manager.resumeEngine(engineId);
	expect(statuses(board(engineId))).toEqual(["paused"]);

	internals.afterCommanderSettled(entry);
	const nudged = prompts().at(-1) ?? "";
	expect(nudged).toContain("有 1 个任务因暂停而中断");
	expect(nudged).toContain("continue_task");
	expect(nudged).toContain("abort_task");
	expect(nudged).toContain("engine_done 会被拒绝");
	expect(nudged).not.toContain("请用 engine_done 提交总报告结束工程");

	// With nothing interrupted left, the plain advice to close the run is right again.
	await manager.abortTask(task.id, "放弃");
	internals.afterCommanderSettled(entry);
	expect(prompts().at(-1)).toContain("请用 engine_done 提交总报告结束工程");
});

test("the plan's own resume puts back everything its pause interrupted, started or not", async () => {
	const start = Date.UTC(2026, 10, 24, 1, 0, 0);
	vi.useFakeTimers();
	vi.setSystemTime(new Date(start));
	const { acquire, fakes } = fakeAcquire();
	const { manager, internals, addTask, board, dir } = setup(acquire);
	const planned = await manager.createEngine(
		{ id: "p1", name: "Test", cwd: dir },
		{
			name: "定时工程",
			targets: "example.test",
			doctrines: ["attack-defense-web"],
			presetIds: [],
			presetOptional: true,
			limits: { concurrency: 2, roundLimit: 3, tokenLimit: null, timeLimitMin: null, maxRetries: 0 },
			gateMode: "auto",
			schedule: { timezone: "UTC", startAt: start + 1000, pauseAt: start + 3000, resumeAt: start + 4000 },
		},
	);
	const engineId = planned.id;
	await vi.advanceTimersByTimeAsync(1000);
	expect(board(engineId).status).toBe("running");
	const entry = internals.live.get(engineId);
	if (!entry) throw new Error("Missing live engine");
	const started = fakeSession(taskConversation(dir).id);
	fakes.set("计划暂停时运行的任务", started);
	const running = addTask(engineId, "计划暂停时运行的任务");
	addTask(engineId, "计划暂停时排队的任务");
	await internals.startTask(entry, running.id);

	await vi.advanceTimersByTimeAsync(2000);
	expect(board(engineId)).toMatchObject({ status: "paused", pauseNote: "定时暂停，将在计划时间自动恢复" });
	expect(statuses(board(engineId))).toEqual(["paused", "paused"]);

	await vi.advanceTimersByTimeAsync(1000);
	expect(board(engineId).status).toBe("running");
	expect(statuses(board(engineId))).toEqual(["running", "running"]);
	expect(asks(acquire).slice(1)).toEqual([
		["计划暂停时运行的任务", started.id, true],
		["计划暂停时排队的任务", null, false],
	]);
});

test("a stopped task's conversation says so: the round is closed and the goal waits", async () => {
	const { acquire, fakes } = fakeAcquire();
	const { manager, internals, entry, engineId, addTask, board } = setup(acquire);
	const aborted = fakeSession("session-aborted");
	const paused = fakeSession("session-paused");
	fakes.set("被中止的任务", aborted);
	fakes.set("被暂停打断的任务", paused);
	const first = addTask(engineId, "被中止的任务");
	const second = addTask(engineId, "被暂停打断的任务");
	await internals.startTask(entry, first.id);
	await internals.startTask(entry, second.id);
	// While they run, each conversation shows a goal in progress.
	for (const fake of [aborted, paused]) {
		expect(readGoalState(fake.entries)).toMatchObject({ status: "active" });
		expect(readGoalState(fake.entries)?.rounds[0].endedAt).toBeUndefined();
	}

	await manager.abortTask(first.id, "不需要了");
	await manager.pauseEngine(engineId);

	expect(statuses(board(engineId))).toEqual(["aborted", "paused"]);
	// Left as it was, the conversation kept showing work in progress, with a duration that went on ticking.
	for (const fake of [aborted, paused]) {
		const goal = readGoalState(fake.entries);
		expect(goal).toMatchObject({ status: "paused", pauseReason: "manual", pauseNote: "运行被中止，目标已暂停" });
		expect(goal?.rounds.at(-1)).toMatchObject({ outcome: "aborted", endedAt: expect.any(Number) });
	}
});
