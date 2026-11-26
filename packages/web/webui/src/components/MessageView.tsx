import { BranchesOutlined, ExpandOutlined, SafetyOutlined } from "@ant-design/icons";
import { Button, Collapse, Space, Tag, Typography } from "antd";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { t } from "../i18n.ts";
import { formatTokens, textFromContent } from "../transcript.ts";
import type { AgentMessageView, ContentBlockView } from "../types.ts";
import { ToolCard } from "./ToolCard.tsx";
import "./process.css";

const { Text } = Typography;

/** Markdown renderer for model output; raw HTML is never rendered. */
export function MarkdownText({ text }: { text: string }) {
	return (
		<div className="markdown-body">
			<Markdown
				remarkPlugins={[remarkGfm]}
				components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
			>
				{text}
			</Markdown>
		</div>
	);
}

function blockText(block: ContentBlockView): string {
	if (typeof block !== "object" || block === null) return "";
	if (block.type === "text") return (block as { text: string }).text;
	return "";
}

/** Image attachments stored on a user message, rendered from their base64 payload. */
function messageImages(content: unknown): { data: string; mimeType: string }[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(block): block is { type: "image"; data: string; mimeType: string } =>
			typeof block === "object" &&
			block !== null &&
			(block as { type?: string }).type === "image" &&
			typeof (block as { data?: unknown }).data === "string",
	);
}

export function formatTime(timestamp?: number): string {
	if (!timestamp) return "";
	return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * One operator entry: a prompt line with a marker, the way a console echoes
 * input. No avatar, no bubble, no role tag.
 */
function OperatorEntry({
	timestamp,
	action,
	children,
}: {
	timestamp?: number;
	action?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div className="entry entry--operator">
			<span className="entry__mark">&gt;</span>
			<div className="entry__body">
				{children}
				{timestamp || action ? (
					<div className="entry__footer">
						{timestamp ? (
							<Text type="secondary" className="entry__time">
								{formatTime(timestamp)}
							</Text>
						) : null}
						{action}
					</div>
				) : null}
			</div>
		</div>
	);
}

/** One agent entry: plain prose in the flow, with a quiet role tag and timestamp. */
export function AgentEntry({
	subagent,
	timestamp,
	children,
}: {
	subagent?: boolean;
	timestamp?: number;
	children: React.ReactNode;
}) {
	return (
		<div className={subagent ? "entry entry--agent is-sub" : "entry entry--agent"}>
			<span className="entry__gutter">
				<Tag color={subagent ? "purple" : "blue"} variant="filled">
					{subagent ? "SA" : "AI"}
				</Tag>
			</span>
			<div className="entry__body">
				{children}
				{timestamp ? (
					<Text type="secondary" className="entry__time">
						{formatTime(timestamp)}
					</Text>
				) : null}
			</div>
		</div>
	);
}

/** Turn common provider/endpoint failures into an actionable Chinese hint. */
function hintForError(message: string): string {
	if (/502|upstream/i.test(message)) {
		return t(
			"端点网关连不上上游模型服务：检查中转渠道是否被禁用、上游服务是否存活。可用「设置 → 模型 → 测试连接」验证。",
		);
	}
	if (/401|403|unauthorized|api key|authentication/i.test(message)) {
		return t("认证失败：检查 API Key 是否有效，或在「设置 → 模型」中重新填写。");
	}
	if (/404|not found/i.test(message)) {
		return t("路径或模型不存在：确认 Base URL 以 /v1 结尾、模型 ID 拼写正确。");
	}
	if (/429|rate limit|quota/i.test(message)) {
		return t("限流或额度不足：稍后重试，或检查端点的令牌额度。");
	}
	if (/timeout|timed out|econnrefused|enotfound|fetch failed|network/i.test(message)) {
		return t("网络问题：确认端点地址可达、服务已启动。可用「设置 → 模型 → 测试连接」定位。");
	}
	if (/context|token limit|too long/i.test(message)) {
		return t("上下文超限：先压缩会话（输入 /compact 或点击「压缩上下文」）后重试。");
	}
	return t("运行失败：可重试；持续失败请用「设置 → 模型 → 测试连接」检查端点。");
}

/**
 * A goal round boundary: the opening contract renders as a distinct start
 * block; every automatic continuation renders as a centered badge divider
 * （迭代 N · 轮 N/Y · 上轮耗时） so a whole goal reads as one continuous
 * conversation instead of a sequence of "new sessions". Both expand to the
 * full contract text for auditing.
 */
function GoalMarker({ text, timestamp, elapsedMs }: { text: string; timestamp?: number; elapsedMs?: number }) {
	const started = text.startsWith("【持续目标已启动】");
	const objective = started ? /^目标（来自操作员）：(.+)$/m.exec(text)?.[1] : undefined;
	const limit = started ? /自动续跑上限为 (\d+) 轮/.exec(text)?.[1] : undefined;
	const round = started ? null : /第 (\d+)\/(\d+) 轮/.exec(text);
	const iteration = round?.[1] ?? "?";
	const roundLimit = round?.[2] ?? "?";

	return (
		<Collapse
			ghost
			size="small"
			className="goalmark"
			items={[
				{
					key: "contract",
					label: started ? (
						<Space size={8} wrap>
							<Tag color="blue" variant="filled">
								{t("持续目标已启动")}
							</Tag>
							<Text type="secondary">
								{objective ? t("目标：{objective}", { objective }) : t("见合约")}
								{limit ? t(" · 轮数上限 {limit}", { limit }) : ""}
							</Text>
						</Space>
					) : (
						<Space size={8} wrap>
							<Tag color="geekblue" variant="filled">
								{t("迭代")} {iteration}
							</Tag>
							<Text type="secondary">
								{t("轮")} {iteration}/{roundLimit}
								{elapsedMs !== undefined ? ` · ${formatDurationShort(elapsedMs)}` : ""}
								{timestamp ? ` · ${formatTime(timestamp)}` : ""}
							</Text>
						</Space>
					),
					children: <pre className="goalmark__body">{text}</pre>,
				},
			]}
		/>
	);
}

/** Compact mm:ss / h 小时 m 分 for badge metadata. */
function formatDurationShort(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return t("{seconds} 秒", { seconds: totalSeconds });
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return t("{minutes} 分 {seconds} 秒", { minutes, seconds: totalSeconds % 60 });
	return t("{hours} 时 {minutes} 分", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/**
 * One settled step of an expanded run, 方案 B 单行手风琴: time · tool · argument
 * summary · duration on one line, the output hidden until the row is clicked.
 * This is the compact shape that keeps a 100-step run scannable; the streaming
 * run keeps full ToolCards instead.
 */
function StepRow({
	time,
	tool,
	argument,
	output,
	durationMs,
	isError,
	onFullscreen,
	viewerTitle,
}: {
	time?: number;
	tool: string;
	argument: string;
	output: string;
	durationMs?: number;
	isError?: boolean;
	onFullscreen?: (command: string | undefined, output: string) => void;
	/** Title for the shared viewer; defaults to the generic tool-output label. */
	viewerTitle?: string;
}) {
	const duration =
		durationMs !== undefined ? (durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`) : "";
	return (
		<Collapse
			ghost
			size="small"
			className={isError ? "steprow is-error" : "steprow"}
			items={[
				{
					key: "output",
					label: (
						<div className="steprow__label">
							<Text type="secondary" className="steprow__time">
								{formatTime(time) || "—"}
							</Text>
							<Tag variant="filled" className="steprow__tool">
								{tool}
							</Tag>
							<Text type="secondary" className="steprow__arg" title={argument}>
								{argument || t("(无参数)")}
							</Text>
							{duration ? (
								<Text type="secondary" className="steprow__dur">
									{duration}
								</Text>
							) : null}
							{onFullscreen && output ? (
								<Button
									type="text"
									size="small"
									icon={<ExpandOutlined />}
									aria-label={t("在查看器中打开全部内容")}
									onClick={(event) => {
										event.stopPropagation();
										onFullscreen(viewerTitle ?? (argument || undefined), output);
									}}
								/>
							) : null}
						</div>
					),
					children: (
						<div className="steprow__details">
							{argument && !viewerTitle ? (
								<div>
									<Text type="secondary">{t("参数")}</Text>
									<pre className="steprow__pre">{argument}</pre>
								</div>
							) : null}
							<div>
								<Text type="secondary">{viewerTitle ?? t("输出")}</Text>
								<pre className="steprow__pre">{output || t("（无输出）")}</pre>
							</div>
						</div>
					),
				},
			]}
		/>
	);
}

/** One folded boundary row (summary, modeling note, loop guard). */
function FoldRow({ label, warn, children }: { label: React.ReactNode; warn?: boolean; children: React.ReactNode }) {
	return (
		<Collapse
			ghost
			size="small"
			className={warn ? "foldrow is-warn" : "foldrow"}
			items={[{ key: "body", label, children, forceRender: true }]}
		/>
	);
}

/** First line of a thinking block, as the row's argument summary. */
function thinkingSummary(thinking: string): string {
	const line = thinking.split("\n").find((candidate) => candidate.trim().length > 0) ?? t("(空)");
	return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

export function MessageView({
	message,
	toolCommand,
	forkEntryId,
	onFork,
	onFullscreen,
	goalElapsedMs,
	compact,
}: {
	message: AgentMessageView;
	/** Command of the tool call this result belongs to, when the transcript has it. */
	toolCommand?: string;
	forkEntryId?: string;
	onFork?: (entryId: string) => void;
	onFullscreen?: (command: string | undefined, output: string) => void;
	/** For a goal continuation marker: how long the round it closed took. */
	goalElapsedMs?: number;
	/** 方案 B：settled run 内用单行手风琴渲染工具与思考；流式运行组保持完整卡片。 */
	compact?: boolean;
}) {
	if (message.role === "user") {
		const text = Array.isArray(message.content)
			? message.content.map(blockText).join("")
			: String(message.content ?? "");
		const images = messageImages(message.content);
		return (
			<OperatorEntry
				timestamp={message.timestamp}
				action={
					forkEntryId && onFork ? (
						<Button
							size="small"
							type="text"
							icon={<BranchesOutlined />}
							className="fork-button"
							onClick={() => onFork(forkEntryId)}
						>
							{t("从此分叉")}
						</Button>
					) : null
				}
			>
				{images.length > 0 ? (
					<div className="message-images">
						{images.map((image, index) => (
							<img
								key={index}
								src={`data:${image.mimeType};base64,${image.data}`}
								alt={t("附件 {index}", { index: index + 1 })}
								loading="lazy"
							/>
						))}
					</div>
				) : null}
				{text ? <div className="log-op-text">{text}</div> : null}
			</OperatorEntry>
		);
	}

	if (message.role === "assistant") {
		const blocks = Array.isArray(message.content) ? message.content : [];
		const thinking = blocks.filter((block) => (block as { type?: string }).type === "thinking");
		const text = blocks.map(blockText).join("");
		const failed = message.stopReason === "error" || message.stopReason === "aborted";
		const isSubagentToolCall = blocks.some(
			(block) =>
				(block as { type?: string }).type === "toolCall" && (block as { name?: string }).name === "spawn_agent",
		);
		const thinkingText = thinking.map((block) => (block as { thinking?: string }).thinking ?? "").join("\n");
		// Tool-call metadata is shown with its result; an empty AI entry only
		// inserts a timestamp and blank space between the process steps.
		if (!text && thinking.length === 0 && !failed && !message.errorMessage) return null;
		// 方案 B：只含思考、没有正文的 assistant（被中止/压缩截断的常见形态）在
		// settled run 里就是一行「思考」，不再套 AI 徽标行和折叠块。
		if (compact && thinking.length > 0 && !text) {
			return (
				<StepRow
					time={message.timestamp}
					tool={t("思考")}
					argument={thinkingSummary(thinkingText)}
					output={thinkingText}
					onFullscreen={onFullscreen}
					viewerTitle={t("思考过程")}
				/>
			);
		}
		return (
			<AgentEntry subagent={isSubagentToolCall} timestamp={message.timestamp}>
				{thinking.length > 0 ? (
					compact && text ? (
						<StepRow
							time={message.timestamp}
							tool={t("思考")}
							argument={thinkingSummary(thinkingText)}
							output={thinkingText}
							onFullscreen={onFullscreen}
							viewerTitle={t("思考过程")}
						/>
					) : (
						<FoldRow label={t("思考过程")}>
							<pre className="foldrow__pre">{thinkingText}</pre>
						</FoldRow>
					)
				) : null}
				{text ? (
					<div className={failed ? "failed" : ""}>
						<MarkdownText text={text} />
					</div>
				) : null}
				{failed && !text ? <div className="failed">{t("（本次运行失败或被中止）")}</div> : null}
				{message.errorMessage ? (
					<div className="failed">
						<div className="error-title">{message.errorMessage}</div>
						<div className="error-hint">{hintForError(message.errorMessage)}</div>
					</div>
				) : null}
			</AgentEntry>
		);
	}

	if (message.role === "toolResult") {
		const output = Array.isArray(message.content) ? message.content.map(blockText).join("") : "";
		if (compact) {
			return (
				<StepRow
					time={message.timestamp}
					tool={message.toolName}
					argument={toolCommand ?? ""}
					output={output}
					durationMs={message.durationMs}
					isError={message.isError}
					onFullscreen={onFullscreen}
				/>
			);
		}
		return (
			<ToolCard
				name={message.toolName}
				status={message.isError ? "error" : "done"}
				time={formatTime(message.timestamp)}
				durationMs={message.durationMs}
				command={toolCommand}
				output={output}
				onFullscreen={onFullscreen}
			/>
		);
	}

	if (message.role === "bashExecution") {
		if (compact) {
			return (
				<StepRow
					time={message.timestamp}
					tool="bash"
					argument={message.command}
					output={message.output}
					isError={message.exitCode !== 0 && !message.cancelled}
					onFullscreen={onFullscreen}
				/>
			);
		}
		return (
			<ToolCard
				name="! bash"
				status={message.exitCode === 0 ? "done" : "error"}
				time={formatTime(message.timestamp)}
				command={message.command}
				output={message.output}
				onFullscreen={onFullscreen}
			/>
		);
	}

	if (message.role === "compactionSummary" || message.role === "branchSummary") {
		// The row says what was summarized: the summary itself is the model's
		// context, and the transcript above the marker is what it replaced.
		const before = message.role === "compactionSummary" && message.tokensBefore ? message.tokensBefore : 0;
		return (
			<FoldRow
				label={
					<Space size={6}>
						<Text type="secondary">
							{t("会话摘要（{kind}）", {
								kind: message.role === "compactionSummary" ? t("压缩") : t("分支"),
							})}
						</Text>
						{before > 0 ? (
							<Text type="secondary">{t(" · 压缩前 {tokens} tokens", { tokens: formatTokens(before) })}</Text>
						) : null}
					</Space>
				}
			>
				<pre className="foldrow__pre">{message.summary ?? ""}</pre>
			</FoldRow>
		);
	}

	if (message.role === "custom") {
		// Goal rows are goal mode's own voice in the transcript: the contract the
		// goal started under, and the one injected for each automatic continuation.
		// They fold like a summary, because they are a boundary line between rounds
		// rather than part of what the agent said.
		if (message.customType === "zg-goal") {
			const text = textFromContent(message.content);
			return <GoalMarker text={text} timestamp={message.timestamp} elapsedMs={goalElapsedMs} />;
		}
		// Loop-guard notices: the run was cut short because the output stuttered, or a
		// tool call repeated. They are injected into the conversation like a prompt, so
		// they fold the same way, but they are not the operator's words.
		if (message.customType === "zg-loop-guard") {
			const text = textFromContent(message.content);
			const stutter = text.startsWith("【输出重复】");
			return (
				<FoldRow
					warn
					label={
						<Space size={6}>
							<Tag color={stutter ? "red" : "orange"} variant="filled">
								{stutter ? t("输出重复已中止") : t("重复工具调用提醒")}
							</Tag>
							{message.timestamp ? <Text type="secondary">{formatTime(message.timestamp)}</Text> : null}
						</Space>
					}
				>
					<pre className="foldrow__pre">{text}</pre>
				</FoldRow>
			);
		}
		// Keep the intervention visible without letting long advice interrupt the
		// timeline. The original injected text remains available on expansion.
		if (message.customType === "zg-supervisor-advice") {
			const text = textFromContent(message.content);
			const preview = text.split("\n").find((line) => line.trim() && !line.trim().startsWith("【")) ?? text;
			return (
				<details className="supervisor-advice-row">
					<summary className="supervisor-advice-row__head">
						<SafetyOutlined />
						<Text strong>{t("监督建议已介入")}</Text>
						{message.timestamp ? <Text type="secondary">{formatTime(message.timestamp)}</Text> : null}
						<span className="supervisor-advice-row__preview">{preview}</span>
						<span className="supervisor-advice-row__toggle" aria-hidden="true" />
					</summary>
					<pre>{text}</pre>
				</details>
			);
		}
		// Business-modeling rows: the briefing the button sent and the line that
		// closed the run. They fold like a summary — the operator needs the boundary
		// in the transcript, not the whole briefing in the way.
		if (message.customType === "zg-modeling") {
			const text = textFromContent(message.content);
			const closing = text.startsWith("【业务建模 · 结束】");
			return (
				<FoldRow
					label={
						<Space size={6}>
							<Tag color={closing ? "default" : "blue"} variant="filled">
								{closing ? t("业务建模已结束") : t("业务建模已启动")}
							</Tag>
							{message.timestamp ? <Text type="secondary">{formatTime(message.timestamp)}</Text> : null}
						</Space>
					}
				>
					<pre className="foldrow__pre">{text}</pre>
				</FoldRow>
			);
		}
		return null;
	}

	return null;
}
