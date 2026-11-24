import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

/** One valid example of each browser-to-server message described in connection.md. */
export const client = {
	set_ui_language: { type: "set_ui_language", language: "en" },
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

/** One valid example of each server-to-browser message described in connection.md. */
export const server = {
	ui_config: { type: "ui_config", language: "zh" },
	error: { type: "error", message: "未知消息类型: foo" },
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
