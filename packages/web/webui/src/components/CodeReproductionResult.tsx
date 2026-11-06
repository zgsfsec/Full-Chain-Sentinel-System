import { Alert, Button, Descriptions, Modal, Space, Tag, Tooltip, Typography } from "antd";
import { useState } from "react";
import { parseCodeReproductionResult } from "../../../src/code-reproduction.ts";
import { reproductionRecovery, reproductionView, type ReproductionView } from "../code-reproduction.ts";
import { getLanguage, t } from "../i18n.ts";
import type { SentinelCodeCommit, SentinelEngine } from "../types.ts";
import { MarkdownText } from "./MessageView.tsx";

const { Paragraph, Text } = Typography;

function resultLabel(outcome: ReproductionView["outcome"]): string {
	const labels = getLanguage() === "en"
		? { pending: "Not started", running: "In progress", paused: "Paused", confirmed: "Confirmed", not_reproduced: "Not reproduced", inconclusive: "Insufficient evidence", failed: "Execution failed", unreviewed: "Needs review" }
		: { pending: "未复现", running: "复现中", paused: "已暂停", confirmed: "确认存在", not_reproduced: "未能复现", inconclusive: "证据不足", failed: "执行失败", unreviewed: "待确认" };
	return labels[outcome];
}

export function CodeReproductionResult({ commit, engine }: { commit: SentinelCodeCommit; engine?: SentinelEngine }) {
	const result = reproductionView(commit, engine);
	if (result.outcome === "pending") return <Text type="secondary">—</Text>;
	const color = { running: "processing", paused: "gold", confirmed: "green", not_reproduced: "blue", inconclusive: "orange", failed: "red", unreviewed: "default" }[result.outcome];
	const en = getLanguage() === "en";
	const hint = result.summary || (result.outcome === "running"
		? (en ? "Reproduction is running. A conclusion will appear after verification." : "正在执行复现，验证完成后显示结论。")
		: result.outcome === "paused"
			? (en ? "Open the engineering board to resolve blockers and continue." : "请打开工程看板处理阻塞并继续。")
			: (en ? "Completion alone does not establish reproduction. Review the report and evidence." : "工程结束不代表复现成功，请查看报告与证据。"));
	return <Tooltip title={hint}><Tag color={color} tabIndex={0}>{resultLabel(result.outcome)}</Tag></Tooltip>;
}

export function CodeRecovery({ error, onOpenProject, onOpenModels }: {
	error: string;
	onOpenProject(): void;
	onOpenModels(): void;
}) {
	const en = getLanguage() === "en";
	const kind = reproductionRecovery(error);
	const hint = {
		network: en ? "Check the project proxy, DNS and GitHub connectivity, then retry." : "检查所属项目的代理、DNS 和 GitHub 连通性后重试。",
		auth: en ? "Check the monitor's GitHub token and repository permissions." : "请在监控编辑中检查 GitHub 令牌及仓库访问权限。",
		model: en ? "Check the model endpoint, credentials and quota. Continue the existing task in its engineering board." : "检查模型端点、凭据和配额；已有工程请在看板中继续任务。",
		environment: en ? "Check the project container and build dependencies. Review task commands in the engineering board." : "检查项目容器与构建依赖；在工程看板中查看失败命令。",
		inspect: en ? "Review the original error and task logs before retrying." : "请结合原始错误和任务日志定位问题后重试。",
	}[kind];
	return <Space orientation="vertical" size={8} style={{ width: "100%" }}>
		<Alert type="warning" showIcon title={hint} />
		<Space wrap>
			{kind === "network" || kind === "environment" ? <Button size="small" onClick={onOpenProject}>{en ? "Project and proxy settings" : "项目与代理设置"}</Button> : null}
			{kind === "model" ? <Button size="small" onClick={onOpenModels}>{en ? "Model settings" : "模型设置"}</Button> : null}
		</Space>
	</Space>;
}

export function CodeReproductionActions({ commit, engine, onOpenEngine }: {
	commit: SentinelCodeCommit;
	engine?: SentinelEngine;
	onOpenEngine(id: string): void;
}) {
	const [reportOpen, setReportOpen] = useState(false);
	const en = getLanguage() === "en";
	if (!commit.engineId) return null;
	return <>
		<Tooltip title={!engine ? (en ? "Engine unavailable or removed; refresh to check." : "工程暂不可用或已删除，请刷新确认。") : undefined}>
			<Button size="small" type="link" disabled={!engine} onClick={() => engine && onOpenEngine(engine.id)}>{en ? "Engineering" : "查看工程"}</Button>
		</Tooltip>
		{engine?.report ? <Button size="small" type="link" onClick={() => setReportOpen(true)}>{en ? "Report" : "查看报告"}</Button> : null}
		<Modal open={reportOpen} onCancel={() => setReportOpen(false)} width={960} title={`${en ? "Reproduction report" : "复现报告"} · ${engine?.name ?? commit.shortSha}`}
			footer={<Space wrap><Button onClick={() => engine && onOpenEngine(engine.id)}>{en ? "Engineering" : "查看工程"}</Button><Button onClick={() => setReportOpen(false)}>{t("关闭")}</Button></Space>}>
			{engine ? <CodeReproductionSummary commit={commit} engine={engine} /> : null}
			<Paragraph copyable={{ text: engine?.report ?? "" }}>{en ? "Copy report" : "复制完整报告"}</Paragraph>
			<div className="code-intel-report"><MarkdownText text={engine?.report ?? ""} /></div>
		</Modal>
	</>;
}

export function CodeReproductionSummary({ commit, engine }: { commit: SentinelCodeCommit; engine?: SentinelEngine }) {
	const en = getLanguage() === "en";
	const result = reproductionView(commit, engine);
	const evidence = engine?.status === "completed" ? parseCodeReproductionResult(engine.reproduction) : null;
	return <Descriptions size="small" column={1} items={[
		{ key: "outcome", label: en ? "Reproduction result" : "复现结果", children: <CodeReproductionResult commit={commit} engine={engine} /> },
		{ key: "summary", label: en ? "Basis" : "结论依据", children: <Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>{result.summary || (en ? "No structured conclusion yet. Review the report and evidence." : "尚无结构化结论，请查看报告与证据。")}</Paragraph> },
		...(evidence ? [
			{ key: "source", label: en ? "Source" : "结论来源", children: en ? "Engineering commander; subject to evidence review" : "工程指挥官提交，需结合证据复核" },
			...([ ["pocPath", en ? "PoC path" : "PoC 路径"], ["vulnerableEvidence", en ? "Vulnerable version" : "漏洞版本证据"], ["fixedEvidence", en ? "Fixed version" : "修复版本证据"] ] as const)
				.filter(([key]) => evidence[key]).map(([key, label]) => ({ key, label, children: <Paragraph copyable className="code-intel-evidence">{evidence[key]}</Paragraph> })),
		] : []),
	]} />;
}
