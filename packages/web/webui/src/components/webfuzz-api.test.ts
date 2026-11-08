import { afterEach, expect, test, vi } from "vitest";
import { webFuzzApi } from "./webfuzz-api.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test.each(["/webfuzz", "/webfuzz/workspace"])("%s times out and releases a stalled request", async (path) => {
	vi.useFakeTimers();
	let signal: AbortSignal | undefined;
	vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
		signal = init?.signal ?? undefined;
		signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
	})));
	const task = webFuzzApi(path, "p", path.endsWith("workspace") ? { tabs: [], activeId: null } : undefined);
	const failure = expect(task).rejects.toThrow("请求超时");
	await vi.advanceTimersByTimeAsync(10000);
	await failure;
	expect(signal?.aborted).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

test("the timeout also covers a stalled JSON body after headers arrived", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (_input, init) => new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"tabs":'));
			init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
		},
	}))));
	const task = webFuzzApi("/webfuzz", "p");
	const failure = expect(task).rejects.toThrow("请求超时");
	await vi.advanceTimersByTimeAsync(10000);
	await failure;
	expect(vi.getTimerCount()).toBe(0);
});

test.each(["/webfuzz", "/webfuzz/send"])("%s retains caller cancellation without reporting a timeout", async (path) => {
	vi.useFakeTimers();
	const controller = new AbortController();
	let requestSignal: AbortSignal | undefined;
	vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
		requestSignal = init?.signal ?? undefined;
		if (requestSignal?.aborted) reject(requestSignal.reason);
		else requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
	})));
	const task = webFuzzApi(path, "p", undefined, controller.signal);
	const failure = expect(task).rejects.toMatchObject({ name: "AbortError" });
	if (path.endsWith("send")) {
		await vi.advanceTimersByTimeAsync(120000);
		expect(requestSignal?.aborted).toBe(false);
	}
	controller.abort();
	await failure;
	expect(requestSignal?.aborted).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

test("successful reads and project errors clear their timers", async () => {
	vi.useFakeTimers();
	const fetcher = vi.fn<typeof fetch>()
		.mockResolvedValueOnce(Response.json({ tabs: [], activeId: null, history: [] }))
		.mockResolvedValueOnce(Response.json({ error: "当前项目已变更，请刷新页面。" }, { status: 409 }));
	vi.stubGlobal("fetch", fetcher);
	expect(await webFuzzApi("/webfuzz", "a b")).toMatchObject({ tabs: [] });
	expect(fetcher.mock.calls[0][0]).toBe("/api/mitm/webfuzz?projectId=a%20b");
	await expect(webFuzzApi("/webfuzz/workspace", "p", { tabs: [] })).rejects.toThrow("当前项目已变更");
	expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ projectId: "p", tabs: [] });
	expect(vi.getTimerCount()).toBe(0);
});
