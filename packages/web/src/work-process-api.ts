import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkProcesses } from "./work-process.ts";
import type { WorkProcessRef } from "./work-process-types.ts";

/** This route is mounted behind the existing console gate, login, and consent checks. */
export async function handleWorkProcessApi(
	request: IncomingMessage,
	response: ServerResponse,
	processes: WorkProcesses | undefined,
	authorized: () => boolean,
): Promise<void> {
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	try {
		if (!processes) {
			response.statusCode = 503;
			throw new Error("工作链路需要配置数据目录");
		}
		const url = new URL(request.url ?? "/", "http://localhost");
		const path = url.pathname;
		const method = path === "/api/work-processes/control" ? "POST" : "GET";
		if (
			![
				"/api/work-processes",
				"/api/work-processes/detail",
				"/api/work-processes/control",
				"/api/work-processes/revisions",
				"/api/work-processes/evidence",
			].includes(path)
		) {
			response.statusCode = 404;
			throw new Error("工作链路接口不存在");
		}
		if (request.method !== method) {
			response.statusCode = 405;
			response.setHeader("allow", method);
			throw new Error("请求方法不支持");
		}
		const projectId = url.searchParams.get("projectId");
		const kind = url.searchParams.get("kind");
		const id = url.searchParams.get("id");
		if (!projectId || projectId.length > 200 || (kind !== "session" && kind !== "engine")) {
			response.statusCode = 400;
			throw new Error("请指定项目和对话或工程类型");
		}
		if (path === "/api/work-processes") {
			response.end(JSON.stringify({ items: await processes.list(projectId, kind) }));
			return;
		}
		if (!id || !/^[a-zA-Z0-9._:-]{1,200}$/.test(id)) {
			response.statusCode = 400;
			throw new Error("工作链路对象 id 无效");
		}
		const ref: WorkProcessRef = { projectId, kind, id };
		if (path === "/api/work-processes/evidence") {
			const result = await processes.original(ref, url.searchParams.get("evidenceId") ?? "");
			if (!authorized()) {
				response.statusCode = 401;
				throw new Error("登录或授权已失效，请刷新页面");
			}
			response.end(JSON.stringify(result));
			return;
		}
		if (path === "/api/work-processes/control") {
			if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
				response.statusCode = 415;
				throw new Error("请发送 JSON 请求");
			}
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of request.iterator({ destroyOnReturn: false })) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				size += bytes.length;
				if (size > 4096) {
					request.resume();
					response.statusCode = 413;
					throw new Error("请求内容过大");
				}
				chunks.push(bytes);
			}
			if (!authorized()) {
				response.statusCode = 401;
				throw new Error("登录或授权已失效，请刷新页面");
			}
			const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const action = body && typeof body === "object" && "action" in body ? body.action : null;
			if (action !== "enable" && action !== "pause" && action !== "analyze" && action !== "retry") {
				response.statusCode = 400;
				throw new Error("工作链路操作无效");
			}
			response.end(JSON.stringify({ process: await processes.control(ref, action) }));
			return;
		}
		const process = await processes.detail(ref);
		if (!authorized()) {
			response.statusCode = 401;
			throw new Error("登录或授权已失效，请刷新页面");
		}
		if (path === "/api/work-processes/revisions") {
			const nodeId = url.searchParams.get("nodeId") ?? "";
			if (!process.nodes.some((node) => node.id === nodeId)) {
				response.statusCode = 404;
				throw new Error("节点不存在");
			}
			response.end(JSON.stringify({ revisions: processes.revisions(ref, nodeId) }));
			return;
		}
		response.end(JSON.stringify({ process }));
	} catch (error) {
		if (!response.destroyed && !response.headersSent) {
			if (response.statusCode === 200)
				response.statusCode = error instanceof Error && /不存在/.test(error.message) ? 404 : 400;
			response.end(JSON.stringify({ error: error instanceof Error ? error.message : "工作链路请求失败" }));
		}
	}
}
