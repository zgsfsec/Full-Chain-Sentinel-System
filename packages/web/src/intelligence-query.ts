import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ASSET_PLATFORMS, readAssetConfig } from "./asset-config.ts";
import { searchAssets } from "./asset-platforms.ts";
import { normalizeIntelligenceIp } from "./intelligence-input.ts";
import type { IntelligenceEngineInput } from "./intelligence-types.ts";
import type { SentinelAssetPlatform } from "./protocol.ts";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

export type IntelligenceFetch = (url: string, init?: RequestInit) => Promise<Response>;
const RDAP_HOSTS = new Set([
	"rdap.org",
	"rdap.arin.net",
	"rdap.db.ripe.net",
	"rdap.apnic.net",
	"rdap.lacnic.net",
	"rdap.afrinic.net",
]);

/** Only registry/search APIs are contacted; never connect to the reported IP. */
export async function registryJson(
	url: string,
	signal: AbortSignal,
	fetchImpl: IntelligenceFetch = fetch,
): Promise<unknown> {
	for (let redirects = 0; redirects < 5; redirects++) {
		const target = new URL(url);
		if (
			target.protocol !== "https:" ||
			target.username ||
			target.password ||
			target.port ||
			(!RDAP_HOSTS.has(target.hostname) && target.hostname !== "stat.ripe.net")
		)
			throw new Error("情报接口重定向到未允许的地址");
		const response = await fetchImpl(target.href, {
			signal,
			redirect: "manual",
			headers: { accept: "application/json" },
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			const location = response.headers.get("location");
			if (!location) throw new Error("情报接口未提供重定向地址");
			url = new URL(location, target).href;
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`情报接口 HTTP ${response.status}`);
		}
		const reader = response.body?.getReader();
		if (!reader) throw new Error("情报接口返回空响应");
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				length += next.value.byteLength;
				if (length > 262144) throw new Error("情报响应超过 256 KiB");
				chunks.push(next.value);
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	}
	throw new Error("情报接口重定向过多");
}

export function publicIntelligenceIp(ip: string): boolean {
	if (ip.includes(":")) {
		return /^[23]/.test(ip) && !ip.startsWith("2001:db8:");
	}
	const [a, b, c] = ip.split(".").map(Number);
	return (
		a > 0 &&
		a < 224 &&
		a !== 10 &&
		a !== 127 &&
		!(a === 100 && b >= 64 && b <= 127) &&
		!(a === 169 && b === 254) &&
		!(a === 172 && b >= 16 && b <= 31) &&
		!(a === 192 && b === 168) &&
		!(a === 192 && b === 0) &&
		!(a === 198 && (b === 18 || b === 19)) &&
		!(a === 198 && b === 51 && c === 100) &&
		!(a === 203 && b === 0 && c === 113)
	);
}

interface QueryRecord {
	kind: string;
	at: number;
	source: string;
	data: unknown;
}
interface QueryPlan {
	platforms: SentinelAssetPlatform[];
}

/** Durable budget and evidence; cached successes survive pause and service restart. */
export class IntelligenceQueries {
	private readonly db: SqliteDatabase;
	private readonly agentDir: string;
	private readonly fetchImpl: IntelligenceFetch;
	private readonly pending = new Map<string, Promise<QueryRecord[]>>();
	private readonly controller = new AbortController();
	private readonly purgedProjects = new Set<string>();
	private closed = false;
	constructor(agentDir: string, path: string, fetchImpl: IntelligenceFetch = fetch) {
		this.agentDir = agentDir;
		this.fetchImpl = fetchImpl;
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS plans(attempt TEXT PRIMARY KEY, project TEXT NOT NULL, payload TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS queries(attempt TEXT NOT NULL, ip TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(attempt,ip,kind));`);
	}
	close(): void {
		this.closed = true;
		this.controller.abort();
		this.db.close();
	}
	purgeProject(projectId: string): void {
		this.purgedProjects.add(projectId);
		this.db
			.prepare("DELETE FROM queries WHERE attempt IN (SELECT attempt FROM plans WHERE project=?)")
			.run(projectId);
		this.db.prepare("DELETE FROM plans WHERE project=?").run(projectId);
	}
	private plan(projectId: string, input: IntelligenceEngineInput): QueryPlan {
		if (this.closed || this.purgedProjects.has(projectId)) throw new Error("项目情报查询已关闭");
		const existing = this.db.prepare("SELECT payload FROM plans WHERE attempt=?").get(input.attemptId) as
			| { payload: string }
			| undefined;
		if (existing) return JSON.parse(existing.payload) as QueryPlan;
		const config = readAssetConfig(this.agentDir);
		const plan = {
			platforms: input.template.assets
				? ASSET_PLATFORMS.filter((id) => config.platforms[id].enabled && config.platforms[id].key)
				: [],
		};
		this.db
			.prepare("INSERT INTO plans(attempt,project,payload) VALUES (?,?,?)")
			.run(input.attemptId, projectId, JSON.stringify(plan));
		return plan;
	}
	private kinds(projectId: string, input: IntelligenceEngineInput): string[] {
		const plan = this.plan(projectId, input);
		return [...(input.template.rdap ? ["rdap", "asn"] : []), ...plan.platforms, "coverage"];
	}
	assertComplete(projectId: string, input: IntelligenceEngineInput): void {
		const kinds = this.kinds(projectId, input);
		for (const item of input.items)
			for (const kind of kinds) {
				if (
					!this.db
						.prepare("SELECT 1 FROM queries WHERE attempt=? AND ip=? AND kind=?")
						.get(input.attemptId, item.ip, kind)
				) {
					throw new Error(`请先用 ip_intelligence 查询 ${item.ip}（缺少 ${kind} 证据）`);
				}
			}
	}
	lookup(
		projectId: string,
		input: IntelligenceEngineInput,
		value: string,
		signal?: AbortSignal,
	): Promise<QueryRecord[]> {
		if (this.closed) return Promise.reject(new Error("情报查询服务已关闭"));
		const ip = normalizeIntelligenceIp(value);
		if (!input.items.some((item) => item.ip === ip)) return Promise.reject(new Error("IP 不在本批次快照内"));
		const key = `${input.attemptId}/${ip}`;
		const existing = this.pending.get(key);
		if (existing) return existing;
		const bounded = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
		const promise = this.query(projectId, input, ip, bounded).finally(() => this.pending.delete(key));
		this.pending.set(key, promise);
		return promise;
	}
	private async query(
		projectId: string,
		input: IntelligenceEngineInput,
		ip: string,
		signal?: AbortSignal,
	): Promise<QueryRecord[]> {
		const kinds = this.kinds(projectId, input);
		const results: QueryRecord[] = [];
		for (const kind of kinds) {
			signal?.throwIfAborted();
			const cached = this.db
				.prepare("SELECT payload FROM queries WHERE attempt=? AND ip=? AND kind=?")
				.get(input.attemptId, ip, kind) as { payload: string } | undefined;
			if (cached) {
				results.push(JSON.parse(cached.payload) as QueryRecord);
				continue;
			}
			let data: unknown;
			let source = kind;
			if (kind === "coverage") {
				data = {
					queried: kinds.filter((entry) => entry !== "coverage"),
					skipped: input.template.assets
						? ASSET_PLATFORMS.filter((entry) => !kinds.includes(entry))
						: ASSET_PLATFORMS,
					note: "资产平台未启用或未配置 Key 时跳过；无结果不代表无风险。",
				};
			} else if (!publicIntelligenceIp(ip)) {
				data = { status: "not_applicable", note: "非公网单播地址，不发送外部情报查询。" };
			} else {
				const spent = this.db
					.prepare("UPDATE plans SET used=used+1 WHERE attempt=? AND used<?")
					.run(input.attemptId, input.template.queryLimit);
				if (!Number(spent.changes)) throw new Error("本批次情报查询预算已用完，请调整模板后新建批次");
				const timeout = AbortSignal.timeout(90000);
				const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
				if (kind === "rdap" || kind === "asn") {
					source =
						kind === "rdap"
							? `https://rdap.org/ip/${encodeURIComponent(ip)}`
							: `https://stat.ripe.net/data/network-info/data.json?resource=${encodeURIComponent(ip)}`;
					data = await registryJson(source, bounded, this.fetchImpl);
					if (!data || typeof data !== "object") throw new Error("情报接口返回格式错误");
					const result = data as Record<string, unknown>;
					if (kind === "rdap" && !result.objectClassName && !result.startAddress)
						throw new Error("RDAP 响应缺少网络注册信息");
					if (kind === "asn" && result.status !== "ok") throw new Error("RIPEstat 查询未成功");
				} else {
					const platform = kind as SentinelAssetPlatform;
					const config = readAssetConfig(this.agentDir).platforms[platform];
					if (!config.enabled || !config.key)
						throw new Error(`${kind} 已停用或 Key 缺失，请恢复配置后手动重试批次`);
					const result = await searchAssets({
						platform,
						key: config.key,
						baseUrl: config.baseUrl,
						query: platform === "quake" ? `ip:"${ip}"` : `ip="${ip}"`,
						page: 1,
						size: input.template.resultsPerIp,
						signal: bounded,
						fetchImpl: this.fetchImpl,
					});
					source = `${platform} / ${result.query}`;
					data = {
						total: result.total,
						records: result.records.slice(0, input.template.resultsPerIp),
						quota: result.quota,
						page: 1,
					};
				}
			}
			const record = { kind, at: Date.now(), source, data };
			signal?.throwIfAborted();
			if (this.closed || this.purgedProjects.has(projectId)) throw new Error("项目情报查询已关闭");
			this.db
				.prepare("INSERT OR REPLACE INTO queries VALUES (?,?,?,?)")
				.run(input.attemptId, ip, kind, JSON.stringify(record));
			results.push(record);
		}
		return results;
	}
}
