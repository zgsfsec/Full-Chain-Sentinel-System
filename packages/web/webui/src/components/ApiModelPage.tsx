/**
 * The business-modeling page: the OpenAPI documents the agent produced.
 *
 * Modeling happens inside an ordinary conversation — the operator presses 业务建模
 * in the composer, the agent gets two extra tools for the run, and the result
 * lands here. This page is read-only by construction: the document is the
 * agent's record of what it verified, so the operator inspects it, exports it,
 * or deletes it, but editing it here would blur "the model inferred this" and
 * "someone corrected it".
 *
 * The list is project-scoped like the vulnerability hub: a model belongs to the
 * scope it was produced in. One row opens a drill-down view: the document in an
 * embedded Swagger UI (the same reader the operator uses for any other API doc),
 * plus the business entities and relations and the audit trail — the two things
 * Swagger UI has no notion of.
 */

import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { Alert, Button, Card, Empty, Input, Select, Space, Tabs, Tag, Timeline, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import swaggerUiCss from "swagger-ui-dist/swagger-ui.css?url";
import swaggerUiBundle from "swagger-ui-dist/swagger-ui-bundle.js?url";
import { t } from "../i18n.ts";
import type {
	SentinelApiModel,
	SentinelApiModelEntity,
	SentinelApiModelEvent,
	SentinelApiModelStatus,
	SentinelApiModelSummary,
} from "../types.ts";
import { SENTINEL_API_MODEL_STATUS_LABELS } from "../types.ts";
import { Page } from "../ui/Page.tsx";
import "./apimodel-page.css";

const { Text } = Typography;

const STATUS_COLORS: Record<SentinelApiModelStatus, string> = {
	modeling: "blue",
	done: "green",
	manual: "default",
	failed: "red",
};

const STATUS_FILTERS: { value: SentinelApiModelStatus | ""; label: string }[] = [
	{ value: "", label: t("全部") },
	{ value: "modeling", label: t("建模中") },
	{ value: "done", label: t("已完成") },
	{ value: "manual", label: t("人工结束") },
	{ value: "failed", label: t("失败") },
];

/** The three panes of a drill-down. The document is the default: it is the deliverable. */
type DetailPane = "doc" | "entities" | "timeline";

const DETAIL_PANES: { value: DetailPane; label: string }[] = [
	{ value: "doc", label: t("接口文档") },
	{ value: "entities", label: t("业务实体") },
	{ value: "timeline", label: t("时间线") },
];

/**
 * One document as a standalone Swagger UI page.
 *
 * The spec is inlined rather than fetched: the page is served with the console's
 * own auth, and an iframe fetch would have to thread the session through. `<` is
 * escaped so a `</script>` inside a description or an example value cannot close
 * the inline script early. Try-it-out is removed, not just disabled: modeling is
 * read-and-restore, and a button that fires real requests at the target from the
 * console is the wrong default.
 */
function swaggerDocumentHtml(openapi: Record<string, unknown>): string {
	const spec = JSON.stringify(openapi).replace(/</g, "\\u003c");
	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		`<link rel="stylesheet" href="${swaggerUiCss}">`,
		'</head><body><div id="swagger-ui"></div>',
		`<script src="${swaggerUiBundle}"></script>`,
		"<script>window.onload=function(){SwaggerUIBundle({",
		`spec:${spec},`,
		"dom_id:'#swagger-ui',docExpansion:'list',",
		"supportedSubmitMethods:[]});};</script></body></html>",
	].join("");
}

function formatTime(iso: string | null): string {
	if (!iso) return "—";
	return iso.slice(0, 19).replace("T", " ");
}

/** Human line for one audit entry. */
function eventLabel(event: SentinelApiModelEvent): string {
	switch (event.kind) {
		case "created":
			return t("建模开始");
		case "submitted":
			return t("提交（{paths} 路径 / {ops} 操作）", {
				paths: event.pathCount ?? 0,
				ops: event.operationCount ?? 0,
			});
		case "done":
			return t("Agent 声明完成");
		case "manual":
			return t("操作员结束");
		case "failed":
			return t("失败");
	}
}

function StatusChip({ status }: { status: SentinelApiModelStatus }) {
	return (
		<Tag color={STATUS_COLORS[status]} variant="filled">
			{SENTINEL_API_MODEL_STATUS_LABELS[status]}
		</Tag>
	);
}

function EntityCard({ entity }: { entity: SentinelApiModelEntity }) {
	return (
		<Card size="small" className="apimodel-entity" title={<Text strong>{entity.name}</Text>}>
			{entity.description ? (
				<Text type="secondary" className="apimodel-entity__desc">
					{entity.description}
				</Text>
			) : null}
			{entity.fields && entity.fields.length > 0 ? (
				<ProTable
					size="small"
					rowKey="name"
					search={false}
					options={false}
					pagination={false}
					dataSource={entity.fields}
					toolbar={{ title: <Text strong>{t("字段")}</Text> }}
					columns={[
						{ title: t("字段"), dataIndex: "name", key: "name" },
						{ title: t("类型"), dataIndex: "type", key: "type" },
						{ title: t("说明"), dataIndex: "description", key: "description" },
					]}
				/>
			) : null}
			{entity.relations && entity.relations.length > 0 ? (
				<Space size={4} wrap className="apimodel-relations">
					{entity.relations.map((relation) => (
						<Tag key={`${relation.target}-${relation.kind ?? ""}`} variant="filled">
							{relation.kind ? `${relation.kind} ` : ""}
							{relation.target}
							{relation.description ? `（${relation.description}）` : ""}
						</Tag>
					))}
				</Space>
			) : null}
		</Card>
	);
}

export function ApiModelPage({
	items,
	detail,
	events,
	projectName,
	hasProject,
	onRefresh,
	onOpen,
	onClose,
	onDelete,
	onEnd,
	onExport,
	onOpenSession,
}: {
	items: SentinelApiModelSummary[];
	/** The run whose drill-down is open; null shows the list. */
	detail: SentinelApiModel | null;
	events: SentinelApiModelEvent[];
	projectName: string | null;
	hasProject: boolean;
	onRefresh(): void;
	onOpen(id: string): void;
	onClose(): void;
	onDelete(id: string): void;
	/** Close a run that is still 建模中 (its session may be long gone). */
	onEnd(id: string): void;
	onExport(id: string, format: "json" | "yaml"): void;
	onOpenSession(path: string): void;
}) {
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState<SentinelApiModelStatus | "">("");
	const [pane, setPane] = useState<DetailPane>("doc");

	// Opening another record lands on its document, not on the pane the previous
	// record happened to be on.
	useEffect(() => setPane("doc"), [detail?.id]);

	const visible = useMemo(() => {
		const needle = search.trim().toLowerCase();
		return items.filter((item) => {
			if (status && item.status !== status) return false;
			if (!needle) return true;
			return item.title.toLowerCase().includes(needle) || item.target.toLowerCase().includes(needle);
		});
	}, [items, search, status]);

	if (!hasProject) {
		return (
			<Page title={t("业务建模")} description={t("业务建模的成果按项目归档")}>
				<Empty
					image={Empty.PRESENTED_IMAGE_SIMPLE}
					description={t("请先在侧栏顶部创建或选择一个项目")}
				/>
			</Page>
		);
	}

	if (detail) {
		// The drill-down does not scroll as a page: the pane the operator is on owns
		// the scroll, so the document reads like any full-height API doc.
		return (
			<Page
				className="apimodel-detail"
				title={t("业务建模")}
				description={detail.title}
				extra={
					<Space>
						<Button size="small" onClick={onClose}>
							{t("返回列表")}
						</Button>
						<Button size="small" onClick={() => onExport(detail.id, "json")}>
							{t("导出 JSON")}
						</Button>
						<Button size="small" onClick={() => onExport(detail.id, "yaml")}>
							{t("导出 YAML")}
						</Button>
						{detail.status === "modeling" ? (
							<Button size="small" onClick={() => onEnd(detail.id)}>
								{t("标记已结束")}
							</Button>
						) : null}
						<Button
							size="small"
							danger
							onClick={() => {
								onDelete(detail.id);
								onClose();
							}}
						>
							{t("删除")}
						</Button>
					</Space>
				}
			>
				<div className="apimodel-meta">
					<StatusChip status={detail.status} />
					<Text type="secondary">
						{t("目标")} <Text strong>{detail.target || t("未记录目标")}</Text>
					</Text>
					<Text type="secondary">
						{t("路径")} <Text strong>{detail.pathCount}</Text>
					</Text>
					<Text type="secondary">
						{t("操作")} <Text strong>{detail.operationCount}</Text>
					</Text>
					<Text type="secondary">
						{t("实体")} <Text strong>{detail.entities.length}</Text>
					</Text>
					<Text type="secondary">
						{t("提交")} <Text strong>{detail.submissions}</Text> {t("次")}
					</Text>
					<Text type="secondary">{t("开始 {time}", { time: formatTime(detail.createdAt) })}</Text>
					<Text type="secondary">{t("更新 {time}", { time: formatTime(detail.updatedAt) })}</Text>
					{detail.sessionPath ? (
						<Button type="link" size="small" onClick={() => onOpenSession(detail.sessionPath as string)}>
							{t("打开发起它的会话")}
						</Button>
					) : null}
				</div>
				{detail.error ? (
					<Alert type="error" showIcon className="ui-page__alert" title={detail.error} />
				) : null}

				<Tabs
					activeKey={pane}
					onChange={(key) => setPane(key as DetailPane)}
					items={DETAIL_PANES.map((entry) => ({
						key: entry.value,
						label: (
							<Space size={6}>
								{entry.label}
								{entry.value === "entities" ? <Tag variant="filled">{detail.entities.length}</Tag> : null}
								{entry.value === "timeline" ? <Tag variant="filled">{events.length}</Tag> : null}
							</Space>
						),
					}))}
				/>

				<div className="apimodel-stage">
					<div className={pane === "doc" ? "apimodel-pane is-active" : "apimodel-pane"}>
						{detail.pathCount === 0 ? (
							<Empty
								image={Empty.PRESENTED_IMAGE_SIMPLE}
								description={t("文档里还没有接口：Agent 提交后这里就是 Swagger UI。")}
							/>
						) : (
							<iframe
								className="apimodel-doc"
								title={`Swagger UI · ${detail.title}`}
								sandbox="allow-scripts"
								srcDoc={swaggerDocumentHtml(detail.openapi)}
							/>
						)}
					</div>
					<div className={pane === "entities" ? "apimodel-pane is-active" : "apimodel-pane"}>
						<div className="apimodel-pane__pad">
							{detail.entities.length === 0 ? (
								<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("这次建模没有整理业务实体。")} />
							) : (
								<div className="apimodel-entities">
									{detail.entities.map((entity) => (
										<EntityCard key={entity.name} entity={entity} />
									))}
								</div>
							)}
						</div>
					</div>
					<div className={pane === "timeline" ? "apimodel-pane is-active" : "apimodel-pane"}>
						<div className="apimodel-pane__pad">
							<Timeline
								items={events.map((event, index) => ({
									key: `${event.at}-${index}`,
									children: (
										<div className="apimodel-event">
											<Text type="secondary" className="apimodel-event__time">
												{formatTime(event.at)}
											</Text>
											<Text strong>{eventLabel(event)}</Text>
											{event.note ? <Text type="secondary">{event.note}</Text> : null}
										</div>
									),
								}))}
							/>
						</div>
					</div>
				</div>
			</Page>
		);
	}

	const columns: ProColumns<SentinelApiModelSummary>[] = [
		{
			title: t("名称"),
			dataIndex: "title",
			key: "title",
			ellipsis: { showTitle: true },
		},
		{
			title: t("状态"),
			dataIndex: "status",
			key: "status",
			width: 100,
			render: (_, item) => <StatusChip status={item.status} />,
		},
		{
			title: t("目标"),
			dataIndex: "target",
			key: "target",
			width: 200,
			ellipsis: { showTitle: true },
			render: (_, item) => <Text code>{item.target || "—"}</Text>,
		},
		{
			title: t("接口"),
			key: "paths",
			width: 170,
			render: (_, item) => (
				<Text type="secondary">
					{t("{paths} 路径 / {ops} 操作", { paths: item.pathCount, ops: item.operationCount })}
				</Text>
			),
		},
		{
			title: t("实体"),
			dataIndex: "entityCount",
			key: "entities",
			width: 80,
			align: "right",
		},
		{
			title: t("时间"),
			dataIndex: "createdAt",
			key: "createdAt",
			width: 170,
			render: (_, item) => <Text type="secondary">{formatTime(item.createdAt)}</Text>,
		},
		{
			title: t("操作"),
			key: "actions",
			width: 80,
			render: (_, item) => (
				<Button type="link" size="small" onClick={() => onOpen(item.id)}>
					{t("查看")}
				</Button>
			),
		},
	];

	return (
		<Page
			title={t("业务建模")}
			description={
				projectName
					? `${projectName} · ${t("共 {n} 份", { n: items.length })}`
					: t("共 {n} 份", { n: items.length })
			}
			extra={
				<Button icon={<ReloadOutlined />} onClick={onRefresh}>
					{t("刷新")}
				</Button>
			}
		>
			<ProTable<SentinelApiModelSummary>
				rowKey="id"
				size="small"
				columns={columns}
				dataSource={visible}
				search={false}
				options={false}
				pagination={false}
				scroll={{ x: 900 }}
				toolbar={{
					title: (
						<div className="apimodel-toolbar">
							<Input
								allowClear
								className="apimodel-search"
								prefix={<SearchOutlined />}
								placeholder={t("搜索名称或目标")}
								value={search}
								onChange={(event) => setSearch(event.target.value)}
							/>
							<Select
								value={status}
								style={{ width: 120 }}
								onChange={(value) => setStatus(value as SentinelApiModelStatus | "")}
								options={STATUS_FILTERS.map((entry) => ({ value: entry.value, label: entry.label }))}
							/>
						</div>
					),
				}}
				onRow={(record) => ({
					onClick: (event) => {
						const target = event.target as HTMLElement;
						if (target.closest("button, a, .ant-checkbox-wrapper")) return;
						onOpen(record.id);
					},
					style: { cursor: "pointer" },
				})}
				locale={{
					emptyText: (
						<Empty
							image={Empty.PRESENTED_IMAGE_SIMPLE}
							description={
								items.length === 0
									? t("还没有业务建模记录。")
									: search.trim()
										? t("没有符合当前筛选的记录（共 {n} 份，当前有关键字）。", { n: items.length })
										: t("没有符合当前筛选的记录（共 {n} 份）。", { n: items.length })
							}
						/>
					),
				}}
			/>
		</Page>
	);
}
