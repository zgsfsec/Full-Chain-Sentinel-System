import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { AboutPage } from "./AboutPage.tsx";

vi.mock("../branding.ts", () => ({
	CONSOLE_VERSION: "2.2.12",
	PROJECT_LICENSE: "MIT",
	PROJECT_LICENSE_URL: "https://example.com/license",
	PROJECT_NAME: "Sentinel",
	PROJECT_REPOSITORY: "https://example.com/repo",
	PROJECT_RELEASES_URL: "https://example.com/repo/releases/latest",
	PROJECT_LATEST_RELEASE_API: "https://api.github.com/repos/example/repo/releases/latest",
}));

test("About displays historical totals even when the current session has no usage", () => {
	const html = renderToStaticMarkup(
		<AboutPage
			snapshot={null}
			main={null}
			project={null}
			connected
			stats={{
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
				cumulative: {
					tokens: { input: 12345, output: 6789, cacheRead: 0, cacheWrite: 0, total: 19134 },
					cost: 1.2345,
				},
			}}
		/>,
	);
	expect(html).toContain("12,345");
	expect(html).toContain("6,789");
	expect(html).toContain("19,134");
	expect(html.replace(/<[^>]*>/g, "")).toContain("1.2345");
});
