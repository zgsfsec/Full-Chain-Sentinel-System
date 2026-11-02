/**
 * The permissions page.
 *
 * Two columns of switches, one per agent, plus a read-only inventory of what the
 * live session actually mounted. The inventory matters: the switches are
 * enforced by dropping tools at registration, so the only way to be sure they
 * did what they say is to look at the result.
 *
 * A sub-agent can never hold a tool the main agent does not have, so a switch
 * the main agent turned off is shown disabled here rather than silently
 * ignored.
 *
 * The MCP switch opens into one switch per configured server, because "MCP on"
 * is too coarse to be useful: an operator who wants the local filesystem server
 * but not the one holding production credentials has no way to say so with a
 * single switch.
 *
 * Installed plugins are MCP servers too, but they come from the plugin host
 * rather than `mcp.json`, so they get their own section instead of hiding among
 * the servers. One row per plugin, one switch per agent: a plugin is mounted for
 * an agent or it is not, and "not mounted" means the server never connects.
 */

import { ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { ProTable } from "@ant-design/pro-components";
import {
	Alert,
	Button,
	InputNumber,
	List,
	Space,
	Switch,
	Tag,
	Tooltip,
	Typography,
} from "antd";
import { useEffect, useState } from "react";
import { t } from "../i18n.ts";
import { SettingsBar, SettingsNote, SettingsSection } from "../ui/Settings.tsx";
import type {
	SentinelCommanderPermissionKey,
	SentinelMcpServerView,
	SentinelPermissionKey,
	SentinelPermissionPreset,
	SentinelPermissionSet,
	SentinelPermissionsConfig,
	SentinelPluginsView,
	SentinelToolInfo,
} from "../types.ts";
import { mcpServerState, mountReason, TRANSPORT_LABELS } from "./McpPanel.tsx";

const { Text } = Typography;

/** Order and wording of the switches; spawn_agent is main-agent only. */
const SWITCHES: { key: SentinelPermissionKey; label: string; hint: string; subagent: boolean }[] = [
	{ key: "read", label: "read", hint: t("读取工作目录中的文件内容"), subagent: true },
	{ key: "bash", label: "bash", hint: t("在项目容器内执行命令（审批模式仍逐条确认）"), subagent: true },
	{ key: "edit", label: "edit", hint: t("对已有文件做精确文本替换"), subagent: true },
	{ key: "write", label: "write", hint: t("新建或整体覆盖文件"), subagent: true },
	{ key: "codemode", label: "codemode", hint: t("脚本编排，只能调用上面已允许的工具"), subagent: true },
	{ key: "tool_search", label: "tool_search", hint: t("检索并加载尚未声明的工具，禁用的搜不到"), subagent: true },
	{
		key: "mcp",
		label: "MCP",
		hint: t("连接「设置 → MCP」中配置的服务器并使用它们的工具（项目目录与配置目录里的 mcp.json 都不读）"),
		subagent: true,
	},
	{ key: "spawn_agent", label: "spawn_agent", hint: t("派生子代理并行执行；子代理永远不能再派生"), subagent: false },
	{
		key: "vuln_submit",
		label: "vuln_submit",
		hint: t("把已验证的漏洞提交到当前项目的漏洞中枢（原始数据包与评分一并提交）"),
		subagent: true,
	},
	{
		key: "vuln_read",
		label: "vuln_list / vuln_get",
		hint: t("查询当前项目已记录的漏洞，避免重复提交并在总结中引用编号"),
		subagent: true,
	},
	{
		key: "asset_library_write",
		label: "asset_report / asset_note",
		hint: t("把实际接触过的域名、IP、端口服务与 URL 上报到资产库，并追加测试记录（同一资产自动合并）"),
		subagent: true,
	},
	{
		key: "asset_library_read",
		label: "asset_list / asset_get",
		hint: t("查询当前项目已收录的资产与测试记录，避免重复上报"),
		subagent: true,
	},
	{
		key: "poc_read",
		label: "poc_search / poc_read",
		hint: t("检索 POC 库（只读参考：模板不进容器，要执行需自己写 yaml 后用 bash 跑 nuclei）"),
		subagent: true,
	},
	{
		key: "mitm_read",
		label: "mitm_flows / mitm_flow_get / mitm_flow_read",
		hint: t("只读查询会话所属项目的 MITM 流量，支持筛选与分段读取；不能启停代理、修改配置或清空记录"),
		subagent: true,
	},
	{
		key: "asset_read",
		label: "fofa_search / quake_search / hunter_search",
		hint: t("用 FOFA / 360 Quake / 奇安信 Hunter 做互联网资产测绘（设置 → 资产测绘 管理平台与密钥）"),
		subagent: true,
	},
	{
		key: "web_search",
		label: "web_search / web_extract",
		hint: t("用 Tavily 号池做公网 Web 搜索与页面抓取（设置 → Web 搜索 管理 Key，按剩余额度自动轮换）"),
		subagent: true,
	},
];

const SUBAGENT_SWITCHES = SWITCHES.filter((item) => item.subagent);

/** The engineering-mode commander's switches: its scheduling tools are always mounted. */
const COMMANDER_SWITCHES: { key: SentinelCommanderPermissionKey; label: string; hint: string }[] = [
	{
		key: "bash",
		label: t("bash（受限）"),
		hint: t("项目容器内执行命令，仅用于拆解任务前的一次性轻量确认；受每工程 40 条预算、单条 20 秒超时、输出截断与破坏性命令拦截约束"),
	},
	{ key: "read", label: "read", hint: t("读取项目工作目录中的文件（只读，不能修改）") },
];

function SwitchRow({
	label,
	hint,
	checked,
	disabled,
	onChange,
	tooltip,
}: {
	label: React.ReactNode;
	hint: string;
	checked: boolean;
	disabled?: boolean;
	onChange: () => void;
	tooltip?: string;
}) {
	return (
		<div className="permhub-row">
			<div className="permhub-row__text">
				<Text code className="permhub-row__name">
					{label}
				</Text>
				<Text type="secondary" className="permhub-row__hint">
					{hint}
				</Text>
			</div>
			<Tooltip title={tooltip}>
				<Switch size="small" checked={checked} disabled={disabled} onChange={onChange} />
			</Tooltip>
		</div>
	);
}

export function PermissionsPanel({
	config,
	presets,
	tools,
	mcpServers,
	plugins,
	mcpBusy,
	busy,
	onSave,
	onRefresh,
	onToggleMcpServer,
}: {
	config: SentinelPermissionsConfig;
	presets: SentinelPermissionPreset[];
	tools: SentinelToolInfo[];
	/**
	 * The custom MCP servers, so the MCP switch can be narrowed to individual ones.
	 * Null until the MCP view arrives, which is a different state from "none configured".
	 */
	mcpServers: SentinelMcpServerView[] | null;
	/**
	 * Installed plugins, which are MCP servers owned by the plugin center rather
	 * than by `mcp.json`. Null until the plugin view arrives.
	 */
	plugins: SentinelPluginsView | null;
	/** A per-server switch is in flight; it rebuilds sessions like a save does. */
	mcpBusy: boolean;
	busy: boolean;
	onSave: (config: SentinelPermissionsConfig) => void;
	onRefresh: () => void;
	onToggleMcpServer: (name: string, enabled: boolean) => void;
}) {
	const [draft, setDraft] = useState<SentinelPermissionsConfig>(config);

	// Follow the server whenever it reports a different configuration, so a save
	// from another window (or a rejected save) cannot leave stale switches here.
	useEffect(() => {
		setDraft(config);
	}, [config]);

	const dirty = JSON.stringify(draft) !== JSON.stringify(config);

	const toggle = (agent: "main" | "subagent", key: SentinelPermissionKey) => {
		setDraft((prev) => {
			const next: SentinelPermissionsConfig = {
				main: { ...prev.main },
				subagent: { ...prev.subagent },
				commander: { ...prev.commander },
				subagentMaxTurns: prev.subagentMaxTurns,
				plugins: prev.plugins,
			};
			next[agent][key] = !prev[agent][key];
			if (agent === "main" && !next.main[key] && key !== "spawn_agent") {
				// The subset rule: a sub-agent cannot hold what the main agent lost.
				next.subagent[key] = false;
			}
			return next;
		});
	};

	/** A plugin is on unless the operator stored an explicit `false` for this agent. */
	const pluginOn = (agent: "main" | "subagent", key: string) => draft.plugins[agent][key] !== false;

	const togglePlugin = (agent: "main" | "subagent", key: string) => {
		setDraft((prev) => {
			const on = prev.plugins[agent][key] !== false;
			const next: SentinelPermissionsConfig = {
				main: prev.main,
				subagent: prev.subagent,
				commander: prev.commander,
				subagentMaxTurns: prev.subagentMaxTurns,
				plugins: {
					main: { ...prev.plugins.main },
					subagent: { ...prev.plugins.subagent },
				},
			};
			next.plugins[agent][key] = !on;
			// Same subset rule as the tool switches, applied per plugin.
			if (agent === "main" && on) next.plugins.subagent[key] = false;
			return next;
		});
	};

	const toggleCommander = (key: SentinelCommanderPermissionKey) => {
		setDraft((prev) => ({
			main: prev.main,
			subagent: prev.subagent,
			commander: { ...prev.commander, [key]: !prev.commander[key] },
			subagentMaxTurns: prev.subagentMaxTurns,
			plugins: prev.plugins,
		}));
	};

	const applyPreset = (preset: SentinelPermissionPreset) => {
		setDraft((prev) => ({
			main: { ...preset.main },
			subagent: { ...preset.subagent },
			commander: { ...preset.commander },
			subagentMaxTurns: prev.subagentMaxTurns,
			// A preset describes tools, not plugins: it must not remount anything.
			plugins: prev.plugins,
		}));
	};

	const setMaxTurns = (value: number) => {
		setDraft((prev) => ({ ...prev, subagentMaxTurns: value }));
	};

	const disabledCount = (set: SentinelPermissionSet) =>
		SWITCHES.filter((item) => item.subagent && !set[item.key]).length;

	const switchRow = (agent: "main" | "subagent", item: (typeof SWITCHES)[number]) => {
		const on = draft[agent][item.key];
		const blockedByParent = agent === "subagent" && !draft.main[item.key];
		return (
			<SwitchRow
				key={item.key}
				label={item.label}
				hint={blockedByParent ? t("主 Agent 已禁用，子 Agent 无法单独开启") : item.hint}
				checked={on}
				disabled={busy || blockedByParent}
				onChange={() => toggle(agent, item.key)}
			/>
		);
	};

	/**
	 * The MCP switch, narrowed to individual servers.
	 *
	 * These rows are not a second switch: they read and write the same `enabled` field
	 * the MCP page's 启用 does, so the two pages cannot disagree. They stay operable with
	 * the master switch off, which is how a server is staged before MCP is allowed at all.
	 */
	const mcpServerRows = (
		<div className="permhub-mcp">
			{mcpServers === null ? (
				<Text type="secondary">{t("正在读取 MCP 配置…")}</Text>
			) : mcpServers.length === 0 ? (
				<Text type="secondary">{t("还没有配置服务器（设置 → MCP）。")}</Text>
			) : (
				<>
					<Text type="secondary" className="permhub-mcp__note">
						{t("逐个服务器控制。这里的开关就是「设置 → MCP」的启用，对所有 Agent 生效。")}
					</Text>
					{mcpServers.map((server) => {
						const state = mcpServerState(server);
						return (
							<div key={server.name} className="permhub-row permhub-row--nested">
								<div className="permhub-row__text">
									<Space size={6}>
										<Text code>{server.name}</Text>
										<Tag variant="filled">{TRANSPORT_LABELS[server.transport]}</Tag>
									</Space>
									<Text type="secondary" className="permhub-row__hint" title={server.target}>
										{draft.main.mcp
											? state === "mounted"
												? server.target
												: mountReason(server)
											: t("主开关已关闭：全部不挂载")}
									</Text>
								</div>
								<Switch
									size="small"
									checked={server.enabled}
									disabled={busy || mcpBusy}
									onChange={() => onToggleMcpServer(server.name, !server.enabled)}
								/>
							</div>
						);
					})}
				</>
			)}
		</div>
	);

	return (
		<>
			<Alert
				type="info"
				showIcon
				className="ui-page__alert"
				title={t(
					"工具在会话创建时挂载，被禁用的工具会从注册表里移除：模型看不到、tool_search 搜不到、codemode 也调不到。保存后会立即重建当前会话（历史保留）；有会话正在运行时会拒绝保存，请先中止。",
				)}
			/>

			<SettingsBar
				meta={
					<>
						<Text type="secondary">{t("预设")}</Text>
						<Space size={6} wrap>
							{presets.map((preset) => (
								<Tooltip key={preset.id} title={preset.hint}>
									<Button disabled={busy} onClick={() => applyPreset(preset)}>
										{preset.label}
									</Button>
								</Tooltip>
							))}
						</Space>
						<Text type={dirty ? "warning" : "secondary"} className="permhub-dirty">
							{dirty
								? t("有未保存的修改")
								: t("主 Agent 已禁用 {count} 项", { count: disabledCount(draft.main) })}
						</Text>
					</>
				}
				extra={
					<>
						<Button
							icon={<ReloadOutlined />}
							disabled={busy}
							title={t("重新读取已挂载工具")}
							onClick={onRefresh}
						>
							{t("刷新清单")}
						</Button>
						<Button
							type="primary"
							icon={<SaveOutlined />}
							disabled={busy || !dirty}
							onClick={() =>
								onSave({
									main: { ...draft.main },
									subagent: { ...draft.subagent },
									commander: { ...draft.commander },
									subagentMaxTurns: draft.subagentMaxTurns,
									plugins: {
										main: { ...draft.plugins.main },
										subagent: { ...draft.plugins.subagent },
									},
								})
							}
						>
							{t("保存并重建会话")}
						</Button>
					</>
				}
			/>

			<div className="permhub-grid">
				<SettingsSection
					title={t("主 Agent")}
					description={t("共 {count} 项权限", { count: SWITCHES.length })}
					className="permhub-panel"
				>
					<div className="permhub-list">
						{SWITCHES.map((item) => (
							<div key={item.key}>
								{switchRow("main", item)}
								{item.key === "mcp" ? mcpServerRows : null}
							</div>
						))}
					</div>
				</SettingsSection>
				<SettingsSection
					title={t("子 Agent")}
					description={t("权限不超过主 Agent")}
					className="permhub-panel"
				>
					<div className="permhub-list">
						{SUBAGENT_SWITCHES.map((item) => switchRow("subagent", item))}
						<div className="permhub-row">
							<div className="permhub-row__text">
								<Text strong>{t("轮次上限")}</Text>
								<Text type="secondary" className="permhub-row__hint">
									{t("单个子代理最多执行的轮数，达到后中止并汇报已有结果")}
								</Text>
							</div>
							<InputNumber
								size="small"
								min={1}
								max={200}
								value={draft.subagentMaxTurns}
								disabled={busy}
								style={{ width: 72 }}
								onChange={(value) => {
									if (typeof value === "number" && Number.isFinite(value)) setMaxTurns(Math.round(value));
								}}
							/>
						</div>
					</div>
				</SettingsSection>
				<SettingsSection
					title={t("当前已挂载工具 ({count})", { count: tools.length })}
					description={t("按当前会话的实际挂载结果")}
					className="permhub-panel"
				>
					{tools.length === 0 ? (
						<div className="permhub-panel__empty">
							<Text type="secondary">{t("当前没有会话（先选择项目），或所有工具都被禁用。")}</Text>
						</div>
					) : (
						<List
							size="small"
							dataSource={tools}
							renderItem={(tool) => (
								<List.Item className={tool.active ? "permhub-tool" : "permhub-tool is-dim"}>
									<Space size={6} wrap>
										<Text code>{tool.name}</Text>
										<Text type="secondary">{tool.source}</Text>
										{tool.active ? null : <Tag variant="filled">{t("按需加载")}</Tag>}
									</Space>
								</List.Item>
							)}
						/>
					)}
				</SettingsSection>
			</div>

			<SettingsSection title={t("插件")} className="permhub-card">
				<SettingsNote>
					{t(
						"插件在实现上是 MCP 服务器，因此先受上面的 MCP 总开关约束；这里决定每个插件挂载给哪一类 Agent。关掉后该 Agent 的会话不连接这个插件，它的工具不会注册，tool_search 也搜不到。插件页的启用开关仍然有效，两处都开才会挂载。",
					)}
				</SettingsNote>
				{plugins === null ? (
					<SettingsNote>{t("正在读取插件…")}</SettingsNote>
				) : plugins.plugins.length === 0 ? (
					<SettingsNote>{t("还没有安装插件（设置 → 插件）。")}</SettingsNote>
				) : (
					<ProTable
						size="small"
						rowKey={(plugin) => `${plugin.hostId}/${plugin.manifest.id}`}
						search={false}
						options={false}
						pagination={false}
						tableLayout="fixed"
						dataSource={plugins.plugins}
						columns={[
							{
								title: t("插件"),
								key: "name",
								render: (_, plugin) => (
									<div className="permhub-plugin">
										<Space size={6}>
											<Text strong>{plugin.manifest.name}</Text>
											<Text type="secondary">v{plugin.manifest.version}</Text>
										</Space>
										<Text type="secondary" className="permhub-plugin__hint">
											{!plugin.enabled
												? t("插件页已停用：不挂载")
												: !draft.main.mcp
													? t("MCP 总开关已关闭：全部不挂载")
													: plugin.state === "running"
														? t("{host} · 运行中", { host: plugin.hostName })
														: `${plugin.hostName} · ${plugin.state}`}
										</Text>
									</div>
								),
							},
							{
								title: t("主 Agent"),
								key: "main",
								width: 110,
								align: "center",
								render: (_, plugin) => {
									const key = `${plugin.hostId}/${plugin.manifest.id}`;
									return (
										<Switch
											size="small"
											checked={pluginOn("main", key)}
											disabled={busy}
											aria-label={t("{name} 挂载给主 Agent", { name: plugin.manifest.name })}
											onChange={() => togglePlugin("main", key)}
										/>
									);
								},
							},
							{
								title: t("子 Agent"),
								key: "subagent",
								width: 110,
								align: "center",
								render: (_, plugin) => {
									const key = `${plugin.hostId}/${plugin.manifest.id}`;
									const mainOn = pluginOn("main", key);
									return (
										<div className="permhub-plugin-switch">
											<Switch
												size="small"
												checked={mainOn && pluginOn("subagent", key)}
												disabled={busy || !mainOn}
												aria-label={t("{name} 挂载给子 Agent", { name: plugin.manifest.name })}
												onChange={() => togglePlugin("subagent", key)}
											/>
											{!mainOn ? (
												<Text type="secondary" className="permhub-plugin-switch__hint">
													{t("主 Agent 已关闭，子 Agent 无法单独开启")}
												</Text>
											) : null}
										</div>
									);
								},
							},
						]}
					/>
				)}
			</SettingsSection>

			<SettingsSection title={t("指挥官（工程模式）")} className="permhub-card">
				<SettingsNote>
					{t(
						"指挥官的调度工具（dispatch_task 等）始终挂载；这里控制的是它拆解任务用的受限执行面。修改在指挥官会话下次创建时生效（新建或恢复工程），运行中的工程不受影响。",
					)}
				</SettingsNote>
				<div className="permhub-list">
					{COMMANDER_SWITCHES.map((item) => (
						<SwitchRow
							key={item.key}
							label={item.label}
							hint={item.hint}
							checked={draft.commander[item.key]}
							disabled={busy}
							onChange={() => toggleCommander(item.key)}
						/>
					))}
				</div>
				{draft.commander.bash ? null : (
					<SettingsNote>
						{t("bash 已关闭：指挥官将完全基于目标清单与任务结果摘要编排，不能再自行确认目标类型。")}
					</SettingsNote>
				)}
			</SettingsSection>

			{draft.main.bash || draft.main.edit || draft.main.write ? null : (
				<Alert
					type="warning"
					showIcon
					title={t(
						"当前配置下 Agent 不能执行命令，也不能修改文件：适合只读侦察。如果它需要落地脚本或证据文件，请至少开启 write。",
					)}
				/>
			)}
		</>
	);
}
