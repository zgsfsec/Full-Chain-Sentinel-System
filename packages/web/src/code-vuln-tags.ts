/** Browser-safe taxonomy shared by the open-source monitor, storage and UI. */
interface CodeVulnTagDefinition {
	id: string;
	zh: string;
	en: string;
	categories: readonly string[];
}

export const CODE_VULN_TAGS = [
	{ id: "rce", zh: "RCE", en: "RCE", categories: ["web", "memory", "other"] },
	{ id: "ssrf", zh: "SSRF", en: "SSRF", categories: ["web"] },
	{ id: "file-upload", zh: "文件上传", en: "File upload", categories: ["web"] },
	{ id: "access-control", zh: "越权", en: "Broken access control", categories: ["web"] },
	{ id: "sql-injection", zh: "SQL 注入", en: "SQL injection", categories: ["web"] },
	{ id: "xss", zh: "XSS", en: "XSS", categories: ["web"] },
	{ id: "unauthorized-access", zh: "未授权访问", en: "Unauthenticated access", categories: ["web"] },
	{ id: "auth-bypass", zh: "认证绕过", en: "Authentication bypass", categories: ["web"] },
	{ id: "command-injection", zh: "命令注入", en: "Command injection", categories: ["web", "other"] },
	{ id: "nosql-injection", zh: "NoSQL 注入", en: "NoSQL injection", categories: ["web"] },
	{ id: "xxe", zh: "XXE", en: "XXE", categories: ["web"] },
	{ id: "ssti", zh: "SSTI", en: "SSTI", categories: ["web"] },
	{ id: "path-traversal", zh: "路径穿越", en: "Path traversal", categories: ["web", "other"] },
	{ id: "file-read", zh: "任意文件读取", en: "Arbitrary file read", categories: ["web", "other"] },
	{ id: "file-write", zh: "任意文件写入", en: "Arbitrary file write", categories: ["web", "other"] },
	{ id: "file-inclusion", zh: "文件包含", en: "File inclusion", categories: ["web"] },
	{ id: "deserialization", zh: "反序列化", en: "Unsafe deserialization", categories: ["web", "other"] },
	{ id: "csrf", zh: "CSRF", en: "CSRF", categories: ["web"] },
	{ id: "open-redirect", zh: "开放重定向", en: "Open redirect", categories: ["web"] },
	{ id: "request-smuggling", zh: "HTTP 请求走私", en: "HTTP request smuggling", categories: ["web"] },
	{ id: "business-logic", zh: "业务逻辑漏洞", en: "Business logic flaw", categories: ["web"] },
	{ id: "heap-overflow", zh: "堆溢出", en: "Heap buffer overflow", categories: ["memory"] },
	{ id: "stack-overflow", zh: "栈缓冲区溢出", en: "Stack buffer overflow", categories: ["memory"] },
	{ id: "out-of-bounds-read", zh: "越界读", en: "Out-of-bounds read", categories: ["memory"] },
	{ id: "out-of-bounds-write", zh: "越界写", en: "Out-of-bounds write", categories: ["memory"] },
	{ id: "use-after-free", zh: "释放后使用", en: "Use after free", categories: ["memory"] },
	{ id: "double-free", zh: "双重释放", en: "Double free", categories: ["memory"] },
	{ id: "type-confusion", zh: "类型混淆", en: "Type confusion", categories: ["memory"] },
	{ id: "integer-overflow", zh: "整数溢出", en: "Integer overflow", categories: ["memory", "other"] },
	{ id: "uninitialized-memory", zh: "未初始化内存", en: "Uninitialized memory", categories: ["memory"] },
	{ id: "null-dereference", zh: "空指针解引用", en: "Null pointer dereference", categories: ["memory"] },
	{ id: "format-string", zh: "格式化字符串漏洞", en: "Format string flaw", categories: ["memory"] },
	{ id: "memory-leak", zh: "内存泄漏", en: "Memory leak", categories: ["memory"] },
	{ id: "race-condition", zh: "竞态条件", en: "Race condition", categories: ["web", "memory", "other"] },
	{ id: "info-disclosure", zh: "信息泄露", en: "Information disclosure", categories: ["web", "memory", "other"] },
	{ id: "credential-leak", zh: "凭据泄露", en: "Credential leak", categories: ["web", "other"] },
	{ id: "privilege-escalation", zh: "权限提升", en: "Privilege escalation", categories: ["web", "memory", "other"] },
	{ id: "dos", zh: "拒绝服务", en: "Denial of service", categories: ["web", "memory", "other"] },
	{ id: "crypto-flaw", zh: "加密实现缺陷", en: "Cryptographic flaw", categories: ["other"] },
	{ id: "certificate-validation", zh: "证书校验缺陷", en: "Certificate validation flaw", categories: ["other"] },
	{ id: "supply-chain", zh: "供应链漏洞", en: "Supply chain flaw", categories: ["other"] },
	{ id: "other", zh: "其他", en: "Other", categories: ["web", "memory", "other"] },
] as const satisfies readonly CodeVulnTagDefinition[];

export type CodeVulnTag = (typeof CODE_VULN_TAGS)[number]["id"];

/** Only explicit names from the taxonomy are accepted; no inference from titles. */
export function normalizeCodeVulnTags(raw: unknown, category: string | null): CodeVulnTag[] {
	if (!Array.isArray(raw) || !category) return [];
	const tags = new Set<CodeVulnTag>();
	for (const value of raw) {
		if (typeof value !== "string") continue;
		const name = value.trim().toLowerCase();
		const tag = CODE_VULN_TAGS.find(
			(tag) => tag.id === name || tag.zh.toLowerCase() === name || tag.en.toLowerCase() === name,
		);
		if (tag && (tag.categories as readonly string[]).includes(category)) tags.add(tag.id);
	}
	// "Other" is a fallback, not a second classification alongside a known type.
	if (tags.size > 1) tags.delete("other");
	return [...tags];
}
