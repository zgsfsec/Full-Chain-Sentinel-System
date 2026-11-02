/**
 * Capture tooling: device-side tcpdump driven over the tunnel, plus the HTTP
 * evidence store (HAR / Burp imports and their queries).
 *
 * Two halves share one file because one workflow joins them: capture on the
 * device, pull the pcap, parse it with tshark in the container, and import the
 * requests the operator captured by hand — then quote and replay them during
 * 越权/重放 testing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CaptureStore, HttpEntry } from "./captures.ts";
import { execInContainer } from "./docker.ts";
import type { DroidGateway } from "./droid-gateway.ts";
import { parseTsharkHttpJson } from "./pcap-http.ts";

export const DROID_CAPTURE_TOOL_NAMES: readonly string[] = [
	"droid_capture_start",
	"droid_capture_status",
	"droid_capture_pull",
];

/** Both Android and iOS write HTTP evidence to this project-scoped store. */
export const HTTP_EVIDENCE_TOOL_NAMES: readonly string[] = [
	"capture_import",
	"capture_search",
	"capture_get",
	"capture_replay",
];

export const CAPTURE_TOOL_NAMES: readonly string[] = [...DROID_CAPTURE_TOOL_NAMES, ...HTTP_EVIDENCE_TOOL_NAMES];

const DEVICE_PCAP = "/data/local/tmp/droid-capture.pcap";

export interface CaptureToolContext {
	gateway: () => DroidGateway | undefined;
	container: () => string;
	workDir: () => string;
	/** The active project; imports and queries are project-scoped. */
	project: () => { id: string; name: string } | null;
	store: () => CaptureStore;
}

function failure(text: string): AgentToolResult<{ ok: boolean }> {
	return { content: [{ type: "text", text }], details: { ok: false }, isError: true };
}

function pickDevice(
	gateway: DroidGateway | undefined,
	device: string | undefined,
): { id: string; name: string } | string {
	if (!gateway) return "设备网关未启动";
	const online = gateway.onlineDevices();
	if (online.length === 0) return "没有在线的安卓设备";
	if (device?.trim()) {
		const found =
			online.find((candidate) => candidate.id === device.trim()) ??
			online.find((candidate) => candidate.name === device.trim());
		if (!found) return `设备「${device}」不在线`;
		return { id: found.id, name: found.name };
	}
	if (online.length > 1) return "多台设备在线，请用 device 参数指定";
	return { id: online[0]!.id, name: online[0]!.name };
}

function clip(text: string, max = 4000): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`;
}

/** The capture commands run as root shell over the gateway, like tcpdump needs. */
async function shell(gateway: DroidGateway, deviceId: string, cmd: string, timeoutMs = 15_000) {
	return gateway.request(deviceId, { t: "exec", cmd, asRoot: false, timeoutMs }, { timeoutMs: timeoutMs + 5_000 });
}

export function createCaptureTools(ctx: CaptureToolContext): ToolDefinition[] {
	const start = defineTool({
		name: "droid_capture_start",
		label: "Start a packet capture on the device",
		defaultActive: false,
		description:
			"Start tcpdump on the rooted device (writes /data/local/tmp/droid-capture.pcap). Capture covers all interfaces and every app; HTTPS bodies are encrypted — pair the pcap with droid_frida (okhttp_log) for plaintext, or ask the operator to proxy through Burp. droid_capture_pull stops the capture and parses the file.",
		promptSnippet: "Start tcpdump on the device",
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
			iface: Type.Optional(Type.String({ description: "网卡，默认 any" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const picked = pickDevice(gateway, params.device);
			if (typeof picked === "string") return failure(picked);
			const result = await shell(
				gateway,
				picked.id,
				"pkill -f droid-capture.pcap; sleep 0.3; nohup tcpdump -i '" +
					(params.iface ?? "any").replace(/'/g, "") +
					"' -s0 -w '" +
					DEVICE_PCAP +
					"' > /dev/null 2>&1 & echo started",
			);
			if (!result.ok) return failure(`启动失败：${result.error ?? "未知错误"}`);
			return {
				content: [
					{
						type: "text",
						text: `已在 ${picked.name} 上开始抓包（${params.iface ?? "any"}）。操作几步目标 App 后用 droid_capture_pull 停止并解析。`,
					},
				],
				details: { ok: true },
			};
		},
	});

	const status = defineTool({
		name: "droid_capture_status",
		label: "Check the device capture",
		defaultActive: false,
		description: "Whether tcpdump is running on the device and how large the pcap has grown.",
		promptSnippet: "Check the running capture's size",
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const picked = pickDevice(gateway, params.device);
			if (typeof picked === "string") return failure(picked);
			const result = await shell(
				gateway,
				picked.id,
				"ls -l '" +
					DEVICE_PCAP +
					"' 2>/dev/null || echo none; pgrep -f droid-capture.pcap > /dev/null && echo running || echo stopped",
			);
			if (!result.ok) return failure(`查询失败：${result.error ?? "未知错误"}`);
			return {
				content: [{ type: "text", text: `${picked.name} 抓包状态：\n${result.stdout ?? ""}` }],
				details: { ok: true },
			};
		},
	});

	const pull = defineTool({
		name: "droid_capture_pull",
		label: "Stop the capture, pull the pcap and parse it",
		defaultActive: false,
		description:
			"Stop tcpdump on the device, pull the pcap into the work directory (evidence/pcap/), and parse it in the container with tshark: protocol statistics plus every plaintext HTTP request line. HTTPS shows only endpoints; use droid_frida okhttp_log for plaintext bodies. The pcap path doubles as vulnerability evidence.",
		promptSnippet: "Stop the device capture, pull the pcap and summarize it",
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean; path?: string }>> {
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const picked = pickDevice(gateway, params.device);
			if (typeof picked === "string") return failure(picked);
			await shell(gateway, picked.id, "pkill -f droid-capture.pcap; sleep 1", 10_000);
			const pulled = await gateway.request(
				picked.id,
				{ t: "pull", path: DEVICE_PCAP, maxBytes: 512 * 1024 * 1024 },
				{ timeoutMs: 180_000 },
			);
			if (!pulled.ok) return failure(`拉取失败：${pulled.error ?? "未知错误"}`);
			const bytes = pulled.bytes ?? Buffer.alloc(0);
			if (bytes.length === 0) return failure("pcap 为空：抓包期间可能没有流量，或 tcpdump 未真正启动");
			const dir = join(ctx.workDir(), "evidence", "pcap");
			mkdirSync(dir, { recursive: true });
			const name = `capture-${new Date().toISOString().replace(/[:.]/g, "-")}.pcap`;
			const target = join(dir, name);
			writePcap(target, bytes);
			const parsed = await execInContainer(
				ctx.container(),
				`set -e; f='/work/evidence/pcap/${name}'; echo '== 协议分布 =='; tshark -r "$f" -q -z io,phs 2>/dev/null | head -30; echo; echo '== 明文 HTTP 请求 =='; tshark -r "$f" -Y http.request -T fields -e frame.number -e ip.dst -e http.host -e http.request.method -e http.request.uri 2>/dev/null | head -60; echo; echo '== DNS 查询 =='; tshark -r "$f" -Y dns.flags.response==0 -T fields -e dns.qry.name 2>/dev/null | sort -u | head -40`,
				[],
				{ timeoutMs: 180_000 },
			);
			const summary = (parsed.stdout + (parsed.stderr ? `\n${parsed.stderr}` : "")).trim() || "（tshark 无输出）";
			return {
				content: [
					{ type: "text", text: `pcap 已保存：${target}（${bytes.length} 字节）\n\n${clip(summary, 12_000)}` },
				],
				details: { ok: true, path: target },
			};
		},
	});

	const storeOf = (): { store: CaptureStore; project: { id: string; name: string } } | string => {
		const project = ctx.project();
		if (!project) return "尚未选择项目：抓包证据按项目归档";
		return { store: ctx.store(), project };
	};

	const importTool = defineTool({
		name: "capture_import",
		label: "Import a capture export into the evidence store",
		defaultActive: false,
		description:
			"Import a HAR (.har), Burp Suite XML export, raw request dump, or a pcap from the work directory into this project's HTTP evidence store. pcap uses tshark to extract plaintext HTTP requests/responses (HTTPS stays encrypted; use ios_http_log for that). Afterwards capture_search/capture_get quote the requests and capture_replay builds replay commands. Importing again creates duplicates; import once per export.",
		promptSnippet: "Import a HAR/Burp/text/pcap capture export as queryable evidence",
		parameters: Type.Object({
			path: Type.String({
				description: "工作目录内的导出文件路径，例如 /work/burp.xml、/work/traffic.har 或 /work/ios.pcap",
			}),
			format: Type.Union([Type.Literal("har"), Type.Literal("burp"), Type.Literal("text"), Type.Literal("pcap")], {
				description: "导出格式",
			}),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const context = storeOf();
			if (typeof context === "string") return failure(context);
			const hostPath = join(ctx.workDir(), params.path.replace(/^\/work\/?/, ""));
			if (!existsSync(hostPath)) return failure(`文件不存在：${params.path}`);
			if (params.format === "pcap") {
				let cPath: string;
				try {
					cPath = containerPathOf(ctx.workDir(), hostPath);
				} catch (error) {
					return failure(error instanceof Error ? error.message : String(error));
				}
				const parsed = await importPcap(ctx.container(), cPath);
				if (!parsed.ok) return failure(`tshark 解析失败：${parsed.error}`);
				if (parsed.entries.length === 0) {
					return failure(
						"pcap 里没有明文 HTTP 请求。HTTPS 流量请用 ios_http_log（NSURLSession 层）或手工代理导出 HAR。",
					);
				}
				const result = context.store.importEntries(context.project.id, basename(params.path), parsed.entries);
				return {
					content: [
						{
							type: "text",
							text: `pcap 导入完成：${result.imported} 条入库，${result.skipped} 条跳过（来源 ${result.source}，项目 ${context.project.name}）。用 capture_search 检索。`,
						},
					],
					details: { ok: true },
				};
			}
			const text = readText(hostPath);
			const result =
				params.format === "har"
					? context.store.importHar(context.project.id, basename(params.path), text)
					: params.format === "burp"
						? context.store.importBurp(context.project.id, basename(params.path), text)
						: context.store.importText(context.project.id, basename(params.path), text);
			return {
				content: [
					{
						type: "text",
						text: `导入完成：${result.imported} 条入库，${result.skipped} 条跳过（来源 ${result.source}，项目 ${context.project.name}）。用 capture_search 检索。`,
					},
				],
				details: { ok: true },
			};
		},
	});

	const search = defineTool({
		name: "capture_search",
		label: "Search stored HTTP evidence",
		defaultActive: false,
		description:
			"Search this project's imported HTTP entries by host and/or free text (URL, path, method, request/response bodies). Returns summaries with ids; capture_get returns the full entry, capture_replay builds the replay command.",
		promptSnippet: "Search imported HTTP requests by host or free text",
		parameters: Type.Object({
			host: Type.Optional(Type.String({ description: "按 host 子串过滤" })),
			q: Type.Optional(Type.String({ description: "自由文本：URL/路径/方法/请求或响应体内匹配" })),
			limit: Type.Optional(Type.Number({ description: "最多返回条数，默认 50" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const context = storeOf();
			if (typeof context === "string") return failure(context);
			const rows = context.store.list(context.project.id, {
				...(params.host ? { host: params.host } : {}),
				...(params.q ? { q: params.q } : {}),
				...(params.limit ? { limit: params.limit } : {}),
			});
			if (rows.length === 0) return failure("没有匹配的记录。先用 capture_import 导入 HAR/Burp 导出。");
			const lines = rows.map(
				(row) => `- [${row.id.slice(0, 8)}] ${row.method} ${row.url}${row.status ? ` → ${row.status}` : ""}`,
			);
			return {
				content: [
					{
						type: "text",
						text: `匹配 ${rows.length} 条（用方括号里的 id 调 capture_get / capture_replay）：\n${lines.join("\n")}`,
					},
				],
				details: { ok: true },
			};
		},
	});

	const get = defineTool({
		name: "capture_get",
		label: "Read one stored HTTP entry",
		defaultActive: false,
		description:
			"Read one imported entry in full: method, URL, request headers and body, response status, headers and body (long bodies are truncated — export the id for the verbatim record). This is what 越权/重放 analysis quotes.",
		promptSnippet: "Read one stored request/response pair in full",
		parameters: Type.Object({
			id: Type.String({ description: "capture_search 返回的条目 id（可只给前 8 位）" }),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const context = storeOf();
			if (typeof context === "string") return failure(context);
			const entry = findEntry(context.store, context.project.id, params.id);
			if (!entry) return failure(`条目不存在：${params.id}`);
			return {
				content: [
					{
						type: "text",
						text: `${entry.method} ${entry.url}\n状态：${entry.status ?? "—"}\n\n请求头：\n${clip(entry.requestHeaders)}\n\n请求体：\n${clip(entry.requestBody)}\n\n响应头：\n${clip(entry.responseHeaders)}\n\n响应体：\n${clip(entry.responseBody)}`,
					},
				],
				details: { ok: true },
			};
		},
	});

	const replay = defineTool({
		name: "capture_replay",
		label: "Build a replay command for one entry",
		defaultActive: false,
		description:
			"Build a curl command that replays a stored request verbatim, ready to run in the container. For 越权 testing: replay it with another account's Cookie/Token substituted and compare the responses. The tool only builds the command; running it goes through the normal bash approval chain.",
		promptSnippet: "Build a curl replay command for a stored request",
		parameters: Type.Object({
			id: Type.String({ description: "capture_search 返回的条目 id（可只给前 8 位）" }),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const context = storeOf();
			if (typeof context === "string") return failure(context);
			const entry = findEntry(context.store, context.project.id, params.id);
			if (!entry) return failure(`条目不存在：${params.id}`);
			const headers: string[] = [];
			let body = "";
			for (const line of entry.requestHeaders.split("\n")) {
				const cut = line.indexOf(":");
				if (cut <= 0) continue;
				const name = line.slice(0, cut).trim();
				const value = line.slice(cut + 1).trim();
				if (/^(content-length|host|connection)$/i.test(name)) continue;
				if (/^content-type$/i.test(name)) {
					headers.push(`-H 'Content-Type: ${value}'`);
					continue;
				}
				headers.push(`-H '${name}: ${value.replace(/'/g, `'\\''`)}'`);
			}
			if (entry.requestBody) {
				body = ` --data-raw '${entry.requestBody.replace(/'/g, `'\\''`)}'`;
			}
			const curl = `curl -sS -X ${entry.method} '${entry.url.replace(/'/g, `'\\''`)}' ${headers.join(" ")}${body}`;
			return {
				content: [
					{
						type: "text",
						text: `重放命令（越权测试时替换 Cookie/Token 后对比响应；运行会经 bash 审批链）：\n\n${curl}`,
					},
				],
				details: { ok: true },
			};
		},
	});

	return [start, status, pull, importTool, search, get, replay];
}

function writePcap(target: string, bytes: Buffer): void {
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, bytes);
}

/** Host path under the project, expressed as the container's /work mount. */
function containerPathOf(workDir: string, hostPath: string): string {
	const rel = relative(workDir, hostPath).split(sep).join("/");
	if (rel === "" || rel.startsWith("..")) throw new Error(`路径必须位于工程目录内：${hostPath}`);
	return `/work/${rel}`;
}

async function importPcap(
	container: string,
	cPath: string,
): Promise<{ ok: true; entries: ReturnType<typeof parseTsharkHttpJson> } | { ok: false; error: string }> {
	const parsed = await execInContainer(container, 'tshark -r "$1" -Y http --no-duplicate-keys -T json', [cPath], {
		timeoutMs: 300_000,
	});
	if (parsed.code !== 0) {
		return { ok: false, error: parsed.stderr.trim() || `tshark 退出码 ${parsed.code}` };
	}
	return { ok: true, entries: parseTsharkHttpJson(parsed.stdout) };
}

function readText(path: string): string {
	return readFileSync(path, "utf-8");
}

/** Id prefix match: the agent quotes the 8 characters the search results show. */
function findEntry(store: CaptureStore, projectId: string, id: string): HttpEntry | undefined {
	const full = store.get(id, projectId);
	if (full) return full;
	const rows = store.list(projectId, { limit: 500 });
	const prefix = id.trim().toLowerCase();
	const match = rows.find((row) => row.id.startsWith(prefix));
	return match ? store.get(match.id, projectId) : undefined;
}
