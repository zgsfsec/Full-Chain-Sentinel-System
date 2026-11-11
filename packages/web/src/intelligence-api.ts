import type { IncomingMessage, ServerResponse } from "node:http";
import type { IntelligenceManager } from "./intelligence.ts";
import { INTELLIGENCE_API_GUIDE } from "./intelligence-docs.ts";
import {
	IntelligenceError,
	normalizeIntelligenceIp,
	objectValue,
	parseIntelligencePolicy,
	parseIntelligencePush,
	textValue,
} from "./intelligence-input.ts";
import type { IntelligenceCleanup } from "./intelligence-types.ts";

function reply(response: ServerResponse, data: unknown, status = 200): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(data));
}

async function body(request: IncomingMessage): Promise<unknown> {
	if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? ""))
		throw new IntelligenceError("Content-Type 必须是 application/json", 415);
	const chunks: Buffer[] = [];
	let size = 0;
	const timer = setTimeout(() => request.destroy(), 15000);
	try {
		for await (const chunk of request.iterator({ destroyOnReturn: false })) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += bytes.length;
			if (size > 1048576) {
				request.resume();
				throw new IntelligenceError("正文超过 1 MiB", 413);
			}
			chunks.push(bytes);
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		} catch {
			throw new IntelligenceError("正文不是合法 JSON");
		}
	} finally {
		clearTimeout(timer);
	}
}

export async function handleIntelligenceIngest(
	request: IncomingMessage,
	response: ServerResponse,
	manager: IntelligenceManager | undefined,
): Promise<void> {
	let release: (() => void) | undefined;
	try {
		if (!manager) throw new IntelligenceError("情报服务未就绪", 503);
		if (request.method !== "POST") throw new IntelligenceError("仅支持 POST", 405);
		const token = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1] ?? "";
		const authenticated = manager.store.authenticate(token);
		if (!authenticated) throw new IntelligenceError("Token 无效或数据源已停用", 401);
		release = manager.beginIngest(authenticated.id);
		const input = parseIntelligencePush(await body(request));
		// Recheck after reading: rotating/revoking a token takes effect immediately.
		const source = manager.store.authenticate(token);
		if (!source) throw new IntelligenceError("Token 无效或数据源已停用", 401);
		reply(response, manager.store.ingest(source, input));
		manager.run();
	} catch (error) {
		if (error instanceof IntelligenceError && error.status === 429) response.setHeader("retry-after", "60");
		reply(
			response,
			{ error: error instanceof Error ? error.message : String(error) },
			error instanceof IntelligenceError ? error.status : 500,
		);
	} finally {
		release?.();
	}
}

export async function handleIntelligenceApi(
	request: IncomingMessage,
	response: ServerResponse,
	manager: IntelligenceManager | undefined,
	projectExists: (id: string) => boolean,
	authorized: () => boolean,
): Promise<void> {
	try {
		if (!manager) throw new IntelligenceError("情报服务未就绪", 503);
		const url = new URL(request.url ?? "/", "http://localhost");
		const projectId = textValue(url.searchParams.get("projectId"), "projectId");
		const check = () => {
			if (!authorized()) throw new IntelligenceError("会话已过期", 401);
			if (!projectExists(projectId)) throw new IntelligenceError("项目不存在", 404);
		};
		check();
		const route = url.pathname.slice("/api/intelligence/".length);
		const store = manager.store;
		const page = Number(url.searchParams.get("page") ?? 1);
		if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new IntelligenceError("page 非法");
		if (request.method === "GET") {
			if (route === "sources") return reply(response, store.sources(projectId));
			if (route === "policy") return reply(response, store.policy(projectId));
			if (route === "doctrines") return reply(response, store.doctrines());
			if (route === "guide") return reply(response, { text: INTELLIGENCE_API_GUIDE });
			if (route === "ips")
				return reply(
					response,
					store.indicators(projectId, page, 50, (url.searchParams.get("search") ?? "").slice(0, 80)),
				);
			if (route === "alerts")
				return reply(response, store.alerts(projectId, normalizeIntelligenceIp(url.searchParams.get("ip")), page));
			if (route === "batches") return reply(response, store.batches(projectId, page));
			if (route.startsWith("batches/")) {
				const batch = store.batch(projectId, route.slice(8));
				if (!batch) throw new IntelligenceError("批次不存在", 404);
				return reply(response, batch);
			}
		} else if (request.method === "POST") {
			const input = objectValue(await body(request));
			check();
			if (route === "sources")
				return reply(response, store.createSource(projectId, textValue(input.name, "name", 120)));
			if (route.startsWith("sources/")) {
				if (typeof input.enabled !== "boolean" || typeof input.rotate !== "boolean")
					throw new IntelligenceError("enabled / rotate 必须是布尔值");
				return reply(response, store.updateSource(projectId, route.slice(8), input.enabled, input.rotate));
			}
			if (route === "policy") {
				const policy = parseIntelligencePolicy(input);
				store.savePolicy(projectId, policy);
				manager.run();
				return reply(response, store.policy(projectId));
			}
			if (route.startsWith("batches/")) {
				const parts = route.split("/");
				if (parts.length !== 3) throw new IntelligenceError("无效批次路径");
				await manager.action(projectId, parts[1], parts[2]);
				return reply(response, { ok: true });
			}
			if (route === "clear") {
				if (input.confirmProjectId !== projectId) throw new IntelligenceError("请确认清空当前项目情报");
				store.clear(projectId);
				return reply(response, { ok: true });
			}
			if (route === "cleanup" || route === "cleanup/preview") {
				const filters: IntelligenceCleanup = {};
				if (input.sourceId !== undefined) {
					filters.sourceId = textValue(input.sourceId, "sourceId");
					if (!store.sources(projectId).some((source) => source.id === filters.sourceId))
						throw new IntelligenceError("数据源不存在", 404);
				}
				for (const key of ["before", "after"] as const)
					if (input[key] !== undefined) {
						if (typeof input[key] !== "number" || !Number.isSafeInteger(input[key]) || input[key] < 0)
							throw new IntelligenceError(`${key} 必须是毫秒时间戳`);
						filters[key] = input[key];
					}
				if (filters.after !== undefined && filters.before !== undefined && filters.after > filters.before)
					throw new IntelligenceError("时间范围起止顺序错误");
				return reply(response, store.cleanup(projectId, filters, route === "cleanup"));
			}
		}
		throw new IntelligenceError("接口不存在", 404);
	} catch (error) {
		reply(
			response,
			{ error: error instanceof Error ? error.message : String(error) },
			error instanceof IntelligenceError ? error.status : 500,
		);
	}
}
