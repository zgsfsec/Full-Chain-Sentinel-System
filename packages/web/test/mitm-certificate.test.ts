import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { runDocker } from "../src/docker.ts";
import { MitmCenter } from "../src/mitm.ts";
import * as certificates from "../src/mitm-certificate.ts";
import {
	addProject,
	ensureProjectReady,
	recreateProject,
	removeProject,
	startProject,
	stopProject,
} from "../src/projects.ts";
import * as replayd from "../src/replayd-binary.ts";
import { installFakeDocker } from "./fake-docker.ts";

let fixtures: string;
let root: string;
let pem: string;

beforeAll(() => {
	fixtures = mkdtempSync(join(tmpdir(), "sentinel-mitm-ca-fixture-"));
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=MITM test",
			"-addext",
			"basicConstraints=critical,CA:TRUE",
			"-keyout",
			join(fixtures, "key.pem"),
			"-out",
			join(fixtures, "ca.pem"),
		],
		{ stdio: "ignore" },
	);
	pem = readFileSync(join(fixtures, "ca.pem"), "utf8");
});

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-mitm-ca-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

test("installs only the matching project's public CA; stopped work containers are deferred", async () => {
	const path = join(certificates.projectMitmDirectory(root, "a"), "ca");
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "ca.crt"), pem);
	writeFileSync(join(path, "ca.key"), "never-copy-private-key");
	const calls: string[][] = [];
	let running = true;
	const docker: typeof runDocker = async (args) => {
		calls.push(args);
		return { code: 0, stdout: args[0] === "inspect" ? String(running) : "", stderr: "" };
	};
	await certificates.installProjectMitmCa(root, { id: "a", container: "work-a" }, docker);
	expect(calls[0]).toEqual(["inspect", "--format", "{{.State.Running}}", "work-a"]);
	expect(calls[1].slice(0, 7)).toEqual(["exec", "--user", "0", "work-a", "python3", "-c", expect.any(String)]);
	const copied = Buffer.from(calls[1][7], "base64").toString();
	expect(new X509Certificate(copied).fingerprint256).toBe(new X509Certificate(pem).fingerprint256);
	expect(copied).not.toContain("PRIVATE KEY");
	expect(calls.flat().join(" ")).not.toContain("never-copy-private-key");
	expect(calls[1][6]).toContain("update-ca-certificates");
	const before = calls.length;
	await certificates.installProjectMitmCa(root, { id: "b", container: "work-b" }, docker);
	expect(calls).toHaveLength(before);
	running = false;
	await certificates.installProjectMitmCa(root, { id: "a", container: "work-a" }, docker);
	expect(calls).toHaveLength(before + 1);
});

test("clear's rotated directory is respected, and installation failures are not silently accepted", async () => {
	const projectRoot = join(root, "mitm", "a");
	const data = "data-12345678-1234-1234-1234-123456789abc";
	mkdirSync(join(projectRoot, data, "ca"), { recursive: true });
	writeFileSync(join(projectRoot, "capture.json"), JSON.stringify(data));
	writeFileSync(join(projectRoot, data, "ca", "ca.crt"), pem);
	const docker: typeof runDocker = async (args) =>
		args[0] === "inspect"
			? { code: 0, stdout: "true", stderr: "" }
			: { code: 1, stdout: "", stderr: "update-ca-certificates failed" };
	await expect(certificates.installProjectMitmCa(root, { id: "a", container: "work-a" }, docker)).rejects.toThrow(
		"MITM CA 自动安装失败",
	);
	writeFileSync(join(projectRoot, "capture.json"), JSON.stringify("../../other"));
	expect(() => certificates.projectMitmDirectory(root, "a")).toThrow("索引损坏");
	expect(() => certificates.projectMitmDirectory(root, "../a")).toThrow();
});

test("starting an already running MITM worker repairs trust in its registered work container", async () => {
	const owner = createHash("sha256")
		.update(`${join(root, "mitm")}/a`)
		.digest("hex");
	let installed = false;
	const docker: typeof runDocker = async (args) => {
		if (args[0] === "inspect" && args[1] === "--format") return { code: 0, stdout: "true", stderr: "" };
		if (args[0] === "exec") {
			installed = true;
			expect(args[3]).toBe("work-a");
			return { code: 0, stdout: "", stderr: "" };
		}
		return {
			code: 0,
			stderr: "",
			stdout: JSON.stringify([
				{
					Config: { Labels: { "sentinel.mitm.owner": owner } },
					State: { Running: true },
					NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "18080" }] } },
				},
			]),
		};
	};
	const center = new MitmCenter(root, () => [{ id: "a", name: "A", container: "work-a" }], docker);
	const path = join(center.directory("a"), "ca");
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "ca.crt"), pem);
	expect((await center.start("a")).state).toBe("running");
	expect(installed).toBe(true);
});

test.each([false, true])(
	"saving during capture applies settings and restores the old proxy on failure: %s",
	async (fail) => {
		vi.spyOn(replayd, "readReplaydBinary").mockReturnValue({
			path: "fixture",
			bytes: Buffer.from("fixture"),
			sha256: "fixture",
			source: "env",
			arch: "amd64",
		});
		const owner = createHash("sha256")
			.update(`${join(root, "mitm")}/a`)
			.digest("hex");
		let running = false;
		let attempts = 0;
		let port = 18080;
		const calls: string[][] = [];
		const docker: typeof runDocker = async (args) => {
			calls.push(args);
			if (args[0] === "inspect")
				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify([
						{
							Config: { Labels: { "sentinel.mitm.owner": owner } },
							State: { Running: running },
							NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: String(port) }] } },
						},
					]),
				};
			if (args[0] === "image") return { code: 0, stdout: "amd64", stderr: "" };
			if (args[0] === "stop") running = false;
			if (args[0] === "run") {
				attempts++;
				if (fail && attempts === 1) return { code: 1, stdout: "", stderr: "port is already allocated" };
				port = Number(args[args.indexOf("-p") + 1].split(":")[1]);
				running = true;
			}
			return { code: 0, stdout: "", stderr: "" };
		};
		const center = new MitmCenter(root, () => [{ id: "a", name: "A" }], docker);
		await center.save("a", { bind: "127.0.0.1", port: 18080 });
		const ca = join(center.directory("a"), "ca");
		mkdirSync(ca, { recursive: true });
		writeFileSync(join(ca, "ca.crt"), pem);
		writeFileSync(join(center.directory("a"), "keep-history"), "history");
		running = true;
		const before = calls.length;
		await expect(center.save("a", { bind: "127.0.0.1", port: -1 })).rejects.toThrow();
		expect(calls.slice(before).every((call) => call[0] === "inspect")).toBe(true);
		await center.save("a", { bind: "127.0.0.1", port: 18080 });
		expect(attempts).toBe(0);
		const saving = center.save("a", { bind: "0.0.0.0", port: 18081, skipStatic: false, maxCaptureMb: 8 });
		if (fail) await expect(saving).rejects.toThrow("已恢复原配置和代理");
		else
			await expect(saving).resolves.toMatchObject({
				state: "running",
				config: { port: 18081, skipStatic: false, maxCaptureMb: 8 },
			});
		expect((await center.status("a")).config.port).toBe(fail ? 18080 : 18081);
		expect(running).toBe(true);
		expect(readFileSync(join(ca, "ca.crt"), "utf8")).toBe(pem);
		expect(readFileSync(join(center.directory("a"), "keep-history"), "utf8")).toBe("history");
		expect(attempts).toBe(fail ? 2 : 1);
		const launch = calls.filter((call) => call[0] === "run")[0];
		expect(launch).toContain("-proxy-skip-static=false");
		expect(launch[launch.indexOf("-proxy-max-capture-bytes") + 1]).toBe(String(8 * 1024 * 1024));
	},
);

test("work container start, readiness, recreation and removed-container recovery all install the project CA", async () => {
	const fake = installFakeDocker(root, join(root, "projects", "demo"));
	const install = vi.spyOn(certificates, "installProjectMitmCa").mockResolvedValue();
	try {
		const added = await addProject(root, { name: "demo" });
		const project = added.project;
		if (!project) throw new Error(added.error);
		await stopProject(root, project.id);
		expect((await startProject(root, project.id)).error).toBeUndefined();
		expect(await ensureProjectReady(project, root)).toBe(true);
		expect((await recreateProject(root, project.id)).error).toBeUndefined();
		await removeProject(root, project.id, "container");
		expect((await startProject(root, project.id)).created).toBe(true);
		expect(install).toHaveBeenCalledTimes(4);
		for (const call of install.mock.calls)
			expect(call).toEqual([root, expect.objectContaining({ id: project.id, container: project.container })]);
	} finally {
		fake.restore();
	}
});
