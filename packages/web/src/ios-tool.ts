/**
 * The agent's hands on an iPhone.
 *
 * Every tool goes through the reverse gateway; nothing here speaks to a device
 * directly. The tools are registered on every console session with
 * `defaultActive: false` and mounted only while the operator enabled the iOS
 * switch for that conversation, so a Web-only session never sees them.
 *
 * `ios_shell` is the dangerous one: SentinelBridge runs as root under launchd,
 * so this is a root shell on a jailbroken phone. It goes through the same
 * approval chain as container bash (auto/review/ai), with the device as the
 * source and the audit row in gatekeeper.db. The other four tools are read-only
 * or writer-only in the project directory, which is why they are not gated.
 *
 * Pulls stream to disk: a 200 MB IPA or a pcap must not sit in the gateway's
 * heap as well as the tool's, and the same path is what M2's IPA tools reuse.
 */

import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CaptureStore } from "./captures.ts";
import { execInContainer } from "./docker.ts";
import type { IosDevice } from "./ios.ts";
import { IOS_MAX_STREAM_BYTES, type IosRequestInput, type IosResult } from "./ios-protocol.ts";
import { machoInfo } from "./macho.ts";

/** Every tool name this plugin registers, for mount/unmount as one switch. */
export const IOS_TOOL_NAMES: readonly string[] = [
	"ios_devices",
	"ios_shell",
	"ios_file_pull",
	"ios_file_push",
	"ios_screencap",
	"ios_apps",
	"ios_app_info",
	"ios_ipa_pull",
	"ios_profiles",
	"ios_install",
	"ios_uninstall",
	"ipa_info",
	"ipa_files",
	"ipa_strings",
	"ipa_search",
	"ipa_plist",
	"ios_deps",
];

/**
 * The slice of the gateway the tools use. Keeping it narrow lets a test drive a
 * tool without a socket, and it states exactly what a tool may do to a device.
 */
export interface IosGatewayPort {
	onlineDevices(): IosDevice[];
	request(
		deviceId: string,
		req: IosRequestInput,
		options?: { timeoutMs?: number; onData?: (chunk: Buffer) => void },
	): Promise<IosResult>;
	pushFile(
		deviceId: string,
		path: string,
		bytes: Buffer,
		options?: { mode?: string; timeoutMs?: number },
	): Promise<IosResult>;
	/** Open (or reuse) a loopback tunnel into a device port, for frida-server. */
	openTunnel(
		deviceId: string,
		targetHost: string,
		targetPort: number,
	): Promise<{ ok: boolean; port?: number; tunnelId?: string; error?: string }>;
	/** Present on the real gateway; tests may omit it and use the WS fallback. */
	openUpload?(maxBytes: number): { id: string };
	takeUpload?(id: string): string | undefined;
	discardUpload?(id: string): void;
}

export interface IosToolContext {
	gateway: () => IosGatewayPort | undefined;
	/** This conversation's switch; false means the tools are not even mounted. */
	enabled: () => boolean;
	/** Host work directory; evidence and pushed files resolve under it. */
	workDir: () => string;
	/** The project container, for the ipa_* static tools (unzip / plistutil). */
	container: () => string;
	/**
	 * The approval chain for device commands (mode auto/review/ai). Returns the
	 * command that may run (the approval card may edit it), or rejects with a
	 * Chinese reason when it must not.
	 */
	guard: (deviceName: string, command: string) => Promise<string>;
	/**
	 * The active project, for tools that write into the evidence store
	 * (ios_http_log, ios_capture_pull). Absent in unit tests and when the
	 * operator has not opened a project: those tools still work, they just do
	 * not persist.
	 */
	project?: () => { id: string; name: string } | null;
	store?: () => CaptureStore;
}

function failure(text: string): AgentToolResult<{ ok: boolean }> {
	return { content: [{ type: "text", text }], details: { ok: false }, isError: true };
}

function truncate(text: string | undefined, max = 16_000): string {
	const value = text ?? "";
	if (value.length <= max) return value;
	return `${value.slice(0, max)}\n…[输出过长已截断，共 ${value.length} 字符]`;
}

function unresponsive(device: IosDevice): string {
	const seconds = Math.round((device.idleMs ?? 0) / 1000);
	return `设备「${device.name}」无响应：已 ${seconds}s 未收到心跳（SentinelBridge 进程可能被系统挂起或卡死：socket 还在，但设备不再执行任何代码）。请在设备上重开 SentinelBridge 或重启 daemon 后重试`;
}

/** Pick the device: the id/name when given, the only online device otherwise. */
function pickDevice(ctx: IosToolContext, device: string | undefined): { id: string; name: string } | string {
	const gateway = ctx.gateway();
	if (!gateway) return "设备网关未启动";
	const online = gateway.onlineDevices();
	if (online.length === 0) return "没有在线的 iOS 设备：先在越狱设备上打开 SentinelBridge 并等待反连成功";
	if (device?.trim()) {
		const needle = device.trim();
		const found =
			online.find((candidate) => candidate.id === needle) ?? online.find((candidate) => candidate.name === needle);
		if (!found) {
			return `设备「${needle}」不在线。在线设备：${online.map((candidate) => `${candidate.name}(${candidate.id.slice(0, 8)})`).join("、")}`;
		}
		if (found.stale) return unresponsive(found);
		return { id: found.id, name: found.name };
	}
	if (online.length > 1) {
		return `多台设备在线，请用 device 参数指定：${online.map((candidate) => `${candidate.name}(${candidate.id.slice(0, 8)})`).join("、")}`;
	}
	const only = online[0]!;
	if (only.stale) return unresponsive(only);
	return { id: only.id, name: only.name };
}

/**
 * Resolve a path under the project work directory. A tool that can write
 * anywhere on the host is a sandbox escape with extra steps, so `..` and
 * absolute paths outside the project are refused here, not left to the model.
 */
function insideWorkDir(ctx: IosToolContext, path: string): string {
	const root = resolve(ctx.workDir());
	const target = resolve(root, path);
	if (target !== root && !target.startsWith(root + sep)) {
		throw new Error(`路径必须位于工程目录内：${path}`);
	}
	return target;
}

function evidenceDir(ctx: IosToolContext, sub: "files" | "screenshots"): string {
	const dir = join(ctx.workDir(), "evidence", "ios", sub);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Parse a JSON payload a device frame returned in `stdout`. */
function parseJson(text: string | undefined, what: string): unknown {
	if (!text) throw new Error(`${what} 没有返回内容`);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${what} 返回的不是 JSON`);
	}
}

/** Map a host path under the project to its path inside the container (/work). */
export function containerPath(ctx: IosToolContext, hostPath: string): string {
	const rel = relative(resolve(ctx.workDir()), resolve(hostPath));
	if (rel === "" || rel.startsWith("..")) throw new Error("路径必须在工程目录内");
	return `/work/${rel.split(sep).join("/")}`;
}

/** Stream one device file to a local path; returns the byte count. */
export async function pullToFile(
	gateway: IosGatewayPort,
	deviceId: string,
	remotePath: string,
	target: string,
	timeoutMs: number,
): Promise<number> {
	mkdirSync(dirname(target), { recursive: true });
	const part = `${target}.part`;
	let fd: number | undefined;
	let bytes = 0;
	try {
		// Preferred path: the device uploads the file over HTTPS and the console
		// streams it to a temp file. No WebSocket data frames, no base64, and the
		// iOS process never holds the file in memory (jetsam per-process limit).
		if (gateway.openUpload && gateway.takeUpload) {
			const upload = gateway.openUpload(IOS_MAX_STREAM_BYTES);
			try {
				const result = await gateway.request(
					deviceId,
					{ t: "upload", path: remotePath, uploadId: upload.id, maxBytes: IOS_MAX_STREAM_BYTES },
					{ timeoutMs },
				);
				if (!result.ok) throw new Error(result.error ?? "未知错误");
				const uploaded = gateway.takeUpload(upload.id);
				if (!uploaded) throw new Error("上传文件未落到控制台");
				renameSync(uploaded, target);
				return statSync(target).size;
			} catch (error) {
				gateway.discardUpload?.(upload.id);
				throw error;
			}
		}
		fd = openSync(part, "w");
		const result = await gateway.request(
			deviceId,
			{ t: "pull", path: remotePath, maxBytes: IOS_MAX_STREAM_BYTES },
			{
				timeoutMs,
				onData: (chunk) => {
					if (fd === undefined) return;
					writeSync(fd, chunk);
					bytes += chunk.length;
				},
			},
		);
		if (fd !== undefined) {
			closeSync(fd);
			fd = undefined;
		}
		if (!result.ok) throw new Error(result.error ?? "未知错误");
		renameSync(part, target);
		return bytes;
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		rmSync(part, { force: true });
		throw error;
	}
}

/** Minimal XML plist reader for Info.plist and provisioning profiles. */
function parsePlistXml(xml: string): unknown {
	let index = xml.indexOf("<plist");
	if (index < 0) throw new Error("不是 XML plist");
	index = xml.indexOf(">", index) + 1;

	function skip(): void {
		while (index < xml.length && /\s/.test(xml[index] ?? "")) index += 1;
	}
	function readText(tag: string): string {
		const end = xml.indexOf(`</${tag}>`, index);
		if (end < 0) throw new Error(`plist 缺少 </${tag}>`);
		const text = xml.slice(index, end);
		index = end + tag.length + 3;
		return text;
	}
	function node(): unknown {
		skip();
		if (xml[index] !== "<") throw new Error("plist 结构损坏");
		const close = xml.indexOf(">", index);
		const tag = xml
			.slice(index + 1, close)
			.replace(/\/$/, "")
			.trim();
		const selfClosing = xml[close - 1] === "/";
		index = close + 1;
		switch (tag) {
			case "true":
				return true;
			case "false":
				return false;
			case "string":
			case "date":
			case "data":
				return readText(tag);
			case "integer":
				return Number.parseInt(readText(tag).trim(), 10);
			case "real":
				return Number.parseFloat(readText(tag).trim());
			case "dict": {
				const dict: Record<string, unknown> = {};
				if (selfClosing) return dict;
				for (;;) {
					skip();
					if (xml.startsWith("</dict>", index)) {
						index += 7;
						return dict;
					}
					if (!xml.startsWith("<key>", index)) throw new Error("plist dict 缺少 key");
					const keyEnd = xml.indexOf("</key>", index);
					const key = xml.slice(index + 5, keyEnd);
					index = keyEnd + 6;
					dict[key] = node();
				}
			}
			case "array": {
				const array: unknown[] = [];
				if (selfClosing) return array;
				for (;;) {
					skip();
					if (xml.startsWith("</array>", index)) {
						index += 8;
						return array;
					}
					array.push(node());
				}
			}
			default:
				throw new Error(`未知 plist 标签 <${tag}>`);
		}
	}
	return node();
}

/** Read Payload/*.app/Info.plist out of an IPA via unzip + plistutil. */
async function readIpaPlist(container: string, cPath: string): Promise<Record<string, unknown>> {
	const run = await execInContainer(
		container,
		'unzip -p "$1" "$2" > /tmp/sentinel-info.plist; if command -v plistutil >/dev/null 2>&1; then plistutil -i /tmp/sentinel-info.plist -o -; else cat /tmp/sentinel-info.plist; fi',
		[cPath, "Payload/*.app/Info.plist"],
		{ timeoutMs: 60_000 },
	);
	if (run.code !== 0) throw new Error(`读取 Info.plist 失败：${run.stderr}`);
	try {
		return parsePlistXml(run.stdout) as Record<string, unknown>;
	} catch (error) {
		throw new Error(
			`解析 Info.plist 失败：${error instanceof Error ? error.message : String(error)}（容器需要 libplist-utils 提供的 plistutil）`,
		);
	}
}

/** File manifest a device returns for one installed app. */
export interface AppBundleManifest {
	appPath: string;
	bundleId: string;
	entries: Array<{ rel: string; size: number; symlink?: string }>;
}

/**
 * Pull every file of an installed app into a staging directory under
 * evidence/ios/ipa/, laid out as Payload/<App>.app. Shared by ios_ipa_pull and
 * ios_decrypt: the decrypt path replaces some binaries afterwards and only the
 * final zip differs.
 */
export async function pullAppBundle(
	ctx: IosToolContext,
	deviceId: string,
	bundleId: string,
	timeoutMs: number,
): Promise<
	| { ok: true; staging: string; appDir: string; appName: string; manifest: AppBundleManifest; total: number }
	| { ok: false; error: string }
> {
	const gateway = ctx.gateway();
	if (!gateway) return { ok: false, error: "设备网关未启动" };
	const manifestResult = await gateway.request(deviceId, { t: "app_bundle", bundleId }, { timeoutMs: 60_000 });
	if (!manifestResult.ok) return { ok: false, error: `读取清单失败：${manifestResult.error ?? "未知错误"}` };
	let manifest: AppBundleManifest;
	try {
		manifest = parseJson(manifestResult.stdout, "app_bundle") as AppBundleManifest;
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const safe = bundleId.replace(/[^A-Za-z0-9._-]/g, "_");
	const staging = join(ctx.workDir(), "evidence", "ios", "ipa", `${safe}-${stamp}`);
	const appName = basename(manifest.appPath);
	const appDir = join(staging, "Payload", appName);
	mkdirSync(appDir, { recursive: true });
	let total = 0;
	try {
		for (const entry of manifest.entries) {
			const target = join(appDir, entry.rel);
			mkdirSync(dirname(target), { recursive: true });
			if (entry.symlink) {
				symlinkSync(entry.symlink, target);
				continue;
			}
			total += await pullToFile(gateway, deviceId, `${manifest.appPath}/${entry.rel}`, target, timeoutMs);
		}
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		return { ok: false, error: `拉取 App 失败：${error instanceof Error ? error.message : String(error)}` };
	}
	return { ok: true, staging, appDir, appName, manifest, total };
}

/** Zip a staged Payload/ directory into an IPA inside the project container. */
export async function zipPayload(ctx: IosToolContext, staging: string, ipaPath: string): Promise<void> {
	const result = await execInContainer(
		ctx.container(),
		// Remove the old archive first: `zip` updates an existing file and would
		// otherwise leave entries from a previous run of the same bundle.
		'cd "$1" && rm -f "$2" && zip -r -y -q "$2" Payload',
		[containerPath(ctx, staging), containerPath(ctx, ipaPath)],
		{ timeoutMs: 900_000 },
	);
	if (result.code !== 0) throw new Error(result.stderr || `zip 退出码 ${result.code}`);
}

const deviceParam = Type.Optional(Type.String({ description: "目标设备：deviceId 或设备名；只有一台在线时可省略" }));

export function createIosTools(ctx: IosToolContext): ToolDefinition[] {
	const devices = defineTool({
		name: "ios_devices",
		label: "List iOS devices",
		defaultActive: false,
		description:
			"List the iOS devices connected through the reverse channel, online first: device id, name, model, iOS version, architecture, jailbreak form, root state, last seen. Use a device id or name from here in every other ios_* tool.",
		promptSnippet: "List the jailbroken iOS devices reachable over the reverse channel",
		parameters: Type.Object({}),
		async execute(): Promise<AgentToolResult<{ ok: boolean }>> {
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const all = gateway.onlineDevices();
			if (all.length === 0) {
				return failure("没有在线的 iOS 设备：在越狱设备上打开 SentinelBridge，等它反连成功后重试。");
			}
			const lines = all.map((device) => {
				const state = device.stale
					? `无响应（已 ${Math.round((device.idleMs ?? 0) / 1000)}s 无心跳，进程可能被挂起）`
					: device.online
						? "在线"
						: "离线";
				const jailbreak = device.jailbreakName
					? `${device.jailbreakName} ${device.jailbreakVersion}`.trim()
					: "未知越狱";
				return `- ${device.name} [id: ${device.id}] · ${device.model} · iOS ${device.osVersion} (${device.build || "未上报构建号"}) · ${device.arch} · ${jailbreak} (${device.jailbreakForm}) · ${device.hasRoot ? "daemon 有 root" : "仅 App 权限"} · ${state}`;
			});
			const stale = all.filter((device) => device.stale).length;
			const hint =
				stale > 0
					? `\n\n注意：${stale} 台设备 socket 还在但已停止响应，任何请求都会立刻失败——请先在设备上重开 SentinelBridge。`
					: "";
			return {
				content: [{ type: "text", text: `在线设备 ${all.length} 台：\n${lines.join("\n")}${hint}` }],
				details: { ok: true },
			};
		},
	});

	const shell = defineTool({
		name: "ios_shell",
		label: "Run a shell command on the iPhone",
		defaultActive: false,
		description:
			"Run one shell command on a connected, jailbroken iPhone and return its exit code, stdout and stderr. The device daemon runs as root, so treat every command as root on a live target: no destructive operations beyond the objective. Long output is truncated; redirect to a file under /tmp and ios_file_pull it when you need everything.",
		promptSnippet: "Run a shell command on a connected jailbroken iPhone (root)",
		promptGuidelines: [
			"Prefer one focused command per call; quote paths that contain spaces",
			"The daemon already runs as root: asRoot is only for the App-only fallback, and most devices do not need it",
			"Output beyond 16k characters is truncated: write to /tmp and pull the file instead",
			"iOS has no /proc and a different userland: use ps, lsof, launchctl, log show and the /var/jb paths",
		],
		parameters: Type.Object({
			command: Type.String({
				description: "要在设备上执行的 shell 命令，例如 id / ps -ax / launchctl list / ls /var/jb",
			}),
			device: deviceParam,
			asRoot: Type.Optional(
				Type.Boolean({
					description:
						"标记这条命令需要 root。daemon 本身以 root 运行时无差别；受限模式下 daemon 不是 root，标记 true 会直接失败而不是静默降权",
				}),
			),
			timeoutSecs: Type.Optional(Type.Number({ description: "超时秒数，默认 30，上限 600" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const timeoutMs = Math.min(Math.max(Math.round((params.timeoutSecs ?? 30) * 1000), 1000), 600_000);
			let command = params.command;
			try {
				command = await ctx.guard(picked.name, command);
			} catch (error) {
				return failure(`命令未执行：${error instanceof Error ? error.message : String(error)}`);
			}
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const result = await gateway.request(
				picked.id,
				{ t: "exec", cmd: command, asRoot: params.asRoot === true, timeoutMs },
				{ timeoutMs: timeoutMs + 10_000 },
			);
			if (!result.ok) return failure(`执行失败：${result.error ?? "未知错误"}`);
			const head = `设备 ${picked.name} · 退出码 ${result.code ?? -1}${params.asRoot === true ? "（root）" : ""}`;
			const body = [
				result.stdout ? `stdout:\n${truncate(result.stdout)}` : "",
				result.stderr ? `stderr:\n${truncate(result.stderr)}` : "",
			]
				.filter(Boolean)
				.join("\n\n");
			return {
				content: [{ type: "text", text: body ? `${head}\n\n${body}` : `${head}\n\n（无输出）` }],
				details: { ok: true },
			};
		},
	});

	const pull = defineTool({
		name: "ios_file_pull",
		label: "Pull a file from the iPhone",
		defaultActive: false,
		description:
			"Copy one file from the iPhone to the project. The payload streams to disk in chunks and is saved under evidence/ios/files unless localPath is given (relative to the project; absolute paths outside the project are refused). Use this for IPAs, databases, keychain dumps, pcaps and logs.",
		promptSnippet: "Copy a file from the iPhone into the project",
		promptGuidelines: [
			"Prefer a specific file over a directory; tar a directory on the device first",
			"Large pulls stream to disk, so a several-hundred-MB IPA is fine",
		],
		parameters: Type.Object({
			remotePath: Type.String({
				description: "设备上的绝对路径，例如 /var/mobile/Containers/.../Documents/db.sqlite",
			}),
			localPath: Type.Optional(
				Type.String({ description: "工程内的目标路径；省略时存到 evidence/ios/files/<文件名>" }),
			),
			device: deviceParam,
			timeoutSecs: Type.Optional(Type.Number({ description: "超时秒数，默认 120，上限 1800" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			let target: string;
			try {
				target = params.localPath
					? insideWorkDir(ctx, params.localPath)
					: join(evidenceDir(ctx, "files"), basename(params.remotePath));
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			mkdirSync(dirname(target), { recursive: true });
			const part = `${target}.part`;
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const timeoutSecs = Math.min(Math.max(params.timeoutSecs ?? 120, 5), 1800);
			let fd: number | undefined;
			let bytes = 0;
			try {
				fd = openSync(part, "w");
				const result = await gateway.request(
					picked.id,
					{ t: "pull", path: params.remotePath, maxBytes: IOS_MAX_STREAM_BYTES },
					{
						timeoutMs: timeoutSecs * 1000,
						onData: (chunk) => {
							if (fd === undefined) return;
							writeSync(fd, chunk);
							bytes += chunk.length;
						},
					},
				);
				if (fd !== undefined) {
					closeSync(fd);
					fd = undefined;
				}
				if (!result.ok) {
					rmSync(part, { force: true });
					return failure(`拉取失败：${result.error ?? "未知错误"}`);
				}
				renameSync(part, target);
				return {
					content: [{ type: "text", text: `已保存 ${params.remotePath} → ${target}（${bytes} 字节）` }],
					details: { ok: true },
				};
			} catch (error) {
				if (fd !== undefined) closeSync(fd);
				rmSync(part, { force: true });
				return failure(`拉取失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	const push = defineTool({
		name: "ios_file_push",
		label: "Push a file to the iPhone",
		defaultActive: false,
		description:
			"Copy one file from the project to the iPhone in 1 MB chunks. Use it for frida scripts, decryption helpers, tcpdump or a rebuilt binary. The remote path must be writable by the daemon (root), and mode 0755 makes the file executable.",
		promptSnippet: "Copy a project file to the iPhone",
		parameters: Type.Object({
			localPath: Type.String({ description: "工程内的源文件路径（相对工程目录）" }),
			remotePath: Type.String({ description: "设备上的目标绝对路径，例如 /tmp/frida.js 或 /usr/local/bin/tool" }),
			mode: Type.Optional(Type.String({ description: "八进制权限，例如 0755；默认 0644" })),
			device: deviceParam,
			timeoutSecs: Type.Optional(Type.Number({ description: "超时秒数，默认 120，上限 1800" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			let source: string;
			try {
				source = insideWorkDir(ctx, params.localPath);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			let bytes: Buffer;
			try {
				if (!statSync(source).isFile()) return failure(`不是文件：${params.localPath}`);
				bytes = readFileSync(source);
			} catch (error) {
				return failure(`读取失败：${error instanceof Error ? error.message : String(error)}`);
			}
			if (bytes.length > IOS_MAX_STREAM_BYTES) {
				return failure(`文件超过 ${IOS_MAX_STREAM_BYTES} 字节上限`);
			}
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const timeoutSecs = Math.min(Math.max(params.timeoutSecs ?? 120, 5), 1800);
			const result = await gateway.pushFile(picked.id, params.remotePath, bytes, {
				mode: params.mode ?? "0644",
				timeoutMs: timeoutSecs * 1000,
			});
			if (!result.ok) return failure(`推送失败：${result.error ?? "未知错误"}`);
			return {
				content: [
					{
						type: "text",
						text: `已推送 ${params.localPath} → ${params.remotePath}（${bytes.length} 字节，权限 ${params.mode ?? "0644"}）`,
					},
				],
				details: { ok: true },
			};
		},
	});

	const screencap = defineTool({
		name: "ios_screencap",
		label: "Capture the iPhone screen",
		defaultActive: false,
		description:
			"Capture the iPhone screen to evidence/ios/screenshots as a PNG and return the saved path. The daemon uses the private screen-capture API, so it works while another app is in front — including a login or payment page the agent is documenting.",
		promptSnippet: "Capture the iPhone screen into evidence/ios/screenshots",
		parameters: Type.Object({
			device: deviceParam,
			filename: Type.Optional(Type.String({ description: "文件名（不含目录），默认按时间戳生成" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const result = await gateway.request(picked.id, { t: "screencap" }, { timeoutMs: 20_000 });
			if (!result.ok) return failure(`截屏失败：${result.error ?? "未知错误"}`);
			if (!result.bytes || result.bytes.length === 0) return failure("截屏失败：设备返回了空图片");
			const name = params.filename?.trim() || `screencap-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
			const target = join(evidenceDir(ctx, "screenshots"), basename(name));
			let fd: number | undefined;
			try {
				mkdirSync(dirname(target), { recursive: true });
				fd = openSync(target, "w");
				writeSync(fd, result.bytes);
			} catch (error) {
				return failure(`保存失败：${error instanceof Error ? error.message : String(error)}`);
			} finally {
				if (fd !== undefined) closeSync(fd);
			}
			return {
				content: [{ type: "text", text: `截图已保存：${target}（${result.bytes.length} 字节）` }],
				details: { ok: true },
			};
		},
	});

	const apps = defineTool({
		name: "ios_apps",
		label: "List installed iOS apps",
		defaultActive: false,
		description:
			"List the apps installed on a connected iPhone: bundle id, display name, version, build and whether it is a user or system app. Start here to pick a target, then use ios_app_info for its plist, signature and encryption state.",
		promptSnippet: "List installed apps on the iPhone",
		promptGuidelines: ["User apps only by default; pass system=true to include /Applications"],
		parameters: Type.Object({
			device: deviceParam,
			system: Type.Optional(Type.Boolean({ description: "包含系统 App（默认 false）" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const result = await gateway.request(
				picked.id,
				{ t: "apps_list", system: params.system === true },
				{ timeoutMs: 60_000 },
			);
			if (!result.ok) return failure(`枚举失败：${result.error ?? "未知错误"}`);
			let records: Array<Record<string, unknown>>;
			try {
				records = parseJson(result.stdout, "apps_list") as Array<Record<string, unknown>>;
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			if (records.length === 0) return failure("没有枚举到 App");
			const lines = records.map(
				(record) =>
					`- ${record.bundleId} · ${record.name || "(无名)"} · ${record.version || "?"} (${record.build || "?"}) · ${record.type === "system" ? "系统" : "用户"}`,
			);
			return {
				content: [
					{ type: "text", text: `设备 ${picked.name} 上共 ${records.length} 个 App：\n${lines.join("\n")}` },
				],
				details: { ok: true },
			};
		},
	});

	const appInfo = defineTool({
		name: "ios_app_info",
		label: "Inspect one iOS app",
		defaultActive: false,
		description:
			"Read one installed app's Info.plist facts, architectures, FairPlay cryptid, entitlements (when ldid is present), frameworks, URL schemes and data container path. cryptid 0 means the executable is already decrypted; a non-zero value needs ios_decrypt before static analysis of the binary.",
		promptSnippet: "Read an installed app's plist, signature and encryption state",
		parameters: Type.Object({
			bundleId: Type.String({ description: "Bundle id，例如 com.example.app" }),
			device: deviceParam,
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const result = await gateway.request(
				picked.id,
				{ t: "app_info", bundleId: params.bundleId },
				{ timeoutMs: 60_000 },
			);
			if (!result.ok) return failure(`读取失败：${result.error ?? "未知错误"}`);
			let info: Record<string, unknown>;
			try {
				info = parseJson(result.stdout, "app_info") as Record<string, unknown>;
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			const lines = [
				`名称：${info.name || "?"}`,
				`版本：${info.version || "?"} (${info.build || "?"}) · 最低系统 ${info.minimumOS || "?"}`,
				`路径：${info.path}`,
				`可执行：${info.executable || "?"} · ${info.arch || "未知架构"}${info.cryptid ? ` · cryptid ${info.cryptid}（未解密）` : " · 已解密（cryptid 0）"}`,
				`框架：${Array.isArray(info.frameworks) && info.frameworks.length > 0 ? (info.frameworks as string[]).join(", ") : "无"}`,
				`URL Scheme：${Array.isArray(info.urlSchemes) && info.urlSchemes.length > 0 ? (info.urlSchemes as string[]).join(", ") : "无"}`,
				`签名：${info.hasCodeSignature ? "有 _CodeSignature" : "无 _CodeSignature"} · 描述文件：${info.hasEmbeddedProvision ? "有" : "无"}`,
				`数据容器：${info.containerPath || "未找到"}`,
				`包大小：${info.bundleSize ?? 0} 字节`,
			];
			if (typeof info.entitlements === "string" && info.entitlements.trim()) {
				lines.push(`entitlements：\n${truncate(info.entitlements, 4000)}`);
			}
			if (info.provisionEntitlements && typeof info.provisionEntitlements === "object") {
				lines.push(
					`描述文件：${info.provisionUUID || "?"} · ${info.provisionName || "?"} · 到期 ${info.provisionExpiration || "?"} · 应用标识 ${info.provisionApplicationIdentifier || "?"}`,
				);
				lines.push(
					`描述文件 entitlements：\n${truncate(JSON.stringify(info.provisionEntitlements, null, 2), 4000)}`,
				);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: { ok: true } };
		},
	});

	const profiles = defineTool({
		name: "ios_profiles",
		label: "List provisioning profiles",
		defaultActive: false,
		description:
			"List the provisioning profiles present on the device with UUID, name, team, expiry and path. XML profiles are parsed; CMS-signed ones show the file facts only.",
		promptSnippet: "List provisioning profiles on the iPhone",
		parameters: Type.Object({ device: deviceParam }),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const result = await gateway.request(picked.id, { t: "profiles_list" }, { timeoutMs: 60_000 });
			if (!result.ok) return failure(`枚举失败：${result.error ?? "未知错误"}`);
			let records: Array<Record<string, unknown>>;
			try {
				records = parseJson(result.stdout, "profiles_list") as Array<Record<string, unknown>>;
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			if (records.length === 0) return failure("设备上没有 provisioning profile");
			const lines = records.map(
				(record) =>
					`- ${record.name || record.file} · ${record.uuid || "无 UUID"} · 团队 ${record.team || "?"} · 到期 ${record.expiration || "?"} · ${record.path}`,
			);
			return {
				content: [{ type: "text", text: `共 ${records.length} 个 profile：\n${lines.join("\n")}` }],
				details: { ok: true },
			};
		},
	});

	const ipaPull = defineTool({
		name: "ios_ipa_pull",
		label: "Pull an installed app as an IPA",
		defaultActive: false,
		description:
			"Package one installed app into an IPA inside the project: the device returns a file manifest, this tool pulls every file (streaming to disk) and zips them in the project container. The IPA lands under evidence/ios/ipa/. FairPlay-encrypted binaries stay encrypted; check cryptid with ios_app_info and use ios_decrypt when needed.",
		promptSnippet: "Pull an installed iOS app as an IPA",
		promptGuidelines: ["Large apps take a while: thousands of small files are pulled one by one"],
		parameters: Type.Object({
			bundleId: Type.String({ description: "Bundle id，例如 com.example.app" }),
			device: deviceParam,
			timeoutSecs: Type.Optional(Type.Number({ description: "单个文件的超时秒数，默认 120" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const timeoutMs = Math.min(Math.max(params.timeoutSecs ?? 120, 5), 1800) * 1000;
			const pulled = await pullAppBundle(ctx, picked.id, params.bundleId, timeoutMs);
			if (!pulled.ok) return failure(pulled.error);
			const safe = params.bundleId.replace(/[^A-Za-z0-9._-]/g, "_");
			const ipaPath = join(
				ctx.workDir(),
				"evidence",
				"ios",
				"ipa",
				`${safe}-${new Date().toISOString().replace(/[:.]/g, "-")}.ipa`,
			);
			try {
				await zipPayload(ctx, pulled.staging, ipaPath);
			} catch (error) {
				rmSync(pulled.staging, { recursive: true, force: true });
				return failure(`打包 IPA 失败：${error instanceof Error ? error.message : String(error)}`);
			}
			rmSync(pulled.staging, { recursive: true, force: true });
			return {
				content: [
					{
						type: "text",
						text: `已生成 ${ipaPath}（${pulled.manifest.entries.length} 个文件，${pulled.total} 字节原始内容）。下一步可用 ipa_info 看结构化信息。`,
					},
				],
				details: { ok: true },
			};
		},
	});

	const install = defineTool({
		name: "ios_install",
		label: "Install an IPA on the iPhone",
		defaultActive: false,
		description:
			"Install an IPA that already exists on the device (push it with ios_file_push first) using appinst or ipainstaller. This changes the device, so it goes through the approval chain.",
		promptSnippet: "Install an IPA on the iPhone",
		parameters: Type.Object({
			path: Type.String({ description: "设备上的 IPA 绝对路径" }),
			device: deviceParam,
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			let command: string;
			try {
				command = await ctx.guard(picked.name, `appinst '${params.path.replace(/'/g, "'\\''")}'`);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const result = await gateway.request(picked.id, { t: "install", path: params.path }, { timeoutMs: 600_000 });
			if (!result.ok) return failure(`安装失败：${result.error ?? "未知错误"}`);
			let info: Record<string, unknown>;
			try {
				info = parseJson(result.stdout, "install") as Record<string, unknown>;
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			const body = String(info.stdout ?? "") + String(info.stderr ?? "");
			return {
				content: [
					{
						type: "text",
						text: `已用 ${info.tool} 安装（退出码 ${info.code}）：\n${truncate(command)}\n${truncate(body)}`,
					},
				],
				details: { ok: true },
			};
		},
	});

	const uninstall = defineTool({
		name: "ios_uninstall",
		label: "Uninstall an app from the iPhone",
		defaultActive: false,
		description:
			"Uninstall one app by bundle id with appinst -u or ipainstaller -u. This destroys app data, so it goes through the approval chain.",
		promptSnippet: "Uninstall an app from the iPhone",
		parameters: Type.Object({
			bundleId: Type.String({ description: "Bundle id" }),
			device: deviceParam,
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			try {
				await ctx.guard(picked.name, `appinst -u '${params.bundleId.replace(/'/g, "'\\''")}'`);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const result = await gateway.request(
				picked.id,
				{ t: "uninstall", bundleId: params.bundleId },
				{ timeoutMs: 180_000 },
			);
			if (!result.ok) return failure(`卸载失败：${result.error ?? "未知错误"}`);
			let info: Record<string, unknown>;
			try {
				info = parseJson(result.stdout, "uninstall") as Record<string, unknown>;
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			return {
				content: [
					{
						type: "text",
						text: `已卸载 ${params.bundleId}（${info.tool}，退出码 ${info.code}）\n${truncate(String(info.stdout ?? "") + String(info.stderr ?? ""))}`,
					},
				],
				details: { ok: true },
			};
		},
	});

	const ipaInfo = defineTool({
		name: "ipa_info",
		label: "Inspect an IPA in the project",
		defaultActive: false,
		description:
			"Read an IPA already in the project (usually from ios_ipa_pull): Info.plist fields, architectures, FairPlay cryptid, frameworks and entry count. Runs unzip and plistutil in the project container.",
		promptSnippet: "Inspect a local IPA",
		parameters: Type.Object({
			path: Type.String({ description: "工程内的 IPA 路径，例如 evidence/ios/ipa/com.example.app-....ipa" }),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			let hostPath: string;
			let container: string;
			try {
				hostPath = insideWorkDir(ctx, params.path);
				container = ctx.container();
				if (!statSync(hostPath).isFile()) throw new Error("不是文件");
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			const cPath = containerPath(ctx, hostPath);
			const list = await execInContainer(container, 'unzip -l "$1"', [cPath], { timeoutMs: 60_000 });
			if (list.code !== 0) return failure(`unzip 失败：${list.stderr || list.stdout}`);
			let plist: Record<string, unknown>;
			try {
				plist = await readIpaPlist(container, cPath);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			const executable = String(plist.CFBundleExecutable ?? "");
			let macho: { arch: string; cryptid: number } | null = null;
			if (executable) {
				const binary = await execInContainer(
					container,
					'unzip -p "$1" "$2"',
					[cPath, `Payload/*.app/${executable}`],
					{
						timeoutMs: 120_000,
					},
				);
				if (binary.code === 0) macho = machoInfo(binary.stdoutBytes);
			}
			const entries = list.stdout.split("\n").filter((line) => /Payload\//.test(line)).length;
			const lines = [
				`Bundle id：${plist.CFBundleIdentifier ?? "?"}`,
				`名称：${plist.CFBundleDisplayName ?? plist.CFBundleName ?? "?"}`,
				`版本：${plist.CFBundleShortVersionString ?? "?"} (${plist.CFBundleVersion ?? "?"}) · 最低系统 ${plist.MinimumOSVersion ?? "?"}`,
				`可执行：${executable || "?"} · ${macho?.arch ?? "未知架构"}${macho && macho.cryptid !== 0 ? ` · cryptid ${macho.cryptid}（未解密，静态分析二进制会失败）` : " · 已解密（cryptid 0）"}`,
				`文件条目：${entries} · IPA 大小 ${statSync(hostPath).size} 字节`,
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { ok: true } };
		},
	});

	const ipaFiles = defineTool({
		name: "ipa_files",
		label: "List IPA entries",
		defaultActive: false,
		description:
			"List the entries of an IPA in the project with unzip -l; use it to find the binary, frameworks and resources before reading them.",
		promptSnippet: "List the files inside a local IPA",
		parameters: Type.Object({ path: Type.String({ description: "工程内的 IPA 路径" }) }),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			let hostPath: string;
			try {
				hostPath = insideWorkDir(ctx, params.path);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			const result = await execInContainer(ctx.container(), 'unzip -l "$1"', [containerPath(ctx, hostPath)], {
				timeoutMs: 60_000,
			});
			if (result.code !== 0) return failure(`unzip 失败：${result.stderr || result.stdout}`);
			return { content: [{ type: "text", text: truncate(result.stdout, 12_000) }], details: { ok: true } };
		},
	});

	const ipaStrings = defineTool({
		name: "ipa_strings",
		label: "Extract strings from an IPA binary",
		defaultActive: false,
		description:
			"Run strings over the app executable inside an IPA (or a named entry) in the project container. Use it for quick triage of endpoints, keys, class names and error text without decompiling. For encrypted binaries the output is noise: check cryptid with ipa_info first.",
		promptSnippet: "Extract strings from a binary inside a local IPA",
		promptGuidelines: [
			"Pass entry to target a framework or dylib instead of the main executable",
			"Raise minLength to cut noise, lower it to catch short secrets",
		],
		parameters: Type.Object({
			path: Type.String({ description: "工程内的 IPA 路径" }),
			entry: Type.Optional(Type.String({ description: "IPA 内条目；省略时用主可执行文件" })),
			minLength: Type.Optional(Type.Number({ description: "最短字符串长度，默认 6，范围 4-64" })),
			maxChars: Type.Optional(Type.Number({ description: "最多返回字符数，默认 20000" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			let hostPath: string;
			let container: string;
			try {
				hostPath = insideWorkDir(ctx, params.path);
				container = ctx.container();
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			const cPath = containerPath(ctx, hostPath);
			let entry = params.entry?.trim();
			if (!entry) {
				try {
					const plist = await readIpaPlist(container, cPath);
					const executable = String(plist.CFBundleExecutable ?? "");
					if (!executable) throw new Error("Info.plist 里没有 CFBundleExecutable");
					entry = `Payload/*.app/${executable}`;
				} catch (error) {
					return failure(error instanceof Error ? error.message : String(error));
				}
			}
			const minLength = Math.min(Math.max(Math.round(params.minLength ?? 6), 4), 64);
			const maxChars = Math.min(Math.max(Math.round(params.maxChars ?? 20_000), 1000), 200_000);
			const result = await execInContainer(
				container,
				'unzip -p "$1" "$2" | strings -n "$3" | head -c "$4"',
				[cPath, entry, String(minLength), String(maxChars)],
				{ timeoutMs: 300_000 },
			);
			if (result.code !== 0) return failure(`strings 失败：${result.stderr || result.stdout}`);
			const body = result.stdout.trim();
			if (!body) return failure(`没有从 ${entry} 提取到字符串（二进制已加密？先用 ipa_info 看 cryptid）`);
			return {
				content: [{ type: "text", text: `strings ${entry}（最短 ${minLength}）：\n${truncate(body, maxChars)}` }],
				details: { ok: true },
			};
		},
	});

	const ipaSearch = defineTool({
		name: "ipa_search",
		label: "Search text across an IPA",
		defaultActive: false,
		description:
			"Unzip an IPA in the project container and grep -E across every file (binary included, as text) for a pattern: domains, SDK names, hardcoded keys, feature flags. Returns file:line matches. Check cryptid with ipa_info first when searching the executable.",
		promptSnippet: "Grep text across the files of a local IPA",
		promptGuidelines: [
			"Use an extended regex, for example 'api[_-]?key|secret'",
			"Pass entry to search one file instead of the whole bundle",
		],
		parameters: Type.Object({
			path: Type.String({ description: "工程内的 IPA 路径" }),
			pattern: Type.String({ description: "grep -E 正则" }),
			entry: Type.Optional(Type.String({ description: "只搜 IPA 内某个条目" })),
			maxResults: Type.Optional(Type.Number({ description: "最多返回行数，默认 100，上限 500" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			let hostPath: string;
			let container: string;
			try {
				hostPath = insideWorkDir(ctx, params.path);
				container = ctx.container();
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			const maxResults = Math.min(Math.max(Math.round(params.maxResults ?? 100), 1), 500);
			const result = await execInContainer(
				container,
				'set -e; tmp=$(mktemp -d); trap \'rm -rf "$tmp"\' EXIT; unzip -q -o "$1" -d "$tmp"; if [ -n "$3" ]; then grep -a -n -E --binary-files=text -m "$4" -e "$2" "$tmp/$3" || true; else grep -r -a -n -E --binary-files=text -m "$4" -e "$2" "$tmp" | head -n "$4" || true; fi',
				[containerPath(ctx, hostPath), params.pattern, params.entry?.trim() ?? "", String(maxResults)],
				{ timeoutMs: 300_000 },
			);
			if (result.code !== 0) return failure(`搜索失败：${result.stderr || result.stdout}`);
			const body = result.stdout.trim();
			if (!body) return failure(`没有匹配 ${params.pattern}`);
			return {
				content: [
					{ type: "text", text: `匹配 ${params.pattern}（最多 ${maxResults} 行）：\n${truncate(body, 20_000)}` },
				],
				details: { ok: true },
			};
		},
	});

	const ipaPlist = defineTool({
		name: "ipa_plist",
		label: "Print one plist from an IPA",
		defaultActive: false,
		description:
			"Extract one entry from an IPA in the project and print it as an XML plist: Info.plist, a framework Info.plist, an app extension, an entitlements file. Binary plists are converted with plistutil in the project container.",
		promptSnippet: "Print a plist entry from a local IPA",
		parameters: Type.Object({
			path: Type.String({ description: "工程内的 IPA 路径" }),
			entry: Type.String({ description: "IPA 内条目，例如 Payload/Demo.app/Info.plist" }),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			let hostPath: string;
			let container: string;
			try {
				hostPath = insideWorkDir(ctx, params.path);
				container = ctx.container();
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			const cPath = containerPath(ctx, hostPath);
			const result = await execInContainer(
				container,
				'unzip -p "$1" "$2" > /tmp/sentinel-entry; if command -v plistutil >/dev/null 2>&1 && plistutil -i /tmp/sentinel-entry -o /tmp/sentinel-entry.xml 2>/dev/null; then cat /tmp/sentinel-entry.xml; else cat /tmp/sentinel-entry; fi',
				[cPath, params.entry],
				{ timeoutMs: 60_000 },
			);
			if (result.code !== 0) return failure(`读取失败：${result.stderr || result.stdout}`);
			if (!result.stdout.trim()) return failure(`${params.entry} 不存在或为空`);
			try {
				parsePlistXml(result.stdout);
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `${params.entry} 不是可解析的 XML plist，原样返回前 8000 字符：\n${truncate(result.stdout, 8000)}`,
						},
					],
					details: { ok: true },
				};
			}
			return { content: [{ type: "text", text: truncate(result.stdout, 20_000) }], details: { ok: true } };
		},
	});

	const deps = defineTool({
		name: "ios_deps",
		label: "Check optional iOS tooling",
		defaultActive: false,
		description:
			"Check which optional root tools are present on the iPhone: tcpdump, frida-server, appinst/ipainstaller, ldid, bfdecrypt, keychain_dumper. Returns the absolute path when found and the Sileo/ios_frida_setup step when missing. Read-only: it installs nothing.",
		promptSnippet: "Check optional iOS tools before assuming a capability works",
		promptGuidelines: [
			"Run this after install and after a failed tool: the daemon itself is installed by deb, but tcpdump/frida/appinst/ldid are separate packages",
			"Missing dependencies are not errors: tell the operator the exact Sileo package or ios_frida_setup step",
		],
		parameters: Type.Object({ device: deviceParam }),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const tools: Array<{ name: string; paths: string[] }> = [
				{ name: "tcpdump", paths: ["/var/jb/usr/bin/tcpdump", "/usr/bin/tcpdump"] },
				{
					name: "frida-server",
					paths: ["/var/jb/usr/sbin/frida-server", "/usr/sbin/frida-server", "/usr/bin/frida-server"],
				},
				{ name: "appinst", paths: ["/var/jb/usr/bin/appinst", "/usr/bin/appinst"] },
				{ name: "ipainstaller", paths: ["/var/jb/usr/bin/ipainstaller", "/usr/bin/ipainstaller"] },
				{ name: "ldid", paths: ["/var/jb/usr/bin/ldid", "/usr/bin/ldid"] },
				{ name: "bfdecrypt", paths: ["/var/jb/usr/bin/bfdecrypt", "/usr/bin/bfdecrypt"] },
				{ name: "keychain_dumper", paths: ["/var/jb/usr/bin/keychain_dumper", "/usr/bin/keychain_dumper"] },
			];
			const checks = tools
				.map(
					(tool) =>
						`found=""; for p in ${tool.paths.join(" ")}; do if [ -x "$p" ]; then found="$p"; break; fi; done; if [ -z "$found" ]; then found="$(command -v ${tool.name} 2>/dev/null || true)"; fi; if [ -n "$found" ]; then echo "OK ${tool.name} $found"; else echo "MISSING ${tool.name}"; fi`,
				)
				.join("\n");
			const result = await gateway.request(
				picked.id,
				{ t: "exec", cmd: checks, asRoot: false, timeoutMs: 30_000 },
				{ timeoutMs: 40_000 },
			);
			if (!result.ok) return failure(`检查失败：${result.error ?? "未知错误"}`);
			const output = result.stdout ?? "";
			const missing = tools.filter((tool) => !output.includes(`OK ${tool.name} `));
			const lines = tools.map((tool) => {
				const match = output.match(new RegExp(`OK ${tool.name} (\\S+)`));
				return match ? `- ${tool.name}: ${match[1]}` : `- ${tool.name}: 缺失`;
			});
			const hints = missing
				.map((tool) => {
					switch (tool.name) {
						case "frida-server":
							return "frida-server：把匹配版本的 ios-arm64 二进制放到 /work/frida-server，再运行 ios_frida_setup";
						case "tcpdump":
							return "tcpdump：Sileo 安装 tcpdump（或 install-ios.sh --with-deps）";
						case "appinst":
						case "ipainstaller":
							return `${tool.name}：Sileo 安装 appinst/ipainstaller（或 --with-deps）`;
						case "ldid":
							return "ldid：Sileo 安装 ldid（用于解密后重签）";
						case "bfdecrypt":
							return "bfdecrypt：Sileo 安装 bfdecrypt（frida dump 失败时的回退）";
						case "keychain_dumper":
							return "keychain_dumper：Sileo 安装 keychain_dumper（否则只能用 frida SecItemCopyMatching）";
						default:
							return `${tool.name}：用 Sileo 安装`;
					}
				})
				.join("\n");
			return {
				content: [
					{
						type: "text",
						text: `设备 ${picked.name} 的可选工具：\n${lines.join("\n")}${missing.length > 0 ? `\n\n缺失 ${missing.length} 项：\n${hints}` : "\n\n全部可用。"}`,
					},
				],
				details: { ok: true },
			};
		},
	});

	return [
		devices,
		shell,
		pull,
		push,
		screencap,
		apps,
		appInfo,
		profiles,
		ipaPull,
		install,
		uninstall,
		ipaInfo,
		ipaFiles,
		ipaStrings,
		ipaSearch,
		ipaPlist,
		deps,
	];
}
