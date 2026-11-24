import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

/** One valid example of each browser-to-server message described in permissions-presets.md. */
export const client = {
	get_permissions: {
		type: "get_permissions",
	},
	save_permissions: {
		type: "save_permissions",
		config: {
			main: {
				web_search: true,
				mcp: true,
				tool_search: true,
				edit: true,
				bash: true,
				codemode: true,
				read: true,
				write: true,
				spawn_agent: true,
				vuln_submit: true,
				vuln_read: true,
				poc_read: true,
				asset_read: true,
				asset_library_write: true,
				asset_library_read: true,
				mitm_read: true,
			},
			subagent: {
				web_search: true,
				mcp: true,
				tool_search: true,
				edit: true,
				bash: true,
				codemode: true,
				read: true,
				write: true,
				spawn_agent: true,
				vuln_submit: true,
				vuln_read: true,
				poc_read: true,
				asset_read: true,
				asset_library_write: true,
				asset_library_read: true,
				mitm_read: true,
			},
			commander: {
				bash: true,
				read: true,
			},
			subagentMaxTurns: 100,
			plugins: {
				main: {
					"key-1": true,
				},
				subagent: {
					"key-1": true,
				},
			},
		},
	},
	get_notify_config: {
		type: "get_notify_config",
	},
	save_notify_config: {
		type: "save_notify_config",
		config: {
			groups: [
				{
					id: "id-1",
					name: "示例文本",
					enabled: true,
					kinds: {
						runs: true,
						vulns: true,
						codeIntel: true,
						goals: true,
						engines: true,
						pocs: true,
					},
					targets: [
						{
							id: "id-1",
							name: "示例文本",
							channel: "dingtalk",
							enabled: true,
							webhook: "https://example.com",
							secret: "example-credential",
							keyword: "text",
						},
					],
				},
			],
			summaryLimit: 3,
		},
	},
	test_notify: {
		type: "test_notify",
		target: {
			id: "id-1",
			name: "示例文本",
			channel: "dingtalk",
			enabled: true,
			webhook: "https://example.com",
			secret: "example-credential",
			keyword: "text",
		},
	},
	list_presets: {
		type: "list_presets",
	},
	save_preset: {
		type: "save_preset",
		input: {
			name: "示例文本",
			description: "nmap -sV -p 443 example.com",
			tags: ["text"],
			placeholder: "text",
			text: "示例文本",
			enabled: false,
		},
	},
	delete_preset: {
		type: "delete_preset",
		id: "id-1",
	},
	set_preset_enabled: {
		type: "set_preset_enabled",
		id: "id-1",
		enabled: true,
	},
	export_presets: {
		type: "export_presets",
		ids: ["id-1"],
	},
	import_presets: {
		type: "import_presets",
		content:
			'{\n\t"format": "sentinel-presets",\n\t"version": 1,\n\t"exportedAt": 1763973000000,\n\t"presets": [\n\t\t{\n\t\t\t"id": "preset-1",\n\t\t\t"name": "只读侦察",\n\t\t\t"description": "只做侦察，不改动目标",\n\t\t\t"tags": [\n\t\t\t\t"recon"\n\t\t\t],\n\t\t\t"placeholder": "",\n\t\t\t"text": "只使用只读工具：端口扫描、目录枚举、指纹识别。不执行写入、不利用漏洞。",\n\t\t\t"enabled": true\n\t\t}\n\t]\n}',
	},
	list_doctrines: {
		type: "list_doctrines",
	},
	save_doctrine: {
		type: "save_doctrine",
		input: {
			name: "示例文本",
			text: "示例文本",
		},
	},
	delete_doctrine: {
		type: "delete_doctrine",
		id: "id-1",
	},
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

/** One valid example of each server-to-browser message described in permissions-presets.md. */
export const server = {
	permissions: {
		type: "permissions",
		config: {
			main: {
				web_search: true,
				mcp: true,
				tool_search: true,
				edit: true,
				bash: true,
				codemode: true,
				read: true,
				write: true,
				spawn_agent: true,
				vuln_submit: true,
				vuln_read: true,
				poc_read: true,
				asset_read: true,
				asset_library_write: true,
				asset_library_read: true,
				mitm_read: true,
			},
			subagent: {
				web_search: true,
				mcp: true,
				tool_search: true,
				edit: true,
				bash: true,
				codemode: true,
				read: true,
				write: true,
				spawn_agent: true,
				vuln_submit: true,
				vuln_read: true,
				poc_read: true,
				asset_read: true,
				asset_library_write: true,
				asset_library_read: true,
				mitm_read: true,
			},
			commander: {
				bash: true,
				read: true,
			},
			subagentMaxTurns: 100,
			plugins: {
				main: {
					"key-1": true,
				},
				subagent: {
					"key-1": true,
				},
			},
		},
		effectiveSubagent: {
			web_search: true,
			mcp: true,
			tool_search: true,
			edit: true,
			bash: true,
			codemode: true,
			read: true,
			write: true,
			spawn_agent: true,
			vuln_submit: true,
			vuln_read: true,
			poc_read: true,
			asset_read: true,
			asset_library_write: true,
			asset_library_read: true,
			mitm_read: true,
		},
		presets: [
			{
				id: "id-1",
				label: "示例文本",
				hint: "text",
				main: {
					web_search: true,
					mcp: true,
					tool_search: true,
					edit: true,
					bash: true,
					codemode: true,
					read: true,
					write: true,
					spawn_agent: true,
					vuln_submit: true,
					vuln_read: true,
					poc_read: true,
					asset_read: true,
					asset_library_write: true,
					asset_library_read: true,
					mitm_read: true,
				},
				subagent: {
					web_search: true,
					mcp: true,
					tool_search: true,
					edit: true,
					bash: true,
					codemode: true,
					read: true,
					write: true,
					spawn_agent: true,
					vuln_submit: true,
					vuln_read: true,
					poc_read: true,
					asset_read: true,
					asset_library_write: true,
					asset_library_read: true,
					mitm_read: true,
				},
				commander: {
					bash: true,
					read: true,
				},
			},
		],
		tools: [
			{
				name: "示例文本",
				source: "text",
				active: true,
			},
		],
	},
	notify_config: {
		type: "notify_config",
		config: {
			groups: [
				{
					id: "id-1",
					name: "示例文本",
					enabled: true,
					kinds: {
						runs: true,
						vulns: true,
						codeIntel: true,
						goals: true,
						engines: true,
						pocs: true,
					},
					targets: [
						{
							id: "id-1",
							name: "示例文本",
							channel: "dingtalk",
							enabled: true,
							webhook: "https://example.com",
							secret: "example-credential",
							keyword: "text",
						},
					],
				},
			],
			summaryLimit: 3,
		},
		status: {
			at: 1763973000000,
			ok: true,
			error: "示例错误信息",
			subject: "text",
			deliveries: [
				{
					groupId: "group-1",
					groupName: "示例文本",
					targetId: "target-1",
					targetName: "示例文本",
					channel: "dingtalk",
					ok: true,
				},
			],
		},
	},
	notify_test_result: {
		type: "notify_test_result",
		result: {
			ok: true,
			message: "示例文本",
			detail: "示例文本",
		},
	},
	presets: {
		type: "presets",
		presets: [
			{
				text: "示例文本",
				textMissing: true,
				tokens: 2,
				id: "id-1",
				name: "示例文本",
				description: "nmap -sV -p 443 example.com",
				tags: ["text"],
				placeholder: "text",
				enabled: true,
				createdAt: 1763973000000,
				updatedAt: 1763973000000,
			},
		],
	},
	preset_saved: {
		type: "preset_saved",
		preset: {
			text: "示例文本",
			textMissing: true,
			tokens: 2,
			id: "id-1",
			name: "示例文本",
			description: "nmap -sV -p 443 example.com",
			tags: ["text"],
			placeholder: "text",
			enabled: true,
			createdAt: 1763973000000,
			updatedAt: 1763973000000,
		},
		error: "示例错误信息",
	},
	preset_deleted: {
		type: "preset_deleted",
		id: "id-1",
		ok: true,
		error: "示例错误信息",
	},
	presets_export: {
		type: "presets_export",
		filename: "sentinel-presets-2026-11-24.json",
		content:
			'{\n\t"format": "sentinel-presets",\n\t"version": 1,\n\t"exportedAt": 1763973000000,\n\t"presets": [\n\t\t{\n\t\t\t"id": "preset-1",\n\t\t\t"name": "只读侦察",\n\t\t\t"description": "只做侦察，不改动目标",\n\t\t\t"tags": [\n\t\t\t\t"recon"\n\t\t\t],\n\t\t\t"placeholder": "",\n\t\t\t"text": "只使用只读工具：端口扫描、目录枚举、指纹识别。不执行写入、不利用漏洞。",\n\t\t\t"enabled": true\n\t\t}\n\t]\n}',
	},
	presets_imported: {
		type: "presets_imported",
		imported: [
			{
				text: "示例文本",
				textMissing: true,
				tokens: 2,
				id: "id-1",
				name: "示例文本",
				description: "nmap -sV -p 443 example.com",
				tags: ["text"],
				placeholder: "text",
				enabled: true,
				createdAt: 1763973000000,
				updatedAt: 1763973000000,
			},
		],
		skipped: [
			{
				name: "示例文本",
				reason: "示例错误信息",
			},
		],
		error: "示例错误信息",
	},
	doctrines: {
		type: "doctrines",
		doctrines: [
			{
				id: "id-1",
				name: "示例文本",
				text: "示例文本",
				builtin: true,
			},
		],
	},
	doctrine_saved: {
		type: "doctrine_saved",
		doctrine: {
			id: "id-1",
			name: "示例文本",
			text: "示例文本",
			builtin: true,
		},
		error: "示例错误信息",
	},
	doctrine_deleted: {
		type: "doctrine_deleted",
		id: "id-1",
		ok: true,
		error: "示例错误信息",
	},
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
