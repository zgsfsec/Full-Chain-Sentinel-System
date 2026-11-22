import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";
import type { WorkProcess, WorkProcessRef, WorkRevision } from "./work-process-types.ts";

export function workProcessKey(ref: WorkProcessRef): string {
	return JSON.stringify([ref.projectId, ref.kind, ref.id]);
}

/** Each analysis commits its graph, source cursor, and revision atomically. */
export class WorkProcessStore {
	private readonly db: SqliteDatabase;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = openSqliteDatabase(path);
		this.db.exec(`PRAGMA journal_mode=WAL;
			CREATE TABLE IF NOT EXISTS work_processes (
				key TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS work_process_project ON work_processes(project_id);
			CREATE TABLE IF NOT EXISTS work_process_revisions (
				key TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
				PRIMARY KEY (key, revision)
			);
			CREATE TABLE IF NOT EXISTS work_process_watchers (
				key TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL
			);`);
	}

	get(ref: WorkProcessRef): WorkProcess | null {
		const row = this.db.prepare("SELECT payload FROM work_processes WHERE key = ?").get(workProcessKey(ref)) as
			| { payload: string }
			| undefined;
		return row ? (JSON.parse(row.payload) as WorkProcess) : null;
	}

	list(projectId?: string): WorkProcess[] {
		const rows = (
			projectId
				? this.db.prepare("SELECT payload FROM work_processes WHERE project_id = ?").all(projectId)
				: this.db.prepare("SELECT payload FROM work_processes").all()
		) as { payload: string }[];
		return rows.map((row) => JSON.parse(row.payload) as WorkProcess);
	}

	watchers(): WorkProcessRef[] {
		const rows = this.db.prepare("SELECT project_id, kind, source_id FROM work_process_watchers").all() as {
			project_id: string;
			kind: WorkProcessRef["kind"];
			source_id: string;
		}[];
		return rows.map((row) => ({ projectId: row.project_id, kind: row.kind, id: row.source_id }));
	}

	save(process: WorkProcess, revision?: WorkRevision): void {
		const key = workProcessKey(process);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare("INSERT OR REPLACE INTO work_processes VALUES (?, ?, ?)")
				.run(key, process.projectId, JSON.stringify(process));
			if ((process.enabled && !process.error) || process.retry) {
				this.db
					.prepare("INSERT OR REPLACE INTO work_process_watchers VALUES (?, ?, ?, ?)")
					.run(key, process.projectId, process.kind, process.id);
			} else {
				this.db.prepare("DELETE FROM work_process_watchers WHERE key = ?").run(key);
			}
			if (revision) {
				this.db
					.prepare("INSERT OR REPLACE INTO work_process_revisions VALUES (?, ?, ?)")
					.run(key, revision.revision, JSON.stringify(revision));
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	revisions(ref: WorkProcessRef, nodeId: string): WorkRevision[] {
		const rows = this.db
			.prepare("SELECT payload FROM work_process_revisions WHERE key = ? ORDER BY revision DESC")
			.all(workProcessKey(ref)) as { payload: string }[];
		return rows
			.map((row) => JSON.parse(row.payload) as WorkRevision)
			.filter((revision) => revision.nodes.some((node) => node.id === nodeId));
	}

	delete(ref: WorkProcessRef): void {
		const key = workProcessKey(ref);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("DELETE FROM work_process_revisions WHERE key = ?").run(key);
			this.db.prepare("DELETE FROM work_processes WHERE key = ?").run(key);
			this.db.prepare("DELETE FROM work_process_watchers WHERE key = ?").run(key);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.db.close();
	}
}
