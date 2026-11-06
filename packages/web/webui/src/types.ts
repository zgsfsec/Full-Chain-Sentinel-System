/** Client-side view of the Full Chain Sentinel wire protocol (mirrors packages/web/src/protocol.ts). */

import type { CodeVulnTag } from "../../src/code-vuln-tags.ts";
import type { CodeReproductionResult } from "../../src/code-reproduction.ts";
import type { UiLanguage } from "../../src/i18n-messages.ts";
import { t } from "./i18n.ts";

export type SentinelMode = "review" | "ai" | "auto";

/** The three modes in the order the toolbar offers them. */
export const SENTINEL_MODES: readonly SentinelMode[] = ["review", "ai", "auto"];

export const SENTINEL_MODE_LABELS: Record<SentinelMode, string> = {
	review: t("审批模式"),
	ai: t("AI 审批"),
	auto: t("自动执行"),
};

/**
 * Every page the console can show in the content area. The sider navigates
 * between them; 文件 and 子代理 are overlays opened from the chat page.
 */
export type SentinelPageId =
	| "dashboard"
	| "chat"
	| "projects"
	| "proxies"
	| "vulns"
	| "assets"
	| "mitm"
	| "webfuzz"
	| "pocs"
	| "codeintel"
	| "apimodels"
	| "droid"
	| "ios"
	| "engine"
	| "gates"
	| "supervisor"
	| "settings.model"
	| "settings.supervisor"
	| "settings.notify"
	| "settings.permissions"
	| "settings.environment"
	| "settings.security"
	| "settings.presets"
	| "settings.pocs"
	| "settings.assets"
	| "settings.websearch"
	| "settings.mcp"
	| "settings.plugins"
	/** A pinned plugin UI page: `plugin:<hostId>:<pluginId>`. */
	| `plugin:${string}`
	| "about";

/** Reasoning effort levels pi accepts, ascending. */
export type SentinelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Image attachment carried with a prompt (base64 payload, no data-URL prefix). */
export interface SentinelImageAttachment {
	type: "image";
	data: string;
	mimeType: string;
}

/** One directory entry in the container work directory. */
export interface SentinelFileEntry {
	name: string;
	path: string;
	type: "dir" | "file";
	size: number;
	/** Unix seconds. */
	mtime: number;
}

/** Bounded inline view of one file. */
/**
 * The operator's shell in a project container, kept alive when its panel closes.
 */
export interface SentinelTerminalSession {
	status: "running" | "exited";
	projectId: string;
	projectName: string;
	container: string;
	cols: number;
	rows: number;
	startedAt: number;
	code: number | null;
}

export interface SentinelFilePreview {
	path: string;
	kind: "text" | "image" | "binary";
	size: number;
	truncated: boolean;
	text?: string;
	data?: string;
	mimeType?: string;
}

export type SentinelSubagentStatus = "running" | "done" | "error" | "aborted";

/** One normalized step of a sub-agent's process. */
export interface SentinelSubagentEvent {
	seq: number;
	kind: "text" | "thinking" | "tool_start" | "tool_end" | "turn" | "status";
	at: number;
	text?: string;
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
	output?: string;
	isError?: boolean;
	status?: SentinelSubagentStatus;
	note?: string;
	/** How long the call ran, on `tool_end` only; lets the panel show a slow step. */
	durationMs?: number;
	/** Set on commander `text` events typed by the operator, for the chat feed. */
	from?: "operator";
	/** Set when the stored payload exceeded the per-step cap and was cut down. */
	truncated?: boolean;
}

export interface SentinelSubagentRun {
	id: string;
	sessionId: string;
	task: string;
	status: SentinelSubagentStatus;
	turns: number;
	startedAt: string;
	endedAt?: string;
	result?: string;
	error?: string;
	events?: SentinelSubagentEvent[];
}

/** USD prices per million tokens, matching pi's model schema. */
export interface SentinelModelCostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Best-effort prompt cache lifetime in seconds, per retention tier. */
export interface SentinelModelPromptCache {
	short?: number;
	long?: number;
}

/** What pi needs to know about a model beyond its id. */
export interface SentinelModelCapabilities {
	api?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	cost?: SentinelModelCostRates;
	promptCache?: SentinelModelPromptCache;
}

export interface SentinelModelConfig {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	/** Present when the operator declared capabilities for this model. */
	capabilities?: SentinelModelCapabilities;
}

/** The jobs a model can be assigned to. */
export type SentinelModelRoleName = "main" | "judge" | "reviewer" | "supervisor" | "commander" | "monitor";

/** One row of the model library. The key itself never leaves the server. */
export interface SentinelModelEntryView {
	id: string;
	name: string;
	baseUrl: string;
	modelId: string;
	hasKey: boolean;
	roles: SentinelModelRoleName[];
	api: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: SentinelModelCostRates | null;
	promptCache: SentinelModelPromptCache | null;
}

/**
 * One channel (provider) in the built-in catalog. The add-model form picks a
 * channel first, then a model inside it.
 */
export interface SentinelBuiltinChannel {
	provider: string;
	name: string;
	api: string;
	baseUrl: string;
	baseUrls: string[];
	modelCount: number;
	featured: boolean;
}

/** One built-in catalog entry offered as a capability template. */
export interface SentinelBuiltinModelDefaults {
	provider: string;
	providerName: string;
	/** Catalog id; differs from the typed id when this is an approximate match. */
	modelId: string;
	api: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: SentinelModelCostRates;
	promptCache: SentinelModelPromptCache | null;
	/** No same-id entry existed; the form offers this as a choice only. */
	approximate?: true;
}

/** One built-in catalog model offered as a ready-made preset in the editor. */
export interface SentinelBuiltinModelPreset extends SentinelBuiltinModelDefaults {
	/** Catalog display name; prefills an empty name field. */
	name: string;
	/** Catalog endpoint; prefills an empty Base URL field. */
	baseUrl: string;
}

/** What a role resolves to right now. */
export interface SentinelResolvedModelView {
	entryId: string;
	entryName: string;
	modelId: string;
	followedMain: boolean;
}

/** The whole model screen: library, role assignments, resolved endpoints. */
export interface SentinelModelLibraryView {
	entries: SentinelModelEntryView[];
	roles: {
		main: string | null;
		judge: string;
		reviewer: string;
		supervisor: string;
		commander: string;
		monitor: string;
	};
	reviewerAuto: boolean;
	resolved: {
		main: SentinelResolvedModelView | null;
		judge: SentinelResolvedModelView | null;
		reviewer: SentinelResolvedModelView | null;
		supervisor: SentinelResolvedModelView | null;
		commander: SentinelResolvedModelView | null;
		monitor: SentinelResolvedModelView | null;
	};
}

/** Every tool switch the permissions screen offers. */
export type SentinelPermissionKey =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "codemode"
	| "tool_search"
	| "mcp"
	| "spawn_agent"
	| "vuln_submit"
	| "vuln_read"
	| "poc_read"
	| "asset_read"
	| "asset_library_write"
	| "asset_library_read"
	| "mitm_read"
	| "web_search";

/** The switches of one agent; a missing entry means "not allowed". */
export type SentinelPermissionSet = Record<SentinelPermissionKey, boolean>;

export type SentinelCommanderPermissionKey = "bash" | "read";

export type SentinelCommanderPermissionSet = Record<SentinelCommanderPermissionKey, boolean>;

/** Per-plugin mount switches keyed by `${hostId}/${pluginId}`; absent means allowed. */
export type SentinelPluginPermissionMap = Record<string, boolean>;

export interface SentinelAgentPluginPermissions {
	main: SentinelPluginPermissionMap;
	subagent: SentinelPluginPermissionMap;
}

export interface SentinelPermissionsConfig {
	main: SentinelPermissionSet;
	subagent: SentinelPermissionSet;
	commander: SentinelCommanderPermissionSet;
	/** Turn budget before one sub-agent run is aborted. */
	subagentMaxTurns: number;
	/** Per-plugin mount switches, one set per agent. */
	plugins: SentinelAgentPluginPermissions;
}

export interface SentinelPermissionPreset {
	commander: SentinelCommanderPermissionSet;
	id: string;
	label: string;
	hint: string;
	main: SentinelPermissionSet;
	subagent: SentinelPermissionSet;
}

/** One tool the live session actually mounted, for the read-only inventory. */
export interface SentinelToolInfo {
	name: string;
	source: string;
	/** Whether the model sees it right now, as opposed to codemode/deferred only. */
	active: boolean;
}

export interface SentinelTestResult {
	ok: boolean;
	message: string;
	detail?: string;
}

/** The two chat robots a finished notification can go to. */
export type SentinelNotifyChannel = "dingtalk" | "feishu" | "wecom";

/** One robot's connection settings. */
export interface SentinelNotifyChannelConfig {
	enabled: boolean;
	webhook: string;
	secret: string;
	keyword: string;
}

/** Notification configuration (mirrors notifications.json). */
export interface SentinelNotifyConfig extends SentinelNotifyChannelConfig {
	/** Which notifications to push while either channel is enabled; all default on. */
	kinds: { runs: boolean; vulns: boolean; goals: boolean; engines: boolean; pocs: boolean };
	/** Characters of notification body to keep per section; 0 keeps all of it. */
	summaryLimit: number;
	feishu: SentinelNotifyChannelConfig;
	/** WeCom group robot: webhook only (no signing/keyword on the platform). */
	wecom: SentinelNotifyChannelConfig;
}

/** Outcome of the most recent notification send. */
export interface SentinelNotifyStatus {
	at: number | null;
	ok: boolean;
	error?: string;
	subject?: string;
	channels?: Partial<Record<SentinelNotifyChannel, { ok: boolean; error?: string }>>;
}

export interface SentinelApprovalRequest {
	id: string;
	command: string;
	cwd: string;
	source?: string;
}

export interface SentinelProjectInfo {
	id: string;
	name: string;
	cwd: string;
	/** Docker container executing this project's tools. */
	container?: string | null;
	/** Sessions recorded for this project, counted from the session directory. */
	sessionCount?: number;
	/** Docker's view of the container: absent when there is no container at all. */
	state?: "running" | "stopped" | "missing";
	/** The operator stopped this container on purpose, so it needs an explicit start. */
	manualStop?: boolean;
	/** Findings recorded for this project, so its deletion can state what it takes. */
	vulnCount?: number;
	/** Inventory assets recorded for this project, for the same reason. */
	assetCount?: number;
	/** Gatekeeper judgments recorded for this project, for the same reason. */
	gateCount?: number;
	/**
	 * Proxy this project's container is created with: absent follows the default
	 * on the 代理 page, `null` means no proxy, an id names a profile.
	 */
	proxyId?: string | null;
	/** Name of the profile that id resolves to, for the row's tag. */
	proxyName?: string | null;
	/**
	 * The node of that profile's subscription, when the project pins one. Absent
	 * follows the profile's own choice, which is what most projects do.
	 */
	proxyNode?: string;
	/** Name of the node that will actually be used, resolved; null when there is none. */
	proxyNodeName?: string | null;
}

// ---------------------------------------------------------------------------
// Gatekeeper (审批)
// ---------------------------------------------------------------------------

export type SentinelGateDecisionKind = "allow" | "block" | "failed";

/**
 * Who let the call through. Every tool call lands in exactly one bucket:
 * `ai` is judged by the gatekeeper, `human` is an operator approval, `auto` is
 * nobody. The audit page groups the first as 「AI 审批」 and the other two as
 * 「自动审批」.
 */
export type SentinelGateApproval = "ai" | "human" | "auto";

/** One gatekeeper judgment. */
export interface SentinelGateDecision {
	id: string;
	at: number;
	projectId: string | null;
	projectName: string | null;
	sessionId: string | null;
	/** Which agent issued it: 主代理 / 子代理 / 工程任务「X」. */
	source: string;
	tool: string;
	command: string;
	commandTruncated?: boolean;
	cwd: string | null;
	/** Who let it through; see SentinelGateApproval. */
	approval: SentinelGateApproval;
	decision: SentinelGateDecisionKind;
	reason?: string;
	latencyMs: number;
	model?: string;
	/** Display name of the library entry the endpoint came from. */
	modelFrom?: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	error?: string;
}

/** Audit list filters; every field is optional and they combine with AND. */
export interface SentinelGateFilter {
	decision?: SentinelGateDecisionKind;
	projectId?: string;
	sessionId?: string;
	source?: string;
	/** Which buckets to include; an absent or empty list means all three. */
	approval?: SentinelGateApproval[];
	search?: string;
	since?: number;
}

/** The audit page's two tabs; 「自动审批」 is two buckets at once. */
export type SentinelGateTab = "ai" | "auto";

/** The buckets each tab shows. */
export const SENTINEL_GATE_TAB_BUCKETS: Record<SentinelGateTab, SentinelGateApproval[]> = {
	ai: ["ai"],
	auto: ["auto", "human"],
};

export interface SentinelGateStats {
	total: number;
	byDecision: Record<SentinelGateDecisionKind, number>;
	/** Rows per approval bucket, so each tab can summarise itself. */
	byApproval: Record<SentinelGateApproval, number>;
	blockRate: number;
	avgLatencyMs: number;
	totalTokens: number;
	last24h: number;
	failures: number;
	lastFailureAt: number | null;
	lastSuccessAt: number | null;
	lastError: string | null;
}

export interface SentinelGatePage {
	items: SentinelGateDecision[];
	total: number;
	page: number;
	pageSize: number;
}

/** Which non-shell tools the judge also sees, on top of the always-on bash gate. */
export interface SentinelMcpToolGate {
	enabled: boolean;
	/** Include plugin-host tools (server names `plugin-*`). */
	includePlugins: boolean;
}

export interface SentinelGatekeeperConfig {
	mode: SentinelMode;
	timeoutMs: number;
	concurrency: number;
	mcpTools: SentinelMcpToolGate;
}

/** Live gatekeeper state carried in every snapshot. */
export interface SentinelGatekeeperView {
	globalMode: SentinelMode;
	sessionMode: SentinelMode;
	sessionOverride: SentinelMode | null;
	/** The endpoint the 守门模型 role resolves to; null when nothing resolves. */
	judgeResolved: SentinelResolvedModelView | null;
	failures: number;
	lastFailureAt: number | null;
	/** When the judge last answered; newer than `lastFailureAt` means it recovered. */
	lastSuccessAt: number | null;
	lastError: string | null;
}

export const SENTINEL_GATE_DECISION_LABELS: Record<SentinelGateDecisionKind, string> = {
	allow: t("放行"),
	block: t("拦截"),
	failed: t("请求失败"),
};

/** How a call got through, in the row badge and the stat tiles. */
export const SENTINEL_GATE_APPROVAL_LABELS: Record<SentinelGateApproval, string> = {
	ai: t("AI 判定"),
	human: t("人工放行"),
	auto: t("自动放行"),
};

/** Severity buckets of the vulnerability hub. */
export type SentinelVulnSeverity = "critical" | "high" | "medium" | "low" | "info";

/** Lifecycle of one finding; the agent always creates `pending`. */
export type SentinelVulnStatus = "pending" | "confirmed" | "false_positive" | "fixed";

export const SENTINEL_VULN_SEVERITIES: readonly SentinelVulnSeverity[] = ["critical", "high", "medium", "low", "info"];

export const SENTINEL_VULN_SEVERITY_LABELS: Record<SentinelVulnSeverity, string> = {
	critical: t("严重"),
	high: t("高危"),
	medium: t("中危"),
	low: t("低危"),
	info: t("信息"),
};

export const SENTINEL_VULN_STATUS_LABELS: Record<SentinelVulnStatus, string> = {
	pending: t("待确认"),
	confirmed: t("已确认"),
	false_positive: t("误报"),
	fixed: t("已修复"),
};

/** One piece of supporting evidence: a command with its output, or a container file. */
export interface SentinelVulnEvidence {
	kind: "command" | "file";
	command?: string;
	output?: string;
	path?: string;
	note?: string;
}

/** One entry of a finding's timeline. */
export interface SentinelVulnNote {
	at: string;
	author: "agent" | "operator" | "system";
	text: string;
	statusFrom?: SentinelVulnStatus;
	statusTo?: SentinelVulnStatus;
}

export interface SentinelVulnReview {
	state: "queued" | "done" | "failed" | "skipped";
	severity?: SentinelVulnSeverity;
	cvss?: number;
	cvssVector?: string;
	verdict?: "solid" | "dubious";
	reason?: string;
	model?: string;
	error?: string;
	/** The agent's own rating, kept beside the reviewer's verdict. */
	agentSeverity?: SentinelVulnSeverity;
	agentCvss?: number;
	at: number;
}

export interface SentinelVulnerability {
	/** The reviewer LLM's verdict; a fresh submission starts as "queued". */
	review: SentinelVulnReview;
	id: string;
	label: string;
	number: number;
	projectId: string;
	projectName: string;
	sessionId?: string;
	/** Engineering provenance: the engine and task this finding came from. */
	engineId?: string;
	taskId?: string;
	/** Session display name at submission time, for records whose session is gone. */
	sessionName?: string;
	/** Inventory asset this finding is linked to, when the submitter named one. */
	assetId?: string;
	/** Asset label snapshot, so the hub can show it after the asset is gone. */
	assetLabel?: string;
	source: string;
	title: string;
	severity: SentinelVulnSeverity;
	cvss: number;
	cvssVector?: string;
	status: SentinelVulnStatus;
	target: string;
	category?: string;
	description: string;
	packet: string;
	repro?: string;
	remediation?: string;
	references?: string[];
	createdAt: string;
	updatedAt: string;
	evidence: SentinelVulnEvidence[];
	notes: SentinelVulnNote[];
	/** The CVSS score maps to a different bucket than `severity`. */
	severityMismatch: boolean;
}

export type SentinelVulnSummary = Omit<SentinelVulnerability, "packet" | "evidence" | "notes">;

export interface SentinelVulnFilters {
	/** Restrict to selected records; an empty selection matches nothing. */
	ids?: string[];
	status?: SentinelVulnStatus;
	/** Match any selected level; omitted or empty means all levels. */
	severity?: SentinelVulnSeverity[];
	target?: string;
	/** Matches id, title, type, description and the origin/source text. */
	search?: string;
	/** Exact session the finding was submitted from. */
	sessionId?: string;
	/** Exact engineering engine (工程) the finding came from. */
	engineId?: string;
	/** Exact engineering task inside that engine. */
	taskId?: string;
	/** Exact inventory asset the finding is linked to. */
	assetId?: string;
	/** Only records the reviewer marked as dubious (hallucination suspects). */
	dubious?: boolean;
}

export interface SentinelVulnUpdate {
	status?: SentinelVulnStatus;
	severity?: SentinelVulnSeverity;
	cvss?: number;
	note?: string;
}

export interface SentinelVulnStats {
	total: number;
	bySeverity: Record<SentinelVulnSeverity, number>;
	byStatus: Record<SentinelVulnStatus, number>;
}

// --- 资产库（Agent 上报的资产台账） ---

export type SentinelAssetKind = "domain" | "ip" | "service" | "url";
export type SentinelAssetState = "pending" | "testing" | "tested" | "out_of_scope";
export type SentinelAssetOutcome = "note" | "clean" | "suspicious" | "vulnerable" | "unreachable";

export interface SentinelAssetEntry {
	seq: number;
	/** record = test/remark (counted); status = operator state change (not counted). */
	kind: "record" | "status";
	at: string;
	author: "agent" | "operator";
	source?: string;
	outcome: SentinelAssetOutcome;
	method?: string;
	text: string;
	vulnLabel?: string;
}

export interface SentinelAssetSummary {
	id: string;
	label: string;
	number: number;
	projectId: string;
	projectName: string;
	kind: SentinelAssetKind;
	name: string;
	host: string;
	domain?: string;
	ip?: string;
	port?: number;
	transport?: "tcp" | "udp";
	protocol?: string;
	url?: string;
	title?: string;
	server?: string;
	tech?: string;
	tags: string[];
	status: SentinelAssetState;
	source: string;
	sessionId?: string;
	engineId?: string;
	taskId?: string;
	sessionName?: string;
	testCount: number;
	lastOutcome?: SentinelAssetOutcome;
	lastTestedAt?: string;
	firstSeenAt: string;
	lastSeenAt: string;
	createdAt: string;
	updatedAt: string;
}

export interface SentinelAsset extends SentinelAssetSummary {
	entries: SentinelAssetEntry[];
}

export interface SentinelAssetDetail {
	asset: SentinelAsset;
	vulns: SentinelVulnSummary[];
}

export interface SentinelAssetFilters {
	kind?: SentinelAssetKind;
	status?: SentinelAssetState;
	tested?: boolean;
	search?: string;
}

export interface SentinelAssetUpdate {
	status?: SentinelAssetState;
	tags?: string[];
	outcome?: SentinelAssetOutcome;
	note?: string;
}

export interface SentinelAssetStats {
	total: number;
	byKind: Record<SentinelAssetKind, number>;
	byStatus: Record<SentinelAssetState, number>;
	tested: number;
	untested: number;
}

export interface SentinelAssetDeletePreview {
	count: number;
	records: number;
	vulns: number;
}

export const SENTINEL_ASSET_KINDS: readonly SentinelAssetKind[] = ["domain", "ip", "service", "url"];
export const SENTINEL_ASSET_STATES: readonly SentinelAssetState[] = ["pending", "testing", "tested", "out_of_scope"];
export const SENTINEL_ASSET_OUTCOMES: readonly SentinelAssetOutcome[] = [
	"note",
	"clean",
	"suspicious",
	"vulnerable",
	"unreachable",
];
export const SENTINEL_ASSET_KIND_LABELS: Record<SentinelAssetKind, string> = {
	domain: t("域名"),
	ip: t("IP"),
	service: t("服务"),
	url: t("URL"),
};
export const SENTINEL_ASSET_STATE_LABELS: Record<SentinelAssetState, string> = {
	pending: t("待测试"),
	testing: t("测试中"),
	tested: t("已测试"),
	out_of_scope: t("范围外"),
};
export const SENTINEL_ASSET_OUTCOME_LABELS: Record<SentinelAssetOutcome, string> = {
	note: t("备注"),
	clean: t("无发现"),
	suspicious: t("可疑"),
	vulnerable: t("有漏洞"),
	unreachable: t("不可达"),
};

// --- POC 库（Nuclei 模板中心；对 agent 只读） ---

export type SentinelPocSeverity = SentinelVulnSeverity;

export interface SentinelPoc {
	id: string;
	name: string;
	severity: SentinelPocSeverity;
	tags: string[];
	references: string[];
	content: string;
	sourceFile: string;
	importedAt: string;
}

export type SentinelPocSummary = Omit<SentinelPoc, "content">;

export interface SentinelPocFilters {
	search?: string;
	severity?: SentinelPocSeverity;
	tag?: string;
}

export interface SentinelPocStats {
	total: number;
	bySeverity: Record<SentinelPocSeverity, number>;
}

export interface SentinelPocImportOutcome {
	imported: number;
	replaced: number;
	skipped: { name: string; reason: string }[];
}

export interface SentinelPocImportProgress {
	processed: number;
	imported: number;
	replaced: number;
	skipped: number;
	current: string;
}

export type SentinelPocImportJobStatus = "queued" | "running" | "done" | "error";

export interface SentinelPocImportJobView {
	id: string;
	name: string;
	status: SentinelPocImportJobStatus;
	progress: SentinelPocImportProgress;
	outcome?: SentinelPocImportOutcome;
	error?: string;
}

// --- POC 订阅（远程 zip 源；只增不减） ---

/**
 * Id of the source the one-click official sync owns. Mirrors
 * `OFFICIAL_SOURCE_ID` in the server: the button compares against it to show
 * that row as busy, and the page uses it to read that source's last outcome.
 */
export const SENTINEL_OFFICIAL_POC_SOURCE_ID = "official";

export interface SentinelPocSource {
	id: string;
	name: string;
	url: string;
	headerName?: string;
	headerSet: boolean;
	intervalHours: number;
	enabled: boolean;
	lastSyncAt: string | null;
	lastResult: SentinelPocSyncRecord | null;
	/** Recent sync outcomes, newest first (bounded server-side). */
	history: SentinelPocSyncRecord[];
}

export interface SentinelPocSyncRecord {
	at: string;
	ok: boolean;
	trigger: "manual" | "auto";
	durationMs: number;
	imported: number;
	replaced: number;
	skipped: number;
	error?: string;
}

export interface SentinelPocSourceSave {
	id?: string;
	name: string;
	url: string;
	headerName?: string;
	headerValue?: string;
	intervalHours: number;
	enabled: boolean;
}

// ---------------------------------------------------------------------------
// 开源漏洞监测（Open-source vulnerability watch）
// ---------------------------------------------------------------------------

export type SentinelCodeVerdict = "pending" | "security" | "not_security" | "failed";

export type SentinelCodeScheduleKind = "interval" | "cron";

export type SentinelCodeCheckTrigger = "manual" | "auto" | "batch";

export type SentinelCodeCheckStatus = "running" | "ok" | "error";

export type SentinelCodeCommitStatus = "new" | "dispatching" | "dispatched" | "ignored";

export type SentinelCodeReproductionStage = "git" | "engineering" | "paused" | "completed" | "stopped" | "failed";

/** Coarse vulnerability class on a security verdict; drives filtering and auto-dispatch. */
export type SentinelVulnCategory = "web" | "memory" | "other";

export interface SentinelCodeMonitor {
	id: string;
	projectId: string;
	projectName: string;
	name: string;
	host: string;
	owner: string;
	repo: string;
	repoUrl: string;
	apiBaseUrl: string;
	branches: string[];
	baselines: Record<string, string>;
	tokenSet: boolean;
	autoDispatch: boolean;
	autoDispatchCategories: SentinelVulnCategory[] | null;
	autoDispatchTags: CodeVulnTag[] | null;
	intervalMinutes: number;
	scheduleKind: SentinelCodeScheduleKind;
	cronExpression: string | null;
	nextCheckAt: number | null;
	checkState: "idle" | "queued" | "running";
	enabled: boolean;
	lastCheckAt: number | null;
	lastError: string | null;
	createdAt: number;
	findingCount: number;
	pendingCount: number;
}

export interface SentinelCodeCommit {
	id: string;
	monitorId: string;
	projectId: string;
	branch: string;
	sha: string;
	shortSha: string;
	title: string;
	message: string;
	author: string;
	authoredAt: number;
	url: string;
	verdict: SentinelCodeVerdict;
	confidence: number | null;
	cve: string | null;
	severity: SentinelVulnSeverity | null;
	vulnType: string | null;
	vulnCategory: SentinelVulnCategory | null;
	vulnTags: CodeVulnTag[];
	reason: string | null;
	status: SentinelCodeCommitStatus;
	reproductionStage: SentinelCodeReproductionStage | null;
	engineId: string | null;
	duplicateOf: string | null;
	error: string | null;
	additions: number;
	deletions: number;
	files: number;
	diff: string | null;
	createdAt: number;
	judgedAt: number | null;
}

/** Progress of the client-side sequential monitor import queue. */
export type SentinelCodeActivityFilter =
	| "attention"
	| "review"
	| "failed"
	| "dispatch_failed"
	| "pending"
	| "reproducing"
	| "finished"
	| "all";

export interface SentinelCodeActivityCounts {
	attention: number;
	review: number;
	failed: number;
	dispatchFailed: number;
	pending: number;
	anomalies: number;
	reproducing: number;
	finished: number;
}

export interface SentinelCodeActivityView {
	items: SentinelCodeCommit[];
	total: number;
	page: number;
	pageSize: number;
	counts: SentinelCodeActivityCounts;
}

export interface SentinelCodeImportState {
	total: number;
	processed: number;
	succeeded: number;
	failed: number;
	current: string | null;
	running: boolean;
	errors: { url: string; error: string }[];
}

export interface SentinelCodeCheckJob {
	id: string;
	monitorId: string;
	projectId: string;
	host: string;
	trigger: SentinelCodeCheckTrigger;
	status: SentinelCodeJobStatus;
	attempts: number;
	maxAttempts: number;
	nextRunAt: number;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
	error: string | null;
	checkId: string | null;
}

export type SentinelCodeJobStatus = "queued" | "running" | "done" | "failed";

export interface SentinelCodeCheckLog {
	id: string;
	monitorId: string;
	trigger: SentinelCodeCheckTrigger;
	status: SentinelCodeCheckStatus;
	startedAt: number;
	endedAt: number | null;
	commits: number;
	findings: number;
	error: string | null;
}

export interface SentinelCodeMonitorDetail {
	monitor: SentinelCodeMonitor;
	commits: SentinelCodeCommit[];
	checks: SentinelCodeCheckLog[];
	jobs: SentinelCodeCheckJob[];
}

export interface SentinelCodeMonitorInput {
	projectId: string;
	url: string;
	name?: string;
	token?: string;
	apiBaseUrl?: string;
	branches: string[];
	intervalMinutes?: number;
	scheduleKind?: SentinelCodeScheduleKind;
	cronExpression?: string | null;
	autoDispatch?: boolean;
	autoDispatchCategories?: SentinelVulnCategory[] | null;
	autoDispatchTags?: CodeVulnTag[] | null;
	enabled?: boolean;
}

// ---------------------------------------------------------------------------
// 业务建模（Business modeling）
// ---------------------------------------------------------------------------

export type SentinelApiModelStatus = "modeling" | "done" | "manual" | "failed";

export const SENTINEL_API_MODEL_STATUS_LABELS: Record<SentinelApiModelStatus, string> = {
	modeling: t("建模中"),
	done: t("已完成"),
	manual: t("人工结束"),
	failed: t("失败"),
};

/** One field of a business entity. */
export interface SentinelApiModelField {
	name: string;
	type?: string;
	description?: string;
}

/** One relation between two business entities. */
export interface SentinelApiModelRelation {
	target: string;
	kind?: string;
	description?: string;
}

/** A business entity: the object the API is about, not a schema of the document. */
export interface SentinelApiModelEntity {
	name: string;
	description?: string;
	fields?: SentinelApiModelField[];
	relations?: SentinelApiModelRelation[];
}

/** One stored modeling run. */
export interface SentinelApiModel {
	id: string;
	projectId: string | null;
	sessionId: string | null;
	sessionPath: string | null;
	title: string;
	target: string;
	status: SentinelApiModelStatus;
	openapi: Record<string, unknown>;
	entities: SentinelApiModelEntity[];
	pathCount: number;
	operationCount: number;
	submissions: number;
	error?: string;
	createdAt: string;
	updatedAt: string;
	doneAt: string | null;
}

/** A run without the document body, for the list. */
export type SentinelApiModelSummary = Omit<SentinelApiModel, "openapi" | "entities"> & { entityCount: number };

export interface SentinelApiModelFilters {
	status?: SentinelApiModelStatus;
	projectId?: string;
	search?: string;
}

/** One line of a run's audit trail. */
export interface SentinelApiModelEvent {
	at: string;
	kind: "created" | "submitted" | "done" | "manual" | "failed";
	note?: string;
	pathCount?: number;
	operationCount?: number;
}

/** Live state of the modeling run in the viewed session. */
export interface SentinelModelingState {
	runId: string;
	title: string;
	target: string;
	startedAt: string;
	pathCount: number;
	operationCount: number;
	entityCount: number;
}

// ---------------------------------------------------------------------------
// 安卓设备（Droid 插件）
// ---------------------------------------------------------------------------

/** One Android device the DroidBridge APK registered. */
export interface DroidDevice {
	id: string;
	name: string;
	model: string;
	androidVersion: string;
	sdkInt: number;
	rooted: boolean;
	online: boolean;
	tokenId: string;
	firstSeen: string;
	lastSeen: string;
	/** Runtime-only: the socket is open but the device stopped answering. */
	stale?: boolean;
	/** Runtime-only: milliseconds since the device's last frame (0 when fresh). */
	idleMs?: number;
}

/** One reverse-connection token; the value is shown once for typing into the APK. */
export interface DroidToken {
	id: string;
	label: string;
	token: string;
	createdAt: string;
	lastUsedAt: string | null;
}

// ---------------------------------------------------------------------------
// iOS 设备（SentinelBridge）
// ---------------------------------------------------------------------------

/** One iPhone the SentinelBridge daemon registered. */
export interface IosDevice {
	id: string;
	name: string;
	model: string;
	osVersion: string;
	build: string;
	/** arm64 / arm64e. */
	arch: string;
	jailbreakForm: "rootful" | "rootless" | "roothide" | "unknown";
	jailbreakName: string;
	jailbreakVersion: string;
	hasRoot: boolean;
	online: boolean;
	tokenId: string;
	firstSeen: string;
	lastSeen: string;
	/** Socket open but no frame for 45s: the process may be suspended. */
	stale?: boolean;
	idleMs?: number;
}

/** One iOS reverse-connection token; typed into SentinelBridge once. */
export interface IosToken {
	id: string;
	label: string;
	token: string;
	createdAt: string;
	lastUsedAt: string | null;
}

// ---------------------------------------------------------------------------
// 监督（观察 / 介入）
// ---------------------------------------------------------------------------

export type SentinelSupervisorMode = "observe" | "intervene";

export type SentinelSupervisorStrategy = "steady" | "validation" | "offensive" | "stealth" | "guarded";

export interface SentinelSupervisorCustomStrategy {
	id: string;
	name: string;
	base: SentinelSupervisorStrategy;
	description: string;
	instructions: string;
	createdAt: number;
	updatedAt: number;
}
export type SentinelSupervisorDelivery = "auto" | "confirm";
export type SentinelSupervisorStatus = "waiting" | "running" | "stopped" | "error";
export type SentinelSupervisorProgress = "advancing" | "stalled" | "looping" | "unknown";
export type SentinelSupervisorTrigger =
	| "batch"
	| "duplicate"
	| "no-progress"
	| "error-streak"
	| "manual"
	| "settled";
export type SentinelSupervisorAdviceStatus = "pending" | "sent" | "ignored";

/** A strategy selected for one conversation: a preset base or a saved custom strategy. */
export interface SentinelSupervisorStrategyRef {
	strategy: SentinelSupervisorStrategy;
	customStrategyId: string | null;
}

/** A resolved strategy snapshot carried with a live view or an audit row. */
export interface SentinelSupervisorStrategyEntry extends SentinelSupervisorStrategyRef {
	name: string;
	instructions: string;
}

export interface SentinelSupervisorConfig {
	enabled: boolean;
	batchToolCalls: number;
	duplicateThreshold: number;
	noProgressCalls: number;
	errorStreak: number;
	timeoutMs: number;
	redactSecrets: boolean;
	defaultStrategy: SentinelSupervisorStrategy;
	/** Ordered default selection for a new conversation; can contain several strategies. */
	defaultStrategies?: SentinelSupervisorStrategyRef[];
	customStrategies: SentinelSupervisorCustomStrategy[];
	defaultCustomStrategyId: string | null;
}

export interface SentinelSupervisorTested {
	target: string;
	test: string;
	result: string;
}

export interface SentinelSupervisorCall {
	callId: string;
	at: number;
	tool: string;
	args: string;
	status: "ok" | "error";
	durationMs: number | null;
	outputBytes: number;
	outputHash: string;
	outputHead: string;
	outputTail: string;
	httpStatus: number | null;
	newEndpoints: string[];
	newParams: string[];
	newEvidence: boolean;
	signals: string[];
}

export interface SentinelSupervisorUsage {
	input: number;
	output: number;
	total: number;
}

export interface SentinelSupervisorAdviceDraft {
	needed: boolean;
	reason: string;
	doNotRepeat: string[];
	nextActions: string[];
}

export interface SentinelSupervisorEpisode {
	id: string;
	sessionId: string;
	seq: number;
	at: number;
	trigger: SentinelSupervisorTrigger;
	phase: string;
	intent: string;
	actions: string[];
	outcomes: string[];
	tested: SentinelSupervisorTested[];
	deadEnds: string[];
	newEvidence: string[];
	openQuestions: string[];
	nextCandidates: string[];
	duplicateSignals: string[];
	progress: SentinelSupervisorProgress;
	confidence: number;
	advice: SentinelSupervisorAdviceDraft | null;
	model: string | null;
	usage: SentinelSupervisorUsage | null;
	error: string | null;
	durationMs: number;
}

export interface SentinelSupervisorAdvice {
	id: string;
	sessionId: string;
	episodeId: string;
	at: number;
	delivery: SentinelSupervisorDelivery;
	status: SentinelSupervisorAdviceStatus;
	text: string;
	sentAt: number | null;
}

export interface SentinelSupervisorState {
	phase: string;
	intent: string;
	progress: SentinelSupervisorProgress;
	tested: SentinelSupervisorTested[];
	deadEnds: string[];
	newEvidence: string[];
	openQuestions: string[];
	nextCandidates: string[];
	duplicateSignals: string[];
}

export interface SentinelSupervisorLog {
	at: number;
	kind: string;
	text: string;
}

export interface SentinelSupervisorView {
	sessionId: string;
	sessionPath: string | null;
	sessionName: string;
	projectId: string | null;
	projectName: string | null;
	mode: SentinelSupervisorMode;
	delivery: SentinelSupervisorDelivery;
	strategy: SentinelSupervisorStrategy;
	strategyCustomId: string | null;
	strategyName: string;
	strategyInstructions: string;
	/** Every selected strategy; older persisted sessions omit it. */
	strategies?: SentinelSupervisorStrategyEntry[];
	strategyNote: string;
	status: SentinelSupervisorStatus;
	armedAt: number;
	startedAt: number | null;
	endedAt: number | null;
	model: SentinelResolvedModelView | null;
	state: SentinelSupervisorState;
	episodeCount: number;
	callCount: number;
	lastEpisodeAt: number | null;
	lastCallAt: number | null;
	usage: SentinelSupervisorUsage;
	lastError: string | null;
	running: boolean;
	pendingAdvice: SentinelSupervisorAdvice | null;
	recentCalls: SentinelSupervisorCall[];
	logs: SentinelSupervisorLog[];
}

export interface SentinelSupervisorAuditItem {
	sessionId: string;
	sessionPath: string | null;
	sessionName: string;
	projectId: string | null;
	projectName: string | null;
	mode: SentinelSupervisorMode;
	delivery: SentinelSupervisorDelivery;
	strategy: SentinelSupervisorStrategy;
	strategyCustomId: string | null;
	strategyName: string;
	strategyInstructions: string;
	/** Every selected strategy; older persisted sessions omit it. */
	strategies?: SentinelSupervisorStrategyEntry[];
	strategyNote: string;
	status: SentinelSupervisorStatus;
	armedAt: number;
	startedAt: number | null;
	endedAt: number | null;
	updatedAt: number;
	episodeCount: number;
	callCount: number;
	phase: string;
	intent: string;
	progress: SentinelSupervisorProgress;
	adviceCount: number;
	usage: SentinelSupervisorUsage;
	lastError: string | null;
}

export interface SentinelSupervisorAuditStats {
	total: number;
	advancing: number;
	stalled: number;
	looping: number;
	stopped: number;
	pendingAdvice: number;
}

export interface SentinelSupervisorAuditPage {
	items: SentinelSupervisorAuditItem[];
	total: number;
	page: number;
	pageSize: number;
	stats: SentinelSupervisorAuditStats;
}

export interface SentinelSupervisorDetail {
	session: SentinelSupervisorAuditItem;
	episodes: SentinelSupervisorEpisode[];
	logs: SentinelSupervisorLog[];
	advice: SentinelSupervisorAdvice[];
}

export interface SentinelStateSnapshot {
	mode: SentinelMode;
	streaming: boolean;
	cwd: string;
	project: SentinelProjectInfo | null;
	model: { provider: string; id: string } | null;
	modelConfigured: boolean;
	thinkingLevel: SentinelThinkingLevel;
	availableThinkingLevels: SentinelThinkingLevel[];
	activeSessionId: string | null;
	messages: AgentMessageView[];
	pendingApprovals: SentinelApprovalRequest[];
	allowedPrefixes: string[];
	/** Session ids with an active run (background included). */
	runningSessions: string[];
	/** Sub-agent runs of the active session, newest first, without process steps. */
	subagents: SentinelSubagentRun[];
	subagentTotal: number;
	/** Persistent goal of the active session, with live counters; null when there is none. */
	goal: SentinelGoalView | null;
	/** Operator status of the active session, as a label the agent never sees. */
	sessionStatus: SentinelSessionStatus | null;
	/** Mode state and judge health, for the toolbar switch and the fail-open banner. */
	gatekeeper: SentinelGatekeeperView;
	/** The preset agent the active session was created with; null means the default agent. */
	preset: SentinelSessionPresetView | null;
	/**
	 * The business-modeling run in force for the active session, with live
	 * counters; null when this session is not modeling. The two modeling tools
	 * exist only while this is set.
	 */
	modeling: SentinelModelingState | null;
	/**
	 * Modeling records attached to the active session from the composer (带建模
	 * 数据); empty when none. While set, api_model_read is mounted for the agent.
	 */
	modelingAttached: Array<{ id: string; title: string }>;
	/** Compaction is running for the active session, which blocks prompts. */
	compacting: boolean;
	/** When that compaction started, for the elapsed time; null when idle. */
	compactionStartedAt: number | null;
	/** Whether the viewed conversation mounts the Android toolset (per session). */
	droidEnabled: boolean;
	/** Whether the viewed conversation mounts the iOS toolset (per session). */
	iosEnabled: boolean;
	/** Supervision of the viewed conversation; null when it was never armed. */
	supervisor: SentinelSupervisorView | null;
	/** Global supervision settings shown under 设置 → 模型. */
	supervisorConfig: SentinelSupervisorConfig;
}

export interface SessionInfoView {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
	/** Operator status, absent when the session was never labeled. */
	status?: SentinelSessionStatus;
	/** Present when this session is an engineering task's conversation. */
	engine?: { engineId: string; engineName: string; taskStatus: string };
}

/** The operator's manual label for a session. The agent never sees it. */
export type SentinelSessionStatus = "todo" | "active" | "done" | "ignored";

export interface SessionTreeNodeView {
	entry: {
		id: string;
		type: string;
		parentId: string | null;
		timestamp: string;
		/** Present on message entries; used for readable branch labels. */
		message?: { role?: string; content?: unknown };
	};
	children: SessionTreeNodeView[];
	label?: string;
}

export interface SentinelForkPoint {
	entryId: string;
	text: string;
}

export interface SentinelStatsView {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	/** Historical session usage for About; top-level counters remain session-scoped. */
	cumulative?: { tokens: SentinelStatsView["tokens"]; cost: number };
}

/** Lifecycle of the persistent goal of the viewed session. */
export type SentinelGoalStatus = "active" | "paused" | "blocked" | "completed";
export type SentinelGoalPauseReason = "manual" | "limit" | "no-progress" | "interrupted" | "loop-guard";
export type SentinelGoalRoundOutcome = "continued" | "completed" | "blocked" | "paused" | "aborted" | "error";

export interface SentinelGoalUsage {
	input: number;
	output: number;
	total: number;
	cost: number | null;
}

export interface SentinelGoalRound {
	index: number;
	kind: "initial" | "continue";
	startedAt: number;
	endedAt?: number;
	toolCalls: number;
	usage?: SentinelGoalUsage;
	summary?: string;
	summaryFromTool?: boolean;
	outcome?: SentinelGoalRoundOutcome;
	blockerReason?: string;
}

export interface SentinelGoalCriterionResult {
	criterion: string;
	met: boolean;
	evidence: string;
}

export interface SentinelGoalView {
	id: string;
	objective: string;
	criteria: string[];
	roundLimit: number;
	roundsUsed: number;
	noProgressStreak: number;
	blockerStreak: number;
	status: SentinelGoalStatus;
	pauseReason?: SentinelGoalPauseReason;
	pauseNote?: string;
	baseline: SentinelGoalUsage;
	progress: { done: string[]; todo: string[]; blockers: string[] };
	rounds: SentinelGoalRound[];
	lastBlocker?: string;
	submitted: number;
	completion?: {
		summary: string;
		evidence: string[];
		submitted: number;
		findingsNote: string;
		criteria: SentinelGoalCriterionResult[];
		at: number;
	};
	blocked?: { reason: string; evidence: string[]; streak: number; at: number };
	createdAt: number;
	startedAt: number;
	endedAt?: number;
	updatedAt: number;
	/** Main-agent usage since the goal started. */
	usage: SentinelGoalUsage;
	/** Sub-agent work of this goal; shown for context, it consumes no rounds. */
	subagent: { runs: number; turns: number };
	running: boolean;
}

/** Subset of pi AgentMessage shapes the UI renders. */
export type AgentMessageView =
	| { role: "system"; content?: unknown }
	| { role: "user"; content: ContentBlockView[]; timestamp?: number }
	| {
			role: "assistant";
			content: ContentBlockView[];
			timestamp?: number;
			model?: string;
			stopReason?: string;
			errorMessage?: string;
	  }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: ContentBlockView[];
			isError?: boolean;
			durationMs?: number;
			timestamp?: number;
	  }
	| {
			role: "bashExecution";
			command: string;
			output: string;
			exitCode?: number;
			cancelled?: boolean;
			timestamp?: number;
	  }
	| { role: "compactionSummary"; summary?: string; tokensBefore?: number; timestamp?: number }
	| { role: "branchSummary"; summary?: string; timestamp?: number }
	| { role: "custom"; customType: string; content: unknown; timestamp?: number };

export type ContentBlockView =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	| { type: "image"; data: string; mimeType: string }
	| { type: string };

export type SentinelClientMessage =
	| {
			type: "prompt";
			text: string;
			streamingBehavior?: "steer" | "followUp";
			images?: SentinelImageAttachment[];
			/** Composer choice: force a notification for this run. */
			notify?: boolean;
			/**
			 * 带建模数据: records whose catalog rides this first message of a fresh
			 * conversation. Honored only then; unchecked means the field is absent.
			 */
			attachModelIds?: string[];
	  }
	| { type: "abort" }
	| { type: "compact" }
	| { type: "abort_compaction" }
	| { type: "start_goal"; objective: string; criteria?: string[]; roundLimit: number }
	| { type: "pause_goal" }
	| { type: "resume_goal"; extraRounds?: number }
	| { type: "clear_goal" }
	| { type: "set_thinking_level"; level: SentinelThinkingLevel }
	/** null makes the active session follow the console-wide default again. */
	| { type: "set_mode"; mode: SentinelMode | null }
	| { type: "set_global_mode"; mode: SentinelMode }
	| { type: "decide"; decision: { id: string; approved: boolean; command?: string; alwaysAllowPrefix?: boolean } }
	| { type: "decide_all"; approved: boolean }
	| { type: "allow_prefix"; prefix: string }
	| { type: "remove_allowed_prefix"; prefix: string }
	| { type: "new_session"; presetId?: string }
	/** Re-brief the viewed session; `presetId: null` drops back to the default agent. */
	| { type: "set_session_preset"; presetId: string | null }
	| { type: "switch_session"; path: string }
	| { type: "rename_session"; path: string; name: string }
	| { type: "set_session_status"; path?: string; status: SentinelSessionStatus | null }
	| { type: "delete_session"; path: string }
	| { type: "list_sessions" }
	| { type: "navigate"; entryId: string; summarize?: boolean }
	| { type: "rename_branch"; entryId: string; label: string }
	| { type: "get_tree" }
	| { type: "get_state" }
	| { type: "get_model_library" }
	/** Create (`id` omitted) or update one entry. `apiKey: null` keeps the stored key. */
	| {
			type: "save_model_entry";
			id?: string;
			name: string;
			baseUrl: string;
			apiKey: string | null;
			modelId: string;
			/** Omitted means "keep what is stored"; present replaces the whole declaration. */
			capabilities?: SentinelModelCapabilities;
	  }
	| { type: "lookup_model_defaults"; modelId: string; baseUrl: string }
	/** Channel list for the add-model form; `requestId` matches the async reply. */
	| { type: "list_model_channels"; requestId: number; query: string }
	/** Models of one chosen channel, for the second picker. */
	| { type: "list_channel_models"; requestId: number; provider: string }
	| { type: "remove_model_entry"; id: string }
	| { type: "duplicate_model_entry"; id: string }
	| { type: "set_model_role"; role: SentinelModelRoleName; target: string | null }
	| { type: "set_reviewer_auto"; enabled: boolean }
	| { type: "test_model_entry"; id: string }
	| { type: "get_permissions" }
	| { type: "save_permissions"; config: SentinelPermissionsConfig }
	| { type: "get_notify_config" }
	| { type: "save_notify_config"; config: SentinelNotifyConfig }
	| { type: "test_notify"; config: SentinelNotifyConfig; channel?: SentinelNotifyChannel }
	| { type: "get_stats" }
	| { type: "list_projects" }
	/** `proxyId` absent follows the default on the 代理 page, `null` means none. */
	| { type: "add_project"; name: string; proxyId?: string | null; proxyNode?: string }
	/** What a removal covers: the container only, or the project and its data. */
	| { type: "remove_project"; id: string; confirmName: string; scope: "container" | "data" }
	/** Stop the container deliberately: it stays, but using the project needs an explicit start. */
	| { type: "stop_project"; id: string }
	/** Start (or recreate, when it is gone) the project container. */
	| { type: "start_project"; id: string }
	/** Replace a project's container so changed settings (network mode) apply. */
	| { type: "recreate_project"; id: string }
	| { type: "switch_project"; id: string }
	| { type: "list_files"; path: string }
	| { type: "read_file"; path: string }
	| { type: "write_file"; path: string; text: string }
	| { type: "upload_file"; path: string; data: string }
	| { type: "download_file"; path: string }
	| { type: "delete_path"; path: string }
	| { type: "rename_path"; from: string; to: string }
	| { type: "make_directory"; path: string }
	| { type: "download_folder"; path: string }
	| { type: "cancel_folder_archive"; id: string }
	| { type: "terminal_open"; projectId: string; cols: number; rows: number }
	| { type: "terminal_input"; projectId: string; data: string }
	| { type: "terminal_close"; projectId: string }
	| { type: "list_subagents"; offset?: number; limit?: number }
	| { type: "get_subagent"; id: string }
	| { type: "abort_subagent"; id: string }
	| { type: "steer_subagent"; id: string; text: string }
	| { type: "list_vulns"; filters?: SentinelVulnFilters }
	| { type: "get_vuln"; id: string }
	| { type: "update_vuln"; id: string; patch: SentinelVulnUpdate }
	| { type: "list_assets"; filters?: SentinelAssetFilters; page?: number; pageSize?: number }
	| { type: "get_asset"; id: string }
	| { type: "update_asset"; id: string; patch: SentinelAssetUpdate }
	| { type: "preview_asset_delete"; ids: string[] }
	| { type: "delete_assets"; ids: string[] }
	| { type: "export_assets"; filters?: SentinelAssetFilters }
	/** How much deleting these records would take with them, for the dialog. */
	| { type: "preview_vuln_delete"; ids: string[] }
	| { type: "delete_vulns"; ids: string[] }
	| { type: "export_vulns"; filters?: SentinelVulnFilters }
	| { type: "retry_vuln_review"; id: string; force?: boolean }
	| { type: "review_pending_vulns" }
	| { type: "list_pocs"; filters?: SentinelPocFilters; page?: number; pageSize?: number }
	| { type: "get_poc"; id: string }
	| { type: "delete_poc"; id: string }
	| { type: "list_poc_sources" }
	| { type: "save_poc_source"; source: SentinelPocSourceSave }
	| { type: "delete_poc_source"; id: string }
	| { type: "sync_poc_source"; id: string }
	| { type: "sync_official_pocs" }
	| { type: "list_code_monitors" }
	| {
			type: "code_monitor_branches";
			requestId: number;
			projectId: string;
			url: string;
			monitorId?: string;
			token?: string;
			apiBaseUrl?: string;
	  }
	| { type: "create_code_monitor"; input: SentinelCodeMonitorInput }
	| { type: "update_code_monitor"; id: string; input: SentinelCodeMonitorInput }
	| { type: "delete_code_monitor"; id: string }
	| { type: "delete_code_monitors"; ids: string[] }
	| { type: "import_code_monitors"; inputs: SentinelCodeMonitorInput[] }
	| { type: "get_code_monitor_import" }
	| { type: "dismiss_code_monitor_import" }
	| {
			type: "list_code_activity";
			requestId: number;
			projectId: string;
			filter: SentinelCodeActivityFilter;
			category?: SentinelVulnCategory | null;
			tag?: CodeVulnTag | null;
			search?: string;
			page: number;
			pageSize: number;
	  }
	| { type: "check_code_monitor"; id: string; trigger?: SentinelCodeCheckTrigger }
	| { type: "get_code_monitor"; id: string }
	| { type: "dispatch_code_commit"; id: string }
	| { type: "ignore_code_commit"; id: string }
	| { type: "rejudge_code_commit"; id: string }
	| {
			type: "set_code_monitors_schedule";
			ids: string[];
			scheduleKind: SentinelCodeScheduleKind;
			intervalMinutes?: number;
			cronExpression?: string | null;
	  }
	| {
			type: "set_code_monitors_dispatch";
			ids: string[];
			autoDispatch?: boolean;
			autoDispatchCategories?: SentinelVulnCategory[] | null;
			autoDispatchTags?: CodeVulnTag[] | null;
	  }
	| { type: "list_code_monitor_logs"; projectId: string }
	| { type: "get_environment" }
	| { type: "check_environment" }
	| { type: "build_image" }
	| { type: "abort_image_build" }
	| { type: "set_sources"; sources: SentinelSources }
	| { type: "set_container_network"; network: SentinelContainerNetwork }
	| { type: "get_proxy_config" }
	/** Create or update one profile; `id` absent creates. */
	| { type: "save_proxy"; proxy: SentinelProxyInput }
	/** Re-read one profile's subscription: fetch, parse, cache. */
	| { type: "refresh_proxy_subscription"; id: string }
	/** Which node a subscription profile should use. */
	| { type: "set_proxy_node"; id: string; nodeTag: string }
	/** Measure every node of one subscription against a URL. */
	| { type: "test_proxy_nodes"; id: string; url: string }
	/** Fetch a URL through one profile's exit, in a throwaway container. */
	| { type: "test_proxy_connection"; id: string; url: string }
	| { type: "delete_proxy"; id: string }
	/** Which profile a project without a choice of its own follows; null = none. */
	| { type: "set_default_proxy"; id: string | null }
	/** The sing-box image every sidecar runs. */
	| { type: "set_proxy_image"; image: string }
	/** Pull that image. */
	| { type: "pull_singbox_image" }
	/** Set or clear one project's proxy; `proxyId` absent clears it. */
	| { type: "set_project_proxy"; projectId: string; proxyId?: string | null; proxyNode?: string }
	/** Move a running project's node now, and record the choice for later. */
	| { type: "switch_project_node"; projectId: string; nodeTag: string }
	| { type: "get_asset_config" }
	| { type: "save_asset_platform"; platform: SentinelAssetPlatformInput }
	| { type: "set_asset_query_limit"; limit: number }
	| { type: "test_asset_platform"; platform: SentinelAssetPlatform; key?: string; baseUrl?: string }
	| { type: "get_websearch_config" }
	| { type: "save_websearch_key"; key: SentinelWebSearchKeyInput }
	| { type: "delete_websearch_key"; id: string }
	| { type: "set_websearch_query_limit"; limit: number }
	| { type: "test_websearch_key"; id?: string; key?: string }
	| { type: "get_mcp_servers" }
	| { type: "save_mcp_server"; server: SentinelMcpServerInput }
	| { type: "delete_mcp_server"; name: string }
	/** Flip one server's switch from the permissions page; the MCP page reads the same field. */
	| { type: "set_mcp_server_enabled"; name: string; enabled: boolean }
	| { type: "test_mcp_server"; name: string; draft?: SentinelMcpServerInput }
	| { type: "get_plugins" }
	/** Add or update one host. An empty token keeps the stored one. */
	| { type: "save_plugin_host"; host: SentinelPluginHostInput }
	| { type: "delete_plugin_host"; id: string }
	| { type: "test_plugin_host"; id: string }
	/** Read `plugin.json` from a directory on the console host; nothing is installed yet. */
	| { type: "inspect_plugin_package"; name: string; data: string }
	| {
			type: "install_plugin";
			hostId: string;
			manifest: SentinelPluginManifest;
			package: string;
			allowBuild: boolean;
			allowHostNetwork: boolean;
			allowPrivileged: boolean;
			config: Record<string, string>;
	  }
	| { type: "uninstall_plugin"; hostId: string; pluginId: string; purge: boolean }
	| { type: "start_plugin"; hostId: string; pluginId: string }
	| { type: "stop_plugin"; hostId: string; pluginId: string }
	| { type: "set_plugin_enabled"; hostId: string; pluginId: string; enabled: boolean }
	| { type: "set_plugin_sidebar"; hostId: string; pluginId: string; pinned: boolean }
	| { type: "list_official_plugins" }
	| { type: "get_plugin_build_log"; hostId: string; pluginId: string }
	| {
			type: "install_official_plugin";
			hostId: string;
			pluginId: string;
			allowBuild: boolean;
			allowHostNetwork: boolean;
			allowPrivileged: boolean;
			config: Record<string, string>;
	  }
	/** Empty secret values keep the stored secret; other empty values clear the key. */
	| { type: "save_plugin_config"; hostId: string; pluginId: string; values: Record<string, string> }
	| { type: "get_plugin_logs"; hostId: string; pluginId: string }
	| { type: "list_plugin_artifacts"; hostId: string; pluginId: string }
	| { type: "fetch_plugin_artifact"; hostId: string; pluginId: string; path: string }
	| { type: "plugin_ui_open"; hostId: string; pluginId: string }
	| {
			type: "plugin_ui_call";
			requestId: string;
			hostId: string;
			pluginId: string;
			method: string;
			params: unknown;
	  }
	| { type: "list_engines" }
	| { type: "engine_create"; input: SentinelEngineCreateInput }
	| { type: "engine_pause"; id: string }
	| { type: "engine_resume"; id: string }
	| { type: "engine_abort"; id: string }
	| { type: "engine_set_schedule"; id: string; schedule: SentinelEngineScheduleInput }
	| { type: "engine_cancel_schedule"; id: string }
	| { type: "engine_delete"; id: string }
	| { type: "engine_add_targets"; id: string; targets: string }
	| { type: "engine_steer_commander"; id: string; text: string }
	| { type: "engine_abort_task"; taskId: string }
	| { type: "engine_task_events"; taskId: string }
	| { type: "engine_open_task_session"; taskId: string }
	| { type: "engine_commander_events"; id: string }
	| { type: "engine_report_snapshot"; id: string }
	| { type: "list_doctrines" }
	| { type: "save_doctrine"; input: { id?: string; name: string; text: string } }
	| { type: "delete_doctrine"; id: string }
	| { type: "list_presets" }
	/**
	 * Create or update a preset agent. `id` is present only when updating: the
	 * server generates ids, and a save never overwrites another entry.
	 */
	| {
			type: "save_preset";
			input: {
				id?: string;
				name: string;
				description?: string;
				tags?: string[];
				placeholder?: string;
				text: string;
				enabled?: boolean;
			};
	  }
	| { type: "delete_preset"; id: string }
	| { type: "set_preset_enabled"; id: string; enabled: boolean }
	/** Export the selected presets, or all of them when `ids` is omitted. */
	| { type: "export_presets"; ids?: string[] }
	| { type: "import_presets"; content: string }
	| { type: "get_gatekeeper_config" }
	| { type: "set_ui_language"; language: UiLanguage }
	| { type: "save_gatekeeper_config"; config: SentinelGatekeeperConfig }
	| { type: "test_judge" }
	| { type: "gate_audit_query"; filter?: SentinelGateFilter; page?: number; pageSize?: number }
	| { type: "gate_audit_stats"; filter?: SentinelGateFilter }
	| {
			type: "supervisor_arm";
			mode: SentinelSupervisorMode;
			delivery: SentinelSupervisorDelivery;
			strategy: SentinelSupervisorStrategy;
			strategies?: SentinelSupervisorStrategyRef[];
			customStrategyId?: string | null;
			note?: string;
	  }
	| { type: "supervisor_stop" }
	| {
			type: "supervisor_set_mode";
			mode: SentinelSupervisorMode;
			delivery: SentinelSupervisorDelivery;
	  }
	| {
			type: "supervisor_set_strategy";
			strategy: SentinelSupervisorStrategy;
			customStrategyId?: string | null;
			strategies?: SentinelSupervisorStrategyRef[];
			note?: string;
	  }
	| { type: "supervisor_run_now" }
	| { type: "supervisor_call_output"; callId: string }
	| {
			type: "supervisor_audit";
			page?: number;
			pageSize?: number;
			projectId?: string;
			search?: string;
			mode?: SentinelSupervisorMode;
			progress?: SentinelSupervisorProgress;
			strategy?: SentinelSupervisorStrategy;
			customStrategyId?: string;
	  }
	| { type: "supervisor_detail"; sessionId: string }
	| { type: "supervisor_advice_action"; id: string; action: "send" | "ignore" }
	| { type: "save_supervisor_config"; config: SentinelSupervisorConfig }
	| { type: "test_supervisor" }
	/** Start business modeling in the viewed session; the objective comes from the conversation. */
	| { type: "start_modeling" }
	| { type: "end_modeling" }
	| { type: "detach_modeling" }
	| { type: "end_api_model"; id: string }
	/** The Android device page: pull the full gateway state. */
	| { type: "droid_state" }
	| { type: "droid_token_create"; label: string }
	| { type: "droid_token_delete"; id: string }
	| { type: "droid_device_rename"; id: string; name: string }
	| { type: "droid_device_remove"; id: string }
	| { type: "droid_set_enabled"; enabled: boolean }
	| { type: "droid_set_listen"; host: string; port: number }
	/** The iOS device page: tokens and devices (no dedicated listener). */
	| { type: "ios_state" }
	| { type: "ios_token_create"; label: string }
	| { type: "ios_token_delete"; id: string }
	| { type: "ios_device_rename"; id: string; name: string }
	| { type: "ios_device_remove"; id: string }
	| { type: "ios_set_enabled"; enabled: boolean }
	| { type: "ios_set_listen"; host: string; port: number }
	| { type: "list_api_models"; filters?: SentinelApiModelFilters }
	| { type: "get_api_model"; id: string }
	| { type: "delete_api_model"; id: string }
	| { type: "export_api_model"; id: string; format: "json" | "yaml" }
	| { type: "engine_set_gate_mode"; id: string; gateMode: SentinelEngineGateMode }
	/**
	 * Replace this engine's preset whitelist. An empty list means "no restriction":
	 * the commander may use any enabled preset.
	 */
	| { type: "engine_set_presets"; id: string; presetIds: string[] }
	/**
	 * Whether the commander may leave a task without a preset, running it as the
	 * default agent. False means every dispatch must name one of the allowed
	 * presets, and a dispatch that names none is refused with the list of choices.
	 */
	| { type: "engine_set_preset_optional"; id: string; optional: boolean };

export type SentinelServerMessage =
	| { type: "snapshot"; snapshot: SentinelStateSnapshot }
	| { type: "session_event"; event: SessionEventView }
	| { type: "sessions"; sessions: SessionInfoView[] }
	| { type: "tree"; tree: SessionTreeNodeView[]; leafId: string | null; forkPoints: SentinelForkPoint[] }
	| { type: "model_library"; library: SentinelModelLibraryView }
	| { type: "model_defaults"; modelId: string; matches: SentinelBuiltinModelDefaults[] }
	| {
			type: "model_channels";
			requestId: number;
			query: string;
			channels: SentinelBuiltinChannel[];
	  }
	| {
			type: "channel_models";
			requestId: number;
			provider: string;
			presets: SentinelBuiltinModelPreset[];
	  }
	| { type: "model_test_result"; result: SentinelTestResult }
	| {
			type: "permissions";
			config: SentinelPermissionsConfig;
			effectiveSubagent: SentinelPermissionSet;
			presets: SentinelPermissionPreset[];
			tools: SentinelToolInfo[];
	  }
	| { type: "notify_config"; config: SentinelNotifyConfig; status: SentinelNotifyStatus }
	| { type: "notify_test_result"; result: SentinelTestResult }
	| { type: "stats"; stats: SentinelStatsView }
	| { type: "projects"; projects: SentinelProjectInfo[]; activeProjectId: string | null }
	| { type: "files"; path: string; entries: SentinelFileEntry[] }
	| { type: "file_preview"; preview: SentinelFilePreview }
	| { type: "file_download"; path: string; size: number; data: string; mimeType: string }
	| { type: "file_result"; action: string; path: string; ok: boolean; error?: string }
	| { type: "folder_archive_started"; id: string; path: string; filename: string }
	| { type: "folder_archive_progress"; id: string; bytes: number }
	| { type: "folder_archive_ready"; id: string; filename: string; size: number; warning?: string }
	| { type: "folder_archive_failed"; id?: string; error: string }
	| { type: "folder_archive_cancelled"; id: string }
	| {
			type: "terminal_state";
			projectId: string;
			outcome: "opened" | "failed" | "closed";
			session?: SentinelTerminalSession;
			replay?: string;
			error?: string;
	  }
	| { type: "terminal_output"; projectId: string; data: string }
	| { type: "terminal_exit"; projectId: string; code: number | null }
	| { type: "official_plugins"; plugins: SentinelOfficialPluginView[] }
	| { type: "plugin_build_log"; hostId: string; pluginId: string; log: string }
	| { type: "subagents"; runs: SentinelSubagentRun[]; offset: number; total: number }
	| { type: "subagent_run"; run: SentinelSubagentRun }
	| { type: "subagent_event"; runId: string; event: SentinelSubagentEvent }
	| { type: "subagent_result"; action: string; id: string; ok: boolean; error?: string }
	| { type: "vulns"; items: SentinelVulnSummary[]; stats: SentinelVulnStats }
	| { type: "vuln"; vuln: SentinelVulnerability }
	| { type: "vuln_result"; action: string; id?: string; ok: boolean; error?: string }
	| { type: "vuln_delete_preview"; count: number; evidence: number; notes: number }
	| { type: "vulns_deleted"; count: number }
	| { type: "vuln_delete_preview"; count: number; evidence: number; notes: number }
	| { type: "vulns_deleted"; count: number }
	| { type: "vulns_export"; filename: string; markdown: string }
	| { type: "vuln_review_result"; id: string; ok: boolean; error?: string }
	| {
			type: "assets";
			items: SentinelAssetSummary[];
			stats: SentinelAssetStats;
			total: number;
			page: number;
			pageSize: number;
			hasMore: boolean;
	  }
	| { type: "assets_changed" }
	| { type: "asset"; detail: SentinelAssetDetail }
	| { type: "asset_result"; action: string; id?: string; ok: boolean; error?: string }
	| { type: "asset_delete_preview"; count: number; records: number; vulns: number }
	| { type: "assets_deleted"; count: number }
	| { type: "assets_export"; filename: string; markdown: string }
	| { type: "pocs"; items: SentinelPocSummary[]; stats: SentinelPocStats; total: number; page: number; pageSize: number }
	| { type: "poc"; poc: SentinelPoc }
	| { type: "poc_result"; action: string; id?: string; ok: boolean; error?: string }
	| { type: "poc_sources"; sources: SentinelPocSource[] }
	| { type: "poc_source_result"; action: string; id?: string; ok: boolean; error?: string }
	| { type: "code_monitors"; monitors: SentinelCodeMonitor[] }
	| { type: "code_monitor_import"; state: SentinelCodeImportState | null }
	| { type: "code_activity"; requestId: number; view: SentinelCodeActivityView }
	| { type: "code_activity_error"; requestId: number; error: string }
	| { type: "code_monitor_detail"; detail: SentinelCodeMonitorDetail }
	| { type: "code_monitor_logs"; checks: SentinelCodeCheckLog[]; jobs: SentinelCodeCheckJob[] }
	| { type: "code_monitor_branches"; requestId: number; branches?: string[]; error?: string }
	| {
			type: "code_monitor_result";
			action: string;
			id?: string;
			ok: boolean;
			error?: string;
			detail?: string;
	  }
	| { type: "environment"; report: SentinelEnvReport; building: boolean }
	| { type: "image_build_log"; line: string }
	| { type: "image_build_result"; ok: boolean; error?: string }
	| { type: "sources_saved"; sources: SentinelSources; error?: string }
	| { type: "container_network_saved"; network: SentinelContainerNetwork; error?: string }
	| { type: "proxy_config"; config: SentinelProxyConfigView; error?: string; push?: boolean }
	| { type: "singbox_pull_started" }
	| { type: "singbox_pull_result"; ok: boolean; error?: string }
	| { type: "project_proxy_saved"; projectId: string; error?: string; applied?: boolean }
	| { type: "asset_config"; config: SentinelAssetConfigView }
	| { type: "asset_test_result"; platform: SentinelAssetPlatform; result: SentinelTestResult }
	| { type: "websearch_config"; config: SentinelWebSearchConfigView }
	| { type: "websearch_test_result"; result: SentinelTestResult }
	| { type: "mcp_servers"; config: SentinelMcpConfigView }
	| { type: "mcp_test_result"; name: string; result: SentinelMcpTestResult }
	| { type: "plugins"; view: SentinelPluginsView }
	| { type: "plugin_manifest"; manifest: SentinelPluginManifest; source: string }
	| { type: "plugin_logs"; hostId: string; pluginId: string; logs: string }
	| { type: "plugin_artifacts"; hostId: string; pluginId: string; artifacts: SentinelPluginArtifact[] }
	| { type: "plugin_artifact_saved"; hostId: string; pluginId: string; path: string; savedTo: string }
	| { type: "plugin_ui_opened"; token: string }
	| { type: "plugin_ui_result"; requestId: string; ok: boolean; result?: unknown; error?: string }
	| { type: "engines"; engines: SentinelEngine[] }
	| { type: "engine_update"; engine: SentinelEngine }
	| { type: "engine_commander_event"; engineId: string; event: SentinelSubagentEvent }
	| { type: "engine_task_event"; taskId: string; event: SentinelSubagentEvent }
	| { type: "engine_task_events"; taskId: string; events: SentinelSubagentEvent[] }
	| { type: "engine_commander_events"; id: string; events: SentinelSubagentEvent[] }
	| { type: "engine_report"; id: string; markdown: string; filename: string }
	| { type: "doctrines"; doctrines: SentinelDoctrineView[] }
	| { type: "doctrine_saved"; doctrine: SentinelDoctrineView; error?: string }
	| { type: "doctrine_deleted"; id: string; ok: boolean; error?: string }
	| { type: "presets"; presets: SentinelPresetView[] }
	| { type: "preset_saved"; preset: SentinelPresetView | null; error?: string }
	| { type: "preset_deleted"; id: string; ok: boolean; error?: string }
	| { type: "presets_export"; filename: string; content: string }
	| {
			type: "presets_imported";
			imported: SentinelPresetView[];
			skipped: Array<{ name: string; reason: string }>;
			error?: string;
	  }
	| { type: "gatekeeper_config"; config: SentinelGatekeeperConfig }
	| { type: "ui_config"; language: UiLanguage }
	| { type: "judge_test_result"; result: SentinelTestResult; raw?: string }
	| { type: "gate_audit"; page: SentinelGatePage }
	| { type: "gate_audit_stats"; stats: SentinelGateStats; tabCounts: Record<SentinelGateApproval, number> }
	| { type: "gate_decision"; decision: SentinelGateDecision }
	| { type: "api_models"; items: SentinelApiModelSummary[] }
	| { type: "api_model"; model: SentinelApiModel; events: SentinelApiModelEvent[] }
	| { type: "api_model_result"; action: string; id?: string; ok: boolean; error?: string }
	| { type: "api_model_export"; filename: string; format: "json" | "yaml"; text: string }
	| {
			type: "droid_state";
			enabled: boolean;
			devices: DroidDevice[];
			tokens: DroidToken[];
			listen: { host: string; port: number } | null;
			listenConfig: { host: string; port: number } | null;
			lanIps: string[];
			certPin: string | null;
	  }
	| {
			type: "ios_state";
			enabled: boolean;
			devices: IosDevice[];
			tokens: IosToken[];
			listen: { host: string; port: number } | null;
			listenConfig: { host: string; port: number } | null;
			lanIps: string[];
			certPin: string | null;
	  }
	| { type: "supervisor_state"; supervisor: SentinelSupervisorView | null }
	| { type: "supervisor_episode"; episode: SentinelSupervisorEpisode; calls: SentinelSupervisorCall[] }
	| { type: "supervisor_log"; sessionId: string; log: SentinelSupervisorLog }
	| { type: "supervisor_advice"; advice: SentinelSupervisorAdvice }
	| { type: "supervisor_config"; config: SentinelSupervisorConfig }
	| { type: "supervisor_audit"; page: SentinelSupervisorAuditPage }
	| { type: "supervisor_detail"; detail: SentinelSupervisorDetail }
	| {
			type: "supervisor_call_output";
			callId: string;
			text: string;
			truncated: boolean;
			error?: string;
	  }
	| { type: "supervisor_test_result"; result: SentinelTestResult; raw?: string }
	| { type: "error"; message: string };

/**
 * One environment prerequisite. Blocking items decide whether the console runs at
 * all: every tool call is a `docker exec`, so Docker is not optional.
 */
export interface SentinelEnvItem {
	id: string;
	group: string;
	label: string;
	status: "ok" | "warn" | "fail" | "skipped";
	detail: string;
	hint?: string;
	blocking: boolean;
}

/** Base image and package mirrors the toolbox image is built with. */
export interface SentinelSources {
	baseImage: string;
	aptMirror: string;
	pipIndex: string;
	npmRegistry: string;
	goProxy: string;
}

/**
 * The three internet-wide asset search engines the console can query with the
 * operator's own account. The console sends the requests, so the key never
 * reaches the project container.
 */
export type SentinelAssetPlatform = "fofa" | "quake" | "hunter";

/** Outcome of the most recent call to one platform, shown on the settings page. */
export interface SentinelAssetStatus {
	/** Epoch milliseconds of the attempt, or null when the platform was never called. */
	at: number | null;
	ok: boolean;
	error?: string;
	/** Quota line as the platform reported it. */
	quota?: string;
}

export interface SentinelAssetPlatformView {
	id: SentinelAssetPlatform;
	label: string;
	enabled: boolean;
	/** A key is stored. The key itself is never sent to the browser. */
	hasKey: boolean;
	/** Custom origin or reverse-proxy prefix; empty means the official platform URL. */
	baseUrl: string;
	/** The key was probed and the platform answered; only then is the tool mounted. */
	verified: boolean;
	status: SentinelAssetStatus;
}

export interface SentinelAssetConfigView {
	platforms: SentinelAssetPlatformView[];
	/** Queries one session may send across all platforms; 0 means unlimited. */
	sessionQueryLimit: number;
	/** Platforms that are enabled, keyed and verified. */
	usable: number;
}

/** Saving one platform: the key is write-only and never read back. */
export interface SentinelAssetPlatformInput {
	id: SentinelAssetPlatform;
	enabled: boolean;
	/** null keeps the stored key, "" clears it, anything else replaces it. */
	key: string | null;
	/** undefined keeps the stored URL, "" restores the official URL. */
	baseUrl?: string;
}

/** One Tavily pool key as the settings screen shows it; the key never leaves the host. */
export interface SentinelWebSearchKeyView {
	id: string;
	label: string;
	enabled: boolean;
	hasKey: boolean;
	verified: boolean;
	status: SentinelAssetStatus;
	/** Last 4 characters of the stored key, so rows can be told apart. */
	tail?: string;
	/** Credits left and the cap they relate to, when a usage probe has run. */
	usage?: { remaining: number | null; limit: number | null };
}

export interface SentinelWebSearchConfigView {
	keys: SentinelWebSearchKeyView[];
	/** Queries one session may send; 0 means unlimited. */
	sessionQueryLimit: number;
	usable: number;
}

/** Add or update one pool key. An absent id adds; a replaced key un-verifies it. */
export interface SentinelWebSearchKeyInput {
	id?: string;
	label: string;
	/** null keeps the stored secret; omitted on add is an error. */
	key?: string | null;
	enabled: boolean;
}

/**
 * `stdio` spawns a command on the console host. `http` calls a remote
 * streamable-HTTP endpoint, and `sse` the older HTTP+SSE one.
 */
export type SentinelMcpTransport = "stdio" | "http" | "sse";

/** Exposure of a server's tools, as the MCP extension accepts it. */
export type SentinelMcpExposure = "codemode" | "deferred" | "direct" | "hidden";

/** Outcome of the last connection attempt, shown on the settings page. */
export interface SentinelMcpStatus {
	at: number | null;
	ok: boolean;
	error?: string;
	tools?: number;
	resources?: number;
}

export interface SentinelMcpServerView {
	name: string;
	enabled: boolean;
	transport: SentinelMcpTransport;
	/** Command line for stdio, URL for http. */
	target: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	url: string;
	headers: Record<string, string>;
	description: string;
	exposure: SentinelMcpExposure;
	/** Per-request timeout in seconds; null means the extension's own default. */
	timeout: number | null;
	/** stdio only: the operator accepted that the command runs on the console host. */
	hostExecAcknowledged: boolean;
	status: SentinelMcpStatus;
}

export interface SentinelMcpConfigView {
	servers: SentinelMcpServerView[];
	/** Servers a session connects (enabled, and acknowledged when stdio). */
	mounted: number;
	/** The 权限 → MCP switch; off means nothing is mounted. */
	permissionOn: boolean;
	/** Config file the entries are stored in. */
	path: string;
}

export interface SentinelMcpServerInput {
	name: string;
	enabled: boolean;
	transport: SentinelMcpTransport;
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	url: string;
	headers: Record<string, string>;
	description: string;
	exposure: SentinelMcpExposure;
	timeout: number | null;
	hostExecAcknowledged: boolean;
}

/** One connection probe, with what the server offered when it answered. */
export interface SentinelMcpTestResult extends SentinelTestResult {
	state: "connected" | "needs-auth" | "failed";
	tools: string[];
	resources: number;
	instructions?: string;
}

// ---------------------------------------------------------------------------
// 插件中心 (mirrors packages/web/src/protocol.ts and plugin-manifest.ts)
// ---------------------------------------------------------------------------

export type SentinelPluginNetwork = "none" | "bridge" | "host";

/** Where a plugin makes sense: the operator's LAN, a public egress, or either. */
export type SentinelPluginLocality = "local-only" | "remote-only" | "any";

export type SentinelPluginConfigType = "string" | "secret" | "number" | "boolean" | "enum";

/** Only streamable HTTP is part of the plugin contract. */
export type SentinelPluginMcpTransport = "http";

/** One configuration field the install form renders. */
export interface SentinelPluginConfigField {
	key: string;
	label: string;
	type: SentinelPluginConfigType;
	required: boolean;
	/** Pre-filled value; `null` starts empty. */
	default: string | number | boolean | null;
	/** Allowed values for `enum`, empty otherwise. */
	options: string[];
	description: string;
}

export interface SentinelPluginMcp {
	transport: SentinelPluginMcpTransport;
	port: number;
	path: string;
	startupTimeoutMs: number;
	/** Per-request budget of an MCP call, in milliseconds. */
	requestTimeoutMs: number;
}

export interface SentinelPluginPermissions {
	network: SentinelPluginNetwork;
	/** Extra Linux capabilities, e.g. `NET_RAW` for a scanner that needs raw sockets. */
	capAdd: string[];
	privileged: boolean;
}

export interface SentinelPluginResources {
	cpus: number;
	/** Docker size string, e.g. `512m` or `2g`. */
	memory: string;
	pidsLimit: number;
}

export interface SentinelPluginHealthcheck {
	path: string;
	intervalMs: number;
	timeoutMs: number;
	retries: number;
}

export interface SentinelPluginArtifacts {
	path: string;
	maxFileBytes: number;
}

/** How the host builds the image from the uploaded package. */
export interface SentinelPluginBuild {
	dockerfile: string;
	context: string;
	args: Record<string, string>;
}

/** Optional frontend served from the plugin image under `/ui/`. */
export interface SentinelPluginUiSidebar {
	label: string;
	icon: string;
}

export interface SentinelPluginUi {
	/** Container path of the entry document, e.g. `/ui/index.html`. */
	entry: string;
	/** Title shown in the console frame around the iframe. */
	title: string;
	/** Bridge protocol; only 1 is understood. */
	protocol: number;
	/** Author's sidebar suggestion; the operator opts in per plugin. */
	sidebar: SentinelPluginUiSidebar | null;
}

/** A tool as advertised before install; the running MCP server remains authoritative. */
export interface SentinelPluginToolHint {
	name: string;
	description: string;
}

/** The community plugin manifest (`plugin.json`). */
export interface SentinelPluginManifest {
	schema: number;
	id: string;
	name: string;
	version: string;
	description: string;
	author: string;
	source: string;
	license: string;
	build: SentinelPluginBuild;
	mcp: SentinelPluginMcp;
	config: SentinelPluginConfigField[];
	permissions: SentinelPluginPermissions;
	locality: SentinelPluginLocality;
	resources: SentinelPluginResources;
	healthcheck: SentinelPluginHealthcheck;
	artifacts: SentinelPluginArtifacts;
	tools: SentinelPluginToolHint[];
	/** Null when the plugin ships no frontend. */
	ui: SentinelPluginUi | null;
}

/**
 * A plugin host as the console lists it. The token is never part of the view:
 * saving a host without one keeps the stored token.
 */
export interface SentinelPluginHostView {
	id: string;
	name: string;
	url: string;
	/** Discovered from a `plugin-host --local` state file on this machine. */
	local: boolean;
	status: {
		at: number | null;
		ok: boolean;
		error?: string;
		version?: string;
		mode?: "local" | "remote";
		docker?: { ok: boolean; version?: string; error?: string };
	};
}

/** Runtime state of one installed plugin, as the host reports it. */
export type SentinelPluginState = "running" | "starting" | "stopped" | "failed" | "missing";

/** One installed plugin on one host. */
export interface SentinelPluginView {
	hostId: string;
	hostName: string;
	hostLocal: boolean;
	manifest: SentinelPluginManifest;
	state: SentinelPluginState;
	healthy: boolean;
	/** The console-side switch; off means its tools are not mounted. */
	enabled: boolean;
	/** Pinned to the console sidebar by the operator. */
	pinned: boolean;
	/** Config keys that have a stored value. */
	configured: string[];
	/** Stored values of non-secret fields; secrets only appear in `configured`. */
	values: Record<string, string>;
	hostPort: number | null;
	installedAt: number;
	lastError: string | null;
}

export interface SentinelOfficialPluginView {
	manifest: SentinelPluginManifest;
	sizeBytes: number;
}

/** Everything the plugin center page renders. */
export interface SentinelPluginsView {
	hosts: SentinelPluginHostView[];
	plugins: SentinelPluginView[];
	/** Hosts that did not answer, one line each. */
	problems: string[];
}

/** Add or edit one host. `id` present means edit. */
export interface SentinelPluginHostInput {
	id?: string;
	name: string;
	url: string;
	/** Empty on an edit keeps the stored token. */
	token: string;
}

/** One file under a plugin's artifacts directory. */
export interface SentinelPluginArtifact {
	path: string;
	size: number;
}

/** The manifest read from an uploaded package, before the operator confirms install. */
export interface SentinelPluginManifestView {
	manifest: SentinelPluginManifest;
	/** File name of the package, shown on the install form. */
	source: string;
}

/** Logs currently expanded on the plugin page. */
export interface SentinelPluginLogsView {
	hostId: string;
	pluginId: string;
	logs: string;
}

/** Artifact listing currently expanded on the plugin page. */
export interface SentinelPluginArtifactsView {
	hostId: string;
	pluginId: string;
	items: SentinelPluginArtifact[];
}

/**
 * How project containers join the network. `host` shares the host's namespace
 * (listeners inside the container are reachable from the target, `127.0.0.1` is
 * the host); `bridge` keeps Docker's own address and publishes nothing.
 *
 * A project with a proxy gets neither: its container shares the network namespace
 * of that project's sing-box sidecar, so every packet takes the tunnel.
 */
export type SentinelContainerNetwork = "host" | "bridge";

/**
 * How the proxy is described. `off` runs no sidecar at all; `simple` covers a
 * SOCKS5 or HTTP endpoint (a local Clash, a VPS); `subscription` takes a URL
 * whose nodes are fetched, parsed and cached; `wireguard` and `openvpn` are
 * tunnels, whose sidecars run `wg-quick` and the OpenVPN client instead of
 * sing-box.
 */
export type SentinelProxyMode = "off" | "simple" | "subscription" | "wireguard" | "openvpn";

/** A SOCKS5 or HTTP endpoint, the whole of what `simple` mode needs. */
export interface SentinelSimpleProxy {
	type: "socks5" | "http";
	server: string;
	port: number;
	username: string;
	password: string;
	/** HTTPS upstream for `http`; ignored by SOCKS5. */
	tls: boolean;
}

/**
 * One node of a subscription, already translated into a sing-box outbound.
 *
 * Stored, not recomputed: the console must be able to write a sidecar
 * configuration on a machine that cannot reach the provider, and the parse is a
 * guess that the operator may want to correct by hand later.
 */
export interface SentinelProxyNode {
	/** Unique inside the profile; it is what the selector and the route name. */
	tag: string;
	/** What the provider called it, for the picker. */
	name: string;
	/** The sing-box outbound type, for the picker. */
	protocol: string;
	/** The outbound itself, already tagged. */
	outbound: Record<string, unknown>;
	/**
	 * Round trip through this node to the test URL, in milliseconds; null when the
	 * request did not come back. Absent until the node has been tested.
	 */
	latencyMs?: number | null;
	/** When `latencyMs` was measured. */
	testedAt?: number;
}

/**
 * One WireGuard tunnel: the pasted `wg0.conf`, plus the two things the file cannot
 * say — the resolver the container should use, and whether to drop the direct
 * default route once the tunnel is up.
 */
export interface SentinelWireGuard {
	config: string;
	dns: string;
	killSwitch: boolean;
}

/**
 * One OpenVPN tunnel: the pasted `.ovpn` (inline certificates), the credentials
 * its `auth-user-pass` needs, and the two things the file cannot say — the
 * resolver the container should use, and whether to drop the direct default route
 * once the tunnel is up.
 */
export interface SentinelOpenVpn {
	config: string;
	dns: string;
	username: string;
	password: string;
	killSwitch: boolean;
}

/** Where a subscription profile's nodes come from, and how the last read went. */
export interface SentinelProxySubscription {
	url: string;
	/** Sent as `User-Agent`; providers switch format on it. */
	userAgent: string;
	/** When the nodes were last read successfully; 0 means never. */
	updatedAt: number;
	/** Why the last read failed, or null when it did not. */
	error: string | null;
	/** Re-read every N hours; 0 turns the timer off. */
	intervalHours: number;
}

/**
 * Effective proxy settings for one project: what the sing-box configuration is
 * generated from. Never stored — a project points at a profile, and the console
 * resolves the two together.
 */
export interface SentinelProxySettings {
	mode: SentinelProxyMode;
	simple: SentinelSimpleProxy;
	/** Cached nodes of a subscription profile. */
	nodes: SentinelProxyNode[];
	/** Which of `nodes` the generated selector defaults to. */
	nodeTag: string;
	/** The tunnel, when `mode` is `wireguard`. */
	wireguard: SentinelWireGuard;
	/** The tunnel, when `mode` is `openvpn`. */
	openvpn: SentinelOpenVpn;
	/** Image the sidecar runs; empty means the built-in default. */
	image: string;
	/**
	 * Send private destinations (RFC1918, loopback, link-local) out the direct
	 * path. On by default: a LAN target is not reachable through a remote exit.
	 */
	routePrivateDirect: boolean;
}

/** The last connectivity test of one profile, as the server stored it. */
export interface SentinelProxyTest {
	ok: boolean;
	/** Round trip in milliseconds; null when the request did not come back. */
	latencyMs: number | null;
	testedAt: number;
	/** The URL traffic was sent to. */
	url: string;
	/** Why it failed, or null when it worked. */
	error: string | null;
}

/**
 * One named proxy, managed on the 代理 page. A profile always describes something
 * that runs — "no proxy" is a project's choice, not a profile.
 */
export interface SentinelProxy {
	id: string;
	name: string;
	mode: Exclude<SentinelProxyMode, "off">;
	simple: SentinelSimpleProxy;
	/** Present when `mode` is `subscription`. */
	subscription: SentinelProxySubscription | null;
	/** Present when `mode` is `wireguard`. */
	wireguard: SentinelWireGuard;
	/** Present when `mode` is `openvpn`. */
	openvpn: SentinelOpenVpn;
	/** Cached nodes; only a subscription profile has any. */
	nodes: SentinelProxyNode[];
	/** Which node the generated selector defaults to. */
	nodeTag: string;
	/** Nodes the last parse could not use, and why. */
	skipped: { name: string; reason: string }[];
	routePrivateDirect: boolean;
	/** Absent until the profile has been tested. */
	test?: SentinelProxyTest | null;
	createdAt: number;
}

/** Everything the 代理 page renders. */
export interface SentinelProxyConfigView {
	proxies: SentinelProxy[];
	/**
	 * Proxy a project follows when it has no choice of its own; null means new
	 * projects start without one.
	 */
	defaultId: string | null;
	/** Image every sidecar runs, whatever profile it uses. */
	image: string;
	/** Whether that image is present locally. */
	imagePresent: boolean;
	/** URL the batch latency test fetches through each node. */
	testUrl: string;
}

/** One profile as the page saves it; `id` absent creates a new one. */
export interface SentinelProxyInput {
	id?: string;
	name: string;
	mode: Exclude<SentinelProxyMode, "off">;
	simple: SentinelSimpleProxy;
	/** The tunnel, when `mode` is `wireguard`. */
	wireguard: SentinelWireGuard;
	/** The tunnel, when `mode` is `openvpn`. */
	openvpn: SentinelOpenVpn;
	/** Subscription URL and user agent; the nodes themselves are fetched here. */
	subscriptionUrl: string;
	subscriptionUserAgent: string;
	/** Re-read every N hours; 0 turns the timer off. */
	subscriptionIntervalHours: number;
	/** Which cached node the profile should use; empty picks the first. */
	nodeTag: string;
	routePrivateDirect: boolean;
}

/**
 * What the 代理 page renders before the first environment report arrives. The real
 * values always come from the server; this only keeps the page renderable while
 * the console is still checking Docker.
 */
/** What a tunnel profile starts from: no keys, everything through it, kill switch on. */
export const EMPTY_WIREGUARD: SentinelWireGuard = {
	config: "",
	dns: "",
	killSwitch: true,
};

/** What an OpenVPN profile starts from: no configuration, no credentials, kill switch on. */
export const EMPTY_OPENVPN: SentinelOpenVpn = {
	config: "",
	dns: "",
	username: "",
	password: "",
	killSwitch: true,
};

/**
 * The tag that means "let sing-box rank the nodes". It is not a node: it is the
 * generated `urltest` group, offered wherever a node can be chosen.
 */
export const AUTO_NODE_TAG = "auto";

export const EMPTY_PROXY_CONFIG: SentinelProxyConfigView = {
	proxies: [],
	defaultId: null,
	image: "",
	imagePresent: false,
	testUrl: "https://www.gstatic.com/generate_204",
};

/** What the proxy editor starts from when creating a profile. */
export const EMPTY_PROXY_INPUT: SentinelProxyInput = {
	name: "",
	mode: "simple",
	simple: { type: "socks5", server: "", port: 0, username: "", password: "", tls: false },
	wireguard: EMPTY_WIREGUARD,
	openvpn: EMPTY_OPENVPN,
	subscriptionUrl: "",
	subscriptionUserAgent: "",
	subscriptionIntervalHours: 0,
	nodeTag: "",
	routePrivateDirect: true,
};

export interface SentinelEnvReport {
	at: string;
	ok: boolean;
	items: SentinelEnvItem[];
	url: string;
	/** Build sources as configured; an empty field means the official source. */
	sources: SentinelSources;
	/** Network mode new and rebuilt containers are created with. */
	containerNetwork: SentinelContainerNetwork;
	/** Proxy profiles as configured, for the environment page's summary. */
	proxies: SentinelProxyConfigView;
}

/** Union of the session events the UI reacts to. */
export type SessionEventView =
	| { type: "message_start"; message: AgentMessageView }
	| {
			type: "message_update";
			message: AgentMessageView;
			assistantMessageEvent:
				| { type: "text_delta"; delta: string }
				| { type: "thinking_delta"; delta: string }
				| { type: string };
	  }
	| { type: "message_end"; message: AgentMessageView }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			/** Set when a codemode script (or another tool) made this call. */
			parentToolCallId?: string;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			partialResult: unknown;
			parentToolCallId?: string;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: { content?: ContentBlockView[] } | null;
			isError: boolean;
			durationMs?: number;
			parentToolCallId?: string;
	  }
	| { type: "agent_start" }
	| { type: "agent_settled"; aborted: boolean }
	| { type: "queue_update"; steering: string[]; followUp: string[] };

// ---------------------------------------------------------------------------
// Engineering mode (mirrors packages/web/src/protocol.ts)
// ---------------------------------------------------------------------------

export type SentinelEngineStatus = "scheduled" | "running" | "paused" | "completed" | "stopped";

/**
 * How an engine's workers get their commands approved. Engineering mode is
 * unattended, so `review` is not offered.
 */
export type SentinelEngineGateMode = "auto" | "ai";

export type SentinelEngineTaskStatus = "queued" | "running" | "done" | "failed" | "blocked" | "aborted" | "paused";

export interface SentinelEngineTarget {
	target: string;
	note?: string;
}

/** One step of a one-shot engineering schedule. */
export type SentinelEngineScheduleAction = "start" | "pause" | "resume" | "deadline";

export type SentinelEngineSchedulePhase = "waiting_start" | "running" | "paused" | "finished";

export type SentinelEngineScheduleFinishReason =
	| "completed"
	| "deadline"
	| "manual"
	| "canceled"
	| "start_failed"
	| "missed"
	| "restart";

export interface SentinelEngineSchedule {
	timezone: string;
	startAt: number;
	pauseAt: number | null;
	resumeAt: number | null;
	deadlineAt: number | null;
	repeatDaily: boolean;
	phase: SentinelEngineSchedulePhase;
	applied: SentinelEngineScheduleAction[];
	finishedReason: SentinelEngineScheduleFinishReason | null;
	finishedAt: number | null;
}

export interface SentinelEngineScheduleInput {
	timezone: string;
	startAt: number;
	pauseAt?: number | null;
	resumeAt?: number | null;
	deadlineAt?: number | null;
	repeatDaily?: boolean;
}

export interface SentinelEngineLimits {
	concurrency: number;
	roundLimit: number;
	tokenLimit: number | null;
	timeLimitMin: number | null;
	maxRetries: number;
}

export interface SentinelEngineTaskContinue {
	instruction: string;
	criteria: string[];
	roundLimit: number;
	requestedAt: number;
}

export interface SentinelEngineTask {
	id: string;
	engineId: string;
	title: string;
	objective: string;
	target: string | null;
	workspace: string;
	status: SentinelEngineTaskStatus;
	attempt: number;
	criteria: string[];
	roundLimit: number;
	/** A requested continuation that has not started yet. */
	pendingContinue: SentinelEngineTaskContinue | null;
	/**
	 * Which preset agent this task runs as, fixed at dispatch. `presetName` is
	 * copied in rather than resolved from the preset library, so the board still
	 * shows what a finished task ran as after the preset is deleted or renamed.
	 */
	presetId: string | null;
	presetName: string | null;
	sessionId: string | null;
	startedAt: number | null;
	endedAt: number | null;
	summary: string | null;
	error: string | null;
	usage: SentinelGoalUsage | null;
	vulns: number;
	autoResume: boolean;
}

export interface SentinelEngine {
	id: string;
	projectId: string;
	projectName: string;
	name: string;
	status: SentinelEngineStatus;
	pauseNote: string | null;
	targets: SentinelEngineTarget[];
	doctrines: string[];
	/**
	 * Preset agents the commander may dispatch with. Empty means no restriction:
	 * the brief lists every enabled preset. A non-empty list narrows the choice,
	 * and `dispatch_task` refuses a preset outside it.
	 */
	presetIds: string[];
	/**
	 * Whether a task may run without a preset, as the default agent. True is how
	 * every engine behaved before this switch existed, and it stays the default.
	 * False makes `dispatch_task` refuse a dispatch that names no preset, so every
	 * worker runs under an identity the operator allowed.
	 */
	presetOptional: boolean;
	limits: SentinelEngineLimits;
	/** How this engine's worker commands are gated; see SentinelEngineGateMode. */
	gateMode: SentinelEngineGateMode;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
	schedule: SentinelEngineSchedule | null;
	report: string | null;
	reproduction?: CodeReproductionResult | null;
	tasks: SentinelEngineTask[];
}

export interface SentinelDoctrineView {
	id: string;
	name: string;
	text: string;
	builtin: boolean;
}

/**
 * One preset agent: a named block of extra system-prompt context.
 *
 * Metadata only. The prompt body lives in `presets/<id>.md` and is loaded on
 * demand, so the session list can be read without pulling every preset's text
 * into memory.
 */
export interface SentinelPreset {
	id: string;
	name: string;
	description: string;
	tags: string[];
	/** The composer's idle hint while this preset is in force; empty means the default text. */
	placeholder: string;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

/** A preset as the settings screen needs it: metadata plus the loaded body. */
export interface SentinelPresetView extends SentinelPreset {
	text: string;
	/** The body file is gone; the entry is unusable until the operator rewrites it. */
	textMissing: boolean;
	/** Rough token cost of `text`, so a huge preset is visible before it is used. */
	tokens: number;
}

/**
 * The preset agent a session was created with, as the console shows it. `null`
 * on the snapshot means the session runs the plain default agent.
 */
export interface SentinelSessionPresetView {
	id: string;
	/** The current name; falls back to the id when the preset was deleted. */
	name: string;
	/** The preset is gone or its body file is missing: the session runs the default agent. */
	missing: boolean;
	/** The preset's composer hint; empty when it has none, or when the preset is gone. */
	placeholder: string;
}

export interface SentinelEngineCreateInput {
	name: string;
	targets: string;
	doctrines: string[];
	/** Preset agents the commander may use; empty or omitted means no restriction. */
	presetIds?: string[];
	/** Whether a task may run without a preset; omitted means it may. */
	presetOptional?: boolean;
	limits: SentinelEngineLimits;
	gateMode?: SentinelEngineGateMode;
	schedule?: SentinelEngineScheduleInput;
}
