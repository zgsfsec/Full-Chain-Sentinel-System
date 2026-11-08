import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DetailRequest } from "./detail-request.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("opens before sending, accepts only the selected record and scope, and keeps live updates", () => {
	const update = vi.fn();
	const request = new DetailRequest<{ title: string }>(update);
	request.open("p1", "a", () => {
		expect(update).toHaveBeenLastCalledWith({ scope: "p1", id: "a", data: null, loading: true, error: null });
	});
	expect(request.accept("p2", "a", { title: "wrong project" })).toBe(false);
	expect(request.accept("p1", "b", { title: "wrong record" })).toBe(false);
	expect(request.accept("p1", "a", { title: "selected" })).toBe(true);
	request.update((data) => ({ title: `${data.title} updated` }));
	expect(request.current?.data).toEqual({ title: "selected updated" });
	expect(request.accept("p1", "a", { title: "server update" })).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

test("switching, closing and disposing reject stale replies and release timers", () => {
	const update = vi.fn();
	const request = new DetailRequest<string>(update);
	request.open("p1", "a", () => {});
	request.open("p1", "b", () => {});
	expect(request.accept("p1", "a", "late a")).toBe(false);
	request.close();
	expect(update).toHaveBeenLastCalledWith(null);
	update.mockClear();
	expect(request.accept("p1", "b", "late b")).toBe(false);
	request.retry();
	vi.advanceTimersByTime(10000);
	expect(update).not.toHaveBeenCalled();
	request.open("p1", "a", () => {});
	request.dispose();
	expect(request.accept("p1", "a", "disposed")).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
});

test("a timeout remains retryable and late replies cannot dismiss the error", () => {
	const request = new DetailRequest<string>(() => {});
	const send = vi.fn();
	request.open(null, "poc", send);
	vi.advanceTimersByTime(10000);
	expect(request.current).toMatchObject({ loading: false, error: expect.stringContaining("超时") });
	expect(request.accept(null, "poc", "late")).toBe(false);
	request.retry();
	expect(send).toHaveBeenCalledTimes(2);
	expect(request.current).toMatchObject({ loading: true, error: null });
	expect(request.accept(null, "poc", "retried")).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

test("disconnects and failed sends settle loading while loaded details remain readable", () => {
	const request = new DetailRequest<string>(() => {});
	request.open(null, "session", () => {});
	request.disconnect();
	expect(request.current).toMatchObject({ loading: false, error: expect.stringContaining("断开") });
	expect(request.accept(null, "session", "old connection")).toBe(false);
	request.open(null, "session", () => { throw new Error("offline"); });
	expect(request.current).toMatchObject({ loading: false, error: "offline" });
	request.open(null, "session", () => {});
	request.accept(null, "session", "readable");
	request.disconnect();
	expect(request.current).toMatchObject({ data: "readable", loading: false, error: null });
	expect(vi.getTimerCount()).toBe(0);
});

test("unsolicited mutation or floating supervisor replies never create a detail selection", () => {
	const update = vi.fn();
	const request = new DetailRequest<string>(update);
	expect(request.accept(null, "floating-session", "history")).toBe(false);
	request.open(null, "audit-session", () => {});
	expect(request.accept(null, "floating-session", "history")).toBe(false);
	request.close();
	update.mockClear();
	expect(request.accept(null, "audit-session", "late history")).toBe(false);
	expect(update).not.toHaveBeenCalled();
});
