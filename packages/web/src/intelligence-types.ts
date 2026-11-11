import type { SentinelEngineLimits } from "./protocol.ts";

export interface IntelligenceEventInput {
	event_id: string;
	indicator: { type: "ip"; value: string };
	occurred_at: string;
	category: string;
	severity: "info" | "low" | "medium" | "high" | "critical";
	evidence: Record<string, unknown>;
}

export interface IntelligencePush {
	schema_version: 1;
	request_id: string;
	events: IntelligenceEventInput[];
}

export interface IntelligenceReceipt {
	requestId: string;
	accepted: number;
	duplicates: number;
	newIps: number;
}

export interface IntelligenceSource {
	id: string;
	projectId: string;
	name: string;
	enabled: boolean;
	createdAt: number;
	lastReceivedAt: number | null;
}

export interface IntelligenceTemplate {
	id: string;
	name: string;
	prompt: string;
	limits: SentinelEngineLimits;
}

export interface IntelligencePolicy {
	enabled: boolean;
	threshold: number;
	batchSize: number;
	concurrency: number;
	cooldownMinutes: number;
	template: IntelligenceTemplate;
}

export type IntelligenceBatchStatus =
	| "queued"
	| "creating"
	| "running"
	| "paused"
	| "succeeded"
	| "failed"
	| "aborted"
	| "discarded";

export interface IntelligenceAlert extends IntelligenceEventInput {
	seq: number;
	sourceId: string;
	sourceName: string;
	receivedAt: number;
}

export interface IntelligenceBatchItem {
	ip: string;
	throughSeq: number;
	alertCount: number;
	/** Latest evidence samples; the full log remains queryable in the project. */
	alerts: IntelligenceAlert[];
}

export interface IntelligenceAttempt {
	id: string;
	batchId: string;
	number: number;
	engineId: string | null;
	status: IntelligenceBatchStatus;
	error: string | null;
	createdAt: number;
}

export interface IntelligenceBatch {
	id: string;
	projectId: string;
	status: IntelligenceBatchStatus;
	createdAt: number;
	template: IntelligenceTemplate;
	policy: Omit<IntelligencePolicy, "template">;
	items: IntelligenceBatchItem[];
	attempts: IntelligenceAttempt[];
}

export interface IntelligenceIndicator {
	ip: string;
	count: number;
	sources: string[];
	firstSeen: number;
	lastSeen: number;
	cooldownUntil: number;
	pending: number;
	batchId: string | null;
	status: "pending" | "processing" | "cooling" | "processed" | "attention";
}

export interface IntelligencePage<T> {
	items: T[];
	total: number;
	page: number;
	pageSize: number;
}

export interface IntelligenceCleanup {
	sourceId?: string;
	/** Receipt time, milliseconds since epoch, inclusive. */
	before?: number;
	after?: number;
}

/** Persisted in the engine database as well as the source batch. */
export interface IntelligenceEngineInput {
	attemptId: string;
	batchId: string;
	template: IntelligenceTemplate;
	items: IntelligenceBatchItem[];
}

export const DEFAULT_INTELLIGENCE_TEMPLATE: IntelligenceTemplate = {
	id: "threat-ip-analysis",
	name: "威胁 IP 分析",
	prompt:
		"分析设备上报的威胁 IP 和告警证据。区分事实和推断，标明来源、时间及不确定性，输出逐 IP 摘要、跨 IP 关联和防御建议。",
	limits: { concurrency: 1, roundLimit: 5, tokenLimit: null, timeLimitMin: 30, maxRetries: 0 },
};

export const DEFAULT_INTELLIGENCE_POLICY: IntelligencePolicy = {
	enabled: false,
	threshold: 20,
	batchSize: 50,
	concurrency: 1,
	cooldownMinutes: 1440,
	template: DEFAULT_INTELLIGENCE_TEMPLATE,
};
