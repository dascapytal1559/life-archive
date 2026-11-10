import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WA_CALLS, writeBridgeLidMap, writeWhatsAppFixture } from "../fixtures/whatsapp.ts";
import { bridgeDatabase, callsFingerprint, copyMacApp, MAC_DATABASES, syncMacCalls, type CopyFile } from "./whatsapp-db/macCalls.ts";

let dir: string;
let app: string;
let archiveDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-mac-calls-"));
  // The app's folder, as ~/Library/Group Containers/... holds it, and the archive's folder.
  app = join(dir, "app");
  archiveDir = join(dir, "archive");
  await writeWhatsAppFixture(app, { copy: "mac", calls: true, macApp: true });
  await mkdir(archiveDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MAC = () => join(archiveDir, "platform-exports", "whatsapp", "mac");
const count = (file: string, sql: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe("the Mac app's safe copy", () => {
  it("copies the databases with their -wal, never touching the app's own, into one file each, replaced each run", async () => {
    // The app is running: a message only in ChatStorage's -wal, not yet in the database itself.
    const live = new DatabaseSync(join(app, "ChatStorage.sqlite"));
    live.exec("PRAGMA wal_autocheckpoint = 0");
    live.exec("INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, ZISFROMME, ZMESSAGETYPE, ZSTANZAID) VALUES (99999, 9, 1, 0, '3A00000000000000W001')");
    const appFiles = async () => Object.fromEntries(await Promise.all((await readdir(app)).sort().map(async (name) => [name, await readFile(join(app, name))])));
    const before = await appFiles();
    expect(Object.keys(before)).toContain("ChatStorage.sqlite-wal");
    try {
      const folder = (await copyMacApp(app, archiveDir))!;
      expect(folder).toBe(MAC());
      expect((await readdir(folder)).sort()).toEqual([...MAC_DATABASES].sort());
      expect(count(join(folder, "ChatStorage.sqlite"), "SELECT count(*) AS n FROM ZWAMESSAGE WHERE Z_PK = 99999")).toBe(1);
      expect(count(join(folder, "CallHistory.sqlite"), "SELECT count(*) AS n FROM ZWACDCALLEVENT")).toBeGreaterThan(0);
      expect(await appFiles()).toEqual(before);
      // Nothing is left of the copies but the folder.
      expect((await readdir(join(archiveDir, "platform-exports", "whatsapp"))).sort()).toEqual(["mac"]);
      // The next run replaces it.
      live.exec("DELETE FROM ZWAMESSAGE WHERE Z_PK = 99999");
      await copyMacApp(app, archiveDir);
      expect(count(join(MAC(), "ChatStorage.sqlite"), "SELECT count(*) AS n FROM ZWAMESSAGE WHERE Z_PK = 99999")).toBe(0);
    } finally {
      live.close();
    }
  });

  it("keeps a copy only when two copies match, trying again a little later, and says when they never do", async () => {
    let copies = 0;
    /** The app writes while the first two copies are made: each second copy differs from the first. */
    const busy = (until: number): CopyFile => async (from, to) => {
      await writeFile(to, await readFile(from));
      if (to.includes("pass-2") && to.endsWith("ChatStorage.sqlite") && ++copies <= until) await writeFile(to, "written meanwhile", { flag: "a" });
    };
    await copyMacApp(app, archiveDir, { pauseMs: 0, copy: busy(2) });
    expect(copies).toBe(3);
    copies = 0;
    await expect(copyMacApp(app, archiveDir, { pauseMs: 0, copy: busy(3) })).rejects.toThrow(/changed its databases while they were copied, 3 times over/);
    // The copy of the run before is kept.
    expect((await readdir(MAC())).sort()).toEqual([...MAC_DATABASES].sort());
    await expect(copyMacApp(join(dir, "nowhere"), archiveDir)).rejects.toThrow(/no WhatsApp ChatStorage\.sqlite/);
  });

  it("finds the bridge's database where the matrix-whatsapp settings say the rig is", async () => {
    const rig = join(dir, "rig");
    await mkdir(join(archiveDir, "connectors"), { recursive: true });
    await writeFile(join(archiveDir, "connectors", "matrix-whatsapp.json"), JSON.stringify({ enabled: true, source: rig }));
    expect(await bridgeDatabase(archiveDir)).toBeNull();
    await mkdir(join(rig, "data", "whatsapp"), { recursive: true });
    writeBridgeLidMap(join(rig, "data", "whatsapp", "mautrix-whatsapp.db"));
    expect(await bridgeDatabase(archiveDir)).toBe(join(rig, "data", "whatsapp", "mautrix-whatsapp.db"));
  });
});

describe("npm run whatsapp-mac-calls", () => {
  const SCRIPT = fileURLToPath(new URL("./whatsapp-db/macCalls.ts", import.meta.url));
  const CLI = fileURLToPath(new URL("../../../server/archive/cli.ts", import.meta.url));
  const env = () => ({ ...process.env, FRIEND_MAP_DATA: "", LIFE_ARCHIVE_DATA: archiveDir });
  const run = (script: string, ...args: string[]) => promisify(execFile)(process.execPath, ["--no-warnings", script, ...args], { env: env() });

  it("copies the app's databases and imports their calls alone, and a second run adds nothing", async () => {
    const iphone = join(archiveDir, "platform-exports", "whatsapp", "2026-09-28");
    await writeWhatsAppFixture(iphone, { calls: true });
    const rig = join(dir, "rig");
    await mkdir(join(rig, "data", "whatsapp"), { recursive: true });
    writeBridgeLidMap(join(rig, "data", "whatsapp", "mautrix-whatsapp.db"));
    await mkdir(join(archiveDir, "connectors"), { recursive: true });
    await writeFile(join(archiveDir, "connectors", "matrix-whatsapp.json"), JSON.stringify({ enabled: false, source: rig }));
    await run(CLI, "enable", "whatsapp-db");
    await run(CLI, "import", "whatsapp-db", iphone);

    const dry = await run(SCRIPT, "--from", app, "--dry-run");
    expect(dry.stdout).toMatch(/^It would add 1 call:$/m);
    const first = await run(SCRIPT, "--from", app);
    expect(first.stdout).toMatch(/Copied WhatsApp.s databases to .*\/platform-exports\/whatsapp\/mac \(chats /);
    expect(first.stdout).toMatch(/^Messages: 1 new .*, 1 changed, 6 already had/m);
    expect(first.stdout).toMatch(/^Accounts: 0 new, 0 changed\. Chats: 0 new, 0 changed\.$/m);
    // Nothing new since: no import, so no import record.
    const imports = () => count(join(archiveDir, "modules", "friend-map", "archive.sqlite"), "SELECT count(*) AS n FROM source");
    const records = imports();
    const again = await run(SCRIPT, "--from", app);
    expect(again.stdout).toMatch(/Nothing new: WhatsApp's calls are as at the last import/);
    expect(again.stdout).not.toMatch(/^Messages:/m);
    expect(imports()).toBe(records);
    const state = JSON.parse(await readFile(join(archiveDir, "whatsapp-mac-calls", "state.json"), "utf8")) as { checked: Record<string, number> };
    expect(state.checked["whatsapp-db"]).toBeGreaterThan(Date.now() - 60_000);
    const db = new DatabaseSync(join(archiveDir, "modules", "friend-map", "archive.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM message WHERE platform_message_id = ?").get(WA_CALLS.macEvening)).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});

describe("a run every 15 minutes", () => {
  it("imports only when the calls changed: not for a message, but for a new call or a call's length", async () => {
    const imported: string[] = [];
    const lines: string[] = [];
    const sync = (dryRun = false) => syncMacCalls({ from: app, archiveDir, dryRun, pauseMs: 0, log: (line) => lines.push(line), importCalls: async (folder) => (imported.push(folder), 0) });

    expect(await sync()).toBe(0);
    expect(imported).toEqual([MAC()]);
    const kept = await readFile(join(MAC(), "ChatStorage.sqlite"));

    // A message that is no call: nothing kept, nothing imported.
    const chats = new DatabaseSync(join(app, "ChatStorage.sqlite"));
    chats.exec("INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, ZISFROMME, ZMESSAGETYPE, ZSTANZAID) VALUES (99998, 9, 1, 0, '3A00000000000000W002')");
    expect(await sync()).toBe("nothing new");
    expect(imported).toHaveLength(1);
    expect(await readFile(join(MAC(), "ChatStorage.sqlite"))).toEqual(kept);
    expect(lines.at(-1)).toMatch(/Nothing new: WhatsApp's calls are as at the last import \(chats \d+\/\d+; calls tab \d+\/\d+\/[\d.]+\)\.$/);
    expect((await readdir(join(archiveDir, "platform-exports", "whatsapp"))).sort()).toEqual(["mac"]);

    // A call's length that came later.
    const tab = new DatabaseSync(join(app, "CallHistory.sqlite"));
    tab.exec("UPDATE ZWACDCALLEVENT SET ZDURATION = coalesce(ZDURATION, 0) + 60 WHERE Z_PK = (SELECT max(Z_PK) FROM ZWACDCALLEVENT)");
    tab.close();
    expect(await sync()).toBe(0);
    expect(imported).toHaveLength(2);

    // A new call record in a chat; a dry run imports in its own way and remembers nothing.
    chats.exec(`INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, ZISFROMME, ZMESSAGETYPE, ZSTANZAID) VALUES (99999, 9, 1, 59, '3A00000000000000W003')`);
    chats.close();
    expect(await sync(true)).toBe(0);
    expect(await sync()).toBe(0);
    expect(await sync()).toBe("nothing new");
    expect(imported).toHaveLength(4);
  });

  it("does not remember an import that failed, so the next run tries again", async () => {
    let code = 1;
    const sync = () => syncMacCalls({ from: app, archiveDir, pauseMs: 0, log: () => {}, importCalls: async () => code });
    expect(await sync()).toBe(1);
    code = 0;
    expect(await sync()).toBe(0);
    expect(await sync()).toBe("nothing new");
  });

  it("leaves it to the last run while that one is still going", async () => {
    await mkdir(join(archiveDir, "whatsapp-mac-calls"), { recursive: true });
    await writeFile(join(archiveDir, "whatsapp-mac-calls", "lock"), String(process.ppid));
    expect(await syncMacCalls({ from: app, archiveDir, log: () => {}, importCalls: async () => { throw new Error("should not import"); } })).toBe("busy");
  });

  it("fingerprints calls by counts, ids and seconds alone", async () => {
    const folder = (await copyMacApp(app, archiveDir))!;
    expect(callsFingerprint(folder)).toMatch(/^chats \d+\/\d+; calls tab \d+\/\d+\/[\d.]+$/);
    expect(callsFingerprint(join(dir, "nowhere"))).toBe("chats none; calls tab none");
  });
});
