import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CredentialStore } from "../src/credential-store.ts";
import { type CredentialView, parseCredential } from "../src/credential-types.ts";
import { Credentials } from "../src/credentials.ts";

let dir: string, server: Server, service: Credentials, store: CredentialStore, base: string;
let authorized = true;
const input = (index = 0) => ({
	name: `Database ${index}`,
	type: "MySQL",
	host: `host-${index}.example`,
	username: "operator",
	password: "not-in-responses",
	fields: [{ key: "secret", value: "custom-secret", sensitive: true }],
});
async function request(action = "", body?: unknown, projectId = "one", origin?: string) {
	return fetch(`${base}/api/credentials${action}?projectId=${projectId}`, {
		...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
		headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
	});
}
async function list(projectId = "one"): Promise<CredentialView[]> {
	return ((await (await request("", undefined, projectId)).json()) as { items: CredentialView[] }).items;
}
async function seed(index = 0): Promise<CredentialView> {
	return ((await (await request("/save", { input: input(index) })).json()) as { items: CredentialView[] }).items[0];
}
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-credential-api-"));
	authorized = true;
	store = new CredentialStore(dir);
	service = new Credentials(
		dir,
		(id) => (["one", "two"].includes(id) ? { id } : undefined),
		() => store,
	);
	server = createServer((req, res) => {
		void service.handleApi(req, res, () => authorized);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing address");
	base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
	service.dispose();
	store.close();
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(dir, { recursive: true, force: true });
});

test("REST isolates projects, never returns secrets, and previews updates before atomic import", async () => {
	const one = await seed();
	expect(one.status).toBe("unverified");
	expect(await list("two")).toEqual([]);
	expect((await request("/confirm", { refs: [one] }, "two")).status).toBe(400);
	const content = JSON.stringify([{ ...input(), name: "Updated", password: "" }, input(1)]);
	const response = await request("/import/preview", { format: "json", content });
	expect(response.status).toBe(200);
	const text = await response.text();
	expect(text).toContain("更新");
	expect(text).toContain("新增");
	expect(text).not.toContain("not-in-responses");
	expect(text).not.toContain("custom-secret");
	expect(await list()).toHaveLength(1);
	const preview = JSON.parse(text) as { version: string };
	expect((await request("/import/apply", { format: "json", content, version: preview.version })).status).toBe(200);
	expect(await list()).toHaveLength(2);
	expect(store.get("one", one.id).password).toBe("not-in-responses");
	expect((await request("/import/apply", { format: "json", content, version: preview.version })).status).toBe(400);
});

test("invalid imports do not partially apply, and old connection endpoints are removed", async () => {
	await seed();
	expect(
		(
			await request("/import/preview", {
				format: "json",
				content: JSON.stringify([input(1), { ...input(2), port: 70000 }]),
			})
		).status,
	).toBe(400);
	expect(await list()).toHaveLength(1);
	for (const action of ["/test", "/command", "/reset-fingerprint"])
		expect((await request(action, {})).status).toBe(404);
});

test("manual confirmation is audited, and failed cleanup is tied to current records", async () => {
	const one = await seed(),
		two = await seed(1);
	expect((await request("/confirm", { refs: [one] })).status).toBe(200);
	expect((await list()).find((row) => row.id === one.id)).toMatchObject({
		status: "usable",
		validations: [{ source: "user", method: "用户确认" }],
	});
	const record = store.get("one", two.id);
	store.validate("one", record.id, record.revision, record.validationToken, {
		status: "failed",
		method: "authentication",
		summary: "rejected",
		source: "agent",
		sessionId: "s",
	});
	const failed = (await list()).filter((row) => row.status === "failed");
	expect((await request("/delete-failed", { confirm: [] })).status).toBe(400);
	expect(
		(await request("/delete-failed", { confirm: failed.map((row) => `${row.id}:${row.revision}:${row.updatedAt}`) }))
			.status,
	).toBe(200);
	expect(await list()).toHaveLength(1);
});

test("requires valid auth, project and origin; rejects stale saves and state injection", async () => {
	const one = await seed();
	expect((await request("/save", { id: one.id, revision: "stale", input: input() })).status).toBe(400);
	expect((await request("/save", { input: { ...input(), status: "usable" } })).status).toBe(400);
	expect((await request("/save", { input: input() }, "one", "https://other.example")).status).toBe(400);
	expect((await request("", undefined, "missing")).status).toBe(403);
	authorized = false;
	expect((await request()).status).toBe(403);
	expect((await request("/save", { input: input(2) })).status).toBe(403);
	expect(store.list("one")).toHaveLength(1);
	store.save("two", [parseCredential(input())]);
	service.purgeProject("one");
	expect(store.list("two")).toHaveLength(1);
});
