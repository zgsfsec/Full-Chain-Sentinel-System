import { expect, test, vi } from "vitest";
import WebSocket from "ws";
import { broadcastConsoleMessage, MAX_CONSOLE_BUFFER_BYTES, sendConsoleMessage } from "../src/console-socket.ts";
import type { SentinelServerMessage } from "../src/protocol.ts";

function socket(bufferedAmount = 0, readyState: WebSocket["readyState"] = WebSocket.OPEN) {
	return { readyState, bufferedAmount, send: vi.fn(), terminate: vi.fn() };
}

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
