/** Wire protocol shared by the Full Chain Sentinel web console server and browser client. */

import type {
	AgentSessionEvent,
	ImageContent,
	SessionStats,
	SessionTreeNode,
	ThinkingLevel,
} from "@earendil-works/pi-coding-agent";
import type { DroidDevice, DroidToken } from "./droid.ts";
import type { UiLanguage } from "./i18n-messages.ts";
import type { IosDevice, IosToken } from "./ios.ts";
import type { SentinelPermissionPreset, SentinelPermissionSet, SentinelPermissionsConfig } from "./permissions.ts";
import type { SentinelPluginManifest } from "./plugin-manifest.ts";
import type { SentinelSessionListEntry, SentinelSessionStatus } from "./session-status.ts";

/**
 * Who decides whether a bash command may run.
 *
 * `review` asks the operator, `ai` asks the gatekeeper model, `auto` runs it.
 * `ai` is not a weaker `auto`: a judgment that fails is allowed through (so a
 * dead endpoint cannot stall an unattended run), but a missing endpoint refuses
 * the mode outright rather than silently degrading.
 */
export type SentinelMode = "review" | "ai" | "auto";

/** Usage retained across sessions, projects and service restarts. */
export type SentinelUsageTotals = Pick<SessionStats, "tokens" | "cost">;

export type SentinelStats = SessionStats & { cumulative: SentinelUsageTotals };

/** The modes a session may carry; the order the console lists them in. */
export const SENTINEL_MODES: readonly SentinelMode[] = ["review", "ai", "auto"];

/** Lifecycle of a persistent goal. Only the model ends one successfully. */
export type SentinelGoalStatus = "active" | "paused" | "blocked" | "completed";

/** Why an active goal stopped. Manual covers the operator's pause and abort. */
export type SentinelGoalPauseReason = "manual" | "limit" | "no-progress" | "interrupted" | "loop-guard";

/** The initial run, or one automatic continuation. */
export type SentinelGoalRoundKind = "initial" | "continue";

/** How a round ended, for the timeline. */
export type SentinelGoalRoundOutcome = "continued" | "completed" | "blocked" | "paused" | "aborted" | "error";

/** Token and cost counters. Cost is null when the endpoint reports no price. */
export interface SentinelGoalUsage {
	input: number;
	output: number;
	total: number;
	cost: number | null;
}

/** What the model last reported through `goal_progress`. */
export interface SentinelGoalProgress {
	done: string[];
	todo: string[];
	blockers: string[];
}

/** One acceptance criterion with the verdict given at completion. */
export interface SentinelGoalCriterionResult {
	criterion: string;
	met: boolean;
	evidence: string;
}

/** The evidence a completed goal carries. */
export interface SentinelGoalCompletion {
	summary: string;
	evidence: string[];
	/** Findings submitted to the hub during this goal, as verified by the runtime. */
	submitted: number;
	/** Required when nothing was submitted: why the run found nothing to report. */
	findingsNote: string;
	criteria: SentinelGoalCriterionResult[];
	at: number;
}

/** The blocker report that stopped a goal. */
export interface SentinelGoalBlocked {
	reason: string;
	evidence: string[];
	/** Consecutive rounds the same blocker was reported. */
	streak: number;
	at: number;
}

/** One round of a goal: the initial run, or one automatic continuation. */
export interface SentinelGoalRound {
	/** 0 is the initial run; continuations count up from 1. */
	index: number;
	kind: SentinelGoalRoundKind;
	startedAt: number;
	endedAt?: number;
	/** Tool calls the round made; zero for three rounds running trips the fuse. */
	toolCalls: number;
	usage?: SentinelGoalUsage;
	/** Closing summary: what `goal_progress` said, or the round's last prose. */
	summary?: string;
	summaryFromTool?: boolean;
	outcome?: SentinelGoalRoundOutcome;
	blockerReason?: string;
}

/**
 * One persistent goal. Stored in the session file as a state entry, so it
 * survives a reload, a compaction, and a branch switch with the session it
 * belongs to.
 */
export interface SentinelGoal {
	id: string;
	objective: string;
	/** Acceptance criteria; empty means the operator left them out. */
	criteria: string[];
	/** Automatic continuations allowed. The initial run is not counted. */
	roundLimit: number;
	roundsUsed: number;
	/** Consecutive rounds without a tool call. */
	noProgressStreak: number;
	/** Consecutive rounds reporting the same blocker. */
	blockerStreak: number;
	status: SentinelGoalStatus;
	pauseReason?: SentinelGoalPauseReason;
	pauseNote?: string;
	/** Usage when the goal started, so the bar can show what this goal cost. */
	baseline: SentinelGoalUsage;
	progress: SentinelGoalProgress;
	rounds: SentinelGoalRound[];
	lastBlocker?: string;
	/** Findings submitted to the hub while this goal ran. */
	submitted: number;
	completion?: SentinelGoalCompletion;
	blocked?: SentinelGoalBlocked;
	createdAt: number;
	startedAt: number;
	endedAt?: number;
	updatedAt: number;
}

/** A goal as the console shows it: the stored record plus live counters. */
export interface SentinelGoalView extends SentinelGoal {
	/** Main-agent usage since the goal started. */
	usage: SentinelGoalUsage;
	/** Sub-agent work of this goal. Shown for context; it does not consume rounds. */
	subagent: { runs: number; turns: number };
	/** Whether the goal's session has a run in flight right now. */
	running: boolean;
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

/**
 * What pi needs to know about a model beyond its id. Absent fields fall back to
 * pi's own defaults (128k context, 16k output, no reasoning, text only, no
 * prices, no cache lifetime). `api` defaults to OpenAI Chat Completions.
 */
export interface SentinelModelCapabilities {
	api?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	cost?: SentinelModelCostRates;
	promptCache?: SentinelModelPromptCache;
}

/** Model endpoint configuration persisted in models.json. */
export interface SentinelModelConfig {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	/** Present when the operator declared capabilities for this model. */
	capabilities?: SentinelModelCapabilities;
}

/** The jobs a model can be assigned to. */
export type SentinelModelRoleName = "main" | "judge" | "reviewer" | "supervisor" | "commander" | "monitor";

/**
 * One row of the model library as the settings screen sees it. The key itself is
 * never sent to the client; `hasKey` only says whether one is stored.
 */
export interface SentinelModelEntryView {
	id: string;
	name: string;
	baseUrl: string;
	modelId: string;
	hasKey: boolean;
	/** Roles currently pointing at this entry. */
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
 * channel first, then a model inside it, so the operator never needs a model id.
 */
export interface SentinelBuiltinChannel {
	provider: string;
	name: string;
	/** Protocol most models of this channel speak; a model's own value wins. */
	api: string;
	/** Primary endpoint for display; `baseUrls` holds every variant for matching. */
	baseUrl: string;
	baseUrls: string[];
	modelCount: number;
	/** Belongs to the short list of direct vendors shown above "更多渠道". */
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

/** What a role resolves to right now, so the screen can show the effective endpoint. */
export interface SentinelResolvedModelView {
	entryId: string;
	entryName: string;
	modelId: string;
	/** True when the role resolved through 主模型 instead of its own entry. */
	followedMain: boolean;
}

/**
 * The whole model screen: the library, the role assignments (entry id, or
 * "follow-main" for judge/reviewer, or null for an unset main), and what each
 * role currently resolves to.
 */
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

/** The chat robots a finished notification can go to. */
export type SentinelNotifyChannel = "dingtalk" | "feishu" | "wecom";

/** One robot's connection settings. */
export interface SentinelNotifyChannelConfig {
	enabled: boolean;
	/** Custom-robot webhook URL, including its access token. */
	webhook: string;
	/** Optional signing secret ("加签"). Empty sends an unsigned request. */
	secret: string;
	/** Optional custom keyword, prepended to the body for keyword-secured robots. */
	keyword: string;
}

/**
 * Notification configuration persisted in notifications.json. DingTalk keeps the
 * legacy top-level fields; Feishu is nested so an existing file still loads.
 */
export interface SentinelNotifyConfig extends SentinelNotifyChannelConfig {
	/**
	 * Which notifications to push while either channel is enabled. All default to
	 * on, which is what a config written before the checkboxes existed does; a
	 * run forced from the composer still pushes with run reports off, because an
	 * explicit ask beats a general filter.
	 */
	kinds: { runs: boolean; vulns: boolean; goals: boolean; engines: boolean; pocs: boolean };
	/**
	 * How many characters of notification body to keep, counted per section (a run's
	 * closing summary, a goal's conclusion, a finding's raw packet). 0 keeps all of
	 * it. Each platform's byte limit is enforced separately, whatever this says.
	 */
	summaryLimit: number;
	feishu: SentinelNotifyChannelConfig;
	/**
	 * WeCom group robot. Its webhook already carries the access token, and the
	 * platform has no signing or keyword mode of its own, so only the webhook is
	 * used; the inherited secret/keyword fields stay empty.
	 */
	wecom: SentinelNotifyChannelConfig;
}

/** Outcome of the most recent notification send, for the settings screen. */
export interface SentinelNotifyStatus {
	/** Epoch milliseconds of the attempt, or null when nothing was sent yet. */
	at: number | null;
	ok: boolean;
	/** Failure reason(s), or the platform error code when a robot rejected it. */
	error?: string;
	/** What the notification was for, e.g. the session title. */
	subject?: string;
	/** Per-channel outcome for the most recent multi-channel send. */
	channels?: Partial<Record<SentinelNotifyChannel, { ok: boolean; error?: string }>>;
}

/**
 * One mounted tool of the live session, listed on the permissions screen so the
 * operator can check what the switches actually produced.
 */
export interface SentinelToolInfo {
	name: string;
	/** Where the tool came from, e.g. "base", "extension", "sdk", "mcp". */
	source: string;
	/** Whether the model sees it right now (as opposed to codemode/deferred only). */
	active: boolean;
}

/** Result of probing an endpoint configuration without saving it. */
export interface SentinelTestResult {
	ok: boolean;
	/** Human-readable summary in Chinese for direct display. */
	message: string;
	/** Technical detail, e.g. the response body excerpt or error cause. */
	detail?: string;
}

/** A bash command awaiting operator approval. */
export interface SentinelApprovalRequest {
	id: string;
	command: string;
	cwd: string;
	/** Which agent issued the command, e.g. "主代理" or "子代理". */
	source?: string;
}

// ---------------------------------------------------------------------------
// Gatekeeper (审批)
// ---------------------------------------------------------------------------

/**
 * What the gatekeeper decided about one bash command.
 *
 * `failed` is deliberately separate from `allow`: a judgment that never arrived
 * is allowed through, but it is a different event from the gatekeeper reading
 * the command and clearing it, and the audit page has to keep them apart.
 */
export type SentinelGateDecisionKind = "allow" | "block" | "failed";

/**
 * Who let the call through. Every tool call lands in exactly one bucket:
 *
 * - `ai`    the gatekeeper judged it — bash and droid_shell in AI 审批, plus MCP
 *           and plugin tools while the MCP switch is on. The only bucket with a
 *           verdict, a latency and a token cost.
 * - `human` 审批模式: the operator approved or rejected it in the queue.
 * - `auto`  nobody looked: 自动执行 mode, an allow-listed prefix, or a tool the
 *           judge does not cover (read, edit, write, …).
 *
 * The audit page shows the first bucket as 「AI 审批」 and the other two as
 * 「自动审批」, which together cover every call exactly once.
 */
export type SentinelGateApproval = "ai" | "human" | "auto";

/** One gatekeeper judgment, as stored and as streamed to the console. */
export interface SentinelGateDecision {
	id: string;
	/** Epoch milliseconds when the judgment started. */
	at: number;
	projectId: string | null;
	projectName: string | null;
	/** Session that issued the command. */
	sessionId: string | null;
	/** Which agent issued it: 主代理 / 子代理 / 工程任务「X」. */
	source: string;
	tool: string;
	command: string;
	/** The stored command was cut to the per-record cap. */
	commandTruncated?: boolean;
	cwd: string | null;
	/** Who let it through; see SentinelGateApproval. */
	approval: SentinelGateApproval;
	decision: SentinelGateDecisionKind;
	/** The gatekeeper's BLOCK reason, or the failure text for `failed`. */
	reason?: string;
	latencyMs: number;
	/** Endpoint that produced the verdict, e.g. "judge-stub". */
	model?: string;
	/** Display name of the library entry the endpoint came from. */
	modelFrom?: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	/** Raw error text when the judgment could not be completed. */
	error?: string;
}

/** Audit list filters; every field is optional and they combine with AND. */
export interface SentinelGateFilter {
	decision?: SentinelGateDecisionKind;
	projectId?: string;
	sessionId?: string;
	/** Exact source label, e.g. "子代理". */
	source?: string;
	/**
	 * Which buckets to include. An array because the page's 「自动审批」 tab is
	 * two buckets at once (human + auto); an empty or absent list means all three.
	 */
	approval?: SentinelGateApproval[];
	/** Case-insensitive substring match on the command and the reason. */
	search?: string;
	/** Only judgments at or after this epoch millisecond. */
	since?: number;
}

/** Counts and cost figures for the audit page header. */
export interface SentinelGateStats {
	total: number;
	byDecision: Record<SentinelGateDecisionKind, number>;
	/** Rows per approval bucket, so each tab can summarise itself. */
	byApproval: Record<SentinelGateApproval, number>;
	/** block / total, 0 when nothing was judged yet. */
	blockRate: number;
	avgLatencyMs: number;
	/** Judge tokens spent; never counted into a session's own usage. */
	totalTokens: number;
	/** Judgments in the last 24 hours, so the page can show whether it is alive. */
	last24h: number;
	/** Judgments that ended in a failure (all of which were allowed through). */
	failures: number;
	lastFailureAt: number | null;
	/** When the judge last answered at all, block included. */
	lastSuccessAt: number | null;
	lastError: string | null;
}

/** One page of audit records, newest first. */
export interface SentinelGatePage {
	items: SentinelGateDecision[];
	/** Records matching the filter, not the page size. */
	total: number;
	page: number;
	pageSize: number;
}

/**
 * MCP tool judging: the gatekeeper's second entrance.
 *
 * bash is judged inside the bash tool, at the point where the command would
 * enter the container. MCP tools — plugin tools included — have no such seam, so
 * they are judged on the agent's `tool_call` event instead. The switch exists
 * because every judged call costs one model round-trip: an operator who only
 * cares about shell commands can leave it off, and one who wants plugins watched
 * without the noise of every custom MCP server can narrow it further.
 */
export interface SentinelMcpToolGate {
	/** Judge MCP tool calls at all, in AI 审批 mode only. */
	enabled: boolean;
	/**
	 * Include plugin-host tools (server names `plugin-*`). Those are the ones that
	 * can drive managed hosts, so they are the most worth watching — and the
	 * noisiest, because a single plugin exposes dozens of tools.
	 */
	includePlugins: boolean;
}

/** Gatekeeper settings persisted in gatekeeper.json. */
export interface SentinelGatekeeperConfig {
	/** Console-wide default mode; a session may override it. */
	mode: SentinelMode;
	/** How long one judgment may take before it counts as a failure. */
	timeoutMs: number;
	/** Judgments allowed in flight at once; 0 means no limit. */
	concurrency: number;
	/** Which non-shell tools the judge also sees. */
	mcpTools: SentinelMcpToolGate;
}

/** Live gatekeeper state carried in every snapshot. */
export interface SentinelGatekeeperView {
	/** The console-wide default. */
	globalMode: SentinelMode;
	/** Mode in effect for the active session (its override, or the global default). */
	sessionMode: SentinelMode;
	/** The active session's own choice; null means it follows the global default. */
	sessionOverride: SentinelMode | null;
	/** The endpoint the 守门模型 role resolves to; null when nothing resolves. */
	judgeResolved: SentinelResolvedModelView | null;
	/** Judgments that failed and were allowed through. */
	failures: number;
	lastFailureAt: number | null;
	/** When the judge last answered; newer than `lastFailureAt` means it recovered. */
	lastSuccessAt: number | null;
	lastError: string | null;
}

/** A registered project (named working directory). */
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

/** One directory entry in the container work directory. */
export interface SentinelFileEntry {
	name: string;
	/** Absolute path inside the container. */
	path: string;
	type: "dir" | "file";
	size: number;
	/** Unix seconds. */
	mtime: number;
}

/** Bounded inline view of one file. */
export interface SentinelFilePreview {
	path: string;
	kind: "text" | "image" | "binary";
	size: number;
	truncated: boolean;
	/** Present for kind "text". */
	text?: string;
	/** Base64 payload, present for kind "image". */
	data?: string;
	mimeType?: string;
}

/**
 * The operator's shell in a project container.
 *
 * Each project keeps its shell alive when that project's panel closes.
 */
export interface SentinelTerminalSession {
	status: "running" | "exited";
	projectId: string;
	projectName: string;
	container: string;
	cols: number;
	rows: number;
	startedAt: number;
	/** Exit code once the shell is gone; null while it runs. */
	code: number | null;
}

/** Lifecycle of one sub-agent run. */
export type SentinelSubagentStatus = "running" | "done" | "error" | "aborted";

/** One normalized step of a sub-agent's process, in order. */
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

/** A sub-agent run: live state plus the summary retained in the history list. */
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
	/** Buffered process steps; only sent for one run on demand, never in a snapshot. */
	events?: SentinelSubagentEvent[];
}

/** Severity buckets of the vulnerability hub. */
export type SentinelVulnSeverity = "critical" | "high" | "medium" | "low" | "info";

/**
 * Lifecycle of one finding. The agent always creates `pending`; only the
 * operator moves a record on from there, because a finding the model believes in
 * is still a hypothesis until someone reproduces it.
 */
export type SentinelVulnStatus = "pending" | "confirmed" | "false_positive" | "fixed";

/** One piece of supporting evidence: a command with its output, or a container file. */
export interface SentinelVulnEvidence {
	kind: "command" | "file";
	command?: string;
	output?: string;
	/** Absolute path inside the project container (/work/...), previewed in place. */
	path?: string;
	note?: string;
}

/** One entry of a finding's timeline: a status change or a free-text remark. */
export interface SentinelVulnNote {
	at: string;
	author: "agent" | "operator" | "system";
	text: string;
	statusFrom?: SentinelVulnStatus;
	statusTo?: SentinelVulnStatus;
}

/**
 * One finding in the hub. `packet` holds the raw request or packet that proves
 * it, which is why it is a required field rather than part of the description.
 */
/** The dedicated reviewer LLM's verdict on one finding. */
export interface SentinelVulnReview {
	/** queued = waiting for the reviewer; done = verdict applied; failed = endpoint/parse error; skipped = operator acted first. */
	state: "queued" | "done" | "failed" | "skipped";
	/** The reviewer's own rating, present when state is "done". */
	severity?: SentinelVulnSeverity;
	cvss?: number;
	cvssVector?: string;
	/** solid = evidence supports the finding; dubious = it does not (hallucination suspects). */
	verdict?: "solid" | "dubious";
	/** One-paragraph justification, always in Chinese for the operator. */
	reason?: string;
	/** Which model produced the verdict, e.g. "gpt-4o-mini". */
	model?: string;
	/** Failure reason, present when state is "failed". */
	error?: string;
	/**
	 * The agent's own rating, kept beside the reviewer's verdict.
	 *
	 * The record carries these numbers until the reviewer rules — and keeps
	 * them after a failed review — so the console can say 「自评」 instead of
	 * presenting an unverified number as a calibrated one.
	 */
	agentSeverity?: SentinelVulnSeverity;
	agentCvss?: number;
	at: number;
}

export interface SentinelVulnerability {
	/** The reviewer LLM's verdict; a fresh submission starts as "queued". */
	review: SentinelVulnReview;
	id: string;
	/** Human-readable id, `<project prefix>-<sequence>`, e.g. "E2E-PROJECT-0003". */
	label: string;
	/** Sequence within the project, starting at 1. */
	number: number;
	projectId: string;
	projectName: string;
	/** Main session the submission belongs to. */
	sessionId?: string;
	/** Engineering provenance: the engine and task this finding came from. */
	engineId?: string;
	taskId?: string;
	/** Session display name at submission time, for records whose session is gone. */
	sessionName?: string;
	/** Inventory asset this finding was linked to, when the submitter named one. */
	assetId?: string;
	/** Asset label snapshot, so the hub can show it after the asset is gone. */
	assetLabel?: string;
	/** Who submitted it: "主代理" or "子代理 <runId>". */
	source: string;
	title: string;
	severity: SentinelVulnSeverity;
	/** CVSS base score, 0.0-10.0. */
	cvss: number;
	/** Optional CVSS vector string. */
	cvssVector?: string;
	status: SentinelVulnStatus;
	/** Affected target: host, URL, IP:port or service. */
	target: string;
	/** Vulnerability class, e.g. "SQL 注入" or "未授权访问". */
	category?: string;
	/** 平台：web（默认）或 android（Droid 插件提交的移动端发现）。 */
	platform: "web" | "android";
	/** android 时可选：目标应用的包名与版本。 */
	appPackage?: string;
	appVersion?: string;
	description: string;
	/** Raw request or packet, verbatim. */
	packet: string;
	repro?: string;
	remediation?: string;
	references?: string[];
	createdAt: string;
	updatedAt: string;
	evidence: SentinelVulnEvidence[];
	notes: SentinelVulnNote[];
	/** True when the CVSS score maps to a different bucket than `severity`. */
	severityMismatch: boolean;
}

/** A finding without its heavy fields, for the list and for the agent's query. */
export type SentinelVulnSummary = Omit<SentinelVulnerability, "packet" | "evidence" | "notes">;

/** List filters; every field is optional and they combine with AND. */
export interface SentinelVulnFilters {
	/** Restrict to selected records; an empty selection matches nothing. */
	ids?: string[];
	status?: SentinelVulnStatus;
	/** Match any selected level; omitted or empty means all levels. */
	severity?: SentinelVulnSeverity[];
	/** Case-insensitive substring match on the affected target. */
	target?: string;
	/** Case-insensitive substring match on label, title, category, description and source. */
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

/** Operator edits; the agent may not change a record after submitting it. */
export interface SentinelVulnUpdate {
	status?: SentinelVulnStatus;
	severity?: SentinelVulnSeverity;
	cvss?: number;
	/** Appended to the timeline. */
	note?: string;
}

/** Counts for the hub page header. */
export interface SentinelVulnStats {
	total: number;
	bySeverity: Record<SentinelVulnSeverity, number>;
	byStatus: Record<SentinelVulnStatus, number>;
}

// ---------------------------------------------------------------------------
// 资产库（Agent 上报的资产台账）
// ---------------------------------------------------------------------------

/**
 * What one inventory row describes. A row is one reachable endpoint, not a
 * container for every field: a URL, an IP:port service, a bare IP, or a bare
 * domain. The agent reports what it actually touched; the operator decides what
 * it means.
 */
export type SentinelAssetKind = "domain" | "ip" | "service" | "url";

/** Operator workflow state; the agent never writes it directly. */
export type SentinelAssetState = "pending" | "testing" | "tested" | "out_of_scope";

/** One test record's conclusion; `note` is an observation, not a conclusion. */
export type SentinelAssetOutcome = "note" | "clean" | "suspicious" | "vulnerable" | "unreachable";

/** One entry of an asset's timeline. */
export interface SentinelAssetEntry {
	seq: number;
	/** record = test/remark (counted); status = operator state change (not counted). */
	kind: "record" | "status";
	at: string;
	author: "agent" | "operator";
	/** Agent-side provenance, e.g. "主代理" or "子代理 <runId>". */
	source?: string;
	outcome: SentinelAssetOutcome;
	/** Command or method used, e.g. "nmap -sV". */
	method?: string;
	/** Observation text; may be empty for a bare outcome. */
	text: string;
	/** Set on the entry created by linking a hub finding. */
	vulnLabel?: string;
}

/** One asset without its timeline, for lists and for the agent's query. */
export interface SentinelAssetSummary {
	id: string;
	/** Human-readable id, `<project prefix>-A<sequence>`, e.g. "E2E-A0001". */
	label: string;
	number: number;
	projectId: string;
	projectName: string;
	kind: SentinelAssetKind;
	/** Canonical identifier: domain, IP, IP:port, or URL. */
	name: string;
	/** Owning host: the domain/IP, or the URL host including a non-default port. */
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
	/** Who first reported it: "主代理" / "子代理 <runId>" / "工程任务「…」". */
	source: string;
	sessionId?: string;
	engineId?: string;
	taskId?: string;
	sessionName?: string;
	/** Number of timeline records, excluding status changes. */
	testCount: number;
	/** Latest conclusive outcome; notes never overwrite it. */
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

/** One asset with the findings linked to it. */
export interface SentinelAssetDetail {
	asset: SentinelAsset;
	vulns: SentinelVulnSummary[];
}

/** List filters; every field is optional and they combine with AND. */
export interface SentinelAssetFilters {
	kind?: SentinelAssetKind;
	status?: SentinelAssetState;
	/** true = has a conclusive record; false = none. Notes do not count. */
	tested?: boolean;
	/** Case-insensitive substring on label, name, host, URL, title, tags and source. */
	search?: string;
}

/** Operator edits; the agent writes through asset_report / asset_note instead. */
export interface SentinelAssetUpdate {
	status?: SentinelAssetState;
	/** Replaces the whole tag list; an empty array clears it. */
	tags?: string[];
	/** Appended as an operator record; defaults to note when outcome is absent. */
	outcome?: SentinelAssetOutcome;
	note?: string;
}

/** Counts for the inventory page header. */
export interface SentinelAssetStats {
	total: number;
	byKind: Record<SentinelAssetKind, number>;
	byStatus: Record<SentinelAssetState, number>;
	/** Assets with at least one conclusive record, regardless of status. */
	tested: number;
	untested: number;
}

/** What deleting the selected assets would take with them. */
export interface SentinelAssetDeletePreview {
	count: number;
	records: number;
	/** Findings whose asset link would be cleared (the findings themselves stay). */
	vulns: number;
}

// ---------------------------------------------------------------------------
// POC 库（Nuclei 模板中心）
// ---------------------------------------------------------------------------

/** Severity buckets mirror the hub's; nuclei uses the same five. */
export type SentinelPocSeverity = SentinelVulnSeverity;

/**
 * One imported Nuclei template. The library is read-only for the agent: the
 * yaml never enters the project container, and the only agent-facing tools
 * (poc_search / poc_read) hand back text. Firing a template means writing your
 * own yaml into the working directory and running nuclei on it via bash.
 */
export interface SentinelPoc {
	/** The template's own `info.id`, which imports dedupe on. */
	id: string;
	name: string;
	severity: SentinelPocSeverity;
	tags: string[];
	/** CVE ids extracted at import time. */
	references: string[];
	/** Full template yaml, verbatim. */
	content: string;
	/** File the template was imported from. */
	sourceFile: string;
	importedAt: string;
}

/** A template without its yaml, for lists. */
export type SentinelPocSummary = Omit<SentinelPoc, "content">;

/** List filters; every field is optional and they combine with AND. */
export interface SentinelPocFilters {
	/** Case-insensitive substring match on id, name, tags and CVE ids. */
	search?: string;
	severity?: SentinelPocSeverity;
	/** Exact tag match, e.g. "cve". */
	tag?: string;
}

export interface SentinelPocStats {
	total: number;
	bySeverity: Record<SentinelPocSeverity, number>;
}

// ---------------------------------------------------------------------------
// POC 订阅（远程 zip 源）
// ---------------------------------------------------------------------------

/**
 * One subscription source: a zip URL the operator subscribes to. Sync only
 * upserts (by template id) and never deletes — the library grows, and removing
 * a template stays a manual decision.
 */
export interface SentinelPocSource {
	id: string;
	name: string;
	url: string;
	/** Optional single auth header (e.g. Authorization). Present = one is set; the value itself never leaves the server. */
	headerName?: string;
	/** True when the stored source carries a header value. */
	headerSet: boolean;
	/** Hours between automatic syncs; 0 = manual only. */
	intervalHours: number;
	enabled: boolean;
	lastSyncAt: string | null;
	/** Newest outcome, mirrored at the top of `history`. */
	lastResult: SentinelPocSyncRecord | null;
	/** Recent sync outcomes, newest first (bounded server-side). */
	history: SentinelPocSyncRecord[];
}

/** Save payload: `id` absent creates a source; an empty header value keeps the stored one. */
export interface SentinelPocSourceSave {
	id?: string;
	name: string;
	url: string;
	headerName?: string;
	headerValue?: string;
	intervalHours: number;
	enabled: boolean;
}

/** One sync outcome kept on the source. */
export interface SentinelPocSyncRecord {
	at: string;
	ok: boolean;
	/** "manual" = operator clicked; "auto" = the interval timer fired. */
	trigger: "manual" | "auto";
	durationMs: number;
	imported: number;
	replaced: number;
	skipped: number;
	error?: string;
}

/** What one import batch produced. */
export interface SentinelPocImportOutcome {
	/** Newly inserted templates. */
	imported: number;
	/** Templates whose id already existed and were overwritten. */
	replaced: number;
	skipped: { name: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// 开源漏洞监测（Open-source vulnerability watch）
// ---------------------------------------------------------------------------

/**
 * What the monitor model said about one commit. `pending` means it was stored
 * but not judged yet; `failed` keeps the commit for a retry instead of turning
 * an endpoint error into a verdict.
 */
export type SentinelCodeVerdict = "pending" | "security" | "not_security" | "failed";

/** How a monitor decides when the next check is due. */
export type SentinelCodeScheduleKind = "interval" | "cron";

/** What started a check; kept in the audit log. */
export type SentinelCodeCheckTrigger = "manual" | "auto" | "batch";

/** Lifecycle of one check run. */
export type SentinelCodeCheckStatus = "running" | "ok" | "error";

/** Queue lifecycle of a check request. */
export type SentinelCodeJobStatus = "queued" | "running" | "done" | "failed";

/** Which slice of the project activity feed to read. */
export type SentinelCodeActivityFilter = "attention" | "review" | "failed" | "dispatch_failed" | "pending" | "all";

export interface SentinelCodeActivityCounts {
	attention: number;
	review: number;
	failed: number;
	dispatchFailed: number;
	pending: number;
	anomalies: number;
}

export interface SentinelCodeActivityView {
	items: SentinelCodeCommit[];
	total: number;
	page: number;
	pageSize: number;
	counts: SentinelCodeActivityCounts;
}

/** Server-side progress of a bulk monitor import. */
export interface SentinelCodeImportState {
	total: number;
	processed: number;
	succeeded: number;
	failed: number;
	current: string | null;
	running: boolean;
	errors: { url: string; error: string }[];
}

/** One queued or recently executed check request. */
export interface SentinelCodeCheckJob {
	id: string;
	monitorId: string;
	projectId: string;
	/** GitHub host, used for per-host concurrency. */
	host: string;
	trigger: SentinelCodeCheckTrigger;
	status: SentinelCodeJobStatus;
	/** Starts do not count; this is how many runs were launched. */
	attempts: number;
	maxAttempts: number;
	/** Earliest time the queue may start it, in epoch milliseconds. */
	nextRunAt: number;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
	error: string | null;
	/** Check-log row produced by the latest attempt. */
	checkId: string | null;
}

/**
 * Where a security commit stands after the operator's or the monitor's action.
 * "dispatching" marks a reproduce run in flight, so a page refresh (or a server
 * restart recovery) still shows the truth instead of snapping back to "new".
 */
export type SentinelCodeCommitStatus = "new" | "dispatching" | "dispatched" | "ignored";

/**
 * One watched repository.
 *
 * Polling is branch-scoped and stateful: `baselines` maps each watched branch to
 * the last commit already consumed, so a failed or capped check resumes where it
 * stopped instead of rescanning history. The token itself never leaves the
 * server; `tokenSet` only says one is stored.
 */
export interface SentinelCodeMonitor {
	id: string;
	projectId: string;
	projectName: string;
	name: string;
	/** Host as parsed from the URL, e.g. github.com or ghe.example.com. */
	host: string;
	owner: string;
	repo: string;
	repoUrl: string;
	/** REST base, e.g. https://api.github.com or https://ghe.example.com/api/v3. */
	apiBaseUrl: string;
	branches: string[];
	/** Branch → last consumed commit SHA. */
	baselines: Record<string, string>;
	tokenSet: boolean;
	/** Dispatch a confirmed finding to an engine without asking first. */
	autoDispatch: boolean;
	/** Minutes between automatic checks when `scheduleKind` is interval; 0 = manual. */
	intervalMinutes: number;
	scheduleKind: SentinelCodeScheduleKind;
	/** Five-field cron expression in server local time; null in interval mode. */
	cronExpression: string | null;
	/** Next firing, computed for display; null while a check is due or scheduled mode is off. */
	nextCheckAt: number | null;
	/** Whether a queued/running job currently exists for this monitor. */
	checkState: "idle" | "queued" | "running";
	enabled: boolean;
	lastCheckAt: number | null;
	lastError: string | null;
	createdAt: number;
	/** Security verdicts that were not ignored. */
	findingCount: number;
	/** Security verdicts not yet dispatched. */
	pendingCount: number;
}

/** One commit the monitor fetched, with the judge's verdict and the handoff state. */
export interface SentinelCodeCommit {
	id: string;
	monitorId: string;
	projectId: string;
	branch: string;
	sha: string;
	shortSha: string;
	/** First line of the message, for lists. */
	title: string;
	message: string;
	author: string;
	/** Epoch milliseconds. */
	authoredAt: number;
	url: string;
	verdict: SentinelCodeVerdict;
	/** 0–1, the monitor model's own confidence; null before a verdict. */
	confidence: number | null;
	/** CVE or GHSA id when the commit names one. */
	cve: string | null;
	severity: SentinelVulnSeverity | null;
	/** Vulnerability class, e.g. "路径穿越" or "反序列化". */
	vulnType: string | null;
	reason: string | null;
	status: SentinelCodeCommitStatus;
	/** Engine started for this finding, once dispatched. */
	engineId: string | null;
	/** Another finding in the same monitor already covers this one. */
	duplicateOf: string | null;
	/** Why the last dispatch failed; cleared by a successful one. */
	error: string | null;
	additions: number;
	deletions: number;
	files: number;
	/** Bounded unified diff used for judging, kept for the detail view. */
	diff: string | null;
	createdAt: number;
	judgedAt: number | null;
}

/** One executed (or interrupted) check, for the detail page's log. */
export interface SentinelCodeCheckLog {
	id: string;
	monitorId: string;
	trigger: SentinelCodeCheckTrigger;
	status: SentinelCodeCheckStatus;
	startedAt: number;
	endedAt: number | null;
	/** Commits consumed by this pass. */
	commits: number;
	/** Security verdicts reached by this pass. */
	findings: number;
	/** Branch/API/model error, or the reason an interrupted run was closed. */
	error: string | null;
}

/** One monitor plus its commit history and recent checks, newest first. */
export interface SentinelCodeMonitorDetail {
	monitor: SentinelCodeMonitor;
	commits: SentinelCodeCommit[];
	checks: SentinelCodeCheckLog[];
	jobs: SentinelCodeCheckJob[];
}

/**
 * Create/update payload. On update an omitted token keeps the stored one; an
 * empty string clears it. New branches get their current HEAD as the baseline.
 */
export interface SentinelCodeMonitorInput {
	projectId: string;
	/** HTTPS, SSH or bare `host/owner/repo`. */
	url: string;
	/** Display name; defaults to `owner/repo`. */
	name?: string;
	/** Empty or omitted on update keeps the stored token. */
	token?: string;
	/** Override the derived REST base, e.g. `https://ghe.example.com/api/v3`. */
	apiBaseUrl?: string;
	branches: string[];
	intervalMinutes?: number;
	/** Omitted on update keeps the stored strategy. */
	scheduleKind?: SentinelCodeScheduleKind;
	/** Required when scheduleKind is cron; null/empty clears it. */
	cronExpression?: string | null;
	autoDispatch?: boolean;
	enabled?: boolean;
}

// ---------------------------------------------------------------------------
// 业务建模（Business modeling）
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one modeling run. `modeling` is the only live state: the two
 * modeling tools are mounted in the session that started it. `done` is the
 * agent's own declaration, `manual` is the operator ending it, `failed` marks a
 * run whose session went away before it delivered anything.
 */
export type SentinelApiModelStatus = "modeling" | "done" | "manual" | "failed";

/** One field of a business entity the model inferred. */
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

/**
 * A business entity: the object the API is about (user, order, payment), not a
 * schema of the document. It is what makes the result a business model rather
 * than an endpoint list, and it is stored next to the OpenAPI document.
 */
export interface SentinelApiModelEntity {
	name: string;
	description?: string;
	fields?: SentinelApiModelField[];
	relations?: SentinelApiModelRelation[];
}

/** One stored modeling run. Every run is a new record; history is never overwritten. */
export interface SentinelApiModel {
	id: string;
	projectId: string | null;
	/** Session the run was started from; null when it could not be resolved. */
	sessionId: string | null;
	sessionPath: string | null;
	title: string;
	/** What was modeled: a base URL, a host, or the operator's own words. */
	target: string;
	status: SentinelApiModelStatus;
	/** OpenAPI 3.x document, verbatim. */
	openapi: Record<string, unknown>;
	entities: SentinelApiModelEntity[];
	pathCount: number;
	operationCount: number;
	/** How many submissions the run made; 0 means the agent never delivered. */
	submissions: number;
	/** Why the run ended without a document, when it did. */
	error?: string;
	createdAt: string;
	updatedAt: string;
	doneAt: string | null;
}

/** A run without the document body, for lists. */
export type SentinelApiModelSummary = Omit<SentinelApiModel, "openapi" | "entities"> & { entityCount: number };

/** List filters; every field is optional and they combine with AND. */
export interface SentinelApiModelFilters {
	status?: SentinelApiModelStatus;
	projectId?: string;
	/** Case-insensitive substring match on title and target. */
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

/** Live state of the modeling run in the viewed session, if any. */
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
// Engineering mode (工程模式)
// ---------------------------------------------------------------------------

/** Lifecycle of one engineering run. */
export type SentinelEngineStatus = "scheduled" | "running" | "paused" | "completed" | "stopped";

/**
 * How an engine's workers get their commands approved. Engineering mode is
 * unattended, so `review` is not offered: a worker would park on an approval
 * queue nobody is watching. `ai` routes every worker command through the
 * gatekeeper instead.
 */
export type SentinelEngineGateMode = "auto" | "ai";

/** Lifecycle of one engine task. Paused means interrupted (e.g. a restart). */
export type SentinelEngineTaskStatus = "queued" | "running" | "done" | "failed" | "blocked" | "aborted" | "paused";

/** One line of the operator's target list: a target plus an optional note. */
export interface SentinelEngineTarget {
	target: string;
	note?: string;
}

/**
 * One step of a scheduled engineering run. The timeline is one-shot: the times
 * are absolute epoch milliseconds, and `timezone` is carried only for display
 * (the browser that created the plan, e.g. Asia/Shanghai).
 */
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

/** Persisted plan for one engine; null when the engine was started immediately. */
export interface SentinelEngineSchedule {
	/** IANA zone of the operator when the plan was made; display only. */
	timezone: string;
	startAt: number;
	pauseAt: number | null;
	resumeAt: number | null;
	deadlineAt: number | null;
	/** Start a fresh engineering run each day after the prior run completes. */
	repeatDaily: boolean;
	phase: SentinelEngineSchedulePhase;
	/** Actions already applied, so a restarted scheduler never repeats them. */
	applied: SentinelEngineScheduleAction[];
	finishedReason: SentinelEngineScheduleFinishReason | null;
	finishedAt: number | null;
}

/** Operator input for a schedule; the server fills phase/applied/finished fields. */
export interface SentinelEngineScheduleInput {
	timezone: string;
	startAt: number;
	pauseAt?: number | null;
	resumeAt?: number | null;
	deadlineAt?: number | null;
	repeatDaily?: boolean;
}

/** Per-engine knobs; per-task limits derive from these unless overridden. */
export interface SentinelEngineLimits {
	/** How many tasks of this engine may run at the same time. */
	concurrency: number;
	/** Automatic continuation rounds per task. */
	roundLimit: number;
	/** Total tokens per task; null means no token limit. */
	tokenLimit: number | null;
	/** Wall-clock minutes per task; null means no time limit. */
	timeLimitMin: number | null;
	/** Dispatch attempts allowed per target (the first one counts). */
	maxRetries: number;
}

/**
 * A commander-requested continuation waiting for a worker slot. It is stored on
 * the task row, not in memory, so a service restart while it is queued does not
 * silently drop the instruction.
 */
export interface SentinelEngineTaskContinue {
	/** What the worker should do next, on top of its existing conversation. */
	instruction: string;
	/** Extra automatic rounds; empty means keep the goal's existing criteria. */
	criteria: string[];
	/** Additional continuation rounds to grant, not a total. */
	roundLimit: number;
	requestedAt: number;
}

/** One task the commander dispatched. Executed by its own agent session. */
export interface SentinelEngineTask {
	id: string;
	engineId: string;
	title: string;
	/** Self-contained instructions for the worker, written by the commander. */
	objective: string;
	target: string | null;
	/** Directory inside the project work dir this task owns. */
	workspace: string;
	status: SentinelEngineTaskStatus;
	/** Which dispatch attempt for its target this is; 1 is the first. */
	attempt: number;
	/** Acceptance criteria the commander attached; the worker's goal enforces them. */
	criteria: string[];
	roundLimit: number;
	/**
	 * A requested continuation that has not started yet. While it is set and the
	 * task is queued, the next worker reopens the task's own session file instead
	 * of starting a new conversation.
	 */
	pendingContinue: SentinelEngineTaskContinue | null;
	/**
	 * Which preset agent this task runs as, fixed at dispatch. `presetName` is
	 * copied in rather than resolved from the preset library, so the board still
	 * shows what a finished task ran as after the preset is deleted or renamed.
	 */
	presetId: string | null;
	presetName: string | null;
	/** pi session id of the worker, once it exists. */
	sessionId: string | null;
	startedAt: number | null;
	endedAt: number | null;
	summary: string | null;
	error: string | null;
	usage: SentinelGoalUsage | null;
	/** Findings submitted to the hub while this task ran. */
	vulns: number;
	/**
	 * The task was interrupted by a scheduled pause and should be continued on
	 * the next scheduled resume. A service restart clears this: safe restart
	 * policy leaves interruption recovery to the operator.
	 */
	autoResume: boolean;
}

/** An engineering run: a commander plus its targets, tasks, and report. */
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
	/** When the commander first started; null while the plan is still waiting. */
	startedAt: number | null;
	endedAt: number | null;
	/** One-shot schedule; null for engines created with "start now". */
	schedule: SentinelEngineSchedule | null;
	/** Final report markdown, once the commander declared the engine done. */
	report: string | null;
	tasks: SentinelEngineTask[];
}

/**
 * One step of the commander's decision log or a worker's process, in the same
 * shape as the sub-agent events so the console can render both alike.
 */
export type SentinelEngineEvent = SentinelSubagentEvent;

// ---------------------------------------------------------------------------
// Supervisor (观察 / 介入)
// ---------------------------------------------------------------------------

/** Two operator-visible modes. Both only observe; intervention never blocks. */
export type SentinelSupervisorMode = "observe" | "intervene";

/** How the supervisor weights its attention; never relaxes safety rules. */
export type SentinelSupervisorStrategy = "steady" | "validation" | "offensive" | "stealth" | "guarded";

/** One operator-defined strategy: a named overlay on top of a base preset. */
export interface SentinelSupervisorCustomStrategy {
	id: string;
	name: string;
	base: SentinelSupervisorStrategy;
	/** Short line shown in the picker. */
	description: string;
	/** Extra focus/advice guidance; cannot relax safety rules. */
	instructions: string;
	createdAt: number;
	updatedAt: number;
}

/** How a pending intervention is delivered when the mode is intervene. */
export type SentinelSupervisorDelivery = "auto" | "confirm";

export type SentinelSupervisorStatus = "waiting" | "running" | "stopped" | "error";

export type SentinelSupervisorProgress = "advancing" | "stalled" | "looping" | "unknown";

export type SentinelSupervisorTrigger = "batch" | "duplicate" | "no-progress" | "error-streak" | "manual" | "settled";

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

/** Global settings shown under 设置 → 模型. */
export interface SentinelSupervisorConfig {
	/** Master switch; the per-conversation arm remains the actual gate. */
	enabled: boolean;
	batchToolCalls: number;
	duplicateThreshold: number;
	noProgressCalls: number;
	errorStreak: number;
	timeoutMs: number;
	redactSecrets: boolean;
	/** Default for a new conversation; the operator can override it before arming. */
	defaultStrategy: SentinelSupervisorStrategy;
	/** Ordered default selection for a new conversation; can contain several strategies. */
	defaultStrategies?: SentinelSupervisorStrategyRef[];
	/** Global operator-defined strategies, available in every project. */
	customStrategies: SentinelSupervisorCustomStrategy[];
	/** When set, a new conversation defaults to this custom strategy. */
	defaultCustomStrategyId: string | null;
}

/** One endpoint/test pair the supervisor inferred from an episode. */
export interface SentinelSupervisorTested {
	target: string;
	test: string;
	result: string;
}

/** Compact observation of one tool call; full output stays in the session file. */
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
	/** A new endpoint, parameter, or tool-reported finding landed on this call. */
	newEvidence: boolean;
	signals: string[];
}

export interface SentinelSupervisorUsage {
	input: number;
	output: number;
	total: number;
}

/** What the supervisor asks the main agent to do; only intervene mode sends it. */
export interface SentinelSupervisorAdviceDraft {
	needed: boolean;
	reason: string;
	doNotRepeat: string[];
	nextActions: string[];
}

/** One structured episode produced from a batch of calls. */
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

/** One intervention record, whether auto-sent or awaiting operator confirmation. */
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

/** The rolling state, merged deterministically from episodes. */
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

/** Live view of one supervised conversation, carried in the snapshot and pushed live. */
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
	/** Latest supervisor log lines, so a reopened window is not blank. */
	logs: SentinelSupervisorLog[];
}

/** One global-audit row in 工作台 → 监督. */
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
	/** Sessions with at least one pending advice. */
	pendingAdvice: number;
}

export interface SentinelSupervisorAuditPage {
	items: SentinelSupervisorAuditItem[];
	total: number;
	page: number;
	pageSize: number;
	stats: SentinelSupervisorAuditStats;
}

/** One supervisor log line, kept for the floating window and the audit detail. */
export interface SentinelSupervisorLog {
	at: number;
	kind: string;
	text: string;
}

export interface SentinelSupervisorDetail {
	session: SentinelSupervisorAuditItem;
	episodes: SentinelSupervisorEpisode[];
	logs: SentinelSupervisorLog[];
	advice: SentinelSupervisorAdvice[];
}

/** Snapshot of the runtime state sent on connect and after state changes. */
export interface SentinelStateSnapshot {
	mode: SentinelMode;
	streaming: boolean;
	cwd: string;
	/** Active project; null means no project is selected and the chat is unavailable. */
	project: SentinelProjectInfo | null;
	model: { provider: string; id: string } | null;
	modelConfigured: boolean;
	/** Reasoning effort for the active session; "off" when the model has no reasoning. */
	thinkingLevel: ThinkingLevel;
	/** Levels the active model accepts, in ascending effort order. */
	availableThinkingLevels: ThinkingLevel[];
	activeSessionId: string | null;
	/** Serialized AgentMessage[] for the active session. */
	messages: unknown[];
	/** Bash commands awaiting an operator decision, oldest first. */
	pendingApprovals: SentinelApprovalRequest[];
	/** Command prefixes (first word) auto-approved this session, e.g. ["nmap"]. */
	allowedPrefixes: string[];
	/** Session ids with an active run (background included). */
	runningSessions: string[];
	/** Sub-agent runs of the active session, newest first, without their process steps. */
	subagents: SentinelSubagentRun[];
	/** Total runs of the active session; `subagents` is only the newest page. */
	subagentTotal: number;
	/** Persistent goal of the active session, with live counters; null when there is none. */
	goal: SentinelGoalView | null;
	/** Operator status of the active session, as a label the agent never sees. */
	sessionStatus: SentinelSessionStatus | null;
	/** The preset agent the active session was created with; null means the default agent. */
	preset: SentinelSessionPresetView | null;
	/**
	 * The business-modeling run in the active session, with live counters; null
	 * when this session is not modeling. The modeling tools are only mounted
	 * while this is set, so the console can state whether they are available.
	 */
	modeling: SentinelModelingState | null;
	/**
	 * Modeling records the operator attached to the active session from the
	 * composer (带建模数据); empty when none. While set, the read-only
	 * `api_model_read` is mounted so the model can read the full documents.
	 */
	modelingAttached: Array<{ id: string; title: string }>;
	/** Which mode applies and how the gatekeeper model is doing. */
	gatekeeper: SentinelGatekeeperView;
	/**
	 * Compaction (or branch summarization) is running for the active session. It
	 * blocks prompts, and a slow model can hold it for minutes, so the console has
	 * to show it and offer a way out.
	 */
	compacting: boolean;
	/** When the current compaction started, for the elapsed time; null when idle. */
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

/** A point the conversation can branch from. */
export interface SentinelForkPoint {
	entryId: string;
	text: string;
}

/** Client-to-server messages. */
export type SentinelClientMessage =
	| {
			type: "prompt";
			text: string;
			streamingBehavior?: "steer" | "followUp";
			images?: ImageContent[];
			notify?: boolean;
			/**
			 * Modeling records to attach to this fresh conversation (带建模数据).
			 * Honored only for a conversation that has no messages yet, and only on
			 * this one prompt; their catalog is injected before the text runs.
			 */
			attachModelIds?: string[];
	  }
	| { type: "abort" }
	| { type: "compact" }
	/** Cancel a compaction that is still running (a stalled model request). */
	| { type: "abort_compaction" }
	| {
			type: "start_goal";
			objective: string;
			/** One criterion per line; empty means the operator left them out. */
			criteria?: string[];
			roundLimit: number;
	  }
	| { type: "pause_goal" }
	| { type: "resume_goal"; extraRounds?: number }
	| { type: "clear_goal" }
	| { type: "set_thinking_level"; level: ThinkingLevel }
	/** Sets the active session's own mode; null makes it follow the global default. */
	| { type: "set_mode"; mode: SentinelMode | null }
	/** Sets the console-wide default every session without an override follows. */
	| { type: "set_global_mode"; mode: SentinelMode }
	| {
			type: "decide";
			decision: { id: string; approved: boolean; command?: string; alwaysAllowPrefix?: boolean };
	  }
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
	/** Create (`id` omitted) or update one library entry. `apiKey: null` keeps the stored key. */
	| {
			type: "save_model_entry";
			id?: string;
			name: string;
			baseUrl: string;
			apiKey: string | null;
			modelId: string;
			/**
			 * When present this is the complete capability declaration: fields the
			 * object omits are cleared. Omitted entirely means "keep what is stored".
			 */
			capabilities?: SentinelModelCapabilities;
	  }
	/** Look up same-id entries in pi's built-in catalog, for the editor's fill button. */
	| { type: "lookup_model_defaults"; modelId: string; baseUrl: string }
	/**
	 * Channels (providers) in pi's built-in catalog. `query` also matches model
	 * names, so searching "claude" finds Anthropic. `requestId` keeps several
	 * keystrokes from racing.
	 */
	| { type: "list_model_channels"; requestId: number; query: string }
	/** Every catalog model of one channel, fetched after the channel is picked. */
	| { type: "list_channel_models"; requestId: number; provider: string }
	| { type: "remove_model_entry"; id: string }
	| { type: "duplicate_model_entry"; id: string }
	/** Point a role at an entry id, at "follow-main", or (main only) at null. */
	| { type: "set_model_role"; role: SentinelModelRoleName; target: string | null }
	| { type: "set_reviewer_auto"; enabled: boolean }
	/** Probe one library entry with a plain chat request. */
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
	/** Start an async tar.gz of one folder; progress and completion arrive as messages. */
	| { type: "download_folder"; path: string }
	| { type: "cancel_folder_archive"; id: string }
	/** Open (or attach to) the operator's shell in a project container. */
	| { type: "terminal_open"; projectId: string; cols: number; rows: number }
	| { type: "terminal_input"; projectId: string; data: string }
	/** Ends the shell; the panel's 「结束终端」. */
	| { type: "terminal_close"; projectId: string }
	| { type: "list_subagents"; offset?: number; limit?: number }
	| { type: "get_subagent"; id: string }
	| { type: "abort_subagent"; id: string }
	| { type: "steer_subagent"; id: string; text: string }
	| { type: "list_vulns"; filters?: SentinelVulnFilters }
	| { type: "get_vuln"; id: string }
	| { type: "update_vuln"; id: string; patch: SentinelVulnUpdate }
	/** How much deleting these records would take with them, for the dialog. */
	| { type: "preview_vuln_delete"; ids: string[] }
	| { type: "delete_vulns"; ids: string[] }
	| { type: "export_vulns"; filters?: SentinelVulnFilters }
	/** `force` is the hub's manual re-review: it overwrites an already-settled verdict. */
	| { type: "retry_vuln_review"; id: string; force?: boolean }
	| { type: "review_pending_vulns" }
	| { type: "list_assets"; filters?: SentinelAssetFilters; page?: number; pageSize?: number }
	| { type: "get_asset"; id: string }
	| { type: "update_asset"; id: string; patch: SentinelAssetUpdate }
	/** How much deleting these assets would take with them, for the dialog. */
	| { type: "preview_asset_delete"; ids: string[] }
	| { type: "delete_assets"; ids: string[] }
	| { type: "export_assets"; filters?: SentinelAssetFilters }
	| { type: "list_pocs"; filters?: SentinelPocFilters; page?: number; pageSize?: number }
	| { type: "get_poc"; id: string }
	| { type: "delete_poc"; id: string }
	| { type: "list_poc_sources" }
	/** Create or update a source; an empty `headerValue` keeps the stored one. */
	| { type: "save_poc_source"; source: SentinelPocSourceSave }
	| { type: "delete_poc_source"; id: string }
	| { type: "sync_poc_source"; id: string }
	/** One-click official sync: create the built-in official source if missing, then sync it. */
	| { type: "sync_official_pocs" }
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
	/**
	 * Fetch a URL through one profile's exit, in a throwaway container. The result
	 * is stored on the profile and arrives with the next `proxy_config`.
	 */
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
	/** Save one platform's switch and key; the key is write-only. */
	| { type: "save_asset_platform"; platform: SentinelAssetPlatformInput }
	| { type: "set_asset_query_limit"; limit: number }
	/**
	 * Probe one platform without saving anything. `key` and `baseUrl` override
	 * the stored values so they can be verified before they are written.
	 */
	| { type: "test_asset_platform"; platform: SentinelAssetPlatform; key?: string; baseUrl?: string }
	| { type: "get_websearch_config" }
	/** Add or update one pool key; the key material is write-only. */
	| { type: "save_websearch_key"; key: SentinelWebSearchKeyInput }
	| { type: "delete_websearch_key"; id: string }
	| { type: "set_websearch_query_limit"; limit: number }
	/** Probe one pool key without saving; `key` overrides the stored secret. */
	| { type: "test_websearch_key"; id?: string; key?: string }
	| { type: "get_mcp_servers" }
	/** Add or replace one custom MCP server. The name is the identity; renaming is delete + add. */
	| { type: "save_mcp_server"; server: SentinelMcpServerInput }
	| { type: "delete_mcp_server"; name: string }
	/**
	 * Flip one server's switch from the permissions page, which lists the same servers.
	 * It sends the one field rather than a whole entry, so a page holding a stale copy of
	 * a URL or a token cannot write that copy back over the stored one.
	 */
	| { type: "set_mcp_server_enabled"; name: string; enabled: boolean }
	/**
	 * Probe one server without saving anything, so a draft can be checked before it
	 * is written. `draft` overrides the stored entry; without it the stored one is probed.
	 */
	| { type: "test_mcp_server"; name: string; draft?: SentinelMcpServerInput }
	| { type: "get_plugins" }
	/** Add or update one host. An empty token keeps the stored one. */
	| { type: "save_plugin_host"; host: SentinelPluginHostInput }
	| { type: "delete_plugin_host"; id: string }
	| { type: "test_plugin_host"; id: string }
	/** Read an uploaded plugin package (zip, or a bare plugin.json); nothing is installed yet. */
	| { type: "inspect_plugin_package"; name: string; data: string }
	| {
			type: "install_plugin";
			hostId: string;
			manifest: SentinelPluginManifest;
			/** The uploaded zip, base64. The host extracts and builds it. */
			package: string;
			/** Explicit consent to run the Dockerfile on the plugin host. */
			allowBuild: boolean;
			allowHostNetwork: boolean;
			allowPrivileged: boolean;
			config: Record<string, string>;
	  }
	| { type: "uninstall_plugin"; hostId: string; pluginId: string; purge: boolean }
	| { type: "start_plugin"; hostId: string; pluginId: string }
	| { type: "stop_plugin"; hostId: string; pluginId: string }
	| { type: "set_plugin_enabled"; hostId: string; pluginId: string; enabled: boolean }
	/** Pin or unpin a plugin's UI on the console sidebar (local preference). */
	| { type: "set_plugin_sidebar"; hostId: string; pluginId: string; pinned: boolean }
	| { type: "list_official_plugins" }
	| { type: "get_plugin_build_log"; hostId: string; pluginId: string }
	/** Install a package bundled with the console; the server supplies manifest and bytes. */
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
	/** Pull one artifact into the active project's evidence directory. */
	| { type: "fetch_plugin_artifact"; hostId: string; pluginId: string; path: string }
	/** The plugin's own frontend was opened; recorded in the audit log. */
	| { type: "plugin_ui_open"; hostId: string; pluginId: string }
	/** One bridge call from the plugin frontend; the server validates the method. */
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
	/** Change an engine's command gate; refused while a task is in flight. */
	| { type: "engine_set_gate_mode"; id: string; gateMode: SentinelEngineGateMode }
	/**
	 * Replace this engine's preset whitelist. An empty list means "no restriction":
	 * the commander may use any enabled preset, which is what every engine created
	 * before presets existed does.
	 */
	| { type: "engine_set_presets"; id: string; presetIds: string[] }
	/**
	 * Whether the commander may leave a task without a preset, running it as the
	 * default agent. False means every dispatch must name one of the allowed
	 * presets, and a dispatch that names none is refused with the list of choices.
	 */
	| { type: "engine_set_preset_optional"; id: string; optional: boolean }
	| { type: "engine_pause"; id: string }
	| { type: "engine_resume"; id: string }
	| { type: "engine_abort"; id: string }
	/** Replace the plan of an engine that has not started yet. */
	| { type: "engine_set_schedule"; id: string; schedule: SentinelEngineScheduleInput }
	/** Stop the plan without stopping a run that is already in progress. */
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
	 * Create or update a preset agent. `id` is present only when updating: the id
	 * is generated from the name, so the client never invents one.
	 */
	| {
			type: "save_preset";
			input: {
				id?: string;
				name: string;
				description?: string;
				tags?: string[];
				/** The composer hint while this preset is active; omitted or empty keeps the default. */
				placeholder?: string;
				text: string;
				enabled?: boolean;
			};
	  }
	| { type: "delete_preset"; id: string }
	| { type: "set_preset_enabled"; id: string; enabled: boolean }
	/** Export the selected presets, or all of them when `ids` is omitted. */
	| { type: "export_presets"; ids?: string[] }
	/** Import an export file's text; existing presets are never overwritten. */
	| { type: "import_presets"; content: string }
	| { type: "get_gatekeeper_config" }
	| { type: "set_ui_language"; language: UiLanguage }
	| { type: "save_gatekeeper_config"; config: SentinelGatekeeperConfig }
	/** Probes whatever the 守门模型 role resolves to with one fixed sample command. */
	| { type: "test_judge" }
	| { type: "gate_audit_query"; filter?: SentinelGateFilter; page?: number; pageSize?: number }
	| { type: "gate_audit_stats"; filter?: SentinelGateFilter }
	/** Arm supervision before the conversation's first message. */
	| {
			type: "supervisor_arm";
			mode: SentinelSupervisorMode;
			delivery: SentinelSupervisorDelivery;
			strategy: SentinelSupervisorStrategy;
			/** Multiple selections; takes precedence over the legacy singular fields. */
			strategies?: SentinelSupervisorStrategyRef[];
			/** Set when the operator picked a saved custom strategy. */
			customStrategyId?: string | null;
			/** Optional operator note, capped at 200 characters. */
			note?: string;
	  }
	| { type: "supervisor_stop" }
	/** Change the per-conversation mode/delivery; applies to the next episode. */
	| {
			type: "supervisor_set_mode";
			mode: SentinelSupervisorMode;
			delivery: SentinelSupervisorDelivery;
	  }
	/** Change the per-conversation strategy; applies to the next episode. */
	| {
			type: "supervisor_set_strategy";
			strategy: SentinelSupervisorStrategy;
			customStrategyId?: string | null;
			strategies?: SentinelSupervisorStrategyRef[];
			note?: string;
	  }
	| { type: "supervisor_run_now" }
	/** Full output of one call, read from the session file by callId. */
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
	/**
	 * Start business modeling in the viewed session. No payload: the objective
	 * comes from the conversation the operator is already in. Refused while the
	 * session runs or while a modeling run is already active.
	 */
	| { type: "start_modeling" }
	/** End the run in the viewed session (the operator's own way out). */
	| { type: "end_modeling" }
	/** Remove the modeling records attached to the viewed session (带建模数据). */
	| { type: "detach_modeling" }
	/** The Android device page: pull the full gateway state. */
	| { type: "droid_state" }
	| { type: "droid_token_create"; label: string }
	| { type: "droid_token_delete"; id: string }
	| { type: "droid_device_rename"; id: string; name: string }
	| { type: "droid_device_remove"; id: string }
	| { type: "droid_set_enabled"; enabled: boolean }
	| { type: "droid_set_listen"; host: string; port: number }
	/** The iOS device page: same listener controls, same token list. */
	| { type: "ios_set_listen"; host: string; port: number }
	| { type: "ios_state" }
	| { type: "ios_token_create"; label: string }
	| { type: "ios_token_delete"; id: string }
	| { type: "ios_device_rename"; id: string; name: string }
	| { type: "ios_device_remove"; id: string }
	| { type: "ios_set_enabled"; enabled: boolean }
	/** Close a record from the page, for a run whose session is no longer loaded. */
	| { type: "end_api_model"; id: string }
	| { type: "list_api_models"; filters?: SentinelApiModelFilters }
	| { type: "get_api_model"; id: string }
	| { type: "delete_api_model"; id: string }
	/** Render one run as a downloadable file; the browser turns it into a download. */
	| { type: "export_api_model"; id: string; format: "json" | "yaml" }
	/** Open-source watch: every monitor of every project; the page filters. */
	| { type: "list_code_monitors" }
	/** Probe a repository's branches before a monitor exists, for the multi-select. */
	| {
			type: "code_monitor_branches";
			requestId: number;
			url: string;
			/** An existing monitor lets the server reuse its stored token. */
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
			projectId: string;
			filter: SentinelCodeActivityFilter;
			page: number;
			pageSize: number;
	  }
	| { type: "check_code_monitor"; id: string; trigger?: SentinelCodeCheckTrigger }
	| { type: "get_code_monitor"; id: string }
	/** Start a reproduction engine for one confirmed finding. */
	| { type: "dispatch_code_commit"; id: string }
	| { type: "ignore_code_commit"; id: string }
	| { type: "rejudge_code_commit"; id: string }
	/** Batch-apply one schedule to several monitors. */
	| {
			type: "set_code_monitors_schedule";
			ids: string[];
			scheduleKind: SentinelCodeScheduleKind;
			intervalMinutes?: number;
			cronExpression?: string | null;
	  };

/** Server-to-client messages. */
export type SentinelServerMessage =
	| { type: "snapshot"; snapshot: SentinelStateSnapshot }
	| { type: "session_event"; event: AgentSessionEvent }
	| { type: "sessions"; sessions: SentinelSessionListEntry[] }
	| { type: "tree"; tree: SessionTreeNode[]; leafId: string | null; forkPoints: SentinelForkPoint[] }
	/** The whole model screen: library, role assignments, resolved endpoints. */
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
	| { type: "stats"; stats: SentinelStats }
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
	/**
	 * The answer to `terminal_open`, and the broadcast when a shell ends. `opened`
	 * carries the scrollback the panel missed while it was closed.
	 */
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
	| { type: "vulns_export"; filename: string; markdown: string }
	| { type: "vuln_review_result"; id: string; ok: boolean; error?: string }
	| {
			type: "assets";
			items: SentinelAssetSummary[];
			stats: SentinelAssetStats;
			/** Matches for the current filter, not the page size. */
			total: number;
			page: number;
			pageSize: number;
			hasMore: boolean;
	  }
	/** A write changed the library; clients re-query with their own page. */
	| { type: "assets_changed" }
	| { type: "asset"; detail: SentinelAssetDetail }
	| { type: "asset_result"; action: string; id?: string; ok: boolean; error?: string }
	| { type: "asset_delete_preview"; count: number; records: number; vulns: number }
	| { type: "assets_deleted"; count: number }
	| { type: "assets_export"; filename: string; markdown: string }
	| {
			type: "pocs";
			items: SentinelPocSummary[];
			stats: SentinelPocStats;
			total: number;
			page: number;
			pageSize: number;
	  }
	| { type: "poc"; poc: SentinelPoc }
	| { type: "poc_result"; action: string; id?: string; ok: boolean; error?: string }
	| { type: "poc_sources"; sources: SentinelPocSource[] }
	| { type: "poc_source_result"; action: string; id?: string; ok: boolean; error?: string }
	| { type: "code_monitors"; monitors: SentinelCodeMonitor[] }
	| { type: "code_monitor_import"; state: SentinelCodeImportState | null }
	| { type: "code_activity"; view: SentinelCodeActivityView }
	| { type: "code_monitor_detail"; detail: SentinelCodeMonitorDetail }
	/** Answer to `code_monitor_branches`; `error` is set when the probe failed. */
	| { type: "code_monitor_branches"; requestId: number; branches?: string[]; error?: string }
	| {
			type: "code_monitor_result";
			action: string;
			id?: string;
			ok: boolean;
			error?: string;
			/** Extra outcome line, e.g. how many commits a check consumed. */
			detail?: string;
	  }
	| { type: "environment"; report: SentinelEnvReport; building: boolean }
	| { type: "image_build_log"; line: string }
	| { type: "image_build_result"; ok: boolean; error?: string }
	| { type: "sources_saved"; sources: SentinelSources; error?: string }
	| { type: "container_network_saved"; network: SentinelContainerNetwork; error?: string }
	/**
	 * The whole proxy configuration. `error` is the reason the request that
	 * produced it was refused; `push` marks a change the console did not ask for
	 * (a scheduled subscription refresh), which must not release a pending form.
	 */
	| { type: "proxy_config"; config: SentinelProxyConfigView; error?: string; push?: boolean }
	| { type: "singbox_pull_started" }
	| { type: "singbox_pull_result"; ok: boolean; error?: string }
	/**
	 * A project's proxy choice was stored. `applied` says whether a running
	 * sidecar took it now, as opposed to it waiting for the next rebuild.
	 */
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
	/** Capability token for the iframe URL, issued after an authenticated open. */
	| { type: "plugin_ui_opened"; token: string }
	| { type: "plugin_ui_result"; requestId: string; ok: boolean; result?: unknown; error?: string }
	| { type: "engines"; engines: SentinelEngine[] }
	| { type: "engine_update"; engine: SentinelEngine }
	| { type: "engine_commander_event"; engineId: string; event: SentinelEngineEvent }
	| { type: "engine_task_event"; taskId: string; event: SentinelEngineEvent }
	| { type: "engine_task_events"; taskId: string; events: SentinelEngineEvent[] }
	| { type: "engine_commander_events"; id: string; events: SentinelEngineEvent[] }
	| { type: "engine_report"; id: string; markdown: string; filename: string }
	| { type: "doctrines"; doctrines: SentinelDoctrineView[] }
	| { type: "doctrine_saved"; doctrine: SentinelDoctrineView; error?: string }
	| { type: "doctrine_deleted"; id: string; ok: boolean; error?: string }
	| { type: "presets"; presets: SentinelPresetView[] }
	| { type: "preset_saved"; preset: SentinelPresetView | null; error?: string }
	| { type: "preset_deleted"; id: string; ok: boolean; error?: string }
	/** The export file's text; the browser turns it into a download. */
	| { type: "presets_export"; filename: string; content: string }
	| {
			type: "presets_imported";
			imported: SentinelPresetView[];
			skipped: Array<{ name: string; reason: string }>;
			error?: string;
	  }
	| { type: "gatekeeper_config"; config: SentinelGatekeeperConfig }
	| { type: "ui_config"; language: UiLanguage }
	/** One sample judgment, so the operator can see the prompt and endpoint work. */
	| {
			type: "judge_test_result";
			result: SentinelTestResult;
			/** The raw one-line answer, when a judgment actually came back. */
			raw?: string;
	  }
	| { type: "gate_audit"; page: SentinelGatePage }
	| {
			type: "gate_audit_stats";
			stats: SentinelGateStats;
			/**
			 * Rows per approval bucket, with every filter but `approval` applied.
			 * The tab strip is navigation, not a result: its counts must not
			 * collapse to zero for the tab that is not selected, which is what
			 * happens when the tab's own approval filter is left in.
			 */
			tabCounts: Record<SentinelGateApproval, number>;
	  }
	/** One judgment, streamed live so an open audit page prepends it. */
	| { type: "gate_decision"; decision: SentinelGateDecision }
	| { type: "api_models"; items: SentinelApiModelSummary[] }
	| { type: "api_model"; model: SentinelApiModel; events: SentinelApiModelEvent[] }
	| { type: "api_model_result"; action: string; id?: string; ok: boolean; error?: string }
	| { type: "api_model_export"; filename: string; format: "json" | "yaml"; text: string }
	| {
			type: "droid_state";
			/** The viewed conversation's switch; device and token lists are global. */
			enabled: boolean;
			devices: DroidDevice[];
			tokens: DroidToken[];
			/** The dedicated reverse listener, when it is bound. */
			listen: { host: string; port: number } | null;
			/** What the operator picked (may differ from `listen` when it failed to bind). */
			listenConfig: { host: string; port: number } | null;
			/** Non-internal IPv4 addresses of the server, for the listen picker. */
			lanIps: string[];
	  }
	| {
			type: "ios_state";
			/** The viewed conversation's switch; device and token lists are global. */
			enabled: boolean;
			devices: IosDevice[];
			tokens: IosToken[];
			listen: { host: string; port: number } | null;
			listenConfig: { host: string; port: number } | null;
			lanIps: string[];
			/** SHA-256 of the console's leaf certificate, for wss pinning. */
			certPin: string | null;
	  }
	| { type: "supervisor_state"; supervisor: SentinelSupervisorView | null }
	| {
			type: "supervisor_episode";
			episode: SentinelSupervisorEpisode;
			calls: SentinelSupervisorCall[];
	  }
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
 * One environment prerequisite. `blocking` items decide whether the console runs
 * at all: Docker is not optional here, because every tool call is a `docker exec`
 * into a project container.
 */
export interface SentinelEnvItem {
	id: string;
	/** Section the item is listed under, e.g. Docker 运行时. */
	group: string;
	label: string;
	status: "ok" | "warn" | "fail" | "skipped";
	detail: string;
	/** What to do about a warn or fail. */
	hint?: string;
	blocking: boolean;
}

/**
 * Base image and package mirrors for the toolbox image build. Empty means the
 * official source; the values are baked into the image at build time.
 */
export interface SentinelSources {
	baseImage: string;
	aptMirror: string;
	pipIndex: string;
	npmRegistry: string;
	goProxy: string;
}

/**
 * Asset-mapping platforms the console can query. All three are read-only
 * internet-wide search engines: the console calls them directly with the
 * operator's key, and the key never enters the project container.
 */
export type SentinelAssetPlatform = "fofa" | "quake" | "hunter";

/**
 * The outcome of the most recent call to one platform, kept for the settings
 * screen so a failure stays visible after the session that hit it is gone.
 */
export interface SentinelAssetStatus {
	/** Epoch milliseconds of the attempt, or null when the platform was never called. */
	at: number | null;
	ok: boolean;
	/** Failure text as the platform or the transport reported it. */
	error?: string;
	/** Quota line as the platform reported it, e.g. "剩余 39366 点". */
	quota?: string;
}

/** One platform as the settings screen shows it; the key itself never leaves the host. */
export interface SentinelAssetPlatformView {
	id: SentinelAssetPlatform;
	label: string;
	/** Operator switch. Off means the platform's tool is not mounted at all. */
	enabled: boolean;
	/** A key is stored. Only this fact is sent to the browser, never the key. */
	hasKey: boolean;
	/** Custom origin or reverse-proxy prefix; empty means the official platform URL. */
	baseUrl: string;
	/**
	 * The key was probed and the platform answered. A platform is only handed to
	 * the agent when this is true, so an unusable key never becomes a tool that
	 * fails on every call.
	 */
	verified: boolean;
	status: SentinelAssetStatus;
}

/** The whole asset-mapping configuration as the console sees it. */
export interface SentinelAssetConfigView {
	platforms: SentinelAssetPlatformView[];
	/**
	 * Queries one session may send across all platforms; 0 means unlimited. The
	 * budget exists because all three platforms meter queries, and an agent
	 * working a large scope can burn a day's quota in minutes.
	 */
	sessionQueryLimit: number;
	/** How many platforms are usable right now (enabled, keyed, and verified). */
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

/**
 * Web-search (Tavily) key-pool configuration. Unlike the asset platforms, the
 * pool holds many keys of one provider and rotates them by remaining credits,
 * so the view is a list rather than a fixed platform row.
 */
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
 * How a custom MCP server is reached. `stdio` spawns a command on the console
 * host, outside the project container. `http` talks to a remote streamable-HTTP
 * endpoint, and `sse` to the older HTTP+SSE one, where the server names the
 * message endpoint on a long-lived stream.
 */
export type SentinelMcpTransport = "stdio" | "http" | "sse";

/** Exposure of a server's tools, as the MCP extension accepts it. */
export type SentinelMcpExposure = "codemode" | "deferred" | "direct" | "hidden";

/** The outcome of the last connection attempt, kept for the settings screen. */
export interface SentinelMcpStatus {
	/** Epoch milliseconds of the attempt, or null when it was never connected. */
	at: number | null;
	ok: boolean;
	/** Failure text as the connection or the transport reported it. */
	error?: string;
	/** Tools the server offered at the last successful connect. */
	tools?: number;
	/** Resources it listed at the last successful connect. */
	resources?: number;
}

/** One custom server as the settings screen shows it, editor fields included. */
export interface SentinelMcpServerView {
	name: string;
	enabled: boolean;
	transport: SentinelMcpTransport;
	/** Command line for stdio, URL for http: the one-line summary of the row. */
	target: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	url: string;
	headers: Record<string, string>;
	description: string;
	exposure: SentinelMcpExposure;
	/** Per-request timeout in seconds; null means the extension's own default (60). */
	timeout: number | null;
	/**
	 * stdio only: the operator accepted that the command runs on the console host.
	 * A server without it is stored but never mounted.
	 */
	hostExecAcknowledged: boolean;
	status: SentinelMcpStatus;
}

/** The whole custom-MCP configuration as the console sees it. */
export interface SentinelMcpConfigView {
	servers: SentinelMcpServerView[];
	/** Servers a session mounts right now (enabled, acknowledged, and within the tool budget). */
	mounted: number;
	/** The 权限 → MCP switch. Off means no server is mounted at all. */
	permissionOn: boolean;
	/** Config file the entries are stored in, shown on the page. */
	path: string;
}

/** Saving one custom server. */
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

/** One bundled official plugin, as listed before installation. */
export interface SentinelOfficialPluginView {
	manifest: SentinelPluginManifest;
	/** Zip size, for the "why is this slow" hint. */
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

/** One connection probe, with what the server offered when it answered. */
export interface SentinelMcpTestResult extends SentinelTestResult {
	state: "connected" | "needs-auth" | "failed";
	/** Tool names the server offered, when it connected. */
	tools: string[];
	resources: number;
	/** Server instructions from `initialize`, when it sent any. */
	instructions?: string;
}

export interface SentinelEnvReport {
	/** ISO timestamp of the check that produced this report. */
	at: string;
	/** Every blocking item is ok. */
	ok: boolean;
	items: SentinelEnvItem[];
	/** Console address, shown in the environment page. */
	url: string;
	/** Build sources as configured (empty fields mean the official source). */
	sources: SentinelSources;
	/** Network mode new and rebuilt project containers are created with. */
	containerNetwork: SentinelContainerNetwork;
	/** Proxy profiles as configured, for the environment page's summary. */
	proxies: SentinelProxyConfigView;
}

/**
 * How a project container joins the network. `host` shares the host's namespace,
 * so listeners inside the container are reachable from the target and `127.0.0.1`
 * means the host; `bridge` keeps Docker's own address and publishes nothing.
 *
 * A project with a proxy gets neither: its container shares the network namespace
 * of that project's sing-box sidecar, so every packet takes the tunnel.
 */
export type SentinelContainerNetwork = "host" | "bridge";

/**
 * How the proxy is described. `off` runs no sidecar at all; `simple` covers a
 * SOCKS5 or HTTP endpoint (a local Clash, a VPS); `subscription` takes a URL
 * whose nodes are fetched, parsed and cached; `wireguard` and `openvpn` are
 * tunnels rather than proxies, and their sidecars run `wg-quick` and the OpenVPN
 * client instead of sing-box.
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
 * One WireGuard tunnel.
 *
 * The configuration is pasted whole — that is what a provider hands out, and it
 * carries keys, address, MTU, keepalive and the peer in the spelling `wg-quick`
 * already understands. The console adds only the two decisions that are not in
 * the file: the resolver the container should use (Docker's own resolver runs
 * outside the tunnel, so leaving it unset would leak every lookup) and whether to
 * drop the direct default route once the tunnel is up.
 */
export interface SentinelWireGuard {
	/** `wg0.conf` as pasted. */
	config: string;
	/** Resolver for the container; empty uses the file's own `DNS =` line. */
	dns: string;
	/** Remove the direct default route after the tunnel is up. */
	killSwitch: boolean;
}

/**
 * One OpenVPN tunnel.
 *
 * The configuration is pasted whole — a provider hands out a single `.ovpn` with
 * the certificates inlined, and that file already carries the cipher, the remote
 * and the routes. The console adds what a file cannot say: the credentials for
 * `auth-user-pass` (kept out of the pasted text and mounted as their own file),
 * the resolver the container should use when the pasted file names none, and
 * whether to drop the direct default route once the tunnel is up.
 */
export interface SentinelOpenVpn {
	/** The `.ovpn` as pasted, inline certificates and all. */
	config: string;
	/** Resolver for the container; empty falls back to the `dhcp-option DNS` the server pushes. */
	dns: string;
	/** Username for `auth-user-pass`; empty means the configuration needs none. */
	username: string;
	password: string;
	/** Remove the direct default route after the tunnel is up. */
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
	/** URL the generated `urltest` group uses to rank nodes. */
	testUrl: string;
	/**
	 * Send private destinations (RFC1918, loopback, link-local) out the direct
	 * path. On by default: a LAN target is not reachable through a remote exit.
	 */
	routePrivateDirect: boolean;
}

/**
 * The last connectivity test of one profile: whether traffic actually reached the
 * test URL through that exit.
 *
 * Stored rather than kept in the page: the question "is this proxy still working"
 * is asked once and then read many times, and a result that disappears on reload
 * would have to be paid for with another container every time.
 */
export interface SentinelProxyTest {
	ok: boolean;
	/** Round trip in milliseconds; null when the request did not come back. */
	latencyMs: number | null;
	/** When the test ran. */
	testedAt: number;
	/** The URL traffic was sent to; kept so an old result is never read as a new one. */
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
	/** Why the nodes of the last parse were skipped, for the picker. */
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

/** A doctrine as the wire shows it (same shape as the stored one). */
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
	/**
	 * The composer's idle hint while this preset is in force, e.g. "说说这次要
	 * 看的目标". Empty means the console's default text. It is metadata for the
	 * operator, not context: it never reaches the model.
	 */
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

/** Operator input when creating an engineering run. */
export interface SentinelEngineCreateInput {
	name: string;
	/** One target per line, `target [note]`; blank lines dropped. */
	targets: string;
	doctrines: string[];
	/** Preset agents the commander may use; empty or omitted means no restriction. */
	presetIds?: string[];
	/** Whether a task may run without a preset; omitted means it may. */
	presetOptional?: boolean;
	limits: SentinelEngineLimits;
	/** Defaults to `auto` when omitted, which is what engines predating it used. */
	gateMode?: SentinelEngineGateMode;
	/** When set, the engine is saved as scheduled instead of starting immediately. */
	schedule?: SentinelEngineScheduleInput;
}
