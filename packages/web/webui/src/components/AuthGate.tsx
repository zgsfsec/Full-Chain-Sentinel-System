/**
 * The login screen.
 *
 * Shown instead of the console until the operator authenticates: on a fresh
 * install it is the account-creation form (setup), afterwards the login form.
 * Places the form over the animated skyline using the console's dark palette.
 */
import { GithubOutlined } from "@ant-design/icons";
import { Alert, Button, Checkbox, ConfigProvider, Form, Input, Typography } from "antd";
import { useId, useState } from "react";
import {
	CONSOLE_VERSION,
	PROJECT_LICENSE,
	PROJECT_LICENSE_URL,
	PROJECT_NAME,
	PROJECT_REPOSITORY,
} from "../branding.ts";
import { getLanguage, t } from "../i18n.ts";
import { SESSION_ENDED_NOTICE } from "../ws.ts";
import { consoleAuthTheme } from "../ui/theme.ts";
import { SentinelMark } from "./icons.tsx";
import { LanguageSwitch } from "./LanguageSwitch.tsx";
import { LoginBackdrop } from "./LoginBackdrop.tsx";
import "./auth-gate.css";

const { Title, Text, Link } = Typography;

export function AuthGate({ mode, onDone }: { mode: "setup" | "login"; onDone: () => void }) {
	const formId = useId();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [remember, setRemember] = useState(true);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [sessionNotice] = useState(() => {
		try {
			return window.sessionStorage.getItem(SESSION_ENDED_NOTICE);
		} catch {
			return null;
		}
	});

	const submit = async () => {
		if (busy || !username.trim() || !password || (mode === "setup" && !confirm)) return;
		if (mode === "setup" && password.length < 8) {
			setError(t("密码至少 {n} 个字符", { n: 8 }));
			return;
		}
		if (mode === "setup" && password !== confirm) {
			setError(t("两次输入的密码不一致"));
			return;
		}
		setBusy(true);
		setError("");
		try {
			const response = await fetch(`/api/auth/${mode}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: username.trim(), password, remember }),
			});
			const data = (await response.json().catch(() => ({}))) as { error?: unknown };
			if (!response.ok) {
				setError(typeof data.error === "string" ? data.error : t("操作失败，请重试"));
				return;
			}
			onDone();
		} catch {
			setError(t("无法连接服务，请确认服务在运行"));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="auth-screen">
			<div className="auth-screen__visual" aria-hidden="true">
				<LoginBackdrop />
			</div>
			<header className="auth-screen__header">
				<div className="auth-screen__brand">
					<span className="auth-screen__mark">
						<SentinelMark size={22} />
					</span>
					<span className="auth-screen__name">{PROJECT_NAME}</span>
				</div>
				<LanguageSwitch className="auth-screen__language" />
			</header>
			<ConfigProvider theme={consoleAuthTheme}>
				<main className="auth-screen__main">
					<section className="auth-screen__intro" aria-label={PROJECT_NAME}>
						<span className="auth-screen__eyebrow">FULL CHAIN SENTINEL</span>
						<h2>{PROJECT_NAME}</h2>
						<p>{t("授权渗透测试工作台")}</p>
						<footer className="auth-screen__footer">
							<Text type="secondary">v{CONSOLE_VERSION}</Text>
							<span className="auth-screen__links">
								<Link href={PROJECT_REPOSITORY} target="_blank" rel="noreferrer">
									<GithubOutlined /> GitHub
								</Link>
								<Link href={PROJECT_LICENSE_URL} target="_blank" rel="noreferrer">
									{PROJECT_LICENSE}
								</Link>
							</span>
						</footer>
					</section>
					<div className="auth-screen__content">
						<section className="auth-screen__card" aria-labelledby={`${formId}-title`}>
							<Title level={1} id={`${formId}-title`} className="auth-screen__title">
								{mode === "setup" ? t("创建管理员账号") : t("登录到工作台")}
							</Title>
							<Text type="secondary">
								{mode === "setup" ? t("首次使用：设置管理员用户名与密码，之后用它登录。") : t("输入你的凭据以继续。")}
							</Text>

							<Form layout="vertical" className="auth-screen__form" onFinish={() => void submit()} requiredMark={false} disabled={busy}>
								<Form.Item label={t("用户名")} htmlFor={`${formId}-username`} required>
									<Input
										id={`${formId}-username`}
										required
										value={username}
										autoComplete="username"
										autoFocus
										spellCheck={false}
										onChange={(event) => setUsername(event.target.value)}
									/>
								</Form.Item>
								<Form.Item label={t("密码")} htmlFor={`${formId}-password`} required>
									<Input.Password
										id={`${formId}-password`}
										required
										value={password}
										autoComplete={mode === "setup" ? "new-password" : "current-password"}
										onChange={(event) => setPassword(event.target.value)}
									/>
								</Form.Item>
								{mode === "setup" ? (
									<Form.Item label={t("确认密码")} htmlFor={`${formId}-confirm`} required>
										<Input.Password
											id={`${formId}-confirm`}
											required
											value={confirm}
											autoComplete="new-password"
											onChange={(event) => setConfirm(event.target.value)}
										/>
									</Form.Item>
								) : (
									<Form.Item>
										<Checkbox checked={remember} onChange={(event) => setRemember(event.target.checked)}>
											{t("记住登录 30 天")}
										</Checkbox>
									</Form.Item>
								)}

								{mode === "login" && sessionNotice ? (
									<Alert
										type="info"
										showIcon
										className="auth-screen__error"
										title={sessionNotice === "session_replaced"
											? getLanguage() === "en" ? "Signed in on another terminal. This terminal has been signed out." : "账号已在其他终端登录，当前终端已退出。"
											: getLanguage() === "en" ? "Your session has expired. Please sign in again." : "登录已失效，请重新登录。"}
									/>
								) : null}
								{error ? <Alert type="error" showIcon title={error} className="auth-screen__error" /> : null}

								<Button
									type="primary"
									htmlType="submit"
									block
									size="large"
									loading={busy}
									disabled={!username.trim() || !password || (mode === "setup" && !confirm)}
								>
									{mode === "setup" ? t("创建并登录") : t("登录")}
								</Button>
							</Form>
							<Text type="secondary" className="auth-screen__note">
								{t("密码只以哈希存在本机")}
							</Text>
						</section>
					</div>
				</main>
			</ConfigProvider>
		</div>
	);
}
