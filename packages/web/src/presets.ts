/**
 * Preset agents: named blocks of extra system-prompt context.
 *
 * A preset is context, not capability. It contributes text to a session's
 * system prompt and nothing else — no tools, no skills, no model. That keeps
 * "which agent am I working with" a question about knowledge and framing, while
 * "what may it do" stays with the permission switches, where exactly one place
 * decides it. A preset that could widen tools would be a second answer to that
 * question, and the operator would have to check both.
 *
 * Storage is split on purpose. `presets.json` holds metadata (name, description,
 * tags, enabled); `presets/<id>.md` holds the body. Prompt text is what
 * operators actually write, and a markdown file is diffable, greppable and
 * copyable between machines — burying it in a JSON string would make every edit
 * a JSON edit. The metadata file is the index, so a preset whose body went
 * missing is reported as broken instead of silently contributing nothing.
 *
 * A missing or corrupt `presets.json` reads as an empty list: a broken config
 * file must not lock the console, which is the rule every other reader follows.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { t } from "./i18n.ts";
import type { SentinelPreset, SentinelPresetView } from "./protocol.ts";

/** Metadata file, next to the other console config. */
export const PRESETS_FILE = "presets.json";
/** Directory holding one `<id>.md` per preset. */
export const PRESETS_DIR = "presets";

/** Longest accepted preset name; the sidebar and brief both show it inline. */
export const MAX_PRESET_NAME_CHARS = 60;
/** Longest accepted description. The brief shows only its first 80 characters. */
export const MAX_PRESET_DESCRIPTION_CHARS = 200;
/** Longest accepted composer hint. It has to read as one line above the input. */
export const MAX_PRESET_PLACEHOLDER_CHARS = 120;
/** Longest accepted tag, and how many a preset may carry. */
export const MAX_PRESET_TAG_CHARS = 24;
export const MAX_PRESET_TAGS = 12;

/**
 * Commander-brief limits. The preset list enters the commander's context on
 * every round, so an operator with forty presets must not push the board and the
 * target list out of it. Beyond `PRESET_BRIEF_MAX` the brief names the overflow
 * and asks for a shorter list rather than silently dropping entries.
 */
export const PRESET_BRIEF_MAX = 30;
export const PRESET_BRIEF_DESCRIPTION_CHARS = 80;
export const PRESET_BRIEF_MAX_TAGS = 5;

/** Rough token-cost thresholds the settings screen colours against. */
export const PRESET_TOKEN_WARN = 2000;
export const PRESET_TOKEN_DANGER = 8000;

/** Format marker and version of an exported preset file. */
export const PRESETS_EXPORT_FORMAT = "sentinel-presets";
export const PRESETS_EXPORT_VERSION = 1;

/** One preset with its body, as written to and read from an export file. */
export interface SentinelPresetExportEntry extends SentinelPreset {
	text: string;
}

export interface SentinelPresetExport {
	format: typeof PRESETS_EXPORT_FORMAT;
	version: number;
	exportedAt: number;
	presets: SentinelPresetExportEntry[];
}

export interface SentinelPresetImportResult {
	imported: SentinelPreset[];
	/** Entries that could not be imported, with the reason shown to the operator. */
	skipped: Array<{ name: string; reason: string }>;
	/** Set when the file itself is unusable; per-entry problems go to `skipped`. */
	error?: string;
}

export type SentinelPresetTokenLevel = "ok" | "warn" | "danger";

export function presetsPath(agentDir: string): string {
	return join(agentDir, PRESETS_FILE);
}

export function presetsDir(agentDir: string): string {
	return join(agentDir, PRESETS_DIR);
}

/**
 * The presets every fresh console ships with. They are seeded, not mounted: the
 * first start writes them into the operator's store as ordinary presets, which
 * keeps the rest of the code free of a second preset source. Seeding matches by
 * name and id and only fills a gap — an operator's own edit to a same-named
 * preset is the more valuable copy, so it is never overwritten, and a preset
 * the operator deleted stays deleted.
 */
const BUILTIN_PRESETS: readonly {
	id: string;
	name: string;
	description: string;
	tags: string[];
	placeholder: string;
	text: string;
}[] = [
	{
		id: "web-pentest",
		name: "Web 渗透测试",
		description: "Web 渗透测试，深度渗透测试，以 RCE 为目标",
		tags: ["web"],
		placeholder: "输入目标 URL，敲回车即可。",
		text: "深度渗透测试，以 RCE 为目标进行深度渗透测试，中途挖到的漏洞也要，尽量多的扩大战果，挖到 RCE 之后，不允许影响系统业务正常运行，只允许执行 pwd 来验证，在整个漏洞挖掘的过程中，不允许对系统业务正常运行产生影响，比如删除用户、修改用户密码、删除任何东西、修改系统配置等等。",
	},
	{
		id: "source-code-audit",
		name: "源代码审计 Agent",
		description: "深度源代码安全审计，优先挖掘 RCE，其次审计 OWASP Top 10 风险，只上报有充分证据的漏洞",
		tags: ["源代码审计", "RCE", "OWASP Top 10"],
		placeholder:
			"上传源代码文件或压缩包，即可开始审计；代码包较大时，可先剔除图片、音视频等静态资源，保留源码、配置及依赖清单。",
		text: [
			"你是一名资深源代码安全审计专家。对用户提供的源代码进行深入审计，发现具有真实利用条件和明确安全影响的漏洞。",
			"",
			"审计优先级：",
			"1. 优先挖掘可能导致远程代码执行（RCE）的漏洞，包括命令注入、代码注入、不安全反序列化、模板注入，以及可组合形成 RCE 的漏洞链。",
			"2. 其次审计 OWASP Top 10 相关风险，重点关注权限绕过、注入、服务端请求伪造、路径穿越、任意文件读写等具有实际影响的问题。",
			"",
			"审计方法：",
			"1. 先理解项目架构、技术栈、入口、身份认证、权限控制和关键业务流程，再深入审计。",
			"2. 项目较大或需要系统梳理时，做一次业务建模里读源码的部分（操作员选用本预设即视为提出这一要求；先用 api_model_read 取 part=guide 的操作指引）：用 source_model_submit 分批提交每个接口的入口、调用链、读写的表、权限校验位置和外部调用，以及业务实体、状态机、资源归属和跨接口依赖，每条带代码位置；完成后用 api_model_done 说明覆盖范围。本项目已有业务建模记录时先用 api_model_read 读取，不重复做；之后的越权和业务逻辑审计以这份模型为索引，再到源码里核实。",
			"3. 从外部可控输入出发，跨文件、跨函数追踪数据流，核实危险操作是否实际可达，并检查过滤、权限校验和运行配置。",
			"4. 不局限于关键词搜索或单个危险函数，深入分析业务逻辑、信任边界及漏洞之间的组合关系。",
			"5. 明确区分代码层面确认的问题与实际环境验证结果，不得将未执行的验证描述为验证成功。",
			"",
			"报告质量：",
			"1. 只上报有充分代码证据、明确触发条件和实际安全影响的漏洞。不得为凑数量上报低价值、重复或仅靠猜测的问题。",
			"2. 不将危险函数的存在、依赖版本命中、缺少最佳实践，直接认定为可利用漏洞。",
			"3. 每个漏洞应包含文件路径与行号、相关代码、输入到危险操作的完整调用链、利用前提、安全影响、验证方法及修复建议。",
			"4. 待确认的问题单独列为待核实项，不作为已确认漏洞上报。相同根因的问题合并说明。",
			"5. 没有发现符合标准的漏洞时，如实说明审计范围、已检查内容和验证限制，不得编造发现。",
			"",
			"保留用户源代码及已有文件。需要验证时，使用隔离环境和最小影响的方法，并保存必要的验证证据。",
		].join("\n"),
	},
	{
		id: "app-client",
		name: "APP 客户端漏洞挖掘",
		description: "APP 客户端漏洞挖掘",
		tags: ["app"],
		placeholder: "确认“安卓设备”内有设备连接，并且安装好 APP，然后再右方点击“安卓”，最后说明你想测试的 APP 即可。",
		text: "你是一名APP 客户端漏洞挖掘，你需要对用户提供的目标 APP 进行客户端漏洞挖掘（不涉及服务端），深入漏洞挖掘，以客户端 RCE 漏洞为目标进行测试，其中遇到的其他漏洞也要上报漏洞中枢。如果你没有远程连接安卓相关的工具，那么请提醒用户把“安卓”权限放开。",
	},
	{
		id: "app-server",
		name: "APP 服务端漏洞挖掘",
		description: "APP 服务端漏洞挖掘",
		tags: ["app"],
		placeholder: "确认“安卓设备”内有设备连接，并且安装好 APP，然后再右方点击“安卓”，最后说明你想测试的 APP 即可。",
		text: [
			"你是一名渗透测试专家，需要对目标 APP 做渗透测试，目标是测试 APP 对应的服务端进行测试，通常，你的任务工作流是->逆向 APP->分析源码->对目标业务系统进行业务建模->开始挖掘漏洞。",
			"挖掘漏洞的目标：以 RCE 为目标，进行渗透测试，注意：如果挖到 RCE 漏洞，只允许执行 pwd、dir 命令，并且，在整个漏洞挖掘过程中，不允许对目标业务系统造成影响。",
			"",
			"如果你没有远程连接安卓相关的工具，那么请提醒用户把“安卓”权限放开。",
		].join("\n"),
	},
	{
		id: "recon",
		name: "信息收集",
		description: "资产测绘与信息收集，发现即上报资产库",
		tags: ["信息收集", "资产"],
		placeholder: "描述要收集的目标（域名 / IP / 组织名），敲回车即可。",
		text: [
			"你是一名信息收集与资产测绘专家，负责对用户给定的目标做全面的信息收集，并把所有发现上报资产库。",
			"",
			"边界：只收集，不利用。不爆破登录、不利用漏洞、不做任何破坏性或影响业务的操作；主动扫描控制强度，端口 / 服务 / Web 指纹可以做，发现可疑攻击面只记录不下手。",
			"",
			"收集维度（按目标类型裁剪，被动优先、主动其次）：",
			"1. 域名与子域名：证书透明度、DNS 记录与解析、搜索引擎、公开数据集；需要时再做子域名枚举，逐一确认存活与解析。",
			"2. IP 与开放服务：端口扫描、服务与版本识别，区分对外暴露面与内网段。",
			"3. Web 资产：存活探测、标题、指纹（中间件 / 框架 / CMS / WAF）、技术栈，逐个记录 URL。",
			"4. 组织情报：WHOIS、备案、组织架构、邮箱与人员（OSINT 公开源）。",
			"5. 敏感信息泄露：公开渠道的 AK/SK、JDBC、密钥、文档、网盘与代码片段；确认真实有效的用 vuln_submit 上报漏洞中枢。",
			"",
			"上报要求（这是本任务的硬性交付）：",
			"1. 每个确认存活的资产都上报资产库：域名、IP、IP:端口服务、URL 分别用 asset_report 上报，带协议、标题、指纹等已知信息。",
			"2. 每条资产的结论与备注（来源、置信度、可疑点）用 asset_note 记录。",
			"3. 全部结束后输出汇总：资产清单、分类统计、值得关注的攻击面（如后台入口、非常用端口、过期组件）、下一步测试建议。",
			"",
			"所有结论给出处；无法确认的标注为待验证。",
		].join("\n"),
	},
	{
		id: "incident-response",
		name: "应急响应",
		description: "安全事件排查与取证：只排查取证，不处置，不动生产环境配置",
		tags: ["应急响应", "取证"],
		placeholder: "描述异常现象（如告警、怀疑入侵）与目标主机 / 资产，敲回车即可。",
		text: [
			"你是一名应急响应专家，负责对用户提供的主机 / 业务做安全事件排查与取证。",
			"",
			"硬性边界（任何情况下不得违反）：",
			"1. 只排查、只读取证，不做任何处置与修复：不重启服务、不启停 / kill 进程，不修改、删除、移动生产环境的任何文件与配置，不改密码、不加账号、不打补丁，不清理后门与恶意文件——只定位、记录并报告，处置由运维决定。",
			"2. 不对目标做高负荷操作：不爆破、不高强度扫描，避免影响业务。",
			"3. 不利用漏洞获取权限；验证类检测以无破坏为前提。",
			"4. 需要留存证据时，只允许把文件复制到你自己的工作目录（如 /work/evidence/ir/），原文件保持原样，并记录 md5 / sha256。",
			"5. 拿不准或超出排查范围的动作，先停下来说明理由并征求用户确认。",
			"",
			"排查思路：",
			"1. 确认范围与现象：受影响主机、业务、时间点、告警内容。",
			"2. 主机侧：进程（ps auxf）、网络连接（netstat / ss）、账号与登录（/etc/passwd、last、w）、计划任务与启动项、历史命令、临时目录、近期改动文件（find -mtime / -newer）。",
			"3. Web 侧：访问日志中的可疑请求、webshell 特征文件、上传目录、中间件配置（只读查看）。",
			"4. 日志侧：系统 / 应用 / 审计日志按时间线串联。",
			"5. 产出：事件时间线、入侵路径研判、IOC 清单（IP、域名、文件 hash、可疑账号、后门路径）、影响范围、处置建议（只写建议，不执行）。",
			"",
			"证据与上报：确认的 webshell、后门、未授权访问等用 vuln_submit 提交漏洞中枢并附证据路径；排查到的资产与结论用 asset_report / asset_note 记录。",
			"所有结论都要给出证据出处；没有证据的判断标注为推测。",
		].join("\n"),
	},
	{
		id: "wechat-miniprogram",
		name: "微信小程序渗透测试",
		description: "微信小程序渗透测试",
		tags: ["app"],
		placeholder: "上传反编译后的微信小程序包即可。",
		text: [
			"你的任务是对目标微信小程序进行渗透测试，大致分两类：",
			"1.针对微信小程序生态的：比如 AKSK 泄露、JDBC 泄露之类的。",
			"2.针对远程目标服务器的，一般情况下流程如下：查看用户上传的微信小程序包并解压->对目标进行业务建模->根据业务建模结果继续渗透测试,以数据和权限为目标，尝试 RCE 远程服务器。",
			"",
			"注意：渗透测试过程中，不允许影响目标服务器的正常运行，不允许删除、修改用户密码，不允许对业务正常运行造成影响。",
		].join("\n"),
	},
];

/**
 * Write any built-in preset the store does not have yet, and its body file.
 * Called once per console start; a no-op on every later start.
 */
export function ensureBuiltinPresets(agentDir: string): void {
	const stored = readStored(agentDir);
	const names = new Set(stored.map((preset) => preset.name));
	const ids = new Set(stored.map((preset) => preset.id));
	const missing = BUILTIN_PRESETS.filter((builtin) => !names.has(builtin.name) && !ids.has(builtin.id));
	if (missing.length === 0) return;
	const now = Date.now();
	writeStored(agentDir, [
		...stored,
		...missing.map((builtin) => ({
			id: builtin.id,
			name: builtin.name,
			description: builtin.description,
			tags: [...builtin.tags],
			placeholder: builtin.placeholder,
			enabled: true,
			createdAt: now,
			updatedAt: now,
		})),
	]);
	mkdirSync(presetsDir(agentDir), { recursive: true });
	for (const builtin of missing) {
		const path = presetTextPath(agentDir, builtin.id);
		if (existsSync(path)) continue;
		writeFileSync(path, `${builtin.text.trim()}\n`, { mode: 0o600 });
	}
}

/**
 * Preset ids end up in file names and in the commander's brief, so they are
 * restricted to a slug alphabet. A hand-edited `presets.json` carrying `../` in
 * an id must not be able to point the body path outside the presets directory.
 */
export function isPresetId(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

/** Body path for a preset; only valid ids reach it. */
export function presetTextPath(agentDir: string, id: string): string {
	return join(presetsDir(agentDir), `${id}.md`);
}

/**
 * Rough token estimate for the settings screen. CJK counts about one token per
 * character, everything else about one per four characters. It is deliberately
 * crude and labelled as an estimate in the UI — the point is to make a 40,000
 * character preset visible before it is loaded, not to predict a bill.
 */
export function estimateTokens(text: string): number {
	let wide = 0;
	let narrow = 0;
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (isWideCodePoint(code)) wide += 1;
		else narrow += 1;
	}
	return Math.ceil(wide + narrow / 4);
}

export function presetTokenLevel(tokens: number): SentinelPresetTokenLevel {
	if (tokens >= PRESET_TOKEN_DANGER) return "danger";
	if (tokens >= PRESET_TOKEN_WARN) return "warn";
	return "ok";
}

function isWideCodePoint(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0x303e) ||
		(code >= 0x3041 && code <= 0x33ff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xa000 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x20000 && code <= 0x2fa1f)
	);
}

interface PresetsFile {
	presets: SentinelPreset[];
}

function normalizeTags(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const tags: string[] = [];
	for (const raw of value) {
		if (typeof raw !== "string") continue;
		const tag = raw.trim();
		if (!tag) continue;
		if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) continue;
		tags.push(tag);
	}
	return tags;
}

/** Coerce one stored entry; null when it has no usable identity. */
function normalizeStored(value: unknown): SentinelPreset | null {
	if (typeof value !== "object" || value === null) return null;
	const entry = value as Record<string, unknown>;
	if (!isPresetId(entry.id)) return null;
	if (typeof entry.name !== "string" || !entry.name.trim()) return null;
	const createdAt = typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : 0;
	return {
		id: entry.id,
		name: entry.name.trim(),
		description: typeof entry.description === "string" ? entry.description.trim() : "",
		tags: normalizeTags(entry.tags),
		// A preset written before the hint existed has none, and none means "use the
		// console's default text" — never a blank input.
		placeholder: typeof entry.placeholder === "string" ? entry.placeholder.trim() : "",
		// A stored entry without the flag was written before presets could be
		// disabled; reading it as disabled would hide a preset the operator
		// never turned off.
		enabled: entry.enabled !== false,
		createdAt,
		updatedAt: typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : createdAt,
	};
}

function readStored(agentDir: string): SentinelPreset[] {
	const path = presetsPath(agentDir);
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as PresetsFile;
		if (!Array.isArray(parsed.presets)) return [];
		return parsed.presets.map(normalizeStored).filter((entry): entry is SentinelPreset => entry !== null);
	} catch {
		return [];
	}
}

function writeStored(agentDir: string, presets: SentinelPreset[]): void {
	const path = presetsPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	const file: PresetsFile = { presets };
	writeFileSync(path, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
}

/** Turn a display name into a slug id; empty for a name with no ASCII at all. */
function slugify(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
}

/**
 * Ids are generated, never typed. A name that yields no slug — Chinese names
 * mostly, which is the normal case here — falls back to a random suffix, and a
 * collision gets `-2`, `-3`, … so a name can be reused without clobbering.
 */
function uniqueId(presets: readonly SentinelPreset[], name: string): string {
	const base = slugify(name) || `preset-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const taken = new Set(presets.map((preset) => preset.id));
	if (!taken.has(base)) return base;
	for (let suffix = 2; suffix < 1000; suffix += 1) {
		const candidate = `${base}-${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Metadata of every stored preset, in file order. Bodies are not read. */
export function listPresets(agentDir: string): SentinelPreset[] {
	return readStored(agentDir);
}

/** Enabled presets only: what a new session and the commander may choose from. */
export function listEnabledPresets(agentDir: string): SentinelPreset[] {
	return readStored(agentDir).filter((preset) => preset.enabled);
}

export function findPreset(agentDir: string, id: string): SentinelPreset | null {
	if (!isPresetId(id)) return null;
	return readStored(agentDir).find((preset) => preset.id === id) ?? null;
}

/** The preset body, or null when the file is missing or the id is unusable. */
export function readPresetText(agentDir: string, id: string): string | null {
	if (!isPresetId(id)) return null;
	const path = presetTextPath(agentDir, id);
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

/** Every preset with its body loaded, for the settings screen. */
export function presetViews(agentDir: string): SentinelPresetView[] {
	return readStored(agentDir).map((preset) => viewOf(agentDir, preset));
}

/** One preset with its body loaded, or null when it does not exist. */
export function presetView(agentDir: string, id: string): SentinelPresetView | null {
	const preset = findPreset(agentDir, id);
	return preset ? viewOf(agentDir, preset) : null;
}

function viewOf(agentDir: string, preset: SentinelPreset): SentinelPresetView {
	const text = readPresetText(agentDir, preset.id);
	return {
		...preset,
		text: text ?? "",
		textMissing: text === null,
		tokens: text === null ? 0 : estimateTokens(text),
	};
}

export interface SavePresetInput {
	/** Present to update an existing preset; omitted to create one. */
	id?: string;
	name: string;
	description?: string;
	tags?: string[];
	/** The composer hint while this preset is active; omitted or empty keeps the default. */
	placeholder?: string;
	text: string;
	/** Defaults to true on create, and to the stored value on update. */
	enabled?: boolean;
}

export function savePreset(agentDir: string, input: SavePresetInput): { preset?: SentinelPreset; error?: string } {
	const name = input.name.trim();
	if (!name) return { error: t("预设名称不能为空") };
	if (name.length > MAX_PRESET_NAME_CHARS) {
		return { error: t("预设名称过长（最多 {max} 字）", { max: MAX_PRESET_NAME_CHARS }) };
	}
	const description = (input.description ?? "").trim();
	if (description.length > MAX_PRESET_DESCRIPTION_CHARS) {
		return { error: t("预设描述过长（最多 {max} 字）", { max: MAX_PRESET_DESCRIPTION_CHARS }) };
	}
	const placeholder = (input.placeholder ?? "").trim();
	if (placeholder.length > MAX_PRESET_PLACEHOLDER_CHARS) {
		return { error: t("输入框提示过长（最多 {max} 字）", { max: MAX_PRESET_PLACEHOLDER_CHARS }) };
	}
	const tags = normalizeTags(input.tags ?? []);
	if (tags.length > MAX_PRESET_TAGS) return { error: t("标签过多（最多 {max} 个）", { max: MAX_PRESET_TAGS }) };
	const longTag = tags.find((tag) => tag.length > MAX_PRESET_TAG_CHARS);
	if (longTag)
		return {
			error: t("标签过长（最多 {max} 字）：{tag}", { max: MAX_PRESET_TAG_CHARS, tag: longTag }),
		};
	// The body may be any length — the settings screen shows its token cost
	// instead of refusing it — but an empty body is a preset that does nothing.
	const text = input.text.trim();
	if (!text) return { error: t("预设内容不能为空") };

	const presets = readStored(agentDir);
	const existing = input.id ? presets.find((preset) => preset.id === input.id) : undefined;
	if (input.id && !existing) return { error: t("该预设不存在") };

	const now = Date.now();
	const preset: SentinelPreset = existing
		? {
				...existing,
				name,
				description,
				tags,
				placeholder,
				enabled: input.enabled ?? existing.enabled,
				updatedAt: now,
			}
		: {
				id: uniqueId(presets, name),
				name,
				description,
				tags,
				placeholder,
				enabled: input.enabled ?? true,
				createdAt: now,
				updatedAt: now,
			};

	const next = existing ? presets.map((entry) => (entry.id === preset.id ? preset : entry)) : [...presets, preset];
	// Metadata first: an id with no body would be listed as broken, while a body
	// with no metadata is unreachable but harmless.
	writeStored(agentDir, next);
	mkdirSync(presetsDir(agentDir), { recursive: true });
	writeFileSync(presetTextPath(agentDir, preset.id), `${text}\n`, { mode: 0o600 });
	return { preset };
}

export function setPresetEnabled(
	agentDir: string,
	id: string,
	enabled: boolean,
): { preset?: SentinelPreset; error?: string } {
	const presets = readStored(agentDir);
	const existing = presets.find((preset) => preset.id === id);
	if (!existing) return { error: t("该预设不存在") };
	const preset: SentinelPreset = { ...existing, enabled, updatedAt: Date.now() };
	writeStored(
		agentDir,
		presets.map((entry) => (entry.id === id ? preset : entry)),
	);
	return { preset };
}

/**
 * Remove a preset. Sessions and engines that already used it keep their own
 * record of the name and fall back to the default agent, which is why deletion
 * is not blocked by references: an unusable preset would otherwise sit in the
 * picker forever, and the operator can always re-create it from an export.
 */
export function deletePreset(agentDir: string, id: string): { ok: boolean; error?: string } {
	const presets = readStored(agentDir);
	if (!presets.some((preset) => preset.id === id)) return { ok: false, error: t("该预设不存在") };
	writeStored(
		agentDir,
		presets.filter((preset) => preset.id !== id),
	);
	try {
		unlinkSync(presetTextPath(agentDir, id));
	} catch {
		// The body was already gone; the metadata entry is what mattered.
	}
	return { ok: true };
}

/** Export presets, bodies included, as one self-contained JSON file. */
export function exportPresets(agentDir: string, ids?: readonly string[]): SentinelPresetExport {
	const wanted = ids && ids.length > 0 ? new Set(ids) : null;
	const presets = readStored(agentDir)
		.filter((preset) => !wanted || wanted.has(preset.id))
		.map((preset) => ({ ...preset, text: readPresetText(agentDir, preset.id) ?? "" }));
	return {
		format: PRESETS_EXPORT_FORMAT,
		version: PRESETS_EXPORT_VERSION,
		exportedAt: Date.now(),
		presets,
	};
}

export function exportFileName(now: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `sentinel-presets-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}.json`;
}

/**
 * Import presets from an export file.
 *
 * Every entry is saved as a new copy with a freshly generated id. Importing is
 * how a preset travels between machines or teammates, so it must never
 * overwrite what is already here: the operator's own edit to a same-named
 * preset is the more valuable of the two, and a silent overwrite is not
 * something they could notice afterwards.
 */
export function importPresets(agentDir: string, payload: unknown): SentinelPresetImportResult {
	const skipped: SentinelPresetImportResult["skipped"] = [];
	if (typeof payload !== "object" || payload === null) {
		return { imported: [], skipped, error: t("文件内容不是合法的 JSON 对象") };
	}
	const file = payload as Partial<SentinelPresetExport>;
	if (file.format !== PRESETS_EXPORT_FORMAT) {
		return { imported: [], skipped, error: t("不是 全链哨兵 预设导出文件") };
	}
	if (file.version !== PRESETS_EXPORT_VERSION) {
		return { imported: [], skipped, error: t("不支持的导出版本：{version}", { version: String(file.version) }) };
	}
	if (!Array.isArray(file.presets)) return { imported: [], skipped, error: t("文件里没有预设列表") };

	const imported: SentinelPreset[] = [];
	for (const raw of file.presets) {
		if (typeof raw !== "object" || raw === null) {
			skipped.push({ name: t("（未命名）"), reason: t("条目不是对象") });
			continue;
		}
		const entry = raw as Partial<SentinelPresetExportEntry>;
		const label = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : t("（未命名）");
		const result = savePreset(agentDir, {
			name: typeof entry.name === "string" ? entry.name : "",
			description: typeof entry.description === "string" ? entry.description : "",
			tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [],
			placeholder: typeof entry.placeholder === "string" ? entry.placeholder : "",
			text: typeof entry.text === "string" ? entry.text : "",
			enabled: entry.enabled !== false,
		});
		if (result.preset) imported.push(result.preset);
		else skipped.push({ name: label, reason: result.error ?? t("无法导入") });
	}
	return { imported, skipped };
}

/** Drop a description to the brief's width, on a character boundary. */
export function briefDescription(description: string): string {
	const trimmed = description.trim();
	if (trimmed.length <= PRESET_BRIEF_DESCRIPTION_CHARS) return trimmed;
	return `${trimmed.slice(0, PRESET_BRIEF_DESCRIPTION_CHARS - 1)}…`;
}

/**
 * The preset list as the commander's brief shows it: id, name, description and
 * the first few tags, one per line. Only enabled presets appear — a disabled
 * preset is not a choice, and offering it would produce a dispatch that gets
 * refused. The overflow line exists so an operator with a long list learns why
 * the commander cannot see all of it.
 */
export function presetBriefLines(presets: readonly SentinelPreset[]): string[] {
	const enabled = presets.filter((preset) => preset.enabled);
	const shown = enabled.slice(0, PRESET_BRIEF_MAX);
	const lines = shown.map((preset) => {
		const description = briefDescription(preset.description);
		const tags = preset.tags.slice(0, PRESET_BRIEF_MAX_TAGS).join("、");
		const suffix = [description, tags ? `[${tags}]` : ""].filter(Boolean).join(" · ");
		return `- ${preset.id} · ${preset.name}${suffix ? ` · ${suffix}` : ""}`;
	});
	if (enabled.length > PRESET_BRIEF_MAX) {
		lines.push(`（另有 ${enabled.length - PRESET_BRIEF_MAX} 条预设未列出，请让操作员精简预设库）`);
	}
	return lines;
}
