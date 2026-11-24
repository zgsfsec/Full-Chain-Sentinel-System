# 凭证、报告开关与 MCP 服务器

本域是三样彼此独立的配置：项目的凭证功能及验证、报告中心的开关、MCP 服务器。凭证的增删改和报告的归档走 HTTP（`/api/credentials`、`/api/reports`），这里只有开关和验证。保存或删除 MCP 服务器会重建活动会话，有会话在运行时拒绝。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 8 种 |
| 下行消息 | 2 种 |
| 处理代码 | `packages/web/src/server.ts` 第 2770–2772、2773–2783、2784–2792、2793–2802、2803–2813、3805–3808、3809–3812、3813–3822 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `get_mcp_servers`

取 MCP 服务器列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `mcp_servers` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `mcp_servers` 回给发出消息的连接。

```json
{
	"type": "get_mcp_servers"
}
```

### `save_mcp_server`

新建或修改一个 MCP 服务器。保存后重建活动会话。

| 项目 | 内容 |
| --- | --- |
| 字段 | `server`：SentinelMcpServerInput |
| 回复请求方 | `error` |
| 广播 | `mcp_servers`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `mcp_servers`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "save_mcp_server",
	"server": {
		"name": "example-mcp",
		"enabled": true,
		"transport": "sse",
		"command": "curl -s https://example.com/",
		"args": [
			"text"
		],
		"env": {
			"key-1": "text"
		},
		"cwd": "/work",
		"url": "https://example.com",
		"headers": {
			"key-1": "text"
		},
		"description": "nmap -sV -p 443 example.com",
		"exposure": "deferred",
		"timeout": 2,
		"hostExecAcknowledged": true
	}
}
```

### `delete_mcp_server`

删除一个 MCP 服务器。

| 项目 | 内容 |
| --- | --- |
| 字段 | `name`：string |
| 回复请求方 | `error` |
| 广播 | `mcp_servers`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `mcp_servers`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "delete_mcp_server",
	"name": "示例文本"
}
```

### `set_mcp_server_enabled`

启用或禁用一个 MCP 服务器。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `error` |
| 广播 | `mcp_servers`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}`、`{path} 无法解析，请先修复或删除该文件再修改` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `mcp_servers`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "set_mcp_server_enabled",
	"name": "example-mcp",
	"enabled": true
}
```

### `test_mcp_server`

测试一个 MCP 服务器的连接。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `mcp_test_result` |
| 广播 | `mcp_servers` |
| 失败文案 | 无 |

处理的结果通过 `mcp_test_result` 回给发出消息的连接。同时向所有控制台广播 `mcp_servers`。

```json
{
	"type": "test_mcp_server",
	"name": "示例文本",
	"draft": {
		"name": "示例文本",
		"enabled": true,
		"transport": "sse",
		"command": "curl -s https://example.com/",
		"args": [
			"text"
		],
		"env": {
			"key-1": "text"
		},
		"cwd": "/work",
		"url": "https://example.com",
		"headers": {
			"key-1": "text"
		},
		"description": "nmap -sV -p 443 example.com",
		"exposure": "deferred",
		"timeout": 2,
		"hostExecAcknowledged": true
	}
}
```

### `credentials_set_enabled`

开关当前项目的凭证功能。要先选中项目里的一个普通对话，工程任务的会话不行。

| 项目 | 内容 |
| --- | --- |
| 字段 | `enabled`：boolean |
| 回复请求方 | 无 |
| 广播 | `snapshot` |
| 失败文案 | `凭据开关格式错误`、`请先选择项目中的普通对话` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "credentials_set_enabled",
	"enabled": true
}
```

### `reports_set_enabled`

开关报告中心，可以同时指定默认模板。要先选中项目里的一个普通对话，工程任务的会话不行。

| 项目 | 内容 |
| --- | --- |
| 字段 | `enabled`：boolean；`templateId`（可选）：string | null |
| 回复请求方 | 无 |
| 广播 | `snapshot` |
| 失败文案 | `报告中心开关格式错误`、`请先选择项目中的普通对话`、`报告模板选择格式错误`、`会话正在运行，请结束或中止后再选择报告模板`、`请先选择项目` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "reports_set_enabled",
	"enabled": true
}
```

### `credentials_verify`

验证当前项目的凭证是否可用。

| 项目 | 内容 |
| --- | --- |
| 字段 | `projectId`：string；`refs`：{ id: string；`revision`：string }[] |
| 回复请求方 | `error` |
| 广播 | `environment`、`sessions`、`session_event`、`snapshot` |
| 失败文案 | `环境检查未通过`、`Docker 环境不可用（{detail}）。请在「设置 → 环境」中修复后复检。`、`项目已切换，请重新选择凭据`、`正在创建凭据验证对话，请稍后重试`、`凭据已修改，请刷新后重新选择`、`项目或对话已切换，请重新发起验证`、`请选择 1–1000 条凭据`、`凭据选择格式错误或重复`、`凭据开关格式错误`、`请先选择项目中的普通对话`、`请先创建或选择一个项目`、`会话尚未就绪，请重新选择项目`、`正在压缩上下文，暂时不能发送；可等待压缩完成，或点「中止压缩」放弃这次压缩` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `environment`。状态实际发生变化时，还会向所有控制台广播 `sessions`、`session_event`、`snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "credentials_verify",
	"projectId": "project-1",
	"refs": [
		{
			"id": "id-1",
			"revision": "text"
		}
	]
}
```

## 下行消息（服务端 → 浏览器）

### `mcp_servers`

MCP 服务器列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `config`：SentinelMcpConfigView |
| 发送时机 | 回复 `get_mcp_servers` 时，只发给发出消息的连接；处理 `save_mcp_server`、`delete_mcp_server`、`set_mcp_server_enabled`、`test_mcp_server` 时广播；连接建立时发给新连接 |

```json
{
	"type": "mcp_servers",
	"config": {
		"servers": [
			{
				"name": "示例文本",
				"enabled": true,
				"transport": "sse",
				"target": "text",
				"command": "curl -s https://example.com/",
				"args": [
					"text"
				],
				"env": {
					"key-1": "text"
				},
				"cwd": "/work",
				"url": "https://example.com",
				"headers": {
					"key-1": "text"
				},
				"description": "nmap -sV -p 443 example.com",
				"exposure": "deferred",
				"timeout": 2,
				"hostExecAcknowledged": true,
				"status": {
					"at": 1763973000000,
					"ok": true
				}
			}
		],
		"mounted": 2,
		"permissionOn": true,
		"path": "/work/evidence/notes.md"
	}
}
```

### `mcp_test_result`

一个 MCP 服务器的连接测试结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `name`：string；`result`：SentinelMcpTestResult |
| 发送时机 | 回复 `test_mcp_server` 时，只发给发出消息的连接 |

```json
{
	"type": "mcp_test_result",
	"name": "示例文本",
	"result": {
		"state": "connected",
		"tools": [
			"text"
		],
		"resources": 2,
		"instructions": "text",
		"ok": true,
		"message": "示例文本",
		"detail": "示例文本"
	}
}
```
