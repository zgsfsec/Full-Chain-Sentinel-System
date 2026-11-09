import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import WebSocket from "ws";
import {
	broadcastConsoleMessage,
	CONSOLE_PING_INTERVAL_MS,
	CONSOLE_PONG_TIMEOUT_MS,
	keepConsoleAlive,
	MAX_CONSOLE_BUFFER_BYTES,
	sendConsoleMessage,
} from "../src/console-socket.ts";
import type { SentinelServerMessage } from "../src/protocol.ts";

function socket(bufferedAmount = 0, readyState: WebSocket["readyState"] = WebSocket.OPEN) {
	return { readyState, bufferedAmount, send: vi.fn(), terminate: vi.fn() };
}

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

test("idle consoles exchange pings and stay connected while pongs arrive", () => {
	vi.useFakeTimers();
	const client = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, ping: vi.fn(), terminate: vi.fn() });
	keepConsoleAlive(client);
	for (let i = 0; i < 20; i += 1) {
		vi.advanceTimersByTime(CONSOLE_PING_INTERVAL_MS);
		client.emit("pong", Buffer.alloc(0));
	}
	expect(client.ping).toHaveBeenCalledTimes(20);
	expect(client.terminate).not.toHaveBeenCalled();
	client.emit("close");
	expect(vi.getTimerCount()).toBe(0);
	expect(client.listenerCount("pong")).toBe(0);
});

test("a genuinely unresponsive connection is terminated after a generous timeout", () => {
	vi.useFakeTimers();
	const client = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, ping: vi.fn(), terminate: vi.fn() });
	keepConsoleAlive(client);
	vi.advanceTimersByTime(CONSOLE_PING_INTERVAL_MS + CONSOLE_PONG_TIMEOUT_MS - 1);
	expect(client.terminate).not.toHaveBeenCalled();
	vi.advanceTimersByTime(CONSOLE_PING_INTERVAL_MS);
	expect(client.terminate).toHaveBeenCalledTimes(1);
	client.emit("close");
});

test("server suspension does not falsely time out a healthy console", () => {
	vi.useFakeTimers();
	const client = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, ping: vi.fn(), terminate: vi.fn() });
	keepConsoleAlive(client);
	vi.advanceTimersByTime(CONSOLE_PING_INTERVAL_MS);
	vi.setSystemTime(Date.now() + 10 * 60_000);
	vi.advanceTimersByTime(CONSOLE_PING_INTERVAL_MS);
	expect(client.terminate).not.toHaveBeenCalled();
	expect(client.ping).toHaveBeenCalledTimes(2);
	client.emit("close");
});

test("normal incoming commands also prove the connection is alive", () => {
	vi.useFakeTimers();
	const client = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, ping: vi.fn(), terminate: vi.fn() });
	keepConsoleAlive(client);
	for (let i = 0; i < 10; i += 1) {
		vi.advanceTimersByTime(CONSOLE_PING_INTERVAL_MS);
		client.emit("message", Buffer.from("{}"));
	}
	expect(client.terminate).not.toHaveBeenCalled();
	client.emit("close");
});

test("a stalled console is disconnected before another frame is serialized", () => {
	const stalled = socket(MAX_CONSOLE_BUFFER_BYTES + 1);
	const serialize = vi.fn(() => "snapshot");
	const message = {
		type: "error",
		get message() {
			return serialize();
		},
	} satisfies SentinelServerMessage;
	sendConsoleMessage(stalled, message);
	expect(stalled.terminate).toHaveBeenCalledTimes(1);
	expect(stalled.send).not.toHaveBeenCalled();
	expect(serialize).not.toHaveBeenCalled();
});

test("a stalled browser does not block a healthy browser", () => {
	const stalled = socket(MAX_CONSOLE_BUFFER_BYTES + 1);
	const healthy = socket();
	const closed = socket(0, WebSocket.CLOSED);
	const message = { type: "error", message: "test" } satisfies SentinelServerMessage;
	broadcastConsoleMessage([stalled, healthy, closed], message);
	expect(stalled.terminate).toHaveBeenCalledTimes(1);
	expect(healthy.send).toHaveBeenCalledWith(JSON.stringify(message));
	expect(closed.send).not.toHaveBeenCalled();
});

test("unobserved broadcasts do not serialize their payload", () => {
	const serialize = vi.fn(() => "snapshot");
	const message = {
		type: "error",
		get message() {
			return serialize();
		},
	} satisfies SentinelServerMessage;
	broadcastConsoleMessage([], message);
	broadcastConsoleMessage([socket(0, WebSocket.CLOSED)], message);
	expect(serialize).not.toHaveBeenCalled();
});

test("repeated output stops accumulating when the browser queue exceeds its bound", () => {
	const slow = socket();
	slow.send.mockImplementation((data: string) => {
		slow.bufferedAmount += Buffer.byteLength(data);
	});
	const message = { type: "error", message: "x".repeat(1024 * 1024) } satisfies SentinelServerMessage;
	for (let i = 0; i < 100; i += 1) sendConsoleMessage(slow, message);
	expect(slow.bufferedAmount).toBeLessThan(MAX_CONSOLE_BUFFER_BYTES + 2 * 1024 * 1024);
	expect(slow.terminate).toHaveBeenCalled();
});
