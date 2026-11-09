/**
 * Loop-hygiene detection for the loop-guard extension.
 *
 * Two failure modes, both "the run is spinning without progress":
 *
 * - A stuttering model. The stream repeats one line, or a short cycle, instead of
 *   continuing; nothing in the runtime notices, so it runs to the token limit and
 *   the repeated text then sits in the context, inviting more of the same.
 *   `StutterDetector` folds the growing text and reports where the repetition
 *   started.
 * - A tool loop: the same call with the same arguments, over and over.
 *   `RepeatChain` counts consecutive identical calls and reports the configured
 *   thresholds.
 *
 * Both are pure: no session, no I/O, so thresholds and canonicalization are
 * testable on their own.
 */

export interface StutterSignal {
	/** Consecutive lines, frequent nonconsecutive lines, or a repeating tail. */
	kind: "lines" | "lines_total" | "cycle";
	/** The repeated text, trimmed for display. */
	preview: string;
	/** How often it had repeated when the signal tripped. */
	count: number;
	/** Offset in the scanned text where the repetition starts, for truncating it. */
	offset: number;
}

export interface StutterOptions {
	/** Consecutive identical non-blank lines that trip the detector. */
	repeatLines: number;
	/**
	 * Occurrences of one content line in the recent window that trip the detector
	 * when it accounts for at least half that window. Formatting-only lines and
	 * code fences do not count here; their consecutive runs are still detected.
	 */
	repeatLinesTotal: number;
	/** Maximum non-blank lines retained for nonconsecutive repetition checks. */
	repeatLineWindow: number;
	/** Length of the tail window scanned for a periodic cycle. */
	cycleWindow: number;
	/** Longest repeating unit treated as a cycle. */
	cycleMaxPeriod: number;
	/** Minimum repetitions of the unit inside the window. */
	cycleMinRepeats: number;
	/** How much new text to accumulate between cycle scans. */
	cycleScanStride: number;
	/** Fraction of a single-line window allowed to differ; multiline cycles must match exactly. */
	cycleTolerance: number;
	/**
	 * Repetitions of one 3-word gram inside the cycle window that trip the
	 * detector. Covers short phrases cycled in no fixed order on a single line,
	 * where neither the line signal nor a strict period can fire.
	 */
	gramMinRepeats: number;
}

export const STUTTER_DEFAULTS: StutterOptions = {
	repeatLines: 6,
	repeatLinesTotal: 12,
	repeatLineWindow: 48,
	cycleWindow: 600,
	cycleMaxPeriod: 50,
	cycleMinRepeats: 12,
	cycleScanStride: 200,
	cycleTolerance: 0.03,
	gramMinRepeats: 10,
};

/**
 * Watches one message's text as it streams.
 *
 * The line signal ignores blank lines: a model that repeats `Kingston.` separated
 * by blank lines is looping just as much as one that repeats it without them.
 */
export class StutterDetector {
	private readonly options: StutterOptions;
	private consumed = 0;
	private lineStart = 0;
	private previousLine: string | null = null;
	private run = 0;
	private runStart = 0;
	private lastCycleScan = 0;
	/** A bounded recent window, rather than counts accumulated across a whole report. */
	private readonly recentLines: { line: string; start: number }[] = [];

	constructor(options: StutterOptions = STUTTER_DEFAULTS) {
		this.options = options;
	}

	/** Forget everything: a new message, or a run that was already interrupted. */
	reset(): void {
		this.consumed = 0;
		this.lineStart = 0;
		this.previousLine = null;
		this.run = 0;
		this.runStart = 0;
		this.lastCycleScan = 0;
		this.recentLines.length = 0;
	}

	/** Fold the text so far and report a repetition the first time one trips. */
	push(text: string): StutterSignal | undefined {
		for (;;) {
			const newline = text.indexOf("\n", this.consumed);
			if (newline === -1) break;
			const start = this.lineStart;
			const line = text.slice(start, newline).trim();
			this.lineStart = newline + 1;
			this.consumed = newline + 1;
			const signal = this.observeLine(line, start) ?? this.observeGrams(text, start, newline);
			if (signal) return signal;
		}
		if (text.length - this.lastCycleScan < this.options.cycleScanStride) return undefined;
		this.lastCycleScan = text.length;
		return this.observeCycle(text) ?? this.observeGrams(text, this.lineStart, text.length);
	}

	private observeLine(line: string, start: number): StutterSignal | undefined {
		// Blank lines are transparent: they separate the repeats in practice without
		// breaking the run.
		if (line.length === 0) return undefined;
		this.recentLines.push({ line, start });
		if (this.recentLines.length > this.options.repeatLineWindow) this.recentLines.shift();
		if (line.length >= 2 && /[\p{L}\p{N}]/u.test(line) && !/^(`{3,}|~{3,})/.test(line)) {
			const matches = this.recentLines.filter((entry) => entry.line === line);
			if (matches.length >= this.options.repeatLinesTotal && matches.length * 2 >= this.recentLines.length) {
				return { kind: "lines_total", preview: line.slice(0, 80), count: matches.length, offset: matches[0].start };
			}
		}
		if (line === this.previousLine) {
			this.run += 1;
		} else {
			this.previousLine = line;
			this.run = 1;
			this.runStart = start;
		}
		// Single-character content breaks a run, but braces and similar lines are
		// too common in normal code to trigger an interruption by themselves.
		if (line.length < 2 || this.run < this.options.repeatLines) return undefined;
		return { kind: "lines", preview: line.slice(0, 80), count: this.run, offset: this.runStart };
	}

	/**
	 * A periodic tail, for repetition that never reaches a newline: `**(c**(c…`, or
	 * the same sentence emitted over and over inside one paragraph.
	 */
	private observeCycle(text: string): StutterSignal | undefined {
		const { cycleWindow, cycleMaxPeriod, cycleMinRepeats, cycleTolerance } = this.options;
		if (text.length < cycleWindow) return undefined;
		const window = text.slice(-cycleWindow);
		// Changing identifiers in otherwise similar rows are progress, not noise.
		const tolerance = window.includes("\n") ? 0 : cycleTolerance;
		for (let period = 1; period <= cycleMaxPeriod; period += 1) {
			if (window.length / period < cycleMinRepeats) break;
			const total = window.length - period;
			const allowed = Math.floor(total * tolerance);
			let mismatches = 0;
			for (let index = period; index < window.length; index += 1) {
				if (window[index] !== window[index - period] && ++mismatches > allowed) break;
			}
			if (mismatches > allowed) continue;
			return {
				kind: "cycle",
				preview: window
					.slice(window.length - period * 3)
					.trim()
					.slice(0, 80),
				count: Math.floor(window.length / period),
				offset: Math.max(0, text.length - period * cycleMinRepeats),
			};
		}
		return undefined;
	}

	/**
	 * Short phrases cycled with no fixed period on one line — `Let me run. Let me
	 * be. Let me do. Let me be. …` — evade both the line signal (no newlines) and
	 * the strict period scan (the order is irregular). Word-gram frequency does
	 * not care about order: a 3-word gram that keeps reappearing in the tail is
	 * the same loop.
	 */
	private observeGrams(text: string, start: number, end: number): StutterSignal | undefined {
		const { cycleWindow, gramMinRepeats } = this.options;
		// A shared phrase in distinct table rows or code examples is not a stalled
		// paragraph. Keep phrase matching within one line, including completed lines.
		const windowStart = Math.max(start, end - cycleWindow);
		const window = text.slice(windowStart, end);
		const tokens = window.split(/\s+/).filter((token) => token.length > 0);
		if (tokens.length < gramMinRepeats + 2) return undefined;
		const grams = new Map<string, number>();
		for (let index = 0; index + 2 < tokens.length; index += 1) {
			const gram = `${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`;
			grams.set(gram, (grams.get(gram) ?? 0) + 1);
		}
		let best: { gram: string; count: number } | undefined;
		for (const [gram, count] of grams) {
			if (!best || count > best.count) best = { gram, count };
		}
		if (!best || best.count < gramMinRepeats) return undefined;
		return {
			kind: "cycle",
			preview: best.gram.slice(0, 80),
			count: best.count,
			offset: windowStart,
		};
	}
}

export interface RepeatThresholdHit {
	/** The run length this call reached. */
	count: number;
	/** Canonical arguments, for quoting in the reminder. */
	canonical: string;
	/** The first configured threshold reads as a nudge, later ones as a report. */
	detailed: boolean;
}

export interface RepeatOptions {
	/** Consecutive-repeat counts that trigger a reminder. */
	thresholds: number[];
	/** Tool-name patterns to track; empty means every tool is tracked. */
	include: string[];
	/** Tool-name patterns transparent to the chain: they neither count nor reset. */
	exclude: string[];
}

export const REPEAT_DEFAULTS: RepeatOptions = { thresholds: [3, 5, 8], include: [], exclude: [] };

/**
 * One consecutive-repeat chain: the last tracked call's identity and its run
 * length. Untracked calls are transparent, so a record-keeping tool in the middle
 * of a loop does not hide it.
 */
export class RepeatChain {
	private readonly include: RegExp[];
	private readonly exclude: RegExp[];
	private readonly thresholds: Set<number>;
	private readonly firstThreshold: number;
	private key: string | null = null;
	private count = 0;

	constructor(options: RepeatOptions = REPEAT_DEFAULTS) {
		this.include = options.include.map(wildcardToRegExp);
		this.exclude = options.exclude.map(wildcardToRegExp);
		const thresholds = [...new Set(options.thresholds)].sort((a, b) => a - b);
		this.thresholds = new Set(thresholds);
		this.firstThreshold = thresholds[0] ?? 3;
	}

	reset(): void {
		this.key = null;
		this.count = 0;
	}

	/** Fold one call and report the threshold it just reached, if any. */
	observe(toolName: string, args: unknown): RepeatThresholdHit | undefined {
		if (!this.tracked(toolName)) return undefined;
		const canonical = canonicalizeArguments(args);
		const key = `${toolName}\u0000${canonical}`;
		this.count = this.key === key ? this.count + 1 : 1;
		this.key = key;
		if (!this.thresholds.has(this.count)) return undefined;
		return { count: this.count, canonical, detailed: this.count !== this.firstThreshold };
	}

	private tracked(toolName: string): boolean {
		if (this.include.length > 0 && !this.include.some((pattern) => pattern.test(toolName))) return false;
		return !this.exclude.some((pattern) => pattern.test(toolName));
	}
}

/**
 * Canonical string form of a call's arguments: deep key-sort, then stringify, so
 * two calls that differ only in property order compare equal. Arguments arrive as
 * parsed JSON, so JSON's value domain is the whole input domain.
 */
export function canonicalizeArguments(value: unknown): string {
	return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJsonValue);
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key]);
		return sorted;
	}
	return value;
}

/** Compile one `*`-wildcard pattern to an anchored RegExp; every other metacharacter is literal. */
export function wildcardToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);
	return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}
