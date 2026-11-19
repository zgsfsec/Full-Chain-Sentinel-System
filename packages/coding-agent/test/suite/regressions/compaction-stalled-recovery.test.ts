import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function seedFailedAttempt(harness: Harness): void {
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: "old task ".repeat(500),
		timestamp: Date.now() - 2000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("previous answer", { timestamp: Date.now() - 1000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	harness.sessionManager.appendMessage({ role: "user", content: "pending question", timestamp: Date.now() - 500 });
	const response = fauxAssistantMessage("", { stopReason: "length" });
	const attempt = harness.sessionManager.appendMessage({
		...response,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...response.usage, input: 125_499, output: 1, totalTokens: 125_500 },
	});
	harness.sessionManager.appendContextEdit(attempt, null);
	harness.session.refreshContext();
}

describe("compaction recovers sessions with omitted empty length responses", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		vi.useRealTimers();
	});

	it("compacts the measured oversized input before sending another question", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 16_384 }],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Recovered task checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedFailedAttempt(harness);
		harness.setResponses([
			(context) => {
				const input = JSON.stringify(context.messages);
				expect(input).toContain("Recovered task checkpoint");
				expect(input).not.toContain("old task old task");
				return fauxAssistantMessage("Working again");
			},
		]);

		await harness.session.prompt("continue");

		expect(harness.eventsOfType("compaction_end")[0].result?.tokensBefore).toBe(125_499);
		expect(harness.session.getLastAssistantText()).toBe("Working again");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("does not send the oversized conversation when pre-prompt summarization fails", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 16_384 }],
			settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: false } },
		});
		harnesses.push(harness);
		seedFailedAttempt(harness);
		harness.setResponses([
			fauxAssistantMessage("partial summary", { stopReason: "length" }),
			fauxAssistantMessage("must not send original prompt"),
		]);

		await expect(harness.session.prompt("continue")).rejects.toThrow("summary is incomplete");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain("summary is incomplete");
	});

	it("stops before calling the provider when a generated checkpoint still exceeds the threshold", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 16_384 }],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "x".repeat(500_000),
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedFailedAttempt(harness);
		await expect(harness.session.prompt("continue")).rejects.toThrow("Context is still too large after compaction");
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain("Context is still too large");
		expect(harness.session.isIdle).toBe(true);
	});

	it.each(["timeout", "cancel"])(
		"releases a manual compaction on %s even if the provider ignores abort",
		async (action) => {
			const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
			harnesses.push(harness);
			seedFailedAttempt(harness);
			let requestOptions: SimpleStreamOptions | undefined;
			let started: (() => void) | undefined;
			const requestStarted = new Promise<void>((resolve) => {
				started = resolve;
			});
			const stream = createAssistantMessageEventStream();
			const stalled: StreamFn = (_model, _context, options) => {
				requestOptions = options;
				started?.();
				return stream;
			};
			harness.session.agent.streamFunction = stalled;
			vi.useFakeTimers();
			const pending = harness.session.compact();
			const rejected = expect(pending).rejects.toThrow(action === "timeout" ? "timed out" : /abort|cancel/i);
			await requestStarted;
			if (action === "timeout") await vi.advanceTimersByTimeAsync(5 * 60_000);
			else harness.session.abortCompaction();
			await rejected;

			expect(requestOptions?.signal?.aborted).toBe(true);
			expect(harness.session.isCompacting).toBe(false);
			expect(harness.session.isIdle).toBe(true);
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: action === "cancel" });
			const late = fauxAssistantMessage("late summary must not be saved");
			stream.push({ type: "done", reason: "stop", message: late });
			await Promise.resolve();
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		},
	);
});
