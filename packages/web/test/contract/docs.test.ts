/**
 * Checks the interface contract under docs/contract against the code it
 * describes:
 *
 * - every WebSocket message has exactly one documented entry, and no entry
 *   describes a message that does not exist;
 * - for every browser-to-server message, the entry lists each server message
 *   the handler sends at its call site, each literal failure text included;
 * - every entry shows a JSON example that equals a value the compiler has
 *   checked against the message's type;
 * - the documented drift between the two protocol copies is the accepted drift.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { EN_MESSAGES } from "../../src/i18n-messages.ts";
import { DOMAINS } from "./domains.ts";
import { CLIENT_EXAMPLES, SERVER_EXAMPLES } from "./examples/index.ts";
import type { ClientType, ServerType } from "./examples/types.ts";
import { codeSpans, documentedSections, jsonExample, sections, summary, websocketDocs } from "./markdown.ts";
import { extractUnionMembers, extractWireCases, readSource } from "./wire-source.ts";

describe("contract documents", () => {
	// Read from the protocol source rather than from the examples, so the other
	// checks keep working while an example is still missing.
	const clientTypes = extractUnionMembers(readSource("src", "protocol.ts"), "SentinelClientMessage").map(
		(member) => member.type as ClientType,
	);
	const serverTypes = extractUnionMembers(readSource("src", "protocol.ts"), "SentinelServerMessage").map(
		(member) => member.type as ServerType,
	);
	const serverTypeSet = new Set<string>(serverTypes);
	const clientTypeSet = new Set<string>(clientTypes);
	const documented = documentedSections();
	// A message is looked up in the direction it goes.
	const sectionOf = (type: string) => (clientTypeSet.has(type) ? documented.client : documented.server).get(type);
	// Every text the server hands to the translator, or throws as an error
	// message as it is, is one it can answer with. Placeholders are compared
	// by position: a thrown template names its variables, an entry may write
	// `{…}` for one that is not a plain name.
	const placeholders = (text: string) => text.replace(/\{[^{}]*\}/g, "{}");
	const translated = new Set<string>();
	for (const file of readdirSync(join(import.meta.dirname, "..", "..", "src"))) {
		if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
		const text = readFileSync(join(import.meta.dirname, "..", "..", "src", file), "utf8");
		// `t("…")`, `new Error("…")` and `new SomeError("…")`.
		for (const match of text.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"|new \w*Error\(\s*"((?:[^"\\]|\\.)*)"/g)) {
			try {
				translated.add(placeholders(JSON.parse(`"${match[1] ?? match[2]}"`) as string));
			} catch {
				// Not a plain string literal.
			}
		}
		for (const match of text.matchAll(/new \w*Error\(\s*`([^`]*)`/g)) {
			translated.add(placeholders(match[1].replace(/\$\{[^}]*\}/g, "{}")));
		}
	}
	for (const key of Object.keys(EN_MESSAGES)) translated.add(placeholders(key));
	const domainsOf = (type: string) =>
		Object.entries(DOMAINS).filter(
			([, domain]) => domain.client.includes(type as ClientType) || domain.server.includes(type as ServerType),
		);

	test("every message has exactly one example", () => {
		expect(Object.keys(CLIENT_EXAMPLES).sort()).toEqual([...clientTypes].sort());
		expect(Object.keys(SERVER_EXAMPLES).sort()).toEqual([...serverTypes].sort());
	});

	test("each domain document exists and describes exactly its messages, once each", () => {
		const problems: string[] = [];
		for (const [file, domain] of Object.entries(DOMAINS)) {
			if (!existsSync(join(websocketDocs, `${file}.md`))) problems.push(`${file}.md is missing`);
			for (const [direction, names] of [
				["client", domain.client],
				["server", domain.server],
			] as const) {
				const list: readonly string[] = names;
				const repeated = list.filter((type, index) => list.indexOf(type) !== index);
				if (repeated.length) problems.push(`${file}: ${direction} lists ${repeated.join(", ")} twice`);
			}
		}
		for (const type of [...clientTypes, ...serverTypes]) {
			const owners = domainsOf(type);
			if (owners.length !== 1) problems.push(`${type} belongs to ${owners.length} domains (expected 1)`);
			const file = owners[0]?.[0];
			if (file && sectionOf(type)?.file !== `${file}.md`) problems.push(`${type} is not documented in ${file}.md`);
		}
		for (const [type, section] of [...documented.client, ...documented.server]) {
			if (!clientTypeSet.has(type) && !serverTypeSet.has(type))
				problems.push(`${section.file} documents ${type}, which is not a message`);
		}
		expect(problems).toEqual([]);
	});

	test("every browser-to-server entry lists what its handler sends", () => {
		const problems: string[] = [];
		for (const handler of extractWireCases(readSource("src", "server.ts"))) {
			if (handler.type === "default") continue;
			const section = documented.client.get(handler.type);
			if (!section) continue; // Reported by the previous test.
			const rows = summary(section);
			for (const [key, label, expected] of [
				["replies", "回复请求方", handler.replies],
				["broadcasts", "广播", handler.broadcasts],
				["failures", "失败文案", handler.errors],
			] as const) {
				const listed = codeSpans(rows[key] ?? "");
				for (const item of expected) {
					if (!listed.includes(item))
						problems.push(`${handler.type}: ${label} does not list ${JSON.stringify(item)}`);
				}
				if (key !== "failures") {
					for (const item of listed) {
						if (!serverTypeSet.has(item))
							problems.push(`${handler.type}: ${label} lists ${item}, which is not a server message`);
					}
				}
			}
			for (const [key, label] of [
				["fields", "字段"],
				["replies", "回复请求方"],
				["broadcasts", "广播"],
				["failures", "失败文案"],
			] as const) {
				if (rows[key] === undefined) problems.push(`${handler.type}: no ${label} row`);
			}
		}
		expect(problems).toEqual([]);
	});

	test("every documented failure text is one the server can produce", () => {
		const problems: string[] = [];
		for (const type of clientTypes) {
			const section = documented.client.get(type);
			if (!section) continue; // Reported above.
			// A failure is described in the 失败文案 row when it is an `error`
			// message, and in the sentence about the result message otherwise.
			const described = [
				summary(section).failures ?? "",
				...section.body.split("\n").filter((line) => /^失败(不回|的原因写在)/.test(line)),
			];
			for (const text of described.flatMap(codeSpans)) {
				if (text === "error" || text === "ok" || text === "false" || serverTypeSet.has(text)) continue;
				if (!translated.has(placeholders(text)))
					problems.push(`${type}: ${JSON.stringify(text)} is not a text the server can produce`);
			}
		}
		expect(problems).toEqual([]);
	});

	test("every entry shows its type-checked example", () => {
		const problems: string[] = [];
		// A message that goes both ways has an entry, and an example, each way.
		for (const [direction, examples] of [
			["client", CLIENT_EXAMPLES],
			["server", SERVER_EXAMPLES],
		] as const) {
			for (const [type, example] of Object.entries(examples)) {
				const section = documented[direction].get(type);
				if (!section) continue; // Reported above.
				// Examples travel as JSON, so they must survive the round trip unchanged.
				const expected = JSON.parse(JSON.stringify(example));
				if (JSON.stringify(example) !== JSON.stringify(expected)) {
					problems.push(`${type}: its example is not plain JSON`);
					continue;
				}
				try {
					expect(jsonExample(section)).toEqual(expected);
				} catch (error) {
					problems.push(
						`${type}: ${error instanceof Error ? error.message.split("\n").slice(0, 6).join(" ") : String(error)}`,
					);
				}
			}
		}
		expect(problems).toEqual([]);
	});

	test("messages the server does not handle are known", () => {
		const handled = new Set(extractWireCases(readSource("src", "server.ts")).map((handler) => handler.type));
		// ios_token_delete: the iOS page sends it and the server has no case for
		// it, so it is answered with "unknown message type". See devices.md.
		expect(clientTypes.filter((type) => !handled.has(type))).toEqual(["ios_token_delete"]);
	});

	test("the documented drift is exactly the accepted drift", () => {
		const alignment = readFileSync(join(websocketDocs, "type-alignment.md"), "utf8");
		const source = readSource("webui", "src", "protocol-alignment.ts");
		const problems: string[] = [];
		for (const [name, pattern] of [
			["ACCEPTED_CLIENT_DRIFT", /ACCEPTED_CLIENT_DRIFT = \[([\s\S]*?)\];/],
			["ACCEPTED_SERVER_DRIFT", /ACCEPTED_SERVER_DRIFT = \[([\s\S]*?)\];/],
		] as const) {
			const block = pattern.exec(source)?.[1];
			if (block === undefined) {
				problems.push(`${name} not found`);
				continue;
			}
			for (const match of block.matchAll(/^\t"([a-z_]+)",$/gm)) {
				if (!alignment.includes(`\`${match[1]}\``))
					problems.push(`${match[1]} is accepted but not explained in type-alignment.md`);
			}
		}
		expect(problems).toEqual([]);
	});

	test("no document has an entry outside the messages of its domain", () => {
		const problems: string[] = [];
		for (const [file, domain] of Object.entries(DOMAINS)) {
			if (!existsSync(join(websocketDocs, `${file}.md`))) continue;
			const allowed = new Set<string>([...domain.client, ...domain.server]);
			for (const section of sections(`${file}.md`)) {
				if (!allowed.has(section.type)) problems.push(`${file}.md has an entry for ${section.type}`);
			}
		}
		expect(problems).toEqual([]);
	});

	test("every server-to-browser entry says when it is sent", () => {
		const problems: string[] = [];
		for (const type of serverTypes) {
			const section = documented.server.get(type);
			if (!section) continue; // Reported above.
			if (!/^\| 发送时机 \| .+ \|$/m.test(section.body)) problems.push(`${type}: no 发送时机 row`);
		}
		expect(problems).toEqual([]);
	});

	test("the entry of a server message names every handler that sends it", () => {
		const problems: string[] = [];
		for (const type of serverTypes) {
			// Every handler that can fail sends `error`; its entry explains the
			// situations instead of listing them.
			if (type === "error") continue;
			const section = documented.server.get(type);
			if (!section) continue; // Reported above.
			const named = new Set(codeSpans(section.body));
			for (const handler of extractWireCases(readSource("src", "server.ts"))) {
				if (handler.type === "default") continue;
				if ((handler.replies.includes(type) || handler.broadcasts.includes(type)) && !named.has(handler.type))
					problems.push(`${type}: its entry does not name the ${handler.type} handler, which sends it`);
			}
		}
		expect(problems).toEqual([]);
	});

	test("no entry is left unfinished", () => {
		// The skeletons are written with markers where a person has to write
		// something; a marker that survives means that part was never written.
		const problems: string[] = [];
		for (const [file] of Object.entries(DOMAINS)) {
			if (!existsSync(join(websocketDocs, `${file}.md`))) continue;
			sections(`${file}.md`).forEach((section, index) => {
				if (/TODO\(|EXAMPLE_MISSING/.test(section.body))
					problems.push(`${file}.md: entry ${index + 1} (${section.type}) still has a marker`);
			});
			const head = readFileSync(join(websocketDocs, `${file}.md`), "utf8").split(/^### /m)[0];
			if (/TODO\(/.test(head)) problems.push(`${file}.md: the introduction still has a marker`);
		}
		expect(problems).toEqual([]);
	});

	test("every relative link in the contract points to a file that exists", () => {
		const contractDocs = join(websocketDocs, "..");
		const problems: string[] = [];
		for (const file of readdirSync(contractDocs, { recursive: true, encoding: "utf8" })) {
			if (!file.endsWith(".md")) continue;
			const text = readFileSync(join(contractDocs, file), "utf8");
			// Links inside code blocks and inline code are examples, not navigation.
			const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
			for (const match of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
				const href = match[1];
				if (/^[a-z]+:/i.test(href) || href.startsWith("#")) continue;
				const target = resolve(contractDocs, dirname(file), href.split("#")[0]);
				if (!existsSync(target)) problems.push(`${file} links to ${href}, which does not exist`);
			}
		}
		expect(problems).toEqual([]);
	});

	test("the WebSocket index lists every domain with its message counts", () => {
		const index = readFileSync(join(websocketDocs, "README.md"), "utf8");
		const rows = new Map(
			[...index.matchAll(/^\| \[[^\]]+\]\(([^)]+)\.md\) \| (\d+) \| (\d+) \|$/gm)].map((m) => [
				m[1],
				[Number(m[2]), Number(m[3])],
			]),
		);
		expect(Object.fromEntries(rows)).toEqual(
			Object.fromEntries(
				Object.entries(DOMAINS).map(([file, domain]) => [file, [domain.client.length, domain.server.length]]),
			),
		);
		const total = /\| 合计 \| (\d+) \| (\d+) \|/.exec(index);
		expect(total?.slice(1, 3).map(Number)).toEqual([clientTypes.length, serverTypes.length]);
	});
});
