# 子代理

主 Agent 可以把独立的子任务派给子代理并行执行。子代理的工具集是主 Agent 的子集，bash 走同一条审批链。运行记录永久保存，会话销毁或控制台重启后仍能回看。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 4 种 |
| 下行消息 | 4 种 |
| 处理代码 | `packages/web/src/server.ts` 第 3421–3432、3834–3842、3843–3853、3854–3873 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `list_subagents`

取当前会话派发过的子代理列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `offset`（可选）：number；`limit`（可选）：number |
| 回复请求方 | `subagents` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `subagents` 回给发出消息的连接。

```json
{
	"type": "list_subagents",
	"offset": 2,
	"limit": 3
}
```

### `get_subagent`

取一次子代理运行的过程或结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error`、`subagent_run` |
| 广播 | 无 |
| 失败文案 | `该子代理记录不存在` |

处理的结果通过 `subagent_run` 回给发出消息的连接。

```json
{
	"type": "get_subagent",
	"id": "id-1"
}
```

### `abort_subagent`

中止一个正在运行的子代理。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `subagent_result` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `subagent_result` 回给发出消息的连接。失败的原因写在结果消息的 `error` 字段里：`该子代理已结束，无需中止`。

```json
{
	"type": "abort_subagent",
	"id": "id-1"
}
```

### `steer_subagent`

给一个正在运行的子代理追加指令。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`text`：string |
| 回复请求方 | `error`、`subagent_result` |
| 广播 | 无 |
| 失败文案 | `追加指令不能为空`、`环境检查未通过`、`Docker 环境不可用（{detail}）。请在「设置 → 环境」中修复后复检。` |

处理的结果通过 `subagent_result` 回给发出消息的连接。失败的原因写在结果消息的 `error` 字段里：`该子代理已结束，无法追加指令`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "steer_subagent",
	"id": "id-1",
	"text": "示例文本"
}
```

## 下行消息（服务端 → 浏览器）

### `subagents`

当前会话派发过的子代理运行列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `runs`：SentinelSubagentRun[]；`offset`：number；`total`：number |
| 发送时机 | 回复 `list_subagents` 时，只发给发出消息的连接 |

```json
{
	"type": "subagents",
	"runs": [
		{
			"id": "id-1",
			"sessionId": "session-1",
			"task": "text",
			"status": "done",
			"turns": 2,
			"startedAt": "2026-11-24T08:30:00.000Z",
			"endedAt": "2026-11-24T08:30:00.000Z",
			"result": "text",
			"error": "示例错误信息",
			"events": [
				{
					"seq": 2,
					"kind": "status",
					"at": 1763973000000
				}
			]
		}
	],
	"offset": 2,
	"total": 2
}
```

### `subagent_event`

一次子代理运行过程中的一条事件。

| 项目 | 内容 |
| --- | --- |
| 字段 | `runId`：string；`event`：SentinelSubagentEvent |
| 发送时机 | 运行时钩子 `onSubagentEvent` 触发时广播 |

```json
{
	"type": "subagent_event",
	"runId": "run-1",
	"event": {
		"seq": 2,
		"kind": "status",
		"at": 1763973000000,
		"text": "示例文本",
		"toolName": "示例文本",
		"args": null,
		"output": "text",
		"isError": false,
		"status": "done",
		"note": "示例文本",
		"durationMs": 1250,
		"from": "operator",
		"truncated": false
	}
}
```

### `subagent_run`

一次子代理运行的过程或结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `run`：SentinelSubagentRun |
| 发送时机 | 回复 `get_subagent` 时，只发给发出消息的连接 |

```json
{
	"type": "subagent_run",
	"run": {
		"id": "id-1",
		"sessionId": "session-1",
		"task": "text",
		"status": "done",
		"turns": 2,
		"startedAt": "2026-11-24T08:30:00.000Z",
		"endedAt": "2026-11-24T08:30:00.000Z",
		"result": "text",
		"error": "示例错误信息",
		"events": [
			{
				"seq": 2,
				"kind": "status",
				"at": 1763973000000
			}
		]
	}
}
```

### `subagent_result`

一次子代理操作的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `action`：string；`id`：string；`ok`：boolean；`error`（可选）：string |
| 发送时机 | 回复 `abort_subagent`、`steer_subagent` 时，只发给发出消息的连接 |

```json
{
	"type": "subagent_result",
	"action": "text",
	"id": "id-1",
	"ok": true,
	"error": "示例错误信息"
}
```
