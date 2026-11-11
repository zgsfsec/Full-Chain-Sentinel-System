import type { EngineManager } from "./engine.ts";
import { IntelligenceError } from "./intelligence-input.ts";
import type { IntelligenceStore } from "./intelligence-store.ts";
import type { IntelligenceBatch, IntelligenceEngineInput } from "./intelligence-types.ts";
import type { SentinelEngine, SentinelProjectInfo } from "./protocol.ts";

export interface IntelligenceEngineBridge {
	createIntelligenceEngine(project: SentinelProjectInfo, input: IntelligenceEngineInput): SentinelEngine;
	findIntelligenceEngine(attemptId: string): SentinelEngine | undefined;
	getEngine(id: string): SentinelEngine | undefined;
	pauseEngine: EngineManager["pauseEngine"];
	resumeEngine: EngineManager["resumeEngine"];
	abortEngine: EngineManager["abortEngine"];
}

/** Trigger evaluation is independent of transport and of the concrete engine runner. */
export class IntelligenceManager {
	readonly store: IntelligenceStore;
	private readonly engines: IntelligenceEngineBridge;
	private readonly project: (id: string) => SentinelProjectInfo | undefined;
	private timer: NodeJS.Timeout | undefined;
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
		this.run();
		this.timer = setInterval(() => this.run(), 5000);
		this.timer.unref();
	}
	stop(): void {
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
				: this.engines.findIntelligenceEngine(attempt.id);
			if (!engine && (attempt.engineId || batch.status === "running" || batch.status === "paused"))
				throw new Error("关联工程已被删除，请手动重试批次");
			if (!engine) {
				const project = this.project(batch.projectId);
				if (!project) throw new Error("批次所属项目已不存在");
				this.store.setAttempt(batch, "creating", null, null);
				try {
					engine = this.engines.createIntelligenceEngine(project, {
						attemptId: attempt.id,
						batchId: batch.id,
						template: batch.template,
						items: batch.items,
					});
				} catch (error) {
					// A caller can fail after the engine committed. Recover its stable
					// association before declaring failure or allowing a new attempt.
					engine = this.engines.findIntelligenceEngine(attempt.id);
					if (!engine) throw error;
				}
			}
			const status =
				engine.status === "completed"
					? engine.report?.trim() &&
						engine.tasks.length > 0 &&
						engine.tasks.every((task) => task.status === "done")
						? "succeeded"
						: "failed"
					: engine.status === "paused"
						? "paused"
						: engine.status === "stopped"
							? engine.pauseNote === "操作员终止"
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
