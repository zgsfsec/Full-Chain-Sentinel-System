import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type CodeReproductionResult, parseCodeReproductionResult } from "../src/code-reproduction.ts";
import type { CommanderPort } from "../src/commander-tools.ts";
import { EngineManager } from "../src/engine.ts";
import { EngineStore } from "../src/engine-store.ts";
import type { SentinelEngine } from "../src/protocol.ts";
import { openSqliteDatabase } from "../src/sqlite.ts";

const confirmed: CodeReproductionResult = {
	outcome: "confirmed",
	summary: "Vulnerable version triggers; fixed version rejects the same input.",
	pocPath: "/work/repro/poc.py",
	vulnerableEvidence: "v1: exit 1, ASan heap-buffer-overflow",
	fixedEvidence: "v2: exit 0, invalid input rejected",
};
const limits = { concurrency: 1, roundLimit: 2, tokenLimit: null, timeLimitMin: null, maxRetries: 1 };
const dirs: string[] = [];
const disposers: (() => void)[] = [];

function directory(): string {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-reproduction-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("confirmed conclusions require all comparison evidence; no string coercion", () => {
	expect(parseCodeReproductionResult(confirmed)).toEqual(confirmed);
	for (const field of ["pocPath", "vulnerableEvidence", "fixedEvidence"] as const) {
		expect(parseCodeReproductionResult({ ...confirmed, [field]: undefined })).toBeNull();
		expect(parseCodeReproductionResult({ ...confirmed, [field]: "  " })).toBeNull();
	}
	for (const raw of [
		null,
		[],
		{},
		{ ...confirmed, outcome: ["confirmed"] },
		{ ...confirmed, outcome: "success" },
		{ ...confirmed, summary: " " },
		{ ...confirmed, summary: "x".repeat(4001) },
		{ ...confirmed, vulnerableEvidence: "x".repeat(8001) },
	]) {
		expect(parseCodeReproductionResult(raw)).toBeNull();
	}
});

test.each(["not_reproduced", "inconclusive", "failed"] as const)(
	"%s preserves a concrete reason without claiming confirmation",
	(outcome) => {
		expect(parseCodeReproductionResult({ outcome, summary: "  concrete reason  " })).toEqual({
			outcome,
			summary: "concrete reason",
		});
	},
);

test("report and conclusion survive reopen; corrupt conclusions never become confirmation", () => {
	const path = join(directory(), "engines.db");
	const store = new EngineStore(path);
	const engine = store.createEngine({
		projectId: "p",
		projectName: "P",
		name: "repro",
		targets: [],
		doctrines: ["oss-1day-repro"],
		limits,
		gateMode: "auto",
	});
	store.setEngineReport(engine.id, "# Report", confirmed);
	store.close();
	const reopened = new EngineStore(path);
	expect(reopened.getEngine(engine.id)?.report).toBe("# Report");
	expect(reopened.getEngine(engine.id)?.reproduction).toEqual(confirmed);
	reopened.close();
	const db = openSqliteDatabase(path);
	db.prepare("UPDATE engines SET reproduction = ? WHERE id = ?").run('{"outcome":"confirmed"}', engine.id);
	db.close();
	const corrupted = new EngineStore(path);
	disposers.push(() => corrupted.close());
	expect(corrupted.getEngine(engine.id)?.reproduction).toBeNull();
	expect(corrupted.getEngine(engine.id)?.report).toBe("# Report");
});

test("migrating an old completed report leaves its reproduction conclusion unknown", () => {
	const path = join(directory(), "engines.db");
	const db = openSqliteDatabase(path);
	db.exec(`CREATE TABLE engines (
		id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_name TEXT NOT NULL,
		name TEXT NOT NULL, status TEXT NOT NULL, pause_note TEXT, targets TEXT NOT NULL,
		doctrines TEXT NOT NULL, limits TEXT NOT NULL, created_at INTEGER NOT NULL,
		ended_at INTEGER, report TEXT
	)`);
	db.prepare("INSERT INTO engines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
		"old",
		"p",
		"P",
		"old",
		"completed",
		null,
		"[]",
		'["oss-1day-repro"]',
		JSON.stringify(limits),
		1,
		2,
		"复现成功",
	);
	db.close();
	const store = new EngineStore(path);
	disposers.push(() => store.close());
	expect(store.getEngine("old")?.report).toBe("复现成功");
	expect(store.getEngine("old")?.reproduction).toBeNull();
});

function finishHarness(doctrines = ["oss-1day-repro"]) {
	const dir = directory();
	const manager = new EngineManager(
		dir,
		{ onChange: () => {}, onCommanderEvent: () => {}, onTaskEvent: () => {} },
		async () => {
			throw new Error("No provider session expected");
		},
	);
	disposers.push(() => manager.dispose());
	const store = new EngineStore(join(dir, "engines.db"));
	disposers.push(() => store.close());
	const engine = store.createEngine({
		projectId: "p",
		projectName: "P",
		name: "repro",
		targets: [],
		doctrines,
		limits,
		gateMode: "auto",
	});
	// Exercise the real commander finish boundary without opening a model session.
	const entry = { engine, reportSettled: false };
	const port = (
		manager as unknown as { commanderPort(entry: { engine: SentinelEngine; reportSettled: boolean }): CommanderPort }
	).commanderPort(entry);
	return { port, store, engine };
}

test("OSS finish refuses absent conclusions and unexecuted confirmation without mutating the report", () => {
	const { port, store, engine } = finishHarness();
	expect(port.finish("report").ok).toBe(false);
	expect(port.finish("report", confirmed).ok).toBe(false);
	expect(port.finish("report", { outcome: "not_reproduced", summary: "no trigger" }).ok).toBe(false);
	expect(store.getEngine(engine.id)?.status).toBe("running");
	expect(store.getEngine(engine.id)?.report).toBeNull();
	expect(port.finish("build blocked", { outcome: "failed", summary: "Compiler missing" }).ok).toBe(true);
	expect(store.getEngine(engine.id)?.reproduction?.outcome).toBe("failed");
});

test("OSS finish still waits for outstanding work and persists an explicit conclusion after completion", () => {
	const { port, store, engine } = finishHarness();
	const task = store.createTask({
		engineId: engine.id,
		title: "version comparison",
		objective: "run PoC",
		target: null,
		workspace: "repro",
		roundLimit: 2,
		attempt: 1,
	});
	expect(port.finish("report", confirmed).ok).toBe(false);
	store.updateTask(task.id, { status: "done" });
	expect(port.finish("report", confirmed).ok).toBe(true);
	expect(store.getEngine(engine.id)?.status).toBe("completed");
	expect(store.getEngine(engine.id)?.reproduction).toEqual(confirmed);
});

test("ordinary engineering can finish without a reproduction conclusion", () => {
	const { port, store, engine } = finishHarness(["standard"]);
	expect(port.finish("ordinary report").ok).toBe(true);
	expect(store.getEngine(engine.id)?.reproduction).toBeNull();
});
