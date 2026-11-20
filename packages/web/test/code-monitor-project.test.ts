import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubClient, type GithubCommitDetail } from "../src/code-host.ts";
import { CodeMonitorManager } from "../src/code-monitor.ts";
import * as judge from "../src/code-monitor-judge.ts";
import { CodeMonitorStore, codeMonitorDbPath } from "../src/code-monitor-store.ts";
import { addLibraryEntry } from "../src/model-library.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-code-project-"));
	const store = new CodeMonitorStore(codeMonitorDbPath(dir));
	const hooks = {
		onChange: vi.fn(),
		project: (id: string) => ({ id, name: id, cwd: dir, container: "fake" }),
		ensureContainer: vi.fn(async () => true),
		createEngine: vi.fn(async () => "engine-1"),
		notify: vi.fn(),
		fetchImpl: vi.fn<typeof fetch>(async () => {
			throw new Error("Unexpected network request");
		}),
	};
	const manager = new CodeMonitorManager(dir, store, hooks);
	cleanups.push(() => {
		manager.stop();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const create = (projectId = "p1", enabled = true) =>
		store.createMonitor({
			projectId,
			projectName: projectId,
			name: "acme/app",
			host: "github.com",
			owner: "acme",
			repo: "app",
			repoUrl: "https://github.com/acme/app",
			apiBaseUrl: "https://api.github.com",
			branches: ["main"],
			baselines: { main: "base" },
			autoDispatch: true,
			intervalMinutes: 60,
			scheduleKind: "interval",
			cronExpression: null,
			enabled,
		});
	return { dir, store, manager, hooks, create };
}

describe("project monitoring switch", () => {
	it("sets up multiple one-shot repositories sequentially and continues after a repository fails", async () => {
		const { store, manager } = fixture();
		const firstRepo = deferred<{ defaultBranch: string }>();
		const metadata = vi
			.spyOn(GithubClient.prototype, "getRepo")
			.mockReturnValueOnce(firstRepo.promise)
			.mockRejectedValueOnce(new Error("Repository unavailable"))
			.mockResolvedValueOnce({ defaultBranch: "trunk" });
		vi.spyOn(GithubClient.prototype, "getBranch").mockResolvedValue({ name: "trunk", sha: "head" });
		vi.spyOn(GithubClient.prototype, "listCommits").mockResolvedValue([]);
		const scans = ["first", "missing", "last"].map((repo) =>
			manager.scanHistory({
				projectId: "p1",
				url: `https://github.com/acme/${repo}`,
				token: "ghp_test",
				commitLimit: 2,
				autoDispatch: true,
			}),
		);
		const settled = Promise.allSettled(scans);
		await vi.waitFor(() => expect(metadata).toHaveBeenCalledTimes(1));
		expect(store.listMonitors()).toEqual([]);
		firstRepo.resolve({ defaultBranch: "trunk" });
		const results = await settled;
		expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
		expect(metadata).toHaveBeenCalledTimes(3);
		await vi.waitFor(() => expect(store.activeJobs()).toHaveLength(0));
		const monitors = manager.list().sort((left, right) => left.repo.localeCompare(right.repo));
		expect(monitors.map((monitor) => monitor.repo)).toEqual(["first", "last"]);
		for (const monitor of monitors) {
			expect(monitor).toMatchObject({
				projectId: "p1",
				oneShot: true,
				oneShotLimit: 2,
				autoDispatch: true,
				tokenSet: true,
				enabled: false,
				branches: ["trunk"],
			});
			expect(store.listJobs(monitor.id)[0]).toMatchObject({ trigger: "one-shot", status: "done" });
		}
	});

	it("runs a one-shot scan next after the active host check despite a large monitoring backlog", async () => {
		const { store, manager, create } = fixture();
		const active = create();
		const pending = deferred<{ commits: number; findings: number; checkId: string; error: null }>();
		const check = vi
			.spyOn(manager, "check")
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue({ commits: 0, findings: 0, checkId: "check", error: null });
		manager.enqueue(active.id);
		for (let index = 0; index < 105; index++) {
			const monitor = create();
			store.enqueueJob({
				monitorId: monitor.id,
				projectId: "p1",
				host: monitor.host,
				trigger: "auto",
				now: index + 1,
				maxAttempts: 3,
			});
		}
		vi.spyOn(GithubClient.prototype, "getRepo").mockResolvedValue({ defaultBranch: "main" });
		vi.spyOn(GithubClient.prototype, "getBranch").mockResolvedValue({ name: "main", sha: "head" });
		const scan = await manager.scanHistory({
			projectId: "p1",
			url: "https://github.com/acme/app",
			commitLimit: 5,
			autoDispatch: false,
		});
		expect(check).toHaveBeenCalledTimes(1);
		expect(store.activeJob(scan.id)?.status).toBe("queued");
		pending.resolve({ commits: 0, findings: 0, checkId: "active", error: null });
		await vi.waitFor(() => expect(store.listJobs(scan.id)[0]?.status).toBe("done"));
		expect(check.mock.calls[1]).toEqual([scan.id, "one-shot"]);
	});

	it("persists a pause even without repositories and preserves repository settings and history", () => {
		const { dir, store, manager, create } = fixture();
		const monitor = create("p1", false);
		store.markChecked(monitor.id, 123, "previous error");
		const before = store.getMonitor(monitor.id);
		expect(manager.projectEnabled("p1")).toBe(true);
		manager.setProjectEnabled("p1", false);
		manager.setProjectEnabled("empty", false);
		const reopened = new CodeMonitorStore(codeMonitorDbPath(dir));
		try {
			expect(reopened.projectEnabled("p1")).toBe(false);
			expect(reopened.projectEnabled("empty")).toBe(false);
			expect(reopened.projectEnabled("p2")).toBe(true);
			expect(reopened.getMonitor(monitor.id)).toEqual(before);
			reopened.setProjectEnabled("p1", true);
			expect(reopened.getMonitor(monitor.id)).toEqual(before);
		} finally {
			reopened.close();
		}
	});

	it("filters paused backlog before the queue limit so other projects can run", () => {
		const { store, manager, create } = fixture();
		manager.setProjectEnabled("p1", false);
		for (let index = 0; index < 105; index++) {
			const monitor = create();
			store.enqueueJob({
				monitorId: monitor.id,
				projectId: "p1",
				host: monitor.host,
				trigger: "auto",
				now: 1,
				maxAttempts: 3,
			});
		}
		const other = create("p2");
		store.enqueueJob({
			monitorId: other.id,
			projectId: "p2",
			host: other.host,
			trigger: "auto",
			now: 2,
			maxAttempts: 3,
		});
		expect(store.dueJobs(Date.now(), 1).map((job) => job.monitorId)).toEqual([other.id]);
	});

	it("blocks scheduled and manual checks, then resumes only previously enabled schedules", async () => {
		const { store, manager, hooks, create } = fixture();
		const active = create();
		const disabled = create("p1", false);
		const branch = vi.spyOn(GithubClient.prototype, "getBranch").mockResolvedValue({ name: "main", sha: "base" });
		manager.setProjectEnabled("p1", false);
		await manager.tick();
		expect(store.activeJobs()).toEqual([]);
		expect(() => manager.enqueue(active.id)).toThrow("暂停");
		await expect(manager.check(active.id)).rejects.toThrow("暂停");
		expect(branch).not.toHaveBeenCalled();
		expect(hooks.fetchImpl).not.toHaveBeenCalled();
		const other = create("p2");
		manager.setProjectEnabled("p1", true);
		await vi.waitFor(() => expect(store.listJobs(active.id)[0]?.status).toBe("done"));
		expect(branch).toHaveBeenCalledTimes(1);
		expect(store.listJobs(disabled.id)).toEqual([]);
		expect(store.listJobs(other.id)).toEqual([]);
		expect(store.getMonitor(disabled.id)?.enabled).toBe(false);
	});

	it("keeps restarted queued work paused and starts it on resume", async () => {
		const { store, manager, create } = fixture();
		const monitor = create();
		const job = store.enqueueJob({
			monitorId: monitor.id,
			projectId: "p1",
			host: monitor.host,
			trigger: "manual",
			now: 1,
			maxAttempts: 3,
		});
		store.markJobRunning(job.id, 2);
		manager.setProjectEnabled("p1", false);
		const branch = vi.spyOn(GithubClient.prototype, "getBranch").mockResolvedValue({ name: "main", sha: "base" });
		manager.start();
		expect(store.activeJob(monitor.id)?.status).toBe("queued");
		expect(branch).not.toHaveBeenCalled();
		manager.setProjectEnabled("p1", true);
		await vi.waitFor(() => expect(store.listJobs(monitor.id)[0]?.status).toBe("done"));
		expect(branch).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		"yields an in-flight check without advancing its baseline or spending a retry (resume immediately: %s)",
		async (resumeImmediately) => {
			const { store, manager, create } = fixture();
			const monitor = create();
			const head = deferred<{ name: string; sha: string }>();
			const branch = vi
				.spyOn(GithubClient.prototype, "getBranch")
				.mockReturnValueOnce(head.promise)
				.mockResolvedValue({ name: "main", sha: "base" });
			const compare = vi.spyOn(GithubClient.prototype, "compare");
			manager.enqueue(monitor.id);
			expect(store.activeJob(monitor.id)?.attempts).toBe(1);
			manager.setProjectEnabled("p1", false);
			if (resumeImmediately) manager.setProjectEnabled("p1", true);
			head.resolve({ name: "main", sha: "new-head" });
			await vi.waitFor(() => expect(store.listChecks(monitor.id)[0]?.endedAt).not.toBeNull());
			expect(compare).not.toHaveBeenCalled();
			if (!resumeImmediately) {
				expect(store.getMonitor(monitor.id)).toMatchObject({
					baselines: { main: "base" },
					lastCheckAt: null,
					lastError: null,
				});
				expect(store.activeJob(monitor.id)).toMatchObject({ status: "queued", attempts: 0, error: null });
				manager.setProjectEnabled("p1", true);
			}
			await vi.waitFor(() => expect(store.listJobs(monitor.id)[0]).toMatchObject({ status: "done", attempts: 1 }));
			expect(branch).toHaveBeenCalledTimes(2);
		},
	);

	it("does not notify or auto-dispatch a late model reply and judges that commit on resume", async () => {
		const { dir, store, manager, hooks, create } = fixture();
		addLibraryEntry(dir, { name: "judge", baseUrl: "https://llm.test/v1", apiKey: "test", modelId: "m" });
		const monitor = create();
		const detail: GithubCommitDetail = {
			sha: "fix",
			message: "fix auth",
			author: "dev",
			authoredAt: 1,
			url: "https://github.com/acme/app/commit/fix",
			parents: 1,
			parentSha: "base",
			additions: 1,
			deletions: 1,
			files: [{ filename: "auth.ts", status: "modified", additions: 1, deletions: 1, patch: "-old\n+fixed" }],
		};
		vi.spyOn(GithubClient.prototype, "getBranch").mockResolvedValue({ name: "main", sha: "fix" });
		vi.spyOn(GithubClient.prototype, "compare").mockResolvedValue({ status: "ahead", commits: [detail] });
		vi.spyOn(GithubClient.prototype, "getCommit").mockResolvedValue(detail);
		const verdict: judge.CodeJudgeVerdict = {
			security: true,
			confidence: 0.9,
			cve: null,
			severity: "high",
			vulnType: "auth bypass",
			vulnCategory: "web",
			vulnTags: ["auth-bypass"],
			title: "fix auth",
			reason: "checks authentication",
		};
		const pending = deferred<judge.CodeJudgeVerdict>();
		const model = vi.spyOn(judge, "judgeCommit").mockReturnValueOnce(pending.promise).mockResolvedValue(verdict);
		const dispatch = vi.spyOn(manager, "dispatch").mockResolvedValue("engine-1");
		const checking = manager.check(monitor.id);
		await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
		manager.setProjectEnabled("p1", false);
		pending.resolve(verdict);
		await expect(checking).resolves.toMatchObject({ paused: true });
		expect(store.getMonitor(monitor.id)?.baselines).toEqual({ main: "base" });
		expect(store.listCommits(monitor.id)[0]?.verdict).toBe("pending");
		expect(hooks.notify).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
		manager.setProjectEnabled("p1", true);
		await vi.waitFor(() => expect(store.listJobs(monitor.id)[0]?.status).toBe("done"));
		expect(store.listCommits(monitor.id)).toHaveLength(1);
		expect(store.listCommits(monitor.id)[0]?.verdict).toBe("security");
		expect(hooks.notify).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledTimes(1);
		const saved = store.listCommits(monitor.id)[0];
		if (!saved) throw new Error("Missing commit");
		const repeated = deferred<judge.CodeJudgeVerdict>();
		model.mockReturnValueOnce(repeated.promise);
		const rejudging = manager.rejudge(saved.id);
		await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(3));
		manager.setProjectEnabled("p1", false);
		repeated.resolve(verdict);
		await expect(rejudging).rejects.toThrow("暂停");
		expect(store.getCommit(saved.id)).toEqual(saved);
		expect(hooks.notify).toHaveBeenCalledTimes(1);
		await expect(manager.rejudge(saved.id)).rejects.toThrow("暂停");
	});
});
