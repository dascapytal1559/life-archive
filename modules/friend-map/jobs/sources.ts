// What the Events page's Sources tab says of friend map's scheduled jobs on this Mac (sdk/server.ts's `sources`): the
// two that import into its connectors (this Mac's calls and Messages, every 15 minutes; WhatsApp's calls from the Mac
// app), and the Cua Space's rounds, which ask for the platforms' exports and import them as they come.

import type { ExportFeed, JobFeed } from "../../../sdk/server.ts";
import { LAUNCHD_LABEL as WHATSAPP_CALLS_LABEL, STATE_FOLDER as WHATSAPP_CALLS_STATE } from "../connectors/whatsapp-db/macCallsJob.ts";
import { LAUNCHD_LABEL as CUA_LABEL } from "./cuaExports/live.ts";
import { EXPORT_PLATFORMS } from "./cuaExports/plan.ts";
import { readState } from "./cuaExports/round.ts";
import { LAUNCHD_LABEL as MAC_IMPORTS_LABEL, SOURCES as MAC_IMPORT_SOURCES, STATE_FOLDER as MAC_IMPORTS_STATE } from "./macImports/round.ts";

export const FRIEND_MAP_JOBS: readonly JobFeed[] = [
  {
    label: MAC_IMPORTS_LABEL,
    connectors: MAC_IMPORT_SOURCES.map((source) => source.connector),
    note: null,
    install: "npm run mac-imports -- install",
    state: `${MAC_IMPORTS_STATE}/state.json`,
  },
  {
    label: WHATSAPP_CALLS_LABEL,
    connectors: ["whatsapp-db"],
    note: "its calls only, from the Mac app; the rest by hand from an iPhone backup",
    install: "npm run whatsapp-mac-calls -- install",
    state: `${WHATSAPP_CALLS_STATE}/state.json`,
  },
];

export const FRIEND_MAP_EXPORTS: readonly ExportFeed[] = [
  {
    label: CUA_LABEL,
    connectors: EXPORT_PLATFORMS.map(({ connector, everyDays }) => ({ connector, everyDays })),
    install: "npm run cua-exports -- install",
    enable: "npm run cua-exports -- setup --enable",
    schedule: (folder) => readState(folder).then((state) => state.schedule ?? null),
  },
];
