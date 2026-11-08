import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SentinelVulnerability } from "./types.ts";
import { VulnDetailRequest } from "./vuln-detail-request.ts";

const vuln: SentinelVulnerability = {
	id: "v1", label: "0001", number: 1, projectId: "p1", projectName: "项目",
	title: "未授权访问", source: "主代理", severity: "high", cvss: 7.5, status: "pending", target: "127.0.0.1",
	description: "描述", packet: "GET / HTTP/1.1", evidence: [], notes: [],
	createdAt: "2026-01-01", updatedAt: "2026-01-01", severityMismatch: false, review: { state: "skipped", at: 0 },
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("opens a loading drawer before sending and replaces it with the requested detail", () => {
	const update = vi.fn();
	const request = new VulnDetailRequest(update);
	request.open("p1", "v1", (message) => {
		expect(update).toHaveBeenLastCalledWith({ id: "v1", projectId: "p1", vuln: null, loading: true, error: null });
		expect(message).toEqual({ type: "get_vuln", id: "v1" });
	});
	expect(request.accept(vuln)).toBe(true);
	expect(update).toHaveBeenLastCalledWith({ id: "v1", projectId: "p1", vuln, loading: false, error: null });
	expect(vi.getTimerCount()).toBe(0);
});

test("ignores another selection or project's reply while accepting reviews of the open finding", () => {
	const update = vi.fn();
	const request = new VulnDetailRequest(update);
	request.open("p1", "v1", () => {});
	request.open("p1", "v2", () => {});
	update.mockClear();
	expect(request.accept(vuln)).toBe(false);
	expect(request.accept({ ...vuln, id: "v2", projectId: "p2" })).toBe(false);
	expect(update).not.toHaveBeenCalled();
	expect(request.accept({ ...vuln, id: "v2" })).toBe(true);
	const reviewed = { ...vuln, id: "v2", status: "confirmed" as const };
	expect(request.accept(reviewed)).toBe(true);
	expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ vuln: reviewed }));
	expect(vi.getTimerCount()).toBe(0);
});

test("times out with a retryable error and ignores replies until the operator retries", () => {
	const update = vi.fn();
	const request = new VulnDetailRequest(update);
	request.open("p1", "v1", () => {});
	vi.advanceTimersByTime(10_000);
	expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ loading: false, error: expect.stringContaining("超时") }));
	expect(request.accept(vuln)).toBe(false);
	request.open("p1", "v1", () => {});
	expect(request.accept(vuln)).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

test("closing or disposing cancels the timer and a late reply cannot reopen the drawer", () => {
	const update = vi.fn();
	const request = new VulnDetailRequest(update);
	request.open("p1", "v1", () => {});
	request.close();
	expect(update).toHaveBeenLastCalledWith(null);
	update.mockClear();
	expect(request.accept(vuln)).toBe(false);
	vi.advanceTimersByTime(10_000);
	expect(update).not.toHaveBeenCalled();
	request.open("p1", "v1", () => {});
	request.dispose();
	expect(request.accept(vuln)).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
});

test("disconnects and send failures settle loading without queuing an obsolete selection", () => {
	const update = vi.fn();
	const request = new VulnDetailRequest(update);
	request.open("p1", "v1", () => {});
	request.disconnect();
	expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ loading: false, error: expect.stringContaining("断开") }));
	expect(request.accept(vuln)).toBe(false);
	request.open("p1", "v1", () => { throw new Error("offline"); });
	expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ loading: false, error: "offline" }));
	expect(vi.getTimerCount()).toBe(0);
});

test("a project switch rejects the old finding and a disconnect keeps an already loaded detail readable", () => {
	const update = vi.fn();
	const request = new VulnDetailRequest(update);
	request.open("p1", "v1", () => {});
	request.close();
	request.open("p2", "v2", () => {});
	expect(request.accept(vuln)).toBe(false);
	const current = { ...vuln, id: "v2", projectId: "p2" };
	expect(request.accept(current)).toBe(true);
	update.mockClear();
	request.disconnect();
	expect(update).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});
