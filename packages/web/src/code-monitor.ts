/**
 * Open-source vulnerability watch.
 *
 * A monitor is a repository plus the branches the operator picked. The first
 * check records each branch's HEAD as a baseline; every later check compares
 * that baseline with the new HEAD, stores each unseen commit, and asks the
 * monitor model whether the commit is a security fix. A confirmed fix either
 * waits for the operator or is handed straight to engineering mode, which
 * reproduces it in the project container.
 *
 * Two deliberate choices keep an unattended feature honest:
 *
 * - The baseline only moves past commits that have a stored row. A crash, a
 *   rate limit or a capped batch resumes instead of silently skipping history.
 * - A judgment that fails is stored as `failed`, never guessed. The next check
 *   retries a few of them, and the operator can retry any row by hand.
 */

import {
	GithubApiError,
	GithubClient,
	type GithubCommitDetail,
	type GithubCommitSummary,
	isDependencyOnlyCommit,
	isGithubRateLimit,
	parseGithubRepoUrl,
	renderCommitDiff,
} from "./code-host.ts";
import { judgeCommit } from "./code-monitor-judge.ts";
import {
	type CodeMonitorStore,
	normalizeIntervalMinutes,
	patchKey,
	readCodeMonitorSecrets,
	removeCodeMonitorSecret,
	type StoredCodeMonitor,
	setCodeMonitorSecret,
} from "./code-monitor-store.ts";
import { nextCronTime, parseCronExpression, validateCronExpression } from "./cron.ts";
import { execInContainer } from "./docker.ts";
import { resolveLibraryRole } from "./model-library.ts";
import type {
	SentinelCodeCheckJob,
	SentinelCodeCheckTrigger,
	SentinelCodeCommit,
	SentinelCodeImportState,
	SentinelCodeMonitor,
	SentinelCodeMonitorDetail,
	SentinelCodeMonitorInput,
	SentinelProjectInfo,
} from "./protocol.ts";

/** Scheduler granularity; a monitor's own interval decides when it is due. */
const TICK_MS = 60_000;
/** Commits one check may consume. A busy repository is picked up over several ticks. */
const MAX_COMMITS_PER_CHECK = 20;
/** Failed judgments retried per check, so a model outage recovers on its own. */
const MAX_RETRIES_PER_CHECK = 3;
/** Automatic dispatch below this confidence waits for the operator's click. */
const AUTO_DISPATCH_MIN_CONFIDENCE = 0.65;
const MAX_BRANCHES = 20;

/** Queue bounds: a slow GitHub or model endpoint must not take the whole console. */
const MAX_CONCURRENT_CHECKS = 3;
const MAX_CONCURRENT_PER_HOST = 1;
const MAX_JOB_ATTEMPTS = 3;
const JOB_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];
/** How often queued retries whose nextRunAt has arrived are reconsidered. */
const PUMP_MS = 5_000;

export interface CodeMonitorEngineSource {
	workRoot: string;
	vulnerableDir: string;
	fixedDir: string;
	parentSha: string;
}

export interface CodeMonitorHooks {
	/** A monitor or one of its commits changed; consoles refresh the list. */
	onChange(): void;
	/** The project a monitor belongs to, from the projects file. */
	project(projectId: string): SentinelProjectInfo | undefined;
	/** Start the container if it is not running; false means it cannot run. */
	ensureContainer(project: SentinelProjectInfo): Promise<boolean>;
	/** Create the engineering run for one confirmed finding; returns its id. */
	createEngine(
		monitor: SentinelCodeMonitor,
		commit: SentinelCodeCommit,
		source: CodeMonitorEngineSource,
	): Promise<string>;
	/** Push the finding to the operator's enabled chat channels. */
	notify(monitor: SentinelCodeMonitor, commit: SentinelCodeCommit): void;
	/** Import progress is pushed to every console so a refresh can resume the banner. */
	onImportChange?(state: SentinelCodeImportState | null): void;
	/** Test seam; defaults to the global fetch. */
	fetchImpl?: typeof fetch;
}

export interface CodeCheckResult {
	/** Commits consumed (stored) by this pass. */
	commits: number;
	/** Verdicts that became security findings. */
	findings: number;
	/** Log row written for this pass. */
	checkId: string;
	/** First/joined error that made the pass partial; null when clean. */
	error: string | null;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Branch names reach git through a quoted shell argument, so the check is the
 * ref-name rule rather than a narrow alphabet: no control characters, no
 * revision syntax, no leading dash.
 */
function safeBranch(branch: string): boolean {
	if (!branch || branch.startsWith("-") || branch.includes("..") || branch.includes("@{")) return false;
	if (/[\x00-\x20~^:?*[\\]/.test(branch)) return false;
	return !branch.endsWith(".") && !branch.endsWith("/");
}

function safeSha(sha: string): boolean {
	return /^[0-9a-f]{7,40}$/i.test(sha);
}

function cleanBranches(branches: string[]): string[] {
	const seen = new Set<string>();
	const cleaned: string[] = [];
	for (const raw of branches) {
		const branch = raw.trim();
		if (!branch || seen.has(branch)) continue;
		if (!safeBranch(branch)) throw new Error(`分支名不合法：${branch}`);
		seen.add(branch);
		cleaned.push(branch);
	}
	if (cleaned.length === 0) throw new Error("请至少选择一个监控分支");
	if (cleaned.length > MAX_BRANCHES) throw new Error(`一个监控最多选择 ${MAX_BRANCHES} 个分支`);
	return cleaned;
}

function repoSlug(owner: string, repo: string, monitorId: string): string {
	const base = `${owner}__${repo}__${monitorId.slice(0, 8)}`;
	return base.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface ResolvedSchedule {
	kind: "interval" | "cron";
	intervalMinutes: number;
	cron: string | null;
}

/**
 * Validate the strategy from a create/update/batch payload. On update an omitted
 * kind keeps the stored one; a cron switch requires a valid expression, and an
 * interval switch clears the expression.
 */
function resolveSchedule(
	input: { scheduleKind?: "interval" | "cron"; cronExpression?: string | null; intervalMinutes?: number },
	current?: { scheduleKind: "interval" | "cron"; cronExpression: string | null; intervalMinutes: number },
): ResolvedSchedule {
	const kind = input.scheduleKind ?? (input.cronExpression ? "cron" : (current?.scheduleKind ?? "interval"));
	if (kind === "cron") {
		const expression = (input.cronExpression ?? current?.cronExpression ?? "").trim();
		if (!expression) throw new Error("Cron 表达式不能为空");
		const error = validateCronExpression(expression);
		if (error) throw new Error(error);
		return {
			kind: "cron",
			cron: expression,
			intervalMinutes:
				input.intervalMinutes === undefined
					? (current?.intervalMinutes ?? 60)
					: normalizeIntervalMinutes(input.intervalMinutes),
		};
	}
	return {
		kind: "interval",
		cron: null,
		intervalMinutes: normalizeIntervalMinutes(input.intervalMinutes ?? current?.intervalMinutes ?? 60),
	};
}

/** Whether the scheduler should fire this monitor at `now`. */
function monitorDue(monitor: StoredCodeMonitor, now: number): boolean {
	if (!monitor.enabled) return false;
	if (monitor.scheduleKind === "cron") {
		if (!monitor.cronExpression) return false;
		try {
			const next = nextCronTime(
				parseCronExpression(monitor.cronExpression),
				monitor.lastCheckAt ?? monitor.createdAt,
			);
			return next !== null && next <= now;
		} catch {
			return false;
		}
	}
	if (monitor.intervalMinutes <= 0) return false;
	return (monitor.lastCheckAt ?? 0) + monitor.intervalMinutes * 60_000 <= now;
}

/** For display: when the next check should happen, or null while it is due. */
function nextCheckFor(monitor: StoredCodeMonitor): number | null {
	if (!monitor.enabled) return null;
	if (monitor.scheduleKind === "cron") {
		if (!monitor.cronExpression) return null;
		try {
			return nextCronTime(parseCronExpression(monitor.cronExpression), monitor.lastCheckAt ?? monitor.createdAt);
		} catch {
			return null;
		}
	}
	if (monitor.intervalMinutes <= 0) return null;
	// Never checked yet: the scheduler treats it as due now, so the page says so.
	return monitor.lastCheckAt === null ? Date.now() : monitor.lastCheckAt + monitor.intervalMinutes * 60_000;
}

/**
 * The shell script that prepares both source trees in the project container.
 *
 * It carries no credential: the token is read from stdin by the caller and
 * exported as `ZG_TOKEN`, so the file can sit on disk without a secret and Git
 * receives the header through its environment configuration.
 */
export function buildSourceScript(input: {
	repoUrl: string;
	branch: string;
	sha: string;
	parentSha: string;
	workRoot: string;
}): string {
	return [
		"#!/bin/sh",
		"set -eu",
		`if [ -n "\${ZG_TOKEN:-}" ]; then`,
		"  AUTH=\"Authorization: Basic $(printf 'x-access-token:%s' \"$ZG_TOKEN\" | base64 | tr -d '\\n')\"",
		"  export GIT_CONFIG_COUNT=1",
		"  export GIT_CONFIG_KEY_0=http.extraheader",
		'  export GIT_CONFIG_VALUE_0="$AUTH"',
		"fi",
		`ROOT=${shellQuote(input.workRoot)}`,
		'mkdir -p "$ROOT"',
		'cd "$ROOT"',
		"if [ ! -d src/.git ]; then",
		`\tgit clone ${shellQuote(`${input.repoUrl}.git`)} src`,
		"fi",
		"cd src",
		`git fetch origin ${shellQuote(input.branch)}`,
		`if ! git cat-file -e ${shellQuote(`${input.sha}^{commit}`)} 2>/dev/null; then`,
		`\tgit fetch origin ${shellQuote(input.sha)}`,
		"fi",
		"git worktree remove --force ../vuln >/dev/null 2>&1 || true",
		"git worktree remove --force ../fixed >/dev/null 2>&1 || true",
		"rm -rf ../vuln ../fixed",
		"git worktree prune",
		`git worktree add --detach ../vuln ${shellQuote(input.parentSha)}`,
		`git worktree add --detach ../fixed ${shellQuote(input.sha)}`,
		'printf "vulnerable=%s\\nfixed=%s\\n" "$ROOT/vuln" "$ROOT/fixed"',
		"",
	].join("\n");
}

export class CodeMonitorManager {
	private readonly agentDir: string;
	private readonly store: CodeMonitorStore;
	private readonly hooks: CodeMonitorHooks;
	private timer: ReturnType<typeof setInterval> | undefined;
	private pumpTimer: ReturnType<typeof setInterval> | undefined;
	/** Jobs currently executing; the pump reads this for global/host limits. */
	private readonly runningJobs = new Set<string>();
	private readonly runningByHost = new Map<string, number>();
	/** Host → epoch ms before which no new job may start (429/abuse backoff). */
	private readonly hostCooldownUntil = new Map<string, number>();
	private pumping = false;
	/** Monitors with a check in flight, so a tick cannot stack on a slow API. */
	private readonly checking = new Set<string>();
	/** Server-side sequential import; survives a browser refresh, unlike client state. */
	private importQueue: SentinelCodeMonitorInput[] = [];
	private importState: SentinelCodeImportState | null = null;
	private importProcessing = false;
	/** Commit ids with a dispatch in flight, so a double click cannot make two engines. */
	private readonly dispatching = new Set<string>();
	private ticking = false;

	constructor(agentDir: string, store: CodeMonitorStore, hooks: CodeMonitorHooks) {
		this.agentDir = agentDir;
		this.store = store;
		this.hooks = hooks;
	}

	start(): void {
		if (this.timer) return;
		const now = Date.now();
		// A process that died mid-check leaves a running row; close the log once so
		// the detail page shows an interrupted check, and put the job back in line.
		this.store.failRunningChecks(now, "服务重启，检查中断");
		this.store.requeueRunningJobs(now, "服务重启，重新排队");
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		this.timer.unref?.();
		this.pumpTimer = setInterval(() => void this.pump(), PUMP_MS);
		this.pumpTimer.unref?.();
		void this.pump();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		if (this.pumpTimer) clearInterval(this.pumpTimer);
		this.timer = undefined;
		this.pumpTimer = undefined;
	}

	private token(monitorId: string): string {
		return readCodeMonitorSecrets(this.agentDir)[monitorId] ?? "";
	}

	private view(monitorId: string): SentinelCodeMonitor {
		const stored = this.store.getMonitor(monitorId);
		if (!stored) throw new Error("监控不存在");
		const counts = this.store.counts(monitorId);
		const active = this.store.activeJob(monitorId);
		return {
			...stored,
			tokenSet: Boolean(this.token(monitorId)),
			nextCheckAt: nextCheckFor(stored),
			checkState: active ? (active.status === "running" ? "running" : "queued") : "idle",
			...counts,
		};
	}

	list(): SentinelCodeMonitor[] {
		const secrets = readCodeMonitorSecrets(this.agentDir);
		const active = new Map(
			this.store
				.activeJobs()
				.map((job) => [job.monitorId, job.status === "running" ? "running" : "queued"] as const),
		);
		return this.store.listMonitors().map((monitor) => ({
			...monitor,
			tokenSet: Boolean(secrets[monitor.id]),
			nextCheckAt: nextCheckFor(monitor),
			checkState: active.get(monitor.id) ?? "idle",
		}));
	}

	detail(id: string): SentinelCodeMonitorDetail {
		const monitor = this.view(id);
		return {
			monitor,
			commits: this.store.listCommits(id),
			checks: this.store.listChecks(id),
			jobs: this.store.listJobs(id),
		};
	}

	/** Probe a repository's branches for the multi-select, before or during a save. */
	async branches(input: { url: string; token?: string; apiBaseUrl?: string; monitorId?: string }): Promise<string[]> {
		const ref = parseGithubRepoUrl(input.url, input.apiBaseUrl);
		const token = input.token?.trim() || (input.monitorId ? this.token(input.monitorId) : "");
		const client = new GithubClient(ref, token, this.hooks.fetchImpl);
		return (await client.listBranches()).map((branch) => branch.name);
	}

	/**
	 * Resolve configured branches. A repository that still uses `master` is the
	 * common case behind "Branch not found" during a bulk import, so a missing
	 * `main` falls back to the repository's actual default branch.
	 */
	private async resolveBranches(
		client: GithubClient,
		branches: string[],
		kept: (branch: string) => string | undefined,
		fallbackDefault: boolean,
	): Promise<{ branches: string[]; baselines: Record<string, string> }> {
		const resolved: string[] = [];
		const baselines: Record<string, string> = {};
		for (const branch of branches) {
			try {
				const saved = kept(branch);
				baselines[branch] = saved || (await client.getBranch(branch)).sha;
				if (!resolved.includes(branch)) resolved.push(branch);
			} catch (error) {
				if (fallbackDefault && branch === "main" && error instanceof GithubApiError && error.status === 404) {
					const fallback = (await client.getRepo()).defaultBranch;
					if (fallback && fallback !== "main" && !resolved.includes(fallback)) {
						const saved = kept(fallback);
						baselines[fallback] = saved || (await client.getBranch(fallback)).sha;
						resolved.push(fallback);
						continue;
					}
				}
				throw error;
			}
		}
		return { branches: resolved, baselines };
	}

	async create(input: SentinelCodeMonitorInput): Promise<SentinelCodeMonitor> {
		const project = this.hooks.project(input.projectId);
		if (!project) throw new Error("项目不存在，请重新选择项目");
		const ref = parseGithubRepoUrl(input.url, input.apiBaseUrl);
		const branches = cleanBranches(input.branches);
		const token = input.token?.trim() ?? "";
		if (/\s/.test(token)) throw new Error("访问令牌不能包含空白字符");
		const schedule = resolveSchedule(input);
		const client = new GithubClient(ref, token, this.hooks.fetchImpl);
		const { branches: resolvedBranches, baselines } = await this.resolveBranches(
			client,
			branches,
			() => undefined,
			true,
		);
		const stored = this.store.createMonitor({
			projectId: project.id,
			projectName: project.name,
			name: input.name?.trim() || `${ref.owner}/${ref.repo}`,
			host: ref.host,
			owner: ref.owner,
			repo: ref.repo,
			repoUrl: ref.repoUrl,
			apiBaseUrl: ref.apiBaseUrl,
			branches: resolvedBranches,
			baselines,
			autoDispatch: input.autoDispatch === true,
			intervalMinutes: schedule.intervalMinutes,
			scheduleKind: schedule.kind,
			cronExpression: schedule.cron,
			enabled: input.enabled !== false,
		});
		setCodeMonitorSecret(this.agentDir, stored.id, token);
		this.hooks.onChange();
		return this.view(stored.id);
	}

	async update(id: string, input: SentinelCodeMonitorInput): Promise<SentinelCodeMonitor> {
		const current = this.store.getMonitor(id);
		if (!current) throw new Error("监控不存在");
		const project = this.hooks.project(input.projectId || current.projectId);
		if (!project) throw new Error("项目不存在，请重新选择项目");
		const ref = parseGithubRepoUrl(input.url, input.apiBaseUrl);
		const branches = cleanBranches(input.branches);
		const repoChanged =
			ref.host !== current.host ||
			ref.owner !== current.owner ||
			ref.repo !== current.repo ||
			ref.apiBaseUrl !== current.apiBaseUrl;
		const token = input.token === undefined ? this.token(id) : input.token.trim();
		if (/\s/.test(token)) throw new Error("访问令牌不能包含空白字符");
		const schedule = resolveSchedule(input, current);
		const client = new GithubClient(ref, token, this.hooks.fetchImpl);
		const { branches: resolvedBranches, baselines } = await this.resolveBranches(
			client,
			branches,
			(branch) => (repoChanged ? undefined : current.baselines[branch]),
			true,
		);
		this.store.updateMonitor(id, {
			name: input.name?.trim() || `${ref.owner}/${ref.repo}`,
			host: ref.host,
			owner: ref.owner,
			repo: ref.repo,
			repoUrl: ref.repoUrl,
			apiBaseUrl: ref.apiBaseUrl,
			branches: resolvedBranches,
			baselines,
			autoDispatch: input.autoDispatch === undefined ? current.autoDispatch : input.autoDispatch === true,
			intervalMinutes: schedule.intervalMinutes,
			scheduleKind: schedule.kind,
			cronExpression: schedule.cron,
			enabled: input.enabled === undefined ? current.enabled : input.enabled !== false,
			...(project.id !== current.projectId
				? { projectId: project.id, projectName: project.name }
				: { projectName: project.name }),
		});
		setCodeMonitorSecret(this.agentDir, id, token);
		this.hooks.onChange();
		return this.view(id);
	}

	/** Append repositories to the server-side import queue and start it. */
	importMany(inputs: SentinelCodeMonitorInput[]): void {
		if (inputs.length === 0) return;
		if (!this.importState || !this.importState.running) {
			this.importState = {
				total: inputs.length,
				processed: 0,
				succeeded: 0,
				failed: 0,
				current: null,
				running: true,
				errors: [],
			};
			this.importQueue = [...inputs];
		} else {
			this.importQueue.push(...inputs);
			this.importState.total += inputs.length;
		}
		this.emitImport();
		void this.processImports();
	}

	importView(): SentinelCodeImportState | null {
		return this.importState
			? { ...this.importState, errors: this.importState.errors.map((entry) => ({ ...entry })) }
			: null;
	}

	/** Hide a finished summary; a running import cannot be dismissed. */
	dismissImport(): boolean {
		if (this.importState?.running) return false;
		this.importState = null;
		this.emitImport();
		return true;
	}

	private emitImport(): void {
		this.hooks.onImportChange?.(this.importView());
	}

	private async processImports(): Promise<void> {
		if (this.importProcessing) return;
		this.importProcessing = true;
		try {
			while (this.importQueue.length > 0) {
				const input = this.importQueue.shift();
				const state = this.importState;
				if (!input || !state) break;
				state.current = input.url;
				this.emitImport();
				let retryAfterRateLimit = false;
				try {
					await this.create(input);
					state.succeeded += 1;
				} catch (error) {
					state.failed += 1;
					const message = error instanceof Error ? error.message : String(error);
					if (state.errors.length < 50) state.errors.push({ url: input.url, error: message });
					retryAfterRateLimit = /429|abuse|rate limit|限流/i.test(message);
				}
				state.processed += 1;
				state.current = null;
				this.emitImport();
				if (this.importQueue.length > 0) {
					// A create itself is one API call; the gap prevents a hundred-repo
					// paste from turning into a secondary-limit burst.
					await new Promise((resolve) => setTimeout(resolve, retryAfterRateLimit ? 30_000 : 1_200));
				}
			}
			if (this.importState) {
				this.importState.running = false;
				this.emitImport();
			}
		} finally {
			this.importProcessing = false;
		}
	}

	remove(id: string): void {
		this.removeMany([id]);
	}

	/** Delete several monitors with one broadcast, used by the batch action. */
	removeMany(ids: string[]): number {
		let removed = 0;
		for (const id of new Set(ids)) {
			if (!this.store.getMonitor(id)) continue;
			this.store.deleteMonitor(id);
			removeCodeMonitorSecret(this.agentDir, id);
			removed += 1;
		}
		if (removed > 0) this.hooks.onChange();
		return removed;
	}

	/** Project removal takes its monitors, history and secrets with it. */
	removeByProject(projectId: string): void {
		for (const id of this.store.deleteByProject(projectId)) removeCodeMonitorSecret(this.agentDir, id);
		this.hooks.onChange();
	}

	/** One scheduler pass: enqueue every monitor whose interval elapsed. */
	async tick(now = Date.now()): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			for (const monitor of this.store.listMonitors()) {
				if (!monitorDue(monitor, now)) continue;
				this.enqueue(monitor.id, "auto");
			}
		} finally {
			this.ticking = false;
		}
	}

	/**
	 * Add a check request to the persistent queue. The unique active-job index
	 * means a second click while one is queued or running returns the existing
	 * job instead of stacking another pass.
	 */
	enqueue(id: string, trigger: SentinelCodeCheckTrigger = "manual"): SentinelCodeCheckJob {
		const monitor = this.store.getMonitor(id);
		if (!monitor) throw new Error("监控不存在");
		const job = this.store.enqueueJob({
			monitorId: id,
			projectId: monitor.projectId,
			host: monitor.host,
			trigger,
			now: Date.now(),
			maxAttempts: MAX_JOB_ATTEMPTS,
		});
		this.hooks.onChange();
		void this.pump();
		return job;
	}

	private noteRateLimit(host: string, error: unknown): void {
		if (!isGithubRateLimit(error)) return;
		// Abuse responses often have no Retry-After; five minutes is the shortest
		// wait that reliably clears the detector.
		const until = Date.now() + (error.retryAfterMs ?? 5 * 60_000);
		this.hostCooldownUntil.set(host, Math.max(this.hostCooldownUntil.get(host) ?? 0, until));
	}

	/** Start as many due jobs as the global and per-host limits allow. */
	private async pump(): Promise<void> {
		if (this.pumping) return;
		this.pumping = true;
		try {
			for (;;) {
				if (this.runningJobs.size >= MAX_CONCURRENT_CHECKS) break;
				const due = this.store.dueJobs(Date.now(), 100);
				let launched = false;
				for (const job of due) {
					if (this.runningJobs.size >= MAX_CONCURRENT_CHECKS) break;
					if (this.runningJobs.has(job.id)) continue;
					if ((this.hostCooldownUntil.get(job.host) ?? 0) > Date.now()) continue;
					const onHost = this.runningByHost.get(job.host) ?? 0;
					if (onHost >= MAX_CONCURRENT_PER_HOST) continue;
					const running = this.store.markJobRunning(job.id, Date.now());
					if (!running) continue;
					this.runningJobs.add(running.id);
					this.runningByHost.set(job.host, onHost + 1);
					launched = true;
					void this.runJob(running);
				}
				// The row changes from queued to running before the check finishes.
				if (launched) this.hooks.onChange();
				if (!launched) break;
			}
		} finally {
			this.pumping = false;
		}
	}

	/** Execute one job and translate its outcome into queue state. */
	private async runJob(job: SentinelCodeCheckJob): Promise<void> {
		const monitor = this.store.getMonitor(job.monitorId);
		if (!monitor) {
			this.store.finishJob(job.id, "failed", Date.now(), "监控不存在", null);
			this.releaseJob(job);
			return;
		}
		let result: CodeCheckResult | null = null;
		let error: string | null = null;
		try {
			result = await this.check(job.monitorId, job.trigger);
			error = result.error;
		} catch (caught) {
			this.noteRateLimit(job.host, caught);
			error = errorText(caught);
		}
		const attempts = job.attempts;
		if (error && attempts < job.maxAttempts) {
			const delay =
				JOB_RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), JOB_RETRY_DELAYS_MS.length - 1)] ?? 30_000;
			const cooldown = this.hostCooldownUntil.get(job.host) ?? 0;
			this.store.requeueJob(job.id, Math.max(Date.now() + delay, cooldown), error);
		} else {
			if (!error) this.hostCooldownUntil.delete(job.host);
			this.store.finishJob(job.id, error ? "failed" : "done", Date.now(), error, result?.checkId ?? null);
		}
		this.releaseJob(job);
	}

	private releaseJob(job: SentinelCodeCheckJob): void {
		this.runningJobs.delete(job.id);
		const onHost = this.runningByHost.get(job.host) ?? 0;
		if (onHost <= 1) this.runningByHost.delete(job.host);
		else this.runningByHost.set(job.host, onHost - 1);
		this.hooks.onChange();
		void this.pump();
	}

	/** Check one monitor now. Manual checks run even while the timer is paused. */
	async check(id: string, trigger: SentinelCodeCheckTrigger = "manual"): Promise<CodeCheckResult> {
		const monitor = this.store.getMonitor(id);
		if (!monitor) throw new Error("监控不存在");
		if (this.checking.has(id)) return { commits: 0, findings: 0, checkId: "", error: null };
		this.checking.add(id);
		let checkId: string;
		try {
			checkId = this.store.startCheck(id, monitor.projectId, trigger, Date.now());
		} catch (error) {
			this.checking.delete(id);
			throw error;
		}
		const result: CodeCheckResult = { commits: 0, findings: 0, checkId, error: null };
		let finished = false;
		const finish = (status: "ok" | "error", error: string | null): void => {
			if (finished) return;
			finished = true;
			this.store.finishCheck(checkId, {
				status,
				commits: result.commits,
				findings: result.findings,
				error,
				endedAt: Date.now(),
			});
		};
		const token = this.token(id);
		const client = new GithubClient(
			{
				host: monitor.host,
				apiBaseUrl: monitor.apiBaseUrl,
				owner: monitor.owner,
				repo: monitor.repo,
				repoUrl: monitor.repoUrl,
			},
			token,
			this.hooks.fetchImpl,
			// An unauthenticated client has a tiny hourly quota; slow it down and
			// consume fewer commits per pass.
			{ minRequestIntervalMs: token ? 500 : 1_500 },
		);
		const commitCap = token ? MAX_COMMITS_PER_CHECK : 5;
		const baselines = { ...monitor.baselines };
		let lastError: string | null = null;
		const rememberError = (error: unknown): void => {
			const text = errorText(error);
			const next = lastError ? `${lastError}；${text}` : text;
			lastError = next.length > 4_000 ? next.slice(-4_000) : next;
		};
		try {
			// Take the retry list before this pass judges anything: a model outage in
			// this check must not make every fresh failure retry itself immediately.
			const retryRows = this.store.failedCommits(id, MAX_RETRIES_PER_CHECK);
			for (const branch of monitor.branches) {
				try {
					const head = await client.getBranch(branch);
					const base = baselines[branch];
					if (!base) {
						baselines[branch] = head.sha;
						continue;
					}
					if (base === head.sha) continue;
					let commits: GithubCommitSummary[] = [];
					let resynced = false;
					try {
						const compare = await client.compare(base, head.sha);
						commits = compare.commits;
						// A rewritten branch leaves no path from the old baseline. Fall back
						// to the recent window, with an hour of overlap for clock skew.
						if (compare.status === "diverged" || commits.length === 0) {
							resynced = true;
							const since = monitor.lastCheckAt ? monitor.lastCheckAt - 3_600_000 : undefined;
							commits = await client.listCommits(branch, since);
						}
					} catch (error) {
						if (!(error instanceof GithubApiError) || error.status !== 404) throw error;
						resynced = true;
						const since = monitor.lastCheckAt ? monitor.lastCheckAt - 3_600_000 : undefined;
						commits = await client.listCommits(branch, since);
					}
					const batch = commits.slice(0, commitCap);
					for (const commit of batch) {
						const consumed = await this.consume(monitor.id, branch, commit, client);
						if (consumed) {
							result.commits += 1;
							if (consumed === "security") result.findings += 1;
						}
						baselines[branch] = commit.sha;
					}
					if (batch.length < commits.length) {
						// Capped: keep the baseline at the last consumed commit so the next
						// tick continues from there.
					} else if (!resynced || batch.length === 0) {
						baselines[branch] = head.sha;
					}
				} catch (error) {
					this.noteRateLimit(monitor.host, error);
					rememberError(`${branch}: ${errorText(error)}`);
				}
			}
			// Failed judgments are retried after the branch pass, so a model outage
			// does not need an operator to touch every row.
			for (const failed of retryRows) {
				const retried = await this.retry(monitor.id, failed).catch((error: unknown) => {
					this.noteRateLimit(monitor.host, error);
					rememberError(error);
					return null;
				});
				if (retried) result.commits += 1;
				if (retried === "security") result.findings += 1;
			}
			this.store.setBaselines(id, baselines);
			this.store.markChecked(id, Date.now(), lastError);
			finish(lastError ? "error" : "ok", lastError);
			result.error = lastError;
			return result;
		} catch (error) {
			rememberError(error);
			finish("error", lastError);
			result.error = lastError;
			throw error;
		} finally {
			this.checking.delete(id);
			this.hooks.onChange();
		}
	}

	/** Store and judge one commit. Returns whether it was new work. */
	private async consume(
		monitorId: string,
		branch: string,
		summary: GithubCommitSummary,
		client: GithubClient,
	): Promise<"security" | "not_security" | "failed" | null> {
		const existing = this.store.findCommit(monitorId, summary.sha);
		if (existing && existing.verdict !== "pending" && existing.verdict !== "failed") return null;
		const monitor = this.store.getMonitor(monitorId);
		if (!monitor) throw new Error("监控不存在");
		const detail = await client.getCommit(summary.sha);
		if (!existing) {
			const diff = renderCommitDiff(detail);
			this.store.insertCommit({
				monitorId,
				projectId: monitor.projectId,
				branch,
				sha: detail.sha,
				shortSha: detail.sha.slice(0, 8),
				title: detail.message.split("\n")[0]?.trim() || detail.sha.slice(0, 8),
				message: detail.message,
				author: detail.author,
				authoredAt: detail.authoredAt,
				url: detail.url,
				additions: detail.additions,
				deletions: detail.deletions,
				files: detail.files.length,
				diff,
			});
		}
		const row = this.store.findCommit(monitorId, summary.sha);
		if (!row) return null;
		return this.judge(monitor, row, detail);
	}

	/** Re-run one stored verdict, used by the sweep and by the operator's retry. */
	async rejudge(commitId: string): Promise<SentinelCodeMonitorDetail> {
		const row = this.store.getCommit(commitId);
		if (!row) throw new Error("提交记录不存在");
		const monitor = this.store.getMonitor(row.monitorId);
		if (!monitor) throw new Error("监控不存在");
		const client = new GithubClient(
			{
				host: monitor.host,
				apiBaseUrl: monitor.apiBaseUrl,
				owner: monitor.owner,
				repo: monitor.repo,
				repoUrl: monitor.repoUrl,
			},
			this.token(row.monitorId),
			this.hooks.fetchImpl,
		);
		const detail = await client.getCommit(row.sha);
		this.store.setVerdict(row.id, {
			verdict: "pending",
			confidence: null,
			cve: null,
			severity: null,
			vulnType: null,
			reason: null,
			judgedAt: null,
		});
		await this.judge(monitor, row, detail);
		this.hooks.onChange();
		return this.detail(row.monitorId);
	}

	private async retry(
		monitorId: string,
		row: SentinelCodeCommit,
	): Promise<"security" | "not_security" | "failed" | null> {
		const monitor = this.store.getMonitor(monitorId);
		if (!monitor) return null;
		const client = new GithubClient(
			{
				host: monitor.host,
				apiBaseUrl: monitor.apiBaseUrl,
				owner: monitor.owner,
				repo: monitor.repo,
				repoUrl: monitor.repoUrl,
			},
			this.token(monitorId),
			this.hooks.fetchImpl,
		);
		const detail = await client.getCommit(row.sha);
		const verdict = await this.judge(monitor, row, detail);
		return verdict;
	}

	private async judge(
		monitor: StoredCodeMonitor,
		row: SentinelCodeCommit,
		detail: GithubCommitDetail,
	): Promise<"security" | "not_security" | "failed" | null> {
		if (detail.parents > 1) {
			this.store.setVerdict(row.id, {
				verdict: "not_security",
				confidence: 1,
				cve: null,
				severity: null,
				vulnType: null,
				reason: "合并提交，改动由分支上的单个提交承载",
				judgedAt: Date.now(),
			});
			return "not_security";
		}
		if (detail.files.length === 0) {
			this.store.setVerdict(row.id, {
				verdict: "not_security",
				confidence: 1,
				cve: null,
				severity: null,
				vulnType: null,
				reason: "没有文件差异",
				judgedAt: Date.now(),
			});
			return "not_security";
		}
		if (isDependencyOnlyCommit(detail)) {
			this.store.setVerdict(row.id, {
				verdict: "not_security",
				confidence: 1,
				cve: null,
				severity: null,
				vulnType: null,
				reason: "纯依赖升级，跳过",
				judgedAt: Date.now(),
			});
			return "not_security";
		}
		const config = resolveLibraryRole(this.agentDir, "monitor")?.config ?? null;
		if (!config) {
			this.store.setVerdict(row.id, {
				verdict: "failed",
				confidence: null,
				cve: null,
				severity: null,
				vulnType: null,
				reason: "未配置监测模型（设置 → 模型 → 监测模型）",
				judgedAt: Date.now(),
			});
			return "failed";
		}
		const diff = row.diff ?? renderCommitDiff(detail);
		try {
			const verdict = await judgeCommit(config, monitor, detail, diff, this.hooks.fetchImpl);
			if (!verdict.security) {
				this.store.setVerdict(row.id, {
					verdict: "not_security",
					confidence: verdict.confidence,
					cve: null,
					severity: null,
					vulnType: null,
					reason: verdict.reason,
					judgedAt: Date.now(),
				});
				return "not_security";
			}
			this.store.setVerdict(row.id, {
				verdict: "security",
				confidence: verdict.confidence,
				cve: verdict.cve,
				severity: verdict.severity,
				vulnType: verdict.vulnType,
				reason: verdict.reason,
				judgedAt: Date.now(),
			});
			const updated = this.store.getCommit(row.id);
			if (!updated) return null;
			const key = patchKey(updated.diff);
			const duplicate = verdict.cve
				? this.store.findSecurityByCve(monitor.id, verdict.cve, row.id)
				: key
					? this.store.findSecurityByPatch(monitor.id, key, row.id)
					: null;
			if (duplicate) {
				this.store.setDuplicateOf(row.id, duplicate.id);
				return "security";
			}
			try {
				this.hooks.notify(this.view(monitor.id), updated);
			} catch {
				// A chat robot that rejects a message must not undo the verdict.
			}
			if (monitor.autoDispatch && verdict.confidence >= AUTO_DISPATCH_MIN_CONFIDENCE) {
				// Off the polling path: preparing sources can take minutes, and the
				// next monitor in the tick must not wait for this clone.
				void this.dispatch(row.id).catch((error: unknown) => {
					this.store.setStatus(row.id, "new", null, errorText(error));
					this.hooks.onChange();
				});
			}
			return "security";
		} catch (error) {
			this.store.setVerdict(row.id, {
				verdict: "failed",
				confidence: null,
				cve: null,
				severity: null,
				vulnType: null,
				reason: errorText(error),
				judgedAt: Date.now(),
			});
			return "failed";
		}
	}

	/** Hand one finding to engineering mode, preparing the container source trees first. */
	async dispatch(commitId: string): Promise<string> {
		if (this.dispatching.has(commitId)) throw new Error("该发现正在下发，请稍候");
		this.dispatching.add(commitId);
		try {
			return await this.dispatchUnlocked(commitId);
		} finally {
			this.dispatching.delete(commitId);
		}
	}

	private async dispatchUnlocked(commitId: string): Promise<string> {
		const row = this.store.getCommit(commitId);
		if (!row) throw new Error("提交记录不存在");
		if (row.verdict !== "security") throw new Error("只有判定为安全更新的提交才能复现");
		if (row.engineId) return row.engineId;
		if (row.duplicateOf) throw new Error("该提交与已有发现重复，已跳过");
		if (row.status === "ignored") throw new Error("该提交已被忽略");
		const monitor = this.store.getMonitor(row.monitorId);
		if (!monitor) throw new Error("监控不存在");
		if (!row.diff) throw new Error("缺少 diff，无法准备复现环境");
		const project = this.hooks.project(monitor.projectId);
		if (!project) throw new Error("监控所属项目不存在");
		if (!(await this.hooks.ensureContainer(project))) {
			throw new Error("项目容器未运行，请先在项目页启动容器");
		}
		const detail = await this.detailForDispatch(monitor.id, row);
		if (!detail.parentSha || !safeSha(detail.parentSha)) {
			throw new Error("该提交没有可用的父提交，无法确定漏洞版本");
		}
		const source = await this.prepareRepository(monitor, row, project, detail.parentSha);
		const engineId = await this.hooks.createEngine(this.view(monitor.id), row, source);
		this.store.setStatus(row.id, "dispatched", engineId, null);
		this.hooks.onChange();
		return engineId;
	}

	private async detailForDispatch(monitorId: string, row: SentinelCodeCommit): Promise<GithubCommitDetail> {
		const monitor = this.store.getMonitor(monitorId);
		if (!monitor) throw new Error("监控不存在");
		const client = new GithubClient(
			{
				host: monitor.host,
				apiBaseUrl: monitor.apiBaseUrl,
				owner: monitor.owner,
				repo: monitor.repo,
				repoUrl: monitor.repoUrl,
			},
			this.token(monitorId),
			this.hooks.fetchImpl,
		);
		return client.getCommit(row.sha);
	}

	/**
	 * Write the container helper script. The token stays in a 0700 script under
	 * /root, and git is given an explicit `http.extraheader` rather than a URL
	 * with credentials in it, so the clone's own config carries no secret.
	 */
	private async prepareRepository(
		monitor: StoredCodeMonitor,
		row: SentinelCodeCommit,
		project: SentinelProjectInfo,
		parentSha: string,
	): Promise<CodeMonitorEngineSource> {
		const container = project.container;
		if (!container) throw new Error("项目没有可用容器");
		if (!safeSha(row.sha)) throw new Error("提交 SHA 不合法");
		const slug = repoSlug(monitor.owner, monitor.repo, monitor.id);
		const workRoot = `/work/opensource/${slug}`;
		const scriptPath = `/root/.sentinel/oss/${monitor.id}.sh`;
		const token = this.token(monitor.id);
		const script = buildSourceScript({
			repoUrl: monitor.repoUrl,
			branch: row.branch,
			sha: row.sha,
			parentSha,
			workRoot,
		});
		const written = await execInContainer(
			container,
			'umask 077; mkdir -p /root/.sentinel/oss; cat > "$1"; chmod 700 "$1"',
			[scriptPath],
			{ stdin: Buffer.from(script, "utf-8"), timeoutMs: 15_000 },
		);
		if (written.code !== 0) {
			throw new Error(`写入复现辅助脚本失败：${written.stderr.trim() || `退出码 ${written.code}`}`);
		}
		try {
			// Feed the token on stdin, not into the script: the file carries no
			// secret, and the clone gets the header from Git's environment config.
			const prepared = await execInContainer(
				container,
				'IFS= read -r ZG_TOKEN || ZG_TOKEN=""; export ZG_TOKEN; sh "$1"',
				[scriptPath],
				{ stdin: Buffer.from(`${token}\n`, "utf-8"), timeoutMs: 20 * 60_000 },
			);
			if (prepared.code !== 0) {
				const detail = (prepared.stderr || prepared.stdout).trim().slice(-1500);
				throw new Error(`源码准备失败：${detail || `退出码 ${prepared.code}`}`);
			}
		} finally {
			await execInContainer(container, 'rm -f "$1"', [scriptPath], { timeoutMs: 15_000 }).catch(() => {
				// A leftover file is 0700 in the container; removing it is best effort.
			});
		}
		return {
			workRoot,
			vulnerableDir: `${workRoot}/vuln`,
			fixedDir: `${workRoot}/fixed`,
			parentSha,
		};
	}

	/** Batch-apply one schedule to several monitors; returns how many were updated. */
	async setSchedule(
		ids: string[],
		input: { scheduleKind: "interval" | "cron"; intervalMinutes?: number; cronExpression?: string | null },
	): Promise<number> {
		const unique = [...new Set(ids)].filter(Boolean);
		if (unique.length === 0) throw new Error("请选择要修改的监控");
		const cron = input.scheduleKind === "cron" ? (input.cronExpression ?? "").trim() : null;
		if (input.scheduleKind === "cron") {
			if (!cron) throw new Error("Cron 表达式不能为空");
			const error = validateCronExpression(cron);
			if (error) throw new Error(error);
		}
		let updated = 0;
		for (const id of unique) {
			const current = this.store.getMonitor(id);
			if (!current) continue;
			this.store.updateMonitor(id, {
				...(input.scheduleKind === "cron"
					? { scheduleKind: "cron" as const, cronExpression: cron }
					: {
							scheduleKind: "interval" as const,
							cronExpression: null,
							intervalMinutes: normalizeIntervalMinutes(input.intervalMinutes ?? current.intervalMinutes),
						}),
			});
			updated += 1;
		}
		this.hooks.onChange();
		return updated;
	}

	/** Which monitor a commit belongs to, for a post-dispatch detail refresh. */
	monitorIdForCommit(commitId: string): string | null {
		return this.store.getCommit(commitId)?.monitorId ?? null;
	}

	ignore(commitId: string): SentinelCodeMonitorDetail {
		const row = this.store.getCommit(commitId);
		if (!row) throw new Error("提交记录不存在");
		if (row.engineId) throw new Error("该发现已经进入工程，不能忽略");
		this.store.setStatus(row.id, "ignored", null, null);
		this.hooks.onChange();
		return this.detail(row.monitorId);
	}
}
