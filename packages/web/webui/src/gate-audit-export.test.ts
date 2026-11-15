import { afterEach, expect, test, vi } from "vitest";
import { downloadGateAudit } from "./gate-audit-export.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test("downloads all current filters with the response filename and releases the object URL", async () => {
	vi.useFakeTimers();
	const filter = {
		approval: ["auto", "human"] as const, projectId: "p1", sessionId: "s1", source: "子代理",
		decision: "block" as const, since: 2000, search: "a%_\\&中文",
	};
	const fetchMock = vi.fn().mockResolvedValue(new Response("csv", {
		headers: { "content-disposition": 'attachment; filename="approvals-2026.csv"' },
	}));
	vi.stubGlobal("fetch", fetchMock);
	const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
	const appendChild = vi.fn();
	vi.stubGlobal("document", { createElement: vi.fn(() => anchor), body: { appendChild } });
	const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export");
	const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	await downloadGateAudit({ ...filter, approval: [...filter.approval] });
	const requested = new URL(fetchMock.mock.calls[0][0] as string, "http://localhost");
	expect(requested.pathname).toBe("/api/gate-audit/export");
	expect(JSON.parse(requested.searchParams.get("filter") ?? "")).toEqual(filter);
	expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
	expect(anchor.download).toBe("approvals-2026.csv");
	expect(anchor.href).toBe("blob:export");
	expect(appendChild).toHaveBeenCalledWith(anchor);
	expect(anchor.click).toHaveBeenCalledOnce();
	expect(anchor.remove).toHaveBeenCalledOnce();
	expect(revoke).not.toHaveBeenCalled();
	vi.advanceTimersByTime(1000);
	expect(revoke).toHaveBeenCalledWith("blob:export");
});

test("reports server failures without starting a download", async () => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "导出失败，请重试。" }), { status: 500 })));
	const createUrl = vi.spyOn(URL, "createObjectURL");
	await expect(downloadGateAudit({})).rejects.toThrow("导出失败，请重试。");
	expect(createUrl).not.toHaveBeenCalled();
});

test("reports non-JSON errors and network failures", async () => {
	const fetchMock = vi.fn().mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
		.mockRejectedValueOnce(new Error("Network unavailable"));
	vi.stubGlobal("fetch", fetchMock);
	await expect(downloadGateAudit({})).rejects.toThrow("导出失败，请重试。");
	await expect(downloadGateAudit({})).rejects.toThrow("Network unavailable");
});
