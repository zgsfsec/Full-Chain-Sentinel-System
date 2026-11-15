import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CredentialInput,
	type CredentialRecord,
	type CredentialValidation,
	type CredentialView,
	credentialIdentity,
	credentialView,
	parseCredential,
} from "./credential-types.ts";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

export class CredentialStore {
	private readonly db: SqliteDatabase;
	private readonly key: Buffer;
	constructor(agentDir: string) {
		mkdirSync(agentDir, { recursive: true });
		const keyPath = join(agentDir, "credentials.key");
		const dbPath = join(agentDir, "credentials.db");
		if (!existsSync(keyPath)) {
			if (existsSync(dbPath)) throw new Error("凭据加密密钥缺失，请恢复 credentials.key 备份");
			try {
				writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
			} catch (error) {
				if (!existsSync(keyPath)) throw error;
			}
		}
		this.key = readFileSync(keyPath);
		if (this.key.length !== 32) throw new Error("凭据加密密钥损坏");
		chmodSync(keyPath, 0o600);
		this.db = openSqliteDatabase(dbPath);
		this.db.exec(
			"PRAGMA secure_delete = ON; CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, project TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS credentials_project ON credentials(project)",
		);
		chmodSync(dbPath, 0o600);
	}
	close(): void {
		this.db.close();
		this.key.fill(0);
	}
	private write(record: CredentialRecord): void {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, iv);
		cipher.setAAD(Buffer.from(`${record.projectId}:${record.id}`));
		const bytes = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final()]);
		const payload = Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
		this.db
			.prepare("INSERT OR REPLACE INTO credentials(id, project, payload) VALUES (?, ?, ?)")
			.run(record.id, record.projectId, payload);
	}
	list(projectId: string): CredentialRecord[] {
		return this.db
			.prepare("SELECT id, payload FROM credentials WHERE project = ? ORDER BY rowid DESC")
			.all(projectId)
			.map((value) => this.decode(projectId, value as { id: string; payload: string }));
	}
	private decode(projectId: string, row: { id: string; payload: string }): CredentialRecord {
		let value: unknown;
		try {
			const bytes = Buffer.from(row.payload, "base64");
			const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
			decipher.setAAD(Buffer.from(`${projectId}:${row.id}`));
			decipher.setAuthTag(bytes.subarray(12, 28));
			value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
		} catch {
			throw new Error("凭据解密失败，请检查密钥备份");
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("凭据记录格式错误");
		const record = value as Record<string, unknown>;
		if (record.id !== row.id || record.projectId !== projectId) throw new Error("凭据记录归属不匹配");
		if (record.type === undefined && (record.protocol === "ssh" || record.protocol === "winrm")) {
			// The previous connection center already stored encrypted credentials.
			// Convert their schema without treating a connection test as Agent verification.
			const windows = record.protocol === "winrm";
			const input = parseCredential({
				name: record.name,
				group: "操作系统",
				type: windows ? "Windows" : "SSH 主机",
				host: record.host,
				port: record.port,
				username: record.username,
				password: record.password,
				privateKey: record.privateKey,
				passphrase: record.passphrase,
				fields: [
					{ key: "protocol", value: record.protocol, sensitive: false },
					{ key: "auth", value: record.auth === "key" ? "key" : "password", sensitive: false },
					...(windows
						? [
								{ key: "tls", value: String(record.tls === true), sensitive: false },
								{ key: "insecure", value: String(record.insecure === true), sensitive: false },
							]
						: []),
					...(typeof record.fingerprint === "string"
						? [{ key: "fingerprint", value: record.fingerprint, sensitive: false }]
						: []),
				],
			});
			const migrated: CredentialRecord = {
				...input,
				fields: input.fields ?? [],
				id: row.id,
				projectId,
				revision: randomUUID(),
				validationToken: randomUUID(),
				status: "unverified",
				validations: [],
				updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
			};
			this.write(migrated);
			return migrated;
		}
		if (!Array.isArray(record.fields) || !Array.isArray(record.validations))
			throw new Error("凭据记录缺少字段或验证历史，请检查数据备份");
		return record as unknown as CredentialRecord;
	}
	find(projectId: string, id: string): CredentialRecord | undefined {
		const row = this.db
			.prepare("SELECT id, payload FROM credentials WHERE project = ? AND id = ?")
			.get(projectId, id) as { id: string; payload: string } | undefined;
		return row ? this.decode(projectId, row) : undefined;
	}
	get(projectId: string, id: string): CredentialRecord {
		const record = this.find(projectId, id);
		if (!record) throw new Error("凭据不存在");
		return record;
	}
	prepare(
		projectId: string,
		inputs: CredentialInput[],
		id?: string,
	): { record: CredentialRecord; action: "新增" | "更新" }[] {
		const existing = this.list(projectId);
		const identities = new Set<string>();
		return inputs.map((input) => {
			const identity = credentialIdentity(input);
			if (identities.has(identity)) throw new Error("本批存在重复记录");
			identities.add(identity);
			const old = id ? this.get(projectId, id) : existing.find((item) => credentialIdentity(item) === identity);
			if (id && existing.some((item) => item.id !== id && credentialIdentity(item) === identity))
				throw new Error("同类型、目标、端口、账号和数据库 / 实例的凭据已存在");
			const fields = (input.fields ?? old?.fields ?? []).map((field) => {
				const previous = old?.fields.find((entry) => entry.key === field.key);
				if (previous?.sensitive && !field.sensitive) throw new Error("敏感字段不能改为普通字段，请删除后重新添加");
				return { ...field, value: field.sensitive && !field.value ? (previous?.value ?? "") : field.value };
			});
			const merged = {
				...input,
				password: input.password || old?.password || "",
				privateKey: input.privateKey || old?.privateKey || "",
				passphrase: input.passphrase || old?.passphrase || "",
				token: input.token || old?.token || "",
				fields,
			};
			// Names and notes describe the record; everything else can change authentication.
			const { name: _name, notes: _notes, ...authentication } = merged;
			const previous = old
				? Object.fromEntries(Object.keys(authentication).map((key) => [key, old[key as keyof CredentialInput]]))
				: null;
			const changed = JSON.stringify(authentication) !== JSON.stringify(previous);
			return {
				action: old ? "更新" : "新增",
				record: {
					...merged,
					id: old?.id ?? randomUUID(),
					projectId,
					revision: changed ? randomUUID() : old!.revision,
					validationToken: changed ? randomUUID() : old!.validationToken,
					status: changed ? "unverified" : old!.status,
					validations: old?.validations ?? [],
					updatedAt: new Date().toISOString(),
				},
			};
		});
	}
	save(
		projectId: string,
		inputs: CredentialInput[],
		id?: string,
		expectedRevision?: string,
	): ReturnType<typeof credentialView>[] {
		if (id && expectedRevision && this.get(projectId, id).revision !== expectedRevision)
			throw new Error("凭据已修改，请刷新后重试");
		const prepared = this.prepare(projectId, inputs, id);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const { record } of prepared) this.write(record);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return prepared.map(({ record }) => credentialView(record));
	}
	validate(
		projectId: string,
		id: string,
		revision: string,
		token: string,
		input: Pick<CredentialValidation, "status" | "method" | "summary" | "source" | "sessionId">,
	): CredentialView {
		const record = this.get(projectId, id);
		if (record.revision !== revision || record.validationToken !== token)
			throw new Error("凭据或验证状态已变化，请重新发起验证");
		if (!input.method.trim() || input.method.length > 256 || !input.summary.trim() || input.summary.length > 1000)
			throw new Error("请提供验证方式（最多 256 字）和简短结论（最多 1000 字）");
		const secrets = [
			record.password,
			record.privateKey,
			record.passphrase,
			record.token,
			...record.fields.filter((field) => field.sensitive).map((field) => field.value),
		]
			.filter(Boolean)
			.sort((a, b) => b.length - a.length);
		const redact = (text: string) => secrets.reduce((value, secret) => value.replaceAll(secret, "[已隐藏]"), text);
		const validation: CredentialValidation = {
			...input,
			method: redact(input.method.trim()),
			summary: redact(input.summary.trim()),
			revision,
			at: new Date().toISOString(),
		};
		const updated = {
			...record,
			status: input.status,
			validationToken: randomUUID(),
			validations: [...record.validations, validation],
			updatedAt: validation.at,
		};
		this.write(updated);
		return credentialView(updated);
	}
	confirm(projectId: string, refs: { id: string; revision: string }[]): CredentialView[] {
		// Validate the whole selection before updating any record.
		const records = refs.map(({ id, revision }) => {
			const record = this.get(projectId, id);
			if (record.revision !== revision) throw new Error("凭据已修改，请刷新后重试");
			return record;
		});
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = records.map((record) =>
				this.validate(projectId, record.id, record.revision, record.validationToken, {
					status: "usable",
					method: "用户确认",
					summary: "用户手动标记可用",
					source: "user",
					sessionId: null,
				}),
			);
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	remove(projectId: string, ids: string[]): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const id of ids)
				this.db.prepare("DELETE FROM credentials WHERE project = ? AND id = ?").run(projectId, id);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	purgeProject(projectId: string): void {
		this.db.prepare("DELETE FROM credentials WHERE project = ?").run(projectId);
	}
}
