import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { handleGateAuditExport } from "../src/gate-audit-export.ts";
import { type GateDecisionInput, GatekeeperStore } from "../src/gatekeeper-store.ts";
import { setServerLanguage } from "../src/i18n.ts";
import type { SentinelGateFilter } from "../src/protocol.ts";

let root: string;
let store: GatekeeperStore;
let server: Server;
let url: string;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "sentinel-gate-export-"));
	store = new GatekeeperStore(join(root, "gatekeeper.db"));
	setServerLanguage("zh");
	server = createServer((request, response) =>
		handleGateAuditExport(request, response, (filter, page, pageSize) => store.list(filter, page, pageSize)),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing server address");
	url = `http://127.0.0.1:${address.port}/api/gate-audit/export`;
});

afterEach(async () => {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	store.close();
	rmSync(root, { recursive: true, force: true });
	setServerLanguage("zh");
});

function record(overrides: Partial<GateDecisionInput> = {}) {
	return store.record({
		at: 2000,
		projectId: "p1",
		projectName: "项目一",
		sessionId: "s1",
		source: "主代理",
		tool: "bash",
		command: "id",
		decision: "block",
		approval: "ai",
		latencyMs: 12,
		reason: "needle%_\\",
		...overrides,
	});
}

function exportUrl(filter: SentinelGateFilter): string {
	return `${url}?${new URLSearchParams({ filter: JSON.stringify(filter) })}`;
}

describe("gate audit CSV export", () => {
	test("exports every matching page in order with all filters applied together", async () => {
		const matches = Array.from({ length: 205 }, (_, index) => record({ command: `cmd-${index}` }));
		const excluded = [
			record({ approval: "auto" }),
			record({ decision: "allow" }),
			record({ projectId: "p2" }),
			record({ sessionId: "s2" }),
			record({ source: "子代理" }),
			record({ at: 1999 }),
			record({ reason: "needleABC" }),
		];
		const response = await fetch(
			exportUrl({
				approval: ["ai"],
				decision: "block",
				projectId: "p1",
				sessionId: "s1",
				source: "主代理",
				since: 2000,
				search: "needle%_\\",
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
		expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="approvals-.+\.csv"$/);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const csv = new TextDecoder().decode(bytes);
		expect(csv.match(/"gate-/g)).toHaveLength(205);
		for (const item of matches) expect(csv).toContain(item.id);
		for (const item of excluded) expect(csv).not.toContain(item.id);
		expect(csv.indexOf(matches[204].id)).toBeLessThan(csv.indexOf(matches[0].id));
		const all = await (await fetch(url)).text();
		expect(all.match(/"gate-/g)).toHaveLength(212);
	});

	test("the auto tab includes automatic and human decisions, including human blocks", async () => {
		const automatic = record({ approval: "auto", decision: "allow" });
		const human = record({ approval: "human" });
		const ai = record();
		const csv = await (await fetch(exportUrl({ approval: ["auto", "human"] }))).text();
		expect(csv).toContain(automatic.id);
		expect(csv).toContain(human.id);
		expect(csv).not.toContain(ai.id);
	});

	test("preserves multiline commands, quotes, Chinese, zero values and detail fields", async () => {
		record({
			command: 'echo "中文,a"\r\nid',
			cwd: "/work",
			reason: '理由,"quoted"',
			model: "judge",
			modelFrom: "library",
			inputTokens: 0,
			outputTokens: 3,
			totalTokens: 3,
			error: "错误",
			latencyMs: 0,
		});
		const csv = await (await fetch(url)).text();
		expect(csv).toContain('"echo ""中文,a""\r\nid"');
		expect(csv).toContain('"理由,""quoted"""');
		expect(csv).toContain('"0","judge","library","0","3","3","错误","false"');
		expect(csv).toContain('"1970-01-01T00:00:02.000Z"');
	});

	test.each(["=1+1", "+1+1", "-1+1", "@SUM(1)", "  =1+1", "\t=1+1", "\r=1+1", "\n=1+1"])(
		"exports formula-like text as inert spreadsheet text: %j",
		async (command) => {
			record({ command });
			const csv = await (await fetch(url)).text();
			expect(csv).toContain(`"'${command}"`);
		},
	);

	test("marks commands already truncated in storage and uses English column labels when selected", async () => {
		record({ command: "a".repeat(9000) });
		setServerLanguage("en");
		const csv = await (await fetch(url)).text();
		expect(csv).toContain('"Record ID","Time (UTC)"');
		expect(csv).toContain("（已截断）");
		expect(csv).toContain(',"true"\r\n');
	});

	test("an empty match exports only the header", async () => {
		record();
		const csv = await (await fetch(exportUrl({ search: "missing" }))).text();
		expect(csv).toContain("记录 ID");
		expect(csv.trim().split("\r\n")).toHaveLength(1);
	});

	test.each([
		"{",
		"null",
		"[]",
		'{"source":1}',
		'{"decision":"bad"}',
		'{"approval":"ai"}',
		'{"approval":["bad"]}',
		'{"since":"yesterday"}',
		'{"since":1e999}',
	])("rejects invalid filters: %s", async (filter) => {
		const response = await fetch(`${url}?${new URLSearchParams({ filter })}`);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "导出筛选条件无效" });
	});

	test("rejects unsupported methods and reports database failures", async () => {
		const post = await fetch(url, { method: "POST" });
		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toBe("GET");
		server.removeAllListeners("request");
		server.on("request", (request, response) =>
			handleGateAuditExport(request, response, () => {
				throw new Error("Database unavailable");
			}),
		);
		const failed = await fetch(url);
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({ error: "导出失败，请重试。" });
	});
});
