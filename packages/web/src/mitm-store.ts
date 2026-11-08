/** Read replayd's native SQLite/blob format, including while the capture worker is stopped. */
import { isUtf8 } from "node:buffer";
import { closeSync, existsSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { MitmBody, MitmBodyChunk, MitmFlow, MitmFlowDetail, MitmFlowPage, MitmHeader } from "./mitm-types.ts";
import { openSqliteDatabase, type SqliteValue } from "./sqlite.ts";

export class MitmError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

interface FlowRow {
	id: string;
	ts: number;
	method: string;
	scheme: string;
	host: string;
	port: number;
	path: string;
	query: string | null;
	status: number | null;
	duration_ms: number | null;
	req_size: number;
	resp_size: number | null;
	error: string | null;
	note: string | null;
	req_headers: string;
	resp_headers: string | null;
	req_raw_sha: string | null;
	resp_raw_sha: string | null;
}

function flow(row: FlowRow): MitmFlow {
	return {
		id: row.id,
		ts: row.ts,
		method: row.method,
		scheme: row.scheme,
		host: row.host,
		port: row.port,
		path: row.path,
		query: row.query ?? "",
		status: row.status,
		durationMs: row.duration_ms,
		reqSize: row.req_size,
		respSize: row.resp_size ?? 0,
		error: row.error,
		note: row.note ?? "",
	};
}

/** Blob identifiers are content hashes, never user-supplied filesystem paths. */
export function mitmBlobPath(directory: string, sha: string | null): string | null {
	if (!sha) return null;
	if (!/^[a-f0-9]{64}$/.test(sha)) throw new MitmError("流量正文索引损坏。", 500);
	return join(directory, "blobs", sha.slice(0, 2), sha.slice(2, 4), sha);
}

function body(directory: string, sha: string | null, originalSize: number, maxBytes = 1024 * 1024): MitmBody {
	const path = mitmBlobPath(directory, sha);
	if (!path) return { text: "", encoding: "utf8", size: 0, truncated: false, captureTruncated: false };
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const bytes = Buffer.alloc(Math.min(size, maxBytes));
		const length = readSync(fd, bytes, 0, bytes.length, 0);
		const content = bytes.subarray(0, length);
		const utf8 = isUtf8(content);
		return {
			text: content.toString(utf8 ? "utf8" : "base64"),
			encoding: utf8 ? "utf8" : "base64",
			size,
			truncated: size > length,
			captureTruncated: originalSize > size,
		};
	} finally {
		closeSync(fd);
	}
}

export interface MitmQuery {
	sql: string;
	params: SqliteValue[];
}

export type MitmReader = (queries: MitmQuery[]) => Promise<unknown[][]>;

export type MitmWriter = (queries: MitmQuery[]) => Promise<number>;

/** Shared only by console lists; Agent queries retain exact counts. */
export class MitmCountCache {
	private readonly entries = new Map<string, { total: number; at: number }>();
	revision = 0;

	get(key: string): { total: number; at: number } | undefined {
		const entry = this.entries.get(key);
		if (entry && Date.now() - entry.at >= 0 && Date.now() - entry.at < 15000) return entry;
		this.entries.delete(key);
		return undefined;
	}

	set(key: string, total: number, at: number, revision: number): void {
		if (revision !== this.revision) return;
		this.entries.delete(key);
		if (this.entries.size >= 64) this.entries.delete(this.entries.keys().next().value!);
		this.entries.set(key, { total, at });
	}

	clear(): void {
		this.revision++;
		this.entries.clear();
	}
}

/** The live writer must run in the container, alongside replayd's WAL. */
export const MITM_DELETE_SCRIPT = `import json, sys, urllib.request
queries = json.loads(sys.argv[1])
ids = queries[0]["params"] or None
with open("/data/token") as token:
    request = urllib.request.Request("http://127.0.0.1:8081/api/proxy/flows/delete", data=json.dumps({"ids": ids, "confirm": True}).encode(), headers={"Authorization": "Bearer " + token.read().strip(), "Content-Type": "application/json"})
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open(request, timeout=25) as response:
    print(json.dumps(json.load(response)["deleted"]))
`;

/** Match replayd's deletion semantics: remove flows and reclaim unreferenced blobs.
 * Live cleanup runs inside replayd, coordinated with its file/metadata writer lock.
 */
export async function deleteMitmFlows(directory: string, ids?: unknown, writer?: MitmWriter): Promise<number> {
	if (
		ids !== undefined &&
		(!Array.isArray(ids) ||
			ids.length === 0 ||
			ids.length > 100 ||
			ids.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)))
	)
		throw new MitmError("请选择 1–100 条有效流量记录。");
	const selected = ids as string[] | undefined;
	const queries: MitmQuery[] = [
		{
			sql: `CREATE TEMP TABLE mitm_deleted AS SELECT id, req_body_sha, req_raw_sha, resp_body_sha, resp_raw_sha FROM flows WHERE source = 'proxy'${selected ? ` AND id IN (${selected.map(() => "?").join(",")})` : ""}`,
			params: selected ?? [],
		},
		{
			sql: `CREATE TEMP TABLE mitm_refs AS SELECT sha, COUNT(*) AS n FROM (
				SELECT req_body_sha AS sha FROM mitm_deleted UNION ALL SELECT req_raw_sha FROM mitm_deleted
				UNION ALL SELECT resp_body_sha FROM mitm_deleted UNION ALL SELECT resp_raw_sha FROM mitm_deleted
			) WHERE sha IS NOT NULL GROUP BY sha`,
			params: [],
		},
		{ sql: "CREATE INDEX mitm_refs_sha ON mitm_refs(sha)", params: [] },
		{
			sql: "UPDATE blobs SET refcount = MAX(0, refcount - (SELECT n FROM mitm_refs WHERE sha = blobs.sha256)) WHERE sha256 IN (SELECT sha FROM mitm_refs)",
			params: [],
		},
		{ sql: "DELETE FROM flows WHERE id IN (SELECT id FROM mitm_deleted)", params: [] },
	];
	if (writer) return writer(queries);
	const path = join(directory, "replayd.db");
	if (!existsSync(path)) return 0;
	const db = openSqliteDatabase(path);
	try {
		db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;");
		let deleted = 0;
		for (const query of queries) deleted = Number(db.prepare(query.sql).run(...query.params).changes ?? 0);
		db.exec("COMMIT");
		// This branch is only used with the worker stopped. Live deletion runs in replayd.
		const unused = db.prepare("SELECT sha256 FROM blobs WHERE refcount = 0").all() as { sha256: string }[];
		for (const row of unused) {
			const file = mitmBlobPath(directory, row.sha256)!;
			if (existsSync(file)) unlinkSync(file);
			db.prepare("DELETE FROM blobs WHERE sha256 = ? AND refcount = 0").run(row.sha256);
		}
		return deleted;
	} finally {
		db.close();
	}
}

/** Run bounded, internal read queries in the same OS as the active SQLite writer. */
export const MITM_READ_SCRIPT = `import json, sqlite3, sys
connection = sqlite3.connect("file:/data/replayd.db?mode=ro", uri=True, timeout=1)
connection.row_factory = sqlite3.Row
connection.execute("PRAGMA query_only = ON")
try:
    queries = json.loads(sys.argv[1])
    connection.execute("BEGIN")
    print(json.dumps([[dict(row) for row in connection.execute(q["sql"], q["params"])] for q in queries]))
finally:
    connection.close()
`;

// SQLite's synchronous driver must not block the console when browsing stopped
// captures. Inline worker code also works in the bundled executable, with no
// extra worker entrypoint or third-party runtime dependency.
const HOST_READ_WORKER = `
const { parentPort } = require('node:worker_threads');
const sqlite = require(process.versions.bun ? 'bun:sqlite' : 'node:sqlite');
const Database = sqlite.DatabaseSync || sqlite.Database;
parentPort.on('message', ({ path, queries }) => {
  try {
    const db = new Database(path, process.versions.bun ? { readonly: true } : { readOnly: true });
    let rows;
    try {
      db.exec('PRAGMA busy_timeout = 1000; PRAGMA query_only = ON;');
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'flows'").get()) {
        rows = queries.map(() => []);
      } else {
        db.exec('BEGIN');
        rows = queries.map(q => db.prepare(q.sql).all(...q.params));
      }
    } finally { db.close(); }
    parentPort.postMessage({ rows });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
`;

interface HostReadSlot {
	worker: Worker;
	retiring: boolean;
	pending?: {
		resolve: (rows: unknown[][]) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	};
}

// Lazily reuse at most four threads across projects. SQLite initializes once per
// thread, so polling does not repeatedly pay startup costs or emit its warning.
const hostReaders = new Set<HostReadSlot>();

function retireHostReader(slot: HostReadSlot, error: Error): void {
	if (slot.retiring) return;
	slot.retiring = true;
	const pending = slot.pending;
	slot.pending = undefined;
	if (pending) {
		clearTimeout(pending.timer);
		pending.reject(error);
	}
	// Keep the slot occupied until exit, even after a timeout, to bound threads.
	void slot.worker.terminate().catch(() => {});
}

function createHostReader(): HostReadSlot {
	const worker = new Worker(HOST_READ_WORKER, { eval: true });
	const slot: HostReadSlot = { worker, retiring: false };
	worker.on("message", (result: { rows: unknown[][] } | { error: string }) => {
		const pending = slot.pending;
		if (!pending || slot.retiring) return;
		slot.pending = undefined;
		clearTimeout(pending.timer);
		worker.unref();
		if ("error" in result) pending.reject(new Error(result.error));
		else pending.resolve(result.rows);
	});
	worker.on("error", (error) => retireHostReader(slot, error));
	worker.on("messageerror", (error) => retireHostReader(slot, error));
	worker.on("exit", () => {
		slot.retiring = true;
		hostReaders.delete(slot);
		if (slot.pending) {
			clearTimeout(slot.pending.timer);
			slot.pending.reject(new MitmError("历史流量查询失败。", 503));
			slot.pending = undefined;
		}
	});
	worker.unref(); // Idle threads must not keep the console process alive.
	hostReaders.add(slot);
	return slot;
}

export function readMitmStore(directory: string): MitmReader {
	return async (queries) => {
		const path = join(directory, "replayd.db");
		if (!existsSync(path)) return queries.map(() => []);
		let slot = [...hostReaders].find((entry) => !entry.pending && !entry.retiring);
		if (!slot) {
			if (hostReaders.size >= 4) throw new MitmError("历史流量查询繁忙，请稍后重试。", 503);
			slot = createHostReader();
		}
		const reader = slot;
		return new Promise<unknown[][]>((resolve, reject) => {
			const timer = setTimeout(() => {
				retireHostReader(reader, new MitmError("历史流量查询超时，请缩小时间范围或筛选条件。", 503));
			}, 10000);
			reader.pending = { resolve, reject, timer };
			reader.worker.ref();
			try {
				reader.worker.postMessage({ path, queries });
			} catch (error) {
				retireHostReader(reader, error instanceof Error ? error : new Error(String(error)));
			}
		});
	};
}

export async function listMitmFlows(
	directory: string,
	params: URLSearchParams,
	reader: MitmReader = readMitmStore(directory),
	counts?: MitmCountCache,
): Promise<MitmFlowPage> {
	const requestedPage = Number(params.get("page") ?? 1);
	const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 1_000_000) : 1;
	const requestedSize = Number(params.get("pageSize") ?? 50);
	const pageSize = Number.isSafeInteger(requestedSize) && requestedSize > 0 ? Math.min(requestedSize, 50) : 50;
	const where = ["source = 'proxy'"];
	const values: SqliteValue[] = [];
	for (const [key, column] of [
		["q", "(host || path || COALESCE(query,''))"],
		["host", "host"],
		["path", "path"],
	]) {
		const value = params.get(key)?.trim();
		if (value) {
			where.push(`instr(lower(${column}), lower(?)) > 0`);
			values.push(value.slice(0, 2048));
		}
	}
	for (const [key, operator] of [
		["since", ">="],
		["until", "<="],
	]) {
		const value = params.get(key);
		if (value !== null) {
			const timestamp = Number(value);
			if (!value.trim() || !Number.isSafeInteger(timestamp) || timestamp < 0)
				throw new MitmError("时间筛选应为非负 Unix 毫秒时间戳。");
			where.push(`ts ${operator} ?`);
			values.push(timestamp);
		}
	}
	if (params.has("since") && params.has("until") && Number(params.get("since")) > Number(params.get("until")))
		throw new MitmError("开始时间不能晚于结束时间。");
	const method = params.get("method")?.trim();
	if (method) {
		where.push("method = ?");
		values.push(method.toUpperCase().slice(0, 32));
	}
	const status = params.get("status");
	if (status === "error") where.push("(error IS NOT NULL OR status IS NULL)");
	else if (status && /^[1-5]xx$/.test(status)) {
		where.push("status >= ? AND status < ?");
		values.push(Number(status[0]) * 100, Number(status[0]) * 100 + 100);
	} else if (status && /^\d{3}$/.test(status)) {
		where.push("status = ?");
		values.push(Number(status));
	}
	const clause = where.join(" AND ");
	const countKey = JSON.stringify([directory, clause, values]);
	const cached = params.get("refreshCount") === "1" ? undefined : counts?.get(countKey);
	const revision = counts?.revision ?? 0;
	const at = cached?.at ?? Date.now();
	const rowValues = [...values];
	let rowClause = clause;
	const cursor = params.get("cursor");
	if (cursor) {
		let decoded: unknown;
		try {
			if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("invalid cursor");
			decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		} catch {
			throw new MitmError("翻页游标无效，请刷新列表。");
		}
		if (
			!Array.isArray(decoded) ||
			decoded.length !== 2 ||
			!Number.isSafeInteger(decoded[0]) ||
			decoded[0] < 0 ||
			typeof decoded[1] !== "string" ||
			!/^[a-zA-Z0-9_-]{1,100}$/.test(decoded[1])
		)
			throw new MitmError("翻页游标无效，请刷新列表。");
		rowClause += " AND (ts, id) < (?, ?)";
		rowValues.push(decoded[0], decoded[1]);
	}
	const rowQuery = {
		sql: `SELECT id, ts, method, scheme, host, port, path, query, status, duration_ms, req_size, resp_size, error, note FROM flows WHERE ${rowClause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
		params: [...rowValues, pageSize + 1, cursor ? 0 : (page - 1) * pageSize],
	};
	const results = await reader(
		cached ? [rowQuery] : [{ sql: `SELECT COUNT(*) AS n FROM flows WHERE ${clause}`, params: values }, rowQuery],
	);
	const total = cached?.total ?? (results[0][0] as { n: number } | undefined)?.n ?? 0;
	if (!cached) counts?.set(countKey, total, at, revision);
	const rows = results[cached ? 0 : 1] as FlowRow[];
	const items = rows.slice(0, pageSize).map(flow);
	const last = items.at(-1);
	return {
		items,
		total: cached && items.length > 0 ? Math.max(total, (page - 1) * pageSize + rows.length) : total,
		page,
		pageSize,
		nextCursor:
			rows.length > pageSize && last ? Buffer.from(JSON.stringify([last.ts, last.id])).toString("base64url") : null,
		totalCached: Boolean(cached),
		totalUpdatedAt: at,
	};
}

export async function getMitmFlow(
	directory: string,
	id: string,
	reader: MitmReader = readMitmStore(directory),
	previewBytes = 1024 * 1024,
): Promise<MitmFlowDetail> {
	if (!Number.isSafeInteger(previewBytes) || previewBytes < 0 || previewBytes > 1024 * 1024)
		throw new MitmError("报文预览大小无效。");
	const [rows] = await reader([{ sql: "SELECT * FROM flows WHERE id = ? AND source = 'proxy'", params: [id] }]);
	const row = rows[0] as FlowRow | undefined;
	if (!row) throw new MitmError("流量记录不存在。", 404);
	return {
		...flow(row),
		reqHeaders: JSON.parse(row.req_headers || "[]") as MitmHeader[],
		respHeaders: JSON.parse(row.resp_headers || "[]") as MitmHeader[],
		request: body(directory, row.req_raw_sha, row.req_size, previewBytes),
		response: body(directory, row.resp_raw_sha, row.resp_size ?? 0, previewBytes),
	};
}

/** Read only a bounded range; never load the full blob to serve an Agent page. */
export async function readMitmFlowChunk(
	directory: string,
	id: string,
	side: "request" | "response",
	offset: number,
	limit: number,
	reader: MitmReader = readMitmStore(directory),
): Promise<MitmBodyChunk> {
	if (side !== "request" && side !== "response") throw new MitmError("请选择请求或响应。");
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16384)
		throw new MitmError("offset 应为非负字节偏移，limit 应为 1–16384 字节。");
	const column = side === "request" ? "req" : "resp";
	const [rows] = await reader([
		{
			sql: `SELECT ${column}_raw_sha AS sha, ${column}_size AS size FROM flows WHERE id = ? AND source = 'proxy'`,
			params: [id],
		},
	]);
	const row = rows[0] as { sha: string | null; size: number | null } | undefined;
	if (!row) throw new MitmError("流量记录不存在。", 404);
	const path = mitmBlobPath(directory, row.sha);
	if (!path)
		return {
			text: "",
			encoding: "utf8",
			size: 0,
			truncated: false,
			captureTruncated: false,
			available: false,
			offset,
			bytesRead: 0,
			nextOffset: null,
		};
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const bytes = Buffer.alloc(Math.min(Math.max(size - offset, 0), limit));
		const length = readSync(fd, bytes, 0, bytes.length, Math.min(offset, size));
		const content = bytes.subarray(0, length);
		// A page may split a UTF-8 code point. Base64 preserves those bytes exactly.
		const utf8 = isUtf8(content);
		const nextOffset = offset + length < size ? offset + length : null;
		return {
			text: content.toString(utf8 ? "utf8" : "base64"),
			encoding: utf8 ? "utf8" : "base64",
			size,
			truncated: nextOffset !== null,
			captureTruncated: (row.size ?? 0) > size,
			available: true,
			offset,
			bytesRead: length,
			nextOffset,
		};
	} finally {
		closeSync(fd);
	}
}

export async function mitmRawPath(
	directory: string,
	id: string,
	side: string,
	reader: MitmReader = readMitmStore(directory),
): Promise<string> {
	if (side !== "request" && side !== "response") throw new MitmError("请选择请求或响应。");
	const column = side === "request" ? "req_raw_sha" : "resp_raw_sha";
	const [rows] = await reader([
		{ sql: `SELECT ${column} AS sha FROM flows WHERE id = ? AND source = 'proxy'`, params: [id] },
	]);
	const row = rows[0] as { sha: string | null } | undefined;
	const path = row ? mitmBlobPath(directory, row.sha) : null;
	if (!path || !existsSync(path)) throw new MitmError("没有可下载的原始报文。", 404);
	return path;
}
