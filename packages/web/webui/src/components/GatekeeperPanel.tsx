/**
 * 设置 → 模型 的守门段落。
 *
 * The judge endpoint itself is chosen in the 角色 block above (it is just a model
 * library entry); this panel owns what only the gatekeeper needs — the global
 * default mode, the judgment timeout, and the concurrency cap — plus a way to
 * prove the resolved endpoint actually answers.
 */

import { Alert, Button, Checkbox, InputNumber, Segmented, Space, Tag, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n.ts";
import { SettingsNote, SettingsSection } from "../ui/Settings.tsx";
import type {
	SentinelGatekeeperConfig,
	SentinelMcpToolGate,
	SentinelMode,
	SentinelResolvedModelView,
	SentinelTestResult,
} from "../types.ts";
import { SENTINEL_MODE_LABELS, SENTINEL_MODES } from "../types.ts";

const { Text } = Typography;

/**
 * What an unread config means. A console that predates the switches (or a reply
 * that arrives without them) must not take the page down: the whole settings
 * screen is one render tree and there is no error boundary above it.
 */
const DEFAULT_MCP_TOOLS: SentinelMcpToolGate = { enabled: true, includePlugins: false };

/** The gatekeeper's own settings, saved with one button. */
export function GatekeeperPanel({
	gatekeeperConfig,
	judgeResolved,
	onSave,
	onTestJudge,
}: {
	gatekeeperConfig: SentinelGatekeeperConfig;
	/** What the 守门模型 role resolves to right now. */
	judgeResolved: SentinelResolvedModelView | null;
	onSave: (settings: SentinelGatekeeperConfig) => void;
	onTestJudge: () => Promise<{ result: SentinelTestResult; raw?: string } | null>;
}) {
	const [globalMode, setGlobalMode] = useState<SentinelMode>(gatekeeperConfig.mode);
	const [timeoutMs, setTimeoutMs] = useState(String(gatekeeperConfig.timeoutMs));
	const [concurrency, setConcurrency] = useState(String(gatekeeperConfig.concurrency));
	const [mcpTools, setMcpTools] = useState<SentinelMcpToolGate>(gatekeeperConfig.mcpTools ?? DEFAULT_MCP_TOOLS);
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<SentinelTestResult | null>(null);
	const [raw, setRaw] = useState<string | undefined>(undefined);

	// The reply to `get_gatekeeper_config` can arrive after this panel mounted.
	// Re-sync only when the stored config actually changed, so a save round-trip
	// cannot wipe what the operator is still typing.
	const appliedSettings = useRef(JSON.stringify(gatekeeperConfig));
	useEffect(() => {
		const incoming = JSON.stringify(gatekeeperConfig);
		if (incoming === appliedSettings.current) return;
		appliedSettings.current = incoming;
		setGlobalMode(gatekeeperConfig.mode);
		setTimeoutMs(String(gatekeeperConfig.timeoutMs));
		setConcurrency(String(gatekeeperConfig.concurrency));
		setMcpTools(gatekeeperConfig.mcpTools ?? DEFAULT_MCP_TOOLS);
	}, [gatekeeperConfig]);

	const settingsDraft = useMemo<SentinelGatekeeperConfig>(
		() => ({
			mode: globalMode,
			timeoutMs: Math.max(1000, Math.floor(Number(timeoutMs) || 0)),
			concurrency: Math.max(0, Math.floor(Number(concurrency) || 0)),
			mcpTools,
		}),
		[globalMode, timeoutMs, concurrency, mcpTools],
	);

	const runTest = async () => {
		setTesting(true);
		setResult(null);
		setRaw(undefined);
		try {
			const outcome = await onTestJudge();
			setResult(outcome?.result ?? null);
			setRaw(outcome?.raw);
		} finally {
			setTesting(false);
		}
	};

	return (
		<SettingsSection
			className="settings-panel modelhub-gatekeeper"
			title={t("守门设置（AI 审批）")}
			description={t("全局默认模式、判定超时与工具范围")}
			extra={
				<Space size={8} wrap>
					<Button
						loading={testing}
						disabled={judgeResolved === null || testing}
						onClick={() => void runTest()}
					>
						{testing ? t("判定中…") : t("测试判定")}
					</Button>
					<Button type="primary" onClick={() => onSave(settingsDraft)}>
						{t("保存守门配置")}
					</Button>
				</Space>
			}
		>
			<details className="modelhub-explainer">
				<summary>{t("AI 审批如何判定")}</summary>
				<SettingsNote>
					{t("AI 审批模式下每条命令都先交给「守门模型」判定：返回")} <Text code>ALLOW</Text>{" "}
					{t("才执行，返回")} <Text code>{t("BLOCK: 理由")}</Text>{" "}
					{t("则拒绝并把理由回给 Agent。判定失败（超时、报错、返回无法解析）一律放行，并在审计页记为「请求失败」。")}{" "}
					{t("端点在「角色分配 → 守门模型」里选择。")}
				</SettingsNote>
			</details>

			<div className="settings-field">
				<span className="settings-field__label">{t("当前生效端点")}</span>
				{judgeResolved ? (
					<Space size={6} wrap>
						<Text>{judgeResolved.entryName}</Text>
						<Text strong>{judgeResolved.modelId}</Text>
						{judgeResolved.followedMain ? (
							<Tag color="blue" variant="filled">
								{t("跟随主模型")}
							</Tag>
						) : null}
					</Space>
				) : (
					<Text type="danger">{t("无（切到 AI 审批会被拒绝）")}</Text>
				)}
			</div>

			<div className="settings-grid">
				<div className="settings-field" style={{ gridColumn: "1 / -1" }}>
					<span className="settings-field__label">{t("全局默认模式")}</span>
					<div>
						<Segmented
							value={globalMode}
							onChange={(value) => setGlobalMode(value as SentinelMode)}
							options={SENTINEL_MODES.map((item) => ({ value: item, label: SENTINEL_MODE_LABELS[item] }))}
						/>
					</div>
					<span className="settings-field__hint">
						{t("新建会话跟随它；已有会话可在对话工具栏单独设定或点「跟随全局」回到默认。")}
					</span>
				</div>
				<div className="settings-field">
					<span className="settings-field__label">{t("判定超时（毫秒）")}</span>
					<InputNumber
						min={1000}
						max={120000}
						step={1000}
						style={{ width: "100%" }}
						value={timeoutMs.trim() === "" ? null : Number(timeoutMs)}
						onChange={(value) => setTimeoutMs(value === null || value === undefined ? "" : String(value))}
						placeholder="15000"
					/>
					<span className="settings-field__hint">{t("超时即放行并记为「请求失败」。范围 1000–120000。")}</span>
				</div>
				<div className="settings-field">
					<span className="settings-field__label">{t("并发上限")}</span>
					<InputNumber
						min={0}
						max={64}
						style={{ width: "100%" }}
						value={concurrency.trim() === "" ? null : Number(concurrency)}
						onChange={(value) => setConcurrency(value === null || value === undefined ? "" : String(value))}
						placeholder="0"
					/>
					<span className="settings-field__hint">
						{t("同时进行中的判定数量，0 = 不限制（子代理并行侦察时用得上）。上限 64。")}
					</span>
				</div>
			</div>

			{result ? (
				<Alert
					type={result.ok ? "success" : "error"}
					showIcon
					className="ui-page__alert"
					title={result.message}
					description={
						<>
							{result.detail ? <pre className="gatekeeper__pre">{result.detail}</pre> : null}
							{raw ? <pre className="gatekeeper__pre">{raw}</pre> : null}
						</>
					}
				/>
			) : null}

			<div className="settings-field">
				<span className="settings-field__label">{t("MCP 工具判定")}</span>
				<details className="modelhub-explainer">
					<summary>{t("了解 MCP 判定的影响")}</summary>
					<SettingsNote>
						{t("bash 命令在任何模式下都由上面的模式决定；这一段管的是另外一类调用：MCP 与插件工具。")}{" "}
						{t("打开后，AI 审批模式下每一次这类调用也会先交给守门模型，被拦时把理由回给 Agent。")}
						<Text strong>{t("每次调用都要多花一次模型往返")}</Text>
						{t("，高频只读工具（列目录、查资产）会明显变慢。")}
					</SettingsNote>
				</details>
				<div className="gatekeeper__options">
					<Checkbox
						checked={mcpTools.enabled}
						onChange={(event) => setMcpTools((prev) => ({ ...prev, enabled: event.target.checked }))}
					>
						<Text strong>{t("同时判定 MCP 工具")}</Text>
						<Text type="secondary" className="gatekeeper__hint">
							{t("关闭后守门模型只看 bash 命令，插件与 MCP 工具不再经过判定")}
						</Text>
					</Checkbox>
					<Checkbox
						checked={mcpTools.includePlugins}
						disabled={!mcpTools.enabled}
						onChange={(event) => setMcpTools((prev) => ({ ...prev, includePlugins: event.target.checked }))}
					>
						<Text strong>{t("包含插件工具")}</Text>
						<Text type="secondary" className="gatekeeper__hint">
							{t("插件工具（server 名以")} <Text code>plugin-</Text>{" "}
							{t("开头）能操作受管主机，最值得判；一个插件常有几十个工具， 也最吵。默认不纳入")}
						</Text>
					</Checkbox>
				</div>
			</div>
		</SettingsSection>
	);
}
