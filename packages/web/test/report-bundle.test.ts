import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildReportBundle } from "../src/report-bundle.ts";
import { portableReportMarkdown, submitReport, validateReportEdit } from "../src/report-content.ts";
import type { ReportProvenance } from "../src/report-types.ts";
import { ReportStore } from "../src/reports.ts";
import { VulnerabilityStore, vulnerabilityDbPath } from "../src/vulnerabilities.ts";

let root: string;
let workDir: string;
let reports: ReportStore;
let vulnerabilities: VulnerabilityStore;
const provenance: ReportProvenance = { projectId: "p1", projectName: "项目", source: "session", sessionId: "s1" };
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-report-bundle-"));
	workDir = join(root, "work");
	mkdirSync(workDir);
	reports = new ReportStore(join(root, "reports.db"));
	vulnerabilities = new VulnerabilityStore(vulnerabilityDbPath(root));
});

afterEach(() => {
	reports.close();
	vulnerabilities.close();
	rmSync(root, { recursive: true, force: true });
});

function finding(
	overrides: { projectId?: string; sessionId?: string; engineId?: string; taskId?: string; packet?: string } = {},
) {
	return vulnerabilities.create({
		projectId: "p1",
		projectName: "项目",
		sessionId: "s1",
		source: "主代理",
		title: "访问控制缺失",
		severity: "high",
		cvss: 7.5,
		target: "https://example.test/api",
		description: "已验证的测试记录",
		packet: "GET /api HTTP/1.1\r\nHost: example.test\r\n\r\n",
		repro: "使用已保存的脚本复现。",
		evidence: [
			{ kind: "command", command: "python reproduce.py", output: "HTTP/1.1 200 OK\r\n\r\n原始响应\n" },
			{ kind: "file", path: "/work/reproduce.py" },
			{ kind: "file", path: "/work/proof.png" },
		],
		...overrides,
	});
}

function zipFiles(zip: Buffer): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	const end = zip.length - 22;
	let cursor = zip.readUInt32LE(end + 16);
	for (let index = 0; index < zip.readUInt16LE(end + 10); index++) {
		expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
		const local = zip.readUInt32LE(cursor + 42);
		const nameSize = zip.readUInt16LE(cursor + 28);
		const name = zip.subarray(cursor + 46, cursor + 46 + nameSize).toString("utf8");
		const start = local + 30 + zip.readUInt16LE(local + 26);
		files.set(name, zip.subarray(start, start + zip.readUInt32LE(local + 22)));
		cursor += 46 + nameSize + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
	}
	return files;
}

function manifest(files: Map<string, Buffer>): {
	vulnerabilities: { id: string; label: string; directory: string }[];
	warnings: { source: string; reason: string }[];
} {
	return JSON.parse(files.get("manifest.json")?.toString() ?? "{}");
}

test("ZIP snapshots Markdown, images, linked scripts, explicit files and exact vulnerability packets/outputs", async () => {
	const script = "print('本地复现脚本')\n";
	const response = Buffer.from([0, 13, 10, 255, 65]);
	writeFileSync(join(workDir, "reproduce.py"), script);
	writeFileSync(join(workDir, "proof.png"), png);
	writeFileSync(join(workDir, "response.bin"), response);
	const relevant = finding();
	finding({ projectId: "p2", packet: "FOREIGN_PROJECT_SECRET" });
	finding({ sessionId: "other-session", packet: "OTHER_SESSION_SECRET" });
	const report = await submitReport({
		store: reports,
		provenance,
		key: "first",
		title: "完整报告",
		workDir,
		markdown:
			"# 结论\n\n![截图](proof.png)\n\n[复现脚本][script]\n\n[script]: reproduce.py\n\n```md\n[example](missing.py)\n```",
		attachments: ["/work/response.bin"],
	});
	const linked = report.attachments.find((file) => file.source === "reproduce.py");
	expect(linked).toBeDefined();
	expect(portableReportMarkdown(report)).toContain(`[复现脚本](${linked?.filename})`);
	expect(portableReportMarkdown(report)).toContain("[example](missing.py)");
	const attachmentId = report.attachments[0].id;
	expect(reports.attachment("p2", report.id, attachmentId)).toBeUndefined();
	rmSync(workDir, { recursive: true });
	vulnerabilities.delete(relevant.id);
	reports.close();
	reports = new ReportStore(join(root, "reports.db"));
	const archived = reports.get("p1", report.id);
	if (!archived) throw new Error("Missing archived report");
	const files = zipFiles(await buildReportBundle(reports, archived));
	expect(files.get("report.md")?.toString()).toBe(portableReportMarkdown(archived));
	expect(files.get(`images/${report.images[0].filename}`)).toEqual(png);
	expect(files.get(linked?.filename ?? "")?.toString()).toBe(script);
	expect(files.get(report.attachments.find((file) => file.source === "/work/response.bin")?.filename ?? "")).toEqual(
		response,
	);
	expect(files.get(`vulnerabilities/${relevant.id}/packet.txt`)?.toString()).toBe(relevant.packet);
	expect(files.get(`vulnerabilities/${relevant.id}/evidence/1-output.txt`)?.toString()).toBe(
		relevant.evidence[0].output,
	);
	expect(manifest(files).vulnerabilities.map((entry) => entry.id)).toEqual([relevant.id]);
	expect(manifest(files).warnings).toEqual([]);
	for (const name of files.keys()) expect(name.startsWith("/") || name.split("/").includes("..")).toBe(false);
	expect(Buffer.concat([...files.values()]).toString()).not.toContain("FOREIGN_PROJECT_SECRET");
	expect(Buffer.concat([...files.values()]).toString()).not.toContain("OTHER_SESSION_SECRET");
	expect(reports.delete("p1", report.id)).toBe(true);
	expect(reports.attachment("p1", report.id, attachmentId)).toBeUndefined();
});

test("engine totals include all their tasks while task reports exclude other tasks and engines", async () => {
	writeFileSync(join(workDir, "reproduce.py"), "script");
	writeFileSync(join(workDir, "proof.png"), png);
	const first = finding({ engineId: "e1", taskId: "t1" });
	const second = finding({ engineId: "e1", taskId: "t2" });
	finding({ engineId: "e2", taskId: "t1" });
	for (const [key, taskId, expected] of [
		["engine", undefined, [first.id, second.id]],
		["task", "t1", [first.id]],
	] as const) {
		const report = await submitReport({
			store: reports,
			provenance: { ...provenance, source: "engine", engineId: "e1", taskId },
			key,
			title: key,
			markdown: "# 工程结果",
			workDir,
		});
		expect(
			manifest(zipFiles(await buildReportBundle(reports, report)))
				.vulnerabilities.map((entry) => entry.id)
				.sort(),
		).toEqual([...expected].sort());
	}
});

test("missing, oversized, outside and symlink evidence becomes a manifest warning without reading external URLs", async () => {
	writeFileSync(join(root, "outside.txt"), "HOST_SECRET");
	symlinkSync(join(root, "outside.txt"), join(workDir, "escape.txt"));
	writeFileSync(join(workDir, "large.bin"), "");
	truncateSync(join(workDir, "large.bin"), 16 * 1024 * 1024 + 1);
	const report = await submitReport({
		store: reports,
		provenance,
		key: "missing",
		title: "缺失材料",
		workDir,
		markdown: "[missing](missing.txt) [escape](escape.txt) [large](large.bin) [remote](https://example.test/file.py)",
		attachments: [join(root, "outside.txt")],
	});
	const files = zipFiles(await buildReportBundle(reports, report));
	expect(files.size).toBe(2);
	expect(manifest(files).warnings).toHaveLength(4);
	expect(manifest(files).warnings.some((entry) => entry.source.includes("https://"))).toBe(false);
	expect(Buffer.concat([...files.values()]).toString()).not.toContain("HOST_SECRET");
	expect(() => validateReportEdit(report, "修改", "[new](new.py)")).toThrow("附件尚未归档");
	expect(() => validateReportEdit(report, "修改", report.markdown)).not.toThrow();
});

test("older reports collect surviving files and associated findings at download, including reports without images", async () => {
	writeFileSync(join(workDir, "reproduce.py"), "legacy script");
	writeFileSync(join(workDir, "proof.png"), png);
	const relevant = finding();
	writeFileSync(join(root, "projects.json"), JSON.stringify({ projects: [{ id: "p1", workDir }] }));
	const report = reports.save({
		provenance,
		key: "legacy",
		title: "旧报告",
		markdown: "[脚本](reproduce.py)",
		images: [],
	});
	expect(report.attachments).toEqual([]);
	const files = zipFiles(await buildReportBundle(reports, report));
	expect([...files.keys()].some((name) => name.endsWith("/reproduce.py"))).toBe(true);
	expect(files.get(`vulnerabilities/${relevant.id}/packet.txt`)?.toString()).toBe(relevant.packet);
	expect(manifest(files).warnings).toEqual([]);
	expect(reports.get("p1", report.id)?.attachments).toEqual([]);
});

test("relative encoded links preserve formatted labels and raw attachment paths preserve percent/hash characters", async () => {
	mkdirSync(join(workDir, "reports"));
	const name = "复现 (1)#%.py";
	writeFileSync(join(workDir, "reports", name), "exact script\n");
	const source = encodeURIComponent(name);
	writeFileSync(join(workDir, "reports", "final.md"), `[**复现脚本**](${source})`);
	const report = await submitReport({
		store: reports,
		provenance,
		key: "encoded",
		title: "特殊文件名",
		path: "/work/reports/final.md",
		workDir,
		attachments: [`/work/reports/${name}`],
	});
	const files = zipFiles(await buildReportBundle(reports, report));
	expect(manifest(files).warnings).toEqual([]);
	expect(files.get("report.md")?.toString()).toContain("[**复现脚本**](attachments/");
	expect(files.get("report.md")?.toString()).toContain("%281%29%23%25.py)");
	expect(
		report.attachments.filter((file) => file.source === source || file.source === `/work/reports/${name}`),
	).toHaveLength(2);
	for (const [path, data] of files) if (path.endsWith(name)) expect(data.toString()).toBe("exact script\n");
});
