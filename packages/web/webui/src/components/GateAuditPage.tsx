/**
 * 审批：AI 审批判定流水 + 自动审批工具调用流水，只读。
 *
 * Two tabs, one table. 「AI 审批」 is what the gatekeeper judged; 「自动审批」
 * is every tool call nobody judged. Together they cover each call exactly once —
 * a call is written by the judge or by `recordUnjudged`, never by both — so the
 * two tabs are a split of one trail, not two logs to reconcile.
 *
 * The tabs are not local state: they are a view of `filter.approval`, which is
 * the same field the tab switch writes. That keeps the pagination at the bottom
 * honest — it re-queries with the same filter instead of losing the split.
 */

import { DownloadOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { Alert, Button, Drawer, Empty, Input, Select, Space, Tabs, Tag, Typography } from "antd";
import { useMemo, useState } from "react";
import { downloadGateAudit } from "../gate-audit-export.ts";
import { getLanguage, t } from "../i18n.ts";
import type {
	SentinelGateApproval,
	SentinelGateDecision,
	SentinelGateFilter,
	SentinelGateStats,
	SentinelGateTab,
	SentinelProjectInfo,
	SessionInfoView,
} from "../types.ts";
import { SENTINEL_GATE_APPROVAL_LABELS, SENTINEL_GATE_DECISION_LABELS, SENTINEL_GATE_TAB_BUCKETS } from "../types.ts";
import { Page } from "../ui/Page.tsx";
import { MetricStrip, type MetricItem } from "../ui/MetricStrip.tsx";

const { Text } = Typography;

const PAGE_SIZE = 50;

/** How many sessions the 会话 filter offers; the rest are found by id. */
const MAX_SESSION_OPTIONS = 60;

/** Time windows the since-filter offers; 0 means "everything". */
const WINDOWS: Array<{ label: string; ms: number }> = [
	{ label: t("全部时间"), ms: 0 },
	{ label: t("最近 1 小时"), ms: 60 * 60 * 1000 },
	{ label: t("最近 24 小时"), ms: 24 * 60 * 60 * 1000 },
	{ label: t("最近 7 天"), ms: 7 * 24 * 60 * 60 * 1000 },
];

const DECISION_COLORS: Record<string, string> = {
	allow: "green",
	block: "red",
	failed: "orange",
};

/** Row form: date plus clock, without the year. */
function formatClock(at: number): string {
	return new Date(at).toLocaleString(getLanguage() === "zh" ? "zh-CN" : "en-US", {
		hour12: false,
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/** Short form for the stat tiles, where the year is noise. */
function formatShort(at: number): string {
	return new Date(at).toLocaleString(getLanguage() === "zh" ? "zh-CN" : "en-US", {
		hour12: false,
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatLatency(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	return `${(ms / 1000).toFixed(1)} s`;
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

/**
 * `mcp__<server>__<tool>` → `<tool>`. The server is what tells plugin tools from
 * custom MCP servers, so it stays in the tooltip and in the expanded row.
 */
function toolLabel(tool: string): string {
	if (!tool.startsWith("mcp__")) return tool;
	const rest = tool.slice("mcp__".length);
	const end = rest.indexOf("__");
	return end > 0 ? rest.slice(end + 2) : rest;
}

/** What the 会话 filter shows for one session: its name, else its first line. */
function sessionTitle(session: SessionInfoView): string {
	const name = session.name?.trim() || session.firstMessage?.trim() || session.id;
	return name.length > 48 ? `${name.slice(0, 48)}…` : name;
}

/** The one filter state the page owns; the query itself is sent by App. */
export function GateAuditPage({
	items,
	stats,
	tabCounts,
	total,
	page,
	filter,
	projects,
	sessions,
	onQuery,
	onRefresh,
	onOpenSession,
	sessionPathOf,
}: {
	items: SentinelGateDecision[];
	stats: SentinelGateStats | null;
	/** Rows per approval bucket under every filter but the tab's own. */
	tabCounts: Record<SentinelGateApproval, number> | null;
	total: number;
	page: number;
	filter: SentinelGateFilter;
	projects: SentinelProjectInfo[];
	/** Known conversations, newest first, for the 会话 filter. */
	sessions: SessionInfoView[];
	onQuery: (filter: SentinelGateFilter, page: number) => void;
	onRefresh: () => void;
	onOpenSession: (path: string) => void;
	/** Resolve a judgment's session id to a conversation file, when it is known. */
	sessionPathOf: (sessionId: string) => string | null;
}) {
	const [search, setSearch] = useState(filter.search ?? "");
	const [windowIndex, setWindowIndex] = useState(0);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [exporting, setExporting] = useState(false);
	const [exportError, setExportError] = useState<string | null>(null);
	const detailItem = items.find((item) => item.id === expanded) ?? null;

	/**
	 * Which tab the filter selects. An absent or empty list reads as the first
	 * tab rather than the second: a link that opens the page without an approval
	 * field should land on 「AI 审批」, which is what this page has always shown.
	 */
	const tab: SentinelGateTab =
		filter.approval && filter.approval.length > 0 && !filter.approval.includes("ai") ? "auto" : "ai";

	const apply = (patch: Partial<SentinelGateFilter>, nextPage = 1) => {
		onQuery({ ...filter, ...patch }, nextPage);
	};

	const exportRecords = async () => {
		if (exporting) return;
		setExporting(true);
		setExportError(null);
		try {
			await downloadGateAudit(filter);
		} catch (error) {
			setExportError(error instanceof Error ? error.message : String(error));
		} finally {
			setExporting(false);
		}
	};

	// The verdict filter means different things on the two tabs: `failed` only
	// exists where a judge ran, and 人工拦截 is a 判定 value on this tab. Dropping
	// it on the way over keeps a filter from silently emptying the other tab.
	const applyTab = (next: SentinelGateTab) => {
		onQuery({ ...filter, decision: undefined, approval: SENTINEL_GATE_TAB_BUCKETS[next] }, 1);
	};

	const applyWindow = (index: number) => {
		setWindowIndex(index);
		const entry = WINDOWS[index];
		apply({ since: entry && entry.ms > 0 ? Date.now() - entry.ms : undefined });
	};

	// Session id → what to call it, so the row and the filter agree on a name.
	const titles = useMemo(() => new Map(sessions.map((session) => [session.id, sessionTitle(session)])), [sessions]);
	const sessionOptions = useMemo(
		() => [...sessions].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified)).slice(0, MAX_SESSION_OPTIONS),
		[sessions],
	);

	/**
	 * Whether anything other than the tab itself narrows the list. An empty page
	 * with no other filter is a bucket that has never been written to, which is
	 * a different sentence from a filter that matched nothing.
	 */
	const filtersBeyondTab = Boolean(
		filter.projectId || filter.sessionId || filter.source || filter.search || filter.since || filter.decision,
	);

	const aiCount = tabCounts?.ai ?? stats?.byApproval.ai ?? 0;
	const autoCount =
		(tabCounts?.auto ?? stats?.byApproval.auto ?? 0) + (tabCounts?.human ?? stats?.byApproval.human ?? 0);

	const columns: ProColumns<SentinelGateDecision>[] = [
		{
			title: t("时间"),
			dataIndex: "at",
			key: "at",
			width: 150,
			render: (_, item) => <Text type="secondary">{formatClock(item.at)}</Text>,
		},
		{
			title: tab === "ai" ? t("判定") : t("方式"),
			key: "decision",
			width: 108,
			render: (_, item) =>
				tab === "ai" ? (
					<Tag color={DECISION_COLORS[item.decision]} variant="filled">
						{SENTINEL_GATE_DECISION_LABELS[item.decision]}
					</Tag>
				) : (
					<Tag color={item.decision === "block" ? "red" : "green"} variant="filled">
						{item.decision === "block" ? t("人工拦截") : SENTINEL_GATE_APPROVAL_LABELS[item.approval]}
					</Tag>
				),
		},
		{
			title: t("调用"),
			dataIndex: "command",
			key: "command",
			ellipsis: { showTitle: true },
			render: (_, item) => (
				<div className="gatehub-call">
					{item.tool !== "bash" ? (
						<Tag variant="filled" title={item.tool}>
							{toolLabel(item.tool)}
						</Tag>
					) : null}
					<Text className="table-mono gatehub-command" title={item.command}>
						{item.command.split("\n")[0]}
					</Text>
				</div>
			),
		},
		{
			title: t("来源"),
			dataIndex: "source",
			key: "source",
			width: 200,
			ellipsis: true,
			render: (_, item) => {
				const sessionPath = item.sessionId ? sessionPathOf(item.sessionId) : null;
				return (
					<Space size={6} className="gatehub-source">
						<Text type="secondary" title={item.source}>
							{item.source}
						</Text>
						{sessionPath ? (
							<Button
								type="link"
								size="small"
								title={t("打开这次调用所在的会话")}
								onClick={(event) => {
									event.stopPropagation();
									onOpenSession(sessionPath);
								}}
							>
								{t("会话")}
							</Button>
						) : null}
					</Space>
				);
			},
		},
		...(tab === "ai"
			? [
					{
						title: t("模型"),
						key: "model",
						width: 170,
						ellipsis: { showTitle: true },
						render: (_: unknown, item: SentinelGateDecision) => (
							<div className="gatehub-model">
								<Text type="secondary">{item.model ?? "-"}</Text>
								{item.modelFrom ? <Text type="secondary">{item.modelFrom}</Text> : null}
							</div>
						),
					},
					{
						title: t("耗时"),
						key: "latency",
						width: 96,
						render: (_: unknown, item: SentinelGateDecision) => (
							<Text type="secondary">{formatLatency(item.latencyMs)}</Text>
						),
					},
				]
			: [
					{
						title: t("会话"),
						key: "session",
						width: 220,
						ellipsis: { showTitle: true },
						render: (_: unknown, item: SentinelGateDecision) =>
							item.sessionId ? (
								<Text type="secondary">
									{titles.get(item.sessionId) ?? item.sessionId.slice(0, 8)}
								</Text>
							) : (
								<Text type="secondary">-</Text>
							),
					},
				]),
	];

	const statItems: MetricItem[] =
		tab === "ai"
			? [
					{ label: t("拦截"), value: stats?.byDecision.block ?? 0 },
					{ label: t("放行"), value: stats?.byDecision.allow ?? 0 },
					{
						label: t("失败"),
						value: stats?.byDecision.failed ?? 0,
						tone: (stats?.byDecision.failed ?? 0) > 0 ? "danger" : undefined,
					},
					{ label: t("拦截率"), value: stats ? percent(stats.blockRate) : "-" },
					{ label: t("平均耗时"), value: stats ? formatLatency(stats.avgLatencyMs) : "-" },
					{ label: t("24 小时"), value: stats?.last24h ?? 0 },
					{ label: "tokens", value: stats ? stats.totalTokens.toLocaleString("en-US") : 0 },
					{ label: t("最近成功"), value: stats?.lastSuccessAt ? formatShort(stats.lastSuccessAt) : t("从未") },
				]
			: [
					{ label: t("自动放行"), value: stats?.byApproval.auto ?? 0 },
					{ label: t("人工放行"), value: stats?.byApproval.human ?? 0 },
					{
						label: t("人工拦截"),
						value: stats?.byDecision.block ?? 0,
						tone: (stats?.byDecision.block ?? 0) > 0 ? "danger" : undefined,
					},
					{ label: t("24 小时"), value: stats?.last24h ?? 0 },
				];

	return (
		<Page
			title={t("审批")}
			description={
				<>
					{tab === "ai" ? t("AI 审批判定流水") : t("自动审批工具调用流水")}
					{t(" · 只读 · 永久保留")}
					{stats ? t(" · 共 {count} 条", { count: stats.total }) : ""}
				</>
			}
			extra={
				<Space>
					<Button
						icon={<DownloadOutlined />}
						loading={exporting}
						disabled={total === 0}
						onClick={() => void exportRecords()}
						title={getLanguage() === "en"
							? "Export all records matching the current tab and filters as CSV"
							: "导出当前标签及筛选条件下的全部记录（CSV）"}
					>
						{getLanguage() === "en" ? "Export CSV" : "一键导出"}
					</Button>
					<Button icon={<ReloadOutlined />} onClick={onRefresh}>
						{t("刷新")}
					</Button>
				</Space>
			}
		>
			<Tabs
				activeKey={tab}
				onChange={(key) => applyTab(key as SentinelGateTab)}
				items={[
					{
						key: "ai",
						label: (
							<Space size={6}>
								{t("AI 审批")}
								<Tag variant="filled">{aiCount}</Tag>
							</Space>
						),
					},
					{
						key: "auto",
						label: (
							<Space size={6}>
								{t("自动审批")}
								<Tag variant="filled">{autoCount}</Tag>
							</Space>
						),
					},
				]}
			/>

			<MetricStrip items={statItems} note={tab === "auto" ? t("这些调用不经过判定，只留痕") : undefined} />

			{exportError ? (
				<Alert type="error" showIcon className="ui-page__alert" title={exportError} closable onClose={() => setExportError(null)} />
			) : null}

			{stats?.lastError ? (
				<Alert
					type="error"
					showIcon
					className="ui-page__alert"
					title={t("最近一次判定失败：{error}", { error: stats.lastError })}
				/>
			) : null}

			<ProTable<SentinelGateDecision>
				rowKey="id"
				size="small"
				columns={columns}
				dataSource={items}
				search={false}
				options={false}
				scroll={{ x: 900 }}
				pagination={{
					current: Math.max(1, page),
					pageSize: PAGE_SIZE,
					total,
					showSizeChanger: false,
					showTotal: (count) => t("共 {total} 条", { total: count }),
					onChange: (next) => onQuery(filter, next),
				}}
				toolbar={{
					title: (
						<div className="gatehub-toolbar">
							{tab === "ai" ? (
								<Select
									value={filter.decision ?? ""}
									style={{ width: 120 }}
									onChange={(value) =>
										apply({ decision: (value || undefined) as SentinelGateFilter["decision"] })
									}
									options={[
										{ value: "", label: t("全部判定") },
										{ value: "block", label: t("拦截") },
										{ value: "allow", label: t("放行") },
										{ value: "failed", label: t("请求失败") },
									]}
								/>
							) : null}
							<Select
								value={filter.source ?? ""}
								style={{ width: 116 }}
								onChange={(value) => apply({ source: value || undefined })}
								options={[
									{ value: "", label: t("全部来源") },
									{ value: "主代理", label: t("主代理") },
									{ value: "子代理", label: t("子代理") },
								]}
							/>
							<Select
								value={windowIndex}
								style={{ width: 132 }}
								onChange={(value) => applyWindow(Number(value))}
								options={WINDOWS.map((entry, index) => ({ value: index, label: entry.label }))}
							/>
							<Select
								value={filter.projectId ?? ""}
								style={{ width: 150 }}
								onChange={(value) => apply({ projectId: value || undefined })}
								options={[
									{ value: "", label: t("全部项目") },
									...projects.map((project) => ({ value: project.id, label: project.name })),
								]}
							/>
							<Select
								value={filter.sessionId ?? ""}
								style={{ width: 180 }}
								showSearch
								optionFilterProp="label"
								onChange={(value) => apply({ sessionId: value || undefined })}
								options={[
									{ value: "", label: t("全部会话") },
									...sessionOptions.map((session) => ({ value: session.id, label: sessionTitle(session) })),
								]}
							/>
							<Input
								allowClear
								className="gatehub-search"
								prefix={<SearchOutlined />}
								value={search}
								placeholder={t("命令或理由中包含…")}
								onChange={(event) => setSearch(event.target.value)}
								onPressEnter={() => apply({ search: search.trim() || undefined })}
							/>
							<Button onClick={() => apply({ search: search.trim() || undefined })}>{t("筛选")}</Button>
							<Button
								type="link"
								onClick={() => {
									setSearch("");
									setWindowIndex(0);
									onQuery(tab === "ai" ? { approval: SENTINEL_GATE_TAB_BUCKETS.ai } : {}, 1);
								}}
							>
								{t("清空")}
							</Button>
						</div>
					),
				}}
				onRow={(item) => ({
					onClick: () => setExpanded(item.id),
					style: { cursor: "pointer" },
				})}
				locale={{
					emptyText: (
						<Empty
							image={Empty.PRESENTED_IMAGE_SIMPLE}
							description={
								<>
									<div>
										{filtersBeyondTab
											? t("没有符合条件的{kind}", { kind: tab === "ai" ? t("判定记录") : t("调用记录") })
											: tab === "ai"
												? t("AI 审批还没有任何记录")
												: t("自动审批还没有任何记录")}
									</div>
									<div className="gatehub-empty-hint">
										{tab === "ai"
											? t(
													"AI 审批模式下每条命令、以及（开关打开时）每次 MCP / 插件工具调用都会在这里留下一条记录；审批模式与自动执行不产生判定记录，它们的调用在「自动审批」标签页。",
												)
											: t(
													"这一页记录自动执行、人工审批（含人工放行与人工拦截）、以及 AI 审批下守门没覆盖到的工具调用。",
												)}
									</div>
								</>
							}
						/>
					),
				}}
			/>

			<Drawer
				open={detailItem !== null}
				width={720}
				onClose={() => setExpanded(null)}
				destroyOnHidden
				className="gatehub-drawer"
				title={
					<Space size={8} wrap>
						<Text strong>{detailItem ? SENTINEL_GATE_DECISION_LABELS[detailItem.decision] : ""}</Text>
						{detailItem ? <Text type="secondary">{formatClock(detailItem.at)}</Text> : null}
					</Space>
				}
			>
				{detailItem ? (
					<div className="gatehub-detail">
						<div>{t("调用：{tool}", { tool: detailItem.tool })}</div>
						<div>{t("方式：{mode}", { mode: SENTINEL_GATE_APPROVAL_LABELS[detailItem.approval] })}</div>
						{detailItem.reason ? <div>{t("理由：{reason}", { reason: detailItem.reason })}</div> : null}
						{detailItem.error ? (
							<div className="gatehub-detail__error">
								{t("失败：{error}", { error: detailItem.error })}
							</div>
						) : null}
						<div>{t("来源：{source}", { source: detailItem.source })}</div>
						<div>{t("工作目录：{cwd}", { cwd: detailItem.cwd ?? "-" })}</div>
						<div>
							{t("tokens：{count}", { count: detailItem.totalTokens ?? "-" })}
							{detailItem.modelFrom ? t(" · 来源 {from}", { from: detailItem.modelFrom }) : ""}
							{detailItem.commandTruncated ? t(" · 命令已截断存储") : ""}
						</div>
						{detailItem.commandTruncated ? <div>{t("（记录里的命令超过 8 KB，已截断）")}</div> : null}
						<pre className="gatehub-command-full">{detailItem.command}</pre>
					</div>
				) : null}
			</Drawer>
		</Page>
	);
}
