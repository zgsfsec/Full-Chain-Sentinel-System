import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { securityCheckCategories } from "./security-check-categories.ts";
import { SECURITY_CHECK_MAX_BYTES, type SecurityCheckRule } from "./security-check-types.ts";

export function checkObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("需要对象格式");
	return value as Record<string, unknown>;
}

export function checkString(value: unknown, label: string, max = 512, optional = false): string {
	if (optional && value === undefined) return "";
	if (typeof value !== "string" || (!optional && !value.trim()) || value.length > max || value.includes("\0"))
		throw new Error(`${label}不能为空且长度不能超过 ${max}`);
	return value.trim();
}

export function parseSecurityCheckMarkdown(
	markdown: string,
	sourceId: string,
	path = "",
	commit = "",
): SecurityCheckRule {
	markdown = markdown.replaceAll("\r\n", "\n");
	if (Buffer.byteLength(markdown) > SECURITY_CHECK_MAX_BYTES) throw new Error("规则文件超过 128 KB");
	const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(markdown);
	if (!match) throw new Error("规则需要 YAML 文件头和 Markdown 正文");
	const document = parseDocument(match[1], { uniqueKeys: true });
	if (document.errors.length) throw new Error(`规则文件头无效：${document.errors[0].message}`);
	const metadata = checkObject(document.toJS({ maxAliasCount: 0 }));
	if (Object.keys(metadata).some((key) => !["id", "name", "category", "description"].includes(key)))
		throw new Error("规则文件头包含未支持的字段");
	const ruleId = checkString(metadata.id, "规则 ID", 128);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(ruleId)) throw new Error("规则 ID 只支持字母、数字、点、下划线和连字符");
	const name = checkString(metadata.name, "规则名称", 128);
	const categories = securityCheckCategories(checkString(metadata.category, "分类", 2048));
	if (
		categories.length > 16 ||
		categories.some(
			(path) =>
				path.length > 256 ||
				/[\r\n]/.test(path) ||
				path.split("/").some((part) => !part || part === "." || part === ".."),
		)
	)
		throw new Error("分类最多 16 个，每个路径最长 256 字符，使用逗号分隔；路径层级不能为空、. 或 ..");
	const category = categories.join(",");
	const description = checkString(metadata.description, "简介", 1024, true);
	const text = checkString(match[2], "规则正文", SECURITY_CHECK_MAX_BYTES);
	const version = createHash("sha256")
		.update(JSON.stringify({ ruleId, name, category, description, text }))
		.digest("hex");
	return { id: `${sourceId}:${ruleId}`, sourceId, ruleId, name, category, description, text, version, path, commit };
}

export function parseSecurityCheckRepository(value: unknown): string {
	const url = new URL(checkString(value, "GitHub 仓库"));
	if (
		url.protocol !== "https:" ||
		url.hostname !== "github.com" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.port
	)
		throw new Error("请填写 https://github.com/所有者/仓库");
	const parts = url.pathname
		.replace(/\/$/, "")
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean);
	if (parts.length !== 2 || parts.some((part) => !/^[\w.-]+$/.test(part) || part === "." || part === ".."))
		throw new Error("GitHub 仓库地址无效");
	return `https://github.com/${parts.join("/")}`;
}
