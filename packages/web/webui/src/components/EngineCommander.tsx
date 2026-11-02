import { Badge, Empty, Typography } from "antd";
import { useEffect, useMemo, useRef } from "react";
import { commanderEntries } from "../commander-process.ts";
import { t } from "../i18n.ts";
import { formatMs, toolSummary } from "../subagent-process.ts";
import type { SentinelEngine, SentinelProjectInfo, SentinelSubagentEvent } from "../types.ts";
import { CommanderComposer } from "./EngineCommanderComposer.tsx";
import { MarkdownText } from "./MessageView.tsx";

const { Text } = Typography;

const STATUS_LABELS: Record<SentinelEngine["status"], string> = {
	running: t("执行中"),
	completed: t("已完成"),
	paused: t("已暂停"),
	scheduled: t("等待开始"),
	stopped: t("已终止"),
};

function clock(at: number): string {
	return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

export function CommanderFeed({
	engineId,
	status,
	project,
	events,
	onSend,
}: {
	engineId: string;
	status: SentinelEngine["status"];
	project: SentinelProjectInfo | null;
	events: SentinelSubagentEvent[];
	onSend: (message: unknown) => void;
}) {
	const feed = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const entries = useMemo(() => commanderEntries(events), [events]);
	useEffect(() => {
		if (feed.current && follow.current) feed.current.scrollTop = feed.current.scrollHeight;
	}, [entries]);
	return (
		<section className="engine-commander" aria-label={t("指挥官")}>
			<div className="engine-workspace__panel-head">
				<Text strong>{t("指挥官")}</Text>
				<Badge
					status={status === "running" ? "processing" : status === "completed" ? "success" : "default"}
					text={STATUS_LABELS[status]}
				/>
			</div>
			<div
				ref={feed}
				className="engine-commander__stream"
				aria-live="polite"
				onScroll={() => {
					const element = feed.current;
					if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
				}}
			>
				{entries.length === 0 ? (
					<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("指挥官还没有动作。")} />
				) : null}
				{entries.map((entry) => {
					if (entry.kind === "tool") {
						const { start, end } = entry;
						const name = start.toolName ?? end?.toolName ?? t("工具调用");
						const pending = !end;
						const duration = end ? (end.durationMs ?? (start === end ? undefined : end.at - start.at)) : undefined;
						const summary = toolSummary(
							name,
							start.args,
							end?.output ?? "",
							pending ? "running" : end.isError ? "error" : "done",
						);
						return (
							<details key={start.seq} className="engine-commander__process">
								<summary>
									<time className="engine-commander__time">{clock(start.at)}</time>
									<span className="engine-commander__tool" title={name}>
										{name}
									</span>
									<span className="engine-commander__preview" title={summary}>
										{summary || "—"}
									</span>
									<span className={end?.isError ? "engine-commander__result is-error" : "engine-commander__result"}>
										{pending ? (status === "running" ? t("执行中") : t("未完成")) : end.isError ? t("失败") : t("成功")}
									</span>
									{duration !== undefined ? (
										<span className="engine-commander__duration">{formatMs(duration)}</span>
									) : null}
								</summary>
								<div className="engine-commander__details">
									{start.args !== undefined ? (
										<div>
											<Text type="secondary">{t("参数")}</Text>
											<pre>{typeof start.args === "string" ? start.args : JSON.stringify(start.args, null, 2)}</pre>
										</div>
									) : null}
									{end ? (
										<div>
											<Text type="secondary">{t("结果")}</Text>
											<pre>{end.output || t("（无输出）")}</pre>
											{end.truncated ? <Text type="secondary">{t("输出已截断")}</Text> : null}
										</div>
									) : null}
								</div>
							</details>
						);
					}
					const { event } = entry;
					if (event.kind === "thinking") {
						return (
							<details key={event.seq} className="engine-commander__process">
								<summary>
									<time className="engine-commander__time">{clock(event.at)}</time>
									<span>{t("思考")}</span>
									<span className="engine-commander__preview">
										{t("{count} 字", { count: (event.text ?? "").length })}
									</span>
								</summary>
								<div className="engine-commander__details">
									<MarkdownText text={event.text ?? ""} />
								</div>
							</details>
						);
					}
					if (event.kind === "text") {
						return (
							<div
								key={event.seq}
								className={
									event.from === "operator" ? "engine-commander__message is-operator" : "engine-commander__message"
								}
							>
								<div className="engine-commander__meta">
									<span>{event.from === "operator" ? t("你") : t("指挥官")}</span>
									<time>{clock(event.at)}</time>
								</div>
								{event.from === "operator" ? <div className="engine-commander__operator-text">{event.text}</div> : <MarkdownText text={event.text ?? ""} />}
							</div>
						);
					}
					return (
						<div
							key={event.seq}
							className={event.status === "error" ? "engine-commander__note is-error" : "engine-commander__note"}
						>
							{event.note ?? event.status ?? ""}
						</div>
					);
				})}
			</div>
			<CommanderComposer key={`${engineId}:${project?.id ?? "no-project"}`} status={status} project={project} onSubmit={(text) => {
				onSend({ type: "engine_steer_commander", id: engineId, text });
				follow.current = true;
			}} />
		</section>
	);
}
