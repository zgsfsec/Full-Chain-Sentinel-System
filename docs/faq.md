# 常见问题 Q&A

[返回 README](../README.md#faq)

问答内容待补充。

<!--
新增问答时可参考以下格式，并删除上方“问答内容待补充。”：

## Q：问题描述

A：解答内容。
-->

## 安装环境 docker 部署失败问题

中国大陆地区，关闭代理服务器再选择中国镜像源进行部署，或者直连部署（需要解决网络问题）

## 忘记用户密码怎么办

运行以下命令

```bash
mv ~/.sentinel/agent/auth.json ~/.sentinel/agent/auth.json.bak
```

然后重启即可重置密码。

## 安卓APP怎么下载？

所有的发型版本全在Releases，安卓 apk 也在。

## opencode 使用问题

OpenCode Go 的请求格式和会话请求头有特殊要求，使用时需要自行部署反向代理。可使用仓库提供的 [OpenCode Go 反代脚本](../scripts/opencode_proxy.py)，脚本会补充 `x-opencode-session` 请求头，并转发流式响应。

在仓库根目录运行：

```bash
python3 -m venv .venv-opencode
.venv-opencode/bin/python -m pip install aiohttp
export OPENCODE_API_KEY="你的 OpenCode Go API Key"
.venv-opencode/bin/python scripts/opencode_proxy.py
```

脚本默认监听 `127.0.0.1:12581`，上游为 `https://opencode.ai/zen/go`。在全链哨兵的“设置 → 模型”中，将 Base URL 填为 `http://127.0.0.1:12581/v1`，API Key 填写 OpenCode Go 的密钥，模型 ID 填写对应的模型名称。

如果全链哨兵运行在 Docker 中，启动脚本时加上 `--host 0.0.0.0`，并将 Base URL 中的 `127.0.0.1` 替换为容器可访问的宿主机地址；Docker Desktop 可使用 `host.docker.internal`。

## 阿里百炼模型使用问题

因为 阿里百炼 特殊的接口（不符合主流接口兼容），请再设置-模型-模型能力中“支持思考 / 推理“关闭即可（这个不影响使用）。

## Github打不开、下载过慢

中国大陆需要自行解决网络卡顿问题，具体可以问 AI 或者百度一下。

## 如何开发插件？

设置-插件-开发文档 然后复制给  codex ，提需求即可。

## 守门模型问题

因为所有的 Plan 套餐，全都有 RPM 速率限制和排队等待机制（简单来讲就是你问一个问题，大概率需要几十秒 AI 才可以回答），没法做到实时的回复，所以请用按量付费模型，比如：DeepSeek 官方、千问 API 按量付费官方。

## 监督模型问题

因为所有的 Plan 套餐，全都有 RPM 速率限制和排队等待机制（简单来讲就是你问一个问题，大概率需要几十秒 AI 才可以回答），没法做到实时的回复，所以请用按量付费模型，比如：DeepSeek 官方、千问 API 按量付费官方。


## 关于Skill相关问题

全链哨兵抛弃了 Skill 的设计，因为 98% 的人的 Skill 并不是 Skill，而是一段超长上下文提示词，对渗透测试而言没有任何意义，转而替代的是预设 Agent，你可以查看预设 Agent 相关内容，自己自定义上下文提示词。

如果你对于 Skill 的认知是知识库，那么预设 Agent 对你毫无作用，你的知识库对渗透测试而言也毫无作用。

如果你对于 Skill 的认知是任务+目标，那么你完全可以使用预设 Agent，这对你来说是一个非常好的选择，我们也支持这么做。
