/**
 * The containment check behind "only files inside the session directory may be
 * renamed or deleted".
 *
 * It used to compare a prefix ending in a slash, which never matched on Windows,
 * where folders are joined with a backslash: a user there could not delete,
 * rename or label any session, each attempt answering 路径不在受管的会话目录内.
 * The Windows path functions are run here, on whatever machine runs the tests.
 */
import { posix, win32 } from "node:path";
import { expect, test } from "vitest";
import { isInsideDirectory } from "../src/managed-path.ts";

test("on Windows a session file in the session directory is inside it", () => {
	const directory = win32.resolve("C:\\Users\\op\\.sentinel\\agent\\sessions--C--Users-op-work-project--");
	// The path the session list hands out: the directory and the file joined by the platform.
	const file = win32.join(directory, "2026-11-20T10-00-00_abc123.jsonl");
	expect(file).toContain("\\");
	expect(isInsideDirectory(directory, file, win32)).toBe(true);
	// Nested, and written with forward slashes, as a browser or a script might.
	expect(isInsideDirectory(directory, `${directory}\\nested\\x.jsonl`, win32)).toBe(true);
	expect(
		isInsideDirectory(directory, "C:/Users/op/.sentinel/agent/sessions--C--Users-op-work-project--/x.jsonl", win32),
	).toBe(true);
	// Drive letter case does not make a difference on Windows.
	expect(isInsideDirectory(directory, file.replace("C:\\", "c:\\"), win32)).toBe(true);
});

test("on Windows everything else is outside", () => {
	const directory = win32.resolve("C:\\Users\\op\\.sentinel\\agent\\sessions--C--Users-op-work-project--");
	// Another drive, which no relative path starting with `..` can reach.
	expect(isInsideDirectory(directory, "D:\\elsewhere\\x.jsonl", win32)).toBe(false);
	// The parent, a sibling whose name starts with the directory's, and the directory itself.
	expect(isInsideDirectory(directory, win32.join(directory, "..", "x.jsonl"), win32)).toBe(false);
	expect(isInsideDirectory(directory, `${directory}-other\\x.jsonl`, win32)).toBe(false);
	expect(isInsideDirectory(directory, directory, win32)).toBe(false);
	// A file whose name merely starts with two dots is still inside.
	expect(isInsideDirectory(directory, win32.join(directory, "..draft.jsonl"), win32)).toBe(true);
});

test("on this platform's own path rules the check holds both ways", () => {
	const directory = posix.resolve("/Users/op/.sentinel/agent/sessions--Users-op-work-project--");
	expect(isInsideDirectory(directory, posix.join(directory, "a.jsonl"), posix)).toBe(true);
	expect(isInsideDirectory(directory, posix.join(directory, "..", "a.jsonl"), posix)).toBe(false);
	expect(isInsideDirectory(directory, "/tmp/a.jsonl", posix)).toBe(false);
	// The default is the platform the process runs on.
	expect(isInsideDirectory(directory, posix.join(directory, "a.jsonl"))).toBe(process.platform !== "win32");
});
