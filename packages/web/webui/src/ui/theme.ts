/**
 * The console's Ant Design theme.
 *
 * Light and dark neutral surfaces keep color reserved for meaningful status
 * and severity signals. Both modes share typography, spacing and geometry.
 * Page code reuses these tokens rather than hard-coding its own palette.
 *
 * `cssVar` is on so custom CSS (chat transcript, terminal, plugin frames) can
 * reuse the same tokens instead of duplicating the palette.
 */

import { theme, type ThemeConfig } from "antd";
import type { ThemeMode } from "./theme-mode.ts";

/** Seed colors shared by the theme and the few hand-written surfaces. */
export const CONSOLE_COLORS = {
	sider: "#ffffff",
	siderDeep: "#fafafa",
	primary: "#18181b",
	primaryHover: "#3f3f46",
	primaryActive: "#09090b",
	success: "#217b64",
	warning: "#946200",
	danger: "#c03f48",
	contentBg: "#fafafa",
	card: "#ffffff",
	border: "#d4d4d8",
	borderSoft: "#e4e4e7",
	text: "#18181b",
	textSecondary: "#52525b",
	textTertiary: "#71717a",
} as const;

const FONT_FAMILY = '"Avenir Next", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif';

const DARK_COLORS = {
	sider: "#1b2029",
	siderDeep: "#171b22",
	primary: "#d7e0ec",
	primaryHover: "#edf2f8",
	primaryActive: "#b5c5da",
	success: "#70c7a4",
	warning: "#d9b56f",
	danger: "#ea8591",
	contentBg: "#171b22",
	card: "#202630",
	border: "#394452",
	borderSoft: "#303946",
	text: "#dce3ec",
	textSecondary: "#aab5c4",
	textTertiary: "#8693a6",
} as const;

function createConsoleTheme(mode: ThemeMode): ThemeConfig {
	const dark = mode === "dark";
	const colors = dark ? DARK_COLORS : CONSOLE_COLORS;
	return {
		algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
		cssVar: { key: "sentinel" },
		hashed: false,
		token: {
			colorPrimary: colors.primary,
			colorTextLightSolid: dark ? "#171b22" : "#ffffff",
			colorPrimaryHover: colors.primaryHover,
			colorPrimaryActive: colors.primaryActive,
			colorPrimaryBg: dark ? "#262d38" : "#f4f4f5",
			colorPrimaryBgHover: dark ? "#343e4d" : "#e4e4e7",
			colorPrimaryBorder: dark ? "#7e8b9d" : "#a1a1aa",
			colorPrimaryText: colors.primary,
			colorInfo: colors.primary,
			colorInfoBg: dark ? "#262d38" : "#f4f4f5",
			colorInfoBorder: dark ? "#394452" : "#d4d4d8",
			colorInfoText: colors.primary,
			colorLink: colors.primary,
			colorLinkHover: colors.primaryHover,
			colorLinkActive: colors.primaryActive,
			controlItemBgActive: dark ? "#2a3340" : "#f0f0f2",
			controlItemBgActiveHover: dark ? "#343e4d" : "#e4e4e7",
			colorSuccess: colors.success,
			colorSuccessBg: dark ? "#192e29" : "#edf8f3",
			colorSuccessBorder: dark ? "#315c4e" : "#c1dfd2",
			colorSuccessText: colors.success,
			colorWarning: colors.warning,
			colorWarningBg: dark ? "#30291d" : "#fff7e5",
			colorWarningBorder: dark ? "#645135" : "#ead6a9",
			colorWarningText: colors.warning,
			colorError: colors.danger,
			colorErrorBg: dark ? "#331f26" : "#fff1f2",
			colorErrorBorder: dark ? "#683641" : "#edc5ca",
			colorErrorText: colors.danger,
			colorErrorHover: dark ? "#f29aa1" : "#ad3540",
			colorBgLayout: colors.contentBg,
			colorBgContainer: colors.card,
			colorBgElevated: colors.card,
			colorBorder: colors.border,
			colorBorderSecondary: colors.borderSoft,
			colorSplit: colors.borderSoft,
			colorText: colors.text,
			colorTextSecondary: colors.textSecondary,
			colorTextTertiary: colors.textTertiary,
			colorTextQuaternary: dark ? "#7e8b9d" : "#a1a1aa",
			colorFillTertiary: dark ? "#2a3340" : "#f0f0f2",
			colorFillQuaternary: dark ? "#202630" : "#fafafa",
			borderRadius: 6,
			borderRadiusLG: 10,
			borderRadiusSM: 6,
			borderRadiusXS: 4,
			controlHeight: 32,
			controlHeightSM: 26,
			controlHeightLG: 40,
			fontFamily: FONT_FAMILY,
			fontSize: 14,
			fontSizeSM: 12,
			lineHeight: 1.6,
			boxShadow: "0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06)",
			boxShadowSecondary: "0 12px 32px rgba(16, 24, 40, 0.12), 0 4px 12px rgba(16, 24, 40, 0.06)",
			boxShadowTertiary: "0 1px 2px rgba(16, 24, 40, 0.04)",
			motionDurationMid: "0.16s",
			wireframe: false,
		},
		components: {
			Alert: {
				defaultPadding: "6px 10px",
				withDescriptionPadding: "8px 10px",
				withDescriptionIconSize: 16,
			},
			Layout: {
				bodyBg: colors.contentBg,
				headerBg: colors.card,
				headerHeight: 48,
				headerPadding: "0 14px",
				siderBg: colors.sider,
				triggerBg: colors.siderDeep,
				triggerColor: colors.textSecondary,
				lightSiderBg: colors.sider,
				lightTriggerBg: colors.siderDeep,
				lightTriggerColor: colors.textSecondary,
			},
			Menu: {
				itemBorderRadius: 8,
				itemHeight: 34,
				itemMarginInline: 8,
				itemMarginBlock: 1,
				iconSize: 16,
				collapsedIconSize: 18,
				groupTitleColor: colors.textTertiary,
				groupTitleFontSize: 10.5,
				itemBg: "transparent",
				subMenuItemBg: "transparent",
				itemColor: colors.textSecondary,
				itemHoverBg: dark ? "#262d38" : "#f4f4f5",
				itemHoverColor: colors.text,
				itemSelectedBg: dark ? "#2a3340" : "#f0f0f2",
				itemSelectedColor: colors.text,
				itemDisabledColor: dark ? "#7e8b9d" : "#a1a1aa",
				popupBg: colors.card,
			},
			Table: {
				headerBg: dark ? "#202630" : "#fafafa",
				headerColor: colors.textSecondary,
				headerSplitColor: "transparent",
				borderColor: colors.borderSoft,
				rowHoverBg: dark ? "#202630" : "#fafafa",
				rowSelectedBg: dark ? "#262d38" : "#f4f4f5",
				rowSelectedHoverBg: dark ? "#343e4d" : "#e4e4e7",
				cellFontSize: 13,
				cellFontSizeMD: 13,
				cellFontSizeSM: 13,
				cellPaddingBlock: 10,
				cellPaddingBlockMD: 10,
				cellPaddingBlockSM: 10,
				cellPaddingInline: 12,
				cellPaddingInlineMD: 12,
				cellPaddingInlineSM: 12,
				headerBorderRadius: 8,
				footerBg: "transparent",
			},
			Card: {
				headerBg: "transparent",
				headerFontSize: 14,
				bodyPadding: 16,
				headerPadding: 16,
				headerHeight: 44,
			},
			Button: {
				fontWeight: 500,
				defaultShadow: "none",
				primaryShadow: "none",
				dangerShadow: "none",
				paddingInline: 12,
			},
			Tabs: {
				horizontalItemPadding: "8px 0",
				horizontalItemGutter: 20,
				titleFontSize: 14,
			},
			Modal: {
				titleFontSize: 16,
				headerBg: colors.card,
				contentBg: colors.card,
			},
			Segmented: {
				trackBg: colors.contentBg,
				itemSelectedBg: colors.card,
			},
			Descriptions: {
				labelBg: dark ? "#202630" : "#fafafa",
				titleMarginBottom: 8,
			},
			Form: {
				labelColor: colors.textSecondary,
				labelFontSize: 13,
				itemMarginBottom: 12,
				verticalLabelPadding: "0 0 6px",
			},
			Input: {
				paddingBlock: 4,
				paddingInline: 10,
			},
			Select: {
				optionSelectedBg: dark ? "#262d38" : "#f4f4f5",
			},
			Tag: {
				fontSizeSM: 12,
				defaultBg: colors.contentBg,
				defaultColor: colors.textSecondary,
			},
			Divider: {
				colorSplit: colors.borderSoft,
			},
			Drawer: {
				paddingLG: 16,
			},
			Tooltip: {
				colorBgSpotlight: dark ? "#303946" : colors.primary,
				colorTextLightSolid: "#ffffff",
			},
			Badge: {
				textFontSizeSM: 12,
			},
		},
	};
}

/** Navigation keeps its spacing while inheriting the selected palette. */
function createSidebarTheme(base: ThemeConfig): ThemeConfig {
	return {
		...base,
		cssVar: { key: "sentinel-sidebar" },
		components: {
			...base.components,
			Menu: {
				...base.components?.Menu,
				fontSize: 14,
				iconSize: 18,
				itemHeight: 38,
				itemPaddingInline: 16,
				itemMarginBlock: 1,
				groupTitleFontSize: 11,
			},
		},
	};
}

const light = createConsoleTheme("light");
const dark = createConsoleTheme("dark");

export const consoleThemes = {
	light: { main: light, sidebar: createSidebarTheme(light), auth: { ...light, cssVar: { key: "sentinel-auth" } } },
	dark: { main: dark, sidebar: createSidebarTheme(dark), auth: { ...dark, cssVar: { key: "sentinel-auth" } } },
};
