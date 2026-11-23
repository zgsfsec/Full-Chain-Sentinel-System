import { describe, expect, test } from "vitest";
import { applyWorkProcessAnalysis, buildWorkProcessInput } from "../src/work-process-analysis.ts";
import type { WorkEvidence, WorkNode } from "../src/work-process-types.ts";
import { workEvidence, workGraph, workSnapshot } from "./work-process-fixtures.ts";

function output(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		nodes: [
			{
				id: "new-1",
				kind: "step",
				parentId: "root",
				title: "权限检查",
				intent: "确认接口权限",
				intentBasis: "explicit",
				quote: "确认接口权限",
				status: "running",
				actions: [],
				outcomes: [],
				evidenceIds: ["e1"],
				confidence: 0.8,
				...overrides,
			},
		],
		edges: [],
	});
}

interface ContextNode {
	id: string;
	previousEvidenceIds: string[];
	intentEvidence?: { id: string; text: string };
}

describe("work-link intent evidence", () => {
	test.each(["user", "assistant", "instruction"] as const)(
		"retains verified %s wording and accepts it when history is automatically preserved",
		(kind) => {
			const process = workGraph();
			process.evidence = [workEvidence("e1", { kind })];
			const lane = workSnapshot(process.evidence).lanes[0];
			const previous = applyWorkProcessAnalysis(process, lane, process.evidence, output()).nodes[0];
			expect(previous.intentQuote).toEqual({ evidenceId: "e1", text: "确认接口权限" });
			process.nodes.push(previous);
			const batch = [workEvidence("e2", { kind: "tool_end", text: "接口返回 403" })];
			const before = structuredClone(process);
			const updated = applyWorkProcessAnalysis(
				process,
				lane,
				batch,
				output({ id: previous.id, evidenceIds: ["e2"], status: "done" }),
			).nodes[0];
			expect(updated).toMatchObject({
				intentBasis: "explicit",
				intentQuote: previous.intentQuote,
				evidenceIds: ["e1", "e2"],
			});
			expect(process).toEqual(before);
		},
	);

	test("provides the original verified wording beyond the recent-history and excerpt limits", () => {
		const process = workGraph();
		process.evidence = [workEvidence("e1", { text: `${"前文".repeat(1000)}确认接口权限` })];
		const lane = workSnapshot(process.evidence).lanes[0];
		const node = applyWorkProcessAnalysis(process, lane, process.evidence, output()).nodes[0];
		for (let index = 0; index < 20; index++) {
			const entry = workEvidence(`tool${index}`, { kind: "tool_end", text: "工具结果" });
			process.evidence.push(entry);
			node.evidenceIds.push(entry.id);
		}
		process.nodes.push(node);
		const before = structuredClone(process);
		for (const compact of [false, true]) {
			const input = JSON.parse(buildWorkProcessInput(process, lane, [workEvidence("next")], compact)) as {
				nodes: ContextNode[];
			};
			const context = input.nodes.find((item) => item.id === node.id)!;
			expect(context.intentEvidence).toEqual({ id: "e1", text: "确认接口权限" });
			expect(context.previousEvidenceIds).toContain("e1");
			expect(context.previousEvidenceIds.length).toBeLessThanOrEqual(6);
		}
		expect(process).toEqual(before);
	});

	test("offers a bounded message excerpt for previously saved nodes without a retained quote", () => {
		const process = workGraph();
		const node: WorkNode = {
			...process.nodes[0],
			id: "previous",
			kind: "step",
			parentId: "root",
			evidenceIds: ["e1"],
		};
		process.nodes.push(node);
		process.evidence[0].text = "确认接口权限".repeat(500);
		const lane = workSnapshot().lanes[0];
		for (const compact of [false, true]) {
			const input = JSON.parse(buildWorkProcessInput(process, lane, [workEvidence("e2")], compact)) as {
				nodes: ContextNode[];
			};
			expect(input.nodes.find((item) => item.id === node.id)?.intentEvidence).toEqual({
				id: "e1",
				text: process.evidence[0].text.slice(0, compact ? 320 : 600),
			});
		}
	});

	test.each(["tool_start", "tool_end", "status"] as const)(
		"never treats %s as a direct expression of intent",
		(kind) => {
			const process = workGraph();
			const batch = [workEvidence("e1", { kind })];
			const lane = workSnapshot(batch).lanes[0];
			const before = structuredClone(process);
			expect(() => applyWorkProcessAnalysis(process, lane, batch, output())).toThrow("不能改写、拼接或引用工具输出");
			expect(process).toEqual(before);
		},
	);

	test.each([undefined, "", "确认 API 权限", "确认…权限"])(
		"rejects missing or rewritten wording %s with actionable node feedback",
		(quote) => {
			const process = workGraph();
			const lane = workSnapshot().lanes[0];
			expect(() => applyWorkProcessAnalysis(process, lane, lane.evidence, output({ quote }))).toThrow(
				/节点 new-1.*改为「模型推断」/,
			);
		},
	);

	test("does not borrow another node's retained quote or accept an outdated source", () => {
		const process = workGraph();
		const lane = workSnapshot().lanes[0];
		const node = applyWorkProcessAnalysis(process, lane, lane.evidence, output()).nodes[0];
		process.nodes.push(node);
		const batch = [workEvidence("e2", { kind: "tool_end", text: "工具结果" })];
		expect(() => applyWorkProcessAnalysis(process, lane, batch, output({ evidenceIds: ["e2"] }))).toThrow(
			"缺少对应原文",
		);
		process.evidence[0].text = "历史原文已变化";
		expect(() =>
			applyWorkProcessAnalysis(process, lane, batch, output({ id: node.id, evidenceIds: ["e2"] })),
		).toThrow("缺少对应原文");
		const input = JSON.parse(buildWorkProcessInput(process, lane, batch)) as { nodes: ContextNode[] };
		expect(input.nodes.find((item) => item.id === node.id)?.intentEvidence?.text).toBe("历史原文已变化");
	});

	test("excludes another Agent's messages from intent context and validation", () => {
		const process = workGraph();
		const lane = workSnapshot().lanes[0];
		const node = applyWorkProcessAnalysis(process, lane, lane.evidence, output()).nodes[0];
		process.nodes.push(node);
		process.evidence[0].ownerId = "other-agent";
		const batch: WorkEvidence[] = [workEvidence("e2", { kind: "tool_end", text: "工具结果" })];
		const input = JSON.parse(buildWorkProcessInput(process, lane, batch)) as { nodes: ContextNode[] };
		expect(input.nodes.find((item) => item.id === node.id)).not.toHaveProperty("intentEvidence");
		expect(() =>
			applyWorkProcessAnalysis(process, lane, batch, output({ id: node.id, evidenceIds: ["e2"] })),
		).toThrow("缺少对应原文");
	});

	test("clears the retained quote when the model changes an intent to inferred", () => {
		const process = workGraph();
		const lane = workSnapshot().lanes[0];
		const node = applyWorkProcessAnalysis(process, lane, lane.evidence, output()).nodes[0];
		process.nodes.push(node);
		const updated = applyWorkProcessAnalysis(
			process,
			lane,
			[workEvidence("e2")],
			output({ id: node.id, evidenceIds: ["e2"], intentBasis: "inferred", quote: "" }),
		).nodes[0];
		expect(updated.intentBasis).toBe("inferred");
		expect(updated).not.toHaveProperty("intentQuote");
	});
});
