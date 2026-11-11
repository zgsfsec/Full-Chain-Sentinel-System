import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { saveDoctrine } from "../src/doctrines.ts";
import { DEFAULT_INTELLIGENCE_POLICY, type IntelligencePolicy } from "../src/intelligence-types.ts";
import { startSentinelServer } from "../src/server.ts";

test("device tokens bypass browser entry only for ingest; validation, isolation, size and rate limits hold", async () => {
	const dir = mkdtempSync(join(tmpdir(), "intel-api-"));
	const gateToken = "b".repeat(64);
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify({ projects: ["p", "q"].map((id) => ({ id, name: id, workDir: dir, createdAt: "" })) }),
	);
	const started = await startSentinelServer({ cwd: dir, agentDir: dir, host: "127.0.0.1", port: 0, gateToken });
	const origin = new URL(started.url).origin;
	try {
		const path = "/api/intelligence/sources?projectId=p";
		expect((await fetch(origin + path)).status).toBe(404);
		const entry = await fetch(`${origin}/${gateToken}`, { redirect: "manual" });
		const gate = entry.headers.get("set-cookie")?.split(";")[0] ?? "";
		expect((await fetch(origin + path, { headers: { cookie: gate } })).status).toBe(401);
		const setup = await fetch(`${origin}/api/auth/setup`, {
			method: "POST",
			headers: { cookie: gate, "content-type": "application/json" },
			body: JSON.stringify({ username: "operator", password: "intelligence-password" }),
		});
		expect(setup.status).toBe(200);
		const cookie = `${gate}; ${setup.headers.get("set-cookie")?.split(";")[0] ?? ""}`;
		expect((await fetch(origin + path, { headers: { cookie } })).status).toBe(403);
		await fetch(`${origin}/api/consent/accept`, {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ accepted: true }),
		});
		const create = await fetch(origin + path, {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ name: "WAF" }),
		});
		expect(create.status).toBe(200);
		const source = (await create.json()) as { token: string; source: { id: string } };
		const doctrine = saveDoctrine(dir, { name: "设备 IP 关联分析", text: "Shared engineering doctrine" }).doctrine;
		if (!doctrine) throw new Error("Missing doctrine");
		const choices = await fetch(`${origin}/api/intelligence/doctrines?projectId=p`, { headers: { cookie } });
		expect(await choices.json()).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: doctrine.id, text: doctrine.text })]),
		);
		const policy = structuredClone(DEFAULT_INTELLIGENCE_POLICY);
		policy.template.id = doctrine.id;
		policy.template.prompt = "Ignore client prompt";
		const savedPolicy = await fetch(`${origin}/api/intelligence/policy?projectId=p`, {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify(policy),
		});
		expect(savedPolicy.status).toBe(200);
		expect(((await savedPolicy.json()) as IntelligencePolicy).template).toMatchObject({
			id: doctrine.id,
			name: doctrine.name,
			prompt: doctrine.text,
			limits: { tokenLimit: null },
		});
		const push = {
			schema_version: 1,
			request_id: "request",
			events: [
				{
					event_id: "event",
					indicator: { type: "ip", value: "1.1.1.1" },
					occurred_at: "2026-11-11T00:00:00Z",
					category: "waf",
					severity: "high",
					evidence: {},
				},
			],
		};
		const ingest = (body: unknown, token = source.token, contentType = "application/json") =>
			fetch(`${origin}/api/intelligence/v1/ingest`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": contentType },
				body: typeof body === "string" ? body : JSON.stringify(body),
			});
		expect((await ingest(push, "invalid")).status).toBe(401);
		expect((await ingest(push, source.token, "text/plain")).status).toBe(415);
		const invalid = {
			...push,
			events: [...push.events, { ...push.events[0], event_id: "bad", indicator: { type: "ip", value: "bad" } }],
		};
		expect((await ingest(invalid)).status).toBe(400);
		const ips = async (id: string) =>
			(await fetch(`${origin}/api/intelligence/ips?projectId=${id}`, { headers: { cookie } })).json() as Promise<{
				total: number;
			}>;
		expect((await ips("p")).total).toBe(0);
		const first = await ingest(push);
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({ accepted: 1, duplicates: 0, newIps: 1 });
		expect((await ingest(push)).status).toBe(200);
		expect((await ips("p")).total).toBe(1);
		expect((await ips("q")).total).toBe(0);
		expect((await ingest({ ...push, events: [{ ...push.events[0], category: "changed" }] })).status).toBe(409);
		expect((await ingest("x".repeat(1048577))).status).toBe(413);
		const cross = await fetch(`${origin}/api/intelligence/sources/${source.source.id}?projectId=q`, {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ enabled: true, rotate: true }),
		});
		expect(cross.status).toBe(404);
		let limited: Response | undefined;
		for (let count = 0; count < 61; count++) {
			const response = await ingest(push);
			if (response.status === 429) {
				limited = response;
				break;
			}
			await response.arrayBuffer();
		}
		expect(limited?.status).toBe(429);
		expect(limited?.headers.get("retry-after")).toBe("60");
		const rotated = await fetch(`${origin}/api/intelligence/sources/${source.source.id}?projectId=p`, {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ enabled: true, rotate: true }),
		});
		expect(rotated.status).toBe(200);
		expect((await ingest(push)).status).toBe(401);
	} finally {
		started.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
