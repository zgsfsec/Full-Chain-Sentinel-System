import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { WebFuzzResult } from "../../../src/webfuzz-types.ts";
import { WebFuzzPage, WebFuzzResponse, webFuzzResponseText } from "./WebFuzzPage.tsx";

const result: WebFuzzResult = {
	id: "r",
	at: 1,
	request: {
		raw: "GET / HTTP/1.1",
		target: "https://example.com",
		route: "project",
		timeoutMs: 30000,
		insecureTLS: false,
		fixContentLength: true,
	},
	response: {
		proto: "HTTP/1.1",
		status: 200,
		reason: "OK",
		headers: [{ name: "Content-Type", value: "text/html" }],
		bodyText: "<script>alert(1)</script>",
		rawText: "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>",
		size: 25,
		truncated: false,
	},
	timings: { connectMs: 1, tlsMs: 1, ttfbMs: 1, totalMs: 3 },
	warnings: [],
};

test("target HTML stays inert and raw view preserves headers", () => {
	const html = renderToStaticMarkup(createElement(WebFuzzResponse, { result }));
	expect(html).toContain("&lt;script&gt;");
	expect(html).not.toContain("<script>");
	expect(webFuzzResponseText(result, "headers", false)).not.toContain("alert");
	expect(webFuzzResponseText(result, "raw", false)).toContain("HTTP/1.1 200 OK\r\nContent-Type: text/html");
	const json = { ...result, response: { ...result.response!, bodyText: '{"a":1}' } };
	expect(webFuzzResponseText(json, "body", true)).toBe('{\n  "a": 1\n}');
	expect(webFuzzResponseText(result, "body", true)).toBe(result.response?.bodyText);
});

test("binary and empty states are explicit; no project cannot send", () => {
	const binary = renderToStaticMarkup(
		createElement(WebFuzzResponse, {
			result: { ...result, response: { ...result.response!, rawText: undefined, rawBase64: "//4A", bodyText: undefined, bodyBase64: "//4A" } },
		}),
	);
	expect(binary).toContain("Base64");
	const empty = renderToStaticMarkup(createElement(WebFuzzResponse, { result: null }));
	expect(empty).toContain("发送请求后");
	const page = renderToStaticMarkup(createElement(WebFuzzPage, { project: null }));
	expect(page).toContain("请先选择项目");
	expect(page).not.toContain("发送请求");
});

test("raw response keeps wire framing and never fabricates an original for older records", () => {
	const wire = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n";
	const chunked = { ...result, response: { ...result.response!, rawText: wire, bodyText: "ok" } };
	expect(webFuzzResponseText(chunked, "raw", false)).toBe(wire);
	expect(webFuzzResponseText(chunked, "body", false)).toBe("ok");
	const legacy = { ...result, response: { ...result.response!, rawText: undefined } };
	expect(webFuzzResponseText(legacy, "raw", false)).toContain("未保存原始响应");
	expect(webFuzzResponseText(legacy, "raw", false)).not.toContain("HTTP/1.1");
});
