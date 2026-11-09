/** GitHub reads use the project's existing proxy network; model calls stay on the host. */
import { execInContainer } from "./docker.ts";
import { createProjectNetwork, type ProjectNetworkOperations } from "./project-network.ts";

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
	operations: ProjectNetworkOperations & {
		fetch?: typeof fetch;
		exec?: typeof execInContainer;
	} = {},
): typeof fetch {
	const network = createProjectNetwork(agentDir, projectId, operations);
	return async (input, init) => {
		const request = new Request(input, init);
		request.signal.throwIfAborted();
		const project = await network(request.signal);
		if (!project) return (operations.fetch ?? fetch)(input, init);
		if (request.method !== "GET") throw new Error("GitHub 代理传输只支持 GET 请求");
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
