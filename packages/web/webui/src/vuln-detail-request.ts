import { getLanguage } from "./i18n.ts";
import type { SentinelClientMessage, SentinelVulnerability } from "./types.ts";

export interface VulnDetailView {
	id: string;
	projectId: string;
	vuln: SentinelVulnerability | null;
	loading: boolean;
	error: string | null;
}

/** The operator's selection owns the drawer; list filters cannot dismiss it. */
export class VulnDetailRequest {
	private view: VulnDetailView | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly onView: (view: VulnDetailView | null) => void;

	constructor(onView: (view: VulnDetailView | null) => void) {
		this.onView = onView;
	}

	open(projectId: string, id: string, send: (request: Extract<SentinelClientMessage, { type: "get_vuln" }>) => void): void {
		this.dispose();
		this.view = { id, projectId, vuln: null, loading: true, error: null };
		this.onView(this.view);
		this.timer = setTimeout(() => this.fail(getLanguage() === "en"
			? "Finding details timed out. Retry to load them again."
			: "漏洞详情加载超时，请重试。"), 10_000);
		try {
			send({ type: "get_vuln", id });
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
		}
	}

	/** Updates may refresh the selected record, but never open or replace another one. */
	accept(vuln: SentinelVulnerability): boolean {
		if (!this.view || this.view.error || vuln.id !== this.view.id || vuln.projectId !== this.view.projectId) return false;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.view = { ...this.view, vuln, loading: false, error: null };
		this.onView(this.view);
		return true;
	}

	disconnect(): void {
		if (this.view?.loading) this.fail(getLanguage() === "en"
			? "Connection lost. Retry after reconnecting."
			: "连接已断开，请等待重连后重试。");
	}

	close(): void {
		this.dispose();
		this.onView(null);
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.view = null;
	}

	private fail(error: string): void {
		if (!this.view) return;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.view = { ...this.view, loading: false, error };
		this.onView(this.view);
	}
}
