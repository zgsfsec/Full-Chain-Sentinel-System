/**
 * Full Chain Sentinel web console server.
 *
 * Serves the built browser UI over HTTP and exposes a JSON WebSocket protocol
 * (see protocol.ts) that drives one Full Chain Sentinel runtime. Designed for a single
 * local operator; every connected console receives the same event stream.
 */

import { randomBytes, X509Certificate } from "node:crypto";
import { createReadStream, mkdtempSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, extname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { WebSocket, WebSocketServer } from "ws";
import { parseAssetImport, previewAssetImport } from "./asset-import.ts";
import { AssetInputError, AssetLibraryStore, assetLibraryDbPath } from "./asset-library.ts";
import { readWebuiFile } from "./assets.ts";
import {
	changePassword,
	clearSessionCookieHeader,
	createAuth,
	createLoginLimiter,
	hasValidSession,
	issueSessionToken,
	readStoredAuth,
	revokeSessions,
	type StoredAuth,
	sessionCookieHeader,
	validateCredentials,
	verifyLogin,
} from "./auth.ts";
import { buildImage, containerStates, deleteProjectWorkDir } from "./docker.ts";
import { deleteDoctrine, listDoctrines, saveDoctrine } from "./doctrines.ts";
import { DroidGateway } from "./droid-gateway.ts";
import { testModelConfig } from "./endpoint-probe.ts";
import { EngineManager, engineHasWorkInFlight } from "./engine.ts";
import { checkEnvironment } from "./env-check.ts";
import { guessMimeType } from "./files.ts";
import { FolderArchiveManager, folderArchiveContentDisposition } from "./folder-archive.ts";
import { getServerLanguage, setServerLanguage, t } from "./i18n.ts";
import { IosGateway } from "./ios-gateway.ts";
import { readProviderModelConfig } from "./model-config.ts";
import { DEFAULT_TEST_URL } from "./node-test.ts";
import { buildOpenVpnProfile } from "./openvpn.ts";
import {
	deletePreset,
	exportFileName,
	exportPresets,
	importPresets,
	presetView,
	presetViews,
	savePreset,
	setPresetEnabled,
} from "./presets.ts";
import {
	addProject,
	changeProjectProxy,
	clearProxyFromProjects,
	ensureProjectReady,
	listProjects,
	recreateProject,
	refreshProjectGateways,
	removeProject,
	resolveStartupProject,
	setLastActiveProject,
	setProjectProxy,
	startProject,
	stopProject,
} from "./projects.ts";
import type {
	SentinelClientMessage,
	SentinelEnvReport,
	SentinelProjectInfo,
	SentinelProxy,
	SentinelProxyConfigView,
	SentinelServerMessage,
} from "./protocol.ts";
import { checkProxyConnection } from "./proxy-check.ts";
import { switchProjectNode } from "./proxy-switch.ts";
import { VulnReviewer } from "./reviewer.ts";
import { SubscriptionScheduler } from "./subscription-scheduler.ts";
import { createTerminal } from "./terminal.ts";
import { readUiConfig, writeUiConfig } from "./ui-config.ts";
import { buildWireGuardConfig } from "./wireguard.ts";
import type { WorkerSession } from "./worker.ts";

interface AcquiredTaskSession {
	session: WorkerSession;
	manager: SessionManager;
}

import {
	CONSENT_VERSION,
	type ConsentStatus,
	consentStatus,
	consentTextFor,
	isConsentExemptPath,
	writeConsentRecord,
} from "./consent.ts";
import {
	DEFAULT_CONTAINER_NETWORK,
	normalizeContainerNetwork,
	readContainerNetwork,
	writeContainerNetwork,
} from "./container-network.ts";
import { gateCookieHeader, generateGateToken, hasValidGate, isGateEntry, sendGateNotFound } from "./gate.ts";
import { getOfficialPlugin, listOfficialPlugins } from "./official-plugins.ts";
import { readPluginPackage } from "./plugin-package.ts";
import { effectivePluginHosts } from "./plugin-store.ts";
import { POC_IMPORT_MAX_BYTES, PocImportManager } from "./poc-import.ts";
import {
	buildSingboxConfig,
	DEFAULT_SINGBOX_IMAGE,
	deleteProxy,
	proxyConfigView,
	readProxies,
	recordProxyTest,
	refreshProxySubscription,
	resolveProjectProxy,
	saveProxy,
	setDefaultProxy,
	setProxyImage,
	setProxyNode,
	testProxyNodes,
} from "./proxy.ts";
import { SentinelRuntime } from "./sentinel-session.ts";
import { checkProxyProfile, hasSingboxImage, pullSingboxImage } from "./singbox.ts";
import { EMPTY_SOURCES, normalizeSources, readSources, writeSources } from "./sources.ts";
import { storeUpload } from "./upload.ts";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json; charset=utf-8",
	".woff2": "font/woff2",
};

function fallbackPage(): string {
	return `<!doctype html>
<html lang="${getServerLanguage() === "zh" ? "zh-CN" : "en"}">
<head><meta charset="utf-8"><title>${t("全链哨兵 控制台")}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"></head>
<body style="background:#111418;color:#d7dde4;font-family:system-ui;padding:48px;line-height:1.7">
<h1>${t("全链哨兵 Web 控制台")}</h1>
<p>${t("前端资源尚未构建。请在仓库根目录执行：")}</p>
<pre style="background:#1b2027;padding:12px;border-radius:8px">npm --prefix packages/web run build</pre>
<p>${t("构建完成后刷新本页。")}</p>
</body></html>`;
}

export interface SentinelServerOptions {
	cwd?: string;
	agentDir?: string;
	host?: string;
	port?: number;
	/**
	 * Console authentication (default on). Only the automated tests turn it off;
	 * the credential file is created on first visit.
	 */
	auth?: boolean;
	/**
	 * Secret entry URL (default: on exactly when authentication is). Opening
	 * `/<token>` sets a cookie and redirects to `/`; every other request without
	 * that cookie is answered with a plain 404, so a console bound to a public
	 * address cannot be fingerprinted or indexed. Off means `/` is the console.
	 */
	gate?: boolean;
	/** A fixed entry token; by default a fresh one is generated on every start. */
	gateToken?: string;
	/**
	 * Serve HTTPS (the page and its WebSocket over TLS on the same listener).
	 * Off means plain HTTP — the automated tests run that way; the CLI turns it
	 * on by default and hands the PEM contents here.
	 */
	tls?: { cert: string; key: string };
	/**
	 * First-visit authorization promise (default: on exactly when authentication
	 * is). Until the operator accepts the statement, `/api` and the WebSocket
	 * answer 403 and only the statement itself is served.
	 */
	consent?: boolean;
}

export function webuiDistDir(): string {
	// dist/server.js -> package root -> webui/dist
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "webui", "dist");
}

/**
 * Capability tokens for plugin UI assets.
 *
 * The iframe is sandboxed without allow-same-origin, so its document has an
 * opaque origin and the browser does not send the console's gate or session
 * cookie with its subresource requests. A cookie-protected /plugin-ui would
 * answer 404 for every script and stylesheet. Instead the console issues a
 * random token when the authenticated WebSocket asks to open a UI, and the
 * iframe URL carries it in the path so relative assets inherit it.
 */
const PLUGIN_UI_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const pluginUiTokens = new Map<string, { hostId: string; pluginId: string; expiresAt: number }>();

function issuePluginUiToken(hostId: string, pluginId: string): string {
	const now = Date.now();
	for (const [token, entry] of pluginUiTokens) {
		if (entry.expiresAt <= now) pluginUiTokens.delete(token);
	}
	const token = randomBytes(24).toString("base64url");
	pluginUiTokens.set(token, { hostId, pluginId, expiresAt: now + PLUGIN_UI_TOKEN_TTL_MS });
	return token;
}

/** A plugin's sidebar icon, proxied through the console session (same-origin <img>). */
async function servePluginIcon(
	runtime: SentinelRuntime,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const parts = (request.url ?? "/").split("?")[0].split("/").filter(Boolean);
	try {
		const hostId = decodeURIComponent(parts[1] ?? "");
		const pluginId = decodeURIComponent(parts[2] ?? "");
		const file = decodeURIComponent(parts[3] ?? "");
		if (!hostId || !pluginId || !/^[A-Za-z0-9._-]+\.(svg|png)$/.test(file)) {
			sendJson(response, { error: t("没有这个图标") }, 404);
			return;
		}
		const asset = await runtime.getPluginUiFile(hostId, pluginId, file);
		response.writeHead(200, {
			"content-type": file.endsWith(".svg") ? "image/svg+xml" : "image/png",
			"content-length": String(asset.data.length),
			"cache-control": "private, max-age=60",
			"x-content-type-options": "nosniff",
		});
		response.end(asset.data);
	} catch {
		sendJson(response, { error: t("没有这个图标") }, 404);
	}
}

/**
 * Serve a plugin's frontend through the console's own origin.
 *
 * The iframe cannot point at `http://127.0.0.1:<port>`: the console is HTTPS, so
 * the browser would block it as mixed content. Proxying under the console origin
 * also means the host token and the plugin container port never reach the page.
 * The response is a static asset, nothing else; the bridge is postMessage.
 */
async function servePluginUi(agentDir: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
	const url = new URL(request.url ?? "/", "http://localhost");
	const parts = url.pathname.split("/").filter(Boolean);
	const token = parts[1] ?? "";
	const grant = pluginUiTokens.get(token);
	if (!grant || grant.expiresAt <= Date.now()) {
		sendJson(response, { error: t("没有这个界面") }, 404);
		return;
	}
	let hostId = "";
	try {
		hostId = parts[2] ? decodeURIComponent(parts[2]) : "";
	} catch {
		sendJson(response, { error: t("插件主机 id 非法") }, 400);
		return;
	}
	let pluginId = "";
	try {
		pluginId = parts[3] ? decodeURIComponent(parts[3]) : "";
	} catch {
		sendJson(response, { error: t("插件 id 非法") }, 400);
		return;
	}
	if (!hostId || !pluginId || grant.hostId !== hostId || grant.pluginId !== pluginId) {
		sendJson(response, { error: t("没有这个界面") }, 404);
		return;
	}
	const host = effectivePluginHosts(agentDir).find((entry) => entry.id === hostId);
	if (!host) {
		sendJson(response, { error: t("插件主机不存在") }, 404);
		return;
	}
	const rest: string[] = [];
	for (const raw of parts.slice(4)) {
		let segment: string;
		try {
			segment = decodeURIComponent(raw);
		} catch {
			sendJson(response, { error: t("界面路径非法") }, 400);
			return;
		}
		if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
			sendJson(response, { error: t("界面路径非法") }, 400);
			return;
		}
		rest.push(encodeURIComponent(segment));
	}
	const upstreamPath = `/plugins/${encodeURIComponent(pluginId)}/ui/${rest.join("/")}`;
	let upstream: Response;
	try {
		upstream = await fetch(`${host.url}${upstreamPath}${url.search}`, {
			headers: { authorization: `Bearer ${host.token}` },
			signal: AbortSignal.timeout(20000),
		});
	} catch (error) {
		sendJson(
			response,
			{ error: t("读取插件界面失败：{error}", { error: error instanceof Error ? error.message : String(error) }) },
			502,
		);
		return;
	}
	const body = Buffer.from(await upstream.arrayBuffer());
	response.writeHead(upstream.status, {
		"content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
		"content-length": String(body.length),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		// A module script loaded from a sandboxed (opaque) origin is a CORS request.
		"access-control-allow-origin": "*",
	});
	response.end(body);
}

function sendJson(response: ServerResponse, payload: unknown, status = 200): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(payload));
}

/** Read one JSON request body; oversize or malformed bodies become null. */
async function readJsonBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown> | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request.iterator({ destroyOnReturn: false })) {
		size += (chunk as Buffer).byteLength;
		if (size > maxBytes) {
			request.resume();
			return null;
		}
		chunks.push(chunk as Buffer);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function textField(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	return typeof value === "string" ? value : "";
}

function sendTo(socket: WebSocket, message: SentinelServerMessage): void {
	if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** File mutations report their own outcome so the panel can show it in place. */
async function runFileAction(
	socket: WebSocket,
	action: string,
	path: string,
	run: () => Promise<unknown>,
): Promise<void> {
	try {
		await run();
		sendTo(socket, { type: "file_result", action, path, ok: true });
	} catch (error) {
		sendTo(socket, {
			type: "file_result",
			action,
			path,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function sendFile(response: ServerResponse, body: Buffer, relativePath: string): void {
	const type = MIME_TYPES[extname(relativePath)] ?? "application/octet-stream";
	response.writeHead(200, {
		"content-type": type,
		"content-length": body.byteLength,
		// Hashed assets are immutable, but index.html must always revalidate so a
		// rebuilt frontend is picked up without a hard refresh.
		...(relativePath.endsWith(".html") ? { "cache-control": "no-cache" } : {}),
	});
	response.end(body);
}

/**
 * Serve the frontend from disk when the file is there (a checkout), otherwise from
 * the copy embedded in the executable (a single-file binary). Unknown paths fall
 * back to index.html so client-side routing survives a reload.
 */
function serveStatic(distDir: string, requestPath: string, response: ServerResponse): void {
	let relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
	// URL paths are POSIX. Using the platform `normalize` here turns them into
	// backslashes on Windows and breaks the embedded map, which is keyed with `/`.
	relative = posix.normalize(relative).replace(/^(\.\.[/\\])+/, "");
	const filePath = join(distDir, relative);
	const insideDist = filePath.startsWith(distDir);
	if (insideDist) {
		const body = readWebuiFile(relative, distDir);
		if (body) {
			sendFile(response, body, relative);
			return;
		}
	}
	const index = readWebuiFile("index.html", distDir);
	if (!index) {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(fallbackPage());
		return;
	}
	sendFile(response, index, "index.html");
}

export async function startSentinelServer(
	options: SentinelServerOptions = {},
): Promise<{ close: () => void; url: string; environment: Promise<SentinelEnvReport> }> {
	const startupCwd = resolve(options.cwd ?? process.cwd());
	const clients = new Set<WebSocket>();
	const clientRequests = new WeakMap<WebSocket, IncomingMessage>();
	/** Profiles whose connectivity test is running; one is enough per profile. */
	const proxyChecksInFlight = new Set<string>();
	const proxyImagePulls = new Map<string, Promise<{ ok: boolean; error?: string }>>();
	const agentDir = options.agentDir;
	if (agentDir) setServerLanguage(readUiConfig(agentDir).language);
	// The gate follows authentication by default: a console with no password to
	// protect (the automated tests) is not the deployment this guards, and one that
	// has a password should not be visible before its login page.
	const gateEnabled = options.gate ?? (options.auth !== false && Boolean(agentDir));
	const gateToken = gateEnabled ? (options.gateToken ?? generateGateToken()) : "";
	// The authorization promise follows authentication too: it is tied to the
	// account that accepts it, so a console with no account has nothing to record.
	const consentEnabled = options.consent ?? (options.auth !== false && Boolean(agentDir));
	const startup = agentDir ? await resolveStartupProject(agentDir) : {};
	// The operator's own shell. It is not a tool call: it is never gated and never
	// audited, and it outlives the panel that opened it — a listener started there has
	// to keep running while the operator does something else.
	const terminal = createTerminal({
		onOutput: (projectId, data) => broadcast({ type: "terminal_output", projectId, data }),
		onExit: (projectId, code) => broadcast({ type: "terminal_exit", projectId, code }),
	});
	const runtime = new SentinelRuntime({
		cwd: startup.project?.workDir ?? startupCwd,
		agentDir,
		activeProject: startup.project
			? {
					id: startup.project.id,
					name: startup.project.name,
					container: startup.project.container,
					cwd: startup.project.workDir,
				}
			: undefined,
		hooks: {
			onSessionEvent: (event) => broadcast({ type: "session_event", event }),
			onStateChange: () => broadcastSnapshot(),
			onSubagentEvent: (runId, event) => broadcast({ type: "subagent_event", runId, event }),
			onNotifyStatus: (status) => broadcast({ type: "notify_config", config: runtime.getNotifyConfig(), status }),
			onVulnChange: () => broadcastVulns(),
			onAssetChange: () => broadcast({ type: "assets_changed" }),
			onSessionRenamed: () => void broadcastSessions(),
			onVulnSubmitted: (id) => reviewer?.enqueue(id),
			// Every judgment is broadcast: a console with the audit page open appends
			// the new row live instead of waiting for a refresh.
			onGateDecision: (decision) => broadcast({ type: "gate_decision", decision }),
			onPocChange: () => broadcastPocs(),
			onPocSourceChange: () => broadcast({ type: "poc_sources", sources: runtime.listPocSources() }),
			// A modeling run changed (started, submitted, ended): the page is a list
			// of records, so the whole list is what goes out.
			onApiModelChange: () => broadcastApiModels(),
			onDroidChange: () => broadcastDroidDevices(),
			onIosChange: () => broadcastIosDevices(),
			onSupervisorState: (view) => broadcast({ type: "supervisor_state", supervisor: view }),
			onSupervisorEpisode: (episode, calls) => broadcast({ type: "supervisor_episode", episode, calls }),
			onSupervisorLog: (sessionId, log) => broadcast({ type: "supervisor_log", sessionId, log }),
			onSupervisorAdvice: (advice) => broadcast({ type: "supervisor_advice", advice }),
		},
	});
	const pocImports = new PocImportManager((file, onProgress, signal) =>
		runtime.importPocBytes([file], { onProgress, signal }),
	);
	// Folder archives live outside the project work directory: a partial or
	// finished archive must not show up in the file panel or be read by the
	// agent. The directory is private to this process and removed on shutdown.
	const folderArchiveDir = agentDir ? join(agentDir, "downloads") : mkdtempSync(join(tmpdir(), "sentinel-archives-"));
	const folderArchives = new FolderArchiveManager({ dir: folderArchiveDir });
	/**
	 * Refreshes subscriptions whose interval has elapsed. It pushes the new config
	 * with `push: true`: the page did not ask for it, so it must not release a form
	 * that is waiting for its own answer.
	 */
	const subscriptionScheduler = agentDir
		? new SubscriptionScheduler(agentDir, () => {
				void proxyView().then((config) => broadcast({ type: "proxy_config", config, push: true }));
				void afterProxyChange().catch((error: unknown) => {
					broadcast({ type: "error", message: error instanceof Error ? error.message : String(error) });
				});
			})
		: undefined;
	subscriptionScheduler?.start();

	/**
	 * Docker environment state. The check runs once at startup and on demand; every
	 * prompt waits for it, because a run without a working container backend can
	 * only fail. `imageBuild` is set while a `docker build` is streaming.
	 */
	let envReport: SentinelEnvReport | undefined;
	let envCheck: Promise<SentinelEnvReport> | undefined;
	let imageBuild: AbortController | undefined;

	/**
	 * Engineering mode. One manager owns every engine across projects; the
	 * hooks push engine state and the commander's decision log to all consoles.
	 */
	const engines = agentDir
		? new EngineManager(
				agentDir,
				{
					onChange: (engine) => {
						broadcast({ type: "engine_update", engine });
						// Task statuses feed the sidebar badges.
						void broadcastSessions();
					},
					onCommanderEvent: (engineId, event) => broadcast({ type: "engine_commander_event", engineId, event }),
					onTaskEvent: (taskId, event) => broadcast({ type: "engine_task_event", taskId, event }),
					beforeStart: async () => {
						// A plan can fire hours after it was saved, so the cached startup
						// report is too old to prove Docker is still healthy.
						const report = await ensureEnvironment(true);
						broadcastEnvironment();
						return report.ok ? { ok: true } : { ok: false, error: blockedReason(report) };
					},
				},
				// Task sessions are created by the runtime in the project's normal
				// session directory, so they are first-class conversations.
				(options) => runtime.acquireTaskSession(options) as unknown as Promise<AcquiredTaskSession>,
			)
		: undefined;

	// One-time, best-effort: fill 工程/任务/会话名 on findings submitted before
	// those columns existed. It runs off the startup path, because listing every
	// project's sessions must not delay the console.
	if (runtime.needsVulnProvenanceBackfill()) {
		void runtime
			.backfillVulnProvenance(engines?.taskSessionRefs() ?? new Map())
			.then((filled) => {
				if (filled > 0) broadcastVulns();
			})
			.catch(() => {
				// Provenance is enrichment: the hub works without it.
			});
	}

	/**
	 * The vulnerability reviewer: a dedicated LLM calibrating every fresh
	 * finding's severity/CVSS and flagging hallucination suspects. Hub layer
	 * only — the main agent never sees or waits for it. Shares the commander's
	 * endpoint configuration, falling back to the main endpoint.
	 */
	const reviewer = agentDir
		? new VulnReviewer(
				runtime.vulnerabilityStore(),
				{
					onSettled: (vuln) => {
						void broadcastVulns();
						if (vuln && (vuln.severity === "critical" || vuln.severity === "high")) {
							runtime.notifyReviewedHighSeverity(vuln);
						}
					},
				},
				agentDir,
			)
		: undefined;
	reviewer?.recover();

	function broadcastEngines(socket?: WebSocket): void {
		if (!engines) return;
		const view = { type: "engines", engines: engines.listEngines() } satisfies SentinelServerMessage;
		if (socket) sendTo(socket, view);
		else broadcast(view);
	}

	function consoleUrl(): string {
		const address = server.address();
		const boundPort = address && typeof address === "object" ? address.port : (options.port ?? 7777);
		const boundHost = options.host ?? "127.0.0.1";
		// A wildcard bind is not a browser address.
		const shownHost = boundHost === "0.0.0.0" || boundHost === "::" || boundHost === "[::]" ? "127.0.0.1" : boundHost;
		// With the gate on, the console address is the entry URL: it is the only one
		// that works, so this is what the environment page shows and what the startup
		// log prints.
		return `${options.tls ? "https" : "http"}://${shownHost}:${boundPort}${gateEnabled ? `/${gateToken}` : ""}`;
	}

	/** The current report, running the check first if there is none or `force` is set. */
	async function ensureEnvironment(force = false): Promise<SentinelEnvReport> {
		if (!force && envReport) return envReport;
		if (!force && envCheck) return await envCheck;
		const run = (async () => {
			const report = await checkEnvironment({ agentDir, url: consoleUrl() });
			envReport = report;
			return report;
		})();
		envCheck = run;
		try {
			return await run;
		} finally {
			if (envCheck === run) envCheck = undefined;
		}
	}

	function broadcastEnvironment(): void {
		if (!envReport) return;
		broadcast({ type: "environment", report: envReport, building: imageBuild !== undefined });
	}

	/** Why a run cannot start, phrased for the operator. */
	function blockedReason(report: SentinelEnvReport): string {
		const blocker = report.items.find((entry) => entry.blocking && entry.status !== "ok");
		const detail = blocker ? `${blocker.label}：${blocker.detail}` : t("环境检查未通过");
		return t("Docker 环境不可用（{detail}）。请在「设置 → 环境」中修复后复检。", { detail });
	}

	function broadcast(message: SentinelServerMessage): void {
		let data: string;
		try {
			data = JSON.stringify(message);
		} catch (error) {
			console.error("[sentinel-server] broadcast serialization failed:", error);
			return;
		}
		for (const client of clients) {
			if (client.readyState === WebSocket.OPEN) client.send(data);
		}
	}

	function broadcastSnapshot(): void {
		broadcast({ type: "snapshot", snapshot: runtime.snapshot() });
	}

	/** Findings of the active project, pushed when one is submitted or reviewed. */
	function broadcastVulns(): void {
		const view = runtime.listVulns();
		broadcast({ type: "vulns", items: view.items, stats: view.stats });
	}

	/** The POC library, pushed when the operator imports or deletes templates. */
	function broadcastPocs(): void {
		const view = runtime.listPocs();
		broadcast({
			type: "pocs",
			items: view.items,
			stats: view.stats,
			total: view.total,
			page: view.page,
			pageSize: view.pageSize,
		});
	}

	/**
	 * The business-modeling runs. The list is project-scoped on the page, so the
	 * whole set goes out and the console filters it, the way the engine board does.
	 */
	function broadcastApiModels(): void {
		broadcast({ type: "api_models", items: runtime.listApiModels() });
	}

	/** Non-internal IPv4 addresses of this host, for the listen-address picker. */
	function lanIps(): string[] {
		const ips: string[] = [];
		for (const addresses of Object.values(networkInterfaces())) {
			for (const address of addresses ?? []) {
				if (address.family === "IPv4" && !address.internal) ips.push(address.address);
			}
		}
		return ips;
	}

	/** Device gateway state, pushed whenever a device or token changes. */
	function broadcastDroidDevices(): void {
		const state = runtime.droidState();
		broadcast({
			type: "droid_state",
			enabled: state.enabled,
			devices: state.devices,
			tokens: state.tokens,
			listen: droidGateway.listenInfo() ?? null,
			listenConfig: runtime.droidListenConfig(),
			lanIps: lanIps(),
		});
	}

	/** iOS device page state, pushed whenever a device or token changes. */
	function broadcastIosDevices(): void {
		const state = runtime.iosState();
		broadcast({
			type: "ios_state",
			enabled: state.enabled,
			devices: state.devices,
			tokens: state.tokens,
			listen: iosGateway.listenInfo() ?? null,
			listenConfig: runtime.iosListenConfig(),
			lanIps: lanIps(),
			certPin,
		});
	}

	/**
	 * Project list with each project's finding and gate-record counts, for the
	 * delete warning, plus the container's real state so the page can offer the
	 * action that applies (start, stop, or nothing).
	 *
	 * The state comes from one `docker ps -a`, not one inspect per project.
	 */
	async function projectInfos(): Promise<SentinelProjectInfo[]> {
		if (!agentDir) return [];
		const states = await containerStates();
		const proxies = readProxies(agentDir);
		return listProjects(agentDir).projects.map(({ id, name, workDir, container, manualStop, proxyId, proxyNode }) => {
			const wanted = proxyId === undefined ? proxies.defaultId : proxyId;
			const profile = proxies.proxies.find((entry) => entry.id === wanted);
			// The node the row shows is the one that will actually be used: a pinned
			// node the subscription dropped resolves to the profile's own choice, the
			// same way the sidecar's configuration resolves it.
			const nodes = profile?.mode === "subscription" ? profile.nodes : [];
			const chosen =
				nodes.find((node) => node.tag === proxyNode) ?? nodes.find((node) => node.tag === profile?.nodeTag);
			return {
				id,
				name,
				cwd: workDir,
				container,
				state: states.get(container) ?? "missing",
				manualStop: manualStop === true,
				sessionCount: runtime.countProjectSessions(workDir),
				vulnCount: runtime.countProjectVulns(id),
				assetCount: runtime.countProjectAssets(id),
				gateCount: runtime.countProjectGates(id),
				proxyId,
				proxyName: profile?.name ?? null,
				proxyNode,
				proxyNodeName: nodes.length > 0 ? (chosen?.name ?? null) : null,
			};
		});
	}

	/**
	 * Work in flight for a project, which stopping its container would interrupt:
	 * engines that are running or scheduled (or hold queued/running tasks), plus
	 * the streaming sessions of the active project. Sessions of a project that is
	 * not active are not tracked here, because the console detaches them.
	 */
	function projectActivity(projectId: string): { engines: number; sessions: number } {
		const snapshot = runtime.snapshot();
		const sessions = snapshot.project?.id === projectId ? snapshot.runningSessions.length : 0;
		const busy = (engines?.listEngines(projectId) ?? []).filter(engineHasWorkInFlight);
		return { engines: busy.length, sessions };
	}

	/**
	 * The session list with engineering badges: a session that belongs to an
	 * engine task carries the engine's name and the task's live status, which
	 * is what the sidebar's 对话/工程 filter and badges read.
	 */
	async function sessionViews() {
		const sessions = await runtime.listSessions();
		const index = engines?.taskSessionIndex() ?? new Map();
		return sessions.map((session) => ({ ...session, engine: index.get(session.id) }));
	}

	async function broadcastSessions(socket?: WebSocket): Promise<void> {
		const sessions = await sessionViews();
		const view = { type: "sessions", sessions } satisfies SentinelServerMessage;
		if (socket) sendTo(socket, view);
		else broadcast(view);
	}

	/** The 代理 page's view, with the image's local presence resolved. */
	async function proxyView(): Promise<SentinelProxyConfigView> {
		if (!agentDir) {
			return {
				proxies: [],
				defaultId: null,
				image: DEFAULT_SINGBOX_IMAGE,
				imagePresent: false,
				testUrl: DEFAULT_TEST_URL,
			};
		}
		return proxyConfigView(agentDir, await hasSingboxImage(readProxies(agentDir).image));
	}

	/** Install missing images before validation; concurrent saves share one pull. */
	async function prepareProxyImage(image: string, force = false): Promise<{ ok: boolean; error?: string }> {
		if (!force && (await hasSingboxImage(image))) return { ok: true };
		const pending = proxyImagePulls.get(image);
		if (pending) return pending;
		const pull = (async () => {
			broadcast({ type: "singbox_pull_started" });
			try {
				return await pullSingboxImage(image, {
					onOutput: (chunk) => broadcast({ type: "image_build_log", line: chunk.trimEnd() }),
				});
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		})();
		proxyImagePulls.set(image, pull);
		try {
			const result = await pull;
			broadcast({ type: "singbox_pull_result", ...result });
			broadcast({ type: "proxy_config", config: await proxyView(), push: true });
			return result;
		} finally {
			proxyImagePulls.delete(image);
		}
	}

	/** `sing-box check` on one saved profile, or undefined when it passes. */
	async function validateProfile(profile: SentinelProxy): Promise<string | undefined> {
		if (!agentDir) return undefined;
		const settings = resolveProjectProxy(agentDir, profile.id);
		if (!settings) return undefined;
		// A tunnel does not go through sing-box: its configuration is the file the
		// sidecar's own client reads, so the check is whether it can be written at all.
		if (settings.mode === "wireguard") {
			const built = buildWireGuardConfig(settings.wireguard);
			return built.error;
		}
		if (settings.mode === "openvpn") {
			const built = buildOpenVpnProfile(settings.openvpn);
			return built.error;
		}
		const built = buildSingboxConfig(settings);
		if (built.error) return built.error;
		if (!built.config) return t("配置生成失败");
		const prepared = await prepareProxyImage(settings.image);
		if (!prepared.ok) return t("代理镜像拉取失败：{error}", { error: prepared.error ?? t("未知错误") });
		const checked = await checkProxyProfile(settings.image, built.config, agentDir);
		return checked.ok ? undefined : t("sing-box 校验未通过：{error}", { error: checked.error ?? "" });
	}

	/** Everything a proxy change touches: the page, the project rows, the checks. */
	async function afterProxyChange(): Promise<void> {
		if (agentDir) {
			const errors = await refreshProjectGateways(agentDir);
			if (errors.length > 0) broadcast({ type: "error", message: errors.join("\n") });
		}
		await broadcastProjects();
		await ensureEnvironment(true);
		broadcastEnvironment();
	}

	async function broadcastProjects(): Promise<void> {
		const registry = agentDir ? listProjects(agentDir) : { projects: [] };
		broadcast({
			type: "projects",
			projects: await projectInfos(),
			activeProjectId: runtime.snapshot().project?.id ?? registry.lastActiveProjectId ?? null,
		});
	}

	// --- Console authentication -------------------------------------------
	// Static files carry no secrets and stay open; everything under /api and the
	// WebSocket needs the session cookie. The credential file is created by the
	// first visitor (设置引导), so a fresh install has no default password.
	const authEnabled = options.auth !== false && Boolean(agentDir);
	const currentAuth = (): StoredAuth | null => (authEnabled && agentDir ? readStoredAuth(agentDir) : null);
	const limiter = createLoginLimiter();
	function disconnectClients(reason: "session_replaced" | "session_expired"): void {
		pluginUiTokens.clear();
		for (const client of clients) {
			clients.delete(client);
			client.close(4001, reason);
		}
	}
	/** The promise state for the account this request belongs to. */
	const consentFor = (username: string | null): ConsentStatus =>
		consentEnabled
			? consentStatus(agentDir, username)
			: { required: false, acceptedAt: null, version: CONSENT_VERSION };

	/**
	 * Language switch for the login and consent screens, which exist before the
	 * console WebSocket. The console itself uses the socket message so it can
	 * receive the acknowledgement and reload in the new language.
	 */
	async function handleUiLanguage(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJsonBody(request);
		if (!body || (body.language !== "zh" && body.language !== "en")) {
			sendJson(response, { error: t("语言必须是 zh 或 en") }, 400);
			return;
		}
		setServerLanguage(body.language);
		if (agentDir) writeUiConfig(agentDir, { language: body.language });
		broadcast({ type: "ui_config", language: body.language });
		sendJson(response, { ok: true, language: body.language });
	}

	async function handleSetup(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!agentDir) {
			sendJson(response, { error: t("缺少配置目录，无法创建账号") }, 500);
			return;
		}
		if (readStoredAuth(agentDir)) {
			sendJson(response, { error: t("管理员账号已存在，请直接登录") }, 409);
			return;
		}
		const body = await readJsonBody(request);
		if (!body) {
			sendJson(response, { error: t("请求体不是合法的 JSON") }, 400);
			return;
		}
		const username = textField(body, "username").trim();
		const password = textField(body, "password");
		const problem = validateCredentials(username, password);
		if (problem) {
			sendJson(response, { error: problem }, 400);
			return;
		}
		// Another setup request may have finished while this body was arriving.
		if (readStoredAuth(agentDir)) {
			sendJson(response, { error: t("管理员账号已存在，请直接登录") }, 409);
			return;
		}
		const stored = createAuth(agentDir, username, password);
		const token = issueSessionToken(stored);
		response.setHeader("set-cookie", sessionCookieHeader(token.value, token.maxAge));
		sendJson(response, { ok: true, username: stored.username });
	}

	async function handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const key = request.socket.remoteAddress ?? "unknown";
		const lockedFor = limiter.blocked(key);
		if (lockedFor > 0) {
			sendJson(
				response,
				{ error: t("尝试次数过多，请 {seconds} 秒后再试", { seconds: Math.ceil(lockedFor / 1000) }) },
				429,
			);
			return;
		}
		const body = await readJsonBody(request);
		if (!body) {
			sendJson(response, { error: t("请求体不是合法的 JSON") }, 400);
			return;
		}
		// Read after the body: a delayed request must not restore old credentials.
		const stored = currentAuth();
		if (!stored || !agentDir) {
			sendJson(response, { error: t("还没有管理员账号，请先创建") }, 409);
			return;
		}
		const username = textField(body, "username").trim();
		const password = textField(body, "password");
		if (!verifyLogin(stored, username, password)) {
			limiter.failure(key);
			sendJson(response, { error: t("用户名或密码不正确") }, 401);
			return;
		}
		limiter.success(key);
		const token = issueSessionToken(revokeSessions(agentDir, stored));
		// 记住登录 keeps the cookie across browser restarts (30 days); otherwise it
		// dies with the browser session. The token's own expiry never moves.
		const remember = body.remember !== false;
		response.setHeader("set-cookie", sessionCookieHeader(token.value, remember ? token.maxAge : 0));
		sendJson(response, { ok: true, username: stored.username });
		disconnectClients("session_replaced");
	}

	async function handleChangePassword(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!agentDir) {
			sendJson(response, { error: t("缺少配置目录") }, 500);
			return;
		}
		const body = await readJsonBody(request);
		if (!body) {
			sendJson(response, { error: t("请求体不是合法的 JSON") }, 400);
			return;
		}
		const stored = currentAuth();
		if (!stored || !hasValidSession(stored, request)) {
			sendJson(response, { error: t("未登录") }, 401);
			return;
		}
		if (!verifyLogin(stored, stored.username, textField(body, "current"))) {
			sendJson(response, { error: t("当前密码不正确") }, 400);
			return;
		}
		try {
			// Rotates the signing secret: every other session is logged out.
			changePassword(agentDir, stored, textField(body, "next"));
		} catch (error) {
			sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 400);
			return;
		}
		const updated = readStoredAuth(agentDir) ?? stored;
		const token = issueSessionToken(updated);
		response.setHeader("set-cookie", sessionCookieHeader(token.value, token.maxAge));
		sendJson(response, { ok: true });
		disconnectClients("session_expired");
	}

	/**
	 * Records the promise for this account. The body has to say `accepted: true`:
	 * the checkbox is the point, so an empty POST must not be enough.
	 */
	async function handleConsentAccept(
		request: IncomingMessage,
		response: ServerResponse,
		username: string,
	): Promise<void> {
		if (!agentDir) {
			sendJson(response, { error: t("缺少配置目录，无法记录承诺") }, 500);
			return;
		}
		const body = await readJsonBody(request);
		if (body?.accepted !== true) {
			sendJson(response, { error: t("必须勾选承诺才能记录") }, 400);
			return;
		}
		const record = writeConsentRecord(agentDir, username);
		sendJson(response, { ok: true, acceptedAt: record.acceptedAt, version: CONSENT_VERSION });
	}

	/**
	 * One chat attachment: the raw request body is the file, `name` says what to
	 * call it. It is streamed into the project's uploads directory (see upload.ts)
	 * and the answer carries the absolute path the message will hand the model.
	 */
	async function handleUpload(request: IncomingMessage, response: ServerResponse, workDir: string): Promise<void> {
		const name = new URL(request.url ?? "/", "http://localhost").searchParams.get("name") ?? "";
		const stored = await storeUpload(workDir, name, request);
		if (!stored.ok) {
			sendJson(response, { error: stored.error }, stored.status);
			return;
		}
		sendJson(response, { ok: true, name: stored.name, path: stored.path, size: stored.size });
	}

	/**
	 * POC upload: the raw body is one file, streamed to a private temp file. The
	 * response is only an acceptance receipt; the import itself is a queued job
	 * polled through `/api/pocs/import/<id>`. This keeps an 18MB+ zip out of a
	 * WebSocket frame and keeps the event loop free while it is parsed.
	 */
	async function handlePocImport(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			const name = new URL(request.url ?? "/", "http://localhost").searchParams.get("name") ?? "poc.zip";
			const declared = Number(request.headers["content-length"] ?? 0);
			if (Number.isFinite(declared) && declared > POC_IMPORT_MAX_BYTES) {
				request.resume();
				sendJson(
					response,
					{ error: t("文件超过 {mb}MB 上限", { mb: Math.round(POC_IMPORT_MAX_BYTES / 1024 / 1024) }) },
					413,
				);
				return;
			}
			const accepted = await pocImports.accept(name, request);
			if (!accepted.ok) {
				// The body may still be arriving when the queue rejects it; drain it so
				// the client sees the JSON error instead of a connection reset.
				request.resume();
				sendJson(response, { error: accepted.error }, accepted.status);
				return;
			}
			sendJson(response, { ok: true, id: accepted.id }, 202);
		} catch (error) {
			if (!response.headersSent && !response.destroyed) {
				sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
			} else {
				response.destroy();
			}
		}
	}

	function handlePocImportStatus(response: ServerResponse, id: string): void {
		const job = pocImports.get(id);
		if (!job) {
			sendJson(response, { error: t("导入任务不存在或已过期") }, 404);
			return;
		}
		sendJson(response, job);
	}

	/**
	 * One ready archive, streamed from the temp file. The download is authorized
	 * by the console's normal session cookie: the route sits under /api, after
	 * the same auth and consent checks as every other API call.
	 */
	function handleFolderArchiveDownload(response: ServerResponse, id: string): void {
		const job = folderArchives.beginDownload(id);
		if (!job) {
			const existing = folderArchives.get(id);
			if (existing?.status === "running") {
				sendJson(response, { error: t("压缩包还在生成中") }, 409);
			} else if (existing?.downloading) {
				sendJson(response, { error: t("压缩包正在被下载") }, 409);
			} else {
				sendJson(response, { error: t("压缩包不存在或已过期") }, 404);
			}
			return;
		}
		let size = 0;
		try {
			size = statSync(job.filePath).size;
		} catch {
			folderArchives.releaseDownload(id);
			sendJson(response, { error: t("压缩包不存在或已过期") }, 404);
			return;
		}
		response.writeHead(200, {
			"content-type": "application/gzip",
			"content-length": String(size),
			"content-disposition": folderArchiveContentDisposition(job.filename),
			"cache-control": "no-store",
		});
		const stream = createReadStream(job.filePath);
		let finished = false;
		response.on("finish", () => {
			finished = true;
			folderArchives.finishDownload(id);
		});
		response.on("close", () => {
			if (finished) return;
			stream.destroy();
			folderArchives.releaseDownload(id);
		});
		stream.on("error", () => {
			if (!response.headersSent) {
				sendJson(response, { error: t("读取压缩包失败") }, 500);
			} else {
				response.destroy();
			}
			folderArchives.releaseDownload(id);
		});
		stream.pipe(response);
	}

	// The device gateway owns the reverse WS the DroidBridge APK dials. The store
	// is the runtime's (its tools read the registry); the hooks route lifecycle
	// events into the console broadcasts and the server log.
	const droidGateway = new DroidGateway(runtime.droidRegistry, {
		onDeviceChange: () => broadcastDroidDevices(),
		log: (line: string) => console.error(`[sentinel-droid] ${line}`),
	});
	runtime.setDroidGateway(droidGateway);
	// The iOS side is deliberately its own store and gateway (M0 decision). The
	// store lives on the runtime like the Android one, so the tools and the page
	// read the same registry the gateway authenticates against.
	const iosGateway = new IosGateway(
		runtime.iosRegistry,
		{
			onDeviceChange: () => broadcastIosDevices(),
			log: (line: string) => console.error(`[sentinel-ios] ${line}`),
		},
		{ tls: options.tls },
	);
	runtime.setIosGateway(iosGateway);
	// Restore the persisted reverse-connection listener (address the operator
	// picked on the device page). Binding 0.0.0.0 is what lets a LAN phone dial in.
	const listenConfig = runtime.droidListenConfig();
	if (listenConfig) await droidGateway.listen(listenConfig.host, listenConfig.port);
	const iosListenConfig = runtime.iosListenConfig();
	if (iosListenConfig) {
		if (options.tls) {
			await iosGateway.listen(iosListenConfig.host, iosListenConfig.port);
		} else {
			console.error("[sentinel-ios] iOS 强制 wss，未启用控制台 TLS，跳过独立监听");
		}
	}

	async function handleAssetImport(
		request: IncomingMessage,
		response: ServerResponse,
		preview: boolean,
	): Promise<void> {
		let store: AssetLibraryStore | undefined;
		try {
			if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
				sendJson(response, { error: "请使用 JSON 格式提交资产。" }, 415);
				return;
			}
			const body = await readJsonBody(request, 1024 * 1024);
			// The terminal or active project may have changed while the body arrived.
			if (authEnabled && !hasValidSession(currentAuth(), request)) {
				sendJson(response, { error: t("未登录") }, 401);
				return;
			}
			if (!body || typeof body.text !== "string" || typeof body.projectId !== "string") {
				sendJson(response, { error: "导入内容无效或过大，请分批导入。" }, 400);
				return;
			}
			const project = runtime.snapshot().project;
			if (!project || project.id !== body.projectId) {
				sendJson(response, { error: "当前项目已切换，请关闭窗口后重新导入。" }, 409);
				return;
			}
			if (!agentDir) {
				sendJson(response, { error: "未配置资产库目录。" }, 503);
				return;
			}
			store = new AssetLibraryStore(assetLibraryDbPath(agentDir));
			if (preview) {
				sendJson(response, previewAssetImport(store, project.id, body.text));
				return;
			}
			const parsed = parseAssetImport(body.text);
			if (parsed.identities.length === 0) throw new AssetInputError("没有可导入的有效资产。");
			const result = store.upsertMany(
				parsed.identities.map((identity) => ({
					projectId: project.id,
					projectName: project.name,
					source: "手动导入",
					identity,
				})),
			);
			broadcast({ type: "assets_changed" });
			sendJson(response, {
				...result,
				duplicates: parsed.preview.duplicates,
				invalid: parsed.preview.invalid.length,
			});
		} catch (error) {
			sendJson(
				response,
				{ error: error instanceof Error ? error.message : String(error) },
				error instanceof AssetInputError ? 400 : 500,
			);
		} finally {
			store?.close();
		}
	}

	const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const path = url.pathname;
		// Bulk iOS pulls upload raw bytes here, before the browser gate: the device
		// authenticates with its own token, exactly like the WebSocket upgrade.
		if (path.startsWith("/api/ios/upload/")) {
			void iosGateway.handleUpload(request, response, path);
			return;
		}
		// Swagger UI is rendered inside a sandboxed srcdoc iframe (opaque origin), so
		// that iframe cannot present the gate/session cookies. These two paths are
		// the generic reader library only — no console data — and must stay reachable
		// or the API document pane renders blank.
		if (path.startsWith("/assets/swagger-ui-")) {
			serveStatic(webuiDistDir(), path, response);
			return;
		}
		// The gate answers before anything else — before the auth endpoints too, so a
		// scanner that does not know the entry URL never learns that a console, or its
		// first-run setup flow, is here at all.
		if (gateEnabled) {
			if (isGateEntry(path, gateToken)) {
				response.writeHead(302, { location: "/", "set-cookie": gateCookieHeader(gateToken) });
				response.end();
				return;
			}
			if (!hasValidGate(request, gateToken) && !path.startsWith("/plugin-ui/")) {
				sendGateNotFound(response);
				return;
			}
		}
		const auth = currentAuth();
		if (authEnabled) {
			if (path === "/api/auth/state") {
				sendJson(response, { configured: Boolean(auth), username: auth?.username ?? null });
				return;
			}
			if (path === "/api/auth/setup" && request.method === "POST") {
				void handleSetup(request, response);
				return;
			}
			if (path === "/api/auth/login" && request.method === "POST") {
				void handleLogin(request, response);
				return;
			}
			if (path === "/api/auth/logout" && request.method === "POST") {
				// A replaced or anonymous browser must not log out the active terminal.
				if (auth && agentDir && hasValidSession(auth, request)) {
					revokeSessions(agentDir, auth);
					disconnectClients("session_expired");
				}
				response.setHeader("set-cookie", clearSessionCookieHeader());
				sendJson(response, { ok: true });
				return;
			}
		}
		if (path === "/api/ui-language" && request.method === "GET") {
			sendJson(response, { language: getServerLanguage() });
			return;
		}
		if (path === "/api/ui-language" && request.method === "POST") {
			void handleUiLanguage(request, response);
			return;
		}
		const authorized = authEnabled ? hasValidSession(auth, request) : true;
		// Plugin UI assets are authenticated by the capability token in the path;
		// the sandboxed iframe cannot present the console cookie.
		if (path.startsWith("/plugin-ui/")) {
			if (!agentDir) {
				sendJson(response, { error: t("控制台没有配置目录，无法读取插件界面") }, 503);
				return;
			}
			void servePluginUi(agentDir, request, response);
			return;
		}
		if (authorized) {
			// The promise comes before every other route: until it is recorded, the
			// console answers 403 and only the statement itself, the promise that
			// records it, and the session status stay reachable. The WebSocket is
			// closed separately in the upgrade handler.
			if (path.startsWith("/api/") && !isConsentExemptPath(path) && consentFor(auth?.username ?? null).required) {
				sendJson(response, { error: "consent_required" }, 403);
				return;
			}
			if (path.startsWith("/plugin-icon/")) {
				void servePluginIcon(runtime, request, response);
				return;
			}
			if (path === "/api/assets/import" && request.method === "GET") {
				const project = runtime.snapshot().project;
				sendJson(
					response,
					project ? { id: project.id, name: project.name } : { error: t("尚未选择项目") },
					project ? 200 : 409,
				);
				return;
			}
			if ((path === "/api/assets/import" || path === "/api/assets/import/preview") && request.method === "POST") {
				void handleAssetImport(request, response, path.endsWith("/preview"));
				return;
			}
			if (path === "/api/pocs/import" && request.method === "POST") {
				void handlePocImport(request, response);
				return;
			}
			if (path.startsWith("/api/pocs/import/") && request.method === "GET") {
				const id = path.slice("/api/pocs/import/".length);
				if (!/^[0-9a-f-]{36}$/i.test(id)) {
					sendJson(response, { error: t("导入任务 id 非法") }, 400);
					return;
				}
				handlePocImportStatus(response, id);
				return;
			}
			if (path.startsWith("/api/folder-archives/") && request.method === "GET") {
				const id = path.slice("/api/folder-archives/".length);
				if (!/^[0-9a-f-]{36}$/i.test(id)) {
					sendJson(response, { error: t("下载任务 id 非法") }, 400);
					return;
				}
				handleFolderArchiveDownload(response, id);
				return;
			}
			if (path === "/api/health") {
				sendJson(response, { ok: true, sessionId: runtime.currentSessionId, mode: runtime.currentMode });
				return;
			}
			if (path === "/api/auth/session") {
				const username = auth?.username ?? null;
				sendJson(response, { ok: true, username, consent: consentFor(username) });
				return;
			}
			if (path === "/api/auth/change-password" && request.method === "POST") {
				if (!auth) {
					sendJson(response, { error: "Not logged in" }, 401);
					return;
				}
				void handleChangePassword(request, response);
				return;
			}
			// One chat attachment: the raw body is the file, `name` is what to call
			// it. It lands in the active project's work dir, which is the directory
			// the agent reads in a container session and in a host session alike.
			if (path === "/api/upload" && request.method === "POST") {
				const active = runtime.snapshot();
				if (!active.project) {
					sendJson(response, { error: t("请先创建或选择一个项目，再上传附件") }, 409);
					return;
				}
				if (url.searchParams.get("projectId") !== active.project.id) {
					request.resume();
					sendJson(
						response,
						{
							error:
								getServerLanguage() === "en"
									? "Project changed; upload the file again."
									: "项目已切换，请重新上传文件。",
						},
						409,
					);
					return;
				}
				void handleUpload(request, response, active.cwd);
				return;
			}
			// The statement and the promise that records it. Both stay reachable
			// before the promise: the page has to be able to show the text, and the
			// operator has to be able to accept it.
			if (path === "/api/consent") {
				sendJson(response, { ...consentFor(auth?.username ?? null), text: consentTextFor(getServerLanguage()) });
				return;
			}
			if (path === "/api/consent/accept" && request.method === "POST") {
				if (!agentDir || !auth) {
					sendJson(response, { error: t("缺少账号或配置目录，无法记录承诺") }, 500);
					return;
				}
				void handleConsentAccept(request, response, auth.username);
				return;
			}
		} else if (path.startsWith("/api/")) {
			sendJson(response, { error: t("未登录") }, 401);
			return;
		}
		serveStatic(webuiDistDir(), path, response);
	};
	// SHA-256 of the served leaf certificate, so a self-signed console can be
	// pinned by SentinelBridge instead of asking the operator to trust it.
	const certPin = (() => {
		if (!options.tls) return null;
		try {
			return new X509Certificate(options.tls.cert).fingerprint256.replace(/:/g, "").toLowerCase();
		} catch {
			return null;
		}
	})();
	const server = options.tls
		? createSecureServer({ cert: options.tls.cert, key: options.tls.key }, requestHandler)
		: createServer(requestHandler);

	const wss = new WebSocketServer({ noServer: true });
	// The upgrade handshake is where the WebSocket is gated: no valid session, no console.
	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		// The DroidBridge APK authenticates with its own device token, not the
		// console session, and must reach the gateway before the console's checks.
		if (droidGateway.handleUpgrade(request, socket, head)) return;
		// Same rule for SentinelBridge: the device token is its credential, and the
		// App cannot present a browser cookie. Bad tokens are refused inside.
		if (iosGateway.handleUpgrade(request, socket, head)) return;
		// The console's own socket sits behind the same gate as its page: without the
		// entry cookie there is nothing here to talk to. The device gateway above is
		// exempt on purpose — the APK carries its own token and its URL is fixed in
		// the app, so it cannot be asked to present a browser cookie.
		if (gateEnabled && !hasValidGate(request, gateToken)) {
			socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		if (url.pathname !== "/ws" || (authEnabled && !hasValidSession(currentAuth(), request))) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		// A live console socket is the agent itself, so it waits for the promise.
		if (consentFor(currentAuth()?.username ?? null).required) {
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
	});
	wss.on("connection", (socket, request) => {
		clients.add(socket);
		clientRequests.set(socket, request);
		// Listeners first: the project list needs docker, and a client that sends a
		// command right after connecting must not have it dropped in the meantime.
		socket.on("message", (data) => {
			void handleClientMessage(socket, data.toString());
		});
		socket.on("close", () => clients.delete(socket));
		socket.on("error", () => clients.delete(socket));
		sendTo(socket, { type: "ui_config", language: getServerLanguage() });
		sendTo(socket, { type: "snapshot", snapshot: runtime.snapshot() });
		void projectInfos().then((projects) => {
			sendTo(socket, {
				type: "projects",
				projects,
				activeProjectId: runtime.snapshot().project?.id ?? null,
			});
		});
		// Engineering mode: the board and doctrine list are pushed per connect.
		broadcastEngines(socket);
		if (agentDir) sendTo(socket, { type: "doctrines", doctrines: listDoctrines(agentDir) });
		if (agentDir) sendTo(socket, { type: "gatekeeper_config", config: runtime.getGatekeeperConfig() });
		if (agentDir) sendTo(socket, { type: "model_library", library: runtime.getModelLibrary() });
		if (agentDir) sendTo(socket, { type: "asset_config", config: runtime.getAssetConfig() });
		if (agentDir) sendTo(socket, { type: "websearch_config", config: runtime.getWebSearchConfig() });
		if (agentDir) sendTo(socket, { type: "mcp_servers", config: runtime.getMcpServers() });
		// The 代理 page reads this rather than the environment report, so it is pushed
		// on connect like the other pages that own their configuration.
		if (agentDir) {
			void proxyView().then((config) => sendTo(socket, { type: "proxy_config", config }));
		}
	});

	async function handleClientMessage(socket: WebSocket, raw: string): Promise<void> {
		const request = clientRequests.get(socket);
		if (authEnabled && (!request || !clients.has(socket) || !hasValidSession(currentAuth(), request))) {
			clients.delete(socket);
			socket.close(4001, "session_expired");
			return;
		}
		console.error(`[srv-recv] ${raw.slice(0, 70)}`);
		let message: SentinelClientMessage;
		try {
			message = JSON.parse(raw) as SentinelClientMessage;
		} catch {
			sendError(socket, t("无法解析的消息格式"));
			return;
		}
		try {
			switch (message.type) {
				case "prompt": {
					const images = message.images ?? [];
					if (!message.text.trim() && images.length === 0) {
						sendError(socket, t("消息不能为空"));
						return;
					}
					// A run needs the container backend, so the environment check gates it.
					const report = await ensureEnvironment();
					if (!report.ok) {
						sendError(socket, blockedReason(report));
						broadcastEnvironment();
						return;
					}
					await runtime.prompt(
						message.text,
						message.streamingBehavior,
						images,
						message.notify,
						message.attachModelIds,
					);
					return;
				}
				case "compact": {
					const report = await ensureEnvironment();
					if (!report.ok) {
						sendError(socket, blockedReason(report));
						return;
					}
					await runtime.compact();
					return;
				}
				case "set_thinking_level":
					runtime.setThinkingLevel(message.level);
					return;
				case "start_goal": {
					// A goal runs the agent, so it needs the same container backend.
					const report = await ensureEnvironment();
					if (!report.ok) {
						sendError(socket, blockedReason(report));
						broadcastEnvironment();
						return;
					}
					await runtime.startGoal(message.objective, message.criteria ?? [], message.roundLimit);
					return;
				}
				case "pause_goal":
					await runtime.pauseGoal();
					return;
				case "resume_goal":
					runtime.resumeGoal(message.extraRounds);
					return;
				case "clear_goal":
					await runtime.clearGoal();
					return;
				case "abort":
					await runtime.abort();
					return;
				case "abort_compaction":
					runtime.abortCompaction();
					return;
				case "set_mode":
					runtime.setMode(message.mode);
					return;
				case "set_global_mode":
					runtime.setGlobalMode(message.mode);
					return;
				case "decide": {
					const ok = runtime.decide(
						message.decision.id,
						message.decision.approved,
						message.decision.command,
						message.decision.alwaysAllowPrefix === true,
					);
					if (!ok) sendError(socket, t("该审批请求已失效（可能已被其他窗口处理或运行已中止）"));
					return;
				}
				case "decide_all": {
					const count = runtime.decideAll(message.approved);
					if (count === 0) sendError(socket, t("没有待处理的审批请求"));
					return;
				}
				case "allow_prefix":
					runtime.allowPrefix(message.prefix);
					return;
				case "remove_allowed_prefix":
					runtime.removeAllowedPrefix(message.prefix);
					return;
				case "new_session":
					// An unknown or disabled preset id throws, which the handler reports to
					// the browser; the session is not created at all rather than silently
					// falling back to the default agent.
					await runtime.newSession(message.presetId?.trim() || undefined);
					return;
				case "set_session_preset":
					// Throws on an unknown/disabled preset or a running session; the
					// handler reports it and the conversation keeps its old briefing.
					await runtime.setSessionPreset(message.presetId);
					return;
				case "switch_session":
					await runtime.switchSession(message.path);
					return;
				case "list_sessions":
					await broadcastSessions(socket);
					return;
				case "rename_session": {
					if (!message.name.trim()) {
						sendError(socket, t("会话名称不能为空"));
						return;
					}
					await runtime.renameSession(message.path, message.name.trim());
					await broadcastSessions();
					return;
				}
				case "set_session_status": {
					// The toolbar labels the session it is showing; the list passes a path.
					const statusPath = message.path ?? runtime.currentSessionPath;
					if (!statusPath) {
						sendError(socket, t("没有活动会话"));
						return;
					}
					// Setting it on a loaded session also refreshes the snapshot, which is
					// where the toolbar reads the active session's status from.
					await runtime.setSessionStatus(statusPath, message.status);
					await broadcastSessions();
					return;
				}
				case "delete_session": {
					await runtime.deleteSession(message.path);
					await broadcastSessions();
					return;
				}
				case "navigate":
					await runtime.navigate(message.entryId, message.summarize);
					return;
				case "rename_branch": {
					try {
						runtime.renameBranch(message.entryId, message.label);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
						return;
					}
					const current = runtime.getTree();
					broadcast({
						type: "tree",
						tree: current.tree,
						leafId: current.leafId,
						forkPoints: current.forkPoints,
					});
					return;
				}
				case "get_tree": {
					const { tree, leafId, forkPoints } = runtime.getTree();
					socket.send(JSON.stringify({ type: "tree", tree, leafId, forkPoints } satisfies SentinelServerMessage));
					return;
				}
				case "get_state":
					socket.send(
						JSON.stringify({ type: "snapshot", snapshot: runtime.snapshot() } satisfies SentinelServerMessage),
					);
					return;
				case "get_model_library":
					sendTo(socket, { type: "model_library", library: runtime.getModelLibrary() });
					return;
				case "lookup_model_defaults":
					sendTo(socket, {
						type: "model_defaults",
						modelId: message.modelId,
						matches: await runtime.lookupModelDefaults(message.modelId, message.baseUrl),
					});
					return;
				case "list_model_channels":
					sendTo(socket, {
						type: "model_channels",
						requestId: message.requestId,
						query: message.query,
						channels: await runtime.listModelChannels(message.query),
					});
					return;
				case "list_channel_models":
					sendTo(socket, {
						type: "channel_models",
						requestId: message.requestId,
						provider: message.provider,
						presets: await runtime.listChannelModels(message.provider),
					});
					return;
				case "save_model_entry":
					// The view comes back after every mutation, so the screen never has to
					// guess what the store did (ids, role usage, resolved endpoints).
					sendTo(socket, { type: "model_library", library: runtime.saveModelEntry(message) });
					// The engine keeps its own runtime for the commander; models.json just changed.
					engines?.markModelsDirty();
					broadcastSnapshot();
					return;
				case "remove_model_entry":
					sendTo(socket, { type: "model_library", library: runtime.removeModelEntry(message.id) });
					engines?.markModelsDirty();
					broadcastSnapshot();
					return;
				case "duplicate_model_entry":
					sendTo(socket, { type: "model_library", library: runtime.duplicateModelEntry(message.id) });
					engines?.markModelsDirty();
					return;
				case "set_model_role":
					sendTo(socket, { type: "model_library", library: runtime.setModelRole(message.role, message.target) });
					broadcastSnapshot();
					return;
				case "set_reviewer_auto":
					sendTo(socket, { type: "model_library", library: runtime.setReviewerAuto(message.enabled) });
					return;
				case "test_model_entry": {
					const config = agentDir ? readProviderModelConfig(agentDir, message.id) : null;
					const result = config
						? await testModelConfig(config)
						: { ok: false, message: t("这个模型没有可用的端点配置") };
					sendTo(socket, { type: "model_test_result", result });
					return;
				}
				case "get_permissions": {
					const view = runtime.getPermissions();
					socket.send(
						JSON.stringify({
							type: "permissions",
							config: view.config,
							effectiveSubagent: view.effectiveSubagent,
							presets: [...view.presets],
							tools: view.tools,
						} satisfies SentinelServerMessage),
					);
					return;
				}
				case "save_permissions": {
					try {
						await runtime.savePermissions(message.config);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
						return;
					}
					const view = runtime.getPermissions();
					broadcast({
						type: "permissions",
						config: view.config,
						effectiveSubagent: view.effectiveSubagent,
						presets: [...view.presets],
						tools: view.tools,
					});
					return;
				}
				case "get_notify_config":
					socket.send(
						JSON.stringify({
							type: "notify_config",
							config: runtime.getNotifyConfig(),
							status: runtime.getNotifyStatus(),
						} satisfies SentinelServerMessage),
					);
					return;
				case "save_notify_config":
					runtime.saveNotifyConfig(message.config);
					socket.send(
						JSON.stringify({
							type: "notify_config",
							config: runtime.getNotifyConfig(),
							status: runtime.getNotifyStatus(),
						} satisfies SentinelServerMessage),
					);
					return;
				case "test_notify": {
					const result = await runtime.testNotify(message.config, message.channel ?? "dingtalk");
					socket.send(JSON.stringify({ type: "notify_test_result", result } satisfies SentinelServerMessage));
					return;
				}
				case "get_environment":
					sendTo(socket, {
						type: "environment",
						report: await ensureEnvironment(),
						building: imageBuild !== undefined,
					});
					return;
				case "check_environment": {
					const report = await ensureEnvironment(true);
					broadcast({ type: "environment", report, building: imageBuild !== undefined });
					return;
				}
				case "build_image": {
					if (imageBuild) {
						sendError(socket, t("镜像构建已在进行中"));
						return;
					}
					const controller = new AbortController();
					imageBuild = controller;
					await ensureEnvironment();
					broadcastEnvironment();
					const result = await buildImage(
						{
							onLog: (line) => broadcast({ type: "image_build_log", line }),
							signal: controller.signal,
						},
						agentDir ? readSources(agentDir) : { ...EMPTY_SOURCES },
					);
					imageBuild = undefined;
					broadcast({
						type: "image_build_result",
						ok: result.ok,
						...(result.error ? { error: result.error } : {}),
					});
					// The build may have fixed the only failing item, so re-check.
					await ensureEnvironment(true);
					broadcastEnvironment();
					return;
				}
				case "abort_image_build":
					imageBuild?.abort();
					return;
				case "set_sources": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法保存构建源"));
						return;
					}
					// The sources are baked into the image, so this only records them;
					// the operator rebuilds the image when they want them applied.
					const sources = normalizeSources(message.sources ?? {});
					try {
						writeSources(agentDir, sources);
					} catch (error) {
						sendTo(socket, {
							type: "sources_saved",
							sources: readSources(agentDir),
							error: error instanceof Error ? error.message : String(error),
						} satisfies SentinelServerMessage);
						return;
					}
					sendTo(socket, { type: "sources_saved", sources } satisfies SentinelServerMessage);
					await ensureEnvironment(true);
					broadcastEnvironment();
					return;
				}
				case "set_container_network": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法保存容器网络"));
						return;
					}
					// Only the next container creation reads this: existing containers keep
					// the network they were created with until the operator rebuilds them.
					const network = normalizeContainerNetwork(message.network);
					try {
						writeContainerNetwork(agentDir, network);
					} catch (error) {
						sendTo(socket, {
							type: "container_network_saved",
							network: readContainerNetwork(agentDir),
							error: error instanceof Error ? error.message : String(error),
						} satisfies SentinelServerMessage);
						return;
					}
					sendTo(socket, { type: "container_network_saved", network } satisfies SentinelServerMessage);
					await ensureEnvironment(true);
					broadcastEnvironment();
					return;
				}
				case "get_proxy_config": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法读取代理"));
						return;
					}
					sendTo(socket, { type: "proxy_config", config: await proxyView() } satisfies SentinelServerMessage);
					return;
				}
				case "save_proxy": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法保存代理"));
						return;
					}
					const saved = saveProxy(agentDir, message.proxy);
					if (saved.error || !saved.proxy) {
						sendTo(socket, {
							type: "proxy_config",
							config: await proxyView(),
							error: saved.error ?? t("代理保存失败"),
						} satisfies SentinelServerMessage);
						return;
					}
					// A subscription is read once, here, so that writing a sidecar never
					// depends on the provider being reachable. A URL that was just entered
					// or changed has no nodes yet, which is what `updatedAt === 0` says.
					let fetched: string | undefined;
					if (saved.proxy.mode === "subscription" && saved.proxy.subscription?.updatedAt === 0) {
						fetched = (await refreshProxySubscription(agentDir, saved.proxy.id)).error;
					}
					// A node sing-box refuses is worth catching here rather than at the
					// first container rebuild, when the operator has moved on. The profile
					// stays saved either way: the point is to say what to fix.
					const stored = readProxies(agentDir).proxies.find((entry) => entry.id === saved.proxy?.id);
					const error = fetched ?? (stored ? await validateProfile(stored) : undefined);
					sendTo(socket, {
						type: "proxy_config",
						config: await proxyView(),
						error,
					} satisfies SentinelServerMessage);
					if (!error) await afterProxyChange();
					return;
				}
				case "delete_proxy": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法删除代理"));
						return;
					}
					const removed = deleteProxy(agentDir, message.id);
					if (removed.error) {
						sendTo(socket, {
							type: "proxy_config",
							config: await proxyView(),
							error: removed.error,
						} satisfies SentinelServerMessage);
						return;
					}
					// Projects that pointed at it follow the default again; keeping the id
					// would leave them proxied by nothing at all.
					clearProxyFromProjects(agentDir, message.id);
					sendTo(socket, { type: "proxy_config", config: await proxyView() } satisfies SentinelServerMessage);
					await afterProxyChange();
					return;
				}
				case "refresh_proxy_subscription": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法刷新订阅"));
						return;
					}
					const refreshed = await refreshProxySubscription(agentDir, message.id);
					const error = refreshed.error ?? (refreshed.proxy ? await validateProfile(refreshed.proxy) : undefined);
					sendTo(socket, {
						type: "proxy_config",
						config: await proxyView(),
						error,
					} satisfies SentinelServerMessage);
					if (!error) await afterProxyChange();
					return;
				}
				case "set_proxy_node": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法切换节点"));
						return;
					}
					const switched = setProxyNode(agentDir, message.id, message.nodeTag);
					if (switched.error || !switched.proxy) {
						sendTo(socket, {
							type: "proxy_config",
							config: await proxyView(),
							error: switched.error ?? t("节点不存在"),
						} satisfies SentinelServerMessage);
						return;
					}
					sendTo(socket, { type: "proxy_config", config: await proxyView() } satisfies SentinelServerMessage);
					await afterProxyChange();
					return;
				}
				case "test_proxy_nodes": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法测速"));
						return;
					}
					// The measurement runs in a throwaway container and takes seconds per
					// node; the reply carries the results, so the page keeps its busy
					// state until it arrives.
					const tested = await testProxyNodes(agentDir, message.id, message.url);
					sendTo(socket, {
						type: "proxy_config",
						config: await proxyView(),
						error: tested.error,
					} satisfies SentinelServerMessage);
					await afterProxyChange();
					return;
				}
				case "test_proxy_connection": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法测试代理"));
						return;
					}
					const file = readProxies(agentDir);
					const proxy = file.proxies.find((entry) => entry.id === message.id);
					if (!proxy) {
						sendTo(socket, {
							type: "proxy_config",
							config: await proxyView(),
							error: t("代理不存在"),
						} satisfies SentinelServerMessage);
						return;
					}
					const settings = resolveProjectProxy(agentDir, proxy.id);
					if (!settings) {
						sendTo(socket, {
							type: "proxy_config",
							config: await proxyView(),
							error: t("代理不存在"),
						} satisfies SentinelServerMessage);
						return;
					}
					if (proxy.mode === "subscription") {
						sendTo(socket, {
							type: "proxy_config",
							config: await proxyView(),
							error: t("订阅代理请用「节点」里的批量测速"),
						} satisfies SentinelServerMessage);
						return;
					}
					if (proxyChecksInFlight.has(proxy.id)) {
						sendTo(socket, {
							type: "proxy_config",
							config: await proxyView(),
							error: t("这个代理正在测试，请稍等"),
						} satisfies SentinelServerMessage);
						return;
					}
					const url = message.url.trim() || file.testUrl || DEFAULT_TEST_URL;
					proxyChecksInFlight.add(proxy.id);
					try {
						// A failed test is a result, not a refused request: it is stored on the
						// profile and travels with the next config, so the page can show it
						// next to the exit it belongs to instead of in a transient banner.
						const checked = await checkProxyConnection(agentDir, settings, url);
						const recorded = recordProxyTest(agentDir, proxy.id, {
							ok: checked.ok,
							latencyMs: checked.latencyMs,
							error: checked.ok ? null : (checked.error ?? t("测试失败")),
							url,
							testedAt: Date.now(),
						});
						sendTo(socket, {
							type: "proxy_config",
							config: await proxyView(),
							error: recorded.error,
						} satisfies SentinelServerMessage);
					} finally {
						proxyChecksInFlight.delete(proxy.id);
					}
					return;
				}
				case "switch_project_node": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法切换节点"));
						return;
					}
					const target = listProjects(agentDir).projects.find((project) => project.id === message.projectId);
					if (!target) {
						sendError(socket, t("项目不存在"));
						return;
					}
					// The switch is what makes this different from `set_project_proxy`: it
					// talks to the running sidecar, so it takes effect now. The choice is
					// recorded either way, so a rebuild starts on the same node.
					const switched = target.gateway
						? await changeProjectProxy(agentDir, target.id, target.proxyId, message.nodeTag)
						: await switchProjectNode(agentDir, target, message.nodeTag);
					if (switched.error) {
						sendError(socket, switched.error);
						return;
					}
					const stored = target.gateway
						? switched
						: setProjectProxy(agentDir, message.projectId, target.proxyId, message.nodeTag);
					if (stored.error) {
						sendError(socket, stored.error);
						return;
					}
					sendTo(socket, {
						type: "project_proxy_saved",
						projectId: message.projectId,
						applied: switched.applied,
					} satisfies SentinelServerMessage);
					await broadcastProjects();
					return;
				}
				case "set_default_proxy": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法保存默认代理"));
						return;
					}
					const applied = setDefaultProxy(agentDir, message.id);
					if (applied.error) {
						sendTo(socket, {
							type: "proxy_config",
							config: await proxyView(),
							error: applied.error,
						} satisfies SentinelServerMessage);
						return;
					}
					sendTo(socket, { type: "proxy_config", config: await proxyView() } satisfies SentinelServerMessage);
					await afterProxyChange();
					return;
				}
				case "set_proxy_image": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法保存代理镜像"));
						return;
					}
					setProxyImage(agentDir, message.image);
					const prepared = await prepareProxyImage(readProxies(agentDir).image);
					sendTo(socket, {
						type: "proxy_config",
						config: await proxyView(),
						error: prepared.ok
							? undefined
							: t("代理镜像拉取失败：{error}", { error: prepared.error ?? t("未知错误") }),
					} satisfies SentinelServerMessage);
					if (prepared.ok) await afterProxyChange();
					return;
				}
				case "pull_singbox_image": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法拉取代理镜像"));
						return;
					}
					const image = readProxies(agentDir).image;
					const result = await prepareProxyImage(image, true);
					if (result.ok) await afterProxyChange();
					return;
				}
				case "set_project_proxy": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法保存项目代理"));
						return;
					}
					const saved = await changeProjectProxy(agentDir, message.projectId, message.proxyId, message.proxyNode);
					if (saved.error) {
						sendError(socket, saved.error);
						return;
					}
					sendTo(socket, {
						type: "project_proxy_saved",
						projectId: message.projectId,
						applied: saved.applied,
					} satisfies SentinelServerMessage);
					await broadcastProjects();
					await ensureEnvironment(true);
					broadcastEnvironment();
					return;
				}
				case "get_asset_config":
					sendTo(socket, { type: "asset_config", config: runtime.getAssetConfig() });
					return;
				case "save_asset_platform": {
					// The save also probes the key and rebuilds the live sessions, so the
					// tool set changes with the switch. A running session refuses it.
					try {
						const config = await runtime.saveAssetPlatform(message.platform);
						broadcast({ type: "asset_config", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "set_asset_query_limit": {
					try {
						const config = await runtime.setAssetQueryLimit(message.limit);
						broadcast({ type: "asset_config", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "test_asset_platform": {
					const result = await runtime.testAssetPlatform(message.platform, message.key, message.baseUrl);
					// A probe can flip a platform's usability, so the config follows the
					// result: the screen's "已挂载" state must match what the runtime did.
					broadcast({ type: "asset_config", config: runtime.getAssetConfig() });
					sendTo(socket, {
						type: "asset_test_result",
						platform: message.platform,
						result,
					} satisfies SentinelServerMessage);
					return;
				}
				case "get_websearch_config":
					sendTo(socket, { type: "websearch_config", config: runtime.getWebSearchConfig() });
					return;
				case "save_websearch_key": {
					// Saving also probes the key and rebuilds live sessions, so the tool
					// set follows the pool. A running session refuses the change — but the
					// config is broadcast either way, so the screen never shows a stale
					// pool after a refused or half-applied save.
					try {
						const config = await runtime.saveWebSearchKey(message.key);
						broadcast({ type: "websearch_config", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
						broadcast({ type: "websearch_config", config: runtime.getWebSearchConfig() });
					}
					return;
				}
				case "delete_websearch_key": {
					try {
						const config = await runtime.deleteWebSearchKey(message.id);
						broadcast({ type: "websearch_config", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
						broadcast({ type: "websearch_config", config: runtime.getWebSearchConfig() });
					}
					return;
				}
				case "set_websearch_query_limit": {
					try {
						const config = await runtime.setWebSearchQueryLimit(message.limit);
						broadcast({ type: "websearch_config", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
						broadcast({ type: "websearch_config", config: runtime.getWebSearchConfig() });
					}
					return;
				}
				case "test_websearch_key": {
					const result = await runtime.testWebSearchKey(message.id, message.key);
					broadcast({ type: "websearch_config", config: runtime.getWebSearchConfig() });
					sendTo(socket, { type: "websearch_test_result", result } satisfies SentinelServerMessage);
					return;
				}
				case "get_mcp_servers":
					sendTo(socket, { type: "mcp_servers", config: runtime.getMcpServers() });
					return;
				case "save_mcp_server": {
					// Saving rebuilds the live sessions, so the set of connected servers
					// changes with the form. A running session refuses it.
					try {
						const config = await runtime.saveMcpServer(message.server);
						broadcast({ type: "mcp_servers", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "delete_mcp_server": {
					try {
						const config = await runtime.deleteMcpServer(message.name);
						broadcast({ type: "mcp_servers", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "set_mcp_server_enabled": {
					// Same rebuild as a save: the switch decides whether the server is mounted.
					try {
						const config = await runtime.setMcpServerEnabled(message.name, message.enabled);
						broadcast({ type: "mcp_servers", config });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "test_mcp_server": {
					// A probe writes nothing but the status line, so no rebuild follows.
					const result = await runtime.testMcpServer(message.name, message.draft);
					broadcast({ type: "mcp_servers", config: runtime.getMcpServers() });
					sendTo(socket, {
						type: "mcp_test_result",
						name: message.name,
						result,
					} satisfies SentinelServerMessage);
					return;
				}
				case "get_plugins": {
					sendTo(socket, { type: "plugins", view: await runtime.getPlugins() } satisfies SentinelServerMessage);
					return;
				}
				case "save_plugin_host": {
					try {
						broadcast({ type: "plugins", view: await runtime.savePluginHost(message.host) });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "delete_plugin_host": {
					try {
						broadcast({ type: "plugins", view: await runtime.deletePluginHost(message.id) });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "test_plugin_host": {
					try {
						await runtime.testPluginHost(message.id);
						broadcast({ type: "plugins", view: await runtime.getPlugins() });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "inspect_plugin_package": {
					try {
						const uploaded = readPluginPackage(message.name, message.data);
						sendTo(socket, {
							type: "plugin_manifest",
							manifest: uploaded.manifest,
							source: uploaded.name,
						} satisfies SentinelServerMessage);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "install_plugin": {
					try {
						await runtime.installPlugin({
							hostId: message.hostId,
							manifest: message.manifest,
							package: message.package,
							allowBuild: message.allowBuild,
							allowHostNetwork: message.allowHostNetwork,
							allowPrivileged: message.allowPrivileged,
							config: message.config,
						});
						broadcast({ type: "plugins", view: await runtime.getPlugins() });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "uninstall_plugin": {
					try {
						broadcast({
							type: "plugins",
							view: await runtime.uninstallPlugin(message.hostId, message.pluginId, message.purge),
						});
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "start_plugin": {
					try {
						broadcast({ type: "plugins", view: await runtime.startPlugin(message.hostId, message.pluginId) });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "stop_plugin": {
					try {
						broadcast({ type: "plugins", view: await runtime.stopPlugin(message.hostId, message.pluginId) });
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "get_plugin_build_log": {
					void runtime
						.getPluginBuildLog(message.hostId, message.pluginId)
						.then((log) => {
							sendTo(socket, {
								type: "plugin_build_log",
								hostId: message.hostId,
								pluginId: message.pluginId,
								log,
							});
						})
						.catch((error: unknown) => {
							const detail = error instanceof Error ? error.message : String(error);
							const reason = /没有这个接口|404|not found/i.test(detail)
								? t("插件主机版本过旧，没有构建日志接口；请重启插件主机后再安装")
								: detail;
							sendTo(socket, {
								type: "plugin_build_log",
								hostId: message.hostId,
								pluginId: message.pluginId,
								log: t("读取构建日志失败：{reason}", { reason }),
							});
						});
					return;
				}
				case "list_official_plugins": {
					sendTo(socket, { type: "official_plugins", plugins: listOfficialPlugins() });
					return;
				}
				case "install_official_plugin": {
					const official = getOfficialPlugin(message.pluginId);
					if (!official) {
						sendError(socket, t("没有这个官方插件：{id}", { id: message.pluginId }));
						return;
					}
					void runtime
						.installPlugin({
							hostId: message.hostId,
							manifest: official.manifest,
							package: official.packageBase64,
							allowBuild: message.allowBuild,
							allowHostNetwork: message.allowHostNetwork,
							allowPrivileged: message.allowPrivileged,
							config: message.config,
						})
						.then(async () => {
							broadcast({ type: "plugins", view: await runtime.getPlugins() });
						})
						.catch((error: unknown) => {
							sendError(socket, error instanceof Error ? error.message : String(error));
						});
					return;
				}
				case "set_plugin_sidebar": {
					try {
						broadcast({
							type: "plugins",
							view: await runtime.setPluginSidebar(message.hostId, message.pluginId, message.pinned),
						});
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "set_plugin_enabled": {
					try {
						broadcast({
							type: "plugins",
							view: await runtime.setPluginEnabled(message.hostId, message.pluginId, message.enabled),
						});
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "save_plugin_config": {
					try {
						broadcast({
							type: "plugins",
							view: await runtime.setPluginConfig(message.hostId, message.pluginId, message.values),
						});
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "plugin_ui_open": {
					try {
						runtime.pluginUiOpen(message.hostId, message.pluginId);
						sendTo(socket, {
							type: "plugin_ui_opened",
							token: issuePluginUiToken(message.hostId, message.pluginId),
						});
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "plugin_ui_call": {
					try {
						const result = await runtime.pluginUiCall(
							message.hostId,
							message.pluginId,
							message.method,
							message.params,
						);
						sendTo(socket, {
							type: "plugin_ui_result",
							requestId: message.requestId,
							ok: true,
							result,
						} satisfies SentinelServerMessage);
					} catch (error) {
						sendTo(socket, {
							type: "plugin_ui_result",
							requestId: message.requestId,
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						} satisfies SentinelServerMessage);
					}
					return;
				}
				case "get_plugin_logs": {
					try {
						const logs = await runtime.pluginLogs(message.hostId, message.pluginId);
						sendTo(socket, {
							type: "plugin_logs",
							hostId: message.hostId,
							pluginId: message.pluginId,
							logs,
						} satisfies SentinelServerMessage);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "list_plugin_artifacts": {
					try {
						const artifacts = await runtime.listPluginArtifacts(message.hostId, message.pluginId);
						sendTo(socket, {
							type: "plugin_artifacts",
							hostId: message.hostId,
							pluginId: message.pluginId,
							artifacts,
						} satisfies SentinelServerMessage);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "fetch_plugin_artifact": {
					try {
						const savedTo = await runtime.fetchPluginArtifact(message.hostId, message.pluginId, message.path);
						sendTo(socket, {
							type: "plugin_artifact_saved",
							hostId: message.hostId,
							pluginId: message.pluginId,
							path: message.path,
							savedTo,
						} satisfies SentinelServerMessage);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "get_stats": {
					const stats = runtime.getStats();
					if (stats) socket.send(JSON.stringify({ type: "stats", stats } satisfies SentinelServerMessage));
					return;
				}
				case "list_projects": {
					await broadcastProjects();
					return;
				}
				case "add_project": {
					if (!agentDir) {
						sendError(socket, t("内部错误：agentDir 未初始化"));
						return;
					}
					const result = await addProject(agentDir, {
						name: message.name,
						proxyId: message.proxyId,
						proxyNode: message.proxyNode,
					});
					if (result.error) {
						sendError(socket, result.error);
						return;
					}
					await broadcastProjects();
					return;
				}
				case "remove_project": {
					if (!agentDir) {
						sendError(socket, t("内部错误：agentDir 未初始化"));
						return;
					}
					const registry = listProjects(agentDir);
					const target = registry.projects.find((project) => project.id === message.id);
					if (!target) {
						sendError(socket, t("项目不存在"));
						return;
					}
					if (message.confirmName !== target.name) {
						sendError(socket, t("确认失败：请输入完整项目名「{name}」", { name: target.name }));
						return;
					}
					const wasActive = runtime.snapshot().project?.id === message.id;
					if (message.scope === "container") {
						// Only the container goes: the registry entry, the work directory,
						// the sessions and every record stay. The project needs an explicit
						// start, which recreates the container from current settings.
						const removed = await removeProject(agentDir, message.id, "container");
						if (removed.error) {
							sendError(socket, removed.error);
							return;
						}
						// Its container is gone, so live sessions of the active project cannot
						// run; the console falls back to the project-required state.
						if (wasActive) await runtime.detachProject(target.workDir);
						console.error(`[sentinel-server] 删除项目 ${target.name} 的容器，项目与数据保留`);
						await broadcastProjects();
						if (wasActive) broadcastSnapshot();
						return;
					}
					// Scope "data": unregister, remove the container, and delete what the
					// project owned — records, session files and the work directory.
					const result = await removeProject(agentDir, message.id, "data");
					if (result.error) {
						sendError(socket, result.error);
						return;
					}
					// The project's container is gone: its engines cannot run and
					// their task sessions die with the project, so cascade.
					if (engines) await engines.purgeProject(message.id);
					const purged = runtime.purgeProjectVulns(message.id);
					const purgedGates = runtime.purgeProjectGates(message.id);
					const purgedModels = runtime.purgeProjectApiModels(message.id);
					const purgedCaptures = runtime.purgeProjectCaptures(message.id);
					const purgedAssetQueries = runtime.purgeProjectAssetQueries(message.id);
					const purgedLibraryAssets = runtime.purgeProjectAssetLibrary(message.id);
					const purgedWebSearch = runtime.purgeProjectWebSearch(message.id);
					const purgedSupervisor = runtime.purgeProjectSupervisor(message.id);
					// Detach before the work directory goes: the live sessions holding it
					// must be closed first, or their managers would write into a deleted path.
					if (wasActive) await runtime.detachProject(target.workDir);
					const purgedSessions = await runtime.purgeProjectSessions(target.workDir);
					const workDir = deleteProjectWorkDir(target.workDir);
					console.error(
						`[sentinel-server] 删除项目 ${target.name}，连带删除 ${purged} 条漏洞记录、${purgedGates} 条守门记录、${purgedModels} 份业务模型、${purgedCaptures} 条抓包记录、${purgedAssetQueries} 条资产测绘记录、${purgedLibraryAssets} 条资产库记录、${purgedWebSearch} 条 Web 搜索记录、${purgedSupervisor} 个监督会话、${purgedSessions} 个会话文件${workDir.ok ? "与工作目录" : `（工作目录未删除：${workDir.error ?? ""}）`}`,
					);
					await broadcastProjects();
					broadcastSnapshot();
					return;
				}
				case "stop_project": {
					if (!agentDir) {
						sendError(socket, t("内部错误：agentDir 未初始化"));
						return;
					}
					const target = listProjects(agentDir).projects.find((project) => project.id === message.id);
					if (!target) {
						sendError(socket, t("项目不存在"));
						return;
					}
					// Stopping a container with work in flight would fail that work with
					// docker errors, so the operator is asked to end it first.
					const busy = projectActivity(message.id);
					if (busy.engines > 0 || busy.sessions > 0) {
						sendError(
							socket,
							t(
								"该项目还有正在运行的内容（{engines} 个工程、{sessions} 个会话）：请先暂停工程或等它结束，再停止容器",
								{
									engines: busy.engines,
									sessions: busy.sessions,
								},
							),
						);
						return;
					}
					const stopped = await stopProject(agentDir, message.id);
					if (stopped.error) {
						sendError(socket, stopped.error);
						return;
					}
					// A stopped project cannot be worked in, so the console leaves it; the
					// operator re-enters after starting the container again.
					if (runtime.snapshot().project?.id === message.id) {
						await runtime.detachProject(target.workDir);
						broadcastSnapshot();
					}
					await broadcastProjects();
					return;
				}
				case "start_project": {
					if (!agentDir) {
						sendError(socket, t("内部错误：agentDir 未初始化"));
						return;
					}
					const started = await startProject(agentDir, message.id);
					if (started.error) {
						sendError(socket, started.error);
						return;
					}
					// A recreated container may not match the environment the console
					// reported before (image, toolchain), so re-check it.
					if (started.created) {
						await ensureEnvironment(true);
						broadcastEnvironment();
					}
					await broadcastProjects();
					return;
				}
				case "recreate_project": {
					if (!agentDir) {
						sendError(socket, t("内部错误：agentDir 未初始化"));
						return;
					}
					// Settings that shape a container (the network mode, the mounts) are read
					// when it is created, and Docker cannot change them afterwards, so
					// applying them means replacing the container. The project keeps its id,
					// name and work directory; in-flight commands in its container fail.
					const recreated = await recreateProject(agentDir, message.id);
					if (recreated.error) {
						sendError(socket, recreated.error);
						return;
					}
					await broadcastProjects();
					await ensureEnvironment(true);
					broadcastEnvironment();
					return;
				}
				case "switch_project": {
					if (!agentDir) {
						sendError(socket, t("内部错误：agentDir 未初始化"));
						return;
					}
					const registry = listProjects(agentDir);
					const target = registry.projects.find((project) => project.id === message.id);
					if (!target) {
						sendError(socket, t("项目不存在"));
						return;
					}
					if (!(await ensureProjectReady(target, agentDir))) {
						// A deliberate stop is not a Docker failure: say which click fixes it.
						sendError(
							socket,
							target.manualStop
								? t("项目容器已停止：请在「项目」页点「启动容器」后再进入")
								: t("项目容器 {container} 无法启动，请检查 Docker", { container: target.container }),
						);
						return;
					}
					setLastActiveProject(agentDir, target.id);
					await runtime.switchProject({
						id: target.id,
						name: target.name,
						container: target.container,
						cwd: target.workDir,
					});
					await broadcastProjects();
					await broadcastSessions();
					return;
				}
				case "list_files": {
					const listing = await runtime.listFiles(message.path);
					sendTo(socket, { type: "files", path: listing.path, entries: listing.entries });
					return;
				}
				case "read_file": {
					const preview = await runtime.readFile(message.path);
					sendTo(socket, { type: "file_preview", preview });
					return;
				}
				case "download_file": {
					const file = await runtime.downloadFile(message.path);
					sendTo(socket, {
						type: "file_download",
						path: file.path,
						size: file.size,
						data: file.data,
						mimeType: guessMimeType(file.path),
					});
					return;
				}
				case "write_file":
					await runFileAction(socket, "保存", message.path, () => runtime.writeFile(message.path, message.text));
					return;
				case "upload_file":
					await runFileAction(socket, "上传", message.path, () => runtime.uploadFile(message.path, message.data));
					return;
				case "delete_path":
					await runFileAction(socket, "删除", message.path, () => runtime.deletePath(message.path));
					return;
				case "rename_path":
					await runFileAction(socket, "重命名", message.from, () => runtime.renamePath(message.from, message.to));
					return;
				case "make_directory":
					await runFileAction(socket, "新建目录", message.path, () => runtime.makeDirectory(message.path));
					return;
				case "download_folder": {
					try {
						const source = await runtime.prepareFolderArchive(message.path);
						const job = folderArchives.create(source, {
							onProgress: (progress) =>
								sendTo(socket, {
									type: "folder_archive_progress",
									id: progress.id,
									bytes: progress.bytes,
								}),
							onReady: (ready) =>
								sendTo(socket, {
									type: "folder_archive_ready",
									id: ready.id,
									filename: ready.filename,
									size: ready.size,
									...(ready.warning ? { warning: ready.warning } : {}),
								}),
							onFailed: (failed, error) =>
								sendTo(socket, {
									type: "folder_archive_failed",
									id: failed.id,
									error,
								}),
							onCancelled: (cancelled) =>
								sendTo(socket, {
									type: "folder_archive_cancelled",
									id: cancelled.id,
								}),
						});
						sendTo(socket, {
							type: "folder_archive_started",
							id: job.id,
							path: job.path,
							filename: job.filename,
						});
					} catch (error) {
						sendTo(socket, {
							type: "folder_archive_failed",
							error: error instanceof Error ? error.message : String(error),
						});
					}
					return;
				}
				case "cancel_folder_archive": {
					if (!folderArchives.cancel(message.id)) {
						sendTo(socket, {
							type: "folder_archive_failed",
							id: message.id,
							error: t("打包任务不存在或已结束"),
						});
					}
					return;
				}
				case "terminal_open": {
					const project = runtime.snapshot().project;
					if (!project) {
						sendTo(socket, {
							type: "terminal_state",
							projectId: message.projectId,
							outcome: "failed",
							error: t("未选择项目，终端不可用"),
						});
						return;
					}
					if (!project.container) {
						sendTo(socket, {
							type: "terminal_state",
							projectId: message.projectId,
							outcome: "failed",
							error: t("项目没有容器，终端不可用"),
						});
						return;
					}
					if (project.id !== message.projectId) {
						sendTo(socket, {
							type: "terminal_state",
							projectId: message.projectId,
							outcome: "failed",
							error: t("终端项目与当前项目不匹配"),
						});
						return;
					}
					const opened = await terminal.open({
						projectId: project.id,
						projectName: project.name,
						container: project.container,
						cols: message.cols,
						rows: message.rows,
					});
					if (opened.outcome === "failed") {
						sendTo(socket, {
							type: "terminal_state",
							projectId: project.id,
							outcome: "failed",
							error: opened.error,
						});
						return;
					}
					sendTo(socket, {
						type: "terminal_state",
						projectId: project.id,
						outcome: opened.outcome,
						session: opened.session,
						...(opened.outcome === "opened" ? { replay: opened.replay } : {}),
					});
					return;
				}
				case "terminal_input":
					terminal.write(message.projectId, message.data);
					return;
				case "terminal_close":
					// Broadcast, so every open panel drops its shell view rather than
					// keeping a terminal that no longer exists.
					terminal.close(message.projectId);
					broadcast({ type: "terminal_state", projectId: message.projectId, outcome: "closed" });
					return;
				case "list_subagents": {
					const requested = message.limit ?? 100;
					const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.round(requested))) : 100;
					const offset = Number.isFinite(message.offset) ? Math.max(0, Math.round(message.offset ?? 0)) : 0;
					sendTo(socket, {
						type: "subagents",
						runs: runtime.listSubagents(limit, offset),
						offset,
						total: runtime.countSubagents(),
					});
					return;
				}
				case "list_vulns": {
					const view = runtime.listVulns(message.filters);
					sendTo(socket, { type: "vulns", items: view.items, stats: view.stats });
					return;
				}
				case "get_vuln": {
					const vuln = runtime.getVuln(message.id);
					if (!vuln) {
						sendError(socket, t("该漏洞记录不存在（可能属于其他项目，或已被删除）"));
						return;
					}
					sendTo(socket, { type: "vuln", vuln });
					return;
				}
				case "update_vuln": {
					const updated = runtime.updateVuln(message.id, message.patch);
					if (!updated) {
						sendTo(socket, {
							type: "vuln_result",
							action: "复核",
							id: message.id,
							ok: false,
							error: t("该漏洞记录不存在（可能属于其他项目，或已被删除）"),
						} satisfies SentinelServerMessage);
						return;
					}
					sendTo(socket, { type: "vuln", vuln: updated });
					sendTo(socket, { type: "vuln_result", action: "复核", id: updated.id, ok: true });
					return;
				}
				case "retry_vuln_review": {
					if (!reviewer) {
						sendError(socket, t("未配置配置目录，无法评审"));
						return;
					}
					const result = message.force ? reviewer.requeue(message.id) : reviewer.retry(message.id);
					sendTo(socket, {
						type: "vuln_review_result",
						id: message.id,
						ok: result.ok,
						...(result.error ? { error: result.error } : {}),
					});
					return;
				}
				case "review_pending_vulns": {
					if (!reviewer) {
						sendError(socket, t("未配置配置目录，无法评审"));
						return;
					}
					// The requeue itself is the feedback: the refreshed list shows
					// every record flipping to 评审中.
					reviewer.requeueAll(runtime.pendingVulnIds());
					broadcastVulns();
					return;
				}
				case "preview_vuln_delete": {
					// The dialog shows what disappears with the records; nothing is
					// deleted until the operator confirms.
					sendTo(socket, { type: "vuln_delete_preview", ...runtime.previewVulnDelete(message.ids) });
					return;
				}
				case "delete_vulns": {
					// Deleting triggers the hub-change hook, which broadcasts the
					// unfiltered list to every console; the caller answers with its own
					// count and then re-lists with its own filters, so a filtered view is
					// not silently widened.
					const count = runtime.deleteVulns(message.ids);
					sendTo(socket, { type: "vulns_deleted", count });
					return;
				}
				case "export_vulns": {
					const report = runtime.exportVulns(message.filters);
					sendTo(socket, { type: "vulns_export", filename: report.filename, markdown: report.markdown });
					return;
				}
				case "list_assets": {
					const view = runtime.listAssets(message.filters, message.page, message.pageSize);
					sendTo(socket, {
						type: "assets",
						items: view.items,
						stats: view.stats,
						total: view.total,
						page: view.page,
						pageSize: view.pageSize,
						hasMore: view.hasMore,
					} satisfies SentinelServerMessage);
					return;
				}
				case "get_asset": {
					const detail = runtime.getAsset(message.id);
					if (!detail) {
						sendError(socket, t("该资产不存在（可能属于其他项目，或已被删除）"));
						return;
					}
					sendTo(socket, { type: "asset", detail });
					return;
				}
				case "update_asset": {
					try {
						const detail = runtime.updateAsset(message.id, message.patch);
						if (!detail) {
							sendTo(socket, {
								type: "asset_result",
								action: "更新",
								id: message.id,
								ok: false,
								error: t("该资产不存在（可能属于其他项目，或已被删除）"),
							} satisfies SentinelServerMessage);
							return;
						}
						sendTo(socket, { type: "asset", detail });
						sendTo(socket, { type: "asset_result", action: "更新", id: detail.asset.id, ok: true });
					} catch (error) {
						sendTo(socket, {
							type: "asset_result",
							action: "更新",
							id: message.id,
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						} satisfies SentinelServerMessage);
					}
					return;
				}
				case "preview_asset_delete": {
					sendTo(socket, { type: "asset_delete_preview", ...runtime.previewAssetDelete(message.ids) });
					return;
				}
				case "delete_assets": {
					const count = runtime.deleteAssets(message.ids);
					sendTo(socket, { type: "assets_deleted", count });
					return;
				}
				case "export_assets": {
					const report = runtime.exportAssets(message.filters);
					sendTo(socket, { type: "assets_export", filename: report.filename, markdown: report.markdown });
					return;
				}
				case "list_pocs": {
					const view = runtime.listPocs(message.filters, message.page, message.pageSize);
					sendTo(socket, {
						type: "pocs",
						items: view.items,
						stats: view.stats,
						total: view.total,
						page: view.page,
						pageSize: view.pageSize,
					});
					return;
				}
				case "get_poc": {
					const poc = runtime.getPoc(message.id);
					if (!poc) {
						sendError(socket, t("POC 库中没有 id 为 {id} 的模板", { id: message.id }));
						return;
					}
					sendTo(socket, { type: "poc", poc });
					return;
				}
				case "list_poc_sources": {
					sendTo(socket, { type: "poc_sources", sources: runtime.listPocSources() });
					return;
				}
				case "save_poc_source": {
					const result = runtime.savePocSource(message.source);
					if ("error" in result) {
						sendTo(socket, { type: "poc_source_result", action: "保存", ok: false, error: result.error });
						return;
					}
					sendTo(socket, { type: "poc_source_result", action: "保存", id: result.source.id, ok: true });
					sendTo(socket, { type: "poc_sources", sources: runtime.listPocSources() });
					return;
				}
				case "delete_poc_source": {
					const ok = runtime.deletePocSource(message.id);
					sendTo(socket, {
						type: "poc_source_result",
						action: "删除",
						id: message.id,
						ok,
						...(ok ? {} : { error: t("该订阅源不存在") }),
					});
					return;
				}
				case "sync_poc_source": {
					const result = await runtime.syncPocSource(message.id);
					if ("error" in result) {
						sendTo(socket, {
							type: "poc_source_result",
							action: "同步",
							id: message.id,
							ok: false,
							error: result.error,
						});
						return;
					}
					sendTo(socket, { type: "poc_source_result", action: "同步", id: message.id, ok: true });
					// The sync itself already broadcast the refreshed list.
					return;
				}
				case "sync_official_pocs": {
					const result = await runtime.syncOfficialPocs();
					if ("error" in result) {
						sendTo(socket, { type: "poc_source_result", action: "同步官方 POC", ok: false, error: result.error });
						return;
					}
					sendTo(socket, { type: "poc_source_result", action: "同步官方 POC", ok: true });
					// The sync itself already broadcast the refreshed list.
					return;
				}
				case "delete_poc": {
					const ok = runtime.deletePoc(message.id);
					sendTo(socket, {
						type: "poc_result",
						action: "删除",
						id: message.id,
						ok,
						...(ok ? {} : { error: t("该模板不存在") }),
					});
					return;
				}
				case "start_modeling": {
					// Modeling runs the agent, so it needs the same container backend.
					const report = await ensureEnvironment();
					if (!report.ok) {
						sendError(socket, blockedReason(report));
						broadcastEnvironment();
						return;
					}
					await runtime.startModeling();
					return;
				}
				case "end_modeling":
					await runtime.endModeling();
					return;
				case "detach_modeling":
					await runtime.detachModeling();
					return;
				case "list_api_models":
					sendTo(socket, { type: "api_models", items: runtime.listApiModels(message.filters) });
					return;
				case "get_api_model": {
					const view = runtime.getApiModel(message.id);
					if (!view) {
						sendError(socket, t("没有 id 为 {id} 的业务建模记录", { id: message.id }));
						return;
					}
					sendTo(socket, { type: "api_model", model: view.model, events: view.events });
					return;
				}
				case "end_api_model": {
					// The page's way out of a run whose session is gone; a loaded
					// session ends it through the normal path (tools off, marker).
					const ok = runtime.finishApiModel(message.id, "manual", t("操作员在业务建模页结束"));
					sendTo(socket, {
						type: "api_model_result",
						action: "结束",
						id: message.id,
						ok,
						...(ok ? {} : { error: t("该记录不存在") }),
					});
					return;
				}
				case "delete_api_model": {
					const ok = runtime.deleteApiModel(message.id);
					sendTo(socket, {
						type: "api_model_result",
						action: "删除",
						id: message.id,
						ok,
						...(ok ? {} : { error: t("该记录不存在") }),
					});
					return;
				}
				case "droid_state": {
					const state = runtime.droidState();
					sendTo(socket, {
						type: "droid_state",
						enabled: state.enabled,
						devices: state.devices,
						tokens: state.tokens,
						listen: droidGateway.listenInfo() ?? null,
						listenConfig: runtime.droidListenConfig(),
						lanIps: lanIps(),
					});
					return;
				}
				case "droid_token_create": {
					await runtime.droidCreateToken(message.label);
					return;
				}
				case "droid_token_delete": {
					try {
						await runtime.droidDeleteToken(message.id);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "droid_device_rename": {
					try {
						await runtime.droidRenameDevice(message.id, message.name);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "droid_device_remove": {
					try {
						await runtime.droidRemoveDevice(message.id);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "droid_set_enabled": {
					await runtime.setDroidEnabled(message.enabled);
					return;
				}
				case "droid_set_listen": {
					try {
						await runtime.droidSetListen(message.host, message.port);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "ios_set_listen": {
					try {
						await runtime.iosSetListen(message.host, message.port);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "ios_state": {
					const state = runtime.iosState();
					sendTo(socket, {
						type: "ios_state",
						enabled: state.enabled,
						devices: state.devices,
						tokens: state.tokens,
						listen: iosGateway.listenInfo() ?? null,
						listenConfig: runtime.iosListenConfig(),
						lanIps: lanIps(),
						certPin,
					});
					return;
				}
				case "ios_token_create": {
					await runtime.iosCreateToken(message.label);
					return;
				}
				case "ios_device_rename": {
					try {
						await runtime.iosRenameDevice(message.id, message.name);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "ios_device_remove": {
					try {
						await runtime.iosRemoveDevice(message.id);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "ios_set_enabled": {
					await runtime.setIosEnabled(message.enabled);
					return;
				}
				case "export_api_model": {
					const file = runtime.exportApiModel(message.id, message.format);
					if (!file) {
						sendError(socket, t("该记录不存在"));
						return;
					}
					sendTo(socket, {
						type: "api_model_export",
						filename: file.filename,
						format: message.format,
						text: file.text,
					});
					return;
				}
				case "get_subagent": {
					const run = runtime.getSubagent(message.id);
					if (!run) {
						sendError(socket, t("该子代理记录不存在"));
						return;
					}
					sendTo(socket, { type: "subagent_run", run });
					return;
				}
				case "abort_subagent": {
					const ok = await runtime.abortSubagent(message.id);
					sendTo(socket, {
						type: "subagent_result",
						action: "中止",
						id: message.id,
						ok,
						...(ok ? {} : { error: t("该子代理已结束，无需中止") }),
					});
					return;
				}
				case "steer_subagent": {
					if (!message.text.trim()) {
						sendError(socket, t("追加指令不能为空"));
						return;
					}
					const steerEnv = await ensureEnvironment();
					if (!steerEnv.ok) {
						sendError(socket, blockedReason(steerEnv));
						return;
					}
					const ok = await runtime.steerSubagent(message.id, message.text);
					sendTo(socket, {
						type: "subagent_result",
						action: "追加指令",
						id: message.id,
						ok,
						...(ok ? {} : { error: t("该子代理已结束，无法追加指令") }),
					});
					return;
				}
				case "list_engines":
					broadcastEngines(socket);
					return;
				case "engine_create": {
					if (!engines) {
						sendError(socket, t("未配置配置目录，无法使用工程模式"));
						return;
					}
					const project = runtime.snapshot().project;
					if (!project) {
						sendError(socket, t("请先创建或选择一个项目，工程属于项目"));
						return;
					}
					// A scheduled engine checks the environment when it actually starts, not
					// at planning time: Docker being down now must not prevent making a plan.
					if (!message.input.schedule) {
						const report = await ensureEnvironment();
						if (!report.ok) {
							sendError(socket, blockedReason(report));
							broadcastEnvironment();
							return;
						}
					}
					// Creation inserts the row before the commander's first turn; tell the
					// server to return now and let the insert's engine_update reach the page.
					void engines
						.createEngine(project, message.input)
						.then(() => broadcastEngines())
						.catch((error: unknown) => {
							sendError(socket, error instanceof Error ? error.message : String(error));
						});
					return;
				}
				case "engine_set_gate_mode": {
					if (!engines) {
						sendError(socket, t("未配置配置目录，无法使用工程模式"));
						return;
					}
					engines.setGateMode(message.id, message.gateMode);
					broadcastEngines();
					return;
				}
				case "engine_set_presets": {
					if (!engines) {
						sendError(socket, t("未配置配置目录，无法使用工程模式"));
						return;
					}
					engines.setPresets(message.id, message.presetIds);
					broadcastEngines();
					return;
				}
				case "engine_set_preset_optional": {
					if (!engines) {
						sendError(socket, t("未配置配置目录，无法使用工程模式"));
						return;
					}
					engines.setPresetOptional(message.id, message.optional);
					broadcastEngines();
					return;
				}
				case "engine_pause":
					if (engines) await engines.pauseEngine(message.id);
					return;
				case "engine_resume": {
					if (!engines) return;
					const report = await ensureEnvironment();
					if (!report.ok) {
						sendError(socket, blockedReason(report));
						return;
					}
					await engines.resumeEngine(message.id);
					return;
				}
				case "engine_abort":
					if (engines) await engines.abortEngine(message.id);
					return;
				case "engine_set_schedule":
					if (!engines) return;
					try {
						engines.setSchedule(message.id, message.schedule);
						broadcastEngines();
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				case "engine_cancel_schedule":
					if (!engines) return;
					try {
						engines.cancelSchedule(message.id);
						broadcastEngines();
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				case "engine_delete":
					if (engines) {
						await engines.deleteEngine(message.id);
						broadcastEngines();
					}
					return;
				case "engine_add_targets":
					if (engines) engines.addTargets(message.id, message.targets);
					return;
				case "engine_steer_commander":
					if (!engines) return;
					// Do not hold the socket's message loop for a whole commander turn;
					// the operator event is broadcast before this promise settles.
					void engines.steerCommander(message.id, message.text).catch((error: unknown) => {
						sendError(socket, error instanceof Error ? error.message : String(error));
					});
					return;
				case "engine_abort_task": {
					if (!engines) return;
					const aborted = await engines.abortTask(message.taskId, t("操作员在工程页中止"));
					if (!aborted.ok) sendError(socket, aborted.error ?? t("任务未能中止"));
					return;
				}
				case "engine_task_events": {
					if (!engines) return;
					sendTo(socket, {
						type: "engine_task_events",
						taskId: message.taskId,
						events: engines.taskEvents(message.taskId),
					});
					return;
				}
				case "engine_commander_events": {
					if (!engines) return;
					sendTo(socket, {
						type: "engine_commander_events",
						id: message.id,
						events: engines.commanderEvents(message.id),
					});
					return;
				}
				case "engine_open_task_session": {
					if (!engines) return;
					try {
						const path = engines.taskSessionPath(message.taskId);
						await runtime.switchSession(path);
					} catch (error) {
						sendError(socket, error instanceof Error ? error.message : String(error));
					}
					return;
				}
				case "engine_report_snapshot": {
					if (!engines) return;
					const reportView = engines.reportSnapshot(message.id);
					sendTo(socket, {
						type: "engine_report",
						id: message.id,
						markdown: reportView.markdown,
						filename: reportView.filename,
					});
					return;
				}
				case "list_doctrines":
					sendTo(socket, {
						type: "doctrines",
						doctrines: agentDir ? listDoctrines(agentDir) : [],
					});
					return;
				case "save_doctrine": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法保存指挥思路"));
						return;
					}
					const result = saveDoctrine(agentDir, message.input);
					sendTo(socket, {
						type: "doctrine_saved",
						doctrine: result.doctrine ?? {
							id: message.input.id ?? "",
							name: message.input.name,
							text: message.input.text,
							builtin: false,
						},
						...(result.error ? { error: result.error } : {}),
					});
					return;
				}
				case "delete_doctrine": {
					if (!agentDir) return;
					const result = agentDir
						? deleteDoctrine(agentDir, message.id)
						: { ok: false, error: t("未配置配置目录") };
					sendTo(socket, {
						type: "doctrine_deleted",
						id: message.id,
						ok: result.ok,
						...(result.error ? { error: result.error } : {}),
					});
					return;
				}
				case "list_presets":
					sendTo(socket, { type: "presets", presets: agentDir ? presetViews(agentDir) : [] });
					return;
				case "save_preset": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法保存预设 Agent"));
						return;
					}
					const result = savePreset(agentDir, message.input);
					sendTo(socket, {
						type: "preset_saved",
						preset: result.preset ? presetView(agentDir, result.preset.id) : null,
						...(result.error ? { error: result.error } : {}),
					});
					// The snapshot carries the active session's preset view — its name and
					// the composer hint — so an edit has to reach an open chat page too,
					// not just the settings page that made it.
					if (result.preset) broadcastSnapshot();
					return;
				}
				case "delete_preset": {
					if (!agentDir) return;
					const result = deletePreset(agentDir, message.id);
					sendTo(socket, {
						type: "preset_deleted",
						id: message.id,
						ok: result.ok,
						...(result.error ? { error: result.error } : {}),
					});
					if (result.ok) broadcastSnapshot();
					return;
				}
				case "set_preset_enabled": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法修改预设 Agent"));
						return;
					}
					const result = setPresetEnabled(agentDir, message.id, message.enabled);
					sendTo(socket, {
						type: "preset_saved",
						preset: result.preset ? presetView(agentDir, result.preset.id) : null,
						...(result.error ? { error: result.error } : {}),
					});
					if (result.preset) broadcastSnapshot();
					return;
				}
				case "export_presets": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法导出预设 Agent"));
						return;
					}
					// The file is built here and handed over as text: the browser turns it
					// into a download, so no server route has to serve operator data.
					const exported = exportPresets(agentDir, message.ids);
					sendTo(socket, {
						type: "presets_export",
						filename: exportFileName(new Date()),
						content: `${JSON.stringify(exported, null, "\t")}\n`,
					});
					return;
				}
				case "import_presets": {
					if (!agentDir) {
						sendError(socket, t("未配置配置目录，无法导入预设 Agent"));
						return;
					}
					let parsed: unknown;
					try {
						parsed = JSON.parse(message.content) as unknown;
					} catch {
						sendError(socket, t("导入失败：文件内容不是合法的 JSON"));
						return;
					}
					const result = importPresets(agentDir, parsed);
					sendTo(socket, {
						type: "presets_imported",
						imported: result.imported.map((preset) => ({
							...preset,
							text: presetView(agentDir, preset.id)?.text ?? "",
							textMissing: false,
							tokens: presetView(agentDir, preset.id)?.tokens ?? 0,
						})),
						skipped: result.skipped,
						...(result.error ? { error: result.error } : {}),
					});
					return;
				}
				case "set_ui_language": {
					if (message.language !== "zh" && message.language !== "en") return;
					setServerLanguage(message.language);
					if (agentDir) writeUiConfig(agentDir, { language: message.language });
					broadcast({ type: "ui_config", language: message.language });
					return;
				}
				case "get_gatekeeper_config":
					sendTo(socket, { type: "gatekeeper_config", config: runtime.getGatekeeperConfig() });
					return;
				case "save_gatekeeper_config": {
					runtime.saveGatekeeperConfig(message.config);
					sendTo(socket, { type: "gatekeeper_config", config: runtime.getGatekeeperConfig() });
					// The saved mode is the global default, so it can change the active
					// session's effective mode and the toolbar switch that shows it.
					broadcastSnapshot();
					return;
				}
				case "test_judge": {
					const result = await runtime.testJudge();
					sendTo(socket, { type: "judge_test_result", ...result });
					return;
				}
				case "gate_audit_query": {
					const page = runtime.listGateDecisions(message.filter, message.page, message.pageSize);
					sendTo(socket, { type: "gate_audit", page });
					return;
				}
				case "gate_audit_stats":
					sendTo(socket, {
						type: "gate_audit_stats",
						stats: runtime.getGateStats(message.filter),
						// Without the approval filter: the tab strip counts both tabs
						// whichever one is open.
						tabCounts: runtime.getGateBuckets(message.filter),
					});
					return;
				case "supervisor_arm": {
					const view = runtime.armSupervisor(
						message.mode,
						message.delivery,
						message.strategy,
						message.note,
						message.customStrategyId,
						message.strategies,
					);
					broadcast({ type: "supervisor_state", supervisor: view });
					return;
				}
				case "supervisor_stop": {
					const view = runtime.stopSupervisor();
					broadcast({ type: "supervisor_state", supervisor: view });
					return;
				}
				case "supervisor_set_mode": {
					const view = runtime.setSupervisorMode(message.mode, message.delivery);
					broadcast({ type: "supervisor_state", supervisor: view });
					return;
				}
				case "supervisor_set_strategy": {
					const view = runtime.setSupervisorStrategy(
						message.strategy,
						message.note,
						message.customStrategyId,
						message.strategies,
					);
					broadcast({ type: "supervisor_state", supervisor: view });
					return;
				}
				case "supervisor_run_now":
					runtime.runSupervisorNow();
					return;
				case "supervisor_call_output": {
					try {
						const output = runtime.getSupervisorCallOutput(message.callId);
						sendTo(socket, {
							type: "supervisor_call_output",
							callId: message.callId,
							text: output.text,
							truncated: output.truncated,
						} satisfies SentinelServerMessage);
					} catch (error) {
						sendTo(socket, {
							type: "supervisor_call_output",
							callId: message.callId,
							text: "",
							truncated: false,
							error: error instanceof Error ? error.message : String(error),
						} satisfies SentinelServerMessage);
					}
					return;
				}
				case "supervisor_audit":
					sendTo(socket, {
						type: "supervisor_audit",
						page: runtime.listSupervisorAudit({
							page: message.page,
							pageSize: message.pageSize,
							projectId: message.projectId,
							search: message.search,
							mode: message.mode,
							progress: message.progress,
							strategy: message.strategy,
							customStrategyId: message.customStrategyId,
						}),
					} satisfies SentinelServerMessage);
					return;
				case "supervisor_detail": {
					const detail = runtime.getSupervisorDetail(message.sessionId);
					if (!detail) {
						sendError(socket, t("监督记录不存在"));
						return;
					}
					sendTo(socket, { type: "supervisor_detail", detail } satisfies SentinelServerMessage);
					return;
				}
				case "supervisor_advice_action": {
					const advice =
						message.action === "send"
							? runtime.sendSupervisorAdvice(message.id)
							: runtime.ignoreSupervisorAdvice(message.id);
					broadcast({ type: "supervisor_advice", advice });
					return;
				}
				case "save_supervisor_config": {
					const config = runtime.saveSupervisorConfig(message.config);
					broadcast({ type: "supervisor_config", config });
					broadcastSnapshot();
					return;
				}
				case "test_supervisor": {
					const outcome = await runtime.testSupervisor();
					sendTo(socket, {
						type: "supervisor_test_result",
						...outcome,
					} satisfies SentinelServerMessage);
					return;
				}
				default:
					sendError(socket, t("未知消息类型: {type}", { type: (message as { type?: string }).type ?? "?" }));
			}
		} catch (error) {
			sendError(socket, error instanceof Error ? error.message : String(error));
		}
	}

	function sendError(socket: WebSocket, messageText: string): void {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: "error", message: messageText } satisfies SentinelServerMessage));
		}
	}

	await runtime.init();

	return await new Promise((resolvePromise) => {
		const port = options.port ?? 7777;
		const host = options.host ?? "127.0.0.1";
		server.listen(port, host, () => {
			// The check reports the console address, so it starts once the port is known.
			const environment = ensureEnvironment().then(
				(report) => {
					broadcastEnvironment();
					return report;
				},
				(error: unknown) => {
					console.error("[sentinel-server] 环境检查失败:", error);
					return {
						at: new Date().toISOString(),
						ok: false,
						items: [
							{
								id: "check-failed",
								group: "Docker 运行时",
								label: t("环境检查"),
								status: "fail" as const,
								detail: error instanceof Error ? error.message : String(error),
								blocking: true,
							},
						],
						url: consoleUrl(),
						sources: { ...EMPTY_SOURCES },
						containerNetwork: agentDir ? readContainerNetwork(agentDir) : DEFAULT_CONTAINER_NETWORK,
						proxies: {
							proxies: [],
							defaultId: null,
							image: agentDir ? readProxies(agentDir).image : DEFAULT_SINGBOX_IMAGE,
							imagePresent: false,
							testUrl: DEFAULT_TEST_URL,
						},
					};
				},
			);
			resolvePromise({
				url: consoleUrl(),
				environment,
				close: () => {
					subscriptionScheduler?.stop();
					pocImports.close();
					folderArchives.dispose();
					iosGateway.close();
					engines?.dispose();
					terminal.dispose();
					runtime.dispose();
					for (const client of clients) client.terminate();
					wss.close();
					server.close();
				},
			});
		});
	});
}
