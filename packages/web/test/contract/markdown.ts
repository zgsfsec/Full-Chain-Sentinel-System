/**
 * Reads the contract documents the way the checks do. The unit of a document is
 * an entry: a `### \`message_type\`` heading with what follows it up to the next
 * heading. A browser-to-server message and a server-to-browser message may share
 * a name (`droid_state`), so an entry is identified by its direction as well.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOMAINS } from "./domains.ts";

export const websocketDocs = join(import.meta.dirname, "..", "..", "docs", "contract", "websocket");

export type Direction = "client" | "server";

export interface Section {
	readonly type: string;
	readonly file: string;
	/** Which way the message goes: `client` is browser to server. */
	readonly direction: Direction;
	readonly body: string;
}

/** Every entry of a document, in reading order. */
export function sections(file: string): Section[] {
	const text = readFileSync(join(websocketDocs, file), "utf8");
	const found: Section[] = [];
	// Each entry takes its direction from the `## ` section it is in.
	for (const part of text.split(/^## /m).slice(1)) {
		const direction: Direction = part.includes("下行") ? "server" : "client";
		for (const match of part.matchAll(/^### `([a-z_]+)`$/gm)) {
			const rest = part.slice(match.index + match[0].length);
			const nextHeading = rest.search(/^#{1,3} /m);
			found.push({ type: match[1], file, direction, body: nextHeading < 0 ? rest : rest.slice(0, nextHeading) });
		}
	}
	return found;
}

/** The entries of every domain document that exists, by message type and direction. */
export interface Documented {
	readonly client: Map<string, Section>;
	readonly server: Map<string, Section>;
}

export function documentedSections(): Documented {
	const documented: Documented = { client: new Map(), server: new Map() };
	for (const file of Object.keys(DOMAINS)) {
		if (!existsSync(join(websocketDocs, `${file}.md`))) continue;
		for (const section of sections(`${file}.md`)) documented[section.direction].set(section.type, section);
	}
	return documented;
}

/** The summary rows of an entry, by their labels in the document. */
export interface EntrySummary {
	/** 字段 */
	readonly fields?: string;
	/** 回复请求方 */
	readonly replies?: string;
	/** 广播 */
	readonly broadcasts?: string;
	/** 失败文案 */
	readonly failures?: string;
	/** 发送时机 */
	readonly sentWhen?: string;
}

const ROW_LABELS = {
	字段: "fields",
	回复请求方: "replies",
	广播: "broadcasts",
	失败文案: "failures",
	发送时机: "sentWhen",
} as const;

/** The value cell of each summary row an entry has. */
export function summary(section: Section): EntrySummary {
	const rows: Partial<Record<keyof EntrySummary, string>> = {};
	for (const match of section.body.matchAll(/^\| (字段|回复请求方|广播|失败文案|发送时机) \| (.*) \|$/gm)) {
		rows[ROW_LABELS[match[1] as keyof typeof ROW_LABELS]] = match[2].replaceAll("\\|", "|");
	}
	return rows;
}

/** The message types or texts an entry lists in a row, i.e. its code spans. */
export function codeSpans(cell: string): string[] {
	return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

/** The JSON example of an entry. */
export function jsonExample(section: Section): unknown {
	const block = /```json\n([\s\S]*?)\n```/.exec(section.body);
	if (!block) throw new Error(`${section.file}: ${section.type} has no JSON example`);
	return JSON.parse(block[1]);
}
