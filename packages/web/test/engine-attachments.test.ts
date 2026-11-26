import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { deleteDoctrine, listDoctrines, resolveDoctrines, saveDoctrine } from "../src/doctrines.ts";
import { buildCommanderBrief } from "../src/engine.ts";
import { EngineStore } from "../src/engine-store.ts";
import { parseTargetLines } from "../src/worker.ts";
import { engineTargetText } from "../webui/src/engine-targets.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	roots.length = 0;
});

describe("engineering target attachments", () => {
	test("text-only targets keep their existing representation", () => {
		const text = "10.0.0.1 仅测试登录\nhttps://ctf.example/challenge\n";
		expect(engineTargetText(text, [], "project-1")).toBe(text);
	});

	test.each(["", "https://ctf.example 按题面规则解题"])(
		"attachments survive parsing and restart with description %j",
		(description) => {
			const root = mkdtempSync(join(tmpdir(), "engine-attachments-"));
			roots.push(root);
			const files = [
				{
					name: "题目 1,附件.zip",
					path: "/work/项目 A/uploads/题目 1,附件.zip",
					size: 1024,
					projectId: "project-1",
				},
				{ name: "题面.png", path: "/work/项目 A/uploads/题面.png", size: 2048, projectId: "project-1" },
			];
			const targets = parseTargetLines(engineTargetText(description, files, "project-1"));
			expect(
				targets.filter((target) => target.target === "附件").map((target) => JSON.parse(target.note ?? "")),
			).toEqual(files.map(({ name, path, size }) => ({ name, path, size })));
			const dbPath = join(root, "engines.db");
			const store = new EngineStore(dbPath);
			let engineId: string;
			try {
				engineId = store.createEngine({
					projectId: "project-1",
					projectName: "CTF",
					name: "解题赛",
					targets,
					doctrines: ["ctf-jeopardy"],
					limits: { concurrency: 2, roundLimit: 5, tokenLimit: null, timeLimitMin: null, maxRetries: 1 },
					gateMode: "auto",
				}).id;
			} finally {
				store.close();
			}
			const reopened = new EngineStore(dbPath);
			try {
				const saved = reopened.getEngine(engineId);
				if (!saved) throw new Error("Engine was not persisted");
				expect(saved.targets).toEqual(targets);
				for (const kind of ["initial", "resume"] as const) {
					const brief = buildCommanderBrief(saved, resolveDoctrines(root, saved.doctrines), [], kind, {
						bash: false,
						read: false,
					});
					for (const file of files) expect(brief).toContain(file.path);
					expect(brief).toContain("先派发附件分析任务");
					expect(brief).toContain("CTF 竞赛-夺旗");
					if (description) expect(brief).toContain("按题面规则解题");
				}
			} finally {
				reopened.close();
			}
		},
	);

	test("an attachment from a different project is refused", () => {
		expect(() =>
			engineTargetText(
				"",
				[{ name: "challenge.zip", path: "/other/uploads/challenge.zip", size: 1, projectId: "other" }],
				"project-1",
			),
		).toThrow();
	});
});

test.each([
	{ id: "ctf-jeopardy", name: "CTF 竞赛-夺旗" },
	{ id: "code-audit", name: "代码审计" },
])("$name is a protected built-in alongside custom command doctrines", ({ id, name }) => {
	const root = mkdtempSync(join(tmpdir(), "engine-doctrines-"));
	roots.push(root);
	const builtin = listDoctrines(root).find((doctrine) => doctrine.id === id);
	expect(builtin).toMatchObject({ name, builtin: true });
	expect(saveDoctrine(root, { id, name: "override", text: "override" }).error).toBeTruthy();
	expect(deleteDoctrine(root, id).ok).toBe(false);
	const custom = saveDoctrine(root, { name: "赛题补充", text: "flag 格式为 flag{...}" }).doctrine;
	if (!custom) throw new Error("Custom doctrine was not saved");
	expect(resolveDoctrines(root, [id, custom.id])).toEqual([builtin, custom]);
	expect(listDoctrines(root).find((doctrine) => doctrine.id === id)).toEqual(builtin);
});

test("a code audit engagement retains its doctrine and injects the audit brief on resume", () => {
	const root = mkdtempSync(join(tmpdir(), "engine-code-audit-"));
	roots.push(root);
	const dbPath = join(root, "engines.db");
	const store = new EngineStore(dbPath);
	let id: string;
	try {
		id = store.createEngine({
			projectId: "audit-project",
			projectName: "Source audit",
			name: "Source audit",
			targets: parseTargetLines("/work/source 审计代码中的高危、严重漏洞"),
			doctrines: ["code-audit"],
			limits: { concurrency: 2, roundLimit: 5, tokenLimit: null, timeLimitMin: null, maxRetries: 1 },
			gateMode: "auto",
		}).id;
	} finally {
		store.close();
	}
	const reopened = new EngineStore(dbPath);
	try {
		const engine = reopened.getEngine(id);
		if (!engine) throw new Error("Engine was not persisted");
		expect(engine.doctrines).toEqual(["code-audit"]);
		const brief = buildCommanderBrief(engine, resolveDoctrines(root, engine.doctrines), [], "resume", {
			bash: false,
			read: false,
		});
		expect(brief).toContain("代码审计");
		expect(brief).toContain("你的目标是源代码审计");
		expect(brief).toContain("第一优先级为远程命令执行 RCE");
		// The workflow starts from a sink scan and from whether the project already
		// has a business model: absent, one is dispatched; present, it is used.
		expect(brief).toContain("graudit");
		expect(brief).toContain("api_model_read");
		expect(brief).toContain("做业务建模");
		expect(brief).toContain("不重复做");
		expect(brief).toContain("/work/source");
		expect(brief).not.toContain("CTF 竞赛-夺旗");
	} finally {
		reopened.close();
	}
});
