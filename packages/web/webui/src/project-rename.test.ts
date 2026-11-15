import { afterEach, expect, test, vi } from "vitest";
import { renameProject } from "./project-rename.ts";

afterEach(() => vi.unstubAllGlobals());

test("sends the project id and trimmed name to the save endpoint", async () => {
	const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "p1", name: "新名称" })));
	vi.stubGlobal("fetch", fetcher);
	expect(await renameProject("p1", " 新名称 ")).toBeNull();
	expect(fetcher).toHaveBeenCalledWith("/api/projects/rename", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id: "p1", name: "新名称" }),
	});
});

test("keeps the server validation message available for the dialog", async () => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "已存在同名项目" }), { status: 400 })));
	expect(await renameProject("p1", "其他项目")).toBe("已存在同名项目");
});

test("network failures and unexpected responses return a retry message", async () => {
	const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValueOnce(new Response("<html>proxy error</html>", { status: 502 }));
	vi.stubGlobal("fetch", fetcher);
	expect(await renameProject("p1", "新名称")).toContain("请重试");
	expect(await renameProject("p1", "新名称")).toContain("请重试");
});
