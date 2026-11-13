/** Bounded reads shared by report images and downloadable evidence. */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { downloadFile, toContainerWorkPath } from "./files.ts";

/** Resolve symlinks before reading: reports cannot snapshot another project's or host's files. */
export async function readProjectFile(
	input: string,
	workDir: string,
	container: string | undefined,
	maxBytes: number,
): Promise<Buffer> {
	const containerPath = toContainerWorkPath(input, workDir);
	if (!containerPath || containerPath === "/work") throw new Error(`文件路径不在项目工作目录内：${input}`);
	const root = await realpath(workDir);
	const path = await realpath(resolve(root, containerPath.slice("/work/".length)));
	const rel = relative(root, path);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error(`文件路径不在项目工作目录内：${input}`);
	try {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await handle.stat();
			if (!stat.isFile()) throw new Error(`不是普通文件：${input}`);
			if (stat.size > maxBytes) throw new Error(`文件超过 ${maxBytes / 1024 / 1024} MB 上限：${input}`);
			const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
			let read = 0;
			while (read < bytes.length) {
				const result = await handle.read(bytes, read, bytes.length - read, read);
				if (!result.bytesRead) break;
				read += result.bytesRead;
			}
			if (read !== stat.size) throw new Error(`文件正在变化，请生成完成后重新提交：${input}`);
			return bytes.subarray(0, read);
		} finally {
			await handle.close();
		}
	} catch (error) {
		// Container-created files can be root-owned on a native Linux host.
		if (!container || !(error instanceof Error) || !("code" in error) || error.code !== "EACCES") throw error;
		const downloaded = await downloadFile(container, `/work/${rel.split(sep).join("/")}`);
		if (downloaded.size > maxBytes) throw new Error(`文件超过 ${maxBytes / 1024 / 1024} MB 上限：${input}`);
		return Buffer.from(downloaded.data, "base64");
	}
}
