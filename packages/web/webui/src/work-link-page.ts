import type { WorkProcessRef } from "../../src/work-process-types.ts";

export const WORK_LINK_PAGE_HASH = "#work-links?";

export function workLinkPageHref(target: WorkProcessRef, selectedId: string | null = null): string {
	const query = new URLSearchParams({ projectId: target.projectId, kind: target.kind, id: target.id });
	if (selectedId) query.set("node", selectedId);
	return `${WORK_LINK_PAGE_HASH}${query}`;
}

/** Only local object identifiers enter this route; it never accepts a destination URL. */
export function parseWorkLinkPage(hash: string): { target: WorkProcessRef; selectedId: string | null } | null {
	if (!hash.startsWith(WORK_LINK_PAGE_HASH)) return null;
	const query = new URLSearchParams(hash.slice(WORK_LINK_PAGE_HASH.length));
	const projectId = query.get("projectId");
	const kind = query.get("kind");
	const id = query.get("id");
	if (!projectId || projectId.length > 200 || !id || !/^[a-zA-Z0-9._:-]{1,200}$/.test(id) || (kind !== "session" && kind !== "engine")) return null;
	const node = query.get("node");
	return { target: { projectId, kind, id }, selectedId: node && node.length <= 200 ? node : null };
}
