import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deleteDoctrine, listDoctrines, saveDoctrine } from "../src/doctrines.ts";
import { EngineStore } from "../src/engine-store.ts";
import {
	type IntelligenceEngineBridge,
	IntelligenceManager,
	intelligenceEngineSubmission,
} from "../src/intelligence.ts";
import { normalizeIntelligenceIp, parseIntelligencePolicy, parseIntelligencePush } from "../src/intelligence-input.ts";
import { IntelligenceStore } from "../src/intelligence-store.ts";
import {
	DEFAULT_INTELLIGENCE_POLICY,
	type IntelligenceBatch,
	type IntelligenceEventInput,
	type IntelligencePush,
} from "../src/intelligence-types.ts";
import { parseTargetLines } from "../src/worker.ts";

let dir: string;
let store: IntelligenceStore;
let engines: EngineStore;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "intelligence-test-"));
	store = new IntelligenceStore(join(dir, "intel.db"));
	engines = new EngineStore(join(dir, "engines.db"));
});
afterEach(() => {
	store.close();
	engines.close();
	rmSync(dir, { recursive: true, force: true });
});

function event(id: string, ip = "1.1.1.1"): IntelligenceEventInput {
	return {
		event_id: id,
		indicator: { type: "ip", value: ip },
		occurred_at: "2026-11-11T10:00:00Z",
		category: "waf",
		severity: "high",
	};
}
function push(id: string, ...events: IntelligenceEventInput[]): IntelligencePush {
	return parseIntelligencePush({ schema_version: 1, request_id: id, events });
}
function enable(project = "p", threshold = 1, batchSize = 1, concurrency = 1) {
	store.savePolicy(project, {
		...structuredClone(DEFAULT_INTELLIGENCE_POLICY),
		enabled: true,
		threshold,
		batchSize,
		concurrency,
		cooldownMinutes: 1,
	});
}
function claim(now = 1000): IntelligenceBatch {
	const batch = store.claim("p", now);
	if (!batch) throw new Error("Expected claimed batch");
	return batch;
}

test("JSON validation rejects the entire request and normalizes IPv6 / mapped IPv4", () => {
	expect(normalizeIntelligenceIp("2001:0DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
	expect(normalizeIntelligenceIp("::ffff:1.1.1.1")).toBe("1.1.1.1");
	for (const ip of ["1.1.1.0/24", "example.com", "fe80::1%eth0", "1.1.1.1 OR x"])
		expect(() => push("x", event("a", ip))).toThrow();
	expect(() => push("x", event("a"), event("b", "invalid"))).toThrow("events[1]");
	expect(() => push("x", event("a"), event("a"))).toThrow("不能重复");
	expect(() => push("x", { ...event("a"), occurred_at: "2026-02-30T10:00:00Z" })).toThrow("ISO 8601");
	expect(() => push("x", { ...event("a"), occurred_at: "2026-11-11T10:00:00" })).toThrow();
	const privateEvent = { ...event("a"), evidence: { payload: "private" } };
	expect(() => push("x", privateEvent)).toThrow("不允许上报");
	expect(() => parseIntelligencePolicy({ ...DEFAULT_INTELLIGENCE_POLICY, threshold: 100, batchSize: 20 })).toThrow();
});

test("source tokens isolate projects, rotate, disable, and never appear in listings", () => {
	const first = store.createSource("p", "WAF");
	const second = store.createSource("q", "FW");
	expect(store.authenticate(first.token)?.projectId).toBe("p");
	expect(store.authenticate(second.token)?.projectId).toBe("q");
	expect(JSON.stringify(store.sources("p"))).not.toContain(first.token);
	expect(() => store.updateSource("q", first.source.id, true, true)).toThrow("不存在");
	const rotated = store.updateSource("p", first.source.id, true, true);
	expect(store.authenticate(first.token)).toBeUndefined();
	expect(store.authenticate(rotated.token ?? "")?.id).toBe(first.source.id);
	store.updateSource("p", first.source.id, false, false);
	expect(store.authenticate(rotated.token ?? "")).toBeUndefined();
});

test("same project IPs merge across sources while raw alerts and other projects remain independent", () => {
	const a = store.createSource("p", "WAF").source;
	const b = store.createSource("p", "FW").source;
	const c = store.createSource("q", "SOC").source;
	for (const source of [a, b, c]) store.ingest(source, push("r", event("a")), 100);
	expect(store.indicators("p").items[0]).toMatchObject({ ip: "1.1.1.1", count: 2, sources: ["WAF", "FW"] });
	expect(store.indicators("p").total).toBe(1);
	expect(store.alerts("p", "1.1.1.1").total).toBe(2);
	expect(store.alerts("q", "1.1.1.1").total).toBe(1);
});

test("idempotency is canonical and a conflicting event rolls back earlier valid events in the same request", () => {
	const source = store.createSource("p", "WAF").source;
	const original = push("r", event("a"));
	const receipt = store.ingest(source, original);
	expect(store.ingest(source, structuredClone(original))).toEqual(receipt);
	expect(store.ingest(source, push("s", event("a")))).toMatchObject({
		accepted: 0,
		duplicates: 1,
	});
	expect(() => store.ingest(source, push("r", event("b")))).toThrow("request_id");
	expect(() =>
		store.ingest(source, push("t", event("fresh", "8.8.8.8"), { ...event("a"), category: "changed" })),
	).toThrow("event_id");
	expect(store.indicators("p").total).toBe(1);
	expect(store.alerts("p", "8.8.8.8").total).toBe(0);
	expect(store.ingest(source, push("t", event("fresh", "8.8.8.8")))).toMatchObject({ accepted: 1 });
});

test("threshold and batch/concurrency caps hold across database connections", () => {
	enable("p", 2, 2, 2);
	const source = store.createSource("p", "WAF").source;
	store.ingest(source, push("a", event("a")), 100);
	expect(store.claim("p", 1000)).toBeUndefined();
	store.ingest(source, push("b", ...[2, 3, 4, 5].map((id) => event(String(id), `1.1.1.${id}`))), 200);
	const other = new IntelligenceStore(join(dir, "intel.db"));
	try {
		const first = claim();
		const second = other.claim("p", 1000);
		expect(second?.items).toHaveLength(2);
		expect(new Set([...first.items, ...(second?.items ?? [])].map((item) => item.ip)).size).toBe(4);
		expect(other.claim("p", 1000)).toBeUndefined();
		expect(store.activeCount("p")).toBe(2);
	} finally {
		other.close();
	}
});

test("completion covers only the batch watermark and a new alert waits for cooldown", () => {
	enable();
	const source = store.createSource("p", "WAF").source;
	store.ingest(source, push("a", event("a")), 100);
	const batch = claim(1000);
	store.ingest(source, push("b", event("b")), 1100);
	expect(store.claim("p", 100000)).toBeUndefined();
	store.setAttempt(batch, "succeeded", "e", null);
	expect(store.indicators("p", 1, 50, "", 1200).items[0]).toMatchObject({
		count: 2,
		pending: 1,
		status: "cooling",
		cooldownUntil: 61000,
	});
	expect(store.claim("p", 60999)).toBeUndefined();
	const second = claim(61000);
	expect(second.items[0].alerts.map((alert) => alert.event_id)).toEqual(["b"]);
	store.setAttempt(second, "succeeded", "e2", null);
	expect(store.claim("p", 999999)).toBeUndefined();
	store.setAttempt(batch, "failed", "stale-callback", "late");
	expect(store.batch("p", batch.id)?.status).toBe("succeeded");
});

test("failure requires manual retry, preserves snapshot and cooldown, and stale attempts cannot settle it", () => {
	enable();
	const source = store.createSource("p", "WAF").source;
	store.ingest(source, push("a", event("a")));
	const batch = claim();
	store.setAttempt(batch, "failed", "e", "API failed");
	expect(store.claim("p", 999999)).toBeUndefined();
	expect(store.cleanup("p", {}, false).blockedBatches).toBe(1);
	store.retry("p", batch.id, 2000);
	const retried = store.batch("p", batch.id);
	expect(retried?.items).toEqual(batch.items);
	expect(retried?.attempts).toHaveLength(2);
	store.setAttempt(batch, "succeeded", "old", null);
	expect(store.batch("p", batch.id)?.status).toBe("queued");
	expect(store.indicators("p").items[0].cooldownUntil).toBe(61000);
	if (!retried) throw new Error("Missing retry");
	store.setAttempt(retried, "failed", "e2", "again");
	store.discard("p", batch.id);
	expect(store.batch("p", batch.id)?.status).toBe("discarded");
	expect(store.cleanup("p", {}, true).events).toBe(1);
	expect(store.ingest(source, push("replay", event("a")))).toMatchObject({ accepted: 0, duplicates: 1 });
});

test("filtered cleanup preserves other source alerts; clear retains credentials and idempotency", () => {
	const a = store.createSource("p", "WAF");
	const b = store.createSource("p", "FW");
	store.ingest(a.source, push("a", event("a")), 100);
	store.ingest(b.source, push("b", event("a")), 200);
	expect(store.cleanup("p", { sourceId: a.source.id, before: 150 }, true).events).toBe(1);
	expect(store.indicators("p").items[0]).toMatchObject({ count: 1, sources: ["FW"], firstSeen: 200 });
	store.clear("p");
	expect(store.indicators("p").total).toBe(0);
	expect(store.authenticate(a.token)?.id).toBe(a.source.id);
	expect(store.ingest(b.source, push("repeat", event("a")))).toMatchObject({ accepted: 0 });
	store.purgeProject("p");
	expect(store.authenticate(a.token)).toBeUndefined();
});

function bridge(): IntelligenceEngineBridge {
	return {
		createEngine: async (project, input, submission) =>
			engines.createEngine({
				projectId: project.id,
				projectName: project.name,
				name: input.name,
				targets: parseTargetLines(input.targets),
				doctrines: input.doctrines,
				limits: input.limits,
				gateMode: "auto",
				submission,
			}),
		findSubmittedEngine: (source, key) => engines.findSubmittedEngine(source, key),
		getEngine: (id) => engines.getEngine(id),
		pauseEngine: async (id) => {
			engines.setEngineStatus(id, "paused", "manual", null);
		},
		resumeEngine: async (id) => {
			engines.setEngineStatus(id, "running", null, null);
		},
		abortEngine: async (id) => {
			engines.setEngineStatus(id, "stopped", "操作员终止", 1000);
		},
	};
}

test("scheduler recovers an engine committed before its batch reference, and success needs all done plus report", async () => {
	enable();
	const source = store.createSource("p", "WAF").source;
	store.ingest(source, push("a", event("a")));
	const batch = claim();
	const attempt = batch.attempts[0];
	const input = { attemptId: attempt.id, batchId: batch.id, template: batch.template, items: batch.items };
	const request = intelligenceEngineSubmission(input);
	const engine = await bridge().createEngine({ id: "p", name: "P", cwd: dir }, request.input, request.submission);
	expect((await bridge().createEngine({ id: "p", name: "P", cwd: dir }, request.input, request.submission)).id).toBe(
		engine.id,
	);
	engines.setEngineStatus(engine.id, "paused", "服务重启", null);
	const manager = new IntelligenceManager(store, bridge(), () => ({ id: "p", name: "P", cwd: dir }));
	manager.run();
	expect(store.batch("p", batch.id)).toMatchObject({ status: "paused", attempts: [{ engineId: engine.id }] });
	expect(engines.listEngines()).toHaveLength(1);
	await manager.action("p", batch.id, "resume");
	expect(store.batch("p", batch.id)?.status).toBe("running");
	engines.setEngineStatus(engine.id, "completed", null, 2000);
	manager.run();
	expect(store.batch("p", batch.id)?.status).toBe("failed");
	await manager.action("p", batch.id, "retry");
	const retried = store.batch("p", batch.id);
	const nextId = retried?.attempts.at(-1)?.engineId;
	if (!nextId) throw new Error("Missing retry engine");
	expect(nextId).not.toBe(engine.id);
	expect(engines.getEngine(nextId)?.tasks).toEqual([]);
	const task = engines.createTask({
		engineId: nextId,
		title: "Analysis",
		objective: "Analyze the batch",
		target: null,
		workspace: "analysis",
		roundLimit: 5,
		attempt: 1,
	});
	engines.updateTask(task.id, { status: "done", summary: "Full report" });
	engines.setEngineReport(nextId, "Full report");
	engines.setEngineStatus(nextId, "completed", null, 3000);
	manager.run();
	expect(store.batch("p", batch.id)?.status).toBe("succeeded");
	manager.stop();
});

test("a create exception after engine commit is reconciled without permitting overlapping retry", async () => {
	enable();
	store.ingest(store.createSource("p", "WAF").source, push("a", event("a")));
	const integration = bridge();
	const create = integration.createEngine;
	integration.createEngine = async (project, input, submission) => {
		await create(project, input, submission);
		throw new Error("caller failed after commit");
	};
	const manager = new IntelligenceManager(store, integration, () => ({ id: "p", name: "P", cwd: dir }));
	manager.run();
	manager.run();
	expect(engines.listEngines()).toHaveLength(1);
	await vi.waitFor(() => expect(store.batches("p").items[0].status).toBe("running"));
	manager.stop();
});

test("analysis references engineering doctrines, snapshots the latest text and preserves it across retries", async () => {
	expect(listDoctrines(dir).some((item) => item.id === "threat-ip-analysis")).toBe(true);
	expect(store.policy("p").template.limits.tokenLimit).toBeNull();
	const saved = saveDoctrine(dir, { name: "设备关联分析", text: "Version one" }).doctrine;
	if (!saved) throw new Error("Missing doctrine");
	const policy = structuredClone(DEFAULT_INTELLIGENCE_POLICY);
	policy.enabled = true;
	policy.threshold = 1;
	policy.batchSize = 1;
	policy.template = { ...policy.template, id: saved.id, name: "Client name", prompt: "Client override" };
	store.savePolicy("p", policy);
	expect(store.policy("p").template).toMatchObject({ id: saved.id, name: saved.name, prompt: "Version one" });
	saveDoctrine(dir, { id: saved.id, name: saved.name, text: "Version two" });
	store.ingest(store.createSource("p", "WAF").source, push("r", event("a")));
	const batch = claim();
	expect(batch.template.prompt).toBe("Version two");
	const request = intelligenceEngineSubmission({
		attemptId: batch.attempts[0].id,
		batchId: batch.id,
		template: batch.template,
		items: batch.items,
	});
	const engine = await bridge().createEngine({ id: "p", name: "P", cwd: dir }, request.input, request.submission);
	expect(engine.doctrines).toEqual([saved.id]);
	saveDoctrine(dir, { id: saved.id, name: saved.name, text: "Version three" });
	store.setAttempt(batch, "failed", engine.id, "failure");
	store.retry("p", batch.id);
	expect(store.batch("p", batch.id)?.template.prompt).toBe("Version two");
});

test("deleted engineering doctrine prevents new batches while an existing snapshot stays usable", () => {
	const saved = saveDoctrine(dir, { name: "关联分析", text: "Analyze" }).doctrine;
	if (!saved) throw new Error("Missing doctrine");
	const policy = structuredClone(DEFAULT_INTELLIGENCE_POLICY);
	policy.enabled = true;
	policy.threshold = 1;
	policy.batchSize = 1;
	policy.template.id = saved.id;
	store.savePolicy("p", policy);
	store.ingest(store.createSource("p", "WAF").source, push("r", event("a")));
	deleteDoctrine(dir, saved.id);
	expect(store.claim("p")).toBeUndefined();
	expect(store.batches("p").total).toBe(0);
	expect(() => store.savePolicy("p", policy)).toThrow("指挥思路不存在");
});

test("slow commander startup does not block parallel batches or duplicate submissions", async () => {
	enable("p", 1, 1, 2);
	store.ingest(store.createSource("p", "WAF").source, push("r", event("a"), event("b", "8.8.8.8")));
	const integration = bridge();
	const create = integration.createEngine;
	const release: (() => void)[] = [];
	integration.createEngine = vi.fn(async (project, input, submission) => {
		const engine = await create(project, input, submission);
		await new Promise<void>((resolve) => release.push(resolve));
		return engine;
	});
	const manager = new IntelligenceManager(store, integration, () => ({ id: "p", name: "P", cwd: dir }));
	try {
		manager.run();
		manager.run();
		await vi.waitFor(() => expect(release).toHaveLength(2));
		expect(integration.createEngine).toHaveBeenCalledTimes(2);
		expect(engines.listEngines()).toHaveLength(2);
		const batch = store.batches("p").items[0];
		expect(batch.attempts[0].engineId).toBeTruthy();
		await manager.action("p", batch.id, "abort");
		expect(store.batch("p", batch.id)?.status).toBe("aborted");
	} finally {
		manager.stop();
		for (const finish of release) finish();
	}
});

test("submission failure before commit requires a manual retry", async () => {
	enable();
	store.ingest(store.createSource("p", "WAF").source, push("r", event("a")));
	const integration = bridge();
	integration.createEngine = vi.fn().mockRejectedValue(new Error("storage unavailable"));
	const manager = new IntelligenceManager(store, integration, () => ({ id: "p", name: "P", cwd: dir }));
	try {
		manager.run();
		await vi.waitFor(() => expect(store.batches("p").items[0].status).toBe("failed"));
		manager.run();
		expect(integration.createEngine).toHaveBeenCalledOnce();
		expect(engines.listEngines()).toEqual([]);
	} finally {
		manager.stop();
	}
});

test("completion requires all batch targets but permits recovered failed dispatches", async () => {
	enable("p", 2, 2);
	store.ingest(store.createSource("p", "WAF").source, push("r", event("a"), event("b", "8.8.8.8")));
	const manager = new IntelligenceManager(store, bridge(), () => ({ id: "p", name: "P", cwd: dir }));
	try {
		manager.run();
		const batch = store.batches("p").items[0];
		const engineId = batch.attempts[0].engineId;
		if (!engineId) throw new Error("Missing engine");
		const addTask = (ip: string, status: "done" | "failed") => {
			const task = engines.createTask({
				engineId,
				target: ip,
				title: "Analyze",
				objective: "Analyze",
				workspace: "test",
				roundLimit: 3,
				attempt: 1,
			});
			engines.updateTask(task.id, { status, summary: status });
		};
		addTask("1.1.1.1", "failed");
		addTask("1.1.1.1", "done");
		engines.setEngineReport(engineId, "Report");
		engines.setEngineStatus(engineId, "completed", null, 1000);
		manager.run();
		expect(store.batch("p", batch.id)?.status).toBe("failed");
		await manager.action("p", batch.id, "retry");
		const retryId = store.batch("p", batch.id)?.attempts.at(-1)?.engineId;
		if (!retryId) throw new Error("Missing retry engine");
		for (const [ip, status] of [
			["1.1.1.1", "failed"],
			["1.1.1.1", "done"],
			["8.8.8.8", "done"],
		] as const) {
			const task = engines.createTask({
				engineId: retryId,
				target: ip,
				title: "Analyze",
				objective: "Analyze",
				workspace: "test",
				roundLimit: 3,
				attempt: 1,
			});
			engines.updateTask(task.id, { status, summary: status });
		}
		engines.setEngineReport(retryId, "Full report");
		engines.setEngineStatus(retryId, "completed", null, 2000);
		manager.run();
		expect(store.batch("p", batch.id)?.status).toBe("succeeded");
	} finally {
		manager.stop();
	}
});

test("a deleted ordinary engine fails its batch instead of submitting again", () => {
	enable();
	store.ingest(store.createSource("p", "WAF").source, push("r", event("a")));
	const manager = new IntelligenceManager(store, bridge(), () => ({ id: "p", name: "P", cwd: dir }));
	try {
		manager.run();
		const batch = store.batches("p").items[0];
		const engineId = batch.attempts[0].engineId;
		if (!engineId) throw new Error("Missing engine");
		engines.deleteEngine(engineId);
		manager.run();
		expect(store.batch("p", batch.id)?.status).toBe("failed");
		expect(engines.listEngines()).toEqual([]);
	} finally {
		manager.stop();
	}
});
