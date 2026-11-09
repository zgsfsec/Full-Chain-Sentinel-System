import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SentinelNotifyGroup } from "../types.ts";
import { NotifyGroupEditor, NotifyPanel } from "./NotifyPanel.tsx";

const group: SentinelNotifyGroup = {
	id: "security",
	name: "安全团队",
	enabled: true,
	kinds: { runs: false, vulns: true, codeIntel: true, goals: false, engines: false, pocs: false },
	targets: ["钉钉一群", "钉钉二群"].map((name, index) => ({
		id: String(index),
		name,
		enabled: true,
		channel: "dingtalk",
		webhook: "https://example.com/robot",
		secret: "",
		keyword: "",
	})),
};

test("the empty page explains how to create groups and their global scope", () => {
	const html = renderToStaticMarkup(
		<NotifyPanel
			config={{ groups: [], summaryLimit: 2000 }}
			status={{ at: null, ok: true }}
			onSave={() => {}}
			onTest={async () => null}
		/>,
	);
	expect(html).toContain("还没有通知组");
	expect(html).toContain("新增通知组");
	expect(html).toContain("所有通知组全局生效");
});

test("a group editor renders all six categories and separate same-platform robots", () => {
	const html = renderToStaticMarkup(
		<NotifyGroupEditor group={group} onChange={() => {}} testing={null} results={{}} onTest={() => {}} />,
	);
	for (const label of [
		"运行报告",
		"高危漏洞",
		"开源情报",
		"持续目标结束",
		"工程完成",
		"POC 订阅失败",
		"钉钉一群",
		"钉钉二群",
	])
		expect(html).toContain(label);
	expect(html).toContain("已选 2 / 6");
	expect(html.match(/type="checkbox"/g)).toHaveLength(6);
	expect(html).toContain("手动通知发送到所有已启用组");
});

test("delivery results distinguish same-platform robots and show the failing recipient", () => {
	const html = renderToStaticMarkup(
		<NotifyPanel
			config={{ groups: [group], summaryLimit: 2000 }}
			status={{
				at: 1,
				ok: false,
				subject: "测试报告",
				deliveries: [
					{
						groupId: group.id,
						groupName: group.name,
						targetId: "0",
						targetName: "钉钉一群",
						channel: "dingtalk",
						ok: true,
					},
					{
						groupId: group.id,
						groupName: group.name,
						targetId: "1",
						targetName: "钉钉二群",
						channel: "dingtalk",
						ok: false,
						error: "HTTP 503",
					},
				],
			}}
			onSave={() => {}}
			onTest={async () => null}
		/>,
	);
	expect(html).toContain("安全团队 / 钉钉一群");
	expect(html).toContain("安全团队 / 钉钉二群");
	expect(html).toContain("HTTP 503");
});
