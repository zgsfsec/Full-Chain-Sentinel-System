import type { SentinelClientMessage, SentinelServerMessage } from "../../../src/protocol.ts";
import * as assets from "./assets.ts";
import * as code_intel from "./code-intel.ts";
import * as connection from "./connection.ts";
import * as credentials_mcp from "./credentials-mcp.ts";
import * as devices from "./devices.ts";
import * as discovery from "./discovery.ts";
import * as engine from "./engine.ts";
import * as environment from "./environment.ts";
import * as files_terminal from "./files-terminal.ts";
import * as gatekeeper from "./gatekeeper.ts";
import * as modeling from "./modeling.ts";
import * as models from "./models.ts";
import * as permissions_presets from "./permissions-presets.ts";
import * as plugins from "./plugins.ts";
import * as pocs from "./pocs.ts";
import * as projects from "./projects.ts";
import * as proxy from "./proxy.ts";
import * as session from "./session.ts";
import * as subagents from "./subagents.ts";
import * as supervisor from "./supervisor.ts";
import type { ClientExample, ServerExample } from "./types.ts";
import * as vulns from "./vulns.ts";

/** Every browser-to-server message with one valid example. The compiler rejects a missing or extra message. */
export const CLIENT_EXAMPLES = {
	...connection.client,
	...session.client,
	...subagents.client,
	...models.client,
	...gatekeeper.client,
	...permissions_presets.client,
	...environment.client,
	...proxy.client,
	...projects.client,
	...files_terminal.client,
	...vulns.client,
	...assets.client,
	...discovery.client,
	...pocs.client,
	...modeling.client,
	...devices.client,
	...credentials_mcp.client,
	...code_intel.client,
	...engine.client,
	...plugins.client,
	...supervisor.client,
} satisfies { [K in SentinelClientMessage["type"]]: ClientExample<K> };

/** Every server-to-browser message with one valid example. The compiler rejects a missing or extra message. */
export const SERVER_EXAMPLES = {
	...connection.server,
	...session.server,
	...subagents.server,
	...models.server,
	...gatekeeper.server,
	...permissions_presets.server,
	...environment.server,
	...proxy.server,
	...projects.server,
	...files_terminal.server,
	...vulns.server,
	...assets.server,
	...discovery.server,
	...pocs.server,
	...modeling.server,
	...devices.server,
	...credentials_mcp.server,
	...code_intel.server,
	...engine.server,
	...plugins.server,
	...supervisor.server,
} satisfies { [K in SentinelServerMessage["type"]]: ServerExample<K> };
