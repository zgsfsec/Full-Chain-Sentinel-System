/**
 * The agent's hands on replayd, the in-container packet replay service.
 *
 * Two tools, activated by the conversation's report-center switch and never
 * handed to an engineering task's worker or a sub-agent. The screenshot tool
 * states its purpose in `purpose`; sending still follows the approval chain.
 *
 * What they are for:
 *
 *   - `replay_capture` — evidence for the report: send the packet and screenshot
 *                        replayd's own Repeater window (request + response +
 *                        Beijing-time evidence panel), so a finding is one image an
 *                        operator can attach, and the model has to state in
 *                        `purpose` what the image proves.
 *   - `replay_flows`   — read that container's capture history.
 *
 * Deliberately absent, and why:
 *
 *   - A plain "send this raw packet" tool: the agent already sends requests with
 *     curl through bash, which is on the same approval chain, and the operator
 *     chose the smaller toolset. Byte-level fidelity (malformed Content-Length,
 *     hand-made chunked, exact header order and casing) is what replayd's engine
 *     adds over curl, so a packet that needs it has to go through bash with
 *     `nc`/python instead — that trade is deliberate.
 *   - Rendering an arbitrary URL (`POST /api/render`): a general-purpose
 *     fetch-and-see tool, not a packet tool. The operator can still use it from
 *     replayd's own UI.
 *
 * Sending reaches the target, so it goes through the same approval chain as
 * container bash (mode auto/review/ai) and the operator can edit the packet on the
 * approval card before it is sent. Reading history does not.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ReplaydStatus, replaydArtifact, replaydRequest } from "./replayd.ts";

/** Every tool name controlled by the conversation's report-center switch. */
export const REPLAY_TOOL_NAMES: readonly string[] = ["replay_capture", "replay_flows"];

/** What the runtime provides; the container and the approval chain stay behind it. */
export interface ReplayToolContext {
	/** The issuing conversation's report-center switch, independent of the viewed session. */
	enabled: () => boolean;
	/** The active project's container. */
	container: () => string;
	/** Host work directory; screenshots are saved under it. */
	workDir: () => string;
	/**
	 * The approval chain for actions that reach the target. Returns the payload
	 * that may run (the approval card may edit it), or rejects with a Chinese
	 * reason when it must not. `tool` is the tool being called, so the audit row
	 * names it.
	 */
	guard: (tool: string, summary: string, payload: string) => Promise<string>;
	/** Start the service when needed; replayd.ts caches a healthy answer. */
	ensure: (options?: { force?: boolean }) => Promise<ReplaydStatus>;
}

const MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024;

/**
 * A model writes `\n` between header lines far more often than `\r\n`, and a
 * strict server (Node, nginx) answers 400 for the LF form — which reads as "the
 * target is broken" instead of "the packet is". A packet with no CR at all is
 * sent with CRLF and the result says so; one that already contains CR (bare CR,
 * mixed endings, smuggling probes) is passed through byte-for-byte, because the
 * engine's whole point is sending exactly what was written.
 */
function normalizeLineEndings(raw: string): { raw: string; normalized: boolean } {
	if (raw.includes("\r")) return { raw, normalized: false };
	return { raw: raw.replace(/\n/g, "\r\n"), normalized: true };
}

/**
 * `socks5://alice:s3cret@h:1080` → `socks5://alice:***@h:1080`.
 *
 * The approval card and the audit row name the exit the packet will take; the
 * password is not part of that, and the audit is read later by people who do not
 * need it.
 */
function maskProxyCredentials(url: string): string {
	return url.replace(/^(socks5h?:\/\/)([^:@/]+):([^@/]*)@/i, "$1$2:***@");
}

function failure(text: string): AgentToolResult<{ ok: boolean }> {
	return { content: [{ type: "text", text }], details: { ok: false }, isError: true };
}

function truncate(text: string | undefined, max = 16_000): string {
	const value = text ?? "";
	if (value.length <= max) return value;
	return `${value.slice(0, max)}\n…[输出过长已截断，共 ${value.length} 字符]`;
}

/**
 * Turn the service's error text into something the operator can act on. The one
 * failure that is not the agent's fault is a container image without a browser.
 */
function actionable(error: string): string {
	if (/upstream_(auth|connect)|SOCKS|socks5/i.test(error)) {
		return `${error}\n（代理不可达或认证失败：确认地址是容器视角的——host 网络下 127.0.0.1 是宿主机，bridge 下要写 host.docker.internal 或把代理放进容器；带认证时写成 socks5://user:password@host:port）`;
	}
	if (error.includes("浏览器")) {
		return `${error}\n（容器镜像里没有 Chromium，截图需要它：请操作员在「设置 → 环境」重建镜像，或先在容器内执行 POST /api/render/browser/install 下载 headless shell）`;
	}
	return error;
}

/** The service, or the reason the tool cannot run. */
async function service(ctx: ReplayToolContext): Promise<{ status: ReplaydStatus } | { error: string }> {
	const status = await ctx.ensure();
	if (status.state !== "running" || status.port === undefined) {
		return { error: `replayd 不可用（${status.state}）：${status.error ?? "未知原因"}` };
	}
	return { status };
}

/** Timestamped evidence file name, matching the other tools' `evidence/<kind>/` layout. */
function evidencePath(workDir: string, prefix: string, extension: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = join(workDir, "evidence", "replay");
	mkdirSync(dir, { recursive: true });
	return join(dir, `${prefix}-${stamp}.${extension}`);
}

interface ScreenshotResult {
	/** Line for the text block. */
	note: string;
	/** Image block, when the PNG is small enough to inline. */
	image?: { type: "image"; data: string; mimeType: string };
}

/** Save a screenshot as evidence and prepare the model-visible image block. */
async function collectScreenshot(
	ctx: ReplayToolContext,
	container: string,
	port: number,
	artifactId: string | undefined,
	prefix: string,
	options: { signal?: AbortSignal } = {},
): Promise<ScreenshotResult | { error: string }> {
	if (artifactId === undefined || artifactId === "") return { error: "replayd 没有返回截图产物" };
	const artifact = await replaydArtifact(container, port, artifactId, { signal: options.signal });
	if (!artifact.ok) return { error: `取截图失败：${artifact.error}` };
	const target = evidencePath(ctx.workDir(), prefix, "png");
	writeFileSync(target, artifact.bytes);
	const relative = join("evidence", "replay", target.split(/[\\/]/).pop() ?? "shot.png");
	const note = `截图已存证：${relative}（${artifact.bytes.length} 字节）`;
	if (artifact.bytes.length > MAX_INLINE_IMAGE_BYTES) return { note };
	return { note, image: { type: "image", data: artifact.bytes.toString("base64"), mimeType: "image/png" } };
}

/** Response headers as they arrived, one per line. */
interface CaptureResponseView {
	status?: string;
	statusLine?: string;
	responseHeaders?: string;
	responsePreview?: string;
	evidenceMode?: string;
	evidenceWatermark?: string;
	highlightsApplied?: string[];
	highlightsMissing?: string[];
	sendError?: string;
	/** The SOCKS5 exit this send went through, echoed back by replayd. */
	upstreamProxy?: string;
	screenshots?: Record<string, { artifactId?: string; size?: number }>;
	timings?: { sentMs?: number; evidenceMs?: number; totalMs?: number };
	flowId?: string;
	error?: { code?: string; message?: string };
}

interface FlowsView {
	items?: Array<{
		id?: string;
		ts?: string;
		source?: string;
		method?: string;
		scheme?: string;
		host?: string;
		port?: number;
		path?: string;
		status?: number;
		respSize?: number;
		note?: string;
		error?: { code?: string; message?: string } | null;
	}>;
	total?: number;
	hasMore?: boolean;
	nextCursor?: string | null;
}

export function createReplayTools(ctx: ReplayToolContext): ToolDefinition[] {
	const capture = defineTool({
		name: "replay_capture",
		label: "Capture a packet exchange as report evidence",
		defaultActive: false,
		description:
			"Evidence capture for the report, not a way to send packets. It sends the request and returns a PNG of replayd's own Repeater window: the request on the left, the response in the middle and the Beijing-time evidence panel on the right, with your highlights — the one image a report or a judge needs. Call it ONLY when the operator wants a screenshot for the report (or a confirmed finding needs a picture), and say why in `purpose`. For exploring, iterating and verifying, send the request with curl through bash instead: the operator already approves those, and a screenshot takes seconds and a browser. Also returns the status line, the response headers and the evidence watermark as text, so the result is usable without looking at the image. Goes through the approval chain and the operator can edit the packet first.",
		promptSnippet: "Capture a packet exchange as a screenshot for the report",
		promptGuidelines: [
			"Only for report evidence: the operator asked for a screenshot, or a finding is confirmed and needs a picture. Probing, re-sending and payload checks belong in bash (curl), which is on the same approval chain.",
			"`purpose` is required and is shown to the operator on the approval card: write what the image proves, e.g. 「未授权访问 /admin 的留证（返回 role=admin）」.",
			'Highlight the payload and the echo so the screenshot proves the finding: pass highlightResponse: ["token="] and highlightRequest: ["Host:"].',
			'Use evidenceMode "snapshot" (default) when the time source refuses to be embedded, "direct" to show the live site clock.',
			"When the target is only reachable through a SOCKS5 proxy, pass `proxy`: the send goes out through it (the operator sees the proxy on the approval card), and the screenshot shows the exchange as it happened.",
			"Look at the image you get back: if the time panel still reads 加载中, call again with evidenceSettleMs: 4000 so the panel is painted before the shot.",
		],
		parameters: Type.Object({
			purpose: Type.String({
				description: "这张截图要证明什么（会显示在审批卡与审计里），例如「未授权访问 /admin 的留证」",
			}),
			raw: Type.String({ description: "完整原始请求报文" }),
			host: Type.Optional(Type.String({ description: "覆盖目标主机" })),
			port: Type.Optional(Type.Integer({ description: "覆盖目标端口" })),
			scheme: Type.Optional(Type.Union([Type.Literal("http"), Type.Literal("https")], { description: "覆盖协议" })),
			insecureTLS: Type.Optional(Type.Boolean({ description: "https 不校验证书，默认 true" })),
			highlightRequest: Type.Optional(
				Type.Array(Type.String(), { description: "请求里要高亮的文本片段（最多 20 个）" }),
			),
			highlightResponse: Type.Optional(
				Type.Array(Type.String(), { description: "响应里要高亮的文本片段（最多 20 个）" }),
			),
			highlightColor: Type.Optional(
				Type.Union([Type.Literal("yellow"), Type.Literal("green"), Type.Literal("red"), Type.Literal("blue")], {
					description: "高亮颜色，默认 yellow",
				}),
			),
			evidenceMode: Type.Optional(
				Type.Union([Type.Literal("auto"), Type.Literal("direct"), Type.Literal("snapshot")], {
					description: "北京时间取证面板的取源方式，默认 snapshot",
				}),
			),
			evidenceSettleMs: Type.Optional(
				Type.Integer({ description: "取证面板画完前额外等待的毫秒数，默认 0（用服务端默认值）" }),
			),
			includeContent: Type.Optional(Type.Boolean({ description: "同时回读响应正文预览，默认 true" })),
			width: Type.Optional(Type.Integer({ description: "截图宽度，默认 1600" })),
			height: Type.Optional(Type.Integer({ description: "截图高度，默认 1000" })),
			proxy: Type.Optional(
				Type.String({
					description:
						"SOCKS5 出口，只影响这一次发送：socks5://[user:password@]host:port。目标站只有经代理可达、或域名只能由代理解析时用。地址是容器视角（host 网络下 127.0.0.1 就是宿主机；bridge 下用 host.docker.internal）",
				}),
			),
		}),
		async execute(
			_toolCallId,
			params,
			signal,
		): Promise<AgentToolResult<{ ok: boolean; flowId?: string; path?: string }>> {
			if (!ctx.enabled()) return failure("请先在当前对话启用报告中心");
			// Checked before the service is touched: a call that cannot be accepted must
			// not push a 20 MB binary into the container first.
			const purpose = (params.purpose ?? "").trim();
			if (purpose === "") {
				return failure(
					"purpose 不能为空：写明这张截图要证明什么（会显示在审批卡与审计里），例如「未授权访问 /admin 的留证」",
				);
			}
			// Validated before the service is started: a typo in the proxy must not push
			// a 20 MB binary into the container, and must not look like a target failure.
			let proxy: string | undefined;
			const rawProxy = (params.proxy ?? "").trim();
			if (rawProxy !== "") {
				if (!/^socks5h?:\/\//i.test(rawProxy)) {
					return failure(`proxy 只支持 SOCKS5：socks5://[user:password@]host:port（收到 ${rawProxy}）`);
				}
				proxy = rawProxy;
			}
			const ready = await service(ctx);
			if ("error" in ready) return failure(ready.error);
			const normalized = normalizeLineEndings(params.raw);
			let raw = normalized.raw;
			try {
				raw = await ctx.guard(
					"replay_capture",
					`报告留证截图（${purpose}）${describeTarget(normalized.raw, params.host, params.port, params.scheme)}${proxy ? `（经 ${maskProxyCredentials(proxy)}）` : ""}`,
					normalized.raw,
				);
			} catch (error) {
				return failure(String(error));
			}
			if (!ctx.enabled()) return failure("请先在当前对话启用报告中心");
			if (raw.trim() === "") return failure("审批被拒绝：请求报文为空");
			const highlight =
				params.highlightRequest || params.highlightResponse
					? {
							request: params.highlightRequest ?? [],
							response: params.highlightResponse ?? [],
							color: params.highlightColor ?? "yellow",
						}
					: undefined;
			const result = await replaydRequest<CaptureResponseView>({
				container: ctx.container(),
				port: ready.status.port!,
				method: "POST",
				path: "/api/capture",
				body: {
					raw,
					...(targetOf(params.host, params.port, params.scheme) ?? {}),
					insecureTLS: params.insecureTLS ?? true,
					evidenceMode: params.evidenceMode ?? "snapshot",
					...(params.evidenceSettleMs === undefined ? {} : { evidenceSettleMs: params.evidenceSettleMs }),
					includeContent: params.includeContent ?? true,
					...(highlight === undefined ? {} : { highlight }),
					...(params.width === undefined ? {} : { width: params.width }),
					...(params.height === undefined ? {} : { height: params.height }),
					...(proxy === undefined ? {} : { upstreamProxy: proxy }),
				},
				timeoutMs: 240_000,
				signal,
			});
			if (!result.ok) return failure(actionable(result.error));
			const view = result.data;
			if (view.error)
				return failure(`截图失败（${view.error.code ?? "error"}）：${actionable(view.error.message ?? "")}`);
			const shot = await collectScreenshot(
				ctx,
				ctx.container(),
				ready.status.port!,
				view.screenshots?.viewport?.artifactId,
				"capture",
				{ signal },
			);
			if ("error" in shot) return failure(shot.error);
			const lines = [
				`留证用途：${purpose}`,
				view.statusLine || "（未回读到状态行）",
				"",
				truncate(view.responseHeaders ?? "（无响应头）", 4000),
			];
			if (view.upstreamProxy) lines.push(`出口：${view.upstreamProxy}`);
			if (view.evidenceWatermark) lines.push("", `取证：${view.evidenceWatermark}`);
			if (view.highlightsApplied?.length) lines.push(`已高亮：${view.highlightsApplied.join("、")}`);
			if (view.highlightsMissing?.length) lines.push(`未找到的片段：${view.highlightsMissing.join("、")}`);
			// A proxy that cannot be reached surfaces here (the page's send fails), so the
			// actionable hint belongs on this line, not only on the service error path.
			if (view.sendError) lines.push(`发送异常：${actionable(view.sendError)}`);
			const timings = view.timings;
			if (timings)
				lines.push(
					`耗时：发送 ${timings.sentMs ?? 0}ms · 取证 ${timings.evidenceMs ?? 0}ms · 合计 ${timings.totalMs ?? 0}ms`,
				);
			if (normalized.normalized) lines.push("（报文原本只有 LF 换行，已按 CRLF 发送）");
			if (view.flowId) lines.push(`flowId：${view.flowId}`);
			lines.push("", shot.note);
			const content: AgentToolResult<{ ok: boolean; flowId?: string; path?: string }>["content"] = [
				{ type: "text", text: lines.join("\n") },
			];
			if (shot.image) content.push(shot.image);
			return { content, details: { ok: true, flowId: view.flowId, path: shot.note } };
		},
	});

	const flows = defineTool({
		name: "replay_flows",
		label: "List captured and replayed HTTP flows",
		defaultActive: false,
		description:
			"List the HTTP flows replayd has recorded in this project's container: everything the MITM proxy captured and every replay, newest first, with host/method/status filters. Read-only, so it does not go through the approval chain. Use it to look up a flowId returned by the other tools, or to see what a page requested through the proxy.",
		promptSnippet: "List the captured/replayed HTTP flows of this project",
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer({ description: "条数，默认 20，最大 200" })),
			host: Type.Optional(Type.String({ description: "按主机过滤" })),
			q: Type.Optional(Type.String({ description: "按主机或路径关键字过滤" })),
			source: Type.Optional(
				Type.Union([Type.Literal("replay"), Type.Literal("proxy")], { description: "只看待重放或只看代理抓包" }),
			),
		}),
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ ok: boolean; total?: number }>> {
			if (!ctx.enabled()) return failure("请先在当前对话启用报告中心");
			const ready = await service(ctx);
			if ("error" in ready) return failure(ready.error);
			const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
			const query = new URLSearchParams({ limit: String(limit) });
			if (params.host) query.set("host", params.host);
			if (params.q) query.set("q", params.q);
			if (params.source) query.set("source", params.source);
			const result = await replaydRequest<FlowsView>({
				container: ctx.container(),
				port: ready.status.port!,
				method: "GET",
				path: `/api/flows?${query.toString()}`,
				timeoutMs: 30_000,
				signal,
			});
			if (!result.ok) return failure(actionable(result.error));
			const items = result.data.items ?? [];
			if (items.length === 0) {
				return {
					content: [
						{ type: "text", text: "这个项目的容器里还没有任何 HTTP 记录（代理没抓到包，也还没重放过）。" },
					],
					details: { ok: true, total: 0 },
				};
			}
			const lines = items.map((item) => {
				const target = `${item.scheme ?? "http"}://${item.host ?? "?"}${item.port ? `:${item.port}` : ""}${item.path ?? "/"}`;
				const status = item.error?.code ? `错误 ${item.error.code}` : `${item.status ?? "?"}`;
				return `${item.ts ?? ""}  [${item.source ?? "?"}] ${item.method ?? "?"} ${target} → ${status} · ${item.respSize ?? 0}B${item.note ? ` · ${item.note}` : ""} · ${item.id ?? ""}`;
			});
			const header = `共 ${result.data.total ?? items.length} 条${result.data.hasMore ? "（还有更多）" : ""}，显示 ${items.length} 条：`;
			return {
				content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
				details: { ok: true, total: result.data.total },
			};
		},
	});

	return [capture, flows];
}

/** Explicit target override, or undefined to let the packet's Host header decide. */
function targetOf(
	host: string | undefined,
	port: number | undefined,
	scheme: string | undefined,
): { scheme?: string; host: string; port?: number } | undefined {
	if (!host && port === undefined && !scheme) return undefined;
	const target: { scheme?: string; host: string; port?: number } = { host: host ?? "" };
	if (port !== undefined) target.port = port;
	if (scheme !== undefined) target.scheme = scheme;
	return target.host === "" && target.port === undefined ? undefined : target;
}

/** One-line description of a packet for the approval card and the audit trail. */
function describeTarget(
	raw: string,
	host: string | undefined,
	port: number | undefined,
	scheme: string | undefined,
): string {
	const requestLine = raw.split("\n", 1)[0]?.trim() ?? "";
	const hostHeader = /^host:\s*(.+)$/im.exec(raw)?.[1]?.trim();
	const target = host ?? hostHeader ?? "?";
	const portPart = port === undefined ? "" : `:${port}`;
	return `${requestLine} → ${scheme ? `${scheme}://` : ""}${target}${portPart}`;
}
