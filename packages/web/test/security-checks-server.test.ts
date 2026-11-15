import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeConsentRecord } from "../src/consent.ts";
import { startSentinelServer } from "../src/server.ts";

test("global security-check APIs require console login and consent, including sync and submission", async () => {
	const root = mkdtempSync(join(tmpdir(), "security-checks-server-"));
	const server = await startSentinelServer({ cwd: root, agentDir: root, host: "127.0.0.1", port: 0, gate: false });
	try {
		const routes = ["", "/rules/save", "/rules/delete", "/sources/save", "/sources/delete", "/sync", "/submit"];
		const options = (path: string, cookie?: string) => ({
			method: path ? "POST" : "GET",
			headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
			...(path ? { body: "{}" } : {}),
		});
		for (const route of routes)
			expect((await fetch(`${server.url}/api/security-checks${route}`, options(route))).status).toBe(401);
		const setup = await fetch(`${server.url}/api/auth/setup`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "operator", password: "security check fixture password" }),
		});
		const cookie = setup.headers.get("set-cookie")?.split(";")[0];
		if (!cookie) throw new Error("Missing cookie");
		for (const route of routes)
			expect((await fetch(`${server.url}/api/security-checks${route}`, options(route, cookie))).status).toBe(403);
		writeConsentRecord(root, "operator");
		const catalog = await fetch(`${server.url}/api/security-checks`, options("", cookie));
		expect(catalog.status).toBe(200);
		expect(await catalog.json()).toMatchObject({ rules: [], sources: [{ id: "official" }] });
		const crossOrigin = await fetch(`${server.url}/api/security-checks/rules/save`, {
			...options("/rules/save", cookie),
			headers: { ...options("", cookie).headers, origin: "https://foreign.example" },
		});
		expect(crossOrigin.status).toBe(400);
	} finally {
		server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
