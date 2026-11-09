/** WebSocket client with auto-reconnect. */

import type { SentinelClientMessage, SentinelServerMessage } from "./types.ts";

export const SESSION_ENDED_NOTICE = "sentinel-session-ended";

export class SentinelConnection {
	private socket: WebSocket | null = null;
	private closed = false;
	private reconnectDelay = 500;
	private queue: SentinelClientMessage[] = [];
	private reconnectTimer: number | undefined;
	private generation = 0;

	constructor(
		private readonly onMessage: (message: SentinelServerMessage) => void,
		/** Reports every open and close, so the UI can show the real connection state. */
		private readonly onStatus: (connected: boolean) => void = () => {},
	) {}

	connect(): void {
		if (!this.closed && this.socket) return;
		window.clearTimeout(this.reconnectTimer);
		this.closed = false;
		this.open();
	}

	private open(): void {
		if (this.closed) return;
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
		const generation = ++this.generation;
		this.socket = socket;
		socket.onopen = () => {
			if (this.closed || this.socket !== socket) {
				socket.close();
				return;
			}
			try {
				window.sessionStorage.removeItem(SESSION_ENDED_NOTICE);
			} catch {
				// Storage may be disabled; it is only used for the login notice.
			}
			this.reconnectDelay = 500;
			this.onStatus(true);
			for (const message of this.queue.splice(0)) socket.send(JSON.stringify(message));
		};
		socket.onmessage = (event) => {
			if (this.closed || this.socket !== socket) return;
			try {
				this.onMessage(JSON.parse(String(event.data)) as SentinelServerMessage);
			} catch {
				// Ignore malformed frames.
			}
		};
		socket.onclose = async (event) => {
			if (this.socket !== socket) return;
			this.socket = null;
			this.onStatus(false);
			if (this.closed) return;
			// Never replay queued commands after a login has been replaced.
			if (event.code === 4001) this.queue = [];
			let expired = event.code === 4001;
			try {
				const session = await fetch("/api/auth/session", { cache: "no-store", signal: AbortSignal.timeout(5000) });
				// Another tab in this browser may already have the new login cookie.
				expired = session.status === 401;
			} catch {
				// A network failure should retry; an explicit revocation should not.
			}
			if (this.closed || generation !== this.generation) return;
			console.warn(`[sentinel-ws] reconnecting: code=${event.code} reason=${event.reason || "none"}`);
			if (expired) {
				this.closed = true;
				this.queue = [];
				try {
					window.sessionStorage.setItem(
						SESSION_ENDED_NOTICE,
						event.reason === "session_replaced" ? "session_replaced" : "session_expired",
					);
				} catch {
					// Returning to login must work even without browser storage.
				}
				window.location.reload();
				return;
			}
			this.reconnectTimer = window.setTimeout(() => this.open(), this.reconnectDelay);
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
		};
		socket.onerror = () => socket.close();
	}

	get connected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	send(message: SentinelClientMessage): void {
		if (this.closed) return;
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify(message));
		} else {
			this.queue.push(message);
		}
	}

	close(): void {
		this.closed = true;
		window.clearTimeout(this.reconnectTimer);
		this.queue = [];
		this.socket?.close();
		this.socket = null;
		this.generation += 1;
	}
}
