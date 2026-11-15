/**
 * Static-render tests for the two-tab audit page.
 *
 * The page's whole shape comes from `filter.approval`: which tab is on, which
 * stat line and which columns the table draws. That mapping is what these
 * assertions pin down — a regression here shows up as a page that renders the
 * wrong table for a filter rather than as an exception.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { GateAuditPage } from "./GateAuditPage.tsx";
import type { SentinelGateDecision, SentinelGateFilter, SentinelGateStats, SentinelProjectInfo } from "../types.ts";
import type { SessionInfoView } from "../types.ts";

const STATS: SentinelGateStats = {
	total: 3,
	byDecision: { allow: 2, block: 1, failed: 0 },
	byApproval: { ai: 1, human: 1, auto: 1 },
	blockRate: 1 / 3,
	avgLatencyMs: 120,
	totalTokens: 3612,
	last24h: 3,
	failures: 0,
	lastFailureAt: null,
	lastSuccessAt: 1_700_000_000_000,
	lastError: null,
};

function decision(overrides: Partial<SentinelGateDecision> = {}): SentinelGateDecision {
	return {
		id: "gate-1",
		at: 1_700_000_000_000,
		projectId: "p1",
		projectName: "项目一",
		sessionId: "s1",
		source: "主代理",
		tool: "bash",
		command: "id",
		cwd: "/work",
		decision: "allow",
		approval: "auto",
		reason: undefined,
		latencyMs: 0,
		...overrides,
	};
}

const PROJECTS: SentinelProjectInfo[] = [{ id: "p1", name: "项目一", cwd: "/tmp/p1" }];

const SESSIONS: SessionInfoView[] = [
	{
		id: "s2",
		name: "第二轮扫描",
		path: "/tmp/s2.jsonl",
		cwd: "/tmp/p1",
		created: "2026-10-19T00:00:00.000Z",
		modified: "2026-10-19T01:00:00.000Z",
		messageCount: 4,
		firstMessage: "扫一下端口",
	},
	{
		id: "s1",
		name: "",
		path: "/tmp/s1.jsonl",
		cwd: "/tmp/p1",
		created: "2026-10-18T00:00:00.000Z",
		modified: "2026-10-18T01:00:00.000Z",
		messageCount: 2,
		firstMessage: "打一下这个站",
	},
];

/** The tab strip's numbers: global counts under the non-approval filters. */
const TAB_COUNTS = { ai: 44, human: 1, auto: 7 };

function render(filter: SentinelGateFilter, items: SentinelGateDecision[] = [decision()]): string {
	return renderToStaticMarkup(
		<GateAuditPage
			items={items}
			stats={STATS}
			tabCounts={TAB_COUNTS}
			total={items.length}
			page={1}
			filter={filter}
			projects={PROJECTS}
			sessions={SESSIONS}
			onQuery={() => {}}
			onRefresh={() => {}}
			onOpenSession={() => {}}
			sessionPathOf={() => null}
		/>,
	);
}

describe("GateAuditPage", () => {
	test("the AI 审批 tab is the default landing", () => {
		const html = render({});
		expect(html).toContain("审批");
		expect(html).toContain("AI 审批");
		expect(html).toContain("自动审批");
		// The AI tab's columns, and not the auto tab's.
		expect(html).toContain("判定");
		expect(html).toContain("模型");
		expect(html).not.toContain(">方式<");
	});

	test("an approval filter selects the other tab and its columns", () => {
		const html = render({ approval: ["auto", "human"] });
		expect(html).toContain("方式");
		expect(html).toContain("会话");
		expect(html).not.toContain(">判定<");
		expect(html).toContain("这些调用不经过判定，只留痕");
	});

	test("the toolbar offers the project, session and time filters", () => {
		const html = render({});
		expect(html).toContain("一键导出");
		expect(html).toContain("导出当前标签及筛选条件下的全部记录（CSV）");
		expect(html).toContain("全部项目");
		expect(html).toContain("全部会话");
		expect(html).toContain("全部来源");
		expect(html).toContain("全部时间");
	});

	test("the tab counts survive the open tab's own approval filter", () => {
		// The regression this guards: the counts came from a stats query that
		// carried the tab's approval filter, so opening 「自动审批」 displayed
		// zero on the AI 审批 tab and the strip looked dead.
		const html = render({ approval: ["auto", "human"] });
		expect(html).toContain("44");
		expect(html).toContain("8");
	});

	test("an empty bucket with no other filter says it has no records yet", () => {
		const html = render({ approval: ["auto", "human"] }, []);
		expect(html).toContain("自动审批还没有任何记录");
		expect(html).toContain("这一页记录自动执行");
	});

	test("a filter that matched nothing says so instead", () => {
		const html = render({ approval: ["auto", "human"], projectId: "p1" }, []);
		expect(html).toContain("没有符合条件的调用记录");
		expect(html).not.toContain("还没有任何记录");
	});

	test("an AI 审批 row is badged by verdict and keeps its reason", () => {
		const html = render({}, [decision({ decision: "block", reason: "命中第 4 条", approval: "ai", model: "judge" })]);
		expect(html).toContain("拦截");
		expect(html).toContain("judge");
	});

	test("an 自动审批 row badges the bucket, and a human block reads as 人工拦截", () => {
		const auto = render({ approval: ["auto"] }, [decision({ approval: "auto" })]);
		expect(auto).toContain("自动放行");
		const human = render({ approval: ["human", "auto"] }, [decision({ approval: "human", decision: "block" })]);
		expect(human).toContain("人工拦截");
	});
});
