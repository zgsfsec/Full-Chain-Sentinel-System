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
