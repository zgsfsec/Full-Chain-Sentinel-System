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

export const ALL_THINKING_LEVELS: SentinelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Preserve the model's reasoning capability while choosing an explicit off request. */
export function setThinkingDisabled(current: ModelThinkingDraft, disabled: boolean): ModelThinkingDraft {
	if (disabled) {
		if (!current.availableThinkingLevels.includes("off")) return current;
		return {
			...current,
			defaultThinkingLevel: "off",
			thinkingLevelMap: { ...current.thinkingLevelMap, off: current.thinkingLevelMap?.off ?? "none" },
		};
	}
	return {
		...current,
		defaultThinkingLevel: current.availableThinkingLevels.includes("medium")
			? "medium"
			: (current.availableThinkingLevels.find((level) => level !== "off") ?? "off"),
	};
}

/** Explicit nulls disable SDK defaults; extended levels require an explicit mapping. */
export function customThinkingSettings(
	current: ModelThinkingDraft,
	selected: SentinelThinkingLevel[],
): ModelThinkingDraft {
	const availableThinkingLevels = ALL_THINKING_LEVELS.filter((level) => selected.includes(level));
	const thinkingLevelMap: NonNullable<ModelThinkingDraft["thinkingLevelMap"]> = {};
	for (const level of ALL_THINKING_LEVELS) {
		thinkingLevelMap[level] = availableThinkingLevels.includes(level)
			? (current.thinkingLevelMap?.[level] ?? (level === "off" ? "none" : level))
			: null;
	}
	return {
		...current,
		availableThinkingLevels,
		thinkingLevelMap,
		defaultThinkingLevel: availableThinkingLevels.includes(current.defaultThinkingLevel)
			? current.defaultThinkingLevel
			: (availableThinkingLevels[0] ?? "off"),
	};
}

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
