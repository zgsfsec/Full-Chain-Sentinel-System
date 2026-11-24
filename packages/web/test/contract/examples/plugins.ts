import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

type Manifest = Extract<SentinelServerMessage, { type: "plugin_manifest" }>["manifest"];
type PluginView = Extract<SentinelServerMessage, { type: "plugins" }>["view"]["plugins"][number];

const localHostId = "host-1ke1zl3";
const remoteHostId = "host-1lig2n6";

/**
 * The plugin that runs through most examples: a zip the operator uploaded. This
 * is its `plugin.json` after the server filled in the defaults, which is what
 * `plugin_manifest`, `install_plugin` and `plugins` carry.
 */
const recon = {
	schema: 1,
	id: "com.example.recon",
	name: "Recon Toolkit",
	version: "0.2.0",
	description: "子域名枚举与端口探测，结果写入产物目录。仅限已授权的测试。",
	author: "github:example",
	source: "https://github.com/example/sentinel-plugin-recon",
	license: "MIT",
	build: { dockerfile: "Dockerfile", context: ".", args: { GO_VERSION: "1.22" } },
	mcp: { transport: "http", port: 7801, path: "/mcp", startupTimeoutMs: 60000, requestTimeoutMs: 300000 },
	config: [
		{
			key: "RECON_TOKEN",
			label: "API Token",
			type: "secret",
			required: false,
			default: null,
			options: [],
			description: "可选；留空时只做被动枚举",
		},
		{
			key: "RECON_THREADS",
			label: "并发数",
			type: "number",
			required: false,
			default: 20,
			options: [],
			description: "",
		},
		{
			key: "RECON_MODE",
			label: "模式",
			type: "enum",
			required: false,
			default: "active",
			options: ["passive", "active"],
			description: "active 会向目标发探测包",
		},
	],
	permissions: { network: "bridge", capAdd: ["NET_RAW"], privileged: false },
	locality: "any",
	resources: { cpus: 1, memory: "512m", pidsLimit: 256 },
	healthcheck: { path: "/healthz", intervalMs: 10000, timeoutMs: 3000, retries: 6 },
	artifacts: { path: "/artifacts", maxFileBytes: 52428800 },
	tools: [
		{ name: "list_subdomains", description: "列出子域名" },
		{ name: "probe_ports", description: "探测端口" },
	],
	ui: {
		entry: "/ui/index.html",
		title: "Recon Toolkit 侦察结果",
		protocol: 1,
		sidebar: { label: "Recon Toolkit", icon: "/ui/icon.svg" },
	},
} satisfies Manifest;

/** A second plugin on the same host: a built-in official one, without a frontend. */
const echo = {
	schema: 1,
	id: "com.example.http-echo",
	name: "HTTP Echo",
	version: "0.1.0",
	description: "起一个回显服务的最小示例插件，用来确认插件主机工作正常。",
	author: "github:example",
	source: "https://github.com/example/sentinel-plugin-http-echo",
	license: "MIT",
	build: { dockerfile: "Dockerfile", context: ".", args: {} },
	mcp: { transport: "http", port: 7801, path: "/mcp", startupTimeoutMs: 20000, requestTimeoutMs: 300000 },
	config: [],
	permissions: { network: "bridge", capAdd: [], privileged: false },
	locality: "any",
	resources: { cpus: 0.5, memory: "128m", pidsLimit: 64 },
	healthcheck: { path: "/healthz", intervalMs: 10000, timeoutMs: 3000, retries: 3 },
	artifacts: { path: "/artifacts", maxFileBytes: 52428800 },
	tools: [{ name: "echo", description: "原样返回输入" }],
	ui: null,
} satisfies Manifest;

/**
 * The two plugins as the `plugins` message lists them. Typed as an array of the
 * message's element type: left to be inferred, the two entries form a union that
 * TypeScript cannot check against the record type of `values`.
 */
const views: PluginView[] = [
	{
		hostId: localHostId,
		hostName: "本机插件主机",
		hostLocal: true,
		manifest: recon,
		state: "running",
		healthy: true,
		enabled: true,
		pinned: true,
		configured: ["RECON_TOKEN", "RECON_THREADS", "RECON_MODE"],
		values: { RECON_THREADS: "20", RECON_MODE: "active" },
		hostPort: 35412,
		installedAt: 1795165960000,
		lastError: null,
	},
	{
		hostId: localHostId,
		hostName: "本机插件主机",
		hostLocal: true,
		manifest: echo,
		state: "stopped",
		healthy: false,
		enabled: false,
		pinned: false,
		configured: [],
		values: {},
		hostPort: 32771,
		installedAt: 1794902400000,
		lastError: null,
	},
];

/** One valid example of each browser-to-server message described in plugins.md. */
export const client = {
	get_plugins: { type: "get_plugins" },
	save_plugin_host: {
		type: "save_plugin_host",
		host: {
			name: "VPS 插件主机",
			url: "https://plugin-host.example.com",
			token: "sph_7QmZ0xWv7TqLpR2sYnE4fA1bHcDuKj9LgVbNrT8sXwZ",
		},
	},
	delete_plugin_host: { type: "delete_plugin_host", id: remoteHostId },
	test_plugin_host: { type: "test_plugin_host", id: localHostId },
	inspect_plugin_package: {
		type: "inspect_plugin_package",
		name: "recon-toolkit-0.2.0.zip",
		data: "UEsDBBQAAAAIAAAAAADGx+gMZQAAAGwAAAAKAAAARG9ja2VyZmlsZXML8vdVSM/PScxLtzLUMzLiCvcP8nbxDFLQTywo4HL2D4hU0FPQ4woK9VNIz1dIKs3MSVHQzVfQL0pNzs9T0NNPzk2BsLlcIwL8g10VzC0MDLlc/UKCIgP8Pf1CFKKVIPJKsVwAUEsDBBQAAAAIAAAAAAAHAOZylQMAACwHAAALAAAAcGx1Z2luLmpzb26NVVFvE0cQfj7/Cuueg312G4j8ljZuG7WJUbDaB4Ss9d7Yt/Le7nV3z02KItFCChQaB1URSgKkpWoLRSVVJSgNKX+mvjM88Req3b1zwIEqjzvf7Mw3s/PNni84rsQBhMitFStTBcclvlsrupiHJVhGYUShJABz5mqMoRA0uqQtxSbntEeUQfogJOFMg16pWvKM0QeJBYlUBiS/byS7u8nGd+md7eGTZ8Mn66MHe8ngp3T9bvro2suD66On36d3biXfbCVrPw/3fx1dvT/aeZj8s/nvha+HT9debG0kf/2Zrl9Jb18cbV9KH117vqchkwrFKuBCZ+kSFcTtWkbegJLHAhvigVKRrJXL1qmEeVjOHMsSmCIM6ImIxl3CThxWTQkGJs39hfmmMbVjQnWfzhccx/U57oHoEGpc5g5PUxrFnClYVhoqWQsSXZndddwPG61P60tn5huL2qNSqlbdguOsFpxVnSfEUZ5FCcRkxIXK67DBMsupGa9iz0gF2qOsrxqLVEioOGqSEHisFnTqk57neQYU8HkMUr0KvqNBLyOAOeuQrlsrni04jmXcgxUzA/X3G4utZuPj+qLJ47gUtYFqaPb0fLHJe8AyQK1EpjUSsACVGXVmIkB3sYOoBGv1oYNiqitiMaXWxs0EaWpnz+Verw/WYO/FhasvD3ZGm1uj+/vpzcfJ4Lfkq+3ndx8k396z02a6OvWWIj5aqs/OnZksI/n7cTK4kW7+MVEGi8M2iGOWUfWOWcT/EVxozNUn2aX3fkwOBhPUgMXhMYm5CCvSB/cIPX3WcyTlGHZyZ314M33rUBwebCcbN0Y7D9MfLuvmGWkn19eyodZ33QhESKTM8pnhZqC+4KKnA7UF8bu5dlA06/s5KXex3mwtzX6mY52zwy5In1DoHlaZjS3lGFGiTAsRWzGaFWD3wDgpjmKZbT3HDSHkwvhPV6phpi3iy09ISMw7Tp/MYgeAqApwALiXRxqLzmJf2uuEKRB9RI2qKmPJqQmtZTpUghhqeRokFOkgrOSRJIeIZY6WPyAU3ltR5v509d3qzMxYwIpzKl/Tb77EKZGqJeO2z0NEmHTfLK0rN5PL++PNPTGkeahI8Da09Cp6Sxg7B3bdvzoKMcmrA6Zs+8sxKRPmw3IpUCF1s5YpevTjKQ6f/ZLs7dpfI3sxwRXHnI6fVRIf2kiM1+1YPke+MP1g2LI1FDBnJdnv5tu4sFr4D1BLAQIUABQAAAAIAAAAAADGx+gMZQAAAGwAAAAKAAAAAAAAAAAAAAAAAAAAAABEb2NrZXJmaWxlUEsBAhQAFAAAAAgAAAAAAAcA5nKVAwAALAcAAAsAAAAAAAAAAAAAAAAAjQAAAHBsdWdpbi5qc29uUEsFBgAAAAACAAIAcQAAAEsEAAAAAA==",
	},
	install_plugin: {
		type: "install_plugin",
		hostId: localHostId,
		manifest: recon,
		package:
			"UEsDBBQAAAAIAAAAAADGx+gMZQAAAGwAAAAKAAAARG9ja2VyZmlsZXML8vdVSM/PScxLtzLUMzLiCvcP8nbxDFLQTywo4HL2D4hU0FPQ4woK9VNIz1dIKs3MSVHQzVfQL0pNzs9T0NNPzk2BsLlcIwL8g10VzC0MDLlc/UKCIgP8Pf1CFKKVIPJKsVwAUEsDBBQAAAAIAAAAAAAHAOZylQMAACwHAAALAAAAcGx1Z2luLmpzb26NVVFvE0cQfj7/Cuueg312G4j8ljZuG7WJUbDaB4Ss9d7Yt/Le7nV3z02KItFCChQaB1URSgKkpWoLRSVVJSgNKX+mvjM88Req3b1zwIEqjzvf7Mw3s/PNni84rsQBhMitFStTBcclvlsrupiHJVhGYUShJABz5mqMoRA0uqQtxSbntEeUQfogJOFMg16pWvKM0QeJBYlUBiS/byS7u8nGd+md7eGTZ8Mn66MHe8ngp3T9bvro2suD66On36d3biXfbCVrPw/3fx1dvT/aeZj8s/nvha+HT9debG0kf/2Zrl9Jb18cbV9KH117vqchkwrFKuBCZ+kSFcTtWkbegJLHAhvigVKRrJXL1qmEeVjOHMsSmCIM6ImIxl3CThxWTQkGJs39hfmmMbVjQnWfzhccx/U57oHoEGpc5g5PUxrFnClYVhoqWQsSXZndddwPG61P60tn5huL2qNSqlbdguOsFpxVnSfEUZ5FCcRkxIXK67DBMsupGa9iz0gF2qOsrxqLVEioOGqSEHisFnTqk57neQYU8HkMUr0KvqNBLyOAOeuQrlsrni04jmXcgxUzA/X3G4utZuPj+qLJ47gUtYFqaPb0fLHJe8AyQK1EpjUSsACVGXVmIkB3sYOoBGv1oYNiqitiMaXWxs0EaWpnz+Verw/WYO/FhasvD3ZGm1uj+/vpzcfJ4Lfkq+3ndx8k396z02a6OvWWIj5aqs/OnZksI/n7cTK4kW7+MVEGi8M2iGOWUfWOWcT/EVxozNUn2aX3fkwOBhPUgMXhMYm5CCvSB/cIPX3WcyTlGHZyZ314M33rUBwebCcbN0Y7D9MfLuvmGWkn19eyodZ33QhESKTM8pnhZqC+4KKnA7UF8bu5dlA06/s5KXex3mwtzX6mY52zwy5In1DoHlaZjS3lGFGiTAsRWzGaFWD3wDgpjmKZbT3HDSHkwvhPV6phpi3iy09ISMw7Tp/MYgeAqApwALiXRxqLzmJf2uuEKRB9RI2qKmPJqQmtZTpUghhqeRokFOkgrOSRJIeIZY6WPyAU3ltR5v509d3qzMxYwIpzKl/Tb77EKZGqJeO2z0NEmHTfLK0rN5PL++PNPTGkeahI8Da09Cp6Sxg7B3bdvzoKMcmrA6Zs+8sxKRPmw3IpUCF1s5YpevTjKQ6f/ZLs7dpfI3sxwRXHnI6fVRIf2kiM1+1YPke+MP1g2LI1FDBnJdnv5tu4sFr4D1BLAQIUABQAAAAIAAAAAADGx+gMZQAAAGwAAAAKAAAAAAAAAAAAAAAAAAAAAABEb2NrZXJmaWxlUEsBAhQAFAAAAAgAAAAAAAcA5nKVAwAALAcAAAsAAAAAAAAAAAAAAAAAjQAAAHBsdWdpbi5qc29uUEsFBgAAAAACAAIAcQAAAEsEAAAAAA==",
		allowBuild: true,
		allowHostNetwork: false,
		allowPrivileged: false,
		config: { RECON_THREADS: "20", RECON_MODE: "passive" },
	},
	uninstall_plugin: { type: "uninstall_plugin", hostId: localHostId, pluginId: echo.id, purge: false },
	start_plugin: { type: "start_plugin", hostId: localHostId, pluginId: echo.id },
	stop_plugin: { type: "stop_plugin", hostId: localHostId, pluginId: recon.id },
	get_plugin_build_log: { type: "get_plugin_build_log", hostId: localHostId, pluginId: recon.id },
	list_official_plugins: { type: "list_official_plugins" },
	install_official_plugin: {
		type: "install_official_plugin",
		hostId: localHostId,
		pluginId: echo.id,
		allowBuild: true,
		allowHostNetwork: false,
		allowPrivileged: false,
		config: {},
	},
	set_plugin_sidebar: { type: "set_plugin_sidebar", hostId: localHostId, pluginId: recon.id, pinned: false },
	set_plugin_enabled: { type: "set_plugin_enabled", hostId: localHostId, pluginId: echo.id, enabled: false },
	save_plugin_config: {
		type: "save_plugin_config",
		hostId: localHostId,
		pluginId: recon.id,
		values: { RECON_THREADS: "32", RECON_MODE: "active", RECON_TOKEN: "" },
	},
	plugin_ui_open: { type: "plugin_ui_open", hostId: localHostId, pluginId: recon.id },
	plugin_ui_call: {
		type: "plugin_ui_call",
		requestId: "6f1c2a8e-3b4d-4c5e-9f70-8a9b0c1d2e3f",
		hostId: localHostId,
		pluginId: recon.id,
		method: "tool.call",
		params: { name: "list_subdomains", arguments: { domain: "example.com" } },
	},
	get_plugin_logs: { type: "get_plugin_logs", hostId: localHostId, pluginId: recon.id },
	list_plugin_artifacts: { type: "list_plugin_artifacts", hostId: localHostId, pluginId: recon.id },
	fetch_plugin_artifact: {
		type: "fetch_plugin_artifact",
		hostId: localHostId,
		pluginId: recon.id,
		path: "subdomains/example.com.txt",
	},
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

/** One valid example of each server-to-browser message described in plugins.md. */
export const server = {
	plugins: {
		type: "plugins",
		view: {
			hosts: [
				{
					id: localHostId,
					name: "本机插件主机",
					url: "http://127.0.0.1:37219",
					local: true,
					status: { at: 1795509000000, ok: true, mode: "local", docker: { ok: true, version: "27.0.0" } },
				},
				{
					id: remoteHostId,
					name: "VPS 插件主机",
					url: "https://plugin-host.example.com",
					local: false,
					status: { at: 1795508700000, ok: false, error: "连接 VPS 插件主机 失败：fetch failed" },
				},
			],
			plugins: views,
			problems: ["VPS 插件主机：连接 VPS 插件主机 失败：fetch failed"],
		},
	},
	official_plugins: { type: "official_plugins", plugins: [{ manifest: echo, sizeBytes: 18462 }] },
	plugin_manifest: { type: "plugin_manifest", manifest: recon, source: "recon-toolkit-0.2.0.zip" },
	plugin_build_log: {
		type: "plugin_build_log",
		hostId: localHostId,
		pluginId: recon.id,
		log: "# docker build sentinel-plugin/com.example.recon:0.2.0\n# context /home/operator/.sentinel/plugin-host/packages/com.example.recon\n\n#1 [internal] load build definition from Dockerfile\n#1 transferring dockerfile: 196B done\n#5 [2/2] RUN go build -o /recon ./cmd/recon\n#5 DONE 41.3s\n#6 exporting to image\n#6 DONE 1.2s\n\n# build complete\n",
	},
	plugin_logs: {
		type: "plugin_logs",
		hostId: localHostId,
		pluginId: recon.id,
		logs: "2026-11-24T08:31:02Z recon 0.2.0 starting: mode=active threads=20\n2026-11-24T08:31:02Z mcp server listening on 127.0.0.1:7801/mcp\n2026-11-24T08:31:03Z healthz ok",
	},
	plugin_artifacts: {
		type: "plugin_artifacts",
		hostId: localHostId,
		pluginId: recon.id,
		artifacts: [
			{ path: "ports/203.0.113.10.json", size: 482 },
			{ path: "subdomains/example.com.txt", size: 1832 },
		],
	},
	plugin_artifact_saved: {
		type: "plugin_artifact_saved",
		hostId: localHostId,
		pluginId: recon.id,
		path: "subdomains/example.com.txt",
		savedTo: `evidence/plugin/${localHostId}/com.example.recon/subdomains/example.com.txt`,
	},
	plugin_ui_opened: { type: "plugin_ui_opened", token: "k3Jd9QmZ0xWv7TqLpR2sYnE4fA1bHcDu" },
	plugin_ui_result: {
		type: "plugin_ui_result",
		requestId: "6f1c2a8e-3b4d-4c5e-9f70-8a9b0c1d2e3f",
		ok: true,
		result: {
			content: [{ type: "text", text: "sub1.example.com\nsub2.example.com" }],
			isError: false,
			meta: null,
		},
	},
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
