/**
 * Unit tests for DingTalk notifications.
 *
 * A local HTTP server plays the robot, so signature building, keyword handling,
 * retry, and error mapping are pinned without reaching DingTalk.
 */

import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import {
	buildFeishuPayload,
	buildRunNotification,
	buildWecomPayload,
	clipText,
	feishuSignature,
	fitFeishuPayload,
	fitPayload,
	fitWecomPayload,
	sendDingTalk,
	sendFeishu,
	sendNotifications,
	sendWecom,
	shouldNotifyRun,
	signedWebhookUrl,
	testDingTalk,
	testFeishu,
	testWecom,
	toWecomContent,
} from "../src/notify.ts";
import {
	DEFAULT_SUMMARY_LIMIT,
	notificationsJsonPath,
	readNotifyConfig,
	writeNotifyConfig,
} from "../src/notify-config.ts";
import type { SentinelNotifyConfig } from "../src/protocol.ts";

const CONFIG: SentinelNotifyConfig = {
	enabled: true,
	webhook: "",
	secret: "",
	keyword: "",
	kinds: { runs: true, vulns: true, codeIntel: true, goals: true, engines: true, pocs: true },
	summaryLimit: 2000,
	feishu: { enabled: false, webhook: "", secret: "", keyword: "" },
	wecom: { enabled: false, webhook: "", secret: "", keyword: "" },
};

/** A WeCom webhook pointed at the fake robot. */
const WECOM: SentinelNotifyConfig["wecom"] = {
	enabled: true,
	webhook: "",
	secret: "",
	keyword: "",
};

/** Requests the fake robot received, in order. */
interface Received {
	url: string;
	body: {
		msgtype?: string;
		markdown?: { title?: string; text?: string; content?: string };
		msg_type?: string;
		timestamp?: string;
		sign?: string;
		card?: { elements?: { tag?: string; content?: string }[] };
	};
}

let server: Server;
let received: Received[] = [];
/** Bodies the fake robot rejects, keyed by a substring of the markdown text. */
let rejectWith: { match: string; errcode: number; errmsg: string } | null = null;
let baseUrl = "";

beforeAll(async () => {
	server = createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk: Buffer) => {
			raw += chunk.toString();
		});
		request.on("end", () => {
			const body = JSON.parse(raw) as Received["body"];
			received.push({ url: request.url ?? "", body });
			const text = body.markdown?.text ?? body.markdown?.content ?? body.card?.elements?.[0]?.content ?? "";
			const reject = rejectWith && text.includes(rejectWith.match) ? rejectWith : null;
			response.setHeader("content-type", "application/json");
			if (body.card) {
				response.end(JSON.stringify({ StatusCode: 0, StatusMessage: "success", code: 0, msg: "success" }));
				return;
			}
			response.end(
				JSON.stringify(reject ? { errcode: reject.errcode, errmsg: reject.errmsg } : { errcode: 0, errmsg: "ok" }),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	baseUrl = `http://127.0.0.1:${port}/robot/send?access_token=test-token`;
});

afterAll(() => {
	server.close();
});

afterEach(() => {
	received = [];
	rejectWith = null;
});

test("a signed webhook carries a timestamp and the HMAC of timestamp-newline-secret", () => {
	const url = signedWebhookUrl("https://oapi.dingtalk.com/robot/send?access_token=abc", "SECxyz", 1700000000000);
	const parsed = new URL(url);
	expect(parsed.searchParams.get("access_token")).toBe("abc");
	expect(parsed.searchParams.get("timestamp")).toBe("1700000000000");
	const expected = createHmac("sha256", "SECxyz").update("1700000000000\nSECxyz", "utf-8").digest("base64");
	expect(parsed.searchParams.get("sign")).toBe(expected);
});

test("without a secret the webhook is used as-is", () => {
	const url = "https://oapi.dingtalk.com/robot/send?access_token=abc";
	expect(signedWebhookUrl(url, "", 1700000000000)).toBe(url);
});

test("a configured keyword is prepended to the markdown body", async () => {
	const status = await sendDingTalk({ ...CONFIG, webhook: baseUrl, keyword: "Full Chain Sentinel" }, "T", "### body");
	expect(status.ok).toBe(true);
	expect(received).toHaveLength(1);
	expect(received[0]?.body.markdown?.text).toBe("Full Chain Sentinel\n### body");
	expect(received[0]?.body.msgtype).toBe("markdown");
});

test("a robot error is reported with its errcode and the 310000 hint", async () => {
	rejectWith = { match: "### body", errcode: 310000, errmsg: "keywords not in content" };
	const status = await sendDingTalk({ ...CONFIG, webhook: baseUrl }, "T", "### body");
	expect(status.ok).toBe(false);
	expect(status.error).toContain("310000");
	expect(status.error).toContain("加签校验失败或缺少自定义关键词");
	// The first attempt plus two retries.
	expect(received).toHaveLength(3);
});

test("a rejected send is retried and can still succeed", async () => {
	// The robot accepts everything, so the three attempts all land and the last
	// result is a success.
	const status = await sendDingTalk({ ...CONFIG, webhook: baseUrl }, "T", "### retry-body");
	expect(status.ok).toBe(true);
	expect(received).toHaveLength(1);
	expect(status.at).toBeGreaterThan(0);
});

test("a missing webhook fails without any request", async () => {
	const status = await sendDingTalk({ ...CONFIG, webhook: "  " }, "T", "### body");
	expect(status.ok).toBe(false);
	expect(status.error).toContain("未配置 webhook");
	expect(received).toHaveLength(0);
});

test("the settings-screen test refuses a non-https webhook", async () => {
	const result = await testDingTalk({ ...CONFIG, webhook: "http://example.com/robot/send" });
	expect(result.ok).toBe(false);
	expect(result.message).toContain("https");
	expect(received).toHaveLength(0);
});

test("the run notification reports status, project, session, duration, tokens, and the summary", () => {
	const { title, markdown } = buildRunNotification(
		{
			status: "failed",
			projectName: "测试项目",
			sessionTitle: "扫描 10.0.0.1",
			durationMs: 65000,
			summary: "扫描完成",
			sessionStatus: "todo",
			error: "502 upstream unavailable",
			tokens: { input: 1200, output: 340, total: 1540 },
			cost: 0.0123,
		},
		2000,
	);
	expect(title).toBe("全链哨兵 任务失败");
	expect(markdown).toContain("**状态**：失败");
	expect(markdown).toContain("**项目**：测试项目");
	expect(markdown).toContain("**会话**：扫描 10.0.0.1");
	expect(markdown).toContain("**会话状态**：待跟进");
	expect(markdown).toContain("**耗时**：1m5s");
	expect(markdown).toContain("输入 1200 / 输出 340 / 合计 1540 / 花费 $0.0123");
	expect(markdown).toContain("**错误**：502 upstream unavailable");
	expect(markdown).toContain("扫描完成");
});

test("a summary longer than the configured limit is truncated and says how long it was", () => {
	const { markdown } = buildRunNotification(
		{ status: "done", projectName: "p", sessionTitle: "s", durationMs: 900, summary: "x".repeat(900) },
		500,
	);
	expect(markdown).toContain("（已截断，全文 900 字）");
	expect(markdown).not.toContain("x".repeat(600));
	expect(markdown).toContain("x".repeat(500));
});

test("the limit is the operator's: a longer one keeps more, and 0 keeps everything", () => {
	const summary = "y".repeat(900);
	const kept = buildRunNotification(
		{ status: "done", projectName: "p", sessionTitle: "s", durationMs: 900, summary },
		2000,
	).markdown;
	expect(kept).toContain("y".repeat(900));
	expect(kept).not.toContain("已截断");

	const whole = buildRunNotification(
		{ status: "done", projectName: "p", sessionTitle: "s", durationMs: 900, summary },
		0,
	).markdown;
	expect(whole).toContain("y".repeat(900));
	expect(whole).not.toContain("已截断");
});

test("clipText leaves text alone at or under the limit, and at 0", () => {
	expect(clipText("短", 10)).toBe("短");
	expect(clipText("x".repeat(10), 10)).toBe("x".repeat(10));
	expect(clipText("x".repeat(11), 0)).toBe("x".repeat(11));
	expect(clipText("x".repeat(11), 10)).toBe(`${"x".repeat(10)}…（已截断，全文 11 字）`);
});

test("the payload is cut to fit DingTalk's own 20000-byte limit, whatever the operator asked for", () => {
	// A body far over the platform limit: the request must still be sendable.
	const body = "字".repeat(20000);
	const payload = fitPayload(CONFIG, "t", body);
	expect(Buffer.byteLength(payload, "utf-8")).toBeLessThanOrEqual(20000);
	expect(payload).toContain("超出钉钉单条上限，已截断，全文 20000 字");

	// A body that fits is passed through untouched.
	const small = fitPayload(CONFIG, "t", "hello");
	expect(small).toBe(
		JSON.stringify({ msgtype: "markdown", markdown: { title: "t", text: "hello" }, at: { isAtAll: false } }),
	);
});

test("a done run omits the error and token lines it has no data for", () => {
	const { markdown } = buildRunNotification(
		{ status: "aborted", projectName: "", sessionTitle: "", durationMs: 500, summary: "" },
		DEFAULT_SUMMARY_LIMIT,
	);
	expect(markdown).toContain("**状态**：已中止");
	expect(markdown).toContain("未命名项目");
	expect(markdown).toContain("未命名会话");
	// No status was set on the session, so the line is absent rather than empty.
	expect(markdown).not.toContain("**会话状态**");
	expect(markdown).not.toContain("**错误**");
	expect(markdown).not.toContain("**Token**");
});

test("the per-message choice overrides the global switch in both directions", () => {
	// No choice from the composer: the switch decides.
	expect(shouldNotifyRun(undefined, true)).toBe(true);
	expect(shouldNotifyRun(undefined, false)).toBe(false);
	// An explicit choice wins: opt out while on, force while off.
	expect(shouldNotifyRun(false, true)).toBe(false);
	expect(shouldNotifyRun(true, false)).toBe(true);
});

test("a Feishu signature is the HMAC of timestamp-newline-secret with an empty message", () => {
	const expected = createHmac("sha256", "1700000000\nFSEC").update("").digest("base64");
	expect(feishuSignature(1700000000, "FSEC")).toBe(expected);
});

test("a Feishu card carries timestamp, sign, and the keyword before the body", () => {
	const payload = JSON.parse(
		buildFeishuPayload(
			{
				enabled: true,
				webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/x",
				secret: "FSEC",
				keyword: "zgagent",
			},
			"全链哨兵 测试",
			"### 正文",
			1700000000,
		),
	) as {
		timestamp: string;
		sign: string;
		msg_type: string;
		card: { elements: { tag: string; content: string }[] };
	};
	expect(payload.timestamp).toBe("1700000000");
	expect(payload.sign).toBe(feishuSignature(1700000000, "FSEC"));
	expect(payload.msg_type).toBe("interactive");
	expect(payload.card.elements[0]?.content).toBe("zgagent\n### 正文");
});

test("a Feishu card is clipped below the 30000-byte request limit", () => {
	const body = fitFeishuPayload(
		{ enabled: true, webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/x", secret: "FSEC", keyword: "zgagent" },
		"长正文",
		"x".repeat(40000),
		1700000000,
	);
	expect(Buffer.byteLength(body, "utf-8")).toBeLessThanOrEqual(30000);
	expect(body).toContain("超出飞书单条上限");
});

test("a Feishu send posts the card and treats code 0 as delivered", async () => {
	const config = { enabled: true, webhook: baseUrl, secret: "FSEC", keyword: "zgagent" };
	const status = await sendFeishu(config, "T", "### body");
	expect(status.ok).toBe(true);
	expect(received).toHaveLength(1);
	expect(received[0]?.body.msg_type).toBe("interactive");
	expect(received[0]?.body.card?.elements?.[0]?.content).toBe("zgagent\n### body");
	expect(received[0]?.body.sign).toBe(feishuSignature(Number(received[0]?.body.timestamp), "FSEC"));
});

test("the settings-screen test refuses a non-https Feishu webhook", async () => {
	const result = await testFeishu({
		enabled: true,
		webhook: "http://example.com/open-apis/bot/v2/hook/x",
		secret: "",
		keyword: "",
	});
	expect(result.ok).toBe(false);
	expect(result.message).toContain("https");
	expect(received).toHaveLength(0);
});

test("WeCom markdown headings become bold lines; other markdown is kept", () => {
	expect(toWecomContent("### 标题\n- **状态**：完成\n> 引用")).toBe("**标题**\n- **状态**：完成\n> 引用");
});

test("a WeCom payload carries the keyword and the converted content", () => {
	const body = JSON.parse(buildWecomPayload({ ...WECOM, keyword: "全链" }, "测试", "### 标题\n正文")) as {
		msgtype: string;
		markdown: { content: string };
	};
	expect(body.msgtype).toBe("markdown");
	expect(body.markdown.content).toBe("全链\n**标题**\n正文");
});

test("a WeCom body is clipped below the 4096-byte content limit", () => {
	const long = "汉".repeat(4000);
	const body = JSON.parse(fitWecomPayload(WECOM, "标题", long)) as {
		markdown: { content: string };
	};
	expect(Buffer.byteLength(body.markdown.content, "utf-8")).toBeLessThanOrEqual(4096);
	expect(body.markdown.content).toContain("已截断");
});

test("a WeCom send posts the markdown and treats errcode 0 as delivered", async () => {
	const status = await sendWecom({ ...WECOM, webhook: baseUrl }, "标题", "### 内容");
	expect(status.ok).toBe(true);
	const last = received.at(-1);
	expect(last?.body.msgtype).toBe("markdown");
	expect(last?.body.markdown?.content).toContain("**内容**");
});

test("a WeCom robot error is reported with its errcode", async () => {
	rejectWith = { match: "坏消息", errcode: 93000, errmsg: "invalid webhookurl" };
	const status = await sendWecom({ ...WECOM, webhook: baseUrl }, "标题", "### 坏消息");
	expect(status.ok).toBe(false);
	expect(status.error).toContain("93000");
	expect(status.error).toContain("invalid webhookurl");
});

test("the settings-screen test refuses a non-https WeCom webhook", async () => {
	const result = await testWecom({ ...WECOM, webhook: "http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x" });
	expect(result.ok).toBe(false);
	expect(result.detail).toContain("https");
});

test("sendNotifications delivers to DingTalk, Feishu and WeCom independently", async () => {
	const status = await sendNotifications(
		{
			...CONFIG,
			webhook: baseUrl,
			keyword: "KW",
			feishu: { enabled: true, webhook: baseUrl, secret: "FSEC", keyword: "zgagent" },
			wecom: { enabled: true, webhook: baseUrl, secret: "", keyword: "" },
		},
		"both",
		"### both",
	);
	expect(status).toMatchObject({
		ok: true,
		channels: { dingtalk: { ok: true }, feishu: { ok: true }, wecom: { ok: true } },
	});
	expect(received).toHaveLength(3);
});

test("the notification config round-trips through notifications.json with 0600", () => {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-notify-"));
	try {
		expect(readNotifyConfig(dir)).toEqual({
			enabled: false,
			webhook: "",
			secret: "",
			keyword: "",
			kinds: { runs: true, vulns: true, codeIntel: true, goals: true, engines: true, pocs: true },
			summaryLimit: DEFAULT_SUMMARY_LIMIT,
			feishu: { enabled: false, webhook: "", secret: "", keyword: "" },
			wecom: { enabled: false, webhook: "", secret: "", keyword: "" },
		});
		writeNotifyConfig(dir, {
			enabled: true,
			webhook: " https://x/y ",
			secret: " SEC ",
			keyword: " KW ",
			kinds: { runs: true, vulns: true, codeIntel: true, goals: true, engines: true, pocs: true },
			summaryLimit: 5000,
			feishu: {
				enabled: true,
				webhook: " https://open.feishu.cn/open-apis/bot/v2/hook/test ",
				secret: " FSEC ",
				keyword: " zgagent ",
			},
			wecom: {
				enabled: true,
				webhook: " https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test ",
				secret: "",
				keyword: "",
			},
		});
		expect(readNotifyConfig(dir)).toEqual({
			enabled: true,
			webhook: "https://x/y",
			secret: "SEC",
			keyword: "KW",
			kinds: { runs: true, vulns: true, codeIntel: true, goals: true, engines: true, pocs: true },
			summaryLimit: 5000,
			feishu: {
				enabled: true,
				webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
				secret: "FSEC",
				keyword: "zgagent",
			},
			wecom: {
				enabled: true,
				webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test",
				secret: "",
				keyword: "",
			},
		});
		chmodSync(notificationsJsonPath(dir), 0o600);
		expect(statSync(notificationsJsonPath(dir)).mode & 0o777).toBe(0o600);
		expect(readFileSync(notificationsJsonPath(dir), "utf-8")).toContain('"dingtalk"');
		expect(readFileSync(notificationsJsonPath(dir), "utf-8")).toContain('"feishu"');
		expect(readFileSync(notificationsJsonPath(dir), "utf-8")).toContain('"wecom"');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stored limit is normalized: missing reads as the default, negative as 0", () => {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-notify-limit-"));
	try {
		writeNotifyConfig(dir, {
			enabled: true,
			webhook: "https://x/y",
			secret: "",
			keyword: "",
			kinds: { runs: true, vulns: true, codeIntel: true, goals: true, engines: true, pocs: true },
			summaryLimit: -5,
			feishu: { enabled: false, webhook: "", secret: "", keyword: "" },
			wecom: { enabled: false, webhook: "", secret: "", keyword: "" },
		});
		expect(readNotifyConfig(dir).summaryLimit).toBe(0);

		// A file written before the field existed keeps the default.
		const legacy = JSON.parse(readFileSync(notificationsJsonPath(dir), "utf-8")) as {
			dingtalk: Record<string, unknown>;
		};
		delete legacy.dingtalk.summaryLimit;
		writeFileSync(notificationsJsonPath(dir), JSON.stringify(legacy));
		expect(readNotifyConfig(dir).summaryLimit).toBe(DEFAULT_SUMMARY_LIMIT);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("kinds default to all on and a cleared kind survives the round trip", () => {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-notify-kinds-"));
	try {
		// A file from before the checkboxes existed pushes everything, as it did.
		writeFileSync(
			notificationsJsonPath(dir),
			JSON.stringify({ dingtalk: { enabled: true, webhook: "https://x/y" } }),
		);
		expect(readNotifyConfig(dir).kinds).toEqual({
			runs: true,
			vulns: true,
			codeIntel: true,
			goals: true,
			engines: true,
			pocs: true,
		});

		writeNotifyConfig(dir, {
			...CONFIG,
			kinds: { runs: false, vulns: false, codeIntel: false, goals: true, engines: true, pocs: true },
		});
		expect(readNotifyConfig(dir).kinds).toEqual({
			runs: false,
			vulns: false,
			codeIntel: false,
			goals: true,
			engines: true,
			pocs: true,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test.each([
	{ vulns: true, codeIntel: false },
	{ vulns: false, codeIntel: true },
])("open-source intel and high-severity findings are saved independently: %j", (choices) => {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-notify-intel-"));
	try {
		const config = { ...CONFIG, kinds: { ...CONFIG.kinds, ...choices } };
		writeNotifyConfig(dir, config);
		expect(readNotifyConfig(dir).kinds).toEqual(config.kinds);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
