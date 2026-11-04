/**
 * Five-field cron expressions, evaluated in the server's local time zone.
 *
 * The console only needs two questions answered: is this expression valid, and
 * when does it fire next. Both are implemented here rather than by a dependency,
 * because the schedule is a security-relevant trigger and the parser has to be
 * predictable: standard Vixie field syntax, minute granularity, and no hidden
 * timezone.
 *
 * Day-of-month and day-of-week follow the classic rule: when both are
 * restricted, either may match; when one is `*`, the other alone decides.
 */

export interface CronSchedule {
	/** Trimmed source expression, for display. */
	expression: string;
	minutes: number[];
	hours: number[];
	daysOfMonth: number[];
	months: number[];
	daysOfWeek: number[];
	/** True when the field was not exactly `*` (it takes part in the OR rule). */
	domRestricted: boolean;
	dowRestricted: boolean;
}

/** Starting point for the visual builder when the operator has not typed one. */
export const DEFAULT_CRON_EXPRESSION = "0 * * * *";

const MONTH_NAMES: Record<string, number> = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};

const WEEKDAY_NAMES: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
};

function fail(message: string): never {
	throw new Error(message);
}

/** Numeric fields are tiny; a fixed array keeps ordering and lookups simple. */
function parseNumber(token: string, names: Record<string, number> | undefined, min: number, max: number): number {
	const text = token.trim().toLowerCase();
	const named = names?.[text];
	const value = named ?? Number(text);
	if (!Number.isInteger(value)) fail(`无法识别的值：${token}`);
	if (value < min || value > max) fail(`数值超出范围 ${min}-${max}：${token}`);
	return value;
}

/** Expand one comma-separated field into its sorted, unique values. */
function parseField(
	raw: string,
	label: string,
	min: number,
	max: number,
	names?: Record<string, number>,
	/** Sunday may be written as 7 in the day-of-week field. */
	sundayAsSeven = false,
): number[] {
	const values = new Set<number>();
	for (const part of raw.split(",")) {
		const token = part.trim();
		if (!token) fail(`${label}字段里有空项`);
		const slash = token.indexOf("/");
		const base = slash >= 0 ? token.slice(0, slash).trim() : token;
		const stepText = slash >= 0 ? token.slice(slash + 1).trim() : "";
		let step = 1;
		if (slash >= 0) {
			step = Number(stepText);
			if (!Number.isInteger(step) || step <= 0) fail(`${label}字段的步长无效：${stepText}`);
		}
		const limit = sundayAsSeven ? 7 : max;
		const normalize = (value: number): number => (sundayAsSeven && value === 7 ? 0 : value);
		if (base === "*") {
			for (let value = min; value <= max; value += step) values.add(normalize(value));
			continue;
		}
		const range = base.split("-");
		if (range.length > 2) fail(`${label}字段的区间无效：${base}`);
		if (range.length === 1) {
			const start = parseNumber(base, names, min, limit);
			if (slash >= 0) {
				for (let value = start; value <= limit; value += step) values.add(normalize(value));
			} else {
				values.add(normalize(start));
			}
			continue;
		}
		const start = parseNumber(range[0] ?? "", names, min, limit);
		const end = parseNumber(range[1] ?? "", names, min, limit);
		if (start > end) fail(`${label}字段的区间起点大于终点：${base}`);
		for (let value = start; value <= end; value += step) values.add(normalize(value));
	}
	if (values.size === 0) fail(`${label}字段没有匹配值`);
	return [...values].sort((left, right) => left - right);
}

/**
 * Parse and validate a five-field expression. Throws with a message meant for
 * the operator; `validateCronExpression` turns that into a string for forms.
 */
export function parseCronExpression(expression: string): CronSchedule {
	const trimmed = expression.trim();
	if (!trimmed) fail("Cron 表达式不能为空");
	const fields = trimmed.split(/\s+/);
	if (fields.length !== 5) fail("Cron 表达式需要 5 个字段：分 时 日 月 周");
	const [minuteField = "", hourField = "", domField = "", monthField = "", dowField = ""] = fields;
	return {
		expression: trimmed,
		minutes: parseField(minuteField, "分", 0, 59),
		hours: parseField(hourField, "时", 0, 23),
		daysOfMonth: parseField(domField, "日", 1, 31),
		months: parseField(monthField, "月", 1, 12, MONTH_NAMES),
		daysOfWeek: parseField(dowField, "周", 0, 6, WEEKDAY_NAMES, true),
		domRestricted: domField !== "*",
		dowRestricted: dowField !== "*",
	};
}

/** The five fields as the visual builder edits them. */
export interface CronFieldSelection {
	minutes: number[];
	hours: number[];
	daysOfMonth: number[];
	months: number[];
	daysOfWeek: number[];
}

/** Compress one field: wildcard, uniform step, ranges, then single values. */
function formatField(values: number[], min: number, max: number): string {
	const sorted = [...new Set(values)].sort((left, right) => left - right);
	// An empty selection means "every value"; the builder cannot express a cron
	// field with no values, and treating it as wildcard keeps the form usable.
	if (sorted.length === 0 || sorted.length === max - min + 1) return "*";
	const first = sorted[0];
	const step = sorted.length >= 3 ? (sorted[1] ?? 0) - (first ?? 0) : 0;
	if (
		step > 1 &&
		first === min &&
		sorted.every((value, index) => (index === 0 ? value === first : value - (sorted[index - 1] ?? 0) === step)) &&
		(first ?? 0) + sorted.length * step > max
	) {
		return `*/${step}`;
	}
	const parts: string[] = [];
	let start = first;
	let previous = first;
	for (const value of sorted.slice(1)) {
		if (value === previous + 1) {
			previous = value;
			continue;
		}
		parts.push(start === previous ? `${start}` : `${start}-${previous}`);
		start = value;
		previous = value;
	}
	parts.push(start === previous ? `${start}` : `${start}-${previous}`);
	return parts.join(",");
}

/** Turn the visual builder's selections back into a five-field expression. */
export function formatCronFields(fields: CronFieldSelection): string {
	return [
		formatField(fields.minutes, 0, 59),
		formatField(fields.hours, 0, 23),
		formatField(fields.daysOfMonth, 1, 31),
		formatField(fields.months, 1, 12),
		formatField(fields.daysOfWeek, 0, 6),
	].join(" ");
}

/** How one field is edited in the visual builder. */
export type CronFieldMode = "every" | "cycle" | "range" | "specified";

export interface CronFieldDraft {
	mode: CronFieldMode;
	start: number;
	step: number;
	/** Only the weekday field uses a range. */
	end: number;
	/** Current values, kept even in other modes so switching to "specified" starts from them. */
	values: number[];
}

export interface CronDraft {
	minutes: CronFieldDraft;
	hours: CronFieldDraft;
	daysOfMonth: CronFieldDraft;
	months: CronFieldDraft;
	daysOfWeek: CronFieldDraft;
}

function weekdayValue(token: string): number | null {
	const named = WEEKDAY_NAMES[token.toLowerCase()];
	const value = named ?? Number(token);
	return Number.isInteger(value) && value >= 0 && value <= 7 ? (value === 7 ? 0 : value) : null;
}

function cycleDraft(raw: string, min: number): { start: number; step: number } | null {
	const match = /^(\d+|\*)\/(\d+)$/.exec(raw);
	if (!match) return null;
	const start = match[1] === "*" ? min : Number(match[1]);
	const step = Number(match[2]);
	if (!Number.isInteger(start) || !Number.isInteger(step) || step <= 0) return null;
	return { start, step };
}

function fieldDraft(
	raw: string,
	values: number[],
	min: number,
	max: number,
	options: { range?: boolean; cycle?: boolean },
): CronFieldDraft {
	if (raw === "*") return { mode: "every", start: min, step: 1, end: max, values };
	if (options.range) {
		const match = /^([A-Za-z0-9]+)-([A-Za-z0-9]+)$/.exec(raw);
		const start = match ? weekdayValue(match[1] ?? "") : null;
		const end = match ? weekdayValue(match[2] ?? "") : null;
		if (start !== null && end !== null && start <= end) {
			return { mode: "range", start, step: 1, end, values };
		}
	}
	if (options.cycle) {
		const cycle = cycleDraft(raw, min);
		if (cycle && cycle.start >= min && cycle.start <= max) {
			return { mode: "cycle", start: cycle.start, step: cycle.step, end: max, values };
		}
	}
	return { mode: "specified", start: min, step: 1, end: max, values };
}

/** Read a five-field expression into the builder's per-field mode. Throws when invalid. */
export function parseCronDraft(expression: string): CronDraft {
	const schedule = parseCronExpression(expression);
	const fields = expression.trim().split(/\s+/);
	const [minute = "", hour = "", dom = "", month = "", dow = ""] = fields;
	return {
		minutes: fieldDraft(minute, schedule.minutes, 0, 59, { cycle: true }),
		hours: fieldDraft(hour, schedule.hours, 0, 23, { cycle: true }),
		daysOfMonth: fieldDraft(dom, schedule.daysOfMonth, 1, 31, { cycle: true }),
		months: fieldDraft(month, schedule.months, 1, 12, { cycle: true }),
		daysOfWeek: fieldDraft(dow, schedule.daysOfWeek, 0, 6, { range: true }),
	};
}

/** One field's values as a cron fragment, for the specified mode. */
export function formatCronField(values: number[], min: number, max: number): string {
	return formatField(values, min, max);
}

/** Turn the builder state back into a five-field expression. */
export function formatCronDraft(draft: CronDraft): string {
	/**
	 * A specified field must stay specified after a round-trip. The generic
	 * formatter turns a full selection into `*` (which reads back as "every"),
	 * and a contiguous weekday selection into a range (which reads back as
	 * "range"); both would make the "指定" button appear to do nothing.
	 */
	const specified = (values: number[], min: number, max: number, weekday: boolean): string => {
		const unique = [...new Set(values)].sort((left, right) => left - right);
		if (unique.length === 0) {
			return weekday
				? Array.from({ length: max - min + 1 }, (_value, index) => min + index).join(",")
				: `${min}-${max}`;
		}
		if (weekday) return unique.join(",");
		if (unique.length === max - min + 1) return `${min}-${max}`;
		// No step syntax here: `*/15` would read back as cycle mode and make the
		// "specified" choice look like it did not stick.
		const parts: string[] = [];
		let start = unique[0] ?? min;
		let previous = start;
		for (const value of unique.slice(1)) {
			if (value === previous + 1) {
				previous = value;
				continue;
			}
			parts.push(start === previous ? `${start}` : `${start}-${previous}`);
			start = value;
			previous = value;
		}
		parts.push(start === previous ? `${start}` : `${start}-${previous}`);
		return parts.join(",");
	};
	const field = (value: CronFieldDraft, min: number, max: number, weekday = false): string => {
		if (value.mode === "every") return "*";
		if (value.mode === "cycle") return `${value.start === min ? "*" : value.start}/${value.step}`;
		if (value.mode === "range") return `${value.start}-${value.end}`;
		return specified(value.values, min, max, weekday);
	};
	return [
		field(draft.minutes, 0, 59),
		field(draft.hours, 0, 23),
		field(draft.daysOfMonth, 1, 31),
		field(draft.months, 1, 12),
		field(draft.daysOfWeek, 0, 6, true),
	].join(" ");
}

/** The form's inline validator: an error string, or undefined when valid. */
export function validateCronExpression(expression: string): string | undefined {
	try {
		const schedule = parseCronExpression(expression);
		if (nextCronTime(schedule, Date.now()) === null) {
			return "Cron 表达式在未来 8 年内不会触发";
		}
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** Start of the next local day, used to skip a non-matching date. */
function nextDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
}

/**
 * The first firing at or after `afterMs`, strictly later than the minute that
 * contains `afterMs`. Null when the expression can never fire (for example
 * `0 0 31 2 *`).
 */
export function nextCronTime(schedule: CronSchedule, afterMs: number): number | null {
	const start = new Date(Math.floor(afterMs / 60_000) * 60_000 + 60_000);
	let candidate = start;
	// Eight years covers leap-day schedules and every ordinary gap between hits.
	for (let day = 0; day < 366 * 8; day += 1) {
		if (!schedule.months.includes(candidate.getMonth() + 1)) {
			candidate = nextDay(candidate);
			continue;
		}
		const domMatch = schedule.daysOfMonth.includes(candidate.getDate());
		const dowMatch = schedule.daysOfWeek.includes(candidate.getDay());
		const dayMatches =
			schedule.domRestricted && schedule.dowRestricted
				? domMatch || dowMatch
				: schedule.domRestricted
					? domMatch
					: schedule.dowRestricted
						? dowMatch
						: true;
		if (!dayMatches) {
			candidate = nextDay(candidate);
			continue;
		}
		for (const hour of schedule.hours) {
			if (hour < candidate.getHours()) continue;
			for (const minute of schedule.minutes) {
				if (hour === candidate.getHours() && minute < candidate.getMinutes()) continue;
				const result = new Date(candidate);
				result.setHours(hour, minute, 0, 0);
				if (result.getTime() >= candidate.getTime()) return result.getTime();
			}
		}
		candidate = nextDay(candidate);
	}
	return null;
}

/** The next `count` firings after `afterMs`, for the form's preview. */
export function nextCronOccurrences(expression: string, afterMs: number, count = 3): number[] {
	const schedule = parseCronExpression(expression);
	const times: number[] = [];
	let cursor = afterMs;
	for (let index = 0; index < count; index += 1) {
		const next = nextCronTime(schedule, cursor);
		if (next === null) break;
		times.push(next);
		cursor = next;
	}
	return times;
}

/** Whether the expression is valid, for save-time checks that already have a message. */
export function isValidCronExpression(expression: string): boolean {
	return validateCronExpression(expression) === undefined;
}
