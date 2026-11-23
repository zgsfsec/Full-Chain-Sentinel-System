import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { EMPTY_MODEL_THINKING, customThinkingSettings, setThinkingDisabled } from "./model-thinking-draft.ts";
import { ThinkingLevelEditor } from "./ThinkingLevelEditor.tsx";

describe("explicit reasoning control", () => {
	test("shows a distinct disable option and explains which calls use it", () => {
		const html = renderToStaticMarkup(<ThinkingLevelEditor value={EMPTY_MODEL_THINKING} onChange={() => {}} />);
		expect(html).toContain("关闭推理");
		expect(html).toContain("守门等角色的后续调用默认关闭推理");
		expect(html).toContain("已有对话保留当前设置");
		expect(html).not.toContain('checked=""');
	});
	test("reflects saved off and disables the strength selector", () => {
		const html = renderToStaticMarkup(<ThinkingLevelEditor value={setThinkingDisabled(EMPTY_MODEL_THINKING, true)} onChange={() => {}} />);
		expect(html).toContain('checked=""');
		expect(html).toContain("ant-select-disabled");
	});
	test("explains when the endpoint does not support off", () => {
		const html = renderToStaticMarkup(<ThinkingLevelEditor value={customThinkingSettings(EMPTY_MODEL_THINKING, ["low", "high"])} onChange={() => {}} />);
		expect(html).toContain("此模型未声明支持关闭推理");
		expect(html).toContain("ant-checkbox-disabled");
	});
});
