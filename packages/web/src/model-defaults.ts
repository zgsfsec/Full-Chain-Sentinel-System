/**
 * Capability templates from pi's built-in model catalog.
 *
 * The add-model drawer picks a channel (provider) first, then a model inside it,
 * so the operator never needs to know a model id. A custom channel or a custom
 * model id stays available for anything the catalog does not carry. This only
 * ever produces form values: nothing is written until the model is saved.
 */

import { type Api, clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { SentinelBuiltinChannel, SentinelBuiltinModelDefaults, SentinelBuiltinModelPreset } from "./protocol.ts";

/** Same-id models from every provider; enough to show the common hosts. */
const MAX_MATCHES = 12;
/** Near misses are offered as choices, so the list stays short. */
const MAX_NEAR_MATCHES = 6;
/** Share of the non-family tokens two ids must have in common to count as near. */
const NEAR_MATCH_THRESHOLD = 0.5;

/**
 * Direct vendors first, in the order an operator is likely to look for them.
 * The catalog's own ordering is by audience size and starts with aggregators.
 */
const FEATURED_PROVIDERS = [
	"anthropic",
	"openai",
	"google",
	"deepseek",
	"zai",
	"moonshotai",
	"moonshotai-cn",
	"minimax",
	"minimax-cn",
	"xai",
	"mistral",
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"openrouter",
	"groq",
	"cerebras",
];

function hostOf(baseUrl: string | undefined): string | null {
	if (!baseUrl) return null;
	try {
		return new URL(baseUrl).host.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Model ids arrive in provider-specific packaging: relays prefix the vendor,
 * Bedrock appends `-v1:0`, dated snapshots carry a date suffix. Matching on the
 * canonical form keeps that packaging from defeating the lookup. Only the
 * packaging is removed; the model identity itself is left alone.
 */
function canonicalModelId(raw: string): string {
	let id = raw.trim().toLowerCase();
	const slash = id.lastIndexOf("/");
	if (slash >= 0) id = id.slice(slash + 1);
	return id
		.replace(/-v\d+:\d+$/u, "")
		.replace(/:\d+$/u, "")
		.replace(/-\d{8}$/u, "")
		.replace(/-\d{4}-\d{2}-\d{2}$/u, "");
}

function idTokens(id: string): string[] {
	return id.split(/[^a-z0-9]+/u).filter(Boolean);
}

/** `qwen` vs `qwen3`: the leading family token may carry a version suffix. */
function sameFamily(a: string, b: string): boolean {
	if (a === b) return true;
	if (a.length < 2 || b.length < 2) return false;
	return a.startsWith(b) || b.startsWith(a);
}

function commonPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let index = 0;
	while (index < limit && a[index] === b[index]) index += 1;
	return index;
}

/**
 * Similarity of two ids that already failed to match exactly. The family token
 * has to agree and at least one descriptive token must be shared, so `qwen-flash`
 * reaches `qwen3.8-flash` but `kimi-flash` does not.
 */
function nearMatchScore(query: string, candidate: string): number | null {
	const queryTokens = idTokens(query);
	const candidateTokens = idTokens(candidate);
	if (queryTokens.length === 0 || candidateTokens.length === 0) return null;
	const [queryFamily, ...queryRest] = queryTokens;
	const [candidateFamily, ...candidateRest] = candidateTokens;
	if (!sameFamily(queryFamily, candidateFamily)) return null;
	const shared = queryRest.filter((token) => candidateRest.includes(token));
	if (shared.length === 0) return null;
	const coverage = shared.length / Math.max(queryRest.length, candidateRest.length);
	return coverage + (queryFamily === candidateFamily ? 0.25 : 0);
}

function defaultsOf(
	model: Model<Api>,
	providerName: (providerId: string) => string,
	approximate: boolean,
): SentinelBuiltinModelDefaults {
	const promptCache = model.promptCache;
	return {
		provider: model.provider,
		providerName: providerName(model.provider),
		modelId: model.id,
		api: model.api,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
		defaultThinkingLevel: clampThinkingLevel(model, "medium"),
		availableThinkingLevels: getSupportedThinkingLevels(model),
		thinkingLevelMap: model.thinkingLevelMap ?? null,
		compat: model.compat ?? null,
		input: [...model.input],
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
		},
		promptCache: promptCache
			? {
					...(promptCache.short !== undefined ? { short: promptCache.short } : {}),
					...(promptCache.long !== undefined ? { long: promptCache.long } : {}),
				}
			: null,
		...(approximate ? { approximate: true } : {}),
	};
}

function presetOf(model: Model<Api>, providerName: (providerId: string) => string): SentinelBuiltinModelPreset {
	return {
		...defaultsOf(model, providerName, false),
		name: model.name || model.id,
		baseUrl: model.baseUrl,
	};
}

/**
 * One built-in entry per provider whose canonical id matches, with the provider
 * already serving the operator's host first (a relay usually mirrors one vendor).
 * Sentinel's own `zg-*` providers are skipped: matching them would copy the
 * values already on screen. When no id matches, near entries come back marked
 * `approximate` so the form can offer them without filling anything in.
 */
export function matchBuiltinModelDefaults(
	models: readonly Model<Api>[],
	modelId: string,
	baseUrl: string,
	providerName: (providerId: string) => string = (providerId) => providerId,
): SentinelBuiltinModelDefaults[] {
	const wanted = canonicalModelId(modelId);
	if (!wanted) return [];
	const wantedHost = hostOf(baseUrl);
	const wantedEndpoint = baseUrl.trim().replace(/\/+$/u, "");

	const exact: Array<{ defaults: SentinelBuiltinModelDefaults; hostMatch: boolean; endpointMatch: boolean }> = [];
	const seen = new Set<string>();
	for (const model of models) {
		if (canonicalModelId(model.id) !== wanted) continue;
		if (model.provider.startsWith("zg-") || seen.has(model.provider)) continue;
		seen.add(model.provider);
		exact.push({
			endpointMatch: wantedEndpoint.length > 0 && model.baseUrl.replace(/\/+$/u, "") === wantedEndpoint,
			hostMatch: wantedHost !== null && hostOf(model.baseUrl) === wantedHost,
			defaults: defaultsOf(model, providerName, false),
		});
	}
	if (exact.length > 0) {
		exact.sort(
			(a, b) =>
				Number(b.endpointMatch) - Number(a.endpointMatch) ||
				Number(b.hostMatch) - Number(a.hostMatch) ||
				a.defaults.providerName.localeCompare(b.defaults.providerName),
		);
		return exact.slice(0, MAX_MATCHES).map((match) => match.defaults);
	}

	const near = new Map<
		string,
		{ defaults: SentinelBuiltinModelDefaults; score: number; hostMatch: boolean; prefix: number }
	>();
	for (const model of models) {
		if (model.provider.startsWith("zg-")) continue;
		const canonical = canonicalModelId(model.id);
		const score = nearMatchScore(wanted, canonical);
		if (score === null || score < NEAR_MATCH_THRESHOLD) continue;
		const current = near.get(model.provider);
		if (current && current.score >= score) continue;
		near.set(model.provider, {
			hostMatch: wantedHost !== null && hostOf(model.baseUrl) === wantedHost,
			score,
			prefix: commonPrefixLength(wanted, canonical),
			defaults: defaultsOf(model, providerName, true),
		});
	}
	return [...near.values()]
		.sort(
			(a, b) =>
				b.score - a.score ||
				Number(b.hostMatch) - Number(a.hostMatch) ||
				// Same score: the id that shares more of its spelling is the closer guess.
				b.prefix - a.prefix ||
				a.defaults.providerName.localeCompare(b.defaults.providerName),
		)
		.slice(0, MAX_NEAR_MATCHES)
		.map((match) => match.defaults);
}

function providerRank(provider: string): number {
	const index = FEATURED_PROVIDERS.indexOf(provider);
	return index < 0 ? FEATURED_PROVIDERS.length : index;
}

/** Most frequent value wins; ties keep the first seen so the order is stable. */
function dominant(counts: Map<string, number>, fallback: string): string {
	let best = fallback;
	let bestCount = 0;
	for (const [value, count] of counts) {
		if (count > bestCount) {
			best = value;
			bestCount = count;
		}
	}
	return best;
}

interface ChannelAccumulator {
	provider: string;
	name: string;
	modelCount: number;
	apiCounts: Map<string, number>;
	baseUrlCounts: Map<string, number>;
	matched: boolean;
}

/**
 * Channels for the first picker. A query also matches model names and ids, so
 * `claude` surfaces Anthropic even though the channel is not named that way.
 * Sentinel's own `zg-*` providers are skipped for the same reason as above.
 */
export function listBuiltinChannels(
	models: readonly Model<Api>[],
	query = "",
	providerName: (providerId: string) => string = (providerId) => providerId,
): SentinelBuiltinChannel[] {
	const tokens = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
	const accumulated = new Map<string, ChannelAccumulator>();
	for (const model of models) {
		if (model.provider.startsWith("zg-")) continue;
		const name = providerName(model.provider);
		let channel = accumulated.get(model.provider);
		if (!channel) {
			channel = {
				provider: model.provider,
				name,
				modelCount: 0,
				apiCounts: new Map(),
				baseUrlCounts: new Map(),
				matched: false,
			};
			accumulated.set(model.provider, channel);
		}
		channel.modelCount += 1;
		channel.apiCounts.set(model.api, (channel.apiCounts.get(model.api) ?? 0) + 1);
		channel.baseUrlCounts.set(model.baseUrl, (channel.baseUrlCounts.get(model.baseUrl) ?? 0) + 1);
		if (!channel.matched && tokens.length > 0) {
			const haystack =
				`${name} ${model.provider} ${model.id} ${model.name} ${model.baseUrl} ${model.api}`.toLowerCase();
			channel.matched = tokens.every((token) => haystack.includes(token));
		}
	}

	return [...accumulated.values()]
		.filter((channel) => tokens.length === 0 || channel.matched)
		.map((channel) => ({
			provider: channel.provider,
			name: channel.name,
			api: dominant(channel.apiCounts, ""),
			baseUrl: dominant(channel.baseUrlCounts, ""),
			baseUrls: [...channel.baseUrlCounts.keys()].filter(Boolean),
			modelCount: channel.modelCount,
			featured: providerRank(channel.provider) < FEATURED_PROVIDERS.length,
		}))
		.sort((a, b) => providerRank(a.provider) - providerRank(b.provider) || a.name.localeCompare(b.name));
}

/**
 * Every catalog model of one channel, in catalog order. The picker filters this
 * list in the browser, so a search never turns into a round trip.
 */
export function listBuiltinChannelModels(
	models: readonly Model<Api>[],
	provider: string,
	providerName: (providerId: string) => string = (providerId) => providerId,
): SentinelBuiltinModelPreset[] {
	return models
		.filter((model) => model.provider === provider && !model.provider.startsWith("zg-"))
		.map((model) => presetOf(model, providerName));
}
