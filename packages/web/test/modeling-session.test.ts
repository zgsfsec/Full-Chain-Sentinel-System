/**
 * Business modeling over the real WebSocket protocol.
 *
 * This is the invariant the feature exists for, checked where it actually
 * matters: every conversation declares the four modeling tools, pressing the
 * button sends the instruction and opens no record, and the record the agent's
 * first submission opens is the one the page lists, reads, exports, closes and
 * deletes. Nothing here needs Docker or a provider — the configured endpoint is
 * a port nothing listens on, which is enough to observe the declaration, the
 * instruction, the record and the closing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import { ApiModelStore } from "../src/apimodels.ts";
import type {
	SentinelApiModelSummary,
	SentinelClientMessage,
	SentinelServerMessage,
	SentinelStateSnapshot,
	SentinelToolInfo,
} from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";
import { type FakeDocker, installFakeDocker, projectSlug } from "./fake-docker.ts";
import { writeTestModel } from "./model-fixtures.ts";

let tempRoot = "";
let fakeDocker: FakeDocker | undefined;
let closeServer: (() => void) | undefined;
let ws: WebSocket | undefined;

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
	const index = incoming.findIndex(predicate);
	if (index >= 0) {
		const [message] = incoming.splice(index, 1);
		return Promise.resolve(message);
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			const position = waiters.indexOf(waiter);
			if (position >= 0) waiters.splice(position, 1);
			reject(new Error(`Timed out waiting for a message. Buffered: ${incoming.map((m) => m.type).join(", ")}`));
		}, timeoutMs);
		const waiter = {
			predicate,
			resolve: (message: SentinelServerMessage) => {
				clearTimeout(timer);
				resolve(message);
			},
		};
		waiters.push(waiter);
	});
}

function send(message: SentinelClientMessage): void {
	ws?.send(JSON.stringify(message));
}

function snapshotWhere(
	predicate: (snapshot: SentinelStateSnapshot) => boolean,
	timeoutMs = 20000,
): Promise<SentinelStateSnapshot> {
	return waitFor((message) => message.type === "snapshot" && predicate(message.snapshot), timeoutMs).then(
		(message) => (message as { snapshot: SentinelStateSnapshot }).snapshot,
	);
}

/** The mounted tools of the viewed session, as the permissions screen reads them. */
async function mountedTools(): Promise<SentinelToolInfo[]> {
	// Drop anything an earlier step left buffered: the list must be this answer.
	incoming.length = 0;
	send({ type: "get_permissions" });
	const message = await waitFor((candidate) => candidate.type === "permissions");
	if (message.type !== "permissions") throw new Error("no permissions message");
	return message.tools;
}

function activeNames(tools: SentinelToolInfo[]): string[] {
	return tools.filter((tool) => tool.active).map((tool) => tool.name);
}

async function apiModels(filters?: SentinelApiModelSummary["status"]): Promise<SentinelApiModelSummary[]> {
	incoming.length = 0;
	send({ type: "list_api_models", ...(filters ? { filters: { status: filters } } : {}) });
	const message = await waitFor((candidate) => candidate.type === "api_models");
	if (message.type !== "api_models") throw new Error("no api_models message");
	return message.items;
}

/** The error the server answers the next message with. */
async function refusal(message: SentinelClientMessage): Promise<string> {
	incoming.length = 0;
	send(message);
	const answer = await waitFor((candidate) => candidate.type === "error");
	if (answer.type !== "error") throw new Error("no error message");
	return answer.message;
}

/**
 * Waits for the turn to be over and hands back the snapshot that says so.
 *
 * A snapshot is broadcast only when the state changes, so every wait names the
 * state it wants: waiting for "the next snapshot" never ends when nothing does.
 */
async function settled(): Promise<SentinelStateSnapshot> {
	return snapshotWhere((snapshot) => !snapshot.streaming, 30000);
}

/** The text of every modeling marker row the viewed conversation holds. */
function modelingRows(snapshot: SentinelStateSnapshot): string[] {
	return snapshot.messages
		.filter((message) => (message as { customType?: string }).customType === "zg-modeling")
		.map((message) => JSON.stringify((message as { content?: unknown }).content ?? ""));
}

/**
 * A stored record, written through a second handle on the database the way an
 * earlier run leaves it: with both halves, each put in by its own submission.
 */
function seedRecord(projectId: string, title: string, now: Date): string {
	const seed = new ApiModelStore(join(tempRoot, "agent", "apimodels.db"));
	const opened = seed.start(
		{ projectId, sessionId: "seed", sessionPath: null, title },
		{
			target: "https://shop.example.com",
			paths: { "/api/users": { get: { summary: "用户列表" } } },
			entities: [{ name: "用户", fields: [{ name: "id", type: "integer" }] }],
		},
		now,
	);
	const id = opened.model?.id ?? "";
	const submitted = seed.submitSource(
		id,
		{
			apis: [
				{
					method: "GET",
					path: "/api/orders/{id}",
					module: "订单",
					summary: "查订单",
					handler: { name: "getOrder", location: { file: "src/OrderController.java", line: 42 } },
					callChain: [],
					dataAccess: [],
					authChecks: [],
					externalCalls: [],
				},
			],
			source: "shop-api/",
		},
		{ hostWorkDir: join(tempRoot, "projects", projectSlug("modeling-test")) },
	);
	seed.close();
	if (!submitted.ok) throw new Error(submitted.errors.join("\n"));
	return id;
}

beforeAll(async () => {
	tempRoot = mkdtempSync(join(tmpdir(), "sentinel-web-modeling-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "workspace");
	// A model is configured so entering the project can build a session. The port
	// is closed on purpose: the turn the button starts fails immediately, and what
	// this file asserts is the mounting, the instruction and the records.
	writeTestModel(agentDir, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "test-key", modelId: "sentinel-unused-model" });
	fakeDocker = installFakeDocker(tempRoot, join(tempRoot, "projects", projectSlug("modeling-test")));
	const started = await startSentinelServer({ cwd, agentDir, host: "127.0.0.1", port: 0, auth: false });
	closeServer = started.close;
	ws = new WebSocket(started.url.replace("http://", "ws://").concat("/ws"));
	ws.on("message", (data) => dispatch(JSON.parse(String(data)) as SentinelServerMessage));
	await new Promise<void>((resolve, reject) => {
		if (!ws) throw new Error("no socket");
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});

	send({ type: "add_project", name: "modeling-test" });
	const created = await waitFor((message) => message.type === "projects" && message.projects.length === 1);
	const project = (created as { projects: Array<{ id: string }> }).projects[0];
	send({ type: "switch_project", id: project?.id ?? "" });
	await snapshotWhere((snapshot) => snapshot.project !== null && snapshot.activeSessionId !== null);
});

afterAll(() => {
	ws?.close();
	closeServer?.();
	fakeDocker?.restore();
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test("a fresh conversation carries the four modeling tools active, with no run and no record", async () => {
	const snapshot = await snapshotWhere(() => true);
	expect(snapshot.modeling).toBeNull();

	const tools = await mountedTools();
	const modeling = ["api_model_done", "api_model_read", "api_model_submit", "source_model_submit"];
	expect(
		tools
			.filter((tool) => modeling.includes(tool.name))
			.map((tool) => tool.name)
			.sort(),
	).toEqual(modeling);
	// Every tool is declared in every conversation, so the operator can ask for
	// modeling in the conversation instead of pressing a button, and every agent
	// can read what earlier runs recorded. What keeps writing out of ordinary
	// work is the wording the tools carry: the unit tests pin that every
	// description and first guideline of the three that write say not to call
	// them unless modeling was asked for.
	for (const name of modeling) expect(activeNames(tools)).toContain(name);
	expect(await apiModels()).toEqual([]);
});

test("the button sends the instruction and opens nothing; the record is the agent's to open", async () => {
	send({ type: "start_modeling" });

	// The briefing reached the transcript as a row of its own, and it is the
	// whole instruction: what to decide, the four tools, and the discipline.
	const briefed = await snapshotWhere(
		(snapshot) => modelingRows(snapshot).some((text) => text.includes("【业务建模】现在开始")),
		30000,
	);
	const briefing = modelingRows(briefed).find((text) => text.includes("【业务建模】现在开始")) ?? "";
	for (const expected of [
		"先定范围",
		"api_model_read",
		"api_model_submit",
		"source_model_submit",
		"api_model_done",
		"二、读源码",
	])
		expect(briefing).toContain(expected);
	// No record was opened by the button: only an accepted submission does that.
	expect(briefed.modeling).toBeNull();
	expect(await apiModels()).toEqual([]);

	// The configured endpoint is closed, so the turn the button started fails at
	// once. The failed turn is in the transcript like any other, and it left no
	// record behind: a run that never submitted is not a record.
	const idle = await settled();
	expect(idle.modeling).toBeNull();
	expect(await apiModels()).toEqual([]);

	// With no run there is nothing to end, and the refusal says so.
	expect(await refusal({ type: "end_modeling" })).toContain("没有进行中的业务建模");
	// The tools stay: they are part of every conversation.
	const after = await mountedTools();
	for (const name of ["api_model_read", "api_model_submit", "source_model_submit", "api_model_done"])
		expect(activeNames(after)).toContain(name);
});

test("the page lists, reads, exports, closes and deletes records over the socket", async () => {
	// Snapshots are broadcast only when the state changes, so one is asked for.
	incoming.length = 0;
	send({ type: "get_state" });
	const state = await snapshotWhere(() => true);
	const projectId = state.project?.id as string;
	const listed = seedRecord(projectId, "商城", new Date("2026-11-25T10:00:00Z"));
	const orphan = seedRecord(projectId, "运营后台", new Date("2026-11-25T11:00:00Z"));

	const all = await apiModels();
	expect(all.map((item) => item.id)).toEqual([orphan, listed]);
	// One list row counts both halves.
	expect(all[1]).toMatchObject({
		title: "商城",
		status: "modeling",
		target: "https://shop.example.com",
		source: "shop-api/",
		pathCount: 1,
		operationCount: 1,
		entityCount: 1,
		apiCount: 1,
		projectId,
	});

	incoming.length = 0;
	// The search covers the title and both scopes.
	incoming.length = 0;
	send({ type: "list_api_models", filters: { search: "商城" } });
	const filtered = await waitFor((message) => message.type === "api_models");
	if (filtered.type !== "api_models") throw new Error("no api_models message");
	expect(filtered.items.map((item) => item.id)).toEqual([listed]);

	incoming.length = 0;
	send({ type: "get_api_model", id: listed });
	const detail = await waitFor((message) => message.type === "api_model");
	if (detail.type !== "api_model") throw new Error("no api_model message");
	expect(Object.keys(detail.model.openapi.paths as Record<string, unknown>)).toEqual(["/api/users"]);
	expect(detail.model.apis[0]).toMatchObject({
		method: "GET",
		path: "/api/orders/{id}",
		handler: { name: "getOrder", location: { file: "/work/src/OrderController.java", line: 42 } },
		authChecks: [],
	});
	// One audit trail for the record, whichever half was submitted.
	expect(detail.events.map((event) => [event.kind, event.pathCount, event.apiCount])).toEqual([
		["created", 0, 0],
		["submitted", 1, 0],
		["submitted", 1, 1],
	]);
	expect(await refusal({ type: "get_api_model", id: "api-missing" })).toContain(
		"没有 id 为 api-missing 的业务建模记录",
	);

	// One export, four forms: the interface document as OpenAPI, and the whole record.
	const short = listed.slice(4, 12);
	for (const [format, filename, expected] of [
		["json", `商城-${short}.json`, '"summary": "用户列表"'],
		["yaml", `商城-${short}.yaml`, "openapi: 3.0.3"],
		["record", `商城-record-${short}.json`, '"source": "shop-api/"'],
		["markdown", `商城-record-${short}.md`, "## 接口文档"],
	] as const) {
		incoming.length = 0;
		send({ type: "export_api_model", id: listed, format });
		const exported = await waitFor((message) => message.type === "api_model_export");
		if (exported.type !== "api_model_export") throw new Error("no api_model_export message");
		expect(exported.format).toBe(format);
		expect(exported.filename).toBe(filename);
		expect(exported.text).toContain(expected);
	}
	expect(await refusal({ type: "export_api_model", id: "api-missing", format: "record" })).toContain("该记录不存在");

	// Closing a record that is already over changes nothing and still says ok: the
	// operator's click on a stale page must not rewrite how the run ended.
	for (let attempt = 0; attempt < 2; attempt++) {
		incoming.length = 0;
		send({ type: "end_api_model", id: listed });
		const closed = await waitFor((message) => message.type === "api_model_result" && message.id === listed);
		expect(closed).toMatchObject({ action: "结束", ok: true });
	}
	incoming.length = 0;
	send({ type: "get_api_model", id: listed });
	const reread = await waitFor((message) => message.type === "api_model");
	if (reread.type !== "api_model") throw new Error("no api_model message");
	expect(reread.model.status).toBe("manual");
	expect(reread.events.map((event) => event.kind)).toEqual(["created", "submitted", "submitted", "manual"]);
	expect((await apiModels("manual")).map((item) => item.id)).toEqual([listed]);

	incoming.length = 0;
	send({ type: "delete_api_model", id: orphan });
	const deleted = await waitFor((message) => message.type === "api_model_result" && message.id === orphan);
	expect(deleted).toMatchObject({ action: "删除", ok: true });
	expect((await apiModels()).some((item) => item.id === orphan)).toBe(false);
	// Deleting a record that is not there is a result that says so, not an error.
	incoming.length = 0;
	send({ type: "delete_api_model", id: orphan });
	const missing = await waitFor((message) => message.type === "api_model_result" && message.id === orphan);
	expect(missing).toMatchObject({ action: "删除", ok: false, error: "该记录不存在" });

	// Deleting a record does not disturb the conversation: no tool changes, no marker.
	const tools = await mountedTools();
	for (const name of ["api_model_read", "api_model_submit", "source_model_submit", "api_model_done"])
		expect(activeNames(tools)).toContain(name);
});
