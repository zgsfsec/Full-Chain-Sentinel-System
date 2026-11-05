/**
 * Persistent state of the open-source watch.
 *
 * Two tables: one row per monitored repository, one row per consumed commit.
 * The commit table is the feature's memory — a verdict is written once, and a
 * branch baseline is only advanced past commits that have a row, so a restart or
 * a failed check resumes instead of rescanning or silently skipping history.
 *
 * Access tokens live in their own 0600 JSON file, not in this database: the
 * database is opened by more code (and exported by nothing), while the token file
 * has one reader and one writer.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CODE_VULN_TAGS, type CodeVulnTag, normalizeCodeVulnTags } from "./code-vuln-tags.ts";
import type {
	SentinelCodeActivityCounts,
	SentinelCodeActivityFilter,
	SentinelCodeCheckJob,
	SentinelCodeCheckLog,
	SentinelCodeCheckStatus,
	SentinelCodeCheckTrigger,
	SentinelCodeCommit,
	SentinelCodeCommitStatus,
	SentinelCodeJobStatus,
	SentinelCodeMonitor,
	SentinelCodeReproductionStage,
	SentinelCodeVerdict,
	SentinelVulnCategory,
	SentinelVulnSeverity,
} from "./protocol.ts";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

const REVIEW_SQL =
	"verdict = 'security' AND engine_id IS NULL AND status = 'new' AND duplicate_of IS NULL AND error IS NULL";
const PENDING_SQL = "verdict = 'pending' AND status != 'ignored'";
const FAILED_SQL = "verdict = 'failed' AND status != 'ignored'";
const DISPATCH_FAILED_SQL = "verdict = 'security' AND error IS NOT NULL AND status != 'ignored'";
const DISPATCHING_SQL = "reproduction_stage IN ('git', 'engineering', 'paused')";
const FINISHED_SQL = "reproduction_stage IN ('completed', 'stopped')";
const ATTENTION_SQL = `(${PENDING_SQL}) OR (${FAILED_SQL}) OR (${DISPATCH_FAILED_SQL}) OR (${DISPATCHING_SQL}) OR (${REVIEW_SQL})`;

function activityWhere(filter: SentinelCodeActivityFilter): string {
	switch (filter) {
		case "review":
			return `project_id = ? AND (${REVIEW_SQL})`;
		case "failed":
			return `project_id = ? AND (${FAILED_SQL})`;
		case "dispatch_failed":
			return `project_id = ? AND (${DISPATCH_FAILED_SQL})`;
		case "pending":
			return `project_id = ? AND (${PENDING_SQL})`;
		case "reproducing":
			return `project_id = ? AND (${DISPATCHING_SQL})`;
		case "finished":
			return `project_id = ? AND (${FINISHED_SQL})`;
		case "all":
			return "project_id = ?";
		default:
			return `project_id = ? AND (${ATTENTION_SQL})`;
	}
}

/** Commits kept per monitor; the oldest are dropped first. */
const MAX_COMMITS_PER_MONITOR = 2000;
/** Check log rows kept per monitor. */
const MAX_CHECKS_PER_MONITOR = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS code_monitors (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  api_base_url TEXT NOT NULL,
  branches TEXT NOT NULL DEFAULT '[]',
  baselines TEXT NOT NULL DEFAULT '{}',
  auto_dispatch INTEGER NOT NULL DEFAULT 0,
  auto_dispatch_categories TEXT,
  auto_dispatch_tags TEXT,
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  schedule_kind TEXT NOT NULL DEFAULT 'interval',
  cron_expression TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_check_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS code_commits (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  sha TEXT NOT NULL,
  short_sha TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  author TEXT NOT NULL,
  authored_at INTEGER NOT NULL,
  url TEXT NOT NULL,
  verdict TEXT NOT NULL DEFAULT 'pending',
  confidence REAL,
  cve TEXT,
  severity TEXT,
  vuln_type TEXT,
  vuln_category TEXT,
  vuln_tags TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  reproduction_stage TEXT,
  engine_id TEXT,
  duplicate_of TEXT,
  error TEXT,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  diff TEXT,
  patch_key TEXT,
  created_at INTEGER NOT NULL,
  judged_at INTEGER,
  UNIQUE(monitor_id, sha)
);
CREATE INDEX IF NOT EXISTS idx_code_commits_monitor ON code_commits(monitor_id, authored_at DESC);
CREATE INDEX IF NOT EXISTS idx_code_commits_project ON code_commits(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS code_monitor_checks (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  commits INTEGER NOT NULL DEFAULT 0,
  findings INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_code_checks_monitor ON code_monitor_checks(monitor_id, started_at DESC);
CREATE TABLE IF NOT EXISTS code_monitor_jobs (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  host TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  error TEXT,
  check_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_code_jobs_due ON code_monitor_jobs(status, next_run_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_code_jobs_active ON code_monitor_jobs(monitor_id)
  WHERE status IN ('queued', 'running');
`;

/** A monitor as stored, before the secret flag and the counts are joined in. */
export type StoredCodeMonitor = Omit<
	SentinelCodeMonitor,
	"tokenSet" | "findingCount" | "pendingCount" | "nextCheckAt" | "checkState"
>;

export interface NewCodeCommit {
	monitorId: string;
	projectId: string;
	branch: string;
	sha: string;
	shortSha: string;
	title: string;
	message: string;
	author: string;
	authoredAt: number;
	url: string;
	additions: number;
	deletions: number;
	files: number;
	diff: string | null;
}

export interface CodeCommitVerdict {
	verdict: SentinelCodeVerdict;
	confidence: number | null;
	cve: string | null;
	severity: SentinelVulnSeverity | null;
	vulnType: string | null;
	vulnCategory: SentinelVulnCategory | null;
	vulnTags: CodeVulnTag[];
	reason: string | null;
	judgedAt: number | null;
}

interface MonitorRow {
	id: string;
	project_id: string;
	project_name: string;
	name: string;
	host: string;
	owner: string;
	repo: string;
	repo_url: string;
	api_base_url: string;
	branches: string;
	baselines: string;
	auto_dispatch: number;
	auto_dispatch_categories: string | null;
	auto_dispatch_tags: string | null;
	interval_minutes: number;
	schedule_kind: string;
	cron_expression: string | null;
	enabled: number;
	last_check_at: number | null;
	last_error: string | null;
	created_at: number;
	finding_count?: number;
	pending_count?: number;
}

interface CommitRow {
	id: string;
	monitor_id: string;
	project_id: string;
	branch: string;
	sha: string;
	short_sha: string;
	title: string;
	message: string;
	author: string;
	authored_at: number;
	url: string;
	verdict: string;
	confidence: number | null;
	cve: string | null;
	severity: string | null;
	vuln_type: string | null;
	vuln_category: string | null;
	vuln_tags: string;
	reason: string | null;
	status: string;
	reproduction_stage: SentinelCodeReproductionStage | null;
	engine_id: string | null;
	duplicate_of: string | null;
	error: string | null;
	additions: number;
	deletions: number;
	files: number;
	diff: string | null;
	created_at: number;
	judged_at: number | null;
}

interface CheckRow {
	id: string;
	monitor_id: string;
	project_id: string;
	trigger: string;
	status: string;
	started_at: number;
	ended_at: number | null;
	commits: number;
	findings: number;
	error: string | null;
}

interface JobRow {
	id: string;
	monitor_id: string;
	project_id: string;
	host: string;
	trigger: string;
	status: string;
	attempts: number;
	max_attempts: number;
	next_run_at: number;
	created_at: number;
	started_at: number | null;
	ended_at: number | null;
	error: string | null;
	check_id: string | null;
}

function toJob(row: JobRow): SentinelCodeCheckJob {
	return {
		id: row.id,
		monitorId: row.monitor_id,
		projectId: row.project_id,
		host: row.host,
		trigger: row.trigger as SentinelCodeCheckTrigger,
		status: row.status as SentinelCodeJobStatus,
		attempts: row.attempts,
		maxAttempts: row.max_attempts,
		nextRunAt: row.next_run_at,
		createdAt: row.created_at,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		error: row.error,
		checkId: row.check_id,
	};
}

function toCheck(row: CheckRow): SentinelCodeCheckLog {
	return {
		id: row.id,
		monitorId: row.monitor_id,
		trigger: row.trigger as SentinelCodeCheckTrigger,
		status: row.status as SentinelCodeCheckStatus,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		commits: row.commits,
		findings: row.findings,
		error: row.error,
	};
}

function parseStringArray(raw: string): string[] {
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

function parseBaselines(raw: string): Record<string, string> {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
		const entries: Record<string, string> = {};
		for (const [branch, sha] of Object.entries(value)) {
			if (typeof sha === "string") entries[branch] = sha;
		}
		return entries;
	} catch {
		return {};
	}
}

const VULN_CATEGORIES: readonly SentinelVulnCategory[] = ["web", "memory", "other"];

/** JSON column → category allowlist; null/empty/invalid means "all categories". */
function parseCategories(raw: string | null): SentinelVulnCategory[] | null {
	if (!raw) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value)) return null;
		const list = value.filter(
			(entry): entry is SentinelVulnCategory =>
				typeof entry === "string" && VULN_CATEGORIES.includes(entry as SentinelVulnCategory),
		);
		return list.length > 0 ? [...new Set(list)] : null;
	} catch {
		return null;
	}
}

function toMonitor(row: MonitorRow): StoredCodeMonitor {
	return {
		id: row.id,
		projectId: row.project_id,
		projectName: row.project_name,
		name: row.name,
		host: row.host,
		owner: row.owner,
		repo: row.repo,
		repoUrl: row.repo_url,
		apiBaseUrl: row.api_base_url,
		branches: parseStringArray(row.branches),
		baselines: parseBaselines(row.baselines),
		autoDispatch: row.auto_dispatch === 1,
		autoDispatchCategories: parseCategories(row.auto_dispatch_categories),
		autoDispatchTags:
			row.auto_dispatch_tags === null
				? null
				: parseStringArray(row.auto_dispatch_tags).filter((value): value is CodeVulnTag =>
						CODE_VULN_TAGS.some((tag) => tag.id === value),
					),
		intervalMinutes: row.interval_minutes,
		scheduleKind: row.schedule_kind === "cron" ? "cron" : "interval",
		cronExpression: row.cron_expression,
		enabled: row.enabled === 1,
		lastCheckAt: row.last_check_at,
		lastError: row.last_error,
		createdAt: row.created_at,
	};
}

function toCommit(row: CommitRow): SentinelCodeCommit {
	return {
		id: row.id,
		monitorId: row.monitor_id,
		projectId: row.project_id,
		branch: row.branch,
		sha: row.sha,
		shortSha: row.short_sha,
		title: row.title,
		message: row.message,
		author: row.author,
		authoredAt: row.authored_at,
		url: row.url,
		verdict: row.verdict as SentinelCodeVerdict,
		confidence: row.confidence,
		cve: row.cve,
		severity: row.severity as SentinelVulnSeverity | null,
		vulnType: row.vuln_type,
		vulnTags:
			row.verdict === "security" ? normalizeCodeVulnTags(parseStringArray(row.vuln_tags), row.vuln_category) : [],
		vulnCategory: (VULN_CATEGORIES.includes(row.vuln_category as SentinelVulnCategory)
			? row.vuln_category
			: null) as SentinelVulnCategory | null,
		reason: row.reason,
		status: row.status as SentinelCodeCommitStatus,
		reproductionStage: row.reproduction_stage,
		engineId: row.engine_id,
		duplicateOf: row.duplicate_of,
		error: row.error,
		additions: row.additions,
		deletions: row.deletions,
		files: row.files,
		diff: row.diff,
		createdAt: row.created_at,
		judgedAt: row.judged_at,
	};
}

export class CodeMonitorStore {
	private readonly db: SqliteDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		this.addScheduleColumns();
		this.addVulnerabilityTagsColumn();
		const columns = this.db.prepare("PRAGMA table_info(code_commits)").all() as Array<{ name: string }>;
		if (!columns.some((column) => column.name === "reproduction_stage")) {
			this.db.exec("ALTER TABLE code_commits ADD COLUMN reproduction_stage TEXT");
			this.db.exec("UPDATE code_commits SET reproduction_stage = 'engineering' WHERE engine_id IS NOT NULL");
		}
		// A crash mid-dispatch leaves "dispatching" behind with no run behind it;
		// the engine is only created at the end, so back to "new" is the truth.
		this.db
			.prepare(`UPDATE code_commits SET status = 'new', reproduction_stage = 'failed',
			error = '服务重启，源码准备中断，请重新复现' WHERE status = 'dispatching'`)
			.run();
	}

	/** Databases created before cron scheduling have no strategy columns. */
	private addScheduleColumns(): void {
		const columns = this.db.prepare("PRAGMA table_info(code_monitors)").all() as unknown as Array<{ name: string }>;
		const names = columns.map((column) => column.name);
		if (!names.includes("schedule_kind")) {
			this.db.exec("ALTER TABLE code_monitors ADD COLUMN schedule_kind TEXT NOT NULL DEFAULT 'interval'");
		}
		if (!names.includes("cron_expression")) {
			this.db.exec("ALTER TABLE code_monitors ADD COLUMN cron_expression TEXT");
		}
		if (!names.includes("auto_dispatch_categories")) {
			this.db.exec("ALTER TABLE code_monitors ADD COLUMN auto_dispatch_categories TEXT");
		}
		if (!names.includes("auto_dispatch_tags")) {
			this.db.exec("ALTER TABLE code_monitors ADD COLUMN auto_dispatch_tags TEXT");
		}
		const commitColumns = this.db.prepare("PRAGMA table_info(code_commits)").all() as unknown as Array<{
			name: string;
		}>;
		if (!commitColumns.some((column) => column.name === "vuln_category")) {
			this.db.exec("ALTER TABLE code_commits ADD COLUMN vuln_category TEXT");
		}
	}

	/** Preserve existing findings and copy only explicit, recognized type names. */
	private addVulnerabilityTagsColumn(): void {
		const columns = this.db.prepare("PRAGMA table_info(code_commits)").all() as Array<{ name: string }>;
		if (columns.some((column) => column.name === "vuln_tags")) return;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.exec("ALTER TABLE code_commits ADD COLUMN vuln_tags TEXT NOT NULL DEFAULT '[]'");
			const rows = this.db
				.prepare("SELECT id, vuln_type, vuln_category FROM code_commits WHERE verdict = 'security'")
				.all() as Array<{ id: string; vuln_type: string | null; vuln_category: string | null }>;
			const update = this.db.prepare("UPDATE code_commits SET vuln_tags = ? WHERE id = ?");
			for (const row of rows) {
				const tags = normalizeCodeVulnTags([row.vuln_type], row.vuln_category);
				if (tags.length > 0) update.run(JSON.stringify(tags), row.id);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.db.close();
	}

	listMonitors(): Array<StoredCodeMonitor & { findingCount: number; pendingCount: number }> {
		const rows = this.db
			.prepare(
				`SELECT m.*,
					(SELECT COUNT(*) FROM code_commits c
						WHERE c.monitor_id = m.id AND c.verdict = 'security' AND c.status != 'ignored'
						AND c.duplicate_of IS NULL) AS finding_count,
					(SELECT COUNT(*) FROM code_commits c
						WHERE c.monitor_id = m.id AND c.verdict = 'security' AND c.status = 'new'
						AND c.duplicate_of IS NULL) AS pending_count
				 FROM code_monitors m ORDER BY m.created_at DESC`,
			)
			.all() as unknown as MonitorRow[];
		return rows.map((row) => ({
			...toMonitor(row),
			findingCount: Number(row.finding_count ?? 0),
			pendingCount: Number(row.pending_count ?? 0),
		}));
	}

	counts(monitorId: string): { findingCount: number; pendingCount: number } {
		const row = this.db
			.prepare(
				`SELECT
					(SELECT COUNT(*) FROM code_commits WHERE monitor_id = ? AND verdict = 'security' AND status != 'ignored'
						AND duplicate_of IS NULL) AS finding_count,
					(SELECT COUNT(*) FROM code_commits WHERE monitor_id = ? AND verdict = 'security' AND status = 'new'
						AND duplicate_of IS NULL) AS pending_count`,
			)
			.get(monitorId, monitorId) as unknown as { finding_count: number; pending_count: number } | undefined;
		return {
			findingCount: Number(row?.finding_count ?? 0),
			pendingCount: Number(row?.pending_count ?? 0),
		};
	}

	getMonitor(id: string): StoredCodeMonitor | null {
		const row = this.db.prepare("SELECT * FROM code_monitors WHERE id = ?").get(id) as unknown as
			| MonitorRow
			| undefined;
		return row ? toMonitor(row) : null;
	}

	createMonitor(monitor: {
		projectId: string;
		projectName: string;
		name: string;
		host: string;
		owner: string;
		repo: string;
		repoUrl: string;
		apiBaseUrl: string;
		branches: string[];
		baselines: Record<string, string>;
		autoDispatch: boolean;
		autoDispatchCategories?: SentinelVulnCategory[] | null;
		autoDispatchTags?: CodeVulnTag[] | null;
		intervalMinutes: number;
		scheduleKind: "interval" | "cron";
		cronExpression: string | null;
		enabled: boolean;
	}): StoredCodeMonitor {
		const id = randomUUID();
		const createdAt = Date.now();
		this.db
			.prepare(
				`INSERT INTO code_monitors
					(id, project_id, project_name, name, host, owner, repo, repo_url, api_base_url,
					 branches, baselines, auto_dispatch, auto_dispatch_categories, auto_dispatch_tags, interval_minutes,
					 schedule_kind, cron_expression, enabled, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				monitor.projectId,
				monitor.projectName,
				monitor.name,
				monitor.host,
				monitor.owner,
				monitor.repo,
				monitor.repoUrl,
				monitor.apiBaseUrl,
				JSON.stringify(monitor.branches),
				JSON.stringify(monitor.baselines),
				monitor.autoDispatch ? 1 : 0,
				monitor.autoDispatchCategories ? JSON.stringify(monitor.autoDispatchCategories) : null,
				monitor.autoDispatchTags ? JSON.stringify(monitor.autoDispatchTags) : null,
				monitor.intervalMinutes,
				monitor.scheduleKind,
				monitor.cronExpression,
				monitor.enabled ? 1 : 0,
				createdAt,
			);
		const created = this.getMonitor(id);
		if (!created) throw new Error("监控记录写入失败");
		return created;
	}

	updateMonitor(
		id: string,
		patch: {
			projectId?: string;
			projectName?: string;
			name?: string;
			host?: string;
			owner?: string;
			repo?: string;
			repoUrl?: string;
			apiBaseUrl?: string;
			branches?: string[];
			baselines?: Record<string, string>;
			autoDispatch?: boolean;
			autoDispatchCategories?: SentinelVulnCategory[] | null;
			autoDispatchTags?: CodeVulnTag[] | null;
			intervalMinutes?: number;
			scheduleKind?: "interval" | "cron";
			cronExpression?: string | null;
			enabled?: boolean;
		},
	): StoredCodeMonitor {
		const current = this.getMonitor(id);
		if (!current) throw new Error("监控不存在");
		const next = { ...current, ...patch };
		this.db
			.prepare(
				`UPDATE code_monitors SET
					name = ?, host = ?, owner = ?, repo = ?, repo_url = ?, api_base_url = ?,
					branches = ?, baselines = ?, auto_dispatch = ?, auto_dispatch_categories = ?, auto_dispatch_tags = ?,
					interval_minutes = ?, schedule_kind = ?, cron_expression = ?, enabled = ?
				 WHERE id = ?`,
			)
			.run(
				next.name,
				next.host,
				next.owner,
				next.repo,
				next.repoUrl,
				next.apiBaseUrl,
				JSON.stringify(next.branches),
				JSON.stringify(next.baselines),
				next.autoDispatch ? 1 : 0,
				next.autoDispatchCategories ? JSON.stringify(next.autoDispatchCategories) : null,
				next.autoDispatchTags ? JSON.stringify(next.autoDispatchTags) : null,
				next.intervalMinutes,
				next.scheduleKind,
				next.cronExpression,
				next.enabled ? 1 : 0,
				id,
			);
		const updated = this.getMonitor(id);
		if (!updated) throw new Error("监控更新失败");
		return updated;
	}

	deleteMonitor(id: string): void {
		this.db.prepare("DELETE FROM code_commits WHERE monitor_id = ?").run(id);
		this.db.prepare("DELETE FROM code_monitor_checks WHERE monitor_id = ?").run(id);
		this.db.prepare("DELETE FROM code_monitor_jobs WHERE monitor_id = ?").run(id);
		this.db.prepare("DELETE FROM code_monitors WHERE id = ?").run(id);
	}

	/** Project removal takes its monitors and their history with it. */
	deleteByProject(projectId: string): string[] {
		const rows = this.db
			.prepare("SELECT id FROM code_monitors WHERE project_id = ?")
			.all(projectId) as unknown as Array<{ id: string }>;
		for (const row of rows) this.deleteMonitor(row.id);
		return rows.map((row) => row.id);
	}

	markChecked(id: string, at: number, error: string | null): void {
		this.db.prepare("UPDATE code_monitors SET last_check_at = ?, last_error = ? WHERE id = ?").run(at, error, id);
	}

	setBaselines(id: string, baselines: Record<string, string>): void {
		this.db.prepare("UPDATE code_monitors SET baselines = ? WHERE id = ?").run(JSON.stringify(baselines), id);
	}

	/** Insert one commit; an existing (monitor, sha) row is returned unchanged. */
	insertCommit(commit: NewCodeCommit): SentinelCodeCommit {
		const existing = this.findCommit(commit.monitorId, commit.sha);
		if (existing) return existing;
		const id = randomUUID();
		this.db
			.prepare(
				`INSERT OR IGNORE INTO code_commits
					(id, monitor_id, project_id, branch, sha, short_sha, title, message, author, authored_at,
					 url, additions, deletions, files, diff, patch_key, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				commit.monitorId,
				commit.projectId,
				commit.branch,
				commit.sha,
				commit.shortSha,
				commit.title,
				commit.message,
				commit.author,
				commit.authoredAt,
				commit.url,
				commit.additions,
				commit.deletions,
				commit.files,
				commit.diff,
				patchKey(commit.diff),
				Date.now(),
			);
		const inserted = this.findCommit(commit.monitorId, commit.sha);
		if (!inserted) throw new Error("提交记录写入失败");
		this.trimCommits(commit.monitorId);
		return inserted;
	}

	private trimCommits(monitorId: string): void {
		this.db
			.prepare(
				`DELETE FROM code_commits WHERE monitor_id = ? AND id NOT IN (
					SELECT id FROM code_commits WHERE monitor_id = ? ORDER BY authored_at DESC LIMIT ?
				)`,
			)
			.run(monitorId, monitorId, MAX_COMMITS_PER_MONITOR);
	}

	findCommit(monitorId: string, sha: string): SentinelCodeCommit | null {
		const row = this.db
			.prepare("SELECT * FROM code_commits WHERE monitor_id = ? AND sha = ?")
			.get(monitorId, sha) as unknown as CommitRow | undefined;
		return row ? toCommit(row) : null;
	}

	getCommit(id: string): SentinelCodeCommit | null {
		const row = this.db.prepare("SELECT * FROM code_commits WHERE id = ?").get(id) as unknown as
			| CommitRow
			| undefined;
		return row ? toCommit(row) : null;
	}

	listCommits(monitorId: string, limit = 100): SentinelCodeCommit[] {
		const rows = this.db
			.prepare("SELECT * FROM code_commits WHERE monitor_id = ? ORDER BY authored_at DESC, id LIMIT ?")
			.all(monitorId, limit) as unknown as CommitRow[];
		return rows.map(toCommit);
	}

	/**
	 * Cross-monitor activity for one project. The default slice is the work that
	 * needs an operator: pending/security review, failed judgments and failed
	 * dispatch. Dispatched successes stay out of it.
	 */
	listActivity(
		projectId: string,
		filter: SentinelCodeActivityFilter,
		page: number,
		pageSize: number,
		category: SentinelVulnCategory | null = null,
		tag: CodeVulnTag | null = null,
	): { items: SentinelCodeCommit[]; total: number } {
		let where = activityWhere(filter);
		const params: string[] = [projectId];
		if (category) {
			where += " AND vuln_category = ?";
			params.push(category);
		}
		if (tag) {
			where += " AND verdict = 'security' AND EXISTS (SELECT 1 FROM json_each(vuln_tags) WHERE value = ?)";
			params.push(tag);
		}
		const safePage = Math.max(1, Math.floor(page));
		const safeSize = Math.min(200, Math.max(1, Math.floor(pageSize)));
		const totalRow = this.db
			.prepare(`SELECT COUNT(*) AS total FROM code_commits WHERE ${where}`)
			.get(...params) as unknown as { total: number } | undefined;
		const rows = this.db
			.prepare(
				`SELECT * FROM code_commits WHERE ${where}
				 ORDER BY authored_at DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
			)
			.all(...params, safeSize, (safePage - 1) * safeSize) as unknown as CommitRow[];
		return { items: rows.map(toCommit), total: Number(totalRow?.total ?? 0) };
	}

	activityCounts(projectId: string): Omit<SentinelCodeActivityCounts, "anomalies"> {
		const row = this.db
			.prepare(
				`SELECT
					SUM(CASE WHEN ${PENDING_SQL} THEN 1 ELSE 0 END) AS pending,
					SUM(CASE WHEN ${FAILED_SQL} THEN 1 ELSE 0 END) AS failed,
					SUM(CASE WHEN ${DISPATCH_FAILED_SQL} THEN 1 ELSE 0 END) AS dispatch_failed,
					SUM(CASE WHEN ${DISPATCHING_SQL} THEN 1 ELSE 0 END) AS reproducing,
					SUM(CASE WHEN ${FINISHED_SQL} THEN 1 ELSE 0 END) AS finished,
					SUM(CASE WHEN ${REVIEW_SQL} THEN 1 ELSE 0 END) AS review,
					SUM(CASE WHEN ${ATTENTION_SQL} THEN 1 ELSE 0 END) AS attention,
					COUNT(*) AS total
				 FROM code_commits WHERE project_id = ?`,
			)
			.get(projectId) as unknown as
			| {
					pending: number;
					failed: number;
					dispatch_failed: number;
					reproducing: number;
					finished: number;
					review: number;
					attention: number;
					total: number;
			  }
			| undefined;
		return {
			pending: Number(row?.pending ?? 0),
			failed: Number(row?.failed ?? 0),
			dispatchFailed: Number(row?.dispatch_failed ?? 0),
			review: Number(row?.review ?? 0),
			attention: Number(row?.attention ?? 0),
			reproducing: Number(row?.reproducing ?? 0),
			finished: Number(row?.finished ?? 0),
		};
	}

	/** Create a queued job, or return the active one already covering this monitor. */
	enqueueJob(input: {
		monitorId: string;
		projectId: string;
		host: string;
		trigger: SentinelCodeCheckTrigger;
		now: number;
		maxAttempts: number;
	}): SentinelCodeCheckJob {
		const id = randomUUID();
		this.db
			.prepare(
				`INSERT OR IGNORE INTO code_monitor_jobs
					(id, monitor_id, project_id, host, trigger, status, attempts, max_attempts, next_run_at, created_at)
				 VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
			)
			.run(id, input.monitorId, input.projectId, input.host, input.trigger, input.maxAttempts, input.now, input.now);
		const row = this.db
			.prepare(
				`SELECT * FROM code_monitor_jobs WHERE monitor_id = ?
				 AND status IN ('queued', 'running') LIMIT 1`,
			)
			.get(input.monitorId) as unknown as JobRow | undefined;
		if (!row) throw new Error("检查任务写入失败");
		return toJob(row);
	}

	/** The active job for a monitor, if any. */
	activeJob(monitorId: string): SentinelCodeCheckJob | null {
		const row = this.db
			.prepare(
				`SELECT * FROM code_monitor_jobs WHERE monitor_id = ?
				 AND status IN ('queued', 'running') LIMIT 1`,
			)
			.get(monitorId) as unknown as JobRow | undefined;
		return row ? toJob(row) : null;
	}

	activeJobs(): SentinelCodeCheckJob[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM code_monitor_jobs WHERE status IN ('queued', 'running')
				 ORDER BY next_run_at, created_at`,
			)
			.all() as unknown as JobRow[];
		return rows.map(toJob);
	}

	listJobs(monitorId: string, limit = 50): SentinelCodeCheckJob[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM code_monitor_jobs WHERE monitor_id = ?
				 ORDER BY created_at DESC, id DESC LIMIT ?`,
			)
			.all(monitorId, limit) as unknown as JobRow[];
		return rows.map(toJob);
	}

	/** All monitors' queue rows in one project, newest first, for the log tab. */
	listJobsByProject(projectId: string, limit = 200): SentinelCodeCheckJob[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM code_monitor_jobs WHERE project_id = ?
				 ORDER BY created_at DESC, id DESC LIMIT ?`,
			)
			.all(projectId, limit) as unknown as JobRow[];
		return rows.map(toJob);
	}

	dueJobs(now: number, limit = 50): SentinelCodeCheckJob[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM code_monitor_jobs WHERE status = 'queued' AND next_run_at <= ?
				 ORDER BY next_run_at, created_at LIMIT ?`,
			)
			.all(now, limit) as unknown as JobRow[];
		return rows.map(toJob);
	}

	/** Move a job into running and count the attempt. Returns the updated row. */
	markJobRunning(id: string, now: number): SentinelCodeCheckJob | null {
		this.db
			.prepare(
				`UPDATE code_monitor_jobs SET status = 'running', attempts = attempts + 1,
				 started_at = ?, ended_at = NULL, error = NULL, check_id = NULL WHERE id = ?`,
			)
			.run(now, id);
		const row = this.db.prepare("SELECT * FROM code_monitor_jobs WHERE id = ?").get(id) as unknown as
			| JobRow
			| undefined;
		return row ? toJob(row) : null;
	}

	requeueJob(id: string, nextRunAt: number, error: string): void {
		this.db
			.prepare(
				`UPDATE code_monitor_jobs SET status = 'queued', started_at = NULL, ended_at = NULL,
				 next_run_at = ?, error = ? WHERE id = ?`,
			)
			.run(nextRunAt, error, id);
	}

	finishJob(
		id: string,
		status: "done" | "failed",
		endedAt: number,
		error: string | null,
		checkId: string | null,
	): void {
		this.db
			.prepare(`UPDATE code_monitor_jobs SET status = ?, ended_at = ?, error = ?, check_id = ? WHERE id = ?`)
			.run(status, endedAt, error, checkId, id);
	}

	/** After a restart, runnable jobs go back to the queue; exhausted ones fail. */
	requeueRunningJobs(now: number, reason: string): number {
		const requeued = this.db
			.prepare(
				`UPDATE code_monitor_jobs SET status = 'queued', started_at = NULL,
				 next_run_at = ?, error = ? WHERE status = 'running' AND attempts < max_attempts`,
			)
			.run(now, reason);
		const failed = this.db
			.prepare(
				`UPDATE code_monitor_jobs SET status = 'failed', ended_at = ?, error = ?
				 WHERE status = 'running'`,
			)
			.run(now, reason);
		return Number(requeued.changes ?? 0) + Number(failed.changes ?? 0);
	}

	/** Open a log row before the pass starts, so a crash leaves evidence. */
	startCheck(monitorId: string, projectId: string, trigger: SentinelCodeCheckTrigger, startedAt: number): string {
		const id = randomUUID();
		this.db
			.prepare(
				`INSERT INTO code_monitor_checks
					(id, monitor_id, project_id, trigger, status, started_at)
				 VALUES (?, ?, ?, ?, 'running', ?)`,
			)
			.run(id, monitorId, projectId, trigger, startedAt);
		return id;
	}

	finishCheck(
		id: string,
		outcome: {
			status: SentinelCodeCheckStatus;
			commits: number;
			findings: number;
			error: string | null;
			endedAt: number;
		},
	): void {
		this.db
			.prepare(
				`UPDATE code_monitor_checks SET status = ?, commits = ?, findings = ?, error = ?, ended_at = ?
				 WHERE id = ?`,
			)
			.run(outcome.status, outcome.commits, outcome.findings, outcome.error, outcome.endedAt, id);
		const row = this.db.prepare("SELECT monitor_id FROM code_monitor_checks WHERE id = ?").get(id) as unknown as
			| { monitor_id: string }
			| undefined;
		if (row) this.trimChecks(row.monitor_id);
	}

	/** A restart closes rows that were still running, instead of leaving them orange forever. */
	failRunningChecks(at: number, reason: string): number {
		const result = this.db
			.prepare(
				`UPDATE code_monitor_checks SET status = 'error', error = ?, ended_at = ?
				 WHERE status = 'running'`,
			)
			.run(reason, at);
		return Number(result.changes ?? 0);
	}

	listChecks(monitorId: string, limit = 50): SentinelCodeCheckLog[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM code_monitor_checks WHERE monitor_id = ?
				 ORDER BY started_at DESC, id DESC LIMIT ?`,
			)
			.all(monitorId, limit) as unknown as CheckRow[];
		return rows.map(toCheck);
	}

	/** All monitors' check rows in one project, newest first, for the log tab. */
	listChecksByProject(projectId: string, limit = 200): SentinelCodeCheckLog[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM code_monitor_checks WHERE project_id = ?
				 ORDER BY started_at DESC, id DESC LIMIT ?`,
			)
			.all(projectId, limit) as unknown as CheckRow[];
		return rows.map(toCheck);
	}

	private trimChecks(monitorId: string): void {
		this.db
			.prepare(
				`DELETE FROM code_monitor_checks WHERE monitor_id = ? AND id NOT IN (
					SELECT id FROM code_monitor_checks WHERE monitor_id = ?
					ORDER BY started_at DESC, id DESC LIMIT ?
				)`,
			)
			.run(monitorId, monitorId, MAX_CHECKS_PER_MONITOR);
	}

	setVerdict(id: string, verdict: CodeCommitVerdict): void {
		this.db
			.prepare(
				`UPDATE code_commits SET verdict = ?, confidence = ?, cve = ?, severity = ?,
				 vuln_type = ?, vuln_category = ?, vuln_tags = ?, reason = ?, judged_at = ? WHERE id = ?`,
			)
			.run(
				verdict.verdict,
				verdict.confidence,
				verdict.cve,
				verdict.severity,
				verdict.vulnType,
				verdict.vulnCategory,
				JSON.stringify(
					verdict.verdict === "security" ? normalizeCodeVulnTags(verdict.vulnTags, verdict.vulnCategory) : [],
				),
				verdict.reason,
				verdict.judgedAt,
				id,
			);
	}

	setStatus(id: string, status: SentinelCodeCommitStatus, engineId: string | null, error: string | null): void {
		this.db
			.prepare("UPDATE code_commits SET status = ?, engine_id = ?, error = ?, reproduction_stage = ? WHERE id = ?")
			.run(
				status,
				engineId,
				error,
				error ? "failed" : status === "dispatching" ? "git" : status === "dispatched" ? "engineering" : null,
				id,
			);
	}

	/** Only emit a change when the linked engine actually moves to another stage. */
	syncEngineStage(engineId: string, stage: SentinelCodeReproductionStage): boolean {
		const result = this.db
			.prepare(`UPDATE code_commits SET reproduction_stage = ?
			WHERE engine_id = ? AND reproduction_stage IS NOT ?`)
			.run(stage, engineId, stage);
		return Number(result.changes ?? 0) > 0;
	}

	linkedEngineIds(): string[] {
		return (
			this.db.prepare("SELECT DISTINCT engine_id FROM code_commits WHERE engine_id IS NOT NULL").all() as Array<{
				engine_id: string;
			}>
		).map((row) => row.engine_id);
	}

	setDuplicateOf(id: string, duplicateOf: string): void {
		this.db.prepare("UPDATE code_commits SET duplicate_of = ? WHERE id = ?").run(duplicateOf, id);
	}

	/** Another security verdict for the same advisory, for deduplication. */
	findSecurityByCve(monitorId: string, cve: string, excludeId: string): SentinelCodeCommit | null {
		const row = this.db
			.prepare(
				`SELECT * FROM code_commits WHERE monitor_id = ? AND cve = ? AND id != ?
				 AND verdict = 'security' ORDER BY created_at LIMIT 1`,
			)
			.get(monitorId, cve, excludeId) as unknown as CommitRow | undefined;
		return row ? toCommit(row) : null;
	}

	/** Whether the same patch was already confirmed (CVE-less fixes). */
	findSecurityByPatch(monitorId: string, key: string, excludeId: string): SentinelCodeCommit | null {
		const row = this.db
			.prepare(
				`SELECT * FROM code_commits WHERE monitor_id = ? AND patch_key = ? AND id != ?
				 AND verdict = 'security' ORDER BY created_at LIMIT 1`,
			)
			.get(monitorId, key, excludeId) as unknown as CommitRow | undefined;
		return row ? toCommit(row) : null;
	}

	/** Verdicts that failed before a decision, oldest first, for the retry sweep. */
	failedCommits(monitorId: string, limit = 3): SentinelCodeCommit[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM code_commits WHERE monitor_id = ? AND verdict = 'failed'
				 ORDER BY judged_at ASC, authored_at ASC LIMIT ?`,
			)
			.all(monitorId, limit) as unknown as CommitRow[];
		return rows.map(toCommit);
	}

	/** Security verdicts that were never handed to an engine, for a manual sweep. */
	pendingSecurity(monitorId: string): SentinelCodeCommit[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM code_commits WHERE monitor_id = ? AND verdict = 'security'
				 AND status = 'new' ORDER BY authored_at ASC`,
			)
			.all(monitorId) as unknown as CommitRow[];
		return rows.map(toCommit);
	}
}

/** Stable fingerprint of a rendered diff, for cross-branch cherry-pick dedupe. */
export function patchKey(diff: string | null): string | null {
	if (!diff) return null;
	return createHash("sha256").update(diff, "utf-8").digest("hex");
}

export function codeMonitorDbPath(agentDir: string): string {
	return join(agentDir, "code-monitor.db");
}

function secretsPath(agentDir: string): string {
	return join(agentDir, "code-monitor-secrets.json");
}

/** Monitor id → access token. A missing file is an empty map. */
export function readCodeMonitorSecrets(agentDir: string): Record<string, string> {
	const path = secretsPath(agentDir);
	if (!existsSync(path)) return {};
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
		const secrets: Record<string, string> = {};
		for (const [id, token] of Object.entries(raw)) {
			if (typeof token === "string") secrets[id] = token;
		}
		return secrets;
	} catch {
		return {};
	}
}

function writeSecrets(agentDir: string, secrets: Record<string, string>): void {
	const path = secretsPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(secrets, null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// chmod is best-effort on filesystems that reject it
	}
}

export function setCodeMonitorSecret(agentDir: string, id: string, token: string): void {
	const secrets = readCodeMonitorSecrets(agentDir);
	const trimmed = token.trim();
	if (trimmed) secrets[id] = trimmed;
	else delete secrets[id];
	writeSecrets(agentDir, secrets);
}

export function removeCodeMonitorSecret(agentDir: string, id: string): void {
	const secrets = readCodeMonitorSecrets(agentDir);
	if (!(id in secrets)) return;
	delete secrets[id];
	writeSecrets(agentDir, secrets);
}

/** Narrow input to a positive interval the timer can act on. */
export function normalizeIntervalMinutes(value: unknown): number {
	const minutes = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 60;
	if (minutes <= 0) return 0;
	return Math.max(10, Math.min(24 * 60, minutes));
}
