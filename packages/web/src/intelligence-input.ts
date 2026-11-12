import { isIP } from "node:net";
import {
	DEFAULT_INTELLIGENCE_TEMPLATE,
	type IntelligenceAlert,
	type IntelligenceEventInput,
	type IntelligencePolicy,
	type IntelligencePush,
} from "./intelligence-types.ts";

export class IntelligenceError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

export function objectValue(value: unknown, path = "body"): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new IntelligenceError(`${path} 必须是对象`);
	return value as Record<string, unknown>;
}

export function textValue(value: unknown, path: string, max = 200): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) {
		throw new IntelligenceError(`${path} 必须是 1–${max} 字符的字符串`);
	}
	return value.trim();
}

export function normalizeIntelligenceIp(value: unknown): string {
	const ip = textValue(value, "indicator.value", 64);
	const version = isIP(ip);
	if (!version) throw new IntelligenceError("indicator.value 必须是单个 IPv4 或 IPv6 地址");
	if (ip.includes("%")) throw new IntelligenceError("不支持带接口标识的 IPv6 地址");
	if (version === 4) return ip;
	const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
	// IPv4-mapped IPv6 and the underlying IPv4 identify the same indicator.
	const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
	if (!mapped) return normalized;
	const high = Number.parseInt(mapped[1], 16);
	const low = Number.parseInt(mapped[2], 16);
	return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function onlyKeys(value: Record<string, unknown>, keys: string[], path: string): void {
	for (const key of Object.keys(value))
		if (!keys.includes(key)) throw new IntelligenceError(`${path}.${key} 不允许上报，仅接受协议定义的告警元数据`);
}

export function parseIntelligencePush(value: unknown): IntelligencePush {
	const body = objectValue(value);
	onlyKeys(body, ["schema_version", "request_id", "events"], "body");
	if (body.schema_version !== 1) throw new IntelligenceError("schema_version 必须为 1");
	if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 1000) {
		throw new IntelligenceError("events 每批必须包含 1–1000 条告警");
	}
	const ids = new Set<string>();
	const events = body.events.map((raw, index): IntelligenceEventInput => {
		try {
			const event = objectValue(raw);
			onlyKeys(event, ["event_id", "indicator", "occurred_at", "category", "severity"], "event");
			const indicator = objectValue(event.indicator, "indicator");
			onlyKeys(indicator, ["type", "value"], "indicator");
			if (indicator.type !== "ip") throw new IntelligenceError("indicator.type 首版只支持 ip");
			const id = textValue(event.event_id, "event_id");
			if (ids.has(id)) throw new IntelligenceError("同批次 event_id 不能重复");
			ids.add(id);
			const occurred = textValue(event.occurred_at, "occurred_at", 40);
			const date =
				/^(\d{4})-(\d\d)-(\d\d)T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
					occurred,
				);
			if (
				!date ||
				!Number.isFinite(Date.parse(occurred)) ||
				Number(date[2]) < 1 ||
				Number(date[2]) > 12 ||
				Number(date[3]) < 1 ||
				Number(date[3]) > new Date(Date.UTC(Number(date[1]), Number(date[2]), 0)).getUTCDate()
			) {
				throw new IntelligenceError("occurred_at 必须是带时区的 ISO 8601 时间");
			}
			const severity = event.severity;
			if (
				severity !== "info" &&
				severity !== "low" &&
				severity !== "medium" &&
				severity !== "high" &&
				severity !== "critical"
			) {
				throw new IntelligenceError("severity 必须是 info/low/medium/high/critical");
			}
			return {
				event_id: id,
				indicator: { type: "ip" as const, value: normalizeIntelligenceIp(indicator.value) },
				occurred_at: new Date(occurred).toISOString(),
				category: textValue(event.category, "category"),
				severity,
			};
		} catch (error) {
			throw new IntelligenceError(`events[${index}]: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	return { schema_version: 1, request_id: textValue(body.request_id, "request_id"), events };
}

/** Select fields explicitly so historical payloads cannot reintroduce customer data. */
export function intelligenceAlertMetadata(alert: IntelligenceAlert): IntelligenceAlert {
	return {
		event_id: alert.event_id,
		indicator: { type: "ip", value: alert.indicator.value },
		occurred_at: alert.occurred_at,
		category: alert.category,
		severity: alert.severity,
		seq: alert.seq,
		sourceId: alert.sourceId,
		sourceName: alert.sourceName,
		receivedAt: alert.receivedAt,
	};
}

function int(value: unknown, field: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
		throw new IntelligenceError(`${field} 必须是 ${min}–${max} 的整数`);
	}
	return value;
}

export function parseIntelligencePolicy(value: unknown): IntelligencePolicy {
	const input = objectValue(value);
	const template = objectValue(input.template, "template");
	const limits = objectValue(template.limits, "template.limits");
	if (typeof input.enabled !== "boolean") throw new IntelligenceError("enabled 必须是布尔值");
	const threshold = int(input.threshold, "threshold", 1, 200);
	const batchSize = int(input.batchSize, "batchSize", threshold, 200);
	return {
		enabled: input.enabled,
		threshold,
		batchSize,
		concurrency: int(input.concurrency, "concurrency", 1, 8),
		cooldownMinutes: int(input.cooldownMinutes, "cooldownMinutes", 0, 525600),
		template: {
			id: textValue(template.id, "template.id"),
			// Name and prompt are resolved from the engineering doctrine on save.
			name: DEFAULT_INTELLIGENCE_TEMPLATE.name,
			prompt: DEFAULT_INTELLIGENCE_TEMPLATE.prompt,
			limits: {
				concurrency: int(limits.concurrency, "limits.concurrency", 1, 8),
				roundLimit: int(limits.roundLimit, "limits.roundLimit", 1, 99),
				maxRetries: 0,
				tokenLimit: limits.tokenLimit === null ? null : int(limits.tokenLimit, "limits.tokenLimit", 1, 10000000),
				timeLimitMin:
					limits.timeLimitMin === null ? null : int(limits.timeLimitMin, "limits.timeLimitMin", 1, 1440),
			},
		},
	};
}

/** Stable hashes must not depend on object key order in device JSON. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
