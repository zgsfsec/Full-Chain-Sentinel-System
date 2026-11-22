import { type AuxiliaryModelReply, completeAuxiliaryModel, resolveAuxiliaryModel } from "./auxiliary-model.ts";
import { applyWorkProcessAnalysis, buildWorkProcessInput, WORK_PROCESS_PROMPT } from "./work-process-analysis.ts";
import { type WorkProcessSources, workEvidenceFingerprint } from "./work-process-source.ts";
import { type WorkProcessStore, workProcessKey } from "./work-process-store.ts";
import type { WorkProcess, WorkProcessItem, WorkProcessRef, WorkSourceSnapshot } from "./work-process-types.ts";

export type WorkProcessCompletion = (
	input: string,
	signal: AbortSignal,
) => Promise<AuxiliaryModelReply & { model: string }>;

function initial(snapshot: WorkSourceSnapshot): WorkProcess {
	return {
		...snapshot.source,
		enabled: false,
		running: false,
		error: null,
		nodes: [],
		edges: [],
		evidence: [],
		consumed: {},
		pending: 0,
		revision: 0,
		model: null,
		usage: { input: 0, output: 0, total: 0 },
		lastAnalyzedAt: null,
	};
}

function synchronize(process: WorkProcess, snapshot: WorkSourceSnapshot): WorkProcess {
	const evidence = new Map(process.evidence.map((entry) => [entry.id, entry]));
	for (const lane of snapshot.lanes) for (const entry of lane.evidence) evidence.set(entry.id, entry);
	const nodes = new Map(process.nodes.map((node) => [node.id, node]));
	for (const node of snapshot.nodes) nodes.set(node.id, node);
	const edges = new Map(process.edges.map((edge) => [edge.id, edge]));
	for (const edge of snapshot.edges) edges.set(edge.id, edge);
	return {
		...process,
		...snapshot.source,
		nodes: [...nodes.values()],
		edges: [...edges.values()],
		evidence: [...evidence.values()],
		pending: snapshot.lanes
			.flatMap((lane) => lane.evidence)
			.filter((entry) => process.consumed[entry.id] !== workEvidenceFingerprint(entry)).length,
	};
}

export function workProcessItem(process: WorkProcess): WorkProcessItem {
	const latest = [...process.nodes].reverse().find((node) => node.kind === "step");
	return {
		projectId: process.projectId,
		projectName: process.projectName,
		kind: process.kind,
		id: process.id,
		title: process.title,
		updatedAt: process.lastAnalyzedAt ?? process.updatedAt,
		active: process.active,
		enabled: process.enabled,
		state: process.retry
			? "retrying"
			: process.error
				? "error"
				: process.running
					? "analyzing"
					: process.enabled
						? "watching"
						: process.revision
							? "paused"
							: "off",
		nodeCount: process.nodes.filter((node) => node.kind === "step" || node.kind === "goal").length,
		pending: process.pending,
		intent: latest?.intent ?? "",
	};
}

/** One independent queue, two bounded model requests, and no execution/steering capability. */
export class WorkProcesses {
	private readonly store: WorkProcessStore;
	private readonly sources: WorkProcessSources;
	private readonly complete: WorkProcessCompletion;
	private readonly jobs = new Map<string, { ref: WorkProcessRef; once: boolean }>();
	private readonly running = new Map<string, AbortController>();
	private readonly lastLane = new Map<string, string>();
	private readonly versions = new Map<string, number>();
	private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;

	constructor(store: WorkProcessStore, sources: WorkProcessSources, complete: WorkProcessCompletion) {
		this.store = store;
		this.sources = sources;
		this.complete = complete;
		// A crash cannot leave a persisted request claiming to still be in flight.
		for (const process of store.list()) {
			if (!process.retry && process.enabled && process.error)
				process.retry = { attempt: 1, at: Date.now() + 3000, once: false };
			if (process.running || process.retry) store.save({ ...process, running: false });
			if (process.retry) this.scheduleRetry(process, process.retry);
		}
	}

	private scheduleRetry(ref: WorkProcessRef, retry: NonNullable<WorkProcess["retry"]>): void {
		const key = workProcessKey(ref);
		clearTimeout(this.retryTimers.get(key));
		const timer = setTimeout(
			() => {
				this.retryTimers.delete(key);
				if (this.closed) return;
				const saved = this.store.get(ref)?.retry;
				if (saved?.at === retry.at && saved.attempt === retry.attempt) this.enqueue(ref, retry.once);
			},
			Math.max(0, retry.at - Date.now()),
		);
		timer.unref();
		this.retryTimers.set(key, timer);
	}

	start(): void {
		if (this.timer || this.closed) return;
		this.timer = setInterval(() => this.refresh(), 3000);
		this.timer.unref();
		this.refresh();
	}

	private refresh(): void {
		if (this.closed) return;
		for (const ref of this.store.watchers()) this.enqueue(ref, false);
	}

	async list(projectId: string, kind: WorkProcessRef["kind"]): Promise<WorkProcessItem[]> {
		const sources = await this.sources.list(projectId, kind);
		return sources.map((source) => {
			const saved = this.store.get(source);
			return saved
				? workProcessItem({ ...saved, ...source })
				: { ...source, enabled: false, state: "off", nodeCount: 0, pending: 0, intent: "" };
		});
	}

	async detail(ref: WorkProcessRef): Promise<WorkProcess> {
		const snapshot = await this.sources.load(ref);
		const saved = this.store.get(ref);
		return synchronize(saved ?? initial(snapshot), snapshot);
	}

	async control(ref: WorkProcessRef, action: "enable" | "pause" | "analyze" | "retry"): Promise<WorkProcess> {
		const paused = action === "pause" ? this.store.get(ref) : null;
		const snapshot = paused ? null : await this.sources.load(ref);
		if (this.closed) throw new Error("工作链路服务已关闭");
		const key = workProcessKey(ref);
		this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
		this.running.get(key)?.abort();
		clearTimeout(this.retryTimers.get(key));
		this.retryTimers.delete(key);
		this.jobs.delete(key);
		const current = this.store.get(ref) ?? (snapshot ? initial(snapshot) : paused);
		if (!current) throw new Error("工作链路不存在");
		const updated = {
			...current,
			enabled: action === "enable" ? true : action === "pause" ? false : current.enabled,
			running: false,
			error: null,
			retry: null,
		};
		const next = snapshot ? synchronize(updated, snapshot) : updated;
		next.running = action !== "pause" && next.pending > 0;
		this.store.save(next);
		if (action !== "pause") this.enqueue(ref, true);
		return next;
	}

	private enqueue(ref: WorkProcessRef, once: boolean): void {
		if (this.closed) return;
		const key = workProcessKey(ref);
		if (!this.jobs.has(key)) this.jobs.set(key, { ref, once });
		this.pump();
	}

	private pump(): void {
		if (this.closed) return;
		for (const [key, job] of this.jobs) {
			if (this.running.size >= 2) break;
			if (this.running.has(key)) continue;
			this.jobs.delete(key);
			const controller = new AbortController();
			this.running.set(key, controller);
			void this.run(job.ref, job.once, controller).finally(() => {
				this.running.delete(key);
				this.pump();
			});
		}
	}

	private async run(ref: WorkProcessRef, once: boolean, controller: AbortController): Promise<void> {
		const key = workProcessKey(ref);
		const version = this.versions.get(key) ?? 0;
		const current = (): boolean =>
			!this.closed && !controller.signal.aborted && version === (this.versions.get(key) ?? 0);
		try {
			if (!current()) return;
			let process = this.store.get(ref);
			if (!process) return;
			once ||= process.retry?.once ?? false;
			if (process.retry && process.retry.at > Date.now()) return;
			if ((process.error && !process.retry) || (!process.enabled && !once)) return;
			const snapshot = await this.sources.load(ref);
			if (!current()) return;
			const stored = process;
			process = synchronize(process, snapshot);
			const pendingLanes = snapshot.lanes.filter((lane) =>
				lane.evidence.some((entry) => process?.consumed[entry.id] !== workEvidenceFingerprint(entry)),
			);
			const lane = pendingLanes.find((entry) => entry.ownerId !== this.lastLane.get(key)) ?? pendingLanes[0];
			if (!lane) {
				const next = { ...process, running: false, error: null, retry: null };
				if (JSON.stringify(next) !== JSON.stringify(stored)) this.store.save(next);
				return;
			}
			this.lastLane.set(key, lane.ownerId);
			let batch = lane.evidence
				.filter((entry) => process?.consumed[entry.id] !== workEvidenceFingerprint(entry))
				.slice(0, process.batchSize ?? 12);
			if (
				!once &&
				process.active &&
				batch.length < 12 &&
				process.lastAnalyzedAt !== null &&
				Date.now() - process.lastAnalyzedAt < 15_000
			) {
				this.store.save({ ...process, running: false });
				return;
			}
			this.store.save({ ...process, running: true });
			let compact = process.compactAnalysis ?? false;
			const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
			let reply: Awaited<ReturnType<WorkProcessCompletion>>;
			// Retry only truncation. Each unsuccessful response leaves the graph and cursor untouched.
			while (true) {
				signal.throwIfAborted();
				reply = await this.complete(buildWorkProcessInput(process, lane, batch, compact), signal);
				if (!current()) return;
				process = {
					...process,
					model: reply.model,
					usage: {
						input: process.usage.input + reply.usage.input,
						output: process.usage.output + reply.usage.output,
						total: process.usage.total + reply.usage.total,
					},
				};
				if (reply.finishReason !== "length") {
					this.store.save({ ...process, running: true });
					break;
				}
				if (batch.length > 1) {
					batch = batch.slice(0, Math.max(1, Math.floor(batch.length / 2)));
					process.batchSize = batch.length;
				} else if (!compact) {
					compact = true;
					process.compactAnalysis = true;
				} else {
					this.store.save({ ...process, running: true });
					throw new Error(
						`工作链路模型输出被截断：已自动缩减至单条记录并使用精简输出，仍未完成（模型 ${reply.model}，本次输出 ${reply.usage.output} tokens）。请在 设置 → 模型 中提高该模型最大输出，或选择输出额度更高的模型；原有图谱与待分析记录已保留。`,
					);
				}
				this.store.save({ ...process, running: true });
			}
			const revision = applyWorkProcessAnalysis(process, lane, batch, reply.content);
			const nodes = new Map(process.nodes.map((node) => [node.id, node]));
			const edges = new Map(process.edges.map((edge) => [edge.id, edge]));
			for (const node of revision.nodes) nodes.set(node.id, node);
			for (const edge of revision.edges) edges.set(edge.id, edge);
			const consumed = { ...process.consumed };
			for (const entry of batch) consumed[entry.id] = workEvidenceFingerprint(entry);
			const next: WorkProcess = {
				...process,
				nodes: [...nodes.values()],
				edges: [...edges.values()],
				consumed,
				pending: process.pending - batch.length,
				running: false,
				error: null,
				retry: null,
				revision: revision.revision,
				lastAnalyzedAt: revision.at,
				model: reply.model,
			};
			this.store.save(next, revision);
			if (next.pending > 0) this.jobs.set(key, { ref, once });
		} catch (error) {
			if (!current()) return;
			const process = this.store.get(ref);
			if (process) {
				const attempt = (process.retry?.attempt ?? 0) + 1;
				const retry = {
					attempt,
					at: Date.now() + Math.min(60000, 3000 * 2 ** Math.min(attempt - 1, 5)),
					once: once || (process.retry?.once ?? false),
				};
				this.store.save({
					...process,
					running: false,
					error: error instanceof Error ? error.message : String(error),
					retry,
				});
				this.scheduleRetry(ref, retry);
			}
		}
	}

	revisions(ref: WorkProcessRef, nodeId: string) {
		return this.store.revisions(ref, nodeId);
	}

	async original(ref: WorkProcessRef, evidenceId: string): Promise<{ text: string; truncated: boolean }> {
		const process = await this.detail(ref);
		const entry = process.evidence.find((entry) => entry.id === evidenceId);
		if (!entry) throw new Error("证据记录不存在");
		return this.sources.original(ref, entry);
	}

	delete(ref: WorkProcessRef): void {
		const key = workProcessKey(ref);
		this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
		this.running.get(key)?.abort();
		clearTimeout(this.retryTimers.get(key));
		this.retryTimers.delete(key);
		this.jobs.delete(key);
		this.store.delete(ref);
	}

	purgeProject(projectId: string): void {
		for (const process of this.store.list(projectId)) this.delete(process);
	}

	close(): void {
		this.closed = true;
		clearInterval(this.timer);
		for (const timer of this.retryTimers.values()) clearTimeout(timer);
		this.retryTimers.clear();
		for (const controller of this.running.values()) controller.abort();
		for (const process of this.store.list()) if (process.running) this.store.save({ ...process, running: false });
		this.jobs.clear();
		this.store.close();
	}
}

export function completeWorkProcess(agentDir: string): WorkProcessCompletion {
	return async (input, signal) => {
		const config = resolveAuxiliaryModel(agentDir, "workprocess");
		if (!config) throw new Error("请在设置 → 模型中配置工作链路模型");
		const reply = await completeAuxiliaryModel(config, {
			input,
			signal,
			systemPrompt: WORK_PROCESS_PROMPT,
			json: true,
		});
		return { ...reply, model: config.modelId };
	};
}
