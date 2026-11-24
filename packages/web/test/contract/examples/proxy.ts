import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

const simpleId = "5b0d9f36-7c1e-4a58-9d2b-3f6e8c1a7d24";
const subscriptionId = "c41f8a72-9b3d-4e07-b5a6-8d2f90c4e615";
const wireguardId = "9a6e2d48-1f7b-4c30-a8e5-7d3b91c6f208";
const openvpnId = "e83b60f1-52c9-4d7a-b264-0c9fa1d38e57";
const projectId = "2e7a5c10-93b4-4f6a-8c1d-5b9e2a7f4c30";
const testUrl = "https://www.gstatic.com/generate_204";
const image = "ghcr.io/sagernet/sing-box:v1.13.15";

/** The tunnel fields a profile carries when it is not that kind of tunnel. */
const emptyWireGuard = { config: "", dns: "", killSwitch: true };
const emptyOpenVpn = { config: "", dns: "", username: "", password: "", killSwitch: true };
/** The endpoint fields a profile carries when it is not a `simple` one. */
const emptySimple = { type: "socks5" as const, server: "", port: 0, username: "", password: "", tls: false };

/** One valid example of each browser-to-server message described in proxy.md. */
export const client = {
	get_proxy_config: { type: "get_proxy_config" },
	save_proxy: {
		type: "save_proxy",
		proxy: {
			name: "出口 HTTP",
			mode: "simple",
			simple: { type: "http", server: "proxy.example.com", port: 3128, username: "", password: "", tls: true },
			wireguard: emptyWireGuard,
			openvpn: emptyOpenVpn,
			subscriptionUrl: "",
			subscriptionUserAgent: "",
			subscriptionIntervalHours: 0,
			nodeTag: "",
			routePrivateDirect: true,
		},
	},
	delete_proxy: { type: "delete_proxy", id: wireguardId },
	refresh_proxy_subscription: { type: "refresh_proxy_subscription", id: subscriptionId },
	set_proxy_node: { type: "set_proxy_node", id: subscriptionId, nodeTag: "日本 东京 02" },
	test_proxy_nodes: { type: "test_proxy_nodes", id: subscriptionId, url: testUrl },
	test_proxy_connection: { type: "test_proxy_connection", id: simpleId, url: "https://example.com/" },
	switch_project_node: { type: "switch_project_node", projectId, nodeTag: "auto" },
	set_default_proxy: { type: "set_default_proxy", id: subscriptionId },
	set_proxy_image: { type: "set_proxy_image", image },
	pull_singbox_image: { type: "pull_singbox_image" },
	set_project_proxy: { type: "set_project_proxy", projectId, proxyId: subscriptionId, proxyNode: "香港 01" },
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

/** One valid example of each server-to-browser message described in proxy.md. */
export const server = {
	proxy_config: {
		type: "proxy_config",
		config: {
			proxies: [
				{
					id: simpleId,
					name: "出口 SOCKS5",
					mode: "simple",
					simple: {
						type: "socks5",
						server: "socks.example.com",
						port: 1080,
						username: "operator",
						password: "example-password",
						tls: false,
					},
					subscription: null,
					wireguard: emptyWireGuard,
					openvpn: emptyOpenVpn,
					nodes: [],
					nodeTag: "",
					skipped: [],
					routePrivateDirect: true,
					test: { ok: true, latencyMs: 412, testedAt: 1795509000000, url: testUrl, error: null },
					createdAt: 1794298360000,
				},
				{
					id: subscriptionId,
					name: "订阅 A",
					mode: "subscription",
					simple: emptySimple,
					subscription: {
						url: "https://sub.example.com/api/v1/client/subscribe?token=example-token",
						userAgent: "clash.meta",
						updatedAt: 1795482750000,
						error: null,
						intervalHours: 12,
					},
					wireguard: emptyWireGuard,
					openvpn: emptyOpenVpn,
					nodes: [
						{
							tag: "香港 01",
							name: "香港 01",
							protocol: "shadowsocks",
							outbound: {
								type: "shadowsocks",
								tag: "香港 01",
								server: "hk1.example.com",
								server_port: 8388,
								method: "aes-256-gcm",
								password: "example-password",
							},
							latencyMs: 86,
							testedAt: 1795509000000,
						},
						{
							tag: "日本 东京 02",
							name: "日本 东京 02",
							protocol: "trojan",
							outbound: {
								type: "trojan",
								tag: "日本 东京 02",
								server: "jp2.example.com",
								server_port: 443,
								password: "example-password",
								tls: { enabled: true, server_name: "jp2.example.com" },
							},
							latencyMs: 231,
							testedAt: 1795509000000,
						},
						{
							tag: "美国 洛杉矶 03",
							name: "美国 洛杉矶 03",
							protocol: "vless",
							outbound: {
								type: "vless",
								tag: "美国 洛杉矶 03",
								server: "us3.example.com",
								server_port: 443,
								uuid: "00000000-0000-4000-8000-000000000003",
								tls: { enabled: true, server_name: "us3.example.com" },
								transport: { type: "ws", path: "/vless" },
							},
							latencyMs: null,
							testedAt: 1795509000000,
						},
					],
					nodeTag: "香港 01",
					skipped: [{ name: "ssr://example-node", reason: "sing-box 不支持 ssr，已跳过" }],
					routePrivateDirect: true,
					test: null,
					createdAt: 1794969065000,
				},
				{
					id: wireguardId,
					name: "实验室 WireGuard",
					mode: "wireguard",
					simple: emptySimple,
					subscription: null,
					wireguard: {
						config:
							"[Interface]\nPrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAddress = 10.66.0.2/32\nMTU = 1420\nDNS = 10.66.0.1\n\n[Peer]\nPublicKey = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = wg.example.com:51820\nPersistentKeepalive = 25",
						dns: "",
						killSwitch: true,
					},
					openvpn: emptyOpenVpn,
					nodes: [],
					nodeTag: "",
					skipped: [],
					routePrivateDirect: true,
					test: {
						ok: false,
						latencyMs: null,
						testedAt: 1795509000000,
						url: "https://example.com/",
						error: "WireGuard 隧道没有在 20 秒内建立：[#] ip link set mtu 1420 up dev wg0",
					},
					createdAt: 1795427112000,
				},
				{
					id: openvpnId,
					name: "客户专线 OpenVPN",
					mode: "openvpn",
					simple: emptySimple,
					subscription: null,
					wireguard: emptyWireGuard,
					openvpn: {
						config:
							"client\ndev tun\nproto udp\nremote vpn.example.com 1194\nresolv-retry infinite\nnobind\nauth-user-pass\n<ca>\n-----BEGIN CERTIFICATE-----\nRVhBTVBMRSBURVNUIENFUlRJRklDQVRFIC0gbm90IGEgcmVhbCBjZXJ0aWZpY2F0\nZSAtIHJlc2VydmVkIGZvciBkb2N1bWVudGF0aW9uIGV4YW1wbGVzIG9ubHkuIEVY\nQU1QTEUgVEVTVCBDRVJUSUZJQ0FURSAtIG5vdCBhIHJlYWwgY2VydGlmaWNhdGUg\nLSByZXNlcnZlZCBmb3IgZG9jdW1lbnRhdGlvbiBleGFtcGxlcyBvbmx5LiBFWEFN\nUExFIFRFU1QgQ0VSVElGSUNBVEUgLSBub3QgYSByZWFsIGNlcnRpZmljYXRlIC0g\ncmVzZXJ2ZWQgZm9yIGRvY3VtZW50YXRpb24gZXhhbXBsZXMgb25seS4g\n-----END CERTIFICATE-----\n</ca>",
						dns: "10.8.0.1",
						username: "operator",
						password: "example-password",
						killSwitch: true,
					},
					nodes: [],
					nodeTag: "",
					skipped: [],
					routePrivateDirect: true,
					test: null,
					createdAt: 1795427112000,
				},
			],
			defaultId: subscriptionId,
			image,
			imagePresent: true,
			testUrl,
		},
	},
	project_proxy_saved: { type: "project_proxy_saved", projectId, applied: true },
	singbox_pull_started: { type: "singbox_pull_started" },
	singbox_pull_log: { type: "singbox_pull_log", line: `docker pull ${image}` },
	singbox_pull_result: { type: "singbox_pull_result", ok: true },
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
