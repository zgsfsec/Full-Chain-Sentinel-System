/**
 * Chat attachments: the upload route and the file it writes.
 *
 * The invariant this file exists for: what the operator drops into the composer
 * lands where the agent can read it — under the active project's own work
 * directory — and nothing the client sends can put a file anywhere else, or
 * overwrite an earlier upload, or leave a half-written file behind.
 *
 * The route is driven over real HTTP against a real console, because the path it
 * writes to is the project's work dir and that only exists once a project is
 * active. Docker is faked and no container is involved: the console writes the
 * file on the host side of the mount, which is also what keeps the feature
 * working in a host session.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import { addProject, setLastActiveProject } from "../src/projects.ts";
import type { SentinelServerMessage, SentinelStateSnapshot } from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";
import { safeFileName, storeUpload, suffixedName, UPLOAD_MAX_BYTES, uploadsDirFor } from "../src/upload.ts";
import { type FakeDocker, installFakeDocker, projectSlug } from "./fake-docker.ts";
import { writeTestModel } from "./model-fixtures.ts";

let tempRoot = "";
let workDir = "";
let baseUrl = "";
let projectId = "";
let fakeDocker: FakeDocker | undefined;
let closeServer: (() => void) | undefined;
let socket: WebSocket | undefined;

/** POST one attachment the way the composer does, and read the JSON answer. */
async function upload(
	name: string,
	body: string | Buffer,
): Promise<{ status: number; payload: Record<string, unknown> }> {
	const response = await fetch(
		`${baseUrl}/api/upload?name=${encodeURIComponent(name)}&projectId=${encodeURIComponent(projectId)}`,
		{
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body,
		},
	);
	return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

/** A request body as the route receives one: a stream of buffers. */
async function* chunks(...buffers: Buffer[]): AsyncGenerator<Buffer> {
	for (const buffer of buffers) yield buffer;
}

/** The first snapshot the console pushes, which states the active project. */
function firstSnapshot(url: string): Promise<SentinelStateSnapshot> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url.replace("http://", "ws://").concat("/ws"));
		socket = ws;
		ws.on("message", (data) => {
			const message = JSON.parse(String(data)) as SentinelServerMessage;
			if (message.type === "snapshot") resolve(message.snapshot);
		});
		ws.on("error", reject);
	});
}

beforeAll(async () => {
	tempRoot = mkdtempSync(join(tmpdir(), "sentinel-web-upload-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "workspace");
	mkdirSync(cwd, { recursive: true });
	writeTestModel(agentDir, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "test-key", modelId: "sentinel-unused-model" });
	fakeDocker = installFakeDocker(tempRoot, join(tempRoot, "projects", projectSlug("upload-test")));
	const created = await addProject(agentDir, { name: "upload-test" });
	if (!created.project) throw new Error(`项目创建失败：${created.error ?? "未知原因"}`);
	setLastActiveProject(agentDir, created.project.id);
	const started = await startSentinelServer({ cwd, agentDir, host: "127.0.0.1", port: 0, auth: false });
	baseUrl = started.url;
	closeServer = started.close;
	workDir = created.project.workDir;
	projectId = created.project.id;
	// The route refuses while no project is selected, so the test starts from the
	// state a reloaded console is in: one project, already switched to.
	const snapshot = await firstSnapshot(started.url);
	expect(snapshot.project?.id).toBe(created.project.id);
	expect(snapshot.cwd).toBe(workDir);
});

afterAll(() => {
	socket?.close();
	closeServer?.();
	fakeDocker?.restore();
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test("file names are reduced to one safe segment", () => {
	expect(safeFileName("report.pdf")).toBe("report.pdf");
	expect(safeFileName("../../etc/passwd")).toBe("passwd");
	expect(safeFileName("C:\\Users\\me\\a.txt")).toBe("a.txt");
	expect(safeFileName("..")).toBe("file");
	expect(safeFileName("   ")).toBe("file");
	expect(safeFileName("")).toBe("file");
	expect(safeFileName("a\u0000b.txt")).toBe("ab.txt");
	expect(safeFileName(`${"x".repeat(200)}.txt`).length).toBe(120);
	expect(suffixedName("report.pdf", 2)).toBe("report-2.pdf");
	expect(suffixedName("archive.tar.gz", 3)).toBe("archive.tar-3.gz");
	expect(suffixedName("noext", 2)).toBe("noext-2");
	expect(uploadsDirFor("/work")).toBe("/work/uploads");
	// The advertised cap is the one the route uses when no test cap is passed.
	expect(UPLOAD_MAX_BYTES).toBe(1024 * 1024 * 1024);
});

test("an uploaded file lands in the project work dir, byte for byte", async () => {
	// Two megabytes, so the body arrives as several chunks rather than one: this
	// is the path that has to stream instead of buffering.
	const body = Buffer.concat([
		Buffer.from("第一行\n", "utf-8"),
		Buffer.alloc(2 * 1024 * 1024, 0x41),
		Buffer.from("\nend\n", "utf-8"),
	]);
	const answer = await upload("report.txt", body);
	expect(answer.status).toBe(200);
	expect(answer.payload.ok).toBe(true);
	expect(answer.payload.name).toBe("report.txt");
	expect(answer.payload.path).toBe(join(workDir, "uploads", "report.txt"));
	expect(answer.payload.size).toBe(body.byteLength);
	expect(readFileSync(join(workDir, "uploads", "report.txt"))).toEqual(body);
});

test("a name that tries to escape the uploads directory is reduced to one segment", async () => {
	const relative = await upload("../../evil.sh", Buffer.from("x"));
	expect(relative.status).toBe(200);
	expect(relative.payload.path).toBe(join(workDir, "uploads", "evil.sh"));
	const absolute = await upload("/etc/passwd", Buffer.from("y"));
	expect(absolute.payload.path).toBe(join(workDir, "uploads", "passwd"));
	// Nothing landed outside the uploads directory.
	expect(existsSync(join(workDir, "evil.sh"))).toBe(false);
	expect(existsSync(join(tempRoot, "evil.sh"))).toBe(false);
});

test("a second upload of the same name does not overwrite the first", async () => {
	await upload("dup.txt", Buffer.from("first"));
	const second = await upload("dup.txt", Buffer.from("second"));
	expect(second.payload.name).toBe("dup-2.txt");
	expect(readFileSync(join(workDir, "uploads", "dup.txt"), "utf-8")).toBe("first");
	expect(readFileSync(join(workDir, "uploads", "dup-2.txt"), "utf-8")).toBe("second");
});

test("uploads for a stale or missing project are rejected before writing files", async () => {
	for (const query of ["", "&projectId=other-project"]) {
		const response = await fetch(`${baseUrl}/api/upload?name=wrong-project.txt${query}`, {
			method: "POST",
			body: "private attachment",
		});
		expect(response.status).toBe(409);
		expect(existsSync(join(workDir, "uploads", "wrong-project.txt"))).toBe(false);
	}
});

test("a body over the cap is refused and leaves nothing behind", async () => {
	// The cap is a parameter, so proving the branch does not mean moving 1024MB
	// through the loopback socket.
	const result = await storeUpload(workDir, "big.bin", chunks(Buffer.alloc(6), Buffer.alloc(6)), 8);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("unreachable");
	expect(result.status).toBe(413);
	expect(existsSync(join(workDir, "uploads", "big.bin"))).toBe(false);
});

test("a body that breaks off mid-stream leaves no partial file", async () => {
	async function* broken(): AsyncGenerator<Buffer> {
		yield Buffer.alloc(4);
		throw new Error("connection lost");
	}
	const result = await storeUpload(workDir, "cut.bin", broken());
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("unreachable");
	expect(result.status).toBe(400);
	expect(existsSync(join(workDir, "uploads", "cut.bin"))).toBe(false);
});

test("the route refuses while no project is selected", async () => {
	// A second console with no project of its own: the upload has nowhere to go,
	// and the answer has to say so instead of writing into the startup directory.
	const agentDir = join(tempRoot, "agent-noproject");
	const cwd = join(tempRoot, "empty");
	mkdirSync(cwd, { recursive: true });
	writeTestModel(agentDir, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "test-key", modelId: "sentinel-unused-model" });
	const started = await startSentinelServer({ cwd, agentDir, host: "127.0.0.1", port: 0, auth: false });
	try {
		const response = await fetch(`${started.url}/api/upload?name=x.txt`, { method: "POST", body: "x" });
		expect(response.status).toBe(409);
		const payload = (await response.json()) as { error?: string };
		expect(payload.error).toContain("项目");
		expect(existsSync(join(cwd, "uploads", "x.txt"))).toBe(false);
	} finally {
		started.close();
	}
});
