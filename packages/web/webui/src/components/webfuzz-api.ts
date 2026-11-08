import { getLanguage } from "../i18n.ts";

/** Bound workspace I/O separately from the operator's replay timeout. */
export async function webFuzzApi<T>(path: string, projectId: string, body?: object, signal?: AbortSignal): Promise<T> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	let timedOut = false;
	// Sending includes container preparation and has its own timeout and cancel button.
	const timer = path === "/webfuzz/send" ? undefined : setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, path === "/webfuzz/import" ? 30000 : 10000);
	try {
		const response = await fetch(
			`/api/mitm${path}${body ? "" : `?projectId=${encodeURIComponent(projectId)}`}`,
			{
				...(body ? {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...body, projectId }),
				} : {}),
				signal: controller.signal,
			},
		);
		const value = (await response.json()) as T & { error?: string };
		if (!response.ok) throw new Error(value.error ?? (getLanguage() === "en" ? "Request failed" : "请求失败"));
		return value;
	} catch (cause) {
		if (timedOut && !signal?.aborted) {
			throw new Error(getLanguage() === "en"
				? "Request timed out. Retry, or check the console service if this persists."
				: "请求超时，请重试；若持续失败，请检查控制台服务状态。");
		}
		throw cause;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}
