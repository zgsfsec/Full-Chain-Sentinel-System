import { CheckCircleOutlined, LeftOutlined } from "@ant-design/icons";
import { Alert, Button, Collapse, Empty, Input, Modal, Space, Spin, Table, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { ASSET_IMPORT_MAX_CHARACTERS, type AssetImportPreview, type AssetImportResult } from "../../../src/asset-import-types.ts";
import { getLanguage, t } from "../i18n.ts";
import { SENTINEL_ASSET_KIND_LABELS } from "../types.ts";
import "../styles/asset-import.css";

const labels = getLanguage() === "zh" ? {
	title: "导入资产", paste: "粘贴内容", preview: "识别预览", recognize: "识别资产", confirm: "确认导入",
	back: "修改内容", project: "导入项目", hint: "支持域名、IPv4 / IPv6、主机:端口及 URL，使用空格、逗号或换行分隔。",
	limit: "每次最多 1000 条、200000 字符。URL 查询参数中的逗号会保留，建议每行一个 URL。",
	merge: "新资产为待测试；已有资产合并并保留状态、标签及测试记录。URL 按协议、主机和路径去重，忽略查询参数。",
	new: "新增", existing: "合并已有", duplicates: "粘贴内重复", invalid: "无法识别", validOnly: "确认后仅导入有效资产，无法识别的内容会跳过。",
	input: "原始内容", asset: "识别结果", type: "类型", action: "处理", none: "没有识别到有效资产，请修改内容后重试。",
	failed: "请求失败，请重试。", complete: "导入完成", done: "完成", skipped: "跳过无效内容",
} : {
	title: "Import assets", paste: "Paste", preview: "Preview", recognize: "Recognize assets", confirm: "Confirm import",
	back: "Edit content", project: "Project", hint: "Paste domains, IPv4 / IPv6, host:port or URLs, separated by spaces, commas or newlines.",
	limit: "Up to 1,000 entries and 200,000 characters. Commas in URL queries are preserved; use one URL per line.",
	merge: "New assets are pending. Existing status, tags and test records are preserved. URL deduplication uses scheme, host and path, ignoring query parameters.",
	new: "New", existing: "Merge existing", duplicates: "Repeated input", invalid: "Unrecognized", validOnly: "Only valid assets will be imported. Unrecognized content will be skipped.",
	input: "Original input", asset: "Recognized asset", type: "Type", action: "Action", none: "No valid assets found. Edit the content and try again.",
	failed: "Request failed. Try again.", complete: "Import complete", done: "Done", skipped: "Invalid entries skipped",
};

async function requestImport<T>(path: string, signal: AbortSignal, body?: { projectId: string; text: string }): Promise<T> {
	const response = await fetch(path, {
		method: body ? "POST" : "GET", signal, cache: "no-store",
		...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const payload = await response.json() as T & { error?: string };
	if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : labels.failed);
	return payload;
}

export function AssetImportPreviewBody({ preview }: { preview: AssetImportPreview }) {
	return <div className="asset-import__preview">
		<div className="asset-import__counts">
			<span>{labels.new} <strong>{preview.created}</strong></span>
			<span>{labels.existing} <strong>{preview.merged}</strong></span>
			<span>{labels.duplicates} <strong>{preview.duplicates}</strong></span>
			<span>{labels.invalid} <strong>{preview.invalid.length}</strong></span>
		</div>
		<Table<AssetImportPreview["items"][number]>
			size="small" rowKey="name" dataSource={preview.items} tableLayout="fixed"
			pagination={preview.items.length > 20 ? { pageSize: 20, showSizeChanger: false, size: "small" } : false}
			scroll={{ y: 280 }}
			locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={labels.none} /> }}
			columns={[
				{ title: labels.type, dataIndex: "kind", width: 70, render: (kind: keyof typeof SENTINEL_ASSET_KIND_LABELS) => SENTINEL_ASSET_KIND_LABELS[kind] },
				{ title: labels.asset, dataIndex: "name", render: (_, item) => <div className="asset-import__identity"><span title={item.input}>{item.name}</span>{item.warnings.map((warning) => <small key={warning}>{warning}</small>)}</div> },
				{ title: labels.action, dataIndex: "existing", width: 100, render: (existing: boolean) => <Tag color={existing ? "default" : "blue"}>{existing ? labels.existing : labels.new}</Tag> },
			]}
		/>
		{preview.invalid.length > 0 ? <>
			<div className="asset-import__hint">{labels.validOnly}</div>
			<Collapse ghost size="small" items={[{
				key: "invalid", label: `${labels.invalid} (${preview.invalid.length})`, children: <ul className="asset-import__invalid">{preview.invalid.map((item, index) => <li key={`${index}-${item.input}`}><code>{item.input}</code><span>{item.reason}</span></li>)}</ul>,
			}]} />
		</> : null}
	</div>;
}

export function AssetImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
	const activeRequest = useRef<AbortController | null>(null);
	const [project, setProject] = useState<{ id: string; name: string } | null>(null);
	const [text, setText] = useState("");
	const [preview, setPreview] = useState<AssetImportPreview | null>(null);
	const [result, setResult] = useState<AssetImportResult | null>(null);
	const [pending, setPending] = useState<"context" | "preview" | "import" | null>("context");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const initial = new AbortController();
		activeRequest.current = initial;
		void requestImport<{ id: string; name: string }>("/api/assets/import", initial.signal)
			.then(setProject)
			.catch((reason: unknown) => { if (!initial.signal.aborted) setError(reason instanceof Error ? reason.message : labels.failed); })
			.finally(() => { if (!initial.signal.aborted) setPending(null); });
		return () => { activeRequest.current?.abort(); };
	}, []);

	const submit = async (): Promise<void> => {
		if (!project || pending) return;
		const controller = new AbortController();
		activeRequest.current = controller;
		setError(null);
		setPending(preview ? "import" : "preview");
		try {
			const body = { projectId: project.id, text };
			if (!preview) {
				setPreview(await requestImport<AssetImportPreview>("/api/assets/import/preview", controller.signal, body));
			} else {
				const imported = await requestImport<AssetImportResult>("/api/assets/import", controller.signal, body);
				setResult(imported);
				onImported();
			}
		} catch (reason) {
			if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : labels.failed);
		} finally {
			if (!controller.signal.aborted) setPending(null);
		}
	};

	return <Modal open title={labels.title} width={760} className="asset-import-dialog" onCancel={onClose}
		closable={pending !== "import"} keyboard={pending !== "import"} mask={{ closable: pending !== "import" }}
		footer={result ? <Button type="primary" onClick={onClose}>{labels.done}</Button> : <Space>
			{preview ? <Button icon={<LeftOutlined />} disabled={pending !== null} onClick={() => { setPreview(null); setError(null); }}>{labels.back}</Button> : <Button disabled={pending === "import"} onClick={onClose}>{t("取消")}</Button>}
			<Button type="primary" loading={pending === "preview" || pending === "import"} disabled={!project || pending === "context" || !text.trim() || (preview !== null && preview.items.length === 0)} onClick={() => void submit()}>{preview ? labels.confirm : labels.recognize}</Button>
		</Space>}
	>
		<div className="asset-import">
			{project ? <div className="asset-import__project">{labels.project}<strong>{project.name}</strong></div> : null}
			{error ? <Alert type="error" showIcon title={error} /> : null}
			{pending === "context" ? <div className="asset-import__loading"><Spin /></div> : null}
			{result ? <div className="asset-import__success" role="status">
				<CheckCircleOutlined /><strong>{labels.complete}</strong>
				<div>{labels.new} {result.created} · {labels.existing} {result.merged}</div>
				{result.invalid > 0 ? <small>{labels.skipped} {result.invalid}</small> : null}
			</div> : <>
				<div className="asset-import__steps"><span className={!preview ? "is-active" : ""}>1. {labels.paste}</span><span>→</span><span className={preview ? "is-active" : ""}>2. {labels.preview}</span></div>
				{preview ? <AssetImportPreviewBody preview={preview} /> : <>
					<p className="asset-import__hint">{labels.hint}</p>
					<Input.TextArea aria-label={labels.paste} value={text} disabled={pending !== null} maxLength={ASSET_IMPORT_MAX_CHARACTERS} autoSize={{ minRows: 7, maxRows: 10 }} showCount placeholder={"example.com\n192.168.1.10\n192.168.1.10:443\nhttps://example.com/login"} onChange={(event) => setText(event.target.value)} />
					<p className="asset-import__limit">{labels.limit}</p>
				</>}
				<p className="asset-import__policy">{labels.merge}</p>
			</>}
		</div>
	</Modal>;
}
