import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

/** One valid example of each browser-to-server message described in projects.md. */
export const client = {
	list_projects: {
		type: "list_projects",
	},
	add_project: {
		type: "add_project",
		name: "示例文本",
		proxyNode: "text",
	},
	remove_project: {
		type: "remove_project",
		id: "id-1",
		confirmName: "示例文本",
		scope: "data",
	},
	stop_project: {
		type: "stop_project",
		id: "id-1",
	},
	start_project: {
		type: "start_project",
		id: "id-1",
	},
	recreate_project: {
		type: "recreate_project",
		id: "id-1",
	},
	switch_project: {
		type: "switch_project",
		id: "id-1",
	},
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

/** One valid example of each server-to-browser message described in projects.md. */
export const server = {
	projects: {
		type: "projects",
		projects: [
			{
				id: "id-1",
				name: "示例文本",
				cwd: "/work",
				storage: {
					bytes: 2,
					hostBytes: 2,
					containerBytes: 2,
					partial: true,
					measuredAt: 1763973000000,
				},
				container: "sentinel-project-1",
				sessionCount: 2,
				state: "missing",
				manualStop: false,
				vulnCount: 2,
				assetCount: 2,
				gateCount: 2,
				proxyName: "示例文本",
				proxyNode: "text",
				proxyNodeName: "示例文本",
			},
		],
		activeProjectId: "active-project-1",
	},
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
