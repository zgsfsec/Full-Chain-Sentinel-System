import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import type { ClientExample, ServerExample } from "./types.ts";

/** One valid example of each browser-to-server message described in subagents.md. */
export const client = {
	list_subagents: {
		type: "list_subagents",
		offset: 2,
		limit: 3,
	},
	get_subagent: {
		type: "get_subagent",
		id: "id-1",
	},
	abort_subagent: {
		type: "abort_subagent",
		id: "id-1",
	},
	steer_subagent: {
		type: "steer_subagent",
		id: "id-1",
		text: "示例文本",
	},
} satisfies Partial<{ [K in SentinelClientMessage["type"]]: ClientExample<K> }>;

/** One valid example of each server-to-browser message described in subagents.md. */
export const server = {
	subagents: {
		type: "subagents",
		runs: [
			{
				id: "id-1",
				sessionId: "session-1",
				task: "text",
				status: "done",
				turns: 2,
				startedAt: "2026-11-24T08:30:00.000Z",
				endedAt: "2026-11-24T08:30:00.000Z",
				result: "text",
				error: "示例错误信息",
				events: [
					{
						seq: 2,
						kind: "status",
						at: 1763973000000,
					},
				],
			},
		],
		offset: 2,
		total: 2,
	},
	subagent_event: {
		type: "subagent_event",
		runId: "run-1",
		event: {
			seq: 2,
			kind: "status",
			at: 1763973000000,
			text: "示例文本",
			toolName: "示例文本",
			args: null,
			output: "text",
			isError: false,
			status: "done",
			note: "示例文本",
			durationMs: 1250,
			from: "operator",
			truncated: false,
		},
	},
	subagent_run: {
		type: "subagent_run",
		run: {
			id: "id-1",
			sessionId: "session-1",
			task: "text",
			status: "done",
			turns: 2,
			startedAt: "2026-11-24T08:30:00.000Z",
			endedAt: "2026-11-24T08:30:00.000Z",
			result: "text",
			error: "示例错误信息",
			events: [
				{
					seq: 2,
					kind: "status",
					at: 1763973000000,
				},
			],
		},
	},
	subagent_result: {
		type: "subagent_result",
		action: "text",
		id: "id-1",
		ok: true,
		error: "示例错误信息",
	},
} satisfies Partial<{ [K in SentinelServerMessage["type"]]: ServerExample<K> }>;
