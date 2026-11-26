# 守门配置与守门审计

守门员在 AI 审批模式下判断每条 bash 命令能不能执行。本域管它的配置、端点测试和判定流水（守门审计）。判定失败或超时一律放行并记为「请求失败」，所以守门员掉线时等同于自动执行。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 5 种 |
| 下行消息 | 4 种 |
| 处理代码 | `packages/web/src/server.ts` 第 4505–4507、4508–4515、4516–4520、4521–4525、4526–4534 行 |

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

测试守门模型的端点，也就是「角色分配 → 守门模型」当前指向的那条模型。两种测法：

- 不带 `concurrency`：做一次连通性检查。用一条很短的提示词，只要求回 `ALLOW`，回复里带 `raw`。
- 带 `concurrency`：同时发出那么多次真实判定，回复里带 `load`。每次用正式的守门提示词判定同一条固定的扫描命令 `nmap -sV -p 1-1000 target`，在守门设置的判定超时之内返回可解析的 `ALLOW` 或 `BLOCK` 才算成功。全部成功才算通过；有一次没成功，`result.ok` 就是 `false`，`result.detail` 是「您配置的模型可能无法成功进行 AI 审批守门」。`concurrency` 取 1 到 20 的整数，超出按 20；界面上的「并发测试」发的是 10。

两种测试都不写审计记录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `concurrency`（可选）：number，同时发出的判定次数 |
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

守门模型端点的测试结果：一次连通性检查的，或者一次并发测试的。

| 项目 | 内容 |
| --- | --- |
| 字段 | `result`：SentinelTestResult；`raw`（可选）：string，只在不带 `concurrency` 的测试里，是模型那一行原始回复；`load`（可选）：SentinelJudgeLoadReport，只在带 `concurrency` 的测试里。`load.concurrency` 是同时发出的次数，`load.succeeded` 是成功的次数，`load.latencyMs`（可选）是成功那几次的最小值、中位数、平均值和最大值，单位毫秒，一次都没成功时没有，`load.failures` 是每次失败的原因 |
| 发送时机 | 回复 `test_judge` 时，只发给发出消息的连接 |

下面是并发测试通过时的样子。没通过时 `ok` 是 `false`，`message` 是「守门模型并发测试未通过」，`detail` 是「您配置的模型可能无法成功进行 AI 审批守门」，`failures` 里逐条写着原因，例如「守门判定超时（15000ms）」。

```json
{
	"type": "judge_test_result",
	"result": {
		"ok": true,
		"message": "守门模型并发测试通过"
	},
	"load": {
		"concurrency": 10,
		"succeeded": 10,
		"latencyMs": {
			"min": 812,
			"median": 1402,
			"avg": 1518,
			"max": 2930
		},
		"failures": []
	}
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
