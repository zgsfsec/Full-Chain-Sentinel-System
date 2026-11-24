/**
 * The documents against the real server.
 *
 * Sends the documented example of every browser message that is safe to send
 * (it reaches no network and runs nothing on this machine) to a server started
 * for the test, and checks three things for each entry:
 *
 * - every message type the server sends back is one the entry lists;
 * - every failure text the server sends back is one the entry lists;
 * - every message the server sends back conforms to the schema generated from
 *   its type, so the schemas the frontend works from match what goes on the wire.
 *
 * The entries are written from the source; this is what shows that reading the
 * source went right. Messages that need a running agent, a project container or
 * a selected conversation answer with a failure here, which is fine as long as
 * the entry lists that failure.
 */

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { EN_MESSAGES } from "../../src/i18n-messages.ts";
import type { SentinelServerMessage } from "../../src/protocol.ts";
import { type ConsoleSocket, type ContractTarget, openContractTarget } from "./contract-target.ts";
import { CLIENT_EXAMPLES } from "./examples/index.ts";
import type { ClientType } from "./examples/types.ts";
import { codeSpans, type Documented, documentedSections } from "./markdown.ts";
import { type Schema, type SchemaSource, validate } from "./schema.ts";

interface SchemaDocument extends SchemaSource {
	roots: Record<string, Schema>;
}

const schemas = JSON.parse(
	readFileSync(new URL("../../docs/contract/frontend/schemas.generated.json", import.meta.url), "utf8"),
) as SchemaDocument;

/** Messages that reach the network, run commands on this machine, or bind a port. */
const UNSAFE = new Set(
	(
		"test_notify test_asset_platform test_websearch_key test_proxy_connection test_proxy_nodes test_model_entry " +
		"test_mcp_server test_supervisor test_judge test_plugin_host sync_poc_source sync_official_pocs " +
		"refresh_proxy_subscription pull_singbox_image build_image abort_image_build install_official_plugin " +
		"install_plugin fetch_plugin_artifact plugin_ui_call plugin_ui_open start_plugin stop_plugin uninstall_plugin " +
		"credentials_verify prompt compact abort abort_compaction start_goal start_modeling supervisor_arm " +
		"supervisor_run_now supervisor_advice_action engine_create scan_code_history dispatch_code_commit " +
		"rejudge_code_commit check_code_monitor review_pending_vulns retry_vuln_review create_code_monitor " +
		"code_monitor_branches import_code_monitors set_code_monitors_dispatch set_code_monitors_schedule " +
		"start_project recreate_project add_project remove_project stop_project switch_project terminal_open " +
		"terminal_input terminal_close download_folder cancel_folder_archive download_file upload_file write_file " +
		"delete_path rename_path make_directory droid_set_listen ios_set_listen lookup_model_defaults " +
		"list_model_channels list_channel_models save_proxy switch_project_node set_project_proxy set_default_proxy " +
		"set_proxy_image get_environment check_environment set_sources set_container_network steer_subagent " +
		"abort_subagent save_code_monitor update_code_monitor delete_code_monitors ignore_code_commit " +
		"credentials_set_enabled reports_set_enabled"
	).split(" "),
);
/** Pushes that follow from a state change or from the dispatcher, not from one entry's own logic. */
const GENERIC = new Set(["error", "snapshot", "environment"]);
/**
 * Pushes that runtime activity can produce at any moment: a hook of the agent
 * runtime, the reviewer, the subscription scheduler or a notification. When one
 * arrives it cannot be said to belong to the message that was just sent, so the
 * messages only their own handlers push (the device and modeling pages) stay
 * attributable and these do not.
 */
const BACKGROUND = new Set([
	"session_event",
	"subagent_event",
	"notify_config",
	"gate_decision",
	"vulns",
	"assets_changed",
	"sessions",
	"pocs",
	"poc_sources",
	"supervisor_state",
	"supervisor_episode",
	"supervisor_log",
	"supervisor_advice",
]);
/** How many earlier messages a slow handler's push may be credited to. */
const RECENT = 8;
/** How long to keep collecting after the last frame, and the most to wait for one. */
const QUIET_MS = 500;
const LIMIT_MS = 3000;

/** The key of a failure text the server sent in English: the text with the most fixed characters wins. */
function keyOf(text: string): string | undefined {
	const hits: string[] = [];
	for (const [key, english] of Object.entries(EN_MESSAGES)) {
		const pieces = english.split(/\{\w+\}/);
		// A key made of placeholders only matches anything.
		if (pieces.join("").trim().length < 3) continue;
		const pattern = pieces.map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+");
		if (new RegExp(`^${pattern}$`).test(text)) hits.push(key);
	}
	const fixed = (key: string) => (EN_MESSAGES[key] ?? "").replace(/\{\w+\}/g, "").length;
	return hits.sort((left, right) => fixed(right) - fixed(left))[0];
}

/** What an entry lists: its rows and the sentences after them, the example aside. */
function listedBy(section: string): Set<string> {
	return new Set(codeSpans(section.replace(/```json[\s\S]*?```/, "")));
}

async function signIn(target: ContractTarget): Promise<ConsoleSocket> {
	const entry = await target.request("GET", target.entryPath ?? "/", { anonymous: true });
	target.keepCookie(entry.headers.get("set-cookie"));
	const json = { type: "application/json" };
	const setup = await target.request("POST", "/api/auth/setup", {
		...json,
		body: JSON.stringify({ username: target.username, password: target.password }),
	});
	target.keepCookie(setup.headers.get("set-cookie"));
	await target.request("POST", "/api/consent/accept", { ...json, body: JSON.stringify({ accepted: true }) });
	const socket = await target.socket();
	// The first pushes of a new connection are not about any message.
	await new Promise((resolve) => setTimeout(resolve, 2500));
	socket.pending().length = 0;
	return socket;
}

test("every safe message is answered as its entry says", async () => {
	const target = await openContractTarget();
	try {
		const socket = await signIn(target);
		const documented: Documented = documentedSections();
		const unexpected: string[] = [];
		const unexplained: string[] = [];
		const malformed: string[] = [];
		let sent = 0;
		const recent: Set<string>[] = [];
		for (const type of Object.keys(CLIENT_EXAMPLES) as ClientType[]) {
			if (UNSAFE.has(type)) continue;
			const section = documented.client.get(type);
			if (!section) continue;
			const listed = listedBy(section.body);
			socket.pending().length = 0;
			sent += 1;
			socket.send(CLIENT_EXAMPLES[type]);
			let last = Date.now();
			const started = Date.now();
			let count = 0;
			while (Date.now() - started < LIMIT_MS && (Date.now() - last < QUIET_MS || count === 0)) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				if (socket.pending().length !== count) {
					count = socket.pending().length;
					last = Date.now();
				}
			}
			// A copy: clearing the socket's buffer must not empty what was just read.
			const seen = [...socket.pending()] as SentinelServerMessage[];
			socket.pending().length = 0;
			for (const message of seen) {
				const schema = schemas.roots[`Ws.server.${message.type}`];
				if (!schema) malformed.push(`${type}: the server sent ${message.type}, which has no schema`);
				else malformed.push(...validate(schema, message, schemas).map((failure) => `${type} → ${failure}`));
				// A push that an earlier operation still had in flight belongs to that one.
				const attributed = listed.has(message.type) || recent.some((set) => set.has(message.type));
				if (!attributed && !GENERIC.has(message.type) && !BACKGROUND.has(message.type)) {
					unexpected.push(`${type}: the server sent ${message.type}, the entry does not list it`);
				}
				// A failure is an `error` message, or a result with `ok: false`.
				const failed = message as { ok?: boolean; error?: string };
				const reported =
					message.type === "error"
						? (message as { message: string }).message
						: failed.ok === false
							? failed.error
							: undefined;
				if (reported === undefined || listed.has(reported)) continue;
				const key = keyOf(reported);
				if (key === undefined) {
					unexplained.push(`${type}: the server answered a failure the entry cannot explain: ${reported}`);
				} else if (!listed.has(key)) {
					unexplained.push(`${type}: ${key}`);
				}
			}
			recent.push(listed);
			if (recent.length > RECENT) recent.shift();
		}
		socket.close();
		// Every message has to be covered for the result to mean anything.
		expect(sent).toBeGreaterThan(120);
		expect(unexpected).toEqual([]);
		expect(unexplained).toEqual([]);
		expect(malformed).toEqual([]);
	} finally {
		await target.close();
	}
}, 600_000);
