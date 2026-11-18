/**
 * The supervisor model call must survive two common OpenAI-compatible quirks:
 * an answer that arrived only in reasoning_content, and a reasoning model that
 * spent the whole completion budget and returned content: "" with
 * finish_reason=length.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type AuxiliaryModelConfig, resolveAuxiliaryModel } from "../src/auxiliary-model.ts";
import { addLibraryEntry } from "../src/model-library.ts";
import { callSupervisorModel } from "../src/supervisor.ts";
import { modelStream } from "./model-stream-fixtures.ts";

let dir: string;
let config: AuxiliaryModelConfig;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "supervisor-model-call-"));
	addLibraryEntry(dir, {
		name: "supervisor",
		baseUrl: "http://supervisor/v1",
		apiKey: "",
		modelId: "supervisor-model",
	});
	const resolved = resolveAuxiliaryModel(dir, "supervisor");
	if (!resolved) throw new Error("Missing model");
	config = resolved;
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

describe("callSupervisorModel", () => {
	test("uses reasoning_content when content is empty", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => modelStream("openai-completions", "", "stop", '{"phase":"enum"}')),
		);
		const reply = await callSupervisorModel(config, "input", new AbortController().signal);
		expect(reply.raw).toBe('{"phase":"enum"}');
	});

	test("retries once with a larger budget when finish_reason is length", async () => {
		const calls: Array<{ max_tokens?: number; max_completion_tokens?: number }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: { body: string }) => {
				const body = JSON.parse(init.body) as { max_tokens?: number; max_completion_tokens?: number };
				calls.push(body);
				return calls.length === 1
					? modelStream("openai-completions", "", "length")
					: modelStream("openai-completions", '{"phase":"recon"}');
			}),
		);
		const reply = await callSupervisorModel(config, "input", new AbortController().signal);
		expect(reply.raw).toBe('{"phase":"recon"}');
		expect(calls.map((call) => call.max_tokens ?? call.max_completion_tokens)).toEqual([8192, 16384]);
		expect(reply.usage).toEqual({ input: 20, output: 40, total: 60 });
	});

	test("reports finish_reason and token counts instead of a bare empty error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => modelStream("openai-completions", "", "content_filter")),
		);
		await expect(callSupervisorModel(config, "input", new AbortController().signal)).rejects.toThrow(
			/finish_reason=content_filter.*completion_tokens=20/,
		);
	});
});
