#!/usr/bin/env node
/**
 * A recording reverse proxy for the console contract.
 *
 * It sits between the unchanged browser console and a backend (the current one,
 * or a rewritten one), forwards every HTTP request and the `/ws` WebSocket, and
 * writes every WebSocket message to a file. On exit it reports what it saw:
 *
 * - message types that are not in the protocol, per direction;
 * - HTTP paths that match no path in docs/contract/openapi.yaml;
 * - which documented messages and paths the session never exercised.
 *
 * Usage:
 *   node scripts/contract-proxy.mjs --target <origin or entry URL>
 *        [--listen 127.0.0.1:7788] [--record frames.jsonl] [--report report.json]
 *        [--insecure] [--seconds <n>]
 *
 * --target   The backend. With the secret entry URL (…/<token>) the proxy prints
 *            the address to open through it instead.
 * --insecure Accept a TLS certificate nothing trusts.
 * --seconds Stop by itself after n seconds, as Ctrl+C would.
 *
 * Stop with Ctrl+C. The summary is printed and, with --report, written as JSON.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { parse } from "yaml";
import { extractUnionMembers, readSource } from "../test/contract/wire-source.ts";

const { values } = parseArgs({
	options: {
		target: { type: "string" },
		listen: { type: "string", default: "127.0.0.1:7788" },
		record: { type: "string" },
		report: { type: "string" },
		insecure: { type: "boolean", default: false },
		seconds: { type: "string" },
		help: { type: "boolean", default: false },
	},
});
if (values.help || !values.target) {
	console.log(
		"用法: node scripts/contract-proxy.mjs --target <后端地址或入口地址> [--listen 127.0.0.1:7788] [--record frames.jsonl] [--report report.json] [--insecure] [--seconds <秒>]",
	);
	process.exit(values.target ? 0 : 1);
}

const target = new URL(values.target);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tlsOptions = { rejectUnauthorized: !values.insecure };
const requestModule = target.protocol === "https:" ? httpsRequest : httpRequest;

/** The message types of each direction, read from the protocol source. */
const clientTypes = new Set(extractUnionMembers(readSource("src", "protocol.ts"), "SentinelClientMessage").map((m) => m.type));
const serverTypes = new Set(extractUnionMembers(readSource("src", "protocol.ts"), "SentinelServerMessage").map((m) => m.type));
const openapiPath = join(packageRoot, "docs", "contract", "openapi.yaml");
const documentedPaths = existsSync(openapiPath) ? Object.keys(parse(readFileSync(openapiPath, "utf8")).paths ?? {}) : [];

const frames = [];
const httpRequests = new Map();
let connectionIds = 0;

function record(direction, text, connection) {
	let message;
	try {
		message = JSON.parse(text);
	} catch {
		message = undefined;
	}
	frames.push({ at: new Date().toISOString(), direction, connection, message, ...(message === undefined ? { raw: text } : {}) });
}

function recordHttp(method, url, status) {
	const key = `${method} ${new URL(url, "http://proxy").pathname}`;
	const entry = httpRequests.get(key) ?? { count: 0, statuses: new Set() };
	entry.count += 1;
	entry.statuses.add(status);
	httpRequests.set(key, entry);
}

/** Whether a requested path matches a documented path, `{parameter}` segments aside. */
function matches(path, documented) {
	const left = path.split("/").filter(Boolean);
	const right = documented.split("/").filter(Boolean);
	return left.length === right.length && right.every((segment, index) => segment.startsWith("{") || segment === left[index]);
}

function report() {
	const counts = new Map();
	for (const frame of frames) {
		const key = `${frame.direction === "browser" ? "上行" : "下行"} ${frame.message?.type ?? "(not JSON)"}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const unknown = frames
		.filter((frame) => {
			const types = frame.direction === "browser" ? clientTypes : serverTypes;
			return frame.message === undefined || !types.has(frame.message.type);
		})
		.map((frame) => ({ direction: frame.direction, type: frame.message?.type ?? "(not JSON)", raw: frame.raw?.slice(0, 200) ?? JSON.stringify(frame.message).slice(0, 200) }));
	const unseenMessages = [
		...[...clientTypes].filter((type) => !frames.some((f) => f.direction === "browser" && f.message?.type === type)).map((type) => `上行 ${type}`),
		...[...serverTypes].filter((type) => !frames.some((f) => f.direction === "server" && f.message?.type === type)).map((type) => `下行 ${type}`),
	];
	const requests = [...httpRequests].map(([key, entry]) => ({ request: key, count: entry.count, statuses: [...entry.statuses] }));
	// The entry URL is different on every start, so it is known from the target
	// rather than from the document.
	const entryPath = target.pathname === "/" ? undefined : target.pathname.replace(/\/$/, "");
	const undocumentedPaths = [...new Set(requests.map((entry) => entry.request.split(" ")[1]))].filter(
		(path) => path !== entryPath && !documentedPaths.some((documented) => matches(path, documented)),
	);
	const unrequestedPaths = documentedPaths.filter(
		(documented) => !requests.some((entry) => matches(entry.request.split(" ")[1], documented)),
	);
	return {
		target: target.origin,
		messages: frames.length,
		messageCounts: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))),
		unknownMessages: unknown,
		messagesNotSeen: unseenMessages,
		httpRequests: requests.sort((a, b) => a.request.localeCompare(b.request)),
		pathsNotDocumented: undocumentedPaths,
		pathsNotRequested: unrequestedPaths,
	};
}

const server = createServer((request, response) => {
	const headers = { ...request.headers, host: target.host };
	const upstream = requestModule(
		{ hostname: target.hostname, port: target.port, method: request.method, path: request.url, headers, ...tlsOptions },
		(up) => {
			response.writeHead(up.statusCode ?? 502, up.statusMessage, up.headers);
			up.pipe(response);
			recordHttp(request.method ?? "GET", request.url ?? "/", up.statusCode ?? 0);
		},
	);
	upstream.on("error", (error) => {
		if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
		response.end(`contract-proxy: ${error.message}\n`);
	});
	request.pipe(upstream);
});

const sockets = new WebSocketServer({ noServer: true });
const STATUS_TEXT = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found" };
server.on("upgrade", (request, socket, head) => {
	const url = new URL(request.url ?? "/", "http://proxy");
	if (url.pathname !== "/ws") {
		socket.destroy();
		return;
	}
	// A browser that never opened the entry URL sends no cookie at all.
	const headers = {};
	if (request.headers.cookie) headers.cookie = request.headers.cookie;
	let upstream;
	try {
		upstream = new WebSocket(`${target.protocol === "https:" ? "wss" : "ws"}://${target.host}/ws${url.search}`, {
			headers,
			...tlsOptions,
			handshakeTimeout: 15_000,
		});
	} catch (error) {
		socket.destroy();
		console.error(`[contract-proxy] WebSocket 转发失败: ${error.message}`);
		return;
	}
	upstream.on("unexpected-response", (_request, response) => {
		socket.write(`HTTP/1.1 ${response.statusCode ?? 502} ${STATUS_TEXT[response.statusCode] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
		socket.destroy();
	});
	upstream.on("open", () => {
		sockets.handleUpgrade(request, socket, head, (client) => {
			const connection = ++connectionIds;
			// The backend closes with 4001 when the login is replaced or ends.
			client.on("message", (data, isBinary) => {
				upstream.send(data, { binary: isBinary });
				if (!isBinary) record("browser", data.toString(), connection);
			});
			upstream.on("message", (data, isBinary) => {
				client.send(data, { binary: isBinary });
				if (!isBinary) record("server", data.toString(), connection);
			});
			upstream.on("close", (code, reason) => client.close(code, reason.toString()));
			upstream.on("error", () => client.close(1011, "contract-proxy: upstream error"));
			client.on("close", () => upstream.close());
		});
	});
});

const [listenHost, listenPort] = values.listen.split(":");
server.listen(Number(listenPort), listenHost, () => {
	const base = `http://${values.listen}`;
	console.log(`契约记录代理已启动: ${base}  →  ${target.origin}`);
	console.log(target.pathname === "/" ? `用浏览器打开 ${base}` : `用浏览器打开 ${base}${target.pathname}（入口地址，经代理转发）`);
	console.log("按 Ctrl+C 停止并输出报告。");
	if (values.seconds) setTimeout(() => finish(), Number(values.seconds) * 1000);
});

let finished = false;
function finish() {
	if (finished) return;
	finished = true;
	const summary = report();
	if (values.record) {
		mkdirSync(dirname(resolve(values.record)), { recursive: true });
		writeFileSync(values.record, `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
		console.log(`已写入 ${frames.length} 帧: ${values.record}`);
	}
	if (values.report) {
		mkdirSync(dirname(resolve(values.report)), { recursive: true });
		writeFileSync(values.report, `${JSON.stringify(summary, null, "\t")}\n`);
		console.log(`已写入报告: ${values.report}`);
	}
	const unknownMessages = summary.unknownMessages.length;
	const undocumented = summary.pathsNotDocumented.length;
	console.log(`消息 ${summary.messages} 帧；协议之外的消息 ${unknownMessages} 帧；文档没有的 HTTP 路径 ${undocumented} 个。`);
	for (const frame of summary.unknownMessages.slice(0, 20)) {
		console.log(`  协议之外: ${frame.direction === "browser" ? "上行" : "下行"} ${frame.type}  ${frame.raw}`);
	}
	for (const path of summary.pathsNotDocumented) console.log(`  文档没有的路径: ${path}`);
	console.log(`本次没有出现的消息 ${summary.messagesNotSeen.length} 种，没有请求到的路径 ${summary.pathsNotRequested.length} 个（完整名单见报告）。`);
	sockets.clients.forEach((client) => client.terminate());
	sockets.close();
	server.close(() => process.exit(unknownMessages > 0 || undocumented > 0 ? 1 : 0));
	server.closeAllConnections();
}

process.on("SIGINT", () => finish());
process.on("SIGTERM", () => finish());
