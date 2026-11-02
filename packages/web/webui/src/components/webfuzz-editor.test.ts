import { expect, test } from "vitest";
import { prepareWebFuzzRaw } from "../../../src/webfuzz.ts";
import { editWebFuzzRaw } from "./webfuzz-editor.ts";

test("editing multipart headers preserves every original body byte and a valid form", async () => {
	const body = '--boundary\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n--boundary--\r\n';
	const raw = `POST /upload HTTP/1.1\r\nHost: example.com\r\nCookie: foo\r\nContent-Type: multipart/form-data; boundary=boundary\r\n\r\n${body}`;
	const edited = editWebFuzzRaw(raw, raw.replace(/\r\n/g, "\n").replace("Cookie: foo", "Cookie: bar"));
	expect(edited).toBe(raw.replace("Cookie: foo", "Cookie: bar"));
	const prepared = prepareWebFuzzRaw({ raw: edited, target: "http://example.com", route: "direct", timeoutMs: 1000, insecureTLS: false, fixContentLength: true });
	expect(prepared.endsWith(body)).toBe(true);
	expect(prepared).toContain(`Content-Length: ${Buffer.byteLength(body)}\r\n`);
	const form = await new Response(prepared.split("\r\n\r\n").slice(1).join("\r\n\r\n"), { headers: { "Content-Type": "multipart/form-data; boundary=boundary" } }).formData();
	expect(form.get("field")).toBe("value");
});

test("unchanged body line endings survive header edits, insertions and deletions", () => {
	for (const body of ["a\r\nb\r\n", "a\nb\n", "a\rb\r", "a\r\nb\nc\rd"]) {
		const raw = `POST / HTTP/1.1\r\nHost: example.com\r\nX-Test: old\r\n\r\n${body}`;
		const normalized = raw.replace(/\r\n?/g, "\n");
		for (const replacement of ["new", "", "extra long value"]) {
			expect(editWebFuzzRaw(raw, normalized.replace("X-Test: old", `X-Test: ${replacement}`))).toBe(raw.replace("X-Test: old", `X-Test: ${replacement}`));
		}
	}
});

test("body edits retain CRLF chunk framing and inserted lines use the current style", () => {
	const raw = "POST / HTTP/1.1\r\nHost: x\r\n\r\n3\r\nabc\r\n0\r\n\r\n";
	expect(editWebFuzzRaw(raw, raw.replace(/\r\n/g, "\n").replace("abc", "abd"))).toBe(raw.replace("abc", "abd"));
	expect(editWebFuzzRaw("a\r\nb", "a\nx\nb")).toBe("a\r\nx\r\nb");
	expect(editWebFuzzRaw("a\nb", "a\nx\nb")).toBe("a\nx\nb");
	expect(editWebFuzzRaw("a\r\nb", "")).toBe("");
	expect(editWebFuzzRaw("", "a\nb")).toBe("a\nb");
});
