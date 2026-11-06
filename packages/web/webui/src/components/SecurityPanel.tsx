/**
 * 设置 → 安全: the console's administrator account.
 *
 * The password change goes straight over REST (it is about the HTTP session,
 * not about the agent conversation) and logs every other session out. Logout
 * lives in the sider footer; the server refuses tokens issued before it.
 */
import { Alert, Button, Form, Input, Typography } from "antd";
import { useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import { SettingsNote, SettingsSection } from "../ui/Settings.tsx";

const { Text } = Typography;

export function SecurityPanel({ username }: { username: string | null }) {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		if (busy) return;
		if (!current || !next || !confirm) return;
		setSaved(false);
		if (next.length < 8) {
			setError(t("密码至少 {n} 个字符", { n: 8 }));
			return;
		}
		if (next !== confirm) {
			setError(t("两次输入的新密码不一致"));
			return;
		}
		setBusy(true);
		setError("");
		try {
			const response = await fetch("/api/auth/change-password", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ current, next }),
			});
			const data = (await response.json().catch(() => ({}))) as { error?: unknown };
			if (!response.ok) {
				setError(typeof data.error === "string" ? data.error : t("修改失败"));
				return;
			}
			setCurrent("");
			setNext("");
			setConfirm("");
			setSaved(true);
		} catch {
			setError(getLanguage() === "en" ? "Connection failed. Check your network and try again." : "连接失败，请检查网络后重试。");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="settings-columns security-columns">
			<SettingsSection title={t("修改密码")}>
				<SettingsNote>
					{t("至少 8 个字符。修改后其他已登录的会话（包括别的浏览器）会全部退出。")}
				</SettingsNote>
				<Form layout="vertical" className="security-form" onFinish={() => void submit()} requiredMark={false} disabled={busy}>
					<Form.Item label={t("当前密码")} htmlFor="security-current-password" required>
						<Input.Password
							id="security-current-password"
							required
							value={current}
							autoComplete="current-password"
							onChange={(event) => setCurrent(event.target.value)}
						/>
					</Form.Item>
					<Form.Item label={t("新密码")} htmlFor="security-new-password" required>
						<Input.Password
							id="security-new-password"
							required
							value={next}
							autoComplete="new-password"
							onChange={(event) => setNext(event.target.value)}
						/>
					</Form.Item>
					<Form.Item label={t("确认新密码")} htmlFor="security-confirm-password" required>
						<Input.Password
							id="security-confirm-password"
							required
							value={confirm}
							autoComplete="new-password"
							onChange={(event) => setConfirm(event.target.value)}
						/>
					</Form.Item>

					{error ? <Alert type="error" showIcon title={error} className="ui-page__alert" /> : null}
					{saved ? <Alert type="success" showIcon title={t("密码已修改。")} className="ui-page__alert" /> : null}

					<Button type="primary" htmlType="submit" loading={busy} disabled={!current || !next || !confirm}>
						{busy ? t("保存中…") : t("修改密码")}
					</Button>
				</Form>
			</SettingsSection>
			<SettingsSection title={t("当前登录")} description={username ?? t("未知")}>
				<SettingsNote>
					{t("退出登录在侧栏底部；修改密码后其他已登录的会话（包括别的浏览器）会全部退出。")}
				</SettingsNote>
				<SettingsNote>{t("密码只以哈希存在本机，从不保存明文。")}</SettingsNote>
			</SettingsSection>
		</div>
	);
}
