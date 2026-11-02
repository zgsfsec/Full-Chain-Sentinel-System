/**
 * The agent-facing web-search tools: `web_search` and `web_extract`.
 *
 * Tavily is a general web search engine, so these tools answer "what is
 * publicly written about this target" — breach mentions, exposed repos,技术
 * 资料 — which the asset-mapping platforms cannot. Both tools go through the
 * console: the key pool lives in the runtime, the model only sees results, and
 * every call is metered against the session budget and logged.
 *
 * Which tools exist is decided before the session is built: with the permission
 * switch off, or no usable key in the pool, nothing is mounted at all.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { extractWeb, searchWeb, TavilyError, type WebExtractResult, type WebSearchResult } from "./websearch.ts";

/** Longest tool output handed back to the model. */
const MAX_TOOL_OUTPUT = 12_000;
/** Longest one extracted page may be in the tool answer. */
const MAX_PAGE_CHARS = 4_000;

export const WEBSEARCH_TOOL_NAMES: readonly string[] = ["web_search", "web_extract"];

/** One finished call, as the runtime logs it. */
export interface WebSearchQueryReport {
	kind: "search" | "extract";
	query: string;
	ok: boolean;
	latencyMs: number;
	count: number;
	error?: string;
	/** Which pool key served the call, for the audit trail. */
	keyId?: string;
	evidencePath?: string;
	/** Normalized payload for the query log. */
	records: unknown[];
}

export interface WebSearchToolContext {
	/**
	 * Pick a pool key, excluding the ids the caller says are spent. A string
	 * return is the failure reason (no usable key left).
	 */
	pickKey: (exclude: string[]) => Promise<{ id: string; label: string; key: string } | string>;
	/** Queries left in this session, or null when unlimited. */
	remaining: () => number | null;
	/** Account for one query. False means the session's budget is spent. */
	consume: () => boolean;
	/** Persist the raw response; returns the path to cite, or undefined. */
	saveEvidence: (name: string, raw: unknown) => string | undefined;
	/** Log the call and refresh the key's status line. */
	report: (report: WebSearchQueryReport) => void;
}

export interface WebSearchToolDetails {
	ok: boolean;
	kind: "search" | "extract";
	query: string;
	count: number;
	evidencePath?: string;
	remaining?: number | null;
	error?: string;
}

function clip(text: string, max = MAX_TOOL_OUTPUT): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…（输出已截断，共 ${text.length} 字符）`;
}

function isQuotaError(error: unknown): boolean {
	return error instanceof TavilyError && error.retryable;
}

/** A file name that sorts by time and names the kind. */
function evidenceName(kind: string, now = new Date()): string {
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	return `tavily-${kind}-${stamp}.json`;
}

/**
 * Write one raw response under `<workDir>/evidence/search/` and return the
 * work-directory-relative path — the same convention as the asset tools, so one
 * string works for both the read tool (host) and bash (container /work).
 */
export function writeWebSearchEvidence(workDir: string, name: string, raw: unknown): string | undefined {
	const relative = join("evidence", "search", name);
	try {
		mkdirSync(join(workDir, "evidence", "search"), { recursive: true });
		writeFileSync(join(workDir, relative), `${JSON.stringify(raw, null, "\t")}\n`, "utf8");
		return relative;
	} catch {
		return undefined;
	}
}

function renderSearch(result: WebSearchResult, evidencePath: string | undefined, remaining: number | null): string {
	const head = `Web 搜索「${result.query}」：${result.results.length} 条结果，耗时 ${result.latencyMs}ms（Key: ${result.keyId}）`;
	const body =
		result.results.length > 0
			? result.results
					.map((hit, index) => {
						const lines = [
							`${index + 1}. ${hit.title || "(无标题)"} · score ${hit.score.toFixed(3)}`,
							`   ${hit.url}`,
						];
						if (hit.publishedDate) lines.push(`   发布: ${hit.publishedDate}`);
						if (hit.content) lines.push(`   ${clip(hit.content, 500).replace(/\n+/g, " ")}`);
						return lines.join("\n");
					})
					.join("\n")
			: "（没有结果）";
	const notes: string[] = [];
	if (result.results.length === 0) notes.push("没有命中：换更具体的关键词、去掉 site 限定或用英文重试。");
	if (result.answer) notes.push(`Tavily 摘要：${result.answer}`);
	if (evidencePath) notes.push(`原始响应已写入：${evidencePath}`);
	if (remaining !== null) notes.push(`本会话剩余查询次数：${remaining}`);
	return [clip(`${head}\n${body}`), ...notes].join("\n\n");
}

function renderExtract(result: WebExtractResult, evidencePath: string | undefined, remaining: number | null): string {
	const head = `抓取 ${result.urls.length} 个页面：成功 ${result.pages.length}，失败 ${result.failed.length}，耗时 ${result.latencyMs}ms（Key: ${result.keyId}）`;
	const body =
		result.pages.length > 0
			? result.pages.map((page) => `=== ${page.url} ===\n${clip(page.content, MAX_PAGE_CHARS)}`).join("\n\n")
			: "（没有抓到任何页面正文）";
	const notes: string[] = [];
	for (const failure of result.failed) notes.push(`失败：${failure.url} — ${failure.error}`);
	if (result.pages.length === 0) notes.push("全部失败：确认 URL 可公网访问，或改用 extract_depth=advanced。");
	if (evidencePath) notes.push(`原始响应已写入：${evidencePath}`);
	if (remaining !== null) notes.push(`本会话剩余查询次数：${remaining}`);
	return [clip(`${head}\n${body}`), ...notes].join("\n\n");
}

function budgetDenied(_context: WebSearchToolContext): AgentToolResult<WebSearchToolDetails> {
	return {
		content: [
			{
				type: "text",
				text: "本会话的 Web 搜索预算已用完。请让操作员在「设置 - Web 搜索」里调高上限或新开会话。",
			},
		],
		details: { ok: false, kind: "search", query: "", count: 0, remaining: 0 },
		isError: true,
	};
}

/** One pool key as the tools see it. */
interface PickedKey {
	id: string;
	label: string;
	key: string;
}

/** Run `task` against pool keys, rotating to the next one on quota errors. */
async function withKeyRotation<T>(
	context: WebSearchToolContext,
	task: (picked: PickedKey) => Promise<T>,
): Promise<{ value: T; picked: PickedKey } | { error: string }> {
	const spent: string[] = [];
	let lastError = "";
	for (let attempt = 0; attempt < 5; attempt++) {
		const picked = await context.pickKey(spent);
		if (typeof picked === "string") {
			return { error: lastError ? `${lastError}；${picked}` : picked };
		}
		try {
			return { value: await task(picked), picked };
		} catch (error) {
			if (!isQuotaError(error)) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
			// This key's credits (or the plan cap) ran out: mark it and try the next.
			lastError = error instanceof Error ? error.message : String(error);
			spent.push(picked.id);
		}
	}
	return { error: lastError || "号池中的 Key 全部额度耗尽" };
}

const searchTool = (context: WebSearchToolContext): ToolDefinition =>
	defineTool({
		name: "web_search",
		label: "Search the web (Tavily)",
		description:
			"General web search through the operator's Tavily account. Use it for reconnaissance beyond asset platforms: breach mentions, leaked documents, tech-writeups about the target, employees on public pages. The console sends the request, so API keys stay on the host and out of the container. Multiple keys rotate automatically by remaining quota. Every call is metered against the session budget, logged, and the raw response is written into the project's evidence directory.",
		promptSnippet: "Search the public web (Tavily) for target intelligence",
		promptGuidelines: [
			"Use web_search proactively when the task needs public target intelligence or current product/CVE/vendor documentation that local evidence does not supply; do not wait for the user to ask for a search. Keep queries within the task scope, omit secrets and private request data, and respect the session query budget",
			"Prefer specific queries: add the domain, product name or unique strings instead of generic terms",
			"include_domains/exclude_domains accept bare domains (example.com), one per array entry",
			"topic=news with days=1-30 finds recent reporting; default general ignores recency",
			"Follow up interesting hits with web_extract to read the full page",
		],
		parameters: Type.Object({
			query: Type.String({ description: "搜索关键词，支持与 Google 类似的自然语句；中英文均可" }),
			max_results: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 20, description: "返回条数，默认 5，最多 20" }),
			),
			search_depth: Type.Optional(
				Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
					description: "basic 快而省额度；advanced 更全（消耗更多额度），默认 basic",
				}),
			),
			topic: Type.Optional(
				Type.Union([Type.Literal("general"), Type.Literal("news")], {
					description: "general 常规；news 限定新闻，配合 days",
				}),
			),
			days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365, description: "仅 topic=news：限定最近 N 天" })),
			include_domains: Type.Optional(
				Type.Array(Type.String(), { description: '只搜索这些域名，如 ["example.com"]' }),
			),
			exclude_domains: Type.Optional(Type.Array(Type.String(), { description: "排除这些域名" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<WebSearchToolDetails>> {
			const query = params.query.trim();
			if (!query) {
				return {
					content: [{ type: "text", text: "query 不能为空" }],
					details: { ok: false, kind: "search", query: "", count: 0 },
					isError: true,
				};
			}
			if (!context.consume()) return budgetDenied(context);
			const outcome = await withKeyRotation(context, async (picked) => {
				const result = await searchWeb({
					key: picked.key,
					keyId: picked.label,
					query,
					maxResults: params.max_results,
					depth: params.search_depth,
					topic: params.topic,
					days: params.days,
					includeDomains: params.include_domains,
					excludeDomains: params.exclude_domains,
				});
				return { result, picked };
			});
			if ("error" in outcome) {
				const message = outcome.error;
				context.report({ kind: "search", query, ok: false, latencyMs: 0, count: 0, error: message, records: [] });
				return {
					content: [
						{
							type: "text",
							text: `Web 搜索失败：${message}\n请让操作员在「设置 - Web 搜索」里检查 Key 额度与状态。`,
						},
					],
					details: { ok: false, kind: "search", query, count: 0, error: message, remaining: context.remaining() },
					isError: true,
				};
			}
			const { result, picked } = outcome.value;
			const evidencePath = context.saveEvidence(evidenceName("search"), result.raw);
			context.report({
				kind: "search",
				query,
				ok: true,
				latencyMs: result.latencyMs,
				count: result.results.length,
				keyId: picked.id,
				...(evidencePath ? { evidencePath } : {}),
				records: result.results,
			});
			const remaining = context.remaining();
			return {
				content: [{ type: "text", text: renderSearch(result, evidencePath, remaining) }],
				details: {
					ok: true,
					kind: "search",
					query,
					count: result.results.length,
					...(evidencePath ? { evidencePath } : {}),
					remaining,
				},
			};
		},
	});

const extractTool = (context: WebSearchToolContext): ToolDefinition =>
	defineTool({
		name: "web_extract",
		label: "Extract page content (Tavily)",
		description:
			"Fetch the readable main content of 1-10 public http(s) URLs through the operator's Tavily account — the follow-up to web_search when a snippet is not enough. JavaScript-heavy pages may come back empty; try extract_depth=advanced then. The console sends the request, keys stay on the host, calls are metered, logged and written to the evidence directory.",
		promptSnippet: "Fetch the readable content of public pages (Tavily extract)",
		promptGuidelines: [
			"Up to 10 URLs per call; batch related pages instead of calling one by one",
			"basic is cheaper and faster; advanced renders more JavaScript but spends more quota",
			"Only public URLs: this is not a fetch-through-proxy for internal addresses",
		],
		parameters: Type.Object({
			urls: Type.Array(Type.String(), {
				minItems: 1,
				maxItems: 10,
				description: "要抓取的 http(s) 页面地址，1-10 个",
			}),
			extract_depth: Type.Optional(
				Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
					description: "basic 快而省额度；advanced 渲染更多 JS，默认 basic",
				}),
			),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<WebSearchToolDetails>> {
			if (!context.consume()) return budgetDenied(context);
			const query = params.urls.join(" ");
			const outcome = await withKeyRotation(context, async (picked) => {
				const result = await extractWeb({
					key: picked.key,
					keyId: picked.label,
					urls: params.urls,
					depth: params.extract_depth,
				});
				return { result, picked };
			});
			if ("error" in outcome) {
				const message = outcome.error;
				context.report({ kind: "extract", query, ok: false, latencyMs: 0, count: 0, error: message, records: [] });
				return {
					content: [{ type: "text", text: `页面抓取失败：${message}` }],
					details: { ok: false, kind: "extract", query, count: 0, error: message, remaining: context.remaining() },
					isError: true,
				};
			}
			const { result, picked } = outcome.value;
			const evidencePath = context.saveEvidence(evidenceName("extract"), result.raw);
			context.report({
				kind: "extract",
				query,
				ok: true,
				latencyMs: result.latencyMs,
				count: result.pages.length,
				keyId: picked.id,
				...(evidencePath ? { evidencePath } : {}),
				records: result.pages.map((page) => ({ url: page.url, length: page.content.length })),
			});
			const remaining = context.remaining();
			return {
				content: [{ type: "text", text: renderExtract(result, evidencePath, remaining) }],
				details: {
					ok: true,
					kind: "extract",
					query,
					count: result.pages.length,
					...(evidencePath ? { evidencePath } : {}),
					remaining,
				},
			};
		},
	});

export function createWebSearchTools(context: WebSearchToolContext): ToolDefinition[] {
	return [searchTool(context), extractTool(context)];
}
