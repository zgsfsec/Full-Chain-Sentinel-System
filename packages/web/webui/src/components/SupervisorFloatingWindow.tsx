/**
 * The live supervision window, opened from the composer's 监督 button.
 *
 * A light floating card with a phase header, per-conversation mode controls,
 * and 状态 / 过程 / 日志 tabs. The global audit list lives in 工作台 → 监督.
 * Closing this window only hides it; supervision continues until 停止监督.
 */

import { ProTable } from "@ant-design/pro-components";
import { Alert, Button, Card, ConfigProvider, Popconfirm, Segmented, Space, Tabs, Tag, Typography } from "antd";
import { useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import { SUPERVISOR_STRATEGY_OPTIONS, supervisorStrategyKey, supervisorStrategyLabel } from "../supervisor-strategy.ts";
import type {
	SentinelSupervisorAdvice,
	SentinelSupervisorCall,
	SentinelSupervisorCustomStrategy,
	SentinelSupervisorEpisode,
	SentinelSupervisorLog,
	SentinelSupervisorMode,
	SentinelSupervisorStrategyRef,
	SentinelSupervisorView,
} from "../types.ts";
import "./supervisor-window.css";

const { Text } = Typography;

const PHASE_LABELS: Record<string, string> = {
	recon: t("侦察"),
	enum: t("枚举"),
	vuln_mapping: t("漏洞验证"),
	exploitation: t("利用"),
	post: t("后渗透"),
	report: t("报告"),
	unknown: t("未判断"),
};

const PROGRESS_LABELS: Record<string, string> = {
	advancing: t("有进展"),
	stalled: t("停滞"),
	looping: t("循环"),
	unknown: t("未判断"),
};

type Tab = "state" | "process" | "logs";

const ADVICE_LOG_LABELS: Record<string, string> = {
	"advice-pending": t("待确认"),
	"advice-sent": t("已发送"),
	"advice-ignored": t("已忽略"),
	"advice-skip": t("冷却跳过"),
};

function mergeLogs(first: SentinelSupervisorLog[], second: SentinelSupervisorLog[]): SentinelSupervisorLog[] {
	const seen = new Set<string>();
	const merged: SentinelSupervisorLog[] = [];
	for (const log of [...first, ...second]) {
		const key = `${log.at}-${log.kind}-${log.text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(log);
	}
	return merged.sort((left, right) => left.at - right.at);
}

function phaseLabel(value: string): string {
	return PHASE_LABELS[value] ?? value;
}

function progressLabel(value: string): string {
	return PROGRESS_LABELS[value] ?? value;
}

function progressColor(value: string): string {
	if (value === "looping") return "red";
	if (value === "stalled") return "orange";
	if (value === "advancing") return "green";
	return "default";
}

function timeLabel(at: number): string {
	return new Date(at).toLocaleTimeString(getLanguage() === "zh" ? "zh-CN" : "en-US", { hour12: false });
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function statusLabel(view: SentinelSupervisorView): string {
	if (view.status === "waiting") return t("等待开始");
	if (view.status === "stopped") return t("已停止");
	if (view.running) return t("分析中");
	return t("监督中");
}

function modeLabel(mode: SentinelSupervisorMode, delivery: "auto" | "confirm"): string {
	if (mode === "observe") return t("观察模式");
	return delivery === "auto" ? t("介入 · 自动发送") : t("介入 · 确认后发送");
}

function CallRow({ call, onOpen }: { call: SentinelSupervisorCall; onOpen: (callId: string) => void }) {
	return (
		<Button
			type="text"
			size="small"
			className="svfw-call"
			disabled={call.status === "running"}
			onClick={() => onOpen(call.callId)}
			title={call.status === "running" ? t("命令仍在运行，尚无完整输出") : t("查看完整输出")}
		>
			<Tag color={call.status === "error" ? "red" : call.status === "running" ? "blue" : "green"} variant="filled">
				{call.status === "running" ? `${call.tool} · ${t("运行中")}` : call.tool}
			</Tag>
			<Text type="secondary" ellipsis className="svfw-call__args">
				{call.args}
			</Text>
			<Text type="secondary" className="svfw-call__meta">
				{call.durationMs === null ? "" : `${Math.round(call.durationMs)}ms`}
				{call.httpStatus === null ? "" : ` · HTTP ${call.httpStatus}`}
			</Text>
		</Button>
	);
}

function AdviceCard({
	advice,
	onSend,
	onIgnore,
}: {
	advice: SentinelSupervisorAdvice;
	onSend: (id: string) => void;
	onIgnore: (id: string) => void;
}) {
	const pending = advice.status === "pending";
	return (
		<section className={pending ? "svfw-advice is-pending" : "svfw-advice"}>
			<div className="svfw-advice__head">
				<Text strong>
					{pending ? t("待确认的监督建议") : advice.status === "sent" ? t("建议已发送") : t("建议已忽略")}
				</Text>
				<Text type="secondary">{timeLabel(advice.sentAt ?? advice.at)}</Text>
			</div>
			<pre className="svfw-pre">{advice.text}</pre>
			{pending ? (
				<Space size={8}>
					<Button size="small" type="primary" onClick={() => onSend(advice.id)}>
						{t("发送给 Agent")}
					</Button>
					<Button size="small" onClick={() => onIgnore(advice.id)}>
						{t("忽略")}
					</Button>
				</Space>
			) : null}
		</section>
	);
}

function EpisodeItem({ episode }: { episode: SentinelSupervisorEpisode }) {
	return (
		<Card size="small" className="svfw-episode">
			<Space size={8} wrap>
				<Text type="secondary">{timeLabel(episode.at)}</Text>
				<Text type="secondary">{phaseLabel(episode.phase)}</Text>
				<Tag color={progressColor(episode.progress)} variant="filled">
					{progressLabel(episode.progress)}
				</Tag>
				{episode.error ? (
					<Tag color="red" variant="filled">
						{t("失败")}
					</Tag>
				) : null}
			</Space>
			<Text className="svfw-episode__intent">{episode.intent || episode.error || t("（无摘要）")}</Text>
			{episode.outcomes.length > 0 ? (
				<ul className="svfw-list">
					{episode.outcomes.slice(0, 4).map((item, index) => (
						<li key={index}>{item}</li>
					))}
				</ul>
			) : null}
		</Card>
	);
}

export function SupervisorFloatingWindow({
	view,
	episodes,
	logs,
	onHide,
	onStop,
	onRunNow,
	onSetMode,
	onSetStrategies,
	customStrategies,
	onOpenCall,
	onSendAdvice,
	onIgnoreAdvice,
}: {
	view: SentinelSupervisorView;
	episodes: SentinelSupervisorEpisode[];
	logs: SentinelSupervisorLog[];
	onHide: () => void;
	onStop: () => void;
	onRunNow: () => void;
	onSetMode: (mode: SentinelSupervisorMode, delivery: "auto" | "confirm") => void;
	onSetStrategies: (strategies: SentinelSupervisorStrategyRef[], note?: string) => void;
	customStrategies: SentinelSupervisorCustomStrategy[];
	onOpenCall: (callId: string) => void;
	onSendAdvice: (id: string) => void;
	onIgnoreAdvice: (id: string) => void;
}) {
	const [tab, setTab] = useState<Tab>("state");
	const mode = view.mode;
	const delivery = view.delivery;
	const state = view.state;
	const stopped = view.status === "stopped";
	const activeStrategies = view.strategies?.length
		? view.strategies
		: [
				{
					strategy: view.strategy,
					customStrategyId: view.strategyCustomId,
					name: view.strategyName || supervisorStrategyLabel(view.strategy),
					instructions: view.strategyInstructions,
				},
			];
	const availableForAdd = activeStrategies.filter(
		(entry) => !entry.customStrategyId || customStrategies.some((custom) => custom.id === entry.customStrategyId),
	);
	const toggleStrategy = (ref: SentinelSupervisorStrategyRef): void => {
		const key = supervisorStrategyKey(ref);
		const exists = activeStrategies.some((entry) => supervisorStrategyKey(entry) === key);
		if (exists) {
			if (activeStrategies.length <= 1) return;
			onSetStrategies(
				activeStrategies.filter((entry) => supervisorStrategyKey(entry) !== key),
				view.strategyNote,
			);
			return;
		}
		onSetStrategies([...availableForAdd, ref], view.strategyNote);
	};
	const mergedLogs = mergeLogs(view.logs, logs);
	const adviceLogs = mergedLogs.filter((log) => log.kind.startsWith("advice-")).slice(-4);

	const statePanel = (
		<div className="svfw-panel">
			{view.lastError ? (
				<Alert
					type="error"
					showIcon
					className="svfw-alert"
					title={t("最近错误：{error}", { error: view.lastError })}
				/>
			) : null}

			<Text strong className="svfw-section">
				{t("已排除 / 新证据")}
			</Text>
			<Space size={6} wrap>
				{state.deadEnds.slice(-4).map((item) => (
					<Tag key={`dead-${item}`} variant="filled" title={item}>
						{item}
					</Tag>
				))}
				{state.newEvidence.slice(-4).map((item) => (
					<Tag key={`evidence-${item}`} color="green" variant="filled" title={item}>
						{item}
					</Tag>
				))}
				{state.deadEnds.length === 0 && state.newEvidence.length === 0 ? (
					<Text type="secondary">{t("还没有排除项或新证据。")}</Text>
				) : null}
			</Space>

			{state.tested.length > 0 ? (
				<>
					<ProTable
						size="small"
						rowKey={(entry) => `${entry.target}-${entry.test}`}
						search={false}
						options={false}
						pagination={false}
						dataSource={state.tested.slice(-5).reverse()}
						toolbar={{ title: <Text strong>{t("已测试")}</Text> }}
						columns={[
							{ title: t("目标"), dataIndex: "target", key: "target", ellipsis: true },
							{ title: t("测试"), dataIndex: "test", key: "test", ellipsis: true },
							{ title: t("结果"), dataIndex: "result", key: "result", ellipsis: true },
						]}
					/>
				</>
			) : null}

			{state.nextCandidates.length > 0 ? (
				<>
					<Text strong className="svfw-section">
						{t("下一步候选")}
					</Text>
					<ul className="svfw-list">
						{state.nextCandidates.slice(0, 4).map((item, index) => (
							<li key={index}>{item}</li>
						))}
					</ul>
				</>
			) : null}

			{adviceLogs.length > 0 ? (
				<>
					<Text strong className="svfw-section">
						{t("最近介入")}
					</Text>
					<div className="svfw-advicelog">
						{adviceLogs.map((log, index) => (
							<Space key={`${log.at}-${index}`} size={8} wrap>
								<Text type="secondary">{timeLabel(log.at)}</Text>
								<Tag color={log.kind === "advice-skip" ? "orange" : undefined} variant="filled">
									{ADVICE_LOG_LABELS[log.kind] ?? log.kind}
								</Tag>
								<Text type="secondary">{log.text}</Text>
							</Space>
						))}
					</div>
				</>
			) : null}
		</div>
	);

	const processPanel = (
		<div className="svfw-panel">
			<Text strong className="svfw-section">
				{t("最近分析")}
			</Text>
			{episodes.length === 0 ? (
				<Text type="secondary">{t("暂无分析记录。每 20 次调用或发现重复、空转后会生成一条。")}</Text>
			) : (
				<div className="svfw-episodes">
					{[...episodes]
						.slice(-5)
						.reverse()
						.map((episode) => (
							<EpisodeItem key={episode.id} episode={episode} />
						))}
				</div>
			)}

			<Text strong className="svfw-section">
				{t("最近调用")}
			</Text>
			{view.recentCalls.length === 0 ? (
				<Text type="secondary">{t("还没有工具调用。")}</Text>
			) : (
				<div className="svfw-calls">
					{[...view.recentCalls]
						.slice(-10)
						.reverse()
						.map((call) => (
							<CallRow key={call.callId} call={call} onOpen={onOpenCall} />
						))}
				</div>
			)}
		</div>
	);

	const logsPanel = (
		<div className="svfw-panel">
			{mergedLogs.length === 0 ? (
				<Text type="secondary">{t("暂无日志。")}</Text>
			) : (
				<div className="svfw-logs">
					{mergedLogs.slice(-60).map((log, index) => (
						<Space
							key={`${log.at}-${index}`}
							size={8}
							className={log.kind === "error" ? "svfw-log is-bad" : "svfw-log"}
						>
							<Text type="secondary">{timeLabel(log.at)}</Text>
							<Text>{log.text}</Text>
						</Space>
					))}
				</div>
			)}
		</div>
	);

	return (
		<ConfigProvider button={{ autoInsertSpace: false }}>
			<Card
				size="small"
				className="svfw"
				title={<Text strong>{t("监督")}</Text>}
				extra={
					<Space size={8}>
						<Tag color={view.status === "running" ? "processing" : "default"} variant="filled">
							{statusLabel(view)}
						</Tag>
						<Button size="small" onClick={onHide} title={t("隐藏窗口，监督继续")}>
							{t("收起")}
						</Button>
					</Space>
				}
			>
				<Text type="secondary" className="svfw-session" title={view.sessionName}>
					{view.sessionName}
				</Text>
				<div className="svfw-summary">
					<Space size={6} wrap>
						<Tag variant="filled">{phaseLabel(state.phase)}</Tag>
						<Tag color={progressColor(state.progress)} variant="filled">
							{progressLabel(state.progress)}
						</Tag>
					</Space>
					<Text type="secondary">
						{t("{calls} 次调用 · {episodes} 轮分析", { calls: view.callCount, episodes: view.episodeCount })}
					</Text>
				</div>
				<Text type="secondary" className="svfw-intent">
					{state.intent || t("等待第一批调用…")}
				</Text>
				<details className="svfw-settings">
					<summary>
						<span>{t("监督设置")}</span>
						<Text type="secondary">{modeLabel(mode, delivery)}</Text>
					</summary>
					<div className="svfw-settings__body">
						<Space size={8} wrap className="svfw-mode">
							<Segmented
								size="small"
								value={mode === "observe" ? "observe" : delivery === "auto" ? "auto" : "confirm"}
								disabled={stopped}
								onChange={(value) => {
									if (value === "observe") onSetMode("observe", delivery);
									else if (value === "auto") onSetMode("intervene", "auto");
									else onSetMode("intervene", "confirm");
								}}
								options={[
									{ value: "observe", label: t("观察") },
									{ value: "auto", label: t("介入 · 自动") },
									{ value: "confirm", label: t("介入 · 确认") },
								]}
							/>
						</Space>
						<Space size={8} className="svfw-section">
							<Text strong>{t("监督策略")}</Text>
							<Text type="secondary">{t("{count} 个", { count: activeStrategies.length })}</Text>
						</Space>
						<Text type="secondary" className="svfw-selected">
							{activeStrategies
								.map((entry) => entry.name || supervisorStrategyLabel(entry.strategy))
								.join(" + ")}
						</Text>
						<Space size={6} wrap>
							{SUPERVISOR_STRATEGY_OPTIONS.map((option) => {
								const ref: SentinelSupervisorStrategyRef = { strategy: option.id, customStrategyId: null };
								const selected = activeStrategies.some(
									(entry) => supervisorStrategyKey(entry) === supervisorStrategyKey(ref),
								);
								return (
									<Button
										key={option.id}
										size="small"
										type={selected ? "primary" : "default"}
										disabled={stopped}
										onClick={() => toggleStrategy(ref)}
									>
										{option.label}
									</Button>
								);
							})}
							{customStrategies.map((custom) => {
								const ref: SentinelSupervisorStrategyRef = {
									strategy: custom.base,
									customStrategyId: custom.id,
								};
								const selected = activeStrategies.some(
									(entry) => supervisorStrategyKey(entry) === supervisorStrategyKey(ref),
								);
								return (
									<Button
										key={custom.id}
										size="small"
										type={selected ? "primary" : "default"}
										disabled={stopped}
										onClick={() => toggleStrategy(ref)}
									>
										{custom.name}
									</Button>
								);
							})}
							{activeStrategies
								.filter(
									(entry) =>
										entry.customStrategyId &&
										!customStrategies.some((custom) => custom.id === entry.customStrategyId),
								)
								.map((entry) => (
									<Button
										key={`deleted:${entry.customStrategyId}`}
										size="small"
										type="primary"
										danger
										disabled={stopped}
										title={t("该自定义策略已删除；点击可移除")}
										onClick={() => toggleStrategy(entry)}
									>
										{t("{name}（已删除）", { name: entry.name })}
									</Button>
								))}
						</Space>
						{view.strategyNote ? (
							<Text type="secondary" title={view.strategyNote} className="svfw-note">
								{view.strategyNote}
							</Text>
						) : null}

						<Text type="secondary" className="svfw-meta">
							{view.model?.modelId ?? t("未配置模型")} ·{" "}
							{t("监督模型 tokens {tokens}", { tokens: formatTokens(view.usage.total) })} · {view.usage.input} in
							/ {view.usage.output} out
						</Text>
					</div>
				</details>

				{view.pendingAdvice ? (
					<AdviceCard advice={view.pendingAdvice} onSend={onSendAdvice} onIgnore={onIgnoreAdvice} />
				) : null}

				<Tabs
					className="svfw-tabs"
					activeKey={tab}
					onChange={(key) => setTab(key as Tab)}
					items={[
						{ key: "state", label: t("状态"), children: statePanel, forceRender: true },
						{
							key: "process",
							label: `${t("过程")} ${episodes.length + view.recentCalls.length}`,
							children: processPanel,
							forceRender: true,
						},
						{ key: "logs", label: `${t("日志")} ${mergedLogs.length}`, children: logsPanel, forceRender: true },
					]}
				/>

				<div className="svfw-foot">
					<Button
						size="small"
						onClick={onRunNow}
						loading={view.running}
						disabled={view.status !== "running" || view.running}
					>
						{view.running ? t("分析中…") : t("立即分析")}
					</Button>
					<Popconfirm
						title={t("停止监督")}
						description={t("停止监督后，本次会话不再采集；要重新监督只能新开对话。确定停止？")}
						okText={t("停止监督")}
						okButtonProps={{ danger: true }}
						cancelText={t("取消")}
						disabled={stopped}
						onConfirm={onStop}
					>
						<Button size="small" danger disabled={stopped}>
							{t("停止监督")}
						</Button>
					</Popconfirm>
				</div>
			</Card>
		</ConfigProvider>
	);
}
