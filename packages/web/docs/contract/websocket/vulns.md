# 漏洞

Agent 用工具提交漏洞，操作员在控制台复核。代理只能提交和查询；确认、改级、改分、标误报和备注都只能由操作员做，每次改动追加到时间线。记录属于会话创建时的项目，绑定在当前项目下。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 8 种 |
| 下行消息 | 8 种 |
| 处理代码 | `packages/web/src/server.ts` 第 3433–3437、3438–3446、3447–3462、3463–3476、3477–3487、3488–3493、3494–3502、3503–3507 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `list_vulns`

按条件列出当前项目的漏洞，一次一页。页码从 1 开始，默认第 1 页；每页默认 50 条，最多 200 条。筛选、排序和分页都在数据库里做，一页只读出一页的记录。

`withIds` 为 `true` 时回复里多一个 `ids`：符合条件的全部编号，漏洞页用它做「全选筛选结果」。这一项只查编号，不带记录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `filters`（可选）：SentinelVulnFilters；`page`（可选）：number；`pageSize`（可选）：number；`withIds`（可选）：boolean |
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
	},
	"page": 1,
	"pageSize": 50,
	"withIds": false
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
| 广播 | `vulns_changed` |
| 失败文案 | 无 |

处理的结果通过 `vuln_result`、`vuln` 回给发出消息的连接。状态实际发生变化时，还会向所有控制台广播 `vulns_changed`；什么都没变时不发。失败不回 `error`，而是回 `vuln_result`，其中 `ok` 为 `false`，`error` 是：`该漏洞记录不存在（可能属于其他项目，或已被删除）`。

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
| 广播 | `vulns_changed` |
| 失败文案 | `未配置配置目录，无法评审` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `vulns_changed`。

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
| 广播 | `vulns_changed` |
| 失败文案 | 无 |

处理的结果通过 `vulns_deleted` 回给发出消息的连接。状态实际发生变化时，还会向所有控制台广播 `vulns_changed`；什么都没变时不发。

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

漏洞的一页，按编号从新到旧。`total` 是符合筛选条件的总数，不是本页的条数；`hasMore` 表示后面还有页。`ids` 只在请求带了 `withIds` 时出现，是符合条件的全部编号。`stats` 始终是整个项目的计数，不受筛选影响。

| 项目 | 内容 |
| --- | --- |
| 字段 | `items`：SentinelVulnSummary[]；`stats`：SentinelVulnStats；`total`：number；`page`：number；`pageSize`：number；`hasMore`：boolean；`ids`（可选）：string[] |
| 发送时机 | 回复 `list_vulns` 时，只发给发出消息的连接。列表本身不广播 |

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
		"total": 2,
		"page": 1,
		"pageSize": 50,
		"hasMore": false,
		"ids": [
			"id-1"
		]
	}
```
### `vulns_changed`

漏洞发生了变化。列表是分页的，所以变化时只发通知和最新的计数，不发列表：漏洞页收到后按自己的筛选条件和页码重新请求 `list_vulns`。计数随通知一起发，是因为侧栏角标和项目概览要显示它们，而漏洞页不一定开着。

| 项目 | 内容 |
| --- | --- |
| 字段 | `stats`：SentinelVulnStats |
| 发送时机 | 有漏洞被提交、修改、评审或删除后，由 `broadcastVulns` 发给所有连接 |

```json
{
	"type": "vulns_changed",
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
	}
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
