import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type ArchiveEvent, type TimelinePage, transaction } from "../../../sdk/server.ts";
import { sampleMessengerExport } from "../fixtures/exports.ts";
import { writeMadeUpChats } from "../fixtures/madeUpChats.ts";
import { PROJECT as LLM_PROJECT, TEXTS as LLM_TEXTS, writeLlmSessionsFixture } from "../../../sdk/testing.ts";
import { writeBridgeLidMap, writeWhatsAppFixture } from "../fixtures/whatsapp.ts";
import { openArchive, SCHEMA_VERSION } from "./db.ts";
import { openTestArchive } from "../testing/archive.ts";
import { ManualCalls } from "./manualCalls.ts";
import { People } from "./people.ts";
import { ImportSession } from "./write.ts";

const SCRIPT = fileURLToPath(new URL("../../../server/archive/cli.ts", import.meta.url));

let dataDir: string;

/** friend map's archive in the test's folder, where the module keeps it. */
const archiveFile = () => join(dataDir, "modules", "friend-map", "archive.sqlite");

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-cli-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** The line a command that changed people ends with. */
const CHANGESET = /^Changeset #\d+, after the backup \S+\.sqlite; undo it with: npm run archive -- changes undo \d+$/m;

/** What a command that changed people printed, without that line (checked to be there). */
function changed(output: { stdout: string }): string {
  expect(output.stdout).toMatch(CHANGESET);
  return output.stdout.replace(new RegExp(`${CHANGESET.source}\n`, "m"), "");
}

async function archive(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--no-warnings", SCRIPT, ...args, "--data", dataDir]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr };
  }
}

it("finds the archive LIFE_ARCHIVE_DATA names, without --data", async () => {
  openArchive(archiveFile()).close();
  const env = { ...process.env, FRIEND_MAP_DATA: "", LIFE_ARCHIVE_DATA: dataDir };
  const { stdout } = await promisify(execFile)(process.execPath, ["--no-warnings", SCRIPT, "tag", "list"], { env });
  expect(stdout).toMatch(/^1  archive \(0\) built in\n/);
});

it("pushes the calendar after the rules, which a change made beside them reaches then", async () => {
  const opened = await openTestArchive(dataDir);
  const ada = opened.people.create("Ada Sample");
  opened.changes.record({ surface: "cli", action: "log a call" }, () =>
    new ManualCalls(opened.db).insert({ people: [{ personId: ada, accountId: null, app: "discord" }], day: "2026-04-05", time: "20:00", minutes: 30, note: "" }));
  // A number for a name makes the call an unknown caller's, which no changeset has pushed.
  opened.people.setName(ada, "+61 491 570 006");
  opened.close();
  expect((await archive("calendar", "check")).code).toBe(1);
  expect((await archive("rules")).code).toBe(0);
  expect((await archive("calendar", "check")).code).toBe(0);
});

it("lists, adds, renames, merges, moves and deletes tags", async () => {
  const db = openArchive(archiveFile());
  const people = new People(db);
  people.setTags(people.create("Ada"), ["uni", "family"]);
  people.setTags(people.create("Bea"), ["family"]);
  db.close();

  expect((await archive("tag", "list")).stdout).toBe("1  archive (0) built in\n2  keep (0) built in\n3  live-together (0) built in\n4  show-name (0) built in\n5  uni (1)\n6  family (2)\n");
  expect(changed(await archive("tag", "add", "Night Owls"))).toMatch(/^Added the tag night-owls\.\n(.*\n){6}7  night-owls \(0\)\n$/);
  expect(changed(await archive("tag", "move", "night-owls", "1"))).toMatch(/^1  night-owls \(0\)\n2  archive/);
  expect(changed(await archive("tag", "rename", "uni", "uni-friends"))).toMatch(/^Renamed uni to uni-friends for everyone\.\n/);
  expect(changed(await archive("tag", "rename", "uni-friends", "family")))
    .toBe("Merged uni-friends into family: everyone who had uni-friends has family.\n1  night-owls (0)\n2  archive (0) built in\n3  keep (0) built in\n4  live-together (0) built in\n5  show-name (0) built in\n6  family (2)\n");
  expect(changed(await archive("tag", "delete", "family"))).toMatch(/^Deleted the tag family, taken from 2 people\.\n/);

  const refused = await archive("tag", "delete", "archive");
  expect(refused.code).toBe(1);
  expect(refused.stderr).toMatch(/"archive" is built in/);
  expect((await archive("tag", "move", "keep", "0")).stderr).toMatch(/position, 1 first/);
  expect((await archive("tag", "frobnicate")).stderr).toMatch(/tag list \| add/);
}, 60_000); // Each command is a fresh node process.

it("adds someone by hand with a location, tags and note, refusing a name someone already has unless --anyway", async () => {
  const db = openArchive(archiveFile());
  const ada = new People(db).create("Ada Example");
  db.close();

  const added = changed(await archive("person", "new", "Walt", "Example", "--location", "Hobart", "--tag", "offline, Uni friends", "--note", "a neighbour"));
  expect(added).toMatch(/^\d+ {2}Walt Example \[offline, uni-friends\]: 0 direct, 0 in groups\n {2}location: Hobart\n {2}note:\n {4}a neighbour\n$/);
  const refused = await archive("person", "new", "ada", "example");
  expect(refused.code).toBe(1);
  expect(refused.stderr).toMatch(new RegExp(`already here with that name or alias:\n {2}${ada} {2}Ada Example.*\nadd them anyway with --anyway`));
  expect(changed(await archive("person", "new", "ada", "example", "--anyway"))).toMatch(/^\d+ {2}ada example: /);
}, 60_000); // Each command is a fresh node process.

it("flags people to reach out to, with their drafts, and lists them; a draft is no changeset", async () => {
  const db = openArchive(archiveFile());
  const people = new People(db);
  const ada = people.create("Ada");
  people.create("Bea");
  db.close();

  expect((await archive("person", "reach-out", String(ada))).stdout).toMatch(/you should reach out to them/);
  const drafted = (await archive("person", "draft", String(ada), "Coffee", "soon?")).stdout;
  expect(drafted).toMatch(/draft:\n {4}Coffee soon\?\n/);
  expect(drafted).not.toMatch(/Changeset/);
  expect((await archive("person", "draft", String(ada), "Coffee", "on", "Friday?")).stdout).toMatch(/draft:\n {4}Coffee on Friday\?\n/);
  expect((await archive("people", "--reach-out")).stdout).toMatch(new RegExp(`^${ada}  Ada.*\n {4}Coffee on Friday\\?\n1 to reach out to\.\n$`));
  expect((await archive("person", "clear-draft", String(ada))).stdout).not.toMatch(/draft/);
  expect((await archive("person", "no-reach-out", String(ada))).stdout).not.toMatch(/reach out/);
  expect((await archive("people", "--reach-out")).stdout).toBe("0 to reach out to.\n");
  expect((await archive("person", "draft", String(ada))).stderr).toMatch(/give the draft/);
  expect((await archive("person", "opener", String(ada), "Hi")).stderr).toMatch(/a draft opener is a draft now \(person draft\)/);
}, 60_000); // Each command is a fresh node process.

it("logs, changes and deletes a call, each a changeset, and lists it among the person's calls", async () => {
  const db = openArchive(archiveFile());
  const ada = new People(db).create("Ada");
  db.close();

  const added = (await archive("call", "add", String(ada), "--day", "2026-09-27", "--time", "19:30", "--minutes", "1:30", "--app", "facetime")).stdout;
  expect(added).toMatch(/^Logged #1  2026-09-27 19:30  Call · 1 h 30 min: Ada on FaceTime\nChangeset #1, after the backup/);
  expect((await archive("calls", String(ada))).stdout).toContain("2026-09-27 19:30  logged     Call · 1 h 30 min on FaceTime (#1)\n");
  expect((await archive("call", "change", "1", "--minutes", "25", "--app", "phone")).stdout).toMatch(/^Changed to #1  2026-09-27 19:30  Call · 25 min: Ada on Phone\n/);
  expect((await archive("changes", "show", "2")).stdout).toContain(`  ${ada}  Ada\n    logged call: 1 h 30 min on FaceTime, 27 Sept 2026, 7:30 pm -> 25 min on Phone, 27 Sept 2026, 7:30 pm\n`);
  expect((await archive("call", "delete", "1")).stdout).toMatch(/^Deleted #1  2026-09-27 19:30  Call · 25 min: Ada on Phone\n/);
  expect((await archive("call", "add", String(ada), "--time", "19:30", "--minutes", "1.5")).stderr).toMatch(/--minutes is how long it lasted/);
  expect((await archive("call", "add", String(ada))).stderr).toMatch(/call add <person> \[person \.\.\.\] --time <HH:MM> --minutes <length>/);
}, 60_000); // Each command is a fresh node process.

it("logs a call on someone's account: the one they are called on unless said, another with --account, and refuses --app for them", async () => {
  const db = openArchive(archiveFile());
  const bea = new People(db).create("Bea");
  const account = (platform: string, key: string) => Number(db
    .prepare("INSERT INTO import_person (platform, key, key_kind, display_name, person_id, link_source) VALUES (?, ?, 'id', ?, ?, 'captain')")
    .run(platform, key, key, bea).lastInsertRowid);
  const messenger = account("messenger", "bea.sample");
  account("x", "beasample");
  const phone = account("phone", "+61491570110");
  db.close();

  // Their phone one, with no call yet.
  expect((await archive("call", "add", String(bea), "--day", "2026-09-27", "--time", "19:30", "--minutes", "25")).stdout).toMatch(/^Logged #1  2026-09-27 19:30  Call · 25 min: Bea on Phone\n/);
  expect((await archive("call", "change", "1", "--account", String(messenger))).stdout).toMatch(/^Changed to #1  2026-09-27 19:30  Call · 25 min: Bea on Messenger\n/);
  expect((await archive("changes", "show", "2")).stdout).toContain(`  ${bea}  Bea\n    logged call: 25 min on Phone, 27 Sept 2026, 7:30 pm -> 25 min on Messenger, 27 Sept 2026, 7:30 pm\n`);
  // Now the one their latest call was on.
  expect((await archive("call", "add", String(bea), "--day", "2026-09-28", "--time", "19:30", "--minutes", "5")).stdout).toMatch(/: Bea on Messenger\n/);
  expect((await archive("call", "add", String(bea), "--time", "19:30", "--minutes", "5", "--app", "facetime")).stderr).toMatch(/--app is for someone with no account that carries calls/);
  expect((await archive("call", "add", String(bea), "--time", "19:30", "--minutes", "5", "--account", String(phone + 99))).stderr).toMatch(/--account \d+ is not one of theirs that carries calls/);
}, 60_000); // Each command is a fresh node process.

it("logs a call with several people, each on their account, and changes and deletes it for everyone on it", async () => {
  const db = openArchive(archiveFile());
  const people = new People(db);
  const ada = people.create("Ada");
  const bea = people.create("Bea");
  const cy = people.create("Cy");
  const discord = Number(db
    .prepare("INSERT INTO import_person (platform, key, key_kind, display_name, person_id, link_source) VALUES ('discord', 'bea.sample', 'id', 'Bea', ?, 'captain')")
    .run(bea).lastInsertRowid);
  db.close();

  expect((await archive("call", "add", String(ada), String(bea), "--day", "2026-09-27", "--time", "19:30", "--minutes", "45", "--account", String(discord))).stdout)
    .toMatch(/^Logged #1  2026-09-27 19:30  Call · 45 min: Ada on Phone, Bea on Discord\n/);
  expect((await archive("call", "change", "2", "--people", `${bea},${cy}`, "--minutes", "30")).stdout)
    .toMatch(/^Changed to #1  2026-09-27 19:30  Call · 30 min: Cy on Phone, Bea on Discord\n/);
  // More on it unnamed, kept through a change that does not say them.
  expect((await archive("call", "change", "1", "--others", "2")).stdout).toMatch(/^Changed to #1  2026-09-27 19:30  Call · 30 min: Cy on Phone, Bea on Discord \+2 others\n/);
  expect((await archive("call", "change", "1", "--minutes", "35")).stdout).toMatch(/^Changed to #1  2026-09-27 19:30  Call · 35 min: Cy on Phone, Bea on Discord \+2 others\n/);
  expect((await archive("call", "delete", "1")).stdout).toMatch(/^Deleted #1  2026-09-27 19:30  Call · 35 min: Cy on Phone, Bea on Discord \+2 others\n/);
  const after = openArchive(archiveFile());
  expect(after.prepare("SELECT count(*) AS n FROM manual_call").get()).toEqual({ n: 0 });
  after.close();
  expect((await archive("call", "add", String(ada), "--time", "19:30", "--minutes", "5", "--account", String(discord))).stderr).toMatch(/--account \d+ is not one of theirs/);
}, 60_000); // Each command is a fresh node process.

it("sets a location, lists people by it, and renames and merges locations", async () => {
  const db = openArchive(archiveFile());
  const people = new People(db);
  const ada = people.create("Ada");
  const bea = people.create("Bea");
  db.close();

  expect((await archive("person", "location", String(ada), "New", "York")).stdout).toMatch(/\n {2}location: New York\n/);
  await archive("person", "location", String(bea), "NYC");
  expect((await archive("people", "--location", "new york")).stdout).toMatch(new RegExp(`^${ada}  Ada`, "m"));
  expect((await archive("people", "--location", "new york")).stdout).not.toMatch(/Bea/);
  expect((await archive("locations")).stdout).toBe("New York (1), NYC (1)\n");
  expect(changed(await archive("location", "rename", "NYC", "new york"))).toBe("Merged NYC into New York: 1 person moved there.\nNew York (2)\n");
  expect(changed(await archive("location", "rename", "new york", "New York City"))).toBe("Renamed new york to New York City for 2 people.\nNew York City (2)\n");
  expect((await archive("person", "clear-location", String(ada))).stdout).not.toMatch(/location:/);
  expect((await archive("location", "rename", "Nowhere", "Somewhere")).stderr).toMatch(/nobody is at "Nowhere"/);
  expect((await archive("location", "rename", "New", "York", "City")).stderr).toMatch(/quote one of several words/);
  expect((await archive("location", "list")).stderr).toMatch(/location rename <location> <new name>/);
  // The field commands, Met and Lives say what they became.
  expect((await archive("field", "list")).stderr).toMatch(/field is gone: location is a column of person now \(locations\)/);
  expect((await archive("field", "rename", "location", "a", "b")).stderr).toMatch(/\(location rename <location> <new name>\)/);
  expect((await archive("person", "met", String(ada), "Tokyo")).stderr).toMatch(/person met is gone: Met and Lives became one Location \(person location\)/);
  expect((await archive("people", "--met", "tokyo")).stderr).toMatch(/--met and --lives are gone/);
}, 60_000); // Each command is a fresh node process.

it("migrates after a backup, says what became of Met and Lives and of Location, and the second time does nothing", async () => {
  const file = archiveFile();
  const db = openArchive(file, { version: 26 });
  const now = Date.now();
  // Edited, so the rules keep them though they have no accounts.
  const person = db.prepare("INSERT INTO person (name, name_source, edited_at, created_at) VALUES (?, 'captain', ?, ?)");
  const [ada, bea] = ["Ada", "Bea"].map((name) => Number(person.run(name, now, now).lastInsertRowid));
  const value = db.prepare("INSERT INTO field_value (field, name, created_at) VALUES (?, ?, ?)");
  const give = db.prepare("INSERT INTO person_field_value (person_id, value_id, field, added_at) VALUES (?, ?, ?, ?)");
  give.run(ada, Number(value.run("met", "Tokyo", now).lastInsertRowid), "met", now);
  give.run(bea, Number(value.run("met", "Uni", now).lastInsertRowid), "met", now);
  give.run(bea, Number(value.run("lives", "Hobart", now).lastInsertRowid), "lives", now);
  db.close();

  const first = (await archive("migrate")).stdout;
  expect(first).toMatch(/^Backed up to .*before-migrate\.sqlite, integrity ok\.\n/);
  expect(first).toMatch(new RegExp(`^friend-map: schema 26 -> ${SCHEMA_VERSION}\\.$`, "m"));
  expect(first).toContain(
    "Met and Lives became Location: 1 took their Met place, 1 kept their Lives place (1 had both: 0 the same place, 1 different, " +
      "where Lives was kept and Met went); 2 had a Location after.\n" +
      `  person ${bea} Bea: Location Hobart (Met Uni went)\n` +
      "Location became a column of person: before, 2 people had a location, 2 different (and 0 nobody had, which went); " +
      "after, 2 people have one, 2 different.\n",
  );
  // One backup: the core's file, and friend map's beside it.
  expect((await readdir(join(dataDir, "backups"))).filter((name) => name.endsWith("before-migrate.sqlite"))).toHaveLength(1);

  const second = (await archive("migrate")).stdout;
  expect(second).toMatch(/^Every database was at its code's schema already: nothing to do, so no backup\.\nMet and Lives became Location: 1 took/m);
  expect(second).toContain("Location became a column of person: before, 2 people had");
  expect((await archive("locations")).stdout).toBe("Hobart (1), Tokyo (1)\n");
}, 60_000);

it("edits the people a query chooses, a dry run first, as one changeset that can be shown and undone", async () => {
  const opened = await openTestArchive(dataDir);
  await opened.host.setEnabled("messenger-export", true);
  await opened.importHistory("messenger-export", await sampleMessengerExport(dataDir));
  const ids = new Map(opened.structure.listPeople().people.map((p) => [p.name, p.id]));
  opened.close();
  const [ada, cleo] = [ids.get("Ada Sample")!, ids.get("Cleo Example")!];
  const backups = async () => (await readdir(join(dataDir, "backups")).catch(() => [])).sort();

  const groups = (await archive("groups", "climbing")).stdout;
  const group = /^#(\d+) {2}Climbing crew \(messenger, 5 people, last 2026-08-01\)$/m.exec(groups)?.[1];
  expect(group).toBeDefined();
  expect((await archive("groups", "--person", String(ada))).stdout).toMatch(new RegExp(`^#${group} {2}Climbing crew`, "m"));
  changed(await archive("person", "tag", String(cleo), "commercial"));

  // The dry run writes nothing, and takes no backup.
  const before = await backups();
  const dry = await archive("edit", "tag", "commercial", "--query", `group:#${group} AND NOT keep`);
  expect(dry.stdout).toMatch(new RegExp(`^edit tag commercial, for the query group:#${group} AND NOT keep: 4 chosen\\.\\nWould change 3:\\n`));
  expect(dry.stdout).toMatch(new RegExp(`^ {2}${ada} {2}Ada Sample: \\(none\\) -> commercial$`, "m"));
  expect(dry.stdout).toMatch(new RegExp(`Already so 1:\\n {2}${cleo} {2}Cleo Example: commercial\\n`));
  expect(dry.stdout).toMatch(/run the same with --apply --expect 3 --why/);
  expect(await backups()).toEqual(before);

  const query = ["--query", 'group:"Climbing crew" AND NOT keep'];
  expect((await archive("edit", "tag", "commercial", ...query, "--apply")).stderr).toMatch(/--apply needs --expect/);
  expect((await archive("edit", "tag", "commercial", ...query, "--apply", "--expect", "2")).stderr).toMatch(/this would change 3 people, not 2/);
  expect((await archive("edit", "name", "Someone", ...query)).stderr).toMatch(/a name is for one person at a time; this chooses 4/);
  const applied = await archive("edit", "tag", "commercial", ...query, "--apply", "--expect", "3", "--why", "tag the climbing crew commercial");
  expect(changed(applied)).toMatch(/^Changed 3 \(1 already so\):\n/);
  const changeset = /^Changeset #(\d+), after the backup (\S+);/m.exec(applied.stdout)!;
  expect(await backups()).toContain(changeset[2]);
  expect(changeset[2]).toMatch(/-before-edit-tag-commercial\.sqlite$/);

  const log = (await archive("changes")).stdout;
  expect(log).toMatch(new RegExp(`^#${changeset[1]} {2}\\S+ \\S+ {2}cli {2}edit tag commercial {2}"tag the climbing crew commercial"\\n {4}3 people: `, "m"));
  const shown = (await archive("changes", "show", changeset[1])).stdout;
  expect(shown).toMatch(new RegExp(`^ {2}${ada} {2}Ada Sample\\n {4}tags: \\(none\\) -> commercial$`, "m"));
  expect(shown).toMatch(new RegExp(`^ {2}backup: ${changeset[2]}$`, "m"));

  // Taken off Ada since, so the undo is refused, naming her; given back, it goes through.
  changed(await archive("person", "untag", String(ada), "commercial"));
  const refused = await archive("changes", "undo", changeset[1]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(`can't undo #${changeset[1]}: changed again since: Ada Sample [person ${ada}] (tags)\n`);
  changed(await archive("person", "tag", String(ada), "commercial"));
  const undone = await archive("changes", "undo", `#${changeset[1]}`, "--why", "not them after all");
  expect(changed(undone)).toMatch(new RegExp(`^Undid #${changeset[1]}:\\n#\\d+ .* {2}cli {2}undo #${changeset[1]} {2}"not them after all"\\n`));
  const tagged = (await archive("people", "--tag", "commercial")).stdout;
  expect(tagged).toMatch(/Cleo Example/);
  expect(tagged).not.toMatch(/Ada Sample/);
  expect((await archive("changes")).stdout).toMatch(new RegExp(`^#${changeset[1]} .*undone by #`, "m"));
}, 120_000); // Each command is a fresh node process.

it("takes SQL where it takes --query: people lists whom it returns, and edit chooses them", async () => {
  const db = openArchive(archiveFile());
  const people = new People(db);
  const ada = people.create("Ada");
  const bea = people.create("Bea");
  people.create("Cy");
  people.setTags(bea, ["archive"]);
  people.setLocation(ada, "Tokyo");
  people.setLocation(bea, "Tokyo");
  db.close();

  // SQL lists everyone it returns, archived people too.
  const sql = "SELECT person_id FROM people WHERE location = 'Tokyo'";
  const listed = (await archive("people", "--query", sql)).stdout;
  expect(listed).toMatch(new RegExp(`^${ada}  Ada`, "m"));
  expect(listed).toMatch(new RegExp(`^${bea}  Bea`, "m"));
  expect(listed).not.toMatch(/Cy/);
  // Other words still search names.
  expect((await archive("people", "--query", "cy")).stdout).toMatch(/^\d+ {2}Cy/m);
  expect((await archive("people", "--query", "SELECT name FROM people")).stderr).toMatch(/SQL: return the people as a column named person_id/);

  const dry = await archive("edit", "tag", "friend", "--query", sql);
  expect(dry.stdout).toMatch(new RegExp(`^edit tag friend, for the query ${sql}: 2 chosen\\.\\nWould change 2:\\n`));
  const applied = await archive("edit", "tag", "friend", "--query", sql, "--apply", "--expect", "2", "--why", "tag who I met in Tokyo");
  expect(changed(applied)).toMatch(/^Changed 2:\n/);
  expect((await archive("people", "--tag", "friend")).stdout).toMatch(/Ada/);
  expect((await archive("edit", "untag", "friend", "--query", "WITH x AS (SELECT 1) DELETE FROM person")).stderr)
    .toMatch(/SQL: a query only reads: DELETE is not allowed/);
}, 60_000); // Each command is a fresh node process.

it("drops a group chat and brings it back, each a changeset, and lists the dropped", async () => {
  const opened = await openTestArchive(dataDir);
  await opened.host.setEnabled("messenger-export", true);
  await opened.importHistory("messenger-export", await sampleMessengerExport(dataDir));
  opened.close();
  const group = /^#(\d+) {2}Climbing crew/m.exec((await archive("groups", "climbing")).stdout)![1];

  const dropped = await archive("group", "drop", `#${group}`, "--why", "a bulk message, not a group");
  expect(changed(dropped)).toBe(`Dropped #${group}  Climbing crew (messenger, 5 people, last 2026-08-01): it links nobody now.\n`);
  expect((await archive("groups", "climbing")).stdout).toBe(`0 group chats. Ask for their people with group:#<number>, or group:"<title>" for every chat of that title.\n`);
  expect((await archive("groups", "--dropped")).stdout).toMatch(new RegExp(`^#${group} {2}Climbing crew .*\\n1 dropped group chat\\. Bring one back with: npm run archive -- group restore <number>\\n$`));
  expect((await archive("group", "drop", group)).stdout).toMatch(new RegExp(`^#${group} {2}Climbing crew .* was dropped already\\.\\nNothing changed, so no changeset\\.\\n$`));
  const changeset = /^Changeset #(\d+)/m.exec(dropped.stdout)![1];
  expect((await archive("changes", "show", changeset)).stdout).toMatch(new RegExp(`^ {2}dropped the group chat #${group} "Climbing crew"$`, "m"));

  expect(changed(await archive("group", "restore", group))).toBe(`Brought back #${group}  Climbing crew (messenger, 5 people, last 2026-08-01).\n`);
  expect((await archive("groups", "--dropped")).stdout).toMatch(/^0 dropped group chats\./);
  expect((await archive("group", "leave", group)).stderr).toMatch(/group drop <number> \| group restore <number>/);
}, 60_000); // Each command is a fresh node process.

it("takes someone who never wrote out of a group chat and puts them back, each a changeset, and lists them", async () => {
  const db = openArchive(archiveFile());
  const account = (name: string, isSelf = false): ArchiveEvent => ({ kind: "account", key: name, keyKind: "name", displayName: name, isSelf });
  const message = (id: string, sender: string): ArchiveEvent => ({
    kind: "message", id, idKind: "platform", conversation: "crew", sender, isFromSelf: sender === "Me", sentAt: Date.parse("2026-08-01T12:00:00Z"), type: "text", text: "hi", raw: {},
  });
  transaction(db, () => {
    const source = Number(db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 'test', 'export', 'test', 0, 'ok')")
      .run().lastInsertRowid);
    const session = new ImportSession(db, "messenger", source, "export");
    for (const event of [
      account("Me", true), account("Ada"), account("Dot"),
      { kind: "conversation", id: "crew", type: "group", title: "Crew", members: ["Me", "Ada", "Dot"] },
      message("m1", "Ada"), message("m2", "Me"),
    ] satisfies ArchiveEvent[]) session.apply(event);
  });
  const people = new People(db);
  people.runRules();
  const person = (name: string) => (db.prepare("SELECT id FROM person WHERE name = ?").get(name) as { id: number }).id;
  const [ada, dot] = [person("Ada"), person("Dot")];
  const group = (db.prepare("SELECT id FROM conversation WHERE title = 'Crew'").get() as { id: number }).id;
  db.close();

  const removed = await archive("group", "remove-member", `#${group}`, String(dot), "--why", "added Dot by mistake");
  expect(changed(removed)).toBe(`Took Dot out of the group chat #${group}.\n`);
  expect((await archive("groups", "--removed")).stdout)
    .toMatch(new RegExp(`^#${group} {2}Crew: Dot \\(#${dot}\\), taken out \\d{4}-\\d\\d-\\d\\d\\n1 taken out of group chats\\. `));
  expect((await archive("groups", "--person", String(dot))).stdout).toMatch(/^0 group chats\./);
  const changeset = /^Changeset #(\d+)/m.exec(removed.stdout)![1];
  expect((await archive("changes", "show", changeset)).stdout).toMatch(new RegExp(`^ {2}took Dot out of the group chat #${group} "Crew"$`, "m"));
  expect((await archive("group", "remove-member", String(group), String(ada))).stderr).toMatch(/Ada wrote in the group chat/);

  expect(changed(await archive("group", "put-back", String(group), String(dot)))).toBe(`Put Dot back in the group chat #${group}.\n`);
  expect((await archive("groups", "--removed")).stdout).toMatch(/^0 taken out of group chats\./);
}, 60_000); // Each command is a fresh node process.

it("lists, adds, changes and deletes catch-ups, each a changeset", async () => {
  const db = openArchive(archiveFile());
  const people = new People(db);
  const ada = people.create("Ada");
  const bea = people.create("Bea");
  db.close();

  const added = await archive("catch-up", "add", String(ada), String(bea), "--day", "2026-09-27", "--hours", "2.5", "--note", "a long lunch", "--why", "had lunch with Ada and Bea");
  expect(changed(added)).toBe(`Added #1  2026-09-27  2.5 hours: Ada (#${ada}), Bea (#${bea}); a long lunch\n`);
  const changeset = /^Changeset #(\d+)/m.exec(added.stdout)![1];
  expect((await archive("changes", "show", changeset)).stdout).toContain(`  ${bea}  Bea\n    hangout: (none) -> 2.5 hours, 27 Sept 2026: a long lunch\n`);
  // A catch-up is in person, with no flag to say otherwise: a call is logged as a call.
  for (const flag of ["--call", "--in-person"]) expect((await archive("catch-up", "add", String(ada), flag)).stderr).toMatch(new RegExp(`Unknown option '${flag}'`));
  // Today, an hour, in person, unless said.
  expect(changed(await archive("catch-up", "add", String(bea)))).toMatch(new RegExp(`^Added #2  \\d{4}-\\d\\d-\\d\\d  1 hour: Bea \\(#${bea}\\)\n$`));
  expect((await archive("catch-ups", "--person", String(ada))).stdout)
    .toBe(`#1  2026-09-27  2.5 hours: Ada (#${ada}), Bea (#${bea}); a long lunch\n1 catch-up. Add one with: npm run archive -- catch-up add <person> [person ...]\n`);
  expect((await archive("catch-ups")).stdout).toMatch(/^#2 .*\n#1 .*\n2 catch-ups\./);

  expect(changed(await archive("catch-up", "change", "1", "--people", String(ada), "--hours", "0.75")))
    .toBe(`Changed to #1  2026-09-27  0.75 hours: Ada (#${ada}); a long lunch\n`);
  // Others there unnamed, after everyone named; kept through a change that does not give them.
  expect(changed(await archive("catch-up", "change", "1", "--others", "20")))
    .toBe(`Changed to #1  2026-09-27  0.75 hours: Ada (#${ada}) +20 others; a long lunch\n`);
  expect(changed(await archive("catch-up", "change", "1", "--hours", "1")))
    .toBe(`Changed to #1  2026-09-27  1 hour: Ada (#${ada}) +20 others; a long lunch\n`);
  expect(changed(await archive("catch-up", "change", "1", "--hours", "0.75", "--others", "0")))
    .toBe(`Changed to #1  2026-09-27  0.75 hours: Ada (#${ada}); a long lunch\n`);
  expect(changed(await archive("catch-up", "add", String(bea), "--day", "2026-09-28", "--others", "1"))).toMatch(/^Added #3  2026-09-28  1 hour: Bea \(#\d+\) \+1 other\n$/);
  expect((await archive("catch-up", "add", String(ada), "--others", "1.5")).stderr).toMatch(/others are a whole number from 0 to 10,000/);
  expect((await archive("catch-up", "add", String(ada), "--hours", "0")).stderr).toMatch(/more than 0 hours and at most 24/);
  expect((await archive("person", "show", String(ada))).stdout).toContain(`  #1  2026-09-27  0.75 hours: Ada (#${ada}); a long lunch\n`);
  expect((await archive("catch-up", "add", String(ada), "--day", "2999-01-01")).stderr).toMatch(/a hangout is one that has happened/);
  expect(changed(await archive("catch-up", "delete", "1"))).toBe(`Deleted #1  2026-09-27  0.75 hours: Ada (#${ada}); a long lunch\n`);
  expect((await archive("catch-ups", "--person", String(ada))).stdout).toMatch(/^0 catch-ups\./);
}, 60_000); // Each command is a fresh node process.

it("adds and changes a trip over several days, and makes it one day again", async () => {
  const db = openArchive(archiveFile());
  const people = new People(db);
  const ada = people.create("Ada");
  db.close();

  // From 6 pm on 4 September to 4 pm on the 6th, private midnight to 10 am: 6 + 14 + 6 hours, worked out.
  const added = await archive("catch-up", "add", String(ada), "--day", "2026-09-04", "--time", "18:00", "--until", "2026-09-06", "--end", "16:00", "--note", "the coast");
  expect(changed(added)).toBe(`Added #1  2026-09-04 6:00 pm to 2026-09-06 4:00 pm (private 12:00 am–10:00 am)  26 hours over 3 days: Ada (#${ada}); the coast\n`);
  const changeset = /^Changeset #(\d+)/m.exec(added.stdout)![1];
  expect((await archive("changes", "show", changeset)).stdout)
    .toContain("hangout: (none) -> 26 hours over 3 days, 4–6 Sept 2026, 6:00 pm to 4:00 pm, private 12:00 am–10:00 am: the coast\n");
  // Private 11 pm to 7 am, across midnight, the rest kept.
  expect(changed(await archive("catch-up", "change", "1", "--private", "23:00-07:00")))
    .toBe(`Changed to #1  2026-09-04 6:00 pm to 2026-09-06 4:00 pm (private 11:00 pm–7:00 am)  30 hours over 3 days: Ada (#${ada}); the coast\n`);
  expect((await archive("catch-up", "change", "1", "--private", "night")).stderr).toMatch(/--private is a window of each day, such as 00:00-10:00/);
  expect((await archive("catch-up", "change", "1", "--one-day", "--until", "2026-09-07")).stderr).toMatch(/--one-day takes the trip away/);
  expect((await archive("catch-up", "change", "1", "--time", "")).stderr).toMatch(/needs the time it began/);
  expect((await archive("catch-up", "add", String(ada), "--day", "2026-09-04", "--until", "2026-09-06", "--end", "16:00")).stderr).toMatch(/needs the time it began/);
  expect((await archive("catch-up", "add", String(ada), "--private", "23:00-07:00")).stderr).toMatch(/--private is a trip's/);
  expect(changed(await archive("catch-up", "change", "1", "--one-day", "--hours", "3")))
    .toBe(`Changed to #1  2026-09-04 6:00 pm  3 hours: Ada (#${ada}); the coast\n`);
}, 60_000); // Each command is a fresh node process.

it("tells where each connector's imports stand and what to do next, those never imported apart", async () => {
  const db = openArchive(archiveFile());
  transaction(db, () => {
    const source = Number(db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, finished_at, status) VALUES ('messenger', 'facebook-dyi', 'export', 'sample', 0, ?, 'ok')")
      .run(Date.parse("2026-10-05T12:00:00+11:00")).lastInsertRowid);
    new ImportSession(db, "messenger", source, "export").apply({ kind: "coverage", from: Date.parse("2016-01-01T00:00:00Z"), to: Date.parse("2026-10-04T21:30:00+11:00") });
  });
  db.close();
  // The CLI asks the server at LIFE_ARCHIVE_URL for the live connectors' state: nothing answers there in a test (vitest.config.ts).
  const { stdout } = await promisify(execFile)(process.execPath, ["--no-warnings", SCRIPT, "import-status", "--data", dataDir]);

  expect(stdout).toMatch(new RegExp(
    "^Import status on \\d{4}-\\d\\d-\\d\\d \\(Melbourne\\)\\. Each connector's steps: docs/import-runbook\\.md, under its name\\.\n\n" +
      "Requested from the platform, which sends its export minutes to days later:\n" +
      "  messenger \\(facebook-dyi, switched off\\): covers to 2026-10-04 \\(.+\\); last imported 2026-10-05 \\(.+\\)\n" +
      "    next: request an export of your Facebook information in Accounts Center: Messages only, JSON, from 2026-10-04\n\n" +
      "Never imported \\(how to start\\):\n",
  ));
  expect(stdout).toMatch(/^ {2}phone \(call-history\): copy CallHistory\.storedata from ~\/Library\/Application Support\/CallHistoryDB\/$/m);
  expect(stdout).toMatch(/^ {2}instagram \(instagram-dyi\): request an export of your Instagram information in Accounts Center: Messages only, JSON, from the start$/m);
  expect(stdout).toMatch(/^ {2}telegram \(matrix-bridge\): switched off: npm run archive -- enable matrix-bridge, then restart the server$/m);
  expect(stdout).not.toMatch(/facebook-dyi\): request/);

  // The same report as JSON, for the Cua Space's export plan (server/cuaExports/).
  const json = JSON.parse((await promisify(execFile)(process.execPath, ["--no-warnings", SCRIPT, "import-status", "--json", "--data", dataDir])).stdout);
  expect(json.used).toEqual([expect.objectContaining({ connector: "facebook-dyi", way: "platform", coversTo: Date.parse("2026-10-04T21:30:00+11:00") })]);
  expect(json.unused).toContainEqual(expect.objectContaining({ connector: "instagram-dyi", coversTo: null }));
}, 60_000);

it("reads content only into the trail, as FRIEND_MAP_READER names the reader; and shows its shape with --redacted, --json and --testing", async () => {
  const made = await openTestArchive(dataDir);
  await writeMadeUpChats(dataDir, { db: made.db });
  const ada = String((made.db.prepare("SELECT id FROM person WHERE name = 'Ada Sample'").get() as { id: number }).id);
  made.close();
  const as = async (reader: string | undefined, ...args: string[]) => {
    const env = { ...process.env, FRIEND_MAP_READER: reader };
    if (reader === undefined) delete env.FRIEND_MAP_READER;
    return (await promisify(execFile)(process.execPath, ["--no-warnings", SCRIPT, ...args, "--data", dataDir], { env })).stdout;
  };

  expect(await as("codex", "timeline", ada, "--why", "what we planned for Sunday")).toContain("messenger Ada Sample: Sunday works. I'll bring the rope.");
  // Every text as its length, and every file as its type and size, in the shape the app's routes answer.
  const page = JSON.parse(await as(undefined, "timeline", ada, "--redacted", "--json")) as TimelinePage;
  expect(page.messages.length).toBeGreaterThan(5);
  for (const message of page.messages) expect(message.text ?? "[redacted: 0 characters]").toMatch(/^\[redacted: \d+ characters\]$/);
  expect(page.messages.flatMap((m) => m.attachments)).toContainEqual(expect.objectContaining({ type: "image", mime: "image/jpeg", size: expect.any(Number) }));
  expect(await as(undefined, "search", "rope", "--redacted")).toMatch(/ messenger Ada Sample: \[redacted: \d+ characters\]\n1 matches\.\n$/);

  const trail = (await as(undefined, "content-log")).replace(/\d{4}-\d\d-\d\d \d\d:\d\d/g, "<when>");
  expect(trail).toBe([
    `#3  <when>  cli (unnamed)  search "rope", redacted`,
    `#2  <when>  cli (unnamed)  timeline person ${ada} Ada Sample, redacted`,
    `#1  <when>  cli codex  timeline person ${ada} Ada Sample: what we planned for Sunday`,
    "3 shown, the latest first.",
    "",
  ].join("\n"));

  // --testing reads the testing data, never the archive: an empty data folder stays empty, and nothing is kept.
  const empty = await mkdtemp(join(tmpdir(), "friend-map-cli-testing-"));
  try {
    const testing = await promisify(execFile)(process.execPath, ["--no-warnings", SCRIPT, "search", "rope", "--testing", "--data", empty]);
    expect(testing.stdout).toMatch(/ messenger Ada Sample: Sunday works\. I'll bring the \[rope\]\.\n1 matches\.\n$/);
    expect(JSON.parse((await promisify(execFile)(process.execPath, ["--no-warnings", SCRIPT, "timeline", "2", "--testing", "--json", "--data", empty])).stdout))
      .toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ sender: "Ada Sample" })]) });
    expect(await readdir(empty)).toEqual([]);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
  expect((await archive("content-log")).stdout).toMatch(/^#3 /);
  expect(await archive("people", "--testing")).toMatchObject({ code: 1, stderr: "--testing is for timeline and search\n" });
}, 60_000);

it("says what an import would do in a dry run, with the calls it would add, and leaves the archive as it was", async () => {
  const exports = join(dataDir, "platform-exports", "whatsapp");
  await writeWhatsAppFixture(join(exports, "2026-09-28"), { calls: true });
  await writeWhatsAppFixture(join(exports, "mac"), { copy: "mac", calls: true, macApp: true });
  const bridgeDb = join(dataDir, "mautrix-whatsapp.db");
  writeBridgeLidMap(bridgeDb);
  expect((await archive("enable", "whatsapp-db")).code).toBe(0);
  expect((await archive("import", "whatsapp-db", join(exports, "2026-09-28"))).stdout).toMatch(/^Messages: 42 new/m);
  // A reader may leave an empty -wal beside the archive, as SQLite does for any reader.
  const archiveFiles = async () => Promise.all(["archive.sqlite", "archive.sqlite-wal"].map(async (name) => {
    const bytes = await readFile(join(dataDir, name)).catch(() => null);
    return bytes?.length ? bytes : null;
  }));
  const before = await archiveFiles();
  const settings = JSON.stringify({ only: "calls", callsFrom: "chats", bridgeDb });
  const dry = await archive("import", "whatsapp-db", join(exports, "mac"), "--settings", settings, "--dry-run");
  expect(dry.code).toBe(0);
  expect(dry.stdout).toMatch(/^A dry run of .*mac with whatsapp-db; the archive was only read\.$/m);
  expect(dry.stdout).toMatch(/^Messages: 1 new .*, 1 changed, 6 already had/m);
  expect(dry.stdout).toMatch(/^Calls: 0 new, 0 changed, 2 already had\.$/m);
  expect(dry.stdout).toMatch(/^It would add 1 call:\n  2026-09-22 20:45  outgoing, 5 min, with Ada Sample$/m);
  expect(await archiveFiles()).toEqual(before);
  expect((await readdir(join(dataDir, "archive"))).filter((name) => name.startsWith(".dry-run"))).toEqual([]);
  // The import itself adds what the dry run said.
  expect((await archive("import", "whatsapp-db", join(exports, "mac"), "--settings", settings)).stdout).toMatch(/^Messages: 1 new/m);
  expect((await archive("import", "whatsapp-db", join(exports, "mac"), "--settings", "[1]", "--dry-run")).stderr).toMatch(/--settings takes a JSON object/);
}, 60_000); // Each command is a fresh node process.

it("imports the captain's LLM sessions into the event index, lists a day's events, and reads their text only into the trail", async () => {
  const store = join(dataDir, "claude-projects");
  await writeLlmSessionsFixture(store);
  await mkdir(join(dataDir, "connectors"), { recursive: true });
  await writeFile(join(dataDir, "connectors", "llm-sessions.json"), JSON.stringify({ enabled: true, projects: [LLM_PROJECT] }));

  const imported = await archive("import", "llm-sessions", store);
  expect(imported.code).toBe(0);
  expect(imported.stdout).toMatch(/^Imported \S+ with llm-sessions\.\nEvents, llm_session: 2 new, 0 changed, 0 already had\.\nEvents, llm_prompt: 5 new/);
  expect(imported.stdout).toContain("  sessions run headless (sdk-cli), left out: 1\n");
  // An event source's import says nothing of people.
  expect(imported.stdout).not.toMatch(/^(People|Messages):/m);
  expect((await archive("events")).stdout).toBe([
    "claude-code llm_prompt: 5, 2026-03-01 to 2026-03-02",
    "claude-code llm_reply: 4, 2026-03-01 to 2026-03-02",
    "claude-code llm_session: 2, 2026-03-01 to 2026-03-01",
    "11 events.",
    "",
  ].join("\n"));
  const day = (await archive("events", "--day", "2026-03-01", "--kind", "llm_prompt")).stdout;
  expect(day).toMatch(/^#\d+ {2}23:50 {2}llm_prompt {2}claude-code {2}38 characters {2}in session #\d+, claude-opus-5-5\n#\d+ {2}23:55 {2}llm_prompt {2}claude-code {2}18 characters {2}in session #\d+, claude-sonnet-5-5, 1 picture\n2 events on 2026-03-01 \(Melbourne\)\.\n$/);
  for (const text of Object.values(LLM_TEXTS)) expect(day.includes(text)).toBe(false);
  const p2 = /^#\d+ .*\n#(\d+) /.exec(day)![1];
  expect(await archive("events", "--kind", "llm_prompt")).toMatchObject({ code: 1, stderr: "--kind goes with --day: events --day <YYYY-MM-DD> --kind <kind>\n" });

  const env = { ...process.env, FRIEND_MAP_READER: "claude-code" };
  const read = await promisify(execFile)(process.execPath, ["--no-warnings", SCRIPT, "event-content", p2, "--why", "what bird was that", "--data", dataDir], { env });
  expect(read.stdout).toMatch(new RegExp(`^Session #\\d+ in /home/sample/Projects/firstmate:\\n\\n#${p2} {2}2026-03-01 23:55 {2}me \\[1 picture\\]:\\n${LLM_TEXTS.p2.replace("?", "\\?")}\\n$`));
  const redacted = JSON.parse((await archive("event-content", p2, "--redacted", "--json")).stdout) as { turns: Array<{ text: string }> };
  expect(redacted.turns.map((t) => t.text)).toEqual([`[redacted: ${LLM_TEXTS.p2.length} characters]`]);
  // An agent's latest session, its last turns: what firstmate reads to pick up where it is.
  const latest = JSON.parse((await archive("event-content", "--latest", "claude-code", "--last", "1", "--redacted", "--json")).stdout) as { event: number; turns: Array<{ role: string; text: string }> };
  expect(latest.turns).toEqual([expect.objectContaining({ role: "reply", text: `[redacted: ${LLM_TEXTS.r5.length} characters]` })]);
  expect(await archive("event-content", "--latest", "grok-bot")).toMatchObject({ code: 1, stderr: "no session of grok-bot in the index (its origins: claude-code, grok-bot)\n" });
  expect((await archive("content-log")).stdout.replace(/\d{4}-\d\d-\d\d \d\d:\d\d/g, "<when>")).toBe([
    `#3  <when>  cli (unnamed)  event-content event ${latest.event}, kind llm_session, latest claude-code, last 1, redacted`,
    `#2  <when>  cli (unnamed)  event-content event ${p2}, kind llm_prompt, redacted`,
    `#1  <when>  cli claude-code  event-content event ${p2}, kind llm_prompt: what bird was that`,
    "3 shown, the latest first.",
    "",
  ].join("\n"));
}, 60_000);
