// The Table's Added and First contact (TableRow.addedAt and firstContactAt): when each person was added to the
// archive, and when the captain and they were first in touch, as firstContact.ts works it out.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ArchiveEvent, dayStart, type Db, type MessageType, type TableRow, transaction, wallClock } from "../../../sdk/server.ts";
import { openArchive } from "./db.ts";
import { People } from "./people.ts";
import { ArchiveStructure } from "./structure.ts";
import { ImportSession } from "./write.ts";

let dataDir: string;
let db: Db;
let people: People;
let structure: ArchiveStructure;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "life-archive-first-contact-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  people = new People(db);
  structure = new ArchiveStructure(db, people);
});

afterEach(async () => {
  vi.useRealTimers();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** A time on a Melbourne day (AEDT in February and March). */
const at = (date: string, time: string) => Date.parse(`${date}T${time}:00+11:00`);
const CY_PHONE = "+61491570110";

function importEvents(platform: string, events: ArchiveEvent[]): void {
  transaction(db, () => {
    const source = Number(
      db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'export', 'test', 0, 'ok')")
        .run(platform).lastInsertRowid,
    );
    const session = new ImportSession(db, platform, source, "export");
    for (const event of events) session.apply(event);
  });
}

const account = (key: string, isSelf = false): ArchiveEvent => ({ kind: "account", key, keyKind: "name", displayName: key, isSelf });
let next = 0;
function message(conversation: string, sender: string, sentAt: number, type: MessageType = "text"): ArchiveEvent {
  return { kind: "message", id: `m${next++}`, idKind: "platform", conversation, sender, isFromSelf: sender === "Me", sentAt, type, text: "hi", raw: {} };
}

const personOf = (name: string) => (db.prepare("SELECT id FROM person WHERE name = ?").get(name) as { id: number }).id;
const rowOf = (id: number): TableRow => structure.tableRows().find((p) => p.id === id)!;
const chatOf = (key: string) => (db.prepare("SELECT id FROM conversation WHERE platform_conversation_id = ?").get(key) as { id: number }).id;

describe("a person's first contact", () => {
  it("is their earliest message as messageCount counts them: either way one to one, theirs in a group, never a system message, a Marketplace or a dropped chat", () => {
    importEvents("messenger", [
      account("Me", true), account("Ada Example"), account("Bea Example"),
      { kind: "conversation", id: "ada", type: "direct", members: ["Me", "Ada Example"] },
      { kind: "conversation", id: "ada-bike", type: "direct", members: ["Me", "Ada Example"], marketplace: true },
      { kind: "conversation", id: "club", type: "group", title: "Club", members: ["Me", "Ada Example", "Bea Example"] },
      { kind: "conversation", id: "bulk", type: "group", title: "Bulk", members: ["Me", "Bea Example"] },
      message("ada-bike", "Ada Example", at("2026-02-10", "09:00")),
      message("ada", "Ada Example", at("2026-02-20", "09:00"), "system"),
      message("ada", "Me", at("2026-03-01", "10:00")),
      message("ada", "Ada Example", at("2026-03-01", "10:05")),
      message("bulk", "Bea Example", at("2026-02-01", "12:00")),
      message("club", "Me", at("2026-02-25", "12:00")),
      message("club", "Bea Example", at("2026-03-03", "18:00")),
    ]);
    people.runRules();
    const [ada, bea] = [personOf("Ada Example"), personOf("Bea Example")];
    // The captain's own message opens their one-to-one chat; the system message and the Marketplace chat before it do not.
    expect(rowOf(ada)).toMatchObject({ messageCount: 2, firstContactAt: at("2026-03-01", "10:00") });
    // What the captain says to a group is not her message, so the group's first message of hers is.
    expect(rowOf(bea).firstContactAt).toBe(at("2026-02-01", "12:00"));
    people.dropGroup(chatOf("bulk"));
    expect(rowOf(bea)).toMatchObject({ messageCount: 1, firstContactAt: at("2026-03-03", "18:00") });
  });

  it("is a call of any source when that came first, answered or not, logged ones too", () => {
    importEvents("messenger", [
      account("Me", true), account("Cy Example"),
      { kind: "conversation", id: "cy", type: "direct", members: ["Me", "Cy Example"] },
      message("cy", "Cy Example", at("2026-03-01", "10:00")),
    ]);
    importEvents("phone", [
      { kind: "account", key: CY_PHONE, keyKind: "id", displayName: CY_PHONE, handle: CY_PHONE },
      { kind: "call", id: "P1", with: CY_PHONE, at: at("2026-02-15", "18:00"), durationSeconds: 0, direction: "incoming", answered: false, service: "phone", raw: {} },
    ]);
    people.runRules();
    const cy = personOf("Cy Example");
    const phone = (db.prepare("SELECT id FROM import_person WHERE platform = 'phone'").get() as { id: number }).id;
    people.link(phone, cy);
    expect(rowOf(cy).firstContactAt).toBe(at("2026-02-15", "18:00"));

    const walt = people.create("Walt Example");
    expect(rowOf(walt).firstContactAt).toBeNull();
    people.addCall({ people: [{ personId: walt, accountId: null, app: "facetime" }], day: "2026-03-02", time: "20:15", minutes: 4, note: "" });
    expect(rowOf(walt).firstContactAt).toBe(at("2026-03-02", "20:15"));
  });

  it("is a hangout they were at when that came first: at its time, or its day's start in Melbourne without one", () => {
    const [walt, eve] = [people.create("Walt Example"), people.create("Eve Example")];
    people.addCall({ people: [{ personId: walt, accountId: null, app: "facetime" }], day: "2026-03-10", time: "20:15", minutes: 4, note: "" });
    people.addCatchUp({ day: "2026-03-05", time: null, hours: 2, note: "", personIds: [walt, eve] });
    people.addCatchUp({ day: "2026-03-05", time: "19:30", hours: 1, note: "", personIds: [eve] });
    people.addCatchUp({ day: "2026-03-04", time: "19:30", hours: 1, note: "", personIds: [eve] });
    expect(rowOf(walt).firstContactAt).toBe(dayStart("2026-03-05"));
    expect(rowOf(eve).firstContactAt).toBe(wallClock("2026-03-04", "19:30"));
  });
});

describe("when a person was added", () => {
  it("is when the import that first met them made them, or the captain did; a merge keeps the kept person's, and Not them adds a new one then", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-03-01", "09:00"));
    importEvents("messenger", [
      account("Me", true), account("Ada Example"),
      { kind: "conversation", id: "ada", type: "direct", members: ["Me", "Ada Example"] },
      message("ada", "Ada Example", at("2026-01-01", "10:00")),
    ]);
    people.runRules();
    const ada = personOf("Ada Example");
    expect(rowOf(ada).addedAt).toBe(at("2026-03-01", "09:00"));

    vi.setSystemTime(at("2026-03-05", "09:00"));
    importEvents("telegram", [
      account("Me", true), account("Ada on Telegram"),
      { kind: "conversation", id: "ada", type: "direct", members: ["Me", "Ada on Telegram"] },
      message("ada", "Ada on Telegram", at("2026-01-02", "10:00")),
    ]);
    people.runRules();
    const other = personOf("Ada on Telegram");
    expect(rowOf(other).addedAt).toBe(at("2026-03-05", "09:00"));

    vi.setSystemTime(at("2026-03-06", "09:00"));
    expect(people.merge(other, ada)).toBe(other);
    expect(rowOf(other).addedAt).toBe(at("2026-03-05", "09:00"));

    vi.setSystemTime(at("2026-03-07", "09:00"));
    const messenger = (db.prepare("SELECT id FROM import_person WHERE platform = 'messenger' AND key = 'Ada Example'").get() as { id: number }).id;
    const fresh = people.detach(other, messenger);
    expect(rowOf(fresh).addedAt).toBe(at("2026-03-07", "09:00"));
    expect(rowOf(other).addedAt).toBe(at("2026-03-05", "09:00"));

    vi.setSystemTime(at("2026-03-08", "09:00"));
    expect(rowOf(people.create("Walt Example")).addedAt).toBe(at("2026-03-08", "09:00"));
  });
});
