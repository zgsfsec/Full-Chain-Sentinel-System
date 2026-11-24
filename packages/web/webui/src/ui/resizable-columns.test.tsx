/**
 * Column widths the operator drags apart.
 *
 * What is checked here is what a drag rests on: the width it computes, what is
 * kept of it between visits, and the header cell that carries the handle. The
 * drag itself is pointer work in a browser; it was tried there by hand.
 */

import { renderToStaticMarkup } from "react-dom/server";
import type { ProColumns } from "@ant-design/pro-components";
import { afterEach, expect, test } from "vitest";
import {
	clampColumnWidth,
	columnHeaderProps,
	draggedColumnWidth,
	MAX_COLUMN_WIDTH,
	MIN_COLUMN_WIDTH,
	readColumnOverrides,
	ResizableTitle,
	type ResizableHeaderProps,
	useResizableColumns,
} from "./resizable-columns.tsx";

interface Finding {
	number: number;
	severity: string;
	note: string;
}

const COLUMNS: ProColumns<Finding>[] = [
	{ title: "编号", dataIndex: "number", key: "number", width: 96 },
	{ title: "等级", dataIndex: "severity", key: "severity", width: 124 },
	// No key of its own: the data index stands in.
	{ title: "备注", dataIndex: "note", width: 180 },
	// No width declared: left exactly as it is.
	{ title: "操作", key: "actions" },
];

function fakeStorage(values: Record<string, string>, refuse = false): void {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		writable: true,
		value: refuse
			? {
					getItem: () => {
						throw new Error("SecurityError");
					},
				}
			: {
					getItem: (key: string) => values[key] ?? null,
					setItem: (key: string, value: string) => {
						values[key] = value;
					},
					removeItem: (key: string) => {
						delete values[key];
					},
				},
	});
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, "localStorage");
});

/** What the hook makes of the columns, read off a first render. */
interface Rendered {
	widths: Record<string, number>;
	total: number;
	customized: boolean;
	/** What the 等级 column hands its header cell: the width, and whether the two handlers are there. */
	severity: { width: number; handlers: string[] };
}

function renderHook(): Rendered {
	// Encoded, because markup escapes quotes inside text.
	const html = renderToStaticMarkup(<Probe />);
	return JSON.parse(decodeURIComponent(/<code>(.*?)<\/code>/.exec(html)?.[1] ?? "")) as Rendered;
}

function Probe() {
	const resizable = useResizableColumns("vulns", COLUMNS);
	const severity = resizable.columns.find((column) => column.key === "severity");
	const header = severity?.onHeaderCell?.(severity as never) as ResizableHeaderProps | undefined;
	return (
		<code>
			{encodeURIComponent(
				JSON.stringify({
					widths: Object.fromEntries(
						resizable.columns.map((column) => [column.key ?? String(column.dataIndex), column.width]),
					),
					total: resizable.total,
					customized: resizable.customized,
					severity: {
						width: header?.width,
						handlers: [typeof header?.onColumnResize, typeof header?.onColumnReset],
					},
				}),
			)}
		</code>
	);
}

/** Both handlers, as the first two tests expect them. */
const RESIZABLE = ["function", "function"];

test("a width stays within the limits, as whole pixels", () => {
	expect(clampColumnWidth(300)).toBe(300);
	expect(clampColumnWidth(124.6)).toBe(125);
	expect(clampColumnWidth(10)).toBe(MIN_COLUMN_WIDTH);
	expect(clampColumnWidth(99_999)).toBe(MAX_COLUMN_WIDTH);
	expect(clampColumnWidth(Number.NaN)).toBe(MIN_COLUMN_WIDTH);
});

test("a drag moves the edge by the pointer's travel", () => {
	// A table wider than its page, as wide as its columns: a pixel dragged is a pixel gained.
	const plain = { declared: 124, containerWidth: 1100, others: 1248 };
	expect(draggedColumnWidth({ ...plain, startWidth: 124, distance: 56 })).toBe(180);
	expect(draggedColumnWidth({ ...plain, startWidth: 124, distance: -24 })).toBe(100);
	// Dragging left past the minimum stops there, and so does dragging right past the maximum.
	expect(draggedColumnWidth({ ...plain, startWidth: 60, distance: -500 })).toBe(MIN_COLUMN_WIDTH);
	expect(draggedColumnWidth({ ...plain, startWidth: 1100, distance: 900 })).toBe(MAX_COLUMN_WIDTH);
});

test("on a table stretched to fill its page, the edge still lands where the pointer is", () => {
	// The column was given 96 and is shown at 192: the table is twice as wide as its columns add up to.
	const stretched = { startWidth: 192, declared: 96, containerWidth: 1100, others: 504 };
	const shown = (given: number) => Math.round((given * 1100) / (504 + given));
	// 40 px to the right. Taking the 232 on screen as the width to give would show 347: far past the pointer.
	expect(shown(232)).toBe(347);
	expect(draggedColumnWidth({ ...stretched, distance: 40 })).toBe(135);
	expect(shown(135)).toBe(232);
	// 40 px to the left: the column gives up what the others take.
	expect(draggedColumnWidth({ ...stretched, distance: -40 })).toBe(81);
	expect(shown(81)).toBe(152);
	// Past either end of the page it stops at the limits.
	expect(draggedColumnWidth({ ...stretched, distance: -5000 })).toBe(MIN_COLUMN_WIDTH);
	expect(draggedColumnWidth({ ...stretched, distance: 5000 })).toBe(MAX_COLUMN_WIDTH);
	// A column already at the smallest width it can be given stays there.
	expect(draggedColumnWidth({ ...stretched, startWidth: 96, declared: 48, distance: -40 })).toBe(MIN_COLUMN_WIDTH);
});

test("shrinking a column until the table no longer fills its page stays exact", () => {
	// Columns add up to exactly the page: 124 here and 976 elsewhere in 1100.
	const exact = { startWidth: 124, declared: 124, containerWidth: 1100, others: 976 };
	// 24 px narrower would leave the table 24 px short, so the page shares those out; the width is worked back from that.
	const width = draggedColumnWidth({ ...exact, distance: -24 });
	expect(Math.round((width * 1100) / (976 + width))).toBe(100);
	// Wider, there is nothing to share: a pixel is a pixel.
	expect(draggedColumnWidth({ ...exact, distance: 24 })).toBe(148);
});

test("only sane numbers are read back from what was stored", () => {
	expect(readColumnOverrides(null)).toEqual({});
	expect(readColumnOverrides("")).toEqual({});
	expect(readColumnOverrides('{"severity":200,"title":280}')).toEqual({ severity: 200, title: 280 });
	// A value that is not a number is not a width.
	expect(readColumnOverrides('{"severity":"wide","title":null,"source":[1]}')).toEqual({});
	// A number out of range is brought back in.
	expect(readColumnOverrides('{"severity":-40,"title":99999}')).toEqual({ severity: MIN_COLUMN_WIDTH, title: MAX_COLUMN_WIDTH });
	// A damaged file, or one that is not an object at all, reads as nothing set.
	expect(readColumnOverrides("{not json")).toEqual({});
	expect(readColumnOverrides("[200,300]")).toEqual({});
	expect(readColumnOverrides("200")).toEqual({});
});

test("without stored widths every column starts from its declared width", () => {
	fakeStorage({});
	expect(renderHook()).toEqual({
		widths: { number: 96, severity: 124, note: 180 },
		total: 400,
		customized: false,
		severity: { width: 124, handlers: RESIZABLE },
	});
});

test("a stored width is the width the column starts from on the next visit", () => {
	fakeStorage({ "sentinel.column-widths.vulns": '{"severity":260,"number":72}' });
	expect(renderHook()).toEqual({
		widths: { number: 72, severity: 260, note: 180 },
		total: 512,
		customized: true,
		severity: { width: 260, handlers: RESIZABLE },
	});
});

test("a width stored for a column that is gone changes nothing and does not make the table look customized", () => {
	fakeStorage({ "sentinel.column-widths.vulns": '{"removed-column":500}' });
	expect(renderHook()).toMatchObject({ customized: false, widths: { number: 96, severity: 124, note: 180 } });
});

test("when storage is refused the table still renders, from the declared widths", () => {
	fakeStorage({}, true);
	expect(renderHook()).toMatchObject({ customized: false, widths: { number: 96, severity: 124, note: 180 } });
});

test("the header cell carries the handle only for a column that can be resized", () => {
	const resizable = renderToStaticMarkup(
		<ResizableTitle className="ant-table-cell" scope="col" {...columnHeaderProps("severity", widths())()}>
			等级
		</ResizableTitle>,
	);
	// The cell keeps what the table gave it and gains the marker class; the width is not written on it.
	expect(resizable).toContain('<th scope="col" class="ant-table-cell resizable-col">等级<span');
	expect(resizable).not.toContain("width=");
	expect(resizable).toContain('class="resizable-col-handle"');
	expect(resizable).toContain('role="separator"');
	expect(resizable).toContain('aria-orientation="vertical"');
	expect(resizable).toContain('title="拖动调整列宽，双击恢复默认"');

	// The selection column's header says nothing, so it gets an ordinary cell.
	const plain = renderToStaticMarkup(<ResizableTitle className="ant-table-selection-column">x</ResizableTitle>);
	expect(plain).toBe('<th class="ant-table-selection-column">x</th>');
});

function widths() {
	const state = { widths: { severity: 124 }, total: 124, customized: false };
	return {
		...state,
		resize: () => {},
		reset: () => {},
	};
}
