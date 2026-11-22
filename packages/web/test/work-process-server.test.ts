import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionDirPath, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { writeConsentRecord } from "../src/consent.ts";
import { EngineStore } from "../src/engine-store.ts";
import { addLibraryEntry, setLibraryRole } from "../src/model-library.ts";
import { startSentinelServer } from "../src/server.ts";
import type { WorkProcess } from "../src/work-process-types.ts";
import { installFakeDocker } from "./fake-docker.ts";
import { modelStream } from "./model-stream-fixtures.ts";
import { workReply } from "./work-process-fixtures.ts";

test("work process API: gate, authentication, consent, history, dedicated model, evidence, revisions and project isolation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "work-process-api-"));
	const cwd = join(dir, "projects", "p1");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify({
			projects: ["p1", "p2"].map((id) => ({
				id,
				name: id,
				container: `sentinel-${id}`,
				workDir: join(dir, "projects", id),
				createdAt: "2026-01-01",
			})),
			lastActiveProjectId: "p1",
		}),
	);
	const docker = installFakeDocker(dir, cwd);
	const session = SessionManager.create(cwd, getSessionDirPath(cwd, dir));
	session.appendMessage({ role: "user", content: "检查接口权限", timestamp: Date.now() });
	const id = session.getSessionId();
	const engines = new EngineStore(join(dir, "engines.db"));
	const engine = engines.createEngine({
		projectId: "p1",
		projectName: "p1",
		name: "权限工程",
		targets: [{ target: "https://example.test" }],
		doctrines: [],
		status: "paused",
		gateMode: "auto",
		limits: { concurrency: 1, roundLimit: 1, tokenLimit: null, timeLimitMin: null, maxRetries: 1 },
	});
	engines.appendEvent(engine.id, { seq: 1, at: Date.now(), kind: "text", text: "确认目标后派发任务" });
	engines.close();
	const requests: Record<string, unknown>[] = [];
	let echoedHistory = false;
	const provider = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
			messages: { role: string; content: string }[];
			model: string;
		};
		requests.push(body);
		const input = body.messages.find((message) => message.role === "user")?.content ?? "";
		const context = JSON.parse(input) as { nodes: { id: string; previousEvidenceIds: string[] }[] };
		const result = JSON.parse(workReply(input).content) as { nodes: { id: string; evidenceIds: string[] }[] };
		for (const node of result.nodes) {
			const history = context.nodes.find((previous) => previous.id === node.id)?.previousEvidenceIds ?? [];
			if (history.length) echoedHistory = true;
			node.evidenceIds.unshift(...history);
		}
		const stream = modelStream(
			"openai-completions",
			JSON.stringify(result),
			requests.length === 1 ? "length" : "stop",
		);
		response.writeHead(200, Object.fromEntries(stream.headers));
		response.end(await stream.text());
	});
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	const address = provider.address();
	if (!address || typeof address === "string") throw new Error("Missing model server address");
	addLibraryEntry(dir, { name: "main", baseUrl: "http://127.0.0.1:1/v1", modelId: "main-never-called", apiKey: "" });
	const analysis = addLibraryEntry(dir, {
		name: "work analysis",
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		modelId: "work-analysis",
		apiKey: "test-key",
	});
	setLibraryRole(dir, "workprocess", analysis.id);
	const server = await startSentinelServer({
		cwd,
		agentDir: dir,
		host: "127.0.0.1",
		port: 0,
		gateToken: "work-process-test-gate",
	});
	const origin = new URL(server.url).origin;
	const query = `projectId=p1&kind=session&id=${id}`;
	const detail = `${origin}/api/work-processes/detail?${query}`;
	try {
		expect((await fetch(detail)).status).toBe(404);
		const entry = await fetch(server.url, { redirect: "manual" });
		const gate = entry.headers.get("set-cookie")?.split(";")[0];
		if (!gate) throw new Error("Missing gate cookie");
		expect((await fetch(detail, { headers: { cookie: gate } })).status).toBe(401);
		const setup = await fetch(`${origin}/api/auth/setup`, {
			method: "POST",
			headers: { cookie: gate, "content-type": "application/json" },
			body: JSON.stringify({ username: "operator", password: "work process testing password" }),
		});
		const token = setup.headers.get("set-cookie")?.split(";")[0];
		if (!token) throw new Error("Missing login cookie");
		const headers = { cookie: `${gate}; ${token}`, "content-type": "application/json" };
		expect((await fetch(detail, { headers })).status).toBe(403);
		writeConsentRecord(dir, "operator");
		const initial = await fetch(detail, { headers });
		expect(initial.status).toBe(200);
		expect(initial.headers.get("cache-control")).toBe("no-store");
		expect(await initial.json()).toMatchObject({ process: { enabled: false, revision: 0 } });
		expect(requests).toHaveLength(0);
		const list = await fetch(`${origin}/api/work-processes?projectId=p1&kind=session`, { headers });
		expect(await list.json()).toMatchObject({
			items: expect.arrayContaining([expect.objectContaining({ id, state: "off" })]),
		});
		const control = `${origin}/api/work-processes/control?${query}`;
		for (const body of ["{", "{}", '{"action":"unknown"}', '{"action":true}'])
			expect((await fetch(control, { method: "POST", headers, body })).status).toBe(400);
		expect((await fetch(control, { headers })).status).toBe(405);
		expect((await fetch(control, { method: "POST", headers: { cookie: headers.cookie }, body: "{}" })).status).toBe(
			415,
		);
		expect((await fetch(control, { method: "POST", headers, body: " ".repeat(4200) })).status).toBe(413);
		expect((await fetch(detail.replace("projectId=p1", "projectId=p2"), { headers })).status).toBe(404);
		expect((await fetch(detail.replace(`id=${id}`, "id=../outside"), { headers })).status).toBe(400);
		expect((await fetch(`${origin}/api/work-processes/no-route?${query}`, { headers })).status).toBe(404);
		const analyze = await fetch(control, { method: "POST", headers, body: JSON.stringify({ action: "analyze" }) });
		expect(analyze.status).toBe(200);
		let graph: WorkProcess | undefined;
		await vi.waitFor(async () => {
			graph = ((await (await fetch(detail, { headers })).json()) as { process: WorkProcess }).process;
			expect(graph.revision).toBe(1);
		});
		expect(graph?.enabled).toBe(false);
		expect(graph?.usage.total).toBe(60);
		expect(graph?.compactAnalysis).toBe(true);
		expect(requests).toHaveLength(2);
		expect(requests[0].model).toBe("work-analysis");
		expect(requests[0]).not.toHaveProperty("tools");
		const node = graph?.nodes.find((node) => node.kind === "step");
		if (!node) throw new Error("Missing step");
		const evidence = await fetch(
			`${origin}/api/work-processes/evidence?${query}&evidenceId=${encodeURIComponent(node.evidenceIds[0])}`,
			{ headers },
		);
		expect(await evidence.json()).toMatchObject({ text: "检查接口权限", truncated: false });
		const revisions = await fetch(
			`${origin}/api/work-processes/revisions?${query}&nodeId=${encodeURIComponent(node.id)}`,
			{ headers },
		);
		expect(await revisions.json()).toMatchObject({ revisions: [expect.objectContaining({ revision: 1 })] });
		const engineQuery = `projectId=p1&kind=engine&id=${engine.id}`;
		const engineDetail = await fetch(`${origin}/api/work-processes/detail?${engineQuery}`, { headers });
		expect(engineDetail.status).toBe(200);
		expect(await engineDetail.json()).toMatchObject({
			process: { kind: "engine", nodes: expect.arrayContaining([expect.objectContaining({ kind: "agent" })]) },
		});
		expect(
			(
				await fetch(`${origin}/api/work-processes/control?${engineQuery}`, {
					method: "POST",
					headers,
					body: '{"action":"analyze"}',
				})
			).status,
		).toBe(200);
		await vi.waitFor(async () =>
			expect(
				await (await fetch(`${origin}/api/work-processes/detail?${engineQuery}`, { headers })).json(),
			).toMatchObject({ process: { revision: 1, enabled: false } }),
		);
		expect(
			(
				await fetch(`${origin}/api/work-processes/detail?${engineQuery.replace("projectId=p1", "projectId=p2")}`, {
					headers,
				})
			).status,
		).toBe(404);
		const enabled = await fetch(control, { method: "POST", headers, body: '{"action":"enable"}' });
		expect(await enabled.json()).toMatchObject({ process: { enabled: true } });
		session.appendMessage({ role: "user", content: "继续检查其他接口", timestamp: Date.now() });
		await vi.waitFor(
			async () => {
				const updated = (await (await fetch(detail, { headers })).json()) as { process: WorkProcess };
				expect(updated.process.revision).toBe(2);
				expect(updated.process.nodes.filter((entry) => entry.kind === "step")).toHaveLength(1);
				expect(updated.process.nodes.find((entry) => entry.kind === "step")?.id).toBe(node.id);
			},
			{ timeout: 8000 },
		);
		const paused = await fetch(control, { method: "POST", headers, body: '{"action":"pause"}' });
		expect(echoedHistory).toBe(true);
		expect(await paused.json()).toMatchObject({ process: { enabled: false, revision: 2 } });
		expect(requests).toHaveLength(4);
	} finally {
		await server.environment;
		server.close();
		docker.restore();
		provider.closeAllConnections();
		await new Promise<void>((resolve) => provider.close(() => resolve()));
		rmSync(dir, { force: true, recursive: true });
	}
});
