import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPocSubscriptionDownload } from "../src/poc-subscription-network.ts";
import type { SentinelProject } from "../src/projects.ts";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(listener: RequestListener): Promise<string> {
	const server = createServer(listener);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing local server port");
	return `http://127.0.0.1:${address.port}`;
}

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-poc-network-"));
	dirs.push(dir);
	const project: SentinelProject = {
		id: "p1",
		name: "Project 1",
		container: "sentinel-project-1",
		workDir: "/work",
		createdAt: "2026-01-01",
		gateway: true,
		proxyId: "proxy-1",
	};
	const saveProjects = (projects: SentinelProject[], active: string | undefined = project.id): void => {
		writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects, lastActiveProjectId: active }));
	};
	saveProjects([project]);
	writeFileSync(
		join(dir, "proxies.json"),
		JSON.stringify({
			defaultId: "proxy-1",
			proxies: [
				{
					id: "proxy-1",
					name: "Existing proxy",
					mode: "simple",
					simple: { type: "socks5", server: "127.0.0.1", port: 1080 },
				},
			],
		}),
	);
	const bytes = Buffer.from([0x50, 0x4b, 0, 0xff, 0xfe, 0x80, 0, 1]);
	const operations = {
		fetch: vi.fn<typeof fetch>(async () => new Response(bytes)),
		ensureReady: vi.fn(async () => true),
		checkSidecar: vi.fn(async () => ({ exists: true, joined: true, netnsStale: false, configStale: false })),
		// Exercise the actual curl transfer locally, without requiring or touching Docker.
		spawn: vi.fn((_command: string, args: string[]) => spawn("curl", args.slice(4))),
	};
	return { dir, project, saveProjects, bytes, operations };
}

describe("POC subscription network", () => {
	it.each([null, undefined])("uses direct access when the project proxy is disabled (%s)", async (active) => {
		const fixture = setup();
		fixture.saveProjects([{ ...fixture.project, proxyId: null }], active === null ? fixture.project.id : "");
		const download = createPocSubscriptionDownload(fixture.dir, fixture.operations);

		expect(await download("https://example.com/archive.zip", "Authorization", "Bearer secret")).toEqual(
			fixture.bytes,
		);
		expect(fixture.operations.fetch).toHaveBeenCalledOnce();
		expect(fixture.operations.spawn).not.toHaveBeenCalled();
		expect(fixture.operations.ensureReady).not.toHaveBeenCalled();
	});

	it("follows redirects and decodes gzip through the project network while retaining binary bytes", async () => {
		const fixture = setup();
		const secret = 'Bearer secret"\\token';
		const url = await serve((request, response) => {
			expect(request.headers.authorization).toBe(secret);
			if (request.url === "/archive.zip") response.writeHead(302, { location: "/download.zip" }).end();
			else response.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(fixture.bytes));
		});
		const download = createPocSubscriptionDownload(fixture.dir, fixture.operations);

		expect(await download(`${url}/archive.zip`, "Authorization", secret)).toEqual(fixture.bytes);
		expect(fixture.operations.fetch).not.toHaveBeenCalled();
		expect(fixture.operations.spawn).toHaveBeenCalledWith(
			"docker",
			expect.arrayContaining(["exec", "-i", fixture.project.container, "curl"]),
		);
		expect(JSON.stringify(fixture.operations.spawn.mock.calls)).not.toContain("secret");
		expect(fixture.operations.ensureReady).toHaveBeenCalledWith(fixture.project, fixture.dir);
	});

	it("does not forward Authorization to a different redirect origin", async () => {
		const fixture = setup();
		let leaked: string | undefined;
		const target = await serve((request, response) => {
			leaked = request.headers.authorization;
			response.end(fixture.bytes);
		});
		const url = await serve((_request, response) =>
			response.writeHead(302, { location: `${target}/download.zip` }).end(),
		);

		expect(
			await createPocSubscriptionDownload(fixture.dir, fixture.operations)(url, "Authorization", "Bearer secret"),
		).toEqual(fixture.bytes);
		expect(leaked).toBeUndefined();
	});

	it("captures the current project for one sync and reads the new project for the next sync", async () => {
		const fixture = setup();
		const url = await serve((_request, response) => response.end(fixture.bytes));
		const first = createPocSubscriptionDownload(fixture.dir, fixture.operations);
		const second = { ...fixture.project, id: "p2", container: "sentinel-project-2" };
		fixture.saveProjects([fixture.project, second], second.id);

		await first(url, "", "");
		await createPocSubscriptionDownload(fixture.dir, fixture.operations)(url, "", "");

		expect(fixture.operations.spawn.mock.calls.map((call) => call[1][2])).toEqual([
			fixture.project.container,
			second.container,
		]);
	});

	it("follows the default proxy when the current project has no explicit profile", async () => {
		const fixture = setup();
		fixture.saveProjects([{ ...fixture.project, proxyId: undefined }]);
		const url = await serve((_request, response) => response.end(fixture.bytes));

		await createPocSubscriptionDownload(fixture.dir, fixture.operations)(url, "", "");

		expect(fixture.operations.spawn).toHaveBeenCalledOnce();
		expect(fixture.operations.fetch).not.toHaveBeenCalled();
	});

	it.each(["stopped", "not-ready", "stale", "deleted"])(
		"does not fall back to direct when the project is %s",
		async (failure) => {
			const fixture = setup();
			const download = createPocSubscriptionDownload(fixture.dir, fixture.operations);
			if (failure === "stopped") fixture.saveProjects([{ ...fixture.project, manualStop: true }]);
			if (failure === "not-ready") fixture.operations.ensureReady.mockResolvedValue(false);
			if (failure === "stale")
				fixture.operations.checkSidecar.mockResolvedValue({
					exists: true,
					joined: true,
					netnsStale: false,
					configStale: true,
				});
			if (failure === "deleted") fixture.saveProjects([]);

			await expect(download("https://example.com/archive.zip", "", "")).rejects.toThrow(/项目/);

			expect(fixture.operations.spawn).not.toHaveBeenCalled();
			expect(fixture.operations.fetch).not.toHaveBeenCalled();
			if (failure === "stopped") expect(fixture.operations.ensureReady).not.toHaveBeenCalled();
		},
	);

	it.each([302, 404])("rejects HTTP %i rather than importing an error response", async (status) => {
		const fixture = setup();
		const url = await serve((_request, response) => response.writeHead(status).end("not a zip"));

		await expect(createPocSubscriptionDownload(fixture.dir, fixture.operations)(url, "", "")).rejects.toThrow(
			String(status),
		);
		expect(fixture.operations.fetch).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"bounds archive size with a declared length or chunked body (chunked=%s)",
		async (chunked) => {
			const fixture = setup();
			const url = await serve((_request, response) => {
				response.writeHead(200, chunked ? {} : { "content-length": "4096" });
				response.write(Buffer.alloc(2048));
				response.end(Buffer.alloc(2048));
			});

			await expect(
				createPocSubscriptionDownload(fixture.dir, { ...fixture.operations, maxBytes: 1024 })(url, "", ""),
			).rejects.toThrow("上限");
		},
	);

	it("aborts a stalled proxy transfer when its timeout expires", async () => {
		const fixture = setup();
		const url = await serve(() => {});

		await expect(
			createPocSubscriptionDownload(fixture.dir, { ...fixture.operations, timeoutMs: 100 })(url, "", ""),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fixture.operations.fetch).not.toHaveBeenCalled();
	});

	it("bounds the direct response body too and cancels it after a size failure", async () => {
		const fixture = setup();
		fixture.saveProjects([{ ...fixture.project, proxyId: null }]);
		const cancel = vi.fn();
		fixture.operations.fetch.mockResolvedValue(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(2048));
					},
					cancel,
				}),
			),
		);

		await expect(
			createPocSubscriptionDownload(fixture.dir, { ...fixture.operations, maxBytes: 1024 })(
				"https://example.com/archive.zip",
				"",
				"",
			),
		).rejects.toThrow("上限");
		expect(cancel).toHaveBeenCalledOnce();
	});
});
