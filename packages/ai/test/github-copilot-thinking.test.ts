import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] });

describe("GitHub Copilot thinking", () => {
	// Regression for #12019: Copilot must receive the selected effort for Gemini and Kimi.
	it.each(["gemini-4-argon", "gemini-4-carbon", "gemini-3.8-flash", "kimi-k3"] as const)(
		"forwards the selected effort for %s",
		async (id) => {
			const model = getModel("github-copilot", id);
			expect(model.api).toBe("openai-completions");
			for (const reasoning of ["low", "high"] as const) {
				let payload: unknown;
				await streamSimple({ ...model, api: "openai-completions" }, context, {
					apiKey: "test-key",
					reasoning,
					onPayload: (value) => {
						payload = value;
						throw new Error("payload captured");
					},
				}).result();
				expect(payload).toMatchObject({ reasoning_effort: reasoning });
			}
		},
	);

	// Regression for #12019: Copilot returns reasoning_tokens at the top level of usage.
	it.each([{ reasoning_tokens: 21 }, { reasoning_tokens: 21, completion_tokens_details: { reasoning_tokens: 13 } }])(
		"reads reasoning usage without double counting output: %j",
		async (details) => {
			const events = [
				{
					id: "chat_test",
					choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 10, completion_tokens: 33, ...details },
				},
			];
			const response = await streamSimple(
				{ ...getModel("github-copilot", "gemini-4-argon"), api: "openai-completions" },
				context,
				{
					apiKey: "test-key",
					reasoning: "low",
					fetch: async () =>
						new Response(
							`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
							{
								headers: { "content-type": "text/event-stream" },
							},
						),
				},
			).result();
			expect(response.stopReason).toBe("stop");
			expect(response.usage).toMatchObject({
				input: 10,
				output: 33,
				totalTokens: 43,
				reasoning: details.completion_tokens_details?.reasoning_tokens ?? details.reasoning_tokens,
			});
		},
	);
});
