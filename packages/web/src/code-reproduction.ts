/** Explicit commander conclusions; completion and finding counts are not proof. */
export interface CodeReproductionResult {
	outcome: "confirmed" | "not_reproduced" | "inconclusive" | "failed";
	summary: string;
	pocPath?: string;
	vulnerableEvidence?: string;
	fixedEvidence?: string;
}

/** Validate both tool input and persisted JSON before presenting a conclusion. */
export function parseCodeReproductionResult(raw: unknown): CodeReproductionResult | null {
	if (!raw || typeof raw !== "object" || !("outcome" in raw) || !("summary" in raw)) return null;
	const { outcome, summary } = raw;
	if (outcome !== "confirmed" && outcome !== "not_reproduced" && outcome !== "inconclusive" && outcome !== "failed")
		return null;
	if (typeof summary !== "string" || !summary.trim() || summary.length > 4000) return null;
	const result: CodeReproductionResult = {
		outcome,
		summary: summary.trim(),
	};
	for (const key of ["pocPath", "vulnerableEvidence", "fixedEvidence"] as const) {
		if (key in raw) {
			const value: unknown = (raw as Record<string, unknown>)[key];
			if (typeof value !== "string" || value.length > 8000) return null;
			if (value.trim()) result[key] = value.trim();
		}
	}
	if (outcome === "confirmed" && (!result.pocPath || !result.vulnerableEvidence || !result.fixedEvidence)) return null;
	return result;
}
