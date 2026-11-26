/**
 * Vulnerability hub: the permanent record of findings.
 *
 * The agent submits findings while it works; the operator reviews them on the
 * hub page. Records are project-scoped, numbered inside their project, and never
 * edited by the agent after submission — only the operator moves a record's
 * status, which is what keeps "the model believes it" and "someone reproduced
 * it" distinguishable.
 *
 * Storage is one SQLite database in the agent directory, not in the project work
 * directory: the work directory is mounted into the container, and a bash command
 * could otherwise read or rewrite the hub.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { t } from "./i18n.ts";
import type {
	SentinelVulnEvidence,
	SentinelVulnerability,
	SentinelVulnFilters,
	SentinelVulnNote,
	SentinelVulnPage,
	SentinelVulnReview,
	SentinelVulnSeverity,
	SentinelVulnStats,
	SentinelVulnStatus,
	SentinelVulnSummary,
	SentinelVulnUpdate,
} from "./protocol.ts";
import { openSqliteDatabase, type SqliteDatabase, type SqliteValue } from "./sqlite.ts";

export const SENTINEL_VULN_SEVERITIES: readonly SentinelVulnSeverity[] = ["critical", "high", "medium", "low", "info"];
export const SENTINEL_VULN_STATUSES: readonly SentinelVulnStatus[] = [
	"pending",
	"confirmed",
	"false_positive",
	"fixed",
];
/** A page of the hub's list: fifty rows unless the operator asks for fewer or more, never more than two hundred. */
export const DEFAULT_VULN_PAGE_SIZE = 50;
export const MAX_VULN_PAGE_SIZE = 200;

/** Chinese labels, used by the Markdown export and the notification. */
export const SENTINEL_VULN_SEVERITY_LABELS: Record<SentinelVulnSeverity, string> = {
	critical: "严重",
	high: "高危",
	medium: "中危",
	low: "低危",
	info: "信息",
};

export const SENTINEL_VULN_STATUS_LABELS: Record<SentinelVulnStatus, string> = {
	pending: "待确认",
	confirmed: "已确认",
	false_positive: "误报",
	fixed: "已修复",
};

/** Highest score first, so a report and the page agree on the order. */
export function severityRank(severity: SentinelVulnSeverity): number {
	return SENTINEL_VULN_SEVERITIES.length - SENTINEL_VULN_SEVERITIES.indexOf(severity);
}

/**
 * The severity bucket a CVSS base score belongs to. Used to flag a record whose
 * five-level label disagrees with its own score instead of silently trusting one.
 */
export function severityForCvss(cvss: number): SentinelVulnSeverity {
	if (cvss >= 9) return "critical";
	if (cvss >= 7) return "high";
	if (cvss >= 4) return "medium";
	if (cvss > 0) return "low";
	return "info";
}

export function isSeverityMismatch(severity: SentinelVulnSeverity, cvss: number): boolean {
	return severityForCvss(cvss) !== severity;
}

/** Human-readable id prefix derived from the project name, e.g. "E2E-PROJECT". */
export function vulnPrefix(projectName: string): string {
	const slug = projectName
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9\u4e00-\u9fa5]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 20);
	return slug || "VULN";
}

export function vulnLabel(prefix: string, number: number): string {
	return `${prefix}-${String(number).padStart(4, "0")}`;
}

export interface SentinelVulnCreateInput {
	projectId: string;
	projectName: string;
	sessionId?: string;
	/** Engineering provenance, when the submission came from an engine task. */
	engineId?: string;
	taskId?: string;
	/** Display name of the session at submission time, for records whose session is gone. */
	sessionName?: string;
	/** Inventory asset this finding is linked to, when the submitter named one. */
	assetId?: string;
	/** Asset label snapshot, so the hub can show it after the asset is gone. */
	assetLabel?: string;
	/** Who submitted it, e.g. "主代理" or "子代理 <runId>". */
	source: string;
	title: string;
	severity: SentinelVulnSeverity;
	cvss: number;
	cvssVector?: string;
	target: string;
	category?: string;
	description: string;
	/** Raw request or packet, verbatim. */
	packet: string;
	repro?: string;
	remediation?: string;
	references?: string[];
	evidence?: SentinelVulnEvidence[];
	/** 平台：默认 Web；安卓渗透提交时标 android 并附包名/版本。 */
	platform?: "web" | "android";
	appPackage?: string;
	appVersion?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vulnerabilities (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  number INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  session_id TEXT,
  engine_id TEXT,
  task_id TEXT,
  session_name TEXT,
  asset_id TEXT,
  asset_label TEXT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  cvss REAL NOT NULL,
  cvss_vector TEXT,
  status TEXT NOT NULL,
  target TEXT NOT NULL,
  category TEXT,
  platform TEXT NOT NULL DEFAULT 'web',
  app_package TEXT,
  app_version TEXT,
  description TEXT NOT NULL,
  packet TEXT NOT NULL,
  repro TEXT,
  remediation TEXT,
  refs TEXT,
  review TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vulnerability_evidence (
  vuln_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  command TEXT,
  output TEXT,
  path TEXT,
  note TEXT,
  PRIMARY KEY (vuln_id, seq)
);
CREATE TABLE IF NOT EXISTS vulnerability_notes (
  vuln_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  status_from TEXT,
  status_to TEXT,
  PRIMARY KEY (vuln_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_vulns_project ON vulnerabilities(project_id, number DESC);
CREATE INDEX IF NOT EXISTS idx_vulns_label ON vulnerabilities(project_id, label);
`;

interface VulnRow {
	id: string;
	label: string;
	number: number;
	project_id: string;
	project_name: string;
	session_id: string | null;
	engine_id: string | null;
	task_id: string | null;
	session_name: string | null;
	asset_id: string | null;
	asset_label: string | null;
	source: string;
	title: string;
	severity: string;
	cvss: number;
	cvss_vector: string | null;
	status: string;
	target: string;
	category: string | null;
	platform: string;
	app_package: string | null;
	app_version: string | null;
	description: string;
	packet: string;
	repro: string | null;
	remediation: string | null;
	refs: string | null;
	review: string | null;
	created_at: string;
	updated_at: string;
}

interface EvidenceRow {
	kind: string;
	command: string | null;
	output: string | null;
	path: string | null;
	note: string | null;
}

interface NoteRow {
	at: string;
	author: string;
	text: string;
	status_from: string | null;
	status_to: string | null;
}

function optional(value: string | null | undefined): string | undefined {
	return value === null || value === undefined || value === "" ? undefined : value;
}

/** `%` and `_` in an operator filter must match literally. */
function likePattern(value: string): string {
	return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function parseReferences(raw: string | null): string[] | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) {
			const items = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
			return items.length > 0 ? items : undefined;
		}
	} catch {
		// A hand-edited row falls back to the raw text.
	}
	return [raw];
}

export function vulnerabilityDbPath(agentDir: string): string {
	return `${agentDir}/vulnerabilities.db`;
}

/** Zeroed counts, used when no project is selected. */
export function emptyVulnStats(): SentinelVulnStats {
	return {
		total: 0,
		bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
		byStatus: { pending: 0, confirmed: 0, false_positive: 0, fixed: 0 },
	};
}

export class VulnerabilityStore {
	private readonly db: SqliteDatabase;
	/** True when this open added the provenance columns, so a backfill is due. */
	private provenanceMigrated = false;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		this.addReviewColumn();
		this.addDroidColumns();
		this.addProvenanceColumns();
		this.addAssetColumns();
	}

	/**
	 * Databases created before findings recorded where they came from have no
	 * engine/task/session-name columns. They are filled in on submission from here
	 * on; existing rows keep their `session_id` (which is what filtering uses) and
	 * are backfilled once by the runtime, which is the only layer that can see the
	 * engines and session files.
	 */
	private addProvenanceColumns(): void {
		const columns = this.db.prepare("PRAGMA table_info(vulnerabilities)").all() as unknown as Array<{ name: string }>;
		const names = columns.map((column) => column.name);
		if (!names.includes("engine_id")) {
			this.db.exec("ALTER TABLE vulnerabilities ADD COLUMN engine_id TEXT");
			// Only the runtime can map sessions to engines and names, so it is asked
			// to backfill once, after this migration.
			this.provenanceMigrated = true;
		}
		if (!names.includes("task_id")) this.db.exec("ALTER TABLE vulnerabilities ADD COLUMN task_id TEXT");
		if (!names.includes("session_name")) this.db.exec("ALTER TABLE vulnerabilities ADD COLUMN session_name TEXT");
	}

	/** Databases created before the asset inventory existed have no link columns. */
	private addAssetColumns(): void {
		const columns = this.db.prepare("PRAGMA table_info(vulnerabilities)").all() as unknown as Array<{ name: string }>;
		const names = columns.map((column) => column.name);
		if (!names.includes("asset_id")) this.db.exec("ALTER TABLE vulnerabilities ADD COLUMN asset_id TEXT");
		if (!names.includes("asset_label")) this.db.exec("ALTER TABLE vulnerabilities ADD COLUMN asset_label TEXT");
		// The index is created after the columns, so an old database that gains
		// them in this pass does not fail on a missing column.
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_vulns_asset ON vulnerabilities(project_id, asset_id)");
	}

	/** Databases created before the Droid plugin existed have no platform columns. */
	private addDroidColumns(): void {
		const columns = this.db.prepare("PRAGMA table_info(vulnerabilities)").all() as unknown as Array<{ name: string }>;
		const names = columns.map((column) => column.name);
		if (!names.includes("platform"))
			this.db.exec("ALTER TABLE vulnerabilities ADD COLUMN platform TEXT NOT NULL DEFAULT 'web'");
		if (!names.includes("app_package")) this.db.exec("ALTER TABLE vulnerabilities ADD COLUMN app_package TEXT");
		if (!names.includes("app_version")) this.db.exec("ALTER TABLE vulnerabilities ADD COLUMN app_version TEXT");
	}

	/** True on the one startup that added the provenance columns. */
	needsProvenanceBackfill(): boolean {
		return this.provenanceMigrated;
	}

	/** Databases created before the reviewer existed have no review column. */
	private addReviewColumn(): void {
		const columns = this.db.prepare("PRAGMA table_info(vulnerabilities)").all() as unknown as Array<{ name: string }>;
		if (columns.some((column) => column.name === "review")) return;
		this.db.exec("ALTER TABLE vulnerabilities ADD COLUMN review TEXT");
	}

	/** Next sequence number inside one project; the hub is single-process, so no race. */
	private nextNumber(projectId: string): number {
		const row = this.db
			.prepare("SELECT COALESCE(MAX(number), 0) AS last FROM vulnerabilities WHERE project_id = ?")
			.get(projectId) as unknown as { last: number } | undefined;
		return Number(row?.last ?? 0) + 1;
	}

	create(input: SentinelVulnCreateInput): SentinelVulnerability {
		const id = randomUUID();
		const number = this.nextNumber(input.projectId);
		const prefix = vulnPrefix(input.projectName);
		const label = vulnLabel(prefix, number);
		const now = new Date().toISOString();
		// Fresh submissions start queued for the reviewer LLM; it calibrates the
		// agent's self-assigned rating asynchronously at the hub layer. The
		// agent's own numbers ride along so the console can label them as
		// 「自评」 for as long as no reviewer verdict exists.
		const review: SentinelVulnReview = {
			state: "queued",
			at: Date.now(),
			agentSeverity: input.severity,
			agentCvss: input.cvss,
		};
		this.db
			.prepare(
				`INSERT INTO vulnerabilities (
					id, label, number, project_id, project_name, session_id, engine_id, task_id, session_name,
					asset_id, asset_label, source, title, severity, cvss,
					cvss_vector, status, target, category, platform, app_package, app_version, description, packet,
					repro, remediation, refs, review, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				label,
				number,
				input.projectId,
				input.projectName,
				input.sessionId ?? null,
				input.engineId ?? null,
				input.taskId ?? null,
				input.sessionName ?? null,
				input.assetId ?? null,
				input.assetLabel ?? null,
				input.source,
				input.title,
				input.severity,
				input.cvss,
				input.cvssVector ?? null,
				input.target,
				input.category ?? null,
				input.platform ?? "web",
				input.appPackage ?? null,
				input.appVersion ?? null,
				input.description,
				input.packet,
				input.repro ?? null,
				input.remediation ?? null,
				input.references && input.references.length > 0 ? JSON.stringify(input.references) : null,
				JSON.stringify(review),
				now,
				now,
			);
		const evidence = input.evidence ?? [];
		for (const [index, item] of evidence.entries()) {
			this.db
				.prepare(
					`INSERT INTO vulnerability_evidence (vuln_id, seq, kind, command, output, path, note)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					index + 1,
					item.kind,
					item.command ?? null,
					item.output ?? null,
					item.path ?? null,
					item.note ?? null,
				);
		}
		this.appendNote(id, {
			author: "agent",
			text: t("由 {source} 提交", { source: input.source }),
		});
		const created = this.get(id);
		if (!created) throw new Error(t("漏洞记录写入失败"));
		return created;
	}

	get(id: string): SentinelVulnerability | undefined {
		const row = this.db.prepare("SELECT * FROM vulnerabilities WHERE id = ?").get(id) as unknown as
			| VulnRow
			| undefined;
		if (!row) return undefined;
		const evidence = this.db
			.prepare(
				"SELECT kind, command, output, path, note FROM vulnerability_evidence WHERE vuln_id = ? ORDER BY seq ASC",
			)
			.all(id) as unknown as EvidenceRow[];
		const notes = this.db
			.prepare(
				"SELECT at, author, text, status_from, status_to FROM vulnerability_notes WHERE vuln_id = ? ORDER BY seq ASC",
			)
			.all(id) as unknown as NoteRow[];
		return toVulnerability(row, evidence, notes);
	}

	/** Look up by id or by the human-readable label, always inside one project. */
	find(projectId: string, idOrLabel: string): SentinelVulnerability | undefined {
		const trimmed = idOrLabel.trim();
		const byLabel = this.db
			.prepare("SELECT id FROM vulnerabilities WHERE project_id = ? AND label = ? COLLATE NOCASE")
			.get(projectId, trimmed) as unknown as { id: string } | undefined;
		const found =
			byLabel ??
			(this.db.prepare("SELECT id FROM vulnerabilities WHERE id = ?").get(trimmed) as unknown as
				| { id: string }
				| undefined);
		return found ? this.get(found.id) : undefined;
	}

	/**
	 * Apply the reviewer LLM's verdict. An automatic review only calibrates a
	 * still-pending record with a queued review — anything the operator already
	 * touched is out of the machine's hands. `force` is the operator's own
	 * re-review from the hub, which does overwrite their edits; the timeline
	 * says so. Either way the change rides the same timeline as every other
	 * edit, authored as "system".
	 */
	applyReview(
		id: string,
		verdict: {
			severity: SentinelVulnSeverity;
			cvss: number;
			cvssVector?: string;
			dubious: boolean;
			reason: string;
			model: string;
		},
		force = false,
	): SentinelVulnerability | undefined {
		const existing = this.get(id);
		if (!existing) return undefined;
		if (existing.review.state !== "queued") return existing;
		if (existing.status !== "pending" && !force) return existing;
		const review: SentinelVulnReview = {
			state: "done",
			severity: verdict.severity,
			cvss: verdict.cvss,
			...(verdict.cvssVector ? { cvssVector: verdict.cvssVector } : {}),
			verdict: verdict.dubious ? "dubious" : "solid",
			reason: verdict.reason,
			model: verdict.model,
			// The agent's own numbers stay on the record beside the verdict, so
			// the console can show what the claim was before the calibration.
			...(existing.review.agentSeverity ? { agentSeverity: existing.review.agentSeverity } : {}),
			...(typeof existing.review.agentCvss === "number" ? { agentCvss: existing.review.agentCvss } : {}),
			at: Date.now(),
		};
		this.db
			.prepare(
				"UPDATE vulnerabilities SET severity = ?, cvss = ?, cvss_vector = ?, review = ?, updated_at = ? WHERE id = ?",
			)
			.run(
				verdict.severity,
				verdict.cvss,
				verdict.cvssVector ?? existing.cvssVector ?? null,
				JSON.stringify(review),
				new Date().toISOString(),
				id,
			);
		const changes = [
			t("等级 {from} → {to}", {
				from: t(SENTINEL_VULN_SEVERITY_LABELS[existing.severity]),
				to: t(SENTINEL_VULN_SEVERITY_LABELS[verdict.severity]),
			}),
			`CVSS ${existing.cvss.toFixed(1)} → ${verdict.cvss.toFixed(1)}`,
		];
		this.appendNote(id, {
			author: "system",
			text: t("{mode}：{changes}。{reason}", {
				mode: `${force ? t("人工重新评审") : t("LLM 评审")}${verdict.dubious ? t("（存疑）") : ""}`,
				changes: changes.join(t("，")),
				reason: verdict.reason,
			}),
		});
		return this.get(id);
	}

	/**
	 * The reviewer could not produce a verdict; keep the values in place and
	 * record why. A failed first review leaves the agent's rating untouched, and
	 * a failed re-review keeps the verdict it was re-reviewing.
	 */
	markReviewFailed(id: string, error: string): void {
		const existing = this.get(id);
		if (!existing || existing.review.state !== "queued") return;
		const review: SentinelVulnReview = { ...existing.review, state: "failed", error, at: Date.now() };
		this.db.prepare("UPDATE vulnerabilities SET review = ? WHERE id = ?").run(JSON.stringify(review), id);
	}

	/** Manual retry: a failed (or stuck queued) review goes back to the queue. */
	/**
	 * Manual retry of a failed review, or of one that sat queued when the process
	 * died. `force` widens it to a settled record: the re-review the operator
	 * asks for from the hub, which overwrites the current rating on purpose. The
	 * previous verdict stays in the review object until the new one lands, so a
	 * failed re-review does not erase what it was re-reviewing.
	 */
	requeueReview(id: string, force = false): boolean {
		const existing = this.get(id);
		if (!existing) return false;
		if (existing.review.state === "queued") return false;
		if (!force && existing.review.state !== "failed") return false;
		this.db
			.prepare("UPDATE vulnerabilities SET review = ? WHERE id = ?")
			.run(JSON.stringify({ ...existing.review, state: "queued", at: Date.now() } satisfies SentinelVulnReview), id);
		return true;
	}

	/**
	 * Mark one queued review as not reviewed. Used when automatic review is off:
	 * the record keeps the agent's own rating instead of waiting for a reviewer
	 * that will never run.
	 */
	skipReview(id: string): void {
		const existing = this.get(id);
		if (!existing || existing.review.state !== "queued") return;
		this.db
			.prepare("UPDATE vulnerabilities SET review = ? WHERE id = ?")
			.run(
				JSON.stringify({ ...existing.review, state: "skipped", at: Date.now() } satisfies SentinelVulnReview),
				id,
			);
	}

	/** Drop every queued review, so turning automatic review off clears the backlog. */
	skipQueuedReviews(): number {
		const ids = this.queuedReviewIds();
		for (const id of ids) this.skipReview(id);
		return ids.length;
	}

	/** Records still waiting for the reviewer, oldest first (crash recovery). */
	queuedReviewIds(projectId?: string): string[] {
		const rows = (projectId
			? this.db
					.prepare(
						"SELECT id FROM vulnerabilities WHERE project_id = ? AND review IS NOT NULL AND json_extract(review, '$.state') = 'queued' ORDER BY number ASC",
					)
					.all(projectId)
			: this.db
					.prepare(
						"SELECT id FROM vulnerabilities WHERE review IS NOT NULL AND json_extract(review, '$.state') = 'queued' ORDER BY number ASC",
					)
					.all()) as unknown as Array<{ id: string }>;
		return rows.map((row) => row.id);
	}

	/** The project and the filters as one WHERE clause; undefined when the filters match nothing. */
	private listQuery(
		projectId: string,
		filters: SentinelVulnFilters,
	): { where: string; params: SqliteValue[] } | undefined {
		const conditions = ["project_id = ?"];
		const params: SqliteValue[] = [projectId];
		if (filters.ids !== undefined) {
			const ids = scopedIds(filters.ids);
			if (ids.length === 0) return undefined;
			conditions.push(`id IN (${ids.map(() => "?").join(", ")})`);
			params.push(...ids);
		}
		if (filters.status) {
			conditions.push("status = ?");
			params.push(filters.status);
		}
		if (filters.severity?.length) {
			conditions.push(`severity IN (${filters.severity.map(() => "?").join(", ")})`);
			params.push(...filters.severity);
		}
		if (filters.dubious) {
			conditions.push("json_extract(review, '$.verdict') = 'dubious'");
		}
		if (filters.target?.trim()) {
			conditions.push("target LIKE ? ESCAPE '\\'");
			params.push(likePattern(filters.target.trim()));
		}
		if (filters.sessionId?.trim()) {
			conditions.push("session_id = ?");
			params.push(filters.sessionId.trim());
		}
		if (filters.engineId?.trim()) {
			conditions.push("engine_id = ?");
			params.push(filters.engineId.trim());
		}
		if (filters.taskId?.trim()) {
			conditions.push("task_id = ?");
			params.push(filters.taskId.trim());
		}
		if (filters.assetId?.trim()) {
			conditions.push("asset_id = ?");
			params.push(filters.assetId.trim());
		}
		if (filters.search?.trim()) {
			const pattern = likePattern(filters.search.trim());
			// `source` is included so an operator can search the origin text
			// ("主代理", "子代理 …", "工程任务「…」") the list shows.
			conditions.push(
				"(label LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR COALESCE(category, '') LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')",
			);
			params.push(pattern, pattern, pattern, pattern, pattern);
		}
		return { where: ` WHERE ${conditions.join(" AND ")}`, params };
	}

	/** The ids of every finding that matches the filters, newest first: what selecting a whole filtered result is made of. */
	ids(projectId: string, filters: SentinelVulnFilters = {}): string[] {
		const query = this.listQuery(projectId, filters);
		if (!query) return [];
		const rows = this.db
			.prepare(`SELECT id FROM vulnerabilities${query.where} ORDER BY number DESC`)
			.all(...query.params) as unknown as Array<{ id: string }>;
		return rows.map((row) => row.id);
	}

	/** Every finding of the project that matches the filters, newest first. */
	list(projectId: string, filters: SentinelVulnFilters = {}): SentinelVulnSummary[] {
		const query = this.listQuery(projectId, filters);
		if (!query) return [];
		const rows = this.db
			.prepare(`SELECT * FROM vulnerabilities${query.where} ORDER BY number DESC`)
			.all(...query.params) as unknown as VulnRow[];
		return rows.map(summaryOf);
	}

	/**
	 * One page of the findings that match the filters, newest first. The page
	 * and the count of matches both come out of the database, so a project with
	 * thousands of findings is never read whole to show fifty of them.
	 */
	page(
		projectId: string,
		filters: SentinelVulnFilters = {},
		page = 1,
		pageSize = DEFAULT_VULN_PAGE_SIZE,
	): SentinelVulnPage {
		const requestedPage = Number.isFinite(page) ? Math.floor(page) : 1;
		const requestedSize = Number.isFinite(pageSize) ? Math.floor(pageSize) : DEFAULT_VULN_PAGE_SIZE;
		const size = Math.min(Math.max(1, requestedSize), MAX_VULN_PAGE_SIZE);
		const safePage = Math.max(1, requestedPage);
		const query = this.listQuery(projectId, filters);
		if (!query) return { items: [], total: 0, page: safePage, pageSize: size, hasMore: false };
		const totalRow = this.db
			.prepare(`SELECT COUNT(*) AS n FROM vulnerabilities${query.where}`)
			.get(...query.params) as unknown as {
			n: number;
		};
		const total = Number(totalRow.n);
		const offset = (safePage - 1) * size;
		const rows = this.db
			.prepare(`SELECT * FROM vulnerabilities${query.where} ORDER BY number DESC LIMIT ? OFFSET ?`)
			.all(...query.params, size, offset) as unknown as VulnRow[];
		return {
			items: rows.map(summaryOf),
			total,
			page: safePage,
			pageSize: size,
			hasMore: offset + rows.length < total,
		};
	}

	/** Findings linked to one inventory asset, newest first. */
	listByAsset(projectId: string, assetId: string): SentinelVulnSummary[] {
		const rows = this.db
			.prepare("SELECT * FROM vulnerabilities WHERE project_id = ? AND asset_id = ? ORDER BY number DESC")
			.all(projectId, assetId) as unknown as VulnRow[];
		return rows.map((row) => summaryOf(row));
	}

	/** Every linked finding of one project, grouped by asset id. */
	linkedByAsset(projectId: string): Map<string, SentinelVulnSummary[]> {
		const rows = this.db
			.prepare("SELECT * FROM vulnerabilities WHERE project_id = ? AND asset_id IS NOT NULL ORDER BY number DESC")
			.all(projectId) as unknown as VulnRow[];
		const grouped = new Map<string, SentinelVulnSummary[]>();
		for (const row of rows) {
			if (!row.asset_id) continue;
			const list = grouped.get(row.asset_id) ?? [];
			list.push(summaryOf(row));
			grouped.set(row.asset_id, list);
		}
		return grouped;
	}

	/** How many findings point at these assets, for the delete preview. */
	countLinkedToAssets(projectId: string, assetIds: readonly string[]): number {
		const selected = [...new Set(assetIds.map((id) => id.trim()).filter(Boolean))];
		if (selected.length === 0) return 0;
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS n FROM vulnerabilities
				 WHERE project_id = ? AND asset_id IN (${selected.map(() => "?").join(", ")})`,
			)
			.get(projectId, ...selected) as unknown as { n: number };
		return Number(row.n);
	}

	/** Clear every asset link of one project; used when the project's inventory is purged. */
	unlinkAllAssets(projectId: string): number {
		const result = this.db
			.prepare(
				"UPDATE vulnerabilities SET asset_id = NULL, asset_label = NULL WHERE project_id = ? AND asset_id IS NOT NULL",
			)
			.run(projectId);
		return Number(result.changes ?? 0);
	}

	/** Clear the asset link on findings of these assets; the findings themselves stay. */
	unlinkAssets(projectId: string, assetIds: readonly string[]): number {
		const selected = [...new Set(assetIds.map((id) => id.trim()).filter(Boolean))];
		if (selected.length === 0) return 0;
		const result = this.db
			.prepare(
				`UPDATE vulnerabilities SET asset_id = NULL, asset_label = NULL
				 WHERE project_id = ? AND asset_id IN (${selected.map(() => "?").join(", ")})`,
			)
			.run(projectId, ...selected);
		return Number(result.changes ?? 0);
	}

	stats(projectId: string): SentinelVulnStats {
		const bySeverity = emptyVulnStats().bySeverity;
		const byStatus = emptyVulnStats().byStatus;
		const severityRows = this.db
			.prepare("SELECT severity, COUNT(*) AS count FROM vulnerabilities WHERE project_id = ? GROUP BY severity")
			.all(projectId) as unknown as Array<{ severity: string; count: number }>;
		for (const row of severityRows) {
			if (row.severity in bySeverity) bySeverity[row.severity as SentinelVulnSeverity] = Number(row.count);
		}
		const statusRows = this.db
			.prepare("SELECT status, COUNT(*) AS count FROM vulnerabilities WHERE project_id = ? GROUP BY status")
			.all(projectId) as unknown as Array<{ status: string; count: number }>;
		for (const row of statusRows) {
			if (row.status in byStatus) byStatus[row.status as SentinelVulnStatus] = Number(row.count);
		}
		return {
			total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
			bySeverity,
			byStatus,
		};
	}

	/**
	 * Apply an operator edit. The timeline records what actually changed, so a
	 * record's history explains its current state without a separate audit log.
	 */
	update(id: string, patch: SentinelVulnUpdate): SentinelVulnerability | undefined {
		const existing = this.get(id);
		if (!existing) return undefined;
		const severity = patch.severity ?? existing.severity;
		const cvss = patch.cvss ?? existing.cvss;
		const status = patch.status ?? existing.status;
		const changes: string[] = [];
		if (status !== existing.status) {
			changes.push(
				t("状态 {from} → {to}", {
					from: t(SENTINEL_VULN_STATUS_LABELS[existing.status]),
					to: t(SENTINEL_VULN_STATUS_LABELS[status]),
				}),
			);
		}
		if (severity !== existing.severity) {
			changes.push(
				t("等级 {from} → {to}", {
					from: t(SENTINEL_VULN_SEVERITY_LABELS[existing.severity]),
					to: t(SENTINEL_VULN_SEVERITY_LABELS[severity]),
				}),
			);
		}
		if (cvss !== existing.cvss) {
			changes.push(`CVSS ${existing.cvss} → ${cvss}`);
		}
		const note = patch.note?.trim();
		if (note) changes.push(note);
		if (changes.length === 0) return existing;

		this.db
			.prepare(
				"UPDATE vulnerabilities SET severity = ?, cvss = ?, status = ?, updated_at = ?, review = ? WHERE id = ?",
			)
			.run(
				severity,
				cvss,
				status,
				new Date().toISOString(),
				// The operator acted before the reviewer did: their decision outranks
				// the machine's, so the pending review is skipped for good.
				existing.review.state === "queued"
					? JSON.stringify({ ...existing.review, state: "skipped" })
					: JSON.stringify(existing.review),
				id,
			);
		this.appendNote(id, {
			author: "operator",
			text: changes.join(t("；")),
			...(status !== existing.status ? { statusFrom: existing.status, statusTo: status } : {}),
		});
		return this.get(id);
	}

	private appendNote(
		id: string,
		note: {
			author: SentinelVulnNote["author"];
			text: string;
			statusFrom?: SentinelVulnStatus;
			statusTo?: SentinelVulnStatus;
		},
	): void {
		const row = this.db
			.prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM vulnerability_notes WHERE vuln_id = ?")
			.get(id) as unknown as { last: number } | undefined;
		this.db
			.prepare(
				`INSERT INTO vulnerability_notes (vuln_id, seq, at, author, text, status_from, status_to)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				Number(row?.last ?? 0) + 1,
				new Date().toISOString(),
				note.author,
				note.text,
				note.statusFrom ?? null,
				note.statusTo ?? null,
			);
	}

	/**
	 * What a deletion would take with it. The confirmation dialog shows these so
	 * the operator sees the evidence and notes that disappear with the records.
	 */
	deletePreview(projectId: string, ids: readonly string[]): { count: number; evidence: number; notes: number } {
		const selected = scopedIds(ids);
		if (selected.length === 0) return { count: 0, evidence: 0, notes: 0 };
		const placeholders = selected.map(() => "?").join(", ");
		const count = (table: string): number => {
			const row = this.db
				.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ? AND id IN (${placeholders})`)
				.get(projectId, ...selected) as unknown as { count: number } | undefined;
			return Number(row?.count ?? 0);
		};
		const linked = (table: string): number => {
			const row = this.db
				.prepare(
					`SELECT COUNT(*) AS count FROM ${table} WHERE vuln_id IN (SELECT id FROM vulnerabilities WHERE project_id = ? AND id IN (${placeholders}))`,
				)
				.get(projectId, ...selected) as unknown as { count: number } | undefined;
			return Number(row?.count ?? 0);
		};
		return {
			count: count("vulnerabilities"),
			evidence: linked("vulnerability_evidence"),
			notes: linked("vulnerability_notes"),
		};
	}

	/**
	 * Delete many records of one project with their evidence and notes. Scoped to
	 * the project so a leaked id from another project cannot take records with it.
	 */
	deleteMany(projectId: string, ids: readonly string[]): number {
		const selected = scopedIds(ids);
		if (selected.length === 0) return 0;
		const placeholders = selected.map(() => "?").join(", ");
		this.db.exec("BEGIN");
		try {
			const row = this.db
				.prepare(`SELECT COUNT(*) AS count FROM vulnerabilities WHERE project_id = ? AND id IN (${placeholders})`)
				.get(projectId, ...selected) as unknown as { count: number } | undefined;
			const scope = `vuln_id IN (SELECT id FROM vulnerabilities WHERE project_id = ? AND id IN (${placeholders}))`;
			this.db.prepare(`DELETE FROM vulnerability_evidence WHERE ${scope}`).run(projectId, ...selected);
			this.db.prepare(`DELETE FROM vulnerability_notes WHERE ${scope}`).run(projectId, ...selected);
			this.db
				.prepare(`DELETE FROM vulnerabilities WHERE project_id = ? AND id IN (${placeholders})`)
				.run(projectId, ...selected);
			this.db.exec("COMMIT");
			return Number(row?.count ?? 0);
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/**
	 * Fill engineering provenance for rows submitted before those columns existed.
	 * The runtime supplies the mapping, because only it can see the engines.
	 */
	backfillEngineRefs(bySession: ReadonlyMap<string, { engineId: string; taskId: string }>): number {
		if (bySession.size === 0) return 0;
		const update = this.db.prepare(
			"UPDATE vulnerabilities SET engine_id = ?, task_id = ? WHERE session_id = ? AND engine_id IS NULL",
		);
		let changed = 0;
		for (const [sessionId, ref] of bySession) {
			changed += Number(update.run(ref.engineId, ref.taskId, sessionId).changes ?? 0);
		}
		return changed;
	}

	/** Fill the session-name snapshot for rows submitted before it existed. */
	backfillSessionNames(bySession: ReadonlyMap<string, string>): number {
		if (bySession.size === 0) return 0;
		const update = this.db.prepare(
			"UPDATE vulnerabilities SET session_name = ? WHERE session_id = ? AND session_name IS NULL",
		);
		let changed = 0;
		for (const [sessionId, name] of bySession) {
			changed += Number(update.run(name, sessionId).changes ?? 0);
		}
		return changed;
	}

	delete(id: string): boolean {
		const existing = this.db.prepare("SELECT id FROM vulnerabilities WHERE id = ?").get(id) as unknown as
			| { id: string }
			| undefined;
		if (!existing) return false;
		this.db.prepare("DELETE FROM vulnerability_evidence WHERE vuln_id = ?").run(id);
		this.db.prepare("DELETE FROM vulnerability_notes WHERE vuln_id = ?").run(id);
		this.db.prepare("DELETE FROM vulnerabilities WHERE id = ?").run(id);
		return true;
	}

	countByProject(projectId: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS count FROM vulnerabilities WHERE project_id = ?")
			.get(projectId) as unknown as { count: number } | undefined;
		return Number(row?.count ?? 0);
	}

	/** Deleting a project deletes its findings: they cannot outlive their target scope. */
	deleteByProject(projectId: string): number {
		const ids = this.db
			.prepare("SELECT id FROM vulnerabilities WHERE project_id = ?")
			.all(projectId) as unknown as Array<{
			id: string;
		}>;
		for (const row of ids) {
			this.db.prepare("DELETE FROM vulnerability_evidence WHERE vuln_id = ?").run(row.id);
			this.db.prepare("DELETE FROM vulnerability_notes WHERE vuln_id = ?").run(row.id);
		}
		this.db.prepare("DELETE FROM vulnerabilities WHERE project_id = ?").run(projectId);
		return ids.length;
	}

	close(): void {
		this.db.close();
	}
}

/** The stored review JSON, defensively parsed: a corrupt value reads as skipped. */
function normalizeReview(raw: string | null): SentinelVulnReview {
	if (!raw) return { state: "skipped", at: 0 };
	try {
		const value = JSON.parse(raw) as Partial<SentinelVulnReview>;
		if (value.state !== "queued" && value.state !== "done" && value.state !== "failed" && value.state !== "skipped") {
			return { state: "skipped", at: 0 };
		}
		return {
			state: value.state,
			...(value.severity ? { severity: value.severity } : {}),
			...(typeof value.cvss === "number" ? { cvss: value.cvss } : {}),
			...(typeof value.cvssVector === "string" ? { cvssVector: value.cvssVector } : {}),
			...(value.verdict ? { verdict: value.verdict } : {}),
			...(typeof value.reason === "string" ? { reason: value.reason } : {}),
			...(typeof value.model === "string" ? { model: value.model } : {}),
			...(typeof value.error === "string" ? { error: value.error } : {}),
			...(value.agentSeverity ? { agentSeverity: value.agentSeverity } : {}),
			...(typeof value.agentCvss === "number" ? { agentCvss: value.agentCvss } : {}),
			at: typeof value.at === "number" ? value.at : 0,
		};
	} catch {
		return { state: "skipped", at: 0 };
	}
}

/** Deduplicate and drop empty ids before they reach a statement. */
function scopedIds(ids: readonly string[]): string[] {
	return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

/** A row without its heavy fields; the list and the asset view share this shape. */
function summaryOf(row: VulnRow): SentinelVulnSummary {
	const { packet: _packet, evidence: _evidence, notes: _notes, ...summary } = toVulnerability(row, [], []);
	return summary;
}

function toVulnerability(row: VulnRow, evidence: EvidenceRow[], notes: NoteRow[]): SentinelVulnerability {
	const severity = row.severity as SentinelVulnSeverity;
	const cvss = Number(row.cvss);
	return {
		id: row.id,
		review: normalizeReview(row.review),
		label: row.label,
		number: Number(row.number),
		projectId: row.project_id,
		projectName: row.project_name,
		...(optional(row.session_id) ? { sessionId: row.session_id as string } : {}),
		...(optional(row.engine_id) ? { engineId: row.engine_id as string } : {}),
		...(optional(row.task_id) ? { taskId: row.task_id as string } : {}),
		...(optional(row.session_name) ? { sessionName: row.session_name as string } : {}),
		...(optional(row.asset_id) ? { assetId: row.asset_id as string } : {}),
		...(optional(row.asset_label) ? { assetLabel: row.asset_label as string } : {}),
		source: row.source,
		title: row.title,
		severity,
		cvss,
		...(optional(row.cvss_vector) ? { cvssVector: row.cvss_vector as string } : {}),
		status: row.status as SentinelVulnStatus,
		target: row.target,
		...(optional(row.category) ? { category: row.category as string } : {}),
		platform: (row.platform as "web" | "android") ?? "web",
		...(optional(row.app_package) ? { appPackage: row.app_package as string } : {}),
		...(optional(row.app_version) ? { appVersion: row.app_version as string } : {}),
		description: row.description,
		packet: row.packet,
		...(optional(row.repro) ? { repro: row.repro as string } : {}),
		...(optional(row.remediation) ? { remediation: row.remediation as string } : {}),
		...(parseReferences(row.refs) ? { references: parseReferences(row.refs) as string[] } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		evidence: evidence.map((item) => ({
			kind: item.kind === "file" ? "file" : "command",
			...(optional(item.command) ? { command: item.command as string } : {}),
			...(optional(item.output) ? { output: item.output as string } : {}),
			...(optional(item.path) ? { path: item.path as string } : {}),
			...(optional(item.note) ? { note: item.note as string } : {}),
		})),
		notes: notes.map((item) => ({
			at: item.at,
			author: item.author as SentinelVulnNote["author"],
			text: item.text,
			...(optional(item.status_from) ? { statusFrom: item.status_from as SentinelVulnStatus } : {}),
			...(optional(item.status_to) ? { statusTo: item.status_to as SentinelVulnStatus } : {}),
		})),
		severityMismatch: isSeverityMismatch(severity, cvss),
	};
}
