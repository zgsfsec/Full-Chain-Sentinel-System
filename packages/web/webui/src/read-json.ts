import { getLanguage } from "./i18n.ts";

/** The deadline covers both headers and the body; caller cancellation stays silent in readers. */
export async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
	try {
		const response = await fetch(url, { signal: controller.signal });
		const value: unknown = await response.json().catch((error: unknown) => {
			if (response.ok || controller.signal.aborted) throw error;
			return null;
		});
		if (!response.ok) {
			throw new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string"
				? value.error : getLanguage() === "en" ? `Request failed (${response.status})` : `请求失败（${response.status}）`);
		}
		return value as T;
	} catch (error) {
		if (timedOut && !signal?.aborted) throw new Error(getLanguage() === "en"
			? "Request timed out. Retry to load again." : "请求超时，请重试。");
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}
