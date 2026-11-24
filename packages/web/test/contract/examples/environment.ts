import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

/** One valid example of each browser-to-server message described in environment.md. */
export const client = {
	get_environment: {
		type: "get_environment",
	},
	check_environment: {
		type: "check_environment",
	},
	build_image: {
		type: "build_image",
		sources: {
			baseImage: "text",
			aptMirror: "text",
			pipIndex: "text",
			npmRegistry: "text",
			goProxy: "text",
		},
	},
	abort_image_build: {
		type: "abort_image_build",
	},
	set_sources: {
		type: "set_sources",
		sources: {
			baseImage: "text",
			aptMirror: "text",
			pipIndex: "text",
			npmRegistry: "text",
			goProxy: "text",
		},
	},
	set_container_network: {
		type: "set_container_network",
		network: "host",
	},
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

/** One valid example of each server-to-browser message described in environment.md. */
export const server = {
	environment: {
		type: "environment",
		report: {
			at: "2026-11-24T08:30:00.000Z",
			ok: true,
			items: [
				{
					id: "id-1",
					group: "text",
					label: "示例文本",
					status: "ok",
					detail: "示例文本",
					blocking: true,
				},
			],
			url: "https://example.com",
			sources: {
				baseImage: "text",
				aptMirror: "text",
				pipIndex: "text",
				npmRegistry: "text",
				goProxy: "text",
			},
			containerNetwork: "host",
			proxies: {
				proxies: [
					{
						id: "id-1",
						name: "示例文本",
						mode: "subscription",
						simple: {
							type: "http",
							server: "text",
							port: 8443,
							username: "示例文本",
							password: "example-credential",
							tls: true,
						},
						subscription: {
							url: "https://example.com",
							userAgent: "text",
							updatedAt: 1763973000000,
							error: "示例错误信息",
							intervalHours: 2,
						},
						wireguard: {
							config: "text",
							dns: "text",
							killSwitch: true,
						},
						openvpn: {
							config: "text",
							dns: "text",
							username: "示例文本",
							password: "example-credential",
							killSwitch: true,
						},
						nodes: [
							{
								tag: "text",
								name: "示例文本",
								protocol: "text",
								outbound: {
									"key-1": null,
								},
							},
						],
						nodeTag: "text",
						skipped: [
							{
								name: "示例文本",
								reason: "示例错误信息",
							},
						],
						routePrivateDirect: true,
						createdAt: 1763973000000,
					},
				],
				defaultId: "default-1",
				image: "https://example.com",
				imagePresent: true,
				testUrl: "https://example.com",
			},
		},
		building: true,
		proxyPull: {
			pulling: true,
			log: ["text"],
		},
	},
	sources_saved: {
		type: "sources_saved",
		sources: {
			baseImage: "text",
			aptMirror: "text",
			pipIndex: "text",
			npmRegistry: "text",
			goProxy: "text",
		},
		error: "示例错误信息",
	},
	image_build_result: {
		type: "image_build_result",
		ok: true,
		error: "示例错误信息",
	},
	image_build_log: {
		type: "image_build_log",
		line: "text",
	},
	container_network_saved: {
		type: "container_network_saved",
		network: "host",
		error: "示例错误信息",
	},
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
