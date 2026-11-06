import { parseCodeReproductionResult } from "../../src/code-reproduction.ts";
import type { SentinelCodeCommit, SentinelEngine } from "./types.ts";

export interface ReproductionView {
	outcome: "pending" | "running" | "paused" | "confirmed" | "not_reproduced" | "inconclusive" | "failed" | "unreviewed";
	summary: string;
}

export function reproductionView(commit: SentinelCodeCommit, engine: SentinelEngine | undefined): ReproductionView {
	if (engine?.status === "running" || engine?.status === "scheduled") {
		return { outcome: "running", summary: "" };
	}
	if (engine?.status === "paused" || (!engine && commit.reproductionStage === "paused")) {
		return { outcome: "paused", summary: engine?.pauseNote ?? "" };
	}
	if (engine?.status === "completed") {
		const result = parseCodeReproductionResult(engine.reproduction);
		return result ?? { outcome: "unreviewed", summary: "" };
	}
	if (engine?.status === "stopped" || (!engine && commit.reproductionStage === "stopped")) {
		return { outcome: "inconclusive", summary: engine?.pauseNote ?? "" };
	}
	if (commit.error) return { outcome: "failed", summary: commit.error };
	if (commit.reproductionStage === "git") return { outcome: "running", summary: "" };
	if (commit.reproductionStage === "failed") return { outcome: "failed", summary: "" };
	if (commit.engineId) return { outcome: "unreviewed", summary: "" };
	return { outcome: "pending", summary: "" };
}

/** Suggestions guide the operator; the original error is always retained. */
export function reproductionRecovery(error: string): "network" | "auth" | "model" | "environment" | "inspect" {
	if (/模型|model|provider/i.test(error)) return "model";
	if (/401|403|bad credentials|authentication failed|访问令牌|凭据/i.test(error)) return "auth";
	if (/代理|proxy|github api|fetch failed|could not resolve|connection|connect |timed? ?out|超时|网络|TLS|SSL|ENOTFOUND|ECONN/i.test(error)) return "network";
	if (/429|rate.?limit|配额/i.test(error)) return "model";
	if (/容器|docker|构建|build|依赖|dependency|dependencies|not found|找不到|未运行/i.test(error)) return "environment";
	return "inspect";
}
