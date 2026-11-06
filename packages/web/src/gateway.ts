/** Persistent project gateway. Only clients change; its namespace stays alive. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDocker, SENTINEL_IMAGE } from "./docker.ts";
import { GATEWAY_RUNTIME } from "./gateway-runtime.ts";
import { t } from "./i18n.ts";
import { freePort } from "./node-test.ts";
import { buildOpenVpnProfile, openVpnHookScript } from "./openvpn.ts";
import type { SentinelProxySettings } from "./protocol.ts";
import { buildSingboxConfig, parseNameservers, projectProxyConfigPath, projectResolvConfPath } from "./proxy.ts";
import { ensureProxyNetwork, proxyNetworkName, singboxContainerNameFor } from "./singbox.ts";
import { buildWireGuardConfig } from "./wireguard.ts";

export function projectGatewayDir(agentDir: string, projectId: string): string {
	return join(agentDir, "gateways", projectId);
}

const operations = new Map<string, Promise<unknown>>();

/** Serialize starts, refreshes and switches for the same project. */
export function withGatewayLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = operations.get(key) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(operation);
	operations.set(key, next);
	void next
		.finally(() => {
			if (operations.get(key) === next) operations.delete(key);
		})
		.catch(() => undefined);
	return next;
}

async function stageGateway(
	agentDir: string,
	projectId: string,
	settings: SentinelProxySettings | null,
): Promise<{ directory: string; hash: string; port: number } | { error: string }> {
	const directory = projectGatewayDir(agentDir, projectId);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const portPath = join(directory, "port");
	const secretPath = join(directory, "secret");
	if (!existsSync(portPath)) writeFileSync(portPath, String(await freePort()), { mode: 0o600 });
	if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(16).toString("hex"), { mode: 0o600 });
	const port = Number(readFileSync(portPath, "utf8"));
	const secret = readFileSync(secretPath, "utf8");
	const files: Record<string, string> = { mode: settings?.mode ?? "off", "resolv.conf": "nameserver 127.0.0.11\n" };
	let imageId = "";
	if (settings?.mode === "simple" || settings?.mode === "subscription") {
		const built = buildSingboxConfig(settings, { port, secret });
		if (!built.config) return { error: built.error ?? t("代理配置生成失败") };
		files["config.json"] = built.config;
		const image = await runDocker(["image", "inspect", "--format", "{{.Id}}", settings.image], { timeoutMs: 15000 });
		if (image.code !== 0) return { error: t("代理镜像尚未拉取") };
		imageId = image.stdout.trim() || settings.image;
		const binary = join(directory, "sing-box");
		const imageFile = join(directory, "image");
		if (!existsSync(binary) || !existsSync(imageFile) || readFileSync(imageFile, "utf8") !== imageId) {
			const donor = `sentinel-binary-${randomUUID()}`;
			const created = await runDocker(["create", "--name", donor, "--network", "none", settings.image], {
				timeoutMs: 30000,
			});
			if (created.code !== 0) return { error: t("代理程序准备失败") };
			try {
				const copied = await runDocker(["cp", `${donor}:/usr/local/bin/sing-box`, binary], { timeoutMs: 30000 });
				if (copied.code !== 0) return { error: t("代理镜像中缺少 /usr/local/bin/sing-box") };
				writeFileSync(imageFile, imageId, { mode: 0o600 });
			} finally {
				await runDocker(["rm", "-f", donor], { timeoutMs: 15000 });
			}
		}
	} else if (settings?.mode === "wireguard") {
		const built = buildWireGuardConfig(settings.wireguard);
		if (!built.config) return { error: built.error ?? t("WireGuard 配置生成失败") };
		files["wg0.conf"] = built.config;
		files["kill-switch"] = String(settings.wireguard.killSwitch);
		files["resolv.conf"] = `${parseNameservers(built.dns ?? "")
			.map((ip) => `nameserver ${ip}`)
			.join("\n")}\n`;
	} else if (settings?.mode === "openvpn") {
		const built = buildOpenVpnProfile(settings.openvpn);
		if (!built.config) return { error: built.error ?? t("OpenVPN 配置生成失败") };
		files["client.ovpn"] = built.config;
		files["hook.sh"] = openVpnHookScript(settings.openvpn.killSwitch);
		if (built.credentials !== undefined) files["auth.txt"] = built.credentials;
		files["resolv.conf"] = (built.dns ?? []).map((ip) => `nameserver ${ip}\n`).join("");
	}
	const hash = createHash("sha256")
		.update(JSON.stringify([files, imageId, GATEWAY_RUNTIME]))
		.digest("hex");
	const candidate = join(directory, "candidate");
	rmSync(candidate, { recursive: true, force: true });
	mkdirSync(candidate, { mode: 0o700 });
	for (const [name, value] of Object.entries({ ...files, hash }))
		writeFileSync(join(candidate, name), value, { mode: 0o600 });
	if (files["config.json"]) copyFileSync(join(directory, "sing-box"), join(candidate, "sing-box"));
	writeFileSync(join(directory, "runtime.sh"), GATEWAY_RUNTIME, { mode: 0o600 });
	return { directory, hash, port };
}

/** Must be called under the project lock. Never restarts an existing gateway. */
export async function ensureGateway(
	agentDir: string,
	project: { id: string; container: string },
	settings: SentinelProxySettings | null,
): Promise<{ ok: boolean; sidecar?: string; resolvConfPath?: string; error?: string }> {
	const staged = await stageGateway(agentDir, project.id, settings);
	if ("error" in staged) return { ok: false, error: staged.error };
	const sidecar = singboxContainerNameFor(project.id);
	const resolver = projectResolvConfPath(agentDir, project.id);
	if (!existsSync(resolver)) {
		mkdirSync(join(agentDir, "proxy"), { recursive: true });
		writeFileSync(resolver, "nameserver 127.0.0.11\n", { mode: 0o644 });
	}
	const state = await runDocker(["inspect", "-f", "{{.State.Running}}", sidecar], { timeoutMs: 15000 });
	if (state.code !== 0) {
		const network = await ensureProxyNetwork();
		if (!network.ok) return network;
		const created = await runDocker(
			[
				"run",
				"-d",
				"--name",
				sidecar,
				"--network",
				proxyNetworkName(),
				"--cap-add",
				"NET_ADMIN",
				"--cap-add",
				"NET_RAW",
				"--sysctl",
				"net.ipv4.conf.all.src_valid_mark=1",
				...(existsSync("/dev/net/tun") ? ["--device", "/dev/net/tun"] : []),
				"-p",
				`127.0.0.1::${staged.port}`,
				"-v",
				`${staged.directory}:/etc/sentinel-gateway:ro`,
				"-v",
				`${resolver}:/etc/resolv.conf`,
				"--entrypoint",
				"sh",
				process.env.SENTINEL_GATEWAY_IMAGE || SENTINEL_IMAGE,
				"/etc/sentinel-gateway/runtime.sh",
				"init",
			],
			{ timeoutMs: 60000 },
		);
		if (created.code !== 0) return { ok: false, error: created.stderr.trim() };
	} else if (state.stdout.trim() !== "true") {
		const started = await runDocker(["start", sidecar], { timeoutMs: 60000 });
		if (started.code !== 0) return { ok: false, error: started.stderr.trim() };
	}
	const initialized = await runDocker(
		[
			"exec",
			sidecar,
			"sh",
			"-c",
			'n=0; until [ -f /run/sentinel-gateway/ready ]; do n=$((n+1)); [ "$n" -lt 50 ] || exit 1; sleep 0.1; done',
		],
		{ timeoutMs: 10000 },
	);
	if (initialized.code !== 0) {
		// PID 1 only logs initialization and containment errors; client logs stay
		// inside the gateway so proxy configuration and credentials are not exposed.
		const logs = await runDocker(["logs", "--tail", "20", sidecar], { timeoutMs: 10000 });
		const detail = (logs.code === 0 ? `${logs.stdout}\n${logs.stderr}` : initialized.stderr).trim().slice(-2000);
		return {
			ok: false,
			error: t("网关初始化失败：{error}", {
				error: detail || t("初始化未在规定时间内完成，请检查网关容器日志与 Docker 网络权限"),
			}),
		};
	}
	const current = await runDocker(["exec", sidecar, "sh", "/etc/sentinel-gateway/runtime.sh", "status"], {
		timeoutMs: 15000,
	});
	if (current.code === 0 && current.stdout.trim() === staged.hash)
		return { ok: true, sidecar, resolvConfPath: resolver };
	// Validate before disturbing the old client or pausing any project processes.
	if (settings?.mode === "simple" || settings?.mode === "subscription") {
		const checked = await runDocker(
			[
				"exec",
				sidecar,
				"/etc/sentinel-gateway/sing-box",
				"check",
				"-c",
				"/etc/sentinel-gateway/candidate/config.json",
			],
			{ timeoutMs: 30000 },
		);
		if (checked.code !== 0) return { ok: false, error: t("代理配置未通过 sing-box 校验") };
	}
	const work = await runDocker(["inspect", "-f", "{{.State.Running}} {{.State.Paused}}", project.container]);
	const pause = work.code === 0 && work.stdout.trim() === "true false";
	if (pause) {
		const paused = await runDocker(["pause", project.container], { timeoutMs: 15000 });
		if (paused.code !== 0) return { ok: false, error: t("切换前无法暂停项目进程") };
	}
	const applied = await runDocker(
		["exec", sidecar, "timeout", "--kill-after=5", "150", "sh", "/etc/sentinel-gateway/runtime.sh", "apply"],
		{
			timeoutMs: 165000,
		},
	);
	// Killing only the Docker CLI does not stop an exec inside the container. On an
	// indeterminate result stop the gateway before resuming project processes.
	if (applied.code !== 0 && !applied.stderr.includes("rollback") && !applied.stderr.includes("blocked")) {
		const stopped = await runDocker(["stop", "--time", "5", sidecar], { timeoutMs: 30000 });
		if (stopped.code !== 0)
			return { ok: false, error: t("网关切换状态未知，项目保持暂停；请检查 Docker 后重新启动项目") };
	}
	if (pause) {
		const resumed = await runDocker(["unpause", project.container], { timeoutMs: 15000 });
		if (resumed.code !== 0) return { ok: false, error: t("项目进程恢复失败，请检查 Docker 状态") };
	}
	if (applied.code !== 0)
		return {
			ok: false,
			error: applied.stderr.includes("rollback")
				? t("代理启动失败，已恢复原出口")
				: t("代理启动失败，网关出口不可用；请修正配置后重试"),
		};
	// Existing node switching and diagnostics resolve their API from this file.
	if (settings?.mode === "simple" || settings?.mode === "subscription") {
		writeFileSync(
			projectProxyConfigPath(agentDir, project.id),
			readFileSync(join(staged.directory, "candidate", "config.json")),
			{ mode: 0o600 },
		);
	}
	return { ok: true, sidecar, resolvConfPath: resolver };
}
