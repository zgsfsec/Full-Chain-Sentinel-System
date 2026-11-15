export const CREDENTIAL_GROUPS = ["操作系统", "数据库", "网络与安全设备", "应用与服务", "其他"] as const;
export type CredentialGroup = (typeof CREDENTIAL_GROUPS)[number];
export const CREDENTIAL_TYPES: readonly { value: string; group: CredentialGroup }[] = [
	...["Windows", "Linux", "Unix", "macOS"].map((value) => ({ value, group: "操作系统" as const })),
	...[
		"MySQL",
		"PostgreSQL",
		"Microsoft SQL Server",
		"Oracle",
		"MariaDB",
		"SQLite",
		"Redis",
		"MongoDB",
		"Elasticsearch",
		"OpenSearch",
		"ClickHouse",
		"Apache Cassandra",
		"Apache HBase",
		"Apache Hive",
		"Apache Doris",
		"StarRocks",
		"TiDB",
		"OceanBase",
		"达梦",
		"人大金仓",
		"GaussDB",
		"openGauss",
		"DB2",
		"SAP HANA",
		"Sybase ASE",
		"Informix",
		"Teradata",
		"Snowflake",
		"Amazon Redshift",
		"Couchbase",
		"CouchDB",
		"Neo4j",
		"InfluxDB",
		"TimescaleDB",
		"TDengine",
		"Milvus",
		"Greenplum",
		"Vertica",
		"DynamoDB",
		"Memcached",
	].map((value) => ({ value, group: "数据库" as const })),
	...["防火墙", "WAF", "VPN", "路由器", "交换机", "堡垒机", "NAS", "存储设备", "负载均衡", "态势感知"].map(
		(value) => ({ value, group: "网络与安全设备" as const }),
	),
	...[
		"Web 应用",
		"API",
		"Git",
		"Kubernetes",
		"Docker Registry",
		"云服务",
		"LDAP",
		"邮件服务",
		"消息队列",
		"对象存储",
	].map((value) => ({ value, group: "应用与服务" as const })),
	{ value: "其他", group: "其他" },
];
export interface CredentialField {
	key: string;
	value: string;
	sensitive: boolean;
}
export interface CredentialInput {
	name: string;
	group: CredentialGroup;
	type: string;
	host: string;
	port: number | null;
	username: string;
	password: string;
	privateKey: string;
	passphrase: string;
	token: string;
	database: string;
	instance: string;
	domain: string;
	manufacturer: string;
	model: string;
	notes: string;
	fields?: CredentialField[];
}
export type CredentialStatus = "unverified" | "usable" | "failed";
export interface CredentialValidation {
	status: "usable" | "failed";
	method: string;
	summary: string;
	at: string;
	source: "user" | "agent";
	sessionId: string | null;
	revision: string;
}
export interface CredentialRecord extends CredentialInput {
	fields: CredentialField[];
	id: string;
	projectId: string;
	revision: string;
	validationToken: string;
	status: CredentialStatus;
	validations: CredentialValidation[];
	updatedAt: string;
}
export type CredentialView = Omit<
	CredentialRecord,
	"password" | "privateKey" | "passphrase" | "token" | "validationToken"
> & {
	hasPassword: boolean;
	hasPrivateKey: boolean;
	hasPassphrase: boolean;
	hasToken: boolean;
};
export function credentialView(record: CredentialRecord): CredentialView {
	const { password, privateKey, passphrase, token, validationToken: _validationToken, ...view } = record;
	return {
		...view,
		fields: record.fields.map((field) => ({ ...field, value: field.sensitive ? "" : field.value })),
		hasPassword: Boolean(password),
		hasPrivateKey: Boolean(privateKey),
		hasPassphrase: Boolean(passphrase),
		hasToken: Boolean(token),
	};
}
export function credentialIdentity(record: CredentialInput): string {
	return JSON.stringify([record.type, record.host, record.port, record.username, record.database, record.instance]);
}
export function failedCredential(record: CredentialView | CredentialRecord): boolean {
	return record.status === "failed";
}
export function parseCredential(value: unknown): CredentialInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("凭据必须是对象");
	const row = value as Record<string, unknown>;
	const allowed = [
		"name",
		"group",
		"type",
		"host",
		"port",
		"username",
		"password",
		"privateKey",
		"passphrase",
		"token",
		"database",
		"instance",
		"domain",
		"manufacturer",
		"model",
		"notes",
		"fields",
	];
	if (Object.keys(row).some((key) => !allowed.includes(key))) throw new Error("包含不支持的字段");
	const string = (key: string, cap = 512): string => {
		const text = row[key] ?? "";
		if (typeof text !== "string" || text.length > cap || text.includes("\0")) throw new Error(`${key} 格式错误`);
		return text;
	};
	const type = string("type", 128).trim();
	if (!type) throw new Error("请选择或填写凭据类型");
	const builtin = CREDENTIAL_TYPES.find((entry) => entry.value === type);
	const group = string("group").trim() || builtin?.group || "其他";
	if (!CREDENTIAL_GROUPS.includes(group as CredentialGroup) || (builtin && group !== builtin.group))
		throw new Error("凭据分组与类型不匹配");
	const host = string("host", 2048).trim();
	if (!host || /[\r\n]/.test(host)) throw new Error("请输入有效的目标地址");
	const port = row.port === undefined || row.port === "" || row.port === null ? null : Number(row.port);
	if (
		port !== null &&
		((typeof row.port !== "string" && typeof row.port !== "number") ||
			!Number.isInteger(port) ||
			port < 1 ||
			port > 65535)
	)
		throw new Error("端口应为 1–65535，或留空");
	let fields: unknown = row.fields === undefined || row.fields === "" ? [] : row.fields;
	if (typeof fields === "string") {
		try {
			fields = JSON.parse(fields);
		} catch {
			throw new Error("fields 应为 JSON 数组");
		}
	}
	if (!Array.isArray(fields) || fields.length > 64) throw new Error("自定义字段最多 64 个");
	const seen = new Set<string>();
	const parsedFields = fields
		.map((value): CredentialField => {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("自定义字段格式错误");
			const field = value as Record<string, unknown>;
			if (
				Object.keys(field).some((key) => !["key", "value", "sensitive"].includes(key)) ||
				typeof field.key !== "string" ||
				!field.key.trim() ||
				field.key.length > 128 ||
				typeof field.value !== "string" ||
				field.value.length > 65536 ||
				typeof field.sensitive !== "boolean" ||
				/\0/.test(field.key + field.value)
			)
				throw new Error("自定义字段需要 key、value 和 sensitive");
			const key = field.key.trim();
			if (seen.has(key)) throw new Error("自定义字段名称重复");
			seen.add(key);
			return { key, value: field.value, sensitive: field.sensitive };
		})
		.sort((a, b) => a.key.localeCompare(b.key));
	return {
		name: string("name", 128).trim() || host,
		group: group as CredentialGroup,
		type,
		host,
		port,
		username: string("username", 256).trim(),
		password: string("password", 16384),
		privateKey: string("privateKey", 65536),
		passphrase: string("passphrase", 16384),
		token: string("token", 16384),
		database: string("database").trim(),
		instance: string("instance").trim(),
		domain: string("domain").trim(),
		manufacturer: string("manufacturer").trim(),
		model: string("model").trim(),
		notes: string("notes", 4096),
		fields: row.fields === undefined || row.fields === "" ? undefined : parsedFields,
	};
}
