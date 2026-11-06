import {
	ArrowRightOutlined,
	AuditOutlined,
	BugOutlined,
	BuildOutlined,
	ContainerOutlined,
	MessageOutlined,
	ThunderboltOutlined,
} from "@ant-design/icons";
import { Badge, Button, Card, Empty, Skeleton, Tag, Typography } from "antd";
import { getLanguage, t } from "../i18n.ts";
import type {
	SentinelEngine,
	SentinelPageId,
	SentinelProjectInfo,
	SentinelVulnStats,
	SessionInfoView,
} from "../types.ts";
import { SENTINEL_VULN_SEVERITIES, SENTINEL_VULN_SEVERITY_LABELS } from "../types.ts";
import "./dashboard.css";

const { Text } = Typography;
const tx = (zh: string, en: string) => (getLanguage() === "en" ? en : zh);

export interface DashboardPageProps {
	project: SentinelProjectInfo | null;
	sessions: SessionInfoView[];
	runningSessions: string[];
	engines: SentinelEngine[];
	pendingApprovals: number;
	vulnStats: SentinelVulnStats;
	loading: boolean;
	onNavigate: (page: SentinelPageId) => void;
	onOpenSession: (path: string) => void;
}

export function DashboardPage({
	project,
	sessions,
	runningSessions,
	engines,
	pendingApprovals,
	vulnStats,
	loading,
	onNavigate,
	onOpenSession,
}: DashboardPageProps) {
	const projectEngines = engines.filter((engine) => engine.projectId === project?.id);
	const runningTasks = projectEngines.flatMap((engine) => engine.tasks.filter((task) => task.status === "running"));
	const projectSessionIds = new Set(sessions.map((session) => session.id));
	const runningIds = new Set([
		...runningSessions.filter((id) => projectSessionIds.has(id)),
		...runningTasks.flatMap((task) => (task.sessionId ? [task.sessionId] : [])),
	]);
	const runningCount = runningIds.size + runningTasks.filter((task) => !task.sessionId).length;
	const recent = [...sessions].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified)).slice(0, 6);
	const active = sessions.filter((session) => runningIds.has(session.id));
	const projectRunning = project?.state === "running";
	const summary = !project
		? tx("选择或创建项目，开始管理测试任务与证据。", "Select or create a project to manage testing tasks and evidence.")
		: !projectRunning
			? tx(
					"项目容器尚未运行，前往项目页启动后继续测试。",
					"Start the project container on the Projects page to continue testing.",
				)
			: pendingApprovals > 0
				? tx(
						"有命令正在等待审批，进入对话查看并处理。",
						"Commands are waiting for approval. Open conversations to review them.",
					)
				: runningCount > 0
					? tx(
							"测试任务正在运行，可继续查看进展与收集的证据。",
							"Testing is in progress. Follow the active tasks and collected evidence.",
						)
					: tx(
							"从一条测试指令开始，或继续最近的会话。",
							"Start with a testing instruction, or continue a recent conversation.",
						);
	const metrics = [
		{
			key: "running",
			label: tx("运行中任务", "Running tasks"),
			value: runningCount,
			icon: <ThunderboltOutlined />,
			hint: tx("对话与工程任务", "Conversations and engine tasks"),
			page: runningTasks.length > 0 ? ("engine" as const) : ("chat" as const),
		},
		{
			key: "approvals",
			label: tx("待审批", "Pending approvals"),
			value: pendingApprovals,
			icon: <AuditOutlined />,
			hint: tx("全部项目待处理命令", "Commands across all projects"),
			page: "chat" as const,
		},
		{
			key: "vulns",
			label: t("漏洞"),
			value: vulnStats.total,
			icon: <BugOutlined />,
			hint: tx(`待确认 ${vulnStats.byStatus.pending}`, `${vulnStats.byStatus.pending} pending review`),
			page: "vulns" as const,
		},
		{
			key: "sessions",
			label: t("会话"),
			value: sessions.length,
			icon: <MessageOutlined />,
			hint: t("当前项目"),
			page: "chat" as const,
		},
	];

	return (
		<div className="ui-page dashboard" aria-busy={loading}>
			<section className="dashboard__brief" aria-labelledby="dashboard-project-title">
				<div className="dashboard__brief-copy">
					<h1 id="dashboard-project-title" title={project?.name}>
						{project?.name ?? t("授权渗透测试工作台")}
					</h1>
					<p>{loading ? tx("正在读取项目状态…", "Loading project status…") : summary}</p>
					{project ? (
						<div className="dashboard__project-meta">
							<Badge
								status={loading ? "default" : projectRunning ? "success" : "warning"}
								text={
									loading
										? t("加载中…")
										: projectRunning
											? tx("容器运行中", "Container running")
											: tx("容器未运行", "Container stopped")
								}
							/>
							<code title={project.container || project.cwd}>{project.container || project.cwd}</code>
						</div>
					) : null}
				</div>
				<div className="dashboard__brief-actions">
					<Button
						type="primary"
						size="large"
						icon={projectRunning ? <MessageOutlined /> : <ContainerOutlined />}
						disabled={loading}
						onClick={() => onNavigate(projectRunning ? "chat" : "projects")}
					>
						{projectRunning ? tx("进入对话", "Open conversations") : tx("管理项目", "Manage projects")}
					</Button>
					<Button icon={<BuildOutlined />} disabled={loading || !project} onClick={() => onNavigate("engine")}>
						{tx("查看工程", "View engines")}
					</Button>
				</div>
			</section>
			<div className="dashboard__metrics">
				{metrics.map((metric) => (
					<button
						key={metric.key}
						type="button"
						className={`dashboard__metric${metric.key === "approvals" && pendingApprovals > 0 && !loading ? " is-attention" : ""}`}
						disabled={loading}
						onClick={() => onNavigate(metric.page)}
					>
						<span className="dashboard__metric-label">
							{metric.icon}
							{metric.label}
							<ArrowRightOutlined />
						</span>
						<strong>{loading ? "—" : metric.value}</strong>
						<Text type="secondary">{metric.hint}</Text>
					</button>
				))}
			</div>

			<div className="dashboard__columns">
				<Card
					className="dashboard__recent"
					size="small"
					title={<h2>{tx("最近会话", "Recent conversations")}</h2>}
					extra={
						<Button type="link" size="small" onClick={() => onNavigate("chat")}>
							{tx("查看全部", "View all")}
						</Button>
					}
				>
					{loading ? (
						<Skeleton active paragraph={{ rows: 4 }} />
					) : recent.length === 0 ? (
						<div className="dashboard__empty">
							<MessageOutlined className="dashboard__empty-icon" aria-hidden="true" />
							<Empty
								image={false}
								description={
									<>
										<strong>{t("暂无会话")}</strong>
										<p>
											{tx(
												"在对话中输入目标和测试范围，执行过程与证据会保存在当前项目。",
												"Enter a target and testing scope in a conversation. Execution history and evidence are saved to this project.",
											)}
										</p>
									</>
								}
							/>
							<Button disabled={loading} onClick={() => onNavigate(projectRunning ? "chat" : "projects")}>
								{projectRunning ? tx("进入对话", "Open conversations") : tx("管理项目", "Manage projects")}
							</Button>
						</div>
					) : (
						<div className="dashboard__sessions">
							{recent.map((session) => {
								const modified = new Date(session.modified);
								return (
									<button
										key={session.path}
										type="button"
										className="dashboard__session"
										onClick={() => onOpenSession(session.path)}
									>
										<span className={`dashboard__session-icon${runningIds.has(session.id) ? " is-running" : ""}`}>
											<MessageOutlined />
										</span>
										<span className="dashboard__session-copy">
											<span>{session.name || session.firstMessage.slice(0, 60) || t("未命名会话")}</span>
											<Text type="secondary">
												{session.engine?.engineName ?? t("对话")}
												{runningIds.has(session.id) ? (
													<span className="dashboard__session-running">{tx("运行中", "Running")}</span>
												) : null}
												<span className="dashboard__session-count">
													{tx(`${session.messageCount} 条消息`, `${session.messageCount} messages`)}
												</span>
											</Text>
										</span>
										<time
											className="dashboard__session-time"
											dateTime={Number.isNaN(modified.getTime()) ? undefined : modified.toISOString()}
										>
											{Number.isNaN(modified.getTime())
												? "—"
												: modified.toLocaleDateString(getLanguage() === "en" ? "en-US" : "zh-CN", {
														month: "short",
														day: "numeric",
													})}
										</time>
										<ArrowRightOutlined />
									</button>
								);
							})}
						</div>
					)}
				</Card>

				<div className="dashboard__secondary">
					<Card
						size="small"
						title={<h2>{tx("运行状态", "Runtime")}</h2>}
						extra={
							<Tag color={!loading && projectRunning ? "success" : "default"}>
								{loading ? t("加载中…") : projectRunning ? tx("容器运行中", "Running") : tx("容器未运行", "Stopped")}
							</Tag>
						}
					>
						{loading ? (
							<Skeleton active paragraph={{ rows: 2 }} />
						) : active.length > 0 ? (
							<div className="dashboard__active">
								{active.slice(0, 3).map((session) => (
									<Button key={session.path} type="text" block onClick={() => onOpenSession(session.path)}>
										<Badge status="processing" />
										<span>{session.name || session.firstMessage.slice(0, 60) || t("未命名会话")}</span>
										<ArrowRightOutlined />
									</Button>
								))}
							</div>
						) : (
							<Text type="secondary">
								{runningCount > 0
									? tx("工程任务正在运行，可前往工程查看详情。", "Engine tasks are running. Open engines for details.")
									: tx("当前没有运行中的任务。", "No tasks are running.")}
							</Text>
						)}
						<div className="dashboard__status-footer">
							<Text type="secondary">
								{t("工程")} {projectEngines.length}
							</Text>
							<Button size="small" type="link" onClick={() => onNavigate("engine")}>
								{tx("查看工程", "View engines")}
							</Button>
						</div>
					</Card>
					<Card
						size="small"
						title={<h2>{tx("漏洞分布", "Findings by severity")}</h2>}
						extra={
							<Button size="small" type="link" onClick={() => onNavigate("vulns")}>
								{tx("查看漏洞", "View findings")}
							</Button>
						}
					>
						{loading ? (
							<Skeleton active paragraph={{ rows: 4 }} />
						) : (
							<div className="dashboard__severity">
								{SENTINEL_VULN_SEVERITIES.map((severity) => (
									<div key={severity} className={`dashboard__severity-row is-${severity}`}>
										<span>{SENTINEL_VULN_SEVERITY_LABELS[severity]}</span>
										<span className="dashboard__severity-track" aria-hidden="true">
											<span
												style={{
													width: `${vulnStats.total ? (vulnStats.bySeverity[severity] / vulnStats.total) * 100 : 0}%`,
												}}
											/>
										</span>
										<strong>{vulnStats.bySeverity[severity]}</strong>
									</div>
								))}
							</div>
						)}
						{!loading && vulnStats.total === 0 ? (
							<p className="dashboard__severity-empty">
								{tx(
									"暂无漏洞记录，测试发现会在这里按等级汇总。",
									"No findings recorded yet. Testing results will appear here by severity.",
								)}
							</p>
						) : null}
					</Card>
				</div>
			</div>
		</div>
	);
}
