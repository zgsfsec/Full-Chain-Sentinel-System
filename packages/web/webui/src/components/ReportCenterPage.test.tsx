import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { ReportDetail } from "../../../src/report-types.ts";
import { ReportCenterPage, ReportMarkdown } from "./ReportCenterPage.tsx";

const report: ReportDetail = {
	id: "report1", title: "测试报告", projectId: "p1", projectName: "项目", source: "goal", sessionName: "评估会话",
	createdAt: "2026-11-06T00:00:00Z", size: 100, imageCount: 1,
	images: [{ id: "image1", source: "/work/proof.png", filename: "image1.png", mimeType: "image/png", size: 1 }],
	markdown: "# 结果\n\n| 目标 | 结论 |\n| --- | --- |\n| 靶场 | 无确认漏洞 |\n\n```html\n<script>alert(1)</script>\n```\n\n![截图](/work/proof.png)\n\n![外链](https://tracker.example/a.png)\n\n[危险](javascript:alert)\n\n<script>alert(2)</script>",
};

test("preview renders GFM tables and inert code with only archived image URLs", () => {
	const html = renderToStaticMarkup(createElement(ReportMarkdown, { report }));
	expect(html).toContain("<h1>结果</h1>");
	expect(html).toContain('class="report-markdown__table"');
	expect(html).toContain("<td>无确认漏洞</td>");
	expect(html).toContain("/api/reports/report1/images/image1?projectId=p1");
	expect(html).not.toContain('src="https://tracker');
	expect(html).toContain("图片未归档");
	expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	expect(html).not.toContain("<script>");
	expect(html).not.toContain('href="javascript:');
});

test("without projects the report center explains where reports will appear", () => {
	const html = renderToStaticMarkup(createElement(ReportCenterPage, { projects: [], projectId: null }));
	expect(html).toContain("报告中心");
	expect(html).toContain("创建项目后");
	expect(html).toContain("容器停止后仍可查阅");
});
