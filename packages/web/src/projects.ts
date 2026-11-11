/**
 * Project registry: each project owns a Docker container running the sentinel
 * toolbox image plus a host-side working directory mounted at /work.
 * Sessions, approvals, and reports stay on the host; only tool execution
 * happens inside the container.
 *
 * A project may also own a sing-box sidecar, in which case its container takes
 * that sidecar's network namespace instead of the host or bridge network. The two
 * containers are then a pair with an order that matters: the sidecar starts first,
 * stops last, and is never restarted while the project container is up.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readContainerNetwork } from "./container-network.ts";
import {
	containerNameFor,
	createContainer,
	ensureContainer,
	hasImage,
	projectWorkDir,
	removeContainer,
	SENTINEL_IMAGE,
	stopContainer,
} from "./docker.ts";
import { ensureGateway, projectGatewayDir, withGatewayLock } from "./gateway.ts";
import { t } from "./i18n.ts";
import { installProjectMitmCa } from "./mitm-certificate.ts";
import type { ProjectEgressIp } from "./project-egress-types.ts";
import type { SentinelProxySettings } from "./protocol.ts";
import {
	AUTO_NODE_TAG,
	isTunnelMode,
	projectOpenVpnAuthPath,
	projectOpenVpnConfigPath,
	projectOpenVpnHookPath,
	projectOpenVpnPushedDnsPath,
	projectProxyConfigPath,
	projectResolvConfPath,
	projectWireGuardConfigPath,
	proxyEnabled,
	resolveProjectProxy,
} from "./proxy.ts";
import {
	checkSidecar,
	ensureOpenVpnRunning,
	ensureSingboxRunning,
	ensureWireGuardRunning,
	hasSingboxImage,
	readPushedDnsWhenReady,
	removeSingboxContainer,
	singboxContainerNameFor,
	stopSingboxContainer,
	writeProjectOpenVpnFiles,
	writeProjectProxyConfig,
	writeProjectResolvConf,
	writeProjectWireGuardConfig,
} from "./singbox.ts";

export interface SentinelProject {
	id: string;
	name: string;
	/** Docker container running the toolbox image. */
	container: string;
	/** Host directory mounted at /work in the container. */
	workDir: string;
	createdAt: string;
	/** Kept until the operator successfully tests this project's exit again. */
	egressIp?: ProjectEgressIp;
	/**
	 * The operator stopped this project's container on purpose.
	 *
	 * Docker state is not enough to tell an intentional stop from a container
	 * that exited with the host: the first must wait for an explicit start, the
	 * second may be started again whenever the project is used.
	 */
	manualStop?: boolean;
	/**
	 * Which proxy this project's container is built with. Absent follows the
	 * default on the 代理 page — which is what lets a later change to that default
	 * reach every project that never made a choice of its own — `null` means the
	 * operator turned the proxy off for this project on purpose, and a string
	 * names a profile.
	 */
	proxyId?: string | null;
	/** Which node of that profile's subscription, when this project pins one. */
	proxyNode?: string;
	/** Persistent isolated gateway; proxy changes keep both container identities. */
	gateway?: boolean;
}

interface ProjectsFile {
	projects: SentinelProject[];
	lastActiveProjectId?: string;
}

function projectsPath(agentDir: string): string {
	return `${agentDir}/projects.json`;
}

function readProjects(agentDir: string): ProjectsFile {
	const path = projectsPath(agentDir);
	if (!existsSync(path)) return { projects: [] };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as ProjectsFile;
		if (!Array.isArray(parsed.projects)) return { projects: [] };
		return parsed;
	} catch {
		return { projects: [] };
	}
}

function writeProjects(agentDir: string, file: ProjectsFile): void {
	const path = projectsPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
}

export function listProjects(agentDir: string): ProjectsFile {
	return readProjects(agentDir);
}

export function recordProjectEgressIp(agentDir: string, id: string, result: ProjectEgressIp): void {
	const file = readProjects(agentDir);
	const project = file.projects.find((entry) => entry.id === id);
	if (!project) throw new Error(t("项目不存在"));
	project.egressIp = result;
	writeProjects(agentDir, file);
}

/**
 * The proxy one project's container is created with, or null when it runs
 * without one. A profile that no longer exists resolves to null: the operator
 * deleted the node, so the project falls back to a direct network rather than to
 * a configuration nothing can build.
 */
export function projectProxySettings(agentDir: string, project: SentinelProject): SentinelProxySettings | null {
	const settings = resolveProjectProxy(agentDir, project.proxyId);
	if (!settings || settings.mode !== "subscription" || !project.proxyNode) return settings;
	// A pinned node that the subscription no longer carries falls back to the
	// profile's own choice: the node was renamed or dropped by the provider, and a
	// project that cannot build its configuration is worse than one that moved.
	if (project.proxyNode !== AUTO_NODE_TAG && !settings.nodes.some((node) => node.tag === project.proxyNode))
		return settings;
	return { ...settings, nodeTag: project.proxyNode };
}

/** The sidecar container name of a project, whether or not one exists yet. */
export function projectSidecarName(project: SentinelProject): string {
	return singboxContainerNameFor(project.id);
}

/**
 * Bring a project's proxy sidecar up and return what the container needs.
 *
 * Nothing is created for a project whose proxy is off. When it is on, the
 * configuration is written and the sidecar started *before* the caller creates or
 * starts the project container, because Docker cannot join a namespace that is
 * not running.
 */
async function prepareSidecar(
	agentDir: string,
	project: SentinelProject,
): Promise<
	{ ok: true; sidecar?: string; configPath?: string; resolvConfPath?: string } | { ok: false; error: string }
> {
	const settings = projectProxySettings(agentDir, project);
	if (project.gateway) {
		const ready = await ensureGateway(agentDir, project, settings);
		return ready.ok
			? { ok: true, sidecar: ready.sidecar, resolvConfPath: ready.resolvConfPath }
			: { ok: false, error: ready.error ?? t("网关启动失败") };
	}
	if (!proxyEnabled(settings)) return { ok: true };
	const sidecar = projectSidecarName(project);

	// A tunnel is a different sidecar, not a different outbound: it runs
	// `wg-quick`, and the container gets the tunnel's resolver as a mounted
	// `/etc/resolv.conf` so lookups do not escape through Docker's own DNS.
	if (settings.mode === "wireguard") {
		const written = writeProjectWireGuardConfig(agentDir, project.id, settings.wireguard);
		if (!written.ok) return { ok: false, error: t("代理配置无法生成：{error}", { error: written.error }) };
		const resolver = writeProjectResolvConf(agentDir, project.id, written.dns);
		if (!resolver.ok) return { ok: false, error: t("隧道 DNS 无法写入：{error}", { error: resolver.error }) };
		const up = await ensureWireGuardRunning(sidecar, written.path, SENTINEL_IMAGE, settings.wireguard.killSwitch);
		if (!up.ok) {
			return { ok: false, error: t("代理容器启动失败：{error}", { error: up.error ?? "" }) };
		}
		return { ok: true, sidecar, configPath: written.path, resolvConfPath: resolver.path };
	}

	// OpenVPN is the other tunnel: the same shared namespace, but the sidecar stays in
	// the foreground, and the resolver may only become known once the server pushes it.
	if (settings.mode === "openvpn") {
		const written = writeProjectOpenVpnFiles(agentDir, project.id, settings.openvpn);
		if (!written.ok) return { ok: false, error: t("代理配置无法生成：{error}", { error: written.error }) };
		const up = await ensureOpenVpnRunning(sidecar, written.files, SENTINEL_IMAGE);
		if (!up.ok) return { ok: false, error: t("代理容器启动失败：{error}", { error: up.error ?? "" }) };
		// The profile's own resolver wins; what the server pushed is the fallback, and
		// it is only known now that the tunnel is up.
		const dns = written.dns.length > 0 ? written.dns : await readPushedDnsWhenReady(written.files.pushedDnsPath);
		if (dns.length === 0) return { ok: true, sidecar, configPath: written.files.configPath };
		const resolver = writeProjectResolvConf(agentDir, project.id, dns.join(", "));
		if (!resolver.ok) return { ok: false, error: t("隧道 DNS 无法写入：{error}", { error: resolver.error }) };
		return { ok: true, sidecar, configPath: written.files.configPath, resolvConfPath: resolver.path };
	}

	const written = await writeProjectProxyConfig(agentDir, project.id, settings);
	if (!written.ok) return { ok: false, error: t("代理配置无法生成：{error}", { error: written.error }) };
	const up = await ensureSingboxRunning(sidecar, written.path, settings.image);
	if (!up.ok) {
		return { ok: false, error: t("代理容器启动失败：{error}", { error: up.error ?? "" }) };
	}
	return { ok: true, sidecar, configPath: written.path };
}

/**
 * Make sure the project's container is running, on the network its current
 * settings call for.
 *
 * Two states are repaired here instead of reported, because in both the container
 * is already unusable and `/work` survives the repair:
 *
 * - A namespace that has gone stale (the sidecar was restarted or replaced under a
 *   running container): the container keeps running with no interfaces at all, so
 *   it is rebuilt onto the sidecar's current namespace.
 * - A container that is gone while its sidecar still serves an older
 *   configuration: the sidecar is recreated with it, since there is no container
 *   layer left to lose.
 *
 * A container that is merely on the wrong network (the proxy was switched on after
 * it was created) or that is serving a configuration the operator has since
 * replaced is left alone: both still work, and replacing the container would throw
 * away its layer without being asked. The environment page is what tells the
 * operator to rebuild it.
 */
async function bringProjectUp(
	agentDir: string,
	project: SentinelProject,
): Promise<{ ok: boolean; created: boolean; error?: string }> {
	const ready = await bringProjectContainerUp(agentDir, project);
	if (!ready.ok) return ready;
	try {
		await installProjectMitmCa(agentDir, project);
		return ready;
	} catch (error) {
		return { ...ready, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function bringProjectContainerUp(
	agentDir: string,
	project: SentinelProject,
): Promise<{ ok: boolean; created: boolean; error?: string }> {
	const prepared = await prepareSidecar(agentDir, project);
	if (!prepared.ok) return { ok: false, created: false, error: prepared.error };
	const network = readContainerNetwork(agentDir);
	if (project.gateway && prepared.sidecar) {
		const health = await checkSidecar(project.container, prepared.sidecar, "");
		if (health.exists && (!health.joined || health.netnsStale)) {
			// A restart can rejoin the namespace without destroying the writable layer.
			const stopped = await stopContainer(project.container);
			if (!stopped.ok) return { ok: false, created: false, error: stopped.error };
		}
		return ensureContainer(project.container, project.workDir, network, prepared.sidecar, prepared.resolvConfPath);
	}
	if (!prepared.sidecar || !prepared.configPath) {
		return ensureContainer(project.container, project.workDir, network, undefined, prepared.resolvConfPath);
	}
	let sidecar = prepared.sidecar;
	const health = await checkSidecar(project.container, sidecar, prepared.configPath);
	const rebuild = !health.exists || health.netnsStale;
	if (rebuild && health.configStale) {
		// The configuration moved on while the sidecar kept running, and the
		// container is being replaced anyway: rebuild both, in the only order that
		// leaves the new container on a namespace something is routing.
		const dropped = await removeSingboxContainer(sidecar);
		if (!dropped.ok) return { ok: false, created: false, error: dropped.error };
		const again = await prepareSidecar(agentDir, project);
		if (!again.ok) return { ok: false, created: false, error: again.error };
		sidecar = again.sidecar ?? sidecar;
	} else if (rebuild) {
		const removed = await removeContainer(project.container);
		if (!removed.ok) return { ok: false, created: false, error: removed.error };
	}
	return ensureContainer(project.container, project.workDir, network, sidecar, prepared.resolvConfPath);
}

/** Register a project: creates the container and its host work directory. */
export async function addProject(
	agentDir: string,
	input: { name: string; proxyId?: string | null; proxyNode?: string },
): Promise<{ project?: SentinelProject; error?: string }> {
	const name = input.name.trim();
	if (!name) return { error: t("项目名称不能为空") };
	const file = readProjects(agentDir);
	if (file.projects.some((project) => project.name === name)) {
		return { error: t("已存在同名项目") };
	}
	if (!(await hasImage())) {
		return { error: t("工具镜像尚未构建，请先构建镜像后再创建项目") };
	}
	const id = randomUUID();
	const container = containerNameFor(id);
	const workDir = projectWorkDir(name);
	const project: SentinelProject = {
		id,
		name,
		container,
		workDir,
		gateway: true,
		createdAt: new Date().toISOString(),
	};
	if (input.proxyId !== undefined) project.proxyId = input.proxyId;
	if (input.proxyNode?.trim()) project.proxyNode = input.proxyNode.trim();
	const settings = projectProxySettings(agentDir, project);
	// A tunnel runs its own client in the toolbox image, so none of this applies to
	// it; `prepareSidecar` writes its configuration and starts it.
	if (proxyEnabled(settings) && !isTunnelMode(settings.mode)) {
		// A project that cannot get its sidecar must not be registered: the
		// container would come up without the network the operator asked for.
		if (!(await hasSingboxImage(settings.image))) {
			return {
				error: t("代理镜像 {image} 尚未拉取，请先到「代理」页拉取镜像", { image: settings.image }),
			};
		}
	}
	// The gateway validates its candidate before starting any project processes.
	const prepared = await prepareSidecar(agentDir, project);
	const created = prepared.ok
		? await createContainer(
				container,
				workDir,
				readContainerNetwork(agentDir),
				prepared.sidecar,
				prepared.resolvConfPath,
			)
		: { ok: false, error: prepared.error };
	if (!created.ok) {
		await removeContainer(container);
		await removeSingboxContainer(projectSidecarName(project));
		rmSync(projectGatewayDir(agentDir, id), { recursive: true, force: true });
		rmSync(projectResolvConfPath(agentDir, id), { force: true });
		rmSync(projectProxyConfigPath(agentDir, id), { force: true });
		return { error: t("容器创建失败：{error}", { error: created.error ?? "" }) };
	}
	// Other projects may have changed while Docker was preparing this pair.
	const latest = readProjects(agentDir);
	latest.projects.push(project);
	writeProjects(agentDir, latest);
	return { project };
}

/**
 * Replace a project's container, keeping its id, name and host work directory.
 *
 * Docker cannot change a container's network after creation, so applying a new
 * network mode, a new proxy, or new capabilities means replacing the container —
 * and with a proxy, the sidecar as well, in that order. The work directory is a
 * bind mount and survives; the container's own layer does not, so anything
 * installed with apt or written outside /work is lost.
 */
export async function recreateProject(
	agentDir: string,
	id: string,
): Promise<{ project?: SentinelProject; error?: string }> {
	return withGatewayLock(`${agentDir}:${id}`, () => recreateProjectUnlocked(agentDir, id));
}

async function recreateProjectUnlocked(
	agentDir: string,
	id: string,
): Promise<{ project?: SentinelProject; error?: string }> {
	const file = readProjects(agentDir);
	const project = file.projects.find((entry) => entry.id === id);
	if (!project) return { error: t("项目不存在") };
	if (!(await hasImage())) {
		return { error: t("工具镜像尚未构建，请先构建镜像后再重建容器") };
	}
	const removed = await removeContainer(project.container);
	if (!removed.ok) return { error: t("容器删除失败：{error}", { error: removed.error ?? "" }) };
	// The sidecar goes too: its namespace is gone the moment it is replaced, and
	// reusing the container would leave the new project container on a namespace
	// nothing is routing.
	const sidecar = projectSidecarName(project);
	const removedSidecar = await removeSingboxContainer(sidecar);
	if (!removedSidecar.ok) return { error: t("代理容器删除失败：{error}", { error: removedSidecar.error ?? "" }) };
	project.gateway = true;
	const prepared = await prepareSidecar(agentDir, project);
	if (!prepared.ok) return { error: prepared.error };
	const created = await createContainer(
		project.container,
		project.workDir,
		readContainerNetwork(agentDir),
		prepared.sidecar,
		prepared.resolvConfPath,
	);
	if (!created.ok) return { error: t("容器重建失败：{error}", { error: created.error ?? "" }) };
	try {
		await installProjectMitmCa(agentDir, project);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	// A freshly created container is running: an earlier manual stop is spent.
	delete project.manualStop;
	writeProjects(agentDir, file);
	return { project };
}

/**
 * Remove a project's container, or the project itself.
 *
 * `container` keeps the registry entry and everything on the host: the container
 * is disposable, the work directory and the records are not. The project is left
 * needing an explicit start, which recreates the container from current settings.
 * `data` unregisters the project; its stored data is deleted by the caller, which
 * owns the databases and the session files.
 *
 * The proxy sidecar is removed either way — it is part of the container pair and
 * is recreated with it.
 */
export async function removeProject(
	agentDir: string,
	id: string,
	scope: ProjectRemoveScope = "data",
): Promise<{ removed?: SentinelProject; error?: string }> {
	return withGatewayLock(`${agentDir}:${id}`, () => removeProjectUnlocked(agentDir, id, scope));
}

async function removeProjectUnlocked(
	agentDir: string,
	id: string,
	scope: ProjectRemoveScope = "data",
): Promise<{ removed?: SentinelProject; error?: string }> {
	const file = readProjects(agentDir);
	const project = file.projects.find((entry) => entry.id === id);
	if (!project) return { error: t("项目不存在") };
	const removed = await removeContainer(project.container);
	if (!removed.ok) return { error: t("容器删除失败：{error}", { error: removed.error ?? "" }) };
	await removeSingboxContainer(projectSidecarName(project));
	if (scope === "container") {
		project.manualStop = true;
		writeProjects(agentDir, file);
		return { removed: project };
	}
	const index = file.projects.findIndex((entry) => entry.id === id);
	file.projects.splice(index, 1);
	if (file.lastActiveProjectId === id) delete file.lastActiveProjectId;
	writeProjects(agentDir, file);
	// The generated configuration carries the node credentials — and a tunnel's
	// private key — so a deleted project does not keep either on disk.
	rmSync(projectProxyConfigPath(agentDir, id), { force: true });
	rmSync(projectWireGuardConfigPath(agentDir, id), { force: true });
	rmSync(projectResolvConfPath(agentDir, id), { force: true });
	// An OpenVPN project's four files: the configuration carries the private key, the
	// credentials file the password, and the hook and pushed resolvers mean nothing
	// without them.
	rmSync(projectOpenVpnConfigPath(agentDir, id), { force: true });
	rmSync(projectOpenVpnAuthPath(agentDir, id), { force: true });
	rmSync(projectOpenVpnHookPath(agentDir, id), { force: true });
	rmSync(projectOpenVpnPushedDnsPath(agentDir, id), { force: true });
	rmSync(projectGatewayDir(agentDir, id), { recursive: true, force: true });
	return { removed: project };
}

/**
 * Point one project at a proxy profile, or clear the choice.
 *
 * `proxyId` absent goes back to following the default on the 代理 page, `null`
 * turns the proxy off for this project, and an id names a profile. Only the id is
 * stored — the profile itself is edited in one place and reaches every project
 * that picked it.
 */
export function setProjectProxy(
	agentDir: string,
	id: string,
	proxyId: string | null | undefined,
	proxyNode?: string,
): { project?: SentinelProject; error?: string } {
	const file = readProjects(agentDir);
	const project = file.projects.find((entry) => entry.id === id);
	if (!project) return { error: t("项目不存在") };
	// A node only means something next to the profile that holds it, so switching
	// away from a profile — or to one without a subscription — drops the pin.
	const settings = resolveProjectProxy(agentDir, proxyId);
	const node = proxyNode?.trim();
	// `auto` is not a node but a choice: let sing-box rank the nodes on a timer.
	if (
		node &&
		node !== AUTO_NODE_TAG &&
		settings?.mode === "subscription" &&
		!settings.nodes.some((entry) => entry.tag === node)
	) {
		return { error: t("节点不存在") };
	}
	if (proxyId === undefined) delete project.proxyId;
	else project.proxyId = proxyId;
	if (node && settings?.mode === "subscription") project.proxyNode = node;
	else delete project.proxyNode;
	writeProjects(agentDir, file);
	return { project };
}

/** Apply first, then persist the choice; rejected changes do not replace it. */
export function changeProjectProxy(
	agentDir: string,
	id: string,
	proxyId: string | null | undefined,
	proxyNode?: string,
): Promise<{ project?: SentinelProject; error?: string; applied?: boolean }> {
	return withGatewayLock(`${agentDir}:${id}`, async () => {
		const project = readProjects(agentDir).projects.find((entry) => entry.id === id);
		if (!project) return { error: t("项目不存在") };
		const next = { ...project, proxyId, proxyNode };
		const settings = projectProxySettings(agentDir, next);
		if (proxyId && !resolveProjectProxy(agentDir, proxyId)) return { error: t("代理不存在") };
		if (
			proxyNode &&
			proxyNode !== AUTO_NODE_TAG &&
			settings?.mode === "subscription" &&
			!settings.nodes.some((node) => node.tag === proxyNode)
		)
			return { error: t("节点不存在") };
		if (project.gateway && !project.manualStop) {
			const ready = await ensureGateway(agentDir, next, settings);
			if (!ready.ok) return { error: ready.error };
		}
		return {
			...setProjectProxy(agentDir, id, proxyId, proxyNode),
			applied: Boolean(project.gateway && !project.manualStop),
		};
	});
}

/** Profile refreshes and default changes reach each running persistent gateway. */
export async function refreshProjectGateways(agentDir: string): Promise<string[]> {
	const errors: string[] = [];
	for (const project of readProjects(agentDir).projects) {
		if (!project.gateway || project.manualStop) continue;
		const result = await withGatewayLock(`${agentDir}:${project.id}`, async () => {
			const current = readProjects(agentDir).projects.find((entry) => entry.id === project.id);
			if (!current?.gateway || current.manualStop) return { ok: true };
			return ensureGateway(agentDir, current, projectProxySettings(agentDir, current));
		});
		if (!result.ok) errors.push(`${project.name}: ${result.error}`);
	}
	return errors;
}

/**
 * Drop a deleted profile from every project that pointed at it.
 *
 * The projects fall back to following the default: the node is gone, but the
 * project's intent ("use a proxy") is not the thing that changed.
 */
export function clearProxyFromProjects(agentDir: string, proxyId: string): void {
	const file = readProjects(agentDir);
	let touched = false;
	for (const project of file.projects) {
		if (project.proxyId !== proxyId) continue;
		delete project.proxyId;
		delete project.proxyNode;
		touched = true;
	}
	if (touched) writeProjects(agentDir, file);
}

export function setLastActiveProject(agentDir: string, id: string | undefined): void {
	const file = readProjects(agentDir);
	file.lastActiveProjectId = id;
	writeProjects(agentDir, file);
}

/** Resolve the startup project; returns nothing when it is gone or none was set. */
export async function resolveStartupProject(agentDir: string): Promise<{ project?: SentinelProject }> {
	const file = readProjects(agentDir);
	const last = file.projects.find((project) => project.id === file.lastActiveProjectId);
	// Going through the readiness check keeps a deliberately stopped project
	// stopped: starting it is the operator's click, not a side effect of a restart.
	if (last && (await ensureProjectReady(last, agentDir))) return { project: last };
	return {};
}

/** The project's container state as the operator should see it. */
export type ProjectContainerState = "running" | "stopped" | "missing";

/** What a delete request covers: just the container, or everything the project owns. */
export type ProjectRemoveScope = "container" | "data";

/**
 * Verify a project's container is usable, starting it when it is merely stopped
 * and creating it when it is gone.
 *
 * A project the operator stopped by hand is never started here: it needs an
 * explicit 「启动容器」, or the stop would be undone by the next click.
 */
export async function ensureProjectReady(project: SentinelProject, agentDir: string): Promise<boolean> {
	return withGatewayLock(`${agentDir}:${project.id}`, async () => {
		const current = readProjects(agentDir).projects.find((entry) => entry.id === project.id) ?? project;
		if (current.manualStop) return false;
		return (await bringProjectUp(agentDir, current)).ok;
	});
}

/**
 * Stop a project's container and remember that it was intentional.
 *
 * The container is kept: it can be started again with its installed packages
 * intact, which is what separates this from removing or rebuilding it. The
 * sidecar is stopped after it — stopping the sidecar first would leave the
 * container on a namespace nothing is routing.
 */
export async function stopProject(
	agentDir: string,
	id: string,
): Promise<{ project?: SentinelProject; error?: string }> {
	return withGatewayLock(`${agentDir}:${id}`, () => stopProjectUnlocked(agentDir, id));
}

async function stopProjectUnlocked(
	agentDir: string,
	id: string,
): Promise<{ project?: SentinelProject; error?: string }> {
	const file = readProjects(agentDir);
	const project = file.projects.find((entry) => entry.id === id);
	if (!project) return { error: t("项目不存在") };
	const stopped = await stopContainer(project.container);
	if (!stopped.ok && stopped.error) return { error: t("容器停止失败：{error}", { error: stopped.error }) };
	// Only a project that is proxied has a sidecar to stop, and the check is the
	// settings rather than Docker: an inspect on every stop of every project would
	// cost more than the edge it covers (a proxy switched off but not yet applied
	// by a rebuild, whose sidecar is left for that rebuild or for deletion).
	if (project.gateway || proxyEnabled(projectProxySettings(agentDir, project))) {
		await stopSingboxContainer(projectSidecarName(project));
	}
	project.manualStop = true;
	writeProjects(agentDir, file);
	return { project };
}

/** Start a project's container again, creating it when it no longer exists. */
export async function startProject(
	agentDir: string,
	id: string,
): Promise<{ project?: SentinelProject; created?: boolean; error?: string }> {
	return withGatewayLock(`${agentDir}:${id}`, () => startProjectUnlocked(agentDir, id));
}

async function startProjectUnlocked(
	agentDir: string,
	id: string,
): Promise<{ project?: SentinelProject; created?: boolean; error?: string }> {
	const file = readProjects(agentDir);
	const project = file.projects.find((entry) => entry.id === id);
	if (!project) return { error: t("项目不存在") };
	const ready = await bringProjectUp(agentDir, project);
	if (!ready.ok) return { error: t("容器启动失败：{error}", { error: ready.error ?? "" }) };
	delete project.manualStop;
	writeProjects(agentDir, file);
	return { project, created: ready.created };
}
