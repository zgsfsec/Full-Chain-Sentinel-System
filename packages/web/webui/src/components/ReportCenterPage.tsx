import { ArrowLeftOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { Alert, App, Button, Empty, Flex, Image, Input, Segmented, Select, Skeleton, Space, Tag, Typography } from "antd";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReportDetail, ReportPage, ReportSource, ReportSummary } from "../../../src/report-types.ts";
import { getLanguage } from "../i18n.ts";
import { Page } from "../ui/Page.tsx";
import "./ReportCenterPage.css";

const tx = (zh: string, en: string) => getLanguage() === "en" ? en : zh;
const sourceLabels: Record<ReportSource, string> = {
	session: tx("普通会话", "Conversation"), goal: tx("自主目标", "Autonomous goal"), engine: tx("工程", "Engineering"),
};

function reportUrl(projectId: string, id?: string, suffix = ""): string {
	return `/api/reports${id ? `/${encodeURIComponent(id)}${suffix}` : ""}?projectId=${encodeURIComponent(projectId)}`;
}

async function reportResponse(url: string, options?: RequestInit): Promise<Response> {
	const response = await fetch(url, options);
	if (!response.ok) {
		const body = await response.json().catch(() => null) as { error?: string } | null;
		throw new Error(body?.error ?? tx(`请求失败（${response.status}）`, `Request failed (${response.status})`));
	}
	return response;
}

/** Image URLs come exclusively from the immutable archive, never from document-supplied servers. */
export function ReportMarkdown({ report }: { report: ReportDetail }) {
	const images = new Map(report.images.map((image) => [image.source, reportUrl(report.projectId, report.id, `/images/${encodeURIComponent(image.id)}`)]));
	return <div className="report-markdown">
		<Markdown remarkPlugins={[remarkGfm]} skipHtml
			urlTransform={(url, key) => key === "src" ? images.get(url) ?? "" : defaultUrlTransform(url)}
			components={{
				p: ({ children }) => <div className="report-paragraph">{children}</div>,
				a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
				img: ({ src, alt }) => typeof src === "string" && src ? <Image src={src} alt={alt ?? ""} loading="lazy" /> : <span className="report-image-missing">{tx("图片未归档", "Image unavailable")}{alt ? ` · ${alt}` : ""}</span>,
				table: ({ children }) => <div className="report-markdown__table"><table>{children}</table></div>,
			}}>{report.markdown}</Markdown>
	</div>;
}

export function ReportCenterPage({ projectId, refreshToken = 0 }: {
	projectId: string | null; refreshToken?: number;
}) {
	return <Page title={tx("报告中心", "Reports")}
		description={tx("按当前项目归档任务报告与证据图片，容器停止后仍可查阅。", "Task reports and evidence for the current project, retained after containers stop.")}>
		{projectId ? <ProjectReports key={projectId} projectId={projectId} refreshToken={refreshToken} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tx("请先在全局选择项目，再查看报告。", "Select a project in the global navigation to view reports.")} />}
	</Page>;
}

function ProjectReports({ projectId, refreshToken }: { projectId: string; refreshToken: number }) {
	const { modal, message } = App.useApp();
	const [search, setSearch] = useState("");
	const [source, setSource] = useState<ReportSource | undefined>();
	const [page, setPage] = useState(1);
	const [revision, setRevision] = useState(0);
	const [data, setData] = useState<ReportPage | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [openId, setOpenId] = useState<string | null>(null);
	const [downloading, setDownloading] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		let inFlight = false;
		const load = async (background = false) => {
			if (inFlight) return;
			inFlight = true;
			if (!background) setLoading(true);
			try {
				const url = `${reportUrl(projectId)}&page=${page}&search=${encodeURIComponent(search)}${source ? `&source=${source}` : ""}`;
				const response = await reportResponse(url, { signal: controller.signal });
				const next = await response.json() as ReportPage;
				if (controller.signal.aborted) return;
				setData(next);
				setError(null);
				if (next.page !== page) setPage(next.page);
			} catch (failure) {
				if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
			} finally {
				inFlight = false;
				if (!controller.signal.aborted) setLoading(false);
			}
		};
		void load();
		const timer = window.setInterval(() => { if (!document.hidden) void load(true); }, 15000);
		return () => { controller.abort(); window.clearInterval(timer); };
	}, [projectId, page, search, source, revision, refreshToken]);

	const download = async (report: ReportSummary) => {
		setDownloading(report.id);
		try {
			const response = await reportResponse(reportUrl(projectId, report.id, "/download"));
			const url = URL.createObjectURL(await response.blob());
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `${report.title.replace(/[\\/:*?"<>|]/g, "_")}.${report.imageCount ? "zip" : "md"}`;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (failure) { void message.error(failure instanceof Error ? failure.message : String(failure)); }
		finally { setDownloading(null); }
	};

	const remove = (report: ReportSummary) => modal.confirm({
		title: tx("删除报告？", "Delete report?"),
		content: tx(`将永久删除「${report.title}」及其归档图片。`, `Permanently delete “${report.title}” and its archived images.`),
		okText: tx("删除", "Delete"), cancelText: tx("取消", "Cancel"), okButtonProps: { danger: true },
		onOk: async () => {
			try {
				await reportResponse(reportUrl(projectId, report.id), { method: "DELETE", headers: { "content-type": "application/json" } });
				setOpenId((id) => id === report.id ? null : id);
				setRevision((value) => value + 1);
				void message.success(tx("报告已删除", "Report deleted"));
			} catch (failure) {
				void message.error(failure instanceof Error ? failure.message : String(failure));
				throw failure;
			}
		},
	});

	const columns: ProColumns<ReportSummary>[] = [
		{ title: tx("报告标题", "Title"), dataIndex: "title", ellipsis: true, render: (_, report) => <Button type="link" className="report-title-button" onClick={() => setOpenId(report.id)}>{report.title}</Button> },
		{ title: tx("来源", "Source"), dataIndex: "source", width: 110, render: (_, report) => <Tag>{sourceLabels[report.source]}</Tag> },
		{ title: tx("关联会话 / 工程", "Conversation / engine"), width: 220, ellipsis: true, render: (_, report) => report.taskName ?? report.engineName ?? report.sessionName ?? report.sessionId ?? "—" },
		{ title: tx("图片", "Images"), dataIndex: "imageCount", width: 70, align: "right" },
		{ title: tx("提交时间", "Submitted"), dataIndex: "createdAt", width: 175, render: (_, report) => new Date(report.createdAt).toLocaleString(getLanguage() === "en" ? "en-US" : "zh-CN", { hour12: false }) },
		{ title: tx("操作", "Actions"), valueType: "option", width: 150, fixed: "right", render: (_, report) => <Space size={4}>
			<Button type="link" size="small" onClick={() => setOpenId(report.id)}>{tx("查看", "View")}</Button>
			<Button type="text" size="small" icon={<DownloadOutlined />} aria-label={tx("下载报告", "Download report")} loading={downloading === report.id} disabled={downloading !== null} onClick={() => void download(report)} />
			<Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={tx("删除报告", "Delete report")} onClick={() => remove(report)} />
		</Space> },
	];
	return <div className="report-center">
		{error ? <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => setRevision((value) => value + 1)}>{tx("重试", "Retry")}</Button>} /> : null}
		{openId ? <ReportReader key={openId} projectId={projectId} id={openId} refreshToken={refreshToken} onBack={() => setOpenId(null)} onSaved={() => setRevision((value) => value + 1)} onDownload={download} onDelete={remove} downloading={downloading === openId} /> : <ProTable<ReportSummary>
			rowKey="id" columns={columns} dataSource={data?.items ?? []} loading={loading} search={false} options={false}
			cardBordered headerTitle={`${tx("项目报告", "Project reports")} · ${data?.total ?? 0}`} scroll={{ x: 1050 }}
			toolBarRender={() => [
				<Input.Search key="search" allowClear aria-label={tx("搜索报告", "Search reports")} placeholder={tx("搜索标题、会话或工程", "Search titles, conversations or engines")} onSearch={(value) => { setSearch(value.trim()); setPage(1); }} style={{ width: 260 }} />,
				<Select key="source" aria-label={tx("报告来源", "Report source")} allowClear placeholder={tx("全部来源", "All sources")} value={source} style={{ width: 130 }} onChange={(value: ReportSource | undefined) => { setSource(value); setPage(1); }} options={Object.entries(sourceLabels).map(([value, label]) => ({ value, label }))} />,
				<Button key="refresh" icon={<ReloadOutlined />} aria-label={tx("刷新报告", "Refresh reports")} onClick={() => setRevision((value) => value + 1)} />,
			]}
			pagination={{ current: data?.page ?? page, pageSize: 20, total: data?.total ?? 0, showSizeChanger: false, onChange: setPage, showTotal: (total) => tx(`共 ${total} 份`, `${total} reports`) }}
			locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={search || source ? tx("没有符合条件的报告", "No matching reports") : tx("暂无报告。Agent 完成实质任务后会主动提交，普通问答不生成报告。", "No reports yet. Agents submit reports after substantive tasks; ordinary questions do not generate reports.")} /> }}
		/>}
	</div>;
}

export function ReportEditor({ report, onTitleChange, onMarkdownChange, disabled = false }: {
	report: ReportDetail; onTitleChange: (value: string) => void; onMarkdownChange: (value: string) => void; disabled?: boolean;
}) {
	const markdown = useDeferredValue(report.markdown);
	return <div className="report-editor">
		<section className="report-editor__pane" aria-label={tx("编辑报告", "Edit report")}>
			<div className="report-editor__head"><Typography.Text strong>Markdown</Typography.Text><Typography.Text type="secondary">{tx("修改后点击保存", "Save to apply changes")}</Typography.Text></div>
			<div className="report-editor__fields">
				<label htmlFor="report-edit-title">{tx("报告标题", "Report title")}</label>
				<Input id="report-edit-title" value={report.title} maxLength={120} disabled={disabled} onChange={(event) => onTitleChange(event.target.value)} />
				<label htmlFor="report-edit-markdown">{tx("报告正文", "Markdown body")}</label>
				<Input.TextArea id="report-edit-markdown" className="report-editor__input" value={report.markdown} disabled={disabled} spellCheck={false} onChange={(event) => onMarkdownChange(event.target.value)} />
				<Typography.Text type="secondary" className="report-editor__hint">{tx("支持 Markdown 表格和已有归档图片，请保留图片路径。", "Supports Markdown tables and archived images. Keep existing image paths.")}</Typography.Text>
			</div>
		</section>
		<section className="report-editor__pane" aria-label={tx("报告实时预览", "Live report preview")}>
			<div className="report-editor__head"><Typography.Text strong>{tx("实时预览", "Live preview")}</Typography.Text></div>
			<div className="report-editor__preview"><h1>{report.title || tx("未命名报告", "Untitled report")}</h1><ReportMarkdown report={{ ...report, markdown }} /></div>
		</section>
	</div>;
}

function ReportReader({ projectId, id, refreshToken, onBack, onSaved, onDownload, onDelete, downloading }: {
	projectId: string; id: string; refreshToken: number; onBack: () => void; onSaved: () => void;
	onDownload: (report: ReportSummary) => Promise<void>; onDelete: (report: ReportSummary) => void; downloading: boolean;
}) {
	const { modal, message } = App.useApp();
	const [report, setReport] = useState<ReportDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [mode, setMode] = useState("preview");
	const [draft, setDraft] = useState<ReportDetail | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const restored = useRef(false);
	const draftKey = `sentinel-report-draft:${projectId}:${id}`;
	const editing = draft !== null;
	const dirty = draft !== null && (draft.title !== report?.title || draft.markdown !== report?.markdown);
	useEffect(() => {
		if (editing) return;
		const controller = new AbortController();
		void reportResponse(reportUrl(projectId, id), { signal: controller.signal })
			.then(async (response) => {
				const next = await response.json() as ReportDetail;
				if (controller.signal.aborted) return;
				setReport(next);
				setError(null);
				if (restored.current) return;
				restored.current = true;
				try {
					const saved: unknown = JSON.parse(sessionStorage.getItem(draftKey) ?? "null");
					if (saved && typeof saved === "object" && "title" in saved && typeof saved.title === "string" &&
						"markdown" in saved && typeof saved.markdown === "string" && "revision" in saved && typeof saved.revision === "string") {
						setDraft({ ...next, title: saved.title, markdown: saved.markdown, revision: saved.revision });
						void message.info(tx("已恢复未保存的草稿", "Unsaved draft restored"));
					}
				} catch { /* Draft recovery is optional when browser storage is unavailable. */ }
			})
			.catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
		return () => controller.abort();
	}, [projectId, id, refreshToken, editing, draftKey, message]);
	useEffect(() => {
		if (!draft) return;
		if (!dirty) {
			try { sessionStorage.removeItem(draftKey); } catch { /* Storage may be disabled. */ }
			return;
		}
		try { sessionStorage.setItem(draftKey, JSON.stringify({ title: draft.title, markdown: draft.markdown, revision: draft.revision })); }
		catch { /* The in-memory draft remains editable if storage is full or disabled. */ }
	}, [draft, dirty, draftKey]);
	useEffect(() => {
		if (!dirty) return;
		const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);
	const leave = (action: () => void) => {
		const discard = () => {
			try { sessionStorage.removeItem(draftKey); } catch { /* Storage may be disabled. */ }
			action();
		};
		if (!dirty) { discard(); return; }
		modal.confirm({ title: tx("放弃未保存的修改？", "Discard unsaved changes?"), content: tx("当前修改尚未保存，放弃后将恢复已保存的报告。", "Your changes have not been saved. Discarding restores the saved report."), okText: tx("放弃修改", "Discard changes"), cancelText: tx("继续编辑", "Keep editing"), onOk: discard });
	};
	const save = async () => {
		if (!draft) return;
		setSaving(true);
		setSaveError(null);
		try {
			const response = await reportResponse(reportUrl(projectId, id), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: draft.title, markdown: draft.markdown, revision: draft.revision }) });
			setReport(await response.json() as ReportDetail);
			try { sessionStorage.removeItem(draftKey); } catch { /* Storage may be disabled. */ }
			setDraft(null);
			setMode("preview");
			onSaved();
			void message.success(tx("报告已保存", "Report saved"));
		} catch (failure) { setSaveError(failure instanceof Error ? failure.message : String(failure)); }
		finally { setSaving(false); }
	};
	return <section className="report-reader">
		<Flex justify="space-between" align="center" gap={12} wrap className="report-reader__toolbar">
			<Button icon={<ArrowLeftOutlined />} disabled={saving} onClick={() => leave(onBack)}>{tx("返回列表", "Back to reports")}</Button>
			{report && !error ? editing ? <Space wrap>
				<Typography.Text type="secondary">{dirty ? tx("有未保存的修改", "Unsaved changes") : tx("编辑模式", "Editing")}</Typography.Text>
				<Button disabled={saving} onClick={() => leave(() => { setDraft(null); setSaveError(null); })}>{tx("取消编辑", "Cancel editing")}</Button>
				<Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!dirty || !draft.title.trim() || !draft.markdown.trim()} onClick={() => void save()}>{tx("保存修改", "Save changes")}</Button>
			</Space> : <Space wrap>
				<Segmented value={mode} onChange={setMode} options={[{ label: tx("预览", "Preview"), value: "preview" }, { label: tx("源文", "Markdown"), value: "source" }]} />
				<Button icon={<EditOutlined />} onClick={() => { setDraft(report); setSaveError(null); }}>{tx("编辑", "Edit")}</Button>
				<Button icon={<DownloadOutlined />} loading={downloading} onClick={() => void onDownload(report)}>{tx(report.imageCount ? "下载报告和图片" : "下载 Markdown", report.imageCount ? "Download report & images" : "Download Markdown")}</Button>
				<Button danger icon={<DeleteOutlined />} onClick={() => onDelete(report)}>{tx("删除", "Delete")}</Button>
			</Space> : null}
		</Flex>
		{saveError ? <Alert className="report-editor__error" type="error" showIcon title={saveError} /> : null}
		{draft ? <ReportEditor report={draft} disabled={saving} onTitleChange={(title) => setDraft((current) => current ? { ...current, title } : null)} onMarkdownChange={(markdown) => setDraft((current) => current ? { ...current, markdown } : null)} /> : error ? <Alert type="error" showIcon title={error} /> : report ? <article className="report-document">
			<header className="report-document__head">
				<h1>{report.title}</h1>
				<Space wrap size={[12, 8]}><Tag>{sourceLabels[report.source]}</Tag><Typography.Text type="secondary">{report.engineName ?? report.taskName ?? report.sessionName ?? report.sessionId ?? "—"}</Typography.Text><Typography.Text type="secondary">{new Date(report.createdAt).toLocaleString()}</Typography.Text><Typography.Text type="secondary">{tx(`${report.imageCount} 张图片`, `${report.imageCount} images`)}</Typography.Text></Space>
			</header>
			{mode === "source" ? <pre className="report-source">{report.markdown}</pre> : <ReportMarkdown report={report} />}
		</article> : <Skeleton active paragraph={{ rows: 10 }} />}
	</section>;
}
