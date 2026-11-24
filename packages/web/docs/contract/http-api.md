# HTTP 接口里 OpenAPI 表达不了的部分

每条路由的参数、请求体、状态码和说明在 [openapi.yaml](openapi.yaml)。响应和请求体的精确结构由后端的 TypeScript 类型生成，`openapi.yaml` 里写 `x-schema` 的地方就是指过去的；合在一起、带示例、可以导入 ApiFox 或 Postman 的那一份是 [frontend/http-api.json](frontend/http-api.json)（见 [frontend/README.md](frontend/README.md)）。这里写的是横跨所有路由的规则：请求要过哪几道门、Cookie 怎么工作、静态文件怎么返回、请求体有多大上限。

WebSocket `/ws` 的消息见 [websocket/README.md](websocket/README.md)。连接和消息的通用约定见上一级的 [README](README.md)。

## 每个请求依次经过的三道门

任何一道没过，请求到不了路由本身。

| 顺序 | 检查什么 | 没过时的响应 |
| --- | --- | --- |
| 1 | 入口 Cookie `sentinel-gate` | `404`，`Content-Type` 是 `text/plain; charset=utf-8`，正文是 `Not Found\n` |
| 2 | 会话 Cookie `sentinel-auth` | `/api/*` 回 `401`，正文 `{"error":"未登录"}` |
| 3 | 账号是否接受了授权承诺 | `/api/*` 回 `403`，正文 `{"error":"consent_required"}` |

### 第一道：入口串

后端每次启动生成一个随机的入口串，启动日志里打印入口地址 `/<入口串>`。

| 请求 | 响应 |
| --- | --- |
| `GET /<入口串>`，也接受末尾多一个 `/` | `302`，`Location: /`，`Set-Cookie: sentinel-gate=<值>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` |
| 任何其它请求，不带入口 Cookie | `404`，纯文本 |

Cookie 的值是入口串的 HMAC-SHA256，不是入口串本身。服务端不为它保存任何状态：持有这个 Cookie 就等于打开过入口地址。入口串每次启动都变，所以重启之后旧地址和旧 Cookie 都失效。

`SameSite` 用 `Lax` 而不是 `Strict`，因为操作员通常从聊天窗口或日志里打开入口地址，随后的跳转是一次跨站导航，`Strict` 的 Cookie 在那次导航里不会被带上。

这道门**不是**鉴权。它只决定一个陌生人能不能发现有控制台在这里；能不能用由密码决定。

### 第二道：会话

一个管理员账号。首次使用时创建，之后再创建回 `409`。

| 请求 | Cookie 的变化 |
| --- | --- |
| `POST /api/auth/setup`、`POST /api/auth/login`（`remember` 不是 `false`）、`POST /api/auth/change-password` | 下发 `sentinel-auth=<令牌>; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000` |
| `POST /api/auth/login`，`remember` 为 `false` | 下发 `sentinel-auth=<令牌>; Path=/; HttpOnly; SameSite=Strict`，没有 `Max-Age`，浏览器关闭后失效 |
| `POST /api/auth/logout` | `Set-Cookie: sentinel-auth=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` |

令牌是 `<过期时间毫秒>.<HMAC>`。服务端不保存会话，靠轮换签名密钥让旧令牌失效：

- **登录**：每次登录成功都换一把签名密钥，所以只有最后一次登录有效。其它浏览器的令牌立刻失效，它们的 WebSocket 连接以关闭码 `4001`、原因 `session_replaced` 关闭。
- **退出登录、修改密码**：同样换密钥，并把签发时间的下限设为此刻。所有连接以关闭码 `4001`、原因 `session_expired` 关闭。
- 同一个来源地址连续 5 次登录失败后锁定 30 秒，期间回 `429`。

### 第三道：授权承诺

承诺记录在服务端，带着账号名和声明文字的哈希。换了账号，或声明文字改了，承诺作废，要重新接受。

### 各路由经过哪几道门

| 路由 | 入口 Cookie | 会话 Cookie | 授权承诺 |
| --- | --- | --- | --- |
| `/` 和前端静态资源 | 要 | 不要 | 不要 |
| `/api/auth/state`、`setup`、`login`、`logout` | 要 | 不要 | 不要 |
| `/api/ui-language` | 要 | 不要 | 不要 |
| `/api/auth/session`、`/api/consent`、`/api/consent/accept` | 要 | 要 | **不要**（否则没法接受承诺） |
| 其余 `/api/*`、`/plugin-icon/*` | 要 | 要 | 要 |
| `/plugin-ui/*` | 不要 | 不要 | 不要，改用路径里的临时令牌 |
| `/assets/swagger-ui-*` | 不要 | 不要 | 不要 |
| `/api/intelligence/v1/ingest`、`/api/ios/upload/*` | 不要 | 不要 | 不要，调用方不是浏览器，用各自的令牌 |

## 静态文件

前端是一个单页应用，构建产物在后端的 `webui/dist`（打包成单个可执行文件时内嵌在文件里）。

| 请求路径 | 响应 |
| --- | --- |
| 文件存在 | `200`，按扩展名给 `Content-Type` |
| 文件不存在，或路径里有 `..` 想跳出目录 | `200`，返回 `index.html`，让前端自己路由 |
| 连 `index.html` 都没有（前端还没构建） | `200`，一页说明如何构建的 HTML |

| 扩展名 | `Content-Type` |
| --- | --- |
| `.html` | `text/html; charset=utf-8`，另带 `Cache-Control: no-cache`，每次都要重新验证，重新构建前端后不用强刷 |
| `.js` | `text/javascript; charset=utf-8` |
| `.css` | `text/css; charset=utf-8` |
| `.svg` | `image/svg+xml` |
| `.png` | `image/png` |
| `.ico` | `image/x-icon` |
| `.json` | `application/json; charset=utf-8` |
| `.woff2` | `font/woff2` |
| 其它 | `application/octet-stream` |

除了 `.html`，其它文件不带 `Cache-Control`。前端构建给它们的名字带哈希。

路径先按 URL 规则规范化（`posix.normalize`），再去掉开头的 `..`，最后确认结果仍在目录内。

## 没有匹配到路由时

| 情况 | 响应 |
| --- | --- |
| 路径不是 `/api/` 开头 | 当作前端的路由，返回 `index.html` |
| 已登录，路径以 `/api/` 开头但没有任何路由处理它 | 同上，返回 `index.html`。**不是 `404`** |
| 对一条 API 路由用了它不处理的请求方法 | 多数情况下同上，返回 `200` 的 HTML。只有 [openapi.yaml](openapi.yaml) 里列出了 `405` 的路由会明确拒绝，并带 `Allow` 头 |

所以新后端判断一条请求是不是 API 调用，不能靠「返回了 JSON」：前端自己也会请求 `/settings` 这样的路径并期待拿回 `index.html`。

## 请求体

| 上限 | 路由 | 超出时 |
| --- | --- | --- |
| 64 KiB | 登录相关的路由、`/api/ui-language` | 当作无效请求，回 `400` |
| 1 KiB | `POST /api/code-monitors/project` | 回 `400` |
| 4 KiB | `POST /api/work-processes/control` | 回 `413` |
| 16 KiB | `POST /api/models/remote` | 回 `413` |
| 16 KiB | `/api/mitm/*` 的 POST，下面两条除外 | 回 `413` |
| 128 KiB | `POST /api/assets/remarks` | 当作无效请求，回 `400` |
| 400 KiB | `/api/reports/templates*` 的写操作 | 回 `413` |
| 1 MiB | `/api/assets/import`、`/api/assets/import/preview` | 回 `400` |
| 1 MiB | `/api/intelligence/*`，含数据源推送 | 回 `413` |
| 2 MiB | `/api/security-checks/*` 的 POST | 回 `413` |
| 3 MiB | `/api/credentials/*` 的 POST | 回 `413` |
| 4 MiB | `POST /api/mitm/webfuzz/send` | 回 `413` |
| 6 MiB + 4 KiB | `PUT /api/reports/{id}` | 回 `413` |
| 16 MiB | `POST /api/mitm/webfuzz/workspace` | 回 `413` |
| 512 MiB | `POST /api/pocs/import` | 回 `413` |
| 1 GiB | `POST /api/upload` | 回 `413` |

规则：

- JSON 路由要求请求头 `Content-Type` 以 `application/json` 开头，否则回 `415`。个别路由只检查请求体本身。
- JSON 解析失败回 `400`。
- `POST /api/upload` 和 `POST /api/pocs/import` 的请求体是文件的原始字节，不是 multipart。
- 读取请求体的过程中会再检查一次登录状态：请求体还没收完时登录可能已经失效。

## 流式下载

这些路由不返回 JSON，把文件直接写进响应：

| 路由 | 内容 |
| --- | --- |
| `GET /api/folder-archives/{id}` | `application/gzip`，带 `Content-Disposition` 和 `Content-Length` |
| `GET /api/reports/{id}/download` | `application/zip`（默认）或 `text/markdown; charset=utf-8`（`format=md`），带 `Content-Disposition`，文件名支持 UTF-8 |
| `GET /api/reports/{id}/images/{image}` | 图片本身 |
| `GET /api/mitm/flows/{flowId}/{part}` | 原始报文，`application/octet-stream` |
| `GET /api/mitm/ca.pem`、`GET /api/mitm/ca.crt` | 证书，`application/octet-stream`，附件下载 |
| `GET /api/gate-audit/export` | CSV |

## 响应的共性

- JSON 响应的 `Content-Type` 是 `application/json; charset=utf-8`。
- 错误的正文统一是 `{"error": "…"}`。`error` 是给操作员看的完整句子，前端原样显示。
- 多数错误文案按当前界面语言生成，少数路由固定为中文或英文。
- 报告、凭据、工作链路、情报、MITM、远端模型列表和代码情报项目开关这些路由的响应带 `Cache-Control: no-store`。

## 跨站请求的防线

Cookie 是 `HttpOnly` 的，`SameSite` 是 `Strict`（会话）或 `Lax`（入口），浏览器不会在跨站请求里带上它们。凭据和安全检查两组路由另外检查请求头 `Origin` 的主机部分必须和 `Host` 一致，否则拒绝。
