import { theme } from "antd";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { consoleThemes } from "./theme.ts";
import { getThemeMode, setThemeMode } from "./theme-mode.ts";
import { ThemeToggle } from "./ThemeToggle.tsx";

afterEach(() => {
	setThemeMode("light");
	vi.unstubAllGlobals();
});

test("theme switches update the document and persist the selection", () => {
	const setItem = vi.fn();
	const root = { dataset: { theme: "light" }, style: { colorScheme: "light" } };
	vi.stubGlobal("localStorage", { setItem });
	vi.stubGlobal("document", { documentElement: root });
	setThemeMode("dark");
	expect(getThemeMode()).toBe("dark");
	expect(root.dataset.theme).toBe("dark");
	expect(root.style.colorScheme).toBe("dark");
	expect(setItem).toHaveBeenCalledWith("sentinel.ui.theme", "dark");
	setThemeMode("light");
	expect(root.dataset.theme).toBe("light");
	expect(root.style.colorScheme).toBe("light");
});

test("switching works when the browser refuses storage writes", () => {
	vi.stubGlobal("localStorage", {
		setItem: () => {
			throw new Error("Storage disabled");
		},
	});
	setThemeMode("dark");
	expect(getThemeMode()).toBe("dark");
	setThemeMode("light");
	expect(getThemeMode()).toBe("light");
});

test("the toggle announces the next action and its current pressed state", () => {
	expect(renderToStaticMarkup(createElement(ThemeToggle))).toContain('aria-label="切换到暗色模式"');
	setThemeMode("dark");
	const html = renderToStaticMarkup(createElement(ThemeToggle));
	expect(html).toContain('aria-label="切换到浅色模式"');
	expect(html).toContain('aria-pressed="true"');
});

function luminance(hex: string): number {
	const components = hex
		.slice(1)
		.match(/../g)
		?.map((channel) => {
			const value = Number.parseInt(channel, 16) / 255;
			return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
		});
	if (!components || components.length !== 3) throw new Error(`Expected a six-digit hex color: ${hex}`);
	return components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722;
}

test("dark text, secondary labels and solid button text meet normal-text contrast", () => {
	const tokens = theme.getDesignToken(consoleThemes.dark.main);
	for (const [foreground, background] of [
		[tokens.colorText, tokens.colorBgContainer],
		[tokens.colorTextSecondary, tokens.colorBgContainer],
		[tokens.colorTextLightSolid, tokens.colorPrimary],
	]) {
		const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
		expect((values[1] + 0.05) / (values[0] + 0.05)).toBeGreaterThanOrEqual(4.5);
	}
	for (const variant of ["main", "sidebar", "auth"] as const) {
		expect(theme.getDesignToken(consoleThemes.dark[variant]).colorBgContainer).toBe(tokens.colorBgContainer);
	}
});
