import type { AuxiliaryModelReply } from "../src/auxiliary-model.ts";
import { workStructuralNode } from "../src/work-process-source.ts";
import type { WorkEvidence, WorkNode, WorkProcess, WorkSourceSnapshot } from "../src/work-process-types.ts";

export function workEvidence(id: string, overrides: Partial<WorkEvidence> = {}): WorkEvidence {
	return {
		id,
		ownerId: "s1",
		at: 1_700_000_000_000,
		kind: "assistant",
		text: "确认接口权限",
		entryId: id,
		truncated: false,
		...overrides,
	};
}

export function workSnapshot(entries = [workEvidence("e1")]): WorkSourceSnapshot {
	return {
		source: {
			id: "s1",
			kind: "session",
			projectId: "p1",
			projectName: "测试项目",
			title: "权限检查",
			updatedAt: 1,
			active: false,
		},
		nodes: [
			workStructuralNode({
				id: "root",
				ownerId: "s1",
				parentId: null,
				kind: "root",
				title: "权限检查",
				startedAt: 1,
			}),
		],
		edges: [],
		lanes: [{ ownerId: "s1", parentId: "root", evidence: entries }],
	};
}

export function workGraph(): WorkProcess {
	const snapshot = workSnapshot();
	return {
		...snapshot.source,
		enabled: false,
		running: false,
		error: null,
		nodes: snapshot.nodes,
		edges: [],
		evidence: snapshot.lanes[0].evidence,
		consumed: {},
		pending: 1,
		revision: 0,
		model: null,
		usage: { input: 0, output: 0, total: 0 },
		lastAnalyzedAt: null,
	};
}

export function workReply(input: string): AuxiliaryModelReply & { model: string } {
	const data = JSON.parse(input) as { nodes: WorkNode[]; parentId: string; records: WorkEvidence[] };
	const previous = [...data.nodes].reverse().find((node) => node.kind === "step");
	return {
		model: "test-analysis",
		finishReason: "stop",
		rawFinishReason: "stop",
		reasoning: "",
		usage: { input: 10, output: 20, total: 30 },
		content: JSON.stringify({
			nodes: [
				{
					id: previous?.id ?? "new-1",
					kind: "step",
					parentId: data.parentId,
					title: "确认接口权限",
					intent: "验证接口权限控制",
					intentBasis: "inferred",
					quote: "",
					status: data.records.some((entry) => entry.kind === "tool_end") ? "done" : "running",
					actions: ["检查接口"],
					outcomes: ["等待进一步证据"],
					evidenceIds: data.records.map((entry) => entry.id),
					confidence: 0.8,
				},
			],
			edges: [],
		}),
	};
}
