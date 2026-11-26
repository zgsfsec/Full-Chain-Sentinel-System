/**
 * The words and colours the source panes share: what each layer, check, call
 * and rule kind is called, and how a place in the source is written.
 */

import { CheckOutlined, CopyOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { createContext, useContext, useState } from "react";
import { t } from "../../i18n.ts";
import type {
	SentinelCodeApiDependency,
	SentinelCodeAuthCheck,
	SentinelCodeCallStep,
	SentinelCodeExternalCall,
	SentinelCodeLocation,
	SentinelCodeRuleKind,
} from "../../types.ts";

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

const METHOD_TONES = ["get", "post", "put", "patch", "delete", "any"] as const;

/** The tone a method is written in; `other` is every method the list does not know. */
export function methodTone(method: string): (typeof METHOD_TONES)[number] | "other" {
	const tone = method.toLowerCase();
	return (METHOD_TONES as readonly string[]).includes(tone) ? (tone as (typeof METHOD_TONES)[number]) : "other";
}

/** A method as coloured, fixed-width text, so the paths beside it line up. */
export function Method({ method }: { method: string }) {
	return <span className={`codemodel-method codemodel-method--${methodTone(method)}`}>{method}</span>;
}

/** A location as text, the way the operator reads and copies it: `/work/...:42` or `/work/...:42-60`. */
export function codeLocationText(location: SentinelCodeLocation): string {
	return `${location.file}:${location.line}${location.endLine !== undefined ? `-${location.endLine}` : ""}`;
}

/**
 * The deepest directory every file is under, without its trailing slash:
 * `/work/src` for `/work/src/a/A.java` and `/work/src/b/B.java`.
 *
 * Empty when there is nothing to shorten by: no files, a file with no
 * directory, or files that share nothing above `/`.
 */
export function commonRoot(files: readonly string[]): string {
	let prefix: string | undefined;
	for (const file of new Set(files)) {
		// The directory with its trailing slash, so the shared part always ends between two segments.
		const dir = file.slice(0, file.lastIndexOf("/") + 1);
		if (prefix === undefined) {
			prefix = dir;
			continue;
		}
		let at = 0;
		while (at < prefix.length && at < dir.length && prefix[at] === dir[at]) at++;
		prefix = prefix.slice(0, at);
	}
	// `/work/a/` and `/work/b/` share `/work/`; `/work/a/` and `/work2/` share only `/wo`, so cut back to a slash.
	const root = (prefix ?? "").slice(0, (prefix ?? "").lastIndexOf("/") + 1);
	return root.length > 1 ? root.slice(0, -1) : "";
}

/** A file's path against the root: its directory there, trailing slash included, and its name. */
export function locationParts(file: string, root: string): { dir: string; file: string } {
	const path = root && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
	const at = path.lastIndexOf("/");
	return at < 0 ? { dir: "", file: path } : { dir: path.slice(0, at + 1), file: path.slice(at + 1) };
}

/**
 * The directory a record's locations are shown relative to. Empty, the
 * default, means absolute paths: a pane rendered on its own shortens nothing.
 */
export const LocationRootContext = createContext<string>("");

/**
 * Put `text` on the clipboard. Where the Clipboard API is missing or refused —
 * a console opened over plain HTTP on a network address — a hidden field and
 * the older copy command still work.
 */
async function copyText(text: string): Promise<boolean> {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Refused: the older way below may still be allowed.
		}
	}
	const field = document.createElement("textarea");
	field.value = text;
	field.style.position = "fixed";
	field.style.opacity = "0";
	document.body.appendChild(field);
	field.select();
	const copied = document.execCommand("copy");
	field.remove();
	return copied;
}

/**
 * The button that copies `text` and shows a tick for a moment. It sits in a
 * `codemodel-loc`, whose rules keep it out of sight until the line is hovered.
 */
export function CopyIcon({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			type="text"
			size="small"
			className={copied ? "codemodel-loc__copy is-copied" : "codemodel-loc__copy"}
			aria-label={copied ? t("已复制") : t("复制")}
			title={copied ? t("已复制") : t("复制")}
			icon={copied ? <CheckOutlined /> : <CopyOutlined />}
			onClick={() => {
				void copyText(text).then((done) => {
					if (!done) return;
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1500);
				});
			}}
		/>
	);
}

/**
 * A place in the source, on one line: the directory in faint print, the file's
 * name and the line in normal print. The name gives way only when it alone is
 * wider than the line; the line number never does. The directory is shown
 * whole or not at all — a line too narrow for it shows the name and the line.
 *
 * What is shown is relative to the record's root; what is hovered and copied
 * is the whole absolute path, which is what gets pasted back to an agent.
 */
export function CodeLocation({ location }: { location: SentinelCodeLocation }) {
	const root = useContext(LocationRootContext);
	const text = codeLocationText(location);
	const { dir, file } = locationParts(location.file, root);
	const line = location.endLine !== undefined ? `:${location.line}-${location.endLine}` : `:${location.line}`;
	return (
		<span className="codemodel-loc" title={text}>
			<span className="codemodel-loc__path">
				{dir ? <span className="codemodel-loc__dir">{dir}</span> : null}
				<span className="codemodel-loc__file">{file}</span>
				<span className="codemodel-loc__line">{line}</span>
			</span>
			<CopyIcon text={text} />
		</span>
	);
}

/** Several locations in one cell: the first in full, the rest counted. */
export function CodeLocationList({ locations }: { locations: SentinelCodeLocation[] }) {
	if (locations.length === 0) return <>—</>;
	const rest = locations.slice(1);
	return (
		<span className="codemodel-locs">
			<CodeLocation location={locations[0]} />
			{rest.length > 0 ? (
				<span className="codemodel-loc__more" title={rest.map(codeLocationText).join("\n")}>
					{t("另 {count} 处", { count: rest.length })}
				</span>
			) : null}
		</span>
	);
}
