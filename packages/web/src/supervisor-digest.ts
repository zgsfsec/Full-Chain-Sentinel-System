/**
 * Turn one tool call plus its result into a compact observation.
 *
 * The supervisor never reads full tool output by default: a directory scan or a
 * SQLMap run can be megabytes, and most of it is noise. This module keeps the
 * status, a hash, a head/tail excerpt, and the small number of signals that
 * answer "was this new?" — full output stays in the session JSONL and is
 * fetched by `callId` only when the operator asks for it.
 */

import { createHash } from "node:crypto";
import type { SentinelSupervisorCall } from "./protocol.ts";

const MAX_ARGS = 1_200;
const MAX_EXCERPT = 1_200;
const MAX_SIGNALS = 12;
const MAX_URLS = 12;

/** Tools whose success is itself new evidence, regardless of the text. */
const FINDING_TOOLS = new Set(["vuln_submit", "api_model_submit", "source_model_submit"]);
/** A successful edit/write changes project state, so it is progress even without a new URL. */
const STATE_CHANGE_TOOLS = new Set(["edit", "write"]);

const SECRET_PATTERNS: Array<[RegExp, string]> = [
	// Bearer first: the generic header rule would otherwise consume the word
	// "Bearer" and leave the token itself in the text.
	[/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
	[/\bsk-[A-Za-z0-9_-]{10,}\b/g, "sk-[REDACTED]"],
	[
		/((?:authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;]+)/gi,
		"$1[REDACTED]",
	],
	[/\b(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1$2:[REDACTED]@"],
];

export interface SupervisorDigestInput {
	callId: string;
	toolName: string;
	args: unknown;
	result: unknown;
	isError: boolean;
	durationMs?: number;
	at?: number;
	parentToolCallId?: string;
	redactSecrets: boolean;
	seenEndpoints: Set<string>;
	seenParams: Set<string>;
}

export interface SupervisorDigestResult {
	record: SentinelSupervisorCall;
	fingerprint: string;
}

export interface SupervisorRunningToolInput {
	callId: string;
	toolName: string;
	args: unknown;
	at: number;
	durationMs: number;
	redactSecrets: boolean;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function redact(text: string): string {
	let output = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement);
	return output;
}

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}…`;
}

/** Stable JSON for a fingerprint: object keys sorted, arrays kept in order. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}

function resultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return "";
	const record = result as Record<string, unknown>;
	const parts: string[] = [];
	if (Array.isArray(record.content)) {
		for (const part of record.content) {
			if (!part || typeof part !== "object") continue;
			const item = part as Record<string, unknown>;
			if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
		}
	}
	if (parts.length === 0) {
		if (typeof record.stdout === "string") parts.push(record.stdout);
		if (typeof record.stderr === "string") parts.push(record.stderr);
	}
	if (parts.length === 0 && record.structuredContent !== undefined) {
		try {
			parts.push(JSON.stringify(record.structuredContent));
		} catch {
			// A cyclic structured result is not worth failing the observation for.
		}
	}
	return parts.join("\n");
}

function normalizeUrl(raw: string): string | null {
	const trimmed = raw.replace(/[),.;\]}"']+$/g, "");
	try {
		const url = new URL(trimmed);
		return `${url.origin}${url.pathname}`;
	} catch {
		return null;
	}
}

function extractUrls(text: string): string[] {
	const found = text.match(/https?:\/\/[^\s"'`<>)\]]+/gi) ?? [];
	const unique: string[] = [];
	for (const raw of found) {
		const normalized = normalizeUrl(raw);
		if (normalized && !unique.includes(normalized)) unique.push(normalized);
		if (unique.length >= MAX_URLS) break;
	}
	return unique;
}

function extractParams(text: string): string[] {
	const found = new Set<string>();
	const urlPattern = /https?:\/\/[^\s"'`<>)\]]+/gi;
	for (const raw of text.match(urlPattern) ?? []) {
		const trimmed = raw.replace(/[),.;\]}"']+$/g, "");
		try {
			const url = new URL(trimmed);
			for (const key of url.searchParams.keys()) found.add(key);
		} catch {
			// Not a URL; ignore.
		}
	}
	return [...found];
}

function extractHttpStatus(text: string): number | null {
	const http = /HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(text);
	if (http) return Number(http[1]);
	const json = /"status"\s*:\s*(\d{3})/.exec(text);
	return json ? Number(json[1]) : null;
}

function errorSignal(text: string): string | null {
	const first =
		text
			.split(/\r?\n/)
			.find((line) => line.trim().length > 0)
			?.trim() ?? "";
	if (!first) return null;
	if (/timed?\s*out|timeout/i.test(first)) return "timeout";
	if (/refused|econnrefused|connection reset/i.test(first)) return "connection-error";
	if (/permission denied|forbidden/i.test(first)) return "permission-denied";
	if (/not found/i.test(first)) return "not-found";
	return null;
}

/**
 * Build the compact record. `seenEndpoints`/`seenParams` are updated in place so
 * the caller can tell which calls landed something new.
 */
export function digestToolCall(input: SupervisorDigestInput): SupervisorDigestResult {
	const rawText = stripAnsi(resultText(input.result));
	const text = input.redactSecrets ? redact(rawText) : rawText;
	const argsText = input.redactSecrets
		? redact(truncate(stableStringify(input.args), MAX_ARGS))
		: truncate(stableStringify(input.args), MAX_ARGS);
	const urls = extractUrls(`${argsText}\n${text}`);
	const newEndpoints: string[] = [];
	for (const url of urls) {
		if (input.seenEndpoints.has(url)) continue;
		input.seenEndpoints.add(url);
		newEndpoints.push(url);
	}
	const newParams: string[] = [];
	for (const key of extractParams(`${argsText}\n${text}`)) {
		if (input.seenParams.has(key)) continue;
		input.seenParams.add(key);
		newParams.push(key);
	}
	const httpStatus = extractHttpStatus(text);
	const signals: string[] = [];
	if (httpStatus !== null) signals.push(`http:${httpStatus}`);
	const error = input.isError ? errorSignal(text) : null;
	if (error) signals.push(`error:${error}`);
	if (newEndpoints.length > 0) signals.push(`new-endpoint:${newEndpoints.length}`);
	if (newParams.length > 0) signals.push(`new-param:${newParams.length}`);
	if (FINDING_TOOLS.has(input.toolName) && !input.isError) signals.push("finding");
	if (STATE_CHANGE_TOOLS.has(input.toolName) && !input.isError) signals.push("state-change");
	if (input.parentToolCallId) signals.push("nested");

	const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
	const fingerprint = createHash("sha256")
		.update(`${input.toolName}\n${stableStringify(input.args)}`)
		.digest("hex");
	const head = truncate(text, MAX_EXCERPT);
	const tail = text.length > MAX_EXCERPT ? text.slice(-MAX_EXCERPT) : "";
	return {
		fingerprint,
		record: {
			callId: input.callId,
			at: input.at ?? Date.now(),
			tool: input.toolName,
			args: argsText,
			status: input.isError ? "error" : "ok",
			durationMs: input.durationMs ?? null,
			outputBytes: rawText.length,
			outputHash: hash,
			outputHead: head,
			outputTail: tail,
			httpStatus,
			newEndpoints,
			newParams,
			newEvidence:
				newEndpoints.length > 0 ||
				newParams.length > 0 ||
				(FINDING_TOOLS.has(input.toolName) && !input.isError) ||
				(STATE_CHANGE_TOOLS.has(input.toolName) && !input.isError),
			signals: signals.slice(0, MAX_SIGNALS),
		},
	};
}

/** Describe a still-running call without treating its arguments as observed evidence. */
export function digestRunningToolCall(input: SupervisorRunningToolInput): SupervisorDigestResult {
	const rawArgs = truncate(stableStringify(input.args), MAX_ARGS);
	const args = input.redactSecrets ? redact(rawArgs) : rawArgs;
	const fingerprint = createHash("sha256")
		.update(`${input.toolName}\n${stableStringify(input.args)}`)
		.digest("hex");
	return {
		fingerprint,
		record: {
			callId: input.callId,
			at: input.at,
			tool: input.toolName,
			args,
			status: "running",
			durationMs: input.durationMs,
			outputBytes: 0,
			outputHash: "",
			outputHead: "",
			outputTail: "",
			httpStatus: null,
			newEndpoints: [],
			newParams: [],
			newEvidence: false,
			signals: [],
		},
	};
}
