# 控制台接口契约

这份契约描述浏览器控制台和后端之间的全部约定。读者有两类：照着接口开发前端的工程师，从 [frontend/README.md](frontend/README.md) 开始，那里有能直接导入 ApiFox 或 Postman 的文件；要重写后端的团队，读这一页和下面的各份文档，新后端必须让现有前端不改一行就能正常工作。

契约对应的版本是 `packages/web/package.json` 里的 `version`。每个版本的消息种类和字段以这里列出的文件为准，见「字段形状以哪里为准」。

## 范围

| 内容 | 在不在契约里 | 文档 |
| --- | --- | --- |
| HTTP 接口 `/api/*` | 在 | [openapi.yaml](openapi.yaml)、[http-api.md](http-api.md)；可导入的版本是 [frontend/http-api.json](frontend/http-api.json) |
| 前端页面与静态资源 | 在 | [http-api.md](http-api.md) |
| 插件界面与图标 `/plugin-ui/*`、`/plugin-icon/*` | 在 | [openapi.yaml](openapi.yaml) |
| WebSocket `/ws` | 在 | [websocket/README.md](websocket/README.md) 及其下的功能域文档 |
| 设备反连 `/ws/droid`、`/ws/ios` 与设备上传 | 不在。客户端是已发布的安装包，协议不能改，需要时另写 | — |
| 配置目录下的文件格式（配置 JSON、SQLite 库、会话记录） | 不在。新后端不需要读取现有安装的数据 | — |
| 后端对外部系统的调用（Docker、模型端点、通知机器人） | 不在。只描述它们在接口上表现出来的结果 | — |

设备反连和设备上传的路由在三道门之前处理，见「三道门」。

## 先读什么

前端开发从 [frontend/README.md](frontend/README.md) 开始：导入方法、环境变量、三道门怎么过、WebSocket 怎么连，以及示例是怎么来的。

重写后端的团队按这个顺序：

1. 本页：连接、鉴权和所有消息共用的约定。
2. [http-api.md](http-api.md)：HTTP 接口里 OpenAPI 表达不了的部分，然后查 [openapi.yaml](openapi.yaml)。
3. [websocket/README.md](websocket/README.md)：WebSocket 的消息格式和功能域索引，再按功能域读各文档。
4. [type-alignment.md](websocket/type-alignment.md)：两份类型文件的已知差异。写新后端时要按这里说的取哪一边。
5. [acceptance.md](acceptance.md)：怎么用现有前端和新后端验收。

## 整体结构

前端是一个单页应用，由后端托管，和后端同源。前端只跟自己的后端通信：WebSocket 地址取自页面地址，HTTP 请求都用相对路径，没有可以配置的后端地址。

```text
浏览器
  │  HTTPS（或 HTTP）: 页面、静态资源、/api/*
  │  WSS（或 WS）: /ws，一帧一条 JSON 消息
后端（一个进程，一个端口，默认 7777）
  │  在进程内运行 Agent
  │  通过 docker exec 在项目容器的 Kali 环境里执行命令
```

## 三道门

每个 HTTP 请求和 WebSocket 握手依次经过三道门。任何一道没过，请求到不了接口本身。

### 第一道：入口串

目的：不让扫描器发现这里有控制台。

- 后端每次启动生成一个随机的入口串，启动日志里打印入口地址 `/<入口串>`。
- 打开入口地址：后端回 `302` 跳转到 `/`，同时下发 Cookie `sentinel-gate`。Cookie 的值是入口串的 HMAC-SHA256，不是入口串本身；属性是 `Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`。
- 其余任何不带这个 Cookie 的请求，一律回 `404`，正文是纯文本 `Not Found\n`。没有跳转，没有登录页，没有任何能识别出这个服务的特征。`/`、静态资源、`/api/*` 和 WebSocket 握手都一样。
- 入口串每次启动都变，所以旧地址重启后失效。启动参数可以固定它（8 到 64 位字母、数字、下划线、短横线），也可以整道门关掉。

例外，不经过这道门：

- `/plugin-ui/*`：插件界面在沙箱 iframe 里加载，带不上 Cookie，改用路径里的临时令牌鉴权。
- `/assets/swagger-ui-*`：只是前端资源里的通用阅读器，不含控制台数据。
- `/api/intelligence/v1/ingest`、`/api/ios/upload/*`：调用方不是浏览器，用各自的凭据鉴权。

### 第二道：会话 Cookie

目的：确认操作员登录过。

- 一个管理员账号，用户名加密码。首次使用时创建。
- 登录成功后下发 Cookie `sentinel-auth`，属性是 `Path=/; HttpOnly; SameSite=Strict`。勾选「记住登录」时带 `Max-Age=2592000`，不勾选时是浏览器会话 Cookie。
- Cookie 的值是 `<过期时间毫秒>.<HMAC>`。后端不保存会话，靠轮换签名密钥让旧 Cookie 失效：只有最后一次登录有效，退出登录和修改密码会让之前签发的全部 Cookie 失效。
- 没有有效 Cookie 时：`/api/*` 回 `401`，正文 `{"error":"未登录"}`；WebSocket 握手回 `401`。

不需要会话 Cookie 的路由：`/api/auth/state`、`/api/auth/setup`、`/api/auth/login`、`/api/auth/logout`、`/api/ui-language`，以及上面列出的例外。各路由的请求和响应见 [openapi.yaml](openapi.yaml)。

### 第三道：首次使用的授权承诺

目的：操作员读完授权声明并勾选承诺之后，控制台才可用。

- 承诺记在后端：记录里有所接受声明的哈希和接受的账号名。换了账号，或者声明文字改了，承诺作废，要重新接受。
- 账号还没接受承诺时，已登录的请求访问 `/api/*` 回 `403`，正文 `{"error":"consent_required"}`；WebSocket 握手回 `403`。
- 这期间仍然可用的路由：`/api/auth/session`（查询是否需要承诺）、`/api/consent`（取声明）、`/api/consent/accept`（记录承诺）、`/api/ui-language`。

## WebSocket 连接

### 地址与握手

- 地址是 `wss://<主机>:<端口>/ws`，页面是 HTTP 时是 `ws://`。不带子协议。
- 握手请求带着浏览器的 Cookie，服务端在握手时检查三道门。检查结果体现在握手响应上：没有入口 Cookie 是 `404`，没有会话 Cookie 是 `401`，还没接受承诺是 `403`。握手成功才升级连接。

### 连接建立后服务端先推什么

按这个顺序发给新连接：

1. `ui_config`：当前界面语言。
2. `snapshot`：完整状态。
3. `projects`：项目列表和当前项目（要等 Docker 返回容器状态，可能晚一点到）。
4. `engines`、`doctrines`、`gatekeeper_config`、`model_library`、`asset_config`、`websearch_config`、`mcp_servers`：各设置页需要的配置。
5. `proxy_config`：代理配置（异步，可能晚一点到）。

另外，服务端启动时和每次环境检查后都会向所有连接广播 `environment`。

### 心跳

- 服务端每 25 秒发一个 WebSocket 协议层的 ping。任何一帧来自浏览器的消息也算作响应。
- 90 秒内既没有 pong 也没有消息，服务端直接断开这条连接。
- 心跳在协议层，不是 JSON 消息，浏览器端的 `WebSocket` 自动回 pong，前端不处理。

### 关闭码

| 关闭码 | 原因字符串 | 什么时候 |
| --- | --- | --- |
| `4001` | `session_replaced` | 另一个浏览器登录成功。旧连接全部关闭，只有最新的登录有效 |
| `4001` | `session_expired` | 退出登录或修改密码之后；或者连接还在，但这条连接的会话 Cookie 已失效 |

前端收到 `4001` 后查询 `/api/auth/session`：未登录就记下原因并刷新页面回到登录页；仍登录就清空待发消息后重连。

### 断开与重连

前端的行为，新后端要知道并配合：

- 连接断开后前端自动重连，间隔从 500 毫秒开始翻倍，最长 10 秒。
- 断开期间前端把要发的消息排队，连上后按顺序补发。收到 `4001` 时清空队列，不补发。
- 重连后前端不要求补发断线期间的消息。它靠新连接收到的 `snapshot` 和各列表消息恢复状态。所以重连后的首轮推送必须完整。

### 慢连接

某个连接上待发数据超过 32 MB 时，服务端直接断开它，不无限堆积。前端重连后从 `snapshot` 恢复。

## 消息的通用约定

### 一帧一条 JSON 消息

每条消息是一个普通的 JSON 对象，`type` 字段是消息名，其余字段平铺在同一层，没有外层信封：

```json
{ "type": "prompt", "text": "检查这个站点的登录接口" }
```

### 两个方向

| 方向 | 谁发 | 消息种类 | 文档里的叫法 |
| --- | --- | --- | --- |
| 浏览器 → 服务端 | 前端 | 227 种 | 上行消息 |
| 服务端 → 浏览器 | 后端 | 119 种 | 下行消息 |

上行消息里的 `type` 不是这 227 种之一时，服务端回 `error`，文案是 `未知消息类型: {type}`。JSON 解析不了时回 `error`，文案是 `无法解析的消息格式`。

### 回复和广播

下行消息按接收方分两种：

- **回复**：只发给发出那条上行消息的连接。每份功能域文档在上行消息的「回复请求方」一行列出。
- **广播**：发给所有已连接的控制台，包括触发它的那个。「广播」一行列出。

后端是为单个操作员设计的，但允许同时开多个控制台，它们看到同一条事件流。所有由状态变化引起的推送（Agent 的事件、审批请求、任务进度）都是广播。

### 没有请求 ID 的消息靠顺序对应

大部分上行消息没有请求 ID，前端按「发了一条消息，等对应类型的回复」处理。带请求 ID 的消息是例外，回复里原样带回，这样几次请求的回复不会弄混：`list_model_channels`、`list_channel_models`、`list_code_activity`、`code_monitor_branches`、`plugin_ui_call` 的 `requestId`。

同一条连接上，服务端按收到的顺序开始处理消息，但处理是异步的：前一条还没处理完时，后一条就已经开始处理了。

### 出错

失败统一用下行消息 `error` 回复，只有一个字段 `message`，是给操作员看的完整句子。四种情况见 [connection.md](websocket/connection.md)。

部分功能不用 `error`，而是回一条带 `ok: false` 和 `error` 字段的结果消息，这样页面能就地显示。各功能域文档会写明是哪一种。

### 界面语言

服务端只有一个当前语言，`zh` 或 `en`，所有控制台共用。`error` 文案、环境检查项、结果消息里的说明都按这个语言生成。切换用上行消息 `set_ui_language`，切换后所有控制台都会收到广播 `ui_config`。

新后端要带上文案表，否则切换到英文后这些文案还是中文。文案表见 [appendix/messages.json](appendix/messages.json)，用法见 [appendix/README.md](appendix/README.md)。

### `snapshot` 的合并

状态一变，服务端就安排一次 `snapshot` 广播。100 毫秒内的多次变化合并成一次，所以不要假设「一次操作对应一个 `snapshot`」，也不要依赖 `snapshot` 和事件消息之间的先后。

## 四条时序

### 1. 首次启动到进入控制台

```text
浏览器                              后端
  │  GET /<入口串>                    │
  │──────────────────────────────────>│ 生成入口 Cookie
  │  302 → /  Set-Cookie: sentinel-gate
  │<──────────────────────────────────│
  │  GET /                            │
  │──────────────────────────────────>│ 返回前端页面
  │  GET /api/auth/state              │
  │──────────────────────────────────>│ { configured: false }
  │  POST /api/auth/setup             │ 创建账号
  │──────────────────────────────────>│ 下发会话 Cookie
  │  POST /api/consent/accept         │ 记录承诺
  │──────────────────────────────────>│
  │  WebSocket /ws                    │ 三道门都通过，升级连接
  │──────────────────────────────────>│
  │<──────────────────────────────────│ ui_config、snapshot、projects、各配置…
```

### 2. 发送一句话

```text
浏览器                              后端
  │  { type: "prompt", text: "…" }   │
  │──────────────────────────────────>│ 检查 Docker 环境，不通过则回 error
  │<──────────────────────────────────│ snapshot（运行状态变为运行中）
  │<──────────────────────────────────│ session_event  agent_start
  │<──────────────────────────────────│ session_event  message_start
  │<──────────────────────────────────│ session_event  message_update（增量，很多条）
  │<──────────────────────────────────│ session_event  tool_execution_start
  │<──────────────────────────────────│ session_event  tool_execution_update
  │<──────────────────────────────────│ session_event  tool_execution_end
  │<──────────────────────────────────│ session_event  …（重复，直到模型不再调用工具）
  │<──────────────────────────────────│ session_event  message_end
  │<──────────────────────────────────│ session_event  agent_end
  │<──────────────────────────────────│ snapshot（运行状态变为空闲）
```

浏览器要中止时发 `{ type: "abort" }`。

### 3. 审批模式下的一条命令

```text
浏览器                              后端
  │<──────────────────────────────────│ snapshot（pendingApprovals 里多了一条，含命令全文）
  │  { type: "decide",
  │    decision: { id, approved, command? } }
  │──────────────────────────────────>│
  │<──────────────────────────────────│ snapshot（pendingApprovals 里那条消失）
  │<──────────────────────────────────│ session_event（命令执行、结束）
  │<──────────────────────────────────│ gate_decision（记录这次是谁放行的）
```

待审批的命令放在 `snapshot` 的 `pendingApprovals` 里，所有控制台都收得到，任何一个都能审批。审批请求已经被别的窗口处理过时，再发 `decide` 会回 `error`。`gate_decision` 是判定记录：`decision` 是 `allow`、`block` 或 `failed`，`approval` 是放行方 `human`、`ai` 或 `auto`。细节见 [session.md](websocket/session.md)。

### 4. 会话被顶替

```text
浏览器 A                            后端                       浏览器 B
  │                                  │  POST /api/auth/login     │
  │                                  │<──────────────────────────│
  │                                  │  { ok: true } + 新 Cookie  │
  │                                  │──────────────────────────>│
  │  WebSocket 关闭，4001             │ 清空插件界面令牌           │
  │  session_replaced                │ 关闭 A 的连接              │
  │<──────────────────────────────────│
  │  GET /api/auth/session → 401      │
  │──────────────────────────────────>│
  │  显示提示并刷新，回到登录页        │
```

## 字段形状以哪里为准

每个消息的字段由 TypeScript 类型定义，有两份：

| 文件 | 视角 | 用途 |
| --- | --- | --- |
| `packages/web/src/protocol.ts` | 服务端：后端读什么、发什么 | 下行消息以它为准 |
| `packages/web/webui/src/types.ts` | 浏览器：前端发什么、读什么 | 上行消息以它为准 |

两份是手工保持一致的镜像。编译器会检查它们：227 种上行消息结构上完全一致；下行有 11 种存在已知差异，每一处的取舍写在 [type-alignment.md](websocket/type-alignment.md)。

注意两类类型文件不等于线上的情况：

- 服务端的类型描述的是序列化之前的值。例如会话列表里的 `created` 在类型里是 `Date`，线上是 ISO 8601 字符串。已知的情况见 [type-alignment.md](websocket/type-alignment.md)。
- 服务端有些字段的类型是 `unknown` 或宽松的 `string`，实际内容更具体。浏览器那一份给出了真实形状。

每个功能域文档里每条消息都带一个 JSON 样例。样例经过了编译器对消息类型的校验，可以当作目标形状直接对照。

## 怎么保持这份契约不过期

仓库里有自动检查，改了接口而没改文档会让 `npm run check` 或测试失败：

| 检查 | 哪里 | 管什么 |
| --- | --- | --- |
| 编译期比对两份类型 | `packages/web/webui/src/protocol-alignment.ts` | 两份类型出现新的不一致 |
| 文档覆盖与交叉核对 | `packages/web/test/contract/docs.test.ts` | 每种消息有且只有一个条目；上行条目列全了处理函数回复和广播的消息、可能回的失败文案；每条的 JSON 样例与类型校验过的样例一致 |
| 文档对照真实后端 | `packages/web/test/contract/replay.test.ts` | 把每种可以安全发送的上行消息的样例发给真实后端：它回的每种消息、每条失败文案都是条目里列了的，每条消息都符合生成的结构 |
| HTTP 路由核对 | `packages/web/test/contract/http-doc.test.ts` | `openapi.yaml` 的路径与 `server.ts` 里实际匹配的路由一一对应；版本号与控制台版本一致 |
| HTTP 文档对照真实后端 | `packages/web/test/contract/http-replay.test.ts` | 把 98 个 HTTP 操作里可以发送的 90 个按文档的示例发给真实后端：状态码是文档列了的、也是步骤预期的，每个 JSON 响应符合文档给这个状态码的结构 |
| 导入文件自洽 | `packages/web/test/contract/frontend-docs.test.ts` | `http-api.json` 的引用都能解析，只用了 OpenAPI 3.0 的关键字；每个示例符合旁边的结构；Postman 集合发的请求和存的响应就是文档里的示例；`websocket-messages.json` 有全部 346 种消息，内容与各功能域文档一致 |
| 生成物不过期 | `npm --prefix packages/web run check:contract` | 文案表、常量表、结构定义、导入文件都与源码一致 |

## 已知的服务端缺口

- `ios_token_delete`：前端的 iOS 设备页会发这条消息，服务端没有对应的处理分支，会回 `未知消息类型`。见 [devices.md](websocket/devices.md)。
