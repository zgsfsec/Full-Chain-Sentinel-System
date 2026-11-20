import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import WebSocket from "ws";
import { CodeMonitorManager } from "../src/code-monitor.ts";
import { CodeMonitorStore, codeMonitorDbPath } from "../src/code-monitor-store.ts";
import type { SentinelServerMessage } from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";
import { installFakeDocker } from "./fake-docker.ts";

test("a scheduler batch builds one latest monitor list without disconnecting idle consoles", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-monitor-broadcast-"));
	const workDir = join(root, "workspace");
	mkdirSync(workDir);
	writeFileSync(
		join(root, "projects.json"),
		JSON.stringify({
			projects: [{ id: "p1", name: "Project", container: "sentinel-p1", workDir, createdAt: "2026-01-01" }],
			lastActiveProjectId: "p1",
		}),
	);
	const store = new CodeMonitorStore(codeMonitorDbPath(root));
	for (let index = 0; index < 512; index++) {
		store.createMonitor({
			projectId: "p1",
			projectName: "Project",
			name: `Repository ${index}`,
			host: "github.com",
			owner: "test",
			repo: `repo-${index}`,
			repoUrl: `https://github.com/test/repo-${index}`,
			apiBaseUrl: "https://api.github.com",
			branches: ["main"],
			baselines: { main: "a".repeat(40) },
			autoDispatch: false,
			intervalMinutes: 60,
			scheduleKind: "interval",
			cronExpression: null,
			enabled: true,
		});
	}
	store.close();
	let manager: CodeMonitorManager | undefined;
	const start = vi.spyOn(CodeMonitorManager.prototype, "start").mockImplementation(function (
		this: CodeMonitorManager,
	) {
		manager = this;
	});
	// Exercise the real scheduler and queue without contacting GitHub or a model.
	const check = vi.spyOn(CodeMonitorManager.prototype, "check").mockResolvedValue({
		commits: 0,
		findings: 0,
		checkId: "test-check",
		error: null,
	});
	const list = vi.spyOn(CodeMonitorManager.prototype, "list");
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const docker = installFakeDocker(root, workDir);
	const clients: WebSocket[] = [];
	const replies: SentinelServerMessage[][] = [];
	let server: Awaited<ReturnType<typeof startSentinelServer>> | undefined;
	try {
		server = await startSentinelServer({ agentDir: root, cwd: workDir, auth: false, port: 0 });
		await server.environment;
		if (!manager) throw new Error("Monitor manager did not start");
		manager.setProjectEnabled("p1", false);
		await new Promise((resolve) => setTimeout(resolve, 150));
		const unobservedBuilds = list.mock.calls.length;
		for (let index = 0; index < 3; index++) {
			const messages: SentinelServerMessage[] = [];
			replies.push(messages);
			const client = new WebSocket(`${server.url.replace("http:", "ws:")}/ws`);
			client.on("message", (data) => messages.push(JSON.parse(String(data)) as SentinelServerMessage));
			clients.push(client);
			await once(client, "open");
		}
		clients[0].send(JSON.stringify({ type: "list_code_monitors" }));
		await vi.waitFor(() => expect(replies[0].some((message) => message.type === "code_monitors")).toBe(true));
		list.mockClear();
		for (const messages of replies) messages.length = 0;

		// A due batch changes hundreds of jobs synchronously, before sockets can drain.
		manager.setProjectEnabled("p1", true);
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("send backlog"));
		expect(list).not.toHaveBeenCalled();
		await vi.waitFor(() => {
			expect(check).toHaveBeenCalledTimes(512);
			for (const messages of replies) {
				const updates = messages.filter((message) => message.type === "code_monitors");
				expect(updates).toHaveLength(1);
				expect(updates[0].monitors).toHaveLength(512);
				expect(updates[0].monitors.every((monitor) => monitor.checkState === "idle")).toBe(true);
			}
		});
		expect(list).toHaveBeenCalledTimes(1);
		expect(unobservedBuilds).toBe(0);
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("send backlog"));
		for (const client of clients) expect(client.readyState).toBe(WebSocket.OPEN);
		clients[0].send(JSON.stringify({ type: "get_state" }));
		await vi.waitFor(() => expect(replies[0].some((message) => message.type === "snapshot")).toBe(true));

		list.mockClear();
		manager.setProjectEnabled("p1", false);
		server.close();
		server = undefined;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(list).not.toHaveBeenCalled();
	} finally {
		for (const client of clients) client.terminate();
		server?.close();
		docker.restore();
		start.mockRestore();
		check.mockRestore();
		list.mockRestore();
		warn.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
}, 20_000);
