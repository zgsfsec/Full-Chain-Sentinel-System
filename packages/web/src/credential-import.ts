import { type CredentialInput, credentialIdentity, parseCredential } from "./credential-types.ts";

/** RFC 4180 fields, including escaped quotes and multiline PEM keys. */
export function parseCredentialCsv(content: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [],
		field = "",
		quoted = false,
		closed = false;
	for (let i = 0; i < content.length; i++) {
		const c = content[i];
		if (quoted) {
			if (c === '"' && content[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') {
				quoted = false;
				closed = true;
			} else field += c;
		} else if (c === "," || c === "\n" || c === "\r") {
			row.push(field);
			field = "";
			closed = false;
			if (c !== ",") {
				if (row.some((cell) => cell !== "")) rows.push(row);
				row = [];
				if (c === "\r" && content[i + 1] === "\n") i++;
			}
		} else if (c === '"' && field === "" && !closed) quoted = true;
		else {
			if (closed || c === '"') throw new Error("CSV 引号格式错误");
			field += c;
		}
	}
	if (quoted) throw new Error("CSV 存在未闭合引号");
	row.push(field);
	if (row.some((cell) => cell !== "")) rows.push(row);
	return rows;
}

export function parseCredentialImport(format: unknown, content: unknown): CredentialInput[] {
	if (typeof content !== "string" || Buffer.byteLength(content) > 2 * 1024 * 1024)
		throw new Error("导入内容最大 2 MB");
	const text = content.replace(/^\uFEFF/, "");
	let values: unknown;
	if (format === "json") {
		try {
			values = JSON.parse(text);
		} catch {
			throw new Error("JSON 格式错误");
		}
	} else if (format === "csv") {
		const [rawHeaders, ...rows] = parseCredentialCsv(text);
		const headers = rawHeaders?.map((header) => header.trim());
		if (!headers || headers.some((header) => !header) || new Set(headers).size !== headers.length)
			throw new Error("CSV 表头为空或重复");
		values = rows.map((cells, index) => {
			if (cells.length !== headers.length) throw new Error(`第 ${index + 2} 行列数与表头不符`);
			return Object.fromEntries(headers.map((header, i) => [header.trim(), cells[i]]));
		});
	} else throw new Error("导入格式只能为 csv 或 json");
	if (!Array.isArray(values) || values.length === 0 || values.length > 1000) throw new Error("每批导入 1–1000 条记录");
	const seen = new Set<string>();
	return values.map((value, index) => {
		try {
			const input = parseCredential(value);
			const identity = credentialIdentity(input);
			if (seen.has(identity)) throw new Error("本批存在重复记录");
			seen.add(identity);
			return input;
		} catch (error) {
			throw new Error(`第 ${index + 1} 条：${error instanceof Error ? error.message : "格式错误"}`);
		}
	});
}
