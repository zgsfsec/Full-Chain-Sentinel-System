/**
 * Navigation model for the console.
 *
 * The groups mirror the operator's workflow: the work itself first, then
 * configuration. Pages own their titles; this file owns where they live and
 * what icon they carry, so the sider, the mobile drawer and the header agree.
 */

import {
	AndroidOutlined,
	ApiOutlined,
	ApartmentOutlined,
	AppleOutlined,
	AppstoreAddOutlined,
	AppstoreOutlined,
	AuditOutlined,
	BellOutlined,
	BugOutlined,
	BuildOutlined,
	CloudDownloadOutlined,
	ContainerOutlined,
	DatabaseOutlined,
	DashboardOutlined,
	EyeOutlined,
	FileSearchOutlined,
	FileTextOutlined,
	GlobalOutlined,
	InfoCircleOutlined,
	LockOutlined,
	MessageOutlined,
	RadarChartOutlined,
	RobotOutlined,
	SafetyCertificateOutlined,
	SearchOutlined,
	SendOutlined,
	SettingOutlined,
	SwapOutlined,
	TeamOutlined,
} from "@ant-design/icons";
import type { ComponentType, ReactNode } from "react";
import { getLanguage, t } from "../i18n.ts";
import type { SentinelPageId } from "../types.ts";

export type MenuIcon = ComponentType<{ className?: string }>;

export interface MenuEntry {
	page: SentinelPageId;
	label: string;
	icon: MenuIcon;
}

export interface PluginNavEntry {
	page: SentinelPageId;
	label: string;
	title: string;
	iconUrl: string | null;
	disabled: boolean;
}

/** Group entries by the operator's workflow, with configuration last. */
export const NAV_GROUPS: { group: string; items: MenuEntry[] }[] = [
	{
		group: "工作台",
		items: [
			{ page: "dashboard", label: t("项目概览"), icon: DashboardOutlined },
			{ page: "chat", label: t("对话"), icon: MessageOutlined },
			{ page: "projects", label: t("项目"), icon: AppstoreOutlined },
		],
	},
	{
		group: "资产与工具",
		items: [
			{ page: "vulns", label: t("漏洞"), icon: BugOutlined },
			{ page: "reports", label: getLanguage() === "en" ? "Reports" : "报告中心", icon: FileTextOutlined },
			{ page: "assets", label: t("资产库"), icon: DatabaseOutlined },
			{ page: "mitm", label: getLanguage() === "en" ? "MITM Center" : "MITM 中心", icon: SwapOutlined },
			{ page: "webfuzz", label: "WebFuzz", icon: SendOutlined },
			{ page: "apimodels", label: t("业务建模"), icon: ApartmentOutlined },
			{ page: "pocs", label: t("POC 库"), icon: FileSearchOutlined },
			{ page: "droid", label: t("安卓设备"), icon: AndroidOutlined },
			{ page: "ios", label: t("iOS 设备"), icon: AppleOutlined },
		],
	},
	{
		group: "情报",
		items: [
			{ page: "codeintel", label: t("开源情报"), icon: RadarChartOutlined },
			{ page: "threatintel", label: getLanguage() === "en" ? "Threat Intelligence" : "威胁反制", icon: SafetyCertificateOutlined },
		],
	},
	{
		group: "执行与审计",
		items: [
			{ page: "engine", label: t("工程"), icon: BuildOutlined },
			{ page: "gates", label: t("审批"), icon: AuditOutlined },
			{ page: "supervisor", label: t("监督"), icon: EyeOutlined },
		],
	},
	{
		group: "系统",
		items: [
			{ page: "proxies", label: t("代理"), icon: GlobalOutlined },
			{ page: "settings.model", label: t("设置"), icon: SettingOutlined },
			{ page: "about", label: t("关于"), icon: InfoCircleOutlined },
		],
	},
];

/** The settings row expands into these pages. */
export const SETTINGS_CHILDREN: MenuEntry[] = [
	{ page: "settings.model", label: t("模型"), icon: RobotOutlined },
	{ page: "settings.supervisor", label: t("监督"), icon: EyeOutlined },
	{ page: "settings.notify", label: t("通知"), icon: BellOutlined },
	{ page: "settings.permissions", label: t("权限"), icon: SafetyCertificateOutlined },
	{ page: "settings.presets", label: t("预设 Agent"), icon: TeamOutlined },
	{ page: "settings.pocs", label: t("POC 订阅"), icon: FileSearchOutlined },
	{ page: "settings.assets", label: t("资产测绘"), icon: DatabaseOutlined },
	{ page: "settings.websearch", label: t("Web 搜索"), icon: SearchOutlined },
	{ page: "settings.mcp", label: "MCP", icon: ApiOutlined },
	{ page: "settings.plugins", label: t("插件"), icon: AppstoreAddOutlined },
	{ page: "settings.security", label: t("安全"), icon: LockOutlined },
	{ page: "settings.environment", label: t("环境"), icon: ContainerOutlined },
];

/** Category labels for the settings pages, used by the page header. */
export const PAGE_TITLES: Record<string, string> = (() => {
	const titles: Record<string, string> = {};
	for (const group of NAV_GROUPS) {
		for (const item of group.items) titles[item.page] = item.label;
	}
	for (const item of SETTINGS_CHILDREN) titles[item.page] = item.label;
	return titles;
})();

/**
 * A menu label with an optional count.
 *
 * The badge lives inside the label so it keeps the row's vertical rhythm; a
 * floating `Badge` would sit on the row's corner and read as a notification
 * about the whole sidebar.
 */
export function navLabel(label: string, badge: ReactNode): ReactNode {
	if (!badge) return label;
	return (
		<span className="console-nav-label">
			<span className="console-nav-label__text">{label}</span>
			<span className="console-nav-label__badge">{badge}</span>
		</span>
	);
}
