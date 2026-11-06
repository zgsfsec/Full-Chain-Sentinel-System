/** Execute the real shell runtime with network commands replaced by local mocks. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GATEWAY_RUNTIME } from "../src/gateway-runtime.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(
	options: {
		ipv6?: "enabled" | "kernel-disabled" | "sysctl-disabled" | "interface-enabled" | "default-enabled";
		missingTool?: string;
	} = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "sentinel-gateway-runtime-"));
	roots.push(directory);
	const root = join(directory, "run");
	const config = join(directory, "config");
	const proc = join(directory, "ipv6");
	const bin = join(directory, "bin");
	const log = join(directory, "commands.log");
	mkdirSync(bin);
	mkdirSync(join(config, "candidate"), { recursive: true });
	writeFileSync(join(config, "candidate", "mode"), "off");
	writeFileSync(join(config, "candidate", "hash"), "first");
	writeFileSync(join(config, "candidate", "resolv.conf"), "nameserver 127.0.0.11\n");
	if (options.ipv6 !== "kernel-disabled") {
		for (const name of ["all", "default", "lo", "eth0"]) {
			const enabled =
				!options.ipv6 ||
				options.ipv6 === "enabled" ||
				(options.ipv6 === "interface-enabled" && name === "eth0") ||
				(options.ipv6 === "default-enabled" && name === "default");
			const path = join(proc, "conf", name);
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "disable_ipv6"), enabled ? "0\n" : "1\n");
		}
	}
	const mock = join(bin, "mock-tool");
	writeFileSync(
		mock,
		String.raw`#!/bin/sh
name=$(basename "$0")
printf '%s %s\n' "$name" "$*" >> "$GATEWAY_TEST_LOG"
if [ -n "$GATEWAY_TEST_FAIL" ]; then
  case "$name $*" in "$GATEWAY_TEST_FAIL"*) echo 'RTNETLINK answers: Operation not permitted' >&2; exit 2 ;; esac
fi
case "$name $*" in
  "ip link show "*|"ip -4 rule del pref 0"|"ip -6 rule del pref 0"|"iptables -C "*|"ip6tables -C "*) exit 1 ;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
	for (const tool of [
		"ip",
		"iptables",
		"iptables-save",
		"iptables-restore",
		"ip6tables",
		"ip6tables-save",
		"ip6tables-restore",
		"curl",
		"timeout",
		"mknod",
	]) {
		if (tool !== options.missingTool) symlinkSync(mock, join(bin, tool));
	}
	// Never touch host devices, routing, resolver files or sysctls.
	const script = join(directory, "runtime.sh");
	writeFileSync(
		script,
		GATEWAY_RUNTIME.replaceAll("/run/sentinel-gateway", root)
			.replaceAll("/etc/sentinel-gateway", config)
			.replaceAll("/etc/resolv.conf", join(directory, "resolv.conf"))
			.replaceAll("/dev/net", join(directory, "dev-net"))
			.replaceAll("/proc/sys/net/ipv6", proc),
	);
	return {
		root,
		config,
		run(action: string, fail = "") {
			writeFileSync(log, "");
			const result = spawnSync("/bin/sh", [script, action], {
				encoding: "utf8",
				timeout: 5000,
				env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, GATEWAY_TEST_LOG: log, GATEWAY_TEST_FAIL: fail },
			});
			expect(result.error).toBeUndefined();
			return { ...result, commands: readFileSync(log, "utf8") };
		},
	};
}

// Regression: creating an IPv4 project failed on an IPv6-disabled Docker kernel.
test.each(["kernel-disabled", "sysctl-disabled"] as const)(
	"initializes and switches without IPv6 tools when IPv6 is %s",
	(ipv6) => {
		const runtime = setup({ ipv6, missingTool: "ip6tables" });
		const probe = runtime.run("probe");
		expect(probe.status).toBe(0);
		expect(probe.stdout).toContain("gateway-ready: 4\n");
		expect(existsSync(join(runtime.root, "ready"))).toBe(true);
		expect(probe.commands).not.toMatch(/ip -6|ip6tables/);
		for (const hash of ["first", "second"]) {
			writeFileSync(join(runtime.config, "candidate", "hash"), hash);
			const applied = runtime.run("apply");
			expect(applied.status).toBe(0);
			expect(applied.commands).toContain("ip -4 rule restore");
			expect(applied.commands).toContain("iptables-restore");
			expect(applied.commands).not.toMatch(/ip -6|ip6tables/);
			expect(runtime.run("status").stdout).toBe(hash);
		}
	},
);

test.each(["enabled", "interface-enabled", "default-enabled"] as const)(
	"keeps IPv6 rules and firewall protection when IPv6 is %s",
	(ipv6) => {
		const runtime = setup({ ipv6 });
		const probe = runtime.run("probe");
		expect(probe.status).toBe(0);
		expect(probe.stdout).toContain("gateway-ready: 4 6");
		expect(probe.commands).toContain("ip -6 rule save");
		expect(probe.commands).toContain("ip6tables-save");
		expect(probe.commands).toContain("ip6tables -I OUTPUT");
		const applied = runtime.run("apply");
		expect(applied.status).toBe(0);
		expect(applied.commands).toContain("ip -6 route restore");
		expect(applied.commands).toContain("ip6tables-restore");
	},
);

test.each(["ip -6 rule save", "ip6tables-save", "ip6tables -I"])(
	"does not mistake an IPv6 permission failure for disabled IPv6: %s",
	(command) => {
		const runtime = setup();
		const result = runtime.run("probe", command);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Operation not permitted");
		expect(result.stderr).toContain("gateway init failed:");
		expect(existsSync(join(runtime.root, "ready"))).toBe(false);
	},
);

test("reports missing IPv6 tools when IPv6 is enabled", () => {
	const runtime = setup({ missingTool: "ip6tables" });
	const result = runtime.run("probe");
	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain("missing gateway tool: ip6tables");
});

test("restores the previous IPv4 exit when a client cannot start", () => {
	const runtime = setup({ ipv6: "kernel-disabled" });
	expect(runtime.run("probe").status).toBe(0);
	expect(runtime.run("apply").status).toBe(0);
	writeFileSync(join(runtime.config, "candidate", "mode"), "invalid-client");
	writeFileSync(join(runtime.config, "candidate", "hash"), "bad");
	const result = runtime.run("apply");
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("rollback");
	expect(result.commands).not.toMatch(/ip -6|ip6tables/);
	expect(runtime.run("status").stdout).toBe("first");
});

test.each(["kernel-disabled", "enabled"] as const)(
	"a failed IPv4 firewall block is never reported as contained with IPv6 %s",
	(ipv6) => {
		const runtime = setup({ ipv6 });
		expect(runtime.run("probe").status).toBe(0);
		writeFileSync(join(runtime.config, "candidate", "mode"), "invalid-client");
		const failed = runtime.run("apply", "iptables -I");
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).toContain("containment-failed");
		expect(failed.stderr).not.toContain("\nblocked\n");
	},
);
