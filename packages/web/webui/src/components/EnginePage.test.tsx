/**
 * The task board of one engineering run.
 *
 * The board is where the operator sees what a pause left behind, and 中止 is
 * the one thing they can do to a task from there. What is pinned: it is offered
 * for a running, a queued, and a paused task, and for no other. A paused task is
 * one a pause interrupted, and a run cannot be closed while one is left, so
 * without the button the operator would have no way to drop it.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SentinelEngine, SentinelEngineTask, SentinelEngineTaskStatus } from "../types.ts";
import { TaskBoard } from "./EnginePage.tsx";

function task(id: string, status: SentinelEngineTaskStatus): SentinelEngineTask {
	return {
		id,
		engineId: "e1",
		title: `任务 ${id}`,
		objective: "找入口",
		target: "10.0.0.5",
		workspace: `/work/tasks/${id}`,
		status,
		attempt: 1,
		criteria: [],
		roundLimit: 10,
		presetId: null,
		presetName: null,
		pendingContinue: null,
		sessionId: null,
		startedAt: null,
		endedAt: null,
		summary: null,
		error: null,
		usage: null,
		vulns: 0,
		autoResume: false,
	};
}

function board(statuses: SentinelEngineTaskStatus[]): string {
	const engine: SentinelEngine = {
		id: "e1",
		projectId: "p1",
		projectName: "靶场",
		name: "内网打点",
		status: "running",
		pauseNote: null,
		targets: [],
		doctrines: [],
		presetIds: [],
		presetOptional: true,
		limits: { concurrency: 2, roundLimit: 10, tokenLimit: null, timeLimitMin: null, maxRetries: 1 },
		gateMode: "auto",
		createdAt: 0,
		startedAt: 0,
		endedAt: null,
		schedule: null,
		report: null,
		tasks: statuses.map((status, index) => task(`${index + 1}`, status)),
	};
	return renderToStaticMarkup(createElement(TaskBoard, { engine, onOpenTask: () => {}, onAbortTask: () => {} }));
}

test("中止 is offered for a running, a queued, and a paused task, and for no ended one", () => {
	const html = board(["running", "queued", "paused", "done", "failed", "blocked", "aborted"]);
	// One line per row: the status it shows, and whether it carries the button.
	const rows = html.split('<div class="engine-workspace-task">').slice(1);
	expect(
		rows.map((row) => [row.match(/ant-badge-status-text">([^<]+)</)?.[1], row.includes("engine-workspace-task__abort")]),
	).toEqual([
		["运行中", true],
		["排队中", true],
		["已暂停", true],
		["已完成", false],
		["失败", false],
		["已阻塞", false],
		["已中止", false],
	]);
});

test("a board without tasks says where the tasks will come from", () => {
	const html = board([]);
	expect(html).toContain("还没有任务。指挥官启动后会在这里派发。");
	expect(html).not.toContain("engine-workspace-task__abort");
});
