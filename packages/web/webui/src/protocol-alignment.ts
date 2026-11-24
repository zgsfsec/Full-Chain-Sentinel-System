/**
 * Compile-time proof that the browser's copy of the wire protocol still matches
 * the server's.
 *
 * `webui/src/types.ts` mirrors `src/protocol.ts` by hand, because the browser
 * bundle must not import the agent SDK, and nothing else keeps the two in step.
 * This file makes `npm run check` fail when a message changes on one side only.
 *
 * A message has drifted when a value that is valid for one side is not valid for
 * the other. Drift that is understood is listed in the ACCEPTED_DRIFT constants,
 * one message per line, with its reason in
 * `docs/contract/websocket/type-alignment.md`. `test/contract/docs.test.ts`
 * reads those constants as text, so write each name as `"name",` on its own line.
 *
 * The SDK types the browser copy is compared with come from the SDK's built
 * declarations (`node_modules`), which is what `check:webui` resolves.
 */
import type { SentinelClientMessage, SentinelServerMessage } from "../../src/protocol.ts";
import type {
	SentinelClientMessage as BrowserClientMessage,
	SentinelServerMessage as BrowserServerMessage,
} from "./types.ts";

interface Message {
	type: string;
}

/** Message types that exist on the left side only. */
type Only<Left extends Message, Right extends Message> = Exclude<Left["type"], Right["type"]>;

/** Message types whose two definitions are not interchangeable. */
type Drift<Left extends Message, Right extends Message> = {
	[K in Left["type"] & Right["type"]]: Extract<Left, { type: K }> extends Extract<Right, { type: K }>
		? Extract<Right, { type: K }> extends Extract<Left, { type: K }>
			? never
			: K
		: K;
}[Left["type"] & Right["type"]];

const ACCEPTED_CLIENT_DRIFT = [] as const satisfies readonly SentinelClientMessage["type"][];
const ACCEPTED_SERVER_DRIFT = [
	// The server's records require platform, appPackage and appVersion; the browser copy lacks them.
	"vuln",
	"vulns",
	"asset",
	// The server type says Date; on the wire it is an ISO string, as the browser copy says.
	"sessions",
	// The server types snapshot.messages as unknown[]; the browser copy has the real shape.
	"snapshot",
	// The server sends the whole SDK SessionStats plus cumulative; the browser copy reads a subset.
	"stats",
	// The server's trigger union has "long-call"; the browser copy does not.
	"supervisor_detail",
	"supervisor_episode",
	// The server forwards every SDK agent event; the browser copy is a widened subset.
	"session_event",
	// The server's tree nodes have labelTimestamp and exact entries; the browser copy is widened.
	"tree",
	// Only the browser copy declares certPin on droid_state; the server sends it on ios_state only.
	"droid_state",
] as const satisfies readonly SentinelServerMessage["type"][];

type Accepted<Names extends readonly string[]> = Names[number];

/** Compiles only when called with nothing at all. */
function requireNone(value: never): void {}

declare const clientOnlyOnServer: Only<SentinelClientMessage, BrowserClientMessage>;
declare const clientOnlyInBrowser: Only<BrowserClientMessage, SentinelClientMessage>;
declare const serverOnlyOnServer: Only<SentinelServerMessage, BrowserServerMessage>;
declare const serverOnlyInBrowser: Only<BrowserServerMessage, SentinelServerMessage>;
declare const clientDrift: Exclude<Drift<SentinelClientMessage, BrowserClientMessage>, Accepted<typeof ACCEPTED_CLIENT_DRIFT>>;
declare const serverDrift: Exclude<Drift<SentinelServerMessage, BrowserServerMessage>, Accepted<typeof ACCEPTED_SERVER_DRIFT>>;

requireNone(clientOnlyOnServer);
requireNone(clientOnlyInBrowser);
requireNone(serverOnlyOnServer);
requireNone(serverOnlyInBrowser);
requireNone(clientDrift);
requireNone(serverDrift);
