/**
 * Unit tests for the source half's helpers: what they accept, how they fold a
 * submission into what is already stored, and how they page and lay it out.
 * The record the halves add up to is tested in `apimodels.test.ts`.
 */

import { join } from "node:path";
import { expect, test } from "vitest";
import type { SentinelApiSourceMapping, SentinelBusinessLogicModel } from "../src/protocol.ts";
import {
	countsOf,
	danglingReferences,
	formatCodeLocation,
	mergeApiMappings,
	mergeLogic,
	normalizeLocation,
	normalizeRoute,
	normalizeSourceSubmission,
	Problems,
	pageApiMappings,
	pageOf,
	sourceModelSections,
	sourceOverflow,
	tableCell,
} from "../src/sourcemodels.ts";
import { at, entity, mapping } from "./modeling-fixtures.ts";

// The host side of a project's work directory; no file in it is ever read.
const work = "/tmp/sentinel-sourcemodels-work";

const empty = (): SentinelBusinessLogicModel => ({
	entities: [],
	relations: [],
	stateMachines: [],
	rules: [],
	apiDependencies: [],
});

/** The accepted side of a normalized submission, or the test stops here. */
function accepted(input: Parameters<typeof normalizeSourceSubmission>[0]) {
	const result = normalizeSourceSubmission(input, work);
	if ("errors" in result) throw new Error(result.errors.join("\n"));
	return result;
}

test("a location is put into its /work form, and a route has to be a route", () => {
	const problems = new Problems();
	expect(normalizeLocation({ file: "src\\main\\X.java", line: "12" }, "x", work, problems)).toBeUndefined();
	expect(problems.list()).toEqual(["x 的 line 必须是从 1 开始的行号。"]);
	const clean = new Problems();
	expect(normalizeLocation({ file: "src\\main\\X.java", line: 12, endLine: 40 }, "x", work, clean)).toEqual({
		file: "/work/src/main/X.java",
		line: 12,
		endLine: 40,
	});
	expect(normalizeLocation({ file: ".", line: 1 }, "y", work, clean)).toBeUndefined();
	expect(normalizeLocation({ file: "/work/../etc/passwd", line: 1 }, "z", work, clean)).toBeUndefined();
	expect(normalizeLocation({ file: join(work, "a/b.java"), line: 1 }, "w", work, clean)).toEqual({
		file: "/work/a/b.java",
		line: 1,
	});
	expect(clean.list()).toEqual([
		"y 的 file 指向的是目录，要写到具体文件。",
		"z 的 file 无效：必须是项目工作目录里的文件，写成相对路径或 /work/... 。",
	]);
	expect(normalizeRoute("/api/orders/{id}")).toBe("/api/orders/{id}");
	expect(normalizeRoute(" /api/orders ")).toBe("/api/orders");
	expect(normalizeRoute("api/orders")).toBe("");
	expect(normalizeRoute("/api/my orders")).toBe("");
	expect(normalizeRoute(`/${"a".repeat(600)}`)).toBe("");
});

test("a submission carries the lists it names, and names only those", () => {
	const rule = {
		id: "r1",
		kind: "invariant",
		subject: "订单",
		statement: "金额不能为负",
		locations: [at()],
	};
	// Only the rule list is in the patch, so merging it leaves the other four lists alone.
	const partial = accepted({ rules: [rule], source: "  shop-api/  " });
	expect(Object.keys(partial.patch)).toEqual(["rules"]);
	expect(partial.apis).toEqual([]);
	expect(partial.source).toBe("shop-api/");
	// The scope is kept short enough for one row of the page.
	expect(accepted({ apis: [], source: "x".repeat(300) }).source).toHaveLength(200);
	expect(accepted({ apis: [mapping()], entities: [entity("订单")] }).apis[0].path).toBe("/api/orders/{id}");
	expect(normalizeSourceSubmission({ note: "只有备注" }, work)).toEqual({
		errors: ["提交里没有任何内容：至少给 apis 或业务逻辑模型的某一张表。"],
	});
	expect(normalizeSourceSubmission({ apis: [mapping()], entities: "nope" }, work)).toEqual({
		errors: ["entities 必须是数组。"],
	});
});

test("the merge and the pure helpers", () => {
	const a = mapping("GET", "/a") as SentinelApiSourceMapping;
	const b = mapping("GET", "/b") as SentinelApiSourceMapping;
	expect(mergeApiMappings([a, b], [a])).toHaveLength(2);
	expect(formatCodeLocation({ file: "/work/a.java", line: 3 })).toBe("/work/a.java:3");
	expect(formatCodeLocation({ file: "/work/a.java", line: 3, endLine: 9 })).toBe("/work/a.java:3-9");
	expect(mergeLogic(empty(), {})).toEqual(empty());
	expect(danglingReferences([], empty())).toEqual([]);
	expect(countsOf([a], empty())).toEqual({
		apiCount: 1,
		entityCount: 0,
		relationCount: 0,
		stateMachineCount: 0,
		ruleCount: 0,
		apiDependencyCount: 0,
	});
	const pages = pageOf([1, 2, 3, 4, 5], { page: 2, pageSize: 2 });
	expect(pages).toEqual({ total: 5, items: [3, 4] });
});

test("the read helpers narrow and page", () => {
	const apis = [
		mapping("GET", "/api/orders", { module: "订单" }),
		mapping("POST", "/api/pay", { module: "支付", handler: { name: "pay", location: at(9) } }),
		mapping("GET", "/api/goods", {
			module: "商品",
			dataAccess: [{ operation: "write", table: "t_goods", location: at(1) }],
		}),
	] as SentinelApiSourceMapping[];
	expect(pageApiMappings(apis, { module: "支付", page: 1, pageSize: 20 }).items.map((api) => api.path)).toEqual([
		"/api/pay",
	]);
	expect(pageApiMappings(apis, { search: "pay", page: 1, pageSize: 20 }).items.map((api) => api.path)).toEqual([
		"/api/pay",
	]);
	expect(pageApiMappings(apis, { search: "T_GOODS", page: 1, pageSize: 20 }).items.map((api) => api.path)).toEqual([
		"/api/goods",
	]);
	expect(pageApiMappings(apis, { search: "getOrder", page: 1, pageSize: 20 }).total).toBe(2);
	expect(pageApiMappings(apis, { page: 2, pageSize: 2 })).toEqual({ total: 3, items: [apis[2]] });
});

test("the runaway guards name the first limit a source half exceeds", () => {
	const one = mapping("GET", "/a") as SentinelApiSourceMapping;
	expect(sourceOverflow([one], empty())).toBeUndefined();
	const many = Array.from({ length: 5001 }, (_, index) => ({ ...one, path: `/a/${index}` }));
	expect(sourceOverflow(many, empty())).toBe(
		"接口映射数量 5001 超过上限 5000：请只保留核实过的内容，或分几次业务建模来做。",
	);
	// Under every count limit, but too much text altogether.
	const heavy = Array.from({ length: 4000 }, (_, index) => ({ ...one, path: `/a/${index}`, notes: "x".repeat(600) }));
	expect(sourceOverflow(heavy, empty())).toMatch(
		/^模型过大（\d+KB，上限 2048KB）：请精简描述，或只保留核实过的内容。$/,
	);
});

test("a Markdown section is written only when it has something in it", () => {
	const one = mapping("GET", "/a") as SentinelApiSourceMapping;
	expect(sourceModelSections([], empty())).toEqual([]);
	const onlyApis = sourceModelSections([one], empty()).join("\n");
	expect(onlyApis).toContain("## API 源码映射");
	for (const absent of ["## 源码实体", "## 实体关系", "## 状态机", "## 业务规则", "## 跨接口业务依赖", "（无）"]) {
		expect(onlyApis).not.toContain(absent);
	}
	// A cell cannot break the table it sits in.
	expect(tableCell("a|b\nc")).toBe("a\\|b c");
	expect(tableCell(undefined)).toBe("");
});
