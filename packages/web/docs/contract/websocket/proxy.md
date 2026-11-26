# 代理与出口

代理是命名的档案，一个档案描述一种出口：SOCKS5/HTTP 地址、订阅链接、WireGuard 或 OpenVPN。项目只记住档案的 ID。开了代理的项目容器挂在该项目自己的 sing-box sidecar 上，切换节点不需要重建容器。多数上行消息都用 `proxy_config` 回复，失败时在它的 `error` 字段里带原因，而不是另回一条 `error`。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 12 种 |
| 下行消息 | 5 种 |
| 处理代码 | `packages/web/src/server.ts` 第 2411–2418、2419–2452、2453–2473、2474–2488、2489–2506、2507–2523、2524–2587、2588–2622、2623–2640、2641–2657、2658–2667、2668–2687 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `get_proxy_config`

取代理配置：全部档案、默认档案、sidecar 镜像和它的状态。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `error`、`proxy_config` |
| 广播 | 无 |
| 失败文案 | `未配置配置目录，无法读取代理` |

处理的结果通过 `proxy_config` 回给发出消息的连接。

```json
{
	"type": "get_proxy_config"
}
```

### `save_proxy`

新建或修改一个代理档案。订阅档案第一次保存时会拉取一次节点。

| 项目 | 内容 |
| --- | --- |
| 字段 | `proxy`：SentinelProxyInput |
| 回复请求方 | `error`、`proxy_config` |
| 广播 | `projects`、`environment` |
| 失败文案 | `未配置配置目录，无法保存代理` |

处理的结果通过 `proxy_config` 回给发出消息的连接。同时向所有控制台广播 `projects`、`environment`。失败的原因写在结果消息的 `error` 字段里：`代理名称不能为空`、`已存在同名代理`、`代理不存在`、`订阅地址不能为空`、`这个代理不是订阅`、`订阅地址必须是 http(s) 链接`、`订阅返回 HTTP {status}`、`订阅超过 {kb} KB 上限`、`订阅响应没有内容`、`配置里没有 DNS，请补一行 DNS = 10.66.0.1，或在上面的 DNS 里填一个`、`DNS 要填 IP 地址，多个用逗号分隔`、`配置要求用户名密码（auth-user-pass），请在上面的用户名与密码里填上`。

```json
{
	"type": "save_proxy",
	"proxy": {
		"name": "出口 HTTP",
		"mode": "simple",
		"simple": {
			"type": "http",
			"server": "proxy.example.com",
			"port": 3128,
			"username": "",
			"password": "",
			"tls": true
		},
		"wireguard": {
			"config": "",
			"dns": "",
			"killSwitch": true
		},
		"openvpn": {
			"config": "",
			"dns": "",
			"username": "",
			"password": "",
			"killSwitch": true
		},
		"subscriptionUrl": "",
		"subscriptionUserAgent": "",
		"subscriptionIntervalHours": 0,
		"nodeTag": "",
		"routePrivateDirect": true
	}
}
```

### `delete_proxy`

删除一个代理档案。用到它的项目改为跟随默认。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error`、`proxy_config` |
| 广播 | `projects`、`environment` |
| 失败文案 | `未配置配置目录，无法删除代理` |

处理的结果通过 `proxy_config` 回给发出消息的连接。同时向所有控制台广播 `projects`、`environment`。失败的原因写在结果消息的 `error` 字段里：`代理不存在`。

```json
{
	"type": "delete_proxy",
	"id": "9a6e2d48-1f7b-4c30-a8e5-7d3b91c6f208"
}
```

### `refresh_proxy_subscription`

重新拉取订阅的节点列表。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error`、`proxy_config` |
| 广播 | `projects`、`environment` |
| 失败文案 | `未配置配置目录，无法刷新订阅` |

处理的结果通过 `proxy_config` 回给发出消息的连接。同时向所有控制台广播 `projects`、`environment`。失败的原因写在结果消息的 `error` 字段里：`代理不存在`、`这个代理不是订阅`、`订阅地址必须是 http(s) 链接`、`订阅返回 HTTP {status}`、`订阅超过 {kb} KB 上限`、`订阅响应没有内容`、`配置里没有 DNS，请补一行 DNS = 10.66.0.1，或在上面的 DNS 里填一个`、`DNS 要填 IP 地址，多个用逗号分隔`、`配置要求用户名密码（auth-user-pass），请在上面的用户名与密码里填上`。

```json
{
	"type": "refresh_proxy_subscription",
	"id": "c41f8a72-9b3d-4e07-b5a6-8d2f90c4e615"
}
```

### `set_proxy_node`

设置档案默认使用的节点。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`nodeTag`：string |
| 回复请求方 | `error`、`proxy_config` |
| 广播 | `projects`、`environment` |
| 失败文案 | `未配置配置目录，无法切换节点` |

处理的结果通过 `proxy_config` 回给发出消息的连接。同时向所有控制台广播 `projects`、`environment`。失败的原因写在结果消息的 `error` 字段里：`代理不存在`、`这个代理不是订阅`、`订阅里没有节点，先拉取一次`、`节点不存在`。

```json
{
	"type": "set_proxy_node",
	"id": "c41f8a72-9b3d-4e07-b5a6-8d2f90c4e615",
	"nodeTag": "日本 东京 02"
}
```

### `test_proxy_nodes`

逐个测速档案里的节点。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`url`：string |
| 回复请求方 | `error`、`proxy_config` |
| 广播 | `projects`、`environment` |
| 失败文案 | `未配置配置目录，无法测速` |

处理的结果通过 `proxy_config` 回给发出消息的连接。同时向所有控制台广播 `projects`、`environment`。失败的原因写在结果消息的 `error` 字段里：`代理不存在`、`这个代理不是订阅`、`订阅里没有节点，先拉取一次`、`这个订阅正在测速`。

```json
{
	"type": "test_proxy_nodes",
	"id": "c41f8a72-9b3d-4e07-b5a6-8d2f90c4e615",
	"url": "https://www.gstatic.com/generate_204"
}
```

### `test_proxy_connection`

用档案的出口真实访问一个地址，测试连通性。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `error`、`proxy_config` |
| 广播 | 无 |
| 失败文案 | `未配置配置目录，无法测试代理` |

处理的结果通过 `proxy_config` 回给发出消息的连接。失败的原因写在结果消息的 `error` 字段里：`代理不存在`、`订阅代理请用「节点」里的批量测速`、`这个代理正在测试，请稍等`。

```json
{
	"type": "test_proxy_connection",
	"id": "5b0d9f36-7c1e-4a58-9d2b-3f6e8c1a7d24",
	"url": "https://example.com/"
}
```

### `switch_project_node`

为一个项目钉住订阅里的某个节点，运行中的项目立即生效。

| 项目 | 内容 |
| --- | --- |
| 字段 | `projectId`：string；`nodeTag`：string |
| 回复请求方 | `error`、`project_proxy_saved` |
| 广播 | `projects` |
| 失败文案 | `未配置配置目录，无法切换节点`、`项目不存在` |

处理的结果通过 `project_proxy_saved` 回给发出消息的连接。同时向所有控制台广播 `projects`。失败的原因写在结果消息的 `error` 字段里：`项目不存在`、`代理不存在`、`节点不存在`、`网关初始化失败：{error}`、`代理配置未通过 sing-box 校验`、`切换前无法暂停项目进程`、`网关切换状态未知，项目保持暂停；请检查 Docker 后重新启动项目`、`项目进程恢复失败，请检查 Docker 状态`、`这个项目没有使用代理`、`这个代理只有一个出口，没有可切换的节点`、`代理容器不认识这个节点，请重建容器`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "switch_project_node",
	"projectId": "2e7a5c10-93b4-4f6a-8c1d-5b9e2a7f4c30",
	"nodeTag": "auto"
}
```

### `set_default_proxy`

设置默认的代理档案。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string | null |
| 回复请求方 | `error`、`proxy_config` |
| 广播 | `projects`、`environment` |
| 失败文案 | `未配置配置目录，无法保存默认代理` |

处理的结果通过 `proxy_config` 回给发出消息的连接。同时向所有控制台广播 `projects`、`environment`。失败的原因写在结果消息的 `error` 字段里：`代理不存在`。

```json
{
	"type": "set_default_proxy",
	"id": "c41f8a72-9b3d-4e07-b5a6-8d2f90c4e615"
}
```

### `set_proxy_image`

设置 sidecar 使用的 sing-box 镜像。

| 项目 | 内容 |
| --- | --- |
| 字段 | `image`：string |
| 回复请求方 | `error`、`proxy_config` |
| 广播 | `singbox_pull_started`、`singbox_pull_log`、`singbox_pull_result`、`proxy_config`、`projects`、`environment` |
| 失败文案 | `未配置配置目录，无法保存代理镜像` |

处理的结果通过 `proxy_config` 回给发出消息的连接。同时向所有控制台广播 `singbox_pull_started`、`singbox_pull_log`、`singbox_pull_result`、`proxy_config`、`projects`、`environment`。

```json
{
	"type": "set_proxy_image",
	"image": "ghcr.io/sagernet/sing-box:v1.13.15"
}
```

### `pull_singbox_image`

拉取 sidecar 镜像。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `error` |
| 广播 | `singbox_pull_started`、`singbox_pull_log`、`singbox_pull_result`、`proxy_config`、`projects`、`environment` |
| 失败文案 | `未配置配置目录，无法拉取代理镜像` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `singbox_pull_started`、`singbox_pull_log`、`singbox_pull_result`、`proxy_config`、`projects`、`environment`。

```json
{
	"type": "pull_singbox_image"
}
```

### `set_project_proxy`

设置一个项目使用哪个代理档案。

| 项目 | 内容 |
| --- | --- |
| 字段 | `projectId`：string；`proxyId`（可选）：string | null；`proxyNode`（可选）：string |
| 回复请求方 | `error`、`project_proxy_saved` |
| 广播 | `projects`、`environment` |
| 失败文案 | `未配置配置目录，无法保存项目代理` |

处理的结果通过 `project_proxy_saved` 回给发出消息的连接。同时向所有控制台广播 `projects`、`environment`。失败的原因写在结果消息的 `error` 字段里：`项目不存在`、`代理不存在`、`节点不存在`、`网关初始化失败：{error}`、`代理配置未通过 sing-box 校验`、`切换前无法暂停项目进程`、`网关切换状态未知，项目保持暂停；请检查 Docker 后重新启动项目`、`项目进程恢复失败，请检查 Docker 状态`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "set_project_proxy",
	"projectId": "2e7a5c10-93b4-4f6a-8c1d-5b9e2a7f4c30",
	"proxyId": "c41f8a72-9b3d-4e07-b5a6-8d2f90c4e615",
	"proxyNode": "香港 01"
}
```

## 下行消息（服务端 → 浏览器）

### `proxy_config`

代理配置视图。`error` 表示刚才那次操作的问题，`push` 为 `true` 表示它不是对某条消息的回复。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 发送时机 | 回复 `get_proxy_config`、`save_proxy`、`delete_proxy`、`refresh_proxy_subscription`、`set_proxy_node`、`test_proxy_nodes`、`test_proxy_connection`、`set_default_proxy`、`set_proxy_image` 时，只发给发出消息的连接；连接建立时发给新连接；订阅定时刷新之后，以及代理镜像拉取结束之后，带 `push: true` 广播 |

```json
{
	"type": "proxy_config",
	"config": {
		"proxies": [
			{
				"id": "5b0d9f36-7c1e-4a58-9d2b-3f6e8c1a7d24",
				"name": "出口 SOCKS5",
				"mode": "simple",
				"simple": {
					"type": "socks5",
					"server": "socks.example.com",
					"port": 1080,
					"username": "operator",
					"password": "example-password",
					"tls": false
				},
				"subscription": null,
				"wireguard": {
					"config": "",
					"dns": "",
					"killSwitch": true
				},
				"openvpn": {
					"config": "",
					"dns": "",
					"username": "",
					"password": "",
					"killSwitch": true
				},
				"nodes": [],
				"nodeTag": "",
				"skipped": [],
				"routePrivateDirect": true,
				"test": {
					"ok": true,
					"latencyMs": 412,
					"testedAt": 1795509000000,
					"url": "https://www.gstatic.com/generate_204",
					"error": null
				},
				"createdAt": 1794298360000
			},
			{
				"id": "c41f8a72-9b3d-4e07-b5a6-8d2f90c4e615",
				"name": "订阅 A",
				"mode": "subscription",
				"simple": {
					"type": "socks5",
					"server": "",
					"port": 0,
					"username": "",
					"password": "",
					"tls": false
				},
				"subscription": {
					"url": "https://sub.example.com/api/v1/client/subscribe?token=example-token",
					"userAgent": "clash.meta",
					"updatedAt": 1795482750000,
					"error": null,
					"intervalHours": 12
				},
				"wireguard": {
					"config": "",
					"dns": "",
					"killSwitch": true
				},
				"openvpn": {
					"config": "",
					"dns": "",
					"username": "",
					"password": "",
					"killSwitch": true
				},
				"nodes": [
					{
						"tag": "香港 01",
						"name": "香港 01",
						"protocol": "shadowsocks",
						"outbound": {
							"type": "shadowsocks",
							"tag": "香港 01",
							"server": "hk1.example.com",
							"server_port": 8388,
							"method": "aes-256-gcm",
							"password": "example-password"
						},
						"latencyMs": 86,
						"testedAt": 1795509000000
					},
					{
						"tag": "日本 东京 02",
						"name": "日本 东京 02",
						"protocol": "trojan",
						"outbound": {
							"type": "trojan",
							"tag": "日本 东京 02",
							"server": "jp2.example.com",
							"server_port": 443,
							"password": "example-password",
							"tls": {
								"enabled": true,
								"server_name": "jp2.example.com"
							}
						},
						"latencyMs": 231,
						"testedAt": 1795509000000
					},
					{
						"tag": "美国 洛杉矶 03",
						"name": "美国 洛杉矶 03",
						"protocol": "vless",
						"outbound": {
							"type": "vless",
							"tag": "美国 洛杉矶 03",
							"server": "us3.example.com",
							"server_port": 443,
							"uuid": "00000000-0000-4000-8000-000000000003",
							"tls": {
								"enabled": true,
								"server_name": "us3.example.com"
							},
							"transport": {
								"type": "ws",
								"path": "/vless"
							}
						},
						"latencyMs": null,
						"testedAt": 1795509000000
					}
				],
				"nodeTag": "香港 01",
				"skipped": [
					{
						"name": "ssr://example-node",
						"reason": "sing-box 不支持 ssr，已跳过"
					}
				],
				"routePrivateDirect": true,
				"test": null,
				"createdAt": 1794969065000
			},
			{
				"id": "9a6e2d48-1f7b-4c30-a8e5-7d3b91c6f208",
				"name": "实验室 WireGuard",
				"mode": "wireguard",
				"simple": {
					"type": "socks5",
					"server": "",
					"port": 0,
					"username": "",
					"password": "",
					"tls": false
				},
				"subscription": null,
				"wireguard": {
					"config": "[Interface]\nPrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAddress = 10.66.0.2/32\nMTU = 1420\nDNS = 10.66.0.1\n\n[Peer]\nPublicKey = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = wg.example.com:51820\nPersistentKeepalive = 25",
					"dns": "",
					"killSwitch": true
				},
				"openvpn": {
					"config": "",
					"dns": "",
					"username": "",
					"password": "",
					"killSwitch": true
				},
				"nodes": [],
				"nodeTag": "",
				"skipped": [],
				"routePrivateDirect": true,
				"test": {
					"ok": false,
					"latencyMs": null,
					"testedAt": 1795509000000,
					"url": "https://example.com/",
					"error": "WireGuard 隧道没有在 20 秒内建立：[#] ip link set mtu 1420 up dev wg0"
				},
				"createdAt": 1795427112000
			},
			{
				"id": "e83b60f1-52c9-4d7a-b264-0c9fa1d38e57",
				"name": "客户专线 OpenVPN",
				"mode": "openvpn",
				"simple": {
					"type": "socks5",
					"server": "",
					"port": 0,
					"username": "",
					"password": "",
					"tls": false
				},
				"subscription": null,
				"wireguard": {
					"config": "",
					"dns": "",
					"killSwitch": true
				},
				"openvpn": {
					"config": "client\ndev tun\nproto udp\nremote vpn.example.com 1194\nresolv-retry infinite\nnobind\nauth-user-pass\n<ca>\n-----BEGIN CERTIFICATE-----\nRVhBTVBMRSBURVNUIENFUlRJRklDQVRFIC0gbm90IGEgcmVhbCBjZXJ0aWZpY2F0\nZSAtIHJlc2VydmVkIGZvciBkb2N1bWVudGF0aW9uIGV4YW1wbGVzIG9ubHkuIEVY\nQU1QTEUgVEVTVCBDRVJUSUZJQ0FURSAtIG5vdCBhIHJlYWwgY2VydGlmaWNhdGUg\nLSByZXNlcnZlZCBmb3IgZG9jdW1lbnRhdGlvbiBleGFtcGxlcyBvbmx5LiBFWEFN\nUExFIFRFU1QgQ0VSVElGSUNBVEUgLSBub3QgYSByZWFsIGNlcnRpZmljYXRlIC0g\ncmVzZXJ2ZWQgZm9yIGRvY3VtZW50YXRpb24gZXhhbXBsZXMgb25seS4g\n-----END CERTIFICATE-----\n</ca>",
					"dns": "10.8.0.1",
					"username": "operator",
					"password": "example-password",
					"killSwitch": true
				},
				"nodes": [],
				"nodeTag": "",
				"skipped": [],
				"routePrivateDirect": true,
				"test": null,
				"createdAt": 1795427112000
			}
		],
		"defaultId": "c41f8a72-9b3d-4e07-b5a6-8d2f90c4e615",
		"image": "ghcr.io/sagernet/sing-box:v1.13.15",
		"imagePresent": true,
		"testUrl": "https://www.gstatic.com/generate_204"
	}
}
```

### `project_proxy_saved`

项目的代理设置保存后的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 发送时机 | 回复 `switch_project_node`、`set_project_proxy` 时，只发给发出消息的连接 |

```json
{
	"type": "project_proxy_saved",
	"projectId": "2e7a5c10-93b4-4f6a-8c1d-5b9e2a7f4c30",
	"applied": true
}
```

### `singbox_pull_started`

代理镜像开始拉取。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 发送时机 | 代理镜像开始拉取时广播 |

```json
{
	"type": "singbox_pull_started"
}
```

### `singbox_pull_log`

代理镜像拉取过程中的一行输出。

| 项目 | 内容 |
| --- | --- |
| 字段 | `line`：string |
| 发送时机 | 代理镜像拉取过程中，每有一行输出就广播一次 |

```json
{
	"type": "singbox_pull_log",
	"line": "docker pull ghcr.io/sagernet/sing-box:v1.13.15"
}
```

### `singbox_pull_result`

代理镜像拉取的结果。

| 项目 | 内容 |
| --- | --- |
| 字段 | `ok`：boolean；`error`（可选）：string |
| 发送时机 | 代理镜像拉取结束时广播 |

```json
{
	"type": "singbox_pull_result",
	"ok": true
}
```
