import type { IncomingMessage, ServerResponse } from "node:http";
import { portableReportMarkdown, reportZip } from "./report-content.ts";
import type { ReportSource } from "./report-types.ts";
import type { ReportStore } from "./reports.ts";

function json(response: ServerResponse, body: unknown, status = 200): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}

/** The server applies its normal gate, session and consent checks before routing here. */
export function handleReportApi(
	request: IncomingMessage,
	response: ServerResponse,
	store: ReportStore,
	projectExists: (id: string) => boolean,
): void {
	try {
		const url = new URL(request.url ?? "/", "http://localhost");
		const projectId = url.searchParams.get("projectId") ?? "";
		if (!projectId || !projectExists(projectId)) {
			json(response, { error: "请选择一个存在的项目。" }, 409);
			return;
		}
		const parts = url.pathname.slice("/api/reports".length).split("/").filter(Boolean);
		if (parts.length === 0 && request.method === "GET") {
			const source = url.searchParams.get("source") ?? "";
			if (source && !["session", "goal", "engine"].includes(source)) {
				json(response, { error: "报告来源无效。" }, 400);
				return;
			}
			const page = Number(url.searchParams.get("page") ?? 1);
			if (!Number.isSafeInteger(page) || page < 1) {
				json(response, { error: "页码无效。" }, 400);
				return;
			}
			json(
				response,
				store.list(projectId, {
					search: (url.searchParams.get("search") ?? "").slice(0, 200),
					source: source ? (source as ReportSource) : undefined,
					page,
				}),
			);
			return;
		}
		const id = parts[0] ?? "";
		if (!/^[0-9a-f-]{36}$/i.test(id)) {
			json(response, { error: "报告不存在。" }, 404);
			return;
		}
		const report = store.get(projectId, id);
		if (!report) {
			json(response, { error: "报告不存在或已删除。" }, 404);
			return;
		}
		if (parts.length === 1 && request.method === "DELETE") {
			if (!request.headers["content-type"]?.startsWith("application/json")) {
				json(response, { error: "删除请求必须使用 JSON 格式。" }, 415);
				return;
			}
			json(response, { ok: store.delete(projectId, id) });
			return;
		}
		if (request.method !== "GET") {
			json(response, { error: "请求方法不支持。" }, 405);
			return;
		}
		if (parts.length === 1) {
			json(response, report);
			return;
		}
		if (parts.length === 3 && parts[1] === "images") {
			const image = store.image(projectId, id, parts[2]);
			if (!image) {
				json(response, { error: "报告图片不存在。" }, 404);
				return;
			}
			response.writeHead(200, {
				"content-type": image.mimeType,
				"content-length": image.data.length,
				"cache-control": "private, no-store",
				"x-content-type-options": "nosniff",
				"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
			});
			response.end(image.data);
			return;
		}
		if (parts.length === 2 && parts[1] === "download") {
			const filename = report.title.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 100) || "report";
			const files = [{ name: "report.md", data: Buffer.from(portableReportMarkdown(report), "utf8") }];
			for (const image of report.images) {
				const saved = store.image(projectId, id, image.id);
				if (!saved) throw new Error("报告图片缺失，无法下载完整报告。");
				files.push({ name: `images/${image.filename}`, data: Buffer.from(saved.data) });
			}
			const zipped = report.imageCount > 0;
			const body = zipped ? reportZip(files) : files[0].data;
			response.writeHead(200, {
				"content-type": zipped ? "application/zip" : "text/markdown; charset=utf-8",
				"content-length": body.length,
				"content-disposition": `attachment; filename="report.${zipped ? "zip" : "md"}"; filename*=UTF-8''${encodeURIComponent(`${filename}.${zipped ? "zip" : "md"}`)}`,
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			});
			response.end(body);
			return;
		}
		json(response, { error: "没有这个报告接口。" }, 404);
	} catch (error) {
		json(response, { error: error instanceof Error ? error.message : String(error) }, 500);
	}
}
