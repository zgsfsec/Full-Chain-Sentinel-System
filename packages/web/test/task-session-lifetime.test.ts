import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { SentinelRuntime, type TaskSessionOptions } from "../src/sentinel-session.ts";
import { writeTestModel } from "./model-fixtures.ts";

const cleanups: (() => void)[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup(): { runtime: SentinelRuntime; options: TaskSessionOptions } {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-task-lifetime-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	writeTestModel(dir, { baseUrl: "http://127.0.0.1:1/v1", apiKey: "test", modelId: "test" });
	const runtime = new SentinelRuntime({
		cwd,
		agentDir: dir,
		activeProject: { id: "p1", name: "Project", container: "test", cwd },
		hooks: {
			onSessionEvent: () => {},
			onStateChange: () => {},
			onSubagentEvent: () => {},
			onNotifyStatus: () => {},
			onVulnChange: () => {},
			onAssetChange: () => {},
			onSessionRenamed: () => {},
			onVulnSubmitted: () => {},
			onGateDecision: () => {},
			onPocChange: () => {},
			onPocSourceChange: () => {},
			onApiModelChange: () => {},
			onDroidChange: () => {},
			onIosChange: () => {},
			onSupervisorState: () => {},
			onSupervisorEpisode: () => {},
			onSupervisorLog: () => {},
			onSupervisorAdvice: () => {},
		},
	});
	cleanups.push(() => runtime.dispose());
	return {
		runtime,
		options: {
			project: { id: "p1", name: "Project", container: "test", cwd },
			appendPrompt: "Worker lifecycle test role.",
			presetId: null,
			taskTitle: "Task",
			engineId: "e1",
			taskId: "t1",
			gateMode: "auto",
			taskSessionId: null,
			reopen: false,
			goalPort: {
				current: () => undefined,
				submitted: () => 0,
				progress: () => {},
				complete: () => {},
				blocked: () => ({ streak: 0, accepted: false }),
			},
			onFinding: () => {},
		},
	};
}

function persistEvidence(manager: SessionManager): void {
	// SessionManager persists a new file after its first assistant response.
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "saved evidence" }],
		api: "openai-completions",
		provider: "test",
		model: "test",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
}

test("finished background tasks dispose live sessions and preserve reopenable history", async () => {
	const { runtime, options } = setup();
	for (let i = 0; i < 6; i += 1) {
		const handle = await runtime.acquireTaskSession({ ...options, taskId: `t${i}` });
		persistEvidence(handle.manager);
		const file = handle.manager.getSessionFile();
		const disposed = vi.spyOn(handle.session, "dispose");
		handle.release();
		handle.release();
		expect(disposed).toHaveBeenCalledTimes(1);
		expect(file && existsSync(file)).toBe(true);
		const resumed = await runtime.acquireTaskSession({
			...options,
			reopen: true,
			taskSessionId: handle.manager.getSessionId(),
		});
		expect(resumed.session).not.toBe(handle.session);
		expect(resumed.manager.getSessionId()).toBe(handle.manager.getSessionId());
		expect(
			resumed.manager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "assistant"),
		).toBe(true);
		resumed.release();
	}
});

test("a delayed release from an old worker cannot dispose a continuation", async () => {
	const { runtime, options } = setup();
	const first = await runtime.acquireTaskSession(options);
	persistEvidence(first.manager);
	const resumed = await runtime.acquireTaskSession({
		...options,
		reopen: true,
		taskSessionId: first.manager.getSessionId(),
	});
	const disposed = vi.spyOn(resumed.session, "dispose");
	first.release();
	expect(disposed).not.toHaveBeenCalled();
	resumed.release();
	expect(disposed).toHaveBeenCalledTimes(1);
});

test("viewed task history stays live until the operator switches away", async () => {
	const { runtime, options } = setup();
	const handle = await runtime.acquireTaskSession(options);
	persistEvidence(handle.manager);
	const file = handle.manager.getSessionFile();
	if (!file) throw new Error("missing task file");
	await runtime.switchSession(file);
	const disposed = vi.spyOn(handle.session, "dispose");
	handle.release();
	expect(disposed).not.toHaveBeenCalled();
	await runtime.newSession();
	expect(disposed).toHaveBeenCalledTimes(1);
	await runtime.switchSession(file);
	expect(runtime.snapshot().messages.some((message) => JSON.stringify(message).includes("evidence"))).toBe(true);
});

test("release waits for a busy session to settle", async () => {
	const { runtime, options } = setup();
	const handle = await runtime.acquireTaskSession(options);
	let idle: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		idle = resolve;
	});
	const isIdle = vi.spyOn(handle.session, "isIdle", "get").mockReturnValue(false);
	const waiting = vi.spyOn(handle.session, "waitForIdle").mockReturnValue(gate);
	const disposed = vi.spyOn(handle.session, "dispose");
	handle.release();
	handle.release();
	expect(waiting).toHaveBeenCalledTimes(1);
	expect(disposed).not.toHaveBeenCalled();
	isIdle.mockReturnValue(true);
	idle();
	await gate;
	expect(disposed).toHaveBeenCalledTimes(1);
});

test("concurrent sidebar requests share a scan without caching later refreshes", async () => {
	const { runtime } = setup();
	let finish: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const listing = vi.spyOn(SessionManager, "list").mockImplementation(async () => {
		await gate;
		return [];
	});
	const requests = Array.from({ length: 20 }, () => runtime.listSessions());
	expect(listing).toHaveBeenCalledTimes(1);
	finish();
	await Promise.all(requests);
	await runtime.listSessions();
	expect(listing).toHaveBeenCalledTimes(2);
});
