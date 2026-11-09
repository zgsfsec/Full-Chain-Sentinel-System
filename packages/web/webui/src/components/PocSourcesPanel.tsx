/**
 * The POC subscription settings page: remote zip sources the operator follows.
 *
 * A source is a name, a zip URL, an optional auth header, and an optional
 * automatic interval. Everything here is operator territory — the agent has no
 * tool that can add, edit, or trigger a source. Syncs only upsert templates
 * (by id) and never delete; the header value is written to subscriptions.json
 * (0600) and never echoed back, so an edit leaves the field blank to keep the
 * stored secret.
 *
 * 「一键同步官方 POC」 is the same machinery with the source supplied: the
 * server creates the official nuclei-templates source if it is missing and
 * syncs it, so a first-time operator never has to know the URL. That source is
 * ordinary afterwards — this list edits, retargets, and deletes it like any
 * other, and pressing the button again recreates it.
 */

import {
	CloudDownloadOutlined,
	DeleteOutlined,
	EditOutlined,
	PlusOutlined,
	ReloadOutlined,
	SyncOutlined,
} from "@ant-design/icons";
import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { Alert, Button, Checkbox, Form, Input, Modal, Popconfirm, Select, Space, Tag, Typography } from "antd";
import { useState } from "react";
import { t } from "../i18n.ts";
import { SettingsEmpty } from "../ui/Settings.tsx";
import type { SentinelPocSource, SentinelPocSourceSave } from "../types.ts";
import { SENTINEL_OFFICIAL_POC_SOURCE_ID } from "../types.ts";

const { Text } = Typography;

/** Editing state of the form; a source being edited fills every field. */
interface Draft {
	id: string | null;
	name: string;
	url: string;
	headerName: string;
	headerValue: string;
	/** True while editing a source whose stored header value the form cannot show. */
	headerSet: boolean;
	intervalHours: number;
	enabled: boolean;
}

const EMPTY_DRAFT: Draft = {
	id: null,
	name: "",
	url: "",
	headerName: "",
	headerValue: "",
	headerSet: false,
	intervalHours: 24,
	enabled: true,
};

const INTERVAL_CHOICES: readonly number[] = [0, 1, 6, 24, 168];

function intervalLabel(hours: number): string {
	if (hours <= 0) return t("仅手动");
	if (hours === 168) return t("每 7 天");
	return t("每 {hours} 小时", { hours });
}

function formatWhen(value: string | null): string {
	if (!value) return t("从未同步");
	return value.slice(0, 19).replace("T", " ");
}

function resultLine(source: SentinelPocSource): string {
	const last = source.lastResult;
	if (!last) return t("暂无同步记录");
	const base = t("{status} · 新增 {imported} · 覆盖 {replaced} · 跳过 {skipped} · {duration}s", {
		status: last.ok ? t("成功") : t("失败"),
		imported: last.imported,
		replaced: last.replaced,
		skipped: last.skipped,
		duration: (last.durationMs / 1000).toFixed(1),
	});
	return last.ok ? base : `${base} · ${last.error ?? t("未知错误")}`;
}

/** Grey pill before the first sync, then green for ok and red for a failure. */
function statusOf(source: SentinelPocSource): { color: string; label: string } {
	if (!source.lastResult) return { color: "default", label: t("未同步") };
	return source.lastResult.ok
		? { color: "green", label: t("正常") }
		: { color: "red", label: t("失败") };
}

export function PocSourcesPanel({
	sources,
	syncing,
	onSave,
	onDelete,
	onSync,
	onRefresh,
	officialSyncing,
	onSyncOfficial,
}: {
	sources: SentinelPocSource[];
	/** Id currently syncing, so its row shows the wait instead of a second click. */
	syncing: string | null;
	onSave(source: SentinelPocSourceSave): void;
	onDelete(id: string): void;
	onSync(id: string): void;
	onRefresh(): void;
	/** True while the one-click official sync runs (it creates its own source). */
	officialSyncing: boolean;
	onSyncOfficial(): void;
}) {
	const [draft, setDraft] = useState<Draft | null>(null);
	const [error, setError] = useState<string | null>(null);

	const set = (patch: Partial<Draft>): void => {
		setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
	};

	const edit = (source: SentinelPocSource): void => {
		setDraft({
			id: source.id,
			name: source.name,
			url: source.url,
			headerName: source.headerName ?? "",
			// Blank keeps the stored secret; the form cannot show it back.
			headerValue: "",
			headerSet: source.headerSet,
			intervalHours: source.intervalHours,
			enabled: source.enabled,
		});
		setError(null);
	};

	const submit = (): void => {
		if (!draft) return;
		if (!draft.name.trim() || !draft.url.trim()) {
			setError(t("名称和 URL 不能为空"));
			return;
		}
		if (!/^https?:\/\//i.test(draft.url.trim())) {
			setError(t("URL 必须以 http:// 或 https:// 开头"));
			return;
		}
		setError(null);
		onSave({
			...(draft.id ? { id: draft.id } : {}),
			name: draft.name.trim(),
			url: draft.url.trim(),
			...(draft.headerName.trim() ? { headerName: draft.headerName.trim() } : {}),
			...(draft.headerValue ? { headerValue: draft.headerValue } : {}),
			intervalHours: draft.intervalHours,
			enabled: draft.enabled,
		});
		setDraft(null);
	};

	const columns: ProColumns<SentinelPocSource>[] = [
		{
			title: t("名称"),
			key: "name",
			width: 200,
			render: (_, source) => {
				const status = statusOf(source);
				return (
					<Space size={6} wrap>
						<Text strong>{source.name}</Text>
						<Tag
							color={status.color}
							variant="filled"
							title={source.enabled ? t("已启用") : t("已停用，不会自动同步")}
						>
							{source.enabled ? status.label : t("{label} · 已停用", { label: status.label })}
						</Tag>
					</Space>
				);
			},
		},
		{
			title: t("zip 直链"),
			dataIndex: "url",
			key: "url",
			width: 280,
			ellipsis: { showTitle: true },
			render: (_, source) => <Text code>{source.url}</Text>,
		},
		{
			title: t("同步"),
			key: "schedule",
			width: 150,
			render: (_, source) => (
				<div className="pocsource-schedule">
					<Text>{intervalLabel(source.intervalHours)}</Text>
					<Text type="secondary">{formatWhen(source.lastSyncAt)}</Text>
				</div>
			),
		},
		{
			title: t("最近结果"),
			key: "result",
			width: 220,
			ellipsis: { showTitle: true },
			render: (_, source) => (
				<Text
					type={source.lastResult && !source.lastResult.ok ? "danger" : "secondary"}
					title={resultLine(source)}
					ellipsis
				>
					{resultLine(source)}
				</Text>
			),
		},
		{
			title: t("操作"),
			key: "actions",
			width: 240,
			render: (_, source) => {
				// The official sync starts before its source exists in this list, so
				// its busy state is not keyed on the id alone.
				const busy =
					syncing === source.id || (officialSyncing && source.id === SENTINEL_OFFICIAL_POC_SOURCE_ID);
				return (
					<Space size={4} wrap>
						<Button
							size="small"
							type="link"
							icon={<SyncOutlined spin={busy} />}
							disabled={busy}
							onClick={() => onSync(source.id)}
						>
							{busy ? t("同步中…") : t("立即同步")}
						</Button>
						<Button size="small" type="link" icon={<EditOutlined />} onClick={() => edit(source)}>
							{t("编辑")}
						</Button>
						<Popconfirm
							title={t("删除订阅源")}
							description={t("删除订阅源「{name}」？已导入的模板不会被删除。", { name: source.name })}
							okText={t("删除")}
							okButtonProps={{ danger: true }}
							cancelText={t("取消")}
							onConfirm={() => onDelete(source.id)}
						>
							<Button size="small" type="link" danger icon={<DeleteOutlined />}>
								{t("删除")}
							</Button>
						</Popconfirm>
					</Space>
				);
			},
		},
	];

	return (
		<>
			<Alert
				type="info"
				showIcon
				className="ui-page__alert"
				title={t(
					"订阅远程 zip 模板包，支持手动同步与定时同步；按模板 id 新增或覆盖，不删除本地模板。",
				)}
				description={
					<Space orientation="vertical" size={6}>
						<div>{t("手动同步、同步官方和定时同步均使用同步开始时当前项目的代理；切换项目不改变本次同步所属的项目。项目未配置代理或未选择项目时，使用宿主机网络；代理异常时同步失败，不自动切换为直连。")}</div>
						<div>{t("下载限 512MB，单次请求 10 分钟超时，网络错误自动重试一次；每个源保留最近 5 次同步记录。")}</div>
					</Space>
				}
			/>


			<ProTable<SentinelPocSource>
				rowKey="id"
				size="small"
				columns={columns}
				dataSource={sources}
				search={false}
				options={false}
				pagination={false}
				tableLayout="fixed"
				scroll={{ x: 1137 }}
				toolbar={{
					title: (
						<Text strong>
							{t("订阅源")} <Text type="secondary">{t("（{count} 个）", { count: sources.length })}</Text>
						</Text>
					),
					actions: [
						<Button
							key="official"
							icon={<CloudDownloadOutlined />}
							loading={officialSyncing}
							title={t("从官方仓库 projectdiscovery/nuclei-templates 下载最新模板包并导入；源不存在会自动创建，之后 URL 可以改成镜像")}
							onClick={onSyncOfficial}
						>
							{officialSyncing ? t("同步中…") : t("一键同步官方 POC")}
						</Button>,
						<Button key="refresh" icon={<ReloadOutlined />} onClick={onRefresh}>
							{t("刷新")}
						</Button>,
						<Button
							key="add"
							type="primary"
							icon={<PlusOutlined />}
							onClick={() => {
								setError(null);
								setDraft({ ...EMPTY_DRAFT });
							}}
						>
							{t("添加订阅源")}
						</Button>,
					],
				}}
				expandable={{
					expandedRowRender: (source) => (
						<div className="pocsource-history">
							<Text strong>{t("最近 {count} 次同步", { count: source.history.length })}</Text>
							{source.history.length === 0 ? (
								<Text type="secondary">{t("还没有同步过。")}</Text>
							) : (
								source.history.map((record) => (
									<Text key={record.at} type={record.ok ? undefined : "danger"} className="pocsource-history__line">
										{t(
											"{when} · {status} · 新增 {imported} · 覆盖 {replaced} · 跳过 {skipped} · {duration}s · {trigger}",
											{
												when: formatWhen(record.at),
												status: record.ok ? t("成功") : t("失败"),
												imported: record.imported,
												replaced: record.replaced,
												skipped: record.skipped,
												duration: (record.durationMs / 1000).toFixed(1),
												trigger: record.trigger === "auto" ? t("自动") : t("手动"),
											},
										)}
										{record.error ? ` · ${record.error}` : ""}
									</Text>
								))
							)}
						</div>
					),
					expandRowByClick: false,
				}}
				locale={{
					emptyText: (
						<SettingsEmpty
							title={t("还没有订阅源")}
							hint={t("点右上角「添加订阅源」，填入 zip 直链；同步会把包内模板按 id 去重后并入 POC 库。")}
						/>
					),
				}}
			/>

			<Modal
				title={draft?.id ? t("编辑订阅源") : t("添加订阅源")}
				open={draft !== null}
				width={640}
				okText={draft?.id ? t("保存修改") : t("添加订阅源")}
				cancelText={t("取消")}
				okButtonProps={{ disabled: !draft?.name.trim() || !draft?.url.trim() }}
				onOk={submit}
				onCancel={() => {
					setDraft(null);
					setError(null);
				}}
				destroyOnHidden
			>
				{draft ? (
					<Form layout="vertical" requiredMark={false} onFinish={submit}>
						<div className="pocsource-grid">
							<Form.Item label={t("名称")} required>
								<Input
									value={draft.name}
									placeholder={t("内网模板包")}
									spellCheck={false}
									onChange={(event) => set({ name: event.target.value })}
								/>
							</Form.Item>
							<Form.Item label={t("同步间隔")}>
								<Select
									value={draft.intervalHours}
									onChange={(value) => set({ intervalHours: value })}
									options={INTERVAL_CHOICES.map((hours) => ({
										value: hours,
										label: intervalLabel(hours),
									}))}
								/>
							</Form.Item>
							<Form.Item label={t("zip 直链 URL")} required className="pocsource-grid__wide">
								<Input
									value={draft.url}
									placeholder="https://example.com/nuclei-templates.zip"
									spellCheck={false}
									onChange={(event) => set({ url: event.target.value })}
								/>
							</Form.Item>
							<Form.Item label={t("认证头名称（可选）")}>
								<Input
									value={draft.headerName}
									placeholder="Authorization"
									spellCheck={false}
									onChange={(event) => set({ headerName: event.target.value })}
								/>
							</Form.Item>
							<Form.Item label={t("认证头的值（可选）")}>
								<Input.Password
									value={draft.headerValue}
									placeholder={draft.headerSet ? t("留空保留原值") : "Bearer …"}
									spellCheck={false}
									onChange={(event) => set({ headerValue: event.target.value })}
								/>
							</Form.Item>
						</div>
						<Checkbox checked={draft.enabled} onChange={(event) => set({ enabled: event.target.checked })}>
							{t("启用（停用后不再自动同步，仍可手动「立即同步」）")}
						</Checkbox>
						{error ? <Alert type="error" showIcon title={error} className="ui-page__alert" /> : null}
					</Form>
				) : null}
			</Modal>
		</>
	);
}
