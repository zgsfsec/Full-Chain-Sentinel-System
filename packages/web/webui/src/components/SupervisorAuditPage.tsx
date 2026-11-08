/**
 * 工作台 → 监督: a read-only audit of every conversation that was armed.
 *
 * Filters + KPI strip + dense table, with a detail drawer opened from a row.
 * The live view belongs to the floating window; this page never changes a
 * running session.
 *
 * Two layout rules worth keeping:
 * - The detail opens as a drawer over the table: the supervisor detail is three
 *   blocks of reading material — Episode, 建议, 日志 — that want the full width
 *   side by side rather than a 380px column.
 * - Filters apply the moment they change. The keyword box waits for Enter or
 *   查询, and the pager re-uses the filter that was applied — not the one
 *   half-typed in the box.
 */

import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import {
	Alert,
	Badge,
	Button,
	Col,
	Descriptions,
	Drawer,
	Empty,
	Input,
	Row,
	Select,
	Space,
	Tag,
	Typography,
} from "antd";
import { useEffect, useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import type { DetailLoadState } from "../detail-request.ts";
import { DetailLoading } from "../ui/DetailLoading.tsx";
import { SUPERVISOR_STRATEGY_OPTIONS, supervisorStrategyLabel } from "../supervisor-strategy.ts";
import type {
	SentinelProjectInfo,
	SentinelSupervisorAuditItem,
	SentinelSupervisorAuditPage,
	SentinelSupervisorCustomStrategy,
	SentinelSupervisorDetail,
	SentinelSupervisorEpisode,
	SentinelSupervisorLog,
	SentinelSupervisorMode,
	SentinelSupervisorProgress,
	SentinelSupervisorStrategy,
} from "../types.ts";
import { Page } from "../ui/Page.tsx";
import { MetricStrip } from "../ui/MetricStrip.tsx";

const { Text } = Typography;

const PHASE_LABELS: Record<string, string> = {
	recon: t("侦察"),
	enum: t("枚举"),
	vuln_mapping: t("漏洞验证"),
	exploitation: t("利用"),
	post: t("后渗透"),
	report: t("报告"),
	unknown: t("未判断"),
};

const PROGRESS_LABELS: Record<string, string> = {
	advancing: t("有进展"),
	stalled: t("停滞"),
	looping: t("循环"),
	unknown: t("未判断"),
};

const STATUS_LABELS: Record<string, string> = {
	waiting: t("等待开始"),
	running: t("监督中"),
	stopped: t("已停止"),
	error: t("错误"),
};

const MODE_LABELS: Record<SentinelSupervisorMode, string> = {
	observe: t("观察"),
	intervene: t("介入"),
};

/** Why the supervisor woke up. The stored value is an English enum. */
const TRIGGER_LABELS: Record<string, string> = {
	batch: t("批量触发"),
	duplicate: t("重复调用"),
	"no-progress": t("没有新证据"),
	"error-streak": t("连续报错"),
	manual: t("手动触发"),
	settled: t("运行结算"),
};

const PROGRESS_COLORS: Record<string, string> = {
	advancing: "green",
	stalled: "orange",
	looping: "red",
	unknown: "default",
};

function timeLabel(at: number): string {
	return new Date(at).toLocaleString(getLanguage() === "zh" ? "zh-CN" : "en-US", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function strategyNames(item: SentinelSupervisorAuditItem): string {
	const selected = item.strategies?.filter((entry) => entry.name || entry.strategy);
	if (selected && selected.length > 0) {
		return selected.map((entry) => entry.name || supervisorStrategyLabel(entry.strategy)).join(" + ");
	}
	return item.strategyName || supervisorStrategyLabel(item.strategy);
}

function strategyNotes(item: SentinelSupervisorAuditItem): Array<{ name: string; instructions: string }> {
	const selected = item.strategies?.filter((entry) => entry.instructions.trim());
	if (selected && selected.length > 0) {
		return selected.map((entry) => ({
			name: entry.name || supervisorStrategyLabel(entry.strategy),
			instructions: entry.instructions,
		}));
	}
	return item.strategyInstructions
		? [{ name: item.strategyName || supervisorStrategyLabel(item.strategy), instructions: item.strategyInstructions }]
		: [];
}

function phaseLabel(value: string): string {
	return PHASE_LABELS[value] ?? value;
}

function progressLabel(value: string): string {
	return PROGRESS_LABELS[value] ?? value;
}

function triggerLabel(value: string): string {
	return TRIGGER_LABELS[value] ?? value;
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function statusBadge(status: string): "success" | "processing" | "warning" | "error" | "default" {
	if (status === "running") return "processing";
	if (status === "waiting") return "warning";
	if (status === "error") return "error";
	if (status === "stopped") return "default";
	return "default";
}

/** The mode a session was armed with, including how an advice is delivered. */
function modeHint(item: { mode: SentinelSupervisorMode; delivery: string }): string {
	if (item.mode === "observe") return t("观察模式：只记录，不向主代理注入任何内容");
	return item.delivery === "auto" ? t("介入模式：建议自动发送") : t("介入模式：建议需操作员确认后发送");
}

function EpisodeBlock({ episode }: { episode: SentinelSupervisorEpisode }) {
	return (
		<div className="sva-episode">
			<div className="sva-episode-head">
				<Text type="secondary" className="sva-mono">
					{timeLabel(episode.at)}
				</Text>
				<Tag color={PROGRESS_COLORS[episode.progress]} variant="filled">
					{progressLabel(episode.progress)}
				</Tag>
				<Text type="secondary">{phaseLabel(episode.phase)}</Text>
				{episode.error ? (
					<Tag color="red" variant="filled">
						{t("失败")}
					</Tag>
				) : null}
				<Text type="secondary" title={t("触发原因")}>
					{triggerLabel(episode.trigger)}
				</Text>
			</div>
			<Text>{episode.intent || episode.error || t("（无摘要）")}</Text>
			{episode.outcomes.length > 0 ? (
				<ul className="sva-list">
					{episode.outcomes.map((item, index) => (
						<li key={index}>{item}</li>
					))}
				</ul>
			) : null}
			{episode.deadEnds.length > 0 ? (
				<Text type="secondary">{t("已排除：{items}", { items: episode.deadEnds.join("；") })}</Text>
			) : null}
			{episode.nextCandidates.length > 0 ? (
				<Text>{t("下一步：{items}", { items: episode.nextCandidates.join("；") })}</Text>
			) : null}
		</div>
	);
}

function LogBlock({ logs }: { logs: SentinelSupervisorLog[] }) {
	if (logs.length === 0) return <Text type="secondary">{t("暂无日志。")}</Text>;
	return (
		<div className="sva-log">
			{logs.map((log, index) => (
				<div key={`${log.at}-${index}`} className={log.kind === "error" ? "sva-log__line is-bad" : "sva-log__line"}>
					<Text type="secondary" className="sva-mono">
						{timeLabel(log.at)}
					</Text>
					<Text>{log.text}</Text>
				</div>
			))}
		</div>
	);
}

/** The filter controls the page owns; the query itself is sent by App. */
interface FilterState {
	projectId: string;
	mode: "" | SentinelSupervisorMode;
	progress: "" | SentinelSupervisorProgress;
	strategy: "" | SentinelSupervisorStrategy;
	customStrategyId: string;
	search: string;
}

const EMPTY_FILTER: FilterState = {
	projectId: "",
	mode: "",
	progress: "",
	strategy: "",
	customStrategyId: "",
	search: "",
};

export function SupervisorAuditPage({
	page,
	detail,
	detailState,
	onRetryDetail,
	projects,
	customStrategies,
	onQuery,
	onSelect,
	onBack,
	onOpenSession,
}: {
	page: SentinelSupervisorAuditPage | null;
	detail: SentinelSupervisorDetail | null;
	detailState?: DetailLoadState | null;
	onRetryDetail?: () => void;
	projects: SentinelProjectInfo[];
	customStrategies: SentinelSupervisorCustomStrategy[];
	onQuery: (query: {
		page?: number;
		projectId?: string;
		search?: string;
		mode?: SentinelSupervisorMode;
		progress?: SentinelSupervisorProgress;
		strategy?: SentinelSupervisorStrategy;
		customStrategyId?: string;
	}) => void;
	onSelect: (sessionId: string) => void;
	onBack: () => void;
	onOpenSession: (path: string) => void;
}) {
	const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
	// The filter that is actually on screen. The pager re-uses it, so typing
	// in the keyword box without pressing 查询 cannot change what page 2 shows.
	const [applied, setApplied] = useState<FilterState>(EMPTY_FILTER);

	// The detail is a real drawer: Escape closes it.
	useEffect(() => {
		if (!detail && !detailState) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onBack();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [detail, detailState, onBack]);

	const stats = page?.stats ?? {
		total: 0,
		advancing: 0,
		stalled: 0,
		looping: 0,
		stopped: 0,
		pendingAdvice: 0,
	};

	const toQuery = (state: FilterState, nextPage: number) => ({
		page: nextPage,
		projectId: state.projectId || undefined,
		search: state.search.trim() || undefined,
		mode: state.mode || undefined,
		progress: state.progress || undefined,
		strategy: state.strategy || undefined,
		customStrategyId: state.customStrategyId || undefined,
	});

	const apply = (patch: Partial<FilterState>, nextPage = 1) => {
		const next = { ...filter, ...patch };
		setFilter(next);
		setApplied(next);
		onQuery(toQuery(next, nextPage));
	};

	const clearFilters = () => {
		setFilter(EMPTY_FILTER);
		setApplied(EMPTY_FILTER);
		onQuery(toQuery(EMPTY_FILTER, 1));
	};

	const filtered = Boolean(
		applied.projectId ||
			applied.mode ||
			applied.progress ||
			applied.strategy ||
			applied.customStrategyId ||
			applied.search.trim(),
	);

	const columns: ProColumns<SentinelSupervisorAuditItem>[] = [
		{
			title: t("状态"),
			key: "status",
			width: 150,
			render: (_, item) => (
				<Space size={6} wrap>
					<Badge status={statusBadge(item.status)} text={STATUS_LABELS[item.status] ?? item.status} />
					<Tag variant="filled" title={modeHint(item)}>
						{MODE_LABELS[item.mode]}
					</Tag>
				</Space>
			),
		},
		{
			title: t("会话 / 项目"),
			key: "session",
			ellipsis: true,
			render: (_, item) => (
				<div className="sva-session">
					<Text strong ellipsis title={item.sessionName}>
						{item.sessionName}
					</Text>
					<Text type="secondary">{item.projectName ?? "—"}</Text>
				</div>
			),
		},
		{
			title: t("阶段"),
			key: "phase",
			width: 96,
			render: (_, item) => phaseLabel(item.phase),
		},
		{
			title: t("进度"),
			key: "progress",
			width: 96,
			render: (_, item) => (
				<Tag color={PROGRESS_COLORS[item.progress]} variant="filled">
					{progressLabel(item.progress)}
				</Tag>
			),
		},
		{
			title: t("策略"),
			key: "strategy",
			width: 170,
			ellipsis: { showTitle: true },
			render: (_, item) => (
				<Tag variant="filled" title={strategyNames(item)}>
					{strategyNames(item)}
				</Tag>
			),
		},
		{
			title: t("调用 / Episode"),
			key: "calls",
			width: 130,
			render: (_, item) => (
				<Text type="secondary" className="sva-mono">
					{item.callCount} / {item.episodeCount}
				</Text>
			),
		},
		{
			title: t("建议"),
			key: "advice",
			width: 80,
			render: (_, item) =>
				item.adviceCount > 0 ? (
					<Tag variant="filled" title={t("{count} 条监督建议", { count: item.adviceCount })}>
						{item.adviceCount}
					</Tag>
				) : (
					<Text type="secondary">—</Text>
				),
		},
		{
			title: "tokens",
			key: "tokens",
			width: 90,
			render: (_, item) => (
				<Text type="secondary" className="sva-mono">
					{formatTokens(item.usage.total)}
				</Text>
			),
		},
		{
			title: t("最近更新"),
			key: "updatedAt",
			width: 130,
			render: (_, item) => <Text type="secondary">{timeLabel(item.updatedAt)}</Text>,
		},
	];

	return (
		<Page
			title={t("监督")}
			description={
				<>
					{t("全部对话的监督审计 · 只读")}
					{page ? t(" · 共 {count} 个会话", { count: page.total }) : ""}
				</>
			}
			extra={
				<Button icon={<ReloadOutlined />} onClick={() => onQuery(toQuery(applied, page?.page ?? 1))}>
					{t("刷新")}
				</Button>
			}
		>
			<MetricStrip
				items={[
					{ label: t("监督会话"), value: stats.total },
					{ label: t("有进展"), value: stats.advancing, tone: "success" },
					{ label: t("停滞"), value: stats.stalled, tone: stats.stalled > 0 ? "warning" : undefined },
					{ label: t("循环"), value: stats.looping, tone: stats.looping > 0 ? "danger" : undefined },
					{ label: t("已停止"), value: stats.stopped },
					{ label: t("待确认建议"), value: stats.pendingAdvice, tone: stats.pendingAdvice > 0 ? "warning" : undefined },
				]}
				note={t("进度与停止按每个会话的最新状态统计")}
			/>

			<ProTable<SentinelSupervisorAuditItem>
				rowKey="sessionId"
				size="small"
				columns={columns}
				dataSource={page?.items ?? []}
				loading={!page}
				search={false}
				options={false}
				scroll={{ x: 1080 }}
				pagination={
					page
						? {
								current: page.page,
								pageSize: page.pageSize,
								total: page.total,
								showSizeChanger: false,
								showTotal: (count) => t("共 {count} 个会话", { count }),
								onChange: (next) => onQuery(toQuery(applied, next)),
							}
						: false
				}
				toolbar={{
					title: (
						<div className="sva-toolbar">
							<Select
								value={filter.projectId}
								style={{ width: 150 }}
								onChange={(value) => apply({ projectId: value })}
								options={[
									{ value: "", label: t("全部项目") },
									...projects.map((project) => ({ value: project.id, label: project.name })),
								]}
							/>
							<Select
								value={filter.mode}
								style={{ width: 120 }}
								onChange={(value) => apply({ mode: value as "" | SentinelSupervisorMode })}
								options={[
									{ value: "", label: t("全部模式") },
									{ value: "observe", label: t("观察") },
									{ value: "intervene", label: t("介入") },
								]}
							/>
							<Select
								value={filter.progress}
								style={{ width: 120 }}
								onChange={(value) => apply({ progress: value as "" | SentinelSupervisorProgress })}
								options={[
									{ value: "", label: t("全部进度") },
									{ value: "advancing", label: t("有进展") },
									{ value: "stalled", label: t("停滞") },
									{ value: "looping", label: t("循环") },
									{ value: "unknown", label: t("未判断") },
								]}
							/>
							<Select
								value={filter.strategy}
								style={{ width: 140 }}
								onChange={(value) => apply({ strategy: value as "" | SentinelSupervisorStrategy })}
								options={[
									{ value: "", label: t("全部预设") },
									...SUPERVISOR_STRATEGY_OPTIONS.map((option) => ({ value: option.id, label: option.label })),
								]}
							/>
							{customStrategies.length > 0 ? (
								<Select
									value={filter.customStrategyId}
									style={{ width: 140 }}
									onChange={(value) => apply({ customStrategyId: value })}
									options={[
										{ value: "", label: t("全部自定义") },
										...customStrategies.map((custom) => ({ value: custom.id, label: custom.name })),
									]}
								/>
							) : null}
							<Input
								allowClear
								className="sva-search"
								prefix={<SearchOutlined />}
								placeholder={t("会话 / 项目 / 意图")}
								value={filter.search}
								spellCheck={false}
								onChange={(event) => setFilter({ ...filter, search: event.target.value })}
								onPressEnter={() => apply({ search: filter.search })}
							/>
							<Button onClick={() => apply({ search: filter.search })}>{t("查询")}</Button>
							{filtered ? (
								<Button type="link" onClick={clearFilters}>
									{t("清空")}
								</Button>
							) : null}
						</div>
					),
				}}
				onRow={(record) => ({
					onClick: (event) => {
						const target = event.target as HTMLElement;
						if (target.closest("button, a")) return;
						onSelect(record.sessionId);
					},
					style: { cursor: "pointer" },
				})}
				locale={{
					emptyText: (
						<Empty
							image={Empty.PRESENTED_IMAGE_SIMPLE}
							description={
								<>
									<div>{filtered ? t("没有符合条件的监督会话") : t("还没有开启过监督的会话")}</div>
									<div className="sva-empty-hint">
										{filtered
											? t("清空筛选条件，或换个关键字再试一次。")
											: t("开始对话前在输入框上方点「监督」，这里就会出现记录。")}
									</div>
								</>
							}
						/>
					),
				}}
			/>

			{detail || detailState ? (
				<Drawer
					open
					size={1040}
					onClose={onBack}
					destroyOnHidden
					className="sva-drawer"
					title={detail?.session.sessionName ?? t("监督详情")}
					extra={
						detail?.session.sessionPath ? (
							<Button type="primary" onClick={() => onOpenSession(detail.session.sessionPath as string)}>
								{t("打开会话")}
							</Button>
						) : null
					}
				>
					{!detail ? <DetailLoading error={detailState?.error} onRetry={onRetryDetail} /> : <>
					<Text type="secondary">
						{`${detail.session.projectName ?? t("未选择项目")} · ${
							detail.session.mode === "observe"
								? t("观察")
								: t("介入 · {delivery}", {
										delivery: detail.session.delivery === "auto" ? t("自动") : t("确认"),
									})
						} · ${strategyNames(detail.session)}`}
					</Text>

					<Descriptions
						size="small"
						column={3}
						bordered
						className="sva-desc"
						items={[
							{ key: "phase", label: t("阶段"), children: phaseLabel(detail.session.phase) },
							{ key: "progress", label: t("进度"), children: progressLabel(detail.session.progress) },
							{ key: "calls", label: t("工具调用"), children: detail.session.callCount },
							{ key: "episodes", label: "Episode", children: detail.session.episodeCount },
							{ key: "tokens", label: "tokens", children: formatTokens(detail.session.usage.total) },
							{ key: "mode", label: t("模式"), children: MODE_LABELS[detail.session.mode] },
						]}
					/>

					{strategyNotes(detail.session).map((note, index) => (
						<Alert
							key={`${note.name}-${index}`}
							type="info"
							showIcon
							className="ui-page__alert"
							title={t("策略说明 · {name}", { name: note.name })}
							description={note.instructions}
						/>
					))}
					{detail.session.strategyNote ? (
						<Alert
							type="info"
							showIcon
							className="ui-page__alert"
							title={t("补充：{note}", { note: detail.session.strategyNote })}
						/>
					) : null}
					{detail.session.intent ? <Text className="sva-intent">{detail.session.intent}</Text> : null}
					{detail.session.lastError ? (
						<Alert type="error" showIcon className="ui-page__alert" title={t("最近错误：{error}", { error: detail.session.lastError })} />
					) : null}

					<Row gutter={[16, 16]} className="sva-detail-cols">
						<Col xs={24} lg={8}>
							<div className="sva-section">
								<Text strong>
									Episode <Tag variant="filled">{detail.episodes.length}</Tag>
								</Text>
								<div className="sva-col-scroll">
									{detail.episodes.length === 0 ? (
										<Text type="secondary">{t("还没有 episode。")}</Text>
									) : (
										detail.episodes.map((episode) => <EpisodeBlock key={episode.id} episode={episode} />)
									)}
								</div>
							</div>
						</Col>
						<Col xs={24} lg={8}>
							<div className="sva-section">
								<Text strong>
									{t("建议")} <Tag variant="filled">{detail.advice.length}</Tag>
								</Text>
								<div className="sva-col-scroll">
									{detail.advice.length === 0 ? (
										<Text type="secondary">{t("这次监督没有给出建议。")}</Text>
									) : (
										detail.advice.map((advice) => (
											<div key={advice.id} className="sva-advice">
												<div className="sva-advice-head">
													<Text type="secondary" className="sva-mono">
														{timeLabel(advice.at)}
													</Text>
													<Text type="secondary">{advice.delivery === "auto" ? t("自动") : t("确认")}</Text>
													<Tag
														color={advice.status === "sent" ? "green" : advice.status === "ignored" ? "default" : "orange"}
														variant="filled"
													>
														{advice.status === "sent"
															? t("已发送")
															: advice.status === "ignored"
																? t("已忽略")
																: t("待确认")}
													</Tag>
												</div>
												<pre className="sva-advice-text">{advice.text}</pre>
											</div>
										))
									)}
								</div>
							</div>
						</Col>
						<Col xs={24} lg={8}>
							<div className="sva-section">
								<Text strong>
									{t("日志")} <Tag variant="filled">{detail.logs.length}</Tag>
								</Text>
								<div className="sva-col-scroll">
									<LogBlock logs={detail.logs} />
								</div>
							</div>
						</Col>
					</Row>
					</>}
				</Drawer>
			) : null}
		</Page>
	);
}
