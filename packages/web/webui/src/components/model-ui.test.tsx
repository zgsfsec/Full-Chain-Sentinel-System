/**
 * The 守门模型 concurrency test's result on 设置 → 模型 · 角色分配.
 *
 * The operator reads it to decide whether the model can gate commands in AI
 * approval mode, so it has to show the two things the test measures, and a
 * failure has to say what is at stake and why each judgment failed.
 */

import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { JudgeLoadTestReport } from "./model-ui.tsx";

const HINT = "您配置的模型可能无法成功进行 AI 审批守门";

type Outcome = ComponentProps<typeof JudgeLoadTestReport>["outcome"];

function report(outcome: Outcome): string {
	return renderToStaticMarkup(<JudgeLoadTestReport outcome={outcome} />);
}

test("a passed test shows the success rate and the latency", () => {
	const html = report({
		result: { ok: true, message: "守门模型并发测试通过" },
		load: {
			concurrency: 10,
			succeeded: 10,
			latencyMs: { min: 900, median: 1500, avg: 1800, max: 4200 },
			failures: [],
		},
	});
	expect(html).toContain("ant-alert-success");
	expect(html).toContain("测试成功 · 守门模型并发测试通过");
	expect(html).toContain("成功率 10/10 · 延迟：平均 1.8s，最慢 4.2s");
	expect(html).not.toContain(HINT);
	expect(html).not.toContain("失败原因");
});

test("a failed test says what is at stake, and why each judgment failed", () => {
	const html = report({
		result: { ok: false, message: "守门模型并发测试未通过", detail: HINT },
		load: {
			concurrency: 10,
			succeeded: 7,
			latencyMs: { min: 1100, median: 1300, avg: 1250, max: 1400 },
			failures: ["守门判定超时（15000ms）", "守门判定超时（15000ms）", "HTTP 429"],
		},
	});
	expect(html).toContain("ant-alert-error");
	expect(html).toContain("测试失败 · 守门模型并发测试未通过");
	expect(html).toContain("成功率 7/10 · 延迟：平均 1.3s，最慢 1.4s");
	expect(html).toContain(HINT);
	// The same reason is listed once, with how many judgments it took down.
	expect(html).toContain("失败原因：守门判定超时（15000ms） × 2；HTTP 429");
});

test("no latency is shown when no judgment answered, and no answer at all is an error", () => {
	const none = report({
		result: { ok: false, message: "守门模型并发测试未通过", detail: HINT },
		load: { concurrency: 10, succeeded: 0, failures: Array(10).fill("connection refused") },
	});
	expect(none).toContain("成功率 0/10");
	expect(none).not.toContain("延迟");
	expect(none).toContain("connection refused × 10");

	const unanswered = report(null);
	expect(unanswered).toContain("ant-alert-error");
	expect(unanswered).toContain("无响应");
	expect(unanswered).toContain("没有收到测试结果，请重试。");
});

test("an answer without a report, such as no model behind the role, still shows its verdict", () => {
	const html = report({ result: { ok: false, message: "没有可用的守门模型", detail: "在 设置 → 模型 里给「守门模型」选一条模型，或让它跟随主模型" } });
	expect(html).toContain("测试失败 · 没有可用的守门模型");
	expect(html).toContain("选一条模型，或让它跟随主模型");
	expect(html).not.toContain("成功率");
});
