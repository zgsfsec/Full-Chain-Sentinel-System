import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeConsentRecord } from "../src/consent.ts";
import { startSentinelServer } from "../src/server.ts";

test("approval exports require login and consent before downloading", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-gate-export-server-"));
	const server = await startSentinelServer({ cwd: root, agentDir: root, host: "127.0.0.1", port: 0, gate: false });
	try {
		const url = `${server.url}/api/gate-audit/export`;
		expect((await fetch(url)).status).toBe(401);
		const setup = await fetch(`${server.url}/api/auth/setup`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "operator", password: "approval export test password" }),
		});
		expect(setup.status).toBe(200);
		const cookie = setup.headers.get("set-cookie")?.split(";")[0];
		if (!cookie) throw new Error("No session cookie");
		const blocked = await fetch(url, { headers: { cookie } });
		expect(blocked.status).toBe(403);
		expect(await blocked.json()).toEqual({ error: "consent_required" });
		writeConsentRecord(root, "operator");
		const download = await fetch(url, { headers: { cookie } });
		expect(download.status).toBe(200);
		expect(download.headers.get("content-type")).toBe("text/csv; charset=utf-8");
		expect(await download.text()).toContain("记录 ID");
	} finally {
		server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
