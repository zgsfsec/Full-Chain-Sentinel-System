/**
 * The business logic model of one record: what the source enforces beyond what
 * each endpoint does.
 *
 * Five lists, one tab each. The first is called 源码实体 here because the record
 * also holds the business entities of its interface document, under a tab of
 * their own. A state machine is a table of its transitions — from, to, what
 * triggers the change, what has to hold first and what it writes — because that
 * table is what an auditor reads a skipped state or a missing guard off. No
 * diagram: the console has no graph library, and five states with their guards
 * do not need one.
 */

import { ArrowRightOutlined, SearchOutlined } from "@ant-design/icons";
import { Card, Collapse, Empty, Input, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import { useMemo, useState } from "react";
import { t } from "../../i18n.ts";
import type {
	SentinelBusinessLogicModel,
	SentinelCodeApiDependency,
	SentinelCodeEntity,
	SentinelCodeRelation,
	SentinelCodeRule,
	SentinelCodeStateMachine,
	SentinelCodeTransition,
} from "../../types.ts";
import { CodeLocationList, dependencyKindLabel, RULE_KINDS, ruleKindColor, ruleKindLabel } from "./labels.tsx";

const { Text } = Typography;

const PAGE = { pageSize: 50, size: "small" as const, showSizeChanger: false, hideOnSinglePage: true };
const EMPTY = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("这一部分还没有内容。")} />;

/** Whether a list item mentions what was typed, anywhere in how it is stored. */
function mentions(item: unknown, needle: string): boolean {
	return !needle || JSON.stringify(item).toLowerCase().includes(needle);
}

function EntitiesTable({ entities }: { entities: SentinelCodeEntity[] }) {
	const [search, setSearch] = useState("");
	const visible = useMemo(() => entities.filter((entity) => mentions(entity, search.trim().toLowerCase())), [entities, search]);
	return (
		<>
			<div className="apimodel-toolbar codemodel-toolbar">
				<Input
					allowClear
					className="apimodel-search"
					prefix={<SearchOutlined />}
					placeholder={t("搜索实体、表名或归属方")}
					aria-label={t("搜索实体")}
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</div>
			<Table<SentinelCodeEntity>
				rowKey="name"
				size="small"
				dataSource={visible}
				pagination={PAGE}
				locale={{ emptyText: entities.length === 0 ? EMPTY : undefined }}
				columns={[
					{ title: t("实体"), dataIndex: "name", key: "name", width: 180, render: (name: string) => <Text strong>{name}</Text> },
					{ title: t("对应的表"), dataIndex: "table", key: "table", width: 180, ellipsis: true, render: (value?: string) => (value ? <Text className="table-mono" title={value}>{value}</Text> : "—") },
					{
						title: t("资源归属"),
						dataIndex: "owner",
						key: "owner",
						width: 140,
						ellipsis: true,
						// Who owns the records is the first question of an authorization review.
						render: (value?: string) => (value ? <Tag color="cyan">{value}</Tag> : "—"),
					},
					{
						title: t("字段"),
						dataIndex: "fields",
						key: "fields",
						render: (fields?: SentinelCodeEntity["fields"]) =>
							fields && fields.length > 0 ? (
								<span className="codemodel-tags">
									{fields.map((field) => (
										<Tag key={field.name} title={field.meaning}>
											{field.name}
										</Tag>
									))}
								</span>
							) : (
								"—"
							),
					},
					{ title: t("说明"), dataIndex: "description", key: "description", ellipsis: true, render: (value?: string) => value ?? "—" },
					{ title: t("位置"), dataIndex: "locations", key: "locations", width: 244, render: (locations) => <CodeLocationList locations={locations} /> },
				]}
			/>
		</>
	);
}

function RelationsTable({ relations }: { relations: SentinelCodeRelation[] }) {
	return (
		<Table<SentinelCodeRelation>
			rowKey={(relation) => `${relation.from}|${relation.to}|${relation.kind}`}
			size="small"
			dataSource={relations}
			pagination={PAGE}
			locale={{ emptyText: relations.length === 0 ? EMPTY : undefined }}
			columns={[
				{ title: t("起点"), dataIndex: "from", key: "from", width: 180, render: (from: string) => <Text strong>{from}</Text> },
				{ title: t("关系"), dataIndex: "kind", key: "kind", width: 110, render: (kind: string) => <Tag variant="filled">{kind}</Tag> },
				{ title: t("终点"), dataIndex: "to", key: "to", width: 180, render: (to: string) => <Text strong>{to}</Text> },
				{ title: t("说明"), dataIndex: "description", key: "description", ellipsis: true, render: (value?: string) => value ?? "—" },
				{ title: t("位置"), dataIndex: "locations", key: "locations", width: 244, render: (locations) => <CodeLocationList locations={locations} /> },
			]}
		/>
	);
}

export function StateMachines({ machines }: { machines: SentinelCodeStateMachine[] }) {
	if (machines.length === 0) return EMPTY;
	return (
		// Open from the start: a state machine is here to be read, and there are
		// rarely more than a handful of them.
		<Collapse
			size="small"
			defaultActiveKey={machines.map((machine) => machine.subject)}
			className="codemodel-machines"
			items={machines.map((machine) => ({
				key: machine.subject,
				label: (
					<Space size={8} wrap>
						<Text strong>{machine.subject}</Text>
						{machine.field ? <Text className="table-mono">{machine.field}</Text> : null}
						<Text type="secondary">
							{t("{states} 个状态 · {transitions} 条迁移", {
								states: machine.states.length,
								transitions: machine.transitions.length,
							})}
						</Text>
					</Space>
				),
				children: (
					<div className="codemodel-machine">
						<div className="codemodel-line">
							<Text type="secondary">{t("状态")}</Text>
							<span className="codemodel-tags">
								{machine.states.map((state) => (
									<Tag key={state.name} color={state.name === machine.initial ? "green" : undefined} title={state.meaning}>
										{state.name}
										{state.name === machine.initial ? ` · ${t("初始")}` : ""}
									</Tag>
								))}
							</span>
						</div>
						{machine.description ? <Text>{machine.description}</Text> : null}
						<Table
							rowKey={(transition, index) => `${transition.from}>${transition.to}|${index}`}
							size="small"
							dataSource={machine.transitions}
							pagination={PAGE}
							locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("没有记录到状态迁移。")} /> }}
							// One transition is one move from a state to the next: it reads as one, not as two tags to pair up.
							columns={[
								{
									title: t("迁移"),
									key: "transition",
									width: 220,
									render: (_: unknown, transition: SentinelCodeTransition) => (
										<span className="codemodel-transition">
											<span>{transition.from}</span>
											<ArrowRightOutlined />
											<span>{transition.to}</span>
										</span>
									),
								},
								{
									title: t("触发"),
									dataIndex: "trigger",
									key: "trigger",
									width: 320,
									ellipsis: true,
									render: (value?: string) => (value ? <Text className="table-mono" title={value}>{value}</Text> : "—"),
								},
								{
									title: t("前置条件"),
									dataIndex: "guard",
									key: "guard",
									// A transition with no guard is where a skipped state shows.
									render: (value?: string) =>
										value ? (
											<span title={value}>{value}</span>
										) : (
											<Text type="warning">{t("未记录")}</Text>
										),
								},
								{
									title: t("结果"),
									dataIndex: "effect",
									key: "effect",
									ellipsis: true,
									render: (value?: string) => (value ? <span title={value}>{value}</span> : "—"),
								},
								{
									title: t("位置"),
									dataIndex: "locations",
									key: "locations",
									width: 244,
									render: (locations) => <CodeLocationList locations={locations} />,
								},
							]}
						/>
						<div className="codemodel-line">
							<Text type="secondary">{t("定义位置")}</Text>
							<CodeLocationList locations={machine.locations} />
						</div>
					</div>
				),
			}))}
		/>
	);
}

function RulesTable({ rules }: { rules: SentinelCodeRule[] }) {
	const [kind, setKind] = useState<SentinelCodeRule["kind"] | "">("");
	const [search, setSearch] = useState("");
	const visible = useMemo(
		() => rules.filter((rule) => (!kind || rule.kind === kind) && mentions(rule, search.trim().toLowerCase())),
		[rules, kind, search],
	);
	return (
		<>
			<div className="apimodel-toolbar codemodel-toolbar">
				<Input
					allowClear
					className="apimodel-search"
					prefix={<SearchOutlined />}
					placeholder={t("搜索规则、对象或接口")}
					aria-label={t("搜索业务规则")}
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
				<Select
					allowClear
					placeholder={t("全部类型")}
					aria-label={t("规则类型")}
					style={{ width: 140 }}
					value={kind || undefined}
					onChange={(value) => setKind(value ?? "")}
					options={RULE_KINDS.map((value) => ({ value, label: ruleKindLabel(value) }))}
				/>
			</div>
			<Table<SentinelCodeRule>
				rowKey="id"
				size="small"
				dataSource={visible}
				pagination={PAGE}
				locale={{ emptyText: rules.length === 0 ? EMPTY : undefined }}
				// Every table cell is one line in this console, so the statement is
				// the column the width goes to, and the whole of it is the tooltip.
				columns={[
					{
						title: t("类型"),
						dataIndex: "kind",
						key: "kind",
						width: 110,
						render: (value: SentinelCodeRule["kind"]) => <Tag color={ruleKindColor(value)}>{ruleKindLabel(value)}</Tag>,
					},
					{
						title: t("对象"),
						dataIndex: "subject",
						key: "subject",
						width: 240,
						ellipsis: true,
						render: (subject: string) => (
							<Text strong title={subject}>
								{subject}
							</Text>
						),
					},
					{
						title: t("规则"),
						dataIndex: "statement",
						key: "statement",
						render: (statement: string, rule) => (
							<span title={rule.note ? `${statement}（${rule.note}）` : statement}>
								<Text>{statement}</Text>
								{rule.note ? <Text type="secondary">（{rule.note}）</Text> : null}
							</span>
						),
					},
					{
						title: t("涉及接口"),
						dataIndex: "apis",
						key: "apis",
						width: 290,
						render: (apis?: string[]) =>
							apis && apis.length > 0 ? (
									<span className="codemodel-apis">
										{apis.map((api) => (
											<span key={api} title={api}>
												{api}
											</span>
										))}
									</span>
							) : (
								"—"
							),
					},
					{ title: t("位置"), dataIndex: "locations", key: "locations", width: 220, render: (locations) => <CodeLocationList locations={locations} /> },
				]}
			/>
		</>
	);
}

function DependenciesTable({ dependencies }: { dependencies: SentinelCodeApiDependency[] }) {
	return (
		<Table<SentinelCodeApiDependency>
			rowKey={(dependency) => `${dependency.from}|${dependency.to}|${dependency.kind}`}
			size="small"
			dataSource={dependencies}
			pagination={PAGE}
			locale={{ emptyText: dependencies.length === 0 ? EMPTY : undefined }}
			columns={[
				{
					title: t("起点"),
					dataIndex: "from",
					key: "from",
					width: 240,
					ellipsis: true,
					render: (from: string) => (
						<Text className="table-mono" title={from}>
							{from}
						</Text>
					),
				},
				{ title: t("关系"), dataIndex: "kind", key: "kind", width: 110, render: (kind) => <Tag variant="filled">{dependencyKindLabel(kind)}</Tag> },
				{
					title: t("终点"),
					dataIndex: "to",
					key: "to",
					width: 240,
					ellipsis: true,
					render: (to: string) => (
						<Text className="table-mono" title={to}>
							{to}
						</Text>
					),
				},
				{ title: t("说明"), dataIndex: "description", key: "description", ellipsis: true, render: (value?: string) => value ?? "—" },
				{ title: t("位置"), dataIndex: "locations", key: "locations", width: 248, render: (locations) => <CodeLocationList locations={locations} /> },
			]}
		/>
	);
}

type LogicTab = "entities" | "relations" | "stateMachines" | "rules" | "apiDependencies";

export function CodeModelLogicPane({ logic }: { logic: SentinelBusinessLogicModel }) {
	const [tab, setTab] = useState<LogicTab>("entities");
	// The count is a numeral beside the label, not a chip: a row of chips is not what the tabs are about.
	const count = (value: number) => (value > 0 ? <span className="apimodel-tab-count">{value}</span> : null);
	return (
		<div className="codemodel-logic">
			<Tabs
				size="small"
				activeKey={tab}
				onChange={(key) => setTab(key as LogicTab)}
				items={[
					{
						key: "entities",
						label: (
							<Space size={6}>
								{t("源码实体")}
								{count(logic.entities.length)}
							</Space>
						),
						children: <Card size="small">{logic.entities.length === 0 ? EMPTY : <EntitiesTable entities={logic.entities} />}</Card>,
					},
					{
						key: "relations",
						label: (
							<Space size={6}>
								{t("实体关系")}
								{count(logic.relations.length)}
							</Space>
						),
						children: <Card size="small"><RelationsTable relations={logic.relations} /></Card>,
					},
					{
						key: "stateMachines",
						label: (
							<Space size={6}>
								{t("状态机")}
								{count(logic.stateMachines.length)}
							</Space>
						),
						children: <StateMachines machines={logic.stateMachines} />,
					},
					{
						key: "rules",
						label: (
							<Space size={6}>
								{t("业务规则")}
								{count(logic.rules.length)}
							</Space>
						),
						children: <Card size="small">{logic.rules.length === 0 ? EMPTY : <RulesTable rules={logic.rules} />}</Card>,
					},
					{
						key: "apiDependencies",
						label: (
							<Space size={6}>
								{t("跨接口依赖")}
								{count(logic.apiDependencies.length)}
							</Space>
						),
						children: <Card size="small"><DependenciesTable dependencies={logic.apiDependencies} /></Card>,
					},
				]}
			/>
		</div>
	);
}
