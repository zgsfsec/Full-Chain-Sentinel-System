# 前端开发用的接口文档

这个目录下的文件可以直接导入 ApiFox 或 Postman。后端每个版本重新生成一次，不要手改。

## 文件

| 文件 | 用途 |
| --- | --- |
| [http-api.json](http-api.json) | 98 个 HTTP 操作，OpenAPI 3.0：每个操作要过哪几道门、每个参数和请求体的示例、每种状态码的响应结构和示例 |
| [sentinel.postman_collection.json](sentinel.postman_collection.json) | Postman 集合：同样的 98 个操作按功能分组，每个请求的 Examples 里存着各种状态码的响应样例；最后一个分组是 WebSocket |
| [sentinel.postman_environment.json](sentinel.postman_environment.json) | Postman 环境：下面 5 个变量 |
| [websocket-messages.json](websocket-messages.json) | 不导入，查：347 种 WebSocket 消息的结构、样例和服务端会回什么 |
| [schemas.generated.json](schemas.generated.json) | 不导入：上面几个文件里响应结构的来源，从后端的 TypeScript 类型生成，可以拿去做校验或生成类型 |

菜单名以各工具当前版本为准。

## 导入

Postman：

1. Import，把 `sentinel.postman_collection.json` 和 `sentinel.postman_environment.json` 一起选上。
2. 右上角选环境「全链哨兵：本地」，填 `gateToken` 和 `password`。
3. 从「0. 先做这三步」开始，按顺序发。

ApiFox：

1. 项目里选「导入数据」，选 OpenAPI / Swagger，导入 `http-api.json`。
2. 新建一个环境，手工加上面 5 个变量，填 `baseUrl`、`gateToken`、`password`。
3. WebSocket 要手工新建：新建 WebSocket 请求，地址 `ws://<主机>:7777/ws`，消息样例从 `websocket-messages.json` 或 [各功能域文档](../websocket/README.md) 里复制。ApiFox 不从文件导入 WebSocket 消息。

## 5 个变量

| 变量 | 本地默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:7777` | 后端的协议、主机和端口，不带末尾的斜杠。启用了 HTTPS 时改成 `https://` |
| `wsHost` | `ws://127.0.0.1:7777` | WebSocket 的地址，不带 `/ws`。后端是 https 时这里是 `wss://` |
| `gateToken` | 空 | 后端启动日志里入口地址 `/<入口串>` 的那一段。每次重启都变 |
| `username` | `operator` | 管理员账号 |
| `password` | 空 | 账号的密码 |

`projectId` 不是变量：它是当前项目的 ID，见下面「当前项目的 ID」。

## 先过三道门

每个请求依次过三道门，任何一道没过都到不了接口本身：

1. **入口 Cookie**。除了文档里标明不需要的操作，不带 `sentinel-gate` Cookie 的请求一律回 `404`，正文是纯文本 `Not Found`。打开入口地址 `{{baseUrl}}/{{gateToken}}` 会得到 `302` 到 `/` 并下发这个 Cookie，Postman 和 ApiFox 都会像浏览器一样记住它。
2. **登录**。首次使用先 `POST /api/auth/setup` 创建管理员账号，之后用 `POST /api/auth/login`。两者都下发 `sentinel-auth` Cookie。只记最后一次登录：别处登录后，原来的会话和 WebSocket 连接都失效。
3. **授权承诺**。账号第一次使用要 `POST /api/consent/accept`，请求体 `{"accepted": true}`。没接受之前，其余 `/api/*` 回 `403`，正文 `{"error":"consent_required"}`。

三个 Cookie 都是 `HttpOnly` 的，前端代码读不到，也不需要读。前端只要认两个错误值：`未登录`（回登录页）和 `consent_required`（显示授权承诺页）。其余错误的 `error` 是给操作员看的句子，原样显示，不要按内容匹配。

## 哪些功能走 HTTP

控制台的大部分功能走 WebSocket `/ws`：对话、项目、模型、权限、代理、漏洞、POC、工程、插件、设备等。走 HTTP 的是：

| 功能 | 入口 |
| --- | --- |
| 账号、授权承诺、界面语言 | `/api/auth/*`、`/api/consent*`、`/api/ui-language` |
| 对话附件上传、POC 包上传、文件夹下载 | `/api/upload`、`/api/pocs/import*`、`/api/folder-archives/{id}` |
| 报告中心 | `/api/reports*` |
| 资产批量导入和备注 | `/api/assets/*` |
| MITM 代理和 WebFuzz | `/api/mitm/*` |
| 威胁情报 | `/api/intelligence/*` |
| 安全检查 | `/api/security-checks/*` |
| 凭据 | `/api/credentials/*` |
| 工作链路 | `/api/work-processes/*` |

有的路由会顺带向所有 WebSocket 连接广播一条消息（比如导入资产后广播 `assets_changed`、项目改名后广播 `projects`），这样的路由在说明里写了是哪一个。前端收到广播后自己重新拉数据。

## 当前项目的 ID

很多路由带查询参数 `projectId`，而且必须是被选中的那个项目，项目在请求期间被切换会回 `409`。ID 从这两处拿：

- `GET /api/assets/import`：返回 `{ "id": "…", "name": "…" }`，就是当前项目；
- WebSocket 连接建立后推送的 `projects` 消息。

文档示例里的 `project-1`、`asset-1`、`tpl-1` 都是占位值。实际请求里的 ID、版本号（`revision`、`version`）都来自之前某个响应，文档里尖括号括起来的值（如 `<规则的 version>`）尤其如此。

## WebSocket

地址 `{{wsHost}}/ws`。握手和 HTTP 一样要带两个 Cookie：没有入口 Cookie 回 `404`，没有登录回 `401`，没接受授权承诺回 `403`。

- 一帧一条 JSON 对象，`type` 是消息名，其余字段平铺在同一层：`{"type": "get_stats"}`。
- 连接建立后服务端依次推送 11 种消息（`ui_config`、`snapshot`、`projects` 等），这是前端的初始状态。
- 服务端每 25 秒 ping 一次，90 秒收不到回应就断开。浏览器会自动回 pong。
- 关闭码 `4001`：原因是 `session_replaced`（别处登录了）或 `session_expired`（退出登录、修改密码或会话过期）。收到后回到登录页。

`websocket-messages.json` 的读法：

| 位置 | 内容 |
| --- | --- |
| `messages.client.<消息名>` | 浏览器发给服务端的 228 种。`example` 是样例，直接改了值就能发；`schema` 是它的结构；`replies` 是服务端只回给这条连接的消息，`broadcasts` 是发给所有连接的消息，`failures` 是处理失败时回的 `error` 文案 |
| `messages.server.<消息名>` | 服务端发给浏览器的 119 种。`sentWhen` 是什么情况下发出，`schema` 和 `example` 同上 |
| `$defs` | `schema` 引用的结构定义 |
| `domains` | 21 个功能域，每种消息属于哪一个，完整说明在哪个文档 |

例：发 `{"type":"get_stats"}`，服务端回一条 `{"type":"stats","stats":{…}}`，只回给发出消息的连接。

Postman 集合的最后一个分组里，每个功能域一条 WebSocket 请求，请求的说明里列了这个域全部上行消息的样例。Postman 不保存 WebSocket 消息，所以样例是放在说明里的，复制一条发出去。

## 示例是怎么来的

- **请求示例**是手写的，并且每一条都发给过真实的后端（`test/contract/http-replay.test.ts`）：后端回的状态码和响应结构都与文档一致。有 8 条没有发，因为它们会真的做事：
  `POST /api/models/remote`（访问模型服务商）、`POST /api/projects/egress-ip`（访问外网）、`POST /api/mitm/start`、`POST /api/mitm/stop`（操作容器）、`POST /api/mitm/webfuzz/send`（访问目标）、`POST /api/security-checks/sync`（访问 GitHub）、`POST /api/security-checks/submit`（启动工程）、`POST /api/ios/upload/{name}`（调用方是 iOS 设备，不是前端）。这 8 条的结构只按后端代码核对过，没有实际发过。
- **响应示例**分两种。登录、账号状态这类简单响应是手写的。列表和详情这类是按响应结构生成的：字段齐全、符合结构，但值是示意值（`示例名称`、`item-1` 这样），不是从哪个后端抓下来的。
- **错误示例**里的 `error` 是文档里那句话的意思，多数不是后端的逐字原文。

## 响应结构的两个细节

- 可以是 `null` 的字段，在 `http-api.json` 里写成 `"nullable": true`。字段本身是一个引用类型时（比如 `result` 指向 `ProjectEgressIp`），写成 `"anyOf": [{"$ref": …}, {"nullable": true}]`，意思是「是那个类型，或者是 `null`」。这是 OpenAPI 3.0 表达这件事的标准写法。
- 用 `openapi-typescript` 这类工具从 `http-api.json` 生成 TypeScript 类型时，请把生成结果里几个接口的响应和 `http-api.json` 里的示例对一遍，确认 `null` 那种写法被认成了 `| null`。不同工具对它的支持不一样。

## 重新生成

改了接口、类型或 `openapi.yaml` 之后：

```sh
# 响应结构（需要一个带 JavaScript API 的 TypeScript 5，仓库自带的 TypeScript 7 没有）
CONTRACT_TYPESCRIPT=/path/to/node_modules/typescript \
  npm --prefix packages/web run generate:contract-schemas
# 导入文件
npm --prefix packages/web run generate:contract-api
```

`npm run check` 会在这几个文件和来源不一致时报错。
