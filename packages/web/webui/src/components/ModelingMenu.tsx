/**
 * The 业务建模 menu: the composer's entry to modeling.
 *
 * 开始建模 is only the instruction. It sends the briefing to the agent of this
 * conversation, which decides by what it has — traffic to restore interfaces
 * from, source in the work directory to read — and opens the record with its
 * first accepted submission. 结束建模 closes the record this conversation is
 * writing. There is nothing to attach any more: every agent reads the project's
 * records on its own.
 *
 * Like the preset picker it is portaled to document.body with fixed
 * coordinates: the composer sits at the bottom of the window where a plain
 * dropdown would clip.
 */

import { Button, Typography } from "antd";
import { t } from "../i18n.ts";
import type { SentinelModelingState } from "../types.ts";
import { PickerShell, type PickerAnchor } from "../ui/PickerShell.tsx";

const { Text } = Typography;

interface ModelingMenuProps {
	/** The run in force for this conversation: the record its agent is writing. Null means none. */
	modeling: SentinelModelingState | null;
	/** The agent is running: the instruction is queued after the turn, and the run cannot be ended. */
	streaming: boolean;
	/** An engineering task's conversation. Its commander dispatches modeling; the operator does not. */
	taskSession: boolean;
	onStart(): void;
	onEnd(): void;
	onClose(): void;
}

export function ModelingMenu(props: ModelingMenuProps & { anchor: PickerAnchor }) {
	return (
		<PickerShell anchor={props.anchor} title={t("业务建模")} width={320} className="modeling-menu" onClose={props.onClose}>
			<ModelingMenuBody {...props} />
		</PickerShell>
	);
}

/**
 * The menu's two actions, apart from the portal. The portal is what keeps the
 * menu out of the composer's clipping; apart from it, a test can render the menu.
 */
export function ModelingMenuBody(props: ModelingMenuProps) {
	const run = props.modeling;
	return (
		<>
			<Button
				type="text"
				block
				className="pickmenu__action"
				disabled={props.taskSession}
				title={
					props.taskSession
						? t("工程任务的会话由指挥官安排业务建模，不能在这里开始")
						: props.streaming
							? t("Agent 正在运行：建模指令会排到本轮之后")
							: t("把建模指令发给 Agent：有流量就还原接口，工作目录里有源码就读源码")
				}
				onClick={() => {
					props.onStart();
					props.onClose();
				}}
			>
				<span className="pickmenu__item-text">
					<Text strong>{t("开始建模")}</Text>
					<Text type="secondary">{t("只发一段建模指令，做哪部分由 Agent 按输入决定")}</Text>
				</span>
			</Button>
			<Button
				type="text"
				block
				className="pickmenu__action"
				disabled={!run || props.streaming}
				title={
					!run
						? t("当前会话没有进行中的业务建模")
						: props.streaming
							? t("Agent 正在运行，先中止或等本轮结束")
							: t("结束这次建模（{title}），Agent 回到普通工作", { title: run.title })
				}
				onClick={() => {
					props.onEnd();
					props.onClose();
				}}
			>
				<span className="pickmenu__item-text">
					<Text strong>{t("结束建模")}</Text>
					<Text type="secondary">
						{run
							? t("{title} · {paths} 路径 / {apis} 条源码映射", {
									title: run.title,
									paths: run.pathCount,
									apis: run.apiCount,
								})
							: t("结束这条对话正在写的那条记录")}
					</Text>
				</span>
			</Button>
		</>
	);
}
