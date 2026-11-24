/**
 * Column widths the operator can drag apart, one table at a time.
 *
 * The console's tables give every column a fixed width, so that a long value is
 * cut off instead of pushing the table apart. That left no way to read what a
 * column cut off. With this, the right end of every header cell is a handle:
 * dragging it moves the edge, a double-click on it gives the column its default
 * width back, and the widths stay, in this browser, with the table they belong to.
 *
 * There is no library in it: a handle, three pointer events, and the width the
 * cell had when the drag began.
 */

import {
	type PointerEvent as ReactPointerEvent,
	type ThHTMLAttributes,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ProColumns } from "@ant-design/pro-components";
import { t } from "../i18n.ts";
import "./resizable-columns.css";

/** A column never gets narrower than this: its handle has to stay grabbable. */
export const MIN_COLUMN_WIDTH = 48;
/** Nor wider than this: past it the column is wider than most of the page. */
export const MAX_COLUMN_WIDTH = 1200;

const STORAGE_PREFIX = "sentinel.column-widths.";
/** On `body` while an edge is being dragged: the cursor follows it and no text gets selected. */
const RESIZING_CLASS = "is-resizing-column";

/** What a column hands its header cell through `onHeaderCell`. */
export interface ResizableHeaderProps {
	width?: number;
	/** The edge moved; `width` is the width it leaves the column with. */
	onColumnResize?: (width: number) => void;
	/** The handle was double-clicked: the column goes back to its default width. */
	onColumnReset?: () => void;
}

/** A width as the table can use it: a whole number of pixels within the limits. */
export function clampColumnWidth(width: number): number {
	if (!Number.isFinite(width)) return MIN_COLUMN_WIDTH;
	return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));
}

export interface ColumnDrag {
	/** How wide the column is on the screen as the drag begins. */
	startWidth: number;
	/** The width the column was given. It is the same as `startWidth`, unless the table is sharing out spare width. */
	declared: number;
	/** How far the pointer moved, in pixels; to the right is positive. */
	distance: number;
	/** How wide the table's area on the page is. */
	containerWidth: number;
	/** What the other columns' widths add up to, as they were given. */
	others: number;
}

/**
 * The width a column has to be given for its edge to end where the pointer is.
 *
 * A table narrower than its page is stretched to fill it, every column by the
 * same factor. There a column shows more pixels than it was given, so adding
 * the pointer's travel to what it shows would overshoot: the edge would run
 * ahead of the pointer. The width is worked back from where the edge belongs.
 */
export function draggedColumnWidth(drag: ColumnDrag): number {
	const target = drag.startWidth + drag.distance;
	if (target <= 0) return MIN_COLUMN_WIDTH;
	if (target >= drag.containerWidth) return MAX_COLUMN_WIDTH;
	// Stretched: the other columns take `others` of the page, this one the rest, in proportion.
	if (drag.others > 0 && drag.others + target < drag.containerWidth)
		return clampColumnWidth((target * drag.others) / (drag.containerWidth - target));
	return clampColumnWidth(target);
}

/**
 * The widths an operator set for a table, as they were stored: only whole
 * numbers within the limits count. Anything else, a damaged file included, reads
 * as nothing set, and every column falls back to its default.
 */
export function readColumnOverrides(raw: string | null): Record<string, number> {
	let stored: unknown;
	try {
		stored = raw === null || raw === "" ? {} : JSON.parse(raw);
	} catch {
		return {};
	}
	if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
	const overrides: Record<string, number> = {};
	for (const [key, value] of Object.entries(stored as Record<string, unknown>))
		if (typeof value === "number" && Number.isFinite(value)) overrides[key] = clampColumnWidth(value);
	return overrides;
}

function readStorage(key: string): string | null {
	try {
		return globalThis.localStorage?.getItem(key) ?? null;
	} catch {
		// Storage can be refused (a private window, a locked-down browser): the widths then last for this page only.
		return null;
	}
}

function writeStorage(key: string, overrides: Record<string, number> | null): void {
	try {
		if (overrides === null) globalThis.localStorage?.removeItem(key);
		else globalThis.localStorage?.setItem(key, JSON.stringify(overrides));
	} catch {
		// Same as above: nothing to do when there is nowhere to keep them.
	}
}

export interface ColumnWidths {
	/** Column key → width in pixels. Every column that has a default is in it. */
	widths: Record<string, number>;
	/** Added up: the width the table needs before it has to scroll sideways. */
	total: number;
	/** Whether any column is away from its default width. */
	customized: boolean;
	resize: (key: string, width: number) => void;
	/** One column back to its default, or every column when none is named. */
	reset: (key?: string) => void;
}

/**
 * The widths of one table's columns. `defaults` is each column's declared width
 * by key; only what the operator changed is kept, so a column that changes its
 * default in a later version of the console picks that up.
 */
export function useColumnWidths(table: string, defaults: Readonly<Record<string, number>>): ColumnWidths {
	const storageKey = `${STORAGE_PREFIX}${table}`;
	const [overrides, setOverrides] = useState<Record<string, number>>(() => readColumnOverrides(readStorage(storageKey)));
	// A caller may build its defaults on every render: what says whether they changed is their content.
	const signature = JSON.stringify(defaults);
	const { widths, known } = useMemo(() => {
		const widths: Record<string, number> = {};
		for (const [key, fallback] of Object.entries(defaults)) widths[key] = overrides[key] ?? fallback;
		// A column that is gone keeps no say, and must not make the table look customized.
		const known = Object.fromEntries(Object.entries(overrides).filter(([key]) => key in widths));
		return { widths, known };
	}, [signature, overrides]);
	const customized = Object.keys(known).length > 0;

	const resize = useCallback((key: string, width: number) => {
		setOverrides((current) => ({ ...current, [key]: clampColumnWidth(width) }));
	}, []);
	const reset = useCallback((key?: string) => {
		setOverrides((current) => {
			if (key === undefined) return {};
			const next = { ...current };
			delete next[key];
			return next;
		});
	}, []);

	useEffect(() => {
		writeStorage(storageKey, customized ? known : null);
	}, [storageKey, known, customized]);
	// Another tab of the same console dragging an edge: follow it.
	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (event.key !== storageKey) return;
			setOverrides(readColumnOverrides(event.newValue));
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [storageKey]);

	const total = Object.values(widths).reduce((sum, width) => sum + width, 0);
	return { widths, total, customized, resize, reset };
}

/** The key a column's width is kept under: its `key`, or else its `dataIndex`. */
function columnKey<T>(column: ProColumns<T>): string | undefined {
	if (column.key !== undefined && column.key !== null) return String(column.key);
	if (column.dataIndex !== undefined && column.dataIndex !== null) return String(column.dataIndex);
	return undefined;
}

/** The `onHeaderCell` that makes one column resizable. */
export function columnHeaderProps(key: string, widths: ColumnWidths): () => ResizableHeaderProps {
	return () => ({
		width: widths.widths[key],
		onColumnResize: (width: number) => widths.resize(key, width),
		onColumnReset: () => widths.reset(key),
	});
}

export interface ResizableColumns<T> {
	/** The same columns, each with the width in effect and a header cell that can be dragged. */
	columns: ProColumns<T>[];
	total: number;
	customized: boolean;
	/** Every column back to its declared width. */
	reset: () => void;
}

/**
 * Makes a table's columns resizable: every column that has a key and a numeric
 * `width` starts from that width. Pass what comes back as the table's
 * `columns`, give `total` to `scroll.x`, and render the headers with
 * `ResizableTitle` through `components`.
 */
export function useResizableColumns<T>(table: string, columns: ProColumns<T>[]): ResizableColumns<T> {
	const defaults: Record<string, number> = {};
	for (const column of columns) {
		const key = columnKey(column);
		if (key !== undefined && typeof column.width === "number") defaults[key] = column.width;
	}
	const widths = useColumnWidths(table, defaults);
	const resizable = columns.map((column) => {
		const key = columnKey(column);
		return key !== undefined && key in widths.widths
			? { ...column, width: widths.widths[key], onHeaderCell: columnHeaderProps(key, widths) }
			: column;
	});
	return { columns: resizable, total: widths.total, customized: widths.customized, reset: () => widths.reset() };
}

type HeaderCellProps = ThHTMLAttributes<HTMLElement> & ResizableHeaderProps;

/**
 * The header cell of a resizable table. A column that said nothing through
 * `onHeaderCell` gets an ordinary `th`.
 */
export function ResizableTitle({ width, onColumnResize, onColumnReset, className, children, ...rest }: HeaderCellProps) {
	// The width reaches the column through the table's own `colgroup`, so it is not written on the cell.
	if (!onColumnResize) return <th {...rest} className={className}>{children}</th>;
	return (
		<th {...rest} className={className ? `${className} resizable-col` : "resizable-col"}>
			{children}
			<ColumnEdge declared={width} onResize={onColumnResize} onReset={onColumnReset} />
		</th>
	);
}

/** The strip at the right end of a header cell. */
function ColumnEdge({ declared, onResize, onReset }: { declared?: number; onResize: (width: number) => void; onReset?: () => void }) {
	/** Set while an edge is being dragged. */
	const drag = useRef<{ pointerId: number; startX: number; drag: Omit<ColumnDrag, "distance"> } | null>(null);

	// An unmount in the middle of a drag must not leave the page in its dragging state.
	useEffect(() => () => document.body.classList.remove(RESIZING_CLASS), []);

	const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
		const cell = event.currentTarget.parentElement;
		if (!cell) return;
		// The press is a drag and not a click on the header, and must not select text on the way.
		event.preventDefault();
		event.stopPropagation();
		const startWidth = cell.getBoundingClientRect().width;
		// A column with no room on the screen has no edge to drag.
		if (startWidth <= 0) return;
		// What the other columns come to, in the widths they were given: they are
		// shown stretched by the same factor as this one, if the table is stretched.
		const row = cell.parentElement;
		const shown = row
			? [...row.children].reduce((sum, sibling) => sum + sibling.getBoundingClientRect().width, 0)
			: startWidth;
		const given = declared !== undefined && declared > 0 ? declared : startWidth;
		drag.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			drag: {
				startWidth,
				declared: given,
				// No area to fill (no table around the cell) leaves a column exactly as wide as it is given.
				containerWidth: cell.closest("table")?.parentElement?.clientWidth ?? 0,
				others: ((shown - startWidth) * given) / startWidth,
			},
		};
		try {
			// Captured, the handle keeps hearing the pointer wherever it goes, so the edge follows it past any neighbour.
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			// A pointer that is already gone cannot be captured: there is no drag to make.
			drag.current = null;
			return;
		}
		document.body.classList.add(RESIZING_CLASS);
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
		const state = drag.current;
		if (!state || state.pointerId !== event.pointerId) return;
		onResize(draggedColumnWidth({ ...state.drag, distance: event.clientX - state.startX }));
	};
	const onPointerEnd = (event: ReactPointerEvent<HTMLSpanElement>) => {
		const state = drag.current;
		if (!state || state.pointerId !== event.pointerId) return;
		drag.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		document.body.classList.remove(RESIZING_CLASS);
	};

	return (
		<span
			className="resizable-col-handle"
			role="separator"
			aria-orientation="vertical"
			aria-label={t("调整列宽")}
			title={t("拖动调整列宽，双击恢复默认")}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerEnd}
			onClick={(event) => event.stopPropagation()}
			onDoubleClick={() => onReset?.()}
		/>
	);
}
