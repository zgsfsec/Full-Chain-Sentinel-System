# 权限、通知、预设 Agent 与指挥思路

本域是四类全局配置：主 Agent 与子代理的工具权限、群通知、预设 Agent 和指挥思路。权限和预设的改动会体现在 `snapshot` 里；通知投递结束后 `notify_config` 会被再次广播，带上最近一次的结果。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 14 种 |
| 下行消息 | 11 种 |
| 处理代码 | `packages/web/src/server.ts` 第 2254–2264、2265–2281、2282–2288、2289–2296、2297–2301、4418–4420、4421–4437、4438–4449、4450–4463、4464–4478、4479–4504、4381–4386、4387–4404、4405–4417 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `get_permissions`

取主 Agent 和子代理的工具权限、预设，以及当前会话实际挂载的工具。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `permissions` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `permissions` 回给发出消息的连接。

```json
{
	"type": "get_permissions"
}
```

### `save_permissions`

保存工具权限。有会话正在运行时拒绝；保存后重建所有活动会话。

| 项目 | 内容 |
| --- | --- |
| 字段 | `config`：SentinelPermissionsConfig |
| 回复请求方 | `error` |
| 广播 | `permissions`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `permissions`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "save_permissions",
	"config": {
		"main": {
			"web_search": true,
			"mcp": true,
			"tool_search": true,
			"edit": true,
			"bash": true,
			"codemode": true,
			"read": true,
			"write": true,
			"spawn_agent": true,
			"vuln_submit": true,
			"vuln_read": true,
			"poc_read": true,
			"asset_read": true,
			"asset_library_write": true,
			"asset_library_read": true,
			"mitm_read": true
		},
		"subagent": {
			"web_search": true,
			"mcp": true,
			"tool_search": true,
			"edit": true,
			"bash": true,
			"codemode": true,
			"read": true,
			"write": true,
			"spawn_agent": true,
			"vuln_submit": true,
			"vuln_read": true,
			"poc_read": true,
			"asset_read": true,
			"asset_library_write": true,
			"asset_library_read": true,
			"mitm_read": true
		},
		"commander": {
			"bash": true,
			"read": true
		},
		"subagentMaxTurns": 100,
		"plugins": {
			"main": {
				"key-1": true
			},
			"subagent": {
				"key-1": true
			}
		}
	}
}
```

### `get_notify_config`

取通知配置和最近一次投递的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `notify_config` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `notify_config` 回给发出消息的连接。

```json
{
	"type": "get_notify_config"
}
```

### `save_notify_config`

保存通知配置。

| 项目 | 内容 |
| --- | --- |
| 字段 | `config`：SentinelNotifyConfig |
| 回复请求方 | `notify_config` |
| 广播 | 无 |
| 失败文案 | `{…} / {…}：{error}`、`请填写通知组名称`、`通知组标识重复`、`请填写机器人名称`、`机器人标识重复`、`启用的通知组至少需要一个已启用的机器人` |

处理的结果通过 `notify_config` 回给发出消息的连接。

```json
{
	"type": "save_notify_config",
	"config": {
		"groups": [
			{
				"id": "id-1",
				"name": "示例文本",
				"enabled": true,
				"kinds": {
					"runs": true,
					"vulns": true,
					"codeIntel": true,
					"goals": true,
					"engines": true,
					"pocs": true
				},
				"targets": [
					{
						"id": "id-1",
						"name": "示例文本",
						"channel": "dingtalk",
						"enabled": true,
						"webhook": "https://example.com",
						"secret": "example-credential",
						"keyword": "text"
					}
				]
			}
		],
		"summaryLimit": 3
	}
}
```

### `test_notify`

向一个通知目标发送一条测试消息。

| 项目 | 内容 |
| --- | --- |
| 字段 | `target`：SentinelNotifyTarget |
| 回复请求方 | `notify_test_result` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `notify_test_result` 回给发出消息的连接。

```json
{
	"type": "test_notify",
	"target": {
		"id": "id-1",
		"name": "示例文本",
		"channel": "dingtalk",
		"enabled": true,
		"webhook": "https://example.com",
		"secret": "example-credential",
		"keyword": "text"
	}
}
```

### `list_presets`

取预设 Agent 列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `presets` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `presets` 回给发出消息的连接。

```json
{
	"type": "list_presets"
}
```

### `save_preset`

新建或修改一个预设 Agent。

| 项目 | 内容 |
| --- | --- |
| 字段 | `input`：{ … }；`input.id`（可选）：string；`input.name`：string；`input.description`（可选）：string；`input.tags`（可选）：string[]；`input.placeholder`（可选）：string。The composer hint while this preset is active; omitted or empty keeps the default.；`input.text`：string；`input.enabled`（可选）：boolean |
| 回复请求方 | `error`、`preset_saved` |
| 广播 | `snapshot` |
| 失败文案 | `未配置配置目录，无法保存预设 Agent` |

处理的结果通过 `preset_saved` 回给发出消息的连接。同时向所有控制台广播 `snapshot`。失败的原因写在结果消息的 `error` 字段里：`预设名称不能为空`、`预设名称过长（最多 {max} 字）`、`预设描述过长（最多 {max} 字）`、`输入框提示过长（最多 {max} 字）`、`标签过多（最多 {max} 个）`、`标签过长（最多 {max} 字）：{tag}`、`预设内容不能为空`、`该预设不存在`。

```json
{
	"type": "save_preset",
	"input": {
		"name": "示例文本",
		"description": "nmap -sV -p 443 example.com",
		"tags": [
			"text"
		],
		"placeholder": "text",
		"text": "示例文本",
		"enabled": false
	}
}
```

### `delete_preset`

删除一个预设 Agent。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `preset_deleted` |
| 广播 | `snapshot` |
| 失败文案 | 无 |

处理的结果通过 `preset_deleted` 回给发出消息的连接。同时向所有控制台广播 `snapshot`。失败的原因写在结果消息的 `error` 字段里：`该预设不存在`。

```json
{
	"type": "delete_preset",
	"id": "id-1"
}
```

### `set_preset_enabled`

启用或禁用一个预设 Agent。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`enabled`：boolean |
| 回复请求方 | `error`、`preset_saved` |
| 广播 | `snapshot` |
| 失败文案 | `未配置配置目录，无法修改预设 Agent` |

处理的结果通过 `preset_saved` 回给发出消息的连接。同时向所有控制台广播 `snapshot`。失败的原因写在结果消息的 `error` 字段里：`该预设不存在`。

```json
{
	"type": "set_preset_enabled",
	"id": "id-1",
	"enabled": true
}
```

### `export_presets`

把预设 Agent 导出成文件。

| 项目 | 内容 |
| --- | --- |
| 字段 | `ids`（可选）：string[] |
| 回复请求方 | `error`、`presets_export` |
| 广播 | 无 |
| 失败文案 | `未配置配置目录，无法导出预设 Agent` |

处理的结果通过 `presets_export` 回给发出消息的连接。

```json
{
	"type": "export_presets",
	"ids": [
		"id-1"
	]
}
```

### `import_presets`

从导出的内容导入预设 Agent。

| 项目 | 内容 |
| --- | --- |
| 字段 | `content`：string |
| 回复请求方 | `error`、`presets_imported` |
| 广播 | 无 |
| 失败文案 | `未配置配置目录，无法导入预设 Agent`、`导入失败：文件内容不是合法的 JSON` |

处理的结果通过 `presets_imported` 回给发出消息的连接。失败的原因写在结果消息的 `error` 字段里：`文件内容不是合法的 JSON 对象`、`不是 全链哨兵 预设导出文件`、`不支持的导出版本：{version}`、`文件里没有预设列表`、`预设名称不能为空`、`预设名称过长（最多 {max} 字）`、`预设描述过长（最多 {max} 字）`、`输入框提示过长（最多 {max} 字）`、`标签过多（最多 {max} 个）`、`标签过长（最多 {max} 字）：{tag}`、`预设内容不能为空`、`该预设不存在`。

```json
{
	"type": "import_presets",
	"content": "{\n\t\"format\": \"sentinel-presets\",\n\t\"version\": 1,\n\t\"exportedAt\": 1763973000000,\n\t\"presets\": [\n\t\t{\n\t\t\t\"id\": \"preset-1\",\n\t\t\t\"name\": \"只读侦察\",\n\t\t\t\"description\": \"只做侦察，不改动目标\",\n\t\t\t\"tags\": [\n\t\t\t\t\"recon\"\n\t\t\t],\n\t\t\t\"placeholder\": \"\",\n\t\t\t\"text\": \"只使用只读工具：端口扫描、目录枚举、指纹识别。不执行写入、不利用漏洞。\",\n\t\t\t\"enabled\": true\n\t\t}\n\t]\n}"
}
```

### `list_doctrines`

取指挥思路列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `doctrines` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `doctrines` 回给发出消息的连接。

```json
{
	"type": "list_doctrines"
}
```

### `save_doctrine`

新建或修改一条指挥思路。

| 项目 | 内容 |
| --- | --- |
| 字段 | `input`（可选）：{ id?: string；`name`：string；`text`：string } |
| 回复请求方 | `error`、`doctrine_saved` |
| 广播 | 无 |
| 失败文案 | `未配置配置目录，无法保存指挥思路` |

处理的结果通过 `doctrine_saved` 回给发出消息的连接。失败的原因写在结果消息的 `error` 字段里：`思路名称不能为空`、`思路内容不能为空`、`该思路不存在（内置思路不能修改）`。

```json
{
	"type": "save_doctrine",
	"input": {
		"name": "示例文本",
		"text": "示例文本"
	}
}
```

### `delete_doctrine`

删除一条指挥思路。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `doctrine_deleted` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `doctrine_deleted` 回给发出消息的连接。失败的原因写在结果消息的 `error` 字段里：`未配置配置目录`、`该思路不存在（内置思路不能删除）`。

```json
{
	"type": "delete_doctrine",
	"id": "id-1"
}
```

## 下行消息（服务端 → 浏览器）

### `permissions`

工具权限：主 Agent 与子代理的开关、三个预设，以及当前会话实际挂载的工具。

| 项目 | 内容 |
| --- | --- |
| 字段 | `config`：SentinelPermissionsConfig；`effectiveSubagent`：SentinelPermissionSet；`presets`：SentinelPermissionPreset[]；`tools`：SentinelToolInfo[] |
| 发送时机 | 回复 `get_permissions` 时，只发给发出消息的连接；处理 `save_permissions` 时广播 |

```json
{
	"type": "permissions",
	"config": {
		"main": {
			"web_search": true,
			"mcp": true,
			"tool_search": true,
			"edit": true,
			"bash": true,
			"codemode": true,
			"read": true,
			"write": true,
			"spawn_agent": true,
			"vuln_submit": true,
			"vuln_read": true,
			"poc_read": true,
			"asset_read": true,
			"asset_library_write": true,
			"asset_library_read": true,
			"mitm_read": true
		},
		"subagent": {
			"web_search": true,
			"mcp": true,
			"tool_search": true,
			"edit": true,
			"bash": true,
			"codemode": true,
			"read": true,
			"write": true,
			"spawn_agent": true,
			"vuln_submit": true,
			"vuln_read": true,
			"poc_read": true,
			"asset_read": true,
			"asset_library_write": true,
			"asset_library_read": true,
			"mitm_read": true
		},
		"commander": {
			"bash": true,
			"read": true
		},
		"subagentMaxTurns": 100,
		"plugins": {
			"main": {
				"key-1": true
			},
			"subagent": {
				"key-1": true
			}
		}
	},
	"effectiveSubagent": {
		"web_search": true,
		"mcp": true,
		"tool_search": true,
		"edit": true,
		"bash": true,
		"codemode": true,
		"read": true,
		"write": true,
		"spawn_agent": true,
		"vuln_submit": true,
		"vuln_read": true,
		"poc_read": true,
		"asset_read": true,
		"asset_library_write": true,
		"asset_library_read": true,
		"mitm_read": true
	},
	"presets": [
		{
			"id": "id-1",
			"label": "示例文本",
			"hint": "text",
			"main": {
				"web_search": true,
				"mcp": true,
				"tool_search": true,
				"edit": true,
				"bash": true,
				"codemode": true,
				"read": true,
				"write": true,
				"spawn_agent": true,
				"vuln_submit": true,
				"vuln_read": true,
				"poc_read": true,
				"asset_read": true,
				"asset_library_write": true,
				"asset_library_read": true,
				"mitm_read": true
			},
			"subagent": {
				"web_search": true,
				"mcp": true,
				"tool_search": true,
				"edit": true,
				"bash": true,
				"codemode": true,
				"read": true,
				"write": true,
				"spawn_agent": true,
				"vuln_submit": true,
				"vuln_read": true,
				"poc_read": true,
				"asset_read": true,
				"asset_library_write": true,
				"asset_library_read": true,
				"mitm_read": true
			},
			"commander": {
				"bash": true,
				"read": true
			}
		}
	],
	"tools": [
		{
			"name": "示例文本",
			"source": "text",
			"active": true
		}
	]
}
```

### `notify_config`

通知配置，以及有投递结果时最近一次的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `config`：SentinelNotifyConfig；`status`：SentinelNotifyStatus |
| 发送时机 | 回复 `get_notify_config`、`save_notify_config` 时，只发给发出消息的连接；运行时钩子 `onNotifyStatus` 触发时广播 |

```json
{
	"type": "notify_config",
	"config": {
		"groups": [
			{
				"id": "id-1",
				"name": "示例文本",
				"enabled": true,
				"kinds": {
					"runs": true,
					"vulns": true,
					"codeIntel": true,
					"goals": true,
					"engines": true,
					"pocs": true
				},
				"targets": [
					{
						"id": "id-1",
						"name": "示例文本",
						"channel": "dingtalk",
						"enabled": true,
						"webhook": "https://example.com",
						"secret": "example-credential",
						"keyword": "text"
					}
				]
			}
		],
		"summaryLimit": 3
	},
	"status": {
		"at": 1763973000000,
		"ok": true,
		"error": "示例错误信息",
		"subject": "text",
		"deliveries": [
			{
				"groupId": "group-1",
				"groupName": "示例文本",
				"targetId": "target-1",
				"targetName": "示例文本",
				"channel": "dingtalk",
				"ok": true
			}
		]
	}
}
```

### `notify_test_result`

一条测试通知的发送结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `result`：SentinelTestResult |
| 发送时机 | 回复 `test_notify` 时，只发给发出消息的连接 |

```json
{
	"type": "notify_test_result",
	"result": {
		"ok": true,
		"message": "示例文本",
		"detail": "示例文本"
	}
}
```

### `presets`

预设 Agent 列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `presets`：SentinelPresetView[] |
| 发送时机 | 回复 `list_presets` 时，只发给发出消息的连接 |

```json
{
	"type": "presets",
	"presets": [
		{
			"text": "示例文本",
			"textMissing": true,
			"tokens": 2,
			"id": "id-1",
			"name": "示例文本",
			"description": "nmap -sV -p 443 example.com",
			"tags": [
				"text"
			],
			"placeholder": "text",
			"enabled": true,
			"createdAt": 1763973000000,
			"updatedAt": 1763973000000
		}
	]
}
```

### `preset_saved`

一条预设 Agent 保存后的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `preset`：SentinelPresetView | null；`error`（可选）：string |
| 发送时机 | 回复 `save_preset`、`set_preset_enabled` 时，只发给发出消息的连接 |

```json
{
	"type": "preset_saved",
	"preset": {
		"text": "示例文本",
		"textMissing": true,
		"tokens": 2,
		"id": "id-1",
		"name": "示例文本",
		"description": "nmap -sV -p 443 example.com",
		"tags": [
			"text"
		],
		"placeholder": "text",
		"enabled": true,
		"createdAt": 1763973000000,
		"updatedAt": 1763973000000
	},
	"error": "示例错误信息"
}
```

### `preset_deleted`

一条预设 Agent 删除后的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`ok`：boolean；`error`（可选）：string |
| 发送时机 | 回复 `delete_preset` 时，只发给发出消息的连接 |

```json
{
	"type": "preset_deleted",
	"id": "id-1",
	"ok": true,
	"error": "示例错误信息"
}
```

### `presets_export`

预设 Agent 的导出内容。

| 项目 | 内容 |
| --- | --- |
| 字段 | `filename`：string；`content`：string |
| 发送时机 | 回复 `export_presets` 时，只发给发出消息的连接 |

```json
{
	"type": "presets_export",
	"filename": "sentinel-presets-2026-11-24.json",
	"content": "{\n\t\"format\": \"sentinel-presets\",\n\t\"version\": 1,\n\t\"exportedAt\": 1763973000000,\n\t\"presets\": [\n\t\t{\n\t\t\t\"id\": \"preset-1\",\n\t\t\t\"name\": \"只读侦察\",\n\t\t\t\"description\": \"只做侦察，不改动目标\",\n\t\t\t\"tags\": [\n\t\t\t\t\"recon\"\n\t\t\t],\n\t\t\t\"placeholder\": \"\",\n\t\t\t\"text\": \"只使用只读工具：端口扫描、目录枚举、指纹识别。不执行写入、不利用漏洞。\",\n\t\t\t\"enabled\": true\n\t\t}\n\t]\n}"
}
```

### `presets_imported`

预设 Agent 导入的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `imported`：SentinelPresetView[]；`skipped`：Array<{ name: string; reason: string }>；`error`（可选）：string |
| 发送时机 | 回复 `import_presets` 时，只发给发出消息的连接 |

```json
{
	"type": "presets_imported",
	"imported": [
		{
			"text": "示例文本",
			"textMissing": true,
			"tokens": 2,
			"id": "id-1",
			"name": "示例文本",
			"description": "nmap -sV -p 443 example.com",
			"tags": [
				"text"
			],
			"placeholder": "text",
			"enabled": true,
			"createdAt": 1763973000000,
			"updatedAt": 1763973000000
		}
	],
	"skipped": [
		{
			"name": "示例文本",
			"reason": "示例错误信息"
		}
	],
	"error": "示例错误信息"
}
```

### `doctrines`

指挥思路列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `doctrines`：SentinelDoctrineView[] |
| 发送时机 | 回复 `list_doctrines` 时，只发给发出消息的连接；连接建立时发给新连接 |

```json
{
	"type": "doctrines",
	"doctrines": [
		{
			"id": "id-1",
			"name": "示例文本",
			"text": "示例文本",
			"builtin": true
		}
	]
}
```

### `doctrine_saved`

一条指挥思路保存后的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `doctrine`：SentinelDoctrineView；`error`（可选）：string |
| 发送时机 | 回复 `save_doctrine` 时，只发给发出消息的连接 |

```json
{
	"type": "doctrine_saved",
	"doctrine": {
		"id": "id-1",
		"name": "示例文本",
		"text": "示例文本",
		"builtin": true
	},
	"error": "示例错误信息"
}
```

### `doctrine_deleted`

一条指挥思路删除后的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`ok`：boolean；`error`（可选）：string |
| 发送时机 | 回复 `delete_doctrine` 时，只发给发出消息的连接 |

```json
{
	"type": "doctrine_deleted",
	"id": "id-1",
	"ok": true,
	"error": "示例错误信息"
}
```
