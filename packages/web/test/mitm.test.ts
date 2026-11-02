import { createHash, pbkdf2Sync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { runDocker } from "../src/docker.ts";
import { MitmCenter } from "../src/mitm.ts";
import { handleMitmApi } from "../src/mitm-api.ts";
import { getMitmFlow, listMitmFlows, MitmError, mitmBlobPath, mitmRawPath } from "../src/mitm-store.ts";
import { openSqliteDatabase, type SqliteDatabase } from "../src/sqlite.ts";

let root: string;
let directory: string;
let db: SqliteDatabase;
let server: Server | undefined;
const missingDocker: typeof runDocker = async () => ({ code: 1, stdout: "", stderr: "No such object: capture" });

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-mitm-test-"));
	directory = join(root, "mitm", "a", "data");
	mkdirSync(directory, { recursive: true });
	db = openSqliteDatabase(join(directory, "replayd.db"));
	const migrations = join(
		dirname(fileURLToPath(import.meta.url)),
		"../../../MITM_Fuzz_Render/internal/store/migrations",
	);
	db.exec(readFileSync(join(migrations, "0001_init.sql"), "utf8"));
	db.exec("INSERT INTO projects VALUES ('default', 'default', 1)");
});

afterEach(async () => {
	if (server) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = undefined;
	}
	db.close();
	rmSync(root, { recursive: true, force: true });
});

function blob(bytes: Buffer): string {
	const sha = createHash("sha256").update(bytes).digest("hex");
	const path = mitmBlobPath(directory, sha)!;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes);
	db.prepare("INSERT OR IGNORE INTO blobs (sha256,size,created_at) VALUES (?, ?, 1)").run(sha, bytes.length);
	return sha;
}

function insert(
	id: string,
	status: number | null = 200,
	source = "proxy",
	host = "a.example",
	raw: string | null = null,
): void {
	db.prepare(`INSERT INTO flows (id,project_id,source,ts,method,scheme,host,port,path,query,req_headers,resp_headers,status,req_raw_sha,resp_raw_sha,created_at)
		VALUES (?, 'default', ?, 10, 'GET', 'https', ?, 443, '/login', 'key=value', ?, '[]', ?, ?, ?, 10)`).run(
		id,
		source,
		host,
		JSON.stringify([{ n: "Host", v: host }]),
		status,
		raw,
		raw,
	);
}

test("reads native replayd records, pages and combines filters without including replay traffic", async () => {
	for (let i = 0; i < 53; i++) insert(`flw_${String(i).padStart(3, "0")}`);
	insert("replay_error", null, "replay");
	insert("proxy_error", null);
	insert("other_error", null, "proxy", "b.example");
	expect((await listMitmFlows(directory, new URLSearchParams())).items).toHaveLength(50);
	expect(await listMitmFlows(directory, new URLSearchParams("page=2"))).toMatchObject({
		total: 55,
		page: 2,
		items: expect.any(Array),
	});
	expect((await listMitmFlows(directory, new URLSearchParams("page=2"))).items).toHaveLength(5);
	expect(
		(await listMitmFlows(directory, new URLSearchParams("status=error&host=a.example"))).items.map((row) => row.id),
	).toEqual(["proxy_error"]);
	expect((await listMitmFlows(directory, new URLSearchParams("status=2xx&q=KEY=VALUE&method=get"))).total).toBe(53);
	expect((await listMitmFlows(directory, new URLSearchParams("status=404"))).total).toBe(0);
	expect((await listMitmFlows(directory, new URLSearchParams("q=' OR 1=1 --"))).total).toBe(0);
	expect((await listMitmFlows(directory, new URLSearchParams("page=-1"))).page).toBe(1);
});

test("details preserve headers and raw bytes, bound previews, and reject replay or invalid blob paths", async () => {
	const payload = Buffer.from("GET /login HTTP/1.1\r\nHost: a.example\r\n\r\n中文<script>alert(1)</script>");
	insert("flw_text", 200, "proxy", "a.example", blob(payload));
	expect(await getMitmFlow(directory, "flw_text")).toMatchObject({
		reqHeaders: [{ n: "Host", v: "a.example" }],
		request: { text: payload.toString(), encoding: "utf8", truncated: false },
	});
	expect(readFileSync(await mitmRawPath(directory, "flw_text", "request"))).toEqual(payload);
	insert("flw_binary", 200, "proxy", "a.example", blob(Buffer.from([0xff, 0xfe, 0x00])));
	expect((await getMitmFlow(directory, "flw_binary")).response).toMatchObject({ text: "//4A", encoding: "base64" });
	insert("flw_large", 200, "proxy", "a.example", blob(Buffer.alloc(1024 * 1024 + 100, 65)));
	expect((await getMitmFlow(directory, "flw_large")).request).toMatchObject({
		size: 1024 * 1024 + 100,
		truncated: true,
	});
	expect((await getMitmFlow(directory, "flw_large")).request.text).toHaveLength(1024 * 1024);
	insert("replay", 200, "replay", "a.example", blob(payload));
	await expect(getMitmFlow(directory, "replay")).rejects.toThrow(MitmError);
	await expect(mitmRawPath(directory, "replay", "response")).rejects.toThrow(MitmError);
	await expect(mitmRawPath(directory, "flw_text", "../../ca/ca.key")).rejects.toThrow(MitmError);
	expect(() => mitmBlobPath(directory, "../../ca/ca.key")).toThrow(MitmError);
	expect((await listMitmFlows(join(root, "another"), new URLSearchParams())).total).toBe(0);
	expect(existsSync(join(root, "another"))).toBe(false);
});

test("stopped-only clear rotates data, retains CA/token/config, and cannot touch another project", async () => {
	const projects = [
		{ id: "a", name: "A" },
		{ id: "b", name: "B" },
	];
	const center = new MitmCenter(root, () => projects, missingDocker);
	const other = center.directory("b");
	mkdirSync(other, { recursive: true });
	writeFileSync(join(other, "keep"), "B");
	await center.save("a", { bind: "127.0.0.1", port: 18080 });
	// Public certificate contents are irrelevant to clear; it must preserve bytes exactly.
	mkdirSync(join(directory, "ca"));
	writeFileSync(join(directory, "ca", "ca.key"), "private", { mode: 0o600 });
	writeFileSync(join(directory, "token"), "secret");
	insert("flw_one");
	db.close();
	db = openSqliteDatabase(":memory:");
	await center.clear("a");
	directory = center.directory("a");
	expect(readFileSync(join(directory, "ca", "ca.key"), "utf8")).toBe("private");
	expect(readFileSync(join(directory, "token"), "utf8")).toBe("secret");
	expect((await listMitmFlows(directory, new URLSearchParams())).total).toBe(0);
	expect(JSON.parse(readFileSync(join(root, "mitm", "a", "config.json"), "utf8"))).toMatchObject({
		bind: "127.0.0.1",
		port: 18080,
		skipStatic: true,
		maxCaptureMb: 2,
	});
	expect(readFileSync(join(other, "keep"), "utf8")).toBe("B");
	expect(() => center.directory("../b")).toThrow();
	await expect(center.save("a", { bind: "1.2.3.4", port: 10 })).rejects.toThrow();
	await expect(center.save("a", { bind: "127.0.0.1", port: 65536 })).rejects.toThrow();
	await center.purge("a");
	expect(existsSync(directory)).toBe(false);
	expect(existsSync(other)).toBe(true);
});

test("running or foreign containers cannot be cleared or reconfigured; unused projects delete without Docker", async () => {
	const owner = createHash("sha256")
		.update(`${join(root, "mitm")}/a`)
		.digest("hex");
	const running: typeof runDocker = async () => ({
		code: 0,
		stderr: "",
		stdout: JSON.stringify([
			{
				Config: { Labels: { "sentinel.mitm.owner": owner } },
				State: { Running: true },
				NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "18080" }] } },
			},
		]),
	});
	const center = new MitmCenter(root, () => [{ id: "a", name: "A" }], running);
	await expect(center.clear("a")).rejects.toMatchObject({ status: 409 });
	await expect(center.save("a", { bind: "127.0.0.1", port: 0 })).rejects.toMatchObject({ status: 409 });
	const foreign = new MitmCenter(root, () => [{ id: "b", name: "B" }], running);
	await expect(foreign.start("b")).rejects.toMatchObject({ status: 409 });
	await foreign.purge("b"); // Never used: do not require a working Docker daemon just to remove the project.
});

test("running workers read their own WAL; list, detail and download share the container reader", async () => {
	const owner = createHash("sha256")
		.update(`${join(root, "mitm")}/a`)
		.digest("hex");
	const payload = Buffer.from("captured bytes");
	insert("live", 200, "proxy", "a.example", blob(payload));
	db.prepare("UPDATE flows SET req_size = 2048 WHERE id = 'live'").run();
	let reads = 0;
	const docker: typeof runDocker = async (args) => {
		if (args[0] === "inspect")
			return {
				code: 0,
				stderr: "",
				stdout: JSON.stringify([
					{
						Config: { Labels: { "sentinel.mitm.owner": owner } },
						State: { Running: true },
						NetworkSettings: { Ports: {} },
					},
				]),
			};
		expect(args.slice(0, 4)).toEqual(["exec", "sentinel-mitm-a", "python3", "-c"]);
		expect(args[4]).toContain("mode=ro");
		const queries = JSON.parse(args[5]) as { sql: string; params: string[] }[];
		reads++;
		return { code: 0, stderr: "", stdout: JSON.stringify(queries.map((q) => db.prepare(q.sql).all(...q.params))) };
	};
	const center = new MitmCenter(root, () => [{ id: "a", name: "A" }], docker);
	const reader = await center.reader("a");
	expect(reader).toBeTypeOf("function");
	expect((await listMitmFlows("/not-on-host", new URLSearchParams(), reader)).total).toBe(1);
	expect((await getMitmFlow(directory, "live", reader)).request.captureTruncated).toBe(true);
	expect(readFileSync(await mitmRawPath(directory, "live", "request", reader))).toEqual(payload);
	expect(reads).toBe(3);
	await expect(center.reader("another-project")).rejects.toThrow();
});

test("capture configuration validates limits and persists operator choices", async () => {
	const center = new MitmCenter(root, () => [{ id: "a", name: "A" }], missingDocker);
	expect((await center.status("a")).config).toMatchObject({ skipStatic: true, maxCaptureMb: 2 });
	for (const maxCaptureMb of [0, -1, 33, 1.5, "2"]) {
		await expect(center.save("a", { bind: "127.0.0.1", port: 0, maxCaptureMb })).rejects.toThrow();
	}
	await expect(center.save("a", { bind: "127.0.0.1", port: 0, skipStatic: "yes" })).rejects.toThrow();
	expect(
		(await center.save("a", { bind: "127.0.0.1", port: 0, skipStatic: false, maxCaptureMb: 8 })).config,
	).toMatchObject({ skipStatic: false, maxCaptureMb: 8 });
});

test("HTTP API isolates projects, validates bodies, downloads raw bytes and rechecks context after upload", async () => {
	let active = "a";
	let authorized = true;
	let sawUpload: (() => void) | undefined;
	const center = new MitmCenter(
		root,
		() => [
			{ id: "a", name: "A" },
			{ id: "b", name: "B" },
		],
		missingDocker,
	);
	const payload = Buffer.from("HTTP/1.1 200 OK\r\n\r\n<html>raw</html>");
	insert("flw_one", 200, "proxy", "a.example", blob(payload));
	server = createServer((req, res) => {
		sawUpload?.();
		void handleMitmApi(req, res, center, { project: () => ({ id: active }), authorized: () => authorized });
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No listen address");
	const origin = `http://127.0.0.1:${address.port}`;
	const post = (body: string, contentType = "application/json") =>
		fetch(`${origin}/api/mitm/clear`, { method: "POST", headers: { "content-type": contentType }, body });
	expect((await fetch(`${origin}/api/mitm/flows?projectId=b`)).status).toBe(409);
	expect((await fetch(`${origin}/api/mitm/flows/flw_one?projectId=a`)).status).toBe(200);
	const raw = await fetch(`${origin}/api/mitm/flows/flw_one/response?projectId=a`);
	expect(raw.headers.get("content-type")).toBe("application/octet-stream");
	expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
	expect(Buffer.from(await raw.arrayBuffer())).toEqual(payload);
	expect((await fetch(`${origin}/api/mitm/ca.key?projectId=a`)).status).toBe(404);
	expect((await post("not json")).status).toBe(400);
	expect((await post("{}", "text/plain")).status).toBe(415);
	expect((await post(JSON.stringify({ projectId: "a" }))).status).toBe(400);
	expect((await post(" ".repeat(16385))).status).toBe(413);
	const pending = new Promise<void>((resolve) => {
		sawUpload = resolve;
	});
	const result = new Promise<number>((resolve, reject) => {
		const req = httpRequest(
			`${origin}/api/mitm/clear`,
			{ method: "POST", headers: { "content-type": "application/json" } },
			(res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			},
		);
		req.on("error", reject);
		req.write('{"projectId":"a",');
		void pending.then(() => {
			active = "b";
			req.end('"confirm":true}');
		});
	});
	expect(await result).toBe(409);
	expect((await listMitmFlows(directory, new URLSearchParams())).total).toBe(1);
	active = "a";
	authorized = false;
	expect((await fetch(`${origin}/api/mitm/flows?projectId=a`)).status).toBe(401);
});

test("proxy credentials are hashed, redacted, project-scoped and retained only when requested", async () => {
	const projects = [
		{ id: "a", name: "A" },
		{ id: "b", name: "B" },
	];
	const center = new MitmCenter(root, () => projects, missingDocker);
	const input = { bind: "0.0.0.0", port: 0, authEnabled: true, authUsername: "operator", password: "p@ss:word123" };
	await expect(center.save("a", { ...input, password: "" })).rejects.toThrow();
	for (const authUsername of ["", "user:name", "white space", "\nadmin", "a".repeat(65), 123]) {
		await expect(center.save("a", { ...input, authUsername })).rejects.toThrow();
	}
	for (const password of ["short", "a".repeat(129), "password\n", "中文密码12345", 123]) {
		await expect(center.save("a", { ...input, password })).rejects.toThrow();
	}
	const status = await center.save("a", input);
	expect(status.config).toMatchObject({ authEnabled: true, authUsername: "operator", hasPassword: true });
	expect(JSON.stringify(status)).not.toContain(input.password);
	expect(JSON.stringify(status)).not.toContain("authPasswordHash");
	expect(JSON.stringify(status)).not.toContain("authSalt");
	const path = join(root, "mitm", "a", "config.json");
	const stored = JSON.parse(readFileSync(path, "utf8")) as { authSalt: string; authPasswordHash: string };
	expect(readFileSync(path, "utf8")).not.toContain(input.password);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(pbkdf2Sync(input.password, Buffer.from(stored.authSalt, "hex"), 100000, 32, "sha256").toString("hex")).toBe(
		stored.authPasswordHash,
	);
	await center.save("a", { ...status.config, password: "", authSalt: "fake", authPasswordHash: "fake" });
	expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject(stored);
	const restarted = new MitmCenter(root, () => projects, missingDocker);
	expect((await restarted.status("a")).config.hasPassword).toBe(true);
	expect((await restarted.status("b")).config).toMatchObject({ authEnabled: false, hasPassword: false });
	await restarted.clear("a");
	expect((await restarted.status("a")).config.hasPassword).toBe(true);
	await restarted.save("a", { ...status.config, password: "replacement-password" });
	expect(JSON.parse(readFileSync(path, "utf8")).authPasswordHash).not.toBe(stored.authPasswordHash);
	await restarted.save("a", { ...status.config, authEnabled: false });
	expect((await restarted.status("a")).config.hasPassword).toBe(false);
	await expect(restarted.save("a", { ...status.config, password: "" })).rejects.toThrow();
});
