import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CodeMonitorStore,
	codeMonitorDbPath,
	readCodeMonitorSecrets,
	removeCodeMonitorSecret,
	setCodeMonitorSecret,
} from "../src/code-monitor-store.ts";
import type { CodeVulnTag } from "../src/code-vuln-tags.ts";
import { openSqliteDatabase } from "../src/sqlite.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-code-monitor-"));
	dirs.push(dir);
	return dir;
}

function open(): { dir: string; store: CodeMonitorStore } {
	const dir = tempDir();
	return { dir, store: new CodeMonitorStore(codeMonitorDbPath(dir)) };
}

afterEach(() => {
	// SQLite keeps handles until the process ends; removing the temp directory is
	// enough for the assertions here, and the OS cleans the rest.
	dirs.splice(0, dirs.length);
});

function addMonitor(store: CodeMonitorStore, projectId = "p1") {
	return store.createMonitor({
		projectId,
		projectName: "Project",
		name: "acme/app",
		host: "github.com",
		owner: "acme",
		repo: "app",
		repoUrl: "https://github.com/acme/app",
		apiBaseUrl: "https://api.github.com",
		branches: ["main", "release/1.x"],
		baselines: { main: "aaa", "release/1.x": "bbb" },
		autoDispatch: false,
		intervalMinutes: 60,
		scheduleKind: "interval",
		cronExpression: null,
		enabled: true,
	});
}

function addCommit(store: CodeMonitorStore, monitorId: string, sha = "c1", projectId = "p1") {
	return store.insertCommit({
		monitorId,
		projectId,
		branch: "main",
		sha,
		shortSha: sha.slice(0, 8),
		title: "fix traversal",
		message: "fix traversal",
		author: "dev",
		authoredAt: 1_700_000_000_000,
		url: `https://github.com/acme/app/commit/${sha}`,
		additions: 1,
		deletions: 1,
		files: 1,
		diff: "@@",
	});
}

describe("CodeMonitorStore", () => {
	it("creates a monitor, keeps its branches and updates it", () => {
		const { store } = open();
		const created = addMonitor(store);
		expect(created.branches).toEqual(["main", "release/1.x"]);
		expect(created.baselines.main).toBe("aaa");

		const updated = store.updateMonitor(created.id, {
			branches: ["main"],
			baselines: { main: "ccc" },
			autoDispatch: true,
		});
		expect(updated.branches).toEqual(["main"]);
		expect(updated.baselines).toEqual({ main: "ccc" });
		expect(updated.autoDispatch).toBe(true);
	});

	it("returns an existing commit instead of duplicating the SHA", () => {
		const { store } = open();
		const monitor = addMonitor(store);
		const first = addCommit(store, monitor.id);
		const second = addCommit(store, monitor.id);
		expect(second.id).toBe(first.id);
		expect(store.listCommits(monitor.id)).toHaveLength(1);
	});

	it("migrates existing monitors and persists type restrictions across updates and restarts", () => {
		const { dir, store } = open();
		const monitor = addMonitor(store);
		expect(monitor.autoDispatchTags).toBeNull();
		store.close();
		const legacy = openSqliteDatabase(codeMonitorDbPath(dir));
		legacy.exec("ALTER TABLE code_monitors DROP COLUMN auto_dispatch_tags");
		legacy.close();
		const migrated = new CodeMonitorStore(codeMonitorDbPath(dir));
		expect(migrated.getMonitor(monitor.id)?.autoDispatchTags).toBeNull();
		migrated.updateMonitor(monitor.id, { autoDispatchTags: ["rce", "ssrf"] });
		migrated.updateMonitor(monitor.id, { enabled: false });
		migrated.close();
		const reopened = new CodeMonitorStore(codeMonitorDbPath(dir));
		expect(reopened.getMonitor(monitor.id)?.autoDispatchTags).toEqual(["rce", "ssrf"]);
		expect(reopened.listMonitors()[0]?.autoDispatchTags).toEqual(["rce", "ssrf"]);
		reopened.updateMonitor(monitor.id, { autoDispatchTags: null });
		expect(reopened.getMonitor(monitor.id)?.autoDispatchTags).toBeNull();
		reopened.close();
	});

	it("counts security verdicts and pending ones separately", () => {
		const { store } = open();
		const monitor = addMonitor(store);
		const row = addCommit(store, monitor.id);
		store.setVerdict(row.id, {
			verdict: "security",
			confidence: 0.9,
			cve: "CVE-2024-1234",
			severity: "high",
			vulnType: "路径穿越",
			vulnCategory: "web",
			vulnTags: ["path-traversal" as const],
			reason: "补了规范化",
			judgedAt: Date.now(),
		});
		expect(store.counts(monitor.id)).toEqual({ findingCount: 1, pendingCount: 1 });

		store.setStatus(row.id, "dispatched", "engine-1", null);
		expect(store.counts(monitor.id)).toEqual({ findingCount: 1, pendingCount: 0 });
		expect(store.listMonitors()[0]?.findingCount).toBe(1);
	});

	it("finds an already-dispatched advisory for deduplication", () => {
		const { store } = open();
		const monitor = addMonitor(store);
		const first = addCommit(store, monitor.id, "c1");
		const second = addCommit(store, monitor.id, "c2");
		store.setVerdict(first.id, {
			verdict: "security",
			confidence: 0.9,
			cve: "CVE-2024-1234",
			severity: "high",
			vulnType: null,
			vulnCategory: "other",
			vulnTags: ["other"],
			reason: "x",
			judgedAt: Date.now(),
		});
		store.setStatus(first.id, "dispatched", "engine-1", null);
		expect(store.findSecurityByCve(monitor.id, "CVE-2024-1234", second.id)?.id).toBe(first.id);
	});

	it("dedupes active jobs and requeues them after a restart", () => {
		const { store } = open();
		const monitor = addMonitor(store);
		const first = store.enqueueJob({
			monitorId: monitor.id,
			projectId: "p1",
			host: "github.com",
			trigger: "manual",
			now: 1_000,
			maxAttempts: 3,
		});
		const second = store.enqueueJob({
			monitorId: monitor.id,
			projectId: "p1",
			host: "github.com",
			trigger: "batch",
			now: 2_000,
			maxAttempts: 3,
		});
		expect(second.id).toBe(first.id);
		expect(store.activeJobs()).toHaveLength(1);

		const running = store.markJobRunning(first.id, 3_000);
		expect(running).toMatchObject({ status: "running", attempts: 1 });
		expect(store.requeueRunningJobs(4_000, "服务重启，重新排队")).toBe(1);
		expect(store.activeJobs()[0]).toMatchObject({ status: "queued", attempts: 1 });

		store.finishJob(first.id, "failed", 5_000, "boom", null);
		expect(store.activeJobs()).toHaveLength(0);
		expect(store.listJobs(monitor.id)[0]).toMatchObject({ status: "failed", error: "boom" });
		expect(store.listJobsByProject("p1")).toHaveLength(1);
	});

	it("records check runs and closes interrupted ones", () => {
		const { store } = open();
		const monitor = addMonitor(store);
		const checkId = store.startCheck(monitor.id, "p1", "manual", 1_000);
		expect(store.listChecks(monitor.id)[0]?.status).toBe("running");
		store.finishCheck(checkId, {
			status: "ok",
			commits: 2,
			findings: 1,
			error: null,
			endedAt: 2_000,
		});
		const finished = store.listChecks(monitor.id)[0];
		expect(finished).toMatchObject({ status: "ok", commits: 2, findings: 1, endedAt: 2_000 });

		store.startCheck(monitor.id, "p1", "auto", 3_000);
		expect(store.failRunningChecks(4_000, "服务重启，检查中断")).toBe(1);
		expect(store.listChecks(monitor.id)[0]).toMatchObject({
			status: "error",
			error: "服务重启，检查中断",
			endedAt: 4_000,
		});
		expect(store.listChecksByProject("p1")).toHaveLength(2);
	});

	it("builds the project activity inbox from actionable commits", () => {
		const { store } = open();
		const monitor = addMonitor(store);
		const review = addCommit(store, monitor.id, "review");
		const dispatched = addCommit(store, monitor.id, "dispatched");
		const failed = addCommit(store, monitor.id, "failed");
		const dispatchFailed = addCommit(store, monitor.id, "dispatch-failed");
		const ignored = addCommit(store, monitor.id, "ignored");
		const security = {
			verdict: "security" as const,
			confidence: 0.9,
			cve: null,
			severity: "high" as const,
			vulnType: "路径穿越",
			vulnCategory: "web" as const,
			vulnTags: ["path-traversal" as const],
			reason: "fix",
			judgedAt: 1,
		};
		for (const row of [review, dispatched, dispatchFailed, ignored]) {
			store.setVerdict(row.id, security);
		}
		store.setVerdict(failed.id, {
			verdict: "failed",
			confidence: null,
			cve: null,
			severity: null,
			vulnType: null,
			vulnCategory: null,
			vulnTags: [],
			reason: "model down",
			judgedAt: 1,
		});
		store.setStatus(dispatched.id, "dispatched", "engine-1", null);
		store.setStatus(dispatchFailed.id, "new", null, "429");
		store.setStatus(ignored.id, "ignored", null, null);

		const counts = store.activityCounts("p1");
		expect(counts).toEqual({
			pending: 0,
			failed: 1,
			dispatchFailed: 1,
			review: 1,
			attention: 4,
			reproducing: 1,
			finished: 0,
		});
		const inbox = store.listActivity("p1", "attention", 1, 20);
		expect(inbox.total).toBe(4);
		expect(inbox.items.map((row) => row.id).sort()).toEqual(
			[review.id, failed.id, dispatchFailed.id, dispatched.id].sort(),
		);
		expect(store.listActivity("p1", "all", 1, 20).total).toBe(5);
		// The category narrowing keeps the status filter but drops other classes.
		expect(store.listActivity("p1", "all", 1, 20, "web").total).toBe(4);
		expect(store.listActivity("p1", "all", 1, 20, "memory").total).toBe(0);
	});

	it("filters multiple detailed tags before pagination and intersects project, category and status", () => {
		const { dir, store } = open();
		const monitor = addMonitor(store);
		const otherMonitor = addMonitor(store, "p2");
		const matchingIds: string[] = [];
		for (const sha of ["ssrf-1", "ssrf-2", "ssrf-3", "xss", "memory", "other-project"]) {
			const otherProject = sha === "other-project";
			const row = addCommit(store, otherProject ? otherMonitor.id : monitor.id, sha, otherProject ? "p2" : "p1");
			const tags: CodeVulnTag[] =
				sha === "memory"
					? ["use-after-free", "info-disclosure"]
					: sha === "xss"
						? ["xss"]
						: ["ssrf", "info-disclosure"];
			store.setVerdict(row.id, {
				verdict: "security",
				confidence: 0.9,
				cve: null,
				severity: "high",
				vulnCategory: sha === "memory" ? "memory" : "web",
				vulnType: null,
				vulnTags: tags,
				reason: "diff evidence",
				judgedAt: 1,
			});
			if (sha.startsWith("ssrf")) matchingIds.push(row.id);
		}
		const first = store.listActivity("p1", "all", 1, 2, "web", "ssrf");
		const second = store.listActivity("p1", "all", 2, 2, "web", "ssrf");
		expect(first.total).toBe(3);
		expect(second.total).toBe(3);
		expect(first.items).toHaveLength(2);
		expect(second.items).toHaveLength(1);
		expect([...first.items, ...second.items].map((row) => row.id).sort()).toEqual(matchingIds.sort());
		expect(store.listActivity("p1", "all", 1, 20, null, "info-disclosure").total).toBe(4);
		expect(store.listActivity("p1", "all", 1, 20, "memory", "info-disclosure").total).toBe(1);
		expect(store.listActivity("p1", "all", 1, 20, "memory", "ssrf").total).toBe(0);
		store.setStatus(matchingIds[0], "dispatched", "engine-1", null);
		expect(store.listActivity("p1", "review", 1, 20, "web", "ssrf").total).toBe(2);
		store.close();
		const reopened = new CodeMonitorStore(codeMonitorDbPath(dir));
		expect(reopened.getCommit(matchingIds[0])?.vulnTags).toEqual(["ssrf", "info-disclosure"]);
		reopened.close();
	});

	it("searches all project activity before pagination and intersects existing filters", () => {
		const { store } = open();
		const monitor = addMonitor(store);
		const other = addMonitor(store, "p2");
		const first = addCommit(store, monitor.id, "abc123");
		const second = addCommit(store, monitor.id, "def456");
		const foreign = addCommit(store, other.id, "foreign", "p2");
		const literal = addCommit(store, monitor.id, "%_O'Hara");
		for (const row of [first, second, foreign]) {
			store.setVerdict(row.id, {
				verdict: "security",
				confidence: 0.9,
				cve: "CVE-2026-1234",
				severity: "high",
				vulnCategory: "web",
				vulnType: "请求校验缺陷",
				vulnTags: ["ssrf", "auth-bypass"],
				reason: "阻止访问内网地址",
				judgedAt: 1,
			});
		}
		const page1 = store.listActivity("p1", "all", 1, 1, null, null, "  cve-2026-1234  ");
		const page2 = store.listActivity("p1", "all", 2, 1, null, null, "cve-2026-1234");
		expect(page1.total).toBe(2);
		expect(page2.total).toBe(2);
		expect([...page1.items, ...page2.items].map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
		for (const search of ["SSRF", "认证绕过", "Authentication bypass", "请求校验", "内网地址"]) {
			expect(store.listActivity("p1", "all", 1, 20, null, null, search).total).toBe(2);
		}
		for (const search of ["ACME/APP", "main", "DEV", "fix traversal", "   "]) {
			expect(store.listActivity("p1", "all", 1, 20, null, null, search).total).toBe(3);
		}
		expect(store.listActivity("p1", "all", 1, 20, null, null, "ABC123").items[0]?.id).toBe(first.id);
		for (const search of ["%", "_", "O'Hara"]) {
			expect(store.listActivity("p1", "all", 1, 20, null, null, search).items.map((row) => row.id)).toEqual([
				literal.id,
			]);
		}
		expect(store.listActivity("p1", "all", 1, 20, null, null, "' OR 1=1 --").total).toBe(0);
		store.setStatus(first.id, "dispatched", "engine-1", null);
		expect(store.listActivity("p1", "review", 1, 20, "web", "ssrf", "CVE-2026").items.map((row) => row.id)).toEqual([
			second.id,
		]);
		expect(
			store.listActivity("p1", "reproducing", 1, 20, "web", "ssrf", "CVE-2026").items.map((row) => row.id),
		).toEqual([first.id]);
		expect(store.listActivity("p1", "all", 1, 20, "memory", null, "SSRF").total).toBe(0);
		expect(store.listActivity("p1", "all", 1, 20, "web", "xss", "CVE-2026").total).toBe(0);
		store.close();
	});

	it.each(["pending", "failed", "not_security"] as const)(
		"clears stale tags when rejudgment changes to %s",
		(verdict) => {
			const { store } = open();
			const row = addCommit(store, addMonitor(store).id);
			const security = {
				verdict: "security" as const,
				confidence: 0.9,
				cve: null,
				severity: null,
				vulnType: "SSRF",
				vulnCategory: "web" as const,
				vulnTags: ["ssrf" as const],
				reason: "fix",
				judgedAt: 1,
			};
			store.setVerdict(row.id, security);
			store.setVerdict(row.id, { ...security, verdict });
			expect(store.getCommit(row.id)?.vulnTags).toEqual([]);
			expect(store.listActivity("p1", "all", 1, 20, null, "ssrf").total).toBe(0);
			store.close();
		},
	);

	it("upgrades old databases using explicit type names and leaves unknown findings unclassified", () => {
		const { dir, store } = open();
		const monitor = addMonitor(store);
		const known = addCommit(store, monitor.id, "known");
		const unknown = addCommit(store, monitor.id, "unknown");
		for (const row of [known, unknown]) {
			store.setVerdict(row.id, {
				verdict: "security",
				confidence: 0.9,
				cve: null,
				severity: null,
				vulnType: row.id === known.id ? "路径穿越" : "请求处理缺陷",
				vulnCategory: "web",
				vulnTags: [],
				reason: "fix",
				judgedAt: 1,
			});
		}
		store.close();
		const legacy = openSqliteDatabase(codeMonitorDbPath(dir));
		legacy.exec("ALTER TABLE code_commits DROP COLUMN vuln_tags");
		legacy.close();
		const upgraded = new CodeMonitorStore(codeMonitorDbPath(dir));
		expect(upgraded.getCommit(known.id)?.vulnTags).toEqual(["path-traversal"]);
		expect(upgraded.listActivity("p1", "all", 1, 20, "web", "path-traversal").total).toBe(1);
		expect(upgraded.getCommit(unknown.id)).toMatchObject({ vulnType: "请求处理缺陷", vulnTags: [] });
		upgraded.close();
		const reopened = new CodeMonitorStore(codeMonitorDbPath(dir));
		expect(reopened.listCommits(monitor.id)).toHaveLength(2);
		expect(reopened.getCommit(known.id)?.vulnTags).toEqual(["path-traversal"]);
		reopened.close();
	});

	it("deletes a project's monitors and history together", () => {
		const { store } = open();
		const monitor = addMonitor(store);
		store.insertCommit({
			monitorId: monitor.id,
			projectId: "p1",
			branch: "main",
			sha: "c1",
			shortSha: "c1",
			title: "t",
			message: "t",
			author: "a",
			authoredAt: 1,
			url: "u",
			additions: 0,
			deletions: 0,
			files: 0,
			diff: null,
		});
		expect(store.deleteByProject("p1")).toEqual([monitor.id]);
		expect(store.listMonitors()).toHaveLength(0);
	});

	it("refreshes cached activity totals after commit transitions, external writes and deletion", () => {
		const { dir, store } = open();
		const db = openSqliteDatabase(codeMonitorDbPath(dir));
		try {
			const monitor = addMonitor(store);
			expect(store.activityCounts("p1").pending).toBe(0);
			const commit = addCommit(store, monitor.id);
			expect(store.activityCounts("p1").pending).toBe(1);
			expect(store.listActivity("p1", "all", 1, 20).total).toBe(1);
			const security = {
				verdict: "security" as const,
				confidence: 0.9,
				cve: null,
				severity: null,
				vulnType: null,
				vulnCategory: "web" as const,
				vulnTags: ["ssrf" as const],
				reason: "fix",
				judgedAt: 1,
			};
			store.setVerdict(commit.id, security);
			expect(store.activityCounts("p1")).toMatchObject({ pending: 0, review: 1 });
			store.setStatus(commit.id, "new", null, "failure");
			expect(store.listActivity("p1", "dispatch_failed", 1, 20).total).toBe(1);
			store.setStatus(commit.id, "dispatched", "engine-1", null);
			expect(store.activityCounts("p1")).toMatchObject({ dispatchFailed: 0, review: 0, reproducing: 1 });
			store.syncEngineStage("engine-1", "completed");
			expect(store.activityCounts("p1")).toMatchObject({ reproducing: 0, finished: 1 });
			store.setStatus(commit.id, "new", null, null);
			expect(store.activityCounts("p1").review).toBe(1);
			store.setDuplicateOf(commit.id, "original");
			expect(store.listActivity("p1", "review", 1, 20).total).toBe(0);
			store.setVerdict(commit.id, { ...security, verdict: "failed" });
			expect(store.activityCounts("p1").failed).toBe(1);
			store.setStatus(commit.id, "ignored", null, null);
			expect(store.activityCounts("p1").failed).toBe(0);

			// Another connection must invalidate both the old and the new project.
			db.prepare("UPDATE code_commits SET project_id = 'p2', verdict = 'pending', status = 'new' WHERE id = ?").run(
				commit.id,
			);
			expect(store.listActivity("p1", "all", 1, 20).total).toBe(0);
			expect(store.activityCounts("p2").pending).toBe(1);
			expect(store.listActivity("p2", "all", 1, 20).total).toBe(1);
			store.deleteMonitor(monitor.id);
			expect(store.activityCounts("p2").pending).toBe(0);
			const remaining = addMonitor(store);
			addCommit(store, remaining.id, "remaining");
			expect(store.activityCounts("p1").pending).toBe(1);
			store.deleteByProject("p1");
			expect(store.listActivity("p1", "all", 1, 20).total).toBe(0);
		} finally {
			db.close();
			store.close();
		}
	});

	it("reuses activity aggregates across pagination and keeps returned counts isolated", () => {
		const { store } = open();
		try {
			const monitor = addMonitor(store);
			addCommit(store, monitor.id);
			const counts = store.activityCounts("p1");
			counts.pending = 999;
			expect(store.activityCounts("p1").pending).toBe(1);
			expect(store.listActivity("p1", "pending", 1, 1).total).toBe(1);
			expect(store.listActivity("p1", "pending", 2, 1)).toMatchObject({ items: [], total: 1 });
			expect(store.activityCounts("p2").pending).toBe(0);
		} finally {
			store.close();
		}
	});

	it("counts repository errors only in the requested project and refreshes after recovery", () => {
		const { store } = open();
		try {
			const first = addMonitor(store);
			const second = addMonitor(store);
			const other = addMonitor(store, "p2");
			store.markChecked(first.id, 1, "failed");
			store.markChecked(second.id, 1, "");
			store.markChecked(other.id, 1, "failed");
			expect(store.countMonitorErrors("p1")).toBe(1);
			expect(store.countMonitorErrors("p2")).toBe(1);
			expect(store.countMonitorErrors("missing")).toBe(0);
			store.markChecked(first.id, 2, null);
			expect(store.countMonitorErrors("p1")).toBe(0);
		} finally {
			store.close();
		}
	});
});

describe("monitor secrets", () => {
	it("stores tokens in a 0600 file and removes them", () => {
		const dir = tempDir();
		setCodeMonitorSecret(dir, "m1", "ghp_test");
		expect(readCodeMonitorSecrets(dir)).toEqual({ m1: "ghp_test" });
		const path = join(dir, "code-monitor-secrets.json");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf-8")).not.toContain("ghp_test\nghp_test");

		removeCodeMonitorSecret(dir, "m1");
		expect(readCodeMonitorSecrets(dir)).toEqual({});
	});

	it("clears a token when saved empty", () => {
		const dir = tempDir();
		setCodeMonitorSecret(dir, "m1", "ghp_test");
		setCodeMonitorSecret(dir, "m1", "");
		expect(readCodeMonitorSecrets(dir)).toEqual({});
	});
});
