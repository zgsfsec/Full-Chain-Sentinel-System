/**
 * Business-modeling fixtures for tests: one endpoint as the source submit tool
 * receives it, one source entity, one interface document, and one stored record.
 */

import type { SentinelApiModel, SentinelApiModelSummary } from "../src/protocol.ts";

/** A code location, with the file written relative to the work directory the way the model writes it. */
export const at = (line = 1, file = "src/OrderController.java") => ({ file, line });

export const mapping = (method = "GET", path = "/api/orders/{id}", extra: Record<string, unknown> = {}) => ({
	method,
	path,
	module: "订单",
	summary: "查订单",
	handler: { name: "getOrder", location: at(42) },
	callChain: [
		{ layer: "service", name: "OrderService.find", location: { file: "/work/src/OrderService.java", line: 88 } },
	],
	dataAccess: [
		{ operation: "read", table: "t_order", columns: ["id", "status"], location: at(120, "src/OrderMapper.xml") },
	],
	authChecks: [{ kind: "ownership", note: "只能看自己的订单", location: at(45) }],
	externalCalls: [],
	confidence: "verified",
	...extra,
});

export const entity = (name: string, extra: Record<string, unknown> = {}) => ({
	name,
	table: `t_${name}`,
	owner: "用户",
	locations: [at(10, `src/entity/${name}.java`)],
	...extra,
});

/** An OpenAPI 3 document with the given paths. */
export const DOC = (paths: Record<string, unknown> = {}): Record<string, unknown> => ({
	openapi: "3.0.3",
	info: { title: "商城前台 API", version: "1.0.0" },
	paths,
});

/** A stored record with nothing in it yet; `extra` fills either half. */
export const record = (extra: Partial<SentinelApiModel> = {}): SentinelApiModel => ({
	id: "api-1",
	projectId: "p1",
	sessionId: "s1",
	sessionPath: null,
	title: "商城",
	target: "https://shop.example.com",
	source: "",
	status: "modeling",
	openapi: DOC(),
	entities: [],
	apis: [],
	logic: { entities: [], relations: [], stateMachines: [], rules: [], apiDependencies: [] },
	pathCount: 0,
	operationCount: 0,
	submissions: 0,
	createdAt: "2026-11-25T10:00:00.000Z",
	updatedAt: "2026-11-25T10:00:00.000Z",
	doneAt: null,
	...extra,
});

/** The same record as a list row shows it: the counters without either body. */
export const summary = (extra: Partial<SentinelApiModelSummary> = {}): SentinelApiModelSummary => ({
	id: "api-1",
	projectId: "p1",
	sessionId: "s1",
	sessionPath: null,
	title: "商城",
	target: "https://shop.example.com",
	source: "",
	status: "modeling",
	pathCount: 0,
	operationCount: 0,
	submissions: 0,
	entityCount: 0,
	apiCount: 0,
	stateMachineCount: 0,
	ruleCount: 0,
	createdAt: "2026-11-25T10:00:00.000Z",
	updatedAt: "2026-11-25T10:00:00.000Z",
	doneAt: null,
	...extra,
});
