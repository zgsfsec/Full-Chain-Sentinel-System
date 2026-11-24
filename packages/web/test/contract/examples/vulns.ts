import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

/** One valid example of each browser-to-server message described in vulns.md. */
export const client = {
	list_vulns: {
		type: "list_vulns",
		filters: {
			ids: ["id-1"],
			status: "fixed",
			severity: ["low"],
			target: "text",
			search: "text",
			dubious: false,
		},
	},
	get_vuln: {
		type: "get_vuln",
		id: "id-1",
	},
	update_vuln: {
		type: "update_vuln",
		id: "id-1",
		patch: {
			status: "fixed",
			severity: "low",
			cvss: 2,
			note: "示例文本",
		},
	},
	retry_vuln_review: {
		type: "retry_vuln_review",
		id: "id-1",
		force: false,
	},
	review_pending_vulns: {
		type: "review_pending_vulns",
	},
	preview_vuln_delete: {
		type: "preview_vuln_delete",
		ids: ["id-1"],
	},
	delete_vulns: {
		type: "delete_vulns",
		ids: ["id-1"],
	},
	export_vulns: {
		type: "export_vulns",
		filters: {
			ids: ["id-1"],
			status: "fixed",
			severity: ["low"],
			target: "text",
			search: "text",
			dubious: false,
		},
	},
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

/** One valid example of each server-to-browser message described in vulns.md. */
export const server = {
	vulns: {
		type: "vulns",
		items: [
			{
				number: 2,
				description: "nmap -sV -p 443 example.com",
				status: "fixed",
				source: "text",
				id: "id-1",
				projectId: "project-1",
				target: "text",
				title: "示例文本",
				label: "示例文本",
				createdAt: "2026-11-24T08:30:00.000Z",
				updatedAt: "text",
				review: {
					state: "done",
					at: 1763973000000,
				},
				projectName: "示例文本",
				sessionName: "示例文本",
				assetLabel: "示例文本",
				severity: "low",
				cvss: 2,
				cvssVector: "text",
				category: "text",
				platform: "android",
				appPackage: "text",
				appVersion: "text",
				repro: "text",
				remediation: "text",
				references: ["text"],
				severityMismatch: true,
			},
		],
		stats: {
			total: 2,
			bySeverity: {
				low: 2,
				high: 2,
				info: 2,
				medium: 2,
				critical: 2,
			},
			byStatus: {
				fixed: 2,
				pending: 2,
				confirmed: 2,
				false_positive: 2,
			},
		},
		unfiltered: true,
	},
	vuln: {
		type: "vuln",
		vuln: {
			review: {
				state: "done",
				severity: "low",
				cvss: 2,
				cvssVector: "text",
				verdict: "solid",
				reason: "示例错误信息",
				model: "text",
				error: "示例错误信息",
				agentSeverity: "low",
				agentCvss: 2,
				at: 1763973000000,
			},
			id: "id-1",
			label: "示例文本",
			number: 2,
			projectId: "project-1",
			projectName: "示例文本",
			sessionName: "示例文本",
			assetLabel: "示例文本",
			source: "text",
			title: "示例文本",
			severity: "low",
			cvss: 2,
			cvssVector: "text",
			status: "fixed",
			target: "text",
			category: "text",
			platform: "android",
			appPackage: "text",
			appVersion: "text",
			description: "nmap -sV -p 443 example.com",
			packet: "text",
			repro: "text",
			remediation: "text",
			references: ["text"],
			createdAt: "2026-11-24T08:30:00.000Z",
			updatedAt: "text",
			evidence: [
				{
					kind: "file",
				},
			],
			notes: [
				{
					at: "2026-11-24T08:30:00.000Z",
					author: "system",
					text: "示例文本",
				},
			],
			severityMismatch: true,
		},
	},
	vuln_result: {
		type: "vuln_result",
		action: "text",
		ok: true,
		error: "示例错误信息",
	},
	vuln_review_result: {
		type: "vuln_review_result",
		id: "id-1",
		ok: true,
		error: "示例错误信息",
	},
	vuln_delete_preview: {
		type: "vuln_delete_preview",
		count: 2,
		evidence: 2,
		notes: 2,
	},
	vulns_deleted: {
		type: "vulns_deleted",
		count: 2,
	},
	vulns_export: {
		type: "vulns_export",
		filename: "示例文本",
		markdown: "text",
	},
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
