import { useEffect, useRef, useState } from "react";
import {
	Alert,
	Button,
	Descriptions,
	Drawer,
	Empty,
	Form,
	Input,
	InputNumber,
	Modal,
	Popconfirm,
	Select,
	Space,
	Spin,
	Switch,
	Table,
	Tabs,
	Tag,
	Typography,
} from "antd";
import {
	ReloadOutlined,
	PlusOutlined,
	ApiOutlined,
	ClusterOutlined,
	FileSearchOutlined,
	DeleteOutlined,
	ReadOutlined,
} from "@ant-design/icons";
import type {
	IntelligenceAlert,
	IntelligenceBatch,
	IntelligenceCleanup,
	IntelligenceIndicator,
	IntelligencePage,
	IntelligencePolicy,
	IntelligenceSource,
} from "../../../src/intelligence-types.ts";
import { intelligenceAgentPrompt } from "../../../src/intelligence-docs.ts";
import type { SentinelDoctrineView, SentinelProjectInfo } from "../types.ts";
import { Page, Section } from "../ui/Page.tsx";
import "./threat-intel.css";

type BatchRow = Omit<IntelligenceBatch, "items"> & { ipCount: number };
const labels: Record<string, string> = {
	queued: "排队中",
	creating: "创建工程",
	running: "运行中",
	paused: "已暂停",
	succeeded: "已处理",
	failed: "失败",
	aborted: "已中止",
	discarded: "已放弃",
	pending: "待处理",
	processing: "分析中",
	cooling: "冷却中",
	processed: "已处理",
	attention: "待处理异常",
};
const time = (value: number | null) => (value === null ? "尚未收到" : new Date(value).toLocaleString());

function ReceivedTime({ value }: { value: number | null }) {
	if (value === null) return <Typography.Text type="secondary">尚未收到</Typography.Text>;
	const date = new Date(value);
	return (
		<span className="threat-time" title={time(value)}>
			{date.toLocaleDateString()}
			<small>{date.toLocaleTimeString()}</small>
		</span>
	);
}

function StatusTag({ status }: { status: string }) {
	const color = ["failed", "attention"].includes(status)
		? "error"
		: ["running", "processing", "creating"].includes(status)
			? "processing"
			: ["succeeded", "processed"].includes(status)
				? "success"
				: ["paused", "cooling"].includes(status)
					? "warning"
					: "default";
	return <Tag color={color}>{labels[status] ?? status}</Tag>;
}

async function api<T>(projectId: string, path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
	const response = await fetch(
		`/api/intelligence/${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}`,
		{
			method: data === undefined ? "GET" : "POST",
			signal,
			...(data === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }),
		},
	);
	const result = (await response.json()) as T & { error?: string };
	if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
	return result;
}

function useResource<T>(projectId: string, path: string, revision: number, poll = false) {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const previousPath = useRef("");
	useEffect(() => {
		const controller = new AbortController();
		let busy = false;
		if (previousPath.current !== path) {
			setData(null);
			previousPath.current = path;
		}
		const load = async () => {
			if (busy) return;
			busy = true;
			try {
				const value = await api<T>(projectId, path, undefined, controller.signal);
				if (!controller.signal.aborted) {
					setData(value);
					setError(null);
				}
			} catch (error) {
				if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error));
			} finally {
				busy = false;
			}
		};
		void load();
		const timer = poll
			? window.setInterval(() => {
					void load();
				}, 10000)
			: undefined;
		return () => {
			controller.abort();
			if (timer !== undefined) window.clearInterval(timer);
		};
	}, [projectId, path, revision, poll]);
	return { data, error };
}

function PolicyForm({
	projectId,
	initial,
	doctrines,
	onManageDoctrines,
	onSaved,
}: {
	projectId: string;
	initial: IntelligencePolicy;
	doctrines: SentinelDoctrineView[];
	onManageDoctrines(): void;
	onSaved(): void;
}) {
	const [form] = Form.useForm<IntelligencePolicy>();
	const templateId = Form.useWatch(["template", "id"], form);
	const selectedDoctrine = doctrines.find((item) => item.id === templateId);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const save = async () => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const values = await form.validateFields();
			await api(projectId, "policy", values);
			setNotice("策略已保存，对后续批次生效。");
			onSaved();
		} catch (error) {
			setError(error instanceof Error ? error.message : "请检查表单必填项");
		} finally {
			setBusy(false);
		}
	};
	return (
		<Form
			form={form}
			layout="vertical"
			initialValues={initial}
			className="threat-policy"
			onFinish={() => {
				void save();
			}}
		>
			{error && <Alert type="error" title={error} showIcon />}
			{notice && <Alert type="success" title={notice} showIcon />}
			<div className="threat-policy__layout">
				<div className="threat-policy__fields">
					<Section
						title="触发规则"
						description="累计尚未处理的去重 IP，达到阈值后自动创建工程。"
						className="threat-policy__section"
					>
						<div className="threat-policy__toggle">
							<div>
								<strong>自动创建分析工程</strong>
								<p>保存策略后生效，每个批次创建独立工程。</p>
							</div>
							<Form.Item name="enabled" valuePropName="checked">
								<Switch aria-label="自动创建分析工程" />
							</Form.Item>
						</div>
						<div className="threat-policy__grid">
							<Form.Item
								name="threshold"
								label="触发阈值"
								extra="累计待处理的去重 IP 数量"
								rules={[{ required: true }]}
							>
								<InputNumber min={1} max={200} suffix="个 IP" />
							</Form.Item>
							<Form.Item
								name="batchSize"
								label="单批最多 IP"
								extra="每轮工程处理的 IP 数量上限"
								rules={[{ required: true }]}
							>
								<InputNumber min={1} max={200} suffix="个 IP" />
							</Form.Item>
							<Form.Item
								name="concurrency"
								label="并行批次上限"
								extra="暂停的批次也占用并发名额"
								rules={[{ required: true }]}
							>
								<InputNumber min={1} max={8} suffix="批" />
							</Form.Item>
							<Form.Item
								name="cooldownMinutes"
								label="冷却期"
								extra="从 IP 选入批次时开始计算"
								rules={[{ required: true }]}
							>
								<InputNumber min={0} max={525600} suffix="分钟" />
							</Form.Item>
						</div>
					</Section>
					<Section
						title="工程指挥思路"
						description="复用「工程 → 指挥思路」中的配置。"
						extra={
							<Button type="link" size="small" onClick={onManageDoctrines}>
								管理指挥思路
							</Button>
						}
						className="threat-policy__section"
					>
						<Form.Item label="选择指挥思路" required>
							<Select
								aria-label="选择指挥思路"
								placeholder="选择工程中的指挥思路"
								value={templateId}
								options={doctrines.map((item) => ({ value: item.id, label: item.name }))}
								onChange={(id) => {
									const doctrine = doctrines.find((item) => item.id === id);
									if (doctrine) {
										form.setFieldValue(["template", "id"], doctrine.id);
										form.setFieldValue(["template", "name"], doctrine.name);
										form.setFieldValue(["template", "prompt"], doctrine.text);
									}
								}}
							/>
						</Form.Item>
						{templateId && !selectedDoctrine && (
							<Alert type="warning" showIcon title="关联的工程指挥思路已被删除，请重新选择后保存。" />
						)}
						{doctrines.length === 0 && (
							<Alert type="info" showIcon title="还没有指挥思路，请先到工程中创建，再返回选择。" />
						)}
						<Form.Item name={["template", "id"]} hidden>
							<Input />
						</Form.Item>
						<Form.Item name={["template", "name"]} hidden>
							<Input />
						</Form.Item>
						<Form.Item name={["template", "prompt"]} hidden>
							<Input />
						</Form.Item>
						{selectedDoctrine && (
							<details className="threat-policy__preview">
								<summary>预览指挥思路 · {selectedDoctrine.name}</summary>
								<pre>{selectedDoctrine.text}</pre>
							</details>
						)}
					</Section>
					<Section
						title="运行限制"
						description="每批提交普通工程，由指挥官派发任务，执行 Agent 沿用项目配置。"
						className="threat-policy__section"
					>
						<div className="threat-policy__grid threat-policy__grid--limits">
							<Form.Item
								name={["template", "limits", "roundLimit"]}
								label="Agent 续跑轮数"
								rules={[{ required: true }]}
							>
								<InputNumber min={1} max={99} />
							</Form.Item>
							<Form.Item name={["template", "limits", "tokenLimit"]} label="Token 上限" extra="留空表示不限">
								<InputNumber min={1} max={10000000} placeholder="不限" />
							</Form.Item>
							<Form.Item name={["template", "limits", "timeLimitMin"]} label="时间上限" extra="留空表示不限">
								<InputNumber min={1} max={1440} placeholder="不限" suffix="分钟" />
							</Form.Item>
						</div>
						<Form.Item name={["template", "limits", "concurrency"]} hidden>
							<InputNumber />
						</Form.Item>
						<Form.Item name={["template", "limits", "maxRetries"]} hidden>
							<InputNumber />
						</Form.Item>
					</Section>
				</div>
				<aside className="threat-policy__notes" aria-label="批次处理说明">
					<FileSearchOutlined aria-hidden="true" />
					<h3>从告警到分析报告</h3>
					<ul>
						<li>达到阈值后创建批次，每个 IP 同时只进入一个批次。</li>
						<li>创建时保存指挥思路快照，已有批次与重试沿用原配置。</li>
						<li>工程成功结束时，整批 IP 标记为已处理。</li>
						<li>失败或中止后保留记录，由你手动重试。</li>
						<li>冷却期结束且有新告警时，IP 才能再次进入待处理池。</li>
					</ul>
				</aside>
			</div>
			<div className="threat-policy__footer">
				<Button type="primary" htmlType="submit" loading={busy} disabled={!selectedDoctrine}>
					保存策略
				</Button>
				<Typography.Text type="secondary">修改仅对后续新批次生效</Typography.Text>
			</div>
		</Form>
	);
}

function AlertDetail({ projectId, ip }: { projectId: string; ip: string }) {
	const [page, setPage] = useState(1);
	const resource = useResource<IntelligencePage<IntelligenceAlert>>(
		projectId,
		`alerts?ip=${encodeURIComponent(ip)}&page=${page}`,
		0,
	);
	return (
		<>
			{resource.error && <Alert type="error" title={resource.error} />}
			<Table
				scroll={{ x: 600 }}
				rowKey="seq"
				size="small"
				loading={!resource.data && !resource.error}
				dataSource={resource.data?.items ?? []}
				pagination={{
					current: page,
					total: resource.data?.total ?? 0,
					pageSize: 50,
					showSizeChanger: false,
					onChange: setPage,
				}}
				columns={[
					{ title: "告警时间", render: (_, row) => row.occurred_at },
					{ title: "来源", dataIndex: "sourceName" },
					{ title: "级别", dataIndex: "severity" },
					{ title: "类型", dataIndex: "category" },
				]}
				expandable={{ expandedRowRender: (row) => <pre className="threat-code">{JSON.stringify(row, null, 2)}</pre> }}
			/>
		</>
	);
}

function BatchDetail({
	projectId,
	id,
	onOpenEngine,
}: {
	projectId: string;
	id: string;
	onOpenEngine(id: string): void;
}) {
	const { data, error } = useResource<IntelligenceBatch>(projectId, `batches/${id}`, 0, true);
	if (error) return <Alert type="error" title={error} />;
	if (!data) return <Spin />;
	return (
		<Space orientation="vertical" style={{ width: "100%" }}>
			<Descriptions
				size="small"
				column={1}
				items={[
					{ key: "id", label: "批次", children: data.id },
					{ key: "state", label: "状态", children: labels[data.status] },
					{ key: "template", label: "指挥思路快照", children: data.template.name },
					{ key: "time", label: "选入批次时间", children: time(data.createdAt) },
					{ key: "ips", label: "IP", children: data.items.map((item) => item.ip).join("、") },
				]}
			/>
			<Table
				size="small"
				rowKey="id"
				scroll={{ x: 600 }}
				pagination={false}
				dataSource={data.attempts}
				columns={[
					{ title: "尝试", dataIndex: "number" },
					{ title: "状态", render: (_, row) => labels[row.status] },
					{
						title: "工程",
						render: (_, row) =>
							row.engineId ? (
								<Button type="link" onClick={() => onOpenEngine(row.engineId as string)}>
									查看工程与报告
								</Button>
							) : (
								"待创建"
							),
					},
					{ title: "说明", dataIndex: "error" },
				]}
			/>
			<details>
				<summary>告警与执行配置快照</summary>
				<pre className="threat-code">
					{JSON.stringify({ template: data.template, policy: data.policy, items: data.items }, null, 2)}
				</pre>
			</details>
		</Space>
	);
}

function ThreatIntelWorkspace({
	project,
	refreshRevision,
	onOpenEngine,
	onManageDoctrines,
}: {
	project: SentinelProjectInfo;
	refreshRevision: number;
	onOpenEngine(id: string): void;
	onManageDoctrines(): void;
}) {
	const [activeTab, setActiveTab] = useState("ips");
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		setRevision((value) => value + 1);
	}, [refreshRevision]);
	const [policyRevision, setPolicyRevision] = useState(0);
	const [page, setPage] = useState(1);
	const [batchPage, setBatchPage] = useState(1);
	const [search, setSearch] = useState("");
	const [name, setName] = useState("");
	const [token, setToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [ip, setIp] = useState<string | null>(null);
	const [batchId, setBatchId] = useState<string | null>(null);
	const [cleanupOpen, setCleanupOpen] = useState(false);
	const [sourceId, setSourceId] = useState<string | undefined>();
	const [after, setAfter] = useState("");
	const [before, setBefore] = useState("");
	const [preview, setPreview] = useState<{
		events: number;
		blockedBatches: number;
		filters: IntelligenceCleanup;
	} | null>(null);
	const operationActive = useRef(false);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	const ips = useResource<IntelligencePage<IntelligenceIndicator>>(
		project.id,
		`ips?page=${page}&search=${encodeURIComponent(search)}`,
		revision,
		true,
	);
	const sources = useResource<IntelligenceSource[]>(project.id, "sources", revision, true);
	const batches = useResource<IntelligencePage<BatchRow>>(project.id, `batches?page=${batchPage}`, revision, true);
	const policy = useResource<IntelligencePolicy>(project.id, "policy", policyRevision);
	const doctrines = useResource<SentinelDoctrineView[]>(project.id, "doctrines", revision);
	const refresh = () => setRevision((value) => value + 1);
	const run = async (operation: () => Promise<unknown>) => {
		if (operationActive.current) return;
		operationActive.current = true;
		setBusy(true);
		setError(null);
		try {
			await operation();
			if (alive.current) refresh();
		} catch (error) {
			if (alive.current) setError(error instanceof Error ? error.message : String(error));
		} finally {
			operationActive.current = false;
			if (alive.current) setBusy(false);
		}
	};
	const action = (id: string, command: string) => {
		void run(() => api(project.id, `batches/${id}/${command}`, {}));
	};
	const filters: IntelligenceCleanup = {
		...(sourceId ? { sourceId } : {}),
		...(after ? { after: new Date(after).getTime() } : {}),
		...(before ? { before: new Date(before).getTime() } : {}),
	};
	const agentPrompt = intelligenceAgentPrompt(location.origin, project.name);
	const resourceError = ips.error ?? sources.error ?? batches.error ?? policy.error ?? doctrines.error;
	return (
		<Page
			className="threat-intel"
			title="威胁反制"
			description={`${project.name} 的设备告警、威胁 IP 与分析工程`}
			extra={
				<Space wrap>
					<Tag color={policy.data?.enabled ? "green" : "default"}>
						{policy.data?.enabled ? "自动分析已启用" : "自动分析未启用"}
					</Tag>
					<Button icon={<ReloadOutlined aria-hidden="true" />} onClick={refresh}>
						刷新
					</Button>
					<Button type="text" icon={<DeleteOutlined aria-hidden="true" />} onClick={() => setCleanupOpen(true)}>
						清理数据
					</Button>
				</Space>
			}
		>
			{(error ?? resourceError) && (
				<Alert type="error" showIcon title={error ?? resourceError} closable onClose={() => setError(null)} />
			)}
			<nav className="threat-flow" aria-label="威胁情报工作流程">
				<button
					type="button"
					className={activeTab === "sources" ? "is-current" : undefined}
					onClick={() => setActiveTab("sources")}
				>
					<ApiOutlined aria-hidden="true" />
					<span>
						<strong>接入设备</strong>
						<small>
							{sources.data
								? `${sources.data.filter((source) => source.enabled).length} / ${sources.data.length} 个数据源已启用`
								: "创建数据源，获取独立 Token"}
						</small>
					</span>
				</button>
				<button
					type="button"
					className={activeTab === "policy" ? "is-current" : undefined}
					onClick={() => setActiveTab("policy")}
				>
					<ClusterOutlined aria-hidden="true" />
					<span>
						<strong>自动分析</strong>
						<small>
							{policy.data
								? `累计 ${policy.data.threshold} 个 IP 触发，每批最多 ${policy.data.batchSize} 个`
								: "设置触发规则与工程指挥思路"}
						</small>
					</span>
				</button>
				<button
					type="button"
					className={activeTab === "batches" ? "is-current" : undefined}
					onClick={() => setActiveTab("batches")}
				>
					<FileSearchOutlined aria-hidden="true" />
					<span>
						<strong>查看结果</strong>
						<small>
							{batches.data ? `${batches.data.total} 个处理批次，查看工程与报告` : "追踪处理批次与工程报告"}
						</small>
					</span>
				</button>
			</nav>
			<div className="threat-intel__panel">
				<Tabs
					activeKey={activeTab}
					onChange={setActiveTab}
					items={[
						{
							key: "ips",
							label: `威胁 IP${ips.data ? ` · ${ips.data.total}` : ""}`,
							children: (
								<>
									<div className="threat-toolbar">
										<Input.Search
											placeholder="搜索 IP"
											allowClear
											onSearch={(value) => {
												setSearch(value);
												setPage(1);
											}}
											className="threat-search"
											aria-label="搜索威胁 IP"
										/>
										<Typography.Text type="secondary">平台保留告警元数据，分析工程仅接收威胁 IP</Typography.Text>
									</div>
									<Table
										className="threat-table"
										rowKey="ip"
										size="small"
										loading={!ips.data && !ips.error}
										dataSource={ips.data?.items ?? []}
										scroll={{ x: 1250 }}
										locale={{
											emptyText: (
												<Empty
													image={Empty.PRESENTED_IMAGE_SIMPLE}
													description={search ? "未找到匹配的 IP，请更换关键词" : "尚无威胁 IP，接入设备后会在这里汇总"}
												>
													{!search && (
														<Button type="primary" onClick={() => setActiveTab("sources")}>
															接入数据源
														</Button>
													)}
												</Empty>
											),
										}}
										pagination={{
											current: page,
											total: ips.data?.total ?? 0,
											pageSize: 50,
											showSizeChanger: false,
											onChange: setPage,
										}}
										columns={[
											{
												title: "IP 地址",
												width: 350,
												render: (_, row) => (
													<Button className="threat-ip" title={row.ip} type="link" onClick={() => setIp(row.ip)}>
														{row.ip}
													</Button>
												),
											},
											{ title: "状态", width: 110, render: (_, row) => <StatusTag status={row.status} /> },
											{ title: "告警总数", width: 100, align: "right", dataIndex: "count" },
											{ title: "未处理告警", width: 115, align: "right", dataIndex: "pending" },
											{ title: "数据来源", width: 180, ellipsis: true, render: (_, row) => row.sources.join("、") },
											{ title: "最近接收", width: 130, render: (_, row) => <ReceivedTime value={row.lastSeen} /> },
											{
												title: "冷却截止",
												width: 130,
												render: (_, row) => (row.cooldownUntil ? <ReceivedTime value={row.cooldownUntil} /> : "—"),
											},
											{
												title: "批次",
												render: (_, row) =>
													row.batchId ? (
														<Button type="link" onClick={() => setBatchId(row.batchId)}>
															查看
														</Button>
													) : (
														"—"
													),
											},
										]}
									/>
								</>
							),
						},
						{
							key: "sources",
							label: "数据源",
							children: (
								<>
									<Section
										title="设备数据源"
										description="WAF、防火墙等设备使用各自的 Token，向本项目推送统一 JSON 告警。"
										extra={
											<Button icon={<ReadOutlined aria-hidden="true" />} onClick={() => setActiveTab("docs")}>
												获取接入提示词
											</Button>
										}
									>
										<div className="threat-source-create">
											<Input
												aria-label="数据源名称"
												value={name}
												onChange={(event) => setName(event.target.value)}
												placeholder="例如：生产 WAF"
												maxLength={120}
											/>
											<Button
												type="primary"
												icon={<PlusOutlined aria-hidden="true" />}
												loading={busy}
												disabled={!name.trim()}
												onClick={() => {
													void run(async () => {
														const result = await api<{ token: string }>(project.id, "sources", { name });
														if (alive.current) {
															setToken(result.token);
															setName("");
														}
													});
												}}
											>
												新增数据源
											</Button>
										</div>
									</Section>
									<Table
										className="threat-table"
										scroll={{ x: 650 }}
										locale={{
											emptyText: (
												<Empty
													image={Empty.PRESENTED_IMAGE_SIMPLE}
													description="还没有数据源，在上方填写设备名称即可创建"
												/>
											),
										}}
										rowKey="id"
										size="small"
										dataSource={sources.data ?? []}
										loading={!sources.data && !sources.error}
										pagination={false}
										columns={[
											{ title: "名称", dataIndex: "name", ellipsis: true, width: 240 },
											{ title: "最近接收", render: (_, row) => <ReceivedTime value={row.lastReceivedAt} /> },
											{
												title: "启用",
												render: (_, row) => (
													<Switch
														aria-label={`${row.name} 启用状态`}
														checked={row.enabled}
														disabled={busy}
														onChange={(enabled) => {
															void run(() => api(project.id, `sources/${row.id}`, { enabled, rotate: false }));
														}}
													/>
												),
											},
											{
												title: "凭据",
												render: (_, row) => (
													<Popconfirm
														title="轮换后旧 Token 立即失效"
														onConfirm={() =>
															run(async () => {
																const result = await api<{ token: string }>(project.id, `sources/${row.id}`, {
																	enabled: row.enabled,
																	rotate: true,
																});
																if (alive.current) setToken(result.token);
															})
														}
													>
														<Button disabled={busy}>轮换 Token</Button>
													</Popconfirm>
												),
											},
										]}
									/>
								</>
							),
						},
						{
							key: "policy",
							label: "自动分析",
							children:
								policy.data && doctrines.data ? (
									<PolicyForm
										projectId={project.id}
										initial={policy.data}
										doctrines={doctrines.data}
										onManageDoctrines={onManageDoctrines}
										onSaved={() => {
											refresh();
											setPolicyRevision((value) => value + 1);
										}}
									/>
								) : (
									<Spin />
								),
						},
						{
							key: "batches",
							label: "处理批次",
							children: (
								<>
									<div className="threat-toolbar">
										<Typography.Text type="secondary">
											每批对应一个独立工程；失败或中止的批次可手动重试。
										</Typography.Text>
									</div>
									<Table
										className="threat-table"
										rowKey="id"
										size="small"
										locale={{
											emptyText: (
												<Empty
													image={Empty.PRESENTED_IMAGE_SIMPLE}
													description="还没有处理批次，待处理 IP 达到触发阈值后自动创建"
												>
													<Button onClick={() => setActiveTab("policy")}>配置自动分析</Button>
												</Empty>
											),
										}}
										loading={!batches.data && !batches.error}
										dataSource={batches.data?.items ?? []}
										scroll={{ x: 900 }}
										pagination={{
											current: batchPage,
											total: batches.data?.total ?? 0,
											pageSize: 20,
											showSizeChanger: false,
											onChange: setBatchPage,
										}}
										columns={[
											{
												title: "批次",
												render: (_, row) => (
													<Button type="link" onClick={() => setBatchId(row.id)}>
														{row.id.slice(0, 8)}
													</Button>
												),
											},
											{ title: "创建时间", render: (_, row) => <ReceivedTime value={row.createdAt} /> },
											{ title: "IP", dataIndex: "ipCount" },
											{ title: "状态", render: (_, row) => <StatusTag status={row.status} /> },
											{ title: "尝试", render: (_, row) => row.attempts.length },
											{
												title: "工程",
												render: (_, row) => {
													const id = row.attempts.at(-1)?.engineId;
													return id ? (
														<Button type="link" onClick={() => onOpenEngine(id)}>
															查看工程
														</Button>
													) : (
														"待创建"
													);
												},
											},
											{
												title: "操作",
												render: (_, row) => (
													<Space wrap>
														{row.status === "running" && (
															<Button size="small" disabled={busy} onClick={() => action(row.id, "pause")}>
																暂停
															</Button>
														)}
														{row.status === "paused" && (
															<Button size="small" disabled={busy} onClick={() => action(row.id, "resume")}>
																恢复
															</Button>
														)}
														{["running", "paused", "queued", "creating"].includes(row.status) && (
															<Popconfirm
																title="中止本批次？记录保留，可手动重试。"
																onConfirm={() => action(row.id, "abort")}
															>
																<Button size="small" danger disabled={busy}>
																	中止
																</Button>
															</Popconfirm>
														)}
														{["failed", "aborted"].includes(row.status) && (
															<>
																<Button size="small" disabled={busy} onClick={() => action(row.id, "retry")}>
																	重试
																</Button>
																<Popconfirm
																	title="放弃此快照？仅新告警可再次进入待处理池。"
																	onConfirm={() => action(row.id, "discard")}
																>
																	<Button size="small" disabled={busy}>
																		放弃
																	</Button>
																</Popconfirm>
															</>
														)}
													</Space>
												),
											},
										]}
									/>
								</>
							),
						},
						{
							key: "docs",
							label: "接入提示词",
							children: (
								<div className="threat-docs">
									<div className="threat-toolbar">
										<div>
											<Typography.Title level={5}>让 Agent 自动接入设备告警</Typography.Title>
											<Typography.Text type="secondary">
												复制完整提示词交给 Agent，按提示提供设备信息与数据源 Token，即可开始接入。
											</Typography.Text>
										</div>
										<Typography.Paragraph copyable={{ text: agentPrompt, tooltips: ["复制完整提示词", "已复制"] }}>
											复制完整提示词
										</Typography.Paragraph>
									</div>
									<Input.TextArea
										readOnly
										value={agentPrompt}
										aria-label="Agent 接入提示词"
										autoSize={{ minRows: 18, maxRows: 28 }}
										spellCheck={false}
									/>
								</div>
							),
						},
					]}
				/>
			</div>
			<Modal
				title="保存数据源 Token"
				open={token !== null}
				onCancel={() => setToken(null)}
				footer={<Button onClick={() => setToken(null)}>已保存</Button>}
			>
				<p>Token 仅显示本次，请复制到设备配置。它只允许向当前项目的该数据源推送告警。</p>
				<Typography.Paragraph copyable={token ? { text: token } : false} style={{ overflowWrap: "anywhere" }}>
					{token}
				</Typography.Paragraph>
			</Modal>
			<Drawer
				title={`告警 · ${ip ?? ""}`}
				open={ip !== null}
				onClose={() => setIp(null)}
				size="large"
				className="threat-detail"
			>
				{ip && <AlertDetail key={ip} projectId={project.id} ip={ip} />}
			</Drawer>
			<Drawer
				title="处理批次"
				open={batchId !== null}
				onClose={() => setBatchId(null)}
				size="large"
				className="threat-detail"
			>
				{batchId && <BatchDetail key={batchId} projectId={project.id} id={batchId} onOpenEngine={onOpenEngine} />}
			</Drawer>
			<Modal
				title="清理项目情报"
				open={cleanupOpen}
				onCancel={() => {
					setCleanupOpen(false);
					setPreview(null);
				}}
				footer={null}
			>
				<Space orientation="vertical" style={{ width: "100%" }}>
					{error && <Alert type="error" title={error} />}
					<p>
						按数据源和接收时间删除原始告警。批次快照、工程及报告独立保留；关联未结束或待重试批次的告警需先处理批次。
					</p>
					<Select
						disabled={busy}
						style={{ width: "100%" }}
						allowClear
						placeholder="所有数据源"
						value={sourceId}
						options={(sources.data ?? []).map((source) => ({ value: source.id, label: source.name }))}
						onChange={(value) => {
							setSourceId(value);
							setPreview(null);
						}}
					/>
					<label>
						接收时间从
						<Input
							disabled={busy}
							type="datetime-local"
							value={after}
							onChange={(event) => {
								setAfter(event.target.value);
								setPreview(null);
							}}
						/>
					</label>
					<label>
						到
						<Input
							disabled={busy}
							type="datetime-local"
							value={before}
							onChange={(event) => {
								setBefore(event.target.value);
								setPreview(null);
							}}
						/>
					</label>
					<Button
						loading={busy}
						onClick={() => {
							void run(async () => {
								const result = await api<{ events: number; blockedBatches: number }>(
									project.id,
									"cleanup/preview",
									filters,
								);
								if (alive.current) setPreview({ ...result, filters });
							});
						}}
					>
						预览清理数量
					</Button>
					{preview && (
						<>
							<p>
								将删除 {preview.events} 条告警，关联 {preview.blockedBatches} 个未处理批次。
							</p>
							<Popconfirm
								title={`永久删除 ${preview.events} 条告警？`}
								onConfirm={() =>
									run(async () => {
										await api(project.id, "cleanup", preview.filters);
										if (alive.current) {
											setPreview(null);
											setCleanupOpen(false);
										}
									})
								}
							>
								<Button danger disabled={busy || preview.blockedBatches > 0 || preview.events === 0}>
									确认删除
								</Button>
							</Popconfirm>
						</>
					)}
					<Popconfirm
						title="清空本项目全部告警和批次记录？"
						description="保留数据源、策略和幂等记录；工程指挥思路、工程及报告独立保留。请先中止未结束的批次。"
						onConfirm={() =>
							run(async () => {
								await api(project.id, "clear", { confirmProjectId: project.id });
								if (alive.current) {
									setCleanupOpen(false);
									setPreview(null);
								}
							})
						}
					>
						<Button danger disabled={busy}>
							清空项目情报
						</Button>
					</Popconfirm>
				</Space>
			</Modal>
		</Page>
	);
}

export function ThreatIntelPage({
	project,
	refreshRevision = 0,
	onOpenEngine,
	onManageDoctrines,
}: {
	project: SentinelProjectInfo | null;
	refreshRevision?: number;
	onOpenEngine(id: string): void;
	onManageDoctrines(): void;
}) {
	if (!project)
		return (
			<Page title="威胁反制">
				<Empty description="请先选择项目，再接入威胁情报" />
			</Page>
		);
	return (
		<ThreatIntelWorkspace
			key={project.id}
			project={project}
			refreshRevision={refreshRevision}
			onOpenEngine={onOpenEngine}
			onManageDoctrines={onManageDoctrines}
		/>
	);
}
