import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";

describe("OpenAI thinking model metadata", () => {
	it.each(["gpt-6.1-terra", "gpt-6.2-astra", "gpt-6.2-sol"] as const)(
		"matches upstream capabilities for %s on each Responses host",
		(id) => {
			for (const provider of ["openai", "openai-codex", "azure"] as const) {
				const model = getModel(provider, id);
				expect(model).toBeDefined();
				expect(model.thinkingLevelMap).toMatchObject({
					off: id === "gpt-6.1-terra" ? "none" : null,
					minimal: provider === "openai-codex" ? "low" : null,
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
				});
				expect(getSupportedThinkingLevels(model)).toContain("max");
				expect(model.compat?.supportsMidConvoEffort).toBe(provider === "azure" ? undefined : true);
				expect(model.contextWindow).toBe(
					provider === "azure" ? 1050000 : provider === "openai-codex" && id !== "gpt-6.2-astra" ? 500000 : 272000,
				);
			}
		},
	);

	it("uses the upstream Codex GPT-6.1 Sol context limit", () => {
		expect(getModel("openai-codex", "gpt-6.1-sol").contextWindow).toBe(500000);
	});
});
