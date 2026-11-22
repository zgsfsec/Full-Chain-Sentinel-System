/** Evidence-backed, read-only reconstructions of conversations and engineering runs. */
export type WorkProcessKind = "session" | "engine";
export type WorkNodeStatus = "unknown" | "running" | "done" | "failed" | "blocked" | "abandoned";
export type WorkEdgeKind = "contains" | "dispatch" | "sequence" | "dependency" | "pivot" | "merge";

export interface WorkProcessRef {
	projectId: string;
	kind: WorkProcessKind;
	id: string;
}

export interface WorkProcessSource extends WorkProcessRef {
	title: string;
	projectName: string;
	updatedAt: number;
	active: boolean;
}

export interface WorkEvidence {
	id: string;
	ownerId: string;
	at: number;
	kind: "user" | "assistant" | "instruction" | "tool_start" | "tool_end" | "status";
	text: string;
	toolCallId?: string;
	toolName?: string;
	status?: "running" | "ok" | "error";
	/** The original session entry or engineering event; never a model-produced locator. */
	entryId: string;
	truncated: boolean;
}

export interface WorkNode {
	id: string;
	ownerId: string;
	parentId: string | null;
	kind: "root" | "agent" | "task" | "goal" | "step";
	title: string;
	intent: string;
	intentBasis: "explicit" | "inferred" | "unknown";
	status: WorkNodeStatus;
	actions: string[];
	outcomes: string[];
	evidenceIds: string[];
	confidence: number | null;
	startedAt: number;
	updatedAt: number;
	revision: number;
}

export interface WorkEdge {
	id: string;
	from: string;
	to: string;
	kind: WorkEdgeKind;
	basis: "recorded" | "inferred";
	reason: string;
	evidenceIds: string[];
}

export interface WorkProcess extends WorkProcessSource {
	enabled: boolean;
	running: boolean;
	error: string | null;
	/** Persisted retry schedule, including history-only runs, cleared by pause or success. */
	retry?: { attempt: number; at: number; once: boolean } | null;
	nodes: WorkNode[];
	edges: WorkEdge[];
	evidence: WorkEvidence[];
	/** Fingerprints of consumed records, keyed by immutable evidence id. */
	consumed: Record<string, string>;
	pending: number;
	/** Learned after output truncation; persisted so retries do not repeat an oversized batch. */
	batchSize?: number;
	compactAnalysis?: boolean;
	revision: number;
	model: string | null;
	usage: { input: number; output: number; total: number };
	lastAnalyzedAt: number | null;
}

export interface WorkProcessItem extends WorkProcessSource {
	enabled: boolean;
	state: "off" | "paused" | "analyzing" | "watching" | "retrying" | "error";
	nodeCount: number;
	pending: number;
	intent: string;
}

export interface WorkLane {
	ownerId: string;
	parentId: string;
	evidence: WorkEvidence[];
}

export interface WorkSourceSnapshot {
	source: WorkProcessSource;
	nodes: WorkNode[];
	edges: WorkEdge[];
	lanes: WorkLane[];
}

export interface WorkRevision {
	revision: number;
	at: number;
	nodes: WorkNode[];
	edges: WorkEdge[];
}
