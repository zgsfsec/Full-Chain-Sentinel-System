import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { runDocker } from "./docker.ts";
import { withGatewayLock } from "./gateway.ts";
import { getServerLanguage } from "./i18n.ts";
import type { ProjectEgressIp } from "./project-egress-types.ts";
import { listProjects, recordProjectEgressIp } from "./projects.ts";

const pending = new Map<string, Promise<ProjectEgressIp>>();

/** Measure the existing container's actual route; never fall back to the host. */
export function testProjectEgressIp(agentDir: string, projectId: string): Promise<ProjectEgressIp> {
	const key = `${agentDir}:${projectId}`;
	const existing = pending.get(key);
	if (existing) return existing;
	const operation = withGatewayLock(key, async () => {
		const project = listProjects(agentDir).projects.find((entry) => entry.id === projectId);
		if (!project) throw new Error(getServerLanguage() === "en" ? "Project not found." : "项目不存在。");
		if (project.manualStop) {
			throw new Error(
				getServerLanguage() === "en" ? "Start the project container before testing." : "请先启动项目容器再测试。",
			);
		}
		const response = await runDocker(
			[
				"exec",
				project.container,
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
			],
			{ timeoutMs: 10000 },
		);
		// ping0 /geo returns IP, location, ASN and organization on separate lines.
		const [ip, location] = response.stdout
			.trim()
			.split(/\r?\n/)
			.map((line) => line.trim());
		if (response.code === 0 && ip && isIP(ip) && location) {
			const result = { ip, location, testedAt: Date.now() };
			recordProjectEgressIp(agentDir, projectId, result);
			return result;
		}
		throw new Error(
			getServerLanguage() === "en"
				? "Public IP test failed. Check the project container, network and proxy, then retry."
				: "公网 IP 测试失败，请检查项目容器、网络和代理后重试。",
		);
	}).finally(() => pending.delete(key));
	pending.set(key, operation);
	return operation;
}

/** Routed after the console's gate, authentication and consent checks. GET never probes. */
export async function handleProjectEgressApi(
	request: IncomingMessage,
	response: ServerResponse,
	agentDir: string | undefined,
): Promise<void> {
	let status = 200;
	let body: { result: ProjectEgressIp | null } | { error: string };
	try {
		if (!agentDir) {
			status = 503;
			throw new Error(getServerLanguage() === "en" ? "Configuration directory unavailable." : "配置目录不可用。");
		}
		const url = new URL(request.url ?? "/", "http://localhost");
		const projectId = url.searchParams.get("projectId");
		const project = listProjects(agentDir).projects.find((entry) => entry.id === projectId);
		if (!project) {
			status = 404;
			throw new Error(getServerLanguage() === "en" ? "Project not found." : "项目不存在。");
		}
		if (request.method === "GET") {
			body = { result: project.egressIp ?? null };
		} else if (request.method === "POST") {
			body = { result: await testProjectEgressIp(agentDir, project.id) };
		} else {
			status = 405;
			response.setHeader("allow", "GET, POST");
			throw new Error(getServerLanguage() === "en" ? "Method not allowed." : "不支持的请求方法。");
		}
	} catch (error) {
		if (status === 200) status = 502;
		body = { error: error instanceof Error ? error.message : String(error) };
	}
	if (response.destroyed) return;
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}
