import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { SentinelRuntime } from "../src/sentinel-session.ts";
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
		"/api/mitm/webfuzz?projectId=a",
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

test("WebFuzz reads and saves check the current project without constructing a chat snapshot", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-webfuzz-loading-"));
	const started = await startSentinelServer({ cwd: root, agentDir: root, host: "127.0.0.1", port: 0, auth: false });
	writeFileSync(join(root, "projects.json"), JSON.stringify({ projects: [{ id: "a", name: "A" }] }));
	const project = vi.spyOn(SentinelRuntime.prototype, "currentProject", "get").mockReturnValue({
		id: "a",
		name: "A",
		cwd: root,
		container: null,
	});
	const snapshot = vi.spyOn(SentinelRuntime.prototype, "snapshot").mockImplementation(() => {
		throw new Error("WebFuzz must not load the conversation transcript");
	});
	const origin = new URL(started.url).origin;
	try {
		const state = await fetch(`${origin}/api/mitm/webfuzz?projectId=a`);
		expect(state.status).toBe(200);
		expect(await state.json()).toEqual({ tabs: [], activeId: null, history: [] });
		const save = await fetch(`${origin}/api/mitm/webfuzz/workspace`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId: "a", tabs: [], activeId: null }),
		});
		expect(save.status).toBe(200);
		project.mockReturnValue(null);
		expect((await fetch(`${origin}/api/mitm/webfuzz?projectId=a`)).status).toBe(409);
		expect(snapshot).not.toHaveBeenCalled();
	} finally {
		snapshot.mockRestore();
		project.mockRestore();
		started.close();
		rmSync(root, { recursive: true, force: true });
	}
});
