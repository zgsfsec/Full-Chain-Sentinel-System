import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import WebSocket from "ws";
import type { SentinelEngine, SentinelEngineCreateInput } from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";
import type { WorkProcess } from "../src/work-process-types.ts";
import { installFakeDocker } from "./fake-docker.ts";

test("engine creation enables only opted-in work links and retains recording after startup failure", async () => {
	const dir = mkdtempSync(join(tmpdir(), "engine-work-links-server-"));
	const cwd = join(dir, "projects", "p1");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify({
			projects: [{ id: "p1", name: "项目", workDir: cwd, container: "sentinel-p1", createdAt: "2026-01-01" }],
			lastActiveProjectId: "p1",
		}),
	);
	const docker = installFakeDocker(dir, cwd);
	const server = await startSentinelServer({ cwd, agentDir: dir, auth: false, host: "127.0.0.1", port: 0 });
	const ws = new WebSocket(`${server.url.replace("http:", "ws:")}/ws`);
	const engines = new Map<string, SentinelEngine>();
	ws.on("message", (raw) => {
		const message = JSON.parse(String(raw)) as { type: string; engine?: SentinelEngine };
		if (message.type === "engine_update" && message.engine) engines.set(message.engine.name, message.engine);
	});
	const detail = async (id: string): Promise<WorkProcess> =>
		(
			(await (await fetch(`${server.url}/api/work-processes/detail?projectId=p1&kind=engine&id=${id}`)).json()) as {
				process: WorkProcess;
			}
		).process;
	try {
		await once(ws, "open");
		await server.environment;
		for (const [name, recordWorkLinks, scheduled] of [
			["default-off", undefined, true],
			["scheduled-on", true, true],
			["immediate-on", true, false],
		] as const) {
			const input: SentinelEngineCreateInput = {
				name,
				recordWorkLinks,
				targets: "https://example.test",
				doctrines: ["attack-defense-web"],
				limits: { concurrency: 1, roundLimit: 1, maxRetries: 0, tokenLimit: null, timeLimitMin: null },
				...(scheduled ? { schedule: { timezone: "UTC", startAt: Date.now() + 3600_000 } } : {}),
			};
			ws.send(JSON.stringify({ type: "engine_create", input }));
			await vi.waitFor(() => expect(engines.has(name)).toBe(true), { timeout: 5000 });
			const engine = engines.get(name)!;
			await vi.waitFor(async () => expect((await detail(engine.id)).enabled).toBe(recordWorkLinks === true));
			if (scheduled) expect(engine.status).toBe("scheduled");
			else await vi.waitFor(() => expect(engines.get(name)?.status).toBe("paused"));
			if (recordWorkLinks) {
				expect((await detail(engine.id)).nodes).toContainEqual(
					expect.objectContaining({ kind: "root", title: name }),
				);
				const pause = await fetch(
					`${server.url}/api/work-processes/control?projectId=p1&kind=engine&id=${engine.id}`,
					{ method: "POST", headers: { "content-type": "application/json" }, body: '{"action":"pause"}' },
				);
				expect(pause.ok).toBe(true);
			}
		}
		expect(engines.size).toBe(3);
	} finally {
		ws.terminate();
		server.close();
		docker.restore();
		rmSync(dir, { recursive: true, force: true });
	}
});
