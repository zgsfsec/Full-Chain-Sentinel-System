import { DeleteOutlined, ImportOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Alert, App, AutoComplete, Button, Checkbox, Drawer, Dropdown, Empty, Flex, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Timeline, Tooltip, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { CREDENTIAL_GROUPS, CREDENTIAL_TYPES, type CredentialInput, type CredentialStatus, type CredentialView, failedCredential } from "../../../src/credential-types.ts";
import { getLanguage } from "../i18n.ts";
import { Page } from "../ui/Page.tsx";
import "./CredentialsPage.css";

const tx = (zh: string, en: string) => getLanguage() === "en" ? en : zh;
const AI_ENTRY_HINT = "建议在「对话」中勾选「凭据中心」，粘贴凭据或上传文件，让 AI 识别类型、整理字段并批量录入，也可继续使用下方表单。";
const defaults: CredentialInput = { name: "", group: "操作系统", type: "Linux", host: "", port: null, username: "", password: "", privateKey: "", passphrase: "", token: "", database: "", instance: "", domain: "", manufacturer: "", model: "", notes: "", fields: [] };
const statusLabels: Record<CredentialStatus, string> = { unverified: "未验证", usable: "可用", failed: "验证失败" };
type Preview = CredentialView & { operation: string };
type VerificationRef = { id: string; revision: string };
interface PageProps { projectId: string | null; refreshToken?: number; verificationDisabledReason?: string | null; onVerify: (refs: VerificationRef[]) => void }

async function credentialRequest<T>(projectId: string, action: string, signal: AbortSignal, body?: unknown): Promise<T> {
	const response = await fetch(`/api/credentials${action}?projectId=${encodeURIComponent(projectId)}`, { signal, ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
	const result = await response.json() as T & { error?: string };
	if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
	return result;
}
function downloadTemplate(format: "csv" | "json") {
	const example: CredentialInput = { ...defaults, name: "业务数据库", group: "数据库", type: "PostgreSQL", host: "192.0.2.10", port: 5432, username: "operator", password: "replace-me", database: "app", fields: [{ key: "sslmode", value: "require", sensitive: false }] };
	const text = format === "json" ? JSON.stringify([example], null, 2) : `${Object.keys(example).join(",")}\r\n${Object.values(example).map((value) => `"${String(Array.isArray(value) ? JSON.stringify(value) : value ?? "").replaceAll('"', '""')}"`).join(",")}\r\n`;
	const url = URL.createObjectURL(new Blob([`\uFEFF${text}`], { type: "text/plain;charset=utf-8" }));
	const anchor = document.createElement("a"); anchor.href = url; anchor.download = `credentials-template.${format}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function CredentialsPage(props: PageProps) {
	return props.projectId ? <ProjectCredentials key={props.projectId} {...props} projectId={props.projectId} /> : <Page title={tx("凭据中心", "Credentials")}><Empty description={tx("请先选择项目", "Select a project first")} /></Page>;
}
function ProjectCredentials({ projectId, refreshToken = 0, verificationDisabledReason, onVerify }: PageProps & { projectId: string }) {
	const { message, modal } = App.useApp();
	const [items, setItems] = useState<CredentialView[]>([]);
	const [selected, setSelected] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [revision, setRevision] = useState(0);
	const [error, setError] = useState("");
	const [search, setSearch] = useState("");
	const [group, setGroup] = useState<string>();
	const [status, setStatus] = useState<string>();
	const [editor, setEditor] = useState<CredentialView | "new" | null>(null);
	const [audit, setAudit] = useState<CredentialView | null>(null);
	const [saving, setSaving] = useState(false);
	const [form] = Form.useForm<CredentialInput>();
	const formGroup = Form.useWatch("group", form);
	const [importOpen, setImportOpen] = useState(false);
	const [format, setFormat] = useState<"csv" | "json">("csv");
	const [content, setContent] = useState("");
	const [preview, setPreview] = useState<{ items: Preview[]; version: string } | null>(null);
	const [importBusy, setImportBusy] = useState(false);
	const [importError, setImportError] = useState("");
	const life = useRef(new AbortController());
	useEffect(() => { life.current = new AbortController(); return () => life.current.abort(); }, []);
	useEffect(() => {
		const controller = new AbortController(); let pending = false;
		const load = async () => {
			if (pending) return; pending = true;
			try {
				const result = await credentialRequest<{ items: CredentialView[] }>(projectId, "", controller.signal);
				if (!controller.signal.aborted) { setItems(result.items); setSelected((ids) => ids.filter((id) => result.items.some((item) => item.id === id))); setError(""); }
			} catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取失败"); }
			finally { pending = false; if (!controller.signal.aborted) setLoading(false); }
		};
		void load(); const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 5000);
		return () => { controller.abort(); window.clearInterval(timer); };
	}, [projectId, revision, refreshToken]);
	const refresh = () => setRevision((value) => value + 1);
	const failure = (cause: unknown) => { if (!life.current.signal.aborted) void message.error(cause instanceof Error ? cause.message : "操作失败"); };
	const mutate = async (action: string, body: unknown) => { await credentialRequest(projectId, action, life.current.signal, body); if (!life.current.signal.aborted) refresh(); };
	const openEditor = (record?: CredentialView) => {
		setEditor(record ?? "new"); form.resetFields();
		if (record) {
			const { id: _id, projectId: _projectId, revision: _revision, status: _status, validations: _validations, updatedAt: _updatedAt, hasPassword: _password, hasPrivateKey: _key, hasPassphrase: _phrase, hasToken: _token, ...input } = record;
			form.setFieldsValue({ ...defaults, ...input, password: "", privateKey: "", passphrase: "", token: "" });
		} else form.setFieldsValue(defaults);
	};
	const remove = (ids: string[]) => modal.confirm({ title: `删除 ${ids.length} 条凭据？`, content: "凭据及其验证记录将永久删除。", okText: "删除", okButtonProps: { danger: true }, onOk: () => mutate("/delete", { ids }).catch((cause) => { failure(cause); throw cause; }) });
	const refsFor = (ids: string[]) => items.filter((item) => ids.includes(item.id)).map(({ id, revision }) => ({ id, revision }));
	const confirmUsable = (ids: string[]) => modal.confirm({ title: `将 ${ids.length} 条凭据标记为可用？`, content: "这会记录为“用户确认”，启用凭据中心的当前项目 Agent 可按需读取并使用这些凭据。", okText: "确认可用", onOk: () => mutate("/confirm", { refs: refsFor(ids) }).catch((cause) => { failure(cause); throw cause; }) });
	const verify = (ids: string[]) => modal.confirm({ title: `交给 Agent 验证 ${ids.length} 条凭据？`, content: "将在当前项目新建独立对话，自动启用凭据中心并发送验证任务。原对话继续保留，实际操作沿用审批设置。", okText: "开始验证", onOk: () => onVerify(refsFor(ids)) });
	const failed = items.filter(failedCredential);
	const visible = items.filter((item) => (!group || item.group === group) && (!status || item.status === status) && `${item.name} ${item.type} ${item.host} ${item.username} ${item.database} ${item.instance}`.toLowerCase().includes(search.toLowerCase()));
	return <Page className="credentials-page" title={tx("凭据中心", "Credentials")} description={tx("按项目管理各类凭据，由用户确认或交给 Agent 验证后使用。", "Project-scoped credentials, confirmed by you or verified by your Agent.")}
		extra={<><Button icon={<ReloadOutlined />} onClick={refresh}>{tx("刷新", "Refresh")}</Button><Button icon={<ImportOutlined />} onClick={() => { setImportOpen(true); setPreview(null); setImportError(""); }}>{tx("批量导入", "Import")}</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>{tx("添加凭据", "Add credential")}</Button></>}>
		<div className="credentials-body">
			{error && <Alert type="error" title={error} showIcon />}
			<Flex className="credentials-summary" gap={24} wrap><span>项目凭据 <b>{items.length}</b></span><span>可用 <b>{items.filter((item) => item.status === "usable").length}</b></span><span>未验证 <b>{items.filter((item) => item.status === "unverified").length}</b></span><span>验证失败 <b>{failed.length}</b></span><Typography.Text type="secondary">加密保存 · 按需读取</Typography.Text></Flex>
			<Flex gap={8} wrap align="center" className="credentials-toolbar">
				<Input.Search aria-label="搜索凭据" placeholder="搜索名称、目标、类型或账号" value={search} onChange={(event) => setSearch(event.target.value)} allowClear style={{ width: 260 }} />
				<Select aria-label="筛选分组" placeholder="全部分组" value={group} onChange={setGroup} allowClear style={{ width: 160 }} options={CREDENTIAL_GROUPS.map((value) => ({ value, label: value }))} />
				<Select aria-label="筛选状态" placeholder="全部状态" value={status} onChange={setStatus} allowClear style={{ width: 130 }} options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))} />
				<span className="credentials-toolbar__spacer" />
				<Button icon={<SafetyCertificateOutlined />} disabled={!selected.length || Boolean(verificationDisabledReason)} title={verificationDisabledReason ?? "新建对话验证所选凭据"} onClick={() => verify(selected)}>交给 Agent 验证{selected.length ? ` (${selected.length})` : ""}</Button>
				<Dropdown menu={{ items: [{ key: "confirm", label: "标记选中为可用", disabled: !selected.length }, { key: "delete", label: "删除选中", disabled: !selected.length, danger: true }, { key: "failed", label: `清理验证失败 (${failed.length})`, disabled: !failed.length, danger: true }], onClick: ({ key }) => {
					if (key === "confirm") confirmUsable(selected);
					else if (key === "delete") remove(selected);
					else modal.confirm({ title: `删除全部 ${failed.length} 条验证失败记录？`, content: "仅删除当前项目当前状态为验证失败的凭据。", okText: "删除失败记录", okButtonProps: { danger: true }, onOk: () => mutate("/delete-failed", { confirm: failed.map((item) => `${item.id}:${item.revision}:${item.updatedAt}`) }).catch((cause) => { failure(cause); throw cause; }) });
				} }}><Button>批量操作</Button></Dropdown>
			</Flex>
			<Table<CredentialView> className="credentials-table" rowKey="id" size="small" tableLayout="fixed" loading={loading} dataSource={visible} rowSelection={{ columnWidth: 40, selectedRowKeys: selected, onChange: (keys) => setSelected(keys.map(String)) }} scroll={{ x: 1200 }} pagination={{ defaultPageSize: 20, showSizeChanger: true, showTotal: (count) => `共 ${count} 条` }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={items.length ? "没有符合条件的凭据" : "添加凭据，或从 CSV / JSON 批量导入"} /> }} columns={[
				{ title: "名称", dataIndex: "name", width: 180, ellipsis: true },
				{ title: "目标", key: "target", width: 240, ellipsis: true, render: (_, item) => <span className="table-mono" title={`${item.host}${item.port ? `:${item.port}` : ""}`}>{item.host}{item.port ? `:${item.port}` : ""}</span> },
				{ title: "类型", key: "type", width: 140, ellipsis: true, render: (_, item) => <Tooltip title={`${item.group} / ${item.type}`}><Tag className="credentials-type">{item.type}</Tag></Tooltip> },
				{ title: "账号", dataIndex: "username", width: 140, ellipsis: true, render: (value: string) => value || "—" },
				{ title: "数据库 / 实例", key: "database", width: 180, ellipsis: true, render: (_, item) => <span title={[item.database, item.instance].filter(Boolean).join(" / ")}>{[item.database, item.instance].filter(Boolean).join(" / ") || "—"}</span> },
				{ title: "状态", key: "status", width: 110, render: (_, item) => <Tooltip title={item.status === "unverified" ? "等待用户确认或 Agent 验证" : item.validations.at(-1)?.source === "user" ? "用户确认" : "Agent 验证"}><Tag color={item.status === "usable" ? "success" : item.status === "failed" ? "error" : "default"}>{statusLabels[item.status]}</Tag></Tooltip> },
				{ title: "操作", key: "actions", width: 160, fixed: "right", align: "right", render: (_, item) => <Space size={0} wrap={false}><Button type="link" size="small" onClick={() => openEditor(item)}>编辑</Button><Button type="link" size="small" disabled={Boolean(verificationDisabledReason)} title={verificationDisabledReason ?? undefined} onClick={() => verify([item.id])}>验证</Button><Dropdown menu={{ items: [{ key: "confirm", label: "标记为可用" }, { key: "audit", label: "验证记录" }, { key: "delete", label: "删除", danger: true }], onClick: ({ key }) => { if (key === "confirm") confirmUsable([item.id]); else if (key === "audit") setAudit(item); else remove([item.id]); } }}><Button type="text" size="small" aria-label="更多操作">···</Button></Dropdown></Space> },
			]} />
		</div>
		<Modal title={editor === "new" ? "添加凭据" : "编辑凭据"} open={Boolean(editor)} width={760} styles={{ body: { maxHeight: "70vh", overflowY: "auto", paddingRight: 4 } }} confirmLoading={saving} forceRender onCancel={() => { setEditor(null); form.resetFields(); }} okText="保存" onOk={async () => {
			let input: CredentialInput; try { input = await form.validateFields(); } catch { return; }
			setSaving(true);
			try { await mutate("/save", { ...(editor && editor !== "new" ? { id: editor.id, revision: editor.revision } : {}), input: { ...defaults, ...input } }); setEditor(null); form.resetFields(); }
			catch (cause) { failure(cause); } finally { setSaving(false); }
		}}>
			{editor === "new" && <Alert className="credentials-ai-hint" type="info" showIcon title={AI_ENTRY_HINT} />}
			<Form form={form} layout="vertical" initialValues={defaults} preserve={false}>
				<Form.Item name="name" label="名称"><Input placeholder="例如：生产只读账号" maxLength={128} /></Form.Item>
				<div className="credentials-form-grid"><Form.Item name="group" label="分组"><Select options={CREDENTIAL_GROUPS.map((value) => ({ value, label: value }))} onChange={() => form.setFieldValue("type", "")} /></Form.Item><Form.Item name="type" label="类型" rules={[{ required: true, message: "请选择或填写类型" }]}><AutoComplete options={CREDENTIAL_TYPES.filter((entry) => entry.group === formGroup).map(({ value }) => ({ value }))} filterOption={(input, option) => String(option?.value).toLowerCase().includes(input.toLowerCase())} placeholder="选择常见类型，或输入自定义类型" /></Form.Item></div>
				<div className="credentials-form-grid"><Form.Item name="host" label="目标地址" rules={[{ required: true, message: "请输入目标地址" }]}><Input placeholder="IP、域名或服务地址" /></Form.Item><Form.Item name="port" label="端口"><InputNumber min={1} max={65535} style={{ width: "100%" }} /></Form.Item></div>
				<div className="credentials-form-grid"><Form.Item name="username" label="用户名 / 账号"><Input autoComplete="off" /></Form.Item><Form.Item name="domain" label="域"><Input /></Form.Item><Form.Item name="database" label="数据库名"><Input /></Form.Item><Form.Item name="instance" label="实例名"><Input /></Form.Item><Form.Item name="manufacturer" label="厂商"><Input /></Form.Item><Form.Item name="model" label="型号"><Input /></Form.Item></div>
				<Typography.Paragraph type="secondary">按需填写认证信息。编辑时，空白敏感字段保留原值；修改目标、账号或认证信息后需重新验证。</Typography.Paragraph>
				<div className="credentials-form-grid"><Form.Item name="password" label="密码"><Input.Password autoComplete="new-password" placeholder={editor !== "new" ? "留空保留原值" : "可选"} /></Form.Item><Form.Item name="token" label="Token / API Key"><Input.Password autoComplete="new-password" placeholder={editor !== "new" ? "留空保留原值" : "可选"} /></Form.Item></div>
				<Form.Item name="privateKey" label="私钥"><Input.TextArea autoComplete="off" rows={3} placeholder={editor !== "new" ? "留空保留原值" : "粘贴私钥全文（可选）"} /></Form.Item>
				<Form.Item name="passphrase" label="私钥口令"><Input.Password autoComplete="new-password" /></Form.Item>
				<Form.List name="fields">{(fields, { add, remove: removeField }) => <div className="credentials-fields"><Typography.Text strong>自定义字段</Typography.Text>{fields.map(({ key, name, ...rest }) => <div key={key} className="credentials-field"><Form.Item {...rest} name={[name, "key"]} rules={[{ required: true, message: "填写字段名" }]}><Input placeholder="字段名" /></Form.Item><Form.Item {...rest} name={[name, "value"]}><Input.Password autoComplete="new-password" placeholder="字段值；敏感字段留空保留原值" /></Form.Item><Form.Item {...rest} name={[name, "sensitive"]} valuePropName="checked"><Checkbox>敏感</Checkbox></Form.Item><Button type="text" danger icon={<DeleteOutlined />} aria-label="删除字段" onClick={() => removeField(name)} /></div>)}<Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ key: "", value: "", sensitive: true })}>添加字段</Button></div>}</Form.List>
				<Form.Item name="notes" label="备注"><Input.TextArea rows={3} maxLength={4096} placeholder="请勿在备注中填写密码或业务数据" /></Form.Item>
			</Form>
		</Modal>
		<Modal className="credentials-import" title="批量导入凭据" open={importOpen} width={900} closable={!importBusy} mask={{ closable: !importBusy }} destroyOnHidden onCancel={() => { setImportOpen(false); setContent(""); setPreview(null); }} footer={<Space><Button disabled={importBusy} onClick={() => { setImportOpen(false); setContent(""); setPreview(null); }}>取消</Button>{preview ? <Button type="primary" loading={importBusy} onClick={async () => { setImportBusy(true); try { await mutate("/import/apply", { format, content, version: preview.version }); setContent(""); setPreview(null); setImportOpen(false); void message.success("导入完成"); } catch (cause) { setImportError(cause instanceof Error ? cause.message : "导入失败"); setPreview(null); } finally { setImportBusy(false); } }}>确认导入 {preview.items.length} 条</Button> : <Button type="primary" loading={importBusy} disabled={!content.trim()} onClick={async () => { setImportBusy(true); setImportError(""); try { setPreview(await credentialRequest<{ items: Preview[]; version: string }>(projectId, "/import/preview", life.current.signal, { format, content })); } catch (cause) { setImportError(cause instanceof Error ? cause.message : "预览失败"); } finally { setImportBusy(false); } }}>校验并预览</Button>}</Space>}>
			<Alert className="credentials-ai-hint" type="info" showIcon title={AI_ENTRY_HINT} />
			<Alert type="info" showIcon title="按类型 + 目标地址 + 端口 + 用户名 + 数据库名 / 实例名匹配更新。空白敏感字段保留原值；整批校验通过才会保存。" />
			<Flex gap={8} wrap className="credentials-import__tools"><Select disabled={importBusy} value={format} onChange={(value) => { setFormat(value); setPreview(null); }} options={[{ value: "csv", label: "CSV" }, { value: "json", label: "JSON" }]} /><Button onClick={() => downloadTemplate(format)}>下载模板</Button><label className="credentials-upload">选择文件<input disabled={importBusy} type="file" accept=".csv,.json" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; if (file.size > 2 * 1024 * 1024) { setImportError("文件最大 2 MB"); return; } try { setContent(await file.text()); setFormat(file.name.toLowerCase().endsWith(".json") ? "json" : "csv"); setPreview(null); setImportError(""); } catch (cause) { failure(cause); } }} /></label>{preview && <Button disabled={importBusy} onClick={() => setPreview(null)}>返回编辑</Button>}</Flex>
			{importError && <Alert type="error" showIcon title={importError} />}
			{preview ? <Table<Preview> className="credentials-table" rowKey="id" size="small" tableLayout="fixed" dataSource={preview.items} scroll={{ x: 800 }} pagination={{ pageSize: 10 }} columns={[{ title: "操作", dataIndex: "operation", width: 80, render: (value: string) => <Tag color={value === "新增" ? "green" : "blue"}>{value}</Tag> }, { title: "名称", dataIndex: "name", ellipsis: true }, { title: "类型", dataIndex: "type", ellipsis: true }, { title: "目标", dataIndex: "host", ellipsis: true }, { title: "账号", dataIndex: "username", ellipsis: true }, { title: "数据库", dataIndex: "database", ellipsis: true }, { title: "实例", dataIndex: "instance", ellipsis: true }]} /> : <Input.TextArea aria-label="导入内容" rows={12} value={content} disabled={importBusy} onChange={(event) => { setContent(event.target.value); setPreview(null); }} placeholder="粘贴 CSV / JSON，或选择文件" spellCheck={false} />}
			<Typography.Paragraph type="secondary" className="credentials-import__hint">每批 1–1000 条，最多 2 MB。JSON 使用对象数组；CSV 自定义 fields 列填写 JSON 数组。导入不会自动验证。</Typography.Paragraph>
		</Modal>
		<Drawer title={`验证记录 · ${audit?.name ?? ""}`} open={Boolean(audit)} size={560} onClose={() => setAudit(null)} destroyOnHidden>
			<Alert type="info" showIcon title="记录验证方式和简短结论，不保存原始请求响应或命令输出。Agent 验证结果由 Agent 上报。" />
			{audit?.validations.length ? <Timeline className="credentials-audit" items={[...audit.validations].reverse().map((entry) => ({ color: entry.status === "usable" ? "green" : "red", content: <><Typography.Text strong>{entry.source === "user" ? "用户确认" : "Agent 验证"} · {statusLabels[entry.status]}</Typography.Text><Typography.Paragraph>{entry.method}：{entry.summary}</Typography.Paragraph><Typography.Paragraph type="secondary">{new Date(entry.at).toLocaleString()}<br />版本：{entry.revision}{entry.revision !== audit.revision ? "（历史版本）" : ""}{entry.sessionId && <><br />会话：{entry.sessionId}</>}</Typography.Paragraph></> }))} /> : <Empty description="暂无验证记录" />}
		</Drawer>
	</Page>;
}
