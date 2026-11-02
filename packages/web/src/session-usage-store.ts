/** Durable, deduplicated usage from session transcripts, independent of the viewed session. */

import { createHash } from "node:crypto";
import { createReadStream, type Dirent, mkdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { SentinelUsageTotals } from "./protocol.ts";
import { openSqliteDatabase, type SqliteDatabase, type SqliteStatement } from "./sqlite.ts";

interface UsageRow {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function counter(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageRow(raw: unknown): { key: string; usage: UsageRow } | undefined {
	const entry = record(raw);
	if (!entry || typeof entry.id !== "string" || typeof entry.timestamp !== "string") return undefined;
	const message = record(entry.message);
	const rawUsage =
		entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
			? entry.usage
			: entry.type === "message" && (message?.role === "assistant" || message?.role === "toolResult")
				? message.usage
				: undefined;
	const source = record(rawUsage);
	if (!source) return undefined;
	const usage: UsageRow = {
		input: counter(source.input),
		output: counter(source.output),
		cacheRead: counter(source.cacheRead),
		cacheWrite: counter(source.cacheWrite),
		cost: counter(record(source.cost)?.total),
	};
	if (Object.values(usage).every((value) => value === 0)) return undefined;
	// Forks retain entry IDs and timestamps but may rewrite parentId. Neither
	// the containing session ID nor parentId identifies a new billable call.
	const key = createHash("sha256")
		.update(JSON.stringify([entry.id, entry.timestamp, entry.type, usage]))
		.digest("hex");
	return { key, usage };
}

export class SessionUsageStore {
	private readonly db: SqliteDatabase;
	private readonly insert: SqliteStatement;
	private readonly recorded = new WeakSet<object>();

	constructor(agentDir: string) {
		const path = join(agentDir, "session-usage.db");
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS session_usage (
				key TEXT PRIMARY KEY,
				input REAL NOT NULL, output REAL NOT NULL,
				cacheRead REAL NOT NULL, cacheWrite REAL NOT NULL, cost REAL NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_usage_files (
				path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL
			);
		`);
		this.insert = this.db.prepare("INSERT OR IGNORE INTO session_usage VALUES (?, ?, ?, ?, ?, ?)");
	}

	/** Never subtract usage when a transcript or project is deleted. */
	recordEntries(entries: readonly unknown[]): void {
		const rows = entries.flatMap((raw) => {
			const entry = record(raw);
			if (!entry || this.recorded.has(entry)) return [];
			const row = usageRow(entry);
			return row ? [{ ...row, entry }] : [];
		});
		if (rows.length === 0) return;
		this.db.exec("BEGIN");
		try {
			for (const { key, usage } of rows) {
				this.insert.run(key, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost);
			}
			this.db.exec("COMMIT");
			for (const { entry } of rows) this.recorded.add(entry);
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Import existing transcripts without opening or modifying them through SessionManager. */
	async backfill(directory: string): Promise<void> {
		let files: Dirent[];
		try {
			files = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const file of files) {
			const path = join(directory, file.name);
			if (file.isDirectory()) {
				await this.backfill(path);
			} else if (file.isFile() && file.name.endsWith(".jsonl")) {
				try {
					await this.importFile(path);
				} catch (error) {
					// One unreadable transcript must not hide the other sessions' usage.
					console.error(`[sentinel] Usage import failed for ${path}: ${String(error)}`);
				}
			}
		}
	}

	private async importFile(path: string): Promise<void> {
		const info = await stat(path);
		const previous = this.db.prepare("SELECT size, mtime FROM session_usage_files WHERE path = ?").get(path) as
			| { size: number; mtime: number }
			| undefined;
		if (previous?.size === info.size && previous.mtime === info.mtimeMs) return;
		const stream = createReadStream(path, { encoding: "utf8" });
		const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
		const batch: unknown[] = [];
		try {
			for await (const line of lines) {
				let entry: unknown;
				try {
					entry = JSON.parse(line);
				} catch {
					// A malformed line or crash-truncated tail does not erase earlier usage.
					continue;
				}
				batch.push(entry);
				if (batch.length >= 250) {
					this.recordEntries(batch);
					batch.length = 0;
				}
			}
			this.recordEntries(batch);
		} finally {
			lines.close();
			stream.destroy();
		}
		this.db.prepare("INSERT OR REPLACE INTO session_usage_files VALUES (?, ?, ?)").run(path, info.size, info.mtimeMs);
	}

	totals(): SentinelUsageTotals {
		const row = this.db
			.prepare(`SELECT COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output,
				COALESCE(SUM(cacheRead), 0) AS cacheRead, COALESCE(SUM(cacheWrite), 0) AS cacheWrite,
				COALESCE(SUM(cost), 0) AS cost FROM session_usage`)
			.get() as UsageRow;
		return {
			tokens: {
				input: row.input,
				output: row.output,
				cacheRead: row.cacheRead,
				cacheWrite: row.cacheWrite,
				total: row.input + row.output + row.cacheRead + row.cacheWrite,
			},
			cost: row.cost,
		};
	}

	close(): void {
		this.db.close();
	}
}
