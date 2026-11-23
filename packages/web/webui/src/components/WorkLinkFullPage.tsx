import { ArrowLeftOutlined, FullscreenExitOutlined, FullscreenOutlined } from "@ant-design/icons";
import { Alert, Button, Result, Space, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { parseWorkLinkPage } from "../work-link-page.ts";
import { ThemeToggle } from "../ui/ThemeToggle.tsx";
import { PageBoundary } from "./PageBoundary.tsx";
import { workText as tx } from "./WorkProcessGraph.tsx";
import { WorkProcessDetail } from "./WorkProcessPage.tsx";
import "./work-process.css";

/** Runs inside the authenticated console, with all available space devoted to this graph. */
export function WorkLinkFullPage({ hash }: { hash: string }) {
	const route = parseWorkLinkPage(hash);
	const container = useRef<HTMLElement>(null);
	const [fullscreen, setFullscreen] = useState(false);
	const [fullscreenError, setFullscreenError] = useState(false);
	useEffect(() => {
		const update = () => setFullscreen(document.fullscreenElement === container.current);
		document.addEventListener("fullscreenchange", update);
		return () => { document.removeEventListener("fullscreenchange", update); };
	}, []);
	const toggleFullscreen = async () => {
		setFullscreenError(false);
		try {
			if (document.fullscreenElement === container.current) await document.exitFullscreen();
			else if (container.current?.requestFullscreen) await container.current.requestFullscreen();
			else setFullscreenError(true);
		} catch { setFullscreenError(true); }
	};
	return <main className="work-link-fullpage" ref={container} aria-label={tx("工作链路独立页面", "Work links full page")}>
		<header className="work-link-fullpage__header">
			<Space wrap><Typography.Text strong>{tx("工作链路", "Work links")}</Typography.Text><Typography.Text type="secondary">{tx("独立视图", "Expanded view")}</Typography.Text></Space>
			<Space wrap><Button href="#" icon={<ArrowLeftOutlined />}>{tx("返回控制台", "Back to console")}</Button><ThemeToggle />
				<Button icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={() => void toggleFullscreen()}>{fullscreen ? tx("退出全屏", "Exit fullscreen") : tx("进入全屏", "Enter fullscreen")}</Button>
			</Space>
		</header>
		{fullscreenError ? <Alert type="info" showIcon closable title={tx("浏览器未允许全屏，仍可在当前展开页面查看链路。", "Fullscreen is unavailable. The expanded page remains available.")} onClose={() => setFullscreenError(false)} /> : null}
		{route ? <PageBoundary><WorkProcessDetail key={`${route.target.projectId}:${route.target.kind}:${route.target.id}`} target={route.target} initialSelectedId={route.selectedId} expanded /></PageBoundary>
			: <Result status="warning" title={tx("工作链路链接无效", "Invalid work links URL")} subTitle={tx("请从对应对话或工程的工作链路重新打开。", "Open this view again from the conversation or engineering work links.")} />}
	</main>;
}
