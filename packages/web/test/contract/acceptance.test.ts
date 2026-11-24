/**
 * The contract, run against a backend.
 *
 * Every check here comes from docs/contract: what the three gates answer, what a
 * new connection receives, how failures and the language switch look on the
 * wire, and that each read-only message is answered by a message its entry
 * lists. The backend is reached only the way the browser reaches it, so the same
 * tests run against a rewritten backend: see contract-target.ts.
 */

import { afterAll, beforeAll, describe, expect, type TestContext, test } from "vitest";
import { EN_MESSAGES, interpolate } from "../../src/i18n-messages.ts";
import type { SentinelServerMessage } from "../../src/protocol.ts";
import type { ConsoleSocket, ContractTarget } from "./contract-target.ts";
import { openContractTarget } from "./contract-target.ts";
import { CLIENT_EXAMPLES } from "./examples/index.ts";
import type { ClientType } from "./examples/types.ts";
import { codeSpans, documentedSections, summary } from "./markdown.ts";

/**
 * Read-only messages. Sending the documented example changes nothing on the
 * backend and reaches no third party, so they are safe against any backend.
 */
const REPLAY: readonly ClientType[] = [
	"get_state",
	"get_tree",
	"get_stats",
	"list_sessions",
	"get_model_library",
	"lookup_model_defaults",
	"list_model_channels",
	"list_channel_models",
	"get_permissions",
	"get_notify_config",
	"get_environment",
	"get_proxy_config",
	"get_asset_config",
	"get_websearch_config",
	"get_mcp_servers",
	"get_plugins",
	"list_official_plugins",
	"list_projects",
	"list_subagents",
	"list_vulns",
	"list_assets",
	"list_pocs",
	"list_poc_sources",
	"list_api_models",
	"droid_state",
	"ios_state",
	"list_code_monitors",
	"get_code_monitor_import",
	"list_engines",
	"list_doctrines",
	"list_presets",
	"get_gatekeeper_config",
	"gate_audit_query",
	"gate_audit_stats",
	"supervisor_audit",
	"list_code_monitor_logs",
];

/**
 * Messages that change what the backend has stored, and whose example needs
 * nothing that exists beforehand. They are sent only to a backend these tests
 * started themselves, or one whose operator allowed changes.
 */
const REPLAY_CONFIG: readonly ClientType[] = [
	"save_model_entry",
	"set_reviewer_auto",
	"save_permissions",
	"save_notify_config",
	"save_preset",
	"save_doctrine",
	"save_supervisor_config",
	"save_gatekeeper_config",
	"set_container_network",
	"set_sources",
	"save_mcp_server",
];

/** A text the server may answer, in either language. */
function answerInEitherLanguage(chinese: string, vars?: Record<string, string>): string[] {
	return [interpolate(chinese, vars), interpolate(EN_MESSAGES[chinese] ?? chinese, vars)];
}

const ofTypes =
	(...types: string[]) =>
	(message: SentinelServerMessage) =>
		types.includes(message.type);

describe.sequential("contract acceptance", () => {
	let target: ContractTarget;
	let primary: ConsoleSocket;
	/** Set once the account is logged in and the authorization promise is out of the way. */
	let ready = false;
	let originalLanguage = "zh";
	let password = "";

	const whenReady = (context: TestContext) => {
		if (!ready) context.skip();
		return ready;
	};

	beforeAll(async () => {
		target = await openContractTarget();
		password = target.password;
	}, 120_000);

	afterAll(async () => {
		primary?.close();
		await target?.close();
	});

	test("without the entry cookie, every request answers a plain 404", async (context) => {
		if (target.entryPath === null) return context.skip();
		for (const path of ["/", "/api/health", "/api/auth/state", "/assets/app.js"]) {
			const reply = await target.request("GET", path, { anonymous: true });
			expect(reply.status, path).toBe(404);
			expect(reply.headers.get("content-type"), path).toMatch(/^text\/plain/);
			expect(reply.text, path).toBe("Not Found\n");
		}
		target.cookies.clear();
		await expect(target.socket(), "the WebSocket handshake").rejects.toThrow(/404/);
	});

	test("the entry URL sets the entry cookie and redirects to /", async (context) => {
		if (target.entryPath === null) return context.skip();
		const reply = await target.request("GET", target.entryPath, { anonymous: true });
		expect(reply.status).toBe(302);
		expect(reply.headers.get("location")).toBe("/");
		const attributes = target.keepCookie(reply.headers.get("set-cookie"));
		expect([...target.cookies.keys()]).toEqual(["sentinel-gate"]);
		expect(attributes).toEqual(["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=2592000"]);
	});

	test("the console page and the account state are served", async () => {
		const page = await target.request("GET", "/");
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toMatch(/^text\/html/);
		const state = await target.request("GET", "/api/auth/state");
		expect(state.status).toBe(200);
		// `username` is null until the account exists.
		expect(state.json()).toMatchObject({ configured: expect.any(Boolean) });
	});

	test("API routes and the WebSocket stay closed without a session", async () => {
		const reply = await target.request("GET", "/api/reports");
		expect(reply.status).toBe(401);
		expect(typeof reply.json().error).toBe("string");
		await expect(target.socket(), "the WebSocket handshake").rejects.toThrow(/401/);
	});

	test("the account is created on first use, or the existing one is opened", async () => {
		const { configured } = (await target.request("GET", "/api/auth/state")).json<{ configured: boolean }>();
		const json = { type: "application/json" };
		if (!configured) {
			const created = await target.request("POST", "/api/auth/setup", {
				...json,
				body: JSON.stringify({ username: target.username, password }),
			});
			expect(created.status).toBe(200);
			expect(created.json()).toEqual({ ok: true, username: target.username });
			expect(target.keepCookie(created.headers.get("set-cookie"))).toEqual([
				"Path=/",
				"HttpOnly",
				"SameSite=Strict",
				"Max-Age=2592000",
			]);
			const again = await target.request("POST", "/api/auth/setup", {
				...json,
				body: JSON.stringify({ username: target.username, password }),
			});
			expect(again.status).toBe(409);
			return;
		}
		const wrong = await target.request("POST", "/api/auth/login", {
			...json,
			body: JSON.stringify({ username: target.username, password: `${password}-wrong` }),
		});
		expect(wrong.status).toBe(401);
		const opened = await target.request("POST", "/api/auth/login", {
			...json,
			body: JSON.stringify({ username: target.username, password, remember: false }),
		});
		expect(opened.status).toBe(200);
		expect(opened.json()).toEqual({ ok: true, username: target.username });
		// Without 记住登录 the cookie is a browser-session cookie.
		expect(target.keepCookie(opened.headers.get("set-cookie"))).toEqual(["Path=/", "HttpOnly", "SameSite=Strict"]);
	});

	test("the session status says whether the authorization promise is still due", async () => {
		const reply = await target.request("GET", "/api/auth/session");
		expect(reply.status).toBe(200);
		// `acceptedAt` is null until the promise is accepted.
		expect(reply.json()).toMatchObject({
			ok: true,
			username: target.username,
			consent: { required: expect.any(Boolean), version: expect.anything() },
		});
	});

	test("until the authorization promise is accepted, the console stays closed", async (context) => {
		const { consent } = (await target.request("GET", "/api/auth/session")).json<{ consent: { required: boolean } }>();
		if (!consent.required) {
			ready = true;
			return context.skip();
		}
		const json = { type: "application/json" };
		const refused = await target.request("GET", "/api/reports");
		expect(refused.status).toBe(403);
		expect(refused.json()).toEqual({ error: "consent_required" });
		await expect(target.socket(), "the WebSocket handshake").rejects.toThrow(/403/);

		const statement = await target.request("GET", "/api/consent");
		expect(statement.status).toBe(200);
		expect(statement.json()).toMatchObject({
			required: true,
			text: expect.objectContaining({ title: expect.any(String) }),
		});
		// The checkbox is the point: an acceptance that is not `true` records nothing.
		const unchecked = await target.request("POST", "/api/consent/accept", {
			...json,
			body: JSON.stringify({ accepted: false }),
		});
		expect(unchecked.status).toBe(400);

		if (!target.mayAcceptConsent) return context.skip();
		const accepted = await target.request("POST", "/api/consent/accept", {
			...json,
			body: JSON.stringify({ accepted: true }),
		});
		expect(accepted.status).toBe(200);
		expect(accepted.json()).toMatchObject({ ok: true, acceptedAt: expect.any(String) });
		const after = await target.request("GET", "/api/auth/session");
		expect(after.json<{ consent: { required: boolean } }>().consent.required).toBe(false);
		ready = true;
	});

	test("a new connection first receives the language and the full state", async (context) => {
		if (!whenReady(context)) return;
		primary = await target.socket();
		const language = await primary.next(ofTypes("ui_config"));
		originalLanguage = (language as { language: string }).language;
		expect(["zh", "en"]).toContain(originalLanguage);
		await primary.next(ofTypes("snapshot"));
		for (const type of [
			"projects",
			"engines",
			"doctrines",
			"gatekeeper_config",
			"model_library",
			"asset_config",
			"websearch_config",
			"mcp_servers",
			"proxy_config",
		]) {
			await primary.next(ofTypes(type), 20_000);
		}
	});

	test("an unknown message and a frame that is not JSON are answered with an error", async (context) => {
		if (!whenReady(context)) return;
		primary.send({ type: "not_a_message" });
		const unknown = await primary.next(ofTypes("error"));
		expect(answerInEitherLanguage("未知消息类型: {type}", { type: "not_a_message" })).toContain(
			(unknown as { message: string }).message,
		);
		primary.sendRaw("{not json");
		const malformed = await primary.next(ofTypes("error"));
		expect(answerInEitherLanguage("无法解析的消息格式")).toContain((malformed as { message: string }).message);
	});

	test("every console is told when the language changes", async (context) => {
		if (!whenReady(context)) return;
		const other = await target.socket();
		try {
			await other.next(ofTypes("ui_config"));
			const switched = originalLanguage === "zh" ? "en" : "zh";
			primary.send({ type: "set_ui_language", language: switched });
			await Promise.all([
				primary.next((message) => message.type === "ui_config" && message.language === switched),
				other.next((message) => message.type === "ui_config" && message.language === switched),
			]);
			// From then on the server's own texts come in the new language.
			primary.send({ type: "not_a_message" });
			const error = await primary.next(ofTypes("error"));
			expect((error as { message: string }).message).toBe(
				interpolate(EN_MESSAGES["未知消息类型: {type}"], { type: "not_a_message" }),
			);
		} finally {
			primary.send({ type: "set_ui_language", language: originalLanguage });
			await primary.next((message) => message.type === "ui_config" && message.language === originalLanguage);
		}
	});

	/** Sends the documented example of each message and waits for an answer its entry lists. */
	const replay = async (types: readonly ClientType[]) => {
		const documented = documentedSections();
		const silent: string[] = [];
		for (const type of types) {
			const rows = summary(documented.client.get(type) ?? { type, file: "", direction: "client", body: "" });
			// What the entry says the handler answers with, the error aside.
			const expected = new Set(
				[...codeSpans(rows.replies ?? ""), ...codeSpans(rows.broadcasts ?? "")].filter((name) => name !== "error"),
			);
			if (expected.size === 0) {
				silent.push(type);
				continue;
			}
			primary.send(CLIENT_EXAMPLES[type]);
			await primary.next((message) => expected.has(message.type), 15_000);
		}
		expect(silent).toEqual([]);
	};

	test("each read-only message is answered by a message its entry lists", async (context) => {
		if (!whenReady(context)) return;
		await replay(REPLAY);
	});

	test("each configuration message is answered by a message its entry lists", async (context) => {
		if (!whenReady(context) || !target.mayChangeAccount) return context.skip();
		await replay(REPLAY_CONFIG);
	});

	test("logging out closes every console and ends the session", async (context) => {
		if (!whenReady(context) || !target.mayChangeAccount) return context.skip();
		const socket = await target.socket();
		await socket.next(ofTypes("ui_config"));
		const logout = await target.request("POST", "/api/auth/logout");
		expect(logout.status).toBe(200);
		expect(logout.json()).toEqual({ ok: true });
		expect(await socket.closed()).toEqual({ code: 4001, reason: "session_expired" });
		expect((await target.request("GET", "/api/auth/session")).status).toBe(401);
		const login = await target.request("POST", "/api/auth/login", {
			type: "application/json",
			body: JSON.stringify({ username: target.username, password }),
		});
		expect(login.status).toBe(200);
		target.keepCookie(login.headers.get("set-cookie"));
	});

	test("a new login replaces the previous one", async (context) => {
		if (!whenReady(context) || !target.mayChangeAccount) return context.skip();
		const socket = await target.socket();
		await socket.next(ofTypes("ui_config"));
		const login = await target.request("POST", "/api/auth/login", {
			type: "application/json",
			body: JSON.stringify({ username: target.username, password }),
		});
		expect(login.status).toBe(200);
		expect(await socket.closed()).toEqual({ code: 4001, reason: "session_replaced" });
		target.keepCookie(login.headers.get("set-cookie"));
	});

	test("changing the password ends every session", async (context) => {
		if (!whenReady(context) || !target.mayChangeAccount) return context.skip();
		const socket = await target.socket();
		await socket.next(ofTypes("ui_config"));
		const next = `${password}-next`;
		const changed = await target.request("POST", "/api/auth/change-password", {
			type: "application/json",
			body: JSON.stringify({ current: password, next }),
		});
		expect(changed.status).toBe(200);
		expect(changed.json()).toEqual({ ok: true });
		expect(await socket.closed()).toEqual({ code: 4001, reason: "session_expired" });
		const old = await target.request("POST", "/api/auth/login", {
			type: "application/json",
			body: JSON.stringify({ username: target.username, password }),
		});
		expect(old.status).toBe(401);
		password = next;
		const login = await target.request("POST", "/api/auth/login", {
			type: "application/json",
			body: JSON.stringify({ username: target.username, password }),
		});
		expect(login.status).toBe(200);
		target.keepCookie(login.headers.get("set-cookie"));
	});
});
