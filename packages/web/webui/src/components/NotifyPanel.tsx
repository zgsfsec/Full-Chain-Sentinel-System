import { DeleteOutlined, EditOutlined, PlusOutlined, SaveOutlined, SendOutlined } from "@ant-design/icons";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import {
	Alert,
	Badge,
	Button,
	Checkbox,
	Drawer,
	Form,
	Input,
	InputNumber,
	Popconfirm,
	Select,
	Space,
	Switch,
	Tag,
	Typography,
} from "antd";
import { useEffect, useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import { SettingsBar, SettingsEmpty, SettingsNote, SettingsSection } from "../ui/Settings.tsx";
import type {
	SentinelNotifyChannel,
	SentinelNotifyConfig,
	SentinelNotifyGroup,
	SentinelNotifyKind,
	SentinelNotifyKinds,
	SentinelNotifyStatus,
	SentinelNotifyTarget,
	SentinelTestResult,
} from "../types.ts";
import "./NotifyPanel.css";

const { Text } = Typography;
const CHANNELS: Record<SentinelNotifyChannel, string> = {
	dingtalk: t("钉钉"),
	feishu: t("飞书"),
	wecom: t("企业微信"),
};
const KINDS: readonly [SentinelNotifyKind, string, string][] = [
	["runs", t("运行报告"), t("每次运行结束（含失败/中止）的汇总报告")],
	["vulns", t("高危漏洞"), t("提交或被审查抬级为 high/critical 的漏洞")],
	["codeIntel", t("开源情报"), t("监测提交被判定为安全更新时推送")],
	["goals", t("持续目标结束"), t("目标完成、阻塞、暂停或轮数用完")],
	["engines", t("工程完成"), t("工程总报告提交时")],
	["pocs", t("POC 订阅失败"), t("订阅源同步失败时（成功不推送）")],
];

function allKinds(value: boolean): SentinelNotifyKinds {
	return { runs: value, vulns: value, codeIntel: value, goals: value, engines: value, pocs: value };
}

function newTarget(): SentinelNotifyTarget {
	return {
		id: crypto.randomUUID(),
		name: "",
		channel: "dingtalk",
		enabled: true,
		webhook: "",
		secret: "",
		keyword: "",
	};
}

function groupError(group: SentinelNotifyGroup): string | null {
	if (!group.name.trim()) return t("请填写通知组名称");
	if (group.enabled && !group.targets.some((target) => target.enabled))
		return t("启用的通知组至少需要一个已启用的机器人");
	for (const target of group.targets) {
		if (!target.name.trim()) return t("请填写机器人名称");
		if (!group.enabled || !target.enabled) continue;
		if (!target.webhook.trim()) return `${target.name}：${t("请先填写 webhook 地址")}`;
		try {
			const url = new URL(target.webhook.trim());
			const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
			if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error();
		} catch {
			return `${target.name}：${t("webhook 必须是 https 地址")}`;
		}
	}
	return null;
}

/** The editor uses the same fields for each robot, including repeated platforms. */
export function NotifyGroupEditor({
	group,
	onChange,
	testing,
	results,
	onTest,
}: {
	group: SentinelNotifyGroup;
	onChange: (group: SentinelNotifyGroup) => void;
	testing: string | null;
	results: Record<string, SentinelTestResult>;
	onTest: (target: SentinelNotifyTarget) => void;
}) {
	const setTarget = (id: string, patch: Partial<SentinelNotifyTarget>) =>
		onChange({
			...group,
			targets: group.targets.map((target) => (target.id === id ? { ...target, ...patch } : target)),
		});
	return (
		<>
			<Form layout="vertical" requiredMark={false}>
				<div className="notify-groups__identity">
					<Form.Item label={t("通知组名称")} required>
						<Input
							aria-label={t("通知组名称")}
							value={group.name}
							maxLength={120}
							placeholder={t("例如：安全团队、运维团队")}
							onChange={(event) => onChange({ ...group, name: event.target.value })}
						/>
					</Form.Item>
					<Form.Item label={t("启用通知组")}>
						<Switch
							aria-label={t("启用通知组")}
							checked={group.enabled}
							onChange={(enabled) => onChange({ ...group, enabled })}
						/>
					</Form.Item>
				</div>
			</Form>
			<SettingsSection
				title={t("推送内容")}
				description={t("已选 {selected} / {total}", {
					selected: KINDS.filter(([key]) => group.kinds[key]).length,
					total: KINDS.length,
				})}
				extra={
					<Space size={4}>
						<Button size="small" onClick={() => onChange({ ...group, kinds: allKinds(true) })}>
							{t("全选")}
						</Button>
						<Button size="small" onClick={() => onChange({ ...group, kinds: allKinds(false) })}>
							{t("全部不选")}
						</Button>
					</Space>
				}
			>
				<Checkbox.Group
					className="notifyhub-kinds"
					value={KINDS.filter(([key]) => group.kinds[key]).map(([key]) => key)}
					onChange={(values) =>
						onChange({
							...group,
							kinds: Object.fromEntries(KINDS.map(([key]) => [key, values.includes(key)])) as SentinelNotifyKinds,
						})
					}
				>
					{KINDS.map(([key, name, note]) => (
						<Checkbox key={key} value={key} className="notifyhub-kind">
							<span className="notifyhub-kind__copy">
								<Text strong>{name}</Text>
								<Text type="secondary">{note}</Text>
							</span>
						</Checkbox>
					))}
				</Checkbox.Group>
				<SettingsNote>{t("自动通知按勾选类别发送；手动通知发送到所有已启用组，不受类别限制。")}</SettingsNote>
			</SettingsSection>
			<SettingsSection
				title={t("接收机器人")}
				description={t("可添加多个同类型机器人，分别填写群地址。")}
				extra={
					<Button
						size="small"
						icon={<PlusOutlined />}
						onClick={() => onChange({ ...group, targets: [...group.targets, newTarget()] })}
					>
						{t("添加机器人")}
					</Button>
				}
			>
				{group.targets.length === 0 ? (
					<SettingsEmpty title={t("还没有接收机器人")} hint={t("添加一个机器人，填写群地址并发送测试消息。")} />
				) : (
					group.targets.map((target) => (
						<section key={target.id} className="notify-groups__robot" aria-label={target.name || t("新机器人")}>
							<div className="notify-groups__robot-head">
								<Text strong>{target.name || t("新机器人")}</Text>
								<Space>
									<Switch
										checked={target.enabled}
										checkedChildren={t("启用")}
										unCheckedChildren={t("停用")}
										aria-label={t("启用机器人")}
										onChange={(enabled) => setTarget(target.id, { enabled })}
									/>
									<Popconfirm
										title={t("移除此机器人？")}
										okText={t("移除")}
										cancelText={t("取消")}
										onConfirm={() =>
											onChange({ ...group, targets: group.targets.filter((entry) => entry.id !== target.id) })
										}
									>
										<Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={t("移除机器人")} />
									</Popconfirm>
								</Space>
							</div>
							<Form layout="vertical" requiredMark={false}>
								<div className="notify-groups__fields">
									<Form.Item label={t("机器人名称")} required>
										<Input
											aria-label={t("机器人名称")}
											value={target.name}
											maxLength={120}
											placeholder={t("例如：安全团队钉钉群")}
											onChange={(event) => setTarget(target.id, { name: event.target.value })}
										/>
									</Form.Item>
									<Form.Item label={t("通知渠道")}>
										<Select
											aria-label={t("通知渠道")}
											value={target.channel}
											options={Object.entries(CHANNELS).map(([value, label]) => ({ value, label }))}
											onChange={(channel: SentinelNotifyChannel) =>
												setTarget(target.id, { channel, ...(channel === "wecom" ? { secret: "", keyword: "" } : {}) })
											}
										/>
									</Form.Item>
									<Form.Item label={t("Webhook 地址")} required className="notify-groups__wide">
										<Input.Password
											aria-label={t("Webhook 地址")}
											autoComplete="off"
											value={target.webhook}
											placeholder="https://…"
											onChange={(event) => setTarget(target.id, { webhook: event.target.value })}
										/>
									</Form.Item>
									{target.channel !== "wecom" ? (
										<>
											<Form.Item label={t("签名密钥")}>
												<Input.Password
													aria-label={t("签名密钥")}
													autoComplete="off"
													value={target.secret}
													placeholder={t("可选")}
													onChange={(event) => setTarget(target.id, { secret: event.target.value })}
												/>
											</Form.Item>
											<Form.Item label={t("关键词")}>
												<Input
													aria-label={t("关键词")}
													value={target.keyword}
													placeholder={t("可选")}
													onChange={(event) => setTarget(target.id, { keyword: event.target.value })}
												/>
											</Form.Item>
										</>
									) : null}
								</div>
							</Form>
							<div className="notify-groups__test">
								<Button
									size="small"
									icon={<SendOutlined />}
									disabled={!target.webhook.trim() || testing !== null}
									loading={testing === target.id}
									onClick={() => onTest(target)}
								>
									{t("发送测试消息")}
								</Button>
								<Text type="secondary">{t("测试使用当前填写内容，无需先保存。")}</Text>
							</div>
							{results[target.id] ? (
								<Alert
									type={results[target.id].ok ? "success" : "error"}
									showIcon
									title={results[target.id].message}
									description={results[target.id].detail}
								/>
							) : null}
						</section>
					))
				)}
			</SettingsSection>
		</>
	);
}

export function NotifyPanel({
	config,
	status,
	onSave,
	onTest,
}: {
	config: SentinelNotifyConfig;
	status: SentinelNotifyStatus;
	onSave: (config: SentinelNotifyConfig) => void;
	onTest: (target: SentinelNotifyTarget) => Promise<SentinelTestResult | null>;
}) {
	const [draft, setDraft] = useState<SentinelNotifyGroup | null>(null);
	const [limit, setLimit] = useState(config.summaryLimit);
	const [error, setError] = useState<string | null>(null);
	const [testing, setTesting] = useState<string | null>(null);
	const [results, setResults] = useState<Record<string, SentinelTestResult>>({});
	useEffect(() => setLimit(config.summaryLimit), [config.summaryLimit]);

	const edit = (group: SentinelNotifyGroup) => {
		setDraft(structuredClone(group));
		setError(null);
		setResults({});
	};
	const saveGroup = () => {
		if (!draft) return;
		const error = groupError(draft);
		if (error) {
			setError(error);
			return;
		}
		const group: SentinelNotifyGroup = {
			...draft,
			name: draft.name.trim(),
			targets: draft.targets.map((target) => ({
				...target,
				name: target.name.trim(),
				webhook: target.webhook.trim(),
				secret: target.secret.trim(),
				keyword: target.keyword.trim(),
			})),
		};
		const exists = config.groups.some((entry) => entry.id === group.id);
		onSave({
			...config,
			groups: exists
				? config.groups.map((entry) => (entry.id === group.id ? group : entry))
				: [...config.groups, group],
		});
		setDraft(null);
	};
	const testTarget = async (target: SentinelNotifyTarget) => {
		setTesting(target.id);
		try {
			const result = await onTest({
				...target,
				webhook: target.webhook.trim(),
				secret: target.secret.trim(),
				keyword: target.keyword.trim(),
			});
			setResults((prev) => ({
				...prev,
				[target.id]: result ?? { ok: false, message: t("测试超时，请检查连接后重试") },
			}));
		} catch {
			setResults((prev) => ({ ...prev, [target.id]: { ok: false, message: t("发送失败") } }));
		} finally {
			setTesting(null);
		}
	};
	const columns: ProColumns<SentinelNotifyGroup>[] = [
		{
			title: t("通知组"),
			dataIndex: "name",
			width: 180,
			ellipsis: true,
			render: (_, group) => <Text strong>{group.name}</Text>,
		},
		{
			title: t("推送内容"),
			key: "kinds",
			width: 300,
			render: (_, group) => (
				<Space size={[0, 4]} wrap>
					{KINDS.filter(([key]) => group.kinds[key]).map(([key, name]) => (
						<Tag key={key}>{name}</Tag>
					))}
					{!KINDS.some(([key]) => group.kinds[key]) ? <Text type="secondary">{t("仅手动通知")}</Text> : null}
				</Space>
			),
		},
		{
			title: t("接收机器人"),
			key: "targets",
			width: 220,
			render: (_, group) => (
				<div className="notify-groups__recipients">
					{group.targets.map((target) => (
						<Text key={target.id} type={target.enabled ? undefined : "secondary"}>
							{target.name}{" "}
							<Text type="secondary">
								({CHANNELS[target.channel]}
								{target.enabled ? "" : ` / ${t("已停用")}`})
							</Text>
						</Text>
					))}
				</div>
			),
		},
		{
			title: t("状态"),
			key: "enabled",
			width: 90,
			render: (_, group) => (
				<Switch
					checked={group.enabled}
					aria-label={t("启用通知组")}
					onChange={(enabled) => {
						const next = { ...group, enabled };
						const error = groupError(next);
						if (error) {
							edit(next);
							setError(error);
							return;
						}
						onSave({ ...config, groups: config.groups.map((entry) => (entry.id === group.id ? next : entry)) });
					}}
				/>
			),
		},
		{
			title: t("操作"),
			key: "actions",
			width: 140,
			fixed: "right",
			render: (_, group) => (
				<Space size={0}>
					<Button type="link" size="small" icon={<EditOutlined />} onClick={() => edit(group)}>
						{t("编辑")}
					</Button>
					<Popconfirm
						title={t("删除通知组？")}
						description={t("删除后，该组将不再接收通知。")}
						okText={t("删除")}
						cancelText={t("取消")}
						okButtonProps={{ danger: true }}
						onConfirm={() => onSave({ ...config, groups: config.groups.filter((entry) => entry.id !== group.id) })}
					>
						<Button type="link" size="small" danger icon={<DeleteOutlined />}>
							{t("删除")}
						</Button>
					</Popconfirm>
				</Space>
			),
		},
	];
	return (
		<>
			<SettingsBar
				title={t("通知组")}
				meta={t("{enabled} / {total} 已启用", {
					enabled: config.groups.filter((group) => group.enabled).length,
					total: config.groups.length,
				})}
				extra={
					<Button
						type="primary"
						icon={<PlusOutlined />}
						onClick={() =>
							edit({ id: crypto.randomUUID(), name: "", enabled: true, kinds: allKinds(true), targets: [newTarget()] })
						}
					>
						{t("新增通知组")}
					</Button>
				}
			/>
			<SettingsNote>
				{t("所有通知组全局生效。各组选定类别后，自动通知会发送到该组所有已启用的机器人；同一事件可发送到多个组。")}
			</SettingsNote>
			<ProTable<SentinelNotifyGroup>
				rowKey="id"
				columns={columns}
				dataSource={config.groups}
				size="small"
				search={false}
				options={false}
				pagination={config.groups.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
				tableLayout="fixed"
				scroll={{ x: 930 }}
				locale={{
					emptyText: <SettingsEmpty title={t("还没有通知组")} hint={t("新增通知组，选择事件类别并添加接收机器人。")} />,
				}}
			/>
			<SettingsSection title={t("通知正文字数上限")}>
				<div className="notify-groups__test">
					<InputNumber
						aria-label={t("通知正文字数上限")}
						min={0}
						precision={0}
						value={limit}
						onChange={(value) => setLimit(value ?? 0)}
					/>
					<Text type="secondary">{t("0 = 不截断")}</Text>
					<Button
						icon={<SaveOutlined />}
						disabled={limit === config.summaryLimit}
						onClick={() => onSave({ ...config, summaryLimit: Math.max(0, Math.floor(limit)) })}
					>
						{t("保存设置")}
					</Button>
				</div>
				<SettingsNote>{t("所有组共用正文字数上限，各平台的单条消息字节上限仍会单独限制。")}</SettingsNote>
			</SettingsSection>
			<SettingsSection
				title={t("最近一次通知")}
				description={
					status.at === null
						? undefined
						: t("发送于 {time}", {
								time: new Date(status.at).toLocaleString(getLanguage() === "zh" ? "zh-CN" : "en-US", { hour12: false }),
							})
				}
			>
				<div className="notify-groups__outcome">
					<Badge status={status.at === null ? "default" : status.ok ? "success" : "error"} />
					<Text strong>
						{status.subject || (status.at === null ? t("尚未发送过通知") : status.ok ? t("发送成功") : t("发送失败"))}
					</Text>
				</div>
				{status.deliveries?.map((entry) => (
					<div className="notify-groups__delivery" key={`${entry.groupId}/${entry.targetId}`}>
						<Badge status={entry.ok ? "success" : "error"} />
						<Text>
							{entry.groupName} / {entry.targetName}
						</Text>
						<Tag>{CHANNELS[entry.channel]}</Tag>
						<Text type={entry.ok ? "secondary" : "danger"}>{entry.ok ? t("成功") : entry.error}</Text>
					</div>
				))}
				{status.error && !status.deliveries?.length ? <Text type="danger">{status.error}</Text> : null}
			</SettingsSection>
			<Drawer
				title={draft && config.groups.some((group) => group.id === draft.id) ? t("编辑通知组") : t("新增通知组")}
				open={draft !== null}
				size="min(760px, 100vw)"
				destroyOnHidden
				onClose={() => setDraft(null)}
				footer={
					<Space>
						<Button onClick={() => setDraft(null)}>{t("取消")}</Button>
						<Button type="primary" icon={<SaveOutlined />} onClick={saveGroup}>
							{t("保存通知组")}
						</Button>
					</Space>
				}
			>
				{error ? <Alert className="ui-page__alert" type="error" showIcon title={error} /> : null}
				{draft ? (
					<NotifyGroupEditor
						group={draft}
						onChange={(group) => {
							setDraft(group);
							setError(null);
						}}
						testing={testing}
						results={results}
						onTest={testTarget}
					/>
				) : null}
			</Drawer>
		</>
	);
}
