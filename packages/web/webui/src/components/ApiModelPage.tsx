/**
 * The business-modeling page: what the agent recorded about the project's business.
 *
 * Modeling happens inside an ordinary conversation or an engineering task's
 * worker — the operator sends the instruction from the composer, or the
 * commander dispatches it as a task — and the result lands here. One run is one
 * record, with two halves: the interface document restored from the target's
 * traffic (an OpenAPI document with the business entities inferred along the
 * way), and what the agent read out of the project's source (the mapping of each
 * endpoint and the business logic model). A record holds whichever halves the
 * run's inputs allowed for.
 *
 * This page is read-only by construction: a record is the agent's account of
 * what it verified or read, so the operator inspects it, exports it, or deletes
 * it, but editing it here would blur "the model inferred this" and "someone
 * corrected it".
 *
 * The list is project-scoped like the vulnerability hub: a record belongs to the
 * scope it was produced in. One row opens a drill-down with a tab per part —
 * only the parts the record has — plus the audit trail.
 *
 * The places in the source a record points at are shown relative to the
 * directory they all share; the whole path stays on hover and is what gets
 * copied, since that is what an agent can open.
 */

import { ArrowLeftOutlined, DownOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { Alert, Button, Card, Dropdown, Empty, Input, Select, Space, Tabs, Tag, Timeline, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import swaggerUiCss from "swagger-ui-dist/swagger-ui.css?url";
import swaggerUiBundle from "swagger-ui-dist/swagger-ui-bundle.js?url";
import { t } from "../i18n.ts";
import type { DetailLoadState } from "../detail-request.ts";
import { DetailLoading } from "../ui/DetailLoading.tsx";
import { Page } from "../ui/Page.tsx";
import type {
	SentinelApiModel,
	SentinelApiModelEntity,
	SentinelApiModelEvent,
	SentinelApiModelStatus,
	SentinelApiModelSummary,
	SentinelCodeLocation,
} from "../types.ts";
import { CodeModelApiPane } from "./codemodel/CodeModelApiPane.tsx";
import { CodeModelLogicPane } from "./codemodel/CodeModelLogicPane.tsx";
import { commonRoot, CopyIcon, LocationRootContext } from "./codemodel/labels.tsx";
import { formatModelTime, MODEL_STATUS_FILTERS, ModelStatusChip } from "./modelStatus.tsx";
import "./apimodel-page.css";
import "./codemodel/codemodel.css";

const { Text } = Typography;

/** What a record can be exported as: the interface document as OpenAPI, or the whole record. */
type ExportFormat = "json" | "yaml" | "record" | "markdown";

/** The panes of a drill-down. Which ones a record has is decided per record. */
type DetailPane = "document" | "entities" | "apis" | "logic" | "timeline";

const PANE_LABELS: Record<DetailPane, string> = {
	document: t("接口文档"),
	entities: t("业务实体"),
	apis: t("源码映射"),
	logic: t("业务逻辑"),
	timeline: t("时间线"),
};

/** How many items the business-logic model holds across its five lists. */
function logicCount(model: SentinelApiModel): number {
	const { logic } = model;
	return (
		logic.entities.length +
		logic.relations.length +
		logic.stateMachines.length +
		logic.rules.length +
		logic.apiDependencies.length
	);
}

/** Whether the record's source half was done at all. */
function hasSource(model: SentinelApiModel): boolean {
	return Boolean(model.source) || model.apis.length > 0 || logicCount(model) > 0;
}

/** Every file the record's source half points at: what its locations are shown relative to is worked out from all of them. */
function locationFiles(model: SentinelApiModel): string[] {
	const files: string[] = [];
	const take = (...locations: readonly SentinelCodeLocation[]) => {
		for (const { file } of locations) files.push(file);
	};
	for (const api of model.apis) {
		take(
			api.handler.location,
			...api.callChain.map((step) => step.location),
			...api.dataAccess.map((access) => access.location),
			...api.authChecks.map((check) => check.location),
			...api.externalCalls.map((call) => call.location),
		);
	}
	const { logic } = model;
	for (const entity of logic.entities) take(...entity.locations);
	for (const relation of logic.relations) take(...relation.locations);
	for (const machine of logic.stateMachines) take(...machine.locations, ...machine.transitions.flatMap((transition) => transition.locations));
	for (const rule of logic.rules) take(...rule.locations);
	for (const dependency of logic.apiDependencies) take(...dependency.locations);
	return files;
}

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

/**
 * The panes a record has, each with what it counts. A part the record does not
 * have gets no tab, so the tabs are exactly what there is to read; the audit
 * trail is always there.
 */
function panesOf(
	detail: SentinelApiModel,
	events: readonly SentinelApiModelEvent[],
): Array<{ value: DetailPane; count: number }> {
	return [
		...(detail.pathCount > 0 ? [{ value: "document" as const, count: detail.pathCount }] : []),
		...(detail.entities.length > 0 ? [{ value: "entities" as const, count: detail.entities.length }] : []),
		...(detail.apis.length > 0 ? [{ value: "apis" as const, count: detail.apis.length }] : []),
		...(logicCount(detail) > 0 ? [{ value: "logic" as const, count: logicCount(detail) }] : []),
		{ value: "timeline" as const, count: events.length },
	];
}

/** Human line for one audit entry: what the record held after it. */
function eventLabel(event: SentinelApiModelEvent): string {
	switch (event.kind) {
		case "created":
			return t("建模开始");
		case "submitted": {
			const parts: string[] = [];
			if ((event.pathCount ?? 0) > 0) {
				parts.push(t("{paths} 路径 / {ops} 操作", { paths: event.pathCount ?? 0, ops: event.operationCount ?? 0 }));
			}
			if ((event.apiCount ?? 0) > 0) parts.push(t("{apis} 条接口映射", { apis: event.apiCount ?? 0 }));
			if ((event.stateMachineCount ?? 0) > 0) {
				parts.push(t("{machines} 个状态机", { machines: event.stateMachineCount ?? 0 }));
			}
			if ((event.ruleCount ?? 0) > 0) parts.push(t("{rules} 条规则", { rules: event.ruleCount ?? 0 }));
			return parts.length > 0 ? t("提交（{counts}）", { counts: parts.join(" / ") }) : t("提交");
		}
		case "done":
			return t("Agent 声明完成");
		case "manual":
			return t("操作员结束");
		case "failed":
			return t("失败");
	}
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
					scroll={{ x: 560 }}
					dataSource={entity.fields}
					toolbar={{ title: <Text strong>{t("字段")}</Text> }}
					columns={[
						{ title: t("字段"), dataIndex: "name", key: "name", width: 180 },
						{ title: t("类型"), dataIndex: "type", key: "type", width: 100 },
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
	detailState,
	onRetryDetail,
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
	/** Loaded record; detailState keeps the drill-down visible while waiting. */
	detail: SentinelApiModel | null;
	detailState?: DetailLoadState | null;
	onRetryDetail?: () => void;
	events: SentinelApiModelEvent[];
	projectName: string | null;
	hasProject: boolean;
	onRefresh(): void;
	onOpen(id: string): void;
	onClose(): void;
	onDelete(id: string): void;
	/** Close a run that is still 建模中 (its session may be long gone). */
	onEnd(id: string): void;
	onExport(id: string, format: ExportFormat): void;
	onOpenSession(path: string): void;
}) {
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState<SentinelApiModelStatus | "">("");
	/** The pane the operator picked; null means the record's first tab. */
	const [picked, setPicked] = useState<DetailPane | null>(null);

	// Opening another record lands on its first tab, not on the pane the previous
	// record happened to be on.
	useEffect(() => setPicked(null), [detail?.id]);

	const visible = useMemo(() => {
		const needle = search.trim().toLowerCase();
		return items.filter((item) => {
			if (status && item.status !== status) return false;
			if (!needle) return true;
			return (
				item.title.toLowerCase().includes(needle) ||
				item.target.toLowerCase().includes(needle) ||
				item.source.toLowerCase().includes(needle)
			);
		});
	}, [items, search, status]);

	if (!hasProject) {
		return (
			<Page title={t("业务建模")} description={t("业务建模的成果按项目归档")}>
				<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("请先在侧栏顶部创建或选择一个项目")} />
			</Page>
		);
	}

	if (!detail && detailState) {
		return (
			<Page title={t("业务建模")} extra={<Button icon={<ArrowLeftOutlined />} onClick={onClose}>{t("返回列表")}</Button>}>
				<DetailLoading error={detailState.error} onRetry={onRetryDetail} />
			</Page>
		);
	}

	if (detail) {
		const panes = panesOf(detail, events);
		const pane = panes.some((entry) => entry.value === picked) ? (picked as DetailPane) : panes[0].value;
		const source = hasSource(detail);
		// The locations of a record that has none of the source are shown in full.
		const root = source ? commonRoot(locationFiles(detail)) : "";
		// One menu, four forms: the interface document as OpenAPI when there is one, and the whole record.
		const exports = [
			...(detail.pathCount > 0
				? [
						{ key: "json", label: t("接口文档（OpenAPI JSON）") },
						{ key: "yaml", label: t("接口文档（OpenAPI YAML）") },
					]
				: []),
			{ key: "record", label: t("完整记录（JSON）") },
			{ key: "markdown", label: t("完整记录（Markdown）") },
		];
		const paneClass = (value: DetailPane) => (pane === value ? "apimodel-pane is-active" : "apimodel-pane");
		const has = (value: DetailPane) => panes.some((entry) => entry.value === value);
		// The drill-down does not scroll as a page: the pane the operator is on owns
		// the scroll, so a document reads like any full-height API doc.
		return (
			<Page
				className="apimodel-detail codemodel-detail"
				title={t("业务建模")}
				description={detail.title}
				extra={
					<Space wrap>
						<Button size="small" onClick={onClose}>
							{t("返回列表")}
						</Button>
						<Dropdown menu={{ items: exports, onClick: ({ key }) => onExport(detail.id, key as ExportFormat) }}>
							<Button size="small">
								{t("导出")} <DownOutlined />
							</Button>
						</Dropdown>
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
				{/* What the record is, what it covers, and what it holds: three lines, so
				    a label is always beside its value and not somewhere in a wrapped row. */}
				<dl className="apimodel-meta">
					<div className="apimodel-meta__row">
						<dt>{t("状态")}</dt>
						<dd>
							<ModelStatusChip status={detail.status} />
							<span>
								{t("提交")} <Text strong>{detail.submissions}</Text> {t("次")}
							</span>
							<span>{t("开始 {time}", { time: formatModelTime(detail.createdAt) })}</span>
							<span>{t("更新 {time}", { time: formatModelTime(detail.updatedAt) })}</span>
							{detail.sessionPath ? (
								<Button type="link" size="small" onClick={() => onOpenSession(detail.sessionPath as string)}>
									{t("打开发起它的会话")}
								</Button>
							) : null}
						</dd>
					</div>
					<div className="apimodel-meta__row">
						<dt>{t("范围")}</dt>
						<dd>
							<span>
								{t("目标")}{" "}
								<Text className="table-mono" title={detail.target}>
									{detail.target || t("未记录目标")}
								</Text>
							</span>
							{source ? (
								<span>
									{t("源码范围")}{" "}
									<Text className="table-mono" title={detail.source}>
										{detail.source || t("未记录")}
									</Text>
								</span>
							) : null}
							{root ? (
								<span className="apimodel-meta__root">
									{t("位置相对")}
									<span className="codemodel-loc" title={root}>
										<span className="codemodel-loc__path">
											<span className="codemodel-loc__file">{root}</span>
										</span>
										<CopyIcon text={root} />
									</span>
								</span>
							) : null}
						</dd>
					</div>
					<div className="apimodel-meta__row">
						<dt>{t("内容")}</dt>
						<dd>
							<span>
								{t("路径")} <Text strong>{detail.pathCount}</Text>
							</span>
							<span>
								{t("操作")} <Text strong>{detail.operationCount}</Text>
							</span>
							<span>
								{t("实体")} <Text strong>{detail.entities.length}</Text>
							</span>
							{source ? (
								<>
									<span>
										{t("源码映射")} <Text strong>{detail.apis.length}</Text>
									</span>
									<span>
										{t("状态机")} <Text strong>{detail.logic.stateMachines.length}</Text>
									</span>
									<span>
										{t("规则")} <Text strong>{detail.logic.rules.length}</Text>
									</span>
								</>
							) : null}
						</dd>
					</div>
				</dl>
				{detail.error ? (
					<Alert type="error" showIcon className="ui-page__alert" title={detail.error} />
				) : null}

				<Tabs
					activeKey={pane}
					onChange={(key) => setPicked(key as DetailPane)}
					items={panes.map((entry) => ({
						key: entry.value,
						label: (
							<Space size={6}>
								{PANE_LABELS[entry.value]}
								<span className="apimodel-tab-count">{entry.count}</span>
							</Space>
						),
					}))}
				/>

				<LocationRootContext.Provider value={root}>
					<div className="apimodel-stage">
						{/* Only the panes the record has are rendered at all, like their tabs. */}
						{has("document") ? (
							<div className={paneClass("document")}>
								<iframe
									className="apimodel-doc"
									title={`Swagger UI · ${detail.title}`}
									sandbox="allow-scripts"
									srcDoc={swaggerDocumentHtml(detail.openapi)}
								/>
							</div>
						) : null}
						{has("entities") ? (
							<div className={paneClass("entities")}>
								<div className="apimodel-pane__pad">
									<div className="apimodel-entities">
										{detail.entities.map((entity) => (
											<EntityCard key={entity.name} entity={entity} />
										))}
									</div>
								</div>
							</div>
						) : null}
						{has("apis") ? (
							<div className={paneClass("apis")}>
								<CodeModelApiPane apis={detail.apis} />
							</div>
						) : null}
						{has("logic") ? (
							<div className={paneClass("logic")}>
								<div className="apimodel-pane__pad">
									<CodeModelLogicPane logic={detail.logic} />
								</div>
							</div>
						) : null}
						<div className={paneClass("timeline")}>
							<div className="apimodel-pane__pad">
								<Timeline
									items={events.map((event, index) => ({
										key: `${event.at}-${index}`,
										content: (
											<div className="apimodel-event">
												<Text type="secondary" className="apimodel-event__time">
													{formatModelTime(event.at)}
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
				</LocationRootContext.Provider>
			</Page>
		);
	}

	const columns: ProColumns<SentinelApiModelSummary>[] = [
		{
			title: t("名称"),
			dataIndex: "title",
			key: "title",
			width: 240,
			ellipsis: { showTitle: true },
		},
		{
			title: t("状态"),
			dataIndex: "status",
			key: "status",
			width: 100,
			render: (_, item) => <ModelStatusChip status={item.status} />,
		},
		{
			title: t("范围"),
			key: "scope",
			width: 220,
			// What the record covers: the traffic its interfaces were restored
			// from, the part of the source that was read, or both.
			render: (_, item) =>
				item.target || item.source ? (
					<div className="apimodel-scope">
						{item.target ? (
							<Text className="table-mono" title={item.target}>
								{item.target}
							</Text>
						) : null}
						{item.source ? (
							<Text className="table-mono" title={item.source}>
								{item.source}
							</Text>
						) : null}
					</div>
				) : (
					"—"
				),
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
		{ title: t("实体"), dataIndex: "entityCount", key: "entities", width: 70, align: "right" },
		{ title: t("源码映射"), dataIndex: "apiCount", key: "apis", width: 90, align: "right" },
		{ title: t("状态机"), dataIndex: "stateMachineCount", key: "stateMachines", width: 80, align: "right" },
		{ title: t("规则"), dataIndex: "ruleCount", key: "rules", width: 70, align: "right" },
		{
			title: t("时间"),
			dataIndex: "createdAt",
			key: "createdAt",
			width: 170,
			render: (_, item) => <Text type="secondary">{formatModelTime(item.createdAt)}</Text>,
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
				scroll={{ x: 1300 }}
				toolbar={{
					title: (
						<div className="apimodel-toolbar">
							<Input
								allowClear
								className="apimodel-search"
								prefix={<SearchOutlined />}
								placeholder={t("搜索名称、目标或源码范围")}
								value={search}
								onChange={(event) => setSearch(event.target.value)}
							/>
							<Select
								value={status}
								style={{ width: 120 }}
								onChange={(value) => setStatus(value as SentinelApiModelStatus | "")}
								options={MODEL_STATUS_FILTERS.map((entry) => ({ value: entry.value, label: entry.label }))}
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
									? t("还没有业务建模记录。在输入框上方点「业务建模 → 开始建模」，让 Agent 还原目标的接口，或读一遍项目的源码。")
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
