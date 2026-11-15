import type { IncomingMessage, ServerResponse } from "node:http";
import { getServerLanguage } from "./i18n.ts";
import type { SentinelGateDecision, SentinelGateFilter, SentinelGatePage } from "./protocol.ts";

type ListDecisions = (filter: SentinelGateFilter, page: number, pageSize: number) => SentinelGatePage;

function parseFilter(raw: string | null): SentinelGateFilter {
	const value: unknown = raw === null ? {} : JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid filter");
	const fields = value as Record<string, unknown>;
	const filter: SentinelGateFilter = {};
	for (const key of ["projectId", "sessionId", "source", "search"] as const) {
		if (fields[key] === undefined) continue;
		if (typeof fields[key] !== "string") throw new Error("Invalid filter");
		filter[key] = fields[key];
	}
	if (fields.decision !== undefined) {
		if (fields.decision !== "allow" && fields.decision !== "block" && fields.decision !== "failed") {
			throw new Error("Invalid decision");
		}
		filter.decision = fields.decision;
	}
	if (fields.approval !== undefined) {
		if (!Array.isArray(fields.approval)) throw new Error("Invalid approval");
		filter.approval = fields.approval.map((approval: unknown) => {
			if (approval !== "ai" && approval !== "human" && approval !== "auto") throw new Error("Invalid approval");
			return approval;
		});
	}
	if (fields.since !== undefined) {
		if (typeof fields.since !== "number" || !Number.isFinite(fields.since)) throw new Error("Invalid time");
		filter.since = fields.since;
	}
	return filter;
}

function csvRow(values: Array<string | number | boolean | null | undefined>): string {
	return `${values
		.map((value) => {
			let text = String(value ?? "");
			// Quoting alone does not prevent spreadsheet applications from evaluating formulas.
			if (typeof value === "string" && /^(?:\s*[=+@-]|[\t\r\n])/.test(text)) text = `'${text}`;
			return `"${text.replace(/"/g, '""')}"`;
		})
		.join(",")}\r\n`;
}

function decisionRow(item: SentinelGateDecision): string {
	return csvRow([
		item.id,
		new Date(item.at).toISOString(),
		item.projectId,
		item.projectName,
		item.sessionId,
		item.source,
		item.tool,
		item.command,
		item.cwd,
		item.approval,
		item.decision,
		item.reason,
		item.latencyMs,
		item.model,
		item.modelFrom,
		item.inputTokens,
		item.outputTokens,
		item.totalTokens,
		item.error,
		item.commandTruncated ?? false,
	]);
}

/** Called only after the console's gate, login and consent checks. */
export function handleGateAuditExport(request: IncomingMessage, response: ServerResponse, list: ListDecisions): void {
	const english = getServerLanguage() === "en";
	if (request.method !== "GET") {
		response.writeHead(405, { allow: "GET", "content-type": "application/json; charset=utf-8" });
		response.end(JSON.stringify({ error: english ? "Method not allowed" : "不支持的请求方法" }));
		return;
	}
	let filter: SentinelGateFilter;
	try {
		filter = parseFilter(new URL(request.url ?? "/", "http://localhost").searchParams.get("filter"));
	} catch {
		response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
		response.end(JSON.stringify({ error: english ? "Invalid export filters" : "导出筛选条件无效" }));
		return;
	}
	try {
		const headers = english
			? [
					"Record ID",
					"Time (UTC)",
					"Project ID",
					"Project",
					"Session ID",
					"Source",
					"Tool",
					"Command",
					"Working directory",
					"Approval",
					"Decision",
					"Reason",
					"Latency (ms)",
					"Model",
					"Model source",
					"Input tokens",
					"Output tokens",
					"Total tokens",
					"Error",
					"Command truncated",
				]
			: [
					"记录 ID",
					"时间（UTC）",
					"项目 ID",
					"项目",
					"会话 ID",
					"来源",
					"工具",
					"命令",
					"工作目录",
					"审批方式",
					"判定",
					"理由",
					"耗时（毫秒）",
					"模型",
					"模型来源",
					"输入 tokens",
					"输出 tokens",
					"总 tokens",
					"错误",
					"命令已截断",
				];
		const chunks = ["\uFEFF", csvRow(headers)];
		// Read every page synchronously so live judgments cannot shift offsets between pages.
		let result = list(filter, 1, 200);
		let exported = 0;
		for (;;) {
			chunks.push(...result.items.map(decisionRow));
			exported += result.items.length;
			if (exported >= result.total || result.items.length === 0) break;
			result = list(filter, result.page + 1, 200);
		}
		const filename = `approvals-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
		response.writeHead(200, {
			"content-type": "text/csv; charset=utf-8",
			"content-disposition": `attachment; filename="${filename}"`,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		});
		response.end(chunks.join(""));
	} catch {
		response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
		response.end(JSON.stringify({ error: english ? "Export failed. Please retry." : "导出失败，请重试。" }));
	}
}
