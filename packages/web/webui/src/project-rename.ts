import { getLanguage } from "./i18n.ts";

/** The server broadcasts the saved name to every connected console. */
export async function renameProject(id: string, name: string): Promise<string | null> {
	const fallback = getLanguage() === "en" ? "Could not rename project. Please retry." : "修改项目名称失败，请重试。";
	try {
		const response = await fetch("/api/projects/rename", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id, name: name.trim() }),
		});
		const body: unknown = await response.json();
		if (response.ok) return null;
		return body && typeof body === "object" && "error" in body && typeof body.error === "string"
			? body.error
			: fallback;
	} catch {
		return fallback;
	}
}
