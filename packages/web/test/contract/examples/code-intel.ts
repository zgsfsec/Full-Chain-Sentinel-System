import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

type MonitorInput = ClientExample<"create_code_monitor">["input"];
type Monitor = ServerExample<"code_monitors">["monitors"][number];
type Commit = ServerExample<"code_activity">["view"]["items"][number];
type CheckLog = ServerExample<"code_monitor_logs">["checks"][number];
type CheckJob = ServerExample<"code_monitor_logs">["jobs"][number];

const projectId = "3f2a9c14-7b6e-4d21-9a58-2c0e5b7d8f31";
const monitorId = "6c1d3a90-2b7f-4e5a-8d34-9f0b1c7a52e8";
const scanId = "a41e8b27-9d0c-4f6b-b3e2-5c8a7d1f9064";
const repoUrl = "https://github.com/example-org/example-gateway";
const token = "github_pat_example0000000000000000000000000";
const engineId = "engine-5e0b7c32-8a1d-4c4f-9e67-2d3b8f1a0c45";

/** What the editor form sends; leaving `token` out keeps the stored one. */
const form: MonitorInput = {
	projectId,
	url: repoUrl,
	name: "example-org/example-gateway",
	apiBaseUrl: "https://api.github.com",
	branches: ["main", "release/2.4"],
	intervalMinutes: 60,
	scheduleKind: "interval",
	cronExpression: null,
	autoDispatch: true,
	autoDispatchCategories: ["web", "memory"],
	autoDispatchTags: ["sql-injection", "path-traversal"],
	enabled: true,
};

/** One valid example of each browser-to-server message described in code-intel.md. */
export const client = {
	list_code_monitors: { type: "list_code_monitors" },
	list_code_activity: {
		type: "list_code_activity",
		requestId: 12,
		projectId,
		filter: "attention",
		category: "web",
		tag: null,
		search: "",
		page: 1,
		pageSize: 20,
	},
	code_monitor_branches: {
		type: "code_monitor_branches",
		requestId: 5,
		projectId,
		url: repoUrl,
		token,
		apiBaseUrl: "https://api.github.com",
	},
	import_code_monitors: {
		type: "import_code_monitors",
		inputs: [
			{ ...form, token },
			{
				projectId,
				url: "https://github.com/example-org/example-cli",
				token,
				branches: ["main"],
				intervalMinutes: 120,
				scheduleKind: "interval",
				cronExpression: null,
				autoDispatch: false,
				enabled: true,
			},
		],
	},
	get_code_monitor_import: { type: "get_code_monitor_import" },
	dismiss_code_monitor_import: { type: "dismiss_code_monitor_import" },
	create_code_monitor: {
		type: "create_code_monitor",
		input: {
			projectId,
			url: "https://github.com/example-org/example-cli",
			name: "Example CLI",
			token,
			branches: ["main"],
			intervalMinutes: 60,
			scheduleKind: "cron",
			cronExpression: "30 2 * * 1-5",
			autoDispatch: true,
			autoDispatchTags: ["rce"],
			enabled: true,
		},
	},
	scan_code_history: {
		type: "scan_code_history",
		input: { projectId, url: repoUrl, token, commitLimit: 20, autoDispatch: false },
	},
	update_code_monitor: { type: "update_code_monitor", id: monitorId, input: form },
	delete_code_monitors: { type: "delete_code_monitors", ids: [monitorId, scanId] },
	delete_code_monitor: { type: "delete_code_monitor", id: monitorId },
	check_code_monitor: { type: "check_code_monitor", id: monitorId, trigger: "manual" },
	get_code_monitor: { type: "get_code_monitor", id: monitorId },
	dispatch_code_commit: { type: "dispatch_code_commit", id: "d27b5e81-3c4a-4f09-8b6d-1e2f3a4c5b70" },
	ignore_code_commit: { type: "ignore_code_commit", id: "8b4f2e69-7a15-4d3c-b0e8-c57f91a3d6e2" },
	rejudge_code_commit: { type: "rejudge_code_commit", id: "5ea1d8b4-2f76-4c90-8b13-9d6e2a7f4c38" },
	set_code_monitors_schedule: {
		type: "set_code_monitors_schedule",
		ids: [monitorId, scanId],
		scheduleKind: "interval",
		intervalMinutes: 120,
		cronExpression: null,
	},
	set_code_monitors_dispatch: {
		type: "set_code_monitors_dispatch",
		ids: [monitorId],
		autoDispatch: true,
		autoDispatchCategories: ["web", "memory"],
		autoDispatchTags: null,
	},
	list_code_monitor_logs: { type: "list_code_monitor_logs", projectId },
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

const rateLimit =
	"main: GitHub API 触发限流（429/abuse）。请稍后重试；建议为监控配置访问令牌，并避免同时检查同一主机的多个仓库（HTTP 403；GET https://api.github.com/repos/example-org/example-gateway/branches/main；812ms）";

const monitor: Monitor = {
	id: monitorId,
	projectId,
	projectName: "Example Gateway",
	name: "example-org/example-gateway",
	host: "github.com",
	owner: "example-org",
	repo: "example-gateway",
	repoUrl,
	apiBaseUrl: "https://api.github.com",
	branches: ["main", "release/2.4"],
	baselines: {
		main: "9f1c3e7a2b4d6f80a1c3e5b7d9f0a2c4e6b8d0f1",
		"release/2.4": "4a7d1e30b9c2f5a68d0e3b7c1f4a6d8e0b2c5f97",
	},
	tokenSet: true,
	autoDispatch: true,
	autoDispatchCategories: ["web", "memory"],
	autoDispatchTags: ["sql-injection", "path-traversal"],
	intervalMinutes: 60,
	scheduleKind: "interval",
	cronExpression: null,
	nextCheckAt: 1795508400000,
	checkState: "idle",
	oneShot: false,
	oneShotLimit: null,
	enabled: true,
	lastCheckAt: 1795504800000,
	lastError: null,
	createdAt: 1794277800000,
	findingCount: 3,
	pendingCount: 2,
};

/** The record a one-time scan leaves behind: never polled, so no next check. */
const scan: Monitor = {
	...monitor,
	id: scanId,
	name: "example-org/example-gateway · 单次扫描",
	branches: ["main"],
	baselines: { main: "9f1c3e7a2b4d6f80a1c3e5b7d9f0a2c4e6b8d0f1" },
	autoDispatch: false,
	autoDispatchCategories: null,
	autoDispatchTags: null,
	intervalMinutes: 0,
	nextCheckAt: null,
	oneShot: true,
	oneShotLimit: 20,
	enabled: false,
	lastCheckAt: 1795504260000,
	lastError: rateLimit,
	createdAt: 1795503600000,
	findingCount: 0,
	pendingCount: 0,
};

/** A security fix waiting for the operator. */
const finding: Commit = {
	id: "d27b5e81-3c4a-4f09-8b6d-1e2f3a4c5b70",
	monitorId,
	projectId,
	branch: "main",
	sha: "9f1c3e7a2b4d6f80a1c3e5b7d9f0a2c4e6b8d0f1",
	shortSha: "9f1c3e7a",
	title: "fix(upload): reject path traversal in avatar names",
	message:
		"fix(upload): reject path traversal in avatar names\n\nResolve the target against the upload root and refuse anything outside it.",
	author: "Jordan Lee",
	authoredAt: 1795503600000,
	url: `${repoUrl}/commit/9f1c3e7a2b4d6f80a1c3e5b7d9f0a2c4e6b8d0f1`,
	verdict: "security",
	confidence: 0.92,
	cve: "CVE-2026-31415",
	severity: "high",
	vulnType: "路径穿越",
	vulnCategory: "web",
	vulnTags: ["path-traversal", "file-write"],
	reason: "src/upload/avatar.ts 原先直接拼接用户传入的文件名，修复后改为 resolve 后校验是否仍在上传目录内。",
	status: "new",
	reproductionStage: null,
	engineId: null,
	duplicateOf: null,
	error: null,
	additions: 24,
	deletions: 3,
	files: 2,
	diff: '### src/upload/avatar.ts (modified, +10 -3)\n@@ -18,7 +18,14 @@\n-    const target = join(root, name);\n+    const target = resolve(root, name);\n+    if (!target.startsWith(root + sep)) throw new Error("invalid name");\n\n### src/upload/validate.ts (added, +14 -0)\n+export function isInside(root: string, target: string): boolean {\n+    return target.startsWith(root + sep);\n+}',
	createdAt: 1795504800000,
	judgedAt: 1795504920000,
};

/** A security fix already handed to an engineering run. */
const dispatched: Commit = {
	...finding,
	id: "0c93a6f2-5b81-4e47-a2d9-6f3c8b1e7d05",
	branch: "release/2.4",
	sha: "4a7d1e30b9c2f5a68d0e3b7c1f4a6d8e0b2c5f97",
	shortSha: "4a7d1e30",
	title: "fix(db): parameterize the tenant lookup",
	message: "fix(db): parameterize the tenant lookup",
	authoredAt: 1795165920000,
	url: `${repoUrl}/commit/4a7d1e30b9c2f5a68d0e3b7c1f4a6d8e0b2c5f97`,
	confidence: 0.88,
	cve: null,
	severity: "medium",
	vulnType: "SQL 注入",
	vulnTags: ["sql-injection"],
	reason: "src/db/tenant.ts 把请求里的 tenant id 直接拼进了 SQL，修复后改为参数绑定。",
	status: "dispatched",
	reproductionStage: "engineering",
	engineId,
	additions: 9,
	deletions: 4,
	files: 1,
	// The `${id}` below is part of the example's content.
	// biome-ignore lint/suspicious/noTemplateCurlyInString: it is SQL text inside the diff, not a placeholder.
	diff: "### src/db/tenant.ts (modified, +9 -4)\n@@ -41,4 +41,9 @@\n-    const sql = `SELECT * FROM tenants WHERE id = '${id}'`;\n+    const sql = \"SELECT * FROM tenants WHERE id = ?\";",
	createdAt: 1795166400000,
	judgedAt: 1795166520000,
};

/** A security fix whose reproduction could not be started. */
const dispatchFailed: Commit = {
	...finding,
	id: "8b4f2e69-7a15-4d3c-b0e8-c57f91a3d6e2",
	sha: "7e3d0c5b8a2f4e61d9c7b0a3e5f2c48d6b1e97a0",
	shortSha: "7e3d0c5b",
	title: "fix(webhook): block requests to link-local addresses",
	message: "fix(webhook): block requests to link-local addresses",
	authoredAt: 1795097100000,
	url: `${repoUrl}/commit/7e3d0c5b8a2f4e61d9c7b0a3e5f2c48d6b1e97a0`,
	confidence: 0.81,
	cve: "GHSA-7q3m-2x8p-9r4c-w5vd",
	vulnType: "SSRF",
	vulnTags: ["ssrf"],
	reason: "src/webhook/deliver.ts 新增了对解析后地址的网段判断，拒绝 169.254.0.0/16 与 127.0.0.0/8。",
	reproductionStage: "failed",
	error: "项目容器未运行，请先在项目页启动容器",
	additions: 31,
	deletions: 1,
	diff: '### src/webhook/deliver.ts (modified, +31 -1)\n@@ -12,6 +12,36 @@\n+    if (isPrivate(target.hostname)) throw new Error("blocked address");',
	createdAt: 1795097400000,
	judgedAt: 1795097520000,
};

/** A commit the monitor model could not judge. */
const failed: Commit = {
	...finding,
	id: "5ea1d8b4-2f76-4c90-8b13-9d6e2a7f4c38",
	sha: "c05b9f6e1d3a7c408e2b6d9f0a1c7e5b3d0f8269",
	shortSha: "c05b9f6e",
	title: "refactor(core): split the request pipeline",
	message: "refactor(core): split the request pipeline",
	authoredAt: 1795420800000,
	url: `${repoUrl}/commit/c05b9f6e1d3a7c408e2b6d9f0a1c7e5b3d0f8269`,
	verdict: "failed",
	confidence: null,
	cve: null,
	severity: null,
	vulnType: null,
	vulnCategory: null,
	vulnTags: [],
	reason: "监测模型请求超时",
	additions: 412,
	deletions: 388,
	files: 17,
	diff: "### src/core/pipeline.ts (modified, +212 -188)\n-export function handle(request) {\n+export function handle(request) {\n（另有 16 个文件的 diff 因长度限制未展示）",
	createdAt: 1795424400000,
	judgedAt: 1795424610000,
};

const checkOk: CheckLog = {
	id: "8f2c6b14-0e3d-4a57-9c81-b2d4e6f80a13",
	monitorId,
	trigger: "manual",
	status: "ok",
	startedAt: 1795504800000,
	endedAt: 1795505040000,
	commits: 2,
	findings: 1,
	error: null,
};

const checkFailed: CheckLog = {
	id: "1d6e4a92-7c3b-4f08-9b25-8e6d2a9c4f07",
	monitorId,
	trigger: "auto",
	status: "error",
	startedAt: 1795424400000,
	endedAt: 1795424610000,
	commits: 0,
	findings: 0,
	error: rateLimit,
};

const scanCheck: CheckLog = {
	id: "c3a7e519-8b02-4d64-b1f7-0a9e3c6d5f284",
	monitorId: scanId,
	trigger: "one-shot",
	status: "error",
	startedAt: 1795503600000,
	endedAt: 1795504260000,
	commits: 12,
	findings: 0,
	error: rateLimit,
};

const jobDone: CheckJob = {
	id: "b9a3f7c1-4d2e-4b80-9f16-3c5e7a8d0b24",
	monitorId,
	projectId,
	host: "github.com",
	trigger: "manual",
	status: "done",
	attempts: 1,
	maxAttempts: 3,
	nextRunAt: 1795504800000,
	createdAt: 1795504800000,
	startedAt: 1795504800000,
	endedAt: 1795505040000,
	error: null,
	checkId: "8f2c6b14-0e3d-4a57-9c81-b2d4e6f80a13",
};

/** A check that ended with an error waits for its retry. */
const jobQueued: CheckJob = {
	id: "e5c8d2a6-1f9b-4e73-8c04-6b7f9d1a3e58",
	monitorId,
	projectId,
	host: "github.com",
	trigger: "auto",
	status: "queued",
	attempts: 1,
	maxAttempts: 3,
	nextRunAt: 1795425600000,
	createdAt: 1795424400000,
	startedAt: null,
	endedAt: null,
	error: rateLimit,
	checkId: null,
};

const scanJob: CheckJob = {
	...jobQueued,
	id: "f0b6e3d7-2a4c-4b91-9d58-7c3e6a0f5b18",
	monitorId: scanId,
	trigger: "one-shot",
	nextRunAt: 1795511100000,
	createdAt: 1795503600000,
};

/** One valid example of each server-to-browser message described in code-intel.md. */
export const server = {
	code_monitors: { type: "code_monitors", monitors: [scan, monitor] },
	code_monitor_import: {
		type: "code_monitor_import",
		state: {
			total: 3,
			processed: 2,
			succeeded: 1,
			failed: 1,
			current: "https://github.com/example-org/example-cache",
			running: true,
			errors: [
				{
					url: "https://github.com/example-org/example-cli",
					error: '仓库或分支不存在，或令牌无权访问（HTTP 404；GET https://api.github.com/repos/example-org/example-cli/branches/main；205ms）：{"message":"Not Found"}',
				},
			],
		},
	},
	code_activity_error: { type: "code_activity_error", requestId: 12, error: "项目不存在" },
	code_activity: {
		type: "code_activity",
		requestId: 12,
		view: {
			items: [finding, dispatched, dispatchFailed],
			total: 3,
			page: 1,
			pageSize: 20,
			counts: {
				attention: 3,
				review: 1,
				failed: 1,
				dispatchFailed: 1,
				pending: 0,
				anomalies: 1,
				reproducing: 1,
				finished: 0,
			},
		},
	},
	code_monitor_branches: {
		type: "code_monitor_branches",
		requestId: 5,
		branches: ["main", "release/2.4", "release/2.5"],
	},
	code_monitor_result: {
		type: "code_monitor_result",
		action: "检查监控",
		id: monitorId,
		ok: true,
		detail: "已加入检查队列",
	},
	code_monitor_detail: {
		type: "code_monitor_detail",
		detail: {
			monitor,
			commits: [finding, failed, dispatched, dispatchFailed],
			checks: [checkOk, checkFailed],
			jobs: [jobDone, jobQueued],
		},
	},
	code_monitor_logs: {
		type: "code_monitor_logs",
		checks: [checkOk, scanCheck, checkFailed],
		jobs: [jobDone, scanJob, jobQueued],
	},
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
