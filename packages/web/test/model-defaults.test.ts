import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { listBuiltinChannelModels, listBuiltinChannels, matchBuiltinModelDefaults } from "../src/model-defaults.ts";

function model(options: {
	id: string;
	provider: string;
	name?: string;
	baseUrl?: string;
	api?: Api;
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	promptCache?: { short?: number; long?: number };
}): Model<Api> {
	return {
		id: options.id,
		name: options.name ?? options.id,
		provider: options.provider,
		api: options.api ?? "openai-completions",
		baseUrl: options.baseUrl ?? "https://api.example.com/v1",
		input: ["text", "image"],
		cost: options.cost ?? { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		reasoning: true,
		contextWindow: options.contextWindow ?? 128000,
		maxTokens: options.maxTokens ?? 16000,
		...(options.promptCache ? { promptCache: options.promptCache } : {}),
	};
}

describe("built-in model defaults", () => {
	test("matches ids case-insensitively and maps the capability fields", () => {
		const matches = matchBuiltinModelDefaults(
			[model({ id: "GLM-4.7", provider: "zhipu", api: "openai-completions", promptCache: { short: 300 } })],
			" gl-m", // does not match
			"",
		);
		expect(matches).toEqual([]);

		const found = matchBuiltinModelDefaults(
			[model({ id: "GLM-4.7", provider: "zhipu", promptCache: { short: 300 } })],
			"glm-4.7",
			"https://open.bigmodel.cn/api/paas/v4",
		);
		expect(found).toEqual([
			{
				provider: "zhipu",
				providerName: "zhipu",
				modelId: "GLM-4.7",
				api: "openai-completions",
				contextWindow: 128000,
				maxTokens: 16000,
				reasoning: true,
				defaultThinkingLevel: "medium",
				availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
				thinkingLevelMap: null,
				compat: null,
				input: ["text", "image"],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
				promptCache: { short: 300 },
			},
		]);
	});

	test("matches through provider prefixes, dates and bedrock suffixes", () => {
		const found = matchBuiltinModelDefaults(
			[model({ id: "claude-sonnet-4-5-20250929", provider: "anthropic", api: "anthropic-messages" })],
			"anthropic/claude-sonnet-4-5-v1:0",
			"",
		);
		expect(found.map((match) => match.modelId)).toEqual(["claude-sonnet-4-5-20250929"]);
		expect(found[0]?.approximate).toBeUndefined();
	});

	test("offers near entries as approximate choices when the id is absent", () => {
		const found = matchBuiltinModelDefaults(
			[
				model({ id: "qwen3.8-flash", provider: "qwen-plan" }),
				model({ id: "kimi-k3", provider: "moonshot" }),
				model({ id: "MiniMax-M3", provider: "minimax", api: "anthropic-messages" }),
			],
			"qwen-flash",
			"",
		);
		expect(found).toEqual([
			expect.objectContaining({ provider: "qwen-plan", modelId: "qwen3.8-flash", approximate: true }),
		]);

		const minimax = matchBuiltinModelDefaults(
			[
				model({ id: "minimax.minimax-m2.1", provider: "amazon-bedrock", api: "bedrock-converse-stream" }),
				model({ id: "MiniMax-M3", provider: "minimax", api: "anthropic-messages" }),
			],
			"MiniMax-M3.1-Flash",
			"",
		);
		// The tied score is broken by how much of the id's spelling they share.
		expect(minimax.map((match) => match.provider)).toEqual(["minimax", "amazon-bedrock"]);
		expect(minimax[0]).toEqual(
			expect.objectContaining({ provider: "minimax", modelId: "MiniMax-M3", approximate: true }),
		);
	});

	test("exact matches win over near entries", () => {
		const found = matchBuiltinModelDefaults(
			[model({ id: "glm-5.3", provider: "zai" }), model({ id: "glm-5.2", provider: "opencode" })],
			"glm-5.3",
			"",
		);
		expect(found.map((match) => match.provider)).toEqual(["zai"]);
		expect(found[0]?.approximate).toBeUndefined();
	});

	test("keeps one entry per provider and skips sentinel's own providers", () => {
		const matches = matchBuiltinModelDefaults(
			[
				model({ id: "m1", provider: "vendor", api: "openai-completions" }),
				model({ id: "m1", provider: "vendor", api: "openai-responses" }),
				model({ id: "m1", provider: "zg-model-1" }),
				model({ id: "m1", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }),
			],
			"m1",
			"https://api.anthropic.com",
		);
		expect(matches.map((match) => match.provider)).toEqual(["anthropic", "vendor"]);
		// The provider already serving the operator's host comes first.
		expect(matches[0]?.api).toBe("anthropic-messages");
	});

	test("resolves provider display names through the callback", () => {
		const [match] = matchBuiltinModelDefaults([model({ id: "m1", provider: "vendor" })], "m1", "", (providerId) =>
			providerId === "vendor" ? "Vendor Inc." : providerId,
		);
		expect(match?.providerName).toBe("Vendor Inc.");
	});

	test("uses the matching endpoint path before another channel on the same host", () => {
		const models = [
			model({ id: "reasoner", provider: "a-go", baseUrl: "https://opencode.ai/zen/go/v1" }),
			model({ id: "reasoner", provider: "z-zen", baseUrl: "https://opencode.ai/zen/v1" }),
		];
		expect(matchBuiltinModelDefaults(models, "reasoner", "https://opencode.ai/zen/v1/")[0].provider).toBe("z-zen");
		expect(matchBuiltinModelDefaults(models, "reasoner", "https://opencode.ai/zen/go/v1")[0].provider).toBe("a-go");
	});
});

describe("built-in channels", () => {
	test("groups models by provider with the dominant protocol and endpoint", () => {
		const channels = listBuiltinChannels(
			[
				model({
					id: "claude-opus-5",
					provider: "anthropic",
					name: "Claude Opus 5",
					api: "anthropic-messages",
					baseUrl: "https://api.anthropic.com",
				}),
				model({
					id: "claude-sonnet-5",
					provider: "anthropic",
					name: "Claude Sonnet 5",
					api: "anthropic-messages",
					baseUrl: "https://api.anthropic.com",
				}),
				model({
					id: "claude-haiku-4",
					provider: "anthropic",
					api: "anthropic-messages",
					baseUrl: "https://proxy.example.com",
				}),
				model({ id: "gpt-5", provider: "openai", name: "GPT-5" }),
				model({ id: "zg-hidden", provider: "zg-default" }),
			],
			"",
			(providerId) => (providerId === "anthropic" ? "Anthropic" : providerId),
		);
		// Featured vendors lead in the panel's order, not the catalog's.
		expect(channels.map((channel) => channel.provider)).toEqual(["anthropic", "openai"]);
		expect(channels[0]).toEqual({
			provider: "anthropic",
			name: "Anthropic",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			baseUrls: ["https://api.anthropic.com", "https://proxy.example.com"],
			modelCount: 3,
			featured: true,
		});
		expect(channels[1]?.featured).toBe(true);
	});

	test("searches channel names, ids, hosts and protocols, requiring every token", () => {
		const models = [
			model({
				id: "claude-sonnet-5",
				provider: "anthropic",
				name: "Claude Sonnet 5",
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
			}),
			model({
				id: "anthropic/claude-sonnet-5",
				provider: "openrouter",
				name: "Anthropic: Claude Sonnet 5",
				baseUrl: "https://openrouter.ai/api",
			}),
			model({
				id: "kimi-k3",
				provider: "moonshotai",
				name: "Kimi K3",
				baseUrl: "https://api.moonshot.ai/v1",
			}),
		];
		expect(listBuiltinChannels(models, "claude sonnet").map((channel) => channel.provider)).toEqual([
			"anthropic",
			"openrouter",
		]);
		expect(listBuiltinChannels(models, "KIMI").map((channel) => channel.provider)).toEqual(["moonshotai"]);
		expect(listBuiltinChannels(models, "openrouter.ai").map((channel) => channel.provider)).toEqual(["openrouter"]);
		expect(listBuiltinChannels(models, "anthropic-messages").map((channel) => channel.provider)).toEqual([
			"anthropic",
		]);
		// Tokens must meet inside one model, so two channels cannot combine.
		expect(listBuiltinChannels(models, "claude kimi")).toEqual([]);
	});

	test("keeps every endpoint for edit matching and skips sentinel's own providers", () => {
		const channels = listBuiltinChannels(
			[
				model({ id: "m1", provider: "vendor", baseUrl: "https://a.example.com/v1" }),
				model({ id: "m2", provider: "vendor", baseUrl: "https://b.example.com/v1" }),
				model({
					id: "m3",
					provider: "vendor",
					baseUrl: "https://a.example.com/v1",
					api: "openai-responses",
				}),
				model({ id: "own", provider: "zg-custom" }),
			],
			"",
		);
		expect(channels).toHaveLength(1);
		expect(channels[0]?.baseUrls).toEqual(["https://a.example.com/v1", "https://b.example.com/v1"]);
		// A protocol tie keeps the first model's value, so repeated renders agree.
		expect(channels[0]?.api).toBe("openai-completions");
		expect(channels[0]?.featured).toBe(false);
	});
});

describe("built-in channel models", () => {
	test("lists one channel in catalog order with display and endpoint values", () => {
		const presets = listBuiltinChannelModels(
			[
				model({
					id: "claude-opus-5",
					provider: "anthropic",
					name: "Claude Opus 5",
					api: "anthropic-messages",
					baseUrl: "https://api.anthropic.com",
					contextWindow: 200000,
				}),
				model({ id: "gpt-5", provider: "openai", name: "GPT-5" }),
				model({
					id: "claude-sonnet-5",
					provider: "anthropic",
					name: "Claude Sonnet 5",
					api: "anthropic-messages",
					baseUrl: "https://api.anthropic.com",
				}),
				model({ id: "own", provider: "zg-anthropic" }),
			],
			"anthropic",
			(providerId) => (providerId === "anthropic" ? "Anthropic" : providerId),
		);
		expect(presets.map((preset) => preset.modelId)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
		expect(presets[0]).toEqual(
			expect.objectContaining({
				provider: "anthropic",
				providerName: "Anthropic",
				name: "Claude Opus 5",
				baseUrl: "https://api.anthropic.com",
				api: "anthropic-messages",
				contextWindow: 200000,
			}),
		);
	});
});
