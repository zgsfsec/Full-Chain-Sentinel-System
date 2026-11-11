import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { type EngineHooks, EngineManager } from "../src/engine.ts";
import { EngineStore } from "../src/engine-store.ts";
import { getServerLanguage, setServerLanguage } from "../src/i18n.ts";
import { DEFAULT_INTELLIGENCE_TEMPLATE } from "../src/intelligence-types.ts";
import type { SentinelEngine } from "../src/protocol.ts";

interface LiveEntry {
	engine: SentinelEngine;
}
interface Internals {
	store: EngineStore;
	live: Map<string, LiveEntry>;
	finishIntelligence(entry: LiveEntry): Promise<void>;
}
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function setup(archiveReport: EngineHooks["archiveReport"] = async () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "intel-engine-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify({ projects: [{ id: "p", name: "P", workDir: dir, createdAt: "" }] }),
	);
	const seed = new EngineStore(join(dir, "engines.db"));
	const engine = seed.createIntelligenceEngine(
		{ id: "p", name: "P" },
		{
			attemptId: "attempt",
			batchId: "batch",
			template: structuredClone(DEFAULT_INTELLIGENCE_TEMPLATE),
			items: [{ ip: "1.1.1.1", throughSeq: 1, alertCount: 0, alerts: [] }],
		},
	);
	seed.close();
	const acquire = vi.fn(async () => {
		throw new Error("Ordinary task runtime must not be used");
	});
	const manager = new EngineManager(
		dir,
		{ onChange: vi.fn(), onTaskEvent: vi.fn(), onCommanderEvent: vi.fn(), archiveReport },
		acquire,
	);
	cleanups.push(() => manager.dispose());
	const internals = manager as unknown as Internals;
	const entry = internals.live.get(engine.id);
	if (!entry) throw new Error("Missing engine");
	expect(entry.engine.status).toBe("paused");
	internals.store.setEngineStatus(engine.id, "running", null, null);
	entry.engine = internals.store.getEngine(engine.id) ?? engine;
	return { manager, internals, entry, acquire, taskId: engine.tasks[0].id };
}

test("only done tasks and an archived nonempty report complete an analysis engine", async () => {
	const archive = vi.fn(async () => {});
	const { manager, internals, entry, taskId, acquire } = setup(archive);
	await internals.finishIntelligence(entry);
	expect(archive).not.toHaveBeenCalled();
	internals.store.updateTask(taskId, { status: "done", summary: "# Full report" });
	await internals.finishIntelligence(entry);
	expect(archive).toHaveBeenCalledOnce();
	expect(manager.getEngine(entry.engine.id)).toMatchObject({ status: "completed", report: "# Full report" });
	await manager.abortEngine(entry.engine.id);
	expect(manager.getEngine(entry.engine.id)?.status).toBe("completed");
	expect(acquire).not.toHaveBeenCalled();
	internals.store.updateTask(taskId, { sessionId: "restricted-session" });
	expect(() => manager.taskSessionPath(taskId)).toThrow("分析会话");
});

test("analysis startup never falls back to the ordinary runtime when the model is unconfigured", async () => {
	const { manager, internals, entry, acquire } = setup();
	internals.store.setEngineStatus(entry.engine.id, "paused", "test", null);
	entry.engine = internals.store.getEngine(entry.engine.id) ?? entry.engine;
	await manager.resumeEngine(entry.engine.id);
	await vi.waitFor(() => expect(manager.getEngine(entry.engine.id)?.status).toBe("stopped"));
	expect(acquire).not.toHaveBeenCalled();
	expect(manager.getEngine(entry.engine.id)?.tasks[0].summary).toContain("请先配置");
});

test.each(["failed", "empty", "archive"])("%s prevents whole-batch success", async (failure) => {
	const { manager, internals, entry, taskId } = setup(async () => {
		if (failure === "archive") throw new Error("disk full");
	});
	internals.store.updateTask(taskId, {
		status: failure === "failed" ? "failed" : "done",
		summary: failure === "empty" ? "" : "report",
	});
	await internals.finishIntelligence(entry);
	expect(manager.getEngine(entry.engine.id)?.status).toBe("stopped");
	expect(manager.getEngine(entry.engine.id)?.report).toBeFalsy();
});

test("operator abort while archiving cannot become successful after the archive returns", async () => {
	let finish: () => void = () => {};
	const { manager, internals, entry, taskId } = setup(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	internals.store.updateTask(taskId, { status: "done", summary: "report" });
	const archiving = internals.finishIntelligence(entry);
	await manager.abortEngine(entry.engine.id);
	finish();
	await archiving;
	expect(manager.getEngine(entry.engine.id)).toMatchObject({ status: "stopped", pauseNote: "操作员终止" });
});

test("analysis abort remains distinguishable from failure with the English UI", async () => {
	const previous = getServerLanguage();
	try {
		setServerLanguage("en");
		const { manager, entry } = setup();
		await manager.abortEngine(entry.engine.id);
		expect(manager.getEngine(entry.engine.id)).toMatchObject({ status: "stopped", pauseNote: "操作员终止" });
	} finally {
		setServerLanguage(previous);
	}
});
