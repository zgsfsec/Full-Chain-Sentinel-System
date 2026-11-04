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
