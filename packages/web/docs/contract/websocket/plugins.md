# 插件与插件主机

插件运行在插件主机上，主机可以是本机也可以是远端。控制台负责主机、安装、启停和配置；插件的界面通过 HTTP 加载，令牌由 `plugin_ui_open` 发出。任何改动之后都会广播新的 `plugins` 视图。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 20 种 |
| 下行消息 | 9 种 |
| 处理代码 | `packages/web/src/server.ts` 第 2810–2813、2814–2821、2822–2829、2830–2838、2839–2851、2852–2868、2869–2879、2880–2887、2888–2895、2896–2920、2921–2924、2925–2948、2949–2959、2960–2970、2971–2981、2982–2993、2994–3017、3018–3031、3032–3045、3046–3060 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `get_plugins`

取插件中心的全貌：插件主机、插件和问题列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `plugins` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `plugins` 回给发出消息的连接。

```json
{
	"type": "get_plugins"
}
```

### `save_plugin_host`

新建或修改一个插件主机。

| 项目 | 内容 |
| --- | --- |
| 字段 | `host`：SentinelPluginHostInput |
| 回复请求方 | `error` |
| 广播 | `plugins` |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。同时向所有控制台广播 `plugins`。失败时把异常的原文作为 `error` 的文案返回，所以文案取决于出错的操作，不是固定的句子。

```json
{
	"type": "save_plugin_host",
	"host": {
		"name": "VPS 插件主机",
		"url": "https://plugin-host.example.com",
		"token": "sph_7QmZ0xWv7TqLpR2sYnE4fA1bHcDuKj9LgVbNrT8sXwZ"
	}
}
```

### `delete_plugin_host`

删除一个插件主机。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error` |
| 广播 | `plugins`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `plugins`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "delete_plugin_host",
	"id": "host-1lig2n6"
}
```

### `test_plugin_host`

测试一个插件主机的连接。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error` |
| 广播 | `plugins` |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。同时向所有控制台广播 `plugins`。失败时把异常的原文作为 `error` 的文案返回，所以文案取决于出错的操作，不是固定的句子。

```json
{
	"type": "test_plugin_host",
	"id": "host-1ke1zl3"
}
```

### `inspect_plugin_package`

解析一个上传的插件包并返回它的清单，不安装。

| 项目 | 内容 |
| --- | --- |
| 字段 | `name`：string；`data`：string |
| 回复请求方 | `plugin_manifest`、`error` |
| 广播 | 无 |
| 失败文案 | `只支持 .zip：插件包必须包含 Dockerfile 和构建上下文`、`插件包里的文件超过 {count} 个，这不像是插件包`、`插件包的根目录（或一层子目录）里没有 plugin.json`、`插件包里没有 Dockerfile：{file}`、`插件包里没有构建上下文目录：{path}`、`插件包「{name}」不是合法的 base64`、`插件包「{name}」为空`、`插件包超过 {size}MB 上限`、`插件包「{name}」里的 plugin.json 不是合法 JSON` |

处理的结果通过 `plugin_manifest` 回给发出消息的连接。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "inspect_plugin_package",
	"name": "recon-toolkit-0.2.0.zip",
	"data": "UEsDBBQAAAAIAAAAAADGx+gMZQAAAGwAAAAKAAAARG9ja2VyZmlsZXML8vdVSM/PScxLtzLUMzLiCvcP8nbxDFLQTywo4HL2D4hU0FPQ4woK9VNIz1dIKs3MSVHQzVfQL0pNzs9T0NNPzk2BsLlcIwL8g10VzC0MDLlc/UKCIgP8Pf1CFKKVIPJKsVwAUEsDBBQAAAAIAAAAAAAHAOZylQMAACwHAAALAAAAcGx1Z2luLmpzb26NVVFvE0cQfj7/Cuueg312G4j8ljZuG7WJUbDaB4Ss9d7Yt/Le7nV3z02KItFCChQaB1URSgKkpWoLRSVVJSgNKX+mvjM88Req3b1zwIEqjzvf7Mw3s/PNni84rsQBhMitFStTBcclvlsrupiHJVhGYUShJABz5mqMoRA0uqQtxSbntEeUQfogJOFMg16pWvKM0QeJBYlUBiS/byS7u8nGd+md7eGTZ8Mn66MHe8ngp3T9bvro2suD66On36d3biXfbCVrPw/3fx1dvT/aeZj8s/nvha+HT9debG0kf/2Zrl9Jb18cbV9KH117vqchkwrFKuBCZ+kSFcTtWkbegJLHAhvigVKRrJXL1qmEeVjOHMsSmCIM6ImIxl3CThxWTQkGJs39hfmmMbVjQnWfzhccx/U57oHoEGpc5g5PUxrFnClYVhoqWQsSXZndddwPG61P60tn5huL2qNSqlbdguOsFpxVnSfEUZ5FCcRkxIXK67DBMsupGa9iz0gF2qOsrxqLVEioOGqSEHisFnTqk57neQYU8HkMUr0KvqNBLyOAOeuQrlsrni04jmXcgxUzA/X3G4utZuPj+qLJ47gUtYFqaPb0fLHJe8AyQK1EpjUSsACVGXVmIkB3sYOoBGv1oYNiqitiMaXWxs0EaWpnz+Verw/WYO/FhasvD3ZGm1uj+/vpzcfJ4Lfkq+3ndx8k396z02a6OvWWIj5aqs/OnZksI/n7cTK4kW7+MVEGi8M2iGOWUfWOWcT/EVxozNUn2aX3fkwOBhPUgMXhMYm5CCvSB/cIPX3WcyTlGHZyZ314M33rUBwebCcbN0Y7D9MfLuvmGWkn19eyodZ33QhESKTM8pnhZqC+4KKnA7UF8bu5dlA06/s5KXex3mwtzX6mY52zwy5In1DoHlaZjS3lGFGiTAsRWzGaFWD3wDgpjmKZbT3HDSHkwvhPV6phpi3iy09ISMw7Tp/MYgeAqApwALiXRxqLzmJf2uuEKRB9RI2qKmPJqQmtZTpUghhqeRokFOkgrOSRJIeIZY6WPyAU3ltR5v509d3qzMxYwIpzKl/Tb77EKZGqJeO2z0NEmHTfLK0rN5PL++PNPTGkeahI8Da09Cp6Sxg7B3bdvzoKMcmrA6Zs+8sxKRPmw3IpUCF1s5YpevTjKQ6f/ZLs7dpfI3sxwRXHnI6fVRIf2kiM1+1YPke+MP1g2LI1FDBnJdnv5tu4sFr4D1BLAQIUABQAAAAIAAAAAADGx+gMZQAAAGwAAAAKAAAAAAAAAAAAAAAAAAAAAABEb2NrZXJmaWxlUEsBAhQAFAAAAAgAAAAAAAcA5nKVAwAALAcAAAsAAAAAAAAAAAAAAAAAjQAAAHBsdWdpbi5qc29uUEsFBgAAAAACAAIAcQAAAEsEAAAAAA=="
}
```

### `install_plugin`

安装一个插件。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`manifest`：SentinelPluginManifest；`package`：string。The uploaded zip, base64. The host extracts and builds it.；`allowBuild`：boolean。Explicit consent to run the Dockerfile on the plugin host.；`allowHostNetwork`：boolean；`allowPrivileged`：boolean；`config`：Record<string, string> |
| 回复请求方 | `error` |
| 广播 | `plugins`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `plugins`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "install_plugin",
	"hostId": "host-1ke1zl3",
	"manifest": {
		"schema": 1,
		"id": "com.example.recon",
		"name": "Recon Toolkit",
		"version": "0.2.0",
		"description": "子域名枚举与端口探测，结果写入产物目录。仅限已授权的测试。",
		"author": "github:example",
		"source": "https://github.com/example/sentinel-plugin-recon",
		"license": "MIT",
		"build": {
			"dockerfile": "Dockerfile",
			"context": ".",
			"args": {
				"GO_VERSION": "1.22"
			}
		},
		"mcp": {
			"transport": "http",
			"port": 7801,
			"path": "/mcp",
			"startupTimeoutMs": 60000,
			"requestTimeoutMs": 300000
		},
		"config": [
			{
				"key": "RECON_TOKEN",
				"label": "API Token",
				"type": "secret",
				"required": false,
				"default": null,
				"options": [],
				"description": "可选；留空时只做被动枚举"
			},
			{
				"key": "RECON_THREADS",
				"label": "并发数",
				"type": "number",
				"required": false,
				"default": 20,
				"options": [],
				"description": ""
			},
			{
				"key": "RECON_MODE",
				"label": "模式",
				"type": "enum",
				"required": false,
				"default": "active",
				"options": [
					"passive",
					"active"
				],
				"description": "active 会向目标发探测包"
			}
		],
		"permissions": {
			"network": "bridge",
			"capAdd": [
				"NET_RAW"
			],
			"privileged": false
		},
		"locality": "any",
		"resources": {
			"cpus": 1,
			"memory": "512m",
			"pidsLimit": 256
		},
		"healthcheck": {
			"path": "/healthz",
			"intervalMs": 10000,
			"timeoutMs": 3000,
			"retries": 6
		},
		"artifacts": {
			"path": "/artifacts",
			"maxFileBytes": 52428800
		},
		"tools": [
			{
				"name": "list_subdomains",
				"description": "列出子域名"
			},
			{
				"name": "probe_ports",
				"description": "探测端口"
			}
		],
		"ui": {
			"entry": "/ui/index.html",
			"title": "Recon Toolkit 侦察结果",
			"protocol": 1,
			"sidebar": {
				"label": "Recon Toolkit",
				"icon": "/ui/icon.svg"
			}
		}
	},
	"package": "UEsDBBQAAAAIAAAAAADGx+gMZQAAAGwAAAAKAAAARG9ja2VyZmlsZXML8vdVSM/PScxLtzLUMzLiCvcP8nbxDFLQTywo4HL2D4hU0FPQ4woK9VNIz1dIKs3MSVHQzVfQL0pNzs9T0NNPzk2BsLlcIwL8g10VzC0MDLlc/UKCIgP8Pf1CFKKVIPJKsVwAUEsDBBQAAAAIAAAAAAAHAOZylQMAACwHAAALAAAAcGx1Z2luLmpzb26NVVFvE0cQfj7/Cuueg312G4j8ljZuG7WJUbDaB4Ss9d7Yt/Le7nV3z02KItFCChQaB1URSgKkpWoLRSVVJSgNKX+mvjM88Req3b1zwIEqjzvf7Mw3s/PNni84rsQBhMitFStTBcclvlsrupiHJVhGYUShJABz5mqMoRA0uqQtxSbntEeUQfogJOFMg16pWvKM0QeJBYlUBiS/byS7u8nGd+md7eGTZ8Mn66MHe8ngp3T9bvro2suD66On36d3biXfbCVrPw/3fx1dvT/aeZj8s/nvha+HT9debG0kf/2Zrl9Jb18cbV9KH117vqchkwrFKuBCZ+kSFcTtWkbegJLHAhvigVKRrJXL1qmEeVjOHMsSmCIM6ImIxl3CThxWTQkGJs39hfmmMbVjQnWfzhccx/U57oHoEGpc5g5PUxrFnClYVhoqWQsSXZndddwPG61P60tn5huL2qNSqlbdguOsFpxVnSfEUZ5FCcRkxIXK67DBMsupGa9iz0gF2qOsrxqLVEioOGqSEHisFnTqk57neQYU8HkMUr0KvqNBLyOAOeuQrlsrni04jmXcgxUzA/X3G4utZuPj+qLJ47gUtYFqaPb0fLHJe8AyQK1EpjUSsACVGXVmIkB3sYOoBGv1oYNiqitiMaXWxs0EaWpnz+Verw/WYO/FhasvD3ZGm1uj+/vpzcfJ4Lfkq+3ndx8k396z02a6OvWWIj5aqs/OnZksI/n7cTK4kW7+MVEGi8M2iGOWUfWOWcT/EVxozNUn2aX3fkwOBhPUgMXhMYm5CCvSB/cIPX3WcyTlGHZyZ314M33rUBwebCcbN0Y7D9MfLuvmGWkn19eyodZ33QhESKTM8pnhZqC+4KKnA7UF8bu5dlA06/s5KXex3mwtzX6mY52zwy5In1DoHlaZjS3lGFGiTAsRWzGaFWD3wDgpjmKZbT3HDSHkwvhPV6phpi3iy09ISMw7Tp/MYgeAqApwALiXRxqLzmJf2uuEKRB9RI2qKmPJqQmtZTpUghhqeRokFOkgrOSRJIeIZY6WPyAU3ltR5v509d3qzMxYwIpzKl/Tb77EKZGqJeO2z0NEmHTfLK0rN5PL++PNPTGkeahI8Da09Cp6Sxg7B3bdvzoKMcmrA6Zs+8sxKRPmw3IpUCF1s5YpevTjKQ6f/ZLs7dpfI3sxwRXHnI6fVRIf2kiM1+1YPke+MP1g2LI1FDBnJdnv5tu4sFr4D1BLAQIUABQAAAAIAAAAAADGx+gMZQAAAGwAAAAKAAAAAAAAAAAAAAAAAAAAAABEb2NrZXJmaWxlUEsBAhQAFAAAAAgAAAAAAAcA5nKVAwAALAcAAAsAAAAAAAAAAAAAAAAAjQAAAHBsdWdpbi5qc29uUEsFBgAAAAACAAIAcQAAAEsEAAAAAA==",
	"allowBuild": true,
	"allowHostNetwork": false,
	"allowPrivileged": false,
	"config": {
		"RECON_THREADS": "20",
		"RECON_MODE": "passive"
	}
}
```

### `uninstall_plugin`

卸载一个插件。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string；`purge`：boolean |
| 回复请求方 | `error` |
| 广播 | `plugins`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `plugins`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "uninstall_plugin",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.http-echo",
	"purge": false
}
```

### `start_plugin`

启动一个插件。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string |
| 回复请求方 | `error` |
| 广播 | `plugins`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `plugins`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "start_plugin",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.http-echo"
}
```

### `stop_plugin`

停止一个插件。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string |
| 回复请求方 | `error` |
| 广播 | `plugins`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `plugins`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "stop_plugin",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.recon"
}
```

### `get_plugin_build_log`

取一个插件的构建日志。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string |
| 回复请求方 | `plugin_build_log` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `plugin_build_log` 回给发出消息的连接。

```json
{
	"type": "get_plugin_build_log",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.recon"
}
```

### `list_official_plugins`

取官方插件目录。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `official_plugins` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `official_plugins` 回给发出消息的连接。

```json
{
	"type": "list_official_plugins"
}
```

### `install_official_plugin`

安装一个官方插件。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string；`allowBuild`：boolean；`allowHostNetwork`：boolean；`allowPrivileged`：boolean；`config`：Record<string, string> |
| 回复请求方 | `error` |
| 广播 | `plugins` |
| 失败文案 | `没有这个官方插件：{id}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `plugins`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "install_official_plugin",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.http-echo",
	"allowBuild": true,
	"allowHostNetwork": false,
	"allowPrivileged": false,
	"config": {}
}
```

### `set_plugin_sidebar`

设置一个插件是否固定在侧栏。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string；`pinned`：boolean |
| 回复请求方 | `error` |
| 广播 | `plugins` |
| 失败文案 | `未找到插件主机 {hostId}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `plugins`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "set_plugin_sidebar",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.recon",
	"pinned": false
}
```

### `set_plugin_enabled`

启用或禁用一个插件。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string；`enabled`：boolean |
| 回复请求方 | `error` |
| 广播 | `plugins`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `plugins`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "set_plugin_enabled",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.http-echo",
	"enabled": false
}
```

### `save_plugin_config`

保存一个插件的配置。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string；`values`：Record<string, string> |
| 回复请求方 | `error` |
| 广播 | `plugins`、`snapshot` |
| 失败文案 | `有会话正在运行，请先中止再修改{what}`、`未找到插件主机 {hostId}` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `plugins`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "save_plugin_config",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.recon",
	"values": {
		"RECON_THREADS": "32",
		"RECON_MODE": "active",
		"RECON_TOKEN": ""
	}
}
```

### `plugin_ui_open`

请求打开一个插件的界面，返回带令牌的地址。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string |
| 回复请求方 | `plugin_ui_opened`、`error` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `plugin_ui_opened` 回给发出消息的连接。失败时把异常的原文作为 `error` 的文案返回，所以文案取决于出错的操作，不是固定的句子。

```json
{
	"type": "plugin_ui_open",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.recon"
}
```

### `plugin_ui_call`

插件界面调用它自己的后端。

| 项目 | 内容 |
| --- | --- |
| 字段 | `requestId`：string；`hostId`：string；`pluginId`：string；`method`：string；`params`：unknown |
| 回复请求方 | `plugin_ui_result` |
| 广播 | `snapshot` |
| 失败文案 | `artifact.read 需要 path`、`不支持的界面方法 {method}`、`单个产物超过 1MB，请在插件页下载`、`有会话正在运行，请先中止再修改{what}` |

处理的结果通过 `plugin_ui_result` 回给发出消息的连接。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。

```json
{
	"type": "plugin_ui_call",
	"requestId": "6f1c2a8e-3b4d-4c5e-9f70-8a9b0c1d2e3f",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.recon",
	"method": "tool.call",
	"params": {
		"name": "list_subdomains",
		"arguments": {
			"domain": "example.com"
		}
	}
}
```

### `get_plugin_logs`

取一个插件的日志。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string |
| 回复请求方 | `plugin_logs`、`error` |
| 广播 | 无 |
| 失败文案 | `未找到插件主机 {hostId}` |

处理的结果通过 `plugin_logs` 回给发出消息的连接。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "get_plugin_logs",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.recon"
}
```

### `list_plugin_artifacts`

列出一个插件的产物文件。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string |
| 回复请求方 | `plugin_artifacts`、`error` |
| 广播 | 无 |
| 失败文案 | `未找到插件主机 {hostId}` |

处理的结果通过 `plugin_artifacts` 回给发出消息的连接。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "list_plugin_artifacts",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.recon"
}
```

### `fetch_plugin_artifact`

把一个插件产物保存到项目工作目录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string；`path`：string |
| 回复请求方 | `plugin_artifact_saved`、`error` |
| 广播 | 无 |
| 失败文案 | `请先创建或选择一个项目，再把插件产物落进证据目录`、`产物路径为空` |

处理的结果通过 `plugin_artifact_saved` 回给发出消息的连接。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "fetch_plugin_artifact",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.recon",
	"path": "subdomains/example.com.txt"
}
```

## 下行消息（服务端 → 浏览器）

### `plugins`

插件中心的全貌：插件主机、插件和问题列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `view`：SentinelPluginsView |
| 发送时机 | 回复 `get_plugins` 时，只发给发出消息的连接；处理 `save_plugin_host`、`delete_plugin_host`、`test_plugin_host`、`install_plugin`、`uninstall_plugin`、`start_plugin`、`stop_plugin`、`install_official_plugin`、`set_plugin_sidebar`、`set_plugin_enabled`、`save_plugin_config` 时广播 |

```json
{
	"type": "plugins",
	"view": {
		"hosts": [
			{
				"id": "host-1ke1zl3",
				"name": "本机插件主机",
				"url": "http://127.0.0.1:37219",
				"local": true,
				"status": {
					"at": 1795509000000,
					"ok": true,
					"mode": "local",
					"docker": {
						"ok": true,
						"version": "27.0.0"
					}
				}
			},
			{
				"id": "host-1lig2n6",
				"name": "VPS 插件主机",
				"url": "https://plugin-host.example.com",
				"local": false,
				"status": {
					"at": 1795508700000,
					"ok": false,
					"error": "连接 VPS 插件主机 失败：fetch failed"
				}
			}
		],
		"plugins": [
			{
				"hostId": "host-1ke1zl3",
				"hostName": "本机插件主机",
				"hostLocal": true,
				"manifest": {
					"schema": 1,
					"id": "com.example.recon",
					"name": "Recon Toolkit",
					"version": "0.2.0",
					"description": "子域名枚举与端口探测，结果写入产物目录。仅限已授权的测试。",
					"author": "github:example",
					"source": "https://github.com/example/sentinel-plugin-recon",
					"license": "MIT",
					"build": {
						"dockerfile": "Dockerfile",
						"context": ".",
						"args": {
							"GO_VERSION": "1.22"
						}
					},
					"mcp": {
						"transport": "http",
						"port": 7801,
						"path": "/mcp",
						"startupTimeoutMs": 60000,
						"requestTimeoutMs": 300000
					},
					"config": [
						{
							"key": "RECON_TOKEN",
							"label": "API Token",
							"type": "secret",
							"required": false,
							"default": null,
							"options": [],
							"description": "可选；留空时只做被动枚举"
						},
						{
							"key": "RECON_THREADS",
							"label": "并发数",
							"type": "number",
							"required": false,
							"default": 20,
							"options": [],
							"description": ""
						},
						{
							"key": "RECON_MODE",
							"label": "模式",
							"type": "enum",
							"required": false,
							"default": "active",
							"options": [
								"passive",
								"active"
							],
							"description": "active 会向目标发探测包"
						}
					],
					"permissions": {
						"network": "bridge",
						"capAdd": [
							"NET_RAW"
						],
						"privileged": false
					},
					"locality": "any",
					"resources": {
						"cpus": 1,
						"memory": "512m",
						"pidsLimit": 256
					},
					"healthcheck": {
						"path": "/healthz",
						"intervalMs": 10000,
						"timeoutMs": 3000,
						"retries": 6
					},
					"artifacts": {
						"path": "/artifacts",
						"maxFileBytes": 52428800
					},
					"tools": [
						{
							"name": "list_subdomains",
							"description": "列出子域名"
						},
						{
							"name": "probe_ports",
							"description": "探测端口"
						}
					],
					"ui": {
						"entry": "/ui/index.html",
						"title": "Recon Toolkit 侦察结果",
						"protocol": 1,
						"sidebar": {
							"label": "Recon Toolkit",
							"icon": "/ui/icon.svg"
						}
					}
				},
				"state": "running",
				"healthy": true,
				"enabled": true,
				"pinned": true,
				"configured": [
					"RECON_TOKEN",
					"RECON_THREADS",
					"RECON_MODE"
				],
				"values": {
					"RECON_THREADS": "20",
					"RECON_MODE": "active"
				},
				"hostPort": 35412,
				"installedAt": 1795165960000,
				"lastError": null
			},
			{
				"hostId": "host-1ke1zl3",
				"hostName": "本机插件主机",
				"hostLocal": true,
				"manifest": {
					"schema": 1,
					"id": "com.example.http-echo",
					"name": "HTTP Echo",
					"version": "0.1.0",
					"description": "起一个回显服务的最小示例插件，用来确认插件主机工作正常。",
					"author": "github:example",
					"source": "https://github.com/example/sentinel-plugin-http-echo",
					"license": "MIT",
					"build": {
						"dockerfile": "Dockerfile",
						"context": ".",
						"args": {}
					},
					"mcp": {
						"transport": "http",
						"port": 7801,
						"path": "/mcp",
						"startupTimeoutMs": 20000,
						"requestTimeoutMs": 300000
					},
					"config": [],
					"permissions": {
						"network": "bridge",
						"capAdd": [],
						"privileged": false
					},
					"locality": "any",
					"resources": {
						"cpus": 0.5,
						"memory": "128m",
						"pidsLimit": 64
					},
					"healthcheck": {
						"path": "/healthz",
						"intervalMs": 10000,
						"timeoutMs": 3000,
						"retries": 3
					},
					"artifacts": {
						"path": "/artifacts",
						"maxFileBytes": 52428800
					},
					"tools": [
						{
							"name": "echo",
							"description": "原样返回输入"
						}
					],
					"ui": null
				},
				"state": "stopped",
				"healthy": false,
				"enabled": false,
				"pinned": false,
				"configured": [],
				"values": {},
				"hostPort": 32771,
				"installedAt": 1794902400000,
				"lastError": null
			}
		],
		"problems": [
			"VPS 插件主机：连接 VPS 插件主机 失败：fetch failed"
		]
	}
}
```

### `plugin_manifest`

解析一个插件包得到的清单。

| 项目 | 内容 |
| --- | --- |
| 字段 | `manifest`：SentinelPluginManifest；`source`：string |
| 发送时机 | 回复 `inspect_plugin_package` 时，只发给发出消息的连接 |

```json
{
	"type": "plugin_manifest",
	"manifest": {
		"schema": 1,
		"id": "com.example.recon",
		"name": "Recon Toolkit",
		"version": "0.2.0",
		"description": "子域名枚举与端口探测，结果写入产物目录。仅限已授权的测试。",
		"author": "github:example",
		"source": "https://github.com/example/sentinel-plugin-recon",
		"license": "MIT",
		"build": {
			"dockerfile": "Dockerfile",
			"context": ".",
			"args": {
				"GO_VERSION": "1.22"
			}
		},
		"mcp": {
			"transport": "http",
			"port": 7801,
			"path": "/mcp",
			"startupTimeoutMs": 60000,
			"requestTimeoutMs": 300000
		},
		"config": [
			{
				"key": "RECON_TOKEN",
				"label": "API Token",
				"type": "secret",
				"required": false,
				"default": null,
				"options": [],
				"description": "可选；留空时只做被动枚举"
			},
			{
				"key": "RECON_THREADS",
				"label": "并发数",
				"type": "number",
				"required": false,
				"default": 20,
				"options": [],
				"description": ""
			},
			{
				"key": "RECON_MODE",
				"label": "模式",
				"type": "enum",
				"required": false,
				"default": "active",
				"options": [
					"passive",
					"active"
				],
				"description": "active 会向目标发探测包"
			}
		],
		"permissions": {
			"network": "bridge",
			"capAdd": [
				"NET_RAW"
			],
			"privileged": false
		},
		"locality": "any",
		"resources": {
			"cpus": 1,
			"memory": "512m",
			"pidsLimit": 256
		},
		"healthcheck": {
			"path": "/healthz",
			"intervalMs": 10000,
			"timeoutMs": 3000,
			"retries": 6
		},
		"artifacts": {
			"path": "/artifacts",
			"maxFileBytes": 52428800
		},
		"tools": [
			{
				"name": "list_subdomains",
				"description": "列出子域名"
			},
			{
				"name": "probe_ports",
				"description": "探测端口"
			}
		],
		"ui": {
			"entry": "/ui/index.html",
			"title": "Recon Toolkit 侦察结果",
			"protocol": 1,
			"sidebar": {
				"label": "Recon Toolkit",
				"icon": "/ui/icon.svg"
			}
		}
	},
	"source": "recon-toolkit-0.2.0.zip"
}
```

### `plugin_build_log`

一个插件的构建日志。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string；`log`：string |
| 发送时机 | 回复 `get_plugin_build_log` 时，只发给发出消息的连接 |

```json
{
	"type": "plugin_build_log",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.recon",
	"log": "# docker build sentinel-plugin/com.example.recon:0.2.0\n# context /home/operator/.sentinel/plugin-host/packages/com.example.recon\n\n#1 [internal] load build definition from Dockerfile\n#1 transferring dockerfile: 196B done\n#5 [2/2] RUN go build -o /recon ./cmd/recon\n#5 DONE 41.3s\n#6 exporting to image\n#6 DONE 1.2s\n\n# build complete\n"
}
```

### `official_plugins`

官方插件目录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `plugins`：SentinelOfficialPluginView[] |
| 发送时机 | 回复 `list_official_plugins` 时，只发给发出消息的连接 |

```json
{
	"type": "official_plugins",
	"plugins": [
		{
			"manifest": {
				"schema": 1,
				"id": "com.example.http-echo",
				"name": "HTTP Echo",
				"version": "0.1.0",
				"description": "起一个回显服务的最小示例插件，用来确认插件主机工作正常。",
				"author": "github:example",
				"source": "https://github.com/example/sentinel-plugin-http-echo",
				"license": "MIT",
				"build": {
					"dockerfile": "Dockerfile",
					"context": ".",
					"args": {}
				},
				"mcp": {
					"transport": "http",
					"port": 7801,
					"path": "/mcp",
					"startupTimeoutMs": 20000,
					"requestTimeoutMs": 300000
				},
				"config": [],
				"permissions": {
					"network": "bridge",
					"capAdd": [],
					"privileged": false
				},
				"locality": "any",
				"resources": {
					"cpus": 0.5,
					"memory": "128m",
					"pidsLimit": 64
				},
				"healthcheck": {
					"path": "/healthz",
					"intervalMs": 10000,
					"timeoutMs": 3000,
					"retries": 3
				},
				"artifacts": {
					"path": "/artifacts",
					"maxFileBytes": 52428800
				},
				"tools": [
					{
						"name": "echo",
						"description": "原样返回输入"
					}
				],
				"ui": null
			},
			"sizeBytes": 18462
		}
	]
}
```

### `plugin_ui_opened`

打开插件界面的地址，里面带着临时令牌。

| 项目 | 内容 |
| --- | --- |
| 字段 | `token`：string |
| 发送时机 | 回复 `plugin_ui_open` 时，只发给发出消息的连接 |

```json
{
	"type": "plugin_ui_opened",
	"token": "k3Jd9QmZ0xWv7TqLpR2sYnE4fA1bHcDu"
}
```

### `plugin_ui_result`

一次插件界面调用的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `requestId`：string；`ok`：boolean；`result`（可选）：unknown；`error`（可选）：string |
| 发送时机 | 回复 `plugin_ui_call` 时，只发给发出消息的连接 |

```json
{
	"type": "plugin_ui_result",
	"requestId": "6f1c2a8e-3b4d-4c5e-9f70-8a9b0c1d2e3f",
	"ok": true,
	"result": {
		"content": [
			{
				"type": "text",
				"text": "sub1.example.com\nsub2.example.com"
			}
		],
		"isError": false,
		"meta": null
	}
}
```

### `plugin_logs`

一个插件的日志。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string；`logs`：string |
| 发送时机 | 回复 `get_plugin_logs` 时，只发给发出消息的连接 |

```json
{
	"type": "plugin_logs",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.recon",
	"logs": "2026-11-24T08:31:02Z recon 0.2.0 starting: mode=active threads=20\n2026-11-24T08:31:02Z mcp server listening on 127.0.0.1:7801/mcp\n2026-11-24T08:31:03Z healthz ok"
}
```

### `plugin_artifacts`

一个插件的产物文件列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string；`artifacts`：SentinelPluginArtifact[] |
| 发送时机 | 回复 `list_plugin_artifacts` 时，只发给发出消息的连接 |

```json
{
	"type": "plugin_artifacts",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.recon",
	"artifacts": [
		{
			"path": "ports/203.0.113.10.json",
			"size": 482
		},
		{
			"path": "subdomains/example.com.txt",
			"size": 1832
		}
	]
}
```

### `plugin_artifact_saved`

一个插件产物保存到了项目工作目录的哪里。

| 项目 | 内容 |
| --- | --- |
| 字段 | `hostId`：string；`pluginId`：string；`path`：string；`savedTo`：string |
| 发送时机 | 回复 `fetch_plugin_artifact` 时，只发给发出消息的连接 |

```json
{
	"type": "plugin_artifact_saved",
	"hostId": "host-1ke1zl3",
	"pluginId": "com.example.recon",
	"path": "subdomains/example.com.txt",
	"savedTo": "evidence/plugin/host-1ke1zl3/com.example.recon/subdomains/example.com.txt"
}
```
