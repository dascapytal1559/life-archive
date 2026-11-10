// For the scheduled jobs installed before friend map was a module (docs/data.md's "This Mac's calls and Messages, every 15
// minutes", "Exports from the Cua Space", "The Mac app's calls, every 15 minutes"): their launchd agents, and the
// launcher Full Disk Access was given to (launcher.c, which bakes in the path it runs), run the old paths, so each old
// path is a small file that runs the friend map module's command in its place, by path, as launcher.c runs a command:
// the same arguments, its output, SIGTERM and SIGINT passed on, and its exit. They go once each job is installed again
// from the module's command (`npm run mac-imports -- install` and the rest), and Full Disk Access given to the new
// launcher; the friend map step's migration says when (docs/modules.md, "Friend map").

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

/** Runs the command at `path` (from the repository's root) in this process's place. */
export function handOn(path: string): void {
  const command = fileURLToPath(new URL(`../${path}`, import.meta.url));
  const child = spawn(process.execPath, ["--no-warnings", command, ...process.argv.slice(2)], { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  child.on("close", (code, signal) => {
    process.exit(code ?? 128 + constants.signals[signal!]);
  });
}
