/**
 * SQLite access that works both from a Node checkout and from a compiled Bun binary.
 *
 * Node exposes `node:sqlite`; Bun does not implement it and exposes `bun:sqlite`
 * instead. A compiled single-file binary carries no `node_modules`, so the module
 * has to be chosen at runtime rather than imported statically: a static import of
 * either specifier fails to resolve on the other runtime.
 *
 * The two implementations agree on the call surface used here (`exec`, `prepare`,
 * `run`, `get`, `all`, `close`), which is what lets the sub-agent store stay
 * runtime-agnostic.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Values the store binds into statements. */
export type SqliteValue = string | number | bigint | null | Uint8Array;

export interface SqliteStatement {
	run(...params: SqliteValue[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
	all(...params: SqliteValue[]): unknown[];
	get(...params: SqliteValue[]): unknown;
}

export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

interface SqliteModule {
	DatabaseSync?: new (path: string, options?: { readOnly: boolean }) => SqliteDatabase;
	Database?: new (path: string, options?: { readonly: boolean }) => SqliteDatabase;
}

function loadSqliteModule(): SqliteModule {
	// Try the runtime's own implementation first; the fallback covers a Bun binary
	// running against a Node build (or the reverse) without changing the caller.
	const specifiers = process.versions.bun ? ["bun:sqlite", "node:sqlite"] : ["node:sqlite", "bun:sqlite"];
	let lastError: unknown;
	for (const specifier of specifiers) {
		try {
			return require(specifier) as SqliteModule;
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`无法加载 SQLite 运行时：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Open a database; read-only observers neither create files nor run migrations. */
export function openSqliteDatabase(path: string, options: { readOnly: boolean } = { readOnly: false }): SqliteDatabase {
	const module = loadSqliteModule();
	if (module.DatabaseSync) return new module.DatabaseSync(path, { readOnly: options.readOnly });
	if (module.Database)
		return options.readOnly ? new module.Database(path, { readonly: true }) : new module.Database(path);
	throw new Error("SQLite 运行时未导出 DatabaseSync/Database");
}
