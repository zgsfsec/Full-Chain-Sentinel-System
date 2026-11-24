/**
 * The documents the frontend imports, under docs/contract/frontend.
 *
 * They are generated, so what is checked here is that each says what its
 * sources say and can be used as it is:
 *
 * - every reference in the OpenAPI document resolves, and the document uses
 *   only what OpenAPI 3.0 allows;
 * - every example conforms to the schema next to it;
 * - the Postman collection sends what the OpenAPI document's examples say, and
 *   its saved answers are the document's;
 * - the WebSocket catalog has every message, with the example and the answers
 *   that its entry in docs/contract/websocket lists.
 *
 * Whether the files are stale is `npm run check:contract-api`'s to say.
 */

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { WEB_CONSOLE_VERSION } from "../../src/assets.ts";
import { DOMAINS } from "./domains.ts";
import { CLIENT_EXAMPLES, SERVER_EXAMPLES } from "./examples/index.ts";
import { codeSpans, documentedSections, jsonExample, summary } from "./markdown.ts";
import { resolveReference, type Schema, type SchemaSource, validate } from "./schema.ts";

interface MediaType {
	schema?: Schema;
	example?: unknown;
}
interface Parameter {
	name: string;
	in: string;
	required?: boolean;
	schema?: Schema;
	example?: unknown;
	$ref?: string;
}
interface Response {
	description?: string;
	content?: Record<string, MediaType>;
	$ref?: string;
}
interface Operation {
	summary?: string;
	description?: string;
	parameters?: Parameter[];
	requestBody?: { content?: Record<string, MediaType> };
	responses?: Record<string, Response>;
}
interface Document extends SchemaSource {
	openapi: string;
	info: { version: string; description: string };
	paths: Record<string, Record<string, unknown>>;
	components: {
		schemas: Record<string, Schema>;
		parameters: Record<string, Parameter>;
		responses: Record<string, Response>;
	};
}
interface Saved {
	code: number;
	body: string;
}
interface Item {
	name: string;
	request?: {
		method: string;
		description?: string;
		url: {
			raw: string;
			path?: string[];
			query?: { key: string; value: string; disabled?: boolean }[];
			variable?: { key: string; value: string }[];
		};
		body?: { raw?: string };
	};
	item?: Item[];
	response?: Saved[];
}
interface Collection {
	info: { name: string; schema: string };
	variable: { key: string; value: string }[];
	item: Item[];
}

const read = (name: string): unknown =>
	JSON.parse(readFileSync(new URL(`../../docs/contract/frontend/${name}`, import.meta.url), "utf8"));
const spec = read("http-api.json") as Document;
const collection = read("sentinel.postman_collection.json") as Collection;
const environment = read("sentinel.postman_environment.json") as { values: { key: string; value: string }[] };
const catalog = read("websocket-messages.json") as SchemaSource & {
	messages: {
		client: Record<
			string,
			{
				domain: string;
				description: string;
				replies: string[];
				broadcasts: string[];
				failures?: string;
				schema: Schema;
				example: unknown;
			}
		>;
		server: Record<
			string,
			{ domain: string; description: string; sentWhen?: string; schema: Schema; example: unknown }
		>;
	};
};

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const JSON_TYPE = "application/json";
/** What OpenAPI 3.0 lets a schema say. */
const SCHEMA_KEYWORDS = new Set([
	"$ref",
	"title",
	"multipleOf",
	"maximum",
	"exclusiveMaximum",
	"minimum",
	"exclusiveMinimum",
	"maxLength",
	"minLength",
	"pattern",
	"maxItems",
	"minItems",
	"uniqueItems",
	"maxProperties",
	"minProperties",
	"required",
	"enum",
	"type",
	"allOf",
	"oneOf",
	"anyOf",
	"not",
	"items",
	"properties",
	"additionalProperties",
	"description",
	"format",
	"default",
	"nullable",
	"discriminator",
	"readOnly",
	"writeOnly",
	"xml",
	"externalDocs",
	"example",
	"deprecated",
]);
const TYPE_NAMES = new Set(["array", "boolean", "integer", "number", "object", "string"]);

/** Every schema inside a schema: what it defines, and what its keywords hold. */
function* schemaNodes(schema: Schema): Generator<Schema> {
	yield schema;
	for (const [name, keyword] of Object.entries(schema)) {
		if (name === "properties") {
			for (const property of Object.values(keyword as Record<string, Schema>)) yield* schemaNodes(property);
		} else if (["items", "additionalProperties", "not"].includes(name)) {
			const held = keyword as Schema | Schema[] | boolean | undefined;
			if (Array.isArray(held)) for (const item of held) yield* schemaNodes(item);
			else if (held && typeof held === "object") yield* schemaNodes(held);
		} else if (["anyOf", "allOf", "oneOf"].includes(name)) {
			for (const option of keyword as Schema[]) yield* schemaNodes(option);
		}
	}
}

const dereference = <T extends { $ref?: string }>(entry: T): T =>
	entry.$ref ? (resolveReference(entry.$ref, spec) as T) : entry;

function operationsOf(document: Document): [method: string, path: string, operation: Operation][] {
	const found: [string, string, Operation][] = [];
	for (const [path, item] of Object.entries(document.paths))
		for (const method of METHODS)
			if (item[method]) found.push([method.toUpperCase(), path, item[method] as Operation]);
	return found;
}

/** Every object of a document, but not what an example holds: that is data, not schema. */
function* nodes(value: unknown): Generator<Record<string, unknown>> {
	if (Array.isArray(value)) {
		for (const item of value) yield* nodes(item);
		return;
	}
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	yield record;
	for (const [key, item] of Object.entries(record)) if (key !== "example" && key !== "examples") yield* nodes(item);
}

test("the OpenAPI document is 3.0, whole, and resolves every reference", () => {
	expect(spec.openapi).toBe("3.0.3");
	expect(spec.info.version).toBe(WEB_CONSOLE_VERSION);
	const problems: string[] = [];
	const references = [...nodes(spec)].flatMap((node) => (typeof node.$ref === "string" ? [node.$ref] : []));
	// Every reference, once each: the list is long and full of repeats.
	expect(new Set(references).size).toBeGreaterThan(100);
	for (const reference of new Set(references))
		if (!resolveReference(reference, spec)) problems.push(`${reference} does not resolve`);
	for (const name of Object.keys(spec.components.schemas))
		if (!/^[a-zA-Z0-9._-]+$/.test(name)) problems.push(`component ${name} is not a name OpenAPI allows`);
	// The same places the generator converts are the places the keywords are read.
	const schemas: [Schema, string][] = [];
	for (const [method, path, operation] of operationsOf(spec)) {
		for (const parameter of operation.parameters ?? []) {
			const resolved = dereference(parameter);
			if (resolved.schema) schemas.push([resolved.schema, `${method} ${path} parameter ${resolved.name}`]);
		}
		for (const [type, media] of Object.entries(operation.requestBody?.content ?? {}))
			if (media.schema) schemas.push([media.schema, `${method} ${path} body ${type}`]);
		for (const [status, response] of Object.entries(operation.responses ?? {}))
			for (const [type, media] of Object.entries(dereference(response).content ?? {}))
				if (media.schema) schemas.push([media.schema, `${method} ${path} ${status} ${type}`]);
	}
	for (const [name, schema] of Object.entries(spec.components.schemas))
		schemas.push([schema, `components.schemas.${name}`]);
	for (const [schema, where] of schemas)
		for (const node of schemaNodes(schema)) {
			for (const key of Object.keys(node))
				if (!SCHEMA_KEYWORDS.has(key)) problems.push(`${where}: ${key} is not an OpenAPI 3.0 keyword`);
			if (node.type !== undefined && !(typeof node.type === "string" && TYPE_NAMES.has(node.type)))
				problems.push(`${where}: type ${JSON.stringify(node.type)} is not one OpenAPI 3.0 names`);
			if (Array.isArray(node.enum) && node.enum.includes(null))
				problems.push(`${where}: null inside enum, which 3.0 writes as nullable`);
			if (Array.isArray(node.required) && node.required.length === 0)
				problems.push(`${where}: an empty required list`);
		}
	expect(problems).toEqual([]);
});

test("the OpenAPI document describes the operations of openapi.yaml, with their words", () => {
	const source = parse(readFileSync(new URL("../../docs/contract/openapi.yaml", import.meta.url), "utf8")) as Document;
	expect(operationsOf(spec).map(([method, path]) => `${method} ${path}`)).toEqual(
		operationsOf(source).map(([method, path]) => `${method} ${path}`),
	);
	const changed: string[] = [];
	for (const [method, path, operation] of operationsOf(spec)) {
		const original = operationsOf(source).find(([m, p]) => m === method && p === path)?.[2];
		for (const field of ["summary", "description"] as const)
			if (operation[field] !== original?.[field]) changed.push(`${method} ${path}: ${field}`);
	}
	expect(changed).toEqual([]);
});

test("every example of the OpenAPI document conforms to the schema next to it", () => {
	const problems: string[] = [];
	let count = 0;
	const check = (schema: Schema | undefined, example: unknown, where: string) => {
		if (!schema || example === undefined) return;
		count += 1;
		for (const failure of validate(schema, example, spec)) problems.push(`${where}: ${failure}`);
	};
	for (const [method, path, operation] of operationsOf(spec)) {
		for (const parameter of operation.parameters ?? []) {
			const resolved = dereference(parameter);
			if (resolved.example === undefined)
				problems.push(`${method} ${path}: parameter ${resolved.name} has no example`);
			check(resolved.schema, resolved.example, `${method} ${path} parameter ${resolved.name}`);
		}
		for (const [type, media] of Object.entries(operation.requestBody?.content ?? {}))
			check(media.schema, media.example, `${method} ${path} body ${type}`);
		for (const [status, response] of Object.entries(operation.responses ?? {}))
			for (const [type, media] of Object.entries(dereference(response).content ?? {}))
				check(media.schema, media.example, `${method} ${path} ${status} ${type}`);
	}
	for (const parameter of Object.values(spec.components.parameters))
		check(parameter.schema, parameter.example, `components.parameters.${parameter.name}`);
	for (const [name, response] of Object.entries(spec.components.responses))
		for (const [type, media] of Object.entries(response.content ?? {}))
			check(media.schema, media.example, `components.responses.${name} ${type}`);
	expect(problems).toEqual([]);
	// Every JSON answer carries an example, so the count is in the hundreds.
	expect(count).toBeGreaterThan(500);
});

test("the Postman collection sends the OpenAPI document's examples and saves its answers", () => {
	// Three parts: the way in, one folder per tag, and the WebSocket.
	expect(collection.item[0].name).toMatch(/^0\./);
	expect(collection.item.at(-1)?.name).toBe("WebSocket /ws");
	const problems: string[] = [];
	const operations = operationsOf(spec);
	const pathParameters = (operation: Operation): Parameter[] =>
		(operation.parameters ?? []).map(dereference).filter((parameter) => parameter.in === "path");
	/** The path as the collection writes it: `:id` for a whole-segment template, the example for one inside a segment. */
	const written = (path: string, operation: Operation): string =>
		path
			.split("/")
			.map((segment) => {
				if (/^\{\w+\}$/.test(segment)) return `:${segment.slice(1, -1)}`;
				for (const parameter of pathParameters(operation))
					segment = segment.replaceAll(`{${parameter.name}}`, encodeURIComponent(String(parameter.example)));
				return segment;
			})
			.join("/");
	let seen = 0;
	for (const folder of collection.item.slice(1, -1)) {
		let last = -1;
		for (const item of folder.item ?? []) {
			const url = item.request?.url;
			// The operation whose path, written as the collection writes it, is this request's.
			const matches = operations
				.map(([method, path, operation], index) => ({ method, path, operation, index }))
				.filter(
					(entry) =>
						entry.method === item.request?.method &&
						`/${written(entry.path, entry.operation).split("/").filter(Boolean).join("/")}` ===
							`/${(url?.path ?? []).join("/")}`,
				);
			if (!url || matches.length !== 1) {
				problems.push(`${item.request?.method} ${url?.raw}: ${matches.length} operations of the document match`);
				continue;
			}
			const { method, path, operation, index } = matches[0];
			const at = `${method} ${path}`;
			seen += 1;
			// Within a folder the requests are in the document's order.
			if (index < last) problems.push(`${at}: out of the document's order`);
			last = index;
			if (!url?.raw.startsWith("{{baseUrl}}/")) problems.push(`${at}: the URL does not start with {{baseUrl}}`);
			if (!item.request?.description?.includes("鉴权"))
				problems.push(`${at}: the request does not say what the gates ask`);
			const parameters = (operation.parameters ?? []).map(dereference);
			const query = parameters.filter((parameter) => parameter.in === "query");
			if (
				JSON.stringify((url.query ?? []).map((entry) => [entry.key, entry.value, entry.disabled === true])) !==
				JSON.stringify(
					query.map((parameter) => [parameter.name, String(parameter.example), parameter.required !== true]),
				)
			)
				problems.push(`${at}: the query differs from the document's parameters`);
			for (const parameter of pathParameters(operation)) {
				const value = String(parameter.example);
				const set = url.variable?.some((entry) => entry.key === parameter.name && entry.value === value);
				// A template inside a longer segment is not a variable: its example stands in the segment.
				const filled = url.path?.some((segment) => segment.includes(encodeURIComponent(value)));
				if (!set && !filled) problems.push(`${at}: no value for path parameter ${parameter.name}`);
			}
			const body = operation.requestBody?.content?.[JSON_TYPE];
			if (body && JSON.stringify(JSON.parse(item.request?.body?.raw ?? "null")) !== JSON.stringify(body.example))
				problems.push(`${at}: the body differs from the document's example`);
			// The saved answers are the document's, one per JSON answer.
			const answers = Object.entries(operation.responses ?? {})
				.map(([status, response]) => [status, dereference(response).content?.[JSON_TYPE]] as const)
				.filter((entry): entry is readonly [string, MediaType] => entry[1] !== undefined);
			if (item.response?.length !== answers.length)
				problems.push(`${at}: ${item.response?.length} saved answers for ${answers.length} in the document`);
			item.response?.forEach((saved, position) => {
				const [status, media] = answers[position] ?? [];
				if (!media) return;
				const code = status.endsWith("xx") ? 400 : Number(status);
				if (saved.code !== code)
					problems.push(`${at}: saved answer ${position} is ${saved.code}, the document says ${status}`);
				if (saved.body !== JSON.stringify(media.example, null, 2))
					problems.push(`${at}: saved answer ${status} differs from the document's example`);
			});
		}
	}
	// Every operation once, in a folder.
	expect(seen).toBe(operations.length);
	expect(problems).toEqual([]);
});

test("the first steps open the entry URL, create the account or log in, and accept", () => {
	const steps = collection.item[0].item ?? [];
	expect(steps.map((step) => step.request?.url.raw)).toEqual([
		"{{baseUrl}}/{{gateToken}}",
		expect.stringMatching(/^{{baseUrl}}\/api\/auth\/setup$/),
		expect.stringMatching(/^{{baseUrl}}\/api\/auth\/login$/),
		expect.stringMatching(/^{{baseUrl}}\/api\/consent\/accept$/),
	]);
	expect(JSON.parse(steps[1].request?.body?.raw ?? "null")).toEqual({
		username: "{{username}}",
		password: "{{password}}",
	});
	expect(JSON.parse(steps[2].request?.body?.raw ?? "null")).toEqual({
		username: "{{username}}",
		password: "{{password}}",
		remember: true,
	});
});

test("every variable the Postman files use is one the environment defines", () => {
	const keys = environment.values.map((entry) => entry.key);
	expect([...keys].sort()).toEqual(["baseUrl", "gateToken", "password", "username", "wsHost"]);
	expect(environment.values.every((entry) => typeof entry.value === "string")).toBe(true);
	expect(collection.variable.map((entry) => entry.key).sort()).toEqual([...keys].sort());
	// Only where Postman substitutes them: names, descriptions and saved answers are text.
	const requests = JSON.stringify(collection, (key, value) =>
		["name", "description", "response", "info"].includes(key) ? undefined : value,
	);
	const used = new Set([...requests.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]));
	expect([...used].filter((key) => !keys.includes(key))).toEqual([]);
});

test("the WebSocket catalog has every message with its example and what the server answers", () => {
	expect(Object.keys(catalog.messages.client).sort()).toEqual(Object.keys(CLIENT_EXAMPLES).sort());
	expect(Object.keys(catalog.messages.server).sort()).toEqual(Object.keys(SERVER_EXAMPLES).sort());
	const problems: string[] = [];
	const documented = documentedSections();
	for (const [direction, entries] of [
		["client", catalog.messages.client],
		["server", catalog.messages.server],
	] as const)
		for (const [type, entry] of Object.entries(entries)) {
			const domain = entry.domain in DOMAINS ? DOMAINS[entry.domain as keyof typeof DOMAINS] : undefined;
			const section = documented[direction].get(type);
			if (!domain || !section || !(domain[direction] as readonly string[]).includes(type)) {
				problems.push(`${direction} ${type}: domain ${entry.domain} does not list it`);
				continue;
			}
			const rows = summary(section);
			if (JSON.stringify(entry.example) !== JSON.stringify(jsonExample(section)))
				problems.push(`${direction} ${type}: example differs from the entry's`);
			if (!entry.description.trim()) problems.push(`${direction} ${type}: no description`);
			for (const failure of validate(entry.schema, entry.example, catalog))
				problems.push(`${direction} ${type}: ${failure}`);
			if (direction === "client") {
				if (JSON.stringify(entry.replies) !== JSON.stringify(codeSpans(rows.replies ?? "")))
					problems.push(`client ${type}: replies`);
				if (JSON.stringify(entry.broadcasts) !== JSON.stringify(codeSpans(rows.broadcasts ?? "")))
					problems.push(`client ${type}: broadcasts`);
				if (entry.failures !== rows.failures) problems.push(`client ${type}: failures`);
			} else if (entry.sentWhen !== rows.sentWhen) problems.push(`server ${type}: sentWhen`);
		}
	expect(problems).toEqual([]);
	// One WebSocket request per domain, on the address the environment names.
	const folder = collection.item.at(-1)?.item ?? [];
	expect(folder).toHaveLength(Object.keys(DOMAINS).length + 1);
	for (const item of folder) expect(item.request?.url.raw).toBe("{{wsHost}}/ws");
});

test("the WebSocket catalog resolves every reference it makes", () => {
	const references = [...nodes(catalog)].flatMap((node) => (typeof node.$ref === "string" ? [node.$ref] : []));
	expect(references.length).toBeGreaterThan(500);
	expect([...new Set(references)].filter((reference) => !resolveReference(reference, catalog))).toEqual([]);
});

test("the source record of the schemas leaves out the embedded console", () => {
	// The embedded asset module holds the built console as strings. Its content
	// changes with every frontend build and its types never do. With it in the
	// record, every rebuild made `npm run check` report the schemas as stale.
	const { files } = (read("schemas.generated.json") as { typesSource: { files: string[] } }).typesSource;
	expect(files).not.toContain("packages/web/src/embedded-assets.generated.ts");
	// What the documents are made of is still recorded.
	expect(files).toContain("packages/web/src/protocol.ts");
	expect(files).toContain("tsconfig.json");
});
