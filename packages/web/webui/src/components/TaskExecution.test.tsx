import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SentinelEngineTaskStatus, SentinelSubagentEvent } from "../types.ts";
import { TaskExecution } from "./TaskExecution.tsx";

function render(events: SentinelSubagentEvent[], status: SentinelEngineTaskStatus = "running") {
	return renderToStaticMarkup(<TaskExecution events={events} status={status} />);
}

test("one tool call renders as one step with its arguments, result and duration", () => {
	const html = render([
		{ seq: 1, at: 100, kind: "tool_start", toolCallId: "call-1", toolName: "read", args: { path: "/work/report.md" } },
		{ seq: 2, at: 200, kind: "tool_end", toolCallId: "call-1", toolName: "read", output: "raw <script>content</script>", durationMs: 100 },
		{ seq: 3, at: 201, kind: "turn", text: "第 1 轮" },
	]);
	expect(html.match(/<details/g)).toHaveLength(1);
	expect(html).toContain("执行过程 · 1 步");
	expect(html).toContain("/work/report.md");
	expect(html).toContain("raw &lt;script&gt;content&lt;/script&gt;");
	expect(html).toContain("100ms");
	expect(html).toContain("成功");
});

test("complete Markdown text, thoughts and retained results remain available for inspection", () => {
	const longText = `${"上下文".repeat(100)}\n\n**最后的结论**`;
	const html = render([
		{ seq: 1, at: 1, kind: "thinking", text: "**评估证据**" },
		{ seq: 2, at: 2, kind: "text", text: longText },
		{ seq: 3, at: 3, kind: "tool_end", toolCallId: "orphan", toolName: "read", output: "Permission denied", isError: true, truncated: true },
	]);
	expect(html).toContain("<strong>最后的结论</strong>");
	expect(html).toContain("<strong>评估证据</strong>");
	expect(html).toContain("Permission denied");
	expect(html).toContain("1 个失败");
	expect(html).toContain("输出已截断");
	expect(html).not.toContain("<details open");
});

test("an unfinished tool does not appear to be running after the task stops", () => {
	const events: SentinelSubagentEvent[] = [{ seq: 1, at: 1, kind: "tool_start", toolName: "read", toolCallId: "pending" }];
	expect(render(events, "running")).toContain("执行中");
	for (const status of ["done", "paused", "aborted", "failed", "blocked"] as const) {
		const html = render(events, status);
		expect(html).toContain("未完成");
		expect(html).not.toContain("执行中");
	}
});

test("long logs have an explicit way to inspect earlier steps", () => {
	const events: SentinelSubagentEvent[] = Array.from({ length: 80 }, (_, index) => ({
		seq: index + 1, at: index + 1, kind: "text", text: `record-${index + 1}-end`,
	}));
	const html = render(events, "done");
	expect(html).toContain("查看更早的步骤（20）");
	expect(html).toContain("显示 60 / 80 条步骤");
	expect(html).toContain("record-21-end");
	expect(html).toContain("record-80-end");
	expect(html).not.toContain("record-1-end");
});

test("empty queued tasks explain where progress will appear", () => {
	expect(render([], "queued")).toContain("任务排队中，启动后会在这里显示执行步骤。");
});
