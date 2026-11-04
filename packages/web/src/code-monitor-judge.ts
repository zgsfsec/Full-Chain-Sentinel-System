/**
 * The monitor model: it reads one commit and decides whether the commit is a
 * security fix.
 *
 * The hard part is not finding the word "security" in a message; it is telling
 * a fix from ordinary hardening, refactoring and dependency noise. The prompt
 * therefore asks for evidence in the diff, and the parser accepts only a strict
 * JSON verdict so an endpoint that starts chatting cannot silently become a
 * finding.
 */

import type { GithubCommitDetail } from "./code-host.ts";
import { t } from "./i18n.ts";
import type { SentinelCodeMonitor, SentinelVulnSeverity } from "./protocol.ts";

const REQUEST_TIMEOUT_MS = 90_000;
const MESSAGE_LIMIT = 4_000;

/** The rubric. Exported so a test can assert it keeps asking for diff evidence. */
export const CODE_MONITOR_SYSTEM_PROMPT = `你是一名开源漏洞情报分析员。你会看到仓库中的一个提交（commit message + 变更文件 + diff）。你的任务是判断：这个提交是否在修复一个安全漏洞（即所谓的 1day），而不是普通的功能、重构、性能或依赖更新。

判断要求：

1. 以 diff 为主要证据，message 只作线索。message 声称"安全修复"但 diff 只是改文档、加日志、调格式，判否。
2. 安全修复的典型形态：
   - 增加或修正边界检查、长度检查、空值检查，堵住越界、整数溢出、空指针导致的崩溃或内存破坏；
   - 增加认证、授权、权限校验，或修正校验顺序，堵住认证绕过、越权；
   - 增加转义、参数化、白名单、路径规范化，堵住注入、XSS、路径穿越、SSRF、反序列化；
   - 修正竞态、释放后使用、双重释放等内存安全问题；
   - 修正加密、随机数、签名校验、证书校验的实现错误；
   - 限制资源消耗、递归深度、解压大小，堵住拒绝服务；
   - 清理硬编码凭据、令牌泄露、敏感信息回显。
3. 以下情况判否：普通 bug 修复且没有安全影响、功能新增、重构、性能优化、日志与注释、格式化、测试与 CI、版本号或依赖升级、构建配置、拼写修正。
4. 以下情况要谨慎：
   - 只改依赖版本（例如 CVE 在依赖里）但没有代码层面的适配：判否，这属于依赖升级，交给依赖扫描；
   - 提交信息含糊、diff 只是重命名变量：除非 diff 清楚地补上了一个安全边界，否则判否；
   - 无法从 diff 判断是否有安全影响时，security=false，并在 reason 里写清缺少什么证据。
5. security=true 时，尽量给出漏洞类型、受影响面与利用前提；能从 message 或 diff 得到 CVE/GHSA 编号时填写，否则 cve 为 null。severity 按"如果被利用"的影响估计：critical / high / medium / low / info；不确定时用 medium。
6. confidence 表示你对 security 判断的把握（0 到 1）。证据只够怀疑时不要给 0.9。

只输出一个 JSON 对象，不要 Markdown 代码块，不要额外解释。字段：
{
  "security": true | false,
  "confidence": 0.0-1.0,
  "cve": "CVE-2024-12345" | "GHSA-xxxx-xxxx-xxxx" | null,
  "severity": "critical" | "high" | "medium" | "low" | "info" | null,
  "vuln_type": "路径穿越" | "反序列化" | "认证绕过" | "SQL 注入" | "内存破坏" | "拒绝服务" | "信息泄露" | "其他" | null,
  "title": "一句话说明修复了什么安全问题（中文）",
  "reason": "判断依据，引用具体文件或 diff 片段（中文）"
}`;

/** What the monitor model returned, already validated. */
export interface CodeJudgeVerdict {
	security: boolean;
	confidence: number;
	cve: string | null;
	severity: SentinelVulnSeverity | null;
	vulnType: string | null;
	title: string;
	reason: string;
}

const SEVERITIES: readonly SentinelVulnSeverity[] = ["critical", "high", "medium", "low", "info"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept only ids that can be looked up later; the model likes to invent formats. */
export function normalizeAdvisoryId(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const value = raw.trim().toUpperCase();
	if (/^CVE-\d{4}-\d{4,}$/.test(value)) return value;
	if (/^GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value)) return value;
	return null;
}

/**
 * Parse the model's answer. A verdict that does not state `security` or a
 * reason is rejected rather than guessed: a failed judgment is retryable, a
 * guessed one becomes a false finding.
 */
export function parseMonitorVerdict(raw: string): CodeJudgeVerdict {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) throw new Error(t("监测模型回复里没有 JSON 对象"));
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		throw new Error(t("监测模型回复的 JSON 无法解析"));
	}
	if (!isRecord(parsed)) throw new Error(t("监测模型回复不是对象"));
	if (typeof parsed.security !== "boolean") throw new Error(t("security 字段无效"));
	const confidenceRaw = parsed.confidence;
	const confidence =
		typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
			? Math.min(1, Math.max(0, confidenceRaw))
			: 0.5;
	const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
	if (!reason) throw new Error(t("reason 为空"));
	const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
	const severityRaw = typeof parsed.severity === "string" ? parsed.severity.trim().toLowerCase() : "";
	const severity =
		parsed.security && SEVERITIES.includes(severityRaw as SentinelVulnSeverity)
			? (severityRaw as SentinelVulnSeverity)
			: null;
	const vulnTypeRaw = typeof parsed.vuln_type === "string" ? parsed.vuln_type.trim() : "";
	return {
		security: parsed.security,
		confidence,
		cve: parsed.security ? normalizeAdvisoryId(parsed.cve) : null,
		severity,
		vulnType: vulnTypeRaw || null,
		title: title || t("未命名安全修复"),
		reason,
	};
}

/** The user turn: metadata, file list and the bounded diff. */
export function buildJudgePrompt(
	monitor: Pick<SentinelCodeMonitor, "owner" | "repo" | "host">,
	commit: GithubCommitDetail,
	diff: string,
): string {
	const lines = [
		`仓库：${monitor.host}/${monitor.owner}/${monitor.repo}`,
		`提交：${commit.sha.slice(0, 12)}`,
		`作者：${commit.author}`,
		`时间：${new Date(commit.authoredAt).toISOString()}`,
		`变更规模：${commit.files.length} 个文件，+${commit.additions} -${commit.deletions}`,
		"",
		"提交信息：",
		"```",
		commit.message.slice(0, MESSAGE_LIMIT) || "(空)",
		"```",
		"",
		"变更文件：",
		...commit.files
			.slice(0, 100)
			.map((file) => `- ${file.filename} (${file.status}, +${file.additions} -${file.deletions})`),
		"",
		"Diff：",
		"```diff",
		diff || "(无文本 diff)",
		"```",
		"",
		"请按系统提示判断这是否是一个安全修复，只输出 JSON。",
	];
	return lines.join("\n");
}

interface JudgeEndpoint {
	baseUrl: string;
	apiKey: string;
	modelId: string;
}

/**
 * One judgment. Kept separate from the queue so tests can stub the transport
 * and so a slow endpoint has exactly one timeout to explain.
 */
export async function callMonitorJudge(
	config: JudgeEndpoint,
	systemPrompt: string,
	userPrompt: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: config.modelId,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt },
				],
				temperature: 0,
				response_format: { type: "json_object" },
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			const body = (await response.text().catch(() => "")).slice(0, 200);
			throw new Error(`${t("监测端点返回 {status}", { status: response.status })}${body ? `：${body}` : ""}`);
		}
		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
		};
		const content = data.choices?.[0]?.message?.content;
		const answer = Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : (content ?? "");
		if (!answer.trim()) throw new Error(t("监测端点返回了空回复"));
		return answer;
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw new Error(t("监测模型请求超时"));
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/** Full judgment: fetch text, parse it, and turn transport errors into one line. */
export async function judgeCommit(
	config: JudgeEndpoint,
	monitor: Pick<SentinelCodeMonitor, "owner" | "repo" | "host">,
	commit: GithubCommitDetail,
	diff: string,
	fetchImpl?: typeof fetch,
): Promise<CodeJudgeVerdict> {
	const raw = await callMonitorJudge(
		config,
		CODE_MONITOR_SYSTEM_PROMPT,
		buildJudgePrompt(monitor, commit, diff),
		fetchImpl,
	);
	return parseMonitorVerdict(raw);
}
