import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { getDefaultSessionDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SentinelRuntime, type SentinelRuntimeHooks } from "../src/sentinel-session.ts";
import { SessionUsageStore } from "../src/session-usage-store.ts";
import { writeTestModel } from "./model-fixtures.ts";

let root: string;
let agentDir: string;
let cwd: string;
let runtime: SentinelRuntime | undefined;
let store: SessionUsageStore | undefined;

function usage(input = 100, output = 20): Usage {
	return {
		input,
		output,
		cacheRead: 30,
		cacheWrite: 40,
		totalTokens: input + output + 70,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
	};
}

function assistant(input = 100, output = 20): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: usage(input, output),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createRuntime(project = false): SentinelRuntime {
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
	return new SentinelRuntime({
		cwd,
		agentDir,
		hooks,
		...(project ? { activeProject: { id: "a", name: "A", container: "test-container", cwd } } : {}),
	});
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-session-usage-"));
	agentDir = join(root, "agent");
	cwd = join(root, "workspace");
	mkdirSync(cwd);
});

afterEach(() => {
	runtime?.dispose();
	runtime = undefined;
	store?.close();
	store = undefined;
	rmSync(root, { recursive: true, force: true });
});

test("About usage survives a restart and stays separate from new sessions and projects", async () => {
	const first = SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
	first.appendMessage(assistant());
	const secondCwd = join(root, "project-b");
	mkdirSync(secondCwd);
	const second = SessionManager.create(secondCwd, getDefaultSessionDir(secondCwd, agentDir));
	second.appendMessage(assistant(200, 40));

	runtime = createRuntime();
	await runtime.init();
	expect(runtime.currentSessionId).toBeNull();
	expect(runtime.getStats()).toMatchObject({
		tokens: { total: 0 },
		cumulative: { tokens: { input: 300, output: 60, cacheRead: 60, cacheWrite: 80, total: 500 } },
	});
	expect(runtime.getStats().cumulative.cost).toBeCloseTo(0.074);
	runtime.dispose();

	runtime = createRuntime(true);
	await runtime.init();
	expect(runtime.getStats().tokens.total).toBe(0);
	expect(runtime.getStats().cumulative.tokens.total).toBe(500);
	await runtime.switchSession(first.getSessionFile()!);
	expect(runtime.getStats().tokens.total).toBe(190);
	expect(runtime.getStats().cumulative.tokens.total).toBe(500);
	await runtime.newSession();
	expect(runtime.getStats().tokens.total).toBe(0);
	expect(runtime.getStats().cumulative.tokens.total).toBe(500);
	await runtime.switchProject({ id: "b", name: "B", cwd: secondCwd, container: "test-b" });
	expect(runtime.getStats().tokens.total).toBe(0);
	expect(runtime.getStats().cumulative.tokens.total).toBe(500);
});

test("forked history is counted once, including summary, tool and standalone usage", async () => {
	const manager = SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
	const messageId = manager.appendMessage(assistant());
	manager.appendCompaction("summary", messageId, 1000, undefined, false, usage(10, 2));
	manager.branchWithSummary(messageId, "branch", undefined, false, usage(20, 4));
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "summary-tool",
		toolName: "read",
		content: [{ type: "text", text: "summarized" }],
		isError: false,
		usage: usage(30, 6),
		timestamp: Date.now(),
	});
	manager.appendUsage("cache_warm", "test", "test", usage(40, 8));
	manager.createBranchedSession(manager.getLeafId()!);
	manager.appendMessage(assistant(300, 60));

	store = new SessionUsageStore(agentDir);
	await store.backfill(join(agentDir, "sessions"));
	// Original compaction remains billable even though the fork's branch omits it.
	expect(store.totals().tokens).toEqual({ input: 500, output: 100, cacheRead: 180, cacheWrite: 240, total: 1020 });
	expect(store.totals().cost).toBeCloseTo(0.222);
	store.recordEntries(manager.getEntries());
	await store.backfill(join(agentDir, "sessions"));
	expect(store.totals().tokens.total).toBe(1020);
	store.close();
	store = undefined;
	rmSync(join(agentDir, "sessions"), { recursive: true });
	store = new SessionUsageStore(agentDir);
	await store.backfill(join(agentDir, "sessions"));
	expect(store.totals().tokens.total).toBe(1020);
});

test("a malformed line or partial tail does not erase valid usage or prevent later imports", async () => {
	const sessionDir = getDefaultSessionDir(cwd, agentDir);
	const path = join(sessionDir, "legacy.jsonl");
	const entry = { type: "message", id: "first", timestamp: "2026-01-01T00:00:00Z", message: assistant() };
	writeFileSync(path, `${JSON.stringify(entry)}\ninvalid\n{"type":"message"`);
	store = new SessionUsageStore(agentDir);
	await store.backfill(join(agentDir, "sessions"));
	expect(store.totals().tokens.total).toBe(190);
	appendFileSync(path, `\n${JSON.stringify({ ...entry, id: "second", message: assistant(200, 40) })}\n`);
	await store.backfill(join(agentDir, "sessions"));
	expect(store.totals().tokens.total).toBe(500);
	expect(store.totals().cost).toBeCloseTo(0.074);
});

test("live model usage is retained before restart without requiring an About stats request", async () => {
	const endpoint = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		const chunks = [
			{ choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			{ choices: [], usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 } },
		];
		response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
	});
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	try {
		const address = endpoint.address();
		if (!address || typeof address === "string") throw new Error("no provider port");
		writeTestModel(agentDir, {
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			apiKey: "test-key",
			modelId: "test-model",
		});
		runtime = createRuntime(true);
		await runtime.init();
		await runtime.prompt("hello");
		// Read the durable store directly: a UI request must not be necessary to save usage.
		store = new SessionUsageStore(agentDir);
		expect(store.totals().tokens.total).toBe(168);
		store.close();
		store = undefined;
		runtime.dispose();
		runtime = createRuntime();
		await runtime.init();
		expect(runtime.getStats()).toMatchObject({
			tokens: { total: 0 },
			cumulative: { tokens: { input: 123, output: 45, total: 168 } },
		});
	} finally {
		endpoint.closeAllConnections();
		await new Promise<void>((resolve) => endpoint.close(() => resolve()));
	}
});
