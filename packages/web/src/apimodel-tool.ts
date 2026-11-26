/**
 * The four tools business modeling works through.
 *
 * They are declared to the model in every conversation and in every engineering
 * task's worker: modeling can be asked for in the conversation instead of
 * pressed, and a worker gets it as its task. A tool that only a button can mount
 * cannot be reached either way. The discipline therefore lives in the tools
 * themselves — the three that write open by saying they may only be called when
 * the operator or the task asked for business modeling — and the first accepted
 * submission opens the record. `api_model_done` still refuses without an open
 * record, so a stale activation cannot close a record that is already finished.
 *
 * The read tool is the one every agent has, the commander and the sub-agents
 * included. It reads the records of the session's project and nothing else, so
 * handing it out gives no way to write. It also carries the instruction itself
 * (`part: "guide"`): a worker whose task says 做业务建模 starts there, which is
 * what lets the commander dispatch modeling without copying the briefing.
 *
 * Both submit tools are deliberately usable many times. A real site has hundreds
 * of endpoints and a real project hundreds more in its source, and none of that
 * fits in one model answer. Each takes a slice, merges slices into the record by
 * key, and reports the validation problems of the merged result so the model
 * fixes the record rather than guessing why it was refused.
 */

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ApiModelSubmitInput, apiModelOverview, pagePathItems } from "./apimodels.ts";
import { modelingRecordLine } from "./modeling.ts";
import type {
	SentinelApiModel,
	SentinelApiModelSummary,
	SentinelBusinessLogicModel,
	SentinelCodeLocation,
} from "./protocol.ts";
import {
	formatCodeLocation,
	pageApiMappings,
	pageOf,
	type SourceModelCounts,
	type SourceModelSubmitInput,
} from "./sourcemodels.ts";

/** Outcome of one interface-document submission, as the runtime reports it back to the tool. */
export type ModelingSubmitOutcome =
	| { ok: true; pathCount: number; operationCount: number; entityCount: number; warnings: string[] }
	| { ok: false; errors: string[] };

/** Outcome of one source submission. */
export type SourceSubmitOutcome =
	| { ok: true; counts: SourceModelCounts; warnings: string[] }
	| { ok: false; errors: string[] };

/** What the runtime has to provide for the tools to work on the record of the calling session. */
export interface ModelingPort {
	/** The record open in the calling session, if any. */
	current(): { runId: string } | undefined;
	/** Store one submission, opening the record when the session has none. */
	submit(input: ApiModelSubmitInput): ModelingSubmitOutcome;
	/** Store one source submission, opening the record when the session has none. */
	submitSource(input: SourceModelSubmitInput): SourceSubmitOutcome;
	/** The agent's own declaration that the record is complete. */
	done(summary: string): void;
}

/** What the runtime provides for the read-only tool. */
export interface ModelingReadPort {
	/** The records of the session's project, newest first. */
	list(): readonly SentinelApiModelSummary[];
	/** One record of that project in full, or undefined when it is not there. */
	read(id: string): SentinelApiModel | undefined;
	/** The instruction the button sends: what to produce, with which tools, and how. */
	guide(): string;
}

const fieldSchema = Type.Object({
	name: Type.String({ description: "字段名，例如 id / status / created_at" }),
	type: Type.Optional(Type.String({ description: "字段类型，例如 string / integer / array<Order>" })),
	description: Type.Optional(Type.String({ description: "这个字段在业务上是什么" })),
});

const relationSchema = Type.Object({
	target: Type.String({ description: "关联到的实体名，必须与另一个实体的 name 一致" }),
	kind: Type.Optional(Type.String({ description: "关系类型，例如 1:N / 属于 / 包含" })),
	description: Type.Optional(Type.String()),
});

const entitySchema = Type.Object({
	name: Type.String({ description: "业务实体名，例如 用户 / 订单 / 支付单" }),
	description: Type.Optional(Type.String({ description: "这个实体在业务里代表什么" })),
	fields: Type.Optional(Type.Array(fieldSchema, { description: "实体的字段，从接口证据归纳" })),
	relations: Type.Optional(Type.Array(relationSchema, { description: "与其他实体的关系" })),
});

const documentSchema = Type.Record(Type.String(), Type.Unknown(), {
	description: 'OpenAPI 3.x 文档对象，例如 { openapi: "3.0.3", info: {...}, paths: {...} }',
});

const submitSchema = Type.Object({
	openapi: Type.Optional(documentSchema),
	paths: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: '按路径分片提交，例如 { "/api/users": { get: {...}, post: {...} } }；与已有草稿按路径合并',
		}),
	),
	components: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "按段分片提交，例如 { schemas: { User: {...} } }；与已有草稿按段内名称合并",
		}),
	),
	entities: Type.Optional(Type.Array(entitySchema, { description: "业务实体与关系；给了就整份替换已存的实体列表" })),
	target: Type.Optional(
		Type.String({ description: "这次还原接口的流量来自哪里：站点根地址或主机，例如 https://example.com" }),
	),
	title: Type.Optional(Type.String({ description: "这次建模的名字，例如「商城前台 API」；不填则沿用记录里的名字" })),
	note: Type.Optional(Type.String({ description: "本次提交补了什么，写进审计时间线" })),
});

const locationSchema = Type.Object({
	file: Type.String({
		description:
			"文件路径：相对项目工作目录，或以 /work/ 开头，例如 src/main/java/com/acme/order/OrderController.java",
	}),
	line: Type.Integer({ minimum: 1, description: "起始行号，从 1 开始，必须是读过的那一行" }),
	endLine: Type.Optional(Type.Integer({ minimum: 1, description: "结束行号，可省略" })),
});

const apiMappingSchema = Type.Object({
	method: Type.String({
		description:
			"HTTP 方法，大写：GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS / TRACE；一个处理函数承接所有方法时写 ANY",
	}),
	path: Type.String({ description: "源码里声明的路由，以 / 开头并保留占位符，例如 /api/orders/{id}" }),
	module: Type.Optional(Type.String({ description: "所属业务模块，例如 订单 / 支付 / 用户" })),
	summary: Type.Optional(Type.String({ description: "这个接口做什么，一句话" })),
	handler: Type.Object({
		name: Type.String({ description: "入口函数：Controller 的方法、handler 函数、视图函数" }),
		location: locationSchema,
	}),
	callChain: Type.Array(
		Type.Object({
			layer: Type.Union(
				[
					Type.Literal("service"),
					Type.Literal("repository"),
					Type.Literal("util"),
					Type.Literal("middleware"),
					Type.Literal("other"),
				],
				{ description: "这一层是什么" },
			),
			name: Type.String({ description: "函数或方法名" }),
			location: locationSchema,
			note: Type.Optional(Type.String({ description: "它做了什么，一句" })),
		}),
		{ description: "从 handler 往里的调用顺序；没有更深调用时给空数组" },
	),
	dataAccess: Type.Array(
		Type.Object({
			operation: Type.Union([Type.Literal("read"), Type.Literal("write")], { description: "读还是写" }),
			table: Type.String({ description: "表名，例如 t_order" }),
			columns: Type.Optional(Type.Array(Type.String(), { description: "涉及的列" })),
			via: Type.Optional(Type.String({ description: "经过哪个 mapper 或函数，调用链里看不出来时写" })),
			location: locationSchema,
		}),
		{ description: "这条调用链读写的表和字段；不碰数据库时给空数组" },
	),
	authChecks: Type.Array(
		Type.Object({
			kind: Type.Union(
				[
					Type.Literal("authentication"),
					Type.Literal("authorization"),
					Type.Literal("ownership"),
					Type.Literal("other"),
				],
				{ description: "登录校验 / 权限校验 / 资源归属校验 / 其他" },
			),
			note: Type.Optional(Type.String({ description: "校验了什么，例如 只允许 admin 角色" })),
			location: locationSchema,
		}),
		{
			description:
				"调用链上校验调用者的位置：注解、中间件、拦截器、切面、过滤器、守卫、策略，以及手写的判断。整条链上都没找到时给空数组，并在 notes 里写明",
		},
	),
	externalCalls: Type.Array(
		Type.Object({
			kind: Type.Union(
				[
					Type.Literal("http"),
					Type.Literal("rpc"),
					Type.Literal("mq"),
					Type.Literal("cache"),
					Type.Literal("file"),
					Type.Literal("other"),
				],
				{ description: "调用的种类" },
			),
			target: Type.String({ description: "调到了哪里：服务名、接口路径、主题名、桶名" }),
			note: Type.Optional(Type.String()),
			location: locationSchema,
		}),
		{ description: "外部服务调用；没有时给空数组" },
	),
	confidence: Type.Optional(
		Type.Union([Type.Literal("verified"), Type.Literal("inferred")], {
			description: "verified：逐行读过；inferred：有一部分是从局部读到的内容推断的",
		}),
	),
	notes: Type.Optional(Type.String({ description: "备注：没找到的校验、没读到的分支、存疑的地方" })),
});

const logicSchemas = {
	entities: Type.Array(
		Type.Object({
			name: Type.String({ description: "实体名，例如 订单 / 用户 / 支付单" }),
			description: Type.Optional(Type.String({ description: "它代表什么" })),
			table: Type.Optional(Type.String({ description: "对应的表或文档集合" })),
			owner: Type.Optional(Type.String({ description: "资源归属：记录属于谁，例如 用户 / 组织 / 系统" })),
			fields: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "字段名" }),
						meaning: Type.Optional(
							Type.String({ description: "业务含义，尤其是状态、金额、归属方、权限相关的字段" }),
						),
					}),
				),
			),
			locations: Type.Array(locationSchema, { description: "定义它的位置：实体类、模型、建表语句，至少一个" }),
		}),
		{ description: "业务实体；按 name 覆盖已提交的同名实体" },
	),
	relations: Type.Array(
		Type.Object({
			from: Type.String({ description: "关系起点的实体名" }),
			to: Type.String({ description: "关系终点的实体名" }),
			kind: Type.String({ description: "关系类型：1:1 / 1:N / N:M，或代码里的叫法" }),
			description: Type.Optional(Type.String()),
			locations: Type.Array(locationSchema, { description: "外键、关联查询或关联字段所在的位置，至少一个" }),
		}),
		{ description: "实体之间的关系；按「起点 + 终点 + 类型」覆盖" },
	),
	stateMachines: Type.Array(
		Type.Object({
			subject: Type.String({ description: "有这些状态的对象，例如 订单 / 提现申请" }),
			field: Type.Optional(Type.String({ description: "保存状态的字段或枚举" })),
			description: Type.Optional(Type.String()),
			states: Type.Array(
				Type.Object({
					name: Type.String({ description: "状态名，照代码里的写法" }),
					meaning: Type.Optional(Type.String({ description: "业务含义" })),
				}),
				{ description: "全部状态，至少一个" },
			),
			transitions: Type.Array(
				Type.Object({
					from: Type.String({ description: "迁移前的状态" }),
					to: Type.String({ description: "迁移后的状态" }),
					trigger: Type.Optional(
						Type.String({
							description: "引起迁移的入口，通常是接口，写成 方法 + 路径，例如 POST /api/orders/{id}/pay",
						}),
					),
					guard: Type.Optional(Type.String({ description: "前置条件：迁移前必须满足什么" })),
					effect: Type.Optional(Type.String({ description: "后置结果：除了状态本身还写了什么" })),
					locations: Type.Array(locationSchema, { description: "改状态的那几行，至少一个" }),
				}),
				{ description: "状态迁移；没找到时给空数组" },
			),
			initial: Type.Optional(Type.String({ description: "新记录的初始状态" })),
			locations: Type.Array(locationSchema, { description: "状态枚举或状态定义所在的位置，至少一个" }),
		}),
		{ description: "状态机；按 subject 覆盖" },
	),
	rules: Type.Array(
		Type.Object({
			id: Type.String({
				description: "这条规则的固定标识，例如 order.pay.precondition；改写同一条规则时沿用同一个 id",
			}),
			kind: Type.Union(
				[
					Type.Literal("precondition"),
					Type.Literal("postcondition"),
					Type.Literal("invariant"),
					Type.Literal("ownership"),
				],
				{ description: "前置条件 / 后置条件 / 业务不变量 / 资源所有权" },
			),
			subject: Type.String({ description: "规则约束的对象：实体、接口或操作" }),
			statement: Type.String({ description: "规则原文：代码要求或保证了什么" }),
			apis: Type.Optional(Type.Array(Type.String(), { description: "涉及它的接口，写成 方法 + 路径" })),
			note: Type.Optional(Type.String()),
			locations: Type.Array(locationSchema, { description: "体现这条规则的代码位置，至少一个" }),
		}),
		{ description: "业务规则；按 id 覆盖" },
	),
	apiDependencies: Type.Array(
		Type.Object({
			from: Type.String({ description: "发起依赖的接口，写成 方法 + 路径" }),
			to: Type.String({ description: "被依赖的接口" }),
			kind: Type.Union(
				[
					Type.Literal("calls"),
					Type.Literal("requires"),
					Type.Literal("triggers"),
					Type.Literal("mutates"),
					Type.Literal("other"),
				],
				{ description: "调用 / 必须先发生 / 触发 / 改动对方的数据 / 其他" },
			),
			description: Type.Optional(Type.String({ description: "依赖的是什么，例如 必须先创建订单才能支付" })),
			locations: Type.Array(locationSchema, { description: "体现依赖的代码位置，至少一个" }),
		}),
		{ description: "跨接口的业务依赖；按「起点 + 终点 + 类型」覆盖" },
	),
};

const sourceSubmitSchema = Type.Object({
	apis: Type.Optional(
		Type.Array(apiMappingSchema, { description: "API 源码映射；按「方法 + 路径」覆盖已提交的同一条接口" }),
	),
	// Every table is optional on purpose: one batch may carry the endpoints of a
	// single module, or one table of the logic model. The SDK checks a call's
	// arguments against this schema before the tool runs, so a list marked
	// required here refuses every partial batch before it is stored.
	entities: Type.Optional(logicSchemas.entities),
	relations: Type.Optional(logicSchemas.relations),
	stateMachines: Type.Optional(logicSchemas.stateMachines),
	rules: Type.Optional(logicSchemas.rules),
	apiDependencies: Type.Optional(logicSchemas.apiDependencies),
	source: Type.Optional(Type.String({ description: "读的是哪部分源码：仓库或目录，例如 shop-api/" })),
	title: Type.Optional(Type.String({ description: "这次建模的名字，例如「商城后台」；不填则沿用记录里的名字" })),
	note: Type.Optional(Type.String({ description: "本次提交补了什么，写进审计时间线" })),
});

const doneSchema = Type.Object({
	summary: Type.String({
		description: "建模结论：两部分各覆盖了哪些模块、哪些没覆盖、哪些内容只是推测",
	}),
});

const LOGIC_SECTIONS = ["entities", "relations", "stateMachines", "rules", "apiDependencies"] as const;
type LogicSection = (typeof LOGIC_SECTIONS)[number];

/** The most one read returns; a page that would exceed it is cut and says so. */
const MAX_READ_CHARS = 60_000;
const MAX_PAGE_SIZE = 30;
const DEFAULT_PAGE_SIZE = 20;

/** Result details shared by the tools, so the transcript can show them uniformly. */
interface ModelingToolDetails {
	ok: boolean;
	runId?: string;
	id?: string;
	part?: string;
	pathCount?: number;
	operationCount?: number;
	entityCount?: number;
	error?: string;
}

function failure(text: string, error: string): AgentToolResult<ModelingToolDetails> {
	return { content: [{ type: "text", text }], details: { ok: false, error }, isError: true };
}

/** A page of a record as the model reads it: every location becomes `file:line`. */
function compact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(compact);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (key === "location" && typeof item === "object" && item !== null)
				out.at = formatCodeLocation(item as SentinelCodeLocation);
			else if (key === "locations" && Array.isArray(item))
				out.at = item.map((location) => formatCodeLocation(location as SentinelCodeLocation));
			else out[key] = compact(item);
		}
		return out;
	}
	return value;
}

/** The page as text, within the read limit; one too large to be useful is cut from the end and says how much went. */
function bounded(body: Record<string, unknown>): string {
	const serialize = (value: Record<string, unknown>): string =>
		JSON.stringify(compact(value)).replace(/</g, "\\u003c");
	const text = serialize(body);
	if (text.length <= MAX_READ_CHARS) return text;
	const items = (body.items as unknown[] | undefined) ?? [];
	let kept = items.length;
	while (kept > 0 && serialize({ ...body, items: items.slice(0, kept) }).length > MAX_READ_CHARS) kept--;
	return serialize({ ...body, items: items.slice(0, kept), truncated: items.length - kept });
}

export function createApiModelTools(port: ModelingPort): ToolDefinition[] {
	/** `api_model_done` starts here: without an open record there is nothing to close. */
	const requireOpen = (): { runId: string } | { error: string } => {
		const run = port.current();
		if (!run) {
			return {
				error: "当前会话没有进行中的业务建模。先调用 api_model_submit 或 source_model_submit 开始一次，或由操作员在输入框上方点「业务建模」。",
			};
		}
		return { runId: run.runId };
	};

	const submit = defineTool({
		name: "api_model_submit",
		label: "Submit API model",
		// Declared everywhere: modeling can be asked for in the conversation or be
		// a worker's task, and the guard against doing it unasked is the wording of
		// the description and the guidelines below, not the tool's absence.
		defaultActive: true,
		description:
			"Only call this when the operator or the task asked for business modeling — if business modeling is not asked for, do not call this tool. Stores the interface half of a modeling record: the OpenAPI 3.x document of the target's business interfaces, or one slice of it, and the business entities behind it. The interfaces have two sources. Where there is traffic, restore them from it. When reading the project's source, write the interfaces the source declares — route, method, parameters, request body, response structure — and start each one's description with 来自源码. Call it repeatedly: send a whole document with `openapi`, or send `paths` / `components` slices that merge into the record by key — that is how a site with hundreds of endpoints is delivered without one oversized answer. `entities` records the business entities and their relations. The merged document is validated server-side (3.x, info.title, info.version, paths); when the call is refused nothing is stored and the answer lists exactly what to fix. A session with no record open gets one from the first accepted call, so that call has to carry content. `title` names the record; `target` says which traffic it was restored from.",
		promptSnippet: "Submit (or extend) the interface document and business entities of a modeling record",
		promptGuidelines: [
			"Call this only when the operator or the task asked for business modeling (in the conversation, by pressing 业务建模, or in the task instruction); if business modeling is not asked for, do not call this tool",
			"Send the skeleton together with the first batch of endpoints — `components` for the shared schemas and `paths` for the first module in one call — then add the rest in batches with the `paths` slice",
			"Take endpoints and fields from the target's traffic where there is any, and from what the source declares when reading the source; an interface taken from the source says 来自源码 at the start of its description",
			"Mark anything inferred in its description instead of dropping the caveat",
			"Do not invent endpoints, parameters or response fields to fill the document out — a smaller verified document is the deliverable",
			"Do not copy real credentials (Cookie, Token, passwords) into the document; use placeholder example values",
			"Re-submitting is the normal way to fix a refusal: read the listed reasons and send the corrected slice",
		],
		parameters: submitSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<ModelingToolDetails>> {
			const outcome = port.submit(params);
			if (!outcome.ok) {
				return failure(
					`提交被拒绝，文档未入库：\n- ${outcome.errors.join("\n- ")}\n请按上述原因修改后重新提交。`,
					"invalid-document",
				);
			}
			const notes: string[] = [];
			if (outcome.warnings.length > 0) notes.push(`提醒：${outcome.warnings.join("；")}`);
			if (outcome.operationCount === 0) {
				notes.push(
					"文档里还没有任何接口：有流量就从流量里确认端点，读源码就按源码里声明的路由，用 paths 分批提交。",
				);
			}
			const tail = notes.length > 0 ? `\n\n${notes.join("\n")}` : "";
			return {
				content: [
					{
						type: "text",
						text: `已入库：路径 ${outcome.pathCount} 个，操作 ${outcome.operationCount} 个，业务实体 ${outcome.entityCount} 个。${tail}`,
					},
				],
				details: {
					ok: true,
					runId: port.current()?.runId,
					pathCount: outcome.pathCount,
					operationCount: outcome.operationCount,
					entityCount: outcome.entityCount,
				},
			};
		},
	});

	const sourceSubmit = defineTool({
		name: "source_model_submit",
		label: "Submit source model",
		defaultActive: true,
		description:
			"Only call this when the operator or the task asked for business modeling — if business modeling is not asked for, do not call this tool. Stores the source half of a modeling record: what you read in the project's source. `apis` is the source mapping of each endpoint: its handler, the call chain behind it, the tables and columns it touches, where the caller is checked, and the calls it makes to other services. The other five lists are the business logic model: `entities`, `relations`, `stateMachines`, `rules` (preconditions, postconditions, invariants, ownership) and `apiDependencies`. Call it repeatedly, in batches: an endpoint replaces the one with the same method and path, and each list merges by its own key, so a large project is delivered without one oversized answer. Every claim carries a location (file and line) as it is in the source. The submission is validated; when it is refused nothing is stored and the answer lists exactly what to fix. A session with no record open gets one from the first accepted call, so that call has to carry content. `title` names the record; `source` says which part of the source was read.",
		promptSnippet: "Submit (or extend) the endpoint mappings and the business logic model of a modeling record",
		promptGuidelines: [
			"Call this only when the operator or the task asked for business modeling (in the conversation, by pressing 业务建模, or in the task instruction); if business modeling is not asked for, do not call this tool",
			"Read the code before you write a location: every file and line is a place you actually saw, never a guess",
			"Map one module at a time and submit its endpoints in batches of at most 20; sending an endpoint again replaces its mapping",
			"Report what you did not find: an endpoint with no check on its path has an empty `authChecks` and a note saying so — that is a finding, not an omission",
			"Mark what you concluded from reading part of the code as `inferred`; do not invent call chain steps, tables or rules to make the model look complete",
			"Do not copy credentials (keys, tokens, passwords) out of the source into the model",
			"Re-submitting is the normal way to fix a refusal: read the listed reasons and send the corrected items",
		],
		parameters: sourceSubmitSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<ModelingToolDetails>> {
			const outcome = port.submitSource(params);
			if (!outcome.ok) {
				return failure(
					`提交被拒绝，未入库：\n- ${outcome.errors.join("\n- ")}\n请按上述原因修改后重新提交。`,
					"invalid-model",
				);
			}
			const counts = outcome.counts;
			const notes: string[] = [];
			if (counts.apiCount === 0) notes.push("还没有接口映射：逐模块读入口和调用链，用 apis 分批提交。");
			if (outcome.warnings.length > 0) notes.push(`提醒：${outcome.warnings.join("；")}`);
			const tail = notes.length > 0 ? `\n\n${notes.join("\n")}` : "";
			return {
				content: [
					{
						type: "text",
						text: `已入库：接口映射 ${counts.apiCount} 条，业务实体 ${counts.entityCount} 个，状态机 ${counts.stateMachineCount} 个，业务规则 ${counts.ruleCount} 条。${tail}`,
					},
				],
				details: { ok: true, runId: port.current()?.runId },
			};
		},
	});

	const done = defineTool({
		name: "api_model_done",
		label: "Finish business modeling",
		defaultActive: true,
		description:
			"Only call this when the operator or the task asked for business modeling — if business modeling is not asked for, do not call this tool. Declares the modeling record complete and ends the run. Whatever the run set out to store must already be submitted. State the coverage: for each part, which modules were mapped or read, which were not, and what is only inferred.",
		promptSnippet: "Declare the business-modeling run complete, with its coverage",
		promptGuidelines: [
			"Call this only when the operator or the task asked for business modeling, and only to close a run you actually started or continued; if business modeling is not asked for, do not call this tool",
			"Call api_model_submit or source_model_submit with the last batch before api_model_done; a run that ends without a submission has produced nothing",
			"State the coverage honestly in the summary: for each part, modules covered, modules left out, and what remains inferred",
		],
		parameters: doneSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<ModelingToolDetails>> {
			const active = requireOpen();
			if ("error" in active) return failure(active.error, "no-modeling-run");
			const summary = params.summary.trim();
			if (!summary) return failure("建模结论不能为空：写清覆盖范围。", "no-summary");
			port.done(summary);
			return {
				content: [
					{
						type: "text",
						text: `业务建模已结束，记录已归档，可以继续原来的工作。\n结论：${summary}`,
					},
				],
				details: { ok: true, runId: active.runId },
			};
		},
	});

	return [submit, sourceSubmit, done];
}

/**
 * The read tool. It has no way to write, which is what lets every agent have
 * it: a conversation, a worker, a sub-agent and the commander alike.
 */
export function createApiModelReadTools(port: ModelingReadPort): ToolDefinition[] {
	const read = defineTool({
		name: "api_model_read",
		label: "Read business model",
		defaultActive: true,
		description:
			"Read the business-modeling records of this project: the interface document (restored from the target's traffic or taken from what the source declares — each interface says which in its description) with its business entities, and what was read out of the project's source (the mapping of each endpoint and the business logic model). Call with `part: \"guide\"` to get the instruction for doing business modeling — start there when the task says 做业务建模. Call without `id` to list the records. With `id`, read one part at a time: `overview` for the shape of the record, `document` for its interface document (page by path, narrow with `search`; `$ref`s are resolved), `entities` for the business entities, `apis` for the mapping of endpoints (narrow with `module` or `search`), `logic` for one of its lists (`section`). Pages come back with their `total`. Locations are written `file:line`. Read this before judging the authorization or the business logic of an endpoint: the call chain, the places that check the caller, the state machines and the rules are all in there.",
		promptSnippet: "Read the project's business-modeling records, or the instruction for doing business modeling",
		promptGuidelines: [
			'A task that says 做业务建模 starts with `part: "guide"`: it says what to produce, with which tools, and how',
			"Before work that touches this project's interfaces or business logic, and before modeling anything again, list the records and read what they cover",
			"List first (no id), then `overview`, then only the parts you need: `document`, `apis` and `logic` are paged",
			"Before judging the authorization or the business logic of an endpoint, read its mapping: where the caller is checked is in `authChecks`, and what the operation must obey is in `rules` and `stateMachines`",
		],
		parameters: Type.Object({
			id: Type.Optional(
				Type.String({ description: "要读取的记录 id；不传则列出本项目的记录（part 为 guide 时不需要）" }),
			),
			part: Type.Optional(
				Type.Union(
					[
						Type.Literal("guide"),
						Type.Literal("overview"),
						Type.Literal("document"),
						Type.Literal("entities"),
						Type.Literal("apis"),
						Type.Literal("logic"),
					],
					{
						description:
							"读哪一部分：guide 操作指引（不需要 id）；overview 概览（默认）；document 接口文档，按路径分页；entities 接口文档的业务实体；apis 接口的源码映射，分页；logic 业务逻辑模型的某一张表，分页",
					},
				),
			),
			module: Type.Optional(Type.String({ description: "part 为 apis 时，只要这个模块的接口" })),
			section: Type.Optional(
				Type.Union(
					[
						Type.Literal("entities"),
						Type.Literal("relations"),
						Type.Literal("stateMachines"),
						Type.Literal("rules"),
						Type.Literal("apiDependencies"),
					],
					{
						description:
							"part 为 logic 时读哪张表：entities / relations / stateMachines / rules / apiDependencies",
					},
				),
			),
			search: Type.Optional(
				Type.String({ description: "关键字，不区分大小写：路径、说明、函数名、表名、实体名、规则内容" }),
			),
			page: Type.Optional(Type.Integer({ minimum: 1, description: "页码，从 1 开始" })),
			pageSize: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, description: `每页条数，默认 ${DEFAULT_PAGE_SIZE}` }),
			),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<ModelingToolDetails>> {
			if (params.part === "guide") {
				return { content: [{ type: "text", text: port.guide() }], details: { ok: true, part: "guide" } };
			}
			if (!params.id) {
				const records = [...port.list()];
				const text =
					records.length === 0
						? "本项目还没有业务建模记录。"
						: `本项目的业务建模记录（${records.length} 份，新在前）：\n${records.map(modelingRecordLine).join("\n")}\n传 id 读取：part=overview 看概览，document / entities / apis / logic 分部分读。`;
				return { content: [{ type: "text", text }], details: { ok: true } };
			}
			const record = port.read(params.id);
			if (!record) {
				return failure(`id ${params.id} 不是本项目的一条业务建模记录（不存在，或已被删除）。`, "unknown-id");
			}
			const part = params.part ?? "overview";
			if (part === "logic" && !params.section) {
				return failure(
					"part 为 logic 时要指定 section：entities / relations / stateMachines / rules / apiDependencies。",
					"no-section",
				);
			}
			const page = params.page ?? 1;
			const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
			const head = { id: record.id, title: record.title, part };
			if (part === "document" && record.pathCount === 0) {
				return failure("这份记录没有接口文档：它的「从流量还原接口」部分没有做。", "empty-part");
			}
			if (part === "entities" && record.entities.length === 0) {
				return failure("这份记录没有业务实体。", "empty-part");
			}
			if (part === "apis" && record.apis.length === 0) {
				return failure("这份记录没有接口源码映射：它的「读源码」部分没有做。", "empty-part");
			}
			const body: Record<string, unknown> =
				part === "overview"
					? { ...head, ...apiModelOverview(record) }
					: part === "document"
						? {
								...head,
								info: record.openapi.info,
								page,
								pageSize,
								...pagePathItems(record.openapi, { search: params.search, page, pageSize }),
							}
						: part === "entities"
							? { ...head, total: record.entities.length, items: record.entities }
							: part === "apis"
								? {
										...head,
										page,
										pageSize,
										...pageApiMappings(record.apis, {
											module: params.module,
											search: params.search,
											page,
											pageSize,
										}),
									}
								: {
										...head,
										section: params.section,
										page,
										pageSize,
										...pageOfLogic(
											record.logic,
											params.section as LogicSection,
											params.search,
											page,
											pageSize,
										),
									};
			const label = part === "logic" ? `${part} / ${params.section}` : part;
			return {
				content: [{ type: "text", text: `${record.title}（${label}）：\n${bounded(body)}` }],
				details: { ok: true, id: record.id, part },
			};
		},
	});
	return [read];
}

function pageOfLogic(
	logic: SentinelBusinessLogicModel,
	section: LogicSection,
	search: string | undefined,
	page: number,
	pageSize: number,
) {
	return pageOf(logic[section] as unknown[], { search, page, pageSize }) as { total: number; items: unknown[] };
}
