/**
 * Render smoke test for the 代理 page.
 *
 * The page needs a browser to *look* right, but a null dereference or a bad prop
 * fails here first, and this is the only automated check its JSX gets. What is
 * pinned is what the operator decides on: which profiles exist, which one the
 * default is, and whether the image their sidecars need is here.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { EMPTY_OPENVPN, EMPTY_PROXY_INPUT, EMPTY_WIREGUARD } from "../types.ts";
import type { SentinelProjectInfo, SentinelProxy, SentinelProxyConfigView } from "../types.ts";
import {
	ProxyEditorBody,
	ProxyNodeDialogBody,
	ProxyPage,
	ProxyTestDialogBody,
} from "./ProxyPage.tsx";

function profile(overrides: Partial<SentinelProxy> = {}): SentinelProxy {
	return {
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
		...overrides,
	};
}

function config(overrides: Partial<SentinelProxyConfigView> = {}): SentinelProxyConfigView {
	return {
		proxies: [profile()],
		defaultId: "p1",
		image: "ghcr.io/sagernet/sing-box:v1.13.15",
		imagePresent: true,
		testUrl: "https://www.gstatic.com/generate_204",
		...overrides,
	};
}

function project(overrides: Partial<SentinelProjectInfo> = {}): SentinelProjectInfo {
	return { id: "proj", name: "靶场", cwd: "/work", vulnCount: 0, gateCount: 0, ...overrides };
}

function render(view: SentinelProxyConfigView, projects: SentinelProjectInfo[] = []): string {
	return renderToStaticMarkup(
		createElement(ProxyPage, {
			config: view,
			projects,
			busy: false,
			onSave: async () => null,
			onDelete: async () => null,
			onRefreshSubscription: async () => null,
			onSetNode: async () => null,
			onTestNodes: async () => null,
			onTestConnection: async () => null,
			refreshingId: null,
			testingId: null,
		}),
	);
}

test("the table lists each profile with its exit and the default marker", () => {
	const html = render(config());
	expect(html).toContain("香港节点");
	expect(html).toContain("SOCKS5 1.2.3.4:1080");
	// The default is a property of the page, not of a profile.
	expect(html).toContain(">默认</span>");
	// The image and the default selector moved to 环境; this page is profiles only.
	expect(html).not.toContain("ghcr.io/sagernet/sing-box");
	expect(html).not.toContain("默认与镜像");
});

test("the project column counts only the projects a profile actually reaches", () => {
	// One project names the profile, one follows the default (which is the same
	// profile), and one is explicitly off.
	const html = render(config(), [
		project({ id: "a", name: "A", proxyId: "p1" }),
		project({ id: "b", name: "B" }),
		project({ id: "c", name: "C", proxyId: null }),
	]);
	const row = html.slice(html.indexOf("香港节点"), html.indexOf("编辑"));
	expect(row).toContain(">2</span>");
});

test("an empty page says what to do", () => {
	const empty = render(config({ proxies: [], defaultId: null }));
	expect(empty).toContain("还没有代理");
	expect(empty).toContain("新建一个之后");
});

test("the table says which kind of profile each row is", () => {
	const html = render(
		config({
			proxies: [
				profile(),
				profile({
					id: "p2",
					name: "机场",
					mode: "subscription",
					subscription: { url: "https://example.com/sub", userAgent: "sing-box", updatedAt: 0, error: null, intervalHours: 0 },
					nodes: [{ tag: "香港", name: "香港", protocol: "trojan", outbound: {} }],
					nodeTag: "香港",
				}),
			],
		}),
	);
	// An address is a plain proxy; a URL-backed profile is a subscription.
	expect(html).toContain("普通代理");
	expect(html).toContain(">订阅<");
});

test("a subscription profile shows its node count and the node it uses", () => {
	const html = render(
		config({
			proxies: [
				profile({
					mode: "subscription",
					subscription: { url: "https://example.com/sub", userAgent: "sing-box", updatedAt: 1, error: null, intervalHours: 0 },
					nodes: [
						{ tag: "香港 01", name: "香港 01", protocol: "vmess", outbound: {} },
						{ tag: "日本 02", name: "日本 02", protocol: "trojan", outbound: {} },
					],
					nodeTag: "日本 02",
				}),
			],
		}),
	);
	expect(html).toContain("2 个节点");
	expect(html).toContain("日本 02");
	// The row offers the node picker only for a subscription.
	expect(html).toContain("节点</span>");
});

test("a subscription that was never read says so", () => {
	const html = render(
		config({
			proxies: [
				profile({
					mode: "subscription",
					subscription: { url: "https://example.com/sub", userAgent: "sing-box", updatedAt: 0, error: null, intervalHours: 0 },
					nodes: [],
				}),
			],
		}),
	);
	expect(html).toContain("订阅未拉取");
});

test("an automatic subscription displays the policy instead of the first node", () => {
	const html = render(
		config({
			proxies: [
				profile({
					mode: "subscription",
					nodes: [{ tag: "first", name: "first-fixed-node", protocol: "trojan", outbound: {} }],
					nodeTag: "auto",
				}),
			],
		}),
	);
	expect(html).toContain("自动（按延迟择优）");
	expect(html).not.toContain("first-fixed-node");
});

test("the node dialog shows measured latency, a timeout, and the test controls", () => {
	const proxy = profile({
		mode: "subscription",
		subscription: { url: "https://example.com/sub", userAgent: "sing-box", updatedAt: 1, error: null, intervalHours: 6 },
		nodes: [
			{ tag: "香港", name: "香港 01", protocol: "trojan", outbound: {}, latencyMs: 42, testedAt: 1 },
			{ tag: "日本", name: "日本 02", protocol: "vmess", outbound: {}, latencyMs: null, testedAt: 1 },
			{ tag: "美国", name: "美国 03", protocol: "vmess", outbound: {} },
		],
		nodeTag: "香港",
	});
	const html = renderToStaticMarkup(
		createElement(ProxyNodeDialogBody, {
			proxy,
			busy: false,
			refreshing: false,
			testing: false,
			testUrl: "https://www.gstatic.com/generate_204",
			onPick: () => {},
			onRefresh: () => {},
			onTest: () => {},
			onClose: () => {},
		}),
	);
	expect(html).toContain("42 ms");
	// A node that was tested and timed out says so; an untested one shows its protocol.
	expect(html).toContain("超时");
	expect(html).toContain("vmess");
	// The URL is editable, and the button tests every node at once.
	expect(html).toContain("测速地址");
	expect(html).toContain("https://www.gstatic.com/generate_204");
	expect(html).toContain("批量测速");
});

test("a simple or tunnel profile offers a connectivity test and shows its last result", () => {
	const html = render(
		config({
			proxies: [
				profile({
					test: {
						ok: true,
						latencyMs: 42,
						testedAt: 1,
						url: "https://www.gstatic.com/generate_204",
						error: null,
					},
				}),
			],
		}),
	);
	// The action is real traffic, not a port check.
	expect(html).toContain("测试</span>");
	// The stored result is visible in the row, so a reload does not lose it.
	expect(html).toContain("42 ms");
});

test("a failed test is red in the row and keeps the reason as a tooltip", () => {
	const html = render(
		config({
			proxies: [
				profile({
					mode: "wireguard",
					wireguard: {
						config: "[Interface]\nPrivateKey = x\n\n[Peer]\nEndpoint = vpn.example.com:51820",
						dns: "",
						killSwitch: true,
					},
					test: { ok: false, latencyMs: null, testedAt: 1, url: "https://example.org", error: "握手超时" },
				}),
			],
		}),
	);
	expect(html).toContain("测试失败");
	expect(html).toContain('title="握手超时"');
});

test("a subscription keeps the node picker instead of a profile test", () => {
	const html = render(
		config({
			proxies: [
				profile({
					mode: "subscription",
					subscription: { url: "https://example.com/sub", userAgent: "sing-box", updatedAt: 1, error: null, intervalHours: 0 },
					nodes: [{ tag: "香港", name: "香港", protocol: "trojan", outbound: {} }],
					nodeTag: "香港",
				}),
			],
		}),
	);
	expect(html).toContain("节点</span>");
	// Its nodes are measured in the picker; a profile-level test would have to pick
	// one silently.
	expect(html).not.toContain("测试</span>");
});

test("the test dialog shows the URL, the last result and the failure reason", () => {
	const proxy = profile({
		mode: "openvpn",
		openvpn: { config: "client\nremote vpn.example.com 1194\n<ca>x</ca>", dns: "", username: "", password: "", killSwitch: true },
		test: { ok: false, latencyMs: null, testedAt: 1, url: "https://internal.example/health", error: "TLS handshake failed" },
	});
	const html = renderToStaticMarkup(
		createElement(ProxyTestDialogBody, {
			proxy,
			busy: false,
			testUrl: "https://www.gstatic.com/generate_204",
			runningUses: 0,
			onTest: async () => null,
			onClose: () => {},
		}),
	);
	// The last URL is what the box opens with, not the page-wide default.
	expect(html).toContain("https://internal.example/health");
	expect(html).toContain("测试失败");
	expect(html).toContain("TLS handshake failed");
	expect(html).toContain("重新测试");
});

test("testing a tunnel that a running project uses warns before it can disturb it", () => {
	const html = renderToStaticMarkup(
		createElement(ProxyTestDialogBody, {
			proxy: profile({ mode: "wireguard" }),
			busy: false,
			testUrl: "https://www.gstatic.com/generate_204",
			runningUses: 2,
			onTest: async () => null,
			onClose: () => {},
		}),
	);
	// A second connection with the same key/certificate can take the peer's endpoint
	// or knock the first client offline, so the operator is told before starting.
	expect(html).toContain("2 个运行中的项目");
	expect(html).toContain("duplicate-cn");
});

test("a simple proxy has no such warning: its credentials can be used more than once", () => {
	const html = renderToStaticMarkup(
		createElement(ProxyTestDialogBody, {
			proxy: profile(),
			busy: false,
			testUrl: "https://www.gstatic.com/generate_204",
			runningUses: 2,
			onTest: async () => null,
			onClose: () => {},
		}),
	);
	expect(html).not.toContain("运行中的项目");
});

test("the test dialog starts empty and offers the first run", () => {
	const html = renderToStaticMarkup(
		createElement(ProxyTestDialogBody, {
			proxy: profile(),
			busy: false,
			testUrl: "https://www.gstatic.com/generate_204",
			runningUses: 0,
			onTest: async () => null,
			onClose: () => {},
		}),
	);
	expect(html).toContain("https://www.gstatic.com/generate_204");
	expect(html).toContain("还没有测试过");
	expect(html).toContain("开始测试");
});

test("the proxy editor keeps the four exit kinds in a left rail", () => {
	const html = renderToStaticMarkup(
		createElement(ProxyEditorBody, {
			initial: { ...EMPTY_PROXY_INPUT, name: "香港节点", mode: "wireguard" },
			busy: false,
			error: null,
			onSave: () => {},
			onCancel: () => {},
		}),
	);
	// All four kinds are visible as navigation, but only the selected kind's form
	// is rendered; the subscription URL is not in the DOM until it is selected.
	expect(html).toContain("出口类型");
	expect(html).toContain("SOCKS5 / HTTP");
	expect(html).toContain("订阅链接");
	expect(html).toContain("WireGuard");
	expect(html).toContain("OpenVPN");
	expect(html).toContain("WireGuard 配置");
	expect(html).toContain("断线即断网");
	expect(html).not.toContain("订阅地址");
});

test("the proxy editor shows the simple fields when that kind is selected", () => {
	const html = renderToStaticMarkup(
		createElement(ProxyEditorBody, {
			initial: {
				...EMPTY_PROXY_INPUT,
				name: "本机 Clash",
				mode: "simple",
				simple: { ...EMPTY_PROXY_INPUT.simple, type: "http" },
			},
			busy: false,
			error: null,
			onSave: () => {},
			onCancel: () => {},
		}),
	);
	expect(html).toContain("端口");
	expect(html).toContain("HTTPS 上游");
	expect(html).toContain("内网与回环地址直连");
	expect(html).not.toContain("WireGuard 配置");
});

test("a tunnel profile has no private-direct column value and no node picker", () => {
	const html = render(
		config({
			proxies: [
				profile({
					id: "wg1",
					name: "隧道",
					mode: "wireguard",
					wireguard: { config: "[Interface]\nPrivateKey = x\n\n[Peer]\nEndpoint = vpn.example.com:51820", dns: "", killSwitch: true },
				}),
			],
		}),
	);
	// The split is expressed by AllowedIPs in the pasted file, so the column is
	// not a yes/no — showing one would promise a switch that does not exist.
	expect(html).toContain("WireGuard vpn.example.com:51820");
	expect(html).toContain(">—</span>");
	expect(html).not.toContain("节点</span>");
});

test("an OpenVPN profile shows its remote, warns when two projects share one certificate", () => {
	const openvpn = profile({
		id: "ovpn1",
		name: "实验室隧道",
		mode: "openvpn",
		openvpn: {
			config: "client\ndev tun\nremote vpn.example.com 1194\n<ca>\nx\n</ca>",
			dns: "",
			username: "",
			password: "",
			killSwitch: true,
		},
	});
	// Two projects on one profile: one client certificate, which the server treats as
	// one client unless it runs with duplicate-cn.
	const html = render(config({ proxies: [openvpn] }), [
		project({ id: "pr1", proxyId: "ovpn1" }),
		project({ id: "pr2", name: "另一台", proxyId: "ovpn1" }),
	]);
	expect(html).toContain("OpenVPN vpn.example.com:1194");
	expect(html).toContain("证书共用");
	expect(html).not.toContain("节点</span>");

	// One project is the normal case: no warning.
	const alone = render(config({ proxies: [openvpn] }), [
		project({ id: "pr1", proxyId: "ovpn1" }),
		project({ id: "pr2", name: "另一台", proxyId: null }),
	]);
	expect(alone).not.toContain("证书共用");
});
