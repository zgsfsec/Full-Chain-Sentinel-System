import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { AssetImportPreviewBody } from "./AssetImportDialog.tsx";

test("preview distinguishes new and existing assets and makes invalid input skipping explicit", () => {
	const html = renderToStaticMarkup(<AssetImportPreviewBody preview={{
		created: 1, merged: 1, duplicates: 2,
		items: [{ input: "EXAMPLE.COM", kind: "domain", name: "example.com", existing: true, warnings: [] }, { input: "10.0.0.1", kind: "ip", name: "10.0.0.1", existing: false, warnings: [] }],
		invalid: [{ input: "invalid", reason: "无法识别" }],
	}} />);
	expect(html).toContain("合并已有");
	expect(html).toContain("新增");
	expect(html).toContain("example.com");
	expect(html).toContain("10.0.0.1");
	expect(html).toContain("无法识别的内容会跳过");
	expect(html).toContain("粘贴内重复");
});
