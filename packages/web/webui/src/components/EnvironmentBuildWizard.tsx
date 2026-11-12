import { Button, Descriptions, Form, Input, Modal, Radio, Steps } from "antd";
import { useState } from "react";
import { t } from "../i18n.ts";
import type { SentinelSources } from "../types.ts";

export const CHINA_SOURCES: SentinelSources = {
	baseImage: "docker.m.daocloud.io/kalilinux/kali-rolling:latest",
	aptMirror: "http://mirrors.tuna.tsinghua.edu.cn/kali",
	pipIndex: "https://pypi.tuna.tsinghua.edu.cn/simple",
	npmRegistry: "https://registry.npmmirror.com",
	goProxy: "https://goproxy.cn,direct",
};
export const EMPTY_SOURCES: SentinelSources = {
	baseImage: "",
	aptMirror: "",
	pipIndex: "",
	npmRegistry: "",
	goProxy: "",
};
const FIELDS: { key: keyof SentinelSources; label: string }[] = [
	{ key: "baseImage", label: "基础镜像" },
	{ key: "aptMirror", label: "apt 源" },
	{ key: "pipIndex", label: "pip 源" },
	{ key: "npmRegistry", label: "npm 源" },
	{ key: "goProxy", label: "go 代理" },
];

export function EnvironmentBuildWizard({
	initial,
	onCancel,
	onBuild,
}: {
	initial: SentinelSources;
	onCancel(): void;
	onBuild(sources: SentinelSources): void;
}) {
	const [step, setStep] = useState(0);
	const [choice, setChoice] = useState("saved");
	const [sources, setSources] = useState(initial);
	return (
		<Modal
			open
			title={t("构建工具镜像")}
			onCancel={onCancel}
			footer={
				step === 0 ? (
					<Button type="primary" onClick={() => setStep(1)}>
						{t("下一步")}
					</Button>
				) : (
					<>
						<Button onClick={() => setStep(0)}>{t("上一步")}</Button>
						<Button type="primary" onClick={() => onBuild(sources)}>
							{t("确认构建")}
						</Button>
					</>
				)
			}
		>
			<Steps size="small" current={step} items={[{ title: t("选择构建源") }, { title: t("确认并构建") }]} />
			{step === 0 ? (
				<>
					<p>{t("是否使用国内源？国内网络可选择中国镜像源，也可保留已有配置或使用官方源。")}</p>
					<Radio.Group
						value={choice}
						onChange={(event) => {
							const value = String(event.target.value);
							setChoice(value);
							setSources(value === "china" ? CHINA_SOURCES : value === "official" ? EMPTY_SOURCES : initial);
						}}
						options={[
							{ value: "saved", label: t("保留当前配置") },
							{ value: "china", label: t("中国镜像源") },
							{ value: "official", label: t("官方源") },
						]}
					/>
					<Form layout="vertical" style={{ marginTop: 16 }}>
						{FIELDS.map((field) => (
							<Form.Item key={field.key} label={t(field.label)}>
								<Input
									value={sources[field.key]}
									placeholder={t("留空使用官方源")}
									spellCheck={false}
									onChange={(event) => {
										setChoice("custom");
										setSources((current) => ({ ...current, [field.key]: event.target.value }));
									}}
								/>
							</Form.Item>
						))}
					</Form>
				</>
			) : (
				<>
					<p>{t("将保存以下构建源并构建 sentinel:latest，首次约 5–15 分钟。构建结束后继续拉取网络与代理镜像。")}</p>
					<Descriptions
						size="small"
						column={1}
						items={FIELDS.map((field) => ({
							key: field.key,
							label: t(field.label),
							children: sources[field.key] || t("官方源"),
						}))}
					/>
				</>
			)}
		</Modal>
	);
}
