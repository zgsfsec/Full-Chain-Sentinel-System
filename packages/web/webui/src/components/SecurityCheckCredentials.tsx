import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Flex, Input, Segmented, Select, Table, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import type { CredentialView } from "../../../src/credential-types.ts";

const STATUS = {
	usable: { label: "可用", color: "success" },
	unverified: { label: "未验证", color: "default" },
	failed: { label: "验证失败", color: "error" },
};

export function SecurityCheckCredentials({ projectId, selected, onChange, onValidityChange }: {
	projectId: string; selected: CredentialView[]; onChange(rows: CredentialView[]): void; onValidityChange(valid: boolean): void;
}) {
	const [items, setItems] = useState<CredentialView[]>([]);
	const [query, setQuery] = useState("");
	const [type, setType] = useState<string>();
	const [status, setStatus] = useState<string>();
	const [selectionOnly, setSelectionOnly] = useState(false);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [revision, setRevision] = useState(0);
	const [page, setPage] = useState(1);
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true); setError("");
		void fetch(`/api/credentials?projectId=${encodeURIComponent(projectId)}`, { signal: controller.signal }).then(async (response) => {
			const result = await response.json() as { items?: CredentialView[]; error?: string };
			if (!response.ok || !Array.isArray(result.items)) throw new Error(result.error ?? "读取凭据失败");
			if (!controller.signal.aborted) setItems(result.items);
		}).catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "读取失败"); })
			.finally(() => { if (!controller.signal.aborted) setLoading(false); });
		return () => controller.abort();
	}, [projectId, revision]);
	const stale = selected.filter((row) => !items.some((current) => current.id === row.id && current.revision === row.revision));
	const valid = selected.length === 0 || (!loading && !error && stale.length === 0);
	useEffect(() => { onValidityChange(valid); }, [onValidityChange, valid]);
	const ids = selected.map((row) => row.id);
	const visible = (selectionOnly ? selected : items).filter((r) => (!type || r.type === type) && (!status || r.status === status) &&
		`${r.name} ${r.type} ${r.host} ${r.port ?? ""} ${r.username} ${r.database} ${r.instance}`.toLowerCase().includes(query.trim().toLowerCase()));
	const select = (keys: string[]) => onChange(keys.flatMap((id) => {
		const row = selected.find((r) => r.id === id) ?? items.find((r) => r.id === id);
		return row ? [row] : [];
	}));
	const clearFilters = () => { setQuery(""); setType(undefined); setStatus(undefined); setPage(1); };
	return <div className="security-checks-credentials">
		<Alert type="info" showIcon title="凭据关联可选" description="直接勾选凭据作为本轮检查目标；已有手动目标时可不选。未验证或验证失败的凭据，由 Agent 先验证再检查。" />
		<Flex className="security-checks-topbar" gap={12} justify="space-between" align="center" wrap>
			<Segmented aria-label="凭据视图" value={selectionOnly ? "selected" : "all"} onChange={(value) => { setSelectionOnly(value === "selected"); clearFilters(); }} options={[{ value: "all", label: `项目凭据 ${items.length}` }, { value: "selected", label: `已选凭据 ${selected.length}` }]} />
			<Button icon={<ReloadOutlined />} loading={loading} onClick={() => setRevision((r) => r + 1)}>刷新凭据</Button>
		</Flex>
		{error && <Alert type="error" title={error} action={<Button size="small" onClick={() => setRevision((r) => r + 1)}>重试</Button>} />}
		{!!stale.length && !loading && !error && <Alert type="warning" showIcon title={`${stale.length} 条已选凭据已修改或删除，请重新确认。`} action={<Button size="small" onClick={() => onChange(items.filter((r) => ids.includes(r.id)))}>更新所选凭据</Button>} />}
		<Flex gap={8} wrap className="security-checks-toolbar">
			<Input.Search aria-label="搜索凭据" placeholder="搜索名称、目标、账号或数据库" allowClear value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
			<Select aria-label="筛选凭据类型" placeholder="全部类型" allowClear value={type} options={[...new Set(items.map((r) => r.type))].sort().map((value) => ({ value, label: value }))} onChange={(value) => { setType(value); setPage(1); }} />
			<Select aria-label="筛选验证状态" placeholder="全部验证状态" allowClear value={status} options={Object.entries(STATUS).map(([value, status]) => ({ value, label: status.label }))} onChange={(value) => { setStatus(value); setPage(1); }} />
		</Flex>
		<Flex className="security-checks-resultbar" gap={8} wrap align="center"><Typography.Text type="secondary">{visible.length} 条{selectionOnly ? "已选凭据" : "凭据"}</Typography.Text><span className="security-checks-spacer" />
			{(query || type || status) && <Button size="small" type="text" onClick={clearFilters}>重置筛选</Button>}
			{!selectionOnly && <Button size="small" disabled={loading || !!error || !visible.length} onClick={() => select([...new Set([...ids, ...visible.map((r) => r.id)])])}>选中筛选结果</Button>}
		</Flex>
		<Table<CredentialView> size="small" rowKey="id" loading={loading} scroll={{ x: 850 }}
			pagination={{ current: Math.min(page, Math.max(1, Math.ceil(visible.length / 10))), pageSize: 10, showSizeChanger: false, showTotal: (total) => `共 ${total} 条`, onChange: setPage }}
			dataSource={visible}
			locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={selectionOnly ? "未关联凭据，可返回项目凭据勾选" : query || type || status ? "没有匹配的凭据，可重置筛选" : "当前项目暂无凭据，可返回上一步输入目标"} /> }}
			rowSelection={{ selectedRowKeys: ids, preserveSelectedRowKeys: true, onChange: (keys) => select(keys.map(String)), getCheckboxProps: (r) => ({ "aria-label": `选择凭据 ${r.name}`, disabled: loading || !!error }) }}
			columns={[
				{ title: "名称", dataIndex: "name", width: 160, ellipsis: true },
				{ title: "类型", dataIndex: "type", width: 140, ellipsis: true },
				{ title: "目标", width: 180, ellipsis: true, render: (_, r) => `${r.host}${r.port ? `:${r.port}` : ""}` },
				{ title: "账号", dataIndex: "username", width: 130, ellipsis: true },
				{ title: "数据库 / 实例", ellipsis: true, render: (_, r) => [r.database, r.instance].filter(Boolean).join(" / ") || "—" },
				{ title: "验证状态", width: 110, render: (_, r) => <Tag color={STATUS[r.status].color}>{STATUS[r.status].label}</Tag> },
			]} />
		<Flex className="security-checks-selection" gap={8} align="center" wrap><Typography.Text strong>已关联 {selected.length} 条凭据</Typography.Text><span className="security-checks-spacer" /><Button size="small" type="text" disabled={!selected.length} onClick={() => onChange([])}>清空选择</Button></Flex>
		<Typography.Paragraph type="secondary" className="security-checks-permission">工程可按需访问当前项目全部凭据。这里的勾选仅确定本轮检查目标，不扩大检查范围。</Typography.Paragraph>
	</div>;
}
