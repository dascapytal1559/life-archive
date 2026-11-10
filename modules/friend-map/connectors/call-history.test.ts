import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTotals, type ConnectorEvent } from "../../../sdk/server.ts";
import { sqlQuerySync } from "../server/sqlQuery.ts";
import { CALL_PEOPLE, writeCallHistoryFixture } from "../fixtures/call-history.ts";
import { IM_PEOPLE, writeMessagesFixture } from "../fixtures/imessage.ts";
import { writeAddressBookFixture } from "../fixtures/whatsapp.ts";
import { keyOf, readCallHistory } from "./call-history/read.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-calls-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The call history where the captain keeps it, in the data folder the archive tests open (dir/data). */
const callsFolder = (copy: "first" | "later" = "first") =>
  join(dir, "data", "platform-exports", "calls", copy === "first" ? "2026-03-15" : "2026-03-22");

async function read(source: string, config: Record<string, unknown> = {}) {
  const events: ConnectorEvent[] = [];
  await readCallHistory({ sources: [source], config, mediaDir: join(dir, "media"), emit: async (event) => void events.push(event) });
  const of = <K extends ConnectorEvent["kind"]>(kind: K) => events.filter((e): e is Extract<ConnectorEvent, { kind: K }> => e.kind === kind);
  return { events, of, tallies: Object.fromEntries(of("tally").map((t) => [t.name, t.count])) };
}

describe("call-history", () => {
  it("keys the other party as imessage-db keys a handle, and names them by the call history, the address book or the handle", async () => {
    const folder = callsFolder();
    await writeCallHistoryFixture(folder);
    const plain = await read(folder);
    expect(Object.fromEntries(plain.of("account").map(({ key, displayName, nameSource, handle }) => [key, { displayName, nameSource, handle }]))).toEqual({
      [IM_PEOPLE.ada]: { displayName: IM_PEOPLE.ada, nameSource: "phone", handle: IM_PEOPLE.ada },
      [IM_PEOPLE.adaEmail]: { displayName: IM_PEOPLE.adaEmail, nameSource: "email", handle: IM_PEOPLE.adaEmail },
      // Written "0491 571 491" and never normalised by the phone: read as an Australian number.
      [IM_PEOPLE.bruno]: { displayName: IM_PEOPLE.bruno, nameSource: "phone", handle: IM_PEOPLE.bruno },
      [CALL_PEOPLE.plumber]: { displayName: "Pat the Plumber", nameSource: "call", handle: CALL_PEOPLE.plumber },
      [CALL_PEOPLE.stranger]: { displayName: CALL_PEOPLE.stranger, nameSource: "phone", handle: CALL_PEOPLE.stranger },
      [CALL_PEOPLE.shortCode]: { displayName: CALL_PEOPLE.shortCode, nameSource: "handle", handle: undefined },
    });
    // With the address book beside it, numbers are named from it.
    writeAddressBookFixture(join(folder, "AddressBook.sqlitedb"));
    const named = await read(folder);
    expect(named.of("account").find((a) => a.key === IM_PEOPLE.ada)).toMatchObject({ displayName: "Ada Sample", nameSource: "addressBook" });
    expect(named.of("account").find((a) => a.key === CALL_PEOPLE.plumber)).toMatchObject({ displayName: "Pat the Plumber", nameSource: "call" });
  });

  it("makes each call one record with when, how long, which way, whether answered and over what, leaving out what it cannot keep", async () => {
    const folder = callsFolder();
    await writeCallHistoryFixture(folder);
    const { of, tallies } = await read(folder);
    expect(of("call").map(({ id, with: other, durationSeconds, direction, answered, service }) => [id, other, durationSeconds, direction, answered, service])).toEqual([
      ["A1", IM_PEOPLE.ada, 1830, "incoming", true, "phone"],
      // Outgoing calls never have ZANSWERED: connected is answered.
      ["A2", IM_PEOPLE.ada, 96, "outgoing", true, "phone"],
      ["A3", IM_PEOPLE.ada, 0, "incoming", false, "phone"],
      ["A4", IM_PEOPLE.adaEmail, 600, "outgoing", true, "facetime-audio"],
      ["B1", IM_PEOPLE.bruno, 0, "outgoing", false, "phone"],
      ["B2", IM_PEOPLE.bruno, 300, "incoming", true, "facetime-video"],
      ["P1", CALL_PEOPLE.plumber, 120, "outgoing", true, "phone"],
      ["S1", CALL_PEOPLE.stranger, 0, "incoming", false, "phone"],
      ["C1", CALL_PEOPLE.shortCode, 45, "outgoing", true, "phone"],
    ]);
    expect(of("call")[0].at).toBe(Date.parse("2026-03-01T19:00:00+11:00"));
    // The original record, without its binary fields.
    expect(of("call")[0].raw).toMatchObject({ ZUNIQUE_ID: "A1", ZADDRESS: "0491 571 266" });
    expect(of("call")[0].raw).not.toHaveProperty("ZLOCALPARTICIPANTUUID");
    expect(tallies).toMatchObject({
      "calls from a withheld or unknown number, left out": 1,
      "calls through another app (net.whatsapp.WhatsApp), left out": 1,
      "group calls, left out": 1,
      "phone calls, answered": 4,
      "phone calls, not answered": 3,
      "facetime-audio calls, answered": 1,
      "facetime-video calls, answered": 1,
    });
    expect(of("coverage")).toEqual([{ kind: "coverage", from: Date.parse("2026-03-01T19:00:00+11:00"), to: Date.parse("2026-03-09T09:00:00+11:00") }]);
  });

  it("reads the database itself or the folder holding it, and refuses anything else", async () => {
    const path = await writeCallHistoryFixture(callsFolder());
    expect((await read(path)).of("call")).toHaveLength(9);
    await mkdir(join(dir, "empty"));
    await expect(read(join(dir, "empty"))).rejects.toThrow("there is no CallHistory.storedata in");
    await writeMessagesFixture(join(dir, "messages"));
    await expect(read(join(dir, "messages", "Library", "SMS", "sms.db"))).rejects.toThrow("has no ZCALLRECORD table");
  });

  it("keys a party by the phone's normalised number, else what was written", () => {
    expect(keyOf({ value: "0491 571 266", normalized: "+61491571266" }, "0491 571 266")).toBe("+61491571266");
    expect(keyOf({ value: "0491 571 266", normalized: null }, "")).toBe("+61491571266");
    expect(keyOf(undefined, "Ada@Example.com")).toBe("ada@example.com");
    expect(keyOf(undefined, "131313")).toBe("131313");
    expect(keyOf(undefined, "")).toBeNull();
  });
});

describe("call-history through the archive", () => {
  let archive: TestArchive;

  beforeEach(async () => {
    const dataDir = join(dir, "data");
    await mkdir(join(dataDir, "friends"), { recursive: true });
    archive = await openTestArchive(dataDir);
    await archive.host.setEnabled("imessage-db", true);
    await archive.host.setEnabled("call-history", true);
  });

  afterEach(() => archive.close());

  const importMessages = async () => {
    const folder = join(dir, "data", "platform-exports", "imessage", "2026-09-28");
    await writeMessagesFixture(folder);
    writeAddressBookFixture(join(folder, "AddressBook.sqlitedb"));
    await archive.importHistory("imessage-db", folder);
  };
  const importCalls = async (copy: "first" | "later" = "first") => {
    const folder = callsFolder(copy);
    await writeCallHistoryFixture(folder, { copy });
    return archive.importHistory("call-history", folder);
  };
  const person = (name: string) => archive.structure.listPeople().people.find((p) => p.name === name)!;
  const callIds = (personId: number) => archive.structure.calls(personId)!.map((call) => archive.db.prepare("SELECT platform_call_id AS id FROM call WHERE id = ?").get(call.id) as { id: string }).map((row) => row.id);

  it("puts a number's calls on the person who holds it in iMessage, with no proposal, and keeps the rest apart", async () => {
    await importMessages();
    const result = await importCalls();
    expect(result.counts.calls).toEqual({ added: 9, updated: 0, unchanged: 0 });
    expect(result.counts.messages.added).toBe(0);

    const ada = person("Ada Sample");
    // Her number and her Apple ID, newest first.
    expect(callIds(ada.id)).toEqual(["A4", "A3", "A2", "A1"]);
    expect(ada.accounts.filter((a) => a.platform === "phone").map((a) => [a.displayName, a.link])).toEqual([
      [IM_PEOPLE.ada, "rule:same-number"], [IM_PEOPLE.adaEmail, "rule:same-number"],
    ]);
    expect(callIds(person("Bruno Placeholder").id)).toEqual(["B2", "B1"]);
    // Calls are not messages.
    expect(ada.messageCount).toBe(person("Ada Sample").messageCount);
    expect(archive.structure.listPeople().people.find((p) => p.name === "Ada Sample")!.directMessageCount).toBeGreaterThan(0);

    // A number nobody holds in iMessage is a person of its own, named by the call history, archived with no messages.
    const plumber = person("Pat the Plumber");
    expect(plumber.accounts.map((a) => [a.platform, a.link])).toEqual([["phone", "import"]]);
    expect(plumber.archived).toBe("no-messages");
    expect(callIds(plumber.id)).toEqual(["P1"]);
    // No proposal for a number someone holds in iMessage: the call is theirs already.
    expect(archive.people.proposalGroups().filter((p) => p.evidence.some((e) => e.detail === IM_PEOPLE.ada))).toEqual([]);
  });

  it("adds only the new calls from a newer copy, and brings a changed one up to date", async () => {
    await importMessages();
    await importCalls();
    expect((await importCalls()).counts.calls).toEqual({ added: 0, updated: 0, unchanged: 9 });
    const later = await importCalls("later");
    expect(later.counts.calls).toEqual({ added: 2, updated: 1, unchanged: 8 });
    expect(archive.structure.calls(person("Ada Sample").id)!.map((call) => call.durationSeconds)).toEqual([2400, 600, 0, 125, 1830]);
  });

  it("moves calls imported first onto whoever later turns out to hold the number in iMessage", async () => {
    await importCalls();
    const before = archive.structure.listPeople().people.filter((p) => p.accounts.some((a) => a.platform === "phone")).length;
    expect(before).toBe(6);
    await importMessages();
    expect(callIds(person("Ada Sample").id)).toEqual(["A4", "A3", "A2", "A1"]);
    // The people the import made for her number and Apple ID are gone.
    expect(archive.structure.listPeople().people.filter((p) => p.name === IM_PEOPLE.ada || p.name === IM_PEOPLE.adaEmail)).toEqual([]);
  });

  it("lets the calls follow the number when it is split off, and never moves a call account the captain placed", async () => {
    await importMessages();
    await importCalls();
    const ada = person("Ada Sample");
    const imessage = ada.accounts.find((a) => a.platform === "imessage" && a.displayName === "Ada Sample" && a.handle === IM_PEOPLE.ada)!;
    // "Not them" on her iMessage number: its calls go with it.
    archive.people.detach(ada.id, imessage.id);
    archive.people.runRules();
    const split = archive.structure.listPeople().people.find((p) => p.id !== ada.id && p.accounts.some((a) => a.id === imessage.id))!;
    expect(callIds(split.id)).toEqual(["A3", "A2", "A1"]);
    expect(callIds(ada.id)).toEqual(["A4"]);

    // "Not them" on the call account itself: it stays where the captain put it.
    const facetime = archive.structure.getPerson(ada.id)!.accounts.find((a) => a.platform === "phone")!;
    archive.people.detach(ada.id, facetime.id);
    archive.people.runRules();
    expect(callIds(ada.id)).toEqual([]);
    expect(archive.structure.getPerson(ada.id)!.accounts.map((a) => a.platform)).toEqual(["imessage"]);
  });

  it("gives the map's report each person's answered call time per Melbourne day", async () => {
    await importMessages();
    await importCalls();
    const ada = person("Ada Sample").id;
    const bruno = person("Bruno Placeholder").id;
    const plumber = person("Pat the Plumber").id;
    const days = archive.structure.relationships().callDays;
    expect(days).toEqual([
      { personId: ada, day: "2026-03-01", seconds: 1830 },
      { personId: ada, day: "2026-03-02", seconds: 96 },
      { personId: ada, day: "2026-03-04", seconds: 600 },
      { personId: bruno, day: "2026-03-06", seconds: 300 },
      { personId: plumber, day: "2026-03-07", seconds: 120 },
      { personId: person(CALL_PEOPLE.shortCode).id, day: "2026-03-09", seconds: 45 },
    ]);
  });

  it("adds up each person's calls for the Table: answered, not answered, time connected, the last call", async () => {
    await importMessages();
    await importCalls();
    const rows = archive.structure.tableRows();
    for (const name of ["Ada Sample", "Bruno Placeholder", "Pat the Plumber"]) {
      const id = person(name).id;
      const calls = archive.structure.calls(id)!;
      const { answered, seconds, unanswered } = callTotals(calls);
      expect(rows.find((row) => row.id === id)!.calls).toEqual({ answered, unanswered, seconds, lastCallAt: calls[0].at });
    }
    expect(rows.find((row) => row.id === person("Ada Sample").id)!.calls).toMatchObject({ answered: 3, seconds: 2526 });
    // Nobody without calls has any.
    const called = new Set(archive.db.prepare("SELECT DISTINCT a.person_id AS id FROM call c JOIN import_person a ON a.id = c.import_person_id").all().map((row) => (row as { id: number }).id));
    expect(rows.filter((row) => !called.has(row.id)).every((row) => row.calls === null)).toBe(true);
  });

  it("answers SQL over person_call: whom the captain talked with for ten minutes or more, and who missed him", async () => {
    await importMessages();
    await importCalls();
    const names = (sql: string) => sqlQuerySync(archive.db, sql).map((id) => archive.structure.getPerson(id)!.name).sort();
    expect(names("SELECT person_id FROM person_call WHERE answered GROUP BY person_id HAVING sum(duration_seconds) >= 600")).toEqual(["Ada Sample"]);
    expect(names("SELECT DISTINCT person_id FROM person_call WHERE service = 'facetime-video'")).toEqual(["Bruno Placeholder"]);
    expect(names("SELECT DISTINCT person_id FROM person_call WHERE NOT answered AND direction = 'incoming' AND day >= '2026-03'")).toEqual([CALL_PEOPLE.stranger, "Ada Sample"]);
  });
});
