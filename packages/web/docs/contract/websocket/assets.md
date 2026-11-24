# 资产库

资产库按项目归并域名、IP、服务和 URL，维护标签、测试记录和关联的漏洞。Agent 上报不发起任何外部请求。列表和详情里的漏洞记录带 `platform`、`appPackage`、`appVersion` 三个字段，见 [type-alignment.md](type-alignment.md)。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 6 种 |
| 下行消息 | 7 种 |
| 处理代码 | `packages/web/src/server.ts` 第 3512–3524、3525–3533、3534–3559、3560–3563、3564–3568、3569–3573 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `list_assets`

按条件列出当前项目的资产。

| 项目 | 内容 |
| --- | --- |
| 字段 | `filters`（可选）：SentinelAssetFilters；`page`（可选）：number；`pageSize`（可选）：number |
| 回复请求方 | `assets` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `assets` 回给发出消息的连接。

```json
{
	"type": "list_assets",
	"filters": {
		"remark": "text",
		"kind": "url",
		"status": "pending",
		"tested": false,
		"search": "text"
	},
	"page": 1,
	"pageSize": 50
}
```

### `get_asset`

取一条资产的详情。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error`、`asset` |
| 广播 | 无 |
| 失败文案 | `该资产不存在（可能属于其他项目，或已被删除）` |

处理的结果通过 `asset` 回给发出消息的连接。

```json
{
	"type": "get_asset",
	"id": "id-1"
}
```

### `update_asset`

修改一条资产：状态、标签，或者追加一条测试记录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`patch`：SentinelAssetUpdate |
| 回复请求方 | `asset_result`、`asset` |
| 广播 | `assets_changed` |
| 失败文案 | 无 |

处理的结果通过 `asset_result`、`asset` 回给发出消息的连接。状态实际发生变化时，还会向所有控制台广播 `assets_changed`；什么都没变时不发。失败不回 `error`，而是回 `asset_result`，其中 `ok` 为 `false`，`error` 是：`该资产不存在（可能属于其他项目，或已被删除）`。

```json
{
	"type": "update_asset",
	"id": "id-1",
	"patch": {
		"status": "pending",
		"tags": [
			"text"
		],
		"outcome": "clean",
		"note": "示例文本"
	}
}
```

### `preview_asset_delete`

预览删除若干条资产会影响什么。

| 项目 | 内容 |
| --- | --- |
| 字段 | `ids`：string[] |
| 回复请求方 | `asset_delete_preview` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `asset_delete_preview` 回给发出消息的连接。

```json
{
	"type": "preview_asset_delete",
	"ids": [
		"id-1"
	]
}
```

### `delete_assets`

删除若干条资产。

| 项目 | 内容 |
| --- | --- |
| 字段 | `ids`：string[] |
| 回复请求方 | `assets_deleted` |
| 广播 | `assets_changed`、`vulns` |
| 失败文案 | 无 |

处理的结果通过 `assets_deleted` 回给发出消息的连接。状态实际发生变化时，还会向所有控制台广播 `assets_changed`、`vulns`；什么都没变时不发。

```json
{
	"type": "delete_assets",
	"ids": [
		"id-1"
	]
}
```

### `export_assets`

把当前筛选出的资产导出成 Markdown。

| 项目 | 内容 |
| --- | --- |
| 字段 | `filters`（可选）：SentinelAssetFilters |
| 回复请求方 | `assets_export` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `assets_export` 回给发出消息的连接。

```json
{
	"type": "export_assets",
	"filters": {
		"remark": "text",
		"kind": "url",
		"status": "pending",
		"tested": false,
		"search": "text"
	}
}
```

## 下行消息（服务端 → 浏览器）

### `assets`

资产列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `items`：SentinelAssetSummary[]；`stats`：SentinelAssetStats；`total`：number。Matches for the current filter, not the page size.；`page`：number；`pageSize`：number；`hasMore`：boolean |
| 发送时机 | 回复 `list_assets` 时，只发给发出消息的连接 |

```json
{
	"type": "assets",
	"items": [
		{
			"remark": "text",
			"id": "id-1",
			"label": "示例文本",
			"number": 2,
			"projectId": "project-1",
			"projectName": "示例文本",
			"kind": "url",
			"name": "示例文本",
			"host": "127.0.0.1",
			"domain": "text",
			"ip": "text",
			"port": 8443,
			"transport": "tcp",
			"protocol": "text",
			"url": "https://example.com",
			"title": "示例文本",
			"server": "text",
			"tech": "text",
			"tags": [
				"text"
			],
			"status": "pending",
			"source": "text",
			"sessionName": "示例文本",
			"testCount": 2,
			"lastOutcome": "clean",
			"lastTestedAt": "2026-11-24T08:30:00.000Z",
			"firstSeenAt": "2026-11-24T08:30:00.000Z",
			"lastSeenAt": "2026-11-24T08:30:00.000Z",
			"createdAt": "2026-11-24T08:30:00.000Z",
			"updatedAt": "text"
		}
	],
	"stats": {
		"total": 2,
		"byKind": {
			"url": 2,
			"domain": 2,
			"service": 2,
			"ip": 2
		},
		"byStatus": {
			"pending": 2,
			"testing": 2,
			"tested": 2,
			"out_of_scope": 2
		},
		"tested": 2,
		"untested": 2
	},
	"total": 2,
	"page": 1,
	"pageSize": 50,
	"hasMore": true
}
```

### `asset`

一条资产的详情，带测试记录和关联的漏洞。

| 项目 | 内容 |
| --- | --- |
| 字段 | `detail`：SentinelAssetDetail |
| 发送时机 | 回复 `get_asset`、`update_asset` 时，只发给发出消息的连接 |

```json
{
	"type": "asset",
	"detail": {
		"asset": {
			"entries": [
				{
					"seq": 2,
					"kind": "status",
					"at": "2026-11-24T08:30:00.000Z",
					"author": "agent",
					"outcome": "clean",
					"text": "示例文本"
				}
			],
			"remark": "text",
			"id": "id-1",
			"label": "示例文本",
			"number": 2,
			"projectId": "project-1",
			"projectName": "示例文本",
			"kind": "url",
			"name": "示例文本",
			"host": "127.0.0.1",
			"domain": "text",
			"ip": "text",
			"port": 8443,
			"transport": "tcp",
			"protocol": "text",
			"url": "https://example.com",
			"title": "示例文本",
			"server": "text",
			"tech": "text",
			"tags": [
				"text"
			],
			"status": "pending",
			"source": "text",
			"sessionName": "示例文本",
			"testCount": 2,
			"lastOutcome": "clean",
			"lastTestedAt": "2026-11-24T08:30:00.000Z",
			"firstSeenAt": "2026-11-24T08:30:00.000Z",
			"lastSeenAt": "2026-11-24T08:30:00.000Z",
			"createdAt": "2026-11-24T08:30:00.000Z",
			"updatedAt": "text"
		},
		"vulns": [
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
				"severity": "low",
				"cvss": 2,
				"platform": "android",
				"severityMismatch": true
			}
		]
	}
}
```

### `asset_result`

一次资产修改操作的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `action`：string；`id`（可选）：string；`ok`：boolean；`error`（可选）：string |
| 发送时机 | 回复 `update_asset` 时，只发给发出消息的连接 |

```json
{
	"type": "asset_result",
	"action": "text",
	"ok": true,
	"error": "示例错误信息"
}
```

### `asset_delete_preview`

删除预览。

| 项目 | 内容 |
| --- | --- |
| 字段 | `count`：number；`records`：number；`vulns`：number |
| 发送时机 | 回复 `preview_asset_delete` 时，只发给发出消息的连接 |

```json
{
	"type": "asset_delete_preview",
	"count": 2,
	"records": 2,
	"vulns": 2
}
```

### `assets_deleted`

删除了多少条资产。

| 项目 | 内容 |
| --- | --- |
| 字段 | `count`：number |
| 发送时机 | 回复 `delete_assets` 时，只发给发出消息的连接 |

```json
{
	"type": "assets_deleted",
	"count": 2
}
```

### `assets_export`

导出的 Markdown。

| 项目 | 内容 |
| --- | --- |
| 字段 | `filename`：string；`markdown`：string |
| 发送时机 | 回复 `export_assets` 时，只发给发出消息的连接 |

```json
{
	"type": "assets_export",
	"filename": "示例文本",
	"markdown": "text"
}
```

### `assets_changed`

资产库发生了变化。它只起通知作用，不带内容。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 发送时机 | 运行时钩子 `onAssetChange` 触发时广播；处理 HTTP 的 `/api/assets/import` 和 `/api/assets/remarks` 之后也会广播 |

```json
{
	"type": "assets_changed"
}
```
