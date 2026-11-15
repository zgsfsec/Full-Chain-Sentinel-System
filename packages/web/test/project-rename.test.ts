import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { withGatewayLock } from "../src/gateway.ts";
import { addProject, listProjects, renameProject, type SentinelProject } from "../src/projects.ts";
import { installFakeDocker } from "./fake-docker.ts";

let root: string;
let original: SentinelProject;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-project-rename-"));
	original = {
		id: "p1",
		name: "原项目",
		container: "sentinel-p1",
		workDir: join(root, "projects", "原项目"),
		createdAt: "2026-01-01T00:00:00Z",
		manualStop: true,
		proxyId: null,
		egressIp: { ip: "203.0.113.1", location: "Test", testedAt: 1 },
	};
	writeFileSync(
		join(root, "projects.json"),
		JSON.stringify({
			projects: [original, { ...original, id: "p2", name: "其他项目", workDir: join(root, "other") }],
			lastActiveProjectId: "p1",
		}),
	);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("renaming trims the name and preserves identity, directory, settings and active selection", async () => {
	const result = await renameProject(root, "p1", "  新项目  ");
	expect(result).toEqual({ project: { ...original, name: "新项目" } });
	const saved = listProjects(root);
	expect(saved.projects[0]).toEqual({ ...original, name: "新项目" });
	expect(saved.lastActiveProjectId).toBe("p1");
	expect(await renameProject(root, "p1", "新项目")).toEqual(result);
});

test("blank, duplicate and missing projects fail without writing the registry", async () => {
	const before = readFileSync(join(root, "projects.json"), "utf8");
	expect(await renameProject(root, "p1", " \n ")).toEqual({ error: "项目名称不能为空" });
	expect(await renameProject(root, "p1", "  其他项目 ")).toEqual({ error: "已存在同名项目" });
	expect(await renameProject(root, "missing", "新项目")).toEqual({ error: "项目不存在" });
	expect(readFileSync(join(root, "projects.json"), "utf8")).toBe(before);
});

test("rename waits for an in-flight container operation on the project", async () => {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const operation = withGatewayLock(`${root}:p1`, () => held);
	const renaming = renameProject(root, "p1", "新项目");
	expect(listProjects(root).projects[0]?.name).toBe("原项目");
	release();
	await operation;
	expect((await renaming).project?.name).toBe("新项目");
});

test("creating a project with a renamed project's old name uses an independent directory", async () => {
	const docker = installFakeDocker(root, original.workDir);
	try {
		await renameProject(root, "p1", "新项目");
		const created = await addProject(root, { name: "原项目" });
		expect(created.error).toBeUndefined();
		expect(created.project?.workDir).not.toBe(original.workDir);
		expect(listProjects(root).projects[0]?.workDir).toBe(original.workDir);
	} finally {
		docker.restore();
	}
});
