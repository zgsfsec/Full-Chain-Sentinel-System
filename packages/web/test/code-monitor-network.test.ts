import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubApiError, GithubClient, parseGithubRepoUrl } from "../src/code-host.ts";
import { createProjectGithubFetch, GITHUB_CONTAINER_REQUEST } from "../src/code-monitor-network.ts";
import type { execInContainer } from "../src/docker.ts";
import type { ensureProjectReady } from "../src/projects.ts";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(mode: "simple" | "subscription" | "wireguard" | "openvpn" = "simple") {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-github-network-"));
	dirs.push(dir);
	const project = {
		id: "p1",
		name: "P",
		container: "sentinel-project-1",
		workDir: "/work",
		createdAt: "2026-01-01",
		gateway: true,
		proxyId: "proxy-1",
		proxyNode: "node-b",
	};
	writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [project] }));
	writeFileSync(
		join(dir, "proxies.json"),
		JSON.stringify({
			proxies: [
				{
					id: "proxy-1",
					name: "Existing proxy",
					mode,
					simple: { type: "socks5", server: "127.0.0.1", port: 1080 },
					nodeTag: "node-a",
					nodes: ["node-a", "node-b"].map((tag) => ({
						tag,
						name: tag,
						protocol: "socks",
						outbound: { type: "socks", tag },
					})),
				},
			],
		}),
	);
	const operations = {
		fetch: vi.fn<typeof fetch>(async () => Response.json({ source: "host" })),
		ensureReady: vi.fn<typeof ensureProjectReady>(async () => true),
		checkSidecar: vi.fn(async () => ({ exists: true, joined: true, netnsStale: false, configStale: false })),
		exec: vi.fn<typeof execInContainer>(async () => ({
			code: 0,
			stdout: JSON.stringify({
				status: 200,
				headers: [],
				body: Buffer.from('{"source":"project"}').toString("base64"),
			}),
			stdoutBytes: Buffer.alloc(0),
			stderr: "",
		})),
	};
	return { dir, project, operations, fetch: createProjectGithubFetch(dir, project.id, operations) };
}

describe("project GitHub network", () => {
	it("uses the host network without a project proxy and reads changes on subsequent requests", async () => {
		const fixture = setup();
		expect(await (await fixture.fetch("https://api.github.com/repos/acme/app")).json()).toEqual({
			source: "project",
		});
		writeFileSync(
			join(fixture.dir, "projects.json"),
			JSON.stringify({ projects: [{ ...fixture.project, proxyId: null }] }),
		);
		expect(await (await fixture.fetch("https://api.github.com/repos/acme/app")).json()).toEqual({ source: "host" });
		expect(fixture.operations.fetch).toHaveBeenCalledOnce();
		expect(fixture.operations.exec).toHaveBeenCalledOnce();
	});

	it.each(["simple", "subscription", "wireguard", "openvpn"] as const)(
		"reuses the %s project's container network and keeps credentials on stdin",
		async (mode) => {
			const fixture = setup(mode);
			for (const suffix of ["branches/main", "commits/abc"]) {
				await fixture.fetch(`https://api.github.com/repos/acme/app/${suffix}`, {
					headers: { authorization: "Bearer private-token" },
				});
			}
			expect(fixture.operations.ensureReady).toHaveBeenCalledOnce();
			expect(fixture.operations.ensureReady).toHaveBeenCalledWith(fixture.project, fixture.dir);
			expect(fixture.operations.checkSidecar).toHaveBeenCalledWith(fixture.project.container, "sentinel-sb-p1", "");
			expect(fixture.operations.fetch).not.toHaveBeenCalled();
			const call = fixture.operations.exec.mock.calls[0];
			expect(call[0]).toBe(fixture.project.container);
			expect(JSON.stringify(call.slice(0, 3))).not.toContain("private-token");
			expect(call[3]?.stdin?.toString()).toContain("Bearer private-token");
		},
	);

	it("honors an intentionally stopped project without restarting it or falling back to direct", async () => {
		const fixture = setup();
		writeFileSync(
			join(fixture.dir, "projects.json"),
			JSON.stringify({ projects: [{ ...fixture.project, manualStop: true }] }),
		);
		await expect(fixture.fetch("https://api.github.com")).rejects.toThrow("手动停止");
		expect(fixture.operations.ensureReady).not.toHaveBeenCalled();
		expect(fixture.operations.exec).not.toHaveBeenCalled();
		expect(fixture.operations.fetch).not.toHaveBeenCalled();
	});

	it("rechecks network readiness after the project's subscription node changes", async () => {
		const fixture = setup("subscription");
		await fixture.fetch("https://api.github.com");
		writeFileSync(
			join(fixture.dir, "projects.json"),
			JSON.stringify({ projects: [{ ...fixture.project, proxyNode: "node-a" }] }),
		);
		await fixture.fetch("https://api.github.com");
		expect(fixture.operations.ensureReady).toHaveBeenCalledTimes(2);
		expect(fixture.operations.ensureReady.mock.calls[1]?.[0]).toMatchObject({ proxyNode: "node-a" });
	});

	it.each([
		{ exists: true, joined: false, netnsStale: false, configStale: false },
		{ exists: true, joined: true, netnsStale: true, configStale: false },
		{ exists: true, joined: true, netnsStale: false, configStale: true },
	])("rejects a proxy network that was not applied: %j", async (health) => {
		const fixture = setup();
		fixture.operations.checkSidecar.mockResolvedValue(health);
		await expect(fixture.fetch("https://api.github.com")).rejects.toThrow("尚未使用当前代理网络");
		expect(fixture.operations.exec).not.toHaveBeenCalled();
		expect(fixture.operations.fetch).not.toHaveBeenCalled();
	});

	it("reports container preparation failures without falling back to direct", async () => {
		const fixture = setup();
		fixture.operations.ensureReady.mockResolvedValue(false);
		await expect(fixture.fetch("https://api.github.com")).rejects.toThrow("项目代理或容器未就绪");
		expect(fixture.operations.fetch).not.toHaveBeenCalled();
		expect(fixture.operations.exec).not.toHaveBeenCalled();
	});

	it("cancels a request while project preparation is pending", async () => {
		const fixture = setup();
		fixture.operations.ensureReady.mockReturnValue(new Promise<boolean>(() => {}));
		const controller = new AbortController();
		const request = fixture.fetch("https://api.github.com", { signal: controller.signal });
		controller.abort();
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		expect(fixture.operations.exec).not.toHaveBeenCalled();
	});

	it("keeps GitHub HTTP errors and rate-limit headers available to the existing client", async () => {
		const fixture = setup();
		fixture.operations.exec.mockResolvedValue({
			code: 0,
			stdout: JSON.stringify({
				status: 429,
				headers: [
					["retry-after", "120"],
					["x-ratelimit-remaining", "0"],
				],
				body: Buffer.from("API rate limit exceeded").toString("base64"),
			}),
			stdoutBytes: Buffer.alloc(0),
			stderr: "",
		});
		const client = new GithubClient(parseGithubRepoUrl("https://github.com/acme/app"), "", fixture.fetch);
		const error: unknown = await client.getBranch("main").catch((error: unknown) => error);
		expect(error).toBeInstanceOf(GithubApiError);
		expect(error).toMatchObject({ status: 429, retryAfterMs: 120_000, rateLimitRemaining: 0 });
	});

	it("retains curl DNS failures in the stored error text", async () => {
		const fixture = setup();
		fixture.operations.exec.mockResolvedValue({
			code: 0,
			stdout: JSON.stringify({ error: "Could not resolve host: api.github.com", code: 6 }),
			stdoutBytes: Buffer.alloc(0),
			stderr: "",
		});
		const client = new GithubClient(parseGithubRepoUrl("https://github.com/acme/app"), "", fixture.fetch);
		await expect(client.getBranch("main")).rejects.toThrow(
			/GET https:\/\/api.github.com.*curl 6.*Could not resolve host/,
		);
	});

	it("executes the real container request script against a local compressed HTTP response", async () => {
		const fixture = setup();
		const server = createServer((request, response) => {
			expect(request.headers.authorization).toBe("Bearer private-token");
			response.writeHead(200, {
				"content-encoding": "gzip",
				"content-type": "application/json",
				"x-ratelimit-remaining": "42",
			});
			response.end(gzipSync(JSON.stringify({ name: "main", commit: { sha: "abc" } })));
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing local server port");
		fixture.operations.exec.mockImplementation(async (_container, _script, args, options) => {
			expect(args).toEqual([GITHUB_CONTAINER_REQUEST]);
			return new Promise((resolve, reject) => {
				const child = execFile("python3", ["-c", GITHUB_CONTAINER_REQUEST], (error, stdout, stderr) => {
					if (error) reject(error);
					else resolve({ code: 0, stdout, stdoutBytes: Buffer.from(stdout), stderr });
				});
				child.stdin?.end(options?.stdin);
			});
		});
		const response = await fixture.fetch(`http://127.0.0.1:${address.port}/repos/acme/app/branches/main`, {
			headers: { authorization: "Bearer private-token" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("x-ratelimit-remaining")).toBe("42");
		expect(response.headers.get("content-encoding")).toBeNull();
		expect(await response.json()).toEqual({ name: "main", commit: { sha: "abc" } });
	});
});
