import { CloudDownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Space, Tag, Tooltip, Typography } from "antd";
import { useEffect, useSyncExternalStore } from "react";
import { PROJECT_RELEASES_URL } from "../branding.ts";
import { getLanguage } from "../i18n.ts";
import { VERSION_CHECK_INTERVAL_MS, versionChecker } from "../version-check.ts";
import "./VersionCheck.css";

const tx = (zh: string, en: string) => (getLanguage() === "en" ? en : zh);

export function useVersionCheck() {
	const state = useSyncExternalStore(versionChecker.subscribe, versionChecker.getSnapshot, versionChecker.getSnapshot);
	useEffect(() => {
		void versionChecker.check();
		const visible = () => {
			if (!document.hidden) void versionChecker.check();
		};
		const timer = setInterval(visible, VERSION_CHECK_INTERVAL_MS);
		document.addEventListener("visibilitychange", visible);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", visible);
		};
	}, []);
	return state;
}

export function VersionCheck() {
	const state = useVersionCheck();
	return (
		<Space size={8} wrap>
			{state.result?.updateAvailable ? (
				<>
					<Tag color="blue">
						{tx("发现新版本", "New version")} v{state.result.latestVersion}
					</Tag>
					<Button
						size="small"
						type="link"
						icon={<CloudDownloadOutlined />}
						href={PROJECT_RELEASES_URL}
						target="_blank"
						rel="noopener noreferrer"
					>
						{tx("前往手动更新", "Open releases")}
					</Button>
				</>
			) : state.result && !state.error ? (
				<Typography.Text type="secondary">{tx("当前已是最新版本", "Already up to date")}</Typography.Text>
			) : null}
			{state.error ? (
				<Tooltip
					title={
						state.error === "unpublished"
							? tx("官方仓库尚未发布正式版本。", "No stable release has been published.")
							: tx(
									"无法读取官方版本，请检查 GitHub 连接后重试。",
									"Cannot read the official version. Check GitHub connectivity and retry.",
								)
					}
				>
					<Typography.Text type="secondary">{tx("未能完成版本检测", "Version check unavailable")}</Typography.Text>
				</Tooltip>
			) : null}
			<Button
				size="small"
				icon={<ReloadOutlined />}
				loading={state.checking}
				onClick={() => void versionChecker.check(true)}
			>
				{tx("检查更新", "Check for updates")}
			</Button>
		</Space>
	);
}
