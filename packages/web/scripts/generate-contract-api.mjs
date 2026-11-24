#!/usr/bin/env node
/**
 * Assemble what a frontend developer imports into ApiFox or Postman, from the
 * contract's sources:
 *
 * - `http-api.json`: openapi.yaml — the gates, the status codes, the
 *   descriptions, the parameter and request examples — with every `x-schema`
 *   replaced by the schema generated from the backend's types, written as
 *   OpenAPI 3.0, every JSON response carrying an example.
 * - `sentinel.postman_collection.json` and `sentinel.postman_environment.json`:
 *   the same operations as a Postman collection with its environment.
 * - `websocket-messages.json`: every WebSocket message with its schema, its
 *   example and what the server answers.
 *
 *   node scripts/generate-contract-api.mjs [--check]
 *
 * `--check` fails when an output is not what this script would write now.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_CONSOLE_VERSION } from "../src/assets.ts";
import { CONSENT_VERSION, consentTextFor, isConsentExemptPath } from "../src/consent.ts";
import { DOMAINS } from "../test/contract/domains.ts";
import { CLIENT_EXAMPLES, SERVER_EXAMPLES } from "../test/contract/examples/index.ts";
import { codeSpans, documentedSections, jsonExample, summary } from "../test/contract/markdown.ts";
import { resolveReference, validate } from "../test/contract/schema.ts";
import { parse } from "yaml";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const docs = join(packageRoot, "docs", "contract");
const outDir = join(docs, "frontend");
const checking = process.argv.includes("--check");
const show = (file) => relative(repoRoot, file);

const source = parse(readFileSync(join(docs, "openapi.yaml"), "utf8"));
const generated = JSON.parse(readFileSync(join(outDir, "schemas.generated.json"), "utf8"));

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const JSON_TYPE = "application/json";
const CLIENT_COUNT = Object.keys(CLIENT_EXAMPLES).length;
const SERVER_COUNT = Object.keys(SERVER_EXAMPLES).length;
/** The server's default port, when nothing else is configured. */
const LOCAL = "http://127.0.0.1:7777";

// ---------------------------------------------------------------------------
// Schemas: the generated ones, written as OpenAPI 3.0 under components.schemas

/** Component name → schema, in the order the document first uses them. */
const schemas = new Map();

/** What a definition of the generated file is called among the components. */
function componentKey(name) {
	// `$` is the one character generated names carry that a component name may not.
	const key = name.replaceAll("$", "_");
	if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw new Error(`定义 ${name} 不能作为 OpenAPI 的组件名`);
	return key;
}

/** The component a generated definition becomes, converting it on first use. */
function take(name, where) {
	const definition = generated.$defs[name];
	if (!definition) throw new Error(`${where}: 生成的结构里没有定义 ${name}`);
	const key = componentKey(name);
	if (schemas.has(key)) return key;
	if (source.components?.schemas?.[key] !== undefined)
		throw new Error(`${where}: 生成的定义 ${name} 和手写的组件同名`);
	// Registered before it is converted: a definition that refers to itself finds itself.
	schemas.set(key, {});
	schemas.set(key, convert(definition, `${where} → ${name}`));
	return key;
}

/** A schema that says only that the value may be null, i.e. is null. */
const isNull = (schema) => schema.nullable === true && Object.keys(schema).length === 1;

/** A schema written as OpenAPI 3.0: OpenAPI 3.1 and JSON Schema 2020-12 spell some things differently. */
function convert(schema, where) {
	if (schema === true) return {};
	if (schema === false) return { not: {} };
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`${where}: 结构不是对象`);

	if (typeof schema.$ref === "string") {
		if (schema.$ref.startsWith("#/$defs/")) {
			const key = take(schema.$ref.slice("#/$defs/".length), where);
			const { $ref, ...rest } = schema;
			return Object.keys(rest).length === 0 ? { $ref: `#/components/schemas/${key}` } : { allOf: [{ $ref: `#/components/schemas/${key}` }], ...convert(rest, where) };
		}
		if (!schema.$ref.startsWith("#/components/")) throw new Error(`${where}: 不认识的引用 ${schema.$ref}`);
		const { $ref, ...rest } = schema;
		// OpenAPI 3.0 ignores what stands next to a reference.
		return Object.keys(rest).length === 0 ? { $ref } : { allOf: [{ $ref }], ...convert(rest, where) };
	}

	const KNOWN = new Set([
		"$ref", "type", "enum", "const", "properties", "required", "items", "prefixItems", "additionalProperties",
		"anyOf", "allOf", "oneOf", "not", "nullable", "description", "deprecated", "format", "title", "default",
		"example", "examples", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "pattern",
		"uniqueItems", "readOnly", "writeOnly", "$comment",
	]);
	for (const key of Object.keys(schema))
		if (!KNOWN.has(key) && !key.startsWith("x-")) throw new Error(`${where}: 不认识的关键字 ${key}`);

	const out = {};
	if (schema.description !== undefined) out.description = schema.description;
	if (schema.title !== undefined) out.title = schema.title;
	if (schema.deprecated !== undefined) out.deprecated = schema.deprecated;
	if (schema.format !== undefined) out.format = schema.format;
	if (schema.default !== undefined) out.default = schema.default;
	if (schema.example !== undefined) out.example = schema.example;
	if (Array.isArray(schema.examples) && schema.examples.length > 0) out.example = schema.examples[0];
	if (schema.pattern !== undefined) out.pattern = schema.pattern;
	if (schema.readOnly !== undefined) out.readOnly = schema.readOnly;
	if (schema.writeOnly !== undefined) out.writeOnly = schema.writeOnly;

	let types = schema.type === undefined ? [] : Array.isArray(schema.type) ? [...schema.type] : [schema.type];
	if (types.includes("null")) {
		types = types.filter((type) => type !== "null");
		out.nullable = true;
	}
	if (types.length === 1) out.type = types[0];
	else if (types.length > 1) out.anyOf = types.map((type) => ({ type }));

	if (schema.const !== undefined) out.enum = [schema.const];
	if (Array.isArray(schema.enum)) {
		const values = schema.enum.filter((value) => value !== null);
		if (values.length !== schema.enum.length) out.nullable = true;
		out.enum = values;
	}

	if (typeof schema.minimum === "number") out.minimum = schema.minimum;
	if (typeof schema.maximum === "number") out.maximum = schema.maximum;
	if (typeof schema.minLength === "number") out.minLength = schema.minLength;
	if (typeof schema.maxLength === "number") out.maxLength = schema.maxLength;
	if (typeof schema.exclusiveMinimum === "number" || typeof schema.exclusiveMaximum === "number")
		throw new Error(`${where}: exclusiveMinimum / exclusiveMaximum 还没有换算成 OpenAPI 3.0 的写法`);
	if (typeof schema.minItems === "number") out.minItems = schema.minItems;
	if (typeof schema.maxItems === "number") out.maxItems = schema.maxItems;
	if (schema.uniqueItems !== undefined) out.uniqueItems = schema.uniqueItems;

	// A tuple: 2020-12 lists its items under `prefixItems` and closes it with `items: false`.
	if (Array.isArray(schema.prefixItems)) {
		out.items = schema.prefixItems.map((item, index) => convert(item, `${where}[${index}]`));
		if (schema.items !== undefined && schema.items !== false)
			throw new Error(`${where}: 元组后面还有不固定个数的元素，OpenAPI 3.0 写不了`);
	} else if (schema.items === false) {
		out.items = {};
		out.maxItems ??= 0;
	} else if (schema.items !== undefined) {
		out.items = convert(schema.items, `${where}[]`);
	}

	for (const keyword of ["anyOf", "oneOf"]) {
		if (!Array.isArray(schema[keyword])) continue;
		const parts = schema[keyword].map((part, index) => convert(part, `${where} ${keyword}[${index}]`));
		if (keyword === "anyOf") {
			// `X | null` is one alternative and a bare null, which OpenAPI 3.0 writes as `nullable: true`.
			const real = parts.filter((part) => !isNull(part));
			if (real.length === 1 && real.length !== parts.length) {
				const [only] = real;
				// `nullable` does nothing next to a reference: there the alternative stays.
				if (only.$ref && Object.keys(only).length === 1) out.anyOf = [only, { nullable: true }];
				else Object.assign(out, only, { nullable: true });
				continue;
			}
		}
		out[keyword] = parts;
	}
	if (Array.isArray(schema.allOf)) out.allOf = schema.allOf.map((part, index) => convert(part, `${where} allOf[${index}]`));
	if (schema.not !== undefined) out.not = convert(schema.not, `${where} not`);
	if (schema.properties !== undefined)
		out.properties = Object.fromEntries(
			Object.entries(schema.properties).map(([name, property]) => [name, convert(property, `${where}.${name}`)]),
		);
	if (Array.isArray(schema.required) && schema.required.length > 0) out.required = [...schema.required];
	if (schema.additionalProperties !== undefined)
		out.additionalProperties =
			typeof schema.additionalProperties === "object" ? convert(schema.additionalProperties, `${where}{…}`) : schema.additionalProperties;
	return out;
}

/** The schema where a reference in the document points, or nothing. */
function dereference(reference, where) {
	const target = resolveReference(reference, spec);
	if (!target) throw new Error(`${where}: 解析不了 ${reference}`);
	return target;
}

// ---------------------------------------------------------------------------
// The document

const spec = structuredClone(source);
spec.openapi = "3.0.3";
delete spec.info.summary;
spec.info.description = [
	"全链哨兵 Web 控制台的 HTTP 接口，给前端开发用。可以导入 ApiFox 或 Postman，导入方法见 docs/contract/frontend/README.md。",
	"",
	"这份文档由 scripts/generate-contract-api.mjs 生成：说明、状态码、参数和请求示例来自手写的 openapi.yaml，响应和请求体的精确结构来自后端的 TypeScript 类型。",
	"",
	`WebSocket \`/ws\` 的 ${CLIENT_COUNT + SERVER_COUNT} 种消息不在这里，见同目录的 websocket-messages.json 和 docs/contract/websocket/ 下的各功能域文档。`,
	"",
	...String(source.info.description ?? "").split("\n"),
].join("\n");
spec.servers = [
	{ url: LOCAL, description: "本地开发时后端的默认地址。后端部署在别处，或者启用了 HTTPS 时，改成实际的协议、主机和端口。" },
	{ url: "/", description: "前端和后端同源：前端页面自己发请求时用相对路径，不需要配置后端地址。" },
];

// The hand-written components come first, so they read before the generated ones.
for (const [name, schema] of Object.entries(source.components?.schemas ?? {})) {
	if (source.components?.schemas?.[name]?.["x-schema"] !== undefined) throw new Error(`components.schemas.${name}: 组件里不写 x-schema`);
	schemas.set(name, convert(schema, `components.schemas.${name}`));
}

/** Every place in the document that holds a schema, by what it describes. */
function* schemaPlaces(document) {
	for (const [path, item] of Object.entries(document.paths ?? {})) {
		for (const parameter of item.parameters ?? [])
			if (parameter.schema) yield [parameter, "schema", `${path} 的参数 ${parameter.name}`];
		for (const method of METHODS) {
			const operation = item[method];
			if (!operation) continue;
			const at = `${method.toUpperCase()} ${path}`;
			for (const parameter of operation.parameters ?? [])
				if (parameter.schema) yield [parameter, "schema", `${at} 的参数 ${parameter.name}`];
			for (const [type, media] of Object.entries(operation.requestBody?.content ?? {}))
				if (media.schema) yield [media, "schema", `${at} 的请求体`];
			for (const [status, response] of Object.entries(operation.responses ?? {})) {
				for (const [header, definition] of Object.entries(response.headers ?? {}))
					if (definition.schema) yield [definition, "schema", `${at} 的响应头 ${header}`];
				for (const media of Object.values(response.content ?? {}))
					if (media.schema) yield [media, "schema", `${at} 的 ${status} 响应`];
			}
		}
	}
	for (const parameter of Object.values(document.components?.parameters ?? {}))
		if (parameter.schema) yield [parameter, "schema", `components.parameters.${parameter.name}`];
	for (const response of Object.values(document.components?.responses ?? {}))
		for (const media of Object.values(response.content ?? {}))
			if (media.schema) yield [media, "schema", `components.responses.${response.description}`];
}

/** The media types and bodies whose structure comes from the generated types. */
const fromTypes = new WeakSet();

/** `x-schema` names the generated root that states the structure here. */
function useGenerated(holder, key, where) {
	const schema = holder[key];
	if (!schema || typeof schema !== "object" || typeof schema["x-schema"] !== "string") return;
	if (Object.keys(schema).length !== 1) throw new Error(`${where}: x-schema 不能和别的关键字写在一起`);
	const root = generated.roots[schema["x-schema"]];
	if (!root || !root.$ref?.startsWith("#/$defs/"))
		throw new Error(`${where}: x-schema 指向的 ${schema["x-schema"]} 不是 schemas.generated.json 里指向定义的根`);
	holder[key] = { $ref: `#/components/schemas/${take(root.$ref.slice("#/$defs/".length), where)}` };
	fromTypes.add(holder);
}

for (const [holder, key, where] of schemaPlaces(spec)) useGenerated(holder, key, where);
for (const [holder, key, where] of schemaPlaces(spec)) holder[key] = convert(holder[key], where);
spec.components.schemas = Object.fromEntries(schemas);

/** The document as the validator reads references from it. */
const document = () => ({ components: { schemas: Object.fromEntries(schemas) } });

/** Every way `value` does not conform to `schema`, as one sentence. */
function checkedIn(source, schema, value, where) {
	const failures = validate(schema, value, source);
	if (failures.length > 0) throw new Error(`${where} 的示例不符合结构：\n  ${failures.slice(0, 6).join("\n  ")}`);
}
const checked = (schema, value, where) => checkedIn(document(), schema, value, where);

// ---------------------------------------------------------------------------
// Examples

const AT = "2026-11-24T08:00:00.000Z";
const AT_LATER = "2026-11-24T09:30:00.000Z";
const MS = Date.parse(AT);
const MS_LATER = Date.parse(AT_LATER);
const UUIDS = ["6f1c2a3e-8b4d-4c2a-9f1e-2d3c4b5a6978", "0b7e3d9f-5c1a-4e8b-b2d6-1f4a7c9e2d13"];

/** Optional properties an example of the ordinary case leaves out: they only appear when something went wrong or a list goes on. */
const ONLY_WHEN_UNUSUAL =
	/^(error|errors|errorMessage|lastError|finalError|warning|warnings|truncated|previewTruncated|rawTruncated|nextCursor|cursor|hasMore|totalCached|totalUpdatedAt|partial|isError|failed|failure)$/;

/** Values that make an example read like the ordinary case, whatever the property is called. */
const ORDINARY = [
	"running", "usable", "completed", "succeeded", "done", "ok", "active", "ready", "available", "processed", "tested",
	"confirmed", "watching", "valid", "success", "enabled", "connected", "installed", "healthy", "auto", "review",
	"medium", "allow", "project", "zh", "clean", "new",
];

const TEXT_BY_NAME = [
	[/passphrase$/i, "example-passphrase"],
	[/password$/i, "example-password"],
	[/^(apiKey|token)$/i, "example-token"],
	[/privateKey/i, "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"],
	[/(hash|digest|salt|signature|fingerprint)$/i, "9f2c1d7e4b6a8c3d5e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d"],
	[/markdown$/i, "# 示例标题\n\n这里是正文。\n\n## 小节\n\n- 要点一\n- 要点二\n"],
	[/^(raw|rawText)$/i, "GET / HTTP/1.1\r\nHost: example.com\r\nAccept: */*\r\n\r\n"],
	[/Base64$/i, "SGVsbG8sIFdvcmxkIQ=="],
	[/^(proto)$/i, "HTTP/1.1"],
	[/^reason$/, "示例原因"],
	[/^(method)$/i, "GET"],
	[/^(scheme)$/i, "https"],
	[/^(language|locale)$/i, "zh"],
	[/^(username|user|account)$/i, "operator"],
	[/^(version|revision)$/i, "1"],
	[/username$/i, "operator"],
	[/^(name)$/i, "示例名称"],
	[/^(title)$/i, "示例标题"],
	[/Name$/i, "示例名称"],
	[/^(sessionId|sessionFile)$/i, (v) => `session-${v + 1}`],
	[/Id$/i, (v, name) => `${name.slice(0, -2).replace(/^(.)/, (first) => first.toLowerCase()) || "item"}-${v + 1}`],
	[/^(description)$/i, "示例说明"],
	[/^(text)$/i, "示例文字"],
	[/^(key)$/i, "示例键"],
	[/^(value)$/i, "示例值"],
	[/^(category|group|type|kind|source)$/i, "示例分类"],
	[/url|uri|Url|Uri|baseUrl|repository|target|homepage|endpoint|webhook/i, "https://example.com/"],
	[/^(host|hostname|domain|server)$/i, "example.com"],
	[/ips?$/i, (v) => `203.0.113.${7 + v}`],
	[/expires$/i, AT_LATER],
	[/^subject$/i, "CN=Sentinel MITM CA"],
	[/(Path|path|Directory|directory|cwd)$/i, "/example/path"],
	[/^(filename|file|image)$/i, (v) => `image-${v + 1}.png`],
	[/^(command|cmd|shell|argv)$/i, "ls -la"],
	[/(At|Time|Date|Seen)$/i, (v) => [AT, AT_LATER][v % 2]],
	[/Text$/i, "示例文字"],
	[/^(error|message|reason|note|notes|intro|prompt|summary|brief|body|label|detail|details|warning|warnings|search|query|comment|intent|criteria|objective|input|requirements|textSignature|thought)$/i, "示例文字"],
];

const NUMBER_BY_NAME = [
	[/^status$/i, 200],
	[/port$/i, 443],
	[/^page$/i, 1],
	[/^(pageSize|limit)$/i, 20],
	[/(At|Since|Until|Deadline|Time|Seen)$/i, (v) => [MS, MS_LATER][v % 2]],
	[/^(ts|at)$/i, (v) => [MS, MS_LATER][v % 2]],
	[/^timeoutMs$/i, 30000],
	[/Ms$|Millis/i, 120],
	[/^batchSize$/i, 50],
	[/maxCaptureMb$/i, 256],
	[/maxConnections$/i, 64],
	[/intervalHours$/i, 24],
	[/size|bytes|used|free|capacity/i, (v) => 1200 + 340 * v],
	[/count|total|number|seq|index|offset/i, (v) => v + 1],
	[/threshold/i, 20],
	[/round|concurrency|retries/i, 4],
];

const FALSE_BY_NAME =
	/^(insecureTLS|truncated|disabled|isError|syncing|lowSpace|partial|pinned|force|hasMore|allowBuild|allowHostNetwork|allowPrivileged|manualStop|authEnabled)$/;

function textFor(name, variant, schema) {
	if (schema.format === "uuid") return UUIDS[variant % UUIDS.length];
	if (schema.format === "date-time" || schema.format === "date") return [AT, AT_LATER][variant % 2];
	if (schema.format === "binary") return "<文件的原始字节>";
	for (const [pattern, value] of TEXT_BY_NAME)
		if (pattern.test(name)) return typeof value === "function" ? value(variant, name) : value;
	return `示例${name}`;
}

function numberFor(name, variant, schema) {
	let value;
	const rule = NUMBER_BY_NAME.find(([pattern]) => pattern.test(name));
	if (rule) value = typeof rule[1] === "function" ? rule[1](variant) : rule[1];
	else value = variant + 1;
	if (typeof schema.minimum === "number" && value < schema.minimum) value = schema.minimum;
	if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) value = schema.exclusiveMinimum + 1;
	if (typeof schema.maximum === "number" && value > schema.maximum) value = schema.maximum;
	return schema.type === "integer" ? Math.round(value) : value;
}

function enumFor(values, name) {
	const candidates = values.filter((value) => value !== null);
	if (candidates.length === 0) return null;
	const preferred = { decision: "allow", severity: "medium", level: "medium", approval: "allow" }[name];
	if (preferred && candidates.includes(preferred)) return preferred;
	return ORDINARY.find((value) => candidates.includes(value)) ?? candidates[0];
}

/**
 * A value that conforms to `schema`, made to read like the ordinary case. It is
 * the same on every run: nothing here is random, and the second item of a list
 * (`variant` 1) differs from the first.
 */
function sampleOf(schema, name, state) {
	if (schema === undefined || schema === true) return null;
	if (schema.example !== undefined) return structuredClone(schema.example);
	if (schema.$ref) {
		if (state.seen.has(schema.$ref)) return undefined;
		state.seen.add(schema.$ref);
		const value = sampleOf(dereference(schema.$ref, `示例里的 ${name}`), name, state);
		state.seen.delete(schema.$ref);
		return value;
	}
	if (schema.anyOf ?? schema.oneOf) {
		for (const option of schema.anyOf ?? schema.oneOf) {
			const value = sampleOf(option, name, state);
			if (value !== undefined && value !== null) return value;
		}
		return null;
	}
	if (schema.allOf) {
		const merged = {};
		for (const part of schema.allOf) {
			const value = sampleOf(part, name, state);
			if (value !== null && typeof value === "object" && !Array.isArray(value)) Object.assign(merged, value);
			else if (value !== undefined && value !== null) return value;
		}
		return merged;
	}
	if (schema.enum !== undefined) return enumFor(schema.enum, name);
	if (schema.const !== undefined) return schema.const;
	switch (schema.type) {
		case "string":
			return textFor(name, state.variant, schema);
		case "number":
		case "integer":
			return numberFor(name, state.variant, schema);
		case "boolean":
			return !FALSE_BY_NAME.test(name);
		case "array": {
			// After the conversion a tuple lists its items as an array.
			if (Array.isArray(schema.items)) return schema.items.map((item) => sampleOf(item, name, state) ?? null);
			const item = schema.items ?? {};
			return [0, 1].map((variant) => sampleOf(item, name, { ...state, variant }) ?? (item.nullable ? null : "示例值"));
		}
		case "object": {
			const out = {};
			for (const [key, property] of Object.entries(schema.properties ?? {})) {
				const required = schema.required?.includes(key) ?? false;
				if (!required && ONLY_WHEN_UNUSUAL.test(key)) continue;
				const value = sampleOf(property, key, state);
				if (value === undefined) {
					if (required) out[key] = null;
					continue;
				}
				out[key] = value;
			}
			// A map: no properties of its own, any number of entries of one shape.
			const map = schema.additionalProperties;
			if (Object.keys(out).length === 0 && map && typeof map === "object")
				out["示例键"] = sampleOf(map, name, state) ?? "示例值";
			return out;
		}
		default:
			return null;
	}
}

/** The first sentence of a description, as plain text. */
function firstSentence(text) {
	return String(text ?? "")
		.replace(/[`*]/g, "")
		.split(/(?<=。)|\n/)[0]
		.trim();
}

/** The first sentence, cut short where it spells out every field: a saved answer's name. */
function brief(text) {
	const sentence = firstSentence(text);
	const cut = sentence.search(/[:：]/);
	return (cut > 0 ? sentence.slice(0, cut) : sentence).slice(0, 40) || "响应";
}

/** One operation, read the way a client sends it. */
function operationView(method, path, item, operation) {
	const at = `${method.toUpperCase()} ${path}`;
	const parameter = (entry) => (typeof entry.$ref === "string" ? dereference(entry.$ref, at) : entry);
	const own = (operation.parameters ?? []).map(parameter);
	const ownKeys = new Set(own.map((entry) => `${entry.in} ${entry.name}`));
	const parameters = [...(item.parameters ?? []).map(parameter).filter((entry) => !ownKeys.has(`${entry.in} ${entry.name}`)), ...own];
	for (const entry of parameters) {
		if (entry.example === undefined) throw new Error(`${at}: 参数 ${entry.name} 缺少 example`);
		checked(entry.schema ?? {}, entry.example, `${at} 的参数 ${entry.name}`);
	}
	const bodies = {};
	for (const [type, media] of Object.entries(operation.requestBody?.content ?? {})) {
		if (type !== JSON_TYPE) continue;
		if (media.example === undefined) throw new Error(`${at}: 请求体缺少 example`);
		checked(media.schema, media.example, `${at} 的请求体`);
		bodies[type] = media;
	}
	const responses = Object.entries(operation.responses ?? {}).map(([status, response]) => {
		const shared = typeof response.$ref === "string" ? dereference(response.$ref, at) : response;
		return { status, definition: shared, inline: typeof response.$ref !== "string" };
	});
	return { at, method, path, item, operation, parameters, bodies, responses };
}

const operations = [];
for (const [path, item] of Object.entries(spec.paths ?? {})) {
	for (const method of METHODS) {
		if (!item[method]) continue;
		const view = operationView(method, path, item, item[method]);
		operations.push(view);
for (const { status, definition, inline } of view.responses) {
	const media = definition.content?.[JSON_TYPE];
	if (!media) continue;
	if (media.example === undefined) {
		if (status.startsWith("2")) {
			// A hand-written schema has no example worth reading off it: one is written by hand.
			if (!inline || !fromTypes.has(media)) throw new Error(`${view.at}: ${status} 响应缺少 example`);
			media.example = sampleOf(media.schema, "response", { seen: new Set(), variant: 0 });
		} else {
			// A failure says one sentence, and what it says is the description. The two a client
			// makes out by their words are the server's own.
			const shared = definition.description.includes("未登录")
				? "未登录"
				: definition.description.includes("consent_required")
					? "consent_required"
					: "请求不合格。";
			media.example = { error: inline ? firstSentence(definition.description) : shared };
		}
	}
	checked(media.schema, media.example, `${view.at} 的 ${status} 响应`);
}
	}
}

// The statement's text is the server's own: read from the source rather than copied.
{
	const consent = operations.find((view) => view.at === "GET /api/consent");
	const media = consent.operation.responses["200"].content[JSON_TYPE];
	media.example = { required: true, acceptedAt: null, version: CONSENT_VERSION, text: consentTextFor("zh") };
	checked(media.schema, media.example, "GET /api/consent 的 200 响应");
}

// ---------------------------------------------------------------------------
// What the gates ask of an operation

function gatesOf(view) {
	const security = view.operation.security ?? spec.security ?? [];
	const names = security.flatMap((requirement) => Object.keys(requirement));
	if (names.length === 0) return "不需要 Cookie，也不需要登录。";
	const parts = [];
	if (names.includes("sentinel-gate")) parts.push("入口 Cookie（先打开过入口地址）");
	if (names.includes("sentinel-auth")) {
		parts.push("登录后的会话 Cookie");
		if (view.path.startsWith("/api/") && !isConsentExemptPath(view.path)) parts.push("账号已接受授权承诺");
	}
	return `需要${parts.join("、")}。`;
}

// ---------------------------------------------------------------------------
// OpenAPI for the client

const httpApi = `${JSON.stringify(spec, null, "\t")}\n`;

// ---------------------------------------------------------------------------
// Postman

const REASONS = {
	200: "OK", 201: "Created", 202: "Accepted", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
	404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large",
	415: "Unsupported Media Type", 429: "Too Many Requests", 500: "Internal Server Error",
	502: "Bad Gateway", 503: "Service Unavailable",
};
/** Sample values of the response headers the document names. */
const HEADER_SAMPLES = {
	"Set-Cookie": "sentinel-auth=<令牌>; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000",
	"Content-Disposition": "attachment; filename=report.zip",
	"Retry-After": "60",
	Allow: "POST",
};
/** What the requests refer to. The environment file and the collection's own defaults both come from here. */
const VARIABLES = [
	{ key: "baseUrl", value: LOCAL, secret: false, description: "后端的协议、主机和端口，不带末尾的斜杠。启用了 HTTPS 时改成 https://。" },
	{ key: "gateToken", value: "", secret: true, description: "后端启动日志里入口地址 `/<入口串>` 的那一段。" },
	{ key: "username", value: "operator", secret: false, description: "管理员账号。" },
	{ key: "password", value: "", secret: true, description: "账号的密码。" },
	{ key: "wsHost", value: LOCAL.replace(/^http/, "ws"), secret: false, description: "WebSocket 的地址，不带 `/ws`。后端是 https 时这里是 wss。" },
];

/** A stable UUID, so the collection keeps its identity across runs. */
function stableId(...parts) {
	const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The path with `{name}` filled from the parameter examples, as a Postman URL. */
function postmanUrl(view) {
	const byName = new Map(view.parameters.filter((entry) => entry.in === "path").map((entry) => [entry.name, entry]));
	const segments = [];
	const variables = [];
	for (const segment of view.path.split("/").filter(Boolean)) {
		const whole = /^\{(\w+)\}$/.exec(segment);
		const entry = whole ? byName.get(whole[1]) : undefined;
		if (entry) {
			// A whole segment is a path variable, which Postman shows a field for.
			segments.push(`:${entry.name}`);
			variables.push({ key: entry.name, value: String(entry.example) });
			continue;
		}
		// A template inside a longer segment, `swagger-ui-{file}`, cannot be one: the example stands in.
		let filled = segment;
		for (const [name, parameter] of byName) filled = filled.replaceAll(`{${name}}`, encodeURIComponent(String(parameter.example)));
		if (filled.includes("{")) throw new Error(`${view.at}: 路径里的 ${segment} 有没有对应参数的模板`);
		segments.push(filled);
	}
	const query = view.parameters
		.filter((entry) => entry.in === "query" && entry.schema?.type !== "object" && typeof entry.example !== "object")
		.map((entry) => ({ key: entry.name, value: String(entry.example), disabled: entry.required !== true }));
	const base = [`{{baseUrl}}`, ...segments].join("/");
	const raw = (base === "{{baseUrl}}" ? `${base}/` : base) + (query.length > 0 ? `?${query.map((entry) => `${entry.key}=${encodeURIComponent(entry.value)}`).join("&")}` : "");
	return {
		raw,
		host: ["{{baseUrl}}"],
		path: segments,
		...(query.length > 0 ? { query } : {}),
		...(variables.length > 0 ? { variable: variables } : {}),
	};
}

function postmanRequest(view) {
	const media = view.bodies[JSON_TYPE];
	const binary = Object.keys(view.operation.requestBody?.content ?? {}).find((type) => type !== JSON_TYPE);
	const header = [{ key: "Accept", value: JSON_TYPE }];
	if (media) header.push({ key: "Content-Type", value: JSON_TYPE });
	if (binary) header.push({ key: "Content-Type", value: binary });
	const body = media
		? { mode: "raw", raw: JSON.stringify(media.example, null, 2), options: { raw: { language: "json" } } }
		: binary
			? { mode: "raw", raw: "这里是文件的内容。\n", options: { raw: { language: "text" } } }
			: undefined;
	return { method: view.method.toUpperCase(), header, ...(body ? { body } : {}), url: postmanUrl(view) };
}

function postmanItem(view) {
	const notes = [view.operation.description ?? "", "", `鉴权：${gatesOf(view)}`].filter(Boolean);
	if (Object.keys(view.operation.requestBody?.content ?? {}).some((type) => type !== JSON_TYPE))
		notes.push("", "请求体是文件的原始字节，不是 multipart。Postman 里把 Body 改成 binary 或 form-data 的 File，选一个文件再发。");
	const responses = [];
	for (const { status, definition } of view.responses) {
		const media = definition.content?.[JSON_TYPE];
		if (!media) continue;
		const code = Number(status);
		responses.push({
			name: `${status} ${brief(definition.description)}`,
			originalRequest: postmanRequest(view),
			status: REASONS[code] ?? "Error",
			code: code >= 100 && code < 600 ? code : 400,
			_postman_previewlanguage: "json",
			header: [
				{ key: "Content-Type", value: "application/json; charset=utf-8" },
				...Object.keys(definition.headers ?? {}).map((name) => ({ key: name, value: HEADER_SAMPLES[name] ?? "…" })),
			],
			cookie: [],
			body: JSON.stringify(media.example, null, 2),
		});
	}
	return {
		name: `${view.operation.summary}  ${view.method.toUpperCase()} ${view.path}`,
		request: { ...postmanRequest(view), description: notes.join("\n") },
		response: responses,
	};
}

/** The operations of one tag, in the order the document lists their paths. */
const tagItems = new Map();
for (const view of operations) {
	const tag = view.operation.tags?.[0];
	if (!tag) throw new Error(`${view.at}: 没有 tags`);
	if (!tagItems.has(tag)) tagItems.set(tag, []);
	tagItems.get(tag).push(postmanItem(view));
}
// The folders in the order the document lists its tags, as a reader meets the features.
const tagOrder = (source.tags ?? []).map((entry) => entry.name);
for (const tag of tagItems.keys()) {
	if (!tagOrder.includes(tag)) throw new Error(`${tag}: 操作用到了 tags 里没有的分组`);
}
const folders = [...tagItems].sort(([left], [right]) => tagOrder.indexOf(left) - tagOrder.indexOf(right));

const find = (at) => {
	const view = operations.find((entry) => entry.at === at);
	if (!view) throw new Error(`找不到 ${at}`);
	return view;
};
/** An operation with the account read from the environment, instead of the example's. */
const withAccount = (at, name) => {
	const item = postmanItem(find(at));
	item.request.body.raw = item.request.body.raw
		.replaceAll('"username": "operator"', '"username": "{{username}}"')
		.replace(/"password": "[^"]*"/, '"password": "{{password}}"');
	return { ...item, name };
};
const firstSteps = {
	name: "0. 先做这三步",
	item: [
		{
			name: "打开入口地址（拿到入口 Cookie）",
			request: {
				method: "GET",
				header: [],
				url: { raw: "{{baseUrl}}/{{gateToken}}", host: ["{{baseUrl}}"], path: ["{{gateToken}}"] },
				description: [
					"后端每次启动打印一个入口地址 `/<入口串>`，把它填进环境变量 `gateToken`。",
					"打开它，后端回 `302` 到 `/` 并下发 `sentinel-gate` Cookie，Postman 会像浏览器一样记住它。",
					"之后所有请求自动带上。入口串每次重启都变，重启后要重新打开一次。",
				].join("\n\n"),
			},
			response: [
				{
					name: "302 Found",
					originalRequest: { method: "GET", header: [], url: { raw: "{{baseUrl}}/{{gateToken}}", host: ["{{baseUrl}}"], path: ["{{gateToken}}"] } },
					status: "Found",
					code: 302,
					_postman_previewlanguage: "text",
					header: [
						{ key: "Location", value: "/" },
						{ key: "Set-Cookie", value: "sentinel-gate=<值>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000" },
					],
					cookie: [],
					body: "",
				},
			],
		},
		withAccount("POST /api/auth/setup", "首次使用：创建管理员账号（只需一次）"),
		withAccount("POST /api/auth/login", "或者：登录"),
		{ ...postmanItem(find("POST /api/consent/accept")), name: "接受授权承诺（每个账号只需一次）" },
	],
	description:
		"三道门依次过：入口 Cookie、登录、授权承诺。下面各分组里的接口，除了「入口与登录」「授权承诺」「界面语言」「运行状态」和「非浏览器调用方」，都要求这三步都做过。请求里的账号是环境变量 `username` 和 `password`。",
};

const websocketFolder = {
	name: "WebSocket /ws",
	item: [
		{
			name: "连接说明（先读这个）",
			request: { method: "GET", header: [], url: { raw: "{{wsHost}}/ws", protocol: "ws", host: ["{{wsHost}}"], path: ["ws"] }, body: { mode: "raw", raw: "", options: { raw: { language: "text" } } } },
			description: [
				"控制台的大部分功能走一条 WebSocket：`{{wsHost}}/ws`。握手时要带入口 Cookie 和会话 Cookie，Postman 会附上它为这个域名保存的 Cookie。",
				"握手被拒时，先看请求右上角的 Cookies 里有没有 `sentinel-gate` 和 `sentinel-auth` 两个（域名要和 `baseUrl` 的一致），没有就照「0. 先做这三步」在同一个域名下请求一次。",
				"",
				"没带入口 Cookie 时握手回 `404`；没登录回 `401`；没接受授权承诺回 `403`。",
				"",
				"一帧一条 JSON 对象，`type` 是消息名，其余字段平铺在同一层。连接建立后服务端依次推 `ui_config`、`snapshot`、`projects` 等 11 种消息，",
				"每 25 秒 ping 一次。只记最后一次登录：别处登录后这条连接以关闭码 `4001` 关闭。",
				"",
				`${CLIENT_COUNT + SERVER_COUNT} 种消息的结构、样例和服务端会回什么，在同目录的 websocket-messages.json；每种消息的完整说明在 docs/contract/websocket/ 下。`,
				"下面每个功能域一条请求，说明里列了这个域全部上行消息的样例，复制一条发出去即可。",
			].join("\n"),
			response: [],
		},
	],
	description: "每个功能域一条 WebSocket 请求，说明里有这个域的上行消息样例。导入 Postman 后类型是 WebSocket；导入别的工具时可能被当成普通请求，那就手动新建一个 WebSocket 请求，地址是 `{{wsHost}}/ws`。",
};

// ---------------------------------------------------------------------------
// WebSocket

const documented = documentedSections();
const websocketDefs = new Map();

/** A generated definition and the ones it refers to, as the catalog states them. */
function takeWs(name) {
	if (websocketDefs.has(name)) return;
	const definition = generated.$defs[name];
	if (!definition) throw new Error(`生成的结构里没有定义 ${name}`);
	websocketDefs.set(name, null);
	for (const reference of referencesIn(definition)) takeWs(reference);
	websocketDefs.set(name, definition);
}
function referencesIn(node) {
	if (Array.isArray(node)) return node.flatMap(referencesIn);
	if (!node || typeof node !== "object") return [];
	const own = typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/") ? [node.$ref.slice("#/$defs/".length)] : [];
	return [...own, ...Object.values(node).flatMap(referencesIn)];
}

/** The paragraph before the table: what the message is for. */
function lead(section) {
	return section.body.trim().split(/\n\s*\n/)[0].trim();
}

const catalog = { client: {}, server: {} };
const byDomain = new Map(Object.entries(DOMAINS).map(([file, domain]) => [file, { file, ...domain }]));
for (const [file, domain] of byDomain) {
	for (const type of domain.client) {
		const section = documented.client.get(type);
		if (!section) throw new Error(`${file}: 找不到上行消息 ${type} 的条目`);
		const rows = summary(section);
		const root = generated.roots[`Ws.client.${type}`];
		if (!root?.$ref?.startsWith("#/$defs/")) throw new Error(`${file}: 上行消息 ${type} 没有生成的结构`);
		takeWs(root.$ref.slice("#/$defs/".length));
		catalog.client[type] = {
			domain: file,
			description: lead(section),
			fields: rows.fields,
			replies: codeSpans(rows.replies ?? ""),
			broadcasts: codeSpans(rows.broadcasts ?? ""),
			failures: rows.failures,
			schema: { $ref: root.$ref },
			example: jsonExample(section),
		};
		checkedIn(generated, root, catalog.client[type].example, `上行消息 ${type} 的样例`);
	}
	for (const type of domain.server) {
		const section = documented.server.get(type);
		if (!section) throw new Error(`${file}: 找不到下行消息 ${type} 的条目`);
		const root = generated.roots[`Ws.server.${type}`];
		if (!root?.$ref?.startsWith("#/$defs/")) throw new Error(`${file}: 下行消息 ${type} 没有生成的结构`);
		takeWs(root.$ref.slice("#/$defs/".length));
		catalog.server[type] = {
			domain: file,
			description: lead(section),
			fields: summary(section).fields,
			sentWhen: summary(section).sentWhen,
			schema: { $ref: root.$ref },
			example: jsonExample(section),
		};
		checkedIn(generated, root, catalog.server[type].example, `下行消息 ${type} 的样例`);
	}
}
for (const key of Object.keys(generated.roots)) {
	const [direction, type] = key.replace(/^Ws\./, "").split(".");
	if (!key.startsWith("Ws.") || catalog[direction]?.[type]) continue;
	throw new Error(`消息 ${type} 有生成的结构，但没有文档条目`);
}

const websocket = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$comment: "由 scripts/generate-contract-api.mjs 生成，不要手改。WebSocket `/ws` 上每一种消息的结构、样例和服务端的回应。",
	title: "全链哨兵 WebSocket 消息",
	description: [
		`一帧一条 JSON 对象，\`type\` 是消息名，其余字段平铺在同一层。\`messages.client\` 是浏览器发给服务端的 ${CLIENT_COUNT} 种，\`messages.server\` 是服务端发给浏览端的 ${SERVER_COUNT} 种。`,
		"每条的 `schema` 指向 `$defs` 里的 JSON Schema（draft 2020-12），`example` 是一个符合它的样例。",
		"上行消息另有 `replies`（只回给发出消息的连接的消息）、`broadcasts`（发给所有连接的消息）、`failures`（处理失败时回的 `error` 文案）；",
		"下行消息另有 `sentWhen`（什么情况下发出）。`domain` 是功能域，完整说明在 docs/contract/websocket/<domain>.md。",
		"每种消息的完整说明在 docs/contract/websocket/ 下，先读 connection.md。",
	].join("\n"),
	connection: {
		path: "/ws",
		url: "{{wsHost}}/ws",
		gates: "握手和 HTTP 一样要过三道门：没有入口 Cookie 回 404，没有会话 Cookie 回 401，账号没接受授权承诺回 403。Cookie 随握手请求发送。",
		heartbeat: "服务端每 25 秒 ping 一次，90 秒收不到 pong 就断开。客户端要回 pong（浏览器的 WebSocket 实现会自动回）。",
		onConnect: "连接建立后依次推送 ui_config、snapshot、projects、engines、doctrines、gatekeeper_config、model_library、asset_config、websearch_config、mcp_servers、proxy_config。",
		replaced: "只记最后一次登录。别处登录、退出登录或修改密码后，这条连接以关闭码 4001 关闭，原因分别是 session_replaced 和 session_expired。收到后重新登录再连接。",
		unknown: "发来不认识的消息名，回 {\"type\":\"error\",\"message\":\"未知消息类型: <消息名>\"}；发来不是 JSON 的帧，回一条 `error`。",
	},
	domains: Object.fromEntries(
		Object.entries(DOMAINS).map(([file, domain]) => [file, { title: domain.title, document: `../websocket/${file}.md`, client: domain.client.length, server: domain.server.length }]),
	),
	messages: catalog,
	$defs: Object.fromEntries(websocketDefs),
};

// One WebSocket request per domain, with the examples of its browser messages in the description.
for (const [file, domain] of byDomain) {
	const lines = [
		`${domain.title}。地址 \`{{wsHost}}/ws\`，先看「连接说明」。`,
		"",
		`这个域有 ${domain.client.length} 种上行消息、${domain.server.length} 种下行消息。下面是每种上行消息的样例，复制一条发送；`,
		"它会回什么、会广播什么、失败时回什么，在 docs/contract/websocket/" + file + ".md。",
	];
	for (const type of domain.client) {
		const entry = catalog.client[type];
		lines.push("", `### \`${type}\``, "", entry.description, "", "发送：", "```json", JSON.stringify(entry.example, null, 2), "```");
		const answers = [
			entry.replies.length > 0 ? `回给发送方：${entry.replies.map((name) => `\`${name}\``).join("、")}` : "",
			entry.broadcasts.length > 0 ? `广播给所有连接：${entry.broadcasts.map((name) => `\`${name}\``).join("、")}` : "",
			entry.failures && entry.failures !== "无" ? `失败时：${entry.failures}` : "",
		].filter(Boolean);
		if (answers.length > 0) lines.push("", ...answers);
	}
	websocketFolder.item.push({
		name: `${domain.title}  /ws`,
		request: { method: "GET", header: [], url: { raw: "{{wsHost}}/ws", protocol: "ws", host: ["{{wsHost}}"], path: ["ws"] }, body: { mode: "raw", raw: "", options: { raw: { language: "text" } } } },
		description: lines.join("\n"),
		response: [],
	});
}

// ---------------------------------------------------------------------------
// The outputs

const collection = {
	info: {
		_postman_id: stableId("sentinel-web", WEB_CONSOLE_VERSION),
		name: "全链哨兵 Web 控制台 HTTP 接口",
		description: [
			`版本 ${WEB_CONSOLE_VERSION}。由 scripts/generate-contract-api.mjs 生成。`,
			"",
			"先看「0. 先做这三步」。环境变量 `baseUrl`、`gateToken`、`username`、`password`、`wsHost` 在同名的环境文件里。",
			"每个请求的 Examples 里存着每种状态码的响应样例。",
			"",
			"WebSocket 消息在最后一个分组，结构见 websocket-messages.json。",
		].join("\n"),
		schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
		version: WEB_CONSOLE_VERSION,
	},
	variable: VARIABLES.map(({ key, value }) => ({ key, value })),
	item: [firstSteps, ...folders.map(([name, item]) => ({ name, item })), websocketFolder],
};
const environment = {
	id: stableId("sentinel-web-environment", WEB_CONSOLE_VERSION),
	name: "全链哨兵：本地",
	values: VARIABLES.map(({ key, value, secret, description }) => ({
		key,
		value,
		type: secret ? "secret" : "default",
		enabled: true,
		description,
	})),
	_postman_variable_scope: "environment",
	_postman_exported_at: AT,
	_postman_exported_using: "scripts/generate-contract-api.mjs",
};

const outputs = new Map([
	["http-api.json", httpApi],
	["sentinel.postman_collection.json", `${JSON.stringify(collection, null, "\t")}\n`],
	["sentinel.postman_environment.json", `${JSON.stringify(environment, null, "\t")}\n`],
	["websocket-messages.json", `${JSON.stringify(websocket, null, "\t")}\n`],
]);

// Every `{{variable}}` the Postman files mention is one the environment defines.
for (const name of ["sentinel.postman_collection.json", "sentinel.postman_environment.json"])
	for (const [, key] of outputs.get(name).matchAll(/\{\{(\w+)\}\}/g))
		if (!VARIABLES.some((variable) => variable.key === key)) throw new Error(`${name} 用到了没有定义的变量 ${key}`);

let stale = 0;
for (const [name, contents] of outputs) {
	const file = join(outDir, name);
	if (checking) {
		const current = readFileSync(file, "utf8");
		if (current !== contents) {
			stale += 1;
			console.error(`${show(file)} 与契约的来源不一致，请运行 npm run generate:contract-api。`);
		}
		continue;
	}
	mkdirSync(outDir, { recursive: true });
	writeFileSync(file, contents);
}
if (stale > 0) process.exit(1);
if (!checking) {
	console.log(
		`已生成 ${show(outDir)}：${operations.length} 个 HTTP 操作，${Object.keys(catalog.client).length} 种上行消息，${Object.keys(catalog.server).length} 种下行消息`,
	);
}
