# 功能详解

[返回首页](../README.md) · [English](features.en.md)

**本页导航**

- [方法论驱动的渗透流程](#section-1)
- [中英文 Web 控制台](#section-2)
- [三档执行模式](#section-3)
- [容器化作业环境](#section-4)
- [自定义代理](#section-5)
- [漏洞中枢](#section-6)
- [文件夹打包下载](#section-7)
- [资产库](#section-8)
- [业务建模与 POC 库](#section-9)
- [安卓设备插件](#section-10)
- [iOS 设备插件](#section-11)
- [开源漏洞监测](#section-19)
- [资产测绘平台插件](#section-12)
- [Web 搜索插件](#section-13)
- [自定义 MCP 插件](#section-14)
- [社区插件中心](#section-15)
- [发包重放与界面截图插件](#section-16)
- [OpenAI 兼容端点](#section-17)
- [会话即审计](#section-18)

---

<a id="section-1"></a>

## 方法论驱动的渗透流程

侦察 → 枚举 → 漏洞映射 → 验证 → 利用 → 后渗透 → 报告，系统提示强调授权范围、证据留痕与最小侵入。

<a id="section-2"></a>

## 中英文 Web 控制台

（[packages/web](../packages/web/README.md)）：默认中文，可在侧栏、登录页与授权承诺页切换英文；服务端提示、错误和报告同步英文化。流式对话与思考过程、工具执行卡片、会话树、文件与子代理弹窗、项目选择。

<a id="section-3"></a>

## 三档执行模式

审批模式（默认，每条 bash 命令可编辑后放行或拒绝）、自动执行、AI 审批（守门模型逐条判定 `ALLOW` / `BLOCK`，判定失败或超时一律放行）。审批链覆盖 bash、安卓 shell 命令（`droid_shell`）与 iOS shell（`ios_shell`）；frida、抓包、APK 分析与文件面板直接调用容器，不过审批门。

<a id="section-4"></a>

## 容器化作业环境

新项目由 Kali 工作容器和常驻网关容器组成。直连、SOCKS5/HTTP、订阅、WireGuard 与 OpenVPN 共用该网关；切换出口不重建容器，保留工作容器中的安装包、文件和后台进程，已有网络连接可能中断。详见 [项目网关](../packages/web/docs/project-gateway.md)。

<a id="section-5"></a>

## 自定义代理

在侧栏「代理」管理命名档案，新建项目或项目设置中选择档案，也可为项目固定订阅中的某个节点。

- 支持 SOCKS5/HTTP、订阅、WireGuard 与 OpenVPN。订阅接受 base64 分享链接、Clash YAML 和 sing-box JSON，保存时拉取并缓存节点；启动容器不拉取订阅。
- 订阅支持定时更新、按自定义 URL 真实访问测速、运行时切换节点和每 3 分钟自检的「自动择优」。普通代理与隧道档案也支持独立连通性测试，结果显示耗时或失败原因。
- OpenVPN 支持内联证书的 `.ovpn`、单独账号密码与服务器推送的 DNS。测试或运行多个项目共用隧道证书、密钥时，连接可能短暂中断。
- 代理保存、档案修改、订阅刷新和默认代理更改会应用到运行中的网关，停止的项目在下次启动时应用。节点凭据仅挂载到网关；内网与回环默认直连。
- 新网关使用隔离网桥，容器监听端口不会自动发布，访问宿主机使用 `host.docker.internal`。旧项目须显式重建才迁移，先备份工作容器可写层。默认代理与 sing-box 镜像在「设置 → 环境」配置。

网络、DNS 和迁移限制见 [项目网关](../packages/web/docs/project-gateway.md)。

<a id="section-6"></a>

## 漏洞中枢

`vuln_submit` 提交已验证漏洞，必填 CVSS 分数，原始数据包逐字保存，操作员复核留时间线，可按项目导出 Markdown 报告。

<a id="section-7"></a>

## 文件夹打包下载

对话「文件」面板的当前目录与每个目录行都能「下载」，后台用容器 `tar` 打包成 `.tar.gz`，进度与取消走 WebSocket，完成后经带登录态的 HTTP 路由流式下载；不跟随符号链接、包含隐藏文件、不设大小上限，临时包在下载完成或 10 分钟后删除。

<a id="section-8"></a>

## 资产库

Agent 用 `asset_report` / `asset_note` 主动上报实际接触过的域名、IP、IP:端口服务与 URL，同一资产按项目自动合并，测试结论按时间线累积；控制台可筛选、改状态与标签、加记录、批量删除与导出 Markdown；漏洞提交时可选关联资产，资产与漏洞详情可互相跳转。

<a id="section-9"></a>

## 业务建模与 POC 库

把目标站点还原成 OpenAPI 3.0 文档；Nuclei POC 订阅、检索与引用。

<a id="section-10"></a>

## 安卓设备插件

root 测试机安装自研 DroidBridge APK 主动反连，提供 shell、文件上下行、截屏、logcat、tcpdump 抓包、frida 动态调试与 APK 静态分析。

<a id="section-11"></a>

## iOS 设备插件

rootless/rootful 越狱设备安装 `SentinelBridge` deb 后反连，本地控制页填 wss 地址和 token；提供 shell、文件拉取/推送、应用清单、HTTP 日志、抓包、frida、砸壳与 IPA 拉取。

<a id="section-12"></a>

## 资产测绘平台插件

（设置 → 资产测绘）：接入 **FOFA**、**360 Quake**、**奇安信 Hunter**，Agent 用 `fofa_search` / `quake_search` / `hunter_search` 三个工具按各平台自己的查询语法测绘公网资产（域名、IP、端口、标题、服务、指纹），原始响应落到项目 `evidence/asset/`，每次查询记一条流水。三家都支持**自定义 BaseURL**（可填反向代理前缀，留空使用官方地址；控制台自动拼接 API 路径，保存后按新地址重新验证，失败则不挂载）。**只有「已启用 + 已配置密钥 + 验证通过」的平台才会挂载工具**，没配置或密钥不可用时 Agent 根本看不到该工具；查询由控制台进程直接发起，密钥不进容器、不进 bash 审计，也不进守门模型判定。

<a id="section-13"></a>

## Web 搜索插件

（设置 → Web 搜索）：接入 **Tavily**，Agent 用 `web_search`（公网搜索）与 `web_extract`（页面正文抓取）做目标情报收集（泄露文档、公开报告、技术文章）。支持多 Key 号池，控制台按各 Key 剩余额度自动轮换，额度耗尽自动切换；查询流水入 `websearch.db`，原始响应落项目 `evidence/search/`。只有「权限 → Web 搜索」开关打开且号池里有已验证的 Key 时才会挂载工具；密钥明文存本机 `websearch.json`（0600），不进容器、不进 bash 审计。

<a id="section-14"></a>

## 自定义 MCP 插件

（设置 → MCP）：在控制台里增删改查 MCP 服务器（`http`、`sse` 或 `stdio`）并逐个测试连接，工具以 `mcp__<服务器>__<工具>` 挂给 Agent，仍受「权限 → MCP」总开关约束，且该开关下可逐个服务器放开或关掉。配置由哨兵自己拥有（`mcp-servers.json`，0600），**不读 pi 原生的 `mcp.json`**，所以列表里没有的服务器 Agent 看不到。**stdio 服务器在控制台宿主机上直接执行**（不在容器内、不过 bash 审批），必须逐条勾选风险确认才能保存。

<a id="section-15"></a>

## 社区插件中心

（设置 → 插件）：插件以 Docker 镜像交付，可以跑在本机，也可以跑在用户自己的 VPS 上。控制台主动出站连接插件主机，所以本地部署没有公网 IP 也能用，不需要反向隧道。每个插件就是一个 MCP server，工具沿用 `mcp__<插件>__<工具>` 命名，受「权限 → MCP」总开关约束。安装时展示 manifest 声明的网络模式与 capabilities，`host` 网络和 `privileged` 必须单独确认；工具调用不逐条拦截，只写审计，插件页可一键停用。插件包是一个 zip（根目录或一层子目录里有 `plugin.json`、Dockerfile 与构建上下文），在「设置 → 插件」上传后由插件主机本地构建并运行，不需要镜像仓库；`source` 必须公开。详见 [docs/plugin-center.md](plugin-center.md) 与 [docs/plugin-authoring.md](plugin-authoring.md)。插件还可以自带前端（`ui.entry`）：在插件抽屉点「打开界面」，控制台以 `sandbox="allow-scripts"` 的 iframe 全屏加载镜像里的 `/ui/`，通过 postMessage 桥调用该插件自己的工具、读产物、读写配置与插件级 storage；iframe 是 opaque origin，读不到控制台 Cookie 与 DOM。见 [docs/plugin-ui.md](plugin-ui.md)。

<a id="section-16"></a>

## 发包重放与界面截图插件

（控制台会话默认挂载，无开关）：每个项目容器里常驻一个 `replayd`（[MITM_Fuzz_Render](../MITM_Fuzz_Render) 的 Go 单二进制，控制台首次使用时下发并校验 sha256）。工具只有两个，且只为**报告留证**服务：`replay_capture` 把一次请求 + 响应 + 北京时间取证面板整窗截成 PNG（可指定要高亮的文本片段，并要求模型在 `purpose` 里写明这张图证明什么，该说明会出现在审批卡与审计里），`replay_flows` 回查抓包历史。**日常发包不给专用工具**：Agent 用 bash 里的 curl 发即可，反正同一条审批链，少一个工具；代价是 curl 无法字节保真（畸形 `Content-Length`、手工 chunked、精确 header 顺序），需要那种保真度时走 bash 的 `nc`/python。截图走审批链（人工放行时可先改包），查历史不过门。**不给 Agent 渲染任意 URL 的能力**：replayd 本身有 `POST /api/render`（无头浏览器渲染任意页面），但那是通用抓取工具，不属于数据包工具，只留给操作员在自己的界面里用。数据落在项目目录 `.sentinel/replayd/`（SQLite 历史 + 内容寻址产物），容器重建不丢。

<a id="section-17"></a>

## OpenAI 兼容端点

支持 vLLM、one-api、new-api 等自建端点，界面直接配置。

<a id="section-18"></a>

## 会话即审计

复用 pi 的 JSONL 会话树，命令、输出与模型决策完整留痕。

<a id="section-19"></a>

## 开源漏洞监测

（项目内「情报 → 开源情报」）。输入 GitHub 或 GitHub Enterprise 仓库地址，可一次粘贴多行、批量新增；每个仓库默认监控 `main`，获取分支后也可以逐个改成其他分支。系统以各分支当前 HEAD 为基线，此后定时用 GitHub REST API 拉取新提交。

- **监控策略**：每个监控可以按固定间隔（10 分钟到 24 小时，或仅手动）检查，也可以填 5 字段 Cron 表达式（分 时 日 月 周，按服务器本地时区执行），保存前预览接下来三次触发时间。列表勾选多个仓库后点「批量策略」可一次改掉它们的检查策略。Cron 编辑器提供常用策略下拉和按字段的复选表格（分钟 / 小时 / 日 / 月 / 周），也可以直接编辑表达式。
- **项目动态**：开源情报页新增「动态」子标签，按当前项目聚合待复现、判定失败、下发失败、判定中和检查异常；支持筛选、分页以及批量复现/重判/忽略，不再需要逐个监控点开。自动复现成功的提交默认不进入待办，「全部」筛选仍可永久回溯。
- **跨页全选**：监控列表分页后，工具栏的「全选所有」会选中当前项目全部监控（不只是当前页），随后可对全部执行批量策略、批量检查或批量删除。
- **批量删除**：勾选多个监控后可以一次删除；提交记录、检查日志、队列任务和本机保存的令牌一起清理，工程不受影响。
- **批量检查**：监控列表支持勾选多个仓库，点「检查所选」一次性拉取所有选中仓库的新提交；单个仓库也可单独点「检查」。
- **检查队列**：检查请求先进入持久化队列，全局最多 3 个并发、同一 GitHub 主机最多 2 个；失败按 30 秒 / 2 分钟 / 5 分钟退避重试，最多 3 次。服务重启后，排队中的任务继续执行，执行中的任务重新排队。
- **批量导入队列**：一次粘贴多个仓库时由服务端按 1.2 秒间隔逐个创建，导入进度显示成功/失败数，错误聚合展示，不再一次性打出几百个请求；分支探测同样串行，每 500ms 一个，避免页面卡死和触发 429。队列在服务端运行，浏览器刷新后仍会继续并重新显示进度。仓库默认 `main` 不存在时会自动回退到仓库真实的默认分支。
- **分页**：监控列表、提交列表和导入时的仓库列表都分页渲染，避免几百行同时挂到页面上造成卡顿。
- **GitHub 限流保护**：GitHub REST 请求按主机串行并留出间隔（有令牌 500ms，无令牌 1.5s）；收到 429/abuse 时读取 `Retry-After`，整台主机至少冷却 5 分钟后再执行队列中的任务。无令牌时每次最多消费 5 个提交，降低突发请求。建议配置访问令牌（5000 次/小时）。
- **检查日志**：每次检查记录触发方式（手动 / 定时 / 批量）、结果、耗时、消费的提交数、命中的安全更新数和错误信息；服务重启时中断的检查会标记为失败，便于回溯。详情页的「队列」页签显示任务的排队、运行、重试和完成状态。
- **判定**：每个新提交把 message、变更文件与 diff 交给「设置 → 模型 → 监测模型」判断是否为安全修复。纯依赖升级、合并提交和空 diff 直接跳过；diff 超过长度上限时保留文件清单和能放下的部分。
- **发现**：判定为安全更新的提交进入列表，按 CVE/GHSA 或补丁标题去重，可推送钉钉、飞书或企业微信通知。每次发现默认进入待确认，也可以在监控上打开「自动下发复现」。
- **复现**：确认后控制台先在项目容器里准备源码——令牌只通过 stdin 传给 git，不落盘、不放进 clone URL、也不进模型上下文；辅助脚本完成检出后即删除。随后按发现新建一个工程，拿到漏洞版本（父提交）与修复版本两个目录；工程按「开源 1day 复现」思路执行，要求写出 PoC/exp、在漏洞版本上触发、在修复版本上验证不再触发。构建失败（缺依赖、需要特殊环境）按任务失败处理，不伪造成功。
- **令牌**：GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token；Repository access 选目标仓库，Repository permissions → Contents 设为 Read-only（Metadata 自动只读），生成后复制 `github_pat_` 开头的令牌。GitHub Enterprise 路径相同，把 github.com 换成实例地址；也可用带 `repo` 权限的 classic token。
- **限制**：只支持 GitHub 系 API（github.com 与 GitHub Enterprise，可改 API Base URL），暂不支持 GitLab/Gitea；SSH 形式的地址会用于识别仓库，但拉取仍走 HTTPS API/克隆，私有仓库需要 Contents 读权限的令牌。令牌只存控制台本机（`code-monitor-secrets.json`，0600）。
