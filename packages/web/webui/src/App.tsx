import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Empty } from "antd";
import type { CodeVulnTag } from "../../src/code-vuln-tags.ts";
import { AboutPage } from "./components/AboutPage.tsx";
import { ReportCenterPage } from "./components/ReportCenterPage.tsx";
import { ApiModelPage } from "./components/ApiModelPage.tsx";
import { ApprovalQueue } from "./components/ApprovalQueue.tsx";
import { AuthGate } from "./components/AuthGate.tsx";
import { ConsoleShell } from "./shell/ConsoleShell.tsx";
import type { PluginNavEntry } from "./shell/navigation.tsx";
import { ConsentGate } from "./components/ConsentGate.tsx";
import { PageBoundary } from "./components/PageBoundary.tsx";
import { BranchModal } from "./components/BranchModal.tsx";
import { ChatToolbar } from "./components/ChatToolbar.tsx";
import { Composer } from "./components/Composer.tsx";
import { DroidPage } from "./components/DroidPage.tsx";
import { DashboardPage } from "./components/DashboardPage.tsx";
import { IosPage } from "./components/IosPage.tsx";
import { EnginePage } from "./components/EnginePage.tsx";
import { EnvironmentPanel } from "./components/EnvironmentPanel.tsx";
import { FilePanel, type FilePanelState, type FolderArchiveState, saveDownload } from "./components/FilePanel.tsx";
import { TerminalPanel } from "./components/TerminalPanel.tsx";
import { publishTerminal } from "./terminal-bus.ts";
import { GateAuditPage } from "./components/GateAuditPage.tsx";
import { GoalBar } from "./components/GoalBar.tsx";
import { GoalStartDialog } from "./components/GoalStartDialog.tsx";
import { AgentEntry, formatTime, MarkdownText, MessageView } from "./components/MessageView.tsx";
import { AssetPanel } from "./components/AssetPanel.tsx";
import { WebSearchPanel } from "./components/WebSearchPanel.tsx";
import { McpPanel } from "./components/McpPanel.tsx";
import { MitmPage } from "./components/MitmPage.tsx";
import { WebFuzzPage } from "./components/WebFuzzPage.tsx";
import { NotifyPanel } from "./components/NotifyPanel.tsx";
import { Overlay } from "./components/Overlay.tsx";
import { PermissionsPanel } from "./components/PermissionsPanel.tsx";
import { PluginPanel } from "./components/PluginPanel.tsx";
import { PluginUiOverlay, type PluginUiCallResult, type PluginUiContext } from "./components/PluginUiOverlay.tsx";
import { CodeIntelPage, type BranchProbe } from "./components/CodeIntelPage.tsx";
import { CodeActivityRequest } from "./code-activity-request.ts";
import { PocPage } from "./components/PocPage.tsx";
import { PocSourcesPanel } from "./components/PocSourcesPanel.tsx";
import { type PresetImportNotice, PresetPanel } from "./components/PresetPanel.tsx";
import { ProjectGate } from "./components/ProjectGate.tsx";
import { ProjectsPage } from "./components/ProjectsPage.tsx";
import { ProxyPage } from "./components/ProxyPage.tsx";
import { RunFold } from "./components/RunFold.tsx";
import { SecurityPanel } from "./components/SecurityPanel.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { SubagentPanel } from "./components/SubagentPanel.tsx";
import { SupervisorAuditPage } from "./components/SupervisorAuditPage.tsx";
import { SupervisorSettingsPanel } from "./components/SupervisorSettingsPanel.tsx";
import { SupervisorFloatingWindow } from "./components/SupervisorFloatingWindow.tsx";
import { AssetLibraryPage } from "./components/AssetLibraryPage.tsx";
import { OutputViewer, ToolCard } from "./components/ToolCard.tsx";
import { VulnDetail, VulnPage } from "./components/VulnPage.tsx";
import { groupRuns, messageKey, runFoldState, textFromContent } from "./transcript.ts";
import type {
	AgentMessageView,
	DroidDevice,
	DroidToken,
	IosDevice,
	IosToken,
	SessionEventView,
	SessionInfoView,
	SessionTreeNodeView,
	SentinelApiModel,
	SentinelApiModelEvent,
	SentinelApiModelFilters,
	SentinelApiModelSummary,
	SentinelAssetConfigView,
	SentinelAssetDeletePreview,
	SentinelAssetDetail,
	SentinelAssetFilters,
	SentinelAssetStats,
	SentinelAssetSummary,
	SentinelAssetUpdate,
	SentinelBuiltinChannel,
	SentinelBuiltinModelDefaults,
	SentinelBuiltinModelPreset,
	SentinelWebSearchConfigView,
	SentinelAssetPlatform,
	SentinelClientMessage,
	SentinelCodeActivityFilter,
	SentinelCodeCheckJob,
	SentinelCodeCheckLog,
	SentinelVulnCategory,
	SentinelCodeActivityView,
	SentinelCodeCommit,
	SentinelCodeImportState,
	SentinelCodeMonitor,
	SentinelCodeMonitorDetail,
	SentinelCodeMonitorInput,
	SentinelDoctrineView,
	SentinelEngine,
	SentinelEnvReport,
	SentinelFileEntry,
	SentinelFilePreview,
	SentinelForkPoint,
	SentinelGateDecision,
	SentinelGateApproval,
	SentinelGateFilter,
	SentinelGatekeeperConfig,
	SentinelGateStats,
	SentinelMode,
	SentinelModelLibraryView,
	SentinelNotifyConfig,
	SentinelNotifyStatus,
	SentinelPageId,
	SentinelPermissionPreset,
	SentinelPermissionSet,
	SentinelPermissionsConfig,
	SentinelPoc,
	SentinelPocFilters,
	SentinelPocImportProgress,
	SentinelPocImportOutcome,
	SentinelPocSource,
	SentinelPocSourceSave,
	SentinelProxyConfigView,
	SentinelProxyInput,
	SentinelPocStats,
	SentinelPocSummary,
	SentinelMcpConfigView,
	SentinelMcpServerInput,
	SentinelMcpTestResult,
	SentinelPluginArtifactsView,
	SentinelPluginHostInput,
	SentinelPluginLogsView,
	SentinelOfficialPluginView,
	SentinelPluginManifestView,
	SentinelPluginView,
	SentinelPluginsView,
	SentinelPresetView,
	SentinelProjectInfo,
	SentinelServerMessage,
	SentinelStateSnapshot,
	SentinelStatsView,
	SentinelSubagentEvent,
	SentinelSubagentRun,
	SentinelSupervisorAdvice,
	SentinelSupervisorAuditPage,
	SentinelSupervisorConfig,
	SentinelSupervisorDetail,
	SentinelSupervisorEpisode,
	SentinelSupervisorLog,
	SentinelSupervisorMode,
	SentinelSupervisorView,
	SentinelTestResult,
	SentinelToolInfo,
	SentinelVulnFilters,
	SentinelVulnStats,
	SentinelVulnSummary,
	SentinelVulnUpdate,
} from "./types.ts";
import { EMPTY_PROXY_CONFIG, SENTINEL_OFFICIAL_POC_SOURCE_ID } from "./types.ts";
import {
	mergePocImportOutcomes,
	POC_UPLOAD_MAX_BYTES,
	uploadPocFile,
	waitForPocImport,
} from "./poc-import.ts";
import { ProjectAction } from "./project-actions.ts";
import { SentinelConnection } from "./ws.ts";
import { VulnDetailRequest, type VulnDetailView } from "./vuln-detail-request.ts";
import { useDetailRequest } from "./detail-request.ts";
import { getLanguage, storeLanguage, t } from "./i18n.ts";

/**
 * Start a browser download from the authenticated archive route. The server
 * sets Content-Disposition; `download` keeps the filename when the browser
 * ignores the header.
 */
function downloadFolderArchive(id: string, filename: string): void {
	const anchor = document.createElement("a");
	anchor.href = `/api/folder-archives/${encodeURIComponent(id)}`;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
}

interface LiveTool {
	id: string;
	name: string;
	command: string;
	status: "running" | "done" | "error";
	output: string;
	startedAt: number;
	durationMs?: number;
}

const CODE_DISPATCHING_PATCH: Partial<SentinelCodeCommit> = { status: "dispatching", reproductionStage: "git", error: null };

function commandFromArgs(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const command = args.command ?? args.cmd ?? args.script;
	if (typeof command === "string") return command;
	// File tools name their target in `path`; dumping the whole argument object
	// would print file contents into the summary row.
	const path = args.path ?? args.file_path ?? args.filePath;
	if (typeof path === "string") return path;
	return JSON.stringify(args);
}

/** Command of the tool call a result message answers, when the transcript has it. */
/**
 * How long the round a goal continuation marker closed took: from the previous
 * boundary (an operator prompt or an earlier round marker) to this marker.
 * Returns undefined when the timestamps needed are missing.
 */
/**
 * Whether the operator sent anything after the goal ended: the terminal badge
 * belongs to the goal's stretch, not to whatever conversation followed it.
 */
function chattedAfterGoalEnd(messages: unknown[], goal: { endedAt?: number }): boolean {
	const endedAt = goal.endedAt;
	if (!endedAt) return false;
	return messages.some(
		(entry) =>
			(entry as { role?: string }).role === "user" && ((entry as { timestamp?: number }).timestamp ?? 0) > endedAt,
	);
}

/** Compact total duration for the terminal goal badge. */
function formatGoalTotalMs(ms: number): string {
	const minutes = Math.round(ms / 60000);
	if (minutes < 60) return t("{minutes} 分", { minutes });
	return t("{hours} 时 {minutes} 分", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

function goalMarkerElapsed(messages: unknown[], marker: AgentMessageView): number | undefined {
	const markerTime = (marker as { timestamp?: number }).timestamp;
	const index = messages.findIndex(
		(entry) =>
			(entry as { customType?: string }).customType === "zg-goal" &&
			messageKey(entry as { role?: string; timestamp?: number }) ===
				messageKey(marker as { role?: string; timestamp?: number }),
	);
	if (index <= 0 || markerTime === undefined) return undefined;
	for (let i = index - 1; i >= 0; i -= 1) {
		const entry = messages[i] as { role?: string; customType?: string; timestamp?: number };
		if (entry.role === "user" || entry.customType === "zg-goal") {
			if (!entry.timestamp) return undefined;
			return Math.max(0, markerTime - entry.timestamp);
		}
	}
	return undefined;
}

function toolCommandOf(message: AgentMessageView, commands: Map<string, string>): string | undefined {
	return message.role === "toolResult" ? commands.get(message.toolCallId) : undefined;
}

/** Whether an assistant turn carries something to render on its own. */
function hasVisibleAssistantContent(message: AgentMessageView): boolean {
	if (message.role !== "assistant") return true;
	if (message.errorMessage) return true;
	return message.content.some((block) => {
		const typed = block as { type?: string; text?: string; thinking?: string };
		return (
			(typed.type === "text" && (typed.text ?? "").length > 0) ||
			(typed.type === "thinking" && (typed.thinking ?? "").length > 0)
		);
	});
}

export function App() {
	const [snapshot, setSnapshot] = useState<SentinelStateSnapshot | null>(null);
	const [sessions, setSessions] = useState<SessionInfoView[]>([]);
	const [notifyConfig, setNotifyConfig] = useState<SentinelNotifyConfig>({ groups: [], summaryLimit: 2000 });
	const [notifyStatus, setNotifyStatus] = useState<SentinelNotifyStatus>({ at: null, ok: true });
	const notifyAvailable = notifyConfig.groups.some(
		(group) => group.enabled && group.kinds.runs && group.targets.some((target) => target.enabled && target.webhook.trim()),
	);
	const [assetConfig, setAssetConfig] = useState<SentinelAssetConfigView | null>(null);
	const [assetBusy, setAssetBusy] = useState(false);
	const [webSearchConfig, setWebSearchConfig] = useState<SentinelWebSearchConfigView | null>(null);
	const [webSearchBusy, setWebSearchBusy] = useState(false);
	const webSearchTestResolverRef = useRef<((result: SentinelTestResult | null) => void) | null>(null);
	const [mcpConfig, setMcpConfig] = useState<SentinelMcpConfigView | null>(null);
	const [mcpBusy, setMcpBusy] = useState(false);
	const [pluginsView, setPluginsView] = useState<SentinelPluginsView | null>(null);
	const [pluginsBusy, setPluginsBusy] = useState(false);
	const [pluginLogs, setPluginLogs] = useState<SentinelPluginLogsView | null>(null);
	const [pluginArtifacts, setPluginArtifacts] = useState<SentinelPluginArtifactsView | null>(null);
	const [pendingManifest, setPendingManifest] = useState<SentinelPluginManifestView | null>(null);
	const [pendingPackage, setPendingPackage] = useState<string | null>(null);
	const [pendingOfficial, setPendingOfficial] = useState<SentinelOfficialPluginView | null>(null);
	const [officialPlugins, setOfficialPlugins] = useState<SentinelOfficialPluginView[]>([]);
	const [pluginBuildLog, setPluginBuildLog] = useState<{
		hostId: string;
		pluginId: string;
		log: string;
	} | null>(null);
	const [pluginUi, setPluginUi] = useState<{
		plugin: SentinelPluginView;
		nonce: string;
		token: string;
	} | null>(null);
	const [pluginPage, setPluginPage] = useState<{
		plugin: SentinelPluginView;
		nonce: string;
		token: string;
	} | null>(null);
	const pendingPluginUi = useRef<{
		plugin: SentinelPluginView;
		nonce: string;
		mode: "overlay" | "page";
	} | null>(null);
	const pluginUiResolvers = useRef(
		new Map<string, (message: Extract<SentinelServerMessage, { type: "plugin_ui_result" }>) => void>(),
	);
	const [pluginNotice, setPluginNotice] = useState<string | null>(null);
	const pendingInstallRef = useRef<{ hostId: string; pluginId: string } | null>(null);
	const [permissions, setPermissions] = useState<SentinelPermissionsConfig | null>(null);
	const [permissionPresets, setPermissionPresets] = useState<SentinelPermissionPreset[]>([]);
	const [permissionTools, setPermissionTools] = useState<SentinelToolInfo[]>([]);
	const [permissionEffective, setPermissionEffective] = useState<SentinelPermissionSet | null>(null);
	const [permissionBusy, setPermissionBusy] = useState(false);
	/**
	 * Composer choice for the next run: true/false once the operator toggles the
	 * pill, null while it simply follows the global switch.
	 */
	const [notifyRun, setNotifyRun] = useState<boolean | null>(null);
	const [stats, setStats] = useState<SentinelStatsView | null>(null);
	/**
	 * Output speed of the latest run, accumulated from assistant message usage.
	 * It is keyed by session so switching conversations cannot show another
	 * session's speed.
	 */
	const [runThroughput, setRunThroughput] = useState<{
		sessionId: string | null;
		tokPerSec: number;
		outputTokens: number;
		durationMs: number;
	} | null>(null);
	const [liveText, setLiveText] = useState("");
	const [liveThinking, setLiveThinking] = useState("");
	const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
	/**
	 * Messages the event stream has already committed but the snapshot does not
	 * carry yet. A run only refreshes the snapshot when it settles, so without
	 * this the assistant's text would vanish at every message_end and the
	 * transcript would read as a jumble until a manual refresh.
	 */
	const [pendingMessages, setPendingMessages] = useState<AgentMessageView[]>([]);
	/** Runs the operator opened by hand; they stay open instead of re-folding. */
	const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
	const [errors, setErrors] = useState<string[]>([]);
	/** The one page the content area shows; navigation lives in the sider. */
	const [page, setPage] = useState<SentinelPageId>("dashboard");
	const [reportRefresh, setReportRefresh] = useState(0);
	const [webFuzzImport, setWebFuzzImport] = useState<{ projectId: string; flowId: string } | null>(null);
	/**
	 * Console authentication: the console renders only once the session is
	 * confirmed; otherwise the login (or first-run setup) screen replaces it.
	 */
	const [authState, setAuthState] = useState<"checking" | "ready" | "setup" | "login" | "consent">("checking");
	const [authUser, setAuthUser] = useState<string | null>(null);
	/** Overlays opened from the chat toolbar. */
	const [filesOpen, setFilesOpen] = useState(false);
	const [subagentsOpen, setSubagentsOpen] = useState(false);
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("sentinel-sidebar-collapsed") === "1");
	// The branch tree is a modal now, so it starts closed.
	const [branchOpen, setBranchOpen] = useState(() => localStorage.getItem("sentinel-branch-open") === "1");
	const [projects, setProjects] = useState<SentinelProjectInfo[]>([]);
	const [activeProject, setActiveProject] = useState<SentinelProjectInfo | null>(null);
	const [projectAction] = useState(() => new ProjectAction());
	const [tree, setTree] = useState<SessionTreeNodeView[]>([]);
	const [leafId, setLeafId] = useState<string | null>(null);
	const [forkPoints, setForkPoints] = useState<SentinelForkPoint[]>([]);
	const [viewer, setViewer] = useState<{ title: string; output: string } | null>(null);
	/** The persistent-goal start dialog. It is only reachable in auto mode. */
	const [goalOpen, setGoalOpen] = useState(false);
	const [connected, setConnected] = useState(false);
	const [connectionWarning, setConnectionWarning] = useState(false);
	/**
	 * Whether the active session is running right now. The server only broadcasts a
	 * snapshot when a run starts and ends, so the events are what keep this current
	 * during a run; every snapshot then re-states it authoritatively.
	 */
	const [runActive, setRunActive] = useState(false);
	/** Docker environment report: the console is locked while it is missing or failing. */
	const [envReport, setEnvReport] = useState<SentinelEnvReport | null>(null);
	const [imageBuilding, setImageBuilding] = useState(false);
	const [buildLog, setBuildLog] = useState<string[]>([]);
	const [sourcesSavedAt, setSourcesSavedAt] = useState<number | null>(null);
	const [containerNetworkSavedAt, setContainerNetworkSavedAt] = useState<number | null>(null);
	const [proxyConfig, setProxyConfig] = useState<SentinelProxyConfigView | null>(null);
	/**
	 * The 代理 page's own action slot. Every proxy mutation answers with exactly one
	 * `proxy_config` — carrying `error` when it was refused — so the page's form is
	 * released by that message and not by an unrelated projects broadcast.
	 */
	const [proxyAction] = useState(() => new ProjectAction());
	/** The profile whose subscription is being re-read, for the picker's button. */
	const [refreshingProxyId, setRefreshingProxyId] = useState<string | null>(null);
	/** The profile whose nodes are being measured, for the node dialog's button. */
	const [testingProxyId, setTestingProxyId] = useState<string | null>(null);
	// The page's own messages arrive before the environment check they trigger, so
	// whichever landed last is what the 代理 page shows.
	const proxyView = proxyConfig ?? envReport?.proxies ?? EMPTY_PROXY_CONFIG;
	/** A `docker pull` of the sing-box image is in flight. */
	const [pullingSingboxImage, setPullingSingboxImage] = useState(false);
	/** Messages sent from this console, shown optimistically until the snapshot absorbs them. */
	const [optimisticUserMessages, setOptimisticUserMessages] = useState<
		{ text: string; imageCount: number; userCountAtSend: number }[]
	>([]);
	/** Queued steering/follow-up texts reported by queue_update events. */
	const [queuedMessages, setQueuedMessages] = useState<{ kind: "steer" | "followUp"; text: string }[]>([]);
	const [filePath, setFilePath] = useState("/work");
	const [fileEntries, setFileEntries] = useState<SentinelFileEntry[]>([]);
	const [filePreview, setFilePreview] = useState<SentinelFilePreview | null>(null);
	const [fileBusy, setFileBusy] = useState(false);
	/** The async folder archive shown in the file panel; survives closing the panel. */
	const [folderArchive, setFolderArchive] = useState<FolderArchiveState | null>(null);
	const folderArchiveRef = useRef<FolderArchiveState | null>(null);
	/** Loaded process steps per sub-agent run; a run absent here is not expanded. */
	const [subagentTranscripts, setSubagentTranscripts] = useState<Record<string, SentinelSubagentEvent[]>>({});
	const [subagentPage, setSubagentPage] = useState<{
		runs: SentinelSubagentRun[];
		offset: number;
		total: number;
	} | null>(null);
	/** Vulnerability hub: the active project's findings, its counts, and the current filter. */
	const [vulnItems, setVulnItems] = useState<SentinelVulnSummary[]>([]);
	/** The filters the page is showing, readable from message handlers. */
	const vulnFiltersRef = useRef<SentinelVulnFilters>({});
	const [vulnStats, setVulnStats] = useState<SentinelVulnStats>({
		total: 0,
		bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
		byStatus: { pending: 0, confirmed: 0, false_positive: 0, fixed: 0 },
	});
	const [vulnFilters, setVulnFilters] = useState<SentinelVulnFilters>({});
	/** The record the detail overlay shows, and the evidence file it is previewing. */
	const [vulnView, setVulnView] = useState<VulnDetailView | null>(null);
	const vulnDetailRequest = useMemo(() => new VulnDetailRequest(setVulnView), []);
	const vulnDetail = vulnView?.vuln ?? null;
	/** Ids awaiting the batch-delete confirmation, and the impact the server reported. */
	const [vulnDeletePending, setVulnDeletePending] = useState<string[] | null>(null);
	const [vulnDeletePreview, setVulnDeletePreview] = useState<{
		count: number;
		evidence: number;
		notes: number;
	} | null>(null);
	/** Asset inventory: paged list, project-wide counts, filters and open detail. */
	const [assetItems, setAssetItems] = useState<SentinelAssetSummary[]>([]);
	const [assetStats, setAssetStats] = useState<SentinelAssetStats>({
		total: 0,
		byKind: { domain: 0, ip: 0, service: 0, url: 0 },
		byStatus: { pending: 0, testing: 0, tested: 0, out_of_scope: 0 },
		tested: 0,
		untested: 0,
	});
	const [assetTotal, setAssetTotal] = useState(0);
	const [assetPage, setAssetPage] = useState(1);
	const [assetPageSize, setAssetPageSize] = useState(50);
	const [assetHasMore, setAssetHasMore] = useState(false);
	const [assetFilters, setAssetFilters] = useState<SentinelAssetFilters>({});
	const assetFiltersRef = useRef<SentinelAssetFilters>({});
	const assetPageRef = useRef(1);
	const assetPageSizeRef = useRef(50);
	const [assetView, assetRequest] = useDetailRequest<SentinelAssetDetail>();
	const assetDetail = assetView?.data ?? null;
	const pageRef = useRef<SentinelPageId>("dashboard");
	const [assetDeletePending, setAssetDeletePending] = useState<string[] | null>(null);
	const [assetDeletePreview, setAssetDeletePreview] = useState<SentinelAssetDeletePreview | null>(null);
	const [pocItems, setPocItems] = useState<SentinelPocSummary[]>([]);
	const [pocStats, setPocStats] = useState<SentinelPocStats>({
		total: 0,
		bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
	});
	const [pocFilters, setPocFilters] = useState<SentinelPocFilters>({});
	/** The library page on screen (1-based) and the server's paging numbers. */
	const [pocPage, setPocPage] = useState(1);
	const [pocTotal, setPocTotal] = useState(0);
	const [pocPageSize, setPocPageSize] = useState(100);
	const [pocView, pocRequest] = useDetailRequest<SentinelPoc>();
	const pocDetail = pocView?.data ?? null;
	const [pocImporting, setPocImporting] = useState(false);
	const [pocImportProgress, setPocImportProgress] = useState<SentinelPocImportProgress | null>(null);
	const [lastPocImport, setLastPocImport] = useState<SentinelPocImportOutcome | null>(null);
	const [pocSources, setPocSources] = useState<SentinelPocSource[]>([]);
	const [pocSyncing, setPocSyncing] = useState<string | null>(null);
	/** The one-click official sync runs for minutes; it keeps its own busy flag
	 * because the source list is broadcast as soon as the source is created. */
	const [pocOfficialSyncing, setPocOfficialSyncing] = useState(false);
	const [codeMonitors, setCodeMonitors] = useState<SentinelCodeMonitor[]>([]);
	const [codeMonitorView, codeMonitorRequest] = useDetailRequest<SentinelCodeMonitorDetail>();
	const codeMonitorDetail = codeMonitorView?.data ?? null;
	const [codeBranchProbes, setCodeBranchProbes] = useState<BranchProbe[]>([]);
	const [codeMonitorBusy, setCodeMonitorBusy] = useState<string | null>(null);
	const [codeCheckingIds, setCodeCheckingIds] = useState<string[]>([]);
	const [codeImport, setCodeImport] = useState<SentinelCodeImportState | null>(null);
	const [codeActivity, setCodeActivity] = useState<SentinelCodeActivityView | null>(null);
	const [codeActivityLoading, setCodeActivityLoading] = useState(false);
	const [codeActivityError, setCodeActivityError] = useState<string | null>(null);
	const codeDispatchingIdsRef = useRef(new Set<string>());
	const codeActivityRequest = useMemo(() => new CodeActivityRequest((loading, error) => {
		setCodeActivityLoading(loading);
		setCodeActivityError(error);
	}, (view) => setCodeActivity(view ? {
		...view,
		// A read started before the click can still contain the previous status.
		items: view.items.map((commit) => codeDispatchingIdsRef.current.has(commit.id) && !commit.engineId && commit.status !== "ignored"
			? { ...commit, ...CODE_DISPATCHING_PATCH } : commit),
	} : null)), []);
	const [codeMonitorLogs, setCodeMonitorLogs] = useState<{
		checks: SentinelCodeCheckLog[];
		jobs: SentinelCodeCheckJob[];
	} | null>(null);
	/** Android devices: the device page's gateway state. */
	const [droidState, setDroidState] = useState<{
		enabled: boolean;
		devices: DroidDevice[];
		tokens: DroidToken[];
		listen: { host: string; port: number } | null;
		listenConfig: { host: string; port: number } | null;
		lanIps: string[];
		certPin: string | null;
	}>({
		enabled: false,
		devices: [],
		tokens: [],
		listen: null,
		listenConfig: null,
		lanIps: [],
		certPin: null,
	});
	/** iOS devices: tokens and the reverse gateway's device list. */
	const [iosState, setIosState] = useState<{
		enabled: boolean;
		devices: IosDevice[];
		tokens: IosToken[];
		listen: { host: string; port: number } | null;
		listenConfig: { host: string; port: number } | null;
		lanIps: string[];
		certPin: string | null;
	}>({
		enabled: false,
		devices: [],
		tokens: [],
		listen: null,
		listenConfig: null,
		lanIps: [],
		certPin: null,
	});
	/** Business modeling: the runs of the active project, and the open drill-down. */
	const [apiModels, setApiModels] = useState<SentinelApiModelSummary[]>([]);
	const [apiModelView, apiModelRequest] = useDetailRequest<{ model: SentinelApiModel; events: SentinelApiModelEvent[] }>();
	const apiModelDetail = apiModelView?.data?.model ?? null;
	const apiModelEvents = apiModelView?.data?.events ?? [];
	const [vulnPreview, setVulnPreview] = useState<SentinelFilePreview | null>(null);
	/** Engineering mode: engines, doctrines, and mirrored event logs. */
	const [engines, setEngines] = useState<SentinelEngine[]>([]);
	const [engineEntryId, setEngineEntryId] = useState<string | null>(null);
	const [doctrines, setDoctrines] = useState<SentinelDoctrineView[]>([]);
	const doctrineSaveResolverRef = useRef<((error: string | null) => void) | null>(null);
	/** Preset agents: null until the first list arrives, which the settings page shows. */
	const [presets, setPresets] = useState<SentinelPresetView[] | null>(null);
	/** The last 导入 reply, kept until the next one replaces it. */
	const [presetImport, setPresetImport] = useState<PresetImportNotice | null>(null);
	const [commanderEvents, setCommanderEvents] = useState<Record<string, SentinelSubagentEvent[]>>({});
	const [engineTaskEvents, setEngineTaskEvents] = useState<Record<string, SentinelSubagentEvent[]>>({});
	/** Model screen: the library, the role assignments, and each role's effective endpoint. */
	const [modelLibrary, setModelLibrary] = useState<SentinelModelLibraryView | null>(null);
	/** Gatekeeper: its settings and the audit page's current view. */
	const [gatekeeperConfig, setGatekeeperConfig] = useState<SentinelGatekeeperConfig>({
		mode: "review",
		timeoutMs: 15000,
		concurrency: 0,
		// Matches the server's defaults: MCP tools judged, plugin tools not.
		mcpTools: { enabled: true, includePlugins: false },
	});
	const [gateItems, setGateItems] = useState<SentinelGateDecision[]>([]);
	const [gateStats, setGateStats] = useState<SentinelGateStats | null>(null);
	const [gateTabCounts, setGateTabCounts] = useState<Record<SentinelGateApproval, number> | null>(null);
	const [gateTotal, setGateTotal] = useState(0);
	const [gatePage, setGatePage] = useState(1);
	// The audit page opens on 「AI 审批」: the judgment trail is what this page
	// has always been, and 「自动审批」 is the tab one switches to on purpose.
	const [gateFilter, setGateFilter] = useState<SentinelGateFilter>({ approval: ["ai"] });
	/** Failure instant the operator dismissed the fail-open banner for. */
	const [dismissedGateFailure, setDismissedGateFailure] = useState<number | null>(null);
	const connectionRef = useRef<SentinelConnection | null>(null);
	const transcriptRef = useRef<HTMLDivElement | null>(null);
	/** Whether the transcript should chase the bottom; turned off by scrolling up. */
	const transcriptFollowRef = useRef(true);
	const modelTestResolverRef = useRef<((result: SentinelTestResult | null) => void) | null>(null);
	const modelDefaultsResolverRef = useRef<((matches: SentinelBuiltinModelDefaults[] | null) => void) | null>(null);
	const modelChannelRequestRef = useRef(0);
	const modelChannelResolversRef = useRef(
		new Map<number, (channels: SentinelBuiltinChannel[] | null) => void>(),
	);
	const modelListRequestRef = useRef(0);
	const modelListResolversRef = useRef(
		new Map<number, (presets: SentinelBuiltinModelPreset[] | null) => void>(),
	);
	const notifyTestResolverRef = useRef<((result: SentinelTestResult | null) => void) | null>(null);
	const assetTestResolverRef = useRef<((result: SentinelTestResult | null) => void) | null>(null);
	const mcpTestResolverRef = useRef<((result: SentinelMcpTestResult | null) => void) | null>(null);
	const judgeTestResolverRef = useRef<((result: { result: SentinelTestResult; raw?: string } | null) => void) | null>(null);
	const supervisorTestResolverRef = useRef<
		((result: { result: SentinelTestResult; raw?: string } | null) => void) | null
	>(null);
	/** Supervision of the viewed conversation; null until it is armed. */
	const [supervisor, setSupervisor] = useState<SentinelSupervisorView | null>(null);
	const [supervisorConfig, setSupervisorConfig] = useState<SentinelSupervisorConfig>({
		enabled: true,
		batchToolCalls: 20,
		duplicateThreshold: 3,
		noProgressCalls: 10,
		errorStreak: 3,
		timeoutMs: 180000,
		redactSecrets: true,
		defaultStrategy: "steady",
		defaultStrategies: [{ strategy: "steady", customStrategyId: null }],
		customStrategies: [],
		defaultCustomStrategyId: null,
	});
	const [supervisorWindowOpen, setSupervisorWindowOpen] = useState(false);
	/** Episodes since this console opened the conversation; the view carries the state, not the history. */
	const [supervisorEpisodes, setSupervisorEpisodes] = useState<SentinelSupervisorEpisode[]>([]);
	const [supervisorLogs, setSupervisorLogs] = useState<SentinelSupervisorLog[]>([]);
	const [supervisorAudit, setSupervisorAudit] = useState<SentinelSupervisorAuditPage | null>(null);
	const [supervisorView, supervisorRequest] = useDetailRequest<SentinelSupervisorDetail>();
	const supervisorDetail = supervisorView?.data ?? null;
	const detailRequests = useMemo(() => [assetRequest, pocRequest, codeMonitorRequest, apiModelRequest, supervisorRequest],
		[assetRequest, pocRequest, codeMonitorRequest, apiModelRequest, supervisorRequest]);
	const [supervisorCallOutput, setSupervisorCallOutput] = useState<{
		callId: string;
		text: string;
		truncated: boolean;
		error?: string;
	} | null>(null);
	const supervisorSessionRef = useRef<string | null>(null);
	const supervisorDetailSessionRef = useRef<string | null>(null);
	/** The audit query on screen, so a live judgment can refresh exactly that view. */
	const gateQueryRef = useRef<{ filter: SentinelGateFilter; page: number } | null>(null);
	const snapshotRef = useRef<SentinelStateSnapshot | null>(null);
	const runOutputTokensRef = useRef(0);
	const runGenerationMsRef = useRef(0);
	const assistantStartedAtRef = useRef<number | null>(null);
	/** Directory the file panel is showing; read by handlers that must re-list it. */
	const filePathRef = useRef("/work");
	/** Path the preview pane is showing, so a write can refresh it. */
	const previewPathRef = useRef<string | null>(null);
	/** Set while a hub evidence preview is in flight, so its reply does not feed the file panel. */
	const vulnPreviewPathRef = useRef<string | null>(null);

	const pushError = useCallback((message: string) => {
		setErrors((prev) => [...prev.slice(-4), message]);
		window.setTimeout(() => setErrors((prev) => prev.filter((item) => item !== message)), 8000);
	}, []);

	const refreshStats = useCallback(() => {
		connectionRef.current?.send({ type: "get_stats" });
	}, []);

	const updateCodeCommit = useCallback((id: string, patch: Partial<SentinelCodeCommit>) => {
		setCodeActivity((current) => current ? {
			...current,
			items: current.items.map((commit) => commit.id === id ? { ...commit, ...patch } : commit),
		} : current);
		codeMonitorRequest.update((current) => ({
			...current,
			commits: current.commits.map((commit) => commit.id === id ? { ...commit, ...patch } : commit),
		}));
	}, [codeMonitorRequest]);

	/** Show a directory in the file panel (also used to refresh the current one). */
	const loadFiles = useCallback((path: string) => {
		filePathRef.current = path;
		setFilePath(path);
		setFileBusy(true);
		setFilePreview(null);
		previewPathRef.current = null;
		connectionRef.current?.send({ type: "list_files", path });
	}, []);

	useEffect(() => {
		folderArchiveRef.current = folderArchive;
	}, [folderArchive]);

	/** Start an async archive; only one runs at a time, enforced by the panel. */
	const requestFolderArchive = useCallback(
		(path: string) => {
			const current = folderArchiveRef.current;
			if (
				current &&
				(current.status === "starting" || current.status === "running" || current.status === "cancelling")
			) {
				return;
			}
			const name = path === "/work" ? "work" : (path.split("/").filter(Boolean).pop() ?? "work");
			const next: FolderArchiveState = {
				id: "",
				path,
				filename: `${name}.tar.gz`,
				bytes: 0,
				status: "starting",
			};
			// Update the ref synchronously so a second click in the same tick cannot
			// start a second job before React has rendered the first state change.
			folderArchiveRef.current = next;
			setFolderArchive(next);
			connectionRef.current?.send({ type: "download_folder", path });
		},
		[],
	);

	const cancelFolderArchive = useCallback(() => {
		const current = folderArchiveRef.current;
		if (!current?.id) return;
		const next: FolderArchiveState = { ...current, status: "cancelling" };
		folderArchiveRef.current = next;
		setFolderArchive(next);
		connectionRef.current?.send({ type: "cancel_folder_archive", id: current.id });
	}, []);

	const handleServerMessage = useCallback(
		(message: SentinelServerMessage) => {
			switch (message.type) {
				case "ui_config":
					if (message.language !== getLanguage()) {
						storeLanguage(message.language);
						window.location.reload();
					}
					break;
				case "snapshot": {
					snapshotRef.current = message.snapshot;
					setSnapshot(message.snapshot);
					setSupervisor(message.snapshot.supervisor);
					setSupervisorConfig(message.snapshot.supervisorConfig);
					const nextSupervisorSession = message.snapshot.supervisor?.sessionId ?? null;
					if (supervisorSessionRef.current !== nextSupervisorSession) {
						supervisorSessionRef.current = nextSupervisorSession;
						supervisorDetailSessionRef.current = null;
						setSupervisorEpisodes([]);
						setSupervisorLogs(message.snapshot.supervisor?.logs ?? []);
					} else if (message.snapshot.supervisor) {
						setSupervisorLogs(message.snapshot.supervisor.logs);
					}
					if (!message.snapshot.supervisor) setSupervisorWindowOpen(false);
					// Drop optimistic bubbles whose message has landed in the snapshot:
					// once the persisted user-message count covers the send, it is rendered there.
					const userCount = message.snapshot.messages.filter(
						(entry) => (entry as { role?: string }).role === "user",
					).length;
					setOptimisticUserMessages((prev) => prev.filter((item) => userCount < item.userCountAtSend + 1));
					// The snapshot is authoritative: anything it already carries stops
					// being rendered from the event-built lists. A message is matched by
					// role plus timestamp, and by content when it has none.
					const persisted = new Set(
						message.snapshot.messages.map((entry) => messageKey(entry as { role?: string; timestamp?: number })),
					);
					setPendingMessages((prev) => prev.filter((entry) => !persisted.has(messageKey(entry))));
					setLiveTools((tools) =>
						tools.filter(
							(tool) =>
								!message.snapshot.messages.some(
									(entry) =>
										(entry as { role?: string; toolCallId?: string }).role === "toolResult" &&
										(entry as { toolCallId?: string }).toolCallId === tool.id,
								),
						),
					);
					setRunActive(message.snapshot.streaming);
					// Only the settled snapshot may drop the in-flight text: a snapshot
					// taken mid-run (a file operation, another window) must not erase it.
					if (!message.snapshot.streaming) {
						setLiveText("");
						setLiveThinking("");
					}
					break;
				}
				case "session_event":
					handleSessionEvent(message.event);
					break;
				case "sessions":
					setSessions(message.sessions);
					break;
				case "model_library":
					setModelLibrary(message.library);
					break;
				case "model_defaults":
					if (modelDefaultsResolverRef.current) {
						const resolve = modelDefaultsResolverRef.current;
						modelDefaultsResolverRef.current = null;
						resolve(message.matches);
					}
					break;
				case "model_channels": {
					const resolve = modelChannelResolversRef.current.get(message.requestId);
					if (resolve) {
						modelChannelResolversRef.current.delete(message.requestId);
						resolve(message.channels);
					}
					break;
				}
				case "channel_models": {
					const resolve = modelListResolversRef.current.get(message.requestId);
					if (resolve) {
						modelListResolversRef.current.delete(message.requestId);
						resolve(message.presets);
					}
					break;
				}
				case "model_test_result":
					if (modelTestResolverRef.current) {
						const resolve = modelTestResolverRef.current;
						modelTestResolverRef.current = null;
						resolve(message.result);
					}
					break;
				case "permissions":
					setPermissions(message.config);
					setPermissionEffective(message.effectiveSubagent);
					setPermissionPresets(message.presets);
					setPermissionTools(message.tools);
					setPermissionBusy(false);
					break;
				case "notify_config":
					setNotifyConfig(message.config);
					setNotifyStatus(message.status);
					break;
				case "asset_config":
					setAssetConfig(message.config);
					setAssetBusy(false);
					break;
				case "websearch_config":
					setWebSearchConfig(message.config);
					setWebSearchBusy(false);
					break;
				case "websearch_test_result":
					if (webSearchTestResolverRef.current) {
						const resolve = webSearchTestResolverRef.current;
						webSearchTestResolverRef.current = null;
						resolve(message.result);
					}
					break;
				case "asset_test_result":
					if (assetTestResolverRef.current) {
						const resolve = assetTestResolverRef.current;
						assetTestResolverRef.current = null;
						resolve(message.result);
					}
					break;
				case "notify_test_result":
					if (notifyTestResolverRef.current) {
						const resolve = notifyTestResolverRef.current;
						notifyTestResolverRef.current = null;
						resolve(message.result);
					}
					break;
				case "mcp_servers":
					setMcpConfig(message.config);
					setMcpBusy(false);
					break;
				case "mcp_test_result":
					if (mcpTestResolverRef.current) {
						const resolve = mcpTestResolverRef.current;
						mcpTestResolverRef.current = null;
						resolve(message.result);
					}
					break;
				case "official_plugins":
					setOfficialPlugins(message.plugins);
					break;
				case "plugin_build_log":
					setPluginBuildLog({ hostId: message.hostId, pluginId: message.pluginId, log: message.log });
					break;
				case "plugins": {
					const pending = pendingInstallRef.current;
					if (pending) {
						const installed = message.view.plugins.find(
							(plugin) => plugin.hostId === pending.hostId && plugin.manifest.id === pending.pluginId,
						);
						if (installed) {
							pendingInstallRef.current = null;
							setPendingManifest(null);
							setPendingPackage(null);
							setPendingOfficial(null);
							setPluginNotice(
								t("插件「{name}」安装完成，当前{state}。", { name: installed.manifest.name, state: installed.state === "running" ? t("运行中") : t("未运行") }),
							);
							window.setTimeout(() => setPluginNotice(null), 8000);
						}
					}
					setPluginsView(message.view);
					setPluginsBusy(false);
					break;
				}
				case "plugin_manifest":
					setPendingManifest({ manifest: message.manifest, source: message.source });
					setPluginsBusy(false);
					break;
				case "plugin_logs":
					setPluginLogs({ hostId: message.hostId, pluginId: message.pluginId, logs: message.logs });
					setPluginsBusy(false);
					break;
				case "plugin_artifacts":
					setPluginArtifacts({
						hostId: message.hostId,
						pluginId: message.pluginId,
						items: message.artifacts,
					});
					setPluginsBusy(false);
					break;
				case "plugin_ui_opened": {
					const pending = pendingPluginUi.current;
					if (!pending) break;
					pendingPluginUi.current = null;
					if (pending.mode === "page") setPluginPage({ ...pending, token: message.token });
					else setPluginUi({ ...pending, token: message.token });
					break;
				}
				case "plugin_ui_result": {
					const resolve = pluginUiResolvers.current.get(message.requestId);
					if (resolve) {
						pluginUiResolvers.current.delete(message.requestId);
						resolve(message);
					}
					break;
				}
				case "plugin_artifact_saved":
					setPluginsBusy(false);
					setPluginNotice(t("产物已保存到 {path}", { path: message.savedTo }));
					window.setTimeout(() => setPluginNotice(null), 8000);
					break;
				case "gatekeeper_config":
					setGatekeeperConfig(message.config);
					break;
				case "judge_test_result":
					if (judgeTestResolverRef.current) {
						const resolve = judgeTestResolverRef.current;
						judgeTestResolverRef.current = null;
						resolve({ result: message.result, ...(message.raw ? { raw: message.raw } : {}) });
					}
					break;
				case "gate_audit":
					setGateItems(message.page.items);
					setGateTotal(message.page.total);
					setGatePage(message.page.page);
					break;
				case "gate_audit_stats":
					setGateStats(message.stats);
					setGateTabCounts(message.tabCounts);
					break;
				case "gate_decision": {
					// A judgment landed. Re-reading the visible query keeps the page
					// honest under a filter: an allow must not appear in a block-only list.
					const query = gateQueryRef.current;
					if (!query) break;
					connectionRef.current?.send({
						type: "gate_audit_query",
						filter: query.filter,
						page: query.page,
						pageSize: 50,
					});
					connectionRef.current?.send({ type: "gate_audit_stats", filter: query.filter });
					break;
				}
				case "supervisor_state":
					setSupervisor(message.supervisor);
					if (message.supervisor) {
						if (supervisorSessionRef.current !== message.supervisor.sessionId) {
							supervisorSessionRef.current = message.supervisor.sessionId;
							supervisorDetailSessionRef.current = null;
							setSupervisorEpisodes([]);
						}
						setSupervisorLogs(message.supervisor.logs);
					} else {
						supervisorSessionRef.current = null;
						supervisorDetailSessionRef.current = null;
						setSupervisorEpisodes([]);
						setSupervisorLogs([]);
						setSupervisorWindowOpen(false);
					}
					break;
				case "supervisor_episode":
					if (supervisorSessionRef.current === message.episode.sessionId) {
						setSupervisorEpisodes((prev) => [...prev.slice(-49), message.episode]);
					}
					break;
				case "supervisor_log":
					if (supervisorSessionRef.current === message.sessionId) {
						setSupervisorLogs((prev) => [...prev.slice(-99), message.log]);
					}
					break;
				case "supervisor_advice":
					setSupervisor((prev) => {
						if (!prev || prev.sessionId !== message.advice.sessionId) return prev;
						if (message.advice.status === "pending") return { ...prev, pendingAdvice: message.advice };
						if (prev.pendingAdvice?.id === message.advice.id) return { ...prev, pendingAdvice: null };
						return prev;
					});
					if (message.advice.status === "pending") {
						pushError(t("监督有一条待确认的建议，请打开监督悬浮窗查看"));
					}
					break;
				case "supervisor_config":
					setSupervisorConfig(message.config);
					break;
				case "supervisor_audit":
					setSupervisorAudit(message.page);
					break;
				case "supervisor_detail":
					supervisorRequest.accept(null, message.detail.session.sessionId, message.detail);
					if (supervisorSessionRef.current === message.detail.session.sessionId) {
						setSupervisorEpisodes(message.detail.episodes);
					}
					break;
				case "supervisor_call_output":
					setSupervisorCallOutput({
						callId: message.callId,
						text: message.text,
						truncated: message.truncated,
						...(message.error ? { error: message.error } : {}),
					});
					break;
				case "supervisor_test_result":
					if (supervisorTestResolverRef.current) {
						const resolve = supervisorTestResolverRef.current;
						supervisorTestResolverRef.current = null;
						resolve({ result: message.result, ...(message.raw ? { raw: message.raw } : {}) });
					}
					break;
				case "environment": {
					setEnvReport(message.report);
					setImageBuilding(message.building);
					if (message.building) setBuildLog([]);
					return;
				}
				case "proxy_config": {
					setProxyConfig(message.config);
					// A scheduled refresh is a change nobody asked for: it updates the
					// view but must not release a form that is waiting for its own answer.
					if (message.push) return;
					setRefreshingProxyId(null);
					setTestingProxyId(null);
					// The page shows the reason next to the form it came from; the action
					// slot is what releases the button that is waiting.
					if (message.error) proxyAction.failed(message.error);
					else proxyAction.succeeded();
					return;
				}
				case "sources_saved": {
					if (message.error) {
						pushError(t("构建源保存失败：{error}", { error: message.error }));
						return;
					}
					setSourcesSavedAt(Date.now());
					return;
				}
				case "container_network_saved": {
					if (message.error) {
						pushError(t("容器网络保存失败：{error}", { error: message.error }));
						return;
					}
					setContainerNetworkSavedAt(Date.now());
					return;
				}

				case "singbox_pull_started":
					setPullingSingboxImage(true);
					return;
				case "singbox_pull_result": {
					setPullingSingboxImage(false);
					if (!message.ok) {
						pushError(t("代理镜像拉取失败：{error}", { error: message.error ?? t("未知错误") }));
						return;
					}
					pushError(t("代理镜像已就绪"));
					return;
				}
				case "project_proxy_saved": {
					if (message.error) {
						pushError(t("项目代理保存失败：{error}", { error: message.error }));
						return;
					}
					return;
				}
				case "image_build_log":
					setBuildLog((prev) => [...prev.slice(-499), message.line]);
					return;
				case "image_build_result": {
					setImageBuilding(false);
					if (!message.ok) {
						pushError(t("镜像构建失败：{error}", { error: message.error ?? t("未知错误") }));
					} else {
						pushError(t("工具镜像构建完成，可点击「复检」确认"));
					}
					return;
				}
				case "stats":
					setStats(message.stats);
					break;
				case "engines":
					setEngines(message.engines);
					break;
				case "engine_update":
					setEngines((prev) => {
						const index = prev.findIndex((engine) => engine.id === message.engine.id);
						if (index === -1) return [message.engine, ...prev];
						const next = [...prev];
						next[index] = message.engine;
						return next;
					});
					break;
				case "engine_commander_events":
					setCommanderEvents((prev) => ({ ...prev, [message.id]: message.events }));
					break;
				case "engine_commander_event":
					setCommanderEvents((prev) => ({
						...prev,
						[message.engineId]: [...(prev[message.engineId] ?? []).slice(-499), message.event],
					}));
					break;
				case "engine_task_event":
					setEngineTaskEvents((prev) => ({
						...prev,
						[message.taskId]: [...(prev[message.taskId] ?? []).slice(-999), message.event],
					}));
					break;
				case "engine_task_events":
					setEngineTaskEvents((prev) => ({ ...prev, [message.taskId]: message.events }));
					break;
				case "engine_report": {
					const blob = new Blob([message.markdown], { type: "text/markdown" });
					const url = URL.createObjectURL(blob);
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = message.filename;
					anchor.click();
					URL.revokeObjectURL(url);
					break;
				}
				case "doctrines":
					setDoctrines(message.doctrines);
					break;
				case "doctrine_saved": {
					const resolve = doctrineSaveResolverRef.current;
					doctrineSaveResolverRef.current = null;
					resolve?.(message.error ?? null);
					if (message.error) {
						pushError(t("思路保存失败：{error}", { error: message.error }));
						return;
					}
					send({ type: "list_doctrines" });
					break;
				}
				case "doctrine_deleted":
					if (!message.ok) pushError(t("思路删除失败：{error}", { error: message.error ?? t("未知错误") }));
					else send({ type: "list_doctrines" });
					break;
				case "presets":
					setPresets(message.presets);
					break;
				case "preset_saved": {
					// The reply carries only the changed entry, and a save and a
					// toggle can both arrive here, so the list is re-read as a whole.
					if (message.error) {
						pushError(t("预设保存失败：{error}", { error: message.error }));
						return;
					}
					send({ type: "list_presets" });
					break;
				}
				case "preset_deleted":
					if (!message.ok) pushError(t("预设删除失败：{error}", { error: message.error ?? t("未知错误") }));
					else send({ type: "list_presets" });
					break;
				case "presets_export": {
					// Same technique as the vulnerability export: the payload is text,
					// so the browser builds the download instead of a server route.
					const url = URL.createObjectURL(new Blob([message.content], { type: "application/json;charset=utf-8" }));
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = message.filename;
					document.body.appendChild(anchor);
					anchor.click();
					anchor.remove();
					URL.revokeObjectURL(url);
					break;
				}
				case "presets_imported": {
					if (message.error) pushError(t("预设导入失败：{error}", { error: message.error }));
					setPresetImport({
						imported: message.imported.length,
						skipped: message.skipped,
					});
					if (message.imported.length > 0) send({ type: "list_presets" });
					break;
				}
				case "tree":
					setTree(message.tree);
					setLeafId(message.leafId);
					setForkPoints(message.forkPoints);
					break;
				case "projects":
					setProjects(message.projects);
					setActiveProject(
						(prev) =>
							message.projects.find((project) => project.id === message.activeProjectId) ??
							(message.activeProjectId === null ? null : prev),
					);
					// This broadcast is how create / remove / rebuild report success, so it
					// has to release the form that is waiting for one.
					projectAction.succeeded();
					break;
				case "files":
					filePathRef.current = message.path;
					setFilePath(message.path);
					setFileEntries(message.entries);
					setFileBusy(false);
					break;
				case "file_preview":
					// A preview requested by the hub's evidence list must not overwrite
					// the file panel's own preview pane.
					if (vulnPreviewPathRef.current === message.preview.path) {
						vulnPreviewPathRef.current = null;
						setVulnPreview(message.preview);
						break;
					}
					previewPathRef.current = message.preview.path;
					setFilePreview(message.preview);
					setFileBusy(false);
					break;
				case "file_download":
					saveDownload(message.path, message.data, message.mimeType);
					setFileBusy(false);
					break;
				case "file_result":
					setFileBusy(false);
					if (!message.ok) {
						if (message.error) pushError(message.error);
					} else if (message.action === "删除" || message.action === "重命名") {
						// The previewed path is gone or moved; drop the pane.
						previewPathRef.current = null;
						setFilePreview(null);
					} else if (message.action === "保存" || message.action === "上传") {
						// Re-read so the pane shows what was actually written.
						if (previewPathRef.current) {
							connectionRef.current?.send({ type: "read_file", path: previewPathRef.current });
						}
					}
					// Any mutation changes the listing; re-read it and refresh the snapshot.
					connectionRef.current?.send({ type: "list_files", path: filePathRef.current });
					connectionRef.current?.send({ type: "get_state" });
					break;
				case "folder_archive_started":
					setFolderArchive({
						id: message.id,
						path: message.path,
						filename: message.filename,
						bytes: 0,
						status: "running",
					});
					break;
				case "folder_archive_progress":
					setFolderArchive((prev) =>
						prev && prev.id === message.id ? { ...prev, bytes: message.bytes } : prev,
					);
					break;
				case "folder_archive_ready":
					setFolderArchive((prev) =>
						prev && prev.id === message.id
							? { ...prev, status: "ready", size: message.size, warning: message.warning }
							: prev,
					);
					// The ready message is the async task's completion; start the
					// browser download now, while the temp file is still retained.
					downloadFolderArchive(message.id, message.filename);
					break;
				case "folder_archive_failed":
					setFolderArchive((prev) => {
						if (message.id && prev && prev.id !== message.id) return prev;
						return {
							id: message.id ?? prev?.id ?? "",
							path: prev?.path ?? "",
							filename: prev?.filename ?? "",
							bytes: prev?.bytes ?? 0,
							status: "failed",
							error: message.error,
						};
					});
					break;
				case "folder_archive_cancelled":
					setFolderArchive((prev) =>
						prev && prev.id === message.id ? { ...prev, status: "cancelled" } : prev,
					);
					break;
				case "terminal_state":
					publishTerminal({
						kind: "state",
						projectId: message.projectId,
						outcome: message.outcome,
						...(message.session ? { session: message.session } : {}),
						...(message.replay ? { replay: message.replay } : {}),
						...(message.error ? { error: message.error } : {}),
					});
					break;
				case "terminal_output":
					publishTerminal({ kind: "output", projectId: message.projectId, data: message.data });
					break;
				case "terminal_exit":
					publishTerminal({ kind: "exit", projectId: message.projectId, code: message.code });
					break;
				case "subagent_run":
					setSubagentTranscripts((prev) => ({ ...prev, [message.run.id]: message.run.events ?? [] }));
					break;
				case "subagent_event":
					setSubagentTranscripts((prev) => {
						const existing = prev[message.runId];
						if (!existing) return prev;
						return { ...prev, [message.runId]: [...existing, message.event] };
					});
					break;
				case "subagents":
					setSubagentPage({ runs: message.runs, offset: message.offset, total: message.total });
					break;
				case "subagent_result":
					if (!message.ok && message.error) pushError(message.error);
					break;
				case "vulns":
					setVulnItems(message.items);
					setVulnStats(message.stats);
					// A filtered or late list is not evidence that the selected record was deleted.
					break;
				case "vuln":
					if (message.vuln.projectId === snapshotRef.current?.project?.id && vulnDetailRequest.accept(message.vuln)) {
						setVulnPreview(null);
					}
					break;
				case "vuln_result":
					if (!message.ok && message.error) pushError(message.error);
					break;
				case "vuln_delete_preview":
					setVulnDeletePreview({ count: message.count, evidence: message.evidence, notes: message.notes });
					break;
				case "vulns_deleted": {
					// The broadcast that follows carries the unfiltered list, so the page
					// asks again with the filters it is actually showing.
					setVulnDeletePending(null);
					setVulnDeletePreview(null);
					vulnDetailRequest.close();
					send({ type: "list_vulns", filters: vulnFiltersRef.current });
					break;
				}
				case "vuln_review_result":
					if (!message.ok) pushError(t("重新评审失败：{error}", { error: message.error ?? t("未知错误") }));
					break;
				case "vulns_export": {
					// Markdown is text, so the download is built directly instead of
					// going through the base64 path the file panel uses.
					const url = URL.createObjectURL(new Blob([message.markdown], { type: "text/markdown;charset=utf-8" }));
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = message.filename;
					document.body.appendChild(anchor);
					anchor.click();
					anchor.remove();
					URL.revokeObjectURL(url);
					break;
				}
				case "assets": {
					setAssetItems(message.items);
					setAssetStats(message.stats);
					setAssetTotal(message.total);
					setAssetPage(message.page);
					assetPageRef.current = message.page;
					setAssetPageSize(message.pageSize);
					assetPageSizeRef.current = message.pageSize;
					setAssetHasMore(message.hasMore);
					// A deletion can empty the last page; step back once instead of
					// leaving the operator on a blank page with records behind it.
					if (message.items.length === 0 && message.total > 0 && message.page > 1) {
						send({
							type: "list_assets",
							filters: assetFiltersRef.current,
							page: message.page - 1,
							pageSize: message.pageSize,
						});
					}
					break;
				}
				case "assets_changed": {
					if (pageRef.current === "assets") {
						send({
							type: "list_assets",
							filters: assetFiltersRef.current,
							page: assetPageRef.current,
							pageSize: assetPageSizeRef.current,
						});
					}
					if (assetRequest.current) {
						send({ type: "get_asset", id: assetRequest.current.id });
					}
					break;
				}
				case "asset":
					if (message.detail.asset.projectId === snapshotRef.current?.project?.id) {
						assetRequest.accept(message.detail.asset.projectId, message.detail.asset.id, message.detail);
					}
					break;
				case "asset_result":
					if (!message.ok && message.error) pushError(message.error);
					break;
				case "asset_delete_preview":
					setAssetDeletePreview({ count: message.count, records: message.records, vulns: message.vulns });
					break;
				case "assets_deleted": {
					setAssetDeletePending(null);
					setAssetDeletePreview(null);
					assetRequest.close();
					send({
						type: "list_assets",
						filters: assetFiltersRef.current,
						page: assetPageRef.current,
						pageSize: assetPageSizeRef.current,
					});
					break;
				}
				case "assets_export": {
					const url = URL.createObjectURL(new Blob([message.markdown], { type: "text/markdown;charset=utf-8" }));
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = message.filename;
					document.body.appendChild(anchor);
					anchor.click();
					anchor.remove();
					URL.revokeObjectURL(url);
					break;
				}
				case "pocs":
					setPocItems(message.items);
					setPocStats(message.stats);
					setPocTotal(message.total);
					setPocPageSize(message.pageSize);
					break;
				case "poc":
					pocRequest.accept(null, message.poc.id, message.poc);
					break;
				case "poc_result":
					if (!message.ok && message.error) pushError(message.error);
					if (message.ok && message.action === "删除" && message.id === pocRequest.current?.id) pocRequest.close();
					break;
				case "poc_sources":
					setPocSources(message.sources);
					setPocSyncing(null);
					break;
				case "poc_source_result":
					if (!message.ok && message.error) pushError(message.error);
					if (message.action === "同步" && message.ok && message.id) setPocSyncing(null);
					if (message.action === "同步官方 POC") setPocOfficialSyncing(false);
					break;
				case "code_monitors": {
					setCodeMonitors(message.monitors);
					// A check or a dispatch landed; an open detail should show it without
					// the operator closing and reopening the drawer.
					const openId = codeMonitorRequest.current?.id;
					if (openId && message.monitors.some((monitor) => monitor.id === openId)) {
						send({ type: "get_code_monitor", id: openId });
					} else if (openId) {
						codeMonitorRequest.close();
					}
					break;
				}
				case "code_monitor_import":
					setCodeImport(message.state);
					break;
				case "code_activity":
				case "code_activity_error":
					codeActivityRequest.accept(message);
					break;
				case "code_monitor_detail":
					// Mutations also return details; they must not open a drawer or
					// replace a different monitor the operator is currently inspecting.
					if (message.detail.monitor.projectId === snapshotRef.current?.project?.id) {
						codeMonitorRequest.accept(message.detail.monitor.projectId, message.detail.monitor.id, message.detail);
					}
					setCodeMonitorBusy((id) => message.detail.commits.some((commit) => commit.id === id && commit.verdict !== "pending") ? null : id);
					break;
				case "code_monitor_logs":
					setCodeMonitorLogs({ checks: message.checks, jobs: message.jobs });
					break;
				case "code_monitor_branches":
					setCodeBranchProbes((prev) =>
						[
							...prev,
							{
								requestId: message.requestId,
								...(message.branches ? { branches: message.branches } : {}),
								...(message.error ? { error: message.error } : {}),
							},
						].slice(-100),
					);
					break;
				case "code_monitor_result":
					if (message.action === "检查监控" && message.id) {
						setCodeCheckingIds((prev) => prev.filter((id) => id !== message.id));
					} else {
						setCodeMonitorBusy(null);
					}
					if (!message.ok && message.error) pushError(message.error);
					if (message.action === "下发复现" && message.id) codeDispatchingIdsRef.current.delete(message.id);
					if (!message.ok && message.action === "下发复现" && message.id) {
						updateCodeCommit(message.id, { status: "new", reproductionStage: "failed", error: message.error ?? t("未知错误") });
					}
					if (
						message.ok &&
						message.action === "检查监控" &&
						message.id &&
						codeMonitorRequest.current?.id === message.id
					) {
						send({ type: "get_code_monitor", id: message.id });
					}
					if (message.ok && message.action === "删除监控" && message.id) {
						if (codeMonitorRequest.current?.id === message.id) codeMonitorRequest.close();
					}
					break;
				case "api_models":
					setApiModels(message.items);
					break;
				case "droid_state":
					setDroidState({
						enabled: message.enabled,
						devices: message.devices,
						tokens: message.tokens,
						listen: message.listen,
						listenConfig: message.listenConfig,
						lanIps: message.lanIps,
						certPin: message.certPin,
					});
					break;
				case "ios_state":
					setIosState({
						enabled: message.enabled,
						devices: message.devices,
						tokens: message.tokens,
						listen: message.listen,
						listenConfig: message.listenConfig,
						lanIps: message.lanIps,
						certPin: message.certPin,
					});
					break;
				case "api_model":
					if (message.model.projectId === snapshotRef.current?.project?.id) {
						apiModelRequest.accept(message.model.projectId, message.model.id, { model: message.model, events: message.events });
					}
					break;
				case "api_model_result":
					if (!message.ok && message.error) pushError(message.error);
					if (message.ok && message.action === "删除" && message.id === apiModelRequest.current?.id) apiModelRequest.close();
					break;
				case "api_model_export": {
					// The document is text, so the download is built directly instead of
					// going through the base64 path the file panel uses.
					const mime = message.format === "yaml" ? "text/yaml;charset=utf-8" : "application/json;charset=utf-8";
					const url = URL.createObjectURL(new Blob([message.text], { type: mime }));
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = message.filename;
					document.body.appendChild(anchor);
					anchor.click();
					anchor.remove();
					URL.revokeObjectURL(url);
					break;
				}
				case "error":
					doctrineSaveResolverRef.current?.(message.message);
					doctrineSaveResolverRef.current = null;
					pendingInstallRef.current = null;
					// A protocol error naming a message this server does not know means
					// the page is newer than the process serving it: the browser keeps the
					// rebuilt bundle, the server keeps the code it loaded at startup.
					pushError(
						/未知消息类型|Unknown message type/.test(message.message)
							? t("{message}（服务端仍是旧版本，请重启控制台进程）", { message: message.message })
							: message.message,
					);
					projectAction.failed(message.message);
					break;
			}
		},
		[pushError, updateCodeCommit, vulnDetailRequest, assetRequest, pocRequest, codeMonitorRequest, apiModelRequest, supervisorRequest],
	);

	const handleSessionEvent = useCallback((event: SessionEventView) => {
		if (event.type === "agent_start") {
			runOutputTokensRef.current = 0;
			runGenerationMsRef.current = 0;
			assistantStartedAtRef.current = null;
			setRunThroughput(null);
			setRunActive(true);
			// A previous run can leave a live card behind if an event was missed;
			// never let it leak into the next run.
			setLiveTools([]);
			return;
		}
		if (event.type === "message_start") {
			// A new assistant message streams into the live tail; the previous one was
			// already moved into the transcript when it ended.
			const role = (event.message as { role?: string } | undefined)?.role;
			if (role === "assistant") {
				assistantStartedAtRef.current = Date.now();
				setLiveText("");
				setLiveThinking("");
			}
			return;
		}
		if (event.type === "message_update" && event.assistantMessageEvent) {
			const delta = event.assistantMessageEvent as { type: string; delta?: string };
			if (delta.type === "text_delta" && typeof delta.delta === "string") {
				setLiveText((prev) => prev + delta.delta);
			} else if (delta.type === "thinking_delta" && typeof delta.delta === "string") {
				setLiveThinking((prev) => prev + delta.delta);
			}
			return;
		}
		if (event.type === "message_end") {
			const message = event.message as AgentMessageView | undefined;
			if (!message) return;
			if (message.role === "user") {
				// The server echoed the operator's prompt, so it renders in order from
				// the event list instead of the optimistic copy.
				setOptimisticUserMessages((prev) => prev.slice(1));
				setPendingMessages((prev) => [...prev, message]);
				return;
			}
			if (message.role === "system") return;
			if (message.role === "assistant") {
				const usage = (message as { usage?: { output?: number } }).usage;
				const outputTokens = usage?.output ?? 0;
				const startedAt =
					(message as { timestamp?: number }).timestamp ?? assistantStartedAtRef.current ?? Date.now();
				const durationMs = Math.max(1, Date.now() - startedAt);
				assistantStartedAtRef.current = null;
				if (outputTokens > 0) {
					runOutputTokensRef.current += outputTokens;
					runGenerationMsRef.current += durationMs;
					setRunThroughput({
						sessionId: snapshotRef.current?.activeSessionId ?? null,
						tokPerSec: runOutputTokensRef.current / (runGenerationMsRef.current / 1000),
						outputTokens: runOutputTokensRef.current,
						durationMs: runGenerationMsRef.current,
					});
				}
				setLiveText("");
				setLiveThinking("");
				// An assistant turn that only requests tools renders nothing on its own:
				// the tool card below carries it, so it is not added as an empty row.
				if (hasVisibleAssistantContent(message)) setPendingMessages((prev) => [...prev, message]);
				return;
			}
			setPendingMessages((prev) => [...prev, message]);
			if (message.role === "toolResult") {
				// The committed card replaces the running one.
				setLiveTools((prev) => prev.filter((tool) => tool.id !== message.toolCallId));
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			// Nested calls (codemode scripts, for example) are summarized by their
			// parent tool's result. They have no transcript message of their own, so
			// rendering them here leaves cards that can never settle or fold.
			if (event.parentToolCallId) return;
			setLiveTools((prev) => [
				...prev,
				{
					id: event.toolCallId,
					name: event.toolName,
					command: commandFromArgs(event.args),
					status: "running",
					output: "",
					startedAt: Date.now(),
				},
			]);
			return;
		}
		if (event.type === "tool_execution_update") {
			if (event.parentToolCallId) return;
			const partial = event.partialResult as { content?: unknown } | null;
			const text = partial ? textFromContent(partial.content) : "";
			if (text) {
				setLiveTools((prev) =>
					prev.map((tool) => (tool.id === event.toolCallId ? { ...tool, output: text } : tool)),
				);
			}
			return;
		}
		if (event.type === "tool_execution_end") {
			if (event.parentToolCallId) return;
			const text = event.result ? textFromContent(event.result.content) : "";
			setLiveTools((prev) =>
				prev.map((tool) =>
					tool.id === event.toolCallId
						? { ...tool, status: event.isError ? "error" : "done", output: text, durationMs: event.durationMs }
						: tool,
				),
			);
			return;
		}
		if (event.type === "queue_update") {
			setQueuedMessages([
				...event.steering.map((text) => ({ kind: "steer" as const, text })),
				...event.followUp.map((text) => ({ kind: "followUp" as const, text })),
			]);
			return;
		}
		if (event.type === "agent_settled") {
			setRunActive(false);
			// The run finished; any optimistic bubble not absorbed by the final
			// snapshot was consumed by an extension or dropped, so clear it. Messages
			// still queued are rendered from queue_update state.
			setOptimisticUserMessages([]);
			setQueuedMessages([]);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		const check = async () => {
			try {
				const session = await fetch("/api/auth/session");
				if (cancelled) return;
				if (session.ok) {
					const data = (await session.json().catch(() => ({}))) as {
						username?: unknown;
						consent?: { required?: unknown };
					};
					setAuthUser(typeof data.username === "string" ? data.username : null);
					// The promise comes before the console: until it is recorded the
					// server answers 403 to the API and closes the WebSocket.
					setAuthState(data.consent?.required === true ? "consent" : "ready");
					return;
				}
				const state = (await fetch("/api/auth/state")
					.then((r) => r.json())
					.catch(() => null)) as {
					configured?: boolean;
				} | null;
				setAuthState(state?.configured ? "login" : "setup");
			} catch {
				if (!cancelled) setAuthState("login");
			}
		};
		void check();
		return () => {
			cancelled = true;
		};
	}, []);

	const authReady = authState === "ready";
	useEffect(() => {
		setConnectionWarning(false);
		if (!authReady || connected) return;
		// Keep real connection state immediate; only the banner has a grace period.
		const timer = window.setTimeout(() => setConnectionWarning(true), 2000);
		return () => window.clearTimeout(timer);
	}, [authReady, connected]);

	const logout = useCallback(async () => {
		await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
		// Back to the login screen; the connection effect below closes the socket.
		setAuthState("login");
	}, []);

	useEffect(() => {
		if (!authReady) return;
		const connection = new SentinelConnection(
			(message) => handleServerMessage(message),
			(open) => {
				setConnected(open);
				if (!open) {
					vulnDetailRequest.disconnect();
					for (const request of detailRequests) request.disconnect();
					// A check in flight dies with the socket; do not leave spinners stuck.
					setCodeCheckingIds([]);
					codeDispatchingIdsRef.current.clear();
					setCodeMonitorBusy(null);
					codeActivityRequest.disconnect();
					return;
				}
				// Every (re)connect re-reads the whole view. A dropped socket misses
				// events, so the snapshot and the listings are the only way to catch up.
				for (const request of [
					"list_sessions",
					"get_notify_config",
					"get_permissions",
					"get_environment",
					"get_stats",
					"list_projects",
					"list_code_monitors",
					"get_state",
					"get_gatekeeper_config",
					"get_model_library",
					"list_presets",
				] as const) {
					connection.send({ type: request });
				}
			},
		);
		connectionRef.current = connection;
		connection.connect();
		const poll = window.setInterval(() => {
			if (connection.connected) connection.send({ type: "list_sessions" });
		}, 15000);
		return () => {
			window.clearInterval(poll);
			codeActivityRequest.dispose();
			vulnDetailRequest.dispose();
			for (const request of detailRequests) request.dispose();
			connection.close();
		};
	}, [handleServerMessage, authReady, vulnDetailRequest, detailRequests]);

	const switchLanguage = useCallback((language: "zh" | "en") => {
		if (!connectionRef.current?.connected) {
			storeLanguage(language);
			window.location.reload();
			return;
		}
		connectionRef.current.send({ type: "set_ui_language", language });
	}, []);

	const send = useCallback((message: Parameters<SentinelConnection["send"]>[0]) => {
		connectionRef.current?.send(message);
	}, []);

	/** One check per selected monitor; the row spinners follow the ids in flight. */
	const startMonitorChecks = useCallback(
		(ids: string[], trigger: "manual" | "batch" = "manual") => {
			const unique = [...new Set(ids)].filter(Boolean);
			if (unique.length === 0) return;
			setCodeCheckingIds((prev) => [...new Set([...prev, ...unique])]);
			for (const id of unique) send({ type: "check_code_monitor", id, trigger });
		},
		[send],
	);

	const importCodeMonitors = useCallback(
		(inputs: SentinelCodeMonitorInput[]) => {
			if (inputs.length === 0) return;
			send({ type: "import_code_monitors", inputs });
		},
		[send],
	);

	const dismissCodeMonitorImport = useCallback(() => {
		send({ type: "dismiss_code_monitor_import" });
	}, [send]);

	const loadCodeActivity = useCallback(
		(
			projectId: string,
			filter: SentinelCodeActivityFilter,
			page: number,
			pageSize: number,
			category: SentinelVulnCategory | null = null,
			tag: CodeVulnTag | null = null,
			search = "",
			background = false,
		) => {
			codeActivityRequest.load({ projectId, filter, page, pageSize, category, tag, search }, (request) => {
				if (!connectionRef.current?.connected) throw new Error(t("连接已断开，请等待重连后重试"));
				connectionRef.current.send(request);
			}, background);
		},
		[codeActivityRequest],
	);

	const loadPluginBuildLog = useCallback(
		(hostId: string, pluginId: string) => {
			send({ type: "get_plugin_build_log", hostId, pluginId });
		},
		[send],
	);

	/** Create a project and resolve with the server's error message, if any. */
	const addProject = useCallback(
		(name: string, proxyId?: string | null, proxyNode?: string): Promise<string | null> =>
			projectAction.run(() => send({ type: "add_project", name, proxyId, proxyNode })),
		[projectAction, send],
	);

	const recreateProject = useCallback(
		(id: string): Promise<string | null> => projectAction.run(() => send({ type: "recreate_project", id })),
		[projectAction, send],
	);

	const removeProject = useCallback(
		(id: string, confirmName: string, scope: "container" | "data"): Promise<string | null> =>
			projectAction.run(() => send({ type: "remove_project", id, confirmName, scope })),
		[projectAction, send],
	);

	const stopProject = useCallback(
		(id: string): Promise<string | null> => projectAction.run(() => send({ type: "stop_project", id })),
		[projectAction, send],
	);

	const startProject = useCallback(
		(id: string): Promise<string | null> => projectAction.run(() => send({ type: "start_project", id })),
		[projectAction, send],
	);

	/**
	 * Store a project's proxy choice, switching the running sidecar when only the
	 * node changed.
	 *
	 * A different profile means a different configuration and therefore a new
	 * sidecar, which the project only gets on a rebuild; the same profile with a
	 * different node is a `PUT` to the sidecar's control port, so it takes effect
	 * without touching the container.
	 */
	const saveProjectProxy = useCallback(
		(id: string, proxyId: string | null | undefined, proxyNode?: string): Promise<string | null> => {
			const project = projects.find((entry) => entry.id === id);
			const sameProfile = project !== undefined && project.proxyId === proxyId;
			if (sameProfile && typeof proxyId === "string" && proxyNode !== undefined) {
				return projectAction.run(() => send({ type: "switch_project_node", projectId: id, nodeTag: proxyNode }));
			}
			return projectAction.run(() => send({ type: "set_project_proxy", projectId: id, proxyId, proxyNode }));
		},
		[projectAction, projects, send],
	);

	/** The proxy page's own actions all answer with the whole config. */
	const runProxyAction = useCallback(
		(run: () => void, timeoutMs = 60000): Promise<string | null> => proxyAction.run(run, timeoutMs),
		[proxyAction],
	);

	const pluginPages = useMemo<PluginNavEntry[]>(() => {
		const entries = (pluginsView?.plugins ?? []).flatMap((plugin): PluginNavEntry[] => {
			const ui = plugin.manifest.ui;
			const sidebar = ui?.sidebar;
			if (!plugin.pinned || !ui || !sidebar) return [];
			const label = sidebar.label || ui.title || plugin.manifest.name;
			const iconFile = sidebar.icon.split("/").filter(Boolean).pop() ?? "";
			const iconUrl =
				plugin.state === "running" && iconFile
					? `/plugin-icon/${encodeURIComponent(plugin.hostId)}/${encodeURIComponent(plugin.manifest.id)}/${encodeURIComponent(iconFile)}`
					: null;
			return [
				{
					page: `plugin:${encodeURIComponent(plugin.hostId)}:${encodeURIComponent(plugin.manifest.id)}`,
					label,
					title: `${label} · ${plugin.hostName}`,
					iconUrl,
					disabled: plugin.state !== "running",
				},
			];
		});
		return entries.sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
	}, [pluginsView]);

	const navigate = useCallback(
		(entryId: string) => {
			send({ type: "navigate", entryId });
			window.setTimeout(() => send({ type: "get_tree" }), 500);
		},
		[send],
	);

	const openViewer = useCallback((command: string | undefined, output: string) => {
		setViewer({ title: command ? command.slice(0, 80) : t("工具输出"), output });
	}, []);

	// Another session (or project) has a different transcript: the event-built
	// lists belong to the old one and would otherwise sit under the new messages
	// until the operator reloaded the page.
	useEffect(() => {
		setPendingMessages([]);
		setExpandedRuns(new Set());
		setLiveText("");
		setLiveThinking("");
		setLiveTools([]);
		setOptimisticUserMessages([]);
		setQueuedMessages([]);
		// A fresh transcript starts pinned to the bottom; scrolling up unpins.
		transcriptFollowRef.current = true;
	}, [snapshot?.activeSessionId, snapshot?.project?.id]);

	// Keep the transcript pinned to the bottom while new messages, live text or
	// tool cards stream in — unless the operator scrolled up to read, in which
	// case the follow flag stays off until they return near the bottom.
	useEffect(() => {
		const el = transcriptRef.current;
		if (el && transcriptFollowRef.current) el.scrollTop = el.scrollHeight;
	});

	// A different project means a different container: drop anything cached from
	// the previous one and re-read the work directory when the files page is up.
	useEffect(() => {
		setFilePath("/work");
		filePathRef.current = "/work";
		setFileEntries([]);
		setFilePreview(null);
		setSubagentTranscripts({});
		if (filesOpen) loadFiles("/work");
	}, [snapshot?.project?.id, filesOpen, loadFiles]);

	// Opening the file browser always re-lists the directory it is showing.
	useEffect(() => {
		if (filesOpen) loadFiles(filePathRef.current);
	}, [filesOpen, loadFiles]);

	/**
	 * Read one page of the audit log under a filter. The query is remembered so a
	 * live judgment can refresh the very view on screen instead of resetting it.
	 */
	const loadGates = useCallback(
		(filter: SentinelGateFilter, page: number) => {
			gateQueryRef.current = { filter, page };
			send({ type: "gate_audit_query", filter, page, pageSize: 50 });
			send({ type: "gate_audit_stats", filter });
		},
		[send],
	);

	/**
	 * Read the plugin center. A host that does not answer is not an error here:
	 * the reply carries a problem line per host, so the page still renders.
	 */
	const loadPlugins = useCallback(() => {
		setPluginsBusy(true);
		send({ type: "get_plugins" });
		window.setTimeout(() => setPluginsBusy(false), 60000);
	}, [send]);

	/**
	 * Send one plugin request and release the busy lock on a timeout as well as
	 * on the reply. Installing pulls an image and waits for a health check, so it
	 * gets the host's ten-minute budget; every other action gets a minute.
	 */
	const runPluginAction = useCallback(
		(message: SentinelClientMessage, timeoutMs = 60000): void => {
			setPluginsBusy(true);
			send(message);
			window.setTimeout(() => setPluginsBusy(false), timeoutMs);
		},
		[send],
	);


	/** Open one plugin's frontend in the sandboxed overlay. */
	const openPluginUi = useCallback(
		(plugin: SentinelPluginView): void => {
			const nonce =
				typeof crypto !== "undefined" && "randomUUID" in crypto
					? crypto.randomUUID()
					: `nonce-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			pendingPluginUi.current = { plugin, nonce, mode: "overlay" };
			send({ type: "plugin_ui_open", hostId: plugin.hostId, pluginId: plugin.manifest.id });
		},
		[send],
	);

	/** Open a pinned plugin as a full page in the content area. */
	const openPluginPage = useCallback(
		(pageId: string): void => {
			const parts = pageId.split(":");
			const hostId = decodeURIComponent(parts[1] ?? "");
			const pluginId = decodeURIComponent(parts.slice(2).join(":"));
			const plugin = pluginsView?.plugins.find(
				(entry) => entry.hostId === hostId && entry.manifest.id === pluginId,
			);
			if (!plugin) return;
			const nonce =
				typeof crypto !== "undefined" && "randomUUID" in crypto
					? crypto.randomUUID()
					: `nonce-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			pendingPluginUi.current = { plugin, nonce, mode: "page" };
			send({ type: "plugin_ui_open", hostId, pluginId });
		},
		[pluginsView, send],
	);

	const openPage = useCallback(
		(next: SentinelPageId) => {
			setEngineEntryId(null);
			setPage(next);
			if (next.startsWith("plugin:")) {
				openPluginPage(next);
			} else {
				setPluginPage(null);
			}
			if (next === "supervisor") {
				supervisorRequest.close();
				connectionRef.current?.send({ type: "supervisor_audit", page: 1 });
			}
		},
		[openPluginPage, supervisorRequest],
	);

	const showSupervisorWindow = useCallback(() => {
		if (!supervisor) return;
		setSupervisorWindowOpen(true);
		if (supervisorEpisodes.length === 0 && supervisorDetailSessionRef.current !== supervisor.sessionId) {
			supervisorDetailSessionRef.current = supervisor.sessionId;
			send({ type: "supervisor_detail", sessionId: supervisor.sessionId });
		}
	}, [supervisor, supervisorEpisodes.length, send]);

	// Switching conversations while the window stays open re-reads the new
	// session's episode history once, without looping when the list is empty.
	useEffect(() => {
		if (!supervisorWindowOpen || !supervisor) return;
		if (supervisorDetailSessionRef.current === supervisor.sessionId) return;
		supervisorDetailSessionRef.current = supervisor.sessionId;
		send({ type: "supervisor_detail", sessionId: supervisor.sessionId });
	}, [supervisorWindowOpen, supervisor, send]);

	/**
	 * One bridge call from the iframe. The server validates the method and the
	 * capability again; this side only correlates the request id.
	 */
	const callPluginUi = useCallback(
		(method: string, params: unknown): Promise<PluginUiCallResult> => {
			const active = pluginUi ?? pluginPage;
			if (!active) return Promise.resolve({ ok: false, error: t("插件界面未打开") });
			const requestId =
				typeof crypto !== "undefined" && "randomUUID" in crypto
					? crypto.randomUUID()
					: `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			return new Promise((resolve) => {
				const timer = window.setTimeout(() => {
					pluginUiResolvers.current.delete(requestId);
					resolve({ ok: false, error: t("插件界面请求超时") });
				}, 600000);
				pluginUiResolvers.current.set(requestId, (message) => {
					window.clearTimeout(timer);
					resolve({ ok: message.ok, result: message.result, error: message.error });
				});
				send({
					type: "plugin_ui_call",
					requestId,
					hostId: active.plugin.hostId,
					pluginId: active.plugin.manifest.id,
					method,
					params,
				});
			});
		},
		[pluginUi, pluginPage, send],
	);

	const pluginUiContext = useMemo<PluginUiContext | null>(() => {
		const active = pluginUi ?? pluginPage;
		if (!active) return null;
		const plugin = active.plugin;
		return {
			plugin: {
				id: plugin.manifest.id,
				name: plugin.manifest.name,
				version: plugin.manifest.version,
				author: plugin.manifest.author,
			},
			host: { id: plugin.hostId, name: plugin.hostName },
			project: snapshot?.project?.name ?? null,
			tools: plugin.manifest.tools,
			configKeys: plugin.configured,
		};
	}, [pluginUi, pluginPage, snapshot?.project?.name]);

	/** Re-read whatever the active page (or overlay) is showing. */
	const refreshPage = useCallback(() => {
		if (filesOpen) loadFiles(filePathRef.current);
		if (subagentsOpen) send({ type: "get_state" });
		switch (page) {
			case "reports":
				setReportRefresh((value) => value + 1);
				break;
			case "dashboard":
				send({ type: "get_state" });
				send({ type: "list_sessions" });
				send({ type: "list_engines" });
				send({ type: "list_vulns" });
				break;
			case "chat":
				send({ type: "get_state" });
				refreshStats();
				break;
			case "projects":
				send({ type: "list_projects" });
				send({ type: "list_sessions" });
				break;
			case "proxies":
				// The page's own view, not the environment report: opening it must not
				// depend on a Docker check having run.
				send({ type: "get_proxy_config" });
				break;
			case "vulns":
				send({ type: "list_vulns", filters: vulnFilters });
				break;
			case "assets":
				send({
					type: "list_assets",
					filters: assetFilters,
					page: assetPage,
					pageSize: assetPageSize,
				});
				break;
			case "pocs":
				send({ type: "list_pocs", filters: pocFilters });
				break;
			case "codeintel":
				send({ type: "list_code_monitors" });
				send({ type: "list_engines" });
				break;
			case "apimodels":
				send({ type: "list_api_models" });
				break;
			case "droid":
				send({ type: "droid_state" });
				break;
			case "ios":
				send({ type: "ios_state" });
				break;
			case "settings.model":
				send({ type: "get_model_library" });
				send({ type: "get_gatekeeper_config" });
				break;
			case "settings.supervisor":
				// supervisorConfig rides the snapshot and every save reply.
				break;
			case "gates":
				// Re-read the view on screen rather than resetting it to page 1.
				loadGates(gateFilter, gatePage);
				break;
			case "supervisor":
				send({ type: "supervisor_audit", page: supervisorAudit?.page ?? 1 });
				break;
			case "settings.notify":
				send({ type: "get_notify_config" });
				break;
			case "settings.permissions":
				send({ type: "get_permissions" });
				// The plugin rows are owned by the plugin center, so they come from its view.
				loadPlugins();
				break;
			case "settings.mcp":
				// Also pushed on connect; this refreshes after another window changed it.
				send({ type: "get_mcp_servers" });
				break;
			case "settings.plugins":
				loadPlugins();
				break;
			case "settings.environment":
				send({ type: "get_environment" });
				break;
			case "settings.pocs":
				send({ type: "list_poc_sources" });
				break;
			case "settings.assets":
				// The server also pushes this on connect; this refreshes on navigation.
				send({ type: "get_asset_config" });
				break;
			case "settings.websearch":
				// The server also pushes this on connect; this refreshes on navigation.
				send({ type: "get_websearch_config" });
				break;
			case "settings.presets":
				send({ type: "list_presets" });
				break;
			case "settings.security":
				// REST-backed; nothing to pull over the socket.
				break;
			case "about":
				send({ type: "get_state" });
				send({ type: "get_model_library" });
				refreshStats();
				break;
		}
	}, [
		page,
		filesOpen,
		subagentsOpen,
		send,
		refreshStats,
		loadFiles,
		vulnFilters,
		assetFilters,
		assetPage,
		assetPageSize,
		pocFilters,
		gateFilter,
		gatePage,
		loadGates,
		loadPlugins,
	]);

	/** The landing page reads project data without opening or creating a session. */
	useEffect(() => {
		if (page !== "dashboard" || !connected) return;
		send({ type: "list_sessions" });
		send({ type: "list_engines" });
		send({ type: "list_vulns" });
	}, [page, connected, snapshot?.project?.id, send]);

	/**
	 * The audit page reads on open and on every filter change. Its query is also
	 * remembered, so judgments that land while it is open refresh the same view.
	 */
	useEffect(() => {
		if (page !== "gates" || !connected) return;
		loadGates(gateFilter, gatePage);
	}, [page, connected, gateFilter, gatePage, loadGates]);

	/**
	 * The POC page reads on open: imports and syncs push the library, but a
	 * console that imported before this page was ever opened has no push to
	 * rely on, and would show an empty table over a full database.
	 */
	useEffect(() => {
		if (page !== "pocs" || !connected) return;
		send({ type: "list_pocs", filters: pocFilters, page: pocPage });
	}, [page, connected, pocFilters, pocPage, send]);

	/**
	 * The watch page reads its list on open and whenever the project changes. The
	 * list is project-scoped on screen, but the server broadcast is pushed only
	 * after a change; without this read a fresh page shows an empty table over a
	 * populated database.
	 */
	useEffect(() => {
		if (page !== "codeintel" || !connected) return;
		send({ type: "list_code_monitors" });
		send({ type: "get_code_monitor_import" });
	}, [page, connected, snapshot?.project?.id, send]);

	/** The plugin center is host state with no push, so opening it reads the page. */
	useEffect(() => {
		if (page !== "settings.plugins" || !connected) return;
		loadPlugins();
	}, [page, connected, loadPlugins]);

	/** Subscription sources are host state with no push either, so opening the page reads them. */
	useEffect(() => {
		if (page !== "settings.pocs" || !connected) return;
		send({ type: "list_poc_sources" });
	}, [page, connected, send]);

	// Pinned plugin pages live in the sidebar, so the plugin list has to load on
	// connect rather than only when the plugin settings page is opened.
	useEffect(() => {
		if (!connected) return;
		loadPlugins();
		send({ type: "list_official_plugins" });
	}, [connected, loadPlugins, send]);

	// Leaving the page drops the remembered query, so a judgment arriving while the
	// operator is elsewhere does not trigger a query nobody is looking at.
	useEffect(() => {
		if (page === "gates") return;
		gateQueryRef.current = null;
	}, [page]);

	/**
	 * The hub re-reads on every project change: findings are project-scoped, so
	 * what is on screen belongs to the previous project the moment it switches.
	 * The list is also read once on connect, so the sidebar badge is right even
	 * if the page is never opened.
	 */
	useEffect(() => {
		setVulnFilters({});
		vulnFiltersRef.current = {};
		setVulnItems([]);
		vulnDetailRequest.close();
		setVulnPreview(null);
		vulnPreviewPathRef.current = null;
	}, [snapshot?.project?.id, vulnDetailRequest]);

	useEffect(() => {
		if (connected) send({ type: "list_vulns" });
	}, [snapshot?.project?.id, connected, send]);

	useEffect(() => {
		if (page !== "vulns") vulnDetailRequest.close();
	}, [page, vulnDetailRequest]);

	// Message handlers read the current page without closing over an old render.
	useEffect(() => {
		pageRef.current = page;
	}, [page]);
	useEffect(() => {
		if (page !== "assets") assetRequest.close();
		if (page !== "pocs") pocRequest.close();
		if (page !== "codeintel") codeMonitorRequest.close();
		if (page !== "apimodels") apiModelRequest.close();
		if (page !== "supervisor") supervisorRequest.close();
	}, [page, assetRequest, pocRequest, codeMonitorRequest, apiModelRequest, supervisorRequest]);

	useEffect(() => {
		assetRequest.close();
		codeMonitorRequest.close();
		apiModelRequest.close();
	}, [snapshot?.project?.id, assetRequest, codeMonitorRequest, apiModelRequest]);

	/** A folder archive belongs to one project's container; drop it on a switch. */
	useEffect(() => {
		const current = folderArchiveRef.current;
		if (
			current?.id &&
			(current.status === "starting" || current.status === "running" || current.status === "cancelling")
		) {
			connectionRef.current?.send({ type: "cancel_folder_archive", id: current.id });
		}
		folderArchiveRef.current = null;
		setFolderArchive(null);
	}, [snapshot?.project?.id]);

	/** The inventory is project-scoped and starts on page 1 after a switch. */
	useEffect(() => {
		setAssetFilters({});
		assetFiltersRef.current = {};
		setAssetPage(1);
		assetPageRef.current = 1;
		setAssetPageSize(50);
		assetPageSizeRef.current = 50;
		setAssetItems([]);
		setAssetStats({
			total: 0,
			byKind: { domain: 0, ip: 0, service: 0, url: 0 },
			byStatus: { pending: 0, testing: 0, tested: 0, out_of_scope: 0 },
			tested: 0,
			untested: 0,
		});
		setAssetTotal(0);
		setAssetHasMore(false);
		setAssetDeletePending(null);
		setAssetDeletePreview(null);
	}, [snapshot?.project?.id]);

	/** Load one page of the inventory with the filters the page is showing. */
	useEffect(() => {
		if (!connected || page !== "assets") return;
		send({
			type: "list_assets",
			filters: assetFiltersRef.current,
			page: assetPageRef.current,
			pageSize: assetPageSizeRef.current,
		});
	}, [page, connected, snapshot?.project?.id, send]);

	/** Re-read the hub under the current filter. */
	const loadVulns = useCallback(
		(filters: SentinelVulnFilters) => {
			setVulnFilters(filters);
			vulnFiltersRef.current = filters;
			send({ type: "list_vulns", filters });
		},
		[send],
	);

	/** Ask the server what deleting these records would take with them. */
	const requestVulnDelete = useCallback(
		(ids: string[]) => {
			if (ids.length === 0) return;
			setVulnDeletePending(ids);
			setVulnDeletePreview(null);
			send({ type: "preview_vuln_delete", ids });
		},
		[send],
	);

	const confirmVulnDelete = useCallback(
		(ids: string[]) => {
			if (ids.length === 0) return;
			send({ type: "delete_vulns", ids });
		},
		[send],
	);

	const cancelVulnDelete = useCallback(() => {
		setVulnDeletePending(null);
		setVulnDeletePreview(null);
	}, []);

	/** Inventory page load; the filters and paging the page is showing are refs. */
	const loadAssets = useCallback(
		(filters: SentinelAssetFilters, page: number, pageSize: number) => {
			setAssetFilters(filters);
			assetFiltersRef.current = filters;
			setAssetPage(page);
			assetPageRef.current = page;
			setAssetPageSize(pageSize);
			assetPageSizeRef.current = pageSize;
			send({ type: "list_assets", filters, page, pageSize });
		},
		[send],
	);

	/** Detail reads fail visibly while offline instead of replaying an obsolete click. */
	const sendDetail = useCallback((request: SentinelClientMessage) => {
		if (!connectionRef.current?.connected) throw new Error(getLanguage() === "en"
			? "Connection lost. Retry after reconnecting." : "连接已断开，请等待重连后重试。");
		connectionRef.current.send(request);
	}, []);

	const openAsset = useCallback(
		(id: string) => {
			const projectId = snapshotRef.current?.project?.id;
			if (projectId) assetRequest.open(projectId, id, () => sendDetail({ type: "get_asset", id }));
		},
		[assetRequest, sendDetail],
	);

	const updateAsset = useCallback(
		(id: string, patch: SentinelAssetUpdate) => {
			send({ type: "update_asset", id, patch });
		},
		[send],
	);

	const requestAssetDelete = useCallback(
		(ids: string[]) => {
			if (ids.length === 0) return;
			setAssetDeletePending(ids);
			setAssetDeletePreview(null);
			send({ type: "preview_asset_delete", ids });
		},
		[send],
	);

	const confirmAssetDelete = useCallback(
		(ids: string[]) => {
			if (ids.length === 0) return;
			send({ type: "delete_assets", ids });
		},
		[send],
	);

	const cancelAssetDelete = useCallback(() => {
		setAssetDeletePending(null);
		setAssetDeletePreview(null);
	}, []);

	/**
	 * Modeling records are project-scoped like findings, so the page re-reads on
	 * every project change and once on connect. A drill-down from the previous
	 * project is dropped rather than shown over the new one.
	 */
	useEffect(() => {
		if (connected) send({ type: "list_api_models" });
	}, [snapshot?.project?.id, connected, send]);

	/** Re-read the library under the current filter. */
	const loadPocs = useCallback((filters: SentinelPocFilters) => {
		setPocFilters(filters);
		// A new filter restarts the listing, so the effect re-reads page 1.
		setPocPage(1);
	}, []);

	/** Turn the library page; the active filter stays as it is. */
	const loadPocsPage = useCallback((page: number) => {
		setPocPage(page);
	}, []);

	/** One template in full, in the detail overlay. */
	const openPoc = useCallback(
		(id: string) => {
			pocRequest.open(null, id, () => sendDetail({ type: "get_poc", id }));
		},
		[pocRequest, sendDetail],
	);

	/**
	 * Upload one file per HTTP request, then poll its import job. A zip stays a
	 * single streamed body instead of becoming a base64 WebSocket message, and
	 * the server imports it asynchronously so the page can show live counters.
	 */
	const importPocs = useCallback(
		async (files: File[]) => {
			if (files.length === 0) return;
			if (files.length > 2000) {
				pushError(t("一次最多导入 2000 个文件，请打包成 zip 或分批上传"));
				return;
			}
			const totalBytes = files.reduce((total, file) => total + file.size, 0);
			if (totalBytes > POC_UPLOAD_MAX_BYTES) {
				pushError(t("文件总大小超过 {limit}MB 上限", { limit: Math.round(POC_UPLOAD_MAX_BYTES / 1024 / 1024) }));
				return;
			}
			setPocImporting(true);
			setPocImportProgress(null);
			setLastPocImport(null);
			const outcomes: SentinelPocImportOutcome[] = [];
			try {
				for (const file of files) {
					const id = await uploadPocFile(file);
					outcomes.push(await waitForPocImport(id, setPocImportProgress));
				}
				setLastPocImport(mergePocImportOutcomes(outcomes));
			} catch (error) {
				if (outcomes.length > 0) setLastPocImport(mergePocImportOutcomes(outcomes));
				pushError(t("导入失败：{error}", { error: error instanceof Error ? error.message : String(error) }));
			} finally {
				setPocImporting(false);
				setPocImportProgress(null);
			}
		},
		[pushError],
	);

	/** The one-click official sync: the server creates the source if it is gone. */
	const syncOfficialPocs = useCallback(() => {
		setPocOfficialSyncing(true);
		send({ type: "sync_official_pocs" });
	}, [send]);

	/** Open immediately; a slow or disconnected request stays visible and retryable. */
	const openVuln = useCallback(
		(id: string) => {
			const projectId = snapshotRef.current?.project?.id;
			if (!projectId) return;
			setVulnPreview(null);
			vulnPreviewPathRef.current = null;
			vulnDetailRequest.open(projectId, id, (request) => {
				if (!connectionRef.current?.connected) throw new Error(getLanguage() === "en"
					? "Connection lost. Retry after reconnecting."
					: "连接已断开，请等待重连后重试。");
				connectionRef.current.send(request);
			});
		},
		[vulnDetailRequest],
	);

	/**
	 * Jump from a finding to the conversation that reported it. Findings carry
	 * the session id; the path is what switch_session needs, and the sessions
	 * list is refreshed with the project.
	 */
	const openVulnSession = useCallback(
		(sessionId: string) => {
			const path = sessions.find((session) => session.id === sessionId)?.path;
			if (!path) {
				pushError(t("对应会话已删除，无法跳转"));
				return;
			}
			openPage("chat");
			send({ type: "switch_session", path });
		},
		[sessions, openPage, pushError, send],
	);

	/** Cross-navigation: an asset's linked finding opens the hub's detail. */
	const openVulnFromAsset = useCallback(
		(id: string) => {
			assetRequest.close();
			setPage("vulns");
			openVuln(id);
		},
		[openVuln, assetRequest],
	);

	/** Cross-navigation: a finding's linked asset opens the inventory detail. */
	const openAssetFromVuln = useCallback(
		(id: string) => {
			vulnDetailRequest.close();
			setVulnPreview(null);
			vulnPreviewPathRef.current = null;
			setPage("assets");
			openAsset(id);
		},
		[openAsset, vulnDetailRequest],
	);

	/** Preview an evidence file. It lives in the project's container, not the host. */
	const previewVulnFile = useCallback(
		(path: string) => {
			vulnPreviewPathRef.current = path;
			send({ type: "read_file", path });
		},
		[send],
	);

	const mode: SentinelMode = snapshot?.mode ?? "review";
	const gatekeeper = snapshot?.gatekeeper ?? null;
	const streaming = runActive;
	/** Active runs plus the sessions a background task is writing to. */
	const runningSessionIds =
		runActive && snapshot?.activeSessionId
			? [...new Set([...(snapshot.runningSessions ?? []), snapshot.activeSessionId])]
			: (snapshot?.runningSessions ?? []);
	const pendingApprovals = snapshot?.pendingApprovals ?? [];
	const needsConfig = snapshot !== null && !snapshot.modelConfigured;
	/** No project means no container, so the console blocks the chat entirely. */
	const needsProject = snapshot !== null && snapshot.project === null;
	const subagentRuns = snapshot?.subagents ?? [];
	const subagentTotal = snapshot?.subagentTotal ?? subagentRuns.length;
	const subagentRunning = subagentRuns.filter((run) => run.status === "running").length;

	useEffect(() => {
		setSubagentPage(null);
	}, [snapshot?.activeSessionId]);
	const goal = snapshot?.goal ?? null;
	/**
	 * The judge answered nothing since its last failure: commands are being let
	 * through ungated right now. A failure older than the newest success is
	 * history, and a banner that never went away would be ignored when it matters.
	 */
	const gateDown =
		gatekeeper !== null &&
		gatekeeper.lastFailureAt !== null &&
		(gatekeeper.lastSuccessAt === null || gatekeeper.lastFailureAt > gatekeeper.lastSuccessAt);
	const showGateBanner = gateDown && dismissedGateFailure !== gatekeeper?.lastFailureAt;
	/**
	 * Why the goal button is unavailable, or null when it can start one. The
	 * reasons mirror the server's own refusals, so the button never opens a dialog
	 * whose submission is guaranteed to fail.
	 */
	const goalDisabledReason = needsProject
		? t("请先创建或选择一个项目")
		: envReport && !envReport.ok
			? t("Docker 环境不可用，无法启动目标")
			: mode === "review"
				? t("持续目标只在自动执行或 AI 审批模式下可用：请先切换模式")
				: streaming
					? t("Agent 正在运行，等本轮结束或中止后再启动")
					: snapshot?.compacting
						? t("正在压缩上下文，压缩完成或中止后再启动目标")
						: goal && goal.status !== "completed"
							? t("当前会话已有未结束的目标")
							: null;

	const visibleMessages = useMemo(
		() => (snapshot?.messages ?? []).filter((message) => message.role !== "system"),
		[snapshot],
	) as AgentMessageView[];

	/**
	 * Commands of the tool calls in the transcript, by tool-call id. A tool result
	 * message carries the output but not the command, so this is what lets a
	 * finished card still show what was run.
	 */
	const toolCommands = useMemo(() => {
		const commands = new Map<string, string>();
		for (const message of [...visibleMessages, ...pendingMessages]) {
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				const call = block as { type?: string; id?: string; arguments?: Record<string, unknown> };
				if (call.type === "toolCall" && call.id) commands.set(call.id, commandFromArgs(call.arguments));
			}
		}
		return commands;
	}, [visibleMessages, pendingMessages]);

	const forkEntryIds = useMemo(() => {
		const ids = new Map<string, string>();
		let index = 0;
		for (const message of visibleMessages) {
			if (message.role !== "user") continue;
			const entryId = forkPoints[index++]?.entryId;
			if (entryId) ids.set(messageKey(message), entryId);
		}
		return ids;
	}, [visibleMessages, forkPoints]);

	/**
	 * The transcript grouped into runs. A summary marker is its own group, and a
	 * stretch a compaction kept folds like any other run, even though the prompt it
	 * answered is no longer the first message in front of it.
	 */
	const runGroups = useMemo(
		() => groupRuns([...visibleMessages, ...pendingMessages]),
		[visibleMessages, pendingMessages],
	);

	/** Whether a run may fold, and whether it is folded right now. */
	const runFold = useCallback(
		(index: number) => runFoldState({ groups: runGroups, index, streaming, expanded: expandedRuns }),
		[runGroups, streaming, expandedRuns],
	);

	useEffect(() => {
		if (!streaming) send({ type: "get_tree" });
	}, [streaming, send, snapshot?.messages.length]);

	useEffect(() => {
		if (!streaming) refreshStats();
	}, [streaming, refreshStats, snapshot?.messages.length]);

	const activeSession = sessions.find((session) => session.id === snapshot?.activeSessionId);
	const sessionLabel = activeSession?.name ?? activeSession?.firstMessage.slice(0, 30) ?? t("未选择会话");
	if (authState === "checking") {
		return <div className="app app--boot" />;
	}
	if (authState === "setup" || authState === "login") {
		return (
			<AuthGate
				mode={authState}
				// The setup/login response already set the cookie; read the account
				// name back so the sider shows it without a reload.
				onDone={() => {
					void (async () => {
						const session = await fetch("/api/auth/session").catch(() => null);
						const data = (await session?.json().catch(() => ({}))) as
							| { username?: unknown; consent?: { required?: unknown } }
							| undefined;
						setAuthUser(typeof data?.username === "string" ? data.username : null);
						setAuthState(data?.consent?.required === true ? "consent" : "ready");
					})();
				}}
			/>
		);
	}
	if (authState === "consent") {
		return <ConsentGate onAccepted={() => setAuthState("ready")} />;
	}

	return (
		<>
			<ConsoleShell
				page={page}
				onNavigate={openPage}
				collapsed={sidebarCollapsed}
				onToggleCollapse={() => {
					setSidebarCollapsed((prev) => {
						const next = !prev;
						localStorage.setItem("sentinel-sidebar-collapsed", next ? "1" : "0");
						return next;
					});
				}}
				connected={connected}
				mode={mode}
				authUser={authUser}
				modelConfigured={snapshot?.modelConfigured ?? false}
				pendingApprovals={pendingApprovals.length}
				pendingVulns={vulnStats.byStatus.pending}
				pluginPages={pluginPages}
				projects={projects}
				activeProject={snapshot?.project ?? null}
				busy={streaming}
				sessionPanel={needsProject ? undefined : {
					sessions,
					activeSessionId: snapshot?.activeSessionId ?? null,
					runningSessions: runningSessionIds,
					engines,
					onNew: () => send({ type: "new_session" }),
					onSwitch: (path) => send({ type: "switch_session", path }),
					onRename: (path, name) => send({ type: "rename_session", path, name }),
					onDelete: (path) => send({ type: "delete_session", path }),
					onSetStatus: (path, status) => send({ type: "set_session_status", path, status }),
				}}
				onSwitchProject={(id) => send({ type: "switch_project", id })}
				onCreateProject={addProject}
				proxyConfig={proxyView}
				onManageProjects={() => openPage("projects")}
				onRefresh={refreshPage}
				onLogout={() => {
					void logout();
				}}
				onSwitchLanguage={switchLanguage}
			>
					{/* A page that throws costs that page, not the console: the shell stays
					    usable and the message says what broke. */}
					<PageBoundary key={page} onHome={() => openPage("dashboard")}>
					{connected || !connectionWarning ? null : (
						<Alert
							type="warning"
							showIcon
							className="console-banner"
							title={t("与后端连接已断开，正在自动重连")}
							description={
								<span>
									{t("若浏览器提示 ERR_ADDRESS_INVALID，请确认打开的是")}
									<code> http://127.0.0.1:{t("端口")} </code>
									{t("（0.0.0.0 不是可访问地址）。")}
								</span>
							}
						/>
					)}
					{envReport && !envReport.ok ? (
						<Alert
							type="error"
							showIcon
							className="console-banner"
							title={t("Docker 环境不可用，对话已锁定：{reason}。", {
								reason:
									envReport.items.find((entry) => entry.blocking && entry.status !== "ok")?.label ??
									t("环境检查未通过"),
							})}
							description={t("构建镜像后才能开始对话。")}
							action={
								<Button size="small" type="link" onClick={() => setPage("settings.environment")}>
									{t("设置 → 环境")}
								</Button>
							}
						/>
					) : null}
					{showGateBanner ? (
						<Alert
							type="warning"
							showIcon
							closable
							className="console-banner"
							onClose={() => setDismissedGateFailure(gatekeeper?.lastFailureAt ?? null)}
							title={t("守门模型不可用，已放行 {count} 次判定（AI 审批模式下命令未经过拦截直接执行）。", {
								count: gatekeeper?.failures ?? 0,
							})}
							description={
								<span>
									{gatekeeper?.lastError ? `${t("最近错误：{error}", { error: gatekeeper.lastError })} ` : ""}
									{t("请检查守门端点，或到")}
									<Button size="small" type="link" onClick={() => setPage("settings.model")}>
										{t("设置 → 模型")}
									</Button>
									<Button size="small" type="link" onClick={() => setPage("gates")}>
										{t("审批")}
									</Button>
									{t("查看失败记录。")}
								</span>
							}
						/>
					) : null}
					{/* The gate replaces the chat page only: settings and the project list
					    must stay reachable, or a first run could never build the image. */}
					{page.startsWith("plugin:") ? (
						pluginPage && pluginUiContext ? (
							<div className="page-card plugin-page-card">
								<PluginUiOverlay
									variant="page"
									plugin={pluginPage.plugin}
									nonce={pluginPage.nonce}
									token={pluginPage.token}
									context={pluginUiContext}
									onCall={callPluginUi}
									onClose={() => {}}
								/>
							</div>
						) : (
							<div className="page-card">
								<p className="muted">{t("正在打开插件界面…")}</p>
							</div>
						)
					) : needsProject && (page === "chat" || page === "dashboard") ? (
						<ProjectGate
							projects={projects}
							proxyConfig={proxyView}
							busy={streaming}
							onCreate={addProject}
							onSwitch={(id) => send({ type: "switch_project", id })}
							onOpenSettings={() => openPage("settings.model")}
						/>
					) : page === "dashboard" ? (
						<DashboardPage
							project={projects.find((project) => project.id === snapshot?.project?.id) ?? snapshot?.project ?? null}
							sessions={sessions}
							runningSessions={runningSessionIds}
							engines={engines}
							pendingApprovals={pendingApprovals.length}
							vulnStats={vulnStats}
							loading={!connected || snapshot === null}
							onNavigate={openPage}
							onOpenSession={(path) => {
								send({ type: "switch_session", path });
								openPage("chat");
							}}
						/>
					) : page === "chat" ? (
						<div className="chat-workspace">
							<div className="chat-main">
								<div className="page-card">
							<div className="chat-head">
								<span className="chat-head__name">{t("对话")}</span>
								<span className="chat-head__sub" title={activeSession?.firstMessage}>
									{sessionLabel}
								</span>
							</div>
							<ChatToolbar
								mode={mode}
								sessionOverride={gatekeeper?.sessionOverride ?? null}
								globalMode={gatekeeper?.globalMode ?? "review"}
								streaming={streaming}
								pendingApprovals={pendingApprovals.length}
								subagentRunning={subagentRunning}
								thinkingLevel={snapshot?.thinkingLevel ?? "off"}
								availableThinkingLevels={snapshot?.availableThinkingLevels ?? []}
								branchOpen={branchOpen}
								filesOpen={filesOpen}
								subagentsOpen={subagentsOpen}
								terminalOpen={terminalOpen}
								project={snapshot?.project ?? null}
								allowedPrefixes={snapshot?.allowedPrefixes ?? []}
								sessionStatus={snapshot?.sessionStatus ?? null}
								preset={snapshot?.preset ?? null}
								onSetSessionStatus={(status) => send({ type: "set_session_status", status })}
								onToggleFiles={() => setFilesOpen((prev) => !prev)}
								onToggleSubagents={() => setSubagentsOpen((prev) => !prev)}
								onToggleTerminal={() => setTerminalOpen((prev) => !prev)}
								onSetMode={(next) => send({ type: "set_mode", mode: next })}
								onSetThinkingLevel={(level) => send({ type: "set_thinking_level", level })}
								onToggleBranch={() => {
									setBranchOpen((prev) => {
										const next = !prev;
										localStorage.setItem("sentinel-branch-open", next ? "1" : "0");
										return next;
									});
									send({ type: "get_tree" });
								}}
								onCompact={() => send({ type: "compact" })}
								onAbortCompaction={() => send({ type: "abort_compaction" })}
								compacting={snapshot?.compacting ?? false}
								compactionStartedAt={snapshot?.compactionStartedAt ?? null}
								onAllowPrefix={(prefix) => send({ type: "allow_prefix", prefix })}
								onRemoveAllowedPrefix={(prefix) => send({ type: "remove_allowed_prefix", prefix })}
							/>
							{goal ? (
								<GoalBar
									goal={goal}
									streaming={streaming}
									onPause={() => send({ type: "pause_goal" })}
									onResume={() => send({ type: "resume_goal" })}
									onClear={() => send({ type: "clear_goal" })}
								/>
							) : null}
							<div className="ws-panel__body">
								<div
									className="transcript"
									ref={transcriptRef}
									onScroll={() => {
										const el = transcriptRef.current;
										if (el) {
											transcriptFollowRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
										}
									}}
								>
									{visibleMessages.length === 0 && !liveText && !streaming ? (
										<Empty
											className="chat-empty"
											image={Empty.PRESENTED_IMAGE_SIMPLE}
											description={
												<>
													<div>{t("等待第一条指令")}</div>
													<div className="chat-empty__hint">
														{needsConfig
															? t("请先在「设置 → 模型」中配置 OpenAI 兼容端点。")
															: t("例如：对 10.10.10.5 进行全端口侦察，或派子代理并行侦察多个目标。")}
													</div>
												</>
											}
										/>
									) : null}
									{runGroups.map((group, groupIndex) => {
										// Compaction summaries live inside the run they happened
										// in: process, folded with everything else.
										const fold = runFold(groupIndex);
										const live = streaming && groupIndex === runGroups.length - 1;
										const summary = group.body[group.body.length - 1];
										return (
											<div className="run-group" key={group.key}>
												{group.prompt ? (
													<MessageView
														message={group.prompt}
														forkEntryId={forkEntryIds.get(messageKey(group.prompt))}
														onFork={streaming ? undefined : navigate}
														onFullscreen={openViewer}
													/>
												) : null}
												{fold ? (
													<RunFold
														digest={fold.digest}
														open={!fold.collapsed}
														onToggle={() =>
															setExpandedRuns((prev) => {
																const next = new Set(prev);
																if (next.has(group.key)) next.delete(group.key);
																else next.add(group.key);
																return next;
															})
														}
													/>
												) : null}
												{fold?.collapsed ? (
													<MessageView
														message={summary}
														toolCommand={toolCommandOf(summary, toolCommands)}
														onFullscreen={openViewer}
													/>
												) : (
													<div className="run-body">
														{group.body.map((message, bodyIndex) => (
															<MessageView
																key={`${group.key}-${bodyIndex}`}
																message={message}
																toolCommand={toolCommandOf(message, toolCommands)}
																onFullscreen={openViewer}
																// 方案 B：已完成的步骤一律单行手风琴（含流式运行
																// 组里刚结束的调用）；正在执行中的那一个调用仍是
																// 完整卡片（下面的 liveTools），方便实时看输出。
																compact
															/>
														))}
														{live && liveThinking ? (
															<AgentEntry>
																<details className="thinking">
																	<summary>{t("思考中…")}</summary>
																	<pre>{liveThinking}</pre>
																</details>
															</AgentEntry>
														) : null}
														{live
															? liveTools.map((tool) => (
																	<ToolCard
																		key={tool.id}
																		name={tool.name}
																		status={tool.status}
																		time={formatTime(tool.startedAt)}
																		durationMs={tool.durationMs}
																		command={tool.command}
																		output={tool.output}
																		onFullscreen={openViewer}
																	/>
																))
															: null}
														{live && liveText ? (
															<AgentEntry>
																<MarkdownText text={liveText} />
															</AgentEntry>
														) : null}
													</div>
												)}
											</div>
										);
									})}
									{snapshot?.goal &&
									snapshot.goal.status !== "active" &&
									!chattedAfterGoalEnd(snapshotRef.current?.messages ?? [], {
										// Paused goals written before endedAt existed fall
										// back to updatedAt, which pause() always set.
										endedAt: snapshot.goal.endedAt ?? snapshot.goal.updatedAt,
									}) ? (
										<div className={`goal-end-badge ${snapshot.goal.status}`}>
											<span className="chip">
												<b>
													{snapshot.goal.status === "completed"
														? `✓ ${t("目标完成")}`
														: snapshot.goal.status === "blocked"
															? `✕ ${t("目标阻塞")}`
															: `⏸ ${t("目标暂停")}`}
												</b>
												<span className="t">
													{t("共 {rounds} 次迭代 · 总耗时 {duration}", {
														rounds: snapshot.goal.rounds.length,
														duration: formatGoalTotalMs(
															(snapshot.goal.endedAt ?? snapshot.goal.updatedAt) - snapshot.goal.startedAt,
														),
													})}
												</span>
											</span>
										</div>
									) : null}
									{optimisticUserMessages.map((item, index) => (
										<div key={`optimistic-${index}`} className="log-op pending">
											<span className="log-op-mark">&gt;</span>
											<div className="log-op-body">
												{item.text}
												{item.imageCount > 0 ? t("（附 {count} 张图片）", { count: item.imageCount }) : ""}
											</div>
										</div>
									))}
									{queuedMessages.map((item, index) => (
										<div key={`queued-${index}`} className="log-op queued">
											<span className="log-op-mark">{item.kind === "steer" ? "↳" : "…"}</span>
											<div className="log-op-body">
												{item.kind === "steer" ? t("插话中：") : t("排队中：")}
												{item.text}
											</div>
										</div>
									))}
								</div>
								<Composer
									streaming={streaming}
									stats={stats}
									throughput={
										runThroughput && runThroughput.sessionId === (snapshot?.activeSessionId ?? null)
											? {
													tokPerSec: runThroughput.tokPerSec,
													outputTokens: runThroughput.outputTokens,
													durationMs: runThroughput.durationMs,
												}
											: null
									}
									hasProject={snapshot?.project !== null && snapshot?.project !== undefined}
									supportsImageInput={
										modelLibrary?.entries
											.find((entry) => entry.id === modelLibrary.resolved.main?.entryId)
											?.input.includes("image") ?? false
									}
									projectId={snapshot?.project?.id ?? null}
									blockedReason={
										envReport && !envReport.ok
											? t("Docker 环境不可用：{reason}。请到「设置 → 环境」修复。", {
													reason:
														envReport.items.find((entry) => entry.blocking && entry.status !== "ok")
															?.label ?? t("环境检查未通过"),
												})
											: envReport
												? snapshot?.compacting
													? t("正在压缩上下文，压缩完成后可继续发送；也可在工具栏点「中止压缩」放弃这次压缩")
													: null
												: t("正在检查 Docker 环境…")
									}
									notifyRun={notifyRun ?? notifyAvailable}
									onToggleNotifyRun={() => setNotifyRun(!(notifyRun ?? notifyAvailable))}
									goalDisabledReason={goalDisabledReason}
									onOpenGoal={() => setGoalOpen(true)}
									modeling={snapshot?.modeling ?? null}
									modelingAttached={snapshot?.modelingAttached ?? []}
									droidEnabled={snapshot?.droidEnabled ?? false}
									onToggleDroid={(next) => send({ type: "droid_set_enabled", enabled: next })}
									iosEnabled={snapshot?.iosEnabled ?? false}
									onToggleIos={(next) => send({ type: "ios_set_enabled", enabled: next })}
									apiModels={
										snapshot?.project
											? apiModels.filter((item) => item.projectId === snapshot.project?.id)
											: apiModels
									}
									freshConversation={
										!(snapshot?.messages ?? []).some(
											(message) => (message as { role?: string }).role === "user",
										)
									}
									onDetachModeling={() => send({ type: "detach_modeling" })}
									onStartModeling={() => send({ type: "start_modeling" })}
									onEndModeling={() => send({ type: "end_modeling" })}
									presets={presets ?? []}
									preset={snapshot?.preset ?? null}
									supervisor={supervisor}
									supervisorEnabled={supervisorConfig.enabled}
									supervisorWindowOpen={supervisorWindowOpen}
									supervisorDefaultStrategies={
										supervisorConfig.defaultStrategies?.length
											? supervisorConfig.defaultStrategies
											: [
													{
														strategy: supervisorConfig.defaultStrategy,
														customStrategyId: supervisorConfig.defaultCustomStrategyId,
													},
												]
									}
									supervisorCustomStrategies={supervisorConfig.customStrategies}
									onArmSupervisor={(mode, delivery, strategies, note) => {
										const primary = strategies[0];
										if (!primary) return;
										send({
											type: "supervisor_arm",
											mode,
											delivery,
											strategy: primary.strategy,
											customStrategyId: primary.customStrategyId,
											strategies,
											note,
										});
										setSupervisorWindowOpen(true);
									}}
									onShowSupervisorWindow={showSupervisorWindow}
									onSetPreset={(presetId) => send({ type: "set_session_preset", presetId })}
									onSend={(text, behavior, images, attachModelIds) => {
										const userCount = (snapshotRef.current?.messages ?? []).filter(
											(entry) => (entry as { role?: string }).role === "user",
										).length;
										setOptimisticUserMessages((prev) => [
											...prev,
											{ text, imageCount: images?.length ?? 0, userCountAtSend: userCount },
										]);
										send({
											type: "prompt",
											text,
											streamingBehavior: behavior,
											images,
											notify: notifyRun ?? undefined,
											...(attachModelIds && attachModelIds.length > 0 ? { attachModelIds } : {}),
										});
									}}
									onAbort={() => send({ type: "abort" })}
								/>
							</div>
								</div>
							</div>
						</div>
					) : page === "projects" ? (
						<ProjectsPage
							projects={projects}
							activeProject={snapshot?.project ?? null}
							busy={streaming}
							proxyConfig={proxyView}
							onCreate={addProject}
							onRecreate={recreateProject}
							onRemove={removeProject}
							onStop={stopProject}
							onStart={startProject}
							onSaveProxy={saveProjectProxy}
						/>
					) : page === "proxies" ? (
						<ProxyPage
							config={proxyView}
							projects={projects}
							busy={streaming || pullingSingboxImage}
							onSave={(input) => runProxyAction(() => send({ type: "save_proxy", proxy: input }), 1860000)}
							onDelete={(id) => runProxyAction(() => send({ type: "delete_proxy", id }))}
							onTestNodes={(id, url) => {
								setTestingProxyId(id);
								return runProxyAction(() => send({ type: "test_proxy_nodes", id, url }), 180000);
							}}
							onTestConnection={(id, url) =>
								runProxyAction(() => send({ type: "test_proxy_connection", id, url }), 240000)
							}
							refreshingId={refreshingProxyId}
							onRefreshSubscription={(id) => {
								setRefreshingProxyId(id);
								return runProxyAction(() => send({ type: "refresh_proxy_subscription", id }), 1860000);
							}}
							onSetNode={(id, nodeTag) => runProxyAction(() => send({ type: "set_proxy_node", id, nodeTag }))}
							testingId={testingProxyId}
						/>
					) : page === "reports" ? (
						<ReportCenterPage key={snapshot?.project?.id ?? "none"} projectId={snapshot?.project?.id ?? null} refreshToken={reportRefresh} />
					) : page === "vulns" ? (
						<VulnPage
							items={vulnItems}
							stats={vulnStats}
							filters={vulnFilters}
							projectId={snapshot?.project?.id ?? null}
							engines={engines}
							sessions={sessions}
							deletePending={vulnDeletePending}
							deletePreview={vulnDeletePreview}
							onRequestDelete={requestVulnDelete}
							onConfirmDelete={confirmVulnDelete}
							onCancelDelete={cancelVulnDelete}
							projectName={snapshot?.project?.name ?? null}
							hasProject={snapshot?.project !== null && snapshot?.project !== undefined}
							onFiltersChange={loadVulns}
							onOpen={openVuln}
							onOpenSession={openVulnSession}
							onExport={(filters) => send({ type: "export_vulns", filters })}
							onRetryReview={(id, force) =>
								send({ type: "retry_vuln_review", id, ...(force ? { force: true } : {}) })
							}
							onReviewAllPending={() => send({ type: "review_pending_vulns" })}
						/>
					) : page === "assets" ? (
						<AssetLibraryPage
							items={assetItems}
							stats={assetStats}
							total={assetTotal}
							page={assetPage}
							pageSize={assetPageSize}
							hasMore={assetHasMore}
							filters={assetFilters}
							detail={assetDetail}
							detailState={assetView}
							onRetryDetail={() => assetRequest.retry()}
							deletePending={assetDeletePending}
							deletePreview={assetDeletePreview}
							projectName={snapshot?.project?.name ?? null}
							hasProject={snapshot?.project !== null && snapshot?.project !== undefined}
							onQuery={loadAssets}
							onOpen={openAsset}
							onCloseDetail={() => assetRequest.close()}
							onUpdate={updateAsset}
							onRequestDelete={requestAssetDelete}
							onConfirmDelete={confirmAssetDelete}
							onCancelDelete={cancelAssetDelete}
							onExport={(filters) => send({ type: "export_assets", filters })}
							onOpenVuln={openVulnFromAsset}
						/>
					) : page === "mitm" ? (
						<MitmPage key={snapshot?.project?.id ?? "none"} project={snapshot?.project ?? null} onSendToWebFuzz={(flowId) => {
							if (!snapshot?.project) return;
							setWebFuzzImport({ projectId: snapshot.project.id, flowId });
							openPage("webfuzz");
						}} />
					) : page === "webfuzz" ? (
						<WebFuzzPage key={snapshot?.project?.id ?? "none"} project={snapshot?.project ?? null}
							initialFlowId={webFuzzImport?.projectId === snapshot?.project?.id ? webFuzzImport?.flowId : undefined}
							onImportConsumed={() => setWebFuzzImport(null)} />
					) : page === "codeintel" ? (
						<CodeIntelPage
							engines={engines}
							onOpenEngine={(id) => { openPage("engine"); setEngineEntryId(id); }}
							onOpenProject={() => openPage("projects")}
							onOpenModels={() => openPage("settings.model")}
							connected={connected}
							project={snapshot?.project ?? null}
							monitors={codeMonitors}
							detail={codeMonitorDetail}
							detailState={codeMonitorView}
							onRetryDetail={() => codeMonitorRequest.retry()}
							branchProbes={codeBranchProbes}
							busyId={codeMonitorBusy}
							checkingIds={codeCheckingIds}
							onCheckMany={(ids) => startMonitorChecks(ids, "batch")}
							onSetSchedule={(ids, schedule) => {
								setCodeMonitorBusy("schedule");
								send({ type: "set_code_monitors_schedule", ids, ...schedule });
							}}
							onRefresh={() => { send({ type: "list_code_monitors" }); send({ type: "list_engines" }); }}
						logs={codeMonitorLogs}
						onLoadLogs={(projectId) => send({ type: "list_code_monitor_logs", projectId })}
						onSetDispatch={(ids, patch) => {
							send({
								type: "set_code_monitors_dispatch",
								ids,
								...(patch.autoDispatch === undefined ? {} : { autoDispatch: patch.autoDispatch }),
								...(patch.autoDispatchCategories === undefined
									? {}
									: { autoDispatchCategories: patch.autoDispatchCategories }),
								...(patch.autoDispatchTags === undefined ? {} : { autoDispatchTags: patch.autoDispatchTags }),
							});
						}}
							onOpen={(id) => {
								const projectId = snapshotRef.current?.project?.id;
								if (projectId) codeMonitorRequest.open(projectId, id, () => sendDetail({ type: "get_code_monitor", id }));
							}}
							onCloseDetail={() => codeMonitorRequest.close()}
							importState={codeImport}
							activity={codeActivity}
							activityLoading={codeActivityLoading}
							activityError={codeActivityError}
							onLoadActivity={loadCodeActivity}
							onImport={importCodeMonitors}
							onDismissImport={dismissCodeMonitorImport}
							onUpdate={(id, input) => {
								setCodeMonitorBusy(id);
								send({ type: "update_code_monitor", id, input });
							}}
							onDelete={(id) => {
								setCodeMonitorBusy(id);
								send({ type: "delete_code_monitor", id });
							}}
							onDeleteMany={(ids) => {
								setCodeMonitorBusy("batch-delete");
								send({ type: "delete_code_monitors", ids });
							}}
							onCheck={(id) => startMonitorChecks([id])}
							onDispatch={(commitId) => {
								if (!connected || codeDispatchingIdsRef.current.has(commitId)) return;
								codeDispatchingIdsRef.current.add(commitId);
								setCodeMonitorBusy(commitId);
								updateCodeCommit(commitId, CODE_DISPATCHING_PATCH);
								send({ type: "dispatch_code_commit", id: commitId });
							}}
							onIgnore={(commitId) => send({ type: "ignore_code_commit", id: commitId })}
							onRejudge={(commitId) => {
								setCodeMonitorBusy(commitId);
								send({ type: "rejudge_code_commit", id: commitId });
							}}
							onProbeBranches={(requestId, input) =>
								send({ type: "code_monitor_branches", requestId, ...input })
							}
						/>
					) : page === "pocs" ? (
						<PocPage
							items={pocItems}
							stats={pocStats}
							page={pocPage}
							pageSize={pocPageSize}
							total={pocTotal}
							filters={pocFilters}
							detail={pocDetail}
							detailState={pocView}
							onRetryDetail={() => pocRequest.retry()}
							onCloseDetail={() => pocRequest.close()}
							importing={pocImporting}
							importProgress={pocImportProgress}
							outcome={lastPocImport}
							onFiltersChange={loadPocs}
							onPageChange={loadPocsPage}
							onOpen={openPoc}
							onImport={(files) => void importPocs(files)}
							onDelete={(id) => send({ type: "delete_poc", id })}
							officialSource={pocSources.find((source) => source.id === SENTINEL_OFFICIAL_POC_SOURCE_ID) ?? null}
							officialSyncing={pocOfficialSyncing}
							onSyncOfficial={syncOfficialPocs}
						/>
					) : page === "apimodels" ? (
						<ApiModelPage
							items={
								snapshot?.project
									? apiModels.filter((item) => item.projectId === snapshot.project?.id)
									: apiModels
							}
							detail={apiModelDetail}
							detailState={apiModelView}
							onRetryDetail={() => apiModelRequest.retry()}
							events={apiModelEvents}
							projectName={snapshot?.project?.name ?? null}
							hasProject={snapshot?.project !== null && snapshot?.project !== undefined}
							onRefresh={() => send({ type: "list_api_models" })}
							onOpen={(id) => {
								const projectId = snapshotRef.current?.project?.id;
								if (projectId) apiModelRequest.open(projectId, id, () => sendDetail({ type: "get_api_model", id }));
							}}
							onClose={() => apiModelRequest.close()}
							onDelete={(id) => send({ type: "delete_api_model", id })}
							onEnd={(id) => send({ type: "end_api_model", id })}
							onExport={(id, format) => send({ type: "export_api_model", id, format })}
							onOpenSession={(path) => {
								openPage("chat");
								send({ type: "switch_session", path });
							}}
						/>
					) : page === "droid" ? (
						<DroidPage
							connected={connected}
							devices={droidState.devices}
							tokens={droidState.tokens}
							listen={droidState.listen}
							listenConfig={droidState.listenConfig}
							lanIps={droidState.lanIps}
							consoleUrl={location.origin}
							send={send}
						/>
					) : page === "ios" ? (
						<IosPage
							connected={connected}
							devices={iosState.devices}
							tokens={iosState.tokens}
							listen={iosState.listen}
							listenConfig={iosState.listenConfig}
							lanIps={iosState.lanIps}
							certPin={iosState.certPin}
							consoleUrl={location.origin}
							send={send}
						/>
					) : page === "engine" ? (
						<EnginePage
							key={engineEntryId ?? "list"}
							initialBoardId={engineEntryId}
							engines={
								snapshot?.project
									? engines.filter((engine) => engine.projectId === snapshot.project?.id)
									: engines
							}
							doctrines={doctrines}
							project={snapshot?.project ?? null}
							onSaveDoctrine={(input) => new Promise<string | null>((resolve) => {
								doctrineSaveResolverRef.current = resolve;
								send({ type: "save_doctrine", input });
								window.setTimeout(() => {
									if (doctrineSaveResolverRef.current !== resolve) return;
									doctrineSaveResolverRef.current = null;
									resolve(getLanguage() === "en" ? "Save timed out. Try again." : "保存超时，请重试。");
								}, 15000);
							})}
							presets={presets ?? []}
							onSend={(message) => send(message as SentinelClientMessage)}
							onError={pushError}
							commanderEvents={commanderEvents}
							taskEvents={engineTaskEvents}
							onOpenTaskEvents={(taskId) => send({ type: "engine_task_events", taskId })}
							onOpenCommanderEvents={(engineId) => send({ type: "engine_commander_events", id: engineId })}
							hasProject={snapshot?.project !== null && snapshot?.project !== undefined}
							judgeAvailable={modelLibrary?.resolved.judge != null}
						/>
	) : page === "supervisor" ? (
					<SupervisorAuditPage
						page={supervisorAudit}
						detail={supervisorDetail}
						detailState={supervisorView}
						onRetryDetail={() => supervisorRequest.retry()}
						projects={projects}
						customStrategies={supervisorConfig.customStrategies}
						onQuery={(query) => {
							send({ type: "supervisor_audit", ...query });
						}}
						onSelect={(sessionId) => supervisorRequest.open(null, sessionId, () => sendDetail({ type: "supervisor_detail", sessionId }))}
						onBack={() => supervisorRequest.close()}
						onOpenSession={(path) => {
							setPage("chat");
							supervisorRequest.close();
							send({ type: "switch_session", path });
						}}
					/>
				) : page === "gates" ? (
					<GateAuditPage
						items={gateItems}
						stats={gateStats}
						tabCounts={gateTabCounts}
						total={gateTotal}
						page={gatePage}
						filter={gateFilter}
						projects={projects}
						sessions={sessions}
						onQuery={(filter, nextPage) => {
							setGateFilter(filter);
							setGatePage(nextPage);
						}}
						onRefresh={() => loadGates(gateFilter, gatePage)}
						onOpenSession={(path) => {
							openPage("chat");
							send({ type: "switch_session", path });
						}}
						sessionPathOf={(sessionId) => sessions.find((session) => session.id === sessionId)?.path ?? null}
					/>
				) : page === "settings.model" ? (
						<SettingsPage page={page}>
							<SettingsPanel
								library={modelLibrary}
								onSaveEntry={(entry) => send({ type: "save_model_entry", ...entry })}
								onRemoveEntry={(id) => send({ type: "remove_model_entry", id })}
								onDuplicateEntry={(id) => send({ type: "duplicate_model_entry", id })}
								onSetRole={(role, target) => send({ type: "set_model_role", role, target })}
								onSetReviewerAuto={(enabled) => send({ type: "set_reviewer_auto", enabled })}
								onTestEntry={async (id) => {
									const result = await new Promise<SentinelTestResult | null>((resolve) => {
										modelTestResolverRef.current = resolve;
										connectionRef.current?.send({ type: "test_model_entry", id });
										window.setTimeout(() => {
											if (modelTestResolverRef.current === resolve) {
												modelTestResolverRef.current = null;
												resolve(null);
											}
										}, 20000);
									});
									return result;
								}}
								onLookupDefaults={async (modelId, baseUrl) => {
									const matches = await new Promise<SentinelBuiltinModelDefaults[] | null>((resolve) => {
										modelDefaultsResolverRef.current = resolve;
										connectionRef.current?.send({ type: "lookup_model_defaults", modelId, baseUrl });
										window.setTimeout(() => {
											if (modelDefaultsResolverRef.current === resolve) {
												modelDefaultsResolverRef.current = null;
												resolve(null);
											}
										}, 10000);
									});
									return matches;
								}}
								onListChannels={async (query) => {
									const requestId = ++modelChannelRequestRef.current;
									return await new Promise<SentinelBuiltinChannel[] | null>((resolve) => {
										modelChannelResolversRef.current.set(requestId, resolve);
										connectionRef.current?.send({ type: "list_model_channels", requestId, query });
										window.setTimeout(() => {
											if (!modelChannelResolversRef.current.has(requestId)) return;
											modelChannelResolversRef.current.delete(requestId);
											resolve(null);
										}, 10000);
									});
								}}
								onListChannelModels={async (provider) => {
									const requestId = ++modelListRequestRef.current;
									return await new Promise<SentinelBuiltinModelPreset[] | null>((resolve) => {
										modelListResolversRef.current.set(requestId, resolve);
										connectionRef.current?.send({ type: "list_channel_models", requestId, provider });
										window.setTimeout(() => {
											if (!modelListResolversRef.current.has(requestId)) return;
											modelListResolversRef.current.delete(requestId);
											resolve(null);
										}, 10000);
									});
								}}
								gatekeeperConfig={gatekeeperConfig}
								judgeResolved={modelLibrary?.resolved.judge ?? null}
								onSaveGatekeeperConfig={(config) => send({ type: "save_gatekeeper_config", config })}
								onTestJudge={async () => {
									const result = await new Promise<{ result: SentinelTestResult; raw?: string } | null>(
										(resolve) => {
											judgeTestResolverRef.current = resolve;
											connectionRef.current?.send({ type: "test_judge" });
											window.setTimeout(() => {
												if (judgeTestResolverRef.current === resolve) {
													judgeTestResolverRef.current = null;
													resolve(null);
												}
											}, 130000);
										},
									);
									return result;
								}}
							/>
						</SettingsPage>
					) : page === "settings.supervisor" ? (
						<SettingsPage page={page}>
							<SupervisorSettingsPanel
								supervisorConfig={supervisorConfig}
								library={modelLibrary}
								onSaveSupervisorConfig={(config) => send({ type: "save_supervisor_config", config })}
								onSetRole={(role, target) => send({ type: "set_model_role", role, target })}
								onTestSupervisor={async () => {
									const result = await new Promise<{ result: SentinelTestResult; raw?: string } | null>(
										(resolve) => {
											supervisorTestResolverRef.current = resolve;
											connectionRef.current?.send({ type: "test_supervisor" });
											window.setTimeout(() => {
												if (supervisorTestResolverRef.current === resolve) {
													supervisorTestResolverRef.current = null;
													resolve(null);
												}
											}, 130000);
										},
									);
									return result;
								}}
							/>
						</SettingsPage>
					) : page === "settings.security" ? (
						<SettingsPage page={page}>
							<SecurityPanel username={authUser} />
						</SettingsPage>
					) : page === "settings.notify" ? (
						<SettingsPage page={page}>
							<NotifyPanel
								config={notifyConfig}
								status={notifyStatus}
								onSave={(next) => send({ type: "save_notify_config", config: next })}
								onTest={async (target) => {
									const result = await new Promise<SentinelTestResult | null>((resolve) => {
										notifyTestResolverRef.current = resolve;
										connectionRef.current?.send({ type: "test_notify", target });
										window.setTimeout(() => {
											if (notifyTestResolverRef.current === resolve) {
												notifyTestResolverRef.current = null;
												resolve(null);
											}
										}, 40000);
									});
									return result;
								}}
							/>
						</SettingsPage>
					) : page === "settings.permissions" ? (
						<SettingsPage page={page} status={permissionEffective ? t("子代理实际可用 {count} 项", { count: Object.values(permissionEffective).filter(Boolean).length }) : null}>
							{permissions ? (
								<PermissionsPanel
									config={permissions}
									presets={permissionPresets}
									tools={permissionTools}
									mcpServers={mcpConfig?.servers ?? null}
									plugins={pluginsView}
									mcpBusy={mcpBusy}
									busy={permissionBusy}
									onRefresh={() => {
										send({ type: "get_permissions" });
										// The MCP switch's per-server rows come from the MCP view.
										send({ type: "get_mcp_servers" });
										// The plugin rows come from the plugin center's view.
										loadPlugins();
									}}
									onToggleMcpServer={(name, enabled) => {
										setMcpBusy(true);
										send({ type: "set_mcp_server_enabled", name, enabled });
										// Flipping the switch rebuilds the live sessions, so the row is
										// released on a timeout as well as on the reply.
										window.setTimeout(() => setMcpBusy(false), 30000);
									}}
									onSave={(next) => {
										setPermissionBusy(true);
										send({ type: "save_permissions", config: next });
										// The rebuild is not instant; a refusal arrives as an error toast.
										window.setTimeout(() => setPermissionBusy(false), 20000);
									}}
								/>
							) : (
								<div className="ws-empty">
									<span>{t("正在读取权限配置…")}</span>
								</div>
							)}
						</SettingsPage>
					) : page === "settings.environment" ? (
						<SettingsPage page={page}>
							<EnvironmentPanel
								report={envReport}
								building={imageBuilding}
								buildLog={buildLog}
								sourcesSavedAt={sourcesSavedAt}
								onSaveSources={(sources) => send({ type: "set_sources", sources })}
								networkSavedAt={containerNetworkSavedAt}
								onSaveNetworkAndProxy={(network, defaultId, image) => {
									// One button, three settings, and only the ones that changed:
									// each is a separate message so a failure names one thing.
									if (network !== envReport?.containerNetwork) {
										send({ type: "set_container_network", network });
									}
									if (defaultId !== proxyView.defaultId) {
										send({ type: "set_default_proxy", id: defaultId });
									}
									if (image !== proxyView.image || !proxyView.imagePresent) {
										send({ type: "set_proxy_image", image });
									}
								}}
								onRefresh={() => send({ type: "check_environment" })}
								onBuild={() => {
									setBuildLog([]);
									setImageBuilding(true);
									send({ type: "build_image" });
								}}
								onAbortBuild={() => send({ type: "abort_image_build" })}
								proxyConfig={proxyView}
								pullingImage={pullingSingboxImage}
								onPullProxyImage={() => {
									setPullingSingboxImage(true);
									send({ type: "pull_singbox_image" });
								}}
							/>
						</SettingsPage>
					) : page === "settings.pocs" ? (
						<SettingsPage page={page} status={t("{count} 个源", { count: pocSources.length })}>
							<PocSourcesPanel
								sources={pocSources}
								syncing={pocSyncing}
								onSave={(source: SentinelPocSourceSave) => send({ type: "save_poc_source", source })}
								onDelete={(id) => send({ type: "delete_poc_source", id })}
								onSync={(id) => {
									setPocSyncing(id);
									send({ type: "sync_poc_source", id });
								}}
								onRefresh={() => send({ type: "list_poc_sources" })}
								officialSyncing={pocOfficialSyncing}
								onSyncOfficial={syncOfficialPocs}
							/>
						</SettingsPage>
					) : page === "settings.assets" ? (
						<SettingsPage page={page} status={assetConfig ? t("已挂载 {count} 个平台", { count: assetConfig.usable }) : null}>
							{assetConfig ? (
								<AssetPanel
									config={assetConfig}
									busy={assetBusy}
									onSave={(platform) => {
										setAssetBusy(true);
										send({ type: "save_asset_platform", platform });
										// Saving also probes the key and rebuilds the sessions, so
										// the switch is released on a timeout as well as on the reply.
										window.setTimeout(() => setAssetBusy(false), 40000);
									}}
									onSaveLimit={(limit) => {
										setAssetBusy(true);
										send({ type: "set_asset_query_limit", limit });
										window.setTimeout(() => setAssetBusy(false), 40000);
									}}
									onTest={async (platform: SentinelAssetPlatform, key?: string, baseUrl?: string) => {
										const result = await new Promise<SentinelTestResult | null>((resolve) => {
											assetTestResolverRef.current = resolve;
											connectionRef.current?.send({ type: "test_asset_platform", platform, key, baseUrl });
											window.setTimeout(() => {
												if (assetTestResolverRef.current === resolve) {
													assetTestResolverRef.current = null;
													resolve(null);
												}
											}, 40000);
										});
										return result;
									}}
								/>
							) : (
								<div className="ws-empty">
									<span>{t("正在读取资产测绘配置…")}</span>
								</div>
							)}
						</SettingsPage>
					) : page === "settings.websearch" ? (
						<SettingsPage page={page} status={webSearchConfig ? t("号池 {count} 个 Key 可用", { count: webSearchConfig.usable }) : null}>
							{webSearchConfig ? (
								<WebSearchPanel
									config={webSearchConfig}
									busy={webSearchBusy}
									onSave={(key) => {
										setWebSearchBusy(true);
										send({ type: "save_websearch_key", key });
										window.setTimeout(() => setWebSearchBusy(false), 40000);
									}}
									onDelete={(id) => {
										setWebSearchBusy(true);
										send({ type: "delete_websearch_key", id });
										window.setTimeout(() => setWebSearchBusy(false), 40000);
									}}
									onSaveLimit={(limit) => {
										setWebSearchBusy(true);
										send({ type: "set_websearch_query_limit", limit });
										window.setTimeout(() => setWebSearchBusy(false), 40000);
									}}
									onTest={async (id?: string, key?: string) => {
										const result = await new Promise<SentinelTestResult | null>((resolve) => {
											webSearchTestResolverRef.current = resolve;
											connectionRef.current?.send({ type: "test_websearch_key", id, key });
											window.setTimeout(() => {
												if (webSearchTestResolverRef.current === resolve) {
													webSearchTestResolverRef.current = null;
													resolve(null);
												}
											}, 40000);
										});
										return result;
									}}
								/>
							) : (
								<div className="ws-empty">
									<span>{t("正在读取 Web 搜索配置…")}</span>
								</div>
							)}
						</SettingsPage>
					) : page === "settings.mcp" ? (
						<SettingsPage page={page} status={mcpConfig ? t("已挂载 {count} 个服务器", { count: mcpConfig.mounted }) : null}>
							{mcpConfig ? (
								<McpPanel
									config={mcpConfig}
									busy={mcpBusy}
									onOpenPermissions={() => openPage("settings.permissions")}
									onSave={(server: SentinelMcpServerInput) => {
										setMcpBusy(true);
										send({ type: "save_mcp_server", server });
										// Saving rebuilds the live sessions, so the switch is released on a
										// timeout as well as on the reply.
										window.setTimeout(() => setMcpBusy(false), 30000);
									}}
									onDelete={(name) => {
										setMcpBusy(true);
										send({ type: "delete_mcp_server", name });
										window.setTimeout(() => setMcpBusy(false), 30000);
									}}
									onTest={async (name, draft) => {
										const result = await new Promise<SentinelMcpTestResult | null>((resolve) => {
											mcpTestResolverRef.current = resolve;
											connectionRef.current?.send({
												type: "test_mcp_server",
												name,
												...(draft ? { draft } : {}),
											});
											window.setTimeout(() => {
												if (mcpTestResolverRef.current === resolve) {
													mcpTestResolverRef.current = null;
													resolve(null);
												}
											}, 40000);
										});
										return result;
									}}
								/>
							) : (
								<div className="ws-empty">
									<span>{t("正在读取 MCP 配置…")}</span>
								</div>
							)}
						</SettingsPage>
					) : page === "settings.plugins" ? (
						<SettingsPage page={page} status={pluginsView ? t("{plugins} 个插件 / {hosts} 个主机", { plugins: pluginsView.plugins.length, hosts: pluginsView.hosts.length }) : null}>
							{pluginsView ? (
								<PluginPanel
									view={pluginsView}
									busy={pluginsBusy}
									permissionOn={mcpConfig ? mcpConfig.permissionOn : null}
									logs={pluginLogs}
									artifacts={pluginArtifacts}
									pendingManifest={pendingManifest}
									notice={pluginNotice}
									onOpenPermissions={() => openPage("settings.permissions")}
									onRefresh={loadPlugins}
									onSaveHost={(host: SentinelPluginHostInput) =>
										runPluginAction({ type: "save_plugin_host", host })
									}
									onDeleteHost={(id) => runPluginAction({ type: "delete_plugin_host", id })}
									onTestHost={(id) => runPluginAction({ type: "test_plugin_host", id })}
									onCloseManifest={() => {
										setPendingManifest(null);
										setPendingPackage(null);
										setPendingOfficial(null);
										setPluginBuildLog(null);
									}}
									onInspectPackage={(name, data) => {
										// The old manifest belongs to the previous upload; never let an
										// install pair the new package with stale declarations.
										setPendingManifest(null);
										setPendingPackage(data);
										setPluginBuildLog(null);
										runPluginAction({ type: "inspect_plugin_package", name, data }, 120000);
									}}
									onInstall={(input) => {
										pendingInstallRef.current = {
											hostId: input.hostId,
											pluginId: input.manifest.id,
										};
										if (pendingOfficial) {
											runPluginAction(
												{
													type: "install_official_plugin",
													hostId: input.hostId,
													pluginId: pendingOfficial.manifest.id,
													allowBuild: input.allowBuild,
													allowHostNetwork: input.allowHostNetwork,
													allowPrivileged: input.allowPrivileged,
													config: input.config,
												},
												1800000,
											);
											return;
										}
										if (!pendingPackage) return;
										// Building the image and waiting for health can take minutes.
										runPluginAction(
											{ type: "install_plugin", ...input, package: pendingPackage },
											1800000,
										);
									}}
									onUninstall={(hostId, pluginId, purge) =>
										runPluginAction({ type: "uninstall_plugin", hostId, pluginId, purge })
									}
									onStart={(hostId, pluginId) =>
										runPluginAction({ type: "start_plugin", hostId, pluginId })
									}
									onStop={(hostId, pluginId) =>
										runPluginAction({ type: "stop_plugin", hostId, pluginId })
									}
									onSetEnabled={(hostId, pluginId, enabled) =>
										runPluginAction({ type: "set_plugin_enabled", hostId, pluginId, enabled })
									}
									onSaveConfig={(hostId, pluginId, values) =>
										// A config change recreates the container, so it gets the install budget.
										runPluginAction({ type: "save_plugin_config", hostId, pluginId, values }, 600000)
									}
									onLoadLogs={(hostId, pluginId) => {
										setPluginLogs(null);
										runPluginAction({ type: "get_plugin_logs", hostId, pluginId });
									}}
									onCloseLogs={() => setPluginLogs(null)}
									onListArtifacts={(hostId, pluginId) => {
										setPluginArtifacts(null);
										runPluginAction({ type: "list_plugin_artifacts", hostId, pluginId });
									}}
									onCloseArtifacts={() => setPluginArtifacts(null)}
									onFetchArtifact={(hostId, pluginId, path) =>
										runPluginAction({ type: "fetch_plugin_artifact", hostId, pluginId, path })
									}
									onOpenUi={openPluginUi}
									onSetSidebar={(hostId, pluginId, pinned) =>
										runPluginAction({ type: "set_plugin_sidebar", hostId, pluginId, pinned })
									}
									officialPlugins={officialPlugins}
									buildLog={pluginBuildLog}
									onLoadBuildLog={loadPluginBuildLog}
									onChooseOfficial={(plugin) => {
										setPendingPackage(null);
										setPluginBuildLog(null);
										setPendingOfficial(plugin);
										setPendingManifest({ manifest: plugin.manifest, source: t("官方插件 · 随控制台内置") });
									}}
								/>
							) : (
								<div className="ws-empty">
									<span>{t("正在读取插件中心…")}</span>
								</div>
							)}
						</SettingsPage>
					) : page === "settings.presets" ? (
						<SettingsPage page={page} status={presets ? t("{enabled} / {total} 已启用", { enabled: presets.filter((preset) => preset.enabled).length, total: presets.length }) : t("读取中")}>
							<PresetPanel
								presets={presets}
								importNotice={presetImport}
								onSave={(input) => send({ type: "save_preset", input })}
								onDelete={(id) => send({ type: "delete_preset", id })}
								onSetEnabled={(id, enabled) => send({ type: "set_preset_enabled", id, enabled })}
								onExport={() => send({ type: "export_presets" })}
								onImport={(content) => send({ type: "import_presets", content })}
							/>
						</SettingsPage>
					) : (
						<AboutPage
							snapshot={snapshot}
							main={modelLibrary?.resolved.main ?? null}
							stats={stats}
							project={snapshot?.project ?? null}
							connected={connected}
						/>
					)}
					</PageBoundary>
			</ConsoleShell>
			{filesOpen ? (
				<Overlay
					title={t("文件")}
					subtitle={t("{project} · 容器工作目录 /work", { project: snapshot?.project?.name ?? t("未选择项目") })}
					onClose={() => setFilesOpen(false)}
					actions={
						<span className="ws-kv">
							<span>
								<b>{fileEntries.length}</b> {t("项")}
							</span>
							{fileBusy ? <span>{t("读取中…")}</span> : null}
						</span>
					}
				>
					<FilePanel
						state={{ path: filePath, entries: fileEntries, preview: filePreview, busy: fileBusy }}
						onOpen={loadFiles}
						onPreview={(path) => {
							setFileBusy(true);
							send({ type: "read_file", path });
						}}
						onSave={(path, text) => {
							setFileBusy(true);
							send({ type: "write_file", path, text });
						}}
						onUpload={(path, data) => {
							setFileBusy(true);
							send({ type: "upload_file", path, data });
						}}
						onDelete={(path) => {
							setFileBusy(true);
							send({ type: "delete_path", path });
						}}
						onRename={(from, to) => {
							setFileBusy(true);
							send({ type: "rename_path", from, to });
						}}
						onMkdir={(path) => {
							setFileBusy(true);
							send({ type: "make_directory", path });
						}}
						onDownload={(path) => {
							setFileBusy(true);
							send({ type: "download_file", path });
						}}
						archive={folderArchive}
						onDownloadFolder={requestFolderArchive}
						onCancelArchive={cancelFolderArchive}
					/>
				</Overlay>
			) : null}
			{terminalOpen ? (
				<TerminalPanel
					key={snapshot?.project?.id ?? "none"}
					projectId={snapshot?.project?.id ?? ""}
					projectName={snapshot?.project?.name ?? t("未选择项目")}
					onOpen={(projectId, cols, rows) => send({ type: "terminal_open", projectId, cols, rows })}
					onInput={(projectId, data) => send({ type: "terminal_input", projectId, data })}
					onClose={(projectId) => send({ type: "terminal_close", projectId })}
					onClosePanel={() => setTerminalOpen(false)}
				/>
			) : null}
			{subagentsOpen ? (
				<Overlay
					title={t("子代理")}
					subtitle={t("当前会话 {total} 次派发", { total: subagentTotal }) + (subagentRunning > 0 ? t(" · {count} 个运行中", { count: subagentRunning }) : "")}
					onClose={() => setSubagentsOpen(false)}
				>
					<SubagentPanel
						key={snapshot?.activeSessionId ?? "none"}
						runs={subagentRuns}
						total={subagentTotal}
						pageRuns={subagentPage?.runs ?? null}
						pageOffset={subagentPage?.offset ?? 0}
						onLoadPage={(offset, limit) => send({ type: "list_subagents", offset, limit })}
						transcripts={subagentTranscripts}
						onLoad={(id) => send({ type: "get_subagent", id })}
						onAbort={(id) => send({ type: "abort_subagent", id })}
						onSteer={(id, text) => send({ type: "steer_subagent", id, text })}
						onFullscreen={(title, output) => setViewer({ title: t("子代理 {name} 输出", { name: title }), output })}
					/>
				</Overlay>
			) : null}
			{vulnView ? (
				<VulnDetail
					vuln={vulnDetail}
					loading={vulnView.loading}
					error={vulnView.error}
					onRetry={() => openVuln(vulnView.id)}
					preview={vulnPreview}
					provenance={{
						// Names are resolved live; the record keeps the ids as the source of
						// truth, and the session snapshot covers a session that is gone.
						engine: engines.find((engine) => engine.id === vulnDetail?.engineId)?.name,
						task: engines
							.flatMap((engine) => engine.tasks)
							.find((task) => task.id === vulnDetail?.taskId)?.title,
						session: sessions.find((session) => session.id === vulnDetail?.sessionId)?.name,
					}}
					onClose={() => {
						vulnDetailRequest.close();
						setVulnPreview(null);
						vulnPreviewPathRef.current = null;
					}}
					onUpdate={(id, patch: SentinelVulnUpdate) => send({ type: "update_vuln", id, patch })}
					onRetryReview={(id, force) => send({ type: "retry_vuln_review", id, ...(force ? { force: true } : {}) })}
					onPreview={previewVulnFile}
					onOpenAsset={openAssetFromVuln}
				/>
			) : null}
			{branchOpen && page === "chat" ? (
				<BranchModal
					tree={tree}
					leafId={leafId}
					forkPoints={forkPoints}
					onNavigate={navigate}
					onRenameBranch={(entryId, label) => send({ type: "rename_branch", entryId, label })}
					onClose={() => {
						setBranchOpen(false);
						localStorage.setItem("sentinel-branch-open", "0");
					}}
				/>
			) : null}
			{pendingApprovals.length > 0 ? (
				<ApprovalQueue
					requests={pendingApprovals}
					onDecide={(id, approved, command, alwaysAllowPrefix) =>
						send({ type: "decide", decision: { id, approved, command, alwaysAllowPrefix } })
					}
					onDecideAll={(approved) => send({ type: "decide_all", approved })}
				/>
			) : null}
			{supervisor && supervisorWindowOpen ? (
				<SupervisorFloatingWindow
					view={supervisor}
					episodes={supervisorEpisodes}
					logs={supervisorLogs}
					onHide={() => setSupervisorWindowOpen(false)}
					onStop={() => send({ type: "supervisor_stop" })}
					onRunNow={() => send({ type: "supervisor_run_now" })}
					onSetMode={(mode, delivery) => send({ type: "supervisor_set_mode", mode, delivery })}
					onSetStrategies={(strategies, note) => {
						const primary = strategies[0];
						if (!primary) return;
						send({
							type: "supervisor_set_strategy",
							strategy: primary.strategy,
							customStrategyId: primary.customStrategyId,
							strategies,
							note,
						});
					}}
					customStrategies={supervisorConfig.customStrategies}
					onOpenCall={(callId) => send({ type: "supervisor_call_output", callId })}
					onSendAdvice={(id) => send({ type: "supervisor_advice_action", id, action: "send" })}
					onIgnoreAdvice={(id) => send({ type: "supervisor_advice_action", id, action: "ignore" })}
				/>
			) : null}
			{supervisorCallOutput ? (
				<Overlay
					title={t("监督 · 调用输出")}
					subtitle={supervisorCallOutput.truncated ? t("输出过长，已截断") : supervisorCallOutput.callId}
					onClose={() => setSupervisorCallOutput(null)}
				>
					{supervisorCallOutput.error ? (
						<p className="warn-text">{supervisorCallOutput.error}</p>
					) : (
						<pre className="sv-call-output">{supervisorCallOutput.text || t("（空输出）")}</pre>
					)}
				</Overlay>
			) : null}
			{viewer ? <OutputViewer title={viewer.title} output={viewer.output} onClose={() => setViewer(null)} /> : null}
			{goalOpen ? (
				<GoalStartDialog
					onClose={() => setGoalOpen(false)}
					onStart={(objective, criteria, roundLimit) =>
						send({
							type: "start_goal",
							objective,
							...(criteria.length > 0 ? { criteria } : {}),
							roundLimit,
						})
					}
				/>
			) : null}
			{pluginUi && pluginUiContext ? (
				<PluginUiOverlay
					plugin={pluginUi.plugin}
					nonce={pluginUi.nonce}
					token={pluginUi.token}
					context={pluginUiContext}
					onCall={callPluginUi}
					onClose={() => {
						setPluginUi(null);
						pendingPluginUi.current = null;
					}}
				/>
			) : null}
			<div className="toasts">
				{errors.map((error, index) => (
					<div key={index} className="toast">
						{error}
					</div>
				))}
			</div>
		</>
	);
}
