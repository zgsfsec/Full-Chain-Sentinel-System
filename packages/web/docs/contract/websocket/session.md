# 会话与对话

本域是对话的核心：发消息、中止、压缩上下文、持续目标、命令门的三种模式和审批、会话的新建与切换、会话树和分支。待审批的命令放在 `snapshot` 的 `pendingApprovals` 里送到浏览器；Agent 运行时的事件通过 `session_event` 持续广播；状态每次变化都会安排一次 `snapshot` 广播，100 毫秒内的多次变化合并成一次。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 27 种 |
| 下行消息 | 6 种 |
| 处理代码 | `packages/web/src/server.ts` 第 2035–2056、2057–2065、2066–2068、2069–2079、2080–2082、2083–2085、2086–2088、2089–2091、2092–2094、2095–2097、2098–2100、2101–2110、2111–2115、2116–2118、2119–2121、2122–2127、2128–2132、2133–2135、2136–2138、2139–2147、2148–2160、2161–2168、2169–2171、2172–2187、2188–2192、2193–2195、3065–3069 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `prompt`

在当前会话里发一句话给 Agent，开始一次运行。`text` 和 `images` 至少要有一样。

| 项目 | 内容 |
| --- | --- |
| 字段 | `text`：string；`streamingBehavior`（可选）："steer" | "followUp"；`images`（可选）：ImageContent[]；`notify`（可选）：boolean；`attachModelIds`（可选）：string[] |
| 回复请求方 | `error` |
| 广播 | `environment`、`snapshot` |
| 失败文案 | `消息不能为空`、`环境检查未通过`、`Docker 环境不可用（{detail}）。请在「设置 → 环境」中修复后复检。`、`请先创建或选择一个项目`、`会话尚未就绪，请重新选择项目`、`正在压缩上下文，暂时不能发送；可等待压缩完成，或点「中止压缩」放弃这次压缩`、`Session not initialized`、`Agent 正在运行，请先中止再压缩上下文`、`当前会话内容太少，无需压缩`、`该会话已经压缩过，无需重复压缩` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `environment`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "prompt",
	"text": "示例文本",
	"streamingBehavior": "steer",
	"images": [
		{
			"type": "image",
			"data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
			"mimeType": "image/png"
		}
	],
	"notify": false,
	"attachModelIds": [
		"attach-model-1"
	]
}
```

### `compact`

把当前会话压缩成摘要，释放上下文。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `error` |
| 广播 | `snapshot` |
| 失败文案 | `环境检查未通过`、`Docker 环境不可用（{detail}）。请在「设置 → 环境」中修复后复检。`、`Session not initialized`、`Agent 正在运行，请先中止再压缩上下文`、`当前会话内容太少，无需压缩`、`该会话已经压缩过，无需重复压缩` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "compact"
}
```

### `set_thinking_level`

设置当前会话的思考等级，只对这个会话生效。

| 项目 | 内容 |
| --- | --- |
| 字段 | `level`：ThinkingLevel |
| 回复请求方 | 无 |
| 广播 | `snapshot` |
| 失败文案 | `Session not initialized`、`当前模型不支持思考等级「{level}」` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "set_thinking_level",
	"level": "low"
}
```

### `start_goal`

为当前会话启动一个持续目标：一轮结束后自动续跑，直到达成或触发熔断。只在自动执行或 AI 审批模式下可用。

| 项目 | 内容 |
| --- | --- |
| 字段 | `objective`：string；`criteria`（可选）：string[]。One criterion per line; empty means the operator left them out.；`roundLimit`：number |
| 回复请求方 | `error` |
| 广播 | `environment`、`snapshot` |
| 失败文案 | `环境检查未通过`、`Docker 环境不可用（{detail}）。请在「设置 → 环境」中修复后复检。`、`请先创建或选择一个项目`、`会话尚未就绪，请重新选择项目`、`持续目标只在自动执行或 AI 审批模式下可用：审批模式下命令要等人放行`、`Agent 正在运行，请先中止或等本轮结束再启动目标`、`目标不能为空`、`当前会话已有未结束的目标，请先在目标条上继续或清除它` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `environment`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "start_goal",
	"objective": "示例文本",
	"criteria": [
		"text"
	],
	"roundLimit": 3
}
```

### `pause_goal`

暂停持续目标，保留进度。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | 无 |
| 广播 | 无 |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。

```json
{
	"type": "pause_goal"
}
```

### `resume_goal`

继续已暂停的持续目标，可以追加续跑轮数的上限。

| 项目 | 内容 |
| --- | --- |
| 字段 | `extraRounds`（可选）：number |
| 回复请求方 | 无 |
| 广播 | `snapshot` |
| 失败文案 | `当前会话没有持续目标`、`目标已完成，请清除后新建目标`、`持续目标只在自动执行或 AI 审批模式下可用：请先切到非审批模式`、`Agent 正在运行，请先中止再继续目标` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "resume_goal",
	"extraRounds": 2
}
```

### `clear_goal`

清除当前会话的持续目标。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | 无 |
| 广播 | `snapshot` |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "clear_goal"
}
```

### `abort`

中止当前会话正在进行的运行。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | 无 |
| 广播 | 无 |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。

```json
{
	"type": "abort"
}
```

### `abort_compaction`

放弃正在进行的上下文压缩。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | 无 |
| 广播 | `snapshot` |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "abort_compaction"
}
```

### `set_mode`

设置当前会话的命令门模式：审批、AI 审批或自动执行。

| 项目 | 内容 |
| --- | --- |
| 字段 | `mode`：SentinelMode | null |
| 回复请求方 | 无 |
| 广播 | `snapshot` |
| 失败文案 | `会话尚未就绪，请重新选择项目`、`未配置守门模型：请在 设置 → 模型 给「守门模型」选一条模型（或让它跟随主模型）后再切到 AI 审批` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "set_mode",
	"mode": "review"
}
```

### `set_global_mode`

设置新会话默认使用的命令门模式。

| 项目 | 内容 |
| --- | --- |
| 字段 | `mode`：SentinelMode |
| 回复请求方 | 无 |
| 广播 | `snapshot` |
| 失败文案 | `未配置守门模型：请在 设置 → 模型 给「守门模型」选一条模型（或让它跟随主模型）后再切到 AI 审批` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "set_global_mode",
	"mode": "review"
}
```

### `decide`

对一条待审批的命令作出决定：批准、改写后批准，或拒绝。

| 项目 | 内容 |
| --- | --- |
| 字段 | `decision`：{ id: string; approved: boolean; command?: string; alwaysAllowPrefix?: boolean } |
| 回复请求方 | `error` |
| 广播 | 无 |
| 失败文案 | `该审批请求已失效（可能已被其他窗口处理或运行已中止）` |

这条消息没有成功时的直接回复。

```json
{
	"type": "decide",
	"decision": {
		"id": "id-1",
		"approved": true,
		"command": "curl -s https://example.com/",
		"alwaysAllowPrefix": false
	}
}
```

### `decide_all`

对所有待审批的命令一次性批准或拒绝。

| 项目 | 内容 |
| --- | --- |
| 字段 | `approved`：boolean |
| 回复请求方 | `error` |
| 广播 | 无 |
| 失败文案 | `没有待处理的审批请求` |

这条消息没有成功时的直接回复。

```json
{
	"type": "decide_all",
	"approved": true
}
```

### `allow_prefix`

把一个命令前缀加入本会话的白名单，之后以它开头的命令不再弹审批。

| 项目 | 内容 |
| --- | --- |
| 字段 | `prefix`：string |
| 回复请求方 | 无 |
| 广播 | 无 |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。

```json
{
	"type": "allow_prefix",
	"prefix": "text"
}
```

### `remove_allowed_prefix`

把一个命令前缀移出白名单。

| 项目 | 内容 |
| --- | --- |
| 字段 | `prefix`：string |
| 回复请求方 | 无 |
| 广播 | 无 |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。

```json
{
	"type": "remove_allowed_prefix",
	"prefix": "text"
}
```

### `new_session`

新建一个会话并切换过去，可以指定一个预设 Agent。

| 项目 | 内容 |
| --- | --- |
| 字段 | `presetId`（可选）：string |
| 回复请求方 | 无 |
| 广播 | `snapshot`、`sessions`、`session_event` |
| 失败文案 | `该预设不存在`、`该预设已停用`、`没有可用的项目容器，请先创建或选择一个项目` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`、`sessions`、`session_event`；什么都没变时不发。

```json
{
	"type": "new_session"
}
```

### `set_session_preset`

给当前会话换一个预设 Agent。会话正在运行时拒绝。

| 项目 | 内容 |
| --- | --- |
| 字段 | `presetId`：string | null |
| 回复请求方 | 无 |
| 广播 | `snapshot`、`sessions`、`session_event` |
| 失败文案 | `还没有会话，无法设置预设`、`工程任务的会话跟随它的任务，不能单独换预设`、`会话正在运行，请先中止再更换预设`、`该预设不存在`、`该预设已停用` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`、`sessions`、`session_event`；什么都没变时不发。

```json
{
	"type": "set_session_preset",
	"presetId": "preset-1"
}
```

### `switch_session`

切换到指定的会话。

| 项目 | 内容 |
| --- | --- |
| 字段 | `path`：string |
| 回复请求方 | 无 |
| 广播 | `snapshot`、`sessions`、`session_event` |
| 失败文案 | `没有可用的项目容器，请先创建或选择一个项目` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`、`sessions`、`session_event`；什么都没变时不发。

```json
{
	"type": "switch_session",
	"path": "/home/operator/.sentinel/agent/sessions/01933f2c-8a6b-7c1d-9e2f-5b4a3c6d8e0f.jsonl"
}
```

### `list_sessions`

取当前项目的会话列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `sessions` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `sessions` 回给发出消息的连接。

```json
{
	"type": "list_sessions"
}
```

### `rename_session`

给会话改名。

| 项目 | 内容 |
| --- | --- |
| 字段 | `path`：string；`name`：string |
| 回复请求方 | `error` |
| 广播 | `sessions` |
| 失败文案 | `会话名称不能为空`、`路径不在受管的会话目录内，已拒绝该操作` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `sessions`。

```json
{
	"type": "rename_session",
	"path": "/home/operator/.sentinel/agent/sessions/01933f2c-8a6b-7c1d-9e2f-5b4a3c6d8e0f.jsonl",
	"name": "示例文本"
}
```

### `set_session_status`

给会话标一个状态（待跟进、进行中、已完成、已忽略）。这只是操作员自己的备忘，模型看不到。

| 项目 | 内容 |
| --- | --- |
| 字段 | `path`（可选）：string；`status`：SentinelSessionStatus | null |
| 回复请求方 | `error` |
| 广播 | `sessions`、`snapshot` |
| 失败文案 | `没有活动会话`、`路径不在受管的会话目录内，已拒绝该操作` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `sessions`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "set_session_status",
	"path": "/home/operator/.sentinel/agent/sessions/01933f2c-8a6b-7c1d-9e2f-5b4a3c6d8e0f.jsonl",
	"status": "done"
}
```

### `delete_session`

删除一个会话。

| 项目 | 内容 |
| --- | --- |
| 字段 | `path`：string |
| 回复请求方 | 无 |
| 广播 | `sessions` |
| 失败文案 | `该会话正在运行，请先中止再删除`、`会话文件不存在（可能已被删除）`、`路径不在受管的会话目录内，已拒绝该操作` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `sessions`。

```json
{
	"type": "delete_session",
	"path": "/home/operator/.sentinel/agent/sessions/01933f2c-8a6b-7c1d-9e2f-5b4a3c6d8e0f.jsonl"
}
```

### `navigate`

在会话树里跳到指定的记录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `entryId`：string；`summarize`（可选）：boolean |
| 回复请求方 | 无 |
| 广播 | `snapshot` |
| 失败文案 | `Session not initialized` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "navigate",
	"entryId": "entry-1",
	"summarize": false
}
```

### `rename_branch`

给会话树里的一个分支改名。

| 项目 | 内容 |
| --- | --- |
| 字段 | `entryId`：string；`label`：string |
| 回复请求方 | `error` |
| 广播 | `tree` |
| 失败文案 | `Session not initialized`、`分支名称不能为空` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `tree`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "rename_branch",
	"entryId": "entry-1",
	"label": "示例文本"
}
```

### `get_tree`

取当前会话的树、当前位置和可分叉的点。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `tree` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `tree` 回给发出消息的连接。

```json
{
	"type": "get_tree"
}
```

### `get_state`

取完整状态的快照。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `snapshot` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `snapshot` 回给发出消息的连接。

```json
{
	"type": "get_state"
}
```

### `get_stats`

取用量统计：本次会话的 token 与费用，以及累计用量。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `stats` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `stats` 回给发出消息的连接。

```json
{
	"type": "get_stats"
}
```

## 下行消息（服务端 → 浏览器）

### `snapshot`

完整状态：当前项目、模式、模型、会话内容和待审批的命令。

| 项目 | 内容 |
| --- | --- |
| 字段 | `snapshot`：SentinelStateSnapshot |
| 发送时机 | 回复 `get_state` 时，只发给发出消息的连接；连接建立时发给新连接；状态每次变化都安排一次广播，100 毫秒内的多次变化合并成一次 |

```json
{
	"type": "snapshot",
	"snapshot": {
		"mode": "review",
		"streaming": true,
		"cwd": "/work",
		"project": {
			"id": "id-1",
			"name": "示例文本",
			"cwd": "/work",
			"storage": {
				"bytes": 2,
				"hostBytes": 2,
				"containerBytes": 2,
				"partial": true,
				"measuredAt": 1763973000000
			},
			"container": "sentinel-project-1",
			"sessionCount": 2,
			"state": "missing",
			"manualStop": false,
			"vulnCount": 2,
			"assetCount": 2,
			"gateCount": 2,
			"proxyName": "示例文本",
			"proxyNode": "text",
			"proxyNodeName": "示例文本"
		},
		"model": {
			"provider": "openai",
			"id": "id-1"
		},
		"modelConfigured": true,
		"thinkingLevel": "low",
		"availableThinkingLevels": [
			"low"
		],
		"activeSessionId": "active-session-1",
		"messages": [],
		"pendingApprovals": [
			{
				"id": "id-1",
				"command": "curl -s https://example.com/",
				"cwd": "/work"
			}
		],
		"allowedPrefixes": [
			"text"
		],
		"runningSessions": [
			"text"
		],
		"subagents": [
			{
				"id": "id-1",
				"sessionId": "session-1",
				"task": "text",
				"status": "done",
				"turns": 2,
				"startedAt": "2026-11-24T08:30:00.000Z"
			}
		],
		"subagentTotal": 2,
		"goal": {
			"usage": {
				"input": 2,
				"output": 2,
				"total": 2,
				"cost": 0.0125
			},
			"subagent": {
				"runs": 2,
				"turns": 2
			},
			"running": true,
			"id": "id-1",
			"objective": "示例文本",
			"criteria": [
				"text"
			],
			"roundLimit": 3,
			"roundsUsed": 2,
			"noProgressStreak": 2,
			"blockerStreak": 2,
			"status": "completed",
			"pauseReason": "manual",
			"pauseNote": "示例文本",
			"baseline": {
				"input": 2,
				"output": 2,
				"total": 2,
				"cost": 0.0125
			},
			"progress": {
				"done": [
					"text"
				],
				"todo": [
					"text"
				],
				"blockers": [
					"text"
				]
			},
			"rounds": [
				{
					"index": 2,
					"kind": "continue",
					"startedAt": 1763973000000,
					"toolCalls": 2
				}
			],
			"lastBlocker": "text",
			"submitted": 2,
			"completion": {
				"summary": "示例文本",
				"evidence": [
					"text"
				],
				"submitted": 2,
				"findingsNote": "示例文本",
				"criteria": [
					{
						"criterion": "text",
						"met": true,
						"evidence": "text"
					}
				],
				"at": 1763973000000
			},
			"blocked": {
				"reason": "示例错误信息",
				"evidence": [
					"text"
				],
				"streak": 2,
				"at": 1763973000000
			},
			"createdAt": 1763973000000,
			"startedAt": 1763973000000,
			"endedAt": 1763973000000,
			"updatedAt": 1763973000000
		},
		"sessionStatus": "done",
		"preset": {
			"id": "id-1",
			"name": "示例文本",
			"missing": true,
			"placeholder": "text"
		},
		"modeling": {
			"runId": "run-1",
			"title": "示例文本",
			"target": "text",
			"startedAt": "2026-11-24T08:30:00.000Z",
			"pathCount": 2,
			"operationCount": 2,
			"entityCount": 2
		},
		"modelingAttached": [
			{
				"id": "id-1",
				"title": "示例文本"
			}
		],
		"gatekeeper": {
			"globalMode": "review",
			"sessionMode": "review",
			"sessionOverride": "review",
			"judgeResolved": {
				"entryId": "entry-1",
				"entryName": "示例文本",
				"modelId": "model-1",
				"followedMain": true
			},
			"failures": 2,
			"lastFailureAt": 1763973000000,
			"lastSuccessAt": 1763973000000,
			"lastError": "示例错误信息"
		},
		"compacting": true,
		"compactionStartedAt": 1763973000000,
		"droidEnabled": true,
		"iosEnabled": true,
		"credentialsEnabled": true,
		"reportsEnabled": true,
		"reportTemplate": {
			"name": "示例文本",
			"id": "id-1",
			"revision": "text"
		},
		"supervisor": {
			"sessionId": "session-1",
			"sessionPath": "/work/evidence/notes.md",
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
		},
		"supervisorConfig": {
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
}
```

### `session_event`

Agent 运行时的一条事件：消息的增量、工具调用的开始与结束、轮次和压缩等。

| 项目 | 内容 |
| --- | --- |
| 字段 | `event`：AgentSessionEvent |
| 发送时机 | 运行时钩子 `onSessionEvent` 触发时广播 |

```json
{
	"type": "session_event",
	"event": {
		"type": "agent_start"
	}
}
```

### `sessions`

当前项目的会话列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `sessions`：SentinelSessionListEntry[] |
| 发送时机 | 由 `broadcastSessions` 发送：回复 `list_sessions` 时只发给发出消息的连接；会话列表变化时广播 |

```json
{
	"type": "sessions",
	"sessions": [
		{
			"status": "done",
			"engine": {
				"engineId": "engine-1",
				"engineName": "示例文本",
				"taskStatus": "text"
			},
			"name": "示例文本",
			"id": "id-1",
			"path": "/home/operator/.sentinel/agent/sessions/01933f2c-8a6b-7c1d-9e2f-5b4a3c6d8e0f.jsonl",
			"created": "2026-11-24T08:30:00.000Z",
			"cwd": "/work",
			"parentSessionPath": "/home/operator/.sentinel/agent/sessions/01933f2c-8a6b-7c1d-9e2f-5b4a3c6d8e0f.jsonl",
			"modified": "2026-11-24T08:30:00.000Z",
			"messageCount": 2,
			"firstMessage": "示例文本"
		}
	]
}
```

### `tree`

会话树、当前位置和可分叉的点。

| 项目 | 内容 |
| --- | --- |
| 字段 | `tree`：SessionTreeNode[]；`leafId`：string | null；`forkPoints`：SentinelForkPoint[] |
| 发送时机 | 回复 `get_tree` 时，只发给发出消息的连接；处理 `rename_branch` 时广播 |

```json
{
	"type": "tree",
	"tree": [
		{
			"entry": {
				"type": "message",
				"message": {
					"role": "assistant",
					"content": [
						{
							"type": "text",
							"text": "示例文本"
						}
					],
					"api": "openai-completions",
					"provider": "openai",
					"model": "text",
					"usage": {
						"input": 2,
						"output": 2,
						"cacheRead": 2,
						"cacheWrite": 2,
						"totalTokens": 2,
						"cost": {
							"input": 2,
							"output": 2,
							"cacheRead": 2,
							"cacheWrite": 2,
							"total": 2
						}
					},
					"stopReason": "length",
					"timestamp": 1763973000000
				},
				"id": "id-1",
				"parentId": "parent-1",
				"timestamp": "2026-11-24T08:30:00.000Z"
			},
			"children": [
				{
					"entry": {
						"type": "message",
						"message": {
							"role": "assistant",
							"content": [
								{
									"type": "text",
									"text": "示例文本"
								}
							],
							"api": "openai-completions",
							"provider": "openai",
							"model": "text",
							"usage": {
								"input": 2,
								"output": 2,
								"cacheRead": 2,
								"cacheWrite": 2,
								"totalTokens": 2,
								"cost": {
									"input": 2,
									"output": 2,
									"cacheRead": 2,
									"cacheWrite": 2,
									"total": 2
								}
							},
							"stopReason": "length",
							"timestamp": 1763973000000
						},
						"id": "id-1",
						"parentId": "parent-1",
						"timestamp": "2026-11-24T08:30:00.000Z"
					},
					"children": [
						{
							"entry": {
								"type": "message",
								"message": {
									"role": "assistant",
									"content": [
										{
											"type": "text",
											"text": "示例文本"
										}
									],
									"api": "openai-completions",
									"provider": "openai",
									"model": "text",
									"usage": {
										"input": 2,
										"output": 2,
										"cacheRead": 2,
										"cacheWrite": 2,
										"totalTokens": 2,
										"cost": {
											"input": 2,
											"output": 2,
											"cacheRead": 2,
											"cacheWrite": 2,
											"total": 2
										}
									},
									"stopReason": "length",
									"timestamp": 1763973000000
								},
								"id": "id-1",
								"parentId": "parent-1",
								"timestamp": "2026-11-24T08:30:00.000Z"
							},
							"children": [
								{
									"entry": {
										"type": "message",
										"message": {
											"role": "assistant",
											"content": [],
											"api": "openai-completions",
											"provider": "openai",
											"model": "text",
											"usage": {
												"input": 2,
												"output": 2,
												"cacheRead": 2,
												"cacheWrite": 2,
												"totalTokens": 2,
												"cost": {
													"input": 2,
													"output": 2,
													"cacheRead": 2,
													"cacheWrite": 2,
													"total": 2
												}
											},
											"stopReason": "length",
											"timestamp": 1763973000000
										},
										"id": "id-1",
										"parentId": "parent-1",
										"timestamp": "2026-11-24T08:30:00.000Z"
									},
									"children": [
										{
											"entry": {
												"type": "message",
												"message": {
													"role": "assistant",
													"content": [],
													"api": "openai-completions",
													"provider": "openai",
													"model": "text",
													"usage": {
														"input": 2,
														"output": 2,
														"cacheRead": 2,
														"cacheWrite": 2,
														"totalTokens": 2,
														"cost": {
															"input": 2,
															"output": 2,
															"cacheRead": 2,
															"cacheWrite": 2,
															"total": 2
														}
													},
													"stopReason": "length",
													"timestamp": 1763973000000
												},
												"id": "id-1",
												"parentId": "parent-1",
												"timestamp": "2026-11-24T08:30:00.000Z"
											},
											"children": []
										}
									]
								}
							]
						}
					]
				}
			],
			"label": "示例文本",
			"labelTimestamp": "2026-11-24T08:30:00.000Z"
		}
	],
	"leafId": "leaf-1",
	"forkPoints": [
		{
			"entryId": "entry-1",
			"text": "示例文本"
		}
	]
}
```

### `stats`

用量统计：本次会话的 token 与费用，以及累计用量。

| 项目 | 内容 |
| --- | --- |
| 字段 | `stats`：SentinelStats |
| 发送时机 | 回复 `get_stats` 时，只发给发出消息的连接 |

```json
{
	"type": "stats",
	"stats": {
		"sessionFile": "notes.md",
		"sessionId": "session-1",
		"userMessages": 2,
		"assistantMessages": 2,
		"toolCalls": 2,
		"toolResults": 2,
		"totalMessages": 2,
		"tokens": {
			"input": 2,
			"output": 2,
			"cacheRead": 2,
			"cacheWrite": 2,
			"total": 2
		},
		"cost": 0.0125,
		"contextUsage": {
			"tokens": 2,
			"contextWindow": 128000,
			"percent": 35
		},
		"cumulative": {
			"cost": 0.0125,
			"tokens": {
				"input": 2,
				"output": 2,
				"cacheRead": 2,
				"cacheWrite": 2,
				"total": 2
			}
		}
	}
}
```

### `gate_decision`

一条守门判定记录：哪条命令、谁放行、理由和耗时。

| 项目 | 内容 |
| --- | --- |
| 字段 | `decision`：SentinelGateDecision |
| 发送时机 | 运行时钩子 `onGateDecision` 触发时广播 |

```json
{
	"type": "gate_decision",
	"decision": {
		"id": "id-1",
		"at": 1763973000000,
		"projectId": "project-1",
		"projectName": "示例文本",
		"sessionId": "session-1",
		"source": "text",
		"tool": "text",
		"command": "curl -s https://example.com/",
		"commandTruncated": false,
		"cwd": "/work",
		"approval": "ai",
		"decision": "block",
		"reason": "示例错误信息",
		"latencyMs": 1250,
		"model": "text",
		"modelFrom": "text",
		"inputTokens": 2,
		"outputTokens": 2,
		"totalTokens": 2,
		"error": "示例错误信息"
	}
}
```
