/**
 * Unit tests for permission normalization, focused on the commander section:
 * an absent section reads as off (the file predates it), a fresh install
 * defaults it on, and explicit values survive a round-trip.
 */

import { expect, test } from "vitest";
import {
	defaultPermissions,
	effectiveSubagentPlugins,
	excludeToolsFor,
	normalizePermissions,
	PERMISSION_PRESETS,
	pluginAllowed,
} from "../src/permissions.ts";

test("fresh defaults give the commander its fenced bash and read", () => {
	const config = defaultPermissions();
	expect(config.commander).toEqual({ bash: true, read: true });
});

test("a stored file without a commander section reads it as off", () => {
	const legacy = normalizePermissions({
		main: defaultPermissions().main,
		subagent: defaultPermissions().subagent,
	});
	expect(legacy.commander).toEqual({ bash: false, read: false });
});

test("explicit commander switches survive normalization", () => {
	const config = normalizePermissions({
		main: defaultPermissions().main,
		subagent: defaultPermissions().subagent,
		commander: { bash: true, read: false },
	});
	expect(config.commander).toEqual({ bash: true, read: false });
});

test("corrupt entries in the commander section read as off", () => {
	const config = normalizePermissions({
		main: defaultPermissions().main,
		subagent: defaultPermissions().subagent,
		commander: { bash: "yes", read: 1 },
	});
	expect(config.commander).toEqual({ bash: false, read: false });
});

test("every preset carries a commander set consistent with its philosophy", () => {
	const byId = new Map(PERMISSION_PRESETS.map((preset) => [preset.id, preset]));
	expect(byId.get("standard")?.commander).toEqual({ bash: true, read: true });
	// Recon runs nothing: the commander keeps read but loses bash.
	expect(byId.get("recon")?.commander).toEqual({ bash: false, read: true });
	expect(byId.get("locked")?.commander).toEqual({ bash: false, read: false });
});

test("normalization keeps the sub-agent subset rule intact", () => {
	const config = normalizePermissions({
		main: { ...defaultPermissions().main, bash: false },
		subagent: defaultPermissions().subagent,
		commander: { bash: true, read: true },
	});
	expect(config.main.bash).toBe(false);
	expect(config.subagent.bash).toBe(false);
	expect(config.subagent.spawn_agent).toBe(false);
});

test("the sub-agent turn budget defaults, clamps, and survives a round-trip", () => {
	// A file from before the field existed reads as the default budget.
	expect(normalizePermissions({}).subagentMaxTurns).toBe(defaultPermissions().subagentMaxTurns);
	expect(normalizePermissions({ subagentMaxTurns: 80 }).subagentMaxTurns).toBe(80);
	expect(normalizePermissions({ subagentMaxTurns: 0 }).subagentMaxTurns).toBe(1);
	expect(normalizePermissions({ subagentMaxTurns: 9999 }).subagentMaxTurns).toBe(200);
	expect(normalizePermissions({ subagentMaxTurns: "many" }).subagentMaxTurns).toBe(
		defaultPermissions().subagentMaxTurns,
	);
});

test("a plugin is mounted unless an agent explicitly switched it off", () => {
	const config = defaultPermissions();
	expect(config.plugins).toEqual({ main: {}, subagent: {} });
	// Absent key: the install was the consent, so nothing is unmounted by default.
	expect(pluginAllowed(config.plugins.main, "local/com.sentinel.cmd5")).toBe(true);
	expect(pluginAllowed({ "local/com.sentinel.cmd5": false }, "local/com.sentinel.cmd5")).toBe(false);
});

test("stored plugin switches survive normalization and keep the subset rule", () => {
	const config = normalizePermissions({
		main: defaultPermissions().main,
		subagent: defaultPermissions().subagent,
		plugins: {
			main: { "local/com.sentinel.cmd5": false, "local/com.example.ok": true },
			subagent: { "local/com.example.ok": false },
		},
	});
	expect(config.plugins.main).toEqual({ "local/com.sentinel.cmd5": false, "local/com.example.ok": true });
	// A sub-agent cannot mount what the main agent lost.
	expect(config.plugins.subagent["local/com.sentinel.cmd5"]).toBe(false);
	expect(config.plugins.subagent["local/com.example.ok"]).toBe(false);
});

test("a malformed plugin switch is dropped rather than read as a switch", () => {
	const config = normalizePermissions({
		plugins: { main: { "no-slash-key": false, "local/x": "no", "local/y": false } },
	});
	expect(config.plugins.main).toEqual({ "local/y": false });
});

test("turning read off also denies the discovery tools", () => {
	const full = defaultPermissions().main;
	const excluded = excludeToolsFor({ ...full, read: false });
	expect(excluded).toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
	// Search stays mounted while reading is allowed.
	const allowed = excludeToolsFor(full);
	expect(allowed).not.toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
});

test("the effective sub-agent map is the intersection of both agents", () => {
	const merged = effectiveSubagentPlugins({
		plugins: {
			main: { "a/one": true, "a/two": false },
			subagent: { "a/two": true, "a/three": false },
		},
	});
	expect(merged).toEqual({ "a/one": true, "a/two": false, "a/three": false });
});

test("asset library switches exist, default on, and recon is read-only", () => {
	const fresh = defaultPermissions();
	expect(fresh.main.asset_library_write).toBe(true);
	expect(fresh.main.asset_library_read).toBe(true);
	const byId = new Map(PERMISSION_PRESETS.map((preset) => [preset.id, preset]));
	expect(byId.get("recon")?.main.asset_library_write).toBe(false);
	expect(byId.get("recon")?.main.asset_library_read).toBe(true);
	expect(byId.get("locked")?.main.asset_library_write).toBe(false);
	expect(byId.get("locked")?.main.asset_library_read).toBe(false);
	// A disabled switch must actually remove the tools, not just hide a button.
	const off = excludeToolsFor({ ...fresh.main, asset_library_write: false, asset_library_read: false });
	expect(off).toEqual(expect.arrayContaining(["asset_report", "asset_note", "asset_list", "asset_get"]));
});

test("MITM reads obey presets, explicit opt-in for stored files, denylist and the sub-agent subset", () => {
	const fresh = defaultPermissions();
	expect(fresh.main.mitm_read).toBe(true);
	expect(fresh.subagent.mitm_read).toBe(true);
	expect(PERMISSION_PRESETS.find((preset) => preset.id === "recon")?.main.mitm_read).toBe(true);
	expect(PERMISSION_PRESETS.find((preset) => preset.id === "locked")?.main.mitm_read).toBe(false);
	const { mitm_read: _omitted, ...stored } = fresh.main;
	expect(normalizePermissions({ main: stored, subagent: fresh.subagent }).main.mitm_read).toBe(false);
	expect(normalizePermissions({ main: stored, subagent: fresh.subagent }).subagent.mitm_read).toBe(false);
	expect(excludeToolsFor({ ...fresh.main, mitm_read: false })).toEqual(
		expect.arrayContaining(["mitm_flows", "mitm_flow_get", "mitm_flow_read"]),
	);
	expect(excludeToolsFor(fresh.main)).not.toContain("mitm_flows");
});
