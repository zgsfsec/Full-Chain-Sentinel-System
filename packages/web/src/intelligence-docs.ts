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
		},
	],
};

export const INTELLIGENCE_API_GUIDE = `POST /api/intelligence/v1/ingest
Authorization: Bearer <数据源 Token>
Content-Type: application/json

${JSON.stringify(INTELLIGENCE_EXAMPLE, null, 2)}

每批 1–1000 条，正文最大 1 MiB。事件仅允许 event_id、indicator、occurred_at、category、severity 五个字段。
每数据源每 60 秒最多 60 次请求，同时最多 4 个推送；全局同时最多 16 个。429 返回 Retry-After: 60。
severity: info / low / medium / high / critical。时间必须包含时区，IP 只接受单个 IPv4 / IPv6。
不要传 project_id 或 source_id：Token 决定所属项目和数据源。不接受 evidence 或任何扩展字段，包含额外字段时整批拒绝。
仅上报威胁来源 IP 和告警元数据，不上传客户请求、请求头、Cookie、请求体、攻击载荷、目标 IP/域名/URL 或业务数据。
event_id 使用不含业务内容的稳定编号，category 使用通用类别编码，不得将敏感内容拼入这些字段。
request_id 在数据源内唯一；重试必须复用原 ID 和内容，服务端返回原回执。
event_id 在数据源内唯一；相同事件重复上报不重复计数。ID 对应不同内容返回 409，整批回滚。
任何一条不合法返回 400 并拒绝整批。修正后重新提交。成功返回 200 和 accepted / duplicates / newIps。
401: Token 无效或数据源停用；413: 正文过大；429: 请求过多，请退避重试；503: 服务不可用。

收到回执只表示告警已保存。达到项目配置的待处理去重 IP 阈值后创建批次及独立工程。
冷却期从选入批次时开始，同 IP 不会同时进入两个批次。新告警持续保存。
成功归档报告后整批标记已处理；失败/中止须手动重试，或放弃该快照。
冷却期结束且有未覆盖的新告警才再次进入待处理池。服务重启后的运行批次暂停等待恢复。

告警元数据永久保存，支持按接收时间/数据源清理。未结束或待重试批次需先处理。
清空项目情报保留数据源、策略和幂等记录；工程指挥思路、已建工程和报告独立保留。
Token 只显示一次，可停用、轮换；请在设备侧保存，通过 HTTPS 传输。
直接选择「工程 → 指挥思路」中的配置，默认内置“威胁溯源反制”。
每批创建时冻结最新指挥思路，已有批次及手动重试沿用原快照；Token 上限默认留空（不限）。
平台保留告警元数据用于管理、去重和批次结算；分析工程仅接收威胁 IP 列表，不传设备信息、来源名称、事件编号、时间、类别、级别或计数。
批次提交为普通工程，由指挥官按所选思路派发任务，执行 Agent 使用项目现有工具、技能和权限。
工程输入 JSON 仅包含 ips 数组，指挥官及执行 Agent 仅围绕其中的 IP 进行只读分析。任务会话可正常查看和续跑，由指挥官提交总报告。
`;

export function intelligenceAgentPrompt(origin: string, projectName: string): string {
	const endpoint = `${origin}/api/intelligence/v1/ingest`;
	return `请为我的安全设备实现并配置威胁 IP 告警同步，将真实告警自动推送到全链哨兵。请完成接入代码、配置和验证，不要只给出方案。

接入参数
- 目标项目：${JSON.stringify(projectName)}（仅供识别，实际项目由数据源 Token 决定）。
- 推送地址：${endpoint}
- 数据源 Token：从环境变量 SENTINEL_INTELLIGENCE_TOKEN 读取；由我在「威胁反制 → 数据源」创建并保存。
- 设备地址、设备凭据、告警读取方式、同步频率：优先复用当前工作区和部署环境中的已有配置。缺少必要信息时一次性向我询问；不要猜测或编造。
- 若 Agent 或设备无法访问上述地址，请向我确认设备可访问的平台地址，并通过 SENTINEL_INTELLIGENCE_ENDPOINT 配置；不要默认 localhost 指向平台。

执行要求
1. 检查现有设备接口、日志或导出文件和项目技术栈，在设备侧或已有采集服务中实现格式转换与主动推送。设备原生支持时优先配置已有能力，否则实现可重复运行的同步程序。
2. 从真实告警仅提取威胁来源 IP、稳定事件编号、发生时间、通用类别编码与级别；不要误取被攻击的目标 IP。明确记录字段映射及 severity 映射，不确定的字段先确认。不要上传客户请求、请求头、Cookie、请求体、攻击载荷、目标 IP/域名/URL 或业务数据，也不要将这些内容拼入编号或类别。
3. 按下方协议校验并分批提交。request_id、event_id、category 均为 1–200 字符的非空字符串；event_id 在同一数据源内稳定且唯一，同批不能重复。indicator 只能包含 type 和 value，不得添加 evidence 或其他扩展字段。无法转换的告警只记录脱敏错误和事件编号，不复制原始敏感告警，不要静默丢弃或填造数据。
4. 在发送前持久化请求 ID、完整请求内容和同步游标。超时、断网、429 或 5xx 时保留原请求，按退避策略重试；429 遵守 Retry-After。重试必须使用相同 request_id 和原内容，不要重新生成 ID。收到 HTTP 200 的有效回执后才推进游标并确认本批已发送。
5. 400 根据 error 定位并修正整批数据，修正后的内容使用新的 request_id；401 检查 Token 与数据源启用状态；409 排查 ID 对应内容冲突，不要无限重试；413 缩小批次并生成新的子批次请求 ID；其他不可重试的 4xx 保留失败记录并报告。
6. Token 与设备凭据从环境变量或已有密钥配置读取，不要硬编码、写入日志或提交 Git。给出不含真实凭据的配置示例，部署时使用 HTTPS。
7. 根据确认的同步频率配置设备推送或定时任务，防止任务重叠，重启后能恢复未确认请求。不要修改平台自动分析策略、创建工程、清理已有情报或轮换 Token。
8. 先用本地模拟服务验证字段转换、批次限制、重复上报、失败重试与游标恢复；协议示例仅用于本地测试，不要向真实平台发送示例或伪造告警。需要联调时使用我确认的真实告警，展示脱敏回执。没有真实数据或凭据时说明尚未完成的验证。

接口协议与平台处理语义
${INTELLIGENCE_API_GUIDE.replace("POST /api/intelligence/v1/ingest", `POST ${endpoint}`)}
交付与验收
- 给出已实现的文件、设备字段映射、依赖、配置变量、启动和定时运行方式。
- 说明本地验证结果与真实联调结果，提供脱敏的 requestId、accepted、duplicates、newIps；没有真实回执时不要声称接入成功。
- 确认重复发送不会重复计数，失败请求可恢复；区分“告警已接收”与“分析工程已完成”。
`;
}
