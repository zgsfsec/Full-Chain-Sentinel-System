/**
 * The operator's manual status for a session.
 *
 * Ten tasks in flight are indistinguishable in a list sorted by time: which one
 * still needs a nudge, and which one is already done and can be forgotten. The
 * status is stored as a `custom` session entry (`zg-status`), the same place the
 * persistent goal keeps its state, so it travels with the conversation, survives
 * a restart, and is inherited by a fork.
 *
 * It is a `custom` entry and not a `custom_message`, so it never enters the
 * model's context: the agent has no business reacting to a label the operator
 * put on the conversation.
 */

import type { SessionInfo } from "@earendil-works/pi-coding-agent";

export const SESSION_STATUS_CUSTOM_TYPE = "zg-status";

export type SentinelSessionStatus = "todo" | "active" | "done" | "ignored";

/** The order the picker lists the statuses in. */
export const SESSION_STATUSES: readonly SentinelSessionStatus[] = ["todo", "active", "done", "ignored"];

export const SESSION_STATUS_LABELS: Record<SentinelSessionStatus, string> = {
	todo: "待跟进",
	active: "进行中",
	done: "已完成",
	ignored: "已忽略",
};

export function isSessionStatus(value: unknown): value is SentinelSessionStatus {
	return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

/** The status a `zg-status` entry carries; `null` data clears it. */
export function sessionStatusFromEntry(data: unknown): SentinelSessionStatus | undefined {
	if (data === null || typeof data !== "object") return undefined;
	const status = (data as { status?: unknown }).status;
	return isSessionStatus(status) ? status : undefined;
}

/** The status set by the last `zg-status` entry on a branch, if any. */
export function readSessionStatus(entries: readonly unknown[]): SentinelSessionStatus | null {
	let found: SentinelSessionStatus | null = null;
	for (const entry of entries) {
		const value = entry as { type?: string; customType?: string; data?: unknown };
		if (value.type !== "custom" || value.customType !== SESSION_STATUS_CUSTOM_TYPE) continue;
		found = sessionStatusFromEntry(value.data) ?? null;
	}
	return found;
}

/** Which engineering task a session belongs to, for the sidebar's engine badge. */
export interface SentinelSessionEngineRef {
	engineId: string;
	engineName: string;
	taskStatus: string;
}

/** A listed session with its operator status, without the raw custom state. */
export interface SentinelSessionListEntry extends Omit<SessionInfo, "customState" | "allMessagesText"> {
	status?: SentinelSessionStatus;
	/** Present when this session is an engineering task's conversation. */
	engine?: SentinelSessionEngineRef;
}

/** Drop `customState` from a listed session and surface the status it holds. */
export function withSessionStatus(info: SessionInfo): SentinelSessionListEntry {
	// The sidebar needs metadata and the first prompt, never the full transcript.
	const { customState, allMessagesText: _allMessagesText, ...rest } = info;
	const status = customState ? sessionStatusFromEntry(customState[SESSION_STATUS_CUSTOM_TYPE]) : undefined;
	return status ? { ...rest, status } : rest;
}
