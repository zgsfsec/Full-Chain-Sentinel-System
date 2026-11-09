import type { IncomingMessage, ServerResponse } from "node:http";
import { t } from "./i18n.ts";
import { fetchRemoteModels } from "./remote-models.ts";

/** Routed after the console's gate, login and consent checks. */
export async function handleRemoteModelsApi(
	request: IncomingMessage,
	response: ServerResponse,
	agentDir: string | undefined,
	authorized: () => boolean,
): Promise<void> {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	response.on("close", cancel);
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	try {
		if (request.method !== "POST") {
			response.statusCode = 405;
			response.setHeader("allow", "POST");
			throw new Error(t("请求方法不支持。"));
		}
		if (!request.headers["content-type"]?.startsWith("application/json")) {
			response.statusCode = 415;
			throw new Error(t("请发送 JSON 请求。"));
		}
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of request.iterator({ destroyOnReturn: false })) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += bytes.length;
			if (size > 16 * 1024) {
				request.resume();
				response.statusCode = 413;
				throw new Error(t("请求内容过大。"));
			}
			chunks.push(bytes);
		}
		if (!authorized()) {
			response.statusCode = 401;
			throw new Error(t("登录或授权已失效，请刷新页面。"));
		}
		let body: unknown;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			response.statusCode = 400;
			throw new Error(t("JSON 格式错误。"));
		}
		if (
			!body ||
			typeof body !== "object" ||
			!("baseUrl" in body) ||
			typeof body.baseUrl !== "string" ||
			!("api" in body) ||
			typeof body.api !== "string" ||
			!("apiKey" in body) ||
			(typeof body.apiKey !== "string" && body.apiKey !== null) ||
			("entryId" in body && typeof body.entryId !== "string")
		) {
			response.statusCode = 400;
			throw new Error(t("请提供 Base URL、协议和 API Key 设置。"));
		}
		const result = await fetchRemoteModels(
			agentDir,
			{
				baseUrl: body.baseUrl,
				api: body.api,
				apiKey: body.apiKey,
				...("entryId" in body && typeof body.entryId === "string" ? { entryId: body.entryId } : {}),
			},
			controller.signal,
		);
		if (!response.destroyed) response.end(JSON.stringify(result));
	} catch (error) {
		if (!response.destroyed) {
			if (response.statusCode === 200) response.statusCode = 400;
			response.end(JSON.stringify({ error: error instanceof Error ? error.message : t("获取远端模型列表失败。") }));
		}
	} finally {
		response.off("close", cancel);
	}
}
