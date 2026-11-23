import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { workGraph } from "../../test/work-process-fixtures.ts";
import { WorkLinkFullPage } from "./components/WorkLinkFullPage.tsx";
import { WorkProcessDetail } from "./components/WorkProcessPage.tsx";
import { WorkProcessGraph } from "./components/WorkProcessGraph.tsx";
import { parseWorkLinkPage, workLinkPageHref } from "./work-link-page.ts";

describe("expanded work links page", () => {
	test.each(["session", "engine"] as const)("opens the exact %s in a new page without activating recording", (kind) => {
		const target = { projectId: "项目 & one", kind, id: "run-123" };
		const href = workLinkPageHref(target, "node:child-1");
		expect(parseWorkLinkPage(href)).toEqual({ target, selectedId: "node:child-1" });
		expect(href).not.toContain("项目 & one");
		const html = renderToStaticMarkup(<WorkProcessDetail target={target} />);
		expect(html).toContain("新页面展开"); expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"'); expect(html).toContain("#work-links?");
		expect(html).not.toContain("/control");
	});

	test.each(["", "#other", "#work-links?", "#work-links?projectId=p&kind=bad&id=s", "#work-links?projectId=p&kind=session&id=../outside", "#work-links?projectId=p&kind=session&id=https://external.test", `#work-links?projectId=${"a".repeat(201)}&kind=engine&id=s`])("rejects malformed object references %s", (hash) => { expect(parseWorkLinkPage(hash)).toBeNull(); });

	test("ignores external destinations and invalid node selections", () => {
		const hash = `${workLinkPageHref({ projectId: "p1", kind: "session", id: "s1" })}&redirect=https://external.test&node=${"x".repeat(201)}`;
		expect(parseWorkLinkPage(hash)).toEqual({ target: { projectId: "p1", kind: "session", id: "s1" }, selectedId: null });
	});

	test("offers native fullscreen and a route back without another expand link", () => {
		const html = renderToStaticMarkup(<WorkLinkFullPage hash={workLinkPageHref({ projectId: "p1", kind: "engine", id: "e1" })} />);
		expect(html).toContain("工作链路独立页面"); expect(html).toContain("进入全屏");
		expect(html).toContain("返回控制台"); expect(html).toContain('href="#"'); expect(html).not.toContain("新页面展开");
		expect(renderToStaticMarkup(<WorkLinkFullPage hash="#work-links?" />)).toContain("工作链路链接无效");
	});

	test("the expanded view shows graph controls and selection immediately", () => {
		const html = renderToStaticMarkup(<WorkProcessGraph process={workGraph()} selectedId="root" initialView="graph" onSelect={() => {}} />);
		expect(html).toContain("可滚动链路图"); expect(html).toContain("适应视图");
		expect(html).toContain('aria-pressed="true"'); expect(html).not.toContain('role="tree"');
	});
});
