# 业务建模

业务建模让 Agent 给项目的业务留下一份模型。一次建模是一条记录，记录分两部分：接口文档（OpenAPI 3.0 文档和业务实体），以及从项目源码里读出来的模型（每个接口的源码映射，和代码背后的业务逻辑模型）。接口文档有两个来源：有流量时从实际响应还原；读源码时按源码里声明的路由、方法、参数、请求体和响应结构写，每个接口的 `description` 开头注明「来自源码」。每部分依据什么由 Agent 按手上的输入决定，有流量也有源码就都做；记录由 Agent 第一次提交时创建，重做不覆盖上一条。

对话里的「开始建模」只发一段建模指令并开始一轮，不建记录。工程模式下由指挥官把「做业务建模」写进任务指令派发给执行 Agent。读取是开放的：对话、执行 Agent、子代理和指挥官都能用 `api_model_read` 读本项目已有的记录；提交只有对话和执行 Agent 可以。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 7 种 |
| 下行消息 | 4 种 |
| 处理代码 | `packages/web/src/server.ts` 第 3653–3663、3664–3666、3667–3669、3670–3678、3679–3691、3692–3702、3820–3833 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

一条记录有两部分，各自可以为空：`target` 是从哪里的流量还原的，`source` 是读了哪部分源码；`pathCount`、`operationCount`、`entityCount` 数接口文档，`apiCount`、`stateMachineCount`、`ruleCount` 数源码模型。合并之前只有接口文档的记录，源码那几个字段是 0，`source` 是空字符串。

## 上行消息（浏览器 → 服务端）

### `start_modeling`

让 Agent 在当前会话里开始业务建模：向会话发一段建模指令，并开始一轮。

这条消息不建记录，也不改会话状态。记录由 Agent 第一次提交时创建，所以这一轮没有提交过任何内容时，不会留下一条空记录。Agent 正在运行时，指令排在当前这一轮之后，不被拒绝。工程任务的会话不能这样开始：它的建模由指挥官派发。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `error` |
| 广播 | `environment` |
| 失败文案 | `环境检查未通过`、`Docker 环境不可用（{detail}）。请在「设置 → 环境」中修复后复检。`、`会话尚未就绪，请重新选择项目`、`工程任务的会话不能做业务建模` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `environment`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "start_modeling"
}
```

### `end_modeling`

手动结束当前会话正在写的那条记录。

记录必须存在，也就是 Agent 已经提交过内容；Agent 正在运行时拒绝，先中止。

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

取一条记录的详情：两部分的内容和审计时间线。

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

把一条记录标记为已结束。

已经结束的记录不被改写：它原来怎么结束的就还是怎么结束，结果里 `ok` 仍是 `true`。

这条消息不看记录所属的会话是否正在运行。那个会话的 Agent 还在运行时，它这一轮里随后的提交都会被拒绝，不会悄悄新开一条记录；等这一轮结束，操作员重新开始建模才能继续。

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

删除一条记录。

某个会话正在写的记录被删除时，那个会话的这次建模一并结束。它的 Agent 还在运行的话，这一轮里随后的提交都会被拒绝，不会悄悄新开一条记录。

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

把一条记录导出成文件。

`format` 是 `json` 或 `yaml` 时导出的是接口文档（OpenAPI）；是 `record` 或 `markdown` 时导出的是整条记录，两部分都在里面。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`format`："json" \| "yaml" \| "record" \| "markdown" |
| 回复请求方 | `error`、`api_model_export` |
| 广播 | 无 |
| 失败文案 | `该记录不存在` |

处理的结果通过 `api_model_export` 回给发出消息的连接。

```json
{
	"type": "export_api_model",
	"id": "api-3f2a1b9c-4d5e-4f6a-9b7c-1d2e3f4a5b6c",
	"format": "markdown"
}
```

## 下行消息（服务端 → 浏览器）

### `api_models`

业务建模记录列表，新在前。每条带两部分的计数。

| 项目 | 内容 |
| --- | --- |
| 字段 | `items`：SentinelApiModelSummary[] |
| 发送时机 | 回复 `list_api_models` 时，只发给发出消息的连接；记录有变化时由 `broadcastApiModels` 发给所有连接 |

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
			"target": "https://checkout.example.com",
			"source": "",
			"status": "modeling",
			"pathCount": 0,
			"operationCount": 0,
			"submissions": 0,
			"createdAt": "2026-11-24T09:41:02.220Z",
			"updatedAt": "2026-11-24T09:41:02.220Z",
			"doneAt": null,
			"entityCount": 0,
			"apiCount": 0,
			"stateMachineCount": 0,
			"ruleCount": 0
		},
		{
			"id": "api-3f2a1b9c-4d5e-4f6a-9b7c-1d2e3f4a5b6c",
			"projectId": "6c2f9a14-3b7e-4d51-9f08-2a5e7c1d0b43",
			"sessionId": "5b0d6f1e-2c3a-4d4b-9e8f-7a6b5c4d3e2f",
			"sessionPath": "/home/operator/.sentinel/agent/sessions/--home-operator-.sentinel-projects-shop--/2026-11-23T08-30-04-512Z_5b0d6f1e-2c3a-4d4b-9e8f-7a6b5c4d3e2f.jsonl",
			"title": "商城",
			"target": "https://shop.example.com",
			"source": "shop-api/",
			"status": "done",
			"pathCount": 2,
			"operationCount": 3,
			"submissions": 4,
			"createdAt": "2026-11-23T08:30:05.310Z",
			"updatedAt": "2026-11-23T09:03:20.084Z",
			"doneAt": "2026-11-23T09:03:20.084Z",
			"entityCount": 2,
			"apiCount": 2,
			"stateMachineCount": 1,
			"ruleCount": 2
		},
		{
			"id": "api-7e1d4c0b-9a8f-4b7e-8c6d-5f4e3d2c1b0a",
			"projectId": "6c2f9a14-3b7e-4d51-9f08-2a5e7c1d0b43",
			"sessionId": "d8a2c5f1-3e4b-4c6d-9f7a-0b1c2d3e4f58",
			"sessionPath": "/home/operator/.sentinel/agent/sessions/--home-operator-.sentinel-projects-shop--/2026-11-22T14-05-31-640Z_d8a2c5f1-3e4b-4c6d-9f7a-0b1c2d3e4f58.jsonl",
			"title": "商城",
			"target": "",
			"source": "",
			"status": "failed",
			"pathCount": 0,
			"operationCount": 0,
			"submissions": 0,
			"error": "会话已关闭",
			"createdAt": "2026-11-22T14:05:36.093Z",
			"updatedAt": "2026-11-22T14:05:39.480Z",
			"doneAt": "2026-11-22T14:05:39.480Z",
			"entityCount": 0,
			"apiCount": 0,
			"stateMachineCount": 0,
			"ruleCount": 0
		}
	]
}
```

### `api_model`

一条记录的详情：两部分的内容和审计时间线。

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
		"title": "商城",
		"target": "https://shop.example.com",
		"source": "shop-api/",
		"status": "done",
		"openapi": {
			"openapi": "3.0.3",
			"info": {
				"title": "商城前台 API",
				"version": "1.0.0"
			},
			"servers": [
				{
					"url": "https://shop.example.com"
				}
			],
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
		"apis": [
			{
				"method": "GET",
				"path": "/api/orders/{id}",
				"module": "订单",
				"summary": "查订单",
				"handler": {
					"name": "OrderController.getOrder",
					"location": {
						"file": "/work/shop-api/src/main/java/com/shop/order/OrderController.java",
						"line": 42
					}
				},
				"callChain": [
					{
						"layer": "service",
						"name": "OrderService.find",
						"location": {
							"file": "/work/shop-api/src/main/java/com/shop/order/OrderService.java",
							"line": 88
						}
					},
					{
						"layer": "repository",
						"name": "OrderMapper.selectById",
						"location": {
							"file": "/work/shop-api/src/main/java/com/shop/order/OrderMapper.java",
							"line": 23
						}
					}
				],
				"dataAccess": [
					{
						"operation": "read",
						"table": "t_order",
						"columns": [
							"id",
							"user_id",
							"status",
							"amount"
						],
						"location": {
							"file": "/work/shop-api/src/main/resources/mapper/OrderMapper.xml",
							"line": 7
						}
					}
				],
				"authChecks": [],
				"externalCalls": [],
				"confidence": "verified",
				"notes": "整条调用链上没有找到登录、权限或资源归属的校验"
			},
			{
				"method": "POST",
				"path": "/api/orders/{id}/pay",
				"module": "订单",
				"summary": "订单支付",
				"handler": {
					"name": "OrderController.pay",
					"location": {
						"file": "/work/shop-api/src/main/java/com/shop/order/OrderController.java",
						"line": 50
					}
				},
				"callChain": [
					{
						"layer": "service",
						"name": "OrderService.pay",
						"location": {
							"file": "/work/shop-api/src/main/java/com/shop/order/OrderService.java",
							"line": 96
						}
					},
					{
						"layer": "util",
						"name": "PayClient.createPayment",
						"location": {
							"file": "/work/shop-api/src/main/java/com/shop/order/pay/PayClient.java",
							"line": 20
						}
					}
				],
				"dataAccess": [
					{
						"operation": "write",
						"table": "t_order",
						"columns": [
							"status",
							"paid_at"
						],
						"location": {
							"file": "/work/shop-api/src/main/java/com/shop/order/OrderService.java",
							"line": 104
						}
					}
				],
				"authChecks": [
					{
						"kind": "ownership",
						"note": "校验 order.userId 等于当前登录用户",
						"location": {
							"file": "/work/shop-api/src/main/java/com/shop/order/OrderService.java",
							"line": 99
						}
					}
				],
				"externalCalls": [
					{
						"kind": "http",
						"target": "https://pay.example.com/v1/payments",
						"location": {
							"file": "/work/shop-api/src/main/java/com/shop/order/pay/PayClient.java",
							"line": 20
						}
					},
					{
						"kind": "mq",
						"target": "order.paid",
						"note": "支付成功后通知发货",
						"location": {
							"file": "/work/shop-api/src/main/java/com/shop/order/OrderService.java",
							"line": 110
						}
					}
				],
				"confidence": "verified"
			}
		],
		"logic": {
			"entities": [
				{
					"name": "订单",
					"table": "t_order",
					"owner": "用户",
					"fields": [
						{
							"name": "status",
							"meaning": "订单状态"
						},
						{
							"name": "amount",
							"meaning": "订单金额"
						},
						{
							"name": "user_id",
							"meaning": "下单用户"
						}
					],
					"locations": [
						{
							"file": "/work/shop-api/src/main/java/com/shop/order/entity/Order.java",
							"line": 9
						}
					]
				},
				{
					"name": "用户",
					"table": "t_user",
					"fields": [
						{
							"name": "role",
							"meaning": "角色，admin 可管理全部订单"
						}
					],
					"locations": [
						{
							"file": "/work/shop-api/src/main/java/com/shop/order/entity/User.java",
							"line": 7
						}
					]
				}
			],
			"relations": [
				{
					"from": "订单",
					"to": "用户",
					"kind": "N:1",
					"description": "一个用户拥有多个订单",
					"locations": [
						{
							"file": "/work/shop-api/src/main/java/com/shop/order/entity/Order.java",
							"line": 12
						}
					]
				}
			],
			"stateMachines": [
				{
					"subject": "订单",
					"field": "status",
					"states": [
						{
							"name": "待支付",
							"meaning": "下单后未付款"
						},
						{
							"name": "已支付"
						},
						{
							"name": "已发货"
						}
					],
					"initial": "待支付",
					"transitions": [
						{
							"from": "待支付",
							"to": "已支付",
							"trigger": "POST /api/orders/{id}/pay",
							"guard": "订单属于当前用户，且金额大于 0",
							"effect": "写入 paid_at，发送 order.paid",
							"locations": [
								{
									"file": "/work/shop-api/src/main/java/com/shop/order/OrderService.java",
									"line": 96
								}
							]
						},
						{
							"from": "已支付",
							"to": "已发货",
							"trigger": "POST /api/orders/{id}/ship",
							"guard": "仅管理员",
							"effect": "写入 shipped_at",
							"locations": [
								{
									"file": "/work/shop-api/src/main/java/com/shop/order/OrderService.java",
									"line": 130
								}
							]
						}
					],
					"locations": [
						{
							"file": "/work/shop-api/src/main/java/com/shop/order/enums/OrderStatus.java",
							"line": 1
						}
					]
				}
			],
			"rules": [
				{
					"id": "order.owner",
					"kind": "ownership",
					"subject": "订单",
					"statement": "用户只能查看和支付自己的订单",
					"apis": [
						"GET /api/orders/{id}",
						"POST /api/orders/{id}/pay"
					],
					"locations": [
						{
							"file": "/work/shop-api/src/main/java/com/shop/order/OrderService.java",
							"line": 99
						}
					]
				},
				{
					"id": "order.pay.precondition",
					"kind": "precondition",
					"subject": "POST /api/orders/{id}/pay",
					"statement": "只有待支付、金额大于 0 的订单可以支付",
					"apis": [
						"POST /api/orders/{id}/pay"
					],
					"locations": [
						{
							"file": "/work/shop-api/src/main/java/com/shop/order/OrderService.java",
							"line": 98
						}
					]
				}
			],
			"apiDependencies": [
				{
					"from": "POST /api/orders/{id}/ship",
					"to": "POST /api/orders/{id}/pay",
					"kind": "requires",
					"description": "发货前订单必须已支付",
					"locations": [
						{
							"file": "/work/shop-api/src/main/java/com/shop/order/OrderService.java",
							"line": 130
						}
					]
				}
			]
		},
		"pathCount": 2,
		"operationCount": 3,
		"submissions": 4,
		"createdAt": "2026-11-23T08:30:05.310Z",
		"updatedAt": "2026-11-23T09:03:20.084Z",
		"doneAt": "2026-11-23T09:03:20.084Z"
	},
	"events": [
		{
			"at": "2026-11-23T08:30:05.310Z",
			"kind": "created",
			"pathCount": 0,
			"operationCount": 0,
			"entityCount": 0,
			"apiCount": 0,
			"stateMachineCount": 0,
			"ruleCount": 0
		},
		{
			"at": "2026-11-23T08:41:12.775Z",
			"kind": "submitted",
			"note": "骨架与用户模块",
			"pathCount": 1,
			"operationCount": 2,
			"entityCount": 1,
			"apiCount": 0,
			"stateMachineCount": 0,
			"ruleCount": 0
		},
		{
			"at": "2026-11-23T08:52:47.026Z",
			"kind": "submitted",
			"note": "订单模块",
			"pathCount": 2,
			"operationCount": 3,
			"entityCount": 2,
			"apiCount": 0,
			"stateMachineCount": 0,
			"ruleCount": 0
		},
		{
			"at": "2026-11-23T09:01:03.412Z",
			"kind": "submitted",
			"note": "订单模块的接口映射",
			"pathCount": 2,
			"operationCount": 3,
			"entityCount": 2,
			"apiCount": 2,
			"stateMachineCount": 0,
			"ruleCount": 0
		},
		{
			"at": "2026-11-23T09:02:10.900Z",
			"kind": "submitted",
			"note": "订单状态机与归属规则",
			"pathCount": 2,
			"operationCount": 3,
			"entityCount": 2,
			"apiCount": 2,
			"stateMachineCount": 1,
			"ruleCount": 2
		},
		{
			"at": "2026-11-23T09:03:20.084Z",
			"kind": "done",
			"note": "接口还原覆盖用户和订单两个模块，支付流程没有验证，未写入；源码读了 shop-api 的订单模块，后台管理接口没有读。",
			"pathCount": 2,
			"operationCount": 3,
			"entityCount": 2,
			"apiCount": 2,
			"stateMachineCount": 1,
			"ruleCount": 2
		}
	]
}
```

### `api_model_result`

一次记录操作的结果。

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

导出的文件。`format` 原样带回请求里的格式，`filename` 是建议的文件名。

| 项目 | 内容 |
| --- | --- |
| 字段 | `filename`：string；`format`："json" \| "yaml" \| "record" \| "markdown"；`text`：string |
| 发送时机 | 回复 `export_api_model` 时，只发给发出消息的连接 |

```json
{
	"type": "api_model_export",
	"filename": "商城-record-3f2a1b9c.md",
	"format": "markdown",
	"text": "# 商城\n\n- 流量目标：https://shop.example.com\n- 源码范围：shop-api/\n- 接口：2 个路径，3 个操作\n- 业务实体：2 个\n- 源码映射：2 条\n- 状态机：1 个\n- 业务规则：2 条\n\n## 接口文档\n\n服务地址：https://shop.example.com\n\n| 方法 | 路径 | 说明 |\n| --- | --- | --- |\n| GET | /api/orders/{orderId} | 订单详情 |\n| GET | /api/users | 用户列表 |\n| POST | /api/users | 创建用户 |\n\n## 业务实体\n\n### 用户\n\n商城的注册账号\n\n| 字段 | 类型 | 说明 |\n| --- | --- | --- |\n| id | integer | 用户 ID |\n| nickname | string | 昵称 |\n\n- 关系：1:N 订单：用户拥有的订单\n\n### 订单\n\n| 字段 | 类型 | 说明 |\n| --- | --- | --- |\n| orderId | integer | 订单 ID |\n| status | string | 待支付 / 已支付 / 已取消 |\n\n## API 源码映射\n\n### GET /api/orders/{id}：查订单\n\n模块：订单\n\n- 入口：`OrderController.getOrder`（/work/shop-api/src/main/java/com/shop/order/OrderController.java:42）\n- 调用链：\n  1. [service] `OrderService.find`（/work/shop-api/src/main/java/com/shop/order/OrderService.java:88）\n  2. [repository] `OrderMapper.selectById`（/work/shop-api/src/main/java/com/shop/order/OrderMapper.java:23）\n- 数据访问：\n  - 读 `t_order`（id, user_id, status, amount）（/work/shop-api/src/main/resources/mapper/OrderMapper.xml:7）\n- 权限校验：未发现\n- 备注：整条调用链上没有找到登录、权限或资源归属的校验\n\n### POST /api/orders/{id}/pay：订单支付\n\n模块：订单\n\n- 入口：`OrderController.pay`（/work/shop-api/src/main/java/com/shop/order/OrderController.java:50）\n- 调用链：\n  1. [service] `OrderService.pay`（/work/shop-api/src/main/java/com/shop/order/OrderService.java:96）\n  2. [util] `PayClient.createPayment`（/work/shop-api/src/main/java/com/shop/order/pay/PayClient.java:20）\n- 数据访问：\n  - 写 `t_order`（status, paid_at）（/work/shop-api/src/main/java/com/shop/order/OrderService.java:104）\n- 权限校验：\n  - ownership：校验 order.userId 等于当前登录用户（/work/shop-api/src/main/java/com/shop/order/OrderService.java:99）\n- 外部调用：\n  - [http] https://pay.example.com/v1/payments（/work/shop-api/src/main/java/com/shop/order/pay/PayClient.java:20）\n  - [mq] order.paid（/work/shop-api/src/main/java/com/shop/order/OrderService.java:110）：支付成功后通知发货\n\n## 源码实体\n\n| 实体 | 表 | 归属 | 说明 | 位置 |\n| --- | --- | --- | --- | --- |\n| 订单 | t_order | 用户 |  | /work/shop-api/src/main/java/com/shop/order/entity/Order.java:9 |\n| 用户 | t_user |  |  | /work/shop-api/src/main/java/com/shop/order/entity/User.java:7 |\n\n## 实体关系\n\n| 起点 | 关系 | 终点 | 说明 | 位置 |\n| --- | --- | --- | --- | --- | --- |\n| 订单 | N:1 | 用户 | 一个用户拥有多个订单 | /work/shop-api/src/main/java/com/shop/order/entity/Order.java:12 |\n\n## 状态机\n\n### 订单（status）\n\n状态：待支付、已支付、已发货；初始状态：待支付\n\n| 从 | 到 | 触发 | 前置条件 | 结果 | 位置 |\n| --- | --- | --- | --- | --- | --- |\n| 待支付 | 已支付 | POST /api/orders/{id}/pay | 订单属于当前用户，且金额大于 0 | 写入 paid_at，发送 order.paid | /work/shop-api/src/main/java/com/shop/order/OrderService.java:96 |\n| 已支付 | 已发货 | POST /api/orders/{id}/ship | 仅管理员 | 写入 shipped_at | /work/shop-api/src/main/java/com/shop/order/OrderService.java:130 |\n\n位置：/work/shop-api/src/main/java/com/shop/order/enums/OrderStatus.java:1\n\n## 业务规则\n\n| 类型 | 对象 | 规则 | 涉及接口 | 位置 |\n| --- | --- | --- | --- | --- | --- |\n| 资源所有权 | 订单 | 用户只能查看和支付自己的订单 | GET /api/orders/{id}、POST /api/orders/{id}/pay | /work/shop-api/src/main/java/com/shop/order/OrderService.java:99 |\n| 前置条件 | POST /api/orders/{id}/pay | 只有待支付、金额大于 0 的订单可以支付 | POST /api/orders/{id}/pay | /work/shop-api/src/main/java/com/shop/order/OrderService.java:98 |\n\n## 跨接口业务依赖\n\n| 起点 | 关系 | 终点 | 说明 | 位置 |\n| --- | --- | --- | --- | --- | --- |\n| POST /api/orders/{id}/ship | 依赖 | POST /api/orders/{id}/pay | 发货前订单必须已支付 | /work/shop-api/src/main/java/com/shop/order/OrderService.java:130 |"
}
```
