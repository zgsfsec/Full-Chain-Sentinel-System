import type { WorkEdge, WorkNode } from "../../../src/work-process-types.ts";

export const WORK_NODE_WIDTH = 256;
export const WORK_NODE_HEIGHT = 132;

export interface WorkPosition { node: WorkNode; x: number; y: number; depth: number }

/** Parent links define the tree projection; other edges never change hierarchy. */
export function layoutWorkProcess(nodes: WorkNode[], collapsed: Set<string>, query = ""): WorkPosition[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const children = new Map<string | null, WorkNode[]>();
	const needle = query.trim().toLocaleLowerCase();
	const included = new Set<string>();
	if (needle) {
		for (const node of nodes) {
			if (![node.title, node.intent, ...node.actions, ...node.outcomes].join("\n").toLocaleLowerCase().includes(needle)) continue;
			let ancestor: WorkNode | undefined = node;
			const path = new Set<string>();
			while (ancestor && !path.has(ancestor.id)) {
				path.add(ancestor.id); included.add(ancestor.id);
				ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
			}
		}
	}
	for (const node of nodes) {
		if (needle && !included.has(node.id)) continue;
		const parentId = node.parentId && byId.has(node.parentId) ? node.parentId : null;
		const siblings = children.get(parentId) ?? [];
		siblings.push(node); children.set(parentId, siblings);
	}
	const result: WorkPosition[] = [];
	const visited = new Set<string>();
	const stack = (children.get(null) ?? []).map((node) => ({ node, depth: 0 })).reverse();
	while (stack.length) {
		const entry = stack.pop();
		if (!entry || visited.has(entry.node.id)) continue;
		visited.add(entry.node.id);
		result.push({ ...entry, x: 28 + entry.depth * 290, y: 28 + result.length * 128 });
		if (!needle && collapsed.has(entry.node.id)) continue;
		const descendants = children.get(entry.node.id) ?? [];
		for (let index = descendants.length - 1; index >= 0; index--) stack.push({ node: descendants[index], depth: entry.depth + 1 });
	}
	return result;
}

/** Place branches on separate rows and center each parent over its visible children. */
export function layoutWorkGraph(positions: WorkPosition[], edges: WorkEdge[] = []): WorkPosition[] {
	const byId = new Map(positions.map((position) => [position.node.id, position]));
	const workflow = edges.filter((edge) => edge.kind !== "contains" && edge.kind !== "dispatch" && edge.from !== edge.to && byId.has(edge.from) && byId.has(edge.to));
	if (workflow.length) {
		const outgoing = new Map(positions.map(({ node }) => [node.id, new Set<string>()]));
		for (const { node } of positions) if (node.parentId && byId.has(node.parentId)) outgoing.get(node.parentId)?.add(node.id);
		for (const edge of edges) if (edge.from !== edge.to && byId.has(edge.from) && byId.has(edge.to)) outgoing.get(edge.from)?.add(edge.to);
		// Remove only feedback constraints for ranking. All original links remain visible, including cycles.
		const state = new Map<string, number>();
		const forward = new Map(positions.map(({ node }) => [node.id, new Set<string>()]));
		for (const { node } of positions) {
			if (state.has(node.id)) continue;
			state.set(node.id, 1);
			const stack = [{ id: node.id, next: [...(outgoing.get(node.id) ?? [])], index: 0 }];
			while (stack.length) {
				const current = stack[stack.length - 1];
				const next = current.next[current.index++];
				if (next === undefined) { state.set(current.id, 2); stack.pop(); continue; }
				if (state.get(next) === 1) continue;
				forward.get(current.id)?.add(next);
				if (!state.has(next)) { state.set(next, 1); stack.push({ id: next, next: [...(outgoing.get(next) ?? [])], index: 0 }); }
			}
		}
		const incoming = new Map(positions.map(({ node }) => [node.id, [] as string[]]));
		for (const [from, targets] of forward) for (const to of targets) incoming.get(to)?.push(from);
		const degree = new Map([...incoming].map(([id, sources]) => [id, sources.length]));
		const rank = new Map(positions.map(({ node }) => [node.id, 0]));
		const queue = positions.filter(({ node }) => degree.get(node.id) === 0).map(({ node }) => node.id);
		for (let index = 0; index < queue.length; index++) {
			const from = queue[index];
			for (const to of forward.get(from) ?? []) {
				rank.set(to, Math.max(rank.get(to) ?? 0, (rank.get(from) ?? 0) + 1));
				const remaining = (degree.get(to) ?? 0) - 1;
				degree.set(to, remaining);
				if (remaining === 0) queue.push(to);
			}
		}
		const layers = new Map<number, WorkPosition[]>();
		for (const position of positions) {
			const column = rank.get(position.node.id) ?? 0;
			const layer = layers.get(column) ?? [];
			layer.push(position); layers.set(column, layer);
		}
		// Align by workflow, using ownership only to anchor the start of each branch.
		// A root containing every step must not pull every later step back toward itself.
		const alignmentIn = new Map(positions.map(({ node }) => [node.id, [] as string[]]));
		const alignmentOut = new Map(positions.map(({ node }) => [node.id, [] as string[]]));
		for (const edge of workflow) if (forward.get(edge.from)?.has(edge.to)) alignmentIn.get(edge.to)?.push(edge.from);
		for (const { node } of positions) {
			if (!alignmentIn.get(node.id)?.length) alignmentIn.set(node.id, incoming.get(node.id) ?? []);
			for (const source of alignmentIn.get(node.id) ?? []) alignmentOut.get(source)?.push(node.id);
		}
		const columns = [...layers].sort(([a], [b]) => a - b).map(([, layer]) => layer);
		const rows = new Map<string, number>();
		for (const layer of columns) layer.forEach(({ node }, index) => rows.set(node.id, index - (layer.length - 1) / 2));
		// Alternating sweeps center both splits and joins. Pool adjacent constraints so
		// collisions move the whole group equally, rather than pushing every node down.
		for (let sweep = 0; sweep < 12; sweep++) {
			const neighbors = sweep % 2 ? alignmentOut : alignmentIn;
			for (const layer of sweep % 2 ? [...columns].reverse() : columns) {
				const preferred = new Map(layer.map(({ node }) => {
					const connected = neighbors.get(node.id) ?? [];
					return [node.id, connected.length ? connected.reduce((sum, id) => sum + (rows.get(id) ?? 0), 0) / connected.length : rows.get(node.id) ?? 0];
				}));
				layer.sort((a, b) => (preferred.get(a.node.id) ?? 0) - (preferred.get(b.node.id) ?? 0));
				const blocks: { start: number; end: number; sum: number; count: number }[] = [];
				layer.forEach(({ node }, index) => {
					blocks.push({ start: index, end: index, sum: (preferred.get(node.id) ?? 0) - index, count: 1 });
					while (blocks.length > 1) {
						const right = blocks[blocks.length - 1]; const left = blocks[blocks.length - 2];
						if (left.sum / left.count <= right.sum / right.count) break;
						left.end = right.end; left.sum += right.sum; left.count += right.count; blocks.pop();
					}
				});
				for (const block of blocks) for (let index = block.start; index <= block.end; index++) rows.set(layer[index].node.id, block.sum / block.count + index);
			}
		}
		const top = Math.min(...rows.values());
		return positions.map((position) => ({ ...position, depth: rank.get(position.node.id) ?? 0, x: 40 + (rank.get(position.node.id) ?? 0) * 360, y: 64 + ((rows.get(position.node.id) ?? 0) - top) * 184 }));
	}
	const children = new Map<string, string[]>();
	for (const { node } of positions) {
		if (!node.parentId || !byId.has(node.parentId)) continue;
		const siblings = children.get(node.parentId) ?? [];
		siblings.push(node.id);
		children.set(node.parentId, siblings);
	}
	const rows = new Map<string, number>();
	let row = 0;
	for (let index = positions.length - 1; index >= 0; index--) {
		const { node } = positions[index];
		const descendants = children.get(node.id) ?? [];
		const first = rows.get(descendants[0]);
		const last = rows.get(descendants[descendants.length - 1]);
		rows.set(node.id, first !== undefined && last !== undefined ? (first + last) / 2 : row++);
	}
	const minDepth = positions.length ? Math.min(...positions.map(({ depth }) => depth)) : 0;
	return positions.map((position) => ({
		...position,
		x: 40 + (position.depth - minDepth) * 360,
		y: 40 + (row - 1 - (rows.get(position.node.id) ?? 0)) * 184,
	}));
}

/** Route cross-column links through the nearest clear gap in their own span. */
export function routeWorkEdge(from: WorkPosition, to: WorkPosition, kind: WorkEdge["kind"], lane = 0, positions: WorkPosition[] = [from, to]) {
	const y1 = from.y + WORK_NODE_HEIGHT / 2;
	const y2 = to.y + WORK_NODE_HEIGHT / 2;
	const x1 = from.x + WORK_NODE_WIDTH;
	if (to.x > from.x && to.x - from.x <= 360) {
		const middle = (x1 + to.x) / 2;
		return { path: `M${x1},${y1} C${middle},${y1} ${middle},${y2} ${to.x},${y2}`, labelX: middle, labelY: (y1 + y2) / 2 - 8, maxX: to.x, maxY: Math.max(y1, y2) };
	}
	const sourceX = x1 + 24 + (lane % 3) * 8;
	const targetPort = to.x > from.x ? to.x : to.x + WORK_NODE_WIDTH;
	const targetX = targetPort + (to.x > from.x ? -24 : 24) + (lane % 3) * 8;
	let channelY = (y1 + y2) / 2;
	if (to.x !== from.x) {
		const left = Math.min(sourceX, targetX); const right = Math.max(sourceX, targetX);
		const obstacles = positions.filter(({ x }) => x < right && x + WORK_NODE_WIDTH > left);
		const clearance = 24 + (lane % 4) * 6;
		const candidates = [y1, y2, channelY, ...obstacles.flatMap(({ y }) => [Math.max(16, y - clearance), y + WORK_NODE_HEIGHT + clearance])];
		const clear = candidates.filter((y) => obstacles.every((node) => y <= node.y - 16 || y >= node.y + WORK_NODE_HEIGHT + 16));
		clear.sort((a, b) => (Math.abs(a - y1) + Math.abs(a - y2) + Math.abs(a - channelY) * 0.1) - (Math.abs(b - y1) + Math.abs(b - y2) + Math.abs(b - channelY) * 0.1));
		channelY = clear[0] ?? channelY;
	}
	const outside = Math.max(sourceX, targetX);
	const targetY = y1 === y2 && to.x === from.x ? y2 + (kind === "pivot" ? 24 : -24) : y2;
	const points = to.x === from.x ? [[x1, y1], [outside, y1], [outside, targetY], [targetPort, targetY]]
		: [[x1, y1], [sourceX, y1], [sourceX, channelY], [targetX, channelY], [targetX, y2], [targetPort, y2]];
	let path = `M${points[0][0]},${points[0][1]}`;
	for (let index = 1; index < points.length - 1; index++) {
		const [x, y] = points[index]; const [previousX, previousY] = points[index - 1]; const [nextX, nextY] = points[index + 1];
		const radius = Math.min(8, Math.hypot(x - previousX, y - previousY) / 2, Math.hypot(nextX - x, nextY - y) / 2);
		path += ` L${x - Math.sign(x - previousX) * radius},${y - Math.sign(y - previousY) * radius} Q${x},${y} ${x + Math.sign(nextX - x) * radius},${y + Math.sign(nextY - y) * radius}`;
	}
	path += ` L${targetPort},${targetY}`;
	return {
		path,
		labelX: to.x === from.x ? outside + 6 : (sourceX + targetX) / 2,
		labelY: to.x === from.x ? (y1 + targetY) / 2 : channelY - 8,
		maxX: Math.max(...points.map(([x]) => x)) + 24,
		maxY: Math.max(...points.map(([, y]) => y)) + 24,
	};
}
