import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { MitmStatus } from "../../../src/mitm-types.ts";
import { MitmFlowLink, MitmPage, MitmRawMessage, mitmProxyEndpoint } from "./MitmPage.tsx";

test("proxy address uses the console IP or host LAN IP and respects loopback binding", () => {
	const status: MitmStatus = {
		project: { id: "p", name: "P" },
		config: { bind: "0.0.0.0", port: 32774, skipStatic: true, maxCaptureMb: 2 },
		state: "running",
		port: 32774,
		lanIps: ["192.168.1.10"],
		ca: null,
	};
	expect(mitmProxyEndpoint(status, "203.0.113.10")).toBe("203.0.113.10:32774");
	expect(mitmProxyEndpoint(status, "localhost")).toBe("192.168.1.10:32774");
	expect(mitmProxyEndpoint(status, "127.0.0.1")).toBe("192.168.1.10:32774");
	expect(mitmProxyEndpoint(status, "console.example.com")).toBe("192.168.1.10:32774");
	expect(mitmProxyEndpoint(status, "[2001:db8::1]")).toBe("[2001:db8::1]:32774");
	expect(mitmProxyEndpoint({ ...status, config: { ...status.config, bind: "127.0.0.1" } }, "203.0.113.10")).toBe(
		"127.0.0.1:32774",
	);
	expect(mitmProxyEndpoint({ ...status, lanIps: [] }, "localhost")).toBeNull();
	expect(mitmProxyEndpoint(null, "localhost")).toBeNull();
});

test("no-project page asks for a project without offering start", () => {
	const html = renderToStaticMarkup(createElement(MitmPage, { project: null }));
	expect(html).toContain("请先选择项目");
	expect(html).not.toContain("启动代理");
});

test("captured HTML remains inert text and truncated binary content is labelled", () => {
	const html = renderToStaticMarkup(
		createElement(MitmRawMessage, {
			body: {
				text: "<script>alert(1)</script>",
				encoding: "utf8",
				size: 25,
				truncated: false,
				captureTruncated: false,
			},
			download: "/api/mitm/flows/a/response?projectId=p",
		}),
	);
	expect(html).toContain("&lt;script&gt;");
	expect(html).not.toContain("<script>");
	const binary = renderToStaticMarkup(
		createElement(MitmRawMessage, {
			body: { text: "//4A", encoding: "base64", size: 2048000, truncated: true, captureTruncated: false },
			download: "/api/mitm/flows/a/response?projectId=p",
		}),
	);
	expect(binary).toContain("Base64");
	expect(binary).toContain("仅预览前 1 MB");
	expect(binary).toContain("下载原始报文");
	const limited = renderToStaticMarkup(
		createElement(MitmRawMessage, {
			body: { text: "saved", encoding: "utf8", size: 1024, truncated: false, captureTruncated: true },
			download: "/raw",
		}),
	);
	expect(limited).toContain("已按保存上限截断");
	expect(limited).toContain("下载已保存报文");
});

test("flow address is a single complete URL including path and query", () => {
	const html = renderToStaticMarkup(
		createElement(MitmFlowLink, {
			flow: {
				id: "a",
				ts: 1,
				method: "GET",
				scheme: "https",
				host: "example.com",
				port: 443,
				path: "/api/users",
				query: "page=1",
				status: 200,
				durationMs: 2,
				reqSize: 1,
				respSize: 1,
				error: null,
				note: "",
			},
			onOpen: () => {},
		}),
	);
	expect(html).toContain("<span>https://example.com/api/users?page=1</span>");
	expect(html).not.toContain("mitm-flow-path");
});
