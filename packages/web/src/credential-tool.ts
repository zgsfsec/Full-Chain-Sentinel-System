import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CredentialStore } from "./credential-store.ts";
import { type CredentialInput, credentialView, parseCredential } from "./credential-types.ts";

export const CREDENTIAL_TOOL_NAMES: readonly string[] = [
	"credential_list",
	"credential_read",
	"credential_save",
	"credential_report_validation",
];
interface VerificationRead {
	revision: string;
	token: string;
}
/** Authority stays with one project/session, including background conversations. */
export class SessionCredentialAccess {
	private readonly context: {
		enabled: () => boolean;
		projectId: string | null;
		sessionId: () => string;
		store: () => CredentialStore;
	};
	private readonly verificationReads = new Map<string, VerificationRead>();
	constructor(context: {
		enabled: () => boolean;
		projectId: string | null;
		sessionId: () => string;
		store: () => CredentialStore;
	}) {
		this.context = context;
	}
	clear(): void {
		this.verificationReads.clear();
	}
	private scope(): { project: string; store: CredentialStore } {
		if (!this.context.enabled() || !this.context.projectId) throw new Error("请先在当前对话启用凭据中心");
		return { project: this.context.projectId, store: this.context.store() };
	}
	list(search: string, offset: number, limit: number): unknown {
		const { project, store } = this.scope();
		const items = store
			.list(project)
			.filter((row) =>
				`${row.name} ${row.type} ${row.host} ${row.username}`.toLowerCase().includes(search.toLowerCase()),
			);
		return { total: items.length, items: items.slice(offset, offset + limit).map(credentialView) };
	}
	read(id: string, purpose: "verify" | "use"): unknown {
		const { project, store } = this.scope();
		const record = store.get(project, id);
		if (purpose === "verify") {
			this.verificationReads.set(id, { revision: record.revision, token: record.validationToken });
		} else if (record.status !== "usable") throw new Error("该凭据尚不可用，请先验证并上报成功后再用于其他任务");
		const { validationToken: _token, ...result } = record;
		return result;
	}
	save(input: Partial<CredentialInput>, id?: string, revision?: string): unknown {
		const { project, store } = this.scope();
		if (id && !revision) throw new Error("更新凭据必须提供当前 revision");
		let base: Partial<CredentialInput> = {};
		if (id) {
			const {
				id: _id,
				projectId: _projectId,
				revision: _revision,
				validationToken: _token,
				status: _status,
				validations: _validations,
				updatedAt: _updatedAt,
				...fields
			} = store.get(project, id);
			base = fields;
		}
		return store.save(project, [parseCredential({ ...base, ...input })], id, revision)[0];
	}
	report(id: string, revision: string, success: boolean, method: string, summary: string): unknown {
		const { project, store } = this.scope();
		const read = this.verificationReads.get(id);
		if (!read || read.revision !== revision) throw new Error("请先读取当前版本凭据并实际验证");
		const result = store.validate(project, id, revision, read.token, {
			status: success ? "usable" : "failed",
			method,
			summary,
			source: "agent",
			sessionId: this.context.sessionId(),
		});
		this.verificationReads.delete(id);
		return result;
	}
}
const inputSchema = Type.Object({
	name: Type.Optional(Type.String()),
	group: Type.Optional(
		Type.Union([
			Type.Literal("操作系统"),
			Type.Literal("数据库"),
			Type.Literal("网络与安全设备"),
			Type.Literal("应用与服务"),
			Type.Literal("其他"),
		]),
	),
	type: Type.Optional(Type.String()),
	host: Type.Optional(Type.String()),
	port: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.Null()])),
	username: Type.Optional(Type.String()),
	password: Type.Optional(Type.String()),
	privateKey: Type.Optional(Type.String()),
	passphrase: Type.Optional(Type.String()),
	token: Type.Optional(Type.String()),
	database: Type.Optional(Type.String()),
	instance: Type.Optional(Type.String()),
	domain: Type.Optional(Type.String()),
	manufacturer: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	notes: Type.Optional(Type.String()),
	fields: Type.Optional(
		Type.Array(Type.Object({ key: Type.String(), value: Type.String(), sensitive: Type.Boolean() })),
	),
});
function outcome(action: () => unknown): AgentToolResult<{ ok: boolean }> {
	try {
		const result = action();
		return { content: [{ type: "text", text: JSON.stringify(result) }], details: { ok: true } };
	} catch (error) {
		return {
			content: [{ type: "text", text: error instanceof Error ? error.message : "凭据操作失败" }],
			details: { ok: false },
			isError: true,
		};
	}
}
export function createCredentialTools(access: SessionCredentialAccess): ToolDefinition[] {
	return [
		defineTool({
			name: "credential_list",
			label: "凭据列表",
			defaultActive: false,
			description: "列出当前项目的脱敏凭据。不会返回密码。",
			parameters: Type.Object({
				search: Type.Optional(Type.String()),
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			}),
			async execute(_id, params) {
				return outcome(() => access.list(params.search ?? "", params.offset ?? 0, params.limit ?? 50));
			},
		}),
		defineTool({
			name: "credential_read",
			label: "读取指定凭据",
			defaultActive: false,
			description:
				"当前对话启用凭据中心即允许主动验证项目内凭据，无需用户逐条选择。purpose=verify 按需读取任意状态凭据用于验证；purpose=use 仅限可用凭据。不要将敏感内容写进报告或验证结论。",
			promptGuidelines: [
				"当前对话已启用凭据中心，可结合用户任务主动列出、读取、验证并上报当前项目凭据，无需额外逐条授权。未验证和验证失败的凭据先验证，上报成功后再用于其他任务。实际命令沿用现有审批流程。",
				"凭据验证优先使用项目容器内现成客户端，通过 bash 执行；先用 command -v 和 --help 确认实际可用命令与参数。不要每个项目都重写 SSH、WinRM 或数据库连接代码；只有现成客户端不支持目标认证方式时，才考虑最小驱动调用或按需安装。旧容器可能尚未安装新增客户端，缺少工具不代表凭据无效。",
				"凭据客户端选择：Linux/Unix/macOS 和支持 SSH 的设备用 ssh，密码认证可配合 sshpass -e，私钥用 ssh -i；Windows 按实际协议用 nxc winrm、nxc smb 或 ssh，不能仅按操作系统推断协议；LDAP/AD 用 ldapwhoami 或 ldapsearch。",
				"数据库客户端选择：MySQL/MariaDB 及兼容协议用 mariadb；PostgreSQL 及兼容协议用 psql；Redis 用 redis-cli；SQL Server/Sybase TDS 用 tsql，或已有的 impacket-mssqlclient；SQLite 用 sqlite3 读取用户指定的本地文件；MongoDB 用系统 python3 的 pymongo.MongoClient，设置连接/服务端选择超时并执行 client.admin.command('ping')，不安装体积较大的 mongosh。",
				"网络设备的 SNMP 用 snmpget 做单个 OID 查询；HTTP API、Elasticsearch/OpenSearch、ClickHouse、InfluxDB、CouchDB 等有 HTTP 接口的服务优先用 curl。其他数据库、设备或自定义类型先识别实际协议，复用兼容客户端，类型列表不等于每种产品都预装专用工具。",
				"验证仅使用所选账号进行最小认证检查，如 SSH 的 true、SQL 的 SELECT 1、Redis 的 PING、MongoDB 的 ping；设置有限超时，确认成功的是需要认证的接口，不能仅凭端口开放、HTTP 200 或匿名访问就判定密码有效。认证明确拒绝时上报失败；工具缺失、网络不通、TLS 或协议不匹配时说明无法确认并保持原状态。",
				"按凭据实际字段使用端口、域、数据库、实例和 TLS 配置。密码、Token 优先用环境变量或受限临时配置传递，sshpass 使用 -e，不将秘密放进命令行参数或打印；私钥临时文件设为 0600，使用后清理。",
				"验证后调用 credential_report_validation 上报实际结果，不得臆测成功；只保存方式和简短结论，不保存原始命令输出、请求响应或密码。",
			],
			parameters: Type.Object({
				id: Type.String(),
				purpose: Type.Union([Type.Literal("verify"), Type.Literal("use")]),
			}),
			async execute(_id, params) {
				return outcome(() => access.read(params.id, params.purpose));
			},
		}),
		defineTool({
			name: "credential_save",
			label: "保存凭据",
			defaultActive: false,
			description:
				"根据用户粘贴、上传或任务中发现的凭据，识别类型和字段，逐条保存或更新，可连续调用批量录入。新增需 type 和 host；更新需 id、revision，input 可只包含变更字段。认证变化后恢复未验证，空白敏感字段保留原值。不得通过此工具设置可用状态。",
			parameters: Type.Object({
				id: Type.Optional(Type.String()),
				revision: Type.Optional(Type.String()),
				input: inputSchema,
			}),
			async execute(_id, params) {
				return outcome(() => access.save(params.input, params.id, params.revision));
			},
		}),
		defineTool({
			name: "credential_report_validation",
			label: "上报凭据验证",
			defaultActive: false,
			description:
				"对当前对话已读取验证的项目凭据提交实际验证结果。必须附上读取的 revision、验证方式、简短结论；禁止原始输出或敏感数据。旧版本或已失效的验证结果将被拒绝。",
			parameters: Type.Object({
				id: Type.String(),
				revision: Type.String(),
				success: Type.Boolean(),
				method: Type.String({ minLength: 1, maxLength: 256 }),
				summary: Type.String({ minLength: 1, maxLength: 1000 }),
			}),
			async execute(_id, params) {
				return outcome(() =>
					access.report(params.id, params.revision, params.success, params.method, params.summary),
				);
			},
		}),
	];
}
