import { DeleteOutlined, EditOutlined, PlusOutlined, SwapOutlined } from "@ant-design/icons";
import {
	Alert,
	Button,
	Checkbox,
	Col,
	Form,
	Input,
	InputNumber,
	List,
	Modal,
	Row,
	Select,
	Space,
	Tag,
	Typography,
} from "antd";
import { useEffect, useState } from "react";
import { t } from "../i18n.ts";
import { SettingsBar, SettingsNote, SettingsSection } from "../ui/Settings.tsx";
import { SUPERVISOR_STRATEGY_OPTIONS, supervisorStrategyKey } from "../supervisor-strategy.ts";
import type {
	SentinelModelLibraryView,
	SentinelSupervisorConfig,
	SentinelSupervisorCustomStrategy,
	SentinelSupervisorStrategy,
	SentinelSupervisorStrategyRef,
	SentinelTestResult,
} from "../types.ts";
import { capabilityChips, hostOf } from "./model-ui.tsx";
import { ModelRolePicker } from "./ModelRolePicker.tsx";

const { Text } = Typography;

interface CustomStrategyDraft {
	id?: string;
	name: string;
	base: SentinelSupervisorStrategy;
	description: string;
	instructions: string;
}

/**
 * 设置 → 监督: strategy and thresholds are separate from the model library, so
 * they no longer sit under the model page. The supervisor endpoint is still a
 * normal library entry and is swapped through the same picker.
 */
export function SupervisorSettingsPanel({
	supervisorConfig,
	library,
	onSaveSupervisorConfig,
	onTestSupervisor,
	onSetRole,
}: {
	supervisorConfig: SentinelSupervisorConfig;
	library: SentinelModelLibraryView | null;
	onSaveSupervisorConfig: (config: SentinelSupervisorConfig) => void;
	onTestSupervisor: () => Promise<{ result: SentinelTestResult; raw?: string } | null>;
	onSetRole: (role: "supervisor", target: string | null) => void;
}) {
	const [supervisorDraft, setSupervisorDraft] = useState<SentinelSupervisorConfig>(supervisorConfig);
	const [supervisorDirty, setSupervisorDirty] = useState(false);
	const [supervisorTesting, setSupervisorTesting] = useState(false);
	const [supervisorTest, setSupervisorTest] = useState<SentinelTestResult | null>(null);
	const [customStrategyDraft, setCustomStrategyDraft] = useState<CustomStrategyDraft | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);

	useEffect(() => {
		// Snapshots arrive while a run is active; they must not wipe an unsaved edit.
		if (!supervisorDirty) setSupervisorDraft(supervisorConfig);
	}, [supervisorConfig, supervisorDirty]);

	const updateSupervisor = (patch: Partial<SentinelSupervisorConfig>): void => {
		setSupervisorDirty(true);
		setSupervisorDraft((current) => ({ ...current, ...patch }));
	};

	const customStrategies = supervisorDraft.customStrategies;
	const defaultStrategies: SentinelSupervisorStrategyRef[] =
		supervisorDraft.defaultStrategies && supervisorDraft.defaultStrategies.length > 0
			? supervisorDraft.defaultStrategies
			: [
					{
						strategy: supervisorDraft.defaultStrategy,
						customStrategyId: supervisorDraft.defaultCustomStrategyId,
					},
				];
	const setDefaultStrategies = (next: SentinelSupervisorStrategyRef[]): void => {
		const primary = next[0];
		if (!primary) return;
		updateSupervisor({
			defaultStrategies: next,
			defaultStrategy: primary.strategy,
			defaultCustomStrategyId: primary.customStrategyId,
		});
	};
	const toggleDefaultStrategy = (ref: SentinelSupervisorStrategyRef): void => {
		const key = supervisorStrategyKey(ref);
		const exists = defaultStrategies.some((entry) => supervisorStrategyKey(entry) === key);
		if (exists) {
			if (defaultStrategies.length <= 1) return;
			setDefaultStrategies(defaultStrategies.filter((entry) => supervisorStrategyKey(entry) !== key));
			return;
		}
		setDefaultStrategies([...defaultStrategies, ref]);
	};

	const commitCustomStrategy = (): void => {
		if (!customStrategyDraft) return;
		const name = customStrategyDraft.name.trim().slice(0, 30);
		const instructions = customStrategyDraft.instructions.trim().slice(0, 500);
		if (!name || !instructions) return;
		const now = Date.now();
		const id = customStrategyDraft.id ?? `custom-${globalThis.crypto?.randomUUID?.() ?? now}`;
		const next: SentinelSupervisorCustomStrategy = {
			id,
			name,
			base: customStrategyDraft.base,
			description: customStrategyDraft.description.trim().slice(0, 80) || name,
			instructions,
			createdAt: customStrategies.find((entry) => entry.id === id)?.createdAt ?? now,
			updatedAt: now,
		};
		const list = customStrategies.some((entry) => entry.id === id)
			? customStrategies.map((entry) => (entry.id === id ? next : entry))
			: [...customStrategies, next];
		const nextDefaults = defaultStrategies.map((entry) =>
			entry.customStrategyId === id ? { strategy: next.base, customStrategyId: id } : entry,
		);
		updateSupervisor({
			customStrategies: list,
			defaultStrategies: nextDefaults,
			defaultStrategy: nextDefaults[0]?.strategy ?? next.base,
			defaultCustomStrategyId: nextDefaults[0]?.customStrategyId ?? null,
		});
		setCustomStrategyDraft(null);
	};

	const removeCustomStrategy = (id: string): void => {
		const nextDefaults = defaultStrategies.filter((entry) => entry.customStrategyId !== id);
		const safeDefaults =
			nextDefaults.length > 0 ? nextDefaults : [{ strategy: "steady" as const, customStrategyId: null }];
		updateSupervisor({
			customStrategies: customStrategies.filter((entry) => entry.id !== id),
			defaultStrategies: safeDefaults,
			defaultStrategy: safeDefaults[0]?.strategy ?? "steady",
			defaultCustomStrategyId: safeDefaults[0]?.customStrategyId ?? null,
		});
		if (customStrategyDraft?.id === id) setCustomStrategyDraft(null);
	};

	const resolved = library?.resolved.supervisor ?? null;
	const entry = library?.entries.find((candidate) => candidate.id === resolved?.entryId) ?? null;

	const strategyOptions = [
		...SUPERVISOR_STRATEGY_OPTIONS.map((option) => ({
			ref: { strategy: option.id, customStrategyId: null } as SentinelSupervisorStrategyRef,
			label: option.label,
			hint: option.hint,
			key: `preset-${option.id}`,
		})),
		...customStrategies.map((custom) => ({
			ref: { strategy: custom.base, customStrategyId: custom.id } as SentinelSupervisorStrategyRef,
			label: custom.name,
			hint: custom.description,
			key: custom.id,
		})),
	];

	return (
		<>
			<SettingsBar
				title={t("监督设置")}
				meta={supervisorDirty ? t("有未保存的修改") : null}
				extra={
					<>
						<Button
							loading={supervisorTesting}
							onClick={async () => {
								setSupervisorTesting(true);
								try {
									const outcome = await onTestSupervisor();
									setSupervisorTest(outcome?.result ?? null);
								} finally {
									setSupervisorTesting(false);
								}
							}}
						>
							{supervisorTesting ? t("测试中…") : t("测试监督模型")}
						</Button>
						<Button
							type="primary"
							onClick={() => {
								onSaveSupervisorConfig(supervisorDraft);
								setSupervisorDirty(false);
							}}
						>
							{t("保存监督设置")}
						</Button>
					</>
				}
			/>

			{supervisorTest ? (
				<Alert
					type={supervisorTest.ok ? "success" : "error"}
					showIcon
					title={supervisorTest.message}
					className="superset-test"
				/>
			) : null}

			<SettingsSection
				title={t("监督模型")}
				description={t("观察模式总结与介入判断使用的端点")}
				extra={
					<Button icon={<SwapOutlined />} onClick={() => setPickerOpen(true)}>
						{t("更换模型")}
					</Button>
				}
			>
				<div className="superset-model">
					<div>
						<Space size={6} wrap>
							<Text strong>{entry?.name ?? t("未选择监督模型")}</Text>
							{resolved?.followedMain ? (
								<Tag color="blue" variant="filled">
									{t("跟随主模型")}
								</Tag>
							) : null}
						</Space>
						<Text type="secondary" className="superset-model__sub">
							{entry ? `${entry.modelId} · ${hostOf(entry.baseUrl)}` : t("尚未解析到可用端点")}
						</Text>
						<Space size={4} wrap>
							{entry
								? capabilityChips(entry).map((chip) => (
										<Tag key={chip} variant="filled">
											{chip}
										</Tag>
									))
								: null}
						</Space>
					</div>
				</div>
				<SettingsNote>
					{t("建议使用低成本的独立模型，避免和监督对象共用同一端点。监督模型在「设置 → 模型」的模型库里维护。")}
				</SettingsNote>
			</SettingsSection>

			<SettingsSection title={t("监督策略")} description={t("全局阈值与新会话的默认值")}>
				<SettingsNote>
					{t(
						"监督是会话级功能：开始对话前在输入框上方点「监督」才会生效。这里配置全局阈值、批大小、新会话的默认策略（可多选）和自定义策略；模式、策略和补充说明在对话里选。",
					)}
				</SettingsNote>

				<Checkbox
					checked={supervisorDraft.enabled}
					onChange={(event) => updateSupervisor({ enabled: event.target.checked })}
				>
					{t("允许在对话中开启监督")}
				</Checkbox>

				<div className="superset-section">
					<Space size={8}>
						<Text strong>{t("默认监督策略")}</Text>
						<Text type="secondary">{t("可多选 · {count} 个", { count: defaultStrategies.length })}</Text>
					</Space>
					<div className="superset-strategies">
						{strategyOptions.map((option) => {
							const selected = defaultStrategies.some(
								(entry) => supervisorStrategyKey(entry) === supervisorStrategyKey(option.ref),
							);
							return (
								<Checkbox
									key={option.key}
									checked={selected}
									className={selected ? "superset-strategy is-on" : "superset-strategy"}
									onChange={() => toggleDefaultStrategy(option.ref)}
								>
									<span className="superset-strategy__copy">
										<Text strong>{option.label}</Text>
										<Text type="secondary">{option.hint}</Text>
									</span>
								</Checkbox>
							);
						})}
					</div>
					<SettingsNote>
						{t(
							"可同时选择多个策略，开启监督时会合并生效；至少保留一个。这里只决定新会话的默认值，对话里仍可调整。",
						)}
					</SettingsNote>
				</div>

				<div className="superset-section">
					<div className="superset-custom__head">
						<Space size={8}>
							<Text strong>{t("自定义策略")}</Text>
							<Text type="secondary">
								{customStrategies.length} / 12
							</Text>
						</Space>
						<Button
							size="small"
							icon={<PlusOutlined />}
							disabled={customStrategies.length >= 12 || customStrategyDraft !== null}
							onClick={() =>
								setCustomStrategyDraft({ name: "", base: "steady", description: "", instructions: "" })
							}
						>
							{t("新建")}
						</Button>
					</div>
					{customStrategies.length === 0 ? (
						<Text type="secondary">{t("还没有自定义策略。可以基于五种预设，追加自己的关注点。")}</Text>
					) : (
						<List
							size="small"
							dataSource={customStrategies}
							renderItem={(custom) => (
								<List.Item
									actions={[
										<Button
											key="edit"
											size="small"
											type="link"
											icon={<EditOutlined />}
											onClick={() =>
												setCustomStrategyDraft({
													id: custom.id,
													name: custom.name,
													base: custom.base,
													description: custom.description,
													instructions: custom.instructions,
												})
											}
										>
											{t("编辑")}
										</Button>,
										<Button
											key="delete"
											size="small"
											type="link"
											danger
											icon={<DeleteOutlined />}
											onClick={() => removeCustomStrategy(custom.id)}
										>
											{t("删除")}
										</Button>,
									]}
								>
									<List.Item.Meta
										title={custom.name}
										description={`${
											SUPERVISOR_STRATEGY_OPTIONS.find((option) => option.id === custom.base)?.label ??
											custom.base
										} · ${custom.description}`}
									/>
								</List.Item>
							)}
						/>
					)}
					<SettingsNote>{t("先保存到列表，再点上方「保存监督设置」写入配置。")}</SettingsNote>
				</div>

				<div className="superset-section">
					<Row gutter={[12, 12]}>
						<Col xs={12} md={8} lg={4}>
							<Text type="secondary">{t("每批调用数")}</Text>
							<InputNumber
								min={5}
								max={100}
								style={{ width: "100%" }}
								value={supervisorDraft.batchToolCalls}
								onChange={(value) => updateSupervisor({ batchToolCalls: value ?? 20 })}
							/>
						</Col>
						<Col xs={12} md={8} lg={4}>
							<Text type="secondary">{t("重复阈值")}</Text>
							<InputNumber
								min={2}
								max={50}
								style={{ width: "100%" }}
								value={supervisorDraft.duplicateThreshold}
								onChange={(value) => updateSupervisor({ duplicateThreshold: value ?? 3 })}
							/>
						</Col>
						<Col xs={12} md={8} lg={4}>
							<Text type="secondary">{t("无新证据阈值")}</Text>
							<InputNumber
								min={2}
								max={50}
								style={{ width: "100%" }}
								value={supervisorDraft.noProgressCalls}
								onChange={(value) => updateSupervisor({ noProgressCalls: value ?? 10 })}
							/>
						</Col>
						<Col xs={12} md={8} lg={4}>
							<Text type="secondary">{t("连续报错阈值")}</Text>
							<InputNumber
								min={2}
								max={50}
								style={{ width: "100%" }}
								value={supervisorDraft.errorStreak}
								onChange={(value) => updateSupervisor({ errorStreak: value ?? 3 })}
							/>
						</Col>
						<Col xs={12} md={8} lg={4}>
							<Text type="secondary">{t("超时（秒）")}</Text>
							<InputNumber
								min={5}
								max={300}
								style={{ width: "100%" }}
								value={Math.round(supervisorDraft.timeoutMs / 1000)}
								onChange={(value) => updateSupervisor({ timeoutMs: (value ?? 180) * 1000 })}
							/>
						</Col>
						<Col xs={12} md={8} lg={4}>
							<Text type="secondary">{t("长命令等待（秒）")}</Text>
							<InputNumber
								min={15}
								max={1800}
								style={{ width: "100%" }}
								value={Math.round(supervisorDraft.longToolCallMs / 1000)}
								onChange={(value) => updateSupervisor({ longToolCallMs: (value ?? 120) * 1000 })}
							/>
						</Col>
						<Col xs={24}>
							<SettingsNote>{t("命令超过时限仍未返回时，会根据命令和已有记录分析意图；不会中断命令。")}</SettingsNote>
						</Col>
					</Row>
				</div>

			</SettingsSection>

			<Modal
				title={customStrategyDraft?.id ? t("编辑自定义策略") : t("新建自定义策略")}
				open={customStrategyDraft !== null}
				okText={t("保存到列表")}
				cancelText={t("取消")}
				width={640}
				okButtonProps={{
					disabled: !customStrategyDraft?.name.trim() || !customStrategyDraft?.instructions.trim(),
				}}
				onOk={commitCustomStrategy}
				onCancel={() => setCustomStrategyDraft(null)}
				destroyOnHidden
			>
				{customStrategyDraft ? (
					<Form layout="vertical" requiredMark={false}>
						<Row gutter={12}>
							<Col span={14}>
								<Form.Item label={t("名称")} required>
									<Input
										value={customStrategyDraft.name}
										maxLength={30}
										onChange={(event) =>
											setCustomStrategyDraft({ ...customStrategyDraft, name: event.target.value })
										}
										placeholder={t("例如：支付网关专用")}
									/>
								</Form.Item>
							</Col>
							<Col span={10}>
								<Form.Item label={t("基础预设")}>
									<Select
										value={customStrategyDraft.base}
										onChange={(value) =>
											setCustomStrategyDraft({ ...customStrategyDraft, base: value as SentinelSupervisorStrategy })
										}
										options={SUPERVISOR_STRATEGY_OPTIONS.map((option) => ({
											value: option.id,
											label: option.label,
										}))}
									/>
								</Form.Item>
							</Col>
						</Row>
						<Form.Item label={t("一句话说明")}>
							<Input
								value={customStrategyDraft.description}
								maxLength={80}
								onChange={(event) =>
									setCustomStrategyDraft({ ...customStrategyDraft, description: event.target.value })
								}
								placeholder={t("例如：先看授权边界，再验证越权")}
							/>
						</Form.Item>
						<Form.Item
							label={t("关注点与建议风格")}
							required
							extra={t("自定义说明只改变监督关注点和建议风格，不能放宽授权范围或安全规则。")}
						>
							<Input.TextArea
								value={customStrategyDraft.instructions}
								maxLength={500}
								autoSize={{ minRows: 5, maxRows: 12 }}
								onChange={(event) =>
									setCustomStrategyDraft({ ...customStrategyDraft, instructions: event.target.value })
								}
								placeholder={t("例如：优先验证 IDOR；不做目录爆破；建议必须给出对照请求。")}
							/>
						</Form.Item>
					</Form>
				) : null}
			</Modal>

			{pickerOpen && library ? (
				<ModelRolePicker
					library={library}
					role="supervisor"
					results={{}}
					onApply={(target) => {
						onSetRole("supervisor", target);
						setPickerOpen(false);
					}}
					onClose={() => setPickerOpen(false)}
				/>
			) : null}
		</>
	);
}
