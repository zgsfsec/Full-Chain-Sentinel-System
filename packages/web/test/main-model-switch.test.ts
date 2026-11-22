import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { addLibraryEntry, libraryView } from "../src/model-library.ts";
import { SentinelRuntime, type SentinelRuntimeHooks } from "../src/sentinel-session.ts";
import { modelStream } from "./model-stream-fixtures.ts";

let root = "";
let runtime: SentinelRuntime;
let first: string;
let second: string;
let requests: string[];
let requestStarted: Promise<void>;
let releaseRequest: () => void;
let closeProvider: () => Promise<void>;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "sentinel-main-switch-"));
	requests = [];
	let notifyRequest: () => void = () => {};
	requestStarted = new Promise<void>((resolve) => {
		notifyRequest = resolve;
	});
	const requestGate = new Promise<void>((resolve) => {
		releaseRequest = resolve;
	});
	const provider = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const payload = JSON.parse(Buffer.concat(chunks).toString()) as { model: string };
		requests.push(payload.model);
		notifyRequest();
		if (requests.length === 1) await requestGate;
		if (res.destroyed) return;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(await modelStream("openai-completions", "fixture answer").text());
	});
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	closeProvider = () =>
		new Promise<void>((resolve) => {
			provider.closeAllConnections();
			provider.close(() => resolve());
		});
	const address = provider.address();
	if (!address || typeof address === "string") throw new Error("No provider address");
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	mkdirSync(cwd);
	const config = { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture" };
	first = addLibraryEntry(agentDir, {
		...config,
		name: "Text model",
		modelId: "text-model",
		capabilities: { reasoning: false, input: ["text"] },
	}).id;
	second = addLibraryEntry(agentDir, {
		...config,
		name: "Vision reasoner",
		modelId: "vision-model",
		capabilities: {
			reasoning: true,
			input: ["text", "image"],
			defaultThinkingLevel: "high",
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high" },
		},
	}).id;
	const noop = () => {};
	const hooks: SentinelRuntimeHooks = {
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
	};
	runtime = new SentinelRuntime({
		cwd,
		agentDir,
		hooks,
		activeProject: { id: "fixture", name: "Fixture", cwd, container: "unused" },
	});
	await runtime.init();
});

afterEach(async () => {
	releaseRequest?.();
	await runtime?.dispose();
	await closeProvider?.();
	if (root) rmSync(root, { recursive: true, force: true });
});

test("switching an idle main model preserves the conversation and refreshes its reasoning capabilities", async () => {
	const before = runtime.snapshot();
	expect(before.model).toEqual({ provider: first, id: "text-model" });
	expect(before.availableThinkingLevels).toEqual(["off"]);
	const selected = await runtime.setModelRole("main", second);
	const after = runtime.snapshot();
	expect(selected.roles.main).toBe(second);
	expect(after.activeSessionId).toBe(before.activeSessionId);
	expect(after.messages).toEqual(before.messages);
	expect(after.model).toEqual({ provider: second, id: "vision-model" });
	expect(after.availableThinkingLevels).toEqual(["low", "high"]);
	expect(after.thinkingLevel).toBe("high");
	expect(requests).toEqual([]);
	expect(libraryView(join(root, "agent")).resolved.judge?.entryId).toBe(second);
});

test("switching a running main model keeps its request intact and uses the new model on the next idle send", async () => {
	const sessionId = runtime.snapshot().activeSessionId;
	const running = runtime.prompt("fixture first message");
	await requestStarted;
	expect(runtime.snapshot().streaming).toBe(true);
	const selected = await runtime.setModelRole("main", second);
	expect(selected.roles.main).toBe(second);
	expect(runtime.snapshot().model).toEqual({ provider: first, id: "text-model" });
	expect(runtime.snapshot().availableThinkingLevels).toEqual(["off"]);
	releaseRequest();
	await running;
	await runtime.prompt("fixture second message");
	const after = runtime.snapshot();
	expect(after.activeSessionId).toBe(sessionId);
	expect(after.model).toEqual({ provider: second, id: "vision-model" });
	expect(after.thinkingLevel).toBe("high");
	expect(requests).toEqual(["text-model", "vision-model"]);
	expect(after.messages.filter((message) => (message as { role?: string }).role === "user")).toHaveLength(2);
});

test("an unknown model is rejected without changing the configured main model", async () => {
	await expect(runtime.setModelRole("main", "missing-entry")).rejects.toThrow();
	expect(runtime.snapshot().model?.provider).toBe(first);
	expect(libraryView(join(root, "agent")).roles.main).toBe(first);
});
