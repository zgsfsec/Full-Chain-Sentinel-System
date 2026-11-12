/**
 * Chat attachments: one uploaded file per HTTP request, streamed straight to disk.
 *
 * The file lands in `<project work dir>/uploads/` because that directory is what
 * the agent can read. The container mounts the work dir both at `/work` and at
 * its own host path, so the absolute path the message carries resolves in a
 * container session and in a host session alike. Nothing here goes through
 * `docker exec`, which also keeps uploads working while no container runs.
 *
 * The client controls only the name and the bytes, so the name is reduced to a
 * single path segment, and a free name is claimed instead of overwriting an
 * earlier upload. The body is streamed, so the cap is a disk budget rather than
 * a memory one; a body over it, or a write that fails, leaves nothing behind.
 */

import type { FileHandle } from "node:fs/promises";
import { mkdir, open, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { t } from "./i18n.ts";

/** Directory under the project work dir that chat attachments land in. */
export const UPLOAD_DIR_NAME = "uploads";

/** Largest single chat attachment. */
export const UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;

/** Where one project's chat attachments live. */
export function uploadsDirFor(workDir: string): string {
	return join(workDir, UPLOAD_DIR_NAME);
}

/**
 * Reduce a client-supplied name to one safe path segment: no directory part, no
 * control characters, and never a bare `.`/`..` (which name the directory itself
 * or its parent). A name that reduces to nothing becomes `file`.
 */
export function safeFileName(raw: string): string {
	const base = basename(raw.replace(/\\/g, "/"))
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim()
		.slice(0, 120)
		.trim();
	return base === "" || /^\.+$/.test(base) ? "file" : base;
}

/** `report.pdf` → `report-2.pdf`, keeping the extension. */
export function suffixedName(name: string, index: number): string {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return `${name}-${index}`;
	return `${name.slice(0, dot)}-${index}${name.slice(dot)}`;
}

export type UploadResult =
	| { ok: true; name: string; path: string; size: number }
	| { ok: false; status: number; error: string };

/**
 * Stream one request body into the project's uploads directory.
 *
 * The first free name wins — the file is created exclusively, so two uploads of
 * the same name cannot collide — and every failure path removes the partial file.
 */
export async function storeUpload(
	workDir: string,
	rawName: string,
	body: AsyncIterable<Buffer | Uint8Array>,
	maxBytes = UPLOAD_MAX_BYTES,
): Promise<UploadResult> {
	const dir = uploadsDirFor(workDir);
	try {
		await mkdir(dir, { recursive: true });
	} catch {
		return { ok: false, status: 500, error: t("无法创建上传目录") };
	}
	const name = safeFileName(rawName);
	let handle: FileHandle | undefined;
	let target = "";
	for (let index = 1; index <= 999 && !handle; index += 1) {
		target = join(dir, index === 1 ? name : suffixedName(name, index));
		try {
			handle = await open(target, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				return { ok: false, status: 500, error: t("无法写入上传目录") };
			}
		}
	}
	if (!handle) return { ok: false, status: 409, error: t("同名文件过多，请改名后重试") };

	let size = 0;
	try {
		for await (const chunk of body) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.byteLength;
			if (size > maxBytes) {
				await handle.close();
				await unlink(target).catch(() => {});
				return {
					ok: false,
					status: 413,
					error: t("文件超过 {max}MB 上限", { max: Math.round(maxBytes / 1024 / 1024) }),
				};
			}
			let written = 0;
			while (written < buffer.byteLength) {
				const { bytesWritten } = await handle.write(buffer, written, buffer.byteLength - written);
				written += bytesWritten;
			}
		}
		await handle.close();
	} catch {
		await handle.close().catch(() => {});
		await unlink(target).catch(() => {});
		return { ok: false, status: 400, error: t("上传中断，未完成的文件已清理") };
	}
	return { ok: true, name: basename(target), path: target, size };
}
