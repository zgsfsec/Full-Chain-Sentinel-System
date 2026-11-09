import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { EngineManager } from "../src/engine.ts";
import { EngineStore } from "../src/engine-store.ts";
import type { SentinelEngine } from "../src/protocol.ts";

interface LiveEntry {
	engine: SentinelEngine;
	commander?: { prompt(text: string): Promise<void>; abort(): Promise<void>; dispose(): void };
	commanderUnsubscribe(): void;
	reportSettled: boolean;
}

interface ManagerProbe {
	live: Map<string, LiveEntry>;
	promptCommander(entry: LiveEntry, text: string): Promise<void>;
	stopCommander(entry: LiveEntry): Promise<void>;
}

test.each(["completed", "paused", "stopped"] as const)(
	"%s engines release the commander after its turn",
	async (status) => {
		const dir = mkdtempSync(join(tmpdir(), "sentinel-commander-lifetime-"));
		const store = new EngineStore(join(dir, "engines.db"));
		const stored = store.createEngine({
			projectId: "p1",
			projectName: "Project",
			name: "Engine",
			targets: [{ target: "example.test" }],
			doctrines: ["attack-defense-web"],
			gateMode: "auto",
			status: "completed",
			startedAt: 0,
			limits: { concurrency: 1, roundLimit: 2, tokenLimit: null, timeLimitMin: null, maxRetries: 1 },
		});
		store.close();
		const manager = new EngineManager(
			dir,
			{
				onChange: () => {},
				onCommanderEvent: () => {},
				onTaskEvent: () => {},
			},
			async () => {
				throw new Error("no worker expected");
			},
		);
		try {
			const probe = manager as unknown as ManagerProbe;
			const entry = probe.live.get(stored.id);
			if (!entry) throw new Error("missing live engine");
			entry.engine.status = "running";
			entry.reportSettled = false;
			const dispose = vi.fn();
			const unsubscribe = vi.fn();
			entry.commanderUnsubscribe = unsubscribe;
			entry.commander = {
				prompt: async () => {
					entry.engine.status = status;
				},
				abort: async () => {},
				dispose,
			};
			await probe.promptCommander(entry, "finish");
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(unsubscribe).toHaveBeenCalledTimes(1);
			expect(entry.commander).toBeUndefined();
		} finally {
			manager.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test("stopping a commander releases it after abort finishes", async () => {
	const probe = Object.create(EngineManager.prototype) as ManagerProbe;
	const calls: string[] = [];
	const entry = {
		commander: {
			prompt: async () => {},
			abort: async () => {
				calls.push("abort");
			},
			dispose: () => {
				calls.push("dispose");
			},
		},
		commanderUnsubscribe: () => {
			calls.push("unsubscribe");
		},
	} as unknown as LiveEntry;
	await probe.stopCommander(entry);
	expect(calls).toEqual(["abort", "unsubscribe", "dispose"]);
	expect(entry.commander).toBeUndefined();
});
