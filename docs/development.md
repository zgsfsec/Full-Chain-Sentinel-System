# 开发指南

[返回首页](../README.md) · [English](development.en.md)

**本页导航**

- [目录结构](#section-1)
- [开发](#section-2)

---

<a id="section-1"></a>

## 目录结构

本仓库沿用上游 pi monorepo 的分包结构（包名仍是上游的 `@earendil-works/*`，改名单独进行）：

| 包 | 说明 |
| --- | --- |
| [packages/web](../packages/web) | 全链哨兵 Web 控制台：HTTP + WebSocket 服务与前端 |
| [packages/coding-agent](../packages/coding-agent) | Agent CLI 与运行时 |
| [packages/agent](../packages/agent) | 工具调用与状态管理 |
| [packages/ai](../packages/ai) | 多 provider LLM API |
| [packages/tui](../packages/tui) | 终端 UI 库 |
| [packages/durable](../packages/durable) | 会话、任务与文档运行时 |
| [packages/mcp](../packages/mcp) · [packages/protocol](../packages/protocol) | MCP 与协议层 |
| [packages/droid-apk](../packages/droid-apk) | 安卓 DroidBridge APK（Kotlin） |
| [packages/web/ios](../packages/web/ios) | iOS SentinelBridge deb（Swift）与 Sileo 源 |
| [MITM_Fuzz_Render](../MITM_Fuzz_Render) | 容器内发包重放与渲染截图服务（`replayd`，Go 单二进制） |
| [docker](../docker) | 作业容器镜像（Kali + 工具链） |

<a id="section-2"></a>

## 开发

以下命令均从仓库根目录执行，单测命令除外。

```bash
./test.sh                   # 全部非 e2e 测试
npm run check               # biome + 依赖/导入/入口图检查 + tsc + webui + 浏览器冒烟
npm run build               # 全量构建，使用版本库内的模型快照
npm run build:offline       # 全量构建，不联网、不重生成模型目录
```

本仓库不跑 CI（只保留发布流程）：提交前请自己跑 `npm run check` 和 `./test.sh`。

单测从包根目录跑：

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/<name>.test.ts
```

`packages/ai/src/providers/data/` 是 `generate-models` 的产物，已固定在版本库里：模型 id 的类型联合体直接由它推导，固定它之后 `tsc` 和测试不会随厂商轮换模型而漂移（全新克隆也能离线做类型检查）。普通 `npm run build`、Web 二进制构建及 `build:offline` 都使用已提交快照，不再自动刷新此目录。要更新目录时显式跑 `npm run generate:models`（需联网），检查模型变更和相关测试后提交——刷新会改到 `.manifest.json` 的 `generatedAt` 时间戳，属正常。独立的 release/local-release 脚本仍显式刷新模型。

作业容器（镜像里带 Chromium 与中文字体，供发包截图使用）：

```bash
docker build -t sentinel:latest docker/
```

发包服务（`replayd`）：控制台首次在项目容器里用到它时会自动下发，二进制从仓库检出（`MITM_Fuzz_Render/dist/replayd_linux_{amd64,arm64}`）或发布包同级的 `replayd/` 目录读取，也可以用 `SENTINEL_REPLAYD_DIR` 指定。本地没构建过就先跑一次：

```bash
cd MITM_Fuzz_Render && make dist   # 产出 dist/replayd_linux_{amd64,arm64}
```

基础镜像与 apt/pip/npm/go 软件源可在控制台「设置 → 环境」配置，也可以在命令行用 `--build-arg` 覆盖。
