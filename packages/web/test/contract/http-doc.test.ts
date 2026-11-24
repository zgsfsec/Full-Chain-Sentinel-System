/**
 * Checks the OpenAPI document under docs/contract against the routes the server
 * actually matches: every route in src/server.ts has a path in the document, and
 * the document describes no path the server does not have.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { WEB_CONSOLE_VERSION } from "../../src/assets.ts";
import { readSource } from "./wire-source.ts";

interface Operation {
	responses?: Record<string, unknown>;
	summary?: string;
	description?: string;
}

interface PathItem {
	get?: Operation;
	post?: Operation;
	put?: Operation;
	patch?: Operation;
	delete?: Operation;
	head?: Operation;
	options?: Operation;
}

interface Spec {
	openapi?: string;
	info?: { version?: string; title?: string };
	paths?: Record<string, PathItem>;
	security?: unknown;
	components?: { securitySchemes?: Record<string, unknown> };
}

const METHODS: (keyof PathItem)[] = ["get", "post", "put", "patch", "delete", "head", "options"];

function serverRoutes(source: string): { exact: Set<string>; prefixes: Set<string> } {
	const exact = new Set<string>();
	const prefixes = new Set<string>();
	for (const match of source.matchAll(/\b(?:path|url\.pathname)( === |\.startsWith\()"([^"]+)"/g)) {
		(match[1].includes("startsWith") ? prefixes : exact).add(match[2]);
	}
	return { exact, prefixes };
}

test("the OpenAPI document parses and carries the console version", () => {
	const spec = parse(
		readFileSync(join(import.meta.dirname, "..", "..", "docs", "contract", "openapi.yaml"), "utf8"),
	) as Spec;
	expect(spec.openapi).toBe("3.1.0");
	expect(spec.info?.version).toBe(WEB_CONSOLE_VERSION);
	expect(spec.info?.title).toBeTruthy();
	expect(spec.components?.securitySchemes).toHaveProperty("sentinel-auth");
	expect(spec.components?.securitySchemes).toHaveProperty("sentinel-gate");
});

test("every operation is described and answers something", () => {
	const spec = parse(
		readFileSync(join(import.meta.dirname, "..", "..", "docs", "contract", "openapi.yaml"), "utf8"),
	) as Spec;
	const problems: string[] = [];
	for (const [path, item] of Object.entries(spec.paths ?? {})) {
		const operations = METHODS.filter((method) => item[method] !== undefined);
		if (operations.length === 0) problems.push(`${path}: no operation`);
		for (const method of operations) {
			const operation = item[method] as Operation;
			const responses = Object.keys(operation.responses ?? {});
			if (responses.length === 0) problems.push(`${method.toUpperCase()} ${path}: no responses`);
			if (!operation.summary && !operation.description)
				problems.push(`${method.toUpperCase()} ${path}: no summary or description`);
		}
	}
	expect(problems).toEqual([]);
});

test("the document covers exactly the routes the server matches", () => {
	const spec = parse(
		readFileSync(join(import.meta.dirname, "..", "..", "docs", "contract", "openapi.yaml"), "utf8"),
	) as Spec;
	const { exact, prefixes } = serverRoutes(readSource("src", "server.ts"));
	// `/api/` is the catch-all the login checks use; every real route has a literal of its own.
	const routes = [...prefixes].filter((prefix) => prefix !== "/api/");
	const documented = Object.keys(spec.paths ?? {});
	const problems: string[] = [];
	for (const route of exact) {
		if (!documented.includes(route)) problems.push(`${route} is matched by the server but not in the document`);
	}
	for (const prefix of routes) {
		// A prefix route is covered by a path that goes on past the prefix.
		if (!documented.some((path) => path.startsWith(prefix) && path.length > prefix.length)) {
			problems.push(`${prefix}* is matched by the server but no documented path starts with it`);
		}
	}
	for (const path of documented) {
		// `/` serves the console page without a literal of its own.
		const known =
			path === "/" ||
			exact.has(path) ||
			routes.some((prefix) => path.startsWith(prefix) && path.length > prefix.length);
		if (!known) problems.push(`${path} is in the document but the server does not match it`);
	}
	expect(problems).toEqual([]);
});
