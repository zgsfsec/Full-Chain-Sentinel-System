/**
 * Persistent record of engineering runs: one row per engine and per task, plus
 * the commander's decision log and each worker's process steps. Everything the
 * console needs to resume or review an engine lives here, so a service restart
 * loses no state (running tasks come back paused, the operator resumes them).
 *
 * Mirrors subagent-store.ts: two entity tables plus append-only event tables
 * ordered by `seq`, with a size cap on long tool output.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type CodeReproductionResult, parseCodeReproductionResult } from "./code-reproduction.ts";
import type { IntelligenceEngineInput } from "./intelligence-types.ts";
import type {
	SentinelEngine,
	SentinelEngineEvent,
	SentinelEngineGateMode,
	SentinelEngineLimits,
	SentinelEngineSchedule,
	SentinelEngineStatus,
	SentinelEngineTarget,
	SentinelEngineTask,
	SentinelEngineTaskContinue,
	SentinelEngineTaskStatus,
	SentinelGoalUsage,
} from "./protocol.ts";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_TASKS_KEPT = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS engines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  pause_note TEXT,
  targets TEXT NOT NULL,
  doctrines TEXT NOT NULL,
  preset_ids TEXT NOT NULL DEFAULT '[]',
  preset_optional INTEGER NOT NULL DEFAULT 1,
  limits TEXT NOT NULL,
  gate_mode TEXT NOT NULL DEFAULT 'auto',
  schedule TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  report TEXT,
  reproduction TEXT
);
CREATE TABLE IF NOT EXISTS engine_tasks (
  id TEXT PRIMARY KEY,
  engine_id TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  target TEXT,
  workspace TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  criteria TEXT NOT NULL DEFAULT '[]',
  round_limit INTEGER NOT NULL,
  preset_id TEXT,
  preset_name TEXT,
  pending_continue TEXT,
  session_id TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  summary TEXT,
  error TEXT,
  usage TEXT,
  vulns INTEGER NOT NULL DEFAULT 0,
  auto_resume INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS engine_events (
  owner_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (owner_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_engine_tasks_engine ON engine_tasks(engine_id, seq ASC);
CREATE INDEX IF NOT EXISTS idx_engine_events_owner ON engine_events(owner_id, seq ASC);
CREATE TABLE IF NOT EXISTS engine_intelligence (
 engine_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, input TEXT NOT NULL
);
`;

interface EngineRow {
	id: string;
	project_id: string;
	project_name: string;
	name: string;
	status: string;
	pause_note: string | null;
	targets: string;
	doctrines: string;
	preset_ids: string;
	/** SQLite has no boolean: 1 means a task may run without a preset. */
	preset_optional: number;
	limits: string;
	gate_mode: string;
	schedule: string | null;
	created_at: number;
	started_at: number | null;
	ended_at: number | null;
	report: string | null;
	reproduction: string | null;
}

interface TaskRow {
	id: string;
	engine_id: string;
	title: string;
	objective: string;
	target: string | null;
	workspace: string;
	status: string;
	attempt: number;
	criteria: string;
	round_limit: number;
	preset_id: string | null;
	preset_name: string | null;
	pending_continue: string | null;
	session_id: string | null;
	started_at: number | null;
	ended_at: number | null;
	summary: string | null;
	error: string | null;
	usage: string | null;
	vulns: number;
	auto_resume: number;
}

export function engineDbPath(agentDir: string): string {
	return `${agentDir}/engines.db`;
}

export class EngineStore {
	private readonly db: SqliteDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		this.addGateModeColumn();
		this.addPresetColumns();
		this.addContinuationColumn();
		this.addScheduleColumns();
		const columns = this.db.prepare("PRAGMA table_info(engines)").all() as Array<{ name: string }>;
		if (!columns.some((column) => column.name === "reproduction")) {
			this.db.exec("ALTER TABLE engines ADD COLUMN reproduction TEXT");
		}
	}

	/**
	 * Databases created before engines carried a gate mode have no column for it.
	 * `auto` is the right default: those engines ran ungated, and reading them as
	 * anything else would change how an existing run behaves.
	 */
	private addGateModeColumn(): void {
		const columns = this.db.prepare("PRAGMA table_info(engines)").all() as unknown as Array<{ name: string }>;
		if (columns.some((column) => column.name === "gate_mode")) return;
		this.db.exec("ALTER TABLE engines ADD COLUMN gate_mode TEXT NOT NULL DEFAULT 'auto'");
	}

	/**
	 * Preset columns, added the same way. An engine from before presets gets an
	 * empty whitelist — no restriction, which is exactly how it ran — and its
	 * existing tasks get no preset, which is the default agent they used. Such an
	 * engine also keeps presets optional, so it dispatches exactly as it did.
	 */
	private addPresetColumns(): void {
		const engineColumns = this.db.prepare("PRAGMA table_info(engines)").all() as unknown as Array<{ name: string }>;
		if (!engineColumns.some((column) => column.name === "preset_ids")) {
			this.db.exec("ALTER TABLE engines ADD COLUMN preset_ids TEXT NOT NULL DEFAULT '[]'");
		}
		if (!engineColumns.some((column) => column.name === "preset_optional")) {
			this.db.exec("ALTER TABLE engines ADD COLUMN preset_optional INTEGER NOT NULL DEFAULT 1");
		}
		const taskColumns = this.db.prepare("PRAGMA table_info(engine_tasks)").all() as unknown as Array<{
			name: string;
		}>;
		if (!taskColumns.some((column) => column.name === "preset_id")) {
			this.db.exec("ALTER TABLE engine_tasks ADD COLUMN preset_id TEXT");
		}
		if (!taskColumns.some((column) => column.name === "preset_name")) {
			this.db.exec("ALTER TABLE engine_tasks ADD COLUMN preset_name TEXT");
		}
	}

	/**
	 * Continuation requests postdate the first task rows. A task from before the
	 * column existed has none, which is exactly the old behavior: it can only be
	 * continued after an explicit command, never on its own.
	 */
	private addContinuationColumn(): void {
		const columns = this.db.prepare("PRAGMA table_info(engine_tasks)").all() as unknown as Array<{ name: string }>;
		if (!columns.some((column) => column.name === "pending_continue")) {
			this.db.exec("ALTER TABLE engine_tasks ADD COLUMN pending_continue TEXT");
		}
	}

	/**
	 * Schedule and started-at columns. Existing engines were all started immediately,
	 * so their started_at falls back to created_at; a null started_at is meaningful
	 * only for a new scheduled row.
	 */
	private addScheduleColumns(): void {
		const engineColumns = this.db.prepare("PRAGMA table_info(engines)").all() as unknown as Array<{ name: string }>;
		if (!engineColumns.some((column) => column.name === "schedule")) {
			this.db.exec("ALTER TABLE engines ADD COLUMN schedule TEXT");
		}
		if (!engineColumns.some((column) => column.name === "started_at")) {
			this.db.exec("ALTER TABLE engines ADD COLUMN started_at INTEGER");
			this.db.exec("UPDATE engines SET started_at = created_at WHERE started_at IS NULL");
		}
		const taskColumns = this.db.prepare("PRAGMA table_info(engine_tasks)").all() as unknown as Array<{
			name: string;
		}>;
		if (!taskColumns.some((column) => column.name === "auto_resume")) {
			this.db.exec("ALTER TABLE engine_tasks ADD COLUMN auto_resume INTEGER NOT NULL DEFAULT 0");
		}
	}

	createEngine(input: {
		projectId: string;
		projectName: string;
		name: string;
		targets: SentinelEngineTarget[];
		doctrines: string[];
		/** Preset whitelist; omitted means no restriction. */
		presetIds?: string[];
		/** Whether a task may run without a preset; omitted means it may. */
		presetOptional?: boolean;
		limits: SentinelEngineLimits;
		gateMode: SentinelEngineGateMode;
		/** Scheduled engines are saved without a commander; defaults to running. */
		status?: SentinelEngineStatus;
		startedAt?: number | null;
		schedule?: SentinelEngineSchedule | null;
	}): SentinelEngine {
		const engine: SentinelEngine = {
			id: `engine-${randomUUID()}`,
			projectId: input.projectId,
			projectName: input.projectName,
			name: input.name,
			status: input.status ?? "running",
			pauseNote: null,
			targets: input.targets,
			doctrines: input.doctrines,
			presetIds: input.presetIds ?? [],
			presetOptional: input.presetOptional ?? true,
			limits: input.limits,
			gateMode: input.gateMode,
			createdAt: Date.now(),
			startedAt: input.startedAt ?? (input.status === "scheduled" ? null : Date.now()),
			endedAt: null,
			schedule: input.schedule ?? null,
			report: null,
			reproduction: null,
			tasks: [],
		};
		this.db
			.prepare(
				`INSERT INTO engines (id, project_id, project_name, name, status, targets, doctrines, preset_ids, preset_optional, limits, gate_mode, schedule, created_at, started_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				engine.id,
				engine.projectId,
				engine.projectName,
				engine.name,
				engine.status,
				JSON.stringify(engine.targets),
				JSON.stringify(engine.doctrines),
				JSON.stringify(engine.presetIds),
				engine.presetOptional ? 1 : 0,
				JSON.stringify(engine.limits),
				engine.gateMode,
				engine.schedule ? JSON.stringify(engine.schedule) : null,
				engine.createdAt,
				engine.startedAt,
			);
		return engine;
	}

	getEngine(id: string): SentinelEngine | undefined {
		const row = this.db.prepare("SELECT * FROM engines WHERE id = ?").get(id) as unknown as EngineRow | undefined;
		if (!row) return undefined;
		const tasks = this.db
			.prepare("SELECT * FROM engine_tasks WHERE engine_id = ? ORDER BY seq ASC")
			.all(id) as unknown as TaskRow[];
		return engineFromRow(row, tasks.map(taskFromRow));
	}

	intelligenceInput(engineId: string): IntelligenceEngineInput | undefined {
		const row = this.db.prepare("SELECT input FROM engine_intelligence WHERE engine_id=?").get(engineId) as
			| { input: string }
			| undefined;
		return row ? (JSON.parse(row.input) as IntelligenceEngineInput) : undefined;
	}

	findIntelligenceEngine(attemptId: string): SentinelEngine | undefined {
		const row = this.db.prepare("SELECT engine_id FROM engine_intelligence WHERE attempt_id=?").get(attemptId) as
			| { engine_id: string }
			| undefined;
		return row ? this.getEngine(row.engine_id) : undefined;
	}

	/** Association and initial task commit together, before any model request. */
	createIntelligenceEngine(project: { id: string; name: string }, input: IntelligenceEngineInput): SentinelEngine {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.findIntelligenceEngine(input.attemptId);
			if (existing) {
				if (existing.projectId !== project.id) throw new Error("分析批次项目不匹配");
				this.db.exec("COMMIT");
				return existing;
			}
			const engine = this.createEngine({
				projectId: project.id,
				projectName: project.name,
				name: `${input.template.name} · ${input.items.length} IP · ${input.batchId.slice(0, 8)}`,
				targets: input.items.map((item) => ({ target: item.ip })),
				doctrines: [input.template.id],
				limits: { ...input.template.limits, concurrency: 1, maxRetries: 0 },
				gateMode: "auto",
			});
			this.db
				.prepare("INSERT INTO engine_intelligence VALUES (?,?,?)")
				.run(engine.id, input.attemptId, JSON.stringify(input));
			const alerts = input.items.map((item) => ({
				ip: item.ip,
				alertCount: item.alertCount,
				alerts: item.alerts.slice(0, 3).map((alert) => ({
					source: alert.sourceName,
					eventId: alert.event_id,
					occurredAt: alert.occurred_at,
					severity: alert.severity,
					category: alert.category,
					evidenceSample: JSON.stringify(alert.evidence).slice(0, 512),
				})),
			}));
			this.createTask({
				engineId: engine.id,
				title: "批次情报分析与关联报告",
				target: null,
				workspace: "intelligence",
				roundLimit: input.template.limits.roundLimit,
				attempt: 1,
				objective: `分析以下全部 IP 的设备告警和证据。告警仅展示最近三条样本，原始记录保留在威胁反制页。\n${JSON.stringify(alerts)}\n完成时在 goal_complete.summary 提交完整 Markdown 报告。`,
				criteria: [
					"已分析全部 IP 的告警，逐 IP 标明事实、来源、时间与不确定性",
					"给出告警关联、跨 IP 关联和防御建议，提交完整 Markdown 报告",
				],
			});
			const saved = this.getEngine(engine.id);
			if (!saved) throw new Error("分析工程保存失败");
			this.db.exec("COMMIT");
			return saved;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	listEngines(projectId?: string): SentinelEngine[] {
		const rows = (projectId
			? this.db.prepare("SELECT * FROM engines WHERE project_id = ? ORDER BY created_at DESC").all(projectId)
			: this.db.prepare("SELECT * FROM engines ORDER BY created_at DESC").all()) as unknown as EngineRow[];
		const statement = this.db.prepare("SELECT * FROM engine_tasks WHERE engine_id = ? ORDER BY seq ASC");
		return rows.map((row) => engineFromRow(row, (statement.all(row.id) as unknown as TaskRow[]).map(taskFromRow)));
	}

	setEngineStatus(id: string, status: SentinelEngineStatus, pauseNote: string | null, endedAt: number | null): void {
		this.db
			.prepare("UPDATE engines SET status = ?, pause_note = ?, ended_at = ? WHERE id = ?")
			.run(status, pauseNote, endedAt, id);
	}

	setEngineStartedAt(id: string, startedAt: number | null): void {
		this.db.prepare("UPDATE engines SET started_at = ? WHERE id = ?").run(startedAt, id);
	}

	setEngineSchedule(id: string, schedule: SentinelEngineSchedule | null): void {
		this.db
			.prepare("UPDATE engines SET schedule = ? WHERE id = ?")
			.run(schedule ? JSON.stringify(schedule) : null, id);
	}

	setEngineReport(id: string, report: string, reproduction: CodeReproductionResult | null = null): void {
		this.db
			.prepare("UPDATE engines SET report = ?, reproduction = ? WHERE id = ?")
			.run(report, reproduction ? JSON.stringify(reproduction) : null, id);
	}

	/** Change how this engine's workers are gated; the manager refuses while it runs. */
	setEngineGateMode(id: string, gateMode: SentinelEngineGateMode): void {
		this.db.prepare("UPDATE engines SET gate_mode = ? WHERE id = ?").run(gateMode, id);
	}

	/**
	 * Replace this engine's preset whitelist. An empty list clears the restriction;
	 * changing it cannot affect a task already dispatched, because a task records
	 * the preset it ran as and its session file carries the choice.
	 */
	setEnginePresets(id: string, presetIds: string[]): void {
		this.db.prepare("UPDATE engines SET preset_ids = ? WHERE id = ?").run(JSON.stringify(presetIds), id);
	}

	/**
	 * Whether this engine's tasks may run without a preset. Like the whitelist this
	 * is per dispatch: a task already created keeps the preset it captured.
	 */
	setEnginePresetOptional(id: string, optional: boolean): void {
		this.db.prepare("UPDATE engines SET preset_optional = ? WHERE id = ?").run(optional ? 1 : 0, id);
	}

	/** Delete an engine with its tasks and event logs. The manager ensures it is not running. */
	deleteEngine(id: string): void {
		this.db.prepare("DELETE FROM engine_events WHERE owner_id = ?").run(id);
		const tasks = this.db.prepare("SELECT id FROM engine_tasks WHERE engine_id = ?").all(id) as unknown as {
			id: string;
		}[];
		for (const task of tasks) {
			this.db.prepare("DELETE FROM engine_events WHERE owner_id = ?").run(task.id);
			this.db.prepare("DELETE FROM engine_tasks WHERE id = ?").run(task.id);
		}
		this.db.prepare("DELETE FROM engines WHERE id = ?").run(id);
	}

	addTargets(id: string, targets: SentinelEngineTarget[]): void {
		const engine = this.getEngine(id);
		if (!engine) return;
		const merged = [...engine.targets];
		for (const target of targets) {
			if (!merged.some((item) => item.target === target.target)) merged.push(target);
		}
		this.db.prepare("UPDATE engines SET targets = ? WHERE id = ?").run(JSON.stringify(merged), id);
	}

	createTask(input: {
		engineId: string;
		title: string;
		objective: string;
		target: string | null;
		workspace: string;
		roundLimit: number;
		attempt: number;
		criteria?: string[];
		/** The preset agent this task runs as; null means the default agent. */
		presetId?: string | null;
		presetName?: string | null;
	}): SentinelEngineTask {
		const engine = this.getEngine(input.engineId);
		const seq = engine ? engine.tasks.length : 0;
		// The task list is bounded so a runaway commander cannot grow the row
		// count forever; the oldest finished tasks fall off the front.
		if (engine && engine.tasks.length >= MAX_TASKS_KEPT) {
			const removable = engine.tasks.filter((task) => task.status === "done").slice(0, 10);
			for (const task of removable) this.db.prepare("DELETE FROM engine_tasks WHERE id = ?").run(task.id);
		}
		const task: SentinelEngineTask = {
			id: `task-${randomUUID()}`,
			engineId: input.engineId,
			title: input.title,
			objective: input.objective,
			target: input.target,
			workspace: input.workspace,
			status: "queued",
			attempt: input.attempt,
			roundLimit: input.roundLimit,
			criteria: input.criteria ?? [],
			presetId: input.presetId ?? null,
			presetName: input.presetName ?? null,
			pendingContinue: null,
			sessionId: null,
			startedAt: null,
			endedAt: null,
			summary: null,
			error: null,
			usage: null,
			vulns: 0,
			autoResume: false,
		};
		this.db
			.prepare(
				`INSERT INTO engine_tasks (id, engine_id, title, objective, target, workspace, status, attempt, criteria, round_limit, preset_id, preset_name, session_id, auto_resume, seq)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
			)
			.run(
				task.id,
				task.engineId,
				task.title,
				task.objective,
				task.target,
				task.workspace,
				task.status,
				task.attempt,
				JSON.stringify(task.criteria),
				task.roundLimit,
				task.presetId,
				task.presetName,
				task.autoResume ? 1 : 0,
				seq,
			);
		return task;
	}

	/** One validated finding reached the hub from this task; atomic so a concurrent updateTask cannot lose it. */
	incrementTaskVulns(id: string): void {
		this.db.prepare("UPDATE engine_tasks SET vulns = vulns + 1 WHERE id = ?").run(id);
	}

	updateTask(id: string, patch: Partial<Omit<SentinelEngineTask, "id" | "engineId">>): void {
		const current = this.getTask(id);
		if (!current) return;
		const next = { ...current, ...patch };
		this.db
			.prepare(
				`UPDATE engine_tasks SET status = ?, criteria = ?, preset_id = ?, preset_name = ?, session_id = ?, started_at = ?, ended_at = ?, summary = ?,
				 error = ?, usage = ?, vulns = ?, title = ?, objective = ?, round_limit = ?, pending_continue = ?, auto_resume = ? WHERE id = ?`,
			)
			.run(
				next.status,
				JSON.stringify(next.criteria),
				next.presetId,
				next.presetName,
				next.sessionId,
				next.startedAt,
				next.endedAt,
				next.summary,
				next.error,
				next.usage ? JSON.stringify(next.usage) : null,
				next.vulns,
				next.title,
				next.objective,
				next.roundLimit,
				next.pendingContinue ? JSON.stringify(next.pendingContinue) : null,
				next.autoResume ? 1 : 0,
				id,
			);
	}

	getTask(id: string): SentinelEngineTask | undefined {
		const row = this.db.prepare("SELECT * FROM engine_tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined;
		return row ? taskFromRow(row) : undefined;
	}

	/** Append one event to an owner (engine id for the commander, task id for a worker). */
	appendEvent(ownerId: string, event: SentinelEngineEvent): void {
		let payload = JSON.stringify(event);
		if (payload.length > MAX_EVENT_BYTES) {
			payload = JSON.stringify({ ...event, text: undefined, output: truncate(event.output), truncated: true });
		}
		this.db
			.prepare("INSERT OR REPLACE INTO engine_events (owner_id, seq, kind, at, payload) VALUES (?, ?, ?, ?, ?)")
			.run(ownerId, event.seq, event.kind, event.at, payload);
	}

	listEvents(ownerId: string): SentinelEngineEvent[] {
		const rows = this.db
			.prepare("SELECT payload FROM engine_events WHERE owner_id = ? ORDER BY seq ASC")
			.all(ownerId) as unknown as { payload: string }[];
		const events: SentinelEngineEvent[] = [];
		for (const row of rows) {
			try {
				events.push(JSON.parse(row.payload) as SentinelEngineEvent);
			} catch {
				// A corrupt row must not hide the rest of the log.
			}
		}
		return events;
	}

	/** Running tasks left behind by a previous process come back as paused. */
	interruptRunning(): number {
		const result = this.db
			.prepare(`UPDATE engine_tasks SET status = 'paused', ended_at = ? WHERE status IN ('running', 'queued')`)
			.run(Date.now());
		return Number(result.changes ?? 0);
	}

	/**
	 * A restart is not a scheduled pause: safe policy leaves interrupted work for
	 * the operator, so no task may auto-continue on the next manual resume.
	 */
	clearAutoResume(): void {
		this.db.prepare("UPDATE engine_tasks SET auto_resume = 0").run();
	}

	close(): void {
		this.db.close();
	}
}

function engineFromRow(row: EngineRow, tasks: SentinelEngineTask[]): SentinelEngine {
	return {
		id: row.id,
		projectId: row.project_id,
		projectName: row.project_name,
		name: row.name,
		status: row.status as SentinelEngineStatus,
		pauseNote: row.pause_note,
		targets: parseJson(row.targets, []) as SentinelEngineTarget[],
		doctrines: parseJson(row.doctrines, []) as string[],
		// A row written before the column existed reads as no restriction, which is
		// how it ran.
		presetIds: parseJson(row.preset_ids, []) as string[],
		// A row written before the column existed reads as optional, which is how it ran.
		presetOptional: row.preset_optional !== 0,
		limits: parseJson(row.limits, null) as unknown as SentinelEngineLimits,
		// A row written before the column existed reads as `auto`, which is how it ran.
		gateMode: row.gate_mode === "ai" ? "ai" : "auto",
		createdAt: row.created_at,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		schedule: scheduleFromRow(row.schedule),
		report: row.report,
		reproduction: row.reproduction ? parseCodeReproductionResult(parseJson(row.reproduction, null)) : null,
		tasks,
	};
}

function taskFromRow(row: TaskRow): SentinelEngineTask {
	return {
		id: row.id,
		engineId: row.engine_id,
		title: row.title,
		objective: row.objective,
		target: row.target,
		workspace: row.workspace,
		status: row.status as SentinelEngineTaskStatus,
		attempt: row.attempt,
		roundLimit: row.round_limit,
		criteria: parseJson(row.criteria, []) as string[],
		presetId: row.preset_id,
		presetName: row.preset_name,
		pendingContinue: continueFromRow(row.pending_continue),
		sessionId: row.session_id,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		summary: row.summary,
		error: row.error,
		usage: row.usage ? (parseJson(row.usage, null) as unknown as SentinelGoalUsage | null) : null,
		vulns: row.vulns,
		autoResume: row.auto_resume === 1,
	};
}

/** Corrupt schedule JSON must not leave a row looking scheduled with no plan. */
function scheduleFromRow(raw: string | null): SentinelEngineSchedule | null {
	if (!raw) return null;
	const value = parseJson<Partial<SentinelEngineSchedule> | null>(raw, null);
	if (!value || typeof value.startAt !== "number" || typeof value.timezone !== "string") return null;
	const phase = value.phase;
	if (phase !== "waiting_start" && phase !== "running" && phase !== "paused" && phase !== "finished") return null;
	return {
		timezone: value.timezone,
		startAt: value.startAt,
		pauseAt: typeof value.pauseAt === "number" ? value.pauseAt : null,
		resumeAt: typeof value.resumeAt === "number" ? value.resumeAt : null,
		deadlineAt: typeof value.deadlineAt === "number" ? value.deadlineAt : null,
		repeatDaily: value.repeatDaily === true,
		phase,
		applied: Array.isArray(value.applied)
			? value.applied.filter(
					(action): action is SentinelEngineSchedule["applied"][number] =>
						action === "start" || action === "pause" || action === "resume" || action === "deadline",
				)
			: [],
		finishedReason:
			value.finishedReason === "completed" ||
			value.finishedReason === "deadline" ||
			value.finishedReason === "manual" ||
			value.finishedReason === "canceled" ||
			value.finishedReason === "start_failed" ||
			value.finishedReason === "missed" ||
			value.finishedReason === "restart"
				? value.finishedReason
				: null,
		finishedAt: typeof value.finishedAt === "number" ? value.finishedAt : null,
	};
}

function parseJson<T>(raw: string, fallback: T): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/** A corrupted continuation row must not keep a task permanently queued. */
function continueFromRow(raw: string | null): SentinelEngineTaskContinue | null {
	if (!raw) return null;
	const value = parseJson<Partial<SentinelEngineTaskContinue> | null>(raw, null);
	if (!value || typeof value.instruction !== "string" || typeof value.roundLimit !== "number") return null;
	return {
		instruction: value.instruction,
		criteria: Array.isArray(value.criteria) ? value.criteria.filter((item) => typeof item === "string") : [],
		roundLimit: value.roundLimit,
		requestedAt: typeof value.requestedAt === "number" ? value.requestedAt : 0,
	};
}

function truncate(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (value.length <= MAX_EVENT_BYTES) return value;
	return `${value.slice(0, MAX_EVENT_BYTES)}\n…（已截断）`;
}
