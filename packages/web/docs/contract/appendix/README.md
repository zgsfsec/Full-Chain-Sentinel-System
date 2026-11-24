# 附录

新后端多半不是 TypeScript 写的，没法直接引用服务端源码里的常量。这里把浏览器和服务端必须一致的常量，以及服务端会发给浏览器的全部文案，导出成 JSON。

两个文件都是脚本从源码生成的，不要手改。改了源码之后重新生成：

```sh
npm --prefix packages/web run generate:contract
```

`npm run check` 会检查它们有没有过期。

## `messages.json`：文案表

| 字段 | 含义 |
| --- | --- |
| `defaultLanguage` | 默认界面语言，`zh` |
| `messages` | 键是中文原文，值是英文 |

服务端发给浏览器的文案都经过这张表。规则：

1. 当前界面语言是 `zh` 时，直接发中文原文。
2. 当前界面语言是 `en` 时，用中文原文作键查表，发查到的英文。
3. 表里没有这个键，发中文原文。
4. 文案里的花括号是占位符，发送前用实际值替换。例如 `尝试次数过多，请 {seconds} 秒后再试`。

当前语言由上行消息 `set_ui_language` 设置，是全局的，所有控制台共用。

新后端要带上这张表，并把每条服务端文案写成和键完全一致的中文原文。少一个字（包括标点）都会让英文界面退回中文。仓库里的检查要求各功能域文档列出的失败文案必须是这张表里的键。

## `constants.json`：常量表

| 字段 | 内容 | 浏览器用在哪里 |
| --- | --- | --- |
| `ui.languages`、`ui.default` | 界面语言的取值和默认值 | `set_ui_language`、`ui_config` |
| `credentials.groups` | 凭证的分组，顺序即显示顺序 | 凭证页 |
| `credentials.types` | 凭证类型，每项有 `value` 和所属的 `group` | 凭证页，以及 `/api/credentials` 的请求 |
| `codeIntel.vulnTags` | 代码情报的漏洞标签，每项有 `id`、中文名 `zh`、英文名 `en` 和适用的检查类别 `categories` | 代码情报页 |
| `codeIntel.maxHistoryCommits` | 一次历史扫描最多处理的提交数。服务端校验 `scan_code_history` 的 `commitLimit` 不超过它 | 代码情报页的输入上限 |
| `codeIntel.defaultCronExpression` | 新建监控的默认 Cron 表达式 | 代码情报页 |
| `models.remoteModelApis` | 添加模型时可选的接口协议。服务端拒绝不在这个列表里的 `api` | 模型页，`POST /api/models/remote` 的 `api` |
| `assets.importMaxCharacters` | 资产批量导入的文本长度上限。超限时服务端拒绝 | 资产库导入对话框，`/api/assets/import` |

## 前端自带、不需要后端提供的部分

浏览器还直接用了后端源码里的几个函数：Cron 表达式的校验和下次执行时间、WebFuzz 请求的目标解析、代码复现结果的解析、凭证的失败判定、安全检查的分类。这些函数被打进了前端包，在前端本地运行，后端不需要实现，也不在协议里出现。

没有列在这里的枚举（角色名、模式、状态等）都写在消息的类型里，见各功能域文档。
