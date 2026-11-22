import { DownOutlined } from "@ant-design/icons";
import { Button, Select, Tooltip, Typography } from "antd";
import { useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import type { SentinelModelLibraryView, SentinelStateSnapshot } from "../types.ts";
import "./chat-model-picker.css";

/** The selected global default and the model currently holding this conversation can differ. */
export function ChatModelPicker({ library, currentModel, connected, onSelect, onManage }: {
	library: SentinelModelLibraryView | null;
	currentModel: SentinelStateSnapshot["model"];
	connected: boolean;
	onSelect: (entryId: string) => void;
	onManage: () => void;
}) {
	const english = getLanguage() === "en";
	const [open, setOpen] = useState(false);
	const selected = library?.resolved.main;
	const pending = selected && currentModel &&
		(selected.entryId !== currentModel.provider || selected.modelId !== currentModel.id);
	const currentEntry = library?.entries.find((entry) => entry.id === currentModel?.provider);
	const currentName = currentEntry?.name ?? currentModel?.id;

	return <div className="chat-model-picker">
		<Tooltip open={open ? false : undefined} title={english
			? "Changes the global main model and roles following it. Running conversations keep their model; the next send uses the selection."
			: "修改全局主模型及跟随它的角色。正在运行的会话保持当前模型，下次空闲时发送使用所选模型。"}>
			<span className="chat-toolbar__field">
				<Typography.Text type="secondary">{t("主模型")}</Typography.Text>
				<span className="chat-model-picker__scope">{english ? "Global" : "全局"}</span>
				<Select
					aria-label={english ? "Global main model" : "全局主模型"}
					size="small"
					variant="borderless"
					className="chat-model-picker__select"
					showSearch={{ optionFilterProp: "searchText" }}
					loading={library === null}
					disabled={!connected || library === null}
					value={selected?.entryId}
					open={open}
					onOpenChange={setOpen}
					placeholder={english ? "Select model" : "选择模型"}
					onChange={onSelect}
					suffixIcon={<DownOutlined />}
					popupMatchSelectWidth={false}
					popupAlign={{ overflow: { adjustX: true, adjustY: true, shiftX: true }, htmlRegion: "visible" }}
					classNames={{ popup: { root: "chat-model-picker__popup" } }}
					options={(library?.entries ?? []).map((entry) => ({
						value: entry.id,
						label: entry.name,
						modelId: entry.modelId,
						searchText: `${entry.name} ${entry.modelId} ${entry.baseUrl}`,
						title: `${entry.name} · ${entry.modelId}`,
					}))}
					optionRender={(option) => <div className="chat-model-picker__option">
						<span>{option.data.label}</span>
						<Typography.Text type="secondary">{option.data.modelId}</Typography.Text>
					</div>}
					notFoundContent={english ? "No matching models" : "没有匹配的模型"}
					popupRender={(menu) => <>{menu}<div className="chat-model-picker__footer">
						<Button type="text" size="small" block onClick={() => { setOpen(false); onManage(); }}>
							{english ? "Manage models" : "管理模型"}
						</Button>
					</div></>}
				/>
			</span>
		</Tooltip>
		{pending ? <Typography.Text type="secondary" className="chat-model-picker__pending" role="status"
			title={english ? `Current model: ${currentName}. The next idle send uses ${selected.entryName}.`
				: `当前模型：${currentName}。下次空闲时发送使用 ${selected.entryName}。`}>
			{english ? `Next send · Current: ${currentName}` : `下次发送生效 · 当前：${currentName}`}
		</Typography.Text> : null}
	</div>;
}
