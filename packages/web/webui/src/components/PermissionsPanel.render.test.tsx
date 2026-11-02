/**
 * Render smoke tests for the permissions page's MCP rows.
 *
 * The page needs a browser to *look* right, but a null dereference or a bad prop
 * would fail here first, and this is the only automated check the JSX gets. The
 * case worth pinning is the one the page exists for: MCP allowed as a whole while
 * one server is switched off, which a single switch cannot express.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type {
	SentinelMcpServerView,
	SentinelPermissionPreset,
	SentinelPermissionsConfig,
	SentinelPluginView,
	SentinelPluginsView,
} from "../types.ts";
import { PermissionsPanel } from "./PermissionsPanel.tsx";

function server(overrides: Partial<SentinelMcpServerView> = {}): SentinelMcpServerView {
	return {
		name: "filesystem",
		enabled: true,
		transport: "stdio",
		target: "npx -y server",
		command: "npx",
		args: ["-y", "server"],
		env: {},
		cwd: "",
		url: "",
		headers: {},
		description: "",
		exposure: "codemode",
		timeout: null,
		hostExecAcknowledged: true,
		status: { at: null, ok: true },
		...overrides,
	};
}

function config(mcp: boolean): SentinelPermissionsConfig {
	const set = {
		read: true,
		bash: true,
		edit: true,
		write: true,
		codemode: true,
		tool_search: true,
		mcp,
		spawn_agent: true,
		vuln_submit: true,
		vuln_read: true,
		poc_read: true,
		asset_read: true,
		asset_library_write: true,
		asset_library_read: true,
		mitm_read: true,
		web_search: true,
	};
	return {
		main: { ...set },
		subagent: { ...set },
		commander: { bash: true, read: true },
		subagentMaxTurns: 40,
		plugins: { main: {}, subagent: {} },
	};
}

/** A plugin as the plugin center lists it; only the fields the rows read matter. */
function plugin(overrides: Partial<SentinelPluginView> = {}): SentinelPluginView {
	return {
		hostId: "local",
		hostName: "本机",
		hostLocal: true,
		state: "running",
		healthy: true,
		enabled: true,
		pinned: false,
		configured: [],
		values: {},
		hostPort: 7801,
		installedAt: 0,
		lastError: null,
		manifest: {
			schema: 1,
			id: "com.sentinel.cmd5",
			name: "CMD5 哈希查询",
			version: "0.1.0",
			description: "",
			author: "github:chinaran404",
			source: "https://example.com",
			license: "MIT",
			build: { dockerfile: "Dockerfile", context: ".", args: {} },
			mcp: { transport: "http", port: 7801, path: "/mcp", startupTimeoutMs: 15000, requestTimeoutMs: 60000 },
			config: [],
			permissions: { network: "bridge", capAdd: [], privileged: false },
			locality: "any",
			resources: { cpus: 0.5, memory: "128m", pidsLimit: 64 },
			healthcheck: { path: "/healthz", intervalMs: 10000, timeoutMs: 3000, retries: 3 },
			artifacts: { path: "", maxFileBytes: 0 },
			tools: [],
			ui: null,
		},
		...overrides,
	};
}

function pluginView(plugins: SentinelPluginView[]): SentinelPluginsView {
	return { hosts: [], plugins, problems: [] };
}

function render(
	servers: SentinelMcpServerView[] | null,
	options: {
		mcp?: boolean;
		busy?: boolean;
		mcpBusy?: boolean;
		plugins?: SentinelPluginsView | null;
		pluginSwitches?: { main?: Record<string, boolean>; subagent?: Record<string, boolean> };
	} = {},
): string {
	const presets: SentinelPermissionPreset[] = [];
	const base = config(options.mcp ?? true);
	return renderToStaticMarkup(
		<PermissionsPanel
			config={{
				...base,
				plugins: {
					main: options.pluginSwitches?.main ?? {},
					subagent: options.pluginSwitches?.subagent ?? {},
				},
			}}
			presets={presets}
			tools={[]}
			mcpServers={servers}
			plugins={options.plugins ?? null}
			mcpBusy={options.mcpBusy ?? false}
			busy={options.busy ?? false}
			onSave={() => {}}
			onRefresh={() => {}}
			onToggleMcpServer={() => {}}
		/>,
	);
}

test("lists one row per server under the MCP switch", () => {
	const html = render([
		server({ name: "filesystem", transport: "stdio", target: "npx -y server" }),
		server({ name: "remote", transport: "http", url: "https://example.com/mcp", target: "https://example.com/mcp" }),
		server({ name: "legacy", transport: "sse", url: "https://example.com/sse", target: "https://example.com/sse" }),
	]);
	expect(html).toContain("permhub-mcp");
	expect(html).toContain("filesystem");
	expect(html).toContain("remote");
	expect(html).toContain("legacy");
	// The transport badge, so a stdio row is not mistaken for a remote one.
	expect(html).toContain(">stdio<");
	expect(html).toContain(">HTTP<");
	expect(html).toContain(">SSE<");
	// The point of the rows: MCP on, one server off, and both visible at once.
	expect(html).toContain("npx -y server");
});

test("a switched-off server says why it contributes nothing", () => {
	const html = render([server({ enabled: false })]);
	expect(html).toContain("已停用：不连接、不注册工具，Agent 看不到它");
});

test("a stdio server without the host-execution acknowledgment says so", () => {
	const html = render([server({ hostExecAcknowledged: false })]);
	expect(html).toContain("未勾选宿主机执行确认：不连接、不注册工具");
});

test("with the master switch off the rows still render, annotated", () => {
	const html = render([server({ name: "filesystem" }), server({ name: "remote", transport: "http" })], { mcp: false });
	expect(html).toContain("filesystem");
	expect(html).toContain("remote");
	expect(html).toContain("主开关已关闭：全部不挂载");
});

test("says where servers come from when none are configured", () => {
	const html = render([]);
	expect(html).toContain("还没有配置服务器（设置 → MCP）");
	// The old wording named a file the console no longer reads.
	expect(html).not.toContain("连接 mcp.json");
	expect(html).toContain("项目目录与配置目录里的 mcp.json 都不读");
});

test("distinguishes 'not loaded yet' from 'none configured'", () => {
	const html = render(null);
	expect(html).toContain("正在读取 MCP 配置…");
	expect(html).not.toContain("还没有配置服务器");
});

test("a per-server switch in flight disables the rows", () => {
	const busy = render([server()], { mcpBusy: true });
	expect(busy).toContain("disabled");
});

test("lists one row per installed plugin with a switch for each agent", () => {
	const html = render([], {
		plugins: pluginView([plugin(), plugin({ hostId: "vps", hostName: "VPS", manifest: { ...plugin().manifest, id: "com.example.scan", name: "扫描器" } })]),
	});
	expect(html).toContain("ant-table");
	expect(html).toContain("CMD5 哈希查询");
	expect(html).toContain("扫描器");
	// One switch per agent, addressable by name so the two are not confused.
	expect(html).toContain("CMD5 哈希查询 挂载给主 Agent");
	expect(html).toContain("CMD5 哈希查询 挂载给子 Agent");
	expect(html).toContain("本机 · 运行中");
});

test("a plugin switched off for the main agent blocks the sub-agent switch", () => {
	const html = render([], {
		plugins: pluginView([plugin()]),
		pluginSwitches: { main: { "local/com.sentinel.cmd5": false } },
	});
	// The sub-agent switch is disabled and its tooltip explains the subset rule.
	expect(html).toContain("主 Agent 已关闭，子 Agent 无法单独开启");
	expect(html).toContain('disabled=""');
});

test("a plugin the operator disabled in the plugin center says why it mounts nowhere", () => {
	const html = render([], { plugins: pluginView([plugin({ enabled: false })]) });
	expect(html).toContain("插件页已停用：不挂载");
});

test("distinguishes 'plugins not loaded yet' from 'none installed'", () => {
	expect(render([], { plugins: null })).toContain("正在读取插件…");
	expect(render([], { plugins: pluginView([]) })).toContain("还没有安装插件（设置 → 插件）");
});

test("shows the read-only MITM permission for both main and sub-agents", () => {
	const html = render([]);
	expect(html.match(/mitm_flows \/ mitm_flow_get \/ mitm_flow_read/g)).toHaveLength(2);
	expect(html).toContain("不能启停代理、修改配置或清空记录");
});
