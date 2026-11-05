import { Steps, Tooltip } from "antd";
import { getLanguage } from "../i18n.ts";
import type { SentinelCodeCommit } from "../types.ts";

/** Finishing an engine does not prove a vulnerability; the report carries the result. */
export function CodeReproductionProgress({ commit, expanded = false }: { commit: SentinelCodeCommit; expanded?: boolean }) {
	const stage = commit.reproductionStage;
	if (!stage) return <span>—</span>;
	const en = getLanguage() === "en";
	const labels = [en ? "Git" : "Git 拉取", en ? "Engineering" : "工程复现", en ? "Finished" : "结束"];
	const current = stage === "git" || (stage === "failed" && !commit.engineId) ? 0
		: stage === "engineering" || stage === "paused" || stage === "failed" ? 1 : 2;
	const note = stage === "paused" ? (en ? "Paused" : "已暂停")
		: stage === "stopped" ? (en ? "Stopped / removed" : "已停止 / 工程已删除")
		: stage === "failed" ? (commit.error ?? (en ? "Failed" : "失败"))
		: stage === "completed" ? (en ? "Engine finished; review its report for the result" : "工程已结束，复现结果以工程报告为准")
		: current === 0 ? (en ? "Fetching Git sources and preparing both revisions" : "正在拉取 Git 源码并准备漏洞与修复版本")
		: (en ? "Engineering reproduction in progress" : "正在工程中复现");
	if (expanded) return <Steps size="small" current={current} status={stage === "completed" ? "finish" : stage === "failed" || stage === "stopped" ? "error" : stage === "paused" ? "wait" : "process"}
		items={labels.map((title, index) => ({ title, ...(index === current ? { content: note } : {}) }))} />;
	return <Tooltip title={note}>
		<span className="code-intel-reproduction" tabIndex={0} aria-label={`${en ? "Reproduction progress" : "复现进度"}：${note}`}>
			{labels.map((label, index) => <span key={label} className={index < current || stage === "completed" ? "is-finished" : index === current ? stage === "failed" || stage === "stopped" ? "is-error" : "is-active" : ""}>
				{index > 0 ? <span className="code-intel-reproduction__arrow">→</span> : null}
				{index === current && stage === "paused" ? (en ? "Paused" : "已暂停")
					: index === current && stage === "stopped" ? (en ? "Stopped" : "已停止")
					: index === current && stage === "failed" ? (en ? "Failed" : "失败")
					: index === current && stage === "git" ? (en ? "Git running" : "Git 中")
					: index === current && stage === "engineering" ? (en ? "Engineering" : "工程中") : label}
			</span>)}
		</span>
	</Tooltip>;
}
