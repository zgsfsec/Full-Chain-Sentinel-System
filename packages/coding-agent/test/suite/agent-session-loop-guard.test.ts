/**
 * End-to-end check of the loop-guard extension inside a real AgentSession.
 *
 * The unit tests call the handlers directly, which cannot show whether the
 * boundary contract works: the extension asks the session to continue by
 * committing a `custom_message` draft and returning `continue: true`, and the
 * session only honours that when the injected message leaves runnable context.
 * This test drives a real (faux) provider through a stuttering response and
 * asserts that the run was cut short, that the nudge reached the model, and that
 * the session actually took another round instead of settling.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import loopGuardExtension from "../../src/extensions/loop-guard/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

const STUTTER = `分析结果如下：\n\n${"Kingston.\n\n".repeat(40)}`;

describe("loop-guard extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("preserves normal reports with code fences and shared phrases across table rows", async () => {
		const text =
			Array.from(
				{ length: 16 },
				(_, index) => `### Case ${index}\n\`\`\`typescript\nconst result${index} = check(${index});\n\`\`\`\n`,
			).join("\n") +
			Array.from(
				{ length: 20 },
				(_, index) => `| ${index} | request completed successfully | result-${index} |\n`,
			).join("");
		const harness = await createHarness({ extensionFactories: [loopGuardExtension] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(text), fauxAssistantMessage("Unexpected continuation")]);

		await harness.session.prompt("输出检查报告");

		expect(getAssistantTexts(harness)).toEqual([text]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "zg-loop-guard"),
		).toBe(false);
	});

	it("aborts a stuttering response and continues with a nudge", async () => {
		const requests: string[] = [];
		const harness = await createHarness({ extensionFactories: [loopGuardExtension] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(STUTTER),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("换一种方式继续。");
			},
		]);

		await harness.session.prompt("继续挖");

		// The next run consumed the second response, with the nudge in its context.
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("【输出重复】");
		// The repeated tail is gone from the context; the nudge quotes one occurrence.
		expect(requests[0]).not.toContain("Kingston.\\n\\nKingston.");
		expect(requests[0]).toContain("[输出因重复被中止，尾部已截断]");

		const guard = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === "zg-loop-guard");
		expect(guard).toMatchObject({ type: "custom_message", display: true });

		const first = getAssistantTexts(harness)[0];
		expect(first).toContain("分析结果如下：");
		expect(first).not.toContain("Kingston.");
		expect(first).toContain("[输出因重复被中止，尾部已截断]");
	});
});
