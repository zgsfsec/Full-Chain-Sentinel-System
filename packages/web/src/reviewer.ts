/**
 * The vulnerability reviewer: a dedicated LLM that calibrates every fresh
 * finding's CVSS metrics, and flags records whose evidence does not support the
 * claimed conclusion (hallucination suspects). The score and the five-level
 * label are derived from those metrics in `cvss.ts`, never written by the model.
 *
 * It lives entirely at the hub layer: submissions still land instantly with
 * the agent's own rating, the review happens asynchronously through a serial
 * queue, and the main agent never sees or waits for any of it. The verdict
 * overwrites severity/CVSS only while the record is still pending and no
 * operator has touched it — after that the machine defers to the human, except
 * when the operator asks for a re-review by hand.
 *
 * The endpoint is the commander's dedicated configuration when present,
 * otherwise the main endpoint: one more "dedicated model" slot without a
 * third settings page.
 */

import { type AuxiliaryModelConfig, completeAuxiliaryModel, resolveAuxiliaryModel } from "./auxiliary-model.ts";
import {
	applyCapabilityLimits,
	type CvssMetrics,
	capMetricsToScore,
	cvssBaseScore,
	cvssVector,
	DUBIOUS_MAX_SCORE,
	parseCvssMetrics,
	type ReviewCapabilities,
} from "./cvss.ts";
import { t } from "./i18n.ts";
import { readModelLibrary } from "./model-library.ts";
import type { SentinelVulnerability } from "./protocol.ts";
import { severityForCvss, type VulnerabilityStore } from "./vulnerabilities.ts";

/**
 * What the reviewer is asked to produce. It judges the eight metrics and the
 * evidence, and never a number: `cvss.ts` turns the metrics into the score and
 * the five-level label.
 */
export interface ReviewVerdict {
	metrics: CvssMetrics;
	/** What the attacker can actually do, when the model answered the four questions. */
	capabilities?: ReviewCapabilities;
	/** true when the evidence does not support the claimed finding. */
	dubious: boolean;
	reason: string;
}

/** How much of each field reaches the reviewer; packets can be huge. */
const PACKET_LIMIT = 6000;
const EVIDENCE_OUTPUT_LIMIT = 1500;
const TEXT_LIMIT = 2000;
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * The reviewer's instructions.
 *
 * Exported so a test can assert the rubric is still there: the metrics are
 * only ever as good as the criteria the model is given, and a rubric that
 * quietly loses a line is how the ratings drift high again.
 *
 * The output section deliberately carries no example tuple. A concrete example
 * is a magnet: with one in place, 14 of 25 real findings came back with the
 * example's exact vector, and every uncertain finding turned into a 9.8.
 * Describing the shape in words leaves the model to judge each record.
 */
export const REVIEWER_SYSTEM_PROMPT = `你是一名严谨的漏洞评审员。渗透测试代理提交了一条漏洞记录，你负责按 CVSS v3.1 基准指标给出可复现、可解释的定级，并审查证据是否支撑结论。

提交者的描述与结论只是一条待核对的声明，不是事实。提交者说"危害很大"不构成调高的理由，说"影响有限"也不构成调低的理由；一切以证据为准，逐项重新判断。

一、先回答四个能力问题

先把"这个漏洞实际能做到什么"说清楚，再谈定级。四个问题都要能在证据里找到依据，判断标准是"这个漏洞本身具备什么能力"，不是"证据当场演示了哪一步"，也不是"这个漏洞听起来严不严重"。

1. read（机密性影响有多大：拿到了什么，或者破坏了哪层保护）
   - none：既拿不到任何数据，也没有破坏任何保护措施，只有版本号、报错栈、目录名、接口路径这类指纹信息。
   - partial：能拿到一部分数据，或者破坏了一部分保护措施——弱加密模式、缺少安全响应头、验证码可绕过、用户名可枚举、越权读到单条他人的普通记录、受害者页面上的一小块数据，都算 partial。
   - total：能拿到关键机密或全部业务数据，或者完全接管了身份认证——整库数据、他人隐私数据、配置里的口令密钥、令牌、会话 cookie、绕过认证后拿到的管理员身份，都算 total。
2. write（能不能改动数据或让状态发生变化）
   - true：能写库、删数据、改配置、传文件，或者能以他人身份发请求改动业务状态、接管他人账号与权限。接管了管理员账号就是 true——管理员能改的全都能改。
   - false：只能看，改不了任何东西。
3. down（能不能让服务不可用或数据被破坏）
   - true：能崩溃、删库、占满资源、让服务拒绝服务。能执行系统命令或任意代码时按 true 算。
   - false：不会让服务不可用。改数据不等于让服务不可用，能改数据但服务照常跑就是 false。
4. cross（影响会不会跳到别的安全域）
   - true：从 Web 应用跳到它管理的内网系统、数据库、云元数据、宿主机，或能操作另一个安全主体。
   - false：影响都在同一个安全域内。同一个应用里跨租户读数据、同一台机器上换了个应用，都算 false。

"证据不足以证明影响"和"这个漏洞没有影响"是两回事，不要混用：
- 只有配置声明、只有权限声明、只有构造请求而没有实际利用结果，证据撑不住结论——这时判 dubious=true 并在 reason 里写清缺什么，不要用 read=none 来代替"证据不足"。存疑的记录会被封顶到中危并标出来，比给一个说不清理由的分数好。
- 证据确实说明了漏洞的能力，就按能力判：能注入命令就是能执行命令，read=total、write=true、down=true。

二、指标判定

AV 攻击向量：N=网络 / A=相邻 / L=本地 / P=物理。只要能用网络请求打到就是 N；渗透测试场景下评估者已在目标网络内，不因为"目标在内网或容器里"而降级。

AC 攻击复杂度：L=低（任何人按步骤直接利用）/ H=高（需要竞态、特定时序或超出攻击者控制的环境条件才触发）。默认 L。

PR 所需权限：N=无（不需要任何凭据，未登录即可利用）/ L=低（需要任意普通账号）/ H=高（需要目标系统的高权限账号，如管理员）。
判断依据是"利用时手里拿着什么凭据"，不是"这个漏洞危不危险"：
- 只读业务接口（订单、报表、导出）即使需要登录，通常是 L。
- 后台管理接口需要管理员登录，通常是 H。
- 完全未登录即可触发的才是 N。
"已经拿到了一个会话"不等于权限要求低：PR 说的是攻击者手里那个账号的权限级别，不是他有没有会话。
把 L 或 H 误判成 N 是最容易犯也最贵的错误，它会让 exploitability 高出三成。

UI 用户交互：N=无（攻击者自己发请求就能完成）/ R=需要（要靠受害者点击、浏览或执行）。
只有存储型/反射型 XSS、需要诱导点击、CSRF 这类才算 R；UI=R 时必须联动降影响——攻击者拿不到受害者数据时，机密性最多给 L。

C/I/A/S 要和第一问的答案一致，不要凭"危害大"自己另判：
- C 机密性：read=none → N；read=partial → L；read=total → H。指纹信息本身不是机密，够不上一个漏洞。
- I 完整性：write=false → N；write=true → H。SQL 注入能否读也能写，看证据里有没有 UNION 这类联合查询，只有布尔盲注、报错注入就是只读，I 取 N。
- A 可用性：down=false → N；down=true → H。RCE、任意文件写入这类真正能执行系统命令或改写文件的，C=I=A=H。
- S 影响范围：cross=false → U；cross=true → C。S 与"危害大"无关，数据只在本系统里读写一律 U。
- XSS：脚本在受害者浏览器里执行，能读页面数据、能冒用受害者身份发请求，所以 C 至少 L；只有攻击者只能触发自己（自反射）时才取 N。I、A 一般为 N，除非能持久化写入或让服务不可用。
- 认证绕过、弱口令、拿到管理员令牌、提权这类：攻击者拿到的是完整的管理员权限，read=total、write=true，按漏洞本身的能力判，不按 PoC 当场演示了哪一步。能不能让服务不可用仍按证据，没有就 down=false。

三、证据审查
先把给的证据读完再判断：响应体、命令输出、回显结果往往就在报文里，不要因为描述写得笼统、报文格式不完整就判存疑。
只依据给你的证据（原始数据包、命令与输出、复现步骤）判断结论是否被支撑：
- 证据确实找不到、输出与结论不符、关键主张无佐证、描述与数据自相矛盾时，判 dubious=true，并在 reason 里写清具体缺口（缺哪一次对照请求、缺哪个字段、缺哪条命令输出）。
- 证据支撑得住结论就判 dubious=false。
- 存疑就说存疑，不要脑补补齐。

四、输出
分数和等级由程序按 CVSS v3.1 公式从你给的指标算出，你不要给分数。严格输出 JSON（不要 markdown 代码块、不要多余文字）。
输出一个 JSON 对象，字段为 av、ac、pr、ui、s、c、i、a（各取上面列出的字母）、read（none/partial/total）、write（true/false）、down（true/false）、cross（true/false）、dubious（布尔）与 reason（中文一句话到三句）。每一个指标都要按本条记录的证据单独判断。`;

function clip(value: string | undefined, limit: number): string {
	if (!value) return "（无）";
	const trimmed = value.trim();
	return trimmed.length > limit ? `${trimmed.slice(0, limit)}…（截断）` : trimmed;
}

/** Exported for tests: the exact material the reviewer model is shown. */
export function buildUserPrompt(vuln: SentinelVulnerability): string {
	const evidence = vuln.evidence
		.map(
			(item, index) =>
				`证据 ${index + 1}：${item.kind === "command" ? "命令" : "文件"}${item.command ? `\n  命令：${clip(item.command, TEXT_LIMIT)}` : ""}${item.output ? `\n  输出：${clip(item.output, EVIDENCE_OUTPUT_LIMIT)}` : ""}${item.path ? `\n  文件：${item.path}` : ""}`,
		)
		.join("\n");
	return [
		`标题：${clip(vuln.title, 300)}`,
		`目标：${vuln.target}`,
		`类型：${vuln.category ?? "未分类"}`,
		`来源：${vuln.source}`,
		"",
		`漏洞描述：${clip(vuln.description, TEXT_LIMIT)}`,
		"",
		`原始数据包：\n${clip(vuln.packet, PACKET_LIMIT)}`,
		"",
		`证据列表：\n${evidence || "（无）"}`,
		"",
		vuln.repro ? `复现步骤：\n${clip(vuln.repro, TEXT_LIMIT)}` : "复现步骤：（无）",
		"",
		"请给出评审 JSON。",
	].join("\n");
}

/**
 * The four capability answers, in whatever shape the model wrote them.
 *
 * They are optional: a reply that leaves them out is still a usable verdict,
 * it just does not get the clip. A partial or malformed answer is dropped as a
 * whole rather than applied in pieces, because half a capability set would
 * clip axes it says nothing about.
 */
function parseCapabilities(parsed: Record<string, unknown>): ReviewCapabilities | undefined {
	const nested = parsed.capabilities ?? parsed.cap;
	const source =
		nested && typeof nested === "object" && !Array.isArray(nested)
			? { ...parsed, ...(nested as Record<string, unknown>) }
			: parsed;
	const readRaw = typeof source.read === "string" ? source.read.trim().toLowerCase() : "";
	const read: ReviewCapabilities["read"] | undefined =
		readRaw === "none"
			? "none"
			: readRaw === "partial" || readRaw === "some" || readRaw === "limited"
				? "partial"
				: readRaw === "total" || readRaw === "full" || readRaw === "all"
					? "total"
					: undefined;
	const flag = (key: string): boolean | undefined => {
		const value = source[key];
		if (value === true || value === false) return value;
		if (value === "true") return true;
		if (value === "false") return false;
		return undefined;
	};
	const write = flag("write");
	const down = flag("down");
	const cross = flag("cross");
	if (!read || write === undefined || down === undefined || cross === undefined) return undefined;
	return { read, write, down, cross };
}

/** Pull the JSON object out of a model reply that may carry fences or prose. */
export function parseVerdict(raw: string): ReviewVerdict {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) throw new Error(t("回复中没有 JSON 对象"));
	const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
	// Some models nest the metrics one level down, under their own key.
	const nested = parsed.metrics;
	const source =
		nested && typeof nested === "object" && !Array.isArray(nested)
			? { ...parsed, ...(nested as Record<string, unknown>) }
			: parsed;
	const metrics = parseCvssMetrics(source);
	if (typeof parsed.dubious !== "boolean")
		throw new Error(t("dubious 无效：{value}", { value: String(parsed.dubious) }));
	const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
	if (!reason) throw new Error(t("reason 为空"));
	const capabilities = parseCapabilities(parsed);
	return { metrics, ...(capabilities ? { capabilities } : {}), dubious: parsed.dubious, reason };
}

async function callReviewer(config: AuxiliaryModelConfig, vuln: SentinelVulnerability): Promise<ReviewVerdict> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const reply = await completeAuxiliaryModel(config, {
			systemPrompt: REVIEWER_SYSTEM_PROMPT,
			input: buildUserPrompt(vuln),
			signal: controller.signal,
			json: true,
		});
		if (!reply.content.trim()) throw new Error(t("端点返回了空回复"));
		return parseVerdict(reply.content);
	} finally {
		clearTimeout(timer);
	}
}

/** Fires whenever a review settles, so consoles and notifications refresh. */
export interface ReviewerHooks {
	onSettled(vuln: SentinelVulnerability | undefined): void;
}

export class VulnReviewer {
	private readonly store: VulnerabilityStore;
	private readonly hooks: ReviewerHooks;
	private readonly agentDir: string;
	/** Pending work; `force` marks an operator-requested re-review of a settled record. */
	private readonly queue: Array<{ id: string; force: boolean }> = [];
	private draining = false;
	/** The model call; public and mutable so tests can stub it. */
	call: (config: AuxiliaryModelConfig, vuln: SentinelVulnerability) => Promise<ReviewVerdict>;

	constructor(store: VulnerabilityStore, hooks: ReviewerHooks, agentDir: string) {
		this.store = store;
		this.hooks = hooks;
		this.agentDir = agentDir;
		this.call = callReviewer;
	}

	/**
	 * Re-enqueue records that were queued when a previous process died. Skipped
	 * entirely while automatic review is off: nothing should be judged then.
	 */
	recover(): void {
		if (!readModelLibrary(this.agentDir).reviewerAuto) return;
		for (const id of this.store.queuedReviewIds()) this.enqueue(id);
	}

	enqueue(vulnId: string, force = false): void {
		const queued = this.queue.find((item) => item.id === vulnId);
		if (queued) {
			// A forced request must not be downgraded by one already waiting.
			if (force) queued.force = true;
			return;
		}
		this.queue.push({ id: vulnId, force });
		void this.drain();
	}

	/** Manual retry from the hub page: a failed review requeues. */
	retry(vulnId: string): { ok: boolean; error?: string } {
		if (!this.store.requeueReview(vulnId)) {
			return { ok: false, error: t("该记录无法重试（未评审失败、正在评审中，或已被操作员处理）") };
		}
		this.enqueue(vulnId);
		return { ok: true };
	}

	/**
	 * Operator-requested re-review of a settled record. Unlike the automatic
	 * pass this overwrites whatever the record holds now, including a rating the
	 * operator edited by hand, so the timeline records it as a manual re-review.
	 */
	requeue(vulnId: string): { ok: boolean; error?: string } {
		if (!this.store.requeueReview(vulnId, true)) {
			return { ok: false, error: t("该记录正在评审中") };
		}
		this.enqueue(vulnId, true);
		return { ok: true };
	}

	/** Bulk forced re-review, for every id the operator's console handed over. */
	requeueAll(vulnIds: string[]): number {
		let queued = 0;
		for (const id of vulnIds) {
			if (this.store.requeueReview(id, true)) {
				this.enqueue(id, true);
				queued += 1;
			}
		}
		return queued;
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const item = this.queue.shift();
				if (!item) break;
				await this.reviewOne(item.id, item.force);
			}
		} finally {
			this.draining = false;
		}
	}

	private async reviewOne(id: string, force: boolean): Promise<void> {
		const config = resolveAuxiliaryModel(this.agentDir, "reviewer");
		const vuln = this.store.get(id);
		// Re-check arbitration at execution time: the operator may have acted
		// while the record sat in the queue.
		if (!vuln || vuln.review.state !== "queued" || (vuln.status !== "pending" && !force)) return;
		if (!config) {
			this.store.markReviewFailed(id, t("未配置模型端点，无法评审"));
			this.hooks.onSettled(this.store.get(id));
			return;
		}
		try {
			const verdict = await this.call(config, vuln);
			// The capability answers clip the axes the model's own judgement
			// inflated — an impact the evidence does not support is taken back
			// before the score is computed, so the number and the vector still
			// describe the same thing.
			const limited = verdict.capabilities
				? applyCapabilityLimits(verdict.metrics, verdict.capabilities)
				: verdict.metrics;
			const capabilityClipped = cvssVector(limited) !== cvssVector(verdict.metrics);
			// A finding the evidence did not support never climbs into the high or
			// critical bucket: the impact axes give way until the score fits, and
			// the vector is rewritten to match, so the number on the record and
			// the vector beside it never disagree.
			const metrics = verdict.dubious ? capMetricsToScore(limited, DUBIOUS_MAX_SCORE) : limited;
			const dubiousCapped = cvssVector(metrics) !== cvssVector(limited);
			// The model picks the metrics; the score and the five-level label are
			// derived here so they can never disagree with the vector.
			const cvss = cvssBaseScore(metrics);
			const notes: string[] = [];
			if (capabilityClipped) {
				// Say which axes gave way: a lowered number the operator cannot
				// trace is a number they will not trust.
				const axes: string[] = [];
				for (const axis of ["c", "i", "a", "s"] as const) {
					if (verdict.metrics[axis] !== limited[axis]) {
						axes.push(`${axis.toUpperCase()}:${verdict.metrics[axis]}→${limited[axis]}`);
					}
				}
				notes.push(t("影响指标已按实际能力下调（{axes}）", { axes: axes.join(t("，")) }));
			}
			if (dubiousCapped) notes.push(t("证据不足，影响指标已按中危上限下调"));
			const reason =
				notes.length > 0
					? `${verdict.reason}${t("（{notes}，最终 {score} 分）", { notes: notes.join(t("；")), score: cvss.toFixed(1) })}`
					: verdict.reason;
			const updated = this.store.applyReview(
				id,
				{
					severity: severityForCvss(cvss),
					cvss,
					cvssVector: cvssVector(metrics),
					dubious: verdict.dubious,
					reason,
					model: config.modelId,
				},
				force,
			);
			this.hooks.onSettled(updated ?? undefined);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.store.markReviewFailed(id, message);
			this.hooks.onSettled(this.store.get(id));
		}
	}
}
