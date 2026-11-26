/**
 * The API source mapping of one record: every endpoint as the source shows it.
 *
 * A master-detail split. The list on the left answers "which endpoints are
 * there, and which of them have no check on their path"; the panel on the right
 * answers "what happens behind this endpoint": the handler, the call chain, the
 * tables it touches, the places that check the caller, and the calls it makes
 * to other services. No diagram: the chain is short and ordered, and a list
 * with a location on every line is what an auditor reads next to the source.
 */

import { SearchOutlined } from "@ant-design/icons";
import { Alert, Empty, Input, Select, Space, Table, Tag, Typography } from "antd";
import { type ReactNode, useMemo, useState } from "react";
import { t } from "../../i18n.ts";
import type { SentinelApiSourceMapping } from "../../types.ts";
import {
	authKindColor,
	authKindLabel,
	callLayerLabel,
	CodeLocationFull,
	externalKindLabel,
	methodColor,
} from "./labels.tsx";

const { Text } = Typography;

/** The key an endpoint is stored and selected under. */
export const mappingKey = (api: SentinelApiSourceMapping): string => `${api.method} ${api.path}`;

/** Whether an endpoint is about what was typed: its path, handler, tables, or anything in its chain. */
export function mappingMatches(api: SentinelApiSourceMapping, needle: string): boolean {
	if (!needle) return true;
	const haystack = [
		`${api.method} ${api.path}`,
		api.handler.name,
		api.handler.location.file,
		api.module ?? "",
		api.summary ?? "",
		api.notes ?? "",
		...api.callChain.map((step) => `${step.name} ${step.location.file}`),
		...api.dataAccess.map((access) => `${access.table} ${(access.columns ?? []).join(" ")}`),
		...api.externalCalls.map((call) => call.target),
	]
		.join("\n")
		.toLowerCase();
	return haystack.includes(needle);
}

/**
 * A handler name in two parts: the class or file in front, and the function at
 * the end. In a narrow cell the front is what gives way, so `OrderController.getOrder`
 * stays readable as `OrderCon…getOrder` instead of losing the function.
 */
export function splitHandler(name: string): { head: string; tail: string } {
	const at = Math.max(name.lastIndexOf("."), name.lastIndexOf("@"), name.lastIndexOf("::"));
	// `::` is two characters; the others are one.
	const length = name.startsWith("::", at) ? 2 : 1;
	return at > 0 && at < name.length - length
		? { head: name.slice(0, at + length), tail: name.slice(at + length) }
		: { head: "", tail: name };
}

function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
	return (
		<div className="codemodel-sec">
			<div className="codemodel-sec__head">
				<Text strong>{title}</Text>
				{extra}
			</div>
			{children}
		</div>
	);
}

function MappingDetail({ api }: { api: SentinelApiSourceMapping }) {
	return (
		<div className="codemodel-mapping">
			<Space wrap align="center" className="codemodel-mapping__title">
				<Tag color={methodColor(api.method)} variant="filled">
					{api.method}
				</Tag>
				<Text code className="codemodel-path">
					{api.path}
				</Text>
				{api.confidence === "inferred" ? <Tag color="orange">{t("部分为推断")}</Tag> : null}
			</Space>
			{api.summary ? <Text strong>{api.summary}</Text> : null}
			{api.module ? (
				<Text type="secondary">
					{t("模块")} {api.module}
				</Text>
			) : null}
			<Section title={t("入口")}>
				<div className="codemodel-line">
					<Text code>{api.handler.name}</Text>
					<CodeLocationFull location={api.handler.location} />
				</div>
			</Section>
			<Section title={t("调用链")} extra={<Text type="secondary">{t("{count} 步", { count: api.callChain.length })}</Text>}>
				{api.callChain.length === 0 ? (
					<Text type="secondary">{t("入口函数之外没有更深的调用。")}</Text>
				) : (
					<ol className="codemodel-chain">
						{api.callChain.map((step, index) => (
							<li key={`${step.name}-${index}`} className="codemodel-line">
								<Tag>{callLayerLabel(step.layer)}</Tag>
								<Text code>{step.name}</Text>
								<CodeLocationFull location={step.location} />
								{step.note ? <Text type="secondary">{step.note}</Text> : null}
							</li>
						))}
					</ol>
				)}
			</Section>
			<Section title={t("数据访问")} extra={<Text type="secondary">{t("{count} 处", { count: api.dataAccess.length })}</Text>}>
				{api.dataAccess.length === 0 ? (
					<Text type="secondary">{t("这条调用链不读写数据库。")}</Text>
				) : (
					<ul className="codemodel-lines">
						{api.dataAccess.map((access, index) => (
							<li key={`${access.table}-${index}`} className="codemodel-line">
								<Tag color={access.operation === "write" ? "volcano" : "default"} variant="filled">
									{access.operation === "write" ? t("写") : t("读")}
								</Tag>
								<Text code>{access.table}</Text>
								{access.columns && access.columns.length > 0 ? (
									<span className="codemodel-tags">
										{access.columns.map((column) => (
											<Tag key={column}>{column}</Tag>
										))}
									</span>
								) : null}
								{access.via ? <Text type="secondary">{t("经 {name}", { name: access.via })}</Text> : null}
								<CodeLocationFull location={access.location} />
							</li>
						))}
					</ul>
				)}
			</Section>
			<Section title={t("权限校验")} extra={<Text type="secondary">{t("{count} 处", { count: api.authChecks.length })}</Text>}>
				{api.authChecks.length === 0 ? (
					// An empty list is the agent's finding, not a gap in the model: it is
					// the first thing an auditor wants to see, so it is said out loud.
					<Alert
						type="warning"
						showIcon
						title={t("未发现权限校验")}
						description={t("整条调用链上没有找到登录、权限或资源归属的校验。审计时先看这里。")}
					/>
				) : (
					<ul className="codemodel-lines">
						{api.authChecks.map((check, index) => (
							<li key={`${check.kind}-${index}`} className="codemodel-line">
								<Tag color={authKindColor(check.kind)}>{authKindLabel(check.kind)}</Tag>
								{check.note ? <Text>{check.note}</Text> : null}
								<CodeLocationFull location={check.location} />
							</li>
						))}
					</ul>
				)}
			</Section>
			<Section title={t("外部调用")} extra={<Text type="secondary">{t("{count} 处", { count: api.externalCalls.length })}</Text>}>
				{api.externalCalls.length === 0 ? (
					<Text type="secondary">{t("这条调用链不调用外部服务。")}</Text>
				) : (
					<ul className="codemodel-lines">
						{api.externalCalls.map((call, index) => (
							<li key={`${call.kind}-${index}`} className="codemodel-line">
								<Tag>{externalKindLabel(call.kind)}</Tag>
								<Text code>{call.target}</Text>
								{call.note ? <Text type="secondary">{call.note}</Text> : null}
								<CodeLocationFull location={call.location} />
							</li>
						))}
					</ul>
				)}
			</Section>
			{api.notes ? (
				<Section title={t("备注")}>
					<Text>{api.notes}</Text>
				</Section>
			) : null}
		</div>
	);
}

export function CodeModelApiPane({ apis }: { apis: SentinelApiSourceMapping[] }) {
	const [search, setSearch] = useState("");
	const [module, setModule] = useState<string>("");
	const [selected, setSelected] = useState<string | null>(null);

	const modules = useMemo(() => {
		const names = [...new Set(apis.map((api) => api.module ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b));
		return names.map((name) => ({ value: name, label: name }));
	}, [apis]);
	const visible = useMemo(
		() => apis.filter((api) => (!module || (api.module ?? "") === module) && mappingMatches(api, search.trim().toLowerCase())),
		[apis, module, search],
	);
	// A selection that a filter hid shows nothing: the first row of what is left takes over.
	const current = visible.find((api) => mappingKey(api) === selected) ?? visible[0];
	const currentKey = current ? mappingKey(current) : null;

	return (
		<div className="codemodel-split">
			<div className="codemodel-split__list">
				<div className="apimodel-toolbar codemodel-toolbar">
					<Input
						allowClear
						className="apimodel-search"
						prefix={<SearchOutlined />}
						placeholder={t("搜索路径、入口函数或表名")}
						aria-label={t("搜索接口映射")}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
					<Select
						allowClear
						placeholder={t("全部模块")}
						aria-label={t("模块")}
						style={{ width: 150 }}
						value={module || undefined}
						onChange={(value) => setModule(value ?? "")}
						options={modules}
					/>
					<Text type="secondary">{t("共 {n} 条", { n: visible.length })}</Text>
				</div>
				<Table<SentinelApiSourceMapping>
					rowKey={mappingKey}
					size="small"
					dataSource={visible}
					pagination={{ pageSize: 20, size: "small", showSizeChanger: false, hideOnSinglePage: true }}
					rowClassName={(api) => (mappingKey(api) === currentKey ? "codemodel-row is-selected" : "codemodel-row")}
					onRow={(api) => ({
						onClick: () => setSelected(mappingKey(api)),
						style: { cursor: "pointer" },
					})}
					locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("没有符合条件的接口映射")} /> }}
						columns={[
							{
								title: t("方法"),
								dataIndex: "method",
								key: "method",
								width: 76,
								render: (method: string) => (
									<Tag color={methodColor(method)} variant="filled">
										{method}
									</Tag>
								),
							},
							{
								title: t("路径"),
								key: "path",
								// The list is read by its path, so the path is the column that
								// takes the width the others leave; the module rides under it
								// rather than taking a column of its own.
								render: (_: unknown, api: SentinelApiSourceMapping) => (
									<div className="codemodel-endpoint">
										<Text code className="codemodel-endpoint__path" title={api.path}>
											{api.path}
										</Text>
										{api.module ? (
											<Text type="secondary" className="codemodel-endpoint__module">
												{api.module}
											</Text>
										) : null}
									</div>
								),
							},
							{
								title: t("入口"),
								dataIndex: ["handler", "name"],
								key: "handler",
								width: 150,
								render: (name: string) => {
									const { head, tail } = splitHandler(name);
									return (
										<Text code className="codemodel-handler" title={name}>
											{head ? <span className="codemodel-handler__head">{head}</span> : null}
											<span className="codemodel-handler__tail">{tail}</span>
										</Text>
									);
								},
							},
							{
								title: t("校验"),
								dataIndex: "authChecks",
								key: "authChecks",
								width: 84,
							// The count, or the warning that there is none: the list is where
							// an unchecked endpoint is spotted.
							render: (checks: SentinelApiSourceMapping["authChecks"]) =>
								checks.length > 0 ? (
									<Tag variant="filled">{t("{count} 处", { count: checks.length })}</Tag>
								) : (
									<Tag color="warning" variant="filled">
										{t("未发现")}
									</Tag>
								),
						},
					]}
				/>
			</div>
			<div className="codemodel-split__detail">
				{current ? (
					<MappingDetail api={current} />
				) : (
					<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("选择左侧的一个接口，看它的调用链、数据访问和权限校验。")} />
				)}
			</div>
		</div>
	);
}
