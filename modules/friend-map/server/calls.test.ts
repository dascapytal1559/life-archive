import { mkdtemp, rm } from "node:fs/promises";
import { changeLog } from "./changeLog.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArchiveEvent, callTotals, Changes, dayStart, type Db, transaction } from "../../../sdk/server.ts";
import { ArchiveContent } from "./content.ts";
import { openArchive } from "./db.ts";
import { People } from "./people.ts";
import { openForQuery } from "./sqlRead.ts";
import { callsBetween, callsOf, listCalls, loggedCall, setCallAnswered, setCallLength, setCallNote } from "./calls.ts";
import { ArchiveStructure } from "./structure.ts";
import { ImportSession } from "./write.ts";

let dataDir: string;
let db: Db;
let people: People;
let structure: ArchiveStructure;
let changes: Changes;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-app-calls-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  people = new People(db);
  structure = new ArchiveStructure(db, people);
  changes = changeLog(db, people);
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** A time on a Melbourne day (AEDT in March). */
const at = (date: string, time: string) => Date.parse(`${date}T${time}:00+11:00`);
const ADA_PHONE = "+61491570006";

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
function call(conversation: string, sender: string, sentAt: number, callSeconds?: number): ArchiveEvent {
  return {
    kind: "message", id: `call${next++}`, idKind: "platform", conversation, sender, isFromSelf: sender === "Me", sentAt, type: "call",
    text: "made-up words an app writes for a call", ...(callSeconds === undefined ? {} : { callSeconds }), raw: {},
  };
}
function text(conversation: string, sender: string, sentAt: number): ArchiveEvent {
  return { kind: "message", id: `text${next++}`, idKind: "platform", conversation, sender, isFromSelf: sender === "Me", sentAt, type: "text", text: "hi", raw: {} };
}

/**
 * Ada on Messenger, WeChat and the phone, all one person: on 1 March a 3-minute Messenger call and a 2.5-minute
 * phone call (each under the 5 minutes a day must reach, together over it) and an unanswered Messenger call; on 2
 * March a lone 3-minute Messenger call; a 20-minute Messenger call in a group chat with Bea; a WeChat call of no
 * known length; and one text.
 */
function importSample(): number {
  importEvents("messenger", [
    account("Me", true), account("Ada"), account("Bea"),
    { kind: "conversation", id: "ada", type: "direct", title: "Ada", members: ["Me", "Ada"] },
    { kind: "conversation", id: "trio", type: "group", title: "Trio", members: ["Me", "Ada", "Bea"] },
    call("ada", "Ada", at("2026-03-01", "19:00"), 180),
    call("ada", "Me", at("2026-03-01", "21:00"), 0),
    call("ada", "Ada", at("2026-03-02", "19:00"), 180),
    text("ada", "Ada", at("2026-03-02", "20:00")),
    call("trio", "Ada", at("2026-03-04", "19:00"), 1200),
  ]);
  importEvents("wechat", [
    account("Me", true), account("Ada on WeChat"),
    { kind: "conversation", id: "ada", type: "direct", members: ["Me", "Ada on WeChat"] },
    call("ada", "Ada on WeChat", at("2026-03-03", "19:00")),
  ]);
  importEvents("phone", [
    { kind: "account", key: ADA_PHONE, keyKind: "id", displayName: ADA_PHONE, handle: ADA_PHONE },
    {
      kind: "call", id: "P1", with: ADA_PHONE, at: at("2026-03-01", "18:00"), durationSeconds: 150, direction: "outgoing", answered: true,
      service: "phone", raw: {},
    },
  ]);
  people.runRules();
  const accountId = (platform: string, key: string) =>
    (db.prepare("SELECT id FROM import_person WHERE platform = ? AND key = ?").get(platform, key) as { id: number }).id;
  const ada = (db.prepare("SELECT person_id FROM import_person WHERE id = ?").get(accountId("messenger", "Ada")) as { person_id: number }).person_id;
  people.link(accountId("wechat", "Ada on WeChat"), ada);
  people.link(accountId("phone", ADA_PHONE), ada);
  return ada;
}

describe("the other apps' calls", () => {
  it("add up with the phone's per person per day, answered ones only, outside group chats, so the minimum applies to the day's total", () => {
    const ada = importSample();
    // Each day's answered seconds added up, which friend-map's closeness weighs against the minimum (callCatchUps).
    expect(structure.relationships().callDays).toEqual([
      { personId: ada, day: "2026-03-01", seconds: 330 },
      { personId: ada, day: "2026-03-02", seconds: 180 },
    ]);
  });

  it("count a call in a one-to-one chat as no message, its length known or not; one in a group chat as one", () => {
    const ada = importSample();
    const them = structure.relationships().people.find((p) => p.id === ada)!;
    // Her text alone: neither the three Messenger calls in their chat nor her WeChat call, whose length is not known.
    expect(them.totals).toMatchObject({ directFromThem: 1, directFromMe: 0, groupFromThem: 1 });
  });

  it("show in the chat with how long they were, or null when their app does not say", () => {
    const ada = importSample();
    const content = new ArchiveContent(db, dataDir);
    const calls = content.timeline(ada, { groups: true })!.messages.filter((m) => m.type === "call");
    expect(calls.map((m) => [m.platform, m.fromSelf, m.callSeconds])).toEqual([
      ["messenger", false, 1200],
      ["wechat", false, null],
      ["messenger", false, 180],
      ["messenger", true, 0],
      ["messenger", false, 180],
    ]);
  });

  it("are among a person's calls when their length is known, marked as messages, so the panel adds them up but the chat does not add them again", () => {
    const ada = importSample();
    const calls = structure.calls(ada)!;
    expect(calls.map((c) => [c.platform, c.messageId !== null, c.direction, c.answered, c.durationSeconds, c.service])).toEqual([
      ["messenger", true, "incoming", true, 180, null],
      ["messenger", true, "outgoing", false, 0, null],
      ["messenger", true, "incoming", true, 180, null],
      ["phone", false, "outgoing", true, 150, "phone"],
    ]);
    expect(callTotals(calls)).toEqual({ answered: 3, seconds: 510, unanswered: 1 });
    // The Table's Phone calls stay the call history's alone.
    const row = structure.tableRows().find((p) => p.id === ada)!;
    expect(row.calls).toMatchObject({ answered: 1, unanswered: 0, seconds: 150 });
  });

  it("are in person_call by platform, the WeChat one with no length or answer known, never the group chat's", () => {
    importSample();
    const query = openForQuery(join(dataDir, "archive.sqlite"));
    try {
      const rows = query.prepare("SELECT platform, call_id IS NOT NULL AS phone, message_id IS NOT NULL AS message, direction, answered, duration_seconds, service, day FROM person_call ORDER BY at").all();
      expect(rows.map((row) => ({ ...row }))).toEqual([
        { platform: "phone", phone: 1, message: 0, direction: "outgoing", answered: 1, duration_seconds: 150, service: "phone", day: "2026-03-01" },
        { platform: "messenger", phone: 0, message: 1, direction: "incoming", answered: 1, duration_seconds: 180, service: null, day: "2026-03-01" },
        { platform: "messenger", phone: 0, message: 1, direction: "outgoing", answered: 0, duration_seconds: 0, service: null, day: "2026-03-01" },
        { platform: "messenger", phone: 0, message: 1, direction: "incoming", answered: 1, duration_seconds: 180, service: null, day: "2026-03-02" },
        { platform: "wechat", phone: 0, message: 1, direction: "incoming", answered: null, duration_seconds: null, service: null, day: "2026-03-03" },
      ]);
    } finally {
      query.close();
    }
  });

  it("count one whose app says no length once the captain gives it one, as a changeset that can be undone, kept through imports", () => {
    const ada = importSample();
    const wechatCall = (db.prepare("SELECT id FROM message WHERE platform = 'wechat' AND type = 'call'").get() as { id: number }).id;
    const give = (minutes: number | null) => changes.record({ surface: "app", action: "call length" }, () => setCallLength(db, wechatCall, minutes));
    const days = () => structure.relationships().callDays.filter((d) => d.day === "2026-03-03");
    expect(days()).toEqual([]);

    const given = give(25);
    expect(given.value).toEqual({ messageId: wechatCall, callSeconds: 25 * 60, callLengthGiven: true });
    expect(days()).toEqual([{ personId: ada, day: "2026-03-03", seconds: 25 * 60 }]);
    const content = new ArchiveContent(db, dataDir);
    const inChat = () => content.timeline(ada, { groups: false })!.messages.find((m) => m.id === wechatCall)!;
    expect(inChat()).toMatchObject({ callSeconds: 25 * 60, callLengthGiven: true });
    expect(structure.calls(ada)!.find((c) => c.messageId === wechatCall)).toMatchObject({ answered: true, durationSeconds: 25 * 60 });
    expect(changes.show(given.changeset!).people).toEqual([
      { id: ada, name: expect.any(String), changes: [{ what: "call on 3 Mar 2026", before: "", after: "25 min" }] },
    ]);

    // The same record imported again keeps the captain's length.
    importEvents("wechat", [
      account("Me", true), account("Ada on WeChat"),
      { kind: "conversation", id: "ada", type: "direct", members: ["Me", "Ada on WeChat"] },
      { ...call("ada", "Ada on WeChat", at("2026-03-03", "19:00")), id: (db.prepare("SELECT platform_message_id AS id FROM message WHERE id = ?").get(wechatCall) as { id: string }).id } as ArchiveEvent,
    ]);
    expect(inChat()).toMatchObject({ callSeconds: 25 * 60, callLengthGiven: true });

    const changed = give(30);
    expect(days()).toEqual([{ personId: ada, day: "2026-03-03", seconds: 30 * 60 }]);
    expect(give(30).changeset).toBeNull();
    changes.undo(changed.changeset!, { surface: "app" });
    expect(inChat()).toMatchObject({ callSeconds: 25 * 60, callLengthGiven: true });
    const cleared = give(null);
    expect(inChat()).toMatchObject({ callSeconds: null, callLengthGiven: false });
    expect(days()).toEqual([]);
    changes.undo(cleared.changeset!, { surface: "app" });
    expect(inChat()).toMatchObject({ callSeconds: 25 * 60, callLengthGiven: true });
  });

  it("refuse a length for a call whose app says one, a call in a group chat, anything not a call, and a length not whole minutes up to a day", () => {
    importSample();
    importEvents("messenger", [call("trio", "Bea", at("2026-03-05", "19:00"))]);
    const id = (where: string) => (db.prepare(`SELECT m.id FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE ${where}`).get() as { id: number }).id;
    const wechatCall = id("m.platform = 'wechat' AND m.type = 'call'");
    expect(() => setCallLength(db, id("m.type = 'call' AND m.call_seconds = 180"), 5)).toThrow(/its app says how long/);
    expect(() => setCallLength(db, id("m.type = 'call' AND m.call_seconds = 0"), 5)).toThrow(/its app says how long/);
    expect(() => setCallLength(db, id("m.type = 'call' AND c.type = 'group' AND m.call_seconds IS NULL"), 5)).toThrow(/group chat/);
    expect(() => setCallLength(db, id("m.type = 'text'"), 5)).toThrow(/not a call/);
    expect(() => setCallLength(db, 999_999, 5)).toThrow(/no message/);
    for (const minutes of [0, -1, 1.5, 24 * 60 + 1, "5", undefined]) expect(() => setCallLength(db, wechatCall, minutes)).toThrow(/whole number/);
    expect(setCallLength(db, wechatCall, 24 * 60).callSeconds).toBe(24 * 3600);
  });

  it("take their length from a later import of the same record, and keep it when nothing else changed", () => {
    importEvents("messenger", [
      account("Me", true), account("Ada"),
      { kind: "conversation", id: "ada", type: "direct", members: ["Me", "Ada"] },
      { ...call("ada", "Ada", at("2026-03-01", "19:00")), id: "same" } as ArchiveEvent,
    ]);
    const length = () => (db.prepare("SELECT call_seconds FROM message WHERE platform_message_id = 'same'").get() as { call_seconds: number | null }).call_seconds;
    expect(length()).toBeNull();
    importEvents("messenger", [{ ...call("ada", "Ada", at("2026-03-01", "19:00"), 240), id: "same" } as ArchiveEvent]);
    expect(length()).toBe(240);
  });

  it("take only a length they lack from a lesser record of them, which adds one the archive lacks", () => {
    const lesser = (id: string, callSeconds?: number) => ({ ...call("ada", "Ada", at("2026-03-01", "19:00"), callSeconds), id, fallback: true }) as ArchiveEvent;
    importEvents("messenger", [
      account("Me", true), account("Ada"),
      { kind: "conversation", id: "ada", type: "direct", members: ["Me", "Ada"] },
      { ...call("ada", "Ada", at("2026-03-01", "19:00")), id: "unknown" } as ArchiveEvent,
      { ...call("ada", "Ada", at("2026-03-01", "20:00"), 2445), id: "known" } as ArchiveEvent,
      lesser("new", 60),
    ]);
    const lengths = () => db.prepare("SELECT platform_message_id AS id, call_seconds AS s FROM message ORDER BY id").all().map((row) => ({ ...row }));
    // A second longer, as the Calls tab may say: the record's own length stays; one of no known length takes it.
    importEvents("messenger", [lesser("known", 2446), lesser("unknown", 300), lesser("new", 61)]);
    expect(lengths()).toEqual([{ id: "known", s: 2445 }, { id: "new", s: 60 }, { id: "unknown", s: 300 }]);
  });
});

describe("an app's calls with several people in no chat", () => {
  /** On WhatsApp, Ada and Bea, each with a chat, and Cy, whom no import has named yet. */
  const threeWay = (alsoWith: string[], others: number, durationSeconds: number | null = 1800): ArchiveEvent => ({
    kind: "call", id: "W1", with: "Ada", ...(alsoWith.length > 0 ? { alsoWith } : {}), ...(others > 0 ? { others } : {}),
    at: at("2026-03-06", "19:00"), ...(durationSeconds === null ? {} : { durationSeconds }), direction: "incoming", answered: true,
    service: "video", raw: {},
  });
  const imported = (events: ArchiveEvent[]) => importEvents("whatsapp", [account("Me", true), account("Ada"), account("Bea"), ...events]);
  const personOf = (key: string) =>
    (db.prepare("SELECT person_id FROM import_person WHERE platform = 'whatsapp' AND key = ?").get(key) as { person_id: number }).person_id;
  const rows = () => db.prepare("SELECT a.key, c.others FROM call c JOIN import_person a ON a.id = c.import_person_id ORDER BY a.key").all().map((row) => ({ ...row }));

  it("are a call with each person named, who each take their share of it with its unnamed others, in their panel, the Calendar and person_call", () => {
    imported([threeWay(["Bea"], 1)]);
    people.runRules();
    const [ada, bea] = [personOf("Ada"), personOf("Bea")];
    expect(rows()).toEqual([{ key: "Ada", others: 1 }, { key: "Bea", others: 1 }]);
    // Each counts their share of half an hour among three, as a call logged with three would.
    expect(structure.relationships().callDays).toEqual([ada, bea].sort((a, b) => a - b).map((personId) => (
      { personId, day: "2026-03-06", seconds: 0, groupCalls: [{ seconds: 1800, people: 3 }] }
    )));
    const [call] = structure.calls(ada)!;
    expect(call).toMatchObject({ platform: "whatsapp", messageId: null, manual: false, direction: "incoming", service: "video", people: 3, others: 1 });
    expect(call.group).toBeLessThan(0);
    expect(structure.calls(bea)![0].group).toBe(call.group);
    // One row each on the Calendar, sharing its group; the Table's Phone calls stay the phone's alone.
    const day = callsBetween(db, dayStart("2026-03-06"), dayStart("2026-03-07"));
    expect(day.map((c) => [c.person, c.group, c.others])).toEqual([[ada, call.group, 1], [bea, call.group, 1]].sort((a, b) => a[0]! - b[0]!));
    expect(structure.tableRows().find((p) => p.id === ada)!.calls).toBeNull();
    const query = openForQuery(join(dataDir, "archive.sqlite"));
    try {
      expect(query.prepare("SELECT person_id, call_group, people, others, service FROM person_call ORDER BY person_id").all().map((row) => ({ ...row }))).toEqual(
        [ada, bea].sort((a, b) => a - b).map((person_id) => ({ person_id, call_group: call.group, people: 3, others: 1, service: "video" })),
      );
    } finally {
      query.close();
    }
  });

  it("keep the people their first record named, whatever a newer one says, and count nothing of no known length", () => {
    imported([threeWay(["Bea"], 1)]);
    const first = (db.prepare("SELECT min(id) AS id FROM call").get() as { id: number }).id;
    // The same again changes nothing.
    const again = new ImportSession(db, "whatsapp", 1, "export");
    transaction(db, () => {
      for (const event of [account("Ada"), account("Bea"), threeWay(["Bea"], 1)]) again.apply(event);
    });
    expect(again.counts.calls).toEqual({ added: 0, updated: 0, unchanged: 1 });
    // A record that names Cy as well, or Cy in Bea's place (as the Mac app's Calls tab may), puts no one on and takes no
    // one off; it brings the rest up to date (here: answered on another device), and the rows keep their numbers.
    importEvents("whatsapp", [account("Ada"), account("Bea"), account("Cy"), threeWay(["Bea", "Cy"], 0)]);
    expect(rows()).toEqual([{ key: "Ada", others: 1 }, { key: "Bea", others: 1 }]);
    importEvents("whatsapp", [account("Ada"), account("Cy"), threeWay(["Cy"], 1, null)]);
    expect(rows()).toEqual([{ key: "Ada", others: 1 }, { key: "Bea", others: 1 }]);
    expect((db.prepare("SELECT min(id) AS id FROM call").get() as { id: number }).id).toBe(first);
    // Answered on another device, so of no known length: in no day's calls and none of the panel's.
    people.runRules();
    expect(structure.relationships().callDays).toEqual([]);
    expect(structure.calls(personOf("Ada"))).toEqual([]);
  });

  it("are the same call as a call record with their id, whichever came first, which only ever gives the other a length", () => {
    const chat = { kind: "conversation", id: "ada", type: "direct", members: ["Me", "Ada"] } as ArchiveEvent;
    const record = (id: string, callSeconds?: number) => ({ ...call("ada", "Ada", at("2026-03-06", "19:00"), callSeconds), id }) as ArchiveEvent;
    const calls = () => db.prepare("SELECT platform_call_id AS id, duration_seconds AS seconds, answered FROM call ORDER BY id").all().map((row) => ({ ...row }));
    const records = () => db.prepare("SELECT platform_message_id AS id, call_seconds AS seconds FROM message ORDER BY id").all().map((row) => ({ ...row }));
    // One copy kept W1 as a three-way call, of no known length; another copy's call record of it adds nothing, gives it its length...
    imported([chat, threeWay(["Bea"], 1, null)]);
    const session = new ImportSession(db, "whatsapp", 1, "export");
    transaction(db, () => {
      for (const event of [account("Me", true), account("Ada"), chat, record("W1", 1500)]) session.apply(event);
    });
    expect(session.counts.calls).toEqual({ added: 0, updated: 1, unchanged: 0 });
    expect(session.counts.messages).toMatchObject({ added: 0, updated: 0 });
    expect(records()).toEqual([]);
    expect(calls()).toEqual([{ id: "W1", seconds: 1500, answered: 1 }, { id: "W1", seconds: 1500, answered: 1 }]);
    // ...and never another.
    importEvents("whatsapp", [record("W1", 60)]);
    expect(calls()).toEqual([{ id: "W1", seconds: 1500, answered: 1 }, { id: "W1", seconds: 1500, answered: 1 }]);

    // One copy kept W2 as a call record in Ada's chat, of no known length; a three-way call of it adds nothing but its length.
    importEvents("whatsapp", [record("W2"), { ...threeWay(["Bea"], 1, 600), id: "W2" } as ArchiveEvent]);
    expect(records()).toEqual([{ id: "W2", seconds: 600 }]);
    importEvents("whatsapp", [account("Bea"), { ...threeWay(["Bea"], 1, 900), id: "W2" } as ArchiveEvent]);
    expect(records()).toEqual([{ id: "W2", seconds: 600 }]);
    expect(calls().map((c) => c.id)).toEqual(["W1", "W1"]);
  });

  it("count someone a merge left on one twice once", () => {
    imported([threeWay(["Bea"], 1)]);
    people.runRules();
    const [ada, bea] = [personOf("Ada"), personOf("Bea")];
    people.merge(ada, bea);
    expect(structure.calls(ada)).toEqual([expect.objectContaining({ people: 2, others: 1 })]);
    expect(structure.relationships().callDays).toEqual([{ personId: ada, day: "2026-03-06", seconds: 0, groupCalls: [{ seconds: 1800, people: 2 }] }]);
  });
});

describe("the calls the captain logs", () => {
  /** Someone's account on a platform. */
  const accountOf = (personId: number, platform: string) =>
    (db.prepare("SELECT id FROM import_person WHERE person_id = ? AND platform = ?").get(personId, platform) as { id: number }).id;
  /** A 4-minute call on 2 March at 8:15 pm on account `accountId` of theirs, as the page sends it (minutes as typed). */
  const onAccount = (personId: number, accountId: number) => ({ people: [{ personId, accountId, app: null }], day: "2026-03-02", time: "20:15", minutes: "4" as unknown as number });
  /** The same on no account, on FaceTime, for someone with no account that carries calls. */
  const facetime = (personId: number) => ({ people: [{ personId, accountId: null, app: "facetime" as const }], day: "2026-03-02", time: "20:15", minutes: "4" as unknown as number });
  const record = <T>(action: string, work: () => T) => changes.record({ surface: "app", action }, work);

  it("are on one of a person's accounts, and count as a call imported on it does: under it, the day's total, the panel's sum, the Table's Phone calls and the Calendar", () => {
    const ada = importSample();
    const phone = accountOf(ada, "phone");
    const id = people.addCall(onAccount(ada, phone));
    const logged = loggedCall(db, id)!;
    expect(logged).toEqual({
      id, platform: "phone", messageId: null, manual: true, accountId: phone, at: at("2026-03-02", "20:15"), durationSeconds: 240,
      direction: null, answered: true, service: null, group: id, people: 1, others: 0, note: "",
    });
    expect(structure.calls(ada)![0]).toEqual(logged);
    expect(structure.calls(ada, phone)!.map((c) => c.manual)).toEqual([true, false]);
    expect(callTotals(structure.calls(ada)!)).toEqual({ answered: 4, seconds: 750, unanswered: 1 });
    // 2 March's 3-minute Messenger call was too short alone; with these 4 minutes the day's 7 count.
    expect(structure.relationships().callDays).toEqual([
      { personId: ada, day: "2026-03-01", seconds: 330 },
      { personId: ada, day: "2026-03-02", seconds: 420 },
    ]);
    // One on the phone account is among the Table's Phone calls; one on Messenger is not, as an imported Messenger call is not.
    const phoneCalls = () => structure.tableRows().find((p) => p.id === ada)!.calls;
    expect(phoneCalls()).toMatchObject({ answered: 2, unanswered: 0, seconds: 390, lastCallAt: at("2026-03-02", "20:15") });
    const messenger = accountOf(ada, "messenger");
    people.addCall({ ...onAccount(ada, messenger), time: "21:00" });
    expect(phoneCalls()).toMatchObject({ answered: 2, seconds: 390 });
    expect(structure.calls(ada, messenger)!.filter((c) => c.manual)).toMatchObject([{ platform: "messenger", accountId: messenger }]);
    // On the Calendar's day, after the phone's.
    expect(callsBetween(db, dayStart("2026-03-01"), dayStart("2026-03-03")).map((c) => [c.manual, c.platform, c.person])).toEqual([
      [false, "phone", ada], [true, "phone", ada], [true, "messenger", ada],
    ]);
  });

  it("are on no account only for someone with none that carries calls, on the app said, and never on someone else's account", () => {
    const ada = importSample();
    const walt = people.create("Walt Example");
    const id = people.addCall(facetime(walt));
    expect(loggedCall(db, id)).toMatchObject({ platform: "facetime", accountId: null, manual: true });
    expect(people.manualCalls.get(id)).toMatchObject({ person_id: walt, account_id: null, app: "facetime", person: walt });
    // A FaceTime one counts among the Table's Phone calls.
    expect(structure.tableRows().find((p) => p.id === walt)!.calls).toMatchObject({ answered: 1, seconds: 240 });
    expect(() => people.addCall(facetime(ada))).toThrow(/on one of their accounts: #\d+ \(messenger\)/);
    const bea = (db.prepare("SELECT id FROM person WHERE name = 'Bea'").get() as { id: number }).id;
    expect(() => people.addCall(onAccount(ada, accountOf(bea, "messenger")))).toThrow(/not one of person \d+'s that carry calls/);
    expect(() => people.addCall(onAccount(walt, accountOf(ada, "phone")))).toThrow(/not one of/);
  });

  it("are added, changed (to another account too) and deleted as changesets that name the call and that undo takes back, marking the person edited", () => {
    importEvents("messenger", [account("Me", true), account("Cy Example"), { kind: "conversation", id: "cy", type: "direct", members: ["Me", "Cy Example"] }, text("cy", "Cy Example", at("2026-03-01", "10:00"))]);
    importEvents("telegram", [account("Me", true), account("Cy Example"), { kind: "conversation", id: "cy", type: "direct", members: ["Me", "Cy Example"] }, text("cy", "Cy Example", at("2026-03-01", "11:00"))]);
    people.runRules();
    const cy = (db.prepare("SELECT id FROM person WHERE name = 'Cy Example'").get() as { id: number }).id;
    const messenger = accountOf(cy, "messenger");
    const telegram = accountOf(cy, "telegram");
    expect(structure.getPerson(cy)!.untouched).toBe(true);
    const added = record("call add", () => people.addCall(onAccount(cy, messenger)));
    expect(structure.getPerson(cy)!.untouched).toBe(false);
    expect(changes.show(added.changeset!).people).toEqual([
      { id: cy, name: "Cy Example", changes: [{ what: "logged call", before: "", after: "4 min on Messenger, 2 Mar 2026, 8:15 pm" }] },
    ]);
    // The same again changes nothing.
    expect(record("call change", () => people.changeCall(added.value, { ...onAccount(cy, messenger), minutes: 4 })).changeset).toBeNull();
    const changed = record("call change", () => people.changeCall(added.value, { ...onAccount(cy, telegram), minutes: 90 }));
    expect(changes.show(changed.changeset!).people[0].changes).toEqual([
      { what: "logged call", before: "4 min on Messenger, 2 Mar 2026, 8:15 pm", after: "1 h 30 min on Telegram, 2 Mar 2026, 8:15 pm" },
    ]);
    changes.undo(changed.changeset!, { surface: "app" });
    expect(loggedCall(db, added.value)).toMatchObject({ platform: "messenger", accountId: messenger, durationSeconds: 240 });
    const deleted = record("call delete", () => people.deleteCall(added.value));
    expect(loggedCall(db, added.value)).toBeNull();
    changes.undo(deleted.changeset!, { surface: "app" });
    expect(loggedCall(db, added.value)).toMatchObject({ durationSeconds: 240, accountId: messenger });
    changes.undo(added.changeset!, { surface: "app" });
    expect(loggedCall(db, added.value)).toBeNull();
    expect(structure.getPerson(cy)!.untouched).toBe(true);
  });

  it("are on WhatsApp, Signal or Discord too for someone with no account that carries calls", () => {
    const walt = people.create("Walt Example");
    for (const app of ["whatsapp", "signal", "discord"] as const) {
      const id = people.addCall({ ...facetime(walt), people: [{ personId: walt, accountId: null, app }] });
      expect(loggedCall(db, id)).toMatchObject({ platform: app, accountId: null, manual: true });
    }
  });

  it("become a catch-up and a catch-up one, each as one changeset that undo takes back whole, everyone on either marked edited", () => {
    const ada = importSample();
    const phone = accountOf(ada, "phone");
    const walt = people.create("Walt Example");
    const call = people.addCall({ ...onAccount(ada, phone), people: [{ personId: ada, accountId: phone, app: null }, { personId: walt, accountId: null, app: "discord" }], note: "Planned the trip" });
    const asCall = loggedCall(db, call);
    const catchUps = () => db.prepare("SELECT count(*) AS n FROM catch_up").get();
    const made = record("call to catch-up", () => people.callToCatchUp(call, { day: "2026-03-02", time: "20:15", hours: "0.07", note: "Planned the trip", personIds: [ada, walt] }));
    expect(db.prepare("SELECT count(*) AS n FROM manual_call").get()).toEqual({ n: 0 });
    expect(people.catchUps.get(made.value)).toMatchObject({ day: "2026-03-02", time: "20:15", hours: 0.07, note: "Planned the trip", others: 0 });
    expect(people.catchUps.get(made.value).people.map((p) => p.id).sort()).toEqual([ada, walt].sort());
    changes.undo(made.changeset!, { surface: "app" });
    expect(catchUps()).toEqual({ n: 0 });
    expect(loggedCall(db, call)).toEqual(asCall);
    expect(people.manualCalls.loggedCall(call).people.map((p) => p.platform)).toEqual(["phone", "discord"]);

    const hangout = people.addCatchUp({ day: "2026-03-03", time: null, hours: 1.5, note: "", personIds: [ada, walt], others: 3 });
    const input = { people: [{ personId: ada, accountId: phone, app: null }, { personId: walt, accountId: null, app: "signal" }], day: "2026-03-03", time: "18:00", minutes: 90, note: "" };
    // Each person is checked as a fresh one on a call is, and nothing changes when one is refused.
    expect(() => people.catchUpToCall(hangout, { ...input, people: [{ personId: ada, accountId: null, app: "phone" }] })).toThrow(/on one of their accounts/);
    expect(catchUps()).toEqual({ n: 1 });
    const back = record("catch-up to call", () => people.catchUpToCall(hangout, input));
    expect(catchUps()).toEqual({ n: 0 });
    expect(people.manualCalls.loggedCall(back.value)).toMatchObject({ at: at("2026-03-03", "18:00"), durationSeconds: 5400, note: "" });
    expect(people.manualCalls.loggedCall(back.value).people.map((p) => [p.person.id, p.platform])).toEqual([[ada, "phone"], [walt, "signal"]]);
    // Its unnamed others come with it (the page's Make it a call does not say), among the call's people.
    expect(loggedCall(db, back.value)).toMatchObject({ people: 5, others: 3 });
    changes.undo(back.changeset!, { surface: "app" });
    expect(people.catchUps.get(hangout)).toMatchObject({ day: "2026-03-03", time: null, hours: 1.5, others: 3 });
    expect(db.prepare("SELECT count(*) AS n FROM manual_call WHERE call_group = ?").get(back.value)).toEqual({ n: 0 });
  });

  it("may have people on it unnamed, who take a share of it, kept through a change that does not say them", () => {
    const ada = importSample();
    const messenger = accountOf(ada, "messenger");
    const added = record("call add", () => people.addCall({ ...onAccount(ada, messenger), others: "2" }));
    expect(loggedCall(db, added.value)).toMatchObject({ people: 3, others: 2, group: added.value });
    expect(people.manualCalls.get(added.value).others).toBe(2);
    // A call with three, Ada's share of it beside 2 March's 3-minute Messenger call (callDaySeconds shares it out).
    expect(structure.relationships().callDays.find((d) => d.day === "2026-03-02")).toEqual({ personId: ada, day: "2026-03-02", seconds: 180, groupCalls: [{ seconds: 240, people: 3 }] });
    expect(changes.show(added.changeset!).people[0].changes).toEqual([
      { what: "logged call", before: "", after: "4 min on Messenger, 2 Mar 2026, 8:15 pm, +2 others" },
    ]);
    expect(listCalls(db).find((c) => c.ref.kind === "logged")).toMatchObject({ people: [ada], others: 2 });
    // Add event's Call does not say them: a change keeps them; one that says changes them, and undo puts them back.
    expect(people.changeCall(added.value, { ...onAccount(ada, messenger), minutes: 5 })).toBe(true);
    expect(people.manualCalls.get(added.value)).toMatchObject({ others: 2, duration_seconds: 300 });
    const none = record("call change", () => people.changeCall(added.value, { ...onAccount(ada, messenger), minutes: 5, others: 0 }));
    expect(loggedCall(db, added.value)).toMatchObject({ people: 1, others: 0 });
    changes.undo(none.changeset!, { surface: "app" });
    expect(people.manualCalls.get(added.value).others).toBe(2);
    for (const others of [-1, 1.5, 10_001, "lots"]) expect(() => people.addCall({ ...onAccount(ada, messenger), others }), String(others)).toThrow(/others are a whole number from 0 to 10,000/);
  });

  it("on the phone with someone alone, and that day's calls from the call history, count the longer, never both; the rest add up", () => {
    // 1 March: a 3-minute Messenger call and the call history's 2.5-minute phone call with Ada.
    const ada = importSample();
    const phone = accountOf(ada, "phone");
    const messenger = accountOf(ada, "messenger");
    const first = () => structure.relationships().callDays.find((d) => d.day === "2026-03-01");
    expect(first()).toEqual({ personId: ada, day: "2026-03-01", seconds: 330 });
    // Four minutes logged on the phone may be the call history's call, logged before it came in: the longer counts.
    const logged = people.addCall({ ...onAccount(ada, phone), day: "2026-03-01", time: "18:00" });
    expect(first()).toEqual({ personId: ada, day: "2026-03-01", seconds: 180 + 240 });
    // Those logged on the phone add up with each other; a minute more makes five.
    people.addCall({ ...onAccount(ada, phone), day: "2026-03-01", time: "22:00", minutes: 1 });
    expect(first()).toEqual({ personId: ada, day: "2026-03-01", seconds: 180 + 300 });
    // Shorter than the call history's, it is the call history's that counts.
    people.changeCall(logged, { ...onAccount(ada, phone), day: "2026-03-01", time: "18:00", minutes: 1 });
    expect(first()).toEqual({ personId: ada, day: "2026-03-01", seconds: 180 + 150 });
    // One logged on another app is never in the call history: it adds up.
    people.addCall({ ...onAccount(ada, messenger), day: "2026-03-01", time: "23:00" });
    expect(first()).toEqual({ personId: ada, day: "2026-03-01", seconds: 180 + 240 + 150 });
    // Nor is one with several people (the call history leaves those out), or with people unnamed: they count their share.
    const walt = people.create("Walt Example");
    people.addCall({ ...onAccount(ada, phone), day: "2026-03-01", time: "23:30", people: [{ personId: ada, accountId: phone, app: null }, { personId: walt, accountId: null, app: "facetime" }] });
    people.addCall({ ...onAccount(ada, phone), day: "2026-03-01", time: "23:45", others: 1 });
    expect(first()).toEqual({ personId: ada, day: "2026-03-01", seconds: 180 + 240 + 150, groupCalls: [{ seconds: 240, people: 2 }, { seconds: 240, people: 2 }] });
    // The Table's Phone calls still list each, as calls.
    expect(structure.tableRows().find((p) => p.id === ada)!.calls).toMatchObject({ answered: 5 });
  });

  it("refuse what is not a call: no person, the captain, a day still to come, no time, a length not whole minutes up to a day, an unknown app", () => {
    const ada = importSample();
    const phone = accountOf(ada, "phone");
    const walt = people.create("Walt Example");
    const me = (db.prepare("SELECT id FROM person WHERE is_self = 1").get() as { id: number }).id;
    expect(() => people.addCall({ ...onAccount(ada, phone), people: [] })).toThrow(/with one or more people/);
    expect(() => people.addCall({ ...onAccount(ada, phone), people: [{}] })).toThrow(/give their number/);
    expect(() => people.addCall({ ...onAccount(ada, phone), people: [...onAccount(ada, phone).people, ...onAccount(ada, phone).people] })).toThrow(/is on a call once/);
    expect(() => people.addCall(facetime(me))).toThrow(/that is you/);
    expect(() => people.addCall(facetime(999_999))).toThrow(/no person/);
    expect(() => people.addCall({ ...onAccount(ada, phone), people: [{ personId: ada, accountId: "phone" }] })).toThrow(/give its number/);
    expect(() => people.addCall({ ...onAccount(ada, phone), day: "2999-01-01" })).toThrow(/after today/);
    expect(() => people.addCall({ ...onAccount(ada, phone), day: "2026-02-30" })).toThrow(/real date/);
    expect(() => people.addCall({ ...onAccount(ada, phone), time: "" })).toThrow(/time is when it started/);
    expect(() => people.addCall({ ...onAccount(ada, phone), minutes: 1.5 })).toThrow(/whole number of minutes/);
    expect(() => people.addCall({ ...onAccount(ada, phone), minutes: 24 * 60 + 1 })).toThrow(/whole number of minutes/);
    expect(() => people.addCall({ ...facetime(walt), people: [{ personId: walt, accountId: null, app: "skype" }] })).toThrow(/on no account is on one of/);
    expect(db.prepare("SELECT count(*) AS n FROM manual_call").get()).toEqual({ n: 0 });
  });

  it("are kept through re-imports, go with their account through a merge and a detach (each undone with it), and go with a person deleted", () => {
    const ada = importSample();
    const phone = accountOf(ada, "phone");
    const id = people.addCall(onAccount(ada, phone));
    importSample();
    importEvents("phone", [
      { kind: "call", id: "P1", with: ADA_PHONE, at: at("2026-03-01", "18:00"), durationSeconds: 150, direction: "outgoing", answered: true, service: "phone", raw: {} },
      { kind: "call", id: "P2", with: ADA_PHONE, at: at("2026-03-05", "18:00"), durationSeconds: 60, direction: "incoming", answered: true, service: "phone", raw: {} },
    ]);
    people.runRules();
    expect(db.prepare("SELECT count(*) AS n FROM manual_call").get()).toEqual({ n: 1 });
    expect(structure.calls(ada)!.filter((c) => c.manual).map((c) => c.id)).toEqual([id]);

    // Detached, the phone account takes its logged call to the person it becomes; undone, both come back.
    const detached = record("detach", () => people.detach(ada, phone));
    expect(people.manualCalls.get(id).person).toBe(detached.value);
    expect(structure.calls(detached.value)!.filter((c) => c.manual).map((c) => c.id)).toEqual([id]);
    expect(structure.calls(ada)!.some((c) => c.manual)).toBe(false);
    changes.undo(detached.changeset!, { surface: "app" });
    expect(people.manualCalls.get(id).person).toBe(ada);

    // Merged into someone, a person's account takes its call along; one on no account is given to the one kept.
    const bea = (db.prepare("SELECT id FROM person WHERE name = 'Bea'").get() as { id: number }).id;
    const beas = people.addCall(onAccount(bea, accountOf(bea, "messenger")));
    const walt = people.create("Walt Example");
    const walts = people.addCall(facetime(walt));
    const intoAda = record("merge", () => [people.merge(ada, bea), people.merge(ada, walt)]);
    expect(people.manualCalls.get(beas)).toMatchObject({ person: ada, person_id: null });
    expect(people.manualCalls.get(walts)).toMatchObject({ person: ada, person_id: ada });
    expect(structure.calls(ada)!.filter((c) => c.manual).map((c) => c.id).sort()).toEqual([id, beas, walts].sort());
    changes.undo(intoAda.changeset!, { surface: "app" });
    expect(people.manualCalls.get(beas).person).toBe(bea);
    expect(people.manualCalls.get(walts).person).toBe(walt);
    people.delete(walt);
    expect(loggedCall(db, walts)).toBeNull();
  });

  describe("with several people", () => {
    /** Ada on her phone, Bea on Messenger and Walt (no account that carries calls) on FaceTime: 45 minutes on 6 March at 7 pm. */
    function groupCall() {
      const ada = importSample();
      const bea = (db.prepare("SELECT id FROM person WHERE name = 'Bea'").get() as { id: number }).id;
      const walt = people.create("Walt Example");
      const on = { ada: accountOf(ada, "phone"), bea: accountOf(bea, "messenger") };
      const input = (minutes: number, who = [ada, bea, walt]) => ({
        people: who.map((personId) => personId === walt ? { personId, accountId: null, app: "facetime" as const } : { personId, accountId: personId === ada ? on.ada : on.bea, app: null }),
        day: "2026-03-06", time: "19:00", minutes,
      });
      const added = record("call add", () => people.addCall(input(45)));
      const rows = () => db.prepare("SELECT id, call_group, person_id, account_id, app, duration_seconds FROM manual_call ORDER BY id").all().map((row) => ({ ...row }));
      const days = () => structure.relationships().callDays.filter((d) => d.day === "2026-03-06").sort((a, b) => a.personId - b.personId);
      return { ada, bea, walt, on, input, added, rows, days };
    }

    it("are one logged call for each, on their own account, sharing a group, and each counts their share of its time", () => {
      const { ada, bea, walt, on, added, rows, days } = groupCall();
      const id = added.value;
      expect(rows()).toEqual([
        { id, call_group: id, person_id: null, account_id: on.ada, app: null, duration_seconds: 2700 },
        { id: id + 1, call_group: id, person_id: null, account_id: on.bea, app: null, duration_seconds: 2700 },
        { id: id + 2, call_group: id, person_id: walt, account_id: null, app: "facetime", duration_seconds: 2700 },
      ]);
      // Each one's chat lists the whole call, with how many were on it.
      expect(structure.calls(bea)!.filter((c) => c.manual)).toEqual([expect.objectContaining({ id: id + 1, platform: "messenger", durationSeconds: 2700, group: id, people: 3 })]);
      // For the closeness score: the whole call, with how many were on it, for the score to share out (callDaySeconds).
      expect(days()).toEqual([
        { personId: ada, day: "2026-03-06", seconds: 0, groupCalls: [{ seconds: 2700, people: 3 }] },
        { personId: bea, day: "2026-03-06", seconds: 0, groupCalls: [{ seconds: 2700, people: 3 }] },
        { personId: walt, day: "2026-03-06", seconds: 0, groupCalls: [{ seconds: 2700, people: 3 }] },
      ].sort((a, b) => a.personId - b.personId));
      // The change log has a line for each of them.
      expect(changes.show(added.changeset!).people.map((p) => [p.id, p.changes])).toEqual(expect.arrayContaining([
        [ada, [{ what: "logged call", before: "", after: "45 min on Phone, 6 Mar 2026, 7:00 pm" }]],
        [bea, [{ what: "logged call", before: "", after: "45 min on Messenger, 6 Mar 2026, 7:00 pm" }]],
        [walt, [{ what: "logged call", before: "", after: "45 min on FaceTime, 6 Mar 2026, 7:00 pm" }]],
      ]));
      expect(people.manualCalls.loggedCall(id + 2)).toEqual({
        at: at("2026-03-06", "19:00"), durationSeconds: 2700, note: "",
        people: [
          { callId: id, person: expect.objectContaining({ id: ada }), accountId: on.ada, platform: "phone" },
          { callId: id + 1, person: expect.objectContaining({ id: bea, name: "Bea" }), accountId: on.bea, platform: "messenger" },
          { callId: id + 2, person: { id: walt, name: "Walt Example", aliases: [] }, accountId: null, platform: "facetime" },
        ],
      });
      // In the person_call view with its group and how many were on it.
      const query = openForQuery(join(dataDir, "archive.sqlite"));
      try {
        expect(query.prepare("SELECT person_id, call_group, people FROM person_call WHERE manual_call_id IS NOT NULL ORDER BY manual_call_id").all().map((row) => ({ ...row }))).toEqual([
          { person_id: ada, call_group: id, people: 3 }, { person_id: bea, call_group: id, people: 3 }, { person_id: walt, call_group: id, people: 3 },
        ]);
      } finally {
        query.close();
      }
    });

    it("are changed and deleted whole from any one's call, each one changeset that undo takes back", () => {
      const { ada, bea, walt, input, added, rows, days } = groupCall();
      const id = added.value;
      // From Bea's: Walt taken off and 30 minutes, the two left sharing it.
      const changed = record("call change", () => people.changeCall(id + 1, input(30, [ada, bea])));
      expect(rows().map((r) => [r.id, r.duration_seconds])).toEqual([[id, 1800], [id + 1, 1800]]);
      expect(days().map((d) => [d.personId, d.groupCalls])).toEqual([[ada, [{ seconds: 1800, people: 2 }]], [bea, [{ seconds: 1800, people: 2 }]]].sort((a, b) => (a[0] as number) - (b[0] as number)));
      expect(changes.show(changed.changeset!).people.find((p) => p.id === walt)!.changes).toEqual([
        { what: "logged call", before: "45 min on FaceTime, 6 Mar 2026, 7:00 pm", after: "" },
      ]);
      // Someone put on takes a new call in the same group.
      const cy = people.create("Cy Example");
      const more = record("call change", () => people.changeCall(id, { ...input(30, [ada, bea]), people: [...input(30, [ada, bea]).people, { personId: cy, accountId: null, app: "phone" }] }));
      expect(rows().map((r) => [r.call_group, r.person_id])).toEqual([[id, null], [id, null], [id, cy]]);
      changes.undo(more.changeset!, { surface: "app" });
      changes.undo(changed.changeset!, { surface: "app" });
      expect(rows().map((r) => [r.id, r.duration_seconds])).toEqual([[id, 2700], [id + 1, 2700], [id + 2, 2700]]);

      const deleted = record("call delete", () => people.deleteCall(id + 2));
      expect(rows()).toEqual([]);
      expect(changes.show(deleted.changeset!).people.map((p) => p.id).sort()).toEqual([ada, bea, walt].sort());
      changes.undo(deleted.changeset!, { surface: "app" });
      expect(rows().map((r) => r.call_group)).toEqual([id, id, id]);
    });

    it("count someone a merge left on one twice once, and the next change keeps one", () => {
      const { ada, bea, walt, input, added, rows, days } = groupCall();
      const id = added.value;
      people.merge(ada, bea);
      // Ada's phone and her merged Messenger: once on it, so two people share it.
      expect(structure.calls(ada)!.filter((c) => c.manual)).toEqual([expect.objectContaining({ id, people: 2 })]);
      expect(days()).toEqual([ada, walt].sort((a, b) => a - b).map((personId) => ({ personId, day: "2026-03-06", seconds: 0, groupCalls: [{ seconds: 2700, people: 2 }] })));
      expect(people.manualCalls.loggedCall(id).people.map((p) => p.person.id)).toEqual([ada, walt]);
      people.changeCall(id, { ...input(45, [ada, walt]), people: input(45, [ada, walt]).people.map((p) => (p.personId === ada ? { ...p, accountId: (rows()[0].account_id as number) } : p)) });
      expect(rows().map((r) => r.id)).toEqual([id, id + 2]);
    });
  });

  it("are in person_call, on their account and its platform, with no direction or service", () => {
    const ada = importSample();
    const wechat = accountOf(ada, "wechat");
    const id = people.addCall(onAccount(ada, wechat));
    const query = openForQuery(join(dataDir, "archive.sqlite"));
    try {
      expect({ ...query.prepare("SELECT manual_call_id, call_id, message_id, account_id, platform, direction, answered, duration_seconds, service, day FROM person_call WHERE manual_call_id IS NOT NULL").get() }).toEqual({
        manual_call_id: id, call_id: null, message_id: null, account_id: wechat, platform: "wechat", direction: null, answered: 1, duration_seconds: 240, service: null, day: "2026-03-02",
      });
    } finally {
      query.close();
    }
  });
});

describe("the Table's Calls", () => {
  const accountOf = (personId: number, platform: string) =>
    (db.prepare("SELECT id FROM import_person WHERE person_id = ? AND platform = ?").get(personId, platform) as { id: number }).id;
  const messageOf = (where: string) => (db.prepare(`SELECT id FROM message WHERE ${where}`).get() as { id: number }).id;
  /** The sample, with a 4-minute call Ada and the captain had on 2 March at 8:15 pm, logged on her phone account. */
  function sample() {
    const ada = importSample();
    const logged = people.addCall({ people: [{ personId: ada, accountId: accountOf(ada, "phone"), app: null }], day: "2026-03-02", time: "20:15", minutes: 4, note: "" });
    const phoneCall = (db.prepare("SELECT id FROM call").get() as { id: number }).id;
    return { ada, logged, phoneCall, wechat: messageOf("platform = 'wechat' AND type = 'call'") };
  }
  const noted = (ref: unknown, note: unknown) => changes.record({ surface: "app", action: "call note" }, () => setCallNote(db, people.manualCalls, ref, note));

  it("lists every call with anyone from every source, one each, newest first, with whose its length is and whether it can be set; never a group chat's", () => {
    const { ada, logged, phoneCall, wechat } = sample();
    const listed = listCalls(db);
    expect(listed.map((c) => [c.ref.kind, c.at, c.source, c.platform])).toEqual([
      ["record", at("2026-03-03", "19:00"), "record", "wechat"],
      ["logged", at("2026-03-02", "20:15"), "logged", "phone"],
      ["record", at("2026-03-02", "19:00"), "record", "messenger"],
      ["record", at("2026-03-01", "21:00"), "record", "messenger"],
      ["record", at("2026-03-01", "19:00"), "record", "messenger"],
      ["call", at("2026-03-01", "18:00"), "history", "phone"],
    ]);
    expect(listed.every((c) => c.people.length === 1 && c.people[0] === ada && c.others === 0 && c.note === "")).toBe(true);
    expect(listed[0]).toMatchObject({ ref: { kind: "record", id: wechat }, direction: "incoming", answered: null, durationSeconds: null, length: null, lengthEditable: true });
    expect(listed[1]).toMatchObject({ ref: { kind: "logged", id: logged }, direction: null, answered: true, durationSeconds: 240, length: "logged", lengthEditable: true, service: null });
    expect(listed[2]).toMatchObject({ direction: "incoming", answered: true, durationSeconds: 180, length: "source", lengthEditable: false });
    expect(listed[3]).toMatchObject({ direction: "outgoing", answered: false, durationSeconds: 0, length: "source", lengthEditable: false });
    expect(listed[5]).toMatchObject({ ref: { kind: "call", id: phoneCall }, direction: "outgoing", answered: true, durationSeconds: 150, length: "source", service: "phone", lengthEditable: false });

    // A length the captain gives a call record is his, and counts as the chat's Add length does.
    changes.record({ surface: "app", action: "call length" }, () => setCallLength(db, wechat, 25));
    expect(listCalls(db)[0]).toMatchObject({ answered: true, durationSeconds: 1500, length: "given", lengthEditable: true });
    expect(structure.relationships().callDays.filter((d) => d.day === "2026-03-03")).toEqual([{ personId: ada, day: "2026-03-03", seconds: 1500 }]);
  });

  it("lists an app's call with several people in no chat once, with everyone on it its source names and its unnamed others", () => {
    importEvents("whatsapp", [
      account("Me", true), account("Ada"), account("Bea"),
      {
        kind: "call", id: "W1", with: "Ada", alsoWith: ["Bea"], others: 1, at: at("2026-03-06", "19:00"), durationSeconds: 1800, direction: "incoming",
        answered: true, service: "video", raw: {},
      },
    ]);
    people.runRules();
    const personOf = (key: string) => (db.prepare("SELECT person_id FROM import_person WHERE platform = 'whatsapp' AND key = ?").get(key) as { person_id: number }).person_id;
    const [call] = listCalls(db);
    expect(listCalls(db)).toHaveLength(1);
    expect(call).toMatchObject({ source: "app", platform: "whatsapp", service: "video", others: 1, length: "source", lengthEditable: false });
    expect([...call.people].sort()).toEqual([personOf("Ada"), personOf("Bea")].sort());
    // Its note is the call's, whichever row it was given on: everyone on it has it.
    const rows = (db.prepare("SELECT id FROM call ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    noted({ kind: "call", id: rows[1] }, "Planned the trip");
    expect(listCalls(db)[0].note).toBe("Planned the trip");
    expect(callsOf(db, personOf("Ada"))[0].note).toBe("Planned the trip");
    expect(callsOf(db, personOf("Bea"))[0].note).toBe("Planned the trip");
  });

  it("gives any call a note, shown wherever the call is, as a changeset that names it and that undo takes back, kept through imports", () => {
    const { ada, logged, phoneCall, wechat } = sample();
    const content = new ArchiveContent(db, dataDir);
    const inChat = (id: number) => content.timeline(ada, { groups: false })!.messages.find((m) => m.id === id)!;

    // A call record: in the list, and in the chat beside it.
    const record = noted({ kind: "record", id: wechat }, "  Planned the trip\r\n");
    expect(record.value).toEqual({ call: { kind: "record", id: wechat }, note: "Planned the trip" });
    expect(listCalls(db)[0].note).toBe("Planned the trip");
    expect(inChat(wechat).callNote).toBe("Planned the trip");
    expect(inChat(messageOf("platform = 'messenger' AND type = 'text'")).callNote).toBe("");
    expect(changes.show(record.changeset!).people).toEqual([
      { id: ada, name: expect.any(String), changes: [{ what: "call note, 3 Mar 2026", before: "", after: "Planned the trip" }] },
    ]);
    // The same note again changes nothing.
    expect(noted({ kind: "record", id: wechat }, "Planned the trip").changeset).toBeNull();

    // A phone call: in the panel's calls (and so the chat), kept through the call history imported again.
    noted({ kind: "call", id: phoneCall }, "Asked about the move");
    expect(callsOf(db, ada).find((c) => c.id === phoneCall && !c.manual && c.messageId === null)!.note).toBe("Asked about the move");
    importEvents("phone", [{
      kind: "call", id: "P1", with: ADA_PHONE, at: at("2026-03-01", "18:00"), durationSeconds: 150, direction: "outgoing", answered: true, service: "phone", raw: {},
    }]);
    expect(listCalls(db).at(-1)!.note).toBe("Asked about the move");

    // A logged call: on its rows, in the form that changes it, and kept by a change that does not say otherwise.
    const loggedNote = noted({ kind: "logged", id: logged }, "Caught up on the week");
    expect(loggedCall(db, logged)!.note).toBe("Caught up on the week");
    expect(people.manualCalls.loggedCall(logged).note).toBe("Caught up on the week");
    expect(changes.show(loggedNote.changeset!).people[0].changes).toEqual([
      { what: "logged call", before: "4 min on Phone, 2 Mar 2026, 8:15 pm", after: "4 min on Phone, 2 Mar 2026, 8:15 pm: Caught up on the week" },
    ]);

    // Taken away, the note goes from everywhere, its row left emptied; undo puts it back.
    const cleared = noted({ kind: "record", id: wechat }, "");
    expect(inChat(wechat).callNote).toBe("");
    expect(db.prepare("SELECT message_id, note FROM call_note WHERE message_id = ?").get(wechat)).toEqual({ message_id: wechat, note: "" });
    expect(noted({ kind: "record", id: wechat }, "").changeset).toBeNull();
    changes.undo(cleared.changeset!, { surface: "app" });
    expect(inChat(wechat).callNote).toBe("Planned the trip");
    // Undoing the first note takes the row away with it, once what came after is undone.
    changes.undo(record.changeset!, { surface: "app" });
    expect(db.prepare("SELECT count(*) AS n FROM call_note WHERE message_id = ?").get(wechat)).toEqual({ n: 0 });
    changes.undo(loggedNote.changeset!, { surface: "app" });
    expect(loggedCall(db, logged)!.note).toBe("");
  });

  it("refuses a note for anything not a call with someone, and a note that is not text or is too long", () => {
    const { wechat } = sample();
    importEvents("messenger", [call("trio", "Bea", at("2026-03-05", "19:00"))]);
    const groupCall = messageOf("platform = 'messenger' AND type = 'call' AND call_seconds IS NULL");
    expect(() => setCallNote(db, people.manualCalls, { kind: "record", id: groupCall }, "A note")).toThrow(/group chat/);
    expect(() => setCallNote(db, people.manualCalls, { kind: "record", id: messageOf("type = 'text'") }, "A note")).toThrow(/not a call/);
    expect(() => setCallNote(db, people.manualCalls, { kind: "record", id: 999_999 }, "A note")).toThrow(/no message/);
    expect(() => setCallNote(db, people.manualCalls, { kind: "call", id: 999_999 }, "A note")).toThrow(/no call/);
    expect(() => setCallNote(db, people.manualCalls, { kind: "logged", id: 999_999 }, "A note")).toThrow(/no logged call/);
    for (const ref of [null, {}, { kind: "message", id: wechat }, { kind: "record", id: "1" }]) {
      expect(() => setCallNote(db, people.manualCalls, ref, "A note")).toThrow(/its kind/);
    }
    expect(() => setCallNote(db, people.manualCalls, { kind: "record", id: wechat }, 5)).toThrow(/is text/);
    expect(() => setCallNote(db, people.manualCalls, { kind: "record", id: wechat }, "x".repeat(1001))).toThrow(/at most 1,000/);
  });

  const answered = (ref: unknown, answer: unknown) => changes.record({ surface: "app", action: "call answered" }, () => setCallAnswered(db, ref, answer));
  const march = (day: string) => structure.relationships().callDays.filter((d) => d.day === day);

  it("takes the captain's answer over its source's, which the closeness score follows, as a changeset that names it and that undo takes back", () => {
    const { ada, phoneCall, wechat } = sample();
    const evening = messageOf(`platform = 'messenger' AND type = 'call' AND sent_at = ${at("2026-03-01", "19:00")}`);
    // 1 March: the 3-minute Messenger call and the 2.5-minute phone call, together over the day's 5 minutes.
    expect(march("2026-03-01")).toEqual([{ personId: ada, day: "2026-03-01", seconds: 330 }]);

    // Missed: it counts nothing, whatever its length, and the list says whose that is and what its source says.
    const missed = answered({ kind: "record", id: evening }, "missed");
    expect(missed.value).toEqual({ call: { kind: "record", id: evening }, answered: false, answeredSet: true });
    expect(march("2026-03-01")).toEqual([{ personId: ada, day: "2026-03-01", seconds: 150 }]);
    expect(listCalls(db).find((c) => c.ref.kind === "record" && c.ref.id === evening)).toMatchObject({ answered: false, answeredSet: true, sourceAnswered: true, durationSeconds: 180 });
    expect(callsOf(db, ada).find((c) => c.messageId === evening)!.answered).toBe(false);
    expect(changes.show(missed.changeset!).people).toEqual([
      { id: ada, name: expect.any(String), changes: [{ what: "call answered, 1 Mar 2026", before: "as its source says", after: "missed" }] },
    ]);
    expect(answered({ kind: "record", id: evening }, "missed").changeset).toBeNull();

    // Back to what its source says: his answer goes, its row left emptied, and it counts again.
    const back = answered({ kind: "record", id: evening }, "answered");
    expect(back.value).toEqual({ call: { kind: "record", id: evening }, answered: true, answeredSet: false });
    expect(db.prepare("SELECT answered FROM call_answered WHERE message_id = ?").get(evening)).toEqual({ answered: "" });
    expect(march("2026-03-01")).toEqual([{ personId: ada, day: "2026-03-01", seconds: 330 }]);
    expect(changes.show(back.changeset!).people[0].changes).toEqual([{ what: "call answered, 1 Mar 2026", before: "missed", after: "as its source says" }]);

    // Unknown: a phone call counts nothing (the day keeps the Messenger call alone), as a call whose source says neither; SQL reads his answer too; kept through
    // the call history imported again.
    const unknown = answered({ kind: "call", id: phoneCall }, "unknown");
    expect(unknown.value.answered).toBeNull();
    expect(march("2026-03-01")).toEqual([{ personId: ada, day: "2026-03-01", seconds: 180 }]);
    expect(listCalls(db).at(-1)).toMatchObject({ ref: { kind: "call", id: phoneCall }, answered: null, answeredSet: true, sourceAnswered: true });
    importEvents("phone", [{
      kind: "call", id: "P1", with: ADA_PHONE, at: at("2026-03-01", "18:00"), durationSeconds: 150, direction: "outgoing", answered: true, service: "phone", raw: {},
    }]);
    expect(listCalls(db).at(-1)!.answered).toBeNull();
    const query = openForQuery(join(dataDir, "archive.sqlite"));
    try {
      expect(query.prepare("SELECT answered FROM person_call WHERE call_id = ?").get(phoneCall)).toEqual({ answered: null });
    } finally {
      query.close();
    }

    // Answered with no length: nothing to count until he gives it one, then its length.
    answered({ kind: "record", id: wechat }, "answered");
    expect(listCalls(db)[0]).toMatchObject({ answered: true, answeredSet: true, sourceAnswered: null, durationSeconds: null, lengthEditable: true });
    expect(march("2026-03-03")).toEqual([]);
    changes.record({ surface: "app", action: "call length" }, () => setCallLength(db, wechat, 25));
    expect(march("2026-03-03")).toEqual([{ personId: ada, day: "2026-03-03", seconds: 1500 }]);

    // Undo takes each back.
    changes.undo(unknown.changeset!, { surface: "app" });
    expect(march("2026-03-01")).toEqual([{ personId: ada, day: "2026-03-01", seconds: 330 }]);
    expect(listCalls(db).at(-1)).toMatchObject({ answered: true, answeredSet: false });
  });

  it("takes away the length he gave a call he says was missed, gives it none after, and undo brings it back", () => {
    const { ada, wechat } = sample();
    changes.record({ surface: "app", action: "call length" }, () => setCallLength(db, wechat, 25));
    expect(march("2026-03-03")).toEqual([{ personId: ada, day: "2026-03-03", seconds: 1500 }]);
    const missed = answered({ kind: "record", id: wechat }, "missed");
    expect(missed.value).toEqual({ call: { kind: "record", id: wechat }, answered: false, answeredSet: true });
    expect(db.prepare("SELECT count(*) AS n FROM call_length WHERE message_id = ?").get(wechat)).toEqual({ n: 0 });
    expect(listCalls(db)[0]).toMatchObject({ answered: false, durationSeconds: null, length: null, lengthEditable: false });
    expect(march("2026-03-03")).toEqual([]);
    expect(() => setCallLength(db, wechat, 10)).toThrow(/missed, so it has no length/);
    changes.undo(missed.changeset!, { surface: "app" });
    expect(listCalls(db)[0]).toMatchObject({ answered: true, answeredSet: false, durationSeconds: 1500, lengthEditable: true });
    expect(march("2026-03-03")).toEqual([{ personId: ada, day: "2026-03-03", seconds: 1500 }]);
  });

  it("shows the chat a call record's answer as he said it, null when he said none or it is as its source says, kept after he takes it away and undone", () => {
    const { ada, wechat } = sample();
    const content = new ArchiveContent(db, dataDir);
    const conversation = (db.prepare("SELECT conversation_id AS id FROM message WHERE id = ?").get(wechat) as { id: number }).id;
    const inChat = (id: number) => content.timeline(ada, { groups: false })!.messages.find((m) => m.id === id)!;
    const inConversation = (id: number) => content.conversation(conversation).messages.find((m) => m.id === id)!;
    const evening = messageOf(`platform = 'messenger' AND type = 'call' AND sent_at = ${at("2026-03-01", "19:00")}`);
    expect(inChat(wechat)).toMatchObject({ callSeconds: null, callAnswer: null });
    expect(inChat(messageOf("platform = 'messenger' AND type = 'text'")).callAnswer).toBeNull();

    // The chat's No answer: the chat reads it back, whichever way it is opened.
    const missed = answered({ kind: "record", id: wechat }, "missed");
    expect(inChat(wechat)).toMatchObject({ callSeconds: null, callLengthGiven: false, callAnswer: "missed" });
    expect(inConversation(wechat).callAnswer).toBe("missed");
    // Taken away (unknown, as its app says): none of his, so Add length again.
    const back = answered({ kind: "record", id: wechat }, "unknown");
    expect(back.value.answeredSet).toBe(false);
    expect(inChat(wechat).callAnswer).toBeNull();
    changes.undo(back.changeset!, { surface: "app" });
    expect(inChat(wechat).callAnswer).toBe("missed");
    changes.undo(missed.changeset!, { surface: "app" });
    expect(inChat(wechat).callAnswer).toBeNull();

    // A call whose app gives a length: his answer over it, the length still its app's.
    answered({ kind: "record", id: evening }, "missed");
    expect(inChat(evening)).toMatchObject({ callSeconds: 180, callAnswer: "missed" });
    answered({ kind: "record", id: evening }, "answered");
    expect(inChat(evening).callAnswer).toBeNull();
  });

  it("refuses an answer for a call he logged, anything not a call with someone, and anything but answered, missed or unknown", () => {
    const { logged, wechat } = sample();
    importEvents("messenger", [call("trio", "Bea", at("2026-03-05", "19:00"))]);
    const groupCall = messageOf("platform = 'messenger' AND type = 'call' AND call_seconds IS NULL");
    expect(() => setCallAnswered(db, { kind: "logged", id: logged }, "missed")).toThrow(/logged was answered/);
    expect(() => setCallAnswered(db, { kind: "record", id: groupCall }, "missed")).toThrow(/group chat/);
    expect(() => setCallAnswered(db, { kind: "record", id: messageOf("type = 'text'") }, "missed")).toThrow(/not a call/);
    expect(() => setCallAnswered(db, { kind: "call", id: 999_999 }, "missed")).toThrow(/no call/);
    for (const answer of [true, null, "Missed", "maybe"]) expect(() => setCallAnswered(db, { kind: "record", id: wechat }, answer)).toThrow(/answered, missed or unknown/);
    expect(listCalls(db).find((c) => c.ref.kind === "logged")).toMatchObject({ answered: true, answeredSet: false, sourceAnswered: true });
  });

  it("keeps notes out of SQL, which still reads every call", () => {
    const { logged, wechat } = sample();
    noted({ kind: "record", id: wechat }, "Planned the trip");
    noted({ kind: "logged", id: logged }, "Caught up on the week");
    const query = openForQuery(join(dataDir, "archive.sqlite"));
    try {
      expect(() => query.prepare("SELECT note FROM call_note")).toThrow();
      expect(() => query.prepare("SELECT person_id FROM manual_call WHERE note LIKE 'Caught%'")).toThrow();
      expect((query.prepare("SELECT count(*) AS n FROM person_call").get() as { n: number }).n).toBe(6);
    } finally {
      query.close();
    }
  });
});
