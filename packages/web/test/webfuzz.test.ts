import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { execInContainer, runDocker } from "../src/docker.ts";
import { MitmCenter } from "../src/mitm.ts";
import { handleMitmApi } from "../src/mitm-api.ts";
import { mitmBlobPath } from "../src/mitm-store.ts";
import { openSqliteDatabase } from "../src/sqlite.ts";
import * as replay from "../src/webfuzz.ts";
import type { WebFuzzRequest, WebFuzzResult, WebFuzzTab } from "../src/webfuzz-types.ts";

let root: string;
let server: Server | undefined;
const request: WebFuzzRequest = {
	raw: "GET / HTTP/1.1\r\nHost: target.test\r\n\r\n",
	target: "https://target.test",
	route: "project",
	timeoutMs: 30000,
	insecureTLS: false,
	fixContentLength: true,
};
const draft: WebFuzzTab = { ...request, id: "one", name: "One" };
const result: WebFuzzResult = {
	id: "result",
	at: 1,
	request,
	response: { proto: "HTTP/1.1", status: 200, reason: "OK", headers: [], bodyText: "ok", size: 2, truncated: false },
	timings: { connectMs: 1, tlsMs: 2, ttfbMs: 3, totalMs: 6 },
	warnings: [],
};
const noDocker = vi.fn<typeof runDocker>(async () => ({ code: 1, stdout: "", stderr: "No such object" }));
const projects = [
	{ id: "a", name: "A", container: "work-a" },
	{ id: "b", name: "B", container: "work-b" },
];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "webfuzz-"));
	noDocker.mockClear();
});
afterEach(async () => {
	vi.restoreAllMocks();
	if (server) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = undefined;
	}
	rmSync(root, { recursive: true, force: true });
});

test("validates send boundaries but lets unfinished workspaces survive reload", () => {
	expect(
		replay.validateWebFuzzRequest({
			...request,
			raw: "GET / HTTP/1.1\r\nHost: 中文.example:8443\r\n\r\n",
			password: "not-persisted",
		}),
	).toEqual({
		...request,
		raw: "GET / HTTP/1.1\r\nHost: 中文.example:8443\r\n\r\n",
		target: "https://xn--fiq228c.example:8443",
	});
	for (const patch of [
		{ raw: "" },
		{ raw: "中".repeat(180000) },
		{ target: "file:///etc/passwd" },
		{ target: "https://user:secret@target.test" },
		{ target: "https://target.test/path" },
		{ target: "https://target.test?a=1" },
		{ route: "other" },
		{ timeoutMs: 999 },
		{ timeoutMs: 120001 },
		{ insecureTLS: 1 },
	])
		expect(() => replay.validateWebFuzzRequest({ ...request, ...patch })).toThrow();
	replay.writeWebFuzzState(root, {
		tabs: [{ ...draft, target: "incomplete", raw: "", password: "not-persisted" }],
		activeId: draft.id,
	});
	expect(replay.readWebFuzzState(root).tabs[0]).toMatchObject({ target: "incomplete", raw: "" });
	expect(JSON.stringify(replay.readWebFuzzState(root))).not.toContain("not-persisted");
});

test("prepares headers and UTF-8 length without rewriting the body or virtual host", () => {
	expect(
		replay.prepareWebFuzzRaw({
			...request,
			raw: "POST /echo HTTP/1.1\nHost: virtual.test\nX-Test: one\nX-Test: two\nContent-Length: 999\n\n中文\nlast",
		}),
	).toBe(
		"POST /echo HTTP/1.1\r\nHost: virtual.test\r\nX-Test: one\r\nX-Test: two\r\nContent-Length: 11\r\n\r\n中文\nlast",
	);
	expect(() => replay.prepareWebFuzzRaw({ ...request, raw: "GET / HTTP/1.1\n" })).toThrow("Host");
	const chunked =
		"POST / HTTP/1.1\r\nHost: target.test\r\nTransfer-Encoding: chunked\r\nContent-Length: 999\r\n\r\n0\r\n\r\n";
	expect(replay.prepareWebFuzzRaw({ ...request, raw: chunked })).toContain("Content-Length: 999");
	expect(replay.prepareWebFuzzRaw({ ...request, raw: chunked, fixContentLength: false })).toContain("0\r\n\r\n");
	expect(
		replay.prepareWebFuzzRaw({
			...request,
			raw: "GET https://target.test/a?x=1 HTTP/1.1\r\nHost: target.test\r\n\r\n",
		}),
	).toMatch(/^GET \/a\?x=1 HTTP\/1.1/);
	for (const raw of [
		"GET https://other.test/ HTTP/1.1",
		"GET / HTTP/2",
		"CONNECT other.test:443 HTTP/1.1",
		"GET other.test HTTP/1.1",
	])
		expect(() => replay.prepareWebFuzzRaw({ ...request, raw })).toThrow();
});

test("Host determines the destination and explicit ports while the selected protocol controls TLS", () => {
	for (const [host, target, expected] of [
		["changed.test", "https://stale.test:8443", "https://changed.test"],
		["changed.test:8080", "http://stale.test", "http://changed.test:8080"],
		["changed.test:443", "http://stale.test", "http://changed.test:443"],
		["[::1]:8443", "https://stale.test", "https://[::1]:8443"],
		["[::1]", "http://stale.test", "http://[::1]"],
	]) {
		expect(
			replay.validateWebFuzzRequest({ ...request, target, raw: `GET / HTTP/1.1\r\nhOsT: ${host}\r\n\r\n` }).target,
		).toBe(expected);
	}
	for (const host of [
		"",
		"a.test/path",
		"a.test?x",
		"user@a.test",
		"a.test:0",
		"a.test:65536",
		"::1",
		"a.test\\evil",
		"a.test\r\nHost: other.test",
		"a.test\r\n folded",
		"a.test%20evil",
		"a.test:abc",
	]) {
		expect(() =>
			replay.validateWebFuzzRequest({ ...request, raw: `GET / HTTP/1.1\r\nHost: ${host}\r\n\r\n` }),
		).toThrow("Host");
	}
	expect(() =>
		replay.prepareWebFuzzRaw({ ...request, raw: "GET http://target.test/ HTTP/1.1\r\nHost: target.test\r\n\r\n" }),
	).toThrow("HTTPS");
});

test("workspaces and bounded histories persist by project, survive capture clear and disappear on purge", async () => {
	const center = new MitmCenter(root, () => projects, noDocker);
	center.saveWebFuzzState("a", { tabs: [draft], activeId: draft.id });
	for (let index = 0; index < 35; index++)
		replay.saveWebFuzzResult(join(root, "mitm", "a"), { ...result, id: `r${index}`, at: index });
	const restarted = new MitmCenter(root, () => projects, noDocker);
	expect(restarted.webFuzzState("a").history).toHaveLength(30);
	expect(restarted.webFuzzState("a").history[0].id).toBe("r34");
	expect(restarted.webFuzzState("a").history.at(-1)?.id).toBe("r5");
	expect(restarted.webFuzzState("b")).toEqual({ tabs: [], activeId: null, history: [] });
	expect(() => center.webFuzzState("../a")).toThrow();
	for (const state of [
		{ tabs: [draft, draft], activeId: draft.id },
		{ tabs: [draft], activeId: "missing" },
		{ tabs: Array(21).fill(draft), activeId: draft.id },
	])
		expect(() => center.saveWebFuzzState("a", state)).toThrow();
	mkdirSync(center.directory("a"), { recursive: true });
	await center.clear("a");
	expect(restarted.webFuzzState("a").tabs).toEqual([draft]);
	expect(restarted.webFuzzState("a").history).toHaveLength(30);
	await center.purge("a");
	expect(existsSync(join(root, "mitm", "a", "webfuzz.db"))).toBe(false);
});

test("sender keeps proxy secrets on stdin and always removes the bounded temporary worker", async () => {
	const docker = vi.fn<typeof runDocker>(async () => ({ code: 0, stdout: "arm64", stderr: "" }));
	const exec = vi.fn<typeof execInContainer>(async () => ({
		code: 0,
		stdout: JSON.stringify(result),
		stdoutBytes: Buffer.alloc(0),
		stderr: "",
	}));
	const binary = vi.fn(() => ({
		path: "fixture",
		bytes: Buffer.from("fixture"),
		sha256: "fixture",
		source: "checkout" as const,
		arch: "arm64" as const,
	}));
	const input = {
		...request,
		target: "http://target.test",
		route: "mitm" as const,
		raw: "GET / HTTP/1.1\r\nHost: target.test\r\nProxy-Authorization: old\r\n old-continuation\r\n\r\n",
	};
	const authorization = `Basic ${Buffer.from("user:secret123").toString("base64")}`;
	const sent = await replay.sendWebFuzz(
		input,
		{
			binDirectory: root,
			network: "container:mitm-a",
			upstreamProxy: "http://user:secret123@127.0.0.1:8080",
			proxyAuthorization: authorization,
			caPath: "/public.crt",
		},
		{ docker, exec, binary },
	);
	const command = docker.mock.calls.find(([args]) => args[0] === "run")![0];
	expect(command).toEqual(expect.arrayContaining(["container:mitm-a", "512m", "ALL", "no-new-privileges"]));
	expect(command.join(" ")).not.toContain("secret123");
	expect(command.join(" ")).not.toContain("8080");
	const payload = JSON.parse(exec.mock.calls[0][3]!.stdin!.toString()) as {
		raw: string;
		options: { upstreamProxy: string };
		save: boolean;
	};
	expect(payload.raw).toContain(`Proxy-Authorization: ${authorization}`);
	expect(payload.raw).not.toContain("old");
	expect(payload.options.upstreamProxy).toContain("secret123");
	expect(payload.save).toBe(false);
	expect(JSON.stringify(exec.mock.calls[0].slice(0, 3))).not.toContain("secret123");
	expect(JSON.stringify(sent)).not.toContain("secret123");
	expect(sent.request.raw).not.toContain(authorization);
	expect(docker.mock.calls.at(-1)?.[0].slice(0, 2)).toEqual(["rm", "-f"]);
	exec.mockResolvedValueOnce({ code: 1, stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "secret123" });
	await expect(
		replay.sendWebFuzz(request, { binDirectory: root, network: "bridge" }, { docker, exec, binary }),
	).rejects.toThrow("发包失败");
	expect(docker.mock.calls.at(-1)?.[0].slice(0, 2)).toEqual(["rm", "-f"]);
	const controller = new AbortController();
	exec.mockImplementationOnce(async () => {
		controller.abort();
		return { code: 1, stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "" };
	});
	await expect(
		replay.sendWebFuzz(
			request,
			{ binDirectory: root, network: "bridge", signal: controller.signal },
			{ docker, exec, binary },
		),
	).rejects.toThrow();
	expect(docker.mock.calls.at(-1)?.[0].slice(0, 2)).toEqual(["rm", "-f"]);
});

test("network selection follows the bound project and MITM authentication, without persisting the password", async () => {
	let running = false;
	const owner = createHash("sha256")
		.update(`${join(root, "mitm")}/a`)
		.digest("hex");
	const docker: typeof runDocker = async () => ({
		code: 0,
		stderr: "",
		stdout: JSON.stringify([
			{
				State: { Running: running },
				Config: { Labels: { "sentinel.mitm.owner": owner } },
				NetworkSettings: { Ports: {} },
			},
		]),
	});
	const center = new MitmCenter(root, () => projects, docker);
	await center.save("a", {
		bind: "127.0.0.1",
		port: 0,
		authEnabled: true,
		authUsername: "user",
		password: "secret123",
	});
	const send = vi
		.spyOn(replay, "sendWebFuzz")
		.mockImplementation(async (input) => ({ ...result, id: crypto.randomUUID(), request: input }));
	const signal = new AbortController().signal;
	await center.replay("b", request, undefined, signal, () => {});
	expect(send.mock.calls.at(-1)?.[1].network).toBe("container:work-b");
	await center.replay("a", { ...request, route: "direct" }, undefined, signal, () => {});
	expect(send.mock.calls.at(-1)?.[1].network).toBe("bridge");
	await expect(center.replay("a", { ...request, route: "mitm" }, "secret123", signal, () => {})).rejects.toMatchObject(
		{ status: 409 },
	);
	running = true;
	await expect(center.replay("a", { ...request, route: "mitm" }, "wrong123", signal, () => {})).rejects.toMatchObject({
		status: 403,
	});
	await center.replay("a", { ...request, route: "mitm" }, "secret123", signal, () => {});
	expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
		network: "container:sentinel-mitm-a",
		upstreamProxy: "http://user:secret123@127.0.0.1:8080/",
	});
	expect(JSON.stringify(center.webFuzzState("a"))).not.toContain("secret123");
	const count = center.webFuzzState("a").history.length;
	let allowed = true;
	send.mockImplementationOnce(async () => {
		allowed = false;
		return { ...result, id: "revoked" };
	});
	await expect(
		center.replay("a", request, undefined, signal, () => {
			if (!allowed) throw new Error("revoked");
		}),
	).rejects.toThrow("revoked");
	expect(center.webFuzzState("a").history).toHaveLength(count);
});

test("project purge cancels active sends and prevents history recreation", async () => {
	const center = new MitmCenter(root, () => projects, noDocker);
	let started: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	vi.spyOn(replay, "sendWebFuzz").mockImplementation(async (_input, context) => {
		started?.();
		await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
		context.signal?.throwIfAborted();
		return result;
	});
	const pending = center.replay("a", request, undefined, new AbortController().signal, () => {});
	const outcome = expect(pending).rejects.toThrow();
	await ready;
	await center.purge("a");
	await outcome;
	expect(existsSync(join(root, "mitm", "a", "webfuzz.db"))).toBe(false);
});

test("imports only complete UTF-8 proxy requests and does not send during import", async () => {
	const center = new MitmCenter(root, () => projects, noDocker);
	const directory = center.directory("a");
	mkdirSync(directory, { recursive: true });
	const db = openSqliteDatabase(join(directory, "replayd.db"));
	db.exec(
		readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"../../../MITM_Fuzz_Render/internal/store/migrations/0001_init.sql",
			),
			"utf8",
		),
	);
	db.exec("INSERT INTO projects VALUES ('default', 'default', 1)");
	for (const [id, bytes, size] of [
		["complete", Buffer.from(request.raw), 0],
		["truncated", Buffer.from(request.raw), 10000],
		["binary", Buffer.from([0xff, 0xfe]), 2],
	] as const) {
		const sha = createHash("sha256").update(bytes).digest("hex");
		const path = mitmBlobPath(directory, sha)!;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, bytes);
		db.prepare("INSERT OR IGNORE INTO blobs(sha256,size,created_at) VALUES(?, ?, 1)").run(sha, bytes.length);
		db.prepare(
			"INSERT INTO flows(id,project_id,source,ts,method,scheme,host,port,path,req_headers,resp_headers,req_raw_sha,req_size,created_at) VALUES(?, 'default', 'proxy', 1, 'GET', 'https', 'target.test', 443, '/', '[]', '[]', ?, ?, 1)",
		).run(id, sha, size);
	}
	db.close();
	expect(await center.importWebFuzz("a", "complete")).toEqual(request);
	await expect(center.importWebFuzz("a", "truncated")).rejects.toThrow("截断");
	await expect(center.importWebFuzz("a", "binary")).rejects.toThrow("二进制");
	await expect(center.importWebFuzz("b", "complete")).rejects.toThrow("不存在");
	expect(center.webFuzzState("a").history).toEqual([]);
});

test("HTTP API scopes workspace, import and send and rejects invalid sends before Docker", async () => {
	let active = "a";
	let authorized = true;
	const center = new MitmCenter(root, () => projects, noDocker);
	server = createServer((req, res) => {
		void handleMitmApi(req, res, center, { project: () => ({ id: active }), authorized: () => authorized });
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No server");
	const origin = `http://127.0.0.1:${address.port}/api/mitm/webfuzz`;
	const post = (path: string, body: object) =>
		fetch(origin + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId: "a", ...body }),
		});
	expect((await fetch(`${origin}?projectId=b`)).status).toBe(409);
	expect((await post("/workspace", { tabs: [draft], activeId: draft.id })).status).toBe(200);
	expect(await (await fetch(`${origin}?projectId=a`)).json()).toMatchObject({ tabs: [draft] });
	expect((await post("/send", { request: { ...request, raw: "GET / HTTP/2" } })).status).toBe(400);
	expect((await post("/send", { request: { ...request, raw: "x".repeat(524289) } })).status).toBe(400);
	expect(noDocker).not.toHaveBeenCalled();
	active = "b";
	expect((await post("/import", { flowId: "one" })).status).toBe(409);
	authorized = false;
	expect((await fetch(`${origin}?projectId=b`)).status).toBe(401);
	expect((await post("/send", { request })).status).toBe(401);
});
