/**
 * Conversations shown in the console's sidebar, grouped by engine, with
 * search, filters, and per-session actions.
 */

import {
	DownOutlined,
	FilterOutlined,
	MenuFoldOutlined,
	MenuUnfoldOutlined,
	PlusOutlined,
	RightOutlined,
	SearchOutlined,
} from "@ant-design/icons";
import { App, Badge, Button, ConfigProvider, Dropdown, Empty, Input, Modal, Tooltip, Typography } from "antd";
import { useEffect, useId, useMemo, useState } from "react";
import { t } from "../i18n.ts";
import { consoleThemes } from "../ui/theme.ts";
import { useThemeMode } from "../ui/theme-mode.ts";
import type { SentinelEngine, SentinelSessionStatus, SessionInfoView } from "../types.ts";
import { SESSION_STATUSES, SESSION_STATUS_LABELS } from "../components/SessionStatusControl.tsx";
import { SessionActions } from "./SessionActions.tsx";

const { Text } = Typography;

type StatusFilter = SentinelSessionStatus | "none";
type SourceFilter = "all" | "chat" | "engine";

const OPEN_STATUSES: StatusFilter[] = ["todo", "active", "none"];

const STORAGE_STATUS = "sentinel-session-filter";
const STORAGE_SOURCE = "sentinel-session-source";
const STORAGE_COLLAPSED = "sentinel-session-collapsed-groups";

function readStatusFilter(): StatusFilter[] {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_STATUS) ?? "[]");
		return Array.isArray(stored)
			? [...new Set(stored.filter((value): value is StatusFilter => value === "none" || SESSION_STATUSES.includes(value)))]
			: [];
	} catch {
		return [];
	}
}

function readSourceFilter(): SourceFilter {
	try {
		const stored = localStorage.getItem(STORAGE_SOURCE);
		return stored === "chat" || stored === "engine" ? stored : "all";
	} catch {
		return "all";
	}
}

/** The dot says what the session is doing; the menu says what the operator decided. */
function dotStatus(
	session: SessionInfoView,
	running: boolean,
): "success" | "processing" | "warning" | "default" | "error" {
	if (session.engine) {
		switch (session.engine.taskStatus) {
			case "running":
			case "queued":
				return "processing";
			case "done":
				return "success";
			case "failed":
			case "aborted":
				return "error";
			case "blocked":
			case "paused":
				return "warning";
			default:
				return "default";
		}
	}
	if (running) return "processing";
	if (session.status === "active") return "warning";
	if (session.status === "done") return "success";
	if (session.status === "ignored") return "default";
	return "default";
}

function rowLabel(session: SessionInfoView): string {
	const raw = session.name ?? session.firstMessage.slice(0, 60);
	const prefix = session.engine?.engineName;
	if (prefix && raw.startsWith(`${prefix} · `)) return raw.slice(prefix.length + 3);
	return raw || t("未命名会话");
}

export interface SessionPanelProps {
	sessions: SessionInfoView[];
	activeSessionId: string | null;
	runningSessions: string[];
	engines: SentinelEngine[];
	onNew: () => void;
	onSwitch: (path: string) => void;
	onRename: (path: string, name: string) => void;
	onDelete: (path: string) => void;
	onSetStatus: (path: string, status: SentinelSessionStatus | null) => void;
}

export function SessionPanel({
	sessions,
	activeSessionId,
	runningSessions,
	onNew,
	onSwitch,
	onRename,
	onDelete,
	onSetStatus,
}: SessionPanelProps) {
	const themeMode = useThemeMode();
	const { modal } = App.useApp();
	const [query, setQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState<StatusFilter[]>(readStatusFilter);
	const [sourceFilter, setSourceFilter] = useState<SourceFilter>(readSourceFilter);
	const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
	const groupId = useId();
	const [collapsed, setCollapsed] = useState<string[]>(() => {
		try {
			const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_COLLAPSED) ?? "[]");
			return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [];
		} catch {
			return [];
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_COLLAPSED, JSON.stringify(collapsed));
		} catch {
			// Group toggles still work when browser storage is unavailable.
		}
	}, [collapsed]);

	const setStatus = (next: StatusFilter[]) => {
		setStatusFilter(next);
		try {
			localStorage.setItem(STORAGE_STATUS, JSON.stringify(next));
		} catch {
			// Filtering still works when browser storage is unavailable.
		}
	};
	const setSource = (next: SourceFilter) => {
		setSourceFilter(next);
		try {
			localStorage.setItem(STORAGE_SOURCE, next);
		} catch {
			// Filtering still works when browser storage is unavailable.
		}
	};

	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return sessions.filter((session) => {
			if (statusFilter.length > 0 && !statusFilter.includes(session.status ?? "none")) return false;
			if (sourceFilter === "chat" && session.engine) return false;
			if (sourceFilter === "engine" && !session.engine) return false;
			if (!needle) return true;
			return rowLabel(session).toLowerCase().includes(needle) || session.firstMessage.toLowerCase().includes(needle);
		});
	}, [sessions, statusFilter, sourceFilter, query]);

	const groups = useMemo(() => {
		const chatSessions = visible.filter((session) => !session.engine);
		const engines = new Map<string, { key: string; name: string; sessions: SessionInfoView[] }>();
		for (const session of visible) {
			if (!session.engine) continue;
			const group = engines.get(session.engine.engineId) ?? {
				key: `engine:${session.engine.engineId}`,
				name: session.engine.engineName,
				sessions: [],
			};
			group.sessions.push(session);
			engines.set(session.engine.engineId, group);
		}
		return [
			...(chatSessions.length ? [{ key: "chat", name: t("对话"), sessions: chatSessions }] : []),
			...engines.values(),
		];
	}, [visible]);
	const allCollapsed = groups.length > 0 && groups.every((group) => collapsed.includes(group.key));
	const openOnly = statusFilter.length === OPEN_STATUSES.length && OPEN_STATUSES.every((status) => statusFilter.includes(status));

	const row = (session: SessionInfoView) => {
		const active = session.id === activeSessionId;
		const running = runningSessions.includes(session.id);
		return (
			<div
				key={session.path}
				className={active ? "session-row is-active" : "session-row"}
				role="button"
				tabIndex={0}
				aria-current={active ? "true" : undefined}
				onClick={() => onSwitch(session.path)}
				onKeyDown={(event) => {
					if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
						event.preventDefault();
						onSwitch(session.path);
					}
				}}
			>
				<Badge status={dotStatus(session, running)} className="session-row__dot" />
				<span className="session-row__name" title={rowLabel(session)}>
					{rowLabel(session)}
				</span>
				{session.status ? (
					<span className="session-row__status">{SESSION_STATUS_LABELS[session.status]}</span>
				) : null}
				<SessionActions
					status={session.status}
					onRename={() => setRenaming({ path: session.path, name: rowLabel(session) })}
					onSetStatus={(status) => onSetStatus(session.path, status)}
					onDelete={() => modal.confirm({
						title: t("删除会话"),
						content: t("删除「{name}」？该操作不可恢复。", { name: rowLabel(session) }),
						okText: t("删除"),
						okButtonProps: { danger: true },
						cancelText: t("取消"),
						onOk: () => onDelete(session.path),
					})}
				/>
			</div>
		);
	};

	return (
		<aside className="session-panel" aria-label={t("会话")}>
			<div className="session-panel__head">
				<Text strong className="session-panel__title">
					{t("会话")}
				</Text>
				<Text type="secondary" className="session-panel__count">
					{visible.length === sessions.length ? sessions.length : `${visible.length} / ${sessions.length}`}
				</Text>
				<Tooltip title={allCollapsed ? t("全部展开") : t("全部折叠")}>
					<Button
						type="text"
						size="small"
						icon={allCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
						disabled={groups.length === 0}
						aria-label={allCollapsed ? t("全部展开") : t("全部折叠")}
						onClick={() =>
							setCollapsed((previous) =>
								allCollapsed
									? previous.filter((key) => !groups.some((group) => group.key === key))
									: [...new Set([...previous, ...groups.map((group) => group.key)])],
							)
						}
					/>
				</Tooltip>
				<Tooltip title={t("新建会话")}>
					<Button type="primary" size="small" icon={<PlusOutlined />} onClick={onNew} aria-label={t("新建会话")} />
				</Tooltip>
			</div>

			<div className="session-panel__tools">
				<Input
					allowClear
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					prefix={<SearchOutlined className="session-panel__search-icon" />}
					placeholder={t("搜索会话")}
					aria-label={t("搜索会话")}
				/>
				<Dropdown
					trigger={["click"]}
					menu={{
						selectable: true,
						multiple: true,
						selectedKeys: [
							...(statusFilter.length === 0 ? ["status:all"] : statusFilter.map((status) => `status:${status}`)),
							...(openOnly ? ["status:open"] : []),
							`source:${sourceFilter}`,
						],
						items: [
							{
								type: "group",
								label: t("状态"),
								children: [
									{ key: "status:all", label: t("全部") },
									{ key: "status:open", label: t("未完成") },
									...SESSION_STATUSES.map((status) => ({ key: `status:${status}`, label: SESSION_STATUS_LABELS[status] })),
									{ key: "status:none", label: t("未标记") },
								],
							},
							{
								type: "group",
								label: t("来源"),
								children: [
									{ key: "source:all", label: t("全部来源") },
									{ key: "source:chat", label: t("对话") },
									{ key: "source:engine", label: t("工程") },
								],
							},
						],
						onClick: ({ key }) => {
							if (key === "status:all") setStatus([]);
							else if (key === "status:open") setStatus(OPEN_STATUSES);
							else if (key.startsWith("status:")) {
								const value = key.slice("status:".length);
								if (value === "none" || SESSION_STATUSES.includes(value as SentinelSessionStatus)) {
									const status = value as StatusFilter;
									setStatus(statusFilter.includes(status) ? statusFilter.filter((item) => item !== status) : [...statusFilter, status]);
								}
							}
							if (key === "source:all" || key === "source:chat" || key === "source:engine") {
								setSource(key === "source:chat" ? "chat" : key === "source:engine" ? "engine" : "all");
							}
						},
					}}
				>
					<Badge dot={statusFilter.length > 0 || sourceFilter !== "all"}>
						<Button
							className="session-panel__filter"
							icon={<FilterOutlined />}
							aria-label={t("筛选会话")}
							title={t("筛选会话")}
						/>
					</Badge>
				</Dropdown>
			</div>

			<div className="session-panel__list">
				{visible.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("没有匹配的会话")} /> : null}
				{groups.map((group) => {
					const isCollapsed = collapsed.includes(group.key);
					const hasRunning = group.sessions.some(
						(session) => dotStatus(session, runningSessions.includes(session.id)) === "processing",
					);
					const contentId = `${groupId}-${group.key}`;
					return (
						<div key={group.key}>
							<button
								type="button"
								className="session-panel__group-toggle"
								aria-expanded={!isCollapsed}
								aria-controls={contentId}
								onClick={() =>
									setCollapsed((previous) =>
										previous.includes(group.key)
											? previous.filter((key) => key !== group.key)
											: [...previous, group.key],
									)
								}
							>
								{isCollapsed ? <RightOutlined /> : <DownOutlined />}
								<span className="session-panel__group-name" title={group.name}>
									{group.name}
								</span>
								{isCollapsed && hasRunning ? <Badge status="processing" /> : null}
								<span className="session-panel__section-count">{group.sessions.length}</span>
							</button>
							<div id={contentId} hidden={isCollapsed}>
								{group.sessions.map(row)}
							</div>
						</div>
					);
				})}
			</div>

			<ConfigProvider theme={consoleThemes[themeMode].main}>
				<Modal
					title={t("重命名会话")}
					open={renaming !== null}
					okText={t("保存")}
					cancelText={t("取消")}
					onCancel={() => setRenaming(null)}
					destroyOnHidden
					onOk={() => {
						if (!renaming) return;
						const name = renaming.name.trim();
						if (!name) return;
						onRename(renaming.path, name);
						setRenaming(null);
					}}
				>
					<Input
						autoFocus
						value={renaming?.name ?? ""}
						onChange={(event) => setRenaming((prev) => (prev ? { ...prev, name: event.target.value } : prev))}
						onPressEnter={() => {
							if (!renaming) return;
							const name = renaming.name.trim();
							if (!name) return;
							onRename(renaming.path, name);
							setRenaming(null);
						}}
					/>
				</Modal>
			</ConfigProvider>
		</aside>
	);
}
