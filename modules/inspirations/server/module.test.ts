// The inspirations module as the server runs it: the archive's server (the core's server/main.ts) started on a made-up
// archive, once with the module on and once off. On, the iPhone's capture route answers at the address it had as a
// core page, the module's work tags what it kept with a stand-in model (the core's fixtures/fake-codex.ts) and, his
// words asking for something to be built, still tells a stand-in firstmate's inbox nothing; the page's settings say it is on. Off, the
// route is gone, nothing is worked on, and the settings say so. Every item is made up.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openModuleDatabase } from "../../../sdk/testing.ts";
import { INSPIRATIONS_DATABASE, INSPIRATIONS_DB } from "./db.ts";
import { inspirationsFolder } from "./files.ts";
import { Inspirations } from "./store.ts";

const MAIN = fileURLToPath(new URL("../../../server/main.ts", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("../../../server/fixtures/fake-codex.ts", import.meta.url));
const CAPTURE = "/life-archive/api/inspirations/capture";

/** The module's database in the made-up archive, open, while the server is down. */
const openStore = () => openModuleDatabase(join(inspirationsFolder(dataDir), INSPIRATIONS_DB), INSPIRATIONS_DATABASE).db;

let root: string;
let dataDir: string;
let server: ChildProcess | null;
let log: string;

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Resolves once `check` holds, looking every 50 ms for up to 30 s. */
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}; the server's log:\n${log}`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "life-archive-inspirations-module-"));
  dataDir = join(root, "data");
  await mkdir(dataDir);
  // `codex` on the server's PATH is the stand-in, answering one AI tagging: woodwork, and (as an old model might) his words an ask, which nothing reads.
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "codex"));
  await writeFile(join(root, "bin", "codex"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "${join(root, "codex")}" "$@"\n`);
  await chmod(join(root, "bin", "codex"), 0o755);
  await writeFile(join(root, "codex", "answers.json"), JSON.stringify([{ text: JSON.stringify({ tags: ["woodwork", "garden"], ask: true }) }]));
  // A stand-in firstmate, whose inbox keeps each note it is sent.
  await mkdir(join(root, "firstmate", "bin"), { recursive: true });
  await writeFile(join(root, "firstmate", "bin", "fm-inbox.sh"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${join(root, "firstmate", "notes.txt")}"\n`);
  await chmod(join(root, "firstmate", "bin", "fm-inbox.sh"), 0o755);
  server = null;
  log = "";
});

afterEach(async () => {
  server?.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
});

/** The archive's server on the made-up archive with the inspirations module switched `on`, once it listens: its address. */
async function start(on: boolean): Promise<string> {
  const settings = join(root, "settings.json");
  await writeFile(settings, JSON.stringify({ timeZone: "Australia/Melbourne", locale: "en-AU", pages: "all", modules: { inspirations: on } }));
  const port = await freePort();
  log = "";
  server = spawn(process.execPath, ["--no-warnings", MAIN], {
    env: {
      ...process.env, LIFE_ARCHIVE_DATA: dataDir, LIFE_ARCHIVE_SETTINGS: settings, LIFE_ARCHIVE_URL: `http://127.0.0.1:${port}`,
      FIRSTMATE_HOME: join(root, "firstmate"), PATH: `${join(root, "bin")}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (chunk) => (log += chunk));
  server.stderr!.on("data", (chunk) => (log += chunk));
  await until(() => log.includes("The archive's server running at"), "the server to start");
  return `http://127.0.0.1:${port}`;
}

/** Stops the server with SIGTERM, as launchd does, and waits for it to exit. */
async function stop(): Promise<void> {
  const exited = new Promise((resolve) => server!.once("exit", resolve));
  server!.kill("SIGTERM");
  await exited;
  server = null;
}

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const capture = (at: string, body: object) => fetch(`${at}${CAPTURE}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(json);
const notes = () => (existsSync(join(root, "firstmate", "notes.txt")) ? readFileSync(join(root, "firstmate", "notes.txt"), "utf8") : "");

describe("the inspirations as the server runs them", { timeout: 90_000 }, () => {
  it("answer the share sheet's capture and work on what it kept, sending firstmate no probe request even for a caption that asks for a build, while on, and do none of it while off", async () => {
    const on = await start(true);
    expect((await json(await fetch(`${on}/life-archive/api/settings`))).body.modules).toMatchObject({ inspirations: true });
    const kept = await capture(on, { text: "A made-up bench\nfrom the offcuts", caption: "build one of these for the garden", origin: "share-sheet" });
    expect(kept).toMatchObject({ status: 200, body: { id: 1, created: true, link: null } });
    // The server's work: the stand-in's tags, and no note to firstmate for his words, the item left with no probe.
    await until(async () => ((await json(await fetch(`${on}/life-archive/api/inspirations/items/1`))).body.aiTags as string[] | undefined)?.length === 2, "the AI's tags");
    const item = await json(await fetch(`${on}/life-archive/api/inspirations/items/1`));
    expect(item).toMatchObject({ status: 200, body: { aiTags: ["woodwork", "garden"], probe: null } });
    expect(notes()).toBe("");
    expect(log).not.toContain("probe");
    await stop();

    // An item waiting for its AI tags, made while the server was down, and a model with an answer for it.
    const db = openStore();
    new Inspirations(db).capture({ link: "https://blog.example.com/stools", caption: "make these", origin: "cli", savedAt: Date.now(), now: Date.now() });
    db.close();
    await writeFile(join(root, "codex", "answers.json"), JSON.stringify([{ text: JSON.stringify({ tags: ["woodwork"], ask: true }) }]));
    const off = await start(false);
    expect((await json(await fetch(`${off}/life-archive/api/settings`))).body.modules).toMatchObject({ inspirations: false });
    // No route of theirs: the capture falls through to the read API, which takes no POST.
    expect((await capture(off, { link: "https://blog.example.com/chairs" })).status).toBe(405);
    expect((await fetch(`${off}/life-archive/api/inspirations/items/1`)).status).toBe(404);
    // Nothing worked on: a pass would have come within its five seconds.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await stop();
    const after = openStore();
    try {
      expect(new Inspirations(after).get(2)).toMatchObject({ aiTags: [], probe: null });
    } finally {
      after.close();
    }
    expect(notes()).toBe("");
    expect(log).not.toContain("[inspirations]");
  });
});
