import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { getSessionDirPath } from "@earendil-works/pi-coding-agent";
import { runDocker } from "./docker.ts";
import type { ProjectStorageUsage } from "./project-storage-types.ts";
import type { SentinelProject } from "./projects.ts";
import {
	projectOpenVpnAuthPath,
	projectOpenVpnConfigPath,
	projectOpenVpnHookPath,
	projectOpenVpnPushedDnsPath,
	projectProxyConfigPath,
	projectResolvConfPath,
	projectWireGuardConfigPath,
} from "./proxy.ts";
import { singboxContainerNameFor } from "./singbox.ts";

type StorageProject = Pick<SentinelProject, "id" | "workDir" | "container">;
interface StorageEntry {
	project: StorageProject;
	usage?: ProjectStorageUsage;
	pending: boolean;
}

/** Like du: allocated blocks, no symlink traversal, and one count per hard link. */
async function directoryUsage(paths: string[], signal: AbortSignal): Promise<{ bytes: number; partial: boolean }> {
	const seen = new Set<string>();
	const pending = [...paths];
	const deadline = Date.now() + 60000;
	let bytes = 0;
	let partial = false;
	while (pending.length > 0) {
		signal.throwIfAborted();
		if (Date.now() > deadline) return { bytes, partial: true };
		const path = pending.pop();
		if (path === undefined) break;
		try {
			const stat = await lstat(path);
			const key = `${stat.dev}:${stat.ino}`;
			if (stat.ino !== 0 && seen.has(key)) continue;
			if (stat.ino !== 0) seen.add(key);
			bytes += Number.isFinite(stat.blocks) ? stat.blocks * 512 : stat.size;
			if (!stat.isDirectory()) continue;
			const directory = await opendir(path);
			for await (const entry of directory) {
				signal.throwIfAborted();
				if (Date.now() > deadline) return { bytes, partial: true };
				pending.push(join(path, entry.name));
			}
		} catch (error) {
			signal.throwIfAborted();
			// Deleted files and optional directories that do not exist consume no space.
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) partial = true;
		}
	}
	return { bytes, partial };
}

export async function measureProjectStorage(
	agentDir: string,
	project: StorageProject,
	signal: AbortSignal = new AbortController().signal,
): Promise<ProjectStorageUsage> {
	const paths = [
		project.workDir,
		getSessionDirPath(project.workDir, agentDir),
		join(agentDir, "mitm", project.id),
		join(agentDir, "gateways", project.id),
		projectProxyConfigPath(agentDir, project.id),
		projectWireGuardConfigPath(agentDir, project.id),
		projectResolvConfPath(agentDir, project.id),
		projectOpenVpnConfigPath(agentDir, project.id),
		projectOpenVpnAuthPath(agentDir, project.id),
		projectOpenVpnHookPath(agentDir, project.id),
		projectOpenVpnPushedDnsPath(agentDir, project.id),
	];
	const names = [...new Set([project.container, singboxContainerNameFor(project.id)])];
	const [host, containers] = await Promise.all([
		directoryUsage(paths, signal),
		runDocker(["container", "inspect", "--size", "--format", "{{.Name}}\t{{.SizeRw}}", ...names], {
			timeoutMs: 15000,
			signal,
		}),
	]);
	const sizes = new Map<string, number>();
	for (const line of containers.stdout.split("\n")) {
		const [name, size] = line.trim().split("\t");
		const bytes = Number(size);
		if (name && size !== undefined && Number.isFinite(bytes) && bytes >= 0) {
			sizes.set(name.replace(/^\//, ""), bytes);
		}
	}
	let containerBytes = 0;
	let partial = host.partial;
	for (const name of names) {
		const size = sizes.get(name);
		if (size !== undefined) containerBytes += size;
		else {
			// Missing containers are normal after "delete container"; daemon and
			// permission failures must instead be shown as an incomplete estimate.
			const missing = containers.stderr
				.split("\n")
				.some(
					(line) =>
						/^Error(?: response from daemon)?: No such (?:object|container): /i.test(line.trim()) &&
						line.trim().endsWith(`: ${name}`),
				);
			if (!missing) partial = true;
		}
	}
	return {
		bytes: host.bytes + containerBytes,
		hostBytes: host.bytes,
		containerBytes,
		partial,
		measuredAt: Date.now(),
	};
}

/** Background scans are bounded to two projects; repeated list requests share cached results. */
export class ProjectStorageCache {
	private readonly entries = new Map<string, StorageEntry>();
	private readonly queue: StorageEntry[] = [];
	private readonly controller = new AbortController();
	private active = 0;
	private readonly agentDir: string;
	private readonly onChange: () => void;
	private readonly measure: typeof measureProjectStorage;

	constructor(agentDir: string, onChange: () => void, measure: typeof measureProjectStorage = measureProjectStorage) {
		this.agentDir = agentDir;
		this.onChange = onChange;
		this.measure = measure;
	}

	get(project: StorageProject, refresh = true): ProjectStorageUsage | undefined {
		let entry = this.entries.get(project.id);
		if (!entry || entry.project.workDir !== project.workDir || entry.project.container !== project.container) {
			entry = { project, pending: false };
			this.entries.set(project.id, entry);
		}
		if (
			refresh &&
			!this.controller.signal.aborted &&
			!entry.pending &&
			(!entry.usage || Date.now() - entry.usage.measuredAt >= 30000)
		) {
			entry.pending = true;
			this.queue.push(entry);
			this.drain();
		}
		return entry.usage;
	}

	retain(ids: Set<string>): void {
		for (const id of this.entries.keys()) {
			if (!ids.has(id)) this.entries.delete(id);
		}
	}

	dispose(): void {
		this.controller.abort();
		this.queue.length = 0;
		this.entries.clear();
	}

	private drain(): void {
		while (this.active < 2 && this.queue.length > 0 && !this.controller.signal.aborted) {
			const entry = this.queue.shift();
			if (!entry) break;
			const { project } = entry;
			if (this.entries.get(project.id) !== entry) continue;
			this.active++;
			void this.measure(this.agentDir, project, this.controller.signal)
				.catch(
					(): ProjectStorageUsage => ({
						bytes: 0,
						hostBytes: 0,
						containerBytes: 0,
						partial: true,
						measuredAt: Date.now(),
					}),
				)
				.then((usage) => {
					if (!this.controller.signal.aborted && this.entries.get(project.id) === entry) {
						entry.usage = usage;
						this.onChange();
					}
				})
				.finally(() => {
					this.active--;
					entry.pending = false;
					this.drain();
				});
		}
	}
}
