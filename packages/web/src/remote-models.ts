import { t } from "./i18n.ts";
import { NO_AUTH_PLACEHOLDER_KEY, readProviderModelConfig } from "./model-config.ts";
import {
	REMOTE_MODEL_APIS,
	type RemoteModel,
	type RemoteModelInput,
	type RemoteModelList,
} from "./remote-model-types.ts";

const MAX_MODELS = 5000;
const MAX_PAGES = 20;
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15000;

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Fetch model IDs only. Pagination, response size and elapsed time are bounded. */
export async function fetchRemoteModels(
	agentDir: string | undefined,
	input: RemoteModelInput,
	signal?: AbortSignal,
): Promise<RemoteModelList> {
	if (!(REMOTE_MODEL_APIS as readonly string[]).includes(input.api)) {
		throw new Error(t("当前协议不支持获取远端模型列表，请手动填写模型 ID。"));
	}
	let url: URL;
	try {
		url = new URL(input.baseUrl.trim());
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
	} catch {
		throw new Error(t("请填写有效的 HTTP 或 HTTPS Base URL。"));
	}
	let apiKey = input.apiKey?.trim() ?? "";
	if (input.apiKey === null && input.entryId) {
		const saved = agentDir ? readProviderModelConfig(agentDir, input.entryId) : null;
		if (!saved) throw new Error(t("这个模型没有可用的端点配置"));
		if (new URL(saved.baseUrl).origin !== url.origin) {
			throw new Error(t("端点已变化，请重新填写 API Key，或清除已保存的密钥后重试。"));
		}
		apiKey = saved.apiKey.trim();
	}
	if (apiKey === NO_AUTH_PLACEHOLDER_KEY) apiKey = "";
	url.hash = "";
	let path = url.pathname.replace(/\/+$/u, "");
	if (input.api === "anthropic-messages") {
		if (!path.endsWith("/v1")) path += "/v1";
	} else if (!path) {
		path = input.api === "google-generative-ai" ? "/v1beta" : "/v1";
	}
	url.pathname = `${path}/models`;
	const headers: Record<string, string> = { accept: "application/json" };
	if (input.api === "anthropic-messages") {
		headers["anthropic-version"] = "2023-06-01";
		if (apiKey) {
			headers["x-api-key"] = apiKey;
			headers.authorization = `Bearer ${apiKey}`;
		}
		url.searchParams.set("limit", "100");
	} else if (apiKey) {
		if (input.api === "google-generative-ai") headers["x-goog-api-key"] = apiKey;
		else headers.authorization = `Bearer ${apiKey}`;
	}
	if (input.api === "google-generative-ai") url.searchParams.set("pageSize", "1000");
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const models = new Map<string, RemoteModel>();
	const cursors = new Set<string>();
	let bytesRead = 0;
	try {
		for (let page = 0; page < MAX_PAGES; page++) {
			const response = await fetch(url, { headers, signal: combined, redirect: "manual" });
			if (!response.ok) {
				await response.body?.cancel();
				if (response.status === 401 || response.status === 403) {
					throw new Error(t("认证失败（HTTP {status}）：API Key 无效或未填写。", { status: response.status }));
				}
				if (response.status === 404 || response.status === 405) {
					throw new Error(t("端点不支持模型列表接口，请检查 Base URL，或手动填写模型 ID。"));
				}
				if (response.status >= 300 && response.status < 400) {
					throw new Error(t("模型列表接口发生重定向，请填写最终端点地址后重试。"));
				}
				throw new Error(t("获取模型列表失败（HTTP {status}），请稍后重试。", { status: response.status }));
			}
			const reader = response.body?.getReader();
			if (!reader) throw new Error(t("远端没有返回有效的模型列表。"));
			const chunks: Uint8Array[] = [];
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					bytesRead += value.byteLength;
					if (bytesRead > MAX_BYTES) throw new Error(t("远端模型列表过大，请手动填写模型 ID。"));
					chunks.push(value);
				}
			} finally {
				await reader.cancel();
			}
			let body: Record<string, unknown>;
			try {
				body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				throw new Error(t("远端没有返回有效的模型列表。"));
			}
			const google = input.api === "google-generative-ai";
			const rows = google ? body.models : body.data;
			if (!Array.isArray(rows)) throw new Error(t("远端没有返回有效的模型列表。"));
			for (const row of rows) {
				const item = record(row);
				if (
					google &&
					Array.isArray(item.supportedGenerationMethods) &&
					!item.supportedGenerationMethods.includes("generateContent")
				)
					continue;
				const rawId = google ? item.name : item.id;
				if (typeof rawId !== "string" || !rawId.trim()) continue;
				const id = google ? rawId.trim().replace(/^models\//u, "") : rawId.trim();
				if (!id || models.has(id)) continue;
				if (models.size >= MAX_MODELS) return { models: [...models.values()], truncated: true };
				const name = item.displayName ?? item.display_name ?? (google ? id : item.name);
				models.set(id, { id, name: typeof name === "string" && name.trim() ? name.trim() : id });
			}
			const cursor = google ? body.nextPageToken : body.has_more === true ? body.last_id : undefined;
			if (!google && body.has_more === true && (typeof cursor !== "string" || !cursor)) {
				throw new Error(t("远端没有返回有效的模型列表。"));
			}
			if (typeof cursor !== "string" || !cursor) return { models: [...models.values()], truncated: false };
			if (cursors.has(cursor)) return { models: [...models.values()], truncated: true };
			cursors.add(cursor);
			url.searchParams.set(google ? "pageToken" : "after_id", cursor);
		}
		return { models: [...models.values()], truncated: true };
	} catch (error) {
		if (timeout.aborted) throw new Error(t("获取模型列表超时，请检查端点连接后重试。"));
		if (error instanceof TypeError) throw new Error(t("无法连接模型列表接口，请检查地址、网络和 API Key。"));
		throw error;
	}
}
