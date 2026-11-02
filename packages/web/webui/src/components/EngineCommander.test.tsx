import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SentinelSubagentEvent } from "../types.ts";
import { CommanderFeed } from "./EngineCommander.tsx";

function render(events: SentinelSubagentEvent[]) {
	return renderToStaticMarkup(<CommanderFeed engineId="eng-1" project={null} status="running" events={events} onSend={() => {}} />);
}

test("commander messages render Markdown headings, lists, tables, fences and links", () => {
	const html = render([{ seq: 1, at: 1, kind: "text", text: "## 排查结论\n\n**高危**\n\n- 核对接口\n\n| 目标 | 结果 |\n| --- | --- |\n| 登录 | 通过 |\n\n```bash\nprintf 'hello'\n```\n\n[报告](https://example.com/report)" }]);
	expect(html).toContain("<h2>排查结论</h2>");
	expect(html).toContain("<strong>高危</strong>");
	expect(html).toContain("<li>核对接口</li>");
	expect(html).toContain("<table>");
	expect(html).toContain('class="language-bash"');
	const link = html.match(/<a\s[^>]*>/)?.[0];
	expect(link).toContain('href="https://example.com/report"');
	expect(link).toContain('target="_blank"');
	expect(link).toContain('rel="noreferrer"');
});

test("model HTML and unsafe links cannot execute in the commander feed", () => {
	const html = render([{ seq: 1, at: 1, kind: "text", text: '<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n<img src=x onerror=alert(1)>' }]);
	expect(html).not.toContain("<script>");
	expect(html).not.toContain("<img src=x");
	expect(html).not.toContain('href="javascript:');
});

test("thoughts render Markdown while tool output and operator input retain literal text", () => {
	const html = render([
		{ seq: 1, at: 1, kind: "thinking", text: "**先验证范围**" },
		{ seq: 2, at: 2, kind: "text", from: "operator", text: "**保留我的原文**" },
		{ seq: 3, at: 3, kind: "tool_end", toolName: "read", output: "**原始输出**\n<script>x</script>" },
	]);
	expect(html).toContain("<strong>先验证范围</strong>");
	expect(html).toContain("**保留我的原文**");
	expect(html).toContain("**原始输出**");
	expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
	expect(html).not.toContain("<details open");
});
