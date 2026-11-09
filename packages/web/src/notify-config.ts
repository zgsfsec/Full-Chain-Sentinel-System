/** Notification groups persisted in notifications.json, with robot secrets protected by 0600. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { t } from "./i18n.ts";
import { webhookUrlError } from "./notify.ts";
import type {
	SentinelNotifyConfig,
	SentinelNotifyGroup,
	SentinelNotifyKinds,
	SentinelNotifyTarget,
} from "./notify-types.ts";

export const DEFAULT_SUMMARY_LIMIT = 2000;

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function kinds(value: unknown): SentinelNotifyKinds {
	const source = record(value);
	return {
		runs: source.runs !== false,
		vulns: source.vulns !== false,
		codeIntel: source.codeIntel !== false,
		goals: source.goals !== false,
		engines: source.engines !== false,
		pocs: source.pocs !== false,
	};
}

function summaryLimit(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_SUMMARY_LIMIT;
}

function target(value: unknown, index: number): SentinelNotifyTarget {
	const source = record(value);
	if (source.channel !== "dingtalk" && source.channel !== "feishu" && source.channel !== "wecom") {
		throw new Error(t("通知渠道类型无效"));
	}
	return {
		id: text(source.id) || `target-${index}`,
		name: text(source.name),
		channel: source.channel,
		enabled: source.enabled === true,
		webhook: text(source.webhook),
		secret: source.channel === "wecom" ? "" : text(source.secret),
		keyword: source.channel === "wecom" ? "" : text(source.keyword),
	};
}

function normalize(value: unknown): SentinelNotifyConfig {
	const source = record(value);
	if (!Array.isArray(source.groups)) throw new Error(t("通知组配置无效"));
	const groups = source.groups.map((value, index): SentinelNotifyGroup => {
		const group = record(value);
		return {
			id: text(group.id) || `group-${index}`,
			name: text(group.name),
			enabled: group.enabled === true,
			kinds: kinds(group.kinds),
			targets: Array.isArray(group.targets) ? group.targets.map(target) : [],
		};
	});
	return { groups, summaryLimit: summaryLimit(source.summaryLimit) };
}

export function notificationsJsonPath(agentDir: string): string {
	return `${agentDir}/notifications.json`;
}

/** Old robot settings become one group; only the saved file format is migrated. */
export function readNotifyConfig(agentDir: string): SentinelNotifyConfig {
	const defaults: SentinelNotifyConfig = { groups: [], summaryLimit: DEFAULT_SUMMARY_LIMIT };
	const path = notificationsJsonPath(agentDir);
	if (!existsSync(path)) return defaults;
	try {
		const parsed = record(JSON.parse(readFileSync(path, "utf-8")));
		if (Array.isArray(parsed.groups)) return normalize(parsed);
		const dingtalk = record(parsed.dingtalk);
		const targets: SentinelNotifyTarget[] = (["dingtalk", "feishu", "wecom"] as const).flatMap((channel, index) => {
			const saved = record(parsed[channel]);
			if (!text(saved.webhook) && !text(saved.secret) && !text(saved.keyword) && saved.enabled !== true) return [];
			return [target({ ...saved, channel, name: channel, id: `default-${channel}` }, index)];
		});
		if (targets.length === 0) return { ...defaults, summaryLimit: summaryLimit(dingtalk.summaryLimit) };
		return {
			groups: [
				{
					id: "default",
					name: t("默认通知组"),
					enabled: targets.some((target) => target.enabled),
					kinds: kinds(dingtalk.kinds),
					targets,
				},
			],
			summaryLimit: summaryLimit(dingtalk.summaryLimit),
		};
	} catch {
		return defaults;
	}
}

/** Validate before replacing saved settings; invalid drafts leave the old file intact. */
export function writeNotifyConfig(agentDir: string, config: SentinelNotifyConfig): void {
	const normalized = normalize(config);
	const groupIds = new Set<string>();
	for (const group of normalized.groups) {
		if (!group.name) throw new Error(t("请填写通知组名称"));
		if (groupIds.has(group.id)) throw new Error(t("通知组标识重复"));
		groupIds.add(group.id);
		const targetIds = new Set<string>();
		for (const target of group.targets) {
			if (!target.name) throw new Error(t("请填写机器人名称"));
			if (targetIds.has(target.id)) throw new Error(t("机器人标识重复"));
			targetIds.add(target.id);
			if (!group.enabled || !target.enabled) continue;
			const error = !target.webhook ? t("请先填写 webhook 地址") : webhookUrlError(target.webhook);
			if (error) throw new Error(`${group.name} / ${target.name}：${error}`);
		}
		if (group.enabled && !group.targets.some((entry) => entry.enabled)) {
			throw new Error(t("启用的通知组至少需要一个已启用的机器人"));
		}
	}
	const path = notificationsJsonPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalized, null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// Some filesystems do not support chmod.
	}
}
