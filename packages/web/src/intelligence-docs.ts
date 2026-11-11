export const INTELLIGENCE_EXAMPLE = {
	schema_version: 1,
	request_id: "waf-20261111-0001",
	events: [
		{
			event_id: "waf-alert-0001",
			indicator: { type: "ip", value: "1.1.1.1" },
			occurred_at: "2026-11-11T10:00:00+08:00",
			category: "web_attack",
			severity: "high",
			evidence: { rule: "SQL injection", count: 12 },
		},
	],
};

export const INTELLIGENCE_API_GUIDE = `POST /api/intelligence/v1/ingest
Authorization: Bearer <数据源 Token>
Content-Type: application/json

${JSON.stringify(INTELLIGENCE_EXAMPLE, null, 2)}

每批 1–1000 条，正文最大 1 MiB，evidence 最大 16000 字符、嵌套不超过 20 层。
每数据源每 60 秒最多 60 次请求，同时最多 4 个推送；全局同时最多 16 个。429 返回 Retry-After: 60。
severity: info / low / medium / high / critical。时间必须包含时区，IP 只接受单个 IPv4 / IPv6。
不要传 project_id 或 source_id：Token 决定所属项目和数据源。扩展字段放入 evidence。
request_id 在数据源内唯一；重试必须复用原 ID 和内容，服务端返回原回执。
event_id 在数据源内唯一；相同事件重复上报不重复计数。ID 对应不同内容返回 409，整批回滚。
任何一条不合法返回 400 并拒绝整批。修正后重新提交。成功返回 200 和 accepted / duplicates / newIps。
401: Token 无效或数据源停用；413: 正文过大；429: 请求过多，请退避重试；503: 服务不可用。

收到回执只表示告警已保存。达到项目配置的待处理去重 IP 阈值后创建批次及独立工程。
冷却期从选入批次时开始，同 IP 不会同时进入两个批次。新告警持续保存。
成功归档报告后整批标记已处理；失败/中止须手动重试，或放弃该快照。
冷却期结束且有未覆盖的新告警才再次进入待处理池。服务重启后的运行批次暂停等待恢复。

原始告警永久保存，支持按接收时间/数据源清理。未结束或待重试批次需先处理。
清空项目情报保留数据源、策略和幂等记录；工程指挥思路、已建工程、报告和工程查询证据独立保留。
Token 只显示一次，可停用、轮换；请在设备侧保存，通过 HTTPS 传输。
直接选择「工程 → 指挥思路」中的配置，内置“威胁 IP 分析”；查询步骤和预算由当前项目策略配置。
每批创建时冻结最新指挥思路，已有批次及手动重试沿用原快照；Token 上限默认留空（不限）。
WHOIS 使用 RDAP，ASN 使用 RIPEstat；资产查询复用设置中的 FOFA / Quake / Hunter。
查询由控制台主机发起，沿用资产平台自定义 BaseURL；不经过项目容器的代理。
资产查询仅第 1 页、返回数量可配置，可能产生平台费用。查询预算按逻辑查询计，平台限流重试最多 2 次。
分析会话仅提供批次内 IP 情报与目标进度工具，过程在工程任务中查看。
`;
