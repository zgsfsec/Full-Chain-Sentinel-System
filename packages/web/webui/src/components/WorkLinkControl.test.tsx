import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Composer } from "./Composer.tsx";
import { WorkLinkControl } from "./WorkLinkControl.tsx";

const props: ComponentProps<typeof Composer> = {
	streaming: false, stats: null, throughput: null, hasProject: true, supportsImageInput: false,
	projectId: "p1", sessionId: "s1", blockedReason: null, notifyRun: false, goalDisabledReason: null,
	modeling: null, modelingAttached: [], droidEnabled: false, iosEnabled: false, credentialsEnabled: false,
	reportsEnabled: false, reportsReadOnly: false, apiModels: [], freshConversation: true, presets: [], preset: null,
	supervisor: null, supervisorEnabled: true, supervisorWindowOpen: false,
	supervisorDefaultStrategies: [], supervisorCustomStrategies: [],
	onToggleDroid: () => {}, onToggleIos: () => {}, onToggleCredentials: () => {}, onToggleReports: () => {},
	onArmSupervisor: () => {}, onShowSupervisorWindow: () => {}, onToggleNotifyRun: () => {}, onOpenGoal: () => {},
	onStartModeling: () => {}, onEndModeling: () => {}, onDetachModeling: () => {}, onSetPreset: () => {}, onSend: () => {}, onAbort: () => {},
};

describe("conversation work link entry", () => {
	test("places work links directly after supervision and before presets", () => {
		const html = renderToStaticMarkup(<Composer {...props} />);
		const supervisor = html.indexOf("开启监督：");
		const links = html.indexOf('aria-label="工作链路"');
		const presets = html.indexOf("给这个会话挂一个预设 Agent");
		expect(supervisor).toBeGreaterThan(0);
		expect(links).toBeGreaterThan(supervisor);
		expect(presets).toBeGreaterThan(links);
	});

	test("keeps work links independent of supervision and available during an existing run", () => {
		const html = renderToStaticMarkup(<Composer {...props} supervisorEnabled={false} streaming freshConversation={false} />);
		expect(html).toContain('aria-label="工作链路"');
		expect(html).not.toContain("开启监督：");
		expect(renderToStaticMarkup(<WorkLinkControl projectId="p1" sessionId="s1" />)).not.toContain("disabled");
	});

	test.each([[null, "s1"], ["p1", null]])("disables recording without a project or conversation (%s, %s)", (projectId, sessionId) => {
		expect(renderToStaticMarkup(<WorkLinkControl projectId={projectId} sessionId={sessionId} />)).toContain("disabled");
	});
});
