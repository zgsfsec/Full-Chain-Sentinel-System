/**
 * 工程模式页面：工程列表 → 工程看板。
 *
 * Visual language follows the console: light page cards with ws-panel headers,
 * data-table rows for the engine list and the task board, tag badges for
 * statuses, and dark blocks only for terminal output. Layout per the approved
 * parallel workspace: compact tasks on the left, commander conversation on the
 * right, and secondary configuration in drawers. Task details open in a modal.
 */

import { PlusOutlined, ReadOutlined, SettingOutlined } from "@ant-design/icons";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import {
	Alert,
	Badge,
	Button,
	Card,
	Checkbox,
	Col,
	Collapse,
	Descriptions,
	Drawer,
	Empty,
	Form,
	Input,
	InputNumber,
	Modal,
	Popconfirm,
	Popover,
	Radio,
	Row,
	Segmented,
	Space,
	Steps,
	Table,
	Tag,
	Typography,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UploadFile } from "antd";
import { engineTargetText } from "../engine-targets.ts";
import { getLanguage, t } from "../i18n.ts";
import type { UploadedFile } from "../uploads.ts";
import { Page } from "../ui/Page.tsx";
import { EngineTargetFiles } from "./EngineTargetFiles.tsx";
import { CommanderFeed } from "./EngineCommander.tsx";
import type {
	SentinelDoctrineView,
	SentinelEngine,
	SentinelEngineGateMode,
	SentinelEngineLimits,
	SentinelEngineSchedule,
	SentinelEngineScheduleAction,
	SentinelEngineScheduleInput,
	SentinelEngineTask,
	SentinelEngineTaskStatus,
	SentinelPresetView,
	SentinelProjectInfo,
	SentinelSubagentEvent,
} from "../types.ts";
import "./doctrine-manager.css";
import "./engine-workspace.css";

const { Text, Title } = Typography;

const TASK_STATUS_LABELS: Record<SentinelEngineTaskStatus, string> = {
	queued: t("排队中"),
	running: t("运行中"),
	done: t("已完成"),
	failed: t("失败"),
	blocked: t("已阻塞"),
	aborted: t("已中止"),
	paused: t("已暂停"),
};

const TASK_STATUS_CLASS: Record<SentinelEngineTaskStatus, string> = {
	queued: "tag-queued",
	running: "tag-running",
	done: "tag-done",
	failed: "tag-failed",
	blocked: "tag-blocked",
	aborted: "tag-aborted",
	paused: "tag-paused",
};

const ENGINE_STATUS_LABELS: Record<SentinelEngine["status"], string> = {
	scheduled: t("已计划"),
	running: t("运行中"),
	paused: t("已暂停"),
	completed: t("已完成"),
	stopped: t("已终止"),
};

const ENGINE_STATUS_CLASS: Record<SentinelEngine["status"], string> = {
	scheduled: "tag-scheduled",
	running: "tag-running",
	paused: "tag-paused",
	completed: "tag-done",
	stopped: "tag-stopped",
};

/** antd Tag colours for the same states, used by the antd list view. */
const ENGINE_STATUS_COLORS: Record<SentinelEngine["status"], string> = {
	scheduled: "blue",
	running: "processing",
	paused: "orange",
	completed: "green",
	stopped: "default",
};

function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60000);
	if (minutes < 60) return t("{minutes} 分钟", { minutes });
	return t("{hours} 小时 {rest} 分", { hours: Math.floor(minutes / 60), rest: minutes % 60 });
}

function formatUsage(total: number | null | undefined): string {
	if (!total) return "—";
	if (total < 1000) return String(total);
	if (total < 1_000_000) return `${(total / 1000).toFixed(1)}k`;
	return `${(total / 1_000_000).toFixed(1)}M`;
}

function formatClock(at: number): string {
	return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

const SCHEDULE_PHASE_LABELS: Record<SentinelEngineSchedule["phase"], string> = {
	waiting_start: t("等待开始"),
	running: t("计划运行中"),
	paused: t("计划暂停中"),
	finished: t("计划已结束"),
};

const SCHEDULE_FINISH_LABELS: Record<NonNullable<SentinelEngineSchedule["finishedReason"]>, string> = {
	completed: t("工程已完成，后续计划取消"),
	deadline: t("到达最晚停止时间，工程未完成，已暂停"),
	manual: t("操作员手动操作，后续计划已停用"),
	canceled: t("计划已取消"),
	start_failed: t("定时启动或恢复失败，计划已停用"),
	missed: t("错过开始时间超过 10 分钟，计划未自动补跑"),
	restart: t("服务重启，计划已停用，等待操作员继续"),
};

const SCHEDULE_ACTION_LABELS: Record<SentinelEngineScheduleAction, string> = {
	start: t("启动"),
	pause: t("暂停"),
	resume: t("恢复"),
	deadline: t("最晚停止"),
};

function browserTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatZonedDateTime(at: number, timezone: string): string {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
			hourCycle: "h23",
		}).formatToParts(new Date(at));
		const value = (type: Intl.DateTimeFormatPartTypes): string =>
			parts.find((part) => part.type === type)?.value ?? "";
		return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
	} catch {
		return new Date(at).toLocaleString("zh-CN", { hour12: false });
	}
}

function toLocalInputValue(at: number): string {
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLocalInput(value: string): number | null {
	if (!value) return null;
	const at = new Date(value).getTime();
	return Number.isFinite(at) ? at : null;
}

interface ScheduleDraft {
	startAt: string;
	pauseEnabled: boolean;
	pauseAt: string;
	resumeAt: string;
	deadlineEnabled: boolean;
	deadlineAt: string;
}

function emptyScheduleDraft(now = Date.now()): ScheduleDraft {
	const start = now + 30 * 60_000;
	return {
		startAt: toLocalInputValue(start),
		pauseEnabled: false,
		pauseAt: toLocalInputValue(start + 4 * 60 * 60_000),
		resumeAt: toLocalInputValue(start + 8 * 60 * 60_000),
		deadlineEnabled: false,
		deadlineAt: toLocalInputValue(start + 10 * 60 * 60_000),
	};
}

function draftFromSchedule(schedule: SentinelEngineSchedule): ScheduleDraft {
	return {
		startAt: toLocalInputValue(schedule.startAt),
		pauseEnabled: schedule.pauseAt !== null,
		pauseAt: schedule.pauseAt !== null ? toLocalInputValue(schedule.pauseAt) : "",
		resumeAt: schedule.resumeAt !== null ? toLocalInputValue(schedule.resumeAt) : "",
		deadlineEnabled: schedule.deadlineAt !== null,
		deadlineAt: schedule.deadlineAt !== null ? toLocalInputValue(schedule.deadlineAt) : "",
	};
}

function parseScheduleDraft(draft: ScheduleDraft): { schedule?: SentinelEngineScheduleInput; error?: string } {
	const startAt = parseLocalInput(draft.startAt);
	if (startAt === null) return { error: t("请选择开始时间") };
	if (startAt <= Date.now()) return { error: t("开始时间必须晚于当前时间") };
	const pauseAt = draft.pauseEnabled ? parseLocalInput(draft.pauseAt) : null;
	const resumeAt = draft.pauseEnabled ? parseLocalInput(draft.resumeAt) : null;
	if (draft.pauseEnabled && (pauseAt === null || resumeAt === null)) {
		return { error: t("请同时填写暂停时间和恢复时间") };
	}
	if (pauseAt !== null && pauseAt <= startAt) return { error: t("暂停时间必须晚于开始时间") };
	if (pauseAt !== null && resumeAt !== null && resumeAt <= pauseAt) {
		return { error: t("恢复时间必须晚于暂停时间") };
	}
	const deadlineAt = draft.deadlineEnabled ? parseLocalInput(draft.deadlineAt) : null;
	if (draft.deadlineEnabled && deadlineAt === null) return { error: t("请选择最晚停止时间") };
	const lastStep = resumeAt ?? pauseAt ?? startAt;
	if (deadlineAt !== null && deadlineAt <= lastStep) {
		return { error: t("最晚停止时间必须晚于最后一次计划动作") };
	}
	return {
		schedule: {
			timezone: browserTimezone(),
			startAt,
			pauseAt,
			resumeAt,
			deadlineAt,
		},
	};
}

function nextPlanStep(
	schedule: SentinelEngineSchedule,
): { action: SentinelEngineScheduleAction; at: number } | null {
	if (schedule.phase === "finished") return null;
	const candidates: Array<{ action: SentinelEngineScheduleAction; at: number }> = [];
	if (schedule.phase === "waiting_start" && !schedule.applied.includes("start")) {
		candidates.push({ action: "start", at: schedule.startAt });
	}
	if (schedule.phase === "running") {
		if (schedule.pauseAt !== null && !schedule.applied.includes("pause")) {
			candidates.push({ action: "pause", at: schedule.pauseAt });
		}
		if (schedule.deadlineAt !== null && !schedule.applied.includes("deadline")) {
			candidates.push({ action: "deadline", at: schedule.deadlineAt });
		}
	}
	if (schedule.phase === "paused") {
		if (schedule.resumeAt !== null && !schedule.applied.includes("resume")) {
			candidates.push({ action: "resume", at: schedule.resumeAt });
		}
		if (schedule.deadlineAt !== null && !schedule.applied.includes("deadline")) {
			candidates.push({ action: "deadline", at: schedule.deadlineAt });
		}
	}
	return candidates.sort((left, right) => left.at - right.at)[0] ?? null;
}

function formatRemaining(at: number, now: number): string {
	const delta = at - now;
	if (delta <= 0) return t("即将执行");
	const minutes = Math.ceil(delta / 60_000);
	if (minutes < 60) return t("{minutes} 分钟后", { minutes });
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest > 0
		? t("{hours} 小时 {rest} 分钟后", { hours, rest })
		: t("{hours} 小时后", { hours });
}

export interface EnginePageProps {
	engines: SentinelEngine[];
	doctrines: SentinelDoctrineView[];
	/** Enabled presets the commander may dispatch with, for the whitelist controls. */
	presets: SentinelPresetView[];
	onSend: (message: unknown) => void;
	onError: (message: string) => void;
	commanderEvents: Record<string, SentinelSubagentEvent[]>;
	taskEvents: Record<string, SentinelSubagentEvent[]>;
	onOpenTaskEvents: (taskId: string) => void;
	onOpenCommanderEvents: (engineId: string) => void;
	hasProject: boolean;
	project: SentinelProjectInfo | null;
	onSaveDoctrine(input: { name: string; text: string }): Promise<string | null>;
	/** Whether a judge endpoint resolves, so the create form can offer AI 裁判. */
	judgeAvailable: boolean;
}

type View = "list" | "board" | "create" | "doctrines";

export function EnginePage(props: EnginePageProps) {
	const [view, setView] = useState<View>("list");
	const [boardId, setBoardId] = useState<string | null>(null);
	const [openTaskId, setOpenTaskId] = useState<string | null>(null);
	const [report, setReport] = useState<{ markdown: string; filename: string } | null>(null);
	const [editingSchedule, setEditingSchedule] = useState(false);

	const board = useMemo(() => props.engines.find((engine) => engine.id === boardId) ?? null, [props.engines, boardId]);
	const scheduleActive = !!board?.schedule && board.schedule.phase !== "finished";
	useEffect(() => {
		if (board?.status !== "scheduled") setEditingSchedule(false);
	}, [board?.status]);

	const openBoard = (id: string) => {
		setBoardId(id);
		setView("board");
	};

	// Poll the persisted commander log while a board is open. Live events are
	// pushed over the socket too, but a missed frame (or a handler still awaiting
	// a commander turn) must not leave the conversation invisible until refresh.
	const openEventsRef = useRef(props.onOpenCommanderEvents);
	openEventsRef.current = props.onOpenCommanderEvents;
	useEffect(() => {
		if (view !== "board" || !boardId) return;
		const load = (): void => openEventsRef.current(boardId);
		load();
		const timer = window.setInterval(load, 3000);
		return () => window.clearInterval(timer);
	}, [view, boardId]);

	const send = props.onSend;

	if (view === "create") {
		return (
			<div className="ui-page enginewiz-page">
				<CreateEngineForm
					key={props.project?.id ?? "no-project"}
					doctrines={props.doctrines}
					presets={props.presets}
					hasProject={props.hasProject}
					project={props.project}
					judgeAvailable={props.judgeAvailable}
					onCancel={() => setView("list")}
					onSubmit={(input) => {
						send({ type: "engine_create", input });
						setView("list");
					}}
				/>
			</div>
		);
	}

	if (view === "doctrines") {
		return (
			<DoctrineManager
				doctrines={props.doctrines}
				onClose={() => setView("list")}
				onSave={props.onSaveDoctrine}
				onDelete={(id) => send({ type: "delete_doctrine", id })}
			/>
		);
	}

	if (view === "board" && board) {
		const scheduled = board.status === "scheduled";
		const running = board.status === "running";
		const paused = board.status === "paused";
		const active = running || paused;
		const elapsedText = board.startedAt !== null
			? board.endedAt
				? t(" · 历时 {duration}", { duration: formatDuration(board.endedAt - board.startedAt) })
				: running
					? t(" · 已运行 {duration}", { duration: formatDuration(Date.now() - board.startedAt) })
					: ""
			: t(" · 尚未启动");

		return (
			<Page
				className="engine-workspace"
				title={
					<Space size={8} wrap>
						<Button size="small" onClick={() => setView("list")}>
							{t("← 返回")}
						</Button>
						{board.name}
						<Tag color={ENGINE_STATUS_COLORS[board.status]} variant="filled">
							{ENGINE_STATUS_LABELS[board.status]}
						</Tag>
					</Space>
				}
				description={`${board.projectName}${t(" · 创建于 {time}", {
					time: new Date(board.createdAt).toLocaleString("zh-CN", { hour12: false }),
				})}${elapsedText}`}
				extra={
					<Space size={6} wrap>
						<Button size="small" onClick={() => send({ type: "engine_report_snapshot", id: board.id })}>
							{t("进度快照")}
						</Button>
						{board.report ? (
							<Button
								size="small"
								onClick={() =>
									setReport({
										markdown: board.report ?? "",
										filename: t("{name}-总报告.md", { name: board.name }),
									})
								}
							>
								{t("查看总报告")}
							</Button>
						) : null}
						{scheduled ? (
							<Button size="small" onClick={() => setEditingSchedule(true)}>
								{t("修改计划")}
							</Button>
						) : null}
						{scheduled ? (
							<Popconfirm
								title={t("取消计划")}
								description={t("取消后计划不再执行，工程会标记为已终止。确定取消？")}
								okText={t("取消计划")}
								okButtonProps={{ danger: true }}
								cancelText={t("返回")}
								onConfirm={() => send({ type: "engine_cancel_schedule", id: board.id })}
							>
								<Button size="small" danger>
									{t("取消计划")}
								</Button>
							</Popconfirm>
						) : null}
						{scheduleActive && !scheduled ? (
							<Popconfirm
								title={t("停用计划")}
								description={t("停用后续定时计划？当前运行不会停止。")}
								okText={t("停用")}
								cancelText={t("返回")}
								onConfirm={() => send({ type: "engine_cancel_schedule", id: board.id })}
							>
								<Button size="small">{t("停用计划")}</Button>
							</Popconfirm>
						) : null}
						{running ? (
							<Button
								size="small"
								onClick={() => {
									if (scheduleActive && !window.confirm(t("手动暂停会停用后续定时计划，确定？"))) return;
									send({ type: "engine_pause", id: board.id });
								}}
							>
								{t("暂停")}
							</Button>
						) : null}
						{paused ? (
							<Button
								size="small"
								type="primary"
								onClick={() => {
									if (scheduleActive && !window.confirm(t("手动继续会停用后续定时计划，确定？"))) return;
									send({ type: "engine_resume", id: board.id });
								}}
							>
								{t("继续")}
							</Button>
						) : null}
						{active ? (
							<Popconfirm
								title={t("终止工程")}
								description={scheduleActive ? t("终止会同时停用后续定时计划，确定？") : t("终止后当前任务会停止。确定？")}
								okText={t("终止")}
								okButtonProps={{ danger: true }}
								cancelText={t("返回")}
								onConfirm={() => send({ type: "engine_abort", id: board.id })}
							>
								<Button size="small" danger>
									{t("终止")}
								</Button>
							</Popconfirm>
						) : (
							<Popconfirm
								title={t("删除工程")}
								description={t("删除工程「{name}」？任务记录将一并删除。", { name: board.name })}
								okText={t("删除")}
								okButtonProps={{ danger: true }}
								cancelText={t("返回")}
								onConfirm={() => {
									send({ type: "engine_delete", id: board.id });
									setView("list");
								}}
							>
								<Button size="small" danger>
									{t("删除")}
								</Button>
							</Popconfirm>
						)}
					</Space>
				}
			>
				<div className="engine-workspace__body">
					{board.schedule ? <ScheduleStrip schedule={board.schedule} /> : null}
					<EngineStats
						key={board.id}
						engine={board}
						presets={props.presets}
						judgeAvailable={props.judgeAvailable}
						onSend={send}
					/>
					<div className="engine-workspace__columns">
						<TaskBoard
							engine={board}
							onOpenTask={(taskId) => {
								setOpenTaskId(taskId);
								props.onOpenTaskEvents(taskId);
							}}
							onAbortTask={(taskId) => send({ type: "engine_abort_task", taskId })}
						/>
						<CommanderFeed
							key={board.id}
							engineId={board.id}
							status={board.status}
							project={props.project?.id === board.projectId ? props.project : null}
							events={props.commanderEvents[board.id] ?? []}
							onSend={send}
						/>
					</div>
				</div>
				{openTaskId ? (
					<TaskModal
						task={board.tasks.find((task) => task.id === openTaskId) ?? null}
						events={props.taskEvents[openTaskId] ?? []}
						onClose={() => setOpenTaskId(null)}
						onAbort={(taskId) => send({ type: "engine_abort_task", taskId })}
						onOpenInChat={(taskId) => {
							send({ type: "engine_open_task_session", taskId });
							setOpenTaskId(null);
						}}
					/>
				) : null}
				{editingSchedule && board.schedule ? (
					<ScheduleModal
						schedule={board.schedule}
						onClose={() => setEditingSchedule(false)}
						onSave={(schedule) => {
							send({ type: "engine_set_schedule", id: board.id, schedule });
							setEditingSchedule(false);
						}}
					/>
				) : null}
				<Modal
					open={report !== null}
					title={report?.filename}
					width={880}
					onCancel={() => setReport(null)}
					footer={
						<Space size={8}>
							<Button onClick={() => void navigator.clipboard.writeText(report?.markdown ?? "")}>
								{t("复制")}
							</Button>
							<Button type="primary" onClick={() => setReport(null)}>
								{t("关闭")}
							</Button>
						</Space>
					}
				>
					<pre className="report-preview">{report?.markdown ?? ""}</pre>
				</Modal>
			</Page>
		);
	}

	// list view
	const columns: ProColumns<SentinelEngine>[] = [
		{
			title: t("工程"),
			dataIndex: "name",
			key: "name",
			render: (_, engine) => <Text strong>{engine.name}</Text>,
		},
		{
			title: t("状态"),
			key: "status",
			width: 120,
			render: (_, engine) => (
				<Tag color={ENGINE_STATUS_COLORS[engine.status]} variant="filled">
					{ENGINE_STATUS_LABELS[engine.status]}
				</Tag>
			),
		},
		{
			title: t("进度"),
			key: "progress",
			render: (_, engine) => {
				const running = engine.tasks.filter((task) => task.status === "running").length;
				const queued = engine.tasks.filter((task) => task.status === "queued").length;
				const done = engine.tasks.filter((task) => task.status === "done").length;
				const failed = engine.tasks.filter((task) => ["failed", "blocked"].includes(task.status)).length;
				const parts = [
					t("{count} 完成", { count: done }),
					running > 0 ? t("{count} 运行", { count: running }) : "",
					queued > 0 ? t("{count} 排队", { count: queued }) : "",
					failed > 0 ? t("{count} 失败", { count: failed }) : "",
				].filter(Boolean);
				return <Text type="secondary">{parts.join(" · ") || "—"}</Text>;
			},
		},
		{
			title: t("中枢提交"),
			key: "vulns",
			width: 110,
			render: (_, engine) => (
				<Text>{t("{count} 条", { count: engine.tasks.reduce((sum, task) => sum + task.vulns, 0) })}</Text>
			),
		},
		{
			title: t("耗时"),
			key: "elapsed",
			width: 110,
			render: (_, engine) => {
				const startedAt = engine.startedAt ?? engine.createdAt;
				const elapsed =
					engine.startedAt === null
						? null
						: (engine.endedAt ?? (engine.status === "running" ? Date.now() : startedAt)) - startedAt;
				return <Text type="secondary">{elapsed === null ? "—" : formatDuration(elapsed)}</Text>;
			},
		},
		{
			title: t("创建时间"),
			key: "createdAt",
			width: 170,
			render: (_, engine) => (
				<Text type="secondary">{new Date(engine.createdAt).toLocaleString("zh-CN", { hour12: false })}</Text>
			),
		},
	];

	return (
		<Page
			title={t("工程")}
			description={
				props.hasProject
					? t("{project} · {count} 个工程", {
							project: props.engines[0]?.projectName ?? "",
							count: props.engines.length,
						})
					: t("请先选择项目")
			}
			extra={
				<Space size={8}>
					<Button icon={<ReadOutlined />} onClick={() => setView("doctrines")}>
						{t("指挥思路")}
					</Button>
					<Button type="primary" icon={<PlusOutlined />} disabled={!props.hasProject} onClick={() => setView("create")}>
						{t("新建工程")}
					</Button>
				</Space>
			}
		>
			<ProTable<SentinelEngine>
				rowKey="id"
				size="small"
				columns={columns}
				dataSource={props.engines}
				search={false}
				options={false}
				pagination={false}
				onRow={(engine) => ({
					onClick: () => openBoard(engine.id),
					style: { cursor: "pointer" },
				})}
				locale={{
					emptyText: props.hasProject
						? t("还没有工程。点「新建工程」，贴入目标清单并选择指挥思路即可开始。")
						: t("工程属于项目：请先在侧栏顶部选择或创建一个项目。"),
				}}
			/>
		</Page>
	);
}

function EngineStats({
	engine,
	presets,
	judgeAvailable,
	onSend,
}: {
	engine: SentinelEngine;
	presets: SentinelPresetView[];
	judgeAvailable: boolean;
	onSend: (message: unknown) => void;
}) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [presetsOpen, setPresetsOpen] = useState(false);
	const count = (status: SentinelEngineTaskStatus) => engine.tasks.filter((task) => task.status === status).length;
	const vulns = engine.tasks.reduce((sum, task) => sum + task.vulns, 0);
	// Task sessions capture their gate mode when created, so an active worker locks it.
	const busy = engine.tasks.some((task) => task.status === "running" || task.status === "queued");
	return (
		<>
			<div className="engine-workspace__summary">
				<div className="engine-workspace__metrics">
					<Text type="secondary">{t("任务")} <Text strong>{count("done")} / {engine.tasks.length}</Text></Text>
					<Text type="secondary">{t("运行中")} <Text strong>{count("running")}</Text></Text>
					<Text type="secondary">{t("排队中")} <Text strong>{count("queued")}</Text></Text>
					<Text type="secondary">{t("中枢提交")} <Text strong>{vulns}</Text></Text>
					{(["failed", "blocked", "paused"] as const).filter((status) => count(status) > 0).map((status) => (
						<Text key={status} type={status === "failed" ? "danger" : "secondary"}>{TASK_STATUS_LABELS[status]} {count(status)}</Text>
					))}
				</div>
				<Space size={4} wrap className="engine-workspace__controls">
					{engine.status === "running" || engine.status === "paused" ? (
						<Popover
							title={t("追加目标")}
							trigger="click"
							placement="bottomRight"
							styles={{ container: { width: "min(420px, calc(100vw - 32px))" } }}
							content={<TargetsBox engineId={engine.id} onSend={onSend} />}
						>
							<Button size="small" type="text" icon={<PlusOutlined />}>{t("追加目标")}</Button>
						</Popover>
					) : null}
					<Button size="small" type="text" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>{t("执行配置")}</Button>
					<Button size="small" type="text" onClick={() => setPresetsOpen(true)}>{t("Agent 白名单")}</Button>
				</Space>
			</div>
			{engine.pauseNote ? <Text type="secondary" className="engine-workspace__pause-note">{engine.pauseNote}</Text> : null}
			<Drawer
				title={t("执行配置")}
				size={440}
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
				styles={{ wrapper: { maxWidth: "100vw" } }}
			>
				<Descriptions
					size="small"
					column={1}
					items={[
						{ key: "concurrency", label: t("最大并发任务"), children: engine.limits.concurrency },
						{ key: "rounds", label: t("单任务最大轮数"), children: engine.limits.roundLimit },
						{ key: "retries", label: t("每目标重试次数"), children: engine.limits.maxRetries },
						{ key: "tokens", label: t("token 上限"), children: engine.limits.tokenLimit ? formatUsage(engine.limits.tokenLimit) : t("不限制") },
						{ key: "time", label: t("总时间上限 / 分钟（可选）"), children: engine.limits.timeLimitMin ?? t("不限制") },
					]}
				/>
				<Form layout="vertical" requiredMark={false}>
					<Form.Item label={t("命令守门")} extra={busy ? t("有任务正在运行或排队，等它们结束再改") : undefined}>
						<Segmented
							size="small"
							value={engine.gateMode}
							disabled={busy}
							onChange={(gateMode) => onSend({ type: "engine_set_gate_mode", id: engine.id, gateMode })}
							options={[
								{ value: "auto", label: t("自动执行") },
								{ value: "ai", label: t("AI 裁判"), disabled: !judgeAvailable },
							]}
						/>
					</Form.Item>
				</Form>
			</Drawer>
			<Drawer
				title={t("Agent 白名单")}
				size={480}
				open={presetsOpen}
				onClose={() => setPresetsOpen(false)}
				className="engine-workspace-presets"
				styles={{ wrapper: { maxWidth: "100vw" } }}
			>
				<EnginePresetWhitelist
					engine={engine}
					presets={presets}
					onChange={(presetIds) => onSend({ type: "engine_set_presets", id: engine.id, presetIds })}
					onChangeOptional={(optional) => onSend({ type: "engine_set_preset_optional", id: engine.id, optional })}
				/>
			</Drawer>
		</>
	);
}

/**
 * The engine's preset whitelist, and whether a task may go without one. Unlike the
 * gate mode both stay editable while the engine runs, because they only narrow what
 * the commander may pick for the tasks it has not dispatched yet.
 */
function EnginePresetWhitelist({
	engine,
	presets,
	onChange,
	onChangeOptional,
}: {
	engine: SentinelEngine;
	presets: SentinelPresetView[];
	onChange(presetIds: string[]): void;
	onChangeOptional(optional: boolean): void;
}) {
	const enabled = presets.filter((preset) => preset.enabled);
	const selected = engine.presetIds;
	const allowed =
		selected.length === 0 ? enabled.length : selected.filter((id) => enabled.some((p) => p.id === id)).length;
	// A required preset with nothing to pick from cannot dispatch at all: the
	// commander would be refused on every attempt.
	const stuck = !engine.presetOptional && allowed === 0;
	return (
		<div className="engine-workspace-presets__form">
			<Text strong>
				{selected.length === 0
					? t("未限制：指挥官可使用全部已启用的预设")
					: t("已限制为 {count} 个预设", { count: selected.length })}
			</Text>
			<Text type="secondary">
				{t("勾选指挥官可以使用的预设；未勾选任何一项 = 不限制（指挥官可用全部已启用的预设）。")}{" "}
				{t("运行中也能修改，只影响之后派发的任务；已停用或已删除的预设不会出现在上面，也不会再被派发。")}
			</Text>
			{enabled.length === 0 ? (
				<Alert
					type="info"
					showIcon
					className="ui-page__alert"
					title={t("还没有启用的预设 Agent，可到 设置 → 预设 Agent 创建。")}
				/>
			) : (
				<Space orientation="vertical" size={6} className="enginehub-presets">
					{enabled.map((preset) => (
						<Checkbox
							key={preset.id}
							checked={selected.includes(preset.id)}
							title={preset.description || undefined}
							onChange={(event) =>
								onChange(
									event.target.checked
										? [...selected, preset.id]
										: selected.filter((id) => id !== preset.id),
								)
							}
						>
							<Space size={8} wrap>
								<Text>{preset.name}</Text>
								<Text type="secondary">{t("粗估 {count} tokens", { count: preset.tokens })}</Text>
							</Space>
						</Checkbox>
					))}
				</Space>
			)}
			<Checkbox
				checked={engine.presetOptional}
				className="enginehub-optional"
				onChange={(event) => onChangeOptional(event.target.checked)}
			>
				{t("允许任务不指定预设（没有合适预设时，指挥官可以省略 preset，让任务用默认 Agent 执行）")}
			</Checkbox>
			<Alert
				type={stuck ? "warning" : "info"}
				showIcon
				className="ui-page__alert"
				title={
					engine.presetOptional
						? t("关掉它，指挥官就必须为每个任务指定一个预设；没有合适的时候也不能退回默认 Agent，派发会被拒绝。")
						: stuck
							? t("已要求每个任务都必须指定预设，但当前没有可用预设：指挥官无法派发任何任务，请勾选上面的预设，或重新允许使用默认 Agent。")
							: t("已要求每个任务都必须指定预设（当前可选 {count} 个）；省略 preset 的派发会被拒绝，不会产生任务。", {
									count: allowed,
								})
				}
			/>
		</div>
	);
}

function TargetsBox({ engineId, onSend }: { engineId: string; onSend: (message: unknown) => void }) {
	const [appendText, setAppendText] = useState("");
	return (
		<div className="enginehub-targets">
			<Space.Compact style={{ width: "100%" }}>
				<Input
					placeholder={t("追加目标（一行一个，可带备注）…")}
					value={appendText}
					onChange={(event) => setAppendText(event.target.value)}
				/>
				<Button
					type="primary"
					disabled={!appendText.trim()}
					onClick={() => {
						onSend({ type: "engine_add_targets", id: engineId, targets: appendText });
						setAppendText("");
					}}
				>
					{t("追加")}
				</Button>
			</Space.Compact>
		</div>
	);
}

function TaskBoard(props: { engine: SentinelEngine; onOpenTask(taskId: string): void; onAbortTask(taskId: string): void }) {
	const tasks = props.engine.tasks;
	return (
		<section className="engine-workspace-tasks" aria-label={t("任务看板")}>
			<div className="engine-workspace__panel-head">
				<Text strong>{t("任务")}</Text>
				<Text type="secondary">{t("{count} 个任务", { count: tasks.length })}</Text>
			</div>
			<div className="engine-workspace-tasks__list">
				{tasks.length === 0 ? (
					<Empty
						image={Empty.PRESENTED_IMAGE_SIMPLE}
						description={props.engine.status === "scheduled" ? t("计划等待开始。到点后先检查运行环境，再启动指挥官并派发任务。") : t("还没有任务。指挥官启动后会在这里派发。")}
					/>
				) : null}
				{tasks.map((task) => (
					<div key={task.id} className="engine-workspace-task">
						<button type="button" className="engine-workspace-task__open" onClick={() => props.onOpenTask(task.id)}>
							<span className="engine-workspace-task__heading">
								<span className="engine-workspace-task__title" title={task.title}>{task.title}</span>
								<Badge status={task.status === "done" ? "success" : task.status === "running" ? "processing" : task.status === "failed" ? "error" : task.status === "blocked" || task.status === "paused" ? "warning" : "default"} text={TASK_STATUS_LABELS[task.status]} />
							</span>
							<span className="engine-workspace-task__meta">
								{task.presetName ?? t("默认 Agent")} · {t("第 {count} 次", { count: task.attempt })}
								{task.vulns > 0 ? ` · ${t("{count} 条", { count: task.vulns })}` : ""}
							</span>
							{task.error || task.summary || task.target ? <span className={task.error ? "engine-workspace-task__preview is-error" : "engine-workspace-task__preview"} title={task.error ?? task.summary ?? task.target ?? undefined}>{task.error ?? task.summary ?? task.target}</span> : null}
						</button>
						{task.status === "running" || task.status === "queued" ? (
							<Button size="small" type="text" danger className="engine-workspace-task__abort" onClick={() => props.onAbortTask(task.id)}>{t("中止")}</Button>
						) : null}
					</div>
				))}
			</div>
		</section>
	);
}

function TaskModal(props: {
	task: SentinelEngineTask | null;
	events: SentinelSubagentEvent[];
	onClose(): void;
	onAbort(taskId: string): void;
	onOpenInChat(taskId: string): void;
}) {
	const task = props.task;
	if (!task) return null;
	return (
		<Modal
			open
			width={880}
			onCancel={props.onClose}
			footer={null}
			destroyOnHidden
			className="engine-task-modal"
			title={
				<Space size={8} wrap>
					<Text strong>{task.title}</Text>
					<Tag color={task.status === "done" ? "green" : task.status === "failed" ? "red" : "processing"} variant="filled">
						{TASK_STATUS_LABELS[task.status]}
					</Tag>
				</Space>
			}
		>
			<Space size={8} wrap className="enginehub-taskops">
				{task.sessionId ? (
					<Button size="small" onClick={() => props.onOpenInChat(task.id)}>
						{t("在对话中打开")}
					</Button>
				) : null}
				{task.status === "running" || task.status === "queued" ? (
					<Button size="small" danger onClick={() => props.onAbort(task.id)}>
						{t("中止任务")}
					</Button>
				) : null}
				<Button size="small" type="primary" onClick={props.onClose}>
					{t("关闭")}
				</Button>
			</Space>

			<Descriptions
				size="small"
				column={2}
				bordered
				className="enginehub-taskdesc"
				items={[
					{ key: "target", label: t("目标"), children: task.target ?? "—" },
					{ key: "preset", label: t("预设 Agent"), children: task.presetName ?? t("默认 Agent") },
					{ key: "attempt", label: t("派发次数"), children: t("第 {count} 次", { count: task.attempt }) },
					{ key: "workspace", label: t("工作目录"), children: <Text code>/work/tasks/{task.workspace}</Text> },
					{ key: "rounds", label: t("轮数上限"), children: task.roundLimit },
					{ key: "tokens", label: t("用量"), children: `${formatUsage(task.usage?.total)} tokens` },
					{
						key: "elapsed",
						label: t("耗时"),
						children: task.startedAt ? formatDuration((task.endedAt ?? Date.now()) - task.startedAt) : "—",
					},
					{ key: "vulns", label: t("中枢提交"), children: t("{count} 条", { count: task.vulns }) },
				]}
			/>

			<Text strong>{task.status === "running" ? t("当前结论") : t("结论")}</Text>
			{task.error ? <Alert type="error" showIcon className="ui-page__alert" title={task.error} /> : null}
			<pre className="enginehub-pre">{task.summary ?? t("（暂无）")}</pre>

			<Text strong>{t("任务指令（指挥官原文）")}</Text>
			<pre className="enginehub-pre">{task.objective}</pre>

			<Text strong>{t("执行过程 · {count} 步", { count: props.events.length })}</Text>
			<div className="enginehub-events">
				{props.events.slice(-30).map((event) => (
					<div key={event.seq} className="enginehub-event">
						<Space size={8} wrap>
							<Text type="secondary">{formatClock(event.at)}</Text>
							{event.kind === "text" ? (
								<Text>{(event.text ?? "").slice(0, 160)}</Text>
							) : event.kind === "thinking" ? (
								<Text type="secondary">{t("思考 · {count} 字", { count: (event.text ?? "").length })}</Text>
							) : event.kind === "tool_start" ? (
								<Text code>{event.toolName}</Text>
							) : event.kind === "tool_end" ? (
								<Tag color={event.isError ? "red" : "green"} variant="filled">
									{event.toolName}
								</Tag>
							) : (
								<Text type="secondary">{event.note ?? event.status ?? ""}</Text>
							)}
						</Space>
						{event.kind === "tool_end" && (event.output ?? "").trim() ? (
							<pre className="enginehub-pre">{event.output}</pre>
						) : null}
					</div>
				))}
			</div>
		</Modal>
	);
}

function ScheduleStrip({ schedule }: { schedule: SentinelEngineSchedule }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (schedule.phase === "finished") return;
		const timer = window.setInterval(() => setNow(Date.now()), 15_000);
		return () => window.clearInterval(timer);
	}, [schedule.phase]);
	const next = nextPlanStep(schedule);
	const steps: Array<{ action: SentinelEngineScheduleAction; at: number }> = [
		{ action: "start", at: schedule.startAt },
	];
	if (schedule.pauseAt !== null) steps.push({ action: "pause", at: schedule.pauseAt });
	if (schedule.resumeAt !== null) steps.push({ action: "resume", at: schedule.resumeAt });
	if (schedule.deadlineAt !== null) steps.push({ action: "deadline", at: schedule.deadlineAt });
	const phaseColor =
		schedule.phase === "running"
			? "processing"
			: schedule.phase === "paused"
				? "warning"
				: schedule.phase === "finished"
					? "default"
					: "blue";
	return (
		<Card
			size="small"
			className="enginehub-schedule"
			title={
				<Space size={8} wrap>
					<Text strong>{t("定时计划")}</Text>
					<Tag color={phaseColor} variant="filled">
						{SCHEDULE_PHASE_LABELS[schedule.phase]}
					</Tag>
					<Text type="secondary">{schedule.timezone}</Text>
				</Space>
			}
		>
			<Text type="secondary">
				{next
					? t("下次{action} {time}（{remaining}）", {
							action: SCHEDULE_ACTION_LABELS[next.action],
							time: formatZonedDateTime(next.at, schedule.timezone),
							remaining: formatRemaining(next.at, now),
						})
					: schedule.phase === "running"
						? t("无后续计划动作，运行至工程完成")
						: schedule.phase === "finished"
							? SCHEDULE_FINISH_LABELS[schedule.finishedReason ?? "manual"]
							: ""}
			</Text>
			<Space size={16} wrap className="enginehub-schedule__steps">
				{steps.map((step) => {
					const done = schedule.applied.includes(step.action);
					const current = next?.action === step.action;
					return (
						<Space key={step.action} size={6}>
							<Tag color={done ? "green" : current ? "processing" : "default"} variant="filled">
								{done ? "✓" : current ? "→" : "·"}
							</Tag>
							<Text>{SCHEDULE_ACTION_LABELS[step.action]}</Text>
							<Text type="secondary">{formatZonedDateTime(step.at, schedule.timezone)}</Text>
						</Space>
					);
				})}
			</Space>
		</Card>
	);
}

function ScheduleFields({
	draft,
	onChange,
	timezone,
}: {
	draft: ScheduleDraft;
	onChange: (next: ScheduleDraft) => void;
	timezone: string;
}) {
	const set = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]): void =>
		onChange({ ...draft, [key]: value });
	const lastStep = draft.resumeAt || draft.pauseAt || draft.startAt;
	return (
		<Form layout="vertical" requiredMark={false} className="enginehub-scheduleform">
			<Row gutter={12}>
				<Col xs={24} md={12}>
					<Form.Item label={t("开始时间")}>
						<Input
							type="datetime-local"
							value={draft.startAt}
							min={toLocalInputValue(Date.now())}
							onChange={(event) => set("startAt", event.target.value)}
						/>
					</Form.Item>
				</Col>
				<Col xs={24} md={12}>
					<Form.Item label={t("时区")}>
						<Text type="secondary">{t("{timezone}（浏览器时区）", { timezone })}</Text>
					</Form.Item>
				</Col>
			</Row>
			<Checkbox checked={draft.pauseEnabled} onChange={(event) => set("pauseEnabled", event.target.checked)}>
				{t("中途暂停，并在指定时间自动恢复")}
			</Checkbox>
			{draft.pauseEnabled ? (
				<Row gutter={12} className="enginehub-scheduleform__row">
					<Col xs={24} md={12}>
						<Form.Item label={t("暂停时间")}>
							<Input
								type="datetime-local"
								value={draft.pauseAt}
								min={draft.startAt}
								onChange={(event) => set("pauseAt", event.target.value)}
							/>
						</Form.Item>
					</Col>
					<Col xs={24} md={12}>
						<Form.Item label={t("恢复时间")}>
							<Input
								type="datetime-local"
								value={draft.resumeAt}
								min={draft.pauseAt || draft.startAt}
								onChange={(event) => set("resumeAt", event.target.value)}
							/>
						</Form.Item>
					</Col>
				</Row>
			) : null}
			<Checkbox checked={draft.deadlineEnabled} onChange={(event) => set("deadlineEnabled", event.target.checked)}>
				{t("设置最晚停止时间；到点未完成则暂停，等待操作员决定")}
			</Checkbox>
			{draft.deadlineEnabled ? (
				<Form.Item label={t("最晚停止时间")} className="enginehub-scheduleform__row">
					<Input
						type="datetime-local"
						value={draft.deadlineAt}
						min={lastStep}
						onChange={(event) => set("deadlineAt", event.target.value)}
					/>
				</Form.Item>
			) : null}
			<Text type="secondary">
				{t("到点暂停会立即中断正在运行的 Agent，保留会话，恢复时自动续跑。服务重启会暂停工程并停用计划，需要操作员手动继续。")}
			</Text>
		</Form>
	);
}

function ScheduleModal({
	schedule,
	onClose,
	onSave,
}: {
	schedule: SentinelEngineSchedule;
	onClose: () => void;
	onSave: (schedule: SentinelEngineScheduleInput) => void;
}) {
	const [draft, setDraft] = useState(() => draftFromSchedule(schedule));
	const [error, setError] = useState<string | null>(null);
	return (
		<Modal
			open
			width={720}
			title={t("修改定时计划")}
			okText={t("保存计划")}
			cancelText={t("取消")}
			onCancel={onClose}
			destroyOnHidden
			onOk={() => {
				const parsed = parseScheduleDraft(draft);
				if (!parsed.schedule) {
					setError(parsed.error ?? t("计划无效"));
					return;
				}
				onSave(parsed.schedule);
			}}
		>
			{error ? <Alert type="error" showIcon className="ui-page__alert" title={error} /> : null}
			<ScheduleFields
				draft={draft}
				onChange={(next) => {
					setDraft(next);
					setError(null);
				}}
				timezone={browserTimezone()}
			/>
		</Modal>
	);
}

function CreateEngineForm(props: {
	doctrines: SentinelDoctrineView[];
	presets: SentinelPresetView[];
	hasProject: boolean;
	project: SentinelProjectInfo | null;
	/** Whether a judge endpoint resolves; `ai` is only offered when it does. */
	judgeAvailable: boolean;
	onCancel(): void;
	onSubmit(input: {
		name: string;
		targets: string;
		doctrines: string[];
		presetIds: string[];
		presetOptional: boolean;
		limits: SentinelEngineLimits;
		gateMode: SentinelEngineGateMode;
		schedule?: SentinelEngineScheduleInput;
	}): void;
}) {
	type WizardStep = 1 | 2 | 3;
	const [step, setStep] = useState<WizardStep>(1);
	const [name, setName] = useState("");
	const [targets, setTargets] = useState("");
	const [files, setFiles] = useState<UploadFile<UploadedFile>[]>([]);
	const [selectedDoctrineId, setSelectedDoctrineId] = useState<string | null>(props.doctrines.some((doctrine) => doctrine.id === "attack-defense-web") ? "attack-defense-web" : null);
	const selectedDoctrine = props.doctrines.find((doctrine) => doctrine.id === selectedDoctrineId);
	/** Preset whitelist; empty means "no restriction" and is the default. */
	const [selectedPresets, setSelectedPresets] = useState<string[]>([]);
	const [presetsOpen, setPresetsOpen] = useState(false);
	const [presetQuery, setPresetQuery] = useState("");
	/** A task may run without a preset; allowing it is the default. */
	const [presetOptional, setPresetOptional] = useState(true);
	const [concurrency, setConcurrency] = useState(3);
	const [roundLimit, setRoundLimit] = useState(5);
	const [maxRetries, setMaxRetries] = useState(1);
	const [tokenLimit, setTokenLimit] = useState("");
	const [timeLimitMin, setTimeLimitMin] = useState("");
	const [gateMode, setGateMode] = useState<SentinelEngineGateMode>("auto");
	const [startMode, setStartMode] = useState<"now" | "scheduled">("now");
	const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => emptyScheduleDraft());
	const [formError, setFormError] = useState<string | null>(null);

	const enabledPresets = props.presets.filter((preset) => preset.enabled);
	const visiblePresets = enabledPresets.filter((preset) =>
		`${preset.name}\n${preset.description}`.toLocaleLowerCase().includes(presetQuery.trim().toLocaleLowerCase()),
	);
	const uploading = files.some((file) => file.status === "uploading");
	const failedUploads = files.some((file) => file.status !== "uploading" && (file.status !== "done" || !file.response));
	const attachments = files.flatMap((file) => file.status === "done" && file.response ? [file.response] : []);
	const stepMeta = [
		{ step: 1 as const, title: t("指挥思路"), hint: t("思路与 Agent") },
		{ step: 2 as const, title: t("目标"), hint: t("范围与名称") },
		{ step: 3 as const, title: getLanguage() === "en" ? "Run settings" : "执行配置", hint: t("时间与上限") },
	];
	const selectedPresetLabel =
		selectedPresets.length === 0
			? t("Agent 不限制")
			: t("{count} 个 Agent 预设", { count: selectedPresets.length });

	/** Validation is per step so "下一步" never skips a blocking field. */
	function validateStep(target: WizardStep): string | null {
		if (target === 1) {
			if (!selectedDoctrine) return getLanguage() === "en" ? "Choose one command doctrine." : "请选择一个指挥思路";
			return null;
		}
		if (target === 2) {
			if (!name.trim()) return t("请填写工程名称");
			if (!props.project) return t("请先选择项目");
			if (uploading) return getLanguage() === "en" ? "Wait for uploads to finish." : "请等待文件上传完成。";
			if (failedUploads) return getLanguage() === "en" ? "Remove or upload failed files again." : "请移除上传失败的文件，或重新上传。";
			if (attachments.some((file) => file.projectId !== props.project?.id)) return getLanguage() === "en" ? "Project changed; upload the files again." : "项目已切换，请重新上传文件。";
			if (targets.trim() === "" && attachments.length === 0) return getLanguage() === "en" ? "Describe the targets or attach a file." : "请填写目标描述或上传附件。";
			return null;
		}
		if (startMode === "scheduled") {
			const parsed = parseScheduleDraft(scheduleDraft);
			return parsed.schedule ? null : (parsed.error ?? t("定时计划无效"));
		}
		return null;
	}

	function goToStep(target: WizardStep): void {
		if (target > step) {
			for (let current = step; current < target; current += 1) {
				const error = validateStep(current as WizardStep);
				if (error) {
					setStep(current as WizardStep);
					setFormError(error);
					return;
				}
			}
		}
		setStep(target);
		setFormError(null);
	}

	function submit(): void {
		for (const current of [1, 2, 3] as const) {
			const error = validateStep(current);
			if (error) {
				setStep(current);
				setFormError(error);
				return;
			}
		}
		const parsed = startMode === "scheduled" ? parseScheduleDraft(scheduleDraft) : {};
		if (startMode === "scheduled" && !parsed.schedule) {
			setFormError(parsed.error ?? t("定时计划无效"));
			return;
		}
		setFormError(null);
		if (!selectedDoctrine) return;
		props.onSubmit({
			name: name.trim(),
			targets: engineTargetText(targets, attachments, props.project?.id ?? ""),
			doctrines: [selectedDoctrine.id],
			presetIds: selectedPresets,
			presetOptional,
			limits: {
				concurrency,
				roundLimit,
				maxRetries,
				tokenLimit: tokenLimit.trim() ? Number.parseInt(tokenLimit, 10) : null,
				timeLimitMin: timeLimitMin.trim() ? Number.parseInt(timeLimitMin, 10) : null,
			},
			gateMode,
			schedule: parsed.schedule,
		});
	}

	function next(): void {
		const error = validateStep(step);
		if (error) {
			setFormError(error);
			return;
		}
		if (step < 3) {
			setStep((step + 1) as WizardStep);
			setFormError(null);
			return;
		}
		submit();
	}

	const nextLabel =
		step === 1
			? (getLanguage() === "en" ? "Next: targets →" : "下一步：目标 →")
			: step === 2
				? t("下一步：执行配置 →")
				: startMode === "scheduled"
					? t("保存计划")
					: t("启动工程 →");

	return (
		<div className="enginewiz">
			<div className="enginewiz-head">
				<div>
					<Title level={4} className="enginewiz-title">
						{t("新建工程")}
					</Title>
					<Text type="secondary">
						{getLanguage() === "en" ? "Choose one command doctrine, add targets, then configure execution." : "先选择一个指挥思路，再添加目标，最后配置执行。"}
					</Text>
				</div>
				<Button onClick={props.onCancel}>{t("取消")}</Button>
			</div>

			<div className="enginewiz-progress">
				<Steps
					current={step - 1}
					size="small"
					className="enginewiz-steps"
					items={stepMeta.map((item) => ({ title: item.title }))}
				/>
				<Text type="secondary" className="enginewiz-step-hint">
					{t("第 {step} 步 / 共 3 步 · {hint}", { step, hint: stepMeta[step - 1]?.hint ?? "" })}
				</Text>
			</div>

			<Row gutter={[16, 16]}>
				<Col xs={24} lg={16}>
					<Card
						size="small"
						title={
							step === 1
								? (getLanguage() === "en" ? "Step 1 · Command doctrines" : "第 1 步 · 指挥思路")
								: step === 2
									? (getLanguage() === "en" ? "Step 2 · Targets" : "第 2 步 · 目标")
									: (getLanguage() === "en" ? "Step 3 · Run settings" : "第 3 步 · 执行配置")
						}
					>
						{formError ? <Alert type="error" showIcon className="ui-page__alert" title={formError} /> : null}

						{step === 1 ? (
							<>
								{props.doctrines.length === 0 ? (
									<Alert
										type="warning"
										showIcon
										className="ui-page__alert"
										title={t("还没有可用的指挥思路，请先到「指挥思路」页面创建。")}
									/>
								) : (
									<Radio.Group value={selectedDoctrineId} onChange={(event) => {
										setSelectedDoctrineId(event.target.value as string);
										setFormError(null);
									}} style={{ width: "100%" }} aria-label={t("指挥思路")}>
									<Space orientation="vertical" size={8} className="enginewiz-list">
										{props.doctrines.map((doctrine) => {
											const checked = selectedDoctrineId === doctrine.id;
											return (
												<Radio
													key={doctrine.id}
													value={doctrine.id}
													className={checked ? "enginewiz-card is-on" : "enginewiz-card"}
												>
													<Space size={6} wrap>
														<Text strong>{doctrine.name}</Text>
														{doctrine.builtin ? (
															<Tag variant="filled">{t("内置")}</Tag>
														) : null}
													</Space>
													<Text type="secondary" className="enginewiz-card__text">
														{doctrine.text.split("\n")[0]}
													</Text>
												</Radio>
											);
										})}
									</Space>
									</Radio.Group>
								)}

								<div className="enginewiz-agent-entry">
									<div className="enginewiz-agent-entry__summary">
										<Text>{t("Agent 白名单")}</Text>
										<Text type="secondary">
											{selectedPresetLabel} · {presetOptional
												? (getLanguage() === "en" ? "Default agent allowed" : "允许默认 Agent")
												: (getLanguage() === "en" ? "Preset required" : "必须指定预设")}
										</Text>
									</div>
									<Button size="small" type="link" icon={<SettingOutlined />} onClick={() => setPresetsOpen(true)}>
										{t("配置")}
									</Button>
								</div>
							</>
						) : null}

						{step === 2 ? (
							<Form layout="vertical" requiredMark={false}>
								<Form.Item label={t("工程名称")} required>
									<Input
										value={name}
										onChange={(event) => {
											setName(event.target.value);
											setFormError(null);
										}}
										placeholder={t("如：内网一批 Web 目标")}
									/>
								</Form.Item>
								<Form.Item
									label={t("目标清单")}
									required
								>
									<Input.TextArea
										value={targets}
										onChange={(event) => {
											setTargets(event.target.value);
											setFormError(null);
										}}
										autoSize={{ minRows: 8, maxRows: 18 }}
										placeholder={t(
											"10.0.0.1 这台是 Web 服务器\n10.0.0.2\nhttp://target.example.com 只测登录功能",
										)}
									/>
									<EngineTargetFiles project={props.project} files={files} onChange={setFiles} />
								</Form.Item>
								<Text type="secondary">
									{t("目标越具体，指挥官拆出来的任务越稳。备注只给指挥官看，不会被当作命令。")}
								</Text>
							</Form>
						) : null}

						{step === 3 ? (
							<>
								<Space size={8} className="enginewiz-section">
									<Text strong>{t("启动方式")}</Text>
									<Text type="secondary">{t("时区 {timezone}", { timezone: browserTimezone() })}</Text>
								</Space>
								<Segmented
									value={startMode}
									onChange={(value) => {
										setStartMode(value as "now" | "scheduled");
										setFormError(null);
									}}
									options={[
										{ value: "now", label: t("立即启动") },
										{ value: "scheduled", label: t("定时启动") },
									]}
								/>
								{startMode === "scheduled" ? (
									<div className="enginewiz-schedule">
										<ScheduleFields
											draft={scheduleDraft}
											onChange={(nextDraft) => {
												setScheduleDraft(nextDraft);
												setFormError(null);
											}}
											timezone={browserTimezone()}
										/>
									</div>
								) : (
									<Text type="secondary">{t("保存后立即检查 Docker 环境并启动指挥官。")}</Text>
								)}

								<Text strong className="enginewiz-section">
									{t("执行上限")}
								</Text>
								<Row gutter={[12, 12]}>
									<Col xs={12} md={8}>
										<Text type="secondary">{t("最大并发任务")}</Text>
										<InputNumber
											min={1}
											style={{ width: "100%" }}
											value={concurrency}
											onChange={(value) => setConcurrency(value ?? 1)}
										/>
									</Col>
									<Col xs={12} md={8}>
										<Text type="secondary">{t("单任务最大轮数")}</Text>
										<InputNumber
											min={1}
											style={{ width: "100%" }}
											value={roundLimit}
											onChange={(value) => setRoundLimit(value ?? 1)}
										/>
									</Col>
									<Col xs={12} md={8}>
										<Text type="secondary">{t("每目标重试次数")}</Text>
										<InputNumber
											min={0}
											style={{ width: "100%" }}
											value={maxRetries}
											onChange={(value) => setMaxRetries(value ?? 0)}
										/>
									</Col>
									<Col xs={12} md={8}>
										<Text type="secondary">{t("总 token 上限（可选）")}</Text>
										<InputNumber
											min={0}
											style={{ width: "100%" }}
											value={tokenLimit.trim() === "" ? null : Number(tokenLimit)}
											onChange={(value) => setTokenLimit(value === null || value === undefined ? "" : String(value))}
											placeholder={t("不限制")}
										/>
									</Col>
									<Col xs={12} md={8}>
										<Text type="secondary">{t("总时间上限 / 分钟（可选）")}</Text>
										<InputNumber
											min={0}
											style={{ width: "100%" }}
											value={timeLimitMin.trim() === "" ? null : Number(timeLimitMin)}
											onChange={(value) => setTimeLimitMin(value === null || value === undefined ? "" : String(value))}
											placeholder={t("不限制")}
										/>
									</Col>
								</Row>

								<Text strong className="enginewiz-section">
									{t("命令守门")}
								</Text>
								<Radio.Group value={gateMode} onChange={(event) => setGateMode(event.target.value as SentinelEngineGateMode)}>
									<Space orientation="vertical" size={8} className="enginewiz-list">
										<Radio value="auto" className={gateMode === "auto" ? "enginewiz-card is-on" : "enginewiz-card"}>
											<Text strong>{t("自动执行")}</Text>
											<Text type="secondary" className="enginewiz-card__text">
												{t("worker 的命令直接执行，不做拦截（最快）。")}
											</Text>
										</Radio>
										<Radio
											value="ai"
											disabled={!props.judgeAvailable}
											className={gateMode === "ai" ? "enginewiz-card is-on" : "enginewiz-card"}
										>
											<Text strong>{t("AI 裁判")}</Text>
											<Text type="secondary" className="enginewiz-card__text">
												{props.judgeAvailable
													? t("每条命令先由守门模型判定，拦截时把理由回给 worker。")
													: t("未配置守门模型：请先到 设置 → 模型 配置守门模型。")}
											</Text>
										</Radio>
									</Space>
								</Radio.Group>

								<Card size="small" className="enginewiz-review" title={t("确认")}>
									<Space size={24} wrap>
										<Text type="secondary">
											{t("指挥")} <Text strong>{selectedDoctrine?.name ?? t("待填写")}</Text>
										</Text>
										<Text type="secondary">
											{t("Agent")}{" "}
											<Text strong>
												{selectedPresets.length === 0
													? t("不限制")
													: t("{count} 个预设", { count: selectedPresets.length })}
											</Text>
										</Text>
										<Text type="secondary">
											{t("启动")}{" "}
											<Text strong>
												{startMode === "scheduled"
													? scheduleDraft.startAt
														? scheduleDraft.startAt.replace("T", " ")
														: t("待填写")
													: t("立即")}
											</Text>
										</Text>
									</Space>
								</Card>
								<Text type="secondary">
									{t("启动后指挥官全权调度；人保留暂停、终止、追加目标与 steer。手动暂停、继续或终止会停用后续定时计划。")}
								</Text>
							</>
						) : null}

						<div className="enginewiz-foot">
							<Button disabled={step === 1} onClick={() => goToStep((step - 1) as WizardStep)}>
								{t("上一步")}
							</Button>
							<Button type="primary" onClick={next} disabled={uploading}>
								{nextLabel}
							</Button>
							<Text type="secondary">{step} / 3</Text>
						</div>
					</Card>
				</Col>
				<Col xs={24} lg={8}>
					<Card size="small" title={t("草稿")} className="enginewiz-draft">
						<Text type="secondary">DRAFT / 0{step}</Text>
						<Text strong>{name.trim() || t("未命名工程")}</Text>
						<Text type="secondary">
							{selectedDoctrine?.name ?? t("待填写")} · {selectedPresetLabel}
						</Text>
						{files.length > 0 ? <Text type="secondary">{getLanguage() === "en" ? `${attachments.length} attachments uploaded` : `已上传 ${attachments.length} 个附件`}</Text> : null}
					</Card>
					<Card size="small" title={t("提示")} className="enginewiz-tips">
						<Space orientation="vertical" size={10}>
							<div className="enginewiz-tiprow">
								<Text strong>{t("不会提前启动")}</Text>
								<Text type="secondary" className="enginewiz-tip">
									{t("定时工程只保存计划，到点才检查 Docker 环境。")}
								</Text>
							</div>
							<div className="enginewiz-tiprow">
								<Text strong>{t("失败可以继续")}</Text>
								<Text type="secondary" className="enginewiz-tip">
									{t("环境或指挥官启动失败会停在暂停态，不会丢配置。")}
								</Text>
							</div>
							<div className="enginewiz-tiprow">
								<Text strong>{t("手动优先")}</Text>
								<Text type="secondary" className="enginewiz-tip">
									{t("手动暂停、继续或终止会停用后续计划，避免互相抢状态。")}
								</Text>
							</div>
						</Space>
					</Card>
				</Col>
			</Row>
			<Drawer
				title={t("Agent 白名单")}
				placement="right"
				size={480}
				open={presetsOpen}
				onClose={() => setPresetsOpen(false)}
				className="enginewiz-agent-drawer"
				styles={{ wrapper: { maxWidth: "100vw" } }}
				footer={
					<div className="enginewiz-agent-drawer__footer">
						<Button disabled={selectedPresets.length === 0} onClick={() => setSelectedPresets([])}>
							{getLanguage() === "en" ? "Clear selection" : "清空选择"}
						</Button>
						<Button type="primary" onClick={() => setPresetsOpen(false)}>{t("完成")}</Button>
					</div>
				}
			>
				<div className="enginewiz-agent-drawer__content">
					<Text type="secondary">{t("不勾选 = 不限制，可使用全部已启用预设")}</Text>
					<div className="enginewiz-agent-drawer__policy">
						<Checkbox checked={presetOptional} onChange={(event) => setPresetOptional(event.target.checked)}>
							{t("允许任务不指定预设，没有合适预设时退回默认 Agent")}
						</Checkbox>
					</div>
					<Input.Search
						allowClear
						value={presetQuery}
						onChange={(event) => setPresetQuery(event.target.value)}
						placeholder={getLanguage() === "en" ? "Search agents" : "搜索 Agent"}
					/>
					{enabledPresets.length === 0 ? (
						<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("还没有启用的预设 Agent，可到「设置 → 预设 Agent」创建。")} />
					) : visiblePresets.length === 0 ? (
						<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={getLanguage() === "en" ? "No matching agents" : "没有匹配的 Agent"} />
					) : (
						<div className="enginewiz-agent-drawer__list">
							{visiblePresets.map((preset) => (
								<Checkbox
									key={preset.id}
									checked={selectedPresets.includes(preset.id)}
									className="enginewiz-agent-option"
									onChange={(event) => setSelectedPresets((previous) =>
										event.target.checked ? [...previous, preset.id] : previous.filter((id) => id !== preset.id),
									)}
								>
									<Text strong>{preset.name}</Text>
									<Text type="secondary" className="enginewiz-card__text">
										{preset.description || `${formatUsage(preset.tokens)} tokens`}
									</Text>
								</Checkbox>
							))}
						</div>
					)}
				</div>
			</Drawer>
		</div>
	);
}


function DoctrineManager(props: {
	doctrines: SentinelDoctrineView[];
	onClose(): void;
	onSave(input: { name: string; text: string }): Promise<string | null>;
	onDelete(id: string): void;
}) {
	const [name, setName] = useState("");
	const [text, setText] = useState("");
	const [creating, setCreating] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const visible = props.doctrines.filter((doctrine) => `${doctrine.name}\n${doctrine.text}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
	const createLabel = getLanguage() === "en" ? "Add command doctrine" : "新增指挥思路";
	const submit = async () => {
		if (!name.trim() || !text.trim() || saving) return;
		setSaving(true);
		setError(null);
		try {
			const message = await props.onSave({ name: name.trim(), text: text.trim() });
			if (message) {
				setError(message);
				return;
			}
			setCreating(false);
			setName("");
			setText("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};
	return (
		<Page
			className="doctrine-manager"
			title={t("指挥思路")}
			description={getLanguage() === "en" ? "Choose one command doctrine when creating an engagement to guide the commander." : "创建工程时选择一个指挥思路，作为指挥官的任务编排依据。"}
			extra={
				<Space size={8} wrap>
					<Button onClick={props.onClose}>{t("返回")}</Button>
					<Button type="primary" icon={<PlusOutlined />} onClick={() => { setError(null); setCreating(true); }}>
						{createLabel}
					</Button>
				</Space>
			}
		>
			<div className="doctrine-manager__layout">
				<section className="doctrine-manager__library">
					<div className="doctrine-manager__toolbar">
						<Text type="secondary">{t("{count} 条思路", { count: props.doctrines.length })}</Text>
						<Input.Search allowClear value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索")} />
					</div>
					{visible.length === 0 ? (
						<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query.trim() ? (getLanguage() === "en" ? "No matching doctrines" : "没有匹配的指挥思路") : t("还没有指挥思路")} />
					) : (
						<Collapse
							className="doctrine-manager__list"
							items={visible.map((doctrine) => ({
								key: doctrine.id,
								label: (
									<div className="doctrine-manager__label">
										<Space size={8} wrap>
											<Text strong>{doctrine.name}</Text>
											{doctrine.builtin ? <Tag variant="filled">{t("内置")}</Tag> : null}
										</Space>
										<Text type="secondary" className="doctrine-manager__preview">
											{doctrine.text.split("\n")[0]}
										</Text>
									</div>
								),
								extra: doctrine.builtin ? null : (
									<Popconfirm
										title={t("删除思路")}
										description={t("删除思路「{name}」？", { name: doctrine.name })}
										okText={t("删除")}
										okButtonProps={{ danger: true }}
										cancelText={t("取消")}
										onConfirm={() => props.onDelete(doctrine.id)}
									>
										<Button size="small" type="text" danger onClick={(event) => event.stopPropagation()}>
											{t("删除")}
										</Button>
									</Popconfirm>
								),
								children: <pre className="doctrine-manager__text">{doctrine.text}</pre>,
							}))}
						/>
					)}
				</section>
			</div>
			<Modal
				open={creating}
				title={createLabel}
				width={720}
				okText={t("保存")}
				cancelText={t("取消")}
				confirmLoading={saving}
				okButtonProps={{ disabled: !name.trim() || !text.trim() }}
				cancelButtonProps={{ disabled: saving }}
				closable={!saving}
				mask={{ closable: !saving }}
				keyboard={!saving}
				onCancel={() => setCreating(false)}
				onOk={() => void submit()}
			>
					{error ? <Alert type="error" showIcon title={error} className="ui-page__alert" /> : null}
					<Form layout="vertical" requiredMark={false} disabled={saving} onFinish={() => void submit()}>
						<Form.Item label={t("思路名称")} required>
							<Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("思路名称")} />
						</Form.Item>
						<Form.Item label={t("思路内容（纯文本，注入指挥官系统指令）")} required>
							<Input.TextArea autoSize={{ minRows: 10, maxRows: 18 }} value={text} onChange={(event) => setText(event.target.value)} />
						</Form.Item>
					</Form>
			</Modal>
		</Page>
	);
}
