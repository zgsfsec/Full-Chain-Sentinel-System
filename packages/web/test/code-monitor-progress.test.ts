import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeMonitorManager } from "../src/code-monitor.ts";
import { CodeMonitorStore, codeMonitorDbPath } from "../src/code-monitor-store.ts";
import * as docker from "../src/docker.ts";
import type { SentinelEngineStatus } from "../src/protocol.ts";
import { openSqliteDatabase } from "../src/sqlite.ts";

const dirs: string[] = [];
const stores: CodeMonitorStore[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-reproduction-"));
	dirs.push(dir);
	const store = new CodeMonitorStore(codeMonitorDbPath(dir));
	stores.push(store);
	const monitor = store.createMonitor({
		projectId: "p1",
		projectName: "P",
		name: "acme/app",
		host: "github.com",
		owner: "acme",
		repo: "app",
		repoUrl: "https://github.com/acme/app",
		apiBaseUrl: "https://api.github.com",
		branches: ["main"],
		baselines: {},
		autoDispatch: false,
		intervalMinutes: 60,
		scheduleKind: "interval",
		cronExpression: null,
		enabled: true,
	});
	const commit = store.insertCommit({
		monitorId: monitor.id,
		projectId: "p1",
		branch: "main",
		sha: "a".repeat(40),
		shortSha: "aaaaaaaa",
		title: "fix access",
		message: "fix access",
		author: "dev",
		authoredAt: 1,
		url: "https://github.com/acme/app/commit/a",
		additions: 1,
		deletions: 1,
		files: 1,
		diff: "@@\n-old\n+fixed",
	});
	store.setVerdict(commit.id, {
		verdict: "security",
		confidence: 0.9,
		cve: null,
		severity: "high",
		vulnType: "SSRF",
		vulnCategory: "web",
		vulnTags: ["ssrf"],
		reason: "fix",
		judgedAt: 1,
	});
	const hooks = {
		onChange: vi.fn(),
		project: () => ({ id: "p1", name: "P", container: "fake", cwd: "/tmp" }),
		ensureContainer: vi.fn(async () => true),
		createEngine: vi.fn(async () => "engine-1"),
		engineStatus: vi.fn<(_id: string) => SentinelEngineStatus | null>(() => "running"),
		notify: vi.fn(),
		fetchImpl: vi.fn<typeof fetch>(async () =>
			Response.json({ sha: commit.sha, parents: [{ sha: "b".repeat(40) }] }),
		),
	};
	vi.spyOn(docker, "execInContainer").mockResolvedValue({
		code: 0,
		stdout: "",
		stdoutBytes: Buffer.alloc(0),
		stderr: "",
	});
	return { dir, store, monitor, commit, hooks, manager: new CodeMonitorManager(dir, store, hooks) };
}

describe("open-source reproduction progress", () => {
	it("persists Git → engineering → completion and updates filtered counts", async () => {
		const { store, commit, manager, hooks } = fixture();
		let ready: (value: boolean) => void = () => {};
		hooks.ensureContainer.mockReturnValue(
			new Promise<boolean>((resolve) => {
				ready = resolve;
			}),
		);
		const pending = manager.dispatch(commit.id);
		expect(store.getCommit(commit.id)).toMatchObject({ status: "dispatching", reproductionStage: "git" });
		expect(manager.activity("p1", "reproducing", 1, 20, "web", "ssrf").total).toBe(1);
		expect(manager.activity("p1", "reproducing", 1, 20, "web", "xss").total).toBe(0);
		await expect(manager.dispatch(commit.id)).rejects.toThrow("正在下发");
		ready(true);
		await expect(pending).resolves.toBe("engine-1");
		expect(store.getCommit(commit.id)).toMatchObject({ engineId: "engine-1", reproductionStage: "engineering" });
		expect(store.activityCounts("p1")).toMatchObject({ reproducing: 1, finished: 0, review: 0 });
		manager.syncEngine("engine-1", "paused");
		expect(store.getCommit(commit.id)?.reproductionStage).toBe("paused");
		manager.syncEngine("engine-1", "running");
		expect(store.getCommit(commit.id)?.reproductionStage).toBe("engineering");
		manager.syncEngine("engine-1", "completed");
		expect(store.activityCounts("p1")).toMatchObject({ reproducing: 0, finished: 1 });
		expect(manager.activity("p1", "finished", 1, 20).items[0]?.reproductionStage).toBe("completed");
		const changes = hooks.onChange.mock.calls.length;
		manager.syncEngine("engine-1", "completed");
		expect(hooks.onChange).toHaveBeenCalledTimes(changes);
		expect(manager.activity("p2", "finished", 1, 20).total).toBe(0);
	});

	it("shows source preparation failures and permits a retry", async () => {
		const { store, commit, manager, hooks } = fixture();
		hooks.ensureContainer.mockResolvedValue(false);
		await expect(manager.dispatch(commit.id)).rejects.toThrow("容器未运行");
		expect(store.getCommit(commit.id)).toMatchObject({ status: "new", reproductionStage: "failed" });
		expect(store.activityCounts("p1")).toMatchObject({ reproducing: 0, dispatchFailed: 1 });
		hooks.ensureContainer.mockResolvedValue(true);
		await manager.dispatch(commit.id);
		expect(store.getCommit(commit.id)).toMatchObject({ error: null, reproductionStage: "engineering" });
	});

	it("reads an engine that already finished during creation and handles stops or deletion", async () => {
		const { store, commit, manager, hooks } = fixture();
		hooks.engineStatus.mockReturnValue("completed");
		await manager.dispatch(commit.id);
		expect(store.getCommit(commit.id)?.reproductionStage).toBe("completed");
		manager.syncEngine("engine-1", "stopped");
		expect(store.getCommit(commit.id)?.reproductionStage).toBe("stopped");
		manager.syncEngine("engine-1", null);
		expect(store.activityCounts("p1")).toMatchObject({ reproducing: 0, finished: 1 });
	});

	it("recovers interrupted Git and synchronizes stored engineering progress after restart", async () => {
		const { dir, store, commit, manager, hooks } = fixture();
		await manager.dispatch(commit.id);
		hooks.engineStatus.mockReturnValue("paused");
		manager.syncEngines();
		expect(store.getCommit(commit.id)?.reproductionStage).toBe("paused");
		store.setStatus(commit.id, "dispatching", null, null);
		store.close();
		stores.pop();
		const recovered = new CodeMonitorStore(codeMonitorDbPath(dir));
		stores.push(recovered);
		expect(recovered.getCommit(commit.id)).toMatchObject({
			status: "new",
			reproductionStage: "failed",
			error: expect.stringContaining("中断"),
		});
	});

	it("migrates old dispatched records and reconciles their real engine state", () => {
		const { dir, store, commit, hooks } = fixture();
		store.setStatus(commit.id, "dispatched", "engine-1", null);
		store.close();
		stores.pop();
		const legacy = openSqliteDatabase(codeMonitorDbPath(dir));
		legacy.exec("ALTER TABLE code_commits DROP COLUMN reproduction_stage");
		legacy.close();
		const migrated = new CodeMonitorStore(codeMonitorDbPath(dir));
		stores.push(migrated);
		hooks.engineStatus.mockReturnValue("completed");
		const manager = new CodeMonitorManager(dir, migrated, hooks);
		manager.syncEngines();
		expect(manager.activity("p1", "finished", 1, 20).total).toBe(1);
	});
});
