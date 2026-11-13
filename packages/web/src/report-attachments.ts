/** Snapshot only evidence associated with this report, never the entire workspace. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { posix } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { SentinelVulnerability } from "./protocol.ts";
import { readProjectFile } from "./report-files.ts";
import type { ReportAttachment, ReportProvenance } from "./report-types.ts";
import type { ArchivedReportAttachment } from "./reports.ts";
import { VulnerabilityStore, vulnerabilityDbPath } from "./vulnerabilities.ts";

export const REPORT_BUNDLE_MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 256;

interface LinkNode {
	type: string;
	url?: string;
	identifier?: string;
	children?: LinkNode[];
	position?: { start: { offset?: number }; end: { offset?: number } };
}

function localLinks(markdown: string): { source: string; label: string; start: number; end: number }[] {
	const nodes: LinkNode[] = [];
	const visit = (node: LinkNode): void => {
		nodes.push(node);
		for (const child of node.children ?? []) visit(child);
	};
	visit(fromMarkdown(markdown));
	const definitions = new Map<string, LinkNode>();
	for (const node of nodes) {
		if (node.type === "definition" && node.identifier && !definitions.has(node.identifier))
			definitions.set(node.identifier, node);
	}
	return nodes.flatMap((node) => {
		const target =
			node.type === "link"
				? node
				: node.type === "linkReference" && node.identifier
					? definitions.get(node.identifier)
					: undefined;
		const source = target?.url;
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (
			!source ||
			/^[a-z][a-z0-9+.-]*:/i.test(source) ||
			source.startsWith("//") ||
			source.startsWith("#") ||
			start === undefined ||
			end === undefined
		)
			return [];
		const labelStart = node.children?.[0]?.position?.start.offset;
		const labelEnd = node.children?.at(-1)?.position?.end.offset;
		const label = labelStart !== undefined && labelEnd !== undefined ? markdown.slice(labelStart, labelEnd) : "";
		return [{ source, label, start, end }];
	});
}

/** Use the same project/session/task provenance as the report, including all tasks for engine totals. */
function relatedVulnerabilities(agentDir: string, provenance: ReportProvenance): SentinelVulnerability[] {
	const path = vulnerabilityDbPath(agentDir);
	if (!existsSync(path) || (!provenance.engineId && !provenance.sessionId)) return [];
	const store = new VulnerabilityStore(path);
	try {
		const filters = provenance.engineId
			? { engineId: provenance.engineId, ...(provenance.taskId ? { taskId: provenance.taskId } : {}) }
			: { sessionId: provenance.sessionId };
		return store.list(provenance.projectId, filters).flatMap((summary) => {
			const finding = store.get(summary.id);
			return finding?.projectId === provenance.projectId ? [finding] : [];
		});
	} finally {
		store.close();
	}
}

export async function collectReportAttachments(options: {
	agentDir: string;
	provenance: ReportProvenance;
	markdown: string;
	base?: string;
	workDir?: string;
	container?: string;
	paths?: string[];
	reservedBytes: number;
}): Promise<ArchivedReportAttachment[]> {
	const files: ArchivedReportAttachment[] = [];
	const warnings: { source: string; reason: string }[] = [];
	const findings: { id: string; label: string; directory: string }[] = [];
	let total = options.reservedBytes;
	const add = (source: string, filename: string, data: Buffer): void => {
		if (
			files.length >= MAX_FILES ||
			data.length > MAX_FILE_BYTES ||
			total + data.length > REPORT_BUNDLE_MAX_BYTES - 1024 * 1024
		) {
			warnings.push({ source, reason: "超过附件数量或大小上限（256 个、单文件 16 MB、完整包 128 MB）。" });
			return;
		}
		total += data.length;
		files.push({ id: randomUUID(), source, filename, size: data.length, data });
	};
	const snapshot = async (source: string, directory: string, markdownUrl = false): Promise<void> => {
		try {
			if (files.length >= MAX_FILES || total >= REPORT_BUNDLE_MAX_BYTES - 1024 * 1024)
				throw new Error("已达到报告附件数量或总大小上限。");
			if (!options.workDir) throw new Error("项目工作目录不可用，无法补收原始文件。");
			const decoded = markdownUrl ? decodeURIComponent(source.split(/[?#]/, 1)[0]) : source;
			if (!decoded || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith("//"))
				throw new Error("只支持项目内本地文件。");
			const path = decoded.startsWith("/") ? decoded : posix.join(options.base ?? "/work", decoded);
			const data = await readProjectFile(path, options.workDir, options.container, MAX_FILE_BYTES);
			const name =
				posix
					.basename(path)
					.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
					.slice(0, 120) || "file";
			add(source, `${directory}/${randomUUID()}/${name}`, data);
		} catch (error) {
			warnings.push({ source, reason: error instanceof Error ? error.message : String(error) });
		}
	};
	const paths = new Map<string, boolean>([
		...localLinks(options.markdown).map((link): [string, boolean] => [link.source, true]),
		...(options.paths ?? []).map((path): [string, boolean] => [path, false]),
	]);
	for (const [source, markdownUrl] of [...paths].slice(0, MAX_FILES))
		await snapshot(source, "attachments", markdownUrl);
	if (paths.size > MAX_FILES) warnings.push({ source: "attachments", reason: `仅收集前 ${MAX_FILES} 个附件引用。` });
	for (const finding of relatedVulnerabilities(options.agentDir, options.provenance)) {
		const directory = `vulnerabilities/${finding.id}`;
		findings.push({ id: finding.id, label: finding.label, directory });
		add(`${finding.id}:finding`, `${directory}/finding.json`, Buffer.from(JSON.stringify(finding, null, 2)));
		// Keep the original packet exactly; it may contain a request, response, or both.
		add(`${finding.id}:packet`, `${directory}/packet.txt`, Buffer.from(finding.packet));
		if (finding.repro) add(`${finding.id}:reproduction`, `${directory}/reproduction.md`, Buffer.from(finding.repro));
		for (const [index, evidence] of finding.evidence.entries()) {
			const prefix = `${directory}/evidence/${index + 1}`;
			if (evidence.command !== undefined)
				add(`${finding.id}:command:${index}`, `${prefix}-command.txt`, Buffer.from(evidence.command));
			if (evidence.output !== undefined)
				add(`${finding.id}:output:${index}`, `${prefix}-output.txt`, Buffer.from(evidence.output));
			if (evidence.path) await snapshot(evidence.path, `${prefix}-files`);
		}
	}
	const { projectId, projectName, source, sessionId, sessionName, goalId, engineId, engineName, taskId, taskName } =
		options.provenance;
	const manifest = Buffer.from(
		JSON.stringify(
			{
				formatVersion: 1,
				collectedAt: new Date().toISOString(),
				provenance: {
					projectId,
					projectName,
					source,
					sessionId,
					sessionName,
					goalId,
					engineId,
					engineName,
					taskId,
					taskName,
				},
				files: files.map(({ data: _data, ...file }) => file),
				vulnerabilities: findings,
				warnings,
				note: "仅包含已保存的原始材料；packet.txt 保留漏洞中枢原始报文，未保存的响应不会补造。",
			},
			null,
			2,
		),
	);
	if (manifest.length > 1024 * 1024) throw new Error("报告附件清单超过 1 MB，请减少关联材料后重试。");
	files.push({
		id: randomUUID(),
		source: "bundle-manifest",
		filename: "manifest.json",
		size: manifest.length,
		data: manifest,
	});
	return files;
}

/** Rewrite actual local link nodes only; code examples and remote URLs stay intact. */
export function portableAttachmentLinks(markdown: string, attachments: ReportAttachment[]): string {
	const archived = new Map(attachments.map((file) => [file.source, file.filename]));
	for (const link of localLinks(markdown).reverse()) {
		const filename = archived.get(link.source);
		if (!filename) continue;
		const target = filename
			.split("/")
			.map((segment) => encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29"))
			.join("/");
		markdown = `${markdown.slice(0, link.start)}[${link.label}](${target})${markdown.slice(link.end)}`;
	}
	return markdown;
}

export function validateAttachmentLinks(markdown: string, original: string, attachments: ReportAttachment[]): void {
	const known = new Set([
		...attachments.map((file) => file.source),
		...localLinks(original).map((link) => link.source),
	]);
	for (const link of localLinks(markdown)) {
		if (!known.has(link.source))
			throw new Error(`附件尚未归档，请保留已有文件链接或重新提交报告：${link.source.slice(0, 160)}`);
	}
}
