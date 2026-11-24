# 监督

监督是会话级的开关：由独立的监督模型定期读取工具调用的摘要，给出阶段、意图、进度和下一步建议。观察模式只显示，介入模式把建议发给 Agent，不阻断任何工具调用。状态、片段、日志和建议都由运行时钩子实时广播。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 11 种 |
| 下行消息 | 9 种 |
| 处理代码 | `packages/web/src/server.ts` 第 4542–4553、4554–4558、4559–4563、4564–4573、4574–4576、4577–4596、4597–4611、4612–4620、4621–4628、4629–4634、4635–4642 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `supervisor_arm`

为当前会话开启监督。

| 项目 | 内容 |
| --- | --- |
| 字段 | `mode`：SentinelSupervisorMode；`delivery`：SentinelSupervisorDelivery；`strategy`：SentinelSupervisorStrategy；`strategies`（可选）：SentinelSupervisorStrategyRef[]。Multiple selections; takes precedence over the legacy singular fields.；`customStrategyId`（可选）：string | null。Set when the operator picked a saved custom strategy.；`note`（可选）：string。Optional operator note, capped at 200 characters. |
| 回复请求方 | 无 |
| 广播 | `supervisor_state` |
| 失败文案 | `会话尚未就绪，请重新选择项目`、`工程任务的会话不能单独开启监督`、`监督功能已在 设置 → 模型 中关闭`、`自定义监督策略不存在或已被删除`、`请至少选择一个监督策略`、`本次会话的监督已停止；请在新对话重新开启`、`监督只能在开始对话前开启` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `supervisor_state`。

```json
{
	"type": "supervisor_arm",
	"mode": "observe",
	"delivery": "confirm",
	"strategy": "steady",
	"strategies": [
		{
			"strategy": "steady",
			"customStrategyId": "custom-strategy-1"
		}
	],
	"note": "示例文本"
}
```

### `supervisor_stop`

停止当前会话的监督。停止之后不能恢复。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | 无 |
| 广播 | `supervisor_state` |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。同时向所有控制台广播 `supervisor_state`。

```json
{
	"type": "supervisor_stop"
}
```

### `supervisor_set_mode`

设置监督的介入模式：只观察，或者提建议。

| 项目 | 内容 |
| --- | --- |
| 字段 | `mode`：SentinelSupervisorMode；`delivery`：SentinelSupervisorDelivery |
| 回复请求方 | 无 |
| 广播 | `supervisor_state` |
| 失败文案 | `会话尚未就绪，请重新选择项目` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `supervisor_state`。

```json
{
	"type": "supervisor_set_mode",
	"mode": "observe",
	"delivery": "confirm"
}
```

### `supervisor_set_strategy`

设置监督使用的策略。

| 项目 | 内容 |
| --- | --- |
| 字段 | `strategy`：SentinelSupervisorStrategy；`customStrategyId`（可选）：string | null；`strategies`（可选）：SentinelSupervisorStrategyRef[]；`note`（可选）：string |
| 回复请求方 | 无 |
| 广播 | `supervisor_state` |
| 失败文案 | `会话尚未就绪，请重新选择项目`、`自定义监督策略不存在或已被删除`、`请至少选择一个监督策略`、`本次会话的监督已停止` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `supervisor_state`。

```json
{
	"type": "supervisor_set_strategy",
	"strategy": "steady",
	"strategies": [
		{
			"strategy": "steady",
			"customStrategyId": "custom-strategy-1"
		}
	],
	"note": "示例文本"
}
```

### `supervisor_run_now`

立即做一次监督分析。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | 无 |
| 广播 | 无 |
| 失败文案 | `会话尚未就绪，请重新选择项目`、`对话开始后才能分析`、`监督分析正在进行`、`还没有可分析的调用` |

这条消息没有成功时的直接回复。

```json
{
	"type": "supervisor_run_now"
}
```

### `supervisor_call_output`

取监督记录里一次工具调用的输出。

| 项目 | 内容 |
| --- | --- |
| 字段 | `callId`：string |
| 回复请求方 | `supervisor_call_output` |
| 广播 | 无 |
| 失败文案 | `会话尚未就绪，请重新选择项目`、`这次调用的完整输出已不在当前会话文件中` |

处理的结果通过 `supervisor_call_output` 回给发出消息的连接。

```json
{
	"type": "supervisor_call_output",
	"callId": "call-1"
}
```

### `supervisor_audit`

分页查询监督审计。

| 项目 | 内容 |
| --- | --- |
| 字段 | `page`（可选）：number；`pageSize`（可选）：number；`projectId`（可选）：string；`search`（可选）：string；`mode`（可选）：SentinelSupervisorMode；`progress`（可选）：SentinelSupervisorProgress；`strategy`（可选）：SentinelSupervisorStrategy；`customStrategyId`（可选）：string |
| 回复请求方 | `supervisor_audit` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `supervisor_audit` 回给发出消息的连接。

```json
{
	"type": "supervisor_audit",
	"page": 1,
	"pageSize": 50,
	"search": "text",
	"mode": "observe",
	"progress": "advancing",
	"strategy": "steady"
}
```

### `supervisor_detail`

取一个监督片段的详情。

| 项目 | 内容 |
| --- | --- |
| 字段 | `sessionId`：string |
| 回复请求方 | `error`、`supervisor_detail` |
| 广播 | 无 |
| 失败文案 | `监督记录不存在` |

处理的结果通过 `supervisor_detail` 回给发出消息的连接。

```json
{
	"type": "supervisor_detail",
	"sessionId": "session-1"
}
```

### `supervisor_advice_action`

对一条监督建议作出处理：发给 Agent，或者忽略。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`action`："send" | "ignore" |
| 回复请求方 | 无 |
| 广播 | `supervisor_advice` |
| 失败文案 | `会话尚未就绪，请重新选择项目`、`监督建议不存在`、`这条建议已被忽略` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `supervisor_advice`。

```json
{
	"type": "supervisor_advice_action",
	"id": "id-1",
	"action": "ignore"
}
```

### `save_supervisor_config`

保存监督的全局配置。

| 项目 | 内容 |
| --- | --- |
| 字段 | `config`：SentinelSupervisorConfig |
| 回复请求方 | 无 |
| 广播 | `supervisor_config`、`snapshot` |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。同时向所有控制台广播 `supervisor_config`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "save_supervisor_config",
	"config": {
		"enabled": true,
		"batchToolCalls": 2,
		"duplicateThreshold": 2,
		"noProgressCalls": 2,
		"errorStreak": 2,
		"longToolCallMs": 1250,
		"timeoutMs": 1250,
		"redactSecrets": true,
		"defaultStrategy": "steady",
		"defaultStrategies": [
			{
				"strategy": "steady",
				"customStrategyId": "custom-strategy-1"
			}
		],
		"customStrategies": [
			{
				"id": "id-1",
				"name": "示例文本",
				"base": "steady",
				"description": "nmap -sV -p 443 example.com",
				"instructions": "text",
				"createdAt": 1763973000000,
				"updatedAt": 1763973000000
			}
		],
		"defaultCustomStrategyId": "default-custom-strategy-1"
	}
}
```

### `test_supervisor`

测试监督模型的连接。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `supervisor_test_result` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `supervisor_test_result` 回给发出消息的连接。

```json
{
	"type": "test_supervisor"
}
```

## 下行消息（服务端 → 浏览器）

### `supervisor_state`

当前会话的监督状态。

| 项目 | 内容 |
| --- | --- |
| 字段 | `supervisor`：SentinelSupervisorView | null |
| 发送时机 | 处理 `supervisor_arm`、`supervisor_stop`、`supervisor_set_mode`、`supervisor_set_strategy` 时广播；运行时钩子 `onSupervisorState` 触发时广播 |

```json
{
	"type": "supervisor_state",
	"supervisor": {
		"sessionId": "session-1",
		"sessionPath": "/home/operator/.sentinel/agent/sessions/01933f2c-8a6b-7c1d-9e2f-5b4a3c6d8e0f.jsonl",
		"sessionName": "示例文本",
		"projectId": "project-1",
		"projectName": "示例文本",
		"mode": "observe",
		"delivery": "confirm",
		"strategy": "steady",
		"strategyCustomId": "strategy-custom-1",
		"strategyName": "示例文本",
		"strategyInstructions": "text",
		"strategies": [
			{
				"name": "示例文本",
				"instructions": "text",
				"strategy": "steady",
				"customStrategyId": "custom-strategy-1"
			}
		],
		"strategyNote": "示例文本",
		"status": "waiting",
		"armedAt": 1763973000000,
		"startedAt": 1763973000000,
		"endedAt": 1763973000000,
		"model": {
			"entryId": "entry-1",
			"entryName": "示例文本",
			"modelId": "model-1",
			"followedMain": true
		},
		"state": {
			"phase": "text",
			"intent": "text",
			"progress": "advancing",
			"tested": [
				{
					"target": "text",
					"test": "text",
					"result": "text"
				}
			],
			"deadEnds": [
				"text"
			],
			"newEvidence": [
				"text"
			],
			"openQuestions": [
				"text"
			],
			"nextCandidates": [
				"2026-11-24T08:30:00.000Z"
			],
			"duplicateSignals": [
				"text"
			]
		},
		"episodeCount": 2,
		"callCount": 2,
		"lastEpisodeAt": 1763973000000,
		"lastCallAt": 1763973000000,
		"usage": {
			"input": 2,
			"output": 2,
			"total": 2
		},
		"lastError": "示例错误信息",
		"running": true,
		"pendingAdvice": {
			"id": "id-1",
			"sessionId": "session-1",
			"episodeId": "episode-1",
			"at": 1763973000000,
			"delivery": "confirm",
			"status": "pending",
			"text": "示例文本",
			"sentAt": 1763973000000
		},
		"recentCalls": [
			{
				"callId": "call-1",
				"at": 1763973000000,
				"tool": "text",
				"args": "text",
				"status": "ok",
				"durationMs": 1250,
				"outputBytes": 2,
				"outputHash": "text",
				"outputHead": "text",
				"outputTail": "text",
				"httpStatus": 2,
				"newEndpoints": [
					"text"
				],
				"newParams": [
					"text"
				],
				"newEvidence": true,
				"signals": [
					"text"
				]
			}
		],
		"logs": [
			{
				"at": 1763973000000,
				"kind": "text",
				"text": "示例文本"
			}
		]
	}
}
```

### `supervisor_episode`

一个监督片段和它包含的工具调用。

| 项目 | 内容 |
| --- | --- |
| 字段 | `episode`：SentinelSupervisorEpisode；`calls`：SentinelSupervisorCall[] |
| 发送时机 | 运行时钩子 `onSupervisorEpisode` 触发时广播 |

```json
{
	"type": "supervisor_episode",
	"episode": {
		"id": "id-1",
		"sessionId": "session-1",
		"seq": 2,
		"at": 1763973000000,
		"trigger": "settled",
		"phase": "text",
		"intent": "text",
		"actions": [
			"text"
		],
		"outcomes": [
			"text"
		],
		"tested": [
			{
				"target": "text",
				"test": "text",
				"result": "text"
			}
		],
		"deadEnds": [
			"text"
		],
		"newEvidence": [
			"text"
		],
		"openQuestions": [
			"text"
		],
		"nextCandidates": [
			"2026-11-24T08:30:00.000Z"
		],
		"duplicateSignals": [
			"text"
		],
		"progress": "advancing",
		"confidence": 2,
		"advice": {
			"needed": true,
			"reason": "示例错误信息",
			"doNotRepeat": [
				"2026-11-24T08:30:00.000Z"
			],
			"nextActions": [
				"text"
			]
		},
		"model": "text",
		"usage": {
			"input": 2,
			"output": 2,
			"total": 2
		},
		"error": "示例错误信息",
		"durationMs": 1250
	},
	"calls": [
		{
			"callId": "call-1",
			"at": 1763973000000,
			"tool": "text",
			"args": "text",
			"status": "ok",
			"durationMs": 1250,
			"outputBytes": 2,
			"outputHash": "text",
			"outputHead": "text",
			"outputTail": "text",
			"httpStatus": 2,
			"newEndpoints": [
				"text"
			],
			"newParams": [
				"text"
			],
			"newEvidence": true,
			"signals": [
				"text"
			]
		}
	]
}
```

### `supervisor_log`

监督的一条日志。

| 项目 | 内容 |
| --- | --- |
| 字段 | `sessionId`：string；`log`：SentinelSupervisorLog |
| 发送时机 | 运行时钩子 `onSupervisorLog` 触发时广播 |

```json
{
	"type": "supervisor_log",
	"sessionId": "session-1",
	"log": {
		"at": 1763973000000,
		"kind": "text",
		"text": "示例文本"
	}
}
```

### `supervisor_advice`

一条监督建议和它的处理状态。

| 项目 | 内容 |
| --- | --- |
| 字段 | `advice`：SentinelSupervisorAdvice |
| 发送时机 | 处理 `supervisor_advice_action` 时广播；运行时钩子 `onSupervisorAdvice` 触发时广播 |

```json
{
	"type": "supervisor_advice",
	"advice": {
		"id": "id-1",
		"sessionId": "session-1",
		"episodeId": "episode-1",
		"at": 1763973000000,
		"delivery": "confirm",
		"status": "pending",
		"text": "示例文本",
		"sentAt": 1763973000000
	}
}
```

### `supervisor_call_output`

监督记录里一次工具调用的输出。

| 项目 | 内容 |
| --- | --- |
| 字段 | `callId`：string；`text`：string；`truncated`：boolean；`error`（可选）：string |
| 发送时机 | 回复 `supervisor_call_output` 时，只发给发出消息的连接 |

```json
{
	"type": "supervisor_call_output",
	"callId": "call-1",
	"text": "示例文本",
	"truncated": true,
	"error": "示例错误信息"
}
```

### `supervisor_audit`

监督审计的一页。

| 项目 | 内容 |
| --- | --- |
| 字段 | `page`：SentinelSupervisorAuditPage |
| 发送时机 | 回复 `supervisor_audit` 时，只发给发出消息的连接 |

```json
{
	"type": "supervisor_audit",
	"page": {
		"items": [
			{
				"sessionId": "session-1",
				"sessionPath": "/home/operator/.sentinel/agent/sessions/01933f2c-8a6b-7c1d-9e2f-5b4a3c6d8e0f.jsonl",
				"sessionName": "示例文本",
				"projectId": "project-1",
				"projectName": "示例文本",
				"mode": "observe",
				"delivery": "confirm",
				"strategy": "steady",
				"strategyCustomId": "strategy-custom-1",
				"strategyName": "示例文本",
				"strategyInstructions": "text",
				"strategyNote": "示例文本",
				"status": "waiting",
				"armedAt": 1763973000000,
				"startedAt": 1763973000000,
				"endedAt": 1763973000000,
				"updatedAt": 1763973000000,
				"episodeCount": 2,
				"callCount": 2,
				"phase": "text",
				"intent": "text",
				"progress": "advancing",
				"adviceCount": 2,
				"usage": {
					"input": 2,
					"output": 2,
					"total": 2
				},
				"lastError": "示例错误信息"
			}
		],
		"total": 2,
		"page": 1,
		"pageSize": 50,
		"stats": {
			"total": 2,
			"advancing": 2,
			"stalled": 2,
			"looping": 2,
			"stopped": 2,
			"pendingAdvice": 2
		}
	}
}
```

### `supervisor_detail`

一个监督片段的详情。

| 项目 | 内容 |
| --- | --- |
| 字段 | `detail`：SentinelSupervisorDetail |
| 发送时机 | 回复 `supervisor_detail` 时，只发给发出消息的连接 |

```json
{
	"type": "supervisor_detail",
	"detail": {
		"session": {
			"sessionId": "session-1",
			"sessionPath": "/home/operator/.sentinel/agent/sessions/01933f2c-8a6b-7c1d-9e2f-5b4a3c6d8e0f.jsonl",
			"sessionName": "示例文本",
			"projectId": "project-1",
			"projectName": "示例文本",
			"mode": "observe",
			"delivery": "confirm",
			"strategy": "steady",
			"strategyCustomId": "strategy-custom-1",
			"strategyName": "示例文本",
			"strategyInstructions": "text",
			"strategies": [
				{
					"name": "示例文本",
					"instructions": "text",
					"strategy": "steady",
					"customStrategyId": "custom-strategy-1"
				}
			],
			"strategyNote": "示例文本",
			"status": "waiting",
			"armedAt": 1763973000000,
			"startedAt": 1763973000000,
			"endedAt": 1763973000000,
			"updatedAt": 1763973000000,
			"episodeCount": 2,
			"callCount": 2,
			"phase": "text",
			"intent": "text",
			"progress": "advancing",
			"adviceCount": 2,
			"usage": {
				"input": 2,
				"output": 2,
				"total": 2
			},
			"lastError": "示例错误信息"
		},
		"episodes": [
			{
				"id": "id-1",
				"sessionId": "session-1",
				"seq": 2,
				"at": 1763973000000,
				"trigger": "settled",
				"phase": "text",
				"intent": "text",
				"actions": [
					"text"
				],
				"outcomes": [
					"text"
				],
				"tested": [
					{
						"target": "text",
						"test": "text",
						"result": "text"
					}
				],
				"deadEnds": [
					"text"
				],
				"newEvidence": [
					"text"
				],
				"openQuestions": [
					"text"
				],
				"nextCandidates": [
					"2026-11-24T08:30:00.000Z"
				],
				"duplicateSignals": [
					"text"
				],
				"progress": "advancing",
				"confidence": 2,
				"advice": {
					"needed": true,
					"reason": "示例错误信息",
					"doNotRepeat": [
						"2026-11-24T08:30:00.000Z"
					],
					"nextActions": [
						"text"
					]
				},
				"model": "text",
				"usage": {
					"input": 2,
					"output": 2,
					"total": 2
				},
				"error": "示例错误信息",
				"durationMs": 1250
			}
		],
		"logs": [
			{
				"at": 1763973000000,
				"kind": "text",
				"text": "示例文本"
			}
		],
		"advice": [
			{
				"id": "id-1",
				"sessionId": "session-1",
				"episodeId": "episode-1",
				"at": 1763973000000,
				"delivery": "confirm",
				"status": "pending",
				"text": "示例文本",
				"sentAt": 1763973000000
			}
		]
	}
}
```

### `supervisor_config`

监督的全局配置。

| 项目 | 内容 |
| --- | --- |
| 字段 | `config`：SentinelSupervisorConfig |
| 发送时机 | 处理 `save_supervisor_config` 时广播 |

```json
{
	"type": "supervisor_config",
	"config": {
		"enabled": true,
		"batchToolCalls": 2,
		"duplicateThreshold": 2,
		"noProgressCalls": 2,
		"errorStreak": 2,
		"longToolCallMs": 1250,
		"timeoutMs": 1250,
		"redactSecrets": true,
		"defaultStrategy": "steady",
		"defaultStrategies": [
			{
				"strategy": "steady",
				"customStrategyId": "custom-strategy-1"
			}
		],
		"customStrategies": [
			{
				"id": "id-1",
				"name": "示例文本",
				"base": "steady",
				"description": "nmap -sV -p 443 example.com",
				"instructions": "text",
				"createdAt": 1763973000000,
				"updatedAt": 1763973000000
			}
		],
		"defaultCustomStrategyId": "default-custom-strategy-1"
	}
}
```

### `supervisor_test_result`

监督模型连接测试的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `result`：SentinelTestResult；`raw`（可选）：string |
| 发送时机 | 回复 `test_supervisor` 时，只发给发出消息的连接 |

```json
{
	"type": "supervisor_test_result",
	"result": {
		"ok": true,
		"message": "示例文本",
		"detail": "示例文本"
	},
	"raw": "text"
}
```
