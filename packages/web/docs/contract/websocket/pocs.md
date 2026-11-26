# POC 库与订阅

POC 库是操作员导入的 Nuclei 模板，全局共享。订阅源定时或手动拉取 zip 模板包，只增不减。Agent 只有检索和读取两个只读工具，模板文件不挂进项目容器。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 8 种 |
| 下行消息 | 5 种 |
| 处理代码 | `packages/web/src/server.ts` 第 3570–3581、3582–3590、3591–3594、3595–3604、3605–3615、3616–3631、3632–3641、3642–3652 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `list_pocs`

分页检索 POC 模板。

| 项目 | 内容 |
| --- | --- |
| 字段 | `filters`（可选）：SentinelPocFilters；`page`（可选）：number；`pageSize`（可选）：number |
| 回复请求方 | `pocs` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `pocs` 回给发出消息的连接。

```json
{
	"type": "list_pocs",
	"filters": {
		"severity": "critical",
		"tag": "cve2026"
	},
	"page": 2,
	"pageSize": 50
}
```

### `get_poc`

取一份 POC 模板的全文。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error`、`poc` |
| 广播 | 无 |
| 失败文案 | `POC 库中没有 id 为 {id} 的模板` |

处理的结果通过 `poc` 回给发出消息的连接。

```json
{
	"type": "get_poc",
	"id": "example-app-login-bypass"
}
```

### `list_poc_sources`

取 POC 订阅源列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `poc_sources` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `poc_sources` 回给发出消息的连接。

```json
{
	"type": "list_poc_sources"
}
```

### `save_poc_source`

新建或修改一个 POC 订阅源。

| 项目 | 内容 |
| --- | --- |
| 字段 | `source`：SentinelPocSourceSave |
| 回复请求方 | `poc_source_result`、`poc_sources` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `poc_source_result`、`poc_sources` 回给发出消息的连接。

```json
{
	"type": "save_poc_source",
	"source": {
		"name": "内部模板源",
		"url": "https://pocs.example.com/templates.zip",
		"headerName": "Authorization",
		"headerValue": "Bearer example-token",
		"intervalHours": 24,
		"enabled": true
	}
}
```

### `delete_poc_source`

删除一个 POC 订阅源。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `poc_source_result` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `poc_source_result` 回给发出消息的连接。失败的原因写在结果消息的 `error` 字段里：`该订阅源不存在`。

```json
{
	"type": "delete_poc_source",
	"id": "3f9a1c2e"
}
```

### `sync_poc_source`

手动同步一个 POC 订阅源。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `poc_source_result` |
| 广播 | `pocs` |
| 失败文案 | `下载失败` |

处理的结果通过 `poc_source_result` 回给发出消息的连接。状态实际发生变化时，还会向所有控制台广播 `pocs`；什么都没变时不发。失败不回 `error`，而是回 `poc_source_result`，其中 `ok` 为 `false`，`error` 是：`该订阅源不存在`、`该订阅源正在同步`。

```json
{
	"type": "sync_poc_source",
	"id": "official"
}
```

### `sync_official_pocs`

同步官方 POC 源；源还不存在时先创建它。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `poc_source_result` |
| 广播 | `pocs` |
| 失败文案 | `下载失败` |

处理的结果通过 `poc_source_result` 回给发出消息的连接。状态实际发生变化时，还会向所有控制台广播 `pocs`；什么都没变时不发。失败不回 `error`，而是回 `poc_source_result`，其中 `ok` 为 `false`，`error` 是：`该订阅源不存在`、`该订阅源正在同步`。

```json
{
	"type": "sync_official_pocs"
}
```

### `delete_poc`

删除一份 POC 模板。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `poc_result` |
| 广播 | `pocs` |
| 失败文案 | 无 |

处理的结果通过 `poc_result` 回给发出消息的连接。状态实际发生变化时，还会向所有控制台广播 `pocs`；什么都没变时不发。失败的原因写在结果消息的 `error` 字段里：`该模板不存在`。

```json
{
	"type": "delete_poc",
	"id": "example-app-login-bypass"
}
```

## 下行消息（服务端 → 浏览器）

### `pocs`

POC 模板的一页，带统计。

| 项目 | 内容 |
| --- | --- |
| 字段 | `items`：SentinelPocSummary[]；`stats`：SentinelPocStats；`total`：number；`page`：number；`pageSize`：number |
| 发送时机 | 回复 `list_pocs` 时，只发给发出消息的连接；由 `broadcastPocs` 发送 |

```json
{
	"type": "pocs",
	"items": [
		{
			"id": "example-app-login-bypass",
			"name": "Example App - Unauthenticated Login Bypass",
			"severity": "critical",
			"tags": [
				"cve",
				"cve2026",
				"example",
				"rce"
			],
			"references": [
				"CVE-2026-31415"
			],
			"sourceFile": "nuclei-templates-main/http/cves/2026/CVE-2026-31415.yaml",
			"importedAt": "2026-11-24T01:59:24.000Z"
		},
		{
			"id": "example-cms-upload-rce",
			"name": "Example CMS - Authenticated File Upload RCE",
			"severity": "critical",
			"tags": [
				"cve",
				"cve2026",
				"example",
				"upload"
			],
			"references": [
				"CVE-2026-27182"
			],
			"sourceFile": "nuclei-templates-main/http/cves/2026/CVE-2026-27182.yaml",
			"importedAt": "2026-11-23T01:59:18.000Z"
		}
	],
	"stats": {
		"total": 14064,
		"bySeverity": {
			"critical": 612,
			"high": 5318,
			"medium": 6021,
			"low": 1680,
			"info": 433
		}
	},
	"total": 73,
	"page": 2,
	"pageSize": 50
}
```

### `poc`

一份 POC 模板的全文。

| 项目 | 内容 |
| --- | --- |
| 字段 | `poc`：SentinelPoc |
| 发送时机 | 回复 `get_poc` 时，只发给发出消息的连接 |

```json
{
	"type": "poc",
	"poc": {
		"id": "example-app-login-bypass",
		"name": "Example App - Unauthenticated Login Bypass",
		"severity": "critical",
		"tags": [
			"cve",
			"cve2026",
			"example",
			"rce"
		],
		"references": [
			"CVE-2026-31415"
		],
		"content": "id: example-app-login-bypass\n\ninfo:\n  name: Example App - Unauthenticated Login Bypass\n  author: example\n  severity: critical\n  description: Example App before 2.4.1 accepts a forged token as a session.\n  classification:\n    cve-id: CVE-2026-31415\n  tags: cve,cve2026,example,rce\n\nhttp:\n  - method: GET\n    path:\n      - {{BaseURL}}/api/login?token=example\n    matchers:\n      - type: word\n        part: body\n        words:\n          - authenticated\n      - type: status\n        status:\n          - 200\n",
		"sourceFile": "nuclei-templates-main/http/cves/2026/CVE-2026-31415.yaml",
		"importedAt": "2026-11-24T01:59:24.000Z"
	}
}
```

### `poc_sources`

POC 订阅源列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `sources`：SentinelPocSource[] |
| 发送时机 | 回复 `list_poc_sources`、`save_poc_source` 时，只发给发出消息的连接；运行时钩子 `onPocSourceChange` 触发时广播 |

```json
{
	"type": "poc_sources",
	"sources": [
		{
			"id": "official",
			"name": "官方 NucleiPOC",
			"url": "https://github.com/projectdiscovery/nuclei-templates/archive/refs/heads/main.zip",
			"headerSet": false,
			"intervalHours": 24,
			"enabled": true,
			"lastSyncAt": "2026-11-24T02:00:12.000Z",
			"lastResult": {
				"at": "2026-11-24T02:00:12.000Z",
				"ok": true,
				"trigger": "auto",
				"durationMs": 48210,
				"imported": 3,
				"replaced": 14061,
				"skipped": 46
			},
			"history": [
				{
					"at": "2026-11-24T02:00:12.000Z",
					"ok": true,
					"trigger": "auto",
					"durationMs": 48210,
					"imported": 3,
					"replaced": 14061,
					"skipped": 46
				},
				{
					"at": "2026-11-23T02:01:03.000Z",
					"ok": true,
					"trigger": "auto",
					"durationMs": 51470,
					"imported": 14,
					"replaced": 14050,
					"skipped": 46
				}
			]
		},
		{
			"id": "3f9a1c2e",
			"name": "内部模板源",
			"url": "https://pocs.example.com/templates.zip",
			"headerName": "Authorization",
			"headerSet": true,
			"intervalHours": 24,
			"enabled": true,
			"lastSyncAt": "2026-11-23T06:30:41.000Z",
			"lastResult": {
				"at": "2026-11-23T06:30:41.000Z",
				"ok": false,
				"trigger": "manual",
				"durationMs": 1840,
				"imported": 0,
				"replaced": 0,
				"skipped": 0,
				"error": "HTTP 403"
			},
			"history": [
				{
					"at": "2026-11-23T06:30:41.000Z",
					"ok": false,
					"trigger": "manual",
					"durationMs": 1840,
					"imported": 0,
					"replaced": 0,
					"skipped": 0,
					"error": "HTTP 403"
				}
			]
		}
	]
}
```

### `poc_source_result`

一次订阅源操作的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `action`：string；`id`（可选）：string；`ok`：boolean；`error`（可选）：string |
| 发送时机 | 回复 `save_poc_source`、`delete_poc_source`、`sync_poc_source`、`sync_official_pocs` 时，只发给发出消息的连接 |

```json
{
	"type": "poc_source_result",
	"action": "同步",
	"id": "official",
	"ok": true
}
```

### `poc_result`

一次 POC 操作的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `action`：string；`id`（可选）：string；`ok`：boolean；`error`（可选）：string |
| 发送时机 | 回复 `delete_poc` 时，只发给发出消息的连接 |

```json
{
	"type": "poc_result",
	"action": "删除",
	"id": "example-app-login-bypass",
	"ok": true
}
```
