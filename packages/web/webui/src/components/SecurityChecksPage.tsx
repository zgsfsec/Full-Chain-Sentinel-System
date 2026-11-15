import { MoreOutlined, PlusOutlined, ReloadOutlined, SettingOutlined } from "@ant-design/icons";
import { Alert, Button, Drawer, Dropdown, Empty, Flex, Form, Grid, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tabs, Tag, Tree, Typography } from "antd";
import { securityCheckCategories } from "../../../src/security-check-categories.ts";
import type { DataNode } from "antd/es/tree";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SecurityCheckCatalog, SecurityCheckRule, SecurityCheckRuleSummary, SecurityCheckSource, SecurityCheckSyncRecord } from "../../../src/security-check-types.ts";
import { securityCheckRequest } from "../security-check-api.ts";
import "./SecurityChecksPage.css";

export function EngineTabs({ active, onChange }: { active: string; onChange(value: string): void }) {
	return <Tabs activeKey={active} onChange={onChange} items={[{ key: "list", label: "工程列表" }, { key: "checks", label: "安全检查" }]} />;
}

interface RuleDraft { ruleId: string; name: string; category: string; description: string; text: string }
const newDraft = (): RuleDraft => ({ ruleId: `check-${crypto.randomUUID()}`, name: "", category: "自定义", description: "", text: "" });
const newSource = { name: "", repository: "https://github.com/", branch: "main", directory: "rules/security-checks", enabled: true, intervalHours: 24 };
const at = (time: number | null) => time ? new Date(time).toLocaleString("zh-CN", { hour12: false }) : "尚未同步";

export function SecurityCheckRules({ selectedRules = [], onChange, onValidityChange }: {
	selectedRules?: SecurityCheckRuleSummary[]; onChange?(rules: SecurityCheckRuleSummary[]): void; onValidityChange?(valid: boolean): void;
}) {
	const screens = Grid.useBreakpoint();
	const [catalog, setCatalog] = useState<SecurityCheckCatalog>({ rules: [], sources: [] });
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [loadError, setLoadError] = useState("");
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState("");
	const [categoryQuery, setCategoryQuery] = useState("");
	const [selectionOnly, setSelectionOnly] = useState(false);
	const [source, setSource] = useState<string>();
	const selected = selectedRules.map((rule) => rule.id);
	const [selectionOpen, setSelectionOpen] = useState(false);
	const [detail, setDetail] = useState<SecurityCheckRule | null>(null);
	const [editor, setEditor] = useState<{ original?: SecurityCheckRule; copiedFrom?: string; draft: RuleDraft } | null>(null);
	const [sourcesOpen, setSourcesOpen] = useState(false);
	const [sourceEditor, setSourceEditor] = useState<Partial<SecurityCheckSource> | null>(null);
	const [history, setHistory] = useState<{ name: string; items: SecurityCheckSyncRecord[] } | null>(null);
	const [busy, setBusy] = useState(false);
	const [revision, setRevision] = useState(0);
	const [page, setPage] = useState(1);
	const life = useRef(new AbortController());
	useEffect(() => { life.current = new AbortController(); return () => life.current.abort(); }, []);
	useEffect(() => {
		const controller = new AbortController(); let pending = false;
		const load = async () => {
			if (pending) return; pending = true;
			try {
				const result = await securityCheckRequest<SecurityCheckCatalog>("", undefined, controller.signal);
				if (!controller.signal.aborted) {
					setCatalog(result); setLoadError("");
				}
			} catch (e) { if (!controller.signal.aborted) setLoadError(e instanceof Error ? e.message : "读取规则失败"); }
			finally { pending = false; if (!controller.signal.aborted) setLoading(false); }
		};
		void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 10_000);
		return () => { controller.abort(); clearInterval(timer); };
	}, [revision]);
	const refresh = () => { setLoading(true); setRevision((n) => n + 1); };
	const act = async (action: string, body: unknown, done?: () => void) => {
		if (busy) return;
		setBusy(true); setError("");
		try {
			const result = await securityCheckRequest<{ items?: { ok: boolean; error?: string }[] }>(action, body, life.current.signal);
			if (life.current.signal.aborted) return;
			refresh(); done?.();
			const failures = result.items?.filter((r) => !r.ok) ?? [];
			if (failures.length) setError(failures.map((r) => r.error).join("；"));
		} catch (e) { if (!life.current.signal.aborted) setError(e instanceof Error ? e.message : "操作失败"); }
		finally { if (!life.current.signal.aborted) setBusy(false); }
	};
	const sourceName = (id: string) => id === "local" ? "自定义" : catalog.sources.find((s) => s.id === id)?.name ?? id;
	const memberships = useMemo(() => {
		const counts = new Map<string, Set<string>>();
		for (const rule of catalog.rules) for (const category of securityCheckCategories(rule.category)) {
			let path = "";
			for (const segment of category.split("/")) {
				path = path ? `${path}/${segment}` : segment;
				const ids = counts.get(path) ?? new Set<string>();
				ids.add(rule.id); counts.set(path, ids);
			}
		}
		return counts;
	}, [catalog.rules]);
	const tree = useMemo(() => {
		const root: DataNode[] = [];
		for (const [category, ids] of memberships) {
			if (categoryQuery && !category.toLowerCase().includes(categoryQuery.toLowerCase())) continue;
			let nodes = root; let path = "";
			for (const segment of category.split("/")) {
				path = path ? `${path}/${segment}` : segment;
				let node = nodes.find((n) => n.key === path);
				if (!node) { node = { key: path, title: <span className="security-checks-category-label"><span>{segment}</span><span>{memberships.get(path)?.size ?? ids.size}</span></span>, children: [] }; nodes.push(node); }
				nodes = node.children ?? [];
			}
		}
		return root;
	}, [memberships, categoryQuery]);
	const chosen = selectedRules;
	const stale = chosen.filter((rule) => !catalog.rules.some((current) => current.id === rule.id && current.version === rule.version));
	const valid = chosen.length === 0 || (!loading && !loadError && stale.length === 0);
	useEffect(() => { onValidityChange?.(valid); }, [onValidityChange, valid]);
	const visible = (selectionOnly ? chosen : catalog.rules).filter((r) =>
		(!category || securityCheckCategories(r.category).some((path) => path === category || path.startsWith(`${category}/`))) &&
		(!source || r.sourceId === source) && `${r.name} ${r.category} ${r.description}`.toLowerCase().includes(query.trim().toLowerCase()));
	const setSelected = (ids: string[]) => onChange?.(ids.flatMap((id) => {
		const rule = chosen.find((rule) => rule.id === id) ?? catalog.rules.find((rule) => rule.id === id);
		return rule ? [rule] : [];
	}));
	const clearFilters = () => { setQuery(""); setCategory(""); setSource(undefined); setCategoryQuery(""); setPage(1); };
	const openCopy = (r: SecurityCheckRule) => { setDetail(null); setEditor({ draft: { ...r, ruleId: `check-${crypto.randomUUID()}`, name: `${r.name}（副本）` }, copiedFrom: `${r.id}@${r.version}` }); };
	const loadRule = async (id: string, mode: "detail" | "edit" | "copy") => {
		try {
			const rule = await securityCheckRequest<SecurityCheckRule>(`/rule?id=${encodeURIComponent(id)}`, undefined, life.current.signal);
			if (life.current.signal.aborted) return;
			if (mode === "detail") setDetail(rule);
			else if (mode === "copy") openCopy(rule);
			else setEditor({ original: rule, draft: rule });
		} catch (e) { if (!life.current.signal.aborted) setError(e instanceof Error ? e.message : "读取规则失败"); }
	};
	const saveRule = () => {
		if (!editor) return;
		const { draft: d, original, copiedFrom } = editor;
		const markdown = `---\nid: ${JSON.stringify(d.ruleId)}\nname: ${JSON.stringify(d.name)}\ncategory: ${JSON.stringify(d.category)}\ndescription: ${JSON.stringify(d.description)}\n---\n\n${d.text}`;
		void act("/rules/save", { markdown, id: original?.id, version: original?.version, copiedFrom }, () => setEditor(null));
	};
	const showHistory = async (s: SecurityCheckSource) => {
		try { const result = await securityCheckRequest<{ items: SecurityCheckSyncRecord[] }>(`/history?sourceId=${encodeURIComponent(s.id)}`, undefined, life.current.signal); if (!life.current.signal.aborted) setHistory({ name: s.name, items: result.items }); }
		catch (e) { if (!life.current.signal.aborted) setError(e instanceof Error ? e.message : "读取记录失败"); }
	};
	return <div className="security-checks-page">
		<Flex className="security-checks-topbar" justify="space-between" align="center" gap={12} wrap>
			{onChange ? <Segmented aria-label="规则视图" value={selectionOnly ? "selected" : "all"} onChange={(value) => { setSelectionOnly(value === "selected"); clearFilters(); }} options={[{ value: "all", label: `规则库 ${catalog.rules.length}` }, { value: "selected", label: `已选规则 ${chosen.length}` }]} /> : <Typography.Text strong>检查规则 · {catalog.rules.length}</Typography.Text>}
			<Space size={4}><Button type="text" icon={<ReloadOutlined />} onClick={refresh} loading={loading} aria-label="刷新规则" />
				<Dropdown trigger={["click"]} menu={{ items: [{ key: "new", label: "新建规则", icon: <PlusOutlined /> }, { key: "sync", label: "同步规则", icon: <ReloadOutlined />, disabled: busy }, { key: "sources", label: "规则源", icon: <SettingOutlined /> }], onClick: ({ key }) => { if (key === "new") setEditor({ draft: newDraft() }); else if (key === "sync") void act("/sync", {}); else setSourcesOpen(true); } }}><Button icon={<MoreOutlined />}>规则管理</Button></Dropdown>
			</Space>
		</Flex>
		{(error || loadError) && <Alert type="error" showIcon title={error || loadError} action={loadError && <Button size="small" onClick={refresh}>重试</Button>} />}
		{!!stale.length && !loading && !loadError && <Alert type="warning" showIcon title={`${stale.length} 条已选规则已更新或下架，请确认后更新选择。`} action={<Button size="small" onClick={() => onChange?.(catalog.rules.filter((r) => selected.includes(r.id)))}>更新所选规则</Button>} />}
		<div className="security-checks-layout">
			<aside className="security-checks-categories">
				<details open={screens.md}><summary>{category || "检查分类"}</summary><Input.Search aria-label="搜索分类" placeholder="搜索分类" allowClear value={categoryQuery} onChange={(e) => setCategoryQuery(e.target.value)} />
				<Button type={!category ? "primary" : "text"} block onClick={() => { setCategory(""); setPage(1); }}>全部分类 · {catalog.rules.length}</Button>
				<Tree key={categoryQuery || String(tree.length)} blockNode defaultExpandAll selectedKeys={category ? [category] : []} treeData={tree} onSelect={(keys) => { setCategory(String(keys[0] ?? "")); setPage(1); }} />
				{!tree.length && <Typography.Text type="secondary">暂无分类</Typography.Text>}</details>
			</aside>
			<section className="security-checks-library">
				<Flex gap={8} wrap className="security-checks-toolbar"><Input.Search aria-label="搜索规则" placeholder="搜索名称、分类或简介" allowClear value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
					<Select aria-label="筛选规则来源" placeholder="全部来源" allowClear value={source} onChange={(v) => { setSource(v); setPage(1); }} options={[{ value: "local", label: "自定义" }, ...catalog.sources.map((s) => ({ value: s.id, label: s.name }))]} />
				</Flex>
				<Flex className="security-checks-resultbar" gap={8} align="center" wrap><Typography.Text type="secondary">{category || "全部分类"} · {visible.length} 条{selectionOnly ? "已选规则" : "规则"}</Typography.Text><span className="security-checks-spacer" />
					{(query || category || source) && <Button size="small" type="text" onClick={clearFilters}>重置筛选</Button>}
					{onChange && !selectionOnly && <Button size="small" disabled={!visible.length || loading || !!loadError} onClick={() => setSelected([...new Set([...selected, ...visible.map((r) => r.id)])])}>选中筛选结果</Button>}
				</Flex>
				<Table<SecurityCheckRuleSummary> rowKey="id" size="small" loading={loading} dataSource={visible} scroll={{ x: 700 }}
					rowSelection={onChange ? { selectedRowKeys: selected, preserveSelectedRowKeys: true, onChange: (keys) => setSelected(keys.map(String)), getCheckboxProps: (r) => ({ "aria-label": `选择规则 ${r.name}`, disabled: loading || !!loadError }) } : undefined}
					pagination={{ current: Math.min(page, Math.max(1, Math.ceil(visible.length / 10))), pageSize: 10, showSizeChanger: false, showTotal: (n) => `共 ${n} 条`, onChange: setPage }}
					locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={selectionOnly ? "还未选择规则，可返回规则库勾选" : query || category || source ? "没有匹配的规则，可重置筛选" : "从规则管理新建规则或同步规则源"} /> }}
					columns={[
						{ title: "规则名称", dataIndex: "name", width: 240, ellipsis: true, render: (_, r) => <Button type="link" size="small" title={r.description || r.name} onClick={() => void loadRule(r.id, "detail")}>{r.name}</Button> },
						{ title: "分类", dataIndex: "category", ellipsis: true, render: (value: string) => <span title={securityCheckCategories(value).join("、")}>{securityCheckCategories(value).join("、")}</span> },
						{ title: "来源", width: 140, ellipsis: true, render: (_, r) => sourceName(r.sourceId) },
						{ title: "操作", width: 110, render: (_, r) => <Space size={0}><Button size="small" type="link" onClick={() => void loadRule(r.id, r.sourceId === "local" ? "edit" : "copy")}>{r.sourceId === "local" ? "编辑" : "复制"}</Button>{r.sourceId === "local" && <Popconfirm title="删除此规则？" description="已有工程的规则快照不受影响。" onConfirm={() => void act("/rules/delete", { id: r.id, version: r.version })}><Button danger type="text" size="small">删除</Button></Popconfirm>}</Space> },
					]} />
			</section>
		</div>
		{onChange && <Flex className="security-checks-selection" align="center" gap={8} wrap><Typography.Text strong>已选 {chosen.length} 条</Typography.Text><Typography.Text type="secondary">跨分类保留，合并为一次检查</Typography.Text><span className="security-checks-spacer" /><Button size="small" disabled={!chosen.length} onClick={() => setSelectionOpen(true)}>查看已选</Button><Button size="small" type="text" disabled={!chosen.length} onClick={() => setSelected([])}>清空选择</Button></Flex>}

		<Drawer rootClassName="security-checks-drawer" styles={{ wrapper: { maxWidth: "100vw" } }} title="已选规则" open={selectionOpen} onClose={() => setSelectionOpen(false)} size={600}>{chosen.map((r) => <Flex key={r.id} justify="space-between" align="center"><Typography.Text ellipsis>{r.category} / {r.name}</Typography.Text><Button type="text" onClick={() => setSelected(selected.filter((id) => id !== r.id))}>移除</Button></Flex>)}</Drawer>
		<Drawer rootClassName="security-checks-drawer" styles={{ wrapper: { maxWidth: "100vw" } }} title={detail?.name} open={!!detail} onClose={() => setDetail(null)} size={760} extra={detail && <Space wrap><Button onClick={() => openCopy(detail)}>复制为自定义规则</Button>{onChange && <Button type="primary" onClick={() => { setSelected(selected.includes(detail.id) ? selected.filter((id) => id !== detail.id) : [...selected, detail.id]); setDetail(null); }}>{selected.includes(detail.id) ? "移除选择" : "选用规则"}</Button>}</Space>}>
			{detail && <><Typography.Paragraph type="secondary">{detail.category} · {sourceName(detail.sourceId)}<br />版本 {detail.version.slice(0, 12)}{detail.commit && ` · 提交 ${detail.commit.slice(0, 12)}`}<br />{detail.path}{detail.copiedFrom && <><br />复制自 {detail.copiedFrom}</>}</Typography.Paragraph><Typography.Paragraph>{detail.description}</Typography.Paragraph><pre className="security-checks-text">{detail.text}</pre></>}
		</Drawer>
		<Modal title={editor?.original ? "编辑自定义规则" : "新建自定义规则"} open={!!editor} onCancel={() => !busy && setEditor(null)} onOk={saveRule} confirmLoading={busy} okText="保存" cancelText="取消" width={800}>
			{error && <Alert type="error" title={error} />}
			{editor && <Form layout="vertical" disabled={busy}>{([ ["ruleId", "固定 ID"], ["name", "规则名称"], ["category", "分类路径（多个用逗号分隔）"], ["description", "简介（可选）"]] as const).map(([key, label]) => <Form.Item key={key} label={label} extra={key === "category" ? "逗号分隔多个分类，/ 表示分类内的层级。一条规则可以归属多个分类。" : undefined}><Input placeholder={key === "category" ? "等保/三级/Linux,主机安全/账号" : undefined} disabled={key === "ruleId" && !!editor.original} value={editor.draft[key]} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, [key]: e.target.value } })} /></Form.Item>)}<Form.Item label="检查提示词"><Input.TextArea autoSize={{ minRows: 9, maxRows: 18 }} value={editor.draft.text} onChange={(e) => setEditor({ ...editor, draft: { ...editor.draft, text: e.target.value } })} placeholder="描述检查范围、要求及交付内容，由 Agent 自主组织检查。" /></Form.Item></Form>}
		</Modal>
		<Drawer rootClassName="security-checks-drawer" styles={{ wrapper: { maxWidth: "100vw" } }} title="规则源" open={sourcesOpen} onClose={() => setSourcesOpen(false)} size={760} extra={<Button icon={<PlusOutlined />} onClick={() => setSourceEditor({ ...newSource })}>添加规则源</Button>}>
			{error && <Alert type="error" title={error} />}
			<Typography.Paragraph type="secondary">全局共享，默认每 24 小时同步。同步失败继续使用已有规则，已提交工程使用自己的快照。</Typography.Paragraph>
			{catalog.sources.map((s) => <section className="security-checks-source" key={s.id}><Flex justify="space-between" wrap gap={8}><Typography.Text strong>{s.name}</Typography.Text><Tag>{s.syncing ? "同步中" : s.enabled ? `每 ${s.intervalHours} 小时` : "自动同步已停用"}</Tag></Flex><Typography.Paragraph type="secondary">{s.repository}<br />{s.branch} / {s.directory}<br />最近检查：{at(s.lastCheckedAt)}<br />最近成功：{at(s.lastSuccessAt)} · {catalog.rules.filter((r) => r.sourceId === s.id).length} 条规则<br />下次同步：{s.enabled ? at(s.nextSyncAt) : "已停用"}</Typography.Paragraph>{s.error && <Alert type="error" title={s.error} />}<Space wrap><Button size="small" disabled={busy || s.syncing} onClick={() => void act("/sync", { id: s.id })}>同步</Button><Button size="small" onClick={() => setSourceEditor(s)}>配置</Button><Button size="small" onClick={() => void showHistory(s)}>同步记录</Button><Popconfirm title="删除规则源？" description={`将移除该来源的 ${catalog.rules.filter((r) => r.sourceId === s.id).length} 条规则，已有工程和本地副本保留。`} onConfirm={() => void act("/sources/delete", { id: s.id })}><Button size="small" danger>删除</Button></Popconfirm></Space></section>)}
		</Drawer>
		<Modal title="规则源配置" open={!!sourceEditor} onCancel={() => !busy && setSourceEditor(null)} onOk={() => sourceEditor && void act("/sources/save", sourceEditor, () => setSourceEditor(null))} confirmLoading={busy} okText="保存" cancelText="取消">
			{error && <Alert type="error" title={error} />}{sourceEditor && <Form layout="vertical" disabled={busy}>{([ ["name", "名称"], ["repository", "GitHub 仓库"], ["branch", "分支"], ["directory", "规则目录"]] as const).map(([key, label]) => <Form.Item key={key} label={label}><Input value={sourceEditor[key]} onChange={(e) => setSourceEditor({ ...sourceEditor, [key]: e.target.value })} /></Form.Item>)}<Form.Item label="自动同步"><Switch checked={sourceEditor.enabled} onChange={(enabled) => setSourceEditor({ ...sourceEditor, enabled })} /></Form.Item><Form.Item label="同步周期（小时）"><InputNumber min={1} max={720} value={sourceEditor.intervalHours} onChange={(n) => setSourceEditor({ ...sourceEditor, intervalHours: n ?? 24 })} /></Form.Item></Form>}
		</Modal>
		<Drawer rootClassName="security-checks-drawer" styles={{ wrapper: { maxWidth: "100vw" } }} title={`${history?.name ?? ""} · 同步记录`} open={!!history} onClose={() => setHistory(null)} size={600}>{history?.items.map((r) => <section key={r.at} className="security-checks-source"><Typography.Text>{at(r.at)} · {r.ok ? "成功" : "失败"}</Typography.Text><Typography.Paragraph>{r.message} · {r.count} 条</Typography.Paragraph></section>)}</Drawer>
	</div>;
}
