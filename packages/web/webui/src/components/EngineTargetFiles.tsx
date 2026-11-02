import { PaperClipOutlined, UploadOutlined } from "@ant-design/icons";
import { Alert, Button, Typography, Upload } from "antd";
import type { UploadFile } from "antd";
import { useEffect, useRef, useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import type { SentinelProjectInfo } from "../types.ts";
import { MAX_UPLOAD_BYTES, type UploadedFile, uploadFile } from "../uploads.ts";

export function EngineTargetFiles({ project, files, onChange, compact = false, disabled = false }: {
	project: SentinelProjectInfo | null;
	files: UploadFile<UploadedFile>[];
	onChange(files: UploadFile<UploadedFile>[]): void;
	compact?: boolean;
	disabled?: boolean;
}) {
	const [error, setError] = useState<string | null>(null);
	const inFlight = useRef(new Map<File, AbortController>());
	useEffect(() => {
		const retained = new Set<File | undefined>(files.map((file) => file.originFileObj));
		for (const [file, controller] of inFlight.current) {
			if (!retained.has(file)) controller.abort();
		}
	}, [files]);
	useEffect(() => () => {
		for (const controller of inFlight.current.values()) controller.abort();
	}, []);
	return (
		<div className={compact ? "engine-target-files is-compact" : "engine-target-files"}>
			<Upload<UploadedFile>
				multiple
				disabled={!project || disabled}
				showUploadList={!compact}
				fileList={files}
				beforeUpload={(file) => {
					setError(null);
					if (file.size > MAX_UPLOAD_BYTES) {
						setError(t("上传失败：文件超过 {max}MB 上限", { max: MAX_UPLOAD_BYTES / 1024 / 1024 }));
						return Upload.LIST_IGNORE;
					}
					return true;
				}}
				customRequest={({ file, onProgress, onSuccess, onError }) => {
					if (!project || !(file instanceof File)) {
						onError?.(new Error(t("请先选择项目")));
						return;
					}
					const controller = new AbortController();
					inFlight.current.set(file, controller);
					void uploadFile(file, project.id, (ratio) => onProgress?.({ percent: ratio * 100 }), controller.signal)
						.then((uploaded) => {
							const cwd = project.cwd.replaceAll("\\", "/").replace(/\/$/, "");
							if (!uploaded.path.replaceAll("\\", "/").startsWith(`${cwd}/uploads/`)) {
								throw new Error(getLanguage() === "en" ? "Project changed; upload the file again." : "项目已切换，请重新上传文件。");
							}
							onSuccess?.(uploaded);
						})
						.catch((cause: unknown) => onError?.(cause instanceof Error ? cause : new Error(String(cause))))
						.finally(() => inFlight.current.delete(file));
					return { abort: () => controller.abort() };
				}}
				onChange={({ fileList }) => onChange(fileList)}
			>
				<Button size={compact ? "small" : "middle"} type={compact ? "text" : "default"} disabled={!project || disabled} icon={compact ? <PaperClipOutlined /> : <UploadOutlined />}>
					{compact ? (getLanguage() === "en" ? "Attach files" : "上传附件") : (getLanguage() === "en" ? "Upload files" : "上传文件")}
				</Button>
			</Upload>
			{!compact ? <Typography.Text type="secondary" className="engine-target-files__hint">
				{getLanguage() === "en"
					? "Attach target lists, challenge files, images, or archives; up to 64 MB per file. The commander arranges analysis alongside your description."
					: "可上传目标清单、题目附件、图片或压缩包，单文件不超过 64 MB。指挥官会结合文字描述安排分析。"}
			</Typography.Text> : null}
			{error ? <Alert type="error" showIcon title={error} /> : null}
		</div>
	);
}
