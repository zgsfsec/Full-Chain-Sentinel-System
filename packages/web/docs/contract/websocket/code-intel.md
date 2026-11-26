# 代码情报

代码情报监控 GitHub 上的仓库有没有新的提交，由判定模型判断提交是否引入安全问题，可以自动或手动下发复现。列表和详情由代码情报管理器维护，变化时经 `monitorBroadcasts` 合并后广播 `code_monitors`。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 19 种 |
| 下行消息 | 8 种 |
| 处理代码 | `packages/web/src/server.ts` 第 3874–3880、3881–3912、3913–3935、3936–3944、3945–3949、3950–3955、3956–3976、3977–4006、4007–4028、4029–4048、4049–4064、4065–4086、4087–4095、4096–4124、4125–4133、4134–4149、4150–4174、4175–4203、4204–4215 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `list_code_monitors`

取全部代码监控的列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `error`、`code_monitors` |
| 广播 | 无 |
| 失败文案 | `未配置配置目录，无法使用开源监测` |

处理的结果通过 `code_monitors` 回给发出消息的连接。

```json
{
	"type": "list_code_monitors"
}
```

### `list_code_activity`

取代码情报的动态视图。

| 项目 | 内容 |
| --- | --- |
| 字段 | `requestId`：number；`projectId`：string；`filter`：SentinelCodeActivityFilter；`category`（可选）：SentinelVulnCategory | null。Optional vuln-category narrowing on top of the status filter.；`tag`（可选）：CodeVulnTag | null；`search`（可选）：string；`page`：number；`pageSize`：number |
| 回复请求方 | `code_activity_error`、`code_activity` |
| 广播 | 无 |
| 失败文案 | `项目不存在` |

处理的结果通过 `code_activity_error`、`code_activity` 回给发出消息的连接。失败的原因写在结果消息的 `error` 字段里：`未配置配置目录，无法使用开源监测`。

```json
{
	"type": "list_code_activity",
	"requestId": 12,
	"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
	"filter": "attention",
	"category": "web",
	"tag": null,
	"search": "",
	"page": 1,
	"pageSize": 20
}
```

### `code_monitor_branches`

列出一个仓库的分支，供选择要监控的分支。

| 项目 | 内容 |
| --- | --- |
| 字段 | `requestId`：number；`projectId`：string；`url`：string；`monitorId`（可选）：string。An existing monitor lets the server reuse its stored token.；`token`（可选）：string；`apiBaseUrl`（可选）：string |
| 回复请求方 | `code_monitor_branches` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `code_monitor_branches` 回给发出消息的连接。失败的原因写在结果消息的 `error` 字段里：`未配置配置目录，无法使用开源监测`。

```json
{
	"type": "code_monitor_branches",
	"requestId": 5,
	"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
	"url": "https://github.com/example-org/example-gateway",
	"token": "github_pat_example0000000000000000000000000",
	"apiBaseUrl": "https://api.github.com"
}
```

### `import_code_monitors`

批量导入代码监控。

| 项目 | 内容 |
| --- | --- |
| 字段 | `inputs`：SentinelCodeMonitorInput[] |
| 回复请求方 | `error`、`code_monitor_import` |
| 广播 | 无 |
| 失败文案 | `未配置配置目录，无法使用开源监测` |

处理的结果通过 `code_monitor_import` 回给发出消息的连接。

```json
{
	"type": "import_code_monitors",
	"inputs": [
		{
			"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
			"url": "https://github.com/example-org/example-gateway",
			"name": "example-org/example-gateway",
			"apiBaseUrl": "https://api.github.com",
			"branches": [
				"main",
				"release/2.4"
			],
			"intervalMinutes": 60,
			"scheduleKind": "interval",
			"cronExpression": null,
			"autoDispatch": true,
			"autoDispatchCategories": [
				"web",
				"memory"
			],
			"autoDispatchTags": [
				"sql-injection",
				"path-traversal"
			],
			"enabled": true,
			"token": "github_pat_example0000000000000000000000000"
		},
		{
			"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
			"url": "https://github.com/example-org/example-cli",
			"token": "github_pat_example0000000000000000000000000",
			"branches": [
				"main"
			],
			"intervalMinutes": 120,
			"scheduleKind": "interval",
			"cronExpression": null,
			"autoDispatch": false,
			"enabled": true
		}
	]
}
```

### `get_code_monitor_import`

取批量导入的进度。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `code_monitor_import` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `code_monitor_import` 回给发出消息的连接。

```json
{
	"type": "get_code_monitor_import"
}
```

### `dismiss_code_monitor_import`

关掉批量导入的进度提示。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `code_monitor_import` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `code_monitor_import` 回给发出消息的连接。

```json
{
	"type": "dismiss_code_monitor_import"
}
```

### `create_code_monitor`

新建一个代码监控。

| 项目 | 内容 |
| --- | --- |
| 字段 | `input`：SentinelCodeMonitorInput |
| 回复请求方 | `error`、`code_monitor_result` |
| 广播 | `code_monitors` |
| 失败文案 | `未配置配置目录，无法使用开源监测` |

处理的结果通过 `code_monitor_result` 回给发出消息的连接。同时向所有控制台广播 `code_monitors`。

```json
{
	"type": "create_code_monitor",
	"input": {
		"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
		"url": "https://github.com/example-org/example-cli",
		"name": "Example CLI",
		"token": "github_pat_example0000000000000000000000000",
		"branches": [
			"main"
		],
		"intervalMinutes": 60,
		"scheduleKind": "cron",
		"cronExpression": "30 2 * * 1-5",
		"autoDispatch": true,
		"autoDispatchTags": [
			"rce"
		],
		"enabled": true
	}
}
```

### `scan_code_history`

对一个仓库做一次历史扫描。

| 项目 | 内容 |
| --- | --- |
| 字段 | `input`：SentinelCodeOneShotInput |
| 回复请求方 | `error`、`code_monitor_result` |
| 广播 | `code_monitors` |
| 失败文案 | `未配置配置目录，无法使用开源监测` |

处理的结果通过 `code_monitor_result` 回给发出消息的连接。同时向所有控制台广播 `code_monitors`。

```json
{
	"type": "scan_code_history",
	"input": {
		"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
		"url": "https://github.com/example-org/example-gateway",
		"token": "github_pat_example0000000000000000000000000",
		"commitLimit": 20,
		"autoDispatch": false
	}
}
```

### `update_code_monitor`

修改一个代码监控。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`input`：SentinelCodeMonitorInput |
| 回复请求方 | `error`、`code_monitor_result` |
| 广播 | `code_monitors` |
| 失败文案 | `未配置配置目录，无法使用开源监测` |

处理的结果通过 `code_monitor_result` 回给发出消息的连接。同时向所有控制台广播 `code_monitors`。

```json
{
	"type": "update_code_monitor",
	"id": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
	"input": {
		"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
		"url": "https://github.com/example-org/example-gateway",
		"name": "example-org/example-gateway",
		"apiBaseUrl": "https://api.github.com",
		"branches": [
			"main",
			"release/2.4"
		],
		"intervalMinutes": 60,
		"scheduleKind": "interval",
		"cronExpression": null,
		"autoDispatch": true,
		"autoDispatchCategories": [
			"web",
			"memory"
		],
		"autoDispatchTags": [
			"sql-injection",
			"path-traversal"
		],
		"enabled": true
	}
}
```

### `delete_code_monitors`

批量删除代码监控。

| 项目 | 内容 |
| --- | --- |
| 字段 | `ids`：string[] |
| 回复请求方 | `code_monitor_result` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `code_monitor_result` 回给发出消息的连接。

```json
{
	"type": "delete_code_monitors",
	"ids": [
		"6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
		"a41e8b27-9d0c-4f6b-b3e2-5c8a7d1f9064"
	]
}
```

### `delete_code_monitor`

删除一个代码监控。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `code_monitor_result` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `code_monitor_result` 回给发出消息的连接。

```json
{
	"type": "delete_code_monitor",
	"id": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8"
}
```

### `check_code_monitor`

立即检查一个代码监控。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`trigger`（可选）：SentinelCodeCheckTrigger |
| 回复请求方 | `code_monitor_result` |
| 广播 | 无 |
| 失败文案 | `监控不存在`、`单次扫描不能再次检查`、`单次扫描记录无效`、`检查任务写入失败` |

处理的结果通过 `code_monitor_result` 回给发出消息的连接。

```json
{
	"type": "check_code_monitor",
	"id": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
	"trigger": "manual"
}
```

### `get_code_monitor`

取一个代码监控的详情。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `code_monitor_detail`、`error` |
| 广播 | 无 |
| 失败文案 | `监控不存在` |

处理的结果通过 `code_monitor_detail` 回给发出消息的连接。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "get_code_monitor",
	"id": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8"
}
```

### `dispatch_code_commit`

把一条提交发现下发复现。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `code_monitor_result`、`code_monitor_detail` |
| 广播 | `engines`、`code_monitors` |
| 失败文案 | `监控不存在` |

处理的结果通过 `code_monitor_result`、`code_monitor_detail` 回给发出消息的连接。同时向所有控制台广播 `engines`、`code_monitors`。

```json
{
	"type": "dispatch_code_commit",
	"id": "d27b5e81-3c4a-4f09-8b6d-1e2f3a4c5b70"
}
```

### `ignore_code_commit`

忽略一条提交发现。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `code_monitor_detail`、`error` |
| 广播 | 无 |
| 失败文案 | `提交记录不存在`、`该发现已经进入工程，不能忽略` |

处理的结果通过 `code_monitor_detail` 回给发出消息的连接。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "ignore_code_commit",
	"id": "8b4f2e69-7a15-4d3c-b0e8-c57f91a3d6e2"
}
```

### `rejudge_code_commit`

让判定模型重新判断一条提交。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `code_monitor_detail`、`code_monitor_result` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `code_monitor_detail`、`code_monitor_result` 回给发出消息的连接。

```json
{
	"type": "rejudge_code_commit",
	"id": "5ea1d8b4-2f76-4c90-8b13-9d6e2a7f4c38"
}
```

### `set_code_monitors_schedule`

批量设置代码监控的检查计划。

| 项目 | 内容 |
| --- | --- |
| 字段 | `ids`：string[]；`scheduleKind`：SentinelCodeScheduleKind；`intervalMinutes`（可选）：number；`cronExpression`（可选）：string | null |
| 回复请求方 | `error`、`code_monitor_result` |
| 广播 | 无 |
| 失败文案 | `未配置配置目录，无法使用开源监测` |

处理的结果通过 `code_monitor_result` 回给发出消息的连接。

```json
{
	"type": "set_code_monitors_schedule",
	"ids": [
		"6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
		"a41e8b27-9d0c-4f6b-b3e2-5c8a7d1f9064"
	],
	"scheduleKind": "interval",
	"intervalMinutes": 120,
	"cronExpression": null
}
```

### `set_code_monitors_dispatch`

批量设置代码监控的自动复现规则。

| 项目 | 内容 |
| --- | --- |
| 字段 | `ids`：string[]；`autoDispatch`（可选）：boolean；`autoDispatchCategories`（可选）：SentinelVulnCategory[] | null；`autoDispatchTags`（可选）：CodeVulnTag[] | null |
| 回复请求方 | `error`、`code_monitor_result` |
| 广播 | 无 |
| 失败文案 | `未配置配置目录，无法使用开源监测`、`请选择要修改的监控`、`请至少选择一种自动复现的漏洞类型`、`自动复现包含未知的漏洞类型，请重新选择`、`监控不存在`、`监控更新失败` |

处理的结果通过 `code_monitor_result` 回给发出消息的连接。

```json
{
	"type": "set_code_monitors_dispatch",
	"ids": [
		"6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8"
	],
	"autoDispatch": true,
	"autoDispatchCategories": [
		"web",
		"memory"
	],
	"autoDispatchTags": null
}
```

### `list_code_monitor_logs`

取项目级的检查日志和队列任务。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `error`、`code_monitor_logs` |
| 广播 | 无 |
| 失败文案 | `未配置配置目录，无法使用开源监测` |

处理的结果通过 `code_monitor_logs` 回给发出消息的连接。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "list_code_monitor_logs",
	"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31"
}
```

## 下行消息（服务端 → 浏览器）

### `code_monitors`

全部代码监控的列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `monitors`：SentinelCodeMonitor[] |
| 发送时机 | 回复 `list_code_monitors` 时，只发给发出消息的连接；监控列表变化后经 `monitorBroadcasts` 合并广播（100 毫秒内的多次变化合并成一次） |

```json
{
	"type": "code_monitors",
	"monitors": [
		{
			"id": "a41e8b27-9d0c-4f6b-b3e2-5c8a7d1f9064",
			"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
			"projectName": "Example Gateway",
			"name": "example-org/example-gateway · 单次扫描",
			"host": "github.com",
			"owner": "example-org",
			"repo": "example-gateway",
			"repoUrl": "https://github.com/example-org/example-gateway",
			"apiBaseUrl": "https://api.github.com",
			"branches": [
				"main"
			],
			"baselines": {
				"main": "9f1c3e7a2b4d6f80a1c3e5b7d9f0a2c4e6b8d0f1"
			},
			"tokenSet": true,
			"autoDispatch": false,
			"autoDispatchCategories": null,
			"autoDispatchTags": null,
			"intervalMinutes": 0,
			"scheduleKind": "interval",
			"cronExpression": null,
			"nextCheckAt": null,
			"checkState": "idle",
			"oneShot": true,
			"oneShotLimit": 20,
			"enabled": false,
			"lastCheckAt": 1795504260000,
			"lastError": "main: GitHub API 触发限流（429/abuse）。请稍后重试；建议为监控配置访问令牌，并避免同时检查同一主机的多个仓库（HTTP 403；GET https://api.github.com/repos/example-org/example-gateway/branches/main；812ms）",
			"createdAt": 1795503600000,
			"findingCount": 0,
			"pendingCount": 0
		},
		{
			"id": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
			"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
			"projectName": "Example Gateway",
			"name": "example-org/example-gateway",
			"host": "github.com",
			"owner": "example-org",
			"repo": "example-gateway",
			"repoUrl": "https://github.com/example-org/example-gateway",
			"apiBaseUrl": "https://api.github.com",
			"branches": [
				"main",
				"release/2.4"
			],
			"baselines": {
				"main": "9f1c3e7a2b4d6f80a1c3e5b7d9f0a2c4e6b8d0f1",
				"release/2.4": "4a7d1e30b9c2f5a68d0e3b7c1f4a6d8e0b2c5f97"
			},
			"tokenSet": true,
			"autoDispatch": true,
			"autoDispatchCategories": [
				"web",
				"memory"
			],
			"autoDispatchTags": [
				"sql-injection",
				"path-traversal"
			],
			"intervalMinutes": 60,
			"scheduleKind": "interval",
			"cronExpression": null,
			"nextCheckAt": 1795508400000,
			"checkState": "idle",
			"oneShot": false,
			"oneShotLimit": null,
			"enabled": true,
			"lastCheckAt": 1795504800000,
			"lastError": null,
			"createdAt": 1794277800000,
			"findingCount": 3,
			"pendingCount": 2
		}
	]
}
```

### `code_monitor_import`

批量导入的进度。

| 项目 | 内容 |
| --- | --- |
| 字段 | `state`：SentinelCodeImportState | null |
| 发送时机 | 回复 `import_code_monitors`、`get_code_monitor_import`、`dismiss_code_monitor_import` 时，只发给发出消息的连接；导入任务有进展时由代码情报管理器发送 |

```json
{
	"type": "code_monitor_import",
	"state": {
		"total": 3,
		"processed": 2,
		"succeeded": 1,
		"failed": 1,
		"current": "https://github.com/example-org/example-cache",
		"running": true,
		"errors": [
			{
				"url": "https://github.com/example-org/example-cli",
				"error": "仓库或分支不存在，或令牌无权访问（HTTP 404；GET https://api.github.com/repos/example-org/example-cli/branches/main；205ms）：{\"message\":\"Not Found\"}"
			}
		]
	}
}
```

### `code_activity_error`

动态视图查询失败的原因。

| 项目 | 内容 |
| --- | --- |
| 字段 | `requestId`：number；`error`：string |
| 发送时机 | 回复 `list_code_activity` 时，只发给发出消息的连接 |

```json
{
	"type": "code_activity_error",
	"requestId": 12,
	"error": "项目不存在"
}
```

### `code_activity`

代码情报的动态视图。

| 项目 | 内容 |
| --- | --- |
| 字段 | `requestId`：number；`view`：SentinelCodeActivityView |
| 发送时机 | 回复 `list_code_activity` 时，只发给发出消息的连接 |

```json
{
	"type": "code_activity",
	"requestId": 12,
	"view": {
		"items": [
			{
				"id": "d27b5e81-3c4a-4f09-8b6d-1e2f3a4c5b70",
				"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
				"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
				"branch": "main",
				"sha": "9f1c3e7a2b4d6f80a1c3e5b7d9f0a2c4e6b8d0f1",
				"shortSha": "9f1c3e7a",
				"title": "fix(upload): reject path traversal in avatar names",
				"message": "fix(upload): reject path traversal in avatar names\n\nResolve the target against the upload root and refuse anything outside it.",
				"author": "Jordan Lee",
				"authoredAt": 1795503600000,
				"url": "https://github.com/example-org/example-gateway/commit/9f1c3e7a2b4d6f80a1c3e5b7d9f0a2c4e6b8d0f1",
				"verdict": "security",
				"confidence": 0.92,
				"cve": "CVE-2026-31415",
				"severity": "high",
				"vulnType": "路径穿越",
				"vulnCategory": "web",
				"vulnTags": [
					"path-traversal",
					"file-write"
				],
				"reason": "src/upload/avatar.ts 原先直接拼接用户传入的文件名，修复后改为 resolve 后校验是否仍在上传目录内。",
				"status": "new",
				"reproductionStage": null,
				"engineId": null,
				"duplicateOf": null,
				"error": null,
				"additions": 24,
				"deletions": 3,
				"files": 2,
				"diff": "### src/upload/avatar.ts (modified, +10 -3)\n@@ -18,7 +18,14 @@\n-    const target = join(root, name);\n+    const target = resolve(root, name);\n+    if (!target.startsWith(root + sep)) throw new Error(\"invalid name\");\n\n### src/upload/validate.ts (added, +14 -0)\n+export function isInside(root: string, target: string): boolean {\n+    return target.startsWith(root + sep);\n+}",
				"createdAt": 1795504800000,
				"judgedAt": 1795504920000
			},
			{
				"id": "0c93a6f2-5b81-4e47-a2d9-6f3c8b1e7d05",
				"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
				"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
				"branch": "release/2.4",
				"sha": "4a7d1e30b9c2f5a68d0e3b7c1f4a6d8e0b2c5f97",
				"shortSha": "4a7d1e30",
				"title": "fix(db): parameterize the tenant lookup",
				"message": "fix(db): parameterize the tenant lookup",
				"author": "Jordan Lee",
				"authoredAt": 1795165920000,
				"url": "https://github.com/example-org/example-gateway/commit/4a7d1e30b9c2f5a68d0e3b7c1f4a6d8e0b2c5f97",
				"verdict": "security",
				"confidence": 0.88,
				"cve": null,
				"severity": "medium",
				"vulnType": "SQL 注入",
				"vulnCategory": "web",
				"vulnTags": [
					"sql-injection"
				],
				"reason": "src/db/tenant.ts 把请求里的 tenant id 直接拼进了 SQL，修复后改为参数绑定。",
				"status": "dispatched",
				"reproductionStage": "engineering",
				"engineId": "engine-5e0b7c32-8a1d-4c4f-9e67-2d3b8f1a0c45",
				"duplicateOf": null,
				"error": null,
				"additions": 9,
				"deletions": 4,
				"files": 1,
				"diff": "### src/db/tenant.ts (modified, +9 -4)\n@@ -41,4 +41,9 @@\n-    const sql = `SELECT * FROM tenants WHERE id = '${id}'`;\n+    const sql = \"SELECT * FROM tenants WHERE id = ?\";",
				"createdAt": 1795166400000,
				"judgedAt": 1795166520000
			},
			{
				"id": "8b4f2e69-7a15-4d3c-b0e8-c57f91a3d6e2",
				"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
				"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
				"branch": "main",
				"sha": "7e3d0c5b8a2f4e61d9c7b0a3e5f2c48d6b1e97a0",
				"shortSha": "7e3d0c5b",
				"title": "fix(webhook): block requests to link-local addresses",
				"message": "fix(webhook): block requests to link-local addresses",
				"author": "Jordan Lee",
				"authoredAt": 1795097100000,
				"url": "https://github.com/example-org/example-gateway/commit/7e3d0c5b8a2f4e61d9c7b0a3e5f2c48d6b1e97a0",
				"verdict": "security",
				"confidence": 0.81,
				"cve": "GHSA-7q3m-2x8p-9r4c-w5vd",
				"severity": "high",
				"vulnType": "SSRF",
				"vulnCategory": "web",
				"vulnTags": [
					"ssrf"
				],
				"reason": "src/webhook/deliver.ts 新增了对解析后地址的网段判断，拒绝 169.254.0.0/16 与 127.0.0.0/8。",
				"status": "new",
				"reproductionStage": "failed",
				"engineId": null,
				"duplicateOf": null,
				"error": "项目容器未运行，请先在项目页启动容器",
				"additions": 31,
				"deletions": 1,
				"files": 2,
				"diff": "### src/webhook/deliver.ts (modified, +31 -1)\n@@ -12,6 +12,36 @@\n+    if (isPrivate(target.hostname)) throw new Error(\"blocked address\");",
				"createdAt": 1795097400000,
				"judgedAt": 1795097520000
			}
		],
		"total": 3,
		"page": 1,
		"pageSize": 20,
		"counts": {
			"attention": 3,
			"review": 1,
			"failed": 1,
			"dispatchFailed": 1,
			"pending": 0,
			"anomalies": 1,
			"reproducing": 1,
			"finished": 0
		}
	}
}
```

### `code_monitor_branches`

一个仓库的分支列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `requestId`：number；`branches`（可选）：string[]；`error`（可选）：string |
| 发送时机 | 回复 `code_monitor_branches` 时，只发给发出消息的连接 |

```json
{
	"type": "code_monitor_branches",
	"requestId": 5,
	"branches": [
		"main",
		"release/2.4",
		"release/2.5"
	]
}
```

### `code_monitor_result`

一次代码监控操作的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `action`：string；`id`（可选）：string；`ok`：boolean；`error`（可选）：string；`detail`（可选）：string。Extra outcome line, e.g. how many commits a check consumed. |
| 发送时机 | 回复 `create_code_monitor`、`scan_code_history`、`update_code_monitor`、`delete_code_monitors`、`delete_code_monitor`、`check_code_monitor`、`dispatch_code_commit`、`rejudge_code_commit`、`set_code_monitors_schedule`、`set_code_monitors_dispatch` 时，只发给发出消息的连接 |

```json
{
	"type": "code_monitor_result",
	"action": "检查监控",
	"id": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
	"ok": true,
	"detail": "已加入检查队列"
}
```

### `code_monitor_detail`

一条提交发现的详情。

| 项目 | 内容 |
| --- | --- |
| 字段 | `detail`：SentinelCodeMonitorDetail |
| 发送时机 | 回复 `get_code_monitor`、`dispatch_code_commit`、`ignore_code_commit`、`rejudge_code_commit` 时，只发给发出消息的连接 |

```json
{
	"type": "code_monitor_detail",
	"detail": {
		"monitor": {
			"id": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
			"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
			"projectName": "Example Gateway",
			"name": "example-org/example-gateway",
			"host": "github.com",
			"owner": "example-org",
			"repo": "example-gateway",
			"repoUrl": "https://github.com/example-org/example-gateway",
			"apiBaseUrl": "https://api.github.com",
			"branches": [
				"main",
				"release/2.4"
			],
			"baselines": {
				"main": "9f1c3e7a2b4d6f80a1c3e5b7d9f0a2c4e6b8d0f1",
				"release/2.4": "4a7d1e30b9c2f5a68d0e3b7c1f4a6d8e0b2c5f97"
			},
			"tokenSet": true,
			"autoDispatch": true,
			"autoDispatchCategories": [
				"web",
				"memory"
			],
			"autoDispatchTags": [
				"sql-injection",
				"path-traversal"
			],
			"intervalMinutes": 60,
			"scheduleKind": "interval",
			"cronExpression": null,
			"nextCheckAt": 1795508400000,
			"checkState": "idle",
			"oneShot": false,
			"oneShotLimit": null,
			"enabled": true,
			"lastCheckAt": 1795504800000,
			"lastError": null,
			"createdAt": 1794277800000,
			"findingCount": 3,
			"pendingCount": 2
		},
		"commits": [
			{
				"id": "d27b5e81-3c4a-4f09-8b6d-1e2f3a4c5b70",
				"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
				"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
				"branch": "main",
				"sha": "9f1c3e7a2b4d6f80a1c3e5b7d9f0a2c4e6b8d0f1",
				"shortSha": "9f1c3e7a",
				"title": "fix(upload): reject path traversal in avatar names",
				"message": "fix(upload): reject path traversal in avatar names\n\nResolve the target against the upload root and refuse anything outside it.",
				"author": "Jordan Lee",
				"authoredAt": 1795503600000,
				"url": "https://github.com/example-org/example-gateway/commit/9f1c3e7a2b4d6f80a1c3e5b7d9f0a2c4e6b8d0f1",
				"verdict": "security",
				"confidence": 0.92,
				"cve": "CVE-2026-31415",
				"severity": "high",
				"vulnType": "路径穿越",
				"vulnCategory": "web",
				"vulnTags": [
					"path-traversal",
					"file-write"
				],
				"reason": "src/upload/avatar.ts 原先直接拼接用户传入的文件名，修复后改为 resolve 后校验是否仍在上传目录内。",
				"status": "new",
				"reproductionStage": null,
				"engineId": null,
				"duplicateOf": null,
				"error": null,
				"additions": 24,
				"deletions": 3,
				"files": 2,
				"diff": "### src/upload/avatar.ts (modified, +10 -3)\n@@ -18,7 +18,14 @@\n-    const target = join(root, name);\n+    const target = resolve(root, name);\n+    if (!target.startsWith(root + sep)) throw new Error(\"invalid name\");\n\n### src/upload/validate.ts (added, +14 -0)\n+export function isInside(root: string, target: string): boolean {\n+    return target.startsWith(root + sep);\n+}",
				"createdAt": 1795504800000,
				"judgedAt": 1795504920000
			},
			{
				"id": "5ea1d8b4-2f76-4c90-8b13-9d6e2a7f4c38",
				"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
				"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
				"branch": "main",
				"sha": "c05b9f6e1d3a7c408e2b6d9f0a1c7e5b3d0f8269",
				"shortSha": "c05b9f6e",
				"title": "refactor(core): split the request pipeline",
				"message": "refactor(core): split the request pipeline",
				"author": "Jordan Lee",
				"authoredAt": 1795420800000,
				"url": "https://github.com/example-org/example-gateway/commit/c05b9f6e1d3a7c408e2b6d9f0a1c7e5b3d0f8269",
				"verdict": "failed",
				"confidence": null,
				"cve": null,
				"severity": null,
				"vulnType": null,
				"vulnCategory": null,
				"vulnTags": [],
				"reason": "监测模型请求超时",
				"status": "new",
				"reproductionStage": null,
				"engineId": null,
				"duplicateOf": null,
				"error": null,
				"additions": 412,
				"deletions": 388,
				"files": 17,
				"diff": "### src/core/pipeline.ts (modified, +212 -188)\n-export function handle(request) {\n+export function handle(request) {\n（另有 16 个文件的 diff 因长度限制未展示）",
				"createdAt": 1795424400000,
				"judgedAt": 1795424610000
			},
			{
				"id": "0c93a6f2-5b81-4e47-a2d9-6f3c8b1e7d05",
				"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
				"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
				"branch": "release/2.4",
				"sha": "4a7d1e30b9c2f5a68d0e3b7c1f4a6d8e0b2c5f97",
				"shortSha": "4a7d1e30",
				"title": "fix(db): parameterize the tenant lookup",
				"message": "fix(db): parameterize the tenant lookup",
				"author": "Jordan Lee",
				"authoredAt": 1795165920000,
				"url": "https://github.com/example-org/example-gateway/commit/4a7d1e30b9c2f5a68d0e3b7c1f4a6d8e0b2c5f97",
				"verdict": "security",
				"confidence": 0.88,
				"cve": null,
				"severity": "medium",
				"vulnType": "SQL 注入",
				"vulnCategory": "web",
				"vulnTags": [
					"sql-injection"
				],
				"reason": "src/db/tenant.ts 把请求里的 tenant id 直接拼进了 SQL，修复后改为参数绑定。",
				"status": "dispatched",
				"reproductionStage": "engineering",
				"engineId": "engine-5e0b7c32-8a1d-4c4f-9e67-2d3b8f1a0c45",
				"duplicateOf": null,
				"error": null,
				"additions": 9,
				"deletions": 4,
				"files": 1,
				"diff": "### src/db/tenant.ts (modified, +9 -4)\n@@ -41,4 +41,9 @@\n-    const sql = `SELECT * FROM tenants WHERE id = '${id}'`;\n+    const sql = \"SELECT * FROM tenants WHERE id = ?\";",
				"createdAt": 1795166400000,
				"judgedAt": 1795166520000
			},
			{
				"id": "8b4f2e69-7a15-4d3c-b0e8-c57f91a3d6e2",
				"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
				"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
				"branch": "main",
				"sha": "7e3d0c5b8a2f4e61d9c7b0a3e5f2c48d6b1e97a0",
				"shortSha": "7e3d0c5b",
				"title": "fix(webhook): block requests to link-local addresses",
				"message": "fix(webhook): block requests to link-local addresses",
				"author": "Jordan Lee",
				"authoredAt": 1795097100000,
				"url": "https://github.com/example-org/example-gateway/commit/7e3d0c5b8a2f4e61d9c7b0a3e5f2c48d6b1e97a0",
				"verdict": "security",
				"confidence": 0.81,
				"cve": "GHSA-7q3m-2x8p-9r4c-w5vd",
				"severity": "high",
				"vulnType": "SSRF",
				"vulnCategory": "web",
				"vulnTags": [
					"ssrf"
				],
				"reason": "src/webhook/deliver.ts 新增了对解析后地址的网段判断，拒绝 169.254.0.0/16 与 127.0.0.0/8。",
				"status": "new",
				"reproductionStage": "failed",
				"engineId": null,
				"duplicateOf": null,
				"error": "项目容器未运行，请先在项目页启动容器",
				"additions": 31,
				"deletions": 1,
				"files": 2,
				"diff": "### src/webhook/deliver.ts (modified, +31 -1)\n@@ -12,6 +12,36 @@\n+    if (isPrivate(target.hostname)) throw new Error(\"blocked address\");",
				"createdAt": 1795097400000,
				"judgedAt": 1795097520000
			}
		],
		"checks": [
			{
				"id": "8f2c6b14-0e3d-4a57-9c81-b2d4e6f80a13",
				"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
				"trigger": "manual",
				"status": "ok",
				"startedAt": 1795504800000,
				"endedAt": 1795505040000,
				"commits": 2,
				"findings": 1,
				"error": null
			},
			{
				"id": "1d6e4a92-7c3b-4f08-9b25-8e6d2a9c4f07",
				"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
				"trigger": "auto",
				"status": "error",
				"startedAt": 1795424400000,
				"endedAt": 1795424610000,
				"commits": 0,
				"findings": 0,
				"error": "main: GitHub API 触发限流（429/abuse）。请稍后重试；建议为监控配置访问令牌，并避免同时检查同一主机的多个仓库（HTTP 403；GET https://api.github.com/repos/example-org/example-gateway/branches/main；812ms）"
			}
		],
		"jobs": [
			{
				"id": "b9a3f7c1-4d2e-4b80-9f16-3c5e7a8d0b24",
				"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
				"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
				"host": "github.com",
				"trigger": "manual",
				"status": "done",
				"attempts": 1,
				"maxAttempts": 3,
				"nextRunAt": 1795504800000,
				"createdAt": 1795504800000,
				"startedAt": 1795504800000,
				"endedAt": 1795505040000,
				"error": null,
				"checkId": "8f2c6b14-0e3d-4a57-9c81-b2d4e6f80a13"
			},
			{
				"id": "e5c8d2a6-1f9b-4e73-8c04-6b7f9d1a3e58",
				"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
				"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
				"host": "github.com",
				"trigger": "auto",
				"status": "queued",
				"attempts": 1,
				"maxAttempts": 3,
				"nextRunAt": 1795425600000,
				"createdAt": 1795424400000,
				"startedAt": null,
				"endedAt": null,
				"error": "main: GitHub API 触发限流（429/abuse）。请稍后重试；建议为监控配置访问令牌，并避免同时检查同一主机的多个仓库（HTTP 403；GET https://api.github.com/repos/example-org/example-gateway/branches/main；812ms）",
				"checkId": null
			}
		]
	}
}
```

### `code_monitor_logs`

项目级的检查日志和队列任务。

| 项目 | 内容 |
| --- | --- |
| 字段 | `checks`：SentinelCodeCheckLog[]；`jobs`：SentinelCodeCheckJob[] |
| 发送时机 | 回复 `list_code_monitor_logs` 时，只发给发出消息的连接 |

```json
{
	"type": "code_monitor_logs",
	"checks": [
		{
			"id": "8f2c6b14-0e3d-4a57-9c81-b2d4e6f80a13",
			"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
			"trigger": "manual",
			"status": "ok",
			"startedAt": 1795504800000,
			"endedAt": 1795505040000,
			"commits": 2,
			"findings": 1,
			"error": null
		},
		{
			"id": "c3a7e519-8b02-4d64-b1f7-0a9e3c6d5f284",
			"monitorId": "a41e8b27-9d0c-4f6b-b3e2-5c8a7d1f9064",
			"trigger": "one-shot",
			"status": "error",
			"startedAt": 1795503600000,
			"endedAt": 1795504260000,
			"commits": 12,
			"findings": 0,
			"error": "main: GitHub API 触发限流（429/abuse）。请稍后重试；建议为监控配置访问令牌，并避免同时检查同一主机的多个仓库（HTTP 403；GET https://api.github.com/repos/example-org/example-gateway/branches/main；812ms）"
		},
		{
			"id": "1d6e4a92-7c3b-4f08-9b25-8e6d2a9c4f07",
			"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
			"trigger": "auto",
			"status": "error",
			"startedAt": 1795424400000,
			"endedAt": 1795424610000,
			"commits": 0,
			"findings": 0,
			"error": "main: GitHub API 触发限流（429/abuse）。请稍后重试；建议为监控配置访问令牌，并避免同时检查同一主机的多个仓库（HTTP 403；GET https://api.github.com/repos/example-org/example-gateway/branches/main；812ms）"
		}
	],
	"jobs": [
		{
			"id": "b9a3f7c1-4d2e-4b80-9f16-3c5e7a8d0b24",
			"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
			"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
			"host": "github.com",
			"trigger": "manual",
			"status": "done",
			"attempts": 1,
			"maxAttempts": 3,
			"nextRunAt": 1795504800000,
			"createdAt": 1795504800000,
			"startedAt": 1795504800000,
			"endedAt": 1795505040000,
			"error": null,
			"checkId": "8f2c6b14-0e3d-4a57-9c81-b2d4e6f80a13"
		},
		{
			"id": "f0b6e3d7-2a4c-4b91-9d58-7c3e6a0f5b18",
			"monitorId": "a41e8b27-9d0c-4f6b-b3e2-5c8a7d1f9064",
			"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
			"host": "github.com",
			"trigger": "one-shot",
			"status": "queued",
			"attempts": 1,
			"maxAttempts": 3,
			"nextRunAt": 1795511100000,
			"createdAt": 1795503600000,
			"startedAt": null,
			"endedAt": null,
			"error": "main: GitHub API 触发限流（429/abuse）。请稍后重试；建议为监控配置访问令牌，并避免同时检查同一主机的多个仓库（HTTP 403；GET https://api.github.com/repos/example-org/example-gateway/branches/main；812ms）",
			"checkId": null
		},
		{
			"id": "e5c8d2a6-1f9b-4e73-8c04-6b7f9d1a3e58",
			"monitorId": "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8",
			"projectId": "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31",
			"host": "github.com",
			"trigger": "auto",
			"status": "queued",
			"attempts": 1,
			"maxAttempts": 3,
			"nextRunAt": 1795425600000,
			"createdAt": 1795424400000,
			"startedAt": null,
			"endedAt": null,
			"error": "main: GitHub API 触发限流（429/abuse）。请稍后重试；建议为监控配置访问令牌，并避免同时检查同一主机的多个仓库（HTTP 403；GET https://api.github.com/repos/example-org/example-gateway/branches/main；812ms）",
			"checkId": null
		}
	]
}
```
