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
import { createToolWorkflowExtension } from "../src/tool-workflow.ts";

let root: string;
let store: PocStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tool-workflow-"));
	store = new PocStore(join(root, "pocs.db"));
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
		expect(getCurrentSystemMessage(harness.session.messages)?.sections?.tool_workflow).toBeUndefined();
	} finally {
		harness.cleanup();
	}
});
