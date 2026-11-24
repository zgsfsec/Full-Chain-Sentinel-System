# 安卓与 iOS 设备

安卓测试机通过 DroidBridge、iOS 测试机通过 SentinelBridge 反连后端。设备自己连后端的 WebSocket 端点不在本契约里；本域只有控制台这一侧的消息。设备状态每次变化都会广播。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 14 种 |
| 下行消息 | 2 种 |
| 处理代码 | `packages/web/src/server.ts` 第 3710–3722、3723–3726、3727–3734、3735–3742、3743–3750、3751–3754、3755–3762、3763–3770、3771–3784、3785–3788、3789–3796、3797–3804、3823–3826 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `droid_state`

取安卓设备的状态：设备、令牌和监听地址。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `droid_state` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `droid_state` 回给发出消息的连接。

```json
{
	"type": "droid_state"
}
```

### `droid_token_create`

创建一个安卓设备的接入令牌。

| 项目 | 内容 |
| --- | --- |
| 字段 | `label`：string |
| 回复请求方 | 无 |
| 广播 | `droid_state` |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `droid_state`；什么都没变时不发。

```json
{
	"type": "droid_token_create",
	"label": "测试机-Pixel 6"
}
```

### `droid_token_delete`

删除一个安卓设备的接入令牌。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error` |
| 广播 | `droid_state` |
| 失败文案 | `该 token 不存在` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `droid_state`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "droid_token_delete",
	"id": "1b6a8e2f-0c4d-4f7b-9e3a-5d8c2b7f9e14"
}
```

### `droid_device_rename`

给一台安卓设备改名。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`name`：string |
| 回复请求方 | `error` |
| 广播 | `droid_state` |
| 失败文案 | `设备不存在或名称为空` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `droid_state`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "droid_device_rename",
	"id": "c81e6b2a-4f3d-4e9a-8b7c-2d5f0a9e1c34",
	"name": "实验室 Pixel"
}
```

### `droid_device_remove`

移除一台安卓设备的记录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error` |
| 广播 | `droid_state` |
| 失败文案 | `设备不存在` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `droid_state`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "droid_device_remove",
	"id": "f0a7d3e5-6c1b-4b28-9e4d-8a2c5b7f9e13"
}
```

### `droid_set_enabled`

开关安卓设备的接入。

| 项目 | 内容 |
| --- | --- |
| 字段 | `enabled`：boolean |
| 回复请求方 | 无 |
| 广播 | `snapshot`、`droid_state` |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`、`droid_state`；什么都没变时不发。

```json
{
	"type": "droid_set_enabled",
	"enabled": true
}
```

### `droid_set_listen`

设置安卓设备反连的监听地址。

| 项目 | 内容 |
| --- | --- |
| 字段 | `host`：string；`port`：number |
| 回复请求方 | `error` |
| 广播 | `droid_state` |
| 失败文案 | `监听地址不能为空`、`端口必须在 1-65535 之间`、`设备网关未启动`、`监听失败` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `droid_state`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "droid_set_listen",
	"host": "0.0.0.0",
	"port": 9944
}
```

### `ios_set_listen`

设置 iOS 设备反连的监听地址。

| 项目 | 内容 |
| --- | --- |
| 字段 | `host`：string；`port`：number |
| 回复请求方 | `error` |
| 广播 | `ios_state` |
| 失败文案 | `监听地址不能为空`、`端口必须在 1-65535 之间`、`设备网关未启动`、`监听失败` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `ios_state`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "ios_set_listen",
	"host": "0.0.0.0",
	"port": 9945
}
```

### `ios_state`

取 iOS 设备的状态，包括证书指纹。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | `ios_state` |
| 广播 | 无 |
| 失败文案 | 无 |

处理的结果通过 `ios_state` 回给发出消息的连接。

```json
{
	"type": "ios_state"
}
```

### `ios_token_create`

创建一个 iOS 设备的接入令牌。

| 项目 | 内容 |
| --- | --- |
| 字段 | `label`：string |
| 回复请求方 | 无 |
| 广播 | `ios_state` |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `ios_state`；什么都没变时不发。

```json
{
	"type": "ios_token_create",
	"label": "测试机-iPhone 13"
}
```

### `ios_device_rename`

给一台 iOS 设备改名。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`name`：string |
| 回复请求方 | `error` |
| 广播 | `ios_state` |
| 失败文案 | `设备不存在或名称为空` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `ios_state`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "ios_device_rename",
	"id": "9b4e2c7a-1f6d-4e3b-8a5c-0d7e9f2b4a16",
	"name": "越狱机 iPhone 13"
}
```

### `ios_device_remove`

移除一台 iOS 设备的记录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error` |
| 广播 | `ios_state` |
| 失败文案 | `设备不存在` |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `ios_state`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "ios_device_remove",
	"id": "3c5d8e1f-2b4a-4c6d-8e0f-9a1b3c5d7e9f"
}
```

### `ios_set_enabled`

开关 iOS 设备的接入。

| 项目 | 内容 |
| --- | --- |
| 字段 | `enabled`：boolean |
| 回复请求方 | 无 |
| 广播 | `snapshot`、`ios_state` |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。状态实际发生变化时，还会向所有控制台广播 `snapshot`、`ios_state`；什么都没变时不发。

```json
{
	"type": "ios_set_enabled",
	"enabled": true
}
```

### `ios_token_delete`

删除一个 iOS 设备的接入令牌。

服务端没有处理这条消息的分支。浏览器发出它之后，收到的是一条 `error`，文案是 `未知消息类型: {type}`。这是现有后端的缺口：令牌没有被删除。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error` |
| 广播 | 无 |
| 失败文案 | `未知消息类型: {type}` |
```json
{
	"type": "ios_token_delete",
	"id": "7d2c9b4e-6a1f-4e8d-b5c3-0f9a8e7d2c61"
}
```

## 下行消息（服务端 → 浏览器）

### `droid_state`

安卓设备的状态：设备、令牌、监听地址和本机的局域网地址。

| 项目 | 内容 |
| --- | --- |
| 字段 | `enabled`：boolean。The viewed conversation's switch; device and token lists are global.；`devices`：DroidDevice[]；`tokens`：DroidToken[]；`listen`：{ host: string; port: number } | null。The dedicated reverse listener, when it is bound.；`listenConfig`：{ host: string; port: number } | null。What the operator picked (may differ from `listen` when it failed to bind).；`lanIps`：string[]。Non-internal IPv4 addresses of the server, for the listen picker. |
| 发送时机 | 回复 `droid_state` 时，只发给发出消息的连接；由 `broadcastDroidDevices` 发送 |

```json
{
	"type": "droid_state",
	"enabled": true,
	"devices": [
		{
			"id": "c81e6b2a-4f3d-4e9a-8b7c-2d5f0a9e1c34",
			"name": "实验室 Pixel",
			"model": "Pixel 6",
			"androidVersion": "14",
			"sdkInt": 34,
			"rooted": true,
			"online": true,
			"tokenId": "3d9c2f61-7b4e-4a8d-9c1f-5e2b8a7d4c06",
			"firstSeen": "2026-11-18T08:12:40.119Z",
			"lastSeen": "2026-11-24T09:30:12.507Z",
			"stale": false,
			"idleMs": 3184
		},
		{
			"id": "f0a7d3e5-6c1b-4b28-9e4d-8a2c5b7f9e13",
			"name": "SM-G991B",
			"model": "SM-G991B",
			"androidVersion": "13",
			"sdkInt": 33,
			"rooted": false,
			"online": true,
			"tokenId": "1b6a8e2f-0c4d-4f7b-9e3a-5d8c2b7f9e14",
			"firstSeen": "2026-11-20T06:44:03.862Z",
			"lastSeen": "2026-11-24T09:29:34.910Z",
			"stale": true,
			"idleMs": 47812
		}
	],
	"tokens": [
		{
			"id": "3d9c2f61-7b4e-4a8d-9c1f-5e2b8a7d4c06",
			"label": "测试机-Pixel 6",
			"token": "droid_4f1c9a7e2b8d6f3a0c5e7b9d1a2f4e6c",
			"createdAt": "2026-11-18T08:10:22.301Z",
			"lastUsedAt": "2026-11-24T09:30:12.507Z"
		},
		{
			"id": "1b6a8e2f-0c4d-4f7b-9e3a-5d8c2b7f9e14",
			"label": "演示机",
			"token": "droid_9e2b5c8f1a7d4e6b3c0f8d2a5b9e1c7d",
			"createdAt": "2026-11-17T02:05:47.640Z",
			"lastUsedAt": "2026-11-20T06:44:03.862Z"
		}
	],
	"listen": {
		"host": "0.0.0.0",
		"port": 9944
	},
	"listenConfig": {
		"host": "0.0.0.0",
		"port": 9944
	},
	"lanIps": [
		"192.168.10.43",
		"10.211.55.2"
	]
}
```

### `ios_state`

iOS 设备的状态：设备、令牌、监听地址、本机的局域网地址和证书指纹。

| 项目 | 内容 |
| --- | --- |
| 字段 | `enabled`：boolean。The viewed conversation's switch; device and token lists are global.；`devices`：IosDevice[]；`tokens`：IosToken[]；`listen`：{ host: string; port: number } | null；`listenConfig`：{ host: string; port: number } | null；`lanIps`：string[]；`certPin`：string | null。SHA-256 of the console's leaf certificate, for wss pinning. |
| 发送时机 | 回复 `ios_state` 时，只发给发出消息的连接；由 `broadcastIosDevices` 发送 |

```json
{
	"type": "ios_state",
	"enabled": false,
	"devices": [
		{
			"id": "9b4e2c7a-1f6d-4e3b-8a5c-0d7e9f2b4a16",
			"name": "越狱机 iPhone 13",
			"model": "iPhone14,5",
			"osVersion": "16.6.1",
			"build": "20G81",
			"arch": "arm64e",
			"jailbreakForm": "rootless",
			"jailbreakName": "Dopamine",
			"jailbreakVersion": "2.4.0",
			"hasRoot": true,
			"online": true,
			"tokenId": "7d2c9b4e-6a1f-4e8d-b5c3-0f9a8e7d2c61",
			"firstSeen": "2026-11-21T07:26:15.208Z",
			"lastSeen": "2026-11-24T09:30:08.113Z",
			"stale": false,
			"idleMs": 6402
		},
		{
			"id": "3c5d8e1f-2b4a-4c6d-8e0f-9a1b3c5d7e9f",
			"name": "iPhone10,3",
			"model": "iPhone10,3",
			"osVersion": "15.8.3",
			"build": "19H386",
			"arch": "arm64",
			"jailbreakForm": "rootful",
			"jailbreakName": "palera1n",
			"jailbreakVersion": "2.1.1",
			"hasRoot": true,
			"online": false,
			"tokenId": "7d2c9b4e-6a1f-4e8d-b5c3-0f9a8e7d2c61",
			"firstSeen": "2026-11-19T13:52:41.935Z",
			"lastSeen": "2026-11-23T18:07:56.204Z",
			"stale": false,
			"idleMs": 0
		}
	],
	"tokens": [
		{
			"id": "7d2c9b4e-6a1f-4e8d-b5c3-0f9a8e7d2c61",
			"label": "测试机-iPhone 13",
			"token": "ios_b3e8d1f4a6c90e2d7b5a8c3f1e6d9b2",
			"createdAt": "2026-11-21T07:20:09.477Z",
			"lastUsedAt": "2026-11-24T09:30:08.113Z"
		},
		{
			"id": "a4f6c8e0-2d3b-4a9c-8e1d-7b5f3a9c6e28",
			"label": "备用机",
			"token": "ios_c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6",
			"createdAt": "2026-11-16T11:38:30.155Z",
			"lastUsedAt": null
		}
	],
	"listen": {
		"host": "0.0.0.0",
		"port": 9945
	},
	"listenConfig": {
		"host": "0.0.0.0",
		"port": 9945
	},
	"lanIps": [
		"192.168.10.43",
		"10.211.55.2"
	],
	"certPin": "9a5c3f7e1b8d2a4f6c0e9b7d5a3c1f8e2b6d4a0c8f7e5b3d1a9c6f4e2b0d8a6c"
}
```
