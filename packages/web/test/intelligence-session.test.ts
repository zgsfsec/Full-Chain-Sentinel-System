import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { createGoal, emptyUsage } from "../src/goal.ts";
import { acquireIntelligenceSession } from "../src/intelligence-session.ts";
import { DEFAULT_INTELLIGENCE_TEMPLATE, type IntelligenceEngineInput } from "../src/intelligence-types.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
});

test("real analysis session exposes only goal tools and accepts an alert report without external queries", async () => {
	const dir = mkdtempSync(join(tmpdir(), "intel-session-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "extensions"));
	// Loading this extension would fail the test; analysis must not load user code or context.
	writeFileSync(join(dir, "extensions", "unexpected.ts"), 'throw new Error("extension loaded")');
	writeFileSync(join(dir, "AGENTS.md"), "UNTRUSTED_CONTEXT_MARKER");
	const goal = createGoal({
		id: "goal",
		criteria: [],
		baseline: emptyUsage(),
		objective: "IP analysis",
		roundLimit: 3,
		at: 1,
	});
	const complete = vi.fn();
	const input: IntelligenceEngineInput = {
		attemptId: "a",
		batchId: "b",
		template: structuredClone(DEFAULT_INTELLIGENCE_TEMPLATE),
		items: [{ ip: "192.168.1.1", throughSeq: 1, alertCount: 0, alerts: [] }],
	};
	const options: Parameters<typeof acquireIntelligenceSession>[0] = {
		agentDir: dir,
		project: { id: "p", name: "P", cwd: dir },
		input,
		model: undefined,
		modelRuntime: undefined,
		sessionId: null,
		goalPort: {
			current: () => goal,
			submitted: () => 0,
			progress: () => {},
			complete,
			blocked: () => ({ streak: 0, accepted: false }),
		},
	};
	const create = vi.spyOn(sdk, "createAgentSession");
	const created = await acquireIntelligenceSession(options);
	cleanups.push(created.release);
	const names = ["goal_blocked", "goal_complete", "goal_progress"];
	expect(
		created.session
			.getAllTools()
			.map((tool) => tool.name)
			.sort(),
	).toEqual(names);
	expect(created.session.getActiveToolNames().sort()).toEqual(names);
	expect(created.session.systemPrompt).not.toContain("UNTRUSTED_CONTEXT_MARKER");
	expect(created.session.systemPrompt).toContain("依据批次内的设备告警和证据进行分析");
	const tool = create.mock.calls[0]?.[0]?.customTools?.find((entry) => entry.name === "goal_complete");
	if (!tool) throw new Error("Missing completion tool");
	const params = {
		summary: "# Analysis\nNo device alert evidence is available for this IP.",
		evidence: ["batch alert snapshot"],
		findings: { submitted: 0, note: "只做情报分析" },
	};
	await expect(
		tool.execute("empty-report", { ...params, summary: " " }, undefined, undefined, {} as never),
	).rejects.toThrow();
	expect(complete).not.toHaveBeenCalled();
	await tool.execute("complete", params, undefined, undefined, {} as never);
	expect(complete).toHaveBeenCalledOnce();
	await expect(acquireIntelligenceSession({ ...options, sessionId: "missing" })).rejects.toThrow("文件丢失");
});
