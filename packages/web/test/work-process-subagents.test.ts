import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionDirPath, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openSqliteDatabase } from "../src/sqlite.ts";
import { SubagentStore, subagentDbPath } from "../src/subagent-store.ts";
import { WorkProcesses } from "../src/work-process.ts";
import { RecordedWorkProcessSources } from "../src/work-process-source.ts";
import { WorkProcessStore } from "../src/work-process-store.ts";
import { recordedWorkSubagents } from "../src/work-process-subagents.ts";
import { layoutWorkGraph, layoutWorkProcess } from "../webui/src/components/work-process-layout.ts";
import { workReply } from "./work-process-fixtures.ts";

let dir: string;
let session: SessionManager;
let sources: RecordedWorkProcessSources;
let retained: SubagentStore | undefined;
let manager: WorkProcesses | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "work-process-subagents-"));
	const cwd = join(dir, "project");
	mkdirSync(cwd);
	session = SessionManager.create(cwd, getSessionDirPath(cwd, dir));
	session.appendMessage({ role: "user", content: "分别检查两个服务的权限", timestamp: Date.now() });
	sources = new RecordedWorkProcessSources({
		agentDir: dir,
		projects: () => [
			{ id: "p1", name: "项目", cwd },
			{ id: "p2", name: "另一项目", cwd },
		],
		engines: () => [],
		commanderEvents: () => [],
		taskEvents: () => [],
		active: () => ({ id: null, projectId: null, running: [] }),
	});
});
afterEach(() => {
	manager?.close();
	manager = undefined;
	retained?.close();
	retained = undefined;
	rmSync(dir, { force: true, recursive: true });
});

function createRun(id: string, projectId = "p1", sessionId = session.getSessionId()) {
	retained ??= new SubagentStore(subagentDbPath(dir));
	retained.createRun({ id, projectId, sessionId, task: "核实接口权限", startedAt: "2026-01-01T00:00:00Z" });
}
function ref() {
	return { projectId: "p1", kind: "session" as const, id: session.getSessionId() };
}

describe("spawn_agent work-link sources", () => {
	test("does not create a subagent database while observing a conversation without children", async () => {
		expect((await sources.load(ref())).nodes).toHaveLength(1);
		expect(recordedWorkSubagents(dir, "p1", session.getSessionId())).toEqual([]);
		expect(existsSync(subagentDbPath(dir))).toBe(false);
	});

	test("opens SQLite observers read-only and never creates a missing database", () => {
		const path = join(dir, "readonly.db");
		const writer = openSqliteDatabase(path);
		writer.exec("CREATE TABLE entries (value TEXT); INSERT INTO entries VALUES ('retained')");
		const observer = openSqliteDatabase(path, { readOnly: true });
		try {
			expect(observer.prepare("SELECT value FROM entries").get()).toMatchObject({ value: "retained" });
			expect(() => observer.exec("DELETE FROM entries")).toThrow();
		} finally {
			observer.close();
			writer.close();
		}
		const missing = join(dir, "missing.db");
		expect(() => openSqliteDatabase(missing, { readOnly: true })).toThrow();
		expect(existsSync(missing)).toBe(false);
	});

	test("reads parallel children of inactive conversations without mixing owners or exposing thinking", async () => {
		createRun("a");
		createRun("b");
		createRun("foreign-project", "p2");
		createRun("foreign-chat", "p1", "other-session");
		retained!.appendEvent("a", { seq: 1, at: 2, kind: "thinking", text: "hidden reasoning" });
		retained!.appendEvent("a", {
			seq: 2,
			at: 3,
			kind: "tool_start",
			toolCallId: "same-call",
			toolName: "request",
			args: { password: "secret-password" },
		});
		retained!.appendEvent("b", {
			seq: 1,
			at: 3,
			kind: "tool_start",
			toolCallId: "same-call",
			toolName: "bash",
			args: { command: "check" },
		});
		const path = session.getSessionFile()!;
		const before = readFileSync(path, "utf8");
		const graph = await sources.load(ref());
		expect(graph.nodes.filter((node) => node.kind === "agent").map((node) => node.id)).toEqual([
			"subagent:a",
			"subagent:b",
		]);
		expect(
			graph.nodes
				.filter((node) => node.kind === "agent")
				.every((node) => node.parentId === "root" && node.status === "running"),
		).toBe(true);
		expect(graph.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ from: "root", to: "subagent:a", kind: "dispatch", basis: "recorded" }),
			]),
		);
		expect(graph.lanes.map((lane) => lane.ownerId)).toEqual([session.getSessionId(), "subagent:a", "subagent:b"]);
		const ids = graph.lanes.flatMap((lane) => lane.evidence.map((entry) => entry.id));
		expect(new Set(ids).size).toBe(ids.length);
		expect(graph.source.active).toBe(true);
		expect(JSON.stringify(graph)).not.toContain("hidden reasoning");
		expect(JSON.stringify(graph)).not.toContain("secret-password");
		expect(graph.lanes[1].evidence.find((entry) => entry.kind === "tool_start")).toMatchObject({ status: "running" });
		expect(readFileSync(path, "utf8")).toBe(before);
		expect((await sources.load({ ...ref(), projectId: "p2" })).nodes.some((node) => node.id === "subagent:a")).toBe(
			false,
		);
	});

	test("keeps completed, failed and aborted branches and expands scoped original evidence", async () => {
		for (const id of ["done", "error", "aborted"]) createRun(id);
		retained!.appendEvent("done", {
			seq: 1,
			at: 10,
			kind: "tool_end",
			toolName: "bash",
			toolCallId: "c1",
			output: "x".repeat(9000),
		});
		retained!.finishRun("done", {
			status: "done",
			turns: 1,
			endedAt: "2026-01-01T00:01:00Z",
			result: "已确认权限边界",
		});
		retained!.finishRun("error", { status: "error", turns: 1, endedAt: "2026-01-01T00:01:00Z", error: "连接失败" });
		retained!.finishRun("aborted", { status: "aborted", turns: 1, endedAt: "2026-01-01T00:01:00Z" });
		const graph = await sources.load(ref());
		expect(graph.nodes.find((node) => node.id === "subagent:done")).toMatchObject({
			status: "done",
			outcomes: ["已确认权限边界"],
		});
		expect(graph.nodes.find((node) => node.id === "subagent:error")).toMatchObject({
			status: "failed",
			outcomes: ["连接失败"],
		});
		expect(graph.nodes.find((node) => node.id === "subagent:aborted")).toMatchObject({ status: "abandoned" });
		const entry = graph.lanes.flatMap((lane) => lane.evidence).find((entry) => entry.toolCallId === "c1")!;
		expect(entry).toMatchObject({ truncated: true, ownerId: "subagent:done" });
		expect(await sources.original(ref(), entry)).toEqual({ text: "x".repeat(9000), truncated: false });
		await expect(sources.original({ ...ref(), projectId: "p2" }, entry)).rejects.toThrow("不存在");
		expect(graph.source.active).toBe(false);
	});

	test("preserves upstream truncation when expanding a retained subagent result", async () => {
		createRun("large");
		retained!.finishRun("large", {
			status: "done",
			turns: 1,
			endedAt: "2026-01-01T00:01:00Z",
			result: "x".repeat(100_000),
		});
		const snapshot = await sources.load(ref());
		const entry = snapshot.lanes[1].evidence.find((entry) => entry.id === "subagent:large:result")!;
		expect(snapshot.nodes.find((node) => node.id === "subagent:large")?.evidenceIds).toContain(entry.id);
		expect(entry.truncated).toBe(true);
		const original = await sources.original(ref(), entry);
		expect(original.truncated).toBe(true);
		expect(original.text).toContain("已截断");
		expect(original.text.length).toBeGreaterThan(entry.text.length);
	});

	test("reads more than the process panel's first 100 retained runs", async () => {
		for (let index = 0; index < 105; index++) createRun(`run-${index}`);
		expect((await sources.load(ref())).nodes.filter((node) => node.kind === "agent")).toHaveLength(105);
	});

	test("analyzes child records incrementally and retains branches across a restart", async () => {
		createRun("a");
		createRun("b");
		const calls: { ownerId: string; records: { id: string; ownerId: string }[] }[] = [];
		const complete = async (input: string) => {
			calls.push(JSON.parse(input));
			return workReply(input);
		};
		const storePath = join(dir, "work-process.db");
		manager = new WorkProcesses(new WorkProcessStore(storePath), sources, complete);
		expect((await manager.detail(ref())).enabled).toBe(false);
		expect(calls).toHaveLength(0);
		await manager.control(ref(), "enable");
		await vi.waitFor(async () => expect((await manager!.detail(ref())).pending).toBe(0));
		const first = await manager.detail(ref());
		expect(first.error).toBeNull();
		expect(first.nodes.filter((node) => node.kind === "step")).toHaveLength(3);
		expect(calls.every((call) => call.records.every((entry) => entry.ownerId === call.ownerId))).toBe(true);
		expect(new Set(calls.map((call) => call.ownerId))).toEqual(
			new Set([session.getSessionId(), "subagent:a", "subagent:b"]),
		);
		const originalId = first.nodes.find((node) => node.kind === "step" && node.ownerId === "subagent:a")!.id;
		const originalStatus = first.evidence.find((entry) => entry.ownerId === "subagent:a" && entry.kind === "status")!;
		retained!.appendEvent("a", { seq: 1, at: Date.now(), kind: "text", text: "继续核实访问控制" });
		for (const id of ["a", "b"])
			retained!.finishRun(id, {
				status: "done",
				turns: 1,
				endedAt: new Date().toISOString(),
				result: "访问被正确拒绝",
			});
		await manager.control(ref(), "analyze");
		await vi.waitFor(async () => expect((await manager!.detail(ref())).pending).toBe(0));
		const updated = await manager.detail(ref());
		expect(updated.error).toBeNull();
		expect(updated.nodes.find((node) => node.id === originalId)).toBeDefined();
		expect(updated.nodes.find((node) => node.id === "subagent:a")?.status).toBe("done");
		expect(updated.evidence.find((entry) => entry.id === originalStatus.id)).toEqual(originalStatus);
		expect(await manager.original(ref(), originalStatus.id)).toEqual({ text: "状态：running", truncated: false });
		const layout = layoutWorkGraph(layoutWorkProcess(updated.nodes, new Set()), updated.edges);
		for (const agent of layout.filter(({ node }) => node.kind === "agent")) {
			const step = layout.find(({ node }) => node.kind === "step" && node.ownerId === agent.node.ownerId)!;
			expect(step.x).toBeGreaterThan(agent.x);
			expect(step.node.parentId).toBe(agent.node.id);
		}
		manager.close();
		manager = new WorkProcesses(new WorkProcessStore(storePath), sources, complete);
		expect((await manager.detail(ref())).nodes.map((node) => node.id)).toEqual(updated.nodes.map((node) => node.id));
		const callCount = calls.length;
		await manager.control(ref(), "analyze");
		await vi.waitFor(async () => expect((await manager!.detail(ref())).running).toBe(false));
		expect(calls).toHaveLength(callCount);
	});
});
