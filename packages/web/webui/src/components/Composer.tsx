import {
	ArrowUpOutlined,
	BellOutlined,
	CloseOutlined,
	KeyOutlined,
	PaperClipOutlined,
	PictureOutlined,
	StopOutlined,
} from "@ant-design/icons";
import { Alert, Button, Input, Progress, Segmented, Space, Tooltip, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import type { ReportTemplateSummary } from "../../../src/report-types.ts";
import { getLanguage, t } from "../i18n.ts";
import { formatSize, formatTokens } from "../transcript.ts";
import type {
	SentinelImageAttachment,
	SentinelModelingState,
	SentinelPresetView,
	SentinelSessionPresetView,
	SentinelStatsView,
	SentinelSupervisorCustomStrategy,
	SentinelSupervisorMode,
	SentinelSupervisorStrategyRef,
	SentinelSupervisorView,
} from "../types.ts";
import { attachmentManifest, planAttachments, staleUploads, type UploadedFile, uploadFile } from "../uploads.ts";
import { ApiModelIcon, DroidIcon, IosIcon, SubagentIcon, SupervisorIcon, TargetIcon } from "./icons.tsx";
import { ModelingMenu } from "./ModelingMenu.tsx";
import { ReportComposerControl } from "./ReportComposerControl.tsx";
import { PresetMenu, type PresetMenuAnchor, presetMenuPosition } from "./PresetMenu.tsx";
import { SupervisorStartMenu, type SupervisorLaunchMode } from "./SupervisorStartMenu.tsx";
import { supervisorStrategyKey } from "../supervisor-strategy.ts";
import { WorkLinkControl } from "./WorkLinkControl.tsx";
import "./composer.css";

const { Text } = Typography;

/** Read a pasted/selected image into the base64 payload pi expects. */
async function readImage(file: File): Promise<SentinelImageAttachment | null> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
	const comma = dataUrl.indexOf(",");
	if (comma === -1) return null;
	return { type: "image", data: dataUrl.slice(comma + 1), mimeType: file.type || "image/png" };
}

/** The idle hint when no preset agent brings its own. */
const DEFAULT_HINT = t("输入目标与任务，Enter 发送，Shift+Enter 换行，可粘贴截图或拖入文件");

function initialSupervisorStrategies(defaults: SentinelSupervisorStrategyRef[]): SentinelSupervisorStrategyRef[] {
	return defaults.length > 0
		? defaults.map((entry) => ({ ...entry }))
		: [{ strategy: "steady", customStrategyId: null }];
}

/**
 * The grey line in the input box. A preset agent may bring its own, which is how
 * an operator says what this agent expects to be asked; a preset whose body went
 * missing runs the default agent, so it falls back to the default text as well.
 */
export function composerHint(preset: SentinelSessionPresetView | null): string {
	const custom = preset && !preset.missing ? preset.placeholder.trim() : "";
	return custom || DEFAULT_HINT;
}

/** Tokens per second, with enough precision to be useful at low speeds. */
export function formatThroughput(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "—";
	if (value >= 100) return value.toFixed(0);
	if (value >= 10) return value.toFixed(1);
	return value.toFixed(2);
}

/**
 * One attachment in the composer: uploading, stored, or refused. The file itself
 * is already in the project's work dir by the time it is stored — the message
 * carries only its path.
 */
interface PendingAttachment {
	/** Client-side key: the same file may be attached twice. */
	id: string;
	name: string;
	size: number;
	/** 0..1 while the body is on the wire. */
	ratio: number;
	error: string | null;
	uploaded: UploadedFile | null;
}

/**
 * The prompt box.
 *
 * Execution policy (mode, thinking level, compaction, branch) lives in the
 * chat page's toolbar; the composer only carries what belongs to one message:
 * its text, its attachments, and whether the run reports to the notification
 * channel.
 */
export function Composer({
	streaming,
	stats,
	throughput,
	hasProject,
	supportsImageInput,
	projectId,
	sessionId,
	blockedReason,
	notifyRun,
	goalDisabledReason,
	modeling,
	taskSession,
	droidEnabled,
	onToggleDroid,
	iosEnabled,
	onToggleIos,
	credentialsEnabled,
	onToggleCredentials,
	reportsEnabled,
	reportTemplate,
	reportsReadOnly,
	onToggleReports,
	freshConversation,
	presets,
	preset,
	supervisor,
	supervisorEnabled,
	supervisorWindowOpen,
	supervisorDefaultStrategies,
	supervisorCustomStrategies,
	onArmSupervisor,
	onShowSupervisorWindow,
	onToggleNotifyRun,
	onOpenGoal,
	onStartModeling,
	onEndModeling,
	onSetPreset,
	onSend,
	onAbort,
}: {
	streaming: boolean;
	stats: SentinelStatsView | null;
	/** Average output speed of the latest run; null before any assistant usage is seen. */
	throughput: { tokPerSec: number; outputTokens: number; durationMs: number } | null;
	hasProject: boolean;
	/** Whether the configured main model accepts images. */
	supportsImageInput: boolean;
	/** The active project's id; null while none is selected. Uploads land in its work dir. */
	projectId: string | null;
	/** The snapshot's current conversation id, used to scope work-link recording. */
	sessionId: string | null;
	/** Set when the console cannot run anything: the input is locked until it clears. */
	blockedReason: string | null;
	/** Whether the run started from here reports to the notification channel. */
	notifyRun: boolean;
	/** Why a persistent goal cannot start right now; null means it can. */
	goalDisabledReason: string | null;
	/**
	 * The business-modeling run in force for this conversation: the record its
	 * agent is writing. Null means none.
	 */
	modeling: SentinelModelingState | null;
	/** An engineering task's conversation: modeling is dispatched by its commander, not started from here. */
	taskSession: boolean;
	/**
	 * The Droid plugin's toolset switch. Off is maximally clean: no device tools
	 * in the prompt, nothing in context.
	 */
	droidEnabled: boolean;
	onToggleDroid: (next: boolean) => void;
	/** The iOS toolset switch, independent of Android for this conversation. */
	iosEnabled: boolean;
	onToggleIos: (next: boolean) => void;
	credentialsEnabled: boolean;
	onToggleCredentials: (next: boolean) => void;
	reportsEnabled: boolean;
	reportTemplate?: Pick<ReportTemplateSummary, "id" | "name" | "revision"> | null;
	/** Engineering task conversations retain their engine-controlled report workflow. */
	reportsReadOnly: boolean;
	onToggleReports: (next: boolean, templateId?: string | null) => void;
	/** True while the conversation has no messages yet: supervision is armed before the first message, not after. */
	freshConversation: boolean;
	/** The library, for the 预设 Agent picker; disabled entries are not offered. */
	presets: readonly SentinelPresetView[];
	/** The preset the viewed session runs under; null means the default agent. */
	preset: SentinelSessionPresetView | null;
	/** Supervision of this conversation; null until the operator arms it. */
	supervisor: SentinelSupervisorView | null;
	/** Global feature switch from 设置 → 模型. */
	supervisorEnabled: boolean;
	/** Whether the floating window is currently visible. */
	supervisorWindowOpen: boolean;
	/** Defaults chosen in 设置 → 模型; the operator can override them per conversation. */
	supervisorDefaultStrategies: SentinelSupervisorStrategyRef[];
	supervisorCustomStrategies: SentinelSupervisorCustomStrategy[];
	onArmSupervisor: (
		mode: SentinelSupervisorMode,
		delivery: "auto" | "confirm",
		strategies: SentinelSupervisorStrategyRef[],
		note: string,
	) => void;
	onShowSupervisorWindow: () => void;
	onToggleNotifyRun: () => void;
	onOpenGoal: () => void;
	onStartModeling: () => void;
	onEndModeling: () => void;
	/** Re-brief the viewed session; null drops back to the default agent. */
	onSetPreset: (presetId: string | null) => void;
	onSend: (text: string, behavior?: "steer" | "followUp", images?: SentinelImageAttachment[]) => void;
	onAbort: () => void;
}) {
	const [text, setText] = useState("");
	const [behavior, setBehavior] = useState<"steer" | "followUp">("steer");
	const [images, setImages] = useState<SentinelImageAttachment[]>([]);
	/** The 预设 Agent picker, anchored under its button. */
	const [presetMenu, setPresetMenu] = useState<PresetMenuAnchor | null>(null);
	/** The 业务建模 menu, anchored under its button. */
	const [modelingMenu, setModelingMenu] = useState<PresetMenuAnchor | null>(null);
	const [supervisorMenu, setSupervisorMenu] = useState<PresetMenuAnchor | null>(null);
	const [supervisorStrategies, setSupervisorStrategies] = useState<SentinelSupervisorStrategyRef[]>(() =>
		initialSupervisorStrategies(supervisorDefaultStrategies),
	);
	const supervisorDefaultStrategyKey = supervisorDefaultStrategies.map(supervisorStrategyKey).join("|");
	const [supervisorStrategyTouched, setSupervisorStrategyTouched] = useState(false);
	const [supervisorNote, setSupervisorNote] = useState("");
	const [supervisorLaunchMode, setSupervisorLaunchMode] = useState<SupervisorLaunchMode>("observe");
	useEffect(() => {
		if (supervisorStrategyTouched) return;
		setSupervisorStrategies(initialSupervisorStrategies(supervisorDefaultStrategies));
	}, [supervisorDefaultStrategyKey, supervisorStrategyTouched]);
	/** Files already uploaded to the project (or being uploaded, or refused). */
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const [dragging, setDragging] = useState(false);
	/** Why the last send was refused; cleared as soon as the composer changes. */
	const [sendNotice, setSendNotice] = useState<string | null>(null);
	/** The 图片 picker and the 附件 picker: images are inlined, files are uploaded. */
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const imageUnsupportedReason =
		getLanguage() === "en" ? "This model does not have multimodal support enabled." : "该模型未开启多模态支持";
	const imagesBlocked = !supportsImageInput && images.length > 0;

	const submit = (override?: "steer" | "followUp") => {
		const trimmed = text.trim();
		const ready = attachments.flatMap((item) => (item.uploaded ? [item.uploaded] : []));
		const uploading = attachments.some((item) => !item.uploaded && !item.error);
		if (blocked || uploading) return;
		if (imagesBlocked) {
			setSendNotice(imageUnsupportedReason);
			return;
		}
		if (!trimmed && images.length === 0 && ready.length === 0) return;
		// An upload is written into whichever project was active when it finished,
		// and only that project's directory is mounted into the container: a path
		// from another project is a reference the agent cannot follow, so the
		// message is refused instead of sent with a dead path in it.
		const stale = staleUploads(ready, projectId);
		if (stale.length > 0) {
			setSendNotice(
				t("这些文件属于另一个项目，请移除后重新上传：{names}", {
					names: stale.map((file) => file.name).join("、"),
				}),
			);
			return;
		}
		const manifest = attachmentManifest(ready);
		onSend(
			manifest ? `${manifest}\n\n${trimmed}` : trimmed,
			streaming ? (override ?? behavior) : undefined,
			images.length > 0 ? images : undefined,
		);
		setText("");
		setImages([]);
		setAttachments([]);
		setSendNotice(null);
	};

	const addImages = async (files: FileList | File[]) => {
		if (!supportsImageInput) {
			setSendNotice(imageUnsupportedReason);
			return;
		}
		const next: SentinelImageAttachment[] = [];
		for (const file of Array.from(files)) {
			if (!file.type.startsWith("image/")) continue;
			const image = await readImage(file);
			if (image) next.push(image);
		}
		if (next.length > 0) setImages((prev) => [...prev, ...next]);
	};

	/**
	 * Take files from a drop, a paste or the image picker. Images keep riding the
	 * vision path; every other file is uploaded right away, so the chip can show
	 * real progress and sending only has to write the paths into the message.
	 */
	const addFiles = (files: FileList | File[]) => {
		setSendNotice(null);
		const plans = planAttachments(Array.from(files), projectId);
		const images = plans.flatMap((plan) => (plan.kind === "image" ? [plan.file] : []));
		if (images.length > 0) void addImages(images);
		for (const plan of plans) {
			if (plan.kind === "image") continue;
			const entry: PendingAttachment = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				name: plan.file.name,
				size: plan.file.size,
				ratio: 0,
				error: plan.kind === "refused" ? plan.reason : null,
				uploaded: null,
			};
			setAttachments((prev) => [...prev, entry]);
			if (plan.kind === "refused") continue;
			void uploadFile(plan.file, plan.projectId, (ratio) => {
				setAttachments((prev) => prev.map((item) => (item.id === entry.id ? { ...item, ratio } : item)));
			})
				.then((uploaded) => {
					setAttachments((prev) =>
						prev.map((item) => (item.id === entry.id ? { ...item, uploaded, ratio: 1 } : item)),
					);
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : t("上传失败");
					setAttachments((prev) =>
						prev.map((item) => (item.id === entry.id ? { ...item, error: message } : item)),
					);
				});
		}
	};

	const blocked = blockedReason !== null;
	const uploading = attachments.some((item) => !item.uploaded && !item.error);
	const readyCount = attachments.filter((item) => item.uploaded !== null).length;
	const canSend =
		!blocked && !uploading && !imagesBlocked && (text.trim().length > 0 || images.length > 0 || readyCount > 0);

	return (
		<div className="composerbox">
			{/* Files can be dropped anywhere on the box; the class is the only feedback
			    that the drop will be taken. */}
			<div
				className={dragging ? "composerbox__box is-dragging" : "composerbox__box"}
				onDragOver={(event) => {
					if (!event.dataTransfer.types.includes("Files")) return;
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
				}}
				onDrop={(event) => {
					event.preventDefault();
					setDragging(false);
					if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
				}}
			>
				{/* Goal mode and the preset agent both sit above the input because they
				    change what the input means: one makes it an objective the agent
				    keeps working on, the other re-briefs who is reading it. */}
				<Space size={6} wrap className="composerbox__tools">
					{supervisorEnabled ? (
						<>
							<Button
								size="small"
								type={supervisor ? "primary" : "default"}
								icon={<SupervisorIcon />}
								aria-expanded={supervisor ? supervisorWindowOpen : undefined}
								onClick={(event) => {
									if (supervisor) {
										onShowSupervisorWindow();
										return;
									}
									if (!freshConversation) return;
									setSupervisorMenu(presetMenuPosition(event.currentTarget.getBoundingClientRect(), 452, 470));
								}}
								disabled={!hasProject || blocked || (!freshConversation && !supervisor)}
								title={
									supervisor
										? supervisor.status === "stopped"
											? t("监督已停止；点击查看本次监督记录")
											: t("打开监督悬浮窗；收起窗口不会停止监督")
										: !freshConversation
											? t("监督只能在开始对话前开启")
											: t("开启监督：观察，或介入并选择自动发送 / 确认后发送")
								}
							>
								{supervisor ? (supervisor.status === "stopped" ? t("监督已停止") : t("监督中")) : t("监督")}
							</Button>
							{supervisorMenu ? (
								<SupervisorStartMenu
									anchor={supervisorMenu}
									mode={supervisorLaunchMode}
									strategies={supervisorStrategies}
									customStrategies={supervisorCustomStrategies}
									note={supervisorNote}
									onModeChange={setSupervisorLaunchMode}
									onToggleStrategy={(ref) => {
										setSupervisorStrategyTouched(true);
										setSupervisorStrategies((current) => {
											const key = supervisorStrategyKey(ref);
											const exists = current.some((entry) => supervisorStrategyKey(entry) === key);
											if (exists) {
												return current.length > 1
													? current.filter((entry) => supervisorStrategyKey(entry) !== key)
													: current;
											}
											return [...current, ref];
										});
									}}
									onNoteChange={setSupervisorNote}
									onClose={() => setSupervisorMenu(null)}
									onStart={() => {
										const mode = supervisorLaunchMode === "observe" ? "observe" : "intervene";
										const delivery = supervisorLaunchMode === "auto" ? "auto" : "confirm";
										if (supervisorStrategies.length === 0) return;
										onArmSupervisor(mode, delivery, supervisorStrategies, supervisorNote.trim());
										setSupervisorMenu(null);
										setSupervisorNote("");
										setSupervisorStrategyTouched(false);
									}}
								/>
							) : null}
						</>
					) : null}
					<WorkLinkControl key={`${projectId ?? ""}:${sessionId ?? ""}`} projectId={projectId} sessionId={sessionId} />
					<Button
						size="small"
						type={preset ? "primary" : "default"}
						icon={<SubagentIcon />}
						onClick={(event) => {
							setPresetMenu(presetMenuPosition(event.currentTarget.getBoundingClientRect()));
						}}
						disabled={!hasProject || blocked || streaming}
						title={
							streaming
								? t("会话正在运行，先中止再换预设")
								: preset
									? t("当前预设：{name}{status}；点击更换，只影响之后的回合", {
											name: preset.name,
											status: preset.missing ? t("（已失效，正按默认 Agent 运行）") : "",
										})
									: t("给这个会话挂一个预设 Agent：换掉身份与背景，不影响可用工具和权限")
						}
					>
						{t("预设 Agent")}
						{preset ? <Text>{preset.name}</Text> : null}
					</Button>
					<Button
						size="small"
						icon={<TargetIcon />}
						onClick={onOpenGoal}
						disabled={goalDisabledReason !== null}
						title={goalDisabledReason ?? t("启动持续目标：一轮结束后自动继续，直到达成目标或达到轮数上限")}
					>
						{t("持续目标")}
					</Button>
					{/* Business modeling: the menu sends the instruction (开始建模) or closes
					    the record this conversation is writing (结束建模). The pill carries no
					    count: the counts of the record in progress are in its tooltip. */}
					<Button
						size="small"
						type={modeling ? "primary" : "default"}
						icon={<ApiModelIcon />}
						onClick={(event) =>
							// Two items tall: the menu goes up when there is no room below.
							setModelingMenu(presetMenuPosition(event.currentTarget.getBoundingClientRect(), 320, 360, 200))
						}
						disabled={!hasProject || blocked}
						title={
							!hasProject
								? t("请先创建或选择一个项目")
								: blocked
									? (blockedReason ?? t("环境未就绪"))
									: modeling
										? t("正在业务建模：{title}；已提交 {paths} 路径 / {operations} 操作 / {entities} 实体 / {apis} 条源码映射 / {machines} 个状态机 / {rules} 条规则", {
												title: modeling.title,
												paths: modeling.pathCount,
												operations: modeling.operationCount,
												entities: modeling.entityCount,
												apis: modeling.apiCount,
												machines: modeling.stateMachineCount,
												rules: modeling.ruleCount,
											})
										: t("业务建模：让 Agent 还原目标的接口、或读懂项目源码；在对话里直接要求也可以")
						}
					>
						{t("业务建模")}
					</Button>
					{/* Android tools: an explicit opt-in for THIS conversation. Off is
					    the clean state — no device tools in the prompt, nothing in context. */}
					<Button
						size="small"
						type={droidEnabled ? "primary" : "default"}
						icon={<DroidIcon />}
						disabled={!hasProject}
						onClick={() => onToggleDroid(!droidEnabled)}
						title={
							!hasProject
								? t("请先创建或选择一个项目")
								: droidEnabled
									? t("当前对话已挂载安卓工具（droid_* / apk_*）。点击摘除；其他对话不受影响")
									: t(
											"为当前对话挂载安卓工具（droid_* / apk_*）：需要先在「安卓设备」页配置反连与 token，并有一台设备在线",
										)
						}
					>
						{t("安卓")}
						{droidEnabled ? <Text>✓</Text> : null}
					</Button>
					{/* iOS tools: the same per-conversation opt-in, independent of Android. */}
					<Button
						size="small"
						type={iosEnabled ? "primary" : "default"}
						icon={<IosIcon />}
						disabled={!hasProject}
						onClick={() => onToggleIos(!iosEnabled)}
						title={
							!hasProject
								? t("请先创建或选择一个项目")
								: iosEnabled
									? t("当前对话已挂载 iOS 工具（ios_*）。点击摘除；其他对话不受影响")
									: t(
											"为当前对话挂载 iOS 工具（ios_*）：需要先在「iOS 设备」页创建 token，并有一台越狱设备在线",
										)
						}
					>
						{t("iOS")}
						{iosEnabled ? <Text>✓</Text> : null}
					</Button>
					<Button size="small" type={credentialsEnabled ? "primary" : "default"} icon={<KeyOutlined />} disabled={!hasProject} onClick={() => onToggleCredentials(!credentialsEnabled)} title={credentialsEnabled ? "当前对话可读取、保存、更新并主动验证项目凭据，点击关闭" : "允许当前对话中的 Agent 管理、主动验证并上报当前项目凭据，无需逐条授权"}>
						{t("凭据中心")}{credentialsEnabled ? <Text>✓</Text> : null}
					</Button>
					<ReportComposerControl projectId={hasProject ? projectId : null} enabled={reportsEnabled} template={reportTemplate} readOnly={reportsReadOnly} streaming={streaming} blocked={blocked} onChange={onToggleReports} />
					{goalDisabledReason ? <Text type="secondary">{goalDisabledReason}</Text> : null}
				</Space>
				{presetMenu ? (
					<PresetMenu
						anchor={presetMenu}
						presets={presets}
						currentId={preset?.id ?? null}
						onPick={(presetId) => {
							setPresetMenu(null);
							onSetPreset(presetId ?? null);
						}}
						onClose={() => setPresetMenu(null)}
					/>
				) : null}
				{modelingMenu ? (
					<ModelingMenu
						anchor={modelingMenu}
						modeling={modeling}
						streaming={streaming}
						taskSession={taskSession}
						onStart={onStartModeling}
						onEnd={onEndModeling}
						onClose={() => setModelingMenu(null)}
					/>
				) : null}
				{images.length > 0 ? (
					<div className="composerbox__files">
						{images.map((image, index) => (
							<div key={index} className="composerbox__image">
								<img
									src={`data:${image.mimeType};base64,${image.data}`}
									alt={t("附件 {index}", { index: index + 1 })}
								/>
								<Button
									type="text"
									size="small"
									shape="circle"
									icon={<CloseOutlined />}
									title={t("移除该图片")}
									onClick={() => setImages((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}
								/>
							</div>
						))}
						<span className="composerbox__count">{t("{count} 张图片待发送", { count: images.length })}</span>
					</div>
				) : null}
				{attachments.length > 0 ? (
					<div className="composerbox__files">
						{attachments.map((item) => (
							<div
								key={item.id}
								className={item.error ? "composerbox__file is-bad" : "composerbox__file"}
								title={item.uploaded?.path ?? item.name}
							>
								<span className="composerbox__fname">{item.name}</span>
								<span className="composerbox__fmeta">
									{item.error ??
										(item.uploaded
											? formatSize(item.uploaded.size)
											: t("上传中 {percent}%", { percent: Math.round(item.ratio * 100) }))}
								</span>
								<span className="composerbox__fbar">
									<span style={{ width: `${Math.round((item.uploaded ? 1 : item.ratio) * 100)}%` }} />
								</span>
								<Button
									type="text"
									size="small"
									shape="circle"
									icon={<CloseOutlined />}
									title={item.uploaded ? t("从待发送列表移除（文件仍在 uploads/ 里）") : t("移除")}
									onClick={() => setAttachments((prev) => prev.filter((entry) => entry.id !== item.id))}
								/>
							</div>
						))}
						<span className="composerbox__count">
							{uploading ? t("上传中…") : t("{count} 个文件待发送", { count: readyCount })}
						</span>
					</div>
				) : null}
				{imagesBlocked || sendNotice ? (
					<Alert
						type="warning"
						showIcon
						className="composerbox__notice"
						title={imagesBlocked ? imageUnsupportedReason : sendNotice}
					/>
				) : null}
				<Input.TextArea
					className="composerbox__input"
					variant="borderless"
					value={text}
					autoSize={{ minRows: 3, maxRows: 8 }}
					placeholder={
						blocked
							? blockedReason
							: hasProject
								? streaming
									? t("Agent 正在运行… 输入内容可插话或排队")
									: composerHint(preset)
								: t("请先在「项目」页创建或选择一个项目")
					}
					disabled={!hasProject || blocked}
					onChange={(event) => {
						setText(event.target.value);
						setSendNotice(null);
					}}
					onPaste={(event) => {
						// A pasted file (from the file manager) arrives in `files`, a pasted
						// screenshot as an image; both are taken here, plain text is left to
						// the textarea.
						const files = Array.from(event.clipboardData.files);
						if (files.length === 0) return;
						event.preventDefault();
						addFiles(files);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							submit();
						}
					}}
				/>
				<div className="composerbox__actions">
					<Tooltip title={supportsImageInput ? t("附加图片（也可直接粘贴截图）") : imageUnsupportedReason}>
						<span style={{ display: "inline-flex" }}>
							<Button
								type="text"
								size="small"
								icon={<PictureOutlined />}
								onClick={() => imageInputRef.current?.click()}
								disabled={!supportsImageInput || !hasProject || blocked}
							>
								{t("图片")}
							</Button>
						</span>
					</Tooltip>
					<Button
						type="text"
						size="small"
						icon={<PaperClipOutlined />}
						onClick={() => fileInputRef.current?.click()}
						disabled={!hasProject || blocked}
						title={t("附加文件（任意类型；上传到项目工作目录，随消息把路径交给 Agent；也可直接拖入或粘贴）")}
					>
						{t("附件")}
					</Button>
					<Button
						type={notifyRun ? "primary" : "text"}
						size="small"
						icon={<BellOutlined />}
						onClick={onToggleNotifyRun}
						title={notifyRun ? t("本次运行完成后发送通知（点击关闭）") : t("本次运行完成后不通知（点击开启）")}
					>
						{t("通知")}
					</Button>
					<input
						ref={imageInputRef}
						type="file"
						accept="image/*"
						disabled={!supportsImageInput || !hasProject || blocked}
						multiple
						hidden
						onChange={(event) => {
							if (event.target.files) addFiles(event.target.files);
							event.target.value = "";
						}}
					/>
					{/* Any type: the plan decides whether a picked file is inlined (image)
					    or uploaded (everything else). */}
					<input
						ref={fileInputRef}
						type="file"
						multiple
						hidden
						onChange={(event) => {
							if (event.target.files) addFiles(event.target.files);
							event.target.value = "";
						}}
					/>
					<span className="composerbox__spacer" />
					{streaming ? (
						<>
							<Segmented
								size="small"
								value={behavior}
								onChange={(value) => setBehavior(value as "steer" | "followUp")}
								options={[
									{ value: "steer", label: t("插话") },
									{ value: "followUp", label: t("排队") },
								]}
							/>
							<Button
								type="primary"
								size="small"
								icon={<ArrowUpOutlined />}
								onClick={() => submit()}
								disabled={!canSend}
							>
								{t("发送")}
							</Button>
							<Button danger size="small" icon={<StopOutlined />} onClick={onAbort}>
								{t("中止")}
							</Button>
						</>
					) : (
						<Button
							type="primary"
							size="small"
							icon={<ArrowUpOutlined />}
							onClick={() => submit()}
							disabled={!canSend || !hasProject || blocked}
						>
							{t("发送")}
						</Button>
					)}
				</div>
			</div>
			<Text
				type="secondary"
				className="composerbox__status"
				title={t("按本轮每个 assistant 消息的 output tokens 与该消息耗时计算，不含工具执行时间")}
			>
				{blocked ? t("已锁定") : streaming ? t("运行中…") : t("空闲")}
				{stats
					? `${t(" · Token 输入 {input} / 输出 {output}", {
							input: formatTokens(stats.tokens.input),
							output: formatTokens(stats.tokens.output),
						})}${stats.cost > 0 ? t(" · 花费 {cost}", { cost: `$${stats.cost.toFixed(4)}` }) : ""}`
					: ""}
				{" · "}
				{throughput
					? `${t("本轮均速 {rate} tok/s", { rate: formatThroughput(throughput.tokPerSec) })}${
							streaming
								? t("（生成中）")
								: ` · ${formatTokens(throughput.outputTokens)} tokens / ${(throughput.durationMs / 1000).toFixed(1)}s`
						}`
					: streaming
						? t("本轮生成中…")
						: t("本轮 tok/s —")}
			</Text>
		</div>
	);
}
