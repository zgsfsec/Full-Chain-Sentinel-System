/**
 * Docker execution layer for container projects.
 *
 * Each project owns one long-running container built from the sentinel image
 * (docker/sentinel.Dockerfile). Every bash tool call is a `docker exec` into
 * that container; file tools operate on the host-side mount so reports and
 * evidence persist outside the container lifecycle.
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { embeddedDockerfile } from "./assets.ts";
import { containerNetworkFlags, sidecarNetworkFlags } from "./container-network.ts";
import { t } from "./i18n.ts";
import type { SentinelContainerNetwork, SentinelSources } from "./protocol.ts";
import { buildArgs } from "./sources.ts";

export const SENTINEL_IMAGE = "sentinel:latest";

/** Run the docker CLI, capturing output. Used by the container layer and the environment check. */
export function runDocker(
	args: string[],
	options: { signal?: AbortSignal; timeoutMs?: number; onOutput?: (chunk: string) => void } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
		const onAbort = () => child.kill("SIGKILL");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stdout += text;
			options.onOutput?.(text);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stderr += text;
			options.onOutput?.(text);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({ code: code ?? 1, stdout, stderr });
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({ code: 1, stdout, stderr: String(error) });
		});
	});
}

/** Whether the sentinel toolbox image exists locally. */
export async function hasImage(): Promise<boolean> {
	const result = await runDocker(["image", "inspect", SENTINEL_IMAGE], { timeoutMs: 15000 });
	return result.code === 0;
}

export interface BuildProgress {
	onLog(line: string): void;
	signal?: AbortSignal;
}

/**
 * Directory `docker build` reads the Dockerfile from: the checkout's `docker/` when
 * there is one, otherwise a temp directory holding the copy embedded in the binary.
 * The caller removes the temp directory.
 */
async function imageContext(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
	const checkout = join(repoRoot(), "docker");
	if (existsSync(join(checkout, "Dockerfile"))) return { dir: checkout, cleanup: async () => {} };
	const dockerfile = embeddedDockerfile();
	if (!dockerfile) throw new Error(t("二进制内没有内置 Dockerfile，无法构建工具镜像"));
	const dir = await mkdtemp(join(tmpdir(), "sentinel-image-"));
	await writeFile(join(dir, "Dockerfile"), dockerfile, "utf8");
	return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Build the toolbox image, streaming build output line by line. */
export async function buildImage(
	progress: BuildProgress,
	sources: SentinelSources,
): Promise<{ ok: boolean; error?: string }> {
	let context: { dir: string; cleanup: () => Promise<void> };
	try {
		context = await imageContext();
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	try {
		return await buildImageIn(progress, context.dir, sources);
	} finally {
		await context.cleanup();
	}
}

function buildImageIn(
	progress: BuildProgress,
	contextDir: string,
	sources: SentinelSources,
): Promise<{ ok: boolean; error?: string }> {
	return new Promise((resolve) => {
		const child = spawn("docker", ["build", "-t", SENTINEL_IMAGE, ...buildArgs(sources), contextDir], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		const onAbort = () => child.kill("SIGKILL");
		progress.signal?.addEventListener("abort", onAbort, { once: true });
		const feed = (stream: NodeJS.ReadableStream) => {
			let buffer = "";
			stream.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) if (line.trim()) progress.onLog(line);
			});
		};
		feed(child.stdout);
		feed(child.stderr);
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => {
			progress.signal?.removeEventListener("abort", onAbort);
			resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.slice(-2000) || `exit ${code}` });
		});
		child.on("error", (error) => resolve({ ok: false, error: String(error) }));
	});
}

export function repoRoot(): string {
	// dist/docker.js -> package root -> packages -> repo root
	return join(import.meta.dirname, "..", "..", "..");
}

/**
 * Host-side working directory for a project (mounted at /work in the container).
 * `SENTINEL_PROJECTS_DIR` relocates the root; tests point it at a temp directory so
 * project creation never touches the operator's real projects.
 */
export function projectWorkDir(name: string): string {
	const slug =
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
			.slice(0, 40) || "project";
	const root = process.env.SENTINEL_PROJECTS_DIR ?? join(homedir(), ".sentinel", "projects");
	const dir = join(root, slug);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Run a POSIX shell script inside a project container.
 *
 * `args` are passed as positional parameters ($1, $2, ...), never interpolated
 * into `script`, so operator-supplied paths cannot inject shell syntax. stdout
 * is collected as bytes because file downloads are binary.
 */
export function execInContainer(
	containerName: string,
	script: string,
	args: string[] = [],
	options: { stdin?: Buffer; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stdoutBytes: Buffer; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("docker", ["exec", "-i", containerName, "sh", "-c", script, "zg", ...args], {
			stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let stderr = "";
		let settled = false;
		const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
		const onAbort = () => child.kill("SIGKILL");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (code: number): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			const stdoutBytes = Buffer.concat(chunks);
			resolve({ code, stdout: stdoutBytes.toString("utf-8"), stdoutBytes, stderr });
		};
		child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		if (options.stdin !== undefined) {
			child.stdin?.on("error", () => {
				// The container may exit before consuming stdin; the exit code carries the failure.
			});
			child.stdin?.end(options.stdin);
		}
		child.on("close", (code) => finish(code ?? 1));
		child.on("error", (error) => {
			stderr = String(error);
			finish(1);
		});
	});
}

/**
 * Like `execInContainer`, but leaves stdout as a live stream.
 *
 * Folder archives can be gigabytes; buffering them in a Buffer or a string only
 * to write them to disk would double the memory and block the process. The
 * caller pipes stdout into a file and applies backpressure.
 */
export function spawnInContainer(
	containerName: string,
	script: string,
	args: string[] = [],
): ChildProcessByStdio<null, Readable, Readable> {
	return spawn("docker", ["exec", "-i", containerName, "sh", "-c", script, "zg", ...args], {
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/**
 * Create the project container: detached, mounted, and joined to the network the
 * operator picked on the environment page (host by default, so listeners inside it
 * are reachable and the real LAN is what the tools see).
 *
 * `sidecar` names a sing-box container whose network namespace this container
 * takes instead. The sidecar has to be running first — Docker refuses to create
 * or start a container against a namespace that is not up.
 */
export async function createContainer(
	containerName: string,
	workDir: string,
	network: SentinelContainerNetwork,
	sidecar?: string,
	/**
	 * File to mount over the container's `/etc/resolv.conf`. A tunnel passes the
	 * generated one: Docker's own resolver runs outside the tunnel, so leaving it
	 * unset would leak every lookup. It cannot be `--dns` instead — Docker rejects
	 * that flag together with the container network mode a tunnel requires
	 * ("conflicting options: dns and the network mode").
	 */
	resolvConfPath?: string,
): Promise<{ ok: boolean; error?: string }> {
	const mounts = ["-v", `${workDir}:/work`];
	// The system prompt hands the model the host working directory (the session cwd),
	// while every bash call runs in the container. Mount the same directory at that
	// path too: a command that uses the absolute path then writes to the shared
	// volume, instead of into the container's own layer, where the file never reaches
	// the host, the file tools and the file panel cannot see it, and recreating the
	// container loses it.
	// A drive-letter path (C:\...) is not a valid destination inside a Linux
	// container: Docker rejects it as an absolute path, so the same-path mount is
	// POSIX-only. On Windows /work still carries the project directory.
	if (process.platform !== "win32" && workDir !== "/work") {
		mounts.push("-v", `${workDir}:${workDir}`);
	}
	const result = await runDocker([
		"run",
		"-d",
		"--name",
		containerName,
		...(sidecar ? sidecarNetworkFlags(sidecar) : containerNetworkFlags(network)),
		...(resolvConfPath ? ["-v", `${resolvConfPath}:/etc/resolv.conf:ro`] : []),
		...mounts,
		"-w",
		"/work",
		SENTINEL_IMAGE,
	]);
	if (result.code !== 0) return { ok: false, error: result.stderr.trim() };
	if (sidecar) await alignHostAlias(containerName, sidecar);
	return { ok: true };
}

/**
 * Make `host.docker.internal` resolvable inside a proxied container.
 *
 * Docker rejects `--add-host` together with `--network container:` ("conflicting
 * options: custom host-to-IP mapping and the network mode"), so the alias cannot
 * be baked into the container's configuration the way the host and bridge modes do
 * it. Docker Desktop's embedded DNS answers the name on its own; on a plain Linux
 * engine nothing does, and the frida tunnel would have no name to dial. The line
 * is appended only when the name does not already resolve, and has to be appended
 * again after every start, because Docker rewrites `/etc/hosts` each time.
 */
export async function alignHostAlias(containerName: string, sidecar: string): Promise<void> {
	const gateway = await runDocker([
		"inspect",
		"-f",
		"{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}",
		sidecar,
	]);
	const address = gateway.stdout.trim();
	if (gateway.code !== 0 || !address) return;
	await execInContainer(
		containerName,
		'getent hosts host.docker.internal >/dev/null 2>&1 || printf "%s host.docker.internal\\n" "$1" >> /etc/hosts',
		[address],
		{ timeoutMs: 20000 },
	);
}

/** Start the container if it is not running (idempotent). */
export async function ensureRunning(containerName: string): Promise<boolean> {
	const state = await runDocker(["inspect", "-f", "{{.State.Running}}", containerName], { timeoutMs: 15000 });
	if (state.code !== 0) return false;
	if (state.stdout.trim() === "true") return true;
	const start = await runDocker(["start", containerName], { timeoutMs: 60000 });
	return start.code === 0;
}

/** Stop the project container, keeping it around so it can be started again. */
export async function stopContainer(containerName: string): Promise<{ ok: boolean; error?: string }> {
	const result = await runDocker(["stop", containerName], { timeoutMs: 120000 });
	return result.code === 0 ? { ok: true } : { ok: false, error: result.stderr.trim() };
}

/**
 * Make sure a project has a running container, creating it when it is gone.
 *
 * "Gone" is a normal state now: removing just the container (or rebuilding it)
 * leaves the project registered with its work directory, and the next explicit
 * start recreates the container from the current settings.
 *
 * A sidecar has to be up before this is called: Docker cannot start a container
 * against a network namespace that is not running, so the caller starts the
 * sidecar first.
 */
export async function ensureContainer(
	containerName: string,
	workDir: string,
	network: SentinelContainerNetwork,
	sidecar?: string,
	resolvConfPath?: string,
): Promise<{ ok: boolean; created: boolean; error?: string }> {
	const state = await runDocker(["inspect", "-f", "{{.State.Running}}", containerName], { timeoutMs: 15000 });
	if (state.code !== 0) {
		if (!(await hasImage())) {
			return { ok: false, created: false, error: t("工具镜像尚未构建，请先构建镜像后再启动容器") };
		}
		const created = await createContainer(containerName, workDir, network, sidecar, resolvConfPath);
		return { ok: created.ok, created: true, error: created.error };
	}
	if (state.stdout.trim() === "true") return { ok: true, created: false };
	const start = await runDocker(["start", containerName], { timeoutMs: 60000 });
	if (start.code !== 0) return { ok: false, created: false, error: start.stderr.trim() };
	if (sidecar) await alignHostAlias(containerName, sidecar);
	return { ok: true, created: false };
}

/**
 * Container state per container name, in one docker call.
 *
 * `docker ps -a` lists stopped containers too, so a name that is absent has no
 * container at all — which is what the projects page shows as 「无容器」.
 */
export async function containerStates(): Promise<Map<string, "running" | "stopped">> {
	const states = new Map<string, "running" | "stopped">();
	const result = await runDocker(["ps", "-a", "--format", "{{.Names}}\t{{.State}}"], { timeoutMs: 15000 });
	if (result.code !== 0) return states;
	for (const line of result.stdout.split("\n")) {
		const [name, state] = line.trim().split("\t");
		if (!name) continue;
		states.set(name, state === "running" ? "running" : "stopped");
	}
	return states;
}

/**
 * Force-remove the project container.
 *
 * Returns the docker error when the container could not be removed, so the
 * caller can tell the operator rather than dropping the registry entry while a
 * container still holds the work directory.
 */
export async function removeContainer(containerName: string): Promise<{ ok: boolean; error?: string }> {
	const result = await runDocker(["rm", "-f", containerName], { timeoutMs: 60000 });
	// Already gone counts as removed: the operator asked for it to not exist.
	if (result.code === 0) return { ok: true };
	const inspect = await runDocker(["inspect", "-f", "{{.Id}}", containerName], { timeoutMs: 15000 });
	return inspect.code === 0 ? { ok: false, error: result.stderr.trim() } : { ok: true };
}

/**
 * Delete a project's host work directory, refusing anything outside the
 * projects root: the path comes from the registry, but a corrupted entry must
 * not be able to turn a delete into `rm -rf` somewhere else.
 */
export function deleteProjectWorkDir(workDir: string): { ok: boolean; error?: string } {
	if (!workDir.trim()) return { ok: false, error: t("工作目录为空，拒绝删除") };
	const root = resolve(process.env.SENTINEL_PROJECTS_DIR ?? join(homedir(), ".sentinel", "projects"));
	const target = resolve(workDir);
	if (target === root || !target.startsWith(root + sep)) {
		return { ok: false, error: t("工作目录不在项目根目录下，拒绝删除：{dir}", { dir: target }) };
	}
	rmSync(target, { recursive: true, force: true });
	return { ok: true };
}

/**
 * Container name prefix. `SENTINEL_CONTAINER_PREFIX` relocates it, so a second
 * instance — a test run beside a live console — never lists, stops, or removes
 * the other instance's containers. Read at call time, like `SENTINEL_PROJECTS_DIR`, so
 * a per-test environment change takes effect without reloading the module.
 */
export function containerPrefix(): string {
	const prefix = process.env.SENTINEL_CONTAINER_PREFIX;
	return prefix && prefix.length > 0 ? prefix : "sentinel-";
}

export function containerNameFor(projectId: string): string {
	return `${containerPrefix()}${projectId.slice(0, 12)}`;
}

/**
 * Map a host-side working directory to its path inside a project container.
 * The project work directory is always mounted at /work, so anything under it
 * maps to /work/<relative>; anything else falls back to /work. Never pass the
 * host path through as-is: a container without the same-path convenience mount
 * may still contain a stale copy of that path, and commands would silently run
 * against it instead of the live project directory.
 */
export function containerWorkPath(hostCwd: string | undefined, hostWorkDir: string): string {
	if (!hostCwd) return "/work";
	const normalized = hostCwd.replace(/\/+$/, "");
	if (normalized === hostWorkDir) return "/work";
	if (normalized.startsWith(`${hostWorkDir}/`)) {
		const relative = normalized.slice(hostWorkDir.length + 1);
		return `/work/${relative}`;
	}
	return "/work";
}

// A descendant can call setsid (LibreOffice does), escaping the command's process
// group while keeping its output pipes open. An inherited environment marker
// identifies those processes without touching other calls in the same container.
const KILL_BASH_PROCESSES = `
for file in /proc/[0-9]*/environ; do
  [ -r "$file" ] || continue
  if tr '\\000' '\\n' < "$file" 2>/dev/null | grep -Fxq -- "$1"; then
    pid="\${file#/proc/}"
    pid="\${pid%/environ}"
    kill -KILL "$pid" 2>/dev/null || :
  fi
done
`;

function killContainerBashProcesses(containerName: string, marker: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("docker", ["exec", containerName, "sh", "-c", KILL_BASH_PROCESSES, "zg", marker], {
			stdio: "ignore",
		});
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(ok);
		};
		// Docker itself can be unavailable. Do not make stopping a command wait
		// indefinitely for its cleanup request or for inherited stdio to close.
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(false);
		}, 5000);
		child.once("error", () => finish(false));
		child.once("exit", (code) => finish(code === 0));
	});
}

/**
 * Run bash in a project container, streaming output and honoring timeout/abort.
 * The session cwd maps to /work so per-task workspaces remain isolated.
 */
export function dockerBashOperations(containerName: string, options: { hostWorkDir?: string } = {}): BashOperations {
	return {
		exec: (command, cwd, execOptions) => {
			return new Promise((resolve, reject) => {
				const timeout = execOptions.timeout;
				if (
					timeout !== undefined &&
					(!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647)
				) {
					reject(new Error("Invalid timeout: must be positive finite seconds within the timer limit"));
					return;
				}
				if (execOptions.signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				const workdir = options.hostWorkDir ? containerWorkPath(cwd, options.hostWorkDir) : cwd || "/work";
				const marker = `SENTINEL_BASH_EXEC_ID=${randomUUID()}`;
				const child = spawn(
					"docker",
					["exec", "-i", "-w", workdir, "-e", marker, containerName, "sh", "-c", command],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);
				let settled = false;
				let stopping = false;
				let timer: NodeJS.Timeout | undefined;
				const finish = (code: number | null, error?: Error) => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					execOptions.signal?.removeEventListener("abort", onAbort);
					if (error) reject(error);
					else resolve({ exitCode: code ?? 1 });
				};
				const stop = (error: Error) => {
					if (settled || stopping) return;
					stopping = true;
					if (timer) clearTimeout(timer);
					child.kill("SIGKILL");
					child.stdout.destroy();
					child.stderr.destroy();
					void killContainerBashProcesses(containerName, marker).then((ok) => {
						if (!ok) execOptions.onData(Buffer.from("\nWarning: container command process cleanup failed.\n"));
						finish(null, error);
					});
				};
				const onAbort = () => stop(new Error("aborted"));
				child.stdout.on("data", (chunk: Buffer) => execOptions.onData(chunk));
				child.stderr.on("data", (chunk: Buffer) => execOptions.onData(chunk));
				child.on("close", (code) => {
					if (!stopping) finish(code);
				});
				child.on("error", (error) => {
					if (!stopping) finish(null, error);
				});
				if (timeout !== undefined) timer = setTimeout(() => stop(new Error(`timeout:${timeout}`)), timeout * 1000);
				execOptions.signal?.addEventListener("abort", onAbort, { once: true });
				if (execOptions.signal?.aborted) onAbort();
			});
		},
	};
}
