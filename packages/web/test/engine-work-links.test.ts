import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { type EngineHooks, EngineManager } from "../src/engine.ts";
import type { SentinelEngine, SentinelEngineCreateInput, SentinelEngineSchedule } from "../src/protocol.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function harness(hooks: Partial<EngineHooks> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "engine-work-links-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const manager = new EngineManager(
		dir,
		{ onChange: () => {}, onCommanderEvent: () => {}, onTaskEvent: () => {}, ...hooks },
		async () => {
			throw new Error("No worker expected");
		},
	);
	cleanups.push(() => manager.dispose());
	const input: SentinelEngineCreateInput = {
		name: "记录测试",
		targets: "https://example.test",
		doctrines: ["attack-defense-web"],
		limits: { concurrency: 1, roundLimit: 1, maxRetries: 0, tokenLimit: null, timeLimitMin: null },
		schedule: { timezone: "UTC", startAt: Date.now() + 3600_000 },
	};
	return { manager, input, project: { id: "p1", name: "项目", cwd: dir } };
}

test.each([undefined, false])("recording remains opt-in when recordWorkLinks=%s", async (recordWorkLinks) => {
	const onCreated = vi.fn<NonNullable<EngineHooks["onCreated"]>>(async () => {});
	const { manager, input, project } = harness({ onCreated });
	const engine = await manager.createEngine(project, { ...input, recordWorkLinks });
	expect(engine.status).toBe("scheduled");
	expect(onCreated).not.toHaveBeenCalled();
});

test("recording is initialized for the exact inserted engine before its first environment or model call", async () => {
	const order: string[] = [];
	let insertedId: string | undefined;
	const onCreated = vi.fn<NonNullable<EngineHooks["onCreated"]>>(async (engine, options) => {
		expect(engine.id).toBe(insertedId);
		expect(options.recordWorkLinks).toBe(true);
		order.push("recording");
		await Promise.resolve();
		order.push("persisted");
	});
	const { manager, input, project } = harness({
		onChange: (engine) => {
			insertedId = engine.id;
		},
		onCreated,
		beforeStart: async () => {
			order.push("start");
			return { ok: false, error: "Fixture stopped before model call" };
		},
	});
	await expect(
		manager.createEngine(project, { ...input, schedule: undefined, recordWorkLinks: true }),
	).rejects.toThrow("Fixture stopped");
	expect(order).toEqual(["recording", "persisted", "start"]);
	expect(manager.listEngines()).toHaveLength(1);
	expect(manager.listEngines()[0].status).toBe("paused");
	expect(onCreated).toHaveBeenCalledTimes(1);
});

test("a scheduled engine records without starting the commander or checking Docker early", async () => {
	const onCreated = vi.fn<NonNullable<EngineHooks["onCreated"]>>(async () => {});
	const beforeStart = vi.fn<NonNullable<EngineHooks["beforeStart"]>>(async () => ({ ok: true }));
	const { manager, input, project } = harness({ onCreated, beforeStart });
	const engine = await manager.createEngine(project, { ...input, recordWorkLinks: true });
	expect(engine.status).toBe("scheduled");
	expect(engine.startedAt).toBeNull();
	expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: engine.id }), { recordWorkLinks: true });
	expect(beforeStart).not.toHaveBeenCalled();
});

test("recording setup failure remains visible without losing or duplicating the created engine", async () => {
	const { manager, input, project } = harness({
		onCreated: async () => {
			throw new Error("storage unavailable");
		},
	});
	const engine = await manager.createEngine(project, { ...input, recordWorkLinks: true });
	expect(engine.status).toBe("scheduled");
	expect(manager.listEngines()).toHaveLength(1);
	expect(manager.commanderEvents(engine.id)).toContainEqual(
		expect.objectContaining({
			kind: "status",
			status: "error",
			note: expect.stringContaining("工作链路开启失败：storage unavailable"),
		}),
	);
});

test("invalid opt-in values fail before creating an engine", async () => {
	const { manager, input, project } = harness();
	await expect(
		manager.createEngine(project, { ...input, recordWorkLinks: "true" as unknown as boolean }),
	).rejects.toThrow("布尔值");
	expect(manager.listEngines()).toEqual([]);
});

test("a daily successor initializes its own recording using the previous run's identity", async () => {
	const onCreated = vi.fn<NonNullable<EngineHooks["onCreated"]>>(async () => {});
	const { manager, input, project } = harness({ onCreated });
	const engine = await manager.createEngine(project, {
		...input,
		recordWorkLinks: true,
		schedule: { ...input.schedule!, repeatDaily: true },
	});
	const recurring = manager as unknown as {
		scheduleNextDailyRun(engine: SentinelEngine, schedule: SentinelEngineSchedule): Promise<void>;
	};
	await recurring.scheduleNextDailyRun(engine, engine.schedule!);
	const next = manager.listEngines().find((entry) => entry.id !== engine.id)!;
	expect(next.status).toBe("scheduled");
	expect(next.schedule?.startAt).toBeGreaterThan(engine.schedule!.startAt);
	expect(onCreated).toHaveBeenLastCalledWith(expect.objectContaining({ id: next.id }), {
		previousEngineId: engine.id,
	});
});
