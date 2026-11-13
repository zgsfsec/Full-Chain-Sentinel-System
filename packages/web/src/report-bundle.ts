/** Assemble downloads from immutable snapshots, with best-effort collection for older reports. */
import { listProjects } from "./projects.ts";
import { collectReportAttachments } from "./report-attachments.ts";
import { portableReportMarkdown, reportZip } from "./report-content.ts";
import type { ReportDetail } from "./report-types.ts";
import type { ArchivedReportAttachment, ReportStore } from "./reports.ts";

export async function buildReportBundle(store: ReportStore, report: ReportDetail): Promise<Buffer> {
	let attachments: ArchivedReportAttachment[];
	if (report.attachments.some((file) => file.filename === "manifest.json")) {
		attachments = report.attachments.map((file) => {
			const saved = store.attachment(report.projectId, report.id, file.id);
			if (!saved) throw new Error(`报告附件缺失，无法下载完整报告：${file.filename}`);
			return saved;
		});
	} else {
		const project = listProjects(store.agentDir).projects.find((entry) => entry.id === report.projectId);
		attachments = await collectReportAttachments({
			agentDir: store.agentDir,
			provenance: report,
			markdown: report.markdown,
			workDir: project?.workDir,
			container: project?.container,
			reservedBytes:
				Buffer.byteLength(report.markdown) + report.images.reduce((total, image) => total + image.size, 0),
		});
	}
	const files = [{ name: "report.md", data: Buffer.from(portableReportMarkdown(report, attachments), "utf8") }];
	for (const image of report.images) {
		const saved = store.image(report.projectId, report.id, image.id);
		if (!saved) throw new Error("报告图片缺失，无法下载完整报告。");
		files.push({ name: `images/${image.filename}`, data: Buffer.from(saved.data) });
	}
	for (const file of attachments) files.push({ name: file.filename, data: Buffer.from(file.data) });
	return reportZip(files);
}
