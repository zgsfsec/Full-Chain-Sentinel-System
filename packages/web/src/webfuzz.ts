/** Operator-owned replay workspaces. Sends run in short-lived, isolated containers. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execInContainer, runDocker, SENTINEL_IMAGE } from "./docker.ts";
import { MitmError } from "./mitm-store.ts";
import { readReplaydBinary, replaydArchFromUname, replaydBinaryHint } from "./replayd-binary.ts";
import { openSqliteDatabase } from "./sqlite.ts";
import { webFuzzTarget } from "./webfuzz-target.ts";
import type { WebFuzzRequest, WebFuzzResult, WebFuzzState, WebFuzzTab } from "./webfuzz-types.ts";

const MAX_REQUEST = 512 * 1024;
const MAX_PREVIEW = 128 * 1024;

function validateDraft(value: unknown): WebFuzzRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new MitmError("发包配置无效。");
	const input = value as Partial<WebFuzzRequest>;
	if (typeof input.raw !== "string" || Buffer.byteLength(input.raw) > MAX_REQUEST)
		throw new MitmError("请求报文不能超过 512 KB。");
	if (typeof input.target !== "string" || input.target.length > 2048) throw new MitmError("目标地址过长。");
	if (input.route !== "project" && input.route !== "direct" && input.route !== "mitm")
		throw new MitmError("请选择发包出口。");
	if (
		typeof input.timeoutMs !== "number" ||
		!Number.isSafeInteger(input.timeoutMs) ||
		input.timeoutMs < 1000 ||
		input.timeoutMs > 120000
	)
		throw new MitmError("超时应为 1–120 秒。");
	if (typeof input.insecureTLS !== "boolean" || typeof input.fixContentLength !== "boolean")
		throw new MitmError("发包选项无效。");
	return {
		raw: input.raw,
		target: input.target,
		route: input.route,
		timeoutMs: input.timeoutMs,
		insecureTLS: input.insecureTLS,
		fixContentLength: input.fixContentLength,
	};
}

export function validateWebFuzzRequest(value: unknown): WebFuzzRequest {
	const input = validateDraft(value);
	if (!input.raw.trim()) throw new MitmError("请求报文不能为空，且不能超过 512 KB。");
	let url: URL;
	try {
		url = new URL(input.target ?? "");
	} catch {
		throw new MitmError("请输入完整目标地址，例如 https://example.com:443。");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		!url.hostname ||
		url.username ||
		url.password ||
		url.hash ||
		url.search ||
		url.pathname !== "/"
	)
		throw new MitmError("目标应为 HTTP/HTTPS 地址及端口；路径和参数请写在请求行，不接受账号密码。");
	try {
		return { ...input, target: webFuzzTarget(input.raw, url.protocol === "https:") };
	} catch (error) {
		throw new MitmError(error instanceof Error ? error.message : "Host 地址无效。");
	}
}

/** Normalize only the header section; never change a pasted body's line endings. */
export function prepareWebFuzzRaw(input: WebFuzzRequest): string {
	const split = /\r?\n\r?\n/.exec(input.raw);
	const head = split ? input.raw.slice(0, split.index) : input.raw;
	const body = split ? input.raw.slice(split.index + split[0].length) : "";
	let lines = (split ? head : head.replace(/\r?\n$/, "")).split(/\r?\n/);
	const match = /^(\S+)\s+(\S+)\s+(HTTP\/\d(?:\.\d)?)$/.exec(lines[0] ?? "");
	if (!match || match[3] !== "HTTP/1.1")
		throw new MitmError("首版仅支持 HTTP/1.1，请使用「方法 路径 HTTP/1.1」请求行。");
	const target = new URL(validateWebFuzzRequest(input).target);
	if (match[1].toUpperCase() === "CONNECT") throw new MitmError("请勾选 HTTPS，WebFuzz 不支持手动 CONNECT 隧道。");
	// An absolute request line must agree with Host and the selected protocol.
	if (/^https?:\/\//i.test(match[2])) {
		let absolute: URL;
		try {
			absolute = new URL(match[2]);
		} catch {
			throw new MitmError("请求行中的绝对地址无效。");
		}
		if (absolute.origin !== target.origin || absolute.username || absolute.password || absolute.hash)
			throw new MitmError("请求行地址与 Host 或 HTTPS 选项不一致。");
		lines[0] = `${match[1]} ${absolute.pathname}${absolute.search} HTTP/1.1`;
	} else if (!match[2].startsWith("/") && match[2] !== "*") {
		throw new MitmError("请求路径应以 / 开始。");
	}
	if (input.fixContentLength && !lines.some((line) => /^transfer-encoding:/i.test(line))) {
		const hadLength = lines.some((line) => /^content-length:/i.test(line));
		lines = lines.filter((line) => !/^content-length:/i.test(line));
		if (body || hadLength) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
	}
	return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

export function readWebFuzzState(directory: string): WebFuzzState {
	const path = join(directory, "webfuzz.db");
	if (!existsSync(path)) return { tabs: [], activeId: null, history: [] };
	const db = openSqliteDatabase(path);
	try {
		const state = db.prepare("SELECT value FROM workspace WHERE id = 1").get() as { value: string } | undefined;
		const history = db.prepare("SELECT value FROM history ORDER BY at DESC, id DESC LIMIT 30").all() as {
			value: string;
		}[];
		return {
			tabs: [],
			activeId: null,
			...(state ? (JSON.parse(state.value) as Pick<WebFuzzState, "tabs" | "activeId">) : {}),
			history: history.map((row) => JSON.parse(row.value) as WebFuzzResult),
		};
	} finally {
		db.close();
	}
}

export function writeWebFuzzState(directory: string, value: unknown): void {
	const state = value as Partial<WebFuzzState> | null;
	if (
		!state ||
		!Array.isArray(state.tabs) ||
		state.tabs.length > 20 ||
		(state.activeId !== null && typeof state.activeId !== "string")
	)
		throw new MitmError("工作台数据无效，最多保留 20 个标签。");
	const tabs: WebFuzzTab[] = state.tabs.map((tab) => {
		if (
			!tab ||
			typeof tab.id !== "string" ||
			!/^[a-zA-Z0-9_-]{1,80}$/.test(tab.id) ||
			typeof tab.name !== "string" ||
			tab.name.length > 80
		)
			throw new MitmError("标签格式无效。");
		return { ...validateDraft(tab), id: tab.id, name: tab.name };
	});
	if (
		new Set(tabs.map((tab) => tab.id)).size !== tabs.length ||
		(state.activeId !== null && !tabs.some((tab) => tab.id === state.activeId))
	)
		throw new MitmError("标签编号无效。");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const db = openSqliteDatabase(join(directory, "webfuzz.db"));
	try {
		db.exec(
			"PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS workspace(id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY, at INTEGER NOT NULL, value TEXT NOT NULL);",
		);
		db.prepare("INSERT OR REPLACE INTO workspace VALUES(1, ?)").run(
			JSON.stringify({ tabs, activeId: state.activeId }),
		);
	} finally {
		db.close();
	}
}

export function saveWebFuzzResult(directory: string, result: WebFuzzResult): void {
	if (!existsSync(join(directory, "webfuzz.db"))) writeWebFuzzState(directory, { tabs: [], activeId: null });
	const db = openSqliteDatabase(join(directory, "webfuzz.db"));
	try {
		db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
		db.prepare("INSERT INTO history VALUES(?, ?, ?)").run(result.id, result.at, JSON.stringify(result));
		db.exec(
			"DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY at DESC, id DESC LIMIT 30); COMMIT;",
		);
	} finally {
		db.close();
	}
}

/** Temporary replayd has no proxy listener or published ports. Secrets arrive over stdin. */
export const WEBFUZZ_RUNNER = `import base64, json, os, socket, subprocess, sys, tempfile, time, urllib.request
payload = json.load(sys.stdin)
with tempfile.TemporaryDirectory() as data:
    environment = os.environ.copy()
    if os.path.isfile("/opt/webfuzz/ca.crt"):
        bundle = os.path.join(data, "ca-bundle.pem")
        with open(bundle, "wb") as output:
            if os.path.isfile("/etc/ssl/certs/ca-certificates.crt"):
                with open("/etc/ssl/certs/ca-certificates.crt", "rb") as source: output.write(source.read())
            with open("/opt/webfuzz/ca.crt", "rb") as source: output.write(b"\\n" + source.read())
        environment["SSL_CERT_FILE"] = bundle
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    process = subprocess.Popen(["/opt/webfuzz/replayd", "-data-dir", data, "-listen", "127.0.0.1:" + str(port), "-no-proxy", "-quiet"], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        origin = "http://127.0.0.1:" + str(port)
        for attempt in range(100):
            try:
                with opener.open(origin + "/api/health", timeout=1) as health:
                    if health.status == 200: break
            except Exception:
                if process.poll() is not None: raise RuntimeError("发包引擎启动失败")
                time.sleep(0.05)
        else: raise RuntimeError("发包引擎启动超时")
        with open(os.path.join(data, "token")) as token:
            request = urllib.request.Request(origin + "/api/replay", data=json.dumps(payload).encode(), headers={"Authorization": "Bearer " + token.read().strip(), "Content-Type": "application/json"})
        with opener.open(request, timeout=payload["options"]["totalTimeoutMs"] / 1000 + 5) as response:
            result = json.load(response)
        result.pop("request", None)
        if result.get("response"):
            view = result["response"]
            headers = []
            remaining = 32768
            for header in view.get("headers") or []:
                cost = len(json.dumps(header).encode())
                if cost > remaining:
                    view["previewTruncated"] = True
                    break
                headers.append(header)
                remaining -= cost
            view["headers"] = headers
            view["reason"] = view.get("reason", "")[:1024]
            for key in ["bodyText", "bodyBase64"]:
                value = view.get(key, "").encode("utf-8")
                if len(value) > 131072:
                    view[key] = value[:131072].decode("utf-8", errors="ignore")
                    view["previewTruncated"] = True
            if "rawBase64" in view:
                raw = base64.b64decode(view["rawBase64"])
                try:
                    view["rawText"] = raw.decode("utf-8")
                    del view["rawBase64"]
                except UnicodeDecodeError:
                    pass
        print(json.dumps(result))
    finally:
        process.terminate()
        process.wait(timeout=3)
`;

export async function sendWebFuzz(
	input: WebFuzzRequest,
	context: {
		binDirectory: string;
		network: string;
		caPath?: string;
		upstreamProxy?: string;
		proxyAuthorization?: string;
		signal?: AbortSignal;
	},
	dependencies = { docker: runDocker, exec: execInContainer, binary: readReplaydBinary },
): Promise<WebFuzzResult> {
	context.signal?.throwIfAborted();
	const request = { ...validateWebFuzzRequest(input), raw: prepareWebFuzzRaw(input) };
	const image = await dependencies.docker(["image", "inspect", "--format", "{{.Architecture}}", SENTINEL_IMAGE], {
		timeoutMs: 15000,
		signal: context.signal,
	});
	const arch = replaydArchFromUname(image.stdout.trim());
	if (image.code !== 0 || !arch) throw new MitmError("工具镜像不可用，请在设置中检查环境。", 503);
	const binary = dependencies.binary(arch);
	if (!binary) throw new MitmError(replaydBinaryHint(arch), 503);
	mkdirSync(context.binDirectory, { recursive: true, mode: 0o700 });
	const path = join(context.binDirectory, `replayd-${arch}-${binary.sha256}`);
	if (!existsSync(path)) writeFileSync(path, binary.bytes, { mode: 0o755 });
	const name = `sentinel-webfuzz-${randomUUID()}`;
	let raw = request.raw;
	if (context.proxyAuthorization && new URL(request.target).protocol === "http:") {
		const boundary = raw.indexOf("\r\n\r\n");
		let skip = false;
		const headers = raw
			.slice(0, boundary)
			.split("\r\n")
			.filter((line) => {
				if (!/^[ \t]/.test(line)) skip = /^proxy-authorization:/i.test(line);
				return !skip;
			});
		headers.push(`Proxy-Authorization: ${context.proxyAuthorization}`);
		raw = `${headers.join("\r\n")}\r\n\r\n${raw.slice(boundary + 4)}`;
	}
	const url = new URL(request.target);
	try {
		context.signal?.throwIfAborted();
		const created = await dependencies.docker(
			[
				"run",
				"-d",
				"--rm",
				"--init",
				"--name",
				name,
				"--network",
				context.network,
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--memory",
				"512m",
				"--pids-limit",
				"64",
				"--mount",
				`type=bind,source=${path},target=/opt/webfuzz/replayd,readonly`,
				...(context.caPath
					? ["--mount", `type=bind,source=${context.caPath},target=/opt/webfuzz/ca.crt,readonly`]
					: []),
				"--entrypoint",
				"sleep",
				SENTINEL_IMAGE,
				"180",
			],
			{ timeoutMs: 30000, signal: context.signal },
		);
		if (created.code !== 0) throw new MitmError("发包环境启动失败，请检查所选项目容器是否运行。", 503);
		context.signal?.throwIfAborted();
		const result = await dependencies.exec(name, 'python3 -c "$1"', [WEBFUZZ_RUNNER], {
			signal: context.signal,
			timeoutMs: request.timeoutMs + 20000,
			stdin: Buffer.from(
				JSON.stringify({
					raw,
					target: {
						scheme: url.protocol.slice(0, -1),
						host: url.hostname.replace(/^\[|\]$/g, ""),
						port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
					},
					save: false,
					options: {
						includeRaw: true,
						insecureTLS: request.insecureTLS,
						upstreamProxy: context.upstreamProxy ?? "",
						totalTimeoutMs: request.timeoutMs,
						connectTimeoutMs: Math.min(10000, request.timeoutMs),
						headerTimeoutMs: request.timeoutMs,
					},
				}),
			),
		});
		context.signal?.throwIfAborted();
		if (result.code !== 0) throw new MitmError("发包失败、超时或响应过大，请检查目标、出口及超时设置。", 502);
		const view = JSON.parse(result.stdout) as {
			response?: WebFuzzResult["response"];
			timings?: WebFuzzResult["timings"];
			error?: { message?: string };
		};
		return {
			id: randomUUID(),
			at: Date.now(),
			request,
			response: view.response ?? null,
			timings: view.timings ?? { connectMs: 0, tlsMs: 0, ttfbMs: 0, totalMs: 0 },
			...(view.error ? { error: (view.error.message ?? "发送失败").slice(0, 2000) } : {}),
			warnings: [
				...(request.raw !== input.raw
					? ["请求头已规范为 CRLF；按当前选项更新 Content-Length，正文保持不变。"]
					: []),
				...(view.response?.truncated
					? [view.error ? "响应未完整接收，已保留收到的部分。" : "响应达到引擎接收上限，内容不完整。"]
					: []),
				...(view.response?.previewTruncated || view.response?.rawTruncated
					? [`响应预览仅保存前 ${MAX_PREVIEW / 1024} KB；原始报文预览可能不完整。`]
					: []),
			],
		};
	} finally {
		await dependencies.docker(["rm", "-f", name], { timeoutMs: 15000 });
	}
}
