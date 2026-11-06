import { PlusOutlined } from "@ant-design/icons";
import {
	Alert,
	Button,
	Checkbox,
	Descriptions,
	Drawer,
	Form,
	Input,
	Popconfirm,
	Segmented,
	Select,
	Space,
	Switch,
	Table,
	Tabs,
	Tag,
	Typography,
} from "antd";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import type { TableProps } from "antd";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { readFileBase64 } from "./PocPage.tsx";
import { OfficialPluginsPanel } from "./OfficialPluginsPanel.tsx";
import { PluginDevDocs } from "./PluginDevDocs.tsx";
import type {
	SentinelOfficialPluginView,
	SentinelPluginArtifactsView,
	SentinelPluginConfigField,
	SentinelPluginHostInput,
	SentinelPluginHostView,
	SentinelPluginLocality,
	SentinelPluginLogsView,
	SentinelPluginManifest,
	SentinelPluginManifestView,
	SentinelPluginNetwork,
	SentinelPluginState,
	SentinelPluginView,
	SentinelPluginsView,
} from "../types.ts";
import { t } from "../i18n.ts";
import { SettingsBar, SettingsEmpty, SettingsNote } from "../ui/Settings.tsx";

const { Text } = Typography;

const STATE_LABELS: Record<SentinelPluginState, string> = {
	running: t("运行中"),
	starting: t("启动中"),
	stopped: t("已停止"),
	failed: t("失败"),
	missing: t("缺失"),
};

const STATE_TONES: Record<SentinelPluginState, "ok" | "warn" | "bad" | "off"> = {
	running: "ok",
	starting: "warn",
	stopped: "off",
	failed: "bad",
	missing: "bad",
};

const LOCALITY_LABELS: Record<SentinelPluginLocality, string> = {
	"local-only": t("仅本地"),
	"remote-only": t("仅远端"),
	any: t("不限"),
};

const NETWORK_LABELS: Record<SentinelPluginNetwork, string> = {
	none: t("无网络"),
	bridge: t("bridge（NAT）"),
	host: t("host（宿主网络栈）"),
};

const MAX_PLUGIN_PACKAGE_BYTES = 8 * 1024 * 1024;

/** The host editor's working copy; `original` is set while editing an existing host. */
interface HostDraft {
	original?: string;
	name: string;
	url: string;
	token: string;
}

const EMPTY_HOST_DRAFT: HostDraft = { name: "", url: "", token: "" };

type DrawerTab = "config" | "logs" | "artifacts";

function formatWhen(at: number | null): string {
	if (at === null) return t("尚未连接");
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pluginKeyOf(plugin: SentinelPluginView): string {
	return `${plugin.hostId}/${plugin.manifest.id}`;
}

function StateChip({ state }: { state: SentinelPluginState }): React.ReactElement {
	const tone = STATE_TONES[state];
	return (
		<span className={`chip ${tone === "off" ? "" : tone}`}>
			<span className={`dot ${tone === "off" ? "" : tone}`} />
			{STATE_LABELS[state]}
		</span>
	);
}

/**
 * The 设置 → 插件 section.
 *
 * A plugin is one Docker image on one plugin host, mounted as an MCP server for
 * the agent. The page is a dense table plus one drawer: rows are for scanning
 * state, the drawer is where a plugin is installed, configured, started, and
 * inspected. The table stays readable with a hundred plugins; the drawer keeps
 * every destructive action one deliberate click away from a row.
 */
export function PluginPanel({
	view,
	busy,
	permissionOn,
	logs,
	artifacts,
	pendingManifest,
	notice,
	onOpenPermissions,
	onRefresh,
	onSaveHost,
	onDeleteHost,
	onTestHost,
	onInspectPackage,
	onInstall,
	onUninstall,
	onStart,
	onStop,
	onSetEnabled,
	onSaveConfig,
	onLoadLogs,
	onCloseLogs,
	onListArtifacts,
	onCloseArtifacts,
	onFetchArtifact,
	onOpenUi,
	onSetSidebar,
	officialPlugins,
	onChooseOfficial,
	buildLog,
	onLoadBuildLog,
	onCloseManifest,
}: {
	view: SentinelPluginsView;
	busy: boolean;
	/** The 权限 → MCP master switch; null while the console has not read it. */
	permissionOn: boolean | null;
	logs: SentinelPluginLogsView | null;
	artifacts: SentinelPluginArtifactsView | null;
	pendingManifest: SentinelPluginManifestView | null;
	/** One-line success message, e.g. where an artifact was saved. */
	notice: string | null;
	onOpenPermissions: () => void;
	onRefresh: () => void;
	onSaveHost: (host: SentinelPluginHostInput) => void;
	onDeleteHost: (id: string) => void;
	onTestHost: (id: string) => void;
	onInspectPackage: (name: string, data: string) => void;
	onInstall: (input: {
		hostId: string;
		manifest: SentinelPluginManifest;
		allowBuild: boolean;
		allowHostNetwork: boolean;
		allowPrivileged: boolean;
		config: Record<string, string>;
	}) => void;
	onUninstall: (hostId: string, pluginId: string, purge: boolean) => void;
	onStart: (hostId: string, pluginId: string) => void;
	onStop: (hostId: string, pluginId: string) => void;
	onSetEnabled: (hostId: string, pluginId: string, enabled: boolean) => void;
	onSaveConfig: (hostId: string, pluginId: string, values: Record<string, string>) => void;
	onLoadLogs: (hostId: string, pluginId: string) => void;
	onCloseLogs: () => void;
	onListArtifacts: (hostId: string, pluginId: string) => void;
	onCloseArtifacts: () => void;
	onFetchArtifact: (hostId: string, pluginId: string, path: string) => void;
	/** Open the plugin's own frontend, when it ships one. */
	onOpenUi: (plugin: SentinelPluginView) => void;
	/** Pin or unpin a plugin's UI on the sidebar. */
	onSetSidebar: (hostId: string, pluginId: string, pinned: boolean) => void;
	/** Official packages bundled with the console. */
	officialPlugins: SentinelOfficialPluginView[];
	onChooseOfficial: (plugin: SentinelOfficialPluginView) => void;
	/** Streaming docker build output for the install currently in progress. */
	buildLog: { hostId: string; pluginId: string; log: string } | null;
	onLoadBuildLog: (hostId: string, pluginId: string) => void;
	/** Close the install drawer by dropping the uploaded manifest. */
	onCloseManifest: () => void;
}) {
	const [hostDraft, setHostDraft] = useState<HostDraft | null>(null);
	const [packageFile, setPackageFile] = useState<{ name: string; size: number } | null>(null);
	const [packageError, setPackageError] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<"plugins" | "official" | "docs">("plugins");
	const [installHostId, setInstallHostId] = useState("");
	const [configValues, setConfigValues] = useState<Record<string, string>>({});
	const [allowBuild, setAllowBuild] = useState(false);
	const [allowHostNetwork, setAllowHostNetwork] = useState(false);
	const [allowPrivileged, setAllowPrivileged] = useState(false);
	const [installPending, setInstallPending] = useState(false);
	const installLogRef = useRef<HTMLPreElement | null>(null);
	const [editingPlugin, setEditingPlugin] = useState<string | null>(null);
	const [editValues, setEditValues] = useState<Record<string, string>>({});
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [drawerTab, setDrawerTab] = useState<DrawerTab>("config");
	const [artifactPage, setArtifactPage] = useState(0);
	const [artifactQuery, setArtifactQuery] = useState("");
	const [query, setQuery] = useState("");
	const [hostFilter, setHostFilter] = useState("all");
	const [stateFilter, setStateFilter] = useState("all");
	const fileInput = useRef<HTMLInputElement | null>(null);

	const running = view.plugins.filter((plugin) => plugin.state === "running").length;
	const failed = view.plugins.filter((plugin) => plugin.state === "failed").length;
	const localHost = view.hosts.find((host) => host.local);
	// A local host is only absent when the daemon was never started, or when it
	// answered once and then stopped; both have the same one-line fix.
	const localHostDown = !localHost || (localHost.status.at !== null && !localHost.status.ok);

	// A new manifest resets the acknowledgement boxes and the config form: the
	// declarations belong to that manifest, and a stale "host network allowed"
	// from a previous upload must never carry over.
	useEffect(() => {
		if (!pendingManifest) return;
		const next: Record<string, string> = {};
		for (const field of pendingManifest.manifest.config) {
			const value = field.default;
			next[field.key] =
				value === null ? "" : typeof value === "boolean" ? (value ? "true" : "false") : String(value);
		}
		setConfigValues(next);
		setAllowBuild(false);
		setAllowHostNetwork(false);
		setAllowPrivileged(false);
		setSelectedKey(null);
		setHostDraft(null);
	}, [pendingManifest]);

	// Keep the install target pointing at a host that still exists.
	useEffect(() => {
		if (installHostId && view.hosts.some((host) => host.id === installHostId)) return;
		setInstallHostId(view.hosts[0]?.id ?? "");
	}, [view.hosts, installHostId]);

	// The pull can take minutes; the note stays up until the page reports back
	// (or the parent's timeout releases busy).
	useEffect(() => {
		if (!busy) setInstallPending(false);
	}, [busy]);

	// Poll the host's build.log while this install is running; the host appends
	// docker build output as it arrives, so both uploads and official packages
	// show the same live log.
	useEffect(() => {
		if (!installPending || !busy || !pendingManifest || !installHostId) return;
		const pluginId = pendingManifest.manifest.id;
		const tick = () => onLoadBuildLog(installHostId, pluginId);
		tick();
		const timer = window.setInterval(tick, 1000);
		return () => window.clearInterval(timer);
	}, [busy, installHostId, installPending, onLoadBuildLog, pendingManifest]);

	useEffect(() => {
		if (!buildLog || !installLogRef.current) return;
		installLogRef.current.scrollTop = installLogRef.current.scrollHeight;
	}, [buildLog]);

	// A plugin that vanished (uninstalled here or on another console) must not
	// leave a drawer open on a row that no longer exists.
	useEffect(() => {
		if (!selectedKey) return;
		if (view.plugins.some((plugin) => pluginKeyOf(plugin) === selectedKey)) return;
		setSelectedKey(null);
		setEditingPlugin(null);
	}, [view.plugins, selectedKey]);

	const manifest = pendingManifest?.manifest ?? null;
	const selected = view.plugins.find((plugin) => pluginKeyOf(plugin) === selectedKey) ?? null;
	const drawerOpen = Boolean(pendingManifest || hostDraft || selected);

	const configComplete =
		manifest === null ||
		manifest.config.every(
			(field) => !field.required || (configValues[field.key] ?? "").trim().length > 0,
		);
	const permissionsAllowed =
		manifest === null ||
		((manifest.permissions.network !== "host" || allowHostNetwork) &&
			(!manifest.permissions.privileged || allowPrivileged));
	const installReady =
		manifest !== null && installHostId !== "" && configComplete && permissionsAllowed && allowBuild;
	const hostValid =
		hostDraft !== null &&
		hostDraft.name.trim().length > 0 &&
		hostDraft.url.trim().length > 0 &&
		(hostDraft.original !== undefined || hostDraft.token.trim().length > 0);

	const filtered = view.plugins.filter((plugin) => {
		if (hostFilter !== "all" && plugin.hostId !== hostFilter) return false;
		if (stateFilter !== "all" && plugin.state !== stateFilter) return false;
		const needle = query.trim().toLowerCase();
		if (!needle) return true;
		const haystack = [
			plugin.manifest.name,
			plugin.manifest.id,
			plugin.hostName,
			...plugin.manifest.tools.map((tool) => tool.name),
		]
			.join(" ")
			.toLowerCase();
		return haystack.includes(needle);
	});

	const closeDrawer = (): void => {
		setSelectedKey(null);
		setHostDraft(null);
		setEditingPlugin(null);
		onCloseLogs();
		onCloseArtifacts();
		if (pendingManifest) onCloseManifest();
	};

	// The drawer is modal: the page behind it must not scroll, and Escape closes it.
	useEffect(() => {
		if (!drawerOpen) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") closeDrawer();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.body.style.overflow = previous;
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [drawerOpen]);

	const openPlugin = (plugin: SentinelPluginView): void => {
		setHostDraft(null);
		setSelectedKey(pluginKeyOf(plugin));
		setEditingPlugin(null);
		setDrawerTab("config");
		setArtifactPage(0);
		setArtifactQuery("");
		onCloseLogs();
		onCloseArtifacts();
		if (pendingManifest) onCloseManifest();
	};

	const startAddHost = (): void => {
		setSelectedKey(null);
		if (pendingManifest) onCloseManifest();
		setHostDraft({ ...EMPTY_HOST_DRAFT });
	};

	const startEditHost = (host: SentinelPluginHostView): void => {
		setSelectedKey(null);
		if (pendingManifest) onCloseManifest();
		setHostDraft({ original: host.id, name: host.name, url: host.url, token: "" });
	};

	const submitHost = (): void => {
		if (!hostDraft || !hostValid) return;
		onSaveHost({
			...(hostDraft.original === undefined ? {} : { id: hostDraft.original }),
			name: hostDraft.name.trim(),
			url: hostDraft.url.trim(),
			token: hostDraft.token,
		});
		setHostDraft(null);
	};

	const choosePackage = (event: ChangeEvent<HTMLInputElement>): void => {
		const file = event.target.files?.[0];
		// Let the same file be picked again after a failed read.
		event.target.value = "";
		if (!file) return;
		setPackageError(null);
		if (file.size > MAX_PLUGIN_PACKAGE_BYTES) {
			setPackageError(t("插件包最大 {size}MB", { size: MAX_PLUGIN_PACKAGE_BYTES / (1024 * 1024) }));
			return;
		}
		void readFileBase64(file)
			.then((data) => {
				setPackageFile({ name: file.name, size: file.size });
				onInspectPackage(file.name, data);
			})
			.catch((error: unknown) => setPackageError(error instanceof Error ? error.message : String(error)));
	};

	const install = (): void => {
		if (!manifest || !installReady) return;
		const config: Record<string, string> = {};
		for (const field of manifest.config) {
			const value = configValues[field.key];
			if (value !== undefined && value !== "") config[field.key] = value;
		}
		setInstallPending(true);
		onInstall({
			hostId: installHostId,
			manifest,
			allowBuild,
			allowHostNetwork,
			allowPrivileged,
			config,
		});
	};

	const uninstall = (plugin: SentinelPluginView): void => {
		if (!window.confirm(t("卸载插件「{name}」？", { name: plugin.manifest.name }))) return;
		// A second question is the purge decision: keeping the data directory is
		// the safer default, so it is the "cancel" branch of the dialog.
		const purge = window.confirm(
			t("是否同时删除该插件的数据？\n确定 = 删除容器配置与产物；取消 = 保留数据目录。"),
		);
		onUninstall(plugin.hostId, plugin.manifest.id, purge);
		closeDrawer();
	};

	const renderConfigField = (
		field: SentinelPluginConfigField,
		value: string,
		set: (next: string) => void,
		secretHint: string,
	): React.ReactElement => {
		const hint = [field.description, field.required ? t("必填") : ""].filter(Boolean).join(" · ");
		if (field.type === "boolean") {
			return (
				<Form.Item key={field.key} extra={hint || undefined}>
					<Checkbox
						checked={value === "true"}
						disabled={busy}
						onChange={(event) => set(event.target.checked ? "true" : "false")}
					>
						{field.label}
					</Checkbox>
				</Form.Item>
			);
		}
		if (field.type === "enum") {
			return (
				<Form.Item key={field.key} label={field.label} extra={hint || undefined}>
					<Select
						value={value}
						disabled={busy}
						onChange={set}
						options={[
							{ value: "", label: field.required ? t("请选择") : t("（不设置）") },
							...field.options.map((option) => ({ value: option, label: option })),
						]}
					/>
				</Form.Item>
			);
		}
		return (
			<Form.Item key={field.key} label={field.label} extra={hint || undefined}>
				{field.type === "secret" ? (
					<Input.Password
						value={value}
						disabled={busy}
						placeholder={secretHint}
						spellCheck={false}
						autoComplete="off"
						onChange={(event) => set(event.target.value)}
					/>
				) : (
					<Input
						type={field.type === "number" ? "number" : "text"}
						step={field.type === "number" ? "any" : undefined}
						value={value}
						disabled={busy}
						spellCheck={false}
						autoComplete="off"
						onChange={(event) => set(event.target.value)}
					/>
				)}
			</Form.Item>
		);
	};

	const configInput = (field: SentinelPluginConfigField) =>
		renderConfigField(
			field,
			configValues[field.key] ?? "",
			(next) => setConfigValues((prev) => ({ ...prev, [field.key]: next })),
			t("不会回显已保存的值"),
		);

	const openConfig = (plugin: SentinelPluginView): void => {
		const key = pluginKeyOf(plugin);
		if (editingPlugin === key) {
			setEditingPlugin(null);
			return;
		}
		const next: Record<string, string> = {};
		for (const field of plugin.manifest.config) {
			if (field.type === "secret") next[field.key] = "";
			else next[field.key] = plugin.values[field.key] ?? "";
		}
		setEditValues(next);
		setEditingPlugin(key);
		setDrawerTab("config");
	};

	const editComplete = (plugin: SentinelPluginView): boolean =>
		plugin.manifest.config.every((field) => {
			if (!field.required) return true;
			if ((editValues[field.key] ?? "").trim() !== "") return true;
			// A required secret may be blank only when a value is already stored.
			return field.type === "secret" && plugin.configured.includes(field.key);
		});

	const selectedLogs =
		selected && logs && logs.hostId === selected.hostId && logs.pluginId === selected.manifest.id ? logs : null;
	const selectedArtifacts =
		selected && artifacts && artifacts.hostId === selected.hostId && artifacts.pluginId === selected.manifest.id
			? artifacts
			: null;
	const ARTIFACT_PAGE_SIZE = 10;
	const allArtifacts = selectedArtifacts?.items ?? [];
	const filteredArtifacts = allArtifacts
		.filter((artifact) => !artifactQuery || artifact.path.toLowerCase().includes(artifactQuery.toLowerCase()))
		.slice()
		.sort((left, right) => right.path.localeCompare(left.path));
	const artifactPageCount = Math.max(1, Math.ceil(filteredArtifacts.length / ARTIFACT_PAGE_SIZE));
	const artifactPageIndex = Math.min(artifactPage, artifactPageCount - 1);
	const visibleArtifacts = filteredArtifacts.slice(
		artifactPageIndex * ARTIFACT_PAGE_SIZE,
		artifactPageIndex * ARTIFACT_PAGE_SIZE + ARTIFACT_PAGE_SIZE,
	);

	return (
		<div className="mcp-page plugin-page">
			<SettingsBar
				meta={
					<Segmented
						value={activeTab}
						onChange={(value) => {
							const next = value as "plugins" | "official" | "docs";
							setActiveTab(next);
							if (next !== "plugins") closeDrawer();
						}}
						options={[
							{ value: "plugins", label: `${t("已安装")} ${view.plugins.length}` },
							{ value: "official", label: `${t("官方插件")} ${officialPlugins.length}` },
							{ value: "docs", label: t("开发文档") },
						]}
					/>
				}
				extra={
					<>
						<Button disabled={busy} onClick={onRefresh}>
							{t("刷新")}
						</Button>
						<Button
							type="primary"
							icon={<PlusOutlined />}
							disabled={busy}
							onClick={() => fileInput.current?.click()}
						>
							{t("上传插件包")}
						</Button>
						<input
							ref={fileInput}
							type="file"
							accept=".zip"
							hidden
							onChange={choosePackage}
							aria-label={t("插件包文件")}
						/>
					</>
				}
			/>

			{activeTab === "docs" ? (
				<PluginDevDocs />
			) : activeTab === "official" ? (
				<OfficialPluginsPanel
					plugins={officialPlugins}
					installed={view.plugins}
					hosts={view.hosts}
					busy={busy}
					onChoose={onChooseOfficial}
				/>
			) : (
				<>
			{notice ? <Alert type="info" showIcon className="ui-page__alert" title={notice} /> : null}

			{permissionOn === false ? (
				<Alert
					type="warning"
					showIcon
					className="ui-page__alert"
					title={t("权限未开启")}
					description={
						<Space size={6} wrap>
							<span>
								{t("「设置 → 权限」里的")} <code>MCP</code> {t("开关是关的，本页的插件都不会挂载。")}
							</span>
							<Button type="link" size="small" onClick={onOpenPermissions}>
								{t("去打开")}
							</Button>
						</Space>
					}
				/>
			) : null}

			{packageError ? <Alert type="error" showIcon className="ui-page__alert" title={packageError} /> : null}

			{view.problems.length > 0 ? (
				<Alert
					type="warning"
					showIcon
					className="ui-page__alert"
					title={t("插件目录有问题")}
					description={
						<ul className="pluginhub-problems">
							{view.problems.map((problem) => (
								<li key={problem}>{problem}</li>
							))}
						</ul>
					}
				/>
			) : null}

			<div className="plugin-hosts">
				{view.hosts.map((host) => (
					<div className="plugin-host-chip" key={host.id}>
						<span
							className={`dot ${
								host.status.at === null ? "" : host.status.ok ? "ok" : "bad"
							}`}
						/>
						<b>{host.name}</b>
						<span className="mono muted">{host.url.replace(/^https?:\/\//, "")}</span>
						{host.local ? <span className="chip">{t("自动发现")}</span> : null}
						<span className="plugin-host-chip__state">
							{host.status.at === null
								? t("未测试")
								: host.status.ok
									? t("已连接 · {when}", { when: formatWhen(host.status.at) })
									: host.status.error || t("连接失败")}
						</span>
						<Button type="link" size="small" disabled={busy} onClick={() => onTestHost(host.id)}>
							{t("测试")}
						</Button>
						{!host.local ? (
							<Button type="link" size="small" disabled={busy} onClick={() => startEditHost(host)}>
								{t("编辑")}
							</Button>
						) : null}
						{!host.local ? (
							<Button
								type="link"
								size="small"
								danger
								disabled={busy}
								onClick={() => {
									if (window.confirm(t("删除插件主机「{name}」？它上面的插件将从控制台消失。", { name: host.name }))) {
										onDeleteHost(host.id);
									}
								}}
							>
								{t("删除")}
							</Button>
						) : null}
					</div>
				))}
				<Button type="link" size="small" disabled={busy} onClick={startAddHost}>
					{t("＋ 添加主机")}
				</Button>
			</div>

			{localHostDown ? (
				<SettingsNote>
					{t("本机还没有可用的插件主机。在终端运行")} <code>sentinel-web plugin-host --local</code>
					{t("，或")} <code>npm run plugin-host -- --local</code>
					{t("，控制台会自动发现它。")}
				</SettingsNote>
			) : null}

			<ProTable<SentinelPluginView>
				className="plugin-table"
				rowKey={pluginKeyOf}
				size="small"
				dataSource={filtered}
				search={false}
				options={false}
				pagination={false}
				tableLayout="fixed"
				scroll={{ x: 1320 }}
				rowClassName={(plugin) => (selectedKey === pluginKeyOf(plugin) ? "is-selected" : "")}
				onRow={(plugin) => ({
					onClick: () => openPlugin(plugin),
					style: { cursor: "pointer" },
				})}
				toolbar={{
					title: (
						<Space size={8} wrap className="plugin-toolbar">
				<Input
					allowClear
					style={{ width: 220 }}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t("搜索插件名、id、工具名")}
					spellCheck={false}
					aria-label={t("搜索插件")}
				/>
				<Select
					style={{ width: 160 }}
					value={hostFilter}
					onChange={setHostFilter}
					options={[
						{ value: "all", label: t("全部主机") },
						...view.hosts.map((host) => ({ value: host.id, label: host.name })),
					]}
				/>
				<Select
					style={{ width: 130 }}
					value={stateFilter}
					onChange={setStateFilter}
					options={[
						{ value: "all", label: t("全部状态") },
						{ value: "running", label: t("运行中") },
						{ value: "stopped", label: t("已停止") },
						{ value: "failed", label: t("失败") },
					]}
				/>
						</Space>
					),
					actions: [
						<span key="ok" className="chip ok">{running} {t("运行")}</span>,
						...(failed > 0 ? [<span key="bad" className="chip bad">{failed} {t("失败")}</span>] : []),
					],
				}}
				columns={[
						{
							title: t("状态"),
							key: "dot",
							width: 64,
							render: (_, plugin) => (
								<span className={`dot ${STATE_TONES[plugin.state] === "off" ? "" : STATE_TONES[plugin.state]}`} />
							),
						},
						{
							title: t("插件"),
							key: "name",
							width: 300,
							render: (_, plugin) => (
								<div className="pluginhub-name">
									<Typography.Text strong>{plugin.manifest.name}</Typography.Text>
									<Typography.Text type="secondary" code>
										{plugin.manifest.id}
									</Typography.Text>
								</div>
							),
						},
						{
							title: t("版本"),
							key: "version",
							width: 90,
							render: (_, plugin) => <Typography.Text code>v{plugin.manifest.version}</Typography.Text>,
						},
						{
							title: t("主机"),
							key: "host",
							width: 140,
							render: (_, plugin) => (
								<Typography.Text type="secondary">
									{plugin.hostName}
									{plugin.hostLocal ? t("（本机）") : ""}
								</Typography.Text>
							),
						},
						{
							title: t("网络"),
							key: "network",
							width: 110,
							render: (_, plugin) => <Tag variant="filled">{plugin.manifest.permissions.network}</Tag>,
						},
						{
							title: t("工具"),
							key: "tools",
							width: 70,
							align: "right",
							render: (_, plugin) => plugin.manifest.tools.length,
						},
						{
							title: t("状态"),
							key: "state",
							width: 150,
							render: (_, plugin) => (
								<Space size={6} wrap>
									<StateChip state={plugin.state} />
									{plugin.lastError ? (
										<Tag color="red" variant="filled" title={plugin.lastError}>
											{t("有错误")}
										</Tag>
									) : null}
								</Space>
							),
						},
						{
							title: t("安装时间"),
							key: "installedAt",
							width: 160,
							render: (_, plugin) => (
								<Typography.Text type="secondary">{formatWhen(plugin.installedAt)}</Typography.Text>
							),
						},
						{
							title: t("操作"),
							key: "ops",
							width: 140,
							render: (_, plugin) => (
								<Space size={4} onClick={(event) => event.stopPropagation()}>
									<Button
										size="small"
										type="link"
										disabled={busy}
										onClick={() =>
											plugin.state === "running"
												? onStop(plugin.hostId, plugin.manifest.id)
												: onStart(plugin.hostId, plugin.manifest.id)
										}
									>
										{plugin.state === "running" ? t("停止") : t("启动")}
									</Button>
									<Button size="small" type="link" onClick={() => openPlugin(plugin)}>
										{t("详情")}
									</Button>
								</Space>
							),
						},
					]}
					locale={{
						emptyText:
							view.plugins.length === 0 ? (
								<SettingsEmpty
									title={t("还没有安装插件")}
									hint={t("点右上角「上传插件包」开始。")}
								/>
							) : (
								<SettingsEmpty title={t("没有匹配的插件")} hint={t("换个关键字或筛选条件。")} />
							),
					}}
				/>

			<SettingsNote>
				{t("工具调用不逐条拦截，只记审计；管理操作写入")} <code>plugin-audit.jsonl</code>
				{t("。启用开关只影响挂载，不会停止容器；卸载默认保留数据目录。")}
			</SettingsNote>
				</>
			)}

			<Drawer
				open={drawerOpen}
				width={760}
				onClose={closeDrawer}
				destroyOnHidden
				className="pluginhub-drawer"
				title={
					pendingManifest ? (
						<Space size={8} wrap>
							<Text strong>
								{/^(官方|Official)/.test(pendingManifest.source) ? t("安装官方插件") : t("安装插件包")}
							</Text>
							<Text type="secondary">
								{pendingManifest.source}
								{packageFile ? ` · ${formatSize(packageFile.size)}` : ""}
							</Text>
						</Space>
					) : hostDraft ? (
						<Text strong>{hostDraft.original ? t("编辑插件主机") : t("添加插件主机")}</Text>
					) : selected ? (
						<Space size={8} wrap>
							<Text strong>{selected.manifest.name}</Text>
							<Text type="secondary">v{selected.manifest.version}</Text>
							<Text type="secondary">
								{selected.manifest.id} · {selected.hostName}
								{selected.hostLocal ? t("（本机）") : ""}
							</Text>
						</Space>
					) : null
				}
				footer={
					pendingManifest ? (
						<Space size={8} className="pluginhub-foot">
							<Button onClick={closeDrawer}>{t("取消")}</Button>
							<Button type="primary" loading={busy && installPending} disabled={busy || !installReady} onClick={install}>
								{installPending && busy ? t("安装中…") : t("安装")}
							</Button>
						</Space>
					) : hostDraft ? (
						<Space size={8} className="pluginhub-foot">
							<Button onClick={() => setHostDraft(null)}>{t("取消")}</Button>
							<Button type="primary" disabled={busy || !hostValid} onClick={submitHost}>
								{t("保存")}
							</Button>
						</Space>
					) : selected ? (
						<Space size={8} wrap className="pluginhub-foot">
							<Button
								disabled={busy}
								onClick={() =>
									selected.state === "running"
										? onStop(selected.hostId, selected.manifest.id)
										: onStart(selected.hostId, selected.manifest.id)
								}
							>
								{selected.state === "running" ? t("停止") : t("启动")}
							</Button>
							<Button
								disabled={busy}
								onClick={() => {
									setDrawerTab("logs");
									onLoadLogs(selected.hostId, selected.manifest.id);
								}}
							>
								{t("日志")}
							</Button>
							<Button
								disabled={busy}
								onClick={() => {
									setDrawerTab("artifacts");
									onListArtifacts(selected.hostId, selected.manifest.id);
								}}
							>
								{t("产物")}
							</Button>
							{selected.manifest.ui ? (
								<Button
									type="primary"
									disabled={busy || selected.state !== "running"}
									title={selected.state === "running" ? t("在沙箱里打开插件界面") : t("插件未运行，先启动再打开界面")}
									onClick={() => onOpenUi(selected)}
								>
									{t("打开界面")}
								</Button>
							) : null}
							<Button danger disabled={busy} onClick={() => uninstall(selected)}>
								{t("卸载")}
							</Button>
						</Space>
					) : null
				}
			>
				{pendingManifest ? (
					<>
						<div className="pluginhub-ident">
							<span className="pluginhub-mark">{manifest?.id.slice(0, 1).toUpperCase()}</span>
							<div>
								<Text strong>
									{manifest?.name} <Text type="secondary">v{manifest?.version}</Text>
								</Text>
								<Text type="secondary">
									{manifest?.id} · {manifest?.author}
								</Text>
							</div>
						</div>

						<Descriptions
							size="small"
							column={2}
							bordered
							className="pluginhub-desc"
							items={[
								{ key: "build", label: t("构建"), children: <Text code>{manifest?.build.dockerfile}</Text> },
								{ key: "context", label: t("上下文"), children: <Text code>{manifest?.build.context}</Text> },
								{
									key: "locality",
									label: "locality",
									children: manifest ? LOCALITY_LABELS[manifest.locality] : "",
								},
								{
									key: "mcp",
									label: "MCP",
									children: (
										<Text code>
											{manifest?.mcp.port}
											{manifest?.mcp.path}
										</Text>
									),
								},
								{
									key: "source",
									label: t("源码"),
									span: 2,
									children: (
										<a href={manifest?.source} target="_blank" rel="noreferrer">
											{manifest?.source}
										</a>
									),
								},
							]}
						/>

						<Text strong className="pluginhub-section">
							{t("权限")}
						</Text>
						<Space size={6} wrap>
							<Tag variant="filled">network {manifest ? NETWORK_LABELS[manifest.permissions.network] : ""}</Tag>
							{manifest?.permissions.capAdd.map((cap) => (
								<Tag color="orange" variant="filled" key={cap}>
									{cap}
								</Tag>
							))}
							<Tag color={manifest?.permissions.privileged ? "red" : undefined} variant="filled">
								privileged {manifest?.permissions.privileged ? t("是") : t("否")}
							</Tag>
						</Space>

						<Checkbox
							className="pluginhub-ack"
							checked={allowBuild}
							disabled={busy}
							onChange={(event) => setAllowBuild(event.target.checked)}
						>
							{t("允许在插件主机上执行插件包里的 Dockerfile：构建阶段可以运行任意命令，并以宿主机 Docker 守护进程的权限访问网络。")}
						</Checkbox>
						{manifest?.permissions.network === "host" ? (
							<Checkbox
								className="pluginhub-ack"
								checked={allowHostNetwork}
								disabled={busy}
								onChange={(event) => setAllowHostNetwork(event.target.checked)}
							>
								{t("允许 host 网络：插件容器直接使用宿主网络栈，能访问本机所有监听端口。")}
							</Checkbox>
						) : null}
						{manifest?.permissions.privileged ? (
							<Checkbox
								className="pluginhub-ack"
								checked={allowPrivileged}
								disabled={busy}
								onChange={(event) => setAllowPrivileged(event.target.checked)}
							>
								{t("允许 privileged：容器获得全部 Linux 能力，隔离性显著降低。")}
							</Checkbox>
						) : null}

						{manifest && manifest.config.length > 0 ? (
							<>
								<Text strong className="pluginhub-section">
									{t("配置")}
								</Text>
								<Form layout="vertical" requiredMark={false} className="pluginhub-form">
									{manifest.config.map((field) => configInput(field))}
								</Form>
							</>
						) : null}

						<Text strong className="pluginhub-section">
							{t("目标 host")}
						</Text>
						<Select
							style={{ width: "100%" }}
							value={installHostId}
							disabled={busy || view.hosts.length === 0}
							onChange={(value) => setInstallHostId(value)}
							options={view.hosts.map((host) => ({
								value: host.id,
								label: `${host.name}${host.local ? t("（本机）") : ""}`,
							}))}
						/>
						{view.hosts.length === 0 ? <Text type="secondary">{t("先添加一个插件主机。")}</Text> : null}
						{!configComplete ? <Text type="secondary">{t("还有必填配置没有填写。")}</Text> : null}
						{!permissionsAllowed ? (
							<Text type="secondary">{t("需要先勾选上面声明的权限才能安装。")}</Text>
						) : null}
						{installPending && busy ? (
							<Text type="secondary">{t("正在构建镜像并等待健康检查，可能需要几分钟。")}</Text>
						) : null}
						{installPending || (buildLog && buildLog.pluginId === manifest?.id) ? (
							<div className="pluginhub-log">
								<Space size={8}>
									<Text strong>{t("安装日志")}</Text>
									<Text type="secondary">{busy ? t("实时") : t("已结束")}</Text>
								</Space>
								<pre className="pluginhub-pre" ref={installLogRef}>
									{buildLog && buildLog.pluginId === manifest?.id && buildLog.log
										? buildLog.log
										: t("等待 Docker 构建输出…")}
								</pre>
							</div>
						) : null}
					</>
				) : hostDraft ? (
					<>
						<Text type="secondary">
							{t("host 是运行插件容器的机器；本机 host 由 plugin-host --local 自动发现。")}
						</Text>
						<Form layout="vertical" requiredMark={false} className="pluginhub-form">
							<Form.Item label={t("名称")}>
								<Input
									value={hostDraft.name}
									disabled={busy}
									onChange={(event) =>
										setHostDraft((prev) => (prev ? { ...prev, name: event.target.value } : prev))
									}
									placeholder={t("本机 / vps-hk")}
								/>
							</Form.Item>
							<Form.Item label="URL" extra={t("非回环地址必须 HTTPS，且证书要受信任。")}>
								<Input
									value={hostDraft.url}
									disabled={busy}
									onChange={(event) =>
										setHostDraft((prev) => (prev ? { ...prev, url: event.target.value } : prev))
									}
									placeholder="https://sentinel.example.com"
									spellCheck={false}
								/>
							</Form.Item>
							<Form.Item label="token">
								<Input.Password
									value={hostDraft.token}
									disabled={busy}
									onChange={(event) =>
										setHostDraft((prev) => (prev ? { ...prev, token: event.target.value } : prev))
									}
									placeholder={hostDraft.original ? t("留空保持已保存的 token") : t("plugin-host 启动时打印的 token")}
									autoComplete="off"
								/>
							</Form.Item>
						</Form>
						<Text type="secondary">
							{t("本机 host 只需要运行")} <Text code>sentinel-web plugin-host --local</Text>
							{t("，不用手填地址与 token。")}
						</Text>
					</>
				) : selected ? (
					<>
						<Space size={10} wrap className="pluginhub-state">
							<StateChip state={selected.state} />
							<Text type="secondary">
								{selected.state === "running"
									? selected.healthy
										? t("健康")
										: t("不健康")
									: formatWhen(selected.installedAt)}
							</Text>
							<Space size={6}>
								<Switch
									size="small"
									checked={selected.enabled}
									disabled={busy}
									aria-label={t("启用 {name}", { name: selected.manifest.name })}
									onChange={(checked) => onSetEnabled(selected.hostId, selected.manifest.id, checked)}
								/>
								<Text type="secondary">{selected.enabled ? t("已挂载") : t("已停用")}</Text>
							</Space>
						</Space>

						{selected.manifest.description ? <Text>{selected.manifest.description}</Text> : null}

						<Descriptions
							size="small"
							column={2}
							bordered
							className="pluginhub-desc"
							items={[
								{
									key: "build",
									label: t("构建"),
									children: (
										<Text code>
											{selected.manifest.build.dockerfile} · {selected.manifest.build.context}
										</Text>
									),
								},
								{
									key: "port",
									label: t("端口"),
									children: (
										<Text code>{selected.hostPort === null ? t("未分配") : `127.0.0.1:${selected.hostPort}`}</Text>
									),
								},
								{
									key: "locality",
									label: "locality",
									children: LOCALITY_LABELS[selected.manifest.locality],
								},
								{ key: "installed", label: t("安装时间"), children: formatWhen(selected.installedAt) },
							]}
						/>

						{selected.lastError ? (
							<Alert type="error" showIcon className="ui-page__alert" title={selected.lastError} />
						) : null}

						<Text strong className="pluginhub-section">
							{t("权限")}
						</Text>
						<Space size={6} wrap>
							<Tag variant="filled">network {selected.manifest.permissions.network}</Tag>
							{selected.manifest.permissions.capAdd.map((cap) => (
								<Tag color="orange" variant="filled" key={cap}>
									{cap}
								</Tag>
							))}
							<Tag color={selected.manifest.permissions.privileged ? "red" : undefined} variant="filled">
								privileged {selected.manifest.permissions.privileged ? t("是") : t("否")}
							</Tag>
						</Space>

						<Text strong className="pluginhub-section">
							{t("工具")}
						</Text>
						<Space size={6} wrap>
							{selected.manifest.tools.length > 0 ? (
								selected.manifest.tools.map((tool) => <Text code key={tool.name}>{tool.name}</Text>)
							) : (
								<Text type="secondary">{t("manifest 未声明工具")}</Text>
							)}
						</Space>

						{selected.manifest.ui?.sidebar ? (
							<>
								<Text strong className="pluginhub-section">
									{t("界面")}
								</Text>
								<Space size={8} wrap>
									<Text strong>{t("显示在侧边栏")}</Text>
									<Text type="secondary">{t("在主内容区打开，和对话、工程并列")}</Text>
									<Switch
										size="small"
										checked={selected.pinned}
										disabled={busy}
										aria-label={t("显示在侧边栏")}
										onChange={(checked) => onSetSidebar(selected.hostId, selected.manifest.id, checked)}
									/>
								</Space>
							</>
						) : null}

						<Tabs
							className="pluginhub-tabs"
							activeKey={drawerTab}
							onChange={(key) => setDrawerTab(key as "config" | "logs" | "artifacts")}
							items={[
								{
									key: "config",
									label: t("配置"),
									children:
										selected.manifest.config.length === 0 ? (
											<Text type="secondary">{t("这个插件没有配置项。")}</Text>
										) : editingPlugin === pluginKeyOf(selected) ? (
											<>
												<Form layout="vertical" requiredMark={false} className="pluginhub-form">
													{selected.manifest.config.map((field) =>
														renderConfigField(
															field,
															editValues[field.key] ?? "",
															(next) => setEditValues((prev) => ({ ...prev, [field.key]: next })),
															selected.configured.includes(field.key)
																? t("已保存，留空保持不变")
																: t("尚未设置"),
														),
													)}
												</Form>
												<Text type="secondary">
													{t("保存会重建容器使新环境变量生效；密钥留空表示保持已保存的值。")}
												</Text>
												<Space size={8} className="pluginhub-actions">
													<Button disabled={busy} onClick={() => setEditingPlugin(null)}>
														{t("取消")}
													</Button>
													<Button
														type="primary"
														disabled={busy || !editComplete(selected)}
														onClick={() => {
															onSaveConfig(selected.hostId, selected.manifest.id, editValues);
															setEditingPlugin(null);
														}}
													>
														{t("保存并重启")}
													</Button>
												</Space>
											</>
										) : (
											<>
												{selected.manifest.config.map((field) => (
													<Space key={field.key} size={8} className="pluginhub-cfgrow">
														<Text code>{field.key}</Text>
														<Text type="secondary">
															{selected.configured.includes(field.key)
																? field.type === "secret"
																	? t("已设置，不回显")
																	: selected.values[field.key] || t("已设置")
																: t("未设置")}
														</Text>
													</Space>
												))}
												<Button disabled={busy} onClick={() => openConfig(selected)}>
													{t("改配置")}
												</Button>
											</>
										),
								},
								{
									key: "logs",
									label: t("日志"),
									children: (
										<>
											<Button
												disabled={busy}
												onClick={() => onLoadLogs(selected.hostId, selected.manifest.id)}
											>
												{selectedLogs ? t("刷新日志") : t("加载日志")}
											</Button>
											<pre className="pluginhub-pre">{selectedLogs?.logs || t("还没有加载日志。")}</pre>
										</>
									),
								},
								{
									key: "artifacts",
									label: t("产物"),
									children: (
										<>
											<Space size={8} wrap>
												<Input
													allowClear
													style={{ width: 240 }}
													value={artifactQuery}
													placeholder={t("筛选产物路径")}
													onChange={(event) => {
														setArtifactQuery(event.target.value);
														setArtifactPage(0);
													}}
												/>
												<Button
													disabled={busy}
													onClick={() => {
														setArtifactPage(0);
														onListArtifacts(selected.hostId, selected.manifest.id);
													}}
												>
													{selectedArtifacts ? t("刷新产物") : t("加载产物")}
												</Button>
											</Space>
											{selectedArtifacts ? (
												allArtifacts.length === 0 ? (
													<Text type="secondary">{t("还没有产物。")}</Text>
												) : filteredArtifacts.length === 0 ? (
													<Text type="secondary">{t("没有匹配「{query}」的产物。", { query: artifactQuery })}</Text>
												) : (
													<>
														<Space size={8} wrap className="pluginhub-pager">
															<Text type="secondary">
																{t("共 {count} 个", { count: filteredArtifacts.length })}
																{artifactQuery ? t("（全部 {count} 个）", { count: allArtifacts.length }) : ""}
															</Text>
															<Button
																size="small"
																disabled={artifactPageIndex === 0}
																onClick={() => setArtifactPage(artifactPageIndex - 1)}
															>
																{t("上一页")}
															</Button>
															<Text type="secondary">
																{artifactPageIndex + 1} / {artifactPageCount}
															</Text>
															<Button
																size="small"
																disabled={artifactPageIndex >= artifactPageCount - 1}
																onClick={() => setArtifactPage(artifactPageIndex + 1)}
															>
																{t("下一页")}
															</Button>
														</Space>
														{visibleArtifacts.map((artifact) => (
															<Space key={artifact.path} size={8} className="pluginhub-artifact">
																<Text code>{artifact.path}</Text>
																<Text type="secondary">{formatSize(artifact.size)}</Text>
																<Button
																	size="small"
																	type="link"
																	disabled={busy}
																	onClick={() =>
																		onFetchArtifact(selected.hostId, selected.manifest.id, artifact.path)
																	}
																>
																	{t("拉取")}
																</Button>
															</Space>
														))}
														{allArtifacts.length >= 2000 ? (
															<Text type="secondary">
																{t("最多列出 2000 个产物，更早的文件请先清理。")}
															</Text>
														) : null}
													</>
												)
											) : (
												<Text type="secondary">{t("点上面的按钮读取产物列表。")}</Text>
											)}
											<Text type="secondary">
												{t("拉取的文件保存到当前项目的")} <Text code>evidence/plugin/</Text>
												{t("下。")}
											</Text>
										</>
									),
								},
							]}
						/>
					</>
				) : null}
			</Drawer>

		</div>
	);
}
