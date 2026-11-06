import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { submitReport } from "./report-content.ts";
import type { ReportProvenance } from "./report-types.ts";
import type { ReportStore } from "./reports.ts";

export function createReportTool(options: {
	store: ReportStore;
	provenance: () => ReportProvenance | undefined;
	workDir: string;
	container?: string;
}): ToolDefinition {
	return defineTool({
		name: "report_submit",
		label: "Submit report",
		description:
			"Archive a completed Markdown report in the current session's project report center, together with every referenced local image. Provide either markdown (relative images use /work) or path (relative images use the Markdown file's directory). Accepts /work paths or host paths inside this project. Returns a report id only after all images are saved. Does not terminate the task.",
		promptSnippet: "Submit the completed task's Markdown report and images to the project's report center",
		promptGuidelines: [
			"Before ending a substantive assessment or autonomous goal, proactively submit a Markdown report with report_submit. Ordinary questions and short explanations do not need reports; do not submit a report for every intermediate round.",
			"Report the actual scope, methods, evidence, outcomes, vulnerability hub references, limitations and recommendations. Zero confirmed findings is a valid outcome; never invent evidence or convert unfinished work into a success.",
			"Submit validated findings to the vulnerability hub first. Then submit the final report before goal_complete or the final answer. Report submission does not itself end a goal or task.",
			"Use standard Markdown image syntax for evidence images. Local files and base64 data images are archived. Download remote images into the project first; do not include external image URLs. Correct missing images and retry if submission fails.",
		],
		parameters: Type.Object({
			title: Type.String({
				minLength: 1,
				maxLength: 120,
				description: "One-line report title identifying the task and target.",
			}),
			markdown: Type.Optional(
				Type.String({
					minLength: 1,
					description: "The complete Markdown body, including standard image references. Exclusive with path.",
				}),
			),
			path: Type.Optional(
				Type.String({
					minLength: 1,
					description:
						"Existing Markdown file in this project's work directory, e.g. /work/reports/final.md. Exclusive with markdown.",
				}),
			),
		}),
		async execute(
			toolCallId,
			params,
		): Promise<AgentToolResult<{ ok: boolean; id?: string; imageCount?: number; error?: string }>> {
			try {
				const provenance = options.provenance();
				if (!provenance) throw new Error("尚未选择项目，无法提交报告。");
				const report = await submitReport({
					...options,
					provenance,
					key: `${provenance.sessionId ?? "session"}:${toolCallId}`,
					...params,
				});
				return {
					content: [
						{
							type: "text",
							text: `报告已归档到报告中心：${report.title}（编号 ${report.id}，${report.imageCount} 张图片）。现在可以正常结束任务；自主目标仍需按实际结果调用 goal_complete。`,
						},
					],
					details: { ok: true, id: report.id, imageCount: report.imageCount },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `报告提交失败：${message}` }],
					details: { ok: false, error: message },
					isError: true,
				};
			}
		},
	});
}
