import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CredentialStore } from "../src/credential-store.ts";
import { parseCredential } from "../src/credential-types.ts";
import { EngineManager } from "../src/engine.ts";
import { EngineStore } from "../src/engine-store.ts";
import { securityCheckCategories } from "../src/security-check-categories.ts";
import { parseSecurityCheckMarkdown, parseSecurityCheckRepository } from "../src/security-check-input.ts";
import { SecurityCheckStore } from "../src/security-check-store.ts";
import { SecurityCheckSync } from "../src/security-check-sync.ts";
import { SecurityChecks } from "../src/security-checks.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
});
function root() {
	const dir = mkdtempSync(join(tmpdir(), "security-checks-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
const markdown = (id = "linux", text = "检查账号策略") =>
	`---\nid: ${id}\nname: Linux 账号检查\ncategory: 等保/三级/Linux\ndescription: 账号策略\n---\n${text}`;

test("Markdown normalizes line endings, versions content, and rejects malformed metadata", () => {
	const rule = parseSecurityCheckMarkdown(markdown(), "official");
	expect(parseSecurityCheckMarkdown(markdown().replaceAll("\n", "\r\n"), "official").version).toBe(rule.version);
	expect(parseSecurityCheckMarkdown(markdown("linux", "新版"), "official").version).not.toBe(rule.version);
	for (const value of [
		"无文件头",
		markdown().replace("id: linux", "id: [linux]"),
		markdown().replace("---\n检查", "id: duplicate\n---\n检查"),
		markdown().replace("等保/三级/Linux", "等保/../Linux"),
		markdown("linux", " "),
	])
		expect(() => parseSecurityCheckMarkdown(value, "official")).toThrow();
	expect(parseSecurityCheckRepository("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo");
	for (const repo of [
		"http://github.com/a/b",
		"https://github.com.evil/a/b",
		"https://user:secret@github.com/a/b",
		"https://github.com/a/b/tree/main",
	])
		expect(() => parseSecurityCheckRepository(repo)).toThrow();
});

test("comma-separated categories normalize, deduplicate, and persist through local edits and source sync", () => {
	const store = new SecurityCheckStore(root());
	cleanups.push(() => store.close());
	const category = " 等保 / 三级 / Linux , 主机安全 / 账号，等保/三级/Linux ";
	const input = markdown().replace("等保/三级/Linux", category);
	const rule = store.saveRule(input);
	expect(rule.category).toBe("等保/三级/Linux,主机安全/账号");
	expect(securityCheckCategories(rule.category)).toEqual(["等保/三级/Linux", "主机安全/账号"]);
	expect(store.getRule(rule.id)).toEqual(rule);
	expect(store.saveRule(input.replace(category, rule.category), rule.id, rule.version).version).toBe(rule.version);
	const source = store.getSource("official");
	store.finishSync(source, [parseSecurityCheckMarkdown(input, source.id)], "a".repeat(40), null);
	expect(store.listRules().every((r) => r.category === rule.category)).toBe(true);
	for (const category of [
		"Linux,",
		",Linux",
		"Linux,,数据库",
		"Linux,数据/../库",
		"Linux,数据//库",
		"a".repeat(257),
		Array.from({ length: 17 }, (_, i) => `分类${i}`).join(","),
	]) {
		expect(() => parseSecurityCheckMarkdown(markdown().replace("等保/三级/Linux", category), "local")).toThrow();
	}
});

test("local copies and optimistic edits survive source sync and deleted official sources stay deleted", () => {
	const dir = root();
	const store = new SecurityCheckStore(dir);
	const source = store.getSource("official");
	const rule = parseSecurityCheckMarkdown(markdown(), source.id);
	store.finishSync(source, [rule], "a".repeat(40), null);
	expect(() => store.saveRule(markdown(), rule.id, rule.version)).toThrow("只读");
	const copy = store.saveRule(markdown("local-copy"), undefined, undefined, `${rule.id}@${rule.version}`);
	store.finishSync(
		store.getSource(source.id),
		[parseSecurityCheckMarkdown(markdown("other"), source.id)],
		"b".repeat(40),
		null,
	);
	expect(store.getRule(copy.id).copiedFrom).toContain(rule.id);
	const changed = store.saveRule(markdown("local-copy", "新内容"), copy.id, copy.version);
	expect(() => store.saveRule(markdown("local-copy"), copy.id, copy.version)).toThrow("已修改");
	store.deleteSource("official");
	store.close();
	const reopened = new SecurityCheckStore(dir);
	try {
		expect(reopened.listSources()).toEqual([]);
		expect(reopened.listRules()).toEqual([changed]);
	} finally {
		reopened.close();
	}
});

test("GitHub sync pins downloads, swaps atomically, retains old rules on failure and schedules backoff", async () => {
	const store = new SecurityCheckStore(root());
	cleanups.push(() => store.close());
	let sha = "a".repeat(40);
	let files = ["linux.md"];
	let broken = false;
	const fetcher = vi.fn<typeof fetch>(async (input) => {
		const url = String(input);
		if (url.includes("/commits/")) return Response.json({ sha });
		if (url.includes("/git/trees/"))
			return Response.json({
				tree: files.map((file) => ({
					type: "blob",
					mode: "100644",
					size: 100,
					path: `rules/security-checks/${file}`,
				})),
			});
		expect(url).toContain(`/${sha}/rules/security-checks/`);
		return new Response(
			broken && url.endsWith("bad.md") ? "invalid" : markdown(url.endsWith("bad.md") ? "bad" : "linux"),
		);
	});
	const sync = new SecurityCheckSync(store, fetcher);
	cleanups.push(() => sync.close());
	await sync.sync("official");
	const first = store.listRules();
	expect(first).toHaveLength(1);
	expect(store.getSource("official").nextSyncAt).toBeGreaterThan(Date.now() + 23 * 3600_000);
	await sync.sync("official");
	expect(fetcher).toHaveBeenCalledTimes(4);
	sha = "b".repeat(40);
	files = ["linux.md", "bad.md"];
	broken = true;
	await expect(sync.sync("official")).rejects.toThrow("bad.md");
	expect(store.listRules()).toEqual(first);
	expect(store.getSource("official")).toMatchObject({ failures: 1, commit: "a".repeat(40) });
	expect(store.getSource("official").nextSyncAt).toBeLessThan(Date.now() + 6 * 60_000);
	broken = false;
	files = ["bad.md"];
	await sync.sync("official");
	expect(store.listRules().map((r) => r.ruleId)).toEqual(["bad"]);
	sha = "c".repeat(40);
	files = [];
	await expect(sync.sync("official")).rejects.toThrow("保留");
	expect(store.listRules()).toHaveLength(1);
	const calls = fetcher.mock.calls.length;
	await sync.tick(0);
	expect(fetcher).toHaveBeenCalledTimes(calls);
});

test("editing a source while downloading invalidates its stale sync result", async () => {
	const store = new SecurityCheckStore(root());
	cleanups.push(() => store.close());
	const source = store.getSource("official");
	const fetcher = vi.fn<typeof fetch>(async () => {
		store.saveSource({ ...source, branch: "changed" });
		return Response.json({ sha: "a".repeat(40) });
	});
	const sync = new SecurityCheckSync(store, fetcher);
	cleanups.push(() => sync.close());
	await expect(sync.sync("official")).rejects.toThrow();
	expect(store.getSource("official").branch).toBe("changed");
	expect(store.listRules()).toEqual([]);
});

test("multiple rules submit one ordinary engine with frozen inputs, project credentials and idempotency", async () => {
	const dir = root();
	const project = { id: "p", name: "P", cwd: dir, container: "fixture" };
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify({ projects: [{ ...project, workDir: dir, createdAt: "" }] }),
	);
	const vault = new CredentialStore(dir);
	cleanups.push(() => vault.close());
	const manager = new EngineManager(
		dir,
		{
			onChange: () => {},
			onCommanderEvent: () => {},
			onTaskEvent: () => {},
			beforeStart: async () => ({ ok: false, error: "No Docker fixture" }),
		},
		async () => {
			throw new Error("No worker expected");
		},
	);
	cleanups.push(() => manager.dispose());
	const service = new SecurityChecks(
		dir,
		manager,
		(id) => (id === "p" ? project : undefined),
		() => vault,
	);
	cleanups.push(() => service.dispose());
	const one = service.store.saveRule(markdown());
	const two = service.store.saveRule(markdown("database"));
	const credential = vault.save("p", [
		parseCredential({
			type: "Linux",
			host: "192.0.2.1",
			password: "DO_NOT_COPY",
			fields: [{ key: "key", value: "CUSTOM_SECRET", sensitive: true }],
		}),
	])[0];
	const body = {
		projectId: "p",
		requestId: "request",
		rules: [one, two].map(({ id, version }) => ({ id, version })),
		credentials: [credential].map(({ id, revision }) => ({ id, revision })),
		requirements: "",
		input: {
			name: "检查",
			targets: "",
			doctrines: ["security-check"],
			presetIds: [],
			presetOptional: true,
			gateMode: "auto",
			limits: { concurrency: 2, roundLimit: 5, maxRetries: 1, tokenLimit: null, timeLimitMin: null },
		},
	};
	const submitted = await service.submit(body);
	expect(manager.listEngines()).toHaveLength(1);
	expect(await service.submit(structuredClone(body))).toEqual(submitted);
	const snapshot = manager.getSubmission(submitted.engineId);
	expect(snapshot).toMatchObject({
		source: "security-check",
		credentials: { scope: "project" },
		doctrines: [{ id: "security-check" }],
	});
	expect(JSON.stringify(snapshot)).not.toContain("DO_NOT_COPY");
	expect(JSON.stringify(snapshot)).not.toContain("CUSTOM_SECRET");
	// Security-check submission uses the built-in doctrine even if client input or a custom entry tries to override it.
	writeFileSync(
		join(dir, "doctrines.json"),
		JSON.stringify({ doctrines: [{ id: "security-check", name: "Shadow", text: "SHADOW_DOCTRINE", builtin: true }] }),
	);
	for (const [index, doctrines] of [["code-audit"], [], undefined].entries()) {
		const forced = await service.submit({
			...body,
			requestId: `forced-${index}`,
			input: { ...body.input, doctrines },
		});
		expect(manager.getEngine(forced.engineId)?.doctrines).toEqual(["security-check"]);
		expect(manager.getSubmission(forced.engineId)?.doctrines).toHaveLength(1);
		expect(manager.getSubmission(forced.engineId)?.doctrines[0]).toMatchObject({
			id: "security-check",
			builtin: true,
		});
		expect(manager.getSubmission(forced.engineId)?.doctrines[0].text).toContain(
			"围绕操作员指定目标和所选安全检查规则",
		);
		expect(JSON.stringify(manager.getSubmission(forced.engineId))).not.toContain("SHADOW_DOCTRINE");
	}
	service.store.deleteRule(one.id, one.version);
	expect(await service.submit(body)).toEqual(submitted);
	await expect(service.submit({ ...body, requirements: "changed" })).rejects.toThrow("请求 ID");
	await expect(service.submit({ ...body, projectId: "other" })).rejects.toThrow("项目不存在");
	const other = vault.save("other", [parseCredential({ type: "Linux", host: "192.0.2.2" })])[0];
	await expect(
		service.submit({ ...body, requestId: "cross-project", rules: [two], credentials: [other] }),
	).rejects.toThrow();
	await vi.waitFor(() => expect(manager.getEngine(submitted.engineId)?.status).toBe("paused"));
	const persisted = new EngineStore(join(dir, "engines.db"));
	try {
		expect(persisted.submission(submitted.engineId)).toEqual(snapshot);
	} finally {
		persisted.close();
	}
});
