import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

/** One valid example of each browser-to-server message described in credentials-mcp.md. */
export const client = {
	get_mcp_servers: {
		type: "get_mcp_servers",
	},
	save_mcp_server: {
		type: "save_mcp_server",
		server: {
			name: "example-mcp",
			enabled: true,
			transport: "sse",
			command: "curl -s https://example.com/",
			args: ["text"],
			env: {
				"key-1": "text",
			},
			cwd: "/work",
			url: "https://example.com",
			headers: {
				"key-1": "text",
			},
			description: "nmap -sV -p 443 example.com",
			exposure: "deferred",
			timeout: 2,
			hostExecAcknowledged: true,
		},
	},
	delete_mcp_server: {
		type: "delete_mcp_server",
		name: "示例文本",
	},
	set_mcp_server_enabled: {
		type: "set_mcp_server_enabled",
		name: "example-mcp",
		enabled: true,
	},
	test_mcp_server: {
		type: "test_mcp_server",
		name: "示例文本",
		draft: {
			name: "示例文本",
			enabled: true,
			transport: "sse",
			command: "curl -s https://example.com/",
			args: ["text"],
			env: {
				"key-1": "text",
			},
			cwd: "/work",
			url: "https://example.com",
			headers: {
				"key-1": "text",
			},
			description: "nmap -sV -p 443 example.com",
			exposure: "deferred",
			timeout: 2,
			hostExecAcknowledged: true,
		},
	},
	credentials_set_enabled: {
		type: "credentials_set_enabled",
		enabled: true,
	},
	reports_set_enabled: {
		type: "reports_set_enabled",
		enabled: true,
	},
	credentials_verify: {
		type: "credentials_verify",
		projectId: "project-1",
		refs: [
			{
				id: "id-1",
				revision: "text",
			},
		],
	},
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

/** One valid example of each server-to-browser message described in credentials-mcp.md. */
export const server = {
	mcp_servers: {
		type: "mcp_servers",
		config: {
			servers: [
				{
					name: "示例文本",
					enabled: true,
					transport: "sse",
					target: "text",
					command: "curl -s https://example.com/",
					args: ["text"],
					env: {
						"key-1": "text",
					},
					cwd: "/work",
					url: "https://example.com",
					headers: {
						"key-1": "text",
					},
					description: "nmap -sV -p 443 example.com",
					exposure: "deferred",
					timeout: 2,
					hostExecAcknowledged: true,
					status: {
						at: 1763973000000,
						ok: true,
					},
				},
			],
			mounted: 2,
			permissionOn: true,
			path: "/work/evidence/notes.md",
		},
	},
	mcp_test_result: {
		type: "mcp_test_result",
		name: "示例文本",
		result: {
			state: "connected",
			tools: ["text"],
			resources: 2,
			instructions: "text",
			ok: true,
			message: "示例文本",
			detail: "示例文本",
		},
	},
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
