import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startSentinelServer } from "../src/server.ts";

test("MITM routes share the console entry gate, login and authorization statement", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-mitm-access-"));
	const token = "a".repeat(64);
	const started = await startSentinelServer({
		cwd: root,
		agentDir: root,
		host: "127.0.0.1",
		port: 0,
		gateToken: token,
	});
	const origin = new URL(started.url).origin;
	const routes = [
		"/api/mitm?projectId=a",
		"/api/mitm/flows?projectId=a",
		"/api/mitm/ca.pem?projectId=a",
		"/api/mitm/flows/flw_one/response?projectId=a",
	];
	try {
		for (const path of routes) expect((await fetch(origin + path)).status).toBe(404);
		const entry = await fetch(`${origin}/${token}`, { redirect: "manual" });
		const gate = entry.headers.get("set-cookie")?.split(";")[0] ?? "";
		expect(gate).not.toBe("");
		for (const path of routes) expect((await fetch(origin + path, { headers: { cookie: gate } })).status).toBe(401);
		const setup = await fetch(`${origin}/api/auth/setup`, {
			method: "POST",
			headers: { cookie: gate, "content-type": "application/json" },
			body: JSON.stringify({ username: "operator", password: "mitm-test-password" }),
		});
		expect(setup.status).toBe(200);
		const session = setup.headers.get("set-cookie")?.split(";")[0] ?? "";
		const cookie = `${gate}; ${session}`;
		for (const path of routes) expect((await fetch(origin + path, { headers: { cookie } })).status).toBe(403);
		const accepted = await fetch(`${origin}/api/consent/accept`, {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ accepted: true }),
		});
		expect(accepted.status).toBe(200);
		for (const path of routes) expect((await fetch(origin + path, { headers: { cookie } })).status).toBe(409);
	} finally {
		started.close();
		rmSync(root, { recursive: true, force: true });
	}
});
