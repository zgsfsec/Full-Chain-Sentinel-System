import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { listDoctrines, type SentinelDoctrine } from "./doctrines.ts";
import { canonicalJson, IntelligenceError, textValue } from "./intelligence-input.ts";
import {
	DEFAULT_INTELLIGENCE_POLICY,
	type IntelligenceAlert,
	type IntelligenceAttempt,
	type IntelligenceBatch,
	type IntelligenceBatchItem,
	type IntelligenceBatchStatus,
	type IntelligenceCleanup,
	type IntelligenceIndicator,
	type IntelligencePage,
	type IntelligencePolicy,
	type IntelligencePush,
	type IntelligenceReceipt,
	type IntelligenceSource,
} from "./intelligence-types.ts";
import { openSqliteDatabase, type SqliteDatabase, type SqliteValue } from "./sqlite.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intel_sources (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, last_received_at INTEGER
);
CREATE INDEX IF NOT EXISTS intel_sources_project ON intel_sources(project_id);
CREATE TABLE IF NOT EXISTS intel_receipts (
 source_id TEXT NOT NULL, request_id TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL,
 PRIMARY KEY(source_id, request_id)
);
CREATE TABLE IF NOT EXISTS intel_event_ids (
 source_id TEXT NOT NULL, event_id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(source_id,event_id)
);
CREATE TABLE IF NOT EXISTS intel_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, source_id TEXT NOT NULL,
 ip TEXT NOT NULL, received_at INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS intel_events_ip ON intel_events(project_id,ip,seq);
CREATE INDEX IF NOT EXISTS intel_events_source ON intel_events(project_id,source_id,received_at);
CREATE TABLE IF NOT EXISTS intel_indicators (
 project_id TEXT NOT NULL, ip TEXT NOT NULL, covered_seq INTEGER NOT NULL DEFAULT 0,
 cooldown_until INTEGER NOT NULL DEFAULT 0, hold_batch TEXT,
 PRIMARY KEY(project_id,ip)
);
CREATE TABLE IF NOT EXISTS intel_policies (project_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS intel_batches (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, snapshot TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS intel_batches_project ON intel_batches(project_id,created_at);
CREATE TABLE IF NOT EXISTS intel_attempts (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, number INTEGER NOT NULL, engine_id TEXT,
 status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, UNIQUE(batch_id,number)
);
CREATE INDEX IF NOT EXISTS intel_attempts_batch ON intel_attempts(batch_id,number);
`;

interface SourceRow {
	id: string;
	project_id: string;
	name: string;
	enabled: number;
	created_at: number;
	last_received_at: number | null;
}
interface BatchRow {
	id: string;
	project_id: string;
	status: IntelligenceBatchStatus;
	created_at: number;
	snapshot: string;
}
interface AttemptRow {
	id: string;
	batch_id: string;
	number: number;
	engine_id: string | null;
	status: IntelligenceBatchStatus;
	error: string | null;
	created_at: number;
}
interface EventRow {
	seq: number;
	source_id: string;
	name: string;
	received_at: number;
	payload: string;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sourceView = (row: SourceRow): IntelligenceSource => ({
	id: row.id,
	projectId: row.project_id,
	name: row.name,
	enabled: row.enabled === 1,
	createdAt: row.created_at,
	lastReceivedAt: row.last_received_at,
});
const attemptView = (row: AttemptRow): IntelligenceAttempt => ({
	id: row.id,
	batchId: row.batch_id,
	number: row.number,
	engineId: row.engine_id,
	status: row.status,
	error: row.error,
	createdAt: row.created_at,
});
const alertView = (row: EventRow): IntelligenceAlert => ({
	...JSON.parse(row.payload),
	seq: row.seq,
	sourceId: row.source_id,
	sourceName: row.name,
	receivedAt: row.received_at,
});

export class IntelligenceStore {
	private readonly db: SqliteDatabase;
	private readonly agentDir: string;
	constructor(path: string) {
		this.agentDir = dirname(path);
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
		this.db.exec(SCHEMA);
	}
	close(): void {
		this.db.close();
	}

	private transaction<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	sources(projectId: string): IntelligenceSource[] {
		const rows = this.db
			.prepare("SELECT * FROM intel_sources WHERE project_id=? ORDER BY created_at,id")
			.all(projectId) as unknown as SourceRow[];
		return rows.map(sourceView);
	}

	createSource(projectId: string, name: string, now = Date.now()): { source: IntelligenceSource; token: string } {
		const id = randomUUID();
		const token = `intel_${randomBytes(32).toString("base64url")}`;
		this.db
			.prepare("INSERT INTO intel_sources VALUES (?,?,?,?,1,?,NULL)")
			.run(id, projectId, textValue(name, "name", 120), hash(token), now);
		return { source: this.sources(projectId).find((source) => source.id === id) as IntelligenceSource, token };
	}

	updateSource(projectId: string, id: string, enabled: boolean, rotate: boolean): { token?: string } {
		if (!this.sources(projectId).some((source) => source.id === id)) throw new IntelligenceError("数据源不存在", 404);
		const token = rotate ? `intel_${randomBytes(32).toString("base64url")}` : undefined;
		if (token)
			this.db
				.prepare("UPDATE intel_sources SET enabled=?,token_hash=? WHERE id=? AND project_id=?")
				.run(Number(enabled), hash(token), id, projectId);
		else
			this.db
				.prepare("UPDATE intel_sources SET enabled=? WHERE id=? AND project_id=?")
				.run(Number(enabled), id, projectId);
		return token ? { token } : {};
	}

	authenticate(token: string): IntelligenceSource | undefined {
		if (!token || token.length > 200) return undefined;
		const row = this.db
			.prepare("SELECT * FROM intel_sources WHERE token_hash=? AND enabled=1")
			.get(hash(token)) as unknown as SourceRow | undefined;
		return row ? sourceView(row) : undefined;
	}

	ingest(source: IntelligenceSource, input: IntelligencePush, now = Date.now()): IntelligenceReceipt {
		return this.transaction(() => {
			const current = this.db
				.prepare("SELECT enabled FROM intel_sources WHERE id=? AND project_id=?")
				.get(source.id, source.projectId) as { enabled: number } | undefined;
			if (current?.enabled !== 1) throw new IntelligenceError("数据源已停用", 401);
			const bodyHash = hash(canonicalJson(input));
			const receipt = this.db
				.prepare("SELECT hash,result FROM intel_receipts WHERE source_id=? AND request_id=?")
				.get(source.id, input.request_id) as { hash: string; result: string } | undefined;
			if (receipt) {
				if (receipt.hash !== bodyHash) throw new IntelligenceError("request_id 已用于不同内容", 409);
				return JSON.parse(receipt.result) as IntelligenceReceipt;
			}
			let accepted = 0;
			let duplicates = 0;
			let newIps = 0;
			for (const event of input.events) {
				const eventHash = hash(canonicalJson(event));
				const prior = this.db
					.prepare("SELECT hash FROM intel_event_ids WHERE source_id=? AND event_id=?")
					.get(source.id, event.event_id) as { hash: string } | undefined;
				if (prior) {
					if (prior.hash !== eventHash)
						throw new IntelligenceError(`event_id ${event.event_id} 已用于不同内容`, 409);
					duplicates++;
					continue;
				}
				const ip = event.indicator.value;
				const inserted = this.db
					.prepare("INSERT OR IGNORE INTO intel_indicators(project_id,ip) VALUES (?,?)")
					.run(source.projectId, ip);
				newIps += Number(inserted.changes ?? 0);
				this.db.prepare("INSERT INTO intel_event_ids VALUES (?,?,?)").run(source.id, event.event_id, eventHash);
				this.db
					.prepare("INSERT INTO intel_events(project_id,source_id,ip,received_at,payload) VALUES (?,?,?,?,?)")
					.run(source.projectId, source.id, ip, now, JSON.stringify(event));
				accepted++;
			}
			const result = { requestId: input.request_id, accepted, duplicates, newIps };
			this.db
				.prepare("INSERT INTO intel_receipts VALUES (?,?,?,?)")
				.run(source.id, input.request_id, bodyHash, JSON.stringify(result));
			this.db.prepare("UPDATE intel_sources SET last_received_at=? WHERE id=?").run(now, source.id);
			return result;
		});
	}

	policy(projectId: string): IntelligencePolicy {
		const row = this.db.prepare("SELECT payload FROM intel_policies WHERE project_id=?").get(projectId) as
			| { payload: string }
			| undefined;
		const policy = row
			? (JSON.parse(row.payload) as IntelligencePolicy)
			: structuredClone(DEFAULT_INTELLIGENCE_POLICY);
		const doctrine = this.doctrines().find((item) => item.id === policy.template.id);
		if (doctrine) policy.template = { ...policy.template, name: doctrine.name, prompt: doctrine.text };
		return policy;
	}
	savePolicy(projectId: string, policy: IntelligencePolicy): void {
		const doctrine = this.doctrines().find((item) => item.id === policy.template.id);
		if (!doctrine) throw new IntelligenceError("工程指挥思路不存在，请重新选择", 409);
		this.db.prepare("INSERT OR REPLACE INTO intel_policies VALUES (?,?)").run(
			projectId,
			JSON.stringify({
				...policy,
				template: { ...policy.template, name: doctrine.name, prompt: doctrine.text },
			}),
		);
	}
	doctrines(): SentinelDoctrine[] {
		return listDoctrines(this.agentDir);
	}
	projects(): string[] {
		return (this.db.prepare("SELECT project_id FROM intel_policies").all() as { project_id: string }[]).map(
			(row) => row.project_id,
		);
	}

	indicators(
		projectId: string,
		page = 1,
		pageSize = 50,
		search = "",
		now = Date.now(),
	): IntelligencePage<IntelligenceIndicator> {
		const offset = (page - 1) * pageSize;
		const params = [projectId, `%${search}%`];
		const where =
			" WHERE i.project_id=? AND i.ip LIKE ? AND EXISTS(SELECT 1 FROM intel_events e WHERE e.project_id=i.project_id AND e.ip=i.ip)";
		const total = (
			this.db.prepare(`SELECT COUNT(*) n FROM intel_indicators i${where}`).get(...params) as { n: number }
		).n;
		const rows = this.db
			.prepare(`SELECT i.*,
 (SELECT COUNT(*) FROM intel_events e WHERE e.project_id=i.project_id AND e.ip=i.ip) AS n,
 (SELECT COUNT(*) FROM intel_events e WHERE e.project_id=i.project_id AND e.ip=i.ip AND e.seq>i.covered_seq) AS pending,
 (SELECT MIN(received_at) FROM intel_events e WHERE e.project_id=i.project_id AND e.ip=i.ip) AS first_seen,
 (SELECT MAX(received_at) FROM intel_events e WHERE e.project_id=i.project_id AND e.ip=i.ip) AS last_seen,
 (SELECT status FROM intel_batches b WHERE b.id=i.hold_batch) AS batch_status
 FROM intel_indicators i${where} ORDER BY last_seen DESC,i.ip LIMIT ? OFFSET ?`)
			.all(...params, pageSize, offset) as unknown as Array<{
			ip: string;
			n: number;
			pending: number;
			first_seen: number;
			last_seen: number;
			cooldown_until: number;
			hold_batch: string | null;
			batch_status: string | null;
		}>;
		return {
			total,
			page,
			pageSize,
			items: rows.map((row) => ({
				ip: row.ip,
				count: row.n,
				pending: row.pending,
				firstSeen: row.first_seen,
				lastSeen: row.last_seen,
				cooldownUntil: row.cooldown_until,
				batchId: row.hold_batch,
				sources: (
					this.db
						.prepare(
							"SELECT DISTINCT s.name FROM intel_events e JOIN intel_sources s ON s.id=e.source_id WHERE e.project_id=? AND e.ip=?",
						)
						.all(projectId, row.ip) as { name: string }[]
				).map((source) => source.name),
				status: row.hold_batch
					? ["failed", "aborted", "paused"].includes(row.batch_status ?? "")
						? "attention"
						: "processing"
					: row.pending === 0
						? "processed"
						: row.cooldown_until > now
							? "cooling"
							: "pending",
			})),
		};
	}

	alerts(projectId: string, ip: string, page = 1): IntelligencePage<IntelligenceAlert> {
		const total = (
			this.db.prepare("SELECT COUNT(*) n FROM intel_events WHERE project_id=? AND ip=?").get(projectId, ip) as {
				n: number;
			}
		).n;
		const rows = this.db
			.prepare(
				"SELECT e.*,s.name FROM intel_events e JOIN intel_sources s ON s.id=e.source_id WHERE e.project_id=? AND e.ip=? ORDER BY seq DESC LIMIT 50 OFFSET ?",
			)
			.all(projectId, ip, (page - 1) * 50) as unknown as EventRow[];
		return { items: rows.map(alertView), total, page, pageSize: 50 };
	}

	private candidates(projectId: string, now: number, limit: number): { ip: string; through_seq: number }[] {
		return this.db
			.prepare(`SELECT i.ip, MAX(e.seq) through_seq FROM intel_indicators i JOIN intel_events e ON e.project_id=i.project_id AND e.ip=i.ip
 WHERE i.project_id=? AND i.hold_batch IS NULL AND i.cooldown_until<=? AND e.seq>i.covered_seq
 GROUP BY i.ip ORDER BY MIN(e.seq),i.ip LIMIT ?`)
			.all(projectId, now, limit) as { ip: string; through_seq: number }[];
	}

	claim(projectId: string, now = Date.now()): IntelligenceBatch | undefined {
		return this.transaction(() => {
			const policy = this.policy(projectId);
			if (!policy.enabled || this.activeCount(projectId) >= policy.concurrency) return undefined;
			if (!this.doctrines().some((item) => item.id === policy.template.id)) return undefined;
			const candidates = this.candidates(projectId, now, policy.batchSize);
			if (candidates.length < policy.threshold) return undefined;
			const items: IntelligenceBatchItem[] = candidates.map((candidate) => {
				const rows = this.db
					.prepare(`SELECT e.*,s.name FROM intel_events e JOIN intel_sources s ON s.id=e.source_id
 JOIN intel_indicators i ON i.project_id=e.project_id AND i.ip=e.ip
 WHERE e.project_id=? AND e.ip=? AND e.seq>i.covered_seq AND e.seq<=? ORDER BY e.seq DESC LIMIT 10`)
					.all(projectId, candidate.ip, candidate.through_seq) as unknown as EventRow[];
				const count = (
					this.db
						.prepare(`SELECT COUNT(*) n FROM intel_events e JOIN intel_indicators i ON i.project_id=e.project_id AND i.ip=e.ip
 WHERE e.project_id=? AND e.ip=? AND e.seq>i.covered_seq AND e.seq<=?`)
						.get(projectId, candidate.ip, candidate.through_seq) as { n: number }
				).n;
				return {
					ip: candidate.ip,
					throughSeq: candidate.through_seq,
					alertCount: count,
					alerts: rows.map((row) => {
						const alert = alertView(row);
						const evidence = JSON.stringify(alert.evidence);
						return evidence.length > 2000
							? { ...alert, evidence: { excerpt: evidence.slice(0, 2000), truncated: true } }
							: alert;
					}),
				};
			});
			const id = randomUUID();
			const { template, ...rule } = policy;
			this.db
				.prepare("INSERT INTO intel_batches VALUES (?,?, 'queued',?,?)")
				.run(id, projectId, now, JSON.stringify({ template, policy: rule, items }));
			for (const candidate of candidates)
				this.db
					.prepare("UPDATE intel_indicators SET hold_batch=?,cooldown_until=? WHERE project_id=? AND ip=?")
					.run(id, now + policy.cooldownMinutes * 60000, projectId, candidate.ip);
			this.addAttempt(id, 1, now);
			return this.batch(projectId, id);
		});
	}

	activeCount(projectId: string): number {
		return (
			this.db
				.prepare(
					"SELECT COUNT(*) n FROM intel_batches WHERE project_id=? AND status IN ('queued','creating','running','paused')",
				)
				.get(projectId) as { n: number }
		).n;
	}

	private addAttempt(batchId: string, number: number, now: number): void {
		this.db
			.prepare("INSERT INTO intel_attempts VALUES (?,?,?,NULL,'queued',NULL,?)")
			.run(randomUUID(), batchId, number, now);
	}

	batch(projectId: string, id: string): IntelligenceBatch | undefined {
		const row = this.db
			.prepare("SELECT * FROM intel_batches WHERE project_id=? AND id=?")
			.get(projectId, id) as unknown as BatchRow | undefined;
		if (!row) return undefined;
		const snapshot = JSON.parse(row.snapshot) as Pick<IntelligenceBatch, "template" | "policy" | "items">;
		const attempts = (
			this.db
				.prepare("SELECT * FROM intel_attempts WHERE batch_id=? ORDER BY number")
				.all(id) as unknown as AttemptRow[]
		).map(attemptView);
		return { id, projectId, status: row.status, createdAt: row.created_at, ...snapshot, attempts };
	}

	batches(projectId: string, page = 1): IntelligencePage<Omit<IntelligenceBatch, "items"> & { ipCount: number }> {
		const total = (
			this.db.prepare("SELECT COUNT(*) n FROM intel_batches WHERE project_id=?").get(projectId) as { n: number }
		).n;
		const rows = this.db
			.prepare("SELECT id FROM intel_batches WHERE project_id=? ORDER BY created_at DESC,id LIMIT 20 OFFSET ?")
			.all(projectId, (page - 1) * 20) as { id: string }[];
		return {
			total,
			page,
			pageSize: 20,
			items: rows.map((row) => {
				const batch = this.batch(projectId, row.id);
				if (!batch) throw new Error("Missing batch");
				const { items, ...rest } = batch;
				return { ...rest, ipCount: items.length };
			}),
		};
	}

	unfinished(): IntelligenceBatch[] {
		const rows = this.db
			.prepare(
				"SELECT id,project_id FROM intel_batches WHERE status IN ('queued','creating','running','paused') ORDER BY created_at",
			)
			.all() as { id: string; project_id: string }[];
		return rows.flatMap((row) => {
			const batch = this.batch(row.project_id, row.id);
			return batch ? [batch] : [];
		});
	}

	setAttempt(
		batch: IntelligenceBatch,
		status: IntelligenceBatchStatus,
		engineId: string | null,
		error: string | null,
	): void {
		const attempt = batch.attempts.at(-1);
		if (!attempt) throw new Error("Missing attempt");
		this.transaction(() => {
			const current = this.batch(batch.projectId, batch.id);
			if (
				!current ||
				current.attempts.at(-1)?.id !== attempt.id ||
				["succeeded", "failed", "aborted", "discarded"].includes(current.status)
			)
				return;
			this.db
				.prepare("UPDATE intel_attempts SET status=?,engine_id=?,error=? WHERE id=?")
				.run(status, engineId, error, attempt.id);
			this.db.prepare("UPDATE intel_batches SET status=? WHERE id=?").run(status, batch.id);
			if (status === "succeeded") {
				for (const item of batch.items)
					this.db
						.prepare(
							"UPDATE intel_indicators SET covered_seq=MAX(covered_seq,?),hold_batch=NULL WHERE project_id=? AND ip=? AND hold_batch=?",
						)
						.run(item.throughSeq, batch.projectId, item.ip, batch.id);
			}
		});
	}

	retry(projectId: string, id: string, now = Date.now()): void {
		this.transaction(() => {
			const batch = this.batch(projectId, id);
			if (!batch) throw new IntelligenceError("批次不存在", 404);
			if (batch.status !== "failed" && batch.status !== "aborted")
				throw new IntelligenceError("仅失败或中止的批次可以重试", 409);
			if (this.activeCount(projectId) >= this.policy(projectId).concurrency)
				throw new IntelligenceError("项目分析并发已满，请稍后重试", 409);
			this.addAttempt(id, (batch.attempts.at(-1)?.number ?? 0) + 1, now);
			this.db.prepare("UPDATE intel_batches SET status='queued' WHERE id=?").run(id);
		});
	}

	discard(projectId: string, id: string): void {
		this.transaction(() => {
			const batch = this.batch(projectId, id);
			if (!batch) throw new IntelligenceError("批次不存在", 404);
			if (batch.status !== "failed" && batch.status !== "aborted")
				throw new IntelligenceError("仅失败或中止批次可以放弃", 409);
			this.db.prepare("UPDATE intel_batches SET status='discarded' WHERE id=?").run(id);
			for (const item of batch.items)
				this.db
					.prepare(
						"UPDATE intel_indicators SET covered_seq=MAX(covered_seq,?),hold_batch=NULL WHERE project_id=? AND ip=? AND hold_batch=?",
					)
					.run(item.throughSeq, projectId, item.ip, id);
		});
	}

	clear(projectId: string): void {
		this.transaction(() => {
			if (this.activeCount(projectId)) throw new IntelligenceError("请先中止项目内未结束的批次", 409);
			this.db
				.prepare("DELETE FROM intel_attempts WHERE batch_id IN (SELECT id FROM intel_batches WHERE project_id=?)")
				.run(projectId);
			for (const table of ["intel_batches", "intel_events", "intel_indicators"])
				this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(projectId);
		});
	}

	cleanup(
		projectId: string,
		filters: IntelligenceCleanup,
		execute: boolean,
	): { events: number; blockedBatches: number } {
		const conditions = ["e.project_id=?"];
		const params: SqliteValue[] = [projectId];
		if (filters.sourceId) {
			conditions.push("e.source_id=?");
			params.push(filters.sourceId);
		}
		if (filters.before !== undefined) {
			conditions.push("e.received_at<=?");
			params.push(filters.before);
		}
		if (filters.after !== undefined) {
			conditions.push("e.received_at>=?");
			params.push(filters.after);
		}
		const where = conditions.join(" AND ");
		return this.transaction(() => {
			const events = (
				this.db.prepare(`SELECT COUNT(*) n FROM intel_events e WHERE ${where}`).get(...params) as { n: number }
			).n;
			// Preserve evidence snapshots and the references needed by retries.
			const blockedBatches = (
				this.db
					.prepare(`SELECT COUNT(DISTINCT b.id) n FROM intel_batches b
 JOIN intel_indicators i ON i.hold_batch=b.id JOIN intel_events e ON e.project_id=i.project_id AND e.ip=i.ip
 WHERE ${where}`)
					.get(...params) as { n: number }
			).n;
			if (execute) {
				if (blockedBatches) throw new IntelligenceError("选中记录关联未结束或待重试批次，请先处理这些批次", 409);
				this.db
					.prepare(`DELETE FROM intel_events WHERE seq IN (SELECT e.seq FROM intel_events e WHERE ${where})`)
					.run(...params);
				// Keep sequence watermarks and duplicate tombstones: replaying a deleted
				// event must not recreate old work or reset an IP's cooldown.
			}
			return { events, blockedBatches };
		});
	}

	purgeProject(projectId: string): void {
		this.transaction(() => {
			for (const table of ["intel_receipts", "intel_event_ids"])
				this.db
					.prepare(`DELETE FROM ${table} WHERE source_id IN (SELECT id FROM intel_sources WHERE project_id=?)`)
					.run(projectId);
			this.db
				.prepare("DELETE FROM intel_attempts WHERE batch_id IN (SELECT id FROM intel_batches WHERE project_id=?)")
				.run(projectId);
			for (const table of ["intel_batches", "intel_events", "intel_indicators", "intel_policies", "intel_sources"])
				this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(projectId);
		});
	}
}
