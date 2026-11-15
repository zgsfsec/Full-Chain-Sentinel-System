import { checkObject, checkString, parseSecurityCheckMarkdown } from "./security-check-input.ts";
import type { SecurityCheckStore } from "./security-check-store.ts";
import {
	SECURITY_CHECK_MAX_BYTES,
	SECURITY_CHECK_MAX_RULES,
	type SecurityCheckRule,
	type SecurityCheckSource,
} from "./security-check-types.ts";

/** Global sources use the console host network; they never follow the viewed project. */
export class SecurityCheckSync {
	private readonly store: SecurityCheckStore;
	private readonly fetcher: typeof fetch;
	private readonly running = new Map<string, AbortController>();
	private timer?: ReturnType<typeof setInterval>;
	private closed = false;
	constructor(store: SecurityCheckStore, fetcher: typeof fetch = fetch) {
		this.store = store;
		this.fetcher = fetcher;
	}
	sources(): SecurityCheckSource[] {
		return this.store.listSources().map((source) => ({ ...source, syncing: this.running.has(source.id) }));
	}
	private async download(url: string, signal: AbortSignal, cap: number): Promise<string> {
		const response = await this.fetcher(url, {
			headers: { accept: "application/vnd.github+json", "user-agent": "Full-Chain-Sentinel-System" },
			signal,
			redirect: "error",
		});
		if (!response.ok)
			throw new Error(
				`GitHub HTTP ${response.status}${response.status === 403 || response.status === 429 ? "：访问受限或请求额度耗尽，请稍后重试" : ""}`,
			);
		if (Number(response.headers.get("content-length") ?? 0) > cap) throw new Error("规则下载超过大小上限");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("规则下载没有响应内容");
		let size = 0;
		const chunks: Uint8Array[] = [];
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > cap) throw new Error("规则下载超过大小上限");
				chunks.push(value);
			}
			return Buffer.concat(chunks).toString("utf8");
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}
	async sync(id: string): Promise<void> {
		if (this.closed) throw new Error("规则同步已关闭");
		if (this.running.has(id)) throw new Error("该规则源正在同步");
		const source = this.store.getSource(id);
		const controller = new AbortController();
		this.running.set(id, controller);
		const timeout = setTimeout(() => controller.abort(), 120_000);
		try {
			const repository = source.repository.slice("https://github.com/".length);
			const revision = checkObject(
				JSON.parse(
					await this.download(
						`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(source.branch)}`,
						controller.signal,
						2 * 1024 * 1024,
					),
				),
			);
			const sha = checkString(revision.sha, "提交 SHA", 64);
			if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("GitHub 返回了无效提交 SHA");
			if (sha === source.commit) {
				this.store.finishSync(source, null, sha, null);
				return;
			}
			const tree = checkObject(
				JSON.parse(
					await this.download(
						`https://api.github.com/repos/${repository}/git/trees/${sha}?recursive=1`,
						controller.signal,
						16 * 1024 * 1024,
					),
				),
			);
			if (tree.truncated || !Array.isArray(tree.tree))
				throw new Error("GitHub 文件目录不完整，请使用较小的规则仓库");
			const entries = tree.tree
				.map(checkObject)
				.filter(
					(entry) =>
						entry.type === "blob" &&
						entry.mode === "100644" &&
						typeof entry.path === "string" &&
						entry.path.startsWith(`${source.directory}/`) &&
						entry.path.endsWith(".md"),
				);
			if (!entries.length) throw new Error("规则目录不存在或没有 Markdown 规则，保留已有规则");
			if (entries.length > SECURITY_CHECK_MAX_RULES)
				throw new Error(`单个来源最多 ${SECURITY_CHECK_MAX_RULES} 条规则`);
			const rules: SecurityCheckRule[] = [];
			let total = 0;
			for (const entry of entries) {
				const path = checkString(entry.path, "文件路径", 2048);
				if (typeof entry.size !== "number" || entry.size > SECURITY_CHECK_MAX_BYTES)
					throw new Error(`${path} 超过 128 KB`);
				try {
					const text = await this.download(
						`https://raw.githubusercontent.com/${repository}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`,
						controller.signal,
						SECURITY_CHECK_MAX_BYTES,
					);
					total += Buffer.byteLength(text);
					if (total > 16 * 1024 * 1024) throw new Error("规则正文总量超过 16 MB");
					const rule = parseSecurityCheckMarkdown(text, source.id, path, sha);
					if (rules.some((item) => item.id === rule.id)) throw new Error(`重复规则 ID：${rule.ruleId}`);
					rules.push(rule);
				} catch (error) {
					throw new Error(`${path}：${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (!this.closed) this.store.finishSync(source, rules, sha, null);
		} catch (error) {
			if (!this.closed) {
				try {
					this.store.finishSync(source, null, source.commit, error instanceof Error ? error.message : "同步失败");
				} catch {
					/* A changed/deleted source invalidates this result. */
				}
			}
			throw error;
		} finally {
			clearTimeout(timeout);
			this.running.delete(id);
		}
	}
	async tick(now = Date.now()): Promise<void> {
		for (const source of this.store.listSources()) {
			if (this.closed) return;
			if (source.enabled && source.nextSyncAt <= now && !this.running.has(source.id))
				await this.sync(source.id).catch(() => {});
		}
	}
	start(): void {
		if (this.timer || this.closed) return;
		void this.tick();
		this.timer = setInterval(() => {
			void this.tick();
		}, 60_000);
		this.timer.unref?.();
	}
	close(): void {
		this.closed = true;
		clearInterval(this.timer);
		for (const controller of this.running.values()) controller.abort();
	}
}
