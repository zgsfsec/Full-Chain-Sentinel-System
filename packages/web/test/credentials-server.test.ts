import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { WebSocket } from "ws";
import { writeConsentRecord } from "../src/consent.ts";
import { startSentinelServer } from "../src/server.ts";

async function upgradeStatus(base: string, cookie?: string): Promise<number> {
	const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws/credentials?projectId=p&id=missing`, {
		origin: base,
		headers: cookie ? { cookie } : {},
	});
	return new Promise((resolve, reject) => {
		socket.on("error", reject);
		socket.on("unexpected-response", (_request, response) => {
			response.resume();
			resolve(response.statusCode ?? 0);
			socket.terminate();
		});
	});
}

test("credential REST requires login/consent and dedicated connection sockets are absent", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-credential-server-"));
	const server = await startSentinelServer({ cwd: root, agentDir: root, host: "127.0.0.1", port: 0, gate: false });
	try {
		const routes = ["", "/save", "/import/preview", "/import/apply", "/confirm", "/delete", "/delete-failed"];
		const options = (path: string, cookie?: string) => ({
			method: path ? "POST" : "GET",
			headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
			...(path ? { body: "{}" } : {}),
		});
		for (const path of routes)
			expect((await fetch(`${server.url}/api/credentials${path}?projectId=p`, options(path))).status).toBe(401);
		expect(await upgradeStatus(server.url)).toBe(401);
		const setup = await fetch(`${server.url}/api/auth/setup`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "operator", password: "credential test password" }),
		});
		const cookie = setup.headers.get("set-cookie")?.split(";")[0];
		if (!cookie) throw new Error("Missing session cookie");
		for (const path of routes)
			expect((await fetch(`${server.url}/api/credentials${path}?projectId=p`, options(path, cookie))).status).toBe(
				403,
			);
		expect(await upgradeStatus(server.url, cookie)).toBe(401);
		writeConsentRecord(root, "operator");
		writeFileSync(
			join(root, "projects.json"),
			JSON.stringify({
				projects: [
					{
						id: "p",
						name: "Credential fixture",
						container: "nonexistent-fixture",
						workDir: root,
						createdAt: "",
						manualStop: true,
					},
				],
			}),
		);
		const response = await fetch(`${server.url}/api/credentials?projectId=p`, options("", cookie));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ items: [] });
		expect(await upgradeStatus(server.url, cookie)).toBe(401);
	} finally {
		server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
