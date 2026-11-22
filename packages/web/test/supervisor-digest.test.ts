/**
 * The observation digest: secrets are redacted, result text stays bounded, and
 * endpoint/parameter novelty is what the no-progress trigger reads.
 */

import { describe, expect, test } from "vitest";
import { digestRunningToolCall, digestToolCall, redact } from "../src/supervisor-digest.ts";

function digest(text: string, overrides: Partial<Parameters<typeof digestToolCall>[0]> = {}) {
	const seenEndpoints = overrides.seenEndpoints ?? new Set<string>();
	const seenParams = overrides.seenParams ?? new Set<string>();
	return digestToolCall({
		callId: "call-1",
		toolName: "bash",
		args: { command: "curl -s 'http://target/api/user?id=1%27'" },
		result: { content: [{ type: "text", text }] },
		isError: false,
		durationMs: 120,
		redactSecrets: true,
		seenEndpoints,
		seenParams,
		...overrides,
	});
}

describe("digestToolCall", () => {
	test("records status, endpoint and parameter novelty", () => {
		const { record } = digest("HTTP/1.1 200 OK\nhttps://target/api/user?id=1");
		expect(record.httpStatus).toBe(200);
		expect(record.newEndpoints).toContain("https://target/api/user");
		expect(record.newEndpoints.length).toBeGreaterThan(0);
		expect(record.newParams).toEqual(["id"]);
		expect(record.newEvidence).toBe(true);
		expect(record.signals).toContain("http:200");
	});

	test("does not call the same endpoint new twice", () => {
		const seenEndpoints = new Set<string>();
		const seenParams = new Set<string>();
		const first = digest("https://target/api/user?id=1", { seenEndpoints, seenParams });
		const second = digest("https://target/api/user?id=2", { seenEndpoints, seenParams });
		expect(first.record.newEvidence).toBe(true);
		expect(second.record.newEndpoints).toEqual([]);
		expect(second.record.newParams).toEqual([]);
		expect(second.record.newEvidence).toBe(false);
	});

	test("redacts headers and bearer tokens from args and output", () => {
		const { record } = digest("Authorization: Bearer super-secret-token\nhttps://target/x?token=abc");
		expect(record.args).not.toContain("super-secret");
		expect(record.outputHead).not.toContain("super-secret-token");
		expect(record.outputHead).toContain("[REDACTED]");
	});

	test("keeps a stable fingerprint across object key order", () => {
		const one = digest("", { args: { a: 1, b: 2 } });
		const two = digest("", { args: { b: 2, a: 1 } });
		expect(one.fingerprint).toBe(two.fingerprint);
	});

	test("marks errors and keeps a null HTTP status when none is present", () => {
		const { record } = digest("connection refused", { isError: true });
		expect(record.status).toBe("error");
		expect(record.httpStatus).toBeNull();
		expect(record.signals).toContain("error:connection-error");
	});
});

test("running-call summaries redact secrets without treating intended requests as evidence", () => {
	const { record } = digestRunningToolCall({
		callId: "call-running",
		toolName: "bash",
		args: { command: "curl -H 'Authorization: Bearer super-secret-token' https://target/api" },
		at: 1_700_000_000_000,
		durationMs: 30_000,
		redactSecrets: true,
	});
	expect(record.status).toBe("running");
	expect(record.args).not.toContain("super-secret-token");
	expect(record.durationMs).toBe(30_000);
	expect(record.newEvidence).toBe(false);
	expect(record.newEndpoints).toEqual([]);
});

test("redact leaves ordinary text alone", () => {
	expect(redact("nmap -sV 10.0.0.1")).toBe("nmap -sV 10.0.0.1");
});
