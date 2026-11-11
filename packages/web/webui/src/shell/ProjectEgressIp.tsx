import { ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import { useEffect, useRef, useState } from "react";
import type { ProjectEgressIp as EgressResult } from "../../../src/project-egress-types.ts";
import { getLanguage } from "../i18n.ts";
import { readJson } from "../read-json.ts";
import "./project-egress-ip.css";

const tx = (zh: string, en: string) => (getLanguage() === "en" ? en : zh);

/** Mounted with the project id as its key so late replies cannot reach another project. */
export function ProjectEgressIp({ projectId, connected }: { projectId: string; connected: boolean }) {
	const [result, setResult] = useState<EgressResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [testing, setTesting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pending = useRef<AbortController | null>(null);
	const url = `/api/projects/egress-ip?projectId=${encodeURIComponent(projectId)}`;

	useEffect(() => {
		const controller = new AbortController();
		void readJson<{ result: EgressResult | null }>(url, controller.signal)
			.then((body) => {
				if (!controller.signal.aborted) setResult(body.result);
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => {
			controller.abort();
			pending.current?.abort();
		};
	}, [url]);

	const testIp = async () => {
		if (loading || pending.current || !connected) return;
		const controller = new AbortController();
		pending.current = controller;
		const timer = setTimeout(() => controller.abort(), 35000);
		setTesting(true);
		setError(null);
		try {
			const response = await fetch(url, { method: "POST", signal: controller.signal });
			const body = (await response.json()) as { result?: EgressResult; error?: string };
			if (!response.ok || !body.result) {
				throw new Error(body.error || tx("测试失败，请重试。", "Test failed. Please retry."));
			}
			setResult(body.result);
		} catch (cause) {
			setError(
				controller.signal.aborted
					? tx("测试超时，请重试。", "Test timed out. Please retry.")
					: cause instanceof Error ? cause.message : String(cause),
			);
		} finally {
			clearTimeout(timer);
			pending.current = null;
			setTesting(false);
		}
	};

	const actionLabel = testing
		? tx("正在检测出口 IP", "Checking exit IP")
		: result
			? tx("重新检测出口 IP", "Recheck exit IP")
			: tx("检测出口 IP", "Check exit IP");

	return (
		<div className="project-egress-ip" role="group" aria-label={tx("项目出口 IP", "Project exit IP")} aria-busy={loading || testing}>
			{result ? (
				<Tooltip
					title={`${result.ip}${result.location ? ` · ${result.location}` : ""} · ${tx("上次测试", "Last tested")}: ${new Date(result.testedAt).toLocaleString()} · ${tx("按项目保存，仅重新测试时更新", "Saved per project; updated only when retested")}`}
				>
					<span className="project-egress-ip__value" role="status">
						<span className="project-egress-ip__address">{result.ip}</span>
						{result.location ? <span> · {result.location}</span> : null}
					</span>
				</Tooltip>
			) : (
				<span className="project-egress-ip__placeholder">{tx("出口 IP", "Exit IP")}</span>
			)}
			<Tooltip title={actionLabel}>
				<span className="project-egress-ip__action">
					<Button
						type="text"
						size="small"
						shape="circle"
						className="project-egress-ip__refresh"
						icon={<ReloadOutlined spin={testing} />}
						disabled={loading || testing || !connected}
						onClick={() => void testIp()}
						aria-label={actionLabel}
					/>
				</span>
			</Tooltip>
			{error ? (
				<Tooltip title={error}>
					<span className="project-egress-ip__error" role="alert" aria-label={error}>
						<WarningOutlined />
					</span>
				</Tooltip>
			) : null}
		</div>
	);
}
