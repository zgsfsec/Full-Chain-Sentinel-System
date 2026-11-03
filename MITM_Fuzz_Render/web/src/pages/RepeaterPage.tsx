import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import EmptyState from "../components/EmptyState";
import { ApiError } from "../lib/api";
import EvidencePanel from "../components/EvidencePanel";
import { HighlightLayer, HighlightToolbar, type SelectionAnchor } from "../components/Highlights";
import {
  addHighlight,
  emptyHighlights,
  highlightRects,
  markColor,
  measureEditor,
  offsetsFromRange,
  overlaps,
  parseHighlights,
  removeOverlapping,
  saveHighlights,
  segmentText,
  type EditorMetrics,
  type HighlightColor,
  type Highlights,
} from "../lib/highlights";
import { listScripts, type ScriptItem } from "../lib/scripts";
import {
  createTab,
  deleteTab,
  listTabs,
  sendReplay,
  updateTab,
  type ReplayResult,
  type ReplayTab,
} from "../lib/replay";

const SAMPLE_REQUEST = [
  "GET / HTTP/1.1",
  "Host: example.com",
  "User-Agent: replayd/0.1.0",
  "Accept: */*",
  "",
  "",
].join("\r\n");

const TARGET_STORAGE_KEY = "replayd.repeater.target";
const DEBOUNCE_MS = 500;

type ResponseView = "pretty" | "raw" | "hex";

const RESPONSE_VIEWS: { key: ResponseView; label: string }[] = [
  { key: "pretty", label: "Pretty" },
  { key: "raw", label: "Raw" },
  { key: "hex", label: "Hex" },
];

/** 响应体的原始字节（用于 Hex 视图）。 */
function responseBytes(response: NonNullable<ReplayResult["response"]>): Uint8Array {
  const raw =
    response.bodyBase64 !== null && response.bodyText === null
      ? atob(response.bodyBase64)
      : (response.bodyText ?? "");
  return new TextEncoder().encode(raw);
}

/** 按当前视图渲染响应体，并给出必要提示。 */
function responseBodyView(
  response: NonNullable<ReplayResult["response"]>,
  view: ResponseView,
): { text: string; hint: string } {
  if (view === "hex") {
    return { text: hexDump(responseBytes(response)), hint: "" };
  }
  if (view === "raw") {
    return { text: response.bodyText ?? "", hint: "" };
  }
  const pretty = prettyBody(response);
  return {
    text: pretty.text,
    hint: pretty.binary ? "二进制响应：切到 Hex 视图查看原始字节" : "",
  };
}

function statusColor(status: number): string {
  if (status >= 500) return "text-danger";
  if (status >= 400) return "text-yellow-400";
  if (status >= 300) return "text-blue-400";
  if (status >= 200) return "text-accent";
  return "text-muted";
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function readStoredTarget(): { scheme: "http" | "https"; host: string } {
  try {
    const stored = localStorage.getItem(TARGET_STORAGE_KEY);
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      if (typeof parsed === "object" && parsed !== null) {
        const source = parsed as { scheme?: unknown; host?: unknown };
        return {
          scheme: source.scheme === "https" ? "https" : "http",
          host: typeof source.host === "string" ? source.host : "",
        };
      }
    }
  } catch {
    // 忽略损坏的本地存储内容
  }
  return { scheme: "https", host: "example.com" };
}

/** 解析 `example.com` / `example.com:8443` 形式的目标；端口非法时返回 null。 */
function parseHost(hostInput: string): { host: string; port: number | null } | null {
  const trimmed = hostInput.trim();
  if (trimmed === "") return null;
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > 0) {
    const host = trimmed.slice(0, lastColon).trim();
    const portText = trimmed.slice(lastColon + 1).trim();
    if (portText === "") return { host, port: null };
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  }
  return { host: trimmed, port: null };
}

function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.subarray(offset, offset + 16);
    const hexParts: string[] = [];
    const asciiParts: string[] = [];
    for (const byte of chunk) {
      hexParts.push(byte.toString(16).padStart(2, "0"));
      asciiParts.push(byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".");
    }
    while (hexParts.length < 16) {
      hexParts.push("  ");
      if (hexParts.length === 8) hexParts.push(" ");
    }
    lines.push(
      `${offset.toString(16).padStart(8, "0")}  ${hexParts.join(" ")}  |${asciiParts.join("")}|`,
    );
  }
  return lines.join("\n");
}

function prettyBody(
  response: NonNullable<ReplayResult["response"]>,
): { text: string; binary: boolean } {
  if (response.bodyBase64 !== null && response.bodyText === null) {
    return { text: "二进制响应，请切换 Hex 视图", binary: true };
  }
  const body = response.bodyText ?? "";
  const contentType =
    response.headers
      .find((header) => header.name.toLowerCase() === "content-type")
      ?.value.toLowerCase() ?? "";
  if (contentType.includes("json")) {
    try {
      return { text: JSON.stringify(JSON.parse(body) as unknown, null, 2), binary: false };
    } catch {
      return { text: body, binary: false };
    }
  }
  return { text: body, binary: false };
}

/** 请求重放：多 tab 编辑 + 发送 + 响应四视图。 */
export default function RepeaterPage() {
  const [tabs, setTabs] = useState<ReplayTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tabSaving, setTabSaving] = useState(false);
  const [target, setTarget] = useState(readStoredTarget);
  // 上游代理不落盘：它可能带凭据，而且是"这一次发送"的设置。
  const [upstreamProxy, setUpstreamProxy] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [view, setView] = useState<ResponseView>("pretty");
  const [scripts, setScripts] = useState<ScriptItem[]>([]);
  const [highlights, setHighlights] = useState<Highlights>(emptyHighlights);
  const [pending, setPending] = useState<SelectionAnchor | null>(null);
  const [metrics, setMetrics] = useState<EditorMetrics | null>(null);
  const [editorScroll, setEditorScroll] = useState({ top: 0, left: 0 });
  const [highlightNotice, setHighlightNotice] = useState("");
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const responseRef = useRef<HTMLPreElement | null>(null);
  const [evidenceVisible, setEvidenceVisible] = useState(() => {
    try {
      return window.localStorage.getItem("replayd.evidenceVisible") !== "0";
    } catch {
      return true;
    }
  });

  const tabsRef = useRef<ReplayTab[]>([]);
  tabsRef.current = tabs;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const patchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeId) ?? null,
    [tabs, activeId],
  );

  const persistTab = useCallback(async (tab: ReplayTab) => {
    setTabSaving(true);
    try {
      await updateTab(tab.id, { name: tab.name, rawRequest: tab.rawRequest });
    } catch {
      // 保存失败不打断编辑；下次变更会再次尝试
    } finally {
      setTabSaving(false);
    }
  }, []);

  const ensureTabs = useCallback(async () => {
    setLoadError(null);
    try {
      const items = await listTabs();
      if (items.length > 0) {
        setTabs(items);
        // 支持 /repeater?tab=<id>（"发送到 Repeater" 会带此参数）
        const requested = new URLSearchParams(window.location.search).get("tab");
        const target = items.find((tab) => tab.id === requested) ?? items[0];
        setActiveId(target?.id ?? null);
        return;
      }
      const created = await createTab("标签 1", SAMPLE_REQUEST);
      setTabs([created]);
      setActiveId(created.id);
    } catch (error) {
      setLoadError(
        error instanceof ApiError
          ? `加载标签失败：${error.message}`
          : "加载标签失败：未知错误",
      );
    }
  }, []);

  useEffect(() => {
    void ensureTabs();
  }, [ensureTabs]);

  // 脚本列表（供每个 tab 选择挂钩脚本）
  useEffect(() => {
    void listScripts()
      .then(setScripts)
      .catch(() => setScripts([]));
  }, []);

  // 内容变化 500ms 防抖 PATCH
  useEffect(() => {
    if (activeTab === null) return;
    if (patchTimer.current !== null) {
      clearTimeout(patchTimer.current);
    }
    patchTimer.current = setTimeout(() => {
      void persistTab(activeTab);
    }, DEBOUNCE_MS);
    return () => {
      if (patchTimer.current !== null) {
        clearTimeout(patchTimer.current);
      }
    };
  }, [activeTab, persistTab]);

  const switchTab = useCallback(
    (id: string) => {
      if (id === activeId) return;
      const current = tabsRef.current.find((tab) => tab.id === activeId);
      if (current !== undefined) {
        void persistTab(current);
      }
      setActiveId(id);
      setResult(null);
      setSendError(null);
      setView("pretty");
    },
    [activeId, persistTab],
  );

  const addTab = useCallback(async () => {
    const existing = tabsRef.current;
    try {
      const created = await createTab(`标签 ${existing.length + 1}`, SAMPLE_REQUEST);
      const current = existing.find((tab) => tab.id === activeIdRef.current);
      if (current !== undefined) {
        void persistTab(current);
      }
      setTabs((prev) => [...prev, created]);
      setActiveId(created.id);
      setResult(null);
      setSendError(null);
    } catch (error) {
      setSendError(error instanceof ApiError ? `新建标签失败：${error.message}` : "新建标签失败");
    }
  }, [persistTab]);

  const closeTab = useCallback(
    async (id: string) => {
      const remaining = tabsRef.current.filter((tab) => tab.id !== id);
      if (remaining.length === 0) return; // 至少保留一个 tab
      try {
        await deleteTab(id);
      } catch (error) {
        setSendError(
          error instanceof ApiError ? `关闭标签失败：${error.message}` : "关闭标签失败",
        );
        return;
      }
      setTabs(remaining);
      if (id === activeIdRef.current) {
        setActiveId(remaining[0]?.id ?? null);
        setResult(null);
        setSendError(null);
      }
    },
    [],
  );

  const updateActiveRaw = useCallback((raw: string) => {
    const id = activeIdRef.current;
    if (id === null) return;
    setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, rawRequest: raw } : tab)));
  }, []);

  useEffect(() => {
    localStorage.setItem(TARGET_STORAGE_KEY, JSON.stringify(target));
  }, [target]);

  const send = useCallback(async () => {
    const tab = tabsRef.current.find((item) => item.id === activeIdRef.current);
    if (tab === undefined) return;
    setSending(true);
    setSendError(null);
    try {
      const parsed = parseHost(target.host);
      if (parsed === null) {
        setSendError("目标主机格式无效：应为 example.com 或 example.com:8443");
        return;
      }
      // origin-form（请求行以 / 开头）才需要 target；absolute-form 由请求行自带的 URL 决定
      const requestLine = tab.rawRequest.split("\r\n", 1)[0]?.split("\n", 1)[0] ?? "";
      const isOriginForm = /^\s*[A-Z]+\s+\//.test(requestLine);
      const defaultPort = target.scheme === "https" ? 443 : 80;
      const port = parsed.port ?? defaultPort;
      const targetValue =
        isOriginForm && parsed.host !== ""
          ? { scheme: target.scheme, host: parsed.host, port }
          : null;
      const proxy = upstreamProxy.trim();
      const response = await sendReplay(tab.rawRequest, {
        target: targetValue,
        ...(tab.scriptId === "" ? {} : { scriptId: tab.scriptId }),
        ...(proxy === "" ? {} : { upstreamProxy: proxy }),
      });
      setResult(response);
    } catch (error) {
      setSendError(
        error instanceof ApiError ? `发送失败：${error.message}` : "发送失败：未知错误",
      );
    } finally {
      setSending(false);
    }
  }, [target, upstreamProxy]);

  // Ctrl/Cmd+Enter 发送
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void send();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [send]);

  const response = result?.response ?? null;
  const error = result?.error ?? null;
  const warnings = result?.request?.warnings ?? [];
  const showEmpty = !sending && result === null && sendError === null;
  // 响应体按当前视图渲染（响应头固定显示在它上方）
  const bodyView =
    response === null ? { text: "", hint: "" } : responseBodyView(response, view);

  useEffect(() => {
    try {
      window.localStorage.setItem("replayd.evidenceVisible", evidenceVisible ? "1" : "0");
    } catch {
      // 隐私模式忽略
    }
  }, [evidenceVisible]);

  // ---- 高亮：随活动标签页切换而载入（服务端保存）----
  useEffect(() => {
    setHighlights(parseHighlights(activeTab?.highlights));
    setPending(null);
  }, [activeTab?.id, activeTab?.highlights]);

  // 等宽字体的字符宽度/行高：用来把偏移换算成色块矩形
  useEffect(() => {
    const el = editorRef.current;
    if (el === null) return;
    const update = () => setMetrics(measureEditor(el));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [activeTab?.id]);

  const persistHighlights = useCallback(async (next: Highlights) => {
    setHighlights(next);
    const id = activeIdRef.current;
    if (id === null) return;
    try {
      await saveHighlights(id, next);
      setHighlightNotice("");
      setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, highlights: next } : tab)));
    } catch {
      setHighlightNotice("高亮保存失败：请检查后端连接");
    }
  }, []);

  /** 请求编辑器里的选区 → 工具条锚点（等宽字体直接算矩形）。 */
  const requestAnchor = useCallback((): SelectionAnchor | null => {
    const el = editorRef.current;
    if (el === null || metrics === null) return null;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (end <= start) return null;
    const rects = highlightRects(el.value, [{ start, end, color: "yellow" }], metrics);
    const first = rects[0];
    if (first === undefined) return null;
    const box = el.getBoundingClientRect();
    return {
      target: "request",
      start,
      end,
      rect: {
        x: box.left + first.x - el.scrollLeft,
        y: box.top + first.y - el.scrollTop,
        width: Math.max(first.width, 12),
        height: first.height,
      },
      existing: overlaps(highlights.request, start, end),
    };
  }, [metrics, highlights.request]);

  /** 响应区（pre）里的选区 → 工具条锚点。 */
  const responseAnchor = useCallback((): SelectionAnchor | null => {
    const el = responseRef.current;
    const selection = window.getSelection();
    if (el === null || selection === null || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (range.collapsed || !el.contains(range.commonAncestorContainer)) return null;
    const offsets = offsetsFromRange(el, range);
    if (offsets === null) return null;
    const box = range.getBoundingClientRect();
    const list = highlights.response[view] ?? [];
    return {
      target: "response",
      start: offsets.start,
      end: offsets.end,
      rect: { x: box.left, y: box.top, width: box.width, height: box.height },
      existing: overlaps(list, offsets.start, offsets.end),
    };
  }, [highlights.response, view]);

  const onRequestSelect = useCallback(() => setPending(requestAnchor()), [requestAnchor]);
  const onResponseSelect = useCallback(() => setPending(responseAnchor()), [responseAnchor]);

  const applyHighlight = useCallback(
    (color: HighlightColor) => {
      if (pending === null) return;
      const next: Highlights =
        pending.target === "request"
          ? { ...highlights, request: addHighlight(highlights.request, pending.start, pending.end, color) }
          : {
              ...highlights,
              response: {
                ...highlights.response,
                [view]: addHighlight(highlights.response[view] ?? [], pending.start, pending.end, color),
              },
            };
      void persistHighlights(next);
      setPending(null);
      window.getSelection()?.removeAllRanges();
    },
    [pending, highlights, view, persistHighlights],
  );

  const clearSelectionHighlight = useCallback(() => {
    if (pending === null) return;
    const next: Highlights =
      pending.target === "request"
        ? { ...highlights, request: removeOverlapping(highlights.request, pending.start, pending.end) }
        : {
            ...highlights,
            response: {
              ...highlights.response,
              [view]: removeOverlapping(highlights.response[view] ?? [], pending.start, pending.end),
            },
          };
    void persistHighlights(next);
    setPending(null);
  }, [pending, highlights, view, persistHighlights]);

  const clearAllHighlights = useCallback(
    (target: "request" | "response") => {
      if (target === "request") {
        void persistHighlights({ ...highlights, request: [] });
        return;
      }
      const rest = { ...highlights.response };
      delete rest[view];
      void persistHighlights({ ...highlights, response: rest });
    },
    [highlights, view, persistHighlights],
  );

  const copySelection = useCallback(() => {
    if (pending === null) return;
    const source = pending.target === "request" ? (activeTab?.rawRequest ?? "") : bodyView.text;
    void navigator.clipboard.writeText(source.slice(pending.start, pending.end));
  }, [pending, activeTab, bodyView.text]);

  const requestRects = useMemo(
    () => (metrics === null ? [] : highlightRects(activeTab?.rawRequest ?? "", highlights.request, metrics)),
    [metrics, activeTab?.rawRequest, highlights.request],
  );
  const responseSegments = useMemo(
    () => segmentText(bodyView.text, highlights.response[view] ?? []),
    [bodyView.text, highlights.response, view],
  );
  const requestHighlightCount = highlights.request.length;
  const responseHighlightCount = (highlights.response[view] ?? []).length;

  return (
    <section data-testid="page-repeater" className="flex h-full min-h-0 flex-col">
      {/* Tab 栏 */}
      <div
        role="tablist"
        aria-label="请求标签"
        data-testid="repeater-tabs"
        className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-panel/60 px-3"
      >
        {loadError !== null ? (
          <span role="alert" data-testid="repeater-tabs-error" className="text-[12px] text-danger">
            {loadError}
            <button
              type="button"
              className="btn ml-2"
              onClick={() => void ensureTabs()}
            >
              重试
            </button>
          </span>
        ) : null}
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeId}
            data-testid="repeater-tab"
            tabIndex={0}
            onClick={() => switchTab(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                switchTab(tab.id);
              }
            }}
            className={`flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[12px] ${
              tab.id === activeId
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-line bg-bg text-muted hover:text-ink"
            }`}
          >
            <span className="max-w-[140px] truncate font-medium">{tab.name}</span>
            {tabs.length > 1 ? (
              <button
                type="button"
                data-testid="repeater-tab-close"
                aria-label={`关闭 ${tab.name}`}
                className="ml-0.5 rounded px-0.5 text-muted/60 hover:text-danger"
                onClick={(event) => {
                  event.stopPropagation();
                  void closeTab(tab.id);
                }}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          data-testid="repeater-tab-add"
          className="btn ml-1"
          onClick={() => void addTab()}
          title="新建标签"
        >
          + 新建
        </button>
      </div>

      {/* 目标栏 */}
      <div
        role="group"
        aria-label="重放目标"
        data-testid="repeater-target"
        className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel/30 px-3"
      >
        <label htmlFor="repeater-scheme" className="sr-only">
          协议
        </label>
        <select
          id="repeater-scheme"
          data-testid="repeater-scheme"
          className="field w-[84px] font-mono"
          value={target.scheme}
          onChange={(event) =>
            setTarget((prev) => ({
              ...prev,
              scheme: event.target.value === "https" ? "https" : "http",
            }))
          }
        >
          <option value="http">http</option>
          <option value="https">https</option>
        </select>
        <label htmlFor="repeater-host" className="sr-only">
          目标主机
        </label>
        <input
          id="repeater-host"
          data-testid="repeater-host"
          type="text"
          className="field w-[260px] font-mono"
          placeholder="example.com:8443（仅 origin-form 请求生效）"
          value={target.host}
          onChange={(event) => setTarget((prev) => ({ ...prev, host: event.target.value }))}
        />
        <label htmlFor="repeater-upstream-proxy" className="sr-only">
          上游代理
        </label>
        <input
          id="repeater-upstream-proxy"
          data-testid="repeater-upstream-proxy"
          type="text"
          className="field w-[220px] font-mono"
          placeholder="socks5://127.0.0.1:1080"
          title="这次发送走这个 SOCKS5 出口（可带 user:password）；只影响本次发送，不是系统代理"
          value={upstreamProxy}
          onChange={(event) => setUpstreamProxy(event.target.value)}
        />
        <span className="font-mono text-[10px] text-muted/50">
          请求行为 absolute-form（GET http://…）时以请求行中的目标为准
        </span>
        <button
          type="button"
          data-testid="evidence-toggle"
          className="btn ml-auto h-6 px-2 text-[11px]"
          aria-pressed={evidenceVisible}
          onClick={() => setEvidenceVisible((v) => !v)}
          title="并排显示第三方时间源，作为攻防演练的时间证据"
        >
          {evidenceVisible ? "取证面板 ✓" : "取证面板"}
        </button>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1">
        {/* 请求编辑区 */}
        <section
          aria-label="请求"
          data-testid="repeater-request"
          className="flex min-w-[260px] flex-1 flex-col border-r border-line"
        >
          <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
            <h2 className="text-[12px] font-medium text-ink">请求</h2>
            <label htmlFor="repeater-script" className="sr-only">
              挂钩脚本
            </label>
            <select
              id="repeater-script"
              data-testid="repeater-script"
              className="field h-6 max-w-[200px] text-[11px]"
              value={activeTab?.scriptId ?? ""}
              onChange={(event) => {
                const id = activeIdRef.current;
                const scriptId = event.target.value;
                if (id === null) return;
                setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, scriptId } : tab)));
                void updateTab(id, { scriptId }).catch(() => {
                  // 保存失败静默：下次编辑会再次 PATCH
                });
              }}
            >
              <option value="">不挂脚本</option>
              {scripts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.enabled ? "" : "（停用）"}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="request-highlight-clear"
              className="btn ml-auto h-6 px-2 text-[11px]"
              disabled={requestHighlightCount === 0}
              title="清除请求包上的全部高亮"
              onClick={() => clearAllHighlights("request")}
            >
              高亮 {requestHighlightCount}
            </button>
            <span className="badge">{tabSaving ? "保存中…" : "RAW · 自动保存"}</span>
          </header>
          <div className="relative flex min-h-0 flex-1 flex-col bg-bg">
            <HighlightLayer
              rects={requestRects}
              scrollTop={editorScroll.top}
              scrollLeft={editorScroll.left}
            />
            <textarea
              ref={editorRef}
              data-testid="repeater-request-editor"
              aria-label="原始请求编辑器"
              spellCheck={false}
              wrap="soft"
              disabled={activeTab === null}
              value={activeTab?.rawRequest ?? ""}
              onChange={(event) => updateActiveRaw(event.target.value)}
              onSelect={onRequestSelect}
              onMouseUp={onRequestSelect}
              onKeyUp={onRequestSelect}
              onScroll={(event) =>
                setEditorScroll({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft })
              }
              className="relative min-h-0 flex-1 resize-none overflow-x-hidden bg-transparent px-3 py-3 font-mono text-[12px] leading-6 break-all text-ink outline-none placeholder:text-muted/40"
              placeholder={"GET / HTTP/1.1\nHost: example.com\n\n"}
            />
          </div>
        </section>

        {/* 响应区 */}
        <section
          aria-label="响应"
          data-testid="repeater-response"
          className={`flex min-w-[260px] flex-1 flex-col ${
            evidenceVisible ? "border-r border-line" : ""
          }`}
        >
          <header className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-panel px-3">
            <h2 className="text-[12px] font-medium text-ink">响应</h2>
            <div className="flex items-center gap-1">
              {RESPONSE_VIEWS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  data-testid={`response-view-${item.key}`}
                  className={`h-6 rounded px-2 font-mono text-[11px] ${
                    view === item.key ? "bg-accent/10 text-accent" : "text-muted hover:text-ink"
                  }`}
                  onClick={() => setView(item.key)}
                >
                  {item.label}
                </button>
              ))}
              <button
                type="button"
                data-testid="response-highlight-clear"
                className="btn ml-1 h-6 px-2 text-[11px]"
                disabled={responseHighlightCount === 0}
                title="清除当前视图响应体上的全部高亮"
                onClick={() => clearAllHighlights("response")}
              >
                高亮 {responseHighlightCount}
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-auto">
            {sendError !== null ? (
              <div
                role="alert"
                data-testid="repeater-send-error"
                className="m-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger"
              >
                {sendError}
              </div>
            ) : null}

            {sending ? (
              <div
                data-testid="repeater-response-loading"
                className="p-5 font-mono text-[12px] text-muted"
              >
                发送中…
              </div>
            ) : null}

            {error !== null ? (
              <div
                role="alert"
                data-testid="repeater-error"
                className="m-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2"
              >
                <p className="font-mono text-[11px] font-medium text-danger">{error.code}</p>
                <p className="mt-1 text-[12px] text-ink">{error.message}</p>
                {error.detail !== null && error.detail !== "" ? (
                  <p className="mt-1 font-mono text-[10px] text-muted">{error.detail}</p>
                ) : null}
              </div>
            ) : null}

            {result?.script !== undefined && result.script !== null ? (
              <div
                data-testid="repeater-script-result"
                className="mx-3 mt-3 rounded-md border border-line bg-panel/40 px-3 py-2"
              >
                <p className="font-mono text-[10px] text-muted">
                  脚本 · {result.script.hooksRun.join(",") || "未执行"} ·{" "}
                  {result.script.durationMs} ms · {result.script.logs.length} 条日志
                </p>
                {result.script.error !== undefined && result.script.error !== "" ? (
                  <p data-testid="repeater-script-error" className="mt-1 text-[11px] text-danger">
                    {result.script.error}
                  </p>
                ) : null}
                {result.script.assert !== undefined ? (
                  <p
                    data-testid="repeater-script-assert"
                    className={`mt-1 text-[11px] ${
                      result.script.assert.ok ? "text-accent" : "text-danger"
                    }`}
                  >
                    {result.script.assert.ok
                      ? `断言通过${result.script.assert.message === "" ? "" : `：${result.script.assert.message}`}`
                      : `断言失败：${result.script.assert.message}`}
                  </p>
                ) : null}
                {result.script.logs.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-muted">
                    {result.script.logs.slice(0, 8).map((log, index) => (
                      <li key={`${index}-${log.message}`} className={log.level === "error" ? "text-danger" : ""}>
                        {log.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {warnings.length > 0 ? (
              <div
                role="status"
                data-testid="repeater-warnings"
                className="mx-3 mt-3 flex flex-col gap-1"
              >
                {warnings.map((warning, index) => (
                  <span
                    key={`${warning.code}-${index}`}
                    className="inline-flex w-fit items-center rounded border border-yellow-500/40 bg-yellow-500/10 px-1.5 py-0.5 font-mono text-[10px] text-yellow-400"
                  >
                    {warning.message}
                  </span>
                ))}
              </div>
            ) : null}

            {response !== null ? (
              <div data-testid="repeater-response-body" className="flex min-h-0 flex-col">
                <div
                  data-testid="repeater-status"
                  className="flex h-8 min-w-0 items-center gap-3 overflow-hidden border-b border-line bg-panel/40 px-3 font-mono text-[11px]"
                >
                  <span className={`min-w-0 truncate ${statusColor(response.status)}`}>
                    {response.status} {response.reason}
                  </span>
                  <span className="text-muted">·</span>
                  <span className="text-muted">{formatBytes(response.size)}</span>
                  <span className="text-muted">·</span>
                  <span className="text-muted">{result?.durationMs ?? "—"} ms</span>
                  {response.truncated ? (
                    <span className="badge border-yellow-500/40 text-yellow-400">已截断</span>
                  ) : null}
                </div>
                {/* 响应头在上、响应体在下，放在同一个视图里（不再需要切换 Headers） */}
                <pre
                  data-testid="repeater-response-headers"
                  className="max-w-full whitespace-pre-wrap break-words border-b border-line bg-panel/20 px-3 py-2 font-mono text-[11px] leading-5 text-muted"
                >
                  {response.headers.length > 0
                    ? response.headers
                        .map((header) => `${header.name}: ${header.value}`)
                        .join("\n")
                    : "（无响应头）"}
                </pre>
                {bodyView.hint !== "" ? (
                  <p
                    data-testid="repeater-response-hint"
                    className="border-b border-line px-3 py-1.5 text-[11px] text-yellow-400"
                  >
                    {bodyView.hint}
                  </p>
                ) : null}
                <pre
                  ref={responseRef}
                  data-testid="repeater-response-content"
                  onMouseUp={onResponseSelect}
                  className={`max-w-full px-3 py-3 font-mono text-[12px] leading-5 text-ink ${
                    view === "hex"
                      ? "overflow-x-auto whitespace-pre"
                      : "whitespace-pre-wrap break-words"
                  }`}
                >
                  {responseSegments.map((seg, index) =>
                    seg.color === undefined ? (
                      <span key={index}>{seg.text}</span>
                    ) : (
                      <mark
                        key={index}
                        data-testid="response-highlight"
                        style={{ backgroundColor: markColor(seg.color), color: "inherit" }}
                      >
                        {seg.text}
                      </mark>
                    ),
                  )}
                </pre>
              </div>
            ) : null}

            {showEmpty ? (
              <div className="flex h-full items-center justify-center p-5">
                <div className="w-full max-w-[420px]">
                  <EmptyState
                    testId="repeater-response-empty"
                    title="尚未发送请求"
                    description="编辑左侧请求后，按 ⌘↵ 或点击发送按钮，状态行、响应头与响应体会显示在这里。"
                    hint="origin-form 请求（GET /path）会使用上方目标栏"
                  />
                </div>
              </div>
            ) : null}
          </div>
        </section>

        {/* 取证区（方案 C：三栏并排） */}
        {evidenceVisible ? (
          <EvidencePanel onHide={() => setEvidenceVisible(false)} />
        ) : null}
      </div>

      <footer className="flex h-11 shrink-0 items-center justify-between gap-4 border-t border-line bg-panel px-3">
        <p className="min-w-0 truncate font-mono text-[10px] text-muted/60">
          {activeTab === null
            ? "未加载标签"
            : `${activeTab.name} · ${activeTab.rawRequest.length} 字符`}
        </p>
        <button
          type="button"
          data-testid="repeater-send"
          className="btn btn-primary"
          disabled={sending || activeTab === null}
          onClick={() => void send()}
          aria-keyshortcuts="Meta+Enter Control+Enter"
        >
          {sending ? "取消" : "发送"}
          <kbd className="kbd">⌘↵</kbd>
        </button>
      </footer>

      {highlightNotice !== "" ? (
        <p
          role="status"
          data-testid="highlight-notice"
          className="absolute bottom-14 left-1/2 z-30 -translate-x-1/2 rounded border border-yellow-500/40 bg-yellow-500/10 px-3 py-1 text-[11px] text-yellow-400"
        >
          {highlightNotice}
        </p>
      ) : null}

      {pending !== null ? (
        <HighlightToolbar
          anchor={pending}
          onPick={applyHighlight}
          onClear={clearSelectionHighlight}
          onCopy={copySelection}
          onDismiss={() => setPending(null)}
        />
      ) : null}
    </section>
  );
}
