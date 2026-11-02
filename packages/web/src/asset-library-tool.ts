/**
 * The asset inventory tools the agent sees.
 *
 * `asset_report` is how an endpoint reaches the inventory: the agent states what
 * kind of thing it is (a domain, an IP, an IP:port service, or a URL) and the
 * row lands in the project's ledger. Re-reporting the same endpoint merges into
 * the existing row instead of creating a duplicate, so the model does not have
 * to be careful about repeats.
 *
 * `asset_note` appends a test record. The timeline is append-only: correcting a
 * conclusion means appending another record, never editing the old one.
 *
 * `asset_list` and `asset_get` let the model read what the project already
 * holds, so a second pass references the existing label instead of reporting it
 * again. The list is paginated for output size only; the library itself has no
 * cap.
 */

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ASSET_KIND_LABELS,
	ASSET_OUTCOME_LABELS,
	ASSET_STATE_LABELS,
	AssetInputError,
	type AssetLibraryStore,
} from "./asset-library.ts";
import type { SentinelPermissionSet } from "./permissions.ts";
import type {
	SentinelAsset,
	SentinelAssetFilters,
	SentinelAssetKind,
	SentinelAssetOutcome,
	SentinelAssetState,
	SentinelAssetSummary,
	SentinelVulnSummary,
} from "./protocol.ts";
import { SENTINEL_VULN_SEVERITY_LABELS, SENTINEL_VULN_STATUS_LABELS } from "./vulnerabilities.ts";

/** Longest output handed back to the model; context protection, not a data cap. */
const MAX_TOOL_OUTPUT = 8000;

/** Most rows one `asset_list` call returns; the store itself has no such cap. */
const MAX_LIST_LIMIT = 200;

export interface AssetLibraryToolOptions {
	store: AssetLibraryStore;
	/** Project captured when the session was created. */
	getProject: () => { id: string; name: string } | undefined;
	permissions: SentinelPermissionSet;
	getSessionId: () => string | undefined;
	getSessionName?: () => string | undefined;
	getEngineRef?: () => { engineId: string; taskId: string } | undefined;
	/** Who is calling: 主代理 / 子代理 <runId> / 工程任务「…」. */
	getSource: () => string;
	/** Findings linked to an asset; absent when the vuln hub may not be read. */
	listVulnsByAsset?: (assetId: string) => SentinelVulnSummary[];
	onChange?: () => void;
}

interface ReportDetails {
	ok: boolean;
	id?: string;
	label?: string;
	created?: boolean;
	kind?: SentinelAssetKind;
	error?: string;
}

interface NoteDetails {
	ok: boolean;
	id?: string;
	label?: string;
	outcome?: SentinelAssetOutcome;
	status?: SentinelAssetState;
	error?: string;
}

interface ListDetails {
	ok: boolean;
	count: number;
	total: number;
	error?: string;
}

interface GetDetails {
	ok: boolean;
	id?: string;
	label?: string;
	error?: string;
}

function clip(text: string): string {
	if (text.length <= MAX_TOOL_OUTPUT) return text;
	return `${text.slice(0, MAX_TOOL_OUTPUT)}\n…（输出已截断，共 ${text.length} 字符；用筛选或 asset_get 收窄）`;
}

function formatWhen(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return `${date.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

function endpointLine(asset: SentinelAsset | SentinelAssetSummary): string {
	if (asset.kind === "service") {
		const protocol = asset.protocol ? ` ${asset.protocol}` : "";
		return `${asset.name}${protocol}/${asset.transport ?? "tcp"}`;
	}
	return asset.name;
}

function outcomeLabel(outcome: SentinelAssetOutcome | undefined): string {
	return outcome ? ASSET_OUTCOME_LABELS[outcome] : "无结论";
}

function stateLabel(state: SentinelAssetState): string {
	return ASSET_STATE_LABELS[state];
}

function kindLabel(kind: SentinelAssetKind): string {
	return ASSET_KIND_LABELS[kind];
}

function renderListLine(asset: SentinelAssetSummary): string {
	return `${asset.label} | ${kindLabel(asset.kind)} | ${asset.name} | ${stateLabel(asset.status)} | ${asset.testCount} 条 · ${outcomeLabel(asset.lastOutcome)} | ${formatWhen(asset.lastSeenAt)} | ${asset.source}`;
}

function renderTimeline(asset: SentinelAsset): string[] {
	if (asset.entries.length === 0) return ["（还没有测试记录）"];
	const lines: string[] = [];
	for (const [index, entry] of asset.entries.entries()) {
		const author = entry.author === "operator" ? "操作员" : (entry.source ?? "代理");
		const kind = entry.kind === "status" ? "状态" : ASSET_OUTCOME_LABELS[entry.outcome];
		const parts = [`${index + 1}. ${formatWhen(entry.at)} ${author} · ${kind}`];
		if (entry.method) parts.push(`方法：${entry.method}`);
		if (entry.vulnLabel) parts.push(`漏洞：${entry.vulnLabel}`);
		lines.push(parts.join(" · "));
		if (entry.text.trim()) lines.push(`   ${entry.text.replace(/\n/g, "\n   ")}`);
	}
	return lines;
}

function renderDetails(asset: SentinelAsset, vulns: SentinelVulnSummary[] | undefined): string {
	const lines = [
		`${asset.label} ${kindLabel(asset.kind)} ${asset.name}`,
		`状态：${stateLabel(asset.status)} · 测试记录：${asset.testCount} 条 · 最近结论：${outcomeLabel(asset.lastOutcome)}`,
	];
	if (asset.domain) lines.push(`域名：${asset.domain}`);
	if (asset.ip) lines.push(`IP：${asset.ip}`);
	if (asset.port !== undefined) lines.push(`端口：${asset.port}${asset.transport ? `/${asset.transport}` : ""}`);
	if (asset.protocol) lines.push(`协议：${asset.protocol}`);
	if (asset.url) lines.push(`URL：${asset.url}`);
	if (asset.title) lines.push(`标题：${asset.title}`);
	if (asset.server) lines.push(`服务：${asset.server}`);
	if (asset.tech) lines.push(`技术栈：${asset.tech}`);
	if (asset.tags.length > 0) lines.push(`标签：${asset.tags.join("、")}`);
	lines.push(
		`来源：${asset.source}${asset.sessionName ? ` · 会话 ${asset.sessionName}` : ""} · 首次发现 ${formatWhen(asset.firstSeenAt)} · 最近发现 ${formatWhen(asset.lastSeenAt)}`,
	);
	lines.push("", "时间线：", ...renderTimeline(asset));
	if (vulns === undefined) {
		lines.push("", "关联漏洞：未开启漏洞读取（vuln_read），关联漏洞未显示。");
	} else if (vulns.length === 0) {
		lines.push("", "关联漏洞：无。");
	} else {
		lines.push("", "关联漏洞：");
		for (const vuln of vulns) {
			lines.push(
				`  ${vuln.label} | ${SENTINEL_VULN_SEVERITY_LABELS[vuln.severity]} | ${SENTINEL_VULN_STATUS_LABELS[vuln.status]} | ${vuln.target} | ${vuln.title}`,
			);
		}
	}
	if (asset.lastOutcome === "vulnerable" && vulns !== undefined && vulns.length === 0) {
		lines.push("", "注意：最近一次测试结论为「有漏洞」，但没有关联的漏洞中枢记录；确认后请用 vuln_submit 补交。");
	}
	return clip(lines.join("\n"));
}

const resultSchema = Type.Union(
	[
		Type.Literal("note"),
		Type.Literal("clean"),
		Type.Literal("suspicious"),
		Type.Literal("vulnerable"),
		Type.Literal("unreachable"),
	],
	{
		description:
			"Test outcome: clean = tested and found nothing, suspicious = worth another look, vulnerable = confirmed flaw, unreachable = the service did not answer, note = an observation that is not a conclusion.",
	},
);

const reportSchema = Type.Object({
	url: Type.Optional(
		Type.String({
			description:
				"One URL you actually fetched. Pass it alone: it carries its host, port and scheme; do not also pass ip/domain/port.",
		}),
	),
	ip: Type.Optional(Type.String({ description: "Bare IP address, e.g. 10.0.0.5 or ::1." })),
	domain: Type.Optional(
		Type.String({ description: "Bare hostname, e.g. admin.example.com. No scheme, port or path." }),
	),
	port: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 65535,
			description: "Service port. Combine with exactly one of ip or domain to report a service.",
		}),
	),
	transport: Type.Optional(
		Type.Union([Type.Literal("tcp"), Type.Literal("udp")], {
			description: "Transport for a service; defaults to tcp.",
		}),
	),
	protocol: Type.Optional(
		Type.String({ description: "Service protocol on that port, e.g. http, https, ssh, rdp. Not the transport." }),
	),
	title: Type.Optional(Type.String({ description: "Page or host title you observed." })),
	server: Type.Optional(Type.String({ description: "Server banner/header you observed, e.g. nginx/1.24.0." })),
	tech: Type.Optional(Type.String({ description: "Technology fingerprint you observed, e.g. Spring Boot, PHP 8.1." })),
	tags: Type.Optional(
		Type.Array(Type.String(), {
			description: "Short labels such as OA, 后台, 数据库. Comma-separated values are split.",
		}),
	),
	note: Type.Optional(
		Type.String({ description: "Optional observation to record on this report, e.g. what the service returned." }),
	),
	method: Type.Optional(
		Type.String({ description: "Optional method that produced the observation, e.g. curl /login." }),
	),
	result: Type.Optional(resultSchema),
});

const noteSchema = Type.Object({
	asset: Type.String({ minLength: 1, description: "Asset id or label, e.g. E2E-A0001." }),
	result: resultSchema,
	method: Type.Optional(
		Type.String({ description: "Method or command actually used, e.g. nmap -sV, curl /login, 手动 SQL 注入." }),
	),
	text: Type.Optional(Type.String({ description: "What you observed and concluded. method and text: at least one." })),
});

const listSchema = Type.Object({
	kind: Type.Optional(
		Type.Union([Type.Literal("domain"), Type.Literal("ip"), Type.Literal("service"), Type.Literal("url")], {
			description: "Only assets of this kind.",
		}),
	),
	status: Type.Optional(
		Type.Union(
			[Type.Literal("pending"), Type.Literal("testing"), Type.Literal("tested"), Type.Literal("out_of_scope")],
			{ description: "Only assets in this operator state." },
		),
	),
	tested: Type.Optional(
		Type.Boolean({
			description:
				"true = assets with at least one conclusive record; false = assets with none. Notes do not count.",
		}),
	),
	search: Type.Optional(
		Type.String({ description: "Substring match on label, name, host, URL, title, tags or source." }),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_LIST_LIMIT,
			description: `Rows returned in this call; default 50, maximum ${MAX_LIST_LIMIT}. This limits the output, never the library.`,
		}),
	),
});

const getSchema = Type.Object({
	asset: Type.String({ minLength: 1, description: "Asset id or label, e.g. E2E-A0001." }),
});

export function createAssetLibraryTools(options: AssetLibraryToolOptions): ToolDefinition[] {
	const requireProject = (): { id: string; name: string } => {
		const project = options.getProject();
		if (!project) throw new Error("尚未选择项目，无法使用资产库。请先在控制台创建或选择一个项目。");
		return project;
	};

	const report = defineTool({
		name: "asset_report",
		label: "Report asset",
		description:
			"Report one asset into this project's asset library: a domain you resolved, an IP you scanned, an IP:port service you probed, or a URL you fetched. Call it as soon as the asset is actually touched, not at the end of the run. The library is project-scoped and deduplicated: re-reporting the same endpoint merges into its existing record instead of creating a second one. Do not report assets that only appeared in a search-engine result or a wordlist; those are not yours yet. Pass a URL by itself: it already carries its host, port and scheme.",
		promptSnippet:
			"Report a domain, IP, IP:port service or URL you actually touched into the project's asset library",
		promptGuidelines: [
			"Report an asset the first time you actually resolve, connect to, or fetch it; do not wait for the final summary",
			"One call = one endpoint: a URL, a host:port service, a bare IP, or a bare domain",
			"Prefer the IP:port form for a service whose IP you know; host:port and IP:port are separate records",
			"Never bulk-report FOFA / Quake / Hunter results; report only what you touched, unless the operator explicitly asks for an import",
			"Call asset_list first when continuing previous work, so you reuse existing labels instead of guessing",
			"After a test, record the outcome with asset_note; when it confirms a flaw, submit it with vuln_submit and pass this asset's label",
			"Keep credentials out of reported URLs; the tool strips them, but do not put them there in the first place",
		],
		parameters: reportSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<ReportDetails>> {
			try {
				const project = requireProject();
				const sessionId = options.getSessionId();
				const engineRef = options.getEngineRef?.();
				const sessionName = options.getSessionName?.();
				const hasRecord =
					params.result !== undefined ||
					(params.note !== undefined && params.note.trim() !== "") ||
					(params.method !== undefined && params.method.trim() !== "");
				const { created, asset, warnings } = options.store.upsert({
					projectId: project.id,
					projectName: project.name,
					source: options.getSource(),
					...(sessionId ? { sessionId } : {}),
					...(engineRef ? { engineId: engineRef.engineId, taskId: engineRef.taskId } : {}),
					...(sessionName ? { sessionName } : {}),
					identity: {
						...(params.url?.trim() ? { url: params.url } : {}),
						...(params.ip?.trim() ? { ip: params.ip } : {}),
						...(params.domain?.trim() ? { domain: params.domain } : {}),
						...(params.port !== undefined ? { port: params.port } : {}),
						...(params.transport ? { transport: params.transport } : {}),
						...(params.protocol?.trim() ? { protocol: params.protocol } : {}),
					},
					...(params.title?.trim() ? { title: params.title } : {}),
					...(params.server?.trim() ? { server: params.server } : {}),
					...(params.tech?.trim() ? { tech: params.tech } : {}),
					...(params.tags && params.tags.length > 0 ? { tags: params.tags } : {}),
					...(hasRecord
						? {
								record: {
									outcome: params.result ?? "note",
									...(params.method?.trim() ? { method: params.method } : {}),
									text: params.note ?? "",
								},
							}
						: {}),
				});
				options.onChange?.();
				const total = options.store.countByProject(project.id);
				const verb = created ? "新建" : "已存在，合并";
				const recordNote = hasRecord
					? `\n已记录测试记录：${ASSET_OUTCOME_LABELS[params.result ?? "note"]}${params.method?.trim() ? `（${params.method.trim()}）` : ""}。`
					: "";
				const warningNote = warnings.length > 0 ? `\n${warnings.join("\n")}` : "";
				return {
					content: [
						{
							type: "text",
							text: `已上报资产 ${asset.label}（${verb}）：${kindLabel(asset.kind)} ${endpointLine(asset)}。项目内共 ${total} 条资产。${recordNote}${warningNote}`,
						},
					],
					details: { ok: true, id: asset.id, label: asset.label, created, kind: asset.kind },
				};
			} catch (error) {
				if (error instanceof AssetInputError) {
					return {
						content: [{ type: "text", text: error.message }],
						details: { ok: false, error: error.message },
						isError: true,
					};
				}
				throw error;
			}
		},
	});

	const note = defineTool({
		name: "asset_note",
		label: "Record asset test",
		description:
			"Append one test record to an asset already in this project's library. Use it after each validation attempt (port scan, HTTP request, login test, manual check) so the asset's timeline tells the next pass what was already done. Records are append-only: to correct an earlier conclusion, append a new record that says so. A conclusive result on a pending asset marks it as tested; it does not change an operator-set status.",
		promptSnippet: "Append a test result (clean / suspicious / vulnerable / unreachable / note) to a recorded asset",
		promptGuidelines: [
			"Use result=clean when a test found nothing, vulnerable when it confirmed a flaw, suspicious when something needs a second look, unreachable when the service did not answer, and note for an observation that is not a conclusion",
			"Name the method actually used (e.g. 'nmap -sV', 'curl /login', 'manual SQL injection') and state what you observed",
			"If the test proved a vulnerability, submit it with vuln_submit and pass this asset's label instead of recording only 'vulnerable' here",
		],
		parameters: noteSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<NoteDetails>> {
			try {
				const project = requireProject();
				const asset = options.store.find(project.id, params.asset);
				if (!asset) {
					return {
						content: [
							{
								type: "text",
								text: `当前项目没有编号为 ${params.asset} 的资产。先用 asset_report 上报，或 asset_list 查编号。`,
							},
						],
						details: { ok: false, error: "not-found" },
						isError: true,
					};
				}
				const method = params.method?.trim();
				const text = params.text ?? "";
				if (!method && text.trim() === "") {
					return {
						content: [{ type: "text", text: "至少提供 method 或 text：测试记录要能说清做了什么或看到了什么。" }],
						details: { ok: false, error: "empty-record" },
						isError: true,
					};
				}
				const updated = options.store.appendEntry(asset.id, {
					author: "agent",
					source: options.getSource(),
					outcome: params.result,
					...(method ? { method } : {}),
					text,
				});
				options.onChange?.();
				return {
					content: [
						{
							type: "text",
							text: `已记录到 ${asset.label}：${ASSET_OUTCOME_LABELS[params.result]}${method ? ` · ${method}` : ""}。测试记录 ${updated?.testCount ?? asset.testCount + 1} 条，状态：${stateLabel(updated?.status ?? asset.status)}。`,
						},
					],
					details: {
						ok: true,
						id: asset.id,
						label: asset.label,
						outcome: params.result,
						status: updated?.status ?? asset.status,
					},
				};
			} catch (error) {
				if (error instanceof AssetInputError) {
					return {
						content: [{ type: "text", text: error.message }],
						details: { ok: false, error: error.message },
						isError: true,
					};
				}
				throw error;
			}
		},
	});

	const list = defineTool({
		name: "asset_list",
		label: "List assets",
		description:
			"List the assets already recorded for this project, newest seen first. Use it before reporting or when deciding what to test next; combine kind, status, tested and search to narrow the list. This reads the library; it never changes it.",
		promptSnippet: "List assets already recorded for this project, with filters for kind, status and test evidence",
		promptGuidelines: [
			"At the start of an assessment or when resuming work on a target, use asset_list with the target as search to check existing assets and test history before repeating reconnaissance; use asset_get on relevant records for their full timeline. Existing records do not expand the task's target scope",
		],
		parameters: listSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<ListDetails>> {
			try {
				const project = requireProject();
				const filters: SentinelAssetFilters = {
					...(params.kind ? { kind: params.kind } : {}),
					...(params.status ? { status: params.status } : {}),
					...(params.tested !== undefined ? { tested: params.tested } : {}),
					...(params.search?.trim() ? { search: params.search.trim() } : {}),
				};
				const limit = Math.min(Math.max(1, params.limit ?? 50), MAX_LIST_LIMIT);
				const view = options.store.list(project.id, filters, 1, limit);
				if (view.total === 0) {
					return {
						content: [{ type: "text", text: "当前项目还没有符合条件的资产。" }],
						details: { ok: true, count: 0, total: 0 },
					};
				}
				const body = view.items.map(renderListLine).join("\n");
				const notes: string[] = [];
				if (view.total > view.items.length) {
					notes.push(
						`本页 ${view.items.length} 条，共 ${view.total} 条；用 kind / status / tested / search 收窄，或调大 limit（最多 ${MAX_LIST_LIMIT}）。`,
					);
				}
				const text = [
					`当前项目 ${view.total} 条资产（编号 | 类型 | 名称 | 状态 | 测试 | 最近发现 | 来源）：`,
					body,
					...notes,
				].join("\n");
				return {
					content: [{ type: "text", text: clip(text) }],
					details: { ok: true, count: view.items.length, total: view.total },
				};
			} catch (error) {
				if (error instanceof Error && error.message.includes("尚未选择项目")) {
					return {
						content: [{ type: "text", text: error.message }],
						details: { ok: false, count: 0, total: 0, error: error.message },
						isError: true,
					};
				}
				throw error;
			}
		},
	});

	const get = defineTool({
		name: "asset_get",
		label: "Get asset",
		description:
			"Read one asset with its full test timeline and the findings linked to it, by id or by its human-readable label (e.g. E2E-A0001).",
		promptSnippet: "Read one asset with its full test timeline and linked findings",
		parameters: getSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<GetDetails>> {
			try {
				const project = requireProject();
				const asset = options.store.find(project.id, params.asset);
				if (!asset) {
					return {
						content: [{ type: "text", text: `当前项目没有编号为 ${params.asset} 的资产。` }],
						details: { ok: false, error: "not-found" },
						isError: true,
					};
				}
				const vulns = options.listVulnsByAsset?.(asset.id);
				return {
					content: [{ type: "text", text: renderDetails(asset, vulns) }],
					details: { ok: true, id: asset.id, label: asset.label },
				};
			} catch (error) {
				if (error instanceof Error && error.message.includes("尚未选择项目")) {
					return {
						content: [{ type: "text", text: error.message }],
						details: { ok: false, error: error.message },
						isError: true,
					};
				}
				throw error;
			}
		},
	});

	const tools: ToolDefinition[] = [];
	if (options.permissions.asset_library_write) tools.push(report, note);
	if (options.permissions.asset_library_read) tools.push(list, get);
	return tools;
}
