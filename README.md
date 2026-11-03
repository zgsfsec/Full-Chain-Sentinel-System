# 全链哨兵 Full Chain Sentinel System

**简体中文** | [English](README.en.md) · **版本 2.2.12**

知攻善防实验室出品，基于 [pi](https://github.com/earendil-works/pi) 的授权渗透测试 Agent。通过中英文 Web 控制台，统一管理 Web、小程序与移动端测试、项目环境、审批和证据。

> **仅用于已获得书面授权的目标。** 自动执行模式可运行任意命令，使用者须自行承担操作后果。使用前请阅读[授权声明与安全边界](docs/security.md)。

[交流群](#community) · [快速开始](#quick-start) · [核心能力](#capabilities) · [文档导航](#documentation) · [许可](#license)

<a id="community"></a>

## 全链哨兵交流群

加入交流群请在打招呼内容中备注 **「全链哨兵」**。

<p>
  <img src="images/Pasted%20image%2020261017125335.png" width="260" alt="全链哨兵交流群入口一" />
  <img src="images/Pasted%20image%2020261017125351.png" width="260" alt="全链哨兵交流群入口二" />
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

打开启动日志中的**完整入口地址**，设置账号密码并确认授权声明。在「设置 → 环境」准备工具镜像，在「模型设置」填写 Base URL、API Key 和模型 ID，然后创建项目。

新项目包含工作容器与常驻网关，切换代理无需重建工作容器。

### 3. 开始测试

在对话中描述授权范围和目标，默认使用审批模式。移动端测试需先接入设备，再启用当前会话的对应工具。

[安装部署与启动参数](docs/deployment.md) · [源码运行](docs/deployment.md#section-3) · [使用指南](docs/usage.md) · [设备接入](docs/mobile.md)

---

<a id="capabilities"></a>

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 对话与工程 | 流式对话、会话分叉、工具过程、子代理与批量任务编排 |
| 项目与网络 | Kali 工作容器、常驻网关、SOCKS5/HTTP、订阅、WireGuard、OpenVPN 与出口热切换 |
| 审批与审计 | 人工审批、自动执行、AI 审批，调用流水与会话记录 |
| 资产与漏洞 | 资产库、漏洞中枢、CVSS、证据留存与 Markdown 报告 |
| 建模与 POC | OpenAPI 业务建模、Nuclei POC 订阅、检索与引用 |
| 移动端 | 安卓 DroidBridge 与 iOS SentinelBridge，设备反连、抓包与动态分析 |
| 情报与插件 | FOFA、Quake、Hunter、Tavily、MCP 与本地 / 远端插件主机 |
| 发包与取证 | 请求重放、历史查询、截图留证与文件打包下载 |

配置条件、工具范围与限制见[功能详解](docs/features.md)。

<details>
<summary>查看控制台示例</summary>

![项目与对话界面](images/Pasted%20image%2020261017124047.png)

更多操作截图见[使用指南](docs/usage.md)。截图仅供流程参考，以当前版本界面为准。

</details>

---

<a id="documentation"></a>

## 文档导航

| 我想了解 | 文档 |
| --- | --- |
| 安装、HTTPS、启动参数、常驻运行 | [安装部署](docs/deployment.md) |
| 完整功能与配置条件 | [功能详解](docs/features.md) |
| 创建项目、Web / 小程序、工程、审批与 POC | [使用指南](docs/usage.md) |
| 安卓与 iOS 设备接入 | [移动端指南](docs/mobile.md) |
| 代理切换、网关与旧项目迁移 | [项目网关](packages/web/docs/project-gateway.md) |
| 资产上报、关联漏洞与导出 | [资产库](docs/asset-library.md) |
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
