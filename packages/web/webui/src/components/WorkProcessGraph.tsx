import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Input, Segmented, Space, Tag, Tooltip } from "antd";
import { AimOutlined, FullscreenOutlined, MinusOutlined, PlusOutlined, SearchOutlined } from "@ant-design/icons";
import type { WorkEdgeKind, WorkNode, WorkProcess } from "../../../src/work-process-types.ts";
import { getLanguage } from "../i18n.ts";
import { layoutWorkGraph, layoutWorkProcess, routeWorkEdge, WORK_NODE_HEIGHT, WORK_NODE_WIDTH } from "./work-process-layout.ts";

export const workText = (zh: string, en: string) => getLanguage() === "en" ? en : zh;

export const WORK_STATUS = {
	unknown: ["待判断", "Unknown"], running: ["进行中", "Running"], done: ["已完成", "Done"],
	failed: ["失败", "Failed"], blocked: ["受阻", "Blocked"], abandoned: ["已放弃", "Abandoned"],
} as const;
const EDGE_LABELS: Record<WorkEdgeKind, [string, string]> = {
	contains: ["目标拆解", "Breakdown"], dispatch: ["派发", "Dispatch"], sequence: ["先后", "Sequence"],
	dependency: ["依赖", "Dependency"], pivot: ["转向", "Pivot"], merge: ["汇合", "Merge"],
};
const NODE_LABELS: Record<WorkNode["kind"], [string, string]> = {
	root: ["总目标", "Objective"], agent: ["Agent", "Agent"], task: ["任务", "Task"],
	goal: ["子目标", "Subgoal"], step: ["工作步骤", "Step"],
};
export function workEdgeLabel(kind: WorkEdgeKind): string { return workText(...EDGE_LABELS[kind]); }

export function WorkProcessGraph({ process, selectedId, onSelect, initialView = "tree" }: { process: WorkProcess; selectedId: string | null; onSelect: (node: WorkNode) => void; initialView?: "tree" | "graph" }) {
	const [view, setView] = useState<string>(initialView);
	const [collapsed, setCollapsed] = useState(new Set<string>());
	const [query, setQuery] = useState("");
	const [zoom, setZoom] = useState(1);
	const [fitted, setFitted] = useState<"width" | "all" | null>("width");
	const [relationFilter, setRelationFilter] = useState("flow");
	const [dragging, setDragging] = useState(false);
	const viewport = useRef<HTMLDivElement>(null);
	const drag = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | null>(null);
	const previousZoom = useRef(zoom);
	const markerId = useId().replace(/:/g, "");
	const positions = useMemo(() => layoutWorkProcess(process.nodes, collapsed, query), [process.nodes, collapsed, query]);
	const [page, setPage] = useState(0);
	const currentPage = Math.min(page, Math.max(0, Math.ceil(positions.length / 150) - 1));
	const visible = useMemo(() => view === "tree" ? positions.slice(currentPage * 150, (currentPage + 1) * 150)
		: layoutWorkGraph(positions.slice(currentPage * 150, (currentPage + 1) * 150), relationFilter === "structure" ? [] : process.edges), [positions, currentPage, view, relationFilter, process.edges]);
	const byId = new Map(visible.map((position) => [position.node.id, position]));
	const workflowTargets = new Set(process.edges.filter((edge) => edge.kind !== "contains" && edge.kind !== "dispatch"
		&& (byId.get(edge.from)?.x ?? Infinity) < (byId.get(edge.to)?.x ?? -Infinity)).map((edge) => edge.to));
	const edges = process.edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to) && (relationFilter === "all"
		|| (relationFilter === "structure" ? edge.kind === "contains" || edge.kind === "dispatch" : edge.kind !== "contains" && edge.kind !== "dispatch" || !workflowTargets.has(edge.to))));
	const routes = edges.map((edge, index) => routeWorkEdge(byId.get(edge.from)!, byId.get(edge.to)!, edge.kind, index, visible));
	const width = Math.max(560, ...visible.map((position) => position.x + WORK_NODE_WIDTH + 120), ...routes.map((route) => route.maxX + 32));
	const height = Math.max(320, ...visible.map((position) => position.y + WORK_NODE_HEIGHT + 40), ...routes.map((route) => route.maxY + 32));
	const parents = new Set(process.nodes.map((node) => node.parentId));
	const connected = new Set([selectedId]);
	for (const edge of edges) if (edge.from === selectedId || edge.to === selectedId) { connected.add(edge.from); connected.add(edge.to); }
	const hasSelection = selectedId !== null && byId.has(selectedId);
	const hasWorkflow = edges.some((edge) => edge.kind !== "contains" && edge.kind !== "dispatch");

	useLayoutEffect(() => {
		const element = viewport.current;
		if (view !== "graph" || !fitted || !element) return;
		const fit = () => setZoom(fitted === "all" ? Math.max(0.15, Math.min(1, (element.clientWidth - 24) / width, (element.clientHeight - 24) / height))
			: Math.max(0.65, Math.min(1, (element.clientWidth - 24) / width)));
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(element);
		return () => observer.disconnect();
	}, [view, fitted, width, height]);
	useLayoutEffect(() => {
		const element = viewport.current;
		if (element) {
			if (fitted) { element.scrollLeft = 0; element.scrollTop = fitted === "width" ? Math.max(0, (height * zoom - element.clientHeight) / 2) : 0; }
			else {
				const ratio = zoom / previousZoom.current;
				element.scrollLeft = (element.scrollLeft + element.clientWidth / 2) * ratio - element.clientWidth / 2;
				element.scrollTop = (element.scrollTop + element.clientHeight / 2) * ratio - element.clientHeight / 2;
			}
		}
		previousZoom.current = zoom;
	}, [zoom, fitted, view, height]);
	const toggle = (id: string) => {
		setCollapsed((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
		setPage(0);
	};
	return <section className="work-graph" aria-label={workText("工作链路图", "Work links graph")}>
		<div className="work-graph__toolbar">
			<Segmented value={view} onChange={(value) => setView(String(value))} options={[
				{ value: "tree", label: workText("目标树", "Goal tree") }, { value: "graph", label: workText("链路图", "Workflow graph") },
			]} />
			<Input allowClear prefix={<SearchOutlined />} value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }}
				placeholder={workText("搜索目标、步骤或结果", "Search goals, steps or outcomes")} aria-label={workText("搜索节点", "Search nodes")} />
			<Space size={4}>
				<Button size="small" onClick={() => { setCollapsed(new Set()); setPage(0); }}>{workText("全部展开", "Expand all")}</Button>
				<Button size="small" onClick={() => { setCollapsed(new Set(process.nodes.filter((node) => node.parentId !== null).map((node) => node.id))); setPage(0); }}>{workText("折叠", "Collapse")}</Button>
			</Space>
		</div>
		{view === "graph" ? <div className="work-graph__controls">
			<Segmented size="small" aria-label={workText("关系筛选", "Filter relationships")} value={relationFilter} onChange={(value) => setRelationFilter(String(value))} options={[
				{ value: "all", label: workText("全部关系", "All links") }, { value: "structure", label: workText("目标与派发", "Structure") }, { value: "flow", label: workText("工作链路", "Workflow") },
			]} />
			<Space size={4} wrap>
				<Button size="small" icon={<FullscreenOutlined />} onClick={() => { setFitted("all"); viewport.current?.scrollTo(0, 0); }}>{workText("适应视图", "Fit view")}</Button>
				<Tooltip title={workText("定位选中节点", "Locate selected node")}><Button size="small" icon={<AimOutlined />} disabled={!hasSelection}
					aria-label={workText("定位选中节点", "Locate selected node")} onClick={() => {
						const position = selectedId ? byId.get(selectedId) : undefined;
						const element = viewport.current;
						if (element && position) element.scrollTo({ left: (position.x + WORK_NODE_WIDTH / 2) * zoom - element.clientWidth / 2, top: (position.y + WORK_NODE_HEIGHT / 2) * zoom - element.clientHeight / 2 });
					}} /></Tooltip>
				<Button size="small" icon={<MinusOutlined />} aria-label={workText("缩小", "Zoom out")} disabled={zoom <= 0.15} onClick={() => { setFitted(null); setZoom((value) => Math.max(0.15, value - 0.1)); }} />
				<Button size="small" aria-label={workText("重置缩放", "Reset zoom")} onClick={() => { setFitted(null); setZoom(1); }}>{Math.round(zoom * 100)}%</Button>
				<Button size="small" icon={<PlusOutlined />} aria-label={workText("放大", "Zoom in")} disabled={zoom >= 1.5} onClick={() => { setFitted(null); setZoom((value) => Math.min(1.5, value + 0.1)); }} />
			</Space>
		</div> : null}
		<div className="work-graph__legend">
			<span><i className="work-graph__line-key" />{workText("实线：原始关系", "Solid: recorded")}</span><span><i className="work-graph__line-key is-inferred" />{workText("虚线：模型推断", "Dashed: inferred")}</span>
			{view === "graph" ? <><span className="work-graph__pivot-key">{workText("转向", "Pivot")}</span><span className="work-graph__merge-key">{workText("汇合", "Merge")}</span></> : null}
			<span className="work-graph__count">{visible.length} {workText("个节点", "nodes")}{view === "graph" ? ` / ${edges.length} ${workText("条关系", "links")}` : ""}</span>
		</div>
		{positions.length > 150 ? <Space className="work-graph__pages">
			<Button size="small" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{workText("上一组", "Previous")}</Button>
			<span>{currentPage * 150 + 1}–{Math.min((currentPage + 1) * 150, positions.length)} / {positions.length}</span>
			<Button size="small" disabled={(currentPage + 1) * 150 >= positions.length} onClick={() => setPage(currentPage + 1)}>{workText("下一组", "Next")}</Button>
		</Space> : null}
		{positions.length === 0 ? <Empty description={workText("没有匹配节点", "No matching nodes")} /> : view === "tree" ?
			<div className="work-tree" role="tree" aria-label={workText("目标树", "Goal tree")}>
				{visible.map(({ node, depth }) => <div className="work-tree__row" key={node.id} style={{ paddingInlineStart: Math.min(depth, 8) * 24 }}
					role="treeitem" aria-level={depth + 1} aria-selected={selectedId === node.id}>
					{parents.has(node.id) ? <Button size="small" type="text" aria-expanded={!collapsed.has(node.id)}
						aria-label={`${workText("展开或收起", "Expand or collapse")} ${node.title}`} onClick={() => toggle(node.id)}
						icon={collapsed.has(node.id) ? <PlusOutlined /> : <MinusOutlined />} /> : <span className="work-tree__spacer" />}
					<button type="button" className={selectedId === node.id ? "work-tree__node is-selected" : "work-tree__node"} onClick={() => onSelect(node)}>
						<span className={`work-status-dot is-${node.status}`} /><strong>{node.title}</strong>
						<span className="work-tree__intent">{node.intent}</span><Tag>{workText(WORK_STATUS[node.status][0], WORK_STATUS[node.status][1])}</Tag>
					</button>
				</div>)}
			</div> : <div ref={viewport} className={`work-graph__viewport${dragging ? " is-dragging" : ""}`} tabIndex={0} role="region" aria-label={workText("可滚动链路图", "Scrollable workflow graph")}
				onPointerDown={(event) => {
					if (event.button !== 0 || event.pointerType === "touch" || (event.target instanceof Element && event.target.closest("button"))) return;
					const element = event.currentTarget;
					drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
					element.setPointerCapture(event.pointerId);
					setDragging(true);
				}}
				onPointerMove={(event) => {
					if (!drag.current || drag.current.pointer !== event.pointerId) return;
					event.currentTarget.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
					event.currentTarget.scrollTop = drag.current.top - (event.clientY - drag.current.y);
				}}
				onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
				onLostPointerCapture={() => { drag.current = null; setDragging(false); }}>
				<div className="work-graph__surface" style={{ width: width * zoom, height: height * zoom }}>
					<div className="work-graph__canvas" style={{ width, height, transform: `scale(${zoom})` }}>
						<svg className="work-graph__edges" width={width} height={height} role="img" aria-label={workText("工作关系连线", "Work relationships")}>
							<title>{workText("工作关系连线", "Work relationships")}</title>
							<defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
							{edges.map((edge, index) => {
								const from = byId.get(edge.from); const to = byId.get(edge.to);
								if (!from || !to) return null;
								const route = routes[index];
								const active = hasSelection && (edge.from === selectedId || edge.to === selectedId);
								const context = relationFilter !== "structure" && hasWorkflow && edge.kind === "contains" && !active;
								return <g key={edge.id} className={`work-graph__edge is-${edge.kind}${context ? " is-context" : ""}${active ? " is-active" : hasSelection ? " is-muted" : ""}`}>
									<title>{`${workEdgeLabel(edge.kind)}：${edge.reason}`}</title>
									<path d={route.path} fill="none" stroke="currentColor" strokeDasharray={edge.basis === "inferred" ? "5 4" : undefined} markerEnd={`url(#${markerId})`} />
									{!context ? <text x={route.labelX} y={route.labelY} textAnchor={to.x !== from.x ? "middle" : "start"}>{workEdgeLabel(edge.kind)}</text> : null}
								</g>;
							})}
						</svg>
						{visible.map(({ node, x, y }) => <div key={node.id} className={`work-graph__position${hasSelection && !connected.has(node.id) ? " is-muted" : ""}`} style={{ left: x, top: y }}>
							<button type="button" aria-pressed={selectedId === node.id} className={`work-graph__node is-${node.kind}${selectedId === node.id ? " is-selected" : ""}`} onClick={() => onSelect(node)}>
								<span className="work-graph__node-kind">{workText(...NODE_LABELS[node.kind])}<span>{node.evidenceIds.length} {workText("条证据", "records")}</span></span>
								<span className="work-graph__node-head"><strong title={node.title}>{node.title}</strong></span>
								<span className="work-graph__node-intent">{node.intent || workText("等待记录", "Waiting for records")}</span>
								<span className="work-graph__node-meta"><span><span className={`work-status-dot is-${node.status}`} />{workText(WORK_STATUS[node.status][0], WORK_STATUS[node.status][1])}</span>
									<span>{node.intentBasis === "inferred" ? workText("模型推断", "Inferred") : node.intentBasis === "explicit" ? workText("明确表达", "Explicit") : workText("无法判断", "Unknown")}</span></span>
							</button>
							{parents.has(node.id) ? <Tooltip title={workText("展开或收起", "Expand or collapse")}><Button size="small" className="work-graph__collapse"
								aria-label={`${workText("展开或收起", "Expand or collapse")} ${node.title}`} aria-expanded={!collapsed.has(node.id)}
								icon={collapsed.has(node.id) ? <PlusOutlined /> : <MinusOutlined />} onClick={() => toggle(node.id)} /></Tooltip> : null}
						</div>)}
					</div>
				</div>
			</div>}
		<div className="work-graph__hint">{view === "graph" ? workText("按先后、依赖、转向与汇合关系从左向右展开；目标归属见目标树。拖动空白处浏览。", "Workflow links progress left to right. See Goal tree for ownership. Drag the canvas to explore.") : workText("展开目标分支，点击步骤查看证据", "Expand branches and select a step to inspect evidence.")}</div>
	</section>;
}
