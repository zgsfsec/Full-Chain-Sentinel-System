import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

/** The project the finished run and the failed run belong to. */
const shopProjectId = "6c2f9a14-3b7e-4d51-9f08-2a5e7c1d0b43";
/** A run the agent declared complete: two paths, three operations, two entities. */
const finishedId = "api-3f2a1b9c-4d5e-4f6a-9b7c-1d2e3f4a5b6c";
/** A run that is still in progress. */
const runningId = "api-9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

/** One valid example of each browser-to-server message described in modeling.md. */
export const client = {
	start_modeling: { type: "start_modeling" },
	end_modeling: { type: "end_modeling" },
	detach_modeling: { type: "detach_modeling" },
	list_api_models: { type: "list_api_models", filters: { projectId: shopProjectId, status: "done", search: "商城" } },
	get_api_model: { type: "get_api_model", id: finishedId },
	end_api_model: { type: "end_api_model", id: runningId },
	delete_api_model: { type: "delete_api_model", id: "api-5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d" },
	export_api_model: { type: "export_api_model", id: finishedId, format: "json" },
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

/** The OpenAPI document of the finished run, as the agent submitted it. */
const openapi = {
	openapi: "3.0.3",
	info: { title: "商城前台 API", version: "1.0.0" },
	paths: {
		"/api/users": {
			get: { summary: "用户列表", responses: { "200": { description: "OK" } } },
			post: { summary: "创建用户", responses: { "201": { description: "Created" } } },
		},
		"/api/orders/{orderId}": {
			get: {
				summary: "订单详情",
				parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "integer" } }],
				responses: { "200": { description: "OK" } },
			},
		},
	},
	components: {
		schemas: {
			User: {
				type: "object",
				required: ["id"],
				properties: { id: { type: "integer" }, nickname: { type: "string" } },
			},
		},
	},
};

/** The business entities the agent inferred from the endpoints. */
const entities = [
	{
		name: "用户",
		description: "商城的注册账号",
		fields: [
			{ name: "id", type: "integer", description: "用户 ID" },
			{ name: "nickname", type: "string", description: "昵称" },
		],
		relations: [{ target: "订单", kind: "1:N", description: "用户拥有的订单" }],
	},
	{
		name: "订单",
		fields: [
			{ name: "orderId", type: "integer", description: "订单 ID" },
			{ name: "status", type: "string", description: "待支付 / 已支付 / 已取消" },
		],
	},
];

/** One valid example of each server-to-browser message described in modeling.md. */
export const server = {
	api_models: {
		type: "api_models",
		items: [
			{
				id: runningId,
				projectId: "e07a5c93-1d4f-4b8a-9c2e-6f3d5b7a1c80",
				sessionId: "c41e7b20-8f6d-4a2c-b3e9-0d5f8a1c6e24",
				sessionPath:
					"/home/operator/.sentinel/agent/sessions/--home-operator-.sentinel-projects-checkout--/2026-11-24T09-40-58-077Z_c41e7b20-8f6d-4a2c-b3e9-0d5f8a1c6e24.jsonl",
				title: "结算流程梳理",
				target: "",
				status: "modeling",
				pathCount: 0,
				operationCount: 0,
				submissions: 0,
				createdAt: "2026-11-24T09:41:02.220Z",
				updatedAt: "2026-11-24T09:41:02.220Z",
				doneAt: null,
				entityCount: 0,
			},
			{
				id: "api-7e1d4c0b-9a8f-4b7e-8c6d-5f4e3d2c1b0a",
				projectId: shopProjectId,
				sessionId: "d8a2c5f1-3e4b-4c6d-9f7a-0b1c2d3e4f58",
				sessionPath:
					"/home/operator/.sentinel/agent/sessions/--home-operator-.sentinel-projects-shop--/2026-11-22T14-05-31-640Z_d8a2c5f1-3e4b-4c6d-9f7a-0b1c2d3e4f58.jsonl",
				title: "业务建模",
				target: "",
				status: "failed",
				pathCount: 0,
				operationCount: 0,
				submissions: 0,
				error: "建模指令注入失败：模型请求失败（HTTP 401）",
				createdAt: "2026-11-22T14:05:36.093Z",
				updatedAt: "2026-11-22T14:05:39.480Z",
				doneAt: "2026-11-22T14:05:39.480Z",
				entityCount: 0,
			},
		],
	},
	api_model: {
		type: "api_model",
		model: {
			id: finishedId,
			projectId: shopProjectId,
			sessionId: "5b0d6f1e-2c3a-4d4b-9e8f-7a6b5c4d3e2f",
			sessionPath:
				"/home/operator/.sentinel/agent/sessions/--home-operator-.sentinel-projects-shop--/2026-11-23T08-30-04-512Z_5b0d6f1e-2c3a-4d4b-9e8f-7a6b5c4d3e2f.jsonl",
			title: "商城前台 API",
			target: "https://shop.example.com",
			status: "done",
			openapi,
			entities,
			pathCount: 2,
			operationCount: 3,
			submissions: 2,
			createdAt: "2026-11-23T08:30:05.310Z",
			updatedAt: "2026-11-23T09:03:20.084Z",
			doneAt: "2026-11-23T09:03:20.084Z",
		},
		events: [
			{ at: "2026-11-23T08:30:05.310Z", kind: "created", pathCount: 0, operationCount: 0 },
			{
				at: "2026-11-23T08:41:12.775Z",
				kind: "submitted",
				note: "骨架与用户模块",
				pathCount: 1,
				operationCount: 2,
			},
			{ at: "2026-11-23T08:52:47.026Z", kind: "submitted", note: "订单模块", pathCount: 2, operationCount: 3 },
			{
				at: "2026-11-23T09:03:20.084Z",
				kind: "done",
				note: "已覆盖用户和订单两个模块；支付流程没有验证，未写入。",
				pathCount: 2,
				operationCount: 3,
			},
		],
	},
	api_model_result: { type: "api_model_result", action: "结束", id: runningId, ok: true },
	api_model_export: {
		type: "api_model_export",
		filename: "商城前台-api-3f2a1b9c.json",
		format: "json",
		text: `${JSON.stringify(openapi, null, 2)}\n`,
	},
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
