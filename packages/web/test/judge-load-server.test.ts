/**
 * The 守门模型 concurrency test over the real console. Ten judgments leave at
 * once for the configured endpoint, and the answer says how many came back and
 * how fast. A judgment that outlives the gatekeeper's own timeout is a failure,
 * because in a run that command would have gone through unjudged.
 */

import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import WebSocket, { type RawData } from "ws";
import { writeGatekeeperConfig } from "../src/gatekeeper-config.ts";
import type { SentinelJudgeLoadReport, SentinelServerMessage, SentinelTestResult } from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";
import { type FakeDocker, installFakeDocker } from "./fake-docker.ts";
import { writeTestModel } from "./model-fixtures.ts";
import { modelStream } from "./model-stream-fixtures.ts";

const MCP_OFF = { enabled: false, includePlugins: false };
type Console = Awaited<ReturnType<typeof startSentinelServer>>;

/** A judge endpoint that answers `ALLOW`, holding each request open for `holdMs`; `stall` picks the ones that never answer. */
function judgeEndpoint(
	holdMs: number,
	stall: (request: number) => boolean = () => false,
): {
	server: Server;
	/** The most requests that were open at the same time. */
	peak: () => number;
} {
	let inFlight = 0;
	let peak = 0;
	let requests = 0;
	const server = createServer((request, response) => {
		request.resume();
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		if (stall(++requests)) {
			// Left open until the console gives up on it. (The request itself ends at once; it is
			// the response that stays open, so the socket closing is what ends it.)
			response.once("close", () => {
				inFlight -= 1;
			});
			return;
		}
		void setTimeout(async () => {
			inFlight -= 1;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(await modelStream("openai-completions", "ALLOW").text());
		}, holdMs);
	});
	return { server, peak: () => peak };
}

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return `http://127.0.0.1:${address.port}/v1`;
}

/** The next message of one kind, or a rejection when none arrives in time. */
function nextOf(client: WebSocket, type: SentinelServerMessage["type"]): Promise<SentinelServerMessage> {
	return new Promise((resolve, reject) => {
		const onMessage = (data: RawData) => {
			const message = JSON.parse(String(data)) as SentinelServerMessage;
			if (message.type !== type) return;
			clearTimeout(timer);
			client.off("message", onMessage);
			resolve(message);
		};
		const timer = setTimeout(() => {
			client.off("message", onMessage);
			reject(new Error(`no ${type} within 20 seconds`));
		}, 20_000);
		client.on("message", onMessage);
	});
}

/** A console on a temporary directory, with the 守门模型 role on a stub endpoint. */
async function openConsole(
	name: string,
	endpoint?: Server,
	timeoutMs = 10_000,
): Promise<{
	server: Console;
	client: WebSocket;
	docker: FakeDocker;
	close: () => void;
}> {
	const root = mkdtempSync(join(tmpdir(), `sentinel-${name}-`));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const docker = installFakeDocker(root, join(root, "workspace"));
	if (endpoint) {
		writeTestModel(agentDir, { baseUrl: await listen(endpoint), apiKey: "", modelId: "judge-stub" }, "judge");
		writeGatekeeperConfig(agentDir, { mode: "ai", timeoutMs, concurrency: 0, mcpTools: MCP_OFF });
	}
	const server = await startSentinelServer({ agentDir, cwd: join(root, "workspace"), auth: false, port: 0 });
	const client = new WebSocket(`${server.url.replace("http:", "ws:")}/ws`);
	await once(client, "open");
	return {
		server,
		client,
		docker,
		close: () => {
			client.terminate();
			server.close();
			docker.restore();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** Ask for a concurrency test and read its report: what it measured and how it was judged. */
async function loadReport(
	client: WebSocket,
	concurrency: number,
): Promise<SentinelJudgeLoadReport & { result: SentinelTestResult }> {
	const answered = nextOf(client, "judge_test_result");
	client.send(JSON.stringify({ type: "test_judge", concurrency }));
	const message = await answered;
	if (message.type !== "judge_test_result" || !message.load) throw new Error("the answer carries no load report");
	return { ...message.load, result: message.result };
}

test("ten judgments go out at once, and the answer says how many came back and how fast", async () => {
	const endpoint = judgeEndpoint(150);
	const target = await openConsole("judge-load", endpoint.server);
	try {
		const report = await loadReport(target.client, 10);
		expect(report.result).toEqual({ ok: true, message: "守门模型并发测试通过" });
		expect(report).toMatchObject({ concurrency: 10, succeeded: 10, failures: [] });
		// Each judgment was held for 150 ms before it answered.
		expect(report.latencyMs?.min).toBeGreaterThan(100);
		expect(endpoint.peak()).toBe(10);

		// Without a size it is still the one connectivity check, with the raw answer.
		const single = nextOf(target.client, "judge_test_result");
		target.client.send(JSON.stringify({ type: "test_judge" }));
		expect(await single).toMatchObject({ type: "judge_test_result", result: { ok: true }, raw: "ALLOW" });
	} finally {
		endpoint.server.close();
		target.close();
	}
}, 30_000);

test("a judgment that outlives the gatekeeper's timeout fails the test, which then says what is at stake", async () => {
	// Every third request never answers.
	const endpoint = judgeEndpoint(50, (request) => request % 3 === 0);
	const target = await openConsole("judge-timeout", endpoint.server, 1000);
	try {
		const report = await loadReport(target.client, 10);
		expect(report.result).toEqual({
			ok: false,
			message: "守门模型并发测试未通过",
			detail: "您配置的模型可能无法成功进行 AI 审批守门",
		});
		expect(report).toMatchObject({
			concurrency: 10,
			succeeded: 7,
			failures: Array(3).fill("守门判定超时（1000ms）"),
		});
	} finally {
		endpoint.server.close();
		target.close();
	}
}, 30_000);

test("a size above the cap is clamped", async () => {
	const endpoint = judgeEndpoint(20);
	const target = await openConsole("judge-clamp", endpoint.server);
	try {
		expect(await loadReport(target.client, 1000)).toMatchObject({ concurrency: 20, succeeded: 20 });
	} finally {
		endpoint.server.close();
		target.close();
	}
}, 30_000);

test("with no model behind the role, the answer is a failure that says where to pick one", async () => {
	const target = await openConsole("judge-none");
	try {
		const asked = nextOf(target.client, "judge_test_result");
		target.client.send(JSON.stringify({ type: "test_judge", concurrency: 10 }));
		expect(await asked).toMatchObject({
			type: "judge_test_result",
			result: { ok: false, message: "没有可用的守门模型" },
		});
	} finally {
		target.close();
	}
}, 30_000);
