/** Parse image references once, snapshot project files, and build portable downloads. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { crc32 } from "node:zlib";
import { fromMarkdown } from "mdast-util-from-markdown";
import { downloadFile, toContainerWorkPath } from "./files.ts";
import type { ReportDetail, ReportProvenance } from "./report-types.ts";
import type { ArchivedReportImage, ReportStore } from "./reports.ts";

const MAX_MARKDOWN_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_IMAGES = 64;

interface MarkdownNode {
	type: string;
	url?: string;
	alt?: string | null;
	title?: string | null;
	identifier?: string;
	children?: MarkdownNode[];
	position?: { start: { offset?: number }; end: { offset?: number } };
}

interface ImageReference {
	source: string;
	alt: string;
	title?: string | null;
	start: number;
	end: number;
}

function imageReferences(markdown: string): ImageReference[] {
	const tree = fromMarkdown(markdown);
	const nodes: MarkdownNode[] = [];
	const visit = (node: MarkdownNode): void => {
		nodes.push(node);
		for (const child of node.children ?? []) visit(child);
	};
	visit(tree);
	const definitions = new Map<string, MarkdownNode>();
	for (const node of nodes) {
		if (node.type === "definition" && node.identifier && !definitions.has(node.identifier))
			definitions.set(node.identifier, node);
	}
	return nodes.flatMap((node) => {
		const reference =
			node.type === "image"
				? node
				: node.type === "imageReference" && node.identifier
					? definitions.get(node.identifier)
					: undefined;
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		return reference?.url && start !== undefined && end !== undefined
			? [{ source: reference.url, alt: node.alt ?? "", title: reference.title, start, end }]
			: [];
	});
}

function imageType(data: Buffer): { extension: string; mimeType: string } {
	if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
		return { extension: "png", mimeType: "image/png" };
	if (data[0] === 255 && data[1] === 216 && data[2] === 255) return { extension: "jpg", mimeType: "image/jpeg" };
	if (/^GIF8[79]a/.test(data.subarray(0, 6).toString("ascii"))) return { extension: "gif", mimeType: "image/gif" };
	if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP")
		return { extension: "webp", mimeType: "image/webp" };
	if (data.subarray(0, 2).toString() === "BM") return { extension: "bmp", mimeType: "image/bmp" };
	if (/^(?:\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->)*<svg[\s>]/i.test(data.subarray(0, 4096).toString("utf8")))
		return { extension: "svg", mimeType: "image/svg+xml" };
	throw new Error("图片格式不支持，请使用 PNG、JPEG、GIF、WebP、BMP 或 SVG 文件。");
}

/** Resolve symlinks before reading: reports cannot snapshot another project's or host's files. */
async function readProjectFile(
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

export async function submitReport(options: {
	store: ReportStore;
	provenance: ReportProvenance;
	key: string;
	title: string;
	markdown?: string;
	path?: string;
	workDir: string;
	container?: string;
}): Promise<ReportDetail> {
	const prior = options.store.findSubmission(options.provenance.projectId, options.key);
	if (prior) return prior;
	const title = options.title.trim();
	if (!title || title.length > 120 || /[\r\n]/.test(title))
		throw new Error("报告标题需要 1–120 个字符，且只能占一行。");
	if ((options.markdown !== undefined) === (options.path !== undefined))
		throw new Error("markdown 和 path 必须且只能提供一个。");
	const markdown =
		options.path !== undefined
			? (await readProjectFile(options.path, options.workDir, options.container, MAX_MARKDOWN_BYTES)).toString(
					"utf8",
				)
			: (options.markdown ?? "");
	if (!markdown.trim()) throw new Error("报告正文不能为空。");
	if (Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES) throw new Error("报告正文超过 1 MB 上限。");
	const documentPath = options.path ? toContainerWorkPath(options.path, options.workDir) : undefined;
	const base = documentPath ? posix.dirname(documentPath) : "/work";
	const sources = [...new Set(imageReferences(markdown).map((image) => image.source))];
	if (sources.length > MAX_IMAGES) throw new Error(`每份报告最多包含 ${MAX_IMAGES} 张图片。`);
	const images: ArchivedReportImage[] = [];
	let total = Buffer.byteLength(markdown);
	for (const source of sources) {
		let data: Buffer;
		const inline = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(source);
		if (inline) {
			data = Buffer.from(inline[1], "base64");
		} else {
			if (/^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith("//")) {
				throw new Error(`请先把图片保存到项目工作目录，再使用本地路径引用：${source.slice(0, 200)}`);
			}
			let path: string;
			try {
				path = decodeURIComponent(source.split(/[?#]/, 1)[0]);
			} catch {
				throw new Error(`图片路径编码无效：${source}`);
			}
			const imagePath = path.startsWith("/") ? path : posix.join(base, path);
			try {
				data = await readProjectFile(imagePath, options.workDir, options.container, MAX_IMAGE_BYTES);
			} catch (error) {
				throw new Error(`报告图片归档失败（${source}）：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (data.length > MAX_IMAGE_BYTES) throw new Error(`单张图片超过 8 MB 上限：${source.slice(0, 200)}`);
		total += data.length;
		if (total > MAX_TOTAL_BYTES) throw new Error("报告和图片合计超过 32 MB 上限。");
		const type = imageType(data);
		const id = randomUUID();
		images.push({
			id,
			source,
			filename: `${id}.${type.extension}`,
			mimeType: type.mimeType,
			size: data.length,
			data,
		});
	}
	return options.store.save({ provenance: options.provenance, key: options.key, title, markdown, images });
}

/** Editing reuses archived evidence and never needs a running container or the original files. */
export function validateReportEdit(report: ReportDetail, title: string, markdown: string): void {
	if (!title.trim() || title.trim().length > 120 || /[\r\n]/.test(title))
		throw new Error("报告标题需要 1–120 个字符，且只能占一行。");
	if (!markdown.trim()) throw new Error("报告正文不能为空。");
	if (Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES) throw new Error("报告正文超过 1 MB 上限。");
	if (Buffer.byteLength(markdown) + report.images.reduce((sum, image) => sum + image.size, 0) > MAX_TOTAL_BYTES)
		throw new Error("报告和图片合计超过 32 MB 上限。");
	const archived = new Set(report.images.map((image) => image.source));
	for (const image of imageReferences(markdown)) {
		if (!archived.has(image.source))
			throw new Error(`图片尚未归档，请保留已有图片路径：${image.source.slice(0, 160)}`);
	}
}

/** Replaces actual Markdown image nodes, including reference-style images, without touching code examples. */
export function portableReportMarkdown(report: ReportDetail): string {
	const images = new Map(report.images.map((image) => [image.source, image.filename]));
	let markdown = report.markdown;
	for (const reference of imageReferences(markdown).reverse()) {
		const filename = images.get(reference.source);
		if (!filename) continue;
		const alt = reference.alt.replace(/[\\[\]]/g, "\\$&");
		const title = reference.title ? ` "${reference.title.replace(/[\\"]/g, "\\$&")}"` : "";
		markdown = `${markdown.slice(0, reference.start)}![${alt}](images/${filename}${title})${markdown.slice(reference.end)}`;
	}
	return markdown;
}

/** ZIP's stored format needs no external archiver and preserves exact Markdown/image bytes. */
export function reportZip(files: { name: string; data: Uint8Array }[]): Buffer {
	const entries: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.name, "utf8");
		const data = Buffer.from(file.data);
		const checksum = crc32(data);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(0x0800, 6);
		header.writeUInt16LE(0x0021, 12);
		header.writeUInt32LE(checksum, 14);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(data.length, 22);
		header.writeUInt16LE(name.length, 26);
		entries.push(header, name, data);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		header.copy(central, 6, 4, 30);
		central.writeUInt32LE(offset, 42);
		directory.push(central, name);
		offset += header.length + name.length + data.length;
	}
	const central = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...entries, central, end]);
}
