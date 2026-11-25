/** The hosts a project keeps out of its MITM traffic list. */
import { MitmError } from "./mitm-store.ts";

/** A list stays short enough to read at a glance and to send in one request. */
export const HOST_FILTER_LIMIT = 500;

/** One label of a hostname or IPv4 address. `_` because internal names use it. */
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/;

/**
 * The list as it is stored and compared: lower case, without a trailing dot,
 * sorted and without repeats. Anything that is not a hostname is refused.
 *
 * `a.test.com` is that host alone; `*.test.com` is every host under `test.com`.
 * A bare `test.com` therefore never hides the main site when the junk traffic
 * comes from its subdomains: the wildcard has to be asked for.
 */
export function normalizeHostFilter(value: unknown): string[] {
	const hosts: unknown = Array.isArray(value) ? value : (value as { hosts?: unknown } | null)?.hosts;
	if (!Array.isArray(hosts) || hosts.length > HOST_FILTER_LIMIT)
		throw new MitmError(`过滤域名应为数组，最多 ${HOST_FILTER_LIMIT} 项。`);
	const unique = new Set<string>();
	for (const entry of hosts) {
		const host = typeof entry === "string" ? entry.trim().toLowerCase().replace(/\.$/, "") : "";
		const name = host.startsWith("*.") ? host.slice(2) : host;
		const labels = name.split(".");
		if (!name || host.length > 255 || labels.some((label) => label.length > 63 || !LABEL.test(label)))
			throw new MitmError(`过滤域名无效：${typeof entry === "string" ? entry.trim().slice(0, 80) : String(entry)}`);
		unique.add(host);
	}
	return [...unique].sort();
}
