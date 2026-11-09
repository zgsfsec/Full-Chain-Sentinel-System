/**
 * Notification configuration stored in notifications.json.
 *
 * The DingTalk and Feishu custom-robot webhooks carry access tokens in their
 * URLs, so the file is written 0600 like models.json. The webhooks are editable
 * in the console the same way the endpoint API key is: plaintext in the settings
 * form, and never sent to the model.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SentinelNotifyConfig } from "./protocol.ts";

/**
 * Characters of notification body kept by default. 500 was too short to read a
 * finding from the phone, so the body is longer and the operator can change it.
 */
export const DEFAULT_SUMMARY_LIMIT = 2000;

/** Notifications stay off until an operator configures and enables them. */
const DEFAULT_CONFIG: SentinelNotifyConfig = {
	enabled: false,
	webhook: "",
	secret: "",
	keyword: "",
	kinds: { runs: true, vulns: true, codeIntel: true, goals: true, engines: true, pocs: true },
	summaryLimit: DEFAULT_SUMMARY_LIMIT,
	feishu: { enabled: false, webhook: "", secret: "", keyword: "" },
	wecom: { enabled: false, webhook: "", secret: "", keyword: "" },
};

function defaultConfig(): SentinelNotifyConfig {
	return {
		...DEFAULT_CONFIG,
		kinds: { ...DEFAULT_CONFIG.kinds },
		feishu: { ...DEFAULT_CONFIG.feishu },
		wecom: { ...DEFAULT_CONFIG.wecom },
	};
}

/** Every kind on unless the file says otherwise, so an old config keeps pushing. */
function coerceKinds(value: unknown): SentinelNotifyConfig["kinds"] {
	const kinds = (value ?? {}) as Partial<SentinelNotifyConfig["kinds"]>;
	return {
		runs: kinds.runs !== false,
		vulns: kinds.vulns !== false,
		codeIntel: kinds.codeIntel !== false,
		goals: kinds.goals !== false,
		engines: kinds.engines !== false,
		pocs: kinds.pocs !== false,
	};
}

/** A limit is a character count: 0 means "keep everything", anything else is positive. */
function coerceSummaryLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SUMMARY_LIMIT;
	const limit = Math.floor(value);
	return limit <= 0 ? 0 : limit;
}

export function notificationsJsonPath(agentDir: string): string {
	return `${agentDir}/notifications.json`;
}

function coerce(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function coerceChannel(value: unknown): SentinelNotifyConfig["feishu"] {
	const channel = (value ?? {}) as Partial<SentinelNotifyConfig["feishu"]>;
	return {
		enabled: channel.enabled === true,
		webhook: coerce(channel.webhook),
		secret: coerce(channel.secret),
		keyword: coerce(channel.keyword),
	};
}

/** Read the persisted notification config; missing or broken files read as defaults. */
export function readNotifyConfig(agentDir: string): SentinelNotifyConfig {
	const path = notificationsJsonPath(agentDir);
	if (!existsSync(path)) return defaultConfig();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			dingtalk?: Partial<SentinelNotifyConfig>;
			feishu?: Partial<SentinelNotifyConfig["feishu"]>;
			wecom?: Partial<SentinelNotifyConfig["wecom"]>;
		};
		const dingtalk = parsed.dingtalk ?? {};
		return {
			enabled: dingtalk.enabled === true,
			webhook: coerce(dingtalk.webhook),
			secret: coerce(dingtalk.secret),
			keyword: coerce(dingtalk.keyword),
			kinds: coerceKinds(dingtalk.kinds),
			summaryLimit: coerceSummaryLimit(dingtalk.summaryLimit),
			feishu: coerceChannel(parsed.feishu),
			wecom: coerceChannel(parsed.wecom),
		};
	} catch {
		return defaultConfig();
	}
}

/** Persist the notification config, replacing every channel section. */
export function writeNotifyConfig(agentDir: string, config: SentinelNotifyConfig): void {
	const path = notificationsJsonPath(agentDir);
	const feishu = coerceChannel(config.feishu);
	const wecom = coerceChannel(config.wecom);
	const payload = {
		dingtalk: {
			enabled: config.enabled,
			webhook: config.webhook.trim(),
			secret: config.secret.trim(),
			keyword: config.keyword.trim(),
			kinds: coerceKinds(config.kinds),
			summaryLimit: coerceSummaryLimit(config.summaryLimit),
		},
		feishu: {
			enabled: feishu.enabled,
			webhook: feishu.webhook.trim(),
			secret: feishu.secret.trim(),
			keyword: feishu.keyword.trim(),
		},
		wecom: {
			enabled: wecom.enabled,
			webhook: wecom.webhook.trim(),
		},
	};
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(payload, null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// chmod is best-effort (some filesystems reject it)
	}
}
