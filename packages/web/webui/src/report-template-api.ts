export const REPORT_TEMPLATES_URL = "/api/reports/templates";

export async function reportTemplateRequest<T>(suffix = "", options?: RequestInit): Promise<T> {
	const response = await fetch(`${REPORT_TEMPLATES_URL}${suffix}`, options);
	const body = await response.json() as T & { error?: string };
	if (!response.ok) throw new Error(body.error ?? `请求失败（${response.status}）`);
	return body;
}
