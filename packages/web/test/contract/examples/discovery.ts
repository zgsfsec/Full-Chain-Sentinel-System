import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

/** One valid example of each browser-to-server message described in discovery.md. */
export const client = {
	get_asset_config: { type: "get_asset_config" },
	save_asset_platform: {
		type: "save_asset_platform",
		platform: { id: "hunter", enabled: true, key: "example-hunter-key", baseUrl: "https://hunter.example.com" },
	},
	set_asset_query_limit: { type: "set_asset_query_limit", limit: 50 },
	test_asset_platform: {
		type: "test_asset_platform",
		platform: "hunter",
		key: "example-hunter-key",
		baseUrl: "https://hunter.example.com",
	},
	get_websearch_config: { type: "get_websearch_config" },
	save_websearch_key: {
		type: "save_websearch_key",
		key: { label: "备用账号", key: "tvly-example-key-c77d", enabled: true },
	},
	delete_websearch_key: { type: "delete_websearch_key", id: "tvk-8d3b7e41" },
	set_websearch_query_limit: { type: "set_websearch_query_limit", limit: 100 },
	test_websearch_key: { type: "test_websearch_key", id: "tvk-5f1c9a2e" },
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

/** One valid example of each server-to-browser message described in discovery.md. */
export const server = {
	asset_config: {
		type: "asset_config",
		config: {
			platforms: [
				{
					id: "fofa",
					label: "FOFA",
					enabled: true,
					hasKey: true,
					baseUrl: "",
					verified: true,
					status: { at: 1795489925000, ok: true, quota: "免费点 1500 · F 点 39366" },
				},
				{
					id: "quake",
					label: "360 Quake",
					enabled: false,
					hasKey: false,
					baseUrl: "",
					verified: false,
					status: { at: null, ok: true },
				},
				{
					id: "hunter",
					label: "奇安信 Hunter",
					enabled: true,
					hasKey: true,
					baseUrl: "https://hunter.example.com",
					verified: false,
					status: { at: 1795502418000, ok: false, error: "网络错误：getaddrinfo ENOTFOUND hunter.example.com" },
				},
			],
			sessionQueryLimit: 50,
			usable: 1,
		},
	},
	asset_test_result: {
		type: "asset_test_result",
		platform: "hunter",
		result: {
			ok: false,
			message: "连接失败：网络错误：getaddrinfo ENOTFOUND hunter.example.com",
			detail: "网络错误：getaddrinfo ENOTFOUND hunter.example.com",
		},
	},
	websearch_config: {
		type: "websearch_config",
		config: {
			keys: [
				{
					id: "tvk-5f1c9a2e",
					label: "主账号",
					enabled: true,
					hasKey: true,
					verified: true,
					status: { at: 1795496561000, ok: true, quota: "套餐 Free · 已用 12 / 1000" },
					tail: "9f2a",
					usage: { remaining: 988, limit: 1000 },
				},
				{
					id: "tvk-8d3b7e41",
					label: "备用账号",
					enabled: false,
					hasKey: true,
					verified: false,
					status: { at: 1795501869000, ok: false, error: "API Key 无效或已过期（HTTP 401）" },
					tail: "c77d",
				},
			],
			sessionQueryLimit: 100,
			usable: 1,
		},
	},
	websearch_test_result: {
		type: "websearch_test_result",
		result: { ok: true, message: "Tavily 连接正常（套餐 Free · 本套餐已用 12 / 1000 · 剩余 988）" },
	},
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
