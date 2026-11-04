import { describe, expect, it } from "vitest";
import {
	formatCronDraft,
	formatCronFields,
	nextCronOccurrences,
	nextCronTime,
	parseCronDraft,
	parseCronExpression,
	validateCronExpression,
} from "../src/cron.ts";

function local(year: number, month: number, day: number, hour = 0, minute = 0): Date {
	return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("parseCronExpression", () => {
	it("expands steps, ranges and names", () => {
		const schedule = parseCronExpression("*/15 9-17 * jan-mar mon-fri");
		expect(schedule.minutes).toEqual([0, 15, 30, 45]);
		expect(schedule.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
		expect(schedule.months).toEqual([1, 2, 3]);
		expect(schedule.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
		expect(schedule.domRestricted).toBe(false);
		expect(schedule.dowRestricted).toBe(true);
	});

	it("accepts Sunday as 7", () => {
		expect(parseCronExpression("0 0 * * 7").daysOfWeek).toEqual([0]);
	});

	it("rejects malformed expressions with a readable message", () => {
		expect(validateCronExpression("")).toContain("不能为空");
		expect(validateCronExpression("* * * *")).toContain("5 个字段");
		expect(validateCronExpression("60 * * * *")).toContain("超出范围");
		expect(validateCronExpression("*/0 * * * *")).toContain("步长");
		expect(validateCronExpression("5-1 * * * *")).toContain("起点大于终点");
		expect(validateCronExpression("0 0 31 2 *")).toContain("不会触发");
	});
});

describe("nextCronTime", () => {
	it("finds the next weekday at 09:00", () => {
		const next = nextCronTime(parseCronExpression("0 9 * * 1-5"), local(2024, 1, 1, 10).getTime());
		expect(next).toBe(local(2024, 1, 2, 9).getTime());
	});

	it("is strictly later than the current minute", () => {
		const at = local(2024, 1, 1, 9, 0).getTime();
		const next = nextCronTime(parseCronExpression("0 9 * * *"), at);
		expect(next).toBe(local(2024, 1, 2, 9).getTime());
	});

	it("ORs a restricted day-of-month with a restricted day-of-week", () => {
		const next = nextCronTime(parseCronExpression("0 0 13 * 5"), local(2024, 9, 1).getTime());
		expect(next).toBe(local(2024, 9, 6).getTime());
	});

	it("returns null for an impossible date", () => {
		expect(nextCronTime(parseCronExpression("0 0 31 2 *"), local(2024, 1, 1).getTime())).toBeNull();
	});

	it("lists the requested number of occurrences", () => {
		const times = nextCronOccurrences("*/30 * * * *", local(2024, 1, 1, 8, 1).getTime(), 3);
		expect(times).toEqual([
			local(2024, 1, 1, 8, 30).getTime(),
			local(2024, 1, 1, 9, 0).getTime(),
			local(2024, 1, 1, 9, 30).getTime(),
		]);
	});
});

describe("formatCronFields", () => {
	it("compresses wildcards, steps and ranges", () => {
		expect(
			formatCronFields({
				minutes: Array.from({ length: 60 }, (_value, index) => index),
				hours: [0],
				daysOfMonth: Array.from({ length: 31 }, (_value, index) => index + 1),
				months: Array.from({ length: 12 }, (_value, index) => index + 1),
				daysOfWeek: [1, 2, 3, 4, 5],
			}),
		).toBe("* 0 * * 1-5");
		expect(
			formatCronFields({
				minutes: [0, 15, 30, 45],
				hours: [9],
				daysOfMonth: [1],
				months: [1],
				daysOfWeek: [1],
			}),
		).toBe("*/15 9 1 1 1");
	});

	it("does not invent values for an incomplete step", () => {
		expect(
			formatCronFields({
				minutes: [0, 15, 30],
				hours: [0],
				daysOfMonth: [1],
				months: [1],
				daysOfWeek: [0],
			}),
		).toBe("0,15,30 0 1 1 0");
	});
});

describe("cron draft", () => {
	it("reads modes and round-trips the expression", () => {
		const draft = parseCronDraft("*/15 9 1 * 1-5");
		expect(draft.minutes.mode).toBe("cycle");
		expect(draft.minutes.start).toBe(0);
		expect(draft.minutes.step).toBe(15);
		expect(draft.hours.mode).toBe("specified");
		expect(draft.hours.values).toEqual([9]);
		expect(draft.months.mode).toBe("every");
		expect(draft.daysOfWeek.mode).toBe("range");
		expect(draft.daysOfWeek.start).toBe(1);
		expect(draft.daysOfWeek.end).toBe(5);
		expect(formatCronDraft(draft)).toBe("*/15 9 1 * 1-5");
	});

	it("keeps a weekday name range readable", () => {
		const draft = parseCronDraft("0 9 * * mon-fri");
		expect(draft.daysOfWeek.mode).toBe("range");
		expect(formatCronDraft(draft)).toBe("0 9 * * 1-5");
	});

	it("falls back to specified for a range with a step", () => {
		const draft = parseCronDraft("0-30/5 * * * *");
		expect(draft.minutes.mode).toBe("specified");
		expect(draft.minutes.values).toEqual([0, 5, 10, 15, 20, 25, 30]);
	});
});

describe("specified mode round-trip", () => {
	it("does not collapse a full field back to the wildcard", () => {
		const draft = parseCronDraft("0 * * * 1");
		draft.minutes = { ...draft.minutes, mode: "specified", values: Array.from({ length: 60 }, (_v, i) => i) };
		const expression = formatCronDraft(draft);
		expect(expression.startsWith("0-59 ")).toBe(true);
		expect(parseCronDraft(expression).minutes.mode).toBe("specified");
	});

	it("does not write step syntax that would read back as a cycle", () => {
		const draft = parseCronDraft("0 * * * 1");
		draft.minutes = { ...draft.minutes, mode: "specified", values: [0, 15, 30, 45] };
		const expression = formatCronDraft(draft);
		expect(expression.startsWith("0,15,30,45 ")).toBe(true);
		expect(parseCronDraft(expression).minutes.mode).toBe("specified");
	});

	it("writes a weekday selection as a list, not a range", () => {
		const draft = parseCronDraft("0 * * * 1");
		draft.daysOfWeek = { ...draft.daysOfWeek, mode: "specified", values: [1, 2, 3, 4, 5] };
		const expression = formatCronDraft(draft);
		expect(expression.endsWith("1,2,3,4,5")).toBe(true);
		expect(parseCronDraft(expression).daysOfWeek.mode).toBe("specified");
	});
});
