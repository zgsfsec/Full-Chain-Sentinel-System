import { useEffect, useRef, useState } from "react";
import { Alert, Button, Empty, Input, Select, Space, Spin, Table, Tag, Typography } from "antd";
import { ArrowLeftOutlined, ApartmentOutlined, CloseOutlined, ExportOutlined, PauseOutlined, PlayCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import type { WorkEvidence, WorkNode, WorkProcess, WorkProcessItem, WorkProcessKind, WorkProcessRef, WorkRevision } from "../../../src/work-process-types.ts";
import type { SentinelProjectInfo } from "../types.ts";
import { readJson } from "../read-json.ts";
import { workLinkPageHref } from "../work-link-page.ts";
import { WorkProcessGraph, workEdgeLabel, WORK_STATUS, workText as tx } from "./WorkProcessGraph.tsx";
import "./work-process.css";

const { Text, Title } = Typography;

function processUrl(ref: WorkProcessRef, operation: string): string {
	return `/api/work-processes/${operation}?${new URLSearchParams({ projectId: ref.projectId, kind: ref.kind, id: ref.id })}`;
}

const STATE_LABELS = {
	off: ["未开启", "Off"], paused: ["已暂停", "Paused"], analyzing: ["分析中", "Analyzing"],
	watching: ["持续分析", "Watching"], error: ["分析失败", "Analysis failed"],
	retrying: ["自动重试", "Retrying"],
} as const;

export function WorkNodeDetails({ process, node, revisions = [], onHistory, onEvidence }: {
	process: WorkProcess; node: WorkNode; revisions?: WorkRevision[]; onHistory: () => void; onEvidence: (entry: WorkEvidence) => void;
}) {
	const evidence = new Map(process.evidence.map((entry) => [entry.id, entry]));
	const relations = process.edges.filter((edge) => edge.from === node.id || edge.to === node.id);
	const nodes = new Map(process.nodes.map((entry) => [entry.id, entry]));
	return <aside className="work-details" aria-label={tx("节点详情", "Node details")}>
		<div className="work-details__title"><Title level={4}>{node.title}</Title><Tag>{tx(WORK_STATUS[node.status][0], WORK_STATUS[node.status][1])}</Tag></div>
		<Text type="secondary">{tx("所属 Agent", "Agent")}: {nodes.get(node.parentId ?? "")?.title ?? process.title}</Text>
		<section><h3>{tx("目标与意图", "Goal and intent")}</h3>
			<Tag color={node.intentBasis === "inferred" ? "gold" : undefined}>{node.intentBasis === "explicit" ? tx("明确表达", "Explicit") : node.intentBasis === "inferred" ? tx("模型推断", "Inferred") : tx("无法判断", "Unknown")}</Tag>
			{node.confidence !== null ? <Text type="secondary">{tx("模型自评置信度", "Model confidence")}: {Math.round(node.confidence * 100)}%</Text> : null}
			<p>{node.intent || tx("暂无足够记录", "Insufficient records")}</p>
		</section>
		<section><h3>{tx("实际行动", "Actions")}</h3>{node.actions.length ? <ul>{node.actions.map((action) => <li key={action}>{action}</li>)}</ul> : <Text type="secondary">{tx("暂无行动摘要", "No action summary")}</Text>}</section>
		<section><h3>{tx("结果与发现", "Outcomes")}</h3>{node.outcomes.length ? <ul>{node.outcomes.map((outcome) => <li key={outcome}>{outcome}</li>)}</ul> : <Text type="secondary">{tx("尚无结果", "No results yet")}</Text>}</section>
		<section><h3>{tx("关联与转向依据", "Relations and pivot evidence")}</h3>
			{relations.map((edge) => <div className="work-details__relation" key={edge.id}>
				<Tag>{workEdgeLabel(edge.kind)}</Tag><Text>{nodes.get(edge.from === node.id ? edge.to : edge.from)?.title}</Text>
				<p>{edge.reason}</p><Text type="secondary">{edge.basis === "recorded" ? tx("原始记录", "Recorded") : tx("模型推断", "Inferred")}</Text>
				{edge.evidenceIds.map((id) => { const entry = evidence.get(id); return entry ? <Button key={id} type="link" size="small" onClick={() => onEvidence(entry)}>{tx("依据", "Evidence")}: {entry.toolName ?? entry.kind} #{entry.entryId.slice(0, 8)}</Button> : null; })}
			</div>)}
		</section>
		<section><h3>{tx("证据与原始记录", "Evidence and source records")} ({node.evidenceIds.length})</h3>
			{node.evidenceIds.map((id) => {
				const entry = evidence.get(id);
				return entry ? <details key={id} className="work-evidence">
					<summary>{entry.toolName ?? (entry.kind === "user" ? tx("用户指令", "User instruction") : entry.kind === "assistant" ? tx("Agent 消息", "Agent message") : tx("状态记录", "Status record"))}
						{entry.status ? <Tag>{entry.status === "running" ? tx("调用开始", "Call started") : entry.status === "error" ? tx("出错", "Error") : tx("已返回", "Returned")}</Tag> : null}
					</summary>
					<Text type="secondary">{new Date(entry.at).toLocaleString()} · {entry.entryId}</Text>
					<pre>{entry.text || tx("空内容", "Empty content")}</pre>
					{entry.truncated ? <Text type="warning">{tx("摘要已截断", "Excerpt truncated")}</Text> : null}
					<Button size="small" onClick={() => onEvidence(entry)}>{tx("查看原始记录", "View source record")}</Button>
				</details> : <p key={id}>{tx("原始记录不可用", "Source record unavailable")}</p>;
			})}
		</section>
		<Text type="secondary">{tx("更新于", "Updated")}: {new Date(node.updatedAt).toLocaleString()}</Text>
		{node.revision > 0 ? <section><Button size="small" onClick={onHistory}>{tx("查看修订历史", "View revision history")}</Button>
			{revisions.map((revision) => { const previous = revision.nodes.find((entry) => entry.id === node.id); return previous ? <details className="work-evidence" key={revision.revision}>
				<summary>#{revision.revision} · {new Date(revision.at).toLocaleString()}</summary><p>{previous.intent}</p><ul>{previous.outcomes.map((outcome) => <li key={outcome}>{outcome}</li>)}</ul>
			</details> : null; })}
		</section> : null}
	</aside>;
}

export function WorkProcessDetail({ target, onBack, expanded = false, initialSelectedId = null }: { target: WorkProcessRef; onBack?: () => void; expanded?: boolean; initialSelectedId?: string | null }) {
	const [process, setProcess] = useState<WorkProcess | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [revisions, setRevisions] = useState<WorkRevision[]>([]);
	const [original, setOriginal] = useState<{ entry: WorkEvidence; text: string; truncated: boolean } | null>(null);
	const requests = useRef(new Set<AbortController>());
	const generation = useRef(0);
	const selectionGeneration = useRef(0);
	const mounted = useRef(true);
	const detailScroll = useRef<HTMLDivElement>(null);
	const originalRecord = useRef<HTMLElement>(null);
	useEffect(() => { if (detailScroll.current) detailScroll.current.scrollTop = 0; }, [selectedId]);
	useEffect(() => {
		const container = detailScroll.current;
		const record = originalRecord.current;
		if (original && container && record) container.scrollTop += record.getBoundingClientRect().top - container.getBoundingClientRect().top;
	}, [original]);
	const detailUrl = processUrl(target, "detail");
	useEffect(() => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			const version = generation.current;
			try {
				const result = await readJson<{ process: WorkProcess }>(detailUrl, controller.signal);
				if (!controller.signal.aborted && version === generation.current) { setProcess(result.process); setError(null); }
			} catch (cause) {
				if (!controller.signal.aborted && version === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
			}
		};
		void poll();
		return () => { controller.abort(); clearTimeout(timer); };
	}, [detailUrl, refresh]);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const controller of requests.current) controller.abort(); }; }, []);

	const control = async (action: "enable" | "pause" | "analyze" | "retry") => {
		if (pending) return;
		const controller = new AbortController(); requests.current.add(controller);
		const version = ++generation.current;
		const timer = setTimeout(() => controller.abort(), 15000);
		setPending(true); setError(null);
		try {
			const response = await fetch(processUrl(target, "control"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }), signal: controller.signal });
			const body = await response.json() as { process?: WorkProcess; error?: string };
			if (!response.ok || !body.process) throw new Error(body.error ?? tx("操作失败", "Action failed"));
			if (version === generation.current && !controller.signal.aborted) { setProcess(body.process); setRefresh((value) => value + 1); }
		} catch (cause) {
			if (mounted.current && version === generation.current) setError(controller.signal.aborted ? tx("操作超时，请刷新后重试", "Action timed out. Refresh and retry.") : cause instanceof Error ? cause.message : String(cause));
		} finally { clearTimeout(timer); requests.current.delete(controller); if (mounted.current) setPending(false); }
	};
	const selected = process?.nodes.find((node) => node.id === selectedId);
	const history = async () => {
		if (!selectedId) return;
		const selection = selectionGeneration.current;
		const controller = new AbortController(); requests.current.add(controller);
		try {
			const data = await readJson<{ revisions: WorkRevision[] }>(`${processUrl(target, "revisions")}&nodeId=${encodeURIComponent(selectedId)}`, controller.signal);
			if (!controller.signal.aborted && selection === selectionGeneration.current) setRevisions(data.revisions);
		} catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { requests.current.delete(controller); }
	};
	const showEvidence = async (entry: WorkEvidence) => {
		const selection = selectionGeneration.current;
		const controller = new AbortController(); requests.current.add(controller);
		try {
			const result = await readJson<{ text: string; truncated: boolean }>(`${processUrl(target, "evidence")}&evidenceId=${encodeURIComponent(entry.id)}`, controller.signal);
			if (!controller.signal.aborted && selection === selectionGeneration.current) setOriginal({ entry, ...result });
		} catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { requests.current.delete(controller); }
	};
	return <div className="work-process work-process--detail">
		<div className="work-process__heading"><Space>{onBack ? <Button icon={<ArrowLeftOutlined />} onClick={onBack}>{tx("返回列表", "Back")}</Button> : null}<Title level={3}>{process?.title ?? tx("工作链路", "Work links")}</Title></Space>
			<Space wrap><Button icon={<ReloadOutlined />} onClick={() => setRefresh((value) => value + 1)}>{tx("刷新", "Refresh")}</Button>
				{!expanded ? <Button icon={<ExportOutlined />} href={workLinkPageHref(target, selectedId)} target="_blank" rel="noopener noreferrer">{tx("新页面展开", "Open expanded page")}</Button> : null}
				{process ? <>
					<Button type={process.enabled || process.running || process.retry ? "default" : "primary"} loading={pending} icon={process.enabled || process.running || process.retry ? <PauseOutlined /> : <PlayCircleOutlined />} onClick={() => void control(process.enabled || process.running || process.retry ? "pause" : "enable")}>
						{process.enabled || process.running || process.retry ? tx("暂停分析", "Pause analysis") : process.revision ? tx("恢复持续分析", "Resume live analysis") : tx("开启工作链路", "Enable work links")}</Button>
					<Button disabled={pending || process.running} onClick={() => void control(process.error ? "retry" : "analyze")}>{process.error ? tx("重试分析", "Retry analysis") : tx("补分析已有记录", "Analyze existing records")}</Button>
				</> : null}
			</Space>
		</div>
		{error ? <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => setRefresh((value) => value + 1)}>{tx("重试", "Retry")}</Button>} /> : null}
		{!process ? <Spin className="work-process__loading" /> : <>
			<div className="work-process__meta"><Tag color={process.retry ? "warning" : process.error ? "error" : process.enabled ? "success" : "default"}>{process.retry ? process.running ? tx("自动重试中", "Retrying") : tx("等待自动重试", "Waiting to retry") : process.error ? tx("分析失败", "Analysis failed") : process.running ? tx("分析中", "Analyzing") : process.enabled ? tx("持续分析", "Watching") : process.revision > 0 ? tx("已暂停", "Paused") : tx("未开启", "Off")}</Tag>
				<Text type="secondary">{process.kind === "engine" ? tx("工程", "Engineering") : tx("对话", "Conversation")} · {process.projectName}</Text>
				<Text type="secondary">{tx("待分析记录", "Pending records")}: {process.pending}</Text>
				{process.model ? <Text type="secondary">{process.model} · {process.usage.total.toLocaleString()} tokens</Text> : null}
				{process.lastAnalyzedAt ? <Text type="secondary">{tx("分析更新", "Last analysis")}: {new Date(process.lastAnalyzedAt).toLocaleString()}</Text> : null}
			</div>
			{process.error ? <Alert type={process.retry ? "warning" : "error"} showIcon title={process.error} description={process.retry ? tx(`已有链路和待分析记录已保留。第 ${process.retry.attempt} 次自动重试${process.running ? "正在进行" : `将在 ${new Date(process.retry.at).toLocaleTimeString()} 开始`}；可暂停分析取消重试。`, `Results and pending records are preserved. Automatic retry ${process.retry.attempt} ${process.running ? "is running" : `starts at ${new Date(process.retry.at).toLocaleTimeString()}`}. Pause analysis to cancel retries.`) : tx("已有链路和待分析记录已保留。点击「重试分析」继续。", "Results and pending records are preserved. Select Retry analysis to continue.")} /> : null}
			{process.revision === 0 && !process.enabled && !process.running && !process.retry ? <Alert type="info" showIcon title={tx("手动开启工作链路", "Enable work links manually")}
				description={tx("开启后先分析已有记录，再持续更新；也可以只补分析已有记录。分析会额外调用工作链路模型。", "Enable to analyze existing records and keep updating, or analyze history once. Analysis uses the work links model.")} /> : null}
			<div className={selected ? "work-process__body has-details" : "work-process__body"}>
				<WorkProcessGraph process={process} selectedId={selectedId} initialView={expanded ? "graph" : "tree"} onSelect={(node) => { selectionGeneration.current++; setSelectedId(node.id); setRevisions([]); setOriginal(null); }} />
				{selected ? <div className="work-process__detail-column">
					<div className="work-process__detail-header"><strong>{tx("节点详情", "Node details")}</strong><Button size="small" type="text" icon={<CloseOutlined />} onClick={() => { selectionGeneration.current++; setSelectedId(null); setOriginal(null); }}>{tx("关闭详情", "Close details")}</Button></div>
					<div className="work-process__detail-scroll" ref={detailScroll} key={selected.id} tabIndex={0} role="region" aria-label={tx("可滚动节点详情", "Scrollable node details")}>
					<WorkNodeDetails process={process} node={selected} revisions={revisions} onHistory={() => void history()} onEvidence={(entry) => void showEvidence(entry)} />
					{original ? <section ref={originalRecord} className="work-original" aria-label={tx("原始记录", "Source record")}><h3>{tx("原始记录", "Source record")}</h3>
						<Text type="secondary">{original.entry.ownerId} · {original.entry.entryId}</Text><pre>{original.text}</pre>
						{original.truncated ? <Text type="warning">{tx("原始记录过长，已截断", "Source record is too long and was truncated")}</Text> : null}
					</section> : null}
					</div>
				</div> : null}
			</div>
		</>}
	</div>;
}

function WorkProcessList({ projectId, kind, onSelect }: { projectId: string; kind: WorkProcessKind; onSelect: (ref: WorkProcessRef) => void }) {
	const [items, setItems] = useState<WorkProcessItem[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [state, setState] = useState("all");
	const [refresh, setRefresh] = useState(0);
	useEffect(() => {
		const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				const result = await readJson<{ items: WorkProcessItem[] }>(`/api/work-processes?${new URLSearchParams({ projectId, kind })}`, controller.signal);
				if (!controller.signal.aborted) { setItems(result.items); setError(null); }
			} catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
			finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000); }
		};
		void poll(); return () => { controller.abort(); clearTimeout(timer); };
	}, [projectId, kind, refresh]);
	const needle = search.trim().toLocaleLowerCase();
	const filtered = (items ?? []).filter((item) => (state === "all" || item.state === state) && `${item.title}\n${item.intent}`.toLocaleLowerCase().includes(needle));
	return <>
		{error ? <Alert type="error" showIcon title={error} action={<Button onClick={() => setRefresh((value) => value + 1)}>{tx("重试", "Retry")}</Button>} /> : null}
		<Space wrap className="work-process__filters"><Input.Search allowClear placeholder={tx("搜索对话、工程或意图", "Search name or intent")} aria-label={tx("搜索工作链路", "Search work links")} value={search} onChange={(event) => setSearch(event.target.value)} />
			<Select aria-label={tx("分析状态", "Analysis state")} value={state} onChange={setState} options={[{ value: "all", label: tx("全部状态", "All states") }, ...Object.entries(STATE_LABELS).map(([value, labels]) => ({ value, label: tx(labels[0], labels[1]) }))]} />
			<Button icon={<ReloadOutlined />} onClick={() => setRefresh((value) => value + 1)}>{tx("刷新", "Refresh")}</Button>
		</Space>
		<Table<WorkProcessItem> rowKey="id" size="small" loading={!items && !error} dataSource={filtered} scroll={{ x: 760 }} pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
			locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tx("暂无匹配的对话或工程。创建后可在这里手动开启分析。", "No matching conversations or engineering runs. Create one, then enable analysis here.")} /> }}
			columns={[
				{ title: tx("名称", "Name"), dataIndex: "title", render: (title: string, item) => <Button type="link" className="work-process__name" onClick={() => onSelect(item)}>{title}</Button> },
				{ title: tx("状态", "State"), dataIndex: "state", width: 120, render: (value: WorkProcessItem["state"]) => <Tag color={value === "error" ? "error" : value === "watching" ? "success" : undefined}>{tx(STATE_LABELS[value][0], STATE_LABELS[value][1])}</Tag> },
				{ title: tx("当前意图", "Current intent"), dataIndex: "intent", ellipsis: true, render: (intent: string) => intent || "—" },
				{ title: tx("步骤", "Steps"), dataIndex: "nodeCount", width: 70 },
				{ title: tx("最近更新", "Updated"), dataIndex: "updatedAt", width: 180, render: (at: number) => new Date(at).toLocaleString() },
				{ title: tx("操作", "Action"), key: "action", width: 100, render: (_, item) => <Button size="small" onClick={() => onSelect(item)}>{tx("查看过程", "View process")}</Button> },
			]} />
	</>;
}

export function WorkProcessPage({ projects, activeProjectId, initialTarget, initialKind = "session" }: {
	projects: SentinelProjectInfo[]; activeProjectId: string | null; initialTarget?: WorkProcessRef | null; initialKind?: WorkProcessKind;
}) {
	const [projectId, setProjectId] = useState(initialTarget?.projectId ?? activeProjectId ?? projects[0]?.id ?? "");
	const [kind, setKind] = useState<WorkProcessKind>(initialTarget?.kind ?? initialKind);
	const [target, setTarget] = useState<WorkProcessRef | null>(initialTarget ?? null);
	useEffect(() => {
		if (!projectId && projects.length) setProjectId(activeProjectId ?? projects[0].id);
	}, [projectId, projects, activeProjectId]);
	return target ? <WorkProcessDetail key={JSON.stringify(target)} target={target} onBack={() => setTarget(null)} /> : <div className="work-process">
		<div className="work-process__heading"><div><Title level={3}><ApartmentOutlined /> {tx("工作链路", "Work links")}</Title>
			<Text type="secondary">{tx("沿着目标、行动与证据，查看 Agent 如何推进工作。", "Trace how agents advance through goals, actions and evidence.")}</Text></div>
			<Select aria-label={tx("筛选项目", "Filter project")} value={projectId || undefined} placeholder={tx("选择项目", "Select project")} onChange={setProjectId} options={projects.map((project) => ({ value: project.id, label: project.name }))} />
		</div>
		<Space className="work-process__tabs"><Button type={kind === "session" ? "primary" : "default"} onClick={() => setKind("session")}>{tx("对话", "Conversations")}</Button><Button type={kind === "engine" ? "primary" : "default"} onClick={() => setKind("engine")}>{tx("工程", "Engineering")}</Button></Space>
		{projectId ? <WorkProcessList key={`${projectId}:${kind}`} projectId={projectId} kind={kind} onSelect={setTarget} /> : <Empty description={tx("请先创建或选择项目", "Create or select a project first")} />}
	</div>;
}
