/** Project reports and archived image bytes, outside container-mounted workspaces. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ReportAttachment,
	ReportDetail,
	ReportImage,
	ReportPage,
	ReportProvenance,
	ReportSource,
	ReportSummary,
} from "./report-types.ts";
import { openSqliteDatabase, type SqliteDatabase, type SqliteValue } from "./sqlite.ts";

export interface ArchivedReportImage extends ReportImage {
	data: Uint8Array;
}

export interface ArchivedReportAttachment extends ReportAttachment {
	data: Uint8Array;
}

interface ReportRow {
	id: string;
	title: string;
	provenance: string;
	markdown?: string;
	created_at: string;
	image_count: number;
	size: number;
}

interface ImageRow {
	id: string;
	source: string;
	filename: string;
	mime_type: string;
	size: number;
	data?: Uint8Array;
}

const SUMMARY_COLUMNS = "id, title, provenance, created_at, image_count, size";

function revision(title: string, markdown: string): string {
	return createHash("sha256")
		.update(JSON.stringify([title, markdown]))
		.digest("hex");
}

function summary(row: ReportRow): ReportSummary {
	return {
		...(JSON.parse(row.provenance) as ReportProvenance),
		id: row.id,
		title: row.title,
		createdAt: row.created_at,
		imageCount: row.image_count,
		size: row.size,
	};
}

function imageInfo(row: ImageRow): ReportImage {
	return { id: row.id, source: row.source, filename: row.filename, mimeType: row.mime_type, size: row.size };
}

export function reportsDbPath(agentDir: string): string {
	return join(agentDir, "reports.db");
}

export class ReportStore {
	private readonly db: SqliteDatabase;
	/** Report exports resolve the project's registry and vulnerability hub in this configuration directory. */
	readonly agentDir: string;

	constructor(path: string) {
		this.agentDir = dirname(path);
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA foreign_keys = ON;
			CREATE TABLE IF NOT EXISTS reports (
				id TEXT PRIMARY KEY, project_id TEXT NOT NULL, submission_key TEXT NOT NULL,
				title TEXT NOT NULL, provenance TEXT NOT NULL, source TEXT NOT NULL,
				markdown TEXT NOT NULL, created_at TEXT NOT NULL, image_count INTEGER NOT NULL,
				size INTEGER NOT NULL, UNIQUE(project_id, submission_key)
			);
			CREATE INDEX IF NOT EXISTS reports_project_date ON reports(project_id, created_at DESC, id DESC);
			CREATE TABLE IF NOT EXISTS report_images (
				id TEXT NOT NULL, report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
				source TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL,
				size INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(report_id, id)
			);
			CREATE TABLE IF NOT EXISTS report_attachments (
				id TEXT NOT NULL, report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
				source TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL,
				PRIMARY KEY(report_id, id)
			);
		`);
	}

	findSubmission(projectId: string, key: string): ReportDetail | undefined {
		const row = this.db
			.prepare("SELECT id FROM reports WHERE project_id = ? AND submission_key = ?")
			.get(projectId, key) as { id: string } | undefined;
		return row ? this.get(projectId, row.id) : undefined;
	}

	save(input: {
		provenance: ReportProvenance;
		key: string;
		title: string;
		markdown: string;
		images: ArchivedReportImage[];
		attachments?: ArchivedReportAttachment[];
	}): ReportDetail {
		const prior = this.findSubmission(input.provenance.projectId, input.key);
		if (prior) return prior;
		const id = randomUUID();
		const createdAt = new Date().toISOString();
		const attachments = input.attachments ?? [];
		const size =
			Buffer.byteLength(input.markdown) +
			input.images.reduce((total, image) => total + image.size, 0) +
			attachments.reduce((total, file) => total + file.size, 0);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare(
					"INSERT INTO reports (id, project_id, submission_key, title, provenance, source, markdown, created_at, image_count, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					input.provenance.projectId,
					input.key,
					input.title,
					JSON.stringify(input.provenance),
					input.provenance.source,
					input.markdown,
					createdAt,
					input.images.length,
					size,
				);
			const insertImage = this.db.prepare(
				"INSERT INTO report_images (id, report_id, source, filename, mime_type, size, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
			);
			for (const image of input.images)
				insertImage.run(image.id, id, image.source, image.filename, image.mimeType, image.size, image.data);
			const insertAttachment = this.db.prepare(
				"INSERT INTO report_attachments (id, report_id, source, filename, size, data) VALUES (?, ?, ?, ?, ?, ?)",
			);
			for (const file of attachments)
				insertAttachment.run(file.id, id, file.source, file.filename, file.size, file.data);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return {
			...input.provenance,
			id,
			title: input.title,
			markdown: input.markdown,
			images: input.images.map(({ data: _data, ...image }) => image),
			attachments: attachments.map(({ data: _data, ...file }) => file),
			createdAt,
			imageCount: input.images.length,
			size,
			revision: revision(input.title, input.markdown),
		};
	}

	list(
		projectId: string,
		options: { search?: string; source?: ReportSource; page?: number; pageSize?: number } = {},
	): ReportPage {
		const conditions = ["project_id = ?"];
		const values: SqliteValue[] = [projectId];
		if (options.search?.trim()) {
			conditions.push("(instr(lower(title), lower(?)) > 0 OR instr(lower(provenance), lower(?)) > 0)");
			values.push(options.search.trim(), options.search.trim());
		}
		if (options.source) {
			conditions.push("source = ?");
			values.push(options.source);
		}
		const where = conditions.join(" AND ");
		const total = (
			this.db.prepare(`SELECT COUNT(*) AS count FROM reports WHERE ${where}`).get(...values) as { count: number }
		).count;
		const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 20)));
		const page = Math.min(Math.max(1, Math.ceil(total / pageSize)), Math.max(1, Math.floor(options.page ?? 1)));
		const rows = this.db
			.prepare(
				`SELECT ${SUMMARY_COLUMNS} FROM reports WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
			)
			.all(...values, pageSize, (page - 1) * pageSize) as ReportRow[];
		return { items: rows.map(summary), total, page, pageSize };
	}

	get(projectId: string, id: string): ReportDetail | undefined {
		const row = this.db
			.prepare(`SELECT ${SUMMARY_COLUMNS}, markdown FROM reports WHERE project_id = ? AND id = ?`)
			.get(projectId, id) as ReportRow | undefined;
		if (!row) return undefined;
		const images = this.db
			.prepare("SELECT id, source, filename, mime_type, size FROM report_images WHERE report_id = ? ORDER BY rowid")
			.all(id) as ImageRow[];
		const markdown = row.markdown ?? "";
		const attachments = this.db
			.prepare("SELECT id, source, filename, size FROM report_attachments WHERE report_id = ? ORDER BY rowid")
			.all(id) as ReportAttachment[];
		return {
			...summary(row),
			markdown,
			images: images.map(imageInfo),
			attachments,
			revision: revision(row.title, markdown),
		};
	}

	/** Compare-and-swap protects edits made in another browser while the editor was open. */
	updateText(
		projectId: string,
		id: string,
		expectedRevision: string,
		title: string,
		markdown: string,
	): ReportDetail | undefined {
		const current = this.get(projectId, id);
		if (!current || current.revision !== expectedRevision) return undefined;
		const size =
			Buffer.byteLength(markdown) +
			current.images.reduce((total, image) => total + image.size, 0) +
			current.attachments.reduce((total, file) => total + file.size, 0);
		const result = this.db
			.prepare(
				"UPDATE reports SET title = ?, markdown = ?, size = ? WHERE project_id = ? AND id = ? AND title = ? AND markdown = ?",
			)
			.run(title, markdown, size, projectId, id, current.title, current.markdown);
		return Number(result.changes) > 0 ? this.get(projectId, id) : undefined;
	}

	image(projectId: string, reportId: string, id: string): ArchivedReportImage | undefined {
		const row = this.db
			.prepare(
				"SELECT i.* FROM report_images i JOIN reports r ON r.id = i.report_id WHERE r.project_id = ? AND r.id = ? AND i.id = ?",
			)
			.get(projectId, reportId, id) as ImageRow | undefined;
		return row?.data ? { ...imageInfo(row), data: row.data } : undefined;
	}

	attachment(projectId: string, reportId: string, id: string): ArchivedReportAttachment | undefined {
		const row = this.db
			.prepare(
				"SELECT a.id, a.source, a.filename, a.size, a.data FROM report_attachments a JOIN reports r ON r.id = a.report_id WHERE r.project_id = ? AND r.id = ? AND a.id = ?",
			)
			.get(projectId, reportId, id) as ArchivedReportAttachment | undefined;
		return row;
	}

	delete(projectId: string, id: string): boolean {
		return (
			Number(
				this.db.prepare("DELETE FROM reports WHERE project_id = ? AND id = ?").run(projectId, id).changes ?? 0,
			) > 0
		);
	}

	purgeProject(projectId: string): number {
		return Number(this.db.prepare("DELETE FROM reports WHERE project_id = ?").run(projectId).changes ?? 0);
	}

	close(): void {
		this.db.close();
	}
}
