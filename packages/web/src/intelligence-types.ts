import type { SentinelEngineLimits } from "./protocol.ts";

export interface IntelligenceEventInput {
	event_id: string;
	indicator: { type: "ip"; value: string };
	occurred_at: string;
	category: string;
	severity: "info" | "low" | "medium" | "high" | "critical";
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
	/** Platform-only alert metadata; never included in engineering input. */
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

/** Internal batch context; only IPs are exported as engineering input. */
export interface IntelligenceEngineInput {
	attemptId: string;
	batchId: string;
	template: IntelligenceTemplate;
	items: IntelligenceBatchItem[];
}

export const DEFAULT_INTELLIGENCE_TEMPLATE: IntelligenceTemplate = {
	id: "threat-ip-analysis",
	name: "威胁溯源反制",
	prompt:
		"分析设备上报的威胁 IP 尝试溯源反制，主动尝试渗透测试反制攻击者 IP 和对攻击者 IP 进行查询，尽量多的获取攻击者信息。",
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
