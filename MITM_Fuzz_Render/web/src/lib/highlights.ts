/* -------------------------------------------------------------------------- */
/* 请求/响应高亮：类型与纯函数                                                 */
/*                                                                             */
/* 高亮存服务端（标签页上），因为 /api/capture 用全新浏览器 profile 截图，      */
/* 存在浏览器 localStorage 里的高亮不会出现在截图里。                          */
/* -------------------------------------------------------------------------- */

export type HighlightColor = "yellow" | "green" | "red" | "blue";

export interface Highlight {
  start: number;
  end: number;
  color: HighlightColor;
}

/** request 为请求编辑器；response 按视图（raw/pretty/hex）分别记录偏移。 */
export interface Highlights {
  request: Highlight[];
  response: Record<string, Highlight[]>;
}

export interface HighlightColorSpec {
  key: HighlightColor;
  label: string;
  /** 内容区高亮底色（半透明，压在文字下面） */
  mark: string;
  /** 工具条上的色点类名 */
  dot: string;
}

export const DEFAULT_HIGHLIGHT_COLOR: HighlightColorSpec = {
  key: "yellow",
  label: "黄",
  mark: "rgba(250, 204, 21, 0.52)",
  dot: "bg-yellow-400",
};

export const HIGHLIGHT_COLORS: HighlightColorSpec[] = [
  DEFAULT_HIGHLIGHT_COLOR,
  { key: "green", label: "绿", mark: "rgba(52, 211, 153, 0.48)", dot: "bg-accent" },
  { key: "red", label: "红", mark: "rgba(248, 113, 113, 0.52)", dot: "bg-red-400" },
  { key: "blue", label: "蓝", mark: "rgba(96, 165, 250, 0.52)", dot: "bg-blue-400" },
];

export function colorSpec(color: HighlightColor): HighlightColorSpec {
  return HIGHLIGHT_COLORS.find((item) => item.key === color) ?? DEFAULT_HIGHLIGHT_COLOR;
}

export function markColor(color: HighlightColor): string {
  return colorSpec(color).mark;
}

export function emptyHighlights(): Highlights {
  return { request: [], response: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseList(value: unknown): Highlight[] {
  if (!Array.isArray(value)) return [];
  const out: Highlight[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const start = entry.start;
    const end = entry.end;
    const color = entry.color;
    if (typeof start !== "number" || typeof end !== "number" || typeof color !== "string") continue;
    if (!HIGHLIGHT_COLORS.some((spec) => spec.key === color)) continue;
    if (start < 0 || end <= start) continue;
    out.push({ start, end, color: color as HighlightColor });
  }
  return normalize(out);
}

/** 从标签页上的 highlights 字段解析（服务端原样存 JSON）。 */
export function parseHighlights(raw: unknown): Highlights {
  if (!isRecord(raw)) return emptyHighlights();
  const result = emptyHighlights();
  result.request = parseList(raw.request);
  if (isRecord(raw.response)) {
    for (const [view, value] of Object.entries(raw.response)) {
      const list = parseList(value);
      if (list.length > 0) result.response[view] = list;
    }
  }
  return result;
}

/** 排序 + 去重叠（与服务端 normalize 保持一致，避免前后端不一致）。 */
export function normalize(list: Highlight[]): Highlight[] {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out: Highlight[] = [];
  let lastEnd = -1;
  for (const item of sorted) {
    if (item.start < lastEnd) continue;
    out.push(item);
    lastEnd = item.end;
  }
  return out;
}

/** 新增一条高亮；与已有高亮重叠的部分先被剔除（后加的赢）。 */
export function addHighlight(list: Highlight[], start: number, end: number, color: HighlightColor): Highlight[] {
  if (end <= start) return list;
  return normalize([...removeOverlapping(list, start, end), { start, end, color }]);
}

/** 移除与 [start,end) 有任何重叠的高亮。 */
export function removeOverlapping(list: Highlight[], start: number, end: number): Highlight[] {
  if (end <= start) return list;
  return list.filter((item) => item.end <= start || item.start >= end);
}

export function overlaps(list: Highlight[], start: number, end: number): boolean {
  return list.some((item) => item.end > start && item.start < end);
}

export function countHighlights(highlights: Highlights): number {
  return (
    highlights.request.length +
    Object.values(highlights.response).reduce((sum, list) => sum + list.length, 0)
  );
}

export interface Segment {
  text: string;
  color?: HighlightColor;
}

/** 把纯文本按高亮切成片段（响应侧用 <mark> 内联渲染，天然支持折行）。 */
export function segmentText(text: string, list: Highlight[]): Segment[] {
  if (list.length === 0) return [{ text }];
  const segments: Segment[] = [];
  let cursor = 0;
  for (const item of normalize(list)) {
    const start = Math.max(0, Math.min(item.start, text.length));
    const end = Math.max(start, Math.min(item.end, text.length));
    if (start > cursor) segments.push({ text: text.slice(cursor, start) });
    if (end > start) segments.push({ text: text.slice(start, end), color: item.color });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

/* -------------------------------------------------------------------------- */
/* 请求编辑器（textarea）的几何计算                                            */
/*                                                                             */
/* textarea 内部无法给选区上色，所以用"底层色块 + 上层透明 textarea"的方案。    */
/* 编辑器使用等宽字体；按可视列数处理软换行，计算高亮矩形。                 */
/* -------------------------------------------------------------------------- */

export interface EditorMetrics {
  charWidth: number;
  lineHeight: number;
  paddingLeft: number;
  paddingTop: number;
  columns: number;
}

export interface HighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
  color: HighlightColor;
}

/** 测量等宽编辑器的字符宽度/行高/内边距。 */
export function measureEditor(element: HTMLTextAreaElement): EditorMetrics | null {
  const style = window.getComputedStyle(element);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const charWidth = ctx.measureText("M").width;
  const lineHeight = Number.parseFloat(style.lineHeight);
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  const contentWidth = element.clientWidth - paddingLeft - paddingRight;
  return {
    charWidth: charWidth > 0 ? charWidth : 7,
    lineHeight: Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24,
    paddingLeft,
    paddingTop: Number.parseFloat(style.paddingTop) || 0,
    columns: Math.max(1, Math.floor(contentWidth / (charWidth > 0 ? charWidth : 7))),
  };
}

/** 把偏移换算成"第几行 / 第几列"。 */
function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 0;
  let lineStart = 0;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: limit - lineStart };
}

/** 计算高亮在编辑器内容里的矩形（多行会拆成多个矩形）。 */
export function highlightRects(
  text: string,
  list: Highlight[],
  metrics: EditorMetrics,
): HighlightRect[] {
  const rects: HighlightRect[] = [];
  const columns = Math.max(1, metrics.columns);
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  for (const item of normalize(list)) {
    const start = Math.max(0, Math.min(item.start, text.length));
    const end = Math.max(start, Math.min(item.end, text.length));
    const from = lineColumn(text, start);
    const to = lineColumn(text, end);
    let visualLine = lines
      .slice(0, from.line)
      .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / columns)), 0);
    for (let line = from.line; line <= to.line; line++) {
      const columnStart = line === from.line ? from.column : 0;
      const columnEnd = line === to.line ? to.column : Number.POSITIVE_INFINITY;
      const content = lines[line] ?? "";
      const segments = splitLineColumns(content, columnStart, columnEnd, columns);
      for (const seg of segments) {
        rects.push({
          x: metrics.paddingLeft + seg.from * metrics.charWidth,
          y: metrics.paddingTop + (visualLine + seg.row) * metrics.lineHeight,
          width: Math.max((seg.to - seg.from) * metrics.charWidth, 2),
          height: metrics.lineHeight,
          color: item.color,
        });
      }
      visualLine += Math.max(1, Math.ceil(content.length / columns));
    }
  }
  return rects;
}

/** 把逻辑行中的列范围切成软换行后的可视行片段。 */
function splitLineColumns(
  content: string,
  fromColumn: number,
  toColumn: number,
  columns: number,
): Array<{ row: number; from: number; to: number }> {
  const width = content.length;
  const from = Math.max(0, Math.min(fromColumn, width));
  const to = Math.max(from, Math.min(toColumn, width));
  if (to <= from) {
    // 空行或整行高亮时给一个可见的最小宽度
    return width === 0 ? [{ row: 0, from: 0, to: 1 }] : [];
  }
  const segments: Array<{ row: number; from: number; to: number }> = [];
  for (let start = from; start < to; ) {
    const row = Math.floor(start / columns);
    const rowEnd = Math.min(to, (row + 1) * columns);
    segments.push({ row, from: start - row * columns, to: rowEnd - row * columns });
    start = rowEnd;
  }
  return segments;
}

/** 从 DOM 选区算出它在某个容器纯文本里的偏移。 */
export function offsetsFromRange(root: HTMLElement, range: Range): { start: number; end: number } | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let start = -1;
  let end = -1;
  let node = walker.nextNode();
  while (node !== null) {
    const length = node.textContent?.length ?? 0;
    if (node === range.startContainer) start = offset + range.startOffset;
    if (node === range.endContainer) end = offset + range.endOffset;
    offset += length;
    node = walker.nextNode();
  }
  if (start < 0 || end < 0 || end <= start) return null;
  return { start, end };
}

/** 请求/响应高亮的持久化（PUT /api/tabs/{id}/highlights）。 */
export async function saveHighlights(
  tabId: string,
  highlights: Highlights,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (highlights.request.length > 0) body.request = highlights.request;
  if (Object.keys(highlights.response).length > 0) body.response = highlights.response;
  const response = await fetch(`/api/tabs/${encodeURIComponent(tabId)}/highlights`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`保存高亮失败：HTTP ${response.status}`);
  }
}
