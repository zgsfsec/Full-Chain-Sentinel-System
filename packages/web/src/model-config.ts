/**
 * Provider entries in models.json.
 *
 * The file belongs to the Pi SDK: one provider per model-library entry, keyed by
 * the entry id. The wire protocol defaults to openai-completions but the model
 * form can select pi's other APIs. Capability fields (context window, reasoning,
 * prices, cache lifetimes) are written when declared and otherwise left to pi's
 * defaults. What the SDK schema has no place for (display names, role
 * assignments, the reviewer switch) lives in model-library.json; see
 * model-library.ts.
 *
 * Three ids are leftovers from the fixed-slot layout. `zg-endpoint` and
 * `zg-judge` are read only by the one-time migration, which reuses them as entry
 * ids so a downgrade still finds its slots. `zg-commander` is read only by the
 * migration, which offers it as the initial 指挥端点 role.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-coding-agent";
import { isModelThinkingLevel, readModelThinkingLevel, writeModelThinkingLevel } from "./model-thinking.ts";
import type {
	SentinelModelCapabilities,
	SentinelModelConfig,
	SentinelModelCostRates,
	SentinelModelPromptCache,
} from "./protocol.ts";

/** Legacy main-endpoint provider id. */
export const SENTINEL_PROVIDER_ID = "zg-endpoint";
/** The engineering commander's own endpoint; may point at a cheaper model. */
export const SENTINEL_COMMANDER_PROVIDER_ID = "zg-commander";
/** Legacy judge provider id. */
export const SENTINEL_JUDGE_PROVIDER_ID = "zg-judge";

/** Bearer placeholder for unauthenticated endpoints; written so Pi treats the provider as credentialed. */
export const NO_AUTH_PLACEHOLDER_KEY = "sentinel-no-auth";

export const DEFAULT_MODEL_API = "openai-completions";

/**
 * Capabilities declared for the configured model. Pi drops image attachments for
 * models whose `input` omits "image" (the provider-model default is text only), so
 * a vision-capable endpoint must opt in here or screenshots never reach it. A
 * text-only endpoint that receives an image reports it upstream.
 */
const DEFAULT_MODEL_INPUT = ["text", "image"];

interface ModelsJson {
	$schema?: string;
	providers: Record<
		string,
		{
			name?: string;
			baseUrl?: string;
			apiKey?: string;
			api?: string;
			headers?: Record<string, string>;
			models?: Array<Record<string, unknown>>;
			[k: string]: unknown;
		}
	>;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readCost(value: unknown): SentinelModelCostRates | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const source = value as Record<string, unknown>;
	const input = nonNegativeNumber(source.input);
	const output = nonNegativeNumber(source.output);
	const cacheRead = nonNegativeNumber(source.cacheRead);
	const cacheWrite = nonNegativeNumber(source.cacheWrite);
	if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
		return undefined;
	}
	return { input, output, cacheRead, cacheWrite };
}

function readPromptCache(value: unknown): SentinelModelPromptCache | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const source = value as Record<string, unknown>;
	const short = positiveNumber(source.short);
	const long = positiveNumber(source.long);
	if (short === undefined && long === undefined) return undefined;
	return { ...(short !== undefined ? { short } : {}), ...(long !== undefined ? { long } : {}) };
}

function readInput(value: unknown): Array<"text" | "image"> | undefined {
	if (!Array.isArray(value)) return undefined;
	const input = value.filter((item): item is "text" | "image" => item === "text" || item === "image");
	return input.length > 0 ? [...new Set(input)] : undefined;
}

function readCapabilities(
	provider: ModelsJson["providers"][string],
	model: Record<string, unknown>,
): SentinelModelCapabilities | undefined {
	const capabilities: SentinelModelCapabilities = {};
	// A model-level api would be dead weight now that the writer always puts the
	// protocol here, but an old hand-written file may still have one.
	const api =
		(typeof provider.api === "string" && provider.api) || (typeof model.api === "string" && model.api) || undefined;
	if (api) capabilities.api = api;
	const contextWindow = positiveNumber(model.contextWindow);
	if (contextWindow !== undefined) capabilities.contextWindow = contextWindow;
	const maxTokens = positiveNumber(model.maxTokens);
	if (maxTokens !== undefined) capabilities.maxTokens = maxTokens;
	if (typeof model.reasoning === "boolean") capabilities.reasoning = model.reasoning;
	const input = readInput(model.input);
	if (input) capabilities.input = input;
	const cost = readCost(model.cost);
	if (cost) capabilities.cost = cost;
	const promptCache = readPromptCache(model.promptCache);
	if (promptCache) capabilities.promptCache = promptCache;
	return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

export function modelsJsonPath(agentDir: string): string {
	return `${agentDir}/models.json`;
}

/** The commander's endpoint. When none is configured the engine falls back to the main role. */
export function readCommanderModelConfig(agentDir: string): SentinelModelConfig | null {
	return readProviderModelConfig(agentDir, SENTINEL_COMMANDER_PROVIDER_ID);
}

export function writeCommanderModelConfig(agentDir: string, config: SentinelModelConfig | null): void {
	// null removes the commander entry, which restores the fallback to the main role.
	if (config === null) {
		removeProviderModelConfig(agentDir, SENTINEL_COMMANDER_PROVIDER_ID);
		return;
	}
	writeProviderModelConfig(agentDir, SENTINEL_COMMANDER_PROVIDER_ID, "Full Chain Sentinel Commander", config);
}

/** One provider entry, or null when it is missing or incomplete. */
export function readProviderModelConfig(agentDir: string, providerId: string): SentinelModelConfig | null {
	const path = modelsJsonPath(agentDir);
	if (!existsSync(path)) return null;
	let parsed: ModelsJson;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8")) as ModelsJson;
	} catch {
		return null;
	}
	const provider = parsed.providers?.[providerId];
	const model = provider?.models?.[0];
	if (!provider?.baseUrl || !model || typeof model.id !== "string") return null;
	const capabilities = readCapabilities(provider, model);
	const defaultThinkingLevel = readModelThinkingLevel(agentDir, providerId, model.id);
	if (capabilities?.reasoning && defaultThinkingLevel !== undefined) {
		capabilities.defaultThinkingLevel = defaultThinkingLevel;
	}
	return {
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKey ?? "",
		modelId: model.id,
		...(capabilities ? { capabilities } : {}),
	};
}

/** The SDK clamps defaults to this list when a session starts. */
export function readProviderThinkingSettings(
	agentDir: string,
	providerId: string,
): { defaultThinkingLevel: ThinkingLevel; availableThinkingLevels: ThinkingLevel[] } {
	const parsed = JSON.parse(readFileSync(modelsJsonPath(agentDir), "utf-8")) as ModelsJson;
	const model = parsed.providers?.[providerId]?.models?.[0];
	const thinkingModel: Model<"openai-completions"> = {
		id: "",
		name: "",
		provider: providerId,
		api: "openai-completions",
		baseUrl: "",
		reasoning: model?.reasoning === true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		thinkingLevelMap: model?.thinkingLevelMap as Model<"openai-completions">["thinkingLevelMap"],
	};
	const requested =
		typeof model?.id === "string" ? readModelThinkingLevel(agentDir, providerId, model.id, true) : undefined;
	return {
		defaultThinkingLevel: clampThinkingLevel(thinkingModel, requested ?? "medium"),
		availableThinkingLevels: getSupportedThinkingLevels(thinkingModel),
	};
}

/** Write one provider entry, merging into any existing models.json. */
export function writeProviderModelConfig(
	agentDir: string,
	providerId: string,
	name: string,
	config: SentinelModelConfig,
): void {
	const path = modelsJsonPath(agentDir);
	let parsed: ModelsJson = { providers: {} };
	if (existsSync(path)) {
		try {
			parsed = JSON.parse(readFileSync(path, "utf-8")) as ModelsJson;
		} catch {
			parsed = { providers: {} };
		}
	}
	if (!parsed.providers || typeof parsed.providers !== "object") parsed.providers = {};
	const previous = parsed.providers[providerId];
	const previousModel = previous?.models?.[0] ?? {};
	// Old hand-written files may declare the protocol on the model instead of the
	// provider; keep it if the form does not supply one.
	const previousModelApi = typeof previousModel.api === "string" ? previousModel.api : undefined;
	// Start from the old entry so fields the form does not own (thinkingLevelMap,
	// samplingParams, compat, inputLimits) survive every save.
	const nextModel: Record<string, unknown> = { ...previousModel, id: config.modelId, name: config.modelId };
	delete nextModel.api;
	const capabilities = config.capabilities;
	const previousThinkingLevel =
		typeof previousModel.id === "string" ? readModelThinkingLevel(agentDir, providerId, previousModel.id) : undefined;
	if (capabilities?.defaultThinkingLevel !== undefined && !isModelThinkingLevel(capabilities.defaultThinkingLevel)) {
		throw new Error("Invalid default thinking level");
	}
	if (capabilities) {
		const contextWindow = positiveNumber(capabilities.contextWindow);
		if (contextWindow !== undefined) nextModel.contextWindow = contextWindow;
		else delete nextModel.contextWindow;
		const maxTokens = positiveNumber(capabilities.maxTokens);
		if (maxTokens !== undefined) nextModel.maxTokens = maxTokens;
		else delete nextModel.maxTokens;
		if (capabilities.reasoning === true) nextModel.reasoning = true;
		else delete nextModel.reasoning;
		nextModel.input = readInput(capabilities.input) ?? DEFAULT_MODEL_INPUT;
		const cost = readCost(capabilities.cost);
		if (cost) nextModel.cost = cost;
		else delete nextModel.cost;
		const promptCache = readPromptCache(capabilities.promptCache);
		if (promptCache) nextModel.promptCache = promptCache;
		else delete nextModel.promptCache;
	} else if (nextModel.input === undefined) {
		nextModel.input = DEFAULT_MODEL_INPUT;
	}
	parsed.providers[providerId] = {
		...previous,
		name,
		baseUrl: config.baseUrl,
		// Pi requires a credential before it will prompt. Unauthenticated local
		// endpoints get a placeholder bearer, which they ignore (same trick the
		// pi docs recommend for Ollama). An empty string would be invalid.
		apiKey: config.apiKey || NO_AUTH_PLACEHOLDER_KEY,
		api: capabilities?.api || previous?.api || previousModelApi || DEFAULT_MODEL_API,
		models: [nextModel],
	};
	mkdirSync(dirname(path), { recursive: true });
	writeModelThinkingLevel(
		agentDir,
		providerId,
		config.modelId,
		nextModel.reasoning === true ? (capabilities?.defaultThinkingLevel ?? previousThinkingLevel) : undefined,
	);
	writeFileSync(path, `${JSON.stringify(parsed, null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// chmod is best-effort (some filesystems reject it)
	}
}

/** Drop one provider entry. A corrupt file is left alone. */
export function removeProviderModelConfig(agentDir: string, providerId: string): void {
	const path = modelsJsonPath(agentDir);
	if (!existsSync(path)) return;
	writeModelThinkingLevel(agentDir, providerId, null);
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as ModelsJson;
		if (parsed.providers) delete parsed.providers[providerId];
		writeFileSync(path, `${JSON.stringify(parsed, null, "\t")}\n`, { mode: 0o600 });
	} catch {
		// A corrupt file is left alone; the endpoint still works.
	}
}
