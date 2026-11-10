import { mkdtemp, rm } from "node:fs/promises";
import { changeLog } from "./changeLog.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArchiveEvent, Changes, type Db, transaction, UndoConflictError } from "../../../sdk/server.ts";
import { openArchive } from "./db.ts";
import { People } from "./people.ts";
import { sqlQuerySync } from "./sqlQuery.ts";
import { ArchiveStructure } from "./structure.ts";
import { ImportSession } from "./write.ts";

let dataDir: string;
let db: Db;
let people: People;
let changes: Changes;
let structure: ArchiveStructure;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-removed-members-"));
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
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 'test', 'export', 'test', 0, 'ok')")
      .run().lastInsertRowid);
    const session = new ImportSession(db, "messenger", source, "export");
    for (const event of events) session.apply(event);
  });
  people.runRules();
}

const message = (id: string, conversation: string, sender: string, sentAt: number): ArchiveEvent => ({
  kind: "message", id, idKind: "platform", conversation, sender, isFromSelf: sender === "Me", sentAt, type: "text", text: "hi", raw: {},
});

/**
 * Me, Ada, Bea, Cy and Dot. Ada and Cy talk with me directly. The Climbers
 * are Ada, Bea, Cy, Dot and me; Ada, Bea and I write there, and I added Dot
 * by mistake, who is in nothing else and never wrote. Cy and I are in a
 * trivia group with Ada, where Cy writes.
 */
function sample(): ArchiveEvent[] {
  const account = (name: string, isSelf = false): ArchiveEvent => ({ kind: "account", key: name, keyKind: "name", displayName: name, isSelf });
  return [
    account("Me", true), account("Ada"), account("Bea"), account("Cy"), account("Dot"),
    { kind: "conversation", id: "ada", type: "direct", members: ["Me", "Ada"] },
    { kind: "conversation", id: "cy", type: "direct", members: ["Me", "Cy"] },
    { kind: "conversation", id: "climbers", type: "group", title: "Climbers", members: ["Me", "Ada", "Bea", "Cy", "Dot"] },
    { kind: "conversation", id: "trivia", type: "group", title: "Trivia", members: ["Me", "Ada", "Cy"] },
    message("m1", "ada", "Ada", day("2026-01-01")),
    message("m2", "ada", "Me", day("2026-01-02")),
    message("m3", "cy", "Cy", day("2026-01-03")),
    message("m4", "cy", "Me", day("2026-01-04")),
    message("m5", "climbers", "Ada", day("2026-02-01")),
    message("m6", "climbers", "Bea", day("2026-02-02")),
    message("m7", "climbers", "Me", day("2026-02-03")),
    message("t1", "trivia", "Cy", day("2026-03-01")),
    message("t2", "trivia", "Me", day("2026-03-02")),
  ];
}

const chat = (key: string) => (db.prepare("SELECT id FROM conversation WHERE platform_conversation_id = ?").get(key) as { id: number }).id;
const climbers = () => chat("climbers");
const trivia = () => chat("trivia");

function id(name: string): number {
  const person = [...structure.tableRows(), ...(structure.listPeople().me ? [structure.listPeople().me!] : [])].find((p) => p.name === name);
  if (!person) throw new Error(`nobody named ${name}`);
  return person.id;
}

/** Everything worked out from group chats that taking Dot out should change, by name. */
function derived() {
  const names = new Map(structure.tableRows().map((p) => [p.id, p.name]));
  const report = structure.relationships(Date.now(), new Set(names.keys()));
  const person = (name: string) => report.people.find((p) => p.name === name)!;
  const group = structure.group(climbers())!;
  return {
    groups: report.groups.map((g) => ({ id: g.id, members: g.memberIds.map((m) => names.get(m)).sort() })),
    groupsOf: Object.fromEntries(["Ada", "Bea", "Cy", "Dot"].map((name) => [name, structure.groupsOf(id(name))!.map((g) => g.id)])),
    climbers: { people: group.people, members: group.members.map((m) => m.name), messages: group.messageCount },
    dotFromMeInGroups: person("Dot").totals.groupFromMe,
    dotArchived: structure.getPerson(id("Dot"))!.archived,
    queryMembers: [...structure.queryable().vocabulary.groups!.members([climbers()])].map((m) => names.get(m)).sort(),
    sqlMembers: sqlQuerySync(db, `SELECT person_id FROM person_group WHERE conversation_id = ${climbers()}`).map((m) => names.get(m)).sort(),
  };
}

function remove(group: number, person: number) {
  return changes.record({ surface: "cli", action: "group remove-member", description: "I added Dot by mistake" }, () => people.removeFromGroup(group, person));
}

describe("taking someone out of a group chat", () => {
  it("leaves them out of everything worked out from it, keeping its messages", () => {
    importEvents(sample());
    const before = derived();
    expect(before.groups).toContainEqual({ id: climbers(), members: ["Ada", "Bea", "Cy", "Dot"] });
    expect(before.groupsOf.Dot).toEqual([climbers()]);
    expect(before.climbers).toEqual({ people: 5, members: ["Ada", "Bea", "Cy", "Dot"], messages: 3 });
    expect(before.dotFromMeInGroups).toBe(1);
    // A small group I wrote in keeps Dot on the map.
    expect(before.dotArchived).toBeNull();
    expect(before.queryMembers).toEqual(["Ada", "Bea", "Cy", "Dot"]);
    expect(before.sqlMembers).toEqual(["Ada", "Bea", "Cy", "Dot"]);

    const done = remove(climbers(), id("Dot"));
    expect(done.value).toBe(true);
    expect(done.changeset).not.toBeNull();

    expect(derived()).toEqual({
      groups: [{ id: climbers(), members: ["Ada", "Bea", "Cy"] }, { id: trivia(), members: ["Ada", "Cy"] }],
      groupsOf: { Ada: [trivia(), climbers()], Bea: [climbers()], Cy: [trivia(), climbers()], Dot: [] },
      climbers: { people: 4, members: ["Ada", "Bea", "Cy"], messages: 3 },
      dotFromMeInGroups: 0,
      dotArchived: "no-messages",
      queryMembers: ["Ada", "Bea", "Cy"],
      sqlMembers: ["Ada", "Bea", "Cy"],
    });
    expect(db.prepare("SELECT count(*) AS n FROM message WHERE conversation_id = ?").get(climbers())).toEqual({ n: 3 });
    expect(structure.removedMembers()).toMatchObject([{ groupId: climbers(), title: "Climbers", personId: id("Dot"), name: "Dot" }]);
    expect(changes.show(done.changeset!)).toMatchObject({
      action: "group remove-member",
      other: [`took Dot out of the group chat #${climbers()} "Climbers"`],
    });
  });

  it("is undone through the change log, and by putting them back", () => {
    importEvents(sample());
    const before = derived();

    const done = remove(climbers(), id("Dot"));
    const undo = changes.undo(done.changeset!, { surface: "cli" });
    expect(undo.value.other).toEqual([`put Dot back in the group chat #${climbers()} "Climbers"`]);
    expect(derived()).toEqual(before);
    expect(structure.removedMembers()).toEqual([]);

    remove(climbers(), id("Dot"));
    const back = changes.record({ surface: "cli", action: "group put-back" }, () => people.putBackInGroup(climbers(), id("Dot")));
    expect(back.value).toBe(true);
    expect(derived()).toEqual(before);
  });

  it("refuses to undo a removal when they have been put back since", () => {
    importEvents(sample());
    const done = remove(climbers(), id("Dot"));
    changes.record({ surface: "cli", action: "group put-back" }, () => people.putBackInGroup(climbers(), id("Dot")));
    expect(() => changes.undo(done.changeset!, { surface: "cli" })).toThrow(UndoConflictError);
  });

  it("keeps them out when the same or a newer export is imported again", () => {
    importEvents(sample());
    remove(climbers(), id("Dot"));
    const after = derived();

    importEvents(sample());
    expect(derived()).toEqual(after);

    // A newer export, with another message in the group.
    importEvents([...sample(), message("m8", "climbers", "Ada", day("2026-04-01"))]);
    const again = derived();
    expect(again.groups).toEqual(after.groups);
    expect(again.groupsOf.Dot).toEqual([]);
    expect(again.climbers).toEqual({ ...after.climbers, messages: 4 });
    expect(again.dotArchived).toBe("no-messages");

    // One where they write there after all: they count again, by what they wrote.
    importEvents([...sample(), message("m9", "climbers", "Dot", day("2026-05-01"))]);
    expect(derived().groupsOf.Dot).toEqual([climbers()]);
  });

  it("is refused for anyone who wrote there, the captain, and a direct chat", () => {
    importEvents(sample());
    expect(() => people.removeFromGroup(climbers(), id("Ada"))).toThrow("Ada wrote in the group chat");
    expect(() => people.removeFromGroup(trivia(), id("Cy"))).toThrow("Cy wrote in the group chat");
    expect(() => people.removeFromGroup(climbers(), id("Me"))).toThrow("that is you");
    expect(() => people.removeFromGroup(chat("cy"), id("Cy"))).toThrow("is not a group chat");
    expect(() => people.removeFromGroup(trivia(), id("Bea"))).toThrow("Bea is not listed in the group chat");
    expect(() => people.removeFromGroup(9999, id("Dot"))).toThrow("no chat #9999");

    // Cy wrote in Trivia, not in the Climbers, so can be taken out of the Climbers alone.
    expect(remove(climbers(), id("Cy")).changeset).not.toBeNull();
    expect(remove(climbers(), id("Cy"))).toEqual({ value: false, changeset: null });
    expect(structure.groupsOf(id("Cy"))!.map((g) => g.id)).toEqual([trivia()]);
    expect(people.putBackInGroup(climbers(), id("Dot"))).toBe(false);
  });
});
