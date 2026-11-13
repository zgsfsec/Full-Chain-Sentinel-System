import { FileSettingsStorage, type ThinkingLevel } from "@earendil-works/pi-coding-agent";

export const MODEL_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isModelThinkingLevel(value: unknown): value is ThinkingLevel {
	return MODEL_THINKING_LEVELS.some((level) => level === value);
}

function parseSettings(content: string | undefined): Record<string, unknown> {
	const settings: unknown = content ? JSON.parse(content.replace(/^\uFEFF/u, "")) : {};
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
		throw new Error("Invalid settings.json: expected an object");
	}
	return settings as Record<string, unknown>;
}

function thinkingDefaults(settings: Record<string, unknown>): Record<string, unknown> {
	const levels = settings.modelThinkingLevels;
	if (levels === undefined) return {};
	if (typeof levels !== "object" || levels === null || Array.isArray(levels)) {
		throw new Error("Invalid settings.json: modelThinkingLevels must be an object");
	}
	return levels as Record<string, unknown>;
}

export function readModelThinkingLevel(
	agentDir: string,
	provider: string,
	modelId: string,
	fallbackToGlobal = false,
): ThinkingLevel | undefined {
	let level: unknown;
	new FileSettingsStorage(agentDir, agentDir).withLock("global", (content) => {
		const settings = parseSettings(content);
		level = thinkingDefaults(settings)[`${provider}/${modelId}`];
		if (level === undefined && fallbackToGlobal) level = settings.defaultThinkingLevel;
		return undefined;
	});
	return isModelThinkingLevel(level) ? level : undefined;
}

/** Use the SDK's lock and settings key so new sessions consume the saved default. */
export function writeModelThinkingLevel(
	agentDir: string,
	provider: string,
	modelId: string | null,
	level?: ThinkingLevel,
): void {
	new FileSettingsStorage(agentDir, agentDir).withLock("global", (content) => {
		const settings = parseSettings(content);
		const levels = { ...thinkingDefaults(settings) };
		// One library provider owns one model. Drop stale keys after an ID change or deletion.
		for (const key of Object.keys(levels)) {
			if (key.startsWith(`${provider}/`)) delete levels[key];
		}
		if (modelId !== null && level !== undefined) levels[`${provider}/${modelId}`] = level;
		if (Object.keys(levels).length > 0) settings.modelThinkingLevels = levels;
		else delete settings.modelThinkingLevels;
		const next = JSON.stringify(settings, null, 2);
		return next === JSON.stringify(parseSettings(content), null, 2) ? undefined : next;
	});
}
