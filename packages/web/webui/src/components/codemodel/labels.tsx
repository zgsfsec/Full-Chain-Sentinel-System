/**
 * The words and colours the project-understanding panes share: what each
 * layer, check, call and rule kind is called, and how a place in the source is
 * written.
 */

import { Typography } from "antd";
import { t } from "../../i18n.ts";
import type {
	SentinelCodeApiDependency,
	SentinelCodeAuthCheck,
	SentinelCodeCallStep,
	SentinelCodeExternalCall,
	SentinelCodeLocation,
	SentinelCodeRuleKind,
} from "../../types.ts";

const { Text } = Typography;

export function callLayerLabel(layer: SentinelCodeCallStep["layer"]): string {
	const labels: Record<SentinelCodeCallStep["layer"], string> = {
		service: "Service",
		repository: "Repository",
		util: t("工具函数"),
		middleware: t("中间件"),
		other: t("其他"),
	};
	return labels[layer];
}

export function authKindLabel(kind: SentinelCodeAuthCheck["kind"]): string {
	const labels: Record<SentinelCodeAuthCheck["kind"], string> = {
		authentication: t("登录校验"),
		authorization: t("权限校验"),
		ownership: t("资源归属校验"),
		other: t("其他"),
	};
	return labels[kind];
}

export function authKindColor(kind: SentinelCodeAuthCheck["kind"]): string {
	const colors: Record<SentinelCodeAuthCheck["kind"], string> = {
		authentication: "geekblue",
		authorization: "blue",
		ownership: "cyan",
		other: "default",
	};
	return colors[kind];
}

export function externalKindLabel(kind: SentinelCodeExternalCall["kind"]): string {
	const labels: Record<SentinelCodeExternalCall["kind"], string> = {
		http: t("HTTP 请求"),
		rpc: t("RPC 调用"),
		mq: t("消息队列"),
		cache: t("缓存"),
		file: t("文件读写"),
		other: t("其他"),
	};
	return labels[kind];
}

export const RULE_KINDS: readonly SentinelCodeRuleKind[] = ["precondition", "postcondition", "invariant", "ownership"];

export function ruleKindLabel(kind: SentinelCodeRuleKind): string {
	const labels: Record<SentinelCodeRuleKind, string> = {
		precondition: t("前置条件"),
		postcondition: t("后置条件"),
		invariant: t("业务不变量"),
		ownership: t("资源所有权"),
	};
	return labels[kind];
}

export function ruleKindColor(kind: SentinelCodeRuleKind): string {
	const colors: Record<SentinelCodeRuleKind, string> = {
		precondition: "gold",
		postcondition: "green",
		invariant: "purple",
		ownership: "cyan",
	};
	return colors[kind];
}

export function dependencyKindLabel(kind: SentinelCodeApiDependency["kind"]): string {
	const labels: Record<SentinelCodeApiDependency["kind"], string> = {
		calls: t("调用"),
		requires: t("依赖"),
		triggers: t("触发"),
		mutates: t("修改数据"),
		other: t("其他"),
	};
	return labels[kind];
}

const METHOD_COLORS: Record<string, string> = {
	GET: "green",
	POST: "blue",
	PUT: "orange",
	PATCH: "gold",
	DELETE: "red",
	ANY: "purple",
};

export function methodColor(method: string): string {
	return METHOD_COLORS[method.toUpperCase()] ?? "default";
}

/** A location as text, the way the operator reads and copies it: `/work/...:42` or `/work/...:42-60`. */
export function codeLocationText(location: SentinelCodeLocation): string {
	return `${location.file}:${location.line}${location.endLine !== undefined ? `-${location.endLine}` : ""}`;
}

const fileName = (file: string) => file.slice(file.lastIndexOf("/") + 1);

/** A location in a table cell: the file's name and the line, the whole path on hover, one click to copy the whole path. */
export function CodeLocationBrief({ location }: { location: SentinelCodeLocation }) {
	const text = codeLocationText(location);
	const short = `${fileName(location.file)}:${location.line}${location.endLine !== undefined ? `-${location.endLine}` : ""}`;
	return (
		<Text code copyable={{ text, tooltips: false }} className="codemodel-loc codemodel-loc--brief" title={text}>
			{short}
		</Text>
	);
}

/** A location in running text: the whole path, copyable. */
export function CodeLocationFull({ location }: { location: SentinelCodeLocation }) {
	const text = codeLocationText(location);
	return (
		<Text code copyable={{ text, tooltips: false }} className="codemodel-loc" title={text}>
			{location.file}
			{location.endLine !== undefined ? `:${location.line}-${location.endLine}` : `:${location.line}`}
		</Text>
	);
}

/** Several locations in one cell: the first in full brief form, the rest counted. */
export function CodeLocationList({ locations }: { locations: SentinelCodeLocation[] }) {
	if (locations.length === 0) return <>—</>;
	const rest = locations.slice(1);
	return (
		<span className="codemodel-locs">
			<CodeLocationBrief location={locations[0]} />
			{rest.length > 0 ? (
				<Text type="secondary" title={rest.map(codeLocationText).join("\n")}>
					{t("另 {count} 处", { count: rest.length })}
				</Text>
			) : null}
		</span>
	);
}
