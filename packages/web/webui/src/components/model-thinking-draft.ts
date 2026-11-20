import type { SentinelBuiltinModelDefaults, SentinelModelCapabilities, SentinelThinkingLevel } from "../types.ts";

export interface ModelThinkingDraft {
	defaultThinkingLevel: SentinelThinkingLevel;
	availableThinkingLevels: SentinelThinkingLevel[];
	thinkingLevelMap?: SentinelModelCapabilities["thinkingLevelMap"];
	compat?: SentinelModelCapabilities["compat"];
}

export const EMPTY_MODEL_THINKING: ModelThinkingDraft = {
	defaultThinkingLevel: "medium",
	availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
	thinkingLevelMap: null,
	compat: null,
};

/** The catalog and the SDK, rather than a fixed UI list, define valid strengths. */
export function catalogThinkingSettings(
	defaults: SentinelBuiltinModelDefaults,
	current?: ModelThinkingDraft,
): ModelThinkingDraft {
	return {
		defaultThinkingLevel:
			current && defaults.availableThinkingLevels.includes(current.defaultThinkingLevel)
				? current.defaultThinkingLevel
				: defaults.defaultThinkingLevel,
		availableThinkingLevels: defaults.availableThinkingLevels,
		thinkingLevelMap: defaults.thinkingLevelMap,
		compat: current ? { ...defaults.compat, ...current.compat } : defaults.compat,
	};
}
