/**
 * The inventory Markdown export: grouping, timeline rendering, linked findings,
 * the empty report and the vulnerable-without-finding warning.
 */

import { expect, test } from "vitest";
import { buildAssetReport } from "../src/asset-markdown.ts";
import type { SentinelAsset, SentinelAssetEntry, SentinelVulnSummary } from "../src/protocol.ts";

const AT = "2026-10-26T10:00:00.000Z";

function entry(seq: number, overrides: Partial<SentinelAssetEntry> = {}): SentinelAssetEntry {
	return {
		seq,
		kind: "record",
		at: AT,
		author: "agent",
		source: "主代理",
		outcome: "clean",
		text: "仅 80/443 开放",
		...overrides,
	};
}

function asset(overrides: Partial<SentinelAsset> = {}): SentinelAsset {
	return {
		id: "a1",
		label: "E2E-A0001",
		number: 1,
		projectId: "p1",
		projectName: "E2E",
		kind: "domain",
		name: "admin.example.com",
		host: "admin.example.com",
		domain: "admin.example.com",
		tags: ["OA", "后台"],
		status: "tested",
		source: "主代理",
		sessionName: "10.0.0.5 侦察",
		testCount: 1,
		lastOutcome: "clean",
		lastTestedAt: AT,
		firstSeenAt: AT,
		lastSeenAt: AT,
		createdAt: AT,
		updatedAt: AT,
		entries: [entry(1, { method: "nmap -sV" })],
		...overrides,
	};
}

test("groups by kind, prints the timeline and linked findings, and names the file", () => {
	const vuln = {
		id: "v1",
		label: "E2E-0003",
		severity: "high",
		status: "pending",
		title: "后台登录处 SQL 注入",
		target: "admin.example.com",
	} as SentinelVulnSummary;
	const report = buildAssetReport({
		projectName: "E2E",
		assets: [
			asset(),
			asset({
				id: "a2",
				label: "E2E-A0002",
				number: 2,
				kind: "service",
				name: "10.0.0.5:443",
				host: "10.0.0.5",
				domain: undefined,
				ip: "10.0.0.5",
				port: 443,
				transport: "tcp",
				protocol: "https",
				title: "后台",
				entries: [
					entry(1, {
						outcome: "vulnerable",
						method: "vuln_submit",
						vulnLabel: "E2E-0003",
						text: "提交漏洞 E2E-0003",
					}),
				],
				lastOutcome: "vulnerable",
			}),
		],
		vulnsByAsset: new Map([["a2", [vuln]]]),
		generatedAt: new Date("2026-10-26T13:30:00Z"),
	});
	expect(report.filename).toBe("E2E-asset-inventory-202610261330.md");
	expect(report.markdown).toContain("# 资产清单 — E2E");
	expect(report.markdown).toContain("## 域名");
	expect(report.markdown).toContain("## 服务");
	expect(report.markdown.indexOf("## 域名")).toBeLessThan(report.markdown.indexOf("## 服务"));
	expect(report.markdown).toContain("### E2E-A0001 admin.example.com");
	expect(report.markdown).toContain("nmap -sV");
	expect(report.markdown).toContain("关联漏洞");
	expect(report.markdown).toContain("E2E-0003");
	expect(report.markdown).toContain("提交漏洞 E2E-0003");
});

test("status changes render as status lines and do not count as tests", () => {
	const report = buildAssetReport({
		projectName: "E2E",
		assets: [
			asset({
				testCount: 1,
				entries: [
					entry(1, {
						kind: "status",
						outcome: "note",
						text: "状态 待测试 → 测试中",
						author: "operator",
						source: undefined,
					}),
					entry(2),
				],
			}),
		],
		vulnsByAsset: new Map(),
		generatedAt: new Date("2026-10-26T13:30:00Z"),
	});
	expect(report.markdown).toContain("操作员 · 状态：状态 待测试 → 测试中");
	expect(report.markdown).toContain("测试记录（1 条）");
});

test("a status-only timeline still appears in the report", () => {
	const report = buildAssetReport({
		projectName: "E2E",
		assets: [
			asset({
				testCount: 0,
				entries: [
					entry(1, {
						kind: "status",
						outcome: "note",
						text: "状态 待测试 → 范围外",
						author: "operator",
						source: undefined,
					}),
				],
			}),
		],
		vulnsByAsset: new Map(),
		generatedAt: new Date("2026-10-26T13:30:00Z"),
	});
	expect(report.markdown).toContain("时间线");
	expect(report.markdown).toContain("状态 待测试 → 范围外");
});

test("an empty export says so instead of printing an empty table", () => {
	const report = buildAssetReport({
		projectName: "空项目",
		assets: [],
		vulnsByAsset: new Map(),
		generatedAt: new Date("2026-10-26T13:30:00Z"),
	});
	expect(report.markdown).toContain("资产总数：0");
	expect(report.markdown).toContain("本次导出没有资产记录。");
	expect(report.markdown).not.toContain("## 域名");
});

test("a vulnerable last outcome without a linked finding is flagged", () => {
	const report = buildAssetReport({
		projectName: "E2E",
		assets: [asset({ lastOutcome: "vulnerable", lastTestedAt: AT })],
		vulnsByAsset: new Map(),
		generatedAt: new Date("2026-10-26T13:30:00Z"),
	});
	expect(report.markdown).toContain("最近一次测试结论为「有漏洞」，但没有关联的漏洞中枢记录。");
});

test("long text is exported in full, not truncated", () => {
	const text = "x".repeat(20_000);
	const report = buildAssetReport({
		projectName: "E2E",
		assets: [asset({ entries: [entry(1, { text })] })],
		vulnsByAsset: new Map(),
		generatedAt: new Date("2026-10-26T13:30:00Z"),
	});
	expect(report.markdown).toContain(text);
});

test("exports editable multiline remarks separately from test records", () => {
	const report = buildAssetReport({
		projectName: "E2E",
		assets: [asset({ remark: "人工标记\nAgent 复核", entries: [], testCount: 0 })],
		vulnsByAsset: new Map(),
	});
	expect(report.markdown).toContain("- 备注：\n    人工标记\n    Agent 复核");
	expect(report.markdown).toContain("测试记录：无");
});
