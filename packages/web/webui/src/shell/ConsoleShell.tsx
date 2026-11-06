/**
 * The console shell: navigation rail, header, content area.
 *
 * One sidebar changes between conversations and global navigation. Opening
 * all features replaces its contents without leaving the active conversation.
 */

import {
	ArrowLeftOutlined,
	CloudDownloadOutlined,
	GithubOutlined,
	LogoutOutlined,
	MenuFoldOutlined,
	MenuUnfoldOutlined,
	MessageOutlined,
	ReloadOutlined,
	SettingOutlined,
	TranslationOutlined,
} from "@ant-design/icons";
import {
	Avatar,
	Badge,
	Button,
	ConfigProvider,
	Divider,
	Drawer,
	Dropdown,
	Flex,
	Grid,
	Layout,
	Menu,
	Tag,
	Tooltip,
	Typography,
} from "antd";
import type { MenuProps } from "antd";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { CONSOLE_VERSION, PROJECT_RELEASES_URL, PROJECT_REPOSITORY } from "../branding.ts";
import { SessionPanel, type SessionPanelProps } from "../chat/SessionPanel.tsx";
import { SentinelMark } from "../components/icons.tsx";
import { useVersionCheck } from "../components/VersionCheck.tsx";
import { getLanguage, t } from "../i18n.ts";
import type { SentinelMode, SentinelPageId, SentinelProjectInfo, SentinelProxyConfigView } from "../types.ts";
import { SENTINEL_MODE_LABELS } from "../types.ts";
import { CONSOLE_COLORS, consoleSidebarTheme } from "../ui/theme.ts";
import {
	NAV_GROUPS,
	PAGE_TITLES,
	SETTINGS_CHILDREN,
	navLabel,
	type MenuEntry,
	type PluginNavEntry,
} from "./navigation.tsx";
import { ProjectSwitcher } from "./ProjectSwitcher.tsx";
import "./sidebar.css";
import "./console-design.css";

const { Header, Sider, Content } = Layout;
const { Text } = Typography;
const CONSOLE_SURFACE_STYLE = {
	"--console-sider": CONSOLE_COLORS.sider,
	"--console-border": CONSOLE_COLORS.border,
} as CSSProperties;

export interface ConsoleShellProps {
	page: SentinelPageId;
	onNavigate: (page: SentinelPageId) => void;
	collapsed: boolean;
	onToggleCollapse: () => void;
	connected: boolean;
	mode: SentinelMode;
	authUser: string | null;
	modelConfigured: boolean;
	pendingApprovals: number;
	pendingVulns: number;
	pluginPages: PluginNavEntry[];
	projects: SentinelProjectInfo[];
	activeProject: SentinelProjectInfo | null;
	busy: boolean;
	proxyConfig: SentinelProxyConfigView;
	sessionPanel?: SessionPanelProps;
	onSwitchProject: (id: string) => void;
	onCreateProject: (name: string, proxyId?: string | null, proxyNode?: string) => Promise<string | null>;
	onManageProjects: () => void;
	onRefresh: () => void;
	onLogout: () => void;
	onSwitchLanguage: (language: "zh" | "en") => void;
	children: ReactNode;
}

const MODE_COLORS: Record<SentinelMode, string> = {
	review: "default",
	ai: "purple",
	auto: "blue",
};

function entryToItem(entry: MenuEntry, badge: ReactNode): NonNullable<MenuProps["items"]>[number] {
	const Icon = entry.icon;
	return {
		key: entry.page,
		icon: <Icon />,
		title: entry.label,
		label: navLabel(entry.label, badge),
	};
}

export function ConsoleShell({
	page,
	onNavigate,
	collapsed,
	onToggleCollapse,
	connected,
	mode,
	authUser,
	modelConfigured,
	pendingApprovals,
	pendingVulns,
	pluginPages,
	projects,
	activeProject,
	busy,
	proxyConfig,
	sessionPanel,
	onSwitchProject,
	onCreateProject,
	onManageProjects,
	onRefresh,
	onLogout,
	onSwitchLanguage,
	children,
}: ConsoleShellProps) {
	const screens = Grid.useBreakpoint();
	const compact = screens.md === false;
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [globalNavigation, setGlobalNavigation] = useState(false);
	const update = useVersionCheck();
	const hasConversations = page === "chat" && sessionPanel !== undefined;
	const showConversations = hasConversations && !globalNavigation;
	const railCollapsed = !compact && collapsed;

	useEffect(() => {
		setGlobalNavigation(false);
	}, [page]);

	const badgeFor = (entry: MenuEntry): ReactNode => {
		if (entry.page === "settings.model" && !modelConfigured) {
			return (
				<Tooltip title={t("模型尚未配置")}>
					<Badge status="warning" />
				</Tooltip>
			);
		}
		const count = entry.page === "chat" ? pendingApprovals : entry.page === "vulns" ? pendingVulns : 0;
		return count > 0 ? <Badge count={count > 9 ? "9+" : count} size="small" /> : null;
	};

	const menuItems: MenuProps["items"] = NAV_GROUPS.map((group) => ({
		type: "group",
		key: group.group,
		label: <span className="console-nav-group">{t(group.group)}</span>,
		children: [
			...group.items.map((entry) =>
				entry.page === "settings.model"
					? {
							key: "settings",
							icon: <SettingOutlined />,
							title: t("设置"),
							label: t("设置"),
							popupClassName: "console-settings-popup",
							children: SETTINGS_CHILDREN.map((child) => entryToItem(child, null)),
						}
					: entryToItem(entry, badgeFor(entry)),
			),
			...(group.group === "资产与工具"
				? pluginPages.map((plugin): NonNullable<MenuProps["items"]>[number] => ({
						key: plugin.page,
						title: plugin.title,
						disabled: plugin.disabled,
						icon: plugin.iconUrl ? (
							<img className="console-nav-plugin-icon" src={plugin.iconUrl} alt="" />
						) : (
							<SettingOutlined />
						),
						label: navLabel(plugin.label, null),
					}))
				: []),
		],
	}));

	const onMenuClick: MenuProps["onClick"] = ({ key }) => {
		setGlobalNavigation(false);
		onNavigate(key as SentinelPageId);
		setDrawerOpen(false);
	};

	const brand = (showTitle: boolean) => (
		<div className="console-brand">
			<span className="console-brand__mark">
				<SentinelMark size={18} />
			</span>
			{showTitle ? (
				<>
					<span className="console-brand__title">{t("全链哨兵")}</span>
					<Button
						type="text"
						size="small"
						className="console-brand__collapse"
						icon={<MenuFoldOutlined />}
						onClick={onToggleCollapse}
						aria-label={t("收起侧边栏")}
					/>
				</>
			) : null}
		</div>
	);

	const menu = (
		<Menu
			className="console-menu"
			mode="inline"
			theme="light"
			items={menuItems}
			selectedKeys={[page]}
			defaultOpenKeys={page.startsWith("settings.") ? ["settings"] : []}
			onClick={onMenuClick}
		/>
	);

	const accountMenu: MenuProps = {
		items: [
			{ key: "who", label: authUser ?? t("未登录"), disabled: true },
			{ type: "divider" },
			{ key: "refresh", icon: <ReloadOutlined />, label: t("刷新当前页") },
			{ key: "language", icon: <TranslationOutlined />, label: t("切换语言") },
			{ key: "repo", icon: <GithubOutlined />, label: t("源码仓库") },
			...(authUser
				? [
						{ type: "divider" as const },
						{ key: "logout", icon: <LogoutOutlined />, label: t("退出登录"), danger: true },
					]
				: []),
		],
		onClick: ({ key, domEvent }) => {
			domEvent.stopPropagation();
			if (key === "refresh") onRefresh();
			if (key === "language") onSwitchLanguage(getLanguage() === "zh" ? "en" : "zh");
			if (key === "repo") window.open(PROJECT_REPOSITORY, "_blank", "noopener,noreferrer");
			if (key === "logout") onLogout();
		},
	};

	const siderFooter = (showText: boolean) => (
		<div className="console-sider-footer">
			<div className="console-sider-footer__row">
				<span className={connected ? "console-dot is-on" : "console-dot"} />
				{showText ? <span className="console-sider-footer__text">{connected ? t("已连接") : t("已断开")}</span> : null}
				{showText ? <span className="console-sider-footer__version">v{CONSOLE_VERSION}</span> : null}
				{update.result?.updateAvailable ? (
					<Tooltip
						title={`${getLanguage() === "en" ? "New version" : "发现新版本"} v${update.result.latestVersion} · ${getLanguage() === "en" ? "Open releases to update manually" : "点击查看发布页，手动更新"}`}
					>
						<Button
							className="console-version-update"
							type="text"
							size="small"
							icon={<CloudDownloadOutlined />}
							aria-label={getLanguage() === "en" ? "New version available" : "发现新版本"}
							href={PROJECT_RELEASES_URL}
							target="_blank"
							rel="noopener noreferrer"
						/>
					</Tooltip>
				) : null}
			</div>
		</div>
	);

	const sidebarContent = (
		<ConfigProvider theme={consoleSidebarTheme}>
			<Flex vertical className="console-sidebar">
				{showConversations ? (
					<div className="console-sidebar__switch">
						<Tooltip title={railCollapsed ? t("全部功能") : undefined} placement="right">
							<Button
								type="text"
								block
								icon={<ArrowLeftOutlined />}
								onClick={() => setGlobalNavigation(true)}
								aria-label={t("全部功能")}
							>
								{railCollapsed ? null : t("全部功能")}
							</Button>
						</Tooltip>
					</div>
				) : null}
				<div className="console-sidebar__navigation console-sider__scroll" hidden={showConversations}>
					{menu}
				</div>
				{sessionPanel ? (
					<div className="console-sidebar__sessions" hidden={!showConversations || railCollapsed}>
						<SessionPanel
							{...sessionPanel}
							onNew={() => {
								sessionPanel.onNew();
								setDrawerOpen(false);
							}}
							onSwitch={(path) => {
								sessionPanel.onSwitch(path);
								setDrawerOpen(false);
							}}
						/>
					</div>
				) : null}
				{showConversations && railCollapsed ? (
					<div className="console-sidebar__expand">
						<Tooltip title={t("展开侧边栏")} placement="right">
							<Button type="text" icon={<MessageOutlined />} onClick={onToggleCollapse} aria-label={t("展开侧边栏")} />
						</Tooltip>
					</div>
				) : null}
				{showConversations && !railCollapsed ? (
					<div className="console-sidebar__settings">
						<Button
							type="text"
							icon={<SettingOutlined />}
							onClick={() => {
								onNavigate("settings.model");
								setDrawerOpen(false);
							}}
						>
							{t("设置")}
						</Button>
					</div>
				) : null}
			</Flex>
		</ConfigProvider>
	);

	const header = (
		<Header className="console-header">
			<div className="console-header__left">
				{compact || collapsed ? (
					<Button
						type="text"
						icon={<MenuUnfoldOutlined />}
						onClick={() => (compact ? setDrawerOpen(true) : onToggleCollapse())}
						aria-label={t(compact ? "打开导航" : "展开侧边栏")}
					/>
				) : null}
				<ProjectSwitcher
					projects={projects}
					activeProject={activeProject}
					busy={busy}
					proxyConfig={proxyConfig}
					onSwitch={onSwitchProject}
					onCreate={onCreateProject}
					onManage={onManageProjects}
				/>
				<Divider orientation="vertical" className="console-header__divider" />
				<span className="console-header__page">
					{page.startsWith("plugin:") ? t("插件") : (PAGE_TITLES[page] ?? t("控制台"))}
				</span>
				{connected ? <Tag color={MODE_COLORS[mode]}>{SENTINEL_MODE_LABELS[mode]}</Tag> : null}
			</div>
			<div className="console-header__right">
				<Badge
					status={connected ? "success" : "error"}
					text={<span className="console-header__conn">{connected ? t("已连接") : t("已断开")}</span>}
				/>
				<Tooltip title={t("刷新当前页")}>
					<Button type="text" icon={<ReloadOutlined />} onClick={onRefresh} aria-label={t("刷新当前页")} />
				</Tooltip>
				<Tooltip title={t("切换语言")}>
					<Button type="text" onClick={() => onSwitchLanguage(getLanguage() === "zh" ? "en" : "zh")}>
						{getLanguage() === "zh" ? "EN" : "中"}
					</Button>
				</Tooltip>
				<Dropdown menu={accountMenu} trigger={["click"]} placement="bottomRight">
					<Button type="text" className="console-account">
						<Avatar size={26} className="console-account__avatar">
							{(authUser ?? "?").slice(0, 1).toUpperCase()}
						</Avatar>
						<Text className="console-account__name">{authUser ?? t("未登录")}</Text>
					</Button>
				</Dropdown>
			</div>
		</Header>
	);

	return (
		<Layout className="console-shell" style={CONSOLE_SURFACE_STYLE}>
			<a className="console-skip-link" href="#console-main-content">
				{getLanguage() === "en" ? "Skip to content" : "跳到主内容"}
			</a>
			{compact ? (
				<Drawer
					open={drawerOpen}
					onClose={() => setDrawerOpen(false)}
					placement="left"
					size={264}
					closable={false}
					rootClassName="console-drawer"
					rootStyle={CONSOLE_SURFACE_STYLE}
					styles={{ body: { padding: 0, display: "flex", flexDirection: "column" } }}
				>
					<div className="console-drawer__inner">
						<div className="console-drawer__brand">
							<span className="console-brand__mark">
								<SentinelMark size={18} />
							</span>
							<span className="console-brand__title">{t("全链哨兵")}</span>
						</div>
						{sidebarContent}
						{siderFooter(true)}
					</div>
				</Drawer>
			) : (
				<Sider
					className="console-sider"
					width={248}
					collapsedWidth={64}
					collapsed={collapsed}
					trigger={null}
					collapsible
					theme="light"
				>
					<div className="console-sider__inner">
						{brand(!collapsed)}
						{sidebarContent}
						{siderFooter(!collapsed)}
					</div>
				</Sider>
			)}

			<Layout className="console-main">
				{header}
				<Content id="console-main-content" className="console-content" tabIndex={-1} inert={compact && drawerOpen}>
					<div className="console-page">{children}</div>
				</Content>
			</Layout>
		</Layout>
	);
}
