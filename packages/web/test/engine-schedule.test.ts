/**
 * The schedule is one absolute timeline, not a recurring calendar. These tests
 * pin the two properties the engine manager depends on: validation rejects
 * ambiguous plans, and each action becomes due exactly once in order even when
 * the scheduler wakes late.
 */

import { expect, test } from "vitest";
import {
	applyScheduleAction,
	dueScheduleAction,
	finishSchedule,
	nextDailyOccurrence,
	nextScheduleAt,
	normalizeSchedule,
	SCHEDULE_START_GRACE_MS,
} from "../src/engine-schedule.ts";

const HOUR = 60 * 60_000;
const now = Date.UTC(2026, 9, 21, 0, 0, 0);

test("normalizeSchedule attaches a waiting plan and preserves null options", () => {
	const schedule = normalizeSchedule(
		{
			timezone: "Asia/Shanghai",
			startAt: now + HOUR,
			pauseAt: null,
			resumeAt: null,
			deadlineAt: now + 4 * HOUR,
		},
		now,
	);
	expect(schedule.phase).toBe("waiting_start");
	expect(schedule.applied).toEqual([]);
	expect(schedule.pauseAt).toBeNull();
	expect(schedule.resumeAt).toBeNull();
	expect(schedule.deadlineAt).toBe(now + 4 * HOUR);
	expect(schedule.finishedReason).toBeNull();
});

test("daily recurrence keeps the same local wall-clock time across daylight saving", () => {
	const startAt = Date.parse("2026-03-07T14:30:00Z"); // 09:30 in New York before DST.
	const next = nextDailyOccurrence({ startAt, timezone: "America/New_York" }, startAt);
	expect(new Date(next).toISOString()).toBe("2026-03-08T13:30:00.000Z"); // 09:30 after DST.
	const schedule = normalizeSchedule({ timezone: "UTC", startAt: now + HOUR, repeatDaily: true }, now);
	expect(schedule.repeatDaily).toBe(true);
});

test("normalizeSchedule accepts a pause/resume pair after the start", () => {
	const schedule = normalizeSchedule(
		{
			timezone: "UTC",
			startAt: now + HOUR,
			pauseAt: now + 2 * HOUR,
			resumeAt: now + 3 * HOUR,
		},
		now,
	);
	expect(schedule.pauseAt).toBe(now + 2 * HOUR);
	expect(schedule.resumeAt).toBe(now + 3 * HOUR);
});

test("normalizeSchedule rejects a past start, bad zone, and broken order", () => {
	const base = { timezone: "UTC", startAt: now + HOUR };
	expect(() => normalizeSchedule({ ...base, startAt: now }, now)).toThrow(/开始时间/);
	expect(() => normalizeSchedule({ ...base, timezone: "Mars/Olympus" }, now)).toThrow(/时区/);
	expect(() => normalizeSchedule({ ...base, pauseAt: now + 2 * HOUR }, now)).toThrow(/同时/);
	expect(() => normalizeSchedule({ ...base, pauseAt: now + 2 * HOUR, resumeAt: now + 2 * HOUR }, now)).toThrow(
		/恢复时间/,
	);
	expect(() => normalizeSchedule({ ...base, deadlineAt: now + HOUR }, now)).toThrow(/最晚停止/);
});

test("a full timeline applies start, pause, resume, deadline exactly once", () => {
	let schedule = normalizeSchedule(
		{
			timezone: "Asia/Shanghai",
			startAt: now + HOUR,
			pauseAt: now + 2 * HOUR,
			resumeAt: now + 3 * HOUR,
			deadlineAt: now + 4 * HOUR,
		},
		now,
	);
	expect(dueScheduleAction(schedule, now + HOUR - 1)).toBeNull();
	expect(dueScheduleAction(schedule, now + HOUR)).toEqual({ action: "start", at: now + HOUR });
	schedule = applyScheduleAction(schedule, "start", now + HOUR + 5);
	expect(schedule.phase).toBe("running");
	expect(dueScheduleAction(schedule, now + HOUR + 5)).toBeNull();
	expect(nextScheduleAt(schedule)).toBe(now + 2 * HOUR);

	schedule = applyScheduleAction(schedule, "pause", now + 2 * HOUR + 5);
	expect(schedule.phase).toBe("paused");
	expect(dueScheduleAction(schedule, now + 2 * HOUR + 5)).toBeNull();
	expect(nextScheduleAt(schedule)).toBe(now + 3 * HOUR);

	schedule = applyScheduleAction(schedule, "resume", now + 3 * HOUR + 5);
	expect(schedule.phase).toBe("running");
	expect(nextScheduleAt(schedule)).toBe(now + 4 * HOUR);

	schedule = applyScheduleAction(schedule, "deadline", now + 4 * HOUR + 5);
	expect(schedule.phase).toBe("finished");
	expect(schedule.finishedReason).toBe("deadline");
	expect(dueScheduleAction(schedule, now + 10 * HOUR)).toBeNull();
	expect(nextScheduleAt(schedule)).toBeNull();
});

test("deadline wins over pause when both are due in the same pass", () => {
	const schedule = normalizeSchedule(
		{
			timezone: "UTC",
			startAt: now + HOUR,
			pauseAt: now + 2 * HOUR,
			resumeAt: now + 3 * HOUR,
			deadlineAt: now + 4 * HOUR,
		},
		now,
	);
	let running = applyScheduleAction(schedule, "start", now + HOUR);
	// The scheduler wakes at +5h: both the pause and the deadline are late, and
	// the deadline must win rather than pause for a resume that is also past.
	expect(dueScheduleAction(running, now + 5 * HOUR)).toEqual({ action: "deadline", at: now + 4 * HOUR });
	running = applyScheduleAction(running, "deadline", now + 4 * HOUR);
	expect(running.phase).toBe("finished");
});

test("applying an action twice does not duplicate the applied marker", () => {
	const schedule = normalizeSchedule({ timezone: "UTC", startAt: now + HOUR }, now);
	const started = applyScheduleAction(schedule, "start", now + HOUR);
	const again = applyScheduleAction(started, "start", now + HOUR + 100);
	expect(again.applied).toEqual(["start"]);
	expect(again.phase).toBe("running");
});

test("finishSchedule stops the plan with an operator-readable reason", () => {
	const schedule = normalizeSchedule({ timezone: "UTC", startAt: now + HOUR }, now);
	const finished = finishSchedule(schedule, "manual", now + 30);
	expect(finished.phase).toBe("finished");
	expect(finished.finishedReason).toBe("manual");
	expect(finished.finishedAt).toBe(now + 30);
	expect(nextScheduleAt(finished)).toBeNull();
});

test("start grace is ten minutes", () => {
	expect(SCHEDULE_START_GRACE_MS).toBe(10 * 60_000);
});
