import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { consoleSessionEvent } from "../src/console-events.ts";
import { MAX_CONSOLE_BUFFER_BYTES, sendConsoleMessage } from "../src/console-socket.ts";

test.each(["text_delta", "thinking_delta"] as const)("%s traffic stays small as the response grows", (type) => {
	const message = fauxAssistantMessage("x".repeat(512 * 1024));
	const event: AgentSessionEvent = {
		type: "message_update",
		message,
		assistantMessageEvent: { type, contentIndex: 0, delta: "新增内容", partial: message },
	};
	const outbound = consoleSessionEvent(event);
	expect(outbound).toMatchObject({
		type: "message_update",
		message: { content: [] },
		assistantMessageEvent: { type, delta: "新增内容", partial: { content: [] } },
	});
	expect(JSON.stringify(outbound).length).toBeLessThan(2000);
	expect(message.content).toEqual([{ type: "text", text: "x".repeat(512 * 1024) }]);
});

test("a burst of large cumulative updates does not fill a browser's send queue", () => {
	const message = fauxAssistantMessage("x".repeat(512 * 1024));
	let terminated = false;
	const socket = {
		readyState: 1 as const,
		bufferedAmount: 0,
		send(data: string) {
			this.bufferedAmount += Buffer.byteLength(data);
		},
		terminate() {
			terminated = true;
		},
	};
	for (let index = 0; index < 80; index += 1) {
		const event = consoleSessionEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
		});
		if (event) sendConsoleMessage(socket, { type: "session_event", event });
	}
	expect(terminated).toBe(false);
	expect(socket.bufferedAmount).toBeLessThan(MAX_CONSOLE_BUFFER_BYTES / 100);
});

test("complete messages and other UI events still reach the console unchanged", () => {
	const message = fauxAssistantMessage("Complete answer");
	const ended: AgentSessionEvent = { type: "message_end", message };
	expect(consoleSessionEvent(ended)).toBe(ended);
	const settled: AgentSessionEvent = { type: "agent_settled", aborted: false };
	expect(consoleSessionEvent(settled)).toBe(settled);
});

test("unused provider and bookkeeping snapshots are not repeated over the wire", () => {
	const message = fauxAssistantMessage("Complete answer");
	expect(
		consoleSessionEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Complete answer", partial: message },
		}),
	).toBeUndefined();
	expect(consoleSessionEvent({ type: "turn_end", message, toolResults: [] })).toBeUndefined();
	expect(consoleSessionEvent({ type: "agent_end", messages: [message], willRetry: false })).toEqual({
		type: "agent_end",
		messages: [],
		willRetry: false,
	});
});
