import { Alert, Button, Select, Space } from "antd";
import { useEffect, useState } from "react";
import type { ReportTemplateList, ReportTemplateSummary } from "../../../src/report-types.ts";
import { getLanguage } from "../i18n.ts";
import { reportTemplateRequest } from "../report-template-api.ts";

const tx = (zh: string, en: string) => getLanguage() === "en" ? en : zh;

export function ReportTemplateSelect({ projectId, value, onChange, disabled = false, inherit = true, snapshot, refreshToken = 0 }: {
	projectId: string; value: string | null | undefined; onChange: (id: string | null | undefined) => void;
	disabled?: boolean; inherit?: boolean; snapshot?: Pick<ReportTemplateSummary, "id" | "name" | "revision"> | null; refreshToken?: number;
}) {
	const [data, setData] = useState<ReportTemplateList | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [retry, setRetry] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		void reportTemplateRequest<ReportTemplateList>(`?projectId=${encodeURIComponent(projectId)}`, { signal: controller.signal })
			.then((next) => { if (!controller.signal.aborted) { setData(next); setError(null); } })
			.catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
		return () => controller.abort();
	}, [projectId, refreshToken, retry]);
	const items = data?.items ?? [];
	const defaultName = items.find((item) => item.id === data?.defaultTemplateId)?.name;
	const options = [
		...(inherit ? [{ value: "default", label: defaultName ? tx(`项目默认：${defaultName}`, `Project default: ${defaultName}`) : tx("项目默认：自由生成", "Project default: free-form") }] : []),
		{ value: "none", label: tx("不使用模板", "No template") },
		...(snapshot && value === snapshot.id ? [{ value: snapshot.id, label: tx(`${snapshot.name}（当前快照）`, `${snapshot.name} (saved copy)`) }] : []),
		...items.filter((item) => item.id !== snapshot?.id || value !== snapshot.id).map((item) => ({ value: item.id, label: item.name })),
	];
	return <Space orientation="vertical" size={4} style={{ maxWidth: "100%" }}>
		<Select aria-label={tx("报告模板", "Report template")} style={{ width: 280, maxWidth: "100%" }} value={value === undefined ? "default" : value === null ? "none" : value}
			disabled={disabled || !data} loading={!data && !error} options={options} showSearch={{ optionFilterProp: "label" }}
			onOpenChange={(open) => { if (open) setRetry((current) => current + 1); }}
			onChange={(id: string) => onChange(id === "default" ? undefined : id === "none" ? null : id)} />
		{error ? <Alert type="error" title={error} action={<Button size="small" onClick={() => setRetry((current) => current + 1)}>{tx("重试", "Retry")}</Button>} /> : null}
	</Space>;
}
