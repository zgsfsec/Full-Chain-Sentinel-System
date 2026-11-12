/**
 * Chat attachments in the composer.
 *
 * Images keep riding the vision path — they are inlined into the message — while
 * every other file goes to the project's work directory first and the message
 * carries its path, because a model message can hold text and images but no
 * document part. The server owns the name sanitizing and the size cap (see
 * packages/web/src/upload.ts); this module owns the transfer and the block of
 * paths the model reads.
 */

import { t } from "./i18n.ts";
import { formatSize } from "./transcript.ts";

/** Largest single attachment; the server refuses anything larger. */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/** One stored attachment, as the upload route reports it. */
export interface UploadedFile {
	name: string;
	/** Absolute path under the project work dir; this is what the agent reads. */
	path: string;
	size: number;
	/** The project it was written into: the path only resolves while that is active. */
	projectId: string;
}

/**
 * Upload one file, reporting progress from 0 to 1. XHR rather than fetch: only
 * XHR reports upload progress, and an attachment with no feedback reads as a
 * hang.
 */
export function uploadFile(
	file: File,
	projectId: string,
	onProgress: (ratio: number) => void,
	signal?: AbortSignal,
): Promise<UploadedFile> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error(t("上传已取消")));
			return;
		}
		const request = new XMLHttpRequest();
		const abort = (): void => request.abort();
		signal?.addEventListener("abort", abort, { once: true });
		request.onloadend = () => signal?.removeEventListener("abort", abort);
		request.open("POST", `/api/upload?name=${encodeURIComponent(file.name)}&projectId=${encodeURIComponent(projectId)}`);
		request.setRequestHeader("content-type", "application/octet-stream");
		request.upload.onprogress = (event) => {
			if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
		};
		request.onload = () => {
			let payload: { name?: string; path?: string; size?: number; error?: string } = {};
			try {
				payload = JSON.parse(request.responseText) as typeof payload;
			} catch {
				// Not JSON: the console answered with something else (a proxy error
				// page, most likely). The status below is the real news.
			}
			if (request.status >= 200 && request.status < 300 && payload.path) {
				resolve({
					name: payload.name ?? file.name,
					path: payload.path,
					size: payload.size ?? file.size,
					projectId,
				});
				return;
			}
			reject(new Error(payload.error ?? t("上传失败（HTTP {status}）", { status: request.status })));
		};
		request.onerror = () => reject(new Error(t("上传失败：连接中断")));
		request.onabort = () => reject(new Error(t("上传已取消")));
		request.send(file);
	});
}

/**
 * The block prepended to the message. Paths, not contents: the model reads the
 * files with its own tools, and the size is there so it can decide how to open
 * one.
 */
export function attachmentManifest(files: readonly UploadedFile[]): string {
	if (files.length === 0) return "";
	const lines = files.map((file) => `- ${file.path}（${formatSize(file.size)}）`);
	return t("已上传文件（可用 read/bash 直接读）：\n{files}", { files: lines.join("\n") });
}

/**
 * Attachments that belong to a project other than the active one. An upload is
 * written into whichever project was active when it finished, and only that
 * project's directory is mounted into the container, so a path from another
 * project is a reference the agent cannot follow.
 */
export function staleUploads(files: readonly UploadedFile[], projectId: string | null): UploadedFile[] {
	return files.filter((file) => file.projectId !== projectId);
}

/** What one dropped file is for: the vision path, the upload path, or neither. */
export type AttachmentPlan =
	| { kind: "image"; file: File }
	| { kind: "upload"; file: File; projectId: string }
	| { kind: "refused"; file: File; reason: string };

/**
 * Decide what to do with each dropped or pasted file before anything is sent.
 * Images are inlined by the composer (they never touch disk); anything else is
 * uploaded into the active project's work dir; a file that cannot be uploaded is
 * kept as a chip with the reason, so the operator sees which one was refused
 * instead of watching a file quietly disappear.
 */
export function planAttachments(files: readonly File[], projectId: string | null): AttachmentPlan[] {
	return files.map((file) => {
		if (file.type.startsWith("image/")) return { kind: "image", file };
		if (!projectId) return { kind: "refused", file, reason: t("请先选择项目") };
		if (file.size > MAX_UPLOAD_BYTES) {
			return { kind: "refused", file, reason: t("超过 {size} 上限", { size: formatSize(MAX_UPLOAD_BYTES) }) };
		}
		return { kind: "upload", file, projectId };
	});
}
