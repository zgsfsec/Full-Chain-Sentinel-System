import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type WorkProcessCompletion, WorkProcesses, workProcessItem } from "../src/work-process.ts";
import type { WorkProcessSources } from "../src/work-process-source.ts";
import { WorkProcessStore } from "../src/work-process-store.ts";
import { workReply, workSnapshot } from "./work-process-fixtures.ts";

let dir: string;
const resources: WorkProcesses[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "work-link-retry-"));
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
	for (const resource of resources.splice(0)) resource.close();
	vi.useRealTimers();
	rmSync(dir, { force: true, recursive: true });
});

function harness(complete: WorkProcessCompletion) {
	const snapshot = workSnapshot();
	const sources: WorkProcessSources = {
		list: async () => [snapshot.source],
		load: async () => structuredClone(snapshot),
		original: async (_ref, entry) => ({ text: entry.text, truncated: false }),
	};
	const store = new WorkProcessStore(join(dir, "process.db"));
	const manager = new WorkProcesses(store, sources, complete);
	resources.push(manager);
	return { manager, store, sources, ref: snapshot.source };
}

describe("automatic work-link recovery", () => {
	test("network failures retry after the scheduled delay and clear the error only on success", async () => {
		const complete = vi
			.fn<WorkProcessCompletion>()
			.mockRejectedValueOnce(new Error("network unavailable"))
			.mockImplementation(async (input) => workReply(input));
		const { manager, store, ref } = harness(complete);
		await manager.control(ref, "enable");
		await vi.advanceTimersByTimeAsync(0);
		const failed = store.get(ref)!;
		expect(failed).toMatchObject({
			retry: { attempt: 1, at: Date.now() + 3000 },
			consumed: {},
			revision: 0,
			pending: 1,
			running: false,
		});
		expect(workProcessItem(failed).state).toBe("retrying");
		await vi.advanceTimersByTimeAsync(2999);
		expect(complete).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(complete).toHaveBeenCalledTimes(2);
		expect(store.get(ref)).toMatchObject({ revision: 1, pending: 0, retry: null, error: null, enabled: true });
	});

	test("history-only runs back off to a one-minute cap and pause cancels all further retries", async () => {
		const complete = vi.fn<WorkProcessCompletion>().mockRejectedValue(new Error("provider unavailable"));
		const { manager, store, ref } = harness(complete);
		await manager.control(ref, "analyze");
		await vi.advanceTimersByTimeAsync(0);
		for (const [index, delay] of [3000, 6000, 12000, 24000, 48000, 60000, 60000].entries()) {
			expect(store.get(ref)?.retry).toMatchObject({ attempt: index + 1, at: Date.now() + delay, once: true });
			await vi.advanceTimersByTimeAsync(delay);
		}
		expect(complete).toHaveBeenCalledTimes(8);
		expect(store.get(ref)).toMatchObject({ enabled: false, revision: 0, consumed: {} });
		await manager.control(ref, "pause");
		await vi.advanceTimersByTimeAsync(120000);
		expect(complete).toHaveBeenCalledTimes(8);
		expect(store.get(ref)).toMatchObject({ retry: null, error: null, running: false });
		expect(store.watchers()).toEqual([]);
	});

	test("invalid model output retries with feedback without accepting the rejected patch", async () => {
		const complete = vi
			.fn<WorkProcessCompletion>()
			.mockImplementationOnce(async (input) => ({ ...workReply(input), content: '{"nodes":[],"edges":[]}' }))
			.mockImplementation(async (input) => workReply(input));
		const { manager, store, ref } = harness(complete);
		await manager.control(ref, "analyze");
		await vi.advanceTimersByTimeAsync(0);
		expect(store.get(ref)).toMatchObject({ revision: 0, consumed: {}, usage: { total: 30 } });
		await vi.advanceTimersByTimeAsync(3000);
		expect(JSON.parse(complete.mock.calls[1][0])).toMatchObject({
			previousAnalysisError: expect.stringContaining("数量无效"),
		});
		expect(store.get(ref)).toMatchObject({
			revision: 1,
			pending: 0,
			enabled: false,
			retry: null,
			usage: { total: 60 },
		});
	});

	test.each(["delete", "close"])("%s cancels a pending retry", async (action) => {
		const complete = vi.fn<WorkProcessCompletion>().mockRejectedValue(new Error("failed"));
		const { manager, ref } = harness(complete);
		await manager.control(ref, "enable");
		await vi.advanceTimersByTimeAsync(0);
		if (action === "delete") manager.delete(ref);
		else {
			manager.close();
			resources.splice(resources.indexOf(manager), 1);
		}
		await vi.advanceTimersByTimeAsync(10000);
		expect(complete).toHaveBeenCalledTimes(1);
	});

	test("service restart restores history-only retry deadlines and attempt counts", async () => {
		const first = harness(async () => {
			throw new Error("interrupted");
		});
		await first.manager.control(first.ref, "analyze");
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1000);
		first.manager.close();
		resources.splice(resources.indexOf(first.manager), 1);
		const complete = vi.fn<WorkProcessCompletion>().mockImplementation(async (input) => workReply(input));
		const store = new WorkProcessStore(join(dir, "process.db"));
		const restored = new WorkProcesses(store, first.sources, complete);
		resources.push(restored);
		await vi.advanceTimersByTimeAsync(1999);
		expect(complete).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(store.get(first.ref)).toMatchObject({ enabled: false, revision: 1, retry: null });
	});

	test("manual retry replaces the scheduled retry instead of leaving a duplicate request", async () => {
		const complete = vi
			.fn<WorkProcessCompletion>()
			.mockRejectedValueOnce(new Error("failed"))
			.mockImplementation(async (input) => workReply(input));
		const { manager, store, ref } = harness(complete);
		await manager.control(ref, "enable");
		await vi.advanceTimersByTimeAsync(0);
		await manager.control(ref, "retry");
		await vi.advanceTimersByTimeAsync(10000);
		expect(complete).toHaveBeenCalledTimes(2);
		expect(store.get(ref)?.revision).toBe(1);
	});

	test("pausing an automatic attempt ignores its late reply and cannot schedule another retry", async () => {
		let release: (() => void) | undefined;
		const complete = vi
			.fn<WorkProcessCompletion>()
			.mockRejectedValueOnce(new Error("network failed"))
			.mockImplementation(async (input) => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return workReply(input);
			});
		const { manager, store, ref } = harness(complete);
		await manager.control(ref, "enable");
		await vi.advanceTimersByTimeAsync(3000);
		expect(complete).toHaveBeenCalledTimes(2);
		await manager.control(ref, "pause");
		release?.();
		await vi.advanceTimersByTimeAsync(120000);
		expect(store.get(ref)).toMatchObject({ enabled: false, retry: null, error: null, consumed: {}, revision: 0 });
		expect(complete).toHaveBeenCalledTimes(2);
	});

	test("startup recovers an enabled legacy error that had no retry schedule", async () => {
		const first = harness(async (input) => workReply(input));
		const state = await first.manager.detail(first.ref);
		first.store.save({ ...state, enabled: true, error: "old provider error" });
		first.manager.close();
		resources.splice(resources.indexOf(first.manager), 1);
		const complete = vi.fn<WorkProcessCompletion>().mockImplementation(async (input) => workReply(input));
		const store = new WorkProcessStore(join(dir, "process.db"));
		const restored = new WorkProcesses(store, first.sources, complete);
		resources.push(restored);
		expect(store.get(first.ref)?.retry?.attempt).toBe(1);
		await vi.advanceTimersByTimeAsync(3000);
		expect(store.get(first.ref)).toMatchObject({ revision: 1, retry: null, error: null });
	});

	test("retry waits release the concurrency slot so another conversation can analyze", async () => {
		const complete = vi
			.fn<WorkProcessCompletion>()
			.mockRejectedValueOnce(new Error("failed"))
			.mockImplementation(async (input) => workReply(input));
		const { manager, store, ref, sources } = harness(complete);
		const load = sources.load;
		sources.load = async (target) => ({ ...(await load(ref)), source: { ...ref, ...target } });
		await manager.control(ref, "analyze");
		await vi.advanceTimersByTimeAsync(0);
		const other = { ...ref, id: "s2" };
		await manager.control(other, "analyze");
		await vi.advanceTimersByTimeAsync(0);
		expect(store.get(other)?.revision).toBe(1);
		expect(store.get(ref)?.retry?.attempt).toBe(1);
		expect(complete).toHaveBeenCalledTimes(2);
	});

	test("source failures respect backoff and remain pausable while the source is unavailable", async () => {
		const complete = vi.fn<WorkProcessCompletion>().mockRejectedValue(new Error("first failure"));
		const { manager, store, ref, sources } = harness(complete);
		await manager.control(ref, "enable");
		await vi.advanceTimersByTimeAsync(0);
		const load = vi.fn(async () => {
			throw new Error("source unavailable");
		});
		sources.load = load;
		await vi.advanceTimersByTimeAsync(3000);
		expect(store.get(ref)?.retry).toMatchObject({ attempt: 2, at: Date.now() + 6000 });
		await vi.advanceTimersByTimeAsync(5999);
		expect(load).toHaveBeenCalledTimes(1);
		await manager.control(ref, "pause");
		await vi.advanceTimersByTimeAsync(120000);
		expect(load).toHaveBeenCalledTimes(1);
		expect(store.get(ref)).toMatchObject({ enabled: false, error: null, retry: null });
	});
});
