/** Global supervision settings: tolerant parse, clamping, and 0600 persistence. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	normalizeSupervisorConfig,
	readSupervisorConfig,
	SUPERVISOR_DEFAULTS,
	supervisorJsonPath,
	writeSupervisorConfig,
} from "../src/supervisor-config.ts";

let root = "";
let agentDir = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sentinel-supervisor-config-"));
	agentDir = join(root, "agent");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("normalizeSupervisorConfig", () => {
	test("missing values fall back to the defaults", () => {
		expect(normalizeSupervisorConfig({})).toEqual(SUPERVISOR_DEFAULTS);
	});

	test("clamps out-of-range thresholds instead of accepting them", () => {
		const config = normalizeSupervisorConfig({
			batchToolCalls: 999,
			duplicateThreshold: 1,
			noProgressCalls: 0,
			errorStreak: -4,
			longToolCallMs: 1,
			timeoutMs: 100,
		});
		expect(config.batchToolCalls).toBe(100);
		expect(config.duplicateThreshold).toBe(2);
		expect(config.noProgressCalls).toBe(2);
		expect(config.errorStreak).toBe(2);
		expect(config.longToolCallMs).toBe(15_000);
		expect(config.timeoutMs).toBe(5000);
	});

	test("keeps booleans and rejects non-boolean values", () => {
		expect(normalizeSupervisorConfig({ enabled: false }).enabled).toBe(false);
		expect(normalizeSupervisorConfig({ enabled: "yes" }).enabled).toBe(true);
	});

	test("accepts only a known default strategy", () => {
		expect(normalizeSupervisorConfig({}).defaultStrategy).toBe("steady");
		expect(normalizeSupervisorConfig({ defaultStrategy: "offensive" }).defaultStrategy).toBe("offensive");
		expect(normalizeSupervisorConfig({ defaultStrategy: "guarded" }).defaultStrategy).toBe("guarded");
		expect(normalizeSupervisorConfig({ defaultStrategy: "unknown" }).defaultStrategy).toBe("steady");
	});

	test("keeps several default strategies and drops deleted custom entries", () => {
		const config = normalizeSupervisorConfig({
			defaultStrategies: [
				{ strategy: "steady", customStrategyId: null },
				{ strategy: "offensive", customStrategyId: null },
				{ strategy: "validation", customStrategyId: "custom-missing" },
				{ strategy: "steady", customStrategyId: null },
			],
			customStrategies: [
				{
					id: "custom-pay",
					name: "支付网关专用",
					base: "validation",
					instructions: "优先验证 IDOR",
				},
			],
		});
		expect(config.defaultStrategies?.map((entry) => entry.strategy)).toEqual(["steady", "offensive"]);
		expect(config.defaultStrategy).toBe("steady");
		expect(config.defaultCustomStrategyId).toBeNull();
	});

	test("normalizes custom strategies and only defaults to an existing one", () => {
		const config = normalizeSupervisorConfig({
			customStrategies: [
				{
					id: "custom-pay",
					name: "支付网关专用",
					base: "validation",
					description: "先看越权",
					instructions: "优先验证 IDOR，不做目录爆破",
				},
				{ id: "custom-empty", name: "", base: "steady", instructions: "" },
			],
			defaultCustomStrategyId: "custom-pay",
		});
		expect(config.customStrategies).toHaveLength(1);
		expect(config.customStrategies[0]?.id).toBe("custom-pay");
		expect(config.customStrategies[0]?.base).toBe("validation");
		expect(config.defaultCustomStrategyId).toBe("custom-pay");
		expect(normalizeSupervisorConfig({ defaultCustomStrategyId: "missing" }).defaultCustomStrategyId).toBeNull();
	});
});

describe("file persistence", () => {
	test("round-trips a config at 0600", () => {
		writeSupervisorConfig(agentDir, {
			...SUPERVISOR_DEFAULTS,
			enabled: false,
			batchToolCalls: 30,
			longToolCallMs: 240_000,
			timeoutMs: 45_000,
		});
		expect(readSupervisorConfig(agentDir)).toMatchObject({
			enabled: false,
			batchToolCalls: 30,
			longToolCallMs: 240_000,
			timeoutMs: 45_000,
		});
		const text = readFileSync(supervisorJsonPath(agentDir), "utf-8");
		expect(text).toContain('"batchToolCalls": 30');
	});

	test("a corrupt file reads as the defaults", () => {
		writeSupervisorConfig(agentDir, SUPERVISOR_DEFAULTS);
		writeFileSync(supervisorJsonPath(agentDir), "{");
		expect(readSupervisorConfig(agentDir)).toEqual(SUPERVISOR_DEFAULTS);
	});
});
