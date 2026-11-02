/**
 * The about page.
 *
 * Read-only summary of what this console is and what it is currently talking
 * to. Values come from the live snapshot, so it doubles as a diagnostics view
 * when something looks wrong.
 */

import { GithubOutlined, LinkOutlined } from "@ant-design/icons";
import { Alert, Button, Descriptions, Space, Statistic, Tag, Typography } from "antd";
import {
	CONSOLE_VERSION,
	PROJECT_LICENSE,
	PROJECT_LICENSE_URL,
	PROJECT_NAME,
	PROJECT_REPOSITORY,
} from "../branding.ts";
import { t } from "../i18n.ts";
import type { SentinelProjectInfo, SentinelResolvedModelView, SentinelStateSnapshot, SentinelStatsView } from "../types.ts";
import { SENTINEL_MODE_LABELS } from "../types.ts";
import { Page } from "../ui/Page.tsx";
import { SentinelMark } from "./icons.tsx";

const { Text } = Typography;

export function AboutPage({
	snapshot,
	main,
	stats,
	project,
	connected,
}: {
	snapshot: SentinelStateSnapshot | null;
	/** What the 主模型 role resolves to. */
	main: SentinelResolvedModelView | null;
	stats: SentinelStatsView | null;
	project: SentinelProjectInfo | null;
	connected: boolean;
}) {
	const cumulative = stats?.cumulative;
	const items = [
		{ key: "console", label: t("控制台"), children: t("{name} Web 控制台", { name: PROJECT_NAME }) },
		{
			key: "connection",
			label: t("连接状态"),
			children: (
				<Tag color={connected ? "green" : "red"} variant="filled">
					{connected ? t("已连接") : t("已断开")}
				</Tag>
			),
		},
		{
			key: "main",
			label: t("主模型"),
			children: main
				? t("{entry}（{model}）", { entry: main.entryName, model: main.modelId })
				: <Text type="secondary">{t("未配置")}</Text>,
		},
		{
			key: "model",
			label: t("模型"),
			children: snapshot?.model ? `${snapshot.model.provider} / ${snapshot.model.id}` : <Text type="secondary">{t("未配置")}</Text>,
		},
		{ key: "mode", label: t("执行模式"), children: snapshot ? SENTINEL_MODE_LABELS[snapshot.mode] : "—" },
		{ key: "thinking", label: t("思考等级"), children: snapshot?.thinkingLevel ?? "—" },
		{
			key: "project",
			label: t("当前项目"),
			children: project
				? t("{name}（{container}）", { name: project.name, container: project.container ?? t("无容器") })
				: <Text type="secondary">{t("未选择")}</Text>,
		},
		{ key: "cwd", label: t("工作目录"), children: <Text code>{snapshot?.cwd ?? "—"}</Text> },
		{ key: "session", label: t("当前会话"), children: snapshot?.activeSessionId ?? "—" },
	];

	return (
		<Page title={t("关于")} description={t("当前运行环境与端点")}>
			<div className="about-summary">
				<div className="about-hero">
					<span className="about-hero__mark">
						<SentinelMark size={22} />
					</span>
					<div className="about-hero__text">
						<Text strong className="about-hero__name">
							{PROJECT_NAME}
						</Text>
						<Text type="secondary" className="about-hero__version">
							v{CONSOLE_VERSION} · {PROJECT_LICENSE}
						</Text>
					</div>
					<Space size={4} className="about-hero__links">
						<Button
							type="link"
							size="small"
							icon={<GithubOutlined />}
							href={PROJECT_REPOSITORY}
							target="_blank"
							rel="noreferrer"
						>
							GitHub
						</Button>
						<Button
							type="link"
							size="small"
							icon={<LinkOutlined />}
							href={PROJECT_LICENSE_URL}
							target="_blank"
							rel="noreferrer"
						>
							{PROJECT_LICENSE}
						</Button>
					</Space>
				</div>

				<div className="about-stats">
					<Statistic title={t("Token 输入")} value={cumulative?.tokens.input ?? "—"} groupSeparator="," />
					<Statistic title={t("Token 输出")} value={cumulative?.tokens.output ?? "—"} groupSeparator="," />
					<Statistic title={t("Token 合计")} value={cumulative?.tokens.total ?? "—"} groupSeparator="," />
					<Statistic title={t("累计花费")} value={cumulative?.cost ?? "—"} precision={4} prefix="$" />
				</div>
			</div>

			<Descriptions bordered size="small" column={2} items={items} className="about-descriptions" />

			<Alert
				type="warning"
				showIcon
				className="ui-page__alert"
				title={t("所有命令都在项目容器内以 root 执行")}
				description={t(
					"bash 命令在审批模式下逐条确认。工具输出与文件面板内容来自容器，请仅在已授权的目标上使用。",
				)}
			/>
		</Page>
	);
}
