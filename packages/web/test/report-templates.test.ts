import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildCommanderBrief, EngineManager } from "../src/engine.ts";
import type { SentinelEngineCreateInput } from "../src/protocol.ts";
import { handleReportApi } from "../src/report-api.ts";
import { REPORT_TEMPLATE_MAX_BYTES, ReportTemplateStore } from "../src/report-templates.ts";
import type { ReportTemplate, ReportTemplateList } from "../src/report-types.ts";
import { ReportStore } from "../src/reports.ts";

let root: string;
let store: ReportTemplateStore;
let server: Server | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-report-templates-"));
	store = new ReportTemplateStore(root);
});

afterEach(async () => {
	if (server) {
		const closing = server;
		server = undefined;
		await new Promise<void>((resolve) => closing.close(() => resolve()));
	}
	store.close();
	rmSync(root, { recursive: true, force: true });
});

test("global templates start empty, persist across restarts and have independent project defaults", () => {
	expect(store.list()).toEqual([]);
	const first = store.create(" 完整报告 ", "# 结论\n\n## 证据");
	const second = store.create("简报", "# 摘要");
	store.setDefault("p1", first.id);
	store.setDefault("p2", second.id);
	store.close();
	store = new ReportTemplateStore(root);
	expect(store.list()).toHaveLength(2);
	expect(store.list()[0]).not.toHaveProperty("markdown");
	expect(store.resolve("p1")).toMatchObject({ name: "完整报告", markdown: first.markdown });
	expect(store.resolve("p2")).toMatchObject({ id: second.id });
	expect(store.resolve("p3")).toBeNull();
	expect(store.resolve("p1", null)).toBeNull();
	expect(store.resolve("p1", second.id)?.id).toBe(second.id);
});

test("optimistic edits prevent lost updates and deletion clears defaults while captured snapshots survive", () => {
	const original = store.create("模板", "## 原始章节");
	store.setDefault("p1", original.id);
	store.setDefault("p2", original.id);
	const snapshot = store.resolve("p1");
	const updated = store.update(original.id, original.revision, "修改", "## 新章节")!;
	expect(updated.revision).not.toBe(original.revision);
	expect(store.update(original.id, original.revision, "过时修改", "## 过时")).toBeUndefined();
	expect(store.get(original.id)?.markdown).toBe("## 新章节");
	expect(snapshot?.markdown).toBe("## 原始章节");
	expect(store.delete(original.id)).toBe(true);
	expect(store.defaultId("p1")).toBeNull();
	expect(store.defaultId("p2")).toBeNull();
	expect(snapshot?.markdown).toBe("## 原始章节");
	expect(() => store.resolve("p1", original.id)).toThrow("不存在");
	expect(() => store.setDefault("p1", original.id)).toThrow("不存在");
});

test("empty templates and oversized UTF-8 content are refused without storing a row", () => {
	for (const name of ["", " ", "a\nb", "a".repeat(121)]) expect(() => store.create(name, "# 正文")).toThrow();
	expect(() => store.create("标题", " \n ")).toThrow();
	expect(() => store.create("标题", "中".repeat(Math.ceil(REPORT_TEMPLATE_MAX_BYTES / 3)))).toThrow("64 KB");
	expect(store.list()).toEqual([]);
});

test("template API supports global CRUD and project defaults, rejecting conflicts, malformed bodies and expired authorization", async () => {
	const reports = new ReportStore(join(root, "reports.db"));
	let authorized = true;
	server = createServer((request, response) => {
		void handleReportApi(
			request,
			response,
			reports,
			(id) => ["p1", "p2"].includes(id),
			() => authorized,
		);
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No HTTP address");
	const base = `http://127.0.0.1:${address.port}/api/reports/templates`;
	const request = (suffix: string, method: string, body: unknown) =>
		fetch(`${base}${suffix}`, {
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	try {
		expect(await (await fetch(base)).json()).toEqual({ items: [], defaultTemplateId: null });
		const created = await request("", "POST", { name: "全局模板", markdown: "## 总结" });
		expect(created.status).toBe(201);
		const template = (await created.json()) as ReportTemplate;
		expect((await request("/default?projectId=p1", "PUT", { templateId: template.id })).status).toBe(200);
		const list = (await (await fetch(`${base}?projectId=p1`)).json()) as ReportTemplateList;
		expect(list.defaultTemplateId).toBe(template.id);
		expect(list.items[0]).not.toHaveProperty("markdown");
		const otherProject = (await (await fetch(`${base}?projectId=p2`)).json()) as ReportTemplateList;
		expect(otherProject.items).toHaveLength(1);
		expect(
			(await request(`/${template.id}`, "PUT", { name: "更新", markdown: "## 更新", revision: template.revision }))
				.status,
		).toBe(200);
		expect((await request(`/${template.id}`, "PUT", { ...template, markdown: "## 过时" })).status).toBe(409);
		expect((await request("/default?projectId=missing", "PUT", { templateId: template.id })).status).toBe(409);
		expect((await request("", "POST", { name: "坏模板", markdown: 42 })).status).toBe(400);
		expect(
			(await request("", "POST", { name: "过大模板", markdown: "a".repeat(REPORT_TEMPLATE_MAX_BYTES + 1) })).status,
		).toBe(400);
		expect(
			(await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status,
		).toBe(400);
		expect((await fetch(base, { method: "POST", body: "{}" })).status).toBe(415);
		authorized = false;
		expect((await request("", "POST", { name: "禁止", markdown: "# 禁止" })).status).toBe(401);
		expect((await fetch(base)).status).toBe(401);
		authorized = true;
		expect((await request(`/${template.id}`, "DELETE", {})).status).toBe(200);
		expect((await fetch(`${base}/${template.id}`)).status).toBe(404);
		expect(store.defaultId("p1")).toBeNull();
	} finally {
		reports.close();
	}
});

test("engineering creation freezes the selected or default template and restores it without applying future template changes", async () => {
	const template = store.create("工程报告", "## 工程结论\n\n## 原始证据");
	store.setDefault("p1", template.id);
	const hooks = { onChange: () => {}, onCommanderEvent: () => {}, onTaskEvent: () => {} };
	const acquire = async (): Promise<never> => {
		throw new Error("No model or worker expected");
	};
	let manager = new EngineManager(root, hooks, acquire);
	const input: SentinelEngineCreateInput = {
		name: "工程",
		targets: "https://fixture.invalid",
		doctrines: ["attack-defense-web"],
		limits: { concurrency: 1, roundLimit: 1, maxRetries: 0, tokenLimit: null, timeLimitMin: null },
		schedule: { timezone: "UTC", startAt: Date.now() + 3600000 },
	};
	const project = { id: "p1", name: "项目", cwd: root };
	try {
		const engine = await manager.createEngine(project, input);
		expect(engine.reportTemplate?.markdown).toBe(template.markdown);
		const free = await manager.createEngine(project, { ...input, reportTemplateId: null });
		expect(free.reportTemplate).toBeNull();
		store.update(template.id, template.revision, "新版", "## 新结构");
		store.delete(template.id);
		manager.dispose();
		manager = new EngineManager(root, hooks, acquire);
		const restored = manager.getEngine(engine.id)!;
		expect(restored.reportTemplate?.markdown).toBe(template.markdown);
		const brief = buildCommanderBrief(restored, [], [], "resume", { bash: false, read: false });
		expect(brief).toContain(template.markdown);
		expect(brief).toContain("保留章节标题及顺序");
		expect(brief).toContain("不改变子任务报告格式");
		expect(
			buildCommanderBrief(manager.getEngine(free.id)!, [], [], "resume", { bash: false, read: false }),
		).not.toContain("<report-template>");
		await expect(manager.createEngine(project, { ...input, reportTemplateId: template.id })).rejects.toThrow(
			"不存在",
		);
	} finally {
		manager.dispose();
	}
});
