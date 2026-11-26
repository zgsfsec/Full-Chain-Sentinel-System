/**
 * Unit tests for the business-modeling store.
 *
 * The store is what makes a modeling run a durable artifact rather than a chat
 * message: the interface document, the source models, the counters and the audit
 * trail. The tests are mostly about refusal — a document a Swagger tool could not
 * open, or a claim with no place in the source, must not be stored, and a refused
 * submission must not half-update a record — and about how a record opens: with
 * the agent's first submission, and never before it.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
	type ApiModelOrigin,
	ApiModelStore,
	type ApiModelSubmitResult,
	apiModelExportName,
	apiModelsDbPath,
	buildApiModelExport,
	buildApiModelMarkdown,
	countOperations,
	mergeOpenApiDraft,
	normalizeEntities,
	normalizeModelTitle,
	validateOpenApiDocument,
} from "../src/apimodels.ts";
import type { SentinelApiModel } from "../src/protocol.ts";
import { countsOf, type SourceModelSubmitResult } from "../src/sourcemodels.ts";
import { openSqliteDatabase } from "../src/sqlite.ts";
import { at, DOC, entity, mapping } from "./modeling-fixtures.ts";

let dir: string;
let store: ApiModelStore;
// The host side of a project's work directory; no file in it is ever read.
const work = join(tmpdir(), "sentinel-apimodels-work");
const options = { hostWorkDir: work };

/** A project and conversation a run belongs to. Every call is another conversation. */
let counter = 0;
const origin = (projectId = "p1", title?: string): ApiModelOrigin => ({
	projectId,
	sessionId: `s${counter++}`,
	sessionPath: null,
	title,
});

/** The record an accepted document submission left, or the test stops here. */
function stored(result: ApiModelSubmitResult): SentinelApiModel {
	if (!result.model) throw new Error(result.errors?.join("\n") ?? "the submission stored nothing");
	return result.model;
}

/** The record an accepted source submission left, or the test stops here. */
function storedSource(result: SourceModelSubmitResult): SentinelApiModel {
	if (!result.ok) throw new Error(result.errors.join("\n"));
	return result.model;
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-apimodels-"));
	store = new ApiModelStore(apiModelsDbPath(dir));
});

afterAll(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

test("the database lives in the agent directory, not the mounted work directory", () => {
	expect(apiModelsDbPath("/home/zg/.sentinel/agent")).toBe("/home/zg/.sentinel/agent/apimodels.db");
});

test("countOperations counts methods, not keys", () => {
	expect(countOperations({ "/a": { get: {}, post: {}, parameters: [] } })).toBe(2);
	expect(countOperations({ "/a": { get: {} }, "/b": { delete: {} } })).toBe(2);
	expect(countOperations({ "/a": { summary: "x" } })).toBe(0);
	expect(countOperations(null)).toBe(0);
});

test("validation names every reason a document cannot be opened", () => {
	expect(validateOpenApiDocument(DOC())).toEqual([]);
	expect(validateOpenApiDocument("nope")).toEqual(["文档必须是一个 JSON 对象。"]);
	expect(validateOpenApiDocument({})).toEqual([
		'缺少 openapi 字段：必须是 "3.0.0" 这类 3.x 版本号（本控制台只接受 OpenAPI 3.x）。',
		"缺少 info 对象：至少要写 info.title 与 info.version。",
		"缺少 paths 对象：没有接口时也要写空的 paths: {}。",
	]);
	expect(validateOpenApiDocument({ openapi: "2.0", info: { title: "x", version: "1" }, paths: {} })).toEqual([
		'openapi 版本 2.0 不受支持：必须是 3.x（例如 "3.0.3"）。',
	]);
	expect(
		validateOpenApiDocument({ openapi: "3.1.0", info: { title: " ", version: "1" }, paths: { users: {} } }),
	).toEqual(["info.title 不能为空。", "paths 的键必须以 / 开头：users 不合法。"]);
	expect(validateOpenApiDocument({ ...DOC(), components: [] })).toEqual(["components 必须是对象。"]);
});

test("merging a shard replaces only the paths it names", () => {
	const base = DOC({ "/a": { get: {} }, "/b": { get: {} } });
	const merged = mergeOpenApiDraft(base, { paths: { "/b": { post: {} }, "/c": { get: {} } } });
	expect(Object.keys(merged.paths as Record<string, unknown>)).toEqual(["/a", "/b", "/c"]);
	expect((merged.paths as Record<string, Record<string, unknown>>)["/b"]).toEqual({ post: {} });
	// The base object is not mutated: the caller keeps its draft.
	expect((base.paths as Record<string, Record<string, unknown>>)["/b"]).toEqual({ get: {} });
});

test("merging components merges inside each section", () => {
	const merged = mergeOpenApiDraft(
		{ ...DOC(), components: { schemas: { User: { type: "object" } }, securitySchemes: { cookie: {} } } },
		{ components: { schemas: { Order: { type: "object" } } } },
	);
	const components = merged.components as Record<string, Record<string, unknown>>;
	expect(Object.keys(components.schemas)).toEqual(["User", "Order"]);
	expect(components.securitySchemes).toEqual({ cookie: {} });
});

test("an unnamed entity is reported, not dropped silently", () => {
	const result = normalizeEntities([
		{
			name: "订单",
			description: "客户下单产生的单据",
			fields: [{ name: "id", type: "string" }],
			relations: [{ target: "用户", kind: "N:1" }],
		},
		{ description: "缺名字" },
		{ name: "用户", fields: "nope" },
	]);
	expect(result.entities.map((entity) => entity.name)).toEqual(["订单", "用户"]);
	expect(result.entities[0].relations).toEqual([{ target: "用户", kind: "N:1" }]);
	expect(result.errors).toEqual(["entities[1] 缺少 name。", "实体「用户」的 fields 必须是数组。"]);
	expect(normalizeEntities(undefined)).toEqual({ entities: [], errors: [] });
	expect(normalizeEntities("nope").errors).toEqual(["entities 必须是数组。"]);
});

test("titles are trimmed to something one row can show", () => {
	expect(normalizeModelTitle("【业务建模】商城前台 API。")).toBe("商城前台 API");
	expect(normalizeModelTitle("   ")).toBe("");
	expect(normalizeModelTitle("x".repeat(200))).toHaveLength(80);
});

test("a record opens with the agent's first submission, and not before it", () => {
	const first = store.start(
		{ projectId: "p-open", sessionId: "s1", sessionPath: "/tmp/s1.jsonl", title: "【业务建模】商城" },
		{ paths: { "/api/users": { get: { summary: "用户列表" } } }, target: "https://shop.example.com" },
	);
	const record = stored(first);
	expect(record.id.startsWith("api-")).toBe(true);
	expect(record).toMatchObject({
		status: "modeling",
		title: "商城",
		target: "https://shop.example.com",
		source: "",
		pathCount: 1,
		operationCount: 1,
		submissions: 1,
	});
	// The source half is there and empty: every reader of a record expects both halves.
	expect(record.apis).toEqual([]);
	expect(record.logic).toEqual({ entities: [], relations: [], stateMachines: [], rules: [], apiDependencies: [] });
	// The document under the submission is complete, so the page can render the record from its first moment.
	expect(record.openapi.info).toEqual({ title: "商城", version: "1.0.0" });
	expect(store.events(record.id).map((event) => [event.kind, event.pathCount, event.apiCount])).toEqual([
		["created", 0, 0],
		["submitted", 1, 0],
	]);
	expect(first.errors).toBeUndefined();
	// Without a conversation name to go by, the record carries the feature's name.
	const unnamed = store.start(
		{ projectId: "p-open", sessionId: "s2", sessionPath: null },
		{ openapi: DOC({ "/a": { get: {} } }) },
	);
	expect(stored(unnamed).title).toBe("业务建模");
});

test("a first submission that stores nothing opens no record", () => {
	const where = { projectId: "p-refused", sessionId: "s3", sessionPath: null, title: "不会留下的记录" };
	const invalid = store.start(where, { openapi: { openapi: "2.0", paths: {} } });
	const bare = store.start(where, { title: "只有标题", target: "https://shop.example.com" });
	const emptyPaths = store.start(where, { paths: {} });
	const badEntities = store.start(where, { entities: [{ description: "缺名字" }] });
	expect(invalid.model).toBeUndefined();
	expect(invalid.errors?.length).toBeGreaterThan(0);
	expect(bare).toEqual({ errors: ["提交里没有任何内容：至少给 openapi、paths、components 或 entities 之一。"] });
	expect(emptyPaths).toEqual({ errors: ["第一次提交没有存下任何内容：至少给一个接口，或一个写完整的业务实体。"] });
	// What was wrong with the entities comes back with it, so the model sees what to fix.
	expect(badEntities).toEqual({
		errors: ["entities[0] 缺少 name。", "第一次提交没有存下任何内容：至少给一个接口，或一个写完整的业务实体。"],
	});
	expect(store.startSource(where, { source: "shop-api/", title: "只有范围" }, options)).toEqual({
		ok: false,
		errors: ["提交里没有任何内容：至少给 apis 或业务逻辑模型的某一张表。"],
	});
	expect(store.list({ projectId: "p-refused" })).toEqual([]);
});

test("a refused submission writes nothing", () => {
	const record = stored(store.start(origin("p1"), { paths: { "/a": { get: {} } } }));
	const refused = store.submit(record.id, { openapi: { openapi: "2.0", paths: {} } });
	expect(refused.model).toBeUndefined();
	expect(refused.errors?.length).toBeGreaterThan(0);
	const kept = store.get(record.id) as SentinelApiModel;
	expect(kept.submissions).toBe(1);
	expect(kept.openapi.openapi).toBe("3.0.3");
	expect(kept.entities).toEqual([]);
	// A call that carries nothing to store is not a submission.
	expect(store.submit(record.id, { note: "只有备注" })).toEqual({
		errors: ["提交里没有任何内容：至少给 openapi、paths、components 或 entities 之一。"],
	});
	expect(store.submit("api-missing", { paths: {} })).toEqual({ errors: ["没有 id 为 api-missing 的业务建模记录。"] });
});

test("submitting shards accumulates the document, the entities and the counters", () => {
	const first = store.start(origin("p1", "商城"), {
		paths: { "/api/users": { get: { summary: "用户列表" }, post: { summary: "创建用户" } } },
		target: "https://shop.example.com",
		entities: [{ name: "用户", fields: [{ name: "id" }] }],
		note: "先交用户模块",
	});
	expect(first.model).toMatchObject({ pathCount: 1, operationCount: 2, target: "https://shop.example.com" });
	expect(first.model?.entities.length).toBe(1);

	const second = store.submit(stored(first).id, { paths: { "/api/orders": { get: {} } } });
	expect(second.model).toMatchObject({ pathCount: 2, operationCount: 3, submissions: 2 });
	// A submission without entities keeps the stored list.
	expect(second.model?.entities.map((item) => item.name)).toEqual(["用户"]);

	const events = store.events(stored(first).id);
	expect(events.map((event) => event.kind)).toEqual(["created", "submitted", "submitted"]);
	expect(events[1].note).toBe("先交用户模块");
	expect(events[2].pathCount).toBe(2);
});

test("a whole-document submission replaces the draft", () => {
	const record = stored(store.start(origin("p1"), { paths: { "/old": { get: {} } } }));
	const replaced = store.submit(record.id, { openapi: DOC({ "/new": { get: {} } }) });
	expect(Object.keys(replaced.model?.openapi.paths as Record<string, unknown>)).toEqual(["/new"]);
});

test("entity problems come back as warnings on a stored document", () => {
	const record = stored(store.start(origin("p1"), { paths: { "/a": { get: {} } } }));
	const result = store.submit(record.id, { paths: { "/b": { get: {} } }, entities: [{ description: "无名" }] });
	expect(result.model?.pathCount).toBe(2);
	expect(result.errors).toEqual(["entities[0] 缺少 name。"]);
	// The entity list on its own is a submission: it is what the tool asks for when it was refused.
	const fixed = store.submit(record.id, { entities: [{ name: "订单" }] });
	expect(fixed.errors).toBeUndefined();
	expect(fixed.model?.entities.map((item) => item.name)).toEqual(["订单"]);
});

test("finishing records the outcome, and how a run ended is written once", () => {
	const record = stored(store.start(origin("p2"), { paths: { "/a": { get: {} } } }));
	const done = store.finish(record.id, "done", { note: "覆盖用户与订单模块" });
	expect(done?.status).toBe("done");
	expect(done?.doneAt).not.toBeNull();
	expect(store.events(record.id).map((event) => [event.kind, event.note])).toEqual([
		["created", undefined],
		["submitted", undefined],
		["done", "覆盖用户与订单模块"],
	]);
	// Finishing again is not an error — the agent's tool and the operator's button
	// race — but the record is not rewritten: the ending that happened first stands.
	expect(store.finish(record.id, "manual", {}, new Date("2026-12-01T00:00:00Z"))).toMatchObject({
		status: "done",
		doneAt: done?.doneAt,
	});
	expect(store.events(record.id)).toHaveLength(3);
	expect(store.finish("api-missing", "manual")).toBeUndefined();
});

test("listing filters by project, status and search text, newest first", () => {
	const older = stored(
		store.start(
			origin("p3", "旧站点"),
			{ target: "https://old.example.com", paths: { "/a": { get: {} } } },
			new Date("2026-11-25T10:00:00Z"),
		),
	);
	const newer = storedSource(
		store.startSource(
			origin("p3", "新站点"),
			{ source: "shop-api-v2/", entities: [entity("订单")] },
			{ ...options, now: new Date("2026-11-25T10:05:00Z") },
		),
	);
	store.finish(newer.id, "manual");

	const listed = store.list({ projectId: "p3" });
	expect(listed.map((item) => item.title)).toEqual(["新站点", "旧站点"]);
	expect(listed[0]).toMatchObject({ source: "shop-api-v2/", pathCount: 0, entityCount: 0, apiCount: 0 });
	expect(listed[1]).toMatchObject({ target: "https://old.example.com", pathCount: 1, apiCount: 0 });
	expect(store.list({ projectId: "p3", status: "manual" }).map((item) => item.title)).toEqual(["新站点"]);
	expect(store.list({ projectId: "p3", search: "old.example" }).map((item) => item.title)).toEqual(["旧站点"]);
	// The source half's scope is searched too.
	expect(store.list({ projectId: "p3", search: "SHOP-API-V2" }).map((item) => item.title)).toEqual(["新站点"]);
	expect(store.list({ projectId: "p3", search: "没有这个" })).toEqual([]);
	expect(store.countProject("p3")).toBe(2);
	expect(store.countProject("nope")).toBe(0);

	// Closing, deleting, and going with the project work the same for both halves.
	store.finish(older.id, "failed", { error: "会话已关闭" });
	expect(store.list({ projectId: "p3", status: "failed" }).map((item) => item.id)).toEqual([older.id]);
	expect(store.delete(older.id)).toBe(true);
	expect(store.delete(older.id)).toBe(false);
	expect(store.get(older.id)).toBeUndefined();
	expect(store.events(older.id)).toEqual([]);
	expect(store.purgeProject("p3")).toBe(1);
	expect(store.list({ projectId: "p3" })).toEqual([]);
	expect(store.purgeProject("p3")).toBe(0);
});

test("the interface document exports as a file a Swagger tool can open", () => {
	const model = stored(store.start(origin("p7", "商城 前台/API"), { paths: { "/a": { get: { summary: "x" } } } }));
	const json = buildApiModelExport(model, "json");
	expect(json.filename).toMatch(/^商城-前台-api-[0-9a-f]{8}\.json$/);
	expect(JSON.parse(json.text).paths["/a"].get.summary).toBe("x");

	const yaml = buildApiModelExport(model, "yaml");
	expect(yaml.filename.endsWith(".yaml")).toBe(true);
	expect(yaml.text).toContain("openapi: 3.0.3");
	expect(yaml.text).toContain("/a:");

	// A record with neither title nor scope still gets a usable name.
	expect(apiModelExportName({ ...model, title: "", target: "", source: "" }, "json")).toBe(
		`api-model-${model.id.slice(4, 12)}.json`,
	);
	expect(apiModelExportName({ ...model, title: "", target: "", source: "" }, "markdown")).toBe(
		`api-model-record-${model.id.slice(4, 12)}.md`,
	);
});

test("the whole record exports as JSON and as one document a person can read", () => {
	const first = store.start(origin("p7", "商城 前台/API"), {
		openapi: {
			...DOC({
				"/api/orders/{id}": { get: { summary: "查订单" } },
				"/api/users": { post: { operationId: "createUser" } },
			}),
			servers: [{ url: "https://shop.example.com" }],
		},
		target: "https://shop.example.com",
		entities: [
			{
				name: "订单",
				description: "客户下单产生的单据",
				fields: [
					{ name: "id", type: "string" },
					{ name: "status", type: "string", description: "待支付 | 已支付" },
				],
				relations: [{ target: "用户", kind: "N:1", description: "下单人" }],
			},
		],
	});
	const model = storedSource(
		store.submitSource(
			stored(first).id,
			{
				apis: [
					mapping("GET", "/api/orders/{id}", { authChecks: [], notes: "没有找到权限校验" }),
					// An inferred mapping says so next to its module; a verified one has nothing to separate.
					mapping("POST", "/api/pay", { module: "支付", confidence: "inferred" }),
				],
				entities: [entity("订单", { description: "一行说明" })],
				stateMachines: [
					{
						subject: "订单",
						field: "status",
						states: [{ name: "待支付" }, { name: "已支付" }],
						transitions: [
							{
								from: "待支付",
								to: "已支付",
								trigger: "POST /pay",
								guard: "余额充足",
								locations: [at(200, "src/OrderService.java")],
							},
						],
						locations: [at(1, "src/Status.java")],
					},
				],
				rules: [
					{
						id: "r1",
						kind: "ownership",
						subject: "订单",
						statement: "只能看自己的",
						apis: ["GET /api/orders/{id}"],
						locations: [at()],
					},
				],
				apiDependencies: [{ from: "POST /pay", to: "GET /api/orders/{id}", kind: "requires", locations: [at()] }],
				source: "shop-api/",
			},
			options,
		),
	);
	const json = buildApiModelExport(model, "record");
	expect(json.filename).toBe(`商城-前台-api-record-${model.id.slice(4, 12)}.json`);
	// Both halves travel, under the names the record keeps them under.
	expect(JSON.parse(json.text)).toMatchObject({
		id: model.id,
		title: "商城 前台/API",
		target: "https://shop.example.com",
		source: "shop-api/",
		status: "modeling",
		openapi: { paths: { "/api/orders/{id}": {}, "/api/users": {} } },
		entities: [{ name: "订单" }],
		apis: [{ path: "/api/orders/{id}" }, { path: "/api/pay" }],
		logic: { entities: [{ name: "订单" }] },
	});

	const markdown = buildApiModelExport(model, "markdown");
	expect(markdown.filename).toBe(`商城-前台-api-record-${model.id.slice(4, 12)}.md`);
	for (const expected of [
		"# 商城 前台/API",
		"- 流量目标：https://shop.example.com",
		"- 源码范围：shop-api/",
		"## 接口文档",
		"服务地址：https://shop.example.com",
		"| GET | /api/orders/{id} | 查订单 |",
		// No summary was written, so the operation id stands in.
		"| POST | /api/users | createUser |",
		"## 业务实体",
		"### 订单",
		"| status | string | 待支付 \\| 已支付 |",
		"- 关系：N:1 用户：下单人",
		"### GET /api/orders/{id}：查订单",
		"- 备注：没有找到权限校验",
		"模块：支付；部分内容为推断",
		"`getOrder`（/work/src/OrderController.java:42）",
		"1. [service] `OrderService.find`（/work/src/OrderService.java:88）",
		"- 读 `t_order`（id, status）（/work/src/OrderMapper.xml:120）",
		"- 权限校验：未发现",
		"## 源码实体",
		"| 订单 | t_订单 | 用户 | 一行说明 | /work/src/entity/订单.java:10 |",
		"## 状态机",
		"| 待支付 | 已支付 | POST /pay | 余额充足 |  | /work/src/OrderService.java:200 |",
		"## 业务规则",
		"| 资源所有权 | 订单 | 只能看自己的 | GET /api/orders/{id} | /work/src/OrderController.java:1 |",
		"## 跨接口业务依赖",
		"| POST /pay | 依赖 | GET /api/orders/{id} |  | /work/src/OrderController.java:1 |",
	])
		expect(markdown.text).toContain(expected);
	// A section for something the record does not have would read as a finding that is not there.
	for (const absent of ["（无）", "## 实体关系"]) expect(markdown.text).not.toContain(absent);
});

test("a record with only one half exports without the other half's sections", () => {
	const document = stored(store.start(origin("p8", "只有文档"), { paths: { "/a": { get: { summary: "x" } } } }));
	expect(buildApiModelMarkdown(document)).toBe(
		[
			"# 只有文档",
			"",
			"- 接口：1 个路径，1 个操作",
			"- 业务实体：0 个",
			"- 源码映射：0 条",
			"- 状态机：0 个",
			"- 业务规则：0 条",
			"",
			"## 接口文档",
			"",
			"| 方法 | 路径 | 说明 |",
			"| --- | --- | --- |",
			"| GET | /a | x |",
		].join("\n"),
	);
	const source = storedSource(
		store.startSource(origin("p8", "只有源码"), { apis: [mapping()], source: "shop-api/" }, options),
	);
	const markdown = buildApiModelMarkdown(source);
	expect(markdown).toContain("- 源码范围：");
	expect(markdown).toContain("- 接口：0 个路径，0 个操作");
	expect(markdown).toContain("## API 源码映射");
	for (const absent of ["## 接口文档", "## 业务实体", "流量目标"]) expect(markdown).not.toContain(absent);
});

test("a source submission stores the models and puts every path into its /work form", () => {
	const model = storedSource(
		store.startSource(
			origin("p9", "商城后台"),
			{
				apis: [
					mapping(),
					// A path copied from a host-side file tool is stored the way the container sees it.
					mapping("POST", "/api/orders", {
						handler: {
							name: "createOrder",
							location: { file: join(work, "src/OrderController.java"), line: 60 },
						},
					}),
					mapping("POST", "/api/orders/{id}/pay"),
				],
				entities: [entity("订单"), entity("用户")],
				relations: [{ from: "订单", to: "用户", kind: "N:1", locations: [at(3, "src/entity/Order.java")] }],
				stateMachines: [
					{
						subject: "订单",
						field: "status",
						states: [{ name: "待支付" }, { name: "已支付" }],
						transitions: [
							{
								from: "待支付",
								to: "已支付",
								trigger: "POST /api/orders/{id}/pay",
								guard: "金额大于 0",
								locations: [at(200, "src/OrderService.java")],
							},
						],
						initial: "待支付",
						locations: [at(1, "src/enums/OrderStatus.java")],
					},
				],
				rules: [
					{
						id: "order.pay.precondition",
						kind: "precondition",
						subject: "POST /api/orders/{id}/pay",
						statement: "只有待支付的订单可以支付",
						apis: ["POST /api/orders/{id}/pay"],
						locations: [at(195, "src/OrderService.java")],
					},
				],
				apiDependencies: [
					{
						from: "POST /api/orders/{id}/pay",
						to: "POST /api/orders",
						kind: "requires",
						locations: [at(30, "src/PayService.java")],
					},
				],
				source: "shop-api/",
			},
			options,
		),
	);
	expect(model.id.startsWith("api-")).toBe(true);
	expect(model).toMatchObject({
		status: "modeling",
		title: "商城后台",
		target: "",
		source: "shop-api/",
		pathCount: 0,
		submissions: 1,
	});
	expect(model.apis.map((api) => api.handler.location)).toEqual([
		{ file: "/work/src/OrderController.java", line: 42 },
		{ file: "/work/src/OrderController.java", line: 60 },
		{ file: "/work/src/OrderController.java", line: 42 },
	]);
	expect(model.apis[0].dataAccess[0]).toMatchObject({
		operation: "read",
		table: "t_order",
		columns: ["id", "status"],
	});
	expect(countsOf(model.apis, model.logic)).toEqual({
		apiCount: 3,
		entityCount: 2,
		relationCount: 1,
		stateMachineCount: 1,
		ruleCount: 1,
		apiDependencyCount: 1,
	});
	expect(store.list({ projectId: "p9" })[0]).toMatchObject({
		title: "商城后台",
		source: "shop-api/",
		apiCount: 3,
		entityCount: 0,
		stateMachineCount: 1,
		ruleCount: 1,
	});
	// One audit line counts both halves as they stood.
	expect(
		store.events(model.id).map((event) => [event.kind, event.pathCount, event.apiCount, event.ruleCount]),
	).toEqual([
		["created", 0, 0, 0],
		["submitted", 0, 3, 1],
	]);
});

test("one record holds both halves, and each submission leaves the other half alone", () => {
	const document = stored(
		store.start(origin("p10", "商城"), {
			paths: { "/api/orders/{id}": { get: {} } },
			target: "https://shop.example.com",
			entities: [{ name: "订单" }],
		}),
	);
	const both = storedSource(
		store.submitSource(
			document.id,
			{
				apis: [mapping()],
				entities: [entity("订单")],
				rules: [{ id: "r1", kind: "invariant", subject: "订单", statement: "金额不能为负", locations: [at()] }],
				source: "shop-api/",
				title: "商城后台",
			},
			options,
		),
	);
	// The record keeps its id, and the title named later is the one it goes by.
	expect(both).toMatchObject({
		id: document.id,
		title: "商城后台",
		target: "https://shop.example.com",
		source: "shop-api/",
		pathCount: 1,
		operationCount: 1,
		submissions: 2,
	});
	expect(both.openapi.paths).toEqual({ "/api/orders/{id}": { get: {} } });
	expect(both.entities.map((item) => item.name)).toEqual(["订单"]);
	expect(countsOf(both.apis, both.logic)).toMatchObject({ apiCount: 1, entityCount: 1, ruleCount: 1 });

	const again = stored(store.submit(document.id, { paths: { "/api/users": { get: {} } } }));
	expect(again).toMatchObject({ pathCount: 2, operationCount: 2, submissions: 3 });
	expect(again.apis).toHaveLength(1);
	expect(again.logic.rules).toHaveLength(1);
	expect(
		store.events(document.id).map((event) => [event.kind, event.pathCount, event.apiCount, event.ruleCount]),
	).toEqual([
		["created", 0, 0, 0],
		["submitted", 1, 0, 0],
		["submitted", 1, 1, 1],
		["submitted", 2, 1, 1],
	]);
	expect(store.list({ projectId: "p10" })[0]).toMatchObject({
		pathCount: 2,
		entityCount: 1,
		apiCount: 1,
		ruleCount: 1,
	});

	// The other order: a record opened from the source takes the interface document later.
	const fromSource = storedSource(store.startSource(origin("p10"), { apis: [mapping("POST", "/api/pay")] }, options));
	const withDocument = stored(
		store.submit(fromSource.id, { paths: { "/api/users": { get: {} } }, target: "https://shop.example.com" }),
	);
	expect(withDocument).toMatchObject({
		id: fromSource.id,
		pathCount: 1,
		operationCount: 1,
		target: "https://shop.example.com",
		source: "",
		submissions: 2,
	});
	expect(withDocument.apis.map((api) => api.path)).toEqual(["/api/pay"]);
});

test("a source submission with anything wrong in it is refused whole, and names every reason", () => {
	const record = storedSource(store.startSource(origin("p11"), { entities: [entity("订单")] }, options));
	const result = store.submitSource(
		record.id,
		{
			apis: [
				{
					method: "FETCH",
					path: "orders",
					handler: { name: "getOrder", location: { file: "../secret.txt", line: 0 } },
					callChain: "OrderService.find",
					dataAccess: [],
					authChecks: [{ kind: "login", location: at(45) }],
					externalCalls: [{ kind: "http", target: "pay", location: at(1, "/etc/passwd") }],
				},
				mapping("GET", "/api/x", { callChain: [{ layer: "controller", name: "a", location: at(-1) }] }),
				mapping("GET", "/api/y", {
					handler: { name: "b", location: { file: "src/A.java", line: 10, endLine: 5 } },
				}),
			],
			entities: [{ name: "订单" }],
			rules: [{ id: "有 空格的 id", kind: "precondition", subject: "订单", statement: "x", locations: [at()] }],
		},
		options,
	);
	if (result.ok) throw new Error("the submission should have been refused");
	expect(result.errors).toEqual([
		"apis[0] 的 method 必须是：GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS / TRACE / ANY。",
		"apis[0] 的 path 必须是以 / 开头的路由（保留占位符，不含空白），例如 /api/orders/{id}，最长 512 个字符。",
		"apis[0].handler 的 file 无效：必须是项目工作目录里的文件，写成相对路径或 /work/... 。",
		"apis[0].handler 的 line 必须是从 1 开始的行号。",
		"apis[0].callChain 必须是数组（没有内容时给空数组）。",
		"apis[0].authChecks[0] 的 kind 必须是：authentication / authorization / ownership / other。",
		"apis[0].externalCalls[0] 的 file 无效：必须是项目工作目录里的文件，写成相对路径或 /work/... 。",
		"apis[1].callChain[0] 的 layer 必须是：service / repository / util / middleware / other。",
		"apis[1].callChain[0] 的 line 必须是从 1 开始的行号。",
		"apis[2].handler 的 endLine 必须是不小于 line 的行号。",
		"entities[0] 的 locations 必须是数组。",
		"rules[0] 的 id 只能包含字母、数字和 _ . : -，并且以字母或数字开头。",
	]);
	// Nothing of it reached the record.
	expect(store.get(record.id)).toMatchObject({ apis: [], submissions: 1 });
	expect(store.get(record.id)?.logic.entities.map((item) => item.name)).toEqual(["订单"]);
	expect(store.submitSource("api-missing", { apis: [] }, options)).toEqual({
		ok: false,
		errors: ["没有 id 为 api-missing 的业务建模记录。"],
	});
});

test("a refusal lists the first fifty problems and counts the rest", () => {
	const result = store.startSource(
		origin("p-refused"),
		{ entities: Array.from({ length: 60 }, (_, index) => ({ name: `e${index}` })) },
		options,
	);
	if (result.ok) throw new Error("the submission should have been refused");
	expect(result.errors).toHaveLength(51);
	expect(result.errors[49]).toBe("entities[49] 的 locations 必须是数组。");
	expect(result.errors[50]).toBe("另有 10 处问题未列出：改完以上几类后重新提交，会看到剩下的。");
	expect(store.list({ projectId: "p-refused" })).toEqual([]);
});

test("the four lists of an endpoint must be there even when empty, and an empty one is stored as empty", () => {
	const { callChain: _chain, ...withoutChain } = mapping();
	const refused = store.startSource(origin("p12"), { apis: [withoutChain] }, options);
	if (refused.ok) throw new Error("the submission should have been refused");
	expect(refused.errors).toEqual(["apis[0].callChain 必须是数组（没有内容时给空数组）。"]);

	const bare = mapping("DELETE", "/api/orders/{id}", {
		summary: "",
		callChain: [],
		dataAccess: [],
		authChecks: [],
		externalCalls: [],
		confidence: "inferred",
		notes: "整条链上没有找到权限校验",
	});
	const model = storedSource(store.startSource(origin("p12"), { apis: [bare] }, options));
	// No summary was given, so there is no summary key; an empty string is not kept.
	expect(model.apis[0]).toEqual({
		method: "DELETE",
		path: "/api/orders/{id}",
		module: "订单",
		handler: { name: "getOrder", location: { file: "/work/src/OrderController.java", line: 42 } },
		callChain: [],
		dataAccess: [],
		authChecks: [],
		externalCalls: [],
		confidence: "inferred",
		notes: "整条链上没有找到权限校验",
	});
});

test("sending an item again replaces it where it stood, under a key that ignores case", () => {
	const first = store.startSource(
		origin("p13"),
		{ apis: [mapping("GET", "/a"), mapping("POST", "/b")], entities: [entity("订单")] },
		options,
	);
	const second = store.submitSource(
		storedSource(first).id,
		{
			// The same endpoint as GET /a: the method comes in lower case and the mapping is replaced.
			apis: [mapping("get", "/a", { summary: "改写后的说明", module: "订单中心" }), mapping("GET", "/c")],
		},
		options,
	);
	const model = storedSource(second);
	expect(model.apis.map((api) => [api.method, api.path, api.summary])).toEqual([
		["GET", "/a", "改写后的说明"],
		["POST", "/b", "查订单"],
		["GET", "/c", "查订单"],
	]);
	// A list the call did not name is left as it was.
	expect(model.logic.entities.map((item) => item.name)).toEqual(["订单"]);
	expect(model.submissions).toBe(2);
});

test("each list of the logic model merges on its own key", () => {
	const first = store.startSource(
		origin("p14"),
		{
			entities: [entity("订单")],
			relations: [{ from: "订单", to: "用户", kind: "N:1", locations: [at()] }],
			stateMachines: [
				{
					subject: "订单",
					states: [{ name: "待支付" }, { name: "已支付" }],
					transitions: [{ from: "待支付", to: "已支付", locations: [at()] }],
					locations: [at()],
				},
			],
			rules: [
				{ id: "r1", kind: "invariant", subject: "订单", statement: "金额不能为负", locations: [at()] },
				{ id: "r2", kind: "ownership", subject: "订单", statement: "订单属于下单用户", locations: [at()] },
			],
			apiDependencies: [{ from: "GET /a", to: "GET /b", kind: "calls", locations: [at()] }],
		},
		options,
	);
	const second = store.submitSource(
		storedSource(first).id,
		{
			// Same name: replaced. New name: appended.
			entities: [entity("订单", { owner: "组织" }), entity("用户")],
			// Same ends and kind: replaced. A different kind is another relation.
			relations: [
				{ from: "订单", to: "用户", kind: "N:1", description: "通过 user_id", locations: [at()] },
				{ from: "用户", to: "订单", kind: "1:N", locations: [at()] },
			],
			// Same subject: the whole machine is replaced, so its transitions start over.
			stateMachines: [
				{
					subject: "订单",
					states: [{ name: "新建" }, { name: "完成" }],
					transitions: [{ from: "新建", to: "完成", locations: [at()] }],
					locations: [at()],
				},
			],
			// r1 is corrected; r2 is not named and stays.
			rules: [
				{ id: "r1", kind: "invariant", subject: "订单", statement: "金额必须大于或等于 0", locations: [at()] },
			],
			apiDependencies: [{ from: "GET /a", to: "GET /b", kind: "calls", description: "直接调用", locations: [at()] }],
		},
		options,
	);
	const { logic } = storedSource(second);
	expect(logic.entities.map((item) => [item.name, item.owner])).toEqual([
		["订单", "组织"],
		["用户", "用户"],
	]);
	expect(logic.relations.map((item) => [item.from, item.to, item.kind, item.description])).toEqual([
		["订单", "用户", "N:1", "通过 user_id"],
		["用户", "订单", "1:N", undefined],
	]);
	expect(logic.stateMachines).toHaveLength(1);
	expect(logic.stateMachines[0].transitions).toEqual([
		{ from: "新建", to: "完成", locations: [{ file: "/work/src/OrderController.java", line: 1 }] },
	]);
	expect(logic.rules.map((item) => [item.id, item.statement])).toEqual([
		["r1", "金额必须大于或等于 0"],
		["r2", "订单属于下单用户"],
	]);
	expect(logic.apiDependencies[0].description).toBe("直接调用");
});

test("a state machine only moves between the states it declares", () => {
	const machine = {
		subject: "提现申请",
		states: [{ name: "申请中" }, { name: "申请中" }, { name: "已到账" }],
		transitions: [{ from: "申请中", to: "已驳回", locations: [at()] }],
		initial: "不存在",
		locations: [at()],
	};
	const refused = store.startSource(
		origin("p-refused"),
		{ stateMachines: [machine, { ...machine, subject: "空", states: [], transitions: [] }] },
		options,
	);
	if (refused.ok) throw new Error("the submission should have been refused");
	expect(refused.errors).toEqual([
		"stateMachines[0].states[1] 的状态「申请中」重复声明了。",
		"stateMachines[0].transitions[0] 的 to「已驳回」不是这个状态机里声明过的状态。",
		"stateMachines[0] 的 initial「不存在」不是这个状态机里声明过的状态。",
		"stateMachines[1].states 至少要有一个状态。",
	]);
	const record = storedSource(store.startSource(origin("p15"), { entities: [entity("订单")] }, options));
	expect(store.submitSource(record.id, { relations: "not a list" }, options)).toEqual({
		ok: false,
		errors: ["relations 必须是数组。"],
	});
});

test("what one call and one record may hold", () => {
	const rule = (index: number) => ({
		id: `r${index}`,
		kind: "postcondition",
		subject: "订单",
		statement: "写入一条流水",
		locations: [at()],
	});
	const record = storedSource(store.startSource(origin("p16"), { entities: [entity("订单")] }, options));
	// A call that carries nothing to store is not a submission.
	expect(store.submitSource(record.id, { note: "只有备注" }, options)).toEqual({
		ok: false,
		errors: ["提交里没有任何内容：至少给 apis 或业务逻辑模型的某一张表。"],
	});
	expect(
		store.submitSource(
			record.id,
			{ apis: Array.from({ length: 51 }, (_, index) => mapping("GET", `/a/${index}`)) },
			options,
		),
	).toEqual({ ok: false, errors: ["apis 超过 50 项。"] });
	expect(
		store.submitSource(record.id, { rules: Array.from({ length: 101 }, (_, index) => rule(index)) }, options),
	).toEqual({
		ok: false,
		errors: ["rules 超过 100 项：请分批提交。"],
	});
	// A table with more columns than one access may list is refused, like the other over-large lists.
	const columns = Array.from({ length: 201 }, (_, index) => `c${index}`);
	const wide = store.submitSource(
		record.id,
		{
			apis: [
				mapping("GET", "/api/wide", {
					dataAccess: [{ operation: "read", table: "t_wide", columns, location: at(1) }],
				}),
			],
		},
		options,
	);
	if (wide.ok) throw new Error("the submission should have been refused");
	expect(wide.errors).toEqual(["apis[0].dataAccess[0] 的 columns 超过 200 个。"]);
	for (let batch = 0; batch < 10; batch++) {
		storedSource(
			store.submitSource(
				record.id,
				{ rules: Array.from({ length: 100 }, (_, index) => rule(batch * 100 + index)) },
				options,
			),
		);
	}
	expect(store.submitSource(record.id, { rules: [rule(1000)] }, options)).toEqual({
		ok: false,
		errors: ["业务规则数量 1001 超过上限 1000：请只保留核实过的内容，或分几次业务建模来做。"],
	});
	// The refused batch left the thousand that fit as they were.
	expect(store.get(record.id)?.logic.rules).toHaveLength(1000);
});

test("references to things not submitted come back as warnings, not refusals", () => {
	const first = store.startSource(
		origin("p17"),
		{
			relations: [{ from: "订单", to: "优惠券", kind: "N:1", locations: [at()] }],
			rules: [
				{
					id: "r1",
					kind: "precondition",
					subject: "支付",
					statement: "先有订单",
					apis: ["post /api/orders/{id}/pay"],
					locations: [at()],
				},
			],
		},
		options,
	);
	// No endpoint has been mapped yet, so an endpoint reference is not held against the model.
	if (!first.ok) throw new Error(first.errors.join("\n"));
	expect(first.warnings).toEqual(["关系引用了 2 个尚未提交的实体：订单、优惠券。"]);
	const record = first.model;
	// The endpoint arrives lower case in the first rule and upper case in the mapping: the same endpoint.
	storedSource(store.submitSource(record.id, { apis: [mapping("POST", "/api/orders/{id}/pay")] }, options));
	const second = store.submitSource(
		record.id,
		{
			rules: [
				{
					id: "r2",
					kind: "precondition",
					subject: "支付",
					statement: "x",
					apis: ["GET /nowhere"],
					locations: [at()],
				},
			],
		},
		options,
	);
	if (!second.ok) throw new Error(second.errors.join("\n"));
	expect(second.warnings).toEqual([
		"关系引用了 2 个尚未提交的实体：订单、优惠券。",
		"规则、依赖或状态迁移引用了 1 个没有源码映射的接口：GET /nowhere。",
	]);
});

test("a database from before a record could hold the source half opens with that half empty", () => {
	const path = join(dir, "old", "apimodels.db");
	mkdirSync(dirname(path), { recursive: true });
	// Written the way the console wrote it when a record was only an interface document.
	const old = openSqliteDatabase(path);
	old.exec(`
CREATE TABLE api_models (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT,
  session_path TEXT,
  title TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  openapi TEXT NOT NULL,
  entities TEXT NOT NULL DEFAULT '[]',
  path_count INTEGER NOT NULL DEFAULT 0,
  operation_count INTEGER NOT NULL DEFAULT 0,
  entity_count INTEGER NOT NULL DEFAULT 0,
  submissions INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT
);
CREATE TABLE api_model_events (
  id INTEGER PRIMARY KEY,
  model_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT,
  path_count INTEGER,
  operation_count INTEGER
);
`);
	old.prepare(
		"INSERT INTO api_models (id, project_id, session_id, session_path, title, target, status, openapi, entities, path_count, operation_count, entity_count, submissions, created_at, updated_at, done_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		"api-legacy",
		"p-old",
		"s-old",
		null,
		"旧记录",
		"https://old.example.com",
		"modeling",
		JSON.stringify(DOC({ "/api/orders": { get: { summary: "订单列表" } } })),
		JSON.stringify([{ name: "订单", fields: [{ name: "id", type: "string" }] }]),
		1,
		1,
		1,
		1,
		"2026-11-20T10:00:00.000Z",
		"2026-11-20T10:01:00.000Z",
		null,
	);
	for (const [time, kind, note, paths] of [
		["2026-11-20T10:00:00.000Z", "created", null, 0],
		["2026-11-20T10:01:00.000Z", "submitted", "首批", 1],
	] as const)
		old.prepare(
			"INSERT INTO api_model_events (model_id, at, kind, note, path_count, operation_count) VALUES (?, ?, ?, ?, ?, ?)",
		).run("api-legacy", time, kind, note, paths, paths);
	old.close();

	const legacy = new ApiModelStore(path);
	const record = legacy.get("api-legacy") as SentinelApiModel;
	expect(record).toMatchObject({
		title: "旧记录",
		target: "https://old.example.com",
		status: "modeling",
		pathCount: 1,
		operationCount: 1,
		submissions: 1,
		createdAt: "2026-11-20T10:00:00.000Z",
	});
	expect(Object.keys(record.openapi.paths as Record<string, unknown>)).toEqual(["/api/orders"]);
	expect(record.entities.map((item) => item.name)).toEqual(["订单"]);
	// The columns were added, and every one of them reads as an empty half.
	expect(record.source).toBe("");
	expect(record.apis).toEqual([]);
	expect(record.logic).toEqual({ entities: [], relations: [], stateMachines: [], rules: [], apiDependencies: [] });
	expect(legacy.list()).toEqual([
		expect.objectContaining({
			id: "api-legacy",
			source: "",
			entityCount: 1,
			apiCount: 0,
			stateMachineCount: 0,
			ruleCount: 0,
		}),
	]);
	// The audit lines written before the change carry what was counted at the time, and nothing else.
	expect(legacy.events("api-legacy")).toEqual([
		{ at: "2026-11-20T10:00:00.000Z", kind: "created", pathCount: 0, operationCount: 0 },
		{ at: "2026-11-20T10:01:00.000Z", kind: "submitted", note: "首批", pathCount: 1, operationCount: 1 },
	]);

	// The old record takes new work in the half it did not have, and keeps its own.
	const added = legacy.submitSource(
		"api-legacy",
		{ apis: [mapping()], entities: [entity("订单")], source: "shop-api/" },
		{ ...options, now: new Date("2026-11-25T10:00:00.000Z") },
	);
	expect(storedSource(added)).toMatchObject({
		pathCount: 1,
		operationCount: 1,
		source: "shop-api/",
		submissions: 2,
	});
	expect(legacy.submit("api-legacy", { paths: { "/api/users": { get: {} } } })?.model?.pathCount).toBe(2);
	expect(legacy.finish("api-legacy", "done")?.status).toBe("done");
	expect(legacy.events("api-legacy").map((event) => [event.kind, event.pathCount, event.apiCount])).toEqual([
		["created", 0, undefined],
		["submitted", 1, undefined],
		["submitted", 1, 1],
		["submitted", 2, 1],
		["done", 2, 1],
	]);
	legacy.close();

	// Opening the same file again finds every column in place.
	const again = new ApiModelStore(path);
	expect(again.get("api-legacy")).toMatchObject({ status: "done", pathCount: 2 });
	expect(again.list({ projectId: "p-old", search: "shop-api" }).map((item) => item.id)).toEqual(["api-legacy"]);
	again.close();
});
