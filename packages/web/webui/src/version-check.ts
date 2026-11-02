/** Public release metadata only: no credentials, targets, downloads or installers. */
import { CONSOLE_VERSION, PROJECT_LATEST_RELEASE_API } from "./branding.ts";

export const VERSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CACHE_KEY = "sentinel.latest-release.v1";
const FAILURE_RETRY_MS = 5 * 60 * 1000;
const VERSION =
	/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface VersionCheckResult {
	latestVersion: string;
	updateAvailable: boolean;
	checkedAt: number;
}
export interface VersionCheckState {
	checking: boolean;
	result: VersionCheckResult | null;
	error: "network" | "unpublished" | "invalid" | null;
}

export function isNewerRelease(current: string, latest: string): boolean {
	const local = VERSION.exec(current);
	const remote = VERSION.exec(latest);
	if (!local || !remote || remote[4]) throw new Error("Invalid stable release version");
	for (let index = 1; index <= 3; index++) {
		const a = BigInt(local[index]);
		const b = BigInt(remote[index]);
		if (a !== b) return b > a;
	}
	return Boolean(local[4]);
}

type CacheStorage = Pick<Storage, "getItem" | "setItem">;

export class VersionChecker {
	private readonly current: string;
	private readonly fetchRelease: typeof fetch;
	private readonly storage: CacheStorage | undefined;
	private readonly now: () => number;
	private state: VersionCheckState = { checking: false, result: null, error: null };
	private readonly listeners = new Set<() => void>();
	private pending: Promise<void> | undefined;
	private retryAfter = 0;

	constructor(
		current: string,
		dependencies: { fetch?: typeof fetch; storage?: CacheStorage; now?: () => number } = {},
	) {
		this.current = current;
		this.fetchRelease = dependencies.fetch ?? ((...args) => fetch(...args));
		this.storage = dependencies.storage;
		this.now = dependencies.now ?? Date.now;
		try {
			const cached = JSON.parse(this.storage?.getItem(CACHE_KEY) ?? "null") as unknown;
			if (
				cached &&
				typeof cached === "object" &&
				"latestVersion" in cached &&
				"checkedAt" in cached &&
				typeof cached.latestVersion === "string" &&
				typeof cached.checkedAt === "number" &&
				cached.checkedAt <= this.now() &&
				this.now() - cached.checkedAt < VERSION_CHECK_INTERVAL_MS
			) {
				this.state.result = {
					latestVersion: cached.latestVersion,
					checkedAt: cached.checkedAt,
					updateAvailable: isNewerRelease(current, cached.latestVersion),
				};
			}
		} catch {
			// Corrupt or blocked browser storage must not prevent a fresh check.
		}
	}

	getSnapshot = (): VersionCheckState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	private publish(state: VersionCheckState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}

	check = (force = false): Promise<void> => {
		if (this.pending) return this.pending;
		const age = this.state.result ? this.now() - this.state.result.checkedAt : Infinity;
		if (!force && (this.now() < this.retryAfter || (age >= 0 && age < VERSION_CHECK_INTERVAL_MS)))
			return Promise.resolve();
		this.publish({ ...this.state, checking: true, error: null });
		this.pending = this.request().finally(() => {
			this.pending = undefined;
		});
		return this.pending;
	};

	private async request(): Promise<void> {
		let failure: VersionCheckState["error"] = "network";
		try {
			const response = await this.fetchRelease(PROJECT_LATEST_RELEASE_API, {
				method: "GET",
				headers: { Accept: "application/vnd.github+json" },
				credentials: "omit",
				referrerPolicy: "no-referrer",
				redirect: "error",
				cache: "no-store",
				signal: AbortSignal.timeout(8000),
			});
			if (response.status === 404) failure = "unpublished";
			if (!response.ok) throw new Error("Release lookup failed");
			failure = "invalid";
			const release: unknown = await response.json();
			if (
				!release ||
				typeof release !== "object" ||
				!("tag_name" in release) ||
				typeof release.tag_name !== "string" ||
				release.tag_name.length > 128 ||
				!("draft" in release) ||
				release.draft !== false ||
				!("prerelease" in release) ||
				release.prerelease !== false
			)
				throw new Error("Invalid release metadata");
			const result = {
				latestVersion: release.tag_name.replace(/^v/, ""),
				updateAvailable: isNewerRelease(this.current, release.tag_name),
				checkedAt: this.now(),
			};
			this.retryAfter = 0;
			this.publish({ checking: false, result, error: null });
			try {
				this.storage?.setItem(CACHE_KEY, JSON.stringify(result));
			} catch {
				/* Storage may be disabled or full. */
			}
		} catch {
			this.retryAfter = this.now() + FAILURE_RETRY_MS;
			this.publish({ ...this.state, checking: false, error: failure });
		}
	}
}

let storage: CacheStorage | undefined;
try {
	storage = globalThis.localStorage;
} catch {
	/* Browser storage is optional. */
}
export const versionChecker = new VersionChecker(CONSOLE_VERSION, { storage });
