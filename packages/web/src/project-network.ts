/** Resolve and verify the network a host-side request borrows from a project. */
import {
	ensureProjectReady,
	listProjects,
	projectProxySettings,
	projectSidecarName,
	type SentinelProject,
} from "./projects.ts";
import { projectOpenVpnConfigPath, projectProxyConfigPath, projectWireGuardConfigPath, proxyEnabled } from "./proxy.ts";
import { checkSidecar } from "./singbox.ts";

export interface ProjectNetworkOperations {
	ensureReady?: typeof ensureProjectReady;
	checkSidecar?: typeof checkSidecar;
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
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

/** null means direct access was selected; proxy preparation failures always throw. */
export function createProjectNetwork(
	agentDir: string,
	projectId: string,
	operations: ProjectNetworkOperations = {},
): (signal: AbortSignal) => Promise<SentinelProject | null> {
	let ready: Promise<void> | undefined;
	let readyKey = "";
	return async (signal) => {
		signal.throwIfAborted();
		const project = listProjects(agentDir).projects.find((entry) => entry.id === projectId);
		if (!project) throw new Error("所选项目不存在，请重新选择项目");
		const settings = projectProxySettings(agentDir, project);
		if (!proxyEnabled(settings)) return null;
		if (project.manualStop) throw new Error("项目容器已手动停止；请求使用项目代理，请先启动项目容器");
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
		await withAbort(ready, signal);
		signal.throwIfAborted();
		return project;
	};
}
