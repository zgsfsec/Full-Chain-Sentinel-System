/**
 * The project-level asset inventory: what the agent actually touched, and what
 * was tested on it.
 *
 * One row is one reachable endpoint: a bare domain, a bare IP, an IP:port
 * service, or a URL. Re-reporting the same endpoint merges into the existing row
 * instead of creating a second one; the identity fields never change after
 * creation, so the label a finding cites stays stable.
 *
 * Storage lives in the agent directory, not the project working directory: the
 * work directory is mounted into the container, and a shell command could
 * otherwise rewrite the inventory. Rows are project-scoped and removed with
 * their project, the same way the vulnerability hub works.
 *
 * There is no cap on the number of assets, records, or exported rows. Listing is
 * paginated because it is a read of one screen, not because the store has a
 * maximum; the detail and the export take everything.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import type {
	SentinelAsset,
	SentinelAssetEntry,
	SentinelAssetFilters,
	SentinelAssetKind,
	SentinelAssetOutcome,
	SentinelAssetState,
	SentinelAssetStats,
	SentinelAssetSummary,
	SentinelAssetUpdate,
} from "./protocol.ts";
import { openSqliteDatabase, type SqliteDatabase, type SqliteValue } from "./sqlite.ts";

export const ASSET_KINDS: readonly SentinelAssetKind[] = ["domain", "ip", "service", "url"];
export const ASSET_STATES: readonly SentinelAssetState[] = ["pending", "testing", "tested", "out_of_scope"];
export const ASSET_OUTCOMES: readonly SentinelAssetOutcome[] = [
	"note",
	"clean",
	"suspicious",
	"vulnerable",
	"unreachable",
];

/** Chinese labels used by the tools, the report and the page. */
export const ASSET_KIND_LABELS: Record<SentinelAssetKind, string> = {
	domain: "域名",
	ip: "IP",
	service: "服务",
	url: "URL",
};

export const ASSET_STATE_LABELS: Record<SentinelAssetState, string> = {
	pending: "待测试",
	testing: "测试中",
	tested: "已测试",
	out_of_scope: "范围外",
};

export const ASSET_OUTCOME_LABELS: Record<SentinelAssetOutcome, string> = {
	note: "备注",
	clean: "无发现",
	suspicious: "可疑",
	vulnerable: "有漏洞",
	unreachable: "不可达",
};

/** Page size ceiling is a rendering control, not a storage limit. */
export const MAX_ASSET_PAGE_SIZE = 200;
export const DEFAULT_ASSET_PAGE_SIZE = 50;

export function isAssetKind(value: unknown): value is SentinelAssetKind {
	return typeof value === "string" && (ASSET_KINDS as readonly string[]).includes(value);
}

export function isAssetState(value: unknown): value is SentinelAssetState {
	return typeof value === "string" && (ASSET_STATES as readonly string[]).includes(value);
}

export function isAssetOutcome(value: unknown): value is SentinelAssetOutcome {
	return typeof value === "string" && (ASSET_OUTCOMES as readonly string[]).includes(value);
}

/** Zeroed counts, used when no project is selected. */
export function emptyAssetStats(): SentinelAssetStats {
	return {
		total: 0,
		byKind: { domain: 0, ip: 0, service: 0, url: 0 },
		byStatus: { pending: 0, testing: 0, tested: 0, out_of_scope: 0 },
		tested: 0,
		untested: 0,
	};
}

export function assetLibraryDbPath(agentDir: string): string {
	return join(agentDir, "asset-library.db");
}

/** Human-readable label prefix derived from the project name. */
export function assetPrefix(projectName: string): string {
	const slug = projectName
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9\u4e00-\u9fa5]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 20);
	return slug || "ASSET";
}

export function assetLabel(prefix: string, number: number): string {
	return `${prefix}-A${String(number).padStart(4, "0")}`;
}

/** Input that is structurally wrong; the message is shown to the model as-is. */
export class AssetInputError extends Error {}

export interface AssetIdentityInput {
	url?: string;
	ip?: string;
	domain?: string;
	port?: number;
	transport?: "tcp" | "udp";
	protocol?: string;
}

export interface AssetEntryInput {
	author: "agent" | "operator";
	/** Agent-side provenance; operator entries leave it empty. */
	source?: string;
	outcome: SentinelAssetOutcome;
	/** Command or method used. */
	method?: string;
	/** Observation text; empty is allowed for a bare outcome. */
	text: string;
	/** Set by the vulnerability link. */
	vulnLabel?: string;
}

export interface AssetUpsertInput {
	projectId: string;
	projectName: string;
	source: string;
	sessionId?: string;
	engineId?: string;
	taskId?: string;
	sessionName?: string;
	identity: AssetIdentityInput;
	title?: string;
	server?: string;
	tech?: string;
	tags?: string[];
	/** Optional first observation, written as an agent record. */
	record?: Pick<AssetEntryInput, "outcome" | "method" | "text">;
}

export interface AssetUpsertResult {
	created: boolean;
	asset: SentinelAsset;
	warnings: string[];
}

interface ResolvedIdentity {
	kind: SentinelAssetKind;
	name: string;
	dedupeKey: string;
	host: string;
	domain?: string;
	ip?: string;
	port?: number;
	transport?: "tcp" | "udp";
	protocol?: string;
	url?: string;
	warnings: string[];
}

interface AssetRow {
	id: string;
	label: string;
	number: number;
	project_id: string;
	project_name: string;
	kind: string;
	name: string;
	dedupe_key: string;
	host: string;
	domain: string | null;
	ip: string | null;
	port: number | null;
	transport: string | null;
	protocol: string | null;
	url: string | null;
	title: string | null;
	server: string | null;
	tech: string | null;
	tags: string;
	status: string;
	source: string;
	session_id: string | null;
	engine_id: string | null;
	task_id: string | null;
	session_name: string | null;
	test_count: number;
	last_outcome: string | null;
	last_tested_at: string | null;
	first_seen_at: string;
	last_seen_at: string;
	created_at: string;
	updated_at: string;
}

interface EntryRow {
	seq: number;
	kind: string;
	at: string;
	author: string;
	source: string | null;
	outcome: string;
	method: string | null;
	text: string;
	vuln_label: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS asset_library (
  id             TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  number         INTEGER NOT NULL,
  project_id     TEXT NOT NULL,
  project_name   TEXT NOT NULL,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  dedupe_key     TEXT NOT NULL,
  host           TEXT NOT NULL,
  domain         TEXT,
  ip             TEXT,
  port           INTEGER,
  transport      TEXT,
  protocol       TEXT,
  url            TEXT,
  title          TEXT,
  server         TEXT,
  tech           TEXT,
  tags           TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'pending',
  source         TEXT NOT NULL,
  session_id     TEXT,
  engine_id      TEXT,
  task_id        TEXT,
  session_name   TEXT,
  test_count     INTEGER NOT NULL DEFAULT 0,
  last_outcome   TEXT,
  last_tested_at TEXT,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE(project_id, dedupe_key),
  UNIQUE(project_id, label)
);
CREATE INDEX IF NOT EXISTS idx_asset_library_project
  ON asset_library(project_id, last_seen_at DESC, number DESC);
CREATE INDEX IF NOT EXISTS idx_asset_library_kind
  ON asset_library(project_id, kind, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_library_status
  ON asset_library(project_id, status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS asset_library_entries (
  asset_id   TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'record',
  at         TEXT NOT NULL,
  author     TEXT NOT NULL,
  source     TEXT,
  outcome    TEXT NOT NULL,
  method     TEXT,
  text       TEXT NOT NULL,
  vuln_label TEXT,
  PRIMARY KEY (asset_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_asset_library_entries_asset ON asset_library_entries(asset_id, seq);

CREATE TABLE IF NOT EXISTS asset_library_sequences (
  project_id  TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL
);
`;

function optional(value: string | null | undefined): string | undefined {
	return value === null || value === undefined || value === "" ? undefined : value;
}

/** Trim a single-line field; a page title does not need embedded newlines. */
function lineText(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/g, " ").trim();
	return text === "" ? undefined : text;
}

/** Trim a block field but keep its line breaks: test notes are evidence. */
function blockText(value: string | undefined): string {
	if (typeof value !== "string") return "";
	return value.replace(/\r\n/g, "\n").trim();
}

/** Tags are comma-separated on the wire and in the operator's input box. */
export function normalizeTags(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const tags: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		for (const part of item.split(/[,，]/)) {
			const tag = part.trim();
			if (tag === "") continue;
			const key = tag.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			tags.push(tag);
		}
	}
	return tags;
}

function parseTags(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		return normalizeTags(parsed);
	} catch {
		// A hand-edited row falls back to "no tags" rather than failing the page.
		return [];
	}
}

function normalizeProtocol(raw: string | undefined): string | undefined {
	const value = lineText(raw)?.replace(/:$/, "").toLowerCase();
	if (!value) return undefined;
	if (!/^[a-z0-9][a-z0-9+._-]*$/.test(value)) {
		throw new AssetInputError(`协议格式不合法：${raw}。用 http、https、ssh、rdp 这类服务名。`);
	}
	return value;
}

function normalizePort(value: number): number {
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new AssetInputError(`端口必须在 1-65535 之间，收到 ${value}。`);
	}
	return value;
}

function normalizeTransport(raw: string | undefined): "tcp" | "udp" {
	const value = (lineText(raw) ?? "tcp").toLowerCase();
	if (value !== "tcp" && value !== "udp") {
		throw new AssetInputError(`transport 只能是 tcp 或 udp，收到 ${raw}。`);
	}
	return value;
}

function canonicalIp(raw: string): string {
	const value = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
	if (isIP(value) === 0) {
		throw new AssetInputError(`${raw} 不是合法 IP；网段请逐条上报具体地址，不要用 CIDR（如 10.0.0.0/24）。`);
	}
	if (isIP(value) === 6) {
		try {
			const hostname = new URL(`http://[${value}]/`).hostname;
			return hostname.slice(1, -1).toLowerCase();
		} catch {
			return value.toLowerCase();
		}
	}
	return value;
}

function canonicalDomain(raw: string): string {
	let value = raw.trim().toLowerCase();
	if (value.endsWith(".")) value = value.slice(0, -1);
	if (value === "") throw new AssetInputError("域名为空。");
	if (value.includes("*")) throw new AssetInputError("通配符不是资产；请上报具体主机名。");
	if (/[/?#@\s]/.test(value) || value.includes(":")) {
		throw new AssetInputError(`${raw} 不是裸域名；带端口请用 port 字段，带协议请用 url 字段。`);
	}
	if (isIP(value) !== 0) throw new AssetInputError(`${raw} 是 IP；请用 ip 字段。`);
	let hostname: string;
	try {
		hostname = new URL(`http://${value}`).hostname;
	} catch {
		throw new AssetInputError(`域名无法解析：${raw}。`);
	}
	if (hostname === "" || hostname.length > 253) {
		throw new AssetInputError(`域名长度不合法：${raw}。`);
	}
	for (const label of hostname.split(".")) {
		if (label.length === 0 || label.length > 63) {
			throw new AssetInputError(`域名分段长度不合法：${raw}。`);
		}
		if (label.startsWith("-") || label.endsWith("-")) {
			throw new AssetInputError(`域名分段不能以连字符开头或结尾：${raw}。`);
		}
	}
	if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(hostname)) {
		throw new AssetInputError(`域名含非法字符：${raw}。`);
	}
	return hostname;
}

function hostPort(host: string, port: number): string {
	return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * Turn the model's loose set of fields into one canonical identity. The rules
 * are strict on purpose: a silently wrong URL or service is worse than an error
 * the model can fix in one retry.
 */
export function resolveAssetIdentity(input: AssetIdentityInput): ResolvedIdentity {
	const url = lineText(input.url);
	const ip = lineText(input.ip);
	const domain = lineText(input.domain);
	const port = input.port === undefined ? undefined : normalizePort(input.port);
	const transport = lineText(input.transport) === undefined ? undefined : normalizeTransport(input.transport);
	const protocol = normalizeProtocol(input.protocol);

	if (url) {
		if (ip || domain || port !== undefined) {
			throw new AssetInputError("URL 已自带主机与端口，不要再传 ip / domain / port。");
		}
		if (transport || protocol) {
			throw new AssetInputError("URL 的协议由 scheme 决定，不要再传 transport / protocol。");
		}
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new AssetInputError(`URL 无法解析：${url}`);
		}
		const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
		if (!["http", "https", "ws", "wss"].includes(scheme)) {
			throw new AssetInputError(`URL scheme 只支持 http / https / ws / wss，收到 ${parsed.protocol}`);
		}
		if (!parsed.hostname) throw new AssetInputError(`URL 缺少主机：${url}`);
		const warnings: string[] = [];
		if (parsed.username || parsed.password) warnings.push("已移除 URL 中的账号密码。");
		const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
		const isAddress = isIP(hostname) !== 0;
		const defaultPort = scheme === "http" || scheme === "ws" ? 80 : 443;
		const effectivePort = normalizePort(parsed.port ? Number(parsed.port) : defaultPort);
		const canonicalHost = isAddress ? canonicalIp(hostname) : canonicalDomain(hostname);
		const hostForUrl =
			(isAddress && isIP(canonicalHost) === 6 ? `[${canonicalHost}]` : canonicalHost) +
			(parsed.port ? `:${parsed.port}` : "");
		const storedUrl = `${scheme}://${hostForUrl}${parsed.pathname}${parsed.search}`;
		return {
			kind: "url",
			name: storedUrl,
			dedupeKey: `url:${scheme}://${hostForUrl}${parsed.pathname}`,
			host: hostForUrl,
			...(isAddress ? { ip: canonicalHost } : { domain: canonicalHost }),
			port: effectivePort,
			protocol: scheme,
			url: storedUrl,
			warnings,
		};
	}

	if (port !== undefined) {
		if (ip && domain) {
			throw new AssetInputError("同时给了域名和 IP：请分两次上报，或只保留实际使用的主机名。");
		}
		if (!ip && !domain) {
			throw new AssetInputError("给了 port 但没有 ip / domain：服务必须有主机。");
		}
		const canonical = ip ? canonicalIp(ip) : canonicalDomain(domain as string);
		const name = hostPort(canonical, port);
		return {
			kind: "service",
			name,
			dedupeKey: `service:${name}/${transport ?? "tcp"}`,
			host: canonical,
			...(ip ? { ip: canonical } : { domain: canonical }),
			port,
			transport: transport ?? "tcp",
			...(protocol ? { protocol } : {}),
			warnings: [],
		};
	}

	if (transport || protocol) {
		throw new AssetInputError("transport / protocol 只跟服务（ip/domain + port）一起使用。");
	}

	if (ip && domain) {
		throw new AssetInputError("同时给了域名和 IP：请分两次上报，或只保留实际使用的主机名。");
	}
	if (ip) {
		const canonical = canonicalIp(ip);
		return {
			kind: "ip",
			name: canonical,
			dedupeKey: `ip:${canonical}`,
			host: canonical,
			ip: canonical,
			warnings: [],
		};
	}
	if (domain) {
		const canonical = canonicalDomain(domain);
		return {
			kind: "domain",
			name: canonical,
			dedupeKey: `domain:${canonical}`,
			host: canonical,
			domain: canonical,
			warnings: [],
		};
	}
	throw new AssetInputError("至少给 url、ip 或 domain 之一。");
}

/** `%` and `_` in an operator filter must match literally. */
function likePattern(value: string): string {
	return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}

/** Deduplicate and drop empty ids before they reach a statement. */
function scopedIds(ids: readonly string[]): string[] {
	return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function entryToProtocol(row: EntryRow): SentinelAssetEntry {
	return {
		seq: Number(row.seq),
		kind: row.kind === "status" ? "status" : "record",
		at: row.at,
		author: row.author === "operator" ? "operator" : "agent",
		...(optional(row.source) ? { source: row.source as string } : {}),
		outcome: isAssetOutcome(row.outcome) ? row.outcome : "note",
		...(optional(row.method) ? { method: row.method as string } : {}),
		text: row.text,
		...(optional(row.vuln_label) ? { vulnLabel: row.vuln_label as string } : {}),
	};
}

function rowToSummary(row: AssetRow): SentinelAssetSummary {
	const status = isAssetState(row.status) ? row.status : "pending";
	const lastOutcome = row.last_outcome && isAssetOutcome(row.last_outcome) ? row.last_outcome : undefined;
	// Only this store writes the row, so an unknown kind is a schema bug rather
	// than user input; reading it as an IP keeps the page usable instead of
	// dropping the record.
	const kind = isAssetKind(row.kind) ? row.kind : "ip";
	return {
		id: row.id,
		label: row.label,
		number: Number(row.number),
		projectId: row.project_id,
		projectName: row.project_name,
		kind,
		name: row.name,
		host: row.host,
		...(optional(row.domain) ? { domain: row.domain as string } : {}),
		...(optional(row.ip) ? { ip: row.ip as string } : {}),
		...(row.port === null || row.port === undefined ? {} : { port: Number(row.port) }),
		...(row.transport === "tcp" || row.transport === "udp" ? { transport: row.transport } : {}),
		...(optional(row.protocol) ? { protocol: row.protocol as string } : {}),
		...(optional(row.url) ? { url: row.url as string } : {}),
		...(optional(row.title) ? { title: row.title as string } : {}),
		...(optional(row.server) ? { server: row.server as string } : {}),
		...(optional(row.tech) ? { tech: row.tech as string } : {}),
		tags: parseTags(row.tags),
		status,
		source: row.source,
		...(optional(row.session_id) ? { sessionId: row.session_id as string } : {}),
		...(optional(row.engine_id) ? { engineId: row.engine_id as string } : {}),
		...(optional(row.task_id) ? { taskId: row.task_id as string } : {}),
		...(optional(row.session_name) ? { sessionName: row.session_name as string } : {}),
		testCount: Number(row.test_count),
		...(lastOutcome ? { lastOutcome } : {}),
		...(optional(row.last_tested_at) ? { lastTestedAt: row.last_tested_at as string } : {}),
		firstSeenAt: row.first_seen_at,
		lastSeenAt: row.last_seen_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class AssetLibraryStore {
	private readonly db: SqliteDatabase;
	private readonly clock: () => Date;

	constructor(path: string, clock: () => Date = () => new Date()) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		this.clock = clock;
	}

	close(): void {
		this.db.close();
	}

	private now(): string {
		return this.clock().toISOString();
	}

	private transaction<T>(run: () => T): T {
		// Savepoints also allow a batch to wrap individual upserts atomically.
		this.db.exec("SAVEPOINT asset_write");
		try {
			const result = run();
			this.db.exec("RELEASE asset_write");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK TO asset_write");
				this.db.exec("RELEASE asset_write");
			} catch {
				// The original error is the one worth reporting.
			}
			throw error;
		}
	}

	get(id: string): SentinelAsset | undefined {
		const row = this.db.prepare("SELECT * FROM asset_library WHERE id = ?").get(id) as unknown as
			| AssetRow
			| undefined;
		return row ? this.toAsset(row) : undefined;
	}

	/** Look up by id or by the human-readable label, always inside one project. */
	find(projectId: string, idOrLabel: string): SentinelAsset | undefined {
		const trimmed = idOrLabel.trim();
		if (!trimmed) return undefined;
		const byLabel = this.db
			.prepare("SELECT id FROM asset_library WHERE project_id = ? AND label = ? COLLATE NOCASE")
			.get(projectId, trimmed) as unknown as { id: string } | undefined;
		const found =
			byLabel ??
			(this.db
				.prepare("SELECT id FROM asset_library WHERE project_id = ? AND id = ?")
				.get(projectId, trimmed) as unknown as { id: string } | undefined);
		return found ? this.get(found.id) : undefined;
	}

	private findByKey(projectId: string, dedupeKey: string): AssetRow | undefined {
		return this.db
			.prepare("SELECT * FROM asset_library WHERE project_id = ? AND dedupe_key = ?")
			.get(projectId, dedupeKey) as unknown as AssetRow | undefined;
	}

	hasIdentity(projectId: string, identity: AssetIdentityInput): boolean {
		return this.findByKey(projectId, resolveAssetIdentity(identity).dedupeKey) !== undefined;
	}

	/** A failed batch leaves neither partial assets nor consumed labels. */
	upsertMany(inputs: AssetUpsertInput[]): { created: number; merged: number } {
		return this.transaction(() => {
			let created = 0;
			let merged = 0;
			for (const input of inputs) {
				if (this.upsert(input).created) created += 1;
				else merged += 1;
			}
			return { created, merged };
		});
	}

	private entriesOf(assetId: string): SentinelAssetEntry[] {
		const rows = this.db
			.prepare("SELECT * FROM asset_library_entries WHERE asset_id = ? ORDER BY seq ASC")
			.all(assetId) as unknown as EntryRow[];
		return rows.map(entryToProtocol);
	}

	private toAsset(row: AssetRow): SentinelAsset {
		return { ...rowToSummary(row), entries: this.entriesOf(row.id) };
	}

	private nextNumber(projectId: string): number {
		const row = this.db
			.prepare("SELECT next_number FROM asset_library_sequences WHERE project_id = ?")
			.get(projectId) as unknown as { next_number: number } | undefined;
		const number = row ? Number(row.next_number) : 1;
		if (row) {
			this.db
				.prepare("UPDATE asset_library_sequences SET next_number = ? WHERE project_id = ?")
				.run(number + 1, projectId);
		} else {
			this.db
				.prepare("INSERT INTO asset_library_sequences (project_id, next_number) VALUES (?, ?)")
				.run(projectId, number + 1);
		}
		return number;
	}

	/**
	 * Insert a new asset or merge into the existing one. Identity fields are
	 * immutable; descriptive fields take the latest non-empty value; tags are a
	 * union; status is only moved by a conclusive record or the operator.
	 */
	upsert(input: AssetUpsertInput): AssetUpsertResult {
		const identity = resolveAssetIdentity(input.identity);
		const at = this.now();
		const tags = normalizeTags(input.tags);
		const title = lineText(input.title);
		const server = lineText(input.server);
		const tech = lineText(input.tech);
		const existing = this.findByKey(input.projectId, identity.dedupeKey);
		if (existing) {
			const asset = this.transaction(() => {
				this.db
					.prepare(
						`UPDATE asset_library
						 SET title = ?, server = ?, tech = ?, protocol = ?, tags = ?, last_seen_at = ?, updated_at = ?
						 WHERE id = ?`,
					)
					.run(
						title ?? existing.title,
						server ?? existing.server,
						tech ?? existing.tech,
						identity.protocol ?? existing.protocol,
						JSON.stringify(normalizeTags([...parseTags(existing.tags), ...tags])),
						at,
						at,
						existing.id,
					);
				if (input.record) {
					this.appendEntryRow(
						existing.id,
						{
							author: "agent",
							source: input.source,
							outcome: input.record.outcome,
							...(input.record.method?.trim() ? { method: input.record.method } : {}),
							text: blockText(input.record.text),
						},
						at,
						{ kind: "record", touchSeen: true, autoStatus: true },
					);
				}
				return this.get(existing.id) as SentinelAsset;
			});
			return { created: false, asset, warnings: identity.warnings };
		}

		const asset = this.transaction(() => {
			const number = this.nextNumber(input.projectId);
			const id = randomUUID();
			const label = assetLabel(assetPrefix(input.projectName), number);
			this.db
				.prepare(
					`INSERT INTO asset_library (
						id, label, number, project_id, project_name, kind, name, dedupe_key, host,
						domain, ip, port, transport, protocol, url, title, server, tech, tags, status,
						source, session_id, engine_id, task_id, session_name,
						test_count, last_outcome, last_tested_at, first_seen_at, last_seen_at, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?)`,
				)
				.run(
					id,
					label,
					number,
					input.projectId,
					input.projectName,
					identity.kind,
					identity.name,
					identity.dedupeKey,
					identity.host,
					identity.domain ?? null,
					identity.ip ?? null,
					identity.port ?? null,
					identity.transport ?? null,
					identity.protocol ?? null,
					identity.url ?? null,
					title ?? null,
					server ?? null,
					tech ?? null,
					JSON.stringify(tags),
					input.source,
					input.sessionId ?? null,
					input.engineId ?? null,
					input.taskId ?? null,
					input.sessionName ?? null,
					at,
					at,
					at,
					at,
				);
			if (input.record) {
				this.appendEntryRow(
					id,
					{
						author: "agent",
						source: input.source,
						outcome: input.record.outcome,
						...(input.record.method?.trim() ? { method: input.record.method } : {}),
						text: blockText(input.record.text),
					},
					at,
					{ kind: "record", touchSeen: true, autoStatus: true },
				);
			}
			return this.get(id) as SentinelAsset;
		});
		return { created: true, asset, warnings: identity.warnings };
	}

	/** Append one test record; operator notes and agent tests share this path. */
	appendEntry(assetId: string, entry: AssetEntryInput): SentinelAsset | undefined {
		if (!isAssetOutcome(entry.outcome)) {
			throw new AssetInputError(`未知的测试结论：${String(entry.outcome)}`);
		}
		const exists = this.db.prepare("SELECT id FROM asset_library WHERE id = ?").get(assetId) as unknown as
			| { id: string }
			| undefined;
		if (!exists) return undefined;
		const at = this.now();
		this.transaction(() =>
			this.appendEntryRow(assetId, entry, at, {
				kind: "record",
				touchSeen: entry.author === "agent",
				autoStatus: true,
			}),
		);
		return this.get(assetId);
	}

	/**
	 * Operator edits: state, tags, and an optional record. A status change and a
	 * record are separate timeline entries; a record with an explicit status does
	 * not auto-advance the state the operator just chose.
	 */
	update(id: string, patch: SentinelAssetUpdate): SentinelAsset | undefined {
		const existing = this.get(id);
		if (!existing) return undefined;
		if (patch.status !== undefined && !isAssetState(patch.status)) {
			throw new AssetInputError(`未知的资产状态：${String(patch.status)}`);
		}
		if (patch.outcome !== undefined && !isAssetOutcome(patch.outcome)) {
			throw new AssetInputError(`未知的测试结论：${String(patch.outcome)}`);
		}
		if (patch.tags !== undefined && !Array.isArray(patch.tags)) {
			throw new AssetInputError("tags 必须是字符串数组。");
		}
		const status = patch.status ?? existing.status;
		const tags = patch.tags === undefined ? existing.tags : normalizeTags(patch.tags);
		const note = blockText(patch.note);
		const hasRecord = note !== "" || patch.outcome !== undefined;
		const statusChanged = status !== existing.status;
		const tagsChanged = JSON.stringify(tags) !== JSON.stringify(existing.tags);
		if (!statusChanged && !tagsChanged && !hasRecord) return existing;
		const at = this.now();
		this.transaction(() => {
			if (tagsChanged || statusChanged) {
				this.db
					.prepare("UPDATE asset_library SET status = ?, tags = ?, updated_at = ? WHERE id = ?")
					.run(status, JSON.stringify(tags), at, id);
			} else {
				this.db.prepare("UPDATE asset_library SET updated_at = ? WHERE id = ?").run(at, id);
			}
			if (statusChanged) {
				this.appendEntryRow(
					id,
					{
						author: "operator",
						outcome: "note",
						text: `状态 ${ASSET_STATE_LABELS[existing.status]} → ${ASSET_STATE_LABELS[status]}`,
					},
					at,
					{ kind: "status", touchSeen: false, autoStatus: false },
				);
			}
			if (hasRecord) {
				this.appendEntryRow(
					id,
					{
						author: "operator",
						outcome: patch.outcome ?? "note",
						text: note,
					},
					at,
					{ kind: "record", touchSeen: false, autoStatus: patch.status === undefined },
				);
			}
		});
		return this.get(id);
	}

	/**
	 * Write one timeline row and refresh the denormalized counters in the same
	 * transaction. Status entries never count as tests and never touch the
	 * conclusion fields.
	 */
	private appendEntryRow(
		assetId: string,
		entry: AssetEntryInput,
		at: string,
		options: { kind: "record" | "status"; touchSeen: boolean; autoStatus: boolean },
	): void {
		const row = this.db.prepare("SELECT * FROM asset_library WHERE id = ?").get(assetId) as unknown as
			| AssetRow
			| undefined;
		if (!row) return;
		const last = this.db
			.prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM asset_library_entries WHERE asset_id = ?")
			.get(assetId) as unknown as { last: number } | undefined;
		const seq = Number(last?.last ?? 0) + 1;
		this.db
			.prepare(
				`INSERT INTO asset_library_entries
				 (asset_id, seq, kind, at, author, source, outcome, method, text, vuln_label)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				assetId,
				seq,
				options.kind,
				at,
				entry.author,
				entry.source ?? null,
				entry.outcome,
				lineText(entry.method) ?? null,
				entry.text,
				entry.vulnLabel ?? null,
			);
		let testCount = Number(row.test_count);
		let lastOutcome = row.last_outcome;
		let lastTestedAt = row.last_tested_at;
		let status = row.status;
		if (options.kind === "record") {
			testCount += 1;
			if (entry.outcome !== "note") {
				lastOutcome = entry.outcome;
				lastTestedAt = at;
				if (options.autoStatus && status === "pending") status = "tested";
			}
		}
		this.db
			.prepare(
				`UPDATE asset_library
				 SET test_count = ?, last_outcome = ?, last_tested_at = ?, status = ?, last_seen_at = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(testCount, lastOutcome, lastTestedAt, status, options.touchSeen ? at : row.last_seen_at, at, assetId);
	}

	list(
		projectId: string,
		filters: SentinelAssetFilters = {},
		page = 1,
		pageSize = DEFAULT_ASSET_PAGE_SIZE,
	): {
		items: SentinelAssetSummary[];
		total: number;
		page: number;
		pageSize: number;
		hasMore: boolean;
	} {
		const conditions = ["project_id = ?"];
		const params: SqliteValue[] = [projectId];
		if (filters.kind && isAssetKind(filters.kind)) {
			conditions.push("kind = ?");
			params.push(filters.kind);
		}
		if (filters.status && isAssetState(filters.status)) {
			conditions.push("status = ?");
			params.push(filters.status);
		}
		if (filters.tested === true) conditions.push("last_tested_at IS NOT NULL");
		if (filters.tested === false) conditions.push("last_tested_at IS NULL");
		const search = filters.search?.trim();
		if (search) {
			const pattern = likePattern(search);
			conditions.push(
				"(label LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR host LIKE ? ESCAPE '\\' OR COALESCE(domain, '') LIKE ? ESCAPE '\\' OR COALESCE(ip, '') LIKE ? ESCAPE '\\' OR COALESCE(url, '') LIKE ? ESCAPE '\\' OR COALESCE(title, '') LIKE ? ESCAPE '\\' OR COALESCE(server, '') LIKE ? ESCAPE '\\' OR COALESCE(tech, '') LIKE ? ESCAPE '\\' OR COALESCE(protocol, '') LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')",
			);
			params.push(
				pattern,
				pattern,
				pattern,
				pattern,
				pattern,
				pattern,
				pattern,
				pattern,
				pattern,
				pattern,
				pattern,
				pattern,
			);
		}
		const where = ` WHERE ${conditions.join(" AND ")}`;
		const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM asset_library${where}`).get(...params) as unknown as {
			n: number;
		};
		const total = Number(totalRow.n);
		const requestedPage = Number.isFinite(page) ? Math.floor(page) : 1;
		const requestedSize = Number.isFinite(pageSize) ? Math.floor(pageSize) : DEFAULT_ASSET_PAGE_SIZE;
		const safePage = Math.max(1, requestedPage);
		const size = Math.min(Math.max(1, requestedSize), MAX_ASSET_PAGE_SIZE);
		const offset = (safePage - 1) * size;
		const rows = this.db
			.prepare(`SELECT * FROM asset_library${where} ORDER BY last_seen_at DESC, number DESC LIMIT ? OFFSET ?`)
			.all(...params, size, offset) as unknown as AssetRow[];
		return {
			items: rows.map(rowToSummary),
			total,
			page: safePage,
			pageSize: size,
			hasMore: offset + rows.length < total,
		};
	}

	stats(projectId: string): SentinelAssetStats {
		const stats = emptyAssetStats();
		const kindRows = this.db
			.prepare("SELECT kind, COUNT(*) AS n FROM asset_library WHERE project_id = ? GROUP BY kind")
			.all(projectId) as unknown as Array<{ kind: string; n: number }>;
		for (const row of kindRows) {
			if (isAssetKind(row.kind)) stats.byKind[row.kind] = Number(row.n);
		}
		const statusRows = this.db
			.prepare("SELECT status, COUNT(*) AS n FROM asset_library WHERE project_id = ? GROUP BY status")
			.all(projectId) as unknown as Array<{ status: string; n: number }>;
		for (const row of statusRows) {
			if (isAssetState(row.status)) stats.byStatus[row.status] = Number(row.n);
		}
		const totalRow = this.db
			.prepare("SELECT COUNT(*) AS n FROM asset_library WHERE project_id = ?")
			.get(projectId) as unknown as { n: number };
		stats.total = Number(totalRow.n);
		const testedRow = this.db
			.prepare("SELECT COUNT(*) AS n FROM asset_library WHERE project_id = ? AND last_tested_at IS NOT NULL")
			.get(projectId) as unknown as { n: number };
		stats.tested = Number(testedRow.n);
		stats.untested = stats.total - stats.tested;
		return stats;
	}

	/** What a deletion would take: assets and every timeline entry under them. */
	deletePreview(projectId: string, ids: readonly string[]): { count: number; records: number } {
		const selected = scopedIds(ids);
		if (selected.length === 0) return { count: 0, records: 0 };
		const marks = placeholders(selected.length);
		const countRow = this.db
			.prepare(`SELECT COUNT(*) AS n FROM asset_library WHERE project_id = ? AND id IN (${marks})`)
			.get(projectId, ...selected) as unknown as { n: number };
		const recordRow = this.db
			.prepare(
				`SELECT COUNT(*) AS n FROM asset_library_entries
				 WHERE asset_id IN (SELECT id FROM asset_library WHERE project_id = ? AND id IN (${marks}))`,
			)
			.get(projectId, ...selected) as unknown as { n: number };
		return { count: Number(countRow.n), records: Number(recordRow.n) };
	}

	/** Delete many assets of one project with their timeline. Scoped to the project. */
	deleteMany(projectId: string, ids: readonly string[]): number {
		const selected = scopedIds(ids);
		if (selected.length === 0) return 0;
		const marks = placeholders(selected.length);
		const scope = `asset_id IN (SELECT id FROM asset_library WHERE project_id = ? AND id IN (${marks}))`;
		return this.transaction(() => {
			const countRow = this.db
				.prepare(`SELECT COUNT(*) AS n FROM asset_library WHERE project_id = ? AND id IN (${marks})`)
				.get(projectId, ...selected) as unknown as { n: number };
			this.db.prepare(`DELETE FROM asset_library_entries WHERE ${scope}`).run(projectId, ...selected);
			this.db
				.prepare(`DELETE FROM asset_library WHERE project_id = ? AND id IN (${marks})`)
				.run(projectId, ...selected);
			return Number(countRow.n);
		});
	}

	/** Deleting a project deletes its inventory: records cannot outlive their scope. */
	deleteByProject(projectId: string): number {
		return this.transaction(() => {
			const countRow = this.db
				.prepare("SELECT COUNT(*) AS n FROM asset_library WHERE project_id = ?")
				.get(projectId) as unknown as { n: number };
			this.db
				.prepare(
					"DELETE FROM asset_library_entries WHERE asset_id IN (SELECT id FROM asset_library WHERE project_id = ?)",
				)
				.run(projectId);
			this.db.prepare("DELETE FROM asset_library WHERE project_id = ?").run(projectId);
			this.db.prepare("DELETE FROM asset_library_sequences WHERE project_id = ?").run(projectId);
			return Number(countRow.n);
		});
	}

	countByProject(projectId: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM asset_library WHERE project_id = ?")
			.get(projectId) as unknown as { n: number };
		return Number(row.n);
	}
}
