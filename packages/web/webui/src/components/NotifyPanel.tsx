import {
	BellOutlined,
	CheckCircleOutlined,
	LinkOutlined,
	LockOutlined,
	SaveOutlined,
	SendOutlined,
	TagOutlined,
	WarningOutlined,
} from "@ant-design/icons";
import {
	Alert,
	Avatar,
	Badge,
	Button,
	Checkbox,
	Col,
	Form,
	Input,
	InputNumber,
	Row,
	Space,
	Switch,
	Tag,
	Typography,
} from "antd";
import { useMemo, useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import { SettingsBar, SettingsNote, SettingsSection } from "../ui/Settings.tsx";
import type {
	SentinelNotifyChannel,
	SentinelNotifyChannelConfig,
	SentinelNotifyConfig,
	SentinelNotifyStatus,
	SentinelTestResult,
} from "../types.ts";

const { Text } = Typography;

function formatWhen(at: number | null): string {
	if (at === null) return t("尚未发送过通知");
	return new Date(at).toLocaleString(getLanguage() === "zh" ? "zh-CN" : "en-US", { hour12: false });
}

type NotifyKind = keyof SentinelNotifyConfig["kinds"];

/** The notification kinds, in the order the checkboxes list them. */
const KINDS = [
	["runs", t("运行报告"), t("每次运行结束（含失败/中止）的汇总报告")],
	["vulns", t("高危漏洞"), t("提交或被审查抬级为 high/critical 的漏洞")],
	["goals", t("持续目标结束"), t("目标完成、阻塞、暂停或轮数用完")],
	["engines", t("工程完成"), t("工程总报告提交时")],
	["pocs", t("POC 订阅失败"), t("订阅源同步失败时（成功不推送）")],
] as const;

/** Every kind at the same value, for the 全选 / 全部不选 buttons. */
function selectAll(value: boolean): SentinelNotifyConfig["kinds"] {
	return { runs: value, vulns: value, goals: value, engines: value, pocs: value };
}

/** The glyph that sits beside one notification kind. */
function kindIcon(kind: NotifyKind) {
	switch (kind) {
		case "runs":
			return <BellOutlined />;
		case "vulns":
			return <WarningOutlined />;
		case "goals":
			return <CheckCircleOutlined />;
		case "engines":
			return <TagOutlined />;
		case "pocs":
			return <LinkOutlined />;
	}
}

/** The brand initial in a channel card's top-left square. */
function channelMark(channel: SentinelNotifyChannel): string {
	return channel === "dingtalk" ? t("钉") : channel === "wecom" ? t("企") : t("飞");
}

/**
 * One robot's card: its switch, connection fields, and test action.
 *
 * The card owns no state; both channels are edited through the panel so they
 * can be saved as one configuration.
 */
function ChannelCard({
	channel,
	title,
	subtitle,
	config,
	placeholder,
	keywordPlaceholder,
	simple,
	busy,
	testing,
	result,
	onChange,
	onTest,
}: {
	channel: SentinelNotifyChannel;
	title: string;
	subtitle: string;
	config: SentinelNotifyChannelConfig;
	placeholder: string;
	keywordPlaceholder: string;
	/** WeCom has no signing or keyword mode; hide those fields. */
	simple?: boolean;
	/** Any channel is testing; this one may be disabled while another runs. */
	busy: boolean;
	/** This channel is the one sending. */
	testing: boolean;
	result: SentinelTestResult | null;
	onChange: (patch: Partial<SentinelNotifyChannelConfig>) => void;
	onTest: () => void;
}) {
	return (
		<div className={`settings-tile notifyhub-card notifyhub-card--${channel}`}>
			<div className="settings-tile__head">
				<Space size={8}>
					<Avatar shape="square" size={28} className="notifyhub-mark">
						{channelMark(channel)}
					</Avatar>
					<span className="notifyhub-title">
						<Text strong>{title}</Text>
						<Text type="secondary">{subtitle}</Text>
					</span>
				</Space>
				<Switch
					checked={config.enabled}
					aria-label={config.enabled ? t("关闭{title}通知", { title }) : t("启用{title}通知", { title })}
					onChange={(checked) => onChange({ enabled: checked })}
				/>
			</div>
			<Space size={8} wrap className="notifyhub-meta">
				<Tag color={config.enabled ? "green" : "default"} variant="filled">
					{config.enabled ? t("已启用") : t("已关闭")}
				</Tag>
				<Text type="secondary">
					{!config.enabled
						? t("开启后才会自动推送")
						: config.webhook.trim()
							? t("允许自动推送和测试")
							: t("已启用，但 webhook 为空")}
				</Text>
			</Space>

			<Form layout="vertical" requiredMark={false} className="notifyhub-form">
				<Form.Item
					label={
						<Space size={6}>
							{t("Webhook 地址")}
							<Text type="danger">{t("必填")}</Text>
						</Space>
					}
				>
					<Input
						prefix={<LinkOutlined />}
						value={config.webhook}
						onChange={(event) => onChange({ webhook: event.target.value })}
						placeholder={placeholder}
						spellCheck={false}
					/>
				</Form.Item>
				{simple ? null : (
					<Row gutter={8}>
						<Col span={12}>
							<Form.Item label={t("签名密钥")}>
								<Input.Password
									prefix={<LockOutlined />}
									value={config.secret}
									onChange={(event) => onChange({ secret: event.target.value })}
									placeholder={channel === "feishu" ? t("飞书加签密钥") : "SEC…"}
									spellCheck={false}
								/>
							</Form.Item>
						</Col>
						<Col span={12}>
							<Form.Item label={t("关键词")}>
								<Input
									prefix={<TagOutlined />}
									value={config.keyword}
									onChange={(event) => onChange({ keyword: event.target.value })}
									placeholder={keywordPlaceholder}
									spellCheck={false}
								/>
							</Form.Item>
						</Col>
					</Row>
				)}
			</Form>

			<div className="notifyhub-test">
				<Button
					size="small"
					icon={<SendOutlined />}
					loading={testing}
					disabled={!config.webhook.trim() || busy}
					onClick={onTest}
				>
					{t("发送测试消息")}
				</Button>
				<Text type="secondary">
					{config.webhook.trim() ? t("只发送一条测试卡片") : t("先填写 webhook")}
				</Text>
			</div>

			{result ? (
				<Alert
					type={result.ok ? "success" : "error"}
					showIcon
					className="ui-page__alert"
					title={result.message}
					description={result.detail ? <pre className="notifyhub-detail">{result.detail}</pre> : undefined}
				/>
			) : null}
		</div>
	);
}

/** The "notifications" section of the settings page: DingTalk, Feishu and WeCom robots. */
export function NotifyPanel({
	config,
	status,
	onSave,
	onTest,
}: {
	config: SentinelNotifyConfig;
	status: SentinelNotifyStatus;
	onSave: (config: SentinelNotifyConfig) => void;
	onTest: (
		config: SentinelNotifyConfig,
		channel: SentinelNotifyChannel,
	) => Promise<SentinelTestResult | null>;
}) {
	const [dingtalk, setDingtalk] = useState<SentinelNotifyChannelConfig>({
		enabled: config.enabled,
		webhook: config.webhook,
		secret: config.secret,
		keyword: config.keyword,
	});
	const [feishu, setFeishu] = useState<SentinelNotifyChannelConfig>(config.feishu);
	const [wecom, setWecom] = useState<SentinelNotifyChannelConfig>(config.wecom);
	const [kinds, setKinds] = useState(config.kinds);
	const [summaryLimit, setSummaryLimit] = useState(config.summaryLimit);
	const [testing, setTesting] = useState<SentinelNotifyChannel | null>(null);
	const [result, setResult] = useState<{ channel: SentinelNotifyChannel; result: SentinelTestResult } | null>(null);

	const draft = useMemo(
		() => ({
			...dingtalk,
			webhook: dingtalk.webhook.trim(),
			secret: dingtalk.secret.trim(),
			keyword: dingtalk.keyword.trim(),
			feishu: {
				...feishu,
				webhook: feishu.webhook.trim(),
				secret: feishu.secret.trim(),
				keyword: feishu.keyword.trim(),
			},
			wecom: {
				...wecom,
				webhook: wecom.webhook.trim(),
				secret: "",
				keyword: "",
			},
			kinds,
			summaryLimit: Math.max(0, Math.floor(Number(summaryLimit) || 0)),
		}),
		[dingtalk, feishu, wecom, kinds, summaryLimit],
	);

	const runTest = async (channel: SentinelNotifyChannel) => {
		setTesting(channel);
		setResult(null);
		try {
			const test = await onTest(draft, channel);
			if (test) setResult({ channel, result: test });
		} finally {
			setTesting(null);
		}
	};

	const enabledChannels = Number(dingtalk.enabled) + Number(feishu.enabled) + Number(wecom.enabled);
	const selectedKinds = KINDS.filter(([key]) => kinds[key]).length;
	const channelStatuses = (["dingtalk", "feishu", "wecom"] as const).flatMap((channel) => {
		const entry = status.channels?.[channel];
		return entry ? [{ channel, ...entry }] : [];
	});

	return (
		<>
			<SettingsBar
				title={t("通知渠道")}
				meta={<Tag variant="filled">{t("{enabled} / {total} 已启用", { enabled: enabledChannels, total: 3 })}</Tag>}
				extra={
					<>
						<Text type="secondary">{t("保存后立即生效")}</Text>
						<Button type="primary" icon={<SaveOutlined />} onClick={() => onSave(draft)}>
							{t("保存设置")}
						</Button>
					</>
				}
			/>
			<SettingsNote>
				{t("任务结束后把结果推送到团队群。钉钉、飞书和企业微信可同时启用；在群的机器人设置里添加自定义机器人并填入 webhook。钉钉/飞书的加签与关键词按机器人安全设置选填。")}
			</SettingsNote>

			<Row gutter={[16, 16]}>
				<Col xs={24} xl={8}>
					<ChannelCard
						channel="dingtalk"
						title={t("钉钉")}
						subtitle={t("自定义机器人 · Markdown")}
						config={dingtalk}
						placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
						keywordPlaceholder="Full Chain Sentinel"
						busy={testing !== null}
						testing={testing === "dingtalk"}
						result={result?.channel === "dingtalk" ? result.result : null}
						onChange={(patch) => setDingtalk((prev) => ({ ...prev, ...patch }))}
						onTest={() => void runTest("dingtalk")}
					/>
				</Col>
				<Col xs={24} xl={8}>
					<ChannelCard
						channel="feishu"
						title={t("飞书")}
						subtitle={t("自定义机器人 · interactive 卡片")}
						config={feishu}
						placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
						keywordPlaceholder="zgagent"
						busy={testing !== null}
						testing={testing === "feishu"}
						result={result?.channel === "feishu" ? result.result : null}
						onChange={(patch) => setFeishu((prev) => ({ ...prev, ...patch }))}
						onTest={() => void runTest("feishu")}
					/>
				</Col>
				<Col xs={24} xl={8}>
					<ChannelCard
						channel="wecom"
						title={t("企业微信")}
						subtitle={t("群机器人 · Markdown")}
						config={wecom}
						placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
						keywordPlaceholder=""
						simple
						busy={testing !== null}
						testing={testing === "wecom"}
						result={result?.channel === "wecom" ? result.result : null}
						onChange={(patch) => setWecom((prev) => ({ ...prev, ...patch }))}
						onTest={() => void runTest("wecom")}
					/>
				</Col>
			</Row>

			<SettingsSection
				title={t("推送内容")}
				description={t("已选 {selected} / {total}", { selected: selectedKinds, total: KINDS.length })}
				extra={
					<Space size={6}>
						<Button size="small" onClick={() => setKinds((prev) => ({ ...prev, ...selectAll(true) }))}>
							{t("全选")}
						</Button>
						<Button size="small" onClick={() => setKinds((prev) => ({ ...prev, ...selectAll(false) }))}>
							{t("全部不选")}
						</Button>
					</Space>
				}
			>
				<SettingsNote>{t("勾选的事件会同时发送到所有已启用渠道。")}</SettingsNote>
				<Checkbox.Group
					className="notifyhub-kinds"
					value={KINDS.filter(([key]) => kinds[key]).map(([key]) => key)}
					onChange={(values) =>
						setKinds(
							Object.fromEntries(KINDS.map(([key]) => [key, values.includes(key)])) as SentinelNotifyConfig["kinds"],
						)
					}
				>
					{KINDS.map(([key, name, note]) => (
						<Checkbox key={key} value={key} className="notifyhub-kind">
							<span className="notifyhub-kind__icon">{kindIcon(key)}</span>
							<span className="notifyhub-kind__copy">
								<Text strong>{name}</Text>
								<Text type="secondary">{note}</Text>
							</span>
						</Checkbox>
					))}
				</Checkbox.Group>

				<div className="notifyhub-limit">
					<Text strong>{t("通知正文字数上限")}</Text>
					<InputNumber
						min={0}
						value={summaryLimit}
						style={{ width: 140 }}
						aria-label={t("通知正文字数上限")}
						onChange={(value) => setSummaryLimit(value ?? 0)}
					/>
					<Text type="secondary">{t("0 = 不截断")}</Text>
					<Text type="secondary" className="notifyhub-limit__note">
						{t("作用于任务报告的「最后回复」、持续目标的「结论」和漏洞通知的「原始数据包」。超过钉钉 20,000 字节或飞书 30,000 字节时仍会硬截断并注明。")}
						{t("输入框旁单条强制发送不受「运行报告」勾选影响。")}
					</Text>
				</div>
			</SettingsSection>

			<SettingsSection
				title={t("最近一次通知")}
				description={
					status.at === null
						? t("启用渠道并保存后，下一轮任务结束时会在这里显示投递结果。")
						: t("发送于 {time}", { time: formatWhen(status.at) })
				}
				extra={
					channelStatuses.length > 0 ? (
						<Space size={6} wrap>
							{channelStatuses.map((entry) => (
								<Tag
									key={entry.channel}
									color={entry.ok ? "green" : "red"}
									variant="filled"
									title={entry.error ?? undefined}
								>
									{entry.channel === "dingtalk" ? t("钉钉") : entry.channel === "wecom" ? t("企业微信") : t("飞书")}
									{entry.ok ? t(" 成功") : t(" 失败")}
								</Tag>
							))}
						</Space>
					) : null
				}
			>
				<div className="notifyhub-last">
					<Space align="start" size={10}>
						<Badge status={status.at === null ? "default" : status.ok ? "success" : "error"} />
						<div className="notifyhub-last__copy">
							<Text strong>
								{status.at === null
									? t("尚未发送过通知")
									: status.ok
										? t("发送成功")
										: t("发送失败")}
								{status.subject ? t(" · {subject}", { subject: status.subject }) : ""}
							</Text>
							{status.error ? <Text type="danger">{status.error}</Text> : null}
						</div>
					</Space>
				</div>
			</SettingsSection>
		</>
	);
}
