# 连接与通用消息

本域只有三条消息：界面语言的设置与通知，以及所有功能域共用的错误消息。连接建立后服务端主动推送的内容、心跳和关闭码见 [README](README.md)。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 1 种 |
| 下行消息 | 2 种 |
| 处理代码 | `packages/web/src/server.ts` 第 4505–4511 行（`set_ui_language`）、第 1994 行（连接后推送 `ui_config`）、第 4651–4653 行（`sendError`） |

字段形状以 `packages/web/src/protocol.ts` 为准：`set_ui_language`、`ui_config`、`error` 三个成员，以及 `UiLanguage`（`packages/web/src/i18n-messages.ts`）。浏览器视角在 `packages/web/webui/src/types.ts`，两边结构一致。

通用约定见 [README](README.md)。

## 界面语言是全局的

服务端只有一门当前语言，所有已连接的控制台共用。`error` 文案、环境检查项、报告里的服务端文案都用这门语言生成。语言存在配置目录的 `ui-config.json`，服务端启动时读取。

## 上行消息（浏览器 → 服务端）

### `set_ui_language`

切换界面语言。服务端先改自己的当前语言并写入配置，再把新的语言广播给所有控制台。

| 项目 | 内容 |
| --- | --- |
| 字段 | `language`：`"zh"` 或 `"en"` |
| 回复请求方 | 无（结果是广播） |
| 广播 | `ui_config` |
| 失败文案 | 无 |

```json
{
	"type": "set_ui_language",
	"language": "en"
}
```

`language` 不是这两个值之一时，服务端忽略这条消息，不回任何内容。

## 下行消息（服务端 → 浏览器）

### `ui_config`

当前界面语言。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 连接建立后立即发给这个连接一次；`set_ui_language` 之后广播给所有控制台；通过 HTTP 的 `POST /api/ui-language` 修改后同样广播 |

```json
{
	"type": "ui_config",
	"language": "zh"
}
```

### `error`

一条消息处理失败的说明。`message` 是给操作员看的完整句子，已按当前界面语言生成，浏览器原样显示。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 见下面四种情况 |

```json
{
	"type": "error",
	"message": "未知消息类型: foo"
}
```

服务端在四种情况下发这条消息：

1. 收到的 JSON 解析不了，文案是 `无法解析的消息格式`。
2. `type` 不是任何一种上行消息，文案是 `未知消息类型: {type}`。
3. 某条消息的处理函数用 `sendError` 主动报告失败。各功能域文档的「失败文案」行列出了这些文案。
4. 处理函数抛出异常。文案是异常的 `message`。

前三种只发给发出消息的连接。后台任务的失败（例如订阅定时刷新出错）会广播给所有控制台。
