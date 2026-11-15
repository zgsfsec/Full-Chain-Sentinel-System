import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCredentialImport } from "./credential-import.ts";
import { CredentialStore } from "./credential-store.ts";
import { credentialView, failedCredential, parseCredential } from "./credential-types.ts";

export interface CredentialRef {
	id: string;
	revision: string;
}
export function parseCredentialRefs(value: unknown): CredentialRef[] {
	if (!Array.isArray(value) || !value.length || value.length > 1000) throw new Error("请选择 1–1000 条凭据");
	const seen = new Set<string>();
	return value.map((item) => {
		if (
			!item ||
			typeof item !== "object" ||
			typeof item.id !== "string" ||
			typeof item.revision !== "string" ||
			!item.id ||
			item.id.length > 128 ||
			!item.revision ||
			item.revision.length > 128 ||
			seen.has(item.id)
		)
			throw new Error("凭据选择格式错误或重复");
		seen.add(item.id);
		return { id: item.id, revision: item.revision };
	});
}
/** HTTP management of the same encrypted vault used by session-bound tools. */
export class Credentials {
	private storeValue?: CredentialStore;
	private readonly agentDir: string;
	private readonly project: (id: string) => { id: string } | undefined;
	private readonly sharedStore?: () => CredentialStore;
	constructor(
		agentDir: string,
		project: (id: string) => { id: string } | undefined,
		sharedStore?: () => CredentialStore,
	) {
		this.agentDir = agentDir;
		this.project = project;
		this.sharedStore = sharedStore;
	}
	private get store(): CredentialStore {
		if (this.sharedStore) return this.sharedStore();
		this.storeValue ??= new CredentialStore(this.agentDir);
		return this.storeValue;
	}
	purgeProject(projectId: string): void {
		this.store.purgeProject(projectId);
	}
	dispose(): void {
		this.storeValue?.close();
	}
	private version(projectId: string): string {
		return createHash("sha256")
			.update(JSON.stringify(this.store.list(projectId)))
			.digest("hex");
	}
	async handleApi(request: IncomingMessage, response: ServerResponse, authorized: () => boolean): Promise<void> {
		response.setHeader("content-type", "application/json; charset=utf-8");
		response.setHeader("cache-control", "no-store");
		try {
			if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host)
				throw new Error("请求来源不匹配");
			const url = new URL(request.url ?? "/", "http://localhost");
			const projectId = url.searchParams.get("projectId") ?? "";
			if (!this.project(projectId) || !authorized()) {
				response.statusCode = 403;
				throw new Error("项目不存在或未授权");
			}
			const action = url.pathname.slice("/api/credentials".length);
			if (request.method === "GET" && action === "") {
				response.end(JSON.stringify({ items: this.store.list(projectId).map(credentialView) }));
				return;
			}
			if (request.method !== "POST") {
				response.statusCode = 405;
				throw new Error("请求方法不支持");
			}
			if (!request.headers["content-type"]?.startsWith("application/json")) {
				response.statusCode = 415;
				throw new Error("请发送 JSON");
			}
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of request.iterator({ destroyOnReturn: false })) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				size += bytes.length;
				if (size > 3 * 1024 * 1024) {
					request.resume();
					response.statusCode = 413;
					throw new Error("请求最大 3 MB");
				}
				chunks.push(bytes);
			}
			if (!authorized() || !this.project(projectId) || response.destroyed) throw new Error("授权已失效或请求已取消");
			let value: unknown;
			try {
				value = JSON.parse(Buffer.concat(chunks).toString());
			} catch {
				throw new Error("JSON 格式错误");
			}
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求格式错误");
			const body = value as Record<string, unknown>;
			let result: unknown;
			if (action === "/save") {
				if (
					(body.id !== undefined && typeof body.id !== "string") ||
					(body.revision !== undefined && typeof body.revision !== "string")
				)
					throw new Error("凭据 ID / 版本格式错误");
				result = { items: this.store.save(projectId, [parseCredential(body.input)], body.id, body.revision) };
			} else if (action === "/import/preview" || action === "/import/apply") {
				const inputs = parseCredentialImport(body.format, body.content);
				if (action.endsWith("preview"))
					result = {
						items: this.store
							.prepare(projectId, inputs)
							.map(({ record, action: operation }) => ({ ...credentialView(record), operation })),
						version: this.version(projectId),
					};
				else {
					if (body.version !== this.version(projectId)) throw new Error("凭据已变化，请重新预览后导入");
					result = { items: this.store.save(projectId, inputs) };
				}
			} else if (action === "/confirm") {
				result = { items: this.store.confirm(projectId, parseCredentialRefs(body.refs)) };
			} else if (action === "/delete") {
				if (
					!Array.isArray(body.ids) ||
					!body.ids.length ||
					body.ids.length > 1000 ||
					!body.ids.every((id) => typeof id === "string")
				)
					throw new Error("请选择 1–1000 条凭据");
				this.store.remove(projectId, body.ids as string[]);
				result = { ok: true };
			} else if (action === "/delete-failed") {
				const failed = this.store.list(projectId).filter(failedCredential);
				const expected = failed.map((record) => `${record.id}:${record.revision}:${record.updatedAt}`).sort();
				if (!Array.isArray(body.confirm) || JSON.stringify([...body.confirm].sort()) !== JSON.stringify(expected))
					throw new Error("失败记录已变化，请刷新后重新确认");
				this.store.remove(
					projectId,
					failed.map((record) => record.id),
				);
				result = { deleted: failed.length };
			} else {
				response.statusCode = 404;
				throw new Error("接口不存在");
			}
			response.end(JSON.stringify(result));
		} catch (error) {
			if (!response.destroyed) {
				if (response.statusCode === 200) response.statusCode = 400;
				response.end(JSON.stringify({ error: error instanceof Error ? error.message : "凭据操作失败" }));
			}
		}
	}
}
