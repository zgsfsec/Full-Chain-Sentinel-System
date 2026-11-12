/**
 * Render smoke test for the environment page.
 *
 * The complaint this pins down: the container network and the proxy defaults used
 * to be two cards with two save buttons, so "which network will a new container
 * get" meant reading two places. They are one card with one 保存 now, and that is
 * what is asserted here — one heading, one button, both settings inside it.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { EMPTY_OPENVPN, EMPTY_WIREGUARD } from "../types.ts";
import type { SentinelEnvItem, SentinelEnvReport, SentinelProxyConfigView } from "../types.ts";
import { EnvironmentPanel } from "./EnvironmentPanel.tsx";
import { environmentSetup } from "./EnvironmentSetupGuide.tsx";

function proxyConfig(overrides: Partial<SentinelProxyConfigView> = {}): SentinelProxyConfigView {
	return {
		proxies: [
			{
				id: "p1",
				name: "香港节点",
				mode: "simple",
				simple: { type: "socks5", server: "1.2.3.4", port: 1080, username: "", password: "", tls: false },
				subscription: null,
				wireguard: { ...EMPTY_WIREGUARD },
				openvpn: { ...EMPTY_OPENVPN },
				nodes: [],
				nodeTag: "",
				skipped: [],
				routePrivateDirect: true,
				createdAt: 0,
			},
		],
		defaultId: "p1",
		image: "ghcr.io/sagernet/sing-box:v1.13.15",
		imagePresent: true,
		testUrl: "https://www.gstatic.com/generate_204",
		...overrides,
	};
}

function report(config: SentinelProxyConfigView): SentinelEnvReport {
	return {
		at: "2026-10-24T00:00:00.000Z",
		ok: true,
		url: "http://127.0.0.1:49187",
		items: [],
		sources: { baseImage: "", aptMirror: "", pipIndex: "", npmRegistry: "", goProxy: "" },
		containerNetwork: "host",
		proxies: config,
	} as SentinelEnvReport;
}

function render(
	config: SentinelProxyConfigView = proxyConfig(),
	pullingImage = false,
	overrides: Partial<SentinelEnvReport> = {},
	building = false,
): string {
	return renderToStaticMarkup(
		createElement(EnvironmentPanel, {
			report: { ...report(config), items: READY_ITEMS, ...overrides },
			building,
			buildLog: [],
			onRefresh: () => {},
			onBuild: () => {},
			onAbortBuild: () => {},
			onSaveSources: () => {},
			sourcesSavedAt: null,
			networkSavedAt: null,
			proxyConfig: config,
			pullingImage,
			proxyPullLog: pullingImage ? ["Pulling fs layer", "Downloading 42%"] : [],
			onSaveNetworkAndProxy: () => {},
			onPullProxyImage: () => {},
		}),
	);
}

test("the network mode and the proxy defaults live in one card with one save", () => {
	const html = render();
	expect(html).toContain("容器网络与代理");
	// Everything the two old cards held is inside this one: the mode radios, the
	// default proxy and the image, and a single 保存 for the lot.
	const start = html.indexOf(">容器网络与代理<");
	const end = html.indexOf("envhub-buildlog");
	const card = html.slice(start, end === -1 ? undefined : end);
	expect(card).toContain("默认代理");
	expect(card).toContain("sing-box 镜像");
	expect(card).toContain("香港节点");
	// One primary button: the single 保存 that commits the whole card.
	expect(card.match(/ant-btn-primary/g) ?? []).toHaveLength(1);
	expect(card).toMatch(/保\s*存/);
	// The old heading is gone.
	expect(html).not.toContain(">代理默认与镜像<");
});

function check(id: string, status: SentinelEnvItem["status"] = "ok", detail = id): SentinelEnvItem {
	return { id, group: "环境", label: id, status, detail, blocking: true };
}

const READY_ITEMS = [
	check("docker-daemon"),
	check("image-present"),
	check("container-run"),
	check("gateway-runtime"),
	check("projects-dir"),
	check("agent-dir"),
];

test("Docker failure takes priority over missing images and dependent skipped checks", () => {
	const items = [
		check("docker-cli", "fail"),
		check("image-present", "skipped"),
		check("container-run", "skipped"),
		check("gateway-runtime", "skipped"),
	];
	const state = environmentSetup({ ...report(proxyConfig()), ok: false, items });
	expect(state.current).toBe(0);
	expect(state.dockerReady).toBe(false);
	const html = render(proxyConfig(), false, { ok: false, items });
	expect(html).toContain("先在服务端安装 Docker");
	expect(html).toContain("等待前置步骤");
	expect(html).toContain("docker info");
	const buildButtons = (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).filter((button) =>
		button.includes("构建镜像"),
	);
	expect(buildButtons).toHaveLength(1);
	expect(buildButtons[0]).toContain("disabled");
	expect(html).not.toContain("修复网关运行环境");
});

test("an installed CLI without a verified daemon cannot enable builds", () => {
	expect(environmentSetup({ ...report(proxyConfig()), items: [check("docker-cli")] }).dockerReady).toBe(false);
});

test("a missing gateway check is not presented as a completed runtime step", () => {
	const items = READY_ITEMS.filter((item) => item.id !== "gateway-runtime");
	expect(environmentSetup({ ...report(proxyConfig()), ok: false, items }).current).toBe(3);
	expect(render(proxyConfig(), false, { ok: false, items })).toContain("检测结果尚不完整");
});

test("a missing toolbox image leads to build instructions before gateway troubleshooting", () => {
	const items = [
		check("docker-daemon"),
		check("image-present", "fail"),
		check("container-run", "skipped"),
		check("gateway-runtime", "fail", "No such image"),
	];
	expect(environmentSetup({ ...report(proxyConfig()), ok: false, items }).current).toBe(1);
	const html = render(proxyConfig(), false, { ok: false, items });
	expect(html).toContain("创建工具运行所需的镜像");
	expect(html).toContain("配置构建源");
	const buildButtons = (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).filter((button) =>
		button.includes("构建镜像"),
	);
	expect(buildButtons).toHaveLength(2);
	for (const button of buildButtons) expect(button).not.toContain("disabled");
	expect(html).not.toContain("修复网关运行环境");
});

test("gateway failures expose the actual error and custom-image recovery guidance", () => {
	const items = READY_ITEMS.map((item) =>
		item.id === "gateway-runtime" ? check(item.id, "fail", "iptables: Operation not permitted") : item,
	);
	expect(environmentSetup({ ...report(proxyConfig()), ok: false, items }).current).toBe(3);
	const html = render(proxyConfig(), false, { ok: false, items });
	expect(html).toContain("修复网关运行环境");
	expect(html).toContain("iptables: Operation not permitted");
	expect(html).toContain("SENTINEL_GATEWAY_IMAGE");
	expect(html).toContain("NET_ADMIN");
});

test("directory failures remain actionable after Docker and gateway checks pass", () => {
	const items = READY_ITEMS.map((item) =>
		item.id === "agent-dir" ? check(item.id, "fail", "/data/config: EACCES") : item,
	);
	expect(environmentSetup({ ...report(proxyConfig()), ok: false, items }).current).toBe(4);
	expect(render(proxyConfig(), false, { ok: false, items })).toContain("SENTINEL_CODING_AGENT_DIR");
});

test("builds show output guidance and abort control even when the previous report was healthy", () => {
	const html = render(proxyConfig(), false, { items: READY_ITEMS }, true);
	expect(html).toContain("环境准备引导");
	expect(html).toContain("查看构建输出");
	expect(html).toContain("中止构建");
	expect(html).not.toContain("Docker 环境正常");
});

test("successful IPv4 checks and optional warnings do not require environment setup", () => {
	const items = [
		...READY_ITEMS.map((item) =>
			item.id === "gateway-runtime" ? check(item.id, "ok", "IPv4 网关初始化通过（IPv6 已禁用）") : item,
		),
		{ ...check("proxy-image", "warn"), blocking: false },
		{ ...check("build-network", "skipped"), blocking: false },
	];
	const html = render(proxyConfig(), false, { items });
	expect(html).toContain("环境准备完成");
	expect(html).toContain("Docker 环境正常");
	expect(html).toContain("IPv4 网关初始化通过");
});

test("a missing proxy image is stated on the same card", () => {
	const html = render(proxyConfig({ imagePresent: false }));
	expect(html).toContain("镜像不在本地");
	// Pulling is an action, so it keeps its own button.
	expect(html).toContain("拉取镜像");
	// The network card's save can install the default image with no edits.
	const card = html.slice(html.indexOf(">容器网络与代理<"));
	const save = card.match(/<button[^>]*ant-btn-primary[^>]*>/)?.[0];
	expect(save).toBeDefined();
	expect(save).not.toContain("disabled");
	const pulling = render(proxyConfig({ imagePresent: false }), true);
	const busyCard = pulling.slice(pulling.indexOf(">容器网络与代理<"));
	expect(busyCard.match(/<button[^>]*ant-btn-primary[^>]*>/)?.[0]).toContain("disabled");
	expect(pulling).toContain("代理镜像拉取输出");
	expect(pulling).toContain("Downloading 42%");
});

test("toolbox construction precedes the separate network image pull step", () => {
	const config = proxyConfig({ imagePresent: false });
	expect(environmentSetup({ ...report(config), items: READY_ITEMS }).current).toBe(2);
	const html = render(config);
	expect(html.indexOf("构建工具镜像")).toBeLessThan(html.indexOf("拉取网络与代理镜像"));
	expect(html).toContain("配置并拉取代理镜像");
	expect(html).not.toContain("Docker 环境正常");
});
