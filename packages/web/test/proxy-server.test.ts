/**
 * The 代理 page and per-project proxy choices, over the console's protocol.
 *
 * The page is where a node is described once and every project points at it, so
 * what is pinned here is the part a unit test cannot see: that the whole config
 * comes back after each change, that a project's row carries the profile it
 * resolved to, and that deleting a profile does not leave a project pointing at
 * nothing.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import type {
	SentinelClientMessage,
	SentinelProjectInfo,
	SentinelProxyConfigView,
	SentinelProxyInput,
	SentinelServerMessage,
} from "../src/protocol.ts";
import {
	AUTO_NODE_TAG,
	buildSingboxConfig,
	describeProxy,
	readProxies,
	resolveProjectProxy,
	setProxyImage,
} from "../src/proxy.ts";
import { startSentinelServer } from "../src/server.ts";
import { CHINA_SOURCES, readSources } from "../src/sources.ts";
import { type FakeDocker, installFakeDocker } from "./fake-docker.ts";

let tempRoot = "";
let agentDir = "";
let fakeDocker: FakeDocker | undefined;
let closeServer: (() => void) | undefined;
let ws: WebSocket | undefined;
/** Serves a subscription so the fetch path is exercised without the internet. */
let subscriptionServer: Server | undefined;
let subscriptionUrl = "";
/** Flipped by a test to simulate a provider that went down after a good read. */
let subscriptionDown = false;
let subscriptionEmpty = false;

const incoming: SentinelServerMessage[] = [];
const waiters: Array<{
	predicate: (message: SentinelServerMessage) => boolean;
	resolve: (message: SentinelServerMessage) => void;
}> = [];

function dispatch(message: SentinelServerMessage): void {
	const index = waiters.findIndex((waiter) => waiter.predicate(message));
	if (index >= 0) {
		const [waiter] = waiters.splice(index, 1);
		waiter.resolve(message);
		return;
	}
	incoming.push(message);
}

function waitFor(
	predicate: (message: SentinelServerMessage) => boolean,
	timeoutMs = 20000,
): Promise<SentinelServerMessage> {
	const buffered = incoming.findIndex(predicate);
	if (buffered >= 0) {
		const [message] = incoming.splice(buffered, 1);
		return Promise.resolve(message);
	}
	return new Promise((resolve, reject) => {
		const waiter = { predicate, resolve: () => {} } as (typeof waiters)[number];
		const timer = setTimeout(() => {
			const position = waiters.indexOf(waiter);
			if (position >= 0) waiters.splice(position, 1);
			reject(new Error(`超时。已收到：${incoming.map((message) => message.type).join(", ")}`));
		}, timeoutMs);
		waiter.resolve = (message) => {
			clearTimeout(timer);
			resolve(message);
		};
		waiters.push(waiter);
	});
}

function send(message: SentinelClientMessage): void {
	ws?.send(JSON.stringify(message));
}

/**
 * Drop broadcast messages of one type that are still buffered.
 *
 * A mutation answers the requester and then broadcasts the new state to everyone;
 * a message from the previous step can therefore still be in the buffer, and
 * reading it back as the result of the next one is how these tests go flaky.
 */
function drain(type: SentinelServerMessage["type"]): void {
	for (let index = incoming.length - 1; index >= 0; index -= 1) {
		if (incoming[index]?.type === type) incoming.splice(index, 1);
	}
}

/** The config broadcast a request just produced. */
async function config(): Promise<SentinelProxyConfigView & { error?: string }> {
	const found = (await waitFor((entry) => entry.type === "proxy_config" && !entry.push)) as {
		config: SentinelProxyConfigView;
		error?: string;
	};
	return { ...found.config, ...(found.error === undefined ? {} : { error: found.error }) };
}

/** Save one profile and read the config that came back. */
async function save(proxy: SentinelProxyInput): Promise<SentinelProxyConfigView & { error?: string }> {
	drain("proxy_config");
	send({ type: "save_proxy", proxy });
	return await config();
}

function input(overrides: Partial<SentinelProxyInput> = {}): SentinelProxyInput {
	return {
		name: "香港节点",
		mode: "simple",
		simple: { type: "socks5", server: "1.2.3.4", port: 1080, username: "", password: "", tls: false },
		wireguard: { config: "", dns: "", killSwitch: true },
		openvpn: { config: "", dns: "", username: "", password: "", killSwitch: true },
		subscriptionUrl: "",
		subscriptionUserAgent: "",
		subscriptionIntervalHours: 0,
		nodeTag: "",
		routePrivateDirect: true,
		...overrides,
	};
}

/** Save a profile and return its id, failing loudly when the server refuses it. */
async function addProxy(overrides: Partial<SentinelProxyInput> = {}): Promise<string> {
	const saved = await save(input(overrides));
	const name = overrides.name ?? "香港节点";
	const profile = saved.proxies.find((entry) => entry.name === name);
	if (!profile) throw new Error(`代理未保存：${saved.error ?? "无错误信息"}`);
	return profile.id;
}

/** One project's row, read from a list asked for after the change. */
async function project(id: string): Promise<SentinelProjectInfo> {
	drain("projects");
	send({ type: "list_projects" });
	const message = (await waitFor(
		(entry) => entry.type === "projects" && entry.projects.some((row) => row.id === id),
	)) as { projects: SentinelProjectInfo[] };
	const found = message.projects.find((entry) => entry.id === id);
	if (!found) throw new Error("项目不在列表中");
	return found;
}

async function addProject(name: string, proxyId?: string | null, proxyNode?: string): Promise<SentinelProjectInfo> {
	drain("projects");
	send({ type: "add_project", name, proxyId, proxyNode });
	const message = (await waitFor(
		(entry) => entry.type === "projects" && entry.projects.some((row) => row.name === name),
	)) as { projects: SentinelProjectInfo[] };
	const created = message.projects.find((entry) => entry.name === name);
	if (!created) throw new Error("项目未创建");
	return created;
}

beforeAll(async () => {
	tempRoot = mkdtempSync(join(tmpdir(), "sentinel-proxy-page-"));
	// Two nodes in the envelope providers actually use: base64 of a link list.
	const links = [
		`ss://${Buffer.from("aes-256-gcm:pw").toString("base64url")}@1.1.1.1:8388#%E9%A6%99%E6%B8%AF`,
		"trojan://pw@2.2.2.2:443#tokyo",
	].join("\n");
	subscriptionServer = createServer((request, response) => {
		if (subscriptionDown) {
			response.writeHead(500, { "content-type": "text/plain" });
			response.end("gone");
			return;
		}
		if (subscriptionEmpty || request.url?.startsWith("/broken")) {
			response.writeHead(200, { "content-type": "text/html" });
			response.end("<html>token expired</html>");
			return;
		}
		response.writeHead(200, { "content-type": "text/plain" });
		response.end(Buffer.from(links, "utf-8").toString("base64"));
	});
	await new Promise<void>((resolve) => subscriptionServer?.listen(0, "127.0.0.1", () => resolve()));
	const address = subscriptionServer.address();
	if (!address || typeof address === "string") throw new Error("订阅服务器未启动");
	subscriptionUrl = `http://127.0.0.1:${address.port}/sub`;
	agentDir = join(tempRoot, "agent");
	mkdirSync(agentDir, { recursive: true });
	fakeDocker = installFakeDocker(tempRoot, join(tempRoot, "projects", "demo"), join(tempRoot, "docker.log"));
	const binary = join(fakeDocker.dir, "docker");
	writeFileSync(
		binary,
		readFileSync(binary, "utf-8").replace(
			"\timage|build) exit 0 ;;",
			`\timage)
		case "$*" in *sing-box*) [ -f "$state_dir/.proxy-image-missing" ] && exit 1 ;; esac
		exit 0 ;;
	pull)
		echo "Downloading proxy layer 42%"
		if [ -f "$state_dir/.proxy-pull-error" ]; then echo "registry unavailable" >&2; exit 1; fi
		rm -f "$state_dir/.proxy-image-missing"
		exit 0 ;;
	build) exit 0 ;;`,
		),
	);
	const started = await startSentinelServer({
		cwd: join(tempRoot, "workspace"),
		agentDir,
		host: "127.0.0.1",
		port: 0,
		auth: false,
	});
	closeServer = started.close;
	ws = new WebSocket(started.url.replace("http://", "ws://").concat("/ws"));
	ws.on("message", (data) => dispatch(JSON.parse(String(data)) as SentinelServerMessage));
	await new Promise<void>((resolve, reject) => {
		ws?.once("open", () => resolve());
		ws?.once("error", (error) => reject(error));
	});
	// The console pushes the config on connect, and that push is asynchronous (it
	// resolves the image's presence first), so wait for it before clearing the
	// buffer — otherwise it would land later and read as a request's answer.
	await waitFor((message) => message.type === "proxy_config");
	// Bootstrap messages that arrived while connecting are not evidence for
	// anything later: start every test from an empty buffer.
	incoming.length = 0;
}, 40000);

afterAll(() => {
	ws?.close();
	closeServer?.();
	subscriptionServer?.close();
	fakeDocker?.restore();
	rmSync(tempRoot, { recursive: true, force: true });
});

test("the page asks for the config and gets the image state with it", async () => {
	drain("proxy_config");
	send({ type: "get_proxy_config" });
	const view = await config();
	expect(view.proxies).toEqual([]);
	expect(view.defaultId).toBeNull();
	// The fake answers `docker image inspect` successfully, so the pinned image
	// counts as present.
	expect(view.image).toContain("sing-box");
	expect(view.imagePresent).toBe(true);
});

test("a saved profile comes back with its id, and a broken one is refused", async () => {
	const id = await addProxy();
	expect(id).not.toBe("");

	// A profile whose address is empty cannot build a configuration; the save is
	// refused with the field that is missing, not with a broken sidecar later.
	const broken = await save(
		input({
			name: "坏节点",
			simple: { type: "socks5", server: "", port: 0, username: "", password: "", tls: false },
			wireguard: { config: "", dns: "", killSwitch: true },
			openvpn: { config: "", dns: "", username: "", password: "", killSwitch: true },
		}),
	);
	expect(broken.error).toContain("地址");
	// The profile stays saved — the point of the error is to say what to fix.
	expect(broken.proxies.map((entry) => entry.name)).toContain("坏节点");

	// Names are the handle the operator uses, so they are unique.
	expect((await save(input({ name: "坏节点" }))).error).toContain("同名");
});

test("an OpenVPN profile is saved, validated, and read back like any other", async () => {
	const pasted = `client
dev tun
remote vpn.example.com 1194
<ca>
-----BEGIN CERTIFICATE-----
MIIB
-----END CERTIFICATE-----
</ca>
`;
	// The console checks the pasted file where it is saved, not at the first
	// container rebuild: a configuration it cannot mount is refused with the reason.
	const broken = await save(
		input({
			name: "缺证书",
			mode: "openvpn",
			openvpn: {
				config: pasted.replace(/<ca>[\s\S]*?<\/ca>\n/, ""),
				dns: "",
				username: "",
				password: "",
				killSwitch: true,
			},
		}),
	);
	expect(broken.error).toContain("ca");

	const saved = await save(
		input({
			name: "实验室 OpenVPN",
			mode: "openvpn",
			openvpn: { config: pasted, dns: "", username: "", password: "", killSwitch: true },
		}),
	);
	expect(saved.error).toBeUndefined();
	const stored = saved.proxies.find((entry) => entry.name === "实验室 OpenVPN");
	expect(stored?.mode).toBe("openvpn");
	// The pasted configuration survives a round trip through the file.
	expect(stored?.openvpn.config).toContain("remote vpn.example.com 1194");
});

test("the default is one profile, and a new project with no choice follows it", async () => {
	const id = await addProxy({ name: "默认节点" });
	drain("proxy_config");
	send({ type: "set_default_proxy", id });
	expect((await config()).defaultId).toBe(id);

	const following = await addProject("跟随默认");
	expect(following.proxyId).toBeUndefined();
	expect(following.proxyName).toBe("默认节点");

	// Turning the proxy off for a project is a choice, not the absence of one.
	send({ type: "set_project_proxy", projectId: following.id, proxyId: null });
	await waitFor((entry) => entry.type === "project_proxy_saved" && entry.projectId === following.id);
	const direct = await project(following.id);
	expect(direct.proxyId).toBeNull();
	expect(direct.proxyName).toBeNull();
});

test("a project created with a named profile reports it, and can switch later", async () => {
	const first = await addProxy({ name: "节点一" });
	const second = await addProxy({ name: "节点二" });
	const created = await addProject("选代理的项目", first);
	expect(created.proxyId).toBe(first);
	expect(created.proxyName).toBe("节点一");

	send({ type: "set_project_proxy", projectId: created.id, proxyId: second });
	await waitFor((entry) => entry.type === "project_proxy_saved" && entry.projectId === created.id);
	expect((await project(created.id)).proxyName).toBe("节点二");

	// Back to the default: the stored choice is dropped, not frozen to a profile.
	send({ type: "set_project_proxy", projectId: created.id, proxyId: undefined });
	await waitFor((entry) => entry.type === "project_proxy_saved" && entry.projectId === created.id);
	expect((await project(created.id)).proxyId).toBeUndefined();
});

test("saving a subscription fetches its nodes, and the chosen one is stored", async () => {
	const saved = await save(input({ name: "机场", mode: "subscription", subscriptionUrl }));
	expect(saved.error).toBeUndefined();
	const profile = saved.proxies.find((entry) => entry.name === "机场");
	if (!profile) throw new Error("订阅未保存");
	expect(profile.nodes.map((node) => node.name)).toEqual(["香港", "tokyo"]);
	// The first node is chosen when nothing else is.
	expect(profile.nodeTag).toBe("香港");
	expect(profile.subscription?.updatedAt).toBeGreaterThan(0);
	expect(profile.subscription?.error).toBeNull();

	// Picking another node is its own message, and it sticks.
	drain("proxy_config");
	send({ type: "set_proxy_node", id: profile.id, nodeTag: "tokyo" });
	const switched = await config();
	expect(switched.proxies.find((entry) => entry.id === profile.id)?.nodeTag).toBe("tokyo");
});

test("a subscription that returns nothing usable is an error, not an empty profile", async () => {
	const saved = await save(
		input({ name: "坏订阅", mode: "subscription", subscriptionUrl: `${subscriptionUrl.replace("/sub", "/broken")}` }),
	);
	expect(saved.error).toContain("没有解析出任何节点");
	const profile = saved.proxies.find((entry) => entry.name === "坏订阅");
	// The profile is kept so the operator can fix the URL, with the reason on it.
	expect(profile?.nodes).toEqual([]);
	expect(profile?.subscription?.error).toContain("没有解析出任何节点");
});

test("a profile can select auto, persist it, and generate an automatic selector", async () => {
	const id = await addProxy({ name: "automatic-profile", mode: "subscription", subscriptionUrl });
	drain("proxy_config");
	send({ type: "set_proxy_node", id, nodeTag: AUTO_NODE_TAG });
	const selected = await config();
	expect(selected.error).toBeUndefined();
	expect(selected.proxies.find((entry) => entry.id === id)?.nodeTag).toBe(AUTO_NODE_TAG);
	expect(readProxies(agentDir).proxies.find((entry) => entry.id === id)?.nodeTag).toBe(AUTO_NODE_TAG);
	const settings = resolveProjectProxy(agentDir, id);
	if (!settings) throw new Error("代理未解析");
	expect(describeProxy(settings)).toContain("自动（按延迟择优）");
	const built = buildSingboxConfig(settings);
	expect(built.error).toBeUndefined();
	const generated = JSON.parse(built.config ?? "{}") as { outbounds: Array<Record<string, unknown>> };
	expect(generated.outbounds.find((entry) => entry.type === "selector")).toMatchObject({ default: AUTO_NODE_TAG });
	expect(generated.outbounds.find((entry) => entry.type === "urltest")).toMatchObject({
		tag: AUTO_NODE_TAG,
		outbounds: ["香港", "tokyo"],
	});

	// Invalid fixed nodes still fail without overwriting the automatic choice.
	drain("proxy_config");
	send({ type: "set_proxy_node", id, nodeTag: "missing-node" });
	const refused = await config();
	expect(refused.error).toContain("节点不存在");
	expect(refused.proxies.find((entry) => entry.id === id)?.nodeTag).toBe(AUTO_NODE_TAG);

	drain("proxy_config");
	send({ type: "set_proxy_node", id, nodeTag: "tokyo" });
	const fixed = await config();
	expect(fixed.error).toBeUndefined();
	expect(fixed.proxies.find((entry) => entry.id === id)?.nodeTag).toBe("tokyo");
});

test("a profile preserves auto across edits and successful or failed subscription refreshes", async () => {
	const original = input({ name: "automatic-refresh", mode: "subscription", subscriptionUrl, nodeTag: AUTO_NODE_TAG });
	const saved = await save(original);
	expect(saved.error).toBeUndefined();
	const profile = saved.proxies.find((entry) => entry.name === original.name);
	if (!profile) throw new Error("订阅未保存");
	expect(profile.nodeTag).toBe(AUTO_NODE_TAG);
	const edited = await save({ ...original, id: profile.id, routePrivateDirect: false });
	expect(edited.error).toBeUndefined();
	expect(edited.proxies.find((entry) => entry.id === profile.id)?.nodeTag).toBe(AUTO_NODE_TAG);

	drain("proxy_config");
	send({ type: "refresh_proxy_subscription", id: profile.id });
	const refreshed = await config();
	expect(refreshed.error).toBeUndefined();
	expect(refreshed.proxies.find((entry) => entry.id === profile.id)?.nodeTag).toBe(AUTO_NODE_TAG);

	subscriptionEmpty = true;
	try {
		drain("proxy_config");
		send({ type: "refresh_proxy_subscription", id: profile.id });
		const failed = await config();
		expect(failed.error).toContain("没有解析出任何节点");
		expect(failed.proxies.find((entry) => entry.id === profile.id)?.nodeTag).toBe(AUTO_NODE_TAG);
	} finally {
		subscriptionEmpty = false;
	}
});

test("a profile without subscription nodes cannot select auto", async () => {
	const id = await addProxy({ name: "simple-no-auto" });
	drain("proxy_config");
	send({ type: "set_proxy_node", id, nodeTag: AUTO_NODE_TAG });
	const simple = await config();
	expect(simple.error).toBeTruthy();
	expect(simple.proxies.find((entry) => entry.id === id)?.nodeTag).not.toBe(AUTO_NODE_TAG);

	const empty = await save(
		input({
			name: "empty-no-auto",
			mode: "subscription",
			subscriptionUrl: subscriptionUrl.replace("/sub", "/broken"),
		}),
	);
	const profile = empty.proxies.find((entry) => entry.name === "empty-no-auto");
	if (!profile) throw new Error("订阅未保存");
	drain("proxy_config");
	send({ type: "set_proxy_node", id: profile.id, nodeTag: AUTO_NODE_TAG });
	const refused = await config();
	expect(refused.error).toBeTruthy();
	expect(refused.proxies.find((entry) => entry.id === profile.id)?.nodeTag).not.toBe(AUTO_NODE_TAG);
});

test("a failed refresh keeps the nodes that already worked", async () => {
	const saved = await save(input({ name: "会掉线的机场", mode: "subscription", subscriptionUrl }));
	const profile = saved.proxies.find((entry) => entry.name === "会掉线的机场");
	if (!profile) throw new Error("订阅未保存");
	expect(profile.nodes).toHaveLength(2);
	const readAt = profile.subscription?.updatedAt ?? 0;

	// The provider goes down; the profile keeps its nodes, because a container that
	// already works must not break because a subscription is unreachable.
	subscriptionDown = true;
	drain("proxy_config");
	send({ type: "refresh_proxy_subscription", id: profile.id });
	const refreshed = await config();
	subscriptionDown = false;
	const after = refreshed.proxies.find((entry) => entry.id === profile.id);
	expect(refreshed.error).toBeTruthy();
	expect(after?.nodes).toHaveLength(2);
	expect(after?.subscription?.error).toBeTruthy();
	// A failed read is not a successful one: the timestamp does not move.
	expect(after?.subscription?.updatedAt).toBe(readAt);

	// And once it is back, the error clears.
	drain("proxy_config");
	send({ type: "refresh_proxy_subscription", id: profile.id });
	const back = await config();
	expect(back.proxies.find((entry) => entry.id === profile.id)?.subscription?.error).toBeNull();
});

test("an HTTP 200 error page preserves cached subscription nodes", async () => {
	const saved = await save(input({ name: "empty-refresh", mode: "subscription", subscriptionUrl }));
	const profile = saved.proxies.find((entry) => entry.name === "empty-refresh");
	if (!profile) throw new Error("订阅未保存");
	subscriptionEmpty = true;
	try {
		drain("proxy_config");
		send({ type: "refresh_proxy_subscription", id: profile.id });
		const refreshed = await config();
		expect(refreshed.error).toContain("没有解析出任何节点");
		const after = refreshed.proxies.find((entry) => entry.id === profile.id);
		expect(after?.nodes).toEqual(profile.nodes);
		expect(after?.subscription?.updatedAt).toBe(profile.subscription?.updatedAt);
	} finally {
		subscriptionEmpty = false;
	}
});

test("a project can pin one node of a subscription, and only of a subscription", async () => {
	const saved = await save(input({ name: "可钉节点的机场", mode: "subscription", subscriptionUrl }));
	const profile = saved.proxies.find((entry) => entry.name === "可钉节点的机场");
	if (!profile) throw new Error("订阅未保存");
	const created = await addProject("钉节点的项目", profile.id, "tokyo");
	// The row reports the node that will actually be used, not just the profile.
	expect(created.proxyNode).toBe("tokyo");
	expect(created.proxyNodeName).toBe("tokyo");
	// And the pin reaches the configuration the sidecar will read: the selector
	// defaults to it, so the container leaves through that node and not the
	// profile's own choice.
	const generated = JSON.parse(readFileSync(join(agentDir, "proxy", `${created.id}.json`), "utf-8")) as {
		outbounds: Array<Record<string, unknown>>;
	};
	expect(generated.outbounds.find((entry) => entry.type === "selector")).toMatchObject({
		tag: "proxy",
		default: "tokyo",
	});

	// Switching back to the profile's own choice drops the pin.
	send({ type: "set_project_proxy", projectId: created.id, proxyId: profile.id });
	await waitFor((entry) => entry.type === "project_proxy_saved" && entry.projectId === created.id);
	const following = await project(created.id);
	expect(following.proxyNode).toBeUndefined();
	// The profile's own node is the first one, so that is what the row shows.
	expect(following.proxyNodeName).toBe("香港");

	// A node that is not in the subscription is refused rather than stored.
	send({ type: "set_project_proxy", projectId: created.id, proxyId: profile.id, proxyNode: "不存在的节点" });
	const refused = await waitFor((entry) => entry.type === "error");
	expect((refused as { message: string }).message).toContain("节点不存在");

	// Turning the proxy off clears the pin as well: a node without a profile is
	// not a state anything can render.
	send({ type: "set_project_proxy", projectId: created.id, proxyId: null });
	await waitFor((entry) => entry.type === "project_proxy_saved" && entry.projectId === created.id);
	const off = await project(created.id);
	expect(off.proxyId).toBeNull();
	expect(off.proxyNode).toBeUndefined();
});

test("switching a node records it even when no sidecar is running", async () => {
	const saved = await save(input({ name: "可切换的机场", mode: "subscription", subscriptionUrl }));
	const profile = saved.proxies.find((entry) => entry.name === "可切换的机场");
	if (!profile) throw new Error("订阅未保存");
	const created = await addProject("切换节点的项目", profile.id);

	// A deliberately stopped project records the choice without waking its pair.
	send({ type: "stop_project", id: created.id });
	await waitFor(
		(entry) => entry.type === "projects" && entry.projects.some((row) => row.id === created.id && row.manualStop),
	);
	drain("project_proxy_saved");
	send({ type: "switch_project_node", projectId: created.id, nodeTag: "tokyo" });
	const answered = await waitFor((entry) => entry.type === "project_proxy_saved" && entry.projectId === created.id);
	expect((answered as { applied?: boolean }).applied).toBe(false);
	expect((await project(created.id)).proxyNode).toBe("tokyo");

	// Auto is a choice like any other, and it is not a node of the subscription.
	drain("project_proxy_saved");
	send({ type: "switch_project_node", projectId: created.id, nodeTag: "auto" });
	await waitFor((entry) => entry.type === "project_proxy_saved" && entry.projectId === created.id);
	expect((await project(created.id)).proxyNode).toBe("auto");
});

test("deleting a profile returns the projects that used it to the default", async () => {
	const doomed = await addProxy({ name: "要删的节点" });
	const created = await addProject("用它建的项目", doomed);
	expect(created.proxyName).toBe("要删的节点");

	drain("proxy_config");
	send({ type: "delete_proxy", id: doomed });
	const after = await config();
	expect(after.proxies.map((entry) => entry.name)).not.toContain("要删的节点");
	// A dangling id would leave the project proxied by nothing at all; falling back
	// to the default keeps the intent, and the row shows which profile that is now.
	const row = await project(created.id);
	expect(row.proxyId).toBeUndefined();
	expect(row.proxyName).toBe("默认节点");
});

test("saving installs a missing image before validation and does not pull an existing image", async () => {
	if (!fakeDocker) throw new Error("Fake Docker not installed");
	mkdirSync(fakeDocker.stateDir, { recursive: true });
	writeFileSync(join(fakeDocker.stateDir, ".proxy-image-missing"), "");
	writeFileSync(join(tempRoot, "docker.log"), "");
	drain("singbox_pull_started");
	drain("singbox_pull_result");
	drain("singbox_pull_log");
	drain("image_build_log");
	const saved = await save(input({ name: "自动安装镜像" }));
	expect(saved.error).toBeUndefined();
	expect(saved.imagePresent).toBe(true);
	await waitFor((entry) => entry.type === "singbox_pull_started");
	await waitFor((entry) => entry.type === "singbox_pull_result" && entry.ok);
	await waitFor((entry) => entry.type === "singbox_pull_log" && entry.line.includes("Downloading proxy layer 42%"));
	expect(incoming.some((entry) => entry.type === "image_build_log")).toBe(false);
	drain("environment");
	send({ type: "get_environment" });
	const snapshot = await waitFor((entry) => entry.type === "environment");
	if (snapshot.type !== "environment") throw new Error("Missing environment snapshot");
	expect(snapshot.proxyPull?.pulling).toBe(false);
	expect(snapshot.proxyPull?.log.join("\n")).toContain("Downloading proxy layer 42%");
	const log = readFileSync(join(tempRoot, "docker.log"), "utf-8");
	expect(log).toContain(`pull ${saved.image}`);
	expect(log.indexOf(`pull ${saved.image}`)).toBeLessThan(log.indexOf(" check -C "));

	writeFileSync(join(tempRoot, "docker.log"), "");
	expect((await save(input({ name: "镜像已存在" }))).error).toBeUndefined();
	expect(readFileSync(join(tempRoot, "docker.log"), "utf-8")).not.toMatch(/^pull /m);
});

test("image pull failure is returned on save and does not validate or apply a gateway", async () => {
	if (!fakeDocker) throw new Error("Fake Docker not installed");
	writeFileSync(join(fakeDocker.stateDir, ".proxy-image-missing"), "");
	writeFileSync(join(fakeDocker.stateDir, ".proxy-pull-error"), "");
	writeFileSync(join(tempRoot, "docker.log"), "");
	try {
		const saved = await save(input({ name: "镜像拉取失败" }));
		expect(saved.error).toContain("registry unavailable");
		expect(saved.imagePresent).toBe(false);
		await waitFor((entry) => entry.type === "singbox_pull_log" && entry.line.includes("registry unavailable"));
		const log = readFileSync(join(tempRoot, "docker.log"), "utf-8");
		expect(log).toContain(`pull ${saved.image}`);
		expect(log).not.toContain(" check -C ");
		expect(log).not.toContain("runtime.sh apply");
	} finally {
		rmSync(join(fakeDocker.stateDir, ".proxy-pull-error"), { force: true });
		rmSync(join(fakeDocker.stateDir, ".proxy-image-missing"), { force: true });
	}
});

test("a build saves and uses the sources chosen in the build wizard", async () => {
	drain("image_build_result");
	drain("sources_saved");
	writeFileSync(join(tempRoot, "docker.log"), "");
	send({ type: "build_image", sources: CHINA_SOURCES });
	await waitFor((entry) => entry.type === "sources_saved");
	await waitFor((entry) => entry.type === "image_build_result" && entry.ok);
	expect(readSources(agentDir)).toEqual(CHINA_SOURCES);
	const log = readFileSync(join(tempRoot, "docker.log"), "utf-8");
	expect(log).toContain(`BASE_IMAGE=${CHINA_SOURCES.baseImage}`);
	expect(log).toContain(`APT_MIRROR=${CHINA_SOURCES.aptMirror}`);
});

test("saving the environment image installs it even when its name has not changed", async () => {
	if (!fakeDocker) throw new Error("Fake Docker not installed");
	writeFileSync(join(fakeDocker.stateDir, ".proxy-image-missing"), "");
	drain("proxy_config");
	const image = readProxies(agentDir).image;
	send({ type: "set_proxy_image", image });
	const saved = await config();
	expect(saved.error).toBeUndefined();
	expect(saved.imagePresent).toBe(true);

	// Explicit image changes use the same installation path.
	writeFileSync(join(fakeDocker.stateDir, ".proxy-image-missing"), "");
	drain("proxy_config");
	send({ type: "set_proxy_image", image: "registry.example/sing-box:custom" });
	const changed = await config();
	expect(changed.image).toBe("registry.example/sing-box:custom");
	expect(changed.imagePresent).toBe(true);
	setProxyImage(agentDir, image);
});
