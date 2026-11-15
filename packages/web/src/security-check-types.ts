export interface SecurityCheckRule {
	id: string;
	ruleId: string;
	sourceId: string;
	name: string;
	/** Comma-separated category memberships; each path uses slash-separated levels. */
	category: string;
	description: string;
	text: string;
	version: string;
	path: string;
	commit: string;
	copiedFrom?: string;
}

export interface SecurityCheckSource {
	id: string;
	name: string;
	repository: string;
	branch: string;
	directory: string;
	enabled: boolean;
	intervalHours: number;
	lastCheckedAt: number | null;
	lastSuccessAt: number | null;
	nextSyncAt: number;
	commit: string;
	error: string | null;
	failures: number;
	syncing?: boolean;
}

export interface SecurityCheckSyncRecord {
	at: number;
	ok: boolean;
	message: string;
	count: number;
}

export interface SecurityCheckCatalog {
	rules: SecurityCheckRuleSummary[];
	sources: SecurityCheckSource[];
}

export type SecurityCheckRuleSummary = Omit<SecurityCheckRule, "text">;

export interface SecurityCheckSelection {
	id: string;
	version: string;
}

export const SECURITY_CHECK_OFFICIAL_REPOSITORY = "https://github.com/zgsfsec/Full-Chain-Sentinel-System";
export const SECURITY_CHECK_MAX_RULES = 1000;
export const SECURITY_CHECK_MAX_BYTES = 128 * 1024;
