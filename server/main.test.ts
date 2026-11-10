// The archive's server as a process (main.ts): started on a made-up archive with a live connector switched on and a
// stand-in for Codex, then sent SIGTERM. It closes everything it opened, in the reverse order, and leaves nothing
// behind: no child process, no live bridges' lock, no WAL.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Archive } from "./archive/index.ts";
import { PROJECT, writeLlmSessionsFixture } from "./fixtures/llm-sessions.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.ts", import.meta.url));

let root: string;
let dataDir: string;
let server: ChildProcess | null;
let log: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-main-"));
  dataDir = join(root, "data");
  await mkdir(dataDir);
  (await Archive.open(dataDir)).close();
  // The agents' conversations, live: a connector of its own process, with no companion to wait for.
  await writeLlmSessionsFixture(join(root, "claude-code"));
  await mkdir(join(dataDir, "connectors"));
  await writeFile(join(dataDir, "connectors", "llm-sessions.json"), JSON.stringify({ enabled: true, source: join(root, "claude-code"), projects: [PROJECT] }));
  // `codex` on the server's PATH is the stand-in (fixtures/fake-codex.ts).
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "codex"));
  await writeFile(join(root, "bin", "codex"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "${join(root, "codex")}" "$@"\n`);
  await chmod(join(root, "bin", "codex"), 0o755);
  server = null;
  log = "";
});

afterEach(async () => {
  server?.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
});

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Resolves once `check` holds, looking every 50 ms for up to 30 s. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}; the server's log:\n${log}`);
}

const childrenOf = (pid: number) => spawnSync("pgrep", ["-P", String(pid)]).stdout.toString().trim().split("\n").filter(Boolean).map(Number);
const alive = (pid: number) => spawnSync("kill", ["-0", String(pid)]).status === 0;

/** The live bridges' lock, as the archive keeps it (connectors/liveLock.ts). */
function liveOwner(): unknown {
  const db = new DatabaseSync(join(dataDir, "core.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT value FROM meta WHERE key = 'live_owner'").get() ?? null;
  } finally {
    db.close();
  }
}

describe("the archive's server, stopped with SIGTERM", { timeout: 60_000 }, () => {
  it("stops the live connectors and Codex, closes the server and the archive, and leaves no process, lock or WAL behind", async () => {
    const port = await freePort();
    server = spawn(process.execPath, ["--no-warnings", MAIN], {
      env: { ...process.env, LIFE_ARCHIVE_DATA: dataDir, LIFE_ARCHIVE_URL: `http://127.0.0.1:${port}`, PATH: `${join(root, "bin")}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout!.on("data", (chunk) => (log += chunk));
    server.stderr!.on("data", (chunk) => (log += chunk));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => server!.once("exit", (code, signal) => resolve({ code, signal })));

    await until(() => log.includes("[live] llm-sessions: connected") && log.includes("[codex] running"), "the server, its live connector and Codex to start");
    expect(log).toContain(`The archive's server running at http://127.0.0.1:${port}/life-archive/, and /friend-map/`);
    expect((await fetch(`http://127.0.0.1:${port}/api/archive/people`)).status).toBe(200);
    const children = childrenOf(server.pid!);
    // Codex's stand-in and the connector's process.
    expect(children).toHaveLength(2);
    expect(liveOwner()).not.toBeNull();
    expect(existsSync(join(dataDir, "modules", "friend-map", "archive.sqlite-wal"))).toBe(true);

    server.kill("SIGTERM");
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(log.trim().split("\n").at(-1)).toBe("[live] llm-sessions: stopped");
    expect(children.filter(alive)).toEqual([]);
    // Looked at before liveOwner opens the archive again.
    expect(existsSync(join(dataDir, "modules", "friend-map", "archive.sqlite-wal"))).toBe(false);
    expect(existsSync(join(dataDir, "core.sqlite-wal"))).toBe(false);
    expect(liveOwner()).toBeNull();
    await expect(fetch(`http://127.0.0.1:${port}/api/archive/people`)).rejects.toThrow();
  });

  it("makes no folder when the archive's is missing: no module's database stands in for it, and the routes say why", async () => {
    const missing = join(root, "moved");
    const port = await freePort();
    server = spawn(process.execPath, ["--no-warnings", MAIN], {
      env: { ...process.env, LIFE_ARCHIVE_DATA: missing, LIFE_ARCHIVE_URL: `http://127.0.0.1:${port}`, PATH: `${join(root, "bin")}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout!.on("data", (chunk) => (log += chunk));
    server.stderr!.on("data", (chunk) => (log += chunk));
    await until(() => log.includes("The archive's server running at"), "the server to start");
    expect(log).toContain(`exercise (there is no archive's folder at ${missing})`);
    const res = await fetch(`http://127.0.0.1:${port}/api/archive/people`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(`there is no archive's folder at ${missing}`);
    expect(existsSync(missing)).toBe(false);
  });

  it("says so and exits 1, closing what it opened, when its port is taken", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const { port } = taken.address() as AddressInfo;
    try {
      server = spawn(process.execPath, ["--no-warnings", MAIN], {
        env: { ...process.env, LIFE_ARCHIVE_DATA: dataDir, LIFE_ARCHIVE_URL: `http://127.0.0.1:${port}`, PATH: `${join(root, "bin")}:${process.env.PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      server.stdout!.on("data", (chunk) => (log += chunk));
      server.stderr!.on("data", (chunk) => (log += chunk));
      const exited = await new Promise<number | null>((resolve) => server!.once("exit", resolve));
      expect(exited).toBe(1);
      expect(log).toContain(`The archive's server could not start on 127.0.0.1:${port}: listen EADDRINUSE`);
      expect(existsSync(join(dataDir, "modules", "friend-map", "archive.sqlite-wal"))).toBe(false);
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });
});
