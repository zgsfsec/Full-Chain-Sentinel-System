import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";

export type ClientType = SentinelClientMessage["type"];
export type ServerType = SentinelServerMessage["type"];

/** The shape of one browser-to-server message. */
export type ClientExample<K extends ClientType> = Extract<SentinelClientMessage, { type: K }>;

type RawServerExample<K extends ServerType> = Extract<SentinelServerMessage, { type: K }>;
type RawSessionEntry = RawServerExample<"sessions">["sessions"][number];
type RawStats = RawServerExample<"stats">["stats"];

/**
 * The shape of one server-to-browser message as it is on the wire. The server
 * types describe values before they are serialized; these are the places where
 * that shows:
 *
 * - the session list has dates, which JSON writes as ISO strings;
 * - the usage statistics leave `sessionFile` out while no conversation is
 *   selected (the server sets it to `undefined`, which JSON drops).
 */
export type ServerExample<K extends ServerType> = K extends "sessions"
	? Omit<RawServerExample<K>, "sessions"> & {
			sessions: Array<Omit<RawSessionEntry, "created" | "modified"> & { created: string; modified: string }>;
		}
	: K extends "stats"
		? Omit<RawServerExample<K>, "stats"> & {
				stats: Omit<RawStats, "sessionFile"> & { sessionFile?: RawStats["sessionFile"] };
			}
		: RawServerExample<K>;
