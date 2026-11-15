import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { parseCredentialImport } from "../src/credential-import.ts";
import { CredentialStore } from "../src/credential-store.ts";
import { CREDENTIAL_TYPES, credentialView, parseCredential } from "../src/credential-types.ts";
import { openSqliteDatabase } from "../src/sqlite.ts";

let dir: string;
let store: CredentialStore | undefined;
const input = () =>
	parseCredential({
		type: "PostgreSQL",
		host: "db.example",
		port: 5432,
		username: "operator",
		password: "secret-never-store-plaintext",
		database: "app",
		fields: [
			{ key: "apiKey", value: "secret-api-key", sensitive: true },
			{ key: "sslmode", value: "require", sensitive: false },
		],
	});
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-credentials-"));
	store = new CredentialStore(dir);
});
afterEach(() => {
	store?.close();
	rmSync(dir, { recursive: true, force: true });
});

test("encrypts complete records, redacts every secret, persists and isolates projects", () => {
	const saved = store!.save("one", [
		{ ...input(), privateKey: "key-secret", passphrase: "phrase-secret", token: "token-secret" },
	])[0];
	expect(saved).toMatchObject({ status: "unverified", hasPassword: true, hasToken: true });
	for (const secret of [input().password, "key-secret", "phrase-secret", "token-secret", "secret-api-key"])
		expect(JSON.stringify(saved)).not.toContain(secret);
	expect(saved.fields).toContainEqual({ key: "sslmode", value: "require", sensitive: false });
	expect(saved).not.toHaveProperty("validationToken");
	expect(store!.list("two")).toEqual([]);
	expect(() => store!.get("two", saved.id)).toThrow("不存在");
	store!.remove("two", [saved.id]);
	expect(store!.get("one", saved.id).password).toBe(input().password);
	const bytes = readFileSync(join(dir, "credentials.db"));
	for (const value of [input().password, "db.example", "secret-api-key"])
		expect(bytes.includes(Buffer.from(value))).toBe(false);
	if (process.platform !== "win32") expect(statSync(join(dir, "credentials.key")).mode & 0o777).toBe(0o600);
	store!.close();
	store = new CredentialStore(dir);
	expect(store.get("one", saved.id).fields[0].value).toBe("secret-api-key");
});

test("deduplicates by type, target, port, account, database and instance; blank secrets survive", () => {
	const saved = store!.save("one", [input()])[0];
	store!.confirm("one", [saved]);
	const next = store!.save("one", [
		{
			...input(),
			name: "Renamed",
			notes: "Updated note",
			password: "",
			fields: [
				{ key: "apiKey", value: "", sensitive: true },
				{ key: "sslmode", value: "require", sensitive: false },
			],
		},
	])[0];
	expect(next).toMatchObject({ id: saved.id, revision: saved.revision, status: "usable" });
	expect(store!.get("one", next.id).password).toBe(input().password);
	expect(store!.get("one", next.id).fields[0].value).toBe("secret-api-key");
	store!.save("one", [
		{ ...input(), database: "other" },
		{ ...input(), instance: "instance-two" },
	]);
	expect(store!.list("one")).toHaveLength(3);
	expect(() => store!.save("one", [input(), input()])).toThrow("重复");
	const withoutFields = parseCredential({
		type: "PostgreSQL",
		host: "db.example",
		port: 5432,
		username: "operator",
		database: "app",
		password: "",
	});
	store!.save("one", [withoutFields]);
	expect(store!.get("one", saved.id).fields).toHaveLength(2);
});

test.each(["host", "username", "password", "token", "database", "instance", "domain", "privateKey"] as const)(
	"changing %s invalidates status and preserves historical validation",
	(field) => {
		const saved = store!.save("one", [input()])[0];
		store!.confirm("one", [saved]);
		const next = store!.save("one", [{ ...input(), [field]: "replacement" }], saved.id, saved.revision)[0];
		expect(next.status).toBe("unverified");
		expect(next.revision).not.toBe(saved.revision);
		expect(next.validations[0]).toMatchObject({ source: "user", method: "用户确认", revision: saved.revision });
	},
);

test("rejects stale Agent results after edits, manual confirmation and deletion", () => {
	const saved = store!.save("one", [input()])[0];
	const original = store!.get("one", saved.id);
	store!.confirm("one", [saved]);
	const report = {
		status: "failed" as const,
		source: "agent" as const,
		method: "driver authentication",
		summary: "failed",
		sessionId: "session",
	};
	expect(() => store!.validate("one", saved.id, original.revision, original.validationToken, report)).toThrow(
		"已变化",
	);
	const current = store!.get("one", saved.id);
	store!.save("one", [{ ...input(), password: "new" }], saved.id);
	expect(() => store!.validate("one", saved.id, current.revision, current.validationToken, report)).toThrow("已变化");
	store!.remove("one", [saved.id]);
	expect(() => store!.validate("one", saved.id, current.revision, current.validationToken, report)).toThrow("不存在");
	expect(store!.list("one")).toEqual([]);
});

test("records concise version-bound results, redacts known secrets and rejects empty conclusions", () => {
	const saved = store!.save("one", [input()])[0],
		record = store!.get("one", saved.id);
	const report = {
		status: "usable" as const,
		source: "agent" as const,
		method: "PostgreSQL auth",
		summary: `ok ${record.password} secret-api-key`,
		sessionId: "session-one",
	};
	expect(() =>
		store!.validate("one", record.id, record.revision, record.validationToken, { ...report, summary: " " }),
	).toThrow("简短结论");
	const validated = store!.validate("one", record.id, record.revision, record.validationToken, report);
	expect(validated.validations[0]).toMatchObject({
		revision: saved.revision,
		sessionId: "session-one",
		source: "agent",
		summary: "ok [已隐藏] [已隐藏]",
	});
	expect(JSON.stringify(credentialView(store!.get("one", saved.id)))).not.toContain(record.password);
});

test("checks a whole selection before confirmation, and rejects duplicate identities before save", () => {
	const saved = store!.save("one", [input()])[0];
	expect(() => store!.confirm("one", [saved, { id: "missing", revision: "missing" }])).toThrow();
	expect(store!.get("one", saved.id).status).toBe("unverified");
	expect(() => store!.save("one", [{ ...input(), name: "Must not apply" }, input()])).toThrow();
	expect(store!.get("one", saved.id).name).toBe("db.example");
});

test("authenticates project binding and refuses missing encryption keys", () => {
	const saved = store!.save("one", [input()])[0];
	const db = openSqliteDatabase(join(dir, "credentials.db"));
	db.prepare("UPDATE credentials SET project = ? WHERE id = ?").run("two", saved.id);
	db.close();
	expect(() => store!.list("two")).toThrow("解密失败");
	store!.close();
	store = undefined;
	unlinkSync(join(dir, "credentials.key"));
	expect(() => new CredentialStore(dir)).toThrow("密钥缺失");
});

test("imports quoted multiline keys, JSON custom fields, custom types and separate database identities", () => {
	const text =
		'\uFEFFtype,host,username,privateKey,fields\r\nLinux,[2001:db8::1],user,"-----BEGIN KEY-----\nline,""quoted""\n-----END KEY-----","[{""key"":""api"",""value"":""secret"",""sensitive"":true}]"\r\n';
	const [row] = parseCredentialImport("csv", text);
	expect(row.privateKey).toContain('line,"quoted"');
	expect(row.fields).toEqual([{ key: "api", value: "secret", sensitive: true }]);
	expect(parseCredential({ type: "内部设备", group: "其他", host: "https://service.example" }).type).toBe("内部设备");
	expect(CREDENTIAL_TYPES.filter((entry) => entry.group === "数据库").length).toBeGreaterThanOrEqual(30);
	expect(parseCredentialImport("json", JSON.stringify([input(), { ...input(), database: "two" }]))).toHaveLength(2);
});

test.each([
	["csv", 'type,host\nLinux,"unclosed'],
	["csv", "type,host\nLinux,example,extra"],
	["json", JSON.stringify([input(), input()])],
	["json", JSON.stringify([{ ...input(), port: 65536 }])],
	["json", JSON.stringify([{ ...input(), group: "其他" }])],
	["json", JSON.stringify([{ ...input(), evidence: "unsupported" }])],
	["json", JSON.stringify([{ ...input(), fields: [{ key: "x", value: "v", sensitive: "true" }] }])],
	["json", JSON.stringify([{ ...input(), fields: null }])],
	["json", JSON.stringify([{ ...input(), fields: false }])],
	["json", "[]"],
])("rejects malformed whole batches (%s)", (format, content) => {
	expect(() => parseCredentialImport(format, content)).toThrow();
});

test.each(["ssh", "winrm"] as const)(
	"migrates existing %s records without exposing secrets or inheriting connection-test trust",
	(protocol) => {
		const id = "legacy-credential";
		const legacy = {
			id,
			projectId: "one",
			name: "Existing host",
			protocol,
			host: "192.0.2.20",
			port: protocol === "ssh" ? 22 : 5986,
			username: "DOMAIN\\operator",
			auth: "password",
			password: "legacy-password",
			privateKey: "legacy-private-key",
			passphrase: "legacy-passphrase",
			tls: true,
			insecure: true,
			fingerprint: "SHA256:original",
			revision: "old-revision",
			updatedAt: "2026-11-15T00:00:00.000Z",
			lastTest: { status: "success", message: "old connection output", at: "2026-11-15T00:00:00.000Z" },
		};
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", readFileSync(join(dir, "credentials.key")), iv);
		cipher.setAAD(Buffer.from(`one:${id}`));
		const encrypted = Buffer.concat([cipher.update(JSON.stringify(legacy)), cipher.final()]);
		const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
		const db = openSqliteDatabase(join(dir, "credentials.db"));
		db.prepare("INSERT INTO credentials(id, project, payload) VALUES (?, ?, ?)").run(id, "one", payload);
		db.close();
		// Previously, listing this record threw at record.fields.map().
		const [view] = store!.list("one").map(credentialView);
		expect(view).toMatchObject({
			id,
			projectId: "one",
			type: protocol === "winrm" ? "Windows" : "SSH 主机",
			group: "操作系统",
			status: "unverified",
			validations: [],
			updatedAt: legacy.updatedAt,
		});
		expect(view.revision).not.toBe(legacy.revision);
		expect(view.fields).toContainEqual({ key: "protocol", value: protocol, sensitive: false });
		expect(view.fields).toContainEqual({ key: "fingerprint", value: legacy.fingerprint, sensitive: false });
		if (protocol === "winrm") {
			expect(view.fields).toContainEqual({ key: "tls", value: "true", sensitive: false });
			expect(view.fields).toContainEqual({ key: "insecure", value: "true", sensitive: false });
		}
		const raw = store!.get("one", id);
		expect(raw).toMatchObject({
			password: legacy.password,
			privateKey: legacy.privateKey,
			passphrase: legacy.passphrase,
			username: legacy.username,
			port: legacy.port,
		});
		for (const secret of [legacy.password, legacy.privateKey, legacy.passphrase, legacy.lastTest.message])
			expect(JSON.stringify(view)).not.toContain(secret);
		expect(store!.list("two")).toEqual([]);
		store!.close();
		store = new CredentialStore(dir);
		expect(store.get("one", id)).toEqual(raw);
		store.confirm("one", [view]);
		const updated = store.save(
			"one",
			[parseCredential({ ...input(), host: legacy.host, type: view.type, group: view.group, fields: undefined })],
			id,
			view.revision,
		)[0];
		expect(updated.status).toBe("unverified");
		expect(store.get("one", id).fields).toEqual(raw.fields);
	},
);
