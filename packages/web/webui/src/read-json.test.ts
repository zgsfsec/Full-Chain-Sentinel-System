import { afterEach, expect, test, vi } from "vitest";
import { readJson } from "./read-json.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test.each(["/api/reports/r1", "/api/mitm/flows/f1"])("%s times out stalled headers and aborts the request", async (url) => {
	vi.useFakeTimers();
	let signal: AbortSignal | undefined;
	vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
		signal = init?.signal ?? undefined;
		signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
	})));
	const failure = expect(readJson(url)).rejects.toThrow("请求超时");
	await vi.advanceTimersByTimeAsync(10000);
	await failure;
	expect(signal?.aborted).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

test("the deadline includes a stalled body after headers arrive", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (_input, init) => new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"title":'));
			init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
		},
	}))));
	const failure = expect(readJson("/api/reports/r1")).rejects.toThrow("请求超时");
	await vi.advanceTimersByTimeAsync(10000);
	await failure;
	expect(vi.getTimerCount()).toBe(0);
});

test("closing a reader retains caller cancellation and removes the deadline", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
	})));
	const controller = new AbortController();
	const failure = expect(readJson("/api/reports/r1", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
	controller.abort();
	await failure;
	expect(vi.getTimerCount()).toBe(0);
});

test("success, server errors and non-JSON errors clear their deadlines", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("fetch", vi.fn<typeof fetch>()
		.mockResolvedValueOnce(Response.json({ title: "report" }))
		.mockResolvedValueOnce(Response.json({ error: "记录不存在" }, { status: 404 }))
		.mockResolvedValueOnce(new Response("Bad gateway", { status: 502 })));
	expect(await readJson("/api/reports/r1")).toEqual({ title: "report" });
	await expect(readJson("/api/reports/r1")).rejects.toThrow("记录不存在");
	await expect(readJson("/api/reports/r1")).rejects.toThrow("502");
	expect(vi.getTimerCount()).toBe(0);
});
