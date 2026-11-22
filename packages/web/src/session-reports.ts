/** Report-center tools are an explicit, branch-local choice for ordinary conversations. */
import type { ReportTemplateSnapshot } from "./report-types.ts";

export const SESSION_REPORTS_CUSTOM_TYPE = "sentinel-reports";
export const SESSION_REPORT_TEMPLATE_CUSTOM_TYPE = "sentinel-report-template";

/** undefined means no selection yet; null explicitly selects free-form reporting. */
export function readSessionReportTemplate(entries: readonly unknown[]): ReportTemplateSnapshot | null | undefined {
	let template: ReportTemplateSnapshot | null | undefined;
	for (const entry of entries) {
		if (
			!entry ||
			typeof entry !== "object" ||
			!("customType" in entry) ||
			entry.customType !== SESSION_REPORT_TEMPLATE_CUSTOM_TYPE ||
			!("type" in entry) ||
			entry.type !== "custom" ||
			!("data" in entry)
		)
			continue;
		const value = entry.data;
		if (value === null) template = null;
		else if (
			value &&
			typeof value === "object" &&
			"id" in value &&
			typeof value.id === "string" &&
			"name" in value &&
			typeof value.name === "string" &&
			"revision" in value &&
			typeof value.revision === "string" &&
			"markdown" in value &&
			typeof value.markdown === "string"
		)
			template = { id: value.id, name: value.name, revision: value.revision, markdown: value.markdown };
	}
	return template;
}

/** Missing or cleared entries mean off, including conversations created before the switch existed. */
export function readSessionReports(entries: readonly unknown[]): boolean {
	let enabled = false;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const value = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (value.type !== "custom" || value.customType !== SESSION_REPORTS_CUSTOM_TYPE) continue;
		if (value.data === null) enabled = false;
		else if (typeof value.data === "object") {
			const next = (value.data as { enabled?: unknown }).enabled;
			if (typeof next === "boolean") enabled = next;
		}
	}
	return enabled;
}
