// The life archive runs on one Node version, pinned in package.json's devEngines.runtime and, for the version managers
// that read a file of their own (nvm, fnm, mise, Cloudflare's build image), in .node-version beside it: the Vite+ shims
// in ~/.vite-plus/bin read the pin and run that version, and npm test, npm start and the CLIs stop on any other, so a
// test result or a run never depends on which Node the PATH found first.

import { readFileSync } from "node:fs";

export function pinnedNode(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return pkg.devEngines.runtime.version;
}

/** The version .node-version names. */
export function nodeVersionFile(): string {
  return readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim();
}

/** Why `running` is not the pinned version, or null when it is. */
export function wrongNode(running: string, pinned: string, execPath = ""): string | null {
  if (running.replace(/^v/, "") === pinned) return null;
  return [
    `The life archive runs on Node ${pinned} (package.json devEngines, and .node-version), but this is Node ${running}${execPath ? ` at ${execPath}` : ""}.`,
    `Put the Vite+ shims first on the PATH, and they run Node ${pinned} here:`,
    `  export PATH="$HOME/.vite-plus/bin:$PATH"`,
    `(once, if it is not installed yet: vp env install), or install Node ${pinned} with a version manager that reads .node-version (nvm, fnm, mise).`,
  ].join("\n");
}

/** Stops the process, with how to get the pinned Node, unless it runs on it. */
export function requirePinnedNode(): void {
  const problem = wrongNode(process.versions.node, pinnedNode(), process.execPath);
  if (problem === null) return;
  console.error(problem);
  process.exit(1);
}
