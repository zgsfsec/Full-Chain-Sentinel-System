# 模型与角色

本域管理模型库。一条模型是 Base URL、模型 ID 和 API Key 的组合；七个角色（主模型、守门、漏洞评审、监督、指挥、监测、工程）各自指向一条模型，或者「跟随主模型」。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 10 种 |
| 下行消息 | 5 种 |
| 处理代码 | `packages/web/src/server.ts` 第 2196–2253 行 |
| 运行时方法 | `packages/web/src/sentinel-session.ts` 的 `getModelLibrary` 到 `setReviewerAuto`，第 4570–4683 行 |
| 存取函数 | `packages/web/src/model-library.ts` |

字段形状以两份类型文件为准，本域涉及的类型在两边结构一致：

- 服务端视角：`packages/web/src/protocol.ts` 的 `SentinelModelLibraryView`、`SentinelModelEntryView`、`SentinelBuiltinModelDefaults`、`SentinelBuiltinChannel`、`SentinelBuiltinModelPreset`、`SentinelTestResult`（第 159–354 行）。
- 浏览器视角：`packages/web/webui/src/types.ts` 里的同名类型。

通用约定见 [README](README.md)。每个上行消息下面的表里：

- 「回复请求方」只发给发出这条消息的连接。
- 「广播」发给所有已连接的控制台，包括发出消息的那个。
- 「失败文案」列出处理这条消息时可能回给浏览器的 `error` 文案。花括号是占位符。

## 角色的取值

`roles` 里每个角色有三种取值：

| 取值 | 含义 |
| --- | --- |
| 条目的 `id` | 指向模型库里的一条模型 |
| `"follow-main"` | 跟随主模型。只有主模型以外的六个角色可以用 |
| `null` | 没有设置。只有主模型可以用 |

`resolved` 给出每个角色此刻实际解析到的端点，`followedMain` 为 `true` 表示它是通过主模型解析出来的。主模型为 `null` 时，跟随它的角色也解析不到任何端点，`resolved` 里对应的位置是 `null`。

## 上行消息（浏览器 → 服务端）

### `get_model_library`

取整个模型库视图：条目、角色指向、每个角色当前解析到的端点。第一次读取时，如果还没有模型库文件，会把旧版的三槽位配置迁移成库条目再返回。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `model_library` |
| 广播 | 无 |
| 失败文案 | 无 |

```json
{
	"type": "get_model_library"
}
```

### `lookup_model_defaults`

按模型 ID 和 Base URL 在内置目录里查找能力模板，供编辑表单预填。只读，不写任何文件。服务端加载不出模型运行时时，`matches` 是空数组。

| 项目 | 内容 |
| --- | --- |
| 字段 | `modelId` 模型 ID；`baseUrl` 端点，用于匹配同一模型的不同服务商 |
| 回复请求方 | `model_defaults` |
| 广播 | 无 |
| 失败文案 | 无 |

```json
{
	"type": "lookup_model_defaults",
	"modelId": "deepseek-chat",
	"baseUrl": "https://api.deepseek.com/v1"
}
```

### `list_model_channels`

列出内置目录里的渠道（服务商），供「添加模型」的第一级选择。`query` 同时匹配渠道名和模型名，例如输入 `claude` 也能找到 Anthropic。

| 项目 | 内容 |
| --- | --- |
| 字段 | `requestId` 请求序号，原样带回；`query` 搜索词 |
| 回复请求方 | `model_channels` |
| 广播 | 无 |
| 失败文案 | 无 |

```json
{
	"type": "list_model_channels",
	"requestId": 7,
	"query": "deepseek"
}
```

### `list_channel_models`

列出一个渠道下的模型，供第二级选择。返回的每一项都是可以直接填进表单的预设。

| 项目 | 内容 |
| --- | --- |
| 字段 | `requestId` 请求序号，原样带回；`provider` 渠道 ID，取自 `model_channels` 里的 `provider` |
| 回复请求方 | `channel_models` |
| 广播 | 无 |
| 失败文案 | 无 |

```json
{
	"type": "list_channel_models",
	"requestId": 8,
	"provider": "deepseek"
}
```

### `save_model_entry`

新增一条模型，或按 `id` 修改已有的一条。带 `id` 修改一条不存在的模型时，服务端回 `error`。每次改动后都把完整的库视图回给浏览器，页面不需要猜测服务端做了什么（分配的 `id`、角色占用、解析结果都在视图里）。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id` 可选，有值是修改，没有是新增；`name`、`baseUrl`、`modelId` 必填；`apiKey` 为 `null` 表示保留已保存的密钥（修改时），新增时写成空串；`capabilities` 可选，声明上下文窗口、最大输出、推理开关、输入类型、价格等 |
| 回复请求方 | `error`、`model_library` |
| 广播 | `snapshot` |
| 失败文案 | `模型不存在，可能已被删除` |

```json
{
	"type": "save_model_entry",
	"name": "DeepSeek",
	"baseUrl": "https://api.deepseek.com/v1",
	"apiKey": "sk-example",
	"modelId": "deepseek-chat"
}
```

新增的第一条模型自动成为主模型。改动的生效时间：

- 下一次创建会话时重新读取模型配置，正在运行的会话不受影响。
- 工程模式的管理器会收到「模型配置已变」的标记。

### `remove_model_entry`

删除一条模型和它保存的端点配置。被任何角色指向的模型不能删除，服务端回 `error` 并在文案里点名是哪些角色在用。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id` 模型库条目 ID |
| 回复请求方 | `error`、`model_library` |
| 广播 | `snapshot` |
| 失败文案 | `「{name}」正被 {roles} 使用，请先改掉这些角色再删除`、`模型不存在，可能已被删除` |

```json
{
	"type": "remove_model_entry",
	"id": "m-2"
}
```

### `duplicate_model_entry`

复制一条模型。新条目沿用原条目的端点配置，名称是原名称加「副本」，`id` 由服务端分配，不占用任何角色。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id` 要复制的条目 ID |
| 回复请求方 | `error`、`model_library` |
| 广播 | `snapshot` |
| 失败文案 | `这个模型没有可复制的端点配置`、`模型不存在，可能已被删除` |

```json
{
	"type": "duplicate_model_entry",
	"id": "m-1"
}
```

### `set_model_role`

把一个角色指向一条模型、「跟随主模型」，或（仅主模型）清空。结果广播给所有控制台，发出消息的那个也会收到。

| 项目 | 内容 |
| --- | --- |
| 字段 | `role` 角色名；`target` 条目 ID、`"follow-main"` 或 `null`，含义见上面「角色的取值」 |
| 回复请求方 | `error` |
| 广播 | `model_library`、`snapshot` |
| 失败文案 | `主模型不能跟随主模型`、`这个角色必须选择一条模型或跟随主模型`、`模型不存在，可能已被删除` |

```json
{
	"type": "set_model_role",
	"role": "judge",
	"target": "m-1"
}
```

改的是主模型且当前有活动会话时，服务端先给这个会话换上新的主模型，再回复。

### `set_reviewer_auto`

开关「漏洞自动评审」。关闭时顺带清掉还没处理的评审队列。

| 项目 | 内容 |
| --- | --- |
| 字段 | `enabled` 开或关 |
| 回复请求方 | `model_library` |
| 广播 | `snapshot` |
| 失败文案 | 无 |

```json
{
	"type": "set_reviewer_auto",
	"enabled": false
}
```

### `test_model_entry`

用一条已保存模型的端点配置发一次探测请求，不保存任何改动。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id` 模型库条目 ID |
| 回复请求方 | `model_test_result` |
| 广播 | 无 |
| 失败文案 | 无 |

```json
{
	"type": "test_model_entry",
	"id": "m-1"
}
```

这条模型没有可用的端点配置时，不回 `error`，而是回 `model_test_result`，其中 `result.ok` 为 `false`、`result.message` 为 `这个模型没有可用的端点配置`。

## 下行消息（服务端 → 浏览器）

### `model_library`

完整的模型库视图。`entries` 是全部条目；`entries[].hasKey` 只说明是否存了密钥，密钥本身永远不发给浏览器；`entries[].customHeaders` 只有请求头的名称，没有值。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 回复 `get_model_library`、`save_model_entry`、`remove_model_entry`、`duplicate_model_entry`、`set_reviewer_auto`；广播 `set_model_role` 的结果 |

```json
{
	"type": "model_library",
	"library": {
		"entries": [
			{
				"id": "m-1",
				"name": "DeepSeek",
				"baseUrl": "https://api.deepseek.com/v1",
				"modelId": "deepseek-chat",
				"hasKey": true,
				"roles": [
					"main"
				],
				"api": "openai-completions",
				"contextWindow": 128000,
				"maxTokens": 8192,
				"reasoning": false,
				"input": [
					"text"
				],
				"cost": {
					"input": 0.14,
					"output": 0.28,
					"cacheRead": 0.035,
					"cacheWrite": 0.14
				},
				"promptCache": null
			}
		],
		"roles": {
			"main": "m-1",
			"judge": "follow-main",
			"reviewer": "follow-main",
			"supervisor": "follow-main",
			"commander": "follow-main",
			"monitor": "follow-main",
			"workprocess": "follow-main"
		},
		"reviewerAuto": true,
		"resolved": {
			"main": {
				"entryId": "m-1",
				"entryName": "DeepSeek",
				"modelId": "deepseek-chat",
				"followedMain": false
			},
			"judge": {
				"entryId": "m-1",
				"entryName": "DeepSeek",
				"modelId": "deepseek-chat",
				"followedMain": true
			},
			"reviewer": {
				"entryId": "m-1",
				"entryName": "DeepSeek",
				"modelId": "deepseek-chat",
				"followedMain": true
			},
			"supervisor": {
				"entryId": "m-1",
				"entryName": "DeepSeek",
				"modelId": "deepseek-chat",
				"followedMain": true
			},
			"commander": {
				"entryId": "m-1",
				"entryName": "DeepSeek",
				"modelId": "deepseek-chat",
				"followedMain": true
			},
			"monitor": {
				"entryId": "m-1",
				"entryName": "DeepSeek",
				"modelId": "deepseek-chat",
				"followedMain": true
			},
			"workprocess": {
				"entryId": "m-1",
				"entryName": "DeepSeek",
				"modelId": "deepseek-chat",
				"followedMain": true
			}
		}
	}
}
```

### `model_defaults`

内置目录里与查询匹配的能力模板。`matches[].approximate` 为 `true` 表示目录里没有完全相同的模型 ID，这一项只是近似匹配，表单可以把它作为一种选择而不是直接套用。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 回复 `lookup_model_defaults` |

```json
{
	"type": "model_defaults",
	"modelId": "deepseek-chat",
	"matches": [
		{
			"provider": "deepseek",
			"providerName": "DeepSeek",
			"modelId": "deepseek-chat",
			"api": "openai-completions",
			"contextWindow": 128000,
			"maxTokens": 8192,
			"reasoning": false,
			"defaultThinkingLevel": "off",
			"availableThinkingLevels": [
				"off"
			],
			"thinkingLevelMap": null,
			"compat": null,
			"input": [
				"text"
			],
			"cost": {
				"input": 0.14,
				"output": 0.28,
				"cacheRead": 0.035,
				"cacheWrite": 0.14
			},
			"promptCache": null
		}
	]
}
```

### `model_channels`

内置目录里的渠道列表。`baseUrls` 是这个渠道的全部端点变体，`baseUrl` 是其中用于显示的那个。`featured` 为 `true` 的渠道显示在「更多渠道」之前。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 回复 `list_model_channels` |

```json
{
	"type": "model_channels",
	"requestId": 7,
	"query": "deepseek",
	"channels": [
		{
			"provider": "deepseek",
			"name": "DeepSeek",
			"api": "openai-completions",
			"baseUrl": "https://api.deepseek.com/v1",
			"baseUrls": [
				"https://api.deepseek.com/v1"
			],
			"modelCount": 2,
			"featured": true
		}
	]
}
```

### `channel_models`

一个渠道下的模型预设。比能力模板多 `name` 和 `baseUrl`，用来预填一个空的表单。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 回复 `list_channel_models` |

```json
{
	"type": "channel_models",
	"requestId": 8,
	"provider": "deepseek",
	"presets": [
		{
			"provider": "deepseek",
			"providerName": "DeepSeek",
			"modelId": "deepseek-chat",
			"api": "openai-completions",
			"contextWindow": 128000,
			"maxTokens": 8192,
			"reasoning": false,
			"defaultThinkingLevel": "off",
			"availableThinkingLevels": [
				"off"
			],
			"thinkingLevelMap": null,
			"compat": null,
			"input": [
				"text"
			],
			"cost": {
				"input": 0.14,
				"output": 0.28,
				"cacheRead": 0.035,
				"cacheWrite": 0.14
			},
			"promptCache": null,
			"name": "DeepSeek V3",
			"baseUrl": "https://api.deepseek.com/v1"
		}
	]
}
```

### `model_test_result`

一次端点探测的结果。`result.message` 是给人看的结论，`result.detail` 是技术细节，例如响应正文的片段或出错原因。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 回复 `test_model_entry` |

```json
{
	"type": "model_test_result",
	"result": {
		"ok": true,
		"message": "连接成功，模型可用"
	}
}
```
