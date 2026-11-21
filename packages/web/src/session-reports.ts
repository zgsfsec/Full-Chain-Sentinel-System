/** Report-center tools are an explicit, branch-local choice for ordinary conversations. */
export const SESSION_REPORTS_CUSTOM_TYPE = "sentinel-reports";

/** Missing or cleared entries mean off, including conversations created before the switch existed. */
export function readSessionReports(entries: readonly unknown[]): boolean {
	let enabled = false;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const value = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (value.type !== "custom" || value.customType !== SESSION_REPORTS_CUSTOM_TYPE) continue;
		if (value.data === null) enabled = false;
		else if (typeof value.data === "object") {
			const next = (value.data as { enabled?: unknown }).enabled;
			if (typeof next === "boolean") enabled = next;
		}
	}
	return enabled;
}
