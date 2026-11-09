/** POC archives use the selected project's network without base64/JSON buffering. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { t } from "./i18n.ts";
import { MAX_ZIP_TOTAL_BYTES } from "./poc-zip.ts";
import { createProjectNetwork, type ProjectNetworkOperations } from "./project-network.ts";
import { listProjects } from "./projects.ts";

/** Official archives can take minutes on slow links. Bound both setup and transfer. */
const FETCH_TIMEOUT_MS = 10 * 60_000;
const STATUS_MARKER = "sentinel-poc-http-status:";

interface DownloadOperations extends ProjectNetworkOperations {
	fetch?: typeof fetch;
	spawn?: (command: string, args: string[]) => ChildProcessWithoutNullStreams;
	maxBytes?: number;
	timeoutMs?: number;
}

/** Capture the current project once so retries cannot switch to another project's exit. */
export function createPocSubscriptionDownload(
	agentDir: string,
	operations: DownloadOperations = {},
): (url: string, headerName: string, headerValue: string) => Promise<Buffer> {
	const projectId = listProjects(agentDir).lastActiveProjectId;
	const network = projectId ? createProjectNetwork(agentDir, projectId, operations) : undefined;
	const maxBytes = operations.maxBytes ?? MAX_ZIP_TOTAL_BYTES;
	const timeoutMs = operations.timeoutMs ?? FETCH_TIMEOUT_MS;
	const tooLarge = () => new Error(t("文件超过 {max}MB 上限", { max: Math.round(maxBytes / 1024 / 1024) }));
	return async (url, headerName, headerValue) => {
		const headers = new Headers();
		if (headerName && headerValue) headers.set(headerName, headerValue);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const project = await network?.(controller.signal);
			controller.signal.throwIfAborted();
			if (!project) {
				const response = await (operations.fetch ?? fetch)(url, {
					headers,
					redirect: "follow",
					signal: controller.signal,
				});
				const reader = response.body?.getReader();
				try {
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw tooLarge();
					if (!reader) throw new Error(t("响应没有内容"));
					const chunks: Uint8Array[] = [];
					let total = 0;
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						total += value.byteLength;
						if (total > maxBytes) throw tooLarge();
						chunks.push(value);
					}
					return Buffer.concat(chunks, total);
				} finally {
					await reader?.cancel().catch(() => undefined);
					reader?.releaseLock();
				}
			}

			const args = [
				"exec",
				"-i",
				project.container,
				"curl",
				"--disable",
				"--silent",
				"--show-error",
				"--fail",
				"--location",
				"--max-redirs",
				"5",
				"--proto",
				"=http,https",
				"--proto-redir",
				"=http,https",
				"--compressed",
				"--proxy",
				"",
				"--max-time",
				String(timeoutMs / 1000),
				"--connect-timeout",
				"10",
				"--max-filesize",
				String(maxBytes),
				"--config",
				"-",
				"--write-out",
				`%{stderr}\n${STATUS_MARKER}%{http_code}`,
			];
			// Feed secrets through stdin, never through process arguments or shell text.
			const config = [
				`url = ${JSON.stringify(new URL(url).href)}`,
				...[...headers].map(([name, value]) => `header = ${JSON.stringify(`${name}: ${value}`)}`),
			].join("\n");
			return await new Promise<Buffer>((resolve, reject) => {
				const child = (operations.spawn ?? spawn)("docker", args);
				const chunks: Buffer[] = [];
				let total = 0;
				let stderr = "";
				let settled = false;
				const fail = (error: unknown): void => {
					if (settled) return;
					settled = true;
					controller.signal.removeEventListener("abort", onAbort);
					chunks.length = 0;
					child.kill("SIGKILL");
					reject(error);
				};
				const onAbort = () => fail(controller.signal.reason);
				controller.signal.addEventListener("abort", onAbort, { once: true });
				child.stdout.on("data", (chunk: Buffer) => {
					if (settled) return;
					total += chunk.byteLength;
					if (total > maxBytes) fail(tooLarge());
					else chunks.push(chunk);
				});
				child.stderr.on("data", (chunk: Buffer) => {
					stderr = (stderr + chunk.toString("utf8")).slice(-4000);
				});
				child.once("error", fail);
				child.stdin.on("error", fail);
				child.once("close", (code) => {
					if (settled) return;
					const status = /\nsentinel-poc-http-status:(\d{3})\s*$/.exec(stderr);
					if (code === 63) {
						fail(tooLarge());
						return;
					}
					if (code !== 0) {
						fail(
							new Error(
								`项目代理下载失败（curl ${code}）：${stderr.replace(/\nsentinel-poc-http-status:\d{3}\s*$/, "").trim()}`,
							),
						);
						return;
					}
					if (!status || Number(status[1]) < 200 || Number(status[1]) >= 300) {
						fail(new Error(status ? `HTTP ${status[1]}` : "项目代理下载未返回 HTTP 状态码"));
						return;
					}
					settled = true;
					controller.signal.removeEventListener("abort", onAbort);
					resolve(Buffer.concat(chunks, total));
				});
				if (controller.signal.aborted) onAbort();
				else child.stdin.end(`${config}\n`);
			});
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	};
}
