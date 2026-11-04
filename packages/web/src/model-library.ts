/**
 * The model library: every OpenAI-compatible endpoint the operator entered, plus
 * which entry each role uses.
 *
 * Problem it solves: the old layout had three fixed slots (`zg-endpoint`,
 * `zg-commander`, `zg-judge`), so "add a second model and use it for the
 * reviewer" was impossible without hand-editing models.json. Now models.json
 * holds one provider per library entry and this file holds what the SDK schema
 * has no place for: display names, role assignments, and the reviewer switch.
 *
 * Roles are references, not copies. `main` names an entry (or null when nothing
 * is configured); `judge` and `reviewer` may instead be "follow-main", which is
 * the old fallback chain made explicit. Deleting an entry that a role still
 * points at is refused, because a silently swapped judge changes security
 * behavior.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { t } from "./i18n.ts";
import {
	DEFAULT_MODEL_API,
	NO_AUTH_PLACEHOLDER_KEY,
	readProviderModelConfig,
	removeProviderModelConfig,
	SENTINEL_COMMANDER_PROVIDER_ID,
	SENTINEL_JUDGE_PROVIDER_ID,
	SENTINEL_PROVIDER_ID,
	writeProviderModelConfig,
} from "./model-config.ts";
import type {
	SentinelModelCapabilities,
	SentinelModelConfig,
	SentinelModelCostRates,
	SentinelModelEntryView,
	SentinelModelLibraryView,
	SentinelModelPromptCache,
	SentinelModelRoleName,
	SentinelResolvedModelView,
} from "./protocol.ts";

export const MODEL_LIBRARY_VERSION = 1;
/** New entries get ids in this namespace; the three legacy slot ids stay as they are. */
export const NEW_ENTRY_ID_PREFIX = "zg-model-";
/** The value a role holds when it should use whatever `main` uses. */
export const FOLLOW_MAIN = "follow-main";

export const SENTINEL_MODEL_ROLE_NAMES: SentinelModelRoleName[] = [
	"main",
	"judge",
	"reviewer",
	"supervisor",
	"commander",
	"monitor",
];
export const SENTINEL_MODEL_ROLE_LABELS: Record<SentinelModelRoleName, string> = {
	get main() {
		return t("主模型");
	},
	get judge() {
		return t("守门模型");
	},
	get reviewer() {
		return t("漏洞评审");
	},
	get supervisor() {
		return t("监督模型");
	},
	get commander() {
		return t("指挥端点");
	},
	get monitor() {
		return t("监测模型");
	},
};

export interface SentinelModelEntry {
	id: string;
	name: string;
}

/** `main` cannot follow itself, so it is either an entry or nothing. */
export type SentinelRoleMainRef = { kind: "model"; id: string } | null;
export type SentinelRoleRef = { kind: "model"; id: string } | { kind: "follow-main" };

export interface SentinelModelLibrary {
	version: number;
	entries: SentinelModelEntry[];
	roles: {
		main: SentinelRoleMainRef;
		judge: SentinelRoleRef;
		reviewer: SentinelRoleRef;
		supervisor: SentinelRoleRef;
		commander: SentinelRoleRef;
		monitor: SentinelRoleRef;
	};
	/** When off, submissions are not queued for the reviewer at all. */
	reviewerAuto: boolean;
}

export interface SentinelResolvedModel {
	config: SentinelModelConfig;
	entryId: string;
	entryName: string;
	/** True when the role resolved through `main` rather than its own entry. */
	followedMain: boolean;
}

export interface SentinelModelEntryInput {
	name: string;
	baseUrl: string;
	apiKey: string;
	modelId: string;
	/** Present for a form save; omitted means "keep what is stored". */
	capabilities?: SentinelModelCapabilities;
}

/** `apiKey: null` keeps the stored key; "" clears it (unauthenticated endpoint). */
export interface SentinelModelEntryPatch {
	name: string;
	baseUrl: string;
	apiKey: string | null;
	modelId: string;
	capabilities?: SentinelModelCapabilities;
}

/**
 * Protocols pi knows. The editor only offers the four common endpoint shapes,
 * but a hand-written models.json may name any of these and must round-trip.
 */
export const MODEL_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"mistral-conversations",
	"azure-openai-responses",
	"openai-codex-responses",
	"bedrock-converse-stream",
	"google-vertex",
	"pi-messages",
] as const;

export function modelLibraryPath(agentDir: string): string {
	return `${agentDir}/model-library.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Tolerant parse: an unreadable or hand-edited file degrades to "fewer entries",
 * never to a crash. References to entries that no longer exist are dropped.
 */
export function normalizeModelLibrary(value: unknown): SentinelModelLibrary {
	const source = isRecord(value) ? value : {};
	const entries: SentinelModelEntry[] = [];
	if (Array.isArray(source.entries)) {
		for (const raw of source.entries) {
			if (!isRecord(raw)) continue;
			const id = nonEmptyString(raw.id);
			if (!id || entries.some((entry) => entry.id === id)) continue;
			entries.push({ id, name: nonEmptyString(raw.name) ?? id });
		}
	}
	const has = (id: string): boolean => entries.some((entry) => entry.id === id);
	const roleRef = (raw: unknown, fallback: SentinelRoleRef): SentinelRoleRef => {
		if (!isRecord(raw)) return fallback;
		if (raw.kind === "follow-main") return { kind: "follow-main" };
		const id = nonEmptyString(raw.id);
		return raw.kind === "model" && id && has(id) ? { kind: "model", id } : fallback;
	};
	const rawRoles = isRecord(source.roles) ? source.roles : {};
	const rawMain = isRecord(rawRoles.main) ? rawRoles.main : null;
	const mainId = rawMain?.kind === "model" ? nonEmptyString(rawMain.id) : null;
	// Older library files have no commander role. Preserve a legacy zg-commander
	// endpoint once, but do not override an explicit follow-main written later.
	const commanderFallback: SentinelRoleRef = has(SENTINEL_COMMANDER_PROVIDER_ID)
		? { kind: "model", id: SENTINEL_COMMANDER_PROVIDER_ID }
		: { kind: "follow-main" };
	const commander = isRecord(rawRoles.commander)
		? roleRef(rawRoles.commander, { kind: "follow-main" })
		: commanderFallback;
	return {
		version: typeof source.version === "number" ? source.version : MODEL_LIBRARY_VERSION,
		entries,
		roles: {
			main: mainId && has(mainId) ? { kind: "model", id: mainId } : null,
			judge: roleRef(rawRoles.judge, { kind: "follow-main" }),
			reviewer: roleRef(rawRoles.reviewer, { kind: "follow-main" }),
			supervisor: roleRef(rawRoles.supervisor, { kind: "follow-main" }),
			commander,
			monitor: roleRef(rawRoles.monitor, { kind: "follow-main" }),
		},
		reviewerAuto: typeof source.reviewerAuto === "boolean" ? source.reviewerAuto : true,
	};
}

/** The persisted library, or null when the file does not exist yet. */
export function readStoredModelLibrary(agentDir: string): SentinelModelLibrary | null {
	const path = modelLibraryPath(agentDir);
	if (!existsSync(path)) return null;
	try {
		return normalizeModelLibrary(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return null;
	}
}

/**
 * The library in effect. When no library file exists yet the legacy slots are
 * translated in memory, so a runtime read before the operator ever opens
 * 设置 → 模型 behaves exactly as before the upgrade.
 */
export function readModelLibrary(agentDir: string): SentinelModelLibrary {
	return readStoredModelLibrary(agentDir) ?? migrateModelLibrary(agentDir);
}

export function writeModelLibrary(agentDir: string, library: SentinelModelLibrary): void {
	const path = modelLibraryPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalizeModelLibrary(library), null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// chmod is best-effort (some filesystems reject it)
	}
}

/**
 * Translate the fixed slots into library entries.
 *
 * The entry ids are the slot ids, so models.json needs no rewrite and a
 * downgrade still finds `zg-endpoint` / `zg-commander` / `zg-judge`. Role
 * assignment reproduces what the old code resolved at runtime: the reviewer used
 * `commander ?? main`, the judge used `judge ?? commander ?? main`.
 */
export function migrateModelLibrary(agentDir: string): SentinelModelLibrary {
	const entries: SentinelModelEntry[] = [];
	const add = (providerId: string, name: string): void => {
		if (readProviderModelConfig(agentDir, providerId)) entries.push({ id: providerId, name });
	};
	add(SENTINEL_PROVIDER_ID, t("主端点"));
	add(SENTINEL_COMMANDER_PROVIDER_ID, t("指挥官端点"));
	add(SENTINEL_JUDGE_PROVIDER_ID, t("守门端点"));
	const has = (id: string): boolean => entries.some((entry) => entry.id === id);
	const judge: SentinelRoleRef = has(SENTINEL_JUDGE_PROVIDER_ID)
		? { kind: "model", id: SENTINEL_JUDGE_PROVIDER_ID }
		: has(SENTINEL_COMMANDER_PROVIDER_ID)
			? { kind: "model", id: SENTINEL_COMMANDER_PROVIDER_ID }
			: { kind: "follow-main" };
	const reviewer: SentinelRoleRef = has(SENTINEL_COMMANDER_PROVIDER_ID)
		? { kind: "model", id: SENTINEL_COMMANDER_PROVIDER_ID }
		: { kind: "follow-main" };
	return normalizeModelLibrary({
		version: MODEL_LIBRARY_VERSION,
		entries,
		roles: {
			main: has(SENTINEL_PROVIDER_ID) ? { kind: "model", id: SENTINEL_PROVIDER_ID } : null,
			judge,
			reviewer,
			supervisor: { kind: "follow-main" },
			commander: has(SENTINEL_COMMANDER_PROVIDER_ID)
				? { kind: "model", id: SENTINEL_COMMANDER_PROVIDER_ID }
				: { kind: "follow-main" },
			monitor: { kind: "follow-main" },
		},
		reviewerAuto: true,
	});
}

/** Roles that currently point at this entry, for the delete guard and the table. */
export function rolesUsing(library: SentinelModelLibrary, entryId: string): SentinelModelRoleName[] {
	const roles: SentinelModelRoleName[] = [];
	for (const role of SENTINEL_MODEL_ROLE_NAMES) {
		const ref = library.roles[role];
		if (ref && ref.kind === "model" && ref.id === entryId) roles.push(role);
	}
	return roles;
}

/** Wire form of a resolved role, for the settings screen and the snapshot. */
export function toResolvedModelView(resolved: SentinelResolvedModel | null): SentinelResolvedModelView | null {
	if (!resolved) return null;
	return {
		entryId: resolved.entryId,
		entryName: resolved.entryName,
		modelId: resolved.config.modelId,
		followedMain: resolved.followedMain,
	};
}

function resolveEntry(
	agentDir: string,
	library: SentinelModelLibrary,
	id: string,
	followedMain: boolean,
): SentinelResolvedModel | null {
	const entry = library.entries.find((candidate) => candidate.id === id);
	if (!entry) return null;
	const config = readProviderModelConfig(agentDir, id);
	if (!config) return null;
	return { config, entryId: id, entryName: entry.name, followedMain };
}

/** Resolve one role to a usable endpoint, or null when nothing resolves. */
export function resolveLibraryRole(agentDir: string, role: SentinelModelRoleName): SentinelResolvedModel | null {
	const library = readModelLibrary(agentDir);
	const mainRef = library.roles.main;
	if (role === "main") {
		return mainRef ? resolveEntry(agentDir, library, mainRef.id, false) : null;
	}
	const ref: SentinelRoleRef = library.roles[role as Exclude<SentinelModelRoleName, "main">];
	if (ref.kind === "model") return resolveEntry(agentDir, library, ref.id, false);
	return mainRef ? resolveEntry(agentDir, library, mainRef.id, true) : null;
}

/** The settings-page view: entries with their endpoint and role usage, never the key itself. */
export function libraryView(agentDir: string): SentinelModelLibraryView {
	const library = readModelLibrary(agentDir);
	const entries: SentinelModelEntryView[] = library.entries.map((entry) => {
		const config = readProviderModelConfig(agentDir, entry.id);
		const capabilities = config?.capabilities;
		return {
			id: entry.id,
			name: entry.name,
			baseUrl: config?.baseUrl ?? "",
			modelId: config?.modelId ?? "",
			hasKey: Boolean(config?.apiKey && config.apiKey !== NO_AUTH_PLACEHOLDER_KEY),
			roles: rolesUsing(library, entry.id),
			api: capabilities?.api ?? DEFAULT_MODEL_API,
			contextWindow: capabilities?.contextWindow ?? null,
			maxTokens: capabilities?.maxTokens ?? null,
			reasoning: capabilities?.reasoning === true,
			input: capabilities?.input ?? ["text"],
			cost: capabilities?.cost ?? null,
			promptCache: capabilities?.promptCache ?? null,
		};
	});
	return {
		entries,
		roles: {
			main: library.roles.main?.id ?? null,
			judge: library.roles.judge.kind === "model" ? library.roles.judge.id : FOLLOW_MAIN,
			reviewer: library.roles.reviewer.kind === "model" ? library.roles.reviewer.id : FOLLOW_MAIN,
			supervisor: library.roles.supervisor.kind === "model" ? library.roles.supervisor.id : FOLLOW_MAIN,
			commander: library.roles.commander.kind === "model" ? library.roles.commander.id : FOLLOW_MAIN,
			monitor: library.roles.monitor.kind === "model" ? library.roles.monitor.id : FOLLOW_MAIN,
		},
		reviewerAuto: library.reviewerAuto,
		resolved: {
			main: toResolvedModelView(resolveLibraryRole(agentDir, "main")),
			judge: toResolvedModelView(resolveLibraryRole(agentDir, "judge")),
			reviewer: toResolvedModelView(resolveLibraryRole(agentDir, "reviewer")),
			supervisor: toResolvedModelView(resolveLibraryRole(agentDir, "supervisor")),
			commander: toResolvedModelView(resolveLibraryRole(agentDir, "commander")),
			monitor: toResolvedModelView(resolveLibraryRole(agentDir, "monitor")),
		},
	};
}

/** Next free `zg-model-N` id. */
export function nextEntryId(entries: SentinelModelEntry[]): string {
	let max = 0;
	for (const entry of entries) {
		if (!entry.id.startsWith(NEW_ENTRY_ID_PREFIX)) continue;
		const suffix = Number.parseInt(entry.id.slice(NEW_ENTRY_ID_PREFIX.length), 10);
		if (Number.isFinite(suffix) && suffix > max) max = suffix;
	}
	return `${NEW_ENTRY_ID_PREFIX}${max + 1}`;
}

function requireEntry(library: SentinelModelLibrary, id: string): SentinelModelEntry {
	const entry = library.entries.find((candidate) => candidate.id === id);
	if (!entry) throw new Error(t("模型不存在，可能已被删除"));
	return entry;
}

function positiveInteger(value: number | undefined, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value <= 0) throw new Error(t("{label}必须是正整数", { label }));
	return value;
}

/**
 * Validate the form's capability fields. A provided object is the whole
 * declaration: omitted fields are cleared, which is what lets the operator turn
 * reasoning or prices back off. Unvalidated input would reach models.json and
 * make pi throw only when a session starts, so everything is checked here.
 */
function cleanCapabilities(raw: SentinelModelCapabilities | undefined): SentinelModelCapabilities | undefined {
	if (!raw) return undefined;
	const api = raw.api?.trim() || DEFAULT_MODEL_API;
	if (!(MODEL_APIS as readonly string[]).includes(api))
		throw new Error(t("不支持的协议：{api}", { api: String(raw.api) }));
	const contextWindow = positiveInteger(raw.contextWindow, t("上下文窗口"));
	const maxTokens = positiveInteger(raw.maxTokens, t("最大输出"));
	if (contextWindow !== undefined && maxTokens !== undefined && maxTokens > contextWindow) {
		throw new Error(t("最大输出不能大于上下文窗口"));
	}
	let cost: SentinelModelCostRates | undefined;
	if (raw.cost) {
		const rate = (value: unknown, label: string): number => {
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
				throw new Error(t("{label}必须是不小于 0 的数字（美元 / 百万 token）", { label }));
			}
			return value;
		};
		cost = {
			input: rate(raw.cost.input, t("输入价格")),
			output: rate(raw.cost.output, t("输出价格")),
			cacheRead: rate(raw.cost.cacheRead, t("缓存读价格")),
			cacheWrite: rate(raw.cost.cacheWrite, t("缓存写价格")),
		};
	}
	let promptCache: SentinelModelPromptCache | undefined;
	if (raw.promptCache) {
		const short = positiveInteger(raw.promptCache.short, t("短期缓存时长"));
		const long = positiveInteger(raw.promptCache.long, t("长期缓存时长"));
		if (short !== undefined || long !== undefined) {
			promptCache = { ...(short !== undefined ? { short } : {}), ...(long !== undefined ? { long } : {}) };
		}
	}
	return {
		api,
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		reasoning: raw.reasoning === true,
		input: Array.isArray(raw.input) && raw.input.includes("image") ? ["text", "image"] : ["text"],
		...(cost ? { cost } : {}),
		...(promptCache ? { promptCache } : {}),
	};
}

function cleanInput(input: SentinelModelEntryInput | SentinelModelEntryPatch): {
	name: string;
	baseUrl: string;
	modelId: string;
	capabilities?: SentinelModelCapabilities;
} {
	const baseUrl = input.baseUrl.trim();
	const modelId = input.modelId.trim();
	if (!baseUrl) throw new Error(t("Base URL 不能为空"));
	if (!modelId) throw new Error(t("模型 ID 不能为空"));
	const capabilities = cleanCapabilities(input.capabilities);
	return { name: input.name.trim() || modelId, baseUrl, modelId, ...(capabilities ? { capabilities } : {}) };
}

/** Add an entry. The first entry becomes the main model, so the app is usable at once. */
export function addLibraryEntry(agentDir: string, input: SentinelModelEntryInput): SentinelModelEntry {
	const library = readModelLibrary(agentDir);
	const clean = cleanInput(input);
	const entry: SentinelModelEntry = { id: nextEntryId(library.entries), name: clean.name };
	writeProviderModelConfig(agentDir, entry.id, entry.name, {
		baseUrl: clean.baseUrl,
		apiKey: input.apiKey.trim(),
		modelId: clean.modelId,
		...(clean.capabilities ? { capabilities: clean.capabilities } : {}),
	});
	library.entries.push(entry);
	if (!library.roles.main) library.roles.main = { kind: "model", id: entry.id };
	writeModelLibrary(agentDir, library);
	return entry;
}

export function updateLibraryEntry(agentDir: string, id: string, patch: SentinelModelEntryPatch): SentinelModelEntry {
	const library = readModelLibrary(agentDir);
	const entry = requireEntry(library, id);
	const clean = cleanInput(patch);
	const previous = readProviderModelConfig(agentDir, id);
	// null keeps the stored key: the form never renders it back.
	const apiKey = patch.apiKey === null ? (previous?.apiKey ?? "") : patch.apiKey.trim();
	writeProviderModelConfig(agentDir, id, clean.name, {
		baseUrl: clean.baseUrl,
		apiKey,
		modelId: clean.modelId,
		...(clean.capabilities ? { capabilities: clean.capabilities } : {}),
	});
	entry.name = clean.name;
	writeModelLibrary(agentDir, library);
	return entry;
}

export function duplicateLibraryEntry(agentDir: string, id: string): SentinelModelEntry {
	const library = readModelLibrary(agentDir);
	const source = requireEntry(library, id);
	const config = readProviderModelConfig(agentDir, id);
	if (!config) throw new Error(t("这个模型没有可复制的端点配置"));
	const entry: SentinelModelEntry = { id: nextEntryId(library.entries), name: `${source.name} ${t("副本")}` };
	writeProviderModelConfig(agentDir, entry.id, entry.name, config);
	library.entries.push(entry);
	writeModelLibrary(agentDir, library);
	return entry;
}

/** Delete an entry. Refused while any role still points at it. */
export function removeLibraryEntry(agentDir: string, id: string): void {
	const library = readModelLibrary(agentDir);
	const entry = requireEntry(library, id);
	const used = rolesUsing(library, id);
	if (used.length > 0) {
		const labels = used.map((role) => SENTINEL_MODEL_ROLE_LABELS[role]).join(t("、"));
		throw new Error(t("「{name}」正被 {roles} 使用，请先改掉这些角色再删除", { name: entry.name, roles: labels }));
	}
	library.entries = library.entries.filter((candidate) => candidate.id !== id);
	writeModelLibrary(agentDir, library);
	removeProviderModelConfig(agentDir, id);
}

/** Point a role at an entry, or at `main` for judge/reviewer. */
export function setLibraryRole(
	agentDir: string,
	role: SentinelModelRoleName,
	target: string | null,
): SentinelModelLibrary {
	const library = readModelLibrary(agentDir);
	if (role === "main") {
		if (target === null) {
			library.roles.main = null;
		} else {
			if (target === FOLLOW_MAIN) throw new Error(t("主模型不能跟随主模型"));
			requireEntry(library, target);
			library.roles.main = { kind: "model", id: target };
		}
	} else if (target === FOLLOW_MAIN) {
		library.roles[role] = { kind: "follow-main" };
	} else if (target === null) {
		throw new Error(t("这个角色必须选择一条模型或跟随主模型"));
	} else {
		requireEntry(library, target);
		library.roles[role] = { kind: "model", id: target };
	}
	writeModelLibrary(agentDir, library);
	return library;
}

export function setReviewerAuto(agentDir: string, enabled: boolean): SentinelModelLibrary {
	const library = readModelLibrary(agentDir);
	library.reviewerAuto = enabled;
	writeModelLibrary(agentDir, library);
	return library;
}
