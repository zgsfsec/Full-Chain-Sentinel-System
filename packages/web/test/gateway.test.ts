import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as docker from "../src/docker.ts";
import { checkEnvironment } from "../src/env-check.ts";
import { ensureGateway } from "../src/gateway.ts";
import { GATEWAY_RUNTIME } from "../src/gateway-runtime.ts";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "sentinel-gateway-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	vi.stubEnv("SENTINEL_PROJECTS_DIR", join(root, "projects"));
	return agentDir;
}

test("initialization errors include the failing network operation instead of assuming missing packages", async () => {
	const agentDir = setup();
	const run = vi.spyOn(docker, "runDocker").mockImplementation(async (args) => {
		if (args[0] === "exec") return { code: 1, stdout: "", stderr: "container is not running" };
		if (args[0] === "logs")
			return {
				code: 0,
				stdout: "",
				stderr:
					"RTNETLINK answers: Operation not permitted\ngateway init failed: saving IPv6 routing rules (exit 2)\n",
			};
		return { code: 0, stdout: "true", stderr: "" };
	});
	const result = await ensureGateway(agentDir, { id: "p1", container: "work-p1" }, null);
	expect(result.ok).toBe(false);
	expect(result.error).toContain("saving IPv6 routing rules");
	expect(result.error).toContain("Operation not permitted");
	expect(result.error).not.toContain("请确认工具镜像包含");
	expect(run).toHaveBeenCalledWith(["logs", "--tail", "20", expect.any(String)], { timeoutMs: 10000 });
	expect(run.mock.calls.some(([args]) => args.includes("apply"))).toBe(false);
});

test("an initialization timeout without logs reports readiness failure", async () => {
	const agentDir = setup();
	vi.spyOn(docker, "runDocker").mockImplementation(async (args) => ({
		code: args[0] === "exec" ? 1 : 0,
		stdout: args[0] === "inspect" ? "true" : "",
		stderr: "",
	}));
	const result = await ensureGateway(agentDir, { id: "p1", container: "work-p1" }, null);
	expect(result.ok).toBe(false);
	expect(result.error).toContain("初始化未在规定时间内完成");
	expect(result.error).not.toContain("iproute2");
});

test.each([
	{ code: 0, stdout: "gateway-ready: 4\n", stderr: "", expected: "ok", detail: "IPv6 已禁用" },
	{ code: 0, stdout: "gateway-ready: 4 6\n", stderr: "", expected: "ok", detail: "IPv4 / IPv6" },
	{
		code: 1,
		stdout: "",
		stderr: "gateway init failed: saving IPv6 firewall (exit 1)",
		expected: "fail",
		detail: "saving IPv6 firewall",
	},
	{ code: 0, stdout: "", stderr: "", expected: "fail", detail: "未返回就绪标记" },
])("environment checks gateway readiness: $expected $detail", async ({ code, stdout, stderr, expected, detail }) => {
	const agentDir = setup();
	vi.stubEnv("SENTINEL_GATEWAY_IMAGE", "custom-gateway:local");
	const run = vi.spyOn(docker, "runDocker").mockImplementation(async (args) => {
		if (args.includes(GATEWAY_RUNTIME)) return { code, stdout, stderr };
		if (args[0] === "run") return { code: 0, stdout: "sentinel-env-ok\n", stderr: "" };
		if (args[0] === "info") return { code: 0, stdout: "20.10.16|linux|amd64", stderr: "" };
		if (args[0] === "image") return { code: 0, stdout: "linux/amd64|1000000000|2026-11-06T00:00:00Z", stderr: "" };
		return { code: 0, stdout: "Docker version 20.10.16", stderr: "" };
	});
	const report = await checkEnvironment({ agentDir, url: "http://127.0.0.1:7777" });
	expect(report.items.find((item) => item.id === "gateway-runtime")).toMatchObject({
		status: expected,
		blocking: true,
		detail: expect.stringContaining(detail),
	});
	expect(report.ok).toBe(expected === "ok");
	const probe = run.mock.calls.find(([args]) => args.includes(GATEWAY_RUNTIME))?.[0];
	expect(probe).toEqual(
		expect.arrayContaining([
			"--rm",
			"--pull=never",
			"--network",
			"none",
			"--cap-add",
			"NET_ADMIN",
			"custom-gateway:local",
			"probe",
		]),
	);
	expect(probe).not.toContain("-v");
});
