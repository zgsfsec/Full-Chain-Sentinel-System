/**
 * The console's Ant Design theme.
 *
 * White navigation and document surfaces with charcoal actions. Neutral
 * structure keeps color reserved for meaningful status and severity signals.
 * Page code reuses these tokens rather than hard-coding its own palette.
 *
 * `cssVar` is on so custom CSS (chat transcript, terminal, plugin frames) can
 * reuse the same tokens instead of duplicating the palette.
 */

import { theme, type ThemeConfig } from "antd";

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

export const consoleTheme: ThemeConfig = {
	algorithm: theme.defaultAlgorithm,
	cssVar: { key: "sentinel" },
	hashed: false,
	token: {
		colorPrimary: CONSOLE_COLORS.primary,
		colorPrimaryHover: CONSOLE_COLORS.primaryHover,
		colorPrimaryActive: CONSOLE_COLORS.primaryActive,
		colorPrimaryBg: "#f4f4f5",
		colorPrimaryBgHover: "#e4e4e7",
		colorPrimaryBorder: "#a1a1aa",
		colorPrimaryText: CONSOLE_COLORS.primary,
		colorInfo: CONSOLE_COLORS.primary,
		colorInfoBg: "#f4f4f5",
		colorInfoBorder: "#d4d4d8",
		colorInfoText: CONSOLE_COLORS.primary,
		colorLink: CONSOLE_COLORS.primary,
		colorLinkHover: CONSOLE_COLORS.primaryHover,
		colorLinkActive: CONSOLE_COLORS.primaryActive,
		controlItemBgActive: "#f0f0f2",
		controlItemBgActiveHover: "#e4e4e7",
		colorSuccess: CONSOLE_COLORS.success,
		colorSuccessBg: "#edf8f3",
		colorSuccessBorder: "#c1dfd2",
		colorSuccessText: CONSOLE_COLORS.success,
		colorWarning: CONSOLE_COLORS.warning,
		colorWarningBg: "#fff7e5",
		colorWarningBorder: "#ead6a9",
		colorWarningText: CONSOLE_COLORS.warning,
		colorError: CONSOLE_COLORS.danger,
		colorErrorBg: "#fff1f2",
		colorErrorBorder: "#edc5ca",
		colorErrorText: CONSOLE_COLORS.danger,
		colorErrorHover: "#ad3540",
		colorBgLayout: CONSOLE_COLORS.contentBg,
		colorBgContainer: CONSOLE_COLORS.card,
		colorBgElevated: CONSOLE_COLORS.card,
		colorBorder: CONSOLE_COLORS.border,
		colorBorderSecondary: CONSOLE_COLORS.borderSoft,
		colorSplit: CONSOLE_COLORS.borderSoft,
		colorText: CONSOLE_COLORS.text,
		colorTextSecondary: CONSOLE_COLORS.textSecondary,
		colorTextTertiary: CONSOLE_COLORS.textTertiary,
		colorTextQuaternary: "#a1a1aa",
		colorFillTertiary: "#f0f0f2",
		colorFillQuaternary: "#fafafa",
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
			bodyBg: CONSOLE_COLORS.contentBg,
			headerBg: CONSOLE_COLORS.card,
			headerHeight: 48,
			headerPadding: "0 14px",
			siderBg: CONSOLE_COLORS.sider,
			triggerBg: CONSOLE_COLORS.siderDeep,
			triggerColor: CONSOLE_COLORS.textSecondary,
			lightSiderBg: CONSOLE_COLORS.sider,
			lightTriggerBg: CONSOLE_COLORS.siderDeep,
			lightTriggerColor: CONSOLE_COLORS.textSecondary,
		},
		Menu: {
			itemBorderRadius: 8,
			itemHeight: 34,
			itemMarginInline: 8,
			itemMarginBlock: 1,
			iconSize: 16,
			collapsedIconSize: 18,
			groupTitleColor: CONSOLE_COLORS.textTertiary,
			groupTitleFontSize: 10.5,
			itemBg: "transparent",
			subMenuItemBg: "transparent",
			itemColor: CONSOLE_COLORS.textSecondary,
			itemHoverBg: "#f4f4f5",
			itemHoverColor: CONSOLE_COLORS.text,
			itemSelectedBg: "#f0f0f2",
			itemSelectedColor: CONSOLE_COLORS.text,
			itemDisabledColor: "#a1a1aa",
			popupBg: CONSOLE_COLORS.card,
		},
		Table: {
			headerBg: "#fafafa",
			headerColor: CONSOLE_COLORS.textSecondary,
			headerSplitColor: "transparent",
			borderColor: CONSOLE_COLORS.borderSoft,
			rowHoverBg: "#fafafa",
			rowSelectedBg: "#f4f4f5",
			rowSelectedHoverBg: "#e4e4e7",
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
			headerBg: CONSOLE_COLORS.card,
			contentBg: CONSOLE_COLORS.card,
		},
		Segmented: {
			trackBg: CONSOLE_COLORS.contentBg,
			itemSelectedBg: CONSOLE_COLORS.card,
		},
		Descriptions: {
			labelBg: "#fafafa",
			titleMarginBottom: 8,
		},
		Form: {
			labelColor: CONSOLE_COLORS.textSecondary,
			labelFontSize: 13,
			itemMarginBottom: 12,
			verticalLabelPadding: "0 0 6px",
		},
		Input: {
			paddingBlock: 4,
			paddingInline: 10,
		},
		Select: {
			optionSelectedBg: "#f4f4f5",
		},
		Tag: {
			fontSizeSM: 12,
			defaultBg: CONSOLE_COLORS.contentBg,
			defaultColor: CONSOLE_COLORS.textSecondary,
		},
		Divider: {
			colorSplit: CONSOLE_COLORS.borderSoft,
		},
		Drawer: {
			paddingLG: 16,
		},
		Tooltip: {
			colorBgSpotlight: CONSOLE_COLORS.primary,
		},
		Badge: {
			textFontSizeSM: 12,
		},
	},
};

/** Scoped to navigation so menus, conversation filters and popups stay light. */
export const consoleSidebarTheme: ThemeConfig = {
	algorithm: theme.defaultAlgorithm,
	cssVar: { key: "sentinel-sidebar" },
	token: {
		colorBgContainer: CONSOLE_COLORS.card,
		colorBgElevated: CONSOLE_COLORS.sider,
		colorBorder: CONSOLE_COLORS.border,
		colorText: CONSOLE_COLORS.text,
		colorTextSecondary: CONSOLE_COLORS.textSecondary,
		colorTextTertiary: CONSOLE_COLORS.textTertiary,
		colorTextPlaceholder: CONSOLE_COLORS.textTertiary,
		colorBgTextHover: "#f4f4f5",
		controlItemBgActive: "#f0f0f2",
	},
	components: {
		Menu: {
			fontSize: 14,
			iconSize: 18,
			itemHeight: 38,
			itemPaddingInline: 16,
			itemMarginBlock: 1,
			groupTitleFontSize: 11,
			groupTitleColor: CONSOLE_COLORS.textTertiary,
			itemColor: CONSOLE_COLORS.textSecondary,
			itemHoverColor: CONSOLE_COLORS.text,
			itemSelectedColor: CONSOLE_COLORS.text,
			itemSelectedBg: "#f0f0f2",
		},
		Segmented: {
			trackBg: "#f4f4f5",
			itemSelectedBg: CONSOLE_COLORS.card,
		},
		Select: { optionSelectedBg: "#f4f4f5" },
	},
};

/** Login forms share the workspace's white surface and charcoal actions. */
export const consoleAuthTheme: ThemeConfig = {
	...consoleSidebarTheme,
	cssVar: { key: "sentinel-auth" },
	token: {
		...consoleSidebarTheme.token,
		colorBgContainerDisabled: "#f4f4f5",
		colorTextDisabled: "#a1a1aa",
	},
	components: {
		Form: { labelColor: CONSOLE_COLORS.textSecondary },
	},
};
