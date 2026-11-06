/**
 * Docker environment check.
 *
 * The console is a front end to a toolbox container: every bash call is a
 * `docker exec` into a project container, so without a working Docker daemon and
 * the toolbox image nothing in the console works. This module answers, before the
 * operator types anything, whether the machine can actually run a task, and what
 * to fix when it cannot.
 *
 * Each item states whether it is blocking. `ok` means every blocking item passed;
 * the console refuses prompts until that is true.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONTAINER_NETWORK, readContainerNetwork } from "./container-network.ts";
import { runDocker, SENTINEL_IMAGE } from "./docker.ts";
import { GATEWAY_RUNTIME } from "./gateway-runtime.ts";
import { t } from "./i18n.ts";
import { resolveLibraryRole } from "./model-library.ts";
import { DEFAULT_TEST_URL } from "./node-test.ts";
import { listProjects, projectSidecarName } from "./projects.ts";
import type { SentinelEnvItem, SentinelEnvReport, SentinelProxyConfigView } from "./protocol.ts";
import {
	DEFAULT_SINGBOX_IMAGE,
	isTunnelMode,
	projectOpenVpnConfigPath,
	projectProxyConfigPath,
	projectWireGuardConfigPath,
	proxyConfigView,
	proxyEnabled,
	readProxies,
	resolveProjectProxy,
} from "./proxy.ts";
import { checkSidecar, hasSingboxImage, singboxState } from "./singbox.ts";
import { DEFAULT_BASE_IMAGE, EMPTY_SOURCES, effectiveSources, readSources } from "./sources.ts";

const GROUP_RUNTIME = "Docker 运行时";
const GROUP_IMAGE = "工具镜像";
const GROUP_CONTAINER = "容器能力";
const GROUP_HOST = "宿主环境";

/** Below this the image build and container layers can run out of room. */
const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runCommand(file: string, args: string[], timeoutMs: number): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		const finish = (code: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		};
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => finish(code ?? 1));
		child.on("error", (error) => {
			stderr = String(error);
			finish(1);
		});
	});
}

function passed(id: string, group: string, label: string, detail: string, blocking = false): SentinelEnvItem {
	return { id, group, label, status: "ok", detail, blocking };
}

function failed(id: string, group: string, label: string, detail: string, hint: string): SentinelEnvItem {
	return { id, group, label, status: "fail", detail, hint, blocking: true };
}

function warned(id: string, group: string, label: string, detail: string, hint?: string): SentinelEnvItem {
	return { id, group, label, status: "warn", detail, hint, blocking: false };
}

function skipped(id: string, group: string, label: string, detail: string, blocking = false): SentinelEnvItem {
	return { id, group, label, status: "skipped", detail, blocking };
}

/** Docker reports `aarch64`/`x86_64` where images are tagged `arm64`/`amd64`. */
function normalizeArch(arch: string): string {
	const value = arch.trim().toLowerCase();
	if (value === "aarch64" || value === "arm64") return "arm64";
	if (value === "x86_64" || value === "amd64") return "amd64";
	return value;
}

/** Writable means: create the directory if needed, then write and remove a file. */
function checkWritable(dir: string): { ok: boolean; error?: string } {
	try {
		mkdirSync(dir, { recursive: true });
		const probe = join(dir, ".sentinel-write-probe");
		writeFileSync(probe, "");
		unlinkSync(probe);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return t("未知");
	const gb = bytes / 1024 / 1024 / 1024;
	return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function formatTimestamp(value: string): string {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? t("时间未知") : new Date(parsed).toLocaleString("zh-CN");
}

async function freeDiskBytes(path: string): Promise<number | undefined> {
	const result = await runCommand("df", ["-k", path], 10000);
	if (result.code !== 0) return undefined;
	const line = result.stdout.trim().split("\n")[1];
	if (!line) return undefined;
	const available = Number(line.split(/\s+/)[3]);
	return Number.isFinite(available) ? available * 1024 : undefined;
}

function projectsRoot(): string {
	return process.env.SENTINEL_PROJECTS_DIR ?? join(homedir(), ".sentinel", "projects");
}

interface RuntimeProbe {
	item: SentinelEnvItem;
	/** `linux/arm64`-style host platform, when the daemon reported one. */
	hostPlatform?: string;
}

async function checkDockerRuntime(): Promise<RuntimeProbe> {
	const cli = await runDocker(["--version"], { timeoutMs: 15000 });
	if (cli.code !== 0) {
		const missing = /ENOENT|not found/i.test(cli.stderr);
		return {
			item: failed(
				"docker-cli",
				GROUP_RUNTIME,
				t("docker 命令"),
				missing ? t("未找到 docker 命令") : cli.stderr.trim() || t("退出码 {code}", { code: cli.code }),
				t("安装 Docker Engine 或 Docker Desktop，并确认 docker 在 PATH 中"),
			),
		};
	}
	const version = cli.stdout.trim() || t("版本未知");

	const info = await runDocker(["info", "--format", "{{.ServerVersion}}|{{.OSType}}|{{.Architecture}}"], {
		timeoutMs: 30000,
	});
	if (info.code !== 0) {
		const stderr = info.stderr.trim();
		const hint = /permission denied|dial unix|connect/i.test(stderr)
			? t("Docker 守护进程不可达：启动 Docker Desktop / dockerd，或把当前用户加入 docker 组")
			: t("Docker 守护进程未响应，先启动 Docker 再复检");
		return {
			item: failed(
				"docker-daemon",
				GROUP_RUNTIME,
				t("Docker 守护进程"),
				stderr || t("退出码 {code}", { code: info.code }),
				hint,
			),
		};
	}
	const [serverVersion, osType, arch] = info.stdout.trim().split("|");
	const hostPlatform = osType && arch ? `${osType}/${normalizeArch(arch)}` : undefined;
	return {
		item: passed(
			"docker-daemon",
			GROUP_RUNTIME,
			t("Docker 守护进程"),
			`${t("{version} · 服务端 {server}", {
				version,
				server: serverVersion || t("版本未知"),
			})}${hostPlatform ? ` · ${hostPlatform}` : ""}`,
			true,
		),
		hostPlatform,
	};
}

async function checkImage(hostPlatform: string | undefined): Promise<SentinelEnvItem[]> {
	const inspect = await runDocker(
		["image", "inspect", SENTINEL_IMAGE, "--format", "{{.Os}}/{{.Architecture}}|{{.Size}}|{{.Created}}"],
		{ timeoutMs: 20000 },
	);
	if (inspect.code !== 0) {
		return [
			failed(
				"image-present",
				GROUP_IMAGE,
				t("工具镜像 {image}", { image: SENTINEL_IMAGE }),
				t("本地不存在该镜像"),
				t("点下方「构建镜像」（需要网络下载 Kali 软件包）；也可在能联网的机器上 docker build 后导入镜像"),
			),
		];
	}
	const [platform, size, created] = inspect.stdout.trim().split("|");
	const items = [
		passed(
			"image-present",
			GROUP_IMAGE,
			t("工具镜像 {image}", { image: SENTINEL_IMAGE }),
			t("{platform} · {size} · 构建于 {created}", {
				platform: platform || t("平台未知"),
				size: formatBytes(Number(size)),
				created: formatTimestamp(created ?? ""),
			}),
			true,
		),
	];
	if (!platform || !hostPlatform) {
		items.push(skipped("image-platform", GROUP_IMAGE, t("镜像与宿主架构"), t("无法读取镜像或宿主的平台信息")));
		return items;
	}
	if (platform.trim().toLowerCase() === hostPlatform.toLowerCase()) {
		items.push(
			passed(
				"image-platform",
				GROUP_IMAGE,
				t("镜像与宿主架构"),
				t("与宿主一致（{platform}）", { platform: hostPlatform }),
			),
		);
	} else {
		items.push(
			warned(
				"image-platform",
				GROUP_IMAGE,
				t("镜像与宿主架构"),
				t("镜像 {image}，宿主 {host}", { image: platform, host: hostPlatform }),
				t("架构不一致的容器只能靠模拟运行，速度慢且部分工具不可用；建议在目标机器上重新构建镜像"),
			),
		);
	}
	return items;
}

async function checkContainerRun(): Promise<SentinelEnvItem> {
	// Exit code is the signal: it is non-zero when the image cannot start at all.
	// `--pull=never` keeps a missing image from turning into a registry download.
	const result = await runDocker(
		[
			"run",
			"--rm",
			"--pull=never",
			"--network",
			"none",
			"--entrypoint",
			"sh",
			SENTINEL_IMAGE,
			"-c",
			"echo sentinel-env-ok",
		],
		{ timeoutMs: 120000 },
	);
	if (result.code !== 0) {
		return failed(
			"container-run",
			GROUP_CONTAINER,
			t("启动一次性容器"),
			result.stderr.trim().slice(-400) || t("退出码 {code}", { code: result.code }),
			t("检查 Docker 资源（内存、磁盘）与镜像完整性；必要时删除镜像后重新构建"),
		);
	}
	const echoed = result.stdout.includes("sentinel-env-ok");
	return passed(
		"container-run",
		GROUP_CONTAINER,
		t("启动一次性容器"),
		echoed ? t("容器可启动，镜像内 shell 可用") : t("容器可启动"),
		true,
	);
}

async function checkGatewayRuntime(): Promise<SentinelEnvItem> {
	// The probe runs the real initialization in a disposable, isolated namespace.
	const result = await runDocker(
		[
			"run",
			"--rm",
			"--pull=never",
			"--network",
			"none",
			"--cap-add",
			"NET_ADMIN",
			"--cap-add",
			"NET_RAW",
			"--sysctl",
			"net.ipv4.conf.all.src_valid_mark=1",
			...(existsSync("/dev/net/tun") ? ["--device", "/dev/net/tun"] : []),
			"--entrypoint",
			"sh",
			process.env.SENTINEL_GATEWAY_IMAGE || SENTINEL_IMAGE,
			"-c",
			GATEWAY_RUNTIME,
			"sentinel-gateway",
			"probe",
		],
		{ timeoutMs: 30000 },
	);
	if (result.code !== 0 || !result.stdout.includes("gateway-ready:")) {
		return failed(
			"gateway-runtime",
			GROUP_CONTAINER,
			t("网关初始化"),
			result.stderr.trim().slice(-2000) || t("网关未返回就绪标记"),
			t("检查网关镜像中的网络工具、TUN 设备和 Docker NET_ADMIN 权限；IPv6 已禁用时可仅使用 IPv4"),
		);
	}
	return passed(
		"gateway-runtime",
		GROUP_CONTAINER,
		t("网关初始化"),
		result.stdout.includes("gateway-ready: 4 6")
			? t("IPv4 / IPv6 网关初始化通过")
			: t("IPv4 网关初始化通过（IPv6 已禁用）"),
		true,
	);
}

/**
 * What a container's network should be, as one word, for comparison with what
 * Docker reports. `proxy` covers every `container:<id>` mode: the sidecar's
 * namespace is a different thing from either of the two built-in modes, and a
 * container built under the wrong one needs the same fix.
 */
type NetworkKind = "host" | "bridge" | "proxy";

function networkKind(mode: string): NetworkKind | undefined {
	if (mode === "host") return "host";
	if (mode === "bridge" || mode === "default") return "bridge";
	return mode.startsWith("container:") ? "proxy" : undefined;
}

async function checkProjectContainers(agentDir: string | undefined): Promise<SentinelEnvItem> {
	if (!agentDir) {
		return skipped("project-containers", GROUP_CONTAINER, t("项目容器"), t("未配置配置目录"));
	}
	const { projects } = listProjects(agentDir);
	if (projects.length === 0) {
		return passed("project-containers", GROUP_CONTAINER, t("项目容器"), t("尚未创建项目"));
	}
	// The network mode and the proxy only reach a container when it is created, so
	// report what the running containers actually use: without this, changing a
	// setting and forgetting to rebuild looks exactly like the setting having no
	// effect. The namespace check is separate because a sidecar that was restarted
	// leaves the container running with no interfaces at all, which no inspect
	// field reveals.
	const wanted = readContainerNetwork(agentDir);
	const stale: string[] = [];
	const wrongNetwork: string[] = [];
	const staleNamespace: string[] = [];
	const staleConfig: string[] = [];
	const unhealthyGateways: string[] = [];
	let proxied = 0;
	for (const project of projects) {
		const settings = resolveProjectProxy(agentDir, project.proxyId);
		const wantsProxy = proxyEnabled(settings);
		if (wantsProxy) proxied += 1;
		const inspect = await runDocker(
			["inspect", "-f", "{{.State.Status}} {{.HostConfig.NetworkMode}}", project.container],
			{ timeoutMs: 15000 },
		);
		const [status = "", mode = ""] = inspect.stdout.trim().split(/\s+/);
		if (inspect.code !== 0 || !status) {
			stale.push(t("{name}（已丢失）", { name: project.name }));
			continue;
		}
		if (status !== "running") stale.push(t("{name}（{status}）", { name: project.name, status }));
		const actual = networkKind(mode);
		if (actual && actual !== (project.gateway || wantsProxy ? "proxy" : wanted)) wrongNetwork.push(project.name);
		if (project.gateway && actual === "proxy") {
			const health = await checkSidecar(project.container, projectSidecarName(project), "");
			if (health.netnsStale) staleNamespace.push(project.name);
			if (status === "running" && !project.manualStop) {
				const probe = await runDocker(
					["exec", projectSidecarName(project), "sh", "/etc/sentinel-gateway/runtime.sh", "status"],
					{ timeoutMs: 15000 },
				);
				if (probe.code !== 0) unhealthyGateways.push(project.name);
			}
		} else if (wantsProxy && actual === "proxy") {
			// A tunnel profile writes its own configuration instead of the JSON one, and
			// the staleness rule is the same: the file moved on after the sidecar
			// started, so a rebuild is what applies it.
			const health = await checkSidecar(
				project.container,
				projectSidecarName(project),
				settings?.mode === "wireguard"
					? projectWireGuardConfigPath(agentDir, project.id)
					: settings?.mode === "openvpn"
						? projectOpenVpnConfigPath(agentDir, project.id)
						: projectProxyConfigPath(agentDir, project.id),
			);
			if (health.netnsStale) staleNamespace.push(project.name);
			else if (health.configStale) staleConfig.push(project.name);
		}
	}
	if (
		stale.length > 0 ||
		wrongNetwork.length > 0 ||
		staleNamespace.length > 0 ||
		staleConfig.length > 0 ||
		unhealthyGateways.length > 0
	) {
		// All four can be true at once (a stopped project, a container built under
		// the old network, one whose sidecar was restarted, and one still serving a
		// configuration the operator has replaced), and each has its own fix, so
		// report them together.
		const parts: string[] = [];
		const hints: string[] = [];
		if (unhealthyGateways.length > 0) {
			parts.push(t("网关出口未就绪：{names}", { names: unhealthyGateways.join(t("、")) }));
			hints.push(t("重新保存项目代理设置，或启动项目以恢复网关出口，无需重建工作容器"));
		}
		if (stale.length > 0) {
			parts.push(
				t("{stale}/{total} 个未运行：{names}", {
					stale: stale.length,
					total: projects.length,
					names: stale.join(t("、")),
				}),
			);
			hints.push(t("在「项目」页重新创建或启动这些项目"));
		}
		if (wrongNetwork.length > 0) {
			parts.push(
				t("{wrong}/{total} 个容器的网络与当前设置不一致：{names}", {
					wrong: wrongNetwork.length,
					total: projects.length,
					names: wrongNetwork.join(t("、")),
				}),
			);
			hints.push(t("在「项目」页点「重建容器」切换网络，容器内 /work 之外的文件会丢、工作目录不受影响"));
		}
		if (staleNamespace.length > 0) {
			parts.push(
				t("{count} 个代理容器的网络命名空间已失效：{names}", {
					count: staleNamespace.length,
					names: staleNamespace.join(t("、")),
				}),
			);
			hints.push(t("代理容器被重启过；独立网关项目可停止后启动恢复，旧项目需重建容器"));
		}
		if (staleConfig.length > 0) {
			parts.push(
				t("{count} 个容器还在用改之前的代理配置：{names}", {
					count: staleConfig.length,
					names: staleConfig.join(t("、")),
				}),
			);
			hints.push(
				t(
					"代理容器要重启才会重新读配置，而这会让挂在它上面的容器失去网络，所以只能成对重建；在「项目」页点「重建容器」即可",
				),
			);
		}
		return warned("project-containers", GROUP_CONTAINER, t("项目容器"), parts.join(t("；")), hints.join(t("；")));
	}
	return passed(
		"project-containers",
		GROUP_CONTAINER,
		t("项目容器"),
		proxied > 0
			? t("全部运行中（{count} 个，其中 {proxied} 个走代理）", { count: projects.length, proxied })
			: t("全部运行中（{count} 个，网络 {network}）", {
					count: projects.length,
					network: projects.some((project) => project.gateway) ? t("独立网关") : wanted,
				}),
	);
}

/**
 * Whether the sing-box image the proxy sidecars run is present, plus what the 代理
 * page holds. Informational: only a project that actually uses a proxy needs the
 * image, and a project reports its own missing image when it is started.
 */
function checkProxyImage(view: SentinelProxyConfigView, present: boolean): SentinelEnvItem {
	if (view.proxies.length === 0) {
		return skipped("proxy-image", GROUP_IMAGE, t("代理镜像"), t("尚未在「代理」页添加代理"));
	}
	// A tunnel profile runs the toolbox image, not sing-box, so it does not need
	// this one at all.
	const needsSingbox = view.proxies.some((entry) => !isTunnelMode(entry.mode));
	if (!needsSingbox) {
		return skipped("proxy-image", GROUP_IMAGE, t("代理镜像"), t("只有隧道档案，用不到 sing-box 镜像"));
	}
	const label = t("代理镜像 {image}", { image: view.image });
	const summary = t("{count} 个代理 · 默认：{name}", {
		count: view.proxies.length,
		name: view.proxies.find((entry) => entry.id === view.defaultId)?.name ?? t("不使用"),
	});
	if (!present) {
		return warned(
			"proxy-image",
			GROUP_IMAGE,
			label,
			t("本地不存在该镜像"),
			t("在「代理」页点「拉取镜像」；国内网络拉不动时把镜像名换成可达的镜像源"),
		);
	}
	return passed("proxy-image", GROUP_IMAGE, label, `${t("已存在")} · ${summary}`);
}

/**
 * Whether every project that asked for a proxy still has its sidecar. A stopped
 * one is normal for a project the operator stopped by hand; a missing one means
 * the next start recreates it.
 */
async function checkProxySidecars(agentDir: string | undefined): Promise<SentinelEnvItem> {
	if (!agentDir) {
		return skipped("proxy-containers", GROUP_CONTAINER, t("代理容器"), t("未配置配置目录"));
	}
	const { projects } = listProjects(agentDir);
	const proxied = projects.filter(
		(project) => project.gateway || proxyEnabled(resolveProjectProxy(agentDir, project.proxyId)),
	);
	if (proxied.length === 0) {
		return passed(
			"proxy-containers",
			GROUP_CONTAINER,
			t("代理容器"),
			readProxies(agentDir).proxies.length === 0 ? t("尚未在「代理」页添加代理") : t("尚无项目使用代理"),
		);
	}
	const stopped: string[] = [];
	const missing: string[] = [];
	for (const project of proxied) {
		const state = await singboxState(projectSidecarName(project));
		if (state === "missing") missing.push(project.name);
		else if (state === "stopped") stopped.push(project.name);
	}
	if (stopped.length === 0 && missing.length === 0) {
		return passed(
			"proxy-containers",
			GROUP_CONTAINER,
			t("代理容器"),
			t("{count} 个项目的网关或代理容器全部运行中", { count: proxied.length }),
		);
	}
	const parts: string[] = [];
	const hints: string[] = [];
	if (stopped.length > 0) {
		parts.push(t("{count} 个已停止：{names}", { count: stopped.length, names: stopped.join(t("、")) }));
		hints.push(t("项目停止时 sidecar 一起停，启动项目时会自动拉起"));
	}
	if (missing.length > 0) {
		parts.push(t("{count} 个不存在：{names}", { count: missing.length, names: missing.join(t("、")) }));
		hints.push(t("启动或重建这些项目时会按当前代理设置重新创建 sidecar"));
	}
	return warned("proxy-containers", GROUP_CONTAINER, t("代理容器"), parts.join(t("；")), hints.join(t("；")));
}

/**
 * Verify the containers carry the project directory at its host path as well as at
 * /work. Without it, a bash command that uses the absolute path the model is given
 * writes into the container's own layer: the file never reaches the host, the file
 * tools and the file panel cannot see it, and recreating the container loses it.
 */
async function checkProjectMounts(agentDir: string | undefined): Promise<SentinelEnvItem> {
	if (!agentDir) {
		return skipped("project-mounts", GROUP_CONTAINER, t("工作目录挂载"), t("未配置配置目录"));
	}
	const { projects } = listProjects(agentDir);
	if (projects.length === 0) {
		return passed("project-mounts", GROUP_CONTAINER, t("工作目录挂载"), t("尚未创建项目"));
	}
	const legacy: string[] = [];
	let inspected = 0;
	for (const project of projects) {
		const inspect = await runDocker(
			["inspect", "-f", "{{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}", project.container],
			{ timeoutMs: 15000 },
		);
		const line = inspect.stdout.trim();
		// A format string the backend cannot answer yields no mount data (the test
		// suite's fake docker answers everything with "true"), so skip instead of
		// reporting a failure that is really an unknown.
		if (inspect.code !== 0 || !line.includes("->")) continue;
		inspected += 1;
		const mounts = line.split(/\s+/);
		if (!mounts.includes(`${project.workDir}->${project.workDir}`)) legacy.push(project.name);
	}
	if (inspected === 0) {
		return skipped("project-mounts", GROUP_CONTAINER, t("工作目录挂载"), t("无法读取挂载信息"));
	}
	if (legacy.length === 0) {
		return passed(
			"project-mounts",
			GROUP_CONTAINER,
			t("工作目录挂载"),
			t("项目目录同时挂在宿主路径（{count} 个容器）", { count: inspected }),
		);
	}
	return warned(
		"project-mounts",
		GROUP_CONTAINER,
		t("工作目录挂载"),
		t("{count} 个容器缺少同路径挂载：{names}", { count: legacy.length, names: legacy.join(t("、")) }),
		t("在「项目」页重建这些容器；重建前先用 docker cp 把容器内该路径下的文件复制出来，容器一删就没了"),
	);
}

/**
 * Report the sources the next image build will use. Informational: a mirror is a
 * choice, not a requirement, so this item never blocks.
 */
function checkBuildSources(agentDir: string | undefined): SentinelEnvItem {
	if (!agentDir) {
		return skipped("build-sources", GROUP_IMAGE, t("构建源"), t("未配置配置目录"));
	}
	const sources = effectiveSources(readSources(agentDir));
	const custom =
		sources.baseImage !== DEFAULT_BASE_IMAGE ||
		Boolean(sources.aptMirror || sources.pipIndex || sources.npmRegistry || sources.goProxy);
	if (!custom) {
		return passed(
			"build-sources",
			GROUP_IMAGE,
			t("构建源"),
			t("全部使用官方源（基础镜像 {image}）· 可在「设置 → 环境」切换国内镜像源", {
				image: DEFAULT_BASE_IMAGE,
			}),
		);
	}
	const parts = [t("基础镜像 {image}", { image: sources.baseImage })];
	parts.push(sources.aptMirror ? `apt ${sources.aptMirror}` : t("apt 官方源"));
	parts.push(sources.pipIndex ? `pip ${sources.pipIndex}` : t("pip 官方源"));
	parts.push(sources.npmRegistry ? `npm ${sources.npmRegistry}` : t("npm 官方源"));
	parts.push(sources.goProxy ? `go ${sources.goProxy}` : t("go 官方代理"));
	return passed("build-sources", GROUP_IMAGE, t("构建源"), parts.join(" · "));
}

function checkProjectsDir(): SentinelEnvItem {
	const root = projectsRoot();
	const result = checkWritable(root);
	if (!result.ok) {
		return failed(
			"projects-dir",
			GROUP_HOST,
			t("项目目录可写"),
			t("{path}：{error}", { path: root, error: result.error ?? t("不可写") }),
			t("修正目录权限，或用 SENTINEL_PROJECTS_DIR 指向一个可写目录"),
		);
	}
	return passed("projects-dir", GROUP_HOST, t("项目目录可写"), root, true);
}

function checkAgentDir(agentDir: string | undefined): SentinelEnvItem {
	if (!agentDir) {
		return skipped("agent-dir", GROUP_HOST, t("配置目录可写"), t("未配置配置目录"));
	}
	const result = checkWritable(agentDir);
	if (!result.ok) {
		return failed(
			"agent-dir",
			GROUP_HOST,
			t("配置目录可写"),
			t("{path}：{error}", { path: agentDir, error: result.error ?? t("不可写") }),
			t("修正目录权限，或用 SENTINEL_CODING_AGENT_DIR 指向一个可写目录"),
		);
	}
	return passed("agent-dir", GROUP_HOST, t("配置目录可写"), agentDir, true);
}

async function checkDisk(): Promise<SentinelEnvItem> {
	const root = projectsRoot();
	const free = await freeDiskBytes(existsSync(root) ? root : homedir());
	if (free === undefined) {
		return skipped("disk-space", GROUP_HOST, t("可用磁盘空间"), t("无法读取磁盘空间"));
	}
	if (free < MIN_FREE_BYTES) {
		return warned(
			"disk-space",
			GROUP_HOST,
			t("可用磁盘空间"),
			t("剩余 {size}", { size: formatBytes(free) }),
			t("工具镜像约 1.5 GB，容器还要额外空间；建议清理磁盘后重试"),
		);
	}
	return passed("disk-space", GROUP_HOST, t("可用磁盘空间"), t("剩余 {size}", { size: formatBytes(free) }));
}

function checkModelConfig(agentDir: string | undefined): SentinelEnvItem {
	if (!agentDir) {
		return skipped("model-config", GROUP_HOST, t("模型端点"), t("未配置配置目录"));
	}
	try {
		const config = resolveLibraryRole(agentDir, "main")?.config ?? null;
		if (!config || !config.baseUrl || !config.modelId) {
			return warned(
				"model-config",
				GROUP_HOST,
				t("模型端点"),
				t("尚未配置模型端点"),
				t("在「设置 → 模型」中填写 API 地址、模型 ID 与密钥"),
			);
		}
		return passed("model-config", GROUP_HOST, t("模型端点"), `${config.modelId} @ ${config.baseUrl}`);
	} catch (error) {
		return warned(
			"model-config",
			GROUP_HOST,
			t("模型端点"),
			error instanceof Error ? error.message : String(error),
			t("在「设置 → 模型」中检查配置"),
		);
	}
}

export interface EnvCheckOptions {
	agentDir?: string;
	url: string;
}

/** Run every check. Never throws: a failing check becomes a report item. */
export async function checkEnvironment(options: EnvCheckOptions): Promise<SentinelEnvReport> {
	const runtime = await checkDockerRuntime();
	const dockerReady = runtime.item.status === "ok";
	const items: SentinelEnvItem[] = [runtime.item];
	const image = options.agentDir ? readProxies(options.agentDir).image : DEFAULT_SINGBOX_IMAGE;
	const singboxImagePresent = dockerReady ? await hasSingboxImage(image) : false;
	const proxies: SentinelProxyConfigView = options.agentDir
		? proxyConfigView(options.agentDir, singboxImagePresent)
		: { proxies: [], defaultId: null, image, imagePresent: false, testUrl: DEFAULT_TEST_URL };

	const imageItems = dockerReady
		? await checkImage(runtime.hostPlatform)
		: [
				skipped(
					"image-present",
					GROUP_IMAGE,
					t("工具镜像 {image}", { image: SENTINEL_IMAGE }),
					t("Docker 不可用"),
					true,
				),
				skipped("image-platform", GROUP_IMAGE, t("镜像与宿主架构"), t("Docker 不可用")),
			];
	items.push(
		...imageItems,
		skipped("build-network", GROUP_IMAGE, t("构建镜像需要网络"), t("构建镜像时验证（apt 需要访问配置的软件源）")),
		checkBuildSources(options.agentDir),
		checkProxyImage(proxies, singboxImagePresent),
	);

	const imageReady = imageItems[0]?.status === "ok";
	items.push(
		imageReady
			? await checkContainerRun()
			: skipped(
					"container-run",
					GROUP_CONTAINER,
					t("启动一次性容器"),
					dockerReady ? t("工具镜像不可用") : t("Docker 不可用"),
					true,
				),
		dockerReady
			? await checkGatewayRuntime()
			: skipped("gateway-runtime", GROUP_CONTAINER, t("网关初始化"), t("Docker 不可用"), true),
		await checkProjectContainers(options.agentDir),
		await checkProxySidecars(options.agentDir),
		await checkProjectMounts(options.agentDir),
		checkProjectsDir(),
		checkAgentDir(options.agentDir),
		await checkDisk(),
		checkModelConfig(options.agentDir),
	);

	return {
		at: new Date().toISOString(),
		ok: items.every((entry) => !entry.blocking || entry.status === "ok"),
		items,
		url: options.url,
		sources: options.agentDir ? readSources(options.agentDir) : { ...EMPTY_SOURCES },
		containerNetwork: options.agentDir ? readContainerNetwork(options.agentDir) : DEFAULT_CONTAINER_NETWORK,
		proxies,
	};
}
