/**
 * What modeling records share on screen: the four states a run can be in, their
 * chip, their filter, and the way a time is written.
 */

import { Tag } from "antd";
import { t } from "../i18n.ts";
import type { SentinelApiModelStatus } from "../types.ts";

/** `modeling` is the only live state; the other three are how a run ended. */
export const MODEL_STATUS_COLORS: Record<SentinelApiModelStatus, string> = {
	modeling: "blue",
	done: "green",
	manual: "default",
	failed: "red",
};

export const MODEL_STATUS_FILTERS: { value: SentinelApiModelStatus | ""; label: string }[] = [
	{ value: "", label: t("全部") },
	{ value: "modeling", label: t("建模中") },
	{ value: "done", label: t("已完成") },
	{ value: "manual", label: t("人工结束") },
	{ value: "failed", label: t("失败") },
];

/** `2026-11-25T08:12:33.000Z` as `2026-11-25 08:12:33`, the way the page lists times. */
export function formatModelTime(iso: string | null): string {
	if (!iso) return "—";
	return iso.slice(0, 19).replace("T", " ");
}

export function ModelStatusChip({ status }: { status: SentinelApiModelStatus }) {
	const labels: Record<SentinelApiModelStatus, string> = {
		modeling: t("建模中"),
		done: t("已完成"),
		manual: t("人工结束"),
		failed: t("失败"),
	};
	return (
		<Tag color={MODEL_STATUS_COLORS[status]} variant="filled">
			{labels[status]}
		</Tag>
	);
}
