# 控制台截图来源

[中文首页](../../README.md) · [English README](../../README.en.md)

本目录存放当前控制台的真实浏览器截图，供首页与使用、部署、移动端指南共用。

- 截图日期：2026-11-06（Asia/Shanghai）。
- 控制台版本：2.3.0；源码基准：`c5a9b37c87eac3576e73c82b78a9cd4fe803536d`，采用当前黑白界面与统一表格样式。
- `setup.png` 在 `af211ff` 重新截取，展示浅色登录与初始化布局；该图片的源码基准单独记录在清单对应条目的 `sourceCommit` 中。
- 前端：仓库 `packages/web/webui` 的完整 Vite 应用，入口为 `src/main.tsx`；没有单独拼装组件、替换组件、修改 DOM 或拦截并伪造 API。
- 后端：`node packages/web/src/index.ts --host 127.0.0.1 --port 17777 --no-gate --no-tls`，配置目录与项目目录通过 `SENTINEL_CODING_AGENT_DIR`、`SENTINEL_PROJECTS_DIR` 指向独立临时目录。主系统原有数据未用于截图。
- 前端监听本机 `14187`，通过临时 Vite 配置将 `/api`、`/ws` 代理到 `17777`。这是源码开发服务，没有修改仓库运行配置或重新生成内嵌资源；原有 `7777` 服务未用于截图。
- 浏览器：Playwright 驱动本机 Google Chrome；大部分视口为 1600 × 1000、设备缩放 1，监控配置表单使用 1600 × 1400 展示全部字段，授权页使用整页截图。
- 项目：通过控制台创建的「README 本地演示」，真实 Kali 工作容器与网关均成功启动，Docker 环境检查通过。

## 数据与画面

- 没有配置模型 API，也没有生成虚构对话、漏洞、资产、建模结果、审批流水、工程结果或设备连接。空列表和未配置提示就是截图时的真实状态。
- `mitm.png` 展示通过真实项目代理请求本机文档服务 `http://host.docker.internal:18787/security.md` 得到的 HTTP 200 记录。未修改状态码或结果。
- `webfuzz.png` 是通过项目网络向同一本机文档服务发送 `GET /security.md` 后的真实 200 响应。响应文本按原样展示，未执行响应脚本。
- `code-intel.png` 展示独立环境的首次使用引导，`code-intel-create.png` 展示填写本项目公开仓库地址后的真实表单；未创建后台监控、触发模型判定或伪造安全更新。
- DroidBridge、Sileo 和 SentinelBridge 的设备安装图及交流群图片属于独立的安装／联系资料；它们不属于本次更新的 34 张 Web 控制台截图。
- 中英文 README 共用这组中文控制台截图，功能说明与图片替代文本分别提供中英文。

## 图片索引

| 文件 | 控制台入口 | 尺寸 |
| --- | --- | --- |
| [android.png](android.png) | 资产与工具 → 安卓设备 | 1600 × 1000 |
| [api-modeling.png](api-modeling.png) | 资产与工具 → 业务建模 | 1600 × 1000 |
| [approvals.png](approvals.png) | 执行与审计 → 审批 | 1600 × 1000 |
| [asset-discovery.png](asset-discovery.png) | 设置 → 资产测绘 | 1600 × 1000 |
| [assets.png](assets.png) | 资产与工具 → 资产库 | 1600 × 1000 |
| [chat.png](chat.png) | 工作台 → 对话 | 1600 × 1000 |
| [code-intel-create.png](code-intel-create.png) | 情报 → 开源情报 → 新增监控 | 1600 × 1400 |
| [code-intel.png](code-intel.png) | 情报 → 开源情报 | 1600 × 1000 |
| [consent.png](consent.png) | 首次访问 → 授权与风险承诺 | 1600 × 1000 |
| [dashboard.png](dashboard.png) | 工作台 → 项目概览 | 1600 × 1000 |
| [engagement-create.png](engagement-create.png) | 执行与审计 → 工程 → 新建工程 | 1600 × 1000 |
| [environment.png](environment.png) | 设置 → 环境 | 1600 × 1000 |
| [files.png](files.png) | 对话 → 文件 | 1600 × 1000 |
| [ios.png](ios.png) | 资产与工具 → iOS 设备 | 1600 × 1000 |
| [mcp.png](mcp.png) | 设置 → MCP | 1600 × 1000 |
| [mitm.png](mitm.png) | 资产与工具 → MITM 中心 | 1600 × 1000 |
| [model-roles.png](model-roles.png) | 设置 → 模型 → 角色分配 | 1600 × 1000 |
| [models.png](models.png) | 设置 → 模型 → 模型库 | 1600 × 1000 |
| [notifications.png](notifications.png) | 设置 → 通知 | 1600 × 1000 |
| [official-plugins.png](official-plugins.png) | 设置 → 插件 → 官方插件 | 1600 × 1000 |
| [permissions.png](permissions.png) | 设置 → 权限 | 1600 × 1000 |
| [plugin-development.png](plugin-development.png) | 设置 → 插件 → 开发文档 | 1600 × 1000 |
| [plugins.png](plugins.png) | 设置 → 插件 → 已安装 | 1600 × 1000 |
| [poc-feeds.png](poc-feeds.png) | 设置 → POC 订阅 | 1600 × 1000 |
| [pocs.png](pocs.png) | 资产与工具 → POC 库 | 1600 × 1000 |
| [presets.png](presets.png) | 设置 → 预设 Agent | 1600 × 1000 |
| [project-create.png](project-create.png) | 项目 → 新建项目 | 1600 × 1000 |
| [projects.png](projects.png) | 工作台 → 项目 | 1600 × 1000 |
| [proxies.png](proxies.png) | 系统 → 代理 | 1600 × 1000 |
| [setup.png](setup.png) | 首次访问 → 创建管理员账号 | 1600 × 1000 |
| [supervision.png](supervision.png) | 执行与审计 → 监督 | 1600 × 1000 |
| [vulnerabilities.png](vulnerabilities.png) | 资产与工具 → 漏洞 | 1600 × 1000 |
| [web-search.png](web-search.png) | 设置 → Web 搜索 | 1600 × 1000 |
| [webfuzz.png](webfuzz.png) | 资产与工具 → WebFuzz | 1600 × 1000 |

## 后续更新

1. 使用当前源码启动完整控制台，配置独立数据目录；保留真实登录、授权、项目与 Docker 路径。
2. 从对应导航进入页面，等待后端加载完成和字体就绪再截图；表单通过页面按钮打开。
3. 涉及请求或抓包的画面必须来自实际请求；无法连接的设备或未完成的模型任务按真实状态展示。
4. 直接覆盖对应的可读文件名，同时更新本页版本、日期、尺寸及 [manifest.json](manifest.json) 中的 SHA-256。
5. 检查中英文 README 和相关指南的所有图片能够加载，并检查功能介绍与当前页面一致。
