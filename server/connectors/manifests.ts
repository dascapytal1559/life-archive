// Every connector of the core's manifest, listed by hand, for code that cannot read the
// connector folders as the host does (loadRegistry in host.ts). A test holds it to the folders. A module's connectors
// are its own (sdk/server.ts's ModuleConnectors: friend map's twelve chat platforms', the exercise module's polar and
// polar-export); rituals, a module too, has none.

import type { ConnectorManifest } from "./contract.ts";
import { manifest as grokBot } from "./grok-bot/manifest.ts";
import { manifest as llmSessions } from "./llm-sessions/manifest.ts";

export const MANIFESTS: readonly ConnectorManifest[] = [grokBot, llmSessions];
