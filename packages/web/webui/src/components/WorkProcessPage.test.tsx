import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { workGraph } from "../../../test/work-process-fixtures.ts";
import type { WorkEdge, WorkNode } from "../../../src/work-process-types.ts";
import { layoutWorkGraph, layoutWorkProcess, routeWorkEdge, WORK_NODE_HEIGHT, WORK_NODE_WIDTH } from "./work-process-layout.ts";
import { WorkNodeDetails, WorkProcessPage } from "./WorkProcessPage.tsx";
import { WorkProcessGraph } from "./WorkProcessGraph.tsx";
import { NAV_GROUPS } from "../shell/navigation.tsx";

describe("work process UI", () => {
	test("adds an independent sidebar destination and explains the opt-in empty state", () => {
		expect(NAV_GROUPS.find((group) => group.group === "执行与审计")?.items.some((item) => item.page === "work-process")).toBe(true);
		const html = renderToStaticMarkup(<WorkProcessPage projects={[]} activeProjectId={null} />);
		expect(html).toContain("工作链路"); expect(html).toContain("请先创建或选择项目");
	});

	test("renders goal hierarchy, semantic statuses, keyboard buttons and graph controls", () => {
		const graph = workGraph();
		graph.nodes.push({ ...graph.nodes[0], id: "step", parentId: "root", kind: "step", title: "验证权限", status: "failed", intentBasis: "inferred" });
		const html = renderToStaticMarkup(<WorkProcessGraph process={graph} selectedId="step" onSelect={() => {}} />);
		expect(html).toContain("目标树"); expect(html).toContain("链路图"); expect(html).toContain("验证权限");
		expect(html).toContain('role="tree"'); expect(html).toContain('aria-selected="true"'); expect(html).toContain("失败");
		expect(html).toContain("虚线：模型推断"); expect(html).toContain("全部展开");
	});

	test("node detail distinguishes inferred intent, exposes raw evidence, pivot reasons and revisions", () => {
		const graph = workGraph();
		const node: WorkNode = { ...graph.nodes[0], id: "step", parentId: "root", kind: "step", title: "改用其他接口", intent: "当前接口未发现越权，转向其他接口", intentBasis: "inferred",
			status: "running", actions: ["检查接口权限"], outcomes: ["访问被拒绝"], evidenceIds: ["e1"], confidence: 0.8, revision: 1 };
		graph.nodes.push(node); graph.edges.push({ id: "pivot", from: "root", to: "step", kind: "pivot", basis: "inferred", reason: "当前路径未发现越权", evidenceIds: ["e1"] });
		const html = renderToStaticMarkup(<WorkNodeDetails process={graph} node={node} onHistory={() => {}} onEvidence={() => {}} revisions={[{ revision: 1, at: 1, nodes: [node], edges: [] }]} />);
		expect(html).toContain("模型推断"); expect(html).toContain("80%"); expect(html).toContain("当前路径未发现越权");
		expect(html).toContain("原始记录"); expect(html).toContain("查看修订历史"); expect(html).toContain("访问被拒绝");
	});

	test("collapses branches, searches ancestors, and keeps stable layout across updates", () => {
		const root = workGraph().nodes[0];
		const nodes: WorkNode[] = [root, { ...root, id: "task", parentId: "root", kind: "task", title: "任务" },
			{ ...root, id: "child", parentId: "task", kind: "step", title: "权限验证" }, { ...root, id: "other", parentId: "root", kind: "step", title: "其他路径" }];
		expect(layoutWorkProcess(nodes, new Set(["task"])).map((position) => position.node.id)).toEqual(["root", "task", "other"]);
		expect(layoutWorkProcess(nodes, new Set(["task"]), "权限").map((position) => position.node.id)).toEqual(["root", "task", "child"]);
		const before = layoutWorkProcess(nodes, new Set()).map(({ x, y }) => ({ x, y }));
		nodes[2] = { ...nodes[2], status: "done", revision: 2 };
		expect(layoutWorkProcess(nodes, new Set()).map(({ x, y }) => ({ x, y }))).toEqual(before);
	});

	test("large trees remain iterative and malformed cycles cannot loop indefinitely", () => {
		const root = workGraph().nodes[0];
		const nodes = Array.from({ length: 5000 }, (_, index): WorkNode => ({ ...root, id: String(index), parentId: index === 0 ? null : String(index - 1) }));
		expect(layoutWorkProcess(nodes, new Set())).toHaveLength(5000);
		expect(layoutWorkProcess([{ ...root, id: "a", parentId: "b" }, { ...root, id: "b", parentId: "a" }], new Set(), "权限")).toEqual([]);
	});

	test("graph packs branches without overlapping cards and centers parents between children", () => {
		const root = workGraph().nodes[0];
		const nodes: WorkNode[] = [root,
			{ ...root, id: "a", parentId: "root" }, { ...root, id: "b", parentId: "root" },
			{ ...root, id: "a1", parentId: "a" }, { ...root, id: "a2", parentId: "a" },
			{ ...root, id: "b1", parentId: "b" },
		];
		const positions = layoutWorkGraph(layoutWorkProcess(nodes, new Set()));
		const byId = new Map(positions.map((position) => [position.node.id, position]));
		const a = byId.get("a")!; const a1 = byId.get("a1")!; const a2 = byId.get("a2")!;
		expect(a.y).toBe((a1.y + a2.y) / 2);
		expect(a1.x).toBeGreaterThan(a.x + WORK_NODE_WIDTH);
		expect(Math.abs(a1.y - a2.y)).toBeGreaterThan(WORK_NODE_HEIGHT);
		for (const first of positions) for (const second of positions) {
			if (first.node.id === second.node.id) continue;
			expect(Math.abs(first.x - second.x) >= WORK_NODE_WIDTH || Math.abs(first.y - second.y) >= WORK_NODE_HEIGHT).toBe(true);
		}
		expect(positions.map(({ node }) => node.id)).toEqual(["root", "a", "a1", "a2", "b", "b1"]);
		const updated = nodes.map((node) => ({ ...node, status: "done" as const }));
		expect(layoutWorkGraph(layoutWorkProcess(updated, new Set())).map(({ x, y }) => ({ x, y }))).toEqual(positions.map(({ x, y }) => ({ x, y })));
	});

	test("single chains stay on one row and later pages do not inherit empty depth columns", () => {
		const root = workGraph().nodes[0];
		const nodes = Array.from({ length: 300 }, (_, index): WorkNode => ({ ...root, id: String(index), parentId: index ? String(index - 1) : null }));
		const positions = layoutWorkGraph(layoutWorkProcess(nodes, new Set()).slice(150));
		expect(positions[0].x).toBe(40);
		expect(new Set(positions.map(({ y }) => y)).size).toBe(1);
		expect(layoutWorkGraph([])).toEqual([]);
	});

	test("routes sibling workflow links around cards and keeps hierarchy links between side ports", () => {
		const root = workGraph().nodes[0];
		const from = { node: root, x: 40, y: 40, depth: 0 };
		const child = { ...from, x: 400 };
		const sibling = { ...from, y: 224 };
		const hierarchy = routeWorkEdge(from, child, "dispatch");
		expect(hierarchy.path).toBe("M296,106 C348,106 348,106 400,106");
		const workflow = routeWorkEdge(from, sibling, "pivot");
		expect(workflow.labelX).toBeGreaterThan(from.x + WORK_NODE_WIDTH);
		expect(workflow.path).toContain("Q");
		expect(workflow.path.endsWith("L296,290")).toBe(true);
		const backward = routeWorkEdge(child, from, "dependency");
		expect(backward.labelY).toBeLessThan(from.y);
		expect(backward.path).toMatch(/^M656,106 L/);
		expect(backward.path.endsWith("L296,106")).toBe(true);
	});

	test("a flat 26-node goal tree becomes multiple workflow layers without changing ownership", () => {
		const root = workGraph().nodes[0];
		const nodes: WorkNode[] = [root, ...Array.from({ length: 25 }, (_, index): WorkNode => ({ ...root, id: `s${index}`, kind: "step", parentId: root.id }))];
		const edges: WorkEdge[] = Array.from({ length: 24 }, (_, index) => ({ id: `link${index}`, from: `s${index}`, to: `s${index + 1}`, kind: index % 3 === 0 ? "pivot" : "sequence", basis: "inferred", reason: "记录支持的工作推进", evidenceIds: ["e1"] }));
		const before = structuredClone(nodes);
		const tree = layoutWorkProcess(nodes, new Set());
		expect(new Set(tree.map(({ depth }) => depth)).size).toBe(2);
		const graph = layoutWorkGraph(tree, edges);
		expect(new Set(graph.map(({ x }) => x)).size).toBe(26);
		for (const edge of edges) expect(graph.find(({ node }) => node.id === edge.to)!.x).toBeGreaterThan(graph.find(({ node }) => node.id === edge.from)!.x);
		expect(nodes).toEqual(before);
	});

	test("balances unequal workflow branches above and below the objective without overlap", () => {
		const root = workGraph().nodes[0];
		const ids = ["a", "a1", "a2", "b", "b1", "c", "c1", "c2", "c3", "join"];
		const nodes: WorkNode[] = [root, ...ids.map((id): WorkNode => ({ ...root, id, parentId: root.id, kind: "step" }))];
		const edges: WorkEdge[] = [["a", "a1"], ["a1", "a2"], ["b", "b1"], ["c", "c1"], ["c1", "c2"], ["c2", "c3"], ["a2", "join"], ["b1", "join"], ["c3", "join"]]
			.map(([from, to], index) => ({ id: String(index), from, to, kind: "sequence", basis: "inferred", reason: "依据", evidenceIds: [] }));
		const graph = layoutWorkGraph(layoutWorkProcess(nodes, new Set()), edges);
		const byId = new Map(graph.map((position) => [position.node.id, position]));
		const starts = ["a", "b", "c"].map((id) => byId.get(id)!);
		const objective = byId.get(root.id)!;
		expect(Math.min(...starts.map(({ y }) => y))).toBeLessThan(objective.y);
		expect(Math.max(...starts.map(({ y }) => y))).toBeGreaterThan(objective.y);
		expect(objective.y).toBeCloseTo(starts.reduce((sum, { y }) => sum + y, 0) / starts.length);
		for (const first of graph) for (const second of graph) {
			if (first.node.id === second.node.id) continue;
			expect(Math.abs(first.x - second.x) >= WORK_NODE_WIDTH || Math.abs(first.y - second.y) >= WORK_NODE_HEIGHT + 40).toBe(true);
		}
		expect(Math.max(...graph.map(({ y }) => y)) - Math.min(...graph.map(({ y }) => y))).toBeLessThan(600);
		for (const edge of edges) expect(byId.get(edge.to)!.x).toBeGreaterThan(byId.get(edge.from)!.x);
	});

	test("long links use local clear channels and their bounds include the entire route", () => {
		const root = workGraph().nodes[0];
		const from = { node: root, x: 40, y: 400, depth: 0 };
		const middle = { ...from, x: 400, y: 380 };
		const to = { ...from, x: 760, y: 584 };
		const above = { ...middle, y: 40 };
		const positions = [from, middle, to, above];
		for (const [source, target] of [[from, to], [to, from]]) {
			const route = routeWorkEdge(source, target, "merge", 1, positions);
			const channel = route.labelY + 8;
			expect(channel).toBeGreaterThan(above.y + WORK_NODE_HEIGHT);
			for (const obstacle of positions) expect(channel <= obstacle.y - 16 || channel >= obstacle.y + WORK_NODE_HEIGHT + 16).toBe(true);
			expect(route.maxY).toBeGreaterThanOrEqual(Math.max(channel, source.y + WORK_NODE_HEIGHT / 2, target.y + WORK_NODE_HEIGHT / 2));
			expect(route.maxX).toBeGreaterThanOrEqual(Math.max(source.x, target.x));
		}
	});

	test("keeps parallel branches separate, merges to a later layer, and tolerates feedback cycles", () => {
		const root = workGraph().nodes[0];
		const nodes: WorkNode[] = [root, ...["a", "b", "c", "d"].map((id): WorkNode => ({ ...root, id, parentId: root.id, kind: "step" }))];
		const edges: WorkEdge[] = [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"], ["d", "a"]].map(([from, to], index) => ({ id: String(index), from, to, kind: "dependency", basis: "inferred", reason: "依据", evidenceIds: [] }));
		const positions = layoutWorkProcess(nodes, new Set());
		const graph = layoutWorkGraph(positions, edges);
		const byId = new Map(graph.map((position) => [position.node.id, position]));
		expect(byId.get("b")!.x).toBe(byId.get("c")!.x);
		expect(Math.abs(byId.get("b")!.y - byId.get("c")!.y)).toBeGreaterThanOrEqual(WORK_NODE_HEIGHT);
		expect(byId.get("d")!.x).toBeGreaterThan(byId.get("b")!.x);
		expect(graph.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
		expect(layoutWorkGraph(positions.map((position) => ({ ...position, node: { ...position.node, status: "done" } })), edges).map(({ x, y }) => ({ x, y }))).toEqual(graph.map(({ x, y }) => ({ x, y })));
		expect(layoutWorkGraph(layoutWorkProcess(nodes, new Set([root.id])), edges)).toHaveLength(1);
	});
});
