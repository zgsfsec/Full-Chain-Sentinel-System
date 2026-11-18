/** Provider wire fixtures consumed by the real SDK adapters, without external APIs. */
import type { Api } from "@earendil-works/pi-ai";

export function modelStream(api: Api, content: string, finishReason = "stop", reasoning = ""): Response {
	let events: unknown[];
	switch (api) {
		case "anthropic-messages":
			events = [
				{
					type: "message_start",
					message: {
						id: "msg_1",
						type: "message",
						role: "assistant",
						model: "test-model",
						content: [],
						usage: { input_tokens: 6, cache_read_input_tokens: 4, output_tokens: 0 },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: finishReason === "length" ? "max_tokens" : "end_turn" },
					usage: { output_tokens: 20 },
				},
				{ type: "message_stop" },
			];
			break;
		case "google-generative-ai":
			events = [
				{
					candidates: [
						{
							index: 0,
							content: { role: "model", parts: [{ text: content }] },
							finishReason: finishReason === "length" ? "MAX_TOKENS" : "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 20,
						totalTokenCount: 30,
						cachedContentTokenCount: 4,
					},
				},
			];
			break;
		case "openai-responses":
			events = [
				{ type: "response.created", response: { id: "resp_1" } },
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { id: "msg_1", type: "message", role: "assistant", content: [] },
				},
				{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: content },
				{
					type: finishReason === "length" ? "response.incomplete" : "response.completed",
					response: {
						id: "resp_1",
						status: finishReason === "length" ? "incomplete" : "completed",
						incomplete_details: finishReason === "length" ? { reason: "max_output_tokens" } : null,
						output: [],
						usage: {
							input_tokens: 10,
							output_tokens: 20,
							total_tokens: 30,
							input_tokens_details: { cached_tokens: 4 },
						},
					},
				},
			];
			break;
		default:
			events = [
				{
					id: "chatcmpl_1",
					object: "chat.completion.chunk",
					created: 1,
					model: "test-model",
					choices: [
						{
							index: 0,
							delta: { role: "assistant", content, ...(reasoning ? { reasoning_content: reasoning } : {}) },
							finish_reason: finishReason,
						},
					],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 20,
						total_tokens: 30,
						prompt_tokens_details: { cached_tokens: 4 },
					},
				},
			];
	}
	const body = events
		.map((event) =>
			api === "anthropic-messages"
				? `event: ${(event as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`
				: `data: ${JSON.stringify(event)}\n\n`,
		)
		.join("");
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
}
