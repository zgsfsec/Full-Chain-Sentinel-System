# 威胁反制：设备接入指南

入口：**情报 → 威胁反制**。先选择项目，在“数据源”中新建 WAF、防火墙或态势感知数据源，复制仅显示一次的 Token。每个数据源使用独立 Token，所属项目由 Token 确定。设备负责将告警转换为下述 JSON。

## 请求格式

`POST /api/intelligence/v1/ingest`

```http
Authorization: Bearer <数据源 Token>
Content-Type: application/json
```

此机器接口不要求控制台登录 Cookie 或隐藏入口地址。Token 仅允许向所属数据源写入，不能查询、清理或修改规则。管理接口仍要求控制台登录及授权声明。通过 HTTPS 接入，Token 轮换或数据源停用后旧凭据立即失效。

```json
{
  "schema_version": 1,
  "request_id": "waf-upload-0001",
  "events": [
    {
      "event_id": "waf-alert-0001",
      "indicator": { "type": "ip", "value": "1.1.1.1" },
      "occurred_at": "2026-11-11T10:00:00+08:00",
      "category": "web_attack",
      "severity": "high",
      "evidence": { "rule": "SQL injection", "action": "blocked", "count": 12 }
    }
  ]
}
```

字段均必填。未定义的扩展字段放入 `evidence`，不得传入 `project_id`、数据源或工程配置。

| 字段 | 约束 |
| --- | --- |
| `schema_version` | 整数 `1` |
| `request_id` | 数据源内唯一，1–200 字符，不能全为空白 |
| `events` | 每批 1–1000 条，同批 `event_id` 不重复 |
| `event_id` | 数据源内唯一，1–200 字符，不能全为空白 |
| `indicator.type` | 固定为 `ip` |
| `indicator.value` | 单个 IPv4 / IPv6；不接受域名、URL、CIDR 或带接口标识的 IPv6 |
| `occurred_at` | 合法 ISO 8601 日历时间，包含秒及 `Z` 或 `±HH:MM`；小数秒最多三位 |
| `category` | 设备定义的告警类别，1–200 字符 |
| `severity` | `info` / `low` / `medium` / `high` / `critical` |
| `evidence` | JSON 对象；序列化后最多 16000 字符，嵌套最多 20 层 |

[JSON Schema](threat-intelligence.schema.json) 可用于设备侧基础校验。服务端另外执行整批 ID、日历时间、证据大小和嵌套深度校验。IP 统一规范化；IPv4 映射 IPv6 与原 IPv4 合并。时间存为 UTC，字符串字段去除首尾空白。

正文最多 **1 MiB**，读取最长 15 秒。每个数据源每 60 秒最多 **60 次**请求，同时最多 **4 个**推送；所有数据源同时最多 **16 个**推送。限流在服务进程内计算，重启重置。

## 回执、幂等与重试

成功返回 HTTP 200：

```json
{ "requestId": "waf-upload-0001", "accepted": 1, "duplicates": 0, "newIps": 1 }
```

`accepted` 为本次新增告警数；`duplicates` 为已保存的重复告警数；`newIps` 为首次创建的项目 IP 汇总数。收到回执表示数据已保存，工程状态单独查询。

- 网络超时或连接中断：保留原 JSON 和 `request_id` 重试。相同请求 ID、相同规范化内容返回原回执，所以回执中的 `accepted` 不是每次实际新插入数。
- 相同 `event_id`、相同内容再次上报不增加告警或阈值计数。
- 同一请求或事件 ID 对应不同内容：HTTP 409，整批回滚。修正内容时使用新的请求 ID；既有事件不可覆盖，需要新建事件。
- 任一记录无效：整批拒绝，无有效告警被部分写入。错误包含出错位置和原因。
- HTTP 429：读取 `Retry-After: 60`，退避后以原请求重试；HTTP 5xx 可采用指数退避。HTTP 400/401/409/413/415 先修正格式、凭据或批量大小。

| 状态 | 含义 |
| --- | --- |
| 200 | 已保存或幂等重放 |
| 400 | 字段、JSON 或整批校验失败 |
| 401 | Token 无效、已轮换或数据源停用 |
| 405 | 请求方法错误 |
| 409 | 请求 ID / 事件 ID 内容冲突 |
| 413 | 超过 1 MiB |
| 415 | Content-Type 不是 application/json |
| 429 | 请求速率或同时推送数超限 |
| 500 / 503 | 服务异常 / 服务未就绪 |

## 设备侧示例

将请求保存为 `alerts.json`，Token 通过环境变量传入：

```sh
curl --fail-with-body "$SENTINEL_URL/api/intelligence/v1/ingest" \
  -H "Authorization: Bearer $SENTINEL_INTEL_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @alerts.json
```

Python 标准库示例；失败时保留文件及原 ID，由设备侧任务重试：

```python
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

request = Request(
    os.environ["SENTINEL_URL"].rstrip("/") + "/api/intelligence/v1/ingest",
    data=Path("alerts.json").read_bytes(),
    headers={
        "Authorization": "Bearer " + os.environ["SENTINEL_INTEL_TOKEN"],
        "Content-Type": "application/json",
    },
    method="POST",
)
try:
    with urlopen(request, timeout=30) as response:
        print(response.read().decode())
except HTTPError as error:
    print(error.code, error.read().decode(), error.headers.get("Retry-After"))
    raise
```

## 自动工程与指挥思路

在“自动分析”中直接选择“工程 → 指挥思路”里的配置，默认使用内置“威胁 IP 分析”。指挥思路共用同一个列表，在工程页创建和管理。默认自动分析关闭，阈值 20、每批最多 50 个 IP、同时 1 批、冷却 1440 分钟，Token 上限留空（不限）。阈值与批大小范围 1–200，批大小不小于阈值，并行批次 1–8，冷却 0–525600 分钟。

候选必须同时满足：项目内 IP 去重、有未覆盖的新告警、冷却已过、没有被其他批次占用。达到阈值后按最早未覆盖告警选取，批次冻结 IP、告警接收序号、模板和策略。冷却从选入批次时开始。暂停批次仍占并发容量，其他项目独立调度，继续服从现有全局 worker 上限。

每批使用一个分析 Agent，使用指挥官模型（默认跟随主模型）。创建批次时读取关联指挥思路的最新内容并冻结，修改不影响已有批次及手动重试；删除被引用的指挥思路会停止创建新批次，需重新选择后保存。查询步骤、预算和执行上限保存在项目策略中。首版能力：

- WHOIS 使用 RDAP 注册服务，ASN 使用 RIPEstat。
- 资产测绘复用“设置 → 资产测绘”中的 FOFA / Quake / Hunter Key 与 BaseURL，仅查询精确 IP 的已收录结果。
- 查询由控制台主机发起，沿用平台自定义 BaseURL，不经过项目容器代理。资产平台未启用或缺少 Key 时明确跳过；已配置平台查询失败会阻塞完成。
- 非公网单播 IP 保留告警，外部情报查询记录为不适用。
- 每 IP 每平台只取第一页，返回数 1–100（默认 20）；Hunter 请求页大小向上取其允许值，最终返回数仍受配置限制。
- 单批查询预算 1–2000（默认 500），一次 RDAP、ASN 或单平台搜索各计一次。最多每公网 IP 五次逻辑查询；失败也消耗预算，平台重试最多两次，实际 HTTP 请求或平台费用可能更多。
- 成功查询缓存和预算持久保存，暂停及重启不会重置。手动重试创建新执行尝试与新预算，继续使用原模板和 IP 快照。

Agent 只能调用批次 IP 情报与目标进度工具。报告包含逐 IP 摘要、跨 IP 关联、来源、时间、局限和防御建议。网络持有组织或地理位置不能直接证明攻击者身份。

为控制上下文大小，批次每 IP 保存最近 10 条未覆盖告警样本，每条证据最多 2000 字符；Agent 初始输入每 IP 最近 3 条、证据最多 512 字符。查询工具每条结果最多 8000 字符。原始告警可在 IP 详情查看，完整标准化查询结果保存在工程查询库；报告应说明采样限制。

只有全部 IP 查询覆盖完成、分析任务成功、非空报告归档成功，整批才标记已处理。成功只覆盖该批接收序号以内的告警，处理中新增告警继续等待冷却与下轮阈值。

失败或中止不会自动重试：到“处理批次”手动重试，或放弃原快照。放弃仅解除原快照占用；需有新事件才再次入池。预算耗尽时，重试会重置预算但保留原预算上限；应为后续批次调整模板与批大小。服务重启后的工程暂停，须手动恢复。

## 保留与清理

原始告警不自动过期。“清理数据”支持数据源及**接收时间**范围，先预览数量再删除；有关联未结束或待重试批次时需先处理批次。

按条件清理保留批次快照、工程和报告；清空项目情报删除告警、IP 汇总与批次记录，保留数据源、策略及幂等摘要。工程指挥思路、已建工程、报告、专用分析会话与工程查询证据独立保留，清空告警不等于删除这些副本。重放旧事件不会恢复已删除告警，应使用新事件 ID 上报新告警。删除项目时清除其情报数据及凭据。

实现架构与扩展入口见 [设计说明](threat-analysis-plan.md)。
