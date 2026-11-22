import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type WorkProcessCompletion, WorkProcesses } from "../src/work-process.ts";
import { applyWorkProcessAnalysis, buildWorkProcessInput } from "../src/work-process-analysis.ts";
import type { WorkProcessSources } from "../src/work-process-source.ts";
import { WorkProcessStore } from "../src/work-process-store.ts";
import type { WorkProcessRef } from "../src/work-process-types.ts";
import { workEvidence, workGraph, workReply, workSnapshot } from "./work-process-fixtures.ts";

let dir: string;
const resources: WorkProcesses[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "work-process-"));
});
afterEach(() => {
	for (const resource of resources.splice(0)) resource.close();
	rmSync(dir, { force: true, recursive: true });
});

function harness(complete: WorkProcessCompletion = async (input) => workReply(input)) {
	const snapshot = workSnapshot();
	const sources: WorkProcessSources = {
		list: async () => [snapshot.source],
		load: async () => structuredClone(snapshot),
		original: async (_ref, entry) => ({ text: entry.text, truncated: entry.truncated }),
	};
	const store = new WorkProcessStore(join(dir, "process.db"));
	const manager = new WorkProcesses(store, sources, complete);
	resources.push(manager);
	return { manager, store, snapshot, sources, ref: snapshot.source };
}

function patch(overrides: Record<string, unknown> = {}) {
	return {
		id: "new-1",
		kind: "step",
		parentId: "root",
		title: "权限检查",
		intent: "确认接口权限",
		intentBasis: "inferred",
		quote: "",
		status: "running",
		actions: ["检查接口"],
		outcomes: [],
		evidenceIds: ["e1"],
		confidence: 0.8,
		...overrides,
	};
}

describe("work process analysis validation", () => {
	test("bounds accumulated graph context without changing evidence or the saved graph", () => {
		const process = workGraph();
		process.nodes[0].intent = "工程总目标";
		process.nodes[0].evidenceIds = Array.from({ length: 100 }, (_, index) => `old${index}`);
		for (let index = 0; index < 50; index++) {
			process.nodes.push({
				...structuredClone(process.nodes[0]),
				id: `step${index}`,
				kind: "step",
				parentId: "root",
			});
		}
		const before = structuredClone(process);
		const lane = workSnapshot().lanes[0];
		for (const compact of [false, true]) {
			const input = JSON.parse(buildWorkProcessInput(process, lane, lane.evidence, compact)) as {
				compact: boolean;
				objective: string;
				parentId: string;
				batchEvidenceIds: string[];
				parent: { previousEvidenceIds: string[] };
				nodes: { previousEvidenceIds: string[] }[];
				records: unknown[];
			};
			expect(input).toMatchObject({ compact, objective: "工程总目标", parentId: "root", records: lane.evidence });
			expect(input.nodes).toHaveLength(compact ? 8 : 40);
			expect(input.batchEvidenceIds).toEqual(["e1"]);
			expect(input.parent.previousEvidenceIds).toEqual(["old94", "old95", "old96", "old97", "old98", "old99"]);
			expect(input.nodes.every((node) => node.previousEvidenceIds.length <= 6)).toBe(true);
			expect(input.parent).not.toHaveProperty("evidenceIds");
		}
		expect(process).toEqual(before);
	});

	test("aggregates steps under goals, resolves local ids and preserves evidence on updates", () => {
		const process = workGraph();
		const lane = workSnapshot().lanes[0];
		const first = applyWorkProcessAnalysis(
			process,
			lane,
			lane.evidence,
			JSON.stringify({
				nodes: [patch({ id: "goal", kind: "goal" }), patch({ parentId: "goal" })],
				edges: [],
			}),
			10,
		);
		expect(first.nodes[1].parentId).toBe(first.nodes[0].id);
		process.nodes.push(...first.nodes);
		process.revision = 1;
		const next = workEvidence("e2");
		const updated = applyWorkProcessAnalysis(
			process,
			lane,
			[next],
			JSON.stringify({
				nodes: [
					patch({
						id: first.nodes[1].id,
						parentId: first.nodes[0].id,
						evidenceIds: [next.id],
						outcomes: ["未发现越权"],
					}),
				],
				edges: [],
			}),
			20,
		);
		expect(updated.nodes[0]).toMatchObject({
			id: first.nodes[1].id,
			revision: 2,
			evidenceIds: ["e1", "e2"],
			outcomes: ["未发现越权"],
		});
		expect(first.nodes[1].evidenceIds).toEqual(["e1"]);
	});

	test("accepts an existing node's echoed history alongside current evidence and deduplicates it", () => {
		const process = workGraph();
		const lane = workSnapshot().lanes[0];
		const previous = applyWorkProcessAnalysis(
			process,
			lane,
			lane.evidence,
			JSON.stringify({ nodes: [patch()], edges: [] }),
		).nodes[0];
		process.nodes.push(previous);
		const batch = [workEvidence("e2", { kind: "tool_end", text: "已返回结果" })];
		const before = structuredClone(process);
		const revision = applyWorkProcessAnalysis(
			process,
			lane,
			batch,
			JSON.stringify({
				nodes: [
					patch({
						id: previous.id,
						evidenceIds: ["e1", "e2", "e1"],
						intentBasis: "explicit",
						quote: "确认接口权限",
						status: "done",
					}),
				],
				edges: [],
			}),
		);
		expect(revision.nodes[0]).toMatchObject({
			id: previous.id,
			evidenceIds: ["e1", "e2"],
			intentBasis: "explicit",
			status: "done",
		});
		expect(process).toEqual(before);
	});

	test.each(["invented", "other-node", "other-agent"])(
		"rejects %s references even alongside valid current evidence",
		(extra) => {
			const process = workGraph();
			const lane = workSnapshot().lanes[0];
			const previous = applyWorkProcessAnalysis(
				process,
				lane,
				lane.evidence,
				JSON.stringify({ nodes: [patch()], edges: [] }),
			).nodes[0];
			process.nodes.push(previous);
			process.evidence.push(workEvidence("other-node"), workEvidence("other-agent", { ownerId: "worker" }));
			const before = structuredClone(process);
			expect(() =>
				applyWorkProcessAnalysis(
					process,
					lane,
					[workEvidence("e2")],
					JSON.stringify({
						nodes: [patch({ id: previous.id, evidenceIds: ["e1", "e2", extra] })],
						edges: [],
					}),
				),
			).toThrow(/证据/);
			expect(process).toEqual(before);
		},
	);

	test("new nodes cannot borrow historical evidence from another node", () => {
		const process = workGraph();
		const lane = workSnapshot().lanes[0];
		process.nodes.push(
			...applyWorkProcessAnalysis(process, lane, lane.evidence, JSON.stringify({ nodes: [patch()], edges: [] }))
				.nodes,
		);
		expect(() =>
			applyWorkProcessAnalysis(
				process,
				lane,
				[workEvidence("e2")],
				JSON.stringify({
					nodes: [patch({ evidenceIds: ["e1", "e2"] })],
					edges: [],
				}),
			),
		).toThrow(/证据/);
	});

	test("history-only updates cannot consume a batch or bypass current coverage for changed records", () => {
		const process = workGraph();
		const lane = workSnapshot().lanes[0];
		const previous = applyWorkProcessAnalysis(
			process,
			lane,
			lane.evidence,
			JSON.stringify({ nodes: [patch()], edges: [] }),
		).nodes[0];
		process.nodes.push(previous);
		expect(() =>
			applyWorkProcessAnalysis(
				process,
				lane,
				[workEvidence("e2")],
				JSON.stringify({
					nodes: [patch({ id: previous.id, evidenceIds: ["e1"] })],
					edges: [],
				}),
			),
		).toThrow(/本批/);
		expect(() =>
			applyWorkProcessAnalysis(
				process,
				lane,
				[workEvidence("e1", { text: "已变化的记录" }), workEvidence("e2")],
				JSON.stringify({
					nodes: [patch({ id: previous.id, evidenceIds: ["e2"] })],
					edges: [],
				}),
			),
		).toThrow("遗漏");
	});

	test("echoed historical messages cannot mark a newly started call complete", () => {
		const process = workGraph();
		const lane = workSnapshot().lanes[0];
		const previous = applyWorkProcessAnalysis(
			process,
			lane,
			lane.evidence,
			JSON.stringify({ nodes: [patch()], edges: [] }),
		).nodes[0];
		process.nodes.push(previous);
		expect(() =>
			applyWorkProcessAnalysis(
				process,
				lane,
				[workEvidence("e2", { kind: "tool_start", status: "running" })],
				JSON.stringify({
					nodes: [patch({ id: previous.id, evidenceIds: ["e1", "e2"], status: "done" })],
					edges: [],
				}),
			),
		).toThrow("尚未返回");
	});

	test("accepts cumulative evidence lists larger than one batch for the same existing node", () => {
		const process = workGraph();
		const history = Array.from({ length: 40 }, (_, index) => workEvidence(`old${index}`));
		process.evidence.push(...history);
		process.nodes.push({
			...process.nodes[0],
			id: "existing",
			kind: "step",
			parentId: "root",
			evidenceIds: history.map((entry) => entry.id),
		});
		const revision = applyWorkProcessAnalysis(
			process,
			workSnapshot().lanes[0],
			[workEvidence("e2")],
			JSON.stringify({
				nodes: [patch({ id: "existing", evidenceIds: [...history.map((entry) => entry.id), "e2"] })],
				edges: [],
			}),
		);
		expect(revision.nodes[0].evidenceIds).toHaveLength(41);
	});

	test.each([
		patch({ evidenceIds: ["invented"] }),
		patch({ evidenceIds: [] }),
		patch({ id: "root" }),
		patch({ parentId: "missing" }),
		patch({ status: "complete" }),
		patch({ confidence: 2 }),
		patch({ intentBasis: "explicit", quote: "不存在的原文" }),
		patch({ title: "" }),
	])("rejects invalid or unsupported patches without mutating the graph: %j", (node) => {
		const process = workGraph();
		const before = structuredClone(process);
		const lane = workSnapshot().lanes[0];
		expect(() =>
			applyWorkProcessAnalysis(process, lane, lane.evidence, JSON.stringify({ nodes: [node], edges: [] })),
		).toThrow();
		expect(process).toEqual(before);
	});

	test("requires an actual quote for explicit intent and marks truncated source evidence", () => {
		const process = workGraph();
		const lane = workSnapshot([workEvidence("e1", { truncated: true })]).lanes[0];
		const revision = applyWorkProcessAnalysis(
			process,
			lane,
			lane.evidence,
			JSON.stringify({ nodes: [patch({ intentBasis: "explicit", quote: "确认接口权限" })], edges: [] }),
		);
		expect(revision.nodes[0].intentBasis).toBe("explicit");
		expect(revision.nodes[0].outcomes.join()).toContain("截断");
	});

	test("rejects completed steps based only on a running call", () => {
		const lane = workSnapshot([workEvidence("e1", { kind: "tool_start", status: "running" })]).lanes[0];
		expect(() =>
			applyWorkProcessAnalysis(
				workGraph(),
				lane,
				lane.evidence,
				JSON.stringify({ nodes: [patch({ status: "done" })], edges: [] }),
			),
		).toThrow("尚未返回");
	});

	test("rejects parent cycles, duplicate local ids and cross-agent updates", () => {
		const process = workGraph();
		const lane = workSnapshot().lanes[0];
		for (const nodes of [
			[patch({ id: "a", kind: "goal", parentId: "b" }), patch({ id: "b", kind: "goal", parentId: "a" })],
			[patch(), patch()],
		]) {
			expect(() =>
				applyWorkProcessAnalysis(process, lane, lane.evidence, JSON.stringify({ nodes, edges: [] })),
			).toThrow();
		}
		process.nodes.push({ ...process.nodes[0], id: "other", ownerId: "other", kind: "step" });
		expect(() =>
			applyWorkProcessAnalysis(
				process,
				lane,
				lane.evidence,
				JSON.stringify({ nodes: [patch({ id: "other" })], edges: [] }),
			),
		).toThrow("其他 Agent");
	});

	test("validates causal evidence separately from chronological sequence", () => {
		const process = workGraph();
		const lane = workSnapshot().lanes[0];
		const nodes = [patch({ id: "a" }), patch({ id: "b" })];
		for (const kind of ["sequence", "dependency", "pivot", "merge"]) {
			const revision = applyWorkProcessAnalysis(
				process,
				lane,
				lane.evidence,
				JSON.stringify({
					nodes,
					edges: [{ from: "a", to: "b", kind, reason: "根据记录调整方向", evidenceIds: ["e1"] }],
				}),
			);
			expect(revision.edges.at(-1)).toMatchObject({ kind, basis: "inferred" });
		}
		for (const edge of [
			{ from: "a", to: "missing", kind: "pivot", reason: "x", evidenceIds: ["e1"] },
			{ from: "a", to: "b", kind: "pivot", reason: "", evidenceIds: [] },
		]) {
			expect(() =>
				applyWorkProcessAnalysis(process, lane, lane.evidence, JSON.stringify({ nodes, edges: [edge] })),
			).toThrow();
		}
	});
});

describe("independent work process queue", () => {
	test("continues incremental analysis with echoed historical references after a service restart", async () => {
		const first = harness();
		await first.manager.control(first.ref, "analyze");
		await vi.waitFor(() => expect(first.store.get(first.ref)?.revision).toBe(1));
		const saved = first.store.get(first.ref)!;
		const step = saved.nodes.find((node) => node.kind === "step")!;
		first.manager.close();
		resources.splice(resources.indexOf(first.manager), 1);
		const complete = vi.fn(async (input: string) => {
			const reply = workReply(input);
			const patch = JSON.parse(reply.content) as { nodes: { evidenceIds: string[] }[] };
			patch.nodes[0].evidenceIds.unshift(...step.evidenceIds);
			return { ...reply, content: JSON.stringify(patch) };
		});
		const reopened = new WorkProcesses(new WorkProcessStore(join(dir, "process.db")), first.sources, complete);
		resources.push(reopened);
		first.snapshot.lanes[0].evidence.push(workEvidence("e2"));
		await reopened.control(first.ref, "retry");
		await vi.waitFor(async () => expect((await reopened.detail(first.ref)).revision).toBe(2));
		expect(await reopened.detail(first.ref)).toMatchObject({ error: null, pending: 0, usage: { total: 60 } });
		expect((await reopened.detail(first.ref)).nodes.find((node) => node.id === step.id)?.evidenceIds).toEqual([
			"e1",
			"e2",
		]);
		expect(reopened.revisions(first.ref, step.id)).toHaveLength(2);
		expect(complete).toHaveBeenCalledTimes(1);
	});

	test("rejects invented references without altering prior results, then retries only the pending record", async () => {
		let invent = false;
		const { manager, snapshot, ref } = harness(async (input) => {
			const reply = workReply(input);
			if (!invent) return reply;
			const result = JSON.parse(reply.content) as { nodes: { evidenceIds: string[] }[] };
			result.nodes[0].evidenceIds.push("invented");
			return { ...reply, content: JSON.stringify(result) };
		});
		await manager.control(ref, "analyze");
		await vi.waitFor(async () => expect((await manager.detail(ref)).revision).toBe(1));
		const before = await manager.detail(ref);
		snapshot.lanes[0].evidence.push(workEvidence("e2"));
		invent = true;
		await manager.control(ref, "analyze");
		await vi.waitFor(async () => expect((await manager.detail(ref)).error).toContain("未知证据"));
		const failed = await manager.detail(ref);
		expect(failed.nodes).toEqual(before.nodes);
		expect(failed.consumed).toEqual(before.consumed);
		expect(failed).toMatchObject({ pending: 1, revision: 1, usage: { total: 60 } });
		invent = false;
		await manager.control(ref, "retry");
		await vi.waitFor(async () => expect((await manager.detail(ref)).revision).toBe(2));
		expect(await manager.detail(ref)).toMatchObject({ error: null, pending: 0, usage: { total: 90 } });
	});

	test("rejects omitted batch records instead of silently consuming them", async () => {
		const { manager, snapshot, ref } = harness(async (input) => {
			const reply = workReply(input);
			const parsed = JSON.parse(reply.content) as { nodes: { evidenceIds: string[] }[] };
			parsed.nodes[0].evidenceIds = ["e1"];
			return { ...reply, content: JSON.stringify(parsed) };
		});
		snapshot.lanes[0].evidence.push(workEvidence("e2"));
		await manager.control(ref, "analyze");
		await vi.waitFor(async () => expect((await manager.detail(ref)).error).toContain("遗漏"));
		expect(await manager.detail(ref)).toMatchObject({ consumed: {}, pending: 2, revision: 0 });
	});

	test("an enabled analysis failure stays scheduled until success or pause", async () => {
		const { manager, store, ref } = harness(async () => {
			throw new Error("provider failure");
		});
		await manager.control(ref, "enable");
		await vi.waitFor(() => expect(store.get(ref)?.error).toBe("provider failure"));
		expect(store.watchers()).toEqual([{ projectId: ref.projectId, kind: ref.kind, id: ref.id }]);
		await manager.control(ref, "pause");
		expect(store.watchers()).toEqual([]);
	});

	test("truncated model output preserves the unconsumed batch", async () => {
		const { manager, ref } = harness(async (input) => ({ ...workReply(input), finishReason: "length" }));
		await manager.control(ref, "analyze");
		await vi.waitFor(async () => expect((await manager.detail(ref)).error).toContain("输出被截断"));
		expect(await manager.detail(ref)).toMatchObject({ consumed: {}, pending: 1, revision: 0, running: false });
	});

	test("automatically halves truncated batches, remembers the limit and consumes every record once", async () => {
		const sizes: number[] = [];
		const { manager, snapshot, ref } = harness(async (input) => {
			const records = (JSON.parse(input) as { records: unknown[] }).records;
			sizes.push(records.length);
			return { ...workReply(input), finishReason: records.length > 3 ? "length" : "stop" };
		});
		snapshot.lanes[0].evidence = Array.from({ length: 12 }, (_, index) => workEvidence(`e${index}`));
		await manager.control(ref, "analyze");
		await vi.waitFor(async () => expect((await manager.detail(ref)).pending).toBe(0));
		const process = await manager.detail(ref);
		expect(sizes).toEqual([12, 6, 3, 3, 3, 3]);
		expect(process).toMatchObject({ revision: 4, batchSize: 3, error: null, usage: { total: 180 } });
		expect(Object.keys(process.consumed)).toHaveLength(12);
		const steps = process.nodes.filter((node) => node.kind === "step");
		expect(steps).toHaveLength(1);
		expect(steps[0].evidenceIds).toEqual(snapshot.lanes[0].evidence.map((entry) => entry.id));
		expect(manager.revisions(ref, steps[0].id)).toHaveLength(4);
	});

	test("retries a truncated singleton in compact mode and persists that choice across restart", async () => {
		const modes: boolean[] = [];
		const first = harness(async (input) => {
			const { compact } = JSON.parse(input) as { compact: boolean };
			modes.push(compact);
			return { ...workReply(input), finishReason: compact ? "stop" : "length" };
		});
		await first.manager.control(first.ref, "analyze");
		await vi.waitFor(() => expect(first.store.get(first.ref)?.revision).toBe(1));
		expect(modes).toEqual([false, true]);
		expect(first.store.get(first.ref)).toMatchObject({ compactAnalysis: true, usage: { total: 60 } });
		first.manager.close();
		resources.splice(resources.indexOf(first.manager), 1);
		const complete = vi.fn(async (input: string) => {
			expect(JSON.parse(input)).toMatchObject({ compact: true });
			return workReply(input);
		});
		const reopened = new WorkProcesses(new WorkProcessStore(join(dir, "process.db")), first.sources, complete);
		resources.push(reopened);
		first.snapshot.lanes[0].evidence.push(workEvidence("e2"));
		await reopened.control(first.ref, "retry");
		await vi.waitFor(async () => expect((await reopened.detail(first.ref)).revision).toBe(2));
		expect(complete).toHaveBeenCalledTimes(1);
		expect(await reopened.detail(first.ref)).toMatchObject({
			pending: 0,
			compactAnalysis: true,
			usage: { total: 90 },
		});
	});

	test("bounds repeated truncation and starts manual retry with the learned batch size after restart", async () => {
		const sizes: number[] = [];
		const first = harness(async (input) => {
			sizes.push((JSON.parse(input) as { records: unknown[] }).records.length);
			return { ...workReply(input), finishReason: "length" };
		});
		first.snapshot.lanes[0].evidence = Array.from({ length: 12 }, (_, index) => workEvidence(`e${index}`));
		await first.manager.control(first.ref, "enable");
		await vi.waitFor(() => expect(first.store.get(first.ref)?.error).toContain("单条记录"));
		expect(sizes).toEqual([12, 6, 3, 1, 1]);
		expect(first.store.get(first.ref)).toMatchObject({
			consumed: {},
			pending: 12,
			revision: 0,
			running: false,
			batchSize: 1,
			compactAnalysis: true,
			usage: { total: 150 },
		});
		expect(first.store.watchers()).toEqual([
			{ projectId: first.ref.projectId, kind: first.ref.kind, id: first.ref.id },
		]);
		first.manager.close();
		resources.splice(resources.indexOf(first.manager), 1);
		const complete = vi.fn(async (input: string) => {
			expect(JSON.parse(input)).toMatchObject({ compact: true, records: [expect.objectContaining({ id: "e0" })] });
			return { ...workReply(input), finishReason: "length" };
		});
		const reopened = new WorkProcesses(new WorkProcessStore(join(dir, "process.db")), first.sources, complete);
		resources.push(reopened);
		await reopened.control(first.ref, "retry");
		await vi.waitFor(async () => expect((await reopened.detail(first.ref)).error).toContain("输出被截断"));
		expect(complete).toHaveBeenCalledTimes(1);
		expect(await reopened.detail(first.ref)).toMatchObject({
			consumed: {},
			revision: 0,
			pending: 12,
			usage: { total: 180 },
		});
	});

	test("pausing during automatic truncation recovery cancels further attempts and ignores late replies", async () => {
		let release: (() => void) | undefined;
		let signal: AbortSignal | undefined;
		const complete = vi.fn(async (input: string, requestSignal: AbortSignal) => {
			if (complete.mock.calls.length === 1) return { ...workReply(input), finishReason: "length" };
			signal = requestSignal;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { ...workReply(input), finishReason: "length" };
		});
		const { manager, ref, store, snapshot } = harness(complete);
		snapshot.lanes[0].evidence.push(workEvidence("e2"));
		await manager.control(ref, "enable");
		await vi.waitFor(() => expect(release).toBeDefined());
		await manager.control(ref, "pause");
		expect(signal?.aborted).toBe(true);
		release?.();
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(complete).toHaveBeenCalledTimes(2);
		expect(store.get(ref)).toMatchObject({
			enabled: false,
			running: false,
			consumed: {},
			revision: 0,
			pending: 2,
			error: null,
		});
	});

	test("preserves an existing graph when all recovery attempts truncate and resumes only pending evidence", async () => {
		let truncated = false;
		const { manager, snapshot, ref } = harness(async (input) => ({
			...workReply(input),
			finishReason: truncated ? "length" : "stop",
		}));
		await manager.control(ref, "analyze");
		await vi.waitFor(async () => expect((await manager.detail(ref)).revision).toBe(1));
		const before = await manager.detail(ref);
		snapshot.lanes[0].evidence.push(workEvidence("e2"));
		truncated = true;
		await manager.control(ref, "analyze");
		await vi.waitFor(async () => expect((await manager.detail(ref)).error).toContain("输出被截断"));
		const failed = await manager.detail(ref);
		expect(failed.nodes).toEqual(before.nodes);
		expect(failed.edges).toEqual(before.edges);
		expect(failed.consumed).toEqual(before.consumed);
		expect(failed).toMatchObject({ revision: 1, pending: 1, usage: { total: 90 } });
		truncated = false;
		await manager.control(ref, "retry");
		await vi.waitFor(async () => expect((await manager.detail(ref)).revision).toBe(2));
		expect(await manager.detail(ref)).toMatchObject({ pending: 0, error: null, usage: { total: 120 } });
		expect((await manager.detail(ref)).nodes.find((node) => node.kind === "step")?.evidenceIds).toEqual(["e1", "e2"]);
	});

	test("no new evidence does not write an unchanged graph or call the model again", async () => {
		const complete = vi.fn(async (input: string) => workReply(input));
		const { manager, store, ref } = harness(complete);
		await manager.control(ref, "enable");
		await vi.waitFor(() => expect(store.get(ref)?.revision).toBe(1));
		const save = vi.spyOn(store, "save");
		manager.start();
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(save).not.toHaveBeenCalled();
		expect(complete).toHaveBeenCalledTimes(1);
	});

	test("a deleted in-flight analysis cannot resurrect its process on a late reply", async () => {
		let release: (() => void) | undefined;
		const { manager, store, ref } = harness(async (input) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return workReply(input);
		});
		await manager.control(ref, "enable");
		await vi.waitFor(() => expect(release).toBeDefined());
		manager.delete(ref);
		release?.();
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(store.get(ref)).toBeNull();
		expect(store.watchers()).toEqual([]);
	});

	test("stays opt-in; analyzes history once; resumes with stable nodes and no duplicate consumption", async () => {
		const complete = vi.fn(async (input: string) => workReply(input));
		const { manager, snapshot, ref } = harness(complete);
		manager.start();
		expect((await manager.list("p1", "session"))[0].state).toBe("off");
		expect(complete).not.toHaveBeenCalled();
		await manager.control(ref, "analyze");
		await vi.waitFor(async () => expect((await manager.detail(ref)).revision).toBe(1));
		const first = await manager.detail(ref);
		const id = first.nodes.find((node) => node.kind === "step")?.id;
		expect(first).toMatchObject({ enabled: false, pending: 0, usage: { total: 30 } });
		await manager.control(ref, "analyze");
		await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
		snapshot.lanes[0].evidence.push(workEvidence("e2", { kind: "tool_end", status: "ok" }));
		await manager.control(ref, "enable");
		await vi.waitFor(async () => expect((await manager.detail(ref)).revision).toBe(2));
		const second = await manager.detail(ref);
		expect(second.nodes.filter((node) => node.kind === "step")).toHaveLength(1);
		expect(second.nodes.find((node) => node.id === id)).toMatchObject({ revision: 2, evidenceIds: ["e1", "e2"] });
		expect(second.enabled).toBe(true);
		expect(second.usage.total).toBe(60);
		expect(manager.revisions(ref, id ?? "")).toHaveLength(2);
		await manager.control(ref, "pause");
		expect((await manager.detail(ref)).enabled).toBe(false);
	});

	test("drains multiple batches and fairly processes each engine worker", async () => {
		const { manager, snapshot, ref } = harness();
		snapshot.lanes[0].evidence = Array.from({ length: 28 }, (_, index) => workEvidence(`e${index}`));
		snapshot.lanes.push({
			ownerId: "worker",
			parentId: "worker-root",
			evidence: [workEvidence("worker-e1", { ownerId: "worker" })],
		});
		snapshot.nodes.push({
			...snapshot.nodes[0],
			id: "worker-root",
			ownerId: "worker",
			parentId: "root",
			kind: "task",
		});
		await manager.control(ref, "analyze");
		await vi.waitFor(async () => expect((await manager.detail(ref)).pending).toBe(0));
		const process = await manager.detail(ref);
		expect(process.revision).toBe(4);
		expect(process.nodes.filter((node) => node.kind === "step")).toHaveLength(2);
	});

	test("keeps the cursor and existing results after failure, then retries the same evidence", async () => {
		let failing = false;
		const complete = vi.fn(async (input: string) => {
			if (failing) throw new Error("endpoint unavailable");
			return workReply(input);
		});
		const { manager, snapshot, ref } = harness(complete);
		await manager.control(ref, "analyze");
		await vi.waitFor(async () => expect((await manager.detail(ref)).revision).toBe(1));
		snapshot.lanes[0].evidence.push(workEvidence("e2"));
		failing = true;
		await manager.control(ref, "enable");
		await vi.waitFor(async () => expect((await manager.detail(ref)).error).toContain("endpoint unavailable"));
		expect(await manager.detail(ref)).toMatchObject({ revision: 1, pending: 1 });
		failing = false;
		await manager.control(ref, "retry");
		await vi.waitFor(async () => expect((await manager.detail(ref)).revision).toBe(2));
		expect((await manager.detail(ref)).error).toBeNull();
		expect(complete).toHaveBeenCalledTimes(3);
	});

	test("pausing aborts an in-flight request; late replies cannot alter the graph", async () => {
		let release: (() => void) | undefined;
		let signal: AbortSignal | undefined;
		const complete: WorkProcessCompletion = async (input, requestSignal) => {
			signal = requestSignal;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return workReply(input);
		};
		const { manager, ref } = harness(complete);
		await manager.control(ref, "enable");
		await vi.waitFor(() => expect(release).toBeDefined());
		await manager.control(ref, "pause");
		expect(signal?.aborted).toBe(true);
		release?.();
		await vi.waitFor(async () => expect((await manager.detail(ref)).running).toBe(false));
		expect((await manager.detail(ref)).revision).toBe(0);
	});

	test("deleting a process cancels it and removes its revision history", async () => {
		const { manager, ref, store } = harness();
		await manager.control(ref, "analyze");
		await vi.waitFor(() => expect(store.get(ref)?.revision).toBe(1));
		const id = store.get(ref)?.nodes.find((node) => node.kind === "step")?.id ?? "";
		manager.purgeProject(ref.projectId);
		expect(store.get(ref)).toBeNull();
		expect(manager.revisions(ref, id)).toEqual([]);
	});

	test("restores the persisted cursor after a service restart", async () => {
		const first = harness();
		await first.manager.control(first.ref, "enable");
		await vi.waitFor(() => expect(first.store.get(first.ref)?.revision).toBe(1));
		first.manager.close();
		resources.splice(resources.indexOf(first.manager), 1);
		const complete = vi.fn(async (input: string) => workReply(input));
		const reopened = new WorkProcesses(new WorkProcessStore(join(dir, "process.db")), first.sources, complete);
		resources.push(reopened);
		reopened.start();
		await reopened.control(first.ref, "enable");
		expect((await reopened.detail(first.ref)).revision).toBe(1);
		expect(complete).not.toHaveBeenCalled();
		first.snapshot.lanes[0].evidence.push(workEvidence("e2"));
		await reopened.control(first.ref, "retry");
		await vi.waitFor(async () => expect((await reopened.detail(first.ref)).revision).toBe(2));
	});

	test("bounds model concurrency and isolates projects with the same source id", async () => {
		const releases: (() => void)[] = [];
		let concurrency = 0;
		let maximum = 0;
		const { manager, sources, snapshot } = harness(async (input) => {
			concurrency++;
			maximum = Math.max(maximum, concurrency);
			await new Promise<void>((resolve) => releases.push(resolve));
			concurrency--;
			return workReply(input);
		});
		sources.load = async (ref) => ({ ...structuredClone(snapshot), source: { ...snapshot.source, ...ref } });
		const refs: WorkProcessRef[] = ["p1", "p2", "p3"].map((projectId) => ({ ...snapshot.source, projectId }));
		for (const ref of refs) await manager.control(ref, "analyze");
		await vi.waitFor(() => expect(releases).toHaveLength(2));
		expect(maximum).toBe(2);
		releases[0]();
		await vi.waitFor(() => expect(releases).toHaveLength(3));
		releases[1]();
		releases[2]();
		await vi.waitFor(async () => {
			for (const ref of refs) expect((await manager.detail(ref)).revision).toBe(1);
		});
	});

	test("rejected model output never advances the source cursor", async () => {
		const { manager, ref } = harness(async (input) => ({ ...workReply(input), content: '{"nodes":[],"edges":[]}' }));
		await manager.control(ref, "analyze");
		await vi.waitFor(async () => expect((await manager.detail(ref)).error).not.toBeNull());
		expect(await manager.detail(ref)).toMatchObject({ revision: 0, consumed: {}, pending: 1 });
	});
});
