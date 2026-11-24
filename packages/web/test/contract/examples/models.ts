import type {
	SentinelBuiltinModelDefaults,
	SentinelClientMessage,
	SentinelModelEntryView,
	SentinelServerMessage,
} from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

/** One valid example of each browser-to-server message described in models.md. */
export const client = {
	get_model_library: { type: "get_model_library" },
	lookup_model_defaults: {
		type: "lookup_model_defaults",
		modelId: "deepseek-chat",
		baseUrl: "https://api.deepseek.com/v1",
	},
	list_model_channels: { type: "list_model_channels", requestId: 7, query: "deepseek" },
	list_channel_models: { type: "list_channel_models", requestId: 8, provider: "deepseek" },
	save_model_entry: {
		type: "save_model_entry",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		apiKey: "sk-example",
		modelId: "deepseek-chat",
	},
	remove_model_entry: { type: "remove_model_entry", id: "m-2" },
	duplicate_model_entry: { type: "duplicate_model_entry", id: "m-1" },
	set_model_role: { type: "set_model_role", role: "judge", target: "m-1" },
	set_reviewer_auto: { type: "set_reviewer_auto", enabled: false },
	test_model_entry: { type: "test_model_entry", id: "m-1" },
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

// Typed here, because a detached literal would widen "main" and "off" to string.
const entry: SentinelModelEntryView = {
	id: "m-1",
	name: "DeepSeek",
	baseUrl: "https://api.deepseek.com/v1",
	modelId: "deepseek-chat",
	hasKey: true,
	roles: ["main"],
	api: "openai-completions",
	contextWindow: 128000,
	maxTokens: 8192,
	reasoning: false,
	input: ["text"],
	cost: { input: 0.14, output: 0.28, cacheRead: 0.035, cacheWrite: 0.14 },
	promptCache: null,
};

const defaults: SentinelBuiltinModelDefaults = {
	provider: "deepseek",
	providerName: "DeepSeek",
	modelId: "deepseek-chat",
	api: "openai-completions",
	contextWindow: 128000,
	maxTokens: 8192,
	reasoning: false,
	defaultThinkingLevel: "off",
	availableThinkingLevels: ["off"],
	thinkingLevelMap: null,
	compat: null,
	input: ["text"],
	cost: { input: 0.14, output: 0.28, cacheRead: 0.035, cacheWrite: 0.14 },
	promptCache: null,
};

/** One valid example of each server-to-browser message described in models.md. */
export const server = {
	model_library: {
		type: "model_library",
		library: {
			entries: [entry],
			roles: {
				main: "m-1",
				judge: "follow-main",
				reviewer: "follow-main",
				supervisor: "follow-main",
				commander: "follow-main",
				monitor: "follow-main",
				workprocess: "follow-main",
			},
			reviewerAuto: true,
			resolved: {
				main: { entryId: "m-1", entryName: "DeepSeek", modelId: "deepseek-chat", followedMain: false },
				judge: { entryId: "m-1", entryName: "DeepSeek", modelId: "deepseek-chat", followedMain: true },
				reviewer: { entryId: "m-1", entryName: "DeepSeek", modelId: "deepseek-chat", followedMain: true },
				supervisor: { entryId: "m-1", entryName: "DeepSeek", modelId: "deepseek-chat", followedMain: true },
				commander: { entryId: "m-1", entryName: "DeepSeek", modelId: "deepseek-chat", followedMain: true },
				monitor: { entryId: "m-1", entryName: "DeepSeek", modelId: "deepseek-chat", followedMain: true },
				workprocess: { entryId: "m-1", entryName: "DeepSeek", modelId: "deepseek-chat", followedMain: true },
			},
		},
	},
	model_defaults: { type: "model_defaults", modelId: "deepseek-chat", matches: [defaults] },
	model_channels: {
		type: "model_channels",
		requestId: 7,
		query: "deepseek",
		channels: [
			{
				provider: "deepseek",
				name: "DeepSeek",
				api: "openai-completions",
				baseUrl: "https://api.deepseek.com/v1",
				baseUrls: ["https://api.deepseek.com/v1"],
				modelCount: 2,
				featured: true,
			},
		],
	},
	channel_models: {
		type: "channel_models",
		requestId: 8,
		provider: "deepseek",
		presets: [{ ...defaults, name: "DeepSeek V3", baseUrl: "https://api.deepseek.com/v1" }],
	},
	model_test_result: {
		type: "model_test_result",
		result: { ok: true, message: "连接成功，模型可用" },
	},
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
