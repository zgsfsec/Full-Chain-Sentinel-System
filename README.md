# 全链哨兵 Full Chain Sentinel System

**简体中文** | [English](README.en.md) · **版本 2.3.0**

知攻善防实验室出品，基于 [pi](https://github.com/earendil-works/pi) 的授权渗透测试 Agent。通过中英文 Web 控制台，统一管理 Web、小程序与移动端测试、项目环境、审批和证据。

> **仅用于已获得书面授权的目标。** 自动执行模式可运行任意命令，使用者须自行承担操作后果。使用前请阅读[授权声明与安全边界](docs/security.md)。

[交流群](#community) · [快速开始](#quick-start) · [核心能力](#capabilities) · [常见问题 Q&A](#faq) · [文档导航](#documentation) · [许可](#license)

<a id="community"></a>

## 全链哨兵交流群

加入交流群请在打招呼内容中备注 **「全链哨兵」**。

<p>
  <img src="images/community-contact-1.png" width="260" alt="全链哨兵交流群入口一" />
  <img src="images/community-contact-2.png" width="260" alt="全链哨兵交流群入口二" />
</p>

[社区说明与致谢](docs/community.md)

---

<a id="quick-start"></a>

## 快速开始

### 1. 下载并启动

先安装并启动 Docker，再从 [Releases](https://github.com/zgsfsec/Full-Chain-Sentinel-System/releases) 选择与你的系统和架构匹配的压缩包。

Linux x64 示例：

```sh
tar -xzf sentinel-web-linux-x64.tar.gz
cd sentinel-web
chmod +x sentinel-web
./sentinel-web
```

Windows 解压 `sentinel-web-windows-x64.zip` 后，在 PowerShell 运行 `.\sentinel-web.exe`。请保留程序旁的 `replayd/` 目录。

### 2. 完成初始化

打开启动日志中的**完整入口地址**，设置账号密码并确认授权声明。在「设置 → 环境」准备工具镜像，在「设置 → 模型」添加端点并分配主模型，然后创建项目。

新项目包含工作容器与常驻网关，切换代理无需重建工作容器。

### 3. 开始测试

在对话中描述授权范围和目标，默认使用审批模式。移动端测试需先接入设备，再启用当前会话的对应工具。

[安装部署与启动参数](docs/deployment.md) · [源码运行](docs/deployment.md#section-3) · [使用指南](docs/usage.md) · [设备接入](docs/mobile.md)

---

<a id="capabilities"></a>

## 核心能力

以下截图来自当前 **v2.3.0 源码运行的完整控制台**，使用独立本地项目、真实后端与 Docker 容器。尚未配置模型、没有记录或未接入设备的页面按实际状态展示。[截图来源与更新方式](images/screenshots/README.md)。

### 1. 项目概览

汇总当前项目的运行任务、待审批项、漏洞与会话；从最近会话、运行状态和漏洞分布进入具体工作。

![项目概览](images/screenshots/dashboard.png)

### 2. 对话与持续目标

流式展示回复、思考与工具过程，支持会话分支、文件、终端和子代理。在输入区选择审批模式、预设 Agent、监督及设备工具；持续目标在自动执行或 AI 审批模式下续跑。

![对话工作台与工具入口](images/screenshots/chat.png)

### 3. 项目与代理

项目隔离工作目录、容器、会话与漏洞记录。新项目使用 Kali 工作容器和常驻网关；代理页管理 SOCKS5/HTTP、订阅、WireGuard 与 OpenVPN，运行中的项目可切换出口。

<details>
<summary>查看界面截图</summary>

![项目与容器管理](images/screenshots/projects.png)

![代理档案管理](images/screenshots/proxies.png)

</details>

### 4. 漏洞与资产库

在漏洞页筛选、复核严重程度、CVSS、状态与证据，导出 Markdown 报告；资产库按项目归并域名、IP、服务和 URL，维护标签、测试记录与关联漏洞。

<details>
<summary>查看界面截图</summary>

![漏洞筛选与复核](images/screenshots/vulnerabilities.png)

![资产库与测试记录](images/screenshots/assets.png)

</details>

### 5. MITM 中心

为当前项目启动 HTTP 显式代理、安装 HTTPS 解密证书，实时查看流量。按方法和状态筛选，检查请求与响应，并将选中的数据包发送到 WebFuzz。

<details>
<summary>查看界面截图</summary>

![实际代理流量记录](images/screenshots/mitm.png)

</details>

### 6. WebFuzz 发包工作台

多标签编辑原始 HTTP 请求，选择项目代理、直连或 MITM 路由，查看响应报文、正文和响应头，检索响应内容并回看历史。下图为真实请求本地文档服务得到的 200 响应。

![原始请求与真实响应](images/screenshots/webfuzz.png)

### 7. 业务建模

将目标业务与接口整理成 OpenAPI 3.0 文档，在项目内查看建模状态、目标、接口数与实体，打开详情或导出文档。

<details>
<summary>查看界面截图</summary>

![项目业务建模列表](images/screenshots/api-modeling.png)

</details>

### 8. POC 库与订阅

检索和引用 Nuclei 模板；在「设置 → POC 订阅」管理官方或自建订阅源、同步计划和更新记录。模板同步与执行测试是不同操作。

手动同步、同步官方和定时同步均使用同步开始时当前项目的代理网络，重试不会跟随切换后的其他项目。未选择项目或项目不使用代理时，走宿主机网络；项目代理不可用时记录同步失败，不自动直连。订阅与模板库仍全局共享。

<details>
<summary>查看界面截图</summary>

![POC 检索与筛选](images/screenshots/pocs.png)

![POC 订阅与同步](images/screenshots/poc-feeds.png)

</details>

### 9. 开源情报

批量添加 GitHub / GitHub Enterprise 仓库和分支，按固定间隔或 Cron 监控新提交。动态页集中处理安全更新、判定失败与检查异常，支持复现、重判、忽略与日志回溯；复现会准备漏洞版和修复版源码并新建工程。

<details>
<summary>查看界面截图</summary>

![开源情报的首次使用引导](images/screenshots/code-intel.png)

![真实的新增仓库监控表单](images/screenshots/code-intel-create.png)

</details>

### 10. 安卓与 iOS 设备

通过 DroidBridge 与 SentinelBridge 接入测试设备，管理反连凭据与连接状态，按会话启用 shell、文件、抓包、动态调试和应用分析工具。安卓需 root，iOS 需越狱；截图时没有接入设备。

<details>
<summary>查看界面截图</summary>

![安卓设备接入页](images/screenshots/android.png)

![iOS 设备接入页](images/screenshots/ios.png)

</details>

### 11. 工程与任务编排

粘贴授权目标清单、选择指挥思路，由指挥官组织多个测试任务，查看任务状态、进度和提交结果。工程模式适合批量工作，仍处于测试阶段。

<details>
<summary>查看界面截图</summary>

![新建工程与目标配置](images/screenshots/engagement-create.png)

</details>

### 12. 审批与审计

支持人工审批、自动执行与 AI 审批。审批页区分 AI 判定和自动审批流水，按项目、会话、来源、时间与关键词回溯；AI 判定失败或超时会放行，完整范围见安全边界。

<details>
<summary>查看界面截图</summary>

![审批与调用审计](images/screenshots/approvals.png)

</details>

### 13. 执行监督

对话可启用监督模型与介入策略。监督页汇总会话阶段、进展、停滞、循环、建议与 Token 使用，便于定位任务为何继续或停止；具体策略在设置中配置。

<details>
<summary>查看界面截图</summary>

![监督会话与执行状态](images/screenshots/supervision.png)

</details>

### 14. 模型与运行环境

模型库集中管理端点，将主模型、守门、漏洞评审、监督、指挥和监测六个角色分配给不同模型。环境页检查 Docker、镜像、挂载与目录权限，并管理镜像源、网络与默认代理。

<details>
<summary>查看界面截图</summary>

![模型库](images/screenshots/models.png)

![六个模型角色分配](images/screenshots/model-roles.png)

![真实 Docker 环境检查与网络设置](images/screenshots/environment.png)

</details>

### 15. 权限与预设 Agent

按 Agent 类型管理工具权限与插件访问范围；维护可复用的身份、背景和任务指令，在对话或编排任务中选择对应预设。

<details>
<summary>查看界面截图</summary>

![Agent 工具权限](images/screenshots/permissions.png)

![预设 Agent 管理](images/screenshots/presets.png)

</details>

### 16. 资产测绘与 Web 搜索

配置 FOFA、360 Quake、奇安信 Hunter 与 Tavily；管理密钥、验证状态、额度和查询记录。启用权限且凭据验证通过后，对应工具才会挂载给 Agent。

<details>
<summary>查看界面截图</summary>

![资产测绘平台配置](images/screenshots/asset-discovery.png)

![Tavily 号池与搜索配置](images/screenshots/web-search.png)

</details>

### 17. MCP 与插件中心

连接 HTTP、SSE 或 stdio MCP 服务器；管理本地和远端插件主机，安装官方插件或上传插件包。插件可提供独立前端，开发页提供完整规范。

<details>
<summary>查看界面截图</summary>

![MCP 服务器管理](images/screenshots/mcp.png)

![真实的官方插件目录](images/screenshots/official-plugins.png)

</details>

### 18. 团队通知

在「设置 → 通知」创建多个全局通知组，每组独立选择运行报告、高危漏洞、开源情报、持续目标、工程完成和 POC 同步失败等事件，可添加多个钉钉、飞书与企业微信群机器人，同类型不限一个。自动通知按类别发送到匹配的启用组；对话中手动开启通知时发送到所有启用组。组与机器人可独立启停、逐个测试，最近投递结果按组和机器人展示。现有配置会自动读取为默认通知组，保留原有渠道、类别与正文字数上限。

<details>
<summary>查看界面截图</summary>

![通知渠道与事件配置](images/screenshots/notifications.png)

</details>

### 19. 文件与证据留存

从对话页打开「文件」，上传、预览项目产物，或将目录打包下载。Agent 可用 `replay_capture` 将真实请求与响应保存为 PNG 证据，用 `replay_flows` 查询历史；取证截图经过审批链。

<details>
<summary>查看界面截图</summary>

![项目文件面板](images/screenshots/files.png)

</details>

### 20. 报告中心

跟随全局项目，统一归档普通会话、自主目标、工程任务和工程总报告。Agent 完成实质测试任务时主动提交 Markdown 报告与证据图片，普通问答不生成报告；工程总报告归档成功后再结束工程。

支持搜索、来源筛选、Markdown 渲染与源文查看、图片放大、下载和删除。点击「编辑」后，左侧修改标题与 Markdown，右侧实时预览，支持保存、取消、草稿恢复和修改冲突提示。已有图片独立保存，容器停止、重建或删除后仍可查看；含图片的报告下载为包含正文与图片的 ZIP，无图片时下载 Markdown。

编辑器保留已有归档图片，暂不上传新图片。完整提交方式、图片限制与数据清理规则见[报告中心使用说明](docs/report-center.md)。

配置条件、操作步骤与限制见[功能详解](docs/features.md)、[使用指南](docs/usage.md)与[安全边界](docs/security.md)。

---

<a id="faq"></a>

## 常见问题 Q&A

使用中的常见问题与解答集中维护在独立页面：[查看常见问题 Q&A](docs/faq.md)。

<a id="documentation"></a>

## 文档导航

| 我想了解 | 文档 |
| --- | --- |
| 安装、HTTPS、启动参数、常驻运行 | [安装部署](docs/deployment.md) |
| 完整功能与配置条件 | [功能详解](docs/features.md) |
| 创建项目、Web / 小程序、工程、审批与 POC | [使用指南](docs/usage.md) |
| HTTP 代理、HTTPS 证书与流量查询 | [MITM 中心](docs/mitm-center.md) |
| 原始 HTTP 手动发包与响应检查 | [WebFuzz](docs/webfuzz.md) |
| 安卓与 iOS 设备接入 | [移动端指南](docs/mobile.md) |
| 代理切换、网关与旧项目迁移 | [项目网关](packages/web/docs/project-gateway.md) |
| 资产上报、关联漏洞与导出 | [资产库](docs/asset-library.md) |
| 报告提交、图片归档、实时编辑与下载 | [报告中心](docs/report-center.md) |
| 安装本地 / 远端插件 | [插件中心](docs/plugin-center.md) |
| 开发插件与插件前端 | [插件开发](docs/plugin-authoring.md) · [插件前端](docs/plugin-ui.md) |
| 仓库结构、构建与测试 | [开发指南](docs/development.md) |
| 授权、审批范围与数据边界 | [授权声明与安全边界](docs/security.md) |

<a id="license"></a>

## 上游与许可

本项目是 [pi](https://github.com/earendil-works/pi) 的衍生作品（fork），**不是上游官方项目**，与上游团队无关。

上游代码以 MIT 许可发布，版权归 Mario Zechner，许可全文见 [LICENSE](LICENSE)；本仓库保留该许可与版权声明，并在此基础上加入渗透测试相关的系统提示、Web 控制台、容器化作业环境与安卓设备插件。

- 上游仓库：https://github.com/earendil-works/pi
- 本项目新增部分的版权归本项目作者，同样以 MIT 发布。
- 例外：[packages/coding-agent/examples/extensions/doom-overlay/doom/](packages/coding-agent/examples/extensions/doom-overlay/doom/) 是 GPLv2 的 DOOM 编译产物及其对应源码，不属于 MIT，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## Star History

<a href="https://www.star-history.com/?repos=zgsfsec%2Ffull-chain-sentinel-system&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=zgsfsec/full-chain-sentinel-system&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=zgsfsec/full-chain-sentinel-system&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=zgsfsec/full-chain-sentinel-system&type=date&legend=top-left" />
 </picture>
</a>
