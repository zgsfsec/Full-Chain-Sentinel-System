import { ApartmentOutlined } from "@ant-design/icons";
import { Alert, Button, Drawer, Space, Spin, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import type { WorkProcess } from "../../../src/work-process-types.ts";
import { readJson } from "../read-json.ts";
import { ensureWorkLinkEnabled } from "../work-link-client.ts";
import { PageBoundary } from "./PageBoundary.tsx";
import { workText as tx } from "./WorkProcessGraph.tsx";
import { WorkProcessDetail } from "./WorkProcessPage.tsx";

/** Scoped by the parent key to one project and conversation, including an empty new chat. */
export function WorkLinkControl({ projectId, sessionId }: { projectId: string | null; sessionId: string | null }) {
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [process, setProcess] = useState<WorkProcess | null>(null);
	const request = useRef<AbortController | null>(null);
	useEffect(() => () => { request.current?.abort(); }, []);
	useEffect(() => {
		if (!projectId || !sessionId || open) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				const query = new URLSearchParams({ projectId, kind: "session", id: sessionId });
				const result = await readJson<{ process: WorkProcess }>(`/api/work-processes/detail?${query}`, controller.signal);
				if (!controller.signal.aborted) setProcess(result.process);
			} catch { /* Activation and the detail panel show actionable request failures. */ }
			finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000); }
		};
		void poll();
		return () => { controller.abort(); clearTimeout(timer); };
	}, [projectId, sessionId, open]);
	const start = async () => {
		if (!projectId || !sessionId || request.current) return;
		const controller = new AbortController();
		request.current = controller;
		setPending(true);
		setError(null);
		setOpen(true);
		try {
			const result = await ensureWorkLinkEnabled({ projectId, kind: "session", id: sessionId }, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
			if (!controller.signal.aborted) setProcess(result);
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!controller.signal.aborted) { request.current = null; setPending(false); }
		}
	};
	return <>
		<Button size="small" icon={<ApartmentOutlined />} type={process?.enabled ? "primary" : "default"} loading={pending}
			disabled={!projectId || !sessionId} aria-expanded={open} aria-label={tx("工作链路", "Work links")}
			title={process?.enabled ? tx("查看当前对话的工作链路；关闭视图后继续记录", "View this conversation's work links. Recording continues when the view closes.") : tx("开启当前对话的工作链路：补齐已有记录，并持续分析后续记录", "Enable work links for this conversation, including existing and future records.")}
			onClick={() => void start()}>{tx("工作链路", "Work links")}</Button>
		<Drawer title={<Space>{tx("工作链路", "Work links")}<Tag>{tx("当前对话", "This conversation")}</Tag></Space>}
			open={open} onClose={() => setOpen(false)} size="min(1440px, 100vw)" destroyOnHidden
			styles={{ body: { display: "flex", minHeight: 0, padding: 16 } }}>
			{pending ? <Space className="work-process__loading"><Spin />{tx("正在开启工作链路", "Enabling work links")}</Space> : error ?
				<Alert type="error" showIcon title={error} action={<Button onClick={() => void start()}>{tx("重试", "Retry")}</Button>} /> : projectId && sessionId ?
					<PageBoundary><WorkProcessDetail target={{ projectId, kind: "session", id: sessionId }} /></PageBoundary> : null}
		</Drawer>
	</>;
}
