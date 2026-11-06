import { expect, test } from "vitest";
import { reproductionRecovery, reproductionView } from "./code-reproduction.ts";
import type { SentinelCodeCommit, SentinelEngine } from "./types.ts";

const commit: SentinelCodeCommit = {
	id: "c", monitorId: "m", projectId: "p", branch: "main", sha: "abcdef0", shortSha: "abcdef0", title: "fix", message: "fix", author: "dev", authoredAt: 1, url: "https://github.com/example/repo/commit/abcdef0", verdict: "security", confidence: 1, cve: null, severity: "high", vulnType: "SSRF", vulnCategory: "web", vulnTags: [], reason: "fix", status: "dispatched", reproductionStage: "completed", engineId: "e", duplicateOf: null, error: null, additions: 1, deletions: 1, files: 1, diff: null, createdAt: 1, judgedAt: 1,
};
const engine: SentinelEngine = {
	id: "e", projectId: "p", projectName: "P", name: "reproduction", status: "completed", pauseNote: null, targets: [], doctrines: ["oss-1day-repro"], presetIds: [], presetOptional: true, limits: { concurrency: 1, roundLimit: 2, tokenLimit: null, timeLimitMin: null, maxRetries: 1 }, gateMode: "auto", createdAt: 1, startedAt: 1, endedAt: 2, schedule: null, report: "复现成功 confirmed", tasks: [],
};

test("completed reports, keywords and a missing engine never imply a reproduced vulnerability", () => {
	expect(reproductionView(commit, engine).outcome).toBe("unreviewed");
	expect(reproductionView(commit, undefined).outcome).toBe("unreviewed");
});

test.each(["confirmed", "not_reproduced", "inconclusive", "failed"] as const)("completed engines use the explicit %s conclusion", (outcome) => {
	expect(reproductionView(commit, { ...engine, reproduction: { outcome, summary: "comparison", pocPath: "/work/poc.py", vulnerableEvidence: "triggered", fixedEvidence: "rejected" } })).toEqual({ outcome, summary: "comparison", pocPath: "/work/poc.py", vulnerableEvidence: "triggered", fixedEvidence: "rejected" });
});

test("live engine lifecycle takes precedence over stale source preparation stages and errors", () => {
	const stale = { ...commit, reproductionStage: "git" as const, error: "previous clone failure" };
	expect(reproductionView(stale, engine).outcome).toBe("unreviewed");
	expect(reproductionView(stale, { ...engine, status: "running" }).outcome).toBe("running");
	expect(reproductionView(stale, { ...engine, status: "paused", pauseNote: "rate limit" })).toEqual({ outcome: "paused", summary: "rate limit" });
	expect(reproductionView(stale, { ...engine, status: "stopped" }).outcome).toBe("inconclusive");
});

test("source preparation failures retain the error and no work stays pending", () => {
	expect(reproductionView({ ...commit, engineId: null, reproductionStage: "failed", error: "fetch failed" }, undefined)).toEqual({ outcome: "failed", summary: "fetch failed" });
	expect(reproductionView({ ...commit, engineId: null, reproductionStage: null }, undefined).outcome).toBe("pending");
	expect(reproductionView({ ...commit, engineId: null, reproductionStage: "git" }, undefined).outcome).toBe("running");
});

test.each([
	["GitHub API 请求失败：fetch failed, ECONNREFUSED", "network"],
	["GitHub API 429 rate limit", "network"],
	["GitHub 401 Bad credentials", "auth"],
	["模型调用失败 401", "model"],
	["provider 404 page not found", "model"],
	["Docker build dependency missing", "environment"],
	["Unexpected exit 7", "inspect"],
])("recovery guidance for %s opens the relevant settings", (error, expected) => {
	expect(reproductionRecovery(error)).toBe(expected);
});
