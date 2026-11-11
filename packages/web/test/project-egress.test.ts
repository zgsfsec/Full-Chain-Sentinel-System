import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as docker from "../src/docker.ts";
import { setServerLanguage } from "../src/i18n.ts";
import { handleProjectEgressApi, testProjectEgressIp } from "../src/project-egress.ts";
import { listProjects, type SentinelProject, setLastActiveProject } from "../src/projects.ts";

let root: string;
let server: Server | undefined;
const oldResult = { ip: "8.8.8.8", location: "美国 加利福尼亚州", testedAt: 1 };
const geoResponse = "1.1.1.1\n中国 香港\nAS13335\nCloudflare, Inc.\n";

function seed(overrides: Partial<SentinelProject> = {}): void {
	writeFileSync(
		join(root, "projects.json"),
		JSON.stringify({
			projects: [
				{ id: "one", name: "One", container: "project-one", workDir: "/work/one", createdAt: "", ...overrides },
				{ id: "two", name: "Two", container: "project-two", workDir: "/work/two", createdAt: "" },
			],
		}),
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-project-egress-"));
	setServerLanguage("zh");
	seed();
});

afterEach(async () => {
	if (server?.listening)
		await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
	server = undefined;
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

test("probes ping0 inside the selected container and persists IP and location across project switches and reads", async () => {
	const run = vi.spyOn(docker, "runDocker").mockResolvedValue({ code: 0, stdout: geoResponse, stderr: "" });
	const result = await testProjectEgressIp(root, "one");
	expect(result).toEqual({ ip: "1.1.1.1", location: "中国 香港", testedAt: expect.any(Number) });
	expect(run.mock.calls[0]?.[0]).toEqual([
		"exec",
		"project-one",
		"curl",
		"--disable",
		"--fail",
		"--silent",
		"--show-error",
		"--connect-timeout",
		"4",
		"--max-time",
		"8",
		"--max-filesize",
		"4096",
		"https://ping0.cc/geo",
	]);
	setLastActiveProject(root, "two");
	expect(listProjects(root).projects.find((project) => project.id === "two")?.egressIp).toBeUndefined();
	setLastActiveProject(root, "one");
	expect(listProjects(root).projects[0]?.egressIp).toEqual(result);
	expect(JSON.parse(readFileSync(join(root, "projects.json"), "utf8")).projects[0].egressIp).toEqual(result);
	expect(run).toHaveBeenCalledTimes(1);

	run.mockResolvedValue({ code: 0, stdout: "9.9.9.9\n美国 加利福尼亚州\nAS19281\nQuad9\n", stderr: "" });
	const next = await testProjectEgressIp(root, "one");
	expect(next.ip).toBe("9.9.9.9");
	expect(next.location).toBe("美国 加利福尼亚州");
	expect(listProjects(root).projects[0]?.egressIp).toEqual(next);
	expect(run).toHaveBeenCalledTimes(2);
});

test("accepts IPv6 with a location and Windows line endings", async () => {
	const run = vi.spyOn(docker, "runDocker").mockResolvedValue({
		code: 0,
		stdout: " 2606:4700:4700::1111 \r\n 中国 河南省 郑州市 \r\nAS13335\r\nCloudflare\r\n",
		stderr: "",
	});
	expect(await testProjectEgressIp(root, "two")).toEqual({
		ip: "2606:4700:4700::1111",
		location: "中国 河南省 郑州市",
		testedAt: expect.any(Number),
	});
	expect(run).toHaveBeenCalledTimes(1);
	expect(run.mock.calls[0]?.[0].slice(0, 2)).toEqual(["exec", "project-two"]);
});

test.each([
	{ code: 0, stdout: "<html>unavailable</html>", stderr: "" },
	{ code: 22, stdout: geoResponse, stderr: "HTTP 503" },
	{ code: 0, stdout: "1.1.1.1\n", stderr: "" },
	{ code: 0, stdout: "invalid-ip\n中国 香港\n", stderr: "" },
	{ code: 0, stdout: "1.1.1.1\n   \nAS13335\n", stderr: "" },
])("rejects incomplete or failed geo responses and retains the saved result: %j", async (response) => {
	seed({ egressIp: oldResult });
	const run = vi.spyOn(docker, "runDocker").mockResolvedValue(response);
	await expect(testProjectEgressIp(root, "one")).rejects.toThrow("公网 IP 测试失败");
	expect(run).toHaveBeenCalledTimes(1);
	expect(listProjects(root).projects[0]?.egressIp).toEqual(oldResult);
});

test("failed retests preserve the last successful result and allow another attempt", async () => {
	seed({ egressIp: oldResult });
	const run = vi.spyOn(docker, "runDocker").mockResolvedValue({ code: 28, stdout: "", stderr: "timeout" });
	await expect(testProjectEgressIp(root, "one")).rejects.toThrow("公网 IP 测试失败");
	expect(listProjects(root).projects[0]?.egressIp).toEqual(oldResult);
	run.mockResolvedValue({ code: 0, stdout: geoResponse, stderr: "" });
	expect((await testProjectEgressIp(root, "one")).ip).toBe("1.1.1.1");
});

test("simultaneous requests share a probe and cannot overwrite another project's data", async () => {
	let finish: ((value: Awaited<ReturnType<typeof docker.runDocker>>) => void) | undefined;
	const run = vi.spyOn(docker, "runDocker").mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const first = testProjectEgressIp(root, "one");
	const second = testProjectEgressIp(root, "one");
	expect(first).toBe(second);
	await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
	setLastActiveProject(root, "two");
	finish?.({ code: 0, stdout: geoResponse, stderr: "" });
	await first;
	expect(listProjects(root).lastActiveProjectId).toBe("two");
	expect(listProjects(root).projects[1]?.egressIp).toBeUndefined();
});

test("missing and manually stopped projects do not run commands", async () => {
	seed({ manualStop: true, egressIp: oldResult });
	const run = vi.spyOn(docker, "runDocker");
	await expect(testProjectEgressIp(root, "missing")).rejects.toThrow("项目不存在");
	await expect(testProjectEgressIp(root, "one")).rejects.toThrow("请先启动项目容器");
	expect(run).not.toHaveBeenCalled();
	expect(listProjects(root).projects[0]?.egressIp).toEqual(oldResult);
});

test("a project deleted during a probe is not resurrected when the probe finishes", async () => {
	vi.spyOn(docker, "runDocker").mockImplementation(async () => {
		writeFileSync(join(root, "projects.json"), JSON.stringify({ projects: [] }));
		return { code: 0, stdout: geoResponse, stderr: "" };
	});
	await expect(testProjectEgressIp(root, "one")).rejects.toThrow("项目不存在");
	expect(listProjects(root).projects).toEqual([]);
});

test("HTTP GET only restores saved data; POST explicitly probes and returns the saved result", async () => {
	seed({ egressIp: oldResult });
	const run = vi.spyOn(docker, "runDocker").mockResolvedValue({ code: 0, stdout: geoResponse, stderr: "" });
	server = createServer((request, response) => {
		void handleProjectEgressApi(request, response, root);
	});
	await new Promise<void>((resolve, reject) => {
		server?.once("error", reject);
		server?.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing HTTP address");
	const url = `http://127.0.0.1:${address.port}/api/projects/egress-ip?projectId=one`;
	const saved = await fetch(url);
	expect(saved.headers.get("cache-control")).toBe("no-store");
	expect(await saved.json()).toEqual({ result: oldResult });
	expect(await (await fetch(url.replace("projectId=one", "projectId=two"))).json()).toEqual({ result: null });
	expect(run).not.toHaveBeenCalled();
	const tested = await fetch(url, { method: "POST" });
	expect(tested.status).toBe(200);
	expect(await tested.json()).toEqual({ result: listProjects(root).projects[0]?.egressIp });
	expect(run).toHaveBeenCalledTimes(1);
	run.mockResolvedValue({ code: 28, stdout: "", stderr: "timeout" });
	const failed = await fetch(url, { method: "POST" });
	expect(failed.status).toBe(502);
	expect(await failed.json()).toEqual({ error: expect.stringContaining("公网 IP 测试失败") });
	expect(await (await fetch(url)).json()).toEqual({ result: listProjects(root).projects[0]?.egressIp });
	expect(listProjects(root).projects[0]?.egressIp?.ip).toBe("1.1.1.1");
	expect(listProjects(root).projects[0]?.egressIp?.location).toBe("中国 香港");
	expect((await fetch(url, { method: "DELETE" })).status).toBe(405);
	expect((await fetch(url.replace("projectId=one", "projectId=unknown"))).status).toBe(404);
});
