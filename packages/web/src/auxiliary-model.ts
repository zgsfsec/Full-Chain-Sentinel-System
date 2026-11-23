/** Single-turn model calls shared by the gatekeeper, reviewer, supervisor and monitor. */
import { readFileSync } from "node:fs";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { t } from "./i18n.ts";
import { modelsJsonPath } from "./model-config.ts";
import { resolveLibraryRole } from "./model-library.ts";
import type { SentinelModelConfig, SentinelModelRoleName } from "./protocol.ts";

export interface AuxiliaryModelConfig extends SentinelModelConfig {
	agentDir: string;
	providerId: string;
}

export interface AuxiliaryModelReply {
	content: string;
	reasoning: string;
	finishReason: string;
	rawFinishReason: string;
	usage: { input: number; output: number; total: number };
}

interface CompletionOptions {
	systemPrompt: string;
	input: string;
	signal: AbortSignal;
	maxTokens?: number;
	json?: boolean;
	/** Ignore the model library's default effort for latency-sensitive classifiers. */
	disableReasoning?: boolean;
	fetch?: typeof fetch;
}

// Each configuration generation owns its runtime. Updating a model must not
// mutate the runtime of a request already in flight, or retain an old API key.
const runtimes = new Map<string, { source: string; runtime: Promise<ModelRuntime> }>();

export function resolveAuxiliaryModel(agentDir: string, role: SentinelModelRoleName): AuxiliaryModelConfig | null {
	const resolved = resolveLibraryRole(agentDir, role);
	return resolved ? { ...resolved.config, agentDir, providerId: resolved.entryId } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep JSON mode where the protocol provides it; prompts and verdict validators remain authoritative. */
function jsonPayload(payload: unknown, model: Model<Api>): unknown {
	if (!isRecord(payload)) return undefined;
	switch (model.api) {
		case "openai-completions":
			return { ...payload, response_format: { type: "json_object" } };
		case "openai-responses":
		case "azure-openai-responses":
			return {
				...payload,
				text: { ...(isRecord(payload.text) ? payload.text : {}), format: { type: "json_object" } },
			};
		case "google-generative-ai":
		case "google-vertex":
			return {
				...payload,
				config: { ...(isRecord(payload.config) ? payload.config : {}), responseMimeType: "application/json" },
			};
		default:
			return undefined;
	}
}

export async function completeAuxiliaryModel(
	config: AuxiliaryModelConfig,
	options: CompletionOptions,
): Promise<AuxiliaryModelReply> {
	const { signal } = options;
	signal.throwIfAborted();
	// Race the entire operation, including runtime initialization, with the
	// caller's deadline. The same signal also cancels the provider request.
	let onAbort: () => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([
			aborted,
			(async () => {
				const path = modelsJsonPath(config.agentDir);
				const source = readFileSync(path, "utf-8");
				let cached = runtimes.get(config.agentDir);
				if (!cached || cached.source !== source) {
					const runtime = ModelRuntime.create({ authPath: `${config.agentDir}/auth.json`, modelsPath: path });
					cached = { source, runtime };
					runtimes.set(config.agentDir, cached);
					const generation = cached;
					void runtime.catch(() => {
						if (runtimes.get(config.agentDir) === generation) runtimes.delete(config.agentDir);
					});
				}
				const runtime = await cached.runtime;
				signal.throwIfAborted();
				const model = runtime.getModel(config.providerId, config.modelId);
				if (!model) throw new Error(t("模型不存在：{model}", { model: config.modelId }));
				const thinking = options.disableReasoning ? undefined : config.capabilities?.defaultThinkingLevel;
				const request: SimpleStreamOptions = {
					signal,
					temperature: 0,
					maxRetries: 0,
					transport: "sse",
					maxTokens: Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens),
					...(thinking && thinking !== "off" ? { reasoning: thinking } : {}),
					...(options.json ? { onPayload: jsonPayload } : {}),
					...(options.fetch ? { fetch: options.fetch } : {}),
				};
				const reply = await runtime.completeSimple(
					model,
					{
						messages: [
							{ role: "system", content: options.systemPrompt, timestamp: Date.now() },
							{ role: "user", content: options.input, timestamp: Date.now() },
						],
					},
					request,
				);
				signal.throwIfAborted();
				if (reply.stopReason === "error" || reply.stopReason === "aborted") {
					const message = reply.errorMessage || t("模型调用失败：{reason}", { reason: reply.stopReason });
					throw new Error(
						`${message} (finish_reason=${reply.rawStopReason ?? reply.stopReason}, completion_tokens=${reply.usage.output})`,
					);
				}
				return {
					content: reply.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join(""),
					reasoning: reply.content
						.filter((part) => part.type === "thinking")
						.map((part) => part.thinking)
						.join(""),
					finishReason: reply.stopReason,
					rawFinishReason: reply.rawStopReason ?? reply.stopReason,
					usage: {
						// SDK input excludes cache reads/writes; the console counts all prompt tokens.
						input: reply.usage.input + reply.usage.cacheRead + reply.usage.cacheWrite,
						output: reply.usage.output,
						total: reply.usage.totalTokens,
					},
				};
			})(),
		]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
