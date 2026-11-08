/**
 * Full Chain Sentinel runtime: owns the live agent sessions, the approval gate, the
 * operator mode, and model-endpoint configuration.
 *
 * Multiple sessions run in parallel: switching the view to another session
 * never stops the previous one — it keeps executing in the background and its
 * transcript is up to date when you switch back. Every bash tool (main or
 * sub-agent, foreground or background session) passes the same approval gate.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolveFsPath } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	type BashOperations,
	createAgentSession,
	createBashTool,
	createCodemodeExtension,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLoopGuardExtension,
	createLsTool,
	createMcpExtension,
	createReadTool,
	createToolSearchExtension,
	createWriteTool,
	DefaultResourceLoader,
	type ExtensionFactory,
	getAgentDir,
	getDefaultSessionDir,
	getSessionDirPath,
	type ImageContent,
	ModelRuntime,
	mcpNamespace,
	probeMcpServer,
	SessionManager,
	type SessionStats,
	type SessionTreeNode,
	SettingsManager,
	type ThinkingLevel,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	createApiModelAttachTools,
	createApiModelTools,
	type ModelingAttachPort,
	type ModelingPort,
	type ModelingSubmitOutcome,
} from "./apimodel-tool.ts";
import {
	ApiModelStore,
	type ApiModelSubmitInput,
	apiModelsDbPath,
	buildApiModelExport,
	endpointsOf,
} from "./apimodels.ts";
import { ApprovalGate } from "./approval.ts";
import {
	ASSET_PLATFORM_LABELS,
	assetConfigView,
	readAssetConfig,
	recordAssetStatus,
	usablePlatforms,
	saveAssetPlatform as writeAssetPlatform,
	setAssetQueryLimit as writeAssetQueryLimit,
} from "./asset-config.ts";
import { AssetLibraryStore, assetLibraryDbPath, emptyAssetStats, MAX_ASSET_PAGE_SIZE } from "./asset-library.ts";
import { createAssetLibraryTools } from "./asset-library-tool.ts";
import { buildAssetReport } from "./asset-markdown.ts";
import { probeAssetPlatform, searchAssets } from "./asset-platforms.ts";
import { AssetStore, assetsDbPath } from "./asset-store.ts";
import { type AssetQueryReport, type AssetToolContext, createAssetTools, writeAssetEvidence } from "./asset-tool.ts";
import { createCaptureTools, DROID_CAPTURE_TOOL_NAMES, HTTP_EVIDENCE_TOOL_NAMES } from "./capture-tool.ts";
import { CaptureStore, capturesDbPath } from "./captures.ts";
import { readContainerNetwork } from "./container-network.ts";
import { containerWorkPath, dockerBashOperations } from "./docker.ts";
import { DroidStore, droidDbPath } from "./droid.ts";
import type { DroidGateway } from "./droid-gateway.ts";
import { createApkTools, createDroidTools, DROID_TOOL_NAMES, type DroidToolContext } from "./droid-tool.ts";
import {
	deletePath,
	downloadFile,
	listFiles,
	makeDirectory,
	readFilePreview,
	renamePath,
	requireDirectory,
	toContainerWorkPath,
	writeFile,
} from "./files.ts";
import { createFridaTools, FRIDA_TOOL_NAMES } from "./frida-tool.ts";
import { buildJudgeInput, GATEKEEPER_SAMPLE_COMMAND, Gatekeeper, type ResolvedJudgeEndpoint } from "./gatekeeper.ts";
import { readGatekeeperConfig, writeGatekeeperConfig } from "./gatekeeper-config.ts";
import { GatekeeperStore, gatekeeperDbPath } from "./gatekeeper-store.ts";
import {
	advanceGoal,
	blockGoal,
	buildGoalContract,
	completeGoal,
	createGoal,
	DEFAULT_ROUND_LIMIT,
	diffUsage,
	emptyUsage,
	extractRoundSummary,
	finishRound,
	GOAL_MESSAGE_CUSTOM_TYPE,
	GOAL_STATE_CUSTOM_TYPE,
	goalStatusLabel,
	parseCriteria,
	pauseGoal,
	readGoalState,
	recordBlocker,
	recordRoundProgress,
	recordSubmission,
	refundRound,
	resumeGoal,
	startRound,
} from "./goal.ts";
import { createGoalTools, type GoalPort } from "./goal-tool.ts";
import { t } from "./i18n.ts";
import { IosStore, iosDbPath } from "./ios.ts";
import { createIosCaptureTools, IOS_CAPTURE_TOOL_NAMES } from "./ios-capture-tool.ts";
import { createIosDecryptTools, IOS_DECRYPT_TOOL_NAMES } from "./ios-decrypt-tool.ts";
import { createIosFridaTools, IOS_FRIDA_TOOL_NAMES } from "./ios-frida-tool.ts";
import type { IosGateway } from "./ios-gateway.ts";
import { createIosTools, IOS_TOOL_NAMES, type IosToolContext } from "./ios-tool.ts";
import {
	loadSentinelMcpConfig,
	mcpConfigView,
	mcpEntryFor,
	normalizeMcpServer,
	readMcpServers,
	recordMcpStatus,
	deleteMcpServer as removeMcpServer,
	type SentinelMcpServerRecord,
	updateMcpServerRecord,
	validateMcpServerInput,
	saveMcpServer as writeMcpServer,
} from "./mcp-config.ts";
import { MitmCenter } from "./mitm.ts";
import { createMitmTools } from "./mitm-tool.ts";
import { modelsJsonPath } from "./model-config.ts";
import { listBuiltinChannelModels, listBuiltinChannels, matchBuiltinModelDefaults } from "./model-defaults.ts";
import {
	addLibraryEntry,
	duplicateLibraryEntry,
	libraryView,
	readModelLibrary,
	readStoredModelLibrary,
	removeLibraryEntry,
	resolveLibraryRole,
	setLibraryRole,
	setReviewerAuto,
	toResolvedModelView,
	updateLibraryEntry,
	writeModelLibrary,
} from "./model-library.ts";
import {
	buildModelingAttachMessage,
	buildModelingBrief,
	buildModelingCatalog,
	buildModelingEndMessage,
	MODELING_ATTACH_CUSTOM_TYPE,
	MODELING_ATTACH_MESSAGE_CUSTOM_TYPE,
	MODELING_MESSAGE_CUSTOM_TYPE,
	MODELING_STATE_CUSTOM_TYPE,
	type ModelingAttach,
	type ModelingRun,
	modelingState,
	modelingToolLoadout,
	readModelingAttach,
	readModelingRun,
} from "./modeling.ts";
import {
	buildGoalNotification,
	buildRunNotification,
	buildVulnNotification,
	hasEnabledNotifyChannel,
	sendNotifications,
	shouldNotifyRun,
	testDingTalk,
	testFeishu,
	testWecom,
} from "./notify.ts";
import { readNotifyConfig, writeNotifyConfig } from "./notify-config.ts";
import {
	effectiveSubagent,
	effectiveSubagentPlugins,
	excludeToolsFor,
	PERMISSION_PRESETS,
	pluginAllowed,
	readPermissionsConfig,
	type SentinelPermissionPreset,
	type SentinelPermissionSet,
	type SentinelPermissionsConfig,
	type SentinelPluginPermissionMap,
	writePermissionsConfig,
} from "./permissions.ts";
import { appendPluginAudit } from "./plugin-audit.ts";
import * as pluginService from "./plugin-service.ts";
import { PocSubscriptions } from "./poc-subscriptions.ts";
import { createPocTools } from "./poc-tool.ts";
import { LIST_CAP, type PocImportOptions, PocStore, pocsDbPath } from "./pocs.ts";
import { ensureBuiltinPresets, findPreset, readPresetText } from "./presets.ts";
import { ensureProjectReady, listProjects, type SentinelProject } from "./projects.ts";
import type {
	SentinelApiModel,
	SentinelApiModelEvent,
	SentinelApiModelFilters,
	SentinelApiModelStatus,
	SentinelApiModelSummary,
	SentinelAsset,
	SentinelAssetConfigView,
	SentinelAssetDeletePreview,
	SentinelAssetDetail,
	SentinelAssetFilters,
	SentinelAssetPlatform,
	SentinelAssetPlatformInput,
	SentinelAssetStats,
	SentinelAssetSummary,
	SentinelAssetUpdate,
	SentinelBuiltinChannel,
	SentinelBuiltinModelDefaults,
	SentinelBuiltinModelPreset,
	SentinelFileEntry,
	SentinelFilePreview,
	SentinelForkPoint,
	SentinelGateApproval,
	SentinelGateDecision,
	SentinelGateDecisionKind,
	SentinelGateFilter,
	SentinelGatekeeperConfig,
	SentinelGatekeeperView,
	SentinelGateStats,
	SentinelGoal,
	SentinelGoalPauseReason,
	SentinelGoalRoundOutcome,
	SentinelGoalUsage,
	SentinelGoalView,
	SentinelMcpConfigView,
	SentinelMcpServerInput,
	SentinelMcpTestResult,
	SentinelMode,
	SentinelModelCapabilities,
	SentinelModelingState,
	SentinelModelLibraryView,
	SentinelModelRoleName,
	SentinelNotifyChannel,
	SentinelNotifyConfig,
	SentinelNotifyStatus,
	SentinelPluginArtifact,
	SentinelPluginHostInput,
	SentinelPluginHostView,
	SentinelPluginsView,
	SentinelPluginView,
	SentinelPoc,
	SentinelPocFilters,
	SentinelPocImportOutcome,
	SentinelPocSource,
	SentinelPocSourceSave,
	SentinelPocStats,
	SentinelPocSummary,
	SentinelPocSyncRecord,
	SentinelSessionPresetView,
	SentinelStateSnapshot,
	SentinelStats,
	SentinelSubagentEvent,
	SentinelSubagentRun,
	SentinelSupervisorAdvice,
	SentinelSupervisorAuditPage,
	SentinelSupervisorCall,
	SentinelSupervisorConfig,
	SentinelSupervisorDetail,
	SentinelSupervisorEpisode,
	SentinelSupervisorLog,
	SentinelSupervisorMode,
	SentinelSupervisorProgress,
	SentinelSupervisorStrategy,
	SentinelSupervisorStrategyEntry,
	SentinelSupervisorStrategyRef,
	SentinelSupervisorView,
	SentinelTestResult,
	SentinelToolInfo,
	SentinelVulnerability,
	SentinelVulnFilters,
	SentinelVulnStats,
	SentinelVulnSummary,
	SentinelVulnUpdate,
	SentinelWebSearchConfigView,
	SentinelWebSearchKeyInput,
} from "./protocol.ts";
import { createReplayTools, type ReplayToolContext } from "./replay-tool.ts";
import { ensureReplayd, type ReplaydStatus } from "./replayd.ts";
import { createReportTool } from "./report-tool.ts";
import { ReportStore, reportsDbPath } from "./reports.ts";
import { readSessionDroid, SESSION_DROID_CUSTOM_TYPE } from "./session-droid.ts";
import { readSessionIos, SESSION_IOS_CUSTOM_TYPE } from "./session-ios.ts";
import { readSessionMode, SESSION_MODE_CUSTOM_TYPE } from "./session-mode.ts";
import { readSessionPreset, SESSION_PRESET_CUSTOM_TYPE } from "./session-preset.ts";
import {
	readSessionStatus,
	SESSION_STATUS_CUSTOM_TYPE,
	type SentinelSessionListEntry,
	type SentinelSessionStatus,
	withSessionStatus,
} from "./session-status.ts";
import { createSessionTitleTool } from "./session-title-tool.ts";
import { SessionUsageStore } from "./session-usage-store.ts";
import { createSubagentTool } from "./subagent.ts";
import { SubagentStore, subagentDbPath } from "./subagent-store.ts";
import { SubagentRegistry } from "./subagents.ts";
import { SUPERVISOR_ADVICE_CUSTOM_TYPE, Supervisor, type SupervisorTestOutcome } from "./supervisor.ts";
import { isSupervisorStrategy, readSupervisorConfig, writeSupervisorConfig } from "./supervisor-config.ts";
import { SUPERVISOR_STRATEGY_LABELS } from "./supervisor-prompt.ts";
import { SupervisorStore, supervisorDbPath } from "./supervisor-store.ts";
import { createToolAuditExtension } from "./tool-audit.ts";
import { createToolGateExtension, type ToolGateContext } from "./tool-gate.ts";
import { createToolWorkflowExtension } from "./tool-workflow.ts";
import { branchTranscript, branchUserMessages, messageText, withSystemPrompt } from "./transcript.ts";
import { createVulnerabilityTools, evidencePathsToContainer } from "./vuln-tool.ts";
import { emptyVulnStats, VulnerabilityStore, vulnerabilityDbPath } from "./vulnerabilities.ts";
import { buildVulnReport } from "./vulnerability-markdown.ts";
import { probeTavilyKey, tavilyUsage, usageRemaining } from "./websearch.ts";
import {
	deleteWebSearchKey as deleteStoredWebSearchKey,
	readWebSearchConfig,
	recordWebSearchKeyStatus,
	saveWebSearchKey,
	usablePoolKeys,
	webSearchConfigView,
	setWebSearchQueryLimit as writeWebSearchQueryLimit,
} from "./websearch-config.ts";
import { WebSearchStore, websearchDbPath } from "./websearch-store.ts";
import {
	createWebSearchTools,
	type WebSearchQueryReport,
	type WebSearchToolContext,
	writeWebSearchEvidence,
} from "./websearch-tool.ts";

export interface SentinelRuntimeHooks {
	/** Events of the currently viewed session only. */
	onSessionEvent(event: AgentSessionEvent): void;
	/** Fired whenever operator-visible state changes (approvals, mode, model, run lifecycle). */
	onStateChange(): void;
	/** One live sub-agent step, for the sub-agent panel. */
	onSubagentEvent(runId: string, event: SentinelSubagentEvent): void;
	/** Fired after a notification send, so the settings screen can show its outcome. */
	onNotifyStatus(status: SentinelNotifyStatus): void;
	/** A finding was submitted or reviewed; connected consoles refresh the hub page. */
	onVulnChange(): void;
	/** An asset or its timeline changed; consoles re-query with their own page. */
	onAssetChange(): void;
	/** A session's name changed (operator or agent); consoles refresh the list. */
	onSessionRenamed(): void;
	/** A finding reached the hub; the reviewer LLM queues it for calibration. */
	onVulnSubmitted(id: string): void;
	/** One gatekeeper judgment settled; consoles with the audit page open refresh it. */
	onGateDecision(decision: SentinelGateDecision): void;
	/** The POC library changed (import or delete); consoles refresh the POC page. */
	onPocChange(): void;
	/** A subscription source changed (save/delete/sync); consoles refresh the settings page. */
	onPocSourceChange(): void;
	/** A business-modeling run changed (started, submitted, ended); consoles refresh the page. */
	onApiModelChange(): void;
	/** A device came online/went offline, or the device page's data changed. */
	onDroidChange(): void;
	/** An iOS device or token changed; the iOS page re-renders. */
	onIosChange(): void;
	/** Live supervision state of a conversation. */
	onSupervisorState(view: SentinelSupervisorView | null): void;
	/** One supervisor episode settled; the floating window appends it. */
	onSupervisorEpisode(episode: SentinelSupervisorEpisode, calls: SentinelSupervisorCall[]): void;
	/** One supervisor log line. */
	onSupervisorLog(sessionId: string, log: SentinelSupervisorLog): void;
	/** A new or updated intervention record. */
	onSupervisorAdvice(advice: SentinelSupervisorAdvice): void;
}

/**
 * The persistent goal of one session, plus the bookkeeping of the round in
 * flight. It lives on the managed session, not on the runtime: a goal belongs to
 * the conversation it was started in, and switching views must not touch it.
 */
interface ManagedGoal {
	goal: SentinelGoal;
	/** Cumulative usage when the round started, so the round can report its delta. */
	roundUsageStart: SentinelGoalUsage;
	/** Tool calls seen in the round in flight; zero for three rounds trips the fuse. */
	roundToolCalls: number;
	/** Findings submitted to the hub since the goal started. */
	submitted: number;
	/**
	 * Consecutive rounds the loop-guard ended with a stutter abort. The guard is
	 * already nudging the model, so the goal stands down only after several in a
	 * row; any other settle clears the count.
	 */
	stutterStreak: number;
}

interface ManagedSession {
	key: string;
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	manager: SessionManager;
	unsubscribe: () => void;
	/**
	 * The project this conversation belongs to, fixed when the session is
	 * created: an engine task uses its engine's project, a console session the
	 * project whose work directory it lives under. Every tool context reads the
	 * project from here, never from the runtime's active project — a session that
	 * keeps running after the operator switched away must still write evidence,
	 * records, and audit rows to its own project.
	 */
	projectId: string | null;
	projectName: string | null;
	/** Container executing this session's tools, captured with the project. */
	container: string;
	/** Host work directory of this session, not the active project's. */
	cwd: string;
	/** This session's command mode: its own override, or the console default. */
	modeOf: () => SentinelMode;
	/**
	 * The run in flight for THIS session. It lives here, not on the runtime,
	 * because a run settles whether or not the operator is still looking at it:
	 * a long task that finishes while another conversation is on screen must
	 * still be reported.
	 */
	run?: {
		startedAt: number;
		/** Composer's per-message choice; undefined when it did not send one. */
		notify: boolean | undefined;
		instruction: string;
	};
	/** Persistent goal of this session, when one was started. */
	goal?: ManagedGoal;
	/**
	 * This session's own mode, when the operator set one. null means it follows
	 * the console-wide default in gatekeeper.json. Read from the session file at
	 * creation, so a reopened conversation keeps the mode it was left in.
	 */
	modeOverride: SentinelMode | null;
	/**
	 * Whether this conversation mounts the Android toolset. Per session, not per
	 * console: one chat driving a phone must not put droid_* / apk_* into every
	 * other chat's prompt. Read from the branch at creation and written back by
	 * the composer switch, so a reopened conversation keeps its own choice.
	 */
	droidOn: boolean;
	/**
	 * Whether this conversation mounts the iOS toolset. Separate from `droidOn`
	 * so one chat can drive a phone while another drives an iPhone; read from
	 * the branch at creation and written back by the composer switch.
	 */
	iosOn: boolean;
	/**
	 * The preset agent this session was created with, read from the branch. null
	 * means the plain default agent. The body is not cached: it is read from disk
	 * on every (re)build, so editing a preset affects sessions created after the
	 * edit while the record of which preset a session used stays exact.
	 */
	presetId: string | null;
	/**
	 * The preset is named on the branch but its body cannot be read any more. The
	 * session runs as the default agent and the console says so, rather than
	 * showing a preset badge for context that was never loaded.
	 */
	presetMissing: boolean;
	/**
	 * When this session's compaction started. The SDK blocks prompts for as long
	 * as its compaction controller lives, and a slow model can hold that for
	 * minutes, so the console tracks it to show the wait and to offer a cancel.
	 */
	compactionStartedAt?: number;
	/**
	 * True when this session belongs to an engineering-mode task. Task sessions
	 * are created by the engine through `acquireTaskSession`, run ungated, are
	 * never rebuilt by config/permission saves, and their goal is driven by the
	 * engine's worker — not by the console's goal bar.
	 */
	taskSession?: boolean;
	/**
	 * The business-modeling run in force for this session, read from the branch
	 * at (re)build time. The two modeling tools are active exactly while this is
	 * set, so a session that is not modeling has no trace of the feature in its
	 * tool list or its system prompt.
	 */
	modeling?: ModelingRun;
	/**
	 * Modeling records the operator attached from the composer (带建模数据). The
	 * catalog is injected once, with the first prompt; the read-only
	 * `api_model_read` stays mounted until the operator removes the attachment.
	 */
	modelingAttach?: ModelingAttach;
	/**
	 * Asset-mapping queries this session has spent, across all platforms and
	 * including its sub-agents. Reset by a rebuild, which is what makes the
	 * configured budget "per session" rather than "per process".
	 */
	assetQueries: number;
	/** Web-search (Tavily) calls this session has made, shared with sub-agents. */
	webQueries: number;
	/** Tool calls whose start event was seen, keyed by call id, for the supervisor digest. */
	toolStarts?: Map<string, { toolName: string; args: unknown; at: number; parentToolCallId?: string }>;
}

/** Extra wiring a task session needs beyond a console session. */
export interface TaskSessionOptions {
	/** The engine's project, which may differ from the viewed one. */
	project: { id: string; name: string; container: string; cwd: string };
	/** Extra system-prompt text: the worker's engineering identity note. */
	appendPrompt: string;
	/**
	 * The preset agent this task was dispatched with; null means the default agent.
	 * It is written into the task's own session file, so the session loads that
	 * context on every rebuild and a resumed task keeps it without the engine
	 * having to pass it again.
	 */
	presetId: string | null;
	taskTitle: string;
	/** The engine this task belongs to, recorded on every finding it submits. */
	engineId: string;
	/** The task itself; with the engine it is the hub's 工程/任务 filter key. */
	taskId: string;
	/**
	 * The engine's gate for this task's commands. A worker never waits for a
	 * human, so `ai` routes its commands through the gatekeeper instead.
	 */
	gateMode: "auto" | "ai";
	/** pi session id to reopen; null for a fresh task. */
	taskSessionId: string | null;
	/**
	 * True when the task already has a conversation to reopen (resume after a
	 * restart, or a commander-requested continuation). The file is required: a
	 * task that lost its transcript is not silently restarted as a new one.
	 */
	reopen: boolean;
	/** Goal tools bind to the engine worker's goal state, not the console's. */
	goalPort: GoalPort;
	/** A finding was submitted; the worker counts it towards its goal. */
	onFinding(): void;
}

/**
 * What a gated bash tool needs to know about the session it belongs to. The
 * label is what the approval popup and the audit record call the caller; the
 * mode is a function because it can change while the session runs.
 */
interface BashGateContext {
	label: () => string;
	modeOf: () => SentinelMode;
	/** Host side of the /work mount, so the judge is shown the container path. */
	hostWorkDir: string;
	projectId: string | null;
	projectName: string | null;
	sessionId: () => string | null;
}

/** Largest artifact a plugin frontend may read in one bridge call. */
const MAX_UI_ARTIFACT_BYTES = 1024 * 1024;

export class SentinelRuntime {
	private cwd: string;
	private activeProjectId: string | undefined;
	private activeProjectName: string | undefined;
	private activeContainer: string | undefined;
	private readonly agentDir: string;
	private sessionDir: string;
	private readonly hooks: SentinelRuntimeHooks;
	private readonly approvals: ApprovalGate;
	private readonly subagentStore: SubagentStore;
	private readonly subagents: SubagentRegistry;
	private readonly vulnerabilities: VulnerabilityStore;
	readonly reports: ReportStore;
	private readonly pocs: PocStore;
	private readonly apiModels: ApiModelStore;
	private readonly droids: DroidStore;
	private readonly ios: IosStore;
	private readonly captures: CaptureStore;
	private readonly assets: AssetStore;
	private readonly assetLibrary: AssetLibraryStore;
	private readonly webSearchLog: WebSearchStore;
	private readonly sessionUsage: SessionUsageStore;
	/** Per-key usage cache: remaining credits at `at`; -1 marks a dead probe. */
	private readonly webUsageCache = new Map<string, { at: number; remaining: number; limit: number | null }>();
	/** Injected once the server has built the WS device gateway (see server.ts). */
	private droidGateway: DroidGateway | undefined;
	private iosGateway: IosGateway | undefined;
	private readonly subscriptions: PocSubscriptions;
	private readonly gateStore: GatekeeperStore;
	private readonly gatekeeper: Gatekeeper;
	private readonly supervisorStore: SupervisorStore;
	private readonly supervisor: Supervisor;

	private sessions = new Map<string, ManagedSession>();
	private activeKey: string | undefined;
	private modelRuntime: ModelRuntime | undefined;
	/** Set when models.json changed under a live runtime, so the next use refreshes it. */
	private modelRuntimeDirty = false;
	/** The run in flight for the viewed session, used to report it when it settles. */
	private notifyStatus: SentinelNotifyStatus = { at: null, ok: true };
	/**
	 * Vulnerability records already pushed to the notification channel. Per
	 * process: a restart may re-push a record the reviewer settles afterwards,
	 * which is one stray push, not the flood the gate exists for.
	 */
	private readonly notifiedVulns = new Set<string>();

	constructor(options: {
		cwd: string;
		agentDir?: string;
		activeProject?: { id: string; name: string; container?: string; cwd?: string };
		hooks: SentinelRuntimeHooks;
	}) {
		this.cwd = options.cwd;
		this.activeProjectId = options.activeProject?.id;
		this.activeProjectName = options.activeProject?.name;
		this.activeContainer = options.activeProject?.container;
		if (options.activeProject) {
			this.cwd = options.activeProject.cwd ?? this.cwd;
		}
		this.agentDir = options.agentDir ?? getAgentDir();
		this.hooks = options.hooks;
		this.approvals = new ApprovalGate(() => this.hooks.onStateChange());
		this.sessionDir = getDefaultSessionDir(this.cwd, this.agentDir);
		this.subagentStore = new SubagentStore(subagentDbPath(this.agentDir));
		this.vulnerabilities = new VulnerabilityStore(vulnerabilityDbPath(this.agentDir));
		this.reports = new ReportStore(reportsDbPath(this.agentDir));
		// Seed the built-in presets before anything reads the store: a fresh
		// console must offer them from its very first session.
		ensureBuiltinPresets(this.agentDir);
		this.pocs = new PocStore(pocsDbPath(this.agentDir));
		this.apiModels = new ApiModelStore(apiModelsDbPath(this.agentDir));
		this.droids = new DroidStore(droidDbPath(this.agentDir));
		this.ios = new IosStore(iosDbPath(this.agentDir));
		this.captures = new CaptureStore(capturesDbPath(this.agentDir));
		this.assets = new AssetStore(assetsDbPath(this.agentDir));
		this.assetLibrary = new AssetLibraryStore(assetLibraryDbPath(this.agentDir));
		this.webSearchLog = new WebSearchStore(websearchDbPath(this.agentDir));
		this.sessionUsage = new SessionUsageStore(this.agentDir);
		this.subscriptions = new PocSubscriptions(this.agentDir, this.pocs, {
			onChange: () => this.hooks.onPocSourceChange(),
			onPocChange: () => this.hooks.onPocChange(),
			onSyncFailure: (source, record) => this.notifyPocSyncFailure(source, record),
		});
		this.subscriptions.start();
		this.subagents = new SubagentRegistry(this.subagentStore, {
			onEvent: (runId, event) => this.hooks.onSubagentEvent(runId, event),
			onRunChange: () => this.hooks.onStateChange(),
		});
		this.gateStore = new GatekeeperStore(gatekeeperDbPath(this.agentDir));
		this.gatekeeper = new Gatekeeper(
			this.gateStore,
			{ onDecision: (decision) => this.hooks.onGateDecision(decision) },
			this.agentDir,
		);
		this.supervisorStore = new SupervisorStore(supervisorDbPath(this.agentDir));
		this.supervisor = new Supervisor({
			agentDir: this.agentDir,
			store: this.supervisorStore,
			hooks: {
				onState: (view) => this.hooks.onSupervisorState(view),
				onEpisode: (episode, calls) => this.hooks.onSupervisorEpisode(episode, calls),
				onLog: (sessionId, log) => this.hooks.onSupervisorLog(sessionId, log),
				onAdvice: (advice) => this.hooks.onSupervisorAdvice(advice),
				onSendAdvice: (advice) => this.injectSupervisorAdvice(advice),
			},
		});
	}

	private get active(): ManagedSession | undefined {
		return this.activeKey ? this.sessions.get(this.activeKey) : undefined;
	}

	get currentSessionId(): string | null {
		return this.active?.manager.getSessionId() ?? null;
	}

	/** Project checks must not construct or clone the conversation transcript. */
	get currentProject(): SentinelStateSnapshot["project"] {
		return this.activeProjectId
			? {
					id: this.activeProjectId,
					name: this.activeProjectName ?? "",
					cwd: this.cwd,
					container: this.activeContainer ?? null,
				}
			: null;
	}

	/** The active session's file path, for messages that mean "the current session". */
	get currentSessionPath(): string | null {
		const file = this.active?.manager.getSessionFile();
		return file ? resolveFsPath(file) : null;
	}

	/** The mode in effect for the viewed session: its own override, or the global default. */
	get currentMode(): SentinelMode {
		return this.effectiveMode(this.active);
	}

	/**
	 * The mode that governs one session's commands. The session's own choice wins;
	 * otherwise the console-wide default applies. Read from disk on each call
	 * because the default can change while a background session is running, and a
	 * background session must not be governed by whatever is on screen.
	 */
	private effectiveMode(managed: ManagedSession | undefined): SentinelMode {
		if (managed?.modeOverride) return managed.modeOverride;
		return readGatekeeperConfig(this.agentDir).mode;
	}

	get isStreaming(): boolean {
		return this.active?.session.isStreaming ?? false;
	}

	/**
	 * Create the viewed session for the active project. Without a project no
	 * session exists at all: the console is not a host-shell runner, so there is
	 * no default directory to fall back to.
	 */
	async init(): Promise<void> {
		await this.sessionUsage.backfill(join(this.agentDir, "sessions"));
		if (!this.activeProjectId) return;
		this.activeKey = await this.createSessionInto(SessionManager.create(this.cwd, this.sessionDir || undefined));
	}

	/** Activate a container project: sessions live on the host under its workDir, tools exec in the container. */
	async switchProject(project: { id: string; name: string; container?: string; cwd: string }): Promise<void> {
		await this.applyProject(project.id, project.name, project.cwd, project.container);
	}

	private async applyProject(
		id: string | undefined,
		name: string | undefined,
		cwd: string,
		container: string | undefined,
	): Promise<void> {
		this.cwd = cwd;
		this.activeProjectId = id;
		this.activeProjectName = name;
		this.activeContainer = container;
		this.sessionDir = getDefaultSessionDir(this.cwd, this.agentDir);
		this.activeKey = await this.createSessionInto(SessionManager.create(this.cwd, this.sessionDir || undefined));
		this.hooks.onStateChange();
	}

	/**
	 * Create a session and register it. Returns its key. Existing sessions are
	 * never touched: switching views must not interrupt background runs.
	 */
	/**
	 * Resource loader and settings shared by the main session and its sub-agents,
	 * so both load the same extensions and activate the same tools.
	 *
	 * The CLI loads codemode, tool search, and MCP as built-in extensions; SDK
	 * sessions have to add them explicitly. codemode and tool_search register
	 * inactive, so the default-tools override activates them while keeping the
	 * coding tools. The MCP extension connects its servers on session_start,
	 * which `bindExtensions` emits; its config comes from 设置 → MCP, not from
	 * pi's own mcp.json (see `createMcpExtension`).
	 */
	private async createSessionContext(
		cwd: string,
		permissions: SentinelPermissionSet,
		appendSystemPrompt?: string[],
		pluginPermissions: SentinelPluginPermissionMap = {},
		gate?: ToolGateContext,
	): Promise<{ resourceLoader: DefaultResourceLoader; settingsManager: SettingsManager }> {
		// A disabled extension is not even loaded: without MCP there are no
		// servers to connect, and codemode/tool_search never register. The
		// excludeTools denylist still covers them, so nothing can re-enable them.
		const extensionFactories = [];
		if (permissions.codemode) extensionFactories.push(createCodemodeExtension());
		if (permissions.tool_search) extensionFactories.push(createToolSearchExtension());
		if (permissions.mcp) extensionFactories.push(this.mcpExtensionFactory(pluginPermissions));
		// MCP tools are judged on the tool_call event rather than inside the tool,
		// because they are executed by an MCP client this console does not wrap.
		// Only mounted when MCP is: without it there is no `mcp__` tool to judge.
		if (permissions.mcp && gate) {
			extensionFactories.push(
				createToolGateExtension({ gatekeeper: this.gatekeeper, agentDir: this.agentDir, context: gate }),
			);
		}
		// The other half of the audit trail: every call the judge does not see is
		// still recorded, so 「自动审批」 can answer "what did this session do".
		// Not gated on MCP — it covers read, edit, write and codemode too.
		if (gate) {
			extensionFactories.push(
				createToolAuditExtension({ store: this.gateStore, agentDir: this.agentDir, context: gate }),
			);
		}
		// Loop hygiene is not permission-gated: it only aborts degenerate output
		// and injects reminders, so it belongs in every session.
		extensionFactories.push(createLoopGuardExtension());
		extensionFactories.push(createToolWorkflowExtension());
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: this.agentDir,
			extensionFactories,
			...(appendSystemPrompt ? { appendSystemPrompt } : {}),
		});
		await resourceLoader.reload();
		const settingsManager = SettingsManager.create(cwd, this.agentDir);
		// Modifier-only entries append to the configured default tools instead of
		// replacing them, so an operator's own `defaultTools` setting still applies.
		const modifiers: string[] = [];
		if (permissions.codemode) modifiers.push("+codemode");
		if (permissions.tool_search) modifiers.push("+tool_search");
		settingsManager.applyOverrides(modifiers.length > 0 ? { defaultTools: modifiers } : {});
		return { resourceLoader, settingsManager };
	}

	/**
	 * The MCP extension, pointed at 设置 → MCP instead of pi's own `mcp.json`.
	 *
	 * Replacing `loadConfig` is what makes the console the only place a server can
	 * come from: a session connects exactly the entries the settings page shows, so
	 * a hand-written file cannot add a tool nobody can see. `updateConfig` covers the
	 * one other writer, the extension's own `/mcp` manager in a terminal session,
	 * which then changes the same file.
	 *
	 * `pluginPermissions` is this agent's slice of 设置 → 权限's plugin rows: a
	 * plugin switched off for the agent is simply not in the config it loads.
	 */
	private mcpExtensionFactory(pluginPermissions: SentinelPluginPermissionMap): ExtensionFactory {
		return createMcpExtension({
			loadConfig: () => loadSentinelMcpConfig(this.agentDir, (key) => pluginAllowed(pluginPermissions, key)),
			updateConfig: (entry, patch) => updateMcpServerRecord(this.agentDir, entry.name, patch),
		});
	}

	private async createSessionInto(manager: SessionManager, task?: TaskSessionOptions): Promise<string> {
		// Every tool call runs in a project container; there is no host backend.
		// A task session runs in the engine's project (which may not be the one
		// on screen) and its bash follows the engine's own choice: `auto` runs
		// straight through, because engineering mode never stops at an approval
		// queue nobody is watching, while `ai` sends every command to the judge.
		const cwd = manager.getCwd();
		const container = task ? task.project.container : this.requireContainer();
		// The session's project is fixed here, once, and every tool context below
		// reads it from `managed` instead of the runtime's active project. A
		// background session from another project would otherwise write evidence
		// and records into whichever project the operator happens to be viewing.
		const project = task ? { id: task.project.id, name: task.project.name } : this.projectOfWorkDir(cwd);
		await this.ensureModelRuntime();

		const model = this.resolveModel();
		// The preset is read back off the branch, so a reopened conversation loads the
		// context it is currently under and a switch applies to the next build. The
		// text itself is resolved here, on every (re)build, which is what makes an
		// edited preset apply to the next build while this one keeps its own.
		const presetId = readSessionPreset(manager.getBranch());
		const presetText = presetId ? readPresetText(this.agentDir, presetId) : null;
		const managed: ManagedSession = {
			key: "",
			session: undefined as unknown as ManagedSession["session"],
			manager,
			unsubscribe: () => {},
			projectId: project?.id ?? null,
			projectName: project?.name ?? null,
			container,
			cwd,
			// A console session follows its own override or the console-wide default;
			// a task session follows its engine's gate, never the console's.
			modeOf: task ? () => (task.gateMode === "ai" ? "ai" : "auto") : () => this.effectiveMode(managed),
			// A reopened conversation keeps the mode it was left in.
			modeOverride: readSessionMode(manager.getBranch()),
			droidOn: task ? false : readSessionDroid(manager.getBranch()),
			iosOn: task ? false : readSessionIos(manager.getBranch()),
			presetId,
			presetMissing: presetId !== null && presetText === null,
			// Modeling is a console feature: an engineering task's worker never gets
			// it, and a reopened conversation resumes the run it was left in.
			modeling: task ? undefined : (readModelingRun(manager.getBranch()) ?? undefined),
			// Attached records survive a restart the same way a run does.
			modelingAttach: task ? undefined : (readModelingAttach(manager.getBranch()) ?? undefined),
			assetQueries: 0,
			webQueries: 0,
		};
		// An engineering task's mode comes from its engine, never from the console:
		// a worker that waited for the operator would defeat the engine's purpose,
		// and the console's mode may be `review` while the engine runs unattended.
		const gateContext: Omit<BashGateContext, "label"> = {
			modeOf: managed.modeOf,
			hostWorkDir: cwd,
			projectId: managed.projectId,
			projectName: managed.projectName,
			sessionId: () => manager.getSessionId(),
		};
		const bash = this.createGatedBash(
			manager.getCwd(),
			dockerBashOperations(container, { hostWorkDir: manager.getCwd() }),
			{
				...gateContext,
				label: task ? () => `工程任务「${task.taskTitle}」` : () => this.sessionLabel(managed),
			},
		);

		const permissionsConfig = readPermissionsConfig(this.agentDir);
		const permissions = permissionsConfig.main;
		const subagentPermissions = effectiveSubagent(permissionsConfig);
		// Plugins follow the same subset rule as tools: a plugin the main agent may
		// not mount is not mountable by a sub-agent either.
		const subagentPlugins = effectiveSubagentPlugins(permissionsConfig);
		// The preset text follows the identity text: a worker first learns that it
		// is a worker, then what it is working as. A session without a preset passes
		// nothing, which is exactly what every session did before presets existed.
		const appendSystemPrompt = task
			? [task.appendPrompt, ...(presetText ? [presetText] : [])]
			: presetText
				? [presetText]
				: undefined;
		const { resourceLoader, settingsManager } = await this.createSessionContext(
			manager.getCwd(),
			permissions,
			appendSystemPrompt,
			permissionsConfig.plugins.main,
			{
				...gateContext,
				label: task ? () => `工程任务「${task.taskTitle}」` : () => this.sessionLabel(managed),
			},
		);

		// `baseToolsOverride` replaces the whole base tool set, so the default coding
		// tools must be listed explicitly alongside the gated bash. Passing only bash
		// would leave the session with bash and the custom tools, and the system
		// prompt's tool section would degrade to the custom tools alone. Disabled
		// tools are left out here and named in `excludeTools`, which keeps
		// tool_search, the transcript and codemode from bringing them back.
		const baseToolsOverride = {
			...(permissions.read
				? {
						read: createReadTool(manager.getCwd()),
						grep: createGrepTool(manager.getCwd()),
						find: createFindTool(manager.getCwd()),
						ls: createLsTool(manager.getCwd()),
					}
				: {}),
			...(permissions.bash ? { bash } : {}),
			...(permissions.edit ? { edit: createEditTool(manager.getCwd()) } : {}),
			...(permissions.write ? { write: createWriteTool(manager.getCwd()) } : {}),
		};
		// The hub tools are mounted here as well, so a session that may not delegate
		// can still report what it found.
		const sessionProject = managed.projectId
			? { id: managed.projectId, name: managed.projectName ?? t("未命名项目") }
			: undefined;
		// Asset mapping is an operator-configured capability: a platform that is
		// switched off, unkeyed or unverified contributes no tool at all, so the
		// model never sees a search engine it cannot use. Task sessions are left
		// out, the same way the droid and modeling tools are.
		const assetPlatforms = task || !permissions.asset_read ? [] : usablePlatforms(this.agentDir);
		// Web search follows the same rule: the switch plus a usable pool key is
		// what puts web_search/web_extract in the tool list at all.
		const webSearchOn = !task && permissions.web_search && usablePoolKeys(this.agentDir).length > 0;
		const mitmContext = {
			center: new MitmCenter(this.agentDir, () => listProjects(this.agentDir).projects),
			projectId: managed.projectId,
		};
		const customTools: ToolDefinition[] = [
			createReportTool({
				store: this.reports,
				workDir: cwd,
				container,
				provenance: () => {
					if (!sessionProject) return undefined;
					const goal = managed.goal?.goal.status === "active" ? managed.goal.goal : undefined;
					return {
						projectId: sessionProject.id,
						projectName: sessionProject.name,
						source: task ? "engine" : goal ? "goal" : "session",
						sessionId: manager.getSessionId(),
						sessionName: manager.getSessionName(),
						...(goal ? { goalId: goal.id } : {}),
						...(task ? { engineId: task.engineId, taskId: task.taskId, taskName: task.taskTitle } : {}),
					};
				},
			}),
			// The agent names the conversation once the task is clear; task
			// sessions keep their engine prefix so the sidebar badge holds.
			createSessionTitleTool({
				rename: (title) => {
					manager.appendSessionInfo(title);
					this.hooks.onSessionRenamed();
				},
			}),
			// The goal tools are always mounted; they refuse to do anything while no
			// goal is running, which keeps the mount set stable across a goal. Task
			// sessions bind to the engine worker's goal state instead.
			...createGoalTools(task ? task.goalPort : this.createGoalPort(managed)),
			...this.createVulnTools({
				project: sessionProject,
				permissions,
				getSessionId: () => manager.getSessionId(),
				getSessionName: () => managed.manager.getSessionName(),
				...(task ? { getEngineRef: () => ({ engineId: task.engineId, taskId: task.taskId }) } : {}),
				getSource: () => (task ? `工程任务「${task.taskTitle}」` : "主代理"),
				workDir: manager.getCwd(),
				// A finding counts towards the goal's hub statement whether the main
				// agent or one of its sub-agents submitted it.
				onSubmit: task ? task.onFinding : () => this.noteGoalFinding(managed),
			}),
			...this.createAssetTools({
				project: sessionProject,
				permissions,
				getSessionId: () => manager.getSessionId(),
				getSessionName: () => managed.manager.getSessionName(),
				...(task ? { getEngineRef: () => ({ engineId: task.engineId, taskId: task.taskId }) } : {}),
				getSource: () => (task ? `工程任务「${task.taskTitle}」` : "主代理"),
			}),
			// The POC library is read-only reference; the switch controls both of
			// its tools, and sub-agents inherit it through the subset rule.
			...(permissions.poc_read ? createPocTools({ store: this.pocs }) : []),
			// Main and engineering workers read only their fixed session project.
			...(permissions.mitm_read ? createMitmTools(mitmContext) : []),
			...(assetPlatforms.length > 0
				? createAssetTools(
						assetPlatforms,
						this.createAssetToolContext(managed, () => "主代理"),
					)
				: []),
			...(webSearchOn ? createWebSearchTools(this.createWebSearchToolContext(managed, () => "主代理")) : []),
			// The modeling tools are declared on every console session — the operator
			// may start modeling by asking for it instead of pressing the button — and
			// they carry their own "only call this when asked" wording. Task sessions
			// do not get them at all, and a sub-agent only receives the tools in its
			// own subset: business modeling stays an operator-driven action on a
			// conversation.
			...(task ? [] : createApiModelTools(this.createModelingPort(managed))),
			...(task ? [] : createApiModelAttachTools(this.createModelingAttachPort(managed))),
			// The Android toolset is opt-in per conversation; off means unmounted,
			// which keeps an Android toolset out of a Web-pentest session's prompt.
			...(task ? [] : createDroidTools(this.createDroidToolContext(managed))),
			...(task ? [] : createApkTools(this.createDroidToolContext(managed))),
			// The iOS toolset is opt-in per conversation, independent of Android.
			...(task ? [] : createIosTools(this.createIosToolContext(managed))),
			...(task ? [] : createIosFridaTools(this.createIosToolContext(managed))),
			...(task ? [] : createIosCaptureTools(this.createIosToolContext(managed))),
			...(task ? [] : createIosDecryptTools(this.createIosToolContext(managed))),
			...(task ? [] : createFridaTools(this.createDroidToolContext(managed))),
			// The report-evidence toolset is declared and active in every console
			// session (like the modeling tools), and never handed to a task worker.
			...(task ? [] : createReplayTools(this.createReplayToolContext(managed))),
			...(task
				? []
				: createCaptureTools({
						gateway: () => this.droidGateway,
						container: () => managed.container,
						workDir: () => managed.cwd,
						project: () =>
							managed.projectId ? { id: managed.projectId, name: managed.projectName ?? t("未命名项目") } : null,
						store: () => this.captures,
					})),
			...(permissions.spawn_agent
				? [
						createSubagentTool({
							cwd: manager.getCwd(),
							agentDir: this.agentDir,
							maxTurns: permissionsConfig.subagentMaxTurns,
							getModel: () => this.resolveModel(),
							getModelRuntime: () => this.modelRuntime,
							registry: this.subagents,
							getParentSessionId: () => manager.getSessionId(),
							getProjectId: () => managed.projectId ?? undefined,
							permissions: subagentPermissions,
							// A sub-agent inherits the parent session's gate: the same mode,
							// the same project, the same audit attribution except the label.
							createGatedBash: () =>
								this.createGatedBash(
									manager.getCwd(),
									dockerBashOperations(container, { hostWorkDir: manager.getCwd() }),
									{ ...gateContext, label: () => "子代理" },
								),
							createSessionContext: (appendSystemPrompt) =>
								this.createSessionContext(
									manager.getCwd(),
									subagentPermissions,
									// A sub-agent inherits the parent session's preset, so it works
									// under the same briefing — after its own sub-agent identity text.
									presetText ? [...appendSystemPrompt, presetText] : appendSystemPrompt,
									subagentPlugins,
									// The judge is told the call came from a sub-agent, the same
									// label the bash gate uses for its commands.
									{ ...gateContext, label: () => "子代理" },
								),
							// A sub-agent reports under the parent session and project.
							createVulnTools: (getSource) =>
								this.createVulnTools({
									project: sessionProject,
									permissions: subagentPermissions,
									getSessionId: () => manager.getSessionId(),
									getSessionName: () => managed.manager.getSessionName(),
									...(task ? { getEngineRef: () => ({ engineId: task.engineId, taskId: task.taskId }) } : {}),
									getSource,
									workDir: manager.getCwd(),
									// A task session's goal is the worker's, not managed.goal:
									// route it to the same counter the main agent uses.
									onSubmit: task ? task.onFinding : () => this.noteGoalFinding(managed),
								}),
							createAssetTools: (getSource) =>
								this.createAssetTools({
									project: sessionProject,
									permissions: subagentPermissions,
									getSessionId: () => manager.getSessionId(),
									getSessionName: () => managed.manager.getSessionName(),
									...(task ? { getEngineRef: () => ({ engineId: task.engineId, taskId: task.taskId }) } : {}),
									getSource,
								}),
							extraTools: [
								...(subagentPermissions.poc_read ? createPocTools({ store: this.pocs }) : []),
								...(subagentPermissions.mitm_read ? createMitmTools(mitmContext) : []),
								// A sub-agent shares the parent session's query budget, so a
								// fan-out cannot spend the operator's quota faster than the
								// budget allows.
								...(subagentPermissions.asset_read && assetPlatforms.length > 0
									? createAssetTools(
											assetPlatforms,
											this.createAssetToolContext(managed, () => "子代理"),
										)
									: []),
								...(subagentPermissions.web_search && webSearchOn
									? createWebSearchTools(this.createWebSearchToolContext(managed, () => "子代理"))
									: []),
							],
						}),
					]
				: []),
		];
		const created = await createAgentSession({
			cwd: manager.getCwd(),
			agentDir: this.agentDir,
			modelRuntime: this.modelRuntime,
			model,
			sessionManager: manager,
			resourceLoader,
			settingsManager,
			baseToolsOverride,
			customTools,
			excludeTools: excludeToolsFor(permissions),
		});
		managed.session = created.session;
		managed.taskSession = task !== undefined;
		// Emits session_start, which connects MCP servers and lets extensions
		// contribute skills and prompt templates.
		await created.session.bindExtensions({});
		managed.key = manager.getSessionId();
		if (!task) {
			this.supervisor.attach({
				sessionId: managed.key,
				manager,
				projectId: managed.projectId,
				projectName: managed.projectName,
			});
		}
		// The modeling tools are declared in every console session (see
		// modelingToolLoadout); this only puts the read tool in place when the
		// conversation carries attached records.
		this.applyModelingTools(managed);
		this.applyDroidTools(managed);
		this.applyIosTools(managed);
		if (task) {
			// Task sessions live under their engine's collapsible group in the
			// sidebar, which already states the ownership — the name is just the
			// task title, no redundant 「工程名 · 」 prefix.
			manager.appendSessionInfo(task.taskTitle);
			// The task's goal is the worker's state, not the console's: no restore
			// here (the worker resumes it itself), and the goal bar never claims it.
		} else {
			// The goal is restored from the session file, so a reopened conversation
			// keeps the objective it was working on.
			managed.goal = this.restoreGoal(managed);
		}
		managed.unsubscribe = created.session.subscribe((event) => {
			if (
				event.type === "turn_end" ||
				event.type === "agent_settled" ||
				event.type === "compaction_end" ||
				event.type === "entry_appended"
			) {
				this.recordSessionUsage(managed);
			}
			// Only the viewed session streams events; background sessions run silently.
			if (managed.key === this.activeKey) this.hooks.onSessionEvent(event);
			if (event.type === "tool_execution_start") {
				if (managed.goal) managed.goal.roundToolCalls += 1;
				if (!task) {
					managed.toolStarts ??= new Map();
					managed.toolStarts.set(event.toolCallId, {
						toolName: event.toolName,
						args: event.args,
						at: Date.now(),
						...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
					});
				}
			}
			if (event.type === "tool_execution_end") {
				const start = managed.toolStarts?.get(event.toolCallId);
				managed.toolStarts?.delete(event.toolCallId);
				// Supervision follows the conversation on screen only. A background
				// session keeps its state, but it does not spend supervisor calls.
				if (
					!task &&
					start &&
					!event.parentToolCallId &&
					managed.key === this.activeKey &&
					this.supervisor.statusOf(managed.key) === "running"
				) {
					this.supervisor.observeToolCall(managed.key, {
						callId: event.toolCallId,
						toolName: start.toolName,
						args: start.args,
						result: event.result,
						isError: event.isError,
						durationMs: event.durationMs,
						at: start.at,
					});
				}
			}
			if (event.type === "agent_settled") {
				// The round is closed before the snapshot goes out: a console that saw
				// the settled state first would show a round that never finished.
				this.reportRunSettled(managed, event.aborted);
				this.afterRoundSettled(managed, event.aborted);
				this.hooks.onStateChange();
				return;
			}
			// Any run start (a prompt, a goal continuation, a queued steer that
			// becomes a turn) is the moment an armed conversation starts collecting.
			if (event.type === "agent_start" && managed.key === this.activeKey) {
				if (this.supervisor.statusOf(managed.key) === "waiting") this.supervisor.start(managed.key);
			}
			if (event.type === "agent_end") this.hooks.onStateChange();
			if (event.type === "compaction_start") {
				managed.compactionStartedAt = Date.now();
				this.hooks.onStateChange();
			}
			if (event.type === "compaction_end") {
				managed.compactionStartedAt = undefined;
				this.hooks.onStateChange();
			}
		});
		this.recordSessionUsage(managed);
		this.sessions.set(managed.key, managed);
		return managed.key;
	}

	/**
	 * Create (or reattach to) the console-visible session of one engineering
	 * task. The session lives in the project's normal session directory, so it
	 * shows up in the 对话 list with its 「工程 · 任务」 name and can be opened in
	 * the full conversation view while it runs — there is exactly one live
	 * instance, owned by this runtime, whether the engine or the operator is
	 * the one looking at it.
	 */
	async acquireTaskSession(
		options: TaskSessionOptions,
	): Promise<{ session: ManagedSession["session"]; manager: SessionManager; unsubscribe: () => void }> {
		const sessionDir = getDefaultSessionDir(options.project.cwd, this.agentDir);
		// A continuation or a resume reopens the task's own conversation. A live
		// session cannot be reused as-is: its goal tools still point at the worker
		// that owned it, so it is rebuilt from the same manager with the new worker's
		// goal port. A dead one is opened from its file. Either way, a missing file
		// is an error rather than a silent fresh start: the continuation was asked
		// to build on prior work.
		let manager: SessionManager;
		let rebuilt = false;
		if (options.reopen) {
			if (!options.taskSessionId) throw new Error(t("任务没有可恢复的会话，无法在原会话上继续"));
			const existing = this.sessions.get(options.taskSessionId);
			if (existing) {
				if (existing.session.isStreaming) throw new Error(t("任务会话仍在运行，请先中止再续跑"));
				existing.unsubscribe();
				existing.session.dispose();
				this.sessions.delete(existing.key);
				manager = existing.manager;
				rebuilt = true;
			} else {
				const file = SessionManager.findById(options.project.cwd, options.taskSessionId, sessionDir);
				if (!file) throw new Error(t("任务会话文件不存在，无法在原会话上继续；请重新派发任务"));
				manager = SessionManager.open(file, sessionDir || undefined, options.project.cwd);
			}
		} else {
			manager = SessionManager.create(options.project.cwd, sessionDir || undefined);
		}
		// A fresh task records the preset it was dispatched with in its own file, so
		// the choice travels with the conversation: reopening it in the console shows
		// the preset badge, and a task resumed after a restart picks it up from the
		// branch. A reopened file already has the entry and must not get a second one.
		if (!options.reopen && options.presetId) {
			manager.appendCustomEntry(SESSION_PRESET_CUSTOM_TYPE, { id: options.presetId, at: Date.now() });
		}
		const key = await this.createSessionInto(manager, options);
		const managed = this.sessions.get(key);
		if (!managed) throw new Error(t("任务会话创建失败"));
		if (rebuilt) this.hooks.onStateChange();
		return {
			session: managed.session,
			manager: managed.manager,
			unsubscribe: managed.unsubscribe,
		};
	}

	private sessionLabel(managed: ManagedSession): string {
		const name = managed.manager.getSessionName();
		return name ? `${name} · 主代理` : "主代理";
	}

	/**
	 * One audit row for a call the judge never saw — the 「自动审批」 half of the
	 * audit page. Best-effort by design: losing a row is better than failing the
	 * command the row was about, so a storage error is swallowed.
	 */
	private recordUnjudged(input: {
		tool: string;
		command: string;
		cwd: string | null;
		approval: SentinelGateApproval;
		decision?: SentinelGateDecisionKind;
		reason?: string;
		context: Pick<BashGateContext, "label" | "projectId" | "projectName" | "sessionId">;
	}): void {
		try {
			this.gateStore.record({
				at: Date.now(),
				latencyMs: 0,
				projectId: input.context.projectId,
				projectName: input.context.projectName,
				sessionId: input.context.sessionId(),
				source: input.context.label(),
				tool: input.tool,
				command: input.command,
				cwd: input.cwd,
				approval: input.approval,
				decision: input.decision ?? "allow",
				...(input.reason ? { reason: input.reason } : {}),
			});
		} catch {
			// The audit trail must not be able to break a run.
		}
	}

	/** Bash tool whose every command passes the gate the session's mode selects. */
	private createGatedBash(cwd: string, operations: BashOperations, context: BashGateContext) {
		const gatedOps: BashOperations = {
			exec: (command, commandCwd, options) => {
				const mode = context.modeOf();
				const workCwd = containerWorkPath(commandCwd, context.hostWorkDir);
				// The three branches below are the only place a bash call can be let
				// through without the judge, so they are also where 「自动审批」 gets
				// its rows. The `ai` branch records inside `gatekeeper.guard`.
				if (mode === "auto") {
					this.recordUnjudged({ tool: "bash", command, cwd: workCwd, approval: "auto", context });
					return operations.exec(command, commandCwd, options);
				}
				if (mode === "review") {
					// Prefix-allowed commands skip the queue; everything else waits for a decision.
					if (this.approvals.isAutoAllowed(command, context.projectId)) {
						this.recordUnjudged({ tool: "bash", command, cwd: workCwd, approval: "auto", context });
						return operations.exec(command, commandCwd, options);
					}
					return this.approvals
						.request(command, commandCwd, options?.signal, context.label(), context.projectId)
						.then((outcome) => {
							// Recorded after the operator answered: before that there is no
							// verdict to write down, and a row guessed now would be a lie
							// for every rejected command.
							this.recordUnjudged({
								tool: "bash",
								command: outcome.command ?? command,
								cwd: workCwd,
								approval: "human",
								...(outcome.approved
									? {}
									: { decision: "block" as const, reason: outcome.reason ?? t("已拒绝") }),
								context,
							});
							return outcome.approved && outcome.command !== undefined
								? operations.exec(outcome.command, commandCwd, options)
								: Promise.reject(new Error(`Command not executed: ${outcome.reason ?? "rejected"}`));
						});
				}
				// ai: the operator's prefix allow-list does not apply. Every command is
				// judged, so "this prefix is fine" can never widen the judge's answer.
				return this.gatekeeper
					.guard({
						command,
						cwd: workCwd,
						source: context.label(),
						projectId: context.projectId,
						projectName: context.projectName,
						sessionId: context.sessionId(),
						...(options?.signal ? { signal: options.signal } : {}),
					})
					.then((outcome) => {
						// A judgment that never arrived is allowed through: an unattended run
						// must not stall because the judge endpoint is down. The audit page and
						// the console banner are what make that visible.
						if (outcome.kind === "allow" || outcome.kind === "failed") {
							return operations.exec(command, commandCwd, options);
						}
						return Promise.reject(
							new Error(outcome.kind === "block" ? outcome.message : "Command not executed: aborted"),
						);
					});
			},
		};
		return createBashTool(cwd, { operations: gatedOps });
	}

	private requireContainer(): string {
		if (!this.activeContainer) throw new Error(t("没有可用的项目容器，请先创建或选择一个项目"));
		return this.activeContainer;
	}

	/**
	 * The registered project a session belongs to, resolved from the directory the
	 * session manager reports. Sessions are created under their project's work
	 * directory, so this binds a reopened conversation to its project without a
	 * new session-file entry; a project that was deleted resolves to undefined and
	 * its sessions lose hub attribution instead of borrowing another project's.
	 */
	private projectOfWorkDir(cwd: string): { id: string; name: string } | undefined {
		return resolveSessionProject(listProjects(this.agentDir).projects, cwd);
	}

	/**
	 * The hub tools one session may mount. A disabled switch is left out here and
	 * named in `excludeTools` as well, so neither tool_search nor a restored
	 * transcript can bring the tool back.
	 *
	 * The project is captured when the session is created, not read from the live
	 * field: switching projects keeps the previous sessions running in the
	 * background, and a finding submitted by one of those must stay with the
	 * project it was found in.
	 */
	private createVulnTools(options: {
		project: { id: string; name: string } | undefined;
		permissions: SentinelPermissionSet;
		getSessionId: () => string | undefined;
		getSessionName: () => string | undefined;
		getEngineRef?: () => { engineId: string; taskId: string } | undefined;
		getSource: () => string;
		/** Host project work directory, mapped to /work inside the container. */
		workDir: string;
		/** A record was created, so a running goal can count it as its own finding. */
		onSubmit: () => void;
	}): ToolDefinition[] {
		if (!options.permissions.vuln_submit && !options.permissions.vuln_read) return [];
		const project = options.project;
		const tools = createVulnerabilityTools({
			store: this.vulnerabilities,
			getProject: () => options.project,
			getSessionId: options.getSessionId,
			getSessionName: options.getSessionName,
			...(options.getEngineRef ? { getEngineRef: options.getEngineRef } : {}),
			getSource: options.getSource,
			getWorkDir: () => options.workDir,
			...(options.permissions.asset_library_write && project
				? {
						resolveAsset: (ref: string) => {
							const asset = this.assetLibrary.find(project.id, ref);
							return asset ? { id: asset.id, label: asset.label } : undefined;
						},
						linkAsset: (assetId: string, vuln: SentinelVulnerability) => {
							this.assetLibrary.appendEntry(assetId, {
								author: "agent",
								source: vuln.source,
								outcome: "vulnerable",
								method: "vuln_submit",
								text: `提交漏洞 ${vuln.label}：${vuln.title}`,
								vulnLabel: vuln.label,
							});
							this.hooks.onAssetChange();
						},
					}
				: {}),
			onHighSeverity: (vuln) => this.notifyHighSeverity(vuln),
			onChange: () => this.hooks.onVulnChange(),
			onSubmit: (vuln) => {
				options.onSubmit();
				// A fresh submission queues for the reviewer LLM (hub layer; the main
				// agent never waits for or sees the calibration) unless the operator
				// turned automatic review off, in which case it is marked as not
				// reviewed so the hub does not show it as queued forever.
				if (readModelLibrary(this.agentDir).reviewerAuto) {
					this.hooks.onVulnSubmitted(vuln.id);
				} else {
					this.vulnerabilities.skipReview(vuln.id);
				}
			},
		});
		return tools.filter((tool) =>
			tool.name === "vuln_submit" ? options.permissions.vuln_submit : options.permissions.vuln_read,
		);
	}

	/**
	 * Inventory tools for one session. The factory applies the permission filter;
	 * the project is captured at session creation so a later project switch does
	 * not move a background session's reports into another project's ledger.
	 */
	private createAssetTools(options: {
		project: { id: string; name: string } | undefined;
		permissions: SentinelPermissionSet;
		getSessionId: () => string | undefined;
		getSessionName: () => string | undefined;
		getEngineRef?: () => { engineId: string; taskId: string } | undefined;
		getSource: () => string;
	}): ToolDefinition[] {
		if (!options.permissions.asset_library_write && !options.permissions.asset_library_read) return [];
		const project = options.project;
		return createAssetLibraryTools({
			store: this.assetLibrary,
			getProject: () => options.project,
			permissions: options.permissions,
			getSessionId: options.getSessionId,
			getSessionName: options.getSessionName,
			...(options.getEngineRef ? { getEngineRef: options.getEngineRef } : {}),
			getSource: options.getSource,
			...(options.permissions.vuln_read && project
				? { listVulnsByAsset: (assetId: string) => this.vulnerabilities.listByAsset(project.id, assetId) }
				: {}),
			onChange: () => this.hooks.onAssetChange(),
		});
	}

	/**
	 * Push a critical/high finding the moment it is submitted. The run-end report
	 * still arrives later; this exists because a serious finding should not wait
	 * for a run that may take another hour.
	 */
	private notifyHighSeverity(vuln: SentinelVulnerability): void {
		const config = readNotifyConfig(this.agentDir);
		if (!hasEnabledNotifyChannel(config) || !config.kinds.vulns) return;
		// One push per record. A high finding is pushed the moment it is
		// submitted; the reviewer's calibration pushes again only when it raised
		// a record the submission did not already push, instead of confirming
		// every submitted high with a second, identical notification.
		if (this.notifiedVulns.has(vuln.id)) return;
		this.notifiedVulns.add(vuln.id);
		// The record's own project, not the one on screen: a finding submitted by a
		// background session must not be announced under another project's name.
		const report = buildVulnNotification(vuln, vuln.projectName, config.summaryLimit);
		void sendNotifications(config, report.title, report.markdown).then((result) => {
			this.notifyStatus = { ...result, subject: report.title };
			this.hooks.onNotifyStatus(this.notifyStatus);
		});
	}

	/**
	 * Read the goal back from the session file. A goal that was active when the
	 * session was (re)built has no run behind it any more — the console restarted,
	 * or the session was recreated after a config change — so it comes back paused
	 * instead of pretending to be running.
	 */
	private restoreGoal(managed: ManagedSession): ManagedGoal | undefined {
		const goal = readGoalState(managed.manager.getBranch());
		if (!goal) return undefined;
		const managedGoal: ManagedGoal = {
			goal,
			roundUsageStart: usageOf(managed.session.getSessionStats()),
			roundToolCalls: 0,
			stutterStreak: 0,
			submitted: goal.submitted,
		};
		if (goal.status === "active") {
			managedGoal.goal = pauseGoal(
				goal,
				"interrupted",
				t("控制台重启或会话重建，目标已暂停；点「继续」恢复自动续跑"),
				Date.now(),
			);
			this.persistGoal(managed, managedGoal.goal);
			this.notifyGoal(managed, managedGoal);
		}
		return managedGoal;
	}

	/** The goal state is a session entry, so it travels with the conversation. */
	private persistGoal(managed: ManagedSession, goal: SentinelGoal | null): void {
		managed.manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, goal);
	}

	/**
	 * What the goal tools may do to the goal of this session. The tools validate
	 * their own arguments; every accepted change lands here, so persistence, the
	 * notification, and the console refresh happen in exactly one place.
	 */
	private createGoalPort(managed: ManagedSession): GoalPort {
		return {
			current: () => managed.goal?.goal,
			submitted: () => managed.goal?.submitted ?? 0,
			progress: (progress) => {
				const managedGoal = managed.goal;
				if (!managedGoal) return;
				managedGoal.goal = recordRoundProgress(managedGoal.goal, progress, Date.now());
				this.persistGoal(managed, managedGoal.goal);
				this.hooks.onStateChange();
			},
			complete: (completion) => {
				const managedGoal = managed.goal;
				if (!managedGoal) return;
				managedGoal.goal = completeGoal(managedGoal.goal, completion);
				this.persistGoal(managed, managedGoal.goal);
				this.notifyGoal(managed, managedGoal);
				this.hooks.onStateChange();
			},
			blocked: (reason, evidence) => {
				const managedGoal = managed.goal;
				if (!managedGoal) return { streak: 0, accepted: false };
				const at = Date.now();
				const result = recordBlocker(managedGoal.goal, reason, at);
				managedGoal.goal = result.accepted
					? blockGoal(result.goal, reason, evidence, result.streak, at)
					: result.goal;
				this.persistGoal(managed, managedGoal.goal);
				if (result.accepted) this.notifyGoal(managed, managedGoal);
				this.hooks.onStateChange();
				return { streak: result.streak, accepted: result.accepted };
			},
		};
	}

	// =========================================================================
	// Business modeling (业务建模)
	// =========================================================================

	/**
	 * What the two modeling tools may do to the run of this session. The tools
	 * validate their own arguments; every accepted change lands here, so the
	 * record, the console refresh and the transcript marker happen in one place.
	 */
	private createModelingPort(managed: ManagedSession): ModelingPort {
		return {
			current: () =>
				managed.modeling ? { runId: managed.modeling.runId, target: managed.modeling.target } : undefined,
			ensureRun: () => this.ensureModelingRun(managed),
			submit: (input) => this.submitApiModel(managed, input),
			done: (summary) => {
				// Not awaited: the tool call returns while the turn is still running, and
				// closing the run mid-turn is exactly what the SDK expects (the new
				// loadout takes effect on the next turn).
				void this.finishModeling(managed, "done", summary);
			},
		};
	}

	/**
	 * The run in force for this session, opening one when the model is the one
	 * starting it (the operator asked for modeling in the conversation instead of
	 * pressing 业务建模). Record, branch entry and console refresh are the same as
	 * the button's; only the briefing is skipped, because the tool descriptions
	 * already said what to produce. No message is injected, so this cannot rebuild
	 * the prompt in the middle of the turn that is calling the tool.
	 */
	private ensureModelingRun(managed: ManagedSession): { runId: string; target: string } {
		const existing = managed.modeling;
		if (existing) return { runId: existing.runId, target: existing.target };
		const sessionFile = managed.manager.getSessionFile();
		const record = this.apiModels.beginRun({
			projectId: managed.projectId,
			sessionId: managed.manager.getSessionId(),
			sessionPath: sessionFile ? resolveFsPath(sessionFile) : null,
			title: managed.manager.getSessionName() ?? undefined,
		});
		const run: ModelingRun = { runId: record.id, target: "", startedAt: Date.now() };
		managed.modeling = run;
		managed.manager.appendCustomEntry(MODELING_STATE_CUSTOM_TYPE, { ...run });
		this.applyModelingTools(managed);
		this.hooks.onApiModelChange();
		this.hooks.onStateChange();
		return { runId: run.runId, target: run.target };
	}

	/** Store one submission and report the counters back to the tool. */
	private submitApiModel(managed: ManagedSession, input: ApiModelSubmitInput): ModelingSubmitOutcome {
		const run = managed.modeling;
		if (!run) return { ok: false, errors: ["当前会话没有进行中的业务建模。"] };
		const result = this.apiModels.submit(run.runId, input);
		const record = result.model;
		if (!record) return { ok: false, errors: result.errors ?? ["提交失败。"] };
		// The target is whatever the model named on its first submission; the page
		// and the closing marker read it from there.
		if (!run.target && record.target) run.target = record.target;
		this.hooks.onApiModelChange();
		this.hooks.onStateChange();
		return {
			ok: true,
			pathCount: record.pathCount,
			operationCount: record.operationCount,
			entityCount: record.entities.length,
			// Problems that did not refuse the document (an unnamed entity) come back
			// as warnings: the endpoints are stored, the model can resubmit the list.
			warnings: result.errors ?? [],
		};
	}

	/**
	 * Bring the modeling tools of one session in line with its state: the two run
	 * tools are always in the set (the model has to know modeling exists for the
	 * operator to be able to ask for it in chat), and the read tool follows the
	 * attached records. The SDK is only called when the set actually changes, which
	 * keeps a normal session's system prompt from being rebuilt for nothing.
	 */
	private applyModelingTools(managed: ManagedSession): void {
		if (managed.taskSession) return;
		const active = managed.session.getActiveToolNames();
		const wanted = modelingToolLoadout(active, managed.modelingAttach !== undefined);
		const changed = wanted.length !== active.length || wanted.some((name, index) => name !== active[index]);
		if (changed) managed.session.setActiveToolsByName(wanted);
	}

	/** The read-only tool may read exactly the records attached to this session. */
	private createModelingAttachPort(managed: ManagedSession): ModelingAttachPort {
		return {
			attached: () => {
				const attach = managed.modelingAttach;
				if (!attach) return [];
				return this.apiModels.getMany(attach.ids).map((model) => ({ id: model.id, title: model.title }));
			},
			read: (id) => {
				const attach = managed.modelingAttach;
				if (!attach || !attach.ids.includes(id)) return undefined;
				const model = this.apiModels.get(id);
				if (!model) return undefined;
				return { title: model.title, document: model.openapi, entities: model.entities };
			},
		};
	}

	/** The records attached to one session, in attach order; missing ones are skipped. */
	private attachedRecordsOf(managed: ManagedSession): SentinelApiModel[] {
		const attach = managed.modelingAttach;
		return attach ? this.apiModels.getMany(attach.ids) : [];
	}

	/**
	 * Attach records to a fresh conversation and inject their catalog as one
	 * foldable row before the operator's first message runs. One-shot: the picker
	 * does not offer this again on this conversation; the records stay attached
	 * (and `api_model_read` mounted) until the operator removes them.
	 */
	private async attachModelingRecords(managed: ManagedSession, ids: string[]): Promise<void> {
		// Requested order wins, unknown or duplicated ids are collapsed.
		const models = this.apiModels.getMany(ids);
		const ordered = ids.flatMap((id) => models.filter((model) => model.id === id));
		if (ordered.length === 0) return;
		managed.modelingAttach = { ids: [...new Set(ordered.map((model) => model.id))], at: Date.now() };
		managed.manager.appendCustomEntry(MODELING_ATTACH_CUSTOM_TYPE, { ...managed.modelingAttach });
		this.applyModelingTools(managed);
		const catalog = buildModelingCatalog(
			ordered.map((model) => ({
				id: model.id,
				title: model.title,
				target: model.target,
				pathCount: model.pathCount,
				operationCount: model.operationCount,
				endpoints: endpointsOf(model.openapi),
				entities: model.entities,
			})),
		);
		this.hooks.onStateChange();
		try {
			await managed.session.sendCustomMessage(
				{
					customType: MODELING_ATTACH_MESSAGE_CUSTOM_TYPE,
					content: `${buildModelingAttachMessage(ordered.map((model) => model.title))}\n\n${catalog}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		} catch {
			// The records are attached and the tool mounted; a marker that could not
			// be written does not undo that.
		}
	}

	/** Remove the attachment at the operator's request; the read tool goes with it. */
	async detachModeling(): Promise<void> {
		const active = this.active;
		if (!active) throw new Error(t("会话尚未就绪，请重新选择项目"));
		if (!active.modelingAttach) throw new Error(t("当前会话没有带入业务建模数据"));
		if (active.session.isStreaming) throw new Error(t("Agent 正在运行，请先中止再移除"));
		active.modelingAttach = undefined;
		active.manager.appendCustomEntry(MODELING_ATTACH_CUSTOM_TYPE, null);
		this.applyModelingTools(active);
		this.hooks.onStateChange();
		try {
			await active.session.sendCustomMessage(
				{
					customType: MODELING_ATTACH_MESSAGE_CUSTOM_TYPE,
					content: "【业务建模 · 已移除带入数据】带入的建模记录已从本会话移除，api_model_read 已摘除。",
					display: true,
				},
				{ triggerTurn: false },
			);
		} catch {
			// The state is cleared either way.
		}
	}

	/** The attached records as the snapshot reports them, for the composer's state. */
	private modelingAttachedView(managed: ManagedSession | undefined): Array<{ id: string; title: string }> {
		if (!managed) return [];
		return this.attachedRecordsOf(managed).map((model) => ({ id: model.id, title: model.title }));
	}

	/**
	 * Start business modeling in the viewed conversation.
	 *
	 * The tools are already declared (they always are), so what this adds is the
	 * run: it records the run on the branch (a restart or a permission rebuild
	 * resumes it) and injects the briefing as a visible row of its own. The agent
	 * then works in the conversation it already has — same model, same
	 * permissions, same command gate.
	 */
	async startModeling(): Promise<void> {
		const active = this.active;
		if (!active) throw new Error(t("会话尚未就绪，请重新选择项目"));
		if (active.taskSession) throw new Error(t("工程任务的会话不能做业务建模"));
		if (active.session.isStreaming) throw new Error(t("Agent 正在运行，请先中止或等本轮结束再开始业务建模"));
		if (active.modeling) throw new Error(t("当前会话已经在业务建模中"));
		const sessionFile = active.manager.getSessionFile();
		const record = this.apiModels.beginRun({
			projectId: active.projectId,
			sessionId: active.manager.getSessionId(),
			sessionPath: sessionFile ? resolveFsPath(sessionFile) : null,
			title: active.manager.getSessionName() ?? undefined,
		});
		const run: ModelingRun = { runId: record.id, target: "", startedAt: Date.now() };
		active.modeling = run;
		// The entry is what makes the run survive a rebuild or a restart; the record
		// itself lives in the hub database.
		active.manager.appendCustomEntry(MODELING_STATE_CUSTOM_TYPE, { ...run });
		this.applyModelingTools(active);
		this.hooks.onApiModelChange();
		this.hooks.onStateChange();
		// Not awaited: with `triggerTurn` the promise settles when the whole turn is
		// over, and the WebSocket handler has to return while the agent works.
		void active.session
			.sendCustomMessage(
				{
					customType: MODELING_MESSAGE_CUSTOM_TYPE,
					content: buildModelingBrief(
						run.target,
						active.projectName,
						this.attachedRecordsOf(active).map((model) => ({ title: model.title, pathCount: model.pathCount })),
					),
					display: true,
				},
				{ triggerTurn: true },
			)
			.catch((error: unknown) => {
				void this.finishModeling(
					active,
					"failed",
					t("建模指令注入失败：{error}", { error: error instanceof Error ? error.message : String(error) }),
				);
			});
	}

	/**
	 * End the run of the viewed session at the operator's request. Refused while
	 * the agent runs: the rebuild would take the tools away mid-turn, and the
	 * operator has 中止 for that.
	 */
	async endModeling(): Promise<void> {
		const active = this.active;
		if (!active) throw new Error(t("会话尚未就绪，请重新选择项目"));
		if (!active.modeling) throw new Error(t("当前会话没有进行中的业务建模"));
		if (active.session.isStreaming) throw new Error(t("Agent 正在运行，请先中止再结束业务建模"));
		await this.finishModeling(active, "manual");
	}

	/**
	 * Close a run: drop the tools, clear the branch entry, close the record and
	 * leave a closing row in the transcript. Idempotent — the agent's
	 * `api_model_done` and the operator's button race by design, and the second
	 * caller finds nothing to do.
	 */
	private async finishModeling(
		managed: ManagedSession,
		status: Exclude<SentinelApiModelStatus, "modeling">,
		note?: string,
	): Promise<void> {
		const run = managed.modeling;
		if (!run) return;
		managed.modeling = undefined;
		managed.manager.appendCustomEntry(MODELING_STATE_CUSTOM_TYPE, null);
		this.applyModelingTools(managed);
		const record = this.apiModels.finish(run.runId, status, {
			...(note ? { note } : {}),
			...(status === "failed" && note ? { error: note } : {}),
		});
		this.hooks.onApiModelChange();
		this.hooks.onStateChange();
		const text = buildModelingEndMessage({
			status,
			pathCount: record?.pathCount ?? 0,
			operationCount: record?.operationCount ?? 0,
			entityCount: record?.entities.length ?? 0,
			...(note ? { note } : {}),
		});
		try {
			await managed.session.sendCustomMessage(
				{ customType: MODELING_MESSAGE_CUSTOM_TYPE, content: text, display: true },
				{ triggerTurn: false },
			);
		} catch {
			// The record is closed and the tools are gone; a marker that could not be
			// written is not worth failing the caller over.
		}
	}

	/** The run in force for the viewed session, as the snapshot reports it. */
	private modelingView(managed: ManagedSession | undefined): SentinelModelingState | null {
		const run = managed?.modeling;
		if (!run) return null;
		const record = this.apiModels.get(run.runId);
		if (!record) return null;
		return modelingState(run, {
			title: record.title,
			pathCount: record.pathCount,
			operationCount: record.operationCount,
			entityCount: record.entities.length,
		});
	}

	/** Every modeling run, newest first; the page filters by project and status. */
	listApiModels(filters: SentinelApiModelFilters = {}): SentinelApiModelSummary[] {
		return this.apiModels.list(filters);
	}

	/** One run with its audit trail. */
	getApiModel(id: string): { model: SentinelApiModel; events: SentinelApiModelEvent[] } | undefined {
		const model = this.apiModels.get(id);
		return model ? { model, events: this.apiModels.events(id) } : undefined;
	}

	/** The document as a file, in the requested format. */
	exportApiModel(id: string, format: "json" | "yaml"): { filename: string; text: string } | undefined {
		const model = this.apiModels.get(id);
		return model ? buildApiModelExport(model, format) : undefined;
	}

	/**
	 * Close a record from the page. When its session is loaded the run is ended
	 * through the normal path (tools off, marker written); otherwise the record is
	 * closed on its own, which is the way out of a run whose console went away.
	 */
	finishApiModel(id: string, status: Exclude<SentinelApiModelStatus, "modeling">, note?: string): boolean {
		for (const managed of this.sessions.values()) {
			if (managed.modeling?.runId === id) {
				void this.finishModeling(managed, status, note);
				return true;
			}
		}
		const record = this.apiModels.finish(id, status, {
			...(note ? { note } : {}),
			...(status === "failed" && note ? { error: note } : {}),
		});
		if (record) this.hooks.onApiModelChange();
		return record !== undefined;
	}

	/**
	 * Delete one run. Deleting the live record also ends the run: leaving the
	 * tools mounted would let the agent submit into a record that is gone. A
	 * deleted record an older conversation still carries as attached simply
	 * disappears from that conversation's reads.
	 */
	deleteApiModel(id: string): boolean {
		for (const managed of this.sessions.values()) {
			if (managed.modeling?.runId === id) void this.finishModeling(managed, "manual", t("记录已被操作员删除"));
			if (managed.modelingAttach?.ids.includes(id)) {
				managed.modelingAttach = {
					ids: managed.modelingAttach.ids.filter((attached) => attached !== id),
					at: managed.modelingAttach.at,
				};
				if (managed.modelingAttach.ids.length === 0) {
					managed.modelingAttach = undefined;
					managed.manager.appendCustomEntry(MODELING_ATTACH_CUSTOM_TYPE, null);
					this.applyModelingTools(managed);
				}
			}
		}
		const ok = this.apiModels.delete(id);
		if (ok) this.hooks.onApiModelChange();
		return ok;
	}

	/** Runs a removed project takes with it. */
	purgeProjectApiModels(projectId: string): number {
		return this.apiModels.purgeProject(projectId);
	}

	/** HTTP capture evidence of a removed project. */
	purgeProjectCaptures(projectId: string): number {
		return this.captures.purgeProject(projectId);
	}

	// =========================================================================
	// Asset mapping (资产测绘插件)
	// =========================================================================

	/** The console's asset configuration. Keys are reported as a has-key flag only. */
	getAssetConfig(): SentinelAssetConfigView {
		return assetConfigView(this.agentDir);
	}

	/** Asset-mapping queries a removed project takes with it. */
	purgeProjectAssetQueries(projectId: string): number {
		return this.assets.purgeProject(projectId);
	}

	/** Web-search queries a removed project takes with it. */
	purgeProjectWebSearch(projectId: string): number {
		return this.webSearchLog.purgeProject(projectId);
	}

	// =========================================================================
	// Web search (Tavily 号池插件)
	// =========================================================================

	/** The console's web-search pool. Keys are reported as has-key flags only. */
	getWebSearchConfig(): SentinelWebSearchConfigView {
		const view = webSearchConfigView(this.agentDir);
		// Merge the usage cache into the view so the panel can draw meters without
		// the browser calling Tavily itself; a stale (never probed) key has none.
		return {
			...view,
			keys: view.keys.map((key) => {
				const cached = this.webUsageCache.get(key.id);
				if (!cached || cached.remaining < 0) return key;
				return {
					...key,
					usage: {
						remaining: cached.remaining === Number.POSITIVE_INFINITY ? null : cached.remaining,
						limit: cached.limit,
					},
				};
			}),
		};
	}

	/** Add or update one pool key, probe it, and rebuild so the tool set follows. */
	async saveWebSearchKey(input: SentinelWebSearchKeyInput): Promise<SentinelWebSearchConfigView> {
		this.assertNoRunningSession(t("Web 搜索配置"));
		const config = saveWebSearchKey(this.agentDir, input);
		const entry = config.keys.find((candidate) => candidate.id === input.id);
		const target = entry ?? config.keys[config.keys.length - 1];
		if (target?.enabled && target.key) {
			const result = await this.probeWebSearchKey(target.id);
			if (!result.ok) {
				// A key that failed its save-time probe is disabled again: mounting an
				// unusable key would make every call fail until someone noticed.
				saveWebSearchKey(this.agentDir, { id: target.id, label: target.label, key: null, enabled: false });
			}
		}
		this.webUsageCache.clear();
		await this.rebuildSessions();
		return this.getWebSearchConfig();
	}

	/** Remove one pool key and rebuild. */
	async deleteWebSearchKey(id: string): Promise<SentinelWebSearchConfigView> {
		this.assertNoRunningSession(t("Web 搜索配置"));
		deleteStoredWebSearchKey(this.agentDir, id);
		this.webUsageCache.clear();
		await this.rebuildSessions();
		return this.getWebSearchConfig();
	}

	/** Change the per-session search budget and rebuild. */
	async setWebSearchQueryLimit(limit: number): Promise<SentinelWebSearchConfigView> {
		this.assertNoRunningSession(t("Web 搜索配置"));
		writeWebSearchQueryLimit(this.agentDir, limit);
		await this.rebuildSessions();
		return this.getWebSearchConfig();
	}

	/**
	 * Probe one pool key without saving; `key` overrides the stored secret so a
	 * draft can be checked first. The outcome is recorded on the key.
	 */
	async testWebSearchKey(id: string | undefined, key?: string): Promise<SentinelTestResult> {
		const config = readWebSearchConfig(this.agentDir);
		const entry = id ? config.keys.find((candidate) => candidate.id === id) : undefined;
		const effective = key?.trim() ? key.trim() : entry?.key;
		if (!effective) return { ok: false, message: t("未提供 API Key") };
		const label = entry?.label ?? t("草稿 Key");
		try {
			const probe = await probeTavilyKey({ key: effective });
			if (entry && !key?.trim()) {
				const usage = probe.usage;
				recordWebSearchKeyStatus(this.agentDir, entry.id, {
					at: Date.now(),
					ok: true,
					...(usage
						? {
								quota:
									usage.planLimit === null
										? t("套餐 {plan} · 已用 {used}", { plan: usage.plan, used: usage.planUsed })
										: t("套餐 {plan} · 已用 {used} / {limit}", {
												plan: usage.plan,
												used: usage.planUsed,
												limit: usage.planLimit,
											}),
							}
						: {}),
				});
			}
			const before = this.webSearchPoolSignature();
			const left = probe.usage ? usageRemaining(probe.usage) : null;
			this.webUsageCache.set(entry?.id ?? "draft", {
				at: Date.now(),
				// Infinity reads as unlimited in the pick; the cache never stores null.
				remaining: left === null ? Number.POSITIVE_INFINITY : left,
				limit: probe.usage?.planLimit ?? probe.usage?.keyLimit ?? null,
			});
			if (this.webSearchPoolSignature() !== before) {
				const running = [...this.sessions.values()].some((managed) => managed.session.isStreaming);
				if (!running) await this.rebuildSessions();
			}
			return { ok: true, message: probe.message };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (entry && !key?.trim()) {
				recordWebSearchKeyStatus(this.agentDir, entry.id, { at: Date.now(), ok: false, error: message });
			}
			return { ok: false, message: `${label}：${message}` };
		}
	}

	/** Probe one stored key and record the outcome. */
	private async probeWebSearchKey(id: string): Promise<SentinelTestResult> {
		return this.testWebSearchKey(id);
	}

	/** Which stored keys currently serve the pool; a change means a rebuild. */
	private webSearchPoolSignature(): string {
		return usablePoolKeys(this.agentDir)
			.map((entry) => entry.id)
			.join(",");
	}

	/**
	 * The tools' view of the key pool. Usages are cached for 60 seconds, so a
	 * burst of searches does not spend a call on /usage every time; the pick is
	 * serialized, so concurrent searches cannot grab the same "most remaining"
	 * key simultaneously.
	 */
	private createWebSearchToolContext(managed: ManagedSession, source: () => string): WebSearchToolContext {
		return {
			pickKey: async (exclude: string[]) => {
				await this.refreshWebUsageCache();
				const candidates = usablePoolKeys(this.agentDir).filter((entry) => !exclude.includes(entry.id));
				if (candidates.length === 0) {
					return exclude.length > 0
						? t("号池中的 Key 额度已全部耗尽")
						: t("没有可用的 Tavily Key：先在「设置 - Web 搜索」添加并验证");
				}
				let best: { id: string; label: string; key: string; remaining: number } | undefined;
				for (const entry of candidates) {
					const cached = this.webUsageCache.get(entry.id);
					const remaining = cached?.remaining ?? Number.POSITIVE_INFINITY;
					if (!best || (remaining > best.remaining && best.remaining !== Number.POSITIVE_INFINITY)) {
						best = { id: entry.id, label: entry.label, key: entry.key, remaining };
					}
				}
				if (!best) return t("没有可用的 Tavily Key");
				return { id: best.id, label: best.label, key: best.key };
			},
			remaining: () => {
				const limit = readWebSearchConfig(this.agentDir).sessionQueryLimit;
				return limit === 0 ? null : Math.max(0, limit - managed.webQueries);
			},
			consume: () => {
				const limit = readWebSearchConfig(this.agentDir).sessionQueryLimit;
				if (limit !== 0 && managed.webQueries >= limit) return false;
				managed.webQueries += 1;
				return true;
			},
			saveEvidence: (name, raw) => writeWebSearchEvidence(managed.cwd, name, raw),
			report: (report) => this.recordWebSearchQuery(managed, source(), report),
		};
	}

	/** Re-read any usage entry older than 60 seconds, newest data first as pick input. */
	private async refreshWebUsageCache(): Promise<void> {
		const now = Date.now();
		const stale = usablePoolKeys(this.agentDir).filter(
			(entry) => !this.webUsageCache.has(entry.id) || now - (this.webUsageCache.get(entry.id)?.at ?? 0) > 60_000,
		);
		if (stale.length === 0) return;
		await Promise.all(
			stale.map(async (entry) => {
				try {
					const usage = await tavilyUsage({ key: entry.key });
					const left = usageRemaining(usage);
					this.webUsageCache.set(entry.id, {
						at: Date.now(),
						remaining: left === null ? Number.POSITIVE_INFINITY : left,
						limit: usage.planLimit ?? usage.keyLimit,
					});
					recordWebSearchKeyStatus(this.agentDir, entry.id, {
						at: Date.now(),
						ok: true,
						quota:
							usage.planLimit === null
								? t("套餐 {plan} · 已用 {used}", { plan: usage.plan, used: usage.planUsed })
								: t("套餐 {plan} · 已用 {used} / {limit}", {
										plan: usage.plan,
										used: usage.planUsed,
										limit: usage.planLimit,
									}),
					});
				} catch (error) {
					// A key that stopped answering drops out of the pick until its status
					// is refreshed by hand (测试) — a dead key must not be chosen.
					this.webUsageCache.set(entry.id, { at: Date.now(), remaining: -1, limit: null });
					recordWebSearchKeyStatus(this.agentDir, entry.id, {
						at: Date.now(),
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
	}

	/**
	 * Log one web-search call. Best-effort, like the asset log: the call already
	 * happened, a bookkeeping failure must not turn it into a failed tool call.
	 */
	private recordWebSearchQuery(managed: ManagedSession, source: string, report: WebSearchQueryReport): void {
		void source;
		const projectId = managed.projectId;
		if (!projectId) return;
		const sessionId = managed.manager.getSessionId();
		try {
			this.webSearchLog.save({
				projectId,
				kind: report.kind,
				query: report.query,
				ok: report.ok,
				latencyMs: report.latencyMs,
				count: report.count,
				...(report.error ? { error: report.error } : {}),
				...(report.keyId ? { keyId: report.keyId } : {}),
				...(sessionId ? { sessionId } : {}),
				source,
				...(report.evidencePath ? { evidencePath: report.evidencePath } : {}),
				records: report.records,
			});
		} catch {
			// The query happened and the agent saw the answer.
		}
	}

	/**
	 * Save one platform, probe it, and rebuild the sessions so the tool set
	 * matches.
	 *
	 * The probe is what decides whether the platform's tool is handed to the
	 * agent: a key that does not work is recorded as a failure and contributes no
	 * tool, rather than a tool that fails on every call. That is why saving is
	 * one round trip — switch, key and verification all settle here.
	 */
	async saveAssetPlatform(input: SentinelAssetPlatformInput): Promise<SentinelAssetConfigView> {
		this.assertNoRunningSession(t("资产测绘配置"));
		const view = writeAssetPlatform(this.agentDir, input);
		const entry = view.platforms.find((platform) => platform.id === input.id);
		if (entry?.enabled && entry.hasKey) await this.probeAssetPlatform(input.id);
		await this.rebuildSessions();
		return this.getAssetConfig();
	}

	/** Change the per-session query budget and rebuild, so live sessions get it. */
	async setAssetQueryLimit(limit: number): Promise<SentinelAssetConfigView> {
		this.assertNoRunningSession(t("资产测绘配置"));
		writeAssetQueryLimit(this.agentDir, limit);
		await this.rebuildSessions();
		return this.getAssetConfig();
	}

	/**
	 * Probe one platform without saving anything, so a key can be checked before
	 * it is written. `key` overrides the stored one.
	 *
	 * A probe that changes which platforms are usable changes the tool set too,
	 * so the sessions are rebuilt — unless one is running, in which case the
	 * change lands on the next rebuild instead of interrupting work.
	 */
	async testAssetPlatform(
		platform: SentinelAssetPlatform,
		key?: string,
		baseUrl?: string,
	): Promise<SentinelTestResult> {
		const before = usablePlatforms(this.agentDir).join(",");
		const result = await this.probeAssetPlatform(platform, key, baseUrl);
		if (usablePlatforms(this.agentDir).join(",") !== before) {
			const running = [...this.sessions.values()].some((managed) => managed.session.isStreaming);
			if (!running) await this.rebuildSessions();
		}
		return result;
	}

	/**
	 * Probe one platform and record the outcome. A probe that throws is recorded
	 * as a failure: an unreachable platform is exactly what the settings screen
	 * has to show.
	 */
	private async probeAssetPlatform(
		platform: SentinelAssetPlatform,
		key?: string,
		baseUrl?: string,
	): Promise<SentinelTestResult> {
		const entry = readAssetConfig(this.agentDir).platforms[platform];
		const effective = key?.trim() ? key.trim() : entry.key;
		if (!effective) {
			return {
				ok: false,
				message: t("尚未填写 {platform} 的 API Key", { platform: ASSET_PLATFORM_LABELS[platform] }),
			};
		}
		// undefined means "use what is stored"; "" is the explicit official URL,
		// so a test can check a base URL before the operator saves it.
		const effectiveBaseUrl = baseUrl === undefined ? entry.baseUrl : baseUrl;
		try {
			const result = await probeAssetPlatform({
				platform,
				key: effective,
				...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
			});
			recordAssetStatus(this.agentDir, platform, {
				at: Date.now(),
				ok: result.ok,
				...(result.ok ? {} : { error: result.message }),
				...(result.quota ? { quota: result.quota } : {}),
			});
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			recordAssetStatus(this.agentDir, platform, { at: Date.now(), ok: false, error: message });
			return { ok: false, message: t("连接失败：{message}", { message }), detail: message };
		}
	}

	/**
	 * The custom MCP servers as 设置 → MCP shows them.
	 *
	 * These are not tools of their own: the MCP extension turns a connected
	 * server's tools into `mcp__<server>__<tool>` registrations, and the 权限
	 * switch named `mcp` decides whether the extension is loaded at all. This
	 * page decides which servers it has to connect.
	 */
	getMcpServers(): SentinelMcpConfigView {
		return mcpConfigView(this.agentDir);
	}

	/**
	 * Add or replace one server and rebuild, so live sessions connect the new set.
	 *
	 * Saving does not probe. A connection is the extension's job at session start,
	 * and probing here would run the operator's stdio command as a side effect of
	 * pressing 保存 — a command they consented to run, but not at that moment.
	 * 测试连接 is the explicit way to run one.
	 */
	async saveMcpServer(input: SentinelMcpServerInput): Promise<SentinelMcpConfigView> {
		this.assertNoRunningSession(t("MCP 配置"));
		const view = writeMcpServer(this.agentDir, input);
		await this.rebuildSessions();
		return view;
	}

	/** Remove one server and rebuild, so its tools stop being registered. */
	async deleteMcpServer(name: string): Promise<SentinelMcpConfigView> {
		this.assertNoRunningSession(t("MCP 配置"));
		const view = removeMcpServer(this.agentDir, name);
		await this.rebuildSessions();
		return view;
	}

	/**
	 * Flip one server's switch from the permissions page.
	 *
	 * Same file and same field as the MCP page's 启用: the two pages are two views of
	 * one switch, so they cannot disagree. Only `enabled` is written, which is also why
	 * this is not a save: a page that has been open a while holds a stale URL and a stale
	 * token, and writing those back would be a silent overwrite of what the operator
	 * typed on the other page.
	 */
	async setMcpServerEnabled(name: string, enabled: boolean): Promise<SentinelMcpConfigView> {
		this.assertNoRunningSession(t("MCP 配置"));
		updateMcpServerRecord(this.agentDir, name, { enabled });
		await this.rebuildSessions();
		return this.getMcpServers();
	}

	/**
	 * Connect once to one server and report what it offers, without saving anything.
	 *
	 * `draft` probes the form as it stands, which is how a server is checked before
	 * it is written. The outcome of a stored server's probe is recorded, so the page
	 * still shows it after a reload.
	 */
	async testMcpServer(name: string, draft?: SentinelMcpServerInput): Promise<SentinelMcpTestResult> {
		let server: SentinelMcpServerRecord;
		if (draft) {
			const failure = validateMcpServerInput(draft);
			if (failure) return { ok: false, state: "failed", message: failure, tools: [], resources: 0 };
			server = normalizeMcpServer(draft);
		} else {
			const namespace = mcpNamespace(name.trim());
			const stored = readMcpServers(this.agentDir).servers.find((entry) => mcpNamespace(entry.name) === namespace);
			if (!stored) {
				return {
					ok: false,
					state: "failed",
					message: t('未找到 MCP 服务器 "{name}"', { name }),
					tools: [],
					resources: 0,
				};
			}
			server = stored;
		}
		const probe = await probeMcpServer(mcpEntryFor(this.agentDir, server), { cwd: this.cwd });
		if (!draft) {
			try {
				recordMcpStatus(this.agentDir, server.name, {
					at: Date.now(),
					ok: probe.ok,
					...(probe.ok
						? { tools: probe.tools.length, resources: probe.resources }
						: { error: probe.detail ?? probe.message }),
				});
			} catch {
				// The settings screen loses one status line, nothing else.
			}
		}
		return {
			ok: probe.ok,
			state: probe.state,
			message: probe.message,
			...(probe.detail ? { detail: probe.detail } : {}),
			tools: probe.tools,
			resources: probe.resources,
			...(probe.instructions ? { instructions: probe.instructions } : {}),
		};
	}

	/**
	 * The plugin center's data: every host, every installed plugin, and the
	 * problems of hosts that did not answer. Reading this also refreshes the
	 * mount cache that session creation uses, so the next rebuild sees the truth.
	 */
	async getPlugins(): Promise<SentinelPluginsView> {
		return pluginService.listPlugins(this.agentDir);
	}

	async savePluginHost(input: SentinelPluginHostInput): Promise<SentinelPluginsView> {
		pluginService.saveHost(this.agentDir, input);
		return pluginService.listPlugins(this.agentDir);
	}

	/** Removing a host removes its plugins from the next session; it does not touch the host itself. */
	async deletePluginHost(id: string): Promise<SentinelPluginsView> {
		this.assertNoRunningSession(t("插件主机"));
		pluginService.deleteHost(this.agentDir, id);
		await this.rebuildSessions();
		return pluginService.listPlugins(this.agentDir);
	}

	testPluginHost(id: string): Promise<SentinelPluginHostView["status"]> {
		return pluginService.testPluginHost(this.agentDir, id);
	}

	/**
	 * Install or upgrade one plugin. Refused while a session is running: the MCP
	 * extension connects its servers at session start, so the tool set changes by
	 * rebuilding, not by mutating a live connection.
	 */
	async getPluginBuildLog(hostId: string, pluginId: string): Promise<string> {
		return pluginService.pluginBuildLog(this.agentDir, hostId, pluginId);
	}

	async installPlugin(input: pluginService.InstallPluginInput): Promise<SentinelPluginView> {
		this.assertNoRunningSession(t("插件"));
		const plugin = await pluginService.installPlugin(this.agentDir, input);
		await this.rebuildSessions();
		return plugin;
	}

	async uninstallPlugin(hostId: string, pluginId: string, purge: boolean): Promise<SentinelPluginsView> {
		this.assertNoRunningSession(t("插件"));
		await pluginService.uninstallPlugin(this.agentDir, hostId, pluginId, purge);
		await this.rebuildSessions();
		return pluginService.listPlugins(this.agentDir);
	}

	async startPlugin(hostId: string, pluginId: string): Promise<SentinelPluginsView> {
		this.assertNoRunningSession(t("插件"));
		await pluginService.startPlugin(this.agentDir, hostId, pluginId);
		await this.rebuildSessions();
		return pluginService.listPlugins(this.agentDir);
	}

	async stopPlugin(hostId: string, pluginId: string): Promise<SentinelPluginsView> {
		this.assertNoRunningSession(t("插件"));
		await pluginService.stopPlugin(this.agentDir, hostId, pluginId);
		await this.rebuildSessions();
		return pluginService.listPlugins(this.agentDir);
	}

	/** Record that the plugin's frontend was opened; the page itself is static. */
	pluginUiOpen(hostId: string, pluginId: string): void {
		appendPluginAudit(this.agentDir, { action: "ui-open", hostId, pluginId, ok: true });
	}

	/**
	 * One call from a plugin's frontend. The method names are a closed set: the
	 * iframe cannot ask the console to run arbitrary host commands. Every branch
	 * lands on an existing service function, so the same host token, path checks,
	 * and audit trail apply.
	 */
	async pluginUiCall(hostId: string, pluginId: string, method: string, raw: unknown): Promise<unknown> {
		const params = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
		const asText = (value: unknown): string => (typeof value === "string" ? value : "");
		switch (method) {
			case "artifact.list":
				return pluginService.listPluginArtifacts(this.agentDir, hostId, pluginId);
			case "artifact.read": {
				const path = asText(params.path);
				if (!path) throw new Error("artifact.read 需要 path");
				const data = await pluginService.downloadPluginArtifact(this.agentDir, hostId, pluginId, path);
				if (data.length > MAX_UI_ARTIFACT_BYTES) {
					throw new Error(t("单个产物超过 1MB，请在插件页下载"));
				}
				appendPluginAudit(this.agentDir, {
					action: "ui-artifact",
					hostId,
					pluginId,
					ok: true,
					detail: { path, bytes: data.length },
				});
				const encoding = params.encoding === "base64" ? "base64" : "utf8";
				return { path, size: data.length, encoding, data: data.toString(encoding) };
			}
			case "tool.call": {
				const name = asText(params.name);
				const args = (
					params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
						? params.arguments
						: {}
				) as Record<string, unknown>;
				return pluginService.callPluginTool(this.agentDir, hostId, pluginId, name, args);
			}
			case "config.get":
				return pluginService.getPluginValues(this.agentDir, hostId, pluginId);
			case "config.save": {
				const values = (
					params.values && typeof params.values === "object" && !Array.isArray(params.values) ? params.values : {}
				) as Record<string, unknown>;
				const normalized: Record<string, string> = {};
				for (const [key, value] of Object.entries(values)) {
					if (typeof value === "string") normalized[key] = value;
					else if (typeof value === "number" || typeof value === "boolean") normalized[key] = String(value);
				}
				this.assertNoRunningSession(t("插件配置"));
				await pluginService.updatePluginConfig(this.agentDir, hostId, pluginId, normalized);
				await this.rebuildSessions();
				return { ok: true };
			}
			case "storage.get": {
				const key = asText(params.key);
				return pluginService.getPluginUiStorage(this.agentDir, hostId, pluginId, key);
			}
			case "storage.set": {
				const key = asText(params.key);
				const value = asText(params.value);
				await pluginService.setPluginUiStorage(this.agentDir, hostId, pluginId, key, value);
				return { ok: true };
			}
			case "storage.delete": {
				const key = asText(params.key);
				await pluginService.deletePluginUiStorage(this.agentDir, hostId, pluginId, key);
				return { ok: true };
			}
			default:
				throw new Error(`不支持的界面方法 ${method}`);
		}
	}

	getPluginUiFile(hostId: string, pluginId: string, relative: string): Promise<{ contentType: string; data: Buffer }> {
		return pluginService.fetchPluginUiFile(this.agentDir, hostId, pluginId, relative);
	}

	/** Sidebar preference only; it does not touch the container or the mount. */
	async setPluginSidebar(hostId: string, pluginId: string, pinned: boolean): Promise<SentinelPluginsView> {
		pluginService.setPluginSidebarPinned(this.agentDir, hostId, pluginId, pinned);
		return pluginService.listPlugins(this.agentDir);
	}

	/** The console-side switch: off unmounts the tools but leaves the container running. */
	async setPluginEnabled(hostId: string, pluginId: string, enabled: boolean): Promise<SentinelPluginsView> {
		this.assertNoRunningSession(t("插件"));
		pluginService.setPluginEnabled(this.agentDir, hostId, pluginId, enabled);
		await this.rebuildSessions();
		return pluginService.listPlugins(this.agentDir);
	}

	/** Update config values, redeploy, and rebuild so the new env reaches the tools. */
	async setPluginConfig(
		hostId: string,
		pluginId: string,
		values: Record<string, string>,
	): Promise<SentinelPluginsView> {
		this.assertNoRunningSession(t("插件配置"));
		await pluginService.updatePluginConfig(this.agentDir, hostId, pluginId, values);
		await this.rebuildSessions();
		return pluginService.listPlugins(this.agentDir);
	}

	pluginLogs(hostId: string, pluginId: string): Promise<string> {
		return pluginService.pluginLogs(this.agentDir, hostId, pluginId);
	}

	listPluginArtifacts(hostId: string, pluginId: string): Promise<SentinelPluginArtifact[]> {
		return pluginService.listPluginArtifacts(this.agentDir, hostId, pluginId);
	}

	/**
	 * Pull one artifact into `evidence/plugin/<host>/<plugin>/` of the active
	 * project. The stored name keeps the plugin's relative path, with traversal
	 * segments removed, so two runs cannot overwrite each other by accident and
	 * nothing can be written outside the evidence directory.
	 */
	async fetchPluginArtifact(hostId: string, pluginId: string, path: string): Promise<string> {
		const project = this.snapshot().project;
		if (!project) throw new Error(t("请先创建或选择一个项目，再把插件产物落进证据目录"));
		const data = await pluginService.downloadPluginArtifact(this.agentDir, hostId, pluginId, path);
		const safeSegments = path
			.split("/")
			.filter((segment) => segment && segment !== "." && segment !== "..")
			.map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, "_"));
		if (safeSegments.length === 0) throw new Error(t("产物路径为空"));
		const savedTo = join("evidence", "plugin", hostId.replace(/[^A-Za-z0-9._-]/g, "_"), pluginId, ...safeSegments);
		const target = join(this.cwd, savedTo);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, data);
		return savedTo;
	}

	/**
	 * The tools' view of the runtime. The key is read per call rather than
	 * captured, so a key the operator replaces mid-session is used at once; the
	 * budget lives on the session, so a sub-agent spends the same allowance.
	 */
	private createAssetToolContext(managed: ManagedSession, source: () => string): AssetToolContext {
		const budget = (): number => readAssetConfig(this.agentDir).sessionQueryLimit;
		return {
			search: (options) => {
				const baseUrl = readAssetConfig(this.agentDir).platforms[options.platform].baseUrl;
				return searchAssets(baseUrl ? { ...options, baseUrl } : options);
			},
			keyOf: (platform) => readAssetConfig(this.agentDir).platforms[platform].key,
			remaining: () => {
				const limit = budget();
				return limit === 0 ? null : Math.max(0, limit - managed.assetQueries);
			},
			consume: () => {
				const limit = budget();
				if (limit !== 0 && managed.assetQueries >= limit) return false;
				managed.assetQueries += 1;
				return true;
			},
			saveEvidence: (name, raw) => writeAssetEvidence(managed.cwd, name, raw),
			report: (report) => this.recordAssetQuery(managed, source(), report),
		};
	}

	/**
	 * Log one query and refresh the platform's status line. Both writes are
	 * best-effort: a successful search must not become a failed tool call because
	 * a bookkeeping write hit a full disk.
	 */
	private recordAssetQuery(managed: ManagedSession, source: string, report: AssetQueryReport): void {
		try {
			recordAssetStatus(this.agentDir, report.platform, {
				at: Date.now(),
				ok: report.ok,
				...(report.ok ? {} : { error: report.error ?? t("查询失败") }),
				...(report.quota ? { quota: report.quota } : {}),
			});
		} catch {
			// The settings screen loses one status line, nothing else.
		}
		const projectId = managed.projectId;
		if (!projectId) return;
		const sessionId = managed.manager.getSessionId();
		try {
			this.assets.save({
				projectId,
				platform: report.platform,
				query: report.query,
				page: report.page,
				size: report.size,
				total: report.total,
				count: report.count,
				ok: report.ok,
				latencyMs: report.latencyMs,
				...(report.error ? { error: report.error } : {}),
				...(report.quota ? { quota: report.quota } : {}),
				...(sessionId ? { sessionId } : {}),
				source,
				...(report.evidencePath ? { evidencePath: report.evidencePath } : {}),
				records: report.records,
			});
		} catch {
			// Same reasoning: the query happened and the operator saw it.
		}
	}

	/**
	 * A tool-set change rebuilds every console session, so it is refused while a
	 * session is running rather than disposing work in flight.
	 */
	private assertNoRunningSession(what: string): void {
		if ([...this.sessions.values()].some((managed) => managed.session.isStreaming)) {
			throw new Error(t("有会话正在运行，请先中止再修改{what}", { what }));
		}
	}

	/**
	 * Dispose and recreate every console session so a tool-set change takes
	 * effect. Task sessions are skipped: the engine owns their lifecycle, and new
	 * tasks pick up the new switches. The viewed session is recreated last, so the
	 * console stays on it.
	 */
	private async rebuildSessions(): Promise<void> {
		const existing = [...this.sessions.values()].filter((managed) => !managed.taskSession);
		const activeKey = this.activeKey;
		for (const managed of existing) managed.unsubscribe();
		for (const managed of existing) managed.session.dispose();
		for (const managed of existing) this.sessions.delete(managed.key);
		const order = [...existing];
		const viewed = order.findIndex((managed) => managed.key === activeKey);
		if (viewed !== -1) order.push(...order.splice(viewed, 1));
		for (const managed of order) {
			await this.createSessionInto(managed.manager);
		}
		this.hooks.onStateChange();
	}

	// =========================================================================
	// Android devices (Droid 插件)
	// =========================================================================

	/** The gateway is built by the server once the HTTP listener exists. */
	setDroidGateway(gateway: DroidGateway): void {
		this.droidGateway = gateway;
	}

	/** The registry the server's device gateway authenticates against. */
	get droidRegistry(): DroidStore {
		return this.droids;
	}

	/** Everything the device page shows: the active conversation's switch, devices, and tokens. */
	droidState(): {
		enabled: boolean;
		devices: ReturnType<DroidStore["listDevices"]>;
		tokens: ReturnType<DroidStore["listTokens"]>;
	} {
		// The stored row only knows the socket; merge in whether the app still
		// answers, so the page never shows 在线 for a frozen process.
		const devices = this.droids.listDevices().map((device) => {
			const liveness = this.droidGateway?.livenessOf(device.id);
			return { ...device, stale: liveness?.stale ?? false, idleMs: liveness?.idleMs ?? 0 };
		});
		return { enabled: this.active?.droidOn ?? false, devices, tokens: this.droids.listTokens() };
	}

	/** The persisted reverse-listener config; null until the operator enabled it. */
	droidListenConfig(): { host: string; port: number } | null {
		const host = this.droids.getMeta("listenHost");
		const port = this.droids.getMeta("listenPort");
		if (!host || !port) return null;
		return { host, port: Number(port) };
	}

	/** Persist and (re)bind the dedicated reverse-connection listener. */
	async droidSetListen(host: string, port: number): Promise<void> {
		const trimmed = host.trim();
		if (!trimmed) throw new Error(t("监听地址不能为空"));
		if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(t("端口必须在 1-65535 之间"));
		this.droids.setMeta("listenHost", trimmed);
		this.droids.setMeta("listenPort", String(port));
		if (!this.droidGateway) throw new Error(t("设备网关未启动"));
		const result = await this.droidGateway.listen(trimmed, port);
		if (!result.ok) throw new Error(result.error ?? t("监听失败"));
		this.hooks.onDroidChange();
	}

	/**
	 * Flip the Android toolset switch for the conversation on screen only.
	 *
	 * The switch is written as a session entry rather than a DroidStore meta row:
	 * a global row is what made one chat's choice mount the tools in every other
	 * chat. Background sessions keep their own state; switching back to one
	 * restores whatever its branch last recorded.
	 */
	async setDroidEnabled(enabled: boolean): Promise<void> {
		const active = this.active;
		if (!active || active.taskSession) return;
		if (active.droidOn === enabled) return;
		active.droidOn = enabled;
		active.manager.appendCustomEntry(SESSION_DROID_CUSTOM_TYPE, { enabled, at: Date.now() });
		this.applyDroidTools(active);
		this.hooks.onStateChange();
		this.hooks.onDroidChange();
	}

	async droidCreateToken(label: string): Promise<void> {
		this.droids.createToken(label);
		this.hooks.onDroidChange();
	}

	/** 删除一条 token（设备页的「删除」），并断开用它反连的设备。 */
	async droidDeleteToken(id: string): Promise<void> {
		if (!this.droids.deleteToken(id)) throw new Error(t("该 token 不存在"));
		for (const device of this.droids.listDevices()) {
			if (device.tokenId === id) this.droidGateway?.disconnect(device.id);
		}
		this.hooks.onDroidChange();
	}

	async droidRenameDevice(id: string, name: string): Promise<void> {
		if (!this.droids.renameDevice(id, name)) throw new Error(t("设备不存在或名称为空"));
		this.hooks.onDroidChange();
	}

	async droidRemoveDevice(id: string): Promise<void> {
		this.droidGateway?.disconnect(id);
		if (!this.droids.removeDevice(id)) throw new Error(t("设备不存在"));
		this.hooks.onDroidChange();
	}

	private createDroidToolContext(managed: ManagedSession): DroidToolContext {
		return {
			gateway: () => this.droidGateway,
			enabled: () => managed.droidOn,
			container: () => managed.container,
			workDir: () => managed.cwd,
			guard: (deviceName, command) => this.guardDroidCommand(managed, deviceName, command),
		};
	}

	/**
	 * The approval chain for device commands, the same three modes container bash
	 * goes through. The judge sees the device as the source, and an edited command
	 * from the approval card is the one that runs. Mode, project and session come
	 * from the session that issued the command: a background conversation must not
	 * be judged by whichever session the operator happens to be viewing.
	 */
	private guardDroidCommand(managed: ManagedSession, deviceName: string, command: string): Promise<string> {
		const mode = managed.modeOf();
		const label = t("设备「{name}」", { name: deviceName });
		const auditContext = {
			label: () => label,
			projectId: managed.projectId,
			projectName: managed.projectName,
			sessionId: () => managed.manager.getSessionId(),
		};
		if (mode === "auto") {
			this.recordUnjudged({ tool: "droid_shell", command, cwd: "/work", approval: "auto", context: auditContext });
			return Promise.resolve(command);
		}
		if (mode === "review") {
			if (this.approvals.isAutoAllowed(command, managed.projectId)) {
				this.recordUnjudged({
					tool: "droid_shell",
					command,
					cwd: "/work",
					approval: "auto",
					context: auditContext,
				});
				return Promise.resolve(command);
			}
			return this.approvals.request(command, "/work", undefined, label, managed.projectId).then((outcome) => {
				this.recordUnjudged({
					tool: "droid_shell",
					command: outcome.command ?? command,
					cwd: "/work",
					approval: "human",
					...(outcome.approved ? {} : { decision: "block" as const, reason: outcome.reason ?? t("已拒绝") }),
					context: auditContext,
				});
				if (outcome.approved && outcome.command !== undefined) return outcome.command;
				throw new Error(outcome.reason ?? t("已拒绝"));
			});
		}
		return this.gatekeeper
			.guard({
				command,
				cwd: "/work",
				source: label,
				projectId: managed.projectId,
				projectName: managed.projectName,
				sessionId: managed.manager.getSessionId(),
			})
			.then((outcome) => {
				if (outcome.kind === "allow" || outcome.kind === "failed") return command;
				throw new Error(outcome.kind === "block" ? outcome.message : t("已中止"));
			});
	}

	/**
	 * Mount or unmount the Android toolset as one switch. The tools refuse to act
	 * while no device is online, so the switch controls prompt noise, not
	 * authority — the authority control is the command gate above.
	 */
	private applyDroidTools(managed: ManagedSession): void {
		if (managed.taskSession) return;
		const active = managed.session.getActiveToolNames();
		const droidNames = [...DROID_TOOL_NAMES, ...FRIDA_TOOL_NAMES, ...DROID_CAPTURE_TOOL_NAMES];
		const wanted = managed.droidOn
			? [...active, ...droidNames.filter((name) => !active.includes(name))]
			: active.filter((name) => !droidNames.includes(name));
		const changed = wanted.length !== active.length || wanted.some((name, index) => name !== active[index]);
		if (changed) managed.session.setActiveToolsByName(wanted);
		this.applyHttpEvidenceTools(managed);
	}

	// =========================================================================
	// Packet replay (replayd, running inside the project container)
	// =========================================================================

	private createReplayToolContext(managed: ManagedSession): ReplayToolContext {
		return {
			container: () => managed.container,
			workDir: () => managed.cwd,
			guard: (tool, summary, payload) => this.guardReplayCommand(managed, tool, summary, payload),
			ensure: (options) => this.ensureReplayService(managed, options),
		};
	}

	/**
	 * The container's replayd, started on demand. The project is readied first so
	 * a stopped container is started rather than reported as an exec failure; the
	 * status is cached by replayd.ts, so this is cheap on the second call.
	 */
	private async ensureReplayService(
		managed: ManagedSession,
		options: { force?: boolean; start?: boolean } = {},
	): Promise<ReplaydStatus> {
		const project = managed.projectId
			? listProjects(this.agentDir).projects.find((candidate) => candidate.id === managed.projectId)
			: undefined;
		if (project) await ensureProjectReady(project, this.agentDir);
		// Host networking shares the host loopback, which is the only case where the
		// operator's browser can open the service UI directly.
		const hostNetwork = readContainerNetwork(this.agentDir) === "host";
		return ensureReplayd(managed.container, managed.cwd, { ...options, hostNetwork });
	}

	/**
	 * The approval chain for actions that reach the target, the same three modes
	 * container bash goes through. The payload — the raw packet — is what the
	 * approval card shows and may edit, and what the judge sees as the command.
	 */
	private guardReplayCommand(
		managed: ManagedSession,
		tool: string,
		summary: string,
		payload: string,
	): Promise<string> {
		const mode = managed.modeOf();
		const label = summary;
		const auditContext = {
			label: () => label,
			projectId: managed.projectId,
			projectName: managed.projectName,
			sessionId: () => managed.manager.getSessionId(),
		};
		if (mode === "auto") {
			this.recordUnjudged({ tool, command: payload, cwd: "/work", approval: "auto", context: auditContext });
			return Promise.resolve(payload);
		}
		if (mode === "review") {
			if (this.approvals.isAutoAllowed(payload, managed.projectId)) {
				this.recordUnjudged({ tool, command: payload, cwd: "/work", approval: "auto", context: auditContext });
				return Promise.resolve(payload);
			}
			return this.approvals.request(payload, "/work", undefined, label, managed.projectId).then((outcome) => {
				this.recordUnjudged({
					tool,
					command: outcome.command ?? payload,
					cwd: "/work",
					approval: "human",
					...(outcome.approved ? {} : { decision: "block" as const, reason: outcome.reason ?? t("已拒绝") }),
					context: auditContext,
				});
				if (outcome.approved && outcome.command !== undefined) return outcome.command;
				throw new Error(outcome.reason ?? t("已拒绝"));
			});
		}
		return this.gatekeeper
			.guard({
				command: payload,
				cwd: "/work",
				source: label,
				projectId: managed.projectId,
				projectName: managed.projectName,
				sessionId: managed.manager.getSessionId(),
			})
			.then((outcome) => {
				if (outcome.kind === "allow" || outcome.kind === "failed") return payload;
				throw new Error(outcome.kind === "block" ? outcome.message : t("已中止"));
			});
	}

	// =========================================================================
	// iOS devices (SentinelBridge)
	// =========================================================================

	/** The gateway is built by the server once the HTTP listener exists. */
	setIosGateway(gateway: IosGateway): void {
		this.iosGateway = gateway;
	}

	/** The registry the server's iOS gateway authenticates against. */
	get iosRegistry(): IosStore {
		return this.ios;
	}

	/** Everything the iOS page shows: the active conversation's switch, devices, tokens. */
	iosState(): {
		enabled: boolean;
		devices: ReturnType<IosStore["listDevices"]>;
		tokens: ReturnType<IosStore["listTokens"]>;
	} {
		const devices = this.ios.listDevices().map((device) => {
			const liveness = this.iosGateway?.livenessOf(device.id);
			return { ...device, stale: liveness?.stale ?? false, idleMs: liveness?.idleMs ?? 0 };
		});
		return {
			enabled: this.active?.iosOn ?? false,
			devices,
			tokens: this.ios.listTokens(),
		};
	}

	/** The persisted iOS reverse-listener config; null until the operator enabled it. */
	iosListenConfig(): { host: string; port: number } | null {
		const host = this.ios.getMeta("listenHost");
		const port = this.ios.getMeta("listenPort");
		if (!host || !port) return null;
		return { host, port: Number(port) };
	}

	/** Bind and persist the dedicated iOS reverse listener. */
	async iosSetListen(host: string, port: number): Promise<void> {
		const trimmed = host.trim();
		if (!trimmed) throw new Error(t("监听地址不能为空"));
		if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(t("端口必须在 1-65535 之间"));
		if (!this.iosGateway) throw new Error(t("设备网关未启动"));
		const result = await this.iosGateway.listen(trimmed, port);
		if (!result.ok) throw new Error(result.error ?? t("监听失败"));
		this.ios.setMeta("listenHost", trimmed);
		this.ios.setMeta("listenPort", String(port));
		this.hooks.onIosChange();
	}

	/** Flip the iOS toolset switch for the conversation on screen only. */
	async setIosEnabled(enabled: boolean): Promise<void> {
		const active = this.active;
		if (!active || active.taskSession) return;
		if (active.iosOn === enabled) return;
		active.iosOn = enabled;
		active.manager.appendCustomEntry(SESSION_IOS_CUSTOM_TYPE, { enabled, at: Date.now() });
		this.applyIosTools(active);
		this.hooks.onStateChange();
		this.hooks.onIosChange();
	}

	async iosCreateToken(label: string): Promise<void> {
		this.ios.createToken(label);
		this.hooks.onIosChange();
	}

	async iosDeleteToken(id: string): Promise<void> {
		if (!this.ios.deleteToken(id)) throw new Error(t("该 token 不存在"));
		for (const device of this.ios.listDevices()) {
			if (device.tokenId === id) this.iosGateway?.disconnect(device.id);
		}
		this.hooks.onIosChange();
	}

	async iosRenameDevice(id: string, name: string): Promise<void> {
		if (!this.ios.renameDevice(id, name)) throw new Error(t("设备不存在或名称为空"));
		this.hooks.onIosChange();
	}

	async iosRemoveDevice(id: string): Promise<void> {
		this.iosGateway?.disconnect(id);
		if (!this.ios.removeDevice(id)) throw new Error(t("设备不存在"));
		this.hooks.onIosChange();
	}

	private createIosToolContext(managed: ManagedSession): IosToolContext {
		return {
			gateway: () => this.iosGateway,
			enabled: () => managed.iosOn,
			workDir: () => managed.cwd,
			container: () => managed.container,
			guard: (deviceName, command) => this.guardIosCommand(managed, deviceName, command),
			project: () =>
				managed.projectId ? { id: managed.projectId, name: managed.projectName ?? t("未命名项目") } : null,
			store: () => this.captures,
		};
	}

	/**
	 * The approval chain for iOS commands, the same three modes container bash
	 * goes through. The judge sees the device as the source, and an edited command
	 * from the approval card is the one that runs. Like Android, everything comes
	 * from the issuing session, not from whichever one is on screen.
	 */
	private guardIosCommand(managed: ManagedSession, deviceName: string, command: string): Promise<string> {
		const mode = managed.modeOf();
		const label = t("设备「{name}」", { name: deviceName });
		const auditContext = {
			label: () => label,
			projectId: managed.projectId,
			projectName: managed.projectName,
			sessionId: () => managed.manager.getSessionId(),
		};
		if (mode === "auto") {
			this.recordUnjudged({ tool: "ios_shell", command, cwd: "/work", approval: "auto", context: auditContext });
			return Promise.resolve(command);
		}
		if (mode === "review") {
			if (this.approvals.isAutoAllowed(command, managed.projectId)) {
				this.recordUnjudged({ tool: "ios_shell", command, cwd: "/work", approval: "auto", context: auditContext });
				return Promise.resolve(command);
			}
			return this.approvals.request(command, "/work", undefined, label, managed.projectId).then((outcome) => {
				this.recordUnjudged({
					tool: "ios_shell",
					command: outcome.command ?? command,
					cwd: "/work",
					approval: "human",
					...(outcome.approved ? {} : { decision: "block" as const, reason: outcome.reason ?? t("已拒绝") }),
					context: auditContext,
				});
				if (outcome.approved && outcome.command !== undefined) return outcome.command;
				throw new Error(outcome.reason ?? t("已拒绝"));
			});
		}
		return this.gatekeeper
			.guard({
				command,
				cwd: "/work",
				source: label,
				projectId: managed.projectId,
				projectName: managed.projectName,
				sessionId: managed.manager.getSessionId(),
			})
			.then((outcome) => {
				if (outcome.kind === "allow" || outcome.kind === "failed") return command;
				throw new Error(outcome.kind === "block" ? outcome.message : t("已中止"));
			});
	}

	/**
	 * Mount or unmount the iOS toolset as one switch. The tools refuse to act
	 * while no device is online, so the switch controls prompt noise, not
	 * authority — the authority control is the command gate above.
	 */
	private applyIosTools(managed: ManagedSession): void {
		if (managed.taskSession) return;
		const active = managed.session.getActiveToolNames();
		const mounted = [
			...IOS_TOOL_NAMES,
			...IOS_FRIDA_TOOL_NAMES,
			...IOS_CAPTURE_TOOL_NAMES,
			...IOS_DECRYPT_TOOL_NAMES,
		];
		const wanted = managed.iosOn
			? [...active, ...mounted.filter((name) => !active.includes(name))]
			: active.filter((name) => !mounted.includes(name));
		const changed = wanted.length !== active.length || wanted.some((name, index) => name !== active[index]);
		if (changed) managed.session.setActiveToolsByName(wanted);
		this.applyHttpEvidenceTools(managed);
	}

	/** Shared HTTP evidence remains readable while either mobile workflow is enabled. */
	private applyHttpEvidenceTools(managed: ManagedSession): void {
		const active = managed.session.getActiveToolNames();
		const wanted =
			managed.droidOn || managed.iosOn
				? [...active, ...HTTP_EVIDENCE_TOOL_NAMES.filter((name) => !active.includes(name))]
				: active.filter((name) => !HTTP_EVIDENCE_TOOL_NAMES.includes(name));
		const changed = wanted.length !== active.length || wanted.some((name, index) => name !== active[index]);
		if (changed) managed.session.setActiveToolsByName(wanted);
	}

	/**
	 * One finding reached the hub while this goal was running. Sub-agents count
	 * too: their work is the goal's work, and a completion claim that ignored a
	 * finding they submitted would be rejected as a mismatch.
	 */
	private noteGoalFinding(managed: ManagedSession): void {
		const managedGoal = managed.goal;
		if (!managedGoal || managedGoal.goal.status !== "active") return;
		managedGoal.submitted += 1;
		managedGoal.goal = recordSubmission(managedGoal.goal, Date.now());
		this.persistGoal(managed, managedGoal.goal);
		this.hooks.onStateChange();
	}

	/**
	 * Move the goal on after a settled round. Called once per settle, and the
	 * continuation is injected with `triggerTurn`, which the SDK defers until the
	 * settle emission is over: a round can never fork into two continuations.
	 *
	 * A round ends when the agent stops calling tools, so everything here is about
	 * what the next round is allowed to be: nothing when the goal already ended,
	 * a pause when a fuse trips, otherwise one continuation carrying the progress.
	 */
	private afterRoundSettled(managed: ManagedSession, aborted: boolean): void {
		const managedGoal = managed.goal;
		if (!managedGoal) return;
		const at = Date.now();
		let goal = managedGoal.goal;
		const last = goal.rounds[goal.rounds.length - 1];
		const roundOpen = last !== undefined && last.endedAt === undefined;

		// A stutter abort is the loop-guard at work, not the operator pulling the
		// plug: the guard trimmed the degenerate output and is nudging the model to
		// try something else, so the attempt costs no round and the goal keeps
		// running. The guard's own nudge starts the next run, which is why no
		// continuation is injected here — that would fork the round. Several trips
		// in a row mean the model cannot shake the repetition: stand down for the
		// operator instead of letting the guard and the goal take turns burning
		// the budget.
		if (aborted && isStutterAbort(managed)) {
			managedGoal.stutterStreak += 1;
			if (goal.status === "active" && roundOpen) {
				const usage = diffUsage(usageOf(managed.session.getSessionStats()), managedGoal.roundUsageStart);
				goal = refundRound(
					finishRound(goal, { at, toolCalls: managedGoal.roundToolCalls, usage, outcome: "aborted" }),
					at,
				);
				managedGoal.roundToolCalls = 0;
				managedGoal.roundUsageStart = usageOf(managed.session.getSessionStats());
				managedGoal.goal = goal;
				this.persistGoal(managed, goal);
			}
			if (goal.status === "active" && managedGoal.stutterStreak >= STUTTER_PAUSE_LIMIT) {
				goal = pauseGoal(
					goal,
					"loop-guard",
					t("连续 {count} 次输出重复中止", { count: managedGoal.stutterStreak }),
					at,
				);
				managedGoal.goal = goal;
				this.persistGoal(managed, goal);
				this.notifyGoal(managed, managedGoal);
			}
			this.hooks.onStateChange();
			return;
		}
		managedGoal.stutterStreak = 0;

		// A settled run closes the round in flight — unless there is none, which is
		// the loop-guard's nudge run finishing after the round it belonged to was
		// already closed and refunded.
		if (roundOpen) {
			const usage = diffUsage(usageOf(managed.session.getSessionStats()), managedGoal.roundUsageStart);
			// A round that called goal_progress already wrote its own summary; the
			// prose fallback is for rounds that never did.
			const summary =
				last?.summaryFromTool === true
					? undefined
					: extractRoundSummary(lastAssistantText(managed.session.messages));
			const status = goal.status;
			const outcome: SentinelGoalRoundOutcome = aborted
				? "aborted"
				: status === "completed"
					? "completed"
					: status === "blocked"
						? "blocked"
						: status === "paused"
							? "paused"
							: lastAssistantStopReason(managed.session.messages) === "error"
								? "error"
								: "continued";
			goal = finishRound(managedGoal.goal, {
				at,
				toolCalls: managedGoal.roundToolCalls,
				usage,
				...(summary ? { summary } : {}),
				outcome,
			});
			managedGoal.roundToolCalls = 0;
			// An abort is an intervention: the goal waits for the operator rather
			// than counting a half-finished round as progress.
			if (aborted && goal.status === "active") {
				goal = pauseGoal(goal, "manual", t("运行被中止，目标已暂停"), at);
			}
			managedGoal.goal = goal;
			this.persistGoal(managed, goal);
		}
		if (goal.status !== "active") {
			if (roundOpen) this.notifyGoal(managed, managedGoal);
			return;
		}
		const decision = advanceGoal(goal, at);
		managedGoal.goal = decision.goal;
		this.persistGoal(managed, decision.goal);
		if (decision.action === "stop") {
			this.notifyGoal(managed, managedGoal);
			return;
		}
		const next = startRound(decision.goal, "continue", at);
		managedGoal.goal = next;
		managedGoal.roundUsageStart = usageOf(managed.session.getSessionStats());
		this.persistGoal(managed, next);
		this.startContinuation(managed, buildGoalContract(next, "continue"));
	}

	/**
	 * Report a goal that stopped. Goal-driven runs deliberately send no per-run
	 * report, so this is the only notification the operator gets about a goal that
	 * finished, ran out of rounds, or gave up; it is not gated on the composer's
	 * per-run switch, only on the notification channel being enabled.
	 */
	private notifyGoal(managed: ManagedSession, managedGoal: ManagedGoal): void {
		const goal = managedGoal.goal;
		if (goal.status === "active") return;
		const config = readNotifyConfig(this.agentDir);
		if (!hasEnabledNotifyChannel(config) || !config.kinds.goals) return;
		const lastRound = goal.rounds[goal.rounds.length - 1];
		const report = buildGoalNotification(
			{
				label: goalStatusLabel(goal),
				projectName: managed.projectName ?? "",
				sessionTitle: managed.manager.getSessionName() ?? firstUserText(managed.session.messages) ?? goal.objective,
				sessionStatus: readSessionStatus(managed.manager.getBranch()),
				objective: goal.objective,
				rounds: { used: goal.roundsUsed, limit: goal.roundLimit },
				durationMs: (goal.endedAt ?? Date.now()) - goal.startedAt,
				summary: goal.completion?.summary ?? goal.blocked?.reason ?? goal.pauseNote ?? lastRound?.summary ?? "",
				...(goal.completion
					? {
							evidence: goal.completion.evidence,
							criteria: goal.completion.criteria,
							findings: { submitted: goal.completion.submitted, note: goal.completion.findingsNote },
						}
					: {}),
				...(goal.blocked ? { evidence: goal.blocked.evidence } : {}),
			},
			config.summaryLimit,
		);
		void sendNotifications(config, report.title, report.markdown).then((result) => {
			this.notifyStatus = { ...result, subject: report.title };
			this.hooks.onNotifyStatus(this.notifyStatus);
		});
	}

	/**
	 * Pause one session's goal. Takes the session rather than assuming the viewed
	 * one: a goal that runs in the background settles there too, and a continuation
	 * that cannot start has to be recorded against its own session.
	 */
	private pauseGoalOf(managed: ManagedSession, reason: SentinelGoalPauseReason, note?: string): void {
		const managedGoal = managed.goal;
		if (!managedGoal || managedGoal.goal.status !== "active") return;
		managedGoal.goal = pauseGoal(managedGoal.goal, reason, note, Date.now());
		this.persistGoal(managed, managedGoal.goal);
		this.notifyGoal(managed, managedGoal);
		this.hooks.onStateChange();
	}

	/**
	 * Pause the viewed session's goal. Only the viewed one: a pause is an operator
	 * action on the conversation on screen, and a goal running in the background
	 * keeps working (its notifications still arrive).
	 */
	private pauseActiveGoal(reason: SentinelGoalPauseReason, note?: string): void {
		if (this.active) this.pauseGoalOf(this.active, reason, note);
	}

	/**
	 * Start a round by injecting its contract. `triggerTurn` defers the run until
	 * the settle emission is over, so a round can never fork into two runs; when
	 * the run cannot start at all, the goal pauses with the reason instead of
	 * sitting there as if it were still working.
	 */
	private startContinuation(managed: ManagedSession, contract: string): void {
		void managed.session
			.sendCustomMessage(
				{ customType: GOAL_MESSAGE_CUSTOM_TYPE, content: contract, display: true },
				{ triggerTurn: true },
			)
			.catch((error: unknown) => {
				this.pauseGoalOf(
					managed,
					"manual",
					t("续跑启动失败：{error}", { error: error instanceof Error ? error.message : String(error) }),
				);
			});
	}

	/** The goal as the console shows it: the stored record plus live counters. */
	private goalView(managed: ManagedSession | undefined): SentinelGoalView | null {
		if (!managed?.goal) return null;
		const goal = managed.goal.goal;
		// Sub-agent usage is shown for context. It does not consume rounds: the
		// budget counts continuations, and there is no token budget to charge.
		const runs = this.subagents
			.list(managed.manager.getSessionId())
			.filter((run) => Date.parse(run.startedAt) >= goal.startedAt);
		return {
			...goal,
			usage: diffUsage(usageOf(managed.session.getSessionStats()), goal.baseline),
			subagent: { runs: runs.length, turns: runs.reduce((sum, run) => sum + run.turns, 0) },
			running: managed.session.isStreaming,
		};
	}

	/**
	 * Start a persistent goal. An unattended mode is a precondition rather than
	 * something this code flips: an unattended loop that stops at every command is
	 * useless, and one that silently changes the operator's safety mode is worse.
	 * `ai` qualifies because the gatekeeper answers instead of the operator.
	 */
	async startGoal(objective: string, criteria: string[], roundLimit: number): Promise<void> {
		if (!this.activeProjectId) throw new Error(t("请先创建或选择一个项目"));
		const active = this.active;
		if (!active) throw new Error(t("会话尚未就绪，请重新选择项目"));
		if (this.effectiveMode(active) === "review") {
			throw new Error(t("持续目标只在自动执行或 AI 审批模式下可用：审批模式下命令要等人放行"));
		}
		if (active.session.isStreaming) throw new Error(t("Agent 正在运行，请先中止或等本轮结束再启动目标"));
		const text = objective.trim();
		if (!text) throw new Error(t("目标不能为空"));
		const existing = active.goal;
		if (existing && existing.goal.status !== "completed") {
			throw new Error(t("当前会话已有未结束的目标，请先在目标条上继续或清除它"));
		}
		const at = Date.now();
		const baseline = usageOf(active.session.getSessionStats());
		const goal = createGoal({
			id: `goal-${randomUUID()}`,
			objective: text,
			criteria: parseCriteria(criteria.join("\n")),
			roundLimit,
			baseline,
			at,
		});
		const managedGoal: ManagedGoal = {
			goal: startRound(goal, "initial", at),
			roundUsageStart: baseline,
			roundToolCalls: 0,
			stutterStreak: 0,
			submitted: 0,
		};
		active.goal = managedGoal;
		this.persistGoal(active, managedGoal.goal);
		// The contract is a visible row of its own rather than part of the operator's
		// message: the objective stays exactly what they typed, and the transcript
		// shows what goal mode added around it.
		await active.session.sendCustomMessage(
			{
				customType: GOAL_MESSAGE_CUSTOM_TYPE,
				content: buildGoalContract(managedGoal.goal, "initial"),
				display: true,
			},
			{ triggerTurn: false },
		);
		// Goal-driven runs skip the per-run report: goal notifications cover the
		// states that matter, and one report per round would be noise.
		active.run = { startedAt: at, notify: false, instruction: text };
		try {
			await active.session.prompt(text, {});
		} catch (error) {
			// The run never started, so the goal cannot be left looking active.
			this.pauseGoalOf(
				active,
				"manual",
				t("启动失败：{error}", { error: error instanceof Error ? error.message : String(error) }),
			);
			throw error;
		}
		this.hooks.onStateChange();
	}

	/** Operator pause: stop the run in flight and keep the goal for later. */
	async pauseGoal(): Promise<void> {
		this.pauseActiveGoal("manual", t("操作员在目标条上暂停"));
		await this.active?.session.abort();
	}

	/**
	 * Resume a paused or blocked goal and start the next round right away. The
	 * extra rounds are added to the budget, so resuming after the limit is the
	 * same action as resuming after a manual pause.
	 */
	resumeGoal(extraRounds?: number): void {
		const active = this.active;
		const managedGoal = active?.goal;
		if (!active || !managedGoal) throw new Error(t("当前会话没有持续目标"));
		if (managedGoal.goal.status === "completed") throw new Error(t("目标已完成，请清除后新建目标"));
		if (this.effectiveMode(active) === "review") {
			throw new Error(t("持续目标只在自动执行或 AI 审批模式下可用：请先切到非审批模式"));
		}
		if (active.session.isStreaming) throw new Error(t("Agent 正在运行，请先中止再继续目标"));
		if (managedGoal.goal.status === "active") return;
		const at = Date.now();
		const resumed = resumeGoal(managedGoal.goal, extraRounds ?? DEFAULT_ROUND_LIMIT, at);
		const next = startRound(resumed, "continue", at);
		managedGoal.goal = next;
		managedGoal.roundUsageStart = usageOf(active.session.getSessionStats());
		managedGoal.roundToolCalls = 0;
		managedGoal.stutterStreak = 0;
		this.persistGoal(active, next);
		this.startContinuation(active, buildGoalContract(next, "continue"));
		this.hooks.onStateChange();
	}

	/** Forget the goal. A run in flight belongs to it, so it is stopped first. */
	async clearGoal(): Promise<void> {
		const active = this.active;
		if (!active?.goal) return;
		if (active.session.isStreaming) await active.session.abort();
		active.goal = undefined;
		this.persistGoal(active, null);
		this.hooks.onStateChange();
	}

	/**
	 * Forget a project and drop its sessions. Used when the project is deleted:
	 * its container is gone, so nothing of it can run any more. The runtime ends
	 * up with no project, which the console renders as the project-required state.
	 */ async detachProject(workDir?: string): Promise<void> {
		for (const [key, managed] of [...this.sessions]) {
			if (workDir !== undefined && managed.manager.getCwd() !== workDir) continue;
			managed.unsubscribe();
			managed.session.dispose();
			this.sessions.delete(key);
			if (this.activeKey === key) this.activeKey = undefined;
		}
		if (workDir === undefined || this.cwd === workDir) {
			this.activeProjectId = undefined;
			this.activeProjectName = undefined;
			this.activeContainer = undefined;
		}
		this.hooks.onStateChange();
	}

	/**
	 * Create the shared model runtime, or refresh it in place when a library entry
	 * changed. Every session holds this one instance, so refreshing here is what
	 * makes a new or edited endpoint visible without rebuilding live sessions.
	 */
	private async ensureModelRuntime(): Promise<void> {
		if (!this.modelRuntime) {
			this.modelRuntime = await ModelRuntime.create({
				authPath: `${this.agentDir}/auth.json`,
				modelsPath: modelsJsonPath(this.agentDir),
			});
			this.modelRuntimeDirty = false;
			return;
		}
		if (!this.modelRuntimeDirty) return;
		this.modelRuntimeDirty = false;
		await this.modelRuntime.refresh({ allowNetwork: false });
	}

	/**
	 * Move an idle session onto whatever 主模型 resolves to now. A run in flight is
	 * left alone: the operator's next send is what picks up the change. Capability
	 * edits count as a change too — otherwise a session that started before
	 * reasoning was enabled would keep the old thinking levels and context window.
	 */
	private async syncMainModel(active: ManagedSession): Promise<void> {
		if (active.session.isStreaming) return;
		const resolved = resolveLibraryRole(this.agentDir, "main");
		if (!resolved || !this.modelRuntime) return;
		const model = this.modelRuntime.getModel(resolved.entryId, resolved.config.modelId);
		if (!model) return;
		if (sameModelDefinition(active.session.model, model)) return;
		await active.session.setModel(model);
	}

	private resolveModel() {
		// The 主模型 role names a library entry; the entry id is the provider id in
		// models.json. A main-model change is picked up here, which is why saving one
		// does not have to tear down running sessions.
		const resolved = resolveLibraryRole(this.agentDir, "main");
		if (!resolved || !this.modelRuntime) return undefined;
		return this.modelRuntime.getModel(resolved.entryId, resolved.config.modelId);
	}

	async prompt(
		text: string,
		streamingBehavior?: "steer" | "followUp",
		images?: ImageContent[],
		notify?: boolean,
		attachModelIds?: string[],
	): Promise<void> {
		if (!this.activeProjectId) throw new Error(t("请先创建或选择一个项目"));
		const active = this.active;
		if (!active) throw new Error(t("会话尚未就绪，请重新选择项目"));
		// pi's built-in slash commands only exist in interactive mode, so the console
		// honors the one its own context-overflow hint references.
		if (text.trim() === "/compact") {
			await this.compact();
			return;
		}
		// pi refuses this in English; the operator is looking at a console that has
		// no other hint about why the prompt went nowhere.
		if (active.session.isCompacting) {
			throw new Error(t("正在压缩上下文，暂时不能发送；可等待压缩完成，或点「中止压缩」放弃这次压缩"));
		}
		// 主模型 changes take effect here rather than at save time, so a live session
		// is never rebuilt behind the operator's back.
		await this.ensureModelRuntime();
		await this.syncMainModel(active);
		// 带建模数据 lands with the first message of a fresh conversation only: the
		// catalog is injected before that message runs, and afterwards the composer's
		// picker is gone (the records stay attached until removed).
		if (attachModelIds && attachModelIds.length > 0 && branchUserMessages(active.manager.getBranch()).length === 0) {
			await this.attachModelingRecords(active, attachModelIds);
		}
		// Supervision was armed before the conversation; the first prompt is what
		// starts collecting. An unarmed session has no supervisor state at all.
		if (this.supervisor.statusOf(active.key) === "waiting") this.supervisor.start(active.key);
		// A steer joins the run already in flight: keep its start time, let the
		// operator's latest choice decide whether the run is reported.
		active.run = {
			startedAt: active.run?.startedAt ?? Date.now(),
			notify,
			instruction: active.run?.instruction ?? text,
		};
		await active.session.prompt(text, {
			...(streamingBehavior ? { streamingBehavior } : {}),
			...(images && images.length > 0 ? { images } : {}),
		});
	}

	/**
	 * Report a settled run to the notification channel. Every session reports its
	 * own run: gating this on the viewed session silently dropped the notification
	 * of any long task that finished while the operator was elsewhere. The send is
	 * fire-and-forget, because a failing webhook must never affect the run.
	 */
	private reportRunSettled(managed: ManagedSession, aborted: boolean): void {
		const run = managed.run;
		managed.run = undefined;
		if (!run) return;
		// A stutter abort is the loop-guard doing its job, not a run that ended:
		// the guard starts the next attempt right away, and one "运行已中止" push
		// per repetition would flood the channel long before anything finishes.
		if (aborted && isStutterAbort(managed)) return;
		const config = readNotifyConfig(this.agentDir);
		if (!shouldNotifyRun(run.notify, hasEnabledNotifyChannel(config))) return;
		// The kind filter narrows the automatic reports; a run the operator forced
		// from the composer is an explicit ask and pushes regardless.
		if (run.notify !== true && !config.kinds.runs) return;
		if (!config.webhook.trim()) return;

		const last = [...managed.session.messages]
			.reverse()
			.find((message) => (message as { role?: string }).role === "assistant") as
			| { stopReason?: string; errorMessage?: string; content?: unknown }
			| undefined;
		const status =
			aborted || last?.stopReason === "aborted" ? "aborted" : last?.stopReason === "error" ? "failed" : "done";
		const stats = managed.session.getSessionStats();
		const report = buildRunNotification(
			{
				status,
				projectName: managed.projectName ?? "",
				sessionTitle:
					managed.manager.getSessionName() ?? firstUserText(managed.session.messages) ?? run.instruction,
				sessionStatus: readSessionStatus(managed.manager.getBranch()),
				durationMs: Date.now() - run.startedAt,
				summary: messageText(last),
				...(status === "failed" && last?.errorMessage ? { error: last.errorMessage } : {}),
				tokens: stats?.tokens
					? { input: stats.tokens.input, output: stats.tokens.output, total: stats.tokens.total }
					: undefined,
				...(typeof stats?.cost === "number" ? { cost: stats.cost } : {}),
			},
			config.summaryLimit,
		);
		void sendNotifications(config, report.title, report.markdown).then((result) => {
			this.notifyStatus = { ...result, subject: report.title };
			this.hooks.onNotifyStatus(this.notifyStatus);
		});
	}

	/** The shared hub store; the reviewer LLM reads and calibrates through it. */
	vulnerabilityStore(): VulnerabilityStore {
		return this.vulnerabilities;
	}

	/**
	 * A reviewer calibration raised a record into critical/high: push it now,
	 * the same way a freshly submitted high finding is pushed. The agent's own
	 * rating may have undersold it.
	 */
	notifyReviewedHighSeverity(vuln: SentinelVulnerability): void {
		this.notifyHighSeverity(vuln);
	}

	/** Notification configuration, for the settings screen. */
	getNotifyConfig(): SentinelNotifyConfig {
		return readNotifyConfig(this.agentDir);
	}

	getNotifyStatus(): SentinelNotifyStatus {
		return this.notifyStatus;
	}

	saveNotifyConfig(config: SentinelNotifyConfig): void {
		writeNotifyConfig(this.agentDir, config);
	}

	async testNotify(
		config: SentinelNotifyConfig,
		channel: SentinelNotifyChannel = "dingtalk",
	): Promise<SentinelTestResult> {
		return channel === "feishu"
			? await testFeishu(config.feishu ?? { enabled: false, webhook: "", secret: "", keyword: "" })
			: channel === "wecom"
				? await testWecom(config.wecom ?? { enabled: false, webhook: "", secret: "", keyword: "" })
				: await testDingTalk(config);
	}

	/** Manually compact the viewed session's context into a summary. */
	async compact(): Promise<void> {
		const active = this.active;
		if (!active) throw new Error("Session not initialized");
		if (active.session.isStreaming) throw new Error(t("Agent 正在运行，请先中止再压缩上下文"));
		try {
			await active.session.compact();
		} catch (error) {
			// pi reports these two cases in English; the console is Chinese-first.
			// Anything else is rethrown unchanged.
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("too small")) throw new Error(t("当前会话内容太少，无需压缩"));
			if (message.includes("Already compacted")) throw new Error(t("该会话已经压缩过，无需重复压缩"));
			// The operator cancelled it: pi reports that as a cancelled or aborted
			// summarization, and it is not a failure worth a toast.
			if (/cancel|abort/i.test(message)) return;
			throw error;
		}
		this.hooks.onStateChange();
	}

	/**
	 * Cancel a compaction that is still running. The SDK has no timeout on the
	 * summarization request, so a stalled model endpoint leaves the session
	 * refusing every prompt with no way out but a restart; this is that way out.
	 * Nothing is lost: the transcript is only rewritten once a summary arrives.
	 */
	abortCompaction(): void {
		const active = this.active;
		if (!active) return;
		active.session.abortCompaction();
		this.hooks.onStateChange();
	}

	/** Set the viewed session's reasoning effort. Persists for this session only. */
	setThinkingLevel(level: ThinkingLevel): void {
		const active = this.active;
		if (!active) throw new Error("Session not initialized");
		if (!active.session.getAvailableThinkingLevels().includes(level)) {
			throw new Error(t("当前模型不支持思考等级「{level}」", { level }));
		}
		active.session.setThinkingLevel(level);
		this.hooks.onStateChange();
	}

	async abort(): Promise<void> {
		// Aborting a goal's run pauses the goal: the run is the goal's work, and an
		// abort is an intervention, not a reason to throw the objective away.
		this.pauseActiveGoal("manual", t("运行被中止，目标已暂停"));
		await this.active?.session.abort();
	}

	/**
	 * Set the viewed session's own mode; null makes it follow the global default.
	 *
	 * The two consequences are enforced here rather than left to the caller:
	 * leaving `review` rejects whatever was waiting for a human, and entering
	 * `review` pauses an active goal. A goal parked on a queue nobody is watching
	 * is worse than one that pauses and says why.
	 */
	setMode(mode: SentinelMode | null): void {
		const active = this.active;
		if (!active) throw new Error(t("会话尚未就绪，请重新选择项目"));
		if (active.modeOverride === mode) return;
		if (mode === "ai") this.requireJudgeEndpoint();
		active.modeOverride = mode;
		active.manager.appendCustomEntry(SESSION_MODE_CUSTOM_TYPE, mode ? { mode, at: Date.now() } : null);
		this.applyModeConsequences(active);
		this.hooks.onStateChange();
	}

	/** Set the console-wide default that every session without an override follows. */
	setGlobalMode(mode: SentinelMode): void {
		const config = readGatekeeperConfig(this.agentDir);
		if (config.mode === mode) return;
		if (mode === "ai") this.requireJudgeEndpoint();
		writeGatekeeperConfig(this.agentDir, { ...config, mode });
		for (const managed of this.sessions.values()) this.applyModeConsequences(managed);
		this.hooks.onStateChange();
	}

	private applyModeConsequences(managed: ManagedSession): void {
		if (this.effectiveMode(managed) === "review") {
			this.pauseGoalOf(managed, "manual", t("已切回审批模式，目标自动暂停"));
			return;
		}
		// Nothing may still be waiting for a human once the mode stops asking one.
		this.approvals.rejectAll(t("已切到非审批模式"));
	}

	/**
	 * Entering `ai` with no endpoint configured would run every command ungated
	 * (the judge fails open), which is the one outcome worse than refusing the
	 * mode. The operator fixes the setting and tries again.
	 */
	private requireJudgeEndpoint(): void {
		if (!this.gatekeeper.resolve().config) {
			throw new Error(
				t("未配置守门模型：请在 设置 → 模型 给「守门模型」选一条模型（或让它跟随主模型）后再切到 AI 审批"),
			);
		}
	}

	/** The gatekeeper settings the settings screen edits. */
	getGatekeeperConfig(): SentinelGatekeeperConfig {
		return readGatekeeperConfig(this.agentDir);
	}

	saveGatekeeperConfig(config: SentinelGatekeeperConfig): void {
		writeGatekeeperConfig(this.agentDir, config);
		// A mode saved here is the global default, so it applies to every session
		// without an override right away.
		for (const managed of this.sessions.values()) this.applyModeConsequences(managed);
		this.hooks.onStateChange();
	}

	/** Which endpoint the judge would use, for the settings screen and the mode guard. */
	resolveJudge(): ResolvedJudgeEndpoint {
		return this.gatekeeper.resolve();
	}

	// -----------------------------------------------------------------------
	// Supervision
	// -----------------------------------------------------------------------

	private resolveSupervisorStrategies(
		selections: SentinelSupervisorStrategyRef[] | undefined,
		fallbackStrategy: SentinelSupervisorStrategy | undefined,
		fallbackCustomId: string | null | undefined,
	): SentinelSupervisorStrategyEntry[] {
		const config = readSupervisorConfig(this.agentDir);
		const requested: SentinelSupervisorStrategyRef[] =
			selections && selections.length > 0
				? selections
				: fallbackCustomId
					? [{ strategy: fallbackStrategy ?? config.defaultStrategy, customStrategyId: fallbackCustomId }]
					: fallbackStrategy
						? [{ strategy: fallbackStrategy, customStrategyId: null }]
						: (config.defaultStrategies ?? [
								{ strategy: config.defaultStrategy, customStrategyId: config.defaultCustomStrategyId },
							]);
		const result: SentinelSupervisorStrategyEntry[] = [];
		const seen = new Set<string>();
		for (const selection of requested) {
			const customId = selection.customStrategyId;
			const custom = customId ? config.customStrategies.find((entry) => entry.id === customId) : undefined;
			if (customId && !custom) throw new Error(t("自定义监督策略不存在或已被删除"));
			const strategy =
				custom?.base ?? (isSupervisorStrategy(selection.strategy) ? selection.strategy : config.defaultStrategy);
			const key = custom ? `custom:${custom.id}` : `preset:${strategy}`;
			if (seen.has(key)) continue;
			seen.add(key);
			result.push({
				strategy,
				customStrategyId: custom?.id ?? null,
				name: custom?.name ?? SUPERVISOR_STRATEGY_LABELS[strategy],
				instructions: custom?.instructions ?? "",
			});
		}
		if (result.length === 0) throw new Error(t("请至少选择一个监督策略"));
		return result;
	}

	/** Arm supervision for the viewed conversation; only before its first message. */
	armSupervisor(
		mode: SentinelSupervisorMode,
		delivery: "auto" | "confirm",
		strategy?: SentinelSupervisorStrategy,
		note?: string,
		customStrategyId?: string | null,
		strategies?: SentinelSupervisorStrategyRef[],
	): SentinelSupervisorView {
		const active = this.active;
		if (!active) throw new Error(t("会话尚未就绪，请重新选择项目"));
		if (active.taskSession) throw new Error(t("工程任务的会话不能单独开启监督"));
		const config = readSupervisorConfig(this.agentDir);
		if (!config.enabled) throw new Error(t("监督功能已在 设置 → 模型 中关闭"));
		const selected = this.resolveSupervisorStrategies(strategies, strategy, customStrategyId);
		const primary = selected[0] as SentinelSupervisorStrategyEntry;
		return this.supervisor.arm(active.key, mode, delivery, primary.strategy, note ?? "", null, selected);
	}

	stopSupervisor(): SentinelSupervisorView | null {
		const active = this.active;
		if (!active) return null;
		return this.supervisor.stop(active.key);
	}

	setSupervisorMode(mode: SentinelSupervisorMode, delivery: "auto" | "confirm"): SentinelSupervisorView {
		const active = this.active;
		if (!active) throw new Error(t("会话尚未就绪，请重新选择项目"));
		return this.supervisor.setMode(active.key, mode, delivery);
	}

	setSupervisorStrategy(
		strategy: SentinelSupervisorStrategy,
		note?: string,
		customStrategyId?: string | null,
		strategies?: SentinelSupervisorStrategyRef[],
	): SentinelSupervisorView {
		const active = this.active;
		if (!active) throw new Error(t("会话尚未就绪，请重新选择项目"));
		const selected = this.resolveSupervisorStrategies(strategies, strategy, customStrategyId);
		const primary = selected[0] as SentinelSupervisorStrategyEntry;
		return this.supervisor.setStrategy(active.key, primary.strategy, note, null, selected);
	}

	runSupervisorNow(): void {
		const active = this.active;
		if (!active) throw new Error(t("会话尚未就绪，请重新选择项目"));
		this.supervisor.runNow(active.key);
	}

	getSupervisorCallOutput(callId: string): { text: string; truncated: boolean } {
		const active = this.active;
		if (!active) throw new Error(t("会话尚未就绪，请重新选择项目"));
		return this.supervisor.getCallOutput(active.key, callId);
	}

	listSupervisorAudit(query: {
		page?: number;
		pageSize?: number;
		projectId?: string;
		search?: string;
		mode?: "observe" | "intervene";
		progress?: SentinelSupervisorProgress;
		strategy?: SentinelSupervisorStrategy;
		customStrategyId?: string;
	}): SentinelSupervisorAuditPage {
		return this.supervisor.listAudit(query);
	}

	getSupervisorDetail(sessionId: string): SentinelSupervisorDetail | null {
		return this.supervisor.getDetail(sessionId);
	}

	sendSupervisorAdvice(id: string): SentinelSupervisorAdvice {
		const active = this.active;
		if (!active) throw new Error(t("会话尚未就绪，请重新选择项目"));
		return this.supervisor.sendAdvice(active.key, id);
	}

	ignoreSupervisorAdvice(id: string): SentinelSupervisorAdvice {
		const active = this.active;
		if (!active) throw new Error(t("会话尚未就绪，请重新选择项目"));
		return this.supervisor.ignoreAdvice(active.key, id);
	}

	getSupervisorConfig(): SentinelSupervisorConfig {
		return readSupervisorConfig(this.agentDir);
	}

	saveSupervisorConfig(config: SentinelSupervisorConfig): SentinelSupervisorConfig {
		writeSupervisorConfig(this.agentDir, config);
		this.hooks.onStateChange();
		return readSupervisorConfig(this.agentDir);
	}

	testSupervisor(): Promise<SupervisorTestOutcome> {
		return this.supervisor.test();
	}

	/** Deleting a project deletes its supervision audit, like its other records. */
	purgeProjectSupervisor(projectId: string): number {
		const page = this.supervisor.listAudit({ projectId, page: 1, pageSize: 1 });
		this.supervisor.deleteProject(projectId);
		return page.total;
	}

	private injectSupervisorAdvice(advice: SentinelSupervisorAdvice): void {
		const managed = this.sessions.get(advice.sessionId);
		if (!managed) return;
		const content = `${advice.text}\n\n（这是监督观察员的建议，不是操作员的指令；是否采纳由你判断。）`;
		void managed.session
			.sendCustomMessage(
				{
					customType: SUPERVISOR_ADVICE_CUSTOM_TYPE,
					content,
					display: true,
					details: { adviceId: advice.id, episodeId: advice.episodeId, at: advice.at },
				},
				managed.session.isStreaming ? { deliverAs: "steer" } : {},
			)
			.catch((error: unknown) => {
				console.error(`[sentinel] 监督建议注入失败：${error instanceof Error ? error.message : String(error)}`);
			});
	}

	/** Judged counts for the audit page header. */
	getGateStats(filter?: SentinelGateFilter): SentinelGateStats {
		return this.gateStore.stats(filter);
	}

	/**
	 * Rows per approval bucket for the audit page's tab strip, scoped by every
	 * filter except the tab's own. See `GatekeeperStore.bucketCounts`.
	 */
	getGateBuckets(filter?: SentinelGateFilter): Record<SentinelGateApproval, number> {
		return this.gateStore.bucketCounts(filter);
	}

	/** One page of audit records, newest first. */
	listGateDecisions(filter: SentinelGateFilter | undefined, page?: number, pageSize?: number) {
		return this.gateStore.list(filter, page, pageSize);
	}

	countProjectGates(projectId: string): number {
		return this.gateStore.countByProject(projectId);
	}

	purgeProjectGates(projectId: string): number {
		return this.gateStore.purgeProject(projectId);
	}

	/**
	 * Probe the judge with one fixed sample command. Nothing is recorded: this is
	 * a settings check, not a real command judgment.
	 */
	async testJudge(): Promise<{ result: SentinelTestResult; raw?: string }> {
		const resolved = this.gatekeeper.resolve();
		if (!resolved.config) {
			return {
				result: {
					ok: false,
					message: t("没有可用的守门模型"),
					detail: t("在 设置 → 模型 里给「守门模型」选一条模型，或让它跟随主模型"),
				},
			};
		}
		const settings = readGatekeeperConfig(this.agentDir);
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, settings.timeoutMs);
		const started = Date.now();
		try {
			const out = await this.gatekeeper.call(
				resolved.config,
				buildJudgeInput({ command: GATEKEEPER_SAMPLE_COMMAND, source: "设置页测试" }),
				controller.signal,
			);
			const verdict =
				out.verdict.decision === "allow"
					? t("放行 ALLOW")
					: t("拦截 BLOCK（{reason}）", { reason: out.verdict.reason });
			return {
				result: {
					ok: true,
					message: t("守门模型可用（{ms}ms，来源：{source}）", {
						ms: Date.now() - started,
						source: String(resolved.from),
					}),
					detail: t("样例命令「{command}」判定为 {verdict}", { command: GATEKEEPER_SAMPLE_COMMAND, verdict }),
				},
				raw: out.raw,
			};
		} catch (error) {
			const text = timedOut
				? t("守门判定超时（{ms}ms）", { ms: settings.timeoutMs })
				: error instanceof Error
					? error.message
					: String(error);
			return { result: { ok: false, message: t("守门模型调用失败"), detail: text } };
		} finally {
			clearTimeout(timer);
		}
	}

	decide(id: string, approved: boolean, editedCommand?: string, alwaysAllowPrefix = false): boolean {
		return this.approvals.decide(id, approved, editedCommand, alwaysAllowPrefix);
	}

	decideAll(approved: boolean): number {
		return this.approvals.decideAll(approved);
	}

	allowPrefix(prefix: string): void {
		// The console page acts on the project it is showing.
		this.approvals.allowPrefix(prefix, this.activeProjectId ?? null);
	}

	removeAllowedPrefix(prefix: string): void {
		this.approvals.removeAllowedPrefix(prefix, this.activeProjectId ?? null);
	}

	/**
	 * Start a new conversation. `presetId` loads a preset agent's context into it;
	 * omitting it starts the plain default agent, which is what every session did
	 * before presets existed. The choice is written to the session file before the
	 * session is built, so `createSessionInto` reads it back off the branch and the
	 * text lands in the very first system prompt.
	 */
	async newSession(presetId?: string): Promise<void> {
		const manager = SessionManager.create(this.cwd, this.sessionDir || undefined);
		if (presetId) {
			// Only an enabled preset is a choice. The picker offers nothing else, but a
			// browser left open across a change can still ask for a disabled or deleted
			// one, and silently starting the default agent would look like it worked.
			const preset = findPreset(this.agentDir, presetId);
			if (!preset) throw new Error(t("该预设不存在"));
			if (!preset.enabled) throw new Error(t("该预设已停用"));
			manager.appendCustomEntry(SESSION_PRESET_CUSTOM_TYPE, { id: presetId, at: Date.now() });
		}
		this.activeKey = await this.createSessionInto(manager);
		this.hooks.onStateChange();
	}

	/**
	 * Re-brief the viewed conversation: append a new `zg-preset` entry and rebuild
	 * the session, so every later turn runs under the new text. Earlier turns keep
	 * the briefing that produced them — a transcript is a record, not a draft — and
	 * the appended entry is what makes the choice survive a restart. `null` drops
	 * back to the default agent.
	 *
	 * Refused while the session is running: the rebuild disposes the live session,
	 * which would abandon the run in flight.
	 */
	async setSessionPreset(presetId: string | null): Promise<void> {
		const active = this.active;
		if (!active) throw new Error(t("还没有会话，无法设置预设"));
		if (active.taskSession) throw new Error(t("工程任务的会话跟随它的任务，不能单独换预设"));
		if (active.session.isStreaming) throw new Error(t("会话正在运行，请先中止再更换预设"));
		if (presetId !== null) {
			const preset = findPreset(this.agentDir, presetId);
			if (!preset) throw new Error(t("该预设不存在"));
			if (!preset.enabled) throw new Error(t("该预设已停用"));
		}
		// Re-picking the same preset is allowed on purpose: editing a preset's body
		// and re-picking it is the only way to apply the edit to an existing session.
		active.manager.appendCustomEntry(SESSION_PRESET_CUSTOM_TYPE, presetId ? { id: presetId, at: Date.now() } : null);
		// Only the viewed session is rebuilt: every other conversation keeps its own
		// preset, and task sessions belong to their engine.
		active.unsubscribe();
		active.session.dispose();
		this.sessions.delete(active.key);
		this.activeKey = await this.createSessionInto(active.manager);
		this.hooks.onStateChange();
	}

	/**
	 * Switch the viewed session. Never interrupts a running one: sessions keep
	 * executing in the background and are up to date when you switch back.
	 */
	async switchSession(path: string): Promise<void> {
		const normalized = resolveFsPath(path);
		for (const managed of this.sessions.values()) {
			const file = managed.manager.getSessionFile();
			if (file && resolveFsPath(file) === normalized) {
				this.activeKey = managed.key;
				this.hooks.onStateChange();
				return;
			}
		}
		const manager = SessionManager.open(normalized, this.sessionDir || undefined, this.cwd);
		this.activeKey = await this.createSessionInto(manager);
		this.hooks.onStateChange();
	}

	async listSessions(): Promise<SentinelSessionListEntry[]> {
		const sessions = await SessionManager.list(this.cwd, this.sessionDir || undefined);
		return sessions.map(withSessionStatus);
	}

	/**
	 * How many sessions a project has, counted without parsing them.
	 *
	 * One session is one file, so a directory listing is enough — and it is the
	 * only way to know the count for a project that is not the active one.
	 */
	countProjectSessions(workDir: string): number {
		const dir = getSessionDirPath(workDir, this.agentDir);
		if (!existsSync(dir)) return 0;
		try {
			return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).length;
		} catch {
			return 0;
		}
	}

	/**
	 * Delete a project's session files, and nothing else.
	 *
	 * Sessions are listed through the SDK for that working directory, so only
	 * files that are really this project's sessions are removed; sidecars that
	 * share a session's name (a temporary file, a database journal) go with it.
	 * The directory itself stays, because it is derived from the working
	 * directory and may hold another project's sessions in the same folder.
	 */
	async purgeProjectSessions(workDir: string): Promise<number> {
		const dir = getSessionDirPath(workDir, this.agentDir);
		if (!existsSync(dir)) return 0;
		const sessions = await SessionManager.list(workDir, dir);
		let removed = 0;
		const ids = new Set<string>();
		for (const session of sessions) {
			ids.add(session.id);
			try {
				rmSync(session.path, { force: true });
				removed += 1;
			} catch {
				// A session file we cannot remove must not stop the purge.
			}
		}
		for (const name of readdirSync(dir)) {
			const owner = [...ids].find((id) => name === id || name.startsWith(`${id}.`));
			if (!owner) continue;
			try {
				rmSync(join(dir, name), { force: true, recursive: true });
			} catch {
				// Same: keep going, the caller reports what it could remove.
			}
		}
		return removed;
	}

	/** Rename any session in the managed session directory by appending a session_info entry. */
	async renameSession(path: string, name: string): Promise<void> {
		const normalized = this.guardSessionPath(path);
		const manager = SessionManager.open(normalized, this.sessionDir || undefined, this.cwd);
		manager.appendSessionInfo(name);
	}

	/**
	 * Set the operator status of any session in the managed session directory. The
	 * status is an entry, so the conversation itself is untouched; `null` clears it.
	 */
	async setSessionStatus(path: string, status: SentinelSessionStatus | null): Promise<void> {
		const normalized = this.guardSessionPath(path);
		const data = status ? { status, at: Date.now() } : null;
		// A loaded session owns the live branch, and the toolbar reads the status
		// from that branch. A second handle on the same file would write the entry
		// without the running session seeing it, so write through the owner.
		for (const managed of this.sessions.values()) {
			const file = managed.manager.getSessionFile();
			if (file && resolveFsPath(file) === normalized) {
				managed.manager.appendCustomEntry(SESSION_STATUS_CUSTOM_TYPE, data);
				this.hooks.onStateChange();
				return;
			}
		}
		const manager = SessionManager.open(normalized, this.sessionDir || undefined, this.cwd);
		manager.appendCustomEntry(SESSION_STATUS_CUSTOM_TYPE, data);
	}

	/** Delete a session file. Running sessions and foreign paths are rejected. */
	async deleteSession(path: string): Promise<void> {
		const normalized = this.guardSessionPath(path);
		for (const managed of this.sessions.values()) {
			const file = managed.manager.getSessionFile();
			if (file && resolveFsPath(file) === normalized) {
				if (managed.session.isStreaming) {
					throw new Error(t("该会话正在运行，请先中止再删除"));
				}
				managed.unsubscribe();
				managed.session.dispose();
				this.supervisor.deleteSession(managed.key);
				this.sessions.delete(managed.key);
				if (this.activeKey === managed.key) this.activeKey = undefined;
				break;
			}
		}
		if (!existsSync(normalized)) {
			throw new Error(t("会话文件不存在（可能已被删除）"));
		}
		unlinkSync(normalized);
		// An unloaded session has no ManagedSession to carry its id; the file name
		// carries it (`<timestamp>_<sessionId>.jsonl`), so its audit can go too.
		const file = basename(normalized, ".jsonl");
		const separator = file.lastIndexOf("_");
		if (separator >= 0) this.supervisor.deleteSession(file.slice(separator + 1));
	}

	/** Only files inside the managed session directory may be renamed or deleted. */
	private guardSessionPath(path: string): string {
		const normalized = resolveFsPath(path);
		const dir = resolveFsPath(this.sessionDir);
		if (!normalized.startsWith(`${dir}/`) || !normalized.endsWith(".jsonl")) {
			throw new Error(t("路径不在受管的会话目录内，已拒绝该操作"));
		}
		return normalized;
	}

	getTree(): { tree: SessionTreeNode[]; leafId: string | null; forkPoints: SentinelForkPoint[] } {
		const active = this.active;
		return {
			tree: active?.manager.getTree() ?? [],
			leafId: active?.manager.getLeafId() ?? null,
			// The client pairs these with the transcript's user messages by index,
			// so they have to come from the same branch the transcript does.
			forkPoints: active ? branchUserMessages(active.manager.getBranch()) : [],
		};
	}

	async navigate(entryId: string, summarize?: boolean): Promise<void> {
		const active = this.active;
		if (!active) throw new Error("Session not initialized");
		// Web semantics: navigating to a user message keeps it and branches from
		// it, instead of pi's default rewind-and-re-edit behavior.
		await active.session.navigateTree(
			entryId,
			summarize ? { summarize: true, forkFromUser: true } : { forkFromUser: true },
		);
		this.hooks.onStateChange();
	}

	/** Name a branch point (pi label entry) for readable branch lists. */
	renameBranch(entryId: string, label: string): void {
		const active = this.active;
		if (!active) throw new Error("Session not initialized");
		if (!label.trim()) throw new Error(t("分支名称不能为空"));
		active.manager.appendLabelChange(entryId, label.trim());
	}

	/**
	 * The model screen. The first call persists the legacy-slot migration, so the
	 * three old slots show up as library entries the operator can rename and reuse.
	 */
	getModelLibrary(): SentinelModelLibraryView {
		if (!readStoredModelLibrary(this.agentDir)) writeModelLibrary(this.agentDir, readModelLibrary(this.agentDir));
		return libraryView(this.agentDir);
	}

	/**
	 * Built-in capability templates for the editor. Read-only: the operator
	 * applies them in the form and nothing is written here. The runtime is created
	 * on demand so the catalog is available before any session exists.
	 */
	async lookupModelDefaults(modelId: string, baseUrl: string): Promise<SentinelBuiltinModelDefaults[]> {
		await this.ensureModelRuntime();
		if (!this.modelRuntime) return [];
		return matchBuiltinModelDefaults(
			this.modelRuntime.getModels(),
			modelId,
			baseUrl,
			(providerId) => this.modelRuntime?.getProvider(providerId)?.name ?? providerId,
		);
	}

	/**
	 * Channels for the first picker. A query also matches model names, so an
	 * operator who knows "claude" but not "Anthropic" still lands on the vendor.
	 * Read-only, like the id lookup.
	 */
	async listModelChannels(query: string): Promise<SentinelBuiltinChannel[]> {
		await this.ensureModelRuntime();
		if (!this.modelRuntime) return [];
		return listBuiltinChannels(
			this.modelRuntime.getModels(),
			query,
			(providerId) => this.modelRuntime?.getProvider(providerId)?.name ?? providerId,
		);
	}

	/** The models of one chosen channel, so the second picker stays in-browser. */
	async listChannelModels(provider: string): Promise<SentinelBuiltinModelPreset[]> {
		await this.ensureModelRuntime();
		if (!this.modelRuntime) return [];
		return listBuiltinChannelModels(
			this.modelRuntime.getModels(),
			provider,
			(providerId) => this.modelRuntime?.getProvider(providerId)?.name ?? providerId,
		);
	}

	/**
	 * Create or update one library entry. The cached model runtime is dropped so
	 * the next session creation re-reads models.json and sees a new provider.
	 */
	saveModelEntry(input: {
		id?: string;
		name: string;
		baseUrl: string;
		apiKey: string | null;
		modelId: string;
		capabilities?: SentinelModelCapabilities;
	}): SentinelModelLibraryView {
		if (input.id) {
			updateLibraryEntry(this.agentDir, input.id, {
				name: input.name,
				baseUrl: input.baseUrl,
				apiKey: input.apiKey,
				modelId: input.modelId,
				...(input.capabilities ? { capabilities: input.capabilities } : {}),
			});
		} else {
			addLibraryEntry(this.agentDir, {
				name: input.name,
				baseUrl: input.baseUrl,
				apiKey: input.apiKey ?? "",
				modelId: input.modelId,
				...(input.capabilities ? { capabilities: input.capabilities } : {}),
			});
		}
		this.modelRuntimeDirty = true;
		this.hooks.onStateChange();
		return libraryView(this.agentDir);
	}

	removeModelEntry(id: string): SentinelModelLibraryView {
		removeLibraryEntry(this.agentDir, id);
		this.modelRuntimeDirty = true;
		this.hooks.onStateChange();
		return libraryView(this.agentDir);
	}

	duplicateModelEntry(id: string): SentinelModelLibraryView {
		duplicateLibraryEntry(this.agentDir, id);
		this.modelRuntimeDirty = true;
		this.hooks.onStateChange();
		return libraryView(this.agentDir);
	}

	/** Point a role at an entry (or at 主模型). Takes effect on the next use of the role. */
	setModelRole(role: SentinelModelRoleName, target: string | null): SentinelModelLibraryView {
		setLibraryRole(this.agentDir, role, target);
		this.hooks.onStateChange();
		return libraryView(this.agentDir);
	}

	/** Turning automatic review off also clears the queued backlog. */
	setReviewerAuto(enabled: boolean): SentinelModelLibraryView {
		setReviewerAuto(this.agentDir, enabled);
		if (!enabled) this.vulnerabilities.skipQueuedReviews();
		this.hooks.onStateChange();
		return libraryView(this.agentDir);
	}

	/** Tool permissions plus the inventory of what the live session mounted. */
	getPermissions(): {
		config: SentinelPermissionsConfig;
		effectiveSubagent: SentinelPermissionSet;
		presets: readonly SentinelPermissionPreset[];
		tools: SentinelToolInfo[];
	} {
		const config = readPermissionsConfig(this.agentDir);
		return {
			config,
			effectiveSubagent: effectiveSubagent(config),
			presets: PERMISSION_PRESETS,
			tools: this.listMountedTools(),
		};
	}

	/**
	 * What the viewed session actually has mounted. The permissions screen shows
	 * this so a switch can be checked against reality instead of trusted.
	 */
	private listMountedTools(): SentinelToolInfo[] {
		const session = this.active?.session;
		if (!session) return [];
		const active = new Set(session.getActiveToolNames());
		return session
			.getAllTools()
			.map((tool) => ({
				name: tool.name,
				source: tool.sourceInfo?.source ?? "unknown",
				active: active.has(tool.name),
			}))
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	/**
	 * Apply new permissions and rebuild every live session, because tools are
	 * mounted when a session is created. A running session is refused rather than
	 * disposed: the operator aborts it first, so no work is lost silently.
	 */
	async savePermissions(config: SentinelPermissionsConfig): Promise<void> {
		this.assertNoRunningSession(t("权限"));
		writePermissionsConfig(this.agentDir, config);
		await this.rebuildSessions();
	}

	/**
	 * The preset the viewed session was created with. The name is resolved now
	 * rather than stored, so a renamed preset shows its current name; a preset
	 * that is gone falls back to its id and is flagged as missing, because the
	 * session is then running on the default agent and the badge must not claim
	 * otherwise.
	 */
	private presetView(active: ManagedSession | undefined): SentinelSessionPresetView | null {
		if (!active?.presetId) return null;
		const preset = findPreset(this.agentDir, active.presetId);
		return {
			id: active.presetId,
			name: preset?.name ?? active.presetId,
			missing: active.presetMissing,
			// The hint belongs to the preset, so a session whose preset is gone falls
			// back to the console's default text.
			placeholder: preset?.placeholder ?? "",
		};
	}

	snapshot(): SentinelStateSnapshot {
		const resolvedMain = resolveLibraryRole(this.agentDir, "main");
		const active = this.active;
		const model = active?.session.model;
		const globalMode = readGatekeeperConfig(this.agentDir).mode;
		const sessionMode = this.effectiveMode(active);
		const health = this.gatekeeper.health();
		const gatekeeper: SentinelGatekeeperView = {
			globalMode,
			sessionMode,
			sessionOverride: active?.modeOverride ?? null,
			judgeResolved: toResolvedModelView(resolveLibraryRole(this.agentDir, "judge")),
			failures: health.failures,
			lastFailureAt: health.lastFailureAt,
			lastSuccessAt: health.lastSuccessAt,
			lastError: health.lastError,
		};
		return {
			mode: sessionMode,
			streaming: this.isStreaming,
			cwd: this.cwd,
			project: this.currentProject,
			model: model ? { provider: model.provider, id: model.id } : null,
			modelConfigured: resolvedMain !== null && model !== undefined,
			thinkingLevel: active?.session.thinkingLevel ?? "off",
			availableThinkingLevels: active?.session.getAvailableThinkingLevels() ?? [],
			activeSessionId: this.currentSessionId,
			// The transcript, not `session.messages`: the latter is the model context,
			// from which a compaction removes everything its summary replaced. The
			// live system prompt comes from the context, because it is not an entry.
			messages: active
				? safeClone(withSystemPrompt(branchTranscript(active.manager.getBranch()), active.session.messages))
				: [],
			pendingApprovals: this.approvals.listPending(),
			allowedPrefixes: this.approvals.getAllowedPrefixes(this.activeProjectId ?? null),
			runningSessions: [...this.sessions.values()]
				.filter((managed) => managed.session.isStreaming)
				.map((managed) => managed.key),
			subagents: this.listSubagents(),
			subagentTotal: this.countSubagents(),
			goal: this.goalView(active),
			// The active session's operator status, read from the branch: a status set
			// in the list must show up here without a second file read.
			sessionStatus: active ? readSessionStatus(active.manager.getBranch()) : null,
			preset: this.presetView(active),
			modeling: this.modelingView(active),
			modelingAttached: this.modelingAttachedView(active),
			droidEnabled: active?.droidOn ?? false,
			iosEnabled: active?.iosOn ?? false,
			supervisor: this.activeKey ? this.supervisor.view(this.activeKey) : null,
			supervisorConfig: readSupervisorConfig(this.agentDir),
			gatekeeper,
			compacting: active?.session.isCompacting ?? false,
			compactionStartedAt: active?.compactionStartedAt ?? null,
		};
	}

	private recordSessionUsage(managed: ManagedSession): void {
		try {
			this.sessionUsage.recordEntries(managed.manager.getEntries());
		} catch (error) {
			// Bookkeeping must not turn a successful model call into a failed run.
			console.error(`[sentinel] Failed to retain session usage: ${String(error)}`);
		}
	}

	/** Current-session counters for the composer and durable historical counters for About. */
	getStats(): SentinelStats {
		if (this.active) this.recordSessionUsage(this.active);
		return {
			...(this.active?.session.getSessionStats() ?? {
				sessionFile: undefined,
				sessionId: "",
				userMessages: 0,
				assistantMessages: 0,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: 0,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
			}),
			cumulative: this.sessionUsage.totals(),
		};
	}

	/**
	 * Directory listing of /work. The host side of the mount is read directly;
	 * the container is only consulted for a directory the host user cannot read.
	 */
	async listFiles(path: string): Promise<{ path: string; entries: SentinelFileEntry[] }> {
		return await listFiles(this.cwd, path, { container: this.requireContainer() });
	}

	async readFile(path: string): Promise<SentinelFilePreview> {
		// Evidence records written before submit-time normalization can still hold
		// the host path; preview must resolve that to the same file's /work name.
		const mapped = toContainerWorkPath(path, this.cwd) ?? path;
		return await readFilePreview(this.requireContainer(), mapped);
	}

	async writeFile(path: string, text: string): Promise<{ path: string; size: number }> {
		return await writeFile(this.requireContainer(), path, Buffer.from(text, "utf-8"));
	}

	async uploadFile(path: string, base64: string): Promise<{ path: string; size: number }> {
		return await writeFile(this.requireContainer(), path, Buffer.from(base64, "base64"));
	}

	async downloadFile(path: string): Promise<{ path: string; size: number; data: string }> {
		return await downloadFile(this.requireContainer(), path);
	}

	/**
	 * Validate and describe a folder for the folder-archive job. The actual tar
	 * runs later, in the server's manager, so the container name is captured
	 * here while the request is tied to this project.
	 */
	async prepareFolderArchive(path: string): Promise<{ container: string; path: string; projectName: string }> {
		const container = this.requireContainer();
		return {
			container,
			path: await requireDirectory(container, path),
			projectName: this.snapshot().project?.name ?? "work",
		};
	}

	async deletePath(path: string): Promise<void> {
		await deletePath(this.requireContainer(), path);
	}

	async renamePath(from: string, to: string): Promise<{ from: string; to: string }> {
		return await renamePath(this.requireContainer(), from, to);
	}

	async makeDirectory(path: string): Promise<{ path: string }> {
		return await makeDirectory(this.requireContainer(), path);
	}

	/** Sub-agent runs of the viewed session, newest first, without process steps. */
	listSubagents(limit = 100, offset = 0): SentinelSubagentRun[] {
		const sessionId = this.currentSessionId;
		if (!sessionId) return [];
		return this.subagents.list(sessionId, limit, offset);
	}

	countSubagents(): number {
		const sessionId = this.currentSessionId;
		if (!sessionId) return 0;
		return this.subagents.count(sessionId);
	}

	getSubagent(id: string): SentinelSubagentRun | undefined {
		return this.subagents.get(id);
	}

	async abortSubagent(id: string): Promise<boolean> {
		return await this.subagents.abort(id);
	}

	async steerSubagent(id: string, text: string): Promise<boolean> {
		return await this.subagents.steer(id, text);
	}

	/**
	 * Findings of the active project plus their counts. The hub is project-scoped:
	 * with no project there is nothing to show, not another project's records.
	 */
	listVulns(filters: SentinelVulnFilters = {}): { items: SentinelVulnSummary[]; stats: SentinelVulnStats } {
		const projectId = this.activeProjectId;
		if (!projectId) return { items: [], stats: emptyVulnStats() };
		return { items: this.vulnerabilities.list(projectId, filters), stats: this.vulnerabilities.stats(projectId) };
	}

	/** One finding, by id or by its human-readable label, inside the active project. */
	getVuln(id: string): SentinelVulnerability | undefined {
		const vuln = this.activeProjectId ? this.vulnerabilities.find(this.activeProjectId, id) : undefined;
		// Older records may hold the host work-directory path the file tools use;
		// the hub and its preview only understand the container name.
		return vuln ? evidencePathsToContainer(vuln, this.cwd) : undefined;
	}

	/** Operator review: status, severity, CVSS, or a note. The agent cannot do this. */
	updateVuln(id: string, patch: SentinelVulnUpdate): SentinelVulnerability | undefined {
		const vuln = this.getVuln(id);
		if (!vuln) return undefined;
		const updated = this.vulnerabilities.update(vuln.id, patch);
		if (updated) this.hooks.onVulnChange();
		return updated ? evidencePathsToContainer(updated, this.cwd) : undefined;
	}

	/**
	 * How much deleting these findings would take with them. The confirmation
	 * dialog shows these counts, so the operator sees the evidence and notes that
	 * disappear with the records.
	 */
	previewVulnDelete(ids: readonly string[]): { count: number; evidence: number; notes: number } {
		if (!this.activeProjectId) return { count: 0, evidence: 0, notes: 0 };
		return this.vulnerabilities.deletePreview(this.activeProjectId, ids);
	}

	/** True on the one startup that added the provenance columns. */
	needsVulnProvenanceBackfill(): boolean {
		return this.vulnerabilities.needsProvenanceBackfill();
	}

	/** Delete findings of the active project; returns how many records went. */
	deleteVulns(ids: readonly string[]): number {
		if (!this.activeProjectId) return 0;
		const deleted = this.vulnerabilities.deleteMany(this.activeProjectId, ids);
		if (deleted > 0) this.hooks.onVulnChange();
		return deleted;
	}

	/**
	 * One-time fill of 工程/任务/会话名 for findings submitted before those columns
	 * existed. The caller supplies the session→engine/task mapping (only the engine
	 * service knows it); this side adds the session names it can still read.
	 */
	async backfillVulnProvenance(
		engineRefs: ReadonlyMap<string, { engineId: string; taskId: string }>,
	): Promise<number> {
		const names = new Map<string, string>();
		for (const project of listProjects(this.agentDir).projects) {
			try {
				const sessions = await SessionManager.list(
					project.workDir,
					getDefaultSessionDir(project.workDir, this.agentDir),
				);
				for (const session of sessions) {
					if (session.name) names.set(session.id, session.name);
				}
			} catch {
				// A project whose sessions cannot be listed simply contributes no names.
			}
		}
		return this.vulnerabilities.backfillEngineRefs(engineRefs) + this.vulnerabilities.backfillSessionNames(names);
	}

	/**
	 * Ids of the active project's still-pending findings: the scope of the hub's
	 * "re-review everything pending" button. Records the operator already moved
	 * on from are never handed to the reviewer.
	 */
	pendingVulnIds(): string[] {
		const projectId = this.activeProjectId;
		if (!projectId) return [];
		return this.vulnerabilities.list(projectId, { status: "pending" }).map((summary) => summary.id);
	}

	/** Markdown report of the active project's findings. */
	exportVulns(filters: SentinelVulnFilters = {}): { filename: string; markdown: string } {
		const projectId = this.activeProjectId;
		const summaries = projectId ? this.vulnerabilities.list(projectId, filters) : [];
		const vulns = summaries
			.map((summary) => this.vulnerabilities.get(summary.id))
			.filter((vuln): vuln is SentinelVulnerability => vuln !== undefined)
			.map((vuln) => evidencePathsToContainer(vuln, this.cwd));
		return buildVulnReport({
			projectId: projectId ?? "",
			projectName: this.activeProjectName ?? t("未命名项目"),
			vulns,
		});
	}

	// --- 资产库（Agent 上报的资产台账） ---

	/** Page of the active project's inventory plus project-wide counts. */
	listAssets(
		filters: SentinelAssetFilters = {},
		page = 1,
		pageSize = 50,
	): {
		items: SentinelAssetSummary[];
		stats: SentinelAssetStats;
		total: number;
		page: number;
		pageSize: number;
		hasMore: boolean;
	} {
		const projectId = this.activeProjectId;
		if (!projectId) {
			return {
				items: [],
				stats: emptyAssetStats(),
				total: 0,
				page: 1,
				pageSize: Math.max(1, pageSize),
				hasMore: false,
			};
		}
		return {
			...this.assetLibrary.list(projectId, filters, page, pageSize),
			stats: this.assetLibrary.stats(projectId),
		};
	}

	/** One asset with its full timeline and the findings linked to it. */
	getAsset(id: string): SentinelAssetDetail | undefined {
		const projectId = this.activeProjectId;
		if (!projectId) return undefined;
		const asset = this.assetLibrary.find(projectId, id);
		if (!asset) return undefined;
		return { asset, vulns: this.vulnerabilities.listByAsset(projectId, asset.id) };
	}

	/** Operator edit: status, tags, or one record. The agent writes through its tools. */
	updateAsset(id: string, patch: SentinelAssetUpdate): SentinelAssetDetail | undefined {
		const projectId = this.activeProjectId;
		if (!projectId) return undefined;
		const existing = this.assetLibrary.find(projectId, id);
		if (!existing) return undefined;
		const updated = this.assetLibrary.update(existing.id, patch);
		if (!updated) return undefined;
		this.hooks.onAssetChange();
		return { asset: updated, vulns: this.vulnerabilities.listByAsset(projectId, updated.id) };
	}

	/** What deleting these assets would take: timeline rows and linked findings. */
	previewAssetDelete(ids: readonly string[]): SentinelAssetDeletePreview {
		const projectId = this.activeProjectId;
		if (!projectId) return { count: 0, records: 0, vulns: 0 };
		return {
			...this.assetLibrary.deletePreview(projectId, ids),
			vulns: this.vulnerabilities.countLinkedToAssets(projectId, ids),
		};
	}

	/**
	 * Delete inventory rows of the active project. Linked findings survive: the
	 * link is cleared first, then the asset and its timeline go.
	 */
	deleteAssets(ids: readonly string[]): number {
		const projectId = this.activeProjectId;
		if (!projectId) return 0;
		const existed = this.assetLibrary.deletePreview(projectId, ids).count;
		if (existed === 0) return 0;
		const unlinked = this.vulnerabilities.unlinkAssets(projectId, ids);
		const deleted = this.assetLibrary.deleteMany(projectId, ids);
		if (deleted > 0) this.hooks.onAssetChange();
		if (unlinked > 0) this.hooks.onVulnChange();
		return deleted;
	}

	/** Markdown inventory of every asset matching the filter; never a partial page. */
	exportAssets(filters: SentinelAssetFilters = {}): { filename: string; markdown: string } {
		const projectId = this.activeProjectId;
		const projectName = this.activeProjectName ?? t("未命名项目");
		const assets: SentinelAsset[] = [];
		if (projectId) {
			// Export is complete, not a page: walk every page until the store says
			// there is no more. The page size is a query detail, not a cap.
			for (let page = 1; ; page += 1) {
				const view = this.assetLibrary.list(projectId, filters, page, MAX_ASSET_PAGE_SIZE);
				for (const summary of view.items) {
					const asset = this.assetLibrary.get(summary.id);
					if (asset) assets.push(asset);
				}
				// A concurrent deletion can make a page empty while total still says
				// there is more; stop rather than loop on the same offset.
				if (!view.hasMore || view.items.length === 0) break;
			}
		}
		return buildAssetReport({
			projectName,
			assets,
			vulnsByAsset: projectId ? this.vulnerabilities.linkedByAsset(projectId) : new Map(),
		});
	}

	/** How many inventory rows a project holds, for the delete dialog. */
	countProjectAssets(projectId: string): number {
		return this.assetLibrary.countByProject(projectId);
	}

	/** Deleting a project deletes its inventory and clears any surviving links. */
	purgeProjectAssetLibrary(projectId: string): number {
		const deleted = this.assetLibrary.deleteByProject(projectId);
		// The server's project deletion also purges the hub, but this method's
		// contract is that no dangling asset link survives it either way.
		this.vulnerabilities.unlinkAllAssets(projectId);
		if (deleted > 0) this.hooks.onAssetChange();
		return deleted;
	}

	// --- POC 订阅（远程 zip 源；设置页管理，库只增不减） ---

	listPocSources(): SentinelPocSource[] {
		return this.subscriptions.list();
	}

	savePocSource(input: SentinelPocSourceSave): { source: SentinelPocSource } | { error: string } {
		return this.subscriptions.save(input);
	}

	deletePocSource(id: string): boolean {
		return this.subscriptions.delete(id);
	}

	async syncPocSource(id: string): Promise<{ source: SentinelPocSource } | { error: string }> {
		return this.subscriptions.sync(id, "manual");
	}

	/** The one-click official sync: make sure the built-in source exists, then sync it. */
	async syncOfficialPocs(): Promise<{ source: SentinelPocSource } | { error: string }> {
		const ensured = this.subscriptions.ensureOfficial();
		return this.subscriptions.sync(ensured.source.id, "manual");
	}

	/** A failed sync pushes DingTalk once per attempt, gated by the pocs kind. */
	private notifyPocSyncFailure(source: SentinelPocSource, record: SentinelPocSyncRecord): void {
		const config = readNotifyConfig(this.agentDir);
		if (!hasEnabledNotifyChannel(config) || !config.kinds.pocs) return;
		const title = `POC 订阅同步失败：${source.name}`;
		const markdown = [
			`### ${title}`,
			"",
			`- 来源：${source.name}（${source.url}）`,
			`- 时间：${record.at.slice(0, 19).replace("T", " ")}`,
			`- 耗时：${(record.durationMs / 1000).toFixed(1)}s`,
			`- 原因：${record.error ?? "未知错误"}`,
			"",
			"请在 设置 → POC 订阅 检查该源，或点「立即同步」重试。",
		].join("\n");
		void sendNotifications(config, title, markdown).then((result) => {
			this.notifyStatus = { ...result, subject: title };
			this.hooks.onNotifyStatus(this.notifyStatus);
		});
	}

	// --- POC 库（只读模板中心；导入与删除是操作员动作，不经过 agent） ---

	/** The library is global, not per project: templates are reference material. */
	listPocs(
		filters: SentinelPocFilters = {},
		page = 1,
		pageSize = LIST_CAP,
	): {
		items: SentinelPocSummary[];
		total: number;
		page: number;
		pageSize: number;
		stats: SentinelPocStats;
	} {
		return { ...this.pocs.list(filters, page, pageSize), stats: this.pocs.stats() };
	}

	getPoc(id: string): SentinelPoc | undefined {
		return this.pocs.get(id);
	}

	/**
	 * Import operator-uploaded bytes. The HTTP layer streams the request to disk
	 * first; this method yields between chunks so the console stays responsive
	 * while a large archive is unpacked and written.
	 */
	async importPocBytes(
		files: { name: string; bytes: Buffer }[],
		options: PocImportOptions = {},
	): Promise<SentinelPocImportOutcome> {
		const outcome = await this.pocs.importAsync(files, options);
		this.hooks.onPocChange();
		return outcome;
	}

	deletePoc(id: string): boolean {
		const deleted = this.pocs.delete(id);
		if (deleted) this.hooks.onPocChange();
		return deleted;
	}

	/** How many findings a project holds, so its deletion can state what it takes with it. */
	countProjectVulns(projectId: string): number {
		return this.vulnerabilities.countByProject(projectId);
	}

	/** Deleting a project deletes its findings: they cannot outlive their target scope. */
	purgeProjectVulns(projectId: string): number {
		const deleted = this.vulnerabilities.deleteByProject(projectId);
		if (deleted > 0) this.hooks.onVulnChange();
		return deleted;
	}

	dispose(): void {
		this.approvals.rejectAll("shutdown");
		for (const managed of this.sessions.values()) {
			this.recordSessionUsage(managed);
			managed.unsubscribe();
			managed.session.dispose();
		}
		this.sessions.clear();
		this.activeKey = undefined;
		this.subagentStore.close();
		this.vulnerabilities.close();
		this.reports.close();
		this.pocs.close();
		this.apiModels.close();
		this.droids.close();
		this.ios.close();
		this.captures.close();
		this.assets.close();
		this.assetLibrary.close();
		this.webSearchLog.close();
		this.sessionUsage.close();
		this.subscriptions.stop();
		this.supervisor.close();
		this.gateStore.close();
	}
}

/**
 * Whether a live session already runs an equivalent model. Comparing the whole
 * definition (not just provider/id) is what lets a capability-only edit reach a
 * session that was created before the edit.
 */
function sameModelDefinition(current: Model<Api> | undefined, next: Model<Api>): boolean {
	if (!current) return false;
	return (
		current.provider === next.provider &&
		current.id === next.id &&
		current.api === next.api &&
		current.baseUrl === next.baseUrl &&
		current.reasoning === next.reasoning &&
		current.contextWindow === next.contextWindow &&
		current.maxTokens === next.maxTokens &&
		current.input.join(",") === next.input.join(",") &&
		JSON.stringify(current.cost) === JSON.stringify(next.cost) &&
		JSON.stringify(current.promptCache) === JSON.stringify(next.promptCache)
	);
}

/** First operator instruction, used as the notification subject when unnamed. */
function firstUserText(messages: readonly unknown[]): string | undefined {
	for (const message of messages) {
		if ((message as { role?: string }).role !== "user") continue;
		const text = messageText(message as { content?: unknown }).trim();
		if (text) return text.slice(0, 80);
	}
	return undefined;
}

/** Token and cost counters of a session, in the shape a goal stores them. */
function usageOf(stats: SessionStats | undefined): SentinelGoalUsage {
	if (!stats) return emptyUsage();
	return {
		input: stats.tokens.input,
		output: stats.tokens.output,
		total: stats.tokens.total,
		cost: typeof stats.cost === "number" ? stats.cost : null,
	};
}

/**
 * The loop-guard trims a stuttering output at the cut and leaves this marker in
 * the assistant message, which is how an abort by the guard is told apart from
 * one by the operator: both end the run the same way.
 */
const LOOP_GUARD_STUTTER_MARKER = "[输出因重复被中止，尾部已截断]";
/**
 * Consecutive stutter aborts after which the goal stands down anyway. The
 * loop-guard stops nudging at three, so past that the model is repeating no
 * matter what the nudges say and only the operator can break the loop.
 */
const STUTTER_PAUSE_LIMIT = 3;

/** Whether the run that just settled was cut by the loop-guard's stutter guard. */
function isStutterAbort(managed: ManagedSession): boolean {
	return lastAssistantText(managed.session.messages)?.includes(LOOP_GUARD_STUTTER_MARKER) === true;
}

/**
 * The project whose work directory is `cwd`, or undefined when no registered
 * project owns it. Exported for tests: this is what binds a reopened
 * conversation to the project it was created in.
 */
export function resolveSessionProject(
	projects: readonly SentinelProject[],
	cwd: string,
): { id: string; name: string } | undefined {
	const resolved = resolveFsPath(cwd);
	const project = projects.find((item) => resolveFsPath(item.workDir) === resolved);
	return project ? { id: project.id, name: project.name } : undefined;
}

/** Closing prose of the last assistant message, for the round summary fallback. */
function lastAssistantText(messages: readonly unknown[]): string | undefined {
	const last = [...messages].reverse().find((message) => (message as { role?: string }).role === "assistant");
	return last ? messageText(last as { content?: unknown }) : undefined;
}

function lastAssistantStopReason(messages: readonly unknown[]): string | undefined {
	const last = [...messages].reverse().find((message) => (message as { role?: string }).role === "assistant");
	return (last as { stopReason?: string } | undefined)?.stopReason;
}

/** JSON-clone the message list, dropping it entirely when it is not serializable. */
function safeClone(value: unknown): unknown[] {
	try {
		const cloned = JSON.parse(JSON.stringify(value ?? null)) as unknown;
		return Array.isArray(cloned) ? cloned : [];
	} catch {
		return [];
	}
}
