import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CREDENTIAL_TOOL_NAMES } from "../src/credential-tool.ts";
import { parseCredential } from "../src/credential-types.ts";
import { SentinelRuntime } from "../src/sentinel-session.ts";
import { readSessionCredentials } from "../src/session-credentials.ts";
import { writeTestModel } from "./model-fixtures.ts";

let root: string, runtime: SentinelRuntime;
let projectA: { id: string; name: string; container: string; cwd: string }, projectB: typeof projectA;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "credential-runtime-"));
	projectA = { id: "a", name: "A", container: "fixture-a", cwd: join(root, "a") };
	projectB = { id: "b", name: "B", container: "fixture-b", cwd: join(root, "b") };
	for (const project of [projectA, projectB]) mkdirSync(project.cwd);
	writeFileSync(
		join(root, "projects.json"),
		JSON.stringify({ projects: [projectA, projectB].map((p) => ({ ...p, workDir: p.cwd, createdAt: "" })) }),
	);
	writeTestModel(root, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture", modelId: "fixture" });
	runtime = new SentinelRuntime({
		cwd: projectA.cwd,
		agentDir: root,
		activeProject: projectA,
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
});
afterEach(() => {
	runtime.dispose();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

test("real sessions default off; toggles load tools without prompting and persist on their branch", async () => {
	const created = vi.spyOn(sdk, "createAgentSession");
	await runtime.init();
	const main = (await created.mock.results[0].value) as Awaited<ReturnType<typeof sdk.createAgentSession>>,
		prompt = vi.spyOn(main.session.agent, "prompt").mockResolvedValue(undefined);
	expect(runtime.snapshot().credentialsEnabled).toBe(false);
	expect(main.session.getActiveToolNames().some((name) => CREDENTIAL_TOOL_NAMES.includes(name))).toBe(false);
	expect(main.session.systemPrompt).not.toContain("凭据客户端选择");
	runtime.setCredentialsEnabled(true);
	expect(main.session.getActiveToolNames()).toEqual(expect.arrayContaining([...CREDENTIAL_TOOL_NAMES]));
	for (const client of [
		"sshpass -e",
		"nxc winrm",
		"ldapwhoami",
		"mariadb",
		"psql",
		"redis-cli",
		"tsql",
		"pymongo.MongoClient",
		"snmpget",
	]) {
		expect(main.session.systemPrompt).toContain(client);
	}
	expect(main.session.systemPrompt).toContain("工具缺失、网络不通、TLS 或协议不匹配");
	expect(readSessionCredentials(main.session.sessionManager.getBranch())).toBe(true);
	expect(prompt).not.toHaveBeenCalled();
	runtime.setCredentialsEnabled(false);
	expect(main.session.getActiveToolNames().some((name) => CREDENTIAL_TOOL_NAMES.includes(name))).toBe(false);
	expect(main.session.systemPrompt).not.toContain("凭据客户端选择");
	expect(main.session.systemPrompt).not.toContain("pymongo.MongoClient");
	expect(readSessionCredentials(main.session.sessionManager.getBranch())).toBe(false);
});

test("page verification starts a new ordinary conversation with tools enabled and no secrets in its prompt", async () => {
	const created = vi.spyOn(sdk, "createAgentSession");
	await runtime.init();
	const original = (await created.mock.results[0].value) as Awaited<ReturnType<typeof sdk.createAgentSession>>;
	const originalId = runtime.currentSessionId;
	const prompt = vi.spyOn(sdk.AgentSession.prototype, "prompt").mockResolvedValue(undefined);
	const one = runtime.credentialStore.save("a", [
		parseCredential({ type: "MySQL", host: "192.0.2.1", password: "fixture-secret" }),
	])[0];
	await runtime.verifyCredentials("a", [one]);
	const fresh = (await created.mock.results[1].value) as Awaited<ReturnType<typeof sdk.createAgentSession>>;
	expect(runtime.currentSessionId).not.toBe(originalId);
	expect(runtime.currentSessionId).toBe(fresh.session.sessionId);
	expect(fresh.session.sessionManager.getSessionName()).toBe("凭据验证 · 1 条");
	expect(prompt).toHaveBeenCalledOnce();
	expect(prompt.mock.contexts[0]).toBe(fresh.session);
	const instruction = JSON.stringify(prompt.mock.calls[0][0]);
	expect(instruction).toContain(one.id);
	expect(instruction).not.toContain("fixture-secret");
	expect(runtime.snapshot().credentialsEnabled).toBe(true);
	expect(fresh.session.getActiveToolNames()).toEqual(expect.arrayContaining([...CREDENTIAL_TOOL_NAMES]));
	expect(fresh.session.systemPrompt).toContain("凭据客户端选择");
	expect(original.session.systemPrompt).not.toContain("凭据客户端选择");
	expect(original.session.getActiveToolNames().some((name) => CREDENTIAL_TOOL_NAMES.includes(name))).toBe(false);
	const read = created.mock.calls[1][0]!.customTools!.find((tool) => tool.name === "credential_read")!;
	expect(
		(await read.execute("verify", { id: one.id, purpose: "verify" }, undefined, undefined, {} as never)).isError,
	).not.toBe(true);
	await runtime.switchProject(projectB);
	expect(runtime.snapshot().credentialsEnabled).toBe(false);
	expect(
		(await read.execute("background-a", { id: one.id, purpose: "verify" }, undefined, undefined, {} as never))
			.isError,
	).not.toBe(true);
	await expect(runtime.verifyCredentials("a", [one])).rejects.toThrow("已切换");
});

test("an existing running conversation does not block or receive page verification", async () => {
	const created = vi.spyOn(sdk, "createAgentSession");
	await runtime.init();
	const original = (await created.mock.results[0].value) as Awaited<ReturnType<typeof sdk.createAgentSession>>;
	const streaming = vi.spyOn(original.session, "isStreaming", "get").mockReturnValue(true);
	const abort = vi.spyOn(original.session, "abort").mockResolvedValue(undefined);
	const prompt = vi.spyOn(sdk.AgentSession.prototype, "prompt").mockResolvedValue(undefined);
	const one = runtime.credentialStore.save("a", [parseCredential({ type: "Linux", host: "192.0.2.1" })])[0];
	await runtime.verifyCredentials("a", [one]);
	expect(runtime.currentSessionId).not.toBe(original.session.sessionId);
	expect(abort).not.toHaveBeenCalled();
	expect(prompt.mock.contexts[0]).not.toBe(original.session);
	expect(original.session.isStreaming).toBe(true);
	streaming.mockRestore();
});

test("stale selections are rejected before creating a conversation", async () => {
	const created = vi.spyOn(sdk, "createAgentSession");
	await runtime.init();
	const originalId = runtime.currentSessionId;
	const one = runtime.credentialStore.save("a", [parseCredential({ type: "Linux", host: "192.0.2.1" })])[0];
	await expect(runtime.verifyCredentials("a", [{ ...one, revision: "stale" }])).rejects.toThrow("已修改");
	expect(created).toHaveBeenCalledOnce();
	expect(runtime.currentSessionId).toBe(originalId);
	expect(runtime.snapshot().credentialsEnabled).toBe(false);
});

test("switching project during verification setup cannot send its instruction into another project", async () => {
	const create = sdk.createAgentSession;
	const created = vi.spyOn(sdk, "createAgentSession");
	await runtime.init();
	let release: () => void = () => {};
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	created.mockImplementationOnce(async (options) => {
		await waiting;
		return create(options);
	});
	const prompt = vi.spyOn(sdk.AgentSession.prototype, "prompt").mockResolvedValue(undefined);
	const one = runtime.credentialStore.save("a", [parseCredential({ type: "Linux", host: "192.0.2.1" })])[0];
	const verifying = runtime.verifyCredentials("a", [one]);
	await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(2));
	await expect(runtime.verifyCredentials("a", [one])).rejects.toThrow("正在创建");
	await runtime.switchProject(projectB);
	const projectBSession = runtime.currentSessionId;
	const rejected = expect(verifying).rejects.toThrow("已切换");
	release();
	await rejected;
	expect(runtime.currentProject?.id).toBe("b");
	expect(runtime.currentSessionId).toBe(projectBSession);
	expect(prompt).not.toHaveBeenCalled();
});
