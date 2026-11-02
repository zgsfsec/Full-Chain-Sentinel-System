import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import * as sdk from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MitmCenter } from "../src/mitm.ts";
import { MITM_TOOL_NAMES } from "../src/mitm-tool.ts";
import { defaultPermissions, writePermissionsConfig } from "../src/permissions.ts";
import { SentinelRuntime, type SentinelRuntimeHooks } from "../src/sentinel-session.ts";
import * as subagent from "../src/subagent.ts";
import { writeTestModel } from "./model-fixtures.ts";

let root: string;
let runtime: SentinelRuntime;
let projectA: { id: string; name: string; container: string; cwd: string };
let projectB: typeof projectA;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mitm-runtime-"));
	projectA = { id: "a", name: "A", container: "sentinel-a", cwd: join(root, "a") };
	projectB = { id: "b", name: "B", container: "sentinel-b", cwd: join(root, "b") };
	for (const project of [projectA, projectB]) mkdirSync(project.cwd);
	writeFileSync(
		join(root, "projects.json"),
		JSON.stringify({
			projects: [projectA, projectB].map((p) => ({ ...p, workDir: p.cwd, createdAt: new Date().toISOString() })),
		}),
	);
	const hooks: SentinelRuntimeHooks = {
		onSessionEvent: vi.fn(),
		onStateChange: vi.fn(),
		onSubagentEvent: vi.fn(),
		onNotifyStatus: vi.fn(),
		onVulnChange: vi.fn(),
		onAssetChange: vi.fn(),
		onSessionRenamed: vi.fn(),
		onVulnSubmitted: vi.fn(),
		onGateDecision: vi.fn(),
		onPocChange: vi.fn(),
		onPocSourceChange: vi.fn(),
		onApiModelChange: vi.fn(),
		onDroidChange: vi.fn(),
		onIosChange: vi.fn(),
		onSupervisorState: vi.fn(),
		onSupervisorEpisode: vi.fn(),
		onSupervisorLog: vi.fn(),
		onSupervisorAdvice: vi.fn(),
	};
	runtime = new SentinelRuntime({ cwd: projectA.cwd, agentDir: root, activeProject: projectA, hooks });
});

afterEach(() => {
	runtime.dispose();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

test("main, worker and their sub-agents receive MITM reads bound to their own project", async () => {
	// Construct real sessions without prompting a model or starting Docker.
	writeTestModel(root, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture", modelId: "fixture" });
	const created = vi.spyOn(sdk, "createAgentSession");
	const spawn = vi.spyOn(subagent, "createSubagentTool");
	const reader = vi.spyOn(MitmCenter.prototype, "reader").mockResolvedValue(undefined);
	await runtime.init();
	const main = await created.mock.results[0].value;
	await assertWorkflow(main.session);
	expect(runtime.getPermissions().tools.filter((tool) => MITM_TOOL_NAMES.includes(tool.name))).toHaveLength(3);
	const parentTools = spawn.mock.calls[0][0].extraTools ?? [];
	expect(parentTools.filter((tool) => MITM_TOOL_NAMES.includes(tool.name))).toHaveLength(3);
	await runtime.switchProject(projectB);
	const aList = parentTools.find((tool) => tool.name === "mitm_flows")!;
	expect((await aList.execute("read-a", {}, undefined, undefined, {} as never)).isError).not.toBe(true);
	expect(reader).toHaveBeenLastCalledWith("a");
	const worker = await runtime.acquireTaskSession({
		project: projectA,
		appendPrompt: "worker",
		presetId: null,
		taskTitle: "task",
		engineId: "e1",
		taskId: "t1",
		gateMode: "auto",
		taskSessionId: null,
		reopen: false,
		onFinding: () => {},
		goalPort: {
			current: () => undefined,
			submitted: () => 0,
			progress: () => {},
			complete: () => {},
			blocked: () => ({ streak: 0, accepted: false }),
		},
	});
	expect(worker.session.getAllTools().filter((tool) => MITM_TOOL_NAMES.includes(tool.name))).toHaveLength(3);
	await assertWorkflow(worker.session);
	const workerChildTools = spawn.mock.calls.at(-1)?.[0].extraTools ?? [];
	const workerList = workerChildTools.find((tool) => tool.name === "mitm_flows")!;
	expect((await workerList.execute("worker-child-a", {}, undefined, undefined, {} as never)).isError).not.toBe(true);
	expect(reader).toHaveBeenLastCalledWith("a");
	const childOptions = spawn.mock.calls.at(-1)![0];
	const context = await childOptions.createSessionContext(["fixture child"]);
	const child = await sdk.createAgentSession({
		cwd: projectA.cwd,
		agentDir: root,
		modelRuntime: childOptions.getModelRuntime(),
		model: childOptions.getModel(),
		...context,
		sessionManager: sdk.SessionManager.inMemory(projectA.cwd),
		baseToolsOverride: {},
		customTools: [
			...childOptions.createVulnTools(() => "fixture child"),
			...(childOptions.createAssetTools?.(() => "fixture child") ?? []),
			...(childOptions.extraTools ?? []),
		],
	});
	try {
		await child.session.bindExtensions({});
		await assertWorkflow(child.session);
	} finally {
		child.session.dispose();
	}
});

async function assertWorkflow(session: sdk.AgentSession): Promise<void> {
	// Stop at the actual model boundary: inspect the prepared prompt/loadout
	// without a provider request, Docker, or a scripted model choosing tools.
	const send = vi.spyOn(session.agent, "prompt").mockResolvedValue();
	try {
		await session.prompt("评估当前目标的 Web 风险");
		expect(send).toHaveBeenCalledOnce();
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["poc_search", "poc_read", "mitm_flows"]));
		// Vitest infers the last overload (string), but AgentSession sends messages.
		const input = send.mock.calls[0][0] as unknown as sdk.AgentSession["messages"];
		expect(Array.isArray(input)).toBe(true);
		const prompt = getCurrentSystemPrompt(input);
		expect(prompt).toContain("<tool_workflow>");
		expect(prompt).toContain("无需用户提醒使用 POC 中心");
		expect(prompt).toContain("When the task or reconnaissance identifies a product");
	} finally {
		send.mockRestore();
	}
}

test("disabled MITM permission removes tools from the real main and sub-agent loadouts", async () => {
	const spawn = vi.spyOn(subagent, "createSubagentTool");
	const permissions = defaultPermissions();
	permissions.main.mitm_read = false;
	writePermissionsConfig(root, permissions);
	await runtime.init();
	expect(runtime.getPermissions().tools.filter((tool) => MITM_TOOL_NAMES.includes(tool.name))).toHaveLength(0);
	expect(spawn.mock.calls[0][0].extraTools?.filter((tool) => MITM_TOOL_NAMES.includes(tool.name))).toHaveLength(0);
});
