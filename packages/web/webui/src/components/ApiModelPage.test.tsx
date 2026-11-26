/**
 * The business-modeling page on screen: the list of records, the drill-down
 * with a tab per part the record has, and what the source panes say about the
 * source.
 *
 * Rendered to static markup, so what is pinned is what the first paint shows:
 * the list's columns, the tabs a record is offered, the detail's meta and
 * actions, the endpoint list with its warning for an endpoint nobody checks,
 * and a state machine whose transition records no guard.
 */

import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { isNoticeMessage } from "../transcript.ts";
import type {
	SentinelApiModel,
	SentinelApiModelSummary,
	SentinelApiSourceMapping,
	SentinelBusinessLogicModel,
} from "../types.ts";
import { ApiModelPage } from "./ApiModelPage.tsx";
import { CodeModelApiPane, mappingKey, mappingMatches, splitHandler } from "./codemodel/CodeModelApiPane.tsx";
import { CodeModelLogicPane, StateMachines } from "./codemodel/CodeModelLogicPane.tsx";
import { authKindLabel, codeLocationText, methodColor, ruleKindLabel } from "./codemodel/labels.tsx";

const STAMP = "2026-11-25T08:00:00.000Z";
const at = (line: number, file = "src/OrderController.java") => ({ file: `/work/${file}`, line });

const unchecked: SentinelApiSourceMapping = {
	method: "GET",
	path: "/api/orders/{id}",
	module: "订单",
	summary: "查订单",
	handler: { name: "OrderController.getOrder", location: at(42) },
	callChain: [{ layer: "service", name: "OrderService.find", location: at(88, "src/OrderService.java") }],
	dataAccess: [{ operation: "read", table: "t_order", columns: ["id", "status"], location: at(7, "src/OrderMapper.xml") }],
	authChecks: [],
	externalCalls: [{ kind: "http", target: "https://pay.example.com", location: at(60) }],
	notes: "整条链上没有找到权限校验",
};

const checked: SentinelApiSourceMapping = {
	method: "POST",
	path: "/api/orders",
	module: "订单",
	handler: { name: "OrderController.createOrder", location: at(50) },
	callChain: [],
	dataAccess: [{ operation: "write", table: "t_order", columns: ["id"], location: at(70, "src/OrderService.java") }],
	authChecks: [{ kind: "authorization", note: "只允许 admin 角色", location: at(48) }],
	externalCalls: [],
};

const logic: SentinelBusinessLogicModel = {
	entities: [
		{
			name: "订单",
			table: "t_order",
			owner: "用户",
			fields: [{ name: "status", meaning: "订单状态" }, { name: "amount" }],
			locations: [at(9, "src/entity/Order.java")],
		},
	],
	relations: [{ from: "订单", to: "用户", kind: "N:1", locations: [at(3, "src/entity/Order.java")] }],
	stateMachines: [
		{
			subject: "订单",
			field: "status",
			states: [{ name: "待支付" }, { name: "已支付" }, { name: "已发货" }],
			initial: "待支付",
			transitions: [
				{ from: "待支付", to: "已支付", trigger: "POST /api/orders/{id}/pay", guard: "金额大于 0", locations: [at(200, "src/OrderService.java")] },
				{ from: "已支付", to: "已发货", trigger: "POST /api/orders/{id}/ship", locations: [at(210, "src/OrderService.java")] },
			],
			locations: [at(1, "src/enums/OrderStatus.java")],
		},
	],
	rules: [{ id: "order.owner", kind: "ownership", subject: "GET /api/orders/{id}", statement: "只能看自己的订单", apis: ["GET /api/orders/{id}"], locations: [at(44)] }],
	apiDependencies: [{ from: "POST /api/orders/{id}/pay", to: "POST /api/orders", kind: "requires", locations: [at(30, "src/PayService.java")] }],
};

const emptyLogic = (): SentinelBusinessLogicModel => ({
	entities: [],
	relations: [],
	stateMachines: [],
	rules: [],
	apiDependencies: [],
});

/** A record with both halves, the way a run leaves one that had traffic and source to work on. */
const record: SentinelApiModel = {
	id: "api-11111111-2222-3333-4444-555555555555",
	projectId: "p1",
	sessionId: "s1",
	sessionPath: "/tmp/s1.jsonl",
	title: "商城",
	target: "https://shop.example.com",
	source: "shop-api/",
	status: "done",
	openapi: { openapi: "3.0.3", info: { title: "商城", version: "1.0.0" }, paths: { "/api/users": { get: { summary: "用户列表" } } } },
	entities: [{ name: "用户", description: "登录主体", fields: [{ name: "id", type: "integer" }], relations: [{ target: "订单", kind: "1:N" }] }],
	apis: [unchecked, checked],
	logic,
	pathCount: 1,
	operationCount: 1,
	submissions: 4,
	createdAt: STAMP,
	updatedAt: STAMP,
	doneAt: STAMP,
};

/** The same record with only its interface document: what records from before the merge hold. */
const documentOnly: SentinelApiModel = { ...record, source: "", apis: [], logic: emptyLogic() };

/** The same record with only its source half: a run that had source and no traffic. */
const sourceOnly: SentinelApiModel = {
	...record,
	target: "",
	openapi: { openapi: "3.0.3", info: { title: "商城", version: "1.0.0" }, paths: {} },
	entities: [],
	pathCount: 0,
	operationCount: 0,
};

function summaryOf(model: SentinelApiModel): SentinelApiModelSummary {
	const { openapi: _openapi, entities, apis, logic: modelLogic, ...rest } = model;
	return {
		...rest,
		entityCount: entities.length,
		apiCount: apis.length,
		stateMachineCount: modelLogic.stateMachines.length,
		ruleCount: modelLogic.rules.length,
	};
}

function renderPage(overrides: Partial<ComponentProps<typeof ApiModelPage>> = {}): string {
	const props: ComponentProps<typeof ApiModelPage> = {
		items: [],
		detail: null,
		events: [],
		projectName: "商城项目",
		hasProject: true,
		onRefresh: () => {},
		onOpen: () => {},
		onClose: () => {},
		onDelete: () => {},
		onEnd: () => {},
		onExport: () => {},
		onOpenSession: () => {},
		...overrides,
	};
	return renderToStaticMarkup(createElement(ApiModelPage, props));
}

/** The labels of the tabs the page offers, in order: the tab's text without its count. */
function tabLabels(html: string): string[] {
	const start = html.indexOf('role="tablist"');
	// The page's own tabs end where its first pane begins; the logic pane has tabs of its own.
	const nav = html.slice(start, html.indexOf('role="tabpanel"', start));
	return nav
		.split('<div role="tab"')
		.slice(1)
		.map((tab) => {
			// One tab node ends where its own two divs close; what follows is the next tab.
			const node = tab.slice(0, tab.indexOf("</div></div>"));
			const body = node.slice(node.indexOf(">", node.indexOf("ant-tabs-tab-btn")) + 1);
			return body
				.replace(/<[^>]+>/g, "")
				.replace(/\d+$/, "")
				.trim();
		});
}

test("the list has one row per record and counts both halves", () => {
	const html = renderPage({ items: [summaryOf(record), summaryOf(documentOnly)] });
	for (const column of ["名称", "状态", "范围", "接口", "实体", "源码映射", "状态机", "规则", "时间", "操作"])
		expect(html).toContain(column);
	for (const cell of ["商城项目", "商城", "https://shop.example.com", "shop-api/", "1 路径 / 1 操作", "已完成", "查看"])
		expect(html).toContain(cell);
	// One page: there is no switch to a second section any more.
	expect(html).not.toContain("ant-segmented");
	expect(html).not.toContain("项目理解");
	// The detail's actions are not the list's.
	expect(html).not.toContain("返回列表");
});

test("the scope cell shows what a record covers: the target, the source range, or neither", () => {
	// A record that says nothing about its scope shows a dash, not a blank cell.
	const bare = renderPage({ items: [{ ...summaryOf(record), target: "", source: "" }] });
	expect(bare).not.toContain("shop-api/");
	expect(bare).not.toContain("https://shop.example.com");
	expect(bare).toMatch(/<td[^>]*>—<\/td>/);
	const scoped = renderPage({ items: [summaryOf(sourceOnly)] });
	expect(scoped).toContain("shop-api/");
	expect(scoped).not.toContain("https://shop.example.com");
});

test("without a project, or without records, the page says what to do next", () => {
	expect(renderPage({ hasProject: false })).toContain("请先在侧栏顶部创建或选择一个项目");
	const empty = renderPage();
	expect(empty).toContain("还没有业务建模记录");
	expect(empty).toContain("业务建模 → 开始建模");
});

test("a record with both halves is offered every tab, and opens on its document", () => {
	const html = renderPage({
		detail: record,
		events: [{ at: STAMP, kind: "created" }, { at: STAMP, kind: "submitted", pathCount: 1, operationCount: 1, apiCount: 2, ruleCount: 1 }],
	});
	expect(tabLabels(html)).toEqual(["接口文档", "业务实体", "源码映射", "业务逻辑", "时间线"]);
	for (const expected of ["导出", "返回列表", "打开发起它的会话", "https://shop.example.com", "shop-api/", "提交"])
		expect(html).toContain(expected);
	// A two-character button is rendered with a space between its characters.
	expect(html).toMatch(/删\s*除/);
	// A finished run cannot be closed again.
	expect(html).not.toContain("标记已结束");
	// The meta counts both halves.
	for (const expected of ["源码范围", "状态机", "规则"]) expect(html).toContain(expected);
	// One audit line counts what the record held after the submission.
	expect(html).toContain("提交（1 路径 / 1 操作 / 2 条接口映射 / 1 条规则）");
});

test("a record with only an interface document looks as it did before: three tabs and no source counts", () => {
	const html = renderPage({ detail: documentOnly, events: [{ at: STAMP, kind: "created" }] });
	expect(tabLabels(html)).toEqual(["接口文档", "业务实体", "时间线"]);
	for (const expected of ["目标", "路径", "操作", "实体"]) expect(html).toContain(expected);
	for (const absent of ["源码映射", "源码范围", "业务逻辑", "状态机"]) expect(html).not.toContain(absent);
});

test("a record with only the source half opens on its mapping, with every place written as path:line", () => {
	const html = renderPage({ detail: sourceOnly });
	expect(tabLabels(html)).toEqual(["源码映射", "业务逻辑", "时间线"]);
	// The first endpoint is selected by default.
	for (const place of ["/work/src/OrderController.java:42", "/work/src/OrderService.java:88", "/work/src/OrderMapper.xml:7", "/work/src/OrderController.java:60"])
		expect(html).toContain(place);
	// The document half is absent, and its scope says so rather than hiding.
	expect(html).toContain("未记录目标");
});

test("the audit trail is there even for a record with nothing in it", () => {
	const empty: SentinelApiModel = { ...record, target: "", source: "", openapi: { openapi: "3.0.3", info: { title: "商城", version: "1.0.0" }, paths: {} }, entities: [], apis: [], logic: emptyLogic(), pathCount: 0, operationCount: 0 };
	const html = renderPage({ detail: empty, events: [{ at: STAMP, kind: "created" }, { at: STAMP, kind: "submitted" }] });
	expect(tabLabels(html)).toEqual(["时间线"]);
	// A submission that stored nothing countable is still a submission.
	expect(html).toMatch(/>(建模开始|提交)<\/(span|strong)>/);
});

test("a run still modeling can be closed from the page, and a failure is shown", () => {
	const html = renderPage({ detail: { ...record, status: "modeling", error: "会话已关闭" } });
	expect(html).toContain("标记已结束");
	expect(html).toContain("会话已关闭");
});

test("an endpoint nobody checks is called out, and a checked one lists where", () => {
	const html = renderToStaticMarkup(createElement(CodeModelApiPane, { apis: [unchecked, checked] }));
	// The list marks the unchecked endpoint; the detail explains it, since it is selected first.
	expect((html.match(/未发现/g) ?? []).length).toBeGreaterThanOrEqual(2);
	expect(html).toContain("未发现权限校验");
	expect(html).toContain("整条调用链上没有找到登录、权限或资源归属的校验");
	// The other endpoint is in the list with its one check counted.
	expect(html).toContain("1 处");
	expect(html).toContain("/api/orders");
	expect(html).toContain("共 2 条");
});

test("the search reaches the path, the handler, a table, and the chain", () => {
	expect(mappingKey(unchecked)).toBe("GET /api/orders/{id}");
	for (const needle of ["orders/{id}", "getorder", "t_order", "find", "pay.example.com", "订单", "查订单"])
		expect(mappingMatches(unchecked, needle), needle).toBe(true);
	expect(mappingMatches(checked, "t_order")).toBe(true);
	expect(mappingMatches(checked, "getorder")).toBe(false);
	expect(mappingMatches(checked, "")).toBe(true);
	expect(mappingMatches(checked, "退款的中文备注")).toBe(false);
});

test("a handler name keeps its function when the cell is narrow", () => {
	// The class in front is what gives way, whatever the stack writes it with.
	expect(splitHandler("OrderController.getOrder")).toEqual({ head: "OrderController.", tail: "getOrder" });
	expect(splitHandler("App\\Http\\CouponController@grant")).toEqual({ head: "App\\Http\\CouponController@", tail: "grant" });
	expect(splitHandler("CouponService::grant")).toEqual({ head: "CouponService::", tail: "grant" });
	// Nothing to split on, or only a separator at the very start: the whole name is the function.
	expect(splitHandler("download_report")).toEqual({ head: "", tail: "download_report" });
	expect(splitHandler(".hidden")).toEqual({ head: "", tail: ".hidden" });
});

test("the logic pane lists its five parts with what each holds", () => {
	const html = renderToStaticMarkup(createElement(CodeModelLogicPane, { logic }));
	// The source's entities are called that, to tell them from the interface document's.
	for (const tab of ["源码实体", "实体关系", "状态机", "业务规则", "跨接口依赖"]) expect(html).toContain(tab);
	// It opens on the entities, and an entity says who owns its records.
	expect(html).toContain("订单");
	expect(html).toContain("t_order");
	expect(html).toContain("用户");
	expect(html).toContain("/work/src/entity/Order.java:9");
});

test("a state machine shows its states and its transitions, and a transition with no guard says so", () => {
	const html = renderToStaticMarkup(createElement(StateMachines, { machines: logic.stateMachines }));
	for (const state of ["待支付", "已支付", "已发货", "初始"]) expect(html).toContain(state);
	expect(html).toContain("3 个状态 · 2 条迁移");
	expect(html).toContain("POST /api/orders/{id}/pay");
	expect(html).toContain("金额大于 0");
	// The second transition records no guard: that is where a skipped state shows.
	expect((html.match(/未记录/g) ?? []).length).toBe(1);
	expect(renderToStaticMarkup(createElement(StateMachines, { machines: [] }))).toContain("这一部分还没有内容");
});

test("the words the panes use for the source are one set", () => {
	expect(authKindLabel("ownership")).toBe("资源归属校验");
	expect(ruleKindLabel("invariant")).toBe("业务不变量");
	expect(methodColor("DELETE")).toBe("red");
	expect(methodColor("anything")).toBe("default");
	expect(codeLocationText({ file: "/work/a.java", line: 3 })).toBe("/work/a.java:3");
	expect(codeLocationText({ file: "/work/a.java", line: 3, endLine: 9 })).toBe("/work/a.java:3-9");
});

test("a modeling row is a notice the transcript folds, and the markers of the old design are gone", () => {
	const notice = (customType: string) => ({ role: "custom" as const, customType, content: "" });
	expect(isNoticeMessage(notice("zg-modeling"))).toBe(true);
	expect(isNoticeMessage(notice("zg-code-modeling"))).toBe(false);
	expect(isNoticeMessage(notice("zg-something-else"))).toBe(false);
});
