import { DownloadOutlined, QuestionCircleOutlined, ReloadOutlined, SettingOutlined } from "@ant-design/icons";
import {
	Alert,
	Badge,
	Button,
	Descriptions,
	Drawer,
	Empty,
	Flex,
	Form,
	Input,
	InputNumber,
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
import { useEffect, useRef, useState } from "react";
import type {
	MitmBody,
	MitmConfig,
	MitmFlow,
	MitmFlowDetail,
	MitmFlowPage,
	MitmStatus,
} from "../../../src/mitm-types.ts";
import { getLanguage } from "../i18n.ts";
import { Page, Section } from "../ui/Page.tsx";
import "./MitmPage.css";

const tx = (zh: string, en: string) => (getLanguage() === "en" ? en : zh);

async function api<T>(url: string, signal?: AbortSignal, body?: Record<string, unknown>): Promise<T> {
	const response = await fetch(
		url,
		body
			? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }
			: { signal },
	);
	const data = (await response.json()) as T & { error?: string };
	if (!response.ok) throw new Error(data.error ?? tx("请求失败", "Request failed"));
	return data;
}

function bytes(size: number): string {
	return size < 1024
		? `${size} B`
		: size < 1024 * 1024
			? `${(size / 1024).toFixed(1)} KB`
			: `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function mitmProxyEndpoint(status: MitmStatus | null, consoleHostname: string): string | null {
	const port = status?.port ?? status?.config.port;
	if (!status || !port) return null;
	if (status.config.bind === "127.0.0.1") return `127.0.0.1:${port}`;
	const hostname = consoleHostname.replace(/^\[|\]$/g, "");
	const remoteIp =
		hostname !== "::1" &&
		!hostname.startsWith("127.") &&
		(hostname.includes(":") || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname));
	const host = remoteIp ? hostname : status.lanIps[0];
	if (!host) return null;
	return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** Render captured content only as text, including HTML and binary payloads. */
export function MitmRawMessage({ body, download }: { body: MitmBody; download: string }) {
	return (
		<div className="mitm-raw">
			<Flex justify="space-between" align="center" gap={12} wrap className="mitm-raw__bar">
				<Typography.Text type="secondary">
					{bytes(body.size)}
					{body.encoding === "base64" ? " · Base64" : ""}
					{body.truncated ? tx(" · 仅预览前 1 MB", " · First 1 MB preview") : ""}
					{body.captureTruncated ? tx(" · 已按保存上限截断", " · Capture size limit reached") : ""}
				</Typography.Text>
				<Button size="small" icon={<DownloadOutlined />} href={download}>
					{body.captureTruncated ? tx("下载已保存报文", "Download captured bytes") : tx("下载原始报文", "Download raw")}
				</Button>
			</Flex>
			<pre>{body.text || tx("没有报文内容", "No content")}</pre>
		</div>
	);
}

export function MitmFlowLink({ flow, onOpen }: { flow: MitmFlow; onOpen: () => void }) {
	const host = flow.host.includes(":") && !flow.host.startsWith("[") ? `[${flow.host}]` : flow.host;
	const port = flow.port !== (flow.scheme === "https" ? 443 : 80) ? `:${flow.port}` : "";
	const url = `${flow.scheme}://${host}${port}${flow.path}${flow.query ? `?${flow.query}` : ""}`;
	return (
		<Button type="link" className="mitm-flow-link" onClick={onOpen} title={url}>
			<span>{url}</span>
		</Button>
	);
}

export function MitmPage({ project }: { project: { id: string; name: string } | null }) {
	const [status, setStatus] = useState<MitmStatus | null>(null);
	const [flows, setFlows] = useState<MitmFlowPage>({ items: [], total: 0, page: 1, pageSize: 50 });
	const [query, setQuery] = useState({ q: "", method: "", status: "", page: 1 });
	const [draftSearch, setDraftSearch] = useState("");
	const [live, setLive] = useState(true);
	const [revision, setRevision] = useState(0);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [pollError, setPollError] = useState("");
	const [drawer, setDrawer] = useState<"settings" | "help" | null>(null);
	const [config, setConfig] = useState<MitmConfig>({ bind: "127.0.0.1", port: 0, skipStatic: true, maxCaptureMb: 2 });
	const [selected, setSelected] = useState<string | null>(null);
	const [detail, setDetail] = useState<MitmFlowDetail | null>(null);
	const [detailError, setDetailError] = useState("");
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	const projectId = project?.id;
	const params = new URLSearchParams({
		projectId: projectId ?? "",
		q: query.q,
		method: query.method,
		status: query.status,
		page: String(query.page),
	});
	const filter = params.toString();
	const scope = `projectId=${encodeURIComponent(projectId ?? "")}`;
	const running = status?.state === "running";
	const unavailable = status?.state === "unavailable";

	useEffect(() => {
		if (!projectId || busy) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			setLoading(true);
			try {
				const [nextStatus, nextFlows] = await Promise.all([
					api<MitmStatus>(`/api/mitm?projectId=${encodeURIComponent(projectId)}`, controller.signal),
					api<MitmFlowPage>(`/api/mitm/flows?${filter}`, controller.signal),
				]);
				if (!controller.signal.aborted) {
					setStatus(nextStatus);
					setFlows(nextFlows);
					setPollError("");
				}
			} catch (cause) {
				if (!controller.signal.aborted) setPollError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (!controller.signal.aborted) {
					setLoading(false);
					if (live) timer = setTimeout(refresh, 3000);
				}
			}
		};
		void refresh();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [projectId, filter, live, revision, busy]);

	useEffect(() => {
		setDetail(null);
		setDetailError("");
		if (!selected || !projectId) return;
		const controller = new AbortController();
		void api<MitmFlowDetail>(
			`/api/mitm/flows/${encodeURIComponent(selected)}?projectId=${encodeURIComponent(projectId)}`,
			controller.signal,
		)
			.then((data) => {
				if (!controller.signal.aborted) setDetail(data);
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted) setDetailError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => controller.abort();
	}, [selected, projectId]);

	async function action(name: string, extra: Record<string, unknown> = {}) {
		if (busy || !projectId) return;
		setBusy(true);
		setError("");
		try {
			const result = await api<MitmStatus | { ok: true }>(`/api/mitm/${name}`, undefined, { ...extra, projectId });
			if (!alive.current) return;
			if ("state" in result) setStatus(result);
			if (name === "config") setDrawer(null);
			if (name === "clear") {
				setSelected(null);
				setQuery((prev) => ({ ...prev, page: 1 }));
			}
		} catch (cause) {
			if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (alive.current) {
				setBusy(false);
				setRevision((prev) => prev + 1);
			}
		}
	}

	if (!project)
		return (
			<Page title={tx("MITM 中心", "MITM Center")}>
				<Empty description={tx("请先选择项目", "Select a project first")} />
			</Page>
		);
	const port = status?.port ?? status?.config.port;
	const endpoint = mitmProxyEndpoint(status, typeof window === "undefined" ? "" : window.location.hostname);
	const download = (path: string) => `/api/mitm/${path}?${scope}`;
	return (
		<Page
			className="mitm-page"
			title={tx("MITM 中心", "MITM Center")}
			extra={
				<>
					<Button icon={<QuestionCircleOutlined />} onClick={() => setDrawer("help")}>
						{tx("接入与证书", "Setup & CA")}
					</Button>
					<Button
						icon={<SettingOutlined />}
						disabled={!status || running || busy || unavailable}
						onClick={() => {
							if (status) setConfig(status.config);
							setDrawer("settings");
						}}
					>
						{tx("代理设置", "Proxy settings")}
					</Button>
					<Button
						type="primary"
						loading={busy}
						disabled={!status || unavailable}
						onClick={() => void action(running ? "stop" : "start")}
					>
						{running ? tx("停止代理", "Stop proxy") : tx("启动代理", "Start proxy")}
					</Button>
				</>
			}
		>
			{error || pollError || status?.error ? (
				<Alert type="error" showIcon title={error || pollError || status?.error} />
			) : null}
			<Section className="mitm-connection">
				<Flex align="center" justify="space-between" gap={16} wrap>
					<Space size={16} wrap>
						<Badge
							status={running ? "processing" : unavailable ? "error" : "default"}
							text={
								running
									? tx("接收中", "Listening")
									: unavailable
										? tx("服务不可用", "Unavailable")
										: tx("已停止", "Stopped")
							}
						/>
						<Typography.Text strong>{project.name}</Typography.Text>
						<Typography.Text code copyable={endpoint ? { text: endpoint } : false}>
							{endpoint ??
								(port ? tx("未检测到主机 IP", "Host IP unavailable") : tx("启动后分配端口", "Port assigned on start"))}
						</Typography.Text>
					</Space>
					<Typography.Text type="secondary">
						{tx("HTTP 显式代理 · HTTPS 解密", "HTTP proxy · HTTPS decryption")}
					</Typography.Text>
				</Flex>
			</Section>
			<Section
				title={tx("流量记录", "Traffic")}
				extra={
					<Space>
						<Typography.Text type="secondary">{tx("实时刷新", "Live")}</Typography.Text>
						<Switch size="small" checked={live} onChange={setLive} />
						<Button
							size="small"
							type="text"
							aria-label={tx("刷新", "Refresh")}
							icon={<ReloadOutlined spin={loading} />}
							disabled={busy}
							onClick={() => setRevision((prev) => prev + 1)}
						/>
						<Popconfirm
							title={tx("清空当前项目的全部流量？", "Clear all traffic for this project?")}
							description={tx("CA 证书会保留，流量记录无法恢复。", "Keeps the CA. Deleted traffic cannot be restored.")}
							onConfirm={() => action("clear", { confirm: true })}
						>
							<Button
								size="small"
								danger
								type="text"
								disabled={!status || running || unavailable || busy || flows.total === 0}
							>
								{tx("清空记录", "Clear")}
							</Button>
						</Popconfirm>
					</Space>
				}
			>
				<Flex gap={8} wrap className="mitm-filters">
					<Input.Search
						allowClear
						placeholder={tx("搜索域名、路径或参数", "Search host, path or query")}
						aria-label={tx("搜索流量", "Search traffic")}
						value={draftSearch}
						onChange={(event) => {
							setDraftSearch(event.target.value);
							if (!event.target.value) setQuery((prev) => ({ ...prev, q: "", page: 1 }));
						}}
						onSearch={(q) => setQuery((prev) => ({ ...prev, q, page: 1 }))}
					/>
					<Select
						aria-label={tx("请求方法", "Method")}
						value={query.method}
						onChange={(method) => setQuery((prev) => ({ ...prev, method, page: 1 }))}
						options={[
							{ value: "", label: tx("全部方法", "All methods") },
							...["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT"].map((value) => ({
								value,
								label: value,
							})),
						]}
					/>
					<Select
						aria-label={tx("响应状态", "Status")}
						value={query.status}
						onChange={(value) => setQuery((prev) => ({ ...prev, status: value, page: 1 }))}
						options={[
							{ value: "", label: tx("全部状态", "All statuses") },
							...["1xx", "2xx", "3xx", "4xx", "5xx"].map((value) => ({ value, label: value })),
							{ value: "error", label: tx("连接异常", "Connection errors") },
						]}
					/>
				</Flex>
				<Table<MitmFlow>
					rowKey="id"
					size="small"
					dataSource={flows.items}
					scroll={{ x: 1100 }}
					tableLayout="fixed"
					pagination={{
						current: query.page,
						total: flows.total,
						pageSize: 50,
						showSizeChanger: false,
						showTotal: (total) => tx(`共 ${total} 条`, `${total} requests`),
						onChange: (page) => setQuery((prev) => ({ ...prev, page })),
					}}
					locale={{
						emptyText: (
							<Empty
								image={Empty.PRESENTED_IMAGE_SIMPLE}
								description={
									query.q || query.method || query.status
										? tx("没有符合条件的流量", "No matching traffic")
										: tx(
												"等待流量：将浏览器或设备的 HTTP 代理设为上方地址",
												"Waiting for traffic. Configure your device's HTTP proxy with the address above.",
											)
								}
							/>
						),
					}}
					columns={[
						{
							title: tx("时间", "Time"),
							width: 100,
							render: (_, row) => <span className="mitm-mono">{new Date(row.ts).toLocaleTimeString()}</span>,
						},
						{
							title: tx("方法", "Method"),
							dataIndex: "method",
							width: 90,
							render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
						},
						{
							title: tx("请求地址", "URL"),
							ellipsis: true,
							render: (_, row) => <MitmFlowLink flow={row} onOpen={() => setSelected(row.id)} />,
						},
						{
							title: tx("状态", "Status"),
							width: 90,
							render: (_, row) => (
								<Tag color={row.error ? "error" : row.status && row.status >= 400 ? "warning" : undefined}>
									{row.status ?? (row.error ? tx("失败", "Failed") : "—")}
								</Tag>
							),
						},
						{
							title: tx("耗时", "Duration"),
							width: 95,
							render: (_, row) => (row.durationMs == null ? "—" : `${row.durationMs} ms`),
						},
						{ title: tx("响应大小", "Response"), width: 100, render: (_, row) => bytes(row.respSize) },
					]}
				/>
			</Section>
			<Drawer
				title={tx("代理设置", "Proxy settings")}
				open={drawer === "settings"}
				onClose={() => setDrawer(null)}
				size={400}
				extra={
					<Button type="primary" loading={busy} onClick={() => void action("config", { ...config })}>
						{tx("保存", "Save")}
					</Button>
				}
			>
				<Form layout="vertical">
					<Form.Item label={tx("监听范围", "Listen on")}>
						<Select
							value={config.bind}
							onChange={(bind) => setConfig((prev) => ({ ...prev, bind }))}
							options={[
								{ value: "127.0.0.1", label: tx("仅 Docker 主机", "Docker host only") },
								{ value: "0.0.0.0", label: tx("允许局域网设备", "Allow LAN devices") },
							]}
						/>
					</Form.Item>
					<Form.Item
						label={tx("端口", "Port")}
						extra={tx(
							"填 0 自动分配；首次启动后保留该端口。",
							"Use 0 for automatic allocation. The assigned port is retained.",
						)}
					>
						<InputNumber
							min={0}
							max={65535}
							precision={0}
							value={config.port}
							onChange={(port) => setConfig((prev) => ({ ...prev, port: port ?? 0 }))}
						/>
					</Form.Item>
					<Form.Item label={tx("过滤常见静态资源", "Filter common static resources")}>
						<Switch
							checked={config.skipStatic}
							onChange={(skipStatic) => setConfig((prev) => ({ ...prev, skipStatic }))}
						/>
						<Typography.Paragraph type="secondary">
							{tx(
								"图片、音视频、字体和 CSS 不入库；保留 JS、SVG、接口、提交请求和错误响应。",
								"Skips images, media, fonts and CSS. Keeps JS, SVG, APIs, submissions and errors.",
							)}
						</Typography.Paragraph>
					</Form.Item>
					<Form.Item
						label={tx("单侧报文保存上限（MB）", "Capture limit per request / response (MB)")}
						extra={tx(
							"超出部分不保存，并在详情中标记；不因此截断转发给浏览器的报文。",
							"Excess bytes are not stored and are labelled in details. This storage limit does not truncate forwarded traffic.",
						)}
					>
						<InputNumber
							min={1}
							max={32}
							precision={0}
							value={config.maxCaptureMb}
							onChange={(maxCaptureMb) => setConfig((prev) => ({ ...prev, maxCaptureMb: maxCaptureMb ?? 2 }))}
						/>
					</Form.Item>
				</Form>
				<Typography.Paragraph type="secondary">
					{tx(
						"允许局域网后，页面将显示主机 IP 和端口；多网卡或端口转发环境请按实际网络调整。该代理没有账号认证，请通过防火墙限制可访问的设备。",
						"LAN mode displays the host IP and port. Adjust for multiple interfaces or port forwarding. This proxy has no authentication; restrict access with your firewall.",
					)}
				</Typography.Paragraph>
			</Drawer>
			<Drawer
				title={tx("接入与证书", "Setup & CA")}
				open={drawer === "help"}
				onClose={() => setDrawer(null)}
				size={480}
			>
				<ol className="mitm-help">
					<li>
						{tx(
							"启动当前项目的代理，复制页面上的地址和端口。",
							"Start the project proxy and copy its address and port.",
						)}
					</li>
					<li>
						{tx(
							"在浏览器或设备中配置 HTTP 代理；远程设备请先在代理设置中允许局域网访问。",
							"Set your browser or device's HTTP proxy. For remote devices, enable LAN access first.",
						)}
					</li>
					<li>
						{tx(
							"当前项目的工作容器会自动安装并信任 CA，容器启动或重建时自动补装。外部浏览器或设备仍需下载并安装、信任此证书。",
							"The project's work container automatically trusts this CA, including after start or recreation. External browsers and devices still need to install and trust it manually.",
						)}
					</li>
				</ol>
				<Space>
					<Button icon={<DownloadOutlined />} href={download("ca.crt")} disabled={!status?.ca}>
						{tx("下载 CA 证书", "Download CA")}
					</Button>
					<Button href={download("ca.pem")} disabled={!status?.ca}>
						PEM
					</Button>
				</Space>
				{status?.ca ? (
					<Descriptions
						className="mitm-ca"
						column={1}
						size="small"
						items={[
							{
								key: "fp",
								label: "SHA-256",
								children: (
									<Typography.Text className="mitm-fingerprint" copyable>
										{status.ca.fingerprint}
									</Typography.Text>
								),
							},
							{ key: "expires", label: tx("有效期至", "Expires"), children: status.ca.expires },
						]}
					/>
				) : (
					<Typography.Paragraph type="secondary">
						{tx(
							"首次启动后生成证书，每个项目独立。",
							"The CA is generated on first start and is unique to this project.",
						)}
					</Typography.Paragraph>
				)}
				<Typography.Paragraph type="secondary">
					{tx(
						"默认从 Docker 网络直连目标，不跟随项目的上游代理。支持 HTTP/1.1；证书锁定应用可能拒绝连接，WebSocket 仅记录隧道信息。控制台重启不会停止正在运行的代理；请在此页手动停止。",
						"Traffic uses the Docker network directly, independently of the project's upstream proxy. Supports HTTP/1.1; certificate-pinned apps may reject connections. WebSocket captures tunnel metadata only. Proxies keep running across console restarts; stop them here.",
					)}
				</Typography.Paragraph>
			</Drawer>
			<Drawer
				className="mitm-detail"
				title={tx("流量详情", "Traffic details")}
				open={selected !== null}
				onClose={() => setSelected(null)}
				size="large"
			>
				{detailError ? (
					<Alert type="error" title={detailError} />
				) : !detail ? (
					<Spin />
				) : (
					<>
						<Typography.Paragraph className="mitm-detail-url">
							<Typography.Text code>{detail.method}</Typography.Text> {detail.scheme}://{detail.host}:{detail.port}
							{detail.path}
							{detail.query ? `?${detail.query}` : ""}
						</Typography.Paragraph>
						<Space wrap>
							<Tag>{detail.status ?? "—"}</Tag>
							<Typography.Text type="secondary">{detail.durationMs ?? "—"} ms</Typography.Text>
							<Typography.Text type="secondary">{new Date(detail.ts).toLocaleString()}</Typography.Text>
						</Space>
						{detail.error || detail.note ? (
							<Typography.Paragraph type="secondary" className="mitm-detail-note">
								{detail.error ||
									detail.note.replace(
										/capture-truncated\([^)]*\)/g,
										tx(
											"报文超出保存上限，已截断保存。",
											"Message exceeded the capture limit and was truncated in storage.",
										),
									)}
							</Typography.Paragraph>
						) : null}
						<Tabs
							items={(["request", "response"] as const).map((side) => ({
								key: side,
								label: side === "request" ? tx("请求", "Request") : tx("响应", "Response"),
								children: (
									<>
										<details className="mitm-headers">
											<summary>{tx("请求 / 响应头", "Headers")}</summary>
											<dl>
												{(side === "request" ? detail.reqHeaders : detail.respHeaders).map((header, index) => (
													<div key={`${header.n}-${index}`}>
														<dt>{header.n}</dt>
														<dd>{header.v}</dd>
													</div>
												))}
											</dl>
										</details>
										<MitmRawMessage
											body={detail[side]}
											download={download(`flows/${encodeURIComponent(detail.id)}/${side}`)}
										/>
									</>
								),
							}))}
						/>
					</>
				)}
			</Drawer>
		</Page>
	);
}
