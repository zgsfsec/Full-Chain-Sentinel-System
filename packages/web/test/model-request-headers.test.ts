import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { modelsJsonPath, readProviderModelConfig } from "../src/model-config.ts";
import { addLibraryEntry, libraryView, updateLibraryEntry } from "../src/model-library.ts";

let dir = "";
const endpoint = { name: "Relay", baseUrl: "https://relay.example/v1", apiKey: "", modelId: "model" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-model-headers-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("persists model request headers but returns only their names to the settings view", () => {
	const entry = addLibraryEntry(dir, {
		...endpoint,
		capabilities: { headers: { "X-Enable-Thinking": "false", "X-Access-Token": "secret-value" } },
	});

	expect(readProviderModelConfig(dir, entry.id)?.capabilities?.headers).toEqual({
		"X-Enable-Thinking": "false",
		"X-Access-Token": "secret-value",
	});
	const view = libraryView(dir);
	expect(view.entries[0]?.customHeaders).toEqual(["X-Enable-Thinking", "X-Access-Token"]);
	expect(JSON.stringify(view)).not.toContain("secret-value");
	expect(JSON.parse(readFileSync(modelsJsonPath(dir), "utf8")).providers[entry.id].models[0].headers).toEqual({
		"X-Enable-Thinking": "false",
		"X-Access-Token": "secret-value",
	});
});

test("keeps a hidden saved value when blank and removes a header omitted from the editor", () => {
	const entry = addLibraryEntry(dir, {
		...endpoint,
		capabilities: { headers: { "X-Access-Token": "secret-value", "X-Mode": "old" } },
	});
	updateLibraryEntry(dir, entry.id, {
		...endpoint,
		apiKey: null,
		capabilities: { headers: { "x-access-token": "", "X-Mode": "new" } },
	});
	expect(readProviderModelConfig(dir, entry.id)?.capabilities?.headers).toEqual({
		"X-Access-Token": "secret-value",
		"X-Mode": "new",
	});

	updateLibraryEntry(dir, entry.id, {
		...endpoint,
		apiKey: null,
		capabilities: { headers: null },
	});
	expect(readProviderModelConfig(dir, entry.id)?.capabilities?.headers).toBeUndefined();
});

test("rejects invalid header names, duplicate names, and control-character injection", () => {
	const invalidHeaders: Record<string, string>[] = [
		{ "Bad Header": "value" },
		{ "X-Token": "one", "x-token": "two" },
		{ "X-Token": "value\r\nInjected: yes" },
		{ "X-Token": "value\u0000injected" },
	];
	for (const headers of invalidHeaders) {
		expect(() => addLibraryEntry(dir, { ...endpoint, capabilities: { headers } })).toThrow();
	}
	expect(libraryView(dir).entries).toEqual([]);
});

test("does not accept an empty value for a newly added header", () => {
	expect(() => addLibraryEntry(dir, { ...endpoint, capabilities: { headers: { "X-Mode": "" } } })).toThrow(
		/Request header value is required/,
	);
	expect(libraryView(dir).entries).toEqual([]);
});
