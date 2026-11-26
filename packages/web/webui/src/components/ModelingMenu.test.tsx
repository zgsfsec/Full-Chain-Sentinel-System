/**
 * The 业务建模 menu's content, rendered without its portal.
 *
 * 开始建模 is only the instruction, so it is always offered — outside an
 * engineering task, whose modeling is dispatched by its commander. 结束建模
 * closes the run in force, so it needs one. While the agent runs the instruction
 * is queued after the turn rather than refused, and the run cannot be ended.
 */

import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SentinelModelingState } from "../types.ts";
import { ModelingMenuBody } from "./ModelingMenu.tsx";

const STAMP = "2026-11-25T08:00:00.000Z";

const run: SentinelModelingState = {
	runId: "api-1",
	title: "商城",
	target: "https://shop.example.com",
	source: "shop-api/",
	startedAt: STAMP,
	pathCount: 12,
	operationCount: 30,
	entityCount: 4,
	apiCount: 18,
	stateMachineCount: 2,
	ruleCount: 9,
};

function render(overrides: Partial<ComponentProps<typeof ModelingMenuBody>> = {}): string {
	const props: ComponentProps<typeof ModelingMenuBody> = {
		modeling: null,
		streaming: false,
		taskSession: false,
		onStart: () => {},
		onEnd: () => {},
		onClose: () => {},
		...overrides,
	};
	return renderToStaticMarkup(createElement(ModelingMenuBody, props));
}

/** The menu's buttons, in order, each with whether it is disabled and its tooltip. */
function buttons(html: string): Array<{ disabled: boolean; title: string }> {
	return (html.match(/<button[^>]*>/g) ?? []).map((tag) => ({
		disabled: /\sdisabled=""/.test(tag),
		title: /title="([^"]*)"/.exec(tag)?.[1] ?? "",
	}));
}

test("the menu is two actions: the instruction, and ending the run in force", () => {
	const html = render();
	expect(html).toContain("开始建模");
	expect(html).toContain("结束建模");
	// Nothing is left of attaching records by hand, or of a second kind of modeling.
	for (const absent of ["关联建模数据", "项目理解", "接口模型"]) expect(html).not.toContain(absent);
	const [start, end, ...rest] = buttons(html);
	expect(rest).toHaveLength(0);
	expect(start?.disabled).toBe(false);
	expect(start?.title).toContain("把建模指令发给 Agent");
	// With no run in force there is nothing to end, and the tooltip says so.
	expect(end?.disabled).toBe(true);
	expect(end?.title).toBe("当前会话没有进行中的业务建模");
});

test("with a run in force, ending names the record and its counts, and starting stays available", () => {
	const html = render({ modeling: run });
	const [start, end] = buttons(html);
	expect(start?.disabled).toBe(false);
	expect(end?.disabled).toBe(false);
	expect(end?.title).toBe("结束这次建模（商城），Agent 回到普通工作");
	expect(html).toContain("商城 · 12 路径 / 18 条源码映射");
});

test("while the agent runs, the instruction is queued and the run cannot be ended", () => {
	const running = buttons(render({ modeling: run, streaming: true }));
	expect(running[0]?.disabled).toBe(false);
	expect(running[0]?.title).toContain("排到本轮之后");
	expect(running[1]?.disabled).toBe(true);
	expect(running[1]?.title).toBe("Agent 正在运行，先中止或等本轮结束");
});

test("an engineering task's conversation gets its modeling from the commander", () => {
	const task = buttons(render({ taskSession: true }));
	expect(task[0]?.disabled).toBe(true);
	expect(task[0]?.title).toBe("工程任务的会话由指挥官安排业务建模，不能在这里开始");
	// A run the commander's worker opened is still the operator's to end.
	const taskRun = buttons(render({ taskSession: true, modeling: run }));
	expect(taskRun[0]?.disabled).toBe(true);
	expect(taskRun[1]?.disabled).toBe(false);
});
