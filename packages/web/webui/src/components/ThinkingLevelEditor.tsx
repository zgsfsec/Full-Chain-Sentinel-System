import { Checkbox, Collapse, Form, Input, Select, Space, Typography } from "antd";
import { getLanguage, t } from "../i18n.ts";
import type { SentinelThinkingLevel } from "../types.ts";
import { ALL_THINKING_LEVELS, customThinkingSettings, type ModelThinkingDraft } from "./model-thinking-draft.ts";

/** Catalog values are starting points; relays can declare a different set and wire values. */
export function ThinkingLevelEditor({
	value,
	onChange,
}: {
	value: ModelThinkingDraft;
	onChange: (next: ModelThinkingDraft) => void;
}) {
	const english = getLanguage() === "en";
	const labels = { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大" };
	return (
		<>
			<Form.Item
				label={english ? "Default thinking level" : "默认思考强度"}
				extra={english ? "Applies to new sessions; adjustable within each session." : "用于新会话，会话中仍可单独调整。"}
			>
				<Select<SentinelThinkingLevel>
					aria-label={english ? "Default thinking level" : "默认思考强度"}
					value={value.availableThinkingLevels.length ? value.defaultThinkingLevel : undefined}
					onChange={(level) => onChange({ ...value, defaultThinkingLevel: level })}
					options={value.availableThinkingLevels.map((level) => ({ value: level, label: `${t(labels[level])} (${level})` }))}
				/>
			</Form.Item>
			<Collapse
				ghost
				items={[{
					key: "mapping",
					label: english ? "Custom supported levels and request values" : "自定义支持等级与请求映射",
					children: (
						<Space orientation="vertical" style={{ width: "100%" }}>
							<Typography.Text type="secondary">
								{english
									? "Select the levels your endpoint supports and enter its request values. Mapping support depends on the selected API. Use none for off with OpenAI-compatible APIs."
									: "勾选渠道支持的等级，并填写其请求值。映射是否生效取决于所选协议；OpenAI 兼容协议的关闭值通常为 none。"}
							</Typography.Text>
							{ALL_THINKING_LEVELS.map((level) => {
								const selected = value.availableThinkingLevels.includes(level);
								return (
									<Space key={level} wrap>
										<Checkbox
											checked={selected}
											style={{ minWidth: 140 }}
											onChange={(event) => onChange(customThinkingSettings(value, event.target.checked
												? [...value.availableThinkingLevels, level]
												: value.availableThinkingLevels.filter((candidate) => candidate !== level)))}
										>
											{t(labels[level])} ({level})
										</Checkbox>
										<Input
											aria-label={english ? `${level} request value` : `${level} 请求值`}
											disabled={!selected}
											value={selected ? (value.thinkingLevelMap?.[level] ?? (level === "off" ? "none" : level)) : ""}
											placeholder={english ? "Request value" : "请求值"}
											onChange={(event) => {
												const next = customThinkingSettings(value, value.availableThinkingLevels);
												onChange({ ...next, thinkingLevelMap: { ...next.thinkingLevelMap, [level]: event.target.value } });
											}}
											spellCheck={false}
										/>
									</Space>
								);
							})}
						</Space>
					),
				}]}
			/>
		</>
	);
}
