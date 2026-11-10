// The console's static demo (npm run build:demo; docs/demo.md): the console as the server serves it (../main.tsx and
// everything it loads), over the demo's backend instead of the server (sdk/demo.ts): the routes it answers live in the
// page (backend.ts), every other one from the server's answers recorded as the demo was built, every change refused.

import initSqlJs, { type SqlJsStatic } from "sql.js";
import wasm from "sql.js/dist/sql-wasm-browser.wasm?url";
import { installDemoBackend } from "../../sdk/demo.ts";
import { consoleRoutes } from "./backend.ts";

let sqlite: Promise<SqlJsStatic> | null = null;
installDemoBackend(consoleRoutes, () => (sqlite ??= initSqlJs({ locateFile: () => wasm })));
await import("../main.tsx");
