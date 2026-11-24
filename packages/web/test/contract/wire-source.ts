/**
 * Reads the WebSocket dispatcher in src/server.ts as text and reports, for every
 * client message, the server messages its handler sends. The contract docs are
 * checked against this, so they cannot list a reply the server never sends, nor
 * omit one it does.
 *
 * It scans source text instead of parsing TypeScript (the repository's TypeScript
 * ships no compiler API). A message whose type only exists in a variable or in a
 * helper is reported as dynamic, which makes the literal lists a lower bound.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..", "..");

export function readSource(...parts: string[]): string {
	return readFileSync(join(packageRoot, ...parts), "utf8");
}

const REGEX_KEYWORDS = new Set([
	"return",
	"case",
	"typeof",
	"in",
	"of",
	"delete",
	"void",
	"new",
	"do",
	"else",
	"yield",
	"await",
	"throw",
]);

function isQuote(char: string): boolean {
	return char === '"' || char === "'" || char === "`";
}

/** Whether a `/` at `index` opens a regular expression rather than a division. */
function opensRegex(text: string, index: number): boolean {
	let i = index - 1;
	while (i >= 0 && /\s/.test(text[i])) i--;
	if (i < 0) return true;
	const char = text[i];
	if (isQuote(char) || char === ")" || char === "]" || char === ".") return false;
	if (!/[\w$]/.test(char)) return true;
	let start = i;
	while (start > 0 && /[\w$]/.test(text[start - 1])) start--;
	return REGEX_KEYWORDS.has(text.slice(start, i + 1));
}

/**
 * Index just past the string, template literal or regular expression that starts
 * at `start`, or -1 when it never ends.
 */
function skipLiteral(text: string, start: number): number {
	const open = text[start];
	let i = start + 1;
	while (i < text.length) {
		const char = text[i];
		if (char === "\\") {
			i += 2;
			continue;
		}
		if (open === "`" && char === "$" && text[i + 1] === "{") {
			const end = matchBracket(text, i + 1);
			if (end < 0) return -1;
			i = end + 1;
			continue;
		}
		if (open === "/" && char === "[") {
			const classEnd = text.indexOf("]", i + 1);
			if (classEnd < 0) return -1;
			i = classEnd + 1;
			continue;
		}
		if (char === open) return i + 1;
		if (open === "/" && char === "\n") return -1;
		i++;
	}
	return -1;
}

/**
 * Index of the bracket that closes the one at `start`, or -1. Contents of
 * strings, template literals, comments and regular expressions are skipped, so a
 * brace inside a message text cannot end an object literal early.
 */
export function matchBracket(text: string, start: number): number {
	const open = text[start];
	const close = open === "(" ? ")" : open === "[" ? "]" : "}";
	let depth = 0;
	let i = start;
	while (i < text.length) {
		const char = text[i];
		if (char === "/" && text[i + 1] === "/") {
			i = text.indexOf("\n", i);
			if (i < 0) return -1;
		} else if (char === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2);
			if (i < 0) return -1;
			i += 2;
		} else if (isQuote(char) || (char === "/" && opensRegex(text, i))) {
			i = skipLiteral(text, i);
			if (i < 0) return -1;
		} else {
			if (char === open) depth++;
			else if (char === close && --depth === 0) return i;
			i++;
		}
	}
	return -1;
}

/**
 * The same text with comments blanked out and, when `literals` is set, the
 * contents of strings, template literals and regular expressions as well. The
 * length never changes, so an index in one text is valid in the other.
 */
export function blankOut(text: string, literals: boolean): string {
	const chars = [...text];
	const blank = (from: number, to: number) => {
		for (let j = from; j < Math.min(to, chars.length); j++) {
			if (chars[j] !== "\n") chars[j] = " ";
		}
	};
	let i = 0;
	while (i < chars.length) {
		const char = chars[i];
		if (char === "/" && chars[i + 1] === "/") {
			const end = text.indexOf("\n", i);
			blank(i, end < 0 ? chars.length : end);
			if (end < 0) break;
			i = end;
		} else if (char === "/" && chars[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			blank(i, end < 0 ? chars.length : end + 2);
			if (end < 0) break;
			i = end + 2;
		} else if (isQuote(char) || (char === "/" && opensRegex(text, i))) {
			const end = skipLiteral(text, i);
			if (end < 0) break;
			if (literals) blank(i, end);
			i = end;
		} else {
			i++;
		}
	}
	return chars.join("");
}

export function maskLiterals(text: string): string {
	return blankOut(text, true);
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The body of the double-quoted string that starts at `start`, or undefined. */
function stringBody(text: string, start: number): string | undefined {
	if (text[start] !== '"') return undefined;
	const end = skipLiteral(text, start);
	if (end < 0) return undefined;
	try {
		return JSON.parse(text.slice(start, end)) as string;
	} catch {
		return text.slice(start + 1, end - 1);
	}
}

/** Who a send reaches: one named socket, or every connected console. */
export type SendChannel = "socket" | "everyone";

export interface RawSend {
	readonly channel: SendChannel;
	/** The variable a direct send goes to; the dispatcher's own socket is `socket`. */
	readonly socket?: string;
	/** The `type` when it is written at the call site. */
	readonly type?: string;
	/** What is sent instead when the type is not written at the call site. */
	readonly dynamic?: string;
	/** The literal text passed to `sendError`. */
	readonly error?: string;
	readonly index: number;
}

const SEND_CALL = /\b(sendTo|broadcast|sendError)\(/g;

/** The identifier that starts at `index`, or undefined. */
function identifierAt(text: string, index: number): string | undefined {
	if (!/[A-Za-z_$]/.test(text[index] ?? "")) return undefined;
	let end = index + 1;
	while (/[\w$]/.test(text[end] ?? "")) end++;
	return text.slice(index, end);
}

/** The first index at or after `index` that is not whitespace. */
function skipWhitespace(text: string, index: number): number {
	let i = index;
	while (/\s/.test(text[i] ?? "")) i++;
	return i;
}

/**
 * Every `sendTo(…)`, `broadcast(…)` and `sendError(…)` call in `masked`, read
 * from `text` at the same indexes. `masked` must be `text` with literals blanked.
 */
export function scanSends(masked: string, text: string): RawSend[] {
	const sends: RawSend[] = [];
	for (const match of masked.matchAll(SEND_CALL)) {
		const name = match[1];
		const callOpen = match.index + match[0].length - 1;
		const callClose = matchBracket(masked, callOpen);
		if (callClose < 0) continue;
		let arg = skipWhitespace(text, match.index + match[0].length);
		if (name === "sendError") {
			// The definition, `sendError(socket: WebSocket, …)`, has a type where
			// a call has a comma, so it is skipped here.
			const socket = identifierAt(masked, arg);
			if (!socket || masked[arg + socket.length] !== ",") continue;
			const textStart = skipWhitespace(text, arg + socket.length + 1);
			// `t("…")` wraps a literal text; anything else is computed.
			const literalAt = masked.startsWith("t(", textStart) ? skipWhitespace(text, textStart + 2) : textStart;
			const error = stringBody(text, literalAt);
			sends.push({
				channel: "socket",
				socket,
				type: "error",
				index: match.index,
				...(error === undefined ? { dynamic: collapse(text.slice(textStart, callClose)) } : { error }),
			});
			continue;
		}
		const channel: SendChannel = name === "broadcast" ? "everyone" : "socket";
		let socket: string | undefined;
		if (channel === "socket") {
			socket = identifierAt(masked, arg);
			if (!socket || masked[arg + socket.length] !== ",") continue;
			arg = skipWhitespace(text, arg + socket.length + 1);
		}
		if (masked[arg] !== "{") {
			sends.push({ channel, socket, dynamic: collapse(text.slice(arg, callClose)), index: match.index });
			continue;
		}
		const close = matchBracket(masked, arg);
		if (close < 0) continue;
		const type = /\btype:\s*"([a-z_]+)"/.exec(text.slice(arg, close + 1))?.[1];
		sends.push({
			channel,
			socket,
			index: match.index,
			...(type ? { type } : { dynamic: collapse(text.slice(arg, close + 1)) }),
		});
	}
	return sends;
}

function lineMap(text: string): (index: number) => number {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") starts.push(i + 1);
	}
	return (index) => {
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if (starts[mid] <= index) low = mid;
			else high = mid - 1;
		}
		return low + 1;
	};
}

export interface WireCase {
	/** The client message `type`; `default` is the branch for unknown types. */
	readonly type: string;
	/** 1-based line of the `case` label. */
	readonly start: number;
	/** 1-based line of the handler's last line. */
	readonly end: number;
	/** Message types sent back to the asking console, in source order. */
	readonly replies: readonly string[];
	/** Message types sent to every connected console, in source order. */
	readonly broadcasts: readonly string[];
	/** Texts passed to `sendError` or thrown, when written at the call site. */
	readonly errors: readonly string[];
	/** What is passed to `sendError` when the text is computed. */
	readonly errorExpressions: readonly string[];
	/** Sends whose message type is not written at the call site. */
	readonly dynamicSends: readonly string[];
	/** Local functions the handler calls. */
	readonly helpers: readonly string[];
	/** `manager.method(` calls such as `runtime.prompt`. */
	readonly members: readonly string[];
}

const NOT_CALLS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"return",
	"await",
	"typeof",
	"new",
	"throw",
	"else",
	"do",
]);
const NOT_MEMBERS = new Set([
	"console",
	"Promise",
	"Object",
	"Array",
	"JSON",
	"Math",
	"Number",
	"String",
	"Date",
	"AbortSignal",
	"Buffer",
	"Set",
	"Map",
	"RegExp",
	"Error",
	"Intl",
	"URL",
]);

function localFunctionNames(source: string): Set<string> {
	const names = new Set<string>();
	for (const match of source.matchAll(/^\t+(?:async function|function) ([A-Za-z_]\w*)\(/gm)) {
		names.add(match[1]);
	}
	return names;
}

function push(list: string[], value: string): void {
	if (!list.includes(value)) list.push(value);
}

/**
 * The cases of `switch (message.type)` in `handleClientMessage`, in source order.
 * Throws when the dispatcher cannot be located, so a refactor that moves it makes
 * the checks fail loudly instead of checking nothing.
 */
export function extractWireCases(source: string): WireCase[] {
	const lines = source.split("\n");
	const handler = lines.findIndex((line) => line.includes("async function handleClientMessage("));
	if (handler < 0) throw new Error("handleClientMessage not found in src/server.ts");
	const switchLine = lines.findIndex((line, index) => index > handler && line === "\t\t\tswitch (message.type) {");
	if (switchLine < 0) throw new Error("switch (message.type) not found in handleClientMessage");
	const switchEnd = lines.findIndex((line, index) => index > switchLine && line === "\t\t\t}");
	if (switchEnd < 0) throw new Error("the message switch in handleClientMessage never closes");

	const starts: { index: number; type: string }[] = [];
	for (let index = switchLine + 1; index < switchEnd; index++) {
		const label = /^\t{4}(?:case "(?<type>[a-z_]+)"|(?<fallback>default)):\s*\{?$/.exec(lines[index]);
		if (label) starts.push({ index, type: label.groups?.type ?? "default" });
	}
	const functions = localFunctionNames(source);
	return starts.map((start, position) => {
		const end = (starts[position + 1]?.index ?? switchEnd) - 1;
		const body = lines.slice(start.index + 1, end + 1).join("\n");
		const masked = maskLiterals(body);
		const replies: string[] = [];
		const broadcasts: string[] = [];
		const errors: string[] = [];
		const errorExpressions: string[] = [];
		const dynamicSends: string[] = [];
		// The dispatcher's own catch answers whatever a handler throws.
		if (/\bthrow\b/.test(masked)) push(replies, "error");
		for (const send of scanSends(masked, body)) {
			const target = send.channel === "everyone" ? broadcasts : replies;
			if (send.channel === "socket" && send.socket !== "socket")
				push(dynamicSends, `${send.socket}: ${send.type ?? send.dynamic}`);
			else if (send.type) push(target, send.type);
			else push(dynamicSends, send.dynamic ?? "");
			if (send.error !== undefined) push(errors, send.error);
			else if (send.type === "error") push(errorExpressions, send.dynamic ?? "");
		}
		const helpers: string[] = [];
		for (const call of masked.matchAll(/(?<![\w.$])([A-Za-z_]\w*)\(/g)) {
			if (!NOT_CALLS.has(call[1]) && functions.has(call[1])) push(helpers, call[1]);
		}
		const members: string[] = [];
		for (const call of masked.matchAll(/\b([A-Za-z_]\w*)\??\.([A-Za-z_]\w*)\(/g)) {
			if (!NOT_MEMBERS.has(call[1])) push(members, `${call[1]}.${call[2]}`);
		}
		return {
			type: start.type,
			start: start.index + 1,
			end: end + 1,
			replies,
			broadcasts,
			errors,
			errorExpressions,
			dynamicSends,
			helpers,
			members,
		};
	});
}

export interface WireSite {
	readonly type?: string;
	readonly dynamic?: string;
	readonly error?: string;
	/** 1-based line of the send. */
	readonly line: number;
	/** The client message whose handler contains the send, when it is in one. */
	readonly caseType?: string;
	/** The local function the send is in, when it is outside the dispatcher. */
	readonly scope?: string;
	/** The nearest event subscription above the send, such as `runtime.on("x")`. */
	readonly subscription?: string;
}

/** Every console message src/server.ts sends, with where it is sent from. */
export function extractWireSites(source: string, cases: WireCase[]): WireSite[] {
	const masked = maskLiterals(source);
	const lineOf = lineMap(source);
	const lines = source.split("\n");
	const scopes = new Map<number, { indent: number; name: string }>();
	lines.forEach((line, index) => {
		const declaration = /^(\t+)(?:async function|function|const|let) ([A-Za-z_]\w*)/.exec(line);
		if (declaration) scopes.set(index + 1, { indent: declaration[1].length, name: declaration[2] });
	});
	return scanSends(masked, source).map((send): WireSite => {
		const line = lineOf(send.index);
		const sent = {
			line,
			...(send.type ? { type: send.type } : {}),
			...(send.dynamic ? { dynamic: send.dynamic } : {}),
			...(send.error !== undefined ? { error: send.error } : {}),
		};
		const owner = cases.find((entry) => line >= entry.start && line <= entry.end);
		if (owner) return { ...sent, caseType: owner.type };
		// Walking up to the next declaration at a smaller indentation finds the
		// function (or helper arrow) the send belongs to.
		const indent = lines[line - 1].match(/^\t*/)?.[0].length ?? 0;
		let scope: { line: number; name: string } | undefined;
		for (let index = line - 1; index > 0 && !scope; index--) {
			const candidate = scopes.get(index);
			if (candidate && candidate.indent < indent) scope = { line: index, name: candidate.name };
		}
		let subscription: string | undefined;
		for (let index = line; index > (scope?.line ?? 0); index--) {
			const event = /\b([\w.]+)\.on\("([^"]+)"/.exec(lines[index - 1]);
			if (event) {
				subscription = `${event[1]}.on("${event[2]}")`;
				break;
			}
		}
		return { ...sent, ...(scope ? { scope: scope.name } : {}), ...(subscription ? { subscription } : {}) };
	});
}

export interface UnionMember {
	readonly type: string;
	/** 1-based line of the member's code inside its file. */
	readonly line: number;
	/** The member's source text, comments removed and whitespace collapsed. */
	readonly normalized: string;
	readonly raw: string;
}

/**
 * The members of a top-level message union such as `SentinelClientMessage`, keyed
 * by the `type` literal of each member. A comment between two members is kept
 * with the member that follows it.
 */
export function extractUnionMembers(source: string, unionName: string): UnionMember[] {
	const lines = source.split("\n");
	const start = lines.indexOf(`export type ${unionName} =`);
	if (start < 0) throw new Error(`export type ${unionName} = not found`);
	// Members are indented; the union ends at the next top-level declaration. A
	// closing brace at column 0 still belongs to the last member.
	const end = lines.findIndex((line, index) => index > start && /^\S/.test(line) && line !== "}");
	if (end < 0) throw new Error(`${unionName} never ends`);
	const members: { line: number; raw: string[] }[] = [];
	let pending: string[] = [];
	for (const [offset, line] of lines.slice(start + 1, end).entries()) {
		if (line.startsWith("\t| ")) {
			members.push({ line: start + 2 + offset, raw: [...pending, line] });
			pending = [];
		} else if (members.length === 0 || /^\t(?:\/\*\*|\/\/| \*| \*\/)/.test(line)) {
			pending.push(line);
		} else {
			members[members.length - 1].raw.push(line);
		}
	}
	return members.map((member) => {
		const raw = member.raw.join("\n");
		const type = /\btype:\s*"([a-z_]+)"/.exec(raw)?.[1];
		if (!type) throw new Error(`a member of ${unionName} has no type literal: ${raw.slice(0, 80)}`);
		return {
			type,
			line: member.line,
			// A trailing semicolon is formatting, not a difference.
			normalized: collapse(blankOut(raw, false)).replace(/;$/, ""),
			raw,
		};
	});
}
