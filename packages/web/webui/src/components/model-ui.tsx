import { Tag } from "antd";
import type {
	SentinelModelEntryView,
	SentinelModelRoleName,
	SentinelTestResult,
} from "../types.ts";
import { t } from "../i18n.ts";

export const FOLLOW_MAIN = "follow-main";

export const ROLE_ORDER: SentinelModelRoleName[] = [
	"main",
	"judge",
	"reviewer",
	"supervisor",
	"commander",
	"monitor",
];

export const ROLE_LABELS: Record<SentinelModelRoleName, string> = {
	main: t("主模型"),
	judge: t("守门模型"),
	reviewer: t("漏洞评审"),
	supervisor: t("监督模型"),
	commander: t("指挥端点"),
	monitor: t("监测模型"),
};

export const ROLE_HINTS: Record<SentinelModelRoleName, string> = {
	main: t("对话页的主代理；改完下次发送时生效，不打断正在跑的会话"),
	judge: t("AI 审批逐条判定 bash 命令；改完立即生效"),
	reviewer: t("提交漏洞后自动校准等级与 CVSS；改完立即生效"),
	supervisor: t("观察模式每 20 次调用或异常时总结；介入模式只给建议，不阻断工具调用"),
	commander: t("工程模式的指挥官；跟随主模型时共用主模型端点"),
	monitor: t("开源情报判断每个新提交是否为安全修复；改完下一次检查生效"),
};

export const ROLE_SHORT: Record<SentinelModelRoleName, string> = {
	main: t("会话默认"),
	judge: t("命令定级"),
	reviewer: t("结论复核"),
	supervisor: t("介入判断"),
	commander: t("工程指挥"),
	monitor: t("提交定级"),
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
