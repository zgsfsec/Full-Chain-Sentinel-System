/**
 * The agent-facing asset tools: kind inference, merge output, notes, list/get,
 * and the permission filter that decides which of the four exist at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { AssetLibraryStore } from "../src/asset-library.ts";
import { createAssetLibraryTools } from "../src/asset-library-tool.ts";
import { defaultPermissions, type SentinelPermissionSet } from "../src/permissions.ts";
import type { SentinelVulnSummary } from "../src/protocol.ts";

let root = "";
let store: AssetLibraryStore | undefined;

function closeStore(): void {
	store?.close();
	store = undefined;
}

afterEach(() => {
	closeStore();
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

interface SetupOptions {
	project?: { id: string; name: string } | undefined;
	permissions?: Partial<SentinelPermissionSet>;
	listVulnsByAsset?: (assetId: string) => SentinelVulnSummary[];
	onChange?: () => void;
}

function setup(options: SetupOptions = {}): ToolDefinition[] {
	root = mkdtempSync(join(tmpdir(), "sentinel-asset-tool-"));
	store = new AssetLibraryStore(join(root, "asset-library.db"));
	return createAssetLibraryTools({
		store,
		getProject: () => ("project" in options ? options.project : { id: "p1", name: "E2E" }),
		permissions: { ...defaultPermissions().main, ...options.permissions },
		getSessionId: () => "s1",
		getSessionName: () => "侦察",
		getSource: () => "主代理",
		...(options.listVulnsByAsset ? { listVulnsByAsset: options.listVulnsByAsset } : {}),
		...(options.onChange ? { onChange: options.onChange } : {}),
	});
}

interface CallResult {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
	details?: { ok?: boolean; label?: string; created?: boolean; total?: number; count?: number };
}

type CallableTool = {
	name: string;
	execute: (toolCallId: string, params: never) => Promise<CallResult>;
};

function tool(tools: ToolDefinition[], name: string): CallableTool {
	const found = tools.find((item) => item.name === name);
	if (!found) throw new Error(`missing tool ${name}`);
	return found as unknown as CallableTool;
}

function textOf(result: CallResult): string {
	return result.content.map((item) => item.text).join("\n");
}

test("asset_report infers the kind, creates a label and calls the change hook", async () => {
	let changes = 0;
	const tools = setup({
		onChange: () => {
			changes += 1;
		},
	});
	const report = tool(tools, "asset_report");
	const result = await report.execute("c1", { ip: "10.0.0.5", port: 443, protocol: "HTTPS", title: "后台" } as never);
	expect(result.isError).not.toBe(true);
	expect(result.details?.label).toBe("E2E-A0001");
	expect(result.details?.created).toBe(true);
	expect(textOf(result)).toContain("新建");
	expect(textOf(result)).toContain("项目内共 1 条资产");
	expect(changes).toBe(1);
	const asset = store?.find("p1", "E2E-A0001");
	expect(asset?.kind).toBe("service");
	expect(asset?.protocol).toBe("https");
	expect(asset?.title).toBe("后台");
});

test("a second report merges into the same label", async () => {
	const tools = setup();
	const report = tool(tools, "asset_report");
	const first = await report.execute("c1", { ip: "10.0.0.5", port: 443 } as never);
	const second = await report.execute("c2", { ip: "10.0.0.5", port: 443, title: "新标题" } as never);
	expect(second.details?.created).toBe(false);
	expect(second.details?.label).toBe(first.details?.label);
	expect(textOf(second)).toContain("已存在");
	expect(store?.countByProject("p1")).toBe(1);
});

test("asset_report rejects a URL combined with a port and says how to fix it", async () => {
	const tools = setup();
	const report = tool(tools, "asset_report");
	const result = await report.execute("c1", { url: "https://x.example", port: 443 } as never);
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("URL 已自带主机与端口");
});

test("asset_note appends a record and advances a pending asset", async () => {
	const tools = setup();
	const report = tool(tools, "asset_report");
	const note = tool(tools, "asset_note");
	await report.execute("c1", { ip: "10.0.0.6" } as never);
	const result = await note.execute("c2", {
		asset: "E2E-A0001",
		result: "clean",
		method: "nmap -sV",
		text: "仅 80",
	} as never);
	expect(result.isError).not.toBe(true);
	expect(textOf(result)).toContain("无发现");
	expect(textOf(result)).toContain("状态：已测试");
	const asset = store?.find("p1", "E2E-A0001");
	expect(asset?.status).toBe("tested");
	expect(asset?.testCount).toBe(1);
	expect(asset?.entries.at(-1)?.method).toBe("nmap -sV");
});

test("asset_note rejects an unknown label and an empty record", async () => {
	const tools = setup();
	const report = tool(tools, "asset_report");
	const note = tool(tools, "asset_note");
	await report.execute("c1", { ip: "10.0.0.7" } as never);
	const missing = await note.execute("c2", { asset: "E2E-9999", result: "note", text: "x" } as never);
	expect(missing.isError).toBe(true);
	expect(textOf(missing)).toContain("没有编号为 E2E-9999");
	const empty = await note.execute("c3", { asset: "E2E-A0001", result: "note", text: "   " } as never);
	expect(empty.isError).toBe(true);
	expect(textOf(empty)).toContain("至少提供 method 或 text");
});

test("asset_list filters and reports the total beyond the requested limit", async () => {
	const tools = setup();
	const report = tool(tools, "asset_report");
	await report.execute("c1", { domain: "a.example.com" } as never);
	await report.execute("c2", { ip: "10.0.0.8" } as never);
	await report.execute("c3", { ip: "10.0.0.8", port: 22, protocol: "ssh" } as never);
	const list = tool(tools, "asset_list");
	const all = await list.execute("c4", { limit: 2 } as never);
	expect(all.details?.total).toBe(3);
	expect(all.details?.count).toBe(2);
	expect(textOf(all)).toContain("用 kind / status / tested / search 收窄");
	const services = await list.execute("c5", { kind: "service" } as never);
	expect(services.details?.total).toBe(1);
	expect(textOf(services)).toContain("10.0.0.8:22");
});

test("asset_get includes the timeline and linked findings", async () => {
	const vuln = {
		label: "E2E-0003",
		severity: "high",
		status: "pending",
		target: "10.0.0.8",
		title: "未授权访问",
	} as SentinelVulnSummary;
	const tools = setup({ listVulnsByAsset: () => [vuln] });
	const report = tool(tools, "asset_report");
	const note = tool(tools, "asset_note");
	await report.execute("c1", { ip: "10.0.0.8", port: 22 } as never);
	await note.execute("c2", { asset: "E2E-A0001", result: "vulnerable", text: "可登录" } as never);
	const get = tool(tools, "asset_get");
	const result = await get.execute("c3", { asset: "E2E-A0001" } as never);
	expect(result.isError).not.toBe(true);
	expect(textOf(result)).toContain("时间线");
	expect(textOf(result)).toContain("可登录");
	expect(textOf(result)).toContain("E2E-0003");
	expect(textOf(result)).not.toContain("未开启漏洞读取");
});

test("asset_get states when the vuln hub was not readable", async () => {
	const tools = setup();
	const report = tool(tools, "asset_report");
	await report.execute("c1", { ip: "10.0.0.9" } as never);
	const get = tool(tools, "asset_get");
	const result = await get.execute("c2", { asset: "E2E-A0001" } as never);
	expect(textOf(result)).toContain("未开启漏洞读取");
});

test("read/write permissions decide which tools exist", () => {
	const readOnly = setup({ permissions: { asset_library_write: false } });
	expect(readOnly.map((item) => item.name)).toEqual(["asset_list", "asset_get"]);
	closeStore();
	if (root) rmSync(root, { recursive: true, force: true });

	const writeOnly = setup({ permissions: { asset_library_read: false } });
	expect(writeOnly.map((item) => item.name)).toEqual(["asset_report", "asset_note"]);
	closeStore();
	if (root) rmSync(root, { recursive: true, force: true });

	const none = setup({ permissions: { asset_library_read: false, asset_library_write: false } });
	expect(none).toEqual([]);
});

test("without a project the tools refuse", async () => {
	const tools = setup({ project: undefined });
	const list = tool(tools, "asset_list");
	const result = await list.execute("c1", {} as never);
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("尚未选择项目");
	const report = tool(tools, "asset_report");
	await expect(report.execute("c2", { ip: "10.0.0.1" } as never)).rejects.toThrow("尚未选择项目");
});

test("Agents read operator remarks, edit and clear them without creating test records", async () => {
	let changes = 0;
	const tools = setup({
		onChange: () => {
			changes += 1;
		},
	});
	const report = tool(tools, "asset_report");
	await report.execute("c1", { domain: "remarks.example.com" } as never);
	const asset = store?.find("p1", "E2E-A0001");
	if (!asset || !store) throw new Error("missing asset");
	store.updateRemarks("p1", [asset.id], "人工标记：稍后复查");
	const list = tool(tools, "asset_list");
	expect(textOf(await list.execute("c2", { remark: "稍后复查" } as never))).toContain("人工标记：稍后复查");
	expect((await list.execute("c3", { remark: "不存在" } as never)).details?.total).toBe(0);
	const get = tool(tools, "asset_get");
	expect(textOf(await get.execute("c4", { asset: asset.label } as never))).toContain("人工标记：稍后复查");
	const note = tool(tools, "asset_note");
	expect((await note.execute("c5", { asset: asset.label, remark: "Agent 已确认归属" } as never)).isError).not.toBe(
		true,
	);
	expect(store.get(asset.id)).toMatchObject({
		remark: "Agent 已确认归属",
		status: "pending",
		testCount: 0,
		entries: [],
	});
	expect(changes).toBe(2);
	const mixed = await note.execute("c6", {
		asset: asset.label,
		remark: "不应写入",
		result: "clean",
		text: "测试",
	} as never);
	expect(mixed.isError).toBe(true);
	expect(store.get(asset.id)?.remark).toBe("Agent 已确认归属");
	const foreign = store.upsert({
		projectId: "other",
		projectName: "other",
		source: "主代理",
		identity: { ip: "10.0.0.50" },
	}).asset;
	expect((await note.execute("c7", { asset: foreign.id, remark: "越界" } as never)).isError).toBe(true);
	await note.execute("c8", { asset: asset.label, remark: "" } as never);
	expect(store.get(asset.id)?.remark).toBe("");
	expect(store.get(asset.id)?.testCount).toBe(0);
});
