# 环境检查、镜像与构建源

Docker 是硬依赖：所有工具调用都在项目容器的 Kali 环境里执行。本域管环境检查、工具镜像的构建、镜像的构建源和容器的网络设置。环境检查不通过时对话被锁定，所以 `environment` 会在启动、每次检查和每次构建之后广播。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 6 种 |
| 下行消息 | 5 种 |
| 处理代码 | `packages/web/src/server.ts` 第 2302–2309、2310–2319、2320–2365、2366–2368、2369–2391、2392–2414 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `get_environment`

取最近的 Docker 环境检查报告；还没有检查过就先检查一次。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `environment` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `environment` 回给发出消息的连接。

```json
{
	"type": "get_environment"
}
```

### `check_environment`

立即重新做一次 Docker 环境检查，并把报告广播给所有控制台。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | 无 |
| 广播 | `environment` |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。同时向所有控制台广播 `environment`。

```json
{
	"type": "check_environment"
}
```

### `build_image`

构建工具镜像，日志实时广播。可以同时保存构建源。

| 项目 | 内容 |
| --- | --- |
| 字段 | `sources`（可选）：SentinelSources |
| 回复请求方 | `error`、`sources_saved`、`image_build_result` |
| 广播 | `image_build_log`、`image_build_result`、`environment` |
| 失败文案 | `镜像构建已在进行中`、`未配置配置目录，无法保存构建源`、`二进制内没有内置 Dockerfile，无法构建工具镜像` |

处理的结果通过 `sources_saved`、`image_build_result` 回给发出消息的连接。同时向所有控制台广播 `image_build_log`、`image_build_result`、`environment`。

```json
{
	"type": "build_image",
	"sources": {
		"baseImage": "text",
		"aptMirror": "text",
		"pipIndex": "text",
		"npmRegistry": "text",
		"goProxy": "text"
	}
}
```

### `abort_image_build`

中止正在进行的镜像构建。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | 无 |
| 广播 | 无 |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。

```json
{
	"type": "abort_image_build"
}
```

### `set_sources`

保存镜像的构建源（基础镜像与软件源）。只做记录，重建镜像时才生效。

| 项目 | 内容 |
| --- | --- |
| 字段 | `sources`：SentinelSources |
| 回复请求方 | `error`、`sources_saved` |
| 广播 | `environment` |
| 失败文案 | `未配置配置目录，无法保存构建源` |

处理的结果通过 `sources_saved` 回给发出消息的连接。同时向所有控制台广播 `environment`。

```json
{
	"type": "set_sources",
	"sources": {
		"baseImage": "text",
		"aptMirror": "text",
		"pipIndex": "text",
		"npmRegistry": "text",
		"goProxy": "text"
	}
}
```

### `set_container_network`

设置新建的容器使用哪种网络。只影响之后创建的容器。

| 项目 | 内容 |
| --- | --- |
| 字段 | `network`：SentinelContainerNetwork |
| 回复请求方 | `error`、`container_network_saved` |
| 广播 | `environment` |
| 失败文案 | `未配置配置目录，无法保存容器网络` |

处理的结果通过 `container_network_saved` 回给发出消息的连接。同时向所有控制台广播 `environment`。

```json
{
	"type": "set_container_network",
	"network": "host"
}
```

## 下行消息（服务端 → 浏览器）

### `environment`

Docker 环境检查报告，以及镜像是否正在构建、代理镜像是否正在拉取。

| 项目 | 内容 |
| --- | --- |
| 字段 | `report`：SentinelEnvReport；`building`：boolean；`proxyPull`（可选）：{ pulling: boolean; log: string[] } |
| 发送时机 | 回复 `get_environment` 时，只发给发出消息的连接；处理 `check_environment` 时广播；由 `broadcastEnvironment` 发送 |

```json
{
	"type": "environment",
	"report": {
		"at": "2026-11-24T08:30:00.000Z",
		"ok": true,
		"items": [
			{
				"id": "id-1",
				"group": "text",
				"label": "示例文本",
				"status": "ok",
				"detail": "示例文本",
				"blocking": true
			}
		],
		"url": "https://example.com",
		"sources": {
			"baseImage": "text",
			"aptMirror": "text",
			"pipIndex": "text",
			"npmRegistry": "text",
			"goProxy": "text"
		},
		"containerNetwork": "host",
		"proxies": {
			"proxies": [
				{
					"id": "id-1",
					"name": "示例文本",
					"mode": "subscription",
					"simple": {
						"type": "http",
						"server": "text",
						"port": 8443,
						"username": "示例文本",
						"password": "example-credential",
						"tls": true
					},
					"subscription": {
						"url": "https://example.com",
						"userAgent": "text",
						"updatedAt": 1763973000000,
						"error": "示例错误信息",
						"intervalHours": 2
					},
					"wireguard": {
						"config": "text",
						"dns": "text",
						"killSwitch": true
					},
					"openvpn": {
						"config": "text",
						"dns": "text",
						"username": "示例文本",
						"password": "example-credential",
						"killSwitch": true
					},
					"nodes": [
						{
							"tag": "text",
							"name": "示例文本",
							"protocol": "text",
							"outbound": {
								"key-1": null
							}
						}
					],
					"nodeTag": "text",
					"skipped": [
						{
							"name": "示例文本",
							"reason": "示例错误信息"
						}
					],
					"routePrivateDirect": true,
					"createdAt": 1763973000000
				}
			],
			"defaultId": "default-1",
			"image": "https://example.com",
			"imagePresent": true,
			"testUrl": "https://example.com"
		}
	},
	"building": true,
	"proxyPull": {
		"pulling": true,
		"log": [
			"text"
		]
	}
}
```

### `sources_saved`

保存后的镜像构建源；保存失败时带 `error`。

| 项目 | 内容 |
| --- | --- |
| 字段 | `sources`：SentinelSources；`error`（可选）：string |
| 发送时机 | 回复 `build_image`、`set_sources` 时，只发给发出消息的连接 |

```json
{
	"type": "sources_saved",
	"sources": {
		"baseImage": "text",
		"aptMirror": "text",
		"pipIndex": "text",
		"npmRegistry": "text",
		"goProxy": "text"
	},
	"error": "示例错误信息"
}
```

### `image_build_result`

镜像构建的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `ok`：boolean；`error`（可选）：string |
| 发送时机 | 回复 `build_image` 时，只发给发出消息的连接；处理 `build_image` 时广播 |

```json
{
	"type": "image_build_result",
	"ok": true,
	"error": "示例错误信息"
}
```

### `image_build_log`

镜像构建过程中的一行输出。

| 项目 | 内容 |
| --- | --- |
| 字段 | `line`：string |
| 发送时机 | 处理 `build_image` 时广播 |

```json
{
	"type": "image_build_log",
	"line": "text"
}
```

### `container_network_saved`

保存后的容器网络设置；保存失败时带 `error`。

| 项目 | 内容 |
| --- | --- |
| 字段 | `network`：SentinelContainerNetwork；`error`（可选）：string |
| 发送时机 | 回复 `set_container_network` 时，只发给发出消息的连接 |

```json
{
	"type": "container_network_saved",
	"network": "host",
	"error": "示例错误信息"
}
```
