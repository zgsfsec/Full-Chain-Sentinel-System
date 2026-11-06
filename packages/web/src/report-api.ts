import type { IncomingMessage, ServerResponse } from "node:http";
import { portableReportMarkdown, reportZip, validateReportEdit } from "./report-content.ts";
import type { ReportSource } from "./report-types.ts";
import type { ReportStore } from "./reports.ts";

function json(response: ServerResponse, body: unknown, status = 200): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}

/** The server applies its normal gate, session and consent checks before routing here. */
export async function handleReportApi(
	request: IncomingMessage,
	response: ServerResponse,
	store: ReportStore,
	projectExists: (id: string) => boolean,
	authorized: () => boolean = () => true,
): Promise<void> {
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
		if (parts.length === 1 && request.method === "PUT") {
			if (!request.headers["content-type"]?.startsWith("application/json")) {
				json(response, { error: "请发送 JSON 请求。" }, 415);
				return;
			}
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of request.iterator({ destroyOnReturn: false })) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				size += bytes.length;
				// A 1 MB Markdown body may use six-byte JSON escapes for control characters.
				if (size > 6 * 1024 * 1024 + 4096) {
					json(response, { error: "请求内容过大。" }, 413);
					return;
				}
				chunks.push(bytes);
			}
			if (!authorized()) {
				json(response, { error: "登录或授权已失效，请刷新页面。" }, 401);
				return;
			}
			if (!projectExists(projectId)) {
				json(response, { error: "项目已删除，无法保存报告。" }, 409);
				return;
			}
			let body: unknown;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				json(response, { error: "JSON 格式错误。" }, 400);
				return;
			}
			if (
				!body ||
				typeof body !== "object" ||
				!("title" in body) ||
				typeof body.title !== "string" ||
				!("markdown" in body) ||
				typeof body.markdown !== "string" ||
				!("revision" in body) ||
				typeof body.revision !== "string"
			) {
				json(response, { error: "请提供报告标题、Markdown 正文和原始版本。" }, 400);
				return;
			}
			try {
				validateReportEdit(report, body.title, body.markdown);
			} catch (error) {
				json(response, { error: error instanceof Error ? error.message : String(error) }, 400);
				return;
			}
			const updated = store.updateText(projectId, id, body.revision, body.title.trim(), body.markdown);
			if (!updated) {
				json(response, { error: "报告已被修改或删除。请复制当前草稿，取消编辑并刷新后再合并修改。" }, 409);
				return;
			}
			json(response, updated);
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
		if (response.destroyed) return;
		json(response, { error: error instanceof Error ? error.message : String(error) }, 500);
	}
}
