/**
 * The 代理 page: named proxies, and the sing-box image their sidecars run.
 *
 * A profile is the whole description of one node — a SOCKS5/HTTP endpoint, or a
 * subscription whose nodes are fetched — and projects point at it by id. That
 * is why editing a profile here reaches every project that uses it, and why the
 * page says how many do: deleting one is the only action on this page that
 * changes what a running engagement will do next.
 *
 * The generated sidecar configuration is not shown here. It is the console's, not
 * the operator's: the tunnel inbound, the DNS escape and the route order are
 * decisions that only have one right answer, and the page says so instead of
 * offering them as fields.
 */

import { PlusOutlined } from "@ant-design/icons";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Select, Space, Tag, Typography } from "antd";
import { useMemo, useState } from "react";
import { t } from "../i18n.ts";
import { Page } from "../ui/Page.tsx";
import {
	AUTO_NODE_TAG,
	EMPTY_PROXY_INPUT,
	type SentinelProjectInfo,
	type SentinelProxy,
	type SentinelProxyConfigView,
	type SentinelProxyInput,
} from "../types.ts";

const { Text } = Typography;


/**
 * Whether a profile is a tunnel rather than a proxy.
 *
 * A tunnel has one exit and no nodes, so the node picker and the private-direct
 * switch do not apply to it. For OpenVPN there is a second consequence: two
 * connections with the same client certificate are the same client to the server,
 * and unless it runs with `duplicate-cn` they knock each other offline — which the
 * table warns about when more than one project picks the profile.
 */
function isTunnel(mode: SentinelProxy["mode"]): boolean {
	return mode === "wireguard" || mode === "openvpn";
}

/**
 * How a profile's traffic leaves, in one line, for the table and the project
 * dialog. Never includes a password.
 */
export function describeProfile(proxy: SentinelProxy): string {
	if (proxy.mode === "simple") {
		const { type, server, port } = proxy.simple;
		if (!server || port <= 0) return t("未配置");
		return `${type === "http" ? "HTTP" : "SOCKS5"} ${server}:${port}`;
	}
	if (proxy.mode === "wireguard") {
		const endpoint = /^\s*endpoint\s*=\s*(.+)$/im.exec(proxy.wireguard.config)?.[1]?.trim();
		return endpoint ? `WireGuard ${endpoint}` : t("未配置");
	}
	if (proxy.mode === "openvpn") {
		// Only for display: the console parses the file properly when it is saved.
		const remote = /^\s*remote\s+(\S+)(?:\s+(\d{1,5}))?/im.exec(proxy.openvpn.config);
		if (!remote?.[1]) return t("未配置");
		return `OpenVPN ${remote[1]}:${remote[2] ?? "1194"}`;
	}
	if (proxy.mode === "subscription") {
		if (proxy.nodes.length === 0) return proxy.subscription?.url ? t("订阅未拉取") : t("未配置订阅");
		const name =
			proxy.nodeTag === AUTO_NODE_TAG
				? t("自动（按延迟择优）")
				: ((proxy.nodes.find((node) => node.tag === proxy.nodeTag) ?? proxy.nodes[0])?.name ?? "");
		const every = proxy.subscription?.intervalHours
			? t(" · 每 {hours} 小时更新", { hours: proxy.subscription.intervalHours })
			: "";
		return t("{count} 个节点 · {name}", { count: proxy.nodes.length, name }) + every;
	}
	return t("未配置");
}

/** `2026-10-24 09:30` in the operator's locale, or a word for "never". */
function when(value: number): string {
	if (!value) return t("从未");
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? t("从未") : date.toLocaleString("zh-CN", { hour12: false });
}

function profileOf(proxy: SentinelProxy): SentinelProxyInput {
	return {
		id: proxy.id,
		name: proxy.name,
		mode: proxy.mode,
		simple: proxy.simple,
		wireguard: proxy.wireguard,
		openvpn: proxy.openvpn,
		subscriptionUrl: proxy.subscription?.url ?? "",
		subscriptionUserAgent: proxy.subscription?.userAgent ?? "",
		subscriptionIntervalHours: proxy.subscription?.intervalHours ?? 0,
		nodeTag: proxy.nodeTag,
		routePrivateDirect: proxy.routePrivateDirect,
	};
}

/**
 * The four exit kinds, as the editor's left rail shows them.
 *
 * The short line is the rail's second line; the full description is shown next to
 * the form, where there is room for it. Keeping both here means adding a mode is
 * one entry, not four scattered blocks.
 */
type ProxyMode = SentinelProxyInput["mode"];

interface ProxyModeCard {
	mode: ProxyMode;
	icon: string;
	label: string;
	short: string;
	kind: string;
	description: string;
}

const PROXY_MODE_CARDS: readonly ProxyModeCard[] = [
	{
		mode: "simple",
		icon: "S",
		label: "SOCKS5 / HTTP",
		short: t("一个地址端口，所有出网都走它"),
		kind: t("代理"),
		description: t("填一个地址端口，容器里所有出网流量都从它走。适合本机 Clash 或 VPS 上的 socks5/http 代理。"),
	},
	{
		mode: "subscription",
		icon: "订",
		label: t("订阅链接"),
		short: t("机场或面板地址，缓存多个节点"),
		kind: t("订阅"),
		description: t(
			"贴机场或自建面板的订阅地址，保存时拉取一次，解析出多个节点后在这里选一个。支持 base64 分享链接、Clash 与 sing-box 配置。",
		),
	},
	{
		mode: "wireguard",
		icon: "WG",
		label: "WireGuard",
		short: t("真隧道，一个出口，无节点"),
		kind: t("隧道"),
		description: t(
			"一条隧道而不是一个代理：容器里的一切（含 ping、UDP、原始套接字）都走它，但只有这一个出口，没有节点可切。",
		),
	},
	{
		mode: "openvpn",
		icon: "OV",
		label: "OpenVPN",
		short: t("真隧道，粘贴 .ovpn 与账号"),
		kind: t("隧道"),
		description: t(
			"同样是一条隧道，配置换成 .ovpn：粘贴内联证书的配置，账号密码单独填；服务器推送的 DNS 会自动用上。",
		),
	},
];

/**
 * The editor for one profile. It is a dialog rather than an inline form because a
 * node is described by up to six fields plus a JSON box, and half of them are
 * credentials: a row in a table is the wrong shape for that.
 *
 * The layout is a left rail of exit kinds and a right pane of only the selected
 * kind's fields. A single column made the four descriptions and the tunnel
 * configuration compete for the same 500px, and the dialog grew taller than the
 * viewport before the operator had typed anything.
 */
export function ProxyEditorBody({
	initial,
	busy,
	error,
	onSave,
	onCancel,
}: {
	initial: SentinelProxyInput;
	busy: boolean;
	error: string | null;
	onSave: (input: SentinelProxyInput) => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState<SentinelProxyInput>(initial);
	const patch = (next: Partial<SentinelProxyInput>) => setDraft((prev) => ({ ...prev, ...next }));
	const patchWireGuard = (changes: Partial<SentinelProxyInput["wireguard"]>) => {
		setDraft((prev) => (prev ? { ...prev, wireguard: { ...prev.wireguard, ...changes } } : prev));
	};
	const patchOpenVpn = (changes: Partial<SentinelProxyInput["openvpn"]>) => {
		setDraft((prev) => (prev ? { ...prev, openvpn: { ...prev.openvpn, ...changes } } : prev));
	};

	const patchSimple = (next: Partial<SentinelProxyInput["simple"]>) =>
		setDraft((prev) => ({ ...prev, simple: { ...prev.simple, ...next } }));
	const named = draft.name.trim().length > 0;
	const activeMode = PROXY_MODE_CARDS.find((entry) => entry.mode === draft.mode) ?? PROXY_MODE_CARDS[0];
	if (!activeMode) return null;

	return (
		<div className="proxy-editor-body">
			<div className="proxy-editor-split">
				<aside className="proxy-editor-rail" role="radiogroup" aria-label={t("出口类型")}>
					<div className="proxy-editor-rail__label">{t("出口类型")}</div>
					{PROXY_MODE_CARDS.map((entry) => (
						<label key={entry.mode} className={draft.mode === entry.mode ? "selected" : undefined}>
							<input
								type="radio"
								name="proxy-kind"
								checked={draft.mode === entry.mode}
								onChange={() => patch({ mode: entry.mode })}
							/>
							<span className="proxy-editor-mode__icon" aria-hidden="true">
								{entry.icon}
							</span>
							<span className="proxy-editor-mode__text">
								<b>{entry.label}</b>
								<small>{entry.short}</small>
							</span>
						</label>
					))}
				</aside>
				<div className="proxy-editor-main">
					<div className="proxy-editor-mode-head">
						<div>
							<h3>{activeMode.label}</h3>
							<p>{activeMode.description}</p>
						</div>
						<span className="proxy-editor-kind">{activeMode.kind}</span>
					</div>
					<label className="proxy-field">
						<span>{t("名称")}</span>
						<Input
							value={draft.name}
							placeholder={t("如 香港节点 / 本机 Clash")}
							spellCheck={false}
							autoFocus
							onChange={(event) => patch({ name: event.target.value })}
						/>
					</label>

					{draft.mode === "simple" ? (
					<div className="env-proxy-fields">
						<label>
							<span>{t("类型")}</span>
							<Select
								value={draft.simple.type}
								onChange={(value) => patchSimple({ type: value === "http" ? "http" : "socks5" })}
								options={[
									{ value: "socks5", label: "SOCKS5" },
									{ value: "http", label: "HTTP" },
								]}
							/>
						</label>
						<label>
							<span>{t("地址")}</span>
							<Input
								value={draft.simple.server}
								placeholder="127.0.0.1"
								onChange={(event) => patchSimple({ server: event.target.value })}
							/>
						</label>
						<label>
							<span>{t("端口")}</span>
							<InputNumber
								style={{ width: "100%" }}
								min={1}
								max={65535}
								value={draft.simple.port || null}
								placeholder="7890"
								onChange={(value) => patchSimple({ port: value ?? 0 })}
							/>
						</label>
						<label>
							<span>{t("用户名")}</span>
							<Input
								value={draft.simple.username}
								onChange={(event) => patchSimple({ username: event.target.value })}
							/>
						</label>
						<label>
							<span>{t("密码")}</span>
							<Input.Password
								value={draft.simple.password}
								onChange={(event) => patchSimple({ password: event.target.value })}
							/>
						</label>
						{draft.simple.type === "http" ? (
							<Checkbox
								className="env-proxy-check"
								checked={draft.simple.tls}
								onChange={(event) => patchSimple({ tls: event.target.checked })}
							>
								{t("HTTPS 上游（tls）")}
							</Checkbox>
						) : null}
					</div>
				) : draft.mode === "wireguard" ? (
					<div className="env-proxy-fields">
						<label className="env-proxy-wide">
							<span>{t("WireGuard 配置（直接粘贴 wg0.conf）")}</span>
							<Input.TextArea
								className="env-proxy-json"
								rows={10}
								value={draft.wireguard.config}
								placeholder={WIREGUARD_PLACEHOLDER}
								spellCheck={false}
								onChange={(event) => patchWireGuard({ config: event.target.value })}
							/>
						</label>
						<label className="env-proxy-wide">
							<span>{t("DNS（配置里没有 DNS = 时填这里）")}</span>
							<Input
								value={draft.wireguard.dns}
								placeholder="10.66.0.1"
								spellCheck={false}
								onChange={(event) => patchWireGuard({ dns: event.target.value })}
							/>
						</label>
						<Checkbox
							className="env-proxy-check env-proxy-wide"
							checked={draft.wireguard.killSwitch}
							onChange={(event) => patchWireGuard({ killSwitch: event.target.checked })}
						>
							{t("断线即断网（kill-switch）：隧道起来后删掉直连的默认路由，隧道掉了不会漏回宿主机网络")}
						</Checkbox>
					</div>
				) : draft.mode === "openvpn" ? (
					<div className="env-proxy-fields">
						<label className="env-proxy-wide">
							<span>{t("OpenVPN 配置（直接粘贴 .ovpn，证书要内联）")}</span>
							<Input.TextArea
								className="env-proxy-json"
								rows={10}
								value={draft.openvpn.config}
								placeholder={OPENVPN_PLACEHOLDER}
								spellCheck={false}
								onChange={(event) => patchOpenVpn({ config: event.target.value })}
							/>
						</label>
						<label>
							<span>{t("用户名")}</span>
							<Input
								value={draft.openvpn.username}
								placeholder={t("配置要求 auth-user-pass 时填")}
								spellCheck={false}
								onChange={(event) => patchOpenVpn({ username: event.target.value })}
							/>
						</label>
						<label>
							<span>{t("密码")}</span>
							<Input.Password
								value={draft.openvpn.password}
								onChange={(event) => patchOpenVpn({ password: event.target.value })}
							/>
						</label>
						<label className="env-proxy-wide">
							<span>{t("DNS（留空则用配置里的，或服务器推送的）")}</span>
							<Input
								value={draft.openvpn.dns}
								placeholder="10.8.0.1"
								spellCheck={false}
								onChange={(event) => patchOpenVpn({ dns: event.target.value })}
							/>
						</label>
						<Checkbox
							className="env-proxy-check env-proxy-wide"
							checked={draft.openvpn.killSwitch}
							onChange={(event) => patchOpenVpn({ killSwitch: event.target.checked })}
						>
							{t("断线即断网（kill-switch）：隧道起来后删掉直连的默认路由，隧道掉了不会漏回宿主机网络")}
						</Checkbox>
					</div>
				) : (
					<div className="env-proxy-fields">
						<label className="env-proxy-wide">
							<span>{t("订阅地址")}</span>
							<Input
								value={draft.subscriptionUrl}
								placeholder="https://example.com/api/v1/client/subscribe?token=..."
								spellCheck={false}
								onChange={(event) => patch({ subscriptionUrl: event.target.value })}
							/>
						</label>
						<label className="env-proxy-wide">
							<span>{t("User-Agent")}</span>
							<Input
								value={draft.subscriptionUserAgent}
								placeholder="clash.meta"
								spellCheck={false}
								onChange={(event) => patch({ subscriptionUserAgent: event.target.value })}
							/>
						</label>
						<label className="env-proxy-wide">
							<span>{t("定时更新")}</span>
							<Select
								value={String(draft.subscriptionIntervalHours)}
								onChange={(value) => patch({ subscriptionIntervalHours: Number(value) })}
								options={INTERVAL_OPTIONS.map((option) => ({
									value: String(option.hours),
									label: option.label,
								}))}
							/>
						</label>
					</div>
				)}

				{draft.mode === "wireguard" || draft.mode === "openvpn" ? null : (
					<Checkbox
						className="env-proxy-check"
						checked={draft.routePrivateDirect}
						onChange={(event) => patch({ routePrivateDirect: event.target.checked })}
					>
						{t("内网与回环地址直连，其余走代理")}
					</Checkbox>
				)}

				<p className="settings-hint">
					{draft.mode === "subscription"
						? t("保存时拉取一次订阅（换地址才会重拉），拉完用 sing-box 校验选中的节点；之后用行内的「节点」换节点、「刷新」重拉。")
						: draft.mode === "wireguard"
							? t("WireGuard 档案的容器跑 wg-quick 而不是 sing-box：隧道是真实网卡加默认路由，所以 ping、UDP、原始套接字都走隧道；只有这一个出口，没有节点可切。要走哪些网段由配置里的 AllowedIPs 决定（写 0.0.0.0/0 就是全部），没有内网直连这个开关。DNS 必填——Docker 自己的解析在隧道外。")
							: draft.mode === "openvpn"
								? t("OpenVPN 档案的容器跑 openvpn 客户端而不是 sing-box：同样是真实网卡加默认路由，所以 ping、UDP、原始套接字都走隧道。配置里的证书必须内联（引用 ca.crt 这类外部文件会被拒绝），daemon、log 与 up/down/route-up 这些脚本选项会被剥掉——控制台只运行自己的 hook。DNS 可以留空：服务器推送的解析器会自动用上。同一份证书同时只能有一个连接，要给每个项目单独一份证书就分别建档案。")
								: t("保存时自动拉取缺失的 sing-box 镜像并校验配置；拉取或校验失败时显示具体原因。")}
				</p>
				{error ? <div className="page-error">{error}</div> : null}
				</div>
			</div>
			<div className="proxy-editor-actions">
				<Button onClick={onCancel}>{t("取消")}</Button>
				<Button type="primary" loading={busy} disabled={!named} onClick={() => onSave(draft)}>
					{busy ? t("保存中…") : t("保存")}
				</Button>
			</div>
		</div>
	);
}

/** The dialog shell around the editor body. */
export function ProxyEditor({
	initial,
	busy,
	error,
	onSave,
	onCancel,
}: {
	initial: SentinelProxyInput;
	busy: boolean;
	error: string | null;
	onSave: (input: SentinelProxyInput) => void;
	onCancel: () => void;
}) {
	return (
		<Modal
			open
			width={980}
			onCancel={onCancel}
			footer={null}
			destroyOnHidden
			className="proxy-editor-dialog"
			title={
				<Space size={8}>
					<Text strong>{initial.id ? t("编辑代理") : t("新建代理")}</Text>
					<Text type="secondary">{initial.name.trim() || t("未命名")}</Text>
				</Space>
			}
		>
			<ProxyEditorBody
				initial={initial}
				busy={busy}
				error={error}
				onSave={onSave}
				onCancel={onCancel}
			/>
		</Modal>
	);
}

/** What a provider hands out, so the box shows the shape it expects. */
const WIREGUARD_PLACEHOLDER = `[Interface]
PrivateKey = ...
Address = 10.66.0.2/32
DNS = 10.66.0.1

[Peer]
PublicKey = ...
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25`;

/**
 * What a provider hands out, so the box shows the shape it expects: one file with
 * the certificates inlined, which is the only shape the console can mount.
 */
const OPENVPN_PLACEHOLDER = `client
dev tun
remote vpn.example.com 1194 udp
remote-cert-tls server
<ca>
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
</ca>
<cert>
...
</cert>
<key>
...
</key>
redirect-gateway def1`;

/** Refresh intervals the operator can pick. 0 is "only when I press refresh". */
const INTERVAL_OPTIONS: ReadonlyArray<{ hours: number; label: string }> = [
	{ hours: 0, label: t("不自动更新") },
	{ hours: 1, label: t("每 1 小时") },
	{ hours: 6, label: t("每 6 小时") },
	{ hours: 12, label: t("每 12 小时") },
	{ hours: 24, label: t("每 24 小时") },
	{ hours: 72, label: t("每 3 天") },
];



/**
 * The nodes of one subscription, and which of them the profile routes through.
 *
 * A provider hands out tens or hundreds of them, and the operator picks one; the
 * list is the whole interaction, so it scrolls rather than paginating. Nodes the
 * parser could not use are listed underneath with the reason, because "why is my
 * node missing" is the question this dialog would otherwise leave unanswered.
 */
export function ProxyNodeDialogBody({
	proxy,
	busy,
	refreshing,
	testing,
	testUrl,
	onPick,
	onRefresh,
	onTest,
	onClose,
}: {
	proxy: SentinelProxy;
	busy: boolean;
	refreshing: boolean;
	testing: boolean;
	testUrl: string;
	onPick: (nodeTag: string) => void;
	onRefresh: () => void;
	/** Measure every node against this URL. */
	onTest: (url: string) => void;
	onClose: () => void;
}) {
	const nodes = Array.isArray(proxy.nodes) ? proxy.nodes : [];
	const [url, setUrl] = useState(testUrl);
	/** Set by a test, so the fastest node is at the top; the provider's order is kept until then. */
	const [byLatency, setByLatency] = useState(false);
	const tested = nodes.some((node) => node.testedAt !== undefined);
	const ordered = byLatency
		? [...nodes].sort((left, right) => {
				// A node that timed out sorts last, after every measured one.
				const a = left.latencyMs ?? Number.MAX_SAFE_INTEGER;
				const b = right.latencyMs ?? Number.MAX_SAFE_INTEGER;
				return a - b;
			})
		: nodes;

	return (
		<div className="proxynode-body">
			<p className="settings-hint">
				{proxy.subscription?.updatedAt
					? t("上次拉取：{when}", { when: when(proxy.subscription.updatedAt) })
					: t("还没有成功拉取过")}
				{proxy.subscription?.error ? ` · ${proxy.subscription.error}` : ""}
			</p>
			<p className="settings-hint">
				{t("换节点或刷新后，运行中的网关项目立即应用；已停止的项目在下次启动时应用。旧项目需重建一次迁移到网关。")}
			</p>
			<label className="proxy-test-url">
				<span>{t("测速地址")}</span>
				<Input
					value={url}
					spellCheck={false}
					placeholder="https://www.gstatic.com/generate_204"
					onChange={(event) => setUrl(event.target.value)}
				/>
			</label>
			<p className="settings-hint">
				{t("测速是从每个节点真实访问这个地址（返回 204 的地址最准），不是只连端口；结果会显示在节点右侧。")}
			</p>
			{nodes.length === 0 ? (
				<div className="ws-empty">
					<span>{t("这个订阅还没有节点")}</span>
					<span>{t("点「刷新订阅」拉取一次")}</span>
				</div>
			) : (
				<div className="proxy-node-list">
					<label className={proxy.nodeTag === AUTO_NODE_TAG ? "selected" : undefined}>
						<input
							type="radio"
							name="proxy-node"
							checked={proxy.nodeTag === AUTO_NODE_TAG}
							disabled={busy}
							onChange={() => onPick(AUTO_NODE_TAG)}
						/>
						<span className="proxy-node__name">{t("自动（按延迟择优）")}</span>
						<span className="proxy-node__meta">
							<span className="proxy-node__protocol">{t("sing-box 每 3 分钟测一次")}</span>
						</span>
					</label>
					{ordered.map((node) => (
						<label key={node.tag} className={node.tag === proxy.nodeTag ? "selected" : undefined}>
							<input
								type="radio"
								name="proxy-node"
								checked={node.tag === proxy.nodeTag}
								disabled={busy}
								onChange={() => onPick(node.tag)}
							/>
							<span className="proxy-node__name">{node.name}</span>
							<span className="proxy-node__meta">
								{node.latencyMs === undefined ? (
									<span className="proxy-node__protocol">{node.protocol}</span>
								) : node.latencyMs === null ? (
									<span className="proxy-latency bad">{t("超时")}</span>
								) : (
									<span className={`proxy-latency${node.latencyMs > 800 ? " slow" : ""}`}>
										{node.latencyMs} ms
									</span>
								)}
							</span>
						</label>
					))}
				</div>
			)}
			{tested && !byLatency ? (
				<Button size="small" onClick={() => setByLatency(true)}>
					{t("按延迟排序")}
				</Button>
			) : null}
			{proxy.skipped.length > 0 ? (
				<>
					<p className="settings-hint">{t("以下节点没能解析，已跳过：")}</p>
					<ul className="proxy-skipped">
						{proxy.skipped.slice(0, 12).map((entry, index) => (
							<li key={`${entry.name}-${index}`}>
								<code>{entry.name || t("未命名")}</code> {entry.reason}
							</li>
						))}
					</ul>
				</>
			) : null}
			<Space size={8} className="proxynode-actions">
				<Button onClick={onClose}>{t("关闭")}</Button>
				<Button loading={refreshing} disabled={refreshing} onClick={onRefresh}>
					{refreshing ? t("拉取中…") : t("刷新订阅")}
				</Button>
				<Button
					type="primary"
					loading={testing}
					disabled={testing || nodes.length === 0}
					onClick={() => {
						setByLatency(true);
						onTest(url.trim());
					}}
				>
					{testing ? t("测速中…") : t("批量测速")}
				</Button>
			</Space>
		</div>
	);
}

/** The dialog shell around the node picker. */
export function ProxyNodeDialog(props: {
	proxy: SentinelProxy;
	busy: boolean;
	refreshing: boolean;
	testing: boolean;
	testUrl: string;
	onPick: (nodeTag: string) => void;
	onRefresh: () => void;
	onTest: (url: string) => void;
	onClose: () => void;
}) {
	return (
		<Modal
			open
			width={720}
			onCancel={props.onClose}
			footer={null}
			destroyOnHidden
			title={
				<Space size={8}>
					<Text strong>{t("节点")}</Text>
					<Text type="secondary">{props.proxy.name}</Text>
				</Space>
			}
		>
			<ProxyNodeDialogBody {...props} />
		</Modal>
	);
}

/**
 * The connectivity test of one profile.
 *
 * The result belongs to the profile rather than to this dialog, so closing it and
 * reopening later shows the last run instead of an empty box. The URL is editable
 * because a split tunnel has no useful public target: what "works" means depends on
 * which destinations the configuration actually routes into the tunnel.
 */
export function ProxyTestDialogBody({
	proxy,
	testUrl,
	busy,
	runningUses,
	onTest,
	onClose,
}: {
	proxy: SentinelProxy;
	testUrl: string;
	busy: boolean;
	/** Running projects on this profile; only a tunnel can be disturbed by a test. */
	runningUses: number;
	/** Run the test; resolves with a request-level error, not a failed result. */
	onTest: (id: string, url: string) => Promise<string | null>;
	onClose: () => void;
}) {
	const [url, setUrl] = useState(proxy.test?.url ?? testUrl);
	const [testing, setTesting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const result = proxy.test;
	const tunnel = isTunnel(proxy.mode);

	const run = async () => {
		setError(null);
		setTesting(true);
		const message = await onTest(proxy.id, url.trim());
		setTesting(false);
		if (message) setError(message);
	};

	return (
		<div className="proxytest-body">
			<p className="settings-hint">
				{tunnel
					? t("测试会启动一个临时隧道容器，真的建起网卡后从隧道里访问测试地址，测完即删。分流的 AllowedIPs / 服务器路由不覆盖这个地址时，它本来就不走隧道，请换成隧道内可达的地址。")
					: t("测试会启动一个临时 sing-box 容器，用这个档案自己的出站真实访问测试地址，测完即删。返回 204 的地址最准。")}
			</p>
			{tunnel && runningUses > 0 ? (
				<p className="proxy-test-warning">
					{t("这个档案正被 {count} 个运行中的项目使用：测试会用同一份证书或密钥再连一次，可能让它们的隧道短暂中断（OpenVPN 未开 duplicate-cn 时会被踢下线）。", {
						count: runningUses,
					})}
				</p>
			) : null}
			<label className="proxy-test-url">
				<span>{t("测试地址")}</span>
				<Input
					value={url}
					spellCheck={false}
					placeholder="https://www.gstatic.com/generate_204"
					onChange={(event) => setUrl(event.target.value)}
				/>
			</label>
			{result ? (
				<div className={`proxy-test-result ${result.ok ? "ok" : "bad"}`}>
					<strong>
						{result.ok ? t("连接正常") : t("测试失败")}
						{result.ok && result.latencyMs !== null ? ` · ${result.latencyMs} ms` : ""}
					</strong>
					{result.error ? <span className="proxy-test-result__error">{result.error}</span> : null}
					<span className="proxy-test-result__meta">
						{t("上次测试：{when} · {url}", { when: when(result.testedAt), url: result.url })}
					</span>
				</div>
			) : (
				<p className="settings-hint">{t("还没有测试过")}</p>
			)}
			{error ? <Alert type="error" showIcon title={error} className="ui-page__alert" /> : null}
			<Space size={8} className="proxytest-actions">
				<Button onClick={onClose}>{t("关闭")}</Button>
				<Button type="primary" loading={testing} disabled={busy || testing} onClick={() => void run()}>
					{testing ? t("测试中…") : result ? t("重新测试") : t("开始测试")}
				</Button>
			</Space>
		</div>
	);
}

/** The dialog shell around the connectivity test. */
export function ProxyTestDialog(props: {
	proxy: SentinelProxy;
	testUrl: string;
	busy: boolean;
	runningUses: number;
	onTest: (id: string, url: string) => Promise<string | null>;
	onClose: () => void;
}) {
	return (
		<Modal
			open
			width={640}
			onCancel={props.onClose}
			footer={null}
			destroyOnHidden
			title={
				<Space size={8}>
					<Text strong>{t("测试代理")}</Text>
					<Text type="secondary">{props.proxy.name}</Text>
				</Space>
			}
		>
			<ProxyTestDialogBody {...props} />
		</Modal>
	);
}

export function ProxyPage({
	config,
	projects,
	busy,
	onSave,
	onDelete,
	onRefreshSubscription,
	onSetNode,
	onTestNodes,
	onTestConnection,
	refreshingId,
	testingId,
}: {
	config: SentinelProxyConfigView;
	/** Only used to count how many projects a profile reaches. */
	projects: SentinelProjectInfo[];
	busy: boolean;
	onSave: (input: SentinelProxyInput) => Promise<string | null>;
	onDelete: (id: string) => Promise<string | null>;
	onRefreshSubscription: (id: string) => Promise<string | null>;
	onSetNode: (id: string, nodeTag: string) => Promise<string | null>;
	onTestNodes: (id: string, url: string) => Promise<string | null>;
	/** Fetch a URL through one profile's exit and store the result. */
	onTestConnection: (id: string, url: string) => Promise<string | null>;
	/** The profile whose subscription is being re-read right now. */
	refreshingId: string | null;
	/** The profile whose nodes are being measured right now. */
	testingId: string | null;
}) {
	const [editing, setEditing] = useState<SentinelProxyInput | null>(null);
	const [deleting, setDeleting] = useState<SentinelProxy | null>(null);
	const [picking, setPicking] = useState<string | null>(null);
	const [checking, setChecking] = useState<string | null>(null);
	const [testing, setTesting] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const list = Array.isArray(config?.proxies) ? config.proxies : [];
	const uses = useMemo(() => {
		const counts = new Map<string, number>();
		const fallback = list.find((entry) => entry.id === config?.defaultId)?.id;
		for (const project of Array.isArray(projects) ? projects : []) {
			// A project with no choice of its own counts against whichever profile is
			// the default, because deleting that one would move it.
			const id = project.proxyId === undefined ? fallback : (project.proxyId ?? undefined);
			if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
		}
		return counts;
	}, [list, projects, config?.defaultId]);
	/**
	 * The projects that are connected right now. A tunnel test opens a second
	 * connection with the same key or certificate, so these are the ones it can
	 * disturb; a stopped project has no tunnel to lose.
	 */
	const runningUses = useMemo(() => {
		const counts = new Map<string, number>();
		const fallback = list.find((entry) => entry.id === config?.defaultId)?.id;
		for (const project of Array.isArray(projects) ? projects : []) {
			if (project.state !== "running") continue;
			const id = project.proxyId === undefined ? fallback : (project.proxyId ?? undefined);
			if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
		}
		return counts;
	}, [list, projects, config?.defaultId]);

	const save = async (input: SentinelProxyInput) => {
		setError(null);
		const message = await onSave(input);
		if (message) {
			setError(message);
			return;
		}
		setEditing(null);
	};

	const refresh = async (proxy: SentinelProxy) => {
		setError(null);
		const message = await onRefreshSubscription(proxy.id);
		if (message) setError(message);
	};

	const testNodes = async (proxy: SentinelProxy, url: string) => {
		setError(null);
		setTesting(proxy.id);
		const message = await onTestNodes(proxy.id, url);
		setTesting(null);
		if (message) setError(message);
	};

	const pickNode = async (proxy: SentinelProxy, nodeTag: string) => {
		setError(null);
		const message = await onSetNode(proxy.id, nodeTag);
		if (message) setError(message);
		else setPicking(null);
	};

	const remove = async (proxy: SentinelProxy) => {
		setError(null);
		const message = await onDelete(proxy.id);
		if (message) {
			setError(message);
			return;
		}
		setDeleting(null);
	};

	const columns: ProColumns<SentinelProxy>[] = [
		{
			title: t("名称"),
			key: "name",
			render: (_, proxy) => (
				<div className="proxyhub-name">
					<Space size={6} wrap>
						<Text strong>{proxy.name}</Text>
						{proxy.id === config?.defaultId ? (
							<Tag color="blue" variant="filled">
								{t("默认")}
							</Tag>
						) : null}
					</Space>
					<Text type="secondary">{describeProfile(proxy)}</Text>
					{proxy.test ? (
						<Tag
							color={proxy.test.ok ? "green" : "red"}
							variant="filled"
							title={proxy.test.error ?? undefined}
						>
							{proxy.test.ok
								? proxy.test.latencyMs === null
									? t("连接正常")
									: `${proxy.test.latencyMs} ms`
								: t("测试失败")}
						</Tag>
					) : null}
				</div>
			),
		},
		{
			title: t("出口"),
			key: "kind",
			width: 130,
			render: (_, proxy) => (
				<Tag variant="filled">
					{proxy.mode === "subscription"
						? t("订阅")
						: proxy.mode === "wireguard"
							? "WireGuard"
							: proxy.mode === "openvpn"
								? "OpenVPN"
								: t("普通代理")}
				</Tag>
			),
		},
		{
			title: t("项目"),
			key: "uses",
			width: 150,
			render: (_, proxy) => {
				const count = uses.get(proxy.id) ?? 0;
				return (
					<Space size={6}>
						<Text className="proxyhub-num">{count}</Text>
						{isTunnel(proxy.mode) && count > 1 ? (
							<Tag
								color="orange"
								variant="filled"
								title={t("同一份证书同时只能有一个连接：除非服务器开了 duplicate-cn，两个项目一起用会被互相踢下线。要给每个项目单独一份证书，请分别建档案。")}
							>
								{t("证书共用")}
							</Tag>
						) : null}
					</Space>
				);
			},
		},
		{
			title: t("内网直连"),
			key: "direct",
			width: 110,
			render: (_, proxy) => (
				<Text type="secondary">
					{isTunnel(proxy.mode) ? "—" : proxy.routePrivateDirect ? t("是") : t("否")}
				</Text>
			),
		},
		{
			title: t("操作"),
			key: "actions",
			width: 200,
			render: (_, proxy) => (
				<Space size={4}>
					{proxy.mode === "subscription" ? (
						<Button
							size="small"
							type="link"
							disabled={busy}
							title={t("选一个节点，或刷新订阅")}
							onClick={() => {
								setError(null);
								setPicking(proxy.id);
							}}
						>
							{t("节点")}
						</Button>
					) : (
						<Button
							size="small"
							type="link"
							disabled={busy}
							title={t("从这个档案真实访问一个地址，确认它还能用")}
							onClick={() => {
								setError(null);
								setChecking(proxy.id);
							}}
						>
							{t("测试")}
						</Button>
					)}
					<Button
						size="small"
						type="link"
						onClick={() => {
							setError(null);
							setEditing(profileOf(proxy));
						}}
					>
						{t("编辑")}
					</Button>
					<Button
						size="small"
						type="link"
						danger
						onClick={() => {
							setError(null);
							setDeleting(proxy);
						}}
					>
						{t("删除")}
					</Button>
				</Space>
			),
		},
	];

	return (
		<Page
			title={t("代理")}
			description={t("{count} 个", { count: list.length })}
			extra={
				<Button
					type="primary"
					icon={<PlusOutlined />}
					disabled={busy}
					onClick={() => {
						setError(null);
						setEditing({ ...EMPTY_PROXY_INPUT });
					}}
				>
					{t("新建代理")}
				</Button>
			}
		>
			{error ? <Alert type="error" showIcon title={error} className="ui-page__alert" /> : null}

			<ProTable<SentinelProxy>
				rowKey="id"
				size="small"
				columns={columns}
				dataSource={list}
				search={false}
				options={false}
				pagination={false}
				scroll={{ x: 900 }}
				locale={{
					emptyText: (
						<div className="proxyhub-empty">
							<Text strong>{t("还没有代理")}</Text>
							<Text type="secondary">{t("新建一个之后，项目才能把出网流量交给它")}</Text>
						</div>
					),
				}}
			/>

			<Text type="secondary" className="proxyhub-note">
				{t("项目按档案共享代理配置，运行中的网关会自动应用更改，无需重建工作容器。")}
			</Text>

			{editing ? (
				<ProxyEditor
					initial={editing}
					busy={busy}
					error={error}
					onSave={(input) => void save(input)}
					onCancel={() => {
						setEditing(null);
						setError(null);
					}}
				/>
			) : null}

			{picking ? (
				(() => {
					const proxy = list.find((entry) => entry.id === picking);
					if (!proxy) return null;
					return (
						<ProxyNodeDialog
							proxy={proxy}
							busy={busy}
							refreshing={refreshingId === proxy.id}
							testing={testing === proxy.id}
							testUrl={config?.testUrl ?? ""}
							onPick={(nodeTag) => void pickNode(proxy, nodeTag)}
							onRefresh={() => void refresh(proxy)}
							onTest={(url) => void testNodes(proxy, url)}
							onClose={() => setPicking(null)}
						/>
					);
				})()
			) : null}

			{checking ? (
				(() => {
					const proxy = list.find((entry) => entry.id === checking);
					if (!proxy) return null;
					return (
						<ProxyTestDialog
							proxy={proxy}
							busy={busy}
							testUrl={config?.testUrl ?? ""}
							runningUses={runningUses.get(proxy.id) ?? 0}
							onTest={onTestConnection}
							onClose={() => setChecking(null)}
						/>
					);
				})()
			) : null}

			<Modal
				open={deleting !== null}
				title={t("删除代理")}
				okText={t("确认删除")}
				okButtonProps={{ danger: true, disabled: busy }}
				cancelText={t("取消")}
				onOk={() => {
					if (deleting) void remove(deleting);
				}}
				onCancel={() => setDeleting(null)}
			>
				<Text>
					{t("删除后，用到它的项目会回到「跟随默认」；运行中的网关立即切换出口，已有连接可能中断。")}
					{uses.get(deleting?.id ?? "") ? ` ${t("当前有 {count} 个项目用它。", { count: uses.get(deleting?.id ?? "") ?? 0 })}` : ""}
				</Text>
			</Modal>
		</Page>
	);
}
