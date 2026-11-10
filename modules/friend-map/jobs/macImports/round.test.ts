import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { openArchive } from "../../server/db.ts";
import { writeCallHistoryFixture } from "../../fixtures/call-history.ts";
import { writeMessagesFixture } from "../../fixtures/imessage.ts";
import { writeMacContactsFixture } from "../../fixtures/macContacts.ts";
import { writeAddressBookFixture } from "../../fixtures/whatsapp.ts";
import { ArchiveCommands, archiveCommandsLayer, Notifier, RunFailed } from "../../../../sdk/server.ts";
import { macSources } from "./copy.ts";
import { buildLauncher, plist } from "./live.ts";
import { arrivedNote, BACKUP_LABEL, macImportsRun, runNote } from "./round.ts";

const CLI = fileURLToPath(new URL("../../../../server/archive/cli.ts", import.meta.url));
// 2026-10-21, midday in Melbourne.
const NOW = Date.parse("2026-10-21T12:00:00+11:00");
const LAUNCHER = "/opt/sample/life-archive-mac-imports";

let dataDir: string;
let home: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "mac-imports-data-"));
  home = await mkdtemp(join(tmpdir(), "mac-imports-home-"));
});

afterEach(async () => {
  // A source made unreadable is made readable again, so it can be removed.
  await chmod(macSources(home).messages, 0o644).catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** A made-up Mac: the call history, Messages' chat.db and Contacts where macOS keeps them, and two attachments, one old and one new. */
async function madeUpMac(): Promise<void> {
  const paths = macSources(home);
  writeMacContactsFixture(paths.contacts);
  await writeCallHistoryFixture(join(paths.calls, ".."));
  await writeMessagesFixture(join(paths.messages, ".."), { copy: "mac" });
  for (const [name, at] of [["old", "2026-01-05T10:00:00+11:00"], ["new", "2026-10-20T10:00:00+11:00"]] as const) {
    const file = join(paths.attachments, "0a", "10", `AT_${name}`, `${name}.heic`);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, `made-up ${name} attachment`);
    await utimes(file, new Date(at), new Date(at));
  }
}

/** A scratch archive that imports both, with an older iPhone address book taken out of a backup. */
async function scratchArchive(): Promise<void> {
  openArchive(join(dataDir, "modules", "friend-map", "archive.sqlite")).close();
  for (const connector of ["call-history", "imessage-db"]) {
    await promisify(execFile)(process.execPath, ["--no-warnings", CLI, "enable", connector, "--data", dataDir]);
  }
  const book = join(dataDir, "platform-exports", "addressbook", "2026-09-01");
  await mkdir(book, { recursive: true });
  writeAddressBookFixture(join(book, "AddressBook.sqlitedb"));
}

/** firstmate's inbox, which takes a note with an id it has had once only. */
function fakeNotifier(notes: Map<string, string>) {
  return Layer.succeed(Notifier, { note: (id: string, text: string) => Effect.sync(() => void (notes.has(id) || notes.set(id, text))) });
}

/** Archive commands that must not run. */
const noArchive = Layer.succeed(ArchiveCommands, {
  coversTo: Effect.die("import-status should not run"),
  archive: (args: string[]) => Effect.die(`archive ${args.join(" ")} should not run`),
  checkData: Effect.die("check-data should not run"),
});

/** Something new on the made-up Mac, after the rest: a call from Ada, a message from the lunch chat, and an attachment. */
async function somethingNew(at: string): Promise<void> {
  const paths = macSources(home);
  const calls = new DatabaseSync(paths.calls);
  calls.prepare(
    `INSERT INTO ZCALLRECORD (Z_PK, Z_ENT, Z_OPT, ZANSWERED, ZCALL_CATEGORY, ZCALLTYPE, ZHANDLE_TYPE, ZORIGINATED, ZDATE, ZDURATION, ZADDRESS,
       ZISO_COUNTRY_CODE, ZNAME, ZSERVICE_PROVIDER, ZUNIQUE_ID, ZLOCALPARTICIPANTUUID)
     SELECT 1000, Z_ENT, Z_OPT, ZANSWERED, ZCALL_CATEGORY, ZCALLTYPE, ZHANDLE_TYPE, ZORIGINATED, ?, ZDURATION, ZADDRESS,
       ZISO_COUNTRY_CODE, ZNAME, ZSERVICE_PROVIDER, 'NEW1', ZLOCALPARTICIPANTUUID FROM ZCALLRECORD WHERE Z_PK = 1`,
  ).run(Date.parse(at) / 1000 - 978_307_200);
  calls.exec("INSERT INTO Z_2REMOTEPARTICIPANTHANDLES SELECT 1000, Z_4REMOTEPARTICIPANTHANDLES FROM Z_2REMOTEPARTICIPANTHANDLES WHERE Z_2REMOTEPARTICIPANTCALLS = 1");
  calls.close();
  const messages = new DatabaseSync(paths.messages);
  const date = (BigInt(Date.parse(at)) - 978_307_200_000n) * 1_000_000n;
  messages.prepare(
    `INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me)
     SELECT (SELECT max(ROWID) FROM message) + 1, 'M900', 'see you there', handle_id, service, ?, 0 FROM message WHERE guid = 'M040'`,
  ).run(date);
  messages.prepare(
    `INSERT INTO chat_message_join (chat_id, message_id, message_date)
     SELECT j.chat_id, (SELECT max(ROWID) FROM message), ? FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id WHERE m.guid = 'M040'`,
  ).run(date);
  messages.close();
  const file = join(paths.attachments, "0b", "11", "AT_later", "later.heic");
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "made-up later attachment");
  await utimes(file, new Date(at), new Date(at));
}

/** How many imports the archive has a record of. */
function importRecords(): number {
  const db = openArchive(join(dataDir, "modules", "friend-map", "archive.sqlite"));
  try {
    return Number((db.prepare("SELECT count(*) AS n FROM source").get() as { n: number }).n);
  } finally {
    db.close();
  }
}

const listed = (...path: string[]) => readdir(join(dataDir, ...path)).then((names) => names.sort());

/** The name each handle's account was given by the imports, and where it came from. */
function namesIn(handles: string[]): Record<string, string> {
  const db = openArchive(join(dataDir, "modules", "friend-map", "archive.sqlite"));
  try {
    const name = db.prepare("SELECT display_name || ' (' || name_source || ')' AS name FROM import_person WHERE handle = ? ORDER BY id LIMIT 1");
    return Object.fromEntries(handles.map((handle) => [handle, String((name.get(handle) as { name: string } | undefined)?.name)]));
  } finally {
    db.close();
  }
}

describe("macImportsRun", () => {
  it.live("syncs what is new into the day's folders, backs up once, imports each named from Contacts and runs check-data; a run with nothing new copies, imports and notes nothing; the next day firstmate hears what came in", () =>
    Effect.gen(function* () {
      yield* Effect.promise(madeUpMac);
      yield* Effect.promise(scratchArchive);
      const notes = new Map<string, string>();
      const layer = Layer.mergeAll(archiveCommandsLayer(dataDir), fakeNotifier(notes));
      const run = (now: number, lines: string[] = []) => macImportsRun({ dataDir, home, now, launcher: LAUNCHER, log: (line) => lines.push(line) }).pipe(Effect.provide(layer));

      // The first run: everything is new.
      const first = yield* run(NOW);
      expect(first.ok).toBe(true);
      expect(first.sources).toEqual([
        { source: "calls", folder: "platform-exports/calls/2026-10-21", ok: true, detail: expect.stringMatching(/^Calls: [1-9]\d* new$/), added: expect.any(Number), attachments: 0 },
        // Never imported before, so every attachment.
        { source: "messages", folder: "platform-exports/imessage/2026-10-21", ok: true, detail: expect.stringMatching(/^Messages: [1-9]\d* new, with 2 attachments \(0\.0 MB\) since the start$/), added: expect.any(Number), attachments: 2 },
      ]);
      expect(first.checkData).toEqual({ ok: true, problems: 0 });
      expect(first.contacts).toEqual({ folder: "platform-exports/addressbook/2026-10-21", copied: true });
      // The Contacts app's stores at their own paths, beside the iPhone's older book; no photos or anything else.
      expect(yield* Effect.promise(() => readdir(join(dataDir, "platform-exports", "addressbook", "2026-10-21"), { recursive: true }).then((names) => names.sort()))).toEqual([
        "AddressBook-v22.abcddb", "Sources", "Sources/0A1B2C3D-0000-4000-8000-000000000001", "Sources/0A1B2C3D-0000-4000-8000-000000000001/AddressBook-v22.abcddb",
        "Sources/0A1B2C3D-0000-4000-8000-000000000002", "Sources/0A1B2C3D-0000-4000-8000-000000000002/AddressBook-v22.abcddb",
      ]);
      // Named from the Mac's Contacts: a number typed in national form, and an email.
      expect(namesIn(["+61491571491", "ada@example.com"])).toEqual({ "+61491571491": "Bruno Placeholder (addressBook)", "ada@example.com": "Ada Sample (addressBook)" });
      expect(yield* Effect.promise(() => listed("platform-exports", "calls", "2026-10-21"))).toEqual(["CallHistory.storedata"]);
      expect(yield* Effect.promise(() => listed("platform-exports", "imessage", "2026-10-21"))).toEqual(["Attachments", "chat.db"]);
      expect(existsSync(join(dataDir, "platform-exports", "imessage", "2026-10-21", "Attachments", "0a", "10", "AT_new", "new.heic"))).toBe(true);
      // One backup for both imports, and nothing half made beside the copies.
      const backups = (yield* Effect.promise(() => listed("backups"))).filter((name) => name.endsWith(`-${BACKUP_LABEL}.sqlite`));
      expect(backups).toHaveLength(1);
      expect(yield* Effect.promise(() => listed("platform-exports", "imessage"))).toEqual(["2026-10-21"]);
      // A run that goes well tells firstmate nothing yet.
      expect(notes.size).toBe(0);
      const records = importRecords();

      // 15 minutes on, nothing new: nothing copied, backed up, imported or noted.
      const lines: string[] = [];
      const quiet = yield* run(NOW + 15 * 60_000, lines);
      expect(quiet).toEqual({
        ok: true,
        noAccess: [],
        sources: [{ source: "calls", folder: null, ok: true, detail: "nothing new", added: 0 }, { source: "messages", folder: null, ok: true, detail: "nothing new", added: 0 }],
        checkData: null,
        contacts: null,
      });
      expect(lines).toEqual([]);
      expect(yield* Effect.promise(() => listed("platform-exports", "calls"))).toEqual(["2026-10-21"]);
      expect(yield* Effect.promise(() => listed("platform-exports", "imessage"))).toEqual(["2026-10-21"]);
      expect(yield* Effect.promise(() => listed("platform-exports", "addressbook"))).toEqual(["2026-09-01", "2026-10-21"]);
      expect((yield* Effect.promise(() => listed("backups"))).filter((name) => name.endsWith(`-${BACKUP_LABEL}.sqlite`))).toEqual(backups);
      expect(importRecords()).toBe(records);
      expect(notes.size).toBe(0);
      // It synced well all the same, as the Sources tab reads it.
      const state = JSON.parse(yield* Effect.promise(() => readFile(join(dataDir, "mac-imports", "state.json"), "utf8"))) as { checked: Record<string, number> };
      expect(state.checked).toEqual({ "call-history": NOW + 15 * 60_000, "imessage-db": NOW + 15 * 60_000 });

      // A call and a message come in: the day's folders are brought up to date, keeping what they had, and the day keeps one backup.
      yield* Effect.promise(() => somethingNew("2026-10-21T12:20:00+11:00"));
      const later = yield* run(NOW + 30 * 60_000);
      expect(later.sources.map((s) => [s.folder, s.detail])).toEqual([
        ["platform-exports/calls/2026-10-21", "Calls: 1 new"],
        ["platform-exports/imessage/2026-10-21", expect.stringMatching(/^Messages: 1 new, with 2 attachments \(0\.0 MB\) since 2026-09-1\d$/)],
      ]);
      expect(later.contacts).toEqual({ folder: "platform-exports/addressbook/2026-10-21", copied: true });
      expect(yield* Effect.promise(() => listed("platform-exports", "imessage"))).toEqual(["2026-10-21"]);
      expect(yield* Effect.promise(() => listed("platform-exports", "imessage", "2026-10-21"))).toEqual(["Attachments", "chat.db"]);
      const attachments = join(dataDir, "platform-exports", "imessage", "2026-10-21", "Attachments");
      for (const kept of [["0a", "10", "AT_old", "old.heic"], ["0a", "10", "AT_new", "new.heic"], ["0b", "11", "AT_later", "later.heic"]]) expect(existsSync(join(attachments, ...kept))).toBe(true);
      expect(yield* Effect.promise(() => listed("platform-exports", "addressbook"))).toEqual(["2026-09-01", "2026-10-21"]);
      const kept = (yield* Effect.promise(() => listed("backups"))).filter((name) => name.includes(`-${BACKUP_LABEL}.`));
      expect(kept.filter((name) => name.endsWith(`-${BACKUP_LABEL}.sqlite`))).toHaveLength(1);
      expect(kept.filter((name) => name.endsWith(`-${BACKUP_LABEL}.exercise.sqlite`))).toHaveLength(1);
      expect(importRecords()).toBe(records + 2);
      expect(notes.size).toBe(0);

      // The next day's first run tells firstmate what came in, once.
      const nextDay = NOW + 12 * 3_600_000 + 10 * 60_000;
      yield* run(nextDay);
      expect([...notes.keys()]).toEqual(["mac-imports-daily-2026-10-22"]);
      expect(notes.get("mac-imports-daily-2026-10-22")).toBe(
        `[life-archive mac-imports, automated] what this Mac's calls and Messages brought into the archive: 2026-10-21: ${first.sources[0].added + 1} calls and ` +
          `${first.sources[1].added + 1} messages (4 attachments), in 2 syncs; check-data found nothing wrong.`,
      );
      notes.clear();
      yield* run(nextDay + 15 * 60_000);
      expect(notes.size).toBe(0);
      expect(importRecords()).toBe(records + 2);
    }), 180_000);

  it.live("tells firstmate at once when an import fails, keeps the copy, and waits an hour before trying again into the same folder", () =>
    Effect.gen(function* () {
      yield* Effect.promise(madeUpMac);
      const notes = new Map<string, string>();
      const asked: string[] = [];
      const failing = Layer.succeed(ArchiveCommands, {
        coversTo: Effect.succeed({}),
        archive: (args: string[]) => Effect.sync(() => void asked.push(args[0])).pipe(
          Effect.andThen(args[0] === "backup" ? Effect.succeed("Backed up.") : Effect.fail(new RunFailed({ message: "the import stopped", code: 1 }))),
        ),
        checkData: Effect.die("check-data should not run"),
      });
      const run = (now: number) => macImportsRun({ dataDir, home, now }).pipe(Effect.provide(Layer.mergeAll(failing, fakeNotifier(notes))));

      const failed = yield* run(NOW);
      expect(failed.ok).toBe(false);
      expect(failed.sources.map((s) => [s.folder, s.ok, s.detail])).toEqual([
        ["platform-exports/calls/2026-10-21", false, "the import"],
        ["platform-exports/imessage/2026-10-21", false, "the import"],
      ]);
      expect(asked).toEqual(["backup", "import", "import"]);
      expect([...notes.keys()]).toEqual(["mac-imports-failed-2026-10-21"]);
      expect(notes.get("mac-imports-failed-2026-10-21")).toContain(
        "Phone calls: the import failed; its copy is in platform-exports/calls/2026-10-21 in the archive's folder: run the import by hand as docs/import-runbook.md says, from the backup step.",
      );

      // Within the hour: nothing.
      const waiting = yield* run(NOW + 15 * 60_000);
      expect(waiting.skipped).toBe("the last try failed at 12:00: the next is after 13:00");
      expect(asked).toHaveLength(3);

      // After it: everything is still new, and copied into the same folders.
      const again = yield* run(NOW + 61 * 60_000);
      expect(again.sources.map((s) => s.folder)).toEqual(["platform-exports/calls/2026-10-21", "platform-exports/imessage/2026-10-21"]);
      expect(asked).toHaveLength(6);
      expect(yield* Effect.promise(() => listed("platform-exports", "calls"))).toEqual(["2026-10-21"]);
    }), 60_000);

  it.live("leaves it to the last run while that one is still going", () =>
    Effect.gen(function* () {
      yield* Effect.promise(madeUpMac);
      // The lock of a run that is still going: this test's parent process stands in for it.
      yield* Effect.promise(() => mkdir(join(dataDir, "mac-imports"), { recursive: true }).then(() => writeFile(join(dataDir, "mac-imports", "lock"), String(process.ppid))));
      const notes = new Map<string, string>();
      const result = yield* macImportsRun({ dataDir, home, now: NOW }).pipe(Effect.provide(Layer.mergeAll(noArchive, fakeNotifier(notes))));
      expect(result).toEqual({ ok: true, skipped: "the last run is still going", noAccess: [], sources: [], checkData: null, contacts: null });
      expect(notes.size).toBe(0);
    }));

  it.live("without Full Disk Access does nothing and tells firstmate what to grant, to which program", () =>
    Effect.gen(function* () {
      if (process.getuid?.() === 0) return; // root reads a file whatever its mode
      yield* Effect.promise(madeUpMac);
      yield* Effect.promise(() => chmod(macSources(home).messages, 0o000));
      const notes = new Map<string, string>();
      const lines: string[] = [];

      const result = yield* macImportsRun({ dataDir, home, now: NOW, launcher: LAUNCHER, log: (line) => lines.push(line) }).pipe(
        Effect.provide(Layer.mergeAll(noArchive, fakeNotifier(notes))),
      );

      expect(result).toEqual({ ok: false, noAccess: [macSources(home).messages], sources: [], checkData: null, contacts: null });
      expect(existsSync(join(dataDir, "platform-exports"))).toBe(false);
      expect([...notes.keys()]).toEqual(["mac-imports-no-access-2026-10-21"]);
      expect(notes.get("mac-imports-no-access-2026-10-21")).toBe(
        "[life-archive mac-imports, automated] the sync of this Mac's calls and Messages did nothing today: macOS has not given it Full Disk Access, so it may not read chat.db. " +
          "Granting it is the captain's, once, to this one program (not to node): System Settings > Privacy & Security > Full Disk Access; click +, press Cmd-Shift-G, " +
          `paste ${LAUNCHER}, choose Open, and check its switch is on. It runs again within 15 minutes (\`launchctl kickstart gui/$(id -u)/local.life-archive-mac-imports\` runs it now).`,
      );
      expect(lines).toEqual([`no Full Disk Access: may not read ${macSources(home).messages}`]);
    }));

  it.live("names from the newest address book before when Contacts cannot be copied, and says so", () =>
    Effect.gen(function* () {
      yield* Effect.promise(madeUpMac);
      yield* Effect.promise(scratchArchive);
      // An account's store that is no database.
      yield* Effect.promise(() => writeFile(join(macSources(home).contacts, "Sources", "0A1B2C3D-0000-4000-8000-000000000002", "AddressBook-v22.abcddb"), "not a database"));
      const notes = new Map<string, string>();
      const lines: string[] = [];

      const result = yield* macImportsRun({ dataDir, home, now: NOW, log: (line) => lines.push(line) }).pipe(
        Effect.provide(Layer.mergeAll(archiveCommandsLayer(dataDir), fakeNotifier(notes))),
      );

      expect(result.ok).toBe(true);
      expect(result.contacts).toEqual({ folder: "platform-exports/addressbook/2026-09-01", copied: false });
      expect(lines.find((line) => line.startsWith("contacts:"))).toMatch(/^contacts: the copy: could not copy .*AddressBook-v22\.abcddb/);
      // Nothing half made is left.
      expect(yield* Effect.promise(() => listed("platform-exports", "addressbook"))).toEqual(["2026-09-01"]);
      expect(namesIn(["+61491571491"])).toEqual({ "+61491571491": "Bruno Placeholder (addressBook)" });
      expect(runNote(result)).toContain("Mac's Contacts could not be copied, so names came from platform-exports/addressbook/2026-09-01.");
    }), 120_000);

  it.live("in a dry run says what it would do, and writes and notes nothing", () =>
    Effect.gen(function* () {
      yield* Effect.promise(madeUpMac);
      const notes = new Map<string, string>();
      const dryArchive = Layer.succeed(ArchiveCommands, {
        coversTo: Effect.succeed({ "imessage-db": Date.parse("2026-10-14T09:00:00+11:00") }),
        archive: (args: string[]) => Effect.die(`archive ${args.join(" ")} should not run`),
        checkData: Effect.die("check-data should not run"),
      });
      const result = yield* macImportsRun({ dataDir, home, now: NOW, dryRun: true }).pipe(Effect.provide(Layer.mergeAll(dryArchive, fakeNotifier(notes))));
      expect(result.sources.map((s) => s.detail)).toEqual([
        expect.stringMatching(/^dry run: something new: would copy CallHistory\.storedata \(0\.\d MB\), back up, and import$/),
        expect.stringMatching(/^dry run: something new: would copy chat\.db \(0\.\d MB\) and the attachments since 2026-10-12, back up, and import$/),
      ]);
      expect(yield* Effect.promise(() => readdir(dataDir))).toEqual([]);
      expect(notes.size).toBe(0);
    }));
});

describe("runNote", () => {
  it("says which step failed, where its copy waits, that the log has why, and when it tries again", () => {
    expect(runNote({
      ok: false,
      noAccess: [],
      sources: [
        { source: "calls", folder: "platform-exports/calls/2026-10-26", ok: true, detail: "Calls: 4 new", added: 4 },
        { source: "messages", folder: "platform-exports/imessage/2026-10-26", ok: false, detail: "the import", added: 0 },
      ],
      checkData: { ok: false, problems: 2 },
      contacts: { folder: "platform-exports/addressbook/2026-10-26", copied: true },
    })).toBe(
      "[life-archive mac-imports, automated] this Mac's calls and Messages: Calls: 4 new, from platform-exports/calls/2026-10-26 (a backup was taken first). " +
        "Messages: the import failed; its copy is in platform-exports/imessage/2026-10-26 in the archive's folder: run the import by hand as docs/import-runbook.md says, from the backup step. " +
        "check-data names 2 problems: run `npm run check-data` and fix each. The log (~/Library/Logs/LifeArchive/mac-imports.log) has why. " +
        "The next try is in an hour, and firstmate hears of another failure tomorrow at the soonest.",
    );
  });
});

describe("arrivedNote", () => {
  it("says each day's calls and messages, the syncs that brought them, and check-data's word", () => {
    expect(arrivedNote([
      ["2026-10-20", { calls: 1, messages: 0, attachments: 0, syncs: 1, problems: 0 }],
      ["2026-10-21", { calls: 2, messages: 14, attachments: 1, syncs: 5, problems: 3 }],
    ])).toBe(
      "[life-archive mac-imports, automated] what this Mac's calls and Messages brought into the archive: 2026-10-20: 1 call, in 1 sync; check-data found nothing wrong. " +
        "2026-10-21: 2 calls and 14 messages (1 attachment), in 5 syncs; check-data named 3 problems (noted then).",
    );
  });
});

const hasClang = spawnSync("/usr/bin/clang", ["--version"], { stdio: "ignore" }).status === 0;

describe("the launcher", () => {
  it.skipIf(!hasClang)("runs only node on the checkout's modules/friend-map/jobs/mac-imports.ts run, says it is the launcher, exits as it does, and is built again only when it changes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "mac-imports-repo-"));
    const out = join(repo, "bin", "life-archive-mac-imports");
    try {
      // A stand-in for the script, which says how it was run.
      await mkdir(join(repo, "modules", "friend-map", "jobs"), { recursive: true });
      await writeFile(join(repo, "modules", "friend-map", "jobs", "mac-imports.ts"), `
        import { writeFileSync } from "node:fs";
        writeFileSync("ran.json", JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), launcher: process.env.LIFE_ARCHIVE_MAC_IMPORTS_LAUNCHER }));
        process.exitCode = 3;
      `);
      expect(await buildLauncher({ node: process.execPath, repo, out })).toBe("built");
      expect(await buildLauncher({ node: process.execPath, repo, out })).toBe("unchanged");

      const ran = spawnSync(out, ["--ignored"], { cwd: tmpdir() });
      expect(ran.status).toBe(3);
      const said = JSON.parse(await readFile(join(repo, "ran.json"), "utf8")) as { args: string[]; cwd: string; launcher: string };
      expect(said).toEqual({ args: ["run"], cwd: expect.stringMatching(/mac-imports-repo-/), launcher: out });
      expect(spawnSync("/usr/bin/codesign", ["--verify", out]).status).toBe(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 60_000);

  it("is the program of a launchd agent that runs every 15 minutes and at load", () => {
    const text = plist({ node: "/home/sample/.vite-plus/bin/node", launcher: LAUNCHER, repo: "/opt/life-archive", logFile: "/tmp/mac-imports.log" });
    expect(text).toContain("<key>Label</key><string>local.life-archive-mac-imports</string>");
    expect(text).toContain(`<key>ProgramArguments</key><array><string>${LAUNCHER}</string></array>`);
    expect(text).toContain("<key>StartInterval</key><integer>900</integer>\n<key>RunAtLoad</key><true/>");
    expect(text).not.toContain("StartCalendarInterval");
    expect(text).toContain("<key>WorkingDirectory</key><string>/opt/life-archive</string>");
    expect(text).toContain("<string>/home/sample/.vite-plus/bin:/opt/homebrew/bin");
  });
});
