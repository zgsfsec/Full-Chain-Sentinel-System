import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IntelligenceQueries, registryJson } from "../src/intelligence-query.ts";
import { DEFAULT_INTELLIGENCE_TEMPLATE, type IntelligenceEngineInput } from "../src/intelligence-types.ts";

let dir: string;
const opened: IntelligenceQueries[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "intel-query-"));
});
afterEach(() => {
	for (const queries of opened.splice(0)) queries.close();
	rmSync(dir, { recursive: true, force: true });
});
function input(ip = "1.1.1.1"): IntelligenceEngineInput {
	return {
		attemptId: "attempt",
		batchId: "batch",
		template: structuredClone(DEFAULT_INTELLIGENCE_TEMPLATE),
		items: [{ ip, throughSeq: 1, alertCount: 0, alerts: [] }],
	};
}
function open(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
	const queries = new IntelligenceQueries(dir, join(dir, "queries.db"), fetchImpl);
	opened.push(queries);
	return queries;
}
const registry = async (url: string) =>
	Response.json(
		url.includes("rdap.org")
			? { objectClassName: "ip network", name: "Network" }
			: { status: "ok", data: { asns: [13335] } },
	);

test("only batch IPs query fixed registries; successful evidence survives restart without spending again", async () => {
	const fetcher = vi.fn(registry);
	const queries = open(fetcher);
	const batch = input();
	expect(() => queries.assertComplete("p", batch)).toThrow("缺少");
	await expect(queries.lookup("p", batch, "8.8.8.8")).rejects.toThrow("快照");
	const [first, second] = await Promise.all([
		queries.lookup("p", batch, "1.1.1.1"),
		queries.lookup("p", batch, "1.1.1.1"),
	]);
	expect(first).toEqual(second);
	expect(fetcher).toHaveBeenCalledTimes(2);
	expect(first.map((record) => record.kind)).toEqual(["rdap", "asn", "coverage"]);
	expect(() => queries.assertComplete("p", batch)).not.toThrow();
	queries.close();
	opened.splice(opened.indexOf(queries), 1);
	const restored = open(fetcher);
	expect(await restored.lookup("p", batch, "1.1.1.1")).toEqual(first);
	expect(fetcher).toHaveBeenCalledTimes(2);
});

test("failed queries spend durable budget and cannot be counted as completed", async () => {
	const fetcher = vi.fn(async () => Response.json({ status: "error" }));
	const queries = open(fetcher);
	const batch = input();
	batch.template.queryLimit = 1;
	await expect(queries.lookup("p", batch, "1.1.1.1")).rejects.toThrow("RDAP");
	expect(() => queries.assertComplete("p", batch)).toThrow();
	queries.close();
	opened.splice(opened.indexOf(queries), 1);
	await expect(open(fetcher).lookup("p", batch, "1.1.1.1")).rejects.toThrow("预算");
	expect(fetcher).toHaveBeenCalledTimes(1);
});

test("RIPEstat error bodies are rejected even with HTTP 200", async () => {
	const queries = open(async (url) =>
		url.includes("rdap.org") ? registry(url) : Response.json({ status: "error", messages: ["failed"] }),
	);
	await expect(queries.lookup("p", input(), "1.1.1.1")).rejects.toThrow("RIPEstat");
	expect(() => queries.assertComplete("p", input())).toThrow("asn");
});

test("private IPs and unconfigured platforms are explicitly skipped without external requests", async () => {
	const fetcher = vi.fn(registry);
	const queries = open(fetcher);
	const batch = input("192.168.1.1");
	const result = await queries.lookup("p", batch, "192.168.1.1");
	expect(fetcher).not.toHaveBeenCalled();
	expect(result[0].data).toMatchObject({ status: "not_applicable" });
	expect(result.at(-1)?.data).toMatchObject({ skipped: ["fofa", "quake", "hunter"] });
	expect(() => queries.assertComplete("p", batch)).not.toThrow();
});

test("asset searches use exact IP, first page, configured relay and bounded results without leaking keys", async () => {
	writeFileSync(
		join(dir, "assets.json"),
		JSON.stringify({
			platforms: { fofa: { enabled: true, key: "fixture-secret", baseUrl: "https://relay.example/fofa" } },
		}),
	);
	const fetcher = vi.fn(async (_url: string) =>
		Response.json({ error: false, size: 1000, results: Array.from({ length: 5 }, () => ["host", "1.1.1.1", "443"]) }),
	);
	const queries = open(fetcher);
	const batch = input();
	batch.template.rdap = false;
	batch.template.resultsPerIp = 2;
	const result = await queries.lookup("p", batch, "1.1.1.1");
	const url = new URL(fetcher.mock.calls[0]?.[0] as string);
	expect(url.origin).toBe("https://relay.example");
	expect(Buffer.from(url.searchParams.get("qbase64") ?? "", "base64").toString()).toBe('ip="1.1.1.1"');
	expect(url.searchParams.get("page")).toBe("1");
	expect(result[0].data).toMatchObject({ total: 1000, records: [expect.any(Object), expect.any(Object)] });
	expect(JSON.stringify(result)).not.toContain("fixture-secret");
});

test("registry redirects reject arbitrary hosts and response size is bounded", async () => {
	for (const target of [
		"https://1.1.1.1/",
		"http://rdap.arin.net/",
		"https://rdap.arin.net.evil.test/",
		"https://u:p@rdap.arin.net/",
	]) {
		const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: target } }));
		await expect(registryJson("https://rdap.org/ip/1.1.1.1", new AbortController().signal, fetcher)).rejects.toThrow(
			"未允许",
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	}
	await expect(
		registryJson(
			"https://rdap.org/ip/1.1.1.1",
			new AbortController().signal,
			async () => new Response("x".repeat(262145)),
		),
	).rejects.toThrow("256 KiB");
});

test.each(["purge", "close"])("%s during a pending request prevents late persistence", async (action) => {
	let respond: (response: Response) => void = () => {};
	const queries = open(
		() =>
			new Promise<Response>((resolve) => {
				respond = resolve;
			}),
	);
	const pending = queries.lookup("p", input(), "1.1.1.1");
	const rejected = expect(pending).rejects.toThrow();
	if (action === "purge") queries.purgeProject("p");
	else {
		queries.close();
		opened.splice(opened.indexOf(queries), 1);
	}
	respond(Response.json({ objectClassName: "ip network" }));
	await rejected;
	const restored = open(vi.fn(registry));
	expect(() => restored.assertComplete("p", input())).toThrow("缺少");
});
