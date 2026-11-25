/**
 * The HTTP document against the real server.
 *
 * Sends every operation of docs/contract/frontend/http-api.json to a backend,
 * the way the document's example says, and checks three things for each:
 *
 * - the status is one the document lists for that operation, and the one the
 *   step expects once the steps before it have run;
 * - a JSON answer conforms to the schema the document gives for that status;
 * - what the server answers is what a later example needs: the ids, versions
 *   and tokens of later requests are taken from earlier answers, never typed in.
 *
 * The backend is reached only the way a browser reaches it, so the same test
 * runs against a rewritten backend: see contract-target.ts. Against another
 * backend the steps that change what it stores are sent only with
 * SENTINEL_CONTRACT_DESTRUCTIVE=1, and nothing is seeded beforehand.
 *
 * Operations that would reach the network, run a container or start an agent
 * are not sent; each says why in NOT_SENT.
 */

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type ContractTarget, openContractTarget, type Reply } from "./contract-target.ts";
import { resolveReference, type Schema, type SchemaSource, validate } from "./schema.ts";

interface MediaType {
	schema?: Schema;
	example?: unknown;
}
interface Parameter {
	name: string;
	in: string;
	required?: boolean;
	example?: unknown;
	$ref?: string;
}
interface Response {
	description: string;
	content?: Record<string, MediaType>;
	$ref?: string;
}
interface Operation {
	parameters?: Parameter[];
	requestBody?: { content?: Record<string, MediaType> };
	responses?: Record<string, Response>;
}
/** The frontend's OpenAPI document, as far as this test reads it. */
interface Document extends SchemaSource {
	paths: Record<string, Record<string, unknown>>;
	components: {
		schemas?: Record<string, Schema>;
		parameters?: Record<string, Parameter>;
		responses?: Record<string, Response>;
	};
}

type Json = Record<string, unknown>;

const api = JSON.parse(
	readFileSync(new URL("../../docs/contract/frontend/http-api.json", import.meta.url), "utf8"),
) as Document;
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const JSON_TYPE = "application/json";
const NO_REPORT = "00000000-0000-0000-0000-000000000000";
const EXAMPLE_PASSWORD = "change-me-please";

function dereference<T extends { $ref?: string }>(entry: T): T {
	return entry.$ref ? (resolveReference(entry.$ref, api) as T) : entry;
}

function operationOf(method: string, path: string): Operation | undefined {
	return api.paths[path]?.[method.toLowerCase()] as Operation | undefined;
}

/** The parameters of an operation: its own, and the path's that it does not repeat. */
function parametersOf(method: string, path: string): Parameter[] {
	const item = api.paths[path] ?? {};
	const own = (operationOf(method, path)?.parameters ?? []).map(dereference);
	const names = new Set(own.map((parameter) => `${parameter.in} ${parameter.name}`));
	const shared = (Array.isArray(item.parameters) ? (item.parameters as Parameter[]) : []).map(dereference);
	return [...shared.filter((parameter) => !names.has(`${parameter.in} ${parameter.name}`)), ...own];
}

/** What the document says about an answer with this status: an exact status, or its `4xx`. */
function documented(method: string, path: string, status: number): Response | undefined {
	const responses = operationOf(method, path)?.responses ?? {};
	const exact = responses[String(status)];
	if (exact) return dereference(exact);
	const pattern = responses[`${Math.floor(status / 100)}xx`];
	return pattern ? dereference(pattern) : undefined;
}

/** The value at a path like `items.0.id`, or undefined. */
function at(value: unknown, path: string): unknown {
	let node = value;
	for (const key of path.split(".")) node = (node as Record<string, unknown> | undefined | null)?.[key];
	return node;
}

/** The example with the current project where the example's placeholder project stands. */
function withProject(value: unknown, projectId: string): unknown {
	if (Array.isArray(value)) return value.map((item) => withProject(item, projectId));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Json).map(([key, item]) => [
			key,
			typeof item === "string" && (key === "projectId" || key === "confirmProjectId")
				? projectId
				: withProject(item, projectId),
		]),
	);
}

/** What a step changes in the request before it is sent. */
interface Sent {
	path?: Record<string, string>;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	body?: unknown;
}
interface Context {
	target: ContractTarget;
	/** "" when the backend has no selected project. */
	projectId: string;
	password: string;
	kept: Record<string, unknown>;
}
type Prepare = (context: Context, example: unknown) => Sent | undefined;
interface Step {
	method: string;
	path: string;
	/** The status, or one of the statuses, the answer has once the steps before it ran. */
	status: number | number[];
	/** Whether it changes what the backend has stored. */
	changes?: boolean;
	prepare?: Prepare;
	keep?: (context: Context, reply: Reply) => void | Promise<void>;
}

/** The first asset of the project, as the browser asks for it over the WebSocket. */
async function firstAssetId(context: Context): Promise<string> {
	const socket = await context.target.socket();
	try {
		socket.send({ type: "list_assets" });
		const message = (await socket.next((entry) => entry.type === "assets", 15_000)) as { items?: { id?: string }[] };
		return text(message.items?.[0]?.id);
	} finally {
		socket.close();
	}
}

const body = (reply: Reply): Json => reply.json();
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The operations in the order a frontend meets them. An operation that needs
 * something an earlier one made reads it out of that one's answer.
 */
const STEPS: Step[] = [
	// The account and the three gates.
	{ method: "GET", path: "/api/auth/state", status: 200 },
	{
		method: "POST",
		path: "/api/auth/setup",
		status: 200,
		changes: true,
		keep: (context) => {
			context.password = EXAMPLE_PASSWORD;
		},
	},
	{
		method: "POST",
		path: "/api/auth/login",
		status: 200,
		changes: true,
		prepare: (context) =>
			context.target.mode === "external"
				? { body: { username: context.target.username, password: context.target.password, remember: true } }
				: undefined,
		keep: (context, reply) => {
			context.target.keepCookie(reply.headers.get("set-cookie"));
		},
	},
	{ method: "GET", path: "/api/auth/session", status: 200 },
	{ method: "GET", path: "/api/consent", status: 200 },
	{ method: "POST", path: "/api/consent/accept", status: 200, changes: true },
	{ method: "GET", path: "/api/health", status: 200 },

	// The project
	{
		method: "GET",
		path: "/api/assets/import",
		status: 200,
		keep: (context, reply) => {
			context.projectId = text(body(reply).id);
		},
	},
	{
		method: "POST",
		path: "/api/projects/rename",
		status: 200,
		changes: true,
		prepare: (context) => ({ body: { id: context.projectId, name: "内网渗透" } }),
	},
	{ method: "GET", path: "/api/projects/egress-ip", status: 200 },
	{ method: "GET", path: "/api/code-monitors/project", status: 200 },
	{ method: "POST", path: "/api/code-monitors/project", status: 200, changes: true },

	// Files and POCs
	{ method: "POST", path: "/api/upload", status: 200, changes: true, prepare: () => ({ body: "附件的内容\n" }) },
	{
		method: "POST",
		path: "/api/pocs/import",
		status: 202,
		changes: true,
		prepare: () => ({ body: "id: contract-example\nname: 契约测试 POC\n" }),
		keep: (context, reply) => {
			context.kept.pocJob = text(body(reply).id);
		},
	},
	{
		method: "GET",
		path: "/api/pocs/import/{id}",
		status: 200,
		prepare: (context) => ({ path: { id: text(context.kept.pocJob) } }),
	},
	{ method: "GET", path: "/api/folder-archives/{id}", status: 404 },

	// The asset library
	{ method: "POST", path: "/api/assets/import/preview", status: 200 },
	{
		method: "POST",
		path: "/api/assets/import",
		status: 200,
		changes: true,
		keep: async (context) => {
			context.kept.assetId = await firstAssetId(context);
		},
	},
	{
		method: "POST",
		path: "/api/assets/remarks",
		status: 200,
		changes: true,
		prepare: (context) => ({
			body: { projectId: context.projectId, ids: [context.kept.assetId], remark: "已确认", mode: "append" },
		}),
	},

	// Reports and templates
	{
		method: "GET",
		path: "/api/reports",
		status: 200,
		keep: (context, reply) => {
			context.kept.reportId = at(body(reply), "items.0.id") ?? NO_REPORT;
		},
	},
	{
		method: "GET",
		path: "/api/reports/{id}",
		status: 200,
		prepare: (context) => ({ path: { id: text(context.kept.reportId) } }),
		keep: (context, reply) => {
			if (reply.status === 200) context.kept.revision = text(body(reply).revision);
		},
	},
	{
		method: "PUT",
		path: "/api/reports/{id}",
		status: 200,
		changes: true,
		prepare: (context, example) => ({
			path: { id: text(context.kept.reportId) },
			body: { ...(example as Json), revision: context.kept.revision },
		}),
		keep: (context, reply) => {
			if (reply.status === 200) context.kept.revision = text(body(reply).revision);
		},
	},
	{
		method: "GET",
		path: "/api/reports/{id}/download",
		status: 200,
		prepare: (context) => ({ path: { id: text(context.kept.reportId) } }),
	},
	{
		method: "GET",
		path: "/api/reports/{id}/images/{image}",
		status: 404,
		prepare: (context) => ({ path: { id: text(context.kept.reportId) } }),
	},
	{
		method: "DELETE",
		path: "/api/reports/{id}",
		status: 200,
		changes: true,
		prepare: (context) => ({ path: { id: text(context.kept.reportId) } }),
	},
	{ method: "GET", path: "/api/reports/templates", status: 200 },
	{
		method: "POST",
		path: "/api/reports/templates",
		status: 201,
		changes: true,
		keep: (context, reply) => {
			if (reply.status === 201) context.kept.templateId = text(body(reply).id);
		},
	},
	{
		method: "GET",
		path: "/api/reports/templates/{id}",
		status: 200,
		prepare: (context) => ({ path: { id: text(context.kept.templateId) } }),
		keep: (context, reply) => {
			if (reply.status === 200) context.kept.templateRevision = text(body(reply).revision);
		},
	},
	{
		method: "PUT",
		path: "/api/reports/templates/{id}",
		status: 200,
		changes: true,
		prepare: (context, example) => ({
			path: { id: text(context.kept.templateId) },
			body: { ...(example as Json), revision: context.kept.templateRevision },
		}),
	},
	{
		method: "PUT",
		path: "/api/reports/templates/default",
		status: 200,
		changes: true,
		prepare: (context) => ({ body: { templateId: context.kept.templateId } }),
	},
	{
		method: "DELETE",
		path: "/api/reports/templates/{id}",
		status: 200,
		changes: true,
		prepare: (context) => ({ path: { id: text(context.kept.templateId) } }),
	},

	// Work processes
	{
		method: "GET",
		path: "/api/work-processes",
		status: 200,
		keep: (context, reply) => {
			const items = body(reply).items as { id?: string; title?: string }[];
			const seeded = context.target.seeded?.conversationTitle;
			context.kept.workId = text(items.find((item) => item.title === seeded)?.id);
		},
	},
	{
		method: "GET",
		path: "/api/work-processes/detail",
		status: 200,
		prepare: (context) => ({ query: { id: text(context.kept.workId) } }),
		keep: (context, reply) => {
			if (reply.status !== 200) return;
			context.kept.nodeId = text(at(body(reply), "process.nodes.0.id"));
			context.kept.evidenceId = text(at(body(reply), "process.evidence.0.id"));
		},
	},
	{
		method: "GET",
		path: "/api/work-processes/revisions",
		status: 200,
		prepare: (context) => ({ query: { id: text(context.kept.workId), nodeId: text(context.kept.nodeId) } }),
	},
	{
		method: "GET",
		path: "/api/work-processes/evidence",
		status: 200,
		prepare: (context) => ({ query: { id: text(context.kept.workId), evidenceId: text(context.kept.evidenceId) } }),
	},
	{
		method: "POST",
		path: "/api/work-processes/control",
		status: 200,
		changes: true,
		prepare: (context) => ({ query: { id: text(context.kept.workId) } }),
	},

	// MITM and WebFuzz
	{ method: "GET", path: "/api/mitm", status: 200 },
	{ method: "GET", path: "/api/mitm/storage", status: 200 },
	{ method: "GET", path: "/api/mitm/flows", status: 200 },
	{ method: "GET", path: "/api/mitm/host-filter", status: 200 },
	{ method: "POST", path: "/api/mitm/host-filter", status: 200, changes: true },
	{ method: "GET", path: "/api/mitm/webfuzz", status: 200 },
	{ method: "POST", path: "/api/mitm/config", status: 200, changes: true },
	{ method: "POST", path: "/api/mitm/clear", status: 200, changes: true },
	{ method: "POST", path: "/api/mitm/flows/delete", status: 200, changes: true },
	{ method: "GET", path: "/api/mitm/flows/{flowId}", status: 404 },
	{ method: "GET", path: "/api/mitm/flows/{flowId}/{part}", status: 404 },
	{ method: "GET", path: "/api/mitm/ca.pem", status: 404 },
	{ method: "GET", path: "/api/mitm/ca.crt", status: 404 },
	{ method: "POST", path: "/api/mitm/webfuzz/workspace", status: 200, changes: true },
	{ method: "POST", path: "/api/mitm/webfuzz/import", status: 404 },

	// Intelligence
	{ method: "GET", path: "/api/intelligence/sources", status: 200 },
	{
		method: "POST",
		path: "/api/intelligence/sources",
		status: 200,
		changes: true,
		keep: (context, reply) => {
			if (reply.status !== 200) return;
			context.kept.sourceId = text(at(body(reply), "source.id"));
			context.kept.token = text(body(reply).token);
		},
	},
	{
		method: "POST",
		path: "/api/intelligence/sources/{id}",
		status: 200,
		changes: true,
		prepare: (context) => ({ path: { id: text(context.kept.sourceId) } }),
		keep: (context, reply) => {
			if (reply.status === 200) context.kept.token = text(body(reply).token);
		},
	},
	{ method: "GET", path: "/api/intelligence/policy", status: 200 },
	{ method: "POST", path: "/api/intelligence/policy", status: 200, changes: true },
	{ method: "GET", path: "/api/intelligence/doctrines", status: 200 },
	{ method: "GET", path: "/api/intelligence/guide", status: 200 },
	{
		method: "POST",
		path: "/api/intelligence/v1/ingest",
		status: 200,
		changes: true,
		prepare: (context) => ({ headers: { Authorization: `Bearer ${text(context.kept.token)}` } }),
	},
	{ method: "GET", path: "/api/intelligence/ips", status: 200 },
	{ method: "GET", path: "/api/intelligence/alerts", status: 200 },
	{ method: "GET", path: "/api/intelligence/batches", status: 200 },
	{ method: "GET", path: "/api/intelligence/batches/{id}", status: 404 },
	{ method: "POST", path: "/api/intelligence/batches/{id}/{action}", status: 404 },
	{ method: "POST", path: "/api/intelligence/cleanup/preview", status: 200 },
	{ method: "POST", path: "/api/intelligence/cleanup", status: 200, changes: true },
	{ method: "POST", path: "/api/intelligence/clear", status: 200, changes: true },

	// Security checks
	{ method: "GET", path: "/api/security-checks", status: 200 },
	{
		method: "POST",
		path: "/api/security-checks/rules/save",
		status: 200,
		changes: true,
		keep: (context, reply) => {
			if (reply.status !== 200) return;
			context.kept.ruleId = text(body(reply).id);
			context.kept.ruleVersion = text(body(reply).version);
		},
	},
	{
		method: "GET",
		path: "/api/security-checks/rule",
		status: 200,
		prepare: (context) => ({ query: { id: text(context.kept.ruleId) } }),
	},
	{
		method: "POST",
		path: "/api/security-checks/sources/save",
		status: 200,
		changes: true,
		keep: (context, reply) => {
			if (reply.status === 200) context.kept.checkSource = text(body(reply).id);
		},
	},
	{
		method: "GET",
		path: "/api/security-checks/history",
		status: 200,
		prepare: (context) => ({ query: { sourceId: text(context.kept.checkSource) } }),
	},
	{
		method: "POST",
		path: "/api/security-checks/sources/delete",
		status: 200,
		changes: true,
		prepare: (context) => ({ body: { id: context.kept.checkSource } }),
	},
	{
		method: "POST",
		path: "/api/security-checks/rules/delete",
		status: 200,
		changes: true,
		prepare: (context) => ({ body: { id: context.kept.ruleId, version: context.kept.ruleVersion } }),
	},

	// Credentials
	{ method: "GET", path: "/api/credentials", status: 200 },
	{
		method: "POST",
		path: "/api/credentials/save",
		status: 200,
		changes: true,
		keep: (context, reply) => {
			if (reply.status !== 200) return;
			context.kept.credentialId = text(at(body(reply), "items.0.id"));
			context.kept.credentialRevision = text(at(body(reply), "items.0.revision"));
		},
	},
	{
		method: "POST",
		path: "/api/credentials/import/preview",
		status: 200,
		keep: (context, reply) => {
			if (reply.status === 200) context.kept.importVersion = text(body(reply).version);
		},
	},
	{
		method: "POST",
		path: "/api/credentials/import/apply",
		status: 200,
		changes: true,
		prepare: (context, example) => ({ body: { ...(example as Json), version: context.kept.importVersion } }),
	},
	{
		method: "POST",
		path: "/api/credentials/confirm",
		status: 200,
		changes: true,
		prepare: (context) => ({
			body: { refs: [{ id: context.kept.credentialId, revision: context.kept.credentialRevision }] },
		}),
	},
	{
		method: "POST",
		path: "/api/credentials/delete",
		status: 200,
		changes: true,
		prepare: (context) => ({ body: { ids: [context.kept.credentialId] } }),
	},
	{
		method: "POST",
		path: "/api/credentials/delete-failed",
		status: 200,
		changes: true,
		prepare: () => ({ body: { confirm: [] } }),
	},

	// Exports and the console page
	{ method: "GET", path: "/api/gate-audit/export", status: 200 },
	{ method: "GET", path: "/", status: 200 },
	// The file names carry a build hash: the example's is there or it is not.
	{ method: "GET", path: "/assets/swagger-ui-{file}", status: [200, 404] },
	{ method: "GET", path: "/plugin-icon/{hostId}/{pluginId}/{file}", status: 404 },
	{ method: "GET", path: "/plugin-ui/{token}/{hostId}/{pluginId}/{assetPath}", status: 404 },

	// The language, last so that the other answers keep one language.
	{
		method: "GET",
		path: "/api/ui-language",
		status: 200,
		keep: (context, reply) => {
			context.kept.language = body(reply).language;
		},
	},
	{ method: "POST", path: "/api/ui-language", status: 200, changes: true },

	// The account, at the very end: both end the session.
	{
		method: "POST",
		path: "/api/auth/change-password",
		status: 200,
		changes: true,
		prepare: (context) => ({ body: { current: context.password, next: `${context.password}-next` } }),
		keep: (context, reply) => {
			context.password = `${context.password}-next`;
			context.target.keepCookie(reply.headers.get("set-cookie"));
		},
	},
	{ method: "POST", path: "/api/auth/logout", status: 200, changes: true },
];

/** Operations that are not sent, and why. Each would do something no test may do to a backend. */
const NOT_SENT: Record<string, string> = {
	"POST /api/models/remote": "向模型服务商发真实请求",
	"POST /api/projects/egress-ip": "让项目容器访问外网",
	"POST /api/mitm/start": "启动容器里的代理",
	"POST /api/mitm/stop": "停止容器里的代理",
	"POST /api/mitm/webfuzz/send": "真的访问目标",
	"POST /api/security-checks/sync": "从 GitHub 拉取规则",
	"POST /api/security-checks/submit": "新建并启动一个工程",
	"POST /api/ios/upload/{name}": "调用方是 iOS 设备，协议不在本契约里",
};

test("every operation answers as the document says", async () => {
	const target = await openContractTarget({ used: true });
	// Whether the answers can be held to the steps' statuses: only when every step before them ran.
	const strict = target.mayChangeAccount;
	const context: Context = { target, projectId: "", password: target.password, kept: {} };
	const undocumented: string[] = [];
	const malformed: string[] = [];
	const unexpected: string[] = [];
	let sent = 0;
	/** Answers checked against a schema. */
	let checked = 0;
	try {
		if (target.entryPath !== null)
			target.keepCookie(
				(await target.request("GET", target.entryPath, { anonymous: true })).headers.get("set-cookie"),
			);
		for (const step of STEPS) {
			if (step.changes && !strict) continue;
			sent += 1;
			const operation = operationOf(step.method, step.path);
			if (!operation) throw new Error(`${step.method} ${step.path} is not in the document`);
			const [type, media] = Object.entries(operation.requestBody?.content ?? {})[0] ?? [];
			const sent_ = step.prepare?.(context, media?.example) ?? {};
			const parameters = parametersOf(step.method, step.path);
			let url = step.path;
			for (const parameter of parameters)
				if (parameter.in === "path")
					url = url.replace(
						`{${parameter.name}}`,
						encodeURIComponent(sent_.path?.[parameter.name] ?? String(parameter.example)),
					);
			const query = new URLSearchParams();
			for (const parameter of parameters) {
				if (parameter.in !== "query") continue;
				const override = sent_.query?.[parameter.name];
				if (override !== undefined) query.set(parameter.name, override);
				else if (parameter.name === "projectId" && context.projectId !== "")
					query.set(parameter.name, context.projectId);
				else if (parameter.required) query.set(parameter.name, String(parameter.example));
			}
			const headers: Record<string, string> = {};
			for (const parameter of parameters)
				if (parameter.in === "header")
					headers[parameter.name] = sent_.headers?.[parameter.name] ?? String(parameter.example);
			const payload = sent_.body ?? media?.example;
			const reply = await target.request(step.method, `${url}${query.size > 0 ? `?${query}` : ""}`, {
				body:
					payload === undefined
						? undefined
						: typeof payload === "string"
							? payload
							: JSON.stringify(withProject(payload, context.projectId)),
				type: payload === undefined ? undefined : type === JSON_TYPE ? JSON_TYPE : type,
				...(Object.keys(headers).length > 0 ? { headers } : {}),
			});
			const at_ = `${step.method} ${step.path}`;
			const response = documented(step.method, step.path, reply.status);
			if (!response) {
				undocumented.push(
					`${at_} answered ${reply.status}, which the document does not list: ${reply.text.slice(0, 200)}`,
				);
			} else if (strict && !(Array.isArray(step.status) ? step.status : [step.status]).includes(reply.status)) {
				unexpected.push(`${at_} answered ${reply.status}, expected ${step.status}: ${reply.text.slice(0, 200)}`);
			}
			const json = Object.entries(response?.content ?? {}).find(
				([name]) => name === JSON_TYPE || name.endsWith("+json"),
			)?.[1];
			if (json?.schema) {
				checked += 1;
				try {
					malformed.push(
						...validate(json.schema, reply.json(), api).map((failure) => `${at_} ${reply.status} → ${failure}`),
					);
				} catch {
					malformed.push(`${at_} ${reply.status}: the answer is not JSON: ${reply.text.slice(0, 200)}`);
				}
			}
			await step.keep?.(context, reply);
		}
		// The language is the console's, not this test's: put it back.
		await target.request("POST", "/api/ui-language", {
			type: JSON_TYPE,
			body: JSON.stringify({ language: context.kept.language ?? "zh" }),
		});
	} finally {
		await target.close();
	}
	expect(undocumented).toEqual([]);
	expect(unexpected).toEqual([]);
	expect(malformed).toEqual([]);
	// Every operation has to be covered for the result to mean anything.
	const covered = new Set([...STEPS.map((step) => `${step.method} ${step.path}`), ...Object.keys(NOT_SENT)]);
	const all = Object.entries(api.paths).flatMap(([path, item]) =>
		METHODS.filter((method) => item[method]).map((method) => `${method.toUpperCase()} ${path}`),
	);
	expect(all.filter((key) => !covered.has(key))).toEqual([]);
	expect([...covered].filter((key) => !all.includes(key))).toEqual([]);
	expect(sent).toBeGreaterThan(80);
	expect(checked).toBeGreaterThan(60);
}, 300_000);
