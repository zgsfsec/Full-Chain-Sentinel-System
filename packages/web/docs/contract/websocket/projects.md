# 项目

项目隔离工作目录、容器、会话和漏洞记录。新项目有一个工作目录和一个 Kali 工作容器。项目的增删启停都会广播新的 `projects` 列表；当前项目变化时还会广播 `snapshot` 和 `sessions`。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 7 种 |
| 下行消息 | 1 种 |
| 处理代码 | `packages/web/src/server.ts` 第 3066–3069、3070–3086、3087–3157、3158–3197、3198–3216、3217–3235、3236–3267 行 |

字段形状以 `packages/web/src/protocol.ts` 为准（浏览器视角在 `packages/web/webui/src/types.ts`）。通用约定见 [README](README.md)。「字段」一行给出字段名、类型和类型定义里的注释。

## 上行消息（浏览器 → 服务端）

### `list_projects`

取项目列表，每个项目带容器状态和统计。

| 项目 | 内容 |
| --- | --- |
| 字段 | 无 |
| 回复请求方 | 无 |
| 广播 | `projects` |
| 失败文案 | 无 |

这条消息没有成功时的直接回复。同时向所有控制台广播 `projects`。

```json
{
	"type": "list_projects"
}
```

### `add_project`

新建一个项目：一个工作目录和一个容器。

| 项目 | 内容 |
| --- | --- |
| 字段 | `name`：string；`proxyId`（可选）：string | null；`proxyNode`（可选）：string |
| 回复请求方 | `error` |
| 广播 | `projects` |
| 失败文案 | `内部错误：agentDir 未初始化` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `projects`。失败的原因写在结果消息的 `error` 字段里：`项目名称不能为空`、`已存在同名项目`、`工具镜像尚未构建，请先构建镜像后再创建项目`、`代理镜像 {image} 尚未拉取，请先到「代理」页拉取镜像`、`容器创建失败：{error}`、`代理配置无法生成：{error}`、`隧道 DNS 无法写入：{error}`、`代理容器启动失败：{error}`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "add_project",
	"name": "示例文本",
	"proxyNode": "text"
}
```

### `remove_project`

删除一个项目，可以选择只删容器还是连数据一起删。需要输入完整的项目名确认。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string；`confirmName`：string；`scope`："container" | "data" |
| 回复请求方 | `error` |
| 广播 | `projects`、`snapshot`、`vulns`、`assets_changed` |
| 失败文案 | `内部错误：agentDir 未初始化`、`项目不存在`、`确认失败：请输入完整项目名「{name}」`、`工程不存在` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `projects`、`snapshot`。状态实际发生变化时，还会向所有控制台广播 `vulns`、`assets_changed`；什么都没变时不发。失败的原因写在结果消息的 `error` 字段里：`项目不存在`、`容器删除失败：{error}`、`工作目录为空，拒绝删除`、`工作目录不在项目根目录下，拒绝删除：{dir}`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "remove_project",
	"id": "id-1",
	"confirmName": "示例文本",
	"scope": "data"
}
```

### `stop_project`

停止项目的容器。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error` |
| 广播 | `snapshot`、`projects` |
| 失败文案 | `内部错误：agentDir 未初始化`、`项目不存在`、`该项目还有正在运行的内容（{engines} 个工程、{sessions} 个会话）：请先暂停工程或等它结束，再停止容器` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `snapshot`、`projects`。失败的原因写在结果消息的 `error` 字段里：`项目不存在`、`容器停止失败：{error}`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "stop_project",
	"id": "id-1"
}
```

### `start_project`

启动项目的容器。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error` |
| 广播 | `environment`、`projects` |
| 失败文案 | `内部错误：agentDir 未初始化` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `environment`、`projects`。失败的原因写在结果消息的 `error` 字段里：`项目不存在`、`容器启动失败：{error}`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "start_project",
	"id": "id-1"
}
```

### `recreate_project`

重建项目的容器：换掉容器，保留项目和工作目录。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error` |
| 广播 | `projects`、`environment` |
| 失败文案 | `内部错误：agentDir 未初始化` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `projects`、`environment`。失败的原因写在结果消息的 `error` 字段里：`项目不存在`、`工具镜像尚未构建，请先构建镜像后再重建容器`、`容器删除失败：{error}`、`代理容器删除失败：{error}`、`容器重建失败：{error}`。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "recreate_project",
	"id": "id-1"
}
```

### `switch_project`

切换当前项目。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id`：string |
| 回复请求方 | `error` |
| 广播 | `projects`、`sessions`、`snapshot` |
| 失败文案 | `内部错误：agentDir 未初始化`、`项目不存在` |

这条消息没有成功时的直接回复。同时向所有控制台广播 `projects`、`sessions`。状态实际发生变化时，还会向所有控制台广播 `snapshot`；什么都没变时不发。处理中抛出的其它异常，原文作为 `error` 的文案返回。

```json
{
	"type": "switch_project",
	"id": "id-1"
}
```

## 下行消息（服务端 → 浏览器）

### `projects`

项目列表，每个项目带容器状态、统计和代理信息，以及当前项目。

| 项目 | 内容 |
| --- | --- |
| 字段 | `projects`：SentinelProjectInfo[]；`activeProjectId`：string | null |
| 发送时机 | 连接建立时发给新连接；由 `broadcastProjects` 发送 |

```json
{
	"type": "projects",
	"projects": [
		{
			"id": "id-1",
			"name": "示例文本",
			"cwd": "/work",
			"storage": {
				"bytes": 2,
				"hostBytes": 2,
				"containerBytes": 2,
				"partial": true,
				"measuredAt": 1763973000000
			},
			"container": "sentinel-project-1",
			"sessionCount": 2,
			"state": "missing",
			"manualStop": false,
			"vulnCount": 2,
			"assetCount": 2,
			"gateCount": 2,
			"proxyName": "示例文本",
			"proxyNode": "text",
			"proxyNodeName": "示例文本"
		}
	],
	"activeProjectId": "active-project-1"
}
```
