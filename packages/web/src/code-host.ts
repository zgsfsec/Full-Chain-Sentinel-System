/**
 * GitHub REST client for the open-source watch.
 *
 * The watch deliberately does not clone anything: polling, branch heads,
 * comparisons and per-commit diffs all come from the API, which is the one
 * interface github.com and GitHub Enterprise share. A private repository is the
 * same code path with a token attached; the token never reaches the browser.
 *
 * Only the endpoints the feature needs are modeled, and every response is
 * normalized here so the rest of the server never sees GitHub's JSON shapes.
 */

const USER_AGENT = "full-chain-sentinel";
const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 30_000;
/** Minimum gap between two REST calls from one check, to avoid burst detection. */
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 500;
const BRANCH_PAGE_SIZE = 100;
const MAX_BRANCH_PAGES = 5;
const COMMIT_PAGE_SIZE = 100;

/** A repository URL resolved to the pieces the REST API needs. */
export interface GithubRepoRef {
	/** Host only, e.g. `github.com` or `ghe.example.com`. */
	host: string;
	/** REST base without a trailing slash. */
	apiBaseUrl: string;
	owner: string;
	repo: string;
	/** Canonical HTTPS clone/browse URL. */
	repoUrl: string;
}

export interface GithubBranch {
	name: string;
	sha: string;
}

export interface GithubCommitSummary {
	sha: string;
	message: string;
	author: string;
	/** Epoch milliseconds of the commit's author date. */
	authoredAt: number;
	url: string;
	parents: number;
	/** First parent, the vulnerable revision a fix commit starts from. */
	parentSha: string | null;
}

export interface GithubFileChange {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	patch?: string;
}

export interface GithubCommitDetail extends GithubCommitSummary {
	additions: number;
	deletions: number;
	files: GithubFileChange[];
}

export interface GithubCompare {
	/** `identical` means the base already contains everything on the head. */
	status: "ahead" | "behind" | "diverged" | "identical";
	/** Oldest first, which is the order a poll consumes them in. */
	commits: GithubCommitSummary[];
}

/** An API failure with enough detail for a useful page error. */
export class GithubApiError extends Error {
	readonly status: number;
	/** Remaining requests in the current window, when the response said so. */
	readonly rateLimitRemaining: number | null;
	/** When that window resets, in epoch milliseconds, when known. */
	readonly rateLimitReset: number | null;
	/** Server-requested wait after a 429/abuse response, when it said so. */
	readonly retryAfterMs: number | null;

	constructor(
		message: string,
		status: number,
		remaining: number | null,
		reset: number | null,
		retryAfterMs: number | null = null,
	) {
		super(message);
		this.name = "GithubApiError";
		this.status = status;
		this.rateLimitRemaining = remaining;
		this.rateLimitReset = reset;
		this.retryAfterMs = retryAfterMs;
	}
}

/** Whether an API failure is GitHub's rate/abuse limit rather than a real error. */
export function isGithubRateLimit(error: unknown): error is GithubApiError {
	if (!(error instanceof GithubApiError)) return false;
	return error.status === 429 || /abuse|rate limit|too many requests/i.test(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Validate the API override and strip a trailing slash. */
export function normalizeApiBase(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error("API Base URL 无法解析");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("API Base URL 只支持 http / https");
	}
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** The REST base a GitHub host uses when the operator did not override it. */
export function defaultApiBase(host: string, scheme: string): string {
	if (host.toLowerCase() === "github.com") return "https://api.github.com";
	return `${scheme}://${host}/api/v3`;
}

/**
 * Parse an HTTPS, SSH or bare `host/owner/repo` address.
 *
 * The host is not restricted to github.com: GitHub Enterprise serves the same
 * REST API under `/api/v3`, and the operator can override the base entirely.
 */
export function parseGithubRepoUrl(raw: string, apiBaseUrl?: string): GithubRepoRef {
	const input = raw.trim();
	if (!input) throw new Error("Git 地址不能为空");
	let host = "";
	let path = "";
	let scheme = "https";

	const scp = /^(?:[A-Za-z0-9._-]+@)?([^:/\s]+):(.+)$/.exec(input);
	(() => {
		if (scp && !input.includes("://")) {
			host = scp[1] ?? "";
			path = scp[2] ?? "";
			scheme = "https";
			return;
		}
		let url: URL;
		const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
		try {
			url = new URL(withScheme);
		} catch {
			throw new Error("Git 地址无法解析");
		}
		if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:") {
			throw new Error("只支持 https / http / ssh 形式的地址");
		}
		if (url.password) throw new Error("地址里不能带密码，请用访问令牌");
		host = url.hostname;
		path = url.pathname;
		// SSH is only used to name the repository; the REST API is HTTPS.
		scheme = url.protocol === "http:" ? "http" : "https";
	})();

	const segments = path.replace(/^\/+/, "").replace(/\/+$/, "").split("/").filter(Boolean);
	if (segments.length < 2) throw new Error("地址里要包含 owner/repo");
	const owner = segments[0] ?? "";
	const repo = (segments[1] ?? "").replace(/\.git$/i, "");
	if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
		throw new Error("owner 或 repo 名不合法");
	}
	if (!host) throw new Error("地址里没有主机名");

	const override = apiBaseUrl?.trim() ? normalizeApiBase(apiBaseUrl) : "";
	return {
		host,
		apiBaseUrl: override || defaultApiBase(host, scheme),
		owner,
		repo,
		repoUrl: `${scheme}://${host}/${owner}/${repo}`,
	};
}

/** Encode one path segment for the API URL. */
function segment(value: string): string {
	return encodeURIComponent(value);
}

/** A GitHub REST client bound to one repository and one optional token. */
export class GithubClient {
	readonly ref: GithubRepoRef;
	private readonly token: string;
	private readonly fetchImpl: typeof fetch;

	private readonly minRequestIntervalMs: number;
	private lastRequestAt = 0;

	constructor(
		ref: GithubRepoRef,
		token: string,
		fetchImpl: typeof fetch = fetch,
		options: { minRequestIntervalMs?: number } = {},
	) {
		this.ref = ref;
		this.token = token.trim();
		this.fetchImpl = fetchImpl;
		this.minRequestIntervalMs = options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS;
	}

	private url(path: string, query?: Record<string, string>): string {
		const url = new URL(`${this.ref.apiBaseUrl}/repos/${segment(this.ref.owner)}/${segment(this.ref.repo)}${path}`);
		for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
		return url.toString();
	}

	private async request<T>(path: string, query?: Record<string, string>): Promise<T> {
		const wait = this.minRequestIntervalMs - (Date.now() - this.lastRequestAt);
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		this.lastRequestAt = Date.now();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await this.fetchImpl(this.url(path, query), {
				headers: {
					accept: "application/vnd.github+json",
					"x-github-api-version": API_VERSION,
					"user-agent": USER_AGENT,
					...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
				},
				signal: controller.signal,
			});
			const remaining = response.headers.get("x-ratelimit-remaining");
			const reset = response.headers.get("x-ratelimit-reset");
			if (!response.ok) {
				const body = (await response.text().catch(() => "")).slice(0, 300);
				const limited =
					response.status === 429 || (response.status === 403 && /abuse|rate limit|too many requests/i.test(body));
				const retryAfter = response.headers.get("retry-after");
				const retryAfterMs = retryAfter
					? Number(retryAfter) * 1000
					: reset
						? Number(reset) * 1000 - Date.now()
						: null;
				const reason = limited
					? "GitHub API 触发限流（429/abuse）。请稍后重试；建议为监控配置访问令牌，并避免同时检查同一主机的多个仓库"
					: response.status === 401 || response.status === 403
						? this.token
							? "访问被拒绝，请检查令牌权限（私有仓库需要 Contents 读权限）"
							: "访问被拒绝，私有仓库需要访问令牌"
						: response.status === 404
							? "仓库或分支不存在，或令牌无权访问"
							: `GitHub API 返回 ${response.status}`;
				throw new GithubApiError(
					body ? `${reason}：${body}` : reason,
					response.status,
					remaining === null ? null : Number(remaining),
					reset === null ? null : Number(reset) * 1000,
					retryAfterMs !== null && Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : null,
				);
			}
			return (await response.json()) as T;
		} catch (error) {
			if (error instanceof GithubApiError) throw error;
			if (error instanceof Error && error.name === "AbortError") throw new Error("GitHub API 请求超时");
			throw new Error(`GitHub API 请求失败：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			clearTimeout(timer);
		}
	}

	async listBranches(): Promise<GithubBranch[]> {
		const branches: GithubBranch[] = [];
		for (let page = 1; page <= MAX_BRANCH_PAGES; page += 1) {
			const data = await this.request<unknown[]>(`/branches`, {
				per_page: String(BRANCH_PAGE_SIZE),
				page: String(page),
			});
			if (!Array.isArray(data)) break;
			for (const raw of data) {
				if (!isRecord(raw)) continue;
				const name = text(raw.name);
				const commit = isRecord(raw.commit) ? raw.commit : {};
				const sha = text(commit.sha);
				if (name && sha) branches.push({ name, sha });
			}
			if (data.length < BRANCH_PAGE_SIZE) break;
		}
		return branches.sort((left, right) => left.name.localeCompare(right.name));
	}

	/** Repository metadata; used to recover when the default branch is not `main`. */
	async getRepo(): Promise<{ defaultBranch: string }> {
		const raw = await this.request<unknown>("");
		const record = isRecord(raw) ? raw : {};
		return { defaultBranch: text(record.default_branch) || "main" };
	}

	async getBranch(name: string): Promise<GithubBranch> {
		const raw = await this.request<unknown>(`/branches/${segment(name)}`);
		const record = isRecord(raw) ? raw : {};
		const commit = isRecord(record.commit) ? record.commit : {};
		const sha = text(commit.sha);
		if (!sha) throw new Error(`分支 ${name} 没有返回提交`);
		return { name: text(record.name) || name, sha };
	}

	/** Commits on one branch, newest first as GitHub returns them. */
	async listCommits(branch: string, sinceMs?: number): Promise<GithubCommitSummary[]> {
		const query: Record<string, string> = { sha: branch, per_page: String(COMMIT_PAGE_SIZE) };
		if (sinceMs && sinceMs > 0) query.since = new Date(sinceMs).toISOString();
		const data = await this.request<unknown[]>(`/commits`, query);
		if (!Array.isArray(data)) return [];
		return data
			.map((raw) => toCommitSummary(raw))
			.filter((commit): commit is GithubCommitSummary => commit !== null)
			.sort((left, right) => left.authoredAt - right.authoredAt);
	}

	async compare(baseSha: string, headSha: string): Promise<GithubCompare> {
		const raw = await this.request<unknown>(`/compare/${segment(baseSha)}...${segment(headSha)}`);
		const record = isRecord(raw) ? raw : {};
		const status = text(record.status);
		const normalizedStatus: GithubCompare["status"] =
			status === "ahead" || status === "behind" || status === "diverged" || status === "identical"
				? status
				: "diverged";
		const commits = Array.isArray(record.commits)
			? record.commits
					.map((entry) => toCommitSummary(entry))
					.filter((commit): commit is GithubCommitSummary => commit !== null)
					.sort((left, right) => left.authoredAt - right.authoredAt)
			: [];
		return { status: normalizedStatus, commits };
	}

	async getCommit(sha: string): Promise<GithubCommitDetail> {
		const raw = await this.request<unknown>(`/commits/${segment(sha)}`);
		const summary = toCommitSummary(raw);
		if (!summary) throw new Error(`提交 ${sha} 没有返回内容`);
		const record = isRecord(raw) ? raw : {};
		const stats = isRecord(record.stats) ? record.stats : {};
		const files: GithubFileChange[] = Array.isArray(record.files)
			? record.files
					.filter((entry): entry is Record<string, unknown> => isRecord(entry))
					.map((entry) => {
						const change: GithubFileChange = {
							filename: text(entry.filename),
							status: text(entry.status) || "modified",
							additions: number(entry.additions),
							deletions: number(entry.deletions),
						};
						const patch = text(entry.patch);
						if (patch) change.patch = patch;
						return change;
					})
					.filter((file) => file.filename)
			: [];
		return {
			...summary,
			additions: number(stats.additions),
			deletions: number(stats.deletions),
			files,
		};
	}
}

function toCommitSummary(raw: unknown): GithubCommitSummary | null {
	if (!isRecord(raw)) return null;
	const sha = text(raw.sha);
	if (!sha) return null;
	const commit = isRecord(raw.commit) ? raw.commit : {};
	const author = isRecord(commit.author) ? commit.author : {};
	const date = text(author.date);
	const authoredAt = date ? Date.parse(date) : Number.NaN;
	return {
		sha,
		message: text(commit.message),
		author: text(author.name) || text(author.email) || "unknown",
		authoredAt: Number.isFinite(authoredAt) ? authoredAt : Date.now(),
		url: text(raw.html_url),
		parents: Array.isArray(raw.parents) ? raw.parents.length : 0,
		parentSha: Array.isArray(raw.parents) && isRecord(raw.parents[0]) ? text(raw.parents[0].sha) || null : null,
	};
}

/**
 * A bounded, model-readable diff. File headers and stats are always kept; the
 * per-file patch is cut so one huge generated file cannot crowd out the rest.
 * When the total is exceeded the remainder is listed by name only, because the
 * judge should know what it did not see.
 */
export function renderCommitDiff(detail: GithubCommitDetail, limit = 40_000, perFile = 6_000): string {
	const lines: string[] = [];
	let used = 0;
	let omitted = 0;
	for (const file of detail.files) {
		const header = `### ${file.filename} (${file.status}, +${file.additions} -${file.deletions})`;
		const patch = file.patch ? `${header}\n${clip(file.patch, perFile)}` : `${header}\n(二进制或无文本差异)`;
		if (used + patch.length > limit) {
			omitted += 1;
			continue;
		}
		lines.push(patch);
		used += patch.length;
	}
	if (omitted > 0) lines.push(`（另有 ${omitted} 个文件的 diff 因长度限制未展示）`);
	return lines.join("\n\n");
}

function clip(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}\n…（已截断）`;
}

/** File names that only pin dependency versions. */
const LOCKFILES = new Set([
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lockb",
	"bun.lock",
	"go.sum",
	"cargo.lock",
	"gemfile.lock",
	"poetry.lock",
	"pipfile.lock",
	"composer.lock",
	"gradle.lockfile",
	"podfile.lock",
	"packages.lock.json",
	"mix.lock",
	"flake.lock",
]);

/** Manifests whose version lines are dependency bumps when nothing else changed. */
const DEPENDENCY_MANIFESTS = new Set([
	"package.json",
	"go.mod",
	"cargo.toml",
	"pyproject.toml",
	"setup.py",
	"setup.cfg",
	"requirements.txt",
	"gemfile",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"composer.json",
	"pubspec.yaml",
]);

function baseName(path: string): string {
	const parts = path.split("/");
	return (parts[parts.length - 1] ?? "").toLowerCase();
}

/**
 * Pure dependency bumps are skipped without an LLM call. The test is narrow on
 * purpose: every changed file must be a lockfile (a manifest edit alone can
 * change install scripts or versions in a way worth reading), or a manifest set
 * whose commit message says it is a bump.
 */
export function isDependencyOnlyCommit(detail: GithubCommitDetail): boolean {
	if (detail.files.length === 0) return false;
	const names = detail.files.map((file) => baseName(file.filename));
	if (names.every((name) => LOCKFILES.has(name))) return true;
	if (!names.every((name) => LOCKFILES.has(name) || DEPENDENCY_MANIFESTS.has(name))) return false;
	return /\b(bump|upgrade|update|deps?|dependenc(?:y|ies)|dependabot|renovate)\b/i.test(detail.message);
}
