# 工程模式

工程模式由一个指挥官（Agent）组织多个测试任务。工程有运行、暂停、定时等状态；任务各自有会话。工程的列表、状态和事件由工程管理器推送：`engine_update` 是状态变化，`engine_commander_event` 和 `engine_task_event` 是事件流。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 18 种 |
| 下行消息 | 7 种 |
| 处理代码 | `packages/web/src/server.ts` 第 4223–4225、4226–4255、4256–4264、4265–4273、4274–4282、4283–4285、4286–4295、4296–4298、4299–4307、4308–4316、4317–4324、4325–4327、4328–4335、4336–4341、4342–4350、4351–4359、4360–4369、4370–4380 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `list_engines`

取工程列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `engines` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `engines` 回给发出消息的连接。

```json
{
	"type": "list_engines"
}
```

### `engine_create`

新建一个工程。

| 项目 | 内容 |
| --- | --- |
| 字段 | `input`：SentinelEngineCreateInput |
| 回复请求方 | `error` |
| 广播 | `environment`、`engines` |
| 失败文案 | `未配置配置目录，无法使用工程模式`、`请先创建或选择一个项目，工程属于项目`、`环境检查未通过`、`Docker 环境不可用（{detail}）。请在「设置 → 环境」中修复后复检。` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `environment`、`engines`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "engine_create",
	"input": {
		"recordWorkLinks": false,
		"name": "示例文本",
		"targets": "text",
		"doctrines": [
			"text"
		],
		"presetIds": [
			"preset-1"
		],
		"presetOptional": false,
		"limits": {
			"concurrency": 2,
			"roundLimit": 3,
			"tokenLimit": 3,
			"timeLimitMin": 3,
			"maxRetries": 100
		},
		"gateMode": "ai",
		"schedule": {
			"timezone": "text",
			"startAt": 1763973000000,
			"pauseAt": 1763973000000,
			"resumeAt": 1763973000000,
			"deadlineAt": 1763973000000,
			"repeatDaily": false
		}
	}
}
```

### `engine_set_gate_mode`

设置一个工程的命令门模式。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`gateMode`：SentinelEngineGateMode |
| 回复请求方 | `error` |
| 广播 | `engines` |
| 失败文案 | `未配置配置目录，无法使用工程模式`、`工程不存在`、`有任务正在运行或排队，请先暂停工程并等任务结束再修改`、`未配置守门模型：请在 设置 → 模型 给「守门模型」选一条模型（或让它跟随主模型）后再选「AI 裁判」` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `engines`。

```json
{
	"type": "engine_set_gate_mode",
	"id": "id-1",
	"gateMode": "ai"
}
```

### `engine_set_presets`

设置一个工程的指挥官可以使用的预设 Agent。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `error` |
| 广播 | `engines` |
| 失败文案 | `未配置配置目录，无法使用工程模式`、`工程不存在` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `engines`。

```json
{
	"type": "engine_set_presets",
	"id": "id-1",
	"presetIds": [
		"preset-1"
	]
}
```

### `engine_set_preset_optional`

设置工程派发任务时是否必须指定预设 Agent。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `error` |
| 广播 | `engines` |
| 失败文案 | `未配置配置目录，无法使用工程模式`、`工程不存在` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `engines`。

```json
{
	"type": "engine_set_preset_optional",
	"id": "id-1",
	"optional": true
}
```

### `engine_pause`

暂停一个工程：从此不再派发，正在运行的任务停下。

- 正在运行的任务停下后状态是 `paused`，对话保留，等 `engine_resume` 时在原对话里接着跑。
- 还在排队的任务也变成 `paused`。所以暂停之后，工程下没有 `queued` 或 `running` 的任务。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | 无 |
| 广播 | 无 |
| 失败文案 | `工程不存在`、`只有运行中的工程才能暂停` |

这条消息没有成功时的直接回复。

```json
{
	"type": "engine_pause",
	"id": "id-1"
}
```

### `engine_resume`

继续一个已暂停的工程，并把暂停打断的工作放回去。

- 开始过的任务回到它原来的对话，从中断处接着跑；还没开始过的任务直接开始。两种都先回到队列（`queued`）。
- 放不回去的任务保持 `paused`，原因写进指挥官的决策日志（`engine_commander_event`），例如任务的对话文件已经被删除。
- 指挥官启动失败时（例如没有配置指挥官模型），工程回到 `paused`，`pauseNote` 是「继续失败：原因」，刚才放回去的任务跟着停下；原因同时作为 `error` 回给请求方。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error` |
| 广播 | 无 |
| 失败文案 | `环境检查未通过`、`Docker 环境不可用（{detail}）。请在「设置 → 环境」中修复后复检。`、`工程不存在`、`只有已暂停的工程才能继续` |

这条消息没有成功时的直接回复。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "engine_resume",
	"id": "id-1"
}
```

### `engine_abort`

中止一个工程。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | 无 |
| 广播 | 无 |
| 失败文案 | `工程不存在` |

这条消息没有成功时的直接回复。失败的原因写在结果消息的 `error` 字段里：`工程已终止`。

```json
{
	"type": "engine_abort",
	"id": "id-1"
}
```

### `engine_set_schedule`

为一个工程设置定时计划。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`schedule`：SentinelEngineScheduleInput |
| 回复请求方 | `error` |
| 广播 | `engines` |
| 失败文案 | `工程不存在`、`只有尚未启动的计划工程才能修改计划；运行中的工程请先停用计划`、`定时计划无效`、`计划时区无效，请重新打开页面后再试`、`开始时间必须晚于当前时间`、`暂停时间和恢复时间必须同时填写，或同时留空`、`暂停时间必须晚于开始时间`、`恢复时间必须晚于暂停时间`、`最晚停止时间必须晚于最后一次计划动作` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `engines`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "engine_set_schedule",
	"id": "id-1",
	"schedule": {
		"timezone": "text",
		"startAt": 1763973000000,
		"pauseAt": 1763973000000,
		"resumeAt": 1763973000000,
		"deadlineAt": 1763973000000,
		"repeatDaily": false
	}
}
```

### `engine_cancel_schedule`

取消一个工程的定时计划。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error` |
| 广播 | `engines` |
| 失败文案 | `工程不存在`、`该工程没有生效中的定时计划` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `engines`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "engine_cancel_schedule",
	"id": "id-1"
}
```

### `engine_delete`

删除一个工程。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | 无 |
| 广播 | `engines` |
| 失败文案 | `工程不存在` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `engines`。失败的原因写在结果消息的 `error` 字段里：`工程已终止`。

```json
{
	"type": "engine_delete",
	"id": "id-1"
}
```

### `engine_add_targets`

给一个工程追加目标。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`targets`：string |
| 回复请求方 | 无 |
| 广播 | 无 |
| 失败文案 | `工程不存在`、`追加的目标列表为空` |

这条消息没有成功时的直接回复。

```json
{
	"type": "engine_add_targets",
	"id": "id-1",
	"targets": "text"
}
```

### `engine_steer_commander`

给工程的指挥官追加指令。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`text`：string |
| 回复请求方 | `error` |
| 广播 | 无 |
| 失败文案 | `工程不存在`、`消息不能为空`、`只有运行中或已完成的工程可以和指挥官对话`、`指挥官模型未配置：请先在「设置 → 模型」配置端点，或在工程页配置指挥官专用端点` |

这条消息没有成功时的直接回复。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "engine_steer_commander",
	"id": "id-1",
	"text": "示例文本"
}
```

### `engine_abort_task`

中止工程里的一个任务。`queued`、`running` 和 `paused` 的任务都可以：

- `queued` 的任务还没开始，直接变成 `aborted`。
- `running` 的任务先停下，再变成 `aborted`。它的对话里，这一轮记为已结束，目标记为已暂停。
- `paused` 的任务是暂停留下的。中止它就是放弃这个任务；还有这种任务时，工程不能收尾。

| 项目 | 内容 |
| --- | --- |
| 字段 | `taskId`：string |
| 回复请求方 | `error` |
| 广播 | 无 |
| 失败文案 | `任务 {id} 不存在（可能已完成、已删除或 id 有误）` |

这条消息没有成功时的直接回复。失败的原因写在结果消息的 `error` 字段里：`任务 {id} 不存在（可能已完成、已删除或 id 有误）`、`任务所属工程不存在`、`任务 {id} 不在运行中（当前状态：{status}）`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

最后一种失败只在任务已经结束时出现：`done`、`failed`、`blocked`、`aborted`。

```json
{
	"type": "engine_abort_task",
	"taskId": "task-1"
}
```

### `engine_task_events`

取一个任务的事件记录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `taskId`：string |
| 回复请求方 | `engine_task_events` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `engine_task_events` 回给发出消息的连接。

```json
{
	"type": "engine_task_events",
	"taskId": "task-1"
}
```

### `engine_commander_events`

取工程指挥官的事件记录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `engine_commander_events` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `engine_commander_events` 回给发出消息的连接。

```json
{
	"type": "engine_commander_events",
	"id": "id-1"
}
```

### `engine_open_task_session`

打开一个任务对应的会话。

| 项目 | 内容 |
| --- | --- |
| 字段 | `taskId`：string |
| 回复请求方 | `error` |
| 广播 | `snapshot`、`sessions`、`session_event` |
| 失败文案 | `该任务没有会话（可能尚未启动或已被删除）`、`任务所属工程不存在`、`该任务的会话文件不存在（可能已被删除）`、`工程所属项目「{project}」已不存在，无法继续执行` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`、`sessions`、`session_event`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "engine_open_task_session",
	"taskId": "task-1"
}
```

### `engine_report_snapshot`

取工程的报告快照。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `engine_report` |
| 广播 | 无 |
| 失败文案 | `工程不存在` |

处理的结果通过 `engine_report` 回给发出消息的连接。

```json
{
	"type": "engine_report_snapshot",
	"id": "id-1"
}
```

## 下行消息（服务端 → 浏览器）

### `engine_update`

一个工程的状态发生了变化。

| 项目 | 内容 |
| --- | --- |
| 字段 | `engine`：SentinelEngine |
| 发送时机 | 工程的状态发生变化时，由工程管理器广播 |

```json
{
	"type": "engine_update",
	"engine": {
		"reportTemplate": {
			"name": "示例文本",
			"id": "id-1",
			"markdown": "text",
			"revision": "text"
		},
		"id": "id-1",
		"submissionSource": "text",
		"projectId": "project-1",
		"projectName": "示例文本",
		"name": "示例文本",
		"status": "completed",
		"pauseNote": "示例文本",
		"targets": [
			{
				"target": "text"
			}
		],
		"doctrines": [
			"text"
		],
		"presetIds": [
			"preset-1"
		],
		"presetOptional": true,
		"limits": {
			"concurrency": 2,
			"roundLimit": 3,
			"tokenLimit": 3,
			"timeLimitMin": 3,
			"maxRetries": 100
		},
		"gateMode": "ai",
		"createdAt": 1763973000000,
		"startedAt": 1763973000000,
		"endedAt": 1763973000000,
		"schedule": {
			"timezone": "text",
			"startAt": 1763973000000,
			"pauseAt": 1763973000000,
			"resumeAt": 1763973000000,
			"deadlineAt": 1763973000000,
			"repeatDaily": true,
			"phase": "finished",
			"applied": [
				"start"
			],
			"finishedReason": "completed",
			"finishedAt": 1763973000000
		},
		"report": "text",
		"reproduction": {
			"outcome": "confirmed",
			"summary": "示例文本",
			"pocPath": "/work/evidence/notes.md",
			"vulnerableEvidence": "text",
			"fixedEvidence": "text"
		},
		"tasks": [
			{
				"id": "id-1",
				"engineId": "engine-1",
				"title": "示例文本",
				"objective": "示例文本",
				"target": "text",
				"workspace": "text",
				"status": "done",
				"attempt": 2,
				"criteria": [
					"text"
				],
				"roundLimit": 3,
				"pendingContinue": {
					"instruction": "text",
					"criteria": [
						"text"
					],
					"roundLimit": 3,
					"requestedAt": 1763973000000
				},
				"presetId": "preset-1",
				"presetName": "示例文本",
				"sessionId": "session-1",
				"startedAt": 1763973000000,
				"endedAt": 1763973000000,
				"summary": "示例文本",
				"error": "示例错误信息",
				"usage": {
					"input": 2,
					"output": 2,
					"total": 2,
					"cost": 0.0125
				},
				"vulns": 2,
				"autoResume": true
			}
		]
	}
}
```

### `engine_commander_event`

工程指挥官的一条事件。

| 项目 | 内容 |
| --- | --- |
| 字段 | `engineId`：string；`event`：SentinelEngineEvent |
| 发送时机 | 工程指挥官产生一条事件时，由工程管理器广播 |

```json
{
	"type": "engine_commander_event",
	"engineId": "engine-1",
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

### `engine_task_event`

工程里一个任务的一条事件。

| 项目 | 内容 |
| --- | --- |
| 字段 | `taskId`：string；`event`：SentinelEngineEvent |
| 发送时机 | 工程里的一个任务产生一条事件时，由工程管理器广播 |

```json
{
	"type": "engine_task_event",
	"taskId": "task-1",
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

### `engines`

工程列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `engines`：SentinelEngine[] |
| 发送时机 | 由 `broadcastEngines` 发送：连接建立时发给新连接；回复 `list_engines` 时发给发出消息的连接；任何修改工程的 `engine_*` 消息处理之后广播 |

```json
{
	"type": "engines",
	"engines": [
		{
			"reportTemplate": {
				"name": "示例文本",
				"id": "id-1",
				"markdown": "text",
				"revision": "text"
			},
			"id": "id-1",
			"submissionSource": "text",
			"projectId": "project-1",
			"projectName": "示例文本",
			"name": "示例文本",
			"status": "completed",
			"pauseNote": "示例文本",
			"targets": [
				{
					"target": "text"
				}
			],
			"doctrines": [
				"text"
			],
			"presetIds": [
				"preset-1"
			],
			"presetOptional": true,
			"limits": {
				"concurrency": 2,
				"roundLimit": 3,
				"tokenLimit": 3,
				"timeLimitMin": 3,
				"maxRetries": 100
			},
			"gateMode": "ai",
			"createdAt": 1763973000000,
			"startedAt": 1763973000000,
			"endedAt": 1763973000000,
			"schedule": {
				"timezone": "text",
				"startAt": 1763973000000,
				"pauseAt": 1763973000000,
				"resumeAt": 1763973000000,
				"deadlineAt": 1763973000000,
				"repeatDaily": true,
				"phase": "finished",
				"applied": [
					"start"
				],
				"finishedReason": "completed",
				"finishedAt": 1763973000000
			},
			"report": "text",
			"reproduction": {
				"outcome": "confirmed",
				"summary": "示例文本"
			},
			"tasks": [
				{
					"id": "id-1",
					"engineId": "engine-1",
					"title": "示例文本",
					"objective": "示例文本",
					"target": "text",
					"workspace": "text",
					"status": "done",
					"attempt": 2,
					"criteria": [
						"text"
					],
					"roundLimit": 3,
					"pendingContinue": {
						"instruction": "text",
						"criteria": [
							"text"
						],
						"roundLimit": 3,
						"requestedAt": 1763973000000
					},
					"presetId": "preset-1",
					"presetName": "示例文本",
					"sessionId": "session-1",
					"startedAt": 1763973000000,
					"endedAt": 1763973000000,
					"summary": "示例文本",
					"error": "示例错误信息",
					"usage": {
						"input": 2,
						"output": 2,
						"total": 2,
						"cost": 0.0125
					},
					"vulns": 2,
					"autoResume": true
				}
			]
		}
	]
}
```

### `engine_task_events`

一个任务的事件记录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `taskId`：string；`events`：SentinelEngineEvent[] |
| 发送时机 | 回复 `engine_task_events` 时，只发给发出消息的连接 |

```json
{
	"type": "engine_task_events",
	"taskId": "task-1",
	"events": [
		{
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
	]
}
```

### `engine_commander_events`

工程指挥官的事件记录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`events`：SentinelEngineEvent[] |
| 发送时机 | 回复 `engine_commander_events` 时，只发给发出消息的连接 |

```json
{
	"type": "engine_commander_events",
	"id": "id-1",
	"events": [
		{
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
	]
}
```

### `engine_report`

工程的报告快照。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`markdown`：string；`filename`：string |
| 发送时机 | 回复 `engine_report_snapshot` 时，只发给发出消息的连接 |

```json
{
	"type": "engine_report",
	"id": "id-1",
	"markdown": "text",
	"filename": "示例文本"
}
```
