/**
 * Command doctrines (指挥思路): named text templates the operator picks when
 * creating an engine. The selected texts are merged into the commander's system
 * prompt.
 *
 * Built-in doctrines ship with the console and cannot be removed;
 * custom doctrines are the operator's own, living in
 * `<agentDir>/doctrines.json` and managed from the engine page. The texts are
 * pure prompt material — nothing here is executed by the engine.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { t } from "./i18n.ts";

export interface SentinelDoctrine {
	id: string;
	name: string;
	/** Prompt text merged into the commander's system prompt. */
	text: string;
	builtin: boolean;
}

/** Built-in playbooks for penetration testing, source audits and CTF challenges. */
const BUILTIN_DOCTRINES: SentinelDoctrine[] = [
	{
		id: "attack-defense-web",
		name: "攻防Web渗透打点",
		text: [
			"对 Web 目标进行深度渗透测试，以权限和数据为目标，最终尝试 RCE，注意不允许影响业务正常运行，在 RCE 后，只允许执行 whoami 进行测试。",
			"",
			"任务分配优先级：",
			"需要先探查任务优先级：",
			"自研 IIS .NEW 系统 > 自研其他系统的优先级 > 通用系统 > 通用 OA>WordPress > 各种门户网站",
			"在下发任务前，请优先测试一下用户提交的目标有无重复，有可能不同域名/IP但是内容是重复的，这点请你熟知。",
			"",
			"用户输入类型判断：",
			"1.如果是 http(s):// 类型，那么直接当做任务目标即可",
			"2.如果是 ip 或者域名，请优先进行信息收集后再进行任务提交",
		].join("\n"),
		builtin: true,
	},
	{
		id: "code-audit",
		name: "代码审计",
		text: [
			"以命令执行 RCE 和其他高危、严重漏洞为目标开展代码审计，优先确认可达、可控且具有实际安全影响的漏洞。",
			"",
			"项目梳理：",
			"先确认源代码目录或附件完整路径、语言与框架、运行入口、依赖版本、路由与认证机制，以及操作员指定的审计范围；代码不可直接读取时，先派发解包和架构梳理任务，保留原始附件。",
			"整理外部输入、信任边界、权限边界与高权限操作，记录部署配置、开关和依赖条件；没有代码或关键配置时明确缺口，不凭经验编造调用关系。",
			"",
			"审计与任务编排：",
			"第一优先级为远程命令执行 RCE：排查系统命令与进程启动、动态代码执行、反序列化、服务端模板执行，以及能够写入可执行位置的任意文件写入或上传；逐条追踪可控输入到危险操作的完整调用链，核对过滤、转义、参数化和沙箱边界。",
			"同时审计其他高危、严重风险：认证绕过与账户接管、越权及权限提升、可造成敏感数据大规模泄露或数据库控制的 SQL 注入、可突破关键边界的 SSRF、任意文件读写及其组合利用链。根据可达性、前置权限、影响范围和证据评估风险，不将低危问题强行升为高危。",
			"按模块或漏洞链拆分独立任务，给执行 Agent 明确代码路径、入口、待验证假设、上下文和验收标准；同一调用链避免重复派发，跨模块的新线索用 steer_task 共享，继续验证时用 continue_task 保留上下文。",
			"先完成入口到危险操作的数据流分析，再验证关键假设；依赖存在已知漏洞不等于项目可利用，必须核对实际版本、调用位置、配置和触发条件。低危及信息性发现只作线索记录，不挤占高危、严重漏洞的验证资源。",
			"",
			"验证与交付：",
			"优先在隔离测试环境构造最小可复现验证；RCE 只需无破坏性证明，例如 whoami。不要修改业务数据、写入持久化后门或扩展到操作员指定范围之外。无法运行时明确标记为静态确认或待动态验证，不伪造命令输出或验证成功。",
			"漏洞记录必须包含文件路径与行号、入口与危险操作、可控参数和调用链、必要配置与权限、复现步骤或最小测试、实际证据、影响与严重性依据、修复建议及验证状态；去重后将已确认漏洞提交到漏洞中枢。",
			"用 engine_done 汇总已确认的高危、严重漏洞、RCE 验证结果、已覆盖模块、未确认假设与阻塞原因。没有发现达到目标的漏洞时如实说明，不为达成目标编造漏洞。",
		].join("\n"),
		builtin: true,
	},
	{
		id: "ctf-jeopardy",
		name: "CTF 竞赛-夺旗",
		text: [
			"面向 CTF 解题赛：分析题目与附件，按题型拆分任务，验证并汇总 flag。",
			"",
			"题目梳理：",
			"先整理操作员提供的题面、附件路径、靶机地址、提示、flag 格式与比赛规则；缺失的信息标记为待确认，不编造题目条件。",
			"附件内容不能直接读取时，先派发附件分析任务，要求执行 Agent 在项目内检查文件类型、目录结构与关键线索，返回题目清单及后续任务所需的完整路径。",
			"按 Web、Pwn、Reverse、Crypto、Misc、Forensics 等类型分类，记录每题进度、线索、尝试过的路线和阻塞原因。",
			"",
			"任务编排：",
			"优先处理线索明确、预期耗时短的题目，独立题目并行，同一题避免重复派发相同路线。",
			"任务指令必须包含题面、完整附件路径或靶机地址、已知线索、flag 格式和验收标准；不能只让执行 Agent 参考指挥官上下文。",
			"选用符合题型的可用预设 Agent；没有合适预设且允许默认 Agent 时，明确写出分析任务要求，不把所有题目套成 Web 渗透。",
			"执行 Agent 应在各自任务目录保存分析脚本、解题脚本与输出，不覆盖原始附件；新线索通过 steer_task 共享，需要继续时用 continue_task 保留已有上下文。",
			"",
			"flag 验证与交付：",
			"候选 flag 必须关联题目、来源、完整值和可复现提取步骤；仅匹配 flag 格式不能视为已经解题，禁止猜测或伪造 flag。",
			"有比赛平台回执时区分 accepted 与 rejected；没有回执时标记为待提交或待验证，不能声称平台已接受。按操作员要求提交，不重复提交同一个 flag。",
			"不要为交付 flag 虚构漏洞记录。用 engine_done 汇总逐题状态、flag、验证依据、解题脚本路径、未解题的阻塞原因与下一步。",
			"活动范围遵守比赛规则及操作员提供的靶机与附件，不把比赛平台、计分系统或其他队伍作为题目目标。",
		].join("\n"),
		builtin: true,
	},
	{
		id: "oss-1day-repro",
		name: "开源 1day 复现",
		text: [
			"目标：对一个已合并的安全修复提交，复现它修复的漏洞。输入是仓库地址、漏洞版本（父提交）与修复版本（修复提交），以及容器内已经准备好的两个源码目录。",
			"",
			"编排要求：",
			"本工程只包含一个目标，只派发一个任务，不要做目标测绘、端口扫描或对外攻击。任务指令必须原样携带：仓库地址、分支、两个提交 SHA、漏洞版本目录、修复版本目录、CVE/GHSA 编号（没有就写无）以及安全修复的主题与类型。",
			"源码已经在容器内准备好：漏洞版本与修复版本各有一个目录，路径在目标备注里。不要重新 clone、不要改这两个目录的历史；目录不存在时直接报告阻塞，不要自己猜路径。",
			"",
			"复现要求：",
			"先对比两个版本，定位修复涉及的文件与函数，讲清漏洞成因、触发入口和修复方式；再在漏洞版本上构建并实际触发，在修复版本上做同一操作确认不再触发。只做静态对比不算复现。",
			"必须写出可重复的 PoC/exp（脚本或最小请求），放在任务工作目录并保留输出；构建失败（缺依赖、需要特殊环境、镜像不可用）算任务失败，如实报告缺失项与尝试过的命令，不伪造成功。",
			"构建或运行只允许在项目容器内进行，不访问外部目标，不写入宿主机。测试数据用自己构造的最小样本。",
			"",
			"交付：",
			"确认可利用后，用 vuln_submit 提交漏洞：目标写仓库与受影响版本，标题按 CVE 或修复主题，描述包含成因、调用链、影响面，原始数据包/证据写实际命令与输出，复现步骤写清楚 vuln 与 fixed 的对照，CVSS 给出合理评分。没有公开 CVE 时不要编造编号。",
			"任务结束时汇报：源码目录、构建命令、PoC 路径、漏洞版本输出、修复版本输出、提交的漏洞编号；失败时汇报阻塞原因。指挥官用 engine_done 汇总，不要在没有复现结果时宣称成功。",
		].join("\n"),
		builtin: true,
	},
];

interface DoctrinesFile {
	doctrines: SentinelDoctrine[];
}

function doctrinesPath(agentDir: string): string {
	return `${agentDir}/doctrines.json`;
}

function readCustom(agentDir: string): SentinelDoctrine[] {
	const path = doctrinesPath(agentDir);
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as DoctrinesFile;
		if (!Array.isArray(parsed.doctrines)) return [];
		return parsed.doctrines.filter(
			(item): item is SentinelDoctrine =>
				typeof item === "object" &&
				item !== null &&
				typeof item.id === "string" &&
				typeof item.name === "string" &&
				typeof item.text === "string",
		);
	} catch {
		return [];
	}
}

function writeCustom(agentDir: string, doctrines: SentinelDoctrine[]): void {
	const path = doctrinesPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	const file: DoctrinesFile = { doctrines };
	writeFileSync(path, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
}

export function listDoctrines(agentDir: string): SentinelDoctrine[] {
	return [...BUILTIN_DOCTRINES, ...readCustom(agentDir)];
}

/** Resolve doctrine ids to their texts, ignoring unknown ids. */
export function resolveDoctrines(agentDir: string, ids: readonly string[]): SentinelDoctrine[] {
	const byId = new Map(listDoctrines(agentDir).map((doctrine) => [doctrine.id, doctrine]));
	const resolved: SentinelDoctrine[] = [];
	for (const id of ids) {
		const doctrine = byId.get(id);
		if (doctrine && !resolved.some((item) => item.id === doctrine.id)) resolved.push(doctrine);
	}
	return resolved;
}

export function saveDoctrine(
	agentDir: string,
	input: { id?: string; name: string; text: string },
): { doctrine?: SentinelDoctrine; error?: string } {
	const name = input.name.trim();
	const text = input.text.trim();
	if (!name) return { error: t("思路名称不能为空") };
	if (!text) return { error: t("思路内容不能为空") };
	const custom = readCustom(agentDir);
	const existing = input.id ? custom.find((item) => item.id === input.id) : undefined;
	if (input.id && !existing) return { error: t("该思路不存在（内置思路不能修改）") };
	const doctrine: SentinelDoctrine = existing
		? { ...existing, name, text }
		: {
				id: `doctrine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				name,
				text,
				builtin: false,
			};
	writeCustom(
		agentDir,
		existing ? custom.map((item) => (item.id === doctrine.id ? doctrine : item)) : [...custom, doctrine],
	);
	return { doctrine };
}

export function deleteDoctrine(agentDir: string, id: string): { ok: boolean; error?: string } {
	const custom = readCustom(agentDir);
	if (!custom.some((item) => item.id === id)) return { ok: false, error: t("该思路不存在（内置思路不能删除）") };
	writeCustom(
		agentDir,
		custom.filter((item) => item.id !== id),
	);
	return { ok: true };
}
