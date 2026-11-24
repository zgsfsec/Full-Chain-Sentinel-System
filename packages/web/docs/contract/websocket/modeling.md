# 业务建模

业务建模让 Agent 把目标的接口还原成 OpenAPI 3.0 文档，并整理出业务实体。一次建模是一条记录，重做不覆盖上一条。会话可以关联建模数据，把接口目录交给 Agent；`detach_modeling` 解除这种关联。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 8 种 |
| 下行消息 | 4 种 |
| 处理代码 | `packages/web/src/server.ts` 第 3657–3667、3668–3670、3671–3673、3674–3676、3677–3685、3686–3698、3699–3709、3827–3840 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `start_modeling`

让 Agent 在当前会话里开始业务建模。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `error` |
| 广播 | `environment`、`api_models`、`snapshot` |
| 失败文案 | `环境检查未通过`、`Docker 环境不可用（{detail}）。请在「设置 → 环境」中修复后复检。`、`会话尚未就绪，请重新选择项目`、`工程任务的会话不能做业务建模`、`Agent 正在运行，请先中止或等本轮结束再开始业务建模`、`当前会话已经在业务建模中` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `environment`。状态实际发生变化时，还会向所有控制台广播 `api_models`、`snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "start_modeling"
}
```

### `end_modeling`

手动结束当前会话的业务建模。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | 无 |
| 广播 | `api_models`、`snapshot` |
| 失败文案 | `会话尚未就绪，请重新选择项目`、`当前会话没有进行中的业务建模`、`Agent 正在运行，请先中止再结束业务建模` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `api_models`、`snapshot`；什么都没变时不发。

```json
{
	"type": "end_modeling"
}
```

### `detach_modeling`

解除会话和建模数据之间的关联。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | 无 |
| 广播 | `snapshot` |
| 失败文案 | `会话尚未就绪，请重新选择项目`、`当前会话没有带入业务建模数据`、`Agent 正在运行，请先中止再移除` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "detach_modeling"
}
```

### `list_api_models`

取业务建模记录列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `filters`（可选）：SentinelApiModelFilters |
| 回复请求方 | `api_models` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `api_models` 回给发出消息的连接。

```json
{
	"type": "list_api_models",
	"filters": {
		"projectId": "6c2f9a14-3b7e-4d51-9f08-2a5e7c1d0b43",
		"status": "done",
		"search": "商城"
	}
}
```

### `get_api_model`

取一条建模记录的详情。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error`、`api_model` |
| 广播 | 无 |
| 失败文案 | `没有 id 为 {id} 的业务建模记录` |

处理的结果通过 `api_model` 回给发出消息的连接。

```json
{
	"type": "get_api_model",
	"id": "api-3f2a1b9c-4d5e-4f6a-9b7c-1d2e3f4a5b6c"
}
```

### `end_api_model`

把一条建模记录标记为已结束。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `api_model_result` |
| 广播 | `api_models`、`snapshot` |
| 失败文案 | 无 |

处理的结果通过 `api_model_result` 回给发出消息的连接。状态实际发生变化时，还会向所有控制台广播 `api_models`、`snapshot`；什么都没变时不发。失败的原因写在结果消息的 `error` 字段里：`该记录不存在`。

```json
{
	"type": "end_api_model",
	"id": "api-9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
}
```

### `delete_api_model`

删除一条建模记录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `api_model_result` |
| 广播 | `api_models`、`snapshot` |
| 失败文案 | 无 |

处理的结果通过 `api_model_result` 回给发出消息的连接。状态实际发生变化时，还会向所有控制台广播 `api_models`、`snapshot`；什么都没变时不发。失败的原因写在结果消息的 `error` 字段里：`该记录不存在`。

```json
{
	"type": "delete_api_model",
	"id": "api-5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d"
}
```

### `export_api_model`

把一条建模记录导出成 OpenAPI 文档。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`format`："json" | "yaml" |
| 回复请求方 | `error`、`api_model_export` |
| 广播 | 无 |
| 失败文案 | `该记录不存在` |

处理的结果通过 `api_model_export` 回给发出消息的连接。

```json
{
	"type": "export_api_model",
	"id": "api-3f2a1b9c-4d5e-4f6a-9b7c-1d2e3f4a5b6c",
	"format": "json"
}
```

## 下行消息（服务端 → 浏览器）

### `api_models`

业务建模记录列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `items`：SentinelApiModelSummary[] |
| 发送时机 | 回复 `list_api_models` 时，只发给发出消息的连接；由 `broadcastApiModels` 发送 |

```json
{
	"type": "api_models",
	"items": [
		{
			"id": "api-9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
			"projectId": "e07a5c93-1d4f-4b8a-9c2e-6f3d5b7a1c80",
			"sessionId": "c41e7b20-8f6d-4a2c-b3e9-0d5f8a1c6e24",
			"sessionPath": "/home/operator/.sentinel/agent/sessions/--home-operator-.sentinel-projects-checkout--/2026-11-24T09-40-58-077Z_c41e7b20-8f6d-4a2c-b3e9-0d5f8a1c6e24.jsonl",
			"title": "结算流程梳理",
			"target": "",
			"status": "modeling",
			"pathCount": 0,
			"operationCount": 0,
			"submissions": 0,
			"createdAt": "2026-11-24T09:41:02.220Z",
			"updatedAt": "2026-11-24T09:41:02.220Z",
			"doneAt": null,
			"entityCount": 0
		},
		{
			"id": "api-7e1d4c0b-9a8f-4b7e-8c6d-5f4e3d2c1b0a",
			"projectId": "6c2f9a14-3b7e-4d51-9f08-2a5e7c1d0b43",
			"sessionId": "d8a2c5f1-3e4b-4c6d-9f7a-0b1c2d3e4f58",
			"sessionPath": "/home/operator/.sentinel/agent/sessions/--home-operator-.sentinel-projects-shop--/2026-11-22T14-05-31-640Z_d8a2c5f1-3e4b-4c6d-9f7a-0b1c2d3e4f58.jsonl",
			"title": "业务建模",
			"target": "",
			"status": "failed",
			"pathCount": 0,
			"operationCount": 0,
			"submissions": 0,
			"error": "建模指令注入失败：模型请求失败（HTTP 401）",
			"createdAt": "2026-11-22T14:05:36.093Z",
			"updatedAt": "2026-11-22T14:05:39.480Z",
			"doneAt": "2026-11-22T14:05:39.480Z",
			"entityCount": 0
		}
	]
}
```

### `api_model`

一条建模记录的详情。

| 项目 | 内容 |
| --- | --- |
| 字段 | `model`：SentinelApiModel；`events`：SentinelApiModelEvent[] |
| 发送时机 | 回复 `get_api_model` 时，只发给发出消息的连接 |

```json
{
	"type": "api_model",
	"model": {
		"id": "api-3f2a1b9c-4d5e-4f6a-9b7c-1d2e3f4a5b6c",
		"projectId": "6c2f9a14-3b7e-4d51-9f08-2a5e7c1d0b43",
		"sessionId": "5b0d6f1e-2c3a-4d4b-9e8f-7a6b5c4d3e2f",
		"sessionPath": "/home/operator/.sentinel/agent/sessions/--home-operator-.sentinel-projects-shop--/2026-11-23T08-30-04-512Z_5b0d6f1e-2c3a-4d4b-9e8f-7a6b5c4d3e2f.jsonl",
		"title": "商城前台 API",
		"target": "https://shop.example.com",
		"status": "done",
		"openapi": {
			"openapi": "3.0.3",
			"info": {
				"title": "商城前台 API",
				"version": "1.0.0"
			},
			"paths": {
				"/api/users": {
					"get": {
						"summary": "用户列表",
						"responses": {
							"200": {
								"description": "OK"
							}
						}
					},
					"post": {
						"summary": "创建用户",
						"responses": {
							"201": {
								"description": "Created"
							}
						}
					}
				},
				"/api/orders/{orderId}": {
					"get": {
						"summary": "订单详情",
						"parameters": [
							{
								"name": "orderId",
								"in": "path",
								"required": true,
								"schema": {
									"type": "integer"
								}
							}
						],
						"responses": {
							"200": {
								"description": "OK"
							}
						}
					}
				}
			},
			"components": {
				"schemas": {
					"User": {
						"type": "object",
						"required": [
							"id"
						],
						"properties": {
							"id": {
								"type": "integer"
							},
							"nickname": {
								"type": "string"
							}
						}
					}
				}
			}
		},
		"entities": [
			{
				"name": "用户",
				"description": "商城的注册账号",
				"fields": [
					{
						"name": "id",
						"type": "integer",
						"description": "用户 ID"
					},
					{
						"name": "nickname",
						"type": "string",
						"description": "昵称"
					}
				],
				"relations": [
					{
						"target": "订单",
						"kind": "1:N",
						"description": "用户拥有的订单"
					}
				]
			},
			{
				"name": "订单",
				"fields": [
					{
						"name": "orderId",
						"type": "integer",
						"description": "订单 ID"
					},
					{
						"name": "status",
						"type": "string",
						"description": "待支付 / 已支付 / 已取消"
					}
				]
			}
		],
		"pathCount": 2,
		"operationCount": 3,
		"submissions": 2,
		"createdAt": "2026-11-23T08:30:05.310Z",
		"updatedAt": "2026-11-23T09:03:20.084Z",
		"doneAt": "2026-11-23T09:03:20.084Z"
	},
	"events": [
		{
			"at": "2026-11-23T08:30:05.310Z",
			"kind": "created",
			"pathCount": 0,
			"operationCount": 0
		},
		{
			"at": "2026-11-23T08:41:12.775Z",
			"kind": "submitted",
			"note": "骨架与用户模块",
			"pathCount": 1,
			"operationCount": 2
		},
		{
			"at": "2026-11-23T08:52:47.026Z",
			"kind": "submitted",
			"note": "订单模块",
			"pathCount": 2,
			"operationCount": 3
		},
		{
			"at": "2026-11-23T09:03:20.084Z",
			"kind": "done",
			"note": "已覆盖用户和订单两个模块；支付流程没有验证，未写入。",
			"pathCount": 2,
			"operationCount": 3
		}
	]
}
```

### `api_model_result`

一次建模记录操作的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `action`：string；`id`（可选）：string；`ok`：boolean；`error`（可选）：string |
| 发送时机 | 回复 `end_api_model`、`delete_api_model` 时，只发给发出消息的连接 |

```json
{
	"type": "api_model_result",
	"action": "结束",
	"id": "api-9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
	"ok": true
}
```

### `api_model_export`

导出的 OpenAPI 文档。

| 项目 | 内容 |
| --- | --- |
| 字段 | `filename`：string；`format`："json" | "yaml"；`text`：string |
| 发送时机 | 回复 `export_api_model` 时，只发给发出消息的连接 |

```json
{
	"type": "api_model_export",
	"filename": "商城前台-api-3f2a1b9c.json",
	"format": "json",
	"text": "{\n  \"openapi\": \"3.0.3\",\n  \"info\": {\n    \"title\": \"商城前台 API\",\n    \"version\": \"1.0.0\"\n  },\n  \"paths\": {\n    \"/api/users\": {\n      \"get\": {\n        \"summary\": \"用户列表\",\n        \"responses\": {\n          \"200\": {\n            \"description\": \"OK\"\n          }\n        }\n      },\n      \"post\": {\n        \"summary\": \"创建用户\",\n        \"responses\": {\n          \"201\": {\n            \"description\": \"Created\"\n          }\n        }\n      }\n    },\n    \"/api/orders/{orderId}\": {\n      \"get\": {\n        \"summary\": \"订单详情\",\n        \"parameters\": [\n          {\n            \"name\": \"orderId\",\n            \"in\": \"path\",\n            \"required\": true,\n            \"schema\": {\n              \"type\": \"integer\"\n            }\n          }\n        ],\n        \"responses\": {\n          \"200\": {\n            \"description\": \"OK\"\n          }\n        }\n      }\n    }\n  },\n  \"components\": {\n    \"schemas\": {\n      \"User\": {\n        \"type\": \"object\",\n        \"required\": [\n          \"id\"\n        ],\n        \"properties\": {\n          \"id\": {\n            \"type\": \"integer\"\n          },\n          \"nickname\": {\n            \"type\": \"string\"\n          }\n        }\n      }\n    }\n  }\n}\n"
}
```
