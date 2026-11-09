/**
 * Unit tests for the operator session status.
 *
 * The status lives in a `custom` session entry, so the tests pin both the entry
 * shape the console writes and the two read paths: the branch of a loaded
 * session, and the session list, which gets it from `SessionInfo.customState`.
 */

import { expect, test } from "vitest";
import {
	isSessionStatus,
	readSessionStatus,
	SESSION_STATUS_CUSTOM_TYPE,
	sessionStatusFromEntry,
	withSessionStatus,
} from "../src/session-status.ts";

function statusEntry(data: unknown): { type: string; customType: string; data: unknown } {
	return { type: "custom", customType: SESSION_STATUS_CUSTOM_TYPE, data };
}

test("a status entry reads back as its status", () => {
	expect(sessionStatusFromEntry({ status: "todo", at: 1 })).toBe("todo");
	expect(readSessionStatus([statusEntry({ status: "ignored", at: 2 })])).toBe("ignored");
});

test("the last status entry on the branch wins, and null clears it", () => {
	const branch = [statusEntry({ status: "todo" }), { type: "message" }, statusEntry({ status: "done" })];
	expect(readSessionStatus(branch)).toBe("done");
	expect(readSessionStatus([...branch, statusEntry(null)])).toBeNull();
});

test("a branch without a status entry has none", () => {
	expect(readSessionStatus([])).toBeNull();
	expect(readSessionStatus([{ type: "custom", customType: "zg-goal-state", data: { status: "active" } }])).toBeNull();
});

test("garbage in the entry is ignored instead of surfacing as a status", () => {
	expect(sessionStatusFromEntry({ status: "urgent" })).toBeUndefined();
	expect(sessionStatusFromEntry({ status: 3 })).toBeUndefined();
	expect(sessionStatusFromEntry("todo")).toBeUndefined();
	expect(readSessionStatus([statusEntry({ status: "urgent" })])).toBeNull();
	expect(isSessionStatus("todo")).toBe(true);
	expect(isSessionStatus("urgent")).toBe(false);
});

test("a listed session surfaces its status without the raw custom state", () => {
	const info = {
		path: "/s/one.jsonl",
		id: "one",
		cwd: "/work",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 3,
		firstMessage: "hi",
		allMessagesText: "hi",
		customState: { [SESSION_STATUS_CUSTOM_TYPE]: { status: "todo", at: 5 } },
	};
	const listed = withSessionStatus(info);
	expect(listed.status).toBe("todo");
	expect("customState" in listed).toBe(false);
	expect("allMessagesText" in listed).toBe(false);
	expect(listed.firstMessage).toBe("hi");
});

test("a listed session with no status, or only other custom state, has no status field", () => {
	const base = {
		path: "/s/two.jsonl",
		id: "two",
		cwd: "/work",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: "hi",
		allMessagesText: "hi",
	};
	expect(withSessionStatus(base).status).toBeUndefined();
	expect(
		withSessionStatus({ ...base, customState: { "zg-goal-state": { status: "active" } } }).status,
	).toBeUndefined();
	expect(withSessionStatus({ ...base, customState: { [SESSION_STATUS_CUSTOM_TYPE]: null } }).status).toBeUndefined();
});
