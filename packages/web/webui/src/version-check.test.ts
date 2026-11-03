import { expect, test, vi } from "vitest";
import { isNewerRelease, VERSION_CHECK_INTERVAL_MS, VersionChecker } from "./version-check.ts";

vi.mock("./branding.ts", () => ({
	CONSOLE_VERSION: "2.2.12",
	PROJECT_LATEST_RELEASE_API: "https://api.github.com/repos/zgsfsec/Full-Chain-Sentinel-System/releases/latest",
}));

function release(version = "v2.2.13") {
	return new Response(JSON.stringify({ tag_name: version, draft: false, prerelease: false }), { status: 200 });
}

test.each([
	["2.2.12", "v2.2.13", true],
	["2.9.0", "v2.10.0", true],
	["2.2.12", "2.2.12", false],
	["2.2.13", "v2.2.12", false],
	["3.0.0", "v2.99.99", false],
	["2.2.12-beta.1", "v2.2.12", true],
	["2.2.12+local", "v2.2.12+release", false],
])("compares versions numerically: %s -> %s", (current, latest, available) => {
	expect(isNewerRelease(current, latest)).toBe(available);
});

test.each(["latest", "v2.2", "v2.02.12", "v2.3.0-beta.1", "<script>"])(
	"rejects invalid or preview release tag %s",
	(tag) => {
		expect(() => isNewerRelease("2.2.12", tag)).toThrow();
	},
);

test("checks only the fixed public version endpoint, caches for six hours and supports manual refresh", async () => {
	let now = 100000;
	let stored: string | null = null;
	const storage = {
		getItem: () => stored,
		setItem: (_key: string, value: string) => {
			stored = value;
		},
	};
	const fetchRelease = vi.fn<typeof fetch>().mockImplementation(async () => release());
	const checker = new VersionChecker("2.2.12", { fetch: fetchRelease, storage, now: () => now });
	const listener = vi.fn();
	const unsubscribe = checker.subscribe(listener);
	await Promise.all([checker.check(), checker.check(), checker.check()]);
	expect(fetchRelease).toHaveBeenCalledTimes(1);
	expect(fetchRelease).toHaveBeenCalledWith(
		"https://api.github.com/repos/zgsfsec/Full-Chain-Sentinel-System/releases/latest",
		expect.objectContaining({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" }),
	);
	expect(checker.getSnapshot()).toMatchObject({
		checking: false,
		error: null,
		result: { latestVersion: "2.2.13", updateAvailable: true },
	});
	expect(listener).toHaveBeenCalledTimes(2);
	await checker.check();
	expect(fetchRelease).toHaveBeenCalledTimes(1);
	await checker.check(true);
	expect(fetchRelease).toHaveBeenCalledTimes(2);
	// Reloads reuse metadata, but upgrading the local installation recalculates availability.
	const upgraded = new VersionChecker("2.2.13", { fetch: fetchRelease, storage, now: () => now });
	await upgraded.check();
	expect(upgraded.getSnapshot().result?.updateAvailable).toBe(false);
	expect(fetchRelease).toHaveBeenCalledTimes(2);
	now += VERSION_CHECK_INTERVAL_MS;
	await checker.check();
	expect(fetchRelease).toHaveBeenCalledTimes(3);
	unsubscribe();
});

test("network/rate-limit failures do not claim to be up to date, and manual retry bypasses cooldown", async () => {
	const fetchRelease = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(new Response("limit", { status: 403 }))
		.mockImplementation(async () => release());
	const checker = new VersionChecker("2.2.12", { fetch: fetchRelease, now: () => 100000 });
	await checker.check();
	expect(checker.getSnapshot()).toMatchObject({ checking: false, result: null, error: "network" });
	await checker.check();
	expect(fetchRelease).toHaveBeenCalledTimes(1);
	await checker.check(true);
	expect(checker.getSnapshot().error).toBeNull();
	expect(checker.getSnapshot().result?.updateAvailable).toBe(true);
});

test.each([
	new Response("missing", { status: 404 }),
	new Response(JSON.stringify({ tag_name: "v2.3.0", draft: true, prerelease: false })),
	new Response(JSON.stringify({ tag_name: "v2.3.0-beta.1", draft: false, prerelease: true })),
	new Response(JSON.stringify({ tag_name: "latest", draft: false, prerelease: false })),
	new Response("not json"),
])("unpublished or malformed metadata cannot produce a version notification", async (response) => {
	const checker = new VersionChecker("2.2.12", { fetch: vi.fn<typeof fetch>().mockResolvedValue(response) });
	await checker.check();
	expect(checker.getSnapshot().result).toBeNull();
	expect(checker.getSnapshot().error).not.toBeNull();
});

test.each([
	"bad json",
	JSON.stringify({ latestVersion: "2.2.13", checkedAt: 9999999 }),
	JSON.stringify({ latestVersion: "invalid", checkedAt: 1000 }),
])("invalid browser cache falls back to a fresh lookup", async (cached) => {
	const fetchRelease = vi.fn<typeof fetch>().mockImplementation(async () => release());
	const checker = new VersionChecker("2.2.12", {
		fetch: fetchRelease,
		storage: {
			getItem: () => cached,
			setItem: () => {
				throw new Error("full");
			},
		},
		now: () => 10000,
	});
	await checker.check();
	expect(fetchRelease).toHaveBeenCalledTimes(1);
	expect(checker.getSnapshot().error).toBeNull();
});
