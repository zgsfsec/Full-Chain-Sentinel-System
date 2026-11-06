/**
 * The vulnerability hub.
 *
 * The agent submits findings while it works; this page is where the operator
 * reads them. It is deliberately read-mostly: a record's content comes from the
 * submission and cannot be rewritten here, because the value of the hub is that
 * it shows what was claimed and what was verified, separately. What the operator
 * changes is the review outcome — status, severity, CVSS and a note — and that
 * lands in the record's timeline.
 */

import {
	CopyOutlined,
	DeleteOutlined,
	DownloadOutlined,
	FilterOutlined,
	ReloadOutlined,
	RightOutlined,
	SearchOutlined,
} from "@ant-design/icons";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import {
	Alert,
	Badge,
	Button,
	Card,
	Descriptions,
	Drawer,
	Empty,
	Input,
	Modal,
	Popover,
	Select,
	Space,
	Tag,
	Timeline,
	Tooltip,
	Typography,
} from "antd";
import type { DescriptionsProps } from "antd";
import { useEffect, useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import type {
	SentinelEngine,
	SentinelFilePreview,
	SentinelVulnEvidence,
	SentinelVulnerability,
	SentinelVulnFilters,
	SentinelVulnReview,
	SentinelVulnSeverity,
	SentinelVulnStats,
	SentinelVulnStatus,
	SentinelVulnSummary,
	SentinelVulnUpdate,
	SessionInfoView,
} from "../types.ts";
import { SENTINEL_VULN_SEVERITIES, SENTINEL_VULN_SEVERITY_LABELS, SENTINEL_VULN_STATUS_LABELS } from "../types.ts";
import { Page, Section } from "../ui/Page.tsx";
import "./vulnerability-assets.css";

const { Text } = Typography;

const SEVERITY_COLORS: Record<SentinelVulnSeverity, string> = {
	critical: "red",
	high: "volcano",
	medium: "gold",
	low: "blue",
	info: "default",
};

const STATUS_COLORS: Record<SentinelVulnStatus, string> = {
	pending: "gold",
	confirmed: "green",
	false_positive: "default",
	fixed: "blue",
};

const STATUSES: readonly SentinelVulnStatus[] = ["pending", "confirmed", "false_positive", "fixed"];

function formatVulnNumber(number: number): string {
	return String(number).padStart(4, "0");
}

function formatWhen(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const sameYear = date.getFullYear() === new Date().getFullYear();
	const datePart = sameYear
		? `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
		: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	return `${datePart} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Small state chip next to the severity: the reviewer's calibration status. */
function ReviewChip({ review }: { review?: SentinelVulnReview }) {
	if (!review || review.state === "skipped") return null;
	if (review.state === "queued") {
		return (
			<Tooltip title={t("评审 LLM 排队中")}>
				<Tag variant="filled">{t("…评")}</Tag>
			</Tooltip>
		);
	}
	if (review.state === "failed") {
		return (
			<Tooltip title={t("评审失败：{error}", { error: review.error ?? "" })}>
				<Tag color="error" variant="filled">
					{t("未评")}
				</Tag>
			</Tooltip>
		);
	}
	if (review.verdict === "dubious") {
		return (
			<Tooltip title={t("评审存疑：{reason}", { reason: review.reason ?? "" })}>
				<Tag color="warning" variant="filled">
					{t("⚠存疑")}
				</Tag>
			</Tooltip>
		);
	}
	return (
		<Tooltip title={t("已评审（{model}）：{reason}", { model: review.model ?? "", reason: review.reason ?? "" })}>
			<Tag color="success" variant="filled">
				{t("✓评")}
			</Tag>
		</Tooltip>
	);
}

function severityClass(severity: SentinelVulnSeverity): string {
	return `vuln-sev vuln-sev-${severity}`;
}

/**
 * Whether the level on the record is still the agent's own guess.
 *
 * A record the reviewer has ruled on carries a calibrated number. One whose
 * review failed — or has not come back yet — carries what the agent claimed,
 * and the console labels it 「自评」 instead of presenting it as a verdict.
 */
function isAgentRating(review?: SentinelVulnReview): boolean {
	if (!review) return false;
	return review.state === "failed" || review.state === "queued";
}

/** The severity bucket a CVSS base score maps to; used for the mismatch hint. */
function severityForScore(score: number): SentinelVulnSeverity {
	if (score >= 9) return "critical";
	if (score >= 7) return "high";
	if (score >= 4) return "medium";
	if (score > 0) return "low";
	return "info";
}

/** Copy button used by the packet and evidence blocks. */
function CopyButton({ text, label = t("复制") }: { text: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			type="text"
			size="small"
			icon={<CopyOutlined />}
			onClick={() => {
				void navigator.clipboard
					.writeText(text)
					.then(() => {
						setCopied(true);
						window.setTimeout(() => setCopied(false), 1500);
					})
					.catch(() => {});
			}}
		>
			{copied ? t("已复制") : label}
		</Button>
	);
}

function vulnSource(source: string): string {
	if (source === "主代理") return t("主代理");
	if (source === "子代理") return t("子代理来源");
	if (source.startsWith("子代理 ")) return `${t("子代理来源")} ${source.slice(4)}`;
	const task = /^工程任务「(.+)」$/.exec(source);
	if (task) return t("工程任务「{name}」", { name: task[1] ?? "" });
	return source;
}

/** The delete confirmation's content, exported so it can be rendered on its own. */
export function VulnDeleteBody({
	pending,
	preview,
}: {
	pending: string[] | null;
	preview: { count: number; evidence: number; notes: number } | null;
}) {
	return (
		<div className="vulnhub-delete">
			<Text>{t("将删除 {count} 条漏洞记录。", { count: preview?.count ?? pending?.length ?? 0 })}</Text>
			{preview ? (
				<ul>
					<li>{t("{count} 条证据", { count: preview.evidence })}</li>
					<li>{t("{count} 条复核备注", { count: preview.notes })}</li>
				</ul>
			) : (
				<Text type="secondary">{t("正在统计影响…")}</Text>
			)}
			<Text type="secondary">{t("记录里的证据引用与备注会一并删除；容器里的原文件不受影响。")}</Text>
		</div>
	);
}

export function VulnPage({
	items,
	stats,
	filters,
	projectName,
	projectId,
	engines,
	sessions,
	hasProject,
	deletePending,
	deletePreview,
	onFiltersChange,
	onOpen,
	onOpenSession,
	onExport,
	onRetryReview,
	onReviewAllPending,
	onRequestDelete,
	onConfirmDelete,
	onCancelDelete,
}: {
	items: SentinelVulnSummary[];
	stats: SentinelVulnStats;
	filters: SentinelVulnFilters;
	projectName: string | null;
	/** Active project, so the engine dropdown lists this project's engines only. */
	projectId: string | null;
	/** All engines of the project, finished ones included: findings are historical. */
	engines: SentinelEngine[];
	/** All sessions of the project, for the session dropdown. */
	sessions: SessionInfoView[];
	hasProject: boolean;
	/** Ids awaiting the delete confirmation, null when no dialog is open. */
	deletePending: string[] | null;
	/** What that deletion would take with it, once the server answered. */
	deletePreview: { count: number; evidence: number; notes: number } | null;
	onFiltersChange: (filters: SentinelVulnFilters) => void;
	onOpen: (id: string) => void;
	/** Switch to the chat page and load the session that reported a finding. */
	onOpenSession: (sessionId: string) => void;
	onExport: (filters: SentinelVulnFilters) => void;
	onRetryReview: (id: string, force: boolean) => void;
	onReviewAllPending: () => void;
	onRequestDelete: (ids: string[]) => void;
	onConfirmDelete: (ids: string[]) => void;
	onCancelDelete: () => void;
}) {
	const [search, setSearch] = useState(filters.search ?? "");
	const [target, setTarget] = useState(filters.target ?? "");
	/** The condition panel is closed by default: the chips already say what is on. */
	const [filterOpen, setFilterOpen] = useState(false);
	/** Rows selected for export or batch deletion. */
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

	// Keep the inputs in step when the page is opened fresh or filters are reset.
	useEffect(() => {
		setSearch(filters.search ?? "");
	}, [filters.search]);
	useEffect(() => {
		setTarget(filters.target ?? "");
	}, [filters.target]);
	// A refresh (another console, or the agent submitting a finding) must not drop
	// the operator's ticks, but ids that disappeared cannot stay selected: deleting
	// them would mean deleting records that are no longer visible.
	useEffect(() => {
		setSelected((prev) => {
			if (prev.size === 0) return prev;
			const visible = new Set(items.map((item) => item.id));
			const next = new Set([...prev].filter((id) => visible.has(id)));
			return next.size === prev.size ? prev : next;
		});
	}, [items]);

	const projectEngines = engines.filter((engine) => engine.projectId === projectId);
	const activeEngine = projectEngines.find((engine) => engine.id === filters.engineId);
	const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
	const selectedIds = items.filter((item) => selected.has(item.id)).map((item) => item.id);
	// Every session of the project is offered, named when it has a name and
	// identified by its first message otherwise.
	const sessionOptions = sessions.map((session) => ({
		id: session.id,
		name: session.name?.trim() || session.firstMessage.slice(0, 40) || t("未命名会话"),
	}));
	/** A record can outlive its session; the snapshot keeps the option readable. */
	const sessionLabelFor = (id: string): string =>
		items.find((item) => item.id && item.sessionId === id)?.sessionName?.trim() || t("已删除的会话");

	/**
	 * The conditions the panel can set, as removable chips. Search and 存疑 are not
	 * here on purpose: each already has a visible control of its own.
	 */
	const chips: { key: string; label: string; value: string; clear: () => void }[] = [];
	if (filters.target) {
		chips.push({
			key: "target",
			label: t("目标"),
			value: filters.target,
			clear: () => onFiltersChange({ ...filters, target: undefined }),
		});
	}
	if (filters.sessionId) {
		chips.push({
			key: "session",
			label: t("会话"),
			value: sessionLabelFor(filters.sessionId),
			clear: () => onFiltersChange({ ...filters, sessionId: undefined }),
		});
	}
	if (filters.engineId) {
		chips.push({
			key: "engine",
			label: t("工程"),
			value: activeEngine?.name ?? filters.engineId,
			// A task belongs to an engine, so dropping the engine drops its task too.
			clear: () => onFiltersChange({ ...filters, engineId: undefined, taskId: undefined }),
		});
	}
	if (filters.taskId) {
		chips.push({
			key: "task",
			label: t("任务"),
			value: activeEngine?.tasks.find((task) => task.id === filters.taskId)?.title ?? filters.taskId,
			clear: () => onFiltersChange({ ...filters, taskId: undefined }),
		});
	}
	for (const severity of filters.severity ?? []) {
		chips.push({
			key: `severity:${severity}`,
			label: t("等级"),
			value: SENTINEL_VULN_SEVERITY_LABELS[severity],
			clear: () => {
				const remaining = filters.severity?.filter((value) => value !== severity);
				onFiltersChange({ ...filters, severity: remaining?.length ? remaining : undefined });
			},
		});
	}
	if (filters.status) {
		chips.push({
			key: "status",
			label: t("状态"),
			value: SENTINEL_VULN_STATUS_LABELS[filters.status],
			clear: () => onFiltersChange({ ...filters, status: undefined }),
		});
	}

	const clearAll = (): void => {
		setSearch("");
		setTarget("");
		onFiltersChange({});
	};

	const clearSelection = (): void => setSelected(new Set());

	if (!hasProject) {
		return (
			<Page title={t("漏洞中枢")} description={t("漏洞记录按项目隔离")}>
				<Empty
					image={Empty.PRESENTED_IMAGE_SIMPLE}
					description={
						<>
							<div>{t("尚未选择项目")}</div>
							<div className="vulnhub-empty-hint">{t("请先在侧栏顶部选择或创建一个项目")}</div>
						</>
					}
				/>
			</Page>
		);
	}

	const filterPanel = (
		<div className="vulnhub-filters">
			<label className="vulnhub-filters__field">
				<span>{t("目标（主机 / URL / IP:port）")}</span>
				<Input
					size="small"
					value={target}
					placeholder={t("10.0.0.5、https://…")}
					onChange={(event) => setTarget(event.target.value)}
					onPressEnter={() => onFiltersChange({ ...filters, target: target.trim() || undefined })}
				/>
			</label>
			<label className="vulnhub-filters__field">
				<span>{t("会话（只列本项目）")}</span>
				<Select
					size="small"
					value={filters.sessionId ?? ""}
					onChange={(value) => onFiltersChange({ ...filters, sessionId: value || undefined })}
					options={[
						{ value: "", label: t("不限会话") },
						...(filters.sessionId && !sessionOptions.some((option) => option.id === filters.sessionId)
							? [{ value: filters.sessionId, label: sessionLabelFor(filters.sessionId) }]
							: []),
						...sessionOptions.map((option) => ({ value: option.id, label: option.name })),
					]}
				/>
			</label>
			<label className="vulnhub-filters__field">
				<span>{t("工程（只列本项目，含已结束）")}</span>
				<Select
					size="small"
					value={filters.engineId ?? ""}
					// The task belongs to an engine, so switching engines clears it.
					onChange={(value) =>
						onFiltersChange({ ...filters, engineId: value || undefined, taskId: undefined })
					}
					options={[
						{ value: "", label: t("不限工程") },
						...projectEngines.map((engine) => ({ value: engine.id, label: engine.name })),
					]}
				/>
			</label>
			<label className="vulnhub-filters__field">
				<span>{t("任务（先选工程）")}</span>
				<Select
					size="small"
					value={filters.taskId ?? ""}
					disabled={!filters.engineId}
					onChange={(value) => onFiltersChange({ ...filters, taskId: value || undefined })}
					options={[
						{ value: "", label: filters.engineId ? t("不限任务") : t("先选工程") },
						...(activeEngine?.tasks ?? []).map((task) => ({ value: task.id, label: task.title })),
					]}
				/>
			</label>
			<label className="vulnhub-filters__field">
				<span>{t("等级")}</span>
				<Select
					size="small"
					mode="multiple"
					allowClear
					maxTagCount="responsive"
					aria-label={t("等级")}
					placeholder={t("全部等级")}
					value={filters.severity ?? []}
					onChange={(value: SentinelVulnSeverity[]) =>
						onFiltersChange({ ...filters, severity: value.length ? value : undefined })
					}
					options={SENTINEL_VULN_SEVERITIES.map((severity) => ({
						value: severity,
						label: SENTINEL_VULN_SEVERITY_LABELS[severity],
					}))}
				/>
			</label>
			<label className="vulnhub-filters__field">
				<span>{t("状态")}</span>
				<Select
					size="small"
					value={filters.status ?? ""}
					onChange={(value) =>
						onFiltersChange({ ...filters, status: (value || undefined) as SentinelVulnStatus | undefined })
					}
					options={[
						{ value: "", label: t("全部状态") },
						...STATUSES.map((status) => ({ value: status, label: SENTINEL_VULN_STATUS_LABELS[status] })),
					]}
				/>
			</label>
			<div className="vulnhub-filters__foot">
				<Button size="small" onClick={clearAll}>
					{t("清空全部")}
				</Button>
				<Button size="small" type="primary" onClick={() => setFilterOpen(false)}>
					{t("完成")}
				</Button>
			</div>
		</div>
	);

	const columns: ProColumns<SentinelVulnSummary>[] = [
		{
			title: t("编号"),
			dataIndex: "number",
			key: "number",
			width: 96,
			render: (_, item) => <Text className="table-mono">{formatVulnNumber(item.number)}</Text>,
		},
		{
			title: t("标题"),
			dataIndex: "title",
			key: "title",
			width: 280,
			ellipsis: { showTitle: true },
		},
		{
			title: t("目标"),
			dataIndex: "target",
			key: "target",
			width: 220,
			ellipsis: true,
			render: (_, item) => (
				<Text className="table-mono" title={item.target}>
					{item.target}
				</Text>
			),
		},
		{
			title: t("关联资产"),
			dataIndex: "assetLabel",
			key: "asset",
			width: 180,
			render: (_, item) =>
				item.assetLabel ? (
					<Tag className="vulnhub-asset-label" variant="filled">{item.assetLabel}</Tag>
				) : (
					<Text type="secondary">—</Text>
				),
		},
		{
			title: t("等级"),
			dataIndex: "severity",
			key: "severity",
			width: 124,
			render: (_, item) => (
				<Space size={4} className="vulnhub-severity">
					<Tag color={SEVERITY_COLORS[item.severity]} variant="filled">
						{SENTINEL_VULN_SEVERITY_LABELS[item.severity]}
					</Tag>
					<Text type="secondary" className="vulnhub-cvss" title={isAgentRating(item.review) ? t("Agent 自评") : undefined}>
						{isAgentRating(item.review) ? `${t("自评")} ` : ""}
						{item.cvss.toFixed(1)}
					</Text>
					{item.severityMismatch ? (
						<Tooltip title={t("等级与 CVSS 分数不一致")}>
							<Text type="warning" className="vulnhub-mismatch">
								!
							</Text>
						</Tooltip>
					) : null}
				</Space>
			),
		},
		{
			title: t("状态"),
			dataIndex: "status",
			key: "status",
			width: 132,
			render: (_, item) => (
				<Space size={4} className="vulnhub-status">
					<Tag color={STATUS_COLORS[item.status]} variant="filled">
						{SENTINEL_VULN_STATUS_LABELS[item.status]}
					</Tag>
					<ReviewChip review={item.review} />
				</Space>
			),
		},
		{
			title: t("来源"),
			dataIndex: "source",
			key: "source",
			width: 120,
			ellipsis: { showTitle: true },
			render: (_, item) => <Text type="secondary">{vulnSource(item.source)}</Text>,
		},
		{
			title: t("提交时间"),
			dataIndex: "createdAt",
			key: "createdAt",
			width: 100,
			render: (_, item) => <Text type="secondary">{formatWhen(item.createdAt)}</Text>,
		},
		{
			title: t("操作"),
			key: "actions",
			width: 76,
			render: (_, item) => {
				const hasSession = Boolean(item.sessionId && sessions.some((session) => session.id === item.sessionId));
				const reason = item.sessionId
					? hasSession
						? t("打开对应对话")
						: t("对应会话已删除")
					: t("该漏洞没有关联会话");
				return (
					<Space size={0}>
						<Tooltip title={reason}>
							<Button
								type="text"
								size="small"
								icon={<RightOutlined />}
								disabled={!hasSession}
								aria-label={reason}
								onClick={(event) => {
									event.stopPropagation();
									if (item.sessionId) onOpenSession(item.sessionId);
								}}
							/>
						</Tooltip>
						<Button
							type="link"
							size="small"
							onClick={(event) => {
								event.stopPropagation();
								onOpen(item.id);
							}}
						>
							{t("查看")}
						</Button>
					</Space>
				);
			},
		},
	];

	return (
		<Page
			title={t("漏洞中枢")}
			description={
				<>
					{projectName ? `${projectName} · ` : ""}
					{t("{total} 条 · 待确认 {pending}", { total: stats.total, pending: stats.byStatus.pending })}
				</>
			}
			extra={
				<Space wrap>
					<Button
						icon={<ReloadOutlined />}
						disabled={stats.byStatus.pending === 0}
						title={t(
							"把本项目所有「待确认」记录重新交给评审 LLM：按 CVSS 3.1 指标重算等级与分数（会覆盖这些记录现有的等级，时间线里会记录）",
						)}
						onClick={onReviewAllPending}
					>
						{t("重新评审待确认")}
					</Button>
					<Button
						type="primary"
						icon={<DownloadOutlined />}
						onClick={() => onExport(selectedIds.length > 0 ? { ...filters, ids: selectedIds } : filters)}
					>
						{selectedIds.length > 0
							? `${getLanguage() === "en" ? "Export selected" : "导出选中"} (${selectedIds.length})`
							: t("导出 Markdown")}
					</Button>
				</Space>
			}
		>
			<div className="vulnhub-stats">
				{SENTINEL_VULN_SEVERITIES.map((severity) => (
					<Tag key={severity} color={SEVERITY_COLORS[severity]} variant="filled">
						{SENTINEL_VULN_SEVERITY_LABELS[severity]} {stats.bySeverity[severity]}
					</Tag>
				))}
				<Text type="secondary" className="vulnhub-status-counts">
					{t("待确认 {count}", { count: stats.byStatus.pending })} ·{" "}
					{t("已确认 {count}", { count: stats.byStatus.confirmed })} ·{" "}
					{t("误报 {count}", { count: stats.byStatus.false_positive })} ·{" "}
					{t("已修复 {count}", { count: stats.byStatus.fixed })}
				</Text>
			</div>

			{selectedIds.length > 0 ? (
				<Alert
					type="info"
					showIcon
					className="ui-page__alert"
					title={t("已选择 {count} 条", { count: selectedIds.length })}
					action={
						<Space size={8}>
							<Button size="small" onClick={clearSelection}>
								{t("取消选择")}
							</Button>
							<Button
								size="small"
								danger
								icon={<DeleteOutlined />}
								onClick={() => onRequestDelete(selectedIds)}
							>
								{t("删除选中")}
							</Button>
						</Space>
					}
				/>
			) : null}

			<ProTable<SentinelVulnSummary>
				className="vulnhub-table"
				rowKey="id"
				size="small"
				columns={columns}
				dataSource={items}
				search={false}
				options={false}
				pagination={false}
				scroll={{ x: 1372 }}
				rowSelection={{
					selectedRowKeys: selectedIds,
					onChange: (keys) => setSelected(new Set(keys as string[])),
					columnWidth: 44,
				}}
				toolbar={{
					title: (
						<div className="vulnhub-toolbar">
							<Input
								allowClear
								className="vulnhub-toolbar__search"
								prefix={<SearchOutlined />}
								value={search}
								placeholder={t("搜索编号 / 标题 / 类型 / 描述 / 来源")}
								onChange={(event) => setSearch(event.target.value)}
								onPressEnter={() =>
									onFiltersChange({ ...filters, search: search.trim() || undefined })
								}
							/>
							<Popover
								open={filterOpen}
								onOpenChange={setFilterOpen}
								trigger="click"
								placement="bottomLeft"
								content={filterPanel}
							>
								<Badge count={chips.length} size="small">
									<Button icon={<FilterOutlined />} title={t("目标、会话、工程、任务、等级与状态都在这里设置")}>
										{t("筛选")}
									</Button>
								</Badge>
							</Popover>
							<Button
								type={filters.dubious ? "primary" : "default"}
								title={t("只看评审 LLM 标记为「存疑」的记录：证据不足以支撑结论")}
								onClick={() => onFiltersChange({ ...filters, dubious: filters.dubious ? undefined : true })}
							>
								{t("⚠ 存疑")}
							</Button>
							<Button
								type="link"
								disabled={items.length === 0}
								title={t("选中当前筛选结果里的全部记录")}
								onClick={() =>
									setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))
								}
							>
								{allSelected ? t("取消全选") : t("全选筛选结果")}
							</Button>
							{chips.map((chip) => (
								<Tag key={chip.key} closable onClose={chip.clear} className="vulnhub-chip">
									{chip.label}：{chip.value}
								</Tag>
							))}
						</div>
					),
				}}
				onRow={(record) => ({
					onClick: (event) => {
						const target = event.target as HTMLElement;
						if (target.closest("button, a, .ant-checkbox-wrapper, .ant-table-selection-column")) return;
						onOpen(record.id);
					},
					style: { cursor: "pointer" },
				})}
				locale={{
					emptyText: (
						<Empty
							image={Empty.PRESENTED_IMAGE_SIMPLE}
							description={
								<>
									<div>{stats.total === 0 ? t("还没有漏洞记录") : t("没有符合条件的记录")}</div>
									<div className="vulnhub-empty-hint">
										{stats.total === 0
											? t(
													"代理用 vuln_submit 提交漏洞后会出现在这里（需要「设置 → 权限」中开启 vuln_submit）",
												)
											: t("调整搜索或筛选条件")}
									</div>
								</>
							}
						/>
					),
				}}
			/>

			<div className="vulnhub-hints">
				<Text type="secondary">
					{t("代理提交的漏洞一律先记为「待确认」；确认、改级、标误报都在详情里完成，改动会记入时间线。")}
				</Text>
				<Text type="secondary">
					{t("勾选记录后仅导出选中项；未勾选时导出当前筛选结果。")}
					{t("导出只包含当前项目的记录与当前筛选条件。删除只能通过勾选记录进行：删除后证据与备注一并消失，不可恢复。")}
				</Text>
			</div>

			<Modal
				open={deletePending !== null}
				getContainer={false}
				forceRender
				title={t("删除漏洞记录")}
				okText={t("确认删除")}
				cancelText={t("取消")}
				okButtonProps={{ danger: true, disabled: deletePreview === null }}
				onOk={() => {
					if (deletePending) onConfirmDelete(deletePending);
				}}
				onCancel={onCancelDelete}
				destroyOnHidden
			>
				<VulnDeleteBody pending={deletePending} preview={deletePreview} />
			</Modal>
		</Page>
	);
}

/** One evidence entry: a command with its output, or a previewable container file. */
function EvidenceBlock({
	item,
	index,
	preview,
	onPreview,
}: {
	item: SentinelVulnEvidence;
	index: number;
	preview: SentinelFilePreview | null;
	onPreview: (path: string) => void;
}) {
	return (
		<Card
			size="small"
			className="vulnhub-evidence"
			title={
				<Space size={8}>
					<Tag variant="filled">{index + 1}</Tag>
					<span>{item.note ?? (item.kind === "file" ? t("容器文件") : t("命令证据"))}</span>
				</Space>
			}
			extra={
				<Space size={4}>
					{item.command ? <CopyButton text={item.command} label={t("复制命令")} /> : null}
					{item.output ? <CopyButton text={item.output} label={t("复制输出")} /> : null}
				</Space>
			}
		>
			{item.command ? <pre className="vulnhub-pre">{item.command}</pre> : null}
			{item.output ? <pre className="vulnhub-pre">{item.output}</pre> : null}
			{item.path ? (
				<Space size={8} className="vulnhub-evidence__file">
					<Text code>{item.path}</Text>
					<Button size="small" onClick={() => onPreview(item.path as string)}>
						{t("预览")}
					</Button>
				</Space>
			) : null}
			{preview && item.path && preview.path === item.path ? (
				<div className="vulnhub-preview">
					{preview.kind === "image" && preview.data ? (
						<img src={`data:${preview.mimeType ?? "image/png"};base64,${preview.data}`} alt={item.path} />
					) : preview.kind === "text" ? (
						<pre className="vulnhub-pre">
							{preview.text}
							{preview.truncated ? `\n${t("…（已截断）")}` : ""}
						</pre>
					) : (
						<Text type="secondary">
							{t("二进制文件（{size} 字节），请在「文件」弹窗中下载查看", { size: preview.size })}
						</Text>
					)}
				</div>
			) : null}
		</Card>
	);
}

export function VulnDetailBody({
	vuln,
	preview,
	provenance,
	onClose,
	onUpdate,
	onPreview,
	onRetryReview,
	onOpenAsset,
}: {
	vuln: SentinelVulnerability;
	/** Preview of a file referenced by this record's evidence, when one was requested. */
	preview: SentinelFilePreview | null;
	/** Human names for the stored 工程/任务/会话 ids, when they can still be resolved. */
	provenance: { engine?: string; task?: string; session?: string };
	onClose: () => void;
	onUpdate: (id: string, patch: SentinelVulnUpdate) => void;
	onPreview: (path: string) => void;
	onRetryReview: (id: string, force: boolean) => void;
	onOpenAsset: (id: string) => void;
}) {
	const [severity, setSeverity] = useState<SentinelVulnSeverity>(vuln.severity);
	const [cvss, setCvss] = useState(String(vuln.cvss));
	const [note, setNote] = useState("");
	/** When the last immediate save landed, shown as a quiet confirmation. */
	const [savedAt, setSavedAt] = useState<Date | null>(null);

	// A refreshed record (after an immediate save, or a submission from another
	// console) re-seeds the editors; keeping stale edits would fight the record.
	useEffect(() => {
		setSeverity(vuln.severity);
		setCvss(String(vuln.cvss));
		setNote("");
	}, [vuln.id, vuln.severity, vuln.cvss, vuln.updatedAt]);

	const parsedCvss = Number(cvss);
	const cvssValid = cvss.trim() !== "" && Number.isFinite(parsedCvss) && parsedCvss >= 0 && parsedCvss <= 10;

	// Every action below saves immediately: the server records one timeline
	// entry per change, so piecemeal updates make a readable audit trail
	// instead of one merged blob.
	const apply = (patch: SentinelVulnUpdate) => {
		onUpdate(vuln.id, patch);
		setSavedAt(new Date());
	};

	const transition = (next: SentinelVulnStatus) => {
		if (next === vuln.status) return;
		apply({ status: next });
	};

	/** Severity/CVSS commit on blur (Enter in the CVSS field commits too). */
	const commitRating = () => {
		if (!cvssValid) return;
		if (severity !== vuln.severity) apply({ severity });
		if (parsedCvss !== vuln.cvss) apply({ cvss: parsedCvss });
	};

	const submitNote = () => {
		const text = note.trim();
		if (!text) return;
		apply({ note: text });
	};

	const retryButton =
		vuln.review.state === "failed" ? (
			<Button size="small" onClick={() => onRetryReview(vuln.id, false)}>
				{t("重试评审")}
			</Button>
		) : vuln.review.state === "queued" ? (
			<Button size="small" disabled>
				{t("评审中…")}
			</Button>
		) : (
			<Button
				size="small"
				title={t(
					"按 CVSS 3.1 指标重新计算等级与分数。这条如果已被手动改过等级（或状态），也会一并覆盖，时间线里会记录",
				)}
				onClick={() => onRetryReview(vuln.id, true)}
			>
				{t("重新评审")}
			</Button>
		);

	const metaItems: DescriptionsProps["items"] = [
		{ key: "label", label: t("编号"), children: <Text code>{formatVulnNumber(vuln.number)}</Text> },
		{ key: "target", label: t("目标"), children: <Text code>{vuln.target}</Text> },
		...(vuln.assetId
			? [
					{
						key: "asset",
						label: t("关联资产"),
						children: (
							<Button className="vulnhub-asset-link" type="link" size="small" onClick={() => onOpenAsset(vuln.assetId as string)}>
								{vuln.assetLabel ?? vuln.assetId}
							</Button>
						),
					},
				]
			: []),
		{ key: "category", label: t("类型"), children: vuln.category ?? "—" },
		{ key: "source", label: t("来源"), children: vulnSource(vuln.source) },
		{ key: "created", label: t("提交时间"), children: formatWhen(vuln.createdAt) },
		...(vuln.engineId || vuln.taskId
			? [
					{
						key: "engine",
						label: t("工程 / 任务"),
						children: `${provenance.engine ?? vuln.engineId ?? ""}${provenance.task ? ` / ${provenance.task}` : ""}`,
					},
				]
			: []),
		...(vuln.sessionId
			? [
					{
						key: "session",
						label: t("会话"),
						children: provenance.session ?? vuln.sessionName ?? vuln.sessionId,
					},
				]
			: []),
		{
			key: "review",
			label: t("评审"),
			children: (
				<Space size={6} wrap>
					<ReviewChip review={vuln.review} />
					{vuln.review.state === "done" && vuln.review.model ? (
						<Text type="secondary">{vuln.review.model}</Text>
					) : null}
					{vuln.review.at ? (
						<Text type="secondary">{new Date(vuln.review.at).toLocaleString("zh-CN", { hour12: false })}</Text>
					) : null}
					{retryButton}
				</Space>
			),
		},
		...(vuln.review.state === "done" && vuln.review.reason
			? [
					{
						key: "reason",
						label: t("评审意见"),
						span: 2,
						children: (
							<Text>
								{vuln.review.verdict === "dubious" ? t("⚠ 存疑：") : ""}
								{vuln.review.reason}
							</Text>
						),
					},
				]
			: []),
		...(vuln.review.state === "failed"
			? [
					{
						key: "review-error",
						label: t("评审失败原因"),
						span: 2,
						children: <Text type="danger">{vuln.review.error ?? t("未知错误")}</Text>,
					},
				]
			: []),
	];

	return (
		<div className="vulnhub-detail">
			<div className="vulnhub-detail__title">
					<span className="vulnhub-detail__name">{vuln.title}</span>
					<Space size={6} wrap className="vulnhub-detail__meta">
						<Tag color={SEVERITY_COLORS[vuln.severity]} variant="filled">
							{SENTINEL_VULN_SEVERITY_LABELS[vuln.severity]}
						</Tag>
						<Text type="secondary">
							{isAgentRating(vuln.review) ? `${t("自评")} CVSS ` : "CVSS "}
							{vuln.cvss.toFixed(1)}
						</Text>
						{vuln.cvssVector ? <Text code>{vuln.cvssVector}</Text> : null}
						<Tag color={STATUS_COLORS[vuln.status]} variant="filled">
							{SENTINEL_VULN_STATUS_LABELS[vuln.status]}
						</Tag>
						{vuln.review?.verdict === "dubious" ? (
							<Tag color="warning" variant="filled">
								{t("评审存疑")}
							</Tag>
						) : null}
						{vuln.severityMismatch ? (
							<Tag color="warning" variant="filled">
								{t("等级与分数不一致")}
							</Tag>
						) : null}
				</Space>
			</div>
			<Descriptions size="small" column={{ xs: 1, sm: 2 }} bordered items={metaItems} className="vulnhub-detail__desc" />

			<div className="vulnhub-actions">
				<Space size={8} wrap>
					{vuln.status === "pending" ? (
						<>
							<Button type="primary" onClick={() => transition("confirmed")}>
								{t("✓ 确认")}
							</Button>
							<Button danger onClick={() => transition("false_positive")}>
								{t("✕ 标误报")}
							</Button>
						</>
					) : null}
					{vuln.status !== "fixed" ? <Button onClick={() => transition("fixed")}>{t("✔ 标已修复")}</Button> : null}
					{vuln.status !== "pending" ? (
						<Button onClick={() => transition("pending")}>{t("↩ 退回待确认")}</Button>
					) : null}
				</Space>
				{savedAt ? (
					<Text type="secondary" className="vulnhub-saved">
						{t("已保存 {time}", { time: savedAt.toLocaleTimeString("zh-CN", { hour12: false }) })}
					</Text>
				) : null}
			</div>

			<div className="vulnhub-rating">
				<Text type="secondary">{t("等级")}</Text>
				<Select
					size="small"
					value={severity}
					onChange={(value) => setSeverity(value as SentinelVulnSeverity)}
					onBlur={commitRating}
					style={{ width: 112 }}
					options={SENTINEL_VULN_SEVERITIES.map((candidate) => ({
						value: candidate,
						label: SENTINEL_VULN_SEVERITY_LABELS[candidate],
					}))}
				/>
				<Text type="secondary">CVSS</Text>
				<Input
					size="small"
					className="vulnhub-cvss-input"
					aria-label="CVSS"
					status={cvssValid ? undefined : "error"}
					value={cvss}
					spellCheck={false}
					onChange={(event) => setCvss(event.target.value)}
					onBlur={commitRating}
					onPressEnter={commitRating}
				/>
				{!cvssValid ? <Text type="danger">{t("CVSS 需要 0.0-10.0")}</Text> : null}
				{cvssValid && severityForScore(parsedCvss) !== severity ? (
					<Text type="warning">
						{t("分数对应「{severity}」，与所选等级不一致", {
							severity: SENTINEL_VULN_SEVERITY_LABELS[severityForScore(parsedCvss)],
						})}
					</Text>
				) : null}
			</div>

			<Input
				className="vulnhub-note"
				value={note}
				placeholder={t("复核备注（回车提交，追加到时间线）…")}
				spellCheck={false}
				onChange={(event) => setNote(event.target.value)}
				onPressEnter={submitNote}
			/>

			<Section title={t("漏洞详情")}>
				<pre className="vulnhub-pre">{vuln.description}</pre>
			</Section>

			<Section
				title={t("原始数据包")}
				extra={<CopyButton text={vuln.packet} label={t("复制数据包")} />}
			>
				<pre className="vulnhub-pre">{vuln.packet}</pre>
			</Section>

			{vuln.repro ? (
				<Section title={t("复现步骤")}>
					<pre className="vulnhub-pre">{vuln.repro}</pre>
				</Section>
			) : null}

			{vuln.evidence.length > 0 ? (
				<Section title={t("证据")}>
					<div className="vulnhub-evidence-list">
						{vuln.evidence.map((item, index) => (
							<EvidenceBlock
								key={`${item.kind}-${item.path ?? item.command ?? index}`}
								item={item}
								index={index}
								preview={preview}
								onPreview={onPreview}
							/>
						))}
					</div>
				</Section>
			) : null}

			{vuln.remediation ? (
				<Section title={t("修复建议")}>
					<pre className="vulnhub-pre">{vuln.remediation}</pre>
				</Section>
			) : null}

			{vuln.references && vuln.references.length > 0 ? (
				<Section title={t("参考")}>
					<ul className="vulnhub-refs">
						{vuln.references.map((reference) => (
							<li key={reference}>{reference}</li>
						))}
					</ul>
				</Section>
			) : null}

			<Section title={t("处理时间线")}>
				<Timeline
					items={vuln.notes.map((entry, index) => ({
						key: `${entry.at}-${index}`,
						children: (
							<div className="vulnhub-timeline__row">
								<Text type="secondary" className="vulnhub-timeline__at">
									{formatWhen(entry.at)}
								</Text>
								<Text strong>{entry.author}</Text>
								<Text>{entry.text}</Text>
							</div>
						),
					}))}
				/>
			</Section>
		</div>
	);
}

/** The detail surface: the same content inside the drawer the page opens. */
export function VulnDetail(props: Parameters<typeof VulnDetailBody>[0]) {
	return (
		<Drawer open width={780} onClose={props.onClose} destroyOnHidden className="vulnhub-drawer">
			<VulnDetailBody {...props} />
		</Drawer>
	);
}
