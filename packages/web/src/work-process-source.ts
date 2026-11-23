import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { getSessionDirPath, parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SentinelEngine, SentinelSubagentEvent } from "./protocol.ts";
import { redactWorkText as redact } from "./work-process-redact.ts";
import { recordedWorkSubagents } from "./work-process-subagents.ts";
import type {
	WorkEvidence,
	WorkNode,
	WorkNodeStatus,
	WorkProcessRef,
	WorkProcessSource,
	WorkSourceSnapshot,
} from "./work-process-types.ts";

export interface WorkProject {
	id: string;
	name: string;
	cwd: string;
}
export interface WorkProcessSources {
	list(projectId: string, kind: WorkProcessRef["kind"]): Promise<WorkProcessSource[]>;
	load(ref: WorkProcessRef): Promise<WorkSourceSnapshot>;
	original(ref: WorkProcessRef, entry: WorkEvidence): Promise<{ text: string; truncated: boolean }>;
}

interface SourceOptions {
	agentDir: string;
	projects(): WorkProject[];
	engines(): SentinelEngine[];
	commanderEvents(id: string): SentinelSubagentEvent[];
	taskEvents(id: string): SentinelSubagentEvent[];
	active(): { id: string | null; projectId: string | null; running: string[] };
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function visibleText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((value) => {
			const block = record(value);
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function evidence(input: Omit<WorkEvidence, "truncated"> & { truncated?: boolean }, limit = 6000): WorkEvidence {
	const text = redact(input.text);
	return { ...input, text: text.slice(0, limit), truncated: input.truncated === true || text.length > limit };
}

export function workStructuralNode(
	input: Pick<WorkNode, "id" | "ownerId" | "parentId" | "kind" | "title" | "startedAt"> & Partial<WorkNode>,
): WorkNode {
	return {
		intentBasis: "explicit",
		status: "unknown",
		actions: [],
		evidenceIds: [],
		confidence: null,
		revision: 0,
		updatedAt: input.startedAt,
		...input,
		title: redact(input.title).slice(0, 200),
		intent: redact(input.intent ?? "").slice(0, 2000),
		outcomes: (input.outcomes ?? []).map((outcome) => redact(outcome).slice(0, 2000)),
	};
}

/** Reads existing records only. Opening a SessionManager would migrate/write old files. */
export function sessionWorkEvidence(content: string, ownerId: string, limit = 6000): WorkEvidence[] {
	const result: WorkEvidence[] = [];
	for (const entry of parseSessionEntries(content)) {
		if (!entry || entry.type !== "message" || typeof entry.id !== "string") continue;
		const message = record(entry.message);
		const at = Date.parse(entry.timestamp) || 0;
		const base = { ownerId, at, entryId: entry.id };
		const text = visibleText(message.content);
		if ((message.role === "user" || message.role === "assistant") && text.trim()) {
			result.push(evidence({ ...base, id: `${ownerId}:${entry.id}:text`, kind: message.role, text }, limit));
		}
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const raw of message.content) {
				const block = record(raw);
				if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
				result.push(
					evidence(
						{
							...base,
							id: `${ownerId}:call:${block.id}`,
							kind: "tool_start",
							toolCallId: block.id,
							toolName: block.name,
							status: "running",
							text: JSON.stringify(block.arguments) ?? "{}",
						},
						limit,
					),
				);
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			result.push(
				evidence(
					{
						...base,
						id: `${ownerId}:result:${message.toolCallId}`,
						kind: "tool_end",
						text,
						toolCallId: message.toolCallId,
						toolName: typeof message.toolName === "string" ? message.toolName : "tool",
						status: message.isError ? "error" : "ok",
					},
					limit,
				),
			);
		}
	}
	return result;
}

export function engineWorkEvidence(events: SentinelSubagentEvent[], ownerId: string, limit = 6000): WorkEvidence[] {
	return events
		.filter((event) => event.kind !== "thinking")
		.map((event) =>
			evidence(
				{
					id: `${ownerId}:event:${event.seq}`,
					ownerId,
					at: event.at,
					entryId: String(event.seq),
					kind:
						event.kind === "text"
							? event.from === "operator"
								? "user"
								: "assistant"
							: event.kind === "tool_start" || event.kind === "tool_end"
								? event.kind
								: "status",
					text:
						event.kind === "tool_start"
							? (JSON.stringify(event.args) ?? "{}")
							: (event.output ?? event.text ?? event.note ?? event.status ?? ""),
					...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
					...(event.toolName ? { toolName: event.toolName } : {}),
					...(event.kind === "tool_start"
						? { status: "running" as const }
						: event.kind === "tool_end"
							? { status: event.isError ? ("error" as const) : ("ok" as const) }
							: {}),
					truncated: event.truncated,
				},
				limit,
			),
		);
}

function taskStatus(status: string): WorkNodeStatus {
	if (status === "queued" || status === "scheduled") return "unknown";
	if (status === "completed") return "done";
	if (status === "stopped" || status === "aborted") return "abandoned";
	if (status === "paused") return "blocked";
	return status === "running" || status === "done" || status === "failed" || status === "blocked" ? status : "unknown";
}

/** Stored engine/task membership supplies the hierarchy even if an old event was truncated. */
export function engineWorkSnapshot(
	engine: SentinelEngine,
	commander: SentinelSubagentEvent[],
	taskEvents: (id: string) => SentinelSubagentEvent[],
): WorkSourceSnapshot {
	const briefText = engine.targets.map((target) => `${target.target} ${target.note ?? ""}`).join("\n");
	const brief = evidence({
		id: `${engine.id}:brief:${createHash("sha256").update(briefText).digest("hex").slice(0, 16)}`,
		ownerId: engine.id,
		at: engine.createdAt,
		kind: "instruction",
		text: briefText,
		entryId: engine.id,
	});
	const root = workStructuralNode({
		id: "root",
		ownerId: engine.id,
		parentId: null,
		kind: "root",
		title: engine.name,
		intent: briefText,
		evidenceIds: [brief.id],
		startedAt: engine.createdAt,
		updatedAt: engine.endedAt ?? engine.startedAt ?? engine.createdAt,
		status: taskStatus(engine.status),
	});
	const actor = workStructuralNode({
		id: `commander:${engine.id}`,
		ownerId: engine.id,
		parentId: root.id,
		kind: "agent",
		title: "指挥 Agent",
		intent: "分解工程目标并协调任务执行",
		evidenceIds: [brief.id],
		startedAt: engine.startedAt ?? engine.createdAt,
		status: root.status,
	});
	const snapshot: WorkSourceSnapshot = {
		source: {
			projectId: engine.projectId,
			projectName: engine.projectName,
			kind: "engine",
			id: engine.id,
			title: engine.name,
			updatedAt: root.updatedAt,
			active: engine.status === "running",
		},
		nodes: [root, actor],
		edges: [
			{
				id: `contains:${actor.id}`,
				from: root.id,
				to: actor.id,
				kind: "contains",
				basis: "recorded",
				reason: "工程指挥关系",
				evidenceIds: [brief.id],
			},
		],
		lanes: [
			{ ownerId: engine.id, parentId: actor.id, evidence: [brief, ...engineWorkEvidence(commander, engine.id)] },
		],
	};
	for (const task of engine.tasks) {
		const id = `task:${task.id}`;
		const taskText = `任务：${task.title}\n目标：${task.objective}\n状态：${task.status}\n结论：${task.summary ?? task.error ?? "暂无"}`;
		const metadata = evidence({
			id: `${task.id}:task:${createHash("sha256").update(taskText).digest("hex").slice(0, 16)}`,
			ownerId: task.id,
			at: task.startedAt ?? engine.createdAt,
			entryId: task.id,
			kind: "instruction",
			text: taskText,
		});
		const dispatch = snapshot.lanes[0].evidence.filter(
			(event) =>
				event.kind === "tool_end" &&
				event.toolName === "dispatch_task" &&
				event.status === "ok" &&
				event.text.includes(task.id),
		);
		snapshot.nodes.push(
			workStructuralNode({
				id,
				ownerId: task.id,
				parentId: actor.id,
				kind: "task",
				title: task.title,
				intent: task.objective,
				status: taskStatus(task.status),
				startedAt: task.startedAt ?? engine.createdAt,
				updatedAt: task.endedAt ?? task.startedAt ?? engine.createdAt,
				outcomes: task.summary || task.error ? [task.summary ?? task.error ?? ""] : [],
				evidenceIds: [metadata.id],
			}),
		);
		snapshot.edges.push({
			id: `dispatch:${task.id}`,
			from: actor.id,
			to: id,
			kind: "dispatch",
			basis: "recorded",
			reason: "工程任务派发记录",
			evidenceIds: [metadata.id, ...dispatch.map((event) => event.id)],
		});
		snapshot.lanes.push({
			ownerId: task.id,
			parentId: id,
			evidence: [metadata, ...engineWorkEvidence(taskEvents(task.id), task.id)],
		});
	}
	if (engine.report) {
		const report = evidence({
			id: `${engine.id}:report`,
			ownerId: engine.id,
			at: engine.endedAt ?? root.updatedAt,
			entryId: engine.id,
			kind: "assistant",
			text: engine.report,
		});
		snapshot.lanes[0].evidence.push(report);
	}
	return snapshot;
}

export class RecordedWorkProcessSources implements WorkProcessSources {
	private readonly options: SourceOptions;
	private readonly files = new Map<string, { signature: string; title: string | null; evidence: WorkEvidence[] }>();

	constructor(options: SourceOptions) {
		this.options = options;
	}

	async list(projectId: string, kind: WorkProcessRef["kind"]): Promise<WorkProcessSource[]> {
		const project = this.options.projects().find((entry) => entry.id === projectId);
		if (!project) throw new Error("项目不存在");
		if (kind === "engine")
			return this.options
				.engines()
				.filter((engine) => engine.projectId === projectId)
				.map((engine) => ({
					id: engine.id,
					kind,
					projectId,
					projectName: project.name,
					title: engine.name,
					updatedAt: engine.endedAt ?? engine.startedAt ?? engine.createdAt,
					active: engine.status === "running",
				}));
		const active = this.options.active();
		const sessions = await SessionManager.list(project.cwd, getSessionDirPath(project.cwd, this.options.agentDir));
		const result: WorkProcessSource[] = sessions.map((session) => ({
			id: session.id,
			kind,
			projectId,
			projectName: project.name,
			title: session.name || session.firstMessage.slice(0, 100) || "未命名对话",
			updatedAt: session.modified.getTime(),
			active: active.running.includes(session.id),
		}));
		if (active.projectId === projectId && active.id && !result.some((source) => source.id === active.id)) {
			result.unshift({
				id: active.id,
				kind,
				projectId,
				projectName: project.name,
				title: "新对话",
				updatedAt: Date.now(),
				active: false,
			});
		}
		return result;
	}

	private appendSubagents(snapshot: WorkSourceSnapshot, sessionId: string, parentId: string, limit: number): void {
		for (const run of recordedWorkSubagents(this.options.agentDir, snapshot.source.projectId, sessionId)) {
			const ownerId = `subagent:${run.id}`;
			const startedAt = Date.parse(run.startedAt) || 0;
			const updatedAt = Math.max(startedAt, Date.parse(run.endedAt ?? "") || run.events?.at(-1)?.at || 0);
			const brief = evidence(
				{ id: `${ownerId}:task`, ownerId, at: startedAt, entryId: run.id, kind: "instruction", text: run.task },
				limit,
			);
			const statusText = `状态：${run.status}${run.error ? `\n错误：${run.error}` : ""}`;
			const status = evidence(
				{
					id: `${ownerId}:status:${createHash("sha256")
						.update(statusText + (run.endedAt ?? ""))
						.digest("hex")
						.slice(0, 16)}`,
					ownerId,
					at: run.status === "running" ? startedAt : updatedAt,
					entryId: run.id,
					kind: "status",
					text: statusText,
					truncated: run.error?.endsWith("\n…（已截断）") ?? false,
				},
				limit,
			);
			const records = [brief, ...engineWorkEvidence(run.events ?? [], ownerId, limit), status];
			if (run.result)
				records.push(
					evidence(
						{
							id: `${ownerId}:result`,
							ownerId,
							at: updatedAt,
							entryId: run.id,
							kind: "assistant",
							text: run.result,
							truncated: run.result.endsWith("\n…（已截断）"),
						},
						limit,
					),
				);
			snapshot.nodes.push(
				workStructuralNode({
					id: ownerId,
					ownerId,
					parentId,
					kind: "agent",
					title: `子 Agent：${run.task}`,
					intent: run.task,
					status: run.status === "error" ? "failed" : taskStatus(run.status),
					startedAt,
					updatedAt,
					evidenceIds: [brief.id, status.id, ...(run.result ? [`${ownerId}:result`] : [])],
					outcomes: [run.result, run.error].filter((value): value is string => Boolean(value)),
				}),
			);
			snapshot.edges.push({
				id: `dispatch:${ownerId}`,
				from: parentId,
				to: ownerId,
				kind: "dispatch",
				basis: "recorded",
				reason: "spawn_agent 父会话与子 Agent 派发记录",
				evidenceIds: [brief.id],
			});
			snapshot.lanes.push({ ownerId, parentId: ownerId, evidence: records });
			snapshot.source.active ||= run.status === "running";
			snapshot.source.updatedAt = Math.max(snapshot.source.updatedAt, updatedAt);
		}
	}

	async load(ref: WorkProcessRef, subagentEvidenceLimit = 6000): Promise<WorkSourceSnapshot> {
		const project = this.options.projects().find((entry) => entry.id === ref.projectId);
		if (!project) throw new Error("项目不存在");
		if (ref.kind === "engine") {
			const engine = this.options.engines().find((entry) => entry.id === ref.id && entry.projectId === project.id);
			if (!engine) throw new Error("工程不存在");
			const snapshot = engineWorkSnapshot(engine, this.options.commanderEvents(engine.id), this.options.taskEvents);
			for (const task of engine.tasks)
				if (task.sessionId)
					this.appendSubagents(snapshot, task.sessionId, `task:${task.id}`, subagentEvidenceLimit);
			return snapshot;
		}
		const path = SessionManager.findById(project.cwd, ref.id, getSessionDirPath(project.cwd, this.options.agentDir));
		const active = this.options.active();
		if (!path && !(active.id === ref.id && active.projectId === ref.projectId)) throw new Error("对话不存在");
		let entries: WorkEvidence[] = [];
		let sessionTitle: string | null = null;
		let updatedAt = Date.now();
		if (path) {
			const info = await stat(path);
			updatedAt = info.mtimeMs;
			const signature = `${info.size}:${info.mtimeMs}`;
			let cached = this.files.get(path);
			if (!cached || cached.signature !== signature) {
				const content = await readFile(path, "utf8");
				const info = [...parseSessionEntries(content)].reverse().find((entry) => entry?.type === "session_info");
				cached = {
					signature,
					title: info?.type === "session_info" && typeof info.name === "string" ? redact(info.name) : null,
					evidence: sessionWorkEvidence(content, ref.id),
				};
				if (this.files.size >= 24 && !this.files.has(path)) {
					const oldest = this.files.keys().next().value;
					if (oldest) this.files.delete(oldest);
				}
				this.files.set(path, cached);
			}
			entries = cached.evidence;
			sessionTitle = cached.title;
		}
		const first = entries.find((entry) => entry.kind === "user");
		const title = sessionTitle || first?.text.slice(0, 100) || "新对话";
		const snapshot: WorkSourceSnapshot = {
			source: { ...ref, projectName: project.name, title, updatedAt, active: active.running.includes(ref.id) },
			nodes: [
				workStructuralNode({
					id: "root",
					ownerId: ref.id,
					parentId: null,
					kind: "root",
					title,
					intent: first?.text ?? "",
					status: active.running.includes(ref.id) ? "running" : "unknown",
					evidenceIds: first ? [first.id] : [],
					startedAt: entries[0]?.at ?? updatedAt,
				}),
			],
			edges: [],
			lanes: [{ ownerId: ref.id, parentId: "root", evidence: entries }],
		};
		this.appendSubagents(snapshot, ref.id, "root", subagentEvidenceLimit);
		return snapshot;
	}

	async original(ref: WorkProcessRef, entry: WorkEvidence): Promise<{ text: string; truncated: boolean }> {
		let found: WorkEvidence | undefined;
		if (entry.ownerId.startsWith("subagent:")) {
			const snapshot = await this.load(ref, 256_000);
			found = snapshot.lanes
				.flatMap((lane) => lane.evidence)
				.find((item) => item.id === entry.id && item.ownerId === entry.ownerId);
			// Earlier metadata revisions live in the saved graph after the run changes state.
			if (
				!found &&
				entry.kind === "status" &&
				entry.id.startsWith(`${entry.ownerId}:status:`) &&
				snapshot.nodes.some((node) => node.id === entry.ownerId && entry.ownerId === `subagent:${entry.entryId}`)
			)
				found = entry;
		} else if (ref.kind === "session") {
			const project = this.options.projects().find((project) => project.id === ref.projectId);
			const path = project
				? SessionManager.findById(project.cwd, ref.id, getSessionDirPath(project.cwd, this.options.agentDir))
				: undefined;
			if (path)
				found = sessionWorkEvidence(await readFile(path, "utf8"), ref.id, 256_000).find(
					(item) => item.id === entry.id,
				);
		} else {
			const engine = this.options
				.engines()
				.find((engine) => engine.id === ref.id && engine.projectId === ref.projectId);
			if (engine && entry.ownerId === engine.id) {
				found = engineWorkEvidence(this.options.commanderEvents(engine.id), engine.id, 256_000).find(
					(item) => item.id === entry.id,
				);
				if (entry.id.startsWith(`${engine.id}:brief:`)) found = entry;
				if (entry.id === `${engine.id}:report` && engine.report)
					found = evidence({ ...entry, text: engine.report, truncated: false }, 256_000);
			} else if (engine?.tasks.some((task) => task.id === entry.ownerId)) {
				found = engineWorkEvidence(this.options.taskEvents(entry.ownerId), entry.ownerId, 256_000).find(
					(item) => item.id === entry.id,
				);
				if (entry.id.startsWith(`${entry.ownerId}:task:`)) found = entry;
			}
		}
		if (!found) throw new Error("原始记录不存在或已删除");
		return { text: found.text, truncated: found.truncated };
	}
}

export function workEvidenceFingerprint(entry: WorkEvidence): string {
	return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}
