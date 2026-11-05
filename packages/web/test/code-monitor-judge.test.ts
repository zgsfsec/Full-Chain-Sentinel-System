import { describe, expect, it } from "vitest";
import type { GithubCommitDetail } from "../src/code-host.ts";
import {
	buildJudgePrompt,
	CODE_MONITOR_SYSTEM_PROMPT,
	normalizeAdvisoryId,
	parseMonitorVerdict,
} from "../src/code-monitor-judge.ts";

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
				vuln_category: "web",
				vuln_tags: ["path-traversal", "file-read"],
				title: "压缩包路径穿越",
				reason: "src/zip.ts 增加了规范化检查",
			}),
		);
		expect(verdict.security).toBe(true);
		expect(verdict.cve).toBe("CVE-2024-12345");
		expect(verdict.severity).toBe("high");
		expect(verdict.confidence).toBeCloseTo(0.86);
		expect(verdict.vulnCategory).toBe("web");
		expect(verdict.vulnTags).toEqual(["path-traversal", "file-read"]);
	});

	it("tolerates a fenced answer and clamps confidence", () => {
		const verdict = parseMonitorVerdict('```json\n{"security": false, "confidence": 9, "reason": "只是重构"}\n```');
		expect(verdict.security).toBe(false);
		expect(verdict.confidence).toBe(1);
		expect(verdict.cve).toBeNull();
	});

	it("drops an invented advisory id", () => {
		const verdict = parseMonitorVerdict(
			JSON.stringify({
				security: true,
				confidence: 0.7,
				cve: "CVE-2024-1",
				vuln_category: "other",
				vuln_tags: ["other"],
				reason: "x",
			}),
		);
		expect(verdict.cve).toBeNull();
	});

	it("normalizes and deduplicates explicit labels without accepting tags from another category", () => {
		const verdict = parseMonitorVerdict(
			JSON.stringify({
				security: true,
				vuln_category: "memory",
				vuln_tags: [
					"释放后使用",
					"use-after-free",
					"out-of-bounds-write",
					" RCE ",
					"SQL 注入",
					"invented",
					7,
					"other",
				],
				reason: "src/cache.c 使用释放后的对象，并缺少边界检查；diff 显示攻击者可控制函数指针",
			}),
		);
		expect(verdict.vulnCategory).toBe("memory");
		expect(verdict.vulnTags).toEqual(["use-after-free", "out-of-bounds-write", "rce"]);
	});

	it.each([undefined, null, "ssrf", [], ["invented"], ["use-after-free"]])(
		"rejects security verdicts without usable detailed tags: %j",
		(tags) => {
			expect(() =>
				parseMonitorVerdict(
					JSON.stringify({
						security: true,
						vuln_category: "web",
						vuln_tags: tags,
						reason: "fix",
					}),
				),
			).toThrow("vuln_tags");
		},
	);

	it("clears detailed tags on non-security verdicts", () => {
		const verdict = parseMonitorVerdict(
			JSON.stringify({
				security: false,
				vuln_category: "web",
				vuln_tags: ["ssrf"],
				reason: "只是测试变更",
			}),
		);
		expect(verdict.vulnTags).toEqual([]);
	});

	it("rejects a security verdict without a usable category", () => {
		expect(() =>
			parseMonitorVerdict('{"security": true, "confidence": 0.9, "reason": "x", "vuln_category": "web2"}'),
		).toThrow();
		expect(() => parseMonitorVerdict('{"security": true, "confidence": 0.9, "reason": "x"}')).toThrow();
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
	it("requires diff evidence for detailed types and impact tags", () => {
		expect(CODE_MONITOR_SYSTEM_PROMPT).toContain("vuln_tags");
		expect(CODE_MONITOR_SYSTEM_PROMPT).toContain("use-after-free=释放后使用");
		expect(CODE_MONITOR_SYSTEM_PROMPT).toContain("不因越界写就推断 RCE");
	});
	it("carries metadata, the message and the diff", () => {
		const prompt = buildJudgePrompt({ owner: "acme", repo: "app", host: "github.com" }, commit, "@@ -1 +1 @@");
		expect(prompt).toContain("github.com/acme/app");
		expect(prompt).toContain("0123456789ab");
		expect(prompt).toContain("escape archive entry names");
		expect(prompt).toContain("src/zip.ts");
		expect(prompt).toContain("@@ -1 +1 @@");
	});
});
