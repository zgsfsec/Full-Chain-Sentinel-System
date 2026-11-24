import { Alert, Space, Tag, Typography } from "antd";
import type {
	SentinelJudgeLoadReport,
	SentinelModelEntryView,
	SentinelModelRoleName,
	SentinelTestResult,
} from "../types.ts";
import { t } from "../i18n.ts";
import { formatMs } from "../subagent-process.ts";

const { Text } = Typography;

/** How many judgments the 守门模型 concurrency test sends at once. */
export const JUDGE_LOAD_TEST_SIZE = 10;

export const FOLLOW_MAIN = "follow-main";

export const ROLE_ORDER: SentinelModelRoleName[] = [
	"main",
	"judge",
	"reviewer",
	"supervisor",
	"commander",
	"monitor",
	"workprocess",
];

export const ROLE_LABELS: Record<SentinelModelRoleName, string> = {
	main: t("主模型"),
	judge: t("守门模型"),
	reviewer: t("漏洞评审"),
	supervisor: t("监督模型"),
	commander: t("指挥端点"),
	monitor: t("监测模型"),
	workprocess: "工作链路模型",
};

export const ROLE_HINTS: Record<SentinelModelRoleName, string> = {
	main: t("对话页的主代理；改完下次发送时生效，不打断正在跑的会话"),
	judge: t("必须使用按量付费 API；AI 审批逐条判定 bash 命令；改完立即生效"),
	reviewer: t("建议使用按量付费 API；提交漏洞后自动校准等级与 CVSS；改完立即生效"),
	supervisor: t("建议使用按量付费 API；观察模式每 20 次调用或异常时总结；介入模式只给建议，不阻断工具调用"),
	commander: t("建议使用按量付费 API；工程模式的指挥官；跟随主模型时共用主模型端点"),
	monitor: t("开源情报判断每个新提交是否为安全修复；改完下一次检查生效"),
	workprocess: "根据对话和工程记录分析目标、步骤与转向原因；每个对象单独手动开启",
};

export const ROLE_SHORT: Record<SentinelModelRoleName, string> = {
	main: t("会话默认"),
	judge: t("命令定级"),
	reviewer: t("结论复核"),
	supervisor: t("介入判断"),
	commander: t("工程指挥"),
	monitor: t("提交定级"),
	workprocess: "过程重建",
};

export const MODEL_API_OPTIONS = [
	{ id: "openai-completions", label: "OpenAI Chat Completions" },
	{ id: "openai-responses", label: "OpenAI Responses" },
	{ id: "anthropic-messages", label: "Anthropic Messages" },
	{ id: "google-generative-ai", label: "Google Generative AI" },
] as const;

export function hostOf(baseUrl: string): string {
	return baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function capabilityChips(entry: SentinelModelEntryView, limit = 3): string[] {
	const chips: string[] = [];
	if (entry.contextWindow !== null) chips.push(t("{n}k 上下文", { n: Math.round(entry.contextWindow / 1000) }));
	if (entry.reasoning) chips.push(t("思考"));
	if (entry.input.includes("image")) chips.push(t("图片"));
	if (chips.length === 0) chips.push(t("pi 默认能力"));
	return chips.slice(0, limit);
}

export interface ModelTestState {
	tone: "ok" | "bad" | "warn" | "idle";
	label: string;
}

export function testState(
	testing: boolean,
	result: SentinelTestResult | null | undefined,
): ModelTestState {
	if (testing) return { tone: "warn", label: t("测试中…") };
	if (result === undefined) return { tone: "idle", label: t("未测试") };
	if (result === null) return { tone: "bad", label: t("无响应") };
	return result.ok ? { tone: "ok", label: t("可用") } : { tone: "bad", label: t("失败") };
}

/** Hover text for a status tag: the probe's summary plus its technical detail. */
export function testDetail(result: SentinelTestResult | null | undefined): string | undefined {
	if (!result) return undefined;
	return result.detail ? `${result.message}\n${result.detail}` : result.message;
}

const TONE_COLORS: Record<ModelTestState["tone"], string> = {
	ok: "green",
	warn: "orange",
	bad: "red",
	idle: "default",
};

export function ModelStatusTag({ state, detail }: { state: ModelTestState; detail?: string }) {
	return (
		<Tag color={TONE_COLORS[state.tone]} variant="filled" title={detail}>
			{state.label}
		</Tag>
	);
}

/** What the 守门模型 concurrency test answered: null when the backend did not answer at all. */
export type JudgeLoadTestOutcome = { result: SentinelTestResult; load?: SentinelJudgeLoadReport } | null;

/** Each reason once, with how many judgments it failed: `超时 × 2、报错`. */
function counted(values: string[]): string[] {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts].map(([value, count]) => (count > 1 ? t("{text} × {count}", { text: value, count }) : value));
}

/** The concurrency test's result on the settings screen: did every judgment get through, and how fast. */
export function JudgeLoadTestReport({ outcome }: { outcome: JudgeLoadTestOutcome }) {
	if (outcome === null) {
		return (
			<Alert
				type="error"
				showIcon
				className="ui-page__alert"
				title={t("无响应")}
				description={t("没有收到测试结果，请重试。")}
			/>
		);
	}
	const { result, load } = outcome;
	const latency = load?.latencyMs
		? ` · ${t("延迟：平均 {avg}，最慢 {max}", { avg: formatMs(load.latencyMs.avg), max: formatMs(load.latencyMs.max) })}`
		: "";
	return (
		<Alert
			type={result.ok ? "success" : "error"}
			showIcon
			className="ui-page__alert"
			title={`${result.ok ? t("测试成功") : t("测试失败")} · ${result.message}`}
			description={
				load ? (
					<Space orientation="vertical" size={4}>
						<div>
							{t("成功率 {ok}/{total}", { ok: load.succeeded, total: load.concurrency})}
							{latency}
						</div>
						{result.detail ? <Text strong>{result.detail}</Text> : null}
						{load.failures.length > 0 ? <div>{t("失败原因")}：{counted(load.failures).join("；")}</div> : null}
					</Space>
				) : (
					result.detail
				)
			}
		/>
	);
}

export function UsageTags({ roles }: { roles: SentinelModelRoleName[] }) {
	if (roles.length === 0) return <Tag variant="filled">{t("未使用")}</Tag>;
	return (
		<>
			{roles.map((role) => (
				<Tag color={role === "main" ? "blue" : undefined} variant="filled" key={role}>
					{ROLE_LABELS[role]}
				</Tag>
			))}
		</>
	);
}
