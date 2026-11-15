import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	checkObject,
	checkString,
	parseSecurityCheckMarkdown,
	parseSecurityCheckRepository,
} from "./security-check-input.ts";
import {
	SECURITY_CHECK_OFFICIAL_REPOSITORY,
	type SecurityCheckRule,
	type SecurityCheckSource,
	type SecurityCheckSyncRecord,
} from "./security-check-types.ts";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

export class SecurityCheckStore {
	private readonly db: SqliteDatabase;
	constructor(agentDir: string) {
		mkdirSync(agentDir, { recursive: true });
		this.db = openSqliteDatabase(join(agentDir, "security-checks.db"));
		this.db.exec(`PRAGMA journal_mode=WAL;
		CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY);
		CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, value TEXT NOT NULL);
		CREATE INDEX IF NOT EXISTS rules_source ON rules(source_id);
		CREATE TABLE IF NOT EXISTS sync_records (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, value TEXT NOT NULL);`);
		if (!this.db.prepare("SELECT id FROM settings WHERE id='initialized'").get()) {
			this.writeSource({
				id: "official",
				name: "官方安全检查规则",
				repository: SECURITY_CHECK_OFFICIAL_REPOSITORY,
				branch: "main",
				directory: "rules/security-checks",
				enabled: true,
				intervalHours: 24,
				lastCheckedAt: null,
				lastSuccessAt: null,
				nextSyncAt: Date.now(),
				commit: "",
				error: null,
				failures: 0,
			});
			this.db.prepare("INSERT INTO settings VALUES ('initialized')").run();
		}
	}
	listRules(): SecurityCheckRule[] {
		return (this.db.prepare("SELECT value FROM rules ORDER BY id").all() as { value: string }[]).map(
			(row) => JSON.parse(row.value) as SecurityCheckRule,
		);
	}
	getRule(id: string): SecurityCheckRule {
		const row = this.db.prepare("SELECT value FROM rules WHERE id=?").get(id) as { value: string } | undefined;
		if (!row) throw new Error("规则不存在或已下架");
		return JSON.parse(row.value) as SecurityCheckRule;
	}
	listSources(): SecurityCheckSource[] {
		return (this.db.prepare("SELECT value FROM sources ORDER BY id").all() as { value: string }[]).map(
			(row) => JSON.parse(row.value) as SecurityCheckSource,
		);
	}
	getSource(id: string): SecurityCheckSource {
		const source = this.listSources().find((item) => item.id === id);
		if (!source) throw new Error("规则源不存在");
		return source;
	}
	private writeSource(source: SecurityCheckSource): void {
		this.db.prepare("INSERT OR REPLACE INTO sources VALUES (?,?)").run(source.id, JSON.stringify(source));
	}
	saveSource(value: unknown): SecurityCheckSource {
		const input = checkObject(value);
		const id = input.id === undefined ? randomUUID() : checkString(input.id, "规则源 ID", 128);
		const existing = input.id === undefined ? undefined : this.getSource(id);
		const branch = checkString(input.branch, "分支", 256);
		const directory = checkString(input.directory, "目录", 512).replace(/\/$/, "");
		if (directory.split("/").some((part) => !part || part === "." || part === "..") || directory.includes("\\"))
			throw new Error("规则目录无效");
		if (
			typeof input.enabled !== "boolean" ||
			typeof input.intervalHours !== "number" ||
			!Number.isInteger(input.intervalHours) ||
			input.intervalHours < 1 ||
			input.intervalHours > 720
		)
			throw new Error("同步周期必须为 1–720 小时，启用状态必须为布尔值");
		const source: SecurityCheckSource = {
			id,
			name: checkString(input.name, "规则源名称", 128),
			repository: parseSecurityCheckRepository(input.repository),
			branch,
			directory,
			enabled: input.enabled,
			intervalHours: input.intervalHours,
			lastCheckedAt: existing?.lastCheckedAt ?? null,
			lastSuccessAt: existing?.lastSuccessAt ?? null,
			nextSyncAt: Date.now(),
			commit: "",
			error: null,
			failures: 0,
		};
		this.writeSource(source);
		return source;
	}
	deleteSource(id: string): void {
		this.getSource(id);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("DELETE FROM rules WHERE source_id=?").run(id);
			this.db.prepare("DELETE FROM sync_records WHERE source_id=?").run(id);
			this.db.prepare("DELETE FROM sources WHERE id=?").run(id);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	saveRule(markdown: string, id?: string, version?: string, copiedFrom?: string): SecurityCheckRule {
		const rule = parseSecurityCheckMarkdown(markdown, "local");
		if (id) {
			const existing = this.getRule(id);
			if (existing.sourceId !== "local") throw new Error("同步规则只读，请复制为自定义规则");
			if (existing.version !== version) throw new Error("规则已修改，请刷新后重试");
			if (rule.id !== id) throw new Error("编辑时不能修改规则 ID");
			rule.copiedFrom = existing.copiedFrom;
		} else if (this.db.prepare("SELECT id FROM rules WHERE id=?").get(rule.id))
			throw new Error("自定义规则 ID 已存在");
		if (copiedFrom) rule.copiedFrom = copiedFrom;
		this.db.prepare("INSERT OR REPLACE INTO rules VALUES (?,?,?)").run(rule.id, "local", JSON.stringify(rule));
		return rule;
	}
	deleteRule(id: string, version: string): void {
		const rule = this.getRule(id);
		if (rule.sourceId !== "local") throw new Error("同步规则不能直接删除，请修改规则源");
		if (rule.version !== version) throw new Error("规则已修改，请刷新后重试");
		this.db.prepare("DELETE FROM rules WHERE id=?").run(id);
	}
	history(sourceId: string): SecurityCheckSyncRecord[] {
		return (
			this.db
				.prepare("SELECT value FROM sync_records WHERE source_id=? ORDER BY id DESC LIMIT 20")
				.all(sourceId) as { value: string }[]
		).map((row) => JSON.parse(row.value) as SecurityCheckSyncRecord);
	}
	finishSync(
		source: SecurityCheckSource,
		rules: SecurityCheckRule[] | null,
		commit: string,
		error: string | null,
		now = Date.now(),
	): void {
		// Saving/deleting a source while the network request runs invalidates that request.
		if (JSON.stringify(this.getSource(source.id)) !== JSON.stringify(source))
			throw new Error("规则源已修改，请重新同步");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (rules) {
				this.db.prepare("DELETE FROM rules WHERE source_id=?").run(source.id);
				for (const rule of rules)
					this.db.prepare("INSERT INTO rules VALUES (?,?,?)").run(rule.id, source.id, JSON.stringify(rule));
			}
			const failures = error ? source.failures + 1 : 0;
			this.writeSource({
				...source,
				commit: error ? source.commit : commit,
				lastCheckedAt: now,
				lastSuccessAt: error ? source.lastSuccessAt : now,
				nextSyncAt:
					now +
					(error
						? Math.min(24 * 3600_000, 5 * 60_000 * 2 ** Math.min(failures - 1, 8))
						: source.intervalHours * 3600_000),
				error,
				failures,
			});
			this.db.prepare("INSERT INTO sync_records(source_id,value) VALUES (?,?)").run(
				source.id,
				JSON.stringify({
					at: now,
					ok: !error,
					message: error ?? (rules ? "同步完成" : "规则无变化"),
					count: rules?.length ?? 0,
				}),
			);
			this.db
				.prepare(
					"DELETE FROM sync_records WHERE source_id=? AND id NOT IN (SELECT id FROM sync_records WHERE source_id=? ORDER BY id DESC LIMIT 20)",
				)
				.run(source.id, source.id);
			this.db.exec("COMMIT");
		} catch (cause) {
			this.db.exec("ROLLBACK");
			throw cause;
		}
	}
	close(): void {
		this.db.close();
	}
}
