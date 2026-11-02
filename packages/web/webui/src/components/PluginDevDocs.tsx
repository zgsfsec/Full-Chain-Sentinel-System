import { CheckOutlined, CopyOutlined, LeftOutlined, RightOutlined } from "@ant-design/icons";
import { Button, Select } from "antd";
import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getLanguage, t } from "../i18n.ts";
import { SettingsBar, SettingsNote } from "../ui/Settings.tsx";
import { PLUGIN_DEV_GUIDE } from "../plugin-dev-guide.ts";
import "../styles/plugin-guide.css";

const labels = getLanguage() === "zh"
	? {
		contents: "章节目录",
		intro: "开始之前",
		description: "按章节查看开发规范与示例，或复制全文交给 AI 编写插件。",
		copySection: "复制本节",
		copyCode: "复制代码",
		copyFailed: "复制失败，请重试",
		plainText: "文本",
		previous: "上一节",
		next: "下一节",
	}
	: {
		contents: "Contents",
		intro: "Before you start",
		description: "Browse the contract and examples by chapter, or copy the full guide for your coding AI.",
		copySection: "Copy chapter",
		copyCode: "Copy code",
		copyFailed: "Copy failed. Try again.",
		plainText: "Text",
		previous: "Previous",
		next: "Next",
	};

// Split only the presentation; the full original contract remains available to copy.
const chapters = PLUGIN_DEV_GUIDE.split(/(?=^## \d+\.)/m).map((markdown, index) => {
	const end = markdown.indexOf("\n");
	return {
		id: index,
		title: index === 0 ? labels.intro : markdown.slice(0, end).replace(/^## \d+\.\s*/, ""),
		body: markdown.slice(end + 1).trim(),
		markdown: markdown.trim(),
	};
});

function CopyButton({ text, label, primary = false }: { text: string; label: string; primary?: boolean }) {
	const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => {
		if (timer.current !== null) clearTimeout(timer.current);
	}, []);

	const copy = async (): Promise<void> => {
		let copied = false;
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
		} catch {
			const previousFocus = document.activeElement;
			const area = document.createElement("textarea");
			area.value = text;
			area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
			document.body.appendChild(area);
			area.select();
			try {
				copied = document.execCommand("copy");
			} catch {
				copied = false;
			} finally {
				area.remove();
				if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
			}
		}
		setStatus(copied ? "copied" : "error");
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = setTimeout(() => setStatus("idle"), 2000);
	};

	return (
		<Button
			type={primary ? "primary" : "text"}
			size="small"
			icon={status === "copied" ? <CheckOutlined /> : <CopyOutlined />}
			onClick={() => void copy()}
			danger={status === "error"}
		>
			<span aria-live="polite">{status === "copied" ? t("已复制") : status === "error" ? labels.copyFailed : label}</span>
		</Button>
	);
}

function GuideCode({ children }: { children?: ReactNode }) {
	const code = Children.toArray(children).find((child) => isValidElement(child));
	if (!isValidElement<{ children?: string; className?: string }>(code)) return <pre>{children}</pre>;
	const language = code.props.className?.replace(/^language-/, "") || labels.plainText;
	return (
		<div className="plugin-guide__code">
			<div className="plugin-guide__code-bar">
				<span>{language}</span>
				<CopyButton text={code.props.children ?? ""} label={labels.copyCode} />
			</div>
			<pre>{children}</pre>
		</div>
	);
}

/** Chapter reader with a full, AI-ready contract available in one copy. */
export function PluginDevDocs() {
	const [active, setActive] = useState(1);
	const chapter = chapters[active];

	return (
		<div className="plugin-guide">
			<SettingsBar
				title={t("开发文档")}
				meta="MCP · Docker"
				extra={<CopyButton text={PLUGIN_DEV_GUIDE} label={t("复制全文")} primary />}
			/>
			<SettingsNote>{labels.description}</SettingsNote>
			<div className="plugin-guide__layout">
				<nav className="plugin-guide__nav" aria-label={labels.contents}>
					<div className="plugin-guide__nav-label">{labels.contents}</div>
					<ol>
						{chapters.map((item) => (
							<li key={item.id}>
								<button type="button" aria-current={active === item.id ? "step" : undefined} onClick={() => setActive(item.id)}>
									<span className="plugin-guide__number">{String(item.id).padStart(2, "0")}</span>
									<span>{item.title}</span>
								</button>
							</li>
						))}
					</ol>
				</nav>
				<div className="plugin-guide__reader">
					<Select
						className="plugin-guide__chapter-select"
						aria-label={labels.contents}
						value={active}
						onChange={setActive}
						options={chapters.map((item) => ({ value: item.id, label: `${item.id}. ${item.title}` }))}
					/>
					<div className="plugin-guide__heading">
						<h2><span>{String(active).padStart(2, "0")}</span>{chapter.title}</h2>
						<CopyButton key={active} text={chapter.markdown} label={labels.copySection} />
					</div>
					<div key={active} className="plugin-guide__body" role="region" aria-label={chapter.title} tabIndex={0}>
						<Markdown remarkPlugins={[remarkGfm]} components={{
							pre: GuideCode,
							a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
						}}>{chapter.body}</Markdown>
					</div>
					<div className="plugin-guide__pagination">
						<Button type="text" size="small" icon={<LeftOutlined />} disabled={active === 0} onClick={() => setActive(active - 1)}>{labels.previous}</Button>
						<span>{active + 1} / {chapters.length}</span>
						<Button type="text" size="small" disabled={active === chapters.length - 1} onClick={() => setActive(active + 1)}>{labels.next}<RightOutlined /></Button>
					</div>
				</div>
			</div>
		</div>
	);
}
