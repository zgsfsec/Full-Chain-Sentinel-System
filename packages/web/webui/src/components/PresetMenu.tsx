/**
 * The preset picker.
 *
 * Two places open it: the sider's 对话 header and the composer's 预设 Agent
 * switch, so the markup and the anchoring live here rather than in either
 * caller. The sider clips its own overflow, so the menu is portaled to
 * document.body with fixed coordinates like the session hover card.
 */

import { List, Space, Tag, Typography } from "antd";
import { t } from "../i18n.ts";
import type { SentinelPresetView } from "../types.ts";
import { PickerShell, type PickerAnchor } from "../ui/PickerShell.tsx";

const { Text } = Typography;

/** Where the menu hangs: below the button, or above it when there is no room. */
export type PresetMenuAnchor = PickerAnchor;

/**
 * Anchor the menu to its button, nudged left like the sider's caret and kept
 * inside the viewport. The composer's switch sits near the bottom of the window,
 * where a fixed menu cannot be scrolled into view, so the menu flips upward when
 * the space below is too small.
 *
 * `needed` is the height the menu's content takes. Below that, opening downward
 * would only put a scrollbar in front of the last items, so the menu goes up.
 */
export function presetMenuPosition(rect: DOMRect, width = 260, maximumHeight = 320, needed = 200): PresetMenuAnchor {
	const left = Math.max(8, Math.min(rect.left - 6, window.innerWidth - width - 8));
	const below = Math.max(0, window.innerHeight - rect.bottom - 12);
	const above = Math.max(0, rect.top - 12);
	if (below < needed && above > below) {
		return {
			left,
			bottom: window.innerHeight - rect.top + 4,
			maxHeight: Math.min(maximumHeight, above),
		};
	}
	return { left, top: rect.bottom + 4, maxHeight: Math.min(maximumHeight, below) };
}

export function PresetMenu(props: {
	anchor: PresetMenuAnchor;
	presets: readonly SentinelPresetView[];
	/**
	 * The preset the viewed session already runs under, marked in the list. Omitted
	 * by the 新建会话 picker, which has no current choice to point at.
	 */
	currentId?: string | null;
	/** Undefined means the default agent: a session with no preset at all. */
	onPick: (presetId?: string) => void;
	onClose: () => void;
}) {
	const enabled = props.presets.filter((preset) => preset.enabled);

	return (
		<PickerShell
			anchor={props.anchor}
			title={t("以哪个身份新建会话")}
			width={260}
			onClose={props.onClose}
		>
			<List
				size="small"
				dataSource={[
					{
						id: "__default__",
						name: t("默认 Agent"),
						description: t("不追加任何身份设定"),
						current: props.currentId === null,
					},
					...enabled.map((preset) => ({
						id: preset.id,
						name: preset.name,
						description: preset.description,
						current: props.currentId === preset.id,
					})),
				]}
				renderItem={(item) => (
					<List.Item
						className="pickmenu__item"
						onClick={() => props.onPick(item.id === "__default__" ? undefined : item.id)}
					>
						<div className="pickmenu__item-text" style={{ minWidth: 0 }}>
							<Space size={6}>
								<Text>{item.name}</Text>
								{item.current ? (
									<Tag color="blue" variant="filled">
										{t("当前")}
									</Tag>
								) : null}
							</Space>
							{item.description ? <Text type="secondary" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{item.description}</Text> : null}
						</div>
					</List.Item>
				)}
			/>
			{enabled.length === 0 ? (
				<Text type="secondary" className="pickmenu__hint">
					{t("还没有启用的预设 Agent。到「设置 → 预设 Agent」新建一个，回到这里就能选它开会话。")}
				</Text>
			) : null}
		</PickerShell>
	);
}
