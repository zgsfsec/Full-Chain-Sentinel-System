import { getLanguage } from "./i18n.ts";
import type { SentinelClientMessage, SentinelCodeActivityView, SentinelServerMessage } from "./types.ts";

type ActivityRequest = Extract<SentinelClientMessage, { type: "list_code_activity" }>;
export type CodeActivityQuery = Omit<ActivityRequest, "type" | "requestId">;
type ActivityReply = Extract<SentinelServerMessage, { type: "code_activity" | "code_activity_error" }>;

/** Correlate replies, coalesce refreshes and always settle the table's spinner. */
export class CodeActivityRequest {
	private sequence = 0;
	private pending: { id: number; key: string; timer: ReturnType<typeof setTimeout> } | null = null;
	private currentKey: string | null = null;
	private loadedKey: string | null = null;
	private readonly onState: (loading: boolean, error: string | null) => void;
	private readonly onView: (view: SentinelCodeActivityView | null) => void;

	constructor(
		onState: (loading: boolean, error: string | null) => void,
		onView: (view: SentinelCodeActivityView | null) => void,
	) {
		this.onState = onState;
		this.onView = onView;
	}

	load(query: CodeActivityQuery, send: (request: ActivityRequest) => void, background = false): void {
		const key = JSON.stringify(query);
		if (this.pending?.key === key) return;
		this.clearPending();
		if (this.currentKey !== key) {
			this.loadedKey = null;
			this.onView(null);
		}
		this.currentKey = key;
		const id = ++this.sequence;
		const timer = setTimeout(() => this.fail(id, getLanguage() === "en"
			? "Activity request timed out. Refresh to retry."
			: "动态加载超时，请刷新重试。"), 15_000);
		this.pending = { id, key, timer };
		this.onState(!background || this.loadedKey !== key, null);
		try {
			send({ type: "list_code_activity", requestId: id, ...query });
		} catch (error) {
			this.fail(id, error instanceof Error ? error.message : String(error));
		}
	}

	accept(reply: ActivityReply): void {
		if (reply.requestId !== this.pending?.id) return;
		if (reply.type === "code_activity_error") {
			this.fail(reply.requestId, reply.error);
			return;
		}
		this.loadedKey = this.pending.key;
		this.clearPending();
		this.onView(reply.view);
		this.onState(false, null);
	}

	disconnect(): void {
		if (this.pending) this.fail(this.pending.id, getLanguage() === "en"
			? "Connection lost. Activity will reload after reconnecting."
			: "连接已断开，重连后将重新加载动态。");
	}

	dispose(): void {
		this.clearPending();
	}

	private fail(id: number, error: string): void {
		if (id !== this.pending?.id) return;
		this.clearPending();
		this.onState(false, error);
	}

	private clearPending(): void {
		if (this.pending) clearTimeout(this.pending.timer);
		this.pending = null;
	}
}
