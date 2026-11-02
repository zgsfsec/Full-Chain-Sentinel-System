/** Manual HTTP replay. Routes always refer to the current project. */
export type WebFuzzRoute = "project" | "direct" | "mitm";

export interface WebFuzzRequest {
	raw: string;
	/** Cached origin; its protocol is the HTTPS selection. Host is resolved again before sending. */
	target: string;
	route: WebFuzzRoute;
	timeoutMs: number;
	insecureTLS: boolean;
	fixContentLength: boolean;
}

export interface WebFuzzTab extends WebFuzzRequest {
	id: string;
	name: string;
}

export interface WebFuzzResult {
	id: string;
	at: number;
	request: WebFuzzRequest;
	response: {
		proto: string;
		status: number;
		reason: string;
		headers: { name: string; value: string }[];
		bodyText?: string;
		bodyBase64?: string;
		rawText?: string;
		rawBase64?: string;
		rawTruncated?: boolean;
		previewTruncated?: boolean;
		truncated: boolean;
		size: number;
	} | null;
	timings: { connectMs: number; tlsMs: number; ttfbMs: number; totalMs: number };
	error?: string;
	warnings: string[];
}

export interface WebFuzzState {
	tabs: WebFuzzTab[];
	activeId: string | null;
	history: WebFuzzResult[];
}
