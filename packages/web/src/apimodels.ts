/**
 * The business-modeling hub: what the agent records about a project's business.
 *
 * One modeling run is one record, with two halves. The document half is the
 * OpenAPI document restored from the target's traffic, with the business entities
 * inferred along the way. The source half is what the agent read out of the
 * project's source: the endpoint mappings and the business logic model. A run
 * fills whichever halves its inputs allow.
 *
 * Modeling runs inside an ordinary conversation or an engineering task's worker,
 * and this module owns everything that outlives that run: the record, the audit
 * trail, and the export.
 *
 * Storage is one SQLite database in the agent directory, not in the project work
 * directory, for the same reason the vulnerability hub lives there: the work
 * directory is mounted into the container, and one `rm` would take the records
 * with it.
 *
 * Every run is a new record. Re-modeling a site produces a second record rather
 * than overwriting the first, so the operator can compare coverage between
 * attempts; nothing here ever merges two runs together.
 *
 * The record is opened by the agent's first submission, not by the button that
 * asks for the work. A submission is applied to a record that is still only in
 * memory and written only once it is accepted, so a first submission that is
 * refused leaves no empty record behind.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as toYaml } from "yaml";
import type {
	SentinelApiModel,
	SentinelApiModelEntity,
	SentinelApiModelEvent,
	SentinelApiModelField,
	SentinelApiModelFilters,
	SentinelApiModelRelation,
	SentinelApiModelStatus,
	SentinelApiModelSummary,
	SentinelApiSourceMapping,
	SentinelBusinessLogicModel,
} from "./protocol.ts";
import {
	danglingReferences,
	emptyLogic,
	mergeApiMappings,
	mergeLogic,
	normalizeSourceSubmission,
	pageOf,
	type SourceModelSubmitInput,
	type SourceModelSubmitResult,
	sourceModelSections,
	sourceOverflow,
	tableCell,
} from "./sourcemodels.ts";
import { openSqliteDatabase, type SqliteDatabase, type SqliteValue } from "./sqlite.ts";

/** Largest document accepted, measured on the serialized JSON. */
const MAX_DOC_BYTES = 512 * 1024;

/**
 * Endpoints one document may hold. A real site is a few hundred; this is a
 * runaway guard, not a design limit.
 */
const MAX_PATHS = 5_000;

/** Business entities the document half may record. */
const MAX_ENTITIES = 200;
const MAX_FIELDS_PER_ENTITY = 200;
const MAX_RELATIONS_PER_ENTITY = 50;

/** Longest title kept; the page shows it in one row. */
const MAX_TITLE_LENGTH = 80;

/** Operations per path item, per the OpenAPI specification. */
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

const STATUSES: readonly SentinelApiModelStatus[] = ["modeling", "done", "manual", "failed"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_models (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT,
  session_path TEXT,
  title TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  openapi TEXT NOT NULL,
  entities TEXT NOT NULL DEFAULT '[]',
  apis TEXT NOT NULL DEFAULT '[]',
  logic TEXT NOT NULL DEFAULT '{}',
  path_count INTEGER NOT NULL DEFAULT 0,
  operation_count INTEGER NOT NULL DEFAULT 0,
  entity_count INTEGER NOT NULL DEFAULT 0,
  api_count INTEGER NOT NULL DEFAULT 0,
  state_machine_count INTEGER NOT NULL DEFAULT 0,
  rule_count INTEGER NOT NULL DEFAULT 0,
  submissions INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT
);
-- The page lists newest first, always scoped to the project on screen.
CREATE INDEX IF NOT EXISTS idx_api_models_project ON api_models(project_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_api_models_created ON api_models(created_at DESC, id);
CREATE TABLE IF NOT EXISTS api_model_events (
  id INTEGER PRIMARY KEY,
  model_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT,
  path_count INTEGER,
  operation_count INTEGER,
  entity_count INTEGER,
  api_count INTEGER,
  state_machine_count INTEGER,
  rule_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_model_events ON api_model_events(model_id, id);
`;

/**
 * Columns a database written before a record could hold the source half does
 * not have. Each is added on open, with the value an empty half reads as.
 */
const SOURCE_COLUMNS: ReadonlyArray<readonly [table: string, column: string, definition: string]> = [
	["api_models", "source", "TEXT NOT NULL DEFAULT ''"],
	["api_models", "apis", "TEXT NOT NULL DEFAULT '[]'"],
	["api_models", "logic", "TEXT NOT NULL DEFAULT '{}'"],
	["api_models", "api_count", "INTEGER NOT NULL DEFAULT 0"],
	["api_models", "state_machine_count", "INTEGER NOT NULL DEFAULT 0"],
	["api_models", "rule_count", "INTEGER NOT NULL DEFAULT 0"],
	["api_model_events", "entity_count", "INTEGER"],
	["api_model_events", "api_count", "INTEGER"],
	["api_model_events", "state_machine_count", "INTEGER"],
	["api_model_events", "rule_count", "INTEGER"],
];

interface ApiModelRow {
	id: string;
	project_id: string | null;
	session_id: string | null;
	session_path: string | null;
	title: string;
	target: string;
	source: string;
	status: string;
	openapi: string;
	entities: string;
	apis: string;
	logic: string;
	path_count: number;
	operation_count: number;
	entity_count: number;
	api_count: number;
	state_machine_count: number;
	rule_count: number;
	submissions: number;
	error: string | null;
	created_at: string;
	updated_at: string;
	done_at: string | null;
}

interface ApiModelEventRow {
	at: string;
	kind: string;
	note: string | null;
	path_count: number | null;
	operation_count: number | null;
	entity_count: number | null;
	api_count: number | null;
	state_machine_count: number | null;
	rule_count: number | null;
}

/** A list row: the two bodies are deliberately absent. */
type ApiModelSummaryRow = Omit<ApiModelRow, "openapi" | "entities" | "apis" | "logic">;

const SUMMARY_COLUMNS =
	"id, project_id, session_id, session_path, title, target, source, status, path_count, operation_count, entity_count, api_count, state_machine_count, rule_count, submissions, error, created_at, updated_at, done_at";

export function apiModelsDbPath(agentDir: string): string {
	return join(agentDir, "apimodels.db");
}

/** Operations in a `paths` object, which is what the page counts as endpoints. */
export function countOperations(paths: unknown): number {
	if (!paths || typeof paths !== "object") return 0;
	let operations = 0;
	for (const item of Object.values(paths as Record<string, unknown>)) {
		if (!item || typeof item !== "object") continue;
		for (const key of Object.keys(item as Record<string, unknown>)) {
			if ((HTTP_METHODS as readonly string[]).includes(key.toLowerCase())) operations += 1;
		}
	}
	return operations;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What is wrong with a document, phrased for the model that has to fix it. An
 * empty list means it is acceptable. The checks are the ones that decide whether
 * a Swagger tool can open the file at all; style is not enforced.
 */
export function validateOpenApiDocument(doc: unknown): string[] {
	if (!isPlainObject(doc)) return ["文档必须是一个 JSON 对象。"];
	const problems: string[] = [];
	const version = doc.openapi;
	if (typeof version !== "string" || !version.trim()) {
		problems.push('缺少 openapi 字段：必须是 "3.0.0" 这类 3.x 版本号（本控制台只接受 OpenAPI 3.x）。');
	} else if (!/^3\./.test(version.trim())) {
		problems.push(`openapi 版本 ${version} 不受支持：必须是 3.x（例如 "3.0.3"）。`);
	}
	if (!isPlainObject(doc.info)) {
		problems.push("缺少 info 对象：至少要写 info.title 与 info.version。");
	} else {
		if (typeof doc.info.title !== "string" || !doc.info.title.trim()) problems.push("info.title 不能为空。");
		if (typeof doc.info.version !== "string" || !doc.info.version.trim()) problems.push("info.version 不能为空。");
	}
	if (!isPlainObject(doc.paths)) {
		problems.push("缺少 paths 对象：没有接口时也要写空的 paths: {}。");
	} else {
		const keys = Object.keys(doc.paths);
		if (keys.length > MAX_PATHS) {
			problems.push(`接口数量 ${keys.length} 超过上限 ${MAX_PATHS}：请拆分或只保留已确认的接口。`);
		}
		const badPath = keys.find((key) => !key.startsWith("/"));
		if (badPath !== undefined) problems.push(`paths 的键必须以 / 开头：${badPath} 不合法。`);
	}
	if (doc.components !== undefined && !isPlainObject(doc.components)) problems.push("components 必须是对象。");
	return problems;
}

/**
 * Fold a partial submission into the document already stored. `paths` is merged
 * per path item and `components` per section, which is what lets a large site be
 * delivered in batches: each call replaces exactly the endpoints it names and
 * leaves the rest of the draft alone.
 */
export function mergeOpenApiDraft(
	base: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...base, ...patch };
	if (patch.paths !== undefined) {
		const existing = isPlainObject(base.paths) ? base.paths : {};
		next.paths = { ...existing, ...(patch.paths as Record<string, unknown>) };
	}
	if (patch.components !== undefined) {
		const existing = isPlainObject(base.components) ? base.components : {};
		const incoming = patch.components as Record<string, unknown>;
		const merged: Record<string, unknown> = { ...existing };
		for (const [section, entries] of Object.entries(incoming)) {
			const before = isPlainObject(existing[section]) ? (existing[section] as Record<string, unknown>) : {};
			merged[section] = isPlainObject(entries) ? { ...before, ...entries } : entries;
		}
		next.components = merged;
	}
	return next;
}

/** Drop a 【…】 prefix and trailing punctuation, the way the hub treats titles. */
export function normalizeModelTitle(text: string): string {
	return text
		.replace(/^\s*【[^】]*】\s*/, "")
		.replace(/[\s。；;，,、.]+$/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_TITLE_LENGTH);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * The business entities a submission carries. Entries without a name are
 * reported rather than dropped silently: an unnamed entity is a model mistake
 * the caller can fix, and a silently discarded one is a document that lies.
 */
export function normalizeEntities(input: unknown): { entities: SentinelApiModelEntity[]; errors: string[] } {
	if (input === undefined) return { entities: [], errors: [] };
	if (!Array.isArray(input)) return { entities: [], errors: ["entities 必须是数组。"] };
	const errors: string[] = [];
	const entities: SentinelApiModelEntity[] = [];
	for (const [index, raw] of input.entries()) {
		if (!isPlainObject(raw)) {
			errors.push(`entities[${index}] 不是对象。`);
			continue;
		}
		const name = text(raw.name);
		if (!name) {
			errors.push(`entities[${index}] 缺少 name。`);
			continue;
		}
		if (entities.length >= MAX_ENTITIES) {
			errors.push(`业务实体数量超过上限 ${MAX_ENTITIES}，多余的已忽略。`);
			break;
		}
		const fields: SentinelApiModelField[] = [];
		if (raw.fields !== undefined) {
			if (!Array.isArray(raw.fields)) errors.push(`实体「${name}」的 fields 必须是数组。`);
			else {
				for (const field of raw.fields.slice(0, MAX_FIELDS_PER_ENTITY)) {
					if (!isPlainObject(field) || !text(field.name)) continue;
					fields.push({
						name: text(field.name),
						...(text(field.type) ? { type: text(field.type) } : {}),
						...(text(field.description) ? { description: text(field.description) } : {}),
					});
				}
			}
		}
		const relations: SentinelApiModelRelation[] = [];
		if (raw.relations !== undefined) {
			if (!Array.isArray(raw.relations)) errors.push(`实体「${name}」的 relations 必须是数组。`);
			else {
				for (const relation of raw.relations.slice(0, MAX_RELATIONS_PER_ENTITY)) {
					if (!isPlainObject(relation) || !text(relation.target)) continue;
					relations.push({
						target: text(relation.target),
						...(text(relation.kind) ? { kind: text(relation.kind) } : {}),
						...(text(relation.description) ? { description: text(relation.description) } : {}),
					});
				}
			}
		}
		entities.push({
			name,
			...(text(raw.description) ? { description: text(raw.description) } : {}),
			...(fields.length > 0 ? { fields } : {}),
			...(relations.length > 0 ? { relations } : {}),
		});
	}
	return { entities, errors };
}

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function statusOf(row: { status: string }): SentinelApiModelStatus {
	return (STATUSES as readonly string[]).includes(row.status) ? (row.status as SentinelApiModelStatus) : "failed";
}

function toModel(row: ApiModelRow): SentinelApiModel {
	return {
		id: row.id,
		projectId: row.project_id,
		sessionId: row.session_id,
		sessionPath: row.session_path,
		title: row.title,
		target: row.target,
		source: row.source,
		status: statusOf(row),
		openapi: parseJson<Record<string, unknown>>(row.openapi, {}),
		entities: parseJson<SentinelApiModelEntity[]>(row.entities, []),
		apis: parseJson<SentinelApiSourceMapping[]>(row.apis, []),
		logic: { ...emptyLogic(), ...parseJson<Partial<SentinelBusinessLogicModel>>(row.logic, {}) },
		pathCount: row.path_count,
		operationCount: row.operation_count,
		submissions: row.submissions,
		...(row.error ? { error: row.error } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		doneAt: row.done_at,
	};
}

function toSummary(row: ApiModelSummaryRow): SentinelApiModelSummary {
	return {
		id: row.id,
		projectId: row.project_id,
		sessionId: row.session_id,
		sessionPath: row.session_path,
		title: row.title,
		target: row.target,
		source: row.source,
		status: statusOf(row),
		pathCount: row.path_count,
		operationCount: row.operation_count,
		submissions: row.submissions,
		...(row.error ? { error: row.error } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		doneAt: row.done_at,
		entityCount: row.entity_count,
		apiCount: row.api_count,
		stateMachineCount: row.state_machine_count,
		ruleCount: row.rule_count,
	};
}

/** Which project and which conversation a run belongs to, as far as the session knows them. */
export interface ApiModelOrigin {
	projectId: string | null;
	sessionId: string | null;
	sessionPath: string | null;
	/** The record's title unless the first submission names one. */
	title?: string;
}

/**
 * A record as it stands before the agent's first submission. It is not in the
 * database: it only becomes a record once a submission is applied to it.
 */
function draft(origin: ApiModelOrigin, now: Date): SentinelApiModel {
	const stamp = now.toISOString();
	const title = normalizeModelTitle(origin.title ?? "") || "业务建模";
	return {
		id: `api-${randomUUID()}`,
		projectId: origin.projectId,
		sessionId: origin.sessionId,
		sessionPath: origin.sessionPath,
		title,
		target: "",
		source: "",
		status: "modeling",
		openapi: { openapi: "3.0.3", info: { title, version: "1.0.0" }, paths: {} },
		entities: [],
		apis: [],
		logic: emptyLogic(),
		pathCount: 0,
		operationCount: 0,
		submissions: 0,
		createdAt: stamp,
		updatedAt: stamp,
		doneAt: null,
	};
}

export interface ApiModelSubmitInput {
	/** Whole document, replacing the draft. */
	openapi?: unknown;
	/** Path items merged into the draft, keyed by path. */
	paths?: unknown;
	/** Component sections merged into the draft. */
	components?: unknown;
	/** Business entities; when given, the whole list replaces the stored one. */
	entities?: unknown;
	target?: string;
	title?: string;
	note?: string;
}

/**
 * Either the record as the submission left it, or the reasons it was refused.
 * `model` is present whenever something would be stored; `errors` is fatal only
 * when it is not.
 */
export type ApiModelSubmitResult = { model?: SentinelApiModel; errors?: string[] };

/**
 * Fold a submission into a record, in memory. A document that fails validation
 * refuses the whole submission: nothing would be written, and the reasons go
 * back to the model. Entities and the target/title are applied only after the
 * document passes, so a rejected call cannot half-update a record.
 */
function applyDocument(current: SentinelApiModel, input: ApiModelSubmitInput, now: Date): ApiModelSubmitResult {
	if (
		input.openapi === undefined &&
		input.paths === undefined &&
		input.components === undefined &&
		input.entities === undefined
	)
		return { errors: ["提交里没有任何内容：至少给 openapi、paths、components 或 entities 之一。"] };

	const base = current.openapi;
	let next: Record<string, unknown>;
	if (input.openapi !== undefined) {
		if (!isPlainObject(input.openapi)) return { errors: ["openapi 必须是 JSON 对象（整份文档）。"] };
		next = input.openapi;
		// A whole-document submission still merges the patch fields on top, so a
		// model that sends the document and one more path in the same call is
		// understood instead of half-applied.
		if (input.paths !== undefined || input.components !== undefined) {
			if (input.paths !== undefined && !isPlainObject(input.paths)) return { errors: ["paths 必须是对象。"] };
			if (input.components !== undefined && !isPlainObject(input.components)) {
				return { errors: ["components 必须是对象。"] };
			}
			next = mergeOpenApiDraft(next, {
				...(input.paths !== undefined ? { paths: input.paths } : {}),
				...(input.components !== undefined ? { components: input.components } : {}),
			});
		}
	} else if (input.paths !== undefined || input.components !== undefined) {
		if (input.paths !== undefined && !isPlainObject(input.paths)) return { errors: ["paths 必须是对象。"] };
		if (input.components !== undefined && !isPlainObject(input.components))
			return { errors: ["components 必须是对象。"] };
		next = mergeOpenApiDraft(base, {
			...(input.paths !== undefined ? { paths: input.paths } : {}),
			...(input.components !== undefined ? { components: input.components } : {}),
		});
	} else {
		next = base;
	}

	const problems = validateOpenApiDocument(next);
	if (problems.length > 0) return { errors: problems };

	const size = JSON.stringify(next).length;
	if (size > MAX_DOC_BYTES) {
		return {
			errors: [
				`文档过大（${Math.round(size / 1024)}KB，上限 ${Math.round(MAX_DOC_BYTES / 1024)}KB）：请分片提交，或删掉没有验证过的示例。`,
			],
		};
	}

	const entities = input.entities !== undefined ? normalizeEntities(input.entities) : undefined;
	const title = input.title !== undefined ? normalizeModelTitle(input.title) : "";
	const target = input.target?.trim() ?? "";
	const paths = isPlainObject(next.paths) ? next.paths : {};
	const model: SentinelApiModel = {
		...current,
		title: title || current.title,
		target: target || current.target,
		openapi: next,
		entities: entities ? entities.entities : current.entities,
		pathCount: Object.keys(paths).length,
		operationCount: countOperations(paths),
		submissions: current.submissions + 1,
		updatedAt: now.toISOString(),
	};
	// Entity problems are reported without refusing the document: the endpoints
	// are already stored, and the model can resubmit the entity list alone.
	return entities && entities.errors.length > 0 ? { model, errors: entities.errors } : { model };
}

/**
 * Fold a source submission into a record, in memory. Anything wrong in the
 * submission refuses it whole.
 *
 * `hostWorkDir` is the host side of the project's work directory: it is what
 * puts a cited path into its `/work/...` form.
 */
function applySource(
	current: SentinelApiModel,
	input: SourceModelSubmitInput,
	hostWorkDir: string,
	now: Date,
): SourceModelSubmitResult {
	const normalized = normalizeSourceSubmission(input, hostWorkDir);
	if ("errors" in normalized) return { ok: false, errors: normalized.errors };
	const apis = mergeApiMappings(current.apis, normalized.apis);
	const logic = mergeLogic(current.logic, normalized.patch);
	const overflow = sourceOverflow(apis, logic);
	if (overflow) return { ok: false, errors: [overflow] };
	const title = input.title === undefined ? "" : normalizeModelTitle(input.title);
	return {
		ok: true,
		model: {
			...current,
			title: title || current.title,
			source: normalized.source || current.source,
			apis,
			logic,
			submissions: current.submissions + 1,
			updatedAt: now.toISOString(),
		},
		warnings: danglingReferences(apis, logic),
	};
}

export class ApiModelStore {
	private readonly db: SqliteDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec(SCHEMA);
		this.addSourceColumns();
	}

	/**
	 * Databases created before a record could hold the source half have no
	 * columns for it. They are added here, so a record that predates them opens
	 * with that half empty instead of failing the first query.
	 */
	private addSourceColumns(): void {
		const names = new Map<string, Set<string>>();
		for (const [table, column, definition] of SOURCE_COLUMNS) {
			let known = names.get(table);
			if (!known) {
				const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
				known = new Set(columns.map((existing) => existing.name));
				names.set(table, known);
			}
			if (!known.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
		}
	}

	close(): void {
		this.db.close();
	}

	/**
	 * Open a record with the agent's first submission. Nothing is stored when the
	 * submission is refused.
	 */
	start(origin: ApiModelOrigin, input: ApiModelSubmitInput, now = new Date()): ApiModelSubmitResult {
		const opened = draft(origin, now);
		const applied = applyDocument(opened, input, now);
		// Entity problems do not refuse a document that was stored. Before the
		// first submission there is no record yet to keep, so a submission that
		// stored neither an endpoint nor an entity opens none.
		if (applied.model && applied.model.pathCount === 0 && applied.model.entities.length === 0) {
			return {
				errors: [...(applied.errors ?? []), "第一次提交没有存下任何内容：至少给一个接口，或一个写完整的业务实体。"],
			};
		}
		return applied.model ? { ...applied, model: this.accept(applied.model, input.note, opened) } : applied;
	}

	/** Store one submission in an open record. */
	submit(id: string, input: ApiModelSubmitInput, now = new Date()): ApiModelSubmitResult {
		const current = this.get(id);
		if (!current) return { errors: [`没有 id 为 ${id} 的业务建模记录。`] };
		const applied = applyDocument(current, input, now);
		return applied.model ? { ...applied, model: this.accept(applied.model, input.note) } : applied;
	}

	/** Open a record with the agent's first source submission. Nothing is stored when it is refused. */
	startSource(
		origin: ApiModelOrigin,
		input: SourceModelSubmitInput,
		options: { hostWorkDir: string; now?: Date },
	): SourceModelSubmitResult {
		const now = options.now ?? new Date();
		const opened = draft(origin, now);
		const applied = applySource(opened, input, options.hostWorkDir, now);
		return applied.ok ? { ...applied, model: this.accept(applied.model, input.note, opened) } : applied;
	}

	/** Store one source submission in an open record. */
	submitSource(
		id: string,
		input: SourceModelSubmitInput,
		options: { hostWorkDir: string; now?: Date },
	): SourceModelSubmitResult {
		const current = this.get(id);
		if (!current) return { ok: false, errors: [`没有 id 为 ${id} 的业务建模记录。`] };
		const applied = applySource(current, input, options.hostWorkDir, options.now ?? new Date());
		return applied.ok ? { ...applied, model: this.accept(applied.model, input.note) } : applied;
	}

	/**
	 * Write an accepted submission and log it. A record that is not in the
	 * database yet goes in empty first, so its audit trail starts where the
	 * record does: with nothing in it.
	 */
	private accept(model: SentinelApiModel, note: string | undefined, opened?: SentinelApiModel): SentinelApiModel {
		if (opened) {
			this.save(opened);
			this.recordEvent(opened.id, "created", opened.createdAt);
		}
		this.save(model);
		this.recordEvent(model.id, "submitted", model.updatedAt, note?.trim() || undefined);
		return this.get(model.id) as SentinelApiModel;
	}

	/** Write a record whole: a record that is not there yet is inserted, every later write replaces it where it stood. */
	private save(model: SentinelApiModel): void {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO api_models (id, project_id, session_id, session_path, title, target, source, status, openapi, entities, apis, logic, " +
					"path_count, operation_count, entity_count, api_count, state_machine_count, rule_count, submissions, error, created_at, updated_at, done_at) " +
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				model.id,
				model.projectId,
				model.sessionId,
				model.sessionPath,
				model.title,
				model.target,
				model.source,
				model.status,
				JSON.stringify(model.openapi),
				JSON.stringify(model.entities),
				JSON.stringify(model.apis),
				JSON.stringify(model.logic),
				model.pathCount,
				model.operationCount,
				model.entities.length,
				model.apis.length,
				model.logic.stateMachines.length,
				model.logic.rules.length,
				model.submissions,
				model.error ?? null,
				model.createdAt,
				model.updatedAt,
				model.doneAt,
			);
	}

	/**
	 * Close a run. Only the agent's own declaration and the operator's two ways
	 * out land here. A record that is already closed is handed back as it is:
	 * how a run ended is written once.
	 */
	finish(
		id: string,
		status: Exclude<SentinelApiModelStatus, "modeling">,
		options: { note?: string; error?: string } = {},
		now = new Date(),
	): SentinelApiModel | undefined {
		const current = this.get(id);
		if (!current || current.status !== "modeling") return current;
		const stamp = now.toISOString();
		this.db
			.prepare("UPDATE api_models SET status = ?, error = ?, updated_at = ?, done_at = ? WHERE id = ?")
			.run(status, options.error ?? null, stamp, stamp, id);
		this.recordEvent(id, status, stamp, options.note?.trim() || options.error);
		return this.get(id);
	}

	get(id: string): SentinelApiModel | undefined {
		const row = this.db.prepare("SELECT * FROM api_models WHERE id = ?").get(id) as unknown as
			| ApiModelRow
			| undefined;
		return row ? toModel(row) : undefined;
	}

	/** Records of one project (or every project when the filter is absent), newest first. */
	list(filters: SentinelApiModelFilters = {}): SentinelApiModelSummary[] {
		const conditions: string[] = [];
		const params: SqliteValue[] = [];
		if (filters.projectId) {
			conditions.push("project_id = ?");
			params.push(filters.projectId);
		}
		if (filters.status) {
			conditions.push("status = ?");
			params.push(filters.status);
		}
		if (filters.search?.trim()) {
			const needle = `%${filters.search.trim().toLowerCase()}%`;
			conditions.push("(LOWER(title) LIKE ? OR LOWER(target) LIKE ? OR LOWER(source) LIKE ?)");
			params.push(needle, needle, needle);
		}
		const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
		const rows = this.db
			.prepare(`SELECT ${SUMMARY_COLUMNS} FROM api_models${where} ORDER BY created_at DESC, id LIMIT 500`)
			.all(...params) as unknown as ApiModelSummaryRow[];
		return rows.map(toSummary);
	}

	/** The audit trail of one run, oldest first. */
	events(id: string): SentinelApiModelEvent[] {
		const rows = this.db
			.prepare(
				"SELECT at, kind, note, path_count, operation_count, entity_count, api_count, state_machine_count, rule_count FROM api_model_events WHERE model_id = ? ORDER BY id",
			)
			.all(id) as unknown as ApiModelEventRow[];
		return rows.map((row) => ({
			at: row.at,
			kind: row.kind as SentinelApiModelEvent["kind"],
			...(row.note ? { note: row.note } : {}),
			...(row.path_count !== null ? { pathCount: row.path_count } : {}),
			...(row.operation_count !== null ? { operationCount: row.operation_count } : {}),
			...(row.entity_count !== null ? { entityCount: row.entity_count } : {}),
			...(row.api_count !== null ? { apiCount: row.api_count } : {}),
			...(row.state_machine_count !== null ? { stateMachineCount: row.state_machine_count } : {}),
			...(row.rule_count !== null ? { ruleCount: row.rule_count } : {}),
		}));
	}

	delete(id: string): boolean {
		const row = this.db.prepare("SELECT 1 AS ok FROM api_models WHERE id = ?").get(id);
		if (!row) return false;
		this.db.prepare("DELETE FROM api_model_events WHERE model_id = ?").run(id);
		this.db.prepare("DELETE FROM api_models WHERE id = ?").run(id);
		return true;
	}

	/** Records a deleted project takes with it. Returns how many went away. */
	purgeProject(projectId: string): number {
		const rows = this.db.prepare("SELECT id FROM api_models WHERE project_id = ?").all(projectId) as unknown as {
			id: string;
		}[];
		for (const row of rows) this.delete(row.id);
		return rows.length;
	}

	countProject(projectId: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM api_models WHERE project_id = ?")
			.get(projectId) as unknown as {
			n: number;
		};
		return row?.n ?? 0;
	}

	private recordEvent(modelId: string, kind: SentinelApiModelEvent["kind"], at: string, note?: string): void {
		const row = this.db
			.prepare(
				"SELECT path_count, operation_count, entity_count, api_count, state_machine_count, rule_count FROM api_models WHERE id = ?",
			)
			.get(modelId) as unknown as
			| {
					path_count: number;
					operation_count: number;
					entity_count: number;
					api_count: number;
					state_machine_count: number;
					rule_count: number;
			  }
			| undefined;
		this.db
			.prepare(
				"INSERT INTO api_model_events (model_id, at, kind, note, path_count, operation_count, entity_count, api_count, state_machine_count, rule_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				modelId,
				at,
				kind,
				note ?? null,
				row?.path_count ?? null,
				row?.operation_count ?? null,
				row?.entity_count ?? null,
				row?.api_count ?? null,
				row?.state_machine_count ?? null,
				row?.rule_count ?? null,
			);
	}
}

export type ApiModelExportFormat = "json" | "yaml" | "record" | "markdown";

/** A file name that survives a download directory: ASCII slug plus the record id. */
export function apiModelExportName(model: SentinelApiModel, format: ApiModelExportFormat): string {
	const slug = (model.title || model.target || model.source || "api-model")
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	// The whole record is told from the interface document by its name.
	const suffix = format === "record" || format === "markdown" ? "record-" : "";
	const extension = format === "yaml" ? "yaml" : format === "markdown" ? "md" : "json";
	return `${slug || "api-model"}-${suffix}${model.id.slice(4, 12)}.${extension}`;
}

/**
 * The endpoint index of one document: one line per operation, sorted by path then
 * method. This is what the read tool's document listing shows — paths and
 * summaries only, no parameters or schemas.
 */
export function endpointsOf(doc: Record<string, unknown>): Array<{ method: string; path: string; summary: string }> {
	const paths = isPlainObject(doc.paths) ? doc.paths : {};
	const endpoints: Array<{ method: string; path: string; summary: string }> = [];
	for (const [path, item] of Object.entries(paths)) {
		if (!isPlainObject(item)) continue;
		for (const [key, value] of Object.entries(item)) {
			const method = key.toLowerCase();
			if (!(HTTP_METHODS as readonly string[]).includes(method) || !isPlainObject(value)) continue;
			const summary = typeof value.summary === "string" ? value.summary : "";
			const operationId = typeof value.operationId === "string" ? value.operationId : "";
			endpoints.push({ method, path, summary: summary || operationId });
		}
	}
	return endpoints.sort(
		(left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
	);
}

/** What the overview of a record says: its shape, enough to know what to ask for next. */
export function apiModelOverview(model: SentinelApiModel): Record<string, unknown> {
	return {
		id: model.id,
		title: model.title,
		target: model.target,
		source: model.source,
		status: model.status,
		counts: {
			paths: model.pathCount,
			operations: model.operationCount,
			entities: model.entities.length,
			apiMappings: model.apis.length,
			logicEntities: model.logic.entities.length,
			relations: model.logic.relations.length,
			stateMachines: model.logic.stateMachines.length,
			rules: model.logic.rules.length,
			apiDependencies: model.logic.apiDependencies.length,
		},
		modules: [...new Set(model.apis.map((api) => api.module ?? "").filter(Boolean))],
		entities: model.entities.map((entity) => entity.name),
		logicEntities: model.logic.entities.map((entity) => entity.name),
		stateMachines: model.logic.stateMachines.map((machine) => ({
			subject: machine.subject,
			field: machine.field ?? "",
			states: machine.states.map((state) => state.name),
		})),
	};
}

/** How deep local `$ref`s are followed when a path is read: a schema that refers to itself has to stop somewhere. */
const MAX_REF_DEPTH = 4;

/** The value with its local `$ref`s (`#/components/...`) replaced by what they point at. */
function dereference(value: unknown, doc: Record<string, unknown>, depth: number): unknown {
	if (Array.isArray(value)) return value.map((item) => dereference(item, doc, depth));
	if (!isPlainObject(value)) return value;
	const ref = value.$ref;
	if (typeof ref === "string" && ref.startsWith("#/") && depth < MAX_REF_DEPTH) {
		const target = ref
			.slice(2)
			.split("/")
			.reduce<unknown>((node, key) => (isPlainObject(node) ? node[key] : undefined), doc);
		if (isPlainObject(target)) return dereference(target, doc, depth + 1);
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) out[key] = dereference(item, doc, depth);
	return out;
}

/**
 * One page of a document's paths, by a search over each path and its path item.
 * Every `$ref` in the returned items is replaced by what it points at, so a
 * page answers on its own: parameters, request bodies and response schemas
 * included, with no second call to look up a schema.
 */
export function pagePathItems(
	doc: Record<string, unknown>,
	query: { search?: string; page: number; pageSize: number },
): { total: number; items: Array<{ path: string; item: unknown }> } {
	const paths = isPlainObject(doc.paths) ? doc.paths : {};
	const items = Object.entries(paths).map(([path, item]) => ({ path, item: dereference(item, doc, 0) }));
	return pageOf(items, query);
}

/**
 * The whole record as one document a person can read without the console: what
 * an auditor opens next to the target and the source. A part the record does not
 * have gets no section, so a record with only an interface document reads as it
 * always did.
 */
export function buildApiModelMarkdown(model: SentinelApiModel): string {
	const lines = [`# ${model.title}`, ""];
	if (model.target) lines.push(`- 流量目标：${model.target}`);
	if (model.source) lines.push(`- 源码范围：${model.source}`);
	lines.push(
		`- 接口：${model.pathCount} 个路径，${model.operationCount} 个操作`,
		`- 业务实体：${model.entities.length} 个`,
		`- 源码映射：${model.apis.length} 条`,
		`- 状态机：${model.logic.stateMachines.length} 个`,
		`- 业务规则：${model.logic.rules.length} 条`,
		"",
	);
	if (model.pathCount > 0) {
		lines.push("## 接口文档", "");
		const urls = (Array.isArray(model.openapi.servers) ? model.openapi.servers : []).flatMap((server) =>
			isPlainObject(server) && typeof server.url === "string" && server.url ? [server.url] : [],
		);
		if (urls.length > 0) lines.push(`服务地址：${urls.join("、")}`, "");
		lines.push("| 方法 | 路径 | 说明 |", "| --- | --- | --- |");
		for (const endpoint of endpointsOf(model.openapi)) {
			lines.push(
				`| ${endpoint.method.toUpperCase()} | ${tableCell(endpoint.path)} | ${tableCell(endpoint.summary)} |`,
			);
		}
		lines.push("");
	}
	if (model.entities.length > 0) {
		lines.push("## 业务实体", "");
		for (const entity of model.entities) {
			lines.push(`### ${entity.name}`, "");
			if (entity.description) lines.push(entity.description, "");
			const fields = entity.fields ?? [];
			if (fields.length > 0) {
				lines.push("| 字段 | 类型 | 说明 |", "| --- | --- | --- |");
				for (const field of fields) {
					lines.push(`| ${tableCell(field.name)} | ${tableCell(field.type)} | ${tableCell(field.description)} |`);
				}
				lines.push("");
			}
			for (const relation of entity.relations ?? []) {
				const kind = relation.kind ? `${relation.kind} ` : "";
				lines.push(`- 关系：${kind}${relation.target}${relation.description ? `：${relation.description}` : ""}`);
			}
			if ((entity.relations ?? []).length > 0) lines.push("");
		}
	}
	lines.push(...sourceModelSections(model.apis, model.logic));
	return lines.join("\n").trimEnd();
}

/** The record as a downloadable file. `json` and `yaml` are the interface document; the other two are the whole record. */
export function buildApiModelExport(
	model: SentinelApiModel,
	format: ApiModelExportFormat,
): { filename: string; text: string } {
	const record = {
		id: model.id,
		title: model.title,
		target: model.target,
		source: model.source,
		status: model.status,
		createdAt: model.createdAt,
		updatedAt: model.updatedAt,
		doneAt: model.doneAt,
		openapi: model.openapi,
		entities: model.entities,
		apis: model.apis,
		logic: model.logic,
	};
	const body =
		format === "yaml"
			? toYaml(model.openapi)
			: format === "markdown"
				? buildApiModelMarkdown(model)
				: `${JSON.stringify(format === "record" ? record : model.openapi, null, 2)}\n`;
	return { filename: apiModelExportName(model, format), text: body };
}
