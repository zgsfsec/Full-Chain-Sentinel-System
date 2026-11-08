import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeMonitorStore } from "../src/code-monitor-store.ts";
import * as sqlite from "../src/sqlite.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function open() {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-code-query-"));
	const path = join(dir, "code-monitor.db");
	const db = sqlite.openSqliteDatabase(path);
	const prepare = vi.spyOn(db, "prepare");
	vi.spyOn(sqlite, "openSqliteDatabase").mockReturnValueOnce(db);
	const store = new CodeMonitorStore(path);
	cleanups.push(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { path, db, prepare, store };
}

describe("Code monitor query indexes", () => {
	it("uses indexes for ordered lists and linked engines without temporary sorting", () => {
		const { db, prepare, store } = open();
		const cases: Array<{ read: () => unknown; params: sqlite.SqliteValue[]; index: string }> = [
			{
				read: () => store.listActivity("p1", "all", 1, 20),
				params: ["p1", 20, 0],
				index: "idx_code_commits_activity",
			},
			{
				read: () => store.listActivity("p1", "review", 1, 20),
				params: ["p1", 20, 0],
				index: "idx_code_commits_review",
			},
			{
				read: () => store.listActivity("p1", "attention", 1, 20),
				params: ["p1", 20, 0],
				index: "idx_code_commits_attention",
			},
			{ read: () => store.listCommits("m1"), params: ["m1", 100], index: "idx_code_commits_monitor_order" },
			{ read: () => store.listChecks("m1"), params: ["m1", 50], index: "idx_code_checks_monitor_order" },
			{ read: () => store.listChecksByProject("p1"), params: ["p1", 200], index: "idx_code_checks_project" },
			{ read: () => store.listJobs("m1"), params: ["m1", 50], index: "idx_code_jobs_monitor" },
			{ read: () => store.listJobsByProject("p1"), params: ["p1", 200], index: "idx_code_jobs_project" },
			{ read: () => store.linkedEngineIds(), params: [], index: "idx_code_commits_engine" },
			{
				read: () => store.syncEngineStage("e1", "completed"),
				params: ["completed", "e1", "completed"],
				index: "idx_code_commits_engine",
			},
		];
		for (const entry of cases) {
			prepare.mockClear();
			entry.read();
			const sql = prepare.mock.calls.find(([sql]) =>
				/^(SELECT \*|SELECT DISTINCT|UPDATE code_commits)/.test(sql),
			)?.[0];
			expect(sql).toBeDefined();
			const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...entry.params) as Array<{ detail: string }>;
			const details = plan.map((row) => row.detail).join("\n");
			expect(details).toContain(entry.index);
			expect(details).not.toContain("TEMP B-TREE");
		}
	});

	it("reuses one aggregate across status filters and pagination until a database write", () => {
		const { db, prepare, store } = open();
		prepare.mockClear();
		store.activityCounts("p1");
		for (const filter of [
			"all",
			"pending",
			"review",
			"failed",
			"dispatch_failed",
			"attention",
			"reproducing",
			"finished",
		] as const) {
			store.listActivity("p1", filter, 1, 20);
			store.listActivity("p1", filter, 2, 20);
		}
		expect(prepare.mock.calls.filter(([sql]) => sql.includes("SUM(CASE"))).toHaveLength(1);
		expect(prepare.mock.calls.some(([sql]) => sql.startsWith("SELECT COUNT(*) AS total FROM code_commits"))).toBe(
			false,
		);
		db.exec(`INSERT INTO code_commits
			(id, monitor_id, project_id, branch, sha, short_sha, title, message, author, authored_at, url, created_at)
			VALUES ('c1', 'm1', 'p1', 'main', 'sha', 'sha', 'fix', 'fix', 'dev', 1, 'url', 1)`);
		expect(store.listActivity("p1", "pending", 1, 20).total).toBe(1);
		expect(store.activityCounts("p1").pending).toBe(1);
		expect(prepare.mock.calls.filter(([sql]) => sql.includes("SUM(CASE"))).toHaveLength(2);
	});

	it("upgrades legacy indexes after missing columns and preserves data across reopens", () => {
		const { path, db, store } = open();
		db.exec(`INSERT INTO code_commits
			(id, monitor_id, project_id, branch, sha, short_sha, title, message, author, authored_at, url, created_at, engine_id)
			VALUES ('c1', 'm1', 'p1', 'main', 'sha', 'sha', 'fix', 'fix', 'dev', 1, 'url', 1, 'e1')`);
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_code_%'")
			.all() as Array<{ name: string }>;
		for (const { name } of indexes) db.exec(`DROP INDEX "${name.replaceAll('"', '""')}"`);
		db.exec(`ALTER TABLE code_commits DROP COLUMN reproduction_stage;
			CREATE INDEX idx_code_commits_monitor ON code_commits(monitor_id, authored_at DESC);
			CREATE INDEX idx_code_commits_project ON code_commits(project_id, created_at DESC);
			CREATE INDEX idx_code_checks_monitor ON code_monitor_checks(monitor_id, started_at DESC)`);
		store.close();
		cleanups.pop();
		cleanups.push(() => rmSync(dirname(path), { recursive: true, force: true }));
		for (let i = 0; i < 2; i++) {
			const reopened = new CodeMonitorStore(path);
			try {
				expect(reopened.getCommit("c1")).toMatchObject({ engineId: "e1", reproductionStage: "engineering" });
				expect(reopened.listActivity("p1", "reproducing", 1, 20).total).toBe(1);
				const inspector = sqlite.openSqliteDatabase(path);
				try {
					const indexes = inspector.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
						name: string;
					}>;
					expect(indexes.map((row) => row.name)).toEqual(
						expect.arrayContaining([
							"idx_code_commits_activity",
							"idx_code_commits_attention",
							"idx_code_commits_engine",
							"idx_code_checks_project",
							"idx_code_jobs_project",
							"idx_code_jobs_due",
							"idx_code_jobs_active",
						]),
					);
					expect(indexes.map((row) => row.name)).not.toContain("idx_code_commits_project");
				} finally {
					inspector.close();
				}
			} finally {
				reopened.close();
			}
		}
	});

	it("keeps page boundaries stable when authored and creation times are identical", () => {
		const { db, store } = open();
		db.exec(`INSERT INTO code_commits
			(id, monitor_id, project_id, branch, sha, short_sha, title, message, author, authored_at, url, created_at)
			VALUES ('a', 'm1', 'p1', 'main', 'a', 'a', 'fix', 'fix', 'dev', 10, 'url', 20),
			('b', 'm1', 'p1', 'main', 'b', 'b', 'fix', 'fix', 'dev', 10, 'url', 20),
			('c', 'm1', 'p1', 'main', 'c', 'c', 'fix', 'fix', 'dev', 10, 'url', 20)`);
		expect(store.listActivity("p1", "pending", 1, 2).items.map((row) => row.id)).toEqual(["c", "b"]);
		expect(store.listActivity("p1", "pending", 2, 2).items.map((row) => row.id)).toEqual(["a"]);
		expect(store.listCommits("m1").map((row) => row.id)).toEqual(["a", "b", "c"]);
	});
});
