// The life archive's server: the only process that opens the archive. It answers the archive's routes (/api/archive/...,
// server/archive/http.ts) on this Mac alone, runs the live connectors, Codex for the Query bar's Generate, and prunes
// the backups at start. friend-map's server passes its page's archive requests to it and reads the facts it scores
// from it (friend-map's server/archiveProxy.ts and server/archiveClient.ts). It also serves the archive's own viewer
// at /life-archive/ (the page in viewer/, through Vite; its read API in server/viewer/, and the Health tab's results
// at /life-archive/api/m/health, modules/health/server/http.ts), which Tailscale Serve mounts on the tailnet, as it never
// mounts /api/archive/.
//
//   npm start  ->  http://127.0.0.1:4650/api/archive/... and http://127.0.0.1:4650/life-archive/
//                  (launchd's local.life-archive keeps it running)
//
// LIFE_ARCHIVE_URL (the environment or .env.local; dataHome.ts) says where it answers, as friend-map reaches it: its
// port is the one taken, and it is never reachable from another machine but through friend-map. The archive's folder
// is LIFE_ARCHIVE_DATA (dataHome.ts). As friend-map's server passes the browser's Host on, it admits localhost and the
// names in LIFE_ARCHIVE_ALLOWED_HOSTS and FRIEND_MAP_ALLOWED_HOSTS, so a page friend-map serves on the tailnet reaches
// it, and a DNS-rebinding page does not. friend-map names the archive's folder it was given on every request
// (ARCHIVE_FOLDER_HEADER), and is answered 503 when it is not this one's, so friend-map on a testing folder never meets
// the real archive.
//
// What it opens and runs is one Layer (serverLayer.ts), built into one ManagedRuntime: the archive's folder and
// settings, the modules, the backups' prune, the open archive, the AI service, the viewer's connections, the HTTP server with Vite,
// then the live connectors. SIGINT and SIGTERM dispose the runtime, which closes them in the reverse order: the live
// connectors stopped and their lock let go, the server closed, Codex stopped, and the archive closed last.

import "./onPinnedNode.ts";
import "./onSettings.ts";
import { ManagedRuntime } from "effect";
import { CouldNotListen, serverLayer } from "./serverLayer.ts";
import { SettingsProblem, writeMovedSwitches } from "./settings.ts";

const server = ManagedRuntime.make(serverLayer);

let stopping: Promise<void> | null = null;
/** Closes everything the server opened, in the reverse order, then exits with `code`. */
const stop = (code: number) => (stopping ??= server.dispose().finally(() => process.exit(code)));
// Kept for the whole run, not once: Vite loads signal-exit, which sends a signal again to a process that has no other
// listener for it, and so would end this one while it stops. A second signal while it stops ends it at once.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (stopping ? process.exit(1) : void stop(0)));

try {
  writeMovedSwitches();
  await server.context();
} catch (error) {
  // Not listening (the port taken, say) is said where it happens; a wrong setting in its own words; anything else is a bug, said here.
  if (error instanceof SettingsProblem) console.error(error.message);
  else if (!(error instanceof CouldNotListen)) console.error("The archive's server could not start:", error);
  await stop(1);
}
