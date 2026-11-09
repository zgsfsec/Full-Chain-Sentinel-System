import WebSocket from "ws";
import type { SentinelServerMessage } from "./protocol.ts";

/** One slow browser must not keep hours of agent output queued in memory. */
export const MAX_CONSOLE_BUFFER_BYTES = 32 * 1024 * 1024;

type ConsoleSocket = Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "terminate">;

function writable(socket: ConsoleSocket): boolean {
	if (socket.readyState !== WebSocket.OPEN) return false;
	if (socket.bufferedAmount <= MAX_CONSOLE_BUFFER_BYTES) return true;
	// Terminate releases queued frames immediately. The console reconnects and
	// reloads persisted state instead of retaining an unbounded send backlog.
	socket.terminate();
	return false;
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
