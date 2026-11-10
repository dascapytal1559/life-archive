// Unlinking someone from a group chat (People.unlinkFromGroup, the person
// panel's break-link button): they stay in it, and it connects them to nobody.

import { changeLog } from "./changeLog.ts";
import { mkdtemp, rm } from "node:fs/promises";
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
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-group-unlinks-"));
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
 * are Ada, Bea, Cy, Dot and me; Ada, Bea and I write there. Cy and I are in a
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

/** What unlinking should leave alone: membership, sizes, counts and what closeness is worked out from. */
function kept() {
  const table = structure.tableRows();
  const report = structure.relationships(Date.now(), new Set(table.map((p) => p.id)));
  return {
    groups: report.groups.map((g) => ({ id: g.id, memberIds: g.memberIds })),
    groupsOf: Object.fromEntries(["Ada", "Bea", "Cy", "Dot"].map((name) => [name, structure.groupsOf(id(name))!.map((g) => ({ id: g.id, people: g.people }))])),
    scoreReport: structure.scoreReport(0),
    totals: Object.fromEntries(report.people.map((p) => [p.name, p.totals])),
  };
}

const unlinks = () => structure.relationships().unlinks;
const unlinkedOf = (name: string) => structure.groupsOf(id(name))!.filter((g) => g.unlinked).map((g) => g.id);

function unlink(group: number, person: number) {
  return changes.record({ surface: "app", action: "group unlink" }, () => people.unlinkFromGroup(group, person));
}

describe("unlinking someone from a group chat", () => {
  it("lists them as unlinked from it, keeping them in it and every count and score as it was", () => {
    importEvents(sample());
    const before = kept();
    const versionBefore = people.version();
    expect(unlinks()).toEqual([]);
    expect(unlinkedOf("Cy")).toEqual([]);

    const done = unlink(climbers(), id("Cy"));
    expect(done.value).toBe(true);
    expect(done.changeset).not.toBeNull();
    expect(people.version()).not.toBe(versionBefore);

    expect(unlinks()).toEqual([{ personId: id("Cy"), groupId: climbers() }]);
    expect(unlinkedOf("Cy")).toEqual([climbers()]);
    expect(unlinkedOf("Ada")).toEqual([]);
    expect(kept()).toEqual(before);
    expect(changes.show(done.changeset!)).toMatchObject({
      action: "group unlink",
      people: [{ name: "Cy", changes: [{ what: "group chat", before: `linked through the group chat #${climbers()} "Climbers"`, after: `unlinked from the group chat #${climbers()} "Climbers"` }] }],
    });
  });

  it("is undone through the change log, and by linking them again", () => {
    importEvents(sample());
    const done = unlink(climbers(), id("Cy"));
    const undo = changes.undo(done.changeset!, { surface: "app" });
    expect(undo.value.people).toMatchObject([{ name: "Cy", changes: [{ what: "group chat", after: `linked through the group chat #${climbers()} "Climbers"` }] }]);
    expect(unlinks()).toEqual([]);
    expect(unlinkedOf("Cy")).toEqual([]);

    unlink(climbers(), id("Cy"));
    const back = changes.record({ surface: "app", action: "group link" }, () => people.linkToGroup(climbers(), id("Cy")));
    expect(back.value).toBe(true);
    expect(back.changeset).not.toBeNull();
    expect(unlinks()).toEqual([]);
    expect(people.linkToGroup(climbers(), id("Cy"))).toBe(false);
  });

  it("refuses to undo an unlink when they have been linked again since", () => {
    importEvents(sample());
    const done = unlink(climbers(), id("Cy"));
    changes.record({ surface: "app", action: "group link" }, () => people.linkToGroup(climbers(), id("Cy")));
    expect(() => changes.undo(done.changeset!, { surface: "app" })).toThrow(UndoConflictError);
  });

  it("keeps them unlinked when the same or a newer export is imported again", () => {
    importEvents(sample());
    unlink(climbers(), id("Cy"));
    importEvents(sample());
    importEvents([...sample(), message("m8", "climbers", "Cy", day("2026-04-01"))]);
    expect(unlinks()).toEqual([{ personId: id("Cy"), groupId: climbers() }]);
    expect(unlinkedOf("Cy")).toEqual([climbers()]);
  });

  it("goes with them when they are joined into someone else, and with the group chat dropped and brought back", () => {
    importEvents(sample());
    unlink(climbers(), id("Cy"));
    const cy = id("Cy");
    changes.record({ surface: "app", action: "merge" }, () => people.merge(id("Dot"), cy));
    expect(unlinks()).toEqual([{ personId: id("Dot"), groupId: climbers() }]);
    people.dropGroup(climbers());
    people.restoreGroup(climbers());
    expect(unlinkedOf("Dot")).toEqual([climbers()]);
  });

  it("is refused for a group chat they are not in, a direct chat, and the captain, and does nothing twice", () => {
    importEvents(sample());
    expect(() => people.unlinkFromGroup(trivia(), id("Bea"))).toThrow("Bea is not in the group chat");
    expect(() => people.unlinkFromGroup(chat("cy"), id("Cy"))).toThrow("is not a group chat");
    expect(() => people.unlinkFromGroup(climbers(), id("Me"))).toThrow("that is you");
    expect(() => people.unlinkFromGroup(9999, id("Cy"))).toThrow("no chat #9999");
    unlink(climbers(), id("Cy"));
    expect(unlink(climbers(), id("Cy"))).toEqual({ value: false, changeset: null });
  });
});
