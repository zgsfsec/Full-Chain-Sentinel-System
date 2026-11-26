/**
 * Unit tests for preset agents: id generation, validation, the metadata/body
 * split, enable/disable, deletion, and export/import.
 *
 * The import tests carry the design decision they were written for: importing
 * never overwrites what is already on disk, because the operator's own copy is
 * the more valuable one and a silent overwrite leaves no trace they could
 * notice.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	briefDescription,
	deletePreset,
	ensureBuiltinPresets,
	estimateTokens,
	exportPresets,
	importPresets,
	isPresetId,
	listEnabledPresets,
	listPresets,
	MAX_PRESET_NAME_CHARS,
	MAX_PRESET_PLACEHOLDER_CHARS,
	PRESETS_EXPORT_FORMAT,
	PRESETS_EXPORT_VERSION,
	presetBriefLines,
	presetTextPath,
	presetTokenLevel,
	presetViews,
	readPresetText,
	savePreset,
	setPresetEnabled,
} from "../src/presets.ts";
import type { SentinelPreset } from "../src/protocol.ts";

let root = "";

function freshAgentDir(): string {
	root = mkdtempSync(join(tmpdir(), "sentinel-presets-"));
	return root;
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

describe("id generation", () => {
	test("slugs an ASCII name", () => {
		const dir = freshAgentDir();
		expect(savePreset(dir, { name: "Web Recon", text: "x" }).preset?.id).toBe("web-recon");
	});

	test("falls back to a generated id when the name has no ASCII", () => {
		const dir = freshAgentDir();
		const preset = savePreset(dir, { name: "内网横向", text: "x" }).preset;
		expect(preset?.id).toMatch(/^preset-[a-z0-9]+$/);
	});

	test("reusing a name gets a suffixed id instead of clobbering", () => {
		const dir = freshAgentDir();
		savePreset(dir, { name: "Web Recon", text: "first" });
		const second = savePreset(dir, { name: "Web Recon", text: "second" }).preset;
		expect(second?.id).toBe("web-recon-2");
		expect(readPresetText(dir, "web-recon")?.trim()).toBe("first");
	});

	test("rejects ids that could escape the presets directory", () => {
		expect(isPresetId("web-recon")).toBe(true);
		expect(isPresetId("../evil")).toBe(false);
		expect(isPresetId("Web")).toBe(false);
		expect(isPresetId("")).toBe(false);
		expect(isPresetId(7)).toBe(false);
	});
});

describe("savePreset", () => {
	test("writes metadata to presets.json and the body to presets/<id>.md", () => {
		const dir = freshAgentDir();
		const preset = savePreset(dir, {
			name: "Web 侦察",
			description: "先指纹后目录",
			tags: ["web", "web", " 外网 "],
			text: "你是 Web 侦察专家。",
		}).preset;
		expect(preset).toBeDefined();
		expect(preset?.enabled).toBe(true);
		expect(preset?.tags).toEqual(["web", "外网"]);
		expect(existsSync(presetTextPath(dir, preset?.id ?? ""))).toBe(true);
		expect(readPresetText(dir, preset?.id ?? "")?.trim()).toBe("你是 Web 侦察专家。");
	});

	test("updating keeps the id and creation time", () => {
		const dir = freshAgentDir();
		const created = savePreset(dir, { name: "Web Recon", text: "old" }).preset;
		const updated = savePreset(dir, { id: created?.id, name: "Web Recon", text: "new" }).preset;
		expect(updated?.id).toBe(created?.id);
		expect(updated?.createdAt).toBe(created?.createdAt);
		expect(updated?.updatedAt).toBeGreaterThanOrEqual(created?.createdAt ?? 0);
		expect(readPresetText(dir, created?.id ?? "")?.trim()).toBe("new");
	});

	test("rejects an update to a preset that does not exist", () => {
		const dir = freshAgentDir();
		expect(savePreset(dir, { id: "nope", name: "x", text: "y" }).error).toBe("该预设不存在");
	});

	test("rejects empty and over-long fields", () => {
		const dir = freshAgentDir();
		expect(savePreset(dir, { name: "  ", text: "y" }).error).toContain("名称");
		expect(savePreset(dir, { name: "a".repeat(MAX_PRESET_NAME_CHARS + 1), text: "y" }).error).toContain("过长");
		expect(savePreset(dir, { name: "x", description: "d".repeat(201), text: "y" }).error).toContain("描述");
		expect(savePreset(dir, { name: "x", text: "  " }).error).toContain("内容");
		expect(
			savePreset(dir, { name: "x", tags: Array.from({ length: 13 }, (_, i) => `t${i}`), text: "y" }).error,
		).toContain("标签过多");
		expect(savePreset(dir, { name: "x", tags: ["t".repeat(25)], text: "y" }).error).toContain("标签过长");
	});

	test("a stored entry without the enabled flag stays enabled", () => {
		const dir = freshAgentDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "presets.json"),
			JSON.stringify({ presets: [{ id: "legacy", name: "Legacy", description: "", tags: [], createdAt: 1 }] }),
		);
		expect(listPresets(dir)[0]?.enabled).toBe(true);
	});

	test("stores the composer hint, and empty means the default text", () => {
		const dir = freshAgentDir();
		const hinted = savePreset(dir, {
			name: "Web Recon",
			placeholder: "  说说这次要看的目标  ",
			text: "你是侦察专家。",
		}).preset;
		expect(hinted?.placeholder).toBe("说说这次要看的目标");
		expect(savePreset(dir, { name: "AD Enum", text: "x" }).preset?.placeholder).toBe("");
		// The hint is metadata for the operator: it must not leak into the prompt body.
		expect(readPresetText(dir, hinted?.id ?? "")?.trim()).toBe("你是侦察专家。");
	});

	test("rejects an over-long composer hint", () => {
		const dir = freshAgentDir();
		const long = "p".repeat(MAX_PRESET_PLACEHOLDER_CHARS + 1);
		expect(savePreset(dir, { name: "x", placeholder: long, text: "y" }).error).toContain("输入框提示");
	});

	test("a stored entry written before the hint existed reads as empty", () => {
		const dir = freshAgentDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "presets.json"),
			JSON.stringify({ presets: [{ id: "legacy", name: "Legacy", description: "", tags: [], createdAt: 1 }] }),
		);
		expect(listPresets(dir)[0]?.placeholder).toBe("");
	});
});

describe("reads", () => {
	test("a missing or corrupt file reads as an empty list", () => {
		const dir = freshAgentDir();
		expect(listPresets(dir)).toEqual([]);
		writeFileSync(join(dir, "presets.json"), "{ not json");
		expect(listPresets(dir)).toEqual([]);
		writeFileSync(join(dir, "presets.json"), JSON.stringify({ presets: "nope" }));
		expect(listPresets(dir)).toEqual([]);
	});

	test("an entry with an unusable id is dropped, not trusted", () => {
		const dir = freshAgentDir();
		writeFileSync(
			join(dir, "presets.json"),
			JSON.stringify({
				presets: [
					{ id: "../evil", name: "Evil" },
					{ id: "ok", name: "Ok" },
				],
			}),
		);
		expect(listPresets(dir).map((preset) => preset.id)).toEqual(["ok"]);
	});

	test("a preset whose body file is gone is reported as missing", () => {
		const dir = freshAgentDir();
		const preset = savePreset(dir, { name: "Web Recon", text: "body" }).preset;
		rmSync(presetTextPath(dir, preset?.id ?? ""));
		const view = presetViews(dir)[0];
		expect(view?.textMissing).toBe(true);
		expect(view?.text).toBe("");
		expect(readPresetText(dir, preset?.id ?? "")).toBeNull();
	});

	test("presetViews loads the body and its token estimate", () => {
		const dir = freshAgentDir();
		savePreset(dir, { name: "Web Recon", text: "你是侦察专家。" });
		const view = presetViews(dir)[0];
		expect(view?.textMissing).toBe(false);
		expect(view?.tokens).toBeGreaterThan(0);
	});
});

describe("enabled", () => {
	test("only enabled presets are offered", () => {
		const dir = freshAgentDir();
		const first = savePreset(dir, { name: "Web Recon", text: "a" }).preset;
		savePreset(dir, { name: "AD Enum", text: "b" });
		expect(listEnabledPresets(dir)).toHaveLength(2);
		expect(setPresetEnabled(dir, first?.id ?? "", false).preset?.enabled).toBe(false);
		expect(listEnabledPresets(dir).map((preset) => preset.id)).toEqual(["ad-enum"]);
		expect(listPresets(dir)).toHaveLength(2);
	});

	test("enabling a preset that does not exist fails", () => {
		expect(setPresetEnabled(freshAgentDir(), "nope", true).error).toBe("该预设不存在");
	});
});

describe("deletePreset", () => {
	test("removes both the metadata entry and the body", () => {
		const dir = freshAgentDir();
		const preset = savePreset(dir, { name: "Web Recon", text: "a" }).preset;
		expect(deletePreset(dir, preset?.id ?? "").ok).toBe(true);
		expect(listPresets(dir)).toEqual([]);
		expect(existsSync(presetTextPath(dir, preset?.id ?? ""))).toBe(false);
	});

	test("deleting a preset that does not exist fails", () => {
		expect(deletePreset(freshAgentDir(), "nope").ok).toBe(false);
	});
});

describe("export and import", () => {
	test("round-trips metadata and body", () => {
		const source = freshAgentDir();
		savePreset(source, { name: "Web Recon", description: "desc", tags: ["web"], text: "你是侦察专家。" });
		const exported = exportPresets(source);
		expect(exported.format).toBe(PRESETS_EXPORT_FORMAT);
		expect(exported.version).toBe(PRESETS_EXPORT_VERSION);

		const target = freshAgentDir();
		const result = importPresets(target, exported);
		expect(result.error).toBeUndefined();
		expect(result.skipped).toEqual([]);
		expect(result.imported).toHaveLength(1);
		expect(readPresetText(target, result.imported[0]?.id ?? "")?.trim()).toBe("你是侦察专家。");
	});

	test("export can be limited to selected ids", () => {
		const dir = freshAgentDir();
		savePreset(dir, { name: "Web Recon", text: "a" });
		savePreset(dir, { name: "AD Enum", text: "b" });
		const exported = exportPresets(dir, ["ad-enum"]);
		expect(exported.presets.map((preset) => preset.id)).toEqual(["ad-enum"]);
	});

	test("round-trips the composer hint, and an older file imports without one", () => {
		const source = freshAgentDir();
		savePreset(source, { name: "Web Recon", placeholder: "先指纹再目录", text: "x" });
		const target = freshAgentDir();
		const result = importPresets(target, exportPresets(source));
		expect(result.imported[0]?.placeholder).toBe("先指纹再目录");

		// A file exported before the hint existed carries no field at all.
		const older = freshAgentDir();
		const legacy = importPresets(older, {
			format: PRESETS_EXPORT_FORMAT,
			version: PRESETS_EXPORT_VERSION,
			presets: [{ name: "Old", text: "x" }],
		});
		expect(legacy.imported[0]?.placeholder).toBe("");
	});

	test("importing a second time adds a copy instead of overwriting", () => {
		const source = freshAgentDir();
		savePreset(source, { name: "Web Recon", text: "imported" });
		const exported = exportPresets(source);

		const target = freshAgentDir();
		savePreset(target, { name: "Web Recon", text: "mine" });
		const result = importPresets(target, exported);

		expect(result.imported[0]?.id).toBe("web-recon-2");
		expect(readPresetText(target, "web-recon")?.trim()).toBe("mine");
		expect(readPresetText(target, "web-recon-2")?.trim()).toBe("imported");
	});

	test("skips unusable entries and reports why", () => {
		const dir = freshAgentDir();
		const result = importPresets(dir, {
			format: PRESETS_EXPORT_FORMAT,
			version: PRESETS_EXPORT_VERSION,
			presets: [{ name: "", text: "x" }, "junk", { name: "No body", text: "" }],
		});
		expect(result.imported).toEqual([]);
		expect(result.skipped).toHaveLength(3);
		expect(result.skipped[0]?.reason).toContain("名称");
		expect(result.skipped[1]?.reason).toContain("对象");
		expect(result.skipped[2]?.reason).toContain("内容");
	});

	test("refuses a file that is not a preset export", () => {
		const dir = freshAgentDir();
		expect(importPresets(dir, null).error).toContain("JSON");
		expect(importPresets(dir, { format: "other", version: 1, presets: [] }).error).toContain("预设导出文件");
		expect(importPresets(dir, { format: PRESETS_EXPORT_FORMAT, version: 99, presets: [] }).error).toContain("版本");
		expect(importPresets(dir, { format: PRESETS_EXPORT_FORMAT, version: 1 }).error).toContain("预设列表");
	});
});

describe("estimateTokens", () => {
	test("counts CJK per character and the rest per four", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("你好")).toBe(2);
		expect(estimateTokens("hello")).toBe(2);
		expect(estimateTokens("你好world")).toBe(4);
	});

	test("colours against the two thresholds", () => {
		expect(presetTokenLevel(0)).toBe("ok");
		expect(presetTokenLevel(1999)).toBe("ok");
		expect(presetTokenLevel(2000)).toBe("warn");
		expect(presetTokenLevel(7999)).toBe("warn");
		expect(presetTokenLevel(8000)).toBe("danger");
	});
});

describe("commander brief", () => {
	const preset = (over: Partial<SentinelPreset>): SentinelPreset => ({
		id: "web-recon",
		name: "Web 侦察",
		description: "先指纹后目录",
		tags: ["web"],
		placeholder: "",
		enabled: true,
		createdAt: 1,
		updatedAt: 1,
		...over,
	});

	test("truncates a description to the brief width", () => {
		expect(briefDescription("a".repeat(80))).toHaveLength(80);
		expect(briefDescription("a".repeat(81))).toHaveLength(80);
		expect(briefDescription("a".repeat(81)).endsWith("…")).toBe(true);
	});

	test("lists id, name, description and tags", () => {
		expect(presetBriefLines([preset({})])).toEqual(["- web-recon · Web 侦察 · 先指纹后目录 · [web]"]);
	});

	test("drops disabled presets, which the commander could not dispatch anyway", () => {
		expect(presetBriefLines([preset({ enabled: false })])).toEqual([]);
	});

	test("keeps at most five tags", () => {
		const line = presetBriefLines([preset({ tags: ["a", "b", "c", "d", "e", "f"] })])[0];
		expect(line).toContain("[a、b、c、d、e]");
		expect(line).not.toContain("f");
	});

	test("caps the list and names the overflow", () => {
		const many = Array.from({ length: 32 }, (_, index) =>
			preset({ id: `preset-${index}`, name: `预设 ${index}`, tags: [] }),
		);
		const lines = presetBriefLines(many);
		expect(lines).toHaveLength(31);
		expect(lines[30]).toContain("另有 2 条预设未列出");
	});
});

test("a fresh console is seeded with the built-in presets, including the incident-response agent", () => {
	const dir = freshAgentDir();
	ensureBuiltinPresets(dir);
	const ir = listPresets(dir).find((preset) => preset.id === "incident-response");
	expect(ir?.name).toBe("应急响应");
	expect(ir?.enabled).toBe(true);
	const body = readPresetText(dir, "incident-response");
	expect(body).toContain("只排查");
	expect(body).toContain("生产环境");
	// The preset is context, not capability: it may not promise tools the
	// permission switches do not grant.
	expect(body).not.toMatch(/你可以使用|授权你调用/);
});

test("the recon preset is seeded and hard-requires asset-library reporting", () => {
	const dir = freshAgentDir();
	ensureBuiltinPresets(dir);
	const recon = listPresets(dir).find((preset) => preset.id === "recon");
	expect(recon?.name).toBe("信息收集");
	const body = readPresetText(dir, "recon");
	expect(body).toContain("asset_report");
	expect(body).toContain("asset_note");
	// Reporting is the deliverable, not an afterthought.
	expect(body).toContain("硬性交付");
	// Same rule as every preset: context only, no capability promises.
	expect(body).not.toMatch(/你可以使用|授权你调用/);
});

test("source audit is available by default with an upload hint and evidence-based reporting", () => {
	const dir = freshAgentDir();
	ensureBuiltinPresets(dir);
	const audit = presetViews(dir).find((preset) => preset.id === "source-code-audit");
	expect(audit?.name).toBe("源代码审计 Agent");
	expect(listEnabledPresets(dir).some((preset) => preset.id === audit?.id)).toBe(true);
	expect(audit?.placeholder).toBe(
		"上传源代码文件或压缩包，即可开始审计；代码包较大时，可先剔除图片、音视频等静态资源，保留源码、配置及依赖清单。",
	);
	expect(audit?.placeholder.length).toBeLessThanOrEqual(MAX_PRESET_PLACEHOLDER_CHARS);
	expect(audit?.textMissing).toBe(false);
	expect(audit?.text).toContain("优先挖掘可能导致远程代码执行（RCE）");
	expect(audit?.text).toContain("其次审计 OWASP Top 10");
	expect(audit?.text).toContain("跨文件、跨函数追踪数据流");
	expect(audit?.text).toContain("待确认的问题单独列为待核实项");
	expect(audit?.text).toContain("不得编造发现");
	// A large project is recorded as models first; the preset is what makes that the operator's request.
	expect(audit?.text).toContain("做一次业务建模里读源码的部分");
	expect(audit?.text).toContain("source_model_submit");
	expect(audit?.text).toContain("api_model_done");
});

test("an existing console gains the audit preset once and retains the operator's edits", () => {
	const dir = freshAgentDir();
	savePreset(dir, { name: "已有自定义预设", text: "保留原内容" });
	ensureBuiltinPresets(dir);
	const result = savePreset(dir, {
		id: "source-code-audit",
		name: "源代码审计 Agent",
		placeholder: "自定义提示",
		text: "自定义审计要求",
		enabled: false,
	});
	expect(result.error).toBeUndefined();
	ensureBuiltinPresets(dir);
	const presets = presetViews(dir);
	expect(presets.filter((preset) => preset.id === "source-code-audit")).toHaveLength(1);
	expect(presets.find((preset) => preset.id === "source-code-audit")).toMatchObject({
		placeholder: "自定义提示",
		text: "自定义审计要求\n",
		enabled: false,
	});
	expect(presets.find((preset) => preset.name === "已有自定义预设")?.text).toBe("保留原内容\n");
});
