/**
 * The packet-replay tools: what the model is allowed to see and what it can do.
 *
 * `replaydRequest` / `replaydArtifact` are mocked, so these tests pin the tool
 * contract rather than the transport (that is replayd.test.ts): which parameters
 * reach the container service, that the approval chain is asked BEFORE anything is
 * sent and that an edited packet is the one that goes out, that a package with no
 * line feed normalization is reported back, and that a screenshot becomes both an
 * evidence file and an image block.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { replaydRequest, replaydArtifact } = vi.hoisted(() => ({
	replaydRequest: vi.fn(),
	replaydArtifact: vi.fn(),
}));
vi.mock("../src/replayd.ts", () => ({
	replaydRequest,
	replaydArtifact,
	replaydDataDirHost: (workDir: string) => join(workDir, ".sentinel", "replayd"),
}));

import { createReplayTools, REPLAY_TOOL_NAMES, type ReplayToolContext } from "../src/replay-tool.ts";

let root = "";
let guarded: Array<{ tool: string; summary: string; payload: string }> = [];
let ensured = 0;

function context(overrides: Partial<ReplayToolContext> = {}): ReplayToolContext {
	return {
		enabled: () => true,
		container: () => "sentinel-test",
		workDir: () => root,
		guard: async (tool, summary, payload) => {
			guarded.push({ tool, summary, payload });
			return payload;
		},
		ensure: async () => {
			ensured += 1;
			return { state: "running", port: 7300, proxyPort: 7600, version: "0.1.0" };
		},
		...overrides,
	};
}

function tool(ctx: ReplayToolContext, name: string) {
	const found = createReplayTools(ctx).find((candidate) => candidate.name === name);
	if (!found) throw new Error(`工具不存在: ${name}`);
	return found;
}

/** The tool result as `{ text, images }`, since content is a union of blocks. */
function blocks(result: { content: Array<{ type: string; text?: string; data?: string }> }): {
	text: string;
	images: number;
} {
	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	return { text, images: result.content.filter((block) => block.type === "image").length };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "replay-tool-"));
	guarded = [];
	ensured = 0;
	replaydRequest.mockReset();
	replaydArtifact.mockReset();
	replaydArtifact.mockResolvedValue({ ok: true, bytes: PNG });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

test("the toolset is the evidence capture plus the read-only history", () => {
	// No plain "send this packet" tool on purpose: curl in bash covers that, on the
	// same approval chain. See the module header.
	expect([...REPLAY_TOOL_NAMES]).toEqual(["replay_capture", "replay_flows"]);
	const tools = createReplayTools(context());
	expect(tools.map((definition) => definition.name)).toEqual([...REPLAY_TOOL_NAMES]);
	expect(tools.every((definition) => definition.defaultActive === false)).toBe(true);
});

test("disabled report tools refuse calls before service startup, approval or network requests", async () => {
	for (const name of REPLAY_TOOL_NAMES) {
		const result = await tool(context({ enabled: () => false }), name).execute(
			"disabled",
			{ purpose: "留证", raw: "GET / HTTP/1.1\r\nHost: fixture.test\r\n\r\n" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBe(true);
		expect(blocks(result).text).toContain("启用报告中心");
	}
	expect(ensured).toBe(0);
	expect(guarded).toHaveLength(0);
	expect(replaydRequest).not.toHaveBeenCalled();
	expect(replaydArtifact).not.toHaveBeenCalled();
});

test("disabling reports while approval is pending prevents the packet from being sent", async () => {
	let enabled = true;
	const result = await tool(
		context({
			enabled: () => enabled,
			guard: async (_tool, _summary, packet) => {
				enabled = false;
				return packet;
			},
		}),
		"replay_capture",
	).execute(
		"disabled-during-approval",
		{ purpose: "留证", raw: "GET / HTTP/1.1\r\nHost: fixture.test\r\n\r\n" },
		undefined,
		undefined,
		{} as never,
	);
	expect(result.isError).toBe(true);
	expect(blocks(result).text).toContain("启用报告中心");
	expect(replaydRequest).not.toHaveBeenCalled();
});

/** A successful capture response, minus what each test overrides. */
function captureOk(overrides: Record<string, unknown> = {}): { ok: true; data: unknown } {
	return {
		ok: true,
		data: {
			status: "done",
			statusLine: "200 OK",
			responseHeaders: "Content-Type: text/html",
			evidenceWatermark: "来源 https://www.beijing-time.org/",
			screenshots: { viewport: { artifactId: "art_1" } },
			timings: { sentMs: 1, evidenceMs: 2, totalMs: 3 },
			...overrides,
		},
	};
}

test("replay_capture asks the approval chain first, with the stated purpose", async () => {
	replaydRequest.mockResolvedValue(captureOk());
	const packet = "GET /admin HTTP/1.1\r\nHost: 10.0.0.5\r\n\r\n";
	const result = await tool(context(), "replay_capture").execute(
		"id",
		{ purpose: "未授权访问 /admin 的留证（返回 role=admin）", raw: packet },
		undefined,
		undefined,
		{} as never,
	);
	expect(replaydRequest).toHaveBeenCalledTimes(1);
	expect(guarded).toHaveLength(1);
	expect(guarded[0].tool).toBe("replay_capture");
	expect(guarded[0].summary).toContain("报告留证截图");
	expect(guarded[0].summary).toContain("未授权访问 /admin 的留证");
	expect(guarded[0].summary).toContain("10.0.0.5");
	// The purpose is part of the result too, so the transcript says what the image was for.
	expect(blocks(result).text).toContain("留证用途：未授权访问 /admin 的留证（返回 role=admin）");
});

test("a SOCKS5 proxy is on the approval card and reaches replayd", async () => {
	// The operator has to see where the packet will leave from: a proxy changes the
	// path it takes, and the screenshot is evidence of that path.
	replaydRequest.mockResolvedValue(captureOk({ upstreamProxy: "socks5://alice:s3cret@127.0.0.1:1080" }));
	const result = await tool(context(), "replay_capture").execute(
		"id",
		{
			purpose: "经代理访问 /admin 的留证",
			raw: "GET /admin HTTP/1.1\r\nHost: 10.0.0.5\r\n\r\n",
			proxy: "socks5://alice:s3cret@127.0.0.1:1080",
		},
		undefined,
		undefined,
		{} as never,
	);
	expect(guarded).toHaveLength(1);
	// The card names the exit but not the password: the audit is read later, by
	// people who do not need the credential.
	expect(guarded[0].summary).toContain("socks5://alice:***@127.0.0.1:1080");
	expect(guarded[0].summary).not.toContain("s3cret");
	const body = replaydRequest.mock.calls[0]?.[0] as { body: { upstreamProxy?: string } };
	expect(body.body.upstreamProxy).toBe("socks5://alice:s3cret@127.0.0.1:1080");
	expect(blocks(result).text).toContain("出口：socks5://alice:s3cret@127.0.0.1:1080");
});

test("a non-SOCKS5 proxy is refused before the service or the approval chain", async () => {
	// A typo must not start replayd, must not ask the operator to approve a packet
	// that cannot be sent the way it was asked for, and must not look like a target
	// failure.
	const result = await tool(context(), "replay_capture").execute(
		"id",
		{ purpose: "留证", raw: "GET / HTTP/1.1\r\nHost: 10.0.0.5\r\n\r\n", proxy: "http://127.0.0.1:8080" },
		undefined,
		undefined,
		{} as never,
	);
	expect(result.isError).toBe(true);
	expect(blocks(result).text).toContain("只支持 SOCKS5");
	expect(ensured).toBe(0);
	expect(guarded).toHaveLength(0);
	expect(replaydRequest).not.toHaveBeenCalled();
});

test("a proxy failure is reported as a proxy problem, not a target one", async () => {
	replaydRequest.mockResolvedValue(
		captureOk({ upstreamProxy: "socks5://127.0.0.1:1080", sendError: "upstream_connect: 连接代理失败" }),
	);
	const result = await tool(context(), "replay_capture").execute(
		"id",
		{ purpose: "留证", raw: "GET / HTTP/1.1\r\nHost: 10.0.0.5\r\n\r\n", proxy: "socks5://127.0.0.1:1080" },
		undefined,
		undefined,
		{} as never,
	);
	expect(blocks(result).text).toContain("发送异常：upstream_connect");
	// The hint names the container-relative address, which is the usual mistake.
	expect(blocks(result).text).toContain("host.docker.internal");
});

test("an edited approval is what actually goes on the wire", async () => {
	replaydRequest.mockResolvedValue(captureOk());
	const edited = "GET /admin2 HTTP/1.1\r\nHost: 10.0.0.5\r\nX-Operator: yes\r\n\r\n";
	await tool(context({ guard: async () => edited }), "replay_capture").execute(
		"id",
		{ purpose: "留证", raw: "GET /admin HTTP/1.1\r\nHost: 10.0.0.5\r\n\r\n" },
		undefined,
		undefined,
		{} as never,
	);
	const body = replaydRequest.mock.calls[0]?.[0] as { body: { raw: string } };
	expect(body.body.raw).toBe(edited);
});

test("a capture without a purpose is refused before the approval chain", async () => {
	const result = await tool(context(), "replay_capture").execute(
		"id",
		{ purpose: "   ", raw: "GET / HTTP/1.1\r\nHost: x\r\n\r\n" },
		undefined,
		undefined,
		{} as never,
	);
	expect(result.isError).toBe(true);
	expect(blocks(result).text).toContain("purpose 不能为空");
	expect(guarded).toHaveLength(0);
	expect(replaydRequest).not.toHaveBeenCalled();
	// Rejected before the service is started, so nothing was pushed into the container.
	expect(ensured).toBe(0);
});

test("a refused approval never reaches the container service", async () => {
	const result = await tool(
		context({
			guard: async () => {
				throw new Error("已拒绝");
			},
		}),
		"replay_capture",
	).execute("id", { purpose: "留证", raw: "GET / HTTP/1.1\r\nHost: x\r\n\r\n" }, undefined, undefined, {} as never);
	expect(blocks(result).text).toContain("已拒绝");
	expect(result.isError).toBe(true);
	expect(replaydRequest).not.toHaveBeenCalled();
});

test("a packet with only LF line endings is normalized and said so", async () => {
	replaydRequest.mockResolvedValue(captureOk());
	const result = await tool(context(), "replay_capture").execute(
		"id",
		{ purpose: "留证", raw: "GET / HTTP/1.1\nHost: 10.0.0.5\n\n" },
		undefined,
		undefined,
		{} as never,
	);
	expect(blocks(result).text).toContain("已按 CRLF 发送");
	const body = replaydRequest.mock.calls[0]?.[0] as { body: { raw: string } };
	expect(body.body.raw).toBe("GET / HTTP/1.1\r\nHost: 10.0.0.5\r\n\r\n");
	// The approval card showed the normalized packet, so the operator approves what is sent.
	expect(guarded[0].payload).toBe("GET / HTTP/1.1\r\nHost: 10.0.0.5\r\n\r\n");
});

test("a packet that already contains CR keeps its bytes untouched", async () => {
	replaydRequest.mockResolvedValue(captureOk());
	const sneaky = "GET / HTTP/1.1\nHost: x\rX-Smuggle: 1\r\n\r\n";
	const result = await tool(context(), "replay_capture").execute(
		"id",
		{ purpose: "留证", raw: sneaky },
		undefined,
		undefined,
		{} as never,
	);
	expect(blocks(result).text).not.toContain("已按 CRLF 发送");
	const body = replaydRequest.mock.calls[0]?.[0] as { body: { raw: string } };
	expect(body.body.raw).toBe(sneaky);
});

test("explicit target overrides reach the request", async () => {
	replaydRequest.mockResolvedValue(captureOk());
	await tool(context(), "replay_capture").execute(
		"id",
		{
			purpose: "留证",
			raw: "GET / HTTP/1.1\r\nHost: ignored\r\n\r\n",
			host: "10.0.0.9",
			port: 8443,
			scheme: "https",
			insecureTLS: false,
		},
		undefined,
		undefined,
		{} as never,
	);
	const body = replaydRequest.mock.calls[0]?.[0] as {
		body: { host: string; port: number; scheme: string; insecureTLS: boolean };
	};
	expect(body.body.host).toBe("10.0.0.9");
	expect(body.body.port).toBe(8443);
	expect(body.body.scheme).toBe("https");
	expect(body.body.insecureTLS).toBe(false);
});

test("replay_capture returns the read-back text plus the screenshot as evidence and image", async () => {
	replaydRequest.mockResolvedValue({
		ok: true,
		data: {
			status: "done",
			statusLine: "200 OK\n·\n415 B\n·\n203 ms",
			responseHeaders: "Content-Type: text/html",
			evidenceWatermark: "来源 https://www.beijing-time.org/ · 模式 服务端快照 · 已记入历史 flw_9",
			highlightsApplied: ["response:role=admin"],
			highlightsMissing: ["response:nothing"],
			screenshots: { viewport: { artifactId: "art_1", size: PNG.length } },
			timings: { sentMs: 203, evidenceMs: 4200, totalMs: 6200 },
			flowId: "flw_9",
		},
	});
	const result = await tool(context(), "replay_capture").execute(
		"id",
		{
			purpose: "越权访问留证",
			raw: "GET /admin HTTP/1.1\r\nHost: 10.0.0.5\r\n\r\n",
			highlightResponse: ["role=admin"],
		},
		undefined,
		undefined,
		{} as never,
	);
	const { text, images } = blocks(result);
	expect(text).toContain("200 OK");
	expect(text).toContain("取证：来源 https://www.beijing-time.org/");
	expect(text).toContain("已高亮：response:role=admin");
	expect(text).toContain("未找到的片段：response:nothing");
	expect(text).toContain("flowId：flw_9");
	expect(text).toContain("截图已存证：evidence/replay/capture-");
	expect(images).toBe(1);
	// The evidence file is on disk, byte-identical to the artifact.
	const note = /evidence\/replay\/(capture-[^（]+\.png)/.exec(text);
	expect(note).not.toBeNull();
	const saved = join(root, "evidence", "replay", note?.[1] ?? "");
	expect(statSync(saved).size).toBe(PNG.length);
	expect(readFileSync(saved).equals(PNG)).toBe(true);
	const body = replaydRequest.mock.calls[0]?.[0] as {
		path: string;
		body: { highlight: unknown; evidenceMode: string; includeContent: boolean };
	};
	expect(body.path).toBe("/api/capture");
	expect(body.body.highlight).toEqual({ request: [], response: ["role=admin"], color: "yellow" });
	expect(body.body.evidenceMode).toBe("snapshot");
	expect(body.body.includeContent).toBe(true);
});

test("a capture without a screenshot artifact fails instead of reporting success", async () => {
	replaydRequest.mockResolvedValue({ ok: true, data: { status: "done", screenshots: {} } });
	const result = await tool(context(), "replay_capture").execute(
		"id",
		{ purpose: "留证", raw: "GET / HTTP/1.1\r\nHost: x\r\n\r\n" },
		undefined,
		undefined,
		{} as never,
	);
	expect(result.isError).toBe(true);
	expect(blocks(result).text).toContain("没有返回截图产物");
});

test("a missing browser is reported with the way to fix it", async () => {
	replaydRequest.mockResolvedValue({
		ok: true,
		data: {
			status: "error",
			error: { code: "capture_failed", message: "browser: 未找到可用浏览器。可设置 REPLAYD_CHROME_PATH" },
		},
	});
	const result = await tool(context(), "replay_capture").execute(
		"id",
		{ purpose: "留证", raw: "GET / HTTP/1.1\r\nHost: x\r\n\r\n" },
		undefined,
		undefined,
		{} as never,
	);
	const { text } = blocks(result);
	expect(result.isError).toBe(true);
	expect(text).toContain("未找到可用浏览器");
	expect(text).toContain("重建镜像");
});

test("replay_flows does not ask for approval and lists what was captured", async () => {
	replaydRequest.mockResolvedValue({
		ok: true,
		data: {
			items: [
				{
					id: "flw_1",
					ts: "2026-10-23T13:00:00+08:00",
					source: "proxy",
					method: "GET",
					scheme: "https",
					host: "a.test",
					port: 443,
					path: "/api/login",
					status: 200,
					respSize: 1830,
					note: "render: https://a.test/",
				},
			],
			total: 1,
			hasMore: false,
		},
	});
	const result = await tool(context(), "replay_flows").execute(
		"id",
		{ limit: 5, host: "a.test" },
		undefined,
		undefined,
		{} as never,
	);
	const { text } = blocks(result);
	expect(guarded).toHaveLength(0);
	expect(text).toContain("共 1 条");
	expect(text).toContain("https://a.test:443/api/login");
	expect(text).toContain("render: https://a.test/");
	const request = replaydRequest.mock.calls[0]?.[0] as { method: string; path: string };
	expect(request.method).toBe("GET");
	expect(request.path).toBe("/api/flows?limit=5&host=a.test");
});

test("an empty history says so instead of printing an empty list", async () => {
	replaydRequest.mockResolvedValue({ ok: true, data: { items: [], total: 0 } });
	const result = await tool(context(), "replay_flows").execute("id", {}, undefined, undefined, {} as never);
	expect(blocks(result).text).toContain("还没有任何 HTTP 记录");
});

test("a service that is not running fails before the approval chain", async () => {
	const result = await tool(
		context({ ensure: async () => ({ state: "binary_missing", error: "未找到 replayd_linux_amd64" }) }),
		"replay_capture",
	).execute("id", { purpose: "留证", raw: "GET / HTTP/1.1\r\nHost: x\r\n\r\n" }, undefined, undefined, {} as never);
	expect(result.isError).toBe(true);
	expect(blocks(result).text).toContain("replayd 不可用");
	expect(guarded).toHaveLength(0);
});
