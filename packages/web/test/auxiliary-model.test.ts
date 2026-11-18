import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { completeAuxiliaryModel, resolveAuxiliaryModel } from "../src/auxiliary-model.ts";
import { judgeCommit } from "../src/code-monitor-judge.ts";
import { Gatekeeper } from "../src/gatekeeper.ts";
import { GatekeeperStore } from "../src/gatekeeper-store.ts";
import { modelsJsonPath } from "../src/model-config.ts";
import { addLibraryEntry, setLibraryRole, updateLibraryEntry } from "../src/model-library.ts";
import { VulnReviewer } from "../src/reviewer.ts";
import { callSupervisorModel } from "../src/supervisor.ts";
import { VulnerabilityStore } from "../src/vulnerabilities.ts";
import { modelStream } from "./model-stream-fixtures.ts";

interface RequestRecord {
	url: string;
	headers: IncomingHttpHeaders;
	body: Record<string, unknown>;
}

let dir: string;
let server: Server;
let baseUrl: string;
let requests: RequestRecord[];
let respond: (record: RequestRecord) => Response | Promise<Response>;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-aux-model-"));
	requests = [];
	respond = () => modelStream("openai-completions", '{"ok":true}');
	server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const record: RequestRecord = {
			url: request.url ?? "",
			headers: request.headers,
			body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
		};
		requests.push(record);
		const result = await respond(record);
		response.writeHead(result.status, Object.fromEntries(result.headers));
		response.end(await result.text());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing server address");
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	rmSync(dir, { recursive: true, force: true });
});

function configure(api: Api, maxTokens = 16384): string {
	return addLibraryEntry(dir, {
		name: "test",
		baseUrl:
			api === "anthropic-messages" ? baseUrl : `${baseUrl}/${api === "google-generative-ai" ? "v1beta" : "v1"}`,
		apiKey: "test-key",
		modelId: "test-model",
		capabilities: { api, contextWindow: 128000, maxTokens },
	}).id;
}

function endpoint() {
	const config = resolveAuxiliaryModel(dir, "supervisor");
	if (!config) throw new Error("Missing model");
	return config;
}

const APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;

describe("auxiliary SDK calls", () => {
	test.each(APIS)("uses %s protocol, authentication, JSON mode and cache-inclusive usage", async (api) => {
		configure(api);
		respond = () => modelStream(api, '{"ok":true}');
		const reply = await completeAuxiliaryModel(endpoint(), {
			systemPrompt: "Return JSON",
			input: "judge",
			signal: new AbortController().signal,
			maxTokens: 128,
			json: true,
		});
		expect(reply).toMatchObject({
			content: '{"ok":true}',
			finishReason: "stop",
			usage: { input: 10, output: 20, total: 30 },
		});
		expect(requests).toHaveLength(1);
		const request = requests[0];
		switch (api) {
			case "openai-completions":
				expect(request.url).toBe("/v1/chat/completions");
				expect(request.headers.authorization).toBe("Bearer test-key");
				expect(request.body).toMatchObject({
					stream: true,
					response_format: { type: "json_object" },
					messages: [
						{ role: "system", content: "Return JSON" },
						{ role: "user", content: "judge" },
					],
				});
				break;
			case "openai-responses":
				expect(request.url).toBe("/v1/responses");
				expect(request.headers.authorization).toBe("Bearer test-key");
				expect(request.body).toMatchObject({ stream: true, text: { format: { type: "json_object" } } });
				break;
			case "anthropic-messages":
				expect(request.url).toBe("/v1/messages?beta=true");
				expect(request.headers["x-api-key"]).toBe("test-key");
				expect(request.body).toMatchObject({ stream: true, max_tokens: 128 });
				expect(request.body).not.toHaveProperty("response_format");
				break;
			case "google-generative-ai":
				expect(request.url).toContain("/v1beta/models/test-model:streamGenerateContent");
				expect(request.headers["x-goog-api-key"]).toBe("test-key");
				expect(request.body).toMatchObject({
					generationConfig: { maxOutputTokens: 128, responseMimeType: "application/json" },
				});
				break;
		}
	});

	test.each(APIS)("gatekeeper judges through %s and records usage", async (api) => {
		configure(api);
		respond = () => modelStream(api, "BLOCK:删除业务数据");
		const store = new GatekeeperStore(join(dir, "gatekeeper.db"));
		try {
			const gate = new Gatekeeper(store, { onDecision: () => {} }, dir);
			const outcome = await gate.guard({ command: "delete business data", source: "test" });
			expect(outcome.kind).toBe("block");
			expect(store.list(undefined).items[0]).toMatchObject({
				decision: "block",
				inputTokens: 10,
				outputTokens: 20,
				totalTokens: 30,
			});
		} finally {
			store.close();
		}
	});

	test.each(APIS)("supervisor retries truncation and accumulates usage with %s", async (api) => {
		configure(api);
		respond = () =>
			modelStream(
				api,
				requests.length === 1 ? '{"phase":' : '{"phase":"recon"}',
				requests.length === 1 ? "length" : "stop",
			);
		const reply = await callSupervisorModel(endpoint(), "input", new AbortController().signal);
		expect(reply).toMatchObject({ raw: '{"phase":"recon"}', usage: { input: 20, output: 40, total: 60 } });
		expect(requests).toHaveLength(2);
	});

	test.each(APIS)("reviewer calibrates a queued vulnerability through %s", async (api) => {
		configure(api);
		respond = () =>
			modelStream(
				api,
				'{"av":"N","ac":"L","pr":"N","ui":"N","s":"U","c":"L","i":"L","a":"N","dubious":false,"reason":"verified"}',
			);
		const store = new VulnerabilityStore(join(dir, "vulns.db"));
		try {
			let settled: () => void = () => {};
			const done = new Promise<void>((resolve) => {
				settled = resolve;
			});
			const reviewer = new VulnReviewer(store, { onSettled: () => settled() }, dir);
			const vuln = store.create({
				projectId: "p1",
				projectName: "test",
				source: "test",
				title: "finding",
				severity: "critical",
				cvss: 9.8,
				description: "evidence",
				packet: "GET /",
				target: "test",
			});
			reviewer.enqueue(vuln.id);
			await done;
			expect(store.get(vuln.id)).toMatchObject({ severity: "medium", cvss: 6.5, review: { state: "done" } });
		} finally {
			store.close();
		}
	});

	test.each(APIS)("monitor validates a commit verdict through %s", async (api) => {
		configure(api);
		respond = () =>
			modelStream(
				api,
				'{"security":true,"confidence":0.9,"vuln_category":"web","vuln_tags":["ssrf"],"reason":"diff adds host checks"}',
			);
		const config = resolveAuxiliaryModel(dir, "monitor");
		if (!config) throw new Error("Missing model");
		const verdict = await judgeCommit(
			config,
			{ host: "github.com", owner: "test", repo: "test" },
			{
				sha: "abcdef",
				message: "fix host checks",
				author: "test",
				authoredAt: 1700000000000,
				url: "https://github.com/test/test/commit/abcdef",
				parents: 1,
				parentSha: "123456",
				additions: 1,
				deletions: 0,
				files: [],
			},
			"+checkHost(url)",
		);
		expect(verdict).toMatchObject({ security: true, vulnCategory: "web", vulnTags: ["ssrf"] });
		respond = () => modelStream(api, '{"security":true,"reason":"missing category"}');
		await expect(
			judgeCommit(
				config,
				{ host: "github.com", owner: "test", repo: "test" },
				{
					sha: "abcdef",
					message: "fix",
					author: "test",
					authoredAt: 1700000000000,
					url: "https://github.com/test/test/commit/abcdef",
					parents: 1,
					parentSha: "123456",
					additions: 1,
					deletions: 0,
					files: [],
				},
				"+checkHost(url)",
			),
		).rejects.toThrow("vuln_category");
	});

	test("refreshes URL, protocol, key and model after a library edit", async () => {
		const id = configure("openai-completions");
		await completeAuxiliaryModel(endpoint(), {
			systemPrompt: "judge",
			input: "first",
			signal: new AbortController().signal,
		});
		updateLibraryEntry(dir, id, {
			name: "updated",
			baseUrl,
			apiKey: "updated-key",
			modelId: "updated-model",
			capabilities: { api: "anthropic-messages" },
		});
		respond = () => modelStream("anthropic-messages", "updated");
		const reply = await completeAuxiliaryModel(endpoint(), {
			systemPrompt: "judge",
			input: "second",
			signal: new AbortController().signal,
		});
		expect(reply.content).toBe("updated");
		expect(requests[1]).toMatchObject({
			url: "/v1/messages?beta=true",
			headers: { "x-api-key": "updated-key" },
			body: { model: "updated-model" },
		});
	});

	test("honors dedicated roles, model output limits and custom provider headers", async () => {
		configure("openai-completions");
		const dedicated = addLibraryEntry(dir, {
			name: "dedicated",
			baseUrl: `${baseUrl}/dedicated`,
			apiKey: "dedicated-key",
			modelId: "dedicated-model",
			capabilities: { api: "openai-completions", maxTokens: 512 },
		});
		setLibraryRole(dir, "supervisor", dedicated.id);
		const path = modelsJsonPath(dir);
		const source = JSON.parse(readFileSync(path, "utf-8")) as {
			providers: Record<string, { headers?: Record<string, string> }>;
		};
		source.providers[dedicated.id].headers = { "x-custom": "custom-value" };
		writeFileSync(path, JSON.stringify(source));
		await completeAuxiliaryModel(endpoint(), {
			systemPrompt: "judge",
			input: "input",
			signal: new AbortController().signal,
			maxTokens: 8192,
		});
		expect(requests[0]).toMatchObject({
			url: "/dedicated/chat/completions",
			headers: { "x-custom": "custom-value", authorization: "Bearer dedicated-key" },
			body: { model: "dedicated-model" },
		});
		expect(requests[0].body.max_tokens ?? requests[0].body.max_completion_tokens).toBe(512);
	});

	test("reports a provider failure without retrying or accepting partial content", async () => {
		configure("openai-completions");
		respond = () => Response.json({ error: { message: "endpoint unavailable" } }, { status: 503 });
		await expect(
			completeAuxiliaryModel(endpoint(), {
				systemPrompt: "judge",
				input: "input",
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("endpoint unavailable");
		expect(requests).toHaveLength(1);
	});

	test("rejects an interrupted stream even when it already contained a verdict", async () => {
		configure("openai-completions");
		respond = async () => {
			const response = modelStream("openai-completions", "ALLOW");
			return new Response((await response.text()).replace('"finish_reason":"stop"', '"finish_reason":null'), {
				headers: response.headers,
			});
		};
		await expect(
			completeAuxiliaryModel(endpoint(), {
				systemPrompt: "judge",
				input: "input",
				signal: new AbortController().signal,
			}),
		).rejects.toThrow();
	});

	test("does not send a request after cancellation", async () => {
		configure("openai-completions");
		const controller = new AbortController();
		controller.abort();
		await expect(
			completeAuxiliaryModel(endpoint(), { systemPrompt: "judge", input: "input", signal: controller.signal }),
		).rejects.toThrow();
		expect(requests).toHaveLength(0);
	});

	test("cancels an in-flight request within the caller's deadline", async () => {
		configure("openai-completions");
		let release: (response: Response) => void = () => {};
		let started: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		respond = () => {
			started();
			return new Promise<Response>((resolve) => {
				release = resolve;
			});
		};
		const controller = new AbortController();
		const pending = completeAuxiliaryModel(endpoint(), {
			systemPrompt: "judge",
			input: "input",
			signal: controller.signal,
		});
		const rejected = expect(pending).rejects.toThrow("deadline");
		await ready;
		controller.abort(new Error("deadline"));
		await rejected;
		release(modelStream("openai-completions", "late"));
	});
});
