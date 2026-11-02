/**
 * The inventory over the console's own protocol.
 *
 * No Docker and no provider are needed: the project is created against the fake
 * docker, and assets are written straight into the store the console opened.
 * What is pinned: paging, the detail payload with linked findings, operator
 * updates, the delete preview/confirm split, the unlink-on-delete rule, full
 * export and the `assets_changed` broadcast.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import { AssetLibraryStore } from "../src/asset-library.ts";
import type {
	SentinelAssetDetail,
	SentinelAssetStats,
	SentinelAssetSummary,
	SentinelClientMessage,
	SentinelServerMessage,
} from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";
import { VulnerabilityStore } from "../src/vulnerabilities.ts";
import { type FakeDocker, installFakeDocker } from "./fake-docker.ts";

let tempRoot = "";
let agentDir = "";
let fakeDocker: FakeDocker | undefined;
let closeServer: (() => void) | undefined;
let serverUrl = "";
let ws: WebSocket | undefined;
let library: AssetLibraryStore | undefined;
let hub: VulnerabilityStore | undefined;

const incoming: SentinelServerMessage[] = [];
const waiters: Array<{
	predicate: (message: SentinelServerMessage) => boolean;
	resolve: (message: SentinelServerMessage) => void;
}> = [];

function dispatch(message: SentinelServerMessage): void {
	const index = waiters.findIndex((waiter) => waiter.predicate(message));
	if (index >= 0) {
		const [waiter] = waiters.splice(index, 1);
		waiter.resolve(message);
		return;
	}
	incoming.push(message);
}

function waitFor(
	predicate: (message: SentinelServerMessage) => boolean,
	timeoutMs = 20000,
): Promise<SentinelServerMessage> {
	const buffered = incoming.findIndex(predicate);
	if (buffered >= 0) {
		const [message] = incoming.splice(buffered, 1);
		return Promise.resolve(message);
	}
	return new Promise((resolve, reject) => {
		const waiter = { predicate, resolve: () => {} } as (typeof waiters)[number];
		const timer = setTimeout(() => {
			const position = waiters.indexOf(waiter);
			if (position >= 0) waiters.splice(position, 1);
			reject(new Error(`Timed out. Buffered: ${incoming.map((message) => message.type).join(", ")}`));
		}, timeoutMs);
		waiter.resolve = (message) => {
			clearTimeout(timer);
			resolve(message);
		};
		waiters.push(waiter);
	});
}

function send(message: SentinelClientMessage): void {
	ws?.send(JSON.stringify(message));
}

function listAssets(): Promise<{
	items: SentinelAssetSummary[];
	stats: SentinelAssetStats;
	total: number;
	page: number;
	pageSize: number;
	hasMore: boolean;
}> {
	return waitFor((message) => message.type === "assets").then(
		(message) =>
			message as unknown as {
				items: SentinelAssetSummary[];
				stats: SentinelAssetStats;
				total: number;
				page: number;
				pageSize: number;
				hasMore: boolean;
			},
	);
}

beforeAll(async () => {
	tempRoot = mkdtempSync(join(tmpdir(), "sentinel-asset-server-"));
	agentDir = join(tempRoot, "agent");
	mkdirSync(agentDir, { recursive: true });
	fakeDocker = installFakeDocker(tempRoot, join(tempRoot, "projects"));
	const started = await startSentinelServer({
		cwd: join(tempRoot, "workspace"),
		agentDir,
		host: "127.0.0.1",
		port: 0,
		auth: false,
	});
	closeServer = started.close;
	serverUrl = started.url;
	ws = new WebSocket(started.url.replace("http://", "ws://").concat("/ws"));
	ws.on("message", (data) => dispatch(JSON.parse(String(data)) as SentinelServerMessage));
	await new Promise<void>((resolve, reject) => {
		ws?.once("open", () => resolve());
		ws?.once("error", (error) => reject(error));
	});
	library = new AssetLibraryStore(join(agentDir, "asset-library.db"));
	hub = new VulnerabilityStore(join(agentDir, "vulnerabilities.db"));
});

afterAll(() => {
	ws?.close();
	closeServer?.();
	fakeDocker?.restore();
	library?.close();
	hub?.close();
	rmSync(tempRoot, { recursive: true, force: true });
});

test("pages the inventory, opens a detail, updates, deletes and exports", async () => {
	send({ type: "add_project", name: "资产库测试" });
	const project = await waitFor(
		(message) => message.type === "projects" && message.projects.some((entry) => entry.name === "资产库测试"),
	).then((message) =>
		(message as { projects: { id: string; name: string }[] }).projects.find((entry) => entry.name === "资产库测试"),
	);
	expect(project).toBeDefined();
	send({ type: "switch_project", id: project?.id ?? "" });
	await waitFor((message) => message.type === "projects" && message.activeProjectId === (project?.id ?? ""));

	const projectId = project?.id ?? "";
	const domain = library?.upsert({
		projectId,
		projectName: "资产库测试",
		source: "主代理",
		identity: { domain: "a.example.com" },
	}).asset;
	const service = library?.upsert({
		projectId,
		projectName: "资产库测试",
		source: "主代理",
		identity: { ip: "10.0.0.5", port: 443, protocol: "https" },
		title: "后台",
	}).asset;
	const url = library?.upsert({
		projectId,
		projectName: "资产库测试",
		source: "子代理 run-1",
		identity: { url: "https://a.example.com/login" },
	}).asset;
	expect(domain?.label).toBe("资产库测试-A0001");
	expect(service?.label).toBe("资产库测试-A0002");
	expect(url?.label).toBe("资产库测试-A0003");
	library?.appendEntry(service?.id ?? "", {
		author: "agent",
		source: "主代理",
		outcome: "clean",
		method: "nmap -sV",
		text: "仅 443",
	});
	const vuln = hub?.create({
		projectId,
		projectName: "资产库测试",
		source: "主代理",
		title: "后台登录处 SQL 注入",
		severity: "high",
		cvss: 8.1,
		target: "10.0.0.5:443",
		description: "注入",
		packet: "POST /login",
		assetId: service?.id,
		assetLabel: service?.label,
	});

	send({ type: "list_assets", filters: {}, page: 1, pageSize: 2 });
	const first = await listAssets();
	expect(first.total).toBe(3);
	expect(first.items).toHaveLength(2);
	expect(first.hasMore).toBe(true);
	expect(first.stats.total).toBe(3);
	expect(first.stats.byKind).toMatchObject({ domain: 1, ip: 0, service: 1, url: 1 });

	send({ type: "list_assets", filters: {}, page: 2, pageSize: 2 });
	const second = await listAssets();
	expect(second.items).toHaveLength(1);
	expect(second.hasMore).toBe(false);

	send({ type: "get_asset", id: service?.id ?? "" });
	const detail = (await waitFor((message) => message.type === "asset")) as { detail: SentinelAssetDetail };
	expect(detail.detail.asset.label).toBe("资产库测试-A0002");
	expect(detail.detail.asset.entries).toHaveLength(1);
	expect(detail.detail.vulns.map((item) => item.label)).toEqual([vuln?.label]);

	send({ type: "update_asset", id: service?.id ?? "", patch: { status: "out_of_scope" } });
	const updated = (await waitFor((message) => message.type === "asset")) as { detail: SentinelAssetDetail };
	expect(updated.detail.asset.status).toBe("out_of_scope");
	expect(updated.detail.asset.testCount).toBe(1);
	expect(updated.detail.asset.entries.at(-1)?.kind).toBe("status");
	await waitFor((message) => message.type === "assets_changed");

	send({ type: "preview_asset_delete", ids: [domain?.id ?? "", service?.id ?? ""] });
	const preview = (await waitFor((message) => message.type === "asset_delete_preview")) as {
		count: number;
		records: number;
		vulns: number;
	};
	expect(preview).toMatchObject({ count: 2, records: 2, vulns: 1 });

	// The preview deletes nothing.
	send({ type: "list_assets", filters: {} });
	expect((await listAssets()).total).toBe(3);

	send({ type: "delete_assets", ids: [domain?.id ?? "", service?.id ?? ""] });
	expect(((await waitFor((message) => message.type === "assets_deleted")) as { count: number }).count).toBe(2);
	send({ type: "list_assets", filters: {} });
	const left = await listAssets();
	expect(left.total).toBe(1);
	expect(left.items[0]?.label).toBe("资产库测试-A0003");
	// The finding survives; only its link goes.
	const after = hub?.find(projectId, vuln?.label ?? "");
	expect(after).toBeDefined();
	expect(after?.assetId).toBeUndefined();
	expect(after?.assetLabel).toBeUndefined();

	send({ type: "export_assets", filters: {} });
	const exported = (await waitFor((message) => message.type === "assets_export")) as {
		filename: string;
		markdown: string;
	};
	expect(exported.filename).toContain("asset-inventory");
	expect(exported.markdown).toContain("资产库测试-A0003");
	expect(exported.markdown).not.toContain("资产库测试-A0001");
});

test("HTTP paste import previews without writes, merges records and rejects stale projects", async () => {
	const context = (await fetch(`${serverUrl}/api/assets/import`).then((response) => response.json())) as {
		id: string;
		name: string;
	};
	const existing = library?.upsert({
		projectId: context.id,
		projectName: context.name,
		source: "主代理",
		identity: { domain: "manual.example.com" },
		tags: ["keep"],
		record: { outcome: "clean", text: "keep record" },
	}).asset;
	const before = library?.countByProject(context.id);
	const text =
		"manual.example.com 192.168.2.10:443,https://new.example.com/login\nhttps://new.example.com/login?q=1\n*.example.com";
	const post = (path: string, projectId = context.id, content = text) =>
		fetch(`${serverUrl}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId, text: content }),
		});
	const preview = await post("/api/assets/import/preview");
	expect(preview.status).toBe(200);
	expect(await preview.json()).toMatchObject({
		created: 2,
		merged: 1,
		duplicates: 1,
		invalid: [{ input: "*.example.com" }],
	});
	expect(library?.countByProject(context.id)).toBe(before);
	expect((await post("/api/assets/import", "other-project")).status).toBe(409);
	expect((await post("/api/assets/import", context.id, "invalid")).status).toBe(400);
	const imported = await post("/api/assets/import");
	expect(imported.status).toBe(200);
	expect(await imported.json()).toEqual({ created: 2, merged: 1, duplicates: 1, invalid: 1 });
	await waitFor((message) => message.type === "assets_changed");
	expect(library?.countByProject(context.id)).toBe((before ?? 0) + 2);
	expect(library?.get(existing?.id ?? "")).toMatchObject({
		status: "tested",
		source: "主代理",
		tags: ["keep"],
		testCount: 1,
		entries: [{ text: "keep record" }],
	});
	expect(await (await post("/api/assets/import")).json()).toEqual({
		created: 0,
		merged: 3,
		duplicates: 1,
		invalid: 1,
	});
	const malformed = await fetch(`${serverUrl}/api/assets/import`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "not-json",
	});
	expect(malformed.status).toBe(400);
	expect((await fetch(`${serverUrl}/api/assets/import`, { method: "POST", body: "example.com" })).status).toBe(415);
	// An oversize request receives a normal error instead of dropping the socket.
	expect((await post("/api/assets/import/preview", context.id, "a".repeat(1024 * 1024))).status).toBe(400);
	expect((await post("/api/assets/import/preview", context.id, "a".repeat(200001))).status).toBe(400);
	expect(library?.countByProject(context.id)).toBe((before ?? 0) + 2);
});
