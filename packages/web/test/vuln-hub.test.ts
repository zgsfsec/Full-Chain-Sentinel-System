/**
 * The vulnerability hub's storage: provenance, filtering and batch deletion.
 *
 * Findings record where they came from (工程/任务/会话) so the hub can be
 * filtered long after a session file is gone, and deletion is now a batch
 * operation scoped to one project. What is pinned here is that filters combine,
 * that a deletion reports and then removes exactly what it previewed, that an id
 * from another project cannot be deleted through this one, and that the one-time
 * provenance backfill fills old rows without overwriting newer values.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openSqliteDatabase } from "../src/sqlite.ts";
import { MAX_VULN_PAGE_SIZE, type SentinelVulnCreateInput, VulnerabilityStore } from "../src/vulnerabilities.ts";

const roots: string[] = [];
const stores: VulnerabilityStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openStore(): { store: VulnerabilityStore; path: string } {
	const root = mkdtempSync(join(tmpdir(), "sentinel-vuln-hub-"));
	roots.push(root);
	const path = join(root, "vulns.db");
	const store = new VulnerabilityStore(path);
	stores.push(store);
	return { store, path };
}

let sequence = 0;
function submit(store: VulnerabilityStore, overrides: Partial<SentinelVulnCreateInput> = {}): string {
	sequence += 1;
	const vuln = store.create({
		projectId: "p1",
		projectName: "靶场",
		sessionId: `s${sequence}`,
		source: "主代理",
		title: `发现 ${sequence}`,
		severity: "high",
		cvss: 7.5,
		target: "10.0.0.5",
		description: "描述",
		packet: "GET / HTTP/1.1",
		evidence: [{ kind: "command", command: "nmap", output: "22/tcp open" }],
		...overrides,
	});
	// `create` already appends a submission note; this adds a reviewer note, so the
	// deletion preview has two kinds to count.
	store.update(vuln.id, { note: "复核备注" });
	return vuln.id;
}

test("provenance is stored with the finding", () => {
	const { store } = openStore();
	const id = submit(store, {
		sessionId: "s-eng",
		engineId: "engine-1",
		taskId: "task-1",
		sessionName: "10.0.0.5 侦察",
	});
	const found = store.find("p1", id);
	expect(found?.engineId).toBe("engine-1");
	expect(found?.taskId).toBe("task-1");
	expect(found?.sessionName).toBe("10.0.0.5 侦察");
});

test("filters by session, engine and task, and search covers the source text", () => {
	const { store } = openStore();
	submit(store, { sessionId: "s-a", engineId: "e1", taskId: "t1", source: "工程任务「内网打点」" });
	submit(store, { sessionId: "s-b", engineId: "e1", taskId: "t2", source: "主代理" });
	submit(store, { sessionId: "s-c", engineId: "e2", taskId: "t3", source: "子代理 run-9" });

	expect(store.list("p1", { sessionId: "s-a" })).toHaveLength(1);
	expect(store.list("p1", { engineId: "e1" })).toHaveLength(2);
	// Filters combine with AND.
	expect(store.list("p1", { engineId: "e1", taskId: "t2" })).toHaveLength(1);
	expect(store.list("p1", { engineId: "e2", taskId: "t2" })).toHaveLength(0);
	// The list's 来源 column is searchable, and target filtering still works.
	expect(store.list("p1", { search: "内网打点" })).toHaveLength(1);
	expect(store.list("p1", { search: "run-9" })).toHaveLength(1);
	expect(store.list("p1", { target: "10.0.0.5" })).toHaveLength(3);
	expect(store.list("p1", { target: "192.168" })).toHaveLength(0);
});

test("severity selections match any chosen level while other filters and project boundaries still apply", () => {
	const { store } = openStore();
	const high = submit(store, { engineId: "e1" });
	const critical = submit(store, { severity: "critical", cvss: 9.8, engineId: "e1" });
	submit(store, { severity: "low", cvss: 2, engineId: "e1" });
	submit(store, { severity: "critical", cvss: 9.8, engineId: "e2" });
	submit(store, { projectId: "p2", severity: "critical", cvss: 9.8, engineId: "e1" });

	expect(store.list("p1", { severity: ["high", "critical"], engineId: "e1" }).map((item) => item.id)).toEqual([
		critical,
		high,
	]);
	expect(store.list("p1", { severity: ["critical"], ids: [high, critical] }).map((item) => item.id)).toEqual([
		critical,
	]);
	expect(store.list("p1", { severity: [] })).toHaveLength(4);
});

test("a deletion previews what it will take and then removes exactly that", () => {
	const { store } = openStore();
	const first = submit(store);
	const second = submit(store);
	const keep = submit(store);

	const preview = store.deletePreview("p1", [first, second]);
	// Two notes per record: the submission note and the review note added above.
	expect(preview).toEqual({ count: 2, evidence: 2, notes: 4 });
	// Previewing deletes nothing.
	expect(store.list("p1", {})).toHaveLength(3);

	expect(store.deleteMany("p1", [first, second])).toBe(2);
	const left = store.list("p1", {});
	expect(left.map((item) => item.id)).toEqual([keep]);
	// Evidence and notes went with the records, not with the neighbours.
	expect(store.find("p1", keep)?.notes).toHaveLength(2);
	expect(store.find("p1", keep)?.evidence).toHaveLength(1);
	// Unknown ids are simply not there, and an empty selection is a no-op.
	expect(store.deleteMany("p1", ["missing"])).toBe(0);
	expect(store.deleteMany("p1", [])).toBe(0);
	expect(store.deletePreview("p1", [])).toEqual({ count: 0, evidence: 0, notes: 0 });
});

test("selected ids restrict findings within the project and combine with other filters", () => {
	const { store } = openStore();
	const first = submit(store);
	const second = submit(store, { severity: "low", cvss: 2 });
	submit(store);
	const foreign = submit(store, { projectId: "p2" });

	expect(store.list("p1", { ids: [first] }).map((item) => item.id)).toEqual([first]);
	expect(store.list("p1", { ids: [first, second, first, foreign, "missing"] }).map((item) => item.id)).toEqual([
		second,
		first,
	]);
	expect(store.list("p1", { ids: [first, second], severity: ["low"] }).map((item) => item.id)).toEqual([second]);
	expect(store.list("p1", { ids: [] })).toEqual([]);
	expect(store.list("p1", { ids: [foreign, "missing", "' OR 1=1 --"] })).toEqual([]);
	expect(store.list("p1")).toHaveLength(3);
});

test("the list is paged in the database: a page, the count of matches, and the ids of a whole result", () => {
	const { store } = openStore();
	const low = submit(store, { severity: "low", cvss: 2 });
	const first = submit(store);
	const second = submit(store);
	const third = submit(store);
	submit(store, { projectId: "p2" });

	// Newest first, two to a page; the count is of the matches, not of the page.
	expect(store.page("p1", {}, 1, 2)).toMatchObject({
		items: [{ id: third }, { id: second }],
		total: 4,
		page: 1,
		pageSize: 2,
		hasMore: true,
	});
	expect(store.page("p1", {}, 2, 2)).toMatchObject({
		items: [{ id: first }, { id: low }],
		total: 4,
		page: 2,
		hasMore: false,
	});
	// Past the end there is nothing, and the count still says what there is.
	expect(store.page("p1", {}, 3, 2)).toMatchObject({ items: [], total: 4, page: 3, hasMore: false });
	// Filters narrow the page and the count alike, and never reach another project.
	expect(store.page("p1", { severity: ["low"] }, 1, 2)).toMatchObject({
		items: [{ id: low }],
		total: 1,
		hasMore: false,
	});
	expect(store.page("p1", { ids: [] }, 1, 2)).toMatchObject({ items: [], total: 0 });
	// A page size out of range is brought back to one, or down to the most the hub sends.
	expect(store.page("p1", {}, 1, 0).pageSize).toBe(1);
	expect(store.page("p1", {}, 1, 9999).pageSize).toBe(MAX_VULN_PAGE_SIZE);
	// Selecting a whole filtered result is made of ids, not of records.
	expect(store.ids("p1", { severity: ["high"] })).toEqual([third, second, first]);
	expect(store.ids("p1", { ids: [] })).toEqual([]);
});

test("a deletion cannot reach another project's findings", () => {
	const { store } = openStore();
	const mine = submit(store);
	const theirs = submit(store, { projectId: "p2", projectName: "别人的项目" });

	expect(store.deletePreview("p1", [theirs])).toEqual({ count: 0, evidence: 0, notes: 0 });
	expect(store.deleteMany("p1", [mine, theirs])).toBe(1);
	expect(store.find("p2", theirs)).toBeDefined();
});

test("an old database gains the columns once, and the backfill fills its rows", () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-vuln-migrate-"));
	roots.push(root);
	const path = join(root, "vulns.db");
	// The pre-provenance schema: same required columns, no engine/task/name.
	const legacy = openSqliteDatabase(path);
	legacy.exec(`
CREATE TABLE vulnerabilities (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, number INTEGER NOT NULL,
  project_id TEXT NOT NULL, project_name TEXT NOT NULL, session_id TEXT,
  source TEXT NOT NULL, title TEXT NOT NULL, severity TEXT NOT NULL, cvss REAL NOT NULL,
  cvss_vector TEXT, status TEXT NOT NULL, target TEXT NOT NULL, category TEXT,
  platform TEXT NOT NULL DEFAULT 'web', app_package TEXT, app_version TEXT,
  description TEXT NOT NULL, packet TEXT NOT NULL, repro TEXT, remediation TEXT, refs TEXT,
  review TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO vulnerabilities (id, label, number, project_id, project_name, session_id, source, title,
  severity, cvss, status, target, description, packet, created_at, updated_at)
VALUES ('v-old', 'E2E-0001', 1, 'p1', '靶场', 's-old', '主代理', '旧记录', 'low', 3.1, 'pending',
  '10.0.0.9', '描述', 'GET /', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
`);
	legacy.close();

	const fresh = new VulnerabilityStore(path);
	stores.push(fresh);
	// Opening the old database added the columns, so the runtime is asked to fill.
	expect(fresh.needsProvenanceBackfill()).toBe(true);
	expect(fresh.find("p1", "v-old")?.engineId).toBeUndefined();

	expect(fresh.backfillEngineRefs(new Map([["s-old", { engineId: "e9", taskId: "t9" }]]))).toBe(1);
	expect(fresh.backfillSessionNames(new Map([["s-old", "历史会话"]]))).toBe(1);
	const filled = fresh.find("p1", "v-old");
	expect(filled?.engineId).toBe("e9");
	expect(filled?.taskId).toBe("t9");
	expect(filled?.sessionName).toBe("历史会话");

	// A second pass does not overwrite what is already there.
	expect(fresh.backfillEngineRefs(new Map([["s-old", { engineId: "other", taskId: "other" }]]))).toBe(0);
	expect(fresh.backfillSessionNames(new Map([["s-old", "改名后"]]))).toBe(0);
	expect(fresh.find("p1", "v-old")?.engineId).toBe("e9");

	// A database that already has the columns asks for no backfill.
	const reopened = new VulnerabilityStore(path);
	stores.push(reopened);
	expect(reopened.needsProvenanceBackfill()).toBe(false);
});

test("findings link to an asset, can be queried by it, and lose only the link on unlink", () => {
	const { store } = openStore();
	const first = store.create({
		projectId: "p1",
		projectName: "靶场",
		source: "主代理",
		title: "关联一",
		severity: "high",
		cvss: 8,
		target: "10.0.0.5",
		description: "描述",
		packet: "GET /",
		assetId: "asset-1",
		assetLabel: "P1-A0001",
	});
	const second = store.create({
		projectId: "p1",
		projectName: "靶场",
		source: "主代理",
		title: "关联二",
		severity: "low",
		cvss: 2,
		target: "10.0.0.6",
		description: "描述",
		packet: "GET /",
		assetId: "asset-1",
		assetLabel: "P1-A0001",
	});
	store.create({
		projectId: "p1",
		projectName: "靶场",
		source: "主代理",
		title: "无关",
		severity: "low",
		cvss: 2,
		target: "10.0.0.7",
		description: "描述",
		packet: "GET /",
	});

	expect(store.get(first.id)?.assetId).toBe("asset-1");
	expect(store.get(first.id)?.assetLabel).toBe("P1-A0001");
	expect(store.listByAsset("p1", "asset-1").map((item) => item.label)).toEqual([second.label, first.label]);
	expect(store.list("p1", { assetId: "asset-1" })).toHaveLength(2);
	expect(store.countLinkedToAssets("p1", ["asset-1"])).toBe(2);
	const grouped = store.linkedByAsset("p1");
	expect(grouped.get("asset-1")).toHaveLength(2);

	expect(store.unlinkAssets("p1", ["asset-1"])).toBe(2);
	expect(store.listByAsset("p1", "asset-1")).toHaveLength(0);
	expect(store.get(first.id)?.assetId).toBeUndefined();
	expect(store.get(first.id)?.assetLabel).toBeUndefined();

	store.create({
		projectId: "p1",
		projectName: "靶场",
		source: "主代理",
		title: "再关联",
		severity: "low",
		cvss: 2,
		target: "10.0.0.8",
		description: "描述",
		packet: "GET /",
		assetId: "asset-2",
		assetLabel: "P1-A0002",
	});
	expect(store.unlinkAllAssets("p1")).toBe(1);
	expect(store.linkedByAsset("p1").size).toBe(0);
});
