/** Project-scoped MITM centre views. */
export interface MitmConfig {
	bind: "127.0.0.1" | "0.0.0.0";
	/** Zero requests an unused port from Docker. */
	port: number;
	skipStatic: boolean;
	/** Maximum stored bytes per request or response, in MiB. */
	maxCaptureMb: number;
	authEnabled: boolean;
	authUsername: string;
	/** Passwords and their hashes are never returned to the browser. */
	hasPassword: boolean;
}

export interface MitmStatus {
	project: { id: string; name: string };
	config: MitmConfig;
	state: "running" | "stopped" | "missing" | "unavailable";
	port: number | null;
	lanIps: string[];
	ca: { fingerprint: string; subject: string; expires: string } | null;
	error?: string;
}

export interface MitmHeader {
	n: string;
	v: string;
}

export interface MitmFlow {
	id: string;
	ts: number;
	method: string;
	scheme: string;
	host: string;
	port: number;
	path: string;
	query: string;
	status: number | null;
	durationMs: number | null;
	reqSize: number;
	respSize: number;
	error: string | null;
	note: string;
}

export interface MitmFlowPage {
	items: MitmFlow[];
	total: number;
	page: number;
	pageSize: number;
}

export interface MitmBody {
	text: string;
	encoding: "utf8" | "base64";
	size: number;
	truncated: boolean;
	captureTruncated: boolean;
}

export interface MitmFlowDetail extends MitmFlow {
	reqHeaders: MitmHeader[];
	respHeaders: MitmHeader[];
	request: MitmBody;
	response: MitmBody;
}

/** Byte offsets refer to the saved raw HTTP message, before UTF-8/Base64 encoding. */
export interface MitmBodyChunk extends MitmBody {
	available: boolean;
	offset: number;
	bytesRead: number;
	nextOffset: number | null;
}
