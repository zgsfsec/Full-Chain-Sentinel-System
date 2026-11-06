/** Project-scoped reports shared by the agent tools, HTTP API and console. */
export type ReportSource = "session" | "goal" | "engine";

export interface ReportProvenance {
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
}

export interface ReportPage {
	items: ReportSummary[];
	total: number;
	page: number;
	pageSize: number;
}
