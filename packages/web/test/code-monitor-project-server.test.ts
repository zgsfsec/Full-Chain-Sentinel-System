import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CodeMonitorStore, codeMonitorDbPath } from "../src/code-monitor-store.ts";
import { writeConsentRecord } from "../src/consent.ts";
import { startSentinelServer } from "../src/server.ts";
import { installFakeDocker } from "./fake-docker.ts";

test("project monitoring API requires gate, login and consent, validates changes, and persists the project scope", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-monitor-api-"));
	const workDir = join(dir, "projects", "p1");
	mkdirSync(workDir, { recursive: true });
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify({
			projects: ["p1", "p2"].map((id) => ({
				id,
				name: id,
				container: `sentinel-${id}`,
				workDir,
				createdAt: "2026-01-01",
			})),
			lastActiveProjectId: "p1",
		}),
	);
	const docker = installFakeDocker(dir, workDir);
	const server = await startSentinelServer({
		cwd: dir,
		agentDir: dir,
		host: "127.0.0.1",
		port: 0,
		gateToken: "monitor-test-gate",
	});
	const origin = new URL(server.url).origin;
	const path = `${origin}/api/code-monitors/project?projectId=p1`;
	try {
		expect((await fetch(path)).status).toBe(404);
		const entry = await fetch(server.url, { redirect: "manual" });
		const gate = entry.headers.get("set-cookie")?.split(";")[0];
		if (!gate) throw new Error("Missing gate cookie");
		expect((await fetch(path, { headers: { cookie: gate } })).status).toBe(401);
		const setup = await fetch(`${origin}/api/auth/setup`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: gate },
			body: JSON.stringify({ username: "operator", password: "monitoring test password" }),
		});
		const session = setup.headers.get("set-cookie")?.split(";")[0];
		if (!session) throw new Error("Missing session cookie");
		const headers = { cookie: `${gate}; ${session}`, "content-type": "application/json" };
		expect((await fetch(path, { headers })).status).toBe(403);
		writeConsentRecord(dir, "operator");
		const get = await fetch(path, { headers });
		expect(get.status).toBe(200);
		expect(get.headers.get("cache-control")).toBe("no-store");
		expect(await get.json()).toEqual({ projectId: "p1", enabled: true });
		for (const body of ['{"enabled":"false"}', "{}", "{"]) {
			expect((await fetch(path, { method: "POST", headers, body })).status).toBe(400);
		}
		expect((await fetch(path, { method: "DELETE", headers })).status).toBe(405);
		expect((await fetch(path.replace("p1", "missing"), { headers })).status).toBe(404);
		const pause = await fetch(path, { method: "POST", headers, body: JSON.stringify({ enabled: false }) });
		expect(await pause.json()).toEqual({ projectId: "p1", enabled: false });
		expect(await (await fetch(path, { headers })).json()).toEqual({ projectId: "p1", enabled: false });
		expect(await (await fetch(path.replace("p1", "p2"), { headers })).json()).toEqual({
			projectId: "p2",
			enabled: true,
		});
		const reopened = new CodeMonitorStore(codeMonitorDbPath(dir));
		try {
			expect(reopened.projectEnabled("p1")).toBe(false);
		} finally {
			reopened.close();
		}
		const resume = await fetch(path, { method: "POST", headers, body: JSON.stringify({ enabled: true }) });
		expect(await resume.json()).toEqual({ projectId: "p1", enabled: true });
	} finally {
		await server.environment;
		server.close();
		docker.restore();
		rmSync(dir, { force: true, recursive: true });
	}
});
