export const SESSION_CREDENTIALS_CUSTOM_TYPE = "zg-credentials";
export function readSessionCredentials(entries: readonly unknown[]): boolean {
	let enabled = false;
	for (const entry of entries) {
		const value = entry as { type?: string; customType?: string; data?: { enabled?: unknown } | null };
		if (value.type !== "custom" || value.customType !== SESSION_CREDENTIALS_CUSTOM_TYPE) continue;
		if (value.data === null) enabled = false;
		else if (typeof value.data?.enabled === "boolean") enabled = value.data.enabled;
	}
	return enabled;
}
