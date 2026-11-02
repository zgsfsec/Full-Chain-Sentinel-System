/** Resolve the connection from the raw Host header and the operator's TLS selection. */
export function webFuzzTarget(raw: string, https: boolean): string {
	const head = raw.split(/\r?\n\r?\n/, 1)[0];
	const lines = head.split(/\r?\n/).slice(1);
	const hosts = lines.filter((line) => /^host:/i.test(line));
	if (hosts.length !== 1) throw new Error("请求头必须包含且只能包含一个 Host。");
	const host = hosts[0].slice(5).trim();
	const authority = /^(?:\[[^\]]+\]|[^:[\]]+)(?::([0-9]{1,5}))?$/.exec(host);
	if (
		!authority ||
		/[\s\\/?#@%\u0000-\u001f\u007f]/.test(host) ||
		(authority[1] !== undefined && (Number(authority[1]) < 1 || Number(authority[1]) > 65535)) ||
		/^[ \t]/.test(lines[lines.indexOf(hosts[0]) + 1] ?? "")
	)
		throw new Error("Host 无效，请填写域名或 IP，可附带端口；IPv6 地址需使用方括号。");
	try {
		const url = new URL(`${https ? "https" : "http"}://${host}`);
		if (!url.hostname) throw new Error();
		return url.origin;
	} catch {
		throw new Error("Host 地址无效。");
	}
}
