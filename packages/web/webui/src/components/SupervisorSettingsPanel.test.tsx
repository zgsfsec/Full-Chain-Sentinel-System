/** Settings → 监督: multiple defaults stay visible and independently checkable. */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { SentinelSupervisorConfig } from "../types.ts";
import { SupervisorSettingsPanel } from "./SupervisorSettingsPanel.tsx";

const config: SentinelSupervisorConfig = {
	enabled: true,
	batchToolCalls: 20,
	duplicateThreshold: 3,
	noProgressCalls: 10,
	errorStreak: 3,
	longToolCallMs: 120_000,
	timeoutMs: 180_000,
	redactSecrets: true,
	defaultStrategy: "steady",
	defaultStrategies: [
		{ strategy: "steady", customStrategyId: null },
		{ strategy: "validation", customStrategyId: null },
	],
	customStrategies: [],
	defaultCustomStrategyId: null,
};

describe("SupervisorSettingsPanel", () => {
	test("renders every default strategy as a checkbox and shows the count", () => {
		const html = renderToStaticMarkup(
			<SupervisorSettingsPanel
				supervisorConfig={config}
				library={null}
				onSaveSupervisorConfig={() => {}}
				onTestSupervisor={async () => null}
				onSetRole={() => {}}
			/>,
		);
		expect(html).toContain("可多选 · 2 个");
		expect(html).toContain("稳健交付");
		expect(html).toContain("漏洞验证");
		expect(html).toContain("红队推进");
		expect(html).toContain("低噪声");
		expect(html).toContain("不测危险接口");
		expect(html).toContain("长命令等待（秒）");
		expect(html).toContain("命令超过时限仍未返回时");
	});
});
