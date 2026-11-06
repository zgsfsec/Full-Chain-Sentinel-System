/**
 * The environment page.
 *
 * The console is a front end to a toolbox container, so this page answers the one
 * question that decides whether anything can run: is there a working Docker
 * daemon with the toolbox image behind it. It is also where the image gets built,
 * because a machine that has Docker but no image is the normal first-run state.
 *
 * Blocking items are listed first within their group and the page says plainly
 * that the chat is locked until they pass.
 */

import { CopyOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { Alert, Button, Col, Form, Input, Radio, Row, Select, Space, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n.ts";
import { SettingsBar, SettingsNote, SettingsSection } from "../ui/Settings.tsx";
import type {
	SentinelContainerNetwork,
	SentinelEnvItem,
	SentinelEnvReport,
	SentinelProxyConfigView,
	SentinelSources,
} from "../types.ts";
import { EnvironmentBuildButton, EnvironmentSetupGuide, environmentSetup } from "./EnvironmentSetupGuide.tsx";

const { Text } = Typography;

/** One-click Chinese mirrors; the server normalizes whatever is saved. */
const CHINA_SOURCES: SentinelSources = {
	baseImage: "docker.m.daocloud.io/kalilinux/kali-rolling:latest",
	aptMirror: "http://mirrors.tuna.tsinghua.edu.cn/kali",
	pipIndex: "https://pypi.tuna.tsinghua.edu.cn/simple",
	npmRegistry: "https://registry.npmmirror.com",
	goProxy: "https://goproxy.cn,direct",
};

const EMPTY_SOURCES: SentinelSources = {
	baseImage: "",
	aptMirror: "",
	pipIndex: "",
	npmRegistry: "",
	goProxy: "",
};

const SOURCE_FIELDS: Array<{ key: keyof SentinelSources; label: string; placeholder: string }> = [
	{
		key: "baseImage",
		label: t("基础镜像"),
		placeholder: t("kalilinux/kali-rolling:latest（可只填 registry，如 docker.m.daocloud.io）"),
	},
	{ key: "aptMirror", label: t("apt 源"), placeholder: t("http://http.kali.org/kali（官方）") },
	{ key: "pipIndex", label: t("pip 源"), placeholder: t("https://pypi.org/simple（官方）") },
	{ key: "npmRegistry", label: t("npm 源"), placeholder: t("https://registry.npmjs.org（官方）") },
	{ key: "goProxy", label: t("go 代理"), placeholder: t("https://proxy.golang.org,direct（官方）") },
];

const STATUS_COLORS: Record<SentinelEnvItem["status"], string> = {
	ok: "green",
	warn: "orange",
	fail: "red",
	skipped: "default",
};

/**
 * Build sources: the base image and the package mirrors baked into the image.
 * Mounted with a key derived from the saved values, so a save or a refresh
 * re-seeds the fields without discarding edits in progress.
 */
function SourcesForm({
	initial,
	savedAt,
	busy,
	onSave,
}: {
	initial: SentinelSources;
	savedAt: number | null;
	busy: boolean;
	onSave: (sources: SentinelSources) => void;
}) {
	const [draft, setDraft] = useState<SentinelSources>(initial);
	const dirty = SOURCE_FIELDS.some((field) => draft[field.key] !== initial[field.key]);
	const set = (key: keyof SentinelSources, value: string) => setDraft((current) => ({ ...current, [key]: value }));

	return (
		<SettingsSection
			className="settings-panel"
			title={t("构建源")}
			description={dirty ? t("有未保存的修改") : savedAt !== null ? t("已保存，重建镜像后生效") : undefined}
			extra={
				<Space size={8} wrap>
					<Button disabled={busy} onClick={() => setDraft(CHINA_SOURCES)}>
						{t("中国镜像源")}
					</Button>
					<Button disabled={busy} onClick={() => setDraft(EMPTY_SOURCES)}>
						{t("清空（用官方源）")}
					</Button>
					<Button type="primary" disabled={busy || !dirty} onClick={() => onSave(draft)}>
						{t("保存")}
					</Button>
				</Space>
			}
		>
			<SettingsNote>
				{t(
					"这些值会烘焙进工具镜像，所以保存后需要重建镜像；pip / npm / go 三项在容器内运行时（pip install、npm install、go install）同样生效。留空表示使用官方源。",
				)}
			</SettingsNote>
			<Form layout="vertical" requiredMark={false}>
				<div className="envhub-grid">
					{SOURCE_FIELDS.map((field) => (
						<Form.Item key={field.key} label={field.label}>
							<Input
								value={draft[field.key]}
								onChange={(event) => set(field.key, event.target.value)}
								placeholder={field.placeholder}
								spellCheck={false}
							/>
						</Form.Item>
					))}
				</div>
			</Form>
		</SettingsSection>
	);
}

/**
 * Container network: whether a project container shares the host's network stack
 * or keeps Docker's own. Host is the default because it is what makes a listener
 * inside the container reachable from the target, and because a real LAN, VPN and
 * internal DNS are what the tools need to see.
 */
const NETWORK_OPTIONS: Array<{ value: SentinelContainerNetwork; label: string; detail: string }> = [
	{
		value: "host",
		label: t("host（默认）"),
		detail: t(
			"容器直接用宿主机的网络：里面起的监听端口（反向 shell、payload 服务、handler）目标机器能连回来，127.0.0.1 就是宿主机（Burp、本地靶场），内网、VPN 与内网 DNS 都是真实的。代价是与宿主机抢端口，且不再有 Docker 的网络隔离。",
		),
	},
	{
		value: "bridge",
		label: t("bridge（Docker 默认隔离）"),
		detail: t(
			"容器有自己的地址，只能通过 host.docker.internal 访问宿主机，且不对外发布任何端口——目标机器连不回容器里的监听。需要隔离、也不需要反弹时用它。",
		),
	},
];

/**
 * Container network and proxy defaults, in one card.
 *
 * They are one decision: a project container either uses the host/bridge network
 * or a sidecar, and which sidecar it gets — and which image that sidecar runs —
 * is the other half of the same question. Two cards meant two saves and two
 * places to look when a container came up on the wrong network.
 *
 * The proxy fields are part of the same draft, so one 保存 commits the lot; the
 * pull button stays separate because it is an action, not a setting.
 */
function NetworkAndProxyForm({
	initial,
	savedAt,
	config,
	busy,
	pulling,
	onSave,
	onPull,
}: {
	initial: SentinelContainerNetwork;
	savedAt: number | null;
	config: SentinelProxyConfigView;
	busy: boolean;
	pulling: boolean;
	onSave: (network: SentinelContainerNetwork, defaultId: string | null, image: string) => void;
	onPull: () => void;
}) {
	const [network, setNetwork] = useState<SentinelContainerNetwork>(initial);
	const [defaultId, setDefaultId] = useState<string | null>(config?.defaultId ?? null);
	const [image, setImage] = useState(config?.image ?? "");
	const list = Array.isArray(config?.proxies) ? config.proxies : [];
	const dirty = network !== initial || defaultId !== (config?.defaultId ?? null) || image !== (config?.image ?? "");

	return (
		<SettingsSection
			className="settings-panel"
			title={t("容器网络与代理")}
			description={dirty ? t("有未保存的修改") : savedAt !== null ? t("已保存") : undefined}
			extra={
				<Space size={8} wrap>
					<Tag color={config?.imagePresent ? "green" : "orange"} variant="filled">
						{config?.imagePresent ? t("镜像已在本地") : t("镜像不在本地")}
					</Tag>
					<Button
						type="primary"
						onClick={() => onSave(network, defaultId, image)}
						loading={pulling}
						disabled={busy || pulling || (!dirty && config.imagePresent)}
					>
						{t("保存")}
					</Button>
				</Space>
			}
		>
			<SettingsNote>
				{t(
					"新项目使用独立网关，代理与节点更改立即应用，无需重建工作容器。旧项目保留原网络方式；重建一次后迁移到网关。网关使用 Docker 隔离网络，访问宿主机用 host.docker.internal，监听端口不会自动对外发布。",
				)}
			</SettingsNote>

			<Text type="secondary">{t("旧项目直连网络（仅适用于尚未迁移到网关的项目）")}</Text>
			<Radio.Group
				className="envhub-network"
				value={network}
				disabled={busy}
				onChange={(event) => setNetwork(event.target.value as SentinelContainerNetwork)}
			>
				<div className="envhub-network-grid">
					{NETWORK_OPTIONS.map((option) => (
						<Radio key={option.value} value={option.value} className="envhub-network__option">
							<Text strong>{option.label}</Text>
							<Text type="secondary" className="envhub-network__detail">
								{option.detail}
							</Text>
						</Radio>
					))}
				</div>
			</Radio.Group>

			<SettingsNote>
				{t("未单独指定代理的项目跟随默认。选「不使用」时，网关直接连接外网；已停止的项目在下次启动时应用。")}
			</SettingsNote>

			<Row gutter={[12, 12]} align="bottom">
				<Col xs={24} md={10}>
					<div className="settings-field">
						<span className="settings-field__label">{t("默认代理")}</span>
						<Select
							style={{ width: "100%" }}
							value={defaultId ?? ""}
							onChange={(value) => setDefaultId(value || null)}
							options={[
								{ value: "", label: t("不使用（新项目默认直连）") },
								...list.map((proxy) => ({ value: proxy.id, label: proxy.name })),
							]}
						/>
					</div>
				</Col>
				<Col xs={24} md={10}>
					<div className="settings-field">
						<span className="settings-field__label">{t("sing-box 镜像")}</span>
						<Input value={image} spellCheck={false} onChange={(event) => setImage(event.target.value)} />
					</div>
				</Col>
				<Col xs={24} md={4}>
					<Button block loading={pulling} disabled={busy || pulling} onClick={onPull}>
						{pulling ? t("拉取中…") : t("拉取镜像")}
					</Button>
				</Col>
			</Row>
			<SettingsNote>{t("保存时自动拉取本地缺失的代理镜像；拉取失败可更换可达的镜像源后重试。")}</SettingsNote>
		</SettingsSection>
	);
}

const STATUS_LABEL: Record<SentinelEnvItem["status"], string> = {
	ok: t("通过"),
	warn: t("警告"),
	fail: t("失败"),
	skipped: t("跳过"),
};

/** Stable group order, independent of the order the server emitted items in. */
const GROUP_ORDER = ["Docker 运行时", "工具镜像", "容器能力", "宿主环境"];

function grouped(items: SentinelEnvItem[]): { group: string; items: SentinelEnvItem[] }[] {
	const names = [...new Set([...GROUP_ORDER, ...items.map((item) => item.group)])];
	return names
		.map((group) => ({ group, items: items.filter((item) => item.group === group) }))
		.filter((entry) => entry.items.length > 0);
}

function diagnostics(report: SentinelEnvReport): string {
	const lines = [
		t("全链哨兵 环境诊断"),
		t("时间: {time}", { time: new Date(report.at).toLocaleString("zh-CN") }),
		t("地址: {url}", { url: report.url }),
		t("结论: {result}", { result: report.ok ? t("通过") : t("未通过") }),
		"",
	];
	for (const { group, items } of grouped(report.items)) {
		lines.push(`[${t(group)}]`);
		for (const item of items) {
			lines.push(`${STATUS_LABEL[item.status]}${item.blocking ? t("(阻断)") : ""} ${item.label}: ${item.detail}`);
			if (item.hint) lines.push(`  ${t("建议: {hint}", { hint: item.hint })}`);
		}
	}
	return lines.join("\n");
}

export function EnvironmentPanel({
	report,
	building,
	buildLog,
	onRefresh,
	onBuild,
	onAbortBuild,
	onSaveSources,
	sourcesSavedAt,
	networkSavedAt,
	proxyConfig,
	pullingImage,
	onSaveNetworkAndProxy,
	onPullProxyImage,
}: {
	report: SentinelEnvReport | null;
	building: boolean;
	buildLog: string[];
	onRefresh: () => void;
	onBuild: () => void;
	onAbortBuild: () => void;
	onSaveSources: (sources: SentinelSources) => void;
	sourcesSavedAt: number | null;
	/** When the network/proxy settings were last saved, for the "saved" note. */
	networkSavedAt: number | null;
	/** Profiles and the sidecar image, which the same card edits. */
	proxyConfig: SentinelProxyConfigView;
	pullingImage: boolean;
	onSaveNetworkAndProxy: (network: SentinelContainerNetwork, defaultId: string | null, image: string) => void;
	onPullProxyImage: () => void;
}) {
	const [copyNote, setCopyNote] = useState<string | null>(null);
	const [fallback, setFallback] = useState<string | null>(null);
	const [checkingReport, setCheckingReport] = useState<SentinelEnvReport | null>(null);
	const [delayedReport, setDelayedReport] = useState<SentinelEnvReport | null>(null);
	const checking = report !== null && checkingReport === report;
	const logRef = useRef<HTMLPreElement | null>(null);
	const sourcesRef = useRef<HTMLDivElement | null>(null);
	const checksRef = useRef<HTMLDivElement | null>(null);
	const showSection = (node: HTMLElement | null) => {
		node?.focus({ preventScroll: true });
		node?.scrollIntoView({ block: "start" });
	};
	const refresh = () => {
		setDelayedReport(null);
		setCheckingReport(report);
		onRefresh();
	};

	useEffect(() => {
		if (!checking) return;
		const timer = window.setTimeout(() => {
			setCheckingReport(null);
			setDelayedReport(report);
		}, 120000);
		return () => window.clearTimeout(timer);
	}, [checking, report]);

	// Keep the newest build output in view; the build streams for minutes.
	useEffect(() => {
		const node = logRef.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [buildLog]);

	const copyDiagnostics = async () => {
		if (!report) return;
		const text = diagnostics(report);
		try {
			await navigator.clipboard.writeText(text);
			setFallback(null);
			setCopyNote(t("已复制"));
		} catch {
			// Clipboard access needs a secure context; a LAN address over http is not one.
			setFallback(text);
			setCopyNote(t("复制失败，请手动选择下面的文本"));
		}
		window.setTimeout(() => setCopyNote(null), 4000);
	};

	if (!report) {
		return <Text type="secondary">{t("正在检查 Docker 环境…")}</Text>;
	}

	const { dockerReady } = environmentSetup(report);
	const warnings = report.items.filter((entry) => entry.status === "warn");
	const okCount = report.items.filter((entry) => entry.status === "ok").length;
	const failCount = report.items.filter((entry) => entry.status === "fail").length;
	const skipCount = report.items.filter((entry) => entry.status === "skipped").length;

	return (
		<>
			<SettingsBar
				meta={
					<>
						<Tag color={report.ok ? "green" : "red"} variant="filled" className="envhub-verdict">
							{report.ok ? t("环境可用") : t("环境不可用")}
						</Tag>
						<span className="settings-bar__meta">
							{t("检查于")} {new Date(report.at).toLocaleString("zh-CN")} · {report.url}
						</span>
					</>
				}
				extra={
					<>
						{copyNote ? <Text type="secondary">{copyNote}</Text> : null}
						<Button
							icon={<CopyOutlined aria-hidden="true" />}
							onClick={() => void copyDiagnostics()}
							title={t("复制全部检查项，便于排障")}
						>
							{t("复制诊断")}
						</Button>
						<Button
							icon={<ReloadOutlined aria-hidden="true" />}
							onClick={refresh}
							loading={checking}
							disabled={building}
							title={t("重新检查")}
						>
							{t("复检")}
						</Button>
						{building ? (
							<Button danger icon={<StopOutlined aria-hidden="true" />} onClick={onAbortBuild}>
								{t("中止构建")}
							</Button>
						) : (
							<EnvironmentBuildButton disabled={!dockerReady || checking} primary={report.ok} onBuild={onBuild} />
						)}
					</>
				}
			/>
			{delayedReport === report ? (
				<Alert
					type="info"
					showIcon
					title={t("环境检查耗时较长，当前仍显示上次结果。请稍后复检，并确认服务连接正常。")}
				/>
			) : null}

			{report.ok && !building ? (
				<Alert
					type="success"
					showIcon
					className="ui-page__alert"
					title={t("Docker 环境正常，工具调用会在项目容器内执行。镜像更新、切换机器或修改 Dockerfile 后回来复检即可。")}
				/>
			) : (
				<EnvironmentSetupGuide
					report={report}
					building={building}
					checking={checking}
					onBuild={onBuild}
					onRefresh={refresh}
					onShowSources={() => showSection(sourcesRef.current)}
					onShowChecks={() => showSection(checksRef.current)}
					onShowBuildLog={() => showSection(logRef.current)}
				/>
			)}

			{building || buildLog.length > 0 ? (
				<SettingsSection className="settings-panel" title={building ? t("正在构建工具镜像…") : t("上次构建输出")}>
					<pre className="envhub-buildlog envsetup-target" ref={logRef} tabIndex={-1} aria-label={t("构建输出")}>
						{buildLog.length > 0 ? buildLog.join("\n") : t("等待 docker build 输出…")}
					</pre>
				</SettingsSection>
			) : null}

			<div ref={sourcesRef} tabIndex={-1} className="envsetup-target" role="group" aria-label={t("构建源")}>
				<SourcesForm
					key={JSON.stringify(report.sources)}
					initial={report.sources}
					savedAt={sourcesSavedAt}
					busy={building}
					onSave={onSaveSources}
				/>
			</div>

			<NetworkAndProxyForm
				key={`${report.containerNetwork}|${proxyConfig?.defaultId ?? ""}|${proxyConfig?.image ?? ""}`}
				initial={report.containerNetwork}
				savedAt={networkSavedAt}
				config={proxyConfig}
				busy={building}
				pulling={pullingImage}
				onSave={onSaveNetworkAndProxy}
				onPull={onPullProxyImage}
			/>

			<div ref={checksRef} tabIndex={-1} className="envsetup-target" role="group" aria-label={t("检查结果")}>
				<SettingsSection
					className="settings-panel"
					title={t("检查结果")}
					description={t("通过 {ok} · 警告 {warn} · 失败 {fail} · 跳过 {skip}", {
						ok: okCount,
						warn: warnings.length,
						fail: failCount,
						skip: skipCount,
					})}
				>
					{grouped(report.items).map(({ group, items }) => (
						<section className="envhub-check-group" key={group}>
							<Text strong className="envhub-check-group__title">
								{t(group)}
							</Text>
							<div className="envhub-list">
								{items.map((item) => (
									<div key={item.id} className={`envhub-row status-${item.status}`}>
										<Tag color={STATUS_COLORS[item.status]} variant="filled" className="envhub-row__status">
											{STATUS_LABEL[item.status]}
										</Tag>
										<div className="envhub-row__body">
											<Space size={6} wrap>
												<Text strong>{item.label}</Text>
												{item.blocking ? (
													<Tag color="red" variant="filled">
														{t("阻断")}
													</Tag>
												) : null}
											</Space>
											<Text type="secondary">{item.detail}</Text>
											{item.hint ? <Text type="warning">{item.hint}</Text> : null}
										</div>
									</div>
								))}
							</div>
						</section>
					))}
				</SettingsSection>
			</div>

			{warnings.length > 0 ? (
				<SettingsNote>{t("警告项不影响运行，但可能让工具变慢或缺少能力，建议一并处理。")}</SettingsNote>
			) : null}

			{fallback ? (
				<SettingsSection className="settings-panel" title={t("诊断信息（手动复制）")}>
					<Input.TextArea className="envhub-diag" readOnly value={fallback} rows={12} />
				</SettingsSection>
			) : null}
		</>
	);
}
