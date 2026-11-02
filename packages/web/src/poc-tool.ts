/**
 * The POC library's agent-facing tools: search and read, nothing else.
 *
 * The library is read-only by construction. Its rows live in the config
 * directory and never enter the project container, so there is no path the
 * agent could point nuclei at. What it gets back from `poc_read` is template
 * text; to fire it, the agent has to write its own yaml into the working
 * directory and run nuclei on that file through bash — the same gate as any
 * other command. Both tool descriptions say so, because a model that does not
 * know the bargain will try to execute the library instead.
 */

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PocStore } from "./pocs.ts";
import type { SentinelPocSeverity } from "./protocol.ts";

/** Longest tool output handed back to the model. */
const MAX_TOOL_OUTPUT = 12000;

/**
 * Ceiling for one batched `poc_read`. Templates run 1-3KB each, so eight of them
 * are already a few thousand tokens of context; a model that needs more can ask
 * again, and one oversized template must not push the rest out of the answer.
 */
const MAX_BATCH_OUTPUT = 30000;

/** Ids one `poc_read` call is meant to carry; the schema states the same limit. */
const MAX_BATCH_IDS = 8;

function clip(text: string): string {
	if (text.length <= MAX_TOOL_OUTPUT) return text;
	return `${text.slice(0, MAX_TOOL_OUTPUT)}\n…（输出已截断，共 ${text.length} 字符）`;
}

const SEVERITY_LABELS: Record<SentinelPocSeverity, string> = {
	critical: "严重",
	high: "高危",
	medium: "中危",
	low: "低危",
	info: "信息",
};

/**
 * Appended to every `poc_read`, outside the clip so a truncated template still
 * carries it. A template's `path` is the author's guess at one common
 * deployment: the failure this prevents is the model firing that path as
 * written, getting a 404, and reporting the target as unaffected.
 */
const TEMPLATE_PATH_NOTE =
	"（提醒：模板里的 path / URL 前缀是作者按常见部署写的，未必等于目标上的真实路径。先按侦察结果确认真实前缀，再把匹配逻辑搬过去；照抄路径跑一次的命中或未命中，都不能单独作为结论。）";

const searchSchema = Type.Object({
	search: Type.Optional(
		Type.String({
			description:
				"One case-insensitive substring matched against template id, name, tags and CVE ids, e.g. 'tomcat' or 'CVE-2021-44228'. Not a natural-language query or a space-separated AND query; search different products separately.",
		}),
	),
	severity: Type.Optional(
		Type.Union(
			[
				Type.Literal("critical"),
				Type.Literal("high"),
				Type.Literal("medium"),
				Type.Literal("low"),
				Type.Literal("info"),
			],
			{ description: "Only templates of this severity" },
		),
	),
	tag: Type.Optional(Type.String({ description: "Exact tag match, e.g. 'cve', 'rce', 'wordpress'" })),
});

const readSchema = Type.Object({
	ids: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		maxItems: MAX_BATCH_IDS,
		description: `Template ids from poc_search, e.g. ["CVE-2021-44228-log4j-rce"]. One call reads up to ${MAX_BATCH_IDS}.`,
	}),
});

export interface PocToolOptions {
	store: PocStore;
}

interface SearchDetails {
	ok: boolean;
	count: number;
	/** The library held more matches than this answer listed. */
	hasMore: boolean;
}

interface ReadDetails {
	ok: boolean;
	/** Ids whose template text is in this answer. */
	ids: string[];
	/** Ids that are not in the library. */
	missing: string[];
	/** Ids that exist but did not fit in this answer's output budget. */
	omitted: string[];
}

export function createPocTools(options: PocToolOptions): ToolDefinition[] {
	const search = defineTool({
		name: "poc_search",
		label: "Search POC library",
		description:
			"Search the operator's read-only Nuclei POC library by keyword, tag or severity, and get back template ids with metadata. Proactively use this when a task or reconnaissance identifies a product, component, version or CVE and you need to map candidate vulnerabilities, before writing or downloading a POC; do not wait for the user to mention the library. Read relevant candidates with poc_read. The library is generic fingerprint knowledge: templates carry one common deployment's paths, not the target's, and are reference material, not executable from here. To actually test a target, write your own yaml into the working directory and run nuclei on it via bash.",
		promptSnippet: "Search the read-only Nuclei POC library for templates matching a keyword, tag or severity",
		promptGuidelines: [
			"When the task or reconnaissance identifies a product, component, version or CVE, proactively search the POC library (poc_search) for relevant checks before selecting vulnerability tests, writing a template from scratch or downloading a POC; do not wait for the user to name this tool",
			"Search one product name, alias or CVE at a time (e.g. tomcat); search is a literal substring, so a sentence or several space-separated keywords may miss existing templates. Read relevant candidate ids with poc_read before adapting a check",
			"If a focused POC search has no matches, try a relevant product alias or CVE when known, then continue with other evidence; an empty library search does not mean the target is safe, and unchanged searches need not be repeated",
			"Templates from the library are read-only reference: to use one, write the yaml yourself into the working directory and run nuclei on your own file via bash",
			"Use the library for generic fingerprinting of a product or CVE, not as a ready-made attack on the current target: a template's path and URL prefix are one common deployment, so confirm the real prefix from recon and adapt the request instead of firing the path as written",
			"A template that misses on its hardcoded path is not evidence that the target is unaffected: the match logic is what it is worth, the path is a guess",
		],
		parameters: searchSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<SearchDetails>> {
			const page = options.store.list({
				...(params.search?.trim() ? { search: params.search.trim() } : {}),
				...(params.severity ? { severity: params.severity as SentinelPocSeverity } : {}),
				...(params.tag?.trim() ? { tag: params.tag.trim() } : {}),
			});
			if (page.items.length === 0) {
				return {
					content: [{ type: "text", text: "POC 库中没有匹配的模板。" }],
					details: { ok: true, count: 0, hasMore: false },
				};
			}
			const lines = page.items.map((item) => {
				const tags = item.tags.length > 0 ? ` | ${item.tags.join(",")}` : "";
				const refs = item.references.length > 0 ? ` | ${item.references.join(",")}` : "";
				return `${item.id} | ${SEVERITY_LABELS[item.severity]} | ${item.name}${tags}${refs}`;
			});
			// Both notes stay outside the clip: the list itself is what exhausts the
			// budget, and a truncated answer that loses the "there is more" line would
			// read as the whole library.
			const notes = ["用 poc_read 按 id 取模板全文，可一次传多个 id。"];
			if (page.hasMore) {
				notes.push("库中还有更多匹配未列出：请用 severity、tag 或更具体的关键词收窄查询，再取下一批。");
			}
			const text = [
				clip(`POC 库 ${page.items.length} 条匹配（id | 等级 | 名称 | 标签 | CVE）：\n${lines.join("\n")}`),
				...notes,
			].join("\n\n");
			return {
				content: [{ type: "text", text }],
				details: { ok: true, count: page.items.length, hasMore: page.hasMore },
			};
		},
	});

	const read = defineTool({
		name: "poc_read",
		label: "Read POC templates",
		description: `Read Nuclei templates from the POC library in full, by id. Pass several ids to get them in one call (up to ${MAX_BATCH_IDS}); ids that are not in the library are reported back by name. The text is reference material only — it is not mounted in the container and cannot be executed from the library. To test with it, write the yaml yourself into the working directory and run nuclei on your own file via bash.`,
		promptSnippet: "Read one or more templates from the read-only Nuclei POC library in full",
		promptGuidelines: [
			"Read several candidate templates in one poc_read call (up to 8 ids) instead of one call per template",
		],
		parameters: readSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<ReadDetails>> {
			// A model copying ids out of a previous answer repeats them often enough to
			// make dedupe worth it, and a blank id would otherwise query for "".
			const ids = [...new Set(params.ids.map((id) => id.trim()).filter((id) => id.length > 0))];
			if (ids.length === 0) {
				return {
					content: [{ type: "text", text: "没有给出有效的模板 id。" }],
					details: { ok: false, ids: [], missing: [], omitted: [] },
					isError: true,
				};
			}
			const byId = new Map(options.store.getMany(ids).map((poc) => [poc.id, poc]));
			const missing: string[] = [];
			const omitted: string[] = [];
			const returned: string[] = [];
			const sections: string[] = [];
			let used = 0;
			for (const id of ids) {
				const poc = byId.get(id);
				if (!poc) {
					missing.push(id);
					continue;
				}
				const section = clip(`模板 ${poc.id}（${SEVERITY_LABELS[poc.severity]}）：\n\n${poc.content}`);
				// Greedy: a template too large for what is left is named in a note
				// instead of blocking the smaller ones behind it.
				if (used + section.length > MAX_BATCH_OUTPUT) {
					omitted.push(poc.id);
					continue;
				}
				used += section.length;
				returned.push(poc.id);
				sections.push(section);
			}
			if (sections.length === 0) {
				const text =
					missing.length > 0
						? `POC 库中没有 id 为 ${missing.join("、")} 的模板。`
						: "本次没有可返回的模板：单次可读的正文总量有限，请减少 id 数量后重试。";
				return {
					content: [{ type: "text", text }],
					details: { ok: false, ids: [], missing, omitted },
					isError: true,
				};
			}
			const notes: string[] = [];
			if (missing.length > 0) notes.push(`未找到：${missing.join("、")}（用 poc_search 确认 id）。`);
			if (omitted.length > 0) {
				notes.push(`本次未返回：${omitted.join("、")}（一次能带的正文总量有限，请减少 id 或单独读取）。`);
			}
			// The path note is outside the clips, so a truncated answer still carries it.
			notes.push(TEMPLATE_PATH_NOTE);
			return {
				content: [{ type: "text", text: `${sections.join("\n\n")}\n\n${notes.join("\n")}` }],
				details: { ok: true, ids: returned, missing, omitted },
			};
		},
	});

	return [search, read];
}
