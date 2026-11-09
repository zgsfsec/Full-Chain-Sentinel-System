/**
 * End-to-end smoke test for the Full Chain Sentinel web console.
 *
 * Drives the full stack without external services: a local fake OpenAI-compatible
 * endpoint serves scripted responses, the server runs against a temp agent dir,
 * and a WebSocket client plays the operator. Verifies the two core behaviors:
 * review-mode approval with command editing, and auto-mode passthrough.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDefaultSessionDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import { modelsJsonPath } from "../src/model-config.ts";
import { readStoredModelLibrary, setLibraryRole } from "../src/model-library.ts";
import type { SentinelPermissionsConfig } from "../src/permissions.ts";
import type {
	SentinelClientMessage,
	SentinelEngine,
	SentinelFileEntry,
	SentinelFilePreview,
	SentinelGateFilter,
	SentinelGatePage,
	SentinelMode,
	SentinelModelLibraryView,
	SentinelNotifyConfig,
	SentinelPresetView,
	SentinelServerMessage,
	SentinelStateSnapshot,
	SentinelSubagentEvent,
	SentinelSubagentRun,
	SentinelSupervisorAuditPage,
	SentinelSupervisorDetail,
	SentinelSupervisorView,
	SentinelVulnerability,
} from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";
import { type FakeDocker, installFakeDocker, projectSlug } from "./fake-docker.ts";
import { writeTestModel } from "./model-fixtures.ts";

/** Scripted assistant turns the fake endpoint serves in order. */
type ScriptStep = {
	toolCallCommand?: string;
	secondToolCallCommand?: string;
	text?: string;
	spawnAgent?: { task: string };
	/** A tool call the model makes by name, used for the hub's own tools. */
	toolCall?: { name: string; args: Record<string, unknown> };
};

const SCRIPT: ScriptStep[] = [
	{ toolCallCommand: "echo sentinel-original-command" },
	{ text: "REVIEW_RUN_COMPLETE" },
	{ toolCallCommand: "echo sentinel-auto-command" },
	{ text: "AUTO_RUN_COMPLETE" },
	{ toolCallCommand: "echo sentinel-batch-a", secondToolCallCommand: "echo sentinel-batch-b" },
	{ text: "BATCH_COMPLETE" },
	{ toolCallCommand: "echo sentinel-whitelisted-a" },
	{ text: "WHITELIST_FIRST_COMPLETE" },
	{ toolCallCommand: "echo sentinel-whitelisted-b" },
	{ text: "WHITELIST_SECOND_COMPLETE" },
	// Sub-agent scenario: parent spawns, the sub-agent runs bash, both finish.
	{ spawnAgent: { task: "recon the target" } },
	{ toolCallCommand: "echo sentinel-subagent-command" },
	{ text: "SUBAGENT_DONE" },
	{ text: "PARENT_SUMMARY" },
	{ text: "SECOND_SESSION_PING" },
	{ text: "FORK_TURN" },
];

/** Project the suite creates; its work directory backs the file-panel assertions. */
const PROJECT_NAME = "e2e-project";

/** Prompt that identifies the sub-agent scenario served out of band. */
const SECOND_SCENARIO_PROMPT = "delegate a read-only recon";
/** Task the sub-agent of that scenario receives. */
const SECOND_SCENARIO_TASK = "recon the second target";
/** Command the second scenario's sub-agent runs, to prove it can execute. */
const SECOND_SCENARIO_COMMAND = "echo sentinel-subagent-command-2";
/** Output marker of that command, used to detect its tool result. */
const SECOND_SCENARIO_OUTPUT = "sentinel-subagent-command-2";
/** Marker present in every sub-agent system prompt. */
const SUBAGENT_MARKER = "sub-agent of Full Chain Sentinel";

/**
 * Text vuln_submit returns; only used to assert what the tool answered.
 */
const VULN_SUBMITTED_MARKER = "已提交到漏洞中枢";

/** Prompt that only asks which tools the session mounted; answered out of band. */
const TOOLS_PROBE_PROMPT = "check the hub tools";
/** Marker text of that probe run. */
const TOOLS_PROBE_DONE = "TOOLS_PROBE_DONE";

/**
 * Compaction scenario. pi only summarizes when there is something to summarize,
 * so the session is filled past its keep-recent threshold with a few large
 * turns, and then the summarization request itself is held open: a model that
 * never answers is exactly the case where the console must show the wait and
 * offer a cancel.
 */
const COMPACT_FILL_PROMPT = "sentinel-compact-fill 写一份很长的报告";
const COMPACT_FILL_TEXT = "COMPACT_FILL_MARKER ".repeat(2500);
const COMPACT_FILL_DONE = "COMPACT_FILL_DONE";
/**
 * pi's own summarization prompts. A compaction that cuts inside a turn issues
 * two requests (the history, then the turn prefix), and both have to be stalled
 * for the wait to be the one the operator sees.
 */
const COMPACTION_PROMPT_MARKERS = ["a conversation to summarize", "earlier context from an ongoing conversation"];
const COMPACTION_SUMMARY_TEXT = "COMPACTION_SUMMARY";

/**
 * Hub scenarios, routed by prompt: the first turn calls vuln_submit, the second
 * (recognized by the title already sitting in the transcript) finishes the run.
 * The title doubles as the marker, so nothing depends on script position.
 */
const VULN_SCENARIOS = [
	{
		prompt: "submit the finding to the hub",
		done: "VULN_SUBMIT_DONE",
		args: {
			title: "后台登录处 SQL 注入",
			severity: "medium",
			cvss: 6.5,
			target: "http://10.10.10.5/admin/login",
			category: "SQL 注入",
			description: "登录参数拼接进 SQL，可用布尔盲注绕过认证。",
			packet: "POST /admin/login HTTP/1.1\nHost: 10.10.10.5\n\nuser=admin' AND 1=1--",
			evidence: [
				{
					kind: "command",
					command: "sqlmap -u http://10.10.10.5/admin/login --data user=admin",
					output: "parameter 'user' is vulnerable",
				},
			],
		},
	},
	{
		prompt: "submit a critical finding",
		done: "VULN_CRITICAL_DONE",
		args: {
			title: "命令注入",
			severity: "critical",
			cvss: 9.8,
			target: "http://10.10.10.5/ping",
			category: "命令注入",
			description: "cmd 参数直接进入 shell，可执行任意命令。",
			packet: "GET /ping?cmd=;id HTTP/1.1\nHost: 10.10.10.5",
		},
	},
] as const;

/**
 * Persistent-goal scenarios, routed by the objective sitting in the transcript.
 * A continuation is injected as a custom message, which the model receives as a
 * user message, so the newest user message is no longer the objective: the
 * scenarios match on the whole request body instead.
 */
const GOAL_COMPLETE_PROMPT = "zg-goal-complete 对 10.10.10.5 完成侦察";
const GOAL_LIMIT_PROMPT = "zg-goal-limit 完成全端口扫描";
const GOAL_NOPROGRESS_PROMPT = "zg-goal-noprogress 写出完整报告";
const GOAL_STUTTER_PROMPT = "zg-goal-stutter 观察目标主机";
/** Text of the goal_progress tool result, used to recognize the second turn. */
const GOAL_PROGRESS_MARKER = "目标进度已更新";
/** Text of the goal_complete tool result, used to recognize the third turn. */
const GOAL_COMPLETED_MARKER = "目标已完成：";

/**
 * Preset-agent scenarios. Both halves of the feature are driven here: a console
 * session that was created with a preset, and an engine whose commander picks a
 * preset for one task and has an out-of-whitelist pick refused for the next.
 *
 * The body markers are distinctive on purpose: the session-side assertion reads
 * them out of the addendum section of the system prompt AND out of the request
 * body the fake endpoint received, so "the text reached the model" is proven at
 * the wire, not merely by the console's own snapshot.
 */
const PRESET_NAME = "Web 侦察 e2e";
const PRESET_DESCRIPTION = "先指纹后目录后参数";
const PRESET_TAGS = ["web", "外网"];
const PRESET_BODY_MARKER = "PRESET_ADDENDUM_MARKER_ALPHA";
const PRESET_EDITED_MARKER = "PRESET_ADDENDUM_MARKER_BETA";
/** The composer hint the preset brings, and the one an edit replaces it with. */
const PRESET_PLACEHOLDER = "说说这次要看的目标";
const PRESET_PLACEHOLDER_EDITED = "这次先看目录，再说参数";
const PRESET_SESSION_PROMPT = "preset session turn";
const PRESET_SESSION_DONE = "PRESET_SESSION_DONE";
const PRESET_SESSION_SECOND_PROMPT = "preset session second turn";
const PRESET_SESSION_SECOND_DONE = "PRESET_SESSION_SECOND_DONE";

/**
 * Switching a live session's preset from the composer. Three turns of one
 * conversation: the first under preset A, the second after switching to B, the
 * third after switching back to the default agent. Each turn's request body is
 * what proves which briefing was in force.
 */
const PRESET_SWITCH_NAME_A = "切换前 e2e";
const PRESET_SWITCH_NAME_B = "切换后 e2e";
const PRESET_SWITCH_MARKER_A = "PRESET_SWITCH_MARKER_DELTA";
const PRESET_SWITCH_MARKER_B = "PRESET_SWITCH_MARKER_EPSILON";
const PRESET_SWITCH_PROMPT = "preset switch turn";
const PRESET_SWITCH_DONE = "PRESET_SWITCH_DONE";
const PRESET_SWITCH_SECOND_PROMPT = "preset switch second turn";
const PRESET_SWITCH_SECOND_DONE = "PRESET_SWITCH_SECOND_DONE";
const PRESET_SWITCH_THIRD_PROMPT = "preset switch third turn";
const PRESET_SWITCH_THIRD_DONE = "PRESET_SWITCH_THIRD_DONE";

/**
 * The sub-agent half of the preset feature. The parent session delegates one
 * task, and the child's own request body is what proves the inheritance: a
 * sub-agent is a separate session, so nothing about the parent's prompt travels
 * with it unless the code puts it there.
 */
const PRESET_SUBAGENT_NAME = "子代理继承 e2e";
const PRESET_SUBAGENT_MARKER = "PRESET_SUBAGENT_MARKER_GAMMA";
const PRESET_SUBAGENT_PROMPT = "preset subagent turn";
const PRESET_SUBAGENT_TASK = "recon the preset target";
const PRESET_SUBAGENT_CHILD_DONE = "PRESET_SUBAGENT_CHILD_DONE";
const PRESET_SUBAGENT_PARENT_DONE = "PRESET_SUBAGENT_PARENT_DONE";

/** Marker only the commander's own system prompt carries, used to tell it apart. */
const COMMANDER_BRIEF_MARKER = "全链哨兵 工程模式的主指挥官";
const ENGINE_PRESET_NAME = "AD 枚举 e2e";
const ENGINE_PRESET_DESCRIPTION = "域内账户枚举";
const ENGINE_PRESET_MARKER = "ENGINE_PRESET_ADDENDUM_MARKER";
/** Id the commander asks for but may not use; it must never reach the board. */
const ENGINE_BAD_PRESET_ID = "preset-not-in-whitelist";
/** Objectives double as routing markers, since a tool call echoes its arguments back. */
const ENGINE_OBJECTIVE_MARKER = "MARKER_ENGINE_TASK_ONE";
const ENGINE_BAD_OBJECTIVE_MARKER = "MARKER_ENGINE_BAD_PRESET";
const ENGINE_WORKER_SUMMARY = "ENGINE_TASK_ONE_DONE";
const ENGINE_REPORT_MARKER = "ENGINE_PRESET_REPORT";

/** The engine preset's generated id, filled in by the test before the engine runs. */
let enginePresetId = "";
/** Commander system prompts as the fake endpoint saw them, for the brief assertion. */
const commanderBodies: string[] = [];
/** The delegating sub-agent's request body, so the test can read its system prompt. */
let presetSubagentBody = "";

/**
 * One turn of a goal scenario. The complete scenario reports progress, then
 * completes with the evidence and the criterion the test asked for; the other two
 * only ever answer with prose, which is what trips the budget and the fuse.
 */
function goalStep(body: string): ScriptStep | undefined {
	if (body.includes(GOAL_LIMIT_PROMPT)) return { text: "GOAL_LIMIT_ROUND" };
	if (body.includes(GOAL_NOPROGRESS_PROMPT)) return { text: "GOAL_IDLE_ROUND" };
	// The same degenerate output on every run, nudges included: the loop-guard
	// aborts each one, and the goal must not pay for those rounds.
	if (body.includes(GOAL_STUTTER_PROMPT)) return { text: `${GOAL_STUTTER_PROMPT}\n`.repeat(12) };
	if (!body.includes(GOAL_COMPLETE_PROMPT)) return undefined;
	if (body.includes(GOAL_COMPLETED_MARKER)) return { text: "GOAL_COMPLETE_DONE" };
	if (body.includes(GOAL_PROGRESS_MARKER)) {
		return {
			toolCall: {
				name: "goal_complete",
				args: {
					summary: "侦察完成：开放 22/80，未发现可利用点",
					evidence: ["nmap -p- 10.10.10.5：22/tcp open ssh，80/tcp open http"],
					findings: { submitted: 0, note: "全端口扫描后只有默认配置，没有可提交的发现" },
					criteria: [{ criterion: "端口已确认", met: true, evidence: "nmap 输出" }],
				},
			},
		};
	}
	return {
		toolCall: {
			name: "goal_progress",
			args: { done: ["全端口扫描完成"], todo: ["确认 80 端口服务"], blockers: [] },
		},
	};
}

/** Tool names a goal request mounted, so the test can prove the tools are there. */
let goalTools: string[] = [];

/**
 * Gatekeeper scenarios, routed by prompt so they never consume the shared
 * script. Each runs one bash command, and the fake judge answers for it.
 */
const GATE_ALLOW_PROMPT = "sentinel-gate-allow 跑一条守门放行的命令";
const GATE_BLOCK_PROMPT = "sentinel-gate-block 跑一条守门拦截的命令";
const GATE_FAIL_PROMPT = "sentinel-gate-fail 跑一条守门判定失败的命令";
const GATE_PREFIX_PROMPT = "sentinel-gate-prefix 跑一条白名单前缀命令";
const GATE_ALLOWED_COMMAND = "echo sentinel-gate-allowed";
const GATE_BLOCKED_COMMAND = "echo sentinel-gate-block-ran";
const GATE_FAILED_COMMAND = "echo sentinel-gate-failed";
const GATE_PREFIXED_COMMAND = "echo sentinel-gate-prefixed";
/**
 * What each command prints. A tool result carries the output only, never the
 * command, so "did this command run" must be asked of these, not of the command
 * text (which every transcript shows once the model proposed it).
 */
const GATE_ALLOWED_OUTPUT = "sentinel-gate-allowed";
const GATE_BLOCKED_OUTPUT = "sentinel-gate-block-ran";
const GATE_FAILED_OUTPUT = "sentinel-gate-failed";
const GATE_PREFIXED_OUTPUT = "sentinel-gate-prefixed";
/** Reason the fake judge returns for a block; distinctive so the transcript can be searched for it. */
const GATE_BLOCK_REASON = "会破坏目标数据库可用性";
/** Marker of the judge's own system prompt, which is how a judge call is recognized. */
const JUDGE_MARKER = "操作守门员";

/**
 * One bash turn per scenario, then a text turn once the result is in. The block
 * scenario also ends on the command's own output, so a block that failed to
 * happen still terminates the run instead of looping on the same tool call; the
 * test then asserts that output never appeared.
 */
function gateStep(prompt: string, body: string): ScriptStep | undefined {
	const scenarios = [
		{
			prompt: GATE_ALLOW_PROMPT,
			command: GATE_ALLOWED_COMMAND,
			markers: [GATE_ALLOWED_COMMAND],
			done: "GATE_ALLOW_DONE",
		},
		{
			prompt: GATE_BLOCK_PROMPT,
			command: GATE_BLOCKED_COMMAND,
			markers: [GATE_BLOCK_REASON, GATE_BLOCKED_COMMAND],
			done: "GATE_BLOCK_DONE",
		},
		{
			prompt: GATE_FAIL_PROMPT,
			command: GATE_FAILED_COMMAND,
			markers: [GATE_FAILED_COMMAND],
			done: "GATE_FAIL_DONE",
		},
		{
			prompt: GATE_PREFIX_PROMPT,
			command: GATE_PREFIXED_COMMAND,
			markers: [GATE_PREFIXED_COMMAND],
			done: "GATE_PREFIX_DONE",
		},
	];
	const scenario = scenarios.find((entry) => entry.prompt === prompt);
	if (!scenario) return undefined;
	if (scenario.markers.some((marker) => body.includes(marker))) return { text: scenario.done };
	return { toolCall: { name: "bash", args: { command: scenario.command } } };
}

/** Commands the fake judge was asked about, in order, so a test can prove every command was judged. */
const judgedCommands: string[] = [];

/** What the fake judge answers next. */
let judgeBehavior: { kind: "allow" } | { kind: "block"; reason: string } | { kind: "error" } | { kind: "garbage" } = {
	kind: "allow",
};

let endpoint: Server;
let endpointPort = 0;
let tempRoot = "";
/** Agent directory of the running server; the hub's database lives here. */
let agentDir = "";
let closeServer: (() => void) | undefined;
let serverUrl = "";
let ws: WebSocket | undefined;
let fakeDocker: FakeDocker | undefined;
/** Host directory mounted at /work for the suite's project. */
let workDir = "";
/** Id of the suite's main project, so a test can return to it after switching. */
let mainProjectId = "";
/** Library entry 主模型 points at, which is also the provider id in models.json. */
let mainEntryId = "";
/** Tool names a chat request advertised, in wire order. */
function toolNamesOf(body: string): string[] {
	let parsed: { tools?: Array<{ function?: { name?: string }; name?: string }> };
	try {
		parsed = JSON.parse(body) as typeof parsed;
	} catch {
		return [];
	}
	return (parsed.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? "").filter(Boolean);
}

/** Body of the most recent completion request, for asserting what reached the model. */
let lastRequestBody = "";
/** Tools the newest main-session request advertised. */
let mainTools: string[] = [];
/** Tools the newest sub-agent request advertised. */
let subagentTools: string[] = [];
/** The out-of-band image response is served once, then the script resumes. */
let imageTurnServed = false;

function sseChunk(payload: Record<string, unknown>): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function functionCall(id: string, name: string, args: Record<string, unknown>, index = 0) {
	return {
		index,
		id: `call_${id}${index > 0 ? `_${index}` : ""}`,
		type: "function",
		function: { name, arguments: JSON.stringify(args) },
	};
}

function toolCallResponse(id: string, command: string, secondCommand?: string): string {
	// OpenAI wire format: `arguments` is a JSON *string* containing the args object.
	const calls = [
		functionCall(id, "bash", { command }),
		...(secondCommand ? [functionCall(id, "bash", { command: secondCommand }, 1)] : []),
	];
	return [
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
		}),
		...calls.map((call) =>
			sseChunk({
				id,
				object: "chat.completion.chunk",
				choices: [
					{
						index: 0,
						delta: { tool_calls: [call] },
						finish_reason: null,
					},
				],
			}),
		),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		}),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		}),
		"data: [DONE]\n\n",
	].join("");
}

function spawnAgentResponse(id: string, task: string): string {
	const call = functionCall(id, "spawn_agent", { task });
	return [
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
		}),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }],
		}),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		}),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		}),
		"data: [DONE]\n\n",
	].join("");
}

/** One named tool call, used to drive the hub's own tools without a real model. */
function namedToolCallResponse(id: string, name: string, args: Record<string, unknown>): string {
	const call = functionCall(id, name, args);
	return [
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
		}),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }],
		}),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		}),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		}),
		"data: [DONE]\n\n",
	].join("");
}

function textResponse(id: string, text: string): string {
	return [
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
		}),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
		}),
		sseChunk({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		}),
		"data: [DONE]\n\n",
	].join("");
}

let requestCount = 0;

/** Text of the newest user message in a chat request. */
function lastUserText(body: string): string {
	let parsed: { messages?: Array<{ role?: string; content?: unknown }> };
	try {
		parsed = JSON.parse(body) as typeof parsed;
	} catch {
		return "";
	}
	const users = (parsed.messages ?? []).filter((message) => message.role === "user");
	const last = users[users.length - 1];
	if (!last) return "";
	if (typeof last.content === "string") return last.content;
	if (Array.isArray(last.content)) {
		return (last.content as Array<{ type?: string; text?: string }>)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join(" ");
	}
	return "";
}

/** The command inside a judge request, read out of its user message. */
function judgeCommandOf(body: string): string {
	const text = lastUserText(body);
	const marker = "命令：";
	const index = text.indexOf(marker);
	return index === -1 ? text : text.slice(index + marker.length).trim();
}

function startFakeEndpoint(): Promise<void> {
	endpoint = createHttpServer((request, response) => {
		if (!(request.method === "POST" && request.url?.includes("/chat/completions"))) {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			// Consume the request so keep-alive does not stall.
			lastRequestBody = body;
			// A gatekeeper judgment: a non-streaming completion whose system prompt is
			// the judge's own. Answered out of band, so it consumes no scripted step
			// and never looks like an agent turn.
			if (body.includes(JUDGE_MARKER)) {
				judgedCommands.push(judgeCommandOf(body));
				if (judgeBehavior.kind === "error") {
					response.writeHead(500, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { message: "judge endpoint down" } }));
					return;
				}
				const content =
					judgeBehavior.kind === "block"
						? `BLOCK: ${judgeBehavior.reason}`
						: judgeBehavior.kind === "garbage"
							? "这条命令看起来有点问题"
							: "ALLOW";
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						id: "chatcmpl-judge",
						object: "chat.completion",
						choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
						usage: { prompt_tokens: 320, completion_tokens: 4, total_tokens: 324 },
					}),
				);
				return;
			}
			// A compaction's summarization request. `stallCompaction` holds it open
			// forever, which is what a slow or wedged endpoint looks like to pi.
			if (COMPACTION_PROMPT_MARKERS.some((marker) => body.includes(marker))) {
				compactionRequests += 1;
				if (stallCompaction) return;
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				response.end(textResponse("chatcmpl-summary", COMPACTION_SUMMARY_TEXT));
				return;
			}
			// An image turn answers out of band so it does not consume a scripted step.
			// Only the first request carrying an image is special-cased: the image stays
			// in the session history, so later requests also mention one.
			const isImageTurn = !imageTurnServed && body.includes("image_url");
			if (isImageTurn) imageTurnServed = true;
			// The second sub-agent scenario is routed by content rather than by script
			// index, so it does not depend on how many turns the earlier tests used.
			const fromSubagent = body.includes(SUBAGENT_MARKER);
			if (fromSubagent) subagentTools = toolNamesOf(body);
			else mainTools = toolNamesOf(body);
			const inSecondScenario = fromSubagent
				? body.includes(SECOND_SCENARIO_TASK)
				: body.includes(SECOND_SCENARIO_PROMPT);
			const newestPrompt = lastUserText(body);
			// Prompts answered with fixed text: they must not consume the shared
			// scripted steps, which every scenario in this file draws from in order.
			const staticStep: ScriptStep | undefined =
				newestPrompt === "check the main model switch"
					? { text: "MAIN_MODEL_SWITCH_OK" }
					: newestPrompt === "notify me when this finishes"
						? { text: "NOTIFY_RUN_COMPLETE" }
						: newestPrompt === "force a notification"
							? { text: "FORCED_NOTIFY_COMPLETE" }
							: newestPrompt === "stay quiet"
								? { text: "QUIET_RUN_COMPLETE" }
								: newestPrompt === "label this session"
									? { text: "LABEL_RUN_DONE" }
									: undefined;
			// Hub scenarios: the first turn submits, the second recognizes its own
			// tool call (its target is echoed back in the transcript) and finishes.
			// A failed call ends the scenario too, so a disabled tool cannot make
			// the fake model loop on the same tool call forever.
			const vulnScenario = VULN_SCENARIOS.find((scenario) => newestPrompt === scenario.prompt);
			const vulnStep: ScriptStep | undefined = vulnScenario
				? body.includes(vulnScenario.args.target) || body.includes("Tool vuln_submit not found")
					? { text: vulnScenario.done }
					: { toolCall: { name: "vuln_submit", args: vulnScenario.args } }
				: undefined;
			const probeStep: ScriptStep | undefined =
				newestPrompt === TOOLS_PROBE_PROMPT ? { text: TOOLS_PROBE_DONE } : undefined;
			const compactFillStep: ScriptStep | undefined =
				newestPrompt === COMPACT_FILL_PROMPT ? { text: `${COMPACT_FILL_DONE}\n${COMPACT_FILL_TEXT}` } : undefined;
			// Preset session turns, answered out of band like the other routed prompts.
			const presetSessionStep: ScriptStep | undefined =
				newestPrompt === PRESET_SESSION_PROMPT
					? { text: PRESET_SESSION_DONE }
					: newestPrompt === PRESET_SESSION_SECOND_PROMPT
						? { text: PRESET_SESSION_SECOND_DONE }
						: undefined;
			// Preset switching: one conversation, three turns, each routed by its text.
			const presetSwitchStep: ScriptStep | undefined =
				newestPrompt === PRESET_SWITCH_PROMPT
					? { text: PRESET_SWITCH_DONE }
					: newestPrompt === PRESET_SWITCH_SECOND_PROMPT
						? { text: PRESET_SWITCH_SECOND_DONE }
						: newestPrompt === PRESET_SWITCH_THIRD_PROMPT
							? { text: PRESET_SWITCH_THIRD_DONE }
							: undefined;
			// The parent delegates once, then finishes; the child answers with prose so
			// no approval gate is involved. Both turns are routed by the task text,
			// which a tool call echoes back, so the scenario does not depend on how many
			// turns the earlier tests used.
			const presetSubagentStep: ScriptStep | undefined =
				body.includes(PRESET_SUBAGENT_TASK) || body.includes(PRESET_SUBAGENT_CHILD_DONE)
					? fromSubagent
						? { text: PRESET_SUBAGENT_CHILD_DONE }
						: { text: PRESET_SUBAGENT_PARENT_DONE }
					: newestPrompt === PRESET_SUBAGENT_PROMPT
						? { spawnAgent: { task: PRESET_SUBAGENT_TASK } }
						: undefined;
			if (fromSubagent && body.includes(PRESET_SUBAGENT_TASK)) presetSubagentBody = body;
			// An engineering run is two sessions on this same endpoint: the commander,
			// recognized by the role line in its brief, and the worker, recognized by
			// the objective it was handed. The commander dispatches once with the
			// whitelisted preset, once with an id it may not use, then finishes.
			const fromCommander = body.includes(COMMANDER_BRIEF_MARKER);
			if (fromCommander) commanderBodies.push(body);
			const commanderStep: ScriptStep | undefined = fromCommander
				? !body.includes(ENGINE_OBJECTIVE_MARKER)
					? {
							toolCall: {
								name: "dispatch_task",
								args: {
									title: "域内账户枚举",
									objective: `枚举域内账户。${ENGINE_OBJECTIVE_MARKER}`,
									target: "10.0.0.7",
									preset: enginePresetId,
								},
							},
						}
					: // While the task runs the commander has nothing better to do than
						// wait for its result. A prose turn is safe here: the engine only
						// nudges an idle commander when the board has nothing outstanding.
						!body.includes(ENGINE_WORKER_SUMMARY)
						? { text: "等这次枚举的结果。" }
						: !body.includes(ENGINE_BAD_OBJECTIVE_MARKER)
							? {
									toolCall: {
										name: "dispatch_task",
										args: {
											title: "越权预设",
											objective: `换一个预设再试。${ENGINE_BAD_OBJECTIVE_MARKER}`,
											target: "10.0.0.8",
											preset: ENGINE_BAD_PRESET_ID,
										},
									},
								}
							: !body.includes(ENGINE_REPORT_MARKER)
								? { toolCall: { name: "engine_done", args: { report: `# 报告\n${ENGINE_REPORT_MARKER}` } } }
								: // The report is in: stop calling tools so the run ends instead of
									// asking for engine_done forever.
									{ text: "报告已提交，等待操作员复核。" }
				: undefined;
			const workerStep: ScriptStep | undefined =
				!fromCommander && body.includes(ENGINE_OBJECTIVE_MARKER) && !body.includes(ENGINE_WORKER_SUMMARY)
					? {
							toolCall: {
								name: "goal_complete",
								args: {
									summary: ENGINE_WORKER_SUMMARY,
									evidence: ["netexec --users 列出了 3 个域账户"],
									findings: { submitted: 0, note: "只做枚举，没有可提交的发现" },
									criteria: [{ criterion: "枚举出域内账户", met: true, evidence: "netexec 输出" }],
								},
							},
						}
					: undefined;
			const goal = goalStep(body);
			if (goal && !fromSubagent) goalTools = toolNamesOf(body);
			const gate = gateStep(newestPrompt, body);
			const step = isImageTurn
				? { text: "IMAGE_TURN_OK" }
				: staticStep
					? staticStep
					: vulnStep
						? vulnStep
						: probeStep
							? probeStep
							: compactFillStep
								? compactFillStep
								: presetSessionStep
									? presetSessionStep
									: presetSwitchStep
										? presetSwitchStep
										: presetSubagentStep
											? presetSubagentStep
											: commanderStep
												? commanderStep
												: workerStep
													? workerStep
													: goal
														? goal
														: gate
															? gate
															: inSecondScenario
																? fromSubagent
																	? body.includes(SECOND_SCENARIO_OUTPUT)
																		? { text: "SECOND_SUBAGENT_DONE" }
																		: { toolCallCommand: SECOND_SCENARIO_COMMAND }
																	: body.includes("SECOND_SUBAGENT_DONE")
																		? { text: "SECOND_PARENT_SUMMARY" }
																		: { spawnAgent: { task: SECOND_SCENARIO_TASK } }
																: (SCRIPT[requestCount] ?? SCRIPT[SCRIPT.length - 1]);
			if (
				!isImageTurn &&
				!inSecondScenario &&
				!staticStep &&
				!vulnStep &&
				!probeStep &&
				!compactFillStep &&
				!presetSessionStep &&
				!presetSubagentStep &&
				!commanderStep &&
				!workerStep &&
				!goal &&
				!gate
			) {
				requestCount += 1;
			}
			const id = `chatcmpl-${isImageTurn ? "image" : staticStep ? "static" : vulnStep ? "vuln" : probeStep ? "probe" : compactFillStep ? "fill" : presetSessionStep ? "preset" : presetSubagentStep ? "preset-subagent" : commanderStep ? "commander" : workerStep ? "worker" : goal ? "goal" : gate ? "gate" : inSecondScenario ? "second" : requestCount}`;
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.end(
				step.toolCall
					? namedToolCallResponse(id, step.toolCall.name, step.toolCall.args)
					: step.toolCallCommand
						? toolCallResponse(id, step.toolCallCommand, step.secondToolCallCommand)
						: step.spawnAgent
							? spawnAgentResponse(id, step.spawnAgent.task)
							: textResponse(id, step.text ?? ""),
			);
		});
	});
	return new Promise((resolve) => {
		endpoint.listen(0, "127.0.0.1", () => {
			endpointPort = (endpoint.address() as { port: number }).port;
			resolve();
		});
	});
}

/** Notifications the fake DingTalk robot received. */
const dingtalk: Array<{ url: string; text: string; title: string }> = [];
let dingtalkServer: Server | undefined;
let dingtalkUrl = "";

/** Set while the test wants a summarization request to hang instead of answering. */
let stallCompaction = false;
/** Summarization requests the fake endpoint saw, so the test can prove one was made. */
let compactionRequests = 0;

/** Queue of incoming server messages plus waiters. */
const incoming: SentinelServerMessage[] = [];
const waiters: Array<{
	predicate: (message: SentinelServerMessage) => boolean;
	resolve: (message: SentinelServerMessage) => void;
}> = [];

function dispatch(message: SentinelServerMessage): void {
	console.error(`[dispatch] ${message.type} waiters=${waiters.length} incoming=${incoming.length}`);
	const index = waiters.findIndex((waiter) => waiter.predicate(message));
	if (index >= 0) {
		const [waiter] = waiters.splice(index, 1);
		waiter.resolve(message);
		return;
	}
	incoming.push(message);
}

function waitFor(
	predicate: (message: SentinelServerMessage) => boolean,
	timeoutMs = 30000,
): Promise<SentinelServerMessage> {
	const index = incoming.findIndex(predicate);
	if (index >= 0) {
		const [message] = incoming.splice(index, 1);
		return Promise.resolve(message);
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			const position = waiters.indexOf(waiter);
			if (position >= 0) waiters.splice(position, 1);
			void fetch(`${serverUrl}/api/health`)
				.then((r) => r.text())
				.then((t) => console.log("DIAG health during timeout:", t))
				.catch((e) => console.log("DIAG health failed:", String(e)));
			reject(
				new Error(
					`Timed out (ws readyState=${ws?.readyState}). Received: ${JSON.stringify(
						incoming.map((message) =>
							message.type === "snapshot"
								? {
										type: "snapshot",
										mode: message.snapshot.mode,
										streaming: message.snapshot.streaming,
										approvals: message.snapshot.pendingApprovals.map((a) => a.command),
										toolText: toolResultText(message.snapshot).slice(0, 120),
										messages: message.snapshot.messages.length,
										compacting: message.snapshot.compacting,
										compactionStartedAt: message.snapshot.compactionStartedAt,
									}
								: message.type === "session_event"
									? {
											type: "session_event",
											event: (message.event as { type?: string }).type,
											stop:
												(message.event as { message?: { stopReason?: string; errorMessage?: string } })
													.message?.stopReason ?? undefined,
											err:
												(
													message.event as { message?: { errorMessage?: string } }
												).message?.errorMessage?.slice(0, 200) ?? undefined,
										}
									: { type: message.type, ...(message.type === "error" ? { message: message.message } : {}) },
						),
						null,
						1,
					)}`,
				),
			);
		}, timeoutMs);
		const waiter = {
			predicate,
			resolve: (message: SentinelServerMessage) => {
				clearTimeout(timer);
				resolve(message);
			},
		};
		waiters.push(waiter);
	});
}

function send(message: SentinelClientMessage): void {
	ws?.send(JSON.stringify(message));
}

/** Drop buffered server messages so a new test only sees fresh state. */
function drainIncoming(): void {
	incoming.length = 0;
}

function snapshotWhere(
	predicate: (snapshot: SentinelStateSnapshot) => boolean,
	timeoutMs?: number,
): Promise<SentinelStateSnapshot> {
	return waitFor((message) => message.type === "snapshot" && predicate(message.snapshot), timeoutMs).then(
		(message) => (message as { snapshot: SentinelStateSnapshot }).snapshot,
	);
}

/** Wait past the point where a fire-and-forget webhook POST would have landed. */
function settleWebhook(ms = 800): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a local condition: used for out-of-band effects such as a webhook POST. */
function waitUntil(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const tick = (): void => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() - startedAt > timeoutMs) {
				reject(new Error("Timed out waiting for a local condition"));
				return;
			}
			setTimeout(tick, 50);
		};
		tick();
	});
}

function toolResultText(snapshot: SentinelStateSnapshot): string {
	return snapshot.messages
		.filter((message) => (message as { role?: string }).role === "toolResult")
		.map((message) => {
			const content = (message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
			return content.map((block) => block.text ?? "").join("");
		})
		.join("\n");
}

/**
 * Run one hub scenario: the fake model calls vuln_submit, the record is pushed
 * to every console, and the run then finishes. Returns the submitted record as
 * the hub read it back.
 */
async function submitViaAgent(prompt: string, done: string): Promise<SentinelVulnerability> {
	drainIncoming();
	send({ type: "prompt", text: prompt });

	// The console learns about the finding the moment it is created, before the
	// run ends: that is what makes the hub page live.
	const listed = await waitFor((message) => message.type === "vulns" && message.items.length > 0);
	const first = (listed as { items: Array<{ id: string }> }).items[0];
	expect(first).toBeDefined();

	const settled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes(done),
					),
			),
	);
	// The tool itself answered, not just the scripted finish text.
	expect(toolResultText(settled)).toContain(VULN_SUBMITTED_MARKER);

	drainIncoming();
	send({ type: "get_vuln", id: first?.id ?? "" });
	const fetched = await waitFor((message) => message.type === "vuln");
	return (fetched as { vuln: SentinelVulnerability }).vuln;
}

beforeAll(async () => {
	await startFakeEndpoint();
	// Plays the DingTalk custom robot: records the markdown it is sent.
	dingtalkServer = createHttpServer((request, response) => {
		let raw = "";
		request.on("data", (chunk: Buffer) => {
			raw += chunk.toString();
		});
		request.on("end", () => {
			const body = JSON.parse(raw) as { markdown?: { title?: string; text?: string } };
			dingtalk.push({
				url: request.url ?? "",
				text: body.markdown?.text ?? "",
				title: body.markdown?.title ?? "",
			});
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
		});
	});
	await new Promise<void>((resolve) => dingtalkServer?.listen(0, "127.0.0.1", resolve));
	const dingtalkAddress = dingtalkServer.address();
	const dingtalkPort = typeof dingtalkAddress === "object" && dingtalkAddress ? dingtalkAddress.port : 0;
	dingtalkUrl = `http://127.0.0.1:${dingtalkPort}/robot/send?access_token=e2e-token`;
	tempRoot = mkdtempSync(join(tmpdir(), "sentinel-web-e2e-"));
	agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "workspace");
	mkdirSync(cwd, { recursive: true });
	mainEntryId = writeTestModel(agentDir, {
		baseUrl: `http://127.0.0.1:${endpointPort}/v1`,
		apiKey: "test-key",
		modelId: "sentinel-fake-model",
	});
	// The console refuses to run without a project, and projects need a container.
	// The fake docker supplies one on PATH so the real container scripts still run.
	workDir = join(tempRoot, "projects", projectSlug(PROJECT_NAME));
	fakeDocker = installFakeDocker(tempRoot, workDir);
	const started = await startSentinelServer({ cwd, agentDir, host: "127.0.0.1", port: 0, auth: false });
	closeServer = started.close;
	serverUrl = started.url;
	ws = new WebSocket(serverUrl.replace("http://", "ws://").concat("/ws"));
	ws.on("message", (data) => {
		const text = String(data);
		if (text.includes("sessions")) console.error(`[cli-dbg] recv ${text.length}B: ${text.slice(0, 60)}`);
		dispatch(JSON.parse(text) as SentinelServerMessage);
	});
	await new Promise<void>((resolve, reject) => {
		if (!ws) throw new Error("no socket");
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});

	// Create and enter the project every other test runs inside.
	send({ type: "add_project", name: PROJECT_NAME });
	const created = await waitFor((message) => message.type === "projects" && message.projects.length === 1);
	const projectId = (created as { projects: Array<{ id: string }> }).projects[0]?.id ?? "";
	expect(projectId).not.toBe("");
	mainProjectId = projectId;
	send({ type: "switch_project", id: projectId });
	const entered = await snapshotWhere((snapshot_) => snapshot_.project?.id === projectId);
	expect(entered.project?.name).toBe(PROJECT_NAME);
	drainIncoming();
});

afterAll(() => {
	ws?.close();
	closeServer?.();
	dingtalkServer?.close();
	endpoint?.close();
	fakeDocker?.restore();
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test("starts configured with review mode and the custom endpoint model", async () => {
	send({ type: "get_state" });
	const snapshot = await snapshotWhere((snapshot_) => snapshot_.modelConfigured);
	expect(snapshot.mode).toBe("review");
	// The provider is the library entry that 主模型 points at.
	expect(snapshot.model?.provider).toBe(mainEntryId);
	expect(snapshot.model?.id).toBe("sentinel-fake-model");
});

test("review mode gates bash, executes the edited command, and streams the final answer", async () => {
	drainIncoming();
	send({ type: "prompt", text: "run the recon echo" });

	const gated = await snapshotWhere((snapshot_) => snapshot_.pendingApprovals.length > 0);
	expect(gated.pendingApprovals[0]?.command).toContain("sentinel-original-command");

	send({
		type: "decide",
		decision: { id: gated.pendingApprovals[0]?.id ?? "", approved: true, command: "echo sentinel-edited-command" },
	});

	const settled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming && snapshot_.pendingApprovals.length === 0 && toolResultText(snapshot_).length > 0,
	);
	expect(toolResultText(settled)).toContain("sentinel-edited-command");
	expect(toolResultText(settled)).not.toContain("sentinel-original-command");

	const finalText = settled.messages
		.filter((message) => (message as { role?: string }).role === "assistant")
		.map((message) =>
			((message as { content?: Array<{ type?: string; text?: string }> }).content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join(""),
		)
		.join("\n");
	expect(finalText).toContain("REVIEW_RUN_COMPLETE");
});

// Depends on the previous test having prompted: pi appends the system message on
// the first prompt, not at session creation.
test("the session keeps the default coding tools and lists them in the system prompt", async () => {
	drainIncoming();
	send({ type: "get_state" });
	const snapshot = await snapshotWhere((snapshot_) =>
		snapshot_.messages.some((message) => (message as { role?: string }).role === "system"),
	);
	const system = snapshot.messages.find((message) => (message as { role?: string }).role === "system") as
		| { sections?: Record<string, string> }
		| undefined;
	const tools = system?.sections?.tools ?? "";
	// The runtime replaces the base tool set to gate bash, so it must name the
	// default coding tools explicitly. Passing only bash leaves the session without
	// the file tools and drops every snippet except the custom tools'.
	for (const name of ["read", "bash", "edit", "write"]) {
		expect(tools).toContain(`- ${name}:`);
	}
	expect(tools).toContain("spawn_agent");
});

test("auto mode executes bash without approval", async () => {
	drainIncoming();
	send({ type: "set_mode", mode: "auto" });
	await snapshotWhere((snapshot_) => snapshot_.mode === "auto");

	send({ type: "prompt", text: "run it again" });

	const settled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.mode === "auto" &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("AUTO_RUN_COMPLETE"),
					),
			),
	);
	expect(toolResultText(settled)).toContain("sentinel-auto-command");
	// No approval was ever requested in auto mode: no request broadcast arrived
	// while the run was active.
	expect(settled.pendingApprovals).toEqual([]);
});

test("queued approvals show every pending command and decide_all approves them all", async () => {
	drainIncoming();
	send({ type: "get_state" });
	const before = await snapshotWhere(() => true);
	if (before.mode !== "review") {
		send({ type: "set_mode", mode: "review" });
		await snapshotWhere((snapshot_) => snapshot_.mode === "review");
	}
	drainIncoming();
	send({ type: "prompt", text: "run both" });

	const gated = await snapshotWhere((snapshot_) => snapshot_.pendingApprovals.length >= 2);
	const commands = gated.pendingApprovals.map((request) => request.command).sort();
	expect(commands).toEqual(["echo sentinel-batch-a", "echo sentinel-batch-b"]);

	send({ type: "decide_all", approved: true });

	const settled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.pendingApprovals.length === 0 &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("BATCH_COMPLETE"),
					),
			),
	);
	const text = toolResultText(settled);
	expect(text).toContain("sentinel-batch-a");
	expect(text).toContain("sentinel-batch-b");
});

test("alwaysAllowPrefix skips the queue for later commands with the same first word", async () => {
	drainIncoming();
	send({ type: "get_state" });
	const before = await snapshotWhere(() => true);
	if (before.mode !== "review") {
		send({ type: "set_mode", mode: "review" });
		await snapshotWhere((snapshot_) => snapshot_.mode === "review");
	}
	drainIncoming();
	send({ type: "prompt", text: "first whitelisted run" });
	const gated = await snapshotWhere((snapshot_) => snapshot_.pendingApprovals.length > 0);
	expect(gated.pendingApprovals[0]?.command).toContain("sentinel-whitelisted-a");

	send({
		type: "decide",
		decision: {
			id: gated.pendingApprovals[0]?.id ?? "",
			approved: true,
			command: "echo sentinel-whitelisted-a",
			alwaysAllowPrefix: true,
		},
	});

	const firstSettled = await snapshotWhere(
		(snapshot_) => !snapshot_.streaming && snapshot_.allowedPrefixes.includes("echo"),
	);
	expect(toolResultText(firstSettled)).toContain("sentinel-whitelisted-a");

	send({ type: "prompt", text: "second whitelisted run" });

	const secondSettled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("WHITELIST_SECOND_COMPLETE"),
					),
			),
	);
	// The second `echo` command never entered the approval queue.
	expect(secondSettled.pendingApprovals).toEqual([]);
	expect(toolResultText(secondSettled)).toContain("sentinel-whitelisted-b");

	// Cleanup: drop the prefix so later flows are not affected.
	send({ type: "remove_allowed_prefix", prefix: "echo" });
	await snapshotWhere((snapshot_) => !snapshot_.allowedPrefixes.includes("echo"));
});

test("saving an entry with an empty API key keeps the model usable", async () => {
	drainIncoming();
	send({ type: "get_model_library" });
	const library = await waitForFirst((message) => message.type === "model_library").then(
		(message) => (message as { library: SentinelModelLibraryView }).library,
	);
	const mainId = library.roles.main;
	expect(mainId).not.toBeNull();
	send({
		type: "save_model_entry",
		id: mainId ?? "",
		name: "主端点",
		baseUrl: library.entries.find((entry) => entry.id === mainId)?.baseUrl ?? "",
		apiKey: "",
		modelId: library.entries.find((entry) => entry.id === mainId)?.modelId ?? "",
	});
	const snapshot = await snapshotWhereFirst((snapshot_) => snapshot_.modelConfigured === true);
	expect(snapshot.model?.id).toBe("sentinel-fake-model");
});

test("spawn_agent delegates to a sub-agent whose bash goes through the same approval gate", async () => {
	send({ type: "get_state" });
	const before = await snapshotWhere(() => true);
	if (before.mode !== "review") {
		send({ type: "set_mode", mode: "review" });
		await snapshotWhere((snapshot_) => snapshot_.mode === "review");
	}
	drainIncoming();
	send({ type: "prompt", text: "delegate recon" });

	// The sub-agent's bash command lands in the shared queue, labeled as sub-agent.
	const gated = await snapshotWhere((snapshot_) => snapshot_.pendingApprovals.length > 0);
	expect(gated.pendingApprovals[0]?.source).toBe("子代理");
	expect(gated.pendingApprovals[0]?.command).toContain("sentinel-subagent-command");

	send({
		type: "decide",
		decision: { id: gated.pendingApprovals[0]?.id ?? "", approved: true },
	});

	// The parent receives the sub-agent result and finishes with its summary.
	const settled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string; toolName?: string }).role === "toolResult" &&
					(message as { toolName?: string }).toolName === "spawn_agent" &&
					JSON.stringify(message).includes("SUBAGENT_DONE"),
			) &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("PARENT_SUMMARY"),
					),
			),
	);
	// The spawn_agent result carries the sub-agent's run details. The approved
	// bash execution itself is proven by the sub-agent reaching its next turn
	// (SUBAGENT_DONE) — the loop only continues after a tool result.
	const spawnResult = settled.messages.find(
		(message) =>
			(message as { role?: string; toolName?: string }).role === "toolResult" &&
			(message as { toolName?: string }).toolName === "spawn_agent",
	);
	expect(JSON.stringify(spawnResult)).toContain('"turns":2');
});

test("an image attachment reaches the model and the turn completes", async () => {
	drainIncoming();
	// 4x4 PNG. pi re-encodes prompt images, so the assertion checks the wire shape
	// rather than the exact payload the operator sent.
	const png =
		"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR42mNUTX7NAANMDEgANwcASLQBeyNXiAIAAAAASUVORK5CYII=";
	send({
		type: "prompt",
		text: "look at this screenshot",
		images: [{ type: "image", data: png, mimeType: "image/png" }],
	});

	const settled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("IMAGE_TURN_OK"),
					),
			),
	);
	// The image survived the wire hop and reached the provider as an OpenAI image part.
	expect(lastRequestBody).toContain('"type":"image_url"');
	expect(lastRequestBody).toContain("data:image/png;base64,");
	// The operator's own message keeps the attachment for rendering.
	const userMessage = settled.messages.find(
		(message) =>
			(message as { role?: string }).role === "user" && JSON.stringify(message).includes("look at this screenshot"),
	);
	expect(JSON.stringify(userMessage)).toContain('"type":"image"');
});

test("thinking level is reported, validated, and changeable", async () => {
	drainIncoming();
	send({ type: "get_state" });
	const snapshot = await snapshotWhere((snapshot_) => snapshot_.modelConfigured);
	expect(snapshot.availableThinkingLevels.length).toBeGreaterThan(0);
	expect(snapshot.availableThinkingLevels).toContain(snapshot.thinkingLevel);

	// A level the model does not accept is rejected instead of silently clamped.
	send({ type: "set_thinking_level", level: "max" });
	if (!snapshot.availableThinkingLevels.includes("max")) {
		const error = await waitFor((message) => message.type === "error" && message.message.includes("思考等级"));
		expect((error as { message: string }).message).toContain("max");
	}

	drainIncoming();
	send({ type: "set_thinking_level", level: snapshot.thinkingLevel });
	await snapshotWhere((snapshot_) => snapshot_.thinkingLevel === snapshot.thinkingLevel);
});

test("compact reports a readable message when the session has nothing to compact", async () => {
	drainIncoming();
	send({ type: "compact" });
	// The fake session is far below the compaction threshold, so pi refuses; the
	// point is that the refusal reaches the operator as a Chinese message.
	const error = await waitFor((message) => message.type === "error");
	expect((error as { message: string }).message).toContain("无需压缩");
});

// Runs after the sub-agent scenarios above, which is what puts a finished run in
// this session's history.
test("sub-agent runs stream live, keep their process, and stay readable as history", async () => {
	drainIncoming();
	send({ type: "prompt", text: "delegate a read-only recon" });

	// The panel is fed live, before the run finishes.
	const live = await waitFor((message) => message.type === "subagent_event");
	const liveEvent = (live as { event: SentinelSubagentEvent }).event;
	expect(liveEvent.kind).toBeTruthy();
	expect(liveEvent.seq).toBeGreaterThan(0);

	// A sub-agent's command lands in the shared approval queue, labeled as a
	// sub-agent request.
	const gated = await snapshotWhere((snapshot_) => snapshot_.pendingApprovals.length > 0);
	expect(gated.pendingApprovals[0]?.source).toBe("子代理");
	expect(gated.pendingApprovals[0]?.command).toContain(SECOND_SCENARIO_OUTPUT);
	send({ type: "decide", decision: { id: gated.pendingApprovals[0]?.id ?? "", approved: true } });

	const settled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("SECOND_PARENT_SUMMARY"),
					),
			),
	);

	// The snapshot carries the run list for the active session, newest first.
	const runs = settled.subagents;
	expect(runs.length).toBeGreaterThanOrEqual(2);
	const newest = runs[0];
	expect(newest.status).toBe("done");
	expect(newest.task).toContain("recon the second target");
	expect(newest.turns).toBeGreaterThanOrEqual(1);
	// Summaries stay small: process steps are fetched per run.
	expect(newest.events).toBeUndefined();

	// Expanding one run loads its recorded process.
	send({ type: "get_subagent", id: newest.id });
	const loaded = await waitFor((message) => message.type === "subagent_run" && message.run.id === newest.id);
	const events = (loaded as { run: SentinelSubagentRun }).run.events ?? [];
	expect(events[0]?.kind).toBe("status");
	expect(events.some((event) => event.kind === "turn")).toBe(true);
	// The sub-agent's command ran: the recorded process holds the bash call and
	// its output.
	expect(events.some((event) => event.kind === "tool_start" && event.toolName === "bash")).toBe(true);
	expect(
		events.some(
			(event) =>
				event.kind === "tool_end" &&
				event.toolName === "bash" &&
				(event.output ?? "").includes(SECOND_SCENARIO_OUTPUT),
		),
	).toBe(true);
	// The finished call carries how long it ran, which the panel shows next to it.
	const bashEnd = events.find((event) => event.kind === "tool_end" && event.toolName === "bash");
	expect(typeof bashEnd?.durationMs).toBe("number");
	expect(bashEnd?.durationMs).toBeGreaterThanOrEqual(0);
	expect(events.some((event) => event.kind === "text" && (event.text ?? "").includes("SECOND_SUBAGENT_DONE"))).toBe(
		true,
	);
	expect(events[events.length - 1]?.kind).toBe("status");
	expect(events[events.length - 1]?.status).toBe("done");

	// A sub-agent is offered the same tools as the session that spawned it, which
	// includes what the loaded extensions contribute. spawn_agent is the one
	// exception, and withholding it is what stops delegation from recursing.
	for (const name of ["read", "bash", "edit", "write", "codemode", "tool_search"]) {
		expect(subagentTools).toContain(name);
	}
	expect(subagentTools).not.toContain("spawn_agent");
	// The parent keeps it, so the difference is the sub-agent's, not a global one.
	expect(mainTools).toContain("spawn_agent");

	// The first scenario's run kept its tool calls, so a finished run is reviewable
	// long after its in-memory session was disposed.
	const firstRun = runs.find((run) => run.task.includes("recon the target"));
	expect(firstRun).toBeDefined();
	send({ type: "get_subagent", id: firstRun?.id ?? "" });
	const firstLoaded = await waitFor((message) => message.type === "subagent_run" && message.run.id === firstRun?.id);
	const firstEvents = (firstLoaded as { run: SentinelSubagentRun }).run.events ?? [];
	const started = firstEvents.find((event) => event.kind === "tool_start" && event.toolName === "bash");
	expect(started).toBeDefined();
	const finished = firstEvents.find((event) => event.kind === "tool_end" && event.toolCallId === started?.toolCallId);
	expect(finished?.output ?? "").toContain("sentinel-subagent-command");

	// Reading it again returns the same steps: the record is durable, not a buffer.
	send({ type: "get_subagent", id: firstRun?.id ?? "" });
	const reread = await waitFor((message) => message.type === "subagent_run" && message.run.id === firstRun?.id);
	expect(((reread as { run: SentinelSubagentRun }).run.events ?? []).length).toBe(firstEvents.length);
});

test("a finished sub-agent cannot be aborted or steered", async () => {
	drainIncoming();
	send({ type: "get_state" });
	const snapshot = await snapshotWhere((snapshot_) => snapshot_.subagents.length > 0);
	const done = snapshot.subagents.find((run) => run.status !== "running");
	expect(done).toBeDefined();

	send({ type: "abort_subagent", id: done?.id ?? "" });
	const aborted = await waitFor((message) => message.type === "subagent_result" && message.action === "中止");
	expect((aborted as { ok: boolean }).ok).toBe(false);

	send({ type: "steer_subagent", id: done?.id ?? "", text: "keep going" });
	const steered = await waitFor((message) => message.type === "subagent_result" && message.action === "追加指令");
	expect((steered as { ok: boolean }).ok).toBe(false);
});

test("the file panel reads and writes inside the container work directory", async () => {
	drainIncoming();
	const listWork = async (path: string): Promise<SentinelFileEntry[]> => {
		send({ type: "list_files", path });
		const listed = await waitFor((message) => message.type === "files" && message.path === path);
		return (listed as { entries: SentinelFileEntry[] }).entries;
	};
	const preview = async (path: string): Promise<SentinelFilePreview> => {
		send({ type: "read_file", path });
		const read = await waitFor((message) => message.type === "file_preview" && message.preview.path === path);
		return (read as { preview: SentinelFilePreview }).preview;
	};
	const expectOk = async (action: string): Promise<void> => {
		const result = await waitFor((message) => message.type === "file_result" && message.action === action);
		expect((result as { ok: boolean; error?: string }).error ?? "").toBe("");
		expect((result as { ok: boolean }).ok).toBe(true);
	};

	// Write, including parent directories the panel has to create itself.
	send({ type: "write_file", path: "/work/reports/notes.txt", text: "hello zg" });
	await expectOk("保存");
	expect(await listWork("/work")).toEqual([expect.objectContaining({ name: "reports", type: "dir" })]);
	expect(await listWork("/work/reports")).toEqual([
		expect.objectContaining({ name: "notes.txt", type: "file", size: 8 }),
	]);

	// Preview returns the text, and editing replaces it.
	const first = await preview("/work/reports/notes.txt");
	expect(first.kind).toBe("text");
	expect(first.text).toBe("hello zg");
	expect(first.truncated).toBe(false);
	send({ type: "write_file", path: "/work/reports/notes.txt", text: "edited by the panel" });
	await expectOk("保存");
	expect((await preview("/work/reports/notes.txt")).text).toBe("edited by the panel");

	// Upload decodes base64 into the container, and binary files are flagged.
	const binary = Buffer.from([0x00, 0x01, 0x02, 0xff]).toString("base64");
	send({ type: "upload_file", path: "/work/reports/blob.bin", data: binary });
	await expectOk("上传");
	const uploaded = await preview("/work/reports/blob.bin");
	expect(uploaded.kind).toBe("binary");
	expect(uploaded.size).toBe(4);

	// Download round-trips the bytes back out.
	send({ type: "download_file", path: "/work/reports/blob.bin" });
	const downloaded = await waitFor((message) => message.type === "file_download");
	expect((downloaded as { data: string }).data).toBe(binary);
	expect((downloaded as { size: number }).size).toBe(4);

	// Rename moves the entry; an existing target is refused rather than overwritten.
	send({ type: "rename_path", from: "/work/reports/blob.bin", to: "/work/reports/renamed.bin" });
	await expectOk("重命名");
	expect((await listWork("/work/reports")).map((entry) => entry.name)).toContain("renamed.bin");
	send({ type: "rename_path", from: "/work/reports/renamed.bin", to: "/work/reports/notes.txt" });
	const refused = await waitFor((message) => message.type === "file_result" && message.action === "重命名");
	expect((refused as { ok: boolean; error?: string }).error).toContain("目标已存在");

	// Delete removes files and directories recursively.
	send({ type: "delete_path", path: "/work/reports" });
	await expectOk("删除");
	expect(await listWork("/work")).toEqual([]);
});

test("the file panel refuses paths outside /work", async () => {
	drainIncoming();
	const expectRejected = async (send: () => void): Promise<void> => {
		drainIncoming();
		send();
		const error = await waitFor((message) => message.type === "error" || message.type === "file_result");
		const text = error.type === "error" ? error.message : ((error as { error?: string }).error ?? "");
		expect(text).toMatch(/路径越界|不允许操作|已存在/);
	};

	await expectRejected(() => send({ type: "read_file", path: "/work/../etc/passwd" }));
	await expectRejected(() => send({ type: "list_files", path: "/etc" }));
	await expectRejected(() => send({ type: "write_file", path: "/work/../../tmp/sentinel-escape.txt", text: "nope" }));
	await expectRejected(() => send({ type: "delete_path", path: "/work" }));
	await expectRejected(() => send({ type: "make_directory", path: "/work" }));
});

test("sessions can be renamed and deleted from the sidebar", async () => {
	// An empty active session is intentionally not persisted, so operate on the
	// most recent listed session instead.
	send({ type: "list_sessions" });
	const listed = await waitFor((message) => message.type === "sessions");
	const sessions = (listed as { sessions: Array<{ path: string; id: string; name?: string }> }).sessions;
	expect(sessions.length).toBeGreaterThanOrEqual(1);
	const target = sessions[0];
	drainIncoming();

	// Rename.
	send({ type: "rename_session", path: target.path, name: "sentinel-renamed-session" });
	const renamed = await waitFor((message) => message.type === "sessions");
	expect(
		(renamed as { sessions: Array<{ path: string; name?: string }> }).sessions.some(
			(session) => session.path === target.path && session.name === "sentinel-renamed-session",
		),
	).toBe(true);

	// Delete it.
	drainIncoming();
	send({ type: "delete_session", path: target.path });
	const afterDelete = await waitFor((message) => message.type === "sessions");
	expect((afterDelete as { sessions: Array<{ path: string }> }).sessions.some((s) => s.path === target.path)).toBe(
		false,
	);

	// Foreign paths are rejected.
	drainIncoming();
	send({ type: "delete_session", path: "/etc/passwd" });
	await waitFor((message) => message.type === "error" && message.message.includes("拒绝"));
});

test("a session carries an operator status, from the toolbar and into the session list", async () => {
	// The previous test deleted the viewed session, so start from a fresh one. It
	// needs one real run first: an empty session is not written to disk at all, and
	// the session list reads statuses from files.
	send({ type: "new_session" });
	await snapshotWhere((snapshot_) => snapshot_.activeSessionId !== null && snapshot_.messages.length === 0);
	drainIncoming();
	send({ type: "prompt", text: "label this session" });
	const settled = await snapshotWhere((snapshot_) => !snapshot_.streaming && snapshot_.messages.length > 0);
	expect(settled.sessionStatus).toBeNull();
	const sessionId = settled.activeSessionId;

	// No path: this is the toolbar entry point, which labels the active session.
	drainIncoming();
	send({ type: "set_session_status", status: "todo" });
	expect((await snapshotWhere((snapshot_) => snapshot_.sessionStatus === "todo")).sessionStatus).toBe("todo");

	// The list carries the label, and the raw custom state stays on the server.
	drainIncoming();
	send({ type: "list_sessions" });
	const listed = await waitFor((message) => message.type === "sessions");
	const rows = (listed as { sessions: Array<{ id: string; status?: string; customState?: unknown }> }).sessions;
	const row = rows.find((session) => session.id === sessionId);
	expect(row?.status).toBe("todo");
	expect(row?.customState).toBeUndefined();

	// It is a session entry, so clearing it is written the same way.
	drainIncoming();
	send({ type: "set_session_status", status: null });
	expect((await snapshotWhere((snapshot_) => snapshot_.sessionStatus === null)).sessionStatus).toBeNull();

	// A path outside the session directory is refused.
	drainIncoming();
	send({ type: "set_session_status", path: "/etc/passwd", status: "todo" });
	await waitFor((message) => message.type === "error" && message.message.includes("拒绝"));
});

test("a finished run notifies the DingTalk group, and the composer flag can force one", async () => {
	// The session-management test deleted the viewed session, so start a fresh one.
	send({ type: "new_session" });
	await snapshotWhere((snapshot_) => snapshot_.activeSessionId !== null && snapshot_.messages.length === 0);
	drainIncoming();

	// Nothing has been sent yet: notifications are off by default.
	send({ type: "get_notify_config" });
	const initial = await waitFor((message) => message.type === "notify_config");
	expect((initial as { config: SentinelNotifyConfig }).config.groups).toEqual([]);
	expect(dingtalk).toHaveLength(0);

	// Enable notifications against the local robot.
	drainIncoming();
	send({
		type: "save_notify_config",
		config: {
			groups: [
				{
					id: "team",
					name: "安全团队",
					enabled: true,
					kinds: { runs: true, vulns: true, codeIntel: false, goals: true, engines: true, pocs: true },
					targets: [
						{
							id: "robot",
							name: "钉钉群",
							channel: "dingtalk",
							enabled: true,
							webhook: dingtalkUrl,
							secret: "SECe2e",
							keyword: "Full Chain Sentinel",
						},
					],
				},
			],
			summaryLimit: 2000,
		},
	});
	const saved = await waitFor((message) => message.type === "notify_config");
	expect((saved as { config: SentinelNotifyConfig }).config).toMatchObject({
		groups: [
			{ enabled: true, kinds: { vulns: true, codeIntel: false }, targets: [{ keyword: "Full Chain Sentinel" }] },
		],
	});

	// One ordinary run. The send is fire-and-forget, so wait on the robot.
	send({ type: "prompt", text: "notify me when this finishes" });
	await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("NOTIFY_RUN_COMPLETE"),
					),
			),
	);
	await waitUntil(() => dingtalk.length > 0);
	const notice = dingtalk[0];
	expect(notice?.title).toBe("全链哨兵 任务完成");
	// The keyword rides along for a keyword-secured robot, and the signature is added.
	expect(notice?.text.startsWith("Full Chain Sentinel\n")).toBe(true);
	expect(notice?.text).toContain("**状态**：完成");
	expect(notice?.text).toContain(`**项目**：${PROJECT_NAME}`);
	expect(notice?.text).toContain("**耗时**：");
	expect(notice?.text).toContain("NOTIFY_RUN_COMPLETE");
	expect(notice?.url).toContain("timestamp=");
	expect(notice?.url).toContain("sign=");

	// The settings screen learns the outcome.
	const reported = await waitFor((message) => message.type === "notify_config" && message.status.at !== null);
	expect((reported as { status: { ok: boolean; subject?: string } }).status).toMatchObject({
		ok: true,
		subject: "全链哨兵 任务完成",
	});

	// An explicit opt-out wins even while the switch is on.
	dingtalk.length = 0;
	drainIncoming();
	send({ type: "prompt", text: "stay quiet", notify: false });
	await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("QUIET_RUN_COMPLETE"),
					),
			),
	);
	// The POST is fire-and-forget: give it time to land before asserting absence.
	await settleWebhook();
	expect(dingtalk).toHaveLength(0);

	// The composer can override the run-report event filter; the channel stays enabled.
	dingtalk.length = 0;
	drainIncoming();
	send({
		type: "save_notify_config",
		config: {
			groups: [
				{
					id: "team",
					name: "安全团队",
					enabled: true,
					kinds: { runs: false, vulns: false, codeIntel: true, goals: true, engines: true, pocs: true },
					targets: [
						{
							id: "robot",
							name: "钉钉群",
							channel: "dingtalk",
							enabled: true,
							webhook: dingtalkUrl,
							secret: "",
							keyword: "",
						},
					],
				},
			],
			summaryLimit: 2000,
		},
	});
	const filtered = await waitFor(
		(message) => message.type === "notify_config" && !message.config.groups[0]?.kinds.runs,
	);
	expect((filtered as { config: SentinelNotifyConfig }).config.groups[0]?.kinds).toMatchObject({
		vulns: false,
		codeIntel: true,
	});
	const broadcast = structuredClone((filtered as { config: SentinelNotifyConfig }).config);
	const secondGroup = structuredClone(broadcast.groups[0]);
	secondGroup.id = "ops";
	secondGroup.name = "运维团队";
	broadcast.groups.push(secondGroup);
	send({ type: "save_notify_config", config: broadcast });
	await waitFor((message) => message.type === "notify_config" && message.config.groups.length === 2);
	send({ type: "prompt", text: "force a notification", notify: true });
	await waitUntil(() => dingtalk.length === 2);
	expect(dingtalk[0]?.text).toContain("**状态**：完成");
	const delivered = await waitFor(
		(message) => message.type === "notify_config" && message.status.deliveries?.length === 2,
	);
	expect(delivered.type === "notify_config" && delivered.status.deliveries?.map((entry) => entry.groupId)).toEqual([
		"team",
		"ops",
	]);
});

test("the agent's finding lands in the hub as pending, and the operator reviews and exports it", async () => {
	const scenario = VULN_SCENARIOS[0];
	const vuln = await submitViaAgent(scenario.prompt, scenario.done);

	// What the agent submitted is stored verbatim, and it is never the agent's
	// record to approve: it starts as 待确认.
	expect(vuln.status).toBe("pending");
	expect(vuln.label).toBe("E2E-PROJECT-0001");
	expect(vuln.severity).toBe("medium");
	expect(vuln.cvss).toBe(6.5);
	expect(vuln.source).toBe("主代理");
	expect(vuln.packet).toContain("user=admin' AND 1=1--");
	expect(vuln.evidence).toHaveLength(1);
	expect(vuln.evidence[0]?.output).toContain("vulnerable");
	expect(vuln.notes).toHaveLength(1);
	expect(vuln.notes[0]?.author).toBe("agent");
	expect(vuln.severityMismatch).toBe(false);

	// The page's list view is a plain round trip, with the project's counts.
	drainIncoming();
	send({ type: "list_vulns" });
	const listed = await waitFor((message) => message.type === "vulns");
	expect((listed as { items: unknown[] }).items).toHaveLength(1);
	expect((listed as { stats: { total: number; bySeverity: Record<string, number> } }).stats.total).toBe(1);
	expect((listed as { stats: { bySeverity: Record<string, number> } }).stats.bySeverity.medium).toBe(1);

	// Review: a status change, a corrected score, and a note.
	drainIncoming();
	send({ type: "update_vuln", id: vuln.id, patch: { status: "confirmed", cvss: 9.1, note: "已在目标上复现" } });
	const updated = await waitFor((message) => message.type === "vuln" && message.vuln.id === vuln.id);
	const record = (updated as { vuln: SentinelVulnerability }).vuln;
	expect(record.status).toBe("confirmed");
	expect(record.cvss).toBe(9.1);
	// The score now disagrees with the bucket: flagged, not rejected.
	expect(record.severityMismatch).toBe(true);
	expect(record.notes).toHaveLength(2);
	expect(record.notes.at(-1)?.author).toBe("operator");
	expect(record.notes.at(-1)?.statusFrom).toBe("pending");
	expect(record.notes.at(-1)?.statusTo).toBe("confirmed");
	const ack = await waitFor((message) => message.type === "vuln_result" && message.action === "复核");
	expect((ack as { ok: boolean }).ok).toBe(true);

	// Export is generated on the server and carries the reviewed state.
	drainIncoming();
	send({ type: "export_vulns" });
	const exported = await waitFor((message) => message.type === "vulns_export");
	const report = exported as { filename: string; markdown: string };
	expect(report.filename).toMatch(/^E2E-PROJECT-vulnerability-report-\d{12}\.md$/);
	expect(report.markdown).toContain("# 漏洞报告 — e2e-project");
	expect(report.markdown).toContain(vuln.label);
	expect(report.markdown).toContain("已确认");
	expect(report.markdown).toContain("user=admin' AND 1=1--");

	// An unknown id is reported rather than silently succeeding.
	drainIncoming();
	send({ type: "get_vuln", id: "E2E-PROJECT-9999" });
	await waitFor((message) => message.type === "error" && message.message.includes("不存在"));
});

test("a critical finding is pushed to DingTalk the moment it is submitted", async () => {
	// Enable high-severity notifications against the local robot.
	drainIncoming();
	send({
		type: "save_notify_config",
		config: {
			groups: [
				{
					id: "team",
					name: "安全团队",
					enabled: true,
					kinds: { runs: true, vulns: true, codeIntel: true, goals: true, engines: true, pocs: true },
					targets: [
						{
							id: "robot",
							name: "钉钉群",
							channel: "dingtalk",
							enabled: true,
							webhook: dingtalkUrl,
							secret: "SECe2e",
							keyword: "Full Chain Sentinel",
						},
					],
				},
			],
			summaryLimit: 2000,
		},
	});
	await waitFor((message) => message.type === "notify_config" && message.config.groups[0]?.enabled);
	dingtalk.length = 0;

	const scenario = VULN_SCENARIOS[1];
	const vuln = await submitViaAgent(scenario.prompt, scenario.done);
	expect(vuln.severity).toBe("critical");
	expect(vuln.label).toBe("E2E-PROJECT-0002");

	await waitUntil(() => dingtalk.some((entry) => entry.title.includes("严重")));
	const notice = dingtalk.find((entry) => entry.title.includes("严重"));
	expect(notice?.title).toBe("全链哨兵 发现严重漏洞");
	expect(notice?.text).toContain(vuln.label);
	expect(notice?.text).toContain("CVSS 9.8");
	expect(notice?.text).toContain("**原始数据包**");
	expect(notice?.text).toContain("GET /ping?cmd=;id HTTP/1.1");

	// Restore the quiet default for any later run.
	drainIncoming();
	send({
		type: "save_notify_config",
		config: {
			groups: [
				{
					id: "team",
					name: "安全团队",
					enabled: false,
					kinds: { runs: true, vulns: true, codeIntel: true, goals: true, engines: true, pocs: true },
					targets: [
						{
							id: "robot",
							name: "钉钉群",
							channel: "dingtalk",
							enabled: true,
							webhook: dingtalkUrl,
							secret: "",
							keyword: "",
						},
					],
				},
			],
			summaryLimit: 2000,
		},
	});
	await waitFor((message) => message.type === "notify_config" && !message.config.groups[0]?.enabled);
});

test("turning vuln_submit off removes the tool, while reading the hub stays available", async () => {
	drainIncoming();
	send({ type: "get_permissions" });
	const current = await waitFor((message) => message.type === "permissions");
	const config = (current as { config: SentinelPermissionsConfig }).config;
	const relaxed: SentinelPermissionsConfig = {
		main: { ...config.main, vuln_submit: false },
		subagent: { ...config.subagent },
		commander: { ...config.commander },
		subagentMaxTurns: config.subagentMaxTurns,
		plugins: config.plugins,
	};

	drainIncoming();
	send({ type: "save_permissions", config: relaxed });
	await waitFor((message) => message.type === "permissions" && !message.config.main.vuln_submit);

	// A new run asks the model for its tools: the disabled one is not advertised
	// at all, while the read-only pair still is.
	drainIncoming();
	send({ type: "prompt", text: TOOLS_PROBE_PROMPT });
	await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes(TOOLS_PROBE_DONE),
					),
			),
	);
	expect(mainTools).toContain("vuln_list");
	expect(mainTools).toContain("vuln_get");
	expect(mainTools).not.toContain("vuln_submit");

	// The switch only removes the ability to write: the hub is still readable.
	drainIncoming();
	send({ type: "list_vulns" });
	const listed = await waitFor((message) => message.type === "vulns");
	expect((listed as { items: unknown[] }).items).toHaveLength(2);

	// Restore the full set so the remaining tests see the default.
	drainIncoming();
	send({
		type: "save_permissions",
		config: {
			main: { ...config.main },
			subagent: { ...config.subagent },
			commander: { ...config.commander },
			subagentMaxTurns: config.subagentMaxTurns,
			plugins: config.plugins,
		},
	});
	await waitFor((message) => message.type === "permissions" && message.config.main.vuln_submit);
});

test("deleting a project deletes its findings and reports the count first", async () => {
	const cascadeName = "cascade-project";
	drainIncoming();
	send({ type: "add_project", name: cascadeName });
	const created = await waitFor(
		(message) => message.type === "projects" && message.projects.some((project) => project.name === cascadeName),
	);
	const cascade = (created as { projects: Array<{ id: string; name: string; vulnCount?: number }> }).projects.find(
		(project) => project.name === cascadeName,
	);
	expect(cascade?.vulnCount).toBe(0);

	drainIncoming();
	send({ type: "switch_project", id: cascade?.id ?? "" });
	await snapshotWhere((snapshot_) => snapshot_.project?.id === cascade?.id);

	// A finding submitted inside the new project is numbered inside that project.
	const vuln = await submitViaAgent(VULN_SCENARIOS[0].prompt, VULN_SCENARIOS[0].done);
	expect(vuln.label).toBe("CASCADE-PROJECT-0001");
	expect(vuln.projectId).toBe(cascade?.id);

	// The project list carries the count, which is what the delete warning shows.
	drainIncoming();
	send({ type: "list_projects" });
	const withCount = await waitFor((message) => message.type === "projects");
	expect(
		(withCount as { projects: Array<{ name: string; vulnCount?: number }> }).projects.find(
			(project) => project.name === cascadeName,
		)?.vulnCount,
	).toBe(1);

	drainIncoming();
	send({ type: "remove_project", id: cascade?.id ?? "", confirmName: cascadeName, scope: "data" });
	await waitFor(
		(message) => message.type === "projects" && !message.projects.some((project) => project.name === cascadeName),
	);

	// The rows are gone from the hub's database, not merely hidden by the
	// missing project: a finding cannot outlive the scope it was found in.
	const db = new DatabaseSync(join(agentDir, "vulnerabilities.db"));
	try {
		const rows = db
			.prepare("SELECT COUNT(*) AS count FROM vulnerabilities WHERE project_id = ?")
			.get(cascade?.id ?? "") as { count: number };
		expect(Number(rows.count)).toBe(0);
		const notes = db
			.prepare(
				"SELECT COUNT(*) AS count FROM vulnerability_notes WHERE vuln_id NOT IN (SELECT id FROM vulnerabilities)",
			)
			.get() as { count: number };
		expect(Number(notes.count)).toBe(0);
	} finally {
		db.close();
	}

	// The other project's findings survived the deletion.
	drainIncoming();
	send({ type: "switch_project", id: mainProjectId });
	await snapshotWhere((snapshot_) => snapshot_.project?.id === mainProjectId);
	send({ type: "list_vulns" });
	const listed = await waitFor((message) => message.type === "vulns");
	expect((listed as { items: unknown[] }).items).toHaveLength(2);
});

// Last on purpose: it adds a session file to the project's session directory, so
// the sidebar assertions above have to have run already.
test("a compacted session keeps the history its summary replaced", async () => {
	const manager = SessionManager.create(workDir, getDefaultSessionDir(workDir, agentDir));
	const firstId = manager.appendMessage({
		role: "user",
		content: "侦察 10.10.10.5",
		timestamp: Date.now() - 60000,
	});
	const keptId = manager.appendMessage({
		role: "user",
		content: "继续扫描 443",
		timestamp: Date.now(),
	});
	manager.appendCompaction("已侦察 10.10.10.5，开放 22/80", keptId, 42000);
	const sessionPath = manager.getSessionFile();
	expect(sessionPath).toBeTruthy();

	drainIncoming();
	send({ type: "switch_session", path: sessionPath ?? "" });
	const snapshot = await snapshotWhere((snapshot_) =>
		snapshot_.messages.some((message) => (message as { role?: string }).role === "compactionSummary"),
	);

	// The model only sees the summary plus what the compaction kept; the console
	// still shows the instructions the summary replaced, with the marker after
	// them (the file appends the compaction entry when it runs).
	const shown = snapshot.messages.filter((message) => (message as { role?: string }).role !== "system");
	expect(shown.map((message) => (message as { role?: string }).role)).toEqual(["user", "user", "compactionSummary"]);
	expect((shown[0] as { content?: unknown }).content).toBe("侦察 10.10.10.5");
	const marker = shown[2] as { summary?: string; tokensBefore?: number };
	expect(marker.summary).toBe("已侦察 10.10.10.5，开放 22/80");
	expect(marker.tokensBefore).toBe(42000);

	// One fork point per operator message, in the same order: the button under the
	// first instruction forks from that instruction, not from the one after it.
	send({ type: "get_tree" });
	const tree = await waitFor((message) => message.type === "tree");
	const points = (tree as { forkPoints: Array<{ entryId: string; text: string }> }).forkPoints;
	expect(points.map((point) => point.entryId)).toEqual([firstId, keptId]);
	expect(points.map((point) => point.text)).toEqual(["侦察 10.10.10.5", "继续扫描 443"]);
});

/** Goal rows of a snapshot, in transcript order. */
function goalRows(snapshot: SentinelStateSnapshot): unknown[] {
	return snapshot.messages.filter(
		(message) =>
			(message as { role?: string }).role === "custom" &&
			(message as { customType?: string }).customType === "zg-goal",
	);
}

/**
 * A fresh session with no goal, in auto mode. Setting the mode is only awaited
 * when it actually changes: the server broadcasts nothing for a no-op switch, so
 * waiting for one would hang on whatever snapshot happens to come next.
 */
async function freshGoalSession(): Promise<void> {
	drainIncoming();
	send({ type: "new_session" });
	const fresh = await snapshotWhere((snapshot) => snapshot.goal === null && !snapshot.streaming);
	if (fresh.mode === "auto") return;
	send({ type: "set_mode", mode: "auto" });
	await snapshotWhere((snapshot) => snapshot.mode === "auto");
}

/** Switch modes, waiting only when the switch changes something. */
async function setModeAndWait(mode: SentinelMode): Promise<void> {
	drainIncoming();
	send({ type: "get_state" });
	const current = await snapshotWhere(() => true);
	if (current.mode === mode) return;
	send({ type: "set_mode", mode });
	await snapshotWhere((snapshot) => snapshot.mode === mode);
}

test("a persistent goal runs its tools and ends on goal_complete", async () => {
	await freshGoalSession();

	send({
		type: "start_goal",
		objective: GOAL_COMPLETE_PROMPT,
		criteria: ["端口已确认"],
		roundLimit: 2,
	});
	const done = await snapshotWhere(
		(snapshot) => snapshot.goal?.status === "completed" && snapshot.goal.rounds[0]?.outcome === "completed",
	);
	const goal = done.goal;
	expect(goal?.objective).toBe(GOAL_COMPLETE_PROMPT);
	expect(goal?.criteria).toEqual(["端口已确认"]);
	// The completion happens inside the initial run, so it costs no continuation.
	expect(goal?.roundsUsed).toBe(0);
	expect(goal?.roundLimit).toBe(2);
	expect(goal?.rounds).toHaveLength(1);
	expect(goal?.rounds[0].outcome).toBe("completed");
	expect(goal?.rounds[0].toolCalls).toBe(2);
	expect(goal?.rounds[0].summary).toContain("已完成：全端口扫描完成");
	expect(goal?.rounds[0].summaryFromTool).toBe(true);
	expect(goal?.completion?.submitted).toBe(0);
	expect(goal?.completion?.criteria[0]).toEqual({ criterion: "端口已确认", met: true, evidence: "nmap 输出" });
	expect(goal?.usage.total).toBeGreaterThan(0);
	expect(goal?.id.startsWith("goal-")).toBe(true);

	// The contract is a visible row of its own, and no continuation was injected.
	expect(goalRows(done)).toHaveLength(1);
	expect((goalRows(done)[0] as { content?: string }).content).toContain("【持续目标已启动】");
	// The contract precedes the operator's own message, which stays a real user
	// message so the transcript keeps their exact words and its fork point.
	const shown = done.messages.filter((message) => (message as { role?: string }).role !== "system");
	expect(shown.map((message) => (message as { role?: string }).role).slice(0, 2)).toEqual(["custom", "user"]);
	expect(JSON.stringify((shown[1] as { content?: unknown }).content)).toContain(GOAL_COMPLETE_PROMPT);
	const assistant = done.messages
		.filter((message) => (message as { role?: string }).role === "assistant")
		.map((message) => JSON.stringify((message as { content?: unknown }).content))
		.join("");
	expect(assistant).toContain("GOAL_COMPLETE_DONE");

	// The main session mounted the goal tools; sub-agents never do.
	expect(goalTools).toContain("goal_progress");
	expect(goalTools).toContain("goal_complete");
	expect(goalTools).toContain("goal_blocked");
	expect(subagentTools).not.toContain("goal_progress");
});

test("a goal pauses at the round budget, and resuming adds rounds", async () => {
	await freshGoalSession();

	send({ type: "start_goal", objective: GOAL_LIMIT_PROMPT, roundLimit: 1 });
	const paused = await snapshotWhere(
		(snapshot) => snapshot.goal?.status === "paused" && snapshot.goal.rounds.length === 2,
	);
	expect(paused.goal?.pauseReason).toBe("limit");
	expect(paused.goal?.pauseNote).toContain("1 轮");
	expect(paused.goal?.roundsUsed).toBe(1);
	expect(paused.goal?.rounds).toHaveLength(2);
	expect(paused.goal?.rounds.map((round) => round.kind)).toEqual(["initial", "continue"]);
	expect(paused.goal?.rounds.map((round) => round.outcome)).toEqual(["continued", "continued"]);
	// The initial contract plus the one continuation, each a foldable row.
	expect(goalRows(paused)).toHaveLength(2);

	// Resuming adds the requested rounds and immediately starts the next one; the
	// added budget runs out the same way.
	send({ type: "resume_goal", extraRounds: 1 });
	const again = await snapshotWhere(
		(snapshot) =>
			snapshot.goal?.status === "paused" && snapshot.goal.roundLimit === 2 && snapshot.goal.rounds.length === 3,
	);
	expect(again.goal?.roundsUsed).toBe(2);
	expect(again.goal?.rounds).toHaveLength(3);
	expect(goalRows(again)).toHaveLength(3);
});

test("three rounds without a tool call trip the no-progress fuse", async () => {
	await freshGoalSession();

	send({ type: "start_goal", objective: GOAL_NOPROGRESS_PROMPT, roundLimit: 5 });
	const paused = await snapshotWhere(
		(snapshot) => snapshot.goal?.status === "paused" && snapshot.goal.rounds.length === 3,
	);
	expect(paused.goal?.pauseReason).toBe("no-progress");
	expect(paused.goal?.noProgressStreak).toBe(3);
	expect(paused.goal?.roundsUsed).toBe(2);
	expect(paused.goal?.rounds).toHaveLength(3);
	expect(paused.goal?.rounds.every((round) => round.toolCalls === 0)).toBe(true);

	// Clearing removes the bar and the stored state.
	drainIncoming();
	send({ type: "clear_goal" });
	const cleared = await snapshotWhere((snapshot) => snapshot.goal === null);
	expect(goalRows(cleared)).toHaveLength(3);
});

test("a loop-guard stutter abort costs no round and only pauses after repeated trips", async () => {
	await freshGoalSession();

	send({ type: "start_goal", objective: GOAL_STUTTER_PROMPT, roundLimit: 5 });
	const paused = await snapshotWhere((snapshot) => snapshot.goal?.status === "paused");
	// Every run of this scenario stutters, nudges included, so the trips come one
	// after another and the goal stands down on the third.
	expect(paused.goal?.pauseReason).toBe("loop-guard");
	expect(paused.goal?.pauseNote).toContain("3 次");
	// The stuttered attempt was refunded: the operator's budget is untouched.
	expect(paused.goal?.roundsUsed).toBe(0);
	expect(paused.goal?.rounds).toHaveLength(1);
	expect(paused.goal?.rounds[0].outcome).toBe("aborted");
	// The guard's notices are in the transcript where the operator can see them.
	// Two are certain by the third trip; the third nudge may land after the pause.
	const notices = paused.messages.filter((message) =>
		JSON.stringify((message as { content?: unknown }).content).includes("【输出重复】"),
	);
	expect(notices.length).toBeGreaterThanOrEqual(2);
	// The guard's last (exhausted) run may still be in flight; let it settle so the
	// next test takes a quiet fake endpoint.
	await snapshotWhere((snapshot) => !snapshot.streaming);
}, 120000);

test("a goal cannot start in review mode, and leaving auto mode pauses it", async () => {
	await freshGoalSession();
	await setModeAndWait("review");

	send({ type: "start_goal", objective: GOAL_LIMIT_PROMPT, roundLimit: 1 });
	await waitFor((message) => message.type === "error" && message.message.includes("只在自动执行或 AI 审批模式下可用"));

	// In auto mode it starts; switching back to review pauses it with a reason.
	await setModeAndWait("auto");
	send({ type: "start_goal", objective: GOAL_NOPROGRESS_PROMPT, roundLimit: 5 });
	await snapshotWhere((snapshot) => snapshot.goal?.status === "active");
	send({ type: "set_mode", mode: "review" });
	const paused = await snapshotWhere((snapshot) => snapshot.goal?.status === "paused");
	expect(paused.goal?.pauseReason).toBe("manual");
	expect(paused.goal?.pauseNote).toContain("审批模式");

	// The round in flight still ends, but it does not start another one.
	const settled = await snapshotWhere(
		(snapshot) =>
			!snapshot.streaming &&
			snapshot.goal?.status === "paused" &&
			snapshot.goal.rounds.some((round) => round.endedAt !== undefined),
	);
	expect(settled.goal?.status).toBe("paused");
});

test("a compaction that stalls is visible, refuses prompts in Chinese, and can be cancelled", async () => {
	await freshGoalSession();
	// Fill the context past the keep-recent threshold: pi refuses to summarize a
	// session with nothing to summarize, and the stall is what this test is about.
	const fillTurns = (snapshot: SentinelStateSnapshot): number =>
		snapshot.messages.filter((message) =>
			JSON.stringify((message as { content?: unknown }).content ?? "").includes(COMPACT_FILL_DONE),
		).length;
	for (let turn = 1; turn <= 3; turn += 1) {
		send({ type: "prompt", text: COMPACT_FILL_PROMPT });
		await snapshotWhere((snapshot) => !snapshot.streaming && fillTurns(snapshot) >= turn);
	}
	const requestsBefore = compactionRequests;

	stallCompaction = true;
	send({ type: "compact" });
	const busy = await snapshotWhere((snapshot) => snapshot.compacting);
	// The console knows when it started, so the operator sees how long it has been.
	expect(busy.compactionStartedAt).toBeGreaterThan(0);
	// The summary request is the thing that is stuck; wait for it to be issued.
	await waitUntil(() => compactionRequests > requestsBefore);

	// A prompt during the compaction is refused with a Chinese reason, not pi's
	// English "Cannot submit a prompt while compaction is in progress".
	send({ type: "prompt", text: "should be refused while compacting" });
	const refused = await waitFor((message) => message.type === "error");
	expect((refused as { message: string }).message).toContain("正在压缩上下文");
	expect((refused as { message: string }).message).not.toContain("Cannot submit a prompt");

	// The operator gives up on it: the wait ends and the session takes prompts
	// again. The endpoint stops stalling first, so a summarization pi retries
	// after the cancel is answered instead of holding the test open.
	stallCompaction = false;
	send({ type: "abort_compaction" });
	await snapshotWhere((snapshot) => !snapshot.compacting && snapshot.compactionStartedAt === null);

	// The session takes prompts again. This deliberately oversized transcript can
	// make pi start its own threshold compaction right after a run, so a refused
	// prompt is retried instead of failing the test: what is being proven is that
	// the cancel left the session usable, not that pi never compacts on its own.
	const answered = async (): Promise<boolean> => {
		const outcome = await Promise.race([
			snapshotWhere(
				(snapshot) =>
					!snapshot.compacting &&
					snapshot.messages.some((message) =>
						JSON.stringify((message as { content?: unknown }).content ?? "").includes("NOTIFY_RUN_COMPLETE"),
					),
				15000,
			)
				.then(() => true)
				.catch(() => false),
			waitFor((message) => message.type === "error", 15000)
				.then(() => false)
				.catch(() => true),
		]);
		return outcome;
	};
	let accepted = false;
	for (let attempt = 0; attempt < 3 && !accepted; attempt += 1) {
		send({ type: "prompt", text: "notify me when this finishes" });
		accepted = await answered();
		if (!accepted) await snapshotWhere((snapshot) => !snapshot.compacting, 15000).catch(() => undefined);
	}
	expect(accepted).toBe(true);
});

/**
 * Gatekeeper (AI 审批) end to end.
 *
 * The judge is the same fake endpoint, recognized by its system prompt, so a
 * test can steer the verdict per command. Every scenario below runs exactly one
 * bash command through the real gate: allow, block, and fail-open.
 */

/**
 * `waitFor`, but registered at the front of the waiter queue.
 *
 * `dispatch` hands a message to the first matching waiter, and a broad waiter
 * left pending by an earlier test — the compaction test races two of them and
 * the loser lives until its timeout — would swallow the message this test is
 * waiting for. Registering first makes this test's own predicate win.
 */
function waitForFirst(
	predicate: (message: SentinelServerMessage) => boolean,
	timeoutMs = 30000,
): Promise<SentinelServerMessage> {
	const queued = waitFor(predicate, timeoutMs);
	const own = waiters[waiters.length - 1];
	if (own && own.predicate === predicate) {
		waiters.pop();
		waiters.unshift(own);
	}
	return queued;
}

/** `snapshotWhere`, registered at the front of the queue for the same reason. */
function snapshotWhereFirst(
	predicate: (snapshot: SentinelStateSnapshot) => boolean,
	timeoutMs = 30000,
): Promise<SentinelStateSnapshot> {
	return waitForFirst((message) => message.type === "snapshot" && predicate(message.snapshot), timeoutMs).then(
		(message) => (message as { snapshot: SentinelStateSnapshot }).snapshot,
	);
}

/** The first audit page matching a filter, so a test can assert what was stored. */
async function auditPage(filter: SentinelGateFilter): Promise<SentinelGatePage> {
	drainIncoming();
	send({ type: "gate_audit_query", filter, page: 1, pageSize: 50 });
	const message = await waitForFirst((candidate) => candidate.type === "gate_audit");
	if (message.type !== "gate_audit") throw new Error("no gate audit page");
	return message.page;
}

test("a judge model is added to the library, assigned to the role, and resolves", async () => {
	drainIncoming();
	send({
		type: "save_model_entry",
		name: "守门模型",
		baseUrl: `http://127.0.0.1:${endpointPort}/v1`,
		apiKey: "judge-key",
		modelId: "zg-judge-model",
	});
	const added = await waitForFirst((message) => message.type === "model_library").then(
		(message) => (message as { library: SentinelModelLibraryView }).library,
	);
	const entry = added.entries.find((candidate) => candidate.modelId === "zg-judge-model");
	expect(entry).toBeDefined();
	// The key is stored but never sent back.
	expect(entry?.hasKey).toBe(true);
	expect(JSON.stringify(added)).not.toContain("judge-key");

	drainIncoming();
	send({ type: "set_model_role", role: "judge", target: entry?.id ?? "" });
	const assigned = await waitForFirst((message) => message.type === "model_library").then(
		(message) => (message as { library: SentinelModelLibraryView }).library,
	);
	expect(assigned.roles.judge).toBe(entry?.id);
	expect(assigned.resolved.judge?.modelId).toBe("zg-judge-model");
	expect(assigned.resolved.judge?.followedMain).toBe(false);

	// The gatekeeper settings reply no longer carries the endpoint; the library does.
	drainIncoming();
	send({ type: "get_gatekeeper_config" });
	const view = await waitForFirst((message) => message.type === "gatekeeper_config");
	if (view.type !== "gatekeeper_config") throw new Error("no gatekeeper config reply");
	expect(view.config.mode).toBe("review");
	expect(view.config.timeoutMs).toBeGreaterThan(0);
});

test("changing 主模型 takes effect on the next send, without rebuilding the session", async () => {
	send({ type: "get_state" });
	const before = await snapshotWhereFirst((snapshot) => snapshot.activeSessionId !== null);
	const sessionId = before.activeSessionId;

	drainIncoming();
	send({
		type: "save_model_entry",
		name: "备用主模型",
		baseUrl: `http://127.0.0.1:${endpointPort}/v1`,
		apiKey: "test-key",
		modelId: "sentinel-fake-model-2",
	});
	const added = await waitForFirst((message) => message.type === "model_library").then(
		(message) => (message as { library: SentinelModelLibraryView }).library,
	);
	const spare = added.entries.find((entry) => entry.modelId === "sentinel-fake-model-2");
	expect(spare).toBeDefined();

	drainIncoming();
	send({ type: "set_model_role", role: "main", target: spare?.id ?? "" });
	await waitForFirst((message) => message.type === "model_library" && message.library.roles.main === spare?.id);

	// The session keeps running on the old model until the operator sends again.
	expect((await snapshotWhereFirst((snapshot) => snapshot.activeSessionId === sessionId)).model?.id).toBe(
		"sentinel-fake-model",
	);

	drainIncoming();
	send({ type: "prompt", text: "check the main model switch" });
	const settled = await snapshotWhereFirst(
		(snapshot) => !snapshot.streaming && JSON.stringify(snapshot.messages).includes("MAIN_MODEL_SWITCH_OK"),
	);
	// Same session, new provider: nothing was torn down and rebuilt.
	expect(settled.activeSessionId).toBe(sessionId);
	expect(settled.model?.provider).toBe(spare?.id);
	expect(settled.model?.id).toBe("sentinel-fake-model-2");
	expect(lastRequestBody).toContain("sentinel-fake-model-2");

	// Put 主模型 back so the rest of the suite runs on its original endpoint.
	drainIncoming();
	send({ type: "set_model_role", role: "main", target: mainEntryId });
	await waitForFirst((message) => message.type === "model_library" && message.library.roles.main === mainEntryId);
});

test("ai mode judges a command, lets it run, and records the allow", async () => {
	await setModeAndWait("ai");
	send({ type: "get_state" });
	const switched = await snapshotWhereFirst((snapshot) => snapshot.mode === "ai");
	expect(switched.gatekeeper.sessionOverride).toBe("ai");
	expect(switched.gatekeeper.judgeResolved?.modelId).toBe("zg-judge-model");

	judgeBehavior = { kind: "allow" };
	judgedCommands.length = 0;
	drainIncoming();
	send({ type: "prompt", text: GATE_ALLOW_PROMPT });
	const settled = await snapshotWhereFirst(
		(snapshot) => !snapshot.streaming && toolResultText(snapshot).includes(GATE_ALLOWED_OUTPUT),
	);
	// One command, one judgment: the command ran because the judge said ALLOW.
	expect(judgedCommands).toHaveLength(1);
	expect(judgedCommands[0]).toContain(GATE_ALLOWED_COMMAND);

	const page = await auditPage({ decision: "allow" });
	const record = page.items.find((item) => item.command.includes(GATE_ALLOWED_COMMAND));
	expect(record).toBeDefined();
	expect(record?.decision).toBe("allow");
	expect(record?.source).toBe("主代理");
	// 来源 names the library entry that judged, not a fixed slot.
	expect(record?.modelFrom).toBe("守门模型");
	expect(record?.totalTokens).toBe(324);
	expect(record?.projectId).toBe(mainProjectId);
	expect(record?.sessionId).toBe(settled.activeSessionId);
	// Judge tokens are the audit page's own column, never the session's usage.
	expect(settled.gatekeeper.failures).toBe(0);
});

test("a blocked command never runs, the reason reaches the model, and the block is recorded", async () => {
	judgeBehavior = { kind: "block", reason: GATE_BLOCK_REASON };
	judgedCommands.length = 0;
	drainIncoming();
	send({ type: "prompt", text: GATE_BLOCK_PROMPT });
	const settled = await snapshotWhereFirst(
		(snapshot) => !snapshot.streaming && toolResultText(snapshot).includes(GATE_BLOCK_REASON),
	);
	// The model is told why, and the command it wanted did not execute.
	const results = toolResultText(settled);
	expect(results).toContain("命令未执行");
	expect(results).not.toContain(GATE_BLOCKED_OUTPUT);
	expect(judgedCommands.some((command) => command.includes(GATE_BLOCKED_COMMAND))).toBe(true);

	const page = await auditPage({ decision: "block" });
	const record = page.items.find((item) => item.command.includes(GATE_BLOCKED_COMMAND));
	expect(record?.reason).toBe(GATE_BLOCK_REASON);
	// A block is a successful judgment, so it must not look like the judge is down.
	expect(record?.latencyMs).toBeGreaterThanOrEqual(0);
	expect(settled.gatekeeper.lastSuccessAt ?? 0).toBeGreaterThan(settled.gatekeeper.lastFailureAt ?? 0);
});

test("a judge failure is allowed through, recorded as 请求失败, and surfaces as fail-open", async () => {
	judgeBehavior = { kind: "error" };
	judgedCommands.length = 0;
	drainIncoming();
	send({ type: "prompt", text: GATE_FAIL_PROMPT });
	const settled = await snapshotWhereFirst(
		(snapshot) => !snapshot.streaming && toolResultText(snapshot).includes(GATE_FAILED_OUTPUT),
	);
	// Fail-open: the command ran even though no verdict came back.
	expect(settled.gatekeeper.failures).toBeGreaterThan(0);
	expect(settled.gatekeeper.lastError).toContain("500");
	// Newer failure than success is what raises the console's yellow banner.
	expect(settled.gatekeeper.lastFailureAt ?? 0).toBeGreaterThan(settled.gatekeeper.lastSuccessAt ?? 0);

	const page = await auditPage({ decision: "failed" });
	const record = page.items.find((item) => item.command.includes(GATE_FAILED_COMMAND));
	expect(record?.decision).toBe("failed");
	// A failure keeps the endpoint's own words; `reason` is the block slot.
	expect(record?.error).toContain("500");

	drainIncoming();
	send({ type: "gate_audit_stats", filter: { decision: "failed" } });
	const stats = await waitForFirst((message) => message.type === "gate_audit_stats");
	if (stats.type !== "gate_audit_stats") throw new Error("no gate stats");
	expect(stats.stats.byDecision.failed).toBeGreaterThan(0);
	expect(stats.stats.failures).toBeGreaterThan(0);
	expect(stats.stats.lastFailureAt).not.toBeNull();
});

test("ai mode ignores the prefix allow-list: a whitelisted prefix is still judged", async () => {
	// In review mode this prefix skips the approval queue entirely.
	await setModeAndWait("review");
	drainIncoming();
	send({ type: "allow_prefix", prefix: "echo" });
	await snapshotWhereFirst((snapshot) => snapshot.allowedPrefixes.includes("echo"));

	await setModeAndWait("ai");
	judgeBehavior = { kind: "allow" };
	judgedCommands.length = 0;
	drainIncoming();
	send({ type: "prompt", text: GATE_PREFIX_PROMPT });
	await snapshotWhereFirst(
		(snapshot) => !snapshot.streaming && toolResultText(snapshot).includes(GATE_PREFIXED_OUTPUT),
	);
	expect(judgedCommands.some((command) => command.includes(GATE_PREFIXED_COMMAND))).toBe(true);

	drainIncoming();
	send({ type: "remove_allowed_prefix", prefix: "echo" });
	await snapshotWhereFirst((snapshot) => !snapshot.allowedPrefixes.includes("echo"));
});

test("a persistent goal can start in AI 审批 mode", async () => {
	// A goal used to require 自动执行 because nothing else could run unattended.
	// The judge is that gate now, so the precondition accepts both.
	await setModeAndWait("ai");
	drainIncoming();
	send({ type: "start_goal", objective: GOAL_LIMIT_PROMPT, roundLimit: 1 });
	const active = await snapshotWhereFirst((snapshot) => snapshot.goal?.status === "active");
	expect(active.goal?.objective).toBe(GOAL_LIMIT_PROMPT);

	// Stop it again: this test is about the precondition, not about the loop. The
	// reason is not asserted because the round budget may trip first.
	drainIncoming();
	send({ type: "pause_goal" });
	await snapshotWhereFirst((snapshot) => snapshot.goal?.status === "paused");
	drainIncoming();
	send({ type: "clear_goal" });
	await snapshotWhereFirst((snapshot) => snapshot.goal === null);
});

test("the mode is a per-session override over a console-wide default", async () => {
	drainIncoming();
	send({ type: "set_global_mode", mode: "auto" });
	await snapshotWhereFirst((snapshot) => snapshot.gatekeeper.globalMode === "auto");

	// A session with no choice of its own follows the default.
	drainIncoming();
	send({ type: "new_session" });
	const fresh = await snapshotWhereFirst(
		(snapshot) => !snapshot.streaming && snapshot.gatekeeper.sessionOverride === null,
	);
	expect(fresh.mode).toBe("auto");

	// An override belongs to the session it was set on...
	drainIncoming();
	send({ type: "set_mode", mode: "ai" });
	await snapshotWhereFirst((snapshot) => snapshot.gatekeeper.sessionOverride === "ai");
	// ...and changing the default does not disturb it.
	drainIncoming();
	send({ type: "set_global_mode", mode: "review" });
	const kept = await snapshotWhereFirst((snapshot) => snapshot.gatekeeper.globalMode === "review");
	expect(kept.mode).toBe("ai");
	expect(kept.gatekeeper.sessionOverride).toBe("ai");

	// Clearing the choice returns the session to the default.
	drainIncoming();
	send({ type: "set_mode", mode: null });
	const cleared = await snapshotWhereFirst((snapshot) => snapshot.gatekeeper.sessionOverride === null);
	expect(cleared.mode).toBe("review");
});

test("a session's own mode is a session entry, so rebuilding the session keeps it", async () => {
	drainIncoming();
	send({ type: "new_session" });
	const opened = await snapshotWhereFirst(
		(snapshot) => !snapshot.streaming && snapshot.gatekeeper.sessionOverride === null,
	);
	const sessionId = opened.activeSessionId;
	expect(sessionId).not.toBeNull();

	drainIncoming();
	send({ type: "set_mode", mode: "ai" });
	await snapshotWhereFirst((snapshot) => snapshot.gatekeeper.sessionOverride === "ai");

	// Re-reading the session from its own file is the path a console restart takes:
	// the mode choice must come back with it.
	drainIncoming();
	send({ type: "get_state" });
	const rebuilt = await snapshotWhereFirst(
		(snapshot) => snapshot.activeSessionId === sessionId && snapshot.mode === "ai",
		30000,
	);
	expect(rebuilt.gatekeeper.sessionOverride).toBe("ai");
});

test("switching to AI 审批 is refused while no judge endpoint resolves", async () => {
	// Follow 主模型, then remove the main entry itself: only when nothing is left
	// does the console refuse, which is the state a fresh install is in.
	setLibraryRole(agentDir, "judge", "follow-main");
	const stored = readStoredModelLibrary(agentDir);
	const mainId = stored?.roles.main?.id;
	expect(mainId).toBeDefined();
	// The library file is written by the settings screen; delete the provider so the
	// role has nothing to resolve, exactly like a hand-emptied models.json.
	const modelsPath = modelsJsonPath(agentDir);
	const parsed = JSON.parse(readFileSync(modelsPath, "utf-8")) as { providers: Record<string, unknown> };
	if (mainId) delete parsed.providers[mainId];
	writeFileSync(modelsPath, `${JSON.stringify(parsed, null, "\t")}\n`);

	drainIncoming();
	send({ type: "get_model_library" });
	const view = await waitForFirst((message) => message.type === "model_library").then(
		(message) => (message as { library: SentinelModelLibraryView }).library,
	);
	expect(view.resolved.judge).toBeNull();

	// The session is still on its own AI override from the previous test; clear it
	// first, otherwise the switch below is a no-op that answers nothing.
	drainIncoming();
	send({ type: "set_mode", mode: null });
	await snapshotWhereFirst((snapshot) => snapshot.gatekeeper.sessionOverride === null);

	drainIncoming();
	send({ type: "set_mode", mode: "ai" });
	const refused = await waitForFirst((message) => message.type === "error");
	expect((refused as { message: string }).message).toContain("未配置守门模型");

	drainIncoming();
	send({ type: "set_global_mode", mode: "ai" });
	const refusedGlobal = await waitForFirst((message) => message.type === "error");
	expect((refusedGlobal as { message: string }).message).toContain("未配置守门模型");
});

// --- 预设 Agent -----------------------------------------------------------
//
// The preset feature has two halves and both are driven end to end here: a
// console session created with a preset, and an engineering run whose commander
// picks a preset for a task and has an out-of-whitelist pick refused. The point
// of the first half is the wire assertion: the marker is read out of the request
// body the fake endpoint received, so the text provably reached the model
// instead of only reaching the console's own snapshot.

/** Current permissions, echoed back: the path that rebuilds every live session. */
async function rebuildSessions(): Promise<void> {
	drainIncoming();
	send({ type: "get_permissions" });
	const current = await waitForFirst((message) => message.type === "permissions");
	const config = (current as { config: SentinelPermissionsConfig }).config;
	drainIncoming();
	send({ type: "save_permissions", config });
	await waitForFirst((message) => message.type === "permissions");
}

/**
 * The addendum section of the session's system prompt, as the model receives it.
 *
 * A session writes the prompt once and then appends a patch system message whenever a
 * section changes, so the current value is the sections of every system message merged
 * in order — the same replay `getCurrentSystemMessage` performs for the request.
 */
function addendumOf(snapshot: SentinelStateSnapshot): string {
	const merged: Record<string, string | null> = {};
	for (const message of snapshot.messages) {
		if ((message as { role?: string }).role !== "system") continue;
		for (const [name, value] of Object.entries(
			(message as { sections?: Record<string, string | null> }).sections ?? {},
		)) {
			if (value === null) delete merged[name];
			else merged[name] = value;
		}
	}
	return merged.addendum ?? "";
}

test("a preset is stored, injected into a new session, and re-read on every rebuild", async () => {
	drainIncoming();
	send({
		type: "save_preset",
		input: {
			name: PRESET_NAME,
			description: PRESET_DESCRIPTION,
			tags: PRESET_TAGS,
			placeholder: PRESET_PLACEHOLDER,
			text: `你是 Web 侦察专家：先指纹，再目录，最后参数。\n${PRESET_BODY_MARKER}`,
		},
	});
	const saved = (await waitForFirst((message) => message.type === "preset_saved")) as {
		preset: SentinelPresetView | null;
		error?: string;
	};
	expect(saved.error).toBeUndefined();
	const presetId = saved.preset?.id ?? "";
	expect(presetId).not.toBe("");
	expect(saved.preset?.name).toBe(PRESET_NAME);
	expect(saved.preset?.description).toBe(PRESET_DESCRIPTION);
	expect(saved.preset?.tags).toEqual(PRESET_TAGS);
	expect(saved.preset?.placeholder).toBe(PRESET_PLACEHOLDER);
	expect(saved.preset?.enabled).toBe(true);
	expect(saved.preset?.tokens).toBeGreaterThan(0);

	// The settings screen reads the list, body included.
	drainIncoming();
	send({ type: "list_presets" });
	const listed = (await waitForFirst((message) => message.type === "presets")) as { presets: SentinelPresetView[] };
	const view = listed.presets.find((item) => item.id === presetId);
	expect(view?.text).toContain(PRESET_BODY_MARKER);
	expect(view?.textMissing).toBe(false);

	// A session created with it runs as that preset, and the choice is recorded.
	drainIncoming();
	send({ type: "new_session", presetId });
	const opened = await snapshotWhereFirst((snapshot) => !snapshot.streaming && snapshot.preset?.id === presetId);
	const sessionId = opened.activeSessionId;
	expect(sessionId).not.toBeNull();
	expect(opened.preset?.name).toBe(PRESET_NAME);
	expect(opened.preset?.missing).toBe(false);
	// The composer's grey line comes from the session's preset, so the snapshot has
	// to carry the hint the operator wrote, not only the name.
	expect(opened.preset?.placeholder).toBe(PRESET_PLACEHOLDER);

	// One turn, so pi writes the system prompt. The preset text must be in the
	// console's view of it AND in the request the model actually received.
	drainIncoming();
	send({ type: "prompt", text: PRESET_SESSION_PROMPT });
	const settled = await snapshotWhereFirst(
		(snapshot) =>
			!snapshot.streaming &&
			snapshot.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes(PRESET_SESSION_DONE),
					),
			),
	);
	expect(addendumOf(settled)).toContain(PRESET_BODY_MARKER);
	expect(lastRequestBody).toContain(PRESET_BODY_MARKER);

	// Rebuilding every live session is the path a console restart takes: the choice
	// is a session entry, so the conversation comes back as the same preset.
	await rebuildSessions();
	const rebuilt = await snapshotWhereFirst(
		(snapshot) => snapshot.activeSessionId === sessionId && snapshot.preset?.id === presetId,
	);
	expect(rebuilt.preset?.name).toBe(PRESET_NAME);
	expect(rebuilt.preset?.placeholder).toBe(PRESET_PLACEHOLDER);
	expect(addendumOf(rebuilt)).toContain(PRESET_BODY_MARKER);

	// Editing the body changes what the next build injects: the text is read from
	// disk per build, never copied into the session file. If pi merely replayed the
	// stored prompt, the old marker would survive this and the new one would not.
	drainIncoming();
	send({
		type: "save_preset",
		input: {
			id: presetId,
			name: PRESET_NAME,
			description: PRESET_DESCRIPTION,
			tags: PRESET_TAGS,
			placeholder: PRESET_PLACEHOLDER_EDITED,
			text: `你是 Web 侦察专家：先指纹，再目录，最后参数。\n${PRESET_EDITED_MARKER}`,
		},
	});
	await waitForFirst((message) => message.type === "preset_saved");
	// A save pushes a fresh snapshot, so an open chat page gets the new hint without
	// waiting for the next rebuild.
	await snapshotWhereFirst(
		(snapshot) =>
			snapshot.activeSessionId === sessionId && snapshot.preset?.placeholder === PRESET_PLACEHOLDER_EDITED,
	);
	await rebuildSessions();
	const afterEdit = await snapshotWhereFirst(
		(snapshot) => snapshot.activeSessionId === sessionId && snapshot.preset?.id === presetId,
	);
	expect(afterEdit.preset?.placeholder).toBe(PRESET_PLACEHOLDER_EDITED);

	drainIncoming();
	send({ type: "prompt", text: PRESET_SESSION_SECOND_PROMPT });
	const second = await snapshotWhereFirst(
		(snapshot) =>
			!snapshot.streaming &&
			snapshot.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes(PRESET_SESSION_SECOND_DONE),
					),
			),
	);
	// The wire is the truth here. A section that changes after the first turn is
	// projected onto the request as a patch rather than written back into the
	// conversation's first system message, so the console's snapshot still replays
	// the text the session was built with while the model gets the current one.
	// Asserting on the request body is therefore the only honest check for the edit.
	expect(second.activeSessionId).toBe(sessionId);
	expect(lastRequestBody).toContain(PRESET_EDITED_MARKER);
	expect(lastRequestBody).not.toContain(PRESET_BODY_MARKER);
}, 90000);

test("deleting a preset returns its sessions to the default agent and says so", async () => {
	drainIncoming();
	send({ type: "list_presets" });
	const listed = (await waitForFirst((message) => message.type === "presets")) as { presets: SentinelPresetView[] };
	const presetId = listed.presets.find((item) => item.name === PRESET_NAME)?.id ?? "";
	expect(presetId).not.toBe("");

	drainIncoming();
	send({ type: "delete_preset", id: presetId });
	const deleted = (await waitForFirst((message) => message.type === "preset_deleted")) as { ok: boolean };
	expect(deleted.ok).toBe(true);

	// The session keeps the record of which preset it used, and the console marks it
	// as missing rather than pretending the context is still loaded.
	await rebuildSessions();
	const rebuilt = await snapshotWhereFirst((snapshot) => snapshot.preset?.id === presetId);
	expect(rebuilt.preset?.missing).toBe(true);
	expect(rebuilt.preset?.name).toBe(presetId);
	// The hint belongs to the preset, so the composer falls back to its default line.
	expect(rebuilt.preset?.placeholder).toBe("");

	// Naming it in a new session is refused outright; silently starting the default
	// agent would look like the preset had been applied.
	drainIncoming();
	send({ type: "new_session", presetId });
	const refused = (await waitForFirst((message) => message.type === "error")) as { message: string };
	expect(refused.message).toContain("预设");
}, 90000);

test("switching a live session's preset re-briefs the turns that follow", async () => {
	// The composer's 预设 Agent switch. Three turns of one conversation: under A,
	// then after switching to B, then after switching back to the default agent.
	// Only the request body can prove which briefing was in force, because a
	// section changed after the first turn reaches the model as a patch.
	const answeredBy = (done: string) => (snapshot: SentinelStateSnapshot) =>
		!snapshot.streaming &&
		snapshot.messages.some(
			(message) =>
				(message as { role?: string }).role === "assistant" &&
				((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
					block.text?.includes(done),
				),
		);

	// Two presets of its own, so the scenario does not depend on what the tests
	// around it created, edited or deleted.
	drainIncoming();
	send({
		type: "save_preset",
		input: {
			name: PRESET_SWITCH_NAME_A,
			description: "切换前的身份",
			tags: ["切换"],
			text: `你是切换前的身份。\n${PRESET_SWITCH_MARKER_A}`,
		},
	});
	const savedA = (await waitForFirst((message) => message.type === "preset_saved")) as {
		preset: SentinelPresetView | null;
	};
	const presetA = savedA.preset?.id ?? "";
	expect(presetA).not.toBe("");

	drainIncoming();
	send({
		type: "save_preset",
		input: {
			name: PRESET_SWITCH_NAME_B,
			description: "切换后的身份",
			tags: ["切换"],
			text: `你是切换后的身份。\n${PRESET_SWITCH_MARKER_B}`,
		},
	});
	const savedB = (await waitForFirst((message) => message.type === "preset_saved")) as {
		preset: SentinelPresetView | null;
	};
	const presetB = savedB.preset?.id ?? "";
	expect(presetB).not.toBe("");
	expect(presetB).not.toBe(presetA);

	// A conversation that starts under A, with one turn to pin A's briefing.
	drainIncoming();
	send({ type: "new_session", presetId: presetA });
	const opened = await snapshotWhereFirst((snapshot) => !snapshot.streaming && snapshot.preset?.id === presetA);
	const sessionId = opened.activeSessionId;
	expect(sessionId).not.toBeNull();

	drainIncoming();
	send({ type: "prompt", text: PRESET_SWITCH_PROMPT });
	await snapshotWhereFirst(answeredBy(PRESET_SWITCH_DONE));
	expect(lastRequestBody).toContain(PRESET_SWITCH_MARKER_A);
	expect(lastRequestBody).not.toContain(PRESET_SWITCH_MARKER_B);

	// Switching rebuilds the same conversation rather than starting a new one: the
	// choice is appended to the session file, so the session id comes back.
	drainIncoming();
	send({ type: "set_session_preset", presetId: presetB });
	const switched = await snapshotWhereFirst((snapshot) => !snapshot.streaming && snapshot.preset?.id === presetB);
	expect(switched.activeSessionId).toBe(sessionId);
	expect(switched.preset?.name).toBe(PRESET_SWITCH_NAME_B);
	expect(switched.preset?.missing).toBe(false);

	drainIncoming();
	send({ type: "prompt", text: PRESET_SWITCH_SECOND_PROMPT });
	await snapshotWhereFirst(answeredBy(PRESET_SWITCH_SECOND_DONE));
	expect(lastRequestBody).toContain(PRESET_SWITCH_MARKER_B);
	expect(lastRequestBody).not.toContain(PRESET_SWITCH_MARKER_A);

	// And back to the plain default agent: neither briefing survives.
	drainIncoming();
	send({ type: "set_session_preset", presetId: null });
	const cleared = await snapshotWhereFirst((snapshot) => !snapshot.streaming && snapshot.preset === null);
	expect(cleared.activeSessionId).toBe(sessionId);

	drainIncoming();
	send({ type: "prompt", text: PRESET_SWITCH_THIRD_PROMPT });
	await snapshotWhereFirst(answeredBy(PRESET_SWITCH_THIRD_DONE));
	expect(lastRequestBody).not.toContain(PRESET_SWITCH_MARKER_A);
	expect(lastRequestBody).not.toContain(PRESET_SWITCH_MARKER_B);

	// "No preset" is a session entry too, so it is what a console restart replays.
	await rebuildSessions();
	const rebuilt = await snapshotWhereFirst((snapshot) => snapshot.activeSessionId === sessionId);
	expect(rebuilt.preset).toBeNull();
}, 90000);

test("a sub-agent inherits the preset of the session that spawned it", async () => {
	// Same restore as the engine test below: earlier tests wreck the model library
	// on purpose, and this scenario really does call the endpoint. It goes through
	// the settings screen rather than writeTestModel because a sub-agent resolves
	// its model through the console's cached runtime: a direct library write leaves
	// that runtime on a stale entry, and the spawn is then refused with "no model"
	// before the sub-agent ever reaches the endpoint.
	drainIncoming();
	send({ type: "get_model_library" });
	const library = await waitForFirst((message) => message.type === "model_library").then(
		(message) => (message as { library: SentinelModelLibraryView }).library,
	);
	const mainId =
		library.roles.main ??
		writeTestModel(agentDir, {
			baseUrl: `http://127.0.0.1:${endpointPort}/v1`,
			apiKey: "test-key",
			modelId: "sentinel-fake-model",
		});
	send({
		type: "save_model_entry",
		id: mainId,
		name: "主端点",
		baseUrl: `http://127.0.0.1:${endpointPort}/v1`,
		apiKey: "test-key",
		modelId: "sentinel-fake-model",
	});
	const restored = await snapshotWhereFirst((snapshot) => snapshot.modelConfigured === true);
	expect(restored.model?.id).toBe("sentinel-fake-model");
	expect(presetSubagentBody).toBe("");
	// No project switch here on purpose: the test before this one already ran a
	// session in the active project, and re-entering the project it is already in
	// only races itself — the switch answers late and re-points the active session
	// at the fresh, preset-less one it created, so the prompt would land there.

	drainIncoming();
	send({
		type: "save_preset",
		input: {
			name: PRESET_SUBAGENT_NAME,
			description: "子代理也要读同一份上下文",
			tags: ["继承"],
			text: `你是 Web 侦察专家。\n${PRESET_SUBAGENT_MARKER}`,
		},
	});
	const saved = (await waitForFirst((message) => message.type === "preset_saved")) as {
		preset: SentinelPresetView | null;
	};
	const presetId = saved.preset?.id ?? "";
	expect(presetId).not.toBe("");

	drainIncoming();
	send({ type: "new_session", presetId });
	const opened = await snapshotWhereFirst((snapshot) => !snapshot.streaming && snapshot.preset?.id === presetId);
	expect(opened.preset?.missing).toBe(false);

	// One turn: the parent delegates, the child answers with its own text.
	drainIncoming();
	send({ type: "prompt", text: PRESET_SUBAGENT_PROMPT });
	await snapshotWhereFirst(
		(snapshot) =>
			!snapshot.streaming &&
			snapshot.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes(PRESET_SUBAGENT_PARENT_DONE),
					),
			),
	);

	// The sub-agent runs in a session of its own, so its system prompt is the only
	// place the preset can come from. The order matters too: the sub-agent identity
	// comes first, the preset text after it, which is the same shape a worker's
	// prompt takes.
	expect(presetSubagentBody).toContain(SUBAGENT_MARKER);
	expect(presetSubagentBody).toContain(PRESET_SUBAGENT_MARKER);
	expect(presetSubagentBody.indexOf(SUBAGENT_MARKER)).toBeLessThan(presetSubagentBody.indexOf(PRESET_SUBAGENT_MARKER));
}, 120000);

test("the commander dispatches with a whitelisted preset and has an outsider refused", async () => {
	// This test runs last, after the ones that wreck the model library on purpose
	// (the 守门模型 refusal test deletes the main provider from models.json), so put a
	// working endpoint back: the commander falls back to 主模型 and the workers use it.
	writeTestModel(agentDir, {
		baseUrl: `http://127.0.0.1:${endpointPort}/v1`,
		apiKey: "test-key",
		modelId: "sentinel-fake-model",
	});
	// The engine runs in the project every other test uses; an earlier test may have
	// left the console inside a project it then deleted, and switching back to the
	// project it is already in is a no-op that answers nothing, so ask for state.
	drainIncoming();
	send({ type: "switch_project", id: mainProjectId });
	send({ type: "get_state" });
	await snapshotWhereFirst((snapshot) => snapshot.project?.id === mainProjectId);

	drainIncoming();
	send({
		type: "save_preset",
		input: {
			name: ENGINE_PRESET_NAME,
			description: ENGINE_PRESET_DESCRIPTION,
			tags: ["域", "内网"],
			text: `你是域内账户枚举专家。\n${ENGINE_PRESET_MARKER}`,
		},
	});
	const saved = (await waitForFirst((message) => message.type === "preset_saved")) as {
		preset: SentinelPresetView | null;
	};
	enginePresetId = saved.preset?.id ?? "";
	expect(enginePresetId).not.toBe("");

	drainIncoming();
	send({
		type: "engine_create",
		input: {
			name: "预设工程 e2e",
			targets: "10.0.0.7\n10.0.0.8",
			doctrines: ["standard"],
			presetIds: [enginePresetId],
			limits: { concurrency: 1, roundLimit: 3, tokenLimit: null, timeLimitMin: null, maxRetries: 1 },
			gateMode: "auto",
		},
	});
	const completed = (await waitForFirst(
		(message) =>
			message.type === "engine_update" &&
			message.engine.status === "completed" &&
			(message.engine.report ?? "").includes(ENGINE_REPORT_MARKER),
		90000,
	)) as { engine: SentinelEngine };
	const engine = completed.engine;

	// The whitelist round-trips through the store and back to the console.
	expect(engine.presetIds).toEqual([enginePresetId]);
	// Exactly one task: the refused dispatch left no row behind, so the board never
	// shows a preset name the worker did not run as.
	expect(engine.tasks).toHaveLength(1);
	const task = engine.tasks[0];
	expect(task?.status).toBe("done");
	expect(task?.presetId).toBe(enginePresetId);
	expect(task?.presetName).toBe(ENGINE_PRESET_NAME);
	expect(task?.summary).toContain(ENGINE_WORKER_SUMMARY);

	// The commander's brief listed the preset with the id it had to use, and never
	// mentioned the outsider it was refused.
	expect(commanderBodies.some((body) => body.includes(`- ${enginePresetId} · ${ENGINE_PRESET_NAME}`))).toBe(true);

	// The task session really ran as that preset: opening it from the task board puts
	// the preset badge on the conversation and its own system prompt carries the text
	// behind the worker identity.
	drainIncoming();
	send({ type: "engine_open_task_session", taskId: task?.id ?? "" });
	const opened = await snapshotWhereFirst((snapshot) => snapshot.preset?.id === enginePresetId, 30000);
	expect(opened.preset?.name).toBe(ENGINE_PRESET_NAME);
	expect(opened.preset?.missing).toBe(false);
	const addendum = addendumOf(opened);
	expect(addendum).toContain(ENGINE_PRESET_MARKER);
	expect(addendum).toContain("Work autonomously inside the assigned working directory");

	// Whether a task may run without a preset is a per-engine switch, and the
	// console learns about a flip from the broadcast.
	drainIncoming();
	send({ type: "engine_set_preset_optional", id: engine.id, optional: false });
	const required = (await waitForFirst(
		(message) => message.type === "engine_update" && message.engine.presetOptional === false,
	)) as { engine: SentinelEngine };
	expect(required.engine.id).toBe(engine.id);
	// Back to the default: presets stay optional unless the operator says otherwise.
	send({ type: "engine_set_preset_optional", id: engine.id, optional: true });
	const restored = (await waitForFirst(
		(message) => message.type === "engine_update" && message.engine.presetOptional === true,
	)) as { engine: SentinelEngine };
	expect(restored.engine.id).toBe(engine.id);
}, 120000);

test("supervision is armed per conversation before the first message, audited, and stopped explicitly", async () => {
	drainIncoming();
	send({ type: "get_state" });
	const before = (await waitForFirst((message) => message.type === "snapshot")) as {
		snapshot: SentinelStateSnapshot;
	};
	send({ type: "new_session" });
	const fresh = await snapshotWhere((snapshot) => snapshot.activeSessionId !== before.snapshot.activeSessionId);
	// No 监督 click, no supervisor state at all.
	expect(fresh.supervisor).toBeNull();
	expect(fresh.supervisorConfig.enabled).toBe(true);

	const customStrategy = {
		id: "custom-e2e",
		name: "E2E 支付专用",
		base: "validation" as const,
		description: "先看越权",
		instructions: "优先验证 IDOR，不做目录爆破",
		createdAt: 1,
		updatedAt: 1,
	};
	send({
		type: "save_supervisor_config",
		config: {
			...fresh.supervisorConfig,
			customStrategies: [customStrategy],
			defaultCustomStrategyId: "custom-e2e",
		},
	});
	await waitFor(
		(message) =>
			message.type === "supervisor_config" &&
			message.config.customStrategies.some((entry) => entry.id === "custom-e2e"),
	);

	send({
		type: "supervisor_arm",
		mode: "observe",
		delivery: "confirm",
		strategy: "validation",
		customStrategyId: "custom-e2e",
		note: "只验证已有漏洞",
	});
	const waitingMessage = (await waitFor(
		(message) => message.type === "supervisor_state" && message.supervisor?.status === "waiting",
	)) as { supervisor: SentinelSupervisorView };
	const waiting = waitingMessage.supervisor;
	expect(waiting.mode).toBe("observe");
	expect(waiting.strategy).toBe("validation");
	expect(waiting.strategyName).toBe("E2E 支付专用");
	expect(waiting.strategyInstructions).toContain("IDOR");
	expect(waiting.strategyNote).toBe("只验证已有漏洞");
	expect(waiting.callCount).toBe(0);
	const sessionId = waiting.sessionId;
	expect(sessionId).not.toBe("");

	// The global audit has the row even before the first prompt.
	send({ type: "supervisor_audit", page: 1 });
	const audit = (await waitFor((message) => message.type === "supervisor_audit")) as {
		page: SentinelSupervisorAuditPage;
	};
	expect(
		audit.page.items.some(
			(item) => item.sessionId === sessionId && item.status === "waiting" && item.strategy === "validation",
		),
	).toBe(true);
	expect(audit.page.stats.total).toBeGreaterThanOrEqual(1);
	expect(audit.page.stats.pendingAdvice).toBe(0);

	send({ type: "supervisor_audit", page: 1, customStrategyId: "custom-e2e" });
	const customAudit = (await waitFor(
		(message) =>
			message.type === "supervisor_audit" && message.page.items.some((item) => item.sessionId === sessionId),
	)) as { page: SentinelSupervisorAuditPage };
	expect(customAudit.page.total).toBe(1);
	expect(customAudit.page.items[0]?.strategyName).toBe("E2E 支付专用");

	// Mode and delivery are per conversation, not a global setting.
	send({ type: "supervisor_set_mode", mode: "intervene", delivery: "auto" });
	const intervenedMessage = (await waitFor(
		(message) =>
			message.type === "supervisor_state" &&
			message.supervisor?.mode === "intervene" &&
			message.supervisor.delivery === "auto",
	)) as { supervisor: SentinelSupervisorView };
	expect(intervenedMessage.supervisor.status).toBe("waiting");

	send({ type: "supervisor_set_strategy", strategy: "offensive", note: "优先看横向" });
	const strategyMessage = (await waitFor(
		(message) =>
			message.type === "supervisor_state" &&
			message.supervisor?.strategy === "offensive" &&
			message.supervisor.strategyNote === "优先看横向",
	)) as { supervisor: SentinelSupervisorView };
	expect(strategyMessage.supervisor.strategy).toBe("offensive");

	send({ type: "supervisor_audit", page: 1, strategy: "offensive" });
	const offensiveAudit = (await waitFor(
		(message) =>
			message.type === "supervisor_audit" &&
			message.page.items.some((item) => item.sessionId === sessionId && item.strategy === "offensive"),
	)) as { page: SentinelSupervisorAuditPage };
	expect(offensiveAudit.page.total).toBe(1);

	send({ type: "supervisor_detail", sessionId });
	const detail = (await waitFor((message) => message.type === "supervisor_detail")) as {
		detail: SentinelSupervisorDetail;
	};
	expect(detail.detail.session.sessionId).toBe(sessionId);
	expect(detail.detail.session.mode).toBe("intervene");

	// Config lives in 设置 → 模型 and reaches the snapshot.
	const config = { ...fresh.supervisorConfig, batchToolCalls: 30 };
	send({ type: "save_supervisor_config", config });
	const configured = await snapshotWhere((snapshot) => snapshot.supervisorConfig.batchToolCalls === 30);
	expect(configured.supervisorConfig.enabled).toBe(true);

	send({ type: "supervisor_stop" });
	const stoppedMessage = (await waitFor(
		(message) => message.type === "supervisor_state" && message.supervisor?.status === "stopped",
	)) as { supervisor: SentinelSupervisorView };
	expect(stoppedMessage.supervisor.endedAt).not.toBeNull();

	// A stopped conversation cannot be re-armed; a new conversation is required.
	send({
		type: "supervisor_arm",
		mode: "observe",
		delivery: "confirm",
		strategy: "validation",
		note: "只验证已有漏洞",
	});
	const refused = await waitFor((message) => message.type === "error" && message.message.includes("停止"));
	expect(refused.type).toBe("error");
}, 30000);
