import { CopyOutlined, DeleteOutlined, RightOutlined } from "@ant-design/icons";
import { Alert, Button, Collapse, Input, Select, Tabs, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n.ts";
import {
	SENTINEL_ASSET_KIND_LABELS,
	SENTINEL_ASSET_OUTCOMES,
	SENTINEL_ASSET_OUTCOME_LABELS,
	SENTINEL_ASSET_STATES,
	SENTINEL_ASSET_STATE_LABELS,
	SENTINEL_VULN_SEVERITY_LABELS,
} from "../types.ts";
import type {
	SentinelAssetDetail,
	SentinelAssetOutcome,
	SentinelAssetState,
	SentinelAssetUpdate,
	SentinelVulnSeverity,
} from "../types.ts";
import "../styles/asset-detail.css";

const OUTCOME_COLORS: Record<SentinelAssetOutcome, string> = {
	note: "default",
	clean: "green",
	suspicious: "orange",
	vulnerable: "red",
	unreachable: "default",
};

const SEVERITY_COLORS: Record<SentinelVulnSeverity, string> = {
	critical: "red",
	high: "volcano",
	medium: "gold",
	low: "blue",
	info: "default",
};

function formatWhen(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString(undefined, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

/** The standalone body is also used by render tests, without a drawer portal. */
export function AssetDetailBody({
	detail,
	onUpdate,
	onRequestDelete,
	onOpenVuln,
}: {
	detail: SentinelAssetDetail;
	onClose: () => void;
	onUpdate: (id: string, patch: SentinelAssetUpdate) => void;
	onRequestDelete: (ids: string[]) => void;
	onOpenVuln: (id: string) => void;
}) {
	const { asset, vulns } = detail;
	const [tags, setTags] = useState(asset.tags.join(", "));
	const [outcome, setOutcome] = useState<SentinelAssetOutcome>("note");
	const [note, setNote] = useState("");
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
	const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		setTags(asset.tags.join(", "));
	}, [asset.id, asset.tags]);

	useEffect(() => {
		setOutcome("note");
		setNote("");
		setCopyState("idle");
		return () => {
			if (copyTimer.current !== null) clearTimeout(copyTimer.current);
		};
	}, [asset.id]);

	const saveTags = (): void => {
		onUpdate(asset.id, {
			tags: tags
				.split(/[,，]/)
				.map((tag) => tag.trim())
				.filter(Boolean),
		});
	};

	const copy = async (): Promise<void> => {
		const text = asset.url ?? asset.name;
		let copied = false;
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
		} catch {
			const previousFocus = document.activeElement;
			const area = document.createElement("textarea");
			area.value = text;
			area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
			document.body.appendChild(area);
			area.select();
			try {
				copied = document.execCommand("copy");
			} catch {
				copied = false;
			} finally {
				area.remove();
				if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
			}
		}
		setCopyState(copied ? "copied" : "failed");
		if (copyTimer.current !== null) clearTimeout(copyTimer.current);
		copyTimer.current = setTimeout(() => setCopyState("idle"), 1500);
	};

	const fields = [
		{ label: t("域名"), value: asset.domain, mono: true },
		{ label: t("IP"), value: asset.ip, mono: true },
		{
			label: t("端口"),
			value: asset.port === undefined ? undefined : `${asset.port}${asset.transport ? `/${asset.transport}` : ""}`,
			mono: true,
		},
		{ label: t("协议"), value: asset.protocol, mono: true },
		{ label: t("URL"), value: asset.url, mono: true, full: true },
		{ label: t("标题"), value: asset.title, full: true },
		{ label: t("服务"), value: asset.server },
		{ label: t("技术栈"), value: asset.tech },
	];

	return (
		<div className="asset-inspector">
			<header className="asset-inspector__identity">
				<div className="asset-inspector__eyebrow">
					<span>{asset.label}</span>
					<span>{SENTINEL_ASSET_KIND_LABELS[asset.kind]}</span>
				</div>
				<h2>{asset.name}</h2>
				<div className="asset-inspector__actions">
					<label htmlFor={`asset-status-${asset.id}`}>{t("状态")}</label>
					<Select<SentinelAssetState>
						id={`asset-status-${asset.id}`}
						aria-label={t("状态")}
						size="small"
						value={asset.status}
						onChange={(status) => onUpdate(asset.id, { status })}
						options={SENTINEL_ASSET_STATES.map((state) => ({
							value: state,
							label: SENTINEL_ASSET_STATE_LABELS[state],
						}))}
					/>
					<Button size="small" type="text" icon={<CopyOutlined />} onClick={() => void copy()}>
						<span aria-live="polite">
							{copyState === "copied" ? t("已复制") : copyState === "failed" ? t("复制失败") : t("复制")}
						</span>
					</Button>
					<Button
						className="asset-inspector__delete"
						size="small"
						type="text"
						danger
						icon={<DeleteOutlined />}
						onClick={() => onRequestDelete([asset.id])}
					>
						{t("删除")}
					</Button>
				</div>
			</header>

			<dl className="asset-inspector__summary">
				<div>
					<dt>{t("测试记录")}</dt>
					<dd>{asset.testCount}</dd>
				</div>
				<div>
					<dt>{t("关联漏洞")}</dt>
					<dd>{vulns.length}</dd>
				</div>
				<div>
					<dt>{t("最近结论")}</dt>
					<dd>
						<Tag color={OUTCOME_COLORS[asset.lastOutcome ?? "note"]} variant="filled">
							{asset.lastOutcome ? SENTINEL_ASSET_OUTCOME_LABELS[asset.lastOutcome] : t("无结论")}
						</Tag>
					</dd>
				</div>
			</dl>

			{asset.lastOutcome === "vulnerable" && vulns.length === 0 ? (
				<Alert
					type="warning"
					showIcon
					title={t("最近一次测试结论为「有漏洞」，但没有关联的漏洞中枢记录；核实后用 vuln_submit 补交。")}
				/>
			) : null}

			<Tabs
				key={asset.id}
				className="asset-inspector__tabs"
				defaultActiveKey="info"
				items={[
					{
						key: "info",
						label: t("基本信息"),
						children: (
							<section className="asset-inspector__section" aria-label={t("基本信息")}>
								<dl className="asset-inspector__facts">
									{fields
										.filter((field) => field.value !== undefined && field.value !== "")
										.map((field) => (
											<div key={field.label} className={field.full ? "asset-inspector__fact--full" : undefined}>
												<dt>{field.label}</dt>
												<dd className={field.mono ? "asset-inspector__mono" : undefined}>{field.value}</dd>
											</div>
										))}
									<div>
										<dt>{t("来源")}</dt>
										<dd>{asset.source}</dd>
									</div>
									<div>
										<dt>{t("会话")}</dt>
										<dd>{asset.sessionName ?? "—"}</dd>
									</div>
									<div>
										<dt>{t("首次发现")}</dt>
										<dd>{formatWhen(asset.firstSeenAt)}</dd>
									</div>
									<div>
										<dt>{t("最近发现")}</dt>
										<dd>{formatWhen(asset.lastSeenAt)}</dd>
									</div>
								</dl>
								<div className="asset-inspector__tag-section">
									<label htmlFor={`asset-tags-${asset.id}`}>{t("标签")}</label>
									{asset.tags.length > 0 ? (
										<div className="asset-inspector__tags">
											{asset.tags.map((tag) => (
												<Tag key={tag} variant="filled">
													{tag}
												</Tag>
											))}
										</div>
									) : null}
									<div className="asset-inspector__tag-editor">
										<Input
											id={`asset-tags-${asset.id}`}
											size="small"
											value={tags}
											placeholder={t("用逗号分隔，如 OA, 后台")}
											spellCheck={false}
											onChange={(event) => setTags(event.target.value)}
											onPressEnter={saveTags}
										/>
										<Button size="small" onClick={saveTags}>
											{t("保存标签")}
										</Button>
									</div>
								</div>
							</section>
						),
					},
					{
						key: "records",
						label: (
							<span className="asset-inspector__tab-label">
								{t("测试记录")}
								<span>{asset.testCount}</span>
							</span>
						),
						forceRender: true,
						children: (
							<section className="asset-inspector__section" aria-label={t("时间线")}>
								<Collapse
									key={asset.id}
									className="asset-inspector__composer"
									size="small"
									expandIconPlacement="end"
									items={[
										{
											key: "record",
											label: t("添加记录"),
											children: (
												<div className="asset-inspector__record">
													<Input.TextArea
														aria-label={t("操作员记录")}
														value={note}
														placeholder={t("操作员记录：复核结论、备注或证据出处")}
														autoSize={{ minRows: 3, maxRows: 7 }}
														onChange={(event) => setNote(event.target.value)}
													/>
													<div className="asset-inspector__record-actions">
														<Select<SentinelAssetOutcome>
															aria-label={t("测试结论")}
															size="small"
															value={outcome}
															onChange={setOutcome}
															options={SENTINEL_ASSET_OUTCOMES.map((value) => ({
																value,
																label: SENTINEL_ASSET_OUTCOME_LABELS[value],
															}))}
														/>
														<Button
															size="small"
															type="primary"
															disabled={note.trim() === "" && outcome === "note"}
															onClick={() => {
																if (note.trim() === "" && outcome === "note") return;
																onUpdate(asset.id, { outcome, ...(note.trim() ? { note } : {}) });
																setNote("");
															}}
														>
															{t("添加记录")}
														</Button>
													</div>
												</div>
											),
										},
									]}
								/>
								{asset.entries.length === 0 ? (
									<p className="asset-inspector__empty">
										{t("还没有测试记录：Agent 用 asset_note 记录，操作员也可以在上方添加。")}
									</p>
								) : (
									<ol className="asset-inspector__timeline">
										{asset.entries.map((entry) => (
											<li
												key={entry.seq}
												className={entry.kind === "status" ? "asset-inspector__event--status" : undefined}
											>
												<div className="asset-inspector__event-meta">
													<time dateTime={entry.at}>{formatWhen(entry.at)}</time>
													<span>{entry.author === "operator" ? t("操作员") : (entry.source ?? t("代理"))}</span>
													<Tag
														color={entry.kind === "status" ? "default" : OUTCOME_COLORS[entry.outcome]}
														variant="filled"
													>
														{entry.kind === "status" ? t("状态") : SENTINEL_ASSET_OUTCOME_LABELS[entry.outcome]}
													</Tag>
													{entry.vulnLabel ? <Tag>{entry.vulnLabel}</Tag> : null}
												</div>
												{entry.method ? <code className="asset-inspector__method">{entry.method}</code> : null}
												{entry.text.trim() ? <p>{entry.text}</p> : null}
											</li>
										))}
									</ol>
								)}
							</section>
						),
					},
					{
						key: "vulns",
						label: (
							<span className="asset-inspector__tab-label">
								{t("关联漏洞")}
								<span>{vulns.length}</span>
							</span>
						),
						forceRender: true,
						children: (
							<section className="asset-inspector__section" aria-label={t("关联漏洞")}>
								{vulns.length === 0 ? (
									<p className="asset-inspector__empty">{t("没有关联的漏洞记录")}</p>
								) : (
									<div className="asset-inspector__vulns">
										{vulns.map((vuln) => (
											<button
												key={vuln.id}
												type="button"
												className="asset-inspector__vuln"
												onClick={() => onOpenVuln(vuln.id)}
											>
												<span className="asset-inspector__vuln-meta">
													<Tag color={SEVERITY_COLORS[vuln.severity]} variant="filled">
														{SENTINEL_VULN_SEVERITY_LABELS[vuln.severity]}
													</Tag>
													<span>{vuln.label}</span>
												</span>
												<span className="asset-inspector__vuln-title">{vuln.title}</span>
												<RightOutlined />
											</button>
										))}
									</div>
								)}
							</section>
						),
					},
				]}
			/>
		</div>
	);
}
