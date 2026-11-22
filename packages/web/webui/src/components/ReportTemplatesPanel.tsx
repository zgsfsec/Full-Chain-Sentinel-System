import { CopyOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { Alert, App, Button, Empty, Flex, Input, Space, Table, Typography } from "antd";
import { useDeferredValue, useEffect, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReportTemplate, ReportTemplateList, ReportTemplateSummary } from "../../../src/report-types.ts";
import { getLanguage } from "../i18n.ts";
import { reportTemplateRequest } from "../report-template-api.ts";
import { ReportTemplateSelect } from "./ReportTemplateSelect.tsx";

const tx = (zh: string, en: string) => getLanguage() === "en" ? en : zh;
type Draft = Pick<ReportTemplate, "name" | "markdown"> & Partial<Pick<ReportTemplate, "id" | "revision">>;
interface Editor { original: ReportTemplate | null; draft: Draft }
const draftKey = (id?: string) => `sentinel-report-template-draft:${id ?? "new"}`;

export function ReportTemplatesPanel({ projectId, refreshToken = 0 }: { projectId: string | null; refreshToken?: number }) {
	const { modal, message } = App.useApp();
	const [data, setData] = useState<ReportTemplateList | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [revision, setRevision] = useState(0);
	const [editor, setEditor] = useState<Editor | null>(null);
	const [busy, setBusy] = useState(false);
	const [search, setSearch] = useState("");
	const [loading, setLoading] = useState(true);
	const markdown = useDeferredValue(editor?.draft.markdown ?? "");
	const dirty = !!editor && (editor.draft.name !== (editor.original?.name ?? "") || editor.draft.markdown !== (editor.original?.markdown ?? ""));
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		void reportTemplateRequest<ReportTemplateList>(projectId ? `?projectId=${encodeURIComponent(projectId)}` : "", { signal: controller.signal })
			.then((next) => { if (!controller.signal.aborted) { setData(next); setError(null); } })
			.catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); })
			.finally(() => { if (!controller.signal.aborted) setLoading(false); });
		return () => controller.abort();
	}, [projectId, revision, refreshToken]);
	useEffect(() => {
		if (!editor) return;
		try {
			if (dirty) sessionStorage.setItem(draftKey(editor.draft.id), JSON.stringify(editor.draft));
			else sessionStorage.removeItem(draftKey(editor.draft.id));
		} catch { /* Editing remains available without browser storage. */ }
	}, [editor, dirty]);
	useEffect(() => {
		if (!dirty) return;
		const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	const open = async (id?: string, copy = false) => {
		setBusy(true);
		try {
			const original = id ? await reportTemplateRequest<ReportTemplate>(`/${encodeURIComponent(id)}`) : null;
			let draft: Draft = copy && original ? { name: `${original.name.slice(0, 110)} ${tx("副本", "copy")}`, markdown: original.markdown } : original ?? { name: "", markdown: "" };
			if (!copy) {
				try {
					const saved: unknown = JSON.parse(sessionStorage.getItem(draftKey(id)) ?? "null");
					if (saved && typeof saved === "object" && "name" in saved && typeof saved.name === "string" && "markdown" in saved && typeof saved.markdown === "string" && (!id || ("revision" in saved && typeof saved.revision === "string"))) {
						draft = { name: saved.name, markdown: saved.markdown, id, revision: "revision" in saved && typeof saved.revision === "string" ? saved.revision : undefined };
						void message.info(tx("已恢复未保存的模板草稿", "Unsaved template draft restored"));
					}
				} catch { /* Invalid drafts do not prevent opening a template. */ }
			}
			setEditor({ original: copy ? null : original, draft });
			setError(null);
		} catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
		finally { setBusy(false); }
	};
	const leave = () => {
		const discard = () => {
			try { sessionStorage.removeItem(draftKey(editor?.draft.id)); } catch { /* Storage is optional. */ }
			setEditor(null); setError(null);
		};
		if (!dirty) { discard(); return; }
		modal.confirm({ title: tx("放弃未保存的模板修改？", "Discard unsaved template changes?"), okText: tx("放弃修改", "Discard changes"), cancelText: tx("继续编辑", "Keep editing"), onOk: discard });
	};
	const save = async () => {
		if (!editor) return;
		setBusy(true);
		try {
			const saved = await reportTemplateRequest<ReportTemplate>(editor.draft.id ? `/${encodeURIComponent(editor.draft.id)}` : "", {
				method: editor.draft.id ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(editor.draft),
			});
			try { sessionStorage.removeItem(draftKey(editor.draft.id)); } catch { /* Storage is optional. */ }
			setEditor({ original: saved, draft: saved }); setRevision((value) => value + 1); setError(null);
			void message.success(tx("模板已保存", "Template saved"));
		} catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
		finally { setBusy(false); }
	};
	const remove = (template: ReportTemplateSummary) => modal.confirm({
		title: tx("删除报告模板？", "Delete report template?"), content: tx(`删除「${template.name}」并取消引用它的项目默认设置。已有任务和报告保留所用模板。`, `Delete “${template.name}” and clear project defaults using it. Existing tasks and reports keep their saved copies.`),
		okText: tx("删除", "Delete"), cancelText: tx("取消", "Cancel"), okButtonProps: { danger: true },
		onOk: async () => {
			try {
				await reportTemplateRequest(`/${encodeURIComponent(template.id)}`, { method: "DELETE", headers: { "content-type": "application/json" } });
				setRevision((value) => value + 1);
			} catch (failure) { void message.error(failure instanceof Error ? failure.message : String(failure)); throw failure; }
		},
	});
	return <div className="report-center">
		{error ? <Alert type="error" showIcon title={error} action={!editor ? <Button onClick={() => setRevision((value) => value + 1)}>{tx("重试", "Retry")}</Button> : undefined} /> : null}
		{editor ? <>
			<Flex justify="space-between" align="center" gap={12} wrap>
				<Button disabled={busy} onClick={leave}>{tx("返回模板列表", "Back to templates")}</Button>
				<Space><Typography.Text type="secondary">{dirty ? tx("有未保存的修改", "Unsaved changes") : tx("已保存", "Saved")}</Typography.Text><Button type="primary" icon={<SaveOutlined />} loading={busy} disabled={!dirty || !editor.draft.name.trim() || !editor.draft.markdown.trim()} onClick={() => void save()}>{tx("保存模板", "Save template")}</Button></Space>
			</Flex>
			<div className="report-editor">
				<section className="report-editor__pane" aria-label={tx("编辑模板", "Edit template")}>
					<div className="report-editor__head"><Typography.Text strong>Markdown</Typography.Text></div>
					<div className="report-editor__fields">
						<label htmlFor="template-name">{tx("模板名称", "Template name")}</label><Input id="template-name" value={editor.draft.name} maxLength={120} disabled={busy} onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, name: event.target.value } })} />
						<label htmlFor="template-markdown">{tx("模板正文", "Template body")}</label><Input.TextArea id="template-markdown" className="report-editor__input" value={editor.draft.markdown} disabled={busy} spellCheck={false} placeholder={tx("写入报告章节、固定文字和填写说明。", "Write report sections, fixed text and writing instructions.")} onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, markdown: event.target.value } })} />
						<Typography.Text type="secondary" className="report-editor__hint">{tx("最多 64 KB。Agent 保留章节顺序，根据实际证据填写；HTML 注释可用作填写说明。", "Up to 64 KB. The agent preserves section order and uses actual evidence. HTML comments can contain writing instructions.")}</Typography.Text>
					</div>
				</section>
				<section className="report-editor__pane" aria-label={tx("模板实时预览", "Live template preview")}>
					<div className="report-editor__head"><Typography.Text strong>{tx("实时预览", "Live preview")}</Typography.Text><Typography.Text type="secondary">{tx("正文结构预览", "Document structure")}</Typography.Text></div>
					<div className="report-editor__preview report-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url, key) => key === "src" ? "" : defaultUrlTransform(url)} components={{ img: () => <span className="report-image-missing">{tx("图片在生成报告时提供", "Images are supplied when generating the report")}</span> }}>{markdown}</Markdown></div>
				</section>
			</div>
		</> : <>
			{projectId && data ? <Flex className="report-template-default" align="center" justify="space-between" gap={12} wrap>
				<div><Typography.Text strong>{tx("当前项目默认模板", "Default template for this project")}</Typography.Text><div><Typography.Text type="secondary">{tx("用于新启用报告的会话和新工程，可在开始前单独更换。", "Used for newly enabled conversations and new engines. Override it before starting.")}</Typography.Text></div></div>
				<ReportTemplateSelect key={projectId} projectId={projectId} value={data.defaultTemplateId} inherit={false} disabled={busy} refreshToken={revision + refreshToken} onChange={(id) => {
					setBusy(true);
					void reportTemplateRequest(`/default?projectId=${encodeURIComponent(projectId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ templateId: id ?? null }) })
						.then(() => { setRevision((value) => value + 1); void message.success(tx("项目默认模板已更新", "Project default updated")); })
						.catch((failure: unknown) => { void message.error(failure instanceof Error ? failure.message : String(failure)); })
						.finally(() => setBusy(false));
				}} />
			</Flex> : null}
			<Flex justify="space-between" align="center" gap={12} wrap><Input.Search aria-label={tx("搜索模板", "Search templates")} placeholder={tx("搜索模板名称", "Search template names")} allowClear style={{ width: 260 }} onChange={(event) => setSearch(event.target.value)} /><Space><Button icon={<ReloadOutlined />} aria-label={tx("刷新模板", "Refresh templates")} onClick={() => setRevision((value) => value + 1)} /><Button type="primary" icon={<PlusOutlined />} disabled={busy} onClick={() => void open()}>{tx("新建模板", "New template")}</Button></Space></Flex>
			<Table<ReportTemplateSummary> rowKey="id" loading={loading || busy} dataSource={data?.items.filter((item) => item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? []} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 600 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tx("暂无模板。新建模板统一报告结构；不选择模板时由 Agent 自由生成。", "No templates. Create one to define the report structure, or let the agent write freely.")} /> }} columns={[
				{ title: tx("模板名称", "Template name"), dataIndex: "name", render: (_, template) => <Button type="link" className="report-title-button" onClick={() => void open(template.id)}>{template.name}</Button> },
				{ title: tx("更新时间", "Updated"), dataIndex: "updatedAt", width: 200, render: (at: string) => new Date(at).toLocaleString() },
				{ title: tx("操作", "Actions"), width: 180, render: (_, template) => <Space><Button size="small" onClick={() => void open(template.id)}>{tx("编辑", "Edit")}</Button><Button size="small" icon={<CopyOutlined />} aria-label={tx("复制模板", "Copy template")} onClick={() => void open(template.id, true)} /><Button size="small" danger icon={<DeleteOutlined />} aria-label={tx("删除模板", "Delete template")} onClick={() => remove(template)} /></Space> },
			]} />
		</>}
	</div>;
}
