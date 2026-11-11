import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { createGoal, emptyUsage } from "../src/goal.ts";
import { IntelligenceQueries } from "../src/intelligence-query.ts";
import { acquireIntelligenceSession } from "../src/intelligence-session.ts";
import { DEFAULT_INTELLIGENCE_TEMPLATE, type IntelligenceEngineInput } from "../src/intelligence-types.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
});

test("real analysis session exposes only scoped intelligence and goal tools; completion requires evidence", async () => {
	const dir = mkdtempSync(join(tmpdir(), "intel-session-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "extensions"));
	// Loading this extension would fail the test; analysis must not load user code or context.
	writeFileSync(join(dir, "extensions", "unexpected.ts"), 'throw new Error("extension loaded")');
	writeFileSync(join(dir, "AGENTS.md"), "UNTRUSTED_CONTEXT_MARKER");
	const queries = new IntelligenceQueries(
		dir,
		join(dir, "q.db"),
		vi.fn(async () => {
			throw new Error("No network permitted in test");
		}),
	);
	cleanups.push(() => queries.close());
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
		queries,
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
	const names = ["goal_blocked", "goal_complete", "goal_progress", "ip_intelligence"];
	expect(
		created.session
			.getAllTools()
			.map((tool) => tool.name)
			.sort(),
	).toEqual(names);
	expect(created.session.getActiveToolNames().sort()).toEqual(names);
	expect(created.session.systemPrompt).not.toContain("UNTRUSTED_CONTEXT_MARKER");
	const tool = create.mock.calls[0]?.[0]?.customTools?.find((entry) => entry.name === "goal_complete");
	if (!tool) throw new Error("Missing completion tool");
	const params = {
		summary: "# Analysis\nPrivate address; no external query applicable.",
		evidence: ["scoped intelligence"],
		findings: { submitted: 0, note: "只做情报分析" },
	};
	await expect(tool.execute("before-query", params, undefined, undefined, {} as never)).rejects.toThrow("缺少");
	expect(complete).not.toHaveBeenCalled();
	await queries.lookup("p", input, "192.168.1.1");
	await tool.execute("complete", params, undefined, undefined, {} as never);
	expect(complete).toHaveBeenCalledOnce();
	await expect(acquireIntelligenceSession({ ...options, sessionId: "missing" })).rejects.toThrow("文件丢失");
});
