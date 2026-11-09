import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SESSION_ENDED_NOTICE, SentinelConnection } from "./ws.ts";

class FakeWebSocket {
	static OPEN = 1;
	static instances: FakeWebSocket[] = [];
	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => Promise<void>) | null = null;
	onerror: (() => void) | null = null;
	send = vi.fn();

	constructor(_url: string) {
		FakeWebSocket.instances.push(this);
	}

	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	async end(code: number, reason = ""): Promise<void> {
		this.readyState = 3;
		await this.onclose?.({ code, reason });
	}

	close(): void {
		void this.end(1000);
	}
}

const reload = vi.fn();
const fetchSession = vi.fn(async (_input: string, _init?: RequestInit) => ({ status: 200 }));
const storage = new Map<string, string>();

beforeEach(() => {
	vi.useFakeTimers();
	FakeWebSocket.instances = [];
	storage.clear();
	reload.mockClear();
	fetchSession.mockReset().mockResolvedValue({ status: 200 });
	vi.stubGlobal("WebSocket", FakeWebSocket);
	vi.stubGlobal("fetch", fetchSession);
	vi.stubGlobal("window", {
		location: { protocol: "https:", host: "console.example", reload },
		sessionStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
		setTimeout: globalThis.setTimeout,
		clearTimeout: globalThis.clearTimeout,
	});
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test("a replaced login returns to login, drops commands and stops reconnecting", async () => {
	fetchSession.mockResolvedValue({ status: 401 });
	const status = vi.fn();
	const connection = new SentinelConnection(vi.fn(), status);
	connection.connect();
	const socket = FakeWebSocket.instances[0];
	socket.open();
	await socket.end(4001, "session_replaced");
	connection.send({ type: "set_ui_language", language: "en" });
	await vi.advanceTimersByTimeAsync(30000);
	expect(storage.get(SESSION_ENDED_NOTICE)).toBe("session_replaced");
	expect(reload).toHaveBeenCalledOnce();
	expect(status).toHaveBeenLastCalledWith(false);
	expect(socket.send).not.toHaveBeenCalled();
	expect(FakeWebSocket.instances).toHaveLength(1);
});

test("an unauthorized reconnect also returns to login", async () => {
	fetchSession.mockResolvedValue({ status: 401 });
	const connection = new SentinelConnection(vi.fn());
	connection.connect();
	await FakeWebSocket.instances[0].end(1006);
	expect(storage.get(SESSION_ENDED_NOTICE)).toBe("session_expired");
	expect(reload).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

test("ordinary network failures reconnect, but closing cancels the pending retry", async () => {
	fetchSession.mockRejectedValue(new Error("offline"));
	const connection = new SentinelConnection(vi.fn());
	connection.connect();
	await FakeWebSocket.instances[0].end(1006);
	expect(reload).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(500);
	expect(FakeWebSocket.instances).toHaveLength(2);
	await FakeWebSocket.instances[1].end(1006);
	connection.close();
	await vi.advanceTimersByTimeAsync(30000);
	expect(FakeWebSocket.instances).toHaveLength(2);
});

test("tabs sharing a renewed cookie reconnect without replaying the old queue", async () => {
	const connection = new SentinelConnection(vi.fn());
	connection.connect();
	connection.send({ type: "set_ui_language", language: "en" });
	await FakeWebSocket.instances[0].end(4001, "session_replaced");
	await vi.advanceTimersByTimeAsync(500);
	const renewed = FakeWebSocket.instances[1];
	storage.set(SESSION_ENDED_NOTICE, "session_replaced");
	renewed.open();
	expect(renewed.send).not.toHaveBeenCalled();
	expect(reload).not.toHaveBeenCalled();
	expect(storage.has(SESSION_ENDED_NOTICE)).toBe(false);
	connection.close();
});

test("explicit revocation returns to login even when the status request is offline", async () => {
	fetchSession.mockRejectedValue(new Error("offline"));
	const connection = new SentinelConnection(vi.fn());
	connection.connect();
	await FakeWebSocket.instances[0].end(4001, "session_replaced");
	expect(reload).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

test("connecting twice does not leave a second socket that can invalidate the active one", () => {
	const connection = new SentinelConnection(vi.fn());
	connection.connect();
	connection.connect();
	expect(FakeWebSocket.instances).toHaveLength(1);
	connection.close();
});

test("late close and message callbacks from an old socket cannot affect its replacement", async () => {
	const onMessage = vi.fn();
	const status = vi.fn();
	const connection = new SentinelConnection(onMessage, status);
	connection.connect();
	const old = FakeWebSocket.instances[0];
	old.open();
	await old.end(1006);
	await vi.advanceTimersByTimeAsync(500);
	const current = FakeWebSocket.instances[1];
	current.open();
	await old.end(1006);
	old.onmessage?.({ data: JSON.stringify({ type: "error", message: "stale" }) });
	expect(connection.connected).toBe(true);
	expect(status).toHaveBeenLastCalledWith(true);
	expect(onMessage).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(20000);
	expect(FakeWebSocket.instances).toHaveLength(2);
	connection.close();
});

test("a late authorization response from an older connection does not log out the new one", async () => {
	let finish: ((result: { status: number }) => void) | undefined;
	fetchSession.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
	const connection = new SentinelConnection(vi.fn());
	connection.connect();
	const pending = FakeWebSocket.instances[0].end(1006);
	connection.connect();
	FakeWebSocket.instances[1].open();
	finish?.({ status: 401 });
	await pending;
	expect(reload).not.toHaveBeenCalled();
	expect(connection.connected).toBe(true);
	connection.close();
});

test("a stalled authorization check times out and reconnects instead of waiting forever", async () => {
	vi.spyOn(AbortSignal, "timeout").mockImplementationOnce((delay) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), delay);
		return controller.signal;
	});
	fetchSession.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
	}));
	const connection = new SentinelConnection(vi.fn());
	connection.connect();
	const pending = FakeWebSocket.instances[0].end(1006);
	await vi.advanceTimersByTimeAsync(5000);
	await pending;
	await vi.advanceTimersByTimeAsync(500);
	expect(FakeWebSocket.instances).toHaveLength(2);
	expect(reload).not.toHaveBeenCalled();
	connection.close();
});
