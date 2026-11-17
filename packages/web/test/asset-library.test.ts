/**
 * The asset inventory store: identity normalization, deduplication, merge rules,
 * the test timeline, pagination and deletion. No caps are asserted as guards;
 * the store is expected to keep growing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AssetInputError, AssetLibraryStore, assetLibraryDbPath, assetPrefix } from "../src/asset-library.ts";
import type { SentinelAsset, SentinelAssetOutcome } from "../src/protocol.ts";
import { openSqliteDatabase } from "../src/sqlite.ts";

let root = "";
let store: AssetLibraryStore | undefined;

function freshStore(): AssetLibraryStore {
	root = mkdtempSync(join(tmpdir(), "sentinel-asset-library-"));
	store = new AssetLibraryStore(assetLibraryDbPath(root));
	return store;
}

function closeStore(): void {
	store?.close();
	store = undefined;
}

afterEach(() => {
	closeStore();
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

const PROJECT = { projectId: "p1", projectName: "E2E", source: "主代理" };

function report(identity: Parameters<AssetLibraryStore["upsert"]>[0]["identity"], extra = {}): SentinelAsset {
	const result = store?.upsert({ ...PROJECT, identity, ...extra });
	if (!result) throw new Error("store missing");
	return result.asset;
}

function note(asset: SentinelAsset, outcome: SentinelAssetOutcome, text = "观察"): SentinelAsset {
	const updated = store?.appendEntry(asset.id, { author: "agent", source: "主代理", outcome, text });
	if (!updated) throw new Error("missing asset");
	return updated;
}

test("creates one labeled row per kind", () => {
	const assets = freshStore();
	const domain = report({ domain: "Admin.Example.com." });
	const ip = report({ ip: "10.0.0.5" });
	const service = report({ ip: "10.0.0.5", port: 443, protocol: "HTTPS" });
	const url = report({ url: "https://admin.example.com/login?x=1#frag" });

	expect(domain.label).toBe("E2E-A0001");
	expect(domain.kind).toBe("domain");
	expect(domain.name).toBe("admin.example.com");
	expect(ip.label).toBe("E2E-A0002");
	expect(ip.kind).toBe("ip");
	expect(service.label).toBe("E2E-A0003");
	expect(service.kind).toBe("service");
	expect(service.name).toBe("10.0.0.5:443");
	expect(service.protocol).toBe("https");
	expect(service.transport).toBe("tcp");
	expect(url.label).toBe("E2E-A0004");
	expect(url.kind).toBe("url");
	expect(url.name).toBe("https://admin.example.com/login?x=1");
	expect(url.domain).toBe("admin.example.com");
	expect(url.port).toBe(443);
	expect(url.protocol).toBe("https");
	expect(assets.countByProject("p1")).toBe(4);
});

test("labels use the project slug and never reuse a deleted number", () => {
	freshStore();
	expect(assetPrefix("E2E PROJECT")).toBe("E2E-PROJECT");
	expect(assetPrefix("靶场-01")).toBe("靶场-01");
	expect(assetPrefix("   ")).toBe("ASSET");
	const first = report({ ip: "10.0.0.1" });
	expect(first.label).toBe("E2E-A0001");
	expect(store?.deleteMany("p1", [first.id])).toBe(1);
	const second = report({ ip: "10.0.0.2" });
	expect(second.label).toBe("E2E-A0002");
});

test("deduplicates domains, IPs, services and URLs across normalizations", () => {
	freshStore();
	const domain = report({ domain: "Example.com" });
	expect(report({ domain: "example.COM." }).label).toBe(domain.label);

	const ip = report({ ip: "0:0:0:0:0:0:0:1" });
	expect(ip.name).toBe("::1");
	expect(report({ ip: "[::1]" }).label).toBe(ip.label);

	const service = report({ domain: "example.com", port: 8443 });
	expect(service.name).toBe("example.com:8443");
	expect(report({ domain: "example.com", port: 8443, transport: "tcp" }).label).toBe(service.label);

	const url = report({ url: "HTTPS://User:Pass@Example.com:443/login?x=1#f" });
	expect(url.name).toBe("https://example.com/login?x=1");
	expect(report({ url: "https://example.com/login?y=2" }).label).toBe(url.label);
	expect(store?.countByProject("p1")).toBe(4);
});

test("URL normalization strips credentials, default ports and fragments", () => {
	freshStore();
	const url = report({ url: "http://[0:0:0:0:0:0:0:1]:8080/a?q=1#frag" });
	expect(url.name).toBe("http://[::1]:8080/a?q=1");
	expect(url.ip).toBe("::1");
	expect(url.port).toBe(8080);
	expect(url.host).toBe("[::1]:8080");
});

test("merges instead of duplicating: identity stays, descriptive fields take the latest", () => {
	freshStore();
	const first = report({ ip: "10.0.0.5", port: 443 }, { title: "旧标题", server: "nginx", tags: ["OA", "后台"] });
	const second = store?.upsert({
		...PROJECT,
		identity: { ip: "10.0.0.5", port: 443, protocol: "https" },
		title: "新标题",
		tech: "Spring Boot",
		tags: ["oa", "数据库"],
	});
	expect(second?.created).toBe(false);
	const asset = second?.asset as SentinelAsset;
	expect(asset.id).toBe(first.id);
	expect(asset.label).toBe(first.label);
	expect(asset.title).toBe("新标题");
	expect(asset.server).toBe("nginx");
	expect(asset.tech).toBe("Spring Boot");
	expect(asset.protocol).toBe("https");
	expect(asset.tags).toEqual(["OA", "后台", "数据库"]);
	expect(asset.source).toBe("主代理");
});

test("notes do not advance the state; a conclusive record does", () => {
	freshStore();
	let asset = report({ ip: "10.0.0.9" });
	asset = note(asset, "note");
	expect(asset.status).toBe("pending");
	expect(asset.testCount).toBe(1);
	expect(asset.lastOutcome).toBeUndefined();

	asset = note(asset, "clean");
	expect(asset.status).toBe("tested");
	expect(asset.testCount).toBe(2);
	expect(asset.lastOutcome).toBe("clean");
	expect(asset.lastTestedAt).toBeTruthy();

	store?.update(asset.id, { status: "pending" });
	asset = store?.get(asset.id) as SentinelAsset;
	asset = note(asset, "suspicious");
	expect(asset.status).toBe("tested");
	expect(asset.lastOutcome).toBe("suspicious");
});

test("operator state changes are status entries and are not counted as tests", () => {
	const assets = freshStore();
	let asset = report({ ip: "10.0.0.10" });
	asset = assets.update(asset.id, { status: "testing" }) as SentinelAsset;
	expect(asset.status).toBe("testing");
	expect(asset.testCount).toBe(0);
	expect(asset.entries.at(-1)?.kind).toBe("status");
	expect(asset.entries.at(-1)?.text).toBe("状态 待测试 → 测试中");

	asset = assets.update(asset.id, { outcome: "clean", note: "人工复核" }) as SentinelAsset;
	expect(asset.status).toBe("testing");
	expect(asset.testCount).toBe(1);
	expect(asset.entries.at(-1)?.kind).toBe("record");
	expect(asset.entries.at(-1)?.author).toBe("operator");
	expect(asset.lastOutcome).toBe("clean");
});

test("an explicit status on an operator record wins over the auto-advance", () => {
	const assets = freshStore();
	let asset = report({ ip: "10.0.0.11" });
	asset = assets.update(asset.id, { status: "pending", outcome: "clean" }) as SentinelAsset;
	expect(asset.status).toBe("pending");
	expect(asset.lastOutcome).toBe("clean");
	expect(asset.testCount).toBe(1);
});

test("operator records do not move last_seen_at; agent records do", async () => {
	const assets = freshStore();
	const asset = report({ ip: "10.0.0.12" });
	const seen = asset.lastSeenAt;
	await new Promise((resolve) => setTimeout(resolve, 5));
	const updated = assets.update(asset.id, { outcome: "clean", note: "复核" }) as SentinelAsset;
	expect(updated.lastSeenAt).toBe(seen);
	expect(updated.updatedAt).not.toBe(updated.lastSeenAt);
	await new Promise((resolve) => setTimeout(resolve, 5));
	const appended = assets.appendEntry(asset.id, { author: "agent", source: "子代理", outcome: "note", text: "继续" });
	expect(appended?.lastSeenAt).not.toBe(seen);
});

test("tags replace on operator update and union on agent merge", () => {
	const assets = freshStore();
	let asset = report({ ip: "10.0.0.13" }, { tags: ["a", "b"] });
	asset = assets.update(asset.id, { tags: ["c"] }) as SentinelAsset;
	expect(asset.tags).toEqual(["c"]);
	asset = assets.upsert({ ...PROJECT, identity: { ip: "10.0.0.13" }, tags: ["C", "d"] })?.asset as SentinelAsset;
	expect(asset.tags).toEqual(["c", "d"]);
});

test("filters, search, stats and pagination", () => {
	const assets = freshStore();
	report({ domain: "a.example.com" });
	report({ ip: "10.0.0.20" });
	const service = report({ ip: "10.0.0.20", port: 22, protocol: "ssh" });
	report({ url: "https://b.example.com/login" });
	assets.update(service.id, { status: "tested", outcome: "clean", note: "人工确认" });

	const all = assets.list("p1", {}, 1, 2);
	expect(all.total).toBe(4);
	expect(all.items).toHaveLength(2);
	expect(all.hasMore).toBe(true);
	const second = assets.list("p1", {}, 2, 2);
	expect(second.items).toHaveLength(2);
	expect(second.hasMore).toBe(false);
	const beyond = assets.list("p1", {}, 9, 2);
	expect(beyond.items).toHaveLength(0);
	expect(beyond.total).toBe(4);

	expect(assets.list("p1", { kind: "service" }).total).toBe(1);
	expect(assets.list("p1", { status: "tested" }).total).toBe(1);
	expect(assets.list("p1", { tested: true }).total).toBe(1);
	expect(assets.list("p1", { tested: false }).total).toBe(3);
	expect(assets.list("p1", { search: "example.com" }).total).toBe(2);
	expect(assets.list("p1", { search: "ssh" }).total).toBe(1);

	const stats = assets.stats("p1");
	expect(stats.total).toBe(4);
	expect(stats.byKind).toEqual({ domain: 1, ip: 1, service: 1, url: 1 });
	expect(stats.byStatus).toEqual({ pending: 3, testing: 0, tested: 1, out_of_scope: 0 });
	expect(stats.tested).toBe(1);
	expect(stats.untested).toBe(3);
});

test("delete previews, scopes deletes to the project and keeps sequence numbers", () => {
	const assets = freshStore();
	const first = report({ ip: "10.0.0.30" });
	note(first, "clean", "一条记录");
	report({ ip: "10.0.0.31" });
	assets.update(first.id, { status: "out_of_scope" });

	const preview = assets.deletePreview("p1", [first.id]);
	expect(preview.count).toBe(1);
	expect(preview.records).toBe(2);
	expect(assets.deleteMany("p1", [first.id])).toBe(1);
	expect(assets.countByProject("p1")).toBe(1);
	// A leaked id from another project deletes nothing.
	expect(assets.deleteMany("other", [first.id])).toBe(0);
	expect(assets.deleteByProject("p1")).toBe(1);
	expect(assets.countByProject("p1")).toBe(0);
});

test("no cap on assets or records; text and tags are not truncated", () => {
	const assets = freshStore();
	for (let index = 0; index < 205; index += 1) {
		report({ ip: `10.1.1.${index}` }, { title: `资产 ${index}` });
	}
	expect(assets.countByProject("p1")).toBe(205);
	expect(assets.list("p1", {}, 1, 200).items).toHaveLength(200);
	expect(assets.list("p1", {}, 2, 200).items).toHaveLength(5);

	const asset = report({ ip: "10.9.9.9" });
	const text = "x".repeat(100_000);
	const updated = assets.appendEntry(asset.id, { author: "agent", source: "主代理", outcome: "clean", text });
	expect(updated?.entries.at(-1)?.text).toHaveLength(100_000);
	const tags = Array.from({ length: 300 }, (_unused, index) => `tag-${index}-${"y".repeat(100)}`);
	const tagged = assets.upsert({ ...PROJECT, identity: { ip: "10.9.9.9" }, tags })?.asset;
	expect(tagged?.tags).toHaveLength(300);
});

test("rejects ambiguous, malformed and out-of-shape identities", () => {
	freshStore();
	const bad = (identity: Parameters<AssetLibraryStore["upsert"]>[0]["identity"]): void => {
		expect(() => store?.upsert({ ...PROJECT, identity })).toThrow(AssetInputError);
	};
	bad({});
	bad({ ip: "1.2.3.4", domain: "example.com" });
	bad({ ip: "10.0.0.0/24" });
	bad({ domain: "*.example.com" });
	bad({ domain: "http://example.com" });
	bad({ domain: "1.2.3.4" });
	bad({ port: 443 });
	bad({ ip: "1.2.3.4", port: 0 });
	bad({ ip: "1.2.3.4", port: 65536 });
	bad({ url: "ftp://example.com" });
	bad({ url: "https://example.com", port: 443 });
	bad({ url: "https://example.com", protocol: "http" });
	bad({ url: "http://example.com:0" });
	bad({ ip: "1.2.3.4", transport: "udp" });
});

test("find and get are scoped to their project", () => {
	const assets = freshStore();
	const asset = report({ ip: "10.0.0.40" });
	expect(assets.find("p1", asset.label)?.id).toBe(asset.id);
	expect(assets.find("p1", asset.label.toLowerCase())?.id).toBe(asset.id);
	expect(assets.find("p1", asset.id)?.id).toBe(asset.id);
	expect(assets.find("other", asset.label)).toBeUndefined();
	expect(assets.find("other", asset.id)).toBeUndefined();
});

test("remarks replace, append, clear and survive reports without changing test evidence", () => {
	const assets = freshStore();
	const first = note(report({ ip: "10.0.0.41" }), "clean");
	const second = report({ ip: "10.0.0.42" });
	expect(assets.updateRemarks("p1", [first.id], " 原备注\r\n第二行 ")).toBe(1);
	expect(assets.updateRemarks("p1", [first.id, second.id, first.id], "追加", "append")).toBe(2);
	expect(assets.get(first.id)).toMatchObject({
		remark: "原备注\n第二行\n追加",
		status: first.status,
		testCount: first.testCount,
		lastOutcome: first.lastOutcome,
		lastSeenAt: first.lastSeenAt,
		lastTestedAt: first.lastTestedAt,
		entries: first.entries,
	});
	expect(assets.get(second.id)).toMatchObject({ remark: "追加", testCount: 0, status: "pending", entries: [] });
	expect(report({ ip: "10.0.0.41" }).remark).toBe("原备注\n第二行\n追加");
	assets.updateRemarks("p1", [first.id, second.id], "统一覆盖", "replace");
	expect(assets.get(first.id)?.remark).toBe("统一覆盖");
	expect(assets.get(second.id)?.remark).toBe("统一覆盖");
	assets.updateRemarks("p1", [first.id], "");
	expect(assets.get(first.id)?.remark).toBe("");
});

test("remark batches roll back on missing, foreign or oversized remarks", () => {
	const assets = freshStore();
	const first = report({ ip: "10.0.0.43" });
	const foreign = report({ ip: "10.0.0.44" }, { projectId: "other" });
	assets.updateRemarks("p1", [first.id], "原备注");
	for (const id of ["missing", foreign.id]) {
		expect(() => assets.updateRemarks("p1", [first.id, id], "不应写入", "append")).toThrow(AssetInputError);
		expect(assets.get(first.id)?.remark).toBe("原备注");
	}
	expect(assets.get(foreign.id)?.remark).toBe("");
	const long = report({ ip: "10.0.0.45" });
	assets.updateRemarks("p1", [long.id], "x".repeat(10000));
	expect(() => assets.updateRemarks("p1", [first.id, long.id], "追加", "append")).toThrow("10000");
	expect(assets.get(first.id)?.remark).toBe("原备注");
	expect(() => assets.updateRemarks("p1", [first.id], "x".repeat(10001))).toThrow("10000");
	expect(() => assets.updateRemarks("p1", [], "x")).toThrow(AssetInputError);
	expect(() => assets.updateRemarks("p1", [first.id], "  ", "append")).toThrow(AssetInputError);
});

test("remark substring filters compose, paginate and escape SQL wildcards", () => {
	const assets = freshStore();
	const first = report({ domain: "remarks.example.com" });
	const second = report({ ip: "10.0.0.46" });
	const third = report({ ip: "10.0.0.47" });
	assets.updateRemarks("p1", [first.id, second.id], "待复查 50%_C:\\data");
	assets.updateRemarks("p1", [third.id], "待复查 50xxC:");
	expect(assets.list("p1", { remark: "50%_C:\\" }).total).toBe(2);
	expect(assets.list("p1", { search: "50%_C:\\" }).total).toBe(2);
	expect(assets.list("p1", { remark: "待复查", kind: "domain", tested: false }).items.map((item) => item.id)).toEqual([
		first.id,
	]);
	expect(assets.list("other", { remark: "待复查" }).total).toBe(0);
	const page = assets.list("p1", { remark: "50%_" }, 2, 1);
	expect(page.total).toBe(2);
	expect(page.items).toHaveLength(1);
	expect(page.items[0].remark).toBe("待复查 50%_C:\\data");
	expect(page.hasMore).toBe(false);
});

test("migrates an existing inventory and persists remarks across reopen", () => {
	freshStore();
	const asset = note(report({ ip: "10.0.0.48" }), "clean");
	closeStore();
	const legacy = openSqliteDatabase(assetLibraryDbPath(root));
	legacy.exec("ALTER TABLE asset_library DROP COLUMN remark");
	legacy.close();
	store = new AssetLibraryStore(assetLibraryDbPath(root));
	expect(store.get(asset.id)).toMatchObject({ remark: "", entries: asset.entries, testCount: 1 });
	store.updateRemarks("p1", [asset.id], "重启后保留");
	closeStore();
	store = new AssetLibraryStore(assetLibraryDbPath(root));
	expect(store.get(asset.id)?.remark).toBe("重启后保留");
});
