/**
 * Proxy profiles and the sing-box configuration they become.
 *
 * A project that has a proxy does not get the host or bridge network: it shares
 * the network namespace of its own sing-box sidecar, so every packet a tool sends
 * leaves through the tunnel. The console owns the parts that have to be right for
 * that to work at all — the tun inbound, the DNS escape hatch, the route order —
 * and a profile only describes where the traffic should come out.
 *
 * Profiles live in `<agentDir>/proxies.json` (0600, credentials included), one
 * file for the whole console: a node is something an engagement borrows, not
 * something it owns, and the 代理 page is where they are kept. A project stores
 * only the id it uses, so editing a profile reaches every project that picked it.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { t } from "./i18n.ts";
import { DEFAULT_TEST_URL, measureNodes } from "./node-test.ts";
import { describeOpenVpn } from "./openvpn.ts";
import type {
	SentinelOpenVpn,
	SentinelProxy,
	SentinelProxyConfigView,
	SentinelProxyInput,
	SentinelProxyNode,
	SentinelProxySettings,
	SentinelProxySubscription,
	SentinelProxyTest,
	SentinelSimpleProxy,
	SentinelWireGuard,
} from "./protocol.ts";
import { downloadSubscription, parseSubscription, subscriptionUserAgent } from "./subscription.ts";
import { normalizeIntervalHours } from "./subscription-scheduler.ts";

/** Pinned so a console upgrade does not silently change tunnel behaviour. */
export const DEFAULT_SINGBOX_IMAGE = "ghcr.io/sagernet/sing-box:v1.13.15";

/**
 * Address of the tunnel interface. 198.18.0.0/15 is the benchmarking range, which
 * no Docker network pool uses, so the route can never shadow the container's own
 * network — the one the sidecar itself uses to reach the proxy server.
 */
export const SINGBOX_TUN_ADDRESS = "198.18.0.1/30";

/** Tag the generated config routes through when the profile did not name one. */
export const PROXY_OUTBOUND_TAG = "proxy";

/**
 * The tag that means "let sing-box pick".
 *
 * It is not a node, which is why it is not in `nodes`: it is a `urltest`
 * outbound the console generates, offered in the same list so the operator can
 * choose between a fixed exit and the fastest healthy one.
 */
export const AUTO_NODE_TAG = "auto";

/** What a project stores when the operator chose "no proxy" for it. */
export const NO_PROXY = null;

interface ProxiesFile {
	proxies: SentinelProxy[];
	defaultId: string | null;
	image: string;
	/** URL the batch latency test fetches through each node. */
	testUrl: string;
}

export function proxiesPath(agentDir: string): string {
	return join(agentDir, "proxies.json");
}

/**
 * Where a project's generated sing-box configuration is written. Named by project
 * id: two projects can use different profiles, and the sidecar mounts exactly one
 * of these, so the file never has to be rewritten for another project's sake.
 */
export function projectProxyConfigPath(agentDir: string, projectId: string): string {
	return join(agentDir, "proxy", `${projectId}.json`);
}

/**
 * Where a WireGuard profile's `wg0.conf` is written.
 *
 * A separate file rather than the JSON one: `wg-quick` reads an ini, and the
 * environment check compares modification times per path, so the two kinds of
 * sidecar must not share one.
 */
export function projectWireGuardConfigPath(agentDir: string, projectId: string): string {
	return join(agentDir, "proxy", `${projectId}.wg.conf`);
}

/**
 * Where the resolver a tunnel hands to its project container is written.
 *
 * A file rather than `docker run --dns`: Docker refuses that flag together with a
 * container network mode ("conflicting options: dns and the network mode"), which
 * is the mode every tunneled container is created with. The file is mounted over
 * `/etc/resolv.conf`, so it is part of the container's configuration and survives
 * a start, and its content is live — editing it reaches a running container
 * without a rebuild.
 */
export function projectResolvConfPath(agentDir: string, projectId: string): string {
	return join(agentDir, "proxy", `${projectId}.resolv.conf`);
}

/**
 * Where an OpenVPN profile's generated files are written: the stripped `.ovpn`,
 * the credentials it must not carry, the hook the client runs after every
 * connection, and the resolvers that hook writes back.
 *
 * Four files rather than one because each is mounted at a different path with a
 * different mode — the configuration and the credentials read-only, the hook
 * read-only, the pushed-resolver file writable by the sidecar. None of them is
 * visible from the job container, which shares only the network namespace.
 */
export function projectOpenVpnConfigPath(agentDir: string, projectId: string): string {
	return join(agentDir, "proxy", `${projectId}.ovpn`);
}

export function projectOpenVpnAuthPath(agentDir: string, projectId: string): string {
	return join(agentDir, "proxy", `${projectId}.ovpn.auth`);
}

export function projectOpenVpnHookPath(agentDir: string, projectId: string): string {
	return join(agentDir, "proxy", `${projectId}.ovpn.hook.sh`);
}

export function projectOpenVpnPushedDnsPath(agentDir: string, projectId: string): string {
	return join(agentDir, "proxy", `${projectId}.ovpn.pushed-dns`);
}

/**
 * The nameservers in a profile's DNS value.
 *
 * `DNS = 10.66.0.1, 1.1.1.1` is how a provider writes a pair, and only an IP can
 * go into a `nameserver` line: everything else is dropped here rather than written
 * into a resolver file glibc would ignore line by line.
 */
export function parseNameservers(value: string): string[] {
	return value.split(/[\s,]+/).filter((entry) => isIP(entry) !== 0);
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asBool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/**
 * A proxy server typed the way people write them: `socks5://host:1080`,
 * `host:1080` or just `host`. The scheme is dropped (the type field says it) and a
 * port baked into the string fills the port field when that one is empty.
 */
function normalizeServer(value: unknown, port: number): { server: string; port: number } {
	const raw = asString(value).trim();
	if (!raw) return { server: "", port };
	const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
	const match = /^(.*):(\d{1,5})$/.exec(withoutScheme);
	const host = match?.[1];
	const inlinePort = match?.[2];
	// A bare IPv6 address is full of colons, so only a single-colon form can be a
	// host:port shorthand.
	if (host && inlinePort && !host.includes(":") && port <= 0) {
		return { server: host, port: Number(inlinePort) };
	}
	return { server: withoutScheme, port };
}

function normalizePort(value: unknown): number {
	const port = typeof value === "number" ? value : Number.parseInt(asString(value), 10);
	if (!Number.isFinite(port)) return 0;
	const rounded = Math.trunc(port);
	return rounded >= 1 && rounded <= 65535 ? rounded : 0;
}

function normalizeSimpleProxy(value: unknown): SentinelSimpleProxy {
	const input = (value ?? {}) as Partial<SentinelSimpleProxy>;
	const port = normalizePort(input.port);
	const { server, port: withPort } = normalizeServer(input.server, port);
	return {
		type: input.type === "http" ? "http" : "socks5",
		server,
		port: withPort,
		username: asString(input.username).trim(),
		password: asString(input.password),
		tls: asBool(input.tls, false),
	};
}

/**
 * A JSON file can hold anything; only the known modes are accepted.
 *
 * The pasted-outbound mode was removed before release. A profile that still says
 * `json` reads back as a `simple` one with an empty address, which surfaces as
 * "代理服务器地址为空" — a visible, fixable state rather than a profile that
 * silently cannot build a configuration.
 */
export function normalizeProxyMode(value: unknown): SentinelProxySettings["mode"] {
	if (value === "simple" || value === "subscription" || value === "wireguard" || value === "openvpn") return value;
	return "off";
}

/** A profile is never `off`: a stored value that says so reads back as `simple`. */
function profileMode(value: unknown): SentinelProxy["mode"] {
	const mode = normalizeProxyMode(value);
	return mode === "off" ? "simple" : mode;
}

/** A node as it was cached: the outbound is opaque to everything but sing-box. */
function normalizeNode(value: unknown): SentinelProxyNode | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Partial<SentinelProxyNode>;
	const tag = asString(input.tag).trim();
	const outbound = input.outbound;
	if (!tag || !outbound || typeof outbound !== "object" || Array.isArray(outbound)) return undefined;
	return {
		tag,
		name: asString(input.name).trim() || tag,
		protocol: asString(input.protocol).trim() || asString((outbound as Record<string, unknown>).type),
		outbound: outbound as Record<string, unknown>,
		latencyMs:
			typeof input.latencyMs === "number" && Number.isFinite(input.latencyMs)
				? input.latencyMs
				: input.latencyMs === null
					? null
					: undefined,
		testedAt: typeof input.testedAt === "number" && Number.isFinite(input.testedAt) ? input.testedAt : undefined,
	};
}

/** A tunnel as stored: the pasted configuration plus two switches. */
export function normalizeWireGuard(value: unknown): SentinelWireGuard {
	const input = (value ?? {}) as Partial<SentinelWireGuard>;
	return {
		config: asString(input.config).trim(),
		dns: asString(input.dns).trim(),
		// On by default: a tunnel that silently falls back to the host network is
		// the failure mode this switch exists to prevent.
		killSwitch: asBool(input.killSwitch, true),
	};
}

/** An OpenVPN tunnel as stored: the pasted `.ovpn`, its credentials and two switches. */
export function normalizeOpenVpn(value: unknown): SentinelOpenVpn {
	const input = (value ?? {}) as Partial<SentinelOpenVpn>;
	return {
		config: asString(input.config).trim(),
		dns: asString(input.dns).trim(),
		username: asString(input.username).trim(),
		// Not trimmed: a password may end in a space, and only the provider knows.
		password: asString(input.password),
		killSwitch: asBool(input.killSwitch, true),
	};
}

/**
 * The stored result of a connectivity test.
 *
 * A result without a URL is dropped: it would be a green or red mark with no way
 * to tell what was fetched, and the page can always run the test again.
 */
function normalizeProxyTest(value: unknown): SentinelProxyTest | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Partial<SentinelProxyTest>;
	const url = asString(input.url).trim();
	if (!url) return undefined;
	return {
		ok: input.ok === true,
		latencyMs:
			typeof input.latencyMs === "number" && Number.isFinite(input.latencyMs) ? Math.trunc(input.latencyMs) : null,
		testedAt: typeof input.testedAt === "number" && Number.isFinite(input.testedAt) ? input.testedAt : Date.now(),
		url,
		error: asString(input.error).trim() || null,
	};
}

function normalizeSubscription(value: unknown): SentinelProxySubscription | null {
	if (!value || typeof value !== "object") return null;
	const input = value as Partial<SentinelProxySubscription>;
	const url = asString(input.url).trim();
	if (!url) return null;
	return {
		url,
		userAgent: subscriptionUserAgent(asString(input.userAgent)),
		updatedAt: typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt) ? input.updatedAt : 0,
		error: asString(input.error).trim() || null,
		intervalHours: normalizeIntervalHours(input.intervalHours),
	};
}

/** A profile is never "off": a profile exists to be used. */
function normalizeProfile(value: unknown): SentinelProxy | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Partial<SentinelProxy>;
	const id = asString(input.id).trim();
	const name = asString(input.name).trim();
	if (!id || !name) return undefined;
	const mode = normalizeProxyMode(input.mode);
	return {
		id,
		name,
		mode: profileMode(mode),
		simple: normalizeSimpleProxy(input.simple),
		subscription: normalizeSubscription(input.subscription),
		wireguard: normalizeWireGuard(input.wireguard),
		openvpn: normalizeOpenVpn(input.openvpn),
		nodes: (Array.isArray(input.nodes) ? input.nodes : [])
			.map(normalizeNode)
			.filter((entry): entry is SentinelProxyNode => entry !== undefined),
		nodeTag: asString(input.nodeTag).trim(),
		skipped: (Array.isArray(input.skipped) ? input.skipped : []).flatMap((entry) => {
			if (!entry || typeof entry !== "object") return [];
			const reason = asString((entry as { reason?: unknown }).reason).trim();
			return reason ? [{ name: asString((entry as { name?: unknown }).name).trim(), reason }] : [];
		}),
		routePrivateDirect: asBool(input.routePrivateDirect, true),
		test: normalizeProxyTest(input.test) ?? null,
		createdAt: typeof input.createdAt === "number" && Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
	};
}

function emptyFile(): ProxiesFile {
	return { proxies: [], defaultId: null, image: DEFAULT_SINGBOX_IMAGE, testUrl: DEFAULT_TEST_URL };
}

/** Read the stored profiles; a missing or malformed file means "none". */
export function readProxies(agentDir: string): ProxiesFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(proxiesPath(agentDir), "utf-8"));
	} catch {
		return emptyFile();
	}
	const input = (parsed ?? {}) as Partial<ProxiesFile>;
	const proxies = (Array.isArray(input.proxies) ? input.proxies : [])
		.map(normalizeProfile)
		.filter((entry): entry is SentinelProxy => entry !== undefined);
	const defaultId =
		typeof input.defaultId === "string" && proxies.some((entry) => entry.id === input.defaultId)
			? input.defaultId
			: null;
	return {
		proxies,
		defaultId,
		image: asString(input.image).trim() || DEFAULT_SINGBOX_IMAGE,
		testUrl: asString(input.testUrl).trim() || DEFAULT_TEST_URL,
	};
}

function writeProxies(agentDir: string, file: ProxiesFile): void {
	const path = proxiesPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
}

/** The view the 代理 page renders. */
export function proxyConfigView(agentDir: string, imagePresent: boolean): SentinelProxyConfigView {
	const file = readProxies(agentDir);
	return {
		proxies: file.proxies,
		defaultId: file.defaultId,
		image: file.image,
		imagePresent,
		testUrl: file.testUrl,
	};
}

function proxyInput(value: SentinelProxyInput): SentinelProxyInput {
	const input = (value ?? {}) as Partial<SentinelProxyInput>;
	return {
		id: asString(input.id).trim() || undefined,
		name: asString(input.name).trim(),
		mode: profileMode(input.mode),
		simple: normalizeSimpleProxy(input.simple),
		wireguard: normalizeWireGuard(input.wireguard),
		openvpn: normalizeOpenVpn(input.openvpn),
		subscriptionUrl: asString(input.subscriptionUrl).trim(),
		subscriptionUserAgent: subscriptionUserAgent(asString(input.subscriptionUserAgent)),
		subscriptionIntervalHours: normalizeIntervalHours(input.subscriptionIntervalHours),
		nodeTag: asString(input.nodeTag).trim(),
		routePrivateDirect: asBool(input.routePrivateDirect, true),
	};
}

/**
 * Create or update one profile. The id is the identity: renaming a profile must
 * not detach it from the projects that use it.
 */
export function saveProxy(
	agentDir: string,
	input: SentinelProxyInput,
): { proxies: ProxiesFile; proxy?: SentinelProxy; error?: string } {
	const file = readProxies(agentDir);
	const normalized = proxyInput(input);
	if (!normalized.name) return { proxies: file, error: t("代理名称不能为空") };
	if (file.proxies.some((entry) => entry.name === normalized.name && entry.id !== normalized.id)) {
		return { proxies: file, error: t("已存在同名代理") };
	}
	const existing = normalized.id ? file.proxies.find((entry) => entry.id === normalized.id) : undefined;
	if (normalized.id && !existing) return { proxies: file, error: t("代理不存在") };
	if (normalized.mode === "subscription" && !normalized.subscriptionUrl) {
		return { proxies: file, error: t("订阅地址不能为空") };
	}
	// The nodes of a subscription are read when it is saved, never later: writing a
	// sidecar must not depend on a provider being reachable. Editing the URL starts
	// a fresh read; leaving it alone keeps the cached nodes and the chosen one.
	const sameUrl = existing?.subscription?.url === normalized.subscriptionUrl;
	const carried = sameUrl ? (existing?.nodes ?? []) : [];
	const nodeTag =
		normalized.nodeTag === AUTO_NODE_TAG || carried.some((node) => node.tag === normalized.nodeTag)
			? normalized.nodeTag
			: (carried[0]?.tag ?? "");
	const proxy: SentinelProxy = {
		id: existing?.id ?? randomUUID(),
		name: normalized.name,
		mode: normalized.mode,
		simple: normalized.simple,
		wireguard: normalized.wireguard,
		openvpn: normalized.openvpn,
		subscription:
			normalized.mode === "subscription"
				? {
						url: normalized.subscriptionUrl,
						userAgent: normalized.subscriptionUserAgent,
						updatedAt: sameUrl ? (existing?.subscription?.updatedAt ?? 0) : 0,
						error: sameUrl ? (existing?.subscription?.error ?? null) : null,
						intervalHours: normalized.subscriptionIntervalHours,
					}
				: null,
		nodes: carried,
		nodeTag,
		skipped: sameUrl ? (existing?.skipped ?? []) : [],
		routePrivateDirect: normalized.routePrivateDirect,
		// The old result describes settings that may no longer be in the profile, so
		// it is dropped rather than shown next to a configuration it never tested.
		test: null,
		createdAt: existing?.createdAt ?? Date.now(),
	};
	const proxies = existing
		? file.proxies.map((entry) => (entry.id === proxy.id ? proxy : entry))
		: [...file.proxies, proxy];
	const next = { ...file, proxies };
	writeProxies(agentDir, next);
	return { proxies: next, proxy };
}

/**
 * Read a subscription profile's nodes and store them.
 *
 * A failed read is stored as the profile's error rather than thrown away: the
 * operator needs to see it next to the URL that produced it, and the previously
 * cached nodes stay usable so a working container is never broken by a provider
 * going down.
 */
export async function refreshProxySubscription(
	agentDir: string,
	id: string,
): Promise<{ proxies: ProxiesFile; proxy?: SentinelProxy; error?: string }> {
	const file = readProxies(agentDir);
	const proxy = file.proxies.find((entry) => entry.id === id);
	if (!proxy) return { proxies: file, error: t("代理不存在") };
	if (proxy.mode !== "subscription" || !proxy.subscription) {
		return { proxies: file, error: t("这个代理不是订阅") };
	}
	const downloaded = await downloadSubscription(proxy.subscription.url, proxy.subscription.userAgent);
	const parsed = downloaded.text === undefined ? undefined : parseSubscription(downloaded.text);
	const nodes = parsed?.nodes.length ? parsed.nodes : proxy.nodes;
	// A read that produced nothing is a failure even when the HTTP call succeeded:
	// an HTML error page is a 200 with no nodes in it.
	const error = downloaded.error ?? (parsed && parsed.nodes.length === 0 ? t("订阅里没有解析出任何节点") : null);
	const updated: SentinelProxy = {
		...proxy,
		nodes,
		skipped: parsed?.skipped ?? proxy.skipped,
		nodeTag:
			proxy.nodeTag === AUTO_NODE_TAG || nodes.some((node) => node.tag === proxy.nodeTag)
				? proxy.nodeTag
				: (nodes[0]?.tag ?? ""),
		subscription: { ...proxy.subscription, updatedAt: error ? proxy.subscription.updatedAt : Date.now(), error },
	};
	const next = { ...file, proxies: file.proxies.map((entry) => (entry.id === id ? updated : entry)) };
	writeProxies(agentDir, next);
	return { proxies: next, proxy: updated, error: error ?? undefined };
}

/**
 * Measure every node of one profile against a URL.
 *
 * The measurement happens through each node's own outbound (see `node-test.ts`);
 * what this function owns is the bookkeeping: remember the URL the operator
 * chose, refuse a second test on the same profile while one is running, and store
 * the results on the nodes so the picker can show them after a reload.
 *
 * `measure` is injectable so the bookkeeping can be tested without Docker.
 */
export async function testProxyNodes(
	agentDir: string,
	id: string,
	url: string,
	measure: typeof measureNodes = measureNodes,
): Promise<{ proxies: ProxiesFile; proxy?: SentinelProxy; error?: string }> {
	const file = readProxies(agentDir);
	const proxy = file.proxies.find((entry) => entry.id === id);
	if (!proxy) return { proxies: file, error: t("代理不存在") };
	if (proxy.mode !== "subscription") return { proxies: file, error: t("这个代理不是订阅") };
	if (proxy.nodes.length === 0) return { proxies: file, error: t("订阅里没有节点，先拉取一次") };
	if (inFlightTests.has(id)) return { proxies: file, error: t("这个订阅正在测速") };

	const testUrl = url.trim() || file.testUrl;
	// Stored even when the test fails: the operator typed it, and the next attempt
	// should use it without typing it again.
	const withUrl = { ...file, testUrl };
	writeProxies(agentDir, withUrl);

	inFlightTests.add(id);
	try {
		const measured = await measure(proxy.nodes, {
			image: withUrl.image,
			agentDir,
			url: testUrl,
		});
		if (measured.error || !measured.latencies) {
			return { proxies: withUrl, proxy, error: measured.error ?? t("测速失败") };
		}
		const testedAt = Date.now();
		const nodes = proxy.nodes.map((node) => ({
			...node,
			latencyMs: measured.latencies?.get(node.tag) ?? null,
			testedAt,
		}));
		const updated: SentinelProxy = { ...proxy, nodes };
		const next = { ...withUrl, proxies: withUrl.proxies.map((entry) => (entry.id === id ? updated : entry)) };
		writeProxies(agentDir, next);
		return { proxies: next, proxy: updated };
	} finally {
		inFlightTests.delete(id);
	}
}

/** Profiles whose nodes are being measured right now. */
const inFlightTests = new Set<string>();

/**
 * Store one profile's connectivity result.
 *
 * The URL stays inside the result rather than replacing the file's shared test URL:
 * a tunnel's target may be an internal address that a subscription's `urltest`
 * must never inherit, and the dialog reopens with the URL it actually tested.
 */
export function recordProxyTest(
	agentDir: string,
	id: string,
	test: SentinelProxyTest,
): { proxies: ProxiesFile; proxy?: SentinelProxy; error?: string } {
	const file = readProxies(agentDir);
	const proxy = file.proxies.find((entry) => entry.id === id);
	if (!proxy) return { proxies: file, error: t("代理不存在") };
	const updated: SentinelProxy = { ...proxy, test };
	const next = {
		...file,
		proxies: file.proxies.map((entry) => (entry.id === id ? updated : entry)),
	};
	writeProxies(agentDir, next);
	return { proxies: next, proxy: updated };
}

/** Which cached node a subscription profile routes through. */
export function setProxyNode(
	agentDir: string,
	id: string,
	nodeTag: string,
): { proxies: ProxiesFile; proxy?: SentinelProxy; error?: string } {
	const file = readProxies(agentDir);
	const proxy = file.proxies.find((entry) => entry.id === id);
	if (!proxy) return { proxies: file, error: t("代理不存在") };
	if (proxy.mode !== "subscription") return { proxies: file, error: t("这个代理不是订阅") };
	if (proxy.nodes.length === 0) return { proxies: file, error: t("订阅里没有节点，先拉取一次") };
	// Auto is a generated selection policy, not one of the cached subscription nodes.
	if (nodeTag !== AUTO_NODE_TAG && !proxy.nodes.some((node) => node.tag === nodeTag)) {
		return { proxies: file, error: t("节点不存在") };
	}
	const next = { ...file, proxies: file.proxies.map((entry) => (entry.id === id ? { ...entry, nodeTag } : entry)) };
	writeProxies(agentDir, next);
	return { proxies: next, proxy: next.proxies.find((entry) => entry.id === id) };
}

/**
 * Remove one profile. Projects that pointed at it fall back to the default rather
 * than to a dangling id: the profile is gone, so "this project's node" is gone
 * with it, and keeping the id would leave the project silently proxied by nothing.
 */
export function deleteProxy(
	agentDir: string,
	id: string,
): { proxies: ProxiesFile; error?: string; projectIds: string[] } {
	const file = readProxies(agentDir);
	if (!file.proxies.some((entry) => entry.id === id)) return { proxies: file, error: t("代理不存在"), projectIds: [] };
	const next = {
		...file,
		proxies: file.proxies.filter((entry) => entry.id !== id),
		defaultId: file.defaultId === id ? null : file.defaultId,
	};
	writeProxies(agentDir, next);
	return { proxies: next, projectIds: [] };
}

export function setDefaultProxy(agentDir: string, id: string | null): { proxies: ProxiesFile; error?: string } {
	const file = readProxies(agentDir);
	if (id !== null && !file.proxies.some((entry) => entry.id === id)) {
		return { proxies: file, error: t("代理不存在") };
	}
	const next = { ...file, defaultId: id };
	writeProxies(agentDir, next);
	return { proxies: next };
}

export function setProxyImage(agentDir: string, image: string): ProxiesFile {
	const file = readProxies(agentDir);
	const next = { ...file, image: image.trim() || DEFAULT_SINGBOX_IMAGE };
	writeProxies(agentDir, next);
	return next;
}

/**
 * The settings a project's container is created with, or null when it runs
 * without a proxy.
 *
 * `proxyId` absent follows the default profile, `NO_PROXY` means the operator
 * turned the proxy off for this project on purpose, and an id names a profile.
 * The image never comes from a profile: it is one thing to keep up to date on a
 * machine, not one per node.
 */
export function resolveProjectProxy(
	agentDir: string,
	proxyId: string | null | undefined,
): SentinelProxySettings | null {
	const file = readProxies(agentDir);
	const wanted = proxyId === undefined ? file.defaultId : proxyId;
	if (wanted === NO_PROXY) return null;
	const profile = file.proxies.find((entry) => entry.id === wanted);
	if (!profile) return null;
	return {
		mode: profile.mode,
		simple: profile.simple,
		nodes: profile.nodes,
		nodeTag: profile.nodeTag,
		wireguard: profile.wireguard,
		openvpn: profile.openvpn,
		image: file.image,
		testUrl: file.testUrl,
		routePrivateDirect: profile.routePrivateDirect,
	};
}

/** Whether a project container should be created on the sidecar's network. */
export function proxyEnabled(settings: SentinelProxySettings | null): settings is SentinelProxySettings {
	return settings !== null && settings.mode !== "off";
}

/**
 * Whether a mode is a tunnel rather than a proxy.
 *
 * A tunnel runs its own sidecar instead of sing-box, has one exit and no nodes, and
 * reaches the container as a real interface with real routes rather than as an
 * outbound. Everything the console does per mode — which sidecar to start, which
 * generated file a project is compared against, whether the sing-box image is needed
 * at all — keys off this.
 */
export function isTunnelMode(mode: SentinelProxySettings["mode"]): boolean {
	return mode === "wireguard" || mode === "openvpn";
}

interface Outbound {
	type: string;
	tag?: string;
	[key: string]: unknown;
}

/**
 * The operator's outbounds, with the tag the route section needs.
 *
 * `json` mode accepts one outbound object or an array of them, because a single
 * node sometimes needs a companion outbound (a `selector`, or a `direct` with a
 * bind address) to mean anything. The route goes through the one tagged `proxy`,
 * or through the last one when none is; a tag the operator chose is kept.
 */
export function proxyOutbounds(
	settings: SentinelProxySettings,
): { outbounds: Outbound[]; tag: string } | { error: string } {
	if (settings.mode === "wireguard") {
		return { error: t("WireGuard 档案不走 sing-box，不能生成出站配置") };
	}
	if (settings.mode === "openvpn") {
		return { error: t("OpenVPN 档案不走 sing-box，不能生成出站配置") };
	}
	if (settings.mode === "subscription") {
		if (settings.nodes.length === 0) return { error: t("订阅里没有可用节点，先在「代理」页拉取一次") };
		const tags = settings.nodes.map((node) => node.tag);
		if (new Set(tags).size !== tags.length) return { error: t("订阅里有重名节点，请重新拉取一次") };
		if (tags.includes("direct") || tags.includes(PROXY_OUTBOUND_TAG)) {
			return { error: t("订阅里有节点占用了 proxy / direct 这两个 tag，请重新拉取一次") };
		}
		const chosen =
			settings.nodeTag === AUTO_NODE_TAG || !tags.includes(settings.nodeTag) ? AUTO_NODE_TAG : settings.nodeTag;
		// Every node goes into the configuration and the route goes through a
		// selector: which node is used is then a property of the selector, not of the
		// route, and the sidecar's own state machine owns the choice. `auto` sits in
		// front of the fixed nodes so "fastest healthy" is one more choice rather
		// than a separate mode.
		const auto: Outbound = {
			type: "urltest",
			tag: AUTO_NODE_TAG,
			outbounds: tags,
			url: settings.testUrl,
			interval: "3m",
			tolerance: 50,
		};
		const selector: Outbound = {
			type: "selector",
			tag: PROXY_OUTBOUND_TAG,
			outbounds: [AUTO_NODE_TAG, ...tags],
			default: chosen,
		};
		return {
			outbounds: [...settings.nodes.map((node) => node.outbound as Outbound), auto, selector],
			tag: PROXY_OUTBOUND_TAG,
		};
	}
	if (settings.mode === "simple") {
		const { type, server, port, username, password, tls } = settings.simple;
		if (!server) return { error: t("代理服务器地址为空") };
		if (port <= 0) return { error: t("代理端口未填写或不在 1-65535 之间") };
		const outbound: Outbound = {
			type: type === "http" ? "http" : "socks",
			tag: PROXY_OUTBOUND_TAG,
			server,
			server_port: port,
		};
		if (type === "socks5") outbound.version = "5";
		if (username) outbound.username = username;
		if (password) outbound.password = password;
		if (tls && type === "http") outbound.tls = { enabled: true };
		return { outbounds: [outbound], tag: PROXY_OUTBOUND_TAG };
	}
	return { error: t("这个代理没有配置出口") };
}

/**
 * The full sing-box configuration for one project's sidecar.
 *
 * Three decisions worth keeping:
 *
 * - DNS stays direct. The container's resolver is Docker's embedded DNS, which
 *   lives in this same namespace; sending those queries through a remote exit
 *   would make every name unresolvable. The `protocol: "dns"` rule only fires when
 *   the resolver sits outside the namespace (Docker Desktop answers on a VM-local
 *   address), and then direct is still the only answer that works.
 * - Private destinations stay direct by default, so a LAN engagement keeps its
 *   scanners pointed at the LAN instead of at the exit node.
 * - `strict_route` stays off. Turning it on drops traffic that does not match the
 *   tunnel's own routes, which is exactly the traffic above.
 */
export function buildSingboxConfig(
	settings: SentinelProxySettings,
	api?: { port: number; secret: string },
): { config?: string; error?: string } {
	const resolved = proxyOutbounds(settings);
	if ("error" in resolved) return { error: resolved.error };
	const rules: Array<Record<string, unknown>> = [{ action: "sniff" }, { protocol: "dns", outbound: "direct" }];
	if (settings.routePrivateDirect) rules.push({ ip_is_private: true, outbound: "direct" });
	const config = {
		log: { level: "warn", timestamp: true },
		// The control surface used to switch nodes without a restart. Bound inside
		// the sidecar's namespace, reachable from the host through a published
		// loopback port, and locked with a secret because the project container
		// shares that namespace and could otherwise reach it.
		...(api
			? {
					experimental: {
						clash_api: {
							external_controller: `0.0.0.0:${api.port}`,
							secret: api.secret,
						},
					},
				}
			: {}),
		inbounds: [
			{
				type: "tun",
				tag: "tun-in",
				interface_name: "tun0",
				address: [SINGBOX_TUN_ADDRESS],
				mtu: 1400,
				auto_route: true,
				strict_route: false,
				stack: "system",
			},
		],
		outbounds: [...resolved.outbounds, { type: "direct", tag: "direct" }],
		route: { auto_detect_interface: true, rules, final: resolved.tag },
	};
	return { config: `${JSON.stringify(config, null, "\t")}\n` };
}

/**
 * A one-line description of where the traffic goes, for the 代理 page and the
 * project rows. Never includes the password.
 */
export function describeProxy(
	proxy: Pick<SentinelProxySettings, "mode" | "simple" | "nodes" | "nodeTag" | "wireguard" | "openvpn"> | null,
): string {
	if (!proxy) return t("关闭");
	if (proxy.mode === "wireguard") {
		const endpoint = /^\s*endpoint\s*=\s*(.+)$/im.exec(proxy.wireguard.config)?.[1]?.trim();
		return endpoint ? `WireGuard ${endpoint}` : t("未配置");
	}
	if (proxy.mode === "openvpn") {
		return describeOpenVpn(proxy.openvpn);
	}
	if (proxy.mode === "simple") {
		const { type, server, port } = proxy.simple;
		if (!server || port <= 0) return t("未配置");
		return `${type === "http" ? "HTTP" : "SOCKS5"} ${server}:${port}`;
	}
	if (proxy.mode === "subscription") {
		if (proxy.nodes.length === 0) return t("订阅未拉取");
		const name =
			proxy.nodeTag === AUTO_NODE_TAG
				? t("自动（按延迟择优）")
				: ((proxy.nodes.find((node) => node.tag === proxy.nodeTag) ?? proxy.nodes[0])?.name ?? "");
		return t("订阅 {count} 个节点 · 当前：{name}", { count: proxy.nodes.length, name });
	}
	return t("未配置");
}
