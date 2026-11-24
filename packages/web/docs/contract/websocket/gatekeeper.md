# 守门配置与守门审计

守门员在 AI 审批模式下判断每条 bash 命令能不能执行。本域管它的配置、端点测试和判定流水（守门审计）。判定失败或超时一律放行并记为「请求失败」，所以守门员掉线时等同于自动执行。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 5 种 |
| 下行消息 | 4 种 |
| 处理代码 | `packages/web/src/server.ts` 第 4512–4514、4515–4522、4523–4527、4528–4532、4533–4541 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `get_gatekeeper_config`

取守门配置：全局默认模式、判定超时、并发上限，以及 MCP 工具的放行设置。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `gatekeeper_config` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `gatekeeper_config` 回给发出消息的连接。

```json
{
	"type": "get_gatekeeper_config"
}
```

### `save_gatekeeper_config`

保存守门配置，改完立即生效。

| 项目 | 内容 |
| --- | --- |
| 字段 | `config`：SentinelGatekeeperConfig |
| 回复请求方 | `gatekeeper_config` |
| 广播 | `snapshot` |
| 失败文案 | 无 |

处理的结果通过 `gatekeeper_config` 回给发出消息的连接。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "save_gatekeeper_config",
	"config": {
		"mode": "review",
		"timeoutMs": 1250,
		"concurrency": 2,
		"mcpTools": {
			"enabled": true,
			"includePlugins": true
		}
	}
}
```

### `test_judge`

对守门模型的端点做一次连通性检查。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `judge_test_result` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `judge_test_result` 回给发出消息的连接。

```json
{
	"type": "test_judge"
}
```

### `gate_audit_query`

按条件分页查询守门判定记录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `filter`（可选）：SentinelGateFilter；`page`（可选）：number；`pageSize`（可选）：number |
| 回复请求方 | `gate_audit` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `gate_audit` 回给发出消息的连接。

```json
{
	"type": "gate_audit_query",
	"filter": {
		"decision": "block",
		"source": "text",
		"approval": [
			"ai"
		],
		"search": "text",
		"since": 2
	},
	"page": 1,
	"pageSize": 50
}
```

### `gate_audit_stats`

取守门判定的统计：拦截、放行、请求失败的次数和耗时。

| 项目 | 内容 |
| --- | --- |
| 字段 | `filter`（可选）：SentinelGateFilter |
| 回复请求方 | `gate_audit_stats` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `gate_audit_stats` 回给发出消息的连接。

```json
{
	"type": "gate_audit_stats",
	"filter": {
		"decision": "block",
		"source": "text",
		"approval": [
			"ai"
		],
		"search": "text",
		"since": 2
	}
}
```

## 下行消息（服务端 → 浏览器）

### `gatekeeper_config`

守门配置。

| 项目 | 内容 |
| --- | --- |
| 字段 | `config`：SentinelGatekeeperConfig |
| 发送时机 | 回复 `get_gatekeeper_config`、`save_gatekeeper_config` 时，只发给发出消息的连接；连接建立时发给新连接 |

```json
{
	"type": "gatekeeper_config",
	"config": {
		"mode": "review",
		"timeoutMs": 1250,
		"concurrency": 2,
		"mcpTools": {
			"enabled": true,
			"includePlugins": true
		}
	}
}
```

### `judge_test_result`

守门判定端点的测试结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `result`：SentinelTestResult；`raw`（可选）：string。The raw one-line answer, when a judgment actually came back. |
| 发送时机 | 回复 `test_judge` 时，只发给发出消息的连接 |

```json
{
	"type": "judge_test_result",
	"result": {
		"ok": true,
		"message": "示例文本",
		"detail": "示例文本"
	},
	"raw": "text"
}
```

### `gate_audit`

守门判定记录的一页。

| 项目 | 内容 |
| --- | --- |
| 字段 | `page`：SentinelGatePage |
| 发送时机 | 回复 `gate_audit_query` 时，只发给发出消息的连接 |

```json
{
	"type": "gate_audit",
	"page": {
		"items": [
			{
				"id": "id-1",
				"at": 1763973000000,
				"projectId": "project-1",
				"projectName": "示例文本",
				"sessionId": "session-1",
				"source": "text",
				"tool": "text",
				"command": "curl -s https://example.com/",
				"cwd": "/work",
				"approval": "ai",
				"decision": "block",
				"latencyMs": 1250
			}
		],
		"total": 2,
		"page": 1,
		"pageSize": 50
	}
}
```

### `gate_audit_stats`

守门判定的统计和各标签页的数量。

| 项目 | 内容 |
| --- | --- |
| 字段 | `stats`：SentinelGateStats；`tabCounts`：Record<SentinelGateApproval, number> |
| 发送时机 | 回复 `gate_audit_stats` 时，只发给发出消息的连接 |

```json
{
	"type": "gate_audit_stats",
	"stats": {
		"total": 2,
		"byDecision": {
			"failed": 2,
			"block": 2,
			"allow": 2
		},
		"byApproval": {
			"auto": 2,
			"ai": 2,
			"human": 2
		},
		"blockRate": 2,
		"avgLatencyMs": 1250,
		"totalTokens": 2,
		"last24h": 2,
		"failures": 2,
		"lastFailureAt": 1763973000000,
		"lastSuccessAt": 1763973000000,
		"lastError": "示例错误信息"
	},
	"tabCounts": {
		"auto": 2,
		"ai": 2,
		"human": 2
	}
}
```
