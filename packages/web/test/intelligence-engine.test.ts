import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import type { CommanderPort } from "../src/commander-tools.ts";
import { deleteDoctrine, saveDoctrine } from "../src/doctrines.ts";
import { type EngineHooks, EngineManager, type RuntimeAcquireTaskSession } from "../src/engine.ts";
import { EngineStore } from "../src/engine-store.ts";
import { submissionInputPath } from "../src/engine-submission.ts";
import { intelligenceEngineSubmission } from "../src/intelligence.ts";
import { DEFAULT_INTELLIGENCE_TEMPLATE } from "../src/intelligence-types.ts";
import type { SentinelEngine } from "../src/protocol.ts";
import type { WorkerSession } from "../src/worker.ts";
import { writeTestModel } from "./model-fixtures.ts";

interface LiveEntry {
	engine: SentinelEngine;
}
interface Internals {
	store: EngineStore;
	live: Map<string, LiveEntry>;
	commanderPort(entry: LiveEntry): CommanderPort;
}
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
});

function setup(overrides: Partial<EngineHooks> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "intel-engine-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const project = { id: "p", name: "P", cwd: dir, container: "test-container" };
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify({ projects: [{ ...project, workDir: dir, createdAt: "" }] }),
	);
	writeTestModel(dir, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "fake", modelId: "fake" });
	const sessionManager = sdk.SessionManager.create(dir, sdk.getDefaultSessionDir(dir, dir));
	sessionManager.appendMessage({ role: "user", content: "Analyze the batch", timestamp: Date.now() });
	const listeners = new Set<(event: sdk.AgentSessionEvent) => void>();
	const worker: WorkerSession = {
		isStreaming: false,
		isIdle: true,
		messages: [],
		prompt: vi.fn(async () => {}),
		sendCustomMessage: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSessionStats: () => ({ tokens: { input: 0, output: 0, total: 0 } }),
	};
	const acquire = vi
		.fn<RuntimeAcquireTaskSession>()
		.mockResolvedValue({ session: worker, manager: sessionManager, release: vi.fn() });
	const archive = vi.fn(async () => {});
	const manager = new EngineManager(
		dir,
		{ onChange: vi.fn(), onCommanderEvent: vi.fn(), onTaskEvent: vi.fn(), archiveReport: archive, ...overrides },
		acquire,
	);
	cleanups.push(() => manager.dispose());
	const internals = manager as unknown as Internals;
	const commander = {
		prompt: vi.fn(async () => {}),
		subscribe: () => () => {},
		bindExtensions: async () => {},
		abort: vi.fn(async () => {}),
		dispose: vi.fn(),
	};
	const create = vi
		.spyOn(sdk, "createAgentSession")
		.mockResolvedValue({ session: commander } as unknown as Awaited<ReturnType<typeof sdk.createAgentSession>>);
	const request = intelligenceEngineSubmission({
		attemptId: "attempt",
		batchId: "batch",
		template: structuredClone(DEFAULT_INTELLIGENCE_TEMPLATE),
		items: [
			{
				ip: "1.1.1.1",
				throughSeq: 1,
				alertCount: 1,
				alerts: [
					{
						seq: 1,
						sourceId: "waf",
						sourceName: "DEVICE_ONLY https://192.0.2.90/",
						receivedAt: 1,
						event_id: "event",
						indicator: { type: "ip", value: "1.1.1.1" },
						occurred_at: "2026-11-11T10:00:00Z",
						category: "waf",
						severity: "high",
					},
				],
			},
		],
	});
	// Keep the opening turn pending until the test dispatches work. No provider is called.
	let releaseOpening: () => void = () => {};
	commander.prompt.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				releaseOpening = resolve;
			}),
	);
	const begin = async () => {
		const pending = manager.createEngine(project, request.input, request.submission);
		await vi.waitFor(() => expect(commander.prompt).toHaveBeenCalled());
		const engine = manager.findSubmittedEngine("intelligence", "attempt");
		if (!engine) throw new Error("Missing submitted engine");
		const entry = internals.live.get(engine.id);
		if (!entry) throw new Error("Missing live entry");
		return { pending, engine, port: internals.commanderPort(entry) };
	};
	return {
		dir,
		project,
		request,
		manager,
		internals,
		acquire,
		archive,
		create,
		commander,
		worker,
		begin,
		releaseOpening: () => releaseOpening(),
		complete: () => {
			const options = acquire.mock.calls.at(-1)?.[0];
			if (!options?.goalPort) throw new Error("Worker did not acquire a goal port");
			options.goalPort.complete({
				summary: "IP report",
				evidence: [],
				submitted: 0,
				findingsNote: "Analysis",
				criteria: [],
				at: Date.now(),
			});
			for (const listener of listeners) listener({ type: "agent_settled", aborted: false });
		},
	};
}

test("a batch starts the ordinary commander and runtime, then completes through engine_done", async () => {
	const env = setup();
	const { pending, engine, port } = await env.begin();
	expect(engine.tasks).toEqual([]);
	const tools = env.create.mock.calls[0]?.[0]?.customTools?.map((tool) => tool.name);
	expect(tools).toContain("dispatch_task");
	expect(tools).toContain("engine_done");
	expect(JSON.parse(readFileSync(submissionInputPath(env.project, engine.id), "utf8"))).toEqual({ ips: ["1.1.1.1"] });
	const commanderInput = JSON.stringify({
		prompt: env.commander.prompt.mock.calls,
		system: env.create.mock.calls[0]?.[0]?.resourceLoader?.getAppendSystemPrompt(),
	});
	expect(commanderInput).not.toContain("DEVICE_ONLY");
	expect(commanderInput).not.toContain("192.0.2.90");
	const dispatched = port.dispatch({
		title: "IP analysis",
		objective: "Analyze 1.1.1.1",
		target: "1.1.1.1",
		criteria: [],
		roundLimit: null,
		presetId: null,
	});
	await vi.waitFor(() => expect(env.worker.prompt).toHaveBeenCalledOnce());
	const options = env.acquire.mock.calls[0][0];
	expect(options).toMatchObject({
		engineId: engine.id,
		taskId: dispatched.task?.id,
		project: { container: "test-container" },
	});
	expect(options.appendPrompt).toContain(`/work/.sentinel/engine-inputs/${engine.id}/input.json`);
	expect(options.appendPrompt).not.toContain("DEVICE_ONLY");
	expect(options.appendPrompt).not.toContain("192.0.2.90");
	expect(await port.finish("premature")).toMatchObject({ ok: false });
	env.releaseOpening();
	await pending;
	env.complete();
	expect(env.manager.getEngine(engine.id)?.status).toBe("running");
	expect(env.manager.taskSessionPath(dispatched.task?.id ?? "")).toContain(".jsonl");
	expect(await port.finish("# Full report")).toEqual({ ok: true });
	expect(env.archive).toHaveBeenCalledOnce();
	expect(env.manager.getEngine(engine.id)).toMatchObject({ status: "completed", report: "# Full report" });
	await env.manager.abortEngine(engine.id);
	expect(env.manager.getEngine(engine.id)?.status).toBe("completed");
});

test("duplicate submission is idempotent while the opening commander turn is pending", async () => {
	const env = setup();
	const { pending, engine } = await env.begin();
	expect((await env.manager.createEngine(env.project, env.request.input, env.request.submission)).id).toBe(engine.id);
	expect(env.create).toHaveBeenCalledOnce();
	await env.manager.abortEngine(engine.id);
	env.releaseOpening();
	await pending;
	expect(env.manager.listEngines()).toHaveLength(1);
	expect(env.manager.getEngine(engine.id)?.status).toBe("stopped");
});

test("doctrine snapshots survive deletion and commander resume", async () => {
	const env = setup();
	const custom = saveDoctrine(env.dir, { name: "Snapshot", text: "Snapshot version" }).doctrine;
	if (!custom) throw new Error("Missing custom doctrine");
	env.request.input.doctrines = [custom.id];
	env.request.submission.doctrines = [custom];
	deleteDoctrine(env.dir, custom.id);
	const { pending, engine } = await env.begin();
	expect(env.create.mock.calls[0]?.[0]?.resourceLoader?.getAppendSystemPrompt().join("\n")).toContain(
		"Snapshot version",
	);
	await env.manager.pauseEngine(engine.id);
	env.releaseOpening();
	await pending;
	await env.manager.resumeEngine(engine.id);
	expect(env.create.mock.calls.at(-1)?.[0]?.resourceLoader?.getAppendSystemPrompt().join("\n")).toContain(
		"Snapshot version",
	);
	const reopened = new EngineStore(join(env.dir, "engines.db"));
	try {
		expect(reopened.submission(engine.id)?.doctrines).toEqual([custom]);
	} finally {
		reopened.close();
	}
});

test("environment rejection pauses the ordinary engine and prevents commander startup", async () => {
	const env = setup({ beforeStart: async () => ({ ok: false, error: "Container unavailable" }) });
	await expect(env.manager.createEngine(env.project, env.request.input, env.request.submission)).rejects.toThrow(
		"Container unavailable",
	);
	expect(env.create).not.toHaveBeenCalled();
	expect(env.manager.findSubmittedEngine("intelligence", "attempt")).toMatchObject({
		status: "paused",
		pauseNote: expect.stringContaining("Container unavailable"),
	});
});

test("aborting during an asynchronous environment check prevents late startup", async () => {
	let finish: (result: { ok: boolean }) => void = () => {};
	const env = setup({
		beforeStart: () =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	});
	const pending = env.manager.createEngine(env.project, env.request.input, env.request.submission);
	const engine = env.manager.findSubmittedEngine("intelligence", "attempt");
	if (!engine) throw new Error("Missing engine");
	await env.manager.abortEngine(engine.id);
	finish({ ok: true });
	await pending;
	expect(env.create).not.toHaveBeenCalled();
	expect(env.manager.getEngine(engine.id)?.status).toBe("stopped");
});
