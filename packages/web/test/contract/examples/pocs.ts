import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

/** A short template in nuclei's format; the library stores the file verbatim. */
const loginBypass = [
	"id: example-app-login-bypass",
	"",
	"info:",
	"  name: Example App - Unauthenticated Login Bypass",
	"  author: example",
	"  severity: critical",
	"  description: Example App before 2.4.1 accepts a forged token as a session.",
	"  classification:",
	"    cve-id: CVE-2026-31415",
	"  tags: cve,cve2026,example,rce",
	"",
	"http:",
	"  - method: GET",
	"    path:",
	"      - {{BaseURL}}/api/login?token=example",
	"    matchers:",
	"      - type: word",
	"        part: body",
	"        words:",
	"          - authenticated",
	"      - type: status",
	"        status:",
	"          - 200",
	"",
].join("\n");

/** One valid example of each browser-to-server message described in pocs.md. */
export const client = {
	list_pocs: { type: "list_pocs", filters: { severity: "critical", tag: "cve2026" }, page: 2, pageSize: 50 },
	get_poc: { type: "get_poc", id: "example-app-login-bypass" },
	list_poc_sources: { type: "list_poc_sources" },
	save_poc_source: {
		type: "save_poc_source",
		source: {
			name: "内部模板源",
			url: "https://pocs.example.com/templates.zip",
			headerName: "Authorization",
			headerValue: "Bearer example-token",
			intervalHours: 24,
			enabled: true,
		},
	},
	delete_poc_source: { type: "delete_poc_source", id: "3f9a1c2e" },
	sync_poc_source: { type: "sync_poc_source", id: "official" },
	sync_official_pocs: { type: "sync_official_pocs" },
	delete_poc: { type: "delete_poc", id: "example-app-login-bypass" },
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

/** The outcome of the official source's newest sync; it is also its first history row. */
const officialSync = {
	at: "2026-11-24T02:00:12.000Z",
	ok: true,
	trigger: "auto" as const,
	durationMs: 48210,
	imported: 3,
	replaced: 14061,
	skipped: 46,
};

/** A refused sync: the download answered 403, so nothing was imported. */
const refusedSync = {
	at: "2026-11-23T06:30:41.000Z",
	ok: false,
	trigger: "manual" as const,
	durationMs: 1840,
	imported: 0,
	replaced: 0,
	skipped: 0,
	error: "HTTP 403",
};

/** One valid example of each server-to-browser message described in pocs.md. */
export const server = {
	pocs: {
		type: "pocs",
		items: [
			{
				id: "example-app-login-bypass",
				name: "Example App - Unauthenticated Login Bypass",
				severity: "critical",
				tags: ["cve", "cve2026", "example", "rce"],
				references: ["CVE-2026-31415"],
				sourceFile: "nuclei-templates-main/http/cves/2026/CVE-2026-31415.yaml",
				importedAt: "2026-11-24T01:59:24.000Z",
			},
			{
				id: "example-cms-upload-rce",
				name: "Example CMS - Authenticated File Upload RCE",
				severity: "critical",
				tags: ["cve", "cve2026", "example", "upload"],
				references: ["CVE-2026-27182"],
				sourceFile: "nuclei-templates-main/http/cves/2026/CVE-2026-27182.yaml",
				importedAt: "2026-11-23T01:59:18.000Z",
			},
		],
		stats: { total: 14064, bySeverity: { critical: 612, high: 5318, medium: 6021, low: 1680, info: 433 } },
		total: 73,
		page: 2,
		pageSize: 50,
	},
	poc: {
		type: "poc",
		poc: {
			id: "example-app-login-bypass",
			name: "Example App - Unauthenticated Login Bypass",
			severity: "critical",
			tags: ["cve", "cve2026", "example", "rce"],
			references: ["CVE-2026-31415"],
			content: loginBypass,
			sourceFile: "nuclei-templates-main/http/cves/2026/CVE-2026-31415.yaml",
			importedAt: "2026-11-24T01:59:24.000Z",
		},
	},
	poc_sources: {
		type: "poc_sources",
		sources: [
			{
				id: "official",
				name: "官方 NucleiPOC",
				url: "https://github.com/projectdiscovery/nuclei-templates/archive/refs/heads/main.zip",
				headerSet: false,
				intervalHours: 24,
				enabled: true,
				lastSyncAt: "2026-11-24T02:00:12.000Z",
				lastResult: officialSync,
				history: [
					officialSync,
					{
						at: "2026-11-23T02:01:03.000Z",
						ok: true,
						trigger: "auto",
						durationMs: 51470,
						imported: 14,
						replaced: 14050,
						skipped: 46,
					},
				],
			},
			{
				id: "3f9a1c2e",
				name: "内部模板源",
				url: "https://pocs.example.com/templates.zip",
				headerName: "Authorization",
				headerSet: true,
				intervalHours: 24,
				enabled: true,
				lastSyncAt: "2026-11-23T06:30:41.000Z",
				lastResult: refusedSync,
				history: [refusedSync],
			},
		],
	},
	poc_source_result: { type: "poc_source_result", action: "同步", id: "official", ok: true },
	poc_result: { type: "poc_result", action: "删除", id: "example-app-login-bypass", ok: true },
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
