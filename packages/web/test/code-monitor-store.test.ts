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

function addMonitor(store: CodeMonitorStore) {
	return store.createMonitor({
		projectId: "p1",
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

function addCommit(store: CodeMonitorStore, monitorId: string, sha = "c1") {
	return store.insertCommit({
		monitorId,
		projectId: "p1",
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
			attention: 3,
		});
		const inbox = store.listActivity("p1", "attention", 1, 20);
		expect(inbox.total).toBe(3);
		expect(inbox.items.map((row) => row.id).sort()).toEqual([review.id, failed.id, dispatchFailed.id].sort());
		expect(store.listActivity("p1", "all", 1, 20).total).toBe(5);
		// The category narrowing keeps the status filter but drops other classes.
		expect(store.listActivity("p1", "all", 1, 20, "web").total).toBe(4);
		expect(store.listActivity("p1", "all", 1, 20, "memory").total).toBe(0);
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
