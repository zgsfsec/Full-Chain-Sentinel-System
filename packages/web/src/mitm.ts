/** Project-owned capture workers. Operator traffic never enters the Agent's replayd instance. */
import { createHash, pbkdf2Sync, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { containerPrefix, runDocker, SENTINEL_IMAGE } from "./docker.ts";
import { installProjectMitmCa, projectMitmDirectory } from "./mitm-certificate.ts";
import { MITM_READ_SCRIPT, MitmError, type MitmReader } from "./mitm-store.ts";
import type { MitmConfig, MitmStatus } from "./mitm-types.ts";
import { readReplaydBinary, replaydArchFromUname, replaydBinaryHint } from "./replayd-binary.ts";

interface MitmProject {
	id: string;
	name: string;
	container?: string;
}
interface StoredMitmConfig extends Omit<MitmConfig, "hasPassword"> {
	authSalt: string;
	authPasswordHash: string;
}

function publicConfig(config: StoredMitmConfig): MitmConfig {
	const { authSalt, authPasswordHash, ...visible } = config;
	return { ...visible, hasPassword: Boolean(authSalt && authPasswordHash) };
}
interface DockerState {
	State: { Running: boolean };
	Config: { Labels: Record<string, string> | null };
	NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
}

export class MitmCenter {
	private readonly root: string;
	private readonly projects: () => MitmProject[];
	private readonly docker: typeof runDocker;
	private readonly locks = new Map<string, Promise<unknown>>();
	private readonly deleting = new Set<string>();
	constructor(agentDir: string, projects: () => MitmProject[], docker: typeof runDocker = runDocker) {
		this.root = resolve(agentDir, "mitm");
		this.projects = projects;
		this.docker = docker;
	}

	private project(id: string): MitmProject {
		const project = this.projects().find((entry) => entry.id === id);
		if (!project || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || this.deleting.has(id))
			throw new MitmError("项目不存在或正在删除。", 404);
		return project;
	}

	directory(id: string): string {
		this.project(id);
		return projectMitmDirectory(dirname(this.root), id);
	}
	private container(id: string): string {
		return `${containerPrefix()}mitm-${id}`;
	}
	private owner(id: string): string {
		return createHash("sha256").update(`${this.root}/${id}`).digest("hex");
	}
	private configPath(id: string): string {
		return join(this.root, id, "config.json");
	}

	private config(id: string): StoredMitmConfig {
		const path = this.configPath(id);
		if (!existsSync(path)) return this.validate({ bind: "127.0.0.1", port: 0 });
		return this.validate(JSON.parse(readFileSync(path, "utf8")));
	}
	private validate(value: unknown): StoredMitmConfig {
		const raw = value as Partial<StoredMitmConfig> | null;
		if (
			!raw ||
			!["127.0.0.1", "0.0.0.0"].includes(raw.bind ?? "") ||
			!Number.isSafeInteger(raw.port) ||
			(raw.port ?? -1) < 0 ||
			(raw.port ?? 65536) > 65535
		)
			throw new MitmError("监听地址无效；端口应为 1–65535，或填 0 自动分配。");
		const skipStatic = raw.skipStatic ?? true;
		const maxCaptureMb = raw.maxCaptureMb ?? 2;
		if (typeof skipStatic !== "boolean" || !Number.isInteger(maxCaptureMb) || maxCaptureMb < 1 || maxCaptureMb > 32)
			throw new MitmError("报文保存上限应为 1–32 MB，静态资源过滤应为开关值。");
		const authEnabled = raw.authEnabled ?? false;
		const authUsername = raw.authUsername ?? "";
		const authSalt = raw.authSalt ?? "";
		const authPasswordHash = raw.authPasswordHash ?? "";
		if (
			typeof authEnabled !== "boolean" ||
			typeof authUsername !== "string" ||
			!/^[\x21-\x39\x3b-\x7e]{0,64}$/.test(authUsername) ||
			(authEnabled && !authUsername) ||
			typeof authSalt !== "string" ||
			typeof authPasswordHash !== "string" ||
			(authEnabled && (!/^[a-f0-9]{32}$/.test(authSalt) || !/^[a-f0-9]{64}$/.test(authPasswordHash)))
		)
			throw new MitmError("请设置代理账号和密码；账号应为 1–64 位可见 ASCII 字符，不含冒号或空格。");
		return {
			bind: raw.bind as MitmConfig["bind"],
			port: raw.port as number,
			skipStatic,
			maxCaptureMb,
			authEnabled,
			authUsername,
			authSalt,
			authPasswordHash,
		};
	}
	private writeConfig(id: string, config: StoredMitmConfig): void {
		mkdirSync(join(this.root, id), { recursive: true, mode: 0o700 });
		const path = this.configPath(id);
		writeFileSync(`${path}.tmp`, JSON.stringify(config), { mode: 0o600 });
		renameSync(`${path}.tmp`, path);
	}

	private async inspect(id: string): Promise<DockerState | null> {
		const result = await this.docker(["inspect", this.container(id)], { timeoutMs: 15000 });
		if (result.code !== 0) {
			if (/no such (object|container)/i.test(result.stderr)) return null;
			throw new MitmError(`无法检查 MITM 容器：${result.stderr.trim().slice(-1000)}`, 503);
		}
		const state = (JSON.parse(result.stdout) as DockerState[])[0];
		if (state?.Config?.Labels?.["sentinel.mitm.owner"] !== this.owner(id))
			throw new MitmError("MITM 容器名被其他实例占用，请先检查 Docker。", 409);
		return state;
	}

	private exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
		const previous = this.locks.get(id) ?? Promise.resolve();
		const task = previous.catch(() => undefined).then(action);
		this.locks.set(id, task);
		void task
			.finally(() => {
				if (this.locks.get(id) === task) this.locks.delete(id);
			})
			.catch(() => {});
		return task;
	}

	certificate(id: string, format: "pem" | "crt"): Buffer {
		const path = join(this.directory(id), "ca", "ca.crt");
		if (!existsSync(path)) throw new MitmError("首次启动代理后才会生成项目 CA。", 404);
		const bytes = readFileSync(path);
		return format === "pem" ? bytes : new X509Certificate(bytes).raw;
	}

	/** Docker Desktop cannot safely share WAL shared memory between Linux and the host. */
	async reader(id: string): Promise<MitmReader | undefined> {
		this.project(id);
		if (!(await this.inspect(id))?.State.Running) return undefined;
		return async (queries) => {
			this.project(id);
			const result = await this.docker(
				["exec", this.container(id), "python3", "-c", MITM_READ_SCRIPT, JSON.stringify(queries)],
				{ timeoutMs: 10000 },
			);
			if (result.code !== 0) throw new MitmError("读取实时流量失败，请刷新重试或检查 MITM 容器日志。", 503);
			return JSON.parse(result.stdout) as unknown[][];
		};
	}

	async status(id: string): Promise<MitmStatus> {
		const project = this.project(id);
		const config = publicConfig(this.config(id));
		const lanIps = [
			...new Set(
				Object.values(networkInterfaces()).flatMap((addresses) =>
					(addresses ?? [])
						.filter((address) => !address.internal && address.family === "IPv4")
						.map((address) => address.address),
				),
			),
		];
		let ca: MitmStatus["ca"] = null;
		const path = join(this.directory(id), "ca", "ca.crt");
		if (existsSync(path)) {
			const cert = new X509Certificate(readFileSync(path));
			ca = { fingerprint: cert.fingerprint256, subject: cert.subject, expires: cert.validTo };
		}
		try {
			const state = await this.inspect(id);
			const port = Number(state?.NetworkSettings.Ports["8080/tcp"]?.[0]?.HostPort) || null;
			return {
				project,
				config,
				state: state ? (state.State.Running ? "running" : "stopped") : "missing",
				port,
				lanIps,
				ca,
			};
		} catch (error) {
			return {
				project,
				config,
				state: "unavailable",
				port: null,
				lanIps,
				ca,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	save(id: string, value: unknown): Promise<MitmStatus> {
		return this.exclusive(id, async () => {
			this.project(id);
			if ((await this.inspect(id))?.State.Running) throw new MitmError("请先停止代理，再修改监听配置。", 409);
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new MitmError("代理配置格式错误。");
			const raw = value as Partial<MitmConfig> & { password?: unknown };
			const previous = this.config(id);
			let authSalt = previous.authSalt;
			let authPasswordHash = previous.authPasswordHash;
			if (raw.password !== undefined && typeof raw.password !== "string") throw new MitmError("代理密码格式错误。");
			if (typeof raw.password === "string" && raw.password !== "") {
				if (!/^[\x20-\x7e]{8,128}$/.test(raw.password))
					throw new MitmError("代理密码应为 8–128 位可见 ASCII 字符。");
				authSalt = randomBytes(16).toString("hex");
				authPasswordHash = pbkdf2Sync(raw.password, Buffer.from(authSalt, "hex"), 100000, 32, "sha256").toString(
					"hex",
				);
			}
			const authEnabled = raw.authEnabled ?? previous.authEnabled;
			this.writeConfig(
				id,
				this.validate({
					bind: raw.bind,
					port: raw.port,
					skipStatic: raw.skipStatic,
					maxCaptureMb: raw.maxCaptureMb,
					authEnabled,
					authUsername: raw.authUsername ?? previous.authUsername,
					authSalt: authEnabled ? authSalt : "",
					authPasswordHash: authEnabled ? authPasswordHash : "",
				}),
			);
			return this.status(id);
		});
	}

	start(id: string): Promise<MitmStatus> {
		return this.exclusive(id, async () => {
			this.project(id);
			const state = await this.inspect(id);
			if (state?.State.Running) {
				await installProjectMitmCa(dirname(this.root), this.project(id), this.docker);
				return this.status(id);
			}
			const image = await this.docker(["image", "inspect", "--format", "{{.Architecture}}", SENTINEL_IMAGE], {
				timeoutMs: 15000,
			});
			if (image.code !== 0) throw new MitmError("请先在「设置 → 环境」构建工具镜像。", 409);
			const arch = replaydArchFromUname(image.stdout.trim());
			if (!arch) throw new MitmError("MITM 服务仅支持 Linux amd64 / arm64 工具镜像。", 409);
			const binary = readReplaydBinary(arch);
			if (!binary) throw new MitmError(replaydBinaryHint(arch), 409);
			const binDirectory = join(this.root, "bin");
			mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
			const binPath = join(binDirectory, `replayd-${arch}-${binary.sha256}`);
			if (!existsSync(binPath)) writeFileSync(binPath, binary.bytes, { mode: 0o755 });
			const directory = this.directory(id);
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const config = this.config(id);
			this.writeConfig(id, config);
			if (state) {
				const removed = await this.docker(["rm", this.container(id)], { timeoutMs: 15000 });
				if (removed.code !== 0) throw new MitmError(`无法更新 MITM 容器：${removed.stderr}`, 502);
			}
			// Management API stays on the container loopback; only the proxy is published.
			const started = await this.docker(
				[
					"run",
					"-d",
					"--init",
					"--name",
					this.container(id),
					"--label",
					`sentinel.mitm.owner=${this.owner(id)}`,
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"--pids-limit",
					"128",
					"--log-opt",
					"max-size=10m",
					"--log-opt",
					"max-file=2",
					"--user",
					`${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
					"-e",
					"HOME=/data",
					"--add-host",
					"host.docker.internal:host-gateway",
					"-p",
					`${config.bind}:${config.port}:8080`,
					"-v",
					`${directory}:/data`,
					"-v",
					`${binPath}:/opt/mitm/replayd:ro`,
					"-v",
					`${this.configPath(id)}:/opt/mitm/proxy-auth.json:ro`,
					"--entrypoint",
					"/opt/mitm/replayd",
					SENTINEL_IMAGE,
					"-data-dir",
					"/data",
					"-listen",
					"127.0.0.1:8081",
					"-proxy-listen",
					"0.0.0.0:8080",
					"-proxy-auth-file",
					"/opt/mitm/proxy-auth.json",
					`-proxy-skip-static=${config.skipStatic}`,
					"-proxy-max-capture-bytes",
					String(config.maxCaptureMb * 1024 * 1024),
					"-quiet",
					"-log-format",
					"json",
				],
				{ timeoutMs: 60000 },
			);
			if (started.code !== 0)
				throw new MitmError(`代理启动失败，请检查端口占用及 Docker：${started.stderr.trim().slice(-1500)}`, 502);
			try {
				for (let attempt = 0; attempt < 30; attempt++) {
					this.project(id);
					const health = await this.docker(
						["exec", this.container(id), "curl", "-fsS", "--max-time", "2", "http://127.0.0.1:8081/api/health"],
						{ timeoutMs: 5000 },
					);
					if (health.code === 0) {
						const status = await this.status(id);
						if (status.state === "running" && status.port && status.ca) {
							this.writeConfig(id, { ...config, port: status.port });
							await installProjectMitmCa(dirname(this.root), this.project(id), this.docker);
							return { ...status, config: publicConfig({ ...config, port: status.port }) };
						}
					}
					await delay(200);
				}
				const log = await this.docker(["logs", "--tail", "15", this.container(id)], { timeoutMs: 5000 });
				throw new MitmError(`MITM 服务未就绪：${(log.stderr || log.stdout).slice(-1500)}`, 502);
			} catch (error) {
				await this.docker(["stop", "--time", "2", this.container(id)], { timeoutMs: 10000 });
				throw error;
			}
		});
	}

	stop(id: string): Promise<MitmStatus> {
		return this.exclusive(id, async () => {
			this.project(id);
			const state = await this.inspect(id);
			if (state?.State.Running) {
				const stopped = await this.docker(["stop", "--time", "2", this.container(id)], { timeoutMs: 15000 });
				if (stopped.code !== 0) throw new MitmError(`停止代理失败：${stopped.stderr}`, 502);
			}
			return this.status(id);
		});
	}

	clear(id: string): Promise<void> {
		return this.exclusive(id, async () => {
			this.project(id);
			const state = await this.inspect(id);
			if (state?.State.Running) throw new MitmError("清空前请先停止代理。", 409);
			const directory = this.directory(id);
			if (!existsSync(directory)) return;
			if (state) {
				const removed = await this.docker(["rm", this.container(id)], { timeoutMs: 15000 });
				if (removed.code !== 0) throw new MitmError(`无法释放 MITM 数据目录：${removed.stderr}`, 502);
			}
			// Use a new mount path: Docker Desktop can cache deleted SQLite paths across containers.
			const name = `data-${randomUUID()}`;
			const next = join(this.root, id, name);
			const pointer = join(this.root, id, "capture.json");
			mkdirSync(next, { mode: 0o700 });
			let switched = false;
			try {
				for (const name of ["ca", "token"]) {
					if (existsSync(join(directory, name)))
						cpSync(join(directory, name), join(next, name), { recursive: true });
				}
				writeFileSync(`${pointer}.tmp`, JSON.stringify(name), { mode: 0o600 });
				renameSync(`${pointer}.tmp`, pointer);
				switched = true;
				rmSync(directory, { recursive: true, force: true });
			} finally {
				if (!switched) rmSync(next, { recursive: true, force: true });
			}
		});
	}

	/** Stop before unregistering a project, so failed cleanup can still be retried. */
	purge(id: string): Promise<void>;
	purge<T>(id: string, unregister: () => Promise<T>): Promise<T>;
	purge<T>(id: string, unregister?: () => Promise<T>): Promise<T | undefined> {
		this.project(id);
		this.deleting.add(id);
		return this.exclusive(id, async () => {
			try {
				if (existsSync(join(this.root, id)) && (await this.inspect(id))) {
					const removed = await this.docker(["rm", "-f", this.container(id)], { timeoutMs: 20000 });
					if (removed.code !== 0) throw new MitmError(`无法清理项目 MITM 容器：${removed.stderr}`, 502);
				}
				rmSync(join(this.root, id), { recursive: true, force: true });
				// Keep starts blocked until the registry operation has completed too.
				return await unregister?.();
			} finally {
				this.deleting.delete(id);
			}
		});
	}
}
