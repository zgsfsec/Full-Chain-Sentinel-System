import type { IncomingMessage, ServerResponse } from "node:http";
import { ReportTemplateStore, validateReportTemplate } from "./report-templates.ts";

/** Routed under /api/reports so the normal login and consent gates apply. */
export async function handleReportTemplateApi(
	request: IncomingMessage,
	response: ServerResponse,
	agentDir: string,
	projectExists: (id: string) => boolean,
	authorized: () => boolean,
): Promise<void> {
	const json = (body: unknown, status = 200) => {
		response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		response.end(JSON.stringify(body));
	};
	const url = new URL(request.url ?? "/", "http://localhost");
	const parts = url.pathname.slice("/api/reports/templates".length).split("/").filter(Boolean);
	const projectId = url.searchParams.get("projectId");
	let body: Record<string, unknown> = {};
	if (request.method !== "GET") {
		if (!request.headers["content-type"]?.startsWith("application/json")) {
			json({ error: "请发送 JSON 请求。" }, 415);
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of request.iterator({ destroyOnReturn: false })) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += bytes.length;
			if (size > 400 * 1024) {
				json({ error: "请求内容过大。" }, 413);
				return;
			}
			chunks.push(bytes);
		}
		try {
			const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
			body = parsed as Record<string, unknown>;
		} catch {
			json({ error: "JSON 格式错误。" }, 400);
			return;
		}
	}
	if (!authorized()) {
		json({ error: "登录或授权已失效，请刷新页面。" }, 401);
		return;
	}
	if (projectId !== null && !projectExists(projectId)) {
		json({ error: "项目不存在，请重新选择。" }, 409);
		return;
	}
	const store = new ReportTemplateStore(agentDir);
	try {
		if (parts.length === 0 && request.method === "GET") {
			json({ items: store.list(), defaultTemplateId: projectId ? store.defaultId(projectId) : null });
			return;
		}
		if (parts.length === 1 && parts[0] === "default" && request.method === "PUT") {
			if (!projectId) {
				json({ error: "请先选择项目。" }, 409);
				return;
			}
			if (body.templateId !== null && typeof body.templateId !== "string") {
				json({ error: "请提供模板编号，或使用 null 取消默认模板。" }, 400);
				return;
			}
			if (typeof body.templateId === "string" && !store.get(body.templateId)) {
				json({ error: "模板不存在或已删除。" }, 404);
				return;
			}
			store.setDefault(projectId, body.templateId);
			json({ defaultTemplateId: body.templateId });
			return;
		}
		if (
			(parts.length === 0 && request.method === "POST") ||
			(parts.length === 1 && request.method === "PUT" && parts[0] !== "default")
		) {
			if (typeof body.name !== "string" || typeof body.markdown !== "string") {
				json({ error: "请提供模板名称和 Markdown 正文。" }, 400);
				return;
			}
			try {
				validateReportTemplate(body.name, body.markdown);
			} catch (error) {
				json({ error: error instanceof Error ? error.message : String(error) }, 400);
				return;
			}
			if (request.method === "POST") {
				json(store.create(body.name, body.markdown), 201);
				return;
			}
			if (typeof body.revision !== "string") {
				json({ error: "请提供模板原始版本。" }, 400);
				return;
			}
			const updated = store.update(parts[0], body.revision, body.name, body.markdown);
			if (!updated) {
				json({ error: "模板已被修改或删除。请复制草稿，重新打开模板后合并修改。" }, 409);
				return;
			}
			json(updated);
			return;
		}
		if (parts.length === 1 && parts[0] !== "default") {
			const template = store.get(parts[0]);
			if (!template) {
				json({ error: "模板不存在或已删除。" }, 404);
				return;
			}
			if (request.method === "GET") {
				json(template);
				return;
			}
			if (request.method === "DELETE") {
				json({ ok: store.delete(template.id) });
				return;
			}
		}
		json({ error: "没有这个模板接口或请求方法不支持。" }, 405);
	} finally {
		store.close();
	}
}
