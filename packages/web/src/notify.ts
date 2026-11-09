/**
 * DingTalk and Feishu custom-robot notifications.
 *
 * A finished run posts a message to every enabled group robot. Sends are
 * best-effort: they never block or fail the agent run, and the outcome of the
 * most recent attempt is kept for the settings screen.
 *
 * Both platforms support the same two security modes:
 * - "加签" (signed): HMAC-SHA256 over a timestamp/secret pairing. DingTalk puts
 *   the signature in the query string; Feishu puts timestamp and sign in the
 *   JSON body.
 * - "自定义关键词" (keyword): the message body must contain the keyword, so it is
 *   prepended to the text.
 */

import { createHmac } from "node:crypto";
import { t } from "./i18n.ts";
import type {
	SentinelCodeCommit,
	SentinelCodeMonitor,
	SentinelNotifyChannelConfig,
	SentinelNotifyConfig,
	SentinelNotifyDelivery,
	SentinelNotifyKind,
	SentinelNotifyStatus,
	SentinelTestResult,
	SentinelVulnerability,
} from "./protocol.ts";
import { SESSION_STATUS_LABELS, type SentinelSessionStatus } from "./session-status.ts";
import { SENTINEL_VULN_SEVERITY_LABELS, SENTINEL_VULN_STATUS_LABELS } from "./vulnerabilities.ts";

const SEND_TIMEOUT_MS = 10000;
/** Two retries after the first attempt, per the operator's choice. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

/** DingTalk answers 200 with a JSON body; only errcode 0 means delivered. */
interface DingTalkReply {
	errcode?: number;
	errmsg?: string;
}

/**
 * Signed webhook URL: DingTalk requires `timestamp` (ms) and `sign`, where the
 * signature is the base64 HMAC-SHA256 of `${timestamp}\n${secret}`.
 */
export function signedWebhookUrl(webhook: string, secret: string, timestampMs: number): string {
	if (!secret) return webhook;
	const stringToSign = `${timestampMs}\n${secret}`;
	const sign = createHmac("sha256", secret).update(stringToSign, "utf-8").digest("base64");
	const separator = webhook.includes("?") ? "&" : "?";
	return `${webhook}${separator}timestamp=${timestampMs}&sign=${encodeURIComponent(sign)}`;
}

/** A DingTalk markdown body, with the keyword prepended when one is configured. */
export function buildPayload(config: SentinelNotifyChannelConfig, title: string, markdown: string): string {
	const prefix = config.keyword ? `${config.keyword}\n` : "";
	return JSON.stringify({
		msgtype: "markdown",
		markdown: { title, text: `${prefix}${markdown}` },
		at: { isAtAll: false },
	});
}

/** DingTalk rejects a request body over this many bytes with errcode 460101. */
const MAX_BODY_BYTES = 20000;
/** Room for the JSON envelope, the keyword, and the trailing note. */
const BODY_BYTE_MARGIN = 300;

/** Keep the first `limit` characters; 0 keeps all of it. */
export function clipText(text: string, limit: number): string {
	if (limit <= 0 || text.length <= limit) return text;
	return `${text.slice(0, limit)}…（已截断，全文 ${text.length} 字）`;
}

/** The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes. */
function clipToBytes(text: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf-8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return text.slice(0, end);
}

/**
 * The request body, clipped until it fits DingTalk's own limit.
 *
 * The character limit each section applies is the operator's choice; this is the
 * platform's, and it applies to the whole body including the envelope. A summary
 * the operator asked to keep in full still has to fit, so it is cut here and the
 * note says which limit did it.
 */
export function fitPayload(config: SentinelNotifyChannelConfig, title: string, markdown: string): string {
	const overhead = Buffer.byteLength(buildPayload(config, title, ""), "utf-8");
	if (overhead + Buffer.byteLength(markdown, "utf-8") <= MAX_BODY_BYTES) {
		return buildPayload(config, title, markdown);
	}
	const note = `…（超出钉钉单条上限，已截断，全文 ${markdown.length} 字）`;
	const budget = MAX_BODY_BYTES - BODY_BYTE_MARGIN - overhead - Buffer.byteLength(note, "utf-8");
	const kept = budget > 0 ? clipToBytes(markdown, budget) : "";
	return buildPayload(config, title, `${kept}${note}`);
}

/** One delivery attempt. Returns the failure reason, or undefined on success. */
async function attempt(
	config: SentinelNotifyChannelConfig,
	title: string,
	markdown: string,
): Promise<string | undefined> {
	const url = signedWebhookUrl(config.webhook, config.secret, Date.now());
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: fitPayload(config, title, markdown),
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") {
			return t("请求超时（{seconds}s）", { seconds: SEND_TIMEOUT_MS / 1000 });
		}
		const message = error instanceof Error ? error.message : String(error);
		const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
		return cause ? t("{message}：{cause}", { message, cause }) : message;
	}
	if (!response.ok) return `HTTP ${response.status}`;
	let reply: DingTalkReply;
	try {
		reply = (await response.json()) as DingTalkReply;
	} catch {
		return t("响应不是合法 JSON");
	}
	if (reply.errcode === 0) return undefined;
	const hint = reply.errcode === 310000 ? t("（通常是加签校验失败或缺少自定义关键词）") : "";
	return t("钉钉返回 errcode {code}: {message}{hint}", {
		code: String(reply.errcode),
		message: reply.errmsg ?? "",
		hint,
	});
}

/**
 * DingTalk is https-only. http is tolerated for a loopback address so a local
 * relay (or the test suite) can stand in for the robot.
 */
export function webhookUrlError(webhook: string): string | undefined {
	let url: URL;
	try {
		url = new URL(webhook);
	} catch {
		return t("webhook 不是合法的 URL");
	}
	if (url.protocol === "https:") return undefined;
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
	if (url.protocol === "http:" && loopback) return undefined;
	return t("webhook 必须是 https 地址");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Post a markdown notification, retrying a transient failure. Never throws: the
 * caller records the result and moves on.
 */
export async function sendDingTalk(
	config: SentinelNotifyChannelConfig,
	title: string,
	markdown: string,
): Promise<SentinelNotifyStatus> {
	const webhook = config.webhook.trim();
	if (!webhook) {
		return { at: Date.now(), ok: false, error: t("未配置 webhook 地址") };
	}
	const urlError = webhookUrlError(webhook);
	if (urlError) return { at: Date.now(), ok: false, error: urlError };
	let lastError: string | undefined;
	for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
		lastError = await attempt(config, title, markdown);
		if (!lastError) return { at: Date.now(), ok: true };
		if (attemptNumber < MAX_ATTEMPTS) await delay(RETRY_DELAY_MS);
	}
	return { at: Date.now(), ok: false, error: lastError };
}

/** Settings-screen "send a test message" action. */
export async function testDingTalk(config: SentinelNotifyChannelConfig): Promise<SentinelTestResult> {
	if (!config.webhook.trim()) return { ok: false, message: t("请先填写 webhook 地址") };
	const urlError = webhookUrlError(config.webhook.trim());
	if (urlError) return { ok: false, message: urlError, detail: t("钉钉自定义机器人只接受 https。") };
	const status = await sendDingTalk(
		config,
		"全链哨兵 测试通知",
		"### 全链哨兵 测试通知\n\n如果你在群里看到这条消息，通知配置可用。",
	);
	return status.ok
		? { ok: true, message: t("测试消息已发送，请查看钉钉群") }
		: { ok: false, message: t("发送失败"), detail: status.error };
}

/** Feishu custom-bot requests are limited to 30,000 bytes. */
const MAX_FEISHU_BODY_BYTES = 30000;

/**
 * Feishu signature: HMAC-SHA256 with `${timestamp}\n${secret}` as the key and an
 * empty message, base64-encoded. The timestamp is in seconds and rides in the
 * body instead of the query string.
 */
export function feishuSignature(timestampSeconds: number, secret: string): string {
	return createHmac("sha256", `${timestampSeconds}\n${secret}`).update("").digest("base64");
}

/** A Feishu interactive card, with timestamp/sign and the keyword when configured. */
export function buildFeishuPayload(
	config: SentinelNotifyChannelConfig,
	title: string,
	markdown: string,
	timestampSeconds: number,
): string {
	const prefix = config.keyword ? `${config.keyword}\n` : "";
	const payload: Record<string, unknown> = {
		timestamp: String(timestampSeconds),
		msg_type: "interactive",
		card: {
			config: { wide_screen_mode: true },
			header: {
				template: "blue",
				title: { tag: "plain_text", content: title },
			},
			elements: [{ tag: "markdown", content: `${prefix}${markdown}` }],
		},
	};
	if (config.secret) payload.sign = feishuSignature(timestampSeconds, config.secret);
	return JSON.stringify(payload);
}

/** The Feishu body, clipped until it fits the platform's byte limit. */
export function fitFeishuPayload(
	config: SentinelNotifyChannelConfig,
	title: string,
	markdown: string,
	timestampSeconds = Math.floor(Date.now() / 1000),
): string {
	const fits = (body: string) => Buffer.byteLength(body, "utf-8") <= MAX_FEISHU_BODY_BYTES;
	const full = buildFeishuPayload(config, title, markdown, timestampSeconds);
	if (fits(full)) return full;
	const note = `…（超出飞书单条上限，已截断，全文 ${markdown.length} 字）`;
	// JSON escapes quotes and newlines, so measure the serialized card rather
	// than estimating from the raw markdown. Binary search the character prefix.
	let low = 0;
	let high = markdown.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const candidate = buildFeishuPayload(config, title, `${markdown.slice(0, middle)}${note}`, timestampSeconds);
		if (fits(candidate)) low = middle;
		else high = middle - 1;
	}
	return buildFeishuPayload(config, title, `${markdown.slice(0, low)}${note}`, timestampSeconds);
}

interface FeishuReply {
	StatusCode?: number;
	StatusMessage?: string;
	code?: number;
	msg?: string;
}

async function attemptFeishu(
	config: SentinelNotifyChannelConfig,
	title: string,
	markdown: string,
): Promise<string | undefined> {
	const timestamp = Math.floor(Date.now() / 1000);
	let response: Response;
	try {
		response = await fetch(config.webhook, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: fitFeishuPayload(config, title, markdown, timestamp),
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") {
			return t("请求超时（{seconds}s）", { seconds: SEND_TIMEOUT_MS / 1000 });
		}
		const message = error instanceof Error ? error.message : String(error);
		const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
		return cause ? t("{message}：{cause}", { message, cause }) : message;
	}
	if (!response.ok) return `HTTP ${response.status}`;
	let reply: FeishuReply;
	try {
		reply = (await response.json()) as FeishuReply;
	} catch {
		return t("响应不是合法 JSON");
	}
	if (reply.StatusCode === 0 || reply.code === 0) return undefined;
	const code = reply.code ?? reply.StatusCode;
	const message = reply.msg ?? reply.StatusMessage ?? "";
	const hint = code === 19021 ? t("（通常是加签校验失败或缺少自定义关键词）") : "";
	return t("飞书返回 code {code}: {message}{hint}", {
		code: code ?? t("未知"),
		message,
		hint,
	});
}

/**
 * Post a Feishu card, retrying a transient failure. Never throws: the caller
 * records the result and moves on.
 */
export async function sendFeishu(
	config: SentinelNotifyChannelConfig,
	title: string,
	markdown: string,
): Promise<SentinelNotifyStatus> {
	const webhook = config.webhook.trim();
	if (!webhook) return { at: Date.now(), ok: false, error: t("未配置 webhook 地址") };
	const urlError = webhookUrlError(webhook);
	if (urlError) return { at: Date.now(), ok: false, error: urlError };
	let lastError: string | undefined;
	for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
		lastError = await attemptFeishu({ ...config, webhook }, title, markdown);
		if (!lastError) return { at: Date.now(), ok: true };
		if (attemptNumber < MAX_ATTEMPTS) await delay(RETRY_DELAY_MS);
	}
	return { at: Date.now(), ok: false, error: lastError };
}

/** Settings-screen "send a test message" action for Feishu. */
export async function testFeishu(config: SentinelNotifyChannelConfig): Promise<SentinelTestResult> {
	if (!config.webhook.trim()) return { ok: false, message: t("请先填写 webhook 地址") };
	const urlError = webhookUrlError(config.webhook.trim());
	if (urlError) return { ok: false, message: urlError, detail: t("飞书自定义机器人只接受 https。") };
	const status = await sendFeishu(
		config,
		"全链哨兵 测试通知",
		"### 全链哨兵 测试通知\n\n如果你在群里看到这条消息，通知配置可用。",
	);
	return status.ok
		? { ok: true, message: t("测试消息已发送，请查看飞书群") }
		: { ok: false, message: t("发送失败"), detail: status.error };
}

/**
 * WeCom (企业微信) group robot.
 *
 * The webhook URL already carries the access token, and the platform has no
 * signing or keyword security mode, so the only configured field is the webhook.
 * The reply uses the same `errcode`/`errmsg` shape as DingTalk.
 */

/** WeCom rejects a markdown body over 4096 bytes with errcode 44002. */
const MAX_WECOM_BODY_BYTES = 4096;

/**
 * WeCom's markdown renderer has no headings: `###` would show up literally.
 * Heading lines become bold lines, which is the closest rendering it has.
 */
export function toWecomContent(markdown: string): string {
	return markdown
		.split("\n")
		.map((line) => line.replace(/^#{1,6}\s+(.*)$/, "**$1**"))
		.join("\n");
}

/** A WeCom markdown body, with the keyword prepended when one is configured. */
export function buildWecomPayload(config: SentinelNotifyChannelConfig, _title: string, markdown: string): string {
	const prefix = config.keyword ? `${config.keyword}\n` : "";
	return JSON.stringify({
		msgtype: "markdown",
		markdown: { content: `${prefix}${toWecomContent(markdown)}` },
	});
}

/** The WeCom body, clipped until it fits the platform's own content limit. */
export function fitWecomPayload(config: SentinelNotifyChannelConfig, title: string, markdown: string): string {
	const fits = (body: string) => Buffer.byteLength(body, "utf-8") <= MAX_WECOM_BODY_BYTES;
	const full = buildWecomPayload(config, title, markdown);
	if (fits(full)) return full;
	const note = `…（超出企业微信单条上限，已截断，全文 ${markdown.length} 字）`;
	const overhead = Buffer.byteLength(buildWecomPayload(config, title, ""), "utf-8");
	const budget = MAX_WECOM_BODY_BYTES - overhead - Buffer.byteLength(note, "utf-8");
	const kept = budget > 0 ? clipToBytes(markdown, budget) : "";
	return buildWecomPayload(config, title, `${kept}${note}`);
}

interface WecomReply {
	errcode?: number;
	errmsg?: string;
}

async function attemptWecom(
	config: SentinelNotifyChannelConfig,
	title: string,
	markdown: string,
): Promise<string | undefined> {
	let response: Response;
	try {
		response = await fetch(config.webhook, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: fitWecomPayload(config, title, markdown),
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") {
			return t("请求超时（{seconds}s）", { seconds: SEND_TIMEOUT_MS / 1000 });
		}
		const message = error instanceof Error ? error.message : String(error);
		const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
		return cause ? t("{message}：{cause}", { message, cause }) : message;
	}
	if (!response.ok) return `HTTP ${response.status}`;
	let reply: WecomReply;
	try {
		reply = (await response.json()) as WecomReply;
	} catch {
		return t("响应不是合法 JSON");
	}
	if (reply.errcode === 0) return undefined;
	return t("企业微信返回 errcode {code}: {message}", {
		code: String(reply.errcode),
		message: reply.errmsg ?? "",
	});
}

/**
 * Post a WeCom markdown notification, retrying a transient failure. Never
 * throws: the caller records the result and moves on.
 */
export async function sendWecom(
	config: SentinelNotifyChannelConfig,
	title: string,
	markdown: string,
): Promise<SentinelNotifyStatus> {
	const webhook = config.webhook.trim();
	if (!webhook) return { at: Date.now(), ok: false, error: t("未配置 webhook 地址") };
	const urlError = webhookUrlError(webhook);
	if (urlError) return { at: Date.now(), ok: false, error: urlError };
	let lastError: string | undefined;
	for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
		lastError = await attemptWecom({ ...config, webhook }, title, markdown);
		if (!lastError) return { at: Date.now(), ok: true };
		if (attemptNumber < MAX_ATTEMPTS) await delay(RETRY_DELAY_MS);
	}
	return { at: Date.now(), ok: false, error: lastError };
}

/** Settings-screen "send a test message" action for WeCom. */
export async function testWecom(config: SentinelNotifyChannelConfig): Promise<SentinelTestResult> {
	if (!config.webhook.trim()) return { ok: false, message: t("请先填写 webhook 地址") };
	const urlError = webhookUrlError(config.webhook.trim());
	if (urlError) return { ok: false, message: urlError, detail: t("企业微信群机器人只接受 https。") };
	const status = await sendWecom(
		config,
		"全链哨兵 测试通知",
		"### 全链哨兵 测试通知\n\n如果你在群里看到这条消息，通知配置可用。",
	);
	return status.ok
		? { ok: true, message: t("测试消息已发送，请查看企业微信群") }
		: { ok: false, message: t("发送失败"), detail: status.error };
}

/** Match automatic events by group; an omitted kind is a manual broadcast. */
export function enabledNotifyTargets(config: SentinelNotifyConfig, kind?: SentinelNotifyKind) {
	return config.groups
		.filter((group) => group.enabled && (!kind || group.kinds[kind]))
		.flatMap((group) =>
			group.targets.filter((target) => target.enabled && target.webhook.trim()).map((target) => ({ group, target })),
		);
}

export function hasEnabledNotifyChannel(config: SentinelNotifyConfig, kind?: SentinelNotifyKind): boolean {
	return enabledNotifyTargets(config, kind).length > 0;
}

/** Each robot has its own outcome, including repeated platforms in the same group. */
export async function sendNotifications(
	config: SentinelNotifyConfig,
	title: string,
	markdown: string,
	kind?: SentinelNotifyKind,
): Promise<SentinelNotifyStatus> {
	const targets = enabledNotifyTargets(config, kind);
	if (targets.length === 0) return { at: Date.now(), ok: false, error: t("没有匹配的已启用通知组或机器人") };
	const deliveries: SentinelNotifyDelivery[] = new Array(targets.length);
	let next = 0;
	// Bound concurrent requests even when a notification fans out to many robots.
	await Promise.all(
		Array.from({ length: Math.min(4, targets.length) }, async () => {
			while (next < targets.length) {
				const index = next++;
				const { group, target } = targets[index];
				let status: SentinelNotifyStatus;
				try {
					status =
						target.channel === "dingtalk"
							? await sendDingTalk(target, title, markdown)
							: target.channel === "feishu"
								? await sendFeishu(target, title, markdown)
								: await sendWecom(target, title, markdown);
				} catch (error) {
					status = { at: Date.now(), ok: false, error: error instanceof Error ? error.message : String(error) };
				}
				deliveries[index] = {
					groupId: group.id,
					groupName: group.name,
					targetId: target.id,
					targetName: target.name,
					channel: target.channel,
					ok: status.ok,
					...(status.ok ? {} : { error: status.error ?? t("发送失败") }),
				};
			}
		}),
	);
	const errors = deliveries
		.filter((entry) => !entry.ok)
		.map((entry) => `${entry.groupName} / ${entry.targetName}：${entry.error}`);
	return {
		at: Date.now(),
		ok: errors.length === 0,
		deliveries,
		...(errors.length ? { error: errors.join("；") } : {}),
	};
}

/**
 * Whether a settled run reports. The composer's per-message choice wins when it
 * sent one: the pill starts out mirroring the global switch, so an explicit
 * false is an opt-out even while the switch is on, and an explicit true forces a
 * send while it is off. Without a choice, the switch decides.
 */
export function shouldNotifyRun(runNotify: boolean | undefined, enabled: boolean): boolean {
	return runNotify ?? enabled;
}

/** Everything the notification reports about one finished run. */
export interface SentinelRunReport {
	status: "done" | "failed" | "aborted";
	projectName: string;
	/** Session name if the operator set one, else the first instruction. */
	sessionTitle: string;
	/** The operator's manual label for that session, when it has one. */
	sessionStatus?: SentinelSessionStatus | null;
	durationMs: number;
	/** The run's closing assistant text. */
	summary: string;
	/** Provider or tool error, when the run failed. */
	error?: string;
	tokens?: { input: number; output: number; total: number };
	cost?: number;
}

const STATUS_LABEL: Record<SentinelRunReport["status"], string> = {
	done: "完成",
	failed: "失败",
	aborted: "已中止",
};

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${Math.round(seconds % 60)}s`;
}

/**
 * The markdown body and robot title for a finished run. `limit` is the operator's
 * character budget for the closing summary; 0 keeps it whole.
 */
export function buildRunNotification(report: SentinelRunReport, limit: number): { title: string; markdown: string } {
	const label = STATUS_LABEL[report.status];
	const title = `全链哨兵 任务${label}`;
	const lines = [
		`### ${title}`,
		"",
		`- **状态**：${label}`,
		`- **项目**：${report.projectName || "未命名项目"}`,
		`- **会话**：${report.sessionTitle || "未命名会话"}`,
	];
	// The operator labels sessions by hand to remember which one still needs them;
	// the notification is read away from the console, so it carries the label too.
	if (report.sessionStatus) lines.push(`- **会话状态**：${SESSION_STATUS_LABELS[report.sessionStatus]}`);
	lines.push(`- **耗时**：${formatDuration(report.durationMs)}`);
	if (report.tokens) {
		const cost = typeof report.cost === "number" ? ` / 花费 $${report.cost.toFixed(4)}` : "";
		lines.push(
			`- **Token**：输入 ${report.tokens.input} / 输出 ${report.tokens.output} / 合计 ${report.tokens.total}${cost}`,
		);
	}
	if (report.error) lines.push(`- **错误**：${report.error}`);
	const summary = report.summary.trim();
	if (summary) lines.push("", "**最后回复**", "", clipText(summary, limit));
	return { title, markdown: lines.join("\n") };
}

/** Everything the notification reports about one persistent goal. */
export interface SentinelGoalReport {
	/** Human label of the state, e.g. "已完成" or "已暂停（轮数上限）". */
	label: string;
	projectName: string;
	sessionTitle: string;
	/** The operator's manual label for that session, when it has one. */
	sessionStatus?: SentinelSessionStatus | null;
	objective: string;
	rounds: { used: number; limit: number };
	durationMs: number;
	/** The completion conclusion, the blocker reason, or the round's last prose. */
	summary: string;
	evidence?: string[];
	/** Findings the hub holds for this goal, as the runtime counted them. */
	findings?: { submitted: number; note: string };
	criteria?: { criterion: string; met: boolean; evidence: string }[];
}

/**
 * One notification per goal state change. A goal runs unattended, so this is the
 * only way the operator learns that it stopped, ran out of rounds, or finished;
 * the per-round run report is switched off for goal-driven runs to avoid noise.
 *
 * `limit` is the operator's character budget for the conclusion; 0 keeps it whole.
 */
export function buildGoalNotification(report: SentinelGoalReport, limit: number): { title: string; markdown: string } {
	const title = `全链哨兵 持续目标${report.label}`;
	const lines = [
		`### ${title}`,
		"",
		`- **状态**：${report.label}`,
		`- **项目**：${report.projectName || "未命名项目"}`,
		`- **会话**：${report.sessionTitle || "未命名会话"}`,
	];
	if (report.sessionStatus) lines.push(`- **会话状态**：${SESSION_STATUS_LABELS[report.sessionStatus]}`);
	lines.push(
		`- **目标**：${report.objective}`,
		`- **轮次**：自动续跑 ${report.rounds.used}/${report.rounds.limit} 轮`,
		`- **耗时**：${formatDuration(report.durationMs)}`,
	);
	if (report.findings) {
		lines.push(
			`- **漏洞中枢**：${report.findings.submitted} 条${report.findings.note ? `（${report.findings.note}）` : ""}`,
		);
	}
	const summary = report.summary.trim();
	if (summary) lines.push("", "**结论**", "", clipText(summary, limit));
	if (report.criteria && report.criteria.length > 0) {
		lines.push("", "**验收标准**");
		for (const item of report.criteria) {
			lines.push(
				`- ${item.met ? "满足" : "未满足"}：${item.criterion}${item.evidence ? ` —— ${item.evidence}` : ""}`,
			);
		}
	}
	if (report.evidence && report.evidence.length > 0) {
		lines.push("", "**证据**");
		for (const item of report.evidence.slice(0, 8)) lines.push(`- ${item}`);
	}
	return { title, markdown: lines.join("\n") };
}

/**
 * One security-fix commit found by the open-source watch. Sent as soon as the
 * verdict lands, before the reproduction engine has had time to run, so the
 * operator learns about the 1day while the patch is still fresh.
 */
export function buildCodeMonitorNotification(
	monitor: SentinelCodeMonitor,
	commit: SentinelCodeCommit,
	limit: number,
): { title: string; markdown: string } {
	const title = `开源漏洞情报 ${monitor.owner}/${monitor.repo}`;
	const lines = [
		`### ${title}`,
		"",
		`- **仓库**：${monitor.host}/${monitor.owner}/${monitor.repo}`,
		`- **分支**：${commit.branch}`,
		`- **提交**：[${commit.shortSha}](${commit.url})`,
		`- **作者**：${commit.author}`,
		`- **置信度**：${Math.round((commit.confidence ?? 0) * 100)}%`,
		`- **判定**：${commit.title}`,
	];
	if (commit.cve) lines.push(`- **编号**：${commit.cve}`);
	if (commit.severity) lines.push(`- **估计等级**：${commit.severity}`);
	if (commit.vulnType) lines.push(`- **类型**：${commit.vulnType}`);
	lines.push(
		`- **状态**：${commit.engineId ? "已交给工程复现" : monitor.autoDispatch ? "已判定为安全更新，正在自动下发复现" : "待确认（可在控制台一键复现）"}`,
		"",
		"**判定依据**",
		"",
		clipText(commit.reason?.trim() || "(无)", limit),
	);
	return { title, markdown: lines.join("\n") };
}

/**
 * Immediate notification for one critical/high finding, sent the moment it is
 * submitted instead of waiting for the run to end. It carries the headline, the
 * score, the target, and as much of the packet as `limit` allows; the hub page
 * holds the rest.
 */
export function buildVulnNotification(
	vuln: SentinelVulnerability,
	projectName: string,
	limit: number,
): { title: string; markdown: string } {
	const severity = SENTINEL_VULN_SEVERITY_LABELS[vuln.severity];
	const title = `全链哨兵 发现${severity}漏洞`;
	const lines = [
		`### ${title}`,
		"",
		`- **编号**：${vuln.label}`,
		`- **标题**：${vuln.title}`,
		`- **等级**：${severity}（${vuln.severity}）· CVSS ${vuln.cvss.toFixed(1)}`,
		`- **状态**：${SENTINEL_VULN_STATUS_LABELS[vuln.status]}`,
		`- **目标**：${vuln.target}`,
		`- **项目**：${projectName || vuln.projectName}`,
		`- **来源**：${vuln.source}`,
	];
	if (vuln.category) lines.push(`- **类型**：${vuln.category}`);
	lines.push(`- **时间**：${new Date(vuln.createdAt).toLocaleString("zh-CN", { hour12: false })}`);
	const packet = vuln.packet.trim();
	if (packet) {
		// No code fence: DingTalk's markdown renderer is narrow, and the raw text
		// survives better as a paragraph.
		lines.push("", "**原始数据包**", "", clipText(packet, limit));
	}
	return { title, markdown: lines.join("\n") };
}
