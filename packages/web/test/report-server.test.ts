import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeConsentRecord } from "../src/consent.ts";
import { startSentinelServer } from "../src/server.ts";

test("report list, detail, images, downloads and deletion require login and consent", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-report-server-"));
	const server = await startSentinelServer({ cwd: root, agentDir: root, host: "127.0.0.1", port: 0, gate: false });
	try {
		const id = "00000000-0000-0000-0000-000000000000";
		const routes = [
			{ path: "", method: "GET" },
			{ path: `/${id}`, method: "GET" },
			{ path: `/${id}/images/${id}`, method: "GET" },
			{ path: `/${id}/download`, method: "GET" },
			{ path: `/${id}`, method: "DELETE" },
			{ path: `/${id}`, method: "PUT" },
		];
		for (const route of routes) {
			expect(
				(await fetch(`${server.url}/api/reports${route.path}?projectId=p`, { method: route.method })).status,
			).toBe(401);
		}
		const setup = await fetch(`${server.url}/api/auth/setup`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "operator", password: "report test password" }),
		});
		expect(setup.status).toBe(200);
		const cookie = setup.headers.get("set-cookie")?.split(";")[0];
		if (!cookie) throw new Error("No session cookie");
		for (const route of routes) {
			const response = await fetch(`${server.url}/api/reports${route.path}?projectId=p`, {
				method: route.method,
				headers: { cookie, "content-type": "application/json" },
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "consent_required" });
		}
		writeConsentRecord(root, "operator");
		// The same requests now reach the report router's project validation.
		for (const route of routes) {
			expect(
				(
					await fetch(`${server.url}/api/reports${route.path}?projectId=p`, {
						method: route.method,
						headers: { cookie, "content-type": "application/json" },
					})
				).status,
			).toBe(409);
		}
	} finally {
		server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
