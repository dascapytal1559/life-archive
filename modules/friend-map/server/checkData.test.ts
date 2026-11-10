import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setCallAnswered, setCallNote } from "./calls.ts";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { transaction, wallClock } from "../../../sdk/server.ts";
import { openArchive } from "./db.ts";
import { CORE_FILE, openCore } from "../../../sdk/testing.ts";
import { People } from "./people.ts";
import { ImportSession } from "./write.ts";

const SCRIPT = fileURLToPath(new URL("../../../server/check-data.ts", import.meta.url));

let dataDir: string;
let archiveFile: string;
/** The environment check-data runs in: the testing settings with the other module that checks its data (the inspirations) off, so these check friend map's alone. */
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "life-archive-check-"));
  archiveFile = join(dataDir, "modules", "friend-map", "archive.sqlite");
  // The core's database: a folder with none is no archive.
  openCore(join(dataDir, CORE_FILE)).close();
  const testing = JSON.parse(readFileSync(process.env.LIFE_ARCHIVE_SETTINGS!, "utf8")) as Record<string, unknown>;
  const settingsFile = join(dataDir, "settings.testing.json");
  await writeFile(settingsFile, JSON.stringify({ ...testing, modules: { inspirations: false } }));
  env = { ...process.env, LIFE_ARCHIVE_SETTINGS: settingsFile };
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function checkData(): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [SCRIPT, dataDir], { env });
    return { code: 0, stdout };
  } catch (error) {
    const { code, stdout } = error as { code: number; stdout: string };
    return { code, stdout };
  }
}

/** An archive with Ada in it, named, aliased and tagged the way the app writes them. */
function archiveWithAda(): number {
  const db = openArchive(archiveFile);
  const people = new People(db);
  const ada = people.create("Ada");
  people.setAliases(ada, ["Addy"]);
  people.setTags(ada, ["climbing"]);
  db.close();
  return ada;
}

it("passes when every person is fine, beside the captain's own folders (his Obsidian vault)", async () => {
  archiveWithAda();
  await mkdir(join(dataDir, "Vault", ".obsidian"), { recursive: true });
  await writeFile(join(dataDir, "Vault", "Journal.md"), "made-up notes");
  expect(await checkData()).toEqual({ code: 0, stdout: `Checked friend-map in ${dataDir}: all fine; switched off, so not checked: inspirations.\n` });
});

it("fails with one line per problem: a person's fields and identicon seed, a tag, and an account linked to nobody", async () => {
  const ada = archiveWithAda();
  const db = openArchive(archiveFile);
  db.prepare("UPDATE person SET name = '', aliases_json = '\"Addy\"', note = ' padded ', identicon_seed = NULL WHERE id = ?").run(ada);
  const draft = Number(db.prepare("INSERT INTO draft (person_id, text, created_at, updated_at) VALUES (?, 'Hi\r\n', 0, 0)").run(ada).lastInsertRowid);
  const me = (db.prepare("SELECT id FROM person WHERE is_self = 1").get() as { id: number }).id;
  db.prepare("UPDATE person SET should_reach_out = 1 WHERE id = ?").run(me);
  db.prepare("UPDATE person SET location = ' Brisbane' WHERE id = ?").run(me);
  db.prepare("UPDATE tag SET name = 'Not/ok' WHERE name = 'climbing'").run();
  db.prepare("UPDATE tag SET name = 'Two Words', built_in = 0 WHERE name = 'keep'").run();
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("INSERT INTO import_person (platform, key, key_kind, display_name, person_id) VALUES ('messenger', 'Gus', 'name', 'Gus', 999)").run();
  db.close();
  const { code, stdout } = await checkData();
  expect(code).toBe(1);
  expect(stdout).toBe(
    `person ${me}: its location is not written the way the app writes them\n` +
      `person ${me}: this is you, and you are not someone to reach out to\n` +
      `person ${me}: this is you, and you have no location, but you have one\n` +
      `person ${ada}: its name: a name can't be empty\n` +
      `person ${ada}: its aliases: aliases must be a list of names\n` +
      `person ${ada}: its note is not written the way the app writes them\n` +
      `person ${ada}: it has no identicon seed (16 hex digits); \`npm run archive -- rules\` gives it one\n` +
      'tag "Two Words": it is not written the way the app writes tags (two-words)\n' +
      'tag "Not/ok": "Not/ok" is not a tag (letters, digits and dashes, up to 40)\n' +
      'tag "keep": it is missing, and is always there\n' +
      `draft #${draft} (person ${ada}): it is not written the way the app writes drafts\n` +
      "account 1: it points at no person, or its link source \"import\" is unknown; `npm run archive -- rules` links it\n" +
      `Checked friend-map in ${dataDir}: 12 to fix; switched off, so not checked: inspirations.\n`,
  );
});

it("finds a location written two ways, but for case, and says how to make them one", async () => {
  const ada = archiveWithAda();
  const db = openArchive(archiveFile);
  const people = new People(db);
  const [bruno, cy] = [people.create("Bruno Placeholder"), people.create("Cy Sample")];
  people.setLocation(ada, "Brisbane");
  people.setLocation(bruno, "Brisbane");
  // As an edit outside the app could leave it.
  db.prepare("UPDATE person SET location = 'BRISBANE' WHERE id = ?").run(cy);
  db.close();
  const { code, stdout } = await checkData();
  expect(code).toBe(1);
  expect(stdout).toBe(
    'location "Brisbane" (2) is also written "BRISBANE" (1): npm run archive -- location rename "BRISBANE" "Brisbane" makes them one\n' +
      `Checked friend-map in ${dataDir}: 1 to fix; switched off, so not checked: inspirations.\n`,
  );
});

it("checks catch-ups: written as the app writes them, in person, with someone, never the captain", async () => {
  const ada = archiveWithAda();
  const db = openArchive(archiveFile);
  const people = new People(db);
  const fine = people.addCatchUp({ day: "2026-09-27", hours: 2.5, note: "a long call", personIds: [ada] });
  const padded = people.addCatchUp({ day: "2026-09-28", hours: 1, note: "", personIds: [ada] });
  const empty = people.addCatchUp({ day: "2026-09-29", hours: 1, note: "", personIds: [ada] });
  const withMe = people.addCatchUp({ day: "2026-09-30", hours: 1, note: "", personIds: [ada] });
  const trip = { day: "2026-09-04", time: "18:00", trip: { lastDay: "2026-09-06", endTime: "16:00" }, note: "", personIds: [ada] };
  const fineTrip = people.addCatchUp(trip);
  const offTrip = people.addCatchUp(trip);
  const me = (db.prepare("SELECT id FROM person WHERE is_self = 1").get() as { id: number }).id;
  db.prepare("UPDATE catch_up SET note = ' dinner ', hours = 1.004 WHERE id = ?").run(padded);
  db.prepare("DELETE FROM catch_up_person WHERE catch_up_id = ?").run(empty);
  // A trip's hours are its time together, worked out: not what it says.
  db.prepare("UPDATE catch_up SET hours = 40 WHERE id = ?").run(offTrip);
  db.prepare("INSERT INTO catch_up_person (catch_up_id, person_id) VALUES (?, ?)").run(withMe, me);
  db.close();
  const { code, stdout } = await checkData();
  expect(code).toBe(1);
  expect(stdout).not.toContain(`catch-up #${fine}`);
  expect(stdout).not.toContain(`catch-up #${fineTrip}`);
  expect(stdout).toContain(`catch-up #${offTrip}: it is not written the way the app writes catch-ups\n`);
  expect(stdout).toContain(`catch-up #${padded}: it is not written the way the app writes catch-ups\n`);
  expect(stdout).toContain(`catch-up #${empty}: a hangout is with someone: give at least one person\n`);
  expect(stdout).toContain(`catch-up #${withMe}: you are at it, and a catch-up is with other people\n`);
});

it("checks the calls the captain logged: a whole number of minutes, from a whole minute, with someone, never the captain, on an account that carries calls", async () => {
  const ada = archiveWithAda();
  const db = openArchive(archiveFile);
  const people = new People(db);
  const call = { people: [{ personId: ada, accountId: null, app: "phone" }], day: "2026-09-27", time: "19:30", minutes: 25 };
  const fine = people.addCall(call);
  const odd = people.addCall(call);
  const withMe = people.addCall(call);
  const me = (db.prepare("SELECT id FROM person WHERE is_self = 1").get() as { id: number }).id;
  db.prepare("UPDATE manual_call SET duration_seconds = 90 WHERE id = ?").run(odd);
  db.prepare("UPDATE manual_call SET person_id = ? WHERE id = ?").run(me, withMe);
  const x = Number(db.prepare("INSERT INTO import_person (platform, key, key_kind, display_name, person_id) VALUES ('x', 'adasample', 'id', 'Ada', ?)").run(ada).lastInsertRowid);
  const onX = Number(db.prepare("INSERT INTO manual_call (call_group, account_id, at, duration_seconds, created_at) VALUES (0, ?, ?, 300, 0)").run(x, wallClock("2026-09-27", "19:30")).lastInsertRowid);
  db.prepare("UPDATE manual_call SET call_group = ? WHERE id = ?").run(onX, onX);
  // A group call whose calls are at different times.
  const bea = people.create("Bea Sample");
  const group = people.addCall({ ...call, people: [...call.people, { personId: bea, accountId: null, app: "phone" }] });
  db.prepare("UPDATE manual_call SET at = at + 60000 WHERE id = ?").run(group + 1);
  // A group call whose calls have different notes, and a call whose note has space round it.
  const noted = people.addCall({ ...call, note: "Planned the trip", people: [...call.people, { personId: bea, accountId: null, app: "phone" }] });
  db.prepare("UPDATE manual_call SET note = 'Something else' WHERE id = ?").run(noted + 1);
  const padded = people.addCall({ ...call, note: "Fine" });
  db.prepare("UPDATE manual_call SET note = '  Fine ' WHERE id = ?").run(padded);
  // A call with people unnamed is fine; a group call whose calls say different numbers of them is not.
  const withOthers = people.addCall({ ...call, others: 2 });
  const crowd = people.addCall({ ...call, others: 2, people: [...call.people, { personId: bea, accountId: null, app: "phone" }] });
  db.prepare("UPDATE manual_call SET others = 3 WHERE id = ?").run(crowd + 1);
  db.close();
  const { code, stdout } = await checkData();
  expect(code).toBe(1);
  expect(stdout).not.toContain(`logged call #${fine}`);
  expect(stdout).toContain(`logged call #${odd}: a call lasts a whole number of minutes, from 1 to 1440\n`);
  expect(stdout).toContain(`logged call #${withMe}: it is with you, and a call is with someone else\n`);
  expect(stdout).toContain(`logged call #${onX}: it is on an account on x, which carries no calls\n`);
  expect(stdout).toContain(`logged call group #${group}: its calls differ in when they started, how long they lasted, their note or their unnamed others`);
  expect(stdout).toContain(`logged call group #${noted}: its calls differ in when they started, how long they lasted, their note or their unnamed others`);
  expect(stdout).toContain(`logged call group #${crowd}: its calls differ`);
  expect(stdout).not.toContain(`logged call #${withOthers}:`);
  expect(stdout).toContain(`logged call #${padded}: its note is not written the way the app writes notes\n`);
  expect(stdout).not.toContain(`logged call group #${fine}:`);
});

it("checks the notes on imported calls: written as the app writes notes, on a call still in the archive", async () => {
  const ada = archiveWithAda();
  const db = openArchive(archiveFile);
  const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('phone', 'call-history', 'app-db', 't', 0, 'ok')").run().lastInsertRowid);
  const phone = Number(db.prepare("INSERT INTO import_person (platform, key, key_kind, display_name, person_id) VALUES ('phone', '+61491570006', 'id', 'Ada', ?)").run(ada).lastInsertRowid);
  const callId = Number(db.prepare(
    `INSERT INTO call (platform, platform_call_id, import_person_id, at, duration_seconds, direction, answered, service, first_source_id, last_source_id, raw_json)
     VALUES ('phone', 'P1', ?, 0, 60, 'incoming', 1, 'phone', ?, ?, '{}')`,
  ).run(phone, source, source).lastInsertRowid);
  const people = new People(db);
  const note = (text: string) => setCallNote(db, people.manualCalls, { kind: "call", id: callId }, text);
  note("Talked about the move");
  const fine = (db.prepare("SELECT id FROM call_note").get() as { id: number }).id;
  db.prepare("UPDATE call_note SET note = ' Talked about the move' WHERE id = ?").run(fine);
  const lost = Number(db.prepare("INSERT INTO call_note (platform, platform_call_id, note, set_at) VALUES ('phone', 'gone', 'A note', 0)").run().lastInsertRowid);
  db.close();
  const { code, stdout } = await checkData();
  expect(code).toBe(1);
  expect(stdout).toContain(`call note #${fine}: it is not written the way the app writes notes\n`);
  expect(stdout).not.toContain(`call note #${fine}: its call`);
  expect(stdout).toContain(`call note #${lost}: its call is no longer in the archive (or no longer a call in a one-to-one chat)\n`);
});

it("checks the captain's answers on imported calls: on a call still in the archive, as notes are, an emptied one too", async () => {
  const ada = archiveWithAda();
  const db = openArchive(archiveFile);
  const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('phone', 'call-history', 'app-db', 't', 0, 'ok')").run().lastInsertRowid);
  const phone = Number(db.prepare("INSERT INTO import_person (platform, key, key_kind, display_name, person_id) VALUES ('phone', '+61491570006', 'id', 'Ada', ?)").run(ada).lastInsertRowid);
  const callId = Number(db.prepare(
    `INSERT INTO call (platform, platform_call_id, import_person_id, at, duration_seconds, direction, answered, service, first_source_id, last_source_id, raw_json)
     VALUES ('phone', 'P1', ?, 0, 60, 'incoming', 1, 'phone', ?, ?, '{}')`,
  ).run(phone, source, source).lastInsertRowid);
  setCallAnswered(db, { kind: "call", id: callId }, "missed");
  const fine = (db.prepare("SELECT id FROM call_answered").get() as { id: number }).id;
  const answer = db.prepare("INSERT INTO call_answered (platform, platform_call_id, answered, set_at) VALUES ('phone', ?, ?, 0)");
  const lost = Number(answer.run("gone", "missed").lastInsertRowid);
  const emptied = Number(answer.run("also gone", "").lastInsertRowid);
  db.close();
  const { code, stdout } = await checkData();
  expect(code).toBe(1);
  expect(stdout).not.toContain(`call answered #${fine}:`);
  expect(stdout).toContain(`call answered #${lost}: its call is no longer in the archive (or no longer a call in a one-to-one chat)\n`);
  expect(stdout).toContain(`call answered #${emptied}: its call is no longer in the archive`);
});

it("lets a person the import left without a name be while the rules archive them, but not once the captain edits them or they are shown", async () => {
  const db = openArchive(archiveFile);
  transaction(db, () => {
    const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 'test', 'export', 'test', 0, 'ok')").run().lastInsertRowid);
    const session = new ImportSession(db, "messenger", source, "export");
    session.apply({ kind: "account", key: "Me", keyKind: "name", displayName: "Me", isSelf: true });
    for (const key of ["1", "2", "3"]) session.apply({ kind: "account", key, keyKind: "id", displayName: "" });
  });
  const people = new People(db);
  people.runRules();
  const blank = (db.prepare("SELECT id, archive_rule FROM person WHERE name = '' ORDER BY id").all() as { id: number; archive_rule: string }[]);
  expect(blank.map((p) => p.archive_rule)).toEqual(["unknown", "unknown", "unknown"]);
  const [, tagged, shown] = blank.map((p) => p.id);
  people.setTags(tagged, ["friend"]);
  db.prepare("UPDATE person SET archive_rule = NULL WHERE id = ?").run(shown);
  db.close();
  const { code, stdout } = await checkData();
  expect(code).toBe(1);
  expect(stdout).toBe(
    `person ${tagged}: its name: a name can't be empty\n` +
      `person ${shown}: its name: a name can't be empty\n` +
      `Checked friend-map in ${dataDir}: 2 to fix; switched off, so not checked: inspirations.\n`,
  );
});

it("lets a name the captain never set keep the platform's stray spaces, but not one the captain edited", async () => {
  const ada = archiveWithAda();
  const db = openArchive(archiveFile);
  const haruki = Number(db.prepare("INSERT INTO person (name, name_source, created_at, identicon_seed) VALUES ('Haruki  Oda ', 'import', 0, '0123456789abcdef')").run().lastInsertRowid);
  db.prepare("INSERT INTO import_person (platform, key, key_kind, display_name, person_id, link_source) VALUES ('messenger', 'Haruki  Oda ', 'name', 'Haruki  Oda ', ?, 'import')").run(haruki);
  db.prepare("UPDATE person SET name = 'Ada  Sample' WHERE id = ?").run(ada);
  db.close();
  const { code, stdout } = await checkData();
  expect(code).toBe(1);
  expect(stdout).toBe(`person ${ada}: its name is not written the way the app writes them\nChecked friend-map in ${dataDir}: 1 to fix; switched off, so not checked: inspirations.\n`);
});

it("names someone whose name is one of their aliases too: each name is listed once", async () => {
  const ada = archiveWithAda();
  const db = openArchive(archiveFile);
  db.prepare("UPDATE person SET aliases_json = ? WHERE id = ?").run(JSON.stringify(["Addy", (db.prepare("SELECT name FROM person WHERE id = ?").get(ada) as { name: string }).name]), ada);
  db.close();
  const { code, stdout } = await checkData();
  expect(code).toBe(1);
  expect(stdout).toBe(`person ${ada}: one of its aliases is its name; a name is listed once\nChecked friend-map in ${dataDir}: 1 to fix; switched off, so not checked: inspirations.\n`);
});

it("says to start the app first when the archive is from older code", async () => {
  openArchive(archiveFile, { version: 4 }).close();
  const { code, stdout } = await checkData();
  expect(code).toBe(1);
  expect(stdout).toMatch(/^archive\.sqlite is from older code \(schema 4, now \d+\): bring it up to date with npm run archive -- migrate/);
});

it("fails differently when there is nothing to check", async () => {
  await rm(join(dataDir, CORE_FILE));
  const { code, stdout } = await checkData();
  expect(code).toBe(2);
  expect(stdout).toMatch(/^Could not check the data: there is no archive in .* \(no core\.sqlite\)/);
});

it("checks the archive in the folder the environment names, when given no folder", async () => {
  archiveWithAda();
  const named = { ...env, FRIEND_MAP_DATA: "", LIFE_ARCHIVE_DATA: dataDir };
  const { stdout } = await promisify(execFile)(process.execPath, [SCRIPT], { env: named });
  expect(stdout).toBe(`Checked friend-map in ${dataDir}: all fine; switched off, so not checked: inspirations.\n`);
});

it("says friend map was not checked when its archive is not in the folder, and never that all is fine", async () => {
  const { code, stdout } = await checkData();
  expect(code).toBe(2);
  expect(stdout).toBe(
    `The friend-map module has no database at ${archiveFile}, so its data is not checked.\n` +
    `Checked nothing in ${dataDir}: nothing to fix in what was checked; not checked: friend-map; switched off, so not checked: inspirations.\n`,
  );
});
