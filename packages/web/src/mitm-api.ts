import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { MitmCenter } from "./mitm.ts";
import { getMitmFlow, MitmError, mitmRawPath } from "./mitm-store.ts";

/** Mounted behind the console's gate, login and consent checks. */
export async function handleMitmApi(
	request: IncomingMessage,
	response: ServerResponse,
	center: MitmCenter | undefined,
	context: { project: () => { id: string } | null; authorized: () => boolean },
): Promise<void> {
	response.setHeader("cache-control", "no-store");
	response.setHeader("x-content-type-options", "nosniff");
	const json = (value: unknown, status = 200) => {
		response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
		response.end(JSON.stringify(value));
	};
	try {
		if (!center) throw new MitmError("控制台未配置数据目录。", 503);
		const url = new URL(request.url ?? "/", "http://localhost");
		const path = url.pathname.slice("/api/mitm".length);
		let body: Record<string, unknown> = {};
		if (request.method === "POST") {
			if (!request.headers["content-type"]?.startsWith("application/json"))
				throw new MitmError("请发送 JSON 请求。", 415);
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of request.iterator({ destroyOnReturn: false })) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				size += bytes.length;
				const limit =
					path === "/webfuzz/workspace" ? 16 * 1024 * 1024 : path === "/webfuzz/send" ? 4 * 1024 * 1024 : 16384;
				if (size > limit) throw new MitmError("请求内容过大。", 413);
				chunks.push(bytes);
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				throw new MitmError("JSON 格式错误。");
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MitmError("请求格式错误。");
			body = parsed as Record<string, unknown>;
		}
		// Check again after body streaming: logout or project switching may have happened meanwhile.
		if (!context.authorized()) throw new MitmError("登录已失效，请重新登录。", 401);
		const id = request.method === "POST" ? body.projectId : url.searchParams.get("projectId");
		if (typeof id !== "string" || !id || context.project()?.id !== id)
			throw new MitmError("当前项目已变更，请刷新页面。", 409);
		const directory = center.directory(id);
		if (request.method === "GET") {
			if (path === "/storage") {
				json(await center.storage(id));
				return;
			}
			if (path === "/webfuzz") {
				json(center.webFuzzState(id));
				return;
			}
			if (path === "" || path === "/") {
				json(await center.status(id));
				return;
			}
			if (path === "/flows") {
				json(await center.listFlows(id, url.searchParams));
				return;
			}
			if (path === "/ca.pem" || path === "/ca.crt") {
				const format = path.endsWith("pem") ? "pem" : "crt";
				const cert = center.certificate(id, format);
				response.writeHead(200, {
					"content-type": "application/octet-stream",
					"content-disposition": `attachment; filename="mitm-ca.${format}"`,
				});
				response.end(cert);
				return;
			}
			const match = /^\/flows\/([a-zA-Z0-9_-]{1,100})(?:\/(request|response))?$/.exec(path);
			if (match) {
				if (!match[2]) {
					json(await getMitmFlow(directory, match[1], await center.reader(id)));
					return;
				}
				const raw = await mitmRawPath(directory, match[1], match[2], await center.reader(id));
				response.writeHead(200, {
					"content-type": "application/octet-stream",
					"content-disposition": `attachment; filename="${match[1]}-${match[2]}.bin"`,
				});
				await pipeline(createReadStream(raw), response);
				return;
			}
		} else if (request.method === "POST") {
			if (path === "/webfuzz/workspace") {
				center.saveWebFuzzState(id, body);
				json({ ok: true });
				return;
			}
			if (path === "/webfuzz/import") {
				json(await center.importWebFuzz(id, body.flowId));
				return;
			}
			if (path === "/webfuzz/send") {
				const controller = new AbortController();
				const abort = () => controller.abort();
				response.once("close", abort);
				try {
					json(
						await center.replay(id, body.request, body.password, controller.signal, () => {
							if (!context.authorized()) throw new MitmError("登录已失效，请重新登录。", 401);
							if (context.project()?.id !== id) throw new MitmError("当前项目已变更，请刷新页面。", 409);
						}),
					);
				} finally {
					response.removeListener("close", abort);
				}
				return;
			}
			if (path === "/config") {
				json(await center.save(id, body));
				return;
			}
			if (path === "/start") {
				json(await center.start(id));
				return;
			}
			if (path === "/stop") {
				json(await center.stop(id));
				return;
			}
			if (path === "/clear") {
				if (body.confirm !== true) throw new MitmError("请确认清空流量记录。");
				await center.clear(id);
				json({ ok: true });
				return;
			}
			if (path === "/flows/delete") {
				if (body.confirm !== true) throw new MitmError("请确认删除选中的流量记录。");
				json({ ok: true, deleted: await center.deleteFlows(id, body.ids) });
				return;
			}
		}
		throw new MitmError("接口不存在或请求方法错误。", 404);
	} catch (error) {
		if (response.destroyed) return;
		if (response.headersSent) {
			response.destroy();
			return;
		}
		if (!(error instanceof MitmError)) console.error("[mitm]", error);
		json(
			{ error: error instanceof MitmError ? error.message : "MITM 操作失败，请检查服务日志。" },
			error instanceof MitmError ? error.status : 500,
		);
	}
}
