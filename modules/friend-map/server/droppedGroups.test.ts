import { mkdtemp, rm } from "node:fs/promises";
import { changeLog } from "./changeLog.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArchiveEvent, Changes, type Db, transaction, UndoConflictError } from "../../../sdk/server.ts";
import { openArchive } from "./db.ts";
import { People } from "./people.ts";
import { ArchiveStructure } from "./structure.ts";
import { ImportSession } from "./write.ts";

let dataDir: string;
let db: Db;
let people: People;
let changes: Changes;
let structure: ArchiveStructure;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-dropped-groups-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  people = new People(db);
  changes = changeLog(db, people);
  structure = new ArchiveStructure(db, people);
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const day = (date: string) => Date.parse(`${date}T12:00:00+10:00`);

function importEvents(events: ArchiveEvent[]): void {
  transaction(db, () => {
    const source = Number(db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('imessage', 'test', 'app-db', 'test', 0, 'ok')")
      .run().lastInsertRowid);
    const session = new ImportSession(db, "imessage", source, "app-db");
    for (const event of events) session.apply(event);
  });
  people.runRules();
}

const message = (id: string, conversation: string, sender: string, sentAt: number): ArchiveEvent => ({
  kind: "message", id, idKind: "platform", conversation, sender, isFromSelf: sender === "Me", sentAt, type: "text", text: "hi", raw: {},
});

/**
 * Me, Ada, Bea, Cy and Dot. Ada and Cy talk with me directly; Ada, Bea and I
 * share a group we all write in; and one Christmas I sent a bulk message to a
 * group of all four, the only message there. Dot is in nothing else.
 */
function sample(): ArchiveEvent[] {
  const account = (name: string, isSelf = false): ArchiveEvent => ({ kind: "account", key: name, keyKind: "name", displayName: name, isSelf });
  return [
    account("Me", true), account("Ada"), account("Bea"), account("Cy"), account("Dot"),
    { kind: "conversation", id: "ada", type: "direct", members: ["Me", "Ada"] },
    { kind: "conversation", id: "cy", type: "direct", members: ["Me", "Cy"] },
    { kind: "conversation", id: "climbers", type: "group", title: "Climbers", members: ["Me", "Ada", "Bea"] },
    { kind: "conversation", id: "xmas", type: "group", members: ["Me", "Ada", "Bea", "Cy", "Dot"] },
    message("m1", "ada", "Ada", day("2026-01-01")),
    message("m2", "ada", "Me", day("2026-01-02")),
    message("m3", "cy", "Cy", day("2026-01-03")),
    message("m4", "cy", "Me", day("2026-01-04")),
    message("m5", "climbers", "Ada", day("2026-02-01")),
    message("m6", "climbers", "Bea", day("2026-02-02")),
    message("m7", "climbers", "Me", day("2026-02-03")),
    message("x1", "xmas", "Me", day("2013-12-25")),
  ];
}

const xmas = () => (db.prepare("SELECT id FROM conversation WHERE platform_conversation_id = 'xmas'").get() as { id: number }).id;
const climbers = () => (db.prepare("SELECT id FROM conversation WHERE platform_conversation_id = 'climbers'").get() as { id: number }).id;

function id(name: string): number {
  const person = structure.tableRows().find((p) => p.name === name);
  if (!person) throw new Error(`nobody named ${name}`);
  return person.id;
}

/** Everything worked out from group chats that the drop should change, by name. */
function derived() {
  const names = new Map(structure.tableRows().map((p) => [p.id, p.name]));
  const report = structure.relationships(Date.now(), new Set(names.keys()));
  const person = (name: string) => report.people.find((p) => p.name === name)!;
  return {
    groups: report.groups.map((g) => ({ id: g.id, members: g.memberIds.map((m) => names.get(m)).sort() })),
    groupsOf: Object.fromEntries(["Ada", "Bea", "Cy", "Dot"].map((name) => [name, structure.groupsOf(id(name))!.map((g) => g.id)])),
    cyFromMeInGroups: person("Cy").totals.groupFromMe,
    dotArchived: structure.getPerson(id("Dot"))!.archived,
    found: structure.findGroups().map((g) => g.id),
    queryable: structure.queryable().vocabulary.groups!.list.map((g) => g.id),
  };
}

function drop(group: number) {
  return changes.record({ surface: "cli", action: "group drop", description: "drop the bulk Christmas group" }, () => people.dropGroup(group));
}

describe("dropping a group chat", () => {
  it("links nobody through it and counts it in nothing, keeping its message", () => {
    importEvents(sample());
    const before = derived();
    expect(before.groups).toContainEqual({ id: xmas(), members: ["Ada", "Bea", "Cy", "Dot"] });
    expect(before.groupsOf.Dot).toEqual([xmas()]);
    expect(before.cyFromMeInGroups).toBe(1);
    // A small group I wrote in keeps Dot on the map.
    expect(before.dotArchived).toBeNull();
    expect(before.found).toContain(xmas());
    expect(before.queryable).toContain(xmas());

    const done = drop(xmas());
    expect(done.value).toBe(true);
    expect(done.changeset).not.toBeNull();

    const after = derived();
    expect(after.groups).toEqual([{ id: climbers(), members: ["Ada", "Bea"] }]);
    expect(after.groupsOf).toEqual({ Ada: [climbers()], Bea: [climbers()], Cy: [], Dot: [] });
    expect(after.cyFromMeInGroups).toBe(0);
    expect(after.dotArchived).toBe("no-messages");
    expect(after.found).toEqual([climbers()]);
    expect(after.queryable).toEqual([climbers()]);
    expect(structure.findGroups("", { dropped: true }).map((g) => g.id)).toEqual([xmas()]);

    // The message stays, and the chat can still be opened to read.
    expect(db.prepare("SELECT count(*) AS n FROM message WHERE conversation_id = ?").get(xmas())).toEqual({ n: 1 });
    expect(structure.group(xmas())).toMatchObject({ id: xmas(), messageCount: 1, people: 5 });

    expect(changes.show(done.changeset!)).toMatchObject({ action: "group drop", other: [`dropped the group chat #${xmas()}`] });
  });

  it("is undone through the change log, and by bringing it back", () => {
    importEvents(sample());
    const before = derived();

    const done = drop(xmas());
    const undo = changes.undo(done.changeset!, { surface: "cli" });
    expect(undo.value.other).toEqual([`brought back the group chat #${xmas()}`]);
    expect(derived()).toEqual(before);

    drop(xmas());
    const restored = changes.record({ surface: "cli", action: "group restore" }, () => people.restoreGroup(xmas()));
    expect(restored.value).toBe(true);
    expect(derived()).toEqual(before);
  });

  it("refuses to undo a drop when the group has been brought back since", () => {
    importEvents(sample());
    const done = drop(xmas());
    changes.record({ surface: "cli", action: "group restore" }, () => people.restoreGroup(xmas()));
    expect(() => changes.undo(done.changeset!, { surface: "cli" })).toThrow(UndoConflictError);
    expect(() => changes.undo(done.changeset!, { surface: "cli" })).toThrow(`the group chat #${xmas()} (brought back)`);
  });

  it("stays dropped when the same or a newer export is imported again", () => {
    importEvents(sample());
    drop(xmas());
    const after = derived();

    importEvents(sample());
    expect(derived()).toEqual(after);

    // A newer export, with another message in the group and someone new in it.
    importEvents([
      ...sample(),
      { kind: "account", key: "Eve", keyKind: "name", displayName: "Eve" },
      { kind: "conversation", id: "xmas", type: "group", members: ["Me", "Ada", "Bea", "Cy", "Dot", "Eve"] },
      message("x2", "xmas", "Me", day("2014-12-25")),
    ]);
    const again = derived();
    expect(again.groups).toEqual(after.groups);
    expect(again.groupsOf).toEqual(after.groupsOf);
    expect(again.cyFromMeInGroups).toBe(0);
    expect(structure.getPerson(id("Eve"))!.archived).toBe("no-messages");
    expect(db.prepare("SELECT count(*) AS n FROM message WHERE conversation_id = ?").get(xmas())).toEqual({ n: 2 });
  });

  it("drops only group chats, once", () => {
    importEvents(sample());
    const direct = (db.prepare("SELECT id FROM conversation WHERE platform_conversation_id = 'ada'").get() as { id: number }).id;
    expect(() => people.dropGroup(direct)).toThrow("is not a group chat");
    expect(() => people.dropGroup(9999)).toThrow("no chat #9999");
    expect(drop(xmas()).changeset).not.toBeNull();
    expect(drop(xmas())).toEqual({ value: false, changeset: null });
    expect(people.restoreGroup(climbers())).toBe(false);
  });
});
