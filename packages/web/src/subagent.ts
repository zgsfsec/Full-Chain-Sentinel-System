/**
 * The spawn_agent tool: lets the main agent delegate a self-contained task to
 * an isolated sub-agent session with its own transcript and turn budget.
 *
 * Sub-agents receive permission-filtered coding tools, hub tools, optional
 * search tools and extensions. Console-only modeling, device and report tools
 * are not passed. They never receive spawn_agent, so delegation cannot recurse.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	createAgentSession,
	type createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type DefaultResourceLoader,
	defineTool,
	type ModelRuntime,
	SessionManager,
	type SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { t } from "./i18n.ts";
import { excludeToolsFor, type SentinelPermissionSet } from "./permissions.ts";
import type { SubagentRegistry } from "./subagents.ts";

/** Turn budget before a sub-agent is aborted. */
const DEFAULT_MAX_TURNS = 15;

const SUBAGENT_APPEND_PROMPT = [
	"You are running as a sub-agent of Full Chain Sentinel. You were spawned to complete one delegated task.",
	"Work autonomously, keep output focused on the task, and finish with a concise result summary the parent agent can use directly.",
	"Do not ask the operator questions; state assumptions instead.",
];

export interface SubagentToolOptions {
	cwd: string;
	agentDir: string;
	/** Resolves the model the sub-agent should use (same endpoint as the parent). */
	getModel: () => Model<any> | undefined;
	getModelRuntime: () => ModelRuntime | undefined;
	/** Builds a bash tool wired to the shared approval gate. */
	createGatedBash: () => ReturnType<typeof createBashTool>;
	/** Builds the resource loader and settings the main session uses, so the
	 * sub-agent loads the same extensions and activates the same tools. The
	 * extra system prompt is appended on top of the loaded one. */
	createSessionContext: (appendSystemPrompt: string[]) => Promise<{
		resourceLoader: DefaultResourceLoader;
		settingsManager: SettingsManager;
	}>;
	/** Records the run so the console can show its process and control it. */
	registry: SubagentRegistry;
	/**
	 * Builds this sub-agent's vulnerability-hub tools. The source label is resolved
	 * per call, because the run id only exists once the run has been registered.
	 */
	createVulnTools: (getSource: () => string) => ToolDefinition[];
	/**
	 * Builds this sub-agent's asset-inventory tools, with the same per-run source
	 * label. Optional so older call sites and tests keep working; the console
	 * always passes it.
	 */
	createAssetTools?: (getSource: () => string) => ToolDefinition[];
	/**
	 * Extra read-only tools the sub-agent may mount in addition to the hub
	 * tools (e.g. the POC library), already reduced to its own permissions.
	 */
	extraTools?: ToolDefinition[];
	/** Session the spawn_agent call belongs to; scopes the run list. */
	getParentSessionId: () => string | undefined;
	/** Project the run belongs to, for the retained record. */
	getProjectId: () => string | undefined;
	/** What this sub-agent is allowed to mount; always a subset of the parent. */
	permissions: SentinelPermissionSet;
	maxTurns?: number;
}

const subagentSchema = Type.Object({
	task: Type.String({
		minLength: 1,
		description: "The self-contained task for the sub-agent, including any target scope it needs.",
	}),
});

export function createSubagentTool(options: SubagentToolOptions): ToolDefinition<typeof subagentSchema> {
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

	return defineTool({
		name: "spawn_agent",
		label: "Sub-agent",
		description:
			"Spawn an isolated sub-agent to complete one delegated task and return its result. Use for parallelizable or self-contained work such as reconnaissance of a single host, log triage, or researching one question. It receives only its permission-filtered coding, project-record, POC, MITM, configured search and extension tools; it does not receive this session's business-modeling, mobile-device, capture or report-screenshot tools, and cannot delegate further. Commands follow this session's approval mode.",
		promptSnippet:
			"Delegate a self-contained task (e.g. recon of one host) to an isolated sub-agent and get its result",
		promptGuidelines: [
			"Prefer spawn_agent for independent per-target work (e.g. recon several hosts in parallel) instead of doing everything in this conversation",
			"Give each sub-agent a complete, self-contained task with explicit target scope; it cannot ask you questions and cannot delegate further",
			"Keep work that requires console-only business models, mobile devices, capture or report screenshots in the parent session; a sub-agent does not inherit those tools or the parent's conversation",
		],
		parameters: subagentSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, onUpdate) {
			const model = options.getModel();
			const modelRuntime = options.getModelRuntime();
			if (!model || !modelRuntime) {
				return {
					content: [{ type: "text", text: "No model configured for sub-agents. Configure the endpoint first." }],
					details: { error: "no-model" as const },
					isError: true,
				};
			}

			const log: string[] = [t("子代理启动：{task}", { task: params.task.slice(0, 120) })];
			const pushLog = (line: string): void => {
				log.push(line);
				onUpdate?.({ content: [{ type: "text", text: log.join("\n") }], details: undefined });
			};

			// Same resource loading as the main session, so the sub-agent sees the
			// same extension-contributed tools. Only the custom tool set differs:
			// spawn_agent is not passed, which is what stops delegation from recursing.
			// The permission set was already reduced to the parent's, so a sub-agent
			// can never hold a tool the main agent does not have.
			const permissions = options.permissions;
			const { resourceLoader, settingsManager } = await options.createSessionContext(SUBAGENT_APPEND_PROMPT);

			// `baseToolsOverride` replaces the whole base set, so the coding tools
			// must be listed explicitly alongside the gated bash. Disabled tools are
			// also denied, so nothing can bring them back.
			const baseToolsOverride = {
				...(permissions.read
					? {
							read: createReadTool(options.cwd),
							grep: createGrepTool(options.cwd),
							find: createFindTool(options.cwd),
							ls: createLsTool(options.cwd),
						}
					: {}),
				...(permissions.bash ? { bash: options.createGatedBash() } : {}),
				...(permissions.edit ? { edit: createEditTool(options.cwd) } : {}),
				...(permissions.write ? { write: createWriteTool(options.cwd) } : {}),
			};
			// The hub tools label their records with the run id, which is assigned
			// after the session exists; the closure reads it when a tool executes.
			const runRef: { id?: string } = {};
			const sourceLabel = () => `子代理 ${runRef.id ?? "unknown"}`;
			const vulnTools = options.createVulnTools(sourceLabel);
			const assetTools = options.createAssetTools?.(sourceLabel) ?? [];
			const created = await createAgentSession({
				cwd: options.cwd,
				agentDir: options.agentDir,
				modelRuntime,
				model,
				settingsManager,
				resourceLoader,
				sessionManager: SessionManager.inMemory(options.cwd),
				baseToolsOverride,
				customTools: [...vulnTools, ...assetTools, ...(options.extraTools ?? [])],
				excludeTools: excludeToolsFor(permissions),
			});
			const session = created.session;
			// Emits session_start, which connects MCP servers and lets extensions
			// contribute their tools.
			await session.bindExtensions({});
			const handle = options.registry.beginRun({
				sessionId: options.getParentSessionId() ?? "unknown",
				projectId: options.getProjectId(),
				task: params.task,
				session,
			});
			runRef.id = handle.id;
			handle.push({ kind: "status", status: "running", note: t("子代理启动") });

			let turns = 0;
			let aborted = false;
			// When each tool call started, so its `tool_end` can report how long the
			// step took; the process view is read to find the slow step.
			const toolStartedAt = new Map<string, number>();
			const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
				if (event.type === "message_end") {
					// Assistant messages carry the sub-agent's own text and reasoning;
					// user and tool-result messages would only duplicate the transcript.
					if ((event.message as { role?: string }).role !== "assistant") return;
					for (const block of messageBlocks(event.message)) {
						if (block.type === "text" && block.text?.trim()) handle.push({ kind: "text", text: block.text });
						else if (block.type === "thinking" && block.thinking?.trim())
							handle.push({ kind: "thinking", text: block.thinking });
					}
				} else if (event.type === "tool_execution_start") {
					toolStartedAt.set(event.toolCallId, Date.now());
					handle.push({
						kind: "tool_start",
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						args: event.args,
					});
					pushLog(t("执行 {tool} …", { tool: event.toolName }));
				} else if (event.type === "tool_execution_end") {
					const startedAt = toolStartedAt.get(event.toolCallId);
					toolStartedAt.delete(event.toolCallId);
					handle.push({
						kind: "tool_end",
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						isError: event.isError,
						output: toolResultText(event.result),
						durationMs: startedAt === undefined ? undefined : Date.now() - startedAt,
					});
				} else if (event.type === "turn_end") {
					turns += 1;
					handle.push({ kind: "turn", text: t("第 {turn} 轮", { turn: turns }) });
					const text = textHead(event.message);
					if (text) pushLog(t("第 {turn} 轮：{text}", { turn: turns, text: text.slice(0, 160) }));
					if (turns >= maxTurns) {
						aborted = true;
						pushLog(t("已达轮次上限（{limit}），中止子代理。", { limit: maxTurns }));
						handle.push({
							kind: "status",
							status: "running",
							note: t("已达轮次上限（{limit}），中止子代理", { limit: maxTurns }),
						});
						void session.abort();
					}
				}
			});

			const onAbort = () => {
				aborted = true;
				void session.abort();
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			let failure: string | undefined;
			let status: "done" | "error" | "aborted" = "done";
			try {
				await session.prompt(params.task, undefined);
			} catch (error) {
				// A failed sub-agent is reported to the parent as a result, not a throw,
				// so the parent can continue with its other work.
				status = "error";
				failure = error instanceof Error ? error.message : String(error);
			} finally {
				signal?.removeEventListener("abort", onAbort);
				unsubscribe();
			}

			const resultText = session.getLastAssistantText() ?? "";
			if (status === "done" && aborted) status = "aborted";
			handle.finish({ status, result: resultText, error: failure });
			session.dispose();

			const outcome =
				status === "error"
					? t("（子代理失败：{error}）", { error: String(failure) })
					: status === "aborted" && !resultText
						? t("（子代理被中止，未产出结果）")
						: resultText;
			return {
				content: [{ type: "text", text: outcome || t("（子代理结束但没有输出文本）") }],
				details: { runId: handle.id, turns, log },
				...(status === "done" ? {} : { isError: true }),
			};
		},
	});
}

interface MessageBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

function messageBlocks(message: unknown): MessageBlock[] {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) ? (content as MessageBlock[]) : [];
}

/** Text of a tool result, which reaches the event as a content-block list. */
function toolResultText(result: unknown): string {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return "";
	return (content as MessageBlock[])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function textHead(message: unknown): string {
	return messageBlocks(message)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join(" ");
}
