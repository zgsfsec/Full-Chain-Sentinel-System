import WebSocket from "ws";
import type { SentinelServerMessage } from "./protocol.ts";

/** One slow browser must not keep hours of agent output queued in memory. */
export const MAX_CONSOLE_BUFFER_BYTES = 32 * 1024 * 1024;
export const CONSOLE_PING_INTERVAL_MS = 25_000;
export const CONSOLE_PONG_TIMEOUT_MS = 90_000;

type ConsoleSocket = Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "terminate">;

function writable(socket: ConsoleSocket): boolean {
	if (socket.readyState !== WebSocket.OPEN) return false;
	if (socket.bufferedAmount <= MAX_CONSOLE_BUFFER_BYTES) return true;
	// Terminate releases queued frames immediately. The console reconnects and
	// reloads persisted state instead of retaining an unbounded send backlog.
	console.warn(
		`[sentinel-ws] disconnect: send backlog ${socket.bufferedAmount} bytes exceeds ${MAX_CONSOLE_BUFFER_BYTES}`,
	);
	socket.terminate();
	return false;
}

/** Native ping/pong works even when a browser tab's JavaScript timers are suspended. */
export function keepConsoleAlive(
	socket: Pick<WebSocket, "readyState" | "ping" | "terminate"> & {
		on(event: "pong" | "message" | "close", listener: () => void): void;
		off(event: "pong" | "message" | "close", listener: () => void): void;
	},
): void {
	let waitingSince: number | undefined;
	let lastTick = Date.now();
	const alive = () => {
		waitingSince = undefined;
	};
	const timer = setInterval(() => {
		if (socket.readyState !== WebSocket.OPEN) return;
		const now = Date.now();
		// A suspended host or blocked server cannot judge a browser's response time.
		if (now - lastTick > CONSOLE_PING_INTERVAL_MS * 2) waitingSince = undefined;
		lastTick = now;
		if (waitingSince !== undefined) {
			if (now - waitingSince >= CONSOLE_PONG_TIMEOUT_MS) {
				console.warn("[sentinel-ws] disconnect: pong timeout");
				socket.terminate();
			}
			return;
		}
		waitingSince = now;
		socket.ping();
	}, CONSOLE_PING_INTERVAL_MS);
	timer.unref();
	const stop = () => {
		clearInterval(timer);
		socket.off("pong", alive);
		socket.off("message", alive);
		socket.off("close", stop);
	};
	socket.on("pong", alive);
	socket.on("message", alive);
	socket.on("close", stop);
}

export function sendConsoleMessage(socket: ConsoleSocket, message: SentinelServerMessage): void {
	if (writable(socket)) socket.send(JSON.stringify(message));
}

export function broadcastConsoleMessage(clients: Iterable<ConsoleSocket>, message: SentinelServerMessage): void {
	const recipients = [...clients].filter(writable);
	if (recipients.length === 0) return;
	const data = JSON.stringify(message);
	for (const client of recipients) client.send(data);
}
