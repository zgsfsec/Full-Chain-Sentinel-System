import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test } from "vitest";
import { modelsJsonPath, readProviderModelConfig } from "../src/model-config.ts";
import {
	addLibraryEntry,
	duplicateLibraryEntry,
	libraryView,
	removeLibraryEntry,
	updateLibraryEntry,
} from "../src/model-library.ts";
import { readModelThinkingLevel } from "../src/model-thinking.ts";
import type { SentinelModelCapabilities } from "../src/protocol.ts";

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
