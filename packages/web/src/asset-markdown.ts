/**
 * Markdown rendering of the asset inventory, for the console's export button.
 *
 * The report is generated on the server so the same text can be asserted in a
 * test and reused later. Export takes every asset matching the filter and every
 * timeline entry: a partial export would be a silent lie about the inventory.
 */

import { ASSET_KIND_LABELS, ASSET_OUTCOME_LABELS, ASSET_STATE_LABELS, assetPrefix } from "./asset-library.ts";
import { getServerLanguage, t } from "./i18n.ts";
import type { SentinelAsset, SentinelAssetEntry, SentinelAssetKind, SentinelVulnSummary } from "./protocol.ts";
import { SENTINEL_VULN_SEVERITY_LABELS, SENTINEL_VULN_STATUS_LABELS } from "./vulnerabilities.ts";

const KIND_ORDER: readonly SentinelAssetKind[] = ["domain", "ip", "service", "url"];

function formatTime(value: string): string {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed)
		? value
		: new Date(parsed).toLocaleString(getServerLanguage() === "zh" ? "zh-CN" : "en-US", { hour12: false });
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
}

function renderEntry(entry: SentinelAssetEntry): string[] {
	const author = entry.author === "operator" ? t("操作员") : (entry.source ?? t("代理"));
	if (entry.kind === "status") {
		return [`  - ${formatTime(entry.at)} ${author} · ${t("状态")}：${entry.text}`];
	}
	const outcome = t(ASSET_OUTCOME_LABELS[entry.outcome]);
	const method = entry.method ? ` · ${entry.method}` : "";
	const target = entry.vulnLabel ? ` · ${t("漏洞 {label}", { label: entry.vulnLabel })}` : "";
	const text = entry.text.trim();
	return [
		`  - ${formatTime(entry.at)} ${author} · ${outcome}${method}${target}${text ? `：` : ""}`,
		...(text ? [indent(text)] : []),
	];
}

function renderAsset(asset: SentinelAsset, vulns: SentinelVulnSummary[]): string[] {
	const lines: string[] = [`### ${asset.label} ${asset.name}`, ""];
	lines.push(t("- 状态：{status}", { status: t(ASSET_STATE_LABELS[asset.status]) }));
	lines.push(t("- 类型：{kind}", { kind: t(ASSET_KIND_LABELS[asset.kind]) }));
	if (asset.domain) lines.push(t("- 域名：{value}", { value: asset.domain }));
	if (asset.ip) lines.push(t("- IP：{value}", { value: asset.ip }));
	if (asset.port !== undefined) {
		lines.push(
			t("- 端口：{port}{transport}", {
				port: String(asset.port),
				transport: asset.transport ? `/${asset.transport}` : "",
			}),
		);
	}
	if (asset.protocol) lines.push(t("- 协议：{value}", { value: asset.protocol }));
	if (asset.url) lines.push(t("- URL：{value}", { value: asset.url }));
	if (asset.title) lines.push(t("- 标题：{value}", { value: asset.title }));
	if (asset.server) lines.push(t("- 服务：{value}", { value: asset.server }));
	if (asset.tech) lines.push(t("- 技术栈：{value}", { value: asset.tech }));
	if (asset.remark) lines.push(`- ${t("备注")}：\n${indent(asset.remark)}`);
	if (asset.tags.length > 0) lines.push(t("- 标签：{tags}", { tags: asset.tags.join(t("、")) }));
	lines.push(
		t("- 来源：{source}{session}", {
			source: asset.source,
			session: asset.sessionName ? t(" · 会话「{name}」", { name: asset.sessionName }) : "",
		}),
	);
	lines.push(
		t("- 首次发现：{first} · 最近发现：{last}", {
			first: formatTime(asset.firstSeenAt),
			last: formatTime(asset.lastSeenAt),
		}),
	);
	if (asset.testCount > 0) {
		lines.push(t("- 测试记录（{count} 条）：", { count: asset.testCount }));
		for (const entry of asset.entries) lines.push(...renderEntry(entry));
	} else if (asset.entries.length > 0) {
		// Status changes only: no test record, but the history still belongs in
		// the report.
		lines.push(t("- 时间线："));
		for (const entry of asset.entries) lines.push(...renderEntry(entry));
	} else {
		lines.push(t("- 测试记录：无"));
	}
	if (vulns.length > 0) {
		lines.push(t("- 关联漏洞："));
		for (const vuln of vulns) {
			lines.push(
				`  - ${vuln.label}（${t(SENTINEL_VULN_SEVERITY_LABELS[vuln.severity])} · ${t(SENTINEL_VULN_STATUS_LABELS[vuln.status])}）${vuln.title}`,
			);
		}
	}
	if (asset.lastOutcome === "vulnerable" && vulns.length === 0) {
		lines.push(t("- 注意：最近一次测试结论为「有漏洞」，但没有关联的漏洞中枢记录。"));
	}
	lines.push("");
	return lines;
}

export interface SentinelAssetReportInput {
	projectName: string;
	/** Every asset matching the export filter, with its full timeline. */
	assets: SentinelAsset[];
	/** Asset id to linked findings; one query's result. */
	vulnsByAsset: Map<string, SentinelVulnSummary[]>;
	/** Overridable so a test can assert the timestamp line. */
	generatedAt?: Date;
}

/** The report body plus a filename that identifies the project and the moment. */
export function buildAssetReport(input: SentinelAssetReportInput): { filename: string; markdown: string } {
	const generatedAt = input.generatedAt ?? new Date();
	const ordered = [...input.assets].sort((left, right) => {
		const group = KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind);
		if (group !== 0) return group;
		return right.lastSeenAt.localeCompare(left.lastSeenAt) || right.number - left.number;
	});
	const counts = new Map<SentinelAssetKind, number>();
	for (const kind of KIND_ORDER) counts.set(kind, 0);
	for (const asset of ordered) counts.set(asset.kind, (counts.get(asset.kind) ?? 0) + 1);
	const tested = ordered.filter((asset) => Boolean(asset.lastTestedAt)).length;
	const byStatus = new Map<string, number>();
	for (const asset of ordered) {
		byStatus.set(asset.status, (byStatus.get(asset.status) ?? 0) + 1);
	}
	const statusBreakdown = (["pending", "testing", "tested", "out_of_scope"] as const)
		.filter((status) => (byStatus.get(status) ?? 0) > 0)
		.map((status) => `${t(ASSET_STATE_LABELS[status])} ${byStatus.get(status) ?? 0}`)
		.join(t(" · "));

	const kindSummary = KIND_ORDER.filter((kind) => (counts.get(kind) ?? 0) > 0)
		.map((kind) => `${t(ASSET_KIND_LABELS[kind])} ${counts.get(kind) ?? 0}`)
		.join(t(" / "));

	const lines: string[] = [
		t("# 资产清单 — {project}", { project: input.projectName }),
		"",
		t("- 生成时间：{time}", {
			time: generatedAt.toLocaleString(getServerLanguage() === "zh" ? "zh-CN" : "en-US", { hour12: false }),
		}),
		t("- 项目：{project}", { project: input.projectName }),
		t("- 资产总数：{count}{kinds}", {
			count: ordered.length,
			kinds: kindSummary ? t("（{summary}）", { summary: kindSummary }) : "",
		}),
		t("- 测试情况：有结论记录 {tested} · 无结论记录 {untested}{statuses}", {
			tested,
			untested: ordered.length - tested,
			statuses: statusBreakdown ? t("（状态：{summary}）", { summary: statusBreakdown }) : "",
		}),
		"",
	];

	if (ordered.length === 0) {
		lines.push(t("本次导出没有资产记录。"), "");
	} else {
		for (const kind of KIND_ORDER) {
			const group = ordered.filter((asset) => asset.kind === kind);
			if (group.length === 0) continue;
			lines.push(`## ${t(ASSET_KIND_LABELS[kind])}`, "");
			for (const asset of group) {
				lines.push(...renderAsset(asset, input.vulnsByAsset.get(asset.id) ?? []));
			}
		}
	}

	const stamp = generatedAt.toISOString().slice(0, 16).replace(/[-:T]/g, "");
	return {
		filename: `${assetPrefix(input.projectName)}-asset-inventory-${stamp}.md`,
		markdown: `${lines
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd()}\n`,
	};
}
