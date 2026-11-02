import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { parseAssetImport, previewAssetImport } from "../src/asset-import.ts";
import { AssetLibraryStore } from "../src/asset-library.ts";

let root: string;
let store: AssetLibraryStore;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "asset-import-"));
	store = new AssetLibraryStore(join(root, "assets.db"));
});
afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

test("recognizes mixed domains, IPv4, IPv6, services and URLs with canonical deduplication", () => {
	const { preview } = parseAssetImport(
		"EXAMPLE.com,example.com. 10.0.0.1\n10.0.0.1:443，api.example.com:8080 ::1 [2001:db8::1]:8443 https://EXAMPLE.com/a?q=1\nhttps://example.com/a?q=2 https://example.com/b#fragment",
	);
	expect(preview.items.map((item) => [item.kind, item.name])).toEqual([
		["domain", "example.com"],
		["ip", "10.0.0.1"],
		["service", "10.0.0.1:443"],
		["service", "api.example.com:8080"],
		["ip", "::1"],
		["service", "[2001:db8::1]:8443"],
		["url", "https://example.com/a?q=1"],
		["url", "https://example.com/b"],
	]);
	expect(preview.duplicates).toBe(2);
	expect(preview.invalid).toEqual([]);
});

test("keeps URL query commas, splits comma-delimited URLs, and reports stripped credentials", () => {
	const { preview } = parseAssetImport(
		"https://example.com/?fields=a,b,https://user:pass@other.example.com/,http://third.example.com",
	);
	expect(preview.items.map((item) => item.name)).toEqual([
		"https://example.com/?fields=a,b",
		"https://other.example.com/",
		"http://third.example.com/",
	]);
	expect(preview.items[1].warnings).toContain("已移除 URL 中的账号密码。");
});

test("rejects entire invalid tokens without extracting misleading assets", () => {
	const values = [
		"*.example.com",
		"10.0.0.0/24",
		"user@example.com",
		"999.1.2.3",
		"example.com:0",
		"10.0.0.1:65536",
		"ftp://example.com",
		"无效内容",
		"example.com/path",
		"-bad.example.com",
	];
	const { preview } = parseAssetImport(values.join("\n"));
	expect(preview.items).toEqual([]);
	expect(preview.invalid.map((item) => item.input)).toEqual(values);
	expect(parseAssetImport("  \n").preview.items).toEqual([]);
	expect(() => parseAssetImport("a".repeat(200001))).toThrow("200000");
	expect(() => parseAssetImport(Array.from({ length: 1001 }, () => "example.com").join("\n"))).toThrow("1000");
});

test("preview is read-only and project-scoped; importing preserves existing records and provenance", () => {
	const existing = store.upsert({
		projectId: "p1",
		projectName: "One",
		source: "主代理",
		identity: { domain: "example.com" },
		tags: ["重要"],
		sessionId: "s1",
		record: { outcome: "clean", text: "已完成测试" },
	}).asset;
	store.update(existing.id, { status: "out_of_scope" });
	const before = store.get(existing.id);
	const text = "example.com new.example.com new.example.com invalid";
	const preview = previewAssetImport(store, "p1", text);
	expect(preview).toMatchObject({ created: 1, merged: 1, duplicates: 1, invalid: [{ input: "invalid" }] });
	expect(store.countByProject("p1")).toBe(1);
	expect(store.get(existing.id)).toEqual(before);
	expect(previewAssetImport(store, "p2", "example.com")).toMatchObject({ created: 1, merged: 0 });
	const parsed = parseAssetImport(text);
	expect(
		store.upsertMany(
			parsed.identities.map((identity) => ({ projectId: "p1", projectName: "One", source: "手动导入", identity })),
		),
	).toEqual({ created: 1, merged: 1 });
	expect(store.get(existing.id)).toMatchObject({
		id: existing.id,
		status: "out_of_scope",
		tags: ["重要"],
		testCount: 1,
		source: "主代理",
		sessionId: "s1",
		entries: before?.entries,
	});
	const fresh = store.list("p1").items.find((item) => item.name === "new.example.com");
	expect(fresh).toMatchObject({ status: "pending", testCount: 0, source: "手动导入" });
	expect(store.get(fresh?.id ?? "")?.entries).toEqual([]);
	expect(store.countByProject("p2")).toBe(0);
});

test("a failed batch rolls back previous inserts and label sequence changes", () => {
	expect(() =>
		store.upsertMany([
			{ projectId: "p1", projectName: "One", source: "手动导入", identity: { domain: "first.example.com" } },
			{ projectId: "p1", projectName: "One", source: "手动导入", identity: { ip: "10.0.0.1", port: 99999 } },
		]),
	).toThrow();
	expect(store.countByProject("p1")).toBe(0);
	expect(
		store.upsert({
			projectId: "p1",
			projectName: "One",
			source: "手动导入",
			identity: { domain: "next.example.com" },
		}).asset.number,
	).toBe(1);
});
