import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildSourceScript, CodeMonitorManager } from "../src/code-monitor.ts";
import { CodeMonitorStore, codeMonitorDbPath, setCodeMonitorSecret } from "../src/code-monitor-store.ts";
import type { CodeVulnTag } from "../src/code-vuln-tags.ts";
import { addLibraryEntry } from "../src/model-library.ts";
import type { SentinelVulnCategory } from "../src/protocol.ts";

const SHA_BASE = "basebasebasebasebasebasebasebasebasebase";
const SHA_FIX = "fixfixfixfixfixfixfixfixfixfixfixfixfixfix";

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status });
}

describe("CodeMonitorManager.check", () => {
	it.each<{
		name: string;
		enabled: boolean;
		categories: SentinelVulnCategory[] | null;
		tags: CodeVulnTag[] | null;
		dispatched: boolean;
	}>([
		{ name: "disabled", enabled: false, categories: null, tags: null, dispatched: false },
		{ name: "unrestricted", enabled: true, categories: null, tags: null, dispatched: true },
		{
			name: "matching one of several tags",
			enabled: true,
			categories: ["web"],
			tags: ["ssrf", "access-control"],
			dispatched: true,
		},
		{ name: "nonmatching tags", enabled: true, categories: ["web"], tags: ["ssrf"], dispatched: false },
		{
			name: "matching tag but wrong category",
			enabled: true,
			categories: ["memory"],
			tags: ["access-control"],
			dispatched: false,
		},
		{
			name: "all categories with a matching tag",
			enabled: true,
			categories: null,
			tags: ["auth-bypass"],
			dispatched: true,
		},
		{ name: "all types in selected category", enabled: true, categories: ["web"], tags: null, dispatched: true },
		{ name: "empty stored restriction", enabled: true, categories: null, tags: [], dispatched: false },
	])(
		"consumes a security commit once and enforces auto-dispatch: $name",
		async ({ enabled, categories, tags, dispatched }) => {
			const dir = mkdtempSync(join(tmpdir(), "sentinel-code-manager-"));
			addLibraryEntry(dir, {
				name: "judge",
				baseUrl: "https://llm.test/v1",
				apiKey: "k",
				modelId: "m",
			});
			const store = new CodeMonitorStore(codeMonitorDbPath(dir));
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
				baselines: { main: SHA_BASE },
				autoDispatch: enabled,
				autoDispatchCategories: categories,
				autoDispatchTags: tags,
				intervalMinutes: 60,
				scheduleKind: "interval",
				cronExpression: null,
				enabled: true,
			});
			setCodeMonitorSecret(dir, monitor.id, "ghp_test");

			const calls: string[] = [];
			const fetchImpl = (async (input: string | URL | Request) => {
				const url = String(input);
				calls.push(url);
				if (url.includes("/branches/main")) {
					return json({ name: "main", commit: { sha: SHA_FIX } });
				}
				if (url.includes("/compare/")) {
					return json({
						status: "ahead",
						commits: [
							{
								sha: SHA_FIX,
								html_url: "https://github.com/acme/app/commit/fix",
								commit: {
									message: "fix: reject unauthenticated admin requests",
									author: { name: "dev", date: "2024-01-01T00:00:00Z" },
								},
								parents: [{ sha: SHA_BASE }],
							},
						],
					});
				}
				if (url.includes("/commits/")) {
					return json({
						sha: SHA_FIX,
						html_url: "https://github.com/acme/app/commit/fix",
						commit: {
							message: "fix: reject unauthenticated admin requests",
							author: { name: "dev", date: "2024-01-01T00:00:00Z" },
						},
						parents: [{ sha: SHA_BASE }],
						stats: { additions: 3, deletions: 1 },
						files: [
							{
								filename: "src/admin.ts",
								status: "modified",
								additions: 3,
								deletions: 1,
								patch: "@@ -1 +1 @@\n-if (!user) return\n+if (!user || !user.isAdmin) return",
							},
						],
					});
				}
				if (url.includes("/chat/completions")) {
					return json({
						choices: [
							{
								message: {
									content: JSON.stringify({
										security: true,
										confidence: 0.9,
										cve: "CVE-2024-9999",
										severity: "high",
										vuln_type: "认证绕过",
										vuln_category: "web",
										vuln_tags: ["auth-bypass", "access-control"],
										title: "管理员接口缺少授权校验",
										reason: "src/admin.ts 增加了 isAdmin 判断",
									}),
								},
							},
						],
					});
				}
				return json({ message: "not found" }, 404);
			}) as unknown as typeof fetch;

			const manager = new CodeMonitorManager(dir, store, {
				onChange: () => {},
				project: () => ({ id: "p1", name: "P", cwd: "/tmp", container: "c" }),
				ensureContainer: async () => true,
				createEngine: async () => "engine-1",
				notify: () => {},
				fetchImpl,
			});
			const dispatch = vi.spyOn(manager, "dispatch").mockResolvedValue("engine-1");

			const result = await manager.check(monitor.id);
			expect(result).toMatchObject({ commits: 1, findings: 1, error: null });
			expect(result.checkId).not.toBe("");
			expect(dispatch).toHaveBeenCalledTimes(dispatched ? 1 : 0);
			const detail = manager.detail(monitor.id);
			expect(detail.commits).toHaveLength(1);
			expect(detail.commits[0]?.verdict).toBe("security");
			expect(detail.commits[0]?.cve).toBe("CVE-2024-9999");
			expect(detail.commits[0]?.vulnTags).toEqual(["auth-bypass", "access-control"]);
			expect(manager.activity("p1", "review", 1, 20, "web", "access-control").total).toBe(1);
			expect(manager.activity("p1", "review", 1, 20, "web", "ssrf").total).toBe(0);
			expect(detail.monitor.baselines.main).toBe(SHA_FIX);
			expect(detail.monitor.pendingCount).toBe(1);
			expect(detail.checks).toHaveLength(1);
			expect(detail.checks[0]).toMatchObject({
				status: "ok",
				trigger: "manual",
				commits: 1,
				findings: 1,
				error: null,
			});

			const callsAfterFirst = calls.length;
			const second = await manager.check(monitor.id);
			expect(second.commits).toBe(0);
			expect(manager.detail(monitor.id).commits).toHaveLength(1);
			expect(manager.detail(monitor.id).checks).toHaveLength(2);
			// No compare request was needed: the baseline already equals the head.
			expect(calls.slice(callsAfterFirst).some((url) => url.includes("/compare/"))).toBe(false);
		},
	);
});

describe("buildSourceScript", () => {
	it("prepares both trees without embedding a token", () => {
		const script = buildSourceScript({
			repoUrl: "https://github.com/acme/app",
			branch: "release/1.x",
			sha: "fixfixfixfixfixfixfixfixfixfixfixfixfixfix",
			parentSha: "basebasebasebasebasebasebasebasebasebase",
			workRoot: "/work/opensource/acme__app__abcd1234",
		});
		expect(script).toContain("git clone 'https://github.com/acme/app.git' src");
		expect(script).toContain("git worktree add --detach ../vuln 'basebase");
		expect(script).toContain("git worktree add --detach ../fixed 'fixfix");
		expect(script).toContain("ZG_TOKEN:-");
		expect(script).not.toContain("ghp_");
	});
});

describe("CodeMonitorManager.setSchedule", () => {
	function setup(fetchImpl?: typeof fetch) {
		const dir = mkdtempSync(join(tmpdir(), "sentinel-code-schedule-"));
		const store = new CodeMonitorStore(codeMonitorDbPath(dir));
		const manager = new CodeMonitorManager(dir, store, {
			onChange: () => {},
			project: () => ({ id: "p1", name: "P", cwd: "/tmp", container: "c" }),
			ensureContainer: async () => true,
			createEngine: async () => "engine-1",
			notify: () => {},
			fetchImpl,
		});
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
			baselines: { main: "base" },
			autoDispatch: false,
			intervalMinutes: 60,
			scheduleKind: "interval",
			cronExpression: null,
			enabled: true,
		});
		return { store, manager, monitor };
	}

	it("applies a cron strategy and rejects an invalid one without touching rows", async () => {
		const { store, manager, monitor } = setup();
		expect(
			await manager.setSchedule([monitor.id], {
				scheduleKind: "cron",
				cronExpression: "0 9 * * 1-5",
			}),
		).toBe(1);
		expect(store.getMonitor(monitor.id)?.scheduleKind).toBe("cron");
		expect(store.getMonitor(monitor.id)?.cronExpression).toBe("0 9 * * 1-5");

		await expect(
			manager.setSchedule([monitor.id], { scheduleKind: "cron", cronExpression: "not a cron" }),
		).rejects.toThrow();
		expect(store.getMonitor(monitor.id)?.cronExpression).toBe("0 9 * * 1-5");
	});

	it("switches back to an interval and clears the expression", async () => {
		const { store, manager, monitor } = setup();
		await manager.setSchedule([monitor.id], { scheduleKind: "cron", cronExpression: "*/30 * * * *" });
		await manager.setSchedule([monitor.id], { scheduleKind: "interval", intervalMinutes: 180 });
		const updated = store.getMonitor(monitor.id);
		expect(updated?.scheduleKind).toBe("interval");
		expect(updated?.cronExpression).toBeNull();
		expect(updated?.intervalMinutes).toBe(180);
	});

	it("batch-updates type restrictions while omitted fields stay unchanged and null clears them", () => {
		const { store, manager, monitor } = setup();
		expect(
			manager.setDispatch([monitor.id, monitor.id], {
				autoDispatch: true,
				autoDispatchCategories: ["web"],
				autoDispatchTags: ["ssrf", "rce", "ssrf"],
			}),
		).toBe(1);
		expect(store.getMonitor(monitor.id)).toMatchObject({
			autoDispatch: true,
			autoDispatchCategories: ["web"],
			autoDispatchTags: ["ssrf", "rce"],
		});
		manager.setDispatch([monitor.id], { autoDispatch: false });
		expect(store.getMonitor(monitor.id)?.autoDispatchTags).toEqual(["ssrf", "rce"]);
		manager.setDispatch([monitor.id], { autoDispatchTags: null });
		expect(store.getMonitor(monitor.id)).toMatchObject({ autoDispatchCategories: ["web"], autoDispatchTags: null });
		store.close();
	});

	it("creates a restricted monitor and preserves types when editing unrelated settings", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => json({ name: "main", commit: { sha: SHA_BASE } }));
		const { store, manager } = setup(fetchImpl);
		const input = { projectId: "p1", url: "https://github.com/acme/new-app", branches: ["main"] };
		const created = await manager.create({
			...input,
			autoDispatchTags: ["use-after-free"],
			autoDispatchCategories: ["memory"],
		});
		expect(created.autoDispatchTags).toEqual(["use-after-free"]);
		const edited = await manager.update(created.id, { ...input, name: "renamed" });
		expect(edited.autoDispatchTags).toEqual(["use-after-free"]);
		expect((await manager.update(created.id, { ...input, autoDispatchTags: null })).autoDispatchTags).toBeNull();
		store.close();
	});

	it("rejects empty or unknown types before changing any monitor", () => {
		const { store, manager, monitor } = setup();
		for (const autoDispatchTags of [[], ["invalid" as CodeVulnTag]]) {
			expect(() => manager.setDispatch([monitor.id], { autoDispatch: true, autoDispatchTags })).toThrow();
			expect(store.getMonitor(monitor.id)).toMatchObject({ autoDispatch: false, autoDispatchTags: null });
		}
		store.close();
	});
});
