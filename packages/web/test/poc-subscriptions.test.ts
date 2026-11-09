/**
 * Unit tests for POC subscriptions: source validation, save/edit semantics
 * (an empty header value keeps the stored secret), a real sync against a local
 * zip server (success, auth header, failure with history + failure hook), and
 * the interval due-date logic the ticker uses.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createPocSubscriptionDownload } from "../src/poc-subscription-network.ts";
import {
	clampIntervalHours,
	isDue,
	OFFICIAL_SOURCE_ID,
	OFFICIAL_SOURCE_NAME,
	OFFICIAL_SOURCE_URL,
	PocSubscriptions,
	type SubscriptionHooks,
	sourceUrlError,
} from "../src/poc-subscriptions.ts";
import { PocStore } from "../src/pocs.ts";
import type { SentinelPocSource } from "../src/protocol.ts";

vi.mock("../src/poc-subscription-network.ts", { spy: true });

const TEMPLATE = (id: string): string => `id: ${id}\ninfo:\n  name: Template ${id}\n  severity: high\n  tags: cve\n`;

/** Minimal stored-entry zip builder (same format as pocs.test.ts). */
function buildZip(files: { name: string; data: Buffer }[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const nameBuf = Buffer.from(file.name, "utf8");
		const local = Buffer.alloc(30 + nameBuf.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(0, 8); // stored
		local.writeUInt32LE(file.data.length, 18);
		local.writeUInt32LE(file.data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		nameBuf.copy(local, 30);
		locals.push(Buffer.concat([local, file.data]));
		const central = Buffer.alloc(46 + nameBuf.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0, 10);
		central.writeUInt32LE(file.data.length, 20);
		central.writeUInt32LE(file.data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt32LE(offset, 42);
		nameBuf.copy(central, 46);
		centrals.push(central);
		offset += local.length + file.data.length;
	}
	const directory = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(directory.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, eocd]);
}

let dir: string;
let store: PocStore;
let subscriptions: PocSubscriptions;
let server: Server;
let port = 0;
/** Served per request path. */
let routes: Record<string, { status: number; body: Buffer; requireAuth?: string }> = {};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-poc-subs-"));
	store = new PocStore(join(dir, "pocs.db"));
	const hooks: SubscriptionHooks = {
		onChange: () => {},
		onPocChange: () => {
			pocChanges += 1;
		},
		onSyncFailure: (source, record) => failures.push({ source, record }),
	};
	subscriptions = new PocSubscriptions(dir, store, hooks);
	server = createServer((request, response) => {
		const route = routes[request.url ?? ""] ?? { status: 404, body: Buffer.alloc(0) };
		if (route.requireAuth && request.headers.authorization !== route.requireAuth) {
			response.writeHead(401).end();
			return;
		}
		response.writeHead(route.status, { "content-type": "application/zip" });
		response.end(route.body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as { port: number }).port;
});

afterAll(() => {
	subscriptions.stop();
	store.close();
	rmSync(dir, { recursive: true, force: true });
	server.close();
});

const failures: { source: SentinelPocSource; record: { error?: string } }[] = [];
/** How many syncs told the consoles to re-read the template library. */
let pocChanges = 0;

test("URL validation and interval clamping", () => {
	expect(sourceUrlError("http://内网/pack.zip")).toBeUndefined();
	expect(sourceUrlError("https://example.com/pack.zip")).toBeUndefined();
	expect(sourceUrlError("ftp://example.com/pack.zip")).toBe("只支持 http / https URL");
	expect(sourceUrlError("https://user:pass@example.com/x.zip")).toBe("URL 里不能带用户名密码，请用认证头");
	expect(sourceUrlError("not a url")).toBe("URL 无法解析");
	expect(clampIntervalHours(0)).toBe(0);
	expect(clampIntervalHours(-3)).toBe(0);
	expect(clampIntervalHours(1.4)).toBe(1);
	expect(clampIntervalHours(10_000)).toBe(24 * 30);
});

test("save validates, hides the header value, and an empty value keeps the stored one", () => {
	expect("error" in subscriptions.save({ name: "", url: "http://x/a.zip", intervalHours: 0, enabled: true })).toBe(
		true,
	);
	const created = subscriptions.save({
		name: "内网包",
		url: `http://127.0.0.1:${port}/a.zip`,
		headerName: "Authorization",
		headerValue: "Bearer secret",
		intervalHours: 0,
		enabled: true,
	});
	expect("error" in created).toBe(false);
	const view = "source" in created ? created.source : undefined;
	expect(view?.headerSet).toBe(true);
	// The view never carries the value.
	expect(JSON.stringify(view)).not.toContain("secret");
	// An edit with an empty value keeps it.
	const edited = subscriptions.save({
		id: view?.id,
		name: "内网包改",
		url: `http://127.0.0.1:${port}/a.zip`,
		headerName: "Authorization",
		headerValue: "",
		intervalHours: 24,
		enabled: true,
	});
	expect("error" in edited).toBe(false);
	expect(("source" in edited ? edited.source : undefined)?.headerSet).toBe(true);
});

test("a sync downloads, imports, and records history", async () => {
	routes = {
		"/a.zip": {
			status: 200,
			body: buildZip([
				{ name: "t-sub.yaml", data: Buffer.from(TEMPLATE("t-sub"), "utf8") },
				{ name: "skip.txt", data: Buffer.from("nope", "utf8") },
			]),
			requireAuth: "Bearer secret",
		},
	};
	const source = subscriptions.list().find((item) => item.name === "内网包改");
	expect(source).toBeDefined();
	const result = await subscriptions.sync(source?.id ?? "", "manual");
	expect("error" in result).toBe(false);
	const after = subscriptions.list().find((item) => item.id === source?.id);
	expect(after?.lastSyncAt).toBeTruthy();
	expect(after?.lastResult).toMatchObject({ ok: true, imported: 1, replaced: 0, skipped: 0, trigger: "manual" });
	expect(store.get("t-sub")).toBeDefined();
	// The library, not just the source list, has to be re-read by the console.
	expect(pocChanges).toBe(1);
});

test("a failed sync records the error, fires the failure hook, and keeps the library", async () => {
	routes = { "/a.zip": { status: 500, body: Buffer.alloc(0), requireAuth: "Bearer secret" } };
	const source = subscriptions.list().find((item) => item.name === "内网包改");
	const result = await subscriptions.sync(source?.id ?? "", "auto");
	expect("error" in result).toBe(false); // the sync itself completed; the outcome is the record
	const after = subscriptions.list().find((item) => item.id === source?.id);
	expect(after?.lastResult?.ok).toBe(false);
	expect(after?.lastResult?.error).toContain("500");
	expect(after?.lastResult?.trigger).toBe("auto");
	expect(failures).toHaveLength(1);
	expect(store.get("t-sub")).toBeDefined();
	// A failed sync changed nothing, so it must not claim the library changed.
	expect(pocChanges).toBe(1);
});

test("interval due logic", () => {
	const fresh: SentinelPocSource = {
		id: "x",
		name: "x",
		url: "http://x/a.zip",
		headerSet: false,
		intervalHours: 24,
		enabled: true,
		lastSyncAt: new Date().toISOString(),
		history: [],
		lastResult: null,
	};
	expect(isDue(fresh)).toBe(false);
	expect(isDue({ ...fresh, lastSyncAt: new Date(Date.now() - 25 * 3_600_000).toISOString() })).toBe(true);
	expect(isDue({ ...fresh, enabled: false })).toBe(false);
	expect(isDue({ ...fresh, intervalHours: 0 })).toBe(false);
	expect(isDue({ ...fresh, lastSyncAt: null })).toBe(true);
});

test("the one-click official source is created once, then syncs whatever URL it has", async () => {
	const created = subscriptions.ensureOfficial();
	expect(created.source).toMatchObject({
		id: OFFICIAL_SOURCE_ID,
		name: OFFICIAL_SOURCE_NAME,
		url: OFFICIAL_SOURCE_URL,
		intervalHours: 0,
		enabled: true,
	});
	// Pressing the button again reuses the source instead of stacking duplicates.
	expect(subscriptions.ensureOfficial().source.id).toBe(OFFICIAL_SOURCE_ID);
	expect(subscriptions.list().filter((item) => item.id === OFFICIAL_SOURCE_ID)).toHaveLength(1);

	// The URL stays editable: an operator who cannot reach GitHub points the
	// button at a mirror, and the sync follows the stored URL.
	routes = {
		"/official.zip": {
			status: 200,
			body: buildZip([{ name: "t-official.yaml", data: Buffer.from(TEMPLATE("t-official"), "utf8") }]),
		},
	};
	const saved = subscriptions.save({
		id: OFFICIAL_SOURCE_ID,
		name: OFFICIAL_SOURCE_NAME,
		url: `http://127.0.0.1:${port}/official.zip`,
		intervalHours: 0,
		enabled: true,
	});
	expect("error" in saved).toBe(false);
	const result = await subscriptions.sync(OFFICIAL_SOURCE_ID, "manual");
	expect("error" in result).toBe(false);
	expect(subscriptions.list().find((item) => item.id === OFFICIAL_SOURCE_ID)?.lastResult).toMatchObject({
		ok: true,
		imported: 1,
		replaced: 0,
	});
	expect(store.get("t-official")).toBeDefined();
});

test.each(["manual", "auto", "official"] as const)(
	"%s syncing imports through the project-aware downloader",
	async (trigger) => {
		const id = `network-${trigger}`;
		const source =
			trigger === "official"
				? subscriptions.ensureOfficial()
				: subscriptions.save({ name: id, url: `https://example.com/${id}.zip`, intervalHours: 0, enabled: true });
		if (!("source" in source)) throw new Error(source.error);
		const download = vi.fn(async () => buildZip([{ name: `${id}.yaml`, data: Buffer.from(TEMPLATE(id)) }]));
		if (trigger === "auto") download.mockRejectedValueOnce(new Error("temporary proxy failure"));
		const networkSelections = vi.mocked(createPocSubscriptionDownload).mock.calls.length;
		vi.mocked(createPocSubscriptionDownload).mockReturnValueOnce(download);

		await subscriptions.sync(source.source.id, trigger === "auto" ? "auto" : "manual");

		expect(createPocSubscriptionDownload).toHaveBeenLastCalledWith(dir);
		expect(createPocSubscriptionDownload).toHaveBeenCalledTimes(networkSelections + 1);
		expect(download).toHaveBeenCalledTimes(trigger === "auto" ? 2 : 1);
		expect(download).toHaveBeenCalledWith(source.source.url, expect.any(String), expect.any(String));
		expect(store.get(id)).toBeDefined();
		expect(subscriptions.list().find((entry) => entry.id === source.source.id)?.lastResult).toMatchObject({
			ok: true,
			imported: 1,
			trigger: trigger === "auto" ? "auto" : "manual",
		});
	},
);
