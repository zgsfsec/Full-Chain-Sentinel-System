import { ProviderCompatSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import { ThinkingLevelMapSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { Compile } from "typebox/compile";
import type { SentinelModelCapabilities } from "./protocol.ts";

const thinkingMapValidator = Compile(ThinkingLevelMapSchema);
const compatValidator = Compile(ProviderCompatSchema);

/** Validate before either the library or models.json is written. */
export function cleanModelAdvancedSettings(raw: SentinelModelCapabilities): SentinelModelCapabilities {
	const advanced: SentinelModelCapabilities = {};
	if (raw.thinkingLevelMap !== undefined) {
		if (raw.thinkingLevelMap !== null && !thinkingMapValidator.Check(raw.thinkingLevelMap)) {
			throw new Error("Invalid thinking level map");
		}
		advanced.thinkingLevelMap = raw.thinkingLevelMap;
	}
	if (raw.compat !== undefined) {
		if (raw.compat !== null && !compatValidator.Check(raw.compat)) {
			throw new Error("Invalid model compatibility settings");
		}
		advanced.compat = raw.compat;
	}
	return advanced;
}
