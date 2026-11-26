/**
 * Unit tests for business modeling: the four tools, the per-session state, the
 * loadout rule, the instruction, and the two markers.
 *
 * The invariant these tests exist for: every agent knows the project's modeling
 * records exist and can read them, but nobody writes one unasked. That rests on
 * three things, and each is checked here — the three tools that write are
 * declared `defaultActive: true` and open their description and guidelines by
 * saying not to call them unless modeling was asked for, the read tool has no
 * way to write, and the first accepted submission opens the record while
 * `api_model_done` still refuses without one.
 *
 * The instruction is checked too, and for a different reason: restoring an API
 * from traffic and reading a code base are the whole point of the feature, and
 * the instruction is where the model is told which of the two the inputs allow
 * for, how to work through each, and where the discipline is.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApiModelReadTools, createApiModelTools, type ModelingPort } from "../src/apimodel-tool.ts";
import { type ApiModelOrigin, ApiModelStore, buildApiModelExport } from "../src/apimodels.ts";
import {
	buildModelingBrief,
	buildModelingEndMessage,
	MODELING_MESSAGE_CUSTOM_TYPE,
	MODELING_READ_TOOLS,
	MODELING_STATE_CUSTOM_TYPE,
	MODELING_TOOLS,
	MODELING_WRITE_TOOLS,
	modelingRecordLine,
	modelingRunFromEntry,
	modelingState,
	modelingToolLoadout,
	readModelingRun,
} from "../src/modeling.ts";
import type { SentinelApiModel, SentinelApiSourceMapping } from "../src/protocol.ts";
import { countsOf } from "../src/sourcemodels.ts";
import * as modeling_contract from "./contract/examples/modeling.ts";
import { at, DOC, entity, mapping, record, summary } from "./modeling-fixtures.ts";

interface CallResult {
	content: { type?: string; text?: string }[];
	isError?: boolean;
	details?: Record<string, unknown>;
}

type CallableTool = {
	name: string;
	defaultActive?: boolean;
	description?: string;
	promptGuidelines?: string[];
	execute: (toolCallId: string, params: never) => Promise<CallResult>;
};

function toolOf(tools: ToolDefinition[], name: string): CallableTool {
	const found = tools.find((tool) => tool.name === name);
	if (!found) throw new Error(`tool ${name} is not mounted`);
	return found as unknown as CallableTool;
}

function textOf(result: CallResult): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

/** The JSON a read returns: everything after the title line. */
function bodyOf(result: CallResult): Record<string, unknown> {
	return JSON.parse(textOf(result).split("\n").slice(1).join("\n")) as Record<string, unknown>;
}

let dir: string;
let counter = 0;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "zg-modeling-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/**
 * A session wired the way the runtime wires it, backed by the real store: no
 * record until the agent's first accepted submission, then that record for
 * every submission after it, whichever half it carries.
 */
function harness(origin: Partial<ApiModelOrigin> = {}) {
	const store = new ApiModelStore(join(dir, `modeling-${counter++}.db`));
	const session = {
		run: undefined as { runId: string } | undefined,
		// The defaults pin the project to a string: the tests read the project's records back.
		origin: { projectId: "p1", sessionId: "s1", sessionPath: null, title: "商城", ...origin } as ApiModelOrigin & {
			projectId: string;
		},
		done: [] as string[],
	};
	const options = { hostWorkDir: join(dir, "work") };
	const port: ModelingPort = {
		current: () => session.run,
		submit: (input) => {
			const result = session.run ? store.submit(session.run.runId, input) : store.start(session.origin, input);
			const model = result.model;
			if (!model) return { ok: false, errors: result.errors ?? ["提交失败。"] };
			session.run ??= { runId: model.id };
			return {
				ok: true,
				pathCount: model.pathCount,
				operationCount: model.operationCount,
				entityCount: model.entities.length,
				warnings: result.errors ?? [],
			};
		},
		submitSource: (input) => {
			const result = session.run
				? store.submitSource(session.run.runId, input, options)
				: store.startSource(session.origin, input, options);
			if (!result.ok) return result;
			session.run ??= { runId: result.model.id };
			return { ok: true, counts: countsOf(result.model.apis, result.model.logic), warnings: result.warnings };
		},
		done: (summaryText) => {
			session.done.push(summaryText);
		},
	};
	const records = () => store.list({ projectId: session.origin.projectId });
	const read = createApiModelReadTools({
		list: records,
		read: (id) => store.get(id),
		guide: () => buildModelingBrief("商城项目", records()),
	});
	return { store, tools: createApiModelTools(port), read, session, records };
}

test("the tools are declared everywhere, and the ones that write say when not to call them", () => {
	const { tools, read } = harness();
	expect(tools.map((tool) => tool.name)).toEqual([...MODELING_WRITE_TOOLS]);
	expect(read.map((tool) => tool.name)).toEqual([...MODELING_READ_TOOLS]);
	for (const tool of [...tools, ...read]) expect(tool.defaultActive).toBe(true);
	for (const tool of tools) {
		// The guard is the wording, not the absence of the tool: the description and
		// the first guideline both tell the model not to call it unasked.
		expect(tool.description).toContain("if business modeling is not asked for, do not call this tool");
		expect(tool.promptGuidelines?.[0]).toContain("do not call this tool");
	}
	// The source submit tool insists on two things, spelled out where the model reads them.
	const source = toolOf(tools, "source_model_submit");
	expect(source.promptGuidelines?.join("\n")).toContain("empty `authChecks`");
	expect(source.promptGuidelines?.join("\n")).toContain("Read the code before you write a location");
	// The document submit tool takes its interfaces from traffic or from the source,
	// and an interface taken from the source has to say so.
	const document = toolOf(tools, "api_model_submit");
	for (const expected of [
		"The interfaces have two sources",
		"restore them from it",
		"write the interfaces the source declares",
		"来自源码",
	])
		expect(`${document.description} ${(document.promptGuidelines ?? []).join(" ")}`).toContain(expected);
	// The read tool has no way to write, and explains what it can be asked for.
	const reader = toolOf(read, "api_model_read");
	for (const part of ["guide", "overview", "document", "entities", "apis", "logic"]) {
		expect(reader.description).toContain(part);
	}
	const words = `${reader.description} ${(reader.promptGuidelines ?? []).join(" ")}`;
	for (const expected of ["authChecks", "rules", "stateMachines", 'part: "guide"']) expect(words).toContain(expected);
});

test("the loadout rule always carries every modeling tool", () => {
	const base = ["read", "bash", "edit", "write", "session_title"];
	// Whatever the session state, the tools are in the set: that is what lets the
	// operator ask for modeling in the conversation, and what lets a worker be
	// given it as a task.
	expect(modelingToolLoadout(base)).toEqual([...base, ...MODELING_TOOLS]);
	// A loadout that already carries them is not duplicated, and the rest keeps its order.
	expect(modelingToolLoadout([...base, ...MODELING_TOOLS])).toEqual([...base, ...MODELING_TOOLS]);
	// A loadout restored from an older transcript gets them back.
	expect(modelingToolLoadout(["read"])).toEqual(["read", ...MODELING_TOOLS]);
	expect(modelingToolLoadout([...base, "api_model_read"])).toEqual([...base, ...MODELING_TOOLS]);
});

test("partial batches pass the argument check the SDK makes before the tool runs", () => {
	// The SDK checks a call's arguments against `parameters`, and a call that does
	// not conform never reaches the tool. Seen end to end once: a list marked
	// required here refused every partial batch — the normal way to deliver a
	// large project — while a direct call of `execute` (what the other tests here
	// do) stored it.
	const { tools, read } = harness();
	const all = [...tools, ...read];
	const schemaOf = (name: string) => {
		const tool = all.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`${name} is not declared`);
		return tool.parameters;
	};
	/** True when the arguments conform, else every reason they do not. */
	const check = (schema: ReturnType<typeof schemaOf>, args: unknown): boolean | string => {
		const errors = [...Value.Errors(schema, args)];
		return errors.length === 0 ? true : errors.map((error) => error.message).join("; ");
	};
	const source = schemaOf("source_model_submit");
	const document = schemaOf("api_model_submit");
	const location = { file: "src/A.java", line: 3 };
	expect(check(source, { apis: [mapping("GET", "/api/orders/{id}")] })).toBe(true);
	expect(
		check(source, { apis: [mapping("GET", "/a")], source: "shop-api/", title: "商城后台", note: "订单模块" }),
	).toBe(true);
	expect(
		check(source, {
			rules: [{ id: "r1", kind: "invariant", subject: "订单", statement: "金额不为负", locations: [location] }],
		}),
	).toBe(true);
	expect(
		check(source, {
			entities: [{ name: "订单", locations: [location] }],
			relations: [{ from: "订单", to: "用户", kind: "N:1", locations: [location] }],
		}),
	).toBe(true);
	// What the source submit tool does insist on: the four lists of an endpoint. An
	// empty one is a finding; a missing one is a gap.
	const gap = check(source, { apis: [{ method: "GET", path: "/a", handler: { name: "handler", location } }] });
	expect(typeof gap).toBe("string");
	expect(gap).toContain("must have required properties");

	expect(check(document, { paths: { "/a": { get: {} } } })).toBe(true);
	expect(
		check(document, { paths: { "/a": { get: {} } }, components: { schemas: { User: { type: "object" } } } }),
	).toBe(true);
	expect(check(document, { openapi: DOC({ "/a": { get: {} } }), entities: [{ name: "订单" }] })).toBe(true);
	expect(check(schemaOf("api_model_done"), { summary: "覆盖订单模块" })).toBe(true);

	// Every parameter of the read tool is optional on its own.
	for (const args of [
		{},
		{ part: "guide" },
		{ id: "api-1" },
		{ id: "api-1", part: "logic", section: "rules", page: 1 },
		{ id: "api-1", part: "document", search: "订单" },
		{ id: "api-1", part: "apis", module: "订单", pageSize: 30 },
	])
		expect(check(schemaOf("api_model_read"), args), JSON.stringify(args)).toBe(true);
	// What is refused before the tool runs.
	expect(check(schemaOf("api_model_read"), { id: "api-1", part: "apis", page: 0 })).not.toBe(true);
	expect(check(schemaOf("api_model_read"), { id: "api-1", part: "apis", pageSize: 31 })).not.toBe(true);
	expect(check(schemaOf("api_model_read"), { id: "api-1", part: "components" })).not.toBe(true);
});

test("the first submission opens the record, and both halves then land in it", async () => {
	const { tools, store, session, records } = harness();
	const submit = toolOf(tools, "api_model_submit");
	const source = toolOf(tools, "source_model_submit");
	const first = await submit.execute("call-1", {
		paths: { "/a": { get: {} } },
		target: "https://shop.example.com",
	} as never);
	expect(first.isError).toBeFalsy();
	expect(textOf(first)).toContain("路径 1 个");
	const opened = session.run?.runId ?? "";
	expect(opened).toBeTruthy();
	expect(records()).toHaveLength(1);

	// The source half goes into the record the first submission opened.
	const second = await source.execute("call-2", {
		apis: [mapping()],
		entities: [entity("订单")],
		source: "shop-api/",
	} as never);
	expect(second.isError).toBeFalsy();
	expect(textOf(second)).toContain("接口映射 1 条，业务实体 1 个，状态机 0 个，业务规则 0 条");
	expect(second.details).toMatchObject({ ok: true, runId: opened });
	expect(session.run?.runId).toBe(opened);
	const stored = store.get(opened) as SentinelApiModel;
	expect(stored).toMatchObject({
		pathCount: 1,
		operationCount: 1,
		target: "https://shop.example.com",
		source: "shop-api/",
	});
	expect(countsOf(stored.apis, stored.logic)).toMatchObject({ apiCount: 1, entityCount: 1 });
	expect(records()[0]).toMatchObject({ status: "modeling", submissions: 2, entityCount: 0, apiCount: 1 });

	// The other order opens the record from the source just the same.
	const other = harness();
	await toolOf(other.tools, "source_model_submit").execute("call-3", { apis: [mapping()] } as never);
	const document = await toolOf(other.tools, "api_model_submit").execute("call-4", {
		paths: { "/a": { get: {} } },
	} as never);
	expect(document.details).toMatchObject({ ok: true, runId: other.session.run?.runId });
	expect(other.records()).toHaveLength(1);
});

test("a first submission that stores nothing opens no record, and says why", async () => {
	const { tools, session, records } = harness();
	const submit = toolOf(tools, "api_model_submit");
	const invalid = await submit.execute("call-1", { openapi: { openapi: "2.0", paths: {} } } as never);
	expect(invalid.isError).toBe(true);
	expect(textOf(invalid)).toContain("openapi 版本 2.0 不受支持");
	// A skeleton on its own is not content: the skeleton travels with the first endpoints.
	const skeleton = await submit.execute("call-2", { components: { schemas: { User: { type: "object" } } } } as never);
	expect(skeleton.isError).toBe(true);
	expect(textOf(skeleton)).toContain("第一次提交没有存下任何内容");
	const bare = await toolOf(tools, "source_model_submit").execute("call-3", { note: "只有备注" } as never);
	expect(bare.isError).toBe(true);
	expect(textOf(bare)).toContain("提交里没有任何内容");
	expect(session.run).toBeUndefined();
	expect(records()).toEqual([]);

	// A submission that names things it did not submit is stored, and says so.
	const warned = await submit.execute("call-4", {
		paths: { "/a": { get: {} } },
		entities: [{ description: "没有名字" }],
	} as never);
	expect(warned.isError).toBeFalsy();
	expect(textOf(warned)).toContain("路径 1 个");
	expect(textOf(warned)).toContain("entities[0] 缺少 name");
});

test("documents submitted through the tool are stored, counted and merged", async () => {
	const { tools, store, session } = harness();
	const submit = toolOf(tools, "api_model_submit");
	const whole = await submit.execute("call-1", {
		openapi: { openapi: "3.0.3", info: { title: "商城", version: "1.0.0" }, paths: { "/a": { get: {}, post: {} } } },
		target: "https://shop.example.com",
		entities: [{ name: "订单", relations: [{ target: "用户" }] }],
	} as never);
	expect(whole.isError).toBeFalsy();
	expect(textOf(whole)).toContain("路径 1 个，操作 2 个，业务实体 1 个");
	const id = session.run?.runId ?? "";
	expect(id).toBeTruthy();
	expect(whole.details).toMatchObject({ ok: true, runId: id, pathCount: 1, operationCount: 2, entityCount: 1 });

	const second = await submit.execute("call-2", { paths: { "/orders": { get: {}, post: {} } } } as never);
	expect(textOf(second)).toContain("路径 2 个，操作 4 个");
	const stored = store.get(id) as SentinelApiModel;
	expect(Object.keys(stored.openapi.paths as Record<string, unknown>)).toEqual(["/a", "/orders"]);
	expect(stored.target).toBe("https://shop.example.com");
	expect(stored.entities[0].name).toBe("订单");
});

test("an empty document says so, and a refused document comes back with the reasons to fix", async () => {
	const { tools, store, session } = harness();
	const submit = toolOf(tools, "api_model_submit");
	// Entities on their own open the record; the document half is still empty, and
	// the tool tells the model to keep going rather than treating it as done — from
	// traffic where there is any, otherwise from what the source declares.
	const entitiesOnly = await submit.execute("call-1", { entities: [{ name: "用户" }] } as never);
	expect(entitiesOnly.isError).toBeFalsy();
	expect(textOf(entitiesOnly)).toContain("还没有任何接口");
	expect(textOf(entitiesOnly)).toContain("读源码就按源码里声明的路由");
	const refused = await submit.execute("call-2", {
		openapi: { openapi: "2.0", info: {}, paths: { users: {} } },
	} as never);
	expect(refused.isError).toBe(true);
	expect(textOf(refused)).toContain("提交被拒绝");
	expect(textOf(refused)).toContain("info.title 不能为空");
	expect(textOf(refused)).toContain("paths 的键必须以 / 开头");
	expect(store.get(session.run?.runId ?? "")?.submissions).toBe(1);
});

test("a refused source submission comes back with every reason and stores nothing", async () => {
	const { tools, store, session } = harness();
	const result = await toolOf(tools, "source_model_submit").execute("call-1", {
		apis: [
			{
				method: "GET",
				path: "orders",
				handler: { name: "h", location: at() },
				callChain: [],
				dataAccess: [],
				authChecks: [],
				externalCalls: [],
			},
		],
		entities: [{ name: "订单" }],
	} as never);
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("提交被拒绝，未入库");
	expect(textOf(result)).toContain("apis[0] 的 path 必须是以 / 开头的路由");
	expect(textOf(result)).toContain("entities[0] 的 locations 必须是数组");
	expect(textOf(result)).toContain("请按上述原因修改后重新提交");
	expect(result.details).toMatchObject({ ok: false, error: "invalid-model" });
	expect(session.run).toBeUndefined();
	expect(store.list({ projectId: "p1" })).toEqual([]);
});

test("api_model_done refuses without a record, needs a conclusion, and reports it once", async () => {
	const orphan = createApiModelTools({
		current: () => undefined,
		submit: () => {
			throw new Error("submit must not be reached");
		},
		submitSource: () => {
			throw new Error("submitSource must not be reached");
		},
		done: () => {
			throw new Error("done must not be reached");
		},
	});
	const refused = await toolOf(orphan, "api_model_done").execute("call-1", { summary: "完成" } as never);
	expect(refused.isError).toBe(true);
	expect(textOf(refused)).toContain("没有进行中的业务建模");
	expect(refused.details).toMatchObject({ error: "no-modeling-run" });

	const { tools, session } = harness();
	await toolOf(tools, "api_model_submit").execute("call-2", { paths: { "/a": { get: {} } } } as never);
	const done = toolOf(tools, "api_model_done");
	const blank = await done.execute("call-3", { summary: "   " } as never);
	expect(blank.isError).toBe(true);
	expect(textOf(blank)).toContain("建模结论不能为空");
	expect(session.done).toEqual([]);
	const closed = await done.execute("call-4", { summary: "覆盖用户与订单，支付未覆盖" } as never);
	expect(closed.isError).toBeFalsy();
	expect(textOf(closed)).toContain("业务建模已结束");
	expect(closed.details).toMatchObject({ ok: true, runId: session.run?.runId });
	expect(session.done).toEqual(["覆盖用户与订单，支付未覆盖"]);
});

test("the run survives on the branch, and null clears it", () => {
	const entry = { type: "custom", customType: MODELING_STATE_CUSTOM_TYPE, data: { runId: "api-1" } };
	expect(readModelingRun([{ type: "message" }, entry])).toEqual({ runId: "api-1" });
	// The last entry wins: appending null is how a run ends.
	expect(readModelingRun([entry, { type: "custom", customType: MODELING_STATE_CUSTOM_TYPE, data: null }])).toBeNull();
	expect(readModelingRun([{ type: "custom", customType: "zg-mode", data: { mode: "auto" } }])).toBeNull();
	// A foreign or malformed entry never starts a run.
	expect(
		readModelingRun([{ type: "custom", customType: MODELING_STATE_CUSTOM_TYPE, data: { target: "x" } }]),
	).toBeNull();
	expect(modelingRunFromEntry(undefined)).toBeUndefined();
	expect(modelingRunFromEntry("nope")).toBeUndefined();
	expect(modelingRunFromEntry(null)).toBeNull();
	// An entry written when the run carried more than its record keeps working.
	expect(modelingRunFromEntry({ runId: "api-2", target: "https://a", startedAt: 5 })).toEqual({ runId: "api-2" });
});

test("the instruction decides the scope by the inputs, names the four tools, and says where the discipline is", () => {
	const brief = buildModelingBrief("商城项目", []);
	expect(brief.startsWith("【业务建模】")).toBe(true);
	for (const tool of MODELING_TOOLS) expect(brief).toContain(tool);
	// What to do follows from what there is to work with. The interface document
	// has two sources, so a project with only source still gets one.
	for (const rule of [
		"先定范围",
		"有流量：还原接口文档",
		"工作目录里有源码：读源码",
		"把源码里声明的接口写进接口文档",
		"照代码里写的填",
		"注明「来自源码」",
		"两边都有的接口以实际响应为准",
		"先问操作员一句",
		"不要凭空生成",
	])
		expect(brief, rule).toContain(rule);
	expect(brief).toContain("一、接口文档");
	expect(brief).toContain("一、从流量还原接口文档（有流量时做）");
	expect(brief).toContain("二、读源码（工作目录里有源码时做）");
	// The first submission opens the record, so it has to carry something.
	expect(brief).toContain("第一次提交就是这条记录的开始");
	// Reading the source works through its steps in order, and the interface
	// document is written from what the source declares along the way.
	const at = (step: string) => {
		const index = brief.indexOf(step);
		expect(index, step).toBeGreaterThan(-1);
		return index;
	};
	const steps = ["先定位源码和范围", "再找入口", "逐模块映射接口", "把接口写进接口文档", "归纳业务逻辑模型", "收尾"];
	for (let index = 1; index < steps.length; index++)
		expect(at(steps[index]), `${steps[index - 1]} comes before ${steps[index]}`).toBeGreaterThan(
			at(steps[index - 1]),
		);
	expect(brief).toContain("用 api_model_submit 按模块提交这个模块的接口");
	// The tool that writes the document says where its interfaces may come from.
	expect(brief).toContain("读源码时写源码里声明的接口");
	const stacks: Record<string, string[]> = {
		"Java / Spring": ["@RestController", "@PreAuthorize", "SecurityFilterChain", "@Aspect", "Mapper", "Feign"],
		Go: ["gin", "ServeMux", "GORM", "中间件", "grpc"],
		PHP: ["Laravel", "routes/api.php", "Eloquent", "Policy", "ThinkPHP", "Db::name", "Guzzle"],
		Python: ["Django", "urls.py", "ViewSet", "permission_classes", "@login_required", "Flask", "FastAPI", "Depends"],
		Node: ["Express", "@Controller", "Guard", "TypeORM", "Prisma", "axios"],
	};
	for (const [stack, markers] of Object.entries(stacks))
		for (const marker of markers) expect(brief, `${stack} should mention ${marker}`).toContain(marker);
	// What must never be done, for each source of the document and for the models.
	for (const rule of [
		"从流量还原的接口和字段，只提交实际验证过的",
		"从源码写进接口文档的，只写代码里写明的",
		"源码中未确认",
		"不要编造端点、参数或响应字段来把文档填满",
		"不要把真实凭据",
		"只写读过的位置",
		"没找到就写没找到",
		"authChecks 给空数组",
		"不要编造调用链",
		"inferred",
		"不运行目标代码",
		"不改任何源文件",
	])
		expect(brief, rule).toContain(rule);
	// The closing statement tells the two sources of the document apart.
	expect(brief).toContain("哪些来自流量哪些来自源码");
	expect(brief).toContain("当前项目「商城项目」的工作目录里（容器内是 /work）");
	expect(buildModelingBrief(null, [])).toContain("工作目录里（容器内是 /work）");
	// The tools stay after the run, and the briefing says so.
	expect(brief).toContain("仍在工具表里");
	// Nothing is left of the time the two halves were two features.
	for (const stale of ["项目理解", "code_model", "增量建模", "带入"]) expect(brief).not.toContain(stale);
});

test("the instruction lists the records the project already has, so a new run builds on them", () => {
	const plain = buildModelingBrief("商城项目", []);
	expect(plain).toContain("本项目还没有业务建模记录。");
	const brief = buildModelingBrief("商城项目", [
		summary({ id: "api-1", title: "商城前台", status: "done", pathCount: 12, operationCount: 30, entityCount: 3 }),
		summary({
			id: "api-2",
			title: "商城后台",
			source: "shop-api/",
			apiCount: 40,
			stateMachineCount: 2,
			ruleCount: 8,
		}),
	]);
	expect(brief).toContain("本项目已有的业务建模记录：");
	expect(
		modelingRecordLine(
			summary({ id: "api-1", title: "商城前台", status: "done", pathCount: 12, operationCount: 30, entityCount: 3 }),
		),
	).toBe(
		"- 商城前台 [id: api-1]（完成）目标 https://shop.example.com：12 路径 / 30 操作 / 3 实体 / 0 源码映射 / 0 状态机 / 0 规则",
	);
	expect(modelingRecordLine(summary({ id: "api-2", title: "商城后台", source: "shop-api/", apiCount: 40 }))).toBe(
		"- 商城后台 [id: api-2]（建模中）目标 https://shop.example.com，源码 shop-api/：0 路径 / 0 操作 / 0 实体 / 40 源码映射 / 0 状态机 / 0 规则",
	);
	// A record with neither says so without a dangling separator.
	expect(modelingRecordLine(summary({ id: "api-3", title: "无范围", target: "" }))).toBe(
		"- 无范围 [id: api-3]（建模中）0 路径 / 0 操作 / 0 实体 / 0 源码映射 / 0 状态机 / 0 规则",
	);
	expect(brief).toContain("不要重做");
	expect(brief).toContain("本次只补缺的和变化的");
	// A long history is counted, not listed whole.
	const many = buildModelingBrief(
		"商城项目",
		Array.from({ length: 30 }, (_, index) => summary({ id: `api-${index}`, title: `记录 ${index}` })),
	);
	expect(many).toContain("另有 10 份未列出");
	expect(many).not.toContain("[id: api-29]");
});

test("the closing marker counts the parts the record has, and the snapshot state carries them", () => {
	// A record with only an interface document reads the way it always did.
	const document = record({
		pathCount: 4,
		operationCount: 9,
		entities: [{ name: "订单" }, { name: "用户" }, { name: "支付单" }],
	});
	const closed = buildModelingEndMessage({ status: "done", note: "覆盖订单" }, document);
	expect(closed.split("\n")).toEqual([
		"【业务建模 · 结束】业务建模已结束（完成）：已记录 4 个路径 / 9 个操作 / 3 个业务实体。",
		"覆盖订单",
		"会话回到普通状态：建模工具仍在工具表里，但没有要求时不要再调用。",
	]);
	const both = record({
		apis: [mapping(), mapping("POST", "/api/pay")] as SentinelApiSourceMapping[],
		logic: {
			entities: [],
			relations: [],
			stateMachines: [{ subject: "订单", states: [], transitions: [], locations: [at()] }],
			rules: [{ id: "r1", kind: "invariant", subject: "订单", statement: "金额不为负", locations: [at()] }],
			apiDependencies: [],
		},
	});
	expect(buildModelingEndMessage({ status: "manual" }, both)).toContain(
		"（操作员结束）：已记录 0 个路径 / 0 个操作 / 0 个业务实体 / 2 条源码映射 / 1 个状态机 / 1 条业务规则。",
	);
	expect(buildModelingEndMessage({ status: "failed" })).toContain("（失败）：已记录 0 个路径");
	expect(MODELING_MESSAGE_CUSTOM_TYPE).toBe("zg-modeling");

	expect(
		modelingState(
			{ runId: "api-1" },
			record({
				pathCount: 2,
				operationCount: 5,
				entities: [{ name: "订单" }],
				apis: [mapping()] as SentinelApiSourceMapping[],
			}),
		),
	).toEqual({
		runId: "api-1",
		title: "商城",
		target: "https://shop.example.com",
		source: "",
		startedAt: "2026-11-25T10:00:00.000Z",
		pathCount: 2,
		operationCount: 5,
		entityCount: 1,
		apiCount: 1,
		stateMachineCount: 0,
		ruleCount: 0,
	});
});

test("the read tool hands out the instruction, lists the project's records, and refuses what is not theirs", async () => {
	const { read } = harness();
	const call = async (params: Record<string, unknown>) =>
		toolOf(read, "api_model_read").execute("call", params as never);
	// A worker whose task says 做业务建模 starts here.
	const guide = await call({ part: "guide" });
	expect(guide.isError).toBeFalsy();
	expect(textOf(guide)).toContain("【业务建模】");
	expect(textOf(guide)).toContain("本项目还没有业务建模记录");
	expect(guide.details).toMatchObject({ ok: true, part: "guide" });

	const none = await call({});
	expect(none.isError).toBeFalsy();
	expect(textOf(none)).toBe("本项目还没有业务建模记录。");

	const stranger = await call({ id: "api-other" });
	expect(stranger.isError).toBe(true);
	expect(textOf(stranger)).toContain("不是本项目的一条业务建模记录");
	expect(stranger.details).toMatchObject({ ok: false, error: "unknown-id" });
});

test("the read tool reads one record part by part", async () => {
	const { read, store, session, records } = harness();
	// A record with both halves, written the way the two submit tools leave one.
	const opened = store.start(session.origin, {
		openapi: {
			...DOC({
				"/api/orders/{id}": {
					get: {
						summary: "查订单",
						parameters: [{ $ref: "#/components/parameters/Id" }],
						responses: { "200": { $ref: "#/components/responses/Order" } },
					},
					post: { summary: "改订单" },
				},
				"/api/users": { get: { summary: "用户列表", operationId: "listUsers" } },
			}),
			components: {
				parameters: { Id: { name: "id", in: "path", required: true } },
				responses: {
					Order: {
						description: "ok",
						content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } },
					},
				},
				schemas: { Order: { type: "object", properties: { id: { type: "string" } } } },
			},
		},
		target: "https://shop.example.com",
		entities: [
			{
				name: "订单",
				description: "下单产生的单据",
				fields: [{ name: "id", type: "string" }],
				relations: [{ target: "用户", kind: "N:1" }],
			},
		],
	});
	const stored = store.submitSource(
		(opened.model as SentinelApiModel).id,
		{
			apis: [
				mapping("GET", "/api/orders"),
				mapping("POST", "/api/pay", { module: "支付" }),
				mapping("DELETE", "/api/orders/{id}"),
			],
			entities: [{ name: "订单", locations: [at(9, "src/entity/Order.java")] }],
			rules: [
				{
					id: "r1",
					kind: "invariant",
					subject: "订单",
					statement: "金额不能为负",
					locations: [at(50, "src/OrderService.java")],
				},
				{
					id: "r2",
					kind: "ownership",
					subject: "订单",
					statement: "只能看自己的",
					locations: [at(51, "src/OrderService.java")],
				},
			],
			source: "shop-api/",
		},
		{ hostWorkDir: join(dir, "work") },
	);
	if (!stored.ok) throw new Error(stored.errors.join("\n"));
	const id = opened.model?.id ?? "";
	const call = async (params: Record<string, unknown>) =>
		toolOf(read, "api_model_read").execute("call", params as never);

	const list = await call({});
	expect(textOf(list)).toContain(`本项目的业务建模记录（${records().length} 份，新在前）：`);
	expect(textOf(list)).toContain(
		`- 商城 [id: ${id}]（建模中）目标 https://shop.example.com，源码 shop-api/：2 路径 / 3 操作 / 1 实体 / 3 源码映射 / 0 状态机 / 2 规则`,
	);

	// The default part is the overview: what exists, enough to know what to ask for.
	const overview = await call({ id });
	expect(textOf(overview)).toContain("商城（overview）：");
	expect(bodyOf(overview)).toMatchObject({
		part: "overview",
		target: "https://shop.example.com",
		source: "shop-api/",
		modules: ["订单", "支付"],
		entities: ["订单"],
		logicEntities: ["订单"],
		counts: { paths: 2, operations: 3, entities: 1, apiMappings: 3, logicEntities: 1, rules: 2 },
	});

	// The interface document is paged by path, narrowed by a search, and every
	// `$ref` comes back as what it points at.
	const users = await call({ id, part: "document", search: "listUsers" });
	expect(bodyOf(users)).toMatchObject({
		part: "document",
		total: 1,
		page: 1,
		pageSize: 20,
		items: [{ path: "/api/users" }],
	});
	const orders = await call({ id, part: "document", search: "orders" });
	expect(bodyOf(orders)).toEqual({
		id,
		title: "商城",
		part: "document",
		info: { title: "商城前台 API", version: "1.0.0" },
		page: 1,
		pageSize: 20,
		total: 1,
		items: [
			{
				path: "/api/orders/{id}",
				item: {
					get: {
						summary: "查订单",
						parameters: [{ name: "id", in: "path", required: true }],
						responses: {
							"200": {
								description: "ok",
								content: {
									"application/json": { schema: { type: "object", properties: { id: { type: "string" } } } },
								},
							},
						},
					},
					post: { summary: "改订单" },
				},
			},
		],
	});

	expect(bodyOf(await call({ id, part: "entities" }))).toMatchObject({
		part: "entities",
		total: 1,
		items: [{ name: "订单", relations: [{ target: "用户", kind: "N:1" }] }],
	});

	// Endpoints are narrowed and paged, and every location reads as file:line.
	const orderApis = await call({ id, part: "apis", module: "订单", pageSize: 1 });
	expect(bodyOf(orderApis)).toMatchObject({ total: 2, page: 1 });
	const page = bodyOf(orderApis).items as Array<Record<string, unknown>>;
	expect(page).toHaveLength(1);
	expect(page[0]).toMatchObject({
		method: "GET",
		path: "/api/orders",
		handler: { name: "getOrder", at: "/work/src/OrderController.java:42" },
	});

	const rules = await call({ id, part: "logic", section: "rules", pageSize: 1, page: 2 });
	const rulesBody = bodyOf(rules);
	expect(rulesBody).toMatchObject({ total: 2, section: "rules" });
	expect(rulesBody.items).toEqual([
		{
			id: "r2",
			kind: "ownership",
			subject: "订单",
			statement: "只能看自己的",
			at: ["/work/src/OrderService.java:51"],
		},
	]);
	expect(textOf(rules)).toContain("商城（logic / rules）");
	expect(rules.details).toMatchObject({ ok: true, id, part: "logic" });

	// What is refused, and why.
	const noSection = await call({ id, part: "logic" });
	expect(noSection.isError).toBe(true);
	expect(textOf(noSection)).toContain("part 为 logic 时要指定 section");
});

test("a part the record does not have is refused by name", async () => {
	const read = async (tools: ToolDefinition[], id: string, params: Record<string, unknown>) =>
		textOf(await toolOf(tools, "api_model_read").execute("call", { id, ...params } as never));

	// A record with only an interface document has none of the source half to read.
	const document = harness();
	const documentId = document.store.start(document.session.origin, { paths: { "/a": { get: {} } } }).model?.id ?? "";
	expect(await read(document.read, documentId, { part: "apis" })).toContain("没有接口源码映射");
	expect(await read(document.read, documentId, { part: "entities" })).toContain("这份记录没有业务实体");

	// One opened from the source has no interface document.
	const source = harness();
	const opened = source.store.startSource(
		source.session.origin,
		{ apis: [mapping()] },
		{ hostWorkDir: join(dir, "work") },
	);
	if (!opened.ok) throw new Error(opened.errors.join("\n"));
	expect(await read(source.read, opened.model.id, { part: "document" })).toContain("没有接口文档");
});

test("a page too large to be useful is cut and says how much went", async () => {
	const store = new ApiModelStore(join(dir, `modeling-big-${counter++}.db`));
	const note = "很长的备注".repeat(400);
	const opened = store.startSource(
		{ projectId: "p1", sessionId: "s1", sessionPath: null, title: "大项目" },
		{
			apis: Array.from({ length: 30 }, (_, index) => mapping("GET", `/api/resource${index}`)),
		},
		{ hostWorkDir: join(dir, "work") },
	);
	if (!opened.ok) throw new Error(opened.errors.join("\n"));
	const stored = store.submitSource(
		opened.model.id,
		{
			rules: Array.from({ length: 30 }, (_, index) => ({
				id: `r${index}`,
				kind: "invariant",
				subject: "订单",
				statement: note,
				locations: [at()],
			})),
		},
		{ hostWorkDir: join(dir, "work") },
	);
	if (!stored.ok) throw new Error(stored.errors.join("\n"));
	const read = toolOf(
		createApiModelReadTools({
			list: () => store.list({ projectId: "p1" }),
			read: (id) => store.get(id),
			guide: () => "",
		}),
		"api_model_read",
	);
	const result = await read.execute("call", {
		id: opened.model.id,
		part: "logic",
		section: "rules",
		pageSize: 30,
	} as never);
	const text = textOf(result).split("\n").slice(1).join("\n");
	expect(text.length).toBeLessThan(60_000);
	const body = JSON.parse(text) as { items: unknown[]; truncated: number; total: number };
	expect(body.items.length).toBeGreaterThan(0);
	expect(body.items.length).toBeLessThan(30);
	expect(body.truncated).toBe(30 - body.items.length);
	expect(body.total).toBe(30);
});

test("the exports the contract documents are what the console produces for the record it documents", () => {
	// The contract's example is pasted into its document; this keeps the two honest about each other.
	const { model, events } = modeling_contract.server.api_model;
	// The example is a record the console could have written: the list row and the
	// audit trail count what the record holds.
	const { openapi: _openapi, entities, apis, logic, ...rest } = model;
	const counts = {
		entityCount: entities.length,
		apiCount: apis.length,
		stateMachineCount: logic.stateMachines.length,
		ruleCount: logic.rules.length,
	};
	expect(modeling_contract.server.api_models.items.find((item) => item.id === model.id)).toEqual({
		...rest,
		...counts,
	});
	const last = events[events.length - 1];
	expect([
		last?.pathCount,
		last?.operationCount,
		last?.entityCount,
		last?.apiCount,
		last?.stateMachineCount,
		last?.ruleCount,
	]).toEqual([
		model.pathCount,
		model.operationCount,
		counts.entityCount,
		counts.apiCount,
		counts.stateMachineCount,
		counts.ruleCount,
	]);

	const documented = modeling_contract.server.api_model_export;
	if (documented.format !== "markdown")
		throw new Error("the documented export is no longer the whole record as Markdown");
	expect(buildApiModelExport(model, "markdown")).toEqual({ filename: documented.filename, text: documented.text });
	// The interface document as OpenAPI, under a name that tells it from the whole record.
	expect(buildApiModelExport(model, "json")).toEqual({
		filename: `商城-${model.id.slice(4, 12)}.json`,
		text: `${JSON.stringify(model.openapi, null, 2)}\n`,
	});
	// The whole record as JSON carries both halves under the names the record keeps them.
	expect(JSON.parse(buildApiModelExport(model, "record").text)).toMatchObject({
		id: model.id,
		title: model.title,
		target: model.target,
		source: model.source,
		openapi: model.openapi,
		entities,
		apis,
		logic,
	});
});
