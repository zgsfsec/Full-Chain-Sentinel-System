import type { EngineManager } from "./engine.ts";
import type { EngineSubmission } from "./engine-submission.ts";
import { IntelligenceError } from "./intelligence-input.ts";
import type { IntelligenceStore } from "./intelligence-store.ts";
import type { IntelligenceBatch, IntelligenceEngineInput } from "./intelligence-types.ts";
import type { SentinelEngineCreateInput, SentinelProjectInfo } from "./protocol.ts";

export interface IntelligenceEngineBridge {
	createEngine: EngineManager["createEngine"];
	findSubmittedEngine: EngineManager["findSubmittedEngine"];
	getEngine: EngineManager["getEngine"];
	pauseEngine: EngineManager["pauseEngine"];
	resumeEngine: EngineManager["resumeEngine"];
	abortEngine: EngineManager["abortEngine"];
}

export function intelligenceEngineSubmission(input: IntelligenceEngineInput): {
	input: SentinelEngineCreateInput;
	submission: EngineSubmission;
} {
	return {
		input: {
			name: `${input.template.name} · ${input.items.length} IP · ${input.batchId.slice(0, 8)}`,
			targets: input.items.map((item) => item.ip).join("\n"),
			doctrines: [input.template.id],
			limits: input.template.limits,
			gateMode: "auto",
		},
		submission: {
			source: "intelligence",
			key: input.attemptId,
			doctrines: [{ id: input.template.id, name: input.template.name, text: input.template.prompt, builtin: false }],
			brief: "工程输入仅包含待分析的威胁 IP 列表（ips），不提供设备信息或告警元数据。仅围绕列表中的 IP 进行只读溯源、公开情报查询、已有资产测绘与关联分析，提供防御建议。不得执行攻击、自动下发处置或将上报设备作为目标。IP 归属或地理位置不能直接证明攻击者身份，不得编造告警或攻击过程。报告逐 IP 标明公开查询来源、查询时间、不确定性与查询失败原因。",
			data: {
				ips: input.items.map((item) => item.ip),
			},
		},
	};
}

/** Trigger evaluation is independent of transport and of the concrete engine runner. */
export class IntelligenceManager {
	readonly store: IntelligenceStore;
	private readonly engines: IntelligenceEngineBridge;
	private readonly project: (id: string) => SentinelProjectInfo | undefined;
	private timer: NodeJS.Timeout | undefined;
	private readonly creating = new Set<string>();
	private stopped = false;
	private readonly ingestionWindows = new Map<string, { start: number; count: number; active: number }>();
	private ingestionActive = 0;
	private ingestionPrunedAt = 0;
	constructor(
		store: IntelligenceStore,
		engines: IntelligenceEngineBridge,
		project: (id: string) => SentinelProjectInfo | undefined,
	) {
		this.store = store;
		this.engines = engines;
		this.project = project;
	}
	start(): void {
		if (this.timer) return;
		this.stopped = false;
		this.run();
		this.timer = setInterval(() => this.run(), 5000);
		this.timer.unref();
	}
	stop(): void {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
	/** Authenticated sources only: bound request rate and memory occupied by slow bodies. */
	beginIngest(sourceId: string): () => void {
		const now = Date.now();
		if (now - this.ingestionPrunedAt >= 60000) {
			for (const [id, window] of this.ingestionWindows)
				if (window.active === 0 && now - window.start >= 60000) this.ingestionWindows.delete(id);
			this.ingestionPrunedAt = now;
		}
		let window = this.ingestionWindows.get(sourceId);
		if (!window) {
			window = { start: now, count: 0, active: 0 };
			this.ingestionWindows.set(sourceId, window);
		} else if (now - window.start >= 60000) {
			window.start = now;
			window.count = 0;
		}
		if (window.count >= 60 || window.active >= 4 || this.ingestionActive >= 16)
			throw new IntelligenceError("推送过于频繁，请在 60 秒后重试", 429);
		window.count++;
		window.active++;
		this.ingestionActive++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			window.active--;
			this.ingestionActive--;
		};
	}
	run(): void {
		try {
			for (const batch of this.store.unfinished()) this.reconcile(batch);
			for (const projectId of this.store.projects()) {
				// A bounded pass also prevents misconfiguration from starving other projects.
				for (let slot = 0; slot < 8; slot++) {
					const batch = this.store.claim(projectId);
					if (!batch) break;
					this.reconcile(batch);
					if (this.store.batch(projectId, batch.id)?.status === "failed") break;
				}
			}
		} catch (error) {
			console.error("[intelligence] 调度失败", error);
		}
	}
	private reconcile(batch: IntelligenceBatch): void {
		const attempt = batch.attempts.at(-1);
		if (!attempt) return;
		try {
			let engine = attempt.engineId
				? this.engines.getEngine(attempt.engineId)
				: this.engines.findSubmittedEngine("intelligence", attempt.id);
			if (!engine && (attempt.engineId || batch.status === "running" || batch.status === "paused"))
				throw new Error("关联工程已被删除，请手动重试批次");
			if (!engine) {
				if (this.creating.has(attempt.id)) return;
				const project = this.project(batch.projectId);
				if (!project) throw new Error("批次所属项目已不存在");
				this.store.setAttempt(batch, "creating", null, null);
				const request = intelligenceEngineSubmission({
					attemptId: attempt.id,
					batchId: batch.id,
					template: batch.template,
					items: batch.items,
				});
				this.creating.add(attempt.id);
				// Opening a commander can take a model round-trip. Keep other batches
				// and operator actions responsive while the ordinary engine starts.
				void this.engines
					.createEngine(project, request.input, request.submission)
					.catch((error: unknown) => {
						if (this.stopped) return;
						// Creation may have committed before a caller or startup failed.
						if (!this.engines.findSubmittedEngine("intelligence", attempt.id))
							this.store.setAttempt(
								batch,
								"failed",
								null,
								error instanceof Error ? error.message : String(error),
							);
					})
					.finally(() => {
						this.creating.delete(attempt.id);
						if (!this.stopped) this.run();
					});
				// The normal creation entry persists its association before awaiting
				// startup. Publish it now so pause/abort works during the first turn.
				engine = this.engines.findSubmittedEngine("intelligence", attempt.id);
				if (!engine) return;
			}
			const status =
				engine.status === "completed"
					? engine.report?.trim() &&
						batch.items.every((item) =>
							engine.tasks.some(
								(task) => task.status === "done" && (task.target === null || task.target === item.ip),
							),
						)
						? "succeeded"
						: "failed"
					: engine.status === "paused"
						? "paused"
						: engine.status === "stopped"
							? ["操作员终止", "Aborted by operator"].includes(engine.pauseNote ?? "")
								? "aborted"
								: "failed"
							: "running";
			this.store.setAttempt(
				batch,
				status,
				engine.id,
				status === "failed" || status === "aborted" || status === "paused"
					? (engine.pauseNote ?? "工程未成功提交整批报告")
					: null,
			);
		} catch (error) {
			this.store.setAttempt(
				batch,
				"failed",
				attempt.engineId,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	async action(projectId: string, id: string, action: string): Promise<void> {
		const batch = this.store.batch(projectId, id);
		if (!batch) throw new IntelligenceError("批次不存在", 404);
		if (action === "retry") {
			this.store.retry(projectId, id);
			this.run();
			return;
		}
		if (action === "discard") {
			this.store.discard(projectId, id);
			this.run();
			return;
		}
		if (!["queued", "creating", "running", "paused"].includes(batch.status))
			throw new IntelligenceError("批次已结束", 409);
		const engineId = batch.attempts.at(-1)?.engineId;
		if (action === "abort") {
			if (engineId) await this.engines.abortEngine(engineId);
			this.store.setAttempt(batch, "aborted", engineId ?? null, "操作员终止");
		} else if (action === "pause" && engineId) await this.engines.pauseEngine(engineId);
		else if (action === "resume" && engineId) await this.engines.resumeEngine(engineId);
		else throw new IntelligenceError("无效的批次操作", 409);
		this.run();
	}
}
