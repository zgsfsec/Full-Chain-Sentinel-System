import { describe, expect, it } from "vitest";
import type { GithubCommitDetail } from "../src/code-host.ts";
import { buildJudgePrompt, normalizeAdvisoryId, parseMonitorVerdict } from "../src/code-monitor-judge.ts";

const commit: GithubCommitDetail = {
	sha: "0123456789abcdef0123456789abcdef01234567",
	message: "fix: escape archive entry names",
	author: "dev",
	authoredAt: 1_700_000_000_000,
	url: "https://github.com/acme/app/commit/0123456",
	parents: 1,
	parentSha: "89abcdef0123456789abcdef0123456789abcdef",
	additions: 3,
	deletions: 1,
	files: [{ filename: "src/zip.ts", status: "modified", additions: 3, deletions: 1, patch: "@@" }],
};

describe("parseMonitorVerdict", () => {
	it("accepts a security verdict with an advisory id", () => {
		const verdict = parseMonitorVerdict(
			JSON.stringify({
				security: true,
				confidence: 0.86,
				cve: "cve-2024-12345",
				severity: "HIGH",
				vuln_type: "路径穿越",
				title: "压缩包路径穿越",
				reason: "src/zip.ts 增加了规范化检查",
			}),
		);
		expect(verdict.security).toBe(true);
		expect(verdict.cve).toBe("CVE-2024-12345");
		expect(verdict.severity).toBe("high");
		expect(verdict.confidence).toBeCloseTo(0.86);
	});

	it("tolerates a fenced answer and clamps confidence", () => {
		const verdict = parseMonitorVerdict('```json\n{"security": false, "confidence": 9, "reason": "只是重构"}\n```');
		expect(verdict.security).toBe(false);
		expect(verdict.confidence).toBe(1);
		expect(verdict.cve).toBeNull();
	});

	it("drops an invented advisory id", () => {
		const verdict = parseMonitorVerdict(
			JSON.stringify({ security: true, confidence: 0.7, cve: "CVE-2024-1", reason: "x" }),
		);
		expect(verdict.cve).toBeNull();
	});

	it("rejects a verdict without security or reason", () => {
		expect(() => parseMonitorVerdict('{"confidence": 0.5, "reason": "x"}')).toThrow();
		expect(() => parseMonitorVerdict('{"security": true, "confidence": 0.5}')).toThrow();
	});
});

describe("normalizeAdvisoryId", () => {
	it("accepts CVE and GHSA, rejects free text", () => {
		expect(normalizeAdvisoryId("CVE-2023-44487")).toBe("CVE-2023-44487");
		expect(normalizeAdvisoryId("ghsa-xxxx-yyyy-zzzz")).toBe("GHSA-XXXX-YYYY-ZZZZ");
		expect(normalizeAdvisoryId("see advisory")).toBeNull();
	});
});

describe("buildJudgePrompt", () => {
	it("carries metadata, the message and the diff", () => {
		const prompt = buildJudgePrompt({ owner: "acme", repo: "app", host: "github.com" }, commit, "@@ -1 +1 @@");
		expect(prompt).toContain("github.com/acme/app");
		expect(prompt).toContain("0123456789ab");
		expect(prompt).toContain("escape archive entry names");
		expect(prompt).toContain("src/zip.ts");
		expect(prompt).toContain("@@ -1 +1 @@");
	});
});
