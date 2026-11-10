// The repair of the chats Messenger's phone export doubled, on made-up exports
// imported as the archive was: by the reader as it was before it keyed chats by
// name (fixtures/messengerExportBefore.ts).

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArchiveEvent, type ConnectorHost, type Db, ImportFailedError, loadRegistry, transaction, writeZip } from "../../../sdk/server.ts";
import { chatHost } from "../testing/host.ts";
import { readMessengerExport } from "../connectors/messenger-export/read.ts";
import { exportFolder, unpackedExport } from "../fixtures/exports.ts";
import { phoneExportPair, SELF } from "../fixtures/messenger.ts";
import { readMessengerExportBefore } from "../fixtures/messengerExportBefore.ts";
import { openArchive } from "./db.ts";
import { dryRunImport, loadModules } from "../../../sdk/testing.ts";
import { applyPhoneChats, chatsUnderOldKeys, chatsWithFileNameIds, planPhoneChats, unsentTexts, type UnsentTexts } from "./messengerPhoneChats.ts";
import { People } from "./people.ts";
import { ImportSession } from "./write.ts";

let dataDir: string;
let db: Db;
let people: People;
let host: ConnectorHost;
/** The texts the exports give unsent messages, read once they are unpacked. */
let texts: UnsentTexts;
const pair = phoneExportPair();
const folders = { first: "", later: "" };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "life-archive-phone-chats-"));
  db = openArchive(join(dataDir, "modules", "friend-map", "archive.sqlite"));
  people = new People(db);
  host = await chatHost(db, dataDir);
  await host.setEnabled("messenger-export", true);
  for (const [name, date] of [["first", "2026-09-27"], ["later", "2026-10-11"]] as const) {
    const zip = join(dataDir, `${name}.zip`);
    await writeZip(zip, pair[name]);
    folders[name] = await unpackedExport(zip, exportFolder(dataDir, "messenger", date));
  }
  texts = await unsentTexts(dataDir);
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * Imports an export as the reader before the fix did (or with `read`, another), as messenger-export's own import, then
 * runs the rules. It goes round the connector host, which refuses an import while chats are under their old keys.
 */
async function importBefore(folder: string, read = readMessengerExportBefore): Promise<void> {
  const events: ArchiveEvent[] = [];
  await read({ sources: [folder], config: {}, mediaDir: join(dataDir, "archive", "media"), emit: async (e) => void events.push(e as ArchiveEvent) });
  // Each import starts at its own millisecond, as real ones do.
  const startedAt = Date.now() + count("SELECT count(*) AS n FROM source");
  const source = Number(db.prepare(
    "INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 'messenger-export', 'export', ?, ?, 'running')",
  ).run(folder, startedAt).lastInsertRowid);
  transaction(db, () => {
    const session = new ImportSession(db, "messenger", source, "export", { dataDir });
    for (const event of JSON.parse(JSON.stringify(events)) as ArchiveEvent[]) session.apply(event);
    db.prepare("UPDATE source SET status = 'ok', finished_at = ? WHERE id = ?").run(Date.now(), source);
  });
  people.runRules();
}

/** Sorted by their JSON, for lists whose order is the export's order of files. */
const sorted = <T>(list: T[]) => [...list].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
const rows = <T>(sql: string, ...args: Array<string | number>) => db.prepare(sql).all(...args) as T[];
const count = (sql: string, ...args: Array<string | number>) => (db.prepare(sql).get(...args) as { n: number }).n;
const chatsTitled = (pattern: string) => rows<{ id: number; dropped_at: number | null }>(
  "SELECT id, dropped_at FROM conversation WHERE title GLOB ? ORDER BY id", pattern);
const personOf = (name: string) => (db.prepare("SELECT person_id FROM import_person WHERE key = ?").get(name) as { person_id: number }).person_id;
/** Every message as sender, time, kind and its attachments' bytes, sorted: what the archive holds, without ids. */
const messages = () => rows<{ who: string; sent_at: number; type: string; files: string | null }>(
  `SELECT a.display_name AS who, m.sent_at, m.type, (SELECT group_concat(sha256) FROM attachment WHERE message_id = m.id) AS files
   FROM message m JOIN import_person a ON a.id = m.sender_account_id`,
).map((m) => `${m.who} ${m.sent_at} ${m.type} ${m.files ?? ""}`).sort();

describe("repairing the chats the phone export doubled", () => {
  it("merges each copy into the first chat, keeps what was said about either, and later imports add nothing", async () => {
    await importBefore(folders.first);
    const once = messages();
    await importBefore(folders.later);
    // As in the captain's archive: the groups, and every "Facebook user" chat, came in twice.
    const [crew, crewCopy] = chatsTitled("Climbing crew_*");
    const [flat, flatCopy] = chatsTitled("Old flat_*");
    expect([crew, crewCopy, flat, flatCopy].every(Boolean)).toBe(true);
    expect(count("SELECT count(*) AS n FROM conversation")).toBe(12);
    expect(count("SELECT count(*) AS n FROM import_person WHERE display_name = 'Facebook user'")).toBe(6);
    const doubled = count("SELECT count(*) AS n FROM message");

    // The stopgap dropped the group's copy; the captain dropped the first "Old flat" himself, took Ada (who only
    // reacted) out of the crew's copy, and unlinked Dev from the flat's copy.
    people.dropGroup(crewCopy.id);
    people.dropGroup(flat.id);
    people.removeFromGroup(crewCopy.id, personOf("Ada Sample"));
    people.unlinkFromGroup(flatCopy.id, personOf("Dev Testington"));

    // Without the exports' texts, the group's unsent message's record (which lost its text) cannot give its id.
    expect(planPhoneChats(db).unrecognised.map((u) => [u.title, u.why])).toEqual([
      ["Climbing crew_21", "2 of its unsent messages' records no longer give their ids, and no phone export in platform-exports/messenger/ gives the text that does, so their new ids cannot be worked out"],
      ["Climbing crew_24", "2 of its unsent messages' records no longer give their ids, and no phone export in platform-exports/messenger/ gives the text that does, so their new ids cannot be worked out"],
    ]);
    const plan = planPhoneChats(db, texts);
    expect(plan.unrecognised).toEqual([]);
    // Hana's chat, in the later export only, with no photos sent together.
    expect(plan.settled).toBe(1);
    // Every message of the crew's copy is the first chat's, its photos sent together too, though each export named
    // them anew; and Ada's chat, under its key, holds those photos twice.
    expect(sorted(plan.repairs.map((r) => [r.kept.title, r.kept.newTitle, r.copies.map((c) => [c.same, c.moved])]))).toEqual([
      ["Ada Sample", "Ada Sample", []],
      ["Climbing crew_21", "Climbing crew", [[pair.crewMessages, 1]]],
      ["Facebook user", "Facebook user", [[0, 0]]],
      ["Facebook user", "Facebook user", [[0, 0]]],
      ["Facebook user", "Facebook user", [[2, 0]]],
      ["Old flat_26", "Old flat", [[2, 0]]],
    ]);
    const repairOf = (id: number) => plan.repairs.find((r) => r.kept.conversation === id);
    expect(repairOf(crew.id)).toMatchObject({
      kept: { dropped: false }, rekeysChat: true, doubled: 0, copies: [{ conversation: crewCopy.id, dropped: true }], removals: 1, differing: 0,
    });
    expect(plan.repairs.find((r) => r.kept.title === "Ada Sample")).toMatchObject({ kept: { messages: 5 }, rekeysChat: false, rekeyed: 4, doubled: 2, differing: 0 });
    expect(repairOf(flat.id)).toMatchObject({ kept: { dropped: true }, copies: [{ conversation: flatCopy.id }], unlinks: 1 });
    expect(plan.repairs.flatMap((r) => r.accounts).map((a) => [a.label, a.personGoes])).toEqual([["Facebook user", true], ["Facebook user", true], ["Facebook user", true]]);
    // A dry run changes nothing.
    expect(count("SELECT count(*) AS n FROM message")).toBe(doubled);

    const result = applyPhoneChats(db, () => people.runRules(), texts);
    expect(result).toMatchObject({ chatsDeleted: 5, accountsDeleted: 3, peopleDeleted: 3, messagesMoved: 1, messagesDeleted: pair.crewMessages + 2 + 2, doublesMerged: 2 });
    expect(count("SELECT count(*) AS n FROM conversation")).toBe(7);
    // Every message once: the first export's, and the later's two new ones.
    expect(messages()).toHaveLength(once.length + 2);
    expect(new Set(messages()).size).toBe(messages().length);
    // The first chats are kept, by their names; the copy's drop is not carried, the first's own is kept.
    expect(rows<{ id: number; title: string; dropped: number }>(
      "SELECT id, title, dropped_at IS NOT NULL AS dropped FROM conversation WHERE type = 'group' ORDER BY id",
    )).toEqual([{ id: crew.id, title: "Climbing crew", dropped: 0 }, { id: flat.id, title: "Old flat", dropped: 1 }]);
    // Who was taken out of or unlinked from a copy stays so.
    expect(count("SELECT count(*) AS n FROM conversation_member WHERE conversation_id = ? AND removed_at IS NOT NULL", crew.id)).toBe(1);
    expect(rows("SELECT person_id, conversation_id FROM group_unlink")).toEqual([{ person_id: personOf("Dev Testington"), conversation_id: flat.id }]);
    // The photos are the newest export's, and the reaction is kept once.
    expect(rows<{ local_path: string }>("SELECT local_path FROM attachment ORDER BY local_path").map((a) => a.local_path)).toEqual([
      "platform-exports/messenger/2026-10-11/media/ada_sample_6/photo_2054.jpeg",
      "platform-exports/messenger/2026-10-11/media/ada_sample_6/photo_2055.jpeg",
      "platform-exports/messenger/2026-10-11/media/climbing_crew_24/crag.jpeg",
      "platform-exports/messenger/2026-10-11/media/climbing_crew_24/photo_2052.jpeg",
      "platform-exports/messenger/2026-10-11/media/climbing_crew_24/photo_2053.jpeg",
    ]);
    expect(count("SELECT count(*) AS n FROM reaction")).toBe(1);
    // A deleted account per chat, keyed by the chat, and a person each.
    const unknown = rows<{ key: string }>("SELECT key FROM import_person WHERE display_name = 'Facebook user'");
    expect(unknown).toHaveLength(3);
    expect(count("SELECT count(*) AS n FROM person WHERE name = 'Facebook user'")).toBe(3);
    expect(count("SELECT count(*) AS n FROM import_person WHERE person_id IS NULL")).toBe(0);
    for (const { key } of unknown) {
      expect(count("SELECT count(*) AS n FROM conversation_member cm JOIN conversation c ON c.id = cm.conversation_id JOIN import_person a ON a.id = cm.account_id WHERE a.key = ? AND substr(c.platform_conversation_id, 1, 8) = substr(?, -8)", key, key)).toBe(1);
    }
    // The counts are worked out again: Gus wrote two messages in the crew, once each, and Ada two photos and a text to the captain.
    expect(db.prepare("SELECT group_count FROM import_person_stats s JOIN import_person a ON a.id = s.import_person_id WHERE a.key = 'Gus Unlisted'").get())
      .toEqual({ group_count: 2 });
    expect(db.prepare("SELECT direct_count FROM import_person_stats s JOIN import_person a ON a.id = s.import_person_id WHERE a.key = 'Ada Sample'").get())
      .toEqual({ direct_count: 3 });

    // Run again, with the exports' texts or without, there is nothing to do.
    expect(planPhoneChats(db, texts)).toEqual({ repairs: [], unrecognised: [], settled: 7 });
    expect(planPhoneChats(db)).toEqual({ repairs: [], unrecognised: [], settled: 7 });
    expect(applyPhoneChats(db, () => people.runRules(), texts)).toMatchObject({ chatsDeleted: 0, messagesDeleted: 0, messagesRekeyed: 0, doublesMerged: 0 });

    // Both exports, imported again by the reader as it is now, add nothing.
    const after = messages();
    for (const folder of [folders.first, folders.later]) {
      const again = await host.importHistory("messenger-export", folder);
      expect(again.counts.messages).toMatchObject({ added: 0, updated: 0, matched: 0 });
      expect(again.counts.conversations).toEqual({ added: 0, updated: 0 });
      expect(again.counts.accounts.added).toBe(0);
      expect(again.counts.attachments).toMatchObject({ added: 0, updated: 0 });
      expect(again.counts.reactions.added).toBe(0);
    }
    expect(messages()).toEqual(after);
    expect(planPhoneChats(db, texts).repairs).toEqual([]);
  });

  it("finishes an archive the repair before the exports' texts left half done", async () => {
    await importBefore(folders.first);
    await importBefore(folders.later);
    // As in the captain's archive: the repair without the texts merged the "Facebook user" chats (and the group with
    // no unsent message) and left the group with one.
    applyPhoneChats(db, () => people.runRules());
    expect(chatsTitled("Climbing crew_*")).toHaveLength(2);
    expect(chatsTitled("Old flat*")).toHaveLength(1);
    const plan = planPhoneChats(db, texts);
    expect(plan).toMatchObject({ unrecognised: [], settled: 6 });
    expect(plan.repairs.map((r) => [r.kept.title, r.kept.newTitle, r.copies.map((c) => c.title), r.accounts.length])).toEqual([
      ["Climbing crew_21", "Climbing crew", ["Climbing crew_24"], 0],
    ]);
    applyPhoneChats(db, () => people.runRules(), texts);
    expect(rows("SELECT title FROM conversation WHERE type = 'group' ORDER BY id")).toEqual([{ title: "Climbing crew" }, { title: "Old flat" }]);
    expect(planPhoneChats(db, texts)).toEqual({ repairs: [], unrecognised: [], settled: 7 });
    const again = await host.importHistory("messenger-export", folders.later);
    expect(again.counts.messages).toMatchObject({ added: 0, updated: 0, matched: 0 });
    expect(again.counts.conversations.added).toBe(0);
  });

  it("refuses an import, and its dry run, while a chat is under its old key", async () => {
    await importBefore(folders.first);
    expect(sorted(chatsUnderOldKeys(db).map((c) => c.title))).toEqual(["Climbing crew_21", "Facebook user", "Facebook user", "Facebook user", "Old flat_26"]);
    const sources = count("SELECT count(*) AS n FROM source");
    const refusal = /^messenger-export: 5 of the archive's Messenger phone-export chats \(#\d+ "[^"]+", .*\) are still under the keys they had before chats were keyed by name, so this import would bring them in again as new chats\. Repair them first: npm run archive -- repair messenger-phone-chats$/;
    const refused = await host.importHistory("messenger-export", folders.later).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ImportFailedError);
    expect((refused as Error).message).toMatch(refusal);
    await expect(dryRunImport(dataDir, "messenger-export", [folders.later], {}, await loadModules({ all: true }))).rejects.toThrow(refusal);
    expect(count("SELECT count(*) AS n FROM source")).toBe(sources);
    expect(chatsTitled("Climbing crew*")).toHaveLength(1);

    applyPhoneChats(db, () => people.runRules(), texts);
    expect(chatsUnderOldKeys(db)).toEqual([]);
    const later = await host.importHistory("messenger-export", folders.later);
    expect(later.counts.conversations.added).toBe(1);
    expect(chatsTitled("Climbing crew*")).toHaveLength(1);
  });

  it("refuses an import while photos sent together have ids made from their file names, and repairs them", async () => {
    // An archive whose only phone-export chat is Ada's: under its key, but its photos' ids are the first export's names.
    const zip = join(dataDir, "ada.zip");
    const cleo = { participants: [SELF, "Cleo Example"], threadName: "Cleo Example_5", messages: [] };
    await writeZip(zip, [
      ...pair.first.filter((f) => !f.name.endsWith(".json") || f.name.startsWith("Ada Sample")),
      { name: "Cleo Example_5.json", data: JSON.stringify(cleo) },
    ]);
    await importBefore(await unpackedExport(zip, exportFolder(dataDir, "messenger", "2026-09-20")));
    expect(chatsUnderOldKeys(db)).toEqual([]);
    expect(chatsWithFileNameIds(db).map((c) => c.title)).toEqual(["Ada Sample"]);
    const refused = await host.importHistory("messenger-export", folders.later).catch((error: unknown) => error);
    expect((refused as Error).message).toMatch(
      /^messenger-export: 1 of the archive's Messenger phone-export chats \(#\d+ "Ada Sample"\) hold photos sent together whose ids were made from their file names, which each export names anew, so this import would bring them in again\. Repair them first: npm run archive -- repair messenger-phone-chats$/,
    );

    expect(planPhoneChats(db).repairs.map((r) => [r.kept.title, r.rekeysChat, r.rekeyed, r.doubled])).toEqual([["Ada Sample", false, 2, 0]]);
    applyPhoneChats(db, () => people.runRules());
    expect(chatsWithFileNameIds(db)).toEqual([]);
    expect(planPhoneChats(db)).toEqual({ repairs: [], unrecognised: [], settled: 2 });
    const later = await host.importHistory("messenger-export", folders.later);
    expect(count("SELECT count(*) AS n FROM message WHERE conversation_id = (SELECT id FROM conversation WHERE title = 'Ada Sample')")).toBe(3);
    expect(later.counts.messages.unchanged).toBeGreaterThanOrEqual(3);
  });

  it("merges a copy imported since the fix, before the repair", async () => {
    await importBefore(folders.first);
    // The host refuses this now; as it was before it did.
    await importBefore(folders.later, readMessengerExport);
    expect(chatsTitled("Climbing crew*")).toHaveLength(2);
    // Ada's photos came in twice too: by their file names from the first, and by their places from the later.
    const result = applyPhoneChats(db, () => people.runRules(), texts);
    expect(result).toMatchObject({ chatsDeleted: 5, accountsDeleted: 3, doublesMerged: 2 });
    expect(planPhoneChats(db, texts)).toMatchObject({ repairs: [], settled: 7 });
    const again = await host.importHistory("messenger-export", folders.later);
    expect(again.counts.messages).toMatchObject({ added: 0, updated: 0 });
    expect(again.counts.conversations.added).toBe(0);
  });

  it("re-keys a chat imported once, so the next export finds it", async () => {
    await importBefore(folders.first);
    const plan = planPhoneChats(db, texts);
    expect(sorted(plan.repairs.map((r) => [r.kept.newTitle, r.copies.length, r.rekeyed]))).toEqual([
      ["Ada Sample", 0, 2],
      ["Climbing crew", 0, pair.crewMessages], ["Facebook user", 0, 0], ["Facebook user", 0, 0], ["Facebook user", 0, 2], ["Old flat", 0, 2],
    ]);
    applyPhoneChats(db, () => people.runRules(), texts);
    // A group with no copy is retitled too.
    expect(rows("SELECT title FROM conversation WHERE type = 'group' ORDER BY id")).toEqual([{ title: "Climbing crew" }, { title: "Old flat" }]);
    const later = await host.importHistory("messenger-export", folders.later);
    // Only what is new: the new chat with its message and its person, and the group's new message (not Ada's photos,
    // which the later export names anew).
    expect(later.counts.messages).toMatchObject({ added: 2, updated: 0 });
    expect(later.counts.conversations.added).toBe(1);
    expect(later.counts.accounts.added).toBe(1);
  });

  it("leaves alone, and names, a chat it cannot recognise or whose messages' records no longer give their ids", async () => {
    await importBefore(folders.first);
    await importBefore(folders.later);
    const [, crewCopy] = chatsTitled("Climbing crew_*");
    const [flat, flatCopy] = chatsTitled("Old flat_*");
    // A message's record that no longer gives its id (as an unsent message's would, had its text not been empty).
    const one = db.prepare("SELECT id, raw_json FROM message WHERE conversation_id = ? LIMIT 1").get(crewCopy.id) as { id: number; raw_json: string };
    db.prepare("UPDATE message SET raw_json = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(one.raw_json), text: "changed" }), one.id);
    // A chat whose id is not the phone export's for its members and title.
    db.prepare("UPDATE conversation SET title = 'Old flat_99' WHERE id = ?").run(flatCopy.id);

    const plan = planPhoneChats(db, texts);
    expect(plan.unrecognised.map((u) => [u.title, u.why])).toEqual([
      ["Climbing crew_21", "1 of its messages' records no longer give their ids, so their new ids cannot be worked out"],
      ["Climbing crew_24", "1 of its messages' records no longer give their ids, so their new ids cannot be worked out"],
      ["Old flat_99", "its id is not the one the phone export gives its members and title"],
    ]);
    // The first "Old flat" alone is re-keyed; the "Facebook user" chats are merged, and Ada's photos.
    expect(sorted(plan.repairs.map((r) => [r.kept.title, r.copies.length]))).toEqual([
      ["Ada Sample", 0], ["Facebook user", 1], ["Facebook user", 1], ["Facebook user", 1], ["Old flat_26", 0],
    ]);
    const before = count("SELECT count(*) AS n FROM message WHERE conversation_id IN (SELECT id FROM conversation WHERE title GLOB 'Climbing crew_*')");
    applyPhoneChats(db, () => people.runRules(), texts);
    expect(chatsTitled("Climbing crew_*")).toHaveLength(2);
    expect(count("SELECT count(*) AS n FROM message WHERE conversation_id IN (SELECT id FROM conversation WHERE title GLOB 'Climbing crew_*')")).toBe(before);
    expect(chatsTitled("Old flat*").map((c) => c.id)).toEqual([flat.id, flatCopy.id]);
  });

  it("from the CLI: a dry run, refused without a checked backup, then made after one", async () => {
    await importBefore(folders.first);
    await importBefore(folders.later);
    const doubled = count("SELECT count(*) AS n FROM message");
    db.close();
    const run = async (script: string, ...args: string[]) => {
      try {
        return { code: 0, ...(await promisify(execFile)(process.execPath, ["--no-warnings", fileURLToPath(new URL(script, import.meta.url)), ...args])) };
      } catch (error) {
        return error as { code: number; stdout: string; stderr: string };
      }
    };
    const repair = (...args: string[]) => run("../../../server/archive/cli.ts", "repair", "messenger-phone-chats", ...args, "--data", dataDir);
    try {
      const dry = await repair();
      expect(dry.code).toBe(0);
      expect(dry.stdout).toMatch(/^chat #\d+ \(group\) "Climbing crew_21", 6 messages: takes its new key, titled "Climbing crew", 6 of its messages new ids$/m);
      expect(dry.stdout).toMatch(/^  merges chat #\d+ \(group\) "Climbing crew_24", 7 messages: 6 the first chat's own, which go, and 1 new to it, which move; then deletes it$/m);
      expect(dry.stdout).toMatch(/^chat #\d+ \(direct\) "Ada Sample", 5 messages: keeps its key, 4 of its messages new ids; 2 it holds twice \(photos sent together, brought in again by a later export\), which go$/m);
      expect(dry.stdout).toMatch(/^  merges account #\d+ "Facebook user" into the first chat's, #\d+, and deletes it; its person \d+ goes with it$/m);
      expect(dry.stdout).toMatch(/^In all: 5 chats take their new keys and 1 keep theirs; 5 copies are merged into them and deleted \(10 of their messages go, 1 move\); 2 messages held twice in one chat go; 3 deleted-account accounts are merged away; 1 chats are under their keys already; 0 are left as they are\.\nNothing changed \(a dry run\)/m);

      // A backup that cannot be made (its folder is a file) refuses the repair.
      await writeFile(join(dataDir, "backups"), "");
      const refused = await repair("--apply");
      expect(refused.code).toBe(1);
      db = openArchive(join(dataDir, "modules", "friend-map", "archive.sqlite"));
      expect(count("SELECT count(*) AS n FROM message")).toBe(doubled);
      db.close();
      await rm(join(dataDir, "backups"));

      const applied = await repair("--apply");
      expect(applied.code).toBe(0);
      expect(applied.stdout).toMatch(/^Backed up to \S+before-repair-messenger-phone-chats\.sqlite, integrity ok\.$/m);
      expect(applied.stdout).toMatch(/^Repaired 6 chats: 5 copies deleted, 10 of their messages merged and 1 moved, \d+ of the first chats' messages given new ids, 2 held twice in one chat merged, 3 accounts merged away and 3 people with no account left deleted by the rules\.$/m);
      expect((await readdir(join(dataDir, "backups"))).filter((name) => name.endsWith("-before-repair-messenger-phone-chats.sqlite"))).toHaveLength(1);
      expect((await run("../../../server/check-data.ts", dataDir)).code).toBe(0);
      expect((await run("../../../server/archive/cli.ts", "calendar", "check", "--data", dataDir)).code).toBe(0);
      expect((await repair("--apply")).stdout).toBe("Nothing to repair: 7 phone-export chats are under their keys already.\n");
    } finally {
      db = openArchive(join(dataDir, "modules", "friend-map", "archive.sqlite"));
    }
  });

  it("does nothing to an archive with no phone export", () => {
    expect(planPhoneChats(db)).toEqual({ repairs: [], unrecognised: [], settled: 0 });
  });
});
