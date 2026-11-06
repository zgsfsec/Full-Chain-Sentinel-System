import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test } from "vitest";
import { handleReportApi } from "../src/report-api.ts";
import { portableReportMarkdown, reportZip, submitReport } from "../src/report-content.ts";
import { createReportTool } from "../src/report-tool.ts";
import { ReportStore } from "../src/reports.ts";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);
const provenance = {
	projectId: "p1",
	projectName: "项目一",
	source: "session" as const,
	sessionId: "s1",
	sessionName: "目标评估",
};
let root: string;
let workDir: string;
let store: ReportStore;
let server: Server | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-reports-"));
	workDir = join(root, "work");
	mkdirSync(workDir);
	store = new ReportStore(join(root, "reports.db"));
});
afterEach(async () => {
	if (server) {
		const closing = server;
		server = undefined;
		await new Promise<void>((resolve) => closing.close(() => resolve()));
	}
	store.close();
	rmSync(root, { recursive: true, force: true });
});

function submit(markdown: string, key = "call1") {
	return submitReport({ store, provenance, key, title: "安全测试报告", markdown, workDir });
}

test("project-scoped list, search, provenance, pagination and deletion survive reopen", async () => {
	const report = await submit("# 实际结论\n\n零确认漏洞。");
	store.save({
		provenance: { ...provenance, projectId: "p2", source: "engine", engineId: "e1", engineName: "工程甲" },
		key: "call1",
		title: "另一份",
		markdown: "body",
		images: [],
	});
	store.close();
	store = new ReportStore(join(root, "reports.db"));
	expect(store.get("p1", report.id)).toMatchObject({
		title: "安全测试报告",
		sessionName: "目标评估",
		source: "session",
	});
	expect(store.list("p1", { search: "目标评估" }).total).toBe(1);
	expect(store.list("p1", { source: "engine" }).total).toBe(0);
	expect(store.list("p1", { page: 999 }).page).toBe(1);
	expect(store.get("p2", report.id)).toBeUndefined();
	expect(store.delete("p2", report.id)).toBe(false);
	expect(store.delete("p1", report.id)).toBe(true);
	expect(store.list("p2").total).toBe(1);
});

test("local and reference-style images are snapshotted relative to the Markdown file and remain after workspace deletion", async () => {
	mkdirSync(join(workDir, "reports"));
	writeFileSync(join(workDir, "reports", "evidence.png"), png);
	const markdown =
		'# 测试\n\n![截图](evidence.png)\n\n![引用][Proof]\n\n[proof]: evidence.png "证据"\n\n```md\n![example](missing.png)\n```';
	writeFileSync(join(workDir, "reports", "final.md"), markdown);
	const report = await submitReport({
		store,
		provenance,
		key: "file",
		title: "归档",
		path: "/work/reports/final.md",
		workDir,
	});
	expect(report.imageCount).toBe(1);
	expect(report.images[0].mimeType).toBe("image/png");
	const portable = portableReportMarkdown(report);
	expect(portable).toContain(`![截图](images/${report.images[0].filename})`);
	expect(portable).toContain(`![引用](images/${report.images[0].filename} "证据")`);
	expect(portable).toContain("![example](missing.png)");
	rmSync(workDir, { recursive: true });
	store.close();
	store = new ReportStore(join(root, "reports.db"));
	expect(Buffer.from(store.image("p1", report.id, report.images[0].id)?.data ?? [])).toEqual(png);
	expect(store.image("p2", report.id, report.images[0].id)).toBeUndefined();
	expect(store.purgeProject("p1")).toBe(1);
	expect(store.image("p1", report.id, report.images[0].id)).toBeUndefined();
});

test("host paths, encoded names and inline base64 images are supported; first reference definition wins", async () => {
	writeFileSync(join(workDir, "证 据.png"), png);
	const report = await submit(
		`![路径](${encodeURI(join(workDir, "证 据.png"))})\n\n![引用][x]\n\n[x]: /work/证%20据.png\n[x]: missing.png\n\n![内联](data:image/png;base64,${png.toString("base64")})`,
	);
	expect(report.imageCount).toBe(3);
	for (const image of report.images)
		expect(Buffer.from(store.image("p1", report.id, image.id)?.data ?? [])).toEqual(png);
});

test("missing or invalid images fail atomically; the same call can be corrected and retried", async () => {
	writeFileSync(join(workDir, "good.png"), png);
	await expect(submit("![ok](good.png) ![missing](missing.png)")).rejects.toThrow("归档失败");
	expect(store.list("p1").total).toBe(0);
	writeFileSync(join(workDir, "missing.png"), png);
	const report = await submit("![ok](good.png) ![fixed](missing.png)");
	expect(report.imageCount).toBe(2);
	rmSync(workDir, { recursive: true });
	expect((await submit("changed")).id).toBe(report.id);
	expect(store.list("p1").total).toBe(1);
});

test("outside files, symlink escapes, external URLs, oversized bodies and non-images are rejected", async () => {
	writeFileSync(join(root, "outside.png"), png);
	symlinkSync(join(root, "outside.png"), join(workDir, "escape.png"));
	writeFileSync(join(workDir, "fake.png"), "not an image");
	for (const source of [
		join(root, "outside.png"),
		"/work/../outside.png",
		"escape.png",
		"https://example.com/image.png",
		"//example.com/image.png",
		"file:///etc/passwd",
		"fake.png",
	]) {
		await expect(submit(`![bad](${source})`)).rejects.toThrow();
	}
	await expect(submit("x".repeat(1024 * 1024 + 1))).rejects.toThrow("1 MB");
	await expect(submit("   ")).rejects.toThrow("不能为空");
	expect(store.list("p1").total).toBe(0);
});

test("tool uses its session provenance and returns an error instead of claiming a failed submission succeeded", async () => {
	let context: typeof provenance | undefined = provenance;
	const tool = createReportTool({ store, provenance: () => context, workDir });
	const unusedContext = {} as ExtensionToolContext;
	const success = await tool.execute(
		"tool1",
		{ title: "目标报告", markdown: "# 结果" },
		undefined,
		undefined,
		unusedContext,
	);
	expect(success.isError).not.toBe(true);
	expect(store.list("p1").items[0]).toMatchObject({ sessionId: "s1", projectId: "p1" });
	expect(
		(
			await tool.execute(
				"tool2",
				{ title: "缺图", markdown: "![missing](missing.png)" },
				undefined,
				undefined,
				unusedContext,
			)
		).isError,
	).toBe(true);
	context = undefined;
	expect(
		(await tool.execute("tool3", { title: "无项目", markdown: "body" }, undefined, undefined, unusedContext)).isError,
	).toBe(true);
	expect(store.list("p1").total).toBe(1);
});

test("HTTP routes scope every detail, image, download and delete to the requested existing project", async () => {
	writeFileSync(join(workDir, "proof.png"), png);
	const report = await submit("# 结论\n\n![截图](proof.png)");
	server = createServer((request, response) =>
		handleReportApi(request, response, store, (id) => ["p1", "p2"].includes(id)),
	);
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No HTTP address");
	const base = `http://127.0.0.1:${address.port}/api/reports`;
	expect((await fetch(base)).status).toBe(409);
	expect((await fetch(`${base}?projectId=p1&page=NaN`)).status).toBe(400);
	expect(await (await fetch(`${base}?projectId=p1`)).json()).toMatchObject({ total: 1 });
	for (const suffix of ["", "/download", `/images/${report.images[0].id}`]) {
		expect((await fetch(`${base}/${report.id}${suffix}?projectId=p2`)).status).toBe(404);
	}
	const image = await fetch(`${base}/${report.id}/images/${report.images[0].id}?projectId=p1`);
	expect(image.headers.get("content-type")).toBe("image/png");
	expect(image.headers.get("content-security-policy")).toContain("sandbox");
	expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
	const zip = await fetch(`${base}/${report.id}/download?projectId=p1`);
	expect(zip.headers.get("content-type")).toBe("application/zip");
	const bytes = Buffer.from(await zip.arrayBuffer());
	expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
	expect(bytes.includes(Buffer.from(portableReportMarkdown(report)))).toBe(true);
	expect(bytes.includes(png)).toBe(true);
	expect((await fetch(`${base}/${report.id}?projectId=p1`, { method: "DELETE" })).status).toBe(415);
	expect(
		(
			await fetch(`${base}/${report.id}?projectId=p1`, {
				method: "DELETE",
				headers: { "content-type": "application/json" },
			})
		).status,
	).toBe(200);
	expect((await fetch(`${base}/${report.id}?projectId=p1`)).status).toBe(404);
});

test("ZIP central directory and local headers describe exact stored contents and UTF-8 names", () => {
	const files = [
		{ name: "报告.md", data: Buffer.from("# 结果") },
		{ name: "images/proof.png", data: png },
	];
	const zip = reportZip(files);
	const end = zip.length - 22;
	expect(zip.readUInt32LE(end)).toBe(0x06054b50);
	expect(zip.readUInt16LE(end + 10)).toBe(2);
	let cursor = zip.readUInt32LE(end + 16);
	for (const file of files) {
		expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
		expect(zip.readUInt16LE(cursor + 8)).toBe(0x0800);
		const local = zip.readUInt32LE(cursor + 42);
		const nameSize = zip.readUInt16LE(cursor + 28);
		expect(zip.subarray(cursor + 46, cursor + 46 + nameSize).toString()).toBe(file.name);
		const dataStart = local + 30 + zip.readUInt16LE(local + 26);
		expect(zip.subarray(dataStart, dataStart + zip.readUInt32LE(local + 22))).toEqual(file.data);
		cursor += 46 + nameSize;
	}
	expect(cursor).toBe(end);
});
