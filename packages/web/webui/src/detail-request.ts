import { useMemo, useState } from "react";
import { getLanguage } from "./i18n.ts";

export interface DetailLoadState {
	loading: boolean;
	error: string | null;
}

export interface DetailView<T> extends DetailLoadState {
	id: string;
	scope: string | null;
	data: T | null;
}

/** Selection, rather than a response or filtered list, owns a detail surface. */
export class DetailRequest<T> {
	private view: DetailView<T> | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private send: (() => void) | null = null;
	private readonly onView: (view: DetailView<T> | null) => void;

	constructor(onView: (view: DetailView<T> | null) => void) {
		this.onView = onView;
	}

	get current(): DetailView<T> | null { return this.view; }

	open(scope: string | null, id: string, send: () => void): void {
		this.dispose();
		this.send = send;
		this.view = { scope, id, data: null, loading: true, error: null };
		this.onView(this.view);
		this.timer = setTimeout(() => this.fail(getLanguage() === "en"
			? "Details timed out. Retry to load them again." : "详情加载超时，请重试。"), 10_000);
		try { send(); } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
	}

	retry(): void {
		if (this.view && this.send) this.open(this.view.scope, this.view.id, this.send);
	}

	accept(scope: string | null, id: string, data: T): boolean {
		if (!this.view || this.view.error || this.view.scope !== scope || this.view.id !== id) return false;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.view = { ...this.view, data, loading: false, error: null };
		this.onView(this.view);
		return true;
	}

	update(transform: (data: T) => T): void {
		if (this.view?.data) {
			this.view = { ...this.view, data: transform(this.view.data) };
			this.onView(this.view);
		}
	}

	disconnect(): void {
		if (this.view?.loading) this.fail(getLanguage() === "en"
			? "Connection lost. Retry after reconnecting." : "连接已断开，请等待重连后重试。");
	}

	close(): void { this.dispose(); this.onView(null); }

	dispose(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.view = null;
		this.send = null;
	}

	private fail(error: string): void {
		if (!this.view) return;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.view = { ...this.view, loading: false, error };
		this.onView(this.view);
	}
}

export function useDetailRequest<T>() {
	const [view, setView] = useState<DetailView<T> | null>(null);
	const request = useMemo(() => new DetailRequest<T>(setView), []);
	return [view, request] as const;
}
