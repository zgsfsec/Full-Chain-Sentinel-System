/**
 * The backend the acceptance tests talk to, reached only the way the browser
 * reaches it: HTTP, and the `/ws` WebSocket.
 *
 * Without `SENTINEL_CONTRACT_URL` the real server is started in this process on
 * a temporary configuration directory, with the secret entry URL, the login and
 * the authorization promise switched on, as an operator runs it. A fake `docker`
 * stands in for the container backend.
 *
 * With `SENTINEL_CONTRACT_URL` set, the tests talk to a backend that is already
 * running, which may be the rewritten one, and leave how it is configured alone:
 *
 *   SENTINEL_CONTRACT_URL            entry URL, e.g. https://10.0.0.5:7777/AbCdEfGhIjKl
 *   SENTINEL_CONTRACT_USERNAME       an account on that backend
 *   SENTINEL_CONTRACT_PASSWORD       its password
 *   SENTINEL_CONTRACT_ACCEPT_CONSENT 1 lets the tests accept the authorization
 *                                    promise for that account
 *   SENTINEL_CONTRACT_DESTRUCTIVE    1 lets the tests log out, replace the
 *                                    session and change the password
 *
 * A backend that serves HTTPS with a certificate nothing trusts is accepted as is.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionDirPath, SessionManager } from "@earendil-works/pi-coding-agent";
import { WebSocket } from "ws";
import { addProject, setLastActiveProject } from "../../src/projects.ts";
import type { SentinelServerMessage } from "../../src/protocol.ts";
import { ReportStore, reportsDbPath } from "../../src/reports.ts";
import { startSentinelServer } from "../../src/server.ts";
import { installFakeDocker } from "../fake-docker.ts";

export interface Reply {
	readonly status: number;
	readonly headers: Headers;
	readonly text: string;
	json<T extends object = Record<string, unknown>>(): T;
}

export interface RequestOptions {
	readonly body?: string;
	readonly type?: string;
	/** Extra request headers, such as a token a route reads instead of the cookies. */
	readonly headers?: Record<string, string>;
	/** Leave the cookies out, as a browser that never logged in would. */
	readonly anonymous?: boolean;
}

/** One console connection. Messages are kept in order until they are read. */
export interface ConsoleSocket {
	/** The next message that `accept` takes, or a rejection when none arrives in time. */
	next(accept: (message: SentinelServerMessage) => boolean, timeoutMs?: number): Promise<SentinelServerMessage>;
	/** Everything received so far that no `next` has taken. */
	pending(): SentinelServerMessage[];
	send(message: object): void;
	sendRaw(text: string): void;
	/** Resolves when the server closes the connection. */
	closed(): Promise<{ code: number; reason: string }>;
	close(): void;
}

/** How to reach a backend, shared by both ways of getting one. */
export interface Transport {
	/** Cookie values by name, sent with every request that is not anonymous. */
	readonly cookies: Map<string, string>;
	/** Stores a cookie from a `Set-Cookie` header and returns its attributes. */
	keepCookie(header: string | null | undefined): string[];
	request(method: string, path: string, options?: RequestOptions): Promise<Reply>;
	socket(): Promise<ConsoleSocket>;
}

export interface ContractTarget extends Transport {
	readonly mode: "in-process" | "external";
	/** Scheme, host and port. */
	readonly origin: string;
	/** The secret entry path, `/<token>`, when the backend has the gate switched on. */
	readonly entryPath: string | null;
	/** Whether the tests may log out, replace the session and change the password. */
	readonly mayChangeAccount: boolean;
	/** Whether the tests may accept the authorization promise for the account. */
	readonly mayAcceptConsent: boolean;
	/** What the backend was started with, when the tests started it themselves. */
	readonly seeded?: { readonly conversationTitle: string };
	readonly username: string;
	readonly password: string;
	close(): Promise<void>;
}

/** `name=value; Path=/; HttpOnly` → the name, the value and the attributes after it. */
function parseSetCookie(header: string): { name: string; value: string; attributes: string[] } {
	const [pair, ...attributes] = header.split(";");
	const at = pair.indexOf("=");
	return { name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim(), attributes };
}

function cookieHeader(cookies: Map<string, string>): string | undefined {
	if (cookies.size === 0) return undefined;
	return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** The shared methods read the origin off the target they end up in. */
type Reaching = Transport & { readonly origin: string };

const transport: Transport = {
	cookies: new Map<string, string>(),

	keepCookie(header) {
		const parsed = parseSetCookie(header ?? "");
		this.cookies.set(parsed.name, parsed.value);
		return parsed.attributes.map((attribute) => attribute.trim());
	},

	async request(this: Reaching, method, path, options = {}) {
		const headers = new Headers(options.headers);
		if (options.type) headers.set("content-type", options.type);
		const cookie = options.anonymous ? undefined : cookieHeader(this.cookies);
		if (cookie) headers.set("cookie", cookie);
		const response = await fetch(`${this.origin}${path}`, {
			method,
			headers,
			body: options.body,
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		return {
			status: response.status,
			headers: response.headers,
			text,
			json: <T extends object = Record<string, unknown>>() => JSON.parse(text) as T,
		};
	},

	socket(this: Reaching) {
		return new Promise((resolve, reject) => {
			const headers: Record<string, string> = {};
			const cookie = cookieHeader(this.cookies);
			if (cookie) headers.cookie = cookie;
			// A backend may serve HTTPS with a certificate nothing trusts.
			const socket = new WebSocket(`${this.origin.replace(/^http/, "ws")}/ws`, {
				headers,
				rejectUnauthorized: false,
				handshakeTimeout: 15_000,
			});
			const received: SentinelServerMessage[] = [];
			const waiters: {
				accept: (message: SentinelServerMessage) => boolean;
				resolve: (message: SentinelServerMessage) => void;
				timer: ReturnType<typeof setTimeout>;
			}[] = [];
			let announceClose: (result: { code: number; reason: string }) => void = () => {};
			const closed = new Promise<{ code: number; reason: string }>((resolveClosed) => {
				announceClose = resolveClosed;
			});
			socket.on("message", (data) => {
				const message = JSON.parse(String(data)) as SentinelServerMessage;
				const index = waiters.findIndex((waiter) => waiter.accept(message));
				if (index < 0) {
					received.push(message);
					return;
				}
				const [waiter] = waiters.splice(index, 1);
				clearTimeout(waiter.timer);
				waiter.resolve(message);
			});
			socket.on("close", (code, reason) => announceClose({ code, reason: reason.toString() }));
			// After the connection is open, a failing socket surfaces as a close.
			socket.on("error", () => {});
			socket.once("open", () =>
				resolve({
					next: (accept, timeoutMs = 10_000) =>
						new Promise((resolveNext, rejectNext) => {
							const index = received.findIndex(accept);
							if (index >= 0) {
								resolveNext(received.splice(index, 1)[0]);
								return;
							}
							const waiter = {
								accept,
								resolve: resolveNext,
								timer: setTimeout(() => {
									waiters.splice(waiters.indexOf(waiter), 1);
									const seen = received.map((entry) => entry.type).join(", ") || "nothing";
									rejectNext(
										new Error(`no matching message within ${timeoutMs} ms; received so far: ${seen}`),
									);
								}, timeoutMs),
							};
							waiters.push(waiter);
						}),
					pending: () => received,
					send: (message) => socket.send(JSON.stringify(message)),
					sendRaw: (text) => socket.send(text),
					closed: () => closed,
					close: () => socket.close(),
				}),
			);
			socket.once("error", (error: Error) => reject(new Error(error.message)));
			socket.once("unexpected-response", (_request, response) => {
				reject(new Error(`the WebSocket handshake was answered with HTTP ${response.statusCode}`));
				socket.terminate();
			});
		});
	},
};

const USERNAME = "contract-operator";
const PASSWORD = "contract-password-1";
const SEEDED_CONVERSATION = "检查示例目标的登录入口";

/** What the tests need the backend they talk to to start with. */
export interface TargetOptions {
	/**
	 * A selected project that already holds a conversation and a report, as a
	 * console that has been used does. Only a backend the tests start themselves
	 * can be given one; another backend is left as it is.
	 */
	readonly used?: boolean;
}

export async function openContractTarget(options: TargetOptions = {}): Promise<ContractTarget> {
	const external = process.env.SENTINEL_CONTRACT_URL;
	if (external) {
		const url = new URL(external);
		return {
			...transport,
			mode: "external",
			origin: url.origin,
			entryPath: url.pathname === "/" ? null : url.pathname.replace(/\/$/, ""),
			mayChangeAccount: process.env.SENTINEL_CONTRACT_DESTRUCTIVE === "1",
			mayAcceptConsent: process.env.SENTINEL_CONTRACT_ACCEPT_CONSENT === "1",
			username: process.env.SENTINEL_CONTRACT_USERNAME ?? USERNAME,
			password: process.env.SENTINEL_CONTRACT_PASSWORD ?? PASSWORD,
			close: async () => {},
		};
	}

	const root = mkdtempSync(join(tmpdir(), "sentinel-contract-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const workspace = join(root, "workspace");
	const docker = installFakeDocker(root, workspace);
	let workDir = workspace;
	if (options.used) {
		const created = await addProject(agentDir, { name: "契约项目" });
		if (!created.project) throw new Error(`项目创建失败：${created.error ?? "未知原因"}`);
		setLastActiveProject(agentDir, created.project.id);
		workDir = created.project.workDir;
		// What only the agent's own activity leaves behind: a conversation and its report.
		const session = SessionManager.create(workDir, getSessionDirPath(workDir, agentDir));
		session.appendMessage({ role: "user", content: SEEDED_CONVERSATION, timestamp: Date.now() });
		const reports = new ReportStore(reportsDbPath(agentDir));
		reports.save({
			provenance: {
				projectId: created.project.id,
				projectName: created.project.name,
				source: "session",
				sessionId: session.getSessionId(),
			},
			key: "contract-report",
			title: "示例报告",
			markdown: "# 示例报告\n\n这是报告正文。\n",
			images: [],
		});
		reports.close();
	}
	const server = await startSentinelServer({ agentDir, cwd: workspace, port: 0 });
	return {
		...transport,
		mode: "in-process",
		origin: new URL(server.url).origin,
		entryPath: new URL(server.url).pathname,
		mayChangeAccount: true,
		mayAcceptConsent: true,
		...(options.used ? { seeded: { conversationTitle: SEEDED_CONVERSATION } } : {}),
		username: USERNAME,
		password: PASSWORD,
		close: async () => {
			server.close();
			docker.restore();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
