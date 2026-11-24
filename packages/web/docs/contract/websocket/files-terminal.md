# 文件与终端

本域有两块，都作用在「当前项目」上。当前项目是控制台此刻选中的项目。

- 文件：在当前项目的工作目录里列目录、预览、下载、保存、上传、删除、改名、新建目录，以及把一个文件夹打包下载。
- 终端：操作员在当前项目的容器里自己的 shell。它不是 Agent 的工具调用，不过审批，也不进会话记录。

| 项目 | 说明 |
| --- | --- |
| 上行消息 | 13 种 |
| 下行消息 | 12 种 |
| 处理代码 | `packages/web/src/server.ts` 第 3272–3424 行（13 条上行消息的处理分支）、第 387–405 行（`runFileAction`，五条修改文件的分支共用）、第 496–499 行（终端管理器，广播 `terminal_output` 和 `terminal_exit`） |
| 运行时方法 | `packages/web/src/sentinel-session.ts` 的 `listFiles` 到 `makeDirectory`，第 4847–4894 行 |
| 辅助代码 | `packages/web/src/files.ts`（路径检查、读写）、`packages/web/src/folder-archive.ts`（打包任务）、`packages/web/src/terminal.ts`（终端） |

字段形状以两份类型文件为准，本域涉及的类型在两边结构一致：

- 服务端视角：`packages/web/src/protocol.ts` 的 `SentinelFileEntry`、`SentinelFilePreview`、`SentinelTerminalSession`（第 563–601 行）。
- 浏览器视角：`packages/web/webui/src/types.ts` 里的同名类型。

通用约定见 [README](README.md)。每个上行消息下面的表里：

- 「回复请求方」只发给发出这条消息的连接。
- 「广播」发给所有已连接的控制台，包括发出消息的那个。
- 「失败文案」列出处理这条消息时可能回给浏览器的 `error` 文案。花括号是占位符。有几条带 `{action}`，它是操作名，各条消息的说明里写了填什么。

## 工作目录和路径的写法

每个项目有一个工作目录。它在主机上，同时挂载在项目容器的 `/work`。本域的路径一律写容器里的名字，也就是 `/work` 下面的绝对路径，下文叫「容器路径」。

服务端这样处理浏览器发来的 `path`：

- 空串表示根目录 `/work`。
- 不以 `/` 开头的路径接在 `/work` 下面。`evidence/notes.md` 就是 `/work/evidence/notes.md`。
- 先折叠 `..` 和多余的 `/`，再检查结果。这一步只看文字，不解析符号链接。
- 结果不是 `/work`，也不在 `/work/` 下面，回失败文案 `路径越界：只能访问容器 /work 目录内的文件`。
- 路径里有空字符（`\0`），回失败文案 `路径包含非法字符`。

回复里的路径是折叠后的绝对路径。唯一的例外是 `file_result` 的 `path`，它原样带回浏览器发来的值。

读、写、删除、改名都在容器里以 root 身份执行，所以 Agent 以 root 身份写出的文件也能读。

## 没有容器时

九条文件消息都要求当前项目有容器。没有时：

- `list_files`、`read_file`、`download_file` 回 `error`，文案是 `没有可用的项目容器，请先创建或选择一个项目`。
- 五条修改文件的消息回 `file_result`，`ok` 为 `false`，`error` 是同一句话。
- `download_folder` 回 `folder_archive_failed`，不带 `id`，`error` 是同一句话。

终端的消息另有一套检查，见 `terminal_open`。

## 上限

| 内容 | 上限 | 超出时 |
| --- | --- | --- |
| `read_file` 带回的内容 | 256 KB | 不算失败。只带前 256 KB，`truncated` 为 `true` |
| `write_file` 写入的内容、`upload_file` 解码后的内容 | 32 MB | 失败 |
| `download_file` 下载的文件 | 32 MB | 失败 |
| `terminal_state` 的 `replay` | 约 26 万个字符 | 丢弃最旧的输出，保留最新的 |

## 上行消息（浏览器 → 服务端）

### `list_files`

列出一个目录里的直接内容，给文件面板用。只读。

| 项目 | 内容 |
| --- | --- |
| 字段 | `path` 必填，要列的目录，写法见「工作目录和路径的写法」 |
| 回复请求方 | `error`、`files` |
| 广播 | 无 |
| 失败文案 | `没有可用的项目容器，请先创建或选择一个项目`、`路径包含非法字符`、`路径越界：只能访问容器 /work 目录内的文件`、`目录不存在或不可读`、`{action}失败：{detail}`、`{action}失败（退出码 {code}）` |

```json
{
	"type": "list_files",
	"path": "/work/evidence"
}
```

失败回 `error`。没有容器和路径被拒绝的情况见上面两节。另外三种：

- 目录不存在，或者 `path` 指向一个文件：`目录不存在或不可读`。
- 目录存在，但控制台进程自己读不了（权限不足）。这时服务端改到容器里去列，容器以 root 运行，读得到。容器里的列目录命令也失败时，回带 `{action}` 的两条之一，`{action}` 处填 `读取目录`：命令有错误输出，`{detail}` 就是这段输出；没有错误输出，`{code}` 是退出码。
- 别的读目录错误：`error` 的文案是系统给的错误信息，不是上表里的固定文案。

### `read_file`

读一个文件的开头，给预览用。文本带回内容，图片转成 base64，其它二进制文件只报告类型和大小。

`path` 还有一种写法：工作目录在主机上的绝对路径。Agent 记在证据里的文件常是这种写法，服务端把它换成同一个文件的容器路径。不在工作目录里的主机路径，按「工作目录和路径的写法」的规则检查。

| 项目 | 内容 |
| --- | --- |
| 字段 | `path` 必填，要读的文件 |
| 回复请求方 | `error`、`file_preview` |
| 广播 | 无 |
| 失败文案 | `没有可用的项目容器，请先创建或选择一个项目`、`路径包含非法字符`、`路径越界：只能访问容器 /work 目录内的文件`、`{action}失败：文件不存在或不可读`、`{action}失败：{detail}`、`{action}失败（退出码 {code}）` |

```json
{
	"type": "read_file",
	"path": "/work/evidence/notes.md"
}
```

文件超过 256 KB 不算失败，见「上限」。失败回 `error`，带 `{action}` 的三条里 `{action}` 处填 `读取文件`：

- `{action}失败：文件不存在或不可读`：文件不存在、读不了，或者 `path` 指向一个目录。
- 另外两条：容器里的读取命令以别的状态退出，例如容器没有在运行，或者 30 秒内没有读完。命令有错误输出，`{detail}` 就是这段输出；没有错误输出，`{code}` 是退出码。

### `download_file`

下载一个文件。整个文件的内容放在回复里，是 base64。

| 项目 | 内容 |
| --- | --- |
| 字段 | `path` 必填，要下载的文件 |
| 回复请求方 | `error`、`file_download` |
| 广播 | 无 |
| 失败文案 | `没有可用的项目容器，请先创建或选择一个项目`、`路径包含非法字符`、`路径越界：只能访问容器 /work 目录内的文件`、`{action}失败：文件不存在或不可读`、`{action}失败：文件超过 {max}MB 上限`、`{action}失败：{detail}`、`{action}失败（退出码 {code}）` |

```json
{
	"type": "download_file",
	"path": "/work/evidence/login.png"
}
```

失败回 `error`，带 `{action}` 的四条里 `{action}` 处填 `下载`：

- `{action}失败：文件不存在或不可读`：文件不存在、读不了，或者 `path` 指向一个目录。
- `{action}失败：文件超过 {max}MB 上限`：文件大于 32 MB，`{max}` 是 `32`。
- 另外两条：容器里的命令以别的状态退出，例如容器没有在运行，或者 120 秒内没有读完。命令有错误输出，`{detail}` 就是这段输出；没有错误输出，`{code}` 是退出码。

### `write_file`

把一段文本存成文件。文件面板的「保存」用它。文件已存在就整个覆盖，不存在就新建，缺少的上级目录一并建出。

| 项目 | 内容 |
| --- | --- |
| 字段 | `path` 必填，目标文件；`text` 必填，文件的完整内容，按 UTF-8 写入 |
| 回复请求方 | `file_result` |
| 广播 | 无 |
| 失败文案 | 无 |

```json
{
	"type": "write_file",
	"path": "/work/evidence/notes.md",
	"text": "# 登录接口\n\n- 表单地址：https://example.com/login\n- 弱口令：admin / admin，已复现\n"
}
```

这条消息不用 `error` 报告失败。成功和失败都回 `file_result`，`action` 是 `保存`。失败时 `ok` 为 `false`，`error` 字段是下面之一：

- `没有可用的项目容器，请先创建或选择一个项目`、`路径包含非法字符`、`路径越界：只能访问容器 /work 目录内的文件`。
- `上传失败：文件超过 {max}MB 上限`：`text` 按 UTF-8 编码后超过 32 MB。这句写的是「上传」，保存时也是它。
- `{action}失败：文件不存在或不可读`：容器里建不出上级目录，或者写不进目标文件，例如目标是一个目录。`{action}` 处填 `写入`。
- `{action}失败：{detail}`、`{action}失败（退出码 {code}）`：容器里的命令以别的状态退出，例如容器没有在运行，或者 120 秒内没有写完。命令有错误输出，`{detail}` 就是这段输出；没有错误输出，`{code}` 是退出码。

### `upload_file`

上传一个文件。行为和 `write_file` 一样：文件已存在就覆盖，缺少的上级目录一并建出。

| 项目 | 内容 |
| --- | --- |
| 字段 | `path` 必填，目标文件；`data` 必填，文件内容的 base64，不带 `data:` 前缀 |
| 回复请求方 | `file_result` |
| 广播 | 无 |
| 失败文案 | 无 |

```json
{
	"type": "upload_file",
	"path": "/work/tools/wordlist.txt",
	"data": "YWRtaW46YWRtaW4Kcm9vdDpyb290Cg=="
}
```

这条消息不用 `error` 报告失败。成功和失败都回 `file_result`，`action` 是 `上传`。失败时 `ok` 为 `false`，`error` 字段的取值和 `write_file` 完全相同：上限按解码后的字节数算，带 `{action}` 的文案里填的也是 `写入`。

### `delete_path`

删除一个文件或目录。目录连同里面的全部内容一起删。

| 项目 | 内容 |
| --- | --- |
| 字段 | `path` 必填，要删的文件或目录 |
| 回复请求方 | `file_result` |
| 广播 | 无 |
| 失败文案 | 无 |

```json
{
	"type": "delete_path",
	"path": "/work/evidence/tmp"
}
```

这条消息不用 `error` 报告失败。成功和失败都回 `file_result`，`action` 是 `删除`。失败时 `ok` 为 `false`，`error` 字段是下面之一：

- `没有可用的项目容器，请先创建或选择一个项目`、`路径包含非法字符`、`路径越界：只能访问容器 /work 目录内的文件`。
- `删除失败：不允许操作 /work 根目录`：`path` 是 `/work`。
- `{action}失败：文件不存在或不可读`：容器里的删除命令自己报了失败，例如路径不存在。
- `{action}失败：{detail}`、`{action}失败（退出码 {code}）`：命令以别的状态退出，例如容器没有在运行，或者 60 秒内没有删完。命令有错误输出，`{detail}` 就是这段输出；没有错误输出，`{code}` 是退出码。

带 `{action}` 的三条里 `{action}` 处填 `删除`。

### `rename_path`

把 `from` 改名成 `to`，或者移到 `to`。文件和目录都可以。`to` 的上级目录缺少时一并建出。

| 项目 | 内容 |
| --- | --- |
| 字段 | `from` 必填，现有的文件或目录；`to` 必填，新的路径。两个都按「工作目录和路径的写法」处理 |
| 回复请求方 | `file_result` |
| 广播 | 无 |
| 失败文案 | 无 |

```json
{
	"type": "rename_path",
	"from": "/work/evidence/notes.md",
	"to": "/work/evidence/login-notes.md"
}
```

这条消息不用 `error` 报告失败。成功和失败都回 `file_result`，`action` 是 `重命名`。失败时 `ok` 为 `false`，`error` 字段是下面之一：

- `没有可用的项目容器，请先创建或选择一个项目`、`路径包含非法字符`、`路径越界：只能访问容器 /work 目录内的文件`。`from` 和 `to` 各检查一次。
- `重命名失败：不允许操作 /work 根目录`：`from` 或 `to` 是 `/work`。
- `{action}失败：文件不存在或不可读`：`from` 不存在，或者 `to` 的上级目录建不出来。
- `{action}失败：目标已存在`：`to` 已经存在。
- `{action}失败：{detail}`、`{action}失败（退出码 {code}）`：移动命令以别的状态退出，例如容器没有在运行。命令有错误输出，`{detail}` 就是这段输出；没有错误输出，`{code}` 是退出码。

带 `{action}` 的四条里 `{action}` 处填 `重命名`。

### `make_directory`

新建一个目录。上级目录缺少时一并建出。目录已经存在不算失败。

| 项目 | 内容 |
| --- | --- |
| 字段 | `path` 必填，要新建的目录 |
| 回复请求方 | `file_result` |
| 广播 | 无 |
| 失败文案 | 无 |

```json
{
	"type": "make_directory",
	"path": "/work/evidence/screenshots"
}
```

这条消息不用 `error` 报告失败。成功和失败都回 `file_result`，`action` 是 `新建目录`。失败时 `ok` 为 `false`，`error` 字段是下面之一：

- `没有可用的项目容器，请先创建或选择一个项目`、`路径包含非法字符`、`路径越界：只能访问容器 /work 目录内的文件`。
- `新建目录失败：目录已存在`：`path` 是 `/work`。
- `{action}失败：文件不存在或不可读`：容器里的建目录命令自己报了失败，例如上级路径里有一段是文件。
- `{action}失败：{detail}`、`{action}失败（退出码 {code}）`：命令以别的状态退出，例如容器没有在运行。命令有错误输出，`{detail}` 就是这段输出；没有错误输出，`{code}` 是退出码。

带 `{action}` 的三条里 `{action}` 处填 `新建目录`。

### `download_folder`

把一个文件夹打成 tar.gz 供下载。打包在后台进行，结果通过一组消息陆续回来。压缩包本身不经过 WebSocket：浏览器收到 `folder_archive_ready` 后，立刻用 `id` 请求 `GET /api/folder-archives/{id}`。这条 HTTP 路由见 [openapi.yaml](../openapi.yaml)。

| 项目 | 内容 |
| --- | --- |
| 字段 | `path` 必填，要打包的目录。`/work` 表示整个工作目录 |
| 回复请求方 | `folder_archive_started`、`folder_archive_progress`、`folder_archive_ready`、`folder_archive_failed`、`folder_archive_cancelled` |
| 广播 | 无 |
| 失败文案 | 无 |

```json
{
	"type": "download_folder",
	"path": "/work/evidence"
}
```

这组消息只发给发出 `download_folder` 的那条连接，顺序固定：

```text
浏览器                                      服务端
  │  download_folder                          │
  │──────────────────────────────────────────>│ 检查目录
  │<──────────────────────────────────────────│ folder_archive_started
  │<──────────────────────────────────────────│ folder_archive_progress（一条或多条）
  │<──────────────────────────────────────────│ folder_archive_ready
  │  GET /api/folder-archives/{id}            │
  │──────────────────────────────────────────>│
```

1. `folder_archive_started`：检查通过，任务建立。
2. `folder_archive_progress`：进度，一条或多条。
3. 结束消息，三选一：`folder_archive_ready`、`folder_archive_failed`、`folder_archive_cancelled`。

这条消息不用 `error`。检查阶段就失败时，没有 `folder_archive_started`，回 `folder_archive_failed`，不带 `id`，`error` 是下面之一：

- `没有可用的项目容器，请先创建或选择一个项目`
- `路径包含非法字符`
- `路径越界：只能访问容器 /work 目录内的文件`
- `只能下载文件夹`：`path` 不是目录，或者到容器里检查目录的命令失败，例如容器没有在运行，或者 15 秒内没有返回。

打包的要求：

- 在容器里以 root 身份执行，主机上普通用户读不了的文件也打得进去。
- 压缩包里的路径从 `/work` 算起。`/work/evidence` 的压缩包里是 `evidence/…`；整个工作目录的压缩包里是 `./…`。
- 包含以 `.` 开头的文件。
- 符号链接按链接本身存进压缩包，不跟随到它指向的文件。
- 打包时有文件发生变化，压缩包照常提供，`folder_archive_ready` 带 `warning`。

### `cancel_folder_archive`

取消一个还在打包的任务。

| 项目 | 内容 |
| --- | --- |
| 字段 | `id` 必填，`folder_archive_started` 带回的任务 `id` |
| 回复请求方 | `folder_archive_failed` |
| 广播 | 无 |
| 失败文案 | 无 |

```json
{
	"type": "cancel_folder_archive",
	"id": "9b2e6f10-3c47-4a8d-9e51-7f0c2d8b4a16"
}
```

取消成功时，这条消息自己不回任何内容。确认是 `folder_archive_cancelled`，它发给当初发出 `download_folder` 的那条连接。取消来自另一个控制台时，那个控制台收不到确认。

`id` 对应的任务不存在，或者已经不在打包（已完成、已失败、已被取消、已过期），回 `folder_archive_failed`：`id` 是收到的 `id`，`error` 是 `打包任务不存在或已结束`。这条消息不用 `error`。

### `terminal_open`

打开当前项目的终端，也就是在这个项目的容器里启动一个 shell。终端面板每次打开都发这条消息。

| 项目 | 内容 |
| --- | --- |
| 字段 | `projectId` 必填，当前项目的 `id`；`cols` 必填，面板量到的列数；`rows` 必填，面板量到的行数 |
| 回复请求方 | `terminal_state` |
| 广播 | `terminal_output` |
| 失败文案 | 无 |

```json
{
	"type": "terminal_open",
	"projectId": "3f2b8c14-9d5e-4a71-b0c6-2e8f5d1a7c93",
	"cols": 120,
	"rows": 30
}
```

成功回 `terminal_state`，`outcome` 是 `opened`。分两种情况：

- 这个项目没有运行中的 shell：启动一个新的，`replay` 是空串。
- 这个项目已有运行中的 shell（面板关掉之后 shell 还在跑）：接回它，不再启动第二个。`replay` 是这个 shell 到此刻为止的输出，面板用它补上错过的内容。这时 `cols` 和 `rows` 不起作用。

shell 的要求：

- 在容器里以伪终端（pty）运行。伪终端让程序像面对真实的屏幕和键盘一样工作，所以 `top`、`nc -lvnp` 这类交互程序能用。
- `TERM` 是 `xterm-256color`，工作目录是 `/work`。镜像里有 `bash` 就用 `bash`，否则用 `sh`。
- 窗口大小在 shell 启动时定下，之后不变。列数取 20 到 500，行数取 5 到 200，超出范围的截到边界；不是数字时用 120 列、30 行。

这条消息不用 `error`。失败回 `terminal_state`，`outcome` 是 `failed`，`error` 是下面之一：

- `未选择项目，终端不可用`：没有当前项目。
- `项目没有容器，终端不可用`：当前项目没有容器。
- `终端项目与当前项目不匹配`：`projectId` 不是当前项目的 `id`。
- `项目容器未运行：{container}`：容器没有在运行。`{container}` 是容器名。

新 shell 启动后打印的内容（提示符等）以广播 `terminal_output` 到达，排在 `terminal_state` 后面。

### `terminal_input`

往终端里输入。

| 项目 | 内容 |
| --- | --- |
| 字段 | `projectId` 必填，终端所属的项目；`data` 必填，要写进 shell 的输入 |
| 回复请求方 | 无 |
| 广播 | `terminal_output` |
| 失败文案 | 无 |

```json
{
	"type": "terminal_input",
	"projectId": "3f2b8c14-9d5e-4a71-b0c6-2e8f5d1a7c93",
	"data": "id\r"
}
```

没有回复。`data` 是操作员在终端面板里敲的内容，原样写进 shell 的标准输入，一个字节都不改：回车是 `\r`，Ctrl+C 是 `\x03`，方向键是转义序列。shell 的输出稍后以广播 `terminal_output` 到达，所有控制台都收得到。

`projectId` 没有运行中的 shell 时（还没打开，或者已经退出），这条消息被丢弃，不回任何内容。

### `terminal_close`

结束一个项目的终端，shell 进程随之结束。面板上的「结束终端」用它。只关掉面板不发这条消息，shell 继续运行。

| 项目 | 内容 |
| --- | --- |
| 字段 | `projectId` 必填，要结束的终端所属的项目 |
| 回复请求方 | 无（结果是广播） |
| 广播 | `terminal_state` |
| 失败文案 | 无 |

```json
{
	"type": "terminal_close",
	"projectId": "3f2b8c14-9d5e-4a71-b0c6-2e8f5d1a7c93"
}
```

结束 shell 之后广播 `terminal_state`，`outcome` 是 `closed`，`projectId` 是收到的 `projectId`。发给所有控制台，这样每个开着的终端面板都会清掉这个 shell 的画面。

- 这个项目没有打开着的终端时，照常广播，不做别的事。
- 这样结束的 shell 不发 `terminal_exit`。`terminal_exit` 只用于 shell 自己退出的情况。

结束后再发 `terminal_open` 会启动一个新的 shell，没有可回放的内容。

## 下行消息（服务端 → 浏览器）

### `files`

一个目录的列表。`path` 是折叠后的绝对路径。`entries` 是这个目录的直接内容，目录排在前面，两组各自按名字排序。包含以 `.` 开头的文件，不包含 `.` 和 `..`。每一项：

- `name`：文件名。
- `path`：容器里的绝对路径。
- `type`：`dir` 是目录，`file` 是文件。
- `size`：字节数。目录是 `0`。
- `mtime`：修改时间，Unix 秒。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 回复 `list_files` |

```json
{
	"type": "files",
	"path": "/work/evidence",
	"entries": [
		{
			"name": "screenshots",
			"path": "/work/evidence/screenshots",
			"type": "dir",
			"size": 0,
			"mtime": 1795488000
		},
		{
			"name": "login.png",
			"path": "/work/evidence/login.png",
			"type": "file",
			"size": 69,
			"mtime": 1795488000
		},
		{
			"name": "notes.md",
			"path": "/work/evidence/notes.md",
			"type": "file",
			"size": 99,
			"mtime": 1795425160
		}
	]
}
```

### `file_preview`

一个文件的预览，放在 `preview` 里。

- `path`：折叠后的绝对路径。
- `size`：文件完整的大小，字节数。被截断时也是完整的大小。
- `truncated`：文件超过 256 KB 时为 `true`。
- `kind`：三种取值，决定还带哪些字段。

| `kind` | 什么文件 | 多带的字段 |
| --- | --- | --- |
| `text` | 读到的开头 8000 字节里没有空字符 | `text`：内容，最多前 256 KB，按 UTF-8 解码 |
| `image` | 有空字符，并且扩展名是 `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.bmp`、`.svg` 之一 | `data`：内容的 base64，最多前 256 KB；`mimeType`：图片的类型 |
| `binary` | 其它有空字符的文件 | 无 |

`mimeType` 按扩展名定：`.png` 是 `image/png`，`.jpg` 和 `.jpeg` 是 `image/jpeg`，`.gif` 是 `image/gif`，`.webp` 是 `image/webp`，`.bmp` 是 `image/bmp`，`.svg` 是 `image/svg+xml`。扩展名不分大小写。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 回复 `read_file` |

```json
{
	"type": "file_preview",
	"preview": {
		"path": "/work/evidence/notes.md",
		"kind": "text",
		"size": 99,
		"truncated": false,
		"text": "# 登录接口\n\n- 表单地址：https://example.com/login\n- 弱口令：admin / admin，已复现\n"
	}
}
```

### `file_download`

一个文件的完整内容。

- `path`：折叠后的绝对路径。
- `size`：字节数。
- `data`：文件内容的 base64。
- `mimeType`：按扩展名判断的类型，见下表。浏览器存盘时用它做文件的类型。

| 扩展名 | `mimeType` |
| --- | --- |
| `.png` | `image/png` |
| `.jpg`、`.jpeg` | `image/jpeg` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |
| `.bmp` | `image/bmp` |
| `.svg` | `image/svg+xml` |
| `.txt`、`.log` | `text/plain; charset=utf-8` |
| `.md` | `text/markdown; charset=utf-8` |
| `.csv` | `text/csv; charset=utf-8` |
| `.json` | `application/json; charset=utf-8` |
| `.xml` | `application/xml; charset=utf-8` |
| `.html`、`.htm` | `text/html; charset=utf-8` |
| `.sh` | `text/x-shellscript; charset=utf-8` |
| `.py` | `text/x-python; charset=utf-8` |
| `.js` | `text/javascript; charset=utf-8` |
| `.ts`、`.yaml`、`.yml`、`.conf` | `text/plain; charset=utf-8` |
| 其它 | `application/octet-stream` |

扩展名不分大小写。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 回复 `download_file` |

```json
{
	"type": "file_download",
	"path": "/work/evidence/login.png",
	"size": 69,
	"data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQyrsBAAIGAWHE0MhtAAAAAElFTkSuQmCC",
	"mimeType": "image/png"
}
```

### `file_result`

一条修改文件的消息的结果。

- `action`：是哪条消息，固定是下表的五个中文词之一，不随界面语言变化。浏览器拿它和这五个值做比较，决定收到后做什么。
- `path`：浏览器发来的路径，原样带回。`rename_path` 的结果里是 `from`。
- `ok`：`true` 是成功，这时没有 `error`。
- `error`：只在失败时有，给操作员看的一句话。取值见各条上行消息。

| `action` | 来自 |
| --- | --- |
| `保存` | `write_file` |
| `上传` | `upload_file` |
| `删除` | `delete_path` |
| `重命名` | `rename_path` |
| `新建目录` | `make_directory` |

浏览器收到后自己再发 `list_files` 和 `get_state` 来刷新列表和状态。服务端不为这次修改推送任何消息。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 回复 `write_file`、`upload_file`、`delete_path`、`rename_path`、`make_directory`，成功和失败都发 |

```json
{
	"type": "file_result",
	"action": "保存",
	"path": "/work/evidence/notes.md",
	"ok": true
}
```

### `folder_archive_started`

一个打包任务建立并开始。之后的进度和结果消息都带同一个 `id`。

- `id`：服务端为这次任务生成的 ID。
- `path`：折叠后的目录路径。
- `filename`：压缩包的文件名。目录是「目录名加 `.tar.gz`」，例如 `evidence.tar.gz`。`path` 是 `/work` 时是「项目名加 `-work.tar.gz`」。名字里的 `\`、`/` 和换行换成 `_`。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 回复 `download_folder`，检查通过之后。一个任务只发一次，是这组消息里的第一条 |

```json
{
	"type": "folder_archive_started",
	"id": "9b2e6f10-3c47-4a8d-9e51-7f0c2d8b4a16",
	"path": "/work/evidence",
	"filename": "evidence.tar.gz"
}
```

### `folder_archive_progress`

打包任务的进度。`id` 是任务 ID，`bytes` 是到此刻为止写入压缩包的字节数。

不是每个数据块都发：第一块数据发一条，之后 250 毫秒内最多一条，字节数没变不发。任务还没写出数据就失败或被取消的，一条都没有。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 回复 `download_folder` 的后续消息：任务打包期间，发给发起打包的那条连接 |

```json
{
	"type": "folder_archive_progress",
	"id": "9b2e6f10-3c47-4a8d-9e51-7f0c2d8b4a16",
	"bytes": 1835008
}
```

### `folder_archive_ready`

压缩包生成完毕。

- `id`：任务 ID。
- `filename`：压缩包的文件名，和 `folder_archive_started` 相同。
- `size`：压缩包的字节数，大于 0。
- `warning`：可选。打包时有文件发生变化就带上，文案是 `部分文件在打包时发生变化，压缩包可能不完整`。这时压缩包照常可用。

浏览器收到后立刻发起 HTTP 下载。压缩包在服务端保留 10 分钟，下载完成就删除。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 回复 `download_folder` 的后续消息：打包成功结束时，发给发起打包的那条连接。一个任务最多发一次 |

```json
{
	"type": "folder_archive_ready",
	"id": "9b2e6f10-3c47-4a8d-9e51-7f0c2d8b4a16",
	"filename": "evidence.tar.gz",
	"size": 3762816
}
```

### `folder_archive_failed`

打包失败。`id` 可选，`error` 是原因。三种形态：

| 什么时候 | `id` | `error` |
| --- | --- | --- |
| `download_folder` 检查目录就失败，任务没有建立 | 没有 | `没有可用的项目容器，请先创建或选择一个项目`、`路径包含非法字符`、`路径越界：只能访问容器 /work 目录内的文件`、`只能下载文件夹` |
| 任务建立后，打包中途失败 | 任务的 `id` | 容器里打包命令的错误输出。没有输出时是 `打包失败（退出码 {code}）`。压缩包是 0 字节时是 `打包失败：压缩包为空` |
| `cancel_folder_archive` 要取消的任务不在打包 | 收到的 `id` | `打包任务不存在或已结束` |

前两种形态发出后，这次任务就结束了，写出一半的压缩包被删掉。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 回复 `download_folder`：检查失败时不带 `id`，打包中途失败时带 `id`，都发给发起打包的那条连接。回复 `cancel_folder_archive`：要取消的任务不在打包时 |

```json
{
	"type": "folder_archive_failed",
	"id": "9b2e6f10-3c47-4a8d-9e51-7f0c2d8b4a16",
	"error": "tar: evidence/lost.txt: Cannot open: No such file or directory\ntar: Exiting with failure status due to previous errors"
}
```

### `folder_archive_cancelled`

打包任务被取消。`id` 是被取消的任务。写出一半的压缩包被删掉。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | `cancel_folder_archive` 取消成功之后，发给当初发出 `download_folder` 的那条连接 |

```json
{
	"type": "folder_archive_cancelled",
	"id": "9b2e6f10-3c47-4a8d-9e51-7f0c2d8b4a16"
}
```

### `terminal_state`

终端的状态。`projectId` 是终端所属的项目，`outcome` 有三种取值，决定还带哪些字段：

| `outcome` | 含义 | 多带的字段 |
| --- | --- | --- |
| `opened` | shell 可用。可能刚启动，也可能是接回已有的 | `session`、`replay` |
| `failed` | 打不开终端 | `error`：原因，见 `terminal_open` |
| `closed` | 终端被 `terminal_close` 结束 | 无 |

`session` 是 shell 的属性：

- `status`：这条消息里总是 `running`。
- `projectId`、`projectName`：所属的项目。
- `container`：容器名。
- `cols`、`rows`：shell 的窗口大小，列数和行数。
- `startedAt`：shell 启动的时刻，Unix 毫秒。
- `code`：退出码。这条消息里总是 `null`。

`replay` 是这个 shell 从启动到现在写出的全部输出，原样带回，含终端转义序列。上限见「上限」：超出的部分按整块丢弃最旧的，一块不拆开。新启动的 shell 是空串。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 回复 `terminal_open`：成功是 `opened`，失败是 `failed`。`terminal_close` 之后广播：`closed` |

```json
{
	"type": "terminal_state",
	"projectId": "3f2b8c14-9d5e-4a71-b0c6-2e8f5d1a7c93",
	"outcome": "opened",
	"session": {
		"status": "running",
		"projectId": "3f2b8c14-9d5e-4a71-b0c6-2e8f5d1a7c93",
		"projectName": "example-web",
		"container": "sentinel-3f2b8c14-9d5e",
		"cols": 120,
		"rows": 30,
		"startedAt": 1795487940000,
		"code": null
	},
	"replay": "root@sentinel-3f2b8c14-9d5e:/work# whoami\r\nroot\r\nroot@sentinel-3f2b8c14-9d5e:/work# "
}
```

### `terminal_output`

终端的一段输出。`projectId` 是终端所属的项目，`data` 是原文，含终端转义序列，换行是 `\r\n`。

`data` 有三种来源：

- shell 的标准输出：提示符和命令的结果。
- Docker 命令行自己的错误输出，例如容器不存在。它和 shell 输出混在同一个 `data` 里。
- 连接 shell 的进程出错：错误文字，前后各带一个 `\r\n`。

一个多字节字符不会拆到两条消息里。前半段先到时，服务端等后半段到齐再发字符，所以这种时候前一条消息的 `data` 是空串。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 某个项目的 shell 每写出一段就广播一次，发给所有控制台。`terminal_open` 新启动的 shell 的第一段输出（提示符等）也在其中 |

```json
{
	"type": "terminal_output",
	"projectId": "3f2b8c14-9d5e-4a71-b0c6-2e8f5d1a7c93",
	"data": "uid=0(root) gid=0(root) groups=0(root)\r\n"
}
```

### `terminal_exit`

shell 自己退出了。`projectId` 是终端所属的项目，`code` 是退出码，被信号结束时是 `null`。

「自己退出」的例子：操作员输入了 `exit`，或者容器停了、被删了。`terminal_close` 结束的 shell 不发这条消息。

退出后，下一次 `terminal_open` 会启动一个新的 shell。

| 项目 | 内容 |
| --- | --- |
| 发送时机 | 某个项目的 shell 结束，并且不是 `terminal_close` 结束的。广播，发给所有控制台 |

```json
{
	"type": "terminal_exit",
	"projectId": "3f2b8c14-9d5e-4a71-b0c6-2e8f5d1a7c93",
	"code": 0
}
```
