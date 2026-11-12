import { CloseOutlined, LoadingOutlined, PaperClipOutlined } from "@ant-design/icons";
import { Button, Input, Tooltip, Typography } from "antd";
import type { UploadFile } from "antd";
import { useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import type { SentinelEngine, SentinelProjectInfo } from "../types.ts";
import { attachmentManifest, MAX_UPLOAD_BYTES, staleUploads, type UploadedFile } from "../uploads.ts";
import { EngineTargetFiles } from "./EngineTargetFiles.tsx";

/** File paths travel in the steering message and persist in the commander log. */
export function CommanderComposer({ status, project, onSubmit }: {
	status: SentinelEngine["status"];
	project: SentinelProjectInfo | null;
	onSubmit(text: string): void;
}) {
	const [draft, setDraft] = useState("");
	const [files, setFiles] = useState<UploadFile<UploadedFile>[]>([]);
	const canChat = status === "running" || status === "completed";
	const canAttach = status === "running" && project !== null;
	const attachments = files.flatMap((file) => file.status === "done" && file.response ? [file.response] : []);
	const blocked = files.some((file) => file.status !== "done" || !file.response)
		|| staleUploads(attachments, project?.id ?? null).length > 0
		|| (files.length > 0 && !canAttach);
	const canSend = canChat && !blocked && (draft.trim() !== "" || attachments.length > 0);
	const sendDraft = (): void => {
		if (!canSend) return;
		onSubmit([
			draft.trim(),
			attachments.length > 0 ? (getLanguage() === "en"
				? "Analyze the attached files before planning further work. If you cannot read them directly, dispatch an attachment analysis task with their full paths."
				: "请先分析附件再安排后续任务；无法直接读取时，请派发附件分析任务并传递完整路径。") : "",
			attachmentManifest(attachments),
		].filter(Boolean).join("\n\n"));
		setDraft("");
		setFiles([]);
	};
	const attachHint = status === "completed"
		? (getLanguage() === "en" ? "Completed engagements support text debrief only." : "工程已完成，复盘对话仅支持文字。")
		: status !== "running" ? (getLanguage() === "en" ? "Attachments are available while the engagement is running." : "工程运行中才可上传附件。")
			: !project ? t("请先选择项目")
			: (getLanguage() === "en" ? `Attach files for the commander to analyze; up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB each.` : `上传附件交给指挥官分析，单文件不超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB。`);

	return <div className="engine-commander__composer">
		{files.length > 0 ? <ul className="engine-commander__attachments" aria-label={getLanguage() === "en" ? "Attachments" : "附件"}>
			{files.map((file) => <li key={file.uid} className={file.status === "error" ? "is-error" : ""}>
				{file.status === "uploading" ? <LoadingOutlined /> : <PaperClipOutlined />}
				<span className="engine-commander__filename" title={file.name}>{file.name}</span>
				<span className="engine-commander__upload-state" title={file.status === "error" && file.error instanceof Error ? file.error.message : undefined}>{file.status === "uploading" ? `${Math.round(file.percent ?? 0)}%` : file.status === "error" ? t("上传失败") : t("已上传")}</span>
				<Button size="small" type="text" icon={<CloseOutlined />} aria-label={getLanguage() === "en" ? `Remove ${file.name}` : `移除 ${file.name}`} onClick={() => setFiles((previous) => previous.filter((item) => item.uid !== file.uid))} />
			</li>)}
		</ul> : null}
		<Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} variant="borderless" aria-label={t("给指挥官的指令")}
			value={draft} disabled={!canChat}
			placeholder={status === "running" ? t("向指挥官补充目标或调整方向…") : status === "completed" ? t("工程已完成，向指挥官追问报告细节…") : t("工程未运行，暂时不能对话")}
			onChange={(event) => setDraft(event.target.value)}
			onKeyDown={(event) => {
				if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
					event.preventDefault();
					sendDraft();
				}
			}}
		/>
		<div className="engine-commander__composer-actions">
			<Tooltip title={attachHint}><div><EngineTargetFiles compact project={project} files={files} onChange={setFiles} disabled={!canAttach} /></div></Tooltip>
			<Typography.Text type="secondary">{t("Enter 发送 · Shift+Enter 换行")}</Typography.Text>
			<Button size="small" type="primary" disabled={!canSend} onClick={sendDraft}>{t("发送")}</Button>
		</div>
		{files.some((file) => file.status === "error") ? <div className="engine-commander__upload-hint" role="alert">{getLanguage() === "en" ? "Remove failed files and upload them again before sending." : "请移除上传失败的附件并重新上传后再发送。"}</div> : null}
		{files.length > 0 && !canAttach ? <div className="engine-commander__upload-hint" role="status">{getLanguage() === "en" ? "The engagement is no longer running. Remove attachments to continue a text debrief." : "工程当前未运行，请移除附件后进行文字复盘，或恢复工程后发送。"}</div> : null}
	</div>;
}
