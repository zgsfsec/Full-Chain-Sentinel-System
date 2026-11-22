/**
 * The chat page's toolbar.
 *
 * Everything that governs how the session runs lives here rather than in the
 * prompt box: the execution mode, the reasoning level, branch navigation,
 * context compaction, and the approved-command prefixes. The container file
 * browser and the sub-agent monitor open from here too, as drawers, so the chat
 * page is the single entry point for working on a target.
 *
 * The bar is allowed to wrap: on a narrow window the controls stay reachable
 * instead of being clipped, and the two right-hand groups keep their order.
 */

import {
	BranchesOutlined,
	CloseOutlined,
	CodeOutlined,
	DownOutlined,
	FileOutlined,
	ScissorOutlined,
	TeamOutlined,
} from "@ant-design/icons";
import { Badge, Button, Divider, Input, Modal, Segmented, Select, Tag, Tooltip, Typography } from "antd";
import { useEffect, useState } from "react";
import { t } from "../i18n.ts";
import type {
	SentinelMode,
	SentinelModelLibraryView,
	SentinelProjectInfo,
	SentinelSessionPresetView,
	SentinelSessionStatus,
	SentinelThinkingLevel,
	SentinelStateSnapshot,
} from "../types.ts";
import { SENTINEL_MODE_LABELS, SENTINEL_MODES } from "../types.ts";
import { SESSION_STATUS_LABELS } from "./SessionStatusControl.tsx";
import { ChatModelPicker } from "./ChatModelPicker.tsx";

const { Text } = Typography;

/** Elapsed time of a compaction, so a slow model is visible as a wait, not a hang. */
function compactionElapsed(startedAt: number | null, now: number): string {
	if (startedAt === null) return "";
	const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
	if (seconds < 60) return t("{seconds} 秒", { seconds });
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return t("{minutes} 分 {seconds} 秒", { minutes, seconds: seconds % 60 });
	return t("{hours} 时 {minutes} 分", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

const THINKING_LABELS: Record<SentinelThinkingLevel, string> = {
	off: t("关闭"),
	minimal: t("最低"),
	low: t("低"),
	medium: t("中"),
	high: t("高"),
	xhigh: t("极高"),
	max: t("最大"),
};

const MODE_HINT = t(
	"审批模式：每条命令执行前等人放行；AI 审批：每条命令先交给守门模型判定，拦截时把理由回给 Agent；自动执行：不做任何拦截。切换只影响本会话",
);

const STATUS_COLORS: Record<SentinelSessionStatus, string> = {
	todo: "gold",
	active: "blue",
	done: "green",
	ignored: "default",
};

export function ChatToolbar({
	mode,
	sessionOverride,
	globalMode,
	streaming,
	pendingApprovals,
	subagentRunning,
	thinkingLevel,
	availableThinkingLevels,
	modelLibrary,
	currentModel,
	connected,
	onSetMainModel,
	onManageModels,
	branchOpen,
	filesOpen,
	subagentsOpen,
	terminalOpen,
	/** The active project; the terminal only exists inside its container. */
	project,
	allowedPrefixes,
	sessionStatus,
	preset,
	onSetSessionStatus,
	onToggleFiles,
	onToggleSubagents,
	onToggleTerminal,
	onSetMode,
	onSetThinkingLevel,
	onToggleBranch,
	onCompact,
	onAbortCompaction,
	compacting,
	compactionStartedAt,
	onAllowPrefix,
	onRemoveAllowedPrefix,
}: {
	mode: SentinelMode;
	/** The active session's own choice; null means it follows the global default. */
	sessionOverride: SentinelMode | null;
	globalMode: SentinelMode;
	streaming: boolean;
	pendingApprovals: number;
	subagentRunning: number;
	thinkingLevel: SentinelThinkingLevel;
	availableThinkingLevels: SentinelThinkingLevel[];
	modelLibrary: SentinelModelLibraryView | null;
	currentModel: SentinelStateSnapshot["model"];
	connected: boolean;
	onSetMainModel: (entryId: string) => void;
	onManageModels: () => void;
	branchOpen: boolean;
	filesOpen: boolean;
	subagentsOpen: boolean;
	terminalOpen: boolean;
	project: SentinelProjectInfo | null;
	allowedPrefixes: string[];
	/** The active session's operator status, shown as a chip at the right end. */
	sessionStatus: SentinelSessionStatus | null;
	/** The preset agent the active session was created with; null means the default agent. */
	preset: SentinelSessionPresetView | null;
	onSetSessionStatus: (status: SentinelSessionStatus | null) => void;
	onToggleFiles: () => void;
	onToggleSubagents: () => void;
	onToggleTerminal: () => void;
	onSetMode: (mode: SentinelMode | null) => void;
	onSetThinkingLevel: (level: SentinelThinkingLevel) => void;
	onToggleBranch: () => void;
	onCompact: () => void;
	onAbortCompaction: () => void;
	/** Compaction is running, so a prompt would be refused until it ends. */
	compacting: boolean;
	compactionStartedAt: number | null;
	onAllowPrefix: (prefix: string) => void;
	onRemoveAllowedPrefix: (prefix: string) => void;
}) {
	// The elapsed time has to move on its own: a compaction that stalls for
	// minutes sends no snapshots, and a frozen "压缩中 3 秒" reads as a hang.
	const [now, setNow] = useState(() => Date.now());
	const [prefixOpen, setPrefixOpen] = useState(false);
	const [prefixDraft, setPrefixDraft] = useState("");
	useEffect(() => {
		if (!compacting) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [compacting]);

	// A model without reasoning support reports a single "off" level.
	const thinkingDisabled = availableThinkingLevels.length <= 1;
	const thinkingOptions = (availableThinkingLevels.length > 0 ? availableThinkingLevels : [thinkingLevel]).map(
		(level) => ({ value: level, label: THINKING_LABELS[level] ?? level }),
	);

	return (
		<div className="chat-toolbar">
			<div className="chat-toolbar__group">
				<Tooltip title={MODE_HINT}>
					<Segmented
						size="small"
						value={mode}
						onChange={(value) => onSetMode(value as SentinelMode)}
						options={SENTINEL_MODES.map((item) => ({
							value: item,
							label: SENTINEL_MODE_LABELS[item],
						}))}
					/>
				</Tooltip>
				{sessionOverride === null ? (
					<Tooltip
						title={t("本会话跟随全局默认（{mode}）。点任一模式可为本会话单独设定", {
							mode: SENTINEL_MODE_LABELS[globalMode],
						})}
					>
						<Text type="secondary" className="chat-toolbar__hint">
							{t("跟随全局")}
						</Text>
					</Tooltip>
				) : (
					<Button
						type="link"
						size="small"
						onClick={() => onSetMode(null)}
						title={t("清除本会话的单独设定，重新跟随全局默认（{mode}）", {
							mode: SENTINEL_MODE_LABELS[globalMode],
						})}
					>
						{t("跟随全局")}
					</Button>
				)}
			</div>

			<Divider orientation="vertical" className="chat-toolbar__divider" />

			<div className="chat-toolbar__group chat-toolbar__group--model">
				<ChatModelPicker library={modelLibrary} currentModel={currentModel} connected={connected}
					onSelect={onSetMainModel} onManage={onManageModels} />
				<Tooltip title={t("模型的推理强度（仅对本次会话生效）")}>
					<span className="chat-toolbar__field">
						<Text type="secondary">{t("思考")}</Text>
						<Select
							size="small"
							variant="borderless"
							disabled={thinkingDisabled}
							value={thinkingLevel}
							onChange={(value) => onSetThinkingLevel(value as SentinelThinkingLevel)}
							options={thinkingOptions}
							style={{ width: 84 }}
							suffixIcon={<DownOutlined />}
						/>
					</span>
				</Tooltip>
				{preset ? (
					<Tooltip
						title={
							preset.missing
								? t(
										"预设「{name}」已被删除或正文缺失，本会话现按默认 Agent 运行；可在输入框上方的「预设 Agent」里换一个，或换回默认 Agent",
										{ name: preset.name },
									)
								: t("预设 Agent：{name}（在输入框上方的「预设 Agent」里可随时更换，只影响之后的回合）", {
										name: preset.name,
									})
						}
					>
						<Tag color={preset.missing ? "error" : "blue"} variant="filled" className="chat-toolbar__tag">
							{t("预设：{name}", { name: preset.name })}
							{preset.missing ? t(" · 已失效") : ""}
						</Tag>
					</Tooltip>
				) : null}
			</div>

			<Divider orientation="vertical" className="chat-toolbar__divider" />

			<div className="chat-toolbar__group">
				<Button
					size="small"
					type={branchOpen ? "primary" : "text"}
					icon={<BranchesOutlined />}
					onClick={onToggleBranch}
					title={branchOpen ? t("收起分支视图") : t("查看会话分支树，可从任意历史消息处分叉")}
				>
					{t("分支")}
				</Button>
				{compacting ? (
					<>
						<Tooltip title={t("压缩期间不能发送新消息")}>
							<Tag color="processing" icon={<ScissorOutlined />} className="chat-toolbar__tag">
								{t("压缩中")} {compactionElapsed(compactionStartedAt, now)}
							</Tag>
						</Tooltip>
						<Button
							size="small"
							danger
							type="text"
							icon={<CloseOutlined />}
							onClick={onAbortCompaction}
							title={t("放弃这次压缩，立刻恢复发送（会话内容不会丢失，压缩只有拿到摘要才会改写上下文）")}
						>
							{t("中止压缩")}
						</Button>
					</>
				) : (
					<Button
						size="small"
						type="text"
						icon={<ScissorOutlined />}
						onClick={onCompact}
						disabled={streaming}
						title={
							streaming
								? t("Agent 正在运行，先中止再压缩")
								: t("把当前上下文压缩成摘要，保留结论、丢弃过程（也可直接输入 /compact）")
						}
					>
						{t("压缩上下文")}
					</Button>
				)}
			</div>

			<Divider orientation="vertical" className="chat-toolbar__divider" />

			<div className="chat-toolbar__group">
				<Button
					size="small"
					type={filesOpen ? "primary" : "text"}
					icon={<FileOutlined />}
					onClick={onToggleFiles}
					title={t("浏览容器工作目录 /work（可编辑、上传、下载）")}
				>
					{t("文件")}
				</Button>
				<Tooltip title={t("查看当前会话的子代理运行，可中止或追加指令")}>
					<Badge count={subagentRunning} size="small" offset={[-2, 2]}>
						<Button
							size="small"
							type={subagentsOpen ? "primary" : "text"}
							icon={<TeamOutlined />}
							onClick={onToggleSubagents}
						>
							{t("子代理")}
						</Button>
					</Badge>
				</Tooltip>
				<Button
					size="small"
					type={terminalOpen ? "primary" : "text"}
					icon={<CodeOutlined />}
					onClick={onToggleTerminal}
					disabled={!project}
					title={
						project
							? t("在项目容器里开一个自己的 shell：不过审批，不进会话记录")
							: t("先选择项目，终端只连项目容器")
					}
				>
					{t("终端")}
				</Button>
			</div>

			<div className="chat-toolbar__right">
				{pendingApprovals > 0 ? <Tag color="error">{t("待审批 {count}", { count: pendingApprovals })}</Tag> : null}
				<Select
					size="small"
					variant="borderless"
					value={sessionStatus ?? "none"}
					onChange={(value) => onSetSessionStatus(value === "none" ? null : (value as SentinelSessionStatus))}
					style={{ width: 108 }}
					suffixIcon={<DownOutlined />}
					options={[
						{ value: "none", label: t("未标记") },
						...Object.entries(SESSION_STATUS_LABELS).map(([value, label]) => ({
							value,
							label: (
								<Tag color={STATUS_COLORS[value as SentinelSessionStatus]} variant="filled">
									{label}
								</Tag>
							),
						})),
					]}
					labelRender={({ value }) => (
						<Text type="secondary" className="chat-toolbar__status-current">
							{value === "none" ? t("未标记") : SESSION_STATUS_LABELS[value as SentinelSessionStatus]}
						</Text>
					)}
				/>
			</div>

			{mode === "review" && allowedPrefixes.length > 0 ? (
				<div className="chat-toolbar__prefix">
					<Text type="secondary">{t("白名单")}</Text>
					{allowedPrefixes.map((prefix) => (
						<Tag key={prefix} closable onClose={() => onRemoveAllowedPrefix(prefix)} className="chat-toolbar__tag">
							{prefix}
						</Tag>
					))}
					<Button size="small" type="link" onClick={() => setPrefixOpen(true)}>
						{t("＋ 添加")}
					</Button>
				</div>
			) : null}

			<Modal
				title={t("添加自动放行的命令前缀")}
				open={prefixOpen}
				okText={t("添加")}
				cancelText={t("取消")}
				onCancel={() => setPrefixOpen(false)}
				destroyOnHidden
				onOk={() => {
					const next = prefixDraft.trim();
					if (next) onAllowPrefix(next);
					setPrefixDraft("");
					setPrefixOpen(false);
				}}
			>
				<Input
					autoFocus
					value={prefixDraft}
					onChange={(event) => setPrefixDraft(event.target.value)}
					placeholder={t("例如：nmap -sV")}
					onPressEnter={() => {
						const next = prefixDraft.trim();
						if (next) onAllowPrefix(next);
						setPrefixDraft("");
						setPrefixOpen(false);
					}}
				/>
				<Text type="secondary" className="ui-hint">
					{t("复合命令永不自动放行。")}
				</Text>
			</Modal>
		</div>
	);
}
