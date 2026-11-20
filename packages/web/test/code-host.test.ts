import { describe, expect, it } from "vitest";
import {
	GithubApiError,
	GithubClient,
	type GithubCommitDetail,
	isDependencyOnlyCommit,
	isGithubRateLimit,
	parseGithubRepoUrl,
	renderCommitDiff,
} from "../src/code-host.ts";

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) =>
		handler(String(input), init)) as unknown as typeof fetch;
}

function commit(overrides: Partial<GithubCommitDetail> = {}): GithubCommitDetail {
	return {
		sha: "0123456789abcdef0123456789abcdef01234567",
		message: "fix: reject path traversal in archive extractor",
		author: "dev",
		authoredAt: 1_700_000_000_000,
		url: "https://github.com/acme/app/commit/0123456",
		parents: 1,
		parentSha: "89abcdef0123456789abcdef0123456789abcdef",
		additions: 10,
		deletions: 2,
		files: [
			{
				filename: "src/archive.ts",
				status: "modified",
				additions: 10,
				deletions: 2,
				patch: "@@ -1 +1 @@\n-old\n+new",
			},
		],
		...overrides,
	};
}

describe("parseGithubRepoUrl", () => {
	it("parses github.com HTTPS URLs and strips .git", () => {
		const ref = parseGithubRepoUrl("https://github.com/acme/app.git");
		expect(ref).toMatchObject({
			host: "github.com",
			owner: "acme",
			repo: "app",
			apiBaseUrl: "https://api.github.com",
			repoUrl: "https://github.com/acme/app",
		});
	});

	it("parses scp-like SSH addresses", () => {
		const ref = parseGithubRepoUrl("git@github.com:acme/app.git");
		expect(ref.owner).toBe("acme");
		expect(ref.repo).toBe("app");
	});

	it("parses ssh:// addresses and keeps the REST base HTTPS", () => {
		const ref = parseGithubRepoUrl("ssh://git@ghe.example.com/acme/app.git");
		expect(ref.host).toBe("ghe.example.com");
		expect(ref.apiBaseUrl).toBe("https://ghe.example.com/api/v3");
		expect(ref.repoUrl).toBe("https://ghe.example.com/acme/app");
	});

	it("accepts a bare host/owner/repo", () => {
		expect(parseGithubRepoUrl("github.com/acme/app").repoUrl).toBe("https://github.com/acme/app");
	});

	it("honours an explicit API base", () => {
		const ref = parseGithubRepoUrl("https://ghe.example.com/acme/app", "https://ghe.example.com/api/v3/");
		expect(ref.apiBaseUrl).toBe("https://ghe.example.com/api/v3");
	});

	it("rejects missing repo and embedded credentials", () => {
		expect(() => parseGithubRepoUrl("https://github.com/acme")).toThrow();
		expect(() => parseGithubRepoUrl("https://user:pass@github.com/acme/app")).toThrow();
	});
});

describe("GithubClient", () => {
	it.each([100, 125])("reads exactly %i recent commits across pages before sorting by author date", async (limit) => {
		const commits = Array.from({ length: 250 }, (_, index) => ({
			sha: `sha-${index}`,
			commit: {
				message: `commit ${index}`,
				author: { name: "dev", date: new Date(index * 1000).toISOString() },
			},
		}));
		const pages: number[] = [];
		const client = new GithubClient(
			parseGithubRepoUrl("https://github.com/acme/app"),
			"token",
			fakeFetch((raw) => {
				const url = new URL(raw);
				expect(url.searchParams.get("sha")).toBe("pinned-head");
				const page = Number(url.searchParams.get("page"));
				const size = Number(url.searchParams.get("per_page"));
				pages.push(page);
				return Response.json(commits.slice((page - 1) * size, page * size));
			}),
			{ minRequestIntervalMs: 0 },
		);
		const result = await client.listCommits("pinned-head", undefined, limit);
		expect(result.map((commit) => commit.sha)).toEqual(commits.slice(0, limit).map((commit) => commit.sha));
		expect(pages).toEqual(limit === 100 ? [1] : [1, 2]);
	});

	it("stops at the end of a short repository without inventing the remaining commits", async () => {
		let calls = 0;
		const client = new GithubClient(
			parseGithubRepoUrl("https://github.com/acme/app"),
			"",
			fakeFetch(() => {
				calls++;
				return Response.json([{ sha: "only-commit" }]);
			}),
			{ minRequestIntervalMs: 0 },
		);
		expect(await client.listCommits("main", undefined, 1000)).toHaveLength(1);
		expect(calls).toBe(1);
	});

	it("sends the token and normalizes branches", async () => {
		let authorization = "";
		const client = new GithubClient(
			parseGithubRepoUrl("https://github.com/acme/app"),
			"secret",
			fakeFetch((url, init) => {
				authorization = new Headers(init?.headers).get("authorization") ?? "";
				expect(url).toContain("/repos/acme/app/branches");
				return new Response(
					JSON.stringify([
						{ name: "main", commit: { sha: "aaa" } },
						{ name: "release/1.x", commit: { sha: "bbb" } },
					]),
					{ status: 200 },
				);
			}),
		);
		const branches = await client.listBranches();
		expect(branches.map((branch) => branch.name)).toEqual(["main", "release/1.x"]);
		expect(branches[1]?.sha).toBe("bbb");
		expect(authorization).toBe("Bearer secret");
	});

	it("reads the first parent SHA and file patches", async () => {
		const client = new GithubClient(
			parseGithubRepoUrl("https://github.com/acme/app"),
			"",
			fakeFetch(() =>
				Response.json({
					sha: "fix",
					html_url: "https://github.com/acme/app/commit/fix",
					commit: {
						message: "fix",
						author: { name: "dev", date: "2024-01-01T00:00:00Z" },
					},
					parents: [{ sha: "parent" }],
					stats: { additions: 2, deletions: 1 },
					files: [{ filename: "a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@" }],
				}),
			),
		);
		const detail = await client.getCommit("fix");
		expect(detail.parentSha).toBe("parent");
		expect(detail.additions).toBe(2);
		expect(detail.files[0]?.patch).toBe("@@");
	});

	it("turns a rate-limit response into a GithubApiError", async () => {
		const client = new GithubClient(
			parseGithubRepoUrl("https://github.com/acme/app"),
			"",
			fakeFetch(
				() =>
					new Response("API rate limit exceeded", {
						status: 403,
						headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" },
					}),
			),
		);
		await expect(client.listBranches()).rejects.toBeInstanceOf(GithubApiError);
	});

	it("preserves native fetch causes, request context and socket error codes", async () => {
		const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), {
			code: "ENOTFOUND",
			hostname: "api.github.com",
			syscall: "getaddrinfo",
		});
		const original = new TypeError("fetch failed", { cause });
		const client = new GithubClient(
			parseGithubRepoUrl("https://github.com/acme/app"),
			"secret",
			fakeFetch(() => {
				throw original;
			}),
		);
		const error: unknown = await client.getBranch("main").catch((error: unknown) => error);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).cause).toBe(original);
		expect((error as Error).message).toContain("GET https://api.github.com/repos/acme/app/branches/main");
		expect((error as Error).message).toContain("code=ENOTFOUND");
		expect((error as Error).message).toContain("hostname=api.github.com");
		expect((error as Error).message).toMatch(/\d+ms/);
	});

	it("reports both IPv4 and IPv6 connection failures and redacts credentials", async () => {
		const nested = new AggregateError([
			Object.assign(new Error("connect failed"), { code: "ECONNREFUSED", address: "127.0.0.1", port: 443 }),
			Object.assign(new Error("secret-token via http://user:password@proxy.example:8080"), {
				code: "ENETUNREACH",
				address: "::1",
				port: 443,
			}),
		]);
		const client = new GithubClient(
			parseGithubRepoUrl("https://github.com/acme/app"),
			"secret-token",
			fakeFetch(() => {
				throw new TypeError("fetch failed", { cause: nested });
			}),
		);
		const error: unknown = await client.getBranch("main").catch((error: unknown) => error);
		const message = (error as Error).message;
		expect(message).toContain("ECONNREFUSED");
		expect(message).toContain("ENETUNREACH");
		expect(message).toContain("address=::1");
		expect(message).not.toContain("secret-token");
		expect(message).not.toContain("user:password");
	});

	it("handles cyclic causes without dropping the useful error code", async () => {
		const cause: { message: string; code: string; cause?: unknown } = {
			message: "TLS failed",
			code: "CERT_HAS_EXPIRED",
		};
		cause.cause = cause;
		const client = new GithubClient(
			parseGithubRepoUrl("https://github.com/acme/app"),
			"",
			fakeFetch(() => {
				throw new Error("fetch failed", { cause });
			}),
		);
		await expect(client.getBranch("main")).rejects.toThrow("CERT_HAS_EXPIRED");
	});

	it("reads the repository default branch", async () => {
		const client = new GithubClient(
			parseGithubRepoUrl("https://github.com/acme/app"),
			"",
			fakeFetch(() => Response.json({ default_branch: "master" })),
		);
		expect(await client.getRepo()).toEqual({ defaultBranch: "master" });
	});

	it("captures Retry-After on an abuse 429", async () => {
		const client = new GithubClient(
			parseGithubRepoUrl("https://github.com/acme/app"),
			"",
			fakeFetch(
				() =>
					new Response("You have triggered an abuse detection mechanism", {
						status: 429,
						headers: { "retry-after": "120" },
					}),
			),
		);
		const error = await client.listBranches().catch((caught: unknown) => caught);
		expect(isGithubRateLimit(error)).toBe(true);
		expect((error as GithubApiError).retryAfterMs).toBe(120_000);
	});
});

describe("diff rendering", () => {
	it("truncates a patch rather than dropping the file list", () => {
		const text = renderCommitDiff(
			commit({
				files: [
					{ filename: "a.ts", status: "modified", additions: 1, deletions: 1, patch: "x".repeat(10_000) },
					{ filename: "b.ts", status: "modified", additions: 1, deletions: 1, patch: "y".repeat(10_000) },
				],
			}),
			12_000,
			8_000,
		);
		expect(text).toContain("### a.ts");
		expect(text).toContain("已截断");
		expect(text).toContain("另有");
	});
});

describe("dependency-only commits", () => {
	it("skips a lockfile-only commit", () => {
		expect(
			isDependencyOnlyCommit(
				commit({
					message: "chore: update lockfile",
					files: [{ filename: "package-lock.json", status: "modified", additions: 5, deletions: 5 }],
				}),
			),
		).toBe(true);
	});

	it("does not skip a source change hidden next to a manifest", () => {
		expect(
			isDependencyOnlyCommit(
				commit({
					message: "bump lodash and fix auth bypass",
					files: [
						{ filename: "package.json", status: "modified", additions: 1, deletions: 1 },
						{ filename: "src/auth.ts", status: "modified", additions: 4, deletions: 1 },
					],
				}),
			),
		).toBe(false);
	});
});
