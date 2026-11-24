/**
 * Unit tests for the gatekeeper judge: the one-line verdict parser, the endpoint
 * fallback chain, the guard's three outcomes (allow, block, failed) plus its
 * timeout, abort, and concurrency behavior, and the concurrency test of the
 * endpoint that the settings screen runs.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AuxiliaryModelConfig } from "../src/auxiliary-model.ts";
import {
	buildJudgeInput,
	buildToolJudgeInput,
	GATEKEEPER_TEST_SYSTEM_PROMPT,
	Gatekeeper,
	type JudgeCallResult,
	judgeLoadTestResult,
	judgeLoadTestSize,
	MAX_JUDGE_LOAD_TEST_SIZE,
	parseGateVerdict,
	resolveJudgeEndpoint,
} from "../src/gatekeeper.ts";
import { writeGatekeeperConfig } from "../src/gatekeeper-config.ts";
import { GatekeeperStore } from "../src/gatekeeper-store.ts";
import { writeCommanderModelConfig } from "../src/model-config.ts";
import { setLibraryRole } from "../src/model-library.ts";
import { writeTestModel } from "./model-fixtures.ts";

let root = "";
let agentDir = "";
let store: GatekeeperStore;

/** These cases judge bash; the MCP switch has its own file (tool-gate.test.ts). */
const MCP_OFF = { enabled: false, includePlugins: false };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-gatekeeper-"));
	agentDir = join(root, "agent");
	store = new GatekeeperStore(join(root, "gatekeeper.db"));
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

function newGatekeeper(): Gatekeeper {
	return new Gatekeeper(store, { onDecision: () => {} }, agentDir);
}

/** A stub that answers with a fixed raw line. */
function stubAnswer(gatekeeper: Gatekeeper, raw: string): void {
	gatekeeper.call = async (): Promise<JudgeCallResult> => ({
		verdict: parseGateVerdict(raw),
		raw,
		usage: { input: 100, output: 3, total: 103 },
	});
}

describe("parseGateVerdict", () => {
	test("the settings connectivity probe uses a short prompt", () => {
		expect(GATEKEEPER_TEST_SYSTEM_PROMPT.length).toBeLessThan(100);
		expect(GATEKEEPER_TEST_SYSTEM_PROMPT).toContain("只回复 ALLOW");
	});
	test("accepts a bare ALLOW, with punctuation and markdown wrapping", () => {
		for (const raw of ["ALLOW", "allow", " ALLOW ", "ALLOW.", "`ALLOW`", "**ALLOW**", "放行"]) {
			expect(parseGateVerdict(raw)).toEqual({ decision: "allow" });
		}
	});

	test("accepts BLOCK with a reason", () => {
		expect(parseGateVerdict("BLOCK:删除系统文件，命中第 4 条")).toEqual({
			decision: "block",
			reason: "删除系统文件，命中第 4 条",
		});
	});

	test("accepts the malformed block spellings rather than failing open", () => {
		for (const raw of [
			"BLOCK",
			"BLOCKED: 停止业务服务",
			"block：清空数据库",
			"拦截：创建用户",
			"**BLOCK**: rm 系统文件",
		]) {
			expect(parseGateVerdict(raw).decision).toBe("block");
		}
	});

	test("uses a default reason when a block carries none", () => {
		const verdict = parseGateVerdict("BLOCK");
		expect(verdict.decision).toBe("block");
		if (verdict.decision === "block") expect(verdict.reason).toContain("守门员判定");
	});

	test("reads only the first non-empty line", () => {
		expect(parseGateVerdict("\n\nBLOCK: 命中第 5 条\n说明文字")).toEqual({
			decision: "block",
			reason: "命中第 5 条",
		});
	});

	test("throws on prose and on an empty answer, so the caller fails open", () => {
		for (const raw of ["", "   ", "这条命令看起来可以放行", "I cannot judge this", "BLOCKEDX"]) {
			expect(() => parseGateVerdict(raw)).toThrow();
		}
	});

	test("caps an overlong reason", () => {
		const verdict = parseGateVerdict(`BLOCK:${"很".repeat(500)}`);
		if (verdict.decision === "block") {
			expect(verdict.reason.length).toBeLessThanOrEqual(201);
			expect(verdict.reason.endsWith("…")).toBe(true);
		}
	});
});

describe("buildJudgeInput", () => {
	test("carries the tool, source, cwd, and the command verbatim", () => {
		const input = buildJudgeInput({ command: "rm -f /etc/passwd", cwd: "/work/tasks/a", source: "子代理" });
		expect(input).toBe("工具：bash\n来源：子代理\n工作目录：/work/tasks/a\n命令：\nrm -f /etc/passwd");
	});

	test("defaults the working directory to /work", () => {
		expect(buildJudgeInput({ command: "id", source: "主代理" })).toContain("工作目录：/work");
	});
});

describe("buildToolJudgeInput", () => {
	test("frames an MCP call as a tool with arguments, not a shell command", () => {
		const input = buildToolJudgeInput({
			tool: "mcp__plugin-com-sentinel-vshell__execute_command",
			server: "plugin-com-sentinel-vshell",
			args: '{"host_id":"h1","command":"systemctl stop nginx"}',
			source: "主代理",
		});
		expect(input).toBe(
			[
				"工具：mcp__plugin-com-sentinel-vshell__execute_command",
				"服务器：plugin-com-sentinel-vshell",
				"来源：主代理",
				"工作目录：/work",
				"参数：",
				'{"host_id":"h1","command":"systemctl stop nginx"}',
			].join("\n"),
		);
		expect(input).not.toContain("命令：");
	});

	test("omits the server line when the caller does not know it", () => {
		const input = buildToolJudgeInput({ tool: "mcp__x__y", args: "{}", source: "子代理" });
		expect(input).not.toContain("服务器：");
	});

	test("truncates a huge argument blob instead of sending a whole file", () => {
		const input = buildToolJudgeInput({ tool: "mcp__x__upload", args: "A".repeat(20_000), source: "主代理" });
		expect(input.length).toBeLessThan(4 * 1024 + 200);
		expect(input).toContain("已截断");
	});
});

describe("resolveJudgeEndpoint", () => {
	test("uses the entry the 守门模型 role points at", () => {
		writeTestModel(agentDir, { baseUrl: "http://main/v1", apiKey: "", modelId: "main" });
		writeCommanderModelConfig(agentDir, { baseUrl: "http://cmdr/v1", apiKey: "", modelId: "cmdr" });
		writeTestModel(agentDir, { baseUrl: "http://judge/v1", apiKey: "sk-judge", modelId: "judge" }, "judge");
		expect(resolveJudgeEndpoint(agentDir)).toEqual({
			config: {
				agentDir,
				providerId: "zg-model-2",
				baseUrl: "http://judge/v1",
				apiKey: "sk-judge",
				modelId: "judge",
				capabilities: { api: "openai-completions", input: ["text", "image"] },
			},
			from: "judge",
			followedMain: false,
		});
	});

	test("follows 主模型 when the role says so, and the commander slot is not consulted", () => {
		writeTestModel(agentDir, { baseUrl: "http://main/v1", apiKey: "", modelId: "main" });
		writeCommanderModelConfig(agentDir, { baseUrl: "http://cmdr/v1", apiKey: "", modelId: "cmdr" });
		expect(resolveJudgeEndpoint(agentDir)).toEqual({
			// An unauthenticated endpoint is stored with the placeholder bearer.
			config: {
				agentDir,
				providerId: "zg-model-1",
				baseUrl: "http://main/v1",
				apiKey: "sentinel-no-auth",
				modelId: "main",
				capabilities: { api: "openai-completions", input: ["text", "image"] },
			},
			from: "main",
			followedMain: true,
		});
		setLibraryRole(agentDir, "judge", "follow-main");
		expect(resolveJudgeEndpoint(agentDir).followedMain).toBe(true);
	});

	test("reports nothing configured on a fresh agent dir", () => {
		expect(resolveJudgeEndpoint(agentDir)).toEqual({ config: null, from: null, followedMain: false });
	});
});

describe("Gatekeeper.guard", () => {
	test("allows and records when the judge says ALLOW", async () => {
		writeTestModel(agentDir, { baseUrl: "http://judge/v1", apiKey: "", modelId: "judge-stub" }, "judge");
		const gatekeeper = newGatekeeper();
		stubAnswer(gatekeeper, "ALLOW");
		const outcome = await gatekeeper.guard({ command: "nmap -sV target", source: "主代理" });
		expect(outcome.kind).toBe("allow");
		const page = store.list(undefined);
		expect(page.total).toBe(1);
		expect(page.items[0].decision).toBe("allow");
		expect(page.items[0].model).toBe("judge-stub");
		expect(page.items[0].modelFrom).toBe("judge-stub");
		expect(page.items[0].totalTokens).toBe(103);
	});

	test("blocks with the reason and a message the model can act on", async () => {
		writeTestModel(agentDir, { baseUrl: "http://judge/v1", apiKey: "", modelId: "judge-stub" }, "judge");
		const gatekeeper = newGatekeeper();
		stubAnswer(gatekeeper, "BLOCK:清空业务数据表，命中第 4 条");
		const outcome = await gatekeeper.guard({ command: 'mysql -e "DROP TABLE orders"', source: "主代理" });
		expect(outcome.kind).toBe("block");
		if (outcome.kind === "block") {
			expect(outcome.reason).toContain("第 4 条");
			expect(outcome.message).toContain("守门员拦截");
		}
		expect(store.list(undefined).items[0].decision).toBe("block");
	});

	test("judges an MCP tool call and names the tool in the rejection", async () => {
		writeTestModel(agentDir, { baseUrl: "http://judge/v1", apiKey: "", modelId: "judge-stub" }, "judge");
		const gatekeeper = newGatekeeper();
		stubAnswer(gatekeeper, "BLOCK:在受管主机上停止业务服务，命中第 5 条");
		const outcome = await gatekeeper.guard({
			tool: "mcp__plugin-com-sentinel-vshell__execute_command",
			server: "plugin-com-sentinel-vshell",
			command: '{"host_id":"h1","command":"systemctl stop nginx"}',
			source: "主代理",
		});
		expect(outcome.kind).toBe("block");
		if (outcome.kind === "block") {
			// Not "命令未执行": this was a tool call, and the model should see which one.
			expect(outcome.message).toContain("工具调用未执行");
			expect(outcome.message).toContain("execute_command");
		}
		const record = store.list(undefined).items[0];
		expect(record.tool).toBe("mcp__plugin-com-sentinel-vshell__execute_command");
		expect(record.command).toContain("systemctl stop nginx");
	});

	test("the judge sees the tool name and the argument JSON, not a command field", async () => {
		writeTestModel(agentDir, { baseUrl: "http://judge/v1", apiKey: "", modelId: "judge-stub" }, "judge");
		const gatekeeper = newGatekeeper();
		let seen = "";
		gatekeeper.call = async (_config, input): Promise<JudgeCallResult> => {
			seen = input;
			return { verdict: { decision: "allow" }, raw: "ALLOW" };
		};
		await gatekeeper.guard({
			tool: "mcp__files__delete_file",
			server: "files",
			command: '{"path":"/data/orders"}',
			source: "子代理",
		});
		expect(seen).toContain("工具：mcp__files__delete_file");
		expect(seen).toContain("服务器：files");
		expect(seen).toContain('{"path":"/data/orders"}');
		expect(seen).not.toContain("命令：");
	});

	test("allows through and records a failure when the endpoint errors", async () => {
		writeTestModel(agentDir, { baseUrl: "http://judge/v1", apiKey: "", modelId: "judge-stub" }, "judge");
		const gatekeeper = newGatekeeper();
		gatekeeper.call = async () => {
			throw new Error("端点返回 500：boom");
		};
		const outcome = await gatekeeper.guard({ command: "id", source: "主代理" });
		expect(outcome.kind).toBe("failed");
		const record = store.list(undefined).items[0];
		expect(record.decision).toBe("failed");
		expect(record.error).toContain("boom");
	});

	test("allows through and records a failure when the answer is unparseable", async () => {
		writeTestModel(agentDir, { baseUrl: "http://judge/v1", apiKey: "", modelId: "judge-stub" }, "judge");
		const gatekeeper = newGatekeeper();
		stubAnswer(gatekeeper, "我觉得这条命令没问题");
		const outcome = await gatekeeper.guard({ command: "id", source: "主代理" });
		expect(outcome.kind).toBe("failed");
		expect(store.list(undefined).items[0].decision).toBe("failed");
	});

	test("records a failure with no endpoint configured instead of throwing", async () => {
		const gatekeeper = newGatekeeper();
		const outcome = await gatekeeper.guard({ command: "id", source: "主代理" });
		expect(outcome.kind).toBe("failed");
		if (outcome.kind === "failed") expect(outcome.error).toContain("未配置守门模型");
		expect(store.stats().failures).toBe(1);
	});

	test("times out into a failure, and says so", async () => {
		writeTestModel(agentDir, { baseUrl: "http://judge/v1", apiKey: "", modelId: "judge-stub" }, "judge");
		writeGatekeeperConfig(agentDir, { mode: "ai", timeoutMs: 1000, concurrency: 0, mcpTools: MCP_OFF });
		const gatekeeper = newGatekeeper();
		gatekeeper.call = (_config, _input, signal) =>
			new Promise<JudgeCallResult>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		const outcome = await gatekeeper.guard({ command: "id", source: "主代理" });
		expect(outcome.kind).toBe("failed");
		expect(store.list(undefined).items[0].error).toContain("超时");
	});

	test("an operator abort judges nothing and records nothing", async () => {
		writeTestModel(agentDir, { baseUrl: "http://judge/v1", apiKey: "", modelId: "judge-stub" }, "judge");
		const gatekeeper = newGatekeeper();
		const controller = new AbortController();
		gatekeeper.call = (_config, _input, signal) =>
			new Promise<JudgeCallResult>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				controller.abort();
			});
		const outcome = await gatekeeper.guard({ command: "id", source: "主代理", signal: controller.signal });
		expect(outcome.kind).toBe("aborted");
		expect(store.list(undefined).total).toBe(0);
	});

	test("does not judge at all when the run was already aborted", async () => {
		writeTestModel(agentDir, { baseUrl: "http://judge/v1", apiKey: "", modelId: "judge-stub" }, "judge");
		const gatekeeper = newGatekeeper();
		let called = false;
		gatekeeper.call = async () => {
			called = true;
			return { verdict: { decision: "allow" }, raw: "ALLOW" };
		};
		const controller = new AbortController();
		controller.abort();
		const outcome = await gatekeeper.guard({ command: "id", source: "主代理", signal: controller.signal });
		expect(outcome.kind).toBe("aborted");
		expect(called).toBe(false);
		expect(store.list(undefined).total).toBe(0);
	});

	test("honors the concurrency limit, and 0 means no limit", async () => {
		writeTestModel(agentDir, { baseUrl: "http://judge/v1", apiKey: "", modelId: "judge-stub" }, "judge");
		const run = async (concurrency: number): Promise<number> => {
			writeGatekeeperConfig(agentDir, { mode: "ai", timeoutMs: 15_000, concurrency, mcpTools: MCP_OFF });
			const gatekeeper = newGatekeeper();
			let running = 0;
			let peak = 0;
			gatekeeper.call = async () => {
				running += 1;
				peak = Math.max(peak, running);
				await new Promise((resolve) => setTimeout(resolve, 20));
				running -= 1;
				return { verdict: { decision: "allow" }, raw: "ALLOW" };
			};
			await Promise.all([
				gatekeeper.guard({ command: "a", source: "主代理" }),
				gatekeeper.guard({ command: "b", source: "主代理" }),
				gatekeeper.guard({ command: "c", source: "主代理" }),
			]);
			return peak;
		};
		expect(await run(1)).toBe(1);
		expect(await run(0)).toBe(3);
	});
});

describe("Gatekeeper.loadTest", () => {
	const config: AuxiliaryModelConfig = {
		agentDir,
		providerId: "judge-entry",
		baseUrl: "http://judge/v1",
		apiKey: "",
		modelId: "judge-stub",
	};

	test("sends every judgment at once with the real prompt, and reports how many answered and how fast", async () => {
		const gatekeeper = newGatekeeper();
		let running = 0;
		let peak = 0;
		const prompts: Array<string | undefined> = [];
		const inputs: string[] = [];
		gatekeeper.call = async (_config, input, _signal, systemPrompt) => {
			running += 1;
			peak = Math.max(peak, running);
			prompts.push(systemPrompt);
			inputs.push(input);
			await new Promise((resolve) => setTimeout(resolve, 20));
			running -= 1;
			return { verdict: { decision: "allow" }, raw: "ALLOW" };
		};
		const report = await gatekeeper.loadTest(config, 10, 15_000);
		expect(report).toMatchObject({ concurrency: 10, succeeded: 10, failures: [] });
		expect(peak).toBe(10);
		// The latency shown is the one a real judgment has, not a connectivity check's.
		expect(prompts.every((prompt) => prompt === undefined)).toBe(true);
		expect(inputs).toHaveLength(10);
		expect(inputs[0]).toContain("nmap -sV -p 1-1000 target");
		const { min, median, avg, max } = report.latencyMs ?? {};
		expect(min).toBeGreaterThan(0);
		expect(min).toBeLessThanOrEqual(median ?? Number.POSITIVE_INFINITY);
		expect(median).toBeLessThanOrEqual(max ?? 0);
		expect(avg).toBeGreaterThanOrEqual(min ?? 0);
		expect(avg).toBeLessThanOrEqual(max ?? 0);
		// A settings check: nothing reaches the audit.
		expect(store.list(undefined).total).toBe(0);
	});

	test("counts a timeout and an endpoint error as failures, and times only the judgments that answered", async () => {
		const gatekeeper = newGatekeeper();
		let nth = 0;
		gatekeeper.call = (_config, _input, signal) => {
			nth += 1;
			if (nth === 1)
				return new Promise<JudgeCallResult>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			if (nth === 2) return Promise.reject(new Error("HTTP 503"));
			return Promise.resolve({ verdict: { decision: "allow" }, raw: "ALLOW" });
		};
		const report = await gatekeeper.loadTest(config, 3, 50);
		expect(report.concurrency).toBe(3);
		expect(report.succeeded).toBe(1);
		expect(report.failures).toEqual(["守门判定超时（50ms）", "HTTP 503"]);
		// An answer that comes back within the same millisecond takes 0 ms.
		const only = report.latencyMs?.min;
		expect(only).toBeGreaterThanOrEqual(0);
		expect(report.latencyMs).toEqual({ min: only, median: only, avg: only, max: only });
	});

	test("reports no latency when nothing succeeded", async () => {
		const gatekeeper = newGatekeeper();
		gatekeeper.call = async () => {
			throw new Error("connection refused");
		};
		const report = await gatekeeper.loadTest(config, 4, 1000);
		expect(report.succeeded).toBe(0);
		expect(report.latencyMs).toBeUndefined();
		expect(report.failures).toEqual(Array(4).fill("connection refused"));
	});

	test("passes only when every judgment answered, and then says what is at stake", () => {
		expect(
			judgeLoadTestResult({
				concurrency: 10,
				succeeded: 10,
				failures: [],
				latencyMs: { min: 1, median: 1, avg: 1, max: 1 },
			}),
		).toEqual({
			ok: true,
			message: "守门模型并发测试通过",
		});
		expect(judgeLoadTestResult({ concurrency: 10, succeeded: 9, failures: ["守门判定超时（15000ms）"] })).toEqual({
			ok: false,
			message: "守门模型并发测试未通过",
			detail: "您配置的模型可能无法成功进行 AI 审批守门",
		});
	});

	test("an omitted size is the single connectivity check, and the size is capped", () => {
		expect(judgeLoadTestSize(undefined)).toBe(1);
		expect(judgeLoadTestSize(10)).toBe(10);
		expect(judgeLoadTestSize(4.6)).toBe(5);
		expect(judgeLoadTestSize(0)).toBe(1);
		expect(judgeLoadTestSize(Number.NaN)).toBe(1);
		expect(judgeLoadTestSize(1000)).toBe(MAX_JUDGE_LOAD_TEST_SIZE);
	});
});
