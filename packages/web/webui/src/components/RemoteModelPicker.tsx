import { CloudDownloadOutlined } from "@ant-design/icons";
import { Alert, Button, Select, Space, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { REMOTE_MODEL_APIS, type RemoteModelInput, type RemoteModelList } from "../../../src/remote-model-types.ts";
import { t } from "../i18n.ts";

/** Independent of the built-in catalog: fetch from the current unsaved connection. */
export function RemoteModelPicker({
	input,
	modelId,
	onSelect,
}: {
	input: RemoteModelInput;
	modelId: string;
	onSelect: (id: string) => void;
}) {
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<RemoteModelList | null>(null);
	const [error, setError] = useState("");
	const pending = useRef<AbortController | null>(null);
	const sequence = useRef(0);
	const key = JSON.stringify([input.entryId, input.baseUrl, input.api, input.apiKey]);
	const currentKey = useRef(key);
	currentKey.current = key;
	const supported = (REMOTE_MODEL_APIS as readonly string[]).includes(input.api);

	useEffect(() => {
		sequence.current++;
		pending.current?.abort();
		setLoading(false);
		setResult(null);
		setError("");
		return () => {
			sequence.current++;
			pending.current?.abort();
		};
	}, [key]);

	const load = async () => {
		const seq = ++sequence.current;
		pending.current?.abort();
		const controller = new AbortController();
		pending.current = controller;
		setLoading(true);
		setResult(null);
		setError("");
		try {
			const response = await fetch("/api/models/remote", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
			});
			const body = (await response.json()) as RemoteModelList & { error?: string };
			if (sequence.current !== seq || currentKey.current !== key) return;
			if (!response.ok) throw new Error(body.error || t("获取远端模型列表失败。"));
			if (!Array.isArray(body.models)) throw new Error(t("远端没有返回有效的模型列表。"));
			setResult(body);
		} catch (error) {
			if (controller.signal.aborted || sequence.current !== seq || currentKey.current !== key) return;
			setError(
				error instanceof Error && error.name === "TimeoutError"
					? t("获取模型列表超时，请检查端点连接后重试。")
					: error instanceof Error && !(error instanceof TypeError) && !(error instanceof SyntaxError)
						? error.message
						: t("获取远端模型列表失败，请检查后端连接后重试。"),
			);
		} finally {
			if (sequence.current === seq && currentKey.current === key) setLoading(false);
		}
	};

	return (
		<Space orientation="vertical" size={8} style={{ width: "100%", marginBottom: 20 }}>
			<Button
				icon={<CloudDownloadOutlined />}
				loading={loading}
				disabled={!input.baseUrl.trim() || !supported}
				onClick={() => void load()}
			>
				{t("获取远端模型列表")}
			</Button>
			<Typography.Text type="secondary">
				{supported
					? t("使用当前 Base URL 和 API Key 查询，无需先保存；也可手动填写模型 ID。")
					: t("当前协议不支持获取远端模型列表，请手动填写模型 ID。")}
			</Typography.Text>
			{error ? <Alert type="error" showIcon title={error} /> : null}
			{result ? (
				result.models.length > 0 ? (
					<>
						<Select
							aria-label={t("远端模型列表")}
							showSearch
							style={{ width: "100%" }}
							value={result.models.some((model) => model.id === modelId) ? modelId : undefined}
							placeholder={t("搜索并选择远端模型（{count} 个）", { count: result.models.length })}
							options={result.models.map((model) => ({
								value: model.id,
								label: model.name === model.id ? model.id : `${model.name} · ${model.id}`,
							}))}
							optionFilterProp="label"
							onChange={onSelect}
						/>
						<Typography.Text type="secondary">{t("选择后仅填入模型 ID，模型能力与价格请核对。")}</Typography.Text>
						{result.truncated ? (
							<Alert type="warning" showIcon title={t("模型列表较大，仅显示部分结果；未找到时可手动填写模型 ID。")} />
						) : null}
					</>
				) : (
					<Alert type="info" showIcon title={t("远端未返回可用模型，请检查 API Key 权限，或手动填写模型 ID。")} />
				)
			) : null}
		</Space>
	);
}
