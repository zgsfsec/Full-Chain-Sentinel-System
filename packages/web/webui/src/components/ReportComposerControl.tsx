import { DownOutlined, FileTextOutlined } from "@ant-design/icons";
import { Button, Popover, Space, Typography } from "antd";
import { useState } from "react";
import type { ReportTemplateSummary } from "../../../src/report-types.ts";
import { getLanguage } from "../i18n.ts";
import { ReportTemplateSelect } from "./ReportTemplateSelect.tsx";
import "./ReportComposerControl.css";

const tx = (zh: string, en: string) => getLanguage() === "en" ? en : zh;

export function ReportComposerControl({ projectId, enabled, readOnly, streaming, blocked, template, onChange }: {
	projectId: string | null;
	enabled: boolean;
	readOnly: boolean;
	streaming: boolean;
	blocked: boolean;
	template?: Pick<ReportTemplateSummary, "id" | "name" | "revision"> | null;
	onChange: (enabled: boolean, templateId?: string | null) => void;
}) {
	const [open, setOpen] = useState(false);
	const templateName = template?.name ?? tx("自由生成", "Free-form");
	const title = !projectId ? tx("请先选择项目", "Select a project first") : readOnly
		? tx("工程任务沿用工程的自动报告流程", "Engineering tasks use their engine's report workflow")
		: enabled ? tx(`已启用报告 · ${templateName}；点击关闭`, `Reports enabled · ${templateName}. Click to disable.`)
			: tx("启用当前对话的报告提交和证据截图", "Enable report submission and evidence screenshots for this conversation");
	return <Space.Compact className={`report-composer-control${enabled ? " is-enabled" : ""}`}>
		<Button size="small" icon={<FileTextOutlined />} aria-pressed={enabled} disabled={!projectId || readOnly} title={title}
			onClick={() => { setOpen(false); onChange(!enabled); }}>
			{tx("报告中心", "Reports")}
			{enabled ? <span className="report-composer-control__status" aria-hidden="true" /> : null}
		</Button>
		{enabled && !readOnly && projectId ? <Popover trigger="click" placement="topRight" open={open} onOpenChange={setOpen}
			content={<div className="report-composer-settings">
				<div className="report-composer-settings__heading"><Typography.Text strong>{tx("报告模板", "Report template")}</Typography.Text><Typography.Text type="secondary">{tx("当前对话", "This conversation")}</Typography.Text></div>
				<ReportTemplateSelect key={projectId} projectId={projectId} value={template?.id ?? null} snapshot={template} inherit={false} disabled={streaming || blocked}
					onChange={(id) => { onChange(true, id ?? null); setOpen(false); }} />
				<Typography.Text type="secondary" className="report-composer-settings__hint">{streaming ? tx("运行结束后可更换模板。", "Change the template after the run ends.") : tx("未选模板时由 Agent 自由组织报告。", "Without a template, the agent chooses the report structure.")}</Typography.Text>
			</div>}>
			<Button size="small" className="report-composer-control__settings" icon={<DownOutlined />} aria-label={tx("报告模板设置", "Report template settings")} aria-expanded={open} title={tx(`报告模板：${templateName}`, `Report template: ${templateName}`)} />
		</Popover> : null}
	</Space.Compact>;
}
