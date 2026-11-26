# 验收

验收回答一个问题：新后端接上现有前端之后，行为是否和契约一致。前端一行不改。

分三层，从自动到人工：

| 层 | 做什么 | 能发现什么 |
| --- | --- | --- |
| 1. 自动验收套件 | 一组测试直接对后端跑，只走 HTTP 和 WebSocket | 三道门、登录、连接、错误、语言、会话失效这些约定的逐条偏差 |
| 2. 记录代理 | 架在前端和后端之间，记下每一帧 | 协议之外的消息；文档里没有的 HTTP 路径；哪些消息和路径这次没有走到 |
| 3. 人工走查 | 人用浏览器把每个页面操作一遍 | 需要模型和 Docker 才能出现的流程，以及页面上看得出的差异 |

三层都通过才算验收通过。

## 1. 自动验收套件

测试文件是 `packages/web/test/contract/acceptance.test.ts`。它不 import 后端的任何代码来驱动功能，只像浏览器一样发 HTTP 请求和 WebSocket 消息。

### 对现有后端跑（回归）

不需要任何设置：

```sh
cd packages/web
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/contract/acceptance.test.ts
```

测试会在进程内启动真实的后端：临时配置目录、入口串、登录和授权承诺全部打开，用一个假的 `docker` 顶替容器后端。

### 对新后端跑（验收）

新后端先按它自己的方式启动好。然后用环境变量告诉测试它在哪：

```sh
cd packages/web
export SENTINEL_CONTRACT_URL="https://10.0.0.5:7770/AbCdEfGhIjKl"
export SENTINEL_CONTRACT_USERNAME=operator
export SENTINEL_CONTRACT_PASSWORD='the-password'
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/contract/acceptance.test.ts
```

| 变量 | 必填 | 含义 |
| --- | --- | --- |
| `SENTINEL_CONTRACT_URL` | 是 | 后端的入口地址（启动日志里打印的那一条）。入口串关掉时填 `https://主机:端口` |
| `SENTINEL_CONTRACT_USERNAME`、`SENTINEL_CONTRACT_PASSWORD` | 后端已有账号时是 | 用来登录。后端还没有账号时，测试用它们创建 |
| `SENTINEL_CONTRACT_ACCEPT_CONSENT=1` | 否 | 允许测试替这个账号接受首次使用的授权承诺。不设时，如果承诺还没接受，需要登录的用例会被跳过 |
| `SENTINEL_CONTRACT_DESTRUCTIVE=1` | 否 | 允许测试退出登录、重复登录和修改密码。不设时这三个用例会被跳过 |

说明：

- 后端用自签证书提供 HTTPS 也可以，测试不校验证书。
- 不设后两个变量时，测试不改动后端的任何配置，除了界面语言：语言切换的用例结束时会把语言改回原值。
- 设了 `SENTINEL_CONTRACT_DESTRUCTIVE=1`，测试会退出登录、重复登录、修改密码，并发送 11 种修改配置的消息。用例结束时账号密码会被改成「原密码加 `-next`」。

### 测试检查什么

按执行顺序：

| 用例 | 对应契约 |
| --- | --- |
| 不带入口 Cookie 时，`/`、`/api/*`、静态资源和 WebSocket 握手一律是纯文本 `404` | 入口串 |
| 打开入口地址：`302` 到 `/`，下发 `sentinel-gate`，属性是 `Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` | 入口串 |
| `/` 返回页面；`/api/auth/state` 返回账号状态 | HTTP 接口 |
| 没有会话 Cookie：`/api/*` 回 `401`，WebSocket 握手回 `401` | 会话 Cookie |
| 首次使用创建账号，第二次创建回 `409`；或者用已有账号登录，错误密码回 `401`。Cookie 属性与「记住登录」的关系 | 会话 Cookie |
| `/api/auth/session` 的结构 | HTTP 接口 |
| 接受授权承诺之前：`/api/*` 回 `403` 且正文是 `consent_required`，WebSocket 握手回 `403`，声明可读，未勾选的接受回 `400`；接受之后放行 | 授权承诺 |
| 新连接先收到 `ui_config`、`snapshot`，随后是 `projects`、`engines`、`doctrines` 和五个设置页的配置 | 连接建立后的推送 |
| 未知消息和不是 JSON 的帧各回一条 `error`，文案正确 | 出错 |
| 一个控制台切换语言，所有控制台都收到 `ui_config`，之后服务端的文案换成新语言 | 界面语言 |
| 36 种只读消息：把文档里的样例发过去，收到的回复是文档里列出的消息类型之一 | 各功能域文档 |
| 11 种修改配置的消息（保存模型、权限、通知、预设、指挥思路、监督和守门配置、构建源、容器网络、MCP 服务器）：同上。只对测试自己启动的后端执行，或者设了 `SENTINEL_CONTRACT_DESTRUCTIVE=1` 时 | 各功能域文档 |
| 退出登录：所有连接以 `4001`、`session_expired` 关闭 | 关闭码 |
| 再次登录：旧连接以 `4001`、`session_replaced` 关闭 | 关闭码 |
| 修改密码：所有连接以 `4001`、`session_expired` 关闭，旧密码失效 | 关闭码 |

只读消息那一项用的是各功能域文档里的 JSON 样例，所以文档、样例和后端三者被同一项检查串起来。修改配置的那一项同理，它留下的配置会写进后端的配置目录。

### 测试不检查什么

需要模型端点和 Docker 容器才会发生的流程不在自动套件里：发消息、Agent 执行、审批、子代理、工程任务。这些靠第 2 层和第 3 层。

要先选中一个对话才能发送的消息（例如开关凭证、开关报告中心）也不在自动套件里，因为测试用的后端还没有任何对话。

## 2. 记录代理

`packages/web/scripts/contract-proxy.mjs` 是一个反向代理。浏览器访问代理，代理把请求转给后端，同时记下经过的每一个 WebSocket 消息和 HTTP 请求。

```sh
cd packages/web
node scripts/contract-proxy.mjs --target "https://10.0.0.5:7770/AbCdEfGhIjKl" \
  --listen 127.0.0.1:7788 --record frames.jsonl --report report.json --insecure
```

| 参数 | 含义 |
| --- | --- |
| `--target` | 后端的地址。带入口串时代理会提示改用哪个地址打开 |
| `--listen` | 代理监听的地址，默认 `127.0.0.1:7788` |
| `--record` | 把每个 WebSocket 消息按行写成 JSON |
| `--report` | 退出时写出报告 |
| `--insecure` | 接受不受信任的证书 |
| `--seconds` | 到时间自动停止，等同于按 Ctrl+C |

用法：启动代理，用浏览器打开代理提示的地址，像平常一样操作前端。结束时按 Ctrl+C，代理打印摘要并写出报告。自动验收套件也可以指向代理（把 `SENTINEL_CONTRACT_URL` 设成代理的地址），这样一次运行既做检查又留下记录。

报告里有四份名单：

| 名单 | 含义 | 出现条目意味着 |
| --- | --- | --- |
| 协议之外的消息 | 方向和 `type` 不在契约里的帧，包括不是 JSON 的帧 | 后端发出了或前端发出了契约里没有的消息。先看是不是前端发了服务端没实现的消息（已知有 `ios_token_delete`） |
| 文档没有的 HTTP 路径 | 请求的路径和 `openapi.yaml` 里的任何一条都对不上 | 后端或前端用了一个没写进契约的路由 |
| 没有出现的消息 | 这次操作里没有经过的消息类型 | 不代表有问题，说明这次没走到那个功能。把各个页面都点一遍，名单会变短 |
| 没有请求到的路径 | 同上，针对 HTTP 路由 | 同上 |

退出码：出现协议之外的消息或文档没有的路径时退出码是 1，适合放进脚本。

## 3. 人工走查

用浏览器对着新后端，把下表每一行操作一遍。每行的「应看到」只是最低要求，细节以对应的功能域文档为准。需要模型和 Docker 的行已标注。

| 功能 | 操作 | 应看到 | 文档 |
| --- | --- | --- | --- |
| 入口与登录 | 打开入口地址，登录 | 跳回控制台；密码错误有提示 | [http-api.md](http-api.md) |
| 界面语言 | 切到英文，再切回中文 | 服务端的提示和错误文案跟着换 | [connection.md](websocket/connection.md) |
| 发送消息（需要模型和 Docker） | 发一句话，中途点中止 | 流式输出思考、正文和工具调用；中止后状态回到空闲 | [session.md](websocket/session.md) |
| 审批（需要模型和 Docker） | 审批模式下触发一条命令；批准、改写后批准、拒绝各试一次 | 弹出审批；`decide` 后命令执行或被拒绝 | [session.md](websocket/session.md) |
| 会话管理 | 新建、切换、重命名、标状态、删除会话；打开分支树并分叉 | 列表和状态实时更新 | [session.md](websocket/session.md) |
| 子代理（需要模型和 Docker） | 触发一次派发，查看过程，中止一个 | 过程按轮次展示，可中止、可追加指令 | [subagents.md](websocket/subagents.md) |
| 模型 | 增、改、复制、删一条模型；换各角色；测试连接；拉取远端模型列表 | 角色解析结果随之变化；被角色使用的模型删不掉 | [models.md](websocket/models.md) |
| 守门 | 改守门配置；测试判定；打开守门审计 | 改完立即生效；审计页逐条显示 | [gatekeeper.md](websocket/gatekeeper.md) |
| 权限、预设、通知、指挥思路 | 各保存一次；发一条测试通知 | 保存后重建会话；通知结果回显 | [permissions-presets.md](websocket/permissions-presets.md) |
| 环境 | 复检；改构建源和容器网络；构建镜像后中止 | 检查项逐条更新；构建日志滚动 | [environment.md](websocket/environment.md) |
| 代理 | 新建、编辑、删除档案；切换节点；测试连通 | 运行中的项目可以切节点 | [proxy.md](websocket/proxy.md) |
| 项目（需要 Docker） | 新建、启动、停止、重建、切换、删除项目 | 容器状态与列表一致 | [projects.md](websocket/projects.md) |
| 文件与终端 | 浏览、预览、编辑、上传、下载文件；打包下载文件夹；打开终端并输入命令 | 文件面板和终端实时更新 | [files-terminal.md](websocket/files-terminal.md) |
| 漏洞与资产 | （需要模型和 Docker）提交后复核、改级、标误报、导出；资产改状态和标签 | 时间线记录每次改动；导出可下载 | [vulns.md](websocket/vulns.md)、[assets.md](websocket/assets.md) |
| 资产测绘与搜索 | 保存平台和密钥，测试连接，测试搜索密钥 | 密钥不回显；验证结果立即生效 | [discovery.md](websocket/discovery.md) |
| POC | 导入模板；新增订阅源并同步；同步官方 POC | 进度和结果回显 | [pocs.md](websocket/pocs.md) |
| 业务建模（需要模型和 Docker） | 开始建模；查看记录的接口文档、业务实体、API 源码映射、业务逻辑模型和时间线；导出 OpenAPI 和完整记录；标记已结束、删除；在工程里把「做业务建模」写进任务指令派发 | 没有提交内容的这一轮不留下记录；没有权限校验的接口被标出；执行 Agent、子代理和指挥官都能用 `api_model_read`，子代理和指挥官不能提交 | [modeling.md](websocket/modeling.md) |
| 设备 | 安卓和 iOS 页各操作令牌与监听地址 | 状态实时更新 | [devices.md](websocket/devices.md) |
| 凭证、报告开关、MCP | 启用并验证凭证；开关报告；增删改 MCP 服务器并测试连接 | 验证结果逐条显示 | [credentials-mcp.md](websocket/credentials-mcp.md) |
| 代码情报 | 新建监控、立即检查、查看判定与日志 | 列表和判定结果实时更新 | [code-intel.md](websocket/code-intel.md) |
| 工程模式（需要模型和 Docker） | 新建工程，暂停、继续、中止；打开任务会话；取总报告 | 看板、任务事件和报告正常 | [engine.md](websocket/engine.md) |
| 插件 | 添加插件主机，安装、启停、配置插件，打开插件界面 | 插件列表、日志和界面正常 | [plugins.md](websocket/plugins.md) |
| 监督（需要模型和 Docker） | 开启监督，观察悬浮窗，停止 | 状态、片段和建议实时出现 | [supervisor.md](websocket/supervisor.md) |

## 已知缺口

iOS 设备页删除令牌时，前端发的 `ios_token_delete` 当前后端没有实现，会提示「未知消息类型」。这是现有后端的缺口，不是新后端的偏差。见 [devices.md](websocket/devices.md)。
