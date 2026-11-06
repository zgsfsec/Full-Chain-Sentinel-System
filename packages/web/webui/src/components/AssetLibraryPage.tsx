/**
 * The asset inventory page.
 *
 * The agent reports what it actually touched; this page is where the operator
 * reads it. Rows are read-only except for the verdict: state, tags, and operator
 * records. Deleting is a selection flow so the dialog can state what goes with
 * the rows. Listing is paginated because it is one screen of a ledger that has
 * no size limit; the export always takes the whole filter, not the page.
 */

import { DeleteOutlined, DownloadOutlined, ImportOutlined, SearchOutlined } from "@ant-design/icons";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { Alert, Button, Drawer, Empty, Input, Modal, Select, Space, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import type {
	SentinelAssetDeletePreview,
	SentinelAssetDetail,
	SentinelAssetFilters,
	SentinelAssetKind,
	SentinelAssetOutcome,
	SentinelAssetState,
	SentinelAssetStats,
	SentinelAssetSummary,
	SentinelAssetUpdate,
} from "../types.ts";
import {
	SENTINEL_ASSET_KINDS,
	SENTINEL_ASSET_KIND_LABELS,
	SENTINEL_ASSET_OUTCOME_LABELS,
	SENTINEL_ASSET_STATES,
	SENTINEL_ASSET_STATE_LABELS,
} from "../types.ts";
import { Page } from "../ui/Page.tsx";

import { AssetDetailBody } from "./AssetDetailBody.tsx";
import { AssetImportDialog } from "./AssetImportDialog.tsx";

const { Text } = Typography;

const KIND_COLORS: Record<SentinelAssetKind, string> = {
	domain: "geekblue",
	ip: "cyan",
	service: "purple",
	url: "blue",
};

const STATE_COLORS: Record<SentinelAssetState, string> = {
	pending: "gold",
	testing: "blue",
	tested: "green",
	out_of_scope: "default",
};

function formatWhen(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const sameYear = date.getFullYear() === new Date().getFullYear();
	const datePart = sameYear
		? `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
		: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	return `${datePart} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function stateLabel(state: SentinelAssetState): string {
	return SENTINEL_ASSET_STATE_LABELS[state];
}

function kindLabel(kind: SentinelAssetKind): string {
	return SENTINEL_ASSET_KIND_LABELS[kind];
}

function outcomeLabel(outcome: SentinelAssetOutcome | undefined): string {
	return outcome ? SENTINEL_ASSET_OUTCOME_LABELS[outcome] : t("无结论");
}

function testSummary(item: SentinelAssetSummary): string {
	if (item.testCount === 0) return "—";
	return `${item.testCount} · ${outcomeLabel(item.lastOutcome)}`;
}

export { AssetDetailBody } from "./AssetDetailBody.tsx";

export function AssetDetail(props: Parameters<typeof AssetDetailBody>[0]) {
	return (
		<Drawer
			open
			size="min(760px, 100vw)"
			onClose={props.onClose}
			destroyOnHidden
			className="asset-inspector-drawer"
			title={t("资产详情")}
		>
			<AssetDetailBody {...props} />
		</Drawer>
	);
}

/** The delete confirmation's content, exported so it can be rendered on its own. */
export function AssetDeleteBody({
	pending,
	preview,
}: {
	pending: string[] | null;
	preview: SentinelAssetDeletePreview | null;
}) {
	return (
		<div className="assethub-delete">
			<Text>{t("将删除 {count} 条资产。", { count: preview?.count ?? pending?.length ?? 0 })}</Text>
			{preview ? (
				<ul>
					<li>{t("{count} 条时间线记录", { count: preview.records })}</li>
					<li>{t("{count} 条漏洞的关联会被解除（漏洞本身保留）", { count: preview.vulns })}</li>
				</ul>
			) : (
				<Text type="secondary">{t("正在统计影响…")}</Text>
			)}
			<Text type="secondary">{t("资产、时间线与导出内容都会消失；关联漏洞只解除关联，不删除漏洞记录。")}</Text>
		</div>
	);
}

export function AssetLibraryPage({
	items,
	stats,
	total,
	page,
	pageSize,
	filters,
	detail,
	deletePending,
	deletePreview,
	projectName,
	hasProject,
	onQuery,
	onOpen,
	onCloseDetail,
	onUpdate,
	onRequestDelete,
	onConfirmDelete,
	onCancelDelete,
	onExport,
	onOpenVuln,
}: {
	items: SentinelAssetSummary[];
	stats: SentinelAssetStats;
	total: number;
	page: number;
	pageSize: number;
	hasMore: boolean;
	filters: SentinelAssetFilters;
	detail: SentinelAssetDetail | null;
	deletePending: string[] | null;
	deletePreview: SentinelAssetDeletePreview | null;
	projectName: string | null;
	hasProject: boolean;
	onQuery: (filters: SentinelAssetFilters, page: number, pageSize: number) => void;
	onOpen: (id: string) => void;
	onCloseDetail: () => void;
	onUpdate: (id: string, patch: SentinelAssetUpdate) => void;
	onRequestDelete: (ids: string[]) => void;
	onConfirmDelete: (ids: string[]) => void;
	onCancelDelete: () => void;
	onExport: (filters: SentinelAssetFilters) => void;
	onOpenVuln: (id: string) => void;
}) {
	const [search, setSearch] = useState(filters.search ?? "");
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [importOpen, setImportOpen] = useState(false);

	useEffect(() => { setImportOpen(false); }, [projectName, hasProject]);

	useEffect(() => {
		setSearch(filters.search ?? "");
	}, [filters.search]);

	// A page/filter change starts a new selection; a live refresh only drops ids
	// that no longer exist.
	useEffect(() => {
		setSelected(new Set());
	}, [page, pageSize, filters]);

	useEffect(() => {
		setSelected((prev) => {
			if (prev.size === 0) return prev;
			const alive = new Set(items.map((item) => item.id));
			const next = new Set([...prev].filter((id) => alive.has(id)));
			return next.size === prev.size ? prev : next;
		});
	}, [items]);

	const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
	const selectedIds = items.filter((item) => selected.has(item.id)).map((item) => item.id);

	const changeFilters = (patch: Partial<SentinelAssetFilters>) => {
		onQuery({ ...filters, ...patch }, 1, pageSize);
	};

	const reset = () => {
		setSearch("");
		onQuery({}, 1, pageSize);
	};

	if (!hasProject) {
		return (
			<Page title={t("资产库")} description={t("资产库按项目隔离")}>
				<Empty
					image={Empty.PRESENTED_IMAGE_SIMPLE}
					description={
						<>
							<div>{t("尚未选择项目")}</div>
							<div className="assethub-empty-hint">{t("请先在侧栏顶部选择或创建一个项目")}</div>
						</>
					}
				/>
			</Page>
		);
	}

	const columns: ProColumns<SentinelAssetSummary>[] = [
		{
			title: t("编号"),
			dataIndex: "label",
			key: "label",
			width: 108,
			render: (_, item) => <Text className="table-mono">{item.label}</Text>,
		},
		{
			title: t("类型"),
			dataIndex: "kind",
			key: "kind",
			width: 84,
			render: (_, item) => (
				<Tag color={KIND_COLORS[item.kind]} variant="filled">
					{kindLabel(item.kind)}
				</Tag>
			),
		},
		{
			title: t("资产"),
			dataIndex: "name",
			key: "name",
			width: 240,
			ellipsis: { showTitle: true },
			render: (_, item) => (
				<Button type="link" className="assethub-asset-link table-mono" title={item.name} onClick={() => onOpen(item.id)}>
					{item.name}
				</Button>
			),
		},
		{
			title: t("标题"),
			dataIndex: "title",
			key: "title",
			width: 220,
			ellipsis: { showTitle: true },
			render: (_, item) => (item.title ? <Text type="secondary">{item.title}</Text> : <Text type="secondary">—</Text>),
		},
		{
			title: t("协议"),
			dataIndex: "protocol",
			key: "protocol",
			width: 88,
			render: (_, item) => item.protocol ?? <Text type="secondary">—</Text>,
		},
		{
			title: t("状态"),
			dataIndex: "status",
			key: "status",
			width: 96,
			render: (_, item) => (
				<Tag color={STATE_COLORS[item.status]} variant="filled">
					{stateLabel(item.status)}
				</Tag>
			),
		},
		{
			title: t("测试"),
			key: "tests",
			width: 150,
			render: (_, item) => <Text type="secondary">{testSummary(item)}</Text>,
		},
		{
			title: t("最近发现"),
			dataIndex: "lastSeenAt",
			key: "lastSeenAt",
			width: 118,
			render: (_, item) => <Text type="secondary">{formatWhen(item.lastSeenAt)}</Text>,
		},
		{
			title: t("来源"),
			dataIndex: "source",
			key: "source",
			width: 150,
			ellipsis: { showTitle: true },
			render: (_, item) => <Text type="secondary">{item.source}</Text>,
		},
	];

	return (
		<Page
			title={t("资产库")}
			description={
				<>
					{projectName ? `${projectName} · ` : ""}
					{t("共 {total} 条 · 待测试 {pending}", { total: stats.total, pending: stats.byStatus.pending })}
					{filters.search || filters.kind || filters.status || filters.tested !== undefined
						? ` · ${t("筛选命中 {count} 条", { count: total })}`
						: ""}
				</>
			}
			extra={
				<Space wrap>
				<Button icon={<DownloadOutlined />} onClick={() => onExport(filters)}>
					{t("导出 Markdown")}
				</Button>
				<Button type="primary" icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>{getLanguage() === "zh" ? "导入资产" : "Import assets"}</Button>
				</Space>
			}
		>
			<div className="assethub-stats">
				{SENTINEL_ASSET_KINDS.map((kind) => (
					<Tag key={kind} color={KIND_COLORS[kind]} variant="filled">
						{kindLabel(kind)} {stats.byKind[kind]}
					</Tag>
				))}
				{SENTINEL_ASSET_STATES.map((state) => (
					<Tag key={state} color={STATE_COLORS[state]} variant="filled">
						{stateLabel(state)} {stats.byStatus[state]}
					</Tag>
				))}
			</div>

			{selectedIds.length > 0 ? (
				<Alert
					type="info"
					showIcon
					className="ui-page__alert"
					title={t("已选择 {count} 条", { count: selectedIds.length })}
					action={
						<Space size={8}>
							<Button size="small" onClick={() => setSelected(new Set())}>
								{t("取消选择")}
							</Button>
							<Button size="small" danger icon={<DeleteOutlined />} onClick={() => onRequestDelete(selectedIds)}>
								{t("删除选中")}
							</Button>
						</Space>
					}
				/>
			) : null}

			<ProTable<SentinelAssetSummary>
				rowKey="id"
				size="small"
				columns={columns}
				dataSource={items}
				search={false}
				options={false}
				scroll={{ x: 1320 }}
				rowSelection={{
					selectedRowKeys: selectedIds,
					onChange: (keys) => setSelected(new Set(keys as string[])),
					columnWidth: 44,
				}}
				pagination={{
					current: Math.max(1, page),
					pageSize,
					total,
					showSizeChanger: true,
					pageSizeOptions: [20, 50, 100, 200],
					showTotal: (count) => t("共 {total} 条", { total: count }),
					onChange: (next, size) => onQuery(filters, size !== pageSize ? 1 : next, size),
				}}
				toolbar={{
					title: (
						<div className="assethub-toolbar">
							<Input
								allowClear
								className="assethub-toolbar__search"
								prefix={<SearchOutlined />}
								value={search}
								placeholder={t("搜索编号 / 名称 / URL / 标题 / 标签 / 来源")}
								onChange={(event) => setSearch(event.target.value)}
								onPressEnter={() => changeFilters({ search: search.trim() || undefined })}
							/>
							<Select
								value={filters.kind ?? ""}
								style={{ width: 116 }}
								onChange={(value) => changeFilters({ kind: (value || undefined) as SentinelAssetKind | undefined })}
								options={[
									{ value: "", label: t("全部类型") },
									...SENTINEL_ASSET_KINDS.map((kind) => ({ value: kind, label: kindLabel(kind) })),
								]}
							/>
							<Select
								value={filters.status ?? ""}
								style={{ width: 116 }}
								onChange={(value) => changeFilters({ status: (value || undefined) as SentinelAssetState | undefined })}
								options={[
									{ value: "", label: t("全部状态") },
									...SENTINEL_ASSET_STATES.map((state) => ({ value: state, label: stateLabel(state) })),
								]}
							/>
							<Select
								value={filters.tested === undefined ? "" : filters.tested ? "yes" : "no"}
								style={{ width: 116 }}
								onChange={(value) => changeFilters({ tested: value === "" ? undefined : value === "yes" })}
								options={[
									{ value: "", label: t("全部结论") },
									{ value: "yes", label: t("有结论") },
									{ value: "no", label: t("无结论") },
								]}
							/>
							<Button type="link" onClick={reset}>
								{t("重置")}
							</Button>
							<Button
								type="link"
								disabled={items.length === 0}
								title={t("只选中当前页，不含其他页")}
								onClick={() => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))}
							>
								{allSelected ? t("取消全选") : t("全选本页")}
							</Button>
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
									<div>{stats.total === 0 ? t("还没有资产记录") : t("没有符合条件的资产")}</div>
									<div className="assethub-empty-hint">
										{stats.total === 0
											? t("Agent 在探测目标时用 asset_report 上报；需要在「设置 → 权限」开启 asset_library_write")
											: t("调整搜索或筛选条件")}
									</div>
								</>
							}
						/>
					),
				}}
			/>

			{importOpen ? <AssetImportDialog onClose={() => setImportOpen(false)} onImported={() => onQuery(filters, 1, pageSize)} /> : null}

			{detail ? (
				<AssetDetail
					detail={detail}
					onClose={onCloseDetail}
					onUpdate={onUpdate}
					onRequestDelete={onRequestDelete}
					onOpenVuln={onOpenVuln}
				/>
			) : null}

			<Modal
				open={deletePending !== null}
				title={t("删除资产")}
				okText={t("确认删除")}
				cancelText={t("取消")}
				okButtonProps={{ danger: true, disabled: deletePreview === null }}
				onOk={() => {
					if (deletePending) onConfirmDelete(deletePending);
				}}
				onCancel={onCancelDelete}
				destroyOnHidden
			>
				<AssetDeleteBody pending={deletePending} preview={deletePreview} />
			</Modal>
		</Page>
	);
}
