import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import type { ModelingReadPort } from "../src/apimodel-tool.ts";
import { ApiModelStore } from "../src/apimodels.ts";
import type { CommanderPort } from "../src/commander-tools.ts";
import { CredentialStore } from "../src/credential-store.ts";
import { parseCredential } from "../src/credential-types.ts";
import { deleteDoctrine, saveDoctrine } from "../src/doctrines.ts";
import { type EngineHooks, EngineManager, type RuntimeAcquireTaskSession } from "../src/engine.ts";
import { applyScheduleAction, normalizeSchedule } from "../src/engine-schedule.ts";
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
		const engine = manager.findSubmittedEngine(request.submission.source, request.submission.key);
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

test("the commander reads the project's business models, and is told what they hold and how to dispatch the rest", async () => {
	// A host that hands over the records of whichever project an engine runs in.
	let store: ApiModelStore;
	const modelingReadPort = vi.fn(
		(_projectId: string): ModelingReadPort => ({
			list: () => store.list({ projectId: "p" }),
			read: (id) => store.get(id),
			guide: () => "【业务建模】操作指引",
		}),
	);
	const env = setup({ modelingReadPort });
	store = new ApiModelStore(join(env.dir, "apimodels.db"));
	cleanups.push(() => store.close());
	store.start(
		{ projectId: "p", sessionId: "seed", sessionPath: null, title: "商城" },
		{ paths: { "/api/users": { get: {} } } },
	);
	const { engine, pending } = await env.begin();

	// Asked for the engine's own project, and nothing else.
	expect(modelingReadPort).toHaveBeenCalledWith("p");
	const created = env.create.mock.calls[0]![0]!;
	const tools = created.customTools!;
	// It reads, and has no way to write: modeling is work, and work is dispatched.
	expect(tools.map((tool) => tool.name)).toContain("api_model_read");
	for (const writer of ["api_model_submit", "source_model_submit", "api_model_done"])
		expect(tools.map((tool) => tool.name)).not.toContain(writer);
	const read = tools.find((tool) => tool.name === "api_model_read")!;
	const listed = await read.execute("call", {}, undefined, undefined, {} as never);
	expect(JSON.stringify(listed)).toContain(`- 商城 [id: ${store.list({ projectId: "p" })[0]?.id}`);
	// The brief names what exists and how to get the rest.
	const system = created.resourceLoader?.getAppendSystemPrompt().join("\n") ?? "";
	for (const expected of [
		"业务建模（本项目的接口与业务逻辑模型）",
		"在 objective 里写明「做业务建模」",
		"本工程启动时项目已有的业务建模记录",
	])
		expect(system).toContain(expected);
	expect(system).toContain(`- 商城 [id: ${store.list({ projectId: "p" })[0]?.id}`);
	await env.manager.abortEngine(engine.id);
	env.releaseOpening();
	await pending;
});

test("a host without business models still gives the commander the read tool, and the brief says there are none", async () => {
	const env = setup();
	const { engine, pending } = await env.begin();
	const created = env.create.mock.calls[0]![0]!;
	expect(created.customTools!.map((tool) => tool.name)).toContain("api_model_read");
	const system = created.resourceLoader?.getAppendSystemPrompt().join("\n") ?? "";
	expect(system).toContain("本工程启动时项目已有的业务建模记录（之后的变化用 api_model_read 查看）：\n- 暂无。");
	const read = created.customTools!.find((tool) => tool.name === "api_model_read")!;
	const listed = await read.execute("call", {}, undefined, undefined, {} as never);
	expect(JSON.stringify(listed)).toContain("本项目还没有业务建模记录");
	await env.manager.abortEngine(engine.id);
	env.releaseOpening();
	await pending;
});

test("security-check engines pass persisted credential capability to workers and use ordinary report completion", async () => {
	let vault: CredentialStore;
	const env = setup({ credentialStore: () => vault });
	vault = new CredentialStore(env.dir);
	cleanups.push(() => vault.close());
	vault.save(env.project.id, [parseCredential({ type: "Linux", host: "192.0.2.10", password: "PRIVATE_PASSWORD" })]);
	env.request.submission.source = "security-check";
	env.request.submission.credentials = { scope: "project" };
	env.request.submission.inputInstructions = "rules 是操作员选定的检查指令";
	const { engine, pending, port } = await env.begin();
	const tools = env.create.mock.calls[0]![0]!.customTools!;
	expect(tools.map((t) => t.name)).toContain("credential_list");
	expect(tools.map((t) => t.name)).not.toContain("credential_read");
	const list = tools.find((t) => t.name === "credential_list")!;
	const output = await list.execute("list", {}, undefined, undefined, {} as never);
	expect(JSON.stringify(output)).toContain("192.0.2.10");
	expect(JSON.stringify(output)).not.toContain("PRIVATE_PASSWORD");
	port.dispatch({
		title: "Account check",
		objective: "Check selected target",
		target: "192.0.2.10",
		criteria: [],
		roundLimit: null,
		presetId: null,
	});
	await vi.waitFor(() => expect(env.worker.prompt).toHaveBeenCalledOnce());
	expect(env.acquire.mock.calls[0][0]).toMatchObject({
		credentials: { scope: "project" },
		project: { id: env.project.id },
	});
	expect(env.acquire.mock.calls[0][0].appendPrompt).toContain("rules 是操作员选定");
	env.releaseOpening();
	await pending;
	await env.manager.pauseEngine(engine.id);
	env.commander.prompt.mockImplementationOnce(async () => {
		const currentPort = env.internals.commanderPort(env.internals.live.get(engine.id)!);
		const paused = env.manager.getEngine(engine.id)!.tasks[0];
		expect(
			await currentPort.continueTask(paused.id, { instruction: "继续检查", criteria: [], roundLimit: 2 }),
		).not.toHaveProperty("error");
	});
	await env.manager.resumeEngine(engine.id);
	const resumed = env.internals.live.get(engine.id)!;
	const resumedPort = env.internals.commanderPort(resumed);
	await vi.waitFor(() => expect(env.acquire).toHaveBeenCalledTimes(2));
	expect(env.acquire.mock.calls.at(-1)![0].credentials).toEqual({ scope: "project" });
	expect(env.create.mock.calls.at(-1)![0]!.customTools!.map((t) => t.name)).toContain("credential_list");
	env.complete();
	const schedule = applyScheduleAction(
		normalizeSchedule({ timezone: "UTC", startAt: Date.now() - 1000, repeatDaily: true }, Date.now() - 2000),
		"start",
		Date.now() - 1000,
	);
	env.internals.store.setEngineSchedule(engine.id, schedule);
	resumed.engine = env.internals.store.getEngine(engine.id)!;
	expect(await resumedPort.finish("# Security check report")).toEqual({ ok: true });
	expect(env.archive).toHaveBeenCalledWith(expect.objectContaining({ id: engine.id }), "# Security check report");
	expect(env.manager.getEngine(engine.id)).toMatchObject({ submissionSource: "security-check", status: "completed" });
	const next = env.manager.listEngines().find((e) => e.id !== engine.id)!;
	expect(next).toMatchObject({ status: "scheduled", submissionSource: "security-check" });
	expect(env.manager.getSubmission(next.id)).toMatchObject({
		data: env.request.submission.data,
		credentials: { scope: "project" },
		doctrines: env.request.submission.doctrines,
	});
	expect(env.manager.getSubmission(next.id)?.key).not.toBe(env.request.submission.key);
});
