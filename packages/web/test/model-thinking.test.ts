import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
	createAgentSession,
	createExtensionRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test } from "vitest";
import { completeAuxiliaryModel, resolveAuxiliaryModel } from "../src/auxiliary-model.ts";
import { modelsJsonPath, readProviderModelConfig } from "../src/model-config.ts";
import { listBuiltinChannelModels } from "../src/model-defaults.ts";
import {
	addLibraryEntry,
	duplicateLibraryEntry,
	libraryView,
	removeLibraryEntry,
	updateLibraryEntry,
} from "../src/model-library.ts";
import { readModelThinkingLevel } from "../src/model-thinking.ts";
import type { SentinelModelCapabilities } from "../src/protocol.ts";
import {
	ALL_THINKING_LEVELS,
	catalogThinkingSettings,
	customThinkingSettings,
	EMPTY_MODEL_THINKING,
} from "../webui/src/components/model-thinking-draft.ts";
import { modelStream } from "./model-stream-fixtures.ts";

let dir = "";
const input = { name: "Reasoner", baseUrl: "http://127.0.0.1:9/v1", apiKey: "", modelId: "reasoner" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-model-thinking-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("saves a per-model default that a new SDK session uses and preserves session overrides", async () => {
	const entry = addLibraryEntry(dir, {
		...input,
		capabilities: { reasoning: true, defaultThinkingLevel: "high" },
	});
	expect(libraryView(dir).entries[0].defaultThinkingLevel).toBe("high");
	const settings = SettingsManager.create(dir, dir);
	expect(settings.getModelThinkingLevel(entry.id, input.modelId)).toBe("high");
	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
	const model: Model<"openai-completions"> = {
		id: input.modelId,
		name: input.name,
		provider: entry.id,
		api: "openai-completions",
		baseUrl: input.baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
	const sessionManager = SessionManager.inMemory(dir);
	const options = { cwd: dir, agentDir: dir, model, resourceLoader, sessionManager, noTools: "all" as const };
	const { session } = await createAgentSession({ ...options, settingsManager: settings });
	try {
		expect(session.thinkingLevel).toBe("high");
		session.setThinkingLevel("low");
		// A resumed conversation has actual data as well as its thinking setting.
		sessionManager.appendMessage({ role: "user", content: "test", timestamp: Date.now() });
	} finally {
		session.dispose();
	}
	updateLibraryEntry(dir, entry.id, {
		...input,
		capabilities: { reasoning: true, defaultThinkingLevel: "medium" },
	});
	const { session: resumed } = await createAgentSession({
		...options,
		settingsManager: SettingsManager.create(dir, dir),
	});
	try {
		expect(resumed.thinkingLevel).toBe("low");
	} finally {
		resumed.dispose();
	}
});

test("copies the default and clears it when reasoning is disabled or the entry is deleted", () => {
	const entry = addLibraryEntry(dir, { ...input, capabilities: { reasoning: true, defaultThinkingLevel: "off" } });
	const copy = duplicateLibraryEntry(dir, entry.id);
	expect(readModelThinkingLevel(dir, copy.id, input.modelId)).toBe("off");
	updateLibraryEntry(dir, entry.id, { ...input, capabilities: { reasoning: false } });
	expect(readModelThinkingLevel(dir, entry.id, input.modelId)).toBeUndefined();
	expect(libraryView(dir).entries[0]).toMatchObject({ defaultThinkingLevel: "off", availableThinkingLevels: ["off"] });
	removeLibraryEntry(dir, copy.id);
	expect(readModelThinkingLevel(dir, copy.id, input.modelId)).toBeUndefined();
});

test("preserves unrelated settings and moves the default when a model ID changes", () => {
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({ theme: "dark", modelThinkingLevels: { "other/m": "low" } }),
	);
	const entry = addLibraryEntry(dir, { ...input, capabilities: { reasoning: true, defaultThinkingLevel: "high" } });
	updateLibraryEntry(dir, entry.id, { ...input, modelId: "new-model" });
	expect(readProviderModelConfig(dir, entry.id)?.capabilities?.defaultThinkingLevel).toBe("high");
	expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"))).toEqual({
		theme: "dark",
		modelThinkingLevels: { "other/m": "low", [`${entry.id}/new-model`]: "high" },
	});
});

test("uses standard reasoning levels unless the model declares extended mappings", () => {
	const entry = addLibraryEntry(dir, { ...input, capabilities: { reasoning: true } });
	expect(libraryView(dir).entries[0].availableThinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
	const path = modelsJsonPath(dir);
	const stored = JSON.parse(readFileSync(path, "utf-8")) as {
		providers: Record<string, { models: Array<{ thinkingLevelMap?: Record<string, string | null> }> }>;
	};
	stored.providers[entry.id].models[0].thinkingLevelMap = { minimal: null, xhigh: "xhigh", max: "max" };
	writeFileSync(path, JSON.stringify(stored));
	expect(libraryView(dir).entries[0].availableThinkingLevels).toEqual([
		"off",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
});

test("displays the effective global default and clamps unsupported strengths like the SDK", () => {
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "high" }));
	const entry = addLibraryEntry(dir, { ...input, capabilities: { reasoning: true } });
	expect(libraryView(dir).entries[0].defaultThinkingLevel).toBe("high");
	updateLibraryEntry(dir, entry.id, {
		...input,
		capabilities: { reasoning: true, defaultThinkingLevel: "max" },
	});
	expect(libraryView(dir).entries[0].defaultThinkingLevel).toBe("high");
});

test("rejects unknown levels before writing configuration", () => {
	const capabilities = JSON.parse('{"reasoning":true,"defaultThinkingLevel":"ultra"}') as SentinelModelCapabilities;
	expect(() => addLibraryEntry(dir, { ...input, capabilities })).toThrow(/Invalid default thinking level/);
	expect(libraryView(dir).entries).toEqual([]);
});

test("leaves corrupt SDK settings intact and reports the save failure", () => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), "broken JSON");
	expect(() =>
		addLibraryEntry(dir, { ...input, capabilities: { reasoning: true, defaultThinkingLevel: "high" } }),
	).toThrow();
	expect(readFileSync(join(dir, "settings.json"), "utf-8")).toBe("broken JSON");
});

test("keeps catalog thinking strengths through the editor, saves, copies and real SDK requests", async () => {
	const preset = listBuiltinChannelModels(getBuiltinModels("opencode-go"), "opencode-go").find(
		(model) => model.modelId === "deepseek-v4.1-flash",
	);
	expect(preset).toBeDefined();
	if (!preset) throw new Error("Missing catalog fixture");
	const draft = catalogThinkingSettings(preset);
	expect(draft.availableThinkingLevels).toEqual(["low", "high", "max"]);
	expect(draft.defaultThinkingLevel).toBe("high");
	// This is the capability payload submitted by the settings drawer.
	const capabilities: SentinelModelCapabilities = {
		api: preset.api,
		reasoning: preset.reasoning,
		thinkingLevelMap: draft.thinkingLevelMap,
		compat: draft.compat,
		defaultThinkingLevel: "max",
	};
	const entry = addLibraryEntry(dir, { ...input, modelId: preset.modelId, capabilities });
	expect(libraryView(dir).entries[0]).toMatchObject({
		defaultThinkingLevel: "max",
		availableThinkingLevels: ["low", "high", "max"],
	});
	const copy = duplicateLibraryEntry(dir, entry.id);
	expect(libraryView(dir).entries.find((model) => model.id === copy.id)).toMatchObject({
		defaultThinkingLevel: "max",
		availableThinkingLevels: ["low", "high", "max"],
	});
	const config = resolveAuxiliaryModel(dir, "main");
	if (!config) throw new Error("Missing saved model");
	const payloads: Record<string, unknown>[] = [];
	await completeAuxiliaryModel(config, {
		systemPrompt: "test",
		input: "test",
		signal: AbortSignal.timeout(10000),
		fetch: async (_url, options) => {
			payloads.push(JSON.parse(String(options?.body)) as Record<string, unknown>);
			return modelStream("openai-completions", "ok");
		},
	});
	expect(payloads).toHaveLength(1);
	expect(payloads[0]).toMatchObject({ model: preset.modelId, reasoning_effort: "max", thinking: { type: "enabled" } });
	expect(payloads[0].max_tokens).toBeDefined();
	expect(payloads[0].max_completion_tokens).toBeUndefined();
	// Choosing a different, uncatalogued model must not retain DeepSeek's map or protocol switches.
	updateLibraryEntry(dir, entry.id, {
		...input,
		capabilities: { reasoning: true, thinkingLevelMap: null, compat: null, defaultThinkingLevel: "medium" },
	});
	expect(readProviderModelConfig(dir, entry.id)?.capabilities?.thinkingLevelMap).toBeUndefined();
	expect(readProviderModelConfig(dir, entry.id)?.capabilities?.compat).toBeUndefined();
	expect(libraryView(dir).entries[0].availableThinkingLevels).toEqual(EMPTY_MODEL_THINKING.availableThinkingLevels);
});

test("repairs an old editor draft without losing a supported default or custom protocol switches", () => {
	const preset = listBuiltinChannelModels(getBuiltinModels("opencode-go"), "opencode-go").find(
		(model) => model.modelId === "deepseek-v4.1-flash",
	);
	if (!preset) throw new Error("Missing catalog fixture");
	const repaired = catalogThinkingSettings(preset, {
		...EMPTY_MODEL_THINKING,
		defaultThinkingLevel: "high",
		compat: { supportsStrictMode: false },
	});
	expect(repaired.availableThinkingLevels).toEqual(["low", "high", "max"]);
	expect(repaired.defaultThinkingLevel).toBe("high");
	expect(repaired.compat).toMatchObject({ thinkingFormat: "deepseek", supportsStrictMode: false });
	expect(
		catalogThinkingSettings(preset, { ...EMPTY_MODEL_THINKING, defaultThinkingLevel: "off" }).defaultThinkingLevel,
	).toBe("high");
});

test("saves custom relay strengths and sends its mapped value through the SDK without a catalog model", async () => {
	const draft = customThinkingSettings(EMPTY_MODEL_THINKING, ["low", "high", "xhigh", "max"]);
	const capabilities: SentinelModelCapabilities = {
		reasoning: true,
		defaultThinkingLevel: "max",
		thinkingLevelMap: { ...draft.thinkingLevelMap, max: "maximum" },
	};
	const entry = addLibraryEntry(dir, { ...input, modelId: "private-relay-alias", capabilities });
	expect(libraryView(dir).entries[0]).toMatchObject({
		availableThinkingLevels: ["low", "high", "xhigh", "max"],
		defaultThinkingLevel: "max",
		thinkingLevelMap: { off: null, minimal: null, medium: null, max: "maximum" },
	});
	const copy = duplicateLibraryEntry(dir, entry.id);
	expect(libraryView(dir).entries.find((model) => model.id === copy.id)).toMatchObject({
		availableThinkingLevels: ["low", "high", "xhigh", "max"],
		defaultThinkingLevel: "max",
		thinkingLevelMap: { max: "maximum" },
	});
	const config = resolveAuxiliaryModel(dir, "main");
	if (!config) throw new Error("Missing custom relay");
	const payloads: Record<string, unknown>[] = [];
	await completeAuxiliaryModel(config, {
		systemPrompt: "test",
		input: "test",
		signal: AbortSignal.timeout(10000),
		fetch: async (_url, options) => {
			payloads.push(JSON.parse(String(options?.body)) as Record<string, unknown>);
			return modelStream("openai-completions", "ok");
		},
	});
	expect(payloads[0]).toMatchObject({ model: "private-relay-alias", reasoning_effort: "maximum" });
});

test("custom selections disable standard SDK defaults and keep a supported default", () => {
	const extended = customThinkingSettings(EMPTY_MODEL_THINKING, ALL_THINKING_LEVELS);
	expect(extended.thinkingLevelMap).toMatchObject({ off: "none", xhigh: "xhigh", max: "max" });
	const reduced = customThinkingSettings({ ...extended, defaultThinkingLevel: "max" }, ["max", "low"]);
	expect(reduced.availableThinkingLevels).toEqual(["low", "max"]);
	expect(reduced.defaultThinkingLevel).toBe("max");
	const withoutMax = customThinkingSettings(reduced, ["low"]);
	expect(withoutMax.defaultThinkingLevel).toBe("low");
	expect(withoutMax.thinkingLevelMap).toMatchObject({ off: null, max: null });
	expect(customThinkingSettings(withoutMax, []).availableThinkingLevels).toEqual([]);
});

test.each([
	{ reasoning: true, thinkingLevelMap: { max: 123 } },
	{ reasoning: true, compat: { thinkingFormat: "invalid" } },
])("rejects malformed catalog settings before changing an entry", (raw) => {
	const entry = addLibraryEntry(dir, input);
	const before = readFileSync(modelsJsonPath(dir), "utf-8");
	expect(() =>
		updateLibraryEntry(dir, entry.id, {
			...input,
			capabilities: raw as unknown as SentinelModelCapabilities,
		}),
	).toThrow(/Invalid/);
	expect(readFileSync(modelsJsonPath(dir), "utf-8")).toBe(before);
});
