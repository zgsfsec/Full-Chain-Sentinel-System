import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CredentialStore } from "../src/credential-store.ts";
import { createCredentialTools, SessionCredentialAccess } from "../src/credential-tool.ts";
import { parseCredential } from "../src/credential-types.ts";
import { readSessionCredentials, SESSION_CREDENTIALS_CUSTOM_TYPE } from "../src/session-credentials.ts";

let dir: string, store: CredentialStore, access: SessionCredentialAccess, enabled: boolean;
const input = () => parseCredential({ type: "Linux", host: "192.0.2.10", password: "secret" });
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "credential-tools-"));
	store = new CredentialStore(dir);
	enabled = true;
	access = new SessionCredentialAccess({
		enabled: () => enabled,
		projectId: "one",
		sessionId: () => "session-one",
		store: () => store,
	});
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

test("disabled tools refuse calls even if recovered via tool search", async () => {
	enabled = false;
	for (const tool of createCredentialTools(access)) {
		const result = await tool.execute(
			"bypass",
			{ id: "x", purpose: "use", input: input(), revision: "v", success: true, method: "m", summary: "s" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("启用凭据中心");
	}
	expect(store.list("one")).toHaveLength(0);
});

test("enabled sessions may verify any project credential without selection; ordinary use still requires success", () => {
	const one = store.save("one", [input()])[0],
		two = store.save("two", [input()])[0];
	expect(() => access.read(one.id, "use")).toThrow("尚不可用");
	expect(access.read(one.id, "verify")).toMatchObject({ password: "secret" });
	expect(() => access.read(two.id, "verify")).toThrow("不存在");
	expect(() => access.read(two.id, "use")).toThrow("不存在");
	access.report(one.id, one.revision, true, "SSH auth", "accepted");
	expect(access.read(one.id, "use")).toMatchObject({ password: "secret" });
	expect(JSON.stringify(access.list("", 0, 50))).not.toContain('"password"');
});

test("results require reading the current version, are one-shot, and record the originating session", () => {
	const one = store.save("one", [input()])[0];
	expect(() => access.report(one.id, one.revision, true, "SSH auth", "accepted")).toThrow("请先读取");
	access.read(one.id, "verify");
	expect(access.report(one.id, one.revision, true, "SSH auth", "accepted")).toMatchObject({
		status: "usable",
		validations: [{ sessionId: "session-one", revision: one.revision, source: "agent" }],
	});
	expect(() => access.report(one.id, one.revision, false, "SSH auth", "rejected")).toThrow();
});

test("failed credentials can be reverified directly while enabled", () => {
	const one = store.save("one", [input()])[0];
	access.read(one.id, "verify");
	access.report(one.id, one.revision, false, "SSH auth", "rejected");
	expect(() => access.read(one.id, "use")).toThrow("尚不可用");
	access.read(one.id, "verify");
	access.report(one.id, one.revision, true, "SSH auth", "accepted");
	expect(store.get("one", one.id).status).toBe("usable");
});

test("stale reports cannot undo manual confirmation or authenticate edited credentials", () => {
	const one = store.save("one", [input()])[0];
	access.read(one.id, "verify");
	store.confirm("one", [one]);
	expect(() => access.report(one.id, one.revision, false, "auth", "rejected")).toThrow("已变化");
	access.read(one.id, "verify");
	store.save("one", [{ ...input(), password: "changed" }], one.id);
	expect(() => access.report(one.id, one.revision, true, "auth", "accepted")).toThrow("已变化");
	expect(store.get("one", one.id).status).toBe("unverified");
});

test("each enabled session can verify directly but must perform its own read before reporting", () => {
	const one = store.save("one", [input()])[0];
	access.read(one.id, "verify");
	const other = new SessionCredentialAccess({
		enabled: () => true,
		projectId: "one",
		sessionId: () => "session-two",
		store: () => store,
	});
	expect(() => other.report(one.id, one.revision, true, "auth", "accepted")).toThrow("请先读取");
	expect(other.read(one.id, "verify")).toMatchObject({ password: "secret" });
	enabled = false;
	expect(() => access.read(one.id, "verify")).toThrow("启用凭据中心");
	expect(() => access.report(one.id, one.revision, true, "auth", "accepted")).toThrow("启用凭据中心");
	access.clear();
	enabled = true;
	expect(() => access.report(one.id, one.revision, true, "auth", "accepted")).toThrow("请先读取");
	expect(access.read(one.id, "verify")).toMatchObject({ password: "secret" });
});

test("Agent can save discovered credentials and patch records without exposing secrets or setting status", () => {
	const created = access.save(input()) as { id: string; revision: string; status: string };
	expect(created.status).toBe("unverified");
	expect(created).not.toHaveProperty("password");
	store.confirm("one", [created]);
	access.save({ notes: "a note" }, created.id, created.revision);
	expect(store.get("one", created.id).status).toBe("usable");
	expect(() => access.save({ password: "new" }, created.id)).toThrow("revision");
	access.save({ password: "new" }, created.id, created.revision);
	expect(store.get("one", created.id)).toMatchObject({ password: "new", status: "unverified" });
	expect(() => access.save({ notes: "stale" }, created.id, created.revision)).toThrow("已修改");
});

test("conversation switch persists independently, defaults off and handles cleared/malformed entries", () => {
	const entry = (data: unknown) => ({ type: "custom", customType: SESSION_CREDENTIALS_CUSTOM_TYPE, data });
	expect(readSessionCredentials([])).toBe(false);
	expect(
		readSessionCredentials([
			entry({ enabled: true }),
			{ type: "custom", customType: "zg-ios", data: { enabled: false } },
		]),
	).toBe(true);
	expect(readSessionCredentials([entry({ enabled: true }), entry({ enabled: "bad" })])).toBe(true);
	expect(readSessionCredentials([entry({ enabled: true }), entry(null)])).toBe(false);
});
