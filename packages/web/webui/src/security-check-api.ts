export async function securityCheckRequest<T>(action = "", body?: unknown, signal?: AbortSignal): Promise<T> {
	const response = await fetch(`/api/security-checks${action}`, {
		signal,
		...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	const result = await response.json() as T & { error?: string };
	if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
	return result;
}
