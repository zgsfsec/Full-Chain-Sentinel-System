/** Project-scoped reports shared by the agent tools, HTTP API and console. */
export type ReportSource = "session" | "goal" | "engine";

export interface ReportTemplateSummary {
	id: string;
	name: string;
	revision: string;
	createdAt: string;
	updatedAt: string;
}

export interface ReportTemplate extends ReportTemplateSummary {
	markdown: string;
}

/** Frozen when a conversation or engine applies a template. */
export type ReportTemplateSnapshot = Pick<ReportTemplate, "id" | "name" | "revision" | "markdown">;

export interface ReportTemplateList {
	items: ReportTemplateSummary[];
	defaultTemplateId: string | null;
}

export interface ReportProvenance {
	reportTemplate?: ReportTemplateSnapshot | null;
	projectId: string;
	projectName: string;
	source: ReportSource;
	sessionId?: string;
	sessionName?: string;
	goalId?: string;
	engineId?: string;
	engineName?: string;
	taskId?: string;
	taskName?: string;
}

export interface ReportImage {
	id: string;
	source: string;
	filename: string;
	mimeType: string;
	size: number;
}

export interface ReportAttachment {
	id: string;
	/** Original Markdown reference or evidence path. */
	source: string;
	/** Relative path inside the downloaded ZIP. */
	filename: string;
	size: number;
}

export interface ReportSummary extends ReportProvenance {
	id: string;
	title: string;
	createdAt: string;
	imageCount: number;
	size: number;
}

export interface ReportDetail extends ReportSummary {
	markdown: string;
	images: ReportImage[];
	attachments: ReportAttachment[];
	revision: string;
}

export interface ReportPage {
	items: ReportSummary[];
	total: number;
	page: number;
	pageSize: number;
}
