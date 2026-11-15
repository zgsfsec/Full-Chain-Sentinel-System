import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import WebSocket from "ws";
import { writeConsentRecord } from "../src/consent.ts";
import { listProjects } from "../src/projects.ts";
import type { SentinelServerMessage } from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";
import { installFakeDocker } from "./fake-docker.ts";

test("rename broadcasts the saved name without replacing the active conversation", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-project-rename-server-"));
	const workDir = join(root, "projects", "old-name");
	mkdirSync(workDir, { recursive: true });
	writeFileSync(
		join(root, "projects.json"),
		JSON.stringify({
			projects: [{ id: "p1", name: "old-name", container: "sentinel-p1", workDir, createdAt: "2026-01-01" }],
			lastActiveProjectId: "p1",
		}),
	);
	const docker = installFakeDocker(root, workDir);
	const server = await startSentinelServer({
		cwd: root,
		agentDir: root,
		host: "127.0.0.1",
		port: 0,
		auth: false,
		gate: false,
	});
	const ws = new WebSocket(`${server.url.replace("http://", "ws://")}/ws`);
	const messages: SentinelServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as SentinelServerMessage));
	try {
		await vi.waitFor(() =>
			expect(messages.some((message) => message.type === "snapshot" && message.snapshot.project?.id === "p1")).toBe(
				true,
			),
		);
		const before = messages.find((message) => message.type === "snapshot" && message.snapshot.project?.id === "p1");
		if (before?.type !== "snapshot") throw new Error("Missing initial snapshot");
		expect(before.snapshot.activeSessionId).not.toBeNull();
		messages.length = 0;
		const response = await fetch(`${server.url}/api/projects/rename`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "p1", name: "  新名称  " }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ id: "p1", name: "新名称" });
		await vi.waitFor(() => {
			expect(
				messages.some(
					(message) =>
						message.type === "projects" &&
						message.projects.some((project) => project.id === "p1" && project.name === "新名称"),
				),
			).toBe(true);
			expect(
				messages.some((message) => message.type === "snapshot" && message.snapshot.project?.name === "新名称"),
			).toBe(true);
		});
		const after = messages.find(
			(message) => message.type === "snapshot" && message.snapshot.project?.name === "新名称",
		);
		if (after?.type !== "snapshot") throw new Error("Missing renamed snapshot");
		expect(after.snapshot.activeSessionId).toBe(before.snapshot.activeSessionId);
		expect(after.snapshot.project).toEqual({ ...before.snapshot.project, name: "新名称" });
		expect(listProjects(root).projects[0]?.name).toBe("新名称");
		const malformed = await fetch(`${server.url}/api/projects/rename`, { method: "POST", body: "{" });
		expect(malformed.status).toBe(400);
		expect((await fetch(`${server.url}/api/projects/rename`)).status).toBe(405);
	} finally {
		ws.close();
		server.close();
		docker.restore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("project renaming requires authentication and consent", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-project-rename-auth-"));
	const server = await startSentinelServer({ cwd: root, agentDir: root, host: "127.0.0.1", port: 0, gate: false });
	try {
		const url = `${server.url}/api/projects/rename`;
		const request = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "missing", name: "新名称" }),
		};
		expect((await fetch(url, request)).status).toBe(401);
		const setup = await fetch(`${server.url}/api/auth/setup`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "operator", password: "project rename test password" }),
		});
		const cookie = setup.headers.get("set-cookie")?.split(";")[0];
		if (!cookie) throw new Error("No session cookie");
		const authorized = { ...request, headers: { ...request.headers, cookie } };
		expect((await fetch(url, authorized)).status).toBe(403);
		writeConsentRecord(root, "operator");
		const missing = await fetch(url, authorized);
		expect(missing.status).toBe(400);
		expect(await missing.json()).toEqual({ error: "项目不存在" });
	} finally {
		server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
