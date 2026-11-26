# 资产测绘与 Web 搜索配置

资产测绘接入 FOFA、360 Quake 和奇安信 Hunter，Web 搜索使用 Tavily。密钥保存在服务端，永不回显给浏览器。只有「已启用、已配置密钥、已验证通过」的平台才会把对应工具挂给 Agent。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 9 种 |
| 下行消息 | 4 种 |
| 处理代码 | `packages/web/src/server.ts` 第 2688–2690、2691–2701、2702–2710、2711–2722、2723–2725、2726–2739、2740–2749、2750–2759、2760–2765 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `get_asset_config`

取资产测绘平台的配置：是否启用、是否已验证、额度。密钥不回显。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `asset_config` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `asset_config` 回给发出消息的连接。

```json
{
	"type": "get_asset_config"
}
```

### `save_asset_platform`

保存一个资产测绘平台的配置，并验证一次。

| 项目 | 内容 |
| --- | --- |
| 字段 | `platform`：SentinelAssetPlatformInput |
| 回复请求方 | `error` |
| 广播 | `asset_config`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `asset_config`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "save_asset_platform",
	"platform": {
		"id": "hunter",
		"enabled": true,
		"key": "example-hunter-key",
		"baseUrl": "https://hunter.example.com"
	}
}
```

### `set_asset_query_limit`

设置每个会话的测绘查询次数上限。

| 项目 | 内容 |
| --- | --- |
| 字段 | `limit`：number |
| 回复请求方 | `error` |
| 广播 | `asset_config`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `asset_config`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "set_asset_query_limit",
	"limit": 50
}
```

### `test_asset_platform`

测试一个资产测绘平台的连接。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `asset_test_result` |
| 广播 | `asset_config`、`snapshot` |
| 失败文案 | 无 |

处理的结果通过 `asset_test_result` 回给发出消息的连接。同时向所有控制台广播 `asset_config`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "test_asset_platform",
	"platform": "hunter",
	"key": "example-hunter-key",
	"baseUrl": "https://hunter.example.com"
}
```

### `get_websearch_config`

取 Web 搜索的配置：各密钥的状态和查询上限。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `websearch_config` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `websearch_config` 回给发出消息的连接。

```json
{
	"type": "get_websearch_config"
}
```

### `save_websearch_key`

保存一个 Web 搜索密钥。

| 项目 | 内容 |
| --- | --- |
| 字段 | `key`：SentinelWebSearchKeyInput |
| 回复请求方 | `error` |
| 广播 | `websearch_config`、`snapshot` |
| 失败文案 | `{path} 无法解析，请先修复或删除该文件再保存`、`新 Key 必须填写密钥`、`号池最多 {max} 个 Key`、`有会话正在运行，请先中止再修改{what}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `websearch_config`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "save_websearch_key",
	"key": {
		"label": "备用账号",
		"key": "tvly-example-key-c77d",
		"enabled": true
	}
}
```

### `delete_websearch_key`

删除一个 Web 搜索密钥。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error` |
| 广播 | `websearch_config`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `websearch_config`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "delete_websearch_key",
	"id": "tvk-8d3b7e41"
}
```

### `set_websearch_query_limit`

设置每个会话的 Web 搜索次数上限。

| 项目 | 内容 |
| --- | --- |
| 字段 | `limit`：number |
| 回复请求方 | `error` |
| 广播 | `websearch_config`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `websearch_config`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "set_websearch_query_limit",
	"limit": 100
}
```

### `test_websearch_key`

测试一个 Web 搜索密钥。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`（可选）：string；`key`（可选）：string |
| 回复请求方 | `websearch_test_result` |
| 广播 | `websearch_config`、`snapshot` |
| 失败文案 | 无 |

处理的结果通过 `websearch_test_result` 回给发出消息的连接。同时向所有控制台广播 `websearch_config`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "test_websearch_key",
	"id": "tvk-5f1c9a2e"
}
```

## 下行消息（服务端 → 浏览器）

### `asset_config`

资产测绘平台的配置。密钥不回显。

| 项目 | 内容 |
| --- | --- |
| 字段 | `config`：SentinelAssetConfigView |
| 发送时机 | 回复 `get_asset_config` 时，只发给发出消息的连接；处理 `save_asset_platform`、`set_asset_query_limit`、`test_asset_platform` 时广播；连接建立时发给新连接 |

```json
{
	"type": "asset_config",
	"config": {
		"platforms": [
			{
				"id": "fofa",
				"label": "FOFA",
				"enabled": true,
				"hasKey": true,
				"baseUrl": "",
				"verified": true,
				"status": {
					"at": 1795489925000,
					"ok": true,
					"quota": "免费点 1500 · F 点 39366"
				}
			},
			{
				"id": "quake",
				"label": "360 Quake",
				"enabled": false,
				"hasKey": false,
				"baseUrl": "",
				"verified": false,
				"status": {
					"at": null,
					"ok": true
				}
			},
			{
				"id": "hunter",
				"label": "奇安信 Hunter",
				"enabled": true,
				"hasKey": true,
				"baseUrl": "https://hunter.example.com",
				"verified": false,
				"status": {
					"at": 1795502418000,
					"ok": false,
					"error": "网络错误：getaddrinfo ENOTFOUND hunter.example.com"
				}
			}
		],
		"sessionQueryLimit": 50,
		"usable": 1
	}
}
```

### `asset_test_result`

一个资产测绘平台的测试结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `platform`：SentinelAssetPlatform；`result`：SentinelTestResult |
| 发送时机 | 回复 `test_asset_platform` 时，只发给发出消息的连接 |

```json
{
	"type": "asset_test_result",
	"platform": "hunter",
	"result": {
		"ok": false,
		"message": "连接失败：网络错误：getaddrinfo ENOTFOUND hunter.example.com",
		"detail": "网络错误：getaddrinfo ENOTFOUND hunter.example.com"
	}
}
```

### `websearch_config`

Web 搜索的配置。密钥不回显。

| 项目 | 内容 |
| --- | --- |
| 字段 | `config`：SentinelWebSearchConfigView |
| 发送时机 | 回复 `get_websearch_config` 时，只发给发出消息的连接；处理 `save_websearch_key`、`delete_websearch_key`、`set_websearch_query_limit`、`test_websearch_key` 时广播；连接建立时发给新连接 |

```json
{
	"type": "websearch_config",
	"config": {
		"keys": [
			{
				"id": "tvk-5f1c9a2e",
				"label": "主账号",
				"enabled": true,
				"hasKey": true,
				"verified": true,
				"status": {
					"at": 1795496561000,
					"ok": true,
					"quota": "套餐 Free · 已用 12 / 1000"
				},
				"tail": "9f2a",
				"usage": {
					"remaining": 988,
					"limit": 1000
				}
			},
			{
				"id": "tvk-8d3b7e41",
				"label": "备用账号",
				"enabled": false,
				"hasKey": true,
				"verified": false,
				"status": {
					"at": 1795501869000,
					"ok": false,
					"error": "API Key 无效或已过期（HTTP 401）"
				},
				"tail": "c77d"
			}
		],
		"sessionQueryLimit": 100,
		"usable": 1
	}
}
```

### `websearch_test_result`

一个 Web 搜索密钥的测试结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `result`：SentinelTestResult |
| 发送时机 | 回复 `test_websearch_key` 时，只发给发出消息的连接 |

```json
{
	"type": "websearch_test_result",
	"result": {
		"ok": true,
		"message": "Tavily 连接正常（套餐 Free · 本套餐已用 12 / 1000 · 剩余 988）"
	}
}
```
