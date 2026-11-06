import {
	CopyOutlined,
	DownOutlined,
	HistoryOutlined,
	PlusOutlined,
	SendOutlined,
	SettingOutlined,
	StopOutlined,
	UpOutlined,
} from "@ant-design/icons";
import {
	Alert,
	Button,
	Checkbox,
	Drawer,
	Empty,
	Input,
	InputNumber,
	Popover,
	Segmented,
	Select,
	Space,
	Spin,
	Switch,
	Tabs,
	Tag,
	Tooltip,
	Typography,
} from "antd";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MitmStatus } from "../../../src/mitm-types.ts";
import { webFuzzTarget } from "../../../src/webfuzz-target.ts";
import type { WebFuzzRequest, WebFuzzResult, WebFuzzState, WebFuzzTab } from "../../../src/webfuzz-types.ts";
import { getLanguage } from "../i18n.ts";
import { Page } from "../ui/Page.tsx";
import { editWebFuzzRaw } from "./webfuzz-editor.ts";
import "./WebFuzzPage.css";

const tx = (zh: string, en: string) => (getLanguage() === "en" ? en : zh);
type Workspace = Pick<WebFuzzState, "tabs" | "activeId">;
const saves = new Map<string, Promise<unknown>>();
// A project switch may revoke a queued save. Keep that draft until this project
// is opened again so the rejected save does not discard the last edit.
const unsaved = new Map<string, Workspace>();

async function api<T>(path: string, projectId: string, body?: object, signal?: AbortSignal): Promise<T> {
	const response = await fetch(
		`/api/mitm${path}${body ? "" : `?projectId=${encodeURIComponent(projectId)}`}`,
		body
			? {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...body, projectId }),
					signal,
				}
			: { signal },
	);
	const value = (await response.json()) as T & { error?: string };
	if (!response.ok) throw new Error(value.error ?? tx("请求失败", "Request failed"));
	return value;
}

function persist(projectId: string, workspace: Workspace): Promise<unknown> {
	unsaved.set(projectId, workspace);
	const task = (saves.get(projectId) ?? Promise.resolve())
		.catch(() => {})
		.then(() => api("/webfuzz/workspace", projectId, workspace));
	saves.set(projectId, task);
	void task
		.then(() => {
			if (unsaved.get(projectId) === workspace) unsaved.delete(projectId);
		})
		.catch(() => {});
	void task
		.finally(() => {
			if (saves.get(projectId) === task) saves.delete(projectId);
		})
		.catch(() => {});
	return task;
}

function newTab(input?: WebFuzzRequest): WebFuzzTab {
	return {
		raw: "GET / HTTP/1.1\r\nHost: \r\n\r\n",
		target: "http://",
		route: "project",
		timeoutMs: 30000,
		insecureTLS: false,
		fixContentLength: true,
		...input,
		id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(""),
		name: tx("未命名请求", "Untitled request"),
	};
}

function size(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function webFuzzResponseText(result: WebFuzzResult, mode: string, format: boolean): string {
	if (!result.response) return result.error ?? "";
	const response = result.response;
	if (mode === "raw") return response.rawText ?? response.rawBase64 ?? tx("此记录未保存原始响应，请重新发送后查看。", "No original response saved for this record. Send again to capture it.");
	const head = `${response.proto} ${response.status} ${response.reason}\r\n${response.headers.map((header) => `${header.name}: ${header.value}`).join("\r\n")}`;
	if (mode === "headers") return head;
	let body = response.bodyText ?? response.bodyBase64 ?? "";
	if (format && response.bodyText !== undefined && mode === "body") {
		try {
			body = JSON.stringify(JSON.parse(body), null, 2);
		} catch {
			/* Non-JSON stays as received. */
		}
	}
	return body;
}

/** Measure the browser's soft wraps so only logical lines receive a line number. */
export function WebFuzzRequestEditor({
	raw,
	disabled,
	onChange,
}: {
	raw: string;
	disabled: boolean;
	onChange: (raw: string) => void;
}) {
	const editor = useRef<HTMLTextAreaElement>(null);
	const mirror = useRef<HTMLDivElement>(null);
	const gutter = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const input = editor.current;
		const measure = mirror.current;
		const numbers = gutter.current;
		if (!input || !measure || !numbers) return;
		const update = () => {
			measure.style.width = `${input.clientWidth}px`;
			Array.from(measure.children).forEach((line, index) => {
				const number = numbers.children[index];
				if (number instanceof HTMLElement) number.style.height = `${line.getBoundingClientRect().height}px`;
			});
			numbers.scrollTop = input.scrollTop;
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(input);
		observer.observe(measure);
		return () => observer.disconnect();
	}, [raw]);
	const lines = raw.split(/\r?\n/);
	return (
		<div className="webfuzz-editor">
			<div className="webfuzz-editor__gutter" aria-hidden="true" ref={gutter}>
				{lines.map((_, index) => (
					<div key={index}>{index + 1}</div>
				))}
			</div>
			<div className="webfuzz-editor__mirror" aria-hidden="true" ref={mirror}>
				{lines.map((line, index) => (
					<div key={index}>{line || "\u200b"}</div>
				))}
			</div>
			<textarea
				ref={editor}
				aria-label={tx("原始 HTTP 请求", "Raw HTTP request")}
				value={raw}
				wrap="soft"
				spellCheck={false}
				autoCapitalize="off"
				autoCorrect="off"
				disabled={disabled}
				onChange={(event) => onChange(editWebFuzzRaw(raw, event.target.value))}
				onScroll={(event) => {
					if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
				}}
			/>
		</div>
	);
}

/** HTML stays inert, even when the target returns an executable document. */
export function WebFuzzResponse({ result }: { result: WebFuzzResult | null }) {
	const [mode, setMode] = useState("raw");
	const [format, setFormat] = useState(false);
	const [search, setSearch] = useState("");
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState("");
	const [matchIndex, setMatchIndex] = useState(0);
	const matchElement = useRef<HTMLElement>(null);
	const content = result ? webFuzzResponseText(result, mode, format) : "";
	const matches: number[] = [];
	if (search) {
		const text = content.toLowerCase();
		const needle = search.toLowerCase();
		for (let start = 0; start < text.length;) {
			const found = text.indexOf(needle, start);
			if (found < 0) break;
			matches.push(found);
			start = found + needle.length;
		}
	}
	const activeMatch = matches.length ? matchIndex % matches.length : 0;
	const offset = matches[activeMatch] ?? -1;
	useEffect(() => {
		const mark = matchElement.current;
		const panel = mark?.parentElement;
		if (mark && panel) panel.scrollTop += mark.getBoundingClientRect().top - panel.getBoundingClientRect().top - panel.clientHeight / 2;
	}, [offset, content]);
	return (
		<div className="webfuzz-response">
			<div className="webfuzz-panel__toolbar">
				<Segmented
					size="small"
					value={mode}
					onChange={setMode}
					options={[
						{ value: "raw", label: tx("报文", "Raw") },
						{ value: "body", label: tx("正文", "Body") },
						{ value: "headers", label: tx("响应头", "Headers") },
					]}
				/>
				<Space size={4}>
					{mode === "body" && result?.response?.bodyText !== undefined ? (
						<Button type="text" size="small" onClick={() => setFormat(!format)}>
							{format ? tx("原文", "Original") : tx("格式化 JSON", "Format JSON")}
						</Button>
					) : null}
					<Tooltip title={copied ? tx("已复制", "Copied") : tx("复制内容", "Copy content")}>
						<Button
							aria-label={tx("复制响应", "Copy response")}
							icon={<CopyOutlined />}
							type="text"
							size="small"
							disabled={!content}
							onClick={() => {
								setCopyError("");
								if (!navigator.clipboard) {
									setCopyError(tx("请手动选择内容复制。", "Select the text and copy manually."));
									return;
								}
								void navigator.clipboard
									.writeText(content)
									.then(() => setCopied(true))
									.catch(() =>
										setCopyError(
											tx("复制失败，请手动选择内容复制。", "Copy failed. Select the text and copy manually."),
										),
									);
							}}
						/>
					</Tooltip>
				</Space>
			</div>
			{result ? (
				<>
					<div className="webfuzz-search">
						<Input.Search
							size="small"
							value={search}
							allowClear
							placeholder={tx("查找响应内容", "Find in response")}
							aria-label={tx("查找响应", "Find response")}
							onChange={(event) => { setSearch(event.target.value); setMatchIndex(0); }}
							onPressEnter={(event) => setMatchIndex((index) => matches.length ? (index + (event.shiftKey ? matches.length - 1 : 1)) % matches.length : 0)}
						/>
						<span>{search ? (offset >= 0 ? `${activeMatch + 1}/${matches.length}` : tx("未找到", "Not found")) : ""}</span>
						<Button type="text" size="small" aria-label={tx("上一处匹配", "Previous match")} icon={<UpOutlined />} disabled={!matches.length} onClick={() => setMatchIndex((activeMatch + matches.length - 1) % matches.length)} />
						<Button type="text" size="small" aria-label={tx("下一处匹配", "Next match")} icon={<DownOutlined />} disabled={!matches.length} onClick={() => setMatchIndex((activeMatch + 1) % matches.length)} />
					</div>
					{copyError ? (
						<div className="webfuzz-notice" role="status">
							{copyError}
						</div>
					) : null}
					{(mode === "raw" ? result.response?.rawBase64 !== undefined : result.response?.bodyBase64 !== undefined && mode === "body") ? (
						<div className="webfuzz-notice">
							{tx("二进制 / 压缩内容，以 Base64 显示", "Binary / compressed content, shown as Base64")}
						</div>
					) : null}
					<pre className="webfuzz-response__content">
						{offset >= 0 ? (
							<>
								{content.slice(0, offset)}
								<mark ref={matchElement}>{content.slice(offset, offset + search.length)}</mark>
								{content.slice(offset + search.length)}
							</>
						) : (
							content || tx("响应内容为空", "Empty response")
						)}
					</pre>
				</>
			) : (
				<div className="webfuzz-response__empty">
					<SendOutlined />
					<span>{tx("发送请求后，在这里查看响应", "Send a request to inspect its response")}</span>
					<small>{tx("响应作为文本显示，页面脚本不会执行", "Responses are displayed as text")}</small>
				</div>
			)}
		</div>
	);
}

export function WebFuzzPage({
	project,
	initialFlowId,
	onImportConsumed,
}: {
	project: { id: string; name: string } | null;
	initialFlowId?: string;
	onImportConsumed?: () => void;
}) {
	const projectId = project?.id;
	const [flowId] = useState(initialFlowId);
	const consumed = useRef(onImportConsumed);
	consumed.current = onImportConsumed;
	const [workspace, setWorkspace] = useState<Workspace | null>(null);
	const [history, setHistory] = useState<WebFuzzResult[]>([]);
	const [results, setResults] = useState<Record<string, WebFuzzResult>>({});
	const [status, setStatus] = useState<MitmStatus | null>(null);
	const [error, setError] = useState("");
	const [saveError, setSaveError] = useState("");
	const [loadFailed, setLoadFailed] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [busyTab, setBusyTab] = useState<string | null>(null);
	const [password, setPassword] = useState("");
	const [loadVersion, setLoadVersion] = useState(0);
	const latest = useRef<Workspace | null>(null);
	const dirty = useRef(false);
	const alive = useRef(true);
	const pending = useRef<AbortController | null>(null);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			pending.current?.abort();
			if (projectId && latest.current && dirty.current) void persist(projectId, latest.current).catch(() => {});
		};
	}, [projectId]);
	useEffect(() => {
		if (!projectId) return;
		const controller = new AbortController();
		setLoadFailed(false);
		void (async () => {
			try {
				await saves.get(projectId)?.catch(() => {});
				const data = await api<WebFuzzState>("/webfuzz", projectId, undefined, controller.signal);
				if (controller.signal.aborted) return;
				const cached = unsaved.get(projectId);
				let tabs = cached?.tabs ?? data.tabs;
				let activeId = cached ? cached.activeId : data.activeId;
				if (cached) dirty.current = true;
				if (flowId) {
					try {
						if (tabs.length >= 20)
							throw new Error(
								tx(
									"标签已满，请先关闭一个标签再从 MITM 导入。",
									"Close a tab before importing from MITM (20 tab limit).",
								),
							);
						const request = await api<WebFuzzRequest>("/webfuzz/import", projectId, { flowId }, controller.signal);
						const tab = newTab(request);
						tab.name = tx("MITM 导入", "MITM import");
						tabs = [...tabs, tab];
						activeId = tab.id;
						dirty.current = true;
					} catch (cause) {
						if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
					}
					if (!controller.signal.aborted) consumed.current?.();
				}
				if (controller.signal.aborted) return;
				if (!tabs.length) {
					const tab = newTab();
					tabs = [tab];
					activeId = tab.id;
					dirty.current = true;
				}
				const next = { tabs, activeId: activeId ?? tabs[0].id };
				latest.current = next;
				setWorkspace(next);
				setHistory(data.history);
			} catch (cause) {
				if (!controller.signal.aborted) {
					setError(cause instanceof Error ? cause.message : String(cause));
					setLoadFailed(true);
				}
			}
		})();
		return () => controller.abort();
	}, [projectId, flowId, loadVersion]);
	useEffect(() => {
		if (!projectId || !workspace || !dirty.current) return;
		const timer = setTimeout(() => {
			dirty.current = false;
			void persist(projectId, workspace)
				.then(() => {
					if (alive.current) setSaveError("");
				})
				.catch((cause: unknown) => {
					dirty.current = true;
					if (alive.current) setSaveError(cause instanceof Error ? cause.message : String(cause));
				});
		}, 500);
		return () => clearTimeout(timer);
	}, [workspace, projectId]);
	const tab = workspace?.tabs.find((item) => item.id === workspace.activeId);
	useEffect(() => {
		if (!projectId || tab?.route !== "mitm") return;
		const controller = new AbortController();
		void api<MitmStatus>("", projectId, undefined, controller.signal)
			.then((value) => {
				if (!controller.signal.aborted) setStatus(value);
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => controller.abort();
	}, [projectId, tab?.route]);
	function change(next: Workspace) {
		latest.current = next;
		dirty.current = true;
		setWorkspace(next);
	}
	function edit(patch: Partial<WebFuzzTab>) {
		if (!workspace || !tab) return;
		const next = { ...tab, ...patch };
		const https = next.target.startsWith("https:");
		try {
			next.target = webFuzzTarget(next.raw, https);
		} catch {
			next.target = https ? "https://" : "http://";
		}
		change({ ...workspace, tabs: workspace.tabs.map((item) => (item.id === tab.id ? next : item)) });
	}
	function add(request?: WebFuzzRequest, result?: WebFuzzResult) {
		if (!workspace) return;
		if (workspace.tabs.length >= 20) {
			setError(tx("最多保留 20 个标签，请先关闭一个。", "Up to 20 tabs. Close one first."));
			return;
		}
		const next = newTab(request);
		change({ tabs: [...workspace.tabs, next], activeId: next.id });
		if (result) setResults((prev) => ({ ...prev, [next.id]: result }));
		setHistoryOpen(false);
	}
	async function send() {
		if (!projectId || !tab || busyTab) return;
		const current = tab;
		const controller = new AbortController();
		pending.current = controller;
		setBusyTab(current.id);
		setError("");
		try {
			const result = await api<WebFuzzResult>(
				"/webfuzz/send",
				projectId,
				{ request: current, ...(current.route === "mitm" ? { password } : {}) },
				controller.signal,
			);
			if (controller.signal.aborted) return;
			setResults((prev) => ({ ...prev, [current.id]: result }));
			setHistory((prev) => [result, ...prev.filter((item) => item.id !== result.id)].slice(0, 30));
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (alive.current) {
				setBusyTab(null);
				pending.current = null;
			}
		}
	}
	if (!project)
		return (
			<Page title="WebFuzz">
				<Empty description={tx("请先选择项目", "Select a project first")} />
			</Page>
		);
	const result = tab ? (results[tab.id] ?? null) : null;
	let resolvedTarget = "";
	if (tab) {
		try {
			resolvedTarget = webFuzzTarget(tab.raw, tab.target.startsWith("https:"));
		} catch {
			/* Incomplete draft. */
		}
	}
	return (
		<Page
			className="webfuzz-page"
			title="WebFuzz"
			extra={
				<>
					<Button icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)}>
						{tx("历史记录", "History")} <span className="webfuzz-count">{history.length}</span>
					</Button>
					<Button icon={<PlusOutlined />} disabled={!workspace || workspace.tabs.length >= 20} onClick={() => add()}>
						{tx("新建请求", "New request")}
					</Button>
				</>
			}
		>
			{error || saveError ? (
				<Alert
					type="error"
					showIcon
					title={error || tx(`草稿保存失败：${saveError}`, `Draft save failed: ${saveError}`)}
					closable
					onClose={() => {
						setError("");
						setSaveError("");
					}}
				/>
			) : null}
			{!workspace || !tab ? (
				<div className="webfuzz-loading">
					{loadFailed ? (
						<Button
							onClick={() => {
								setError("");
								setLoadVersion((value) => value + 1);
							}}
						>
							{tx("重新加载", "Retry")}
						</Button>
					) : (
						<Spin />
					)}
				</div>
			) : (
				<div className="webfuzz-workspace">
					<Tabs
						className="webfuzz-tabs"
						type="editable-card"
						hideAdd
						activeKey={tab.id}
						onChange={(activeId) => change({ ...workspace, activeId })}
						onEdit={(key, action) => {
							if (action !== "remove" || typeof key !== "string" || key === busyTab) return;
							let tabs = workspace.tabs.filter((item) => item.id !== key);
							if (!tabs.length) tabs = [newTab()];
							const index = workspace.tabs.findIndex((item) => item.id === key);
							change({
								tabs,
								activeId:
									workspace.activeId === key ? (tabs[Math.max(0, index - 1)]?.id ?? tabs[0].id) : workspace.activeId,
							});
							setResults((prev) => {
								const next = { ...prev };
								delete next[key];
								return next;
							});
						}}
						items={workspace.tabs.map((item, index) => ({
							key: item.id,
							label: (
								<span
									title={item.target}
									onFocus={(event) => event.stopPropagation()}
									onMouseDown={(event) => event.stopPropagation()}
									onMouseUp={(event) => event.stopPropagation()}
									onClick={(event) => {
										// Tabs otherwise steals focus back from the inline editor.
										event.stopPropagation();
										if (workspace.activeId !== item.id) change({ ...workspace, activeId: item.id });
									}}
									onKeyDown={(event) => {
										if (event.target instanceof HTMLTextAreaElement) event.stopPropagation();
									}}
								>
									<span className="webfuzz-tab-number">{String(index + 1).padStart(2, "0")}</span>
									<Typography.Text
										className="webfuzz-tab-title"
										aria-label={tx("修改请求标题", "Rename request")}
										editable={{
											triggerType: ["text", "icon"],
											tooltip: tx("点击修改标题", "Click to rename"),
											maxLength: 80,
											autoSize: { minRows: 1, maxRows: 1 },
											enterIcon: null,
											onChange: (value) => {
												const name = value.trim();
												if (name) change({ ...workspace, tabs: workspace.tabs.map((entry) => entry.id === item.id ? { ...entry, name } : entry) });
											},
										}}
									>
										{item.name}
									</Typography.Text>
								</span>
							),
							closable: item.id !== busyTab,
						}))}
					/>
					<div className="webfuzz-addressbar">
						<Checkbox
							checked={tab.target.startsWith("https:")}
							onChange={(event) => edit({ target: event.target.checked ? "https://" : "http://" })}
							disabled={busyTab === tab.id}
						>
							HTTPS
						</Checkbox>
						<span className="webfuzz-target" title={resolvedTarget}>
							{resolvedTarget || tx("在请求头中填写 Host", "Enter Host in the request headers")}
						</span>
						<Select
							aria-label={tx("网络出口", "Network route")}
							value={tab.route}
							disabled={busyTab === tab.id}
							onChange={(route) => edit({ route })}
							options={[
								{ value: "project", label: tx("项目代理", "Project network") },
								{ value: "direct", label: tx("直连", "Direct") },
								{ value: "mitm", label: tx("MITM 留痕", "Via MITM") },
							]}
						/>
						<Popover
							trigger="click"
							placement="bottom"
							title={tx("发送选项", "Send options")}
							content={
								<div className="webfuzz-options">
									<label>
										<span>{tx("超时（秒）", "Timeout (s)")}</span>
										<InputNumber
											aria-label={tx("超时秒数", "Timeout seconds")}
											value={tab.timeoutMs / 1000}
											min={1}
											max={120}
											precision={0}
											onChange={(value) => edit({ timeoutMs: (value ?? 30) * 1000 })}
										/>
									</label>
									<label>
										<span>{tx("自动更新 Content-Length", "Update Content-Length")}</span>
										<Switch
											size="small"
											checked={tab.fixContentLength}
											onChange={(fixContentLength) => edit({ fixContentLength })}
										/>
									</label>
									<label>
										<span>{tx("忽略 TLS 证书错误", "Ignore TLS certificate errors")}</span>
										<Switch size="small" checked={tab.insecureTLS} onChange={(insecureTLS) => edit({ insecureTLS })} />
									</label>
								</div>
							}
						>
							<Button
								icon={<SettingOutlined />}
								aria-label={tx("发送选项", "Send options")}
								disabled={busyTab === tab.id}
							/>
						</Popover>
						{busyTab ? (
							<Button icon={<StopOutlined />} onClick={() => pending.current?.abort()}>
								{tx("取消发送", "Cancel")}
							</Button>
						) : (
							<Button
								type="primary"
								icon={<SendOutlined />}
								onClick={() => void send()}
								disabled={!resolvedTarget || !tab.raw.trim()}
							>
								{tx("发送请求", "Send")}
							</Button>
						)}
					</div>
					{tab.route === "mitm" ? (
						<div className="webfuzz-route-note">
							<span>
								{status?.state === "running"
									? tx(
											"经当前项目 MITM 代理发送，按抓包规则记录。",
											"Sent via this project's MITM proxy, subject to capture filters.",
										)
									: tx("请先在 MITM 中心启动当前项目的代理。", "Start this project's proxy in MITM Center first.")}
							</span>
							{status?.config.authEnabled ? (
								<Input.Password
									aria-label={tx("MITM 代理密码", "MITM proxy password")}
									autoComplete="off"
									placeholder={tx("代理密码（不保存）", "Proxy password (not saved)")}
									value={password}
									maxLength={128}
									onChange={(event) => setPassword(event.target.value)}
								/>
							) : null}
						</div>
					) : null}
					<div className="webfuzz-editors">
						<section className="webfuzz-panel">
							<div className="webfuzz-panel__head">
								<span>
									<b>{tx("请求", "Request")}</b>
									<span className="webfuzz-panel__meta">HTTP/1.1</span>
								</span>
								<Button
									type="text"
									size="small"
									icon={<CopyOutlined />}
									onClick={() => add(tab)}
									disabled={workspace.tabs.length >= 20}
								>
									{tx("复制标签", "Duplicate")}
								</Button>
							</div>
							<div className="webfuzz-panel__toolbar">
								<Input
									variant="borderless"
									aria-label={tx("请求名称", "Request name")}
									value={tab.name}
									maxLength={80}
									onChange={(event) => edit({ name: event.target.value })}
								/>
								<span className="webfuzz-panel__meta">{size(new TextEncoder().encode(tab.raw).length)}</span>
							</div>
							<WebFuzzRequestEditor
								key={tab.id}
								raw={tab.raw}
								disabled={busyTab === tab.id}
								onChange={(raw) => edit({ raw })}
							/>
							<div className="webfuzz-panel__foot">
								{tx(
									"目标取自 Host；勾选 HTTPS 启用 TLS。长行自动折行。",
									"Target follows Host; HTTPS enables TLS. Long lines wrap automatically.",
								)}
							</div>
						</section>
						<section className="webfuzz-panel">
							<div className="webfuzz-panel__head">
								<b>{tx("响应", "Response")}</b>
								<Space size={10}>
									{busyTab === tab.id ? <Spin size="small" /> : null}
									{result?.response ? (
										<>
											<Tag color={result.error || result.response.truncated || result.response.status >= 400 ? "warning" : "success"}>
												{result.response.status} {result.response.reason}
											</Tag>
											<span className="webfuzz-panel__meta">
												{Math.round(result.timings.totalMs)} ms · {size(result.response.size)}
											</span>
										</>
									) : null}
								</Space>
							</div>
							<WebFuzzResponse key={result?.id ?? tab.id} result={result} />
							<div className="webfuzz-panel__foot">
								{result
									? tx(
											`连接 ${Math.round(result.timings.connectMs)} ms · TLS ${Math.round(result.timings.tlsMs)} ms · 首字节 ${Math.round(result.timings.ttfbMs)} ms`,
											`Connect ${Math.round(result.timings.connectMs)} ms · TLS ${Math.round(result.timings.tlsMs)} ms · TTFB ${Math.round(result.timings.ttfbMs)} ms`,
										)
									: tx("不自动跟随重定向，不自动重试", "No automatic redirects or retries")}
							</div>
						</section>
					</div>
					{result?.error || result?.warnings.length ? (
						<div className="webfuzz-notice" role="status">
							{[result.error, ...result.warnings].filter(Boolean).join(" ")}
						</div>
					) : null}
				</div>
			)}
			<Drawer
				title={tx("发送历史", "Send history")}
				open={historyOpen}
				onClose={() => setHistoryOpen(false)}
				size={440}
			>
				<Typography.Paragraph type="secondary">
					{tx(
						"当前项目最近 30 次发送。点击恢复到新标签，不会自动发送。",
						"Last 30 sends in this project. Restore to a new tab without sending.",
					)}
				</Typography.Paragraph>
				{history.length ? (
					<div className="webfuzz-history">
						{history.map((item) => (
							<button key={item.id} type="button" onClick={() => add(item.request, item)}>
								<span>
									<b>{item.request.raw.split(/\s/)[0]}</b>
									<Tag color={item.error ? "error" : undefined}>{item.response?.status ?? tx("失败", "Failed")}</Tag>
								</span>
								<strong>{item.request.target}</strong>
								<code>{item.request.raw.split(/\r?\n/)[0]}</code>
								<small>
									{new Date(item.at).toLocaleString()} · {Math.round(item.timings.totalMs)} ms ·{" "}
									{item.request.route === "project"
										? tx("项目代理", "Project")
										: item.request.route === "direct"
											? tx("直连", "Direct")
											: "MITM"}
								</small>
							</button>
						))}
					</div>
				) : (
					<Empty description={tx("暂无发送记录", "No send history")} />
				)}
			</Drawer>
		</Page>
	);
}
