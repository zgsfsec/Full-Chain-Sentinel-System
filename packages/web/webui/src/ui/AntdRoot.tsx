/**
 * The Ant Design runtime root.
 *
 * Three responsibilities, all of them global and all of them necessary once:
 * - the locale follows the console's language, so date pickers, empty states
 *   and pagination are translated with everything else;
 * - the theme is the one in `theme.ts`;
 * - `AntApp` supplies the message/modal/notification instances so pages never
 *   import the static antd singletons (those cannot see the theme or locale).
 *
 * `hashPriority="high"` keeps antd's own selectors ahead of the legacy console
 * stylesheet while the remaining pages are migrated. It can be removed once the
 * legacy sheet is gone.
 */

import { StyleProvider } from "@ant-design/cssinjs";
import { App as AntApp, ConfigProvider } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import type { ReactNode } from "react";
import { getLanguage } from "../i18n.ts";
import { consoleThemes } from "./theme.ts";
import { useThemeMode } from "./theme-mode.ts";

export function AntdRoot({ children }: { children: ReactNode }) {
	const english = getLanguage() === "en";
	const mode = useThemeMode();
	return (
		<StyleProvider hashPriority="high">
			<ConfigProvider
				theme={consoleThemes[mode].main}
				locale={english ? enUS : zhCN}
				button={{ autoInsertSpace: false }}
				form={{ requiredMark: "optional" }}
			>
				<AntApp className="ant-app-root">{children}</AntApp>
			</ConfigProvider>
		</StyleProvider>
	);
}
