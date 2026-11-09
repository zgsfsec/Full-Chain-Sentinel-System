import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** Keep provider snapshots in the runtime; the console renders streaming deltas. */
export function consoleSessionEvent(event: AgentSessionEvent): AgentSessionEvent | undefined {
	if (event.type === "message_update") {
		const update = event.assistantMessageEvent;
		if (event.message.role !== "assistant" || (update.type !== "text_delta" && update.type !== "thinking_delta")) {
			return undefined;
		}
		return {
			...event,
			message: { ...event.message, content: [] },
			assistantMessageEvent: { ...update, partial: { ...update.partial, content: [] } },
		};
	}
	// These runtime bookkeeping events duplicate complete messages already sent
	// through message_end and snapshots. The browser does not consume them.
	if (event.type === "turn_end" || event.type === "entry_appended") return undefined;
	if (event.type === "agent_end") return { ...event, messages: [] };
	return event;
}
