import { MoonOutlined, SunOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import { getLanguage } from "../i18n.ts";
import { setThemeMode, useThemeMode } from "./theme-mode.ts";

export function ThemeToggle() {
	const dark = useThemeMode() === "dark";
	const label =
		getLanguage() === "en"
			? dark
				? "Switch to light mode"
				: "Switch to dark mode"
			: dark
				? "切换到浅色模式"
				: "切换到暗色模式";
	return (
		<Tooltip title={label}>
			<Button
				type="text"
				icon={dark ? <SunOutlined /> : <MoonOutlined />}
				aria-label={label}
				aria-pressed={dark}
				onClick={() => setThemeMode(dark ? "light" : "dark")}
			/>
		</Tooltip>
	);
}
