import { mkdtemp, rm } from "node:fs/promises";
import { changeLog } from "./changeLog.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArchiveEvent, type CatchUpInput, Changes, dayKey, type Db, InvalidInputError, NotFoundError, transaction, UndoConflictError } from "../../../sdk/server.ts";
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
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-catch-ups-"));
  db = openArchive(join(dataDir, "modules", "friend-map", "archive.sqlite"));
  people = new People(db);
  changes = changeLog(db, people);
  structure = new ArchiveStructure(db, people);
  importEvents(sample());
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const at = (date: string) => Date.parse(`${date}T12:00:00+10:00`);
const today = () => dayKey(Date.now());

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
 * Me, Ada, Bea, Cy and Eve. Ada and Cy talk with me directly. Ada, Bea and Eve
 * are in a wedding group I never wrote in, where Bea writes: the rules archive
 * Bea and Eve.
 */
function sample(): ArchiveEvent[] {
  const account = (name: string, isSelf = false): ArchiveEvent => ({ kind: "account", key: name, keyKind: "name", displayName: name, isSelf });
  return [
    account("Me", true), account("Ada Example"), account("Bea Example"), account("Cy Example"), account("Eve Example"),
    { kind: "conversation", id: "ada", type: "direct", members: ["Me", "Ada Example"] },
    { kind: "conversation", id: "cy", type: "direct", members: ["Me", "Cy Example"] },
    { kind: "conversation", id: "wedding", type: "group", title: "Wedding", members: ["Me", "Ada Example", "Bea Example", "Eve Example"] },
    message("m1", "ada", "Ada Example", at("2026-01-01")),
    message("m2", "ada", "Me", at("2026-01-02")),
    message("m3", "cy", "Cy Example", at("2026-02-03")),
    message("m4", "cy", "Me", at("2026-02-04")),
    message("w1", "wedding", "Bea Example", at("2026-02-10")),
  ];
}

const idOf = (name: string) => (db.prepare("SELECT id FROM person WHERE name = ?").get(name) as { id: number }).id;
const selfId = () => (db.prepare("SELECT id FROM person WHERE is_self = 1").get() as { id: number }).id;
const ada = () => idOf("Ada Example");
const bea = () => idOf("Bea Example");
const cy = () => idOf("Cy Example");

/** A long dinner with Ada on 14 February, as the CLI sends it: hours as typed, and a note with space and a Windows line end. */
const dinner = (): CatchUpInput => ({ day: "2026-02-14", time: null, trip: null, hours: "2.504" as unknown as number, note: "  a long dinner at Ada's \r\n", personIds: [ada()], others: 0 });

const record = <T>(action: string, work: () => T) => changes.record({ surface: "cli", action }, work);

describe("catch-ups", () => {
  it("keeps one with everyone at it, the latest first, written as the app writes them", () => {
    const first = people.addCatchUp(dinner());
    const second = people.addCatchUp({ day: "2026-03-01", time: null, hours: 1, note: "", personIds: [cy(), ada(), cy()] } as unknown as CatchUpInput);
    expect(people.catchUps.get(first)).toEqual({
      id: first, day: "2026-02-14", time: null, trip: null, hours: 2.5, note: "a long dinner at Ada's",
      people: [{ id: ada(), name: "Ada Example", aliases: [] }], others: 0,
    });
    // No others given: none.
    expect(people.catchUps.get(second)).toMatchObject({ hours: 1, note: "", others: 0 });
    // Everyone at it once, A to Z.
    expect(people.catchUps.get(second).people.map((p) => p.name)).toEqual(["Ada Example", "Cy Example"]);
    expect(people.catchUps.list({ personId: ada() }).map((c) => c.id)).toEqual([second, first]);
    expect(people.catchUps.list({ personId: cy() }).map((c) => c.id)).toEqual([second]);
    expect(people.catchUps.list().map((c) => c.id)).toEqual([second, first]);
    // Others as typed ("20") are kept as a number.
    expect(people.catchUps.get(people.addCatchUp({ ...dinner(), others: "20" as unknown as number })).others).toBe(20);
  });

  it("keeps when one started if said, written 19:30, and lists those on one date by it, the latest first and those without one last", () => {
    const lunch = people.addCatchUp({ ...dinner(), time: "7:05" });
    const none = people.addCatchUp({ ...dinner(), time: "" as unknown as null });
    const evening = people.addCatchUp({ ...dinner(), time: " 19:30 " });
    const unsaid = people.addCatchUp({ ...dinner(), time: undefined as unknown as null });
    expect([lunch, none, evening, unsaid].map((id) => people.catchUps.get(id).time)).toEqual(["07:05", null, "19:30", null]);
    expect(people.catchUps.list().map((c) => c.id)).toEqual([evening, lunch, unsaid, none]);
    // The same again is no change; a time alone is one.
    expect(people.changeCatchUp(evening, { ...dinner(), time: "19:30" })).toBe(false);
    expect(people.changeCatchUp(evening, { ...dinner(), time: null })).toBe(true);
    expect(people.catchUps.get(evening).time).toBeNull();
  });

  it("is in person: one by call is refused, as a call is logged as a call; byCall false, from an older page, is passed over", () => {
    const byCall = (value: boolean) => ({ ...dinner(), byCall: value }) as CatchUpInput;
    expect(() => people.addCatchUp(byCall(true))).toThrow(/a hangout is time in person: log a call as a call/);
    const id = people.addCatchUp(byCall(false));
    expect(() => people.changeCatchUp(id, byCall(true))).toThrow(/a hangout is time in person/);
    expect(people.changeCatchUp(id, { ...dinner(), note: "dinner" })).toBe(true);
    expect(people.catchUps.get(id)).not.toHaveProperty("byCall");
    expect(people.catchUps.scored().find((c) => c.id === id)).not.toHaveProperty("byCall");
    expect(people.catchUps.list().map((c) => c.id)).toEqual([id]);
  });

  it("is made a call, its unnamed others with it, and undone a hangout again", () => {
    const id = people.addCatchUp({ ...dinner(), others: 2 });
    // Made a call (as the page's Make it a call does), its unnamed others go with it unless it says.
    const account = people.manualCalls.callAccounts(ada());
    const made = record("catch-up to call", () => people.catchUpToCall(id, {
      people: [{ personId: ada(), accountId: account[0]?.id ?? null, app: account.length === 0 ? "discord" : null }], day: "2026-02-14", time: "19:30", minutes: 150, note: "a long call",
    }));
    expect(() => people.catchUps.get(id)).toThrow(NotFoundError);
    expect(people.manualCalls.get(made.value)).toMatchObject({ others: 2, duration_seconds: 9000, note: "a long call" });
    changes.undo(made.changeset!, { surface: "cli" });
    expect(people.catchUps.get(id)).toMatchObject({ others: 2, note: "a long dinner at Ada's" });
  });

  it("refuses what is not a catch-up, and stores nothing", () => {
    const tomorrow = dayKey(Date.now() + 2 * 86_400_000);
    const wrong: Array<Partial<CatchUpInput>> = [
      { day: tomorrow }, { day: "2026-02-30" }, { day: "26-02-01" }, { day: "1899-12-31" },
      { hours: 0 }, { hours: -1 }, { hours: 0.001 }, { hours: 24.5 }, { hours: Number.NaN }, { hours: "two" as unknown as number },
      { hours: undefined },
      { time: "24:00" }, { time: "19:60" }, { time: "7.30pm" }, { time: "7:30 pm" }, { time: "1930" }, { time: 1930 as unknown as string },
      { byCall: true } as Partial<CatchUpInput>,
      { note: "x".repeat(1001) }, { personIds: [] },
      { others: -1 }, { others: 1.5 }, { others: 10_001 }, { others: "lots" as unknown as number }, { others: Number.NaN },
    ];
    for (const change of wrong) expect(() => people.addCatchUp({ ...dinner(), ...change }), JSON.stringify(change)).toThrow(InvalidInputError);
    expect(() => people.addCatchUp({ ...dinner(), personIds: [selfId()] })).toThrow(/that is you/);
    expect(() => people.addCatchUp({ ...dinner(), personIds: [ada(), 9999] })).toThrow(NotFoundError);
    expect(people.catchUps.list()).toEqual([]);
    // Today is fine; so are a whole day, a quarter of an hour and no note.
    expect(() => people.addCatchUp({ ...dinner(), day: today(), time: null, hours: 24, note: undefined as unknown as string })).not.toThrow();
    expect(() => people.addCatchUp({ ...dinner(), hours: 0.25 })).not.toThrow();
    expect(() => people.addCatchUp({ ...dinner(), others: 10_000 })).not.toThrow();
  });

  it("marks everyone at it edited, which brings someone the rules archived back onto the map", () => {
    expect(structure.getPerson(ada())!.untouched).toBe(true);
    expect(structure.getPerson(bea())!.archived).not.toBeNull();
    people.addCatchUp({ ...dinner(), personIds: [ada(), bea()] });
    expect(structure.getPerson(ada())!.untouched).toBe(false);
    expect(structure.getPerson(bea())!.archived).toBeNull();
    expect(structure.relationships().people.map((p) => p.name)).toContain("Bea Example");
  });

  it("changes and deletes one, each a changeset that shows who it touched and that undo takes back", () => {
    const added = record("catch-up add", () => people.addCatchUp(dinner()));
    const id = added.value;
    const original = people.catchUps.get(id);
    expect(changes.show(added.changeset!).people).toEqual([
      { id: ada(), name: "Ada Example", changes: [{ what: "hangout", before: "", after: "2.5 hours, 14 Feb 2026: a long dinner at Ada's" }] },
    ]);

    // Nothing to change: no changeset.
    expect(record("catch-up change", () => people.changeCatchUp(id, dinner())).changeset).toBeNull();
    expect(structure.getPerson(cy())!.untouched).toBe(true);
    const changed = record("catch-up change", () => people.changeCatchUp(id, { ...dinner(), hours: 1, personIds: [ada(), cy()] }));
    expect(people.catchUps.get(id)).toMatchObject({ hours: 1 });
    expect(changes.show(changed.changeset!).people.map((p) => [p.name, p.changes])).toEqual([
      ["Ada Example", [{ what: "hangout", before: "2.5 hours, 14 Feb 2026: a long dinner at Ada's", after: "1 hour, 14 Feb 2026: a long dinner at Ada's" }]],
      ["Cy Example", [{ what: "hangout", before: "", after: "1 hour, 14 Feb 2026: a long dinner at Ada's" }]],
    ]);
    changes.undo(changed.changeset!, { surface: "cli" });
    expect(people.catchUps.get(id)).toEqual(original);
    // Others alone are a change, said after the date, and undone too.
    const crowd = record("catch-up change", () => people.changeCatchUp(id, { ...dinner(), others: 20 }));
    expect(changes.show(crowd.changeset!).people[0].changes).toEqual([
      { what: "hangout", before: "2.5 hours, 14 Feb 2026: a long dinner at Ada's", after: "2.5 hours, 14 Feb 2026, +20 others: a long dinner at Ada's" },
    ]);
    changes.undo(crowd.changeset!, { surface: "cli" });
    expect(people.catchUps.get(id)).toEqual(original);
    // So is a time, said after the date, and undone too.
    const timed = record("catch-up change", () => people.changeCatchUp(id, { ...dinner(), time: "19:30" }));
    expect(changes.show(timed.changeset!).people[0].changes).toEqual([
      { what: "hangout", before: "2.5 hours, 14 Feb 2026: a long dinner at Ada's", after: "2.5 hours, 14 Feb 2026, 7:30 pm: a long dinner at Ada's" },
    ]);
    changes.undo(timed.changeset!, { surface: "cli" });
    expect(people.catchUps.get(id)).toEqual(original);
    // Cy was never changed by hand but for it, so is untouched again.
    expect(structure.getPerson(cy())!.untouched).toBe(true);

    const deleted = record("catch-up delete", () => people.deleteCatchUp(id));
    expect(people.catchUps.list()).toEqual([]);
    expect(changes.show(deleted.changeset!).people[0].changes).toEqual([{ what: "hangout", before: "2.5 hours, 14 Feb 2026: a long dinner at Ada's", after: "" }]);
    changes.undo(deleted.changeset!, { surface: "cli" });
    expect(people.catchUps.get(id)).toEqual(original);

    // Back as it was added, so the add itself can be undone.
    changes.undo(added.changeset!, { surface: "cli" });
    expect(people.catchUps.list()).toEqual([]);
    expect(structure.getPerson(ada())!.untouched).toBe(true);
  });

  it("refuses to undo an add once the catch-up has been changed since, naming it", () => {
    const added = record("catch-up add", () => people.addCatchUp(dinner()));
    record("catch-up change", () => people.changeCatchUp(added.value, { ...dinner(), note: "dinner" }));
    expect(() => changes.undo(added.changeset!, { surface: "cli" })).toThrow(UndoConflictError);
    expect(() => changes.undo(added.changeset!, { surface: "cli" })).toThrow(/the hangout on 14 Feb 2026 \(hangouts\)/);
    expect(people.catchUps.get(added.value).note).toBe("dinner");
  });

  it("gives the one kept a merged person's catch-ups, and undo of the merge takes them back", () => {
    const theirs = people.addCatchUp({ ...dinner(), personIds: [cy()] });
    const both = people.addCatchUp({ ...dinner(), day: "2026-03-02", personIds: [ada(), cy()] });
    const cyId = cy();
    const merged = record("merge", () => people.merge(ada(), cyId));
    expect(people.catchUps.get(theirs).people.map((p) => p.id)).toEqual([ada()]);
    expect(people.catchUps.get(both).people.map((p) => p.id)).toEqual([ada()]);
    changes.undo(merged.changeset!, { surface: "cli" });
    expect(people.catchUps.get(theirs).people.map((p) => p.id)).toEqual([cyId]);
    expect(people.catchUps.get(both).people.map((p) => p.id).sort()).toEqual([ada(), cyId].sort());
  });

  it("takes a deleted person out of their catch-ups, a catch-up left with nobody going too, and undo puts both back", () => {
    const walt = people.create("Walt Example");
    const alone = people.addCatchUp({ ...dinner(), personIds: [walt] });
    const shared = people.addCatchUp({ ...dinner(), personIds: [walt, ada()] });
    const deleted = record("person delete", () => people.delete(walt));
    expect(() => people.catchUps.get(alone)).toThrow(NotFoundError);
    expect(people.catchUps.get(shared).people.map((p) => p.name)).toEqual(["Ada Example"]);
    changes.undo(deleted.changeset!, { surface: "cli" });
    expect(people.catchUps.get(alone).people.map((p) => p.name)).toEqual(["Walt Example"]);
    expect(people.catchUps.get(shared).people.map((p) => p.name)).toEqual(["Ada Example", "Walt Example"]);
  });

  it("leaves catch-ups as they are through a re-import of the same export and a newer one", () => {
    people.addCatchUp(dinner());
    people.addCatchUp({ ...dinner(), day: "2026-03-01", time: null, hours: 1, personIds: [ada(), cy(), bea()] });
    const before = people.catchUps.list();
    importEvents(sample());
    importEvents([...sample(), message("m5", "ada", "Ada Example", at("2026-03-05")), message("w2", "wedding", "Eve Example", at("2026-03-06"))]);
    people.runRules();
    expect(people.catchUps.list()).toEqual(before);
  });

  it("puts every catch-up in the map's report and the score report, someone with no messages at it too", () => {
    const walt = people.create("Walt Example");
    const id = people.addCatchUp({ day: today(), time: null, hours: 2, note: "", personIds: [cy(), walt] });
    const report = structure.relationships();
    expect(report.catchUps).toEqual([{ id, day: today(), time: null, trip: null, hours: 2, others: 0, personIds: [cy(), walt].sort((a, b) => a - b) }]);
    // On the map, Walt, who has no messages, is someone with no months, for friend-map to score and rank
    // (src/demos/model.test.ts scores a report like this one).
    expect(report.people.find((p) => p.id === walt)).toMatchObject({ months: [], firstMessageAt: null });

    // In the score report too, which the Table's closeness is worked out from (server/methodology.ts), with Walt
    // as someone with no months.
    const scored = structure.scoreReport();
    expect(scored.catchUps).toEqual(report.catchUps);
    expect(scored.people).toContainEqual({ id: walt, months: [] });

    // Two others there unnamed, for the score to share it among four.
    people.changeCatchUp(id, { day: today(), time: null, hours: 2, note: "", personIds: [cy(), walt], others: 2 });
    expect(structure.relationships().catchUps[0].others).toBe(2);
    expect(structure.scoreReport().catchUps[0].others).toBe(2);
  });

  it("answers SQL over person_catch_up: whom the captain caught up with this year, and for how long", () => {
    people.addCatchUp(dinner());
    people.addCatchUp({ day: "2026-03-01", time: null, hours: 1.5, note: "", personIds: [ada(), cy()] });
    people.addCatchUp({ day: "2025-12-20", time: null, hours: 3, note: "", personIds: [bea()] });
    const names = (sql: string) => sqlQuerySync(db, sql).map((id) => structure.getPerson(id)!.name).sort();
    expect(names("SELECT DISTINCT person_id FROM person_catch_up WHERE day >= '2026'")).toEqual(["Ada Example", "Cy Example"]);
    expect(names("SELECT person_id FROM person_catch_up WHERE people = 1 AND day >= '2026'")).toEqual(["Ada Example"]);
    // A note is content, which no query reads.
    expect(() => names("SELECT person_id FROM catch_up_person JOIN catch_up ON id = catch_up_id WHERE note LIKE '%call%'")).toThrow("SQL: a query cannot read content: catch_up.note");
    expect(names("SELECT person_id FROM person_catch_up GROUP BY person_id HAVING SUM(hours) > 2")).toEqual(["Ada Example", "Bea Example"]);
    expect(names("SELECT person_id FROM person_catch_up GROUP BY person_id HAVING count(*) >= 2")).toEqual(["Ada Example"]);
    people.addCatchUp({ day: "2026-03-02", time: null, hours: 4, note: "", personIds: [bea()], others: 30 });
    expect(names("SELECT person_id FROM person_catch_up WHERE people + others > 10")).toEqual(["Bea Example"]);
    people.addCatchUp({ day: "2026-03-03", time: "19:30", hours: 1, note: "", personIds: [cy()] });
    expect(names("SELECT person_id FROM person_catch_up WHERE time >= '18:00'")).toEqual(["Cy Example"]);
    // Every one is in person: the view says nothing of calls, which are in person_call.
    expect(names("SELECT DISTINCT person_id FROM person_catch_up WHERE day >= '2026'")).toEqual(["Ada Example", "Bea Example", "Cy Example"]);
    expect(() => names("SELECT person_id FROM person_catch_up WHERE by_call = 1")).toThrow(/no such column: by_call/);
  });
});

describe("trips over several days", () => {
  /** Away with Ada and Cy from 6 pm on 4 September to 4 pm on the 6th, private midnight to 10 am unless said: 6 + 14 + 6 hours. */
  const trip = (changed: Partial<NonNullable<CatchUpInput["trip"]>> = {}): CatchUpInput => ({
    day: "2026-09-04", time: "18:00", trip: { lastDay: "2026-09-06", endTime: "16:00", ...changed } as NonNullable<CatchUpInput["trip"]>,
    hours: 1, note: "the coast", personIds: [ada(), cy()], others: 0,
  });

  it("keeps one as one, its hours its time together outside each day's private hours, on every day it covers", () => {
    const id = people.addCatchUp(trip());
    // The hours given are not kept: they are worked out, and a trip may have more than a day's.
    expect(people.catchUps.get(id)).toMatchObject({
      day: "2026-09-04", time: "18:00", trip: { lastDay: "2026-09-06", endTime: "16:00", privateFrom: "00:00", privateTo: "10:00" }, hours: 26,
    });
    const on = (from: string, to: string) => people.catchUps.list({ from, to }).map((c) => c.id);
    expect(on("2026-09-05", "2026-09-05")).toEqual([id]);
    expect(on("2026-09-06", "2026-09-30")).toEqual([id]);
    expect(on("2026-08-01", "2026-09-04")).toEqual([id]);
    expect(on("2026-09-07", "2026-09-30")).toEqual([]);
    expect(on("2026-08-01", "2026-09-03")).toEqual([]);
    expect(structure.scoreReport().catchUps).toContainEqual(expect.objectContaining({ id, time: "18:00", trip: people.catchUps.get(id).trip, hours: 26 }));
  });

  it("changes one whole, its private hours too, each a changeset that shows it and undo takes back", () => {
    const added = record("catch-up add", () => people.addCatchUp(trip()));
    const id = added.value;
    const original = people.catchUps.get(id);
    expect(changes.show(added.changeset!).people[0].changes).toEqual([
      { what: "hangout", before: "", after: "26 hours over 3 days, 4–6 Sept 2026, 6:00 pm to 4:00 pm, private 12:00 am–10:00 am: the coast" },
    ]);
    expect(record("catch-up change", () => people.changeCatchUp(id, trip())).changeset).toBeNull();
    // Private 11 pm to 7 am, across midnight: 6 pm to 11 pm, then 7 am to 11 pm, then 7 am to 4 pm.
    const night = record("catch-up change", () => people.changeCatchUp(id, trip({ privateFrom: "23:00", privateTo: "07:00" })));
    expect(people.catchUps.get(id)).toMatchObject({ hours: 30, trip: { privateFrom: "23:00", privateTo: "07:00" } });
    expect(changes.show(night.changeset!).people[0].changes[0].after).toBe("30 hours over 3 days, 4–6 Sept 2026, 6:00 pm to 4:00 pm, private 11:00 pm–7:00 am: the coast");
    changes.undo(night.changeset!, { surface: "cli" });
    expect(people.catchUps.get(id)).toEqual(original);
    // A day alone again, with its own hours.
    const single = record("catch-up change", () => people.changeCatchUp(id, { ...trip(), trip: null, hours: 3 }));
    expect(people.catchUps.get(id)).toMatchObject({ day: "2026-09-04", time: "18:00", trip: null, hours: 3 });
    expect(people.catchUps.list({ from: "2026-09-05", to: "2026-09-05" })).toEqual([]);
    changes.undo(single.changeset!, { surface: "cli" });
    expect(people.catchUps.get(id)).toEqual(original);
    const deleted = record("catch-up delete", () => people.deleteCatchUp(id));
    changes.undo(deleted.changeset!, { surface: "cli" });
    expect(people.catchUps.get(id)).toEqual(original);
  });

  it("refuses what is not a trip, and stores nothing", () => {
    const refused = (input: CatchUpInput, message: RegExp) => expect(() => people.addCatchUp(input)).toThrow(message);
    refused({ ...trip(), time: null }, /needs the time it began/);
    refused(trip({ endTime: "" }), /needs the time it ended/);
    refused(trip({ endTime: "4pm" }), /a time of day/);
    refused(trip({ lastDay: "2026-09-04" }), /last day is after its first/);
    refused(trip({ lastDay: "2026-09-31" }), /is not a date/);
    refused({ ...trip(), byCall: true } as CatchUpInput, /a hangout is time in person/);
    refused(trip({ lastDay: "2999-01-01" }), /after today/);
    refused({ ...trip(), day: "2025-01-01", time: "09:00", trip: { lastDay: "2026-01-02", endTime: "09:00", privateFrom: "00:00", privateTo: "10:00" } }, /at most 366 days/);
    // From 6 pm to 9 am the next day, all of it private: no time together.
    refused({ ...trip(), trip: { lastDay: "2026-09-05", endTime: "09:00", privateFrom: "17:00", privateTo: "10:00" } }, /some time together outside the private hours/);
    expect(people.catchUps.list()).toEqual([]);
    // A year is fine, both ends counted, and so is no private window at all (the same time twice).
    const year = people.addCatchUp({ ...trip(), day: "2025-01-01", time: "00:00", trip: { lastDay: "2026-01-01", endTime: "00:00", privateFrom: "08:00", privateTo: "08:00" } });
    expect(people.catchUps.get(year).hours).toBe(365 * 24);
  });

  it("answers SQL over person_catch_up: a trip's last day, and its time together in all", () => {
    people.addCatchUp(trip());
    people.addCatchUp({ day: "2026-09-10", time: null, trip: null, hours: 2, note: "", personIds: [bea()], others: 0 });
    const names = (sql: string) => sqlQuerySync(db, sql).map((id) => structure.getPerson(id)!.name).sort();
    expect(names("SELECT person_id FROM person_catch_up WHERE last_day IS NOT NULL AND end_time = '16:00'")).toEqual(["Ada Example", "Cy Example"]);
    expect(names("SELECT person_id FROM person_catch_up GROUP BY person_id HAVING SUM(hours) > 24")).toEqual(["Ada Example", "Cy Example"]);
    expect(names("SELECT person_id FROM person_catch_up WHERE coalesce(last_day, day) >= '2026-09-06'")).toEqual(["Ada Example", "Bea Example", "Cy Example"]);
  });
});
