import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import * as sdk from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { REPLAY_TOOL_NAMES } from "../src/replay-tool.ts";
import { SentinelRuntime } from "../src/sentinel-session.ts";
import { readSessionReports, SESSION_REPORTS_CUSTOM_TYPE } from "../src/session-reports.ts";
import { writeTestModel } from "./model-fixtures.ts";

const reportNames = ["report_submit", ...REPLAY_TOOL_NAMES];
const noop = () => {};
let root: string;
let runtime: SentinelRuntime;
let projectA: { id: string; name: string; container: string; cwd: string };
let projectB: typeof projectA;

function createRuntime() {
	return new SentinelRuntime({
		cwd: projectA.cwd,
		agentDir: root,
		activeProject: projectA,
		hooks: {
			onSessionEvent: noop,
			onStateChange: noop,
			onSubagentEvent: noop,
			onNotifyStatus: noop,
			onVulnChange: noop,
			onAssetChange: noop,
			onSessionRenamed: noop,
			onVulnSubmitted: noop,
			onGateDecision: noop,
			onPocChange: noop,
			onPocSourceChange: noop,
			onApiModelChange: noop,
			onDroidChange: noop,
			onIosChange: noop,
			onSupervisorState: noop,
			onSupervisorEpisode: noop,
			onSupervisorLog: noop,
			onSupervisorAdvice: noop,
		},
	});
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-report-runtime-"));
	projectA = { id: "a", name: "A", container: "fixture-report-a", cwd: join(root, "a") };
	projectB = { id: "b", name: "B", container: "fixture-report-b", cwd: join(root, "b") };
	for (const project of [projectA, projectB]) mkdirSync(project.cwd);
	writeFileSync(
		join(root, "projects.json"),
		JSON.stringify({
			projects: [projectA, projectB].map((project) => ({ ...project, workDir: project.cwd, createdAt: "" })),
		}),
	);
	writeTestModel(root, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture", modelId: "fixture" });
	runtime = createRuntime();
});

afterEach(() => {
	runtime.dispose();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

test("report entries default off, use the last valid value and ignore unrelated or malformed entries", () => {
	const on = { type: "custom", customType: SESSION_REPORTS_CUSTOM_TYPE, data: { enabled: true } };
	expect(readSessionReports([])).toBe(false);
	expect(readSessionReports([null, { ...on, customType: "zg-credentials" }])).toBe(false);
	expect(readSessionReports([on, { ...on, data: { enabled: "false" } }])).toBe(true);
	expect(readSessionReports([on, { ...on, data: null }])).toBe(false);
	expect(readSessionReports([on, { ...on, data: { enabled: false } }])).toBe(false);
});

test("report tools and their workflow require opt-in and toggling does not prompt or rebuild a session", async () => {
	const created = vi.spyOn(sdk, "createAgentSession");
	await runtime.init();
	const { session } = await created.mock.results[0].value;
	const send = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
	// Inspect the prepared messages at the model boundary; the stub never appends a provider reply.
	const preparedPrompt = () =>
		getCurrentSystemPrompt(send.mock.calls.at(-1)![0] as unknown as sdk.AgentSession["messages"]);
	expect(runtime.snapshot().reportsEnabled).toBe(false);
	for (const name of reportNames) expect(session.getActiveToolNames()).not.toContain(name);
	await session.prompt("评估当前目标");
	expect(preparedPrompt()).not.toContain("report_submit");
	expect(preparedPrompt()).not.toContain("replay_capture");
	send.mockClear();
	runtime.setReportsEnabled(true);
	expect(send).not.toHaveBeenCalled();
	expect(created).toHaveBeenCalledOnce();
	expect(runtime.snapshot().reportsEnabled).toBe(true);
	expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(reportNames));
	expect(readSessionReports(session.sessionManager.getBranch())).toBe(true);
	await session.prompt("完成后归档报告");
	const enabledPrompt = preparedPrompt();
	expect(enabledPrompt).toContain("report_submit");
	expect(enabledPrompt).toContain("成功后再 goal_complete 或最终回复");
	expect(enabledPrompt).toContain("replay_capture");
	send.mockClear();
	runtime.setReportsEnabled(false);
	expect(send).not.toHaveBeenCalled();
	for (const name of reportNames) expect(session.getActiveToolNames()).not.toContain(name);
	await session.prompt("继续讨论结论");
	const disabledPrompt = preparedPrompt();
	expect(disabledPrompt).not.toContain("report_submit");
	expect(disabledPrompt).not.toContain("replay_capture");
	expect(disabledPrompt).not.toContain("成功后再 goal_complete 或最终回复");
	expect(runtime.snapshot().reportsEnabled).toBe(false);
});

test("a disabled submission cannot archive, and a background session keeps its own project and switch", async () => {
	const created = vi.spyOn(sdk, "createAgentSession");
	await runtime.init();
	const sourcePath = runtime.currentSessionPath!;
	const submit = created.mock.calls[0][0]!.customTools!.find((tool) => tool.name === "report_submit")!;
	const denied = await submit.execute(
		"off",
		{ title: "测试报告", markdown: "# 结果" },
		undefined,
		undefined,
		{} as never,
	);
	expect(denied.isError).toBe(true);
	expect(denied.content).toEqual([{ type: "text", text: expect.stringContaining("启用报告中心") }]);
	expect(runtime.reports.list("a").total).toBe(0);
	runtime.setReportsEnabled(true);
	await runtime.switchProject(projectB);
	expect(runtime.snapshot().reportsEnabled).toBe(false);
	const saved = await submit.execute(
		"background",
		{ title: "A 的报告", markdown: "# 结果" },
		undefined,
		undefined,
		{} as never,
	);
	expect(saved.isError).not.toBe(true);
	expect(runtime.reports.list("a").total).toBe(1);
	expect(runtime.reports.list("b").total).toBe(0);
	await runtime.switchProject(projectA);
	await runtime.switchSession(sourcePath);
	expect(runtime.snapshot().reportsEnabled).toBe(true);
	runtime.setReportsEnabled(false);
	expect(
		(await submit.execute("off-again", { title: "禁止归档", markdown: "body" }, undefined, undefined, {} as never))
			.isError,
	).toBe(true);
	expect(runtime.reports.list("a").total).toBe(1);
});

test("new conversations start off and reopening a persisted conversation restores its own choice", async () => {
	const created = vi.spyOn(sdk, "createAgentSession");
	await runtime.init();
	const { session } = await created.mock.results[0].value;
	session.sessionManager.appendMessage({ role: "user", content: "测试对话", timestamp: Date.now() });
	const path = session.sessionManager.getSessionFile()!;
	runtime.setReportsEnabled(true);
	await runtime.newSession();
	expect(runtime.snapshot().reportsEnabled).toBe(false);
	await runtime.switchSession(path);
	expect(runtime.snapshot().reportsEnabled).toBe(true);
	runtime.dispose();
	runtime = createRuntime();
	await runtime.init();
	await runtime.switchSession(path);
	expect(runtime.snapshot().reportsEnabled).toBe(true);
	const reopened = await created.mock.results.at(-1)!.value;
	expect(reopened.session.getActiveToolNames()).toEqual(expect.arrayContaining(reportNames));
	runtime.setReportsEnabled(false);
	const manager = sdk.SessionManager.open(path);
	expect(readSessionReports(manager.getBranch())).toBe(false);
});

test("branch navigation restores the branch's report switch and loadout", async () => {
	const created = vi.spyOn(sdk, "createAgentSession");
	await runtime.init();
	const { session } = await created.mock.results[0].value;
	const userId = session.sessionManager.appendMessage({ role: "user", content: "分支起点", timestamp: Date.now() });
	runtime.setReportsEnabled(true);
	const enabledId = session.sessionManager.getLeafId()!;
	await runtime.navigate(userId);
	expect(runtime.snapshot().reportsEnabled).toBe(false);
	for (const name of reportNames) expect(session.getActiveToolNames()).not.toContain(name);
	await runtime.navigate(enabledId);
	expect(runtime.snapshot().reportsEnabled).toBe(true);
	expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(reportNames));
});

test("engineering workers retain report submission without inheriting the console's screenshot tools", async () => {
	await runtime.init();
	const worker = await runtime.acquireTaskSession({
		project: projectA,
		appendPrompt: "worker",
		presetId: null,
		taskTitle: "测试任务",
		engineId: "engine-fixture",
		taskId: "task-fixture",
		gateMode: "auto",
		taskSessionId: null,
		reopen: false,
		onFinding: noop,
		goalPort: {
			current: () => undefined,
			submitted: () => 0,
			progress: noop,
			complete: noop,
			blocked: () => ({ streak: 0, accepted: false }),
		},
	});
	expect(worker.session.getActiveToolNames()).toContain("report_submit");
	for (const name of REPLAY_TOOL_NAMES)
		expect(worker.session.getAllTools().map((tool) => tool.name)).not.toContain(name);
	worker.release();
});
