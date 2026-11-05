import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeActivityRequest, type CodeActivityQuery } from "./code-activity-request.ts";
import type { SentinelCodeActivityView } from "./types.ts";

const query: CodeActivityQuery = { projectId: "p1", filter: "all", page: 1, pageSize: 20 };
const view: SentinelCodeActivityView = { items: [], total: 0, page: 1, pageSize: 20,
	counts: { attention: 0, review: 0, failed: 0, dispatchFailed: 0, pending: 0, anomalies: 0, reproducing: 0, finished: 0 } };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
	const state = vi.fn();
	const update = vi.fn();
	const send = vi.fn();
	return { state, update, send, request: new CodeActivityRequest(state, update) };
}

describe("activity request lifecycle", () => {
	it("settles server failures and accepts a successful retry", () => {
		const { request, state, update, send } = setup();
		request.load(query, send);
		expect(state).toHaveBeenLastCalledWith(true, null);
		request.accept({ type: "code_activity_error", requestId: 1, error: "项目不存在" });
		expect(state).toHaveBeenLastCalledWith(false, "项目不存在");
		request.load(query, send);
		request.accept({ type: "code_activity", requestId: 2, view });
		expect(state).toHaveBeenLastCalledWith(false, null);
		expect(update).toHaveBeenLastCalledWith(view);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps one deadline despite repeated refresh events and ignores timed-out replies", () => {
		const { request, state, update, send } = setup();
		request.load(query, send);
		vi.advanceTimersByTime(10_000);
		request.load(query, send, true);
		expect(send).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(5_000);
		expect(state).toHaveBeenLastCalledWith(false, expect.stringMatching(/超时|timed out/));
		request.accept({ type: "code_activity", requestId: 1, view });
		expect(update).not.toHaveBeenCalledWith(view);
	});

	it("ignores out-of-order replies after switching filters or projects", () => {
		const { request, state, update, send } = setup();
		request.load(query, send);
		request.load({ ...query, projectId: "p2", filter: "reproducing" }, send);
		request.accept({ type: "code_activity", requestId: 1, view });
		request.accept({ type: "code_activity_error", requestId: 1, error: "old failure" });
		expect(state).toHaveBeenLastCalledWith(true, null);
		expect(update).not.toHaveBeenCalledWith(view);
		request.accept({ type: "code_activity", requestId: 2, view });
		expect(state).toHaveBeenLastCalledWith(false, null);
	});

	it("refreshes loaded data without masking the table and retains it on failure", () => {
		const { request, state, update, send } = setup();
		request.load(query, send);
		request.accept({ type: "code_activity", requestId: 1, view });
		update.mockClear();
		request.load(query, send, true);
		expect(state).toHaveBeenLastCalledWith(false, null);
		request.accept({ type: "code_activity_error", requestId: 2, error: "failed" });
		expect(update).not.toHaveBeenCalled();
		expect(state).toHaveBeenLastCalledWith(false, "failed");
	});

	it("releases loading on disconnect or send failure and discards stale responses", () => {
		const { request, state, update, send } = setup();
		request.load(query, send);
		request.disconnect();
		expect(state).toHaveBeenLastCalledWith(false, expect.any(String));
		request.accept({ type: "code_activity", requestId: 1, view });
		expect(update).not.toHaveBeenCalledWith(view);
		request.load(query, () => { throw new Error("offline"); });
		expect(state).toHaveBeenLastCalledWith(false, "offline");
		request.load(query, send);
		request.accept({ type: "code_activity", requestId: 3, view });
		expect(update).toHaveBeenLastCalledWith(view);
		request.load(query, send);
		request.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
});
