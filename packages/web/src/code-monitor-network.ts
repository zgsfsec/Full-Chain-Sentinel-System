/** GitHub reads use the project's existing proxy network; model calls stay on the host. */
import { execInContainer } from "./docker.ts";
import { ensureProjectReady, listProjects, projectProxySettings, projectSidecarName } from "./projects.ts";
import { projectOpenVpnConfigPath, projectProxyConfigPath, projectWireGuardConfigPath, proxyEnabled } from "./proxy.ts";
import { checkSidecar } from "./singbox.ts";

/** curl follows redirects and decodes compression; only response files touch disk. */
export const GITHUB_CONTAINER_REQUEST = `import base64, json, pathlib, subprocess, sys, tempfile
request = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix="sentinel-github-") as directory:
    headers = pathlib.Path(directory) / "headers"
    body = pathlib.Path(directory) / "body"
    config = "url = " + json.dumps(request["url"]) + "\\n"
    for name, value in request["headers"]:
        config += "header = " + json.dumps(name + ": " + value) + "\\n"
    result = subprocess.run([
        "curl", "--disable", "--silent", "--show-error", "--location", "--max-redirs", "5",
        "--proto", "=http,https", "--proto-redir", "=http,https", "--compressed",
        "--proxy", "", "--max-time", "30", "--connect-timeout", "10",
        "--config", "-", "--dump-header", str(headers), "--output", str(body), "--write-out", "%{http_code}"
    ], input=config, text=True, capture_output=True)
    if result.returncode:
        print(json.dumps({"error": result.stderr.strip(), "code": result.returncode}))
    else:
        blocks = headers.read_bytes().split(b"\\r\\n\\r\\n")
        final = next(block for block in reversed(blocks) if block.startswith(b"HTTP/"))
        pairs = []
        for line in final.split(b"\\r\\n")[1:]:
            name, separator, value = line.partition(b":")
            if separator:
                pairs.append([name.decode("latin-1"), value.strip().decode("latin-1")])
        print(json.dumps({"status": int(result.stdout), "headers": pairs, "body": base64.b64encode(body.read_bytes()).decode("ascii")}))
`;

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal | null): Promise<T> {
	if (!signal) return operation;
	signal.throwIfAborted();
	let onAbort = (): void => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function containerResponse(stdout: string): Response {
	const raw: unknown = JSON.parse(stdout);
	if (!raw || typeof raw !== "object") throw new Error("项目代理返回了无效的响应");
	if ("error" in raw) {
		const code = "code" in raw && typeof raw.code === "number" ? raw.code : "unknown";
		throw new Error(`项目代理请求失败（curl ${code}）：${String(raw.error)}`);
	}
	if (!("status" in raw) || typeof raw.status !== "number" || !("body" in raw) || typeof raw.body !== "string") {
		throw new Error("项目代理没有返回 HTTP 状态码或响应体");
	}
	const headers = new Headers();
	if ("headers" in raw && Array.isArray(raw.headers)) {
		for (const entry of raw.headers) {
			if (Array.isArray(entry) && entry.length === 2 && entry.every((value) => typeof value === "string")) {
				headers.append(entry[0], entry[1]);
			}
		}
	}
	// curl already decoded the body; retain GitHub's rate-limit and retry headers.
	headers.delete("content-encoding");
	headers.delete("content-length");
	return new Response([204, 205, 304].includes(raw.status) ? null : Buffer.from(raw.body, "base64"), {
		status: raw.status,
		headers,
	});
}

/** One client/check shares its readiness work, while proxy selection is read afresh. */
export function createProjectGithubFetch(
	agentDir: string,
	projectId: string,
	operations: {
		fetch?: typeof fetch;
		ensureReady?: typeof ensureProjectReady;
		checkSidecar?: typeof checkSidecar;
		exec?: typeof execInContainer;
	} = {},
): typeof fetch {
	let ready: Promise<void> | undefined;
	let readyKey = "";
	return async (input, init) => {
		const request = new Request(input, init);
		request.signal.throwIfAborted();
		const project = listProjects(agentDir).projects.find((entry) => entry.id === projectId);
		if (!project) throw new Error("监控所属项目不存在，请重新选择项目");
		const settings = projectProxySettings(agentDir, project);
		if (!proxyEnabled(settings)) return (operations.fetch ?? fetch)(input, init);
		if (project.manualStop) throw new Error("项目容器已手动停止；GitHub API 使用项目代理，请先启动项目容器");
		if (request.method !== "GET") throw new Error("GitHub 代理传输只支持 GET 请求");
		const networkKey = JSON.stringify([project, settings]);
		if (!ready || readyKey !== networkKey) {
			readyKey = networkKey;
			ready = (async () => {
				if (!(await (operations.ensureReady ?? ensureProjectReady)(project, agentDir))) {
					throw new Error("项目代理或容器未就绪，请在项目与环境页面检查代理连接和容器状态");
				}
				const configPath = project.gateway
					? ""
					: settings.mode === "wireguard"
						? projectWireGuardConfigPath(agentDir, projectId)
						: settings.mode === "openvpn"
							? projectOpenVpnConfigPath(agentDir, projectId)
							: projectProxyConfigPath(agentDir, projectId);
				const health = await (operations.checkSidecar ?? checkSidecar)(
					project.container,
					projectSidecarName(project),
					configPath,
				);
				if (!health.joined || health.netnsStale || health.configStale) {
					throw new Error("项目容器尚未使用当前代理网络，请在项目页面应用代理配置或重建容器");
				}
			})();
		}
		await withAbort(ready, request.signal);
		request.signal.throwIfAborted();
		const result = await (operations.exec ?? execInContainer)(
			project.container,
			'exec python3 -c "$1"',
			[GITHUB_CONTAINER_REQUEST],
			{
				stdin: Buffer.from(JSON.stringify({ url: request.url, headers: [...request.headers] }), "utf-8"),
				signal: request.signal,
				timeoutMs: 35_000,
			},
		);
		request.signal.throwIfAborted();
		if (result.code !== 0) {
			throw new Error(`项目代理请求执行失败（退出码 ${result.code}）：${result.stderr.trim().slice(-1000)}`);
		}
		return containerResponse(result.stdout);
	};
}
