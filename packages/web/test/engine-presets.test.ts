/**
 * Unit tests for preset handling on the engineering side: which presets the
 * commander may choose from, what happens when it names one it cannot use, and
 * how the task board shows the choice.
 *
 * The refusals are the important half. A dispatch that names an unusable preset
 * must not create a task: the board would show a preset name the worker never
 * ran as, and the commander would conclude the preset worked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { formatTaskBoard } from "../src/commander-tools.ts";
import {
	allowedPresets,
	buildCommanderBrief,
	normalizePresetIds,
	presetChoiceHint,
	resolveDispatchPreset,
} from "../src/engine.ts";
import { savePreset, setPresetEnabled } from "../src/presets.ts";
import type { SentinelEngine, SentinelEngineTask } from "../src/protocol.ts";

let root = "";

function freshAgentDir(): string {
	root = mkdtempSync(join(tmpdir(), "sentinel-engine-presets-"));
	return root;
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

/** Presets are optional unless a test says otherwise, which is the engine default. */
const engine = (presetIds: string[], presetOptional = true) => ({ presetIds, presetOptional });

function task(over: Partial<SentinelEngineTask>): SentinelEngineTask {
	return {
		id: "task-1",
		engineId: "engine-1",
		title: "任务",
		objective: "o",
		target: "10.0.0.1",
		workspace: "w",
		status: "queued",
		attempt: 1,
		criteria: [],
		roundLimit: 3,
		presetId: null,
		presetName: null,
		pendingContinue: null,
		sessionId: null,
		startedAt: null,
		endedAt: null,
		summary: null,
		error: null,
		usage: null,
		vulns: 0,
		autoResume: false,
		...over,
	};
}

describe("allowedPresets", () => {
	test("an empty whitelist means no restriction, not no choice", () => {
		const dir = freshAgentDir();
		savePreset(dir, { name: "Web Recon", text: "a" });
		savePreset(dir, { name: "AD Enum", text: "b" });
		expect(allowedPresets(dir, engine([])).map((preset) => preset.id)).toEqual(["web-recon", "ad-enum"]);
	});

	test("a whitelist narrows the list and keeps its order out of the result", () => {
		const dir = freshAgentDir();
		savePreset(dir, { name: "Web Recon", text: "a" });
		savePreset(dir, { name: "AD Enum", text: "b" });
		savePreset(dir, { name: "DB Audit", text: "c" });
		expect(allowedPresets(dir, engine(["db-audit", "web-recon"])).map((preset) => preset.id)).toEqual([
			"web-recon",
			"db-audit",
		]);
	});

	test("a disabled preset is never offered, whitelisted or not", () => {
		const dir = freshAgentDir();
		savePreset(dir, { name: "Web Recon", text: "a" });
		const ad = savePreset(dir, { name: "AD Enum", text: "b" }).preset;
		setPresetEnabled(dir, ad?.id ?? "", false);
		expect(allowedPresets(dir, engine([])).map((preset) => preset.id)).toEqual(["web-recon"]);
		expect(allowedPresets(dir, engine(["ad-enum"])).map((preset) => preset.id)).toEqual([]);
	});
});

describe("resolveDispatchPreset", () => {
	test("no preset means the default agent", () => {
		const dir = freshAgentDir();
		expect(resolveDispatchPreset(dir, engine([]), null)).toEqual({ preset: null });
	});

	test("an engine that requires a preset refuses a dispatch without one", () => {
		const dir = freshAgentDir();
		savePreset(dir, { name: "Web Recon", text: "a" });
		const result = resolveDispatchPreset(dir, engine([], false), null);
		expect(result.preset).toBeNull();
		expect(result.error).toContain("要求每个任务都指定预设 Agent");
		expect(result.error).toContain("web-recon（Web Recon）");
	});

	test("requiring a preset still accepts one that is allowed", () => {
		const dir = freshAgentDir();
		savePreset(dir, { name: "Web Recon", text: "a" });
		expect(resolveDispatchPreset(dir, engine(["web-recon"], false), "web-recon").preset?.name).toBe("Web Recon");
	});

	test("requiring a preset with nothing available says so instead of offering the default", () => {
		const dir = freshAgentDir();
		const hint = presetChoiceHint(dir, engine([], false));
		expect(hint).toContain("没有可用预设");
		expect(hint).not.toContain("省略 preset 参数");
	});

	test("an existing enabled preset is accepted", () => {
		const dir = freshAgentDir();
		savePreset(dir, { name: "Web Recon", description: "d", text: "a" });
		expect(resolveDispatchPreset(dir, engine([]), "web-recon").preset?.name).toBe("Web Recon");
	});

	test("an unknown id is refused with the available list", () => {
		const dir = freshAgentDir();
		savePreset(dir, { name: "Web Recon", text: "a" });
		const result = resolveDispatchPreset(dir, engine([]), "does-not-exist");
		expect(result.preset).toBeNull();
		expect(result.error).toContain("不存在");
		expect(result.error).toContain("web-recon（Web Recon）");
	});

	test("a disabled preset is refused even when whitelisted", () => {
		const dir = freshAgentDir();
		const preset = savePreset(dir, { name: "Web Recon", text: "a" }).preset;
		setPresetEnabled(dir, preset?.id ?? "", false);
		const result = resolveDispatchPreset(dir, engine(["web-recon"]), "web-recon");
		expect(result.error).toContain("已停用");
	});

	test("a preset outside the whitelist is refused, and the hint says what is allowed", () => {
		const dir = freshAgentDir();
		savePreset(dir, { name: "Web Recon", text: "a" });
		savePreset(dir, { name: "AD Enum", text: "b" });
		const result = resolveDispatchPreset(dir, engine(["ad-enum"]), "web-recon");
		expect(result.preset).toBeNull();
		expect(result.error).toContain("白名单");
		expect(result.error).toContain("ad-enum（AD Enum）");
		expect(result.error).not.toContain("web-recon（");
	});

	test("an empty preset library is explained instead of leaving a bare refusal", () => {
		const dir = freshAgentDir();
		expect(presetChoiceHint(dir, engine([]))).toContain("未启用任何预设");
		expect(resolveDispatchPreset(dir, engine([]), "ghost").error).toContain("默认 Agent");
	});
});

describe("normalizePresetIds", () => {
	test("drops ids that no longer resolve and de-duplicates", () => {
		const dir = freshAgentDir();
		savePreset(dir, { name: "Web Recon", text: "a" });
		expect(normalizePresetIds(dir, ["web-recon", "web-recon", "gone"])).toEqual(["web-recon"]);
	});

	test("an absent list stays empty", () => {
		expect(normalizePresetIds(freshAgentDir(), undefined)).toEqual([]);
		expect(normalizePresetIds(freshAgentDir(), [])).toEqual([]);
	});

	// An empty whitelist means "no restriction", so dropping a preset that merely
	// happens to be off would widen what the commander may use. Keeping the id
	// holds the restriction; the refusal happens per dispatch instead.
	test("keeps a whitelisted preset that exists but is disabled", () => {
		const dir = freshAgentDir();
		const preset = savePreset(dir, { name: "Web Recon", text: "a" }).preset;
		setPresetEnabled(dir, preset?.id ?? "", false);
		expect(normalizePresetIds(dir, ["web-recon"])).toEqual(["web-recon"]);
		expect(allowedPresets(dir, engine(["web-recon"]))).toEqual([]);
		expect(resolveDispatchPreset(dir, engine(["web-recon"]), "web-recon").error).toContain("已停用");
	});
});

describe("buildCommanderBrief", () => {
	const engineFixture = (presetOptional: boolean): SentinelEngine => ({
		id: "engine-1",
		projectId: "p1",
		projectName: "P1",
		name: "工程",
		status: "running",
		pauseNote: null,
		targets: [{ target: "10.0.0.1" }],
		doctrines: ["standard"],
		presetIds: [],
		presetOptional,
		limits: { concurrency: 1, roundLimit: 3, tokenLimit: null, timeLimitMin: null, maxRetries: 1 },
		gateMode: "auto",
		createdAt: 1,
		startedAt: 1,
		endedAt: null,
		schedule: null,
		report: null,
		tasks: [],
	});
	const brief = (presetOptional: boolean, presets: Parameters<typeof buildCommanderBrief>[2]) =>
		buildCommanderBrief(
			engineFixture(presetOptional),
			[{ id: "standard", name: "标准", text: "只做授权范围内的测试", builtin: true }],
			presets,
			"initial",
			{ bash: false, read: false },
		);

	test("leaves the default agent as an option when presets are optional", () => {
		const text = brief(true, []);
		expect(text).toContain("省略 preset，用默认 Agent");
		expect(text).not.toContain("省略会被拒绝");
	});

	test("tells the commander a preset is required, even with nothing to choose from", () => {
		const text = brief(false, []);
		expect(text).toContain("本工程要求每个任务都必须指定");
		expect(text).toContain("省略 preset 会被拒绝");
		expect(text).not.toContain("用默认 Agent。");
	});

	test.each([
		{ bash: false, read: false },
		{ bash: false, read: true },
		{ bash: true, read: false },
		{ bash: true, read: true },
	])("describes independent commander permissions without contradictory prohibitions: %o", (permissions) => {
		const text = buildCommanderBrief(engineFixture(true), [], [], "initial", permissions);
		expect(text).toContain(permissions.read ? "read 已启用" : "read 未启用");
		expect(text).toContain(permissions.bash ? "bash 已启用" : "bash 未启用");
		expect(text).not.toContain(permissions.read ? "read 未启用" : "read 已启用");
		expect(text).not.toContain(permissions.bash ? "bash 未启用" : "bash 已启用");
		expect(text).not.toContain("你没有任何执行工具");
		expect(text).toContain("深入侦察、漏洞验证与利用由执行 Agent 完成");
		if (permissions.bash) expect(text).toContain("命令预算 40 条");
	});
});

describe("formatTaskBoard", () => {
	test("names the preset each task runs as", () => {
		const board = formatTaskBoard([task({ presetId: "web-recon", presetName: "Web 侦察" })]);
		expect(board).toContain("预设：Web 侦察");
	});

	test("says 默认 Agent when a task has none", () => {
		expect(formatTaskBoard([task({})])).toContain("预设：默认 Agent");
	});
});
