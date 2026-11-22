import type { WorkProcess, WorkProcessRef } from "../../src/work-process-types.ts";
import { getLanguage } from "./i18n.ts";
import { readJson } from "./read-json.ts";

/** Opening an enabled conversation must not abort or restart its current analysis. */
export async function ensureWorkLinkEnabled(ref: WorkProcessRef, signal: AbortSignal): Promise<WorkProcess> {
	const query = new URLSearchParams({ projectId: ref.projectId, kind: ref.kind, id: ref.id });
	const { process } = await readJson<{ process: WorkProcess }>(`/api/work-processes/detail?${query}`, signal);
	signal.throwIfAborted();
	if (process.enabled && (!process.error || process.retry)) return process;
	const response = await fetch(`/api/work-processes/control?${query}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action: "enable" }),
		signal,
	});
	const body = await response.json() as { process?: WorkProcess; error?: string };
	signal.throwIfAborted();
	if (!response.ok || !body.process?.enabled) throw new Error(body.error ?? (getLanguage() === "en" ? "Could not enable work links" : "开启工作链路失败"));
	return body.process;
}
