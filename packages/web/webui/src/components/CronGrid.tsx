/**
 * Visual cron generator.
 *
 * Each of the five fields is edited the same way: "every" (the wildcard), a
 * period (start + step), or specific values. The weekday field uses a start/end
 * range instead of a step because `1-5` is what people mean there. The text
 * expression remains the source of truth: the generator re-reads it on every
 * change, and writes a compact expression back when a control moves.
 */

import { Button, Checkbox, InputNumber, Radio, Select, Space, Typography } from "antd";
import { useMemo } from "react";
import {
	DEFAULT_CRON_EXPRESSION,
	type CronDraft,
	type CronFieldDraft,
	type CronFieldMode,
	formatCronDraft,
	parseCronDraft,
} from "../../../src/cron.ts";
import { t } from "../i18n.ts";

const { Text } = Typography;

type FieldKey = keyof CronDraft;

const FIELD_ORDER: FieldKey[] = ["minutes", "hours", "daysOfMonth", "months", "daysOfWeek"];

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const WEEKDAY_OPTIONS = WEEKDAY_LABELS.map((label, value) => ({ value, label: t(label) }));

interface FieldMeta {
	label: string;
	every: string;
	unit: string;
	min: number;
	max: number;
}

const FIELD_META: Record<FieldKey, FieldMeta> = {
	get minutes() {
		return { label: t("分钟"), every: t("每分钟"), unit: t("分钟"), min: 0, max: 59 };
	},
	get hours() {
		return { label: t("小时"), every: t("每小时"), unit: t("小时"), min: 0, max: 23 };
	},
	get daysOfMonth() {
		return { label: t("日"), every: t("每天"), unit: t("天"), min: 1, max: 31 };
	},
	get months() {
		return { label: t("月"), every: t("每月"), unit: t("月"), min: 1, max: 12 };
	},
	get daysOfWeek() {
		return { label: t("周"), every: t("每周"), unit: t("周"), min: 0, max: 6 };
	},
};

function range(min: number, max: number): number[] {
	return Array.from({ length: max - min + 1 }, (_value, index) => min + index);
}

function valueLabel(key: FieldKey, value: number): string {
	if (key === "daysOfWeek") return t(WEEKDAY_LABELS[value] ?? String(value));
	return String(value).padStart(2, "0");
}

function ValueGrid({
	fieldKey,
	field,
	onChange,
}: {
	fieldKey: FieldKey;
	field: CronFieldDraft;
	onChange: (values: number[]) => void;
}) {
	const meta = FIELD_META[fieldKey];
	const values = range(meta.min, meta.max);
	return (
		<div className="cron-field__body">
			<Checkbox.Group
				value={field.values}
				onChange={(next) => onChange(next.map((value) => Number(value)))}
				className={`cron-grid cron-grid--${fieldKey}`}
			>
				{values.map((value) => (
					<Checkbox key={value} value={value}>
						{valueLabel(fieldKey, value)}
					</Checkbox>
				))}
			</Checkbox.Group>
			<Button size="small" type="link" onClick={() => onChange(values)}>
				{t("全选")}
			</Button>
		</div>
	);
}

export function CronGrid({
	expression,
	onChange,
}: {
	expression: string;
	onChange: (expression: string) => void;
}) {
	const empty = expression.trim() === "";
	const draft = useMemo(() => {
		try {
			return parseCronDraft(empty ? DEFAULT_CRON_EXPRESSION : expression);
		} catch {
			return null;
		}
	}, [empty, expression]);

	if (!draft) {
		return <Text type="secondary">{t("表达式无效，先修正上面的文本再使用可视化生成")}</Text>;
	}

	const update = (key: FieldKey, patch: Partial<CronFieldDraft>) => {
		const next: CronDraft = { ...draft, [key]: { ...draft[key], ...patch } };
		onChange(formatCronDraft(next));
	};

	return (
		<div className="cron-builder">
			{empty ? (
				<Text type="secondary" className="cron-builder__hint">
					{t("还没有表达式；下面按默认的每小时显示，改动任意选项后会写入表达式。")}
				</Text>
			) : null}
			{FIELD_ORDER.map((key) => {
				const field = draft[key];
				const meta = FIELD_META[key];
				const modes =
					key === "daysOfWeek"
						? [
								{ value: "every", label: meta.every },
								{ value: "range", label: t("范围") },
								{ value: "specified", label: t("指定") },
							]
						: [
								{ value: "every", label: meta.every },
								{ value: "cycle", label: t("周期") },
								{ value: "specified", label: t("指定") },
							];
				return (
					<div className="cron-field" key={key}>
						<div className="cron-field__row">
							<Text strong className="cron-field__label">
								{meta.label}
							</Text>
							<Radio.Group
								size="small"
								value={field.mode}
								options={modes}
								onChange={(event) => update(key, { mode: event.target.value as CronFieldMode })}
							/>
						</div>
						{field.mode === "cycle" ? (
							<Space size={6} wrap className="cron-field__body">
								<Text type="secondary">{t("起始")}</Text>
								<InputNumber
									size="small"
									min={meta.min}
									max={meta.max}
									value={field.start}
									onChange={(value) => update(key, { start: Number(value ?? meta.min) })}
								/>
								<Text type="secondary">{t("步长")}</Text>
								<InputNumber
									size="small"
									min={1}
									max={meta.max - meta.min + 1}
									value={field.step}
									onChange={(value) => update(key, { step: Number(value ?? 1) })}
								/>
								<Text type="secondary">{meta.unit}</Text>
							</Space>
						) : null}
						{field.mode === "range" && key === "daysOfWeek" ? (
							<Space size={6} wrap className="cron-field__body">
								<Text type="secondary">{t("从")}</Text>
								<Select
									size="small"
									style={{ width: 96 }}
									value={field.start}
									options={WEEKDAY_OPTIONS}
									onChange={(value: number) =>
										update(key, { start: value, ...(value > field.end ? { end: value } : {}) })
									}
								/>
								<Text type="secondary">{t("到")}</Text>
								<Select
									size="small"
									style={{ width: 96 }}
									value={field.end}
									options={WEEKDAY_OPTIONS}
									onChange={(value: number) =>
										update(key, { end: value, ...(value < field.start ? { start: value } : {}) })
									}
								/>
							</Space>
						) : null}
						{field.mode === "specified" ? (
							<ValueGrid
								fieldKey={key}
								field={field}
								onChange={(values) => update(key, { values })}
							/>
						) : null}
					</div>
				);
			})}
			<Text type="secondary" className="cron-builder__hint">
				{t("日和周同时指定时，任一匹配即触发。")}
			</Text>
		</div>
	);
}
