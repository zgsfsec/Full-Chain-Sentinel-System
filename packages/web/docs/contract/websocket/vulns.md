# 漏洞

Agent 用工具提交漏洞，操作员在控制台复核。代理只能提交和查询；确认、改级、改分、标误报和备注都只能由操作员做，每次改动追加到时间线。记录属于会话创建时的项目，绑定在当前项目下。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 8 种 |
| 下行消息 | 7 种 |
| 处理代码 | `packages/web/src/server.ts` 第 3437–3441、3442–3450、3451–3466、3467–3480、3481–3491、3492–3497、3498–3506、3507–3511 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `list_vulns`

按条件列出当前项目的漏洞。

| 项目 | 内容 |
| --- | --- |
| 字段 | `filters`（可选）：SentinelVulnFilters |
| 回复请求方 | `vulns` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `vulns` 回给发出消息的连接。

```json
{
	"type": "list_vulns",
	"filters": {
		"ids": [
			"id-1"
		],
		"status": "fixed",
		"severity": [
			"low"
		],
		"target": "text",
		"search": "text",
		"dubious": false
	}
}
```

### `get_vuln`

取一条漏洞记录的详情。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error`、`vuln` |
| 广播 | 无 |
| 失败文案 | `该漏洞记录不存在（可能属于其他项目，或已被删除）` |

处理的结果通过 `vuln` 回给发出消息的连接。

```json
{
	"type": "get_vuln",
	"id": "id-1"
}
```

### `update_vuln`

复核一条漏洞：确认、改等级、改 CVSS、标误报、写备注。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`patch`：SentinelVulnUpdate |
| 回复请求方 | `vuln_result`、`vuln` |
| 广播 | `vulns` |
| 失败文案 | 无 |

处理的结果通过 `vuln_result`、`vuln` 回给发出消息的连接。状态实际发生变化时，还会向所有控制台广播 `vulns`；什么都没变时不发。失败不回 `error`，而是回 `vuln_result`，其中 `ok` 为 `false`，`error` 是：`该漏洞记录不存在（可能属于其他项目，或已被删除）`。

```json
{
	"type": "update_vuln",
	"id": "id-1",
	"patch": {
		"status": "fixed",
		"severity": "low",
		"cvss": 2,
		"note": "示例文本"
	}
}
```

### `retry_vuln_review`

让评审模型重新评审一条漏洞。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`force`（可选）：boolean |
| 回复请求方 | `error`、`vuln_review_result` |
| 广播 | 无 |
| 失败文案 | `未配置配置目录，无法评审` |

处理的结果通过 `vuln_review_result` 回给发出消息的连接。失败的原因写在结果消息的 `error` 字段里：`该记录正在评审中`、`该记录无法重试（未评审失败、正在评审中，或已被操作员处理）`。

```json
{
	"type": "retry_vuln_review",
	"id": "id-1",
	"force": false
}
```

### `review_pending_vulns`

让评审模型处理所有待评审的漏洞。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `error` |
| 广播 | `vulns` |
| 失败文案 | `未配置配置目录，无法评审` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `vulns`。

```json
{
	"type": "review_pending_vulns"
}
```

### `preview_vuln_delete`

预览删除若干条漏洞会影响什么。

| 项目 | 内容 |
| --- | --- |
| 字段 | `ids`：string[] |
| 回复请求方 | `vuln_delete_preview` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `vuln_delete_preview` 回给发出消息的连接。

```json
{
	"type": "preview_vuln_delete",
	"ids": [
		"id-1"
	]
}
```

### `delete_vulns`

删除若干条漏洞。

| 项目 | 内容 |
| --- | --- |
| 字段 | `ids`：string[] |
| 回复请求方 | `vulns_deleted` |
| 广播 | `vulns` |
| 失败文案 | 无 |

处理的结果通过 `vulns_deleted` 回给发出消息的连接。状态实际发生变化时，还会向所有控制台广播 `vulns`；什么都没变时不发。

```json
{
	"type": "delete_vulns",
	"ids": [
		"id-1"
	]
}
```

### `export_vulns`

把当前筛选出的漏洞导出成 Markdown 报告。

| 项目 | 内容 |
| --- | --- |
| 字段 | `filters`（可选）：SentinelVulnFilters |
| 回复请求方 | `vulns_export` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `vulns_export` 回给发出消息的连接。

```json
{
	"type": "export_vulns",
	"filters": {
		"ids": [
			"id-1"
		],
		"status": "fixed",
		"severity": [
			"low"
		],
		"target": "text",
		"search": "text",
		"dubious": false
	}
}
```

## 下行消息（服务端 → 浏览器）

### `vulns`

漏洞列表。`unfiltered` 为 `true` 表示这是广播的完整列表，不是按筛选条件查出来的。

| 项目 | 内容 |
| --- | --- |
| 字段 | `items`：SentinelVulnSummary[]；`stats`：SentinelVulnStats；`unfiltered`（可选）：true |
| 发送时机 | 回复 `list_vulns` 时，只发给发出消息的连接；由 `broadcastVulns` 发送 |

```json
{
	"type": "vulns",
	"items": [
		{
			"number": 2,
			"description": "nmap -sV -p 443 example.com",
			"status": "fixed",
			"source": "text",
			"id": "id-1",
			"projectId": "project-1",
			"target": "text",
			"title": "示例文本",
			"label": "示例文本",
			"createdAt": "2026-11-24T08:30:00.000Z",
			"updatedAt": "text",
			"review": {
				"state": "done",
				"at": 1763973000000
			},
			"projectName": "示例文本",
			"sessionName": "示例文本",
			"assetLabel": "示例文本",
			"severity": "low",
			"cvss": 2,
			"cvssVector": "text",
			"category": "text",
			"platform": "android",
			"appPackage": "text",
			"appVersion": "text",
			"repro": "text",
			"remediation": "text",
			"references": [
				"text"
			],
			"severityMismatch": true
		}
	],
	"stats": {
		"total": 2,
		"bySeverity": {
			"low": 2,
			"high": 2,
			"info": 2,
			"medium": 2,
			"critical": 2
		},
		"byStatus": {
			"fixed": 2,
			"pending": 2,
			"confirmed": 2,
			"false_positive": 2
		}
	},
	"unfiltered": true
}
```

### `vuln`

一条漏洞记录的详情。

| 项目 | 内容 |
| --- | --- |
| 字段 | `vuln`：SentinelVulnerability |
| 发送时机 | 回复 `get_vuln`、`update_vuln` 时，只发给发出消息的连接 |

```json
{
	"type": "vuln",
	"vuln": {
		"review": {
			"state": "done",
			"severity": "low",
			"cvss": 2,
			"cvssVector": "text",
			"verdict": "solid",
			"reason": "示例错误信息",
			"model": "text",
			"error": "示例错误信息",
			"agentSeverity": "low",
			"agentCvss": 2,
			"at": 1763973000000
		},
		"id": "id-1",
		"label": "示例文本",
		"number": 2,
		"projectId": "project-1",
		"projectName": "示例文本",
		"sessionName": "示例文本",
		"assetLabel": "示例文本",
		"source": "text",
		"title": "示例文本",
		"severity": "low",
		"cvss": 2,
		"cvssVector": "text",
		"status": "fixed",
		"target": "text",
		"category": "text",
		"platform": "android",
		"appPackage": "text",
		"appVersion": "text",
		"description": "nmap -sV -p 443 example.com",
		"packet": "text",
		"repro": "text",
		"remediation": "text",
		"references": [
			"text"
		],
		"createdAt": "2026-11-24T08:30:00.000Z",
		"updatedAt": "text",
		"evidence": [
			{
				"kind": "file"
			}
		],
		"notes": [
			{
				"at": "2026-11-24T08:30:00.000Z",
				"author": "system",
				"text": "示例文本"
			}
		],
		"severityMismatch": true
	}
}
```

### `vuln_result`

一次漏洞复核操作的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `action`：string；`id`（可选）：string；`ok`：boolean；`error`（可选）：string |
| 发送时机 | 回复 `update_vuln` 时，只发给发出消息的连接 |

```json
{
	"type": "vuln_result",
	"action": "text",
	"ok": true,
	"error": "示例错误信息"
}
```

### `vuln_review_result`

评审模型对一条漏洞的评审结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`ok`：boolean；`error`（可选）：string |
| 发送时机 | 回复 `retry_vuln_review` 时，只发给发出消息的连接 |

```json
{
	"type": "vuln_review_result",
	"id": "id-1",
	"ok": true,
	"error": "示例错误信息"
}
```

### `vuln_delete_preview`

删除预览：会删掉多少条记录、多少份证据和多少条备注。

| 项目 | 内容 |
| --- | --- |
| 字段 | `count`：number；`evidence`：number；`notes`：number |
| 发送时机 | 回复 `preview_vuln_delete` 时，只发给发出消息的连接 |

```json
{
	"type": "vuln_delete_preview",
	"count": 2,
	"evidence": 2,
	"notes": 2
}
```

### `vulns_deleted`

删除了多少条漏洞。

| 项目 | 内容 |
| --- | --- |
| 字段 | `count`：number |
| 发送时机 | 回复 `delete_vulns` 时，只发给发出消息的连接 |

```json
{
	"type": "vulns_deleted",
	"count": 2
}
```

### `vulns_export`

导出的 Markdown 报告。

| 项目 | 内容 |
| --- | --- |
| 字段 | `filename`：string；`markdown`：string |
| 发送时机 | 回复 `export_vulns` 时，只发给发出消息的连接 |

```json
{
	"type": "vulns_export",
	"filename": "示例文本",
	"markdown": "text"
}
```
