import { Alert, Button, Skeleton } from "antd";
import { getLanguage, t } from "../i18n.ts";

export function DetailLoading({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
	return error ? <Alert style={{ width: "100%" }} type="error" showIcon title={error}
		action={onRetry ? <Button onClick={onRetry}>{t("重试")}</Button> : undefined} />
		: <div style={{ width: "100%" }} role="status" aria-label={getLanguage() === "en" ? "Loading details" : "正在加载详情"}><Skeleton active paragraph={{ rows: 6 }} /></div>;
}
