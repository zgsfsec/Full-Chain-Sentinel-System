import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import WebSocket from "ws";
import { startSentinelServer } from "../src/server.ts";
import { installFakeDocker } from "./fake-docker.ts";

test("an idle console receives native keepalive pings and remains usable", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-console-idle-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const docker = installFakeDocker(root, join(root, "workspace"));
	let server: Awaited<ReturnType<typeof startSentinelServer>> | undefined;
	let client: WebSocket | undefined;
	try {
		server = await startSentinelServer({ agentDir, cwd: join(root, "workspace"), auth: false, port: 0 });
		client = new WebSocket(`${server.url.replace("http:", "ws:")}/ws`);
		await once(client, "open");
		await once(client, "ping", { signal: AbortSignal.timeout(30_000) });
		expect(client.readyState).toBe(WebSocket.OPEN);
		const received = once(client, "message", { signal: AbortSignal.timeout(5000) });
		client.send(JSON.stringify({ type: "get_state" }));
		const [data] = await received;
		expect(JSON.parse(String(data))).toMatchObject({ type: "snapshot" });
	} finally {
		client?.terminate();
		server?.close();
		docker.restore();
		rmSync(root, { recursive: true, force: true });
	}
});
