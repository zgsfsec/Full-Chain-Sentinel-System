/**
 * The API source mapping of one record: every endpoint as the source shows it.
 *
 * A master-detail split. The list on the left answers "which endpoints are
 * there, and which of them have no check on their path"; the panel on the right
 * answers "what happens behind this endpoint": the handler, the call chain, the
 * tables it touches, the places that check the caller, and the calls it makes
 * to other services. No diagram: the chain is short and ordered, and a list
 * with a location on every line is what an auditor reads next to the source.
 *
 * The list is a list, not a table. Four columns in half the width left the path
 * two hundred pixels, so every path was cut and the list scrolled sideways;
 * two lines per endpoint give the path the whole width.
 */

import { SearchOutlined } from "@ant-design/icons";
import { Alert, Empty, Input, Pagination, Select, Tag, Typography } from "antd";
import { type ReactNode, useMemo, useState } from "react";
import { t } from "../../i18n.ts";
import type { SentinelApiSourceMapping, SentinelCodeLocation } from "../../types.ts";
import {
	authKindColor,
	authKindLabel,
	callLayerLabel,
	CodeLocation,
	externalKindLabel,
	Method,
} from "./labels.tsx";

const { Text } = Typography;

const PAGE_SIZE = 20;

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
 * A handler name in two parts: everything up to and including its last
 * separator (`.`, `@` or `::`), and the function after it.
 */
export function splitHandler(name: string): { head: string; tail: string } {
	const at = Math.max(name.lastIndexOf("."), name.lastIndexOf("@"), name.lastIndexOf("::"));
	// `::` is two characters; the others are one.
	const length = name.startsWith("::", at) ? 2 : 1;
	return at > 0 && at < name.length - length
		? { head: name.slice(0, at + length), tail: name.slice(at + length) }
		: { head: "", tail: name };
}

/**
 * A handler as a list row shows it: its class and function, without the
 * packages in front. `com.future.action.appraise.AppraiseAction.list` reads as
 * `AppraiseAction.list` there and in full on hover: a row has room for that
 * and the module, not for the whole name.
 */
export function shortHandler(name: string): string {
	const { head, tail } = splitHandler(name);
	if (!head) return tail;
	const separator = head.endsWith("::") ? "::" : head.slice(-1);
	// The class is what follows the last dot in front of it, or PHP's backslash.
	const front = head.slice(0, -separator.length);
	const owner = front.slice(Math.max(front.lastIndexOf("."), front.lastIndexOf("\\")) + 1);
	return `${owner}${separator}${tail}`;
}

function Section({ title, count, children }: { title: string; count?: string; children: ReactNode }) {
	return (
		<section className="codemodel-sec">
			<h5 className="codemodel-sec__head">
				{title}
				{count ? <span className="codemodel-sec__count">{count}</span> : null}
			</h5>
			{children}
		</section>
	);
}

/** What a section says when it has nothing to list. */
function Nothing({ children }: { children: string }) {
	return (
		<Text type="secondary" className="codemodel-sec__empty">
			{children}
		</Text>
	);
}

/** What a list of places in the code counts to. */
const places = (count: number): string => t("{count} 处", { count });

/** What a row of a section is made of. */
interface RowProps {
	/** A tag or a layer, in the slot every line of a section starts with. */
	badge?: ReactNode;
	/** What the row is about, when it is a name in the code. */
	name?: string;
	/** What the row is about, when it is a sentence. */
	text?: string;
	/** More about the name: the columns of a table, the call it goes through. */
	detail?: string;
	note?: string;
	location: SentinelCodeLocation;
}

/**
 * One row of a section: the badge, what it names, and the place in the source.
 *
 * The place comes right after what it belongs to — on the same line when the
 * name is short enough to leave it room, on the line under it when it is not —
 * and what else there is to say about the name comes after the place.
 */
function Row({ badge, name, text, detail, note, location }: RowProps) {
	return (
		<div className="codemodel-row">
			<span className="codemodel-row__badge">{badge}</span>
			<span className="codemodel-row__body">
				{name ? <span className="codemodel-row__name">{name}</span> : null}
				{text ? <span className="codemodel-row__text">{text}</span> : null}
			</span>
			<CodeLocation location={location} />
			{detail ? <span className="codemodel-row__detail">{detail}</span> : null}
			{note ? <span className="codemodel-row__note">{note}</span> : null}
		</div>
	);
}

function MappingDetail({ api }: { api: SentinelApiSourceMapping }) {
	return (
		<div className="codemodel-mapping">
			<header className="codemodel-mapping__head">
				<div className="codemodel-mapping__path">
					<Method method={api.method} />
					<span className="codemodel-mapping__title">{api.path}</span>
					{api.confidence === "inferred" ? <Tag color="orange">{t("部分为推断")}</Tag> : null}
				</div>
				{api.summary ? <div className="codemodel-mapping__summary">{api.summary}</div> : null}
				{api.module ? (
					<div className="codemodel-mapping__module">
						{t("模块")} {api.module}
					</div>
				) : null}
			</header>
			<Section title={t("入口")}>
				<Row name={api.handler.name} location={api.handler.location} />
			</Section>
			<Section title={t("调用链")} count={t("{count} 步", { count: api.callChain.length })}>
				{api.callChain.length === 0 ? (
					<Nothing>{t("入口函数之外没有更深的调用。")}</Nothing>
				) : (
					<ol className="codemodel-chain">
						{api.callChain.map((step, index) => (
							<li key={`${step.name}-${index}`} className="codemodel-step">
								<Row
									badge={<span className="codemodel-row__layer">{callLayerLabel(step.layer)}</span>}
									name={step.name}
									note={step.note}
									location={step.location}
								/>
							</li>
						))}
					</ol>
				)}
			</Section>
			<Section title={t("数据访问")} count={places(api.dataAccess.length)}>
				{api.dataAccess.length === 0 ? (
					<Nothing>{t("这条调用链不读写数据库。")}</Nothing>
				) : (
					<div className="codemodel-lines">
						{api.dataAccess.map((access, index) => (
							<Row
								key={`${access.table}-${index}`}
								badge={
									<Tag color={access.operation === "write" ? "volcano" : "default"} variant="filled">
										{access.operation === "write" ? t("写") : t("读")}
									</Tag>
								}
								name={access.table}
								detail={[(access.columns ?? []).join(", "), access.via ? t("经 {name}", { name: access.via }) : ""]
									.filter(Boolean)
									.join(" · ")}
								location={access.location}
							/>
						))}
					</div>
				)}
			</Section>
			<Section title={t("权限校验")} count={places(api.authChecks.length)}>
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
					<div className="codemodel-lines">
						{api.authChecks.map((check, index) => (
							<Row
								key={`${check.kind}-${index}`}
								badge={<Tag color={authKindColor(check.kind)}>{authKindLabel(check.kind)}</Tag>}
								text={check.note}
								location={check.location}
							/>
						))}
					</div>
				)}
			</Section>
			<Section title={t("外部调用")} count={places(api.externalCalls.length)}>
				{api.externalCalls.length === 0 ? (
					<Nothing>{t("这条调用链不调用外部服务。")}</Nothing>
				) : (
					<div className="codemodel-lines">
						{api.externalCalls.map((call, index) => (
							<Row
								key={`${call.kind}-${index}`}
								badge={<Tag>{externalKindLabel(call.kind)}</Tag>}
								name={call.target}
								note={call.note}
								location={call.location}
							/>
						))}
					</div>
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
	const [page, setPage] = useState(1);
	const [selected, setSelected] = useState<string | null>(null);

	const modules = useMemo(() => {
		const names = [...new Set(apis.map((api) => api.module ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b));
		return names.map((name) => ({ value: name, label: name }));
	}, [apis]);
	const visible = useMemo(
		() => apis.filter((api) => (!module || (api.module ?? "") === module) && mappingMatches(api, search.trim().toLowerCase())),
		[apis, module, search],
	);
	// The list can shorten under the operator (a submission, a filter): the page
	// they were on is then the last one there is, never an empty one.
	const at = Math.min(page, Math.max(1, Math.ceil(visible.length / PAGE_SIZE)));
	const shown = visible.slice((at - 1) * PAGE_SIZE, at * PAGE_SIZE);
	// A selection that a filter hid shows nothing: the first row of what is left takes over.
	const current = visible.find((api) => mappingKey(api) === selected) ?? visible[0];
	const currentKey = current ? mappingKey(current) : null;

	return (
		<div className="codemodel-split">
			<div className="codemodel-panel codemodel-panel--list">
				<div className="apimodel-toolbar codemodel-toolbar codemodel-panel__head">
					<Input
						allowClear
						className="apimodel-search"
						prefix={<SearchOutlined />}
						placeholder={t("搜索路径、入口函数或表名")}
						aria-label={t("搜索接口映射")}
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setPage(1);
						}}
					/>
					<Select
						allowClear
						placeholder={t("全部模块")}
						aria-label={t("模块")}
						style={{ width: 140 }}
						value={module || undefined}
						onChange={(value) => {
							setModule(value ?? "");
							setPage(1);
						}}
						options={modules}
					/>
					<Text type="secondary" className="codemodel-toolbar__count">
						{t("共 {n} 条", { n: visible.length })}
					</Text>
				</div>
				{shown.length === 0 ? (
					<div className="codemodel-endpoints__empty">
						<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("没有符合条件的接口映射")} />
					</div>
				) : (
					<ul className="codemodel-endpoints">
					{shown.map((api) => {
						const isSelected = mappingKey(api) === currentKey;
							return (
								<li key={mappingKey(api)}>
									<button
										type="button"
										className={isSelected ? "codemodel-endpoint is-selected" : "codemodel-endpoint"}
										aria-current={isSelected ? "true" : undefined}
										onClick={() => setSelected(mappingKey(api))}
									>
										<Method method={api.method} />
										<span className="codemodel-endpoint__path" title={api.path}>
											{api.path}
										</span>
										<span className="codemodel-endpoint__check">
											{api.authChecks.length > 0 ? (
												// The count, or the warning that there is none: the list is where
												// an unchecked endpoint is spotted.
												<span className="codemodel-endpoint__checks">
													{t("{count} 处校验", { count: api.authChecks.length })}
												</span>
											) : (
												<Tag color="warning" variant="filled">
													{t("未发现校验")}
												</Tag>
											)}
										</span>
										<span className="codemodel-endpoint__sub" title={api.handler.name}>
											<span className="codemodel-handler">{shortHandler(api.handler.name)}</span>
											{api.module ? <span className="codemodel-endpoint__module">· {api.module}</span> : null}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				)}
				{visible.length > PAGE_SIZE ? (
					<Pagination
						className="codemodel-pages"
						size="small"
						align="end"
						current={at}
						pageSize={PAGE_SIZE}
						total={visible.length}
						showSizeChanger={false}
						onChange={setPage}
					/>
				) : null}
			</div>
			<div className="codemodel-panel codemodel-panel--detail">
				{current ? (
					<MappingDetail api={current} />
				) : (
					<div className="codemodel-endpoints__empty">
						<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("选择左侧的一个接口，看它的调用链、数据访问和权限校验。")} />
					</div>
				)}
			</div>
		</div>
	);
}
