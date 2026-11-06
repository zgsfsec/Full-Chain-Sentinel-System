/**
 * The project switcher in the header.
 *
 * A project is the console's root resource: every other page acts on the
 * active one, so the switcher has to be visible from everywhere and has to
 * state the container's state, not just its name. The menu is a list of
 * projects plus the two operations that do not belong to a row (create, manage).
 */

import { DownOutlined, PlusOutlined, SettingOutlined } from "@ant-design/icons";
import { App, Badge, Button, Dropdown, Form, Input, Modal, Typography } from "antd";
import { useState } from "react";
import { t } from "../i18n.ts";
import type { SentinelProjectInfo, SentinelProxyConfigView } from "../types.ts";
import { type ProjectProxyChoice, projectProxyId, projectProxyNode } from "../components/ProjectProxyDialog.tsx";
import { ProjectProxyFields } from "../components/ProjectProxyFields.tsx";

const { Text } = Typography;

function stateStatus(project: SentinelProjectInfo): "success" | "default" | "warning" {
	if (project.state === "running") return "success";
	if (project.state === "stopped") return "default";
	return "warning";
}

function stateLabel(project: SentinelProjectInfo): string {
	if (project.state === "running") return t("运行中");
	if (project.state === "stopped") return project.manualStop ? t("已停止（手动）") : t("已停止");
	return t("无容器");
}

export function ProjectSwitcher({
	projects,
	activeProject,
	busy,
	proxyConfig,
	onSwitch,
	onCreate,
	onManage,
}: {
	projects: SentinelProjectInfo[];
	activeProject: SentinelProjectInfo | null;
	/** A run owns the container; creating or switching stays allowed but is explained. */
	busy: boolean;
	proxyConfig: SentinelProxyConfigView;
	onSwitch: (id: string) => void;
	onCreate: (name: string, proxyId?: string | null, proxyNode?: string) => Promise<string | null>;
	onManage: () => void;
}) {
	const { message } = App.useApp();
	const [createOpen, setCreateOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const [form] = Form.useForm<{ name: string }>();
	const [createProxy, setCreateProxy] = useState<ProjectProxyChoice>({ kind: "inherit" });

	const list = Array.isArray(projects) ? projects : [];

	const submit = async () => {
		const name = form.getFieldValue("name")?.trim();
		if (!name || creating) return;
		setCreating(true);
		const error = await onCreate(name, projectProxyId(createProxy), projectProxyNode(createProxy));
		setCreating(false);
		if (error) {
			message.error(error);
			return;
		}
		form.resetFields();
		setCreateProxy({ kind: "inherit" });
		setCreateOpen(false);
	};

	return (
		<>
			<Dropdown
				trigger={["click"]}
				classNames={{ root: "project-switcher-menu" }}
				menu={{
					selectable: true,
					selectedKeys: activeProject ? [activeProject.id] : [],
					items: [
						...list.map((project) => ({
							key: project.id,
							label: (
								<span className="project-option">
									<Badge status={stateStatus(project)} />
									<span className="project-option__name">{project.name}</span>
									<Text type="secondary" className="project-option__state">
										{stateLabel(project)}
									</Text>
								</span>
							),
							onClick: () => onSwitch(project.id),
						})),
						...(list.length > 0 ? [{ type: "divider" as const }] : []),
						{
							key: "manage",
							icon: <SettingOutlined />,
							label: t("管理项目"),
							onClick: onManage,
						},
						{
							key: "create",
							icon: <PlusOutlined />,
							label: t("新建项目"),
							onClick: () => setCreateOpen(true),
						},
					],
				}}
			>
				<Button type="text" className="project-switcher">
					<span className="project-switcher__inner">
						<Badge status={activeProject ? stateStatus(activeProject) : "error"} />
						<span className="project-switcher__name">{activeProject?.name ?? t("未选择项目")}</span>
						<DownOutlined className="project-switcher__caret" />
					</span>
				</Button>
			</Dropdown>

			<Modal
				title={t("新建项目")}
				open={createOpen}
				okText={t("创建")}
				cancelText={t("取消")}
				confirmLoading={creating}
				onOk={() => void submit()}
				onCancel={() => setCreateOpen(false)}
				destroyOnHidden
			>
				<Form form={form} layout="vertical" onFinish={() => void submit()} disabled={creating}>
					<Form.Item
						name="name"
						label={t("项目名称")}
						rules={[{ required: true, message: t("请填写项目名称") }]}
						extra={t("项目名会用作容器和目录名，创建后不可修改。")}
					>
						<Input autoFocus placeholder={t("例如：客户内网")} onPressEnter={() => void submit()} />
					</Form.Item>
					<ProjectProxyFields config={proxyConfig} choice={createProxy} disabled={creating} onChange={setCreateProxy} />
					{busy ? <Text type="secondary">{t("当前有任务在运行，新项目会在后台创建。")}</Text> : null}
				</Form>
			</Modal>
		</>
	);
}
