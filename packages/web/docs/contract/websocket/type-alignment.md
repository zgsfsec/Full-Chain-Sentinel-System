# 两份类型的差异

消息的字段由 TypeScript 类型定义，有两份手工保持一致的镜像：

| 文件 | 视角 | 谁用它 |
| --- | --- | --- |
| `packages/web/src/protocol.ts` | 服务端 | 后端编译 |
| `packages/web/webui/src/types.ts` | 浏览器 | 前端编译。它不能引用 Agent SDK 的类型，否则 SDK 会被打进浏览器包，所以另抄一份 |

这份清单列出两份之间所有已知的差异，以及重写后端时照哪一边。

## 结论

| 方向 | 种类 | 结构一致的 | 有差异的 |
| --- | --- | --- | --- |
| 上行（浏览器 → 服务端） | 228 | 228 | 0 |
| 下行（服务端 → 浏览器） | 119 | 108 | 11 |

差异不是靠人眼看出来的。`packages/web/webui/src/protocol-alignment.ts` 让编译器比较两份里的每一种消息：一种消息在两边的定义如果不能互相赋值，就算有差异。有差异的消息必须列在那个文件的「已接受」名单里，并且在本文档里有一行，否则 `npm run check` 失败。

比较时，浏览器副本引用的 SDK 类型取自 SDK 构建出来的类型声明（`node_modules` 里），也就是前端自己编译时看到的那一份。

## 重写后端时照哪一边

- **上行消息**：两份完全一致，照哪份都一样。
- **下行消息**：照服务端那一份。现有前端是和现有后端配合工作的，服务端实际发出的就是前端能处理的。

有一类例外要注意：服务端的类型描述的是**序列化之前**的值，个别字段和线上实际发出去的不一样。下表里标了「线上是」的就是这种情况，按「线上是」那一列发。

## 下行消息的差异

### 字段多少不同

| 消息 | 差异 | 新后端怎么发 |
| --- | --- | --- |
| `vuln`、`vulns`、`asset` | 服务端的漏洞记录（`SentinelVulnerability`、`SentinelVulnSummary`，在 `packages/web/src/protocol.ts`）要求有 `platform`、`appPackage`、`appVersion` 三个字段，浏览器副本没有这三个字段。`asset` 的差异来自它内嵌的漏洞列表 | 三个字段都发 |
| `stats` | 服务端发 SDK 的完整 `SessionStats` 再加 `cumulative`；浏览器副本只声明了 `tokens`、`cost`、`cumulative`。多出来的字段是 `sessionFile`、`sessionId`、`userMessages`、`assistantMessages`、`toolCalls`、`toolResults`、`totalMessages`、`contextUsage`。另外 `cumulative` 在服务端是必填，在浏览器副本里是可选 | 按服务端发全部字段，`cumulative` 必发。前端只读其中一部分 |
| `tree` | 服务端的节点类型是 SDK 的 `SessionTreeNode`，有 `labelTimestamp` 字段，`entry` 是精确的联合类型；浏览器副本的 `SessionTreeNodeView` 没有 `labelTimestamp`，`entry` 被放宽成 `type` 为任意字符串 | 按 SDK 的 `SessionTreeNode` 发，带 `labelTimestamp` 和完整的 `entry` |
| `droid_state` | 浏览器副本多声明了一个 `certPin: string \| null`，服务端在 `droid_state` 里不发它 | 不发。`certPin` 只出现在 `ios_state` 里，前端也只在 iOS 页读它 |
| `session_event` | 见下面「`session_event` 的事件」 | 按 SDK 的事件转发 |

### 类型与线上的实际格式不同

| 消息 | 字段 | 服务端类型 | 线上是 | 新后端怎么发 |
| --- | --- | --- | --- | --- |
| `sessions` | 每一项的 `created`、`modified` | `Date`（来自 SDK 的会话信息） | ISO 8601 字符串，例如 `2026-11-24T08:30:00.000Z` | 发 ISO 8601 字符串，和 `JSON.stringify` 处理 `Date` 的结果一致 |
| `snapshot` | `snapshot.messages` | `unknown[]` | 当前分支的会话记录，每项是一条消息（`AgentMessageView` 的形状），最前面是当前系统提示对应的那条 | 按浏览器副本的 `AgentMessageView` 发 |

### `supervisor_detail`、`supervisor_episode`：多一个取值

服务端的 `SentinelSupervisorTrigger` 比浏览器副本多一个值 `"long-call"`（单次命令运行过久）。它出现在 `supervisor_episode` 的 `trigger` 和 `supervisor_detail` 里每一片段的 `trigger` 上。

新后端按服务端：可能发出 `"long-call"`。前端的类型副本没有跟上，但界面上有这个值的文案（`命令运行过久`）。

## `session_event` 的事件

`session_event.event` 是 Agent 运行时的事件。服务端的类型是 SDK 的 `AgentSessionEvent`，共 23 种事件；浏览器副本的 `SessionEventView` 只声明了其中 9 种：

- 声明了的 9 种：`agent_start`、`agent_settled`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`queue_update`。
- 没声明的 14 种：`agent_end`、`turn_start`、`turn_end`、`entry_appended`、`compaction_start`、`compaction_end`、`auto_retry_start`、`auto_retry_end`、`thinking_level_changed`、`session_info_changed`、`bash_execution_update`、`summarization_retry_scheduled`、`summarization_retry_attempt_start`、`summarization_retry_finished`。

没声明不等于前端不处理：前端在连接模块里单独处理了 `compaction_end`，其余的忽略。

新后端按 SDK 转发全部事件，并照现有后端的做法过滤：

| 事件 | 现有后端的处理 |
| --- | --- |
| `message_update` | 只转发助手消息的正文增量和思考增量，并把已经累计的正文清空，只留增量 |
| `turn_end`、`entry_appended` | 不转发。它们和 `message_end`、`snapshot` 重复 |
| `agent_end` | 转发，但把 `messages` 清空 |
| 其余 | 原样转发 |

每种事件的字段见 [session.md](session.md)。

另外，浏览器副本里的 `queue_update` 把 `steering` 和 `followUp` 写成可变数组，服务端是只读数组。这只是类型写法不同，线上格式一样。

## 不在消息上的差异

- `SentinelProxySettings`：服务端有 `testUrl` 字段，浏览器副本没有。这个类型只在后端内部使用，不在任何消息里，对契约没有影响。
- 浏览器副本把 `vuln_delete_preview` 和 `vulns_deleted` 各声明了两次，两次的形状完全相同，没有影响。

## 不是类型差异、但同属两份副本没对齐的一处

`ios_token_delete` 在两份类型里都有声明，前端的 iOS 设备页会发它，但服务端的分发逻辑里没有对应的分支。发出去只会得到 `error`，文案是 `未知消息类型: {type}`。见 [devices.md](devices.md)。

## 怎么改这份清单

改了协议之后，如果 `npm run check` 报 `protocol-alignment.ts` 里的类型错误，说明出现了新的差异：

1. 先判断是哪一边写错了。能改对就改对，差异消失。
2. 确实要有差异时，把消息名加进 `protocol-alignment.ts` 的 `ACCEPTED_SERVER_DRIFT` 或 `ACCEPTED_CLIENT_DRIFT`，一行一个。
3. 在本文档里加一行，写明差异和重写后端时照哪一边。
4. 跑 `packages/web/test/contract/docs.test.ts`，它检查名单里的每个消息在这里都有一行。
