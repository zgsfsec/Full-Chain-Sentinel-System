import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { writeProviderModelConfig } from "../src/model-config.ts";
import type { RemoteModelInput } from "../src/remote-model-types.ts";
import { fetchRemoteModels } from "../src/remote-models.ts";
import { handleRemoteModelsApi } from "../src/remote-models-api.ts";

let remote: Server;
let api: Server;
let baseUrl: string;
let apiUrl: string;
let agentDir: string;
let authorized = true;
let calls: { path: string; headers: IncomingMessage["headers"] }[] = [];
let reply = (_request: IncomingMessage, response: ServerResponse) => response.end('{"data":[]}');

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing server address");
	return `http://127.0.0.1:${address.port}`;
}

function input(patch: Partial<RemoteModelInput> = {}): RemoteModelInput {
	return { baseUrl: `${baseUrl}/v1`, api: "openai-completions", apiKey: "test-secret", ...patch };
}

beforeAll(async () => {
	agentDir = mkdtempSync(join(tmpdir(), "sentinel-remote-models-"));
	remote = createServer((request, response) => {
		calls.push({ path: request.url ?? "", headers: request.headers });
		response.setHeader("content-type", "application/json");
		reply(request, response);
	});
	baseUrl = await listen(remote);
	api = createServer((request, response) => {
		void handleRemoteModelsApi(request, response, agentDir, () => authorized);
	});
	apiUrl = await listen(api);
	writeProviderModelConfig(agentDir, "saved", "Saved", {
		baseUrl: `${baseUrl}/v1`,
		apiKey: "stored-secret",
		modelId: "old",
	});
});

afterEach(() => {
	calls = [];
	authorized = true;
	reply = (_request, response) => response.end('{"data":[]}');
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

afterAll(async () => {
	await Promise.all([remote, api].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	rmSync(agentDir, { recursive: true, force: true });
});

test.each(["openai-completions", "openai-responses"])(
	"%s uses the configured path and bearer, deduplicating IDs",
	async (protocol) => {
		reply = (_request, response) =>
			response.end(
				JSON.stringify({
					data: [{ id: " model-b ", name: "Model B" }, { id: "model-a" }, { id: "model-a" }, { id: 12 }, null],
				}),
			);
		expect(await fetchRemoteModels(undefined, input({ api: protocol, baseUrl: `${baseUrl}/relay/v1/` }))).toEqual({
			models: [
				{ id: "model-b", name: "Model B" },
				{ id: "model-a", name: "model-a" },
			],
			truncated: false,
		});
		expect(calls[0]?.path).toBe("/relay/v1/models");
		expect(calls[0]?.headers.authorization).toBe("Bearer test-secret");
	},
);

test("OpenAI root endpoints get /v1/models and explicit empty keys remain unauthenticated", async () => {
	await fetchRemoteModels(undefined, input({ baseUrl, apiKey: "" }));
	expect(calls[0]?.path).toBe("/v1/models");
	expect(calls[0]?.headers.authorization).toBeUndefined();
});

test.each(["", "/v1", "/relay"])("Anthropic at %s uses versioned auth and follows cursors", async (path) => {
	reply = (request, response) =>
		response.end(
			JSON.stringify(
				request.url?.includes("after_id=")
					? { data: [{ id: "claude-b", display_name: "Claude B" }], has_more: false }
					: { data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" },
			),
		);
	const result = await fetchRemoteModels(
		undefined,
		input({ api: "anthropic-messages", baseUrl: `${baseUrl}${path}` }),
	);
	expect(result.models.map((model) => model.id)).toEqual(["claude-a", "claude-b"]);
	expect(result.truncated).toBe(false);
	expect(calls[0]?.path).toBe(`${path === "/v1" ? path : `${path}/v1`}/models?limit=100`);
	expect(calls[1]?.path).toContain("after_id=claude-a");
	expect(calls[0]?.headers["x-api-key"]).toBe("test-secret");
	expect(calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
});

test("Gemini normalizes model IDs, excludes embedding models and follows page tokens", async () => {
	reply = (request, response) =>
		response.end(
			JSON.stringify(
				request.url?.includes("pageToken=")
					? {
							models: [
								{
									name: "models/gemini-b",
									displayName: "Gemini B",
									supportedGenerationMethods: ["generateContent"],
								},
							],
						}
					: {
							models: [
								{ name: "models/gemini-a" },
								{ name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
							],
							nextPageToken: "next/page",
						},
			),
		);
	const result = await fetchRemoteModels(
		undefined,
		input({ api: "google-generative-ai", baseUrl: `${baseUrl}/v1beta` }),
	);
	expect(result.models).toEqual([
		{ id: "gemini-a", name: "gemini-a" },
		{ id: "gemini-b", name: "Gemini B" },
	]);
	expect(calls[0]?.path).toBe("/v1beta/models?pageSize=1000");
	expect(calls[1]?.path).toContain("pageToken=next%2Fpage");
	expect(calls[0]?.headers["x-goog-api-key"]).toBe("test-secret");
	expect(calls[0]?.headers.authorization).toBeUndefined();
});

test("saved keys stay server-side, can be overridden, and are never reused on a different origin", async () => {
	await fetchRemoteModels(agentDir, input({ entryId: "saved", apiKey: null, baseUrl: `${baseUrl}/other/v1` }));
	expect(calls[0]?.headers.authorization).toBe("Bearer stored-secret");
	await fetchRemoteModels(agentDir, input({ entryId: "saved", apiKey: "replacement" }));
	expect(calls[1]?.headers.authorization).toBe("Bearer replacement");
	await expect(
		fetchRemoteModels(agentDir, input({ entryId: "saved", apiKey: null, baseUrl: `${apiUrl}/v1` })),
	).rejects.toThrow("端点已变化");
	await expect(fetchRemoteModels(agentDir, input({ entryId: "missing", apiKey: null }))).rejects.toThrow("端点配置");
	expect(calls).toHaveLength(2);
});

test("saved unauthenticated placeholders are not sent as real credentials", async () => {
	writeProviderModelConfig(agentDir, "no-auth", "No auth", { baseUrl: `${baseUrl}/v1`, apiKey: "", modelId: "old" });
	await fetchRemoteModels(agentDir, input({ entryId: "no-auth", apiKey: null }));
	expect(calls[0]?.headers.authorization).toBeUndefined();
});

test.each([401, 403, 404, 405, 429, 500, 302])(
	"HTTP %s yields actionable errors without echoing upstream secrets",
	async (status) => {
		reply = (_request, response) => {
			response.writeHead(status, { location: `${apiUrl}/redirect` });
			return response.end("test-secret stored-secret");
		};
		const result = await fetchRemoteModels(undefined, input()).catch((error: Error) => error.message);
		expect(typeof result).toBe("string");
		expect(result).not.toContain("test-secret");
		expect(result).not.toContain("stored-secret");
		expect(calls).toHaveLength(1);
	},
);

test.each(["not JSON", "null", '{"error":"secret"}', '{"data":{}}'])(
	"invalid remote replies fail cleanly: %s",
	async (body) => {
		reply = (_request, response) => response.end(body);
		await expect(fetchRemoteModels(undefined, input())).rejects.toThrow("有效的模型列表");
	},
);

test("repeated pagination cursors stop and mark the result incomplete", async () => {
	reply = (_request, response) => response.end('{"data":[{"id":"same"}],"has_more":true,"last_id":"same"}');
	expect(await fetchRemoteModels(undefined, input({ api: "anthropic-messages" }))).toEqual({
		models: [{ id: "same", name: "same" }],
		truncated: true,
	});
	expect(calls).toHaveLength(2);
});

test("large model lists are capped rather than exhausting memory", async () => {
	reply = (_request, response) =>
		response.end(JSON.stringify({ data: Array.from({ length: 5001 }, (_, id) => ({ id: `model-${id}` })) }));
	const result = await fetchRemoteModels(undefined, input());
	expect(result.models).toHaveLength(5000);
	expect(result.truncated).toBe(true);
});

test("oversized responses are aborted", async () => {
	reply = (_request, response) => response.end(JSON.stringify({ data: [], padding: "x".repeat(4 * 1024 * 1024) }));
	await expect(fetchRemoteModels(undefined, input())).rejects.toThrow("列表过大");
});

test("discovery has a total timeout", async () => {
	vi.useFakeTimers();
	vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
		return controller.signal;
	});
	vi.stubGlobal(
		"fetch",
		(_url: URL, options: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
			}),
	);
	const failed = expect(fetchRemoteModels(undefined, input())).rejects.toThrow("获取模型列表超时");
	await vi.advanceTimersByTimeAsync(15000);
	await failed;
});

test("unsupported protocols and invalid URLs never make requests", async () => {
	await expect(fetchRemoteModels(undefined, input({ api: "bedrock-converse-stream" }))).rejects.toThrow(
		"当前协议不支持",
	);
	for (const url of ["invalid", "file:///tmp/model", "https://name:password@example.com"])
		await expect(fetchRemoteModels(undefined, input({ baseUrl: url }))).rejects.toThrow("Base URL");
	expect(calls).toHaveLength(0);
});

test("HTTP endpoint returns models from an unsaved draft and no credentials", async () => {
	reply = (_request, response) => response.end('{"data":[{"id":"new-model"}]}');
	const response = await fetch(apiUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input({ entryId: "saved", apiKey: null })),
	});
	expect(response.ok).toBe(true);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.json()).toEqual({ models: [{ id: "new-model", name: "new-model" }], truncated: false });
	expect(calls[0]?.headers.authorization).toBe("Bearer stored-secret");
});

test.each([
	{ method: "GET", status: 405 },
	{ method: "POST", body: "{}", status: 415 },
	{ method: "POST", body: "{}", contentType: "application/json", status: 400 },
	{ method: "POST", body: "null", contentType: "application/json", status: 400 },
	{ method: "POST", body: "not JSON", contentType: "application/json", status: 400 },
	{ method: "POST", body: `"${"x".repeat(17000)}"`, contentType: "application/json", status: 413 },
])("invalid API request returns $status before discovery", async ({ method, body, contentType, status }) => {
	const response = await fetch(apiUrl, { method, body, headers: contentType ? { "content-type": contentType } : {} });
	expect(response.status).toBe(status);
	await response.text();
	expect(calls).toHaveLength(0);
});

test("authorization is checked again before loading a saved key", async () => {
	authorized = false;
	const response = await fetch(apiUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input({ entryId: "saved", apiKey: null })),
	});
	expect(response.status).toBe(401);
	await response.text();
	expect(calls).toHaveLength(0);
});
