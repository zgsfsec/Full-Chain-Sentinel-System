import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createHarness } from "../../coding-agent/test/suite/harness.ts";
import { createPocTools } from "../src/poc-tool.ts";
import { PocStore } from "../src/pocs.ts";
import { createSessionTitleTool } from "../src/session-title-tool.ts";
import { createToolWorkflowExtension } from "../src/tool-workflow.ts";

let root: string;
let store: PocStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tool-workflow-"));
	store = new PocStore(join(root, "pocs.db"));
});

test.each([
	{ names: ["web_extract"], context: "公开页面" },
	{ names: ["api_model_read"], context: "已带入" },
	{ names: ["api_model_submit", "api_model_done"], context: "明确要求业务建模" },
	{ names: ["capture_import", "capture_search", "capture_get", "capture_replay"], context: "HTTP 证据" },
	{ names: ["replay_flows", "replay_capture"], context: "报告截图" },
	{
		names: ["droid_devices", "droid_list_packages", "apk_decompile", "apk_manifest", "apk_search"],
		context: "Android",
	},
	{ names: ["droid_frida_setup", "droid_frida_ps", "droid_frida", "droid_unpack"], context: "动态分析" },
	{ names: ["ios_devices", "ios_apps", "ios_app_info", "ios_deps"], context: "iOS" },
	{ names: ["ipa_info", "ipa_files", "ipa_plist", "ipa_strings", "ipa_search"], context: "静态分析" },
	{ names: ["ios_frida_setup", "ios_frida_ps", "ios_frida", "ios_http_log", "ios_decrypt"], context: "动态分析" },
	{ names: ["spawn_agent"], context: "独立子任务" },
])("workflow covers $context with only the active tools: $names", async ({ names, context }) => {
	const tools: ExtensionFactory = (pi) => {
		for (const name of [...names, "poc_search"])
			pi.registerTool({
				name,
				label: name,
				description: name,
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
			});
	};
	const harness = await createHarness({ extensionFactories: [tools, createToolWorkflowExtension()] });
	try {
		harness.session.setActiveToolsByName(names);
		harness.setResponses([fauxAssistantMessage("fixture")]);
		await harness.session.prompt("继续分析当前目标");
		const workflow = getCurrentSystemMessage(harness.session.messages)?.sections?.tool_workflow;
		expect(workflow).toContain(context);
		for (const name of names) expect(workflow).toContain(name);
		expect(workflow).not.toContain("poc_search");
		if (names.includes("api_model_submit")) expect(workflow).toContain("不能因普通渗透任务自行启动建模");
		if (names.includes("replay_capture")) expect(workflow).toContain("会重新发送请求");
	} finally {
		harness.cleanup();
	}
});

test("custom SYSTEM keeps guidelines even when no built-in workflow route matches", async () => {
	const custom: ExtensionFactory = (pi) => {
		pi.registerTool(createSessionTitleTool({ rename: () => {} }));
		pi.on("before_agent_start", (event) => {
			event.systemPromptOptions.customPrompt = "Custom persona.";
		});
	};
	const harness = await createHarness({ extensionFactories: [custom, createToolWorkflowExtension()] });
	try {
		harness.session.setActiveToolsByName(["set_session_title"]);
		harness.setResponses([fauxAssistantMessage("fixture")]);
		await harness.session.prompt("分析目标");
		expect(getCurrentSystemPrompt(harness.session.messages)).toContain("Call set_session_title early");
	} finally {
		harness.cleanup();
	}
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

const businessTools: ExtensionFactory = (pi) => {
	for (const tool of createPocTools({ store })) pi.registerTool(tool);
	for (const name of [
		"asset_list",
		"asset_report",
		"asset_note",
		"vuln_list",
		"vuln_submit",
		"mitm_flows",
		"web_search",
	])
		pi.registerTool({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		});
};

test("ordinary target instructions receive proactive workflow and POC rules in the real model context", async () => {
	const harness = await createHarness({ extensionFactories: [businessTools, createToolWorkflowExtension()] });
	try {
		harness.setResponses([fauxAssistantMessage("fixture")]);
		await harness.session.prompt("评估 https://target.example 的 Tomcat 风险");
		const prompt = getCurrentSystemPrompt(harness.session.messages);
		const system = getCurrentSystemMessage(harness.session.messages);
		expect(system?.toolsAdded?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["poc_search", "poc_read"]));
		expect(prompt).toContain("When the task or reconnaissance identifies a product");
		for (const name of [
			"poc_search",
			"asset_list",
			"vuln_list",
			"mitm_flows",
			"web_search",
			"asset_report",
			"asset_note",
			"vuln_submit",
		])
			expect(system?.sections?.tool_workflow).toContain(name);
		expect(prompt).not.toContain("api_model_submit");
	} finally {
		harness.cleanup();
	}
});

test("custom SYSTEM prompt retains tool constraints and disabled capabilities are absent", async () => {
	const custom: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", (event) => {
			event.systemPromptOptions.customPrompt = "Custom assessment persona.";
		});
	};
	const harness = await createHarness({
		extensionFactories: [businessTools, custom, createToolWorkflowExtension()],
		excludedToolNames: ["mitm_flows", "web_search", "vuln_submit"],
	});
	try {
		harness.setResponses([fauxAssistantMessage("fixture")]);
		await harness.session.prompt("继续目标评估");
		const prompt = getCurrentSystemPrompt(harness.session.messages);
		expect(prompt).toContain("Custom assessment persona.");
		expect(prompt).toContain("poc_search");
		expect(prompt).toContain("template's path and URL prefix");
		const workflow = getCurrentSystemMessage(harness.session.messages)?.sections?.tool_workflow;
		for (const name of ["mitm_flows", "web_search", "vuln_submit"]) expect(workflow).not.toContain(name);
		harness.session.setActiveToolsByName(["poc_read"]);
		harness.setResponses([fauxAssistantMessage("fixture")]);
		await harness.session.prompt("只读取已选模板");
		const readOnly = getCurrentSystemMessage(harness.session.messages)?.sections?.tool_workflow;
		expect(readOnly).toContain("Read several candidate templates in one poc_read call");
		expect(readOnly).not.toContain("poc_search");
		harness.session.setActiveToolsByName([]);
		harness.setResponses([fauxAssistantMessage("fixture")]);
		await harness.session.prompt("只讨论已有结论");
		expect(getCurrentSystemMessage(harness.session.messages)?.sections?.tool_workflow).toBeUndefined();
	} finally {
		harness.cleanup();
	}
});
