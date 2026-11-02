/** Read replayd's native SQLite/blob format, including while the capture worker is stopped. */
import { isUtf8 } from "node:buffer";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { MitmBody, MitmFlow, MitmFlowDetail, MitmFlowPage, MitmHeader } from "./mitm-types.ts";
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

function body(directory: string, sha: string | null, originalSize: number): MitmBody {
	const path = mitmBlobPath(directory, sha);
	if (!path) return { text: "", encoding: "utf8", size: 0, truncated: false, captureTruncated: false };
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const bytes = Buffer.alloc(Math.min(size, 1024 * 1024));
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

function readStore(directory: string, queries: MitmQuery[]): unknown[][] {
	const path = join(directory, "replayd.db");
	if (!existsSync(path)) return queries.map(() => []);
	const db = openSqliteDatabase(path);
	try {
		db.exec("PRAGMA busy_timeout = 1000; PRAGMA query_only = ON;");
		if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'flows'").get())
			return queries.map(() => []);
		db.exec("BEGIN");
		return queries.map((query) => db.prepare(query.sql).all(...query.params));
	} finally {
		db.close();
	}
}

export async function listMitmFlows(
	directory: string,
	params: URLSearchParams,
	reader: MitmReader = async (queries) => readStore(directory, queries),
): Promise<MitmFlowPage> {
	const requestedPage = Number(params.get("page") ?? 1);
	const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 1_000_000) : 1;
	const pageSize = 50;
	const where = ["source = 'proxy'"];
	const values: SqliteValue[] = [];
	for (const [key, column] of [
		["q", "(host || path || COALESCE(query,''))"],
		["host", "host"],
	]) {
		const value = params.get(key)?.trim();
		if (value) {
			where.push(`instr(lower(${column}), lower(?)) > 0`);
			values.push(value.slice(0, 2048));
		}
	}
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
	const [count, rows] = await reader([
		{ sql: `SELECT COUNT(*) AS n FROM flows WHERE ${clause}`, params: values },
		{
			sql: `SELECT * FROM flows WHERE ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
			params: [...values, pageSize, (page - 1) * pageSize],
		},
	]);
	return {
		items: (rows as FlowRow[]).map(flow),
		total: (count[0] as { n: number } | undefined)?.n ?? 0,
		page,
		pageSize,
	};
}

export async function getMitmFlow(
	directory: string,
	id: string,
	reader: MitmReader = async (queries) => readStore(directory, queries),
): Promise<MitmFlowDetail> {
	const [rows] = await reader([{ sql: "SELECT * FROM flows WHERE id = ? AND source = 'proxy'", params: [id] }]);
	const row = rows[0] as FlowRow | undefined;
	if (!row) throw new MitmError("流量记录不存在。", 404);
	return {
		...flow(row),
		reqHeaders: JSON.parse(row.req_headers || "[]") as MitmHeader[],
		respHeaders: JSON.parse(row.resp_headers || "[]") as MitmHeader[],
		request: body(directory, row.req_raw_sha, row.req_size),
		response: body(directory, row.resp_raw_sha, row.resp_size ?? 0),
	};
}

export async function mitmRawPath(
	directory: string,
	id: string,
	side: string,
	reader: MitmReader = async (queries) => readStore(directory, queries),
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
