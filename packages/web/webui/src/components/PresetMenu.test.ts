import { afterEach, expect, test, vi } from "vitest";
import { presetMenuPosition } from "./PresetMenu.tsx";

afterEach(() => vi.unstubAllGlobals());

test("a picker above the composer leaves space between the menu and viewport edge", () => {
	vi.stubGlobal("window", { innerWidth: 1280, innerHeight: 720 });
	const anchor = presetMenuPosition({ left: 32, top: 620, bottom: 650 } as DOMRect);
	expect(anchor.bottom).toBe(104);
	expect(anchor.maxHeight).toBe(320);
	expect(720 - (anchor.bottom ?? 0) - anchor.maxHeight).toBeGreaterThanOrEqual(8);
});

test("a short viewport does not force a minimum height that clips the final item", () => {
	vi.stubGlobal("window", { innerWidth: 360, innerHeight: 160 });
	const anchor = presetMenuPosition({ left: 20, top: 90, bottom: 120 } as DOMRect);
	expect(anchor.bottom).toBe(74);
	expect(anchor.maxHeight).toBe(78);
	expect(160 - (anchor.bottom ?? 0) - anchor.maxHeight).toBe(8);
});

test("a picker below its trigger stays inside the available height and actual width", () => {
	vi.stubGlobal("window", { innerWidth: 360, innerHeight: 720 });
	const anchor = presetMenuPosition({ left: 300, top: 20, bottom: 50 } as DOMRect);
	expect(anchor.top).toBe(54);
	expect(anchor.left + 260).toBeLessThanOrEqual(352);
	expect((anchor.top ?? 0) + anchor.maxHeight).toBeLessThanOrEqual(712);
});

test("a menu taller than the room below its button opens upward instead of scrolling", () => {
	// The composer's pill row in a 900 px window: about 220 px below it, room for
	// a short menu but not for a tall one.
	vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900 });
	const button = { left: 700, top: 640, bottom: 668 } as DOMRect;
	const tall = presetMenuPosition(button, 320, 360, 300);
	expect(tall.top).toBeUndefined();
	expect(tall.bottom).toBe(264);
	expect(tall.maxHeight).toBe(360);
	// The same button with a menu that does fit below stays under it.
	const short = presetMenuPosition(button, 320, 360, 200);
	expect(short.top).toBe(672);
	expect(short.maxHeight).toBe(220);
});
