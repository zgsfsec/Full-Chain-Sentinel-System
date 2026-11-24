/**
 * Renaming, labelling and deleting a session go through one guard: only a file
 * inside the console's session directory may be touched. The guard used to
 * compare a prefix ending in a slash, which never matched on Windows, so a user
 * there could not do any of the three to any session. The Windows paths are
 * covered by managed-path.test.ts; this drives the real console to show that
 * the guard lets its own session files through and still keeps others out.
 */

import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionDirPath, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import WebSocket, { type RawData } from "ws";
import { addProject, setLastActiveProject } from "../src/projects.ts";
import type { SentinelServerMessage } from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";
import type { SentinelSessionListEntry } from "../src/session-status.ts";
import { installFakeDocker } from "./fake-docker.ts";

const REFUSED = "路径不在受管的会话目录内，已拒绝该操作";

type List = SentinelSessionListEntry[];

const listOf = (message: SentinelServerMessage): List | undefined =>
	message.type === "sessions" ? message.sessions : undefined;

/**
 * The console's messages in arrival order, with a way to wait for one that
 * answers a question. A wait that ends without an answer resolves to an `error`
 * message saying what arrived instead, so the test fails with that in its output.
 */
class Inbox {
	private readonly seen: SentinelServerMessage[] = [];
	private readonly waiting: Array<{
		accept: (message: SentinelServerMessage) => boolean;
		resolve: (message: SentinelServerMessage) => void;
	}> = [];
	private readonly timers = new WeakMap<object, ReturnType<typeof setTimeout>>();

	constructor(client: WebSocket) {
		client.on("message", (data: RawData) => {
			const message = JSON.parse(String(data)) as SentinelServerMessage;
			const index = this.waiting.findIndex((waiter) => waiter.accept(message));
			if (index < 0) {
				this.seen.push(message);
				return;
			}
			const [waiter] = this.waiting.splice(index, 1);
			clearTimeout(this.timers.get(waiter));
			waiter.resolve(message);
		});
	}

	/** The first message, already arrived or next, that `accept` takes. */
	next(accept: (message: SentinelServerMessage) => boolean, what: string): Promise<SentinelServerMessage> {
		const index = this.seen.findIndex(accept);
		if (index >= 0) return Promise.resolve(this.seen.splice(index, 1)[0]);
		return new Promise((resolve) => {
			const waiter = { accept, resolve };
			this.timers.set(
				waiter,
				setTimeout(() => {
					this.waiting.splice(this.waiting.indexOf(waiter), 1);
					const seen = this.seen.map((entry) => entry.type).join(", ") || "nothing";
					resolve({ type: "error", message: `no ${what} within 20 seconds; seen so far: ${seen}` });
				}, 20_000),
			);
			this.waiting.push(waiter);
		});
	}

	/** Session lists already in hand show the state before a command was sent: none of them may answer for it. */
	forgetLists(): void {
		this.seen.splice(0, this.seen.length, ...this.seen.filter((message) => listOf(message) === undefined));
	}
}

test("a session of this console can be renamed, labelled and deleted; a file from elsewhere is refused", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-session-files-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const docker = installFakeDocker(root, join(root, "workspace"));
	const created = await addProject(agentDir, { name: "会话操作" });
	if (!created.project) throw new Error(created.error ?? "项目创建失败");
	setLastActiveProject(agentDir, created.project.id);
	// Two conversations with something in them: the list only shows sessions that have a message.
	const workDir = created.project.workDir;
	const sessionDir = getSessionDirPath(workDir, agentDir);
	const first = SessionManager.create(workDir, sessionDir);
	first.appendMessage({ role: "user", content: "第一条对话", timestamp: Date.now() });
	const second = SessionManager.create(workDir, sessionDir);
	second.appendMessage({ role: "user", content: "第二条对话", timestamp: Date.now() });
	const server = await startSentinelServer({ agentDir, cwd: join(root, "workspace"), auth: false, port: 0 });
	const client = new WebSocket(`${server.url.replace("http:", "ws:")}/ws`);
	await once(client, "open");
	const inbox = new Inbox(client);
	const entry = (list: List, path: string) => list.find((item) => item.path === path);

	/** Sends a command and answers the first session list after it that shows it took effect. */
	const command = async (message: object, settled: (list: List) => boolean, what: string): Promise<List> => {
		inbox.forgetLists();
		client.send(JSON.stringify(message));
		const answer = await inbox.next((item) => listOf(item) !== undefined && settled(listOf(item) as List), what);
		if (answer.type === "error") throw new Error(answer.message);
		return listOf(answer) as List;
	};
	try {
		// The second of the project's two conversations is the one to work on.
		const listed = await command({ type: "list_sessions" }, (list) => list.length === 2, "the session list");
		const path = listed.find((item) => item.path === second.getSessionFile())?.path;
		if (!path) throw new Error("the second conversation is not in the list");
		expect(path).toBe(second.getSessionFile());
		expect(existsSync(path)).toBe(true);

		const renamed = await command(
			{ type: "rename_session", path, name: "改名后的会话" },
			(list) => entry(list, path)?.name === "改名后的会话",
			"the renamed session",
		);
		expect(entry(renamed, path)?.name).toBe("改名后的会话");

		const labelled = await command(
			{ type: "set_session_status", path, status: "done" },
			(list) => entry(list, path)?.status === "done",
			"the labelled session",
		);
		expect(entry(labelled, path)?.status).toBe("done");

		await command({ type: "delete_session", path }, (list) => entry(list, path) === undefined, "the deleted session");
		expect(existsSync(path)).toBe(false);

		// A file from outside the session directory, with the right extension, is refused each way and stays as it was.
		mkdirSync(join(root, "elsewhere"));
		const outside = join(root, "elsewhere", "looks-like-a-session.jsonl");
		const content = '{"type":"session"}\n';
		writeFileSync(outside, content);
		for (const message of [
			{ type: "delete_session", path: outside },
			{ type: "rename_session", path: outside, name: "偷来的会话" },
			{ type: "set_session_status", path: outside, status: "done" },
		]) {
			client.send(JSON.stringify(message));
			const answer = await inbox.next((item) => item.type === "error", "the refusal");
			expect(answer).toMatchObject({ type: "error", message: REFUSED });
		}
		expect(readFileSync(outside, "utf8")).toBe(content);
	} finally {
		client.terminate();
		server.close();
		docker.restore();
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);
