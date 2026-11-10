// friend-map's page in the life archive's static demo (npm run build:demo; the core's docs/demo.md), as the console's
// Friend Map frames it: the page as the archive's server serves it (../src/main.tsx and everything it loads), over the
// demo's backend instead of the server (sdk/demo.ts). A person's messages, a chat's pages and its days are answered in
// the page with the server's own reads (../../demo.ts's contentRoutes) over the made-up archive; everything else from
// the server's answers recorded as the demo was built. Its handshake is the server's, less what the demo does not do:
// no change of any kind (so the page is read-only, readOnly.ts), no live reload, no drafts or sends, no model, and
// the Query bar's queries run in the page (over the people the server listed) rather than by the server.

import initSqlJs, { type SqlJsStatic } from "sql.js";
import wasm from "sql.js/dist/sql-wasm-browser.wasm?url";
import { installDemoBackend } from "../../../../sdk/demo.ts";
import type { Capability, Contract } from "../../../../sdk/contract.ts";
import { contentRoutes } from "../../demo.ts";
import { address } from "../src/mount.ts";

/** What of the server's handshake the demo serves: its reads. */
const DEMO_CAPABILITIES: readonly Capability[] = ["map", "score-report", "panel", "content", "table", "calendar", "river", "identity", "changes", "scores"];

const CONTRACT = address("/api/archive/contract");

let sqlite: Promise<SqlJsStatic> | null = null;
installDemoBackend(
  (context) => [
    {
      matches: (url) => url.pathname === CONTRACT,
      answer: async () => {
        const contract = (await context.recorded(CONTRACT))?.body as Contract | undefined;
        return contract && { ...contract, capabilities: contract.capabilities.filter((c) => (DEMO_CAPABILITIES as readonly string[]).includes(c)) };
      },
    },
    contentRoutes(address("/api/archive/content/")),
  ],
  () => (sqlite ??= initSqlJs({ locateFile: () => wasm })),
);
await import("../src/main.tsx");
