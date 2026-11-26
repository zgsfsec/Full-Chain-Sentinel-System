/**
 * The source half of a business-modeling record: the endpoint mappings and the
 * business logic model the agent read out of a project's source.
 *
 * This module holds the pure half of the work — checking a submission, folding
 * it into what is already stored, paging it for the read tool, and laying it out
 * for the Markdown export. The record itself lives in `apimodels.ts`, which is
 * the only place that writes one.
 *
 * A submission is refused whole when any part of it is wrong: nothing is written,
 * and the reasons go back to the model. What is right is merged by key. An endpoint
 * replaces the mapping with the same method and path, and each list of the logic
 * model merges on its own key. That is what lets a large project arrive in batches
 * without one oversized answer, and lets a wrong item be corrected by sending it
 * again.
 *
 * The console does not check that a cited file or line exists. It puts every path
 * into its `/work/...` form and checks the shape of every location; whether the code
 * says what the model claims is for the operator to verify by reading it.
 */

import { toContainerWorkPath } from "./files.ts";
import type {
	SentinelApiModel,
	SentinelApiSourceMapping,
	SentinelBusinessLogicModel,
	SentinelCodeApiDependency,
	SentinelCodeAuthCheck,
	SentinelCodeCallStep,
	SentinelCodeDataAccess,
	SentinelCodeEntity,
	SentinelCodeExternalCall,
	SentinelCodeLocation,
	SentinelCodeRelation,
	SentinelCodeRule,
	SentinelCodeRuleKind,
	SentinelCodeStateMachine,
	SentinelCodeTransition,
} from "./protocol.ts";

/** Largest source half accepted, measured on the serialized JSON of both models. */
const MAX_MODEL_CHARS = 2 * 1024 * 1024;

/** What one call may carry. */
const MAX_APIS_PER_CALL = 50;
const MAX_LOGIC_ITEMS_PER_CALL = 100;

/** What one record may hold. A runaway guard, not a design limit. */
const MAX_APIS = 5_000;
const MAX_LOGIC_ENTITIES = 300;
const MAX_RELATIONS = 600;
const MAX_STATE_MACHINES = 100;
const MAX_RULES = 1_000;
const MAX_API_DEPENDENCIES = 1_000;

/** What one item may hold. */
const MAX_STEPS_PER_API = 100;
const MAX_COLUMNS = 200;
const MAX_FIELDS_PER_ENTITY = 200;
const MAX_STATES = 100;
const MAX_TRANSITIONS = 500;
const MAX_APIS_PER_RULE = 50;

/** Longest values kept, in characters. */
const MAX_NAME = 200;
const MAX_PATH = 512;
const MAX_KIND = 60;
const MAX_TEXT = 2000;
const MAX_STATEMENT = 4000;
const MAX_COLUMN = 128;
const MAX_RULE_ID = 80;
const MAX_SOURCE = 200;
const MAX_LINE = 20_000_000;
const MAX_LINE_SPAN = 10_000;

/** The most problems one refusal lists; the rest are counted. */
const MAX_PROBLEMS = 50;

const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "ANY"] as const;
const CALL_LAYERS = ["service", "repository", "util", "middleware", "other"] as const;
const AUTH_KINDS = ["authentication", "authorization", "ownership", "other"] as const;
const EXTERNAL_KINDS = ["http", "rpc", "mq", "cache", "file", "other"] as const;
const RULE_KINDS = ["precondition", "postcondition", "invariant", "ownership"] as const;
const DEPENDENCY_KINDS = ["calls", "requires", "triggers", "mutates", "other"] as const;
const LOGIC_SECTIONS = ["entities", "relations", "stateMachines", "rules", "apiDependencies"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Why a submission was refused, phrased for the model that has to fix it. The
 * list is capped: a submission that is wrong in a hundred places gets the first
 * fifty and a count, which is an answer a model can act on.
 */
export class Problems {
	private readonly items: string[] = [];
	private dropped = 0;

	add(message: string): void {
		if (this.items.length < MAX_PROBLEMS) this.items.push(message);
		else this.dropped++;
	}

	get length(): number {
		return this.items.length + this.dropped;
	}

	list(): string[] {
		return this.dropped > 0
			? [...this.items, `另有 ${this.dropped} 处问题未列出：改完以上几类后重新提交，会看到剩下的。`]
			: [...this.items];
	}
}

function text(
	value: unknown,
	where: string,
	field: string,
	problems: Problems,
	max: number,
	required = false,
): string | undefined {
	if (value === undefined) {
		if (required) problems.add(`${where} 缺少 ${field}。`);
		return required ? undefined : "";
	}
	if (typeof value !== "string") {
		problems.add(`${where} 的 ${field} 必须是字符串。`);
		return undefined;
	}
	const trimmed = value.trim();
	if (required && !trimmed) {
		problems.add(`${where} 的 ${field} 不能为空。`);
		return undefined;
	}
	if (trimmed.length > max) {
		problems.add(`${where} 的 ${field} 超过 ${max} 个字符。`);
		return undefined;
	}
	return trimmed;
}

function oneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
	where: string,
	field: string,
	problems: Problems,
): T | undefined {
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		problems.add(`${where} 的 ${field} 必须是：${allowed.join(" / ")}。`);
		return undefined;
	}
	return value as T;
}

function requiredArray(raw: unknown, where: string, problems: Problems, max: number): unknown[] | undefined {
	if (!Array.isArray(raw)) {
		problems.add(`${where} 必须是数组（没有内容时给空数组）。`);
		return undefined;
	}
	if (raw.length > max) {
		problems.add(`${where} 超过 ${max} 项。`);
		return undefined;
	}
	return raw;
}

/** A route as declared: it has to start with a slash and carry no whitespace. */
export function normalizeRoute(value: string): string {
	const trimmed = value.trim();
	if (!trimmed.startsWith("/") || /\s/.test(trimmed)) return "";
	return trimmed.length > MAX_PATH ? "" : trimmed;
}

/**
 * One location as it is stored. The path is put into its `/work/...` form, which
 * is the only transformation: whether the file exists and says what is claimed
 * is not checked here.
 */
export function normalizeLocation(
	raw: unknown,
	where: string,
	hostWorkDir: string,
	problems: Problems,
): SentinelCodeLocation | undefined {
	if (!isPlainObject(raw)) {
		problems.add(`${where} 缺少位置（需要 file 和 line）。`);
		return undefined;
	}
	const before = problems.length;
	let file: string | undefined;
	if (typeof raw.file !== "string") problems.add(`${where} 的 file 必须是字符串。`);
	else {
		// Source paths are written with forward slashes whatever the host writes.
		file = toContainerWorkPath(raw.file.replace(/\\/g, "/"), hostWorkDir);
		if (!file) problems.add(`${where} 的 file 无效：必须是项目工作目录里的文件，写成相对路径或 /work/... 。`);
		else if (file === "/work") problems.add(`${where} 的 file 指向的是目录，要写到具体文件。`);
	}
	const line = raw.line;
	if (!Number.isSafeInteger(line) || (line as number) < 1 || (line as number) > MAX_LINE)
		problems.add(`${where} 的 line 必须是从 1 开始的行号。`);
	const endLine = raw.endLine;
	if (
		endLine !== undefined &&
		(!Number.isSafeInteger(endLine) ||
			(endLine as number) < (line as number) ||
			(endLine as number) - (line as number) > MAX_LINE_SPAN)
	)
		problems.add(`${where} 的 endLine 必须是不小于 line 的行号。`);
	return problems.length > before
		? undefined
		: {
				file: file as string,
				line: line as number,
				...(endLine !== undefined ? { endLine: endLine as number } : {}),
			};
}

/** The locations of one claim. There has to be at least one: a claim without a place is not kept. */
function normalizeLocations(
	raw: unknown,
	where: string,
	hostWorkDir: string,
	problems: Problems,
): SentinelCodeLocation[] | undefined {
	if (!Array.isArray(raw)) {
		problems.add(`${where} 的 locations 必须是数组。`);
		return undefined;
	}
	if (raw.length === 0) {
		problems.add(`${where} 的 locations 不能为空：每条结论至少要有一个代码位置。`);
		return undefined;
	}
	const locations: SentinelCodeLocation[] = [];
	for (const [index, item] of raw.entries()) {
		const location = normalizeLocation(item, `${where}.locations[${index}]`, hostWorkDir, problems);
		if (location) locations.push(location);
	}
	return locations.length > 0 ? locations : undefined;
}

function normalizeColumns(raw: unknown, where: string, problems: Problems): string[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		problems.add(`${where} 的 columns 必须是数组。`);
		return undefined;
	}
	const columns: string[] = [];
	for (const [index, item] of raw.entries()) {
		const at = `${where}.columns[${index}]`;
		if (typeof item !== "string" || !item.trim()) problems.add(`${at} 必须是非空的字段名。`);
		else if (item.trim().length > MAX_COLUMN) problems.add(`${at} 超过 ${MAX_COLUMN} 个字符。`);
		else if (!columns.includes(item.trim())) columns.push(item.trim());
	}
	if (columns.length > MAX_COLUMNS) {
		problems.add(`${where} 的 columns 超过 ${MAX_COLUMNS} 个。`);
		return undefined;
	}
	return columns.length > 0 ? columns : undefined;
}

/** One endpoint as it is stored, or undefined when any part of it is wrong. */
export function normalizeApiMapping(
	raw: unknown,
	index: number,
	hostWorkDir: string,
	problems: Problems,
): SentinelApiSourceMapping | undefined {
	const where = `apis[${index}]`;
	if (!isPlainObject(raw)) {
		problems.add(`${where} 不是对象。`);
		return undefined;
	}
	const before = problems.length;
	const method = typeof raw.method === "string" ? raw.method.trim().toUpperCase() : "";
	if (!(API_METHODS as readonly string[]).includes(method))
		problems.add(`${where} 的 method 必须是：${API_METHODS.join(" / ")}。`);
	const path = typeof raw.path === "string" ? normalizeRoute(raw.path) : "";
	if (!path) {
		problems.add(
			`${where} 的 path 必须是以 / 开头的路由（保留占位符，不含空白），例如 /api/orders/{id}，最长 ${MAX_PATH} 个字符。`,
		);
	}
	let handler: SentinelApiSourceMapping["handler"] | undefined;
	if (!isPlainObject(raw.handler)) problems.add(`${where} 缺少 handler（入口函数名和它的位置）。`);
	else {
		const name = text(raw.handler.name, `${where}.handler`, "name", problems, MAX_NAME, true);
		const location = normalizeLocation(raw.handler.location, `${where}.handler`, hostWorkDir, problems);
		if (name !== undefined && location) handler = { name, location };
	}
	const callChain: SentinelCodeCallStep[] = [];
	for (const [step, item] of (
		requiredArray(raw.callChain, `${where}.callChain`, problems, MAX_STEPS_PER_API) ?? []
	).entries()) {
		const at = `${where}.callChain[${step}]`;
		if (!isPlainObject(item)) {
			problems.add(`${at} 不是对象。`);
			continue;
		}
		const start = problems.length;
		const layer = oneOf(item.layer, CALL_LAYERS, at, "layer", problems);
		const name = text(item.name, at, "name", problems, MAX_NAME, true);
		const location = normalizeLocation(item.location, at, hostWorkDir, problems);
		const note = text(item.note, at, "note", problems, MAX_TEXT);
		if (problems.length === start)
			callChain.push({
				layer: layer as SentinelCodeCallStep["layer"],
				name: name as string,
				location: location as SentinelCodeLocation,
				...(note ? { note } : {}),
			});
	}
	const dataAccess: SentinelCodeDataAccess[] = [];
	for (const [access, item] of (
		requiredArray(raw.dataAccess, `${where}.dataAccess`, problems, MAX_STEPS_PER_API) ?? []
	).entries()) {
		const at = `${where}.dataAccess[${access}]`;
		if (!isPlainObject(item)) {
			problems.add(`${at} 不是对象。`);
			continue;
		}
		const start = problems.length;
		const operation = oneOf(item.operation, ["read", "write"] as const, at, "operation", problems);
		const table = text(item.table, at, "table", problems, MAX_NAME, true);
		const columns = normalizeColumns(item.columns, at, problems);
		const via = text(item.via, at, "via", problems, MAX_NAME);
		const location = normalizeLocation(item.location, at, hostWorkDir, problems);
		if (problems.length === start)
			dataAccess.push({
				operation: operation as SentinelCodeDataAccess["operation"],
				table: table as string,
				location: location as SentinelCodeLocation,
				...(columns ? { columns } : {}),
				...(via ? { via } : {}),
			});
	}
	const authChecks: SentinelCodeAuthCheck[] = [];
	for (const [check, item] of (
		requiredArray(raw.authChecks, `${where}.authChecks`, problems, MAX_STEPS_PER_API) ?? []
	).entries()) {
		const at = `${where}.authChecks[${check}]`;
		if (!isPlainObject(item)) {
			problems.add(`${at} 不是对象。`);
			continue;
		}
		const start = problems.length;
		const kind = oneOf(item.kind, AUTH_KINDS, at, "kind", problems);
		const note = text(item.note, at, "note", problems, MAX_TEXT);
		const location = normalizeLocation(item.location, at, hostWorkDir, problems);
		if (problems.length === start)
			authChecks.push({
				kind: kind as SentinelCodeAuthCheck["kind"],
				location: location as SentinelCodeLocation,
				...(note ? { note } : {}),
			});
	}
	const externalCalls: SentinelCodeExternalCall[] = [];
	for (const [call, item] of (
		requiredArray(raw.externalCalls, `${where}.externalCalls`, problems, MAX_STEPS_PER_API) ?? []
	).entries()) {
		const at = `${where}.externalCalls[${call}]`;
		if (!isPlainObject(item)) {
			problems.add(`${at} 不是对象。`);
			continue;
		}
		const start = problems.length;
		const kind = oneOf(item.kind, EXTERNAL_KINDS, at, "kind", problems);
		const target = text(item.target, at, "target", problems, MAX_TEXT, true);
		const note = text(item.note, at, "note", problems, MAX_TEXT);
		const location = normalizeLocation(item.location, at, hostWorkDir, problems);
		if (problems.length === start)
			externalCalls.push({
				kind: kind as SentinelCodeExternalCall["kind"],
				target: target as string,
				location: location as SentinelCodeLocation,
				...(note ? { note } : {}),
			});
	}
	const module = text(raw.module, where, "module", problems, MAX_NAME);
	const summary = text(raw.summary, where, "summary", problems, MAX_TEXT);
	const confidence =
		raw.confidence === undefined
			? undefined
			: oneOf(raw.confidence, ["verified", "inferred"] as const, where, "confidence", problems);
	const notes = text(raw.notes, where, "notes", problems, MAX_TEXT);
	if (problems.length > before) return undefined;
	return {
		method,
		path,
		handler: handler as NonNullable<typeof handler>,
		callChain,
		dataAccess,
		authChecks,
		externalCalls,
		...(module ? { module } : {}),
		...(summary ? { summary } : {}),
		...(confidence ? { confidence } : {}),
		...(notes ? { notes } : {}),
	};
}

/** The names of a state machine's states, which its transitions and its initial state have to come from. */
function stateNames(raw: unknown, where: string, problems: Problems): string[] | undefined {
	const states = requiredArray(raw, where, problems, MAX_STATES);
	if (!states) return undefined;
	if (states.length === 0) {
		problems.add(`${where} 至少要有一个状态。`);
		return undefined;
	}
	const names: string[] = [];
	states.forEach((item, index) => {
		const at = `${where}[${index}]`;
		if (!isPlainObject(item)) {
			problems.add(`${at} 不是对象。`);
			return;
		}
		const name = text(item.name, at, "name", problems, MAX_NAME, true);
		if (name === undefined) return;
		if (names.includes(name)) problems.add(`${at} 的状态「${name}」重复声明了。`);
		else names.push(name);
	});
	return names.length > 0 ? names : undefined;
}

function normalizeEntity(
	raw: unknown,
	index: number,
	hostWorkDir: string,
	problems: Problems,
): SentinelCodeEntity | undefined {
	const where = `entities[${index}]`;
	if (!isPlainObject(raw)) {
		problems.add(`${where} 不是对象。`);
		return undefined;
	}
	const before = problems.length;
	const name = text(raw.name, where, "name", problems, MAX_NAME, true);
	const description = text(raw.description, where, "description", problems, MAX_TEXT);
	const table = text(raw.table, where, "table", problems, MAX_NAME);
	const owner = text(raw.owner, where, "owner", problems, MAX_NAME);
	const locations = normalizeLocations(raw.locations, where, hostWorkDir, problems);
	const fields: SentinelCodeEntity["fields"] = [];
	if (raw.fields !== undefined) {
		for (const [field, item] of (
			requiredArray(raw.fields, `${where}.fields`, problems, MAX_FIELDS_PER_ENTITY) ?? []
		).entries()) {
			const at = `${where}.fields[${field}]`;
			if (!isPlainObject(item)) {
				problems.add(`${at} 不是对象。`);
				continue;
			}
			const start = problems.length;
			const fieldName = text(item.name, at, "name", problems, MAX_COLUMN, true);
			const meaning = text(item.meaning, at, "meaning", problems, MAX_TEXT);
			if (problems.length === start) fields.push({ name: fieldName as string, ...(meaning ? { meaning } : {}) });
		}
	}
	if (problems.length > before) return undefined;
	return {
		name: name as string,
		locations: locations as SentinelCodeLocation[],
		...(description ? { description } : {}),
		...(table ? { table } : {}),
		...(owner ? { owner } : {}),
		...(fields.length > 0 ? { fields } : {}),
	};
}

function normalizeRelation(
	raw: unknown,
	index: number,
	hostWorkDir: string,
	problems: Problems,
): SentinelCodeRelation | undefined {
	const where = `relations[${index}]`;
	if (!isPlainObject(raw)) {
		problems.add(`${where} 不是对象。`);
		return undefined;
	}
	const before = problems.length;
	const from = text(raw.from, where, "from", problems, MAX_NAME, true);
	const to = text(raw.to, where, "to", problems, MAX_NAME, true);
	const kind = text(raw.kind, where, "kind", problems, MAX_KIND, true);
	const description = text(raw.description, where, "description", problems, MAX_TEXT);
	const locations = normalizeLocations(raw.locations, where, hostWorkDir, problems);
	if (problems.length > before) return undefined;
	return {
		from: from as string,
		to: to as string,
		kind: kind as string,
		locations: locations as SentinelCodeLocation[],
		...(description ? { description } : {}),
	};
}

function normalizeStateMachine(
	raw: unknown,
	index: number,
	hostWorkDir: string,
	problems: Problems,
): SentinelCodeStateMachine | undefined {
	const where = `stateMachines[${index}]`;
	if (!isPlainObject(raw)) {
		problems.add(`${where} 不是对象。`);
		return undefined;
	}
	const before = problems.length;
	const subject = text(raw.subject, where, "subject", problems, MAX_NAME, true);
	const field = text(raw.field, where, "field", problems, MAX_COLUMN);
	const description = text(raw.description, where, "description", problems, MAX_TEXT);
	const locations = normalizeLocations(raw.locations, where, hostWorkDir, problems);
	const names = stateNames(raw.states, `${where}.states`, problems);
	const states: SentinelCodeStateMachine["states"] = [];
	for (const [state, item] of (Array.isArray(raw.states) ? raw.states : []).entries()) {
		if (!isPlainObject(item)) continue;
		const meaning = text(item.meaning, `${where}.states[${state}]`, "meaning", problems, MAX_TEXT);
		if (typeof item.name === "string") states.push({ name: item.name.trim(), ...(meaning ? { meaning } : {}) });
	}
	const transitions: SentinelCodeTransition[] = [];
	for (const [transition, item] of (
		requiredArray(raw.transitions, `${where}.transitions`, problems, MAX_TRANSITIONS) ?? []
	).entries()) {
		const at = `${where}.transitions[${transition}]`;
		if (!isPlainObject(item)) {
			problems.add(`${at} 不是对象。`);
			continue;
		}
		const start = problems.length;
		const from = text(item.from, at, "from", problems, MAX_NAME, true);
		const to = text(item.to, at, "to", problems, MAX_NAME, true);
		for (const [end, value] of [
			["from", from],
			["to", to],
		] as const)
			if (value !== undefined && names && !names.includes(value))
				problems.add(`${at} 的 ${end}「${value}」不是这个状态机里声明过的状态。`);
		const trigger = text(item.trigger, at, "trigger", problems, MAX_PATH);
		const guard = text(item.guard, at, "guard", problems, MAX_STATEMENT);
		const effect = text(item.effect, at, "effect", problems, MAX_STATEMENT);
		const transitionLocations = normalizeLocations(item.locations, at, hostWorkDir, problems);
		if (problems.length === start)
			transitions.push({
				from: from as string,
				to: to as string,
				locations: transitionLocations as SentinelCodeLocation[],
				...(trigger ? { trigger } : {}),
				...(guard ? { guard } : {}),
				...(effect ? { effect } : {}),
			});
	}
	const initial = text(raw.initial, where, "initial", problems, MAX_NAME);
	if (initial && names && !names.includes(initial))
		problems.add(`${where} 的 initial「${initial}」不是这个状态机里声明过的状态。`);
	if (problems.length > before) return undefined;
	return {
		subject: subject as string,
		states,
		transitions,
		locations: locations as SentinelCodeLocation[],
		...(field ? { field } : {}),
		...(description ? { description } : {}),
		...(initial ? { initial } : {}),
	};
}

function normalizeRule(
	raw: unknown,
	index: number,
	hostWorkDir: string,
	problems: Problems,
): SentinelCodeRule | undefined {
	const where = `rules[${index}]`;
	if (!isPlainObject(raw)) {
		problems.add(`${where} 不是对象。`);
		return undefined;
	}
	const before = problems.length;
	const id = text(raw.id, where, "id", problems, MAX_RULE_ID, true);
	if (id && !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id))
		problems.add(`${where} 的 id 只能包含字母、数字和 _ . : -，并且以字母或数字开头。`);
	const kind = oneOf(raw.kind, RULE_KINDS, where, "kind", problems);
	const subject = text(raw.subject, where, "subject", problems, MAX_NAME, true);
	const statement = text(raw.statement, where, "statement", problems, MAX_STATEMENT, true);
	const note = text(raw.note, where, "note", problems, MAX_TEXT);
	const locations = normalizeLocations(raw.locations, where, hostWorkDir, problems);
	const apis: string[] = [];
	if (raw.apis !== undefined) {
		for (const [api, item] of (
			requiredArray(raw.apis, `${where}.apis`, problems, MAX_APIS_PER_RULE) ?? []
		).entries()) {
			const reference = text(item, `${where}.apis[${api}]`, "", problems, MAX_PATH, true);
			if (reference && !apis.includes(reference)) apis.push(reference);
		}
	}
	if (problems.length > before) return undefined;
	return {
		id: id as string,
		kind: kind as SentinelCodeRuleKind,
		subject: subject as string,
		statement: statement as string,
		locations: locations as SentinelCodeLocation[],
		...(apis.length > 0 ? { apis } : {}),
		...(note ? { note } : {}),
	};
}

function normalizeDependency(
	raw: unknown,
	index: number,
	hostWorkDir: string,
	problems: Problems,
): SentinelCodeApiDependency | undefined {
	const where = `apiDependencies[${index}]`;
	if (!isPlainObject(raw)) {
		problems.add(`${where} 不是对象。`);
		return undefined;
	}
	const before = problems.length;
	const from = text(raw.from, where, "from", problems, MAX_PATH, true);
	const to = text(raw.to, where, "to", problems, MAX_PATH, true);
	const kind = oneOf(raw.kind, DEPENDENCY_KINDS, where, "kind", problems);
	const description = text(raw.description, where, "description", problems, MAX_TEXT);
	const locations = normalizeLocations(raw.locations, where, hostWorkDir, problems);
	if (problems.length > before) return undefined;
	return {
		from: from as string,
		to: to as string,
		kind: kind as SentinelCodeApiDependency["kind"],
		locations: locations as SentinelCodeLocation[],
		...(description ? { description } : {}),
	};
}

/** What one call of the source submit tool may carry, in the shape the tool receives it. */
export interface SourceModelSubmitInput {
	apis?: unknown;
	entities?: unknown;
	relations?: unknown;
	stateMachines?: unknown;
	rules?: unknown;
	apiDependencies?: unknown;
	/** The part of the source that was read: a repository or a directory. */
	source?: string;
	title?: string;
	note?: string;
}

/** The record as the submission left it, or the reasons it was refused. */
export type SourceModelSubmitResult =
	| { ok: true; model: SentinelApiModel; warnings: string[] }
	| { ok: false; errors: string[] };

/**
 * The submitted lists as they would be stored, or the reasons the submission is
 * refused. A list the call did not name is absent from the patch, which is what
 * leaves the stored one alone.
 */
export function normalizeSourceSubmission(
	input: SourceModelSubmitInput,
	hostWorkDir: string,
):
	| { apis: SentinelApiSourceMapping[]; patch: Partial<SentinelBusinessLogicModel>; source: string }
	| { errors: string[] } {
	if (input.apis === undefined && LOGIC_SECTIONS.every((section) => input[section] === undefined))
		return { errors: ["提交里没有任何内容：至少给 apis 或业务逻辑模型的某一张表。"] };

	const problems = new Problems();
	const apis =
		input.apis === undefined
			? []
			: (requiredArray(input.apis, "apis", problems, MAX_APIS_PER_CALL) ?? []).map((item, index) =>
					normalizeApiMapping(item, index, hostWorkDir, problems),
				);
	const patch: Partial<SentinelBusinessLogicModel> = {};
	/** The list a call named, or undefined when it is not a list of a reasonable size. */
	const named = (raw: unknown, section: string): unknown[] | undefined => {
		if (!Array.isArray(raw)) {
			problems.add(`${section} 必须是数组。`);
			return undefined;
		}
		if (raw.length > MAX_LOGIC_ITEMS_PER_CALL) {
			problems.add(`${section} 超过 ${MAX_LOGIC_ITEMS_PER_CALL} 项：请分批提交。`);
			return undefined;
		}
		return raw;
	};
	const keep = <T>(item: T | undefined): item is T => item !== undefined;
	const entityList = input.entities === undefined ? undefined : named(input.entities, "entities");
	if (entityList)
		patch.entities = entityList
			.map((item, index) => normalizeEntity(item, index, hostWorkDir, problems))
			.filter(keep);
	const relationList = input.relations === undefined ? undefined : named(input.relations, "relations");
	if (relationList)
		patch.relations = relationList
			.map((item, index) => normalizeRelation(item, index, hostWorkDir, problems))
			.filter(keep);
	const machineList = input.stateMachines === undefined ? undefined : named(input.stateMachines, "stateMachines");
	if (machineList)
		patch.stateMachines = machineList
			.map((item, index) => normalizeStateMachine(item, index, hostWorkDir, problems))
			.filter(keep);
	const ruleList = input.rules === undefined ? undefined : named(input.rules, "rules");
	if (ruleList)
		patch.rules = ruleList.map((item, index) => normalizeRule(item, index, hostWorkDir, problems)).filter(keep);
	const dependencyList =
		input.apiDependencies === undefined ? undefined : named(input.apiDependencies, "apiDependencies");
	if (dependencyList)
		patch.apiDependencies = dependencyList
			.map((item, index) => normalizeDependency(item, index, hostWorkDir, problems))
			.filter(keep);
	if (problems.length > 0) return { errors: problems.list() };
	return {
		apis: apis.filter((item): item is SentinelApiSourceMapping => item !== undefined),
		patch,
		source: input.source?.trim().slice(0, MAX_SOURCE) ?? "",
	};
}

/** The key an endpoint is stored and replaced under. */
export function apiMappingKey(api: { method: string; path: string }): string {
	return `${api.method} ${api.path}`;
}

function upsert<T>(base: readonly T[], incoming: readonly T[], keyOf: (item: T) => string): T[] {
	const next = [...base];
	const index = new Map(next.map((item, at) => [keyOf(item), at]));
	for (const item of incoming) {
		const at = index.get(keyOf(item));
		if (at === undefined) {
			index.set(keyOf(item), next.length);
			next.push(item);
		} else next[at] = item;
	}
	return next;
}

/** Fold submitted endpoints into the stored ones: one with a known key replaces that one where it stood. */
export function mergeApiMappings(
	base: readonly SentinelApiSourceMapping[],
	incoming: readonly SentinelApiSourceMapping[],
): SentinelApiSourceMapping[] {
	return upsert(base, incoming, apiMappingKey);
}

/** A logic model with nothing in it yet. */
export function emptyLogic(): SentinelBusinessLogicModel {
	return { entities: [], relations: [], stateMachines: [], rules: [], apiDependencies: [] };
}

/** Fold the submitted lists into the stored model; a list the call did not name is left as it was. */
export function mergeLogic(
	base: SentinelBusinessLogicModel,
	patch: Partial<SentinelBusinessLogicModel>,
): SentinelBusinessLogicModel {
	return {
		entities: patch.entities ? upsert(base.entities, patch.entities, (item) => item.name) : base.entities,
		relations: patch.relations
			? upsert(base.relations, patch.relations, (item) => `${item.from}\u0000${item.to}\u0000${item.kind}`)
			: base.relations,
		stateMachines: patch.stateMachines
			? upsert(base.stateMachines, patch.stateMachines, (item) => item.subject)
			: base.stateMachines,
		rules: patch.rules ? upsert(base.rules, patch.rules, (item) => item.id) : base.rules,
		apiDependencies: patch.apiDependencies
			? upsert(
					base.apiDependencies,
					patch.apiDependencies,
					(item) => `${item.from}\u0000${item.to}\u0000${item.kind}`,
				)
			: base.apiDependencies,
	};
}

/** How many items each list of the source half holds. */
export interface SourceModelCounts {
	apiCount: number;
	entityCount: number;
	relationCount: number;
	stateMachineCount: number;
	ruleCount: number;
	apiDependencyCount: number;
}

export function countsOf(
	apis: readonly SentinelApiSourceMapping[],
	logic: SentinelBusinessLogicModel,
): SourceModelCounts {
	return {
		apiCount: apis.length,
		entityCount: logic.entities.length,
		relationCount: logic.relations.length,
		stateMachineCount: logic.stateMachines.length,
		ruleCount: logic.rules.length,
		apiDependencyCount: logic.apiDependencies.length,
	};
}

/**
 * The runaway guards on a merged source half: the first limit it exceeds, as a
 * message for the model, or undefined when it fits.
 */
export function sourceOverflow(
	apis: readonly SentinelApiSourceMapping[],
	logic: SentinelBusinessLogicModel,
): string | undefined {
	const counts = countsOf(apis, logic);
	const over = [
		["接口映射", counts.apiCount, MAX_APIS],
		["业务实体", counts.entityCount, MAX_LOGIC_ENTITIES],
		["实体关系", counts.relationCount, MAX_RELATIONS],
		["状态机", counts.stateMachineCount, MAX_STATE_MACHINES],
		["业务规则", counts.ruleCount, MAX_RULES],
		["跨接口依赖", counts.apiDependencyCount, MAX_API_DEPENDENCIES],
	].find(([, count, max]) => count > max);
	if (over) {
		return `${over[0]}数量 ${over[1]} 超过上限 ${over[2]}：请只保留核实过的内容，或分几次业务建模来做。`;
	}
	const size = JSON.stringify(apis).length + JSON.stringify(logic).length;
	if (size > MAX_MODEL_CHARS) {
		return `模型过大（${Math.round(size / 1024)}KB，上限 ${Math.round(MAX_MODEL_CHARS / 1024)}KB）：请精简描述，或只保留核实过的内容。`;
	}
	return undefined;
}

/** `post /a/b/` and `POST /a/b/` name the same endpoint as far as references go. */
function referenceKey(reference: string): string {
	const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(reference);
	return match ? `${match[1].toUpperCase()} ${match[2]}` : reference.trim();
}

/**
 * References the model makes to things it has not submitted: a relation to an
 * entity that is not there, a rule or a dependency naming an endpoint without a
 * mapping. Reported, not refused: the missing part may be the next batch.
 */
export function danglingReferences(
	apis: readonly SentinelApiSourceMapping[],
	logic: SentinelBusinessLogicModel,
): string[] {
	const warnings: string[] = [];
	const entities = new Set(logic.entities.map((entity) => entity.name));
	const missingEntities = [
		...new Set(
			logic.relations.flatMap((relation) => [relation.from, relation.to]).filter((name) => !entities.has(name)),
		),
	];
	if (missingEntities.length > 0)
		warnings.push(
			`关系引用了 ${missingEntities.length} 个尚未提交的实体：${missingEntities.slice(0, 5).join("、")}${missingEntities.length > 5 ? " 等" : ""}。`,
		);
	if (apis.length > 0) {
		const known = new Set(apis.map(apiMappingKey));
		const missingApis = [
			...new Set(
				[
					...logic.rules.flatMap((rule) => rule.apis ?? []),
					...logic.apiDependencies.flatMap((dependency) => [dependency.from, dependency.to]),
					...logic.stateMachines.flatMap((machine) =>
						machine.transitions.flatMap((transition) => transition.trigger ?? []),
					),
				].filter((reference) => reference !== "" && !known.has(referenceKey(reference))),
			),
		];
		if (missingApis.length > 0)
			warnings.push(
				`规则、依赖或状态迁移引用了 ${missingApis.length} 个没有源码映射的接口：${missingApis.slice(0, 5).join("、")}${missingApis.length > 5 ? " 等" : ""}。`,
			);
	}
	return warnings;
}

/** A location as text, the way the operator and the model both read it. */
export function formatCodeLocation(location: SentinelCodeLocation): string {
	return `${location.file}:${location.line}${location.endLine !== undefined ? `-${location.endLine}` : ""}`;
}

/** A table cell that cannot break the table: pipes are escaped, line ends become spaces. */
export function tableCell(value: string | undefined): string {
	return (value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

const RULE_LABELS: Record<SentinelCodeRuleKind, string> = {
	precondition: "前置条件",
	postcondition: "后置条件",
	invariant: "业务不变量",
	ownership: "资源所有权",
};

const DEPENDENCY_LABELS: Record<SentinelCodeApiDependency["kind"], string> = {
	calls: "调用",
	requires: "依赖",
	triggers: "触发",
	mutates: "修改",
	other: "其他",
};

/**
 * The source half as Markdown sections, for the record's export. A section is
 * written only when it has something in it, so a record without a state machine
 * does not end in a page of「（无）」.
 */
export function sourceModelSections(
	apis: readonly SentinelApiSourceMapping[],
	logic: SentinelBusinessLogicModel,
): string[] {
	const lines: string[] = [];
	const places = (locations: SentinelCodeLocation[]) => locations.map(formatCodeLocation).join("、");
	if (apis.length > 0) {
		lines.push("## API 源码映射", "");
		for (const api of apis) {
			lines.push(`### ${api.method} ${api.path}${api.summary ? `：${api.summary}` : ""}`, "");
			// The separator goes between two parts, so a verified mapping does not end with a dangling one.
			const parts = [
				api.module ? `模块：${api.module}` : "",
				api.confidence === "inferred" ? "部分内容为推断" : "",
			].filter((part) => part !== "");
			if (parts.length > 0) lines.push(parts.join("；"), "");
			lines.push(`- 入口：\`${api.handler.name}\`（${formatCodeLocation(api.handler.location)}）`);
			lines.push(api.callChain.length > 0 ? "- 调用链：" : "- 调用链：无更深调用");
			api.callChain.forEach((step, index) => {
				lines.push(
					`  ${index + 1}. [${step.layer}] \`${step.name}\`（${formatCodeLocation(step.location)}）${step.note ? `：${step.note}` : ""}`,
				);
			});
			if (api.dataAccess.length > 0) {
				lines.push("- 数据访问：");
				for (const access of api.dataAccess)
					lines.push(
						`  - ${access.operation === "write" ? "写" : "读"} \`${access.table}\`${access.columns ? `（${access.columns.join(", ")}）` : ""}（${formatCodeLocation(access.location)}）`,
					);
			}
			lines.push(api.authChecks.length > 0 ? "- 权限校验：" : "- 权限校验：未发现");
			for (const check of api.authChecks)
				lines.push(
					`  - ${check.kind}${check.note ? `：${check.note}` : ""}（${formatCodeLocation(check.location)}）`,
				);
			if (api.externalCalls.length > 0) {
				lines.push("- 外部调用：");
				for (const call of api.externalCalls)
					lines.push(
						`  - [${call.kind}] ${call.target}（${formatCodeLocation(call.location)}）${call.note ? `：${call.note}` : ""}`,
					);
			}
			if (api.notes) lines.push(`- 备注：${api.notes}`);
			lines.push("");
		}
	}
	if (logic.entities.length > 0) {
		lines.push("## 源码实体", "");
		lines.push("| 实体 | 表 | 归属 | 说明 | 位置 |", "| --- | --- | --- | --- | --- |");
		for (const entity of logic.entities)
			lines.push(
				`| ${tableCell(entity.name)} | ${tableCell(entity.table)} | ${tableCell(entity.owner)} | ${tableCell(entity.description)} | ${tableCell(places(entity.locations))} |`,
			);
		lines.push("");
	}
	if (logic.relations.length > 0) {
		lines.push("## 实体关系", "");
		lines.push("| 起点 | 关系 | 终点 | 说明 | 位置 |", "| --- | --- | --- | --- | --- | --- |");
		for (const relation of logic.relations)
			lines.push(
				`| ${tableCell(relation.from)} | ${tableCell(relation.kind)} | ${tableCell(relation.to)} | ${tableCell(relation.description)} | ${tableCell(places(relation.locations))} |`,
			);
		lines.push("");
	}
	if (logic.stateMachines.length > 0) {
		lines.push("## 状态机", "");
		for (const machine of logic.stateMachines) {
			lines.push(
				`### ${machine.subject}${machine.field ? `（${machine.field}）` : ""}`,
				"",
				`状态：${machine.states.map((state) => state.name).join("、")}${machine.initial ? `；初始状态：${machine.initial}` : ""}`,
				"",
			);
			if (machine.description) lines.push(machine.description, "");
			if (machine.transitions.length === 0) lines.push("（没有记录迁移）", "");
			else {
				lines.push("| 从 | 到 | 触发 | 前置条件 | 结果 | 位置 |", "| --- | --- | --- | --- | --- | --- |");
				for (const transition of machine.transitions)
					lines.push(
						`| ${tableCell(transition.from)} | ${tableCell(transition.to)} | ${tableCell(transition.trigger)} | ${tableCell(transition.guard)} | ${tableCell(transition.effect)} | ${tableCell(places(transition.locations))} |`,
					);
			}
			if (machine.locations.length > 0) lines.push("", `位置：${places(machine.locations)}`);
			lines.push("");
		}
	}
	if (logic.rules.length > 0) {
		lines.push("## 业务规则", "");
		lines.push("| 类型 | 对象 | 规则 | 涉及接口 | 位置 |", "| --- | --- | --- | --- | --- | --- |");
		for (const rule of logic.rules)
			lines.push(
				`| ${RULE_LABELS[rule.kind]} | ${tableCell(rule.subject)} | ${tableCell(rule.statement)}${rule.note ? `（${tableCell(rule.note)}）` : ""} | ${tableCell((rule.apis ?? []).join("、"))} | ${tableCell(places(rule.locations))} |`,
			);
		lines.push("");
	}
	if (logic.apiDependencies.length > 0) {
		lines.push("## 跨接口业务依赖", "");
		lines.push("| 起点 | 关系 | 终点 | 说明 | 位置 |", "| --- | --- | --- | --- | --- | --- |");
		for (const dependency of logic.apiDependencies)
			lines.push(
				`| ${tableCell(dependency.from)} | ${DEPENDENCY_LABELS[dependency.kind]} | ${tableCell(dependency.to)} | ${tableCell(dependency.description)} | ${tableCell(places(dependency.locations))} |`,
			);
		lines.push("");
	}
	return lines;
}

/** A page of a list, by a case-insensitive substring over the item as it is stored. */
export function pageOf<T>(
	items: readonly T[],
	query: { search?: string; page: number; pageSize: number },
): { total: number; items: T[] } {
	const needle = query.search?.trim().toLowerCase() ?? "";
	const matching = needle ? items.filter((item) => JSON.stringify(item).toLowerCase().includes(needle)) : [...items];
	const start = (query.page - 1) * query.pageSize;
	return { total: matching.length, items: matching.slice(start, start + query.pageSize) };
}

/** The endpoints one page of the read tool returns, narrowed by module and by a search over where an endpoint touches. */
export function pageApiMappings(
	apis: readonly SentinelApiSourceMapping[],
	query: { module?: string; search?: string; page: number; pageSize: number },
): { total: number; items: SentinelApiSourceMapping[] } {
	const module = query.module?.trim().toLowerCase();
	const needle = query.search?.trim().toLowerCase() ?? "";
	const matching = apis.filter((api) => {
		if (module && (api.module ?? "").toLowerCase() !== module) return false;
		if (!needle) return true;
		const haystack = [
			`${api.method} ${api.path}`,
			api.handler.name,
			api.handler.location.file,
			api.module ?? "",
			api.summary ?? "",
			...api.callChain.map((step) => `${step.name} ${step.location.file}`),
			...api.dataAccess.map((access) => `${access.table} ${(access.columns ?? []).join(" ")}`),
			...api.externalCalls.map((call) => call.target),
		]
			.join("\n")
			.toLowerCase();
		return haystack.includes(needle);
	});
	const start = (query.page - 1) * query.pageSize;
	return { total: matching.length, items: matching.slice(start, start + query.pageSize) };
}
