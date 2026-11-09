import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeConsentRecord } from "../src/consent.ts";
import { startSentinelServer } from "../src/server.ts";

test("remote discovery requires login and consent before routing", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-remote-models-server-"));
	const server = await startSentinelServer({ cwd: root, agentDir: root, host: "127.0.0.1", port: 0, gate: false });
	try {
		const url = `${server.url}/api/models/remote`;
		const request = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
		expect((await fetch(url, request)).status).toBe(401);
		const setup = await fetch(`${server.url}/api/auth/setup`, {
			method: "POST",
			headers: request.headers,
			body: JSON.stringify({ username: "operator", password: "remote models test password" }),
		});
		expect(setup.status).toBe(200);
		const cookie = setup.headers.get("set-cookie")?.split(";")[0];
		if (!cookie) throw new Error("No session cookie");
		const blocked = await fetch(url, { ...request, headers: { ...request.headers, cookie } });
		expect(blocked.status).toBe(403);
		expect(await blocked.json()).toEqual({ error: "consent_required" });
		writeConsentRecord(root, "operator");
		const allowed = await fetch(url, { ...request, headers: { ...request.headers, cookie } });
		expect(allowed.status).toBe(400);
		expect(await allowed.json()).toEqual({ error: "请提供 Base URL、协议和 API Key 设置。" });
	} finally {
		server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
