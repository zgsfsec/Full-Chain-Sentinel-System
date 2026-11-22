/**
 * The supervisor: a per-conversation observer that turns batches of tool calls
 * into a rolling state, and in intervene mode sends at most one short advice.
 *
 * It never blocks a tool call and never runs tools itself. Observation mode is
 * pure UI/audit; intervene mode injects a labelled custom message, which the
 * main agent is free to ignore. The hard safety property is that the supervisor
 * cannot stop the run: the operator remains the only one who can abort.
 */

import { randomUUID } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { type AuxiliaryModelConfig, completeAuxiliaryModel } from "./auxiliary-model.ts";
import { t } from "./i18n.ts";
import { resolveLibraryRole, toResolvedModelView } from "./model-library.ts";
import type {
	SentinelSupervisorAdvice,
	SentinelSupervisorAdviceDraft,
	SentinelSupervisorAuditItem,
	SentinelSupervisorAuditPage,
	SentinelSupervisorCall,
	SentinelSupervisorConfig,
	SentinelSupervisorCustomStrategy,
	SentinelSupervisorDetail,
	SentinelSupervisorEpisode,
	SentinelSupervisorLog,
	SentinelSupervisorMode,
	SentinelSupervisorProgress,
	SentinelSupervisorState,
	SentinelSupervisorStatus,
	SentinelSupervisorStrategy,
	SentinelSupervisorStrategyEntry,
	SentinelSupervisorTested,
	SentinelSupervisorTrigger,
	SentinelSupervisorUsage,
	SentinelSupervisorView,
	SentinelTestResult,
} from "./protocol.ts";
import { isSupervisorStrategy, readSupervisorConfig } from "./supervisor-config.ts";
import {
	digestRunningToolCall,
	digestToolCall,
	type SupervisorDigestInput,
	type SupervisorRunningToolInput,
} from "./supervisor-digest.ts";
import {
	buildAdviceText,
	buildSupervisorInput,
	buildSupervisorTestInput,
	parseSupervisorEpisode,
	SUPERVISOR_STRATEGY_LABELS,
	SUPERVISOR_SYSTEM_PROMPT,
} from "./supervisor-prompt.ts";
import type { SupervisorAuditQuery, SupervisorStore } from "./supervisor-store.ts";

export const SUPERVISOR_STATE_CUSTOM_TYPE = "zg-supervisor-state";
export const SUPERVISOR_EPISODE_CUSTOM_TYPE = "zg-supervisor-episode";
export const SUPERVISOR_ADVICE_CUSTOM_TYPE = "zg-supervisor-advice";

/** One advice per five minutes at most, however many episodes stall. */
const ADVICE_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_RECENT_CALLS = 20;
const MAX_LOGS = 100;
const MAX_TESTED = 200;
const MAX_DEAD_ENDS = 200;
const MAX_EVIDENCE = 50;
const MAX_STRATEGY_NOTE = 200;

function clipStrategyNote(value: string): string {
	return value.trim().slice(0, MAX_STRATEGY_NOTE);
}

export interface SupervisorObservation {
	record: SentinelSupervisorCall;
	fingerprint: string;
}

export interface SupervisorHooks {
	onState(view: SentinelSupervisorView | null): void;
	onEpisode(episode: SentinelSupervisorEpisode, calls: SentinelSupervisorCall[]): void;
	onLog(sessionId: string, log: SentinelSupervisorLog): void;
	onAdvice(advice: SentinelSupervisorAdvice): void;
	/** The runtime injects the advice into the main agent; observation mode never calls this. */
	onSendAdvice(advice: SentinelSupervisorAdvice): void;
}

interface PersistedState {
	status: SentinelSupervisorStatus;
	mode: SentinelSupervisorMode;
	delivery: "auto" | "confirm";
	strategy: SentinelSupervisorStrategy;
	strategyCustomId: string | null;
	strategyName: string;
	strategyInstructions: string;
	strategies?: SentinelSupervisorStrategyEntry[];
	strategyNote: string;
	armedAt: number;
	startedAt: number | null;
	endedAt: number | null;
	state: SentinelSupervisorState;
	episodeCount: number;
	episodeSeq: number;
	adviceCount: number;
	callCount: number;
	lastEpisodeAt: number | null;
	lastCallAt: number | null;
	usage: SentinelSupervisorUsage;
	lastError: string | null;
}

interface SupervisorSession {
	sessionId: string;
	manager: SessionManager;
	projectId: string | null;
	projectName: string | null;
	mode: SentinelSupervisorMode;
	delivery: "auto" | "confirm";
	strategy: SentinelSupervisorStrategy;
	strategyCustomId: string | null;
	strategyName: string;
	strategyInstructions: string;
	strategies: SentinelSupervisorStrategyEntry[];
	strategyNote: string;
	status: SentinelSupervisorStatus;
	/** False for a session that was never armed; `view` stays null for those. */
	armed: boolean;
	armedAt: number;
	startedAt: number | null;
	endedAt: number | null;
	state: SentinelSupervisorState;
	episodeCount: number;
	episodeSeq: number;
	adviceCount: number;
	callCount: number;
	usage: SentinelSupervisorUsage;
	lastEpisodeAt: number | null;
	lastCallAt: number | null;
	lastError: string | null;
	running: boolean;
	pendingTrigger: SentinelSupervisorTrigger | null;
	pendingLongCalls: Map<string, SupervisorObservation>;
	runningTools: Map<string, RunningSupervisorTool>;
	recentCalls: SupervisorObservation[];
	batchCalls: SupervisorObservation[];
	seenEndpoints: Set<string>;
	seenParams: Set<string>;
	noEvidenceStreak: number;
	errorStreak: number;
	pendingAdvice: SentinelSupervisorAdvice | null;
	lastAdviceAt: number;
	inFlight: AbortController | null;
	logs: SentinelSupervisorLog[];
}

interface RunningSupervisorTool {
	input: Omit<SupervisorRunningToolInput, "redactSecrets" | "durationMs">;
	timer: ReturnType<typeof setTimeout> | null;
}

interface ModelReply {
	raw: string;
	usage: SentinelSupervisorUsage;
	model: string;
	/** Why the endpoint stopped; `length` means the JSON may be truncated. */
	finishReason?: string;
}

export interface SupervisorTestOutcome {
	result: SentinelTestResult;
	raw?: string;
}

export interface SupervisorOptions {
	agentDir: string;
	store: SupervisorStore;
	hooks: SupervisorHooks;
}

function emptyState(): SentinelSupervisorState {
	return {
		phase: "unknown",
		intent: "",
		progress: "unknown",
		tested: [],
		deadEnds: [],
		newEvidence: [],
		openQuestions: [],
		nextCandidates: [],
		duplicateSignals: [],
	};
}

function emptyUsage(): SentinelSupervisorUsage {
	return { input: 0, output: 0, total: 0 };
}

function uniqueStrings(previous: string[], next: string[], limit: number): string[] {
	const output = [...previous];
	for (const value of next) {
		const trimmed = value.trim();
		if (trimmed && !output.includes(trimmed)) output.push(trimmed);
	}
	return output.slice(-limit);
}

function mergeTested(
	previous: SentinelSupervisorTested[],
	next: SentinelSupervisorTested[],
): SentinelSupervisorTested[] {
	const output = [...previous];
	for (const entry of next) {
		const key = `${entry.target}\n${entry.test}`;
		if (!output.some((candidate) => `${candidate.target}\n${candidate.test}` === key)) output.push(entry);
	}
	return output.slice(-MAX_TESTED);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function parsePersistedState(value: unknown): Partial<PersistedState> {
	const record = asRecord(value);
	if (!record) return {};
	const state = asRecord(record.state);
	const tested = Array.isArray(state?.tested)
		? state.tested
				.map((entry) => asRecord(entry))
				.filter((entry): entry is Record<string, unknown> => entry !== null)
				.map((entry) => ({
					target: asString(entry.target),
					test: asString(entry.test),
					result: asString(entry.result),
				}))
				.filter((entry) => entry.target && entry.test)
		: [];
	const strings = (input: unknown): string[] =>
		Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === "string") : [];
	const usage = asRecord(record.usage);
	const progressValue = asString(state?.progress);
	const modeValue = asString(record.mode);
	const deliveryValue = asString(record.delivery);
	const strategyValue = asString(record.strategy);
	const strategyCustomIdValue = asString(record.strategyCustomId);
	const strategiesValue = Array.isArray(record.strategies)
		? record.strategies
				.map((entry) => asRecord(entry))
				.filter((entry): entry is Record<string, unknown> => entry !== null)
				.map((entry) => ({
					strategy: asString(entry.strategy),
					customStrategyId: asString(entry.customStrategyId) || null,
					name: asString(entry.name).slice(0, 30),
					instructions: asString(entry.instructions).slice(0, 500),
				}))
				.filter(
					(entry): entry is SentinelSupervisorStrategyEntry =>
						isSupervisorStrategy(entry.strategy) && entry.name.length > 0,
				)
		: [];
	const statusValue = asString(record.status);
	return {
		status: (["waiting", "running", "stopped", "error"] as const).includes(statusValue as SentinelSupervisorStatus)
			? (statusValue as SentinelSupervisorStatus)
			: undefined,
		mode: modeValue === "intervene" ? "intervene" : modeValue === "observe" ? "observe" : undefined,
		delivery: deliveryValue === "auto" ? "auto" : deliveryValue === "confirm" ? "confirm" : undefined,
		strategy: isSupervisorStrategy(strategyValue) ? strategyValue : undefined,
		strategyCustomId: strategyCustomIdValue || null,
		strategyName: typeof record.strategyName === "string" ? record.strategyName.slice(0, 30) : undefined,
		strategyInstructions:
			typeof record.strategyInstructions === "string" ? record.strategyInstructions.slice(0, 500) : undefined,
		strategies: strategiesValue.length > 0 ? strategiesValue : undefined,
		strategyNote: typeof record.strategyNote === "string" ? clipStrategyNote(record.strategyNote) : undefined,
		armedAt: asNumber(record.armedAt) || undefined,
		startedAt: typeof record.startedAt === "number" ? record.startedAt : null,
		endedAt: typeof record.endedAt === "number" ? record.endedAt : null,
		state: {
			phase: asString(state?.phase) || "unknown",
			intent: asString(state?.intent),
			progress: (["advancing", "stalled", "looping", "unknown"] as const).includes(
				progressValue as SentinelSupervisorProgress,
			)
				? (progressValue as SentinelSupervisorProgress)
				: "unknown",
			tested,
			deadEnds: strings(state?.deadEnds),
			newEvidence: strings(state?.newEvidence),
			openQuestions: strings(state?.openQuestions),
			nextCandidates: strings(state?.nextCandidates),
			duplicateSignals: strings(state?.duplicateSignals),
		},
		episodeCount: asNumber(record.episodeCount),
		episodeSeq: asNumber(record.episodeSeq),
		adviceCount: asNumber(record.adviceCount),
		callCount: asNumber(record.callCount),
		lastEpisodeAt: typeof record.lastEpisodeAt === "number" ? record.lastEpisodeAt : null,
		lastCallAt: typeof record.lastCallAt === "number" ? record.lastCallAt : null,
		usage: {
			input: asNumber(usage?.input),
			output: asNumber(usage?.output),
			total: asNumber(usage?.total),
		},
		lastError: typeof record.lastError === "string" ? record.lastError : null,
	};
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	const record = asRecord(result);
	if (!record) return "";
	if (typeof record.content === "string") return record.content;
	if (Array.isArray(record.content)) {
		const parts: string[] = [];
		for (const part of record.content) {
			const item = asRecord(part);
			if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
		}
		if (parts.length > 0) return parts.join("\n");
	}
	if (typeof record.stdout === "string") return record.stdout;
	return "";
}

export async function callSupervisorModel(
	config: AuxiliaryModelConfig,
	input: string,
	signal: AbortSignal,
): Promise<ModelReply> {
	const request = { systemPrompt: SUPERVISOR_SYSTEM_PROMPT, input, signal };
	let reply = await completeAuxiliaryModel(config, { ...request, maxTokens: 8192 });
	let usage = reply.usage;
	// A long episode can be cut off mid-array. Retry with the model's full output
	// budget whenever the endpoint says the answer was truncated, not only when
	// the content is empty.
	if (reply.finishReason === "length") {
		const retry = await completeAuxiliaryModel(config, { ...request, maxTokens: 16384 });
		usage = {
			input: usage.input + retry.usage.input,
			output: usage.output + retry.usage.output,
			total: usage.total + retry.usage.total,
		};
		reply = retry;
	}
	// Some OpenAI-compatible endpoints put the whole answer in reasoning_content
	// and leave content empty. The parser can still find the JSON object there.
	const raw = reply.content.trim() || reply.reasoning.trim();
	if (!raw) {
		const detail = [
			reply.finishReason ? `finish_reason=${reply.rawFinishReason}` : "",
			`completion_tokens=${reply.usage.output}`,
			reply.reasoning.trim() ? t("只有 reasoning_content") : t("content 为空"),
		]
			.filter(Boolean)
			.join(t("，"));
		throw new Error(t("监督模型返回了空回复（{detail}）", { detail }));
	}
	return { raw, model: config.modelId, usage, finishReason: reply.finishReason };
}

export class Supervisor {
	private readonly agentDir: string;
	private readonly store: SupervisorStore;
	private readonly hooks: SupervisorHooks;
	private readonly sessions = new Map<string, SupervisorSession>();
	private closed = false;
	/** The model call; public and mutable so tests can stub it. */
	call = callSupervisorModel;

	constructor(options: SupervisorOptions) {
		this.agentDir = options.agentDir;
		this.store = options.store;
		this.hooks = options.hooks;
	}

	/** Attach one live main-agent session and restore its last state from the branch. */
	attach(input: {
		sessionId: string;
		manager: SessionManager;
		projectId: string | null;
		projectName: string | null;
	}): void {
		const existing = this.sessions.get(input.sessionId);
		if (existing) {
			existing.manager = input.manager;
			existing.projectId = input.projectId;
			existing.projectName = input.projectName;
			return;
		}
		const persisted = this.latestState(input.manager);
		const pendingAdvice = this.store.getPendingAdvice(input.sessionId);
		const restoredStrategies: SentinelSupervisorStrategyEntry[] =
			Array.isArray(persisted.strategies) && persisted.strategies.length > 0
				? persisted.strategies
				: [
						{
							strategy: persisted.strategy ?? "steady",
							customStrategyId: persisted.strategyCustomId ?? null,
							name: persisted.strategyName ?? SUPERVISOR_STRATEGY_LABELS[persisted.strategy ?? "steady"],
							instructions: persisted.strategyInstructions ?? "",
						},
					];
		const restoredPrimary = restoredStrategies[0] as SentinelSupervisorStrategyEntry;
		const session: SupervisorSession = {
			sessionId: input.sessionId,
			manager: input.manager,
			projectId: input.projectId,
			projectName: input.projectName,
			mode: persisted.mode ?? "observe",
			delivery: persisted.delivery ?? "confirm",
			strategy: restoredPrimary.strategy,
			strategyCustomId: restoredPrimary.customStrategyId,
			strategyName: restoredPrimary.name || SUPERVISOR_STRATEGY_LABELS[restoredPrimary.strategy],
			strategyInstructions: restoredPrimary.instructions,
			strategies: restoredStrategies,
			strategyNote: persisted.strategyNote ?? "",
			status: persisted.status ?? "stopped",
			armed: Object.keys(persisted).length > 0,
			armedAt: persisted.armedAt ?? Date.now(),
			startedAt: persisted.startedAt ?? null,
			endedAt: persisted.endedAt ?? null,
			state: persisted.state ?? emptyState(),
			episodeCount: persisted.episodeCount ?? 0,
			episodeSeq: persisted.episodeSeq ?? 0,
			adviceCount: persisted.adviceCount ?? 0,
			callCount: persisted.callCount ?? 0,
			usage: persisted.usage ?? emptyUsage(),
			lastEpisodeAt: persisted.lastEpisodeAt ?? null,
			lastCallAt: persisted.lastCallAt ?? null,
			lastError: persisted.lastError ?? null,
			running: false,
			pendingTrigger: null,
			pendingLongCalls: new Map(),
			runningTools: new Map(),
			recentCalls: [],
			batchCalls: [],
			seenEndpoints: new Set(),
			seenParams: new Set(),
			noEvidenceStreak: 0,
			errorStreak: 0,
			pendingAdvice,
			lastAdviceAt: pendingAdvice?.at ?? 0,
			inFlight: null,
			logs: this.store.listLogs(input.sessionId, MAX_LOGS),
		};
		this.sessions.set(input.sessionId, session);
		// A waiting state restored for a conversation that already has messages
		// cannot start now; the operator must arm a new conversation instead.
		if (session.status === "waiting" && this.hasUserMessages(session)) {
			session.status = "stopped";
			session.endedAt = Date.now();
			this.persist(session);
		}
	}

	detach(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this.clearRunningTools(session);
		session.inFlight?.abort();
		this.sessions.delete(sessionId);
	}

	arm(
		sessionId: string,
		mode: SentinelSupervisorMode,
		delivery: "auto" | "confirm",
		strategy: SentinelSupervisorStrategy = "steady",
		note = "",
		customStrategy: SentinelSupervisorCustomStrategy | null = null,
		strategies: SentinelSupervisorStrategyEntry[] | null = null,
	): SentinelSupervisorView {
		const session = this.requireSession(sessionId);
		if (session.armed && session.status === "stopped") {
			throw new Error(t("本次会话的监督已停止；请在新对话重新开启"));
		}
		if (this.hasUserMessages(session)) throw new Error(t("监督只能在开始对话前开启"));
		session.mode = mode;
		session.delivery = delivery;
		const selected: SentinelSupervisorStrategyEntry[] =
			strategies && strategies.length > 0
				? strategies
				: [
						{
							strategy: customStrategy?.base ?? strategy,
							customStrategyId: customStrategy?.id ?? null,
							name: customStrategy?.name ?? SUPERVISOR_STRATEGY_LABELS[customStrategy?.base ?? strategy],
							instructions: customStrategy?.instructions ?? "",
						},
					];
		const primary = selected[0] as SentinelSupervisorStrategyEntry;
		session.strategies = selected;
		session.strategy = primary.strategy;
		session.strategyCustomId = primary.customStrategyId;
		session.strategyName = primary.name || SUPERVISOR_STRATEGY_LABELS[primary.strategy];
		session.strategyInstructions = primary.instructions;
		session.strategyNote = clipStrategyNote(note);
		session.status = "waiting";
		session.armed = true;
		session.armedAt = Date.now();
		session.startedAt = null;
		session.endedAt = null;
		session.state = emptyState();
		session.episodeCount = 0;
		session.episodeSeq = 0;
		session.adviceCount = 0;
		session.callCount = 0;
		session.usage = emptyUsage();
		session.lastEpisodeAt = null;
		session.lastCallAt = null;
		session.lastError = null;
		session.recentCalls = [];
		session.batchCalls = [];
		session.seenEndpoints.clear();
		session.seenParams.clear();
		session.noEvidenceStreak = 0;
		session.errorStreak = 0;
		session.pendingAdvice = null;
		session.pendingTrigger = null;
		this.clearRunningTools(session);
		session.lastAdviceAt = 0;
		this.persist(session);
		this.upsert(session);
		this.log(
			session,
			"arm",
			t("已开启监督：{mode} · {strategy}", {
				mode:
					mode === "observe"
						? t("观察模式")
						: t("介入模式（{delivery}）", {
								delivery: delivery === "auto" ? t("自动发送") : t("确认后发送"),
							}),
				strategy: session.strategyName,
			}),
		);
		this.emit(session);
		return this.view(sessionId) as SentinelSupervisorView;
	}

	start(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session || session.status !== "waiting") return;
		session.status = "running";
		session.startedAt = Date.now();
		this.persist(session);
		this.upsert(session);
		this.log(session, "start", t("对话已开始，监督开始采集"));
		this.emit(session);
	}

	stop(sessionId: string): SentinelSupervisorView | null {
		const session = this.requireSession(sessionId);
		if (session.status === "stopped") return this.view(sessionId);
		session.status = "stopped";
		session.endedAt = Date.now();
		session.pendingTrigger = null;
		if (session.pendingAdvice) {
			this.store.setAdviceStatus(session.pendingAdvice.id, "ignored", null);
			session.pendingAdvice = null;
		}
		session.inFlight?.abort();
		session.inFlight = null;
		this.persist(session);
		this.upsert(session);
		this.log(session, "stop", t("监督已停止，本会话不再采集"));
		this.emit(session);
		return this.view(sessionId);
	}

	setMode(sessionId: string, mode: SentinelSupervisorMode, delivery: "auto" | "confirm"): SentinelSupervisorView {
		const session = this.requireSession(sessionId);
		if (session.status === "stopped") throw new Error(t("本次会话的监督已停止"));
		session.mode = mode;
		session.delivery = delivery;
		if (mode === "observe" && session.pendingAdvice) {
			this.store.setAdviceStatus(session.pendingAdvice.id, "ignored", null);
			session.pendingAdvice = null;
		}
		this.persist(session);
		this.upsert(session);
		this.log(
			session,
			"mode",
			t("切换为{mode}", {
				mode:
					mode === "observe"
						? t("观察模式")
						: t("介入模式（{delivery}）", {
								delivery: delivery === "auto" ? t("自动发送") : t("确认后发送"),
							}),
			}),
		);
		this.emit(session);
		return this.view(sessionId) as SentinelSupervisorView;
	}

	setStrategy(
		sessionId: string,
		strategy: SentinelSupervisorStrategy,
		note?: string,
		customStrategy: SentinelSupervisorCustomStrategy | null = null,
		strategies: SentinelSupervisorStrategyEntry[] | null = null,
	): SentinelSupervisorView {
		const session = this.requireSession(sessionId);
		if (session.status === "stopped") throw new Error(t("本次会话的监督已停止"));
		const selected: SentinelSupervisorStrategyEntry[] =
			strategies && strategies.length > 0
				? strategies
				: [
						{
							strategy: customStrategy?.base ?? strategy,
							customStrategyId: customStrategy?.id ?? null,
							name: customStrategy?.name ?? SUPERVISOR_STRATEGY_LABELS[customStrategy?.base ?? strategy],
							instructions: customStrategy?.instructions ?? "",
						},
					];
		const primary = selected[0] as SentinelSupervisorStrategyEntry;
		session.strategies = selected;
		session.strategy = primary.strategy;
		session.strategyCustomId = primary.customStrategyId;
		session.strategyName = primary.name || SUPERVISOR_STRATEGY_LABELS[primary.strategy];
		session.strategyInstructions = primary.instructions;
		if (note !== undefined) session.strategyNote = clipStrategyNote(note);
		this.persist(session);
		this.upsert(session);
		this.log(
			session,
			"strategy",
			t("监督策略切换为：{names}", { names: selected.map((entry) => entry.name).join(" + ") }),
		);
		this.emit(session);
		return this.view(sessionId) as SentinelSupervisorView;
	}

	/** Digest one finished tool call with this session's seen-endpoint/param sets, then observe it. */
	observeToolCall(
		sessionId: string,
		input: Omit<SupervisorDigestInput, "redactSecrets" | "seenEndpoints" | "seenParams">,
	): void {
		const session = this.sessions.get(sessionId);
		if (this.closed || !session || session.status !== "running") return;
		this.finishToolCall(sessionId, input.callId);
		const config = readSupervisorConfig(this.agentDir);
		const digest = digestToolCall({
			...input,
			redactSecrets: config.redactSecrets,
			seenEndpoints: session.seenEndpoints,
			seenParams: session.seenParams,
		});
		const observation = { record: digest.record, fingerprint: digest.fingerprint };
		if (session.pendingLongCalls.has(input.callId)) session.pendingLongCalls.set(input.callId, observation);
		this.observe(sessionId, observation);
	}

	/** Start a one-shot watchdog that analyzes this call only if it stays open. */
	observeToolStart(sessionId: string, input: Omit<SupervisorRunningToolInput, "redactSecrets" | "durationMs">): void {
		const session = this.sessions.get(sessionId);
		if (this.closed || !session || session.status !== "running") return;
		const config = readSupervisorConfig(this.agentDir);
		if (!config.enabled) return;
		this.finishToolCall(sessionId, input.callId);
		const running: RunningSupervisorTool = { input, timer: null };
		running.timer = setTimeout(() => {
			if (this.closed || session.status !== "running" || session.runningTools.get(input.callId) !== running) return;
			running.timer = null;
			const currentConfig = readSupervisorConfig(this.agentDir);
			if (!currentConfig.enabled) return;
			const digest = digestRunningToolCall({
				...input,
				durationMs: Date.now() - input.at,
				redactSecrets: currentConfig.redactSecrets,
			});
			const observation = { record: digest.record, fingerprint: digest.fingerprint };
			if (session.running) {
				session.pendingLongCalls.set(input.callId, observation);
				session.pendingTrigger ??= "long-call";
				this.emit(session);
				return;
			}
			void this.runEpisode(session, "long-call", [...session.batchCalls, observation]);
		}, config.longToolCallMs);
		session.runningTools.set(input.callId, running);
	}

	/** Cancel a watchdog when the observed tool returns, even if the session is no longer active. */
	finishToolCall(sessionId: string, callId: string): void {
		const session = this.sessions.get(sessionId);
		const running = session?.runningTools.get(callId);
		if (!session || !running) return;
		if (running.timer !== null) clearTimeout(running.timer);
		session.runningTools.delete(callId);
	}

	observe(sessionId: string, observation: SupervisorObservation): void {
		if (this.closed) return;
		const session = this.sessions.get(sessionId);
		if (!session || session.status !== "running") return;
		const config = readSupervisorConfig(this.agentDir);
		if (!config.enabled) return;
		session.callCount += 1;
		session.lastCallAt = observation.record.at;
		session.recentCalls.push(observation);
		if (session.recentCalls.length > MAX_RECENT_CALLS) session.recentCalls.shift();
		session.batchCalls.push(observation);
		if (session.batchCalls.length > 100) session.batchCalls.shift();
		session.noEvidenceStreak = observation.record.newEvidence ? 0 : session.noEvidenceStreak + 1;
		session.errorStreak = observation.record.status === "error" ? session.errorStreak + 1 : 0;

		const trigger = this.triggerFor(session, config);
		if (trigger) {
			if (session.running) {
				session.pendingTrigger = trigger;
			} else {
				void this.runEpisode(session, trigger);
			}
		}
		this.emit(session);
	}

	runNow(sessionId: string): void {
		const session = this.requireSession(sessionId);
		if (session.status !== "running") throw new Error(t("对话开始后才能分析"));
		if (session.running) throw new Error(t("监督分析正在进行"));
		const calls = session.batchCalls.length > 0 ? [...session.batchCalls] : session.recentCalls.slice(-20);
		if (calls.length === 0) throw new Error(t("还没有可分析的调用"));
		void this.runEpisode(session, "manual", calls);
	}

	statusOf(sessionId: string): SentinelSupervisorStatus | null {
		return this.sessions.get(sessionId)?.status ?? null;
	}

	view(sessionId: string): SentinelSupervisorView | null {
		const session = this.sessions.get(sessionId);
		if (!session || !session.armed) return null;
		return {
			sessionId: session.sessionId,
			sessionPath: session.manager.getSessionFile() ?? null,
			sessionName:
				session.manager.getSessionName()?.trim() || (session.startedAt !== null ? t("对话") : t("新对话")),
			projectId: session.projectId,
			projectName: session.projectName,
			mode: session.mode,
			delivery: session.delivery,
			strategy: session.strategy,
			strategyCustomId: session.strategyCustomId,
			strategyName: session.strategyName,
			strategyInstructions: session.strategyInstructions,
			strategies: session.strategies.map((entry) => ({ ...entry })),
			strategyNote: session.strategyNote,
			status: session.status,
			armedAt: session.armedAt,
			startedAt: session.startedAt,
			endedAt: session.endedAt,
			model: toResolvedModelView(resolveLibraryRole(this.agentDir, "supervisor")),
			state: { ...session.state, tested: [...session.state.tested] },
			episodeCount: session.episodeCount,
			callCount: session.callCount,
			lastEpisodeAt: session.lastEpisodeAt,
			lastCallAt: session.lastCallAt,
			usage: session.usage,
			lastError: session.lastError,
			running: session.running,
			pendingAdvice: session.pendingAdvice,
			recentCalls: session.recentCalls.map((entry) => entry.record),
			logs: session.logs.slice(-MAX_LOGS),
		};
	}

	listAudit(query: SupervisorAuditQuery = {}): SentinelSupervisorAuditPage {
		return this.store.listSessions(query);
	}

	getDetail(sessionId: string): SentinelSupervisorDetail | null {
		return this.store.getDetail(sessionId);
	}

	sendAdvice(sessionId: string, adviceId: string): SentinelSupervisorAdvice {
		const advice = this.store.getAdvice(adviceId);
		if (!advice || advice.sessionId !== sessionId) throw new Error(t("监督建议不存在"));
		if (advice.status === "ignored") throw new Error(t("这条建议已被忽略"));
		if (advice.status === "sent") return advice;
		const sent: SentinelSupervisorAdvice = { ...advice, status: "sent", sentAt: Date.now() };
		this.store.setAdviceStatus(sent.id, "sent", sent.sentAt);
		this.hooks.onSendAdvice(sent);
		this.hooks.onAdvice(sent);
		const session = this.sessions.get(sessionId);
		if (session) {
			if (session.pendingAdvice?.id === sent.id) session.pendingAdvice = null;
			session.lastAdviceAt = sent.sentAt ?? Date.now();
			this.log(session, "advice-sent", sent.text.split("\n")[1] ?? t("监督建议已发送"));
			this.emit(session);
		}
		return sent;
	}

	ignoreAdvice(sessionId: string, adviceId: string): SentinelSupervisorAdvice {
		const advice = this.store.getAdvice(adviceId);
		if (!advice || advice.sessionId !== sessionId) throw new Error(t("监督建议不存在"));
		const ignored: SentinelSupervisorAdvice = { ...advice, status: "ignored" };
		this.store.setAdviceStatus(ignored.id, "ignored", null);
		this.hooks.onAdvice(ignored);
		const session = this.sessions.get(sessionId);
		if (session) {
			if (session.pendingAdvice?.id === ignored.id) session.pendingAdvice = null;
			this.log(session, "advice-ignored", t("操作员忽略了监督建议"));
			this.emit(session);
		}
		return ignored;
	}

	getCallOutput(sessionId: string, callId: string): { text: string; truncated: boolean } {
		const session = this.requireSession(sessionId);
		for (const entry of session.manager.getEntries()) {
			if (entry.type !== "message") continue;
			const message = entry.message as { role?: string; toolCallId?: string; content?: unknown };
			if (message.role !== "toolResult" || message.toolCallId !== callId) continue;
			const text = extractToolResultText({ content: message.content });
			const limit = 200_000;
			return { text: text.slice(0, limit), truncated: text.length > limit };
		}
		throw new Error(t("这次调用的完整输出已不在当前会话文件中"));
	}

	async test(): Promise<SupervisorTestOutcome> {
		const resolved = resolveLibraryRole(this.agentDir, "supervisor");
		if (!resolved) {
			return { result: { ok: false, message: t("尚未配置监督模型，请在 设置 → 模型 里选择一个模型") } };
		}
		const config = readSupervisorConfig(this.agentDir);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
		const started = Date.now();
		try {
			const reply = await this.call(
				{ ...resolved.config, agentDir: this.agentDir, providerId: resolved.entryId },
				buildSupervisorTestInput(),
				controller.signal,
			);
			parseSupervisorEpisode(reply.raw);
			return {
				result: {
					ok: true,
					message: t("监督模型可用，耗时 {ms}ms（{entry} / {model}）", {
						ms: Date.now() - started,
						entry: resolved.entryName,
						model: reply.model,
					}),
				},
				raw: reply.raw.slice(0, 800),
			};
		} catch (error) {
			return {
				result: {
					ok: false,
					message: error instanceof Error ? error.message : String(error),
				},
			};
		} finally {
			clearTimeout(timeout);
		}
	}

	deleteSession(sessionId: string): void {
		this.detach(sessionId);
		this.store.deleteSession(sessionId);
	}

	deleteProject(projectId: string): void {
		for (const session of [...this.sessions.values()]) {
			if (session.projectId === projectId) this.detach(session.sessionId);
		}
		this.store.deleteProject(projectId);
	}

	close(): void {
		this.closed = true;
		for (const session of this.sessions.values()) {
			this.clearRunningTools(session);
			session.inFlight?.abort();
		}
		this.sessions.clear();
		this.store.close();
	}

	private requireSession(sessionId: string): SupervisorSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(t("监督尚未在这个会话上开启"));
		return session;
	}

	private latestState(manager: SessionManager): Partial<PersistedState> {
		// All file entries, not the current branch: a compaction can omit older
		// custom entries from the branch, and the supervisor state is not context.
		const entries = manager.getEntries();
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry.type !== "custom" || entry.customType !== SUPERVISOR_STATE_CUSTOM_TYPE) continue;
			return parsePersistedState(entry.data);
		}
		return {};
	}

	private hasUserMessages(session: SupervisorSession): boolean {
		return session.manager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user");
	}

	private triggerFor(session: SupervisorSession, config: SentinelSupervisorConfig): SentinelSupervisorTrigger | null {
		const lastTen = session.recentCalls.slice(-10);
		const latest = lastTen[lastTen.length - 1];
		if (latest) {
			const duplicates = lastTen.filter((entry) => entry.fingerprint === latest.fingerprint).length;
			if (duplicates >= config.duplicateThreshold) return "duplicate";
		}
		if (session.noEvidenceStreak >= config.noProgressCalls) return "no-progress";
		if (session.errorStreak >= config.errorStreak) return "error-streak";
		if (session.batchCalls.length >= config.batchToolCalls) return "batch";
		return null;
	}

	private async runEpisode(
		session: SupervisorSession,
		trigger: SentinelSupervisorTrigger,
		overrideCalls?: SupervisorObservation[],
	): Promise<void> {
		if (this.closed || session.running || session.status !== "running") return;
		const observations = overrideCalls ?? [...session.batchCalls];
		const calls = observations.map((entry) => entry.record);
		if (calls.length === 0) return;
		const config = readSupervisorConfig(this.agentDir);
		const resolved = resolveLibraryRole(this.agentDir, "supervisor");
		if (!resolved) {
			session.lastError = t("尚未配置监督模型");
			session.pendingTrigger = null;
			session.batchCalls = [];
			this.log(session, "error", session.lastError);
			this.emit(session);
			return;
		}
		session.running = true;
		session.pendingTrigger = null;
		session.lastError = null;
		this.log(session, "trigger", t("开始分析 {count} 次调用（{trigger}）", { count: calls.length, trigger }));
		this.emit(session);
		const started = Date.now();
		const controller = new AbortController();
		session.inFlight = controller;
		const timeoutText = t(
			"监督模型请求超时（{seconds} 秒）；可在 设置 → 模型 → 监督 调大超时、减小每批调用数或换更快的模型",
			{ seconds: Math.round(config.timeoutMs / 1000) },
		);
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error(timeoutText));
		}, config.timeoutMs);
		try {
			const input = buildSupervisorInput({
				trigger,
				state: session.state,
				calls,
				sessionName: this.view(session.sessionId)?.sessionName ?? "对话",
				projectName: session.projectName,
				strategy: session.strategy,
				strategyName: session.strategyName,
				strategyInstructions: session.strategyInstructions,
				strategies: session.strategies,
				strategyNote: session.strategyNote,
			});
			const reply = await this.call(
				{ ...resolved.config, agentDir: this.agentDir, providerId: resolved.entryId },
				input,
				controller.signal,
			);
			// The session may have been deleted or stopped while the model answered.
			if (!this.sessions.has(session.sessionId) || session.status !== "running") return;
			let parsed: ReturnType<typeof parseSupervisorEpisode>;
			try {
				parsed = parseSupervisorEpisode(reply.raw);
			} catch (error) {
				if (reply.finishReason === "length") {
					throw new Error(t("监督模型输出被截断（finish_reason=length）；请减小每批调用数或换更快的模型"));
				}
				throw error;
			}
			const episode: SentinelSupervisorEpisode = {
				id: randomUUID(),
				sessionId: session.sessionId,
				seq: session.episodeSeq + 1,
				at: Date.now(),
				trigger,
				phase: parsed.phase,
				intent: parsed.intent,
				actions: parsed.actions,
				outcomes: parsed.outcomes,
				tested: parsed.tested,
				deadEnds: parsed.deadEnds,
				newEvidence: parsed.newEvidence,
				openQuestions: parsed.openQuestions,
				nextCandidates: parsed.nextCandidates,
				duplicateSignals: parsed.duplicateSignals,
				progress: parsed.progress,
				confidence: parsed.confidence,
				advice: parsed.advice,
				model: reply.model,
				usage: reply.usage,
				error: null,
				durationMs: Date.now() - started,
			};
			session.episodeSeq += 1;
			session.episodeCount += 1;
			session.lastEpisodeAt = episode.at;
			session.usage = {
				input: session.usage.input + reply.usage.input,
				output: session.usage.output + reply.usage.output,
				total: session.usage.total + reply.usage.total,
			};
			this.mergeState(session, episode);
			this.consumeBatch(session, observations);
			session.noEvidenceStreak = 0;
			session.errorStreak = 0;
			session.manager.appendCustomEntry(SUPERVISOR_EPISODE_CUSTOM_TYPE, { episode, calls });
			this.persist(session);
			this.store.insertEpisode({ episode, calls });
			this.upsert(session);
			this.log(
				session,
				"episode",
				`${episode.phase} · ${episode.intent || t("无法判断意图")} · ${episode.progress}`,
			);
			this.hooks.onEpisode(episode, calls);
			this.maybeAdvise(session, episode);
		} catch (error) {
			if (this.closed || !this.sessions.has(session.sessionId) || session.status !== "running") return;
			const message =
				timedOut || controller.signal.aborted
					? timeoutText
					: error instanceof Error
						? error.message
						: String(error);
			session.lastError = message;
			session.episodeSeq += 1;
			session.episodeCount += 1;
			const episode: SentinelSupervisorEpisode = {
				id: randomUUID(),
				sessionId: session.sessionId,
				seq: session.episodeSeq,
				at: Date.now(),
				trigger,
				phase: "unknown",
				intent: "",
				actions: [],
				outcomes: [],
				tested: [],
				deadEnds: [],
				newEvidence: [],
				openQuestions: [],
				nextCandidates: [],
				duplicateSignals: [],
				progress: "unknown",
				confidence: 0,
				advice: null,
				model: resolved.config.modelId,
				usage: null,
				error: message,
				durationMs: Date.now() - started,
			};
			this.consumeBatch(session, observations);
			this.persist(session);
			this.store.insertEpisode({ episode, calls });
			this.upsert(session);
			this.log(session, "error", t("监督分析失败：{message}", { message }));
			this.hooks.onEpisode(episode, calls);
		} finally {
			clearTimeout(timeout);
			session.inFlight = null;
			session.running = false;
			this.emit(session);
			// Calls can arrive while the model is answering; they were kept in the
			// batch, so a fresh batch threshold still gets its own episode.
			const longCallTriggered = session.pendingLongCalls.size > 0;
			const pending = longCallTriggered
				? "long-call"
				: (session.pendingTrigger ??
					(session.status === "running" ? this.triggerFor(session, readSupervisorConfig(this.agentDir)) : null));
			session.pendingTrigger = null;
			if (pending && session.status === "running") {
				const longCalls = [...session.pendingLongCalls.values()];
				session.pendingLongCalls.clear();
				const observations = new Map(
					[...session.batchCalls, ...longCalls].map((entry) => [entry.record.callId, entry]),
				);
				void this.runEpisode(session, pending, [...observations.values()]);
			}
		}
	}

	private clearRunningTools(session: SupervisorSession): void {
		for (const running of session.runningTools.values()) {
			if (running.timer !== null) clearTimeout(running.timer);
		}
		session.runningTools.clear();
		session.pendingLongCalls.clear();
	}

	/** Remove only the calls this episode analyzed; calls that arrived during the model call stay. */
	private consumeBatch(session: SupervisorSession, observations: SupervisorObservation[]): void {
		const analyzed = new Set(observations.map((entry) => entry.record.callId));
		session.batchCalls = session.batchCalls.filter((entry) => !analyzed.has(entry.record.callId));
	}

	private mergeState(session: SupervisorSession, episode: SentinelSupervisorEpisode): void {
		const previous = session.state;
		session.state = {
			phase: episode.phase !== "unknown" ? episode.phase : previous.phase,
			intent: episode.intent || previous.intent,
			progress: episode.progress === "unknown" ? previous.progress : episode.progress,
			tested: mergeTested(previous.tested, episode.tested),
			deadEnds: uniqueStrings(previous.deadEnds, episode.deadEnds, MAX_DEAD_ENDS),
			newEvidence: uniqueStrings(previous.newEvidence, episode.newEvidence, MAX_EVIDENCE),
			openQuestions: episode.openQuestions.slice(0, 20),
			nextCandidates: episode.nextCandidates.slice(0, 10),
			duplicateSignals: episode.duplicateSignals.slice(0, 20),
		};
	}

	private maybeAdvise(session: SupervisorSession, episode: SentinelSupervisorEpisode): void {
		if (session.mode !== "intervene") return;
		const draft: SentinelSupervisorAdviceDraft | null = episode.advice;
		if (!draft?.needed || episode.confidence < 0.45) return;
		if (session.pendingAdvice) return;
		if (Date.now() - session.lastAdviceAt < ADVICE_COOLDOWN_MS) {
			this.log(session, "advice-skip", t("监督建议处于冷却期，未发送"));
			return;
		}
		const text = buildAdviceText(episode);
		const advice: SentinelSupervisorAdvice = {
			id: randomUUID(),
			sessionId: session.sessionId,
			episodeId: episode.id,
			at: Date.now(),
			delivery: session.delivery,
			status: session.delivery === "auto" ? "sent" : "pending",
			text,
			sentAt: session.delivery === "auto" ? Date.now() : null,
		};
		session.lastAdviceAt = advice.at;
		session.adviceCount += 1;
		this.store.insertAdvice(advice);
		this.hooks.onAdvice(advice);
		if (advice.delivery === "auto") {
			this.hooks.onSendAdvice(advice);
			this.log(session, "advice-sent", t("监督建议已自动发送给主 Agent"));
		} else {
			session.pendingAdvice = advice;
			this.log(session, "advice-pending", t("监督建议等待操作员确认"));
		}
		this.upsert(session);
		this.emit(session);
	}

	private persist(session: SupervisorSession): void {
		if (this.closed) return;
		const data: PersistedState = {
			status: session.status,
			mode: session.mode,
			delivery: session.delivery,
			strategy: session.strategy,
			strategyCustomId: session.strategyCustomId,
			strategyName: session.strategyName,
			strategyInstructions: session.strategyInstructions,
			strategies: session.strategies,
			strategyNote: session.strategyNote,
			armedAt: session.armedAt,
			startedAt: session.startedAt,
			endedAt: session.endedAt,
			state: session.state,
			episodeCount: session.episodeCount,
			episodeSeq: session.episodeSeq,
			adviceCount: session.adviceCount,
			callCount: session.callCount,
			lastEpisodeAt: session.lastEpisodeAt,
			lastCallAt: session.lastCallAt,
			usage: session.usage,
			lastError: session.lastError,
		};
		session.manager.appendCustomEntry(SUPERVISOR_STATE_CUSTOM_TYPE, data);
	}

	private upsert(session: SupervisorSession): void {
		this.store.upsertSession(this.auditItem(session));
	}

	private auditItem(session: SupervisorSession): SentinelSupervisorAuditItem {
		const view = this.view(session.sessionId);
		return {
			sessionId: session.sessionId,
			sessionPath: session.manager.getSessionFile() ?? null,
			sessionName: view?.sessionName ?? t("对话"),
			projectId: session.projectId,
			projectName: session.projectName,
			mode: session.mode,
			delivery: session.delivery,
			strategy: session.strategy,
			strategyCustomId: session.strategyCustomId,
			strategyName: session.strategyName,
			strategyInstructions: session.strategyInstructions,
			strategies: session.strategies.map((entry) => ({ ...entry })),
			strategyNote: session.strategyNote,
			status: session.status,
			armedAt: session.armedAt,
			startedAt: session.startedAt,
			endedAt: session.endedAt,
			updatedAt: Date.now(),
			episodeCount: session.episodeCount,
			callCount: session.callCount,
			phase: session.state.phase,
			intent: session.state.intent,
			progress: session.state.progress,
			adviceCount: session.adviceCount,
			usage: session.usage,
			lastError: session.lastError,
		};
	}

	private log(session: SupervisorSession, kind: string, text: string): void {
		if (this.closed) return;
		const log: SentinelSupervisorLog = { at: Date.now(), kind, text: text.slice(0, 1000) };
		session.logs.push(log);
		if (session.logs.length > MAX_LOGS) session.logs.shift();
		this.store.appendLog(session.sessionId, log);
		this.hooks.onLog(session.sessionId, log);
	}

	private emit(session: SupervisorSession): void {
		if (this.closed) return;
		this.hooks.onState(this.view(session.sessionId));
	}
}
