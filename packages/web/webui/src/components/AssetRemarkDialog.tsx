import { Alert, Input, Modal, Radio } from "antd";
import { useEffect, useRef, useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import type { SentinelAssetSummary } from "../types.ts";
import "../styles/asset-remark.css";

export const assetRemarkLabels = getLanguage() === "zh" ? {
	edit: "编辑备注", add: "添加备注", batch: "批量备注", filter: "按备注筛选（回车应用）",
	append: "追加备注", replace: "覆盖备注", content: "备注内容",
	hint: "人工与 Agent 均可读取、修改；备注不会计入测试记录。",
	batchHint: "追加会保留原备注并换行添加；覆盖会替换原备注，留空则清空。",
	failed: "保存失败，请重试。", selected: "选中资产", empty: "暂无备注",
} : {
	edit: "Edit remark", add: "Add remark", batch: "Batch remarks", filter: "Filter remarks (press Enter)",
	append: "Append", replace: "Replace", content: "Remark",
	hint: "Operators and Agents can read and edit remarks. Remarks do not count as test records.",
	batchHint: "Append keeps existing remarks and adds a new line. Replace overwrites them; leave empty to clear.",
	failed: "Save failed. Try again.", selected: "Selected assets", empty: "No remark",
};

export function AssetRemarkDialog({ assets, batch = false, onClose, onSaved }: {
	assets: readonly SentinelAssetSummary[];
	batch?: boolean;
	onClose: () => void;
	onSaved?: () => void;
}) {
	const [remark, setRemark] = useState(batch ? "" : assets[0]?.remark ?? "");
	const [mode, setMode] = useState<"append" | "replace">(batch ? "append" : "replace");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const request = useRef<AbortController | null>(null);
	useEffect(() => () => request.current?.abort(), []);

	const save = async (): Promise<void> => {
		if (request.current || assets.length === 0) return;
		const controller = new AbortController();
		request.current = controller;
		setPending(true);
		setError(null);
		try {
			const response = await fetch("/api/assets/remarks", {
				method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
				body: JSON.stringify({ projectId: assets[0].projectId, ids: assets.map((asset) => asset.id), remark, mode }),
			});
			const payload = await response.json() as { error?: string };
			if (!response.ok) throw new Error(payload.error || assetRemarkLabels.failed);
			if (controller.signal.aborted) return;
			onSaved?.();
			onClose();
		} catch (reason) {
			if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : assetRemarkLabels.failed);
		} finally {
			if (!controller.signal.aborted) {
				request.current = null;
				setPending(false);
			}
		}
	};

	return <Modal open title={batch ? assetRemarkLabels.batch : assetRemarkLabels.edit}
		onCancel={onClose} onOk={() => void save()} confirmLoading={pending}
		okText={t("保存")} cancelText={t("取消")} closable={!pending} keyboard={!pending} mask={{ closable: !pending }}
		cancelButtonProps={{ disabled: pending }} okButtonProps={{ disabled: assets.length === 0 || (mode === "append" && !remark.trim()) }}>
		<div className="asset-remark-dialog">
			<p>{batch ? `${assetRemarkLabels.selected}：${assets.length}` : `${assets[0]?.label} · ${assets[0]?.name}`}</p>
			{error ? <Alert type="error" showIcon title={error} /> : null}
			{batch ? <Radio.Group value={mode} disabled={pending} onChange={(event) => setMode(event.target.value as "append" | "replace")}
				options={[{ value: "append", label: assetRemarkLabels.append }, { value: "replace", label: assetRemarkLabels.replace }]} /> : null}
			<Input.TextArea aria-label={assetRemarkLabels.content} value={remark} onChange={(event) => setRemark(event.target.value)}
				disabled={pending} maxLength={10000} showCount autoSize={{ minRows: 4, maxRows: 10 }} />
			<p className="asset-remark-hint">{batch ? assetRemarkLabels.batchHint : assetRemarkLabels.hint}</p>
		</div>
	</Modal>;
}
