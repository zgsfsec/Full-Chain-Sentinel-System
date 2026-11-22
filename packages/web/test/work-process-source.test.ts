import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION, getSessionDirPath } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	addLibraryEntry,
	FOLLOW_MAIN,
	libraryView,
	readModelLibrary,
	removeLibraryEntry,
	resolveLibraryRole,
	setLibraryRole,
} from "../src/model-library.ts";
import type { SentinelEngine, SentinelEngineTask } from "../src/protocol.ts";
import {
	engineWorkEvidence,
	engineWorkSnapshot,
	RecordedWorkProcessSources,
	sessionWorkEvidence,
} from "../src/work-process-source.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "work-process-sources-"));
});
afterEach(() => rmSync(dir, { force: true, recursive: true }));

function sessionRecord(id: string, message: Record<string, unknown>) {
	return JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z", message });
}

function task(id: string): SentinelEngineTask {
	return {
		id,
		engineId: "engine-1",
		title: id,
		objective: `检查 ${id}`,
		target: null,
		workspace: "/work",
		status: "running",
		attempt: 1,
		criteria: [],
		roundLimit: 1,
		pendingContinue: null,
		presetId: null,
		presetName: null,
		sessionId: null,
		startedAt: 10,
		endedAt: null,
		summary: null,
		error: null,
		usage: null,
		vulns: 0,
		autoResume: false,
	};
}

function engine(): SentinelEngine {
	return {
		id: "engine-1",
		projectId: "p1",
		projectName: "项目",
		name: "权限工程",
		status: "running",
		pauseNote: null,
		targets: [{ target: "https://example.test" }],
		doctrines: [],
		presetIds: [],
		presetOptional: true,
		limits: { concurrency: 2, roundLimit: 1, tokenLimit: null, timeLimitMin: null, maxRetries: 1 },
		gateMode: "auto",
		createdAt: 1,
		startedAt: 2,
		endedAt: null,
		schedule: null,
		report: null,
		tasks: [task("t1"), task("t2")],
	};
}

describe("recorded work process sources", () => {
	test("an active empty conversation can enable recording before its first persisted message", async () => {
		const cwd = join(dir, "empty-project");
		mkdirSync(cwd);
		const id = "f004d98f-e3a3-4dd0-8e49-1534be84e980";
		const sources = new RecordedWorkProcessSources({
			agentDir: dir,
			projects: () => [{ id: "p1", name: "项目", cwd }],
			engines: () => [],
			commanderEvents: () => [],
			taskEvents: () => [],
			active: () => ({ id, projectId: "p1", running: [] }),
		});
		expect(await sources.list("p1", "session")).toEqual([expect.objectContaining({ id, title: "新对话" })]);
		expect(await sources.load({ projectId: "p1", kind: "session", id })).toMatchObject({
			source: { id, title: "新对话" },
			lanes: [{ ownerId: id, evidence: [] }],
		});
	});

	test("redacts quoted JSON credentials before excerpts, model input, and original-record display", () => {
		const content = sessionRecord("a1", {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "c1",
					name: "request",
					arguments: {
						password: "private-password",
						token: "private-token",
						headers: { Authorization: "Basic private-basic", Cookie: "sid=private-cookie" },
					},
				},
			],
		});
		for (const limit of [6000, 256000]) {
			const entries = sessionWorkEvidence(content, "s1", limit);
			expect(entries).toHaveLength(1);
			for (const secret of ["private-password", "private-token", "private-basic", "private-cookie"])
				expect(entries[0].text).not.toContain(secret);
			expect(entries[0].text).toContain("REDACTED");
		}
	});

	test("uses only visible messages and tool records; redacts secrets and marks truncated output", () => {
		const entries = sessionWorkEvidence(
			[
				"null",
				"broken",
				sessionRecord("u1", { role: "user", content: "确认接口权限" }),
				sessionRecord("a1", {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "private hidden reasoning" },
						{ type: "text", text: "检查鉴权" },
						{
							type: "toolCall",
							id: "c1",
							name: "bash",
							arguments: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://example.test" },
						},
					],
				}),
				sessionRecord("r1", {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "x".repeat(8000) }],
				}),
			].join("\n"),
			"s1",
		);
		expect(entries.map((entry) => entry.kind)).toEqual(["user", "assistant", "tool_start", "tool_end"]);
		expect(JSON.stringify(entries)).not.toContain("private hidden reasoning");
		expect(JSON.stringify(entries)).not.toContain("abcdefghijklmnop");
		expect(entries[2].text).toContain("REDACTED");
		expect(entries[3]).toMatchObject({ status: "error", truncated: true, entryId: "r1", toolCallId: "c1" });
		expect(entries[3].text).toHaveLength(6000);
	});

	test("builds recorded engineering dispatch branches and keeps failed tasks", () => {
		const input = engine();
		input.tasks[1].status = "failed";
		input.tasks[1].error = "连接失败";
		const snapshot = engineWorkSnapshot(
			input,
			[
				{ seq: 1, kind: "thinking", at: 1, text: "hidden" },
				{
					seq: 2,
					kind: "tool_end",
					at: 2,
					toolName: "dispatch_task",
					toolCallId: "c1",
					output: "任务已派发：t1",
					isError: false,
				},
			],
			(id) => [{ seq: 1, kind: "text", at: 4, text: `检查 ${id}` }],
		);
		expect(snapshot.nodes.map((node) => node.kind)).toEqual(["root", "agent", "task", "task"]);
		expect(snapshot.edges.find((edge) => edge.to === "task:t1")).toMatchObject({
			kind: "dispatch",
			basis: "recorded",
		});
		expect(snapshot.nodes.find((node) => node.id === "task:t2")).toMatchObject({
			status: "failed",
			outcomes: ["连接失败"],
		});
		expect(snapshot.lanes).toHaveLength(3);
		expect(JSON.stringify(snapshot)).not.toContain("hidden");
		const before = snapshot.lanes[2].evidence[0].id;
		input.tasks[1].status = "done";
		expect(engineWorkSnapshot(input, [], () => []).lanes[2].evidence[0].id).not.toBe(before);
	});

	test("keeps running calls separate from results and preserves truncation flags", () => {
		const entries = engineWorkEvidence(
			[
				{ seq: 1, kind: "tool_start", at: 1, toolName: "bash", toolCallId: "c1", args: { command: "check" } },
				{ seq: 2, kind: "tool_end", at: 2, toolName: "bash", toolCallId: "c1", output: "partial", truncated: true },
			],
			"commander",
		);
		expect(entries[0]).toMatchObject({ status: "running", id: "commander:event:1" });
		expect(entries[1]).toMatchObject({ status: "ok", truncated: true, id: "commander:event:2" });
	});

	test("reads history without changing source files, enforces project membership and expands original evidence", async () => {
		const cwd = join(dir, "project");
		mkdirSync(cwd);
		const sessionDir = getSessionDirPath(cwd, dir);
		mkdirSync(sessionDir, { recursive: true });
		const id = "f004d98f-e3a3-4dd0-8e49-1534be84e980";
		const path = join(sessionDir, `2026-01-01_${id}.jsonl`);
		const content = [
			JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id,
				cwd,
				timestamp: "2026-01-01T00:00:00Z",
			}),
			sessionRecord("u1", { role: "user", content: "权限检查" }),
			sessionRecord("r1", {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: "a".repeat(9000) }],
			}),
		].join("\n");
		writeFileSync(path, content);
		const sources = new RecordedWorkProcessSources({
			agentDir: dir,
			projects: () => [
				{ id: "p1", name: "项目", cwd },
				{ id: "p2", name: "其他项目", cwd: join(dir, "other") },
			],
			engines: () => [],
			commanderEvents: () => [],
			taskEvents: () => [],
			active: () => ({ id: null, projectId: null, running: [] }),
		});
		const ref = { projectId: "p1", kind: "session" as const, id };
		const listed = await sources.list("p1", "session");
		expect(listed.some((entry) => entry.id === id)).toBe(true);
		const snapshot = await sources.load(ref);
		expect(snapshot.lanes[0].evidence).toHaveLength(2);
		const result = snapshot.lanes[0].evidence[1];
		expect(result.truncated).toBe(true);
		expect(await sources.original(ref, result)).toMatchObject({ text: "a".repeat(9000), truncated: false });
		expect(readFileSync(path, "utf8")).toBe(content);
		await expect(sources.load({ ...ref, projectId: "p2" })).rejects.toThrow("不存在");
		await expect(sources.load({ ...ref, kind: "engine" })).rejects.toThrow("不存在");
	});
});

test("work links model follows main by default, supports its own endpoint and prevents deleting a referenced model", () => {
	const main = addLibraryEntry(dir, { name: "主模型", modelId: "main", baseUrl: "http://main.test/v1", apiKey: "" });
	const analysis = addLibraryEntry(dir, {
		name: "分析",
		modelId: "analysis",
		baseUrl: "http://analysis.test/v1",
		apiKey: "",
	});
	expect(readModelLibrary(dir).roles.workprocess).toEqual({ kind: "follow-main" });
	expect(resolveLibraryRole(dir, "workprocess")).toMatchObject({ entryId: main.id, followedMain: true });
	setLibraryRole(dir, "workprocess", analysis.id);
	expect(libraryView(dir).roles.workprocess).toBe(analysis.id);
	expect(libraryView(dir).resolved.workprocess?.modelId).toBe("analysis");
	expect(() => removeLibraryEntry(dir, analysis.id)).toThrow("工作链路模型");
	setLibraryRole(dir, "workprocess", FOLLOW_MAIN);
	expect(() => removeLibraryEntry(dir, analysis.id)).not.toThrow();
});
