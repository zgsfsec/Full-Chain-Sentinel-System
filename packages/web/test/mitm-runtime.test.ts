import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MitmCenter } from "../src/mitm.ts";
import { MITM_TOOL_NAMES } from "../src/mitm-tool.ts";
import { defaultPermissions, writePermissionsConfig } from "../src/permissions.ts";
import { SentinelRuntime, type SentinelRuntimeHooks } from "../src/sentinel-session.ts";
import * as subagent from "../src/subagent.ts";

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
	const spawn = vi.spyOn(subagent, "createSubagentTool");
	const reader = vi.spyOn(MitmCenter.prototype, "reader").mockResolvedValue(undefined);
	await runtime.init();
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
	const workerChildTools = spawn.mock.calls.at(-1)?.[0].extraTools ?? [];
	const workerList = workerChildTools.find((tool) => tool.name === "mitm_flows")!;
	expect((await workerList.execute("worker-child-a", {}, undefined, undefined, {} as never)).isError).not.toBe(true);
	expect(reader).toHaveBeenLastCalledWith("a");
});

test("disabled MITM permission removes tools from the real main and sub-agent loadouts", async () => {
	const spawn = vi.spyOn(subagent, "createSubagentTool");
	const permissions = defaultPermissions();
	permissions.main.mitm_read = false;
	writePermissionsConfig(root, permissions);
	await runtime.init();
	expect(runtime.getPermissions().tools.filter((tool) => MITM_TOOL_NAMES.includes(tool.name))).toHaveLength(0);
	expect(spawn.mock.calls[0][0].extraTools?.filter((tool) => MITM_TOOL_NAMES.includes(tool.name))).toHaveLength(0);
});
