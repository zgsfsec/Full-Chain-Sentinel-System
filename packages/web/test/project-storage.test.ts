import { linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionDirPath } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as docker from "../src/docker.ts";
import { measureProjectStorage, ProjectStorageCache } from "../src/project-storage.ts";
import type { ProjectStorageUsage } from "../src/project-storage-types.ts";
import { singboxContainerNameFor } from "../src/singbox.ts";

let root: string;
const caches: ProjectStorageCache[] = [];
const project = { id: "project-one", container: "work-one", workDir: "" };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-storage-"));
	project.workDir = join(root, "work");
	mkdirSync(project.workDir);
	vi.spyOn(docker, "runDocker").mockResolvedValue({
		code: 0,
		stdout: `/work-one\t1024\n/${singboxContainerNameFor(project.id)}\t512\n`,
		stderr: "",
	});
});

afterEach(() => {
	for (const cache of caches.splice(0)) cache.dispose();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

test("counts allocated project files, sessions, captures, gateway and proxy files with writable layers", async () => {
	const sessionDir = getSessionDirPath(project.workDir, root);
	const captureDir = join(root, "mitm", project.id);
	const gatewayDir = join(root, "gateways", project.id);
	const paths = [project.workDir, sessionDir, captureDir, gatewayDir];
	for (const directory of paths) {
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "data"), "saved project data");
	}
	mkdirSync(join(root, "proxy"));
	const proxyPath = join(root, "proxy", `${project.id}.json`);
	writeFileSync(proxyPath, "{}");
	// Shared data and other projects must not inflate this project's size.
	writeFileSync(join(root, "shared.db"), Buffer.alloc(1024 * 1024));
	mkdirSync(join(root, "mitm", "other-project"));
	writeFileSync(join(root, "mitm", "other-project", "data"), Buffer.alloc(1024 * 1024));
	const hostBytes = [...paths.flatMap((directory) => [directory, join(directory, "data")]), proxyPath].reduce(
		(sum, path) => sum + lstatSync(path).blocks * 512,
		0,
	);
	const usage = await measureProjectStorage(root, project);
	expect(usage).toEqual({
		bytes: hostBytes + 1536,
		hostBytes,
		containerBytes: 1536,
		partial: false,
		measuredAt: expect.any(Number),
	});
	expect(docker.runDocker).toHaveBeenCalledWith(
		[
			"container",
			"inspect",
			"--size",
			"--format",
			"{{.Name}}\t{{.SizeRw}}",
			"work-one",
			singboxContainerNameFor(project.id),
		],
		expect.objectContaining({ timeoutMs: 15000 }),
	);
});

test("does not follow symlinks or count hard links and overlapping roots twice", async () => {
	const file = join(project.workDir, "data");
	writeFileSync(file, "unique data");
	linkSync(file, join(project.workDir, "hard-link"));
	const outside = join(root, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "large"), Buffer.alloc(1024 * 1024));
	const symlink = join(project.workDir, "external-link");
	symlinkSync(outside, symlink, "dir");
	const hostBytes = [project.workDir, file, symlink].reduce((sum, path) => sum + lstatSync(path).blocks * 512, 0);
	const usage = await measureProjectStorage(root, project);
	expect(usage.hostBytes).toBe(hostBytes);
	expect(usage.partial).toBe(false);
	// The configured work directory can overlap a second counted root.
	const overlapping = { ...project, workDir: join(root, "mitm", project.id) };
	mkdirSync(overlapping.workDir, { recursive: true });
	writeFileSync(join(overlapping.workDir, "data"), "capture");
	expect((await measureProjectStorage(root, overlapping)).hostBytes).toBe(
		lstatSync(overlapping.workDir).blocks * 512 + lstatSync(join(overlapping.workDir, "data")).blocks * 512,
	);
});

test("missing containers count as zero; unavailable Docker and invalid sizes yield partial estimates", async () => {
	vi.mocked(docker.runDocker).mockResolvedValue({
		code: 1,
		stdout: "/work-one\t1024\n",
		stderr: `Error: No such object: ${singboxContainerNameFor(project.id)}\n`,
	});
	expect(await measureProjectStorage(root, project)).toMatchObject({ containerBytes: 1024, partial: false });
	vi.mocked(docker.runDocker).mockResolvedValue({
		code: 1,
		stdout: "",
		stderr: "Cannot connect to the Docker daemon",
	});
	expect(await measureProjectStorage(root, project)).toMatchObject({ containerBytes: 0, partial: true });
	vi.mocked(docker.runDocker).mockResolvedValue({ code: 0, stdout: "/work-one\t<no value>\n", stderr: "" });
	expect(await measureProjectStorage(root, project)).toMatchObject({ containerBytes: 0, partial: true });
});

test("unreadable directory paths preserve known sizes and mark the result partial", async () => {
	mkdirSync(join(root, "mitm"));
	writeFileSync(join(root, "mitm", project.id), "this should have been a directory");
	// A path component that is a file produces ENOTDIR for the session directory.
	writeFileSync(join(root, "sessions"), "invalid session root");
	expect(await measureProjectStorage(root, project)).toMatchObject({ partial: true, containerBytes: 1536 });
});

test("list requests share background scans and cached results expire after 30 seconds", async () => {
	let finish: ((usage: ProjectStorageUsage) => void) | undefined;
	const measure = vi.fn<typeof measureProjectStorage>(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const changed = vi.fn();
	const cache = new ProjectStorageCache(root, changed, measure);
	caches.push(cache);
	expect(cache.get(project)).toBeUndefined();
	expect(cache.get(project)).toBeUndefined();
	expect(measure).toHaveBeenCalledTimes(1);
	const usage = { bytes: 4096, hostBytes: 3072, containerBytes: 1024, partial: false, measuredAt: Date.now() };
	finish?.(usage);
	await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
	expect(cache.get(project)).toBe(usage);
	expect(measure).toHaveBeenCalledTimes(1);
	vi.spyOn(Date, "now").mockReturnValue(usage.measuredAt + 30001);
	cache.get(project, false);
	expect(measure).toHaveBeenCalledTimes(1);
	expect(cache.get(project)).toBe(usage);
	expect(measure).toHaveBeenCalledTimes(2);
});

test("bounds concurrency and discards deleted projects and late results after shutdown", async () => {
	const completions: Array<(usage: ProjectStorageUsage) => void> = [];
	const measure = vi.fn<typeof measureProjectStorage>(
		() =>
			new Promise((resolve) => {
				completions.push(resolve);
			}),
	);
	const changed = vi.fn();
	const cache = new ProjectStorageCache(root, changed, measure);
	caches.push(cache);
	for (const id of ["one", "two", "three"]) cache.get({ ...project, id });
	expect(measure).toHaveBeenCalledTimes(2);
	cache.retain(new Set(["two", "three"]));
	const usage = { bytes: 0, hostBytes: 0, containerBytes: 0, partial: false, measuredAt: Date.now() };
	completions[0]?.(usage);
	await vi.waitFor(() => expect(measure).toHaveBeenCalledTimes(3));
	expect(changed).not.toHaveBeenCalled();
	cache.dispose();
	completions[1]?.(usage);
	completions[2]?.(usage);
	await Promise.resolve();
	await Promise.resolve();
	expect(changed).not.toHaveBeenCalled();
});
