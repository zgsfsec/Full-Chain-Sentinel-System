/** Notification settings shared by the server and browser. Groups apply globally. */
export type SentinelNotifyChannel = "dingtalk" | "feishu" | "wecom";
export type SentinelNotifyKind = "runs" | "vulns" | "codeIntel" | "goals" | "engines" | "pocs";
export type SentinelNotifyKinds = Record<SentinelNotifyKind, boolean>;

export interface SentinelNotifyChannelConfig {
	enabled: boolean;
	webhook: string;
	secret: string;
	keyword: string;
}

export interface SentinelNotifyTarget extends SentinelNotifyChannelConfig {
	id: string;
	name: string;
	channel: SentinelNotifyChannel;
}

export interface SentinelNotifyGroup {
	id: string;
	name: string;
	enabled: boolean;
	kinds: SentinelNotifyKinds;
	targets: SentinelNotifyTarget[];
}

export interface SentinelNotifyConfig {
	groups: SentinelNotifyGroup[];
	/** Characters kept per body section; 0 keeps all, subject to platform limits. */
	summaryLimit: number;
}

export interface SentinelNotifyDelivery {
	groupId: string;
	groupName: string;
	targetId: string;
	targetName: string;
	channel: SentinelNotifyChannel;
	ok: boolean;
	error?: string;
}

export interface SentinelNotifyStatus {
	at: number | null;
	ok: boolean;
	error?: string;
	subject?: string;
	deliveries?: SentinelNotifyDelivery[];
}
