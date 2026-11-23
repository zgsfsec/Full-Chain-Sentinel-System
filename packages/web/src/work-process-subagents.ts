import { existsSync } from "node:fs";
import type { SentinelSubagentEvent, SentinelSubagentRun } from "./protocol.ts";
import { openSqliteDatabase } from "./sqlite.ts";
import { subagentDbPath } from "./subagent-store.ts";

interface RunRow {
	id: string;
	session_id: string;
	task: string;
	status: SentinelSubagentRun["status"];
	turns: number;
	started_at: string;
	ended_at: string | null;
	result: string | null;
	error: string | null;
}

/** Read all retained children of this exact project/session, including inactive chats. */
export function recordedWorkSubagents(agentDir: string, projectId: string, sessionId: string): SentinelSubagentRun[] {
	const path = subagentDbPath(agentDir);
	if (!existsSync(path)) return [];
	const db = openSqliteDatabase(path, { readOnly: true });
	try {
		db.exec("PRAGMA busy_timeout = 1000; BEGIN");
		const rows = db
			.prepare(`SELECT id, session_id, task, status, turns, started_at, ended_at, result, error
			FROM subagent_runs WHERE project_id = ? AND session_id = ? ORDER BY started_at, id`)
			.all(projectId, sessionId) as RunRow[];
		return rows.map((row) => {
			const events: SentinelSubagentEvent[] = [];
			const records = db
				.prepare("SELECT payload FROM subagent_events WHERE run_id = ? AND kind <> 'thinking' ORDER BY seq")
				.all(row.id) as { payload: string }[];
			for (const record of records) {
				try {
					events.push(JSON.parse(record.payload) as SentinelSubagentEvent);
				} catch {
					/* Keep the other retained steps when one row is corrupt. */
				}
			}
			return {
				id: row.id,
				sessionId: row.session_id,
				task: row.task,
				status: row.status,
				turns: row.turns,
				startedAt: row.started_at,
				...(row.ended_at ? { endedAt: row.ended_at } : {}),
				...(row.result ? { result: row.result } : {}),
				...(row.error ? { error: row.error } : {}),
				events,
			};
		});
	} finally {
		db.close();
	}
}
