/**
 * Render smoke test for the vulnerability hub.
 *
 * The hub is read-mostly: the list states what was submitted and how it was
 * reviewed, and the detail pane is where the operator's decision is recorded.
 * What is pinned here: the totals and severity counts, the row content, the
 * review calibration chips, the active filters as removable chips, the delete
 * confirmation's counts, and the detail pane's provenance and review opinion.
 *
 * Both the delete dialog and the detail drawer render inline (`getContainer`
 * false), so a static render contains their content and this test can read it.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type {
	SentinelEngine,
	SentinelVulnerability,
	SentinelVulnFilters,
	SentinelVulnStats,
	SentinelVulnSummary,
	SessionInfoView,
} from "../types.ts";
import { VulnDeleteBody, VulnDetailBody, VulnPage } from "./VulnPage.tsx";

const stats: SentinelVulnStats = {
	total: 2,
	bySeverity: { critical: 0, high: 2, medium: 0, low: 0, info: 0 },
	byStatus: { pending: 2, confirmed: 0, false_positive: 0, fixed: 0 },
};

function summary(overrides: Partial<SentinelVulnSummary> = {}): SentinelVulnSummary {
	return {
		id: "v1",
		label: "E2E-0001",
		number: 1,
		projectId: "p1",
		projectName: "靶场",
		sessionId: "s1",
		sessionName: "10.0.0.5 侦察",
		engineId: "e1",
		taskId: "t1",
		source: "工程任务「内网打点」",
		title: "未授权访问",
		severity: "high",
		cvss: 7.5,
		status: "pending",
		target: "10.0.0.5",
		description: "描述",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		severityMismatch: false,
		review: { state: "queued", at: 0, agentSeverity: "high", agentCvss: 7.5 },
		...overrides,
	};
}

const engines: SentinelEngine[] = [
	{
		id: "e1",
		projectId: "p1",
		projectName: "靶场",
		name: "内网打点",
		status: "completed",
		pauseNote: null,
		targets: [],
		doctrines: [],
		presetIds: [],
		presetOptional: true,
		limits: { concurrency: 2, roundLimit: 10, tokenLimit: null, timeLimitMin: null, maxRetries: 1 },
		gateMode: "auto",
		createdAt: 0,
		startedAt: null,
		endedAt: null,
		schedule: null,
		report: null,
		tasks: [
			{
				id: "t1",
				engineId: "e1",
				title: "Web 面侦察",
				objective: "找入口",
				target: "10.0.0.5",
				workspace: "/work/tasks/t1",
				status: "done",
				attempt: 1,
				criteria: [],
				roundLimit: 10,
				presetId: null,
				presetName: null,
				pendingContinue: null,
				sessionId: "s1",
				startedAt: null,
				endedAt: null,
				summary: null,
				error: null,
				usage: null,
				vulns: 1,
				autoResume: false,
			},
		],
	},
	{
		id: "e2",
		projectId: "p2",
		projectName: "别的项目",
		name: "别的工程",
		status: "running",
		pauseNote: null,
		targets: [],
		doctrines: [],
		presetIds: [],
		presetOptional: true,
		limits: { concurrency: 2, roundLimit: 10, tokenLimit: null, timeLimitMin: null, maxRetries: 1 },
		gateMode: "auto",
		createdAt: 0,
		startedAt: null,
		endedAt: null,
		schedule: null,
		report: null,
		tasks: [],
	},
];

const sessions: SessionInfoView[] = [
	{
		path: "/sessions/a.jsonl",
		id: "s1",
		cwd: "/work",
		name: "10.0.0.5 侦察",
		created: "2026-01-01T00:00:00.000Z",
		modified: "2026-01-01T00:00:00.000Z",
		messageCount: 3,
		firstMessage: "开始侦察",
	},
];

function renderPage(options: {
	filters?: SentinelVulnFilters;
	deletePending?: string[] | null;
	preview?: { count: number; evidence: number; notes: number } | null;
	items?: SentinelVulnSummary[];
} = {}): string {
	return renderToStaticMarkup(
		createElement(VulnPage, {
			items: options.items ?? [summary(), summary({ id: "v2", label: "E2E-0002", number: 2 })],
			stats,
			filters: options.filters ?? {},
			projectName: "靶场",
			projectId: "p1",
			engines,
			sessions,
			hasProject: true,
			deletePending: options.deletePending ?? null,
			deletePreview: options.preview ?? null,
			onFiltersChange: () => {},
			onOpen: () => {},
			onOpenSession: () => {},
			onExport: () => {},
			onRetryReview: () => {},
			onReviewAllPending: () => {},
			onRequestDelete: () => {},
			onConfirmDelete: () => {},
			onCancelDelete: () => {},
		}),
	);
}

test("the page states the project, the totals and the severity breakdown", () => {
	const html = renderPage();
	expect(html).toContain("漏洞中枢");
	expect(html).toContain("靶场");
	expect(html).toContain("2 条");
	expect(html).toContain("待确认 2");
	// Severity counts are tags, status counts are one dim line.
	expect(html).toContain("高危 2");
	expect(html).toContain("误报 0");
});

test("the ledger shows the columns and the submitted content", () => {
	const html = renderPage();
	const header = html.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/)?.[1] ?? "";
	const titles = [...header.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
		.map((match) => match[1].replace(/<[^>]*>/g, "").trim())
		.filter(Boolean);
	expect(titles).toEqual(["编号", "标题", "目标", "关联资产", "等级", "状态", "来源", "提交时间", "操作"]);
	expect(html).toContain(">0001</span>");
	expect(html).toContain(">0002</span>");
	expect(html).not.toContain("E2E-0001");
	expect(html).not.toContain("E2E-0002");
	expect(html).toContain("未授权访问");
	expect(html).toContain("10.0.0.5");
	expect(html).toContain("工程任务「内网打点」");
	expect(html).toContain("7.5");
});

test("the review chip distinguishes queued, failed, dubious and done", () => {
	const queued = renderPage({ items: [summary({ review: { state: "queued", at: 0 } })] });
	expect(queued).toContain("…评");
	// A queued or failed review leaves the level as the agent's own guess.
	expect(queued).toContain("自评");

	const failed = renderPage({ items: [summary({ review: { state: "failed", at: 0, error: "超时" } })] });
	expect(failed).toContain("未评");

	const dubious = renderPage({
		items: [summary({ review: { state: "done", at: 0, verdict: "dubious", reason: "证据不足" } })],
	});
	expect(dubious).toContain("⚠存疑");

	const done = renderPage({
		items: [summary({ review: { state: "done", at: 0, verdict: "solid", reason: "可复现" } })],
	});
	expect(done).toContain("✓评");
	expect(done).not.toContain("自评");
});

test("the active filters are shown as removable chips, without opening the panel", () => {
	const html = renderPage({ filters: { engineId: "e1", severity: ["high", "critical"] } });
	expect(html).toContain("工程：内网打点");
	expect(html).toContain("等级：高危");
	expect(html).toContain("等级：严重");
	// The project-isolated page never offers another project's engines.
	expect(html).not.toContain("别的工程");
});

test("without a project the page says so instead of rendering an empty ledger", () => {
	const html = renderToStaticMarkup(
		createElement(VulnPage, {
			items: [],
			stats,
			filters: {},
			projectName: null,
			projectId: null,
			engines,
			sessions,
			hasProject: false,
			deletePending: null,
			deletePreview: null,
			onFiltersChange: () => {},
			onOpen: () => {},
			onOpenSession: () => {},
			onExport: () => {},
			onRetryReview: () => {},
			onReviewAllPending: () => {},
			onRequestDelete: () => {},
			onConfirmDelete: () => {},
			onCancelDelete: () => {},
		}),
	);
	expect(html).toContain("尚未选择项目");
	expect(html).not.toContain("E2E-0001");
});

test("the delete confirmation states what disappears with the records", () => {
	const html = renderToStaticMarkup(
		createElement(VulnDeleteBody, {
			pending: ["v1", "v2"],
			preview: { count: 2, evidence: 3, notes: 4 },
		}),
	);
	expect(html).toContain("将删除 2 条漏洞记录。");
	expect(html).toContain("3 条证据");
	expect(html).toContain("4 条复核备注");
});

test("each row offers a jump to its reporting session, disabled when the session is gone", () => {
	const html = renderPage();
	expect(html).toContain('aria-label="打开对应对话"');

	const gone = renderPage({ items: [summary({ sessionId: "deleted", sessionName: "旧会话" })] });
	expect(gone).toContain('aria-label="对应会话已删除"');

	const legacy = renderPage({ items: [summary({ sessionId: undefined, sessionName: undefined })] });
	expect(legacy).toContain("该漏洞没有关联会话");
});

test("the detail pane shows provenance, review opinion and the timeline", () => {
	const vuln: SentinelVulnerability = {
		...summary(),
		packet: "GET / HTTP/1.1",
		evidence: [],
		notes: [{ at: "2026-01-02T00:00:00.000Z", author: "operator", text: "已确认可复现" }],
		review: { state: "done", at: 0, verdict: "dubious", reason: "证据不足以支撑结论" },
	};
	const html = renderToStaticMarkup(
		createElement(VulnDetailBody, {
			vuln,
			preview: null,
			provenance: { engine: "内网打点", task: "Web 面侦察", session: "10.0.0.5 侦察" },
			onClose: () => {},
			onUpdate: () => {},
			onPreview: () => {},
			onRetryReview: () => {},
			onOpenAsset: () => {},
		}),
	);
	expect(html).toContain("内网打点 / Web 面侦察");
	expect(html).toContain("<code>0001</code>");
	expect(html).not.toContain("E2E-0001");
	expect(html).toContain("10.0.0.5 侦察");
	expect(html).toContain("评审意见");
	expect(html).toContain("证据不足以支撑结论");
	expect(html).toContain("已确认可复现");
	expect(html).toContain("漏洞详情");
	expect(html).toContain("原始数据包");
});
