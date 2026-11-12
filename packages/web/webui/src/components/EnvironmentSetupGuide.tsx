import { CheckOutlined, PlayCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Space, Tabs, Typography } from "antd";
import { t } from "../i18n.ts";
import type { SentinelEnvItem, SentinelEnvReport } from "../types.ts";
import { SettingsSection } from "../ui/Settings.tsx";
import "./environment-setup.css";

const STEP_IDS = [
	["docker-cli", "docker-daemon"],
	["image-present"],
	["proxy-image"],
	["container-run", "gateway-runtime"],
];
const STEP_TITLES = ["准备 Docker", "构建工具镜像", "拉取网络与代理镜像", "验证容器与网关", "检查本机目录"];

/** Only successful checks prove readiness; skipped checks still need a recheck. */
export function environmentSetup(report: SentinelEnvReport, proxyReady = report.proxies.imagePresent) {
	const steps = STEP_TITLES.map((title, index) => {
		const items = report.items.filter((item) =>
			index < STEP_IDS.length ? STEP_IDS[index].includes(item.id) : item.blocking && !STEP_IDS.flat().includes(item.id),
		);
		const complete =
			index === 0
				? items.some((item) => item.id === "docker-daemon" && item.status === "ok") &&
					items.every((item) => item.status === "ok")
				: index === 2
					? proxyReady
					: index < STEP_IDS.length
						? STEP_IDS[index].every((id) => items.some((item) => item.id === id && item.status === "ok"))
						: items.every((item) => item.status === "ok");
		return { title, items, complete };
	});
	const current = steps.findIndex((step) => !step.complete);
	return { steps, current: current === -1 ? steps.length - 1 : current, dockerReady: steps[0].complete };
}

export function EnvironmentBuildButton({
	disabled,
	primary = false,
	onBuild,
}: {
	disabled: boolean;
	primary?: boolean;
	onBuild: () => void;
}) {
	return (
		<Button
			disabled={disabled}
			type={primary ? "primary" : "default"}
			icon={<PlayCircleOutlined aria-hidden="true" />}
			onClick={onBuild}
		>
			{t("构建镜像")}
		</Button>
	);
}

function CheckDetails({ items }: { items: SentinelEnvItem[] }) {
	return (
		<details className="envsetup-details">
			<summary>{t("查看本步骤检测详情")}</summary>
			{items.map((item) => (
				<div key={item.id}>
					<strong>{item.label}</strong>
					<pre>{item.detail}</pre>
					{item.hint ? <p>{item.hint}</p> : null}
				</div>
			))}
		</details>
	);
}

export function EnvironmentSetupGuide({
	report,
	building,
	checking,
	onBuild,
	onRefresh,
	onShowSources,
	onShowChecks,
	onShowBuildLog,
	proxyReady,
	pulling,
	onShowNetwork,
}: {
	report: SentinelEnvReport;
	building: boolean;
	checking: boolean;
	onBuild: () => void;
	onRefresh: () => void;
	onShowSources: () => void;
	onShowChecks: () => void;
	onShowBuildLog: () => void;
	proxyReady: boolean;
	pulling: boolean;
	onShowNetwork: () => void;
}) {
	const { steps, current, dockerReady } = environmentSetup(report, proxyReady);
	const allComplete = steps.every((step) => step.complete) && !building && !pulling;
	const active = building ? 1 : pulling ? 2 : current;
	const issues = steps[active].items.filter((item) => item.status !== "ok");
	const awaitingChecks = !building && active !== 2 && issues.length === 0 && !allComplete;
	const cliMissing = issues.some((item) => item.id === "docker-cli");
	const permissionDenied = issues.some((item) => /permission denied/i.test(item.detail));
	const gatewayFailed = issues.some((item) => item.id === "gateway-runtime");

	return (
		<SettingsSection
			className="settings-panel envsetup"
			title={t("环境准备引导")}
			description={t("Docker 就绪后，先构建工具镜像，再拉取网络与代理镜像，最后复检。")}
		>
			<ol className="envsetup-steps" aria-label={t("环境准备步骤")}>
				{steps.map((step, index) => {
					if (index === 0) return null;
					const complete = step.complete && !(building && index >= 1) && !(pulling && index >= 2);
					const state = complete ? "complete" : index === active ? "active" : "waiting";
					return (
						<li
							key={step.title}
							className={`envsetup-step is-${state}`}
							aria-current={index === active && !allComplete ? "step" : undefined}
						>
							<span className="envsetup-step__number" aria-hidden="true">
								{complete ? <CheckOutlined /> : index}
							</span>
							<div>
								<strong>{t(step.title)}</strong>
								<span>
									{t(
										complete
											? "已通过"
											: index === active
												? building
													? "构建中"
													: pulling
														? "拉取中…"
														: "当前步骤"
												: "等待前置步骤",
									)}
								</span>
							</div>
						</li>
					);
				})}
			</ol>
			<div className="envsetup-task" aria-live="polite">
				<h3>
					{t(
						allComplete
							? "环境准备完成"
							: building
								? "正在构建工具镜像"
								: awaitingChecks
									? "完成本步骤环境检查"
									: [
											cliMissing ? "先在服务端安装 Docker" : "让 Docker 服务正常运行",
											"创建工具运行所需的镜像",
											"拉取容器网络与代理所需的镜像",
											gatewayFailed ? "修复网关运行环境" : "确认工具容器能够启动",
											"修复本机目录与其他阻断项",
										][active],
					)}
				</h3>
				{allComplete ? (
					<p>{t("工具镜像和网络与代理镜像已就绪，可开始使用；需要更新时可重新构建或拉取。")}</p>
				) : awaitingChecks ? (
					<p>{t("检测结果尚不完整，请点击「复检环境」，验证当前步骤后继续。")}</p>
				) : active === 0 ? (
					<>
						<p>{t("请在运行全链哨兵服务的机器上操作；远程访问时，请联系该机器的管理员。")}</p>
						<Tabs
							items={[
								{
									key: "mac",
									label: "macOS",
									children: (
										<p>
											{t("安装并打开 Docker Desktop，等待引擎启动完成。")}{" "}
											<a
												href="https://docs.docker.com/desktop/setup/install/mac-install/"
												target="_blank"
												rel="noreferrer"
											>
												{t("macOS 安装说明")}
											</a>
										</p>
									),
								},
								{
									key: "windows",
									label: "Windows",
									children: (
										<p>
											{t("按官方说明启用 WSL 2，安装并启动 Docker Desktop，使用 Linux 容器。")}{" "}
											<a
												href="https://docs.docker.com/desktop/setup/install/windows-install/"
												target="_blank"
												rel="noreferrer"
											>
												{t("Windows 安装说明")}
											</a>
										</p>
									),
								},
								{
									key: "linux",
									label: "Linux",
									children: (
										<>
											<p>
												<a href="https://docs.docker.com/engine/install/" target="_blank" rel="noreferrer">
													{t("按发行版安装 Docker Engine")}
												</a>
												{t("。使用 systemd 的机器可运行以下命令启动服务：")}
											</p>
											<Typography.Paragraph className="envsetup-command" copyable code>
												sudo systemctl start docker
											</Typography.Paragraph>
										</>
									),
								},
							]}
						/>
						{permissionDenied ? (
							<p>
								{t(
									"检测到权限不足：请让管理员为运行全链哨兵的系统用户配置 Docker 访问权限；Linux 使用 docker 组时，重新登录并重启全链哨兵服务后生效。",
								)}
							</p>
						) : null}
						<p>
							{t(
								"在同一台机器上，以运行全链哨兵的用户执行以下命令；能看到 Server 信息后，点击「复检环境」。安装后仍找不到 docker 时，请检查服务进程的 PATH 并重启全链哨兵。",
							)}
						</p>
						<Typography.Paragraph className="envsetup-command" copyable code>
							docker info
						</Typography.Paragraph>
					</>
				) : active === 1 ? (
					<>
						<p>
							{t(
								building
									? "构建可能需要 5–15 分钟。输出会持续更新，请等待构建结束，系统随后会重新检查环境。"
									: "点击「构建镜像」，先选择是否使用国内源，再确认配置并构建 sentinel:latest。首次约 5–15 分钟。",
							)}
						</p>
						<p>
							{t(
								"下载缓慢或失败时，先打开「构建源」，选择可达的镜像源并保存，再重新构建。离线环境可在其他机器构建镜像后，用 docker load 导入，再复检。",
							)}
						</p>
					</>
				) : active === 2 ? (
					<p>
						{t(
							pulling
								? "镜像拉取中，实时进度与错误显示在「容器网络与代理」的拉取日志中。"
								: "工具镜像已就绪。进入「容器网络与代理」，确认 sing-box 镜像地址后拉取；下载失败可更换可达的镜像地址后重试。",
						)}
					</p>
				) : active === 3 ? (
					<>
						<p>
							{t(
								gatewayFailed
									? "工具镜像已就绪，但网关尚未通过验证。先展开本步骤检测详情，按实际错误处理："
									: "Docker 和工具镜像已就绪，但一次性容器未通过启动检查。先检查 Docker 的可用内存、磁盘空间与镜像架构；镜像损坏时可重新构建。",
							)}
						</p>
						{gatewayFailed ? (
							<ul className="envsetup-instructions">
								<li>
									{t(
										"缺少 ip、iptables 或 curl：使用内置 Dockerfile 重新构建镜像；自定义网关镜像需包含 iproute2、iptables 和 curl。",
									)}
								</li>
								<li>
									{t(
										"出现 Operation not permitted 或 TUN 错误：请管理员检查 Docker 的 NET_ADMIN、NET_RAW 权限及 TUN 设备支持。",
									)}
								</li>
								<li>
									{t(
										"设置了 SENTINEL_GATEWAY_IMAGE 时，请修复该镜像；重建工具镜像不会更新自定义网关镜像。IPv6 已禁用时，IPv4 验证通过即可。",
									)}
								</li>
							</ul>
						) : null}
					</>
				) : (
					<p>
						{t(
							"展开本步骤检测详情，确认不可写的目录。请管理员为运行全链哨兵的用户配置读写权限；也可通过 SENTINEL_PROJECTS_DIR（项目目录）或 SENTINEL_CODING_AGENT_DIR（配置目录）指定可写目录，重启服务后再复检。其他阻断项请按检测建议处理。",
						)}
					</p>
				)}
				<Space wrap size={8} className="envsetup-actions">
					{building ? (
						<Button onClick={onShowBuildLog}>{t("查看构建输出")}</Button>
					) : active === 1 ? (
						<EnvironmentBuildButton disabled={!dockerReady || checking || pulling} primary onBuild={onBuild} />
					) : null}
					{active === 1 ? (
						<Button disabled={building} onClick={onShowSources}>
							{t("配置构建源")}
						</Button>
					) : null}
					{active === 2 ? (
						<Button type="primary" onClick={onShowNetwork}>
							{t(pulling ? "查看拉取日志" : "配置并拉取代理镜像")}
						</Button>
					) : null}
					<Button
						type={active === 1 ? "default" : "primary"}
						icon={<ReloadOutlined aria-hidden="true" />}
						loading={checking}
						disabled={building}
						onClick={onRefresh}
					>
						{t(checking ? "正在检查…" : "复检环境")}
					</Button>
					<Button onClick={onShowChecks}>{t("查看全部检查项")}</Button>
				</Space>
				{issues.length > 0 && !building ? <CheckDetails items={issues} /> : null}
			</div>
		</SettingsSection>
	);
}
