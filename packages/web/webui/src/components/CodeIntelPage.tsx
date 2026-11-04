/**
 * 开源情报：watched repositories and the security fixes found in their commits.
 *
 * The page is project-scoped: a monitor belongs to the project whose container
 * will reproduce its findings, so switching projects switches the list. Adding a
 * monitor walks the operator through the only two things the server needs — a
 * Git address and the branches to watch — and fetches the branch list first, so
 * a typo surfaces before anything is stored.
 */

import {
	DeleteOutlined,
	EditOutlined,
	ExperimentOutlined,
	EyeOutlined,
	MoreOutlined,
	PlusOutlined,
	QuestionCircleOutlined,
	ReloadOutlined,
	ScheduleOutlined,
	StopOutlined,
	WarningOutlined,
} from "@ant-design/icons";
import {
	Alert,
	Badge,
	Button,
	Card,
	Descriptions,
	Drawer,
	Dropdown,
	Empty,
	Form,
	Input,
	Modal,
	Pagination,
	Progress,
	Segmented,
	Select,
	Space,
	Switch,
	Table,
	Tabs,
	Tag,
	Tooltip,
	Typography,
} from "antd";
import type { TableColumnsType } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_CRON_EXPRESSION, nextCronOccurrences, validateCronExpression } from "../../../src/cron.ts";
import { getLanguage, t } from "../i18n.ts";
import type {
	SentinelCodeActivityFilter,
	SentinelCodeActivityView,
	SentinelCodeCheckJob,
	SentinelCodeCheckLog,
	SentinelCodeCheckStatus,
	SentinelCodeCheckTrigger,
	SentinelCodeImportState,
	SentinelCodeJobStatus,
	SentinelCodeCommit,
	SentinelCodeMonitor,
	SentinelCodeMonitorDetail,
	SentinelCodeMonitorInput,
	SentinelCodeScheduleKind,
	SentinelProjectInfo,
	SentinelVulnCategory,
} from "../types.ts";
import { Page } from "../ui/Page.tsx";
import { CronGrid } from "./CronGrid.tsx";
import "./code-intel.css";

const { Link: Anchor, Text, Paragraph } = Typography;

const REPO_PAGE_SIZE = 20;

const INTERVAL_OPTIONS = [
	{ value: 10, label: t("10 分钟") },
	{ value: 30, label: t("30 分钟") },
	{ value: 60, label: t("1 小时") },
	{ value: 180, label: t("3 小时") },
	{ value: 360, label: t("6 小时") },
	{ value: 720, label: t("12 小时") },
	{ value: 1440, label: t("24 小时") },
	{ value: 0, label: t("仅手动") },
];

const VERDICT_LABELS: Record<SentinelCodeCommit["verdict"], string> = {
	pending: t("待判断"),
	security: t("安全更新"),
	not_security: t("非安全"),
	failed: t("判断失败"),
};

const STATUS_LABELS: Record<SentinelCodeCommit["status"], string> = {
	new: t("待处理"),
	dispatching: t("复现中"),
	dispatched: t("已下发工程"),
	ignored: t("已忽略"),
};

const CHECK_TRIGGER_LABELS: Record<SentinelCodeCheckTrigger, string> = {
	manual: t("手动"),
	auto: t("定时"),
	batch: t("批量"),
};

const CHECK_STATUS_LABELS: Record<SentinelCodeCheckStatus, string> = {
	running: t("运行中"),
	ok: t("成功"),
	error: t("失败"),
};

const JOB_STATUS_LABELS: Record<SentinelCodeJobStatus, string> = {
	queued: t("排队中"),
	running: t("检查中"),
	done: t("成功"),
	failed: t("失败"),
};

const SEVERITY_COLORS: Record<string, string> = {
	critical: "red",
	high: "volcano",
	medium: "gold",
	low: "blue",
	info: "default",
};

const CATEGORY_LABELS: Record<SentinelVulnCategory, string> = {
	web: t("Web 漏洞"),
	memory: t("内存漏洞"),
	other: t("其他漏洞"),
};

const CATEGORY_COLORS: Record<SentinelVulnCategory, string> = {
	web: "geekblue",
	memory: "volcano",
	other: "default",
};

const CATEGORY_OPTIONS = [
	{ value: "web" as SentinelVulnCategory, label: t("Web 漏洞") },
	{ value: "memory" as SentinelVulnCategory, label: t("内存漏洞") },
	{ value: "other" as SentinelVulnCategory, label: t("其他漏洞") },
];

/** Filter dropdown for the activity list; null means "all categories". */
const ACTIVITY_CATEGORY_OPTIONS: Array<{ value: SentinelVulnCategory | null; label: string }> = [
	{ value: null, label: t("全部类别") },
	...CATEGORY_OPTIONS,
];

/** Host of a Git address, for the token-help link. Null when it cannot be read. */
function hostFromUrl(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const scp = /^(?:[^@\s]+@)?([^:/\s]+):[^/]/.exec(trimmed);
	if (scp && !trimmed.includes("://")) return scp[1] ?? null;
	try {
		return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
	} catch {
		return null;
	}
}

function formatWhen(value: number | null): string {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleString(getLanguage() === "en" ? "en-US" : "zh-CN", { hour12: false });
}

function shortRepo(monitor: SentinelCodeMonitor): string {
	return `${monitor.owner}/${monitor.repo}`;
}

/** The base the server would derive; only a different one needs to be shown. */
function defaultApiBaseFor(monitor: SentinelCodeMonitor): string {
	return monitor.host.toLowerCase() === "github.com"
		? "https://api.github.com"
		: `${monitor.repoUrl.split("://")[0]}://${monitor.host}/api/v3`;
}

export interface BranchProbe {
	requestId: number;
	branches?: string[];
	error?: string;
}

export interface CodeIntelPageProps {
	project: SentinelProjectInfo | null;
	monitors: SentinelCodeMonitor[];
	detail: SentinelCodeMonitorDetail | null;
	branchProbes: BranchProbe[];
	busyId: string | null;
	checkingIds: string[];
	onRefresh: () => void;
	onOpen: (id: string) => void;
	onCloseDetail: () => void;
	importState: SentinelCodeImportState | null;
	activity: SentinelCodeActivityView | null;
	activityLoading: boolean;
	onImport: (inputs: SentinelCodeMonitorInput[]) => void;
	onDismissImport: () => void;
	onLoadActivity: (
		projectId: string,
		filter: SentinelCodeActivityFilter,
		page: number,
		pageSize: number,
		category?: SentinelVulnCategory | null,
	) => void;
	onUpdate: (id: string, input: SentinelCodeMonitorInput) => void;
	onDelete: (id: string) => void;
	onDeleteMany: (ids: string[]) => void;
	onCheck: (id: string) => void;
	onCheckMany: (ids: string[]) => void;
	onSetSchedule: (
		ids: string[],
		schedule: { scheduleKind: SentinelCodeScheduleKind; intervalMinutes?: number; cronExpression?: string | null },
	) => void;
	onDispatch: (commitId: string) => void;
	onIgnore: (commitId: string) => void;
	onRejudge: (commitId: string) => void;
	onProbeBranches: (
		requestId: number,
		input: { url: string; token?: string; apiBaseUrl?: string; monitorId?: string },
	) => void;
}

interface EditorState {
	mode: "create" | "edit";
	monitor: SentinelCodeMonitor | null;
	url: string;
	token: string;
	apiBaseUrl: string;
	name: string;
	branches: string[];
	intervalMinutes: number;
	scheduleKind: SentinelCodeScheduleKind;
	cronExpression: string;
	autoDispatch: boolean;
	autoDispatchCategories: SentinelVulnCategory[];
	enabled: boolean;
}

function emptyEditor(): EditorState {
	return {
		mode: "create",
		monitor: null,
		url: "",
		token: "",
		apiBaseUrl: "",
		name: "",
		branches: [],
		intervalMinutes: 60,
		scheduleKind: "interval",
		cronExpression: "",
		autoDispatch: false,
		autoDispatchCategories: [],
		enabled: true,
	};
}

/** One address per line, blank lines and duplicates dropped. */
function repoLines(text: string): string[] {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const line of text.split("\n")) {
		const url = line.trim();
		if (!url || seen.has(url)) continue;
		seen.add(url);
		lines.push(url);
	}
	return lines;
}

function TokenHelp({ host }: { host: string }) {
	const tokenUrl = `https://${host}/settings/personal-access-tokens/new`;
	return (
		<div style={{ maxWidth: 380, fontSize: 12, lineHeight: 1.7 }}>
			<div>{t("GitHub：Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token。")}</div>
			<div style={{ marginTop: 4 }}>
				{t(
					"Repository access 选择目标仓库；Repository permissions → Contents 设为 Read-only，Metadata 会自动只读；生成后复制 github_pat_ 开头的令牌。",
				)}
			</div>
			<div style={{ marginTop: 4 }}>
				{t("GitHub Enterprise 路径相同，把 github.com 换成实例地址；也可以用带 repo 权限的 classic token。")}
			</div>
			<div style={{ marginTop: 6 }}>
				<a href={tokenUrl} target="_blank" rel="noreferrer">
					{t("打开令牌创建页")}
				</a>
			</div>
		</div>
	);
}

const CRON_PRESETS = [
	{ value: "*/5 * * * *", label: t("每 5 分钟") },
	{ value: "*/15 * * * *", label: t("每 15 分钟") },
	{ value: "*/30 * * * *", label: t("每 30 分钟") },
	{ value: "0 * * * *", label: t("每小时") },
	{ value: "0 */6 * * *", label: t("每 6 小时") },
	{ value: "0 9 * * *", label: t("每天 09:00") },
	{ value: "0 9 * * 1", label: t("每周一 09:00") },
	{ value: "0 9 * * 1-5", label: t("工作日 09:00") },
	{ value: "0 0 1 * *", label: t("每月 1 日 00:00") },
];

interface ScheduleDraft {
	scheduleKind: SentinelCodeScheduleKind;
	intervalMinutes: number;
	cronExpression: string;
}

/** Shared strategy editor for one monitor and for the batch dialog. */
function ScheduleFields({
	kind,
	intervalMinutes,
	cronExpression,
	onChange,
}: {
	kind: SentinelCodeScheduleKind;
	intervalMinutes: number;
	cronExpression: string;
	onChange: (patch: Partial<ScheduleDraft>) => void;
}) {
	const [showGrid, setShowGrid] = useState(false);
	const trimmed = cronExpression.trim();
	const presetValue = CRON_PRESETS.find((preset) => preset.value === trimmed)?.value ?? null;
	const cronError =
		kind === "cron" ? (trimmed ? validateCronExpression(trimmed) : t("Cron 表达式不能为空")) : undefined;
	let nextTimes: number[] = [];
	if (kind === "cron" && !cronError) {
		try {
			nextTimes = nextCronOccurrences(trimmed, Date.now(), 3);
		} catch {
			nextTimes = [];
		}
	}
	return (
		<Space direction="vertical" size={8} style={{ width: "100%" }}>
			<Segmented
				options={[
					{ label: t("按间隔"), value: "interval" },
					{ label: "Cron", value: "cron" },
				]}
				value={kind}
				onChange={(value) => {
					const kind = value as SentinelCodeScheduleKind;
					const wasEmpty = !cronExpression.trim();
					if (kind === "cron" && wasEmpty) setShowGrid(true);
					onChange({
						scheduleKind: kind,
						...(kind === "cron" && wasEmpty ? { cronExpression: DEFAULT_CRON_EXPRESSION } : {}),
					});
				}}
			/>
			{kind === "interval" ? (
				<Select
					value={intervalMinutes}
					options={INTERVAL_OPTIONS}
					onChange={(value) => onChange({ intervalMinutes: value })}
					style={{ width: 180 }}
				/>
			) : (
				<>
					<Space size={8} wrap>
						<Select
							size="small"
							value={presetValue}
							placeholder={t("常用策略")}
							options={CRON_PRESETS}
							style={{ width: 180 }}
							onChange={(value: string) => onChange({ cronExpression: value })}
						/>
						<Button size="small" onClick={() => setShowGrid((open) => !open)}>
							{showGrid ? t("收起可视化") : t("可视化生成")}
						</Button>
					</Space>
					<Input
						value={cronExpression}
						placeholder="0 */6 * * *"
						status={cronError ? "error" : undefined}
						onChange={(event) => onChange({ cronExpression: event.target.value })}
					/>
					{cronError ? (
						<Text type="danger" style={{ fontSize: 12 }}>
							{cronError}
						</Text>
					) : nextTimes.length > 0 ? (
						<Text type="secondary" style={{ fontSize: 12 }}>
							{t("接下来：{times}", { times: nextTimes.map((time) => formatWhen(time)).join("、") })}
						</Text>
					) : null}
					<Text type="secondary" style={{ fontSize: 12 }}>
						{t("按服务器本地时区执行；5 个字段：分 时 日 月 周，例如 0 9 * * 1-5。")}
					</Text>
					{showGrid ? (
						<CronGrid
							expression={cronExpression}
							onChange={(value) => onChange({ cronExpression: value })}
						/>
					) : null}
				</>
			)}
		</Space>
	);
}

/** One line for the table, the detail drawer and the batch dialog's default. */
function scheduleText(monitor: SentinelCodeMonitor): string {
	if (monitor.scheduleKind === "cron") return monitor.cronExpression ?? "—";
	return monitor.intervalMinutes > 0 ? t("每 {n} 分钟", { n: monitor.intervalMinutes }) : t("仅手动");
}

export function CodeIntelPage({
	project,
	monitors,
	detail,
	branchProbes,
	busyId,
	checkingIds,
	onRefresh,
	onOpen,
	onCloseDetail,
	importState,
	activity,
	activityLoading,
	onImport,
	onDismissImport,
	onLoadActivity,
	onUpdate,
	onDelete,
	onDeleteMany,
	onCheck,
	onCheckMany,
	onSetSchedule,
	onDispatch,
	onIgnore,
	onRejudge,
	onProbeBranches,
}: CodeIntelPageProps) {
	const [editor, setEditor] = useState<EditorState | null>(null);
	/** Create mode: the textarea, and per-address branch choices (default main). */
	const [bulkUrls, setBulkUrls] = useState("");
	const [repoBranches, setRepoBranches] = useState<Record<string, string[]>>({});
	const [branchOptions, setBranchOptions] = useState<Record<string, string[]>>({});
	const [probeErrors, setProbeErrors] = useState<Record<string, string>>({});
	const [probing, setProbing] = useState(false);
	const [probeProgress, setProbeProgress] = useState<{ done: number; total: number } | null>(null);
	const [repoPage, setRepoPage] = useState(1);
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [monitorPage, setMonitorPage] = useState(1);
	const [monitorPageSize, setMonitorPageSize] = useState(20);
	const [view, setView] = useState<"activity" | "monitors">("activity");
	const [activityFilter, setActivityFilter] = useState<SentinelCodeActivityFilter>("attention");
	const [activityCategory, setActivityCategory] = useState<SentinelVulnCategory | null>(null);
	const [activityPage, setActivityPage] = useState(1);
	const [activityPageSize, setActivityPageSize] = useState(20);
	const [activitySelectedIds, setActivitySelectedIds] = useState<string[]>([]);
	const [batchOpen, setBatchOpen] = useState(false);
	const [batchKind, setBatchKind] = useState<SentinelCodeScheduleKind>("interval");
	const [batchInterval, setBatchInterval] = useState(60);
	const [batchCron, setBatchCron] = useState("");
	const probeSeq = useRef(0);
	/** requestId → address, so queued probes land on the right row. */
	const probeRequests = useRef(new Map<number, string>());
	const probeHandled = useRef(new Set<number>());
	/** One branch probe at a time; hundreds at once is guaranteed burst limiting. */
	const probeQueue = useRef<string[]>([]);
	const probeConfig = useRef<{ token?: string; apiBaseUrl?: string; monitorId?: string }>({});
	const probeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const rows = useMemo(
		() => (project ? monitors.filter((monitor) => monitor.projectId === project.id) : []),
		[monitors, project],
	);
	const monitorById = useMemo(() => new Map(rows.map((monitor) => [monitor.id, monitor] as const)), [rows]);
	const activityRows = activity?.items ?? [];
	const activityCounts =
		activity?.counts ??
		({ attention: 0, review: 0, failed: 0, dispatchFailed: 0, pending: 0, anomalies: 0 } as const);
	const activityAnomalies = rows.filter((monitor) => Boolean(monitor.lastError));
	const editingMonitor = editor?.monitor ?? null;
	const createRepos = useMemo(() => repoLines(bulkUrls), [bulkUrls]);
	const pagedCreateRepos = useMemo(
		() => createRepos.slice((repoPage - 1) * REPO_PAGE_SIZE, repoPage * REPO_PAGE_SIZE),
		[createRepos, repoPage],
	);
	useEffect(() => setRepoPage(1), [bulkUrls]);
	useEffect(() => {
		const lastPage = Math.max(1, Math.ceil(createRepos.length / REPO_PAGE_SIZE));
		setRepoPage((page) => Math.min(page, lastPage));
	}, [createRepos.length]);
	useEffect(() => {
		const lastPage = Math.max(1, Math.ceil(rows.length / monitorPageSize));
		setMonitorPage((page) => Math.min(page, lastPage));
	}, [monitorPageSize, rows.length]);
	useEffect(() => {
		if (view !== "activity" || !project) return;
		onLoadActivity(project.id, activityFilter, activityPage, activityPageSize, activityCategory);
	}, [view, project?.id, activityFilter, activityCategory, activityPage, activityPageSize, monitors, onLoadActivity]);
	useEffect(() => {
		setActivitySelectedIds((prev) =>
			prev.filter((id) => (activity?.items ?? []).some((item) => item.id === id)),
		);
	}, [activity]);
	useEffect(() => {
		if (!activity) return;
		const lastPage = Math.max(1, Math.ceil(activity.total / activityPageSize));
		setActivityPage((page) => Math.min(page, lastPage));
	}, [activity, activityPageSize]);
	const branchesFor = (url: string): string[] => repoBranches[url] ?? ["main"];

	// Selection follows the visible rows: a project switch or a deleted monitor
	// must not leave an invisible id selected for the next batch check.
	useEffect(() => {
		setSelectedIds((prev) => prev.filter((id) => rows.some((row) => row.id === id)));
	}, [rows]);
	useEffect(() => {
		setSelectedIds([]);
		setMonitorPage(1);
	}, [project?.id]);

	const startNextProbe = useCallback(() => {
		if (probeTimer.current) {
			clearTimeout(probeTimer.current);
			probeTimer.current = undefined;
		}
		const url = probeQueue.current.shift();
		if (!url) {
			setProbing(false);
			setProbeProgress(null);
			return;
		}
		const requestId = ++probeSeq.current;
		probeRequests.current.set(requestId, url);
		onProbeBranches(requestId, { url, ...probeConfig.current });
	}, [onProbeBranches]);

	const resetProbes = useCallback(() => {
		if (probeTimer.current) {
			clearTimeout(probeTimer.current);
			probeTimer.current = undefined;
		}
		probeQueue.current = [];
		probeRequests.current.clear();
		probeHandled.current.clear();
		setProbing(false);
		setProbeProgress(null);
	}, []);

	useEffect(() => {
		const mode = editor?.mode;
		if (!mode) return;
		for (const probe of branchProbes) {
			if (probeHandled.current.has(probe.requestId)) continue;
			const url = probeRequests.current.get(probe.requestId);
			if (!url) continue;
			probeHandled.current.add(probe.requestId);
			probeRequests.current.delete(probe.requestId);
			if (probe.error) {
				setProbeErrors((prev) => ({ ...prev, [url]: probe.error ?? t("获取分支失败") }));
			} else {
				const branches = probe.branches ?? [];
				setBranchOptions((prev) => ({ ...prev, [url]: branches }));
				// Keep main unless the repository does not have it; in that case the
				// repository's first listed branch is the least surprising default.
				if (mode === "create") {
					setRepoBranches((prev) => {
						const current = prev[url] ?? ["main"];
						if (
							current.length === 1 &&
							current[0] === "main" &&
							branches.length > 0 &&
							!branches.includes("main")
						) {
							return { ...prev, [url]: [branches[0] ?? "main"] };
						}
						return prev;
					});
				}
			}
			setProbeProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
			if (probeQueue.current.length > 0) {
				probeTimer.current = setTimeout(() => startNextProbe(), 500);
			} else {
				setProbing(false);
				setProbeProgress(null);
			}
		}
	}, [branchProbes, editor?.mode, startNextProbe]);

	const closeEditor = () => {
		resetProbes();
		setEditor(null);
	};

	const openCreate = () => {
		resetProbes();
		setProbeErrors({});
		setBranchOptions({});
		setRepoBranches({});
		setBulkUrls("");
		setEditor(emptyEditor());
	};

	const openEdit = (monitor: SentinelCodeMonitor) => {
		resetProbes();
		setProbeErrors({});
		setBranchOptions({ [monitor.repoUrl]: monitor.branches });
		setRepoBranches({});
		setBulkUrls("");
		setEditor({
			mode: "edit",
			monitor,
			url: monitor.repoUrl,
			token: "",
			apiBaseUrl: defaultApiBaseFor(monitor) === monitor.apiBaseUrl ? "" : monitor.apiBaseUrl,
			name: monitor.name,
			branches: monitor.branches,
			intervalMinutes: monitor.intervalMinutes,
			scheduleKind: monitor.scheduleKind,
			cronExpression: monitor.cronExpression ?? "",
			autoDispatch: monitor.autoDispatch,
			autoDispatchCategories: monitor.autoDispatchCategories ?? [],
			enabled: monitor.enabled,
		});
	};

	const openBatchSchedule = () => {
		const first = rows.find((row) => selectedIds.includes(row.id));
		setBatchKind(first?.scheduleKind ?? "interval");
		setBatchInterval(first?.intervalMinutes ?? 60);
		setBatchCron(first?.cronExpression ?? "");
		setBatchOpen(true);
	};

	const batchCronError =
		batchKind === "cron"
			? batchCron.trim()
				? validateCronExpression(batchCron)
				: t("Cron 表达式不能为空")
			: undefined;

	const applyBatchSchedule = () => {
		if (selectedIds.length === 0 || batchCronError) return;
		onSetSchedule(selectedIds, {
			scheduleKind: batchKind,
			intervalMinutes: batchInterval,
			cronExpression: batchKind === "cron" ? batchCron.trim() : null,
		});
		setBatchOpen(false);
	};

	const probeBranches = () => {
		if (!editor) return;
		const urls = editor.mode === "create" ? createRepos : [editor.url.trim()].filter(Boolean);
		if (urls.length === 0) return;
		probeQueue.current = [...urls];
		probeConfig.current = {
			...(editor.token.trim() ? { token: editor.token.trim() } : {}),
			...(editor.apiBaseUrl.trim() ? { apiBaseUrl: editor.apiBaseUrl.trim() } : {}),
			...(editingMonitor ? { monitorId: editingMonitor.id } : {}),
		};
		setProbing(true);
		setProbeErrors({});
		setProbeProgress({ done: 0, total: urls.length });
		startNextProbe();
	};

	const submit = () => {
		if (!editor || !project) return;
		const common = {
			projectId: project.id,
			...(editor.name.trim() ? { name: editor.name.trim() } : {}),
			...(editor.token.trim() ? { token: editor.token.trim() } : {}),
			...(editor.apiBaseUrl.trim() ? { apiBaseUrl: editor.apiBaseUrl.trim() } : {}),
			intervalMinutes: editor.intervalMinutes,
			scheduleKind: editor.scheduleKind,
			cronExpression: editor.scheduleKind === "cron" ? editor.cronExpression.trim() : null,
			autoDispatch: editor.autoDispatch,
			autoDispatchCategories: editor.autoDispatch && editor.autoDispatchCategories.length > 0 ? editor.autoDispatchCategories : null,
			enabled: editor.enabled,
		};
		if (editor.mode === "create") {
			if (createRepos.length === 0) return;
			onImport(createRepos.map((url) => ({ ...common, url, branches: branchesFor(url) })));
			setBulkUrls("");
			closeEditor();
			return;
		}
		const url = editor.url.trim();
		if (!url || editor.branches.length === 0) return;
		if (editingMonitor) onUpdate(editingMonitor.id, { ...common, url, branches: editor.branches });
		closeEditor();
	};

	const editorCronError =
		editor?.scheduleKind === "cron"
			? editor.cronExpression.trim()
				? validateCronExpression(editor.cronExpression)
				: t("Cron 表达式不能为空")
			: undefined;
	const canSubmit = editor
		? !!editorCronError
			? false
			: editor.mode === "create"
				? createRepos.length > 0 && createRepos.every((url) => branchesFor(url).length > 0)
				: Boolean(editor.url.trim()) && editor.branches.length > 0
		: false;

	const columns: TableColumnsType<SentinelCodeMonitor> = [
		{
			title: t("仓库"),
			key: "repo",
			width: 320,
			ellipsis: true,
			render: (_value, monitor) => (
				<Tooltip
					title={
						<div>
							<div>{monitor.name}</div>
							<div>
								{monitor.host}/{monitor.owner}/{monitor.repo}
							</div>
						</div>
					}
				>
					<div className="code-intel-line">
						<Text strong className="code-intel-line__text">
							{monitor.name}
						</Text>
						{!monitor.enabled ? <Tag>{t("已暂停")}</Tag> : null}
						{monitor.autoDispatch ? <Tag color="purple">{t("自动复现")}</Tag> : null}
						{monitor.checkState === "running" ? (
							<Tag color="processing">{t("检查中")}</Tag>
						) : monitor.checkState === "queued" ? (
							<Tag color="gold">{t("排队中")}</Tag>
						) : null}
					</div>
				</Tooltip>
			),
		},
		{
			title: t("监控分支"),
			key: "branches",
			width: 170,
			render: (_value, monitor) => (
				<Tooltip title={monitor.branches.join("、")}>
					<span className="code-intel-line">
						<span className="code-intel-line__tags">
							{monitor.branches.slice(0, 2).map((branch) => (
								<Tag key={branch}>{branch}</Tag>
							))}
							{monitor.branches.length > 2 ? <Tag>+{monitor.branches.length - 2}</Tag> : null}
						</span>
					</span>
				</Tooltip>
			),
		},
		{
			title: t("策略"),
			key: "schedule",
			width: 170,
			ellipsis: true,
			render: (_value, monitor) => (
				<Tooltip title={scheduleText(monitor)}>
					<span className="code-intel-line">
						<Text type="secondary" className="code-intel-line__text">
							{scheduleText(monitor)}
						</Text>
					</span>
				</Tooltip>
			),
		},
		{
			title: t("最近检查"),
			dataIndex: "lastCheckAt",
			key: "lastCheckAt",
			width: 200,
			render: (_value, monitor) => {
				const next = monitor.nextCheckAt
					? monitor.nextCheckAt <= Date.now()
						? t("即将检查")
						: t("下次 {time}", { time: formatWhen(monitor.nextCheckAt) })
					: null;
				const detail = [scheduleText(monitor), next, monitor.lastError ?? ""].filter(Boolean).join(" · ");
				return (
					<Tooltip title={detail}>
						<span className="code-intel-line">
							<Text className="code-intel-line__text">{formatWhen(monitor.lastCheckAt)}</Text>
							{next ? (
								<Text type="secondary" className="code-intel-line__text">
									{next}
								</Text>
							) : null}
							{monitor.lastError ? <WarningOutlined className="code-intel-probe-error" /> : null}
						</span>
					</Tooltip>
				);
			},
		},
		{
			title: t("发现"),
			key: "findings",
			width: 120,
			render: (_value, monitor) => (
				<span className="code-intel-line">
					<Badge
						count={monitor.pendingCount}
						title={t("待复现")}
						style={{ backgroundColor: monitor.pendingCount > 0 ? "#fa8c16" : undefined }}
					/>
					<Text type="secondary">{t("共 {n} 个", { n: monitor.findingCount })}</Text>
				</span>
			),
		},
		{
			title: t("操作"),
			key: "actions",
			width: 190,
			render: (_value, monitor) => (
				<Space size={4} wrap={false}>
					<Button size="small" icon={<EyeOutlined />} onClick={() => onOpen(monitor.id)}>
						{t("详情")}
					</Button>
					<Button
						size="small"
						icon={<ReloadOutlined />}
						loading={checkingIds.includes(monitor.id) || monitor.checkState === "running"}
						disabled={monitor.checkState !== "idle"}
						onClick={() => onCheck(monitor.id)}
					>
						{t("检查")}
					</Button>
					<Dropdown
						menu={{
							items: [
								{ key: "edit", icon: <EditOutlined />, label: t("编辑") },
								{ key: "delete", icon: <DeleteOutlined />, danger: true, label: t("删除") },
							],
							onClick: ({ key }) => {
								if (key === "edit") {
									openEdit(monitor);
								} else if (key === "delete") {
									Modal.confirm({
										title: t("删除这个监控？"),
										content: t("已记录的提交与发现会一起删除，工程不受影响。"),
										okButtonProps: { danger: true },
										okText: t("删除"),
										cancelText: t("取消"),
										onOk: () => onDelete(monitor.id),
									});
								}
							},
						}}
						trigger={["click"]}
					>
						<Button size="small" icon={<MoreOutlined />} />
					</Dropdown>
				</Space>
			),
		},
	];

	const checkColumns: TableColumnsType<SentinelCodeCheckLog> = [
		{
			title: t("时间"),
			dataIndex: "startedAt",
			key: "startedAt",
			width: 180,
			render: (value: number) => <Text className="code-intel-line__text">{formatWhen(value)}</Text>,
		},
		{
			title: t("触发"),
			dataIndex: "trigger",
			key: "trigger",
			width: 90,
			render: (trigger: SentinelCodeCheckTrigger) => <Tag>{CHECK_TRIGGER_LABELS[trigger]}</Tag>,
		},
		{
			title: t("结果"),
			dataIndex: "status",
			key: "status",
			width: 100,
			render: (status: SentinelCodeCheckStatus, check) => (
				<Tooltip title={check.error ?? undefined}>
					<Tag color={status === "ok" ? "green" : status === "error" ? "red" : "processing"}>
						{CHECK_STATUS_LABELS[status]}
					</Tag>
				</Tooltip>
			),
		},
		{
			title: t("提交数"),
			dataIndex: "commits",
			key: "commits",
			width: 70,
			align: "right",
		},
		{
			title: t("命中数"),
			dataIndex: "findings",
			key: "findings",
			width: 70,
			align: "right",
		},
		{
			title: t("耗时"),
			key: "duration",
			width: 80,
			align: "right",
			render: (_value, check) =>
				check.endedAt === null ? "—" : `${((check.endedAt - check.startedAt) / 1000).toFixed(1)}s`,
		},
		{
			title: t("错误"),
			dataIndex: "error",
			key: "error",
			render: (error: string | null) =>
				error ? (
					<Tooltip title={error}>
						<span className="code-intel-line">
							<Text type="danger" className="code-intel-line__text">
								{error}
							</Text>
						</span>
					</Tooltip>
				) : (
					"—"
				),
		},
	];

	const jobColumns: TableColumnsType<SentinelCodeCheckJob> = [
		{
			title: t("创建"),
			dataIndex: "createdAt",
			key: "createdAt",
			width: 180,
			render: (value: number) => <Text className="code-intel-line__text">{formatWhen(value)}</Text>,
		},
		{
			title: t("触发"),
			dataIndex: "trigger",
			key: "trigger",
			width: 90,
			render: (trigger: SentinelCodeCheckTrigger) => <Tag>{CHECK_TRIGGER_LABELS[trigger]}</Tag>,
		},
		{
			title: t("状态"),
			dataIndex: "status",
			key: "status",
			width: 110,
			render: (status: SentinelCodeJobStatus) => (
				<Tag
					color={
						status === "queued"
							? "gold"
							: status === "running"
								? "processing"
								: status === "done"
									? "green"
									: "red"
					}
				>
					{JOB_STATUS_LABELS[status]}
				</Tag>
			),
		},
		{
			title: t("尝试"),
			key: "attempts",
			width: 80,
			align: "right",
			render: (_value, job) => `${job.attempts}/${job.maxAttempts}`,
		},
		{
			title: t("开始"),
			dataIndex: "startedAt",
			key: "startedAt",
			width: 180,
			render: (value: number | null) => formatWhen(value),
		},
		{
			title: t("结束"),
			key: "endedAt",
			width: 180,
			render: (_value, job) =>
				job.endedAt
					? formatWhen(job.endedAt)
					: job.status === "queued"
						? t("下次 {time}", { time: formatWhen(job.nextRunAt) })
						: "—",
		},
		{
			title: t("错误"),
			dataIndex: "error",
			key: "error",
			render: (error: string | null) =>
				error ? (
					<Tooltip title={error}>
						<span className="code-intel-line">
							<Text type="danger" className="code-intel-line__text">
								{error}
							</Text>
						</span>
					</Tooltip>
				) : (
					"—"
				),
		},
	];

	const canDispatch = (commit: SentinelCodeCommit): boolean =>
		commit.verdict === "security" &&
		!commit.engineId &&
		commit.status !== "dispatching" &&
		commit.status !== "dispatched" &&
		commit.status !== "ignored" &&
		!commit.duplicateOf;
	const canIgnore = (commit: SentinelCodeCommit): boolean =>
		commit.status !== "dispatching" && commit.status !== "dispatched" && !commit.engineId;

	const activityColumns: TableColumnsType<SentinelCodeCommit> = [
		{
			title: t("时间"),
			dataIndex: "authoredAt",
			key: "authoredAt",
			width: 170,
			render: (value: number) => <Text className="code-intel-line__text">{formatWhen(value)}</Text>,
		},
		{
			title: t("仓库"),
			key: "repo",
			width: 200,
			render: (_value, commit) => (
				<Text className="code-intel-line__text">
					{monitorById.get(commit.monitorId)?.name ?? commit.monitorId}
				</Text>
			),
		},
		{
			title: t("分支"),
			dataIndex: "branch",
			key: "branch",
			width: 100,
			render: (branch: string) => <Tag>{branch}</Tag>,
		},
		{
			title: t("提交"),
			key: "commit",
			width: 360,
			render: (_value, commit) => (
				<div className="code-intel-line">
					<Anchor href={commit.url} target="_blank" rel="noreferrer">
						{commit.shortSha}
					</Anchor>
					<Text className="code-intel-line__text">{commit.title}</Text>
				</div>
			),
		},
		{
			title: t("判定"),
			key: "verdict",
			width: 140,
			render: (_value, commit) => (
				<span className="code-intel-line">
					<Tag
						color={
							commit.verdict === "security" ? "red" : commit.verdict === "failed" ? "orange" : "default"
						}
					>
						{VERDICT_LABELS[commit.verdict]}
					</Tag>
					{commit.vulnCategory ? (
						<Tag color={CATEGORY_COLORS[commit.vulnCategory]}>{CATEGORY_LABELS[commit.vulnCategory]}</Tag>
					) : null}
					{commit.cve ? <Tag color="magenta">{commit.cve}</Tag> : null}
					{commit.severity ? (
						<Tag color={SEVERITY_COLORS[commit.severity]}>{commit.severity}</Tag>
					) : null}
				</span>
			),
		},
		{
			title: t("状态"),
			key: "status",
			width: 130,
			render: (_value, commit) => {
				if (commit.error) {
					return (
						<Tooltip title={commit.error}>
							<Tag color="red">{t("下发失败")}</Tag>
						</Tooltip>
					);
				}
				if (commit.status === "dispatching") return <Tag color="processing">{t("复现中")}</Tag>;
				if (commit.verdict === "pending") return <Tag color="processing">{t("判定中")}</Tag>;
				if (commit.status === "ignored") return <Tag>{t("已忽略")}</Tag>;
				if (commit.engineId) return <Tag color="blue">{t("已复现")}</Tag>;
				if (commit.verdict === "failed") return <Tag color="orange">{t("判定失败")}</Tag>;
				if (commit.verdict === "security") return <Tag color="gold">{t("待复现")}</Tag>;
				return <Tag>{t("非安全")}</Tag>;
			},
		},
		{
			title: t("操作"),
			key: "actions",
			width: 280,
			render: (_value, commit) => (
				<Space size={4} wrap={false}>
					<Tooltip title={t("准备源码并新建工程复现")}>
						<Button
							size="small"
							type="primary"
							icon={<ExperimentOutlined />}
							disabled={!canDispatch(commit)}
							loading={busyId === commit.id}
							onClick={() => onDispatch(commit.id)}
						>
							{t("复现")}
						</Button>
					</Tooltip>
					<Button
						size="small"
						icon={<ReloadOutlined />}
						loading={busyId === commit.id}
						onClick={() => onRejudge(commit.id)}
					>
						{t("重判")}
					</Button>
					<Button
						size="small"
						icon={<StopOutlined />}
						disabled={!canIgnore(commit)}
						onClick={() => onIgnore(commit.id)}
					/>
					<Button size="small" type="link" onClick={() => onOpen(commit.monitorId)}>
						{t("详情")}
					</Button>
				</Space>
			),
		},
	];

	const commitColumns: TableColumnsType<SentinelCodeCommit> = [
		{
			title: t("提交"),
			key: "commit",
			width: 520,
			render: (_value, commit) => (
				<Tooltip
					placement="topLeft"
					title={
						<div style={{ maxWidth: 460 }}>
							<div>{commit.message.split("\n")[0] || commit.shortSha}</div>
							<div style={{ marginTop: 4 }}>
								{commit.author} · {formatWhen(commit.authoredAt)} · +{commit.additions} -
								{commit.deletions}
							</div>
						</div>
					}
				>
					<div className="code-intel-line">
						<Anchor href={commit.url} target="_blank" rel="noreferrer">
							{commit.shortSha}
						</Anchor>
						<span className="code-intel-line__tags">
							<Tag>{commit.branch}</Tag>
							{commit.vulnCategory ? (
								<Tag color={CATEGORY_COLORS[commit.vulnCategory]}>
									{CATEGORY_LABELS[commit.vulnCategory]}
								</Tag>
							) : null}
							{commit.cve ? <Tag color="magenta">{commit.cve}</Tag> : null}
							{commit.severity ? (
								<Tag color={SEVERITY_COLORS[commit.severity]}>{commit.severity}</Tag>
							) : null}
						</span>
						<Text className="code-intel-line__text code-intel-commit-title">{commit.title}</Text>
					</div>
				</Tooltip>
			),
		},
		{
			title: t("判定"),
			key: "verdict",
			width: 160,
			render: (_value, commit) => (
				<span className="code-intel-line">
					<Tag
						color={
							commit.verdict === "security" ? "red" : commit.verdict === "failed" ? "orange" : "default"
						}
					>
						{VERDICT_LABELS[commit.verdict]}
					</Tag>
					{commit.confidence !== null ? (
						<Text type="secondary">{Math.round(commit.confidence * 100)}%</Text>
					) : null}
					{commit.duplicateOf ? <Tag>{t("重复")}</Tag> : null}
				</span>
			),
		},
		{
			title: t("状态"),
			key: "status",
			width: 170,
			render: (_value, commit) => (
				<span className="code-intel-line">
					<Tag
						color={
							commit.status === "dispatched"
								? "blue"
								: commit.status === "dispatching"
									? "processing"
									: commit.status === "ignored"
										? "default"
										: "gold"
						}
					>
						{STATUS_LABELS[commit.status]}
					</Tag>
					{commit.engineId ? (
						<Text type="secondary" copyable={{ text: commit.engineId }}>
							{commit.engineId.slice(0, 8)}
						</Text>
					) : null}
					{commit.error ? (
						<Tooltip title={commit.error}>
							<WarningOutlined className="code-intel-probe-error" />
						</Tooltip>
					) : null}
				</span>
			),
		},
		{
			title: t("操作"),
			key: "commit-actions",
			width: 230,
			render: (_value, commit) => (
				<Space size={4} wrap={false}>
					<Tooltip title={t("准备源码并新建工程复现")}>
						<Button
							size="small"
							type="primary"
							icon={<ExperimentOutlined />}
							disabled={
								commit.verdict !== "security" ||
								Boolean(commit.engineId) ||
								commit.status === "dispatching" ||
								commit.status === "ignored" ||
								Boolean(commit.duplicateOf)
							}
							loading={busyId === commit.id}
							onClick={() => onDispatch(commit.id)}
						>
							{t("复现")}
						</Button>
					</Tooltip>
					<Button
						size="small"
						icon={<ReloadOutlined />}
						loading={busyId === commit.id}
						onClick={() => onRejudge(commit.id)}
					>
						{t("重判")}
					</Button>
					<Button
						size="small"
						icon={<StopOutlined />}
						disabled={
						commit.status === "dispatching" ||
						commit.status === "dispatched" ||
						Boolean(commit.engineId)
					}
						onClick={() => onIgnore(commit.id)}
					/>
				</Space>
			),
		},
	];

	const activitySelected = activityRows.filter((commit) => activitySelectedIds.includes(commit.id));
	const dispatchableSelected = activitySelected.filter(canDispatch);
	const ignorableSelected = activitySelected.filter(canIgnore);

	const renderActivity = () => (
		<Space direction="vertical" size={12} style={{ width: "100%" }}>
			{activityAnomalies.length > 0 ? (
				<Alert
					type="warning"
					showIcon
					message={t("有 {n} 个监控检查异常", { n: activityAnomalies.length })}
					description={
						<Space direction="vertical" size={4} style={{ width: "100%" }}>
							{activityAnomalies.slice(0, 3).map((monitor) => (
								<div key={monitor.id} className="code-intel-line">
									<Text strong>{monitor.name}</Text>
									<Text type="danger" className="code-intel-line__text">
										{monitor.lastError}
									</Text>
									<Button size="small" onClick={() => onCheck(monitor.id)}>
										{t("检查")}
									</Button>
								</div>
							))}
							{activityAnomalies.length > 3 ? (
								<Text type="secondary">
									{t("另有 {n} 个异常", { n: activityAnomalies.length - 3 })}
								</Text>
							) : null}
						</Space>
					}
				/>
			) : null}

			<div className="code-intel-activity-bar">
				<Segmented
					size="small"
					value={activityFilter}
					options={[
						{
							value: "attention",
							label: t("待处理（{n}）", { n: activityCounts.attention }),
						},
						{ value: "review", label: t("待复现（{n}）", { n: activityCounts.review }) },
						{ value: "failed", label: t("判定失败（{n}）", { n: activityCounts.failed }) },
						{
							value: "dispatch_failed",
							label: t("下发失败（{n}）", { n: activityCounts.dispatchFailed }),
						},
						{ value: "pending", label: t("判定中（{n}）", { n: activityCounts.pending }) },
						{ value: "all", label: t("全部") },
					]}
					onChange={(value) => {
						setActivityFilter(value as SentinelCodeActivityFilter);
						setActivityPage(1);
						setActivitySelectedIds([]);
					}}
				/>
				<Select
					size="small"
					style={{ minWidth: 120 }}
					value={activityCategory}
					options={ACTIVITY_CATEGORY_OPTIONS}
					onChange={(value) => {
						setActivityCategory(value);
						setActivityPage(1);
						setActivitySelectedIds([]);
					}}
				/>
			</div>

			{activitySelected.length > 0 ? (
				<div className="code-intel-selection-bar">
					<Text type="secondary">{t("已选 {n} 个", { n: activitySelected.length })}</Text>
					<Space size={6} wrap>
						<Button
							size="small"
							type="primary"
							disabled={dispatchableSelected.length === 0}
							onClick={() => {
								for (const commit of dispatchableSelected) onDispatch(commit.id);
								setActivitySelectedIds([]);
							}}
						>
							{t("复现所选（{n}）", { n: dispatchableSelected.length })}
						</Button>
						<Button
							size="small"
							onClick={() => {
								for (const commit of activitySelected) onRejudge(commit.id);
								setActivitySelectedIds([]);
							}}
						>
							{t("重判所选（{n}）", { n: activitySelected.length })}
						</Button>
						<Button
							size="small"
							danger
							disabled={ignorableSelected.length === 0}
							onClick={() => {
								for (const commit of ignorableSelected) onIgnore(commit.id);
								setActivitySelectedIds([]);
							}}
						>
							{t("忽略所选（{n}）", { n: ignorableSelected.length })}
						</Button>
						<Button size="small" type="text" onClick={() => setActivitySelectedIds([])}>
							{t("取消选择")}
						</Button>
					</Space>
				</div>
			) : null}

			<Table
				rowKey="id"
				size="middle"
				columns={activityColumns}
				dataSource={activityRows}
				loading={activityLoading}
				locale={{ emptyText: <Empty description={t("没有需要处理的动态")} /> }}
				pagination={{
					current: activityPage,
					pageSize: activityPageSize,
					total: activity?.total ?? 0,
					showSizeChanger: true,
					pageSizeOptions: [20, 50, 100],
					showTotal: (total) => t("共 {n} 条", { n: total }),
					onChange: (page, size) => {
						setActivityPage(page);
						setActivityPageSize(size);
						setActivitySelectedIds([]);
					},
				}}
				rowSelection={{
					selectedRowKeys: activitySelectedIds,
					preserveSelectedRowKeys: true,
					onChange: (keys) => setActivitySelectedIds(keys.map((key) => String(key))),
				}}
				expandable={{
					expandedRowRender: (commit) => (
						<Space direction="vertical" size={8} style={{ width: "100%" }}>
							<Paragraph style={{ margin: 0 }}>
								<Text strong>{t("判断依据")}</Text>
								<br />
								{commit.reason ?? "—"}
							</Paragraph>
							{commit.diff ? (
								<pre className="code-intel-diff">{commit.diff}</pre>
							) : (
								<Text type="secondary">{t("没有保存 diff")}</Text>
							)}
						</Space>
					),
				}}
				tableLayout="fixed"
				scroll={{ x: 1400 }}
			/>
		</Space>
	);

	return (
		<Page
			title={t("开源情报")}
			description={t(
				"监控仓库分支上的新提交，由监测模型判断是否为安全修复；确认后交给工程复现漏洞。仓库凭据只存本机，源码准备时短暂传给容器内的 git。",
			)}
			extra={
				<Space>
					<Button
						icon={<ReloadOutlined />}
						loading={view === "activity" ? activityLoading : false}
						disabled={!project}
						onClick={() => {
							if (!project) return;
							if (view === "activity")
								onLoadActivity(project.id, activityFilter, activityPage, activityPageSize, activityCategory);
							else onRefresh();
						}}
					>
						{t("刷新")}
					</Button>
					<Button type="primary" icon={<PlusOutlined />} disabled={!project} onClick={openCreate}>
						{t("新增监控")}
					</Button>
				</Space>
			}
		>
			<Tabs
				activeKey={view}
				onChange={(key) => setView(key as "activity" | "monitors")}
				items={[
					{
						key: "activity",
						label: t("动态（{n}）", { n: activityCounts.attention + activityCounts.anomalies }),
					},
					{ key: "monitors", label: t("监控仓库") },
				]}
			/>
			{importState ? (
				<Alert
					style={{ marginBottom: 12 }}
					type={importState.running ? "info" : importState.failed > 0 ? "warning" : "success"}
					showIcon
					message={
						importState.running
							? t("正在导入 {done}/{total} 个仓库", {
									done: importState.processed,
									total: importState.total,
								})
							: t("导入完成：成功 {ok} 个，失败 {fail} 个", {
									ok: importState.succeeded,
									fail: importState.failed,
								})
					}
					description={
						<Space direction="vertical" size={2} style={{ width: "100%" }}>
							{importState.running ? (
								<Progress
									percent={
										importState.total > 0
											? Math.round((importState.processed / importState.total) * 100)
											: 0
									}
									size="small"
									showInfo={false}
								/>
							) : null}
							{importState.current ? (
								<Text type="secondary" className="code-intel-line__text">
									{t("当前：{url}", { url: importState.current })}
								</Text>
							) : null}
							{importState.errors.length > 0 ? (
								<div className="code-intel-import-errors">
									{importState.errors.slice(0, 3).map((item) => (
										<div key={`${item.url}-${item.error}`}>
											<Text type="danger" className="code-intel-line__text">
												{item.url}
											</Text>
											<Text type="secondary" className="code-intel-line__text">
												{item.error}
											</Text>
										</div>
									))}
									{importState.failed > 3 ? (
										<Text type="secondary">
											{t("另有 {n} 个失败", { n: importState.failed - 3 })}
										</Text>
									) : null}
								</div>
							) : null}
						</Space>
					}
					action={
						importState.running ? null : (
							<Button size="small" onClick={onDismissImport}>
								{t("关闭")}
							</Button>
						)
					}
				/>
			) : null}
			{!project ? (
				<Alert
					type="info"
					showIcon
					message={t("请先创建或选择一个项目")}
					description={t("监控必须绑定项目，复现会在该项目的容器里进行。")}
				/>
			) : view === "activity" ? (
				renderActivity()
			) : rows.length === 0 ? (
				<Card>
					<Empty description={t("还没有监控的仓库")}>
						<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
							{t("新增监控")}
						</Button>
					</Empty>
				</Card>
			) : (
				<>
					<div className="code-intel-selection-bar">
						<Text type="secondary">
							{selectedIds.length > 0
								? t("已选 {n} 个", { n: selectedIds.length })
								: t("共 {n} 个监控", { n: rows.length })}
						</Text>
						{selectedIds.length > 0 ? (
							<Space size={6} wrap>
								<Button size="small" icon={<ScheduleOutlined />} onClick={openBatchSchedule}>
									{t("批量策略")}
								</Button>
								<Button
									size="small"
									icon={<ReloadOutlined />}
									disabled={checkingIds.length > 0}
									loading={selectedIds.some((id) => checkingIds.includes(id))}
									onClick={() => onCheckMany(selectedIds)}
								>
									{t("检查所选（{n}）", { n: selectedIds.length })}
								</Button>
								<Button
									size="small"
									danger
									icon={<DeleteOutlined />}
									onClick={() => {
										Modal.confirm({
											title: t("删除所选监控？"),
											content: t("已记录的提交、检查日志和发现会一起删除，工程不受影响。"),
											okButtonProps: { danger: true },
											okText: t("删除"),
											cancelText: t("取消"),
											onOk: () => onDeleteMany(selectedIds),
										});
									}}
								>
									{t("批量删除")}
								</Button>
								<Button size="small" type="text" onClick={() => setSelectedIds([])}>
									{t("取消选择")}
								</Button>
							</Space>
						) : (
							<Button
								size="small"
								icon={<ReloadOutlined />}
								disabled={checkingIds.length > 0}
								loading={rows.some((row) => checkingIds.includes(row.id))}
								onClick={() => onCheckMany(rows.map((row) => row.id))}
							>
								{t("检查全部")}
							</Button>
						)}
					</div>
					<Table
						rowKey="id"
						size="middle"
						columns={columns}
						dataSource={rows}
						pagination={{
							current: monitorPage,
							pageSize: monitorPageSize,
							showSizeChanger: true,
							pageSizeOptions: [20, 50, 100],
							showTotal: (total) => t("共 {n} 条", { n: total }),
							onChange: (page, size) => {
								setMonitorPage(page);
								setMonitorPageSize(size);
							},
						}}
						rowSelection={{
							selectedRowKeys: selectedIds,
							preserveSelectedRowKeys: true,
							onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
						}}
						tableLayout="fixed"
						scroll={{ x: 1240 }}
					/>
				</>
			)}

			<Modal
				open={editor !== null}
				title={editor?.mode === "edit" ? t("编辑监控") : t("新增开源监控")}
				onCancel={closeEditor}
				onOk={submit}
				okText={t("保存")}
				cancelText={t("取消")}
				okButtonProps={{ disabled: !canSubmit || probing, loading: probing }}
				width={680}
				styles={{ body: { maxHeight: "65vh", overflowY: "auto" } }}
				destroyOnHidden
			>
				{editor ? (
					<Form layout="vertical">
						<Form.Item
							label={editor.mode === "create" ? t("仓库地址") : t("Git 地址")}
							required
							extra={
								editor.mode === "create"
									? t(
											"每行一个 Git 地址，默认监控 main 分支，可获取分支后手动挑选；多个仓库共用下面的令牌与 API Base URL。",
										)
									: t("支持 GitHub、GitHub Enterprise 的 HTTPS / SSH 地址，或 owner/repo 形式。")
							}
						>
							{editor.mode === "create" ? (
								<Input.TextArea
									rows={4}
									value={bulkUrls}
									placeholder={"https://github.com/owner/repo-a\nhttps://github.com/owner/repo-b"}
									onChange={(event) => setBulkUrls(event.target.value)}
								/>
							) : (
								<Input
									value={editor.url}
									placeholder="https://github.com/owner/repo"
									onChange={(event) => setEditor({ ...editor, url: event.target.value })}
								/>
							)}
						</Form.Item>
						<Form.Item
							label={
								<Space size={4} align="center">
									<Tooltip
										title={
											<TokenHelp
												host={
													editingMonitor?.host ??
													hostFromUrl(createRepos[0] ?? editor.url) ??
													"github.com"
												}
											/>
										}
										placement="topLeft"
									>
										<QuestionCircleOutlined className="code-intel-help" />
									</Tooltip>
									<span>{t("访问令牌")}</span>
								</Space>
							}
							extra={
								editor.mode === "edit" && editingMonitor?.tokenSet
									? t("留空保持已保存的令牌；私有仓库需要 Contents 读权限。")
									: `${t("私有仓库或提高 API 限额时填写；公开仓库可留空。")}${t("公开仓库不填令牌时受每小时 60 次请求限制，建议填令牌。")}`
							}
						>
							<Input.Password
								value={editor.token}
								placeholder={editingMonitor?.tokenSet ? "••••••••" : "github_pat_..."}
								autoComplete="new-password"
								onChange={(event) => setEditor({ ...editor, token: event.target.value })}
							/>
						</Form.Item>
						<Form.Item
							label={t("API Base URL")}
							extra={t("留空按主机自动推导：github.com 用 api.github.com，GitHub Enterprise 用 /api/v3。")}
						>
							<Input
								value={editor.apiBaseUrl}
								placeholder="https://ghe.example.com/api/v3"
								onChange={(event) => setEditor({ ...editor, apiBaseUrl: event.target.value })}
							/>
						</Form.Item>
						<Form.Item
							label={t("监控分支")}
							required
							extra={
								editor.mode === "create"
									? t("每个仓库默认 main；点击「获取分支」后可逐个挑选，也可直接输入分支名。")
									: t("注册时以各分支当前 HEAD 为基线；可获取分支后重新挑选。")
							}
						>
							<Space direction="vertical" size={8} style={{ width: "100%" }}>
								<Space size={8} wrap>
									<Button
										size="small"
										loading={probing}
										onClick={probeBranches}
										disabled={editor.mode === "create" ? createRepos.length === 0 : !editor.url.trim()}
									>
										{t("获取分支")}
									</Button>
									<Text type="secondary">
										{probing && probeProgress
											? t("获取分支中 {done}/{total}", {
													done: probeProgress.done,
													total: probeProgress.total,
												})
											: editor.mode === "create"
												? t("默认 main")
												: null}
									</Text>
								</Space>
								{editor.mode === "create" ? (
									createRepos.length === 0 ? (
										<Text type="secondary">{t("先在上方输入仓库地址")}</Text>
									) : (
										<div className="code-intel-repo-list">
											{pagedCreateRepos.map((url) => (
												<div key={url} className="code-intel-repo-row">
													<Text className="code-intel-repo-url" ellipsis={{ tooltip: url }}>
														{url}
													</Text>
													<Select
														mode="tags"
														className="code-intel-repo-branches"
														value={branchesFor(url)}
														options={(branchOptions[url] ?? []).map((branch) => ({
															value: branch,
															label: branch,
														}))}
														placeholder="main"
														onChange={(value) =>
															setRepoBranches((prev) => ({ ...prev, [url]: value }))
														}
														optionFilterProp="label"
													/>
													{probeErrors[url] ? (
														<Tooltip title={probeErrors[url]}>
															<WarningOutlined className="code-intel-probe-error" />
														</Tooltip>
													) : null}
												</div>
											))}
											{createRepos.length > REPO_PAGE_SIZE ? (
												<div className="code-intel-repo-pager">
													<Text type="secondary">{t("共 {n} 个仓库", { n: createRepos.length })}</Text>
													<Pagination
														size="small"
														current={repoPage}
														pageSize={REPO_PAGE_SIZE}
														total={createRepos.length}
														showSizeChanger={false}
														onChange={setRepoPage}
													/>
												</div>
											) : null}
										</div>
									)
								) : (
									<Space.Compact style={{ width: "100%" }}>
										<Select
											mode="tags"
											style={{ width: "100%" }}
											value={editor.branches}
											options={(branchOptions[editor.url] ?? editor.branches).map((branch) => ({
												value: branch,
												label: branch,
											}))}
											placeholder={t("点击左侧按钮获取分支，或直接输入分支名")}
											onChange={(value) => setEditor({ ...editor, branches: value })}
											optionFilterProp="label"
										/>
									</Space.Compact>
								)}
								{editor.mode === "edit" && probeErrors[editor.url] ? (
									<Alert
										style={{ marginTop: 4 }}
										type="error"
										showIcon
										message={probeErrors[editor.url]}
									/>
								) : null}
							</Space>
						</Form.Item>
						<Form.Item label={t("监控策略")}>
							<ScheduleFields
								kind={editor.scheduleKind}
								intervalMinutes={editor.intervalMinutes}
								cronExpression={editor.cronExpression}
								onChange={(patch) => setEditor({ ...editor, ...patch })}
							/>
						</Form.Item>
						<Space size={24} wrap>
							<Form.Item label={t("自动下发复现")} style={{ marginBottom: 0 }}>
									<Space size={8}>
										<Switch
											checked={editor.autoDispatch}
											onChange={(checked) => setEditor({ ...editor, autoDispatch: checked })}
										/>
										<Select
											size="small"
											mode="multiple"
											style={{ minWidth: 220 }}
											value={editor.autoDispatchCategories}
											options={CATEGORY_OPTIONS}
											placeholder={t("全部类别")}
											disabled={!editor.autoDispatch}
											onChange={(value) =>
												setEditor({
													...editor,
													autoDispatchCategories: value as SentinelVulnCategory[],
												})
											}
										/>
									</Space>
									<Text type="secondary" style={{ display: "block" }}>
										{t("置信度 ≥ 65% 时直接新建工程；类别留空表示全部自动复现")}
									</Text>
								</Form.Item>
							<Form.Item label={t("启用定时检查")} style={{ marginBottom: 0 }}>
								<Switch
									checked={editor.enabled}
									onChange={(checked) => setEditor({ ...editor, enabled: checked })}
								/>
							</Form.Item>
						</Space>
					</Form>
				) : null}
			</Modal>

			<Modal
				open={batchOpen}
				title={t("批量修改监控策略")}
				onCancel={() => setBatchOpen(false)}
				onOk={applyBatchSchedule}
				okText={t("应用")}
				cancelText={t("取消")}
				okButtonProps={{ disabled: selectedIds.length === 0 || Boolean(batchCronError) }}
				width={560}
				styles={{ body: { maxHeight: "65vh", overflowY: "auto" } }}
				destroyOnHidden
			>
				<Space direction="vertical" size={12} style={{ width: "100%" }}>
					<Text type="secondary">{t("将应用到已选的 {n} 个监控", { n: selectedIds.length })}</Text>
					<ScheduleFields
						kind={batchKind}
						intervalMinutes={batchInterval}
						cronExpression={batchCron}
						onChange={(patch) => {
							if (patch.scheduleKind !== undefined) setBatchKind(patch.scheduleKind);
							if (patch.intervalMinutes !== undefined) setBatchInterval(patch.intervalMinutes);
							if (patch.cronExpression !== undefined) setBatchCron(patch.cronExpression);
						}}
					/>
				</Space>
			</Modal>

			<Drawer
				open={detail !== null}
				width={980}
				onClose={onCloseDetail}
				title={detail ? detail.monitor.name : t("监控详情")}
				destroyOnHidden
			>
				{detail ? (
					<Space direction="vertical" size={16} style={{ width: "100%" }}>
						<Descriptions column={2} size="small" bordered>
							<Descriptions.Item label={t("仓库")} span={2}>
								<Anchor href={detail.monitor.repoUrl} target="_blank" rel="noreferrer">
									{shortRepo(detail.monitor)} · {detail.monitor.host}
								</Anchor>
							</Descriptions.Item>
							<Descriptions.Item label={t("分支")}>
								<Space size={[0, 4]} wrap>
									{detail.monitor.branches.map((branch) => (
										<Tag key={branch}>{branch}</Tag>
									))}
								</Space>
							</Descriptions.Item>
							<Descriptions.Item label={t("最近检查")}>
								{formatWhen(detail.monitor.lastCheckAt)}
							</Descriptions.Item>
							<Descriptions.Item label={t("访问令牌")}>
								{detail.monitor.tokenSet ? t("已保存") : t("未配置")}
							</Descriptions.Item>
							<Descriptions.Item label={t("监控策略")}>
								{scheduleText(detail.monitor)}
							</Descriptions.Item>
							<Descriptions.Item label={t("下次检查")}>
								{detail.monitor.nextCheckAt
									? detail.monitor.nextCheckAt <= Date.now()
										? t("即将检查")
										: formatWhen(detail.monitor.nextCheckAt)
									: t("待首次检查")}
							</Descriptions.Item>
							<Descriptions.Item label={t("自动复现")}>
								{detail.monitor.autoDispatch ? t("开") : t("关")}
							</Descriptions.Item>
							{detail.monitor.lastError ? (
								<Descriptions.Item label={t("最近错误")} span={2}>
									<Text type="danger">{detail.monitor.lastError}</Text>
								</Descriptions.Item>
							) : null}
						</Descriptions>

						<Space>
							<Button
								icon={<ReloadOutlined />}
								loading={checkingIds.includes(detail.monitor.id) || detail.monitor.checkState === "running"}
								disabled={detail.monitor.checkState !== "idle"}
								onClick={() => onCheck(detail.monitor.id)}
							>
								{t("立即检查")}
							</Button>
							<Button icon={<EditOutlined />} onClick={() => openEdit(detail.monitor)}>
								{t("编辑")}
							</Button>
						</Space>

						<Tabs
							style={{ width: "100%" }}
							items={[
								{
									key: "commits",
									label: t("提交（{n}）", { n: detail.commits.length }),
									children:
										detail.commits.length === 0 ? (
											<Empty description={t("还没有拉取到提交")} />
										) : (
											<Table
												rowKey="id"
												size="small"
												columns={commitColumns}
												dataSource={detail.commits}
												pagination={{ pageSize: 20, showSizeChanger: false }}
												tableLayout="fixed"
												scroll={{ x: 1120 }}
												expandable={{
													expandedRowRender: (commit) => (
														<Space direction="vertical" size={8} style={{ width: "100%" }}>
															<Paragraph style={{ margin: 0 }}>
																<Text strong>{t("判断依据")}</Text>
																<br />
																{commit.reason ?? "—"}
															</Paragraph>
															{commit.diff ? (
																<pre className="code-intel-diff">{commit.diff}</pre>
															) : (
																<Text type="secondary">{t("没有保存 diff")}</Text>
															)}
														</Space>
													),
												}}
											/>
										),
								},
								{
									key: "checks",
									label: t("检查日志（{n}）", { n: detail.checks.length }),
									children:
										detail.checks.length === 0 ? (
											<Empty description={t("还没有检查记录")} />
										) : (
											<Table
												rowKey="id"
												size="small"
												columns={checkColumns}
												dataSource={detail.checks}
												pagination={{ pageSize: 10, showSizeChanger: false }}
												tableLayout="fixed"
												scroll={{ x: 900 }}
											/>
										),
								},
								{
									key: "jobs",
									label: t("队列（{n}）", { n: detail.jobs.length }),
									children:
										detail.jobs.length === 0 ? (
											<Empty description={t("队列为空")} />
										) : (
											<Table
												rowKey="id"
												size="small"
												columns={jobColumns}
												dataSource={detail.jobs}
												pagination={{ pageSize: 10, showSizeChanger: false }}
												tableLayout="fixed"
												scroll={{ x: 980 }}
											/>
										),
								},
							]}
						/>
					</Space>
				) : null}
			</Drawer>
		</Page>
	);
}
