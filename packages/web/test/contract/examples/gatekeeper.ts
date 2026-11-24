import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

/** One valid example of each browser-to-server message described in gatekeeper.md. */
export const client = {
	get_gatekeeper_config: {
		type: "get_gatekeeper_config",
	},
	save_gatekeeper_config: {
		type: "save_gatekeeper_config",
		config: {
			mode: "review",
			timeoutMs: 1250,
			concurrency: 2,
			mcpTools: {
				enabled: true,
				includePlugins: true,
			},
		},
	},
	test_judge: {
		type: "test_judge",
	},
	gate_audit_query: {
		type: "gate_audit_query",
		filter: {
			decision: "block",
			source: "text",
			approval: ["ai"],
			search: "text",
			since: 2,
		},
		page: 1,
		pageSize: 50,
	},
	gate_audit_stats: {
		type: "gate_audit_stats",
		filter: {
			decision: "block",
			source: "text",
			approval: ["ai"],
			search: "text",
			since: 2,
		},
	},
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

/** One valid example of each server-to-browser message described in gatekeeper.md. */
export const server = {
	gatekeeper_config: {
		type: "gatekeeper_config",
		config: {
			mode: "review",
			timeoutMs: 1250,
			concurrency: 2,
			mcpTools: {
				enabled: true,
				includePlugins: true,
			},
		},
	},
	judge_test_result: {
		type: "judge_test_result",
		result: {
			ok: true,
			message: "示例文本",
			detail: "示例文本",
		},
		raw: "text",
	},
	gate_audit: {
		type: "gate_audit",
		page: {
			items: [
				{
					id: "id-1",
					at: 1763973000000,
					projectId: "project-1",
					projectName: "示例文本",
					sessionId: "session-1",
					source: "text",
					tool: "text",
					command: "curl -s https://example.com/",
					cwd: "/work",
					approval: "ai",
					decision: "block",
					latencyMs: 1250,
				},
			],
			total: 2,
			page: 1,
			pageSize: 50,
		},
	},
	gate_audit_stats: {
		type: "gate_audit_stats",
		stats: {
			total: 2,
			byDecision: {
				failed: 2,
				block: 2,
				allow: 2,
			},
			byApproval: {
				auto: 2,
				ai: 2,
				human: 2,
			},
			blockRate: 2,
			avgLatencyMs: 1250,
			totalTokens: 2,
			last24h: 2,
			failures: 2,
			lastFailureAt: 1763973000000,
			lastSuccessAt: 1763973000000,
			lastError: "示例错误信息",
		},
		tabCounts: {
			auto: 2,
			ai: 2,
			human: 2,
		},
	},
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
