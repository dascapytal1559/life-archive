// friend map's rows in the core's calendar (calendarRows.ts, calendarPush.ts), and the proof the captain asked for ("the
// build must prove the calendar can be rebuilt from the modules"): a life archive with friend map loaded, built through
// the real paths (the host's imports, the rules, the changesets, an undo), pushes as it goes, and at every step a
// rebuild from the stores would change nothing (no drift), so the pushed calendar equals the rebuilt one; the core's own
// index (the agents' sessions) beside it. Then the Events pages' reads over it: the day summaries name whom he messaged,
// through the module's owner, and say what the Messages tab's person facet and daily chart say of the same days.

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addDays, answering, calendarDayOf, calendarDayStart, Effect, ForbiddenError, FRIEND_MAP, InvalidInputError, isPlatform, NotFoundError, transaction, UnavailableError, type ArchiveEvent, type CalendarRow } from "../../../sdk/server.ts";
import { CalendarPush, calendarDays, CALENDAR_FILE, CORE, coreLedger, rowText, EVENTS_DAY_BEGINS, NO_FILTERS, PROJECT, writeLlmSessionsFixture } from "../../../sdk/testing.ts";
import { sampleMessengerExport } from "../fixtures/exports.ts";
import { addSamplePeople, type SamplePerson } from "../fixtures/samplePeople.ts";
import { openTestArchive, type TestArchive } from "../testing/archive.ts";
import { everyRow } from "./calendarPush.ts";
import { DAY_KINDS, MESSAGED, MESSAGES as MESSAGES_KIND } from "./calendarRows.ts";
import { openArchive } from "./db.ts";
import { ManualCalls } from "./manualCalls.ts";
import { MESSAGES } from "./tabs/messagesTab.ts";
import { applyChats } from "./write.ts";

const SAMPLE_PEOPLE = new URL("../fixtures/data/people.json", import.meta.url);
const NOW = Date.parse("2026-10-15T10:00:00Z");
const ofKind = (rows: CalendarRow[], kind: string) => rows.filter((row) => row.kind === kind);

describe("the calendar, pushed as the archive goes and rebuilt from it", () => {
  let dir: string;
  let dataDir: string;
  let archive: TestArchive;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "life-archive-calendar-"));
    dataDir = join(dir, "data");
    archive = await openTestArchive(dataDir);
  });

  afterAll(async () => {
    archive.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** What a rebuild would change, as "<module> <kind> <id>: <change>" lines: none when the pushes have kept the calendar right. */
  const drift = () => archive.calendar.drift().map((d) => `${d.module} ${d.kind} ${d.nativeId}: ${d.change}`);
  const count = (kind: string) => (archive.calendarDb.prepare("SELECT count(*) AS n FROM event WHERE kind = ?").get(kind) as { n: number }).n;

  it("is built as the archive opens, empty, and says so", () => {
    expect(archive.calendar.isBuilt()).toBe(true);
    expect(archive.calendar.sink.count()).toBe(0);
    expect(drift()).toEqual([]);
  });

  it("follows every import through the host: messages, calls and sessions", async () => {
    await archive.host.setEnabled("messenger-export", true);
    const imported = await archive.importHistory("messenger-export", await sampleMessengerExport(dataDir));
    expect(imported.counts.messages.added).toBeGreaterThan(0);
    expect(drift()).toEqual([]);
    expect(count(MESSAGES_KIND)).toBeGreaterThan(0);
    expect(count(MESSAGED)).toBeGreaterThan(0);
    // Each day's messages are the calendar's days (from 06:00), and its people are the archive's person ids.
    const days = archive.calendarDb.prepare("SELECT day, summary ->> '$.messages' AS n FROM event WHERE kind = ? ORDER BY day").all(MESSAGES_KIND) as Array<{ day: string; n: number }>;
    const first = archive.db.prepare("SELECT min(sent_at) AS at FROM message").get() as { at: number };
    expect(days[0].day).toBe(calendarDayOf(first.at));
    expect(days.reduce((sum, day) => sum + day.n, 0)).toBe((archive.db.prepare("SELECT count(*) AS n FROM message").get() as { n: number }).n);

    const store = join(dir, "claude-projects");
    await writeLlmSessionsFixture(store);
    await archive.host.setEnabled("llm-sessions", true);
    await archive.importHistory("llm-sessions", store, { settings: { projects: [PROJECT] } });
    expect(drift()).toEqual([]);
    expect(count("llm_session")).toBe(2);
    expect(count("llm_prompt")).toBe(5);
  });

  it("follows the people's edits: names, a hangout, a logged call, a merge and its undo, each a changeset", async () => {
    archive.changes.record({ surface: "cli", action: "name the sample people" }, () => addSamplePeople(archive, JSON.parse(readFileSync(SAMPLE_PEOPLE, "utf8")) as SamplePerson[]));
    expect(drift()).toEqual([]);
    const people = archive.structure.listPeople().people.filter((p) => p.name).sort((a, b) => a.id - b.id);
    expect(people.length).toBeGreaterThan(2);
    [ids.a, ids.b] = [people[0].id, people[1].id];

    const hangout = archive.changes.record({ surface: "app", action: "hangout" }, () => archive.people.addCatchUp({ day: "2026-03-07", time: "18:30", hours: 2, personIds: [ids.a, ids.b], others: 1 }));
    expect(hangout.changeset).not.toBeNull();
    expect(drift()).toEqual([]);
    const made = ofKind(archive.calendar.sink.rowsOf(FRIEND_MAP), "hangout");
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ nativeId: String(hangout.value), people: [ids.a, ids.b].sort((x, y) => x - y), hasContent: false, facts: { hours: 2, others: 1, size: 3 } });

    const calls = new ManualCalls(archive.db);
    archive.changes.record({ surface: "app", action: "log a call" }, () => calls.insert({ people: [{ personId: ids.a, accountId: null, app: "discord" }], day: "2026-04-05", time: "20:00", minutes: 30, note: "" }));
    expect(drift()).toEqual([]);
    expect(ofKind(archive.calendar.sink.rowsOf(FRIEND_MAP), "call").map((row) => row.facts.from)).toContain("logged");

    // A name that is only a number makes the calls with that person unknown's: friend map's rows are pushed again after the edit.
    archive.changes.record({ surface: "app", action: "rename" }, () => archive.people.setName(ids.a, "+61 491 570 006"));
    expect(drift()).toEqual([]);
    expect(ofKind(archive.calendar.sink.rowsOf(FRIEND_MAP), "call").find((row) => row.facts.from === "logged")?.facts.caller).toBe("unknown");

    // A merge moves everyone's messages and calls to one person; the day summaries follow, and so does the undo.
    const before = ofKind(archive.calendar.sink.rowsOf(FRIEND_MAP), MESSAGED).map(rowText);
    const merge = archive.changes.record({ surface: "app", action: "merge" }, () => archive.people.merge(ids.b, ids.a));
    expect(merge.changeset).not.toBeNull();
    expect(drift()).toEqual([]);
    expect(ofKind(archive.calendar.sink.rowsOf(FRIEND_MAP), MESSAGED).some((row) => row.people[0] === ids.a)).toBe(false);
    archive.changes.undo(merge.changeset!, { surface: "app" });
    expect(drift()).toEqual([]);
    expect(ofKind(archive.calendar.sink.rowsOf(FRIEND_MAP), MESSAGED).map(rowText)).toEqual(before);
  });

  it("follows the tables' edits (server/edits/), each a changeset: a hangout's time, hours, people and note, a logged call's, and their undos", async () => {
    const edits = archive.life.edits();
    const source = { surface: "app", who: null, why: null } as const;
    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
    const refusal = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(answering(ForbiddenError, InvalidInputError, NotFoundError, UnavailableError), Effect.flip));
    const idOf = (kind: string, like: string) => String((archive.calendarDb.prepare("SELECT id FROM event WHERE kind = ? AND native_id LIKE ? ORDER BY id LIMIT 1").get(kind, like) as { id: number }).id);
    const rowOf = (id: string) => archive.calendarDb.prepare("SELECT native_id, at, people, facts, has_content FROM event WHERE id = ?").get(Number(id)) as { native_id: string; at: number; people: string; facts: string; has_content: number };

    const hangout = idOf("hangout", "%");
    await run(edits.edit("hangouts", hangout, "when", "2026-03-07T20:00", source));
    const hours = await run(edits.edit("hangouts", hangout, "hours", 3, source));
    await run(edits.edit("hangouts", hangout, "with", [ids.a], source));
    await run(edits.edit("hangouts", hangout, "note", "Dinner at the made-up place", source));
    expect(edits.state("hangouts", hangout).fields).toMatchObject({ when: { value: "2026-03-07T20:00" }, hours: { value: 3 }, with: { value: [ids.a] }, note: { value: null, has: true } });
    expect(rowOf(hangout)).toMatchObject({ people: JSON.stringify([ids.a]), has_content: 1 });
    expect(JSON.parse(rowOf(hangout).facts)).toMatchObject({ hours: 3, time: "20:00" });
    expect(archive.changes.list({ limit: 4 }).map((c) => c.action)).toEqual(["hangouts note", "hangouts with", "hangouts hours", "hangouts when"]);
    expect(drift()).toEqual([]);
    await run(edits.undo(hours.edit!, source));
    expect(JSON.parse(rowOf(hangout).facts)).toMatchObject({ hours: 2 });
    expect(drift()).toEqual([]);

    const logged = idOf("call", "logged:%");
    await run(edits.edit("calls", logged, "length", 45, source));
    const people = await run(edits.edit("calls", logged, "with", [ids.a, ids.b], source));
    expect(JSON.parse(rowOf(people.id).people).sort()).toEqual([ids.a, ids.b].sort());
    expect(JSON.parse(rowOf(people.id).facts)).toMatchObject({ seconds: 45 * 60 });
    expect(drift()).toEqual([]);
    const back = await run(edits.undo(people.edit!, source));
    expect(JSON.parse(rowOf(back.id).people)).toEqual([ids.a]);
    expect(edits.list({ kind: "calls", limit: 1 })[0]).toMatchObject({ undoes: people.edit, label: "With" });
    expect(drift()).toEqual([]);

    // Messages are only read.
    expect(await refusal(edits.edit("messages", logged, "when", "2026-03-07T20:00", source))).toBeInstanceOf(ForbiddenError);
    expect(drift()).toEqual([]);
  });

  it("counts the messages again only when who is whom changed, and pushes nothing at an edit friend map does not read", () => {
    const replace = vi.spyOn(archive.calendar.sink, "replace");
    /** The kinds pushed since it was last asked. */
    const pushed = () => {
      const kinds = replace.mock.calls.flatMap(([, , scope]) => scope?.kinds ?? []);
      replace.mockClear();
      return kinds;
    };
    try {
      archive.changes.record({ surface: "app", action: "tag" }, () => archive.people.setTags(ids.a, ["made-up"]));
      expect(pushed()).toEqual([]);
      archive.changes.record({ surface: "app", action: "rename" }, () => archive.people.setName(ids.a, "+61 491 570 110"));
      expect(pushed()).toEqual(["call", "hangout"]);
      expect(drift()).toEqual([]);
      // A name given beside a changeset reaches the calls at the next rules run, with the messages left alone.
      archive.people.setName(ids.a, "+61 491 570 006");
      archive.runRules();
      expect(pushed()).toEqual(["call", "hangout"]);
      expect(drift()).toEqual([]);
      archive.runRules({ onlyMessages: true });
      expect(pushed()).toEqual([]);
      // A merge changes who is whom, so the messages are counted again; its undo too.
      const merge = archive.changes.record({ surface: "app", action: "merge" }, () => archive.people.merge(ids.b, ids.a));
      expect(pushed()).toEqual(["call", "hangout", ...DAY_KINDS]);
      archive.changes.undo(merge.changeset!, { surface: "app" });
      expect(pushed()).toEqual(["call", "hangout", ...DAY_KINDS]);
      expect(drift()).toEqual([]);
    } finally {
      replace.mockRestore();
    }
  });

  it("is what a rebuild makes, row for row, and a rebuild changes nothing", () => {
    const pushed = archive.calendar.sink.modules().flatMap((module) => archive.calendar.sink.rowsOf(module).map(rowText)).sort();
    const counts = archive.calendar.rebuild();
    expect(Object.values(counts).every((c) => c.added === 0 && c.updated === 0 && c.forgotten === 0)).toBe(true);
    const rebuilt = archive.calendar.sink.modules().flatMap((module) => archive.calendar.sink.rowsOf(module).map(rowText)).sort();
    expect(rebuilt).toEqual(pushed);
    expect(archive.calendar.sink.modules()).toEqual([CORE, FRIEND_MAP]);
    expect(archive.calendar.builtAt()).not.toBeNull();
  });

  it("holds the calendar from its read of the archive to its last write, so a push from the server waits rather than being undone", () => {
    const server = new DatabaseSync(join(dataDir, CALENDAR_FILE), { timeout: 0 });
    const read = archive.calendar.expected.bind(archive.calendar);
    const expected = vi.spyOn(archive.calendar, "expected").mockImplementationOnce(() => {
      expect(() => server.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
      return read();
    });
    try {
      archive.calendar.rebuild();
      expect(expected).toHaveBeenCalledOnce();
      server.exec("BEGIN IMMEDIATE; ROLLBACK");
    } finally {
      expected.mockRestore();
      server.close();
    }
  });

  it("is rebuilt whole after data went in beside the host, and forgets what the archive no longer has", () => {
    // A session written beside the host (through the writer alone, as a fixture might) is missing until a rebuild.
    transaction(archive.coreDb, () => {
      const source = Number(archive.coreDb.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('claude-code', 'llm-sessions', 'export', 'beside', 0, 'ok')").run().lastInsertRowid);
      coreLedger(archive.coreDb).apply([{
        kind: "llm-session", id: "beside", entrypoint: "cli", project: PROJECT, file: join(dir, "beside.jsonl"), startedAt: NOW, endedAt: NOW + 60_000, bytes: 10,
      }], { id: source, platform: "claude-code", kind: "export", seenAt: 0, folder: dataDir });
    });
    expect(drift().some((line) => line.startsWith(`${CORE} llm_session beside`) && line.endsWith("missing"))).toBe(true);
    archive.calendar.rebuild();
    expect(drift()).toEqual([]);
    expect(count("llm_session")).toBe(3);
    // A row the archive no longer has (here, one taken out behind the calendar's back) is extra until a rebuild forgets it.
    archive.db.prepare("DELETE FROM catch_up_person WHERE catch_up_id = ?").run(Number(ofKind(archive.calendar.sink.rowsOf(FRIEND_MAP), "hangout")[0].nativeId));
    archive.db.prepare("DELETE FROM catch_up").run();
    expect(drift()).toEqual([expect.stringMatching(/^friend-map hangout \d+: extra$/)]);
    expect(archive.calendar.rebuild()[FRIEND_MAP]).toMatchObject({ forgotten: 1 });
    expect(drift()).toEqual([]);
  });

  it("leaves a module switched off alone: its rows stay, neither drift nor a rebuild's to change, until it is on again", () => {
    const own: CalendarRow = {
      module: "sample", origin: "made-up", nativeId: "w1", shape: "moment", kind: "workout", subkind: "run", at: NOW, atEnd: NOW + 1_000, day: "2026-10-15", self: true,
      direction: null, size: null, hasContent: false, people: [], facts: {}, summary: null,
    };
    archive.calendar.sink.push("sample", [own]);
    // Known and off: left as it is. Unknown (no module of that id at all): extra, as any row is.
    const off = new CalendarPush(archive.coreDb, archive.calendarDb, archive.events, new Map([[FRIEND_MAP, () => everyRow(archive.db)]]), new Set(["sample"]));
    expect(off.drift()).toEqual([]);
    off.rebuild();
    expect(off.sink.rowsOf("sample").map((r) => r.nativeId)).toEqual(["w1"]);
    expect(drift()).toEqual([expect.stringMatching(/^sample workout w1: extra$/)]);
    archive.calendar.rebuild();
    expect(archive.calendar.sink.rowsOf("sample").map((r) => r.nativeId)).toEqual(["w1"]);
    archive.calendar.sink.replace("sample", []);
    expect(drift()).toEqual([]);
  });

  it("answers the Events pages' day summaries from the calendar alone, naming whom he messaged through the owner", () => {
    const reads = archive.reads();
    {
      const { first, last } = archive.calendarDb.prepare("SELECT min(day) AS first, max(day) AS last FROM event WHERE kind = ?").get(MESSAGES_KIND) as { first: string; last: string };
      const answer = calendarDays(reads, { from: first, to: addDays(last, 1), person: null });
      // A day each with any messages (days with only rituals or prompts are listed too, with none).
      expect(answer.days.filter((day) => day.messages > 0).length).toBe(count(MESSAGES_KIND));
      const busy = answer.days.find((day) => day.messaged.length > 0)!;
      expect(busy.messages).toBeGreaterThan(0);
      expect(busy.messaged[0].count).toBeGreaterThanOrEqual(busy.messaged.at(-1)!.count);
      for (const who of busy.messaged) expect(answer.people[who.id]).toMatch(/\S/);
      // With a person, each day's messages are those with them, and nothing else is said.
      const who = busy.messaged[0].id;
      const theirs = calendarDays(reads, { from: first, to: addDays(last, 1), person: who });
      expect(theirs.days.find((day) => day.day === busy.day)).toEqual({ day: busy.day, messages: busy.messaged[0].count, messaged: [], agentMessages: 0, rituals: null });
      expect(theirs.people).toEqual({});
      // The agents' prompts are counted on the calendar's days.
      const prompts = calendarDays(reads, { from: "2026-03-01", to: "2026-03-03", person: null });
      // Four before 06:00 on the 2nd, two of them past midnight, are the 1st's; the 08:00 prompt is the 2nd's.
      expect(Object.fromEntries(prompts.days.map((day) => [day.day, day.agentMessages]))).toEqual({ "2026-03-01": 4, "2026-03-02": 1 });
      expect(calendarDays(reads, { from: "2026-03-01", to: "2026-03-02", person: null }).days[0]?.day).toBe("2026-03-01");
    }
  });

  it("says of each day what the Messages tab says: its person facet, its daily chart, and the messages themselves", () => {
    const reads = archive.reads();
    {
      const { first, last } = archive.calendarDb.prepare("SELECT min(day) AS first, max(day) AS last FROM event WHERE kind = ?").get(MESSAGES_KIND) as { first: string; last: string };
      const days = calendarDays(reads, { from: first, to: addDays(last, 1), person: null }).days.filter((day) => day.messages > 0);
      expect(days.length).toBeGreaterThan(0);
      const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;

      const chart = MESSAGES.volume(reads, { ...NO_FILTERS, from: calendarDayStart(first), to: calendarDayStart(addDays(last, 1)) }, { grain: "day", measure: "messages", split: null, begins: EVENTS_DAY_BEGINS });
      expect(Object.fromEntries(days.map((day) => [day.day, day.messages]))).toEqual(Object.fromEntries(chart.buckets.filter((bucket) => bucket.value > 0).map((bucket) => [bucket.day, bucket.value])));

      const theirMessages = archive.db.prepare(
        `SELECT count(*) AS n FROM message m LEFT JOIN import_person sender ON sender.id = m.sender_account_id
         WHERE m.sent_at >= ? AND m.sent_at < ? AND (sender.person_id = ? OR m.conversation_id IN (
           SELECT cm.conversation_id FROM conversation_member cm JOIN conversation c ON c.id = cm.conversation_id JOIN import_person a ON a.id = cm.account_id
           WHERE c.type = 'direct' AND a.person_id = ?))`,
      );
      for (const day of days) {
        const [from, to] = [calendarDayStart(day.day), calendarDayStart(addDays(day.day, 1))];
        const facet = MESSAGES.facets(reads, { ...NO_FILTERS, from, to }).person.map((value) => ({ id: Number(value.value), count: value.count }));
        expect(day.messaged.toSorted(byId)).toEqual(facet.toSorted(byId));
        for (const who of day.messaged) expect(who.count).toBe((theirMessages.get(from, to, who.id, who.id) as { n: number }).n);
      }
    }
  });
});

describe("the calendar after an import changes what an earlier one brought", () => {
  const AT = Date.parse("2026-03-06T08:00:00Z");
  let dir: string;
  let archive: TestArchive;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "life-archive-calendar-later-"));
    archive = await openTestArchive(dir);
  });

  afterAll(async () => {
    archive.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** One import of `events` on `platform`, pushed as the host pushes it once its transaction has committed. */
  function imported(platform: string, events: ArchiveEvent[]): void {
    const chats = isPlatform(platform);
    const db = chats ? archive.db : archive.coreDb;
    const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'made-up', 'export', 'made up', 0, 'ok')").run(platform).lastInsertRowid);
    const source_ = { id: source, platform, kind: "export" as const, seenAt: 0, folder: dir };
    const applied = chats
      ? transaction(db, () => applyChats(events, db, source_, (touched) => archive.push.afterChats(touched)))
      : transaction(db, () => coreLedger(db, (ids) => archive.calendar.afterIndex(ids)).apply(events, source_));
    applied.afterCommit?.();
  }

  const session = (id: string, model?: string): ArchiveEvent => ({
    kind: "llm-session", id, entrypoint: "cli", project: PROJECT, file: join(dir, `${id}.jsonl`), startedAt: AT, endedAt: AT + 60_000, bytes: 100, ...(model ? { model } : {}),
  });
  const prompt = (id: string, of: string, at: number, model?: string): ArchiveEvent => ({
    kind: "llm-turn", id, session: of, role: "prompt", at, chars: 10, line: 1, offset: 0, length: 10, ...(model ? { model } : {}),
  });
  const row = (nativeId: string) => archive.calendar.sink.rowsOf(CORE).find((r) => r.nativeId === nativeId)!;

  it("gives a turn with no model of its own the one its session comes to have", () => {
    imported("claude-code", [session("s1"), prompt("p1", "s1", AT)]);
    expect(row("p1").facts.model).toBe("");
    imported("claude-code", [session("s1", "made-up-model"), prompt("p1", "s1", AT), prompt("p2", "s1", AT + 1_000, "made-up-model")]);
    expect(row("p1").facts.model).toBe("made-up-model");
    expect(archive.calendar.drift()).toEqual([]);
  });

  it("gives a session with no turns no characters, and one with turns theirs", () => {
    imported("claude-code", [session("s2")]);
    expect(row("s2").facts.chars).toBeNull();
    expect(row("s1").facts.chars).toBe(20);
  });

  it("follows the length a call record gives a call kept in no chat", () => {
    const call: ArchiveEvent = { kind: "call", id: "W1", with: "Ada Sample", alsoWith: ["Bruno Example"], at: AT, direction: "incoming", answered: true, service: "video", raw: {} };
    const account = (key: string): ArchiveEvent => ({ kind: "account", key, keyKind: "name", displayName: key });
    imported("whatsapp", [account("Ada Sample"), account("Bruno Example"), call]);
    archive.runRules();
    const seconds = () => ofKind(archive.calendar.sink.rowsOf(FRIEND_MAP), "call").map((r) => r.facts.seconds);
    expect(seconds()).toEqual([null]);
    imported("whatsapp", [
      { kind: "conversation", id: "chat", type: "direct", members: ["Ada Sample"] },
      { kind: "message", id: "W1", idKind: "platform", conversation: "chat", sender: "Ada Sample", isFromSelf: false, sentAt: AT, type: "call", callSeconds: 120, raw: {} },
    ]);
    expect(seconds()).toEqual([120]);
    expect(archive.calendar.drift()).toEqual([]);
  });

  it("keeps an imported call's time and people its source's, and his note on it beside the import, through a re-import and its undo", async () => {
    const edits = archive.life.edits();
    const source = { surface: "app", who: null, why: null } as const;
    const refusal = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(answering(ForbiddenError, InvalidInputError, NotFoundError, UnavailableError), Effect.flip));
    const call = String((archive.calendarDb.prepare("SELECT id FROM event WHERE kind = 'call' ORDER BY id LIMIT 1").get() as { id: number }).id);
    const state = edits.state("calls", call).fields;
    expect(state.when).toMatchObject({ locked: expect.stringContaining("source") });
    expect(state.with).toMatchObject({ locked: expect.stringContaining("People") });
    expect(await refusal(edits.edit("calls", call, "when", "2026-03-06T19:00", source))).toBeInstanceOf(ForbiddenError);
    expect(await refusal(edits.edit("calls", call, "with", [1], source))).toBeInstanceOf(ForbiddenError);
    const noted = await Effect.runPromise(edits.edit("calls", call, "note", "They called back later", source));
    expect(noted.state!.fields.note).toEqual({ value: null, has: true });
    // The same call imported again leaves his note where it is.
    imported("whatsapp", [{ kind: "call", id: "W1", with: "Ada Sample", alsoWith: ["Bruno Example"], at: AT, direction: "incoming", answered: true, service: "video", raw: {} }]);
    expect(edits.note("calls", call, "note")).toBe("They called back later");
    expect(archive.calendar.drift()).toEqual([]);
    await Effect.runPromise(edits.undo(noted.edit!, source));
    expect(edits.state("calls", call).fields.note).toEqual({ value: null, has: false });
    expect(archive.calendar.drift()).toEqual([]);
  });

  it("keeps a call's people in the order the call gives them", () => {
    const [first, second] = [archive.people.create("Cleo Demo"), archive.people.create("Dana Sample")];
    archive.changes.record({ surface: "app", action: "log a call" }, () =>
      new ManualCalls(archive.db).insert({ people: [{ personId: second, accountId: null, app: "discord" }, { personId: first, accountId: null, app: "discord" }], day: "2026-04-05", time: "20:00", minutes: 30, note: "" }));
    expect(ofKind(archive.calendar.sink.rowsOf(FRIEND_MAP), "call").find((r) => r.facts.from === "logged")?.people).toEqual([second, first]);
    expect(archive.calendar.drift()).toEqual([]);
  });

  it("says a hangout has a note, and never says the note", () => {
    const person = archive.people.create("Cleo Demo");
    const noted = archive.changes.record({ surface: "app", action: "hangout" }, () => archive.people.addCatchUp({ day: "2026-03-07", hours: 2, personIds: [person], note: "made-up words of a hangout" }));
    const plain = archive.changes.record({ surface: "app", action: "hangout" }, () => archive.people.addCatchUp({ day: "2026-03-08", hours: 1, personIds: [person], others: 2 }));
    const hangouts = new Map(ofKind(archive.calendar.sink.rowsOf(FRIEND_MAP), "hangout").map((row) => [row.nativeId, row]));
    expect(hangouts.get(String(noted.value))).toMatchObject({ hasContent: true, people: [person], facts: { size: 1 } });
    expect(hangouts.get(String(plain.value))).toMatchObject({ hasContent: false, facts: { size: 3 } });
    expect(rowText(hangouts.get(String(noted.value))!)).not.toContain("made-up words");
  });

  it("pushes a change to who is whom that came after a rebuild had read the archive", () => {
    imported("whatsapp", [
      { kind: "conversation", id: "bruno", type: "direct", members: ["Bruno Example"] },
      { kind: "message", id: "m1", idKind: "platform", conversation: "bruno", sender: "Bruno Example", isFromSelf: false, sentAt: AT, type: "text", text: "made-up words", raw: {} },
    ]);
    archive.runRules();
    const personOf = (key: string) => (archive.db.prepare("SELECT person_id FROM import_person WHERE key = ?").get(key) as { person_id: number }).person_id;
    const [ada, bruno] = [personOf("Ada Sample"), personOf("Bruno Example")];
    const read = archive.calendar.expected.bind(archive.calendar);
    const expected = vi.spyOn(archive.calendar, "expected").mockImplementationOnce(() => {
      const rows = read();
      archive.people.merge(ada, bruno);
      return rows;
    });
    try {
      archive.calendar.rebuild();
    } finally {
      expected.mockRestore();
    }
    archive.push.afterPeople();
    expect(ofKind(archive.calendar.sink.rowsOf(FRIEND_MAP), MESSAGED).map((row) => row.people)).toEqual([[ada]]);
    expect(archive.calendar.drift()).toEqual([]);
  });
});
