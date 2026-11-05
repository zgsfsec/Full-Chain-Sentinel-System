/**
 * Stop, start and scoped deletion of a project container, over the console's protocol.
 *
 * The operator chooses per situation: stopping frees the container but keeps it
 * (and the project needs an explicit start afterwards), removing only the
 * container keeps the project and every record, and removing the project data
 * takes the container, the registry entry, the work directory, the session files
 * and the records. What is pinned here is that distinction end to end.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultSessionDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import type { SentinelClientMessage, SentinelProjectInfo, SentinelServerMessage } from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";
import { VulnerabilityStore } from "../src/vulnerabilities.ts";
import { type FakeDocker, installFakeDocker } from "./fake-docker.ts";

let tempRoot = "";
let agentDir = "";
let fakeDocker: FakeDocker | undefined;
let closeServer: (() => void) | undefined;
let ws: WebSocket | undefined;
let projectId = "";

const incoming: SentinelServerMessage[] = [];
const waiters: Array<{
	predicate: (message: SentinelServerMessage) => boolean;
	resolve: (message: SentinelServerMessage) => void;
}> = [];

function dispatch(message: SentinelServerMessage): void {
	const index = waiters.findIndex((waiter) => waiter.predicate(message));
	if (index >= 0) {
		const [waiter] = waiters.splice(index, 1);
		waiter.resolve(message);
		return;
	}
	incoming.push(message);
}

function waitFor(
	predicate: (message: SentinelServerMessage) => boolean,
	timeoutMs = 20000,
): Promise<SentinelServerMessage> {
	const buffered = incoming.findIndex(predicate);
	if (buffered >= 0) {
		const [message] = incoming.splice(buffered, 1);
		return Promise.resolve(message);
	}
	return new Promise((resolve, reject) => {
		const waiter = { predicate, resolve: () => {} } as (typeof waiters)[number];
		const timer = setTimeout(() => {
			const position = waiters.indexOf(waiter);
			if (position >= 0) waiters.splice(position, 1);
			reject(new Error(`超时。已收到：${incoming.map((message) => message.type).join(", ")}`));
		}, timeoutMs);
		waiter.resolve = (message) => {
			clearTimeout(timer);
			resolve(message);
		};
		waiters.push(waiter);
	});
}

function send(message: SentinelClientMessage): void {
	ws?.send(JSON.stringify(message));
}

/**
 * Ask the server for a fresh project list, then read this project's row.
 *
 * Every assertion about a state change starts here, so what it reads is the
 * result of the change and not a broadcast that happened to arrive earlier.
 */
async function refreshedProject(): Promise<SentinelProjectInfo> {
	send({ type: "list_projects" });
	return await project();
}

/**
 * The project row from the next broadcast that carries it. Broadcasts without it
 * are skipped, so a stale list from before the project existed cannot be read as
 * the project's current state.
 */
async function project(): Promise<SentinelProjectInfo> {
	const message = (await waitFor(
		(entry) => entry.type === "projects" && entry.projects.some((row) => row.id === projectId),
	)) as { projects: SentinelProjectInfo[] };
	const found = message.projects.find((entry) => entry.id === projectId);
	if (!found) throw new Error("项目中不在列表中");
	return found;
}

beforeAll(async () => {
	tempRoot = mkdtempSync(join(tmpdir(), "sentinel-project-lifecycle-"));
	agentDir = join(tempRoot, "agent");
	mkdirSync(agentDir, { recursive: true });
	fakeDocker = installFakeDocker(tempRoot, join(tempRoot, "projects", "stop-demo"));
	const started = await startSentinelServer({
		cwd: join(tempRoot, "workspace"),
		agentDir,
		host: "127.0.0.1",
		port: 0,
		auth: false,
	});
	closeServer = started.close;
	ws = new WebSocket(started.url.replace("http://", "ws://").concat("/ws"));
	ws.on("message", (data) => dispatch(JSON.parse(String(data)) as SentinelServerMessage));
	await new Promise<void>((resolve, reject) => {
		ws?.once("open", () => resolve());
		ws?.once("error", (error) => reject(error));
	});

	send({ type: "add_project", name: "stop-demo" });
	const created = await waitFor(
		(message) => message.type === "projects" && message.projects.some((entry) => entry.name === "stop-demo"),
	);
	projectId =
		(created as { projects: SentinelProjectInfo[] }).projects.find((entry) => entry.name === "stop-demo")?.id ?? "";
	expect(projectId).not.toBe("");
	send({ type: "switch_project", id: projectId });
	await waitFor((message) => message.type === "projects" && message.activeProjectId === projectId);
	// Bootstrap messages that arrived while connecting are not evidence for
	// anything later: start every test from an empty buffer.
	incoming.length = 0;
}, 40000);

afterAll(() => {
	ws?.close();
	closeServer?.();
	fakeDocker?.restore();
	rmSync(tempRoot, { recursive: true, force: true });
});

test("activity responses echo the request id on success and failure", async () => {
	send({ type: "list_code_activity", requestId: 710, projectId, filter: "reproducing", page: 1, pageSize: 20 });
	const success = await waitFor((message) => message.type === "code_activity" && message.requestId === 710);
	expect(success).toMatchObject({
		type: "code_activity",
		requestId: 710,
		view: { total: 0, counts: { reproducing: 0, finished: 0 } },
	});
	send({
		type: "list_code_activity",
		requestId: 711,
		projectId: "missing-project",
		filter: "all",
		page: 1,
		pageSize: 20,
	});
	const failure = await waitFor((message) => message.type === "code_activity_error" && message.requestId === 711);
	expect(failure).toMatchObject({
		type: "code_activity_error",
		requestId: 711,
		error: expect.stringContaining("项目不存在"),
	});
});

test("each project reports its own session count, not just the active one", async () => {
	const workDir = (await refreshedProject()).cwd;
	expect((await refreshedProject()).sessionCount).toBe(0);

	// A session is one file, so the count is a listing — which is the only way to
	// know it for a project the console is not currently working in.
	const manager = SessionManager.create(workDir, getDefaultSessionDir(workDir, agentDir));
	manager.appendMessage({ role: "user", content: "开始侦察", timestamp: Date.now() });
	const fresh = await refreshedProject();
	expect(fresh.sessionCount).toBe(1);
});

test("a stopped project reports its state and refuses to be entered", async () => {
	expect((await refreshedProject()).state).toBe("running");

	send({ type: "stop_project", id: projectId });
	const stopped = await project();
	expect(stopped.state).toBe("stopped");
	expect(stopped.manualStop).toBe(true);

	// Entering needs the explicit start: the stop must not be undone by a click.
	send({ type: "switch_project", id: projectId });
	const error = (await waitFor((message) => message.type === "error")) as { message?: string; error?: string };
	expect(JSON.stringify(error)).toContain("启动容器");
});

test("starting it again makes the project usable", async () => {
	send({ type: "start_project", id: projectId });
	const started = await project();
	expect(started.state).toBe("running");
	expect(started.manualStop).toBe(false);

	send({ type: "switch_project", id: projectId });
	await waitFor((message) => message.type === "projects" && message.activeProjectId === projectId);
	// Bootstrap messages that arrived while connecting are not evidence for
	// anything later: start every test from an empty buffer.
	incoming.length = 0;
}, 40000);

test("removing only the container keeps the project, its records and its files", async () => {
	const workDir = (await refreshedProject()).cwd;
	writeFileSync(join(workDir, "report.md"), "扫描结果");
	const store = new VulnerabilityStore(join(agentDir, "vulnerabilities.db"));
	try {
		store.create({
			projectId,
			projectName: "stop-demo",
			sessionId: "s1",
			source: "主代理",
			title: "保留的漏洞",
			severity: "high",
			cvss: 7.5,
			target: "10.0.0.5",
			description: "描述",
			packet: "GET /",
		});
	} finally {
		store.close();
	}

	send({ type: "remove_project", id: projectId, confirmName: "stop-demo", scope: "container" });
	const kept = await project();
	expect(kept.state).toBe("missing");
	expect(kept.manualStop).toBe(true);
	// The work directory and the records are untouched. The finding is read from
	// the store: the project is not active any more, so the hub would list nothing.
	expect(existsSync(join(workDir, "report.md"))).toBe(true);
	const after = new VulnerabilityStore(join(agentDir, "vulnerabilities.db"));
	try {
		expect(after.list(projectId, {})).toHaveLength(1);
	} finally {
		after.close();
	}
});

test("removing the project data deletes the records, the sessions and the work directory", async () => {
	const workDir = (await refreshedProject()).cwd;
	const sessionDir = getDefaultSessionDir(workDir, agentDir);
	const manager = SessionManager.create(workDir, sessionDir);
	// The file appears on the first append, not on create.
	manager.appendMessage({ role: "user", content: "侦察 10.0.0.5", timestamp: Date.now() });
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("会话文件未创建");
	expect(existsSync(sessionFile)).toBe(true);

	send({ type: "remove_project", id: projectId, confirmName: "stop-demo", scope: "data" });
	const after = (await waitFor(
		(message) => message.type === "projects" && !message.projects.some((entry) => entry.id === projectId),
	)) as { projects: SentinelProjectInfo[] };
	expect(after.projects.some((entry) => entry.id === projectId)).toBe(false);

	expect(existsSync(sessionFile)).toBe(false);
	expect(existsSync(workDir)).toBe(false);
	const store = new VulnerabilityStore(join(agentDir, "vulnerabilities.db"));
	try {
		expect(store.list(projectId, {})).toHaveLength(0);
	} finally {
		store.close();
	}
});
