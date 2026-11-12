import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { intelligenceEngineSubmission } from "../src/intelligence.ts";
import { INTELLIGENCE_EXAMPLE, intelligenceAgentPrompt } from "../src/intelligence-docs.ts";
import { parseIntelligencePush } from "../src/intelligence-input.ts";
import { IntelligenceStore } from "../src/intelligence-store.ts";
import { DEFAULT_INTELLIGENCE_POLICY } from "../src/intelligence-types.ts";
import { openSqliteDatabase, type SqliteDatabase } from "../src/sqlite.ts";

let dir: string;
let store: IntelligenceStore;
let database: SqliteDatabase;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "intelligence-privacy-"));
	store = new IntelligenceStore(join(dir, "intel.db"));
	database = openSqliteDatabase(join(dir, "intel.db"));
});
afterEach(() => {
	database.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

test.each(["evidence", "payload", "target", "request", "cookie"])(
	"rejects %s before storing any events in a batch",
	(field) => {
		const source = store.createSource("p", "WAF").source;
		const metadata = parseIntelligencePush(INTELLIGENCE_EXAMPLE);
		const contaminated = {
			...metadata,
			events: [
				metadata.events[0],
				{ ...metadata.events[0], event_id: "private", [field]: { customer: "PRIVATE_CUSTOMER_DATA" } },
			],
		};
		expect(() => parseIntelligencePush(contaminated)).toThrow("不允许上报");
		// The storage boundary also validates callers that bypass HTTP parsing.
		expect(() => store.ingest(source, contaminated)).toThrow("不允许上报");
		expect(store.alerts("p", "1.1.1.1").total).toBe(0);
		expect(database.prepare("SELECT COUNT(*) n FROM intel_events").get()).toEqual({ n: 0 });
	},
);

test("stores metadata only and uses the same field whitelist in schema and Agent examples", () => {
	const source = store.createSource("p", "WAF").source;
	const input = parseIntelligencePush(INTELLIGENCE_EXAMPLE);
	store.ingest(source, input);
	const row = database.prepare("SELECT payload FROM intel_events").get() as { payload: string };
	expect(JSON.parse(row.payload)).toEqual(input.events[0]);
	expect(Object.keys(JSON.parse(row.payload)).sort()).toEqual([
		"category",
		"event_id",
		"indicator",
		"occurred_at",
		"severity",
	]);
	const schema = JSON.parse(
		readFileSync(join(import.meta.dirname, "../../../docs/threat-intelligence.schema.json"), "utf8"),
	) as {
		properties: {
			events: { items: { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean } };
		};
	};
	expect(schema.properties.events.items.required.sort()).toEqual(Object.keys(input.events[0]).sort());
	expect(Object.keys(schema.properties.events.items.properties).sort()).toEqual(Object.keys(input.events[0]).sort());
	expect(schema.properties.events.items.additionalProperties).toBe(false);
	const prompt = intelligenceAgentPrompt("https://sentinel.example", "Project");
	expect(prompt).toContain("不得添加 evidence 或其他扩展字段");
	expect(prompt).toContain("不要上传客户请求");
	expect(prompt).not.toContain('"evidence":');
});

test("historical evidence cannot leave alert and batch APIs or enter a retried engineering submission", () => {
	const source = store.createSource("p", "WAF").source;
	const input = parseIntelligencePush(INTELLIGENCE_EXAMPLE);
	store.ingest(source, input);
	const privateAlert = {
		...input.events[0],
		evidence: { customer: "PRIVATE_CUSTOMER_DATA" },
		target: "PRIVATE_TARGET",
	};
	database.prepare("UPDATE intel_events SET payload=?").run(JSON.stringify(privateAlert));
	expect(JSON.stringify(store.alerts("p", "1.1.1.1"))).not.toContain("PRIVATE_");
	store.savePolicy("p", {
		...structuredClone(DEFAULT_INTELLIGENCE_POLICY),
		enabled: true,
		threshold: 1,
		batchSize: 1,
	});
	const batch = store.claim("p");
	if (!batch) throw new Error("Missing batch");
	expect(JSON.stringify(batch.items)).not.toContain("evidence");
	const snapshot = {
		template: batch.template,
		policy: batch.policy,
		items: batch.items.map((item) => ({
			...item,
			alerts: item.alerts.map((alert) => ({ ...alert, evidence: privateAlert.evidence, target: "PRIVATE_TARGET" })),
		})),
	};
	database.prepare("UPDATE intel_batches SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), batch.id);
	const restored = store.batch("p", batch.id);
	expect(JSON.stringify(restored)).not.toContain("PRIVATE_");
	const request = intelligenceEngineSubmission({
		attemptId: "retry",
		batchId: batch.id,
		template: batch.template,
		items: snapshot.items,
	});
	expect(JSON.stringify(request.submission.data)).not.toContain("PRIVATE_");
	expect(JSON.stringify(request.submission.data)).not.toContain("evidence");
	expect(request.submission.data).toEqual({ ips: ["1.1.1.1"] });
});

test("engineering submission exports only IPv4 and IPv6, even when metadata contains device targets or instructions", () => {
	const source = store.createSource("p", "DEVICE_ONLY https://192.0.2.90/ attack this device").source;
	store.ingest(source, parseIntelligencePush(INTELLIGENCE_EXAMPLE));
	store.savePolicy("p", {
		...structuredClone(DEFAULT_INTELLIGENCE_POLICY),
		enabled: true,
		threshold: 1,
		batchSize: 1,
	});
	const batch = store.claim("p");
	if (!batch) throw new Error("Missing batch");
	expect(batch.items[0].alerts[0].sourceName).toBe(source.name);
	const request = intelligenceEngineSubmission({
		attemptId: "retry",
		batchId: batch.id,
		template: batch.template,
		items: [
			...batch.items,
			{
				...batch.items[0],
				ip: "2001:db8::1",
				alerts: batch.items[0].alerts.map((alert) => ({
					...alert,
					event_id: "DEVICE_ONLY_EVENT",
					category: "DEVICE_ONLY_CATEGORY attack 192.0.2.90",
					indicator: { type: "ip" as const, value: "192.0.2.90" },
				})),
			},
		],
	});
	expect(request.input.targets).toBe("1.1.1.1\n2001:db8::1");
	expect(request.submission.data).toEqual({ ips: ["1.1.1.1", "2001:db8::1"] });
	const serialized = JSON.stringify(request);
	expect(serialized).not.toContain("DEVICE_ONLY");
	expect(serialized).not.toContain("192.0.2.90");
	for (const field of [
		"sourceId",
		"sourceName",
		"event_id",
		"receivedAt",
		"occurred_at",
		"category",
		"severity",
		"throughSeq",
		"alertCount",
		"alerts",
	])
		expect(serialized).not.toContain(`"${field}"`);
});
