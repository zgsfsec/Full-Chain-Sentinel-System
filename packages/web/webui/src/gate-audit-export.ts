import { getLanguage } from "./i18n.ts";
import type { SentinelGateFilter } from "./types.ts";

/** Download all matching records without changing the table's current page. */
export async function downloadGateAudit(filter: SentinelGateFilter): Promise<void> {
	const params = new URLSearchParams({ filter: JSON.stringify(filter) });
	const response = await fetch(`/api/gate-audit/export?${params}`, { signal: AbortSignal.timeout(120_000) });
	if (!response.ok) {
		const body: unknown = await response.json().catch(() => null);
		throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
			? body.error : getLanguage() === "en" ? "Export failed. Please retry." : "导出失败，请重试。");
	}
	const blob = await response.blob();
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "approvals.csv";
	try {
		document.body.appendChild(anchor);
		anchor.click();
	} finally {
		anchor.remove();
		// Give the browser time to start reading the download before releasing it.
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
}
