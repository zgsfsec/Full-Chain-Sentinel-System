import { afterEach, describe, expect, test, vi } from "vitest";
import { workGraph } from "../../test/work-process-fixtures.ts";
import { ensureWorkLinkEnabled } from "./work-link-client.ts";

afterEach(() => vi.unstubAllGlobals());
const target = { projectId: "p1", kind: "session" as const, id: "s1" };

describe("opening conversation work links", () => {
	test.each([false, true])("enables an inactive conversation, including fresh=%s, before showing its links", async (fresh) => {
		const process = workGraph();
		if (fresh) { process.evidence = []; process.pending = 0; }
		const requests = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ process: init?.method === "POST" ? { ...process, enabled: true } : process }));
		vi.stubGlobal("fetch", requests);
		const result = await ensureWorkLinkEnabled(target, new AbortController().signal);
		expect(result.enabled).toBe(true);
		expect(requests).toHaveBeenCalledTimes(2);
		const [url, options] = requests.mock.calls[1];
		expect(url).toBe("/api/work-processes/control?projectId=p1&kind=session&id=s1");
		expect(options?.method).toBe("POST");
		expect(JSON.parse(options?.body as string)).toEqual({ action: "enable" });
	});

	test("reopening a running recording does not cancel or restart analysis", async () => {
		const process = { ...workGraph(), enabled: true, running: true };
		const requests = vi.fn(async () => Response.json({ process }));
		vi.stubGlobal("fetch", requests);
		expect(await ensureWorkLinkEnabled(target, new AbortController().signal)).toEqual(process);
		expect(requests).toHaveBeenCalledTimes(1);
	});

	test("opening a scheduled retry preserves its backoff and does not restart it", async () => {
		const process = { ...workGraph(), enabled: true, error: "network failed", retry: { attempt: 2, at: Date.now() + 6000, once: false } };
		const requests = vi.fn(async () => Response.json({ process }));
		vi.stubGlobal("fetch", requests);
		expect((await ensureWorkLinkEnabled(target, new AbortController().signal)).retry).toEqual(process.retry);
		expect(requests).toHaveBeenCalledTimes(1);
	});

	test("an errored recording is explicitly re-enabled", async () => {
		const process = { ...workGraph(), enabled: true, error: "provider error" };
		const requests = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ process: init?.method ? { ...process, error: null } : process }));
		vi.stubGlobal("fetch", requests);
		expect((await ensureWorkLinkEnabled(target, new AbortController().signal)).error).toBeNull();
		expect(requests).toHaveBeenCalledTimes(2);
	});

	test("failed activation remains an error instead of claiming recording is enabled", async () => {
		vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method ? Response.json({ error: "对话不存在" }, { status: 404 }) : Response.json({ process: workGraph() })));
		await expect(ensureWorkLinkEnabled(target, new AbortController().signal)).rejects.toThrow("对话不存在");
	});

	test("switching away during a read cannot enable the previous conversation on a late reply", async () => {
		const controller = new AbortController();
		const requests = vi.fn(async () => { controller.abort(); return Response.json({ process: workGraph() }); });
		vi.stubGlobal("fetch", requests);
		await expect(ensureWorkLinkEnabled(target, controller.signal)).rejects.toThrow();
		expect(requests).toHaveBeenCalledTimes(1);
	});
});
