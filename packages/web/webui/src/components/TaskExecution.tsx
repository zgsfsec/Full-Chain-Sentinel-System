import { Button, Empty, Input, Segmented, Tag, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import { buildTurns, formatMs, plainText, type Step } from "../subagent-process.ts";
import type { SentinelEngineTaskStatus, SentinelSubagentEvent } from "../types.ts";
import { MarkdownText } from "./MessageView.tsx";
import "./task-execution.css";

const { Text } = Typography;
const PAGE_SIZE = 60;
type Filter = "all" | "tools" | "errors";

export function TaskExecution({ events, status }: {
	events: SentinelSubagentEvent[];
	status: SentinelEngineTaskStatus;
}) {
	const english = getLanguage() === "en";
	const turns = useMemo(() => buildTurns(events), [events]);
	const steps = useMemo(() => turns.flatMap((turn) => turn.steps), [turns]);
	const [filter, setFilter] = useState<Filter>("all");
	const [query, setQuery] = useState("");
	const [limit, setLimit] = useState(PAGE_SIZE);
	const [follow, setFollow] = useState(true);
	const feed = useRef<HTMLDivElement>(null);
	const needle = query.trim().toLocaleLowerCase();
	const matches = steps.filter((step) => {
		if (filter === "tools" && step.kind !== "tool") return false;
		if (filter === "errors" && !(step.kind === "tool" ? step.isError : step.kind === "status" && step.status === "error")) return false;
		if (!needle) return true;
		const text = step.kind === "tool"
			? `${step.name}\n${JSON.stringify(step.args)}\n${step.output}`
			: step.kind === "status" ? step.note : step.text;
		return text.toLocaleLowerCase().includes(needle);
	});
	const visible = new Set(matches.slice(-limit).map((step) => step.seq));
	const failures = steps.filter((step) => step.kind === "tool" ? step.isError : step.kind === "status" && step.status === "error").length;
	const tools = steps.filter((step) => step.kind === "tool").length;

	useEffect(() => {
		if (feed.current && follow) feed.current.scrollTop = feed.current.scrollHeight;
	}, [events, follow]);

	return (
		<section className="task-execution" aria-label={english ? "Task execution" : "任务执行过程"}>
			<div className="task-execution__heading">
				<Text strong>{t("执行过程 · {count} 步", { count: steps.length })}</Text>
				<div className="task-execution__counts">
					<Text type="secondary">{t("{count} 个工具", { count: tools })}</Text>
					{failures > 0 ? <Text type="danger">{t("{count} 个失败", { count: failures })}</Text> : null}
				</div>
			</div>
			<div className="task-execution__toolbar">
				<Segmented<Filter>
					size="small"
					aria-label={english ? "Filter steps" : "筛选执行步骤"}
					value={filter}
					onChange={(next) => { setFilter(next); setLimit(PAGE_SIZE); }}
					options={[
						{ value: "all", label: t("全部") },
						{ value: "tools", label: t("工具调用") },
						{ value: "errors", label: t("只看失败") },
					]}
				/>
				<Input
					size="small" allowClear value={query}
					aria-label={t("搜索命令、输出…")}
					placeholder={t("搜索命令、输出…")}
					onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); }}
				/>
				<Button size="small" type={follow ? "primary" : "default"} aria-pressed={follow}
					onClick={() => setFollow((previous) => !previous)}>{t("跟随最新步骤")}</Button>
			</div>
			<div className="task-execution__feed" ref={feed} tabIndex={0}
				aria-label={english ? "Execution steps" : "执行步骤"}
				onScroll={(event) => {
					const element = event.currentTarget;
					setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 40);
				}}>
				{matches.length > limit ? (
					<Button size="small" block className="task-execution__earlier" onClick={() => {
						setFollow(false);
						setLimit((previous) => previous + PAGE_SIZE);
					}}>{english ? `Show earlier steps (${matches.length - limit})` : `查看更早的步骤（${matches.length - limit}）`}</Button>
				) : null}
				{matches.length === 0 ? (
					<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={steps.length > 0
						? t("没有匹配的步骤") : status === "queued"
							? (english ? "Waiting to start. Steps will appear here." : "任务排队中，启动后会在这里显示执行步骤。")
							: t("暂无过程记录")} />
				) : turns.map((turn) => {
					const shown = turn.steps.filter((step) => visible.has(step.seq));
					if (!shown.length) return null;
					return (
						<div key={turn.index} className="task-execution__turn">
							<div className="task-execution__round">{t("第 {round} 轮", { round: turn.index })}</div>
							{shown.map((step) => <ExecutionStep key={step.seq} step={step} running={status === "running"} />)}
						</div>
					);
				})}
			</div>
			<div className="task-execution__footnote">
				{english ? `Showing ${visible.size} of ${matches.length} matching steps` : `显示 ${visible.size} / ${matches.length} 条步骤`}
			</div>
		</section>
	);
}

function ExecutionStep({ step, running }: { step: Step; running: boolean }) {
	const time = new Date(step.at).toLocaleTimeString(getLanguage() === "en" ? "en-US" : "zh-CN", { hour12: false });
	if (step.kind === "status") {
		return <div className={step.status === "error" ? "task-execution__note is-error" : "task-execution__note"}>
			<time>{time}</time><span>{step.note}</span>
		</div>;
	}
	const tool = step.kind === "tool";
	const isError = tool && step.isError;
	const pending = tool && step.running;
	const label = tool ? step.name : step.kind === "thinking" ? t("思考") : t("Agent");
	const preview = tool ? step.summary : plainText(step.text);
	return (
		<details className={`task-execution__step${isError ? " is-error" : ""}${pending && running ? " is-running" : ""}`}>
			<summary>
				<time>{time}</time>
				<span className="task-execution__label" title={label}>{label}</span>
				<span className="task-execution__preview" title={preview}>{preview || "—"}</span>
				{tool ? <>
					{step.durationMs !== undefined ? <span className="task-execution__duration">{formatMs(step.durationMs)}</span> : null}
					<Tag color={pending ? running ? "processing" : "default" : isError ? "red" : "green"} variant="filled">
						{pending ? running ? t("执行中") : t("未完成") : isError ? t("失败") : t("成功")}
					</Tag>
				</> : <span className="task-execution__duration">{t("{count} 字", { count: step.text.length })}</span>}
			</summary>
			<div className="task-execution__detail">
				{tool ? <>
					{step.args !== undefined ? <div><Text type="secondary">{t("参数")}</Text>
						<pre>{typeof step.args === "string" ? step.args : JSON.stringify(step.args, null, 2)}</pre></div> : null}
					<div><Text type="secondary">{t("输出")}</Text>
						<pre>{step.output || (pending ? running ? t("等待输出…") : t("未完成") : t("（无输出）"))}</pre></div>
				</> : <MarkdownText text={step.text} />}
				{"truncated" in step && step.truncated ? <Text type="secondary">{t("输出已截断")}</Text> : null}
			</div>
		</details>
	);
}
