// The viewer's routes (http.ts) over a made-up archive, through the archive's server's door (archive/server.ts): each
// call once, its filters, chart and facets, the answers to what it cannot read, and that it never reads or sends
// content, through the read-only connection the server gives it.

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ArchiveEvent, dayStart, type Db, type FacetsAnswer, isPlatform, type KindsAnswer, LOCALE, type RowDetail, type RowsAnswer, sendJson, sourceTab, TIME_ZONE, transaction, type VolumeAnswer, wallClock } from "../../../sdk/server.ts";
import { archiveServer, CORE_FILE, type CalendarDaysAnswer, type LlmTurnEvent, coreLedger, facetsOf, moduleTabs, NO_FILTERS, NO_LLM_CONTEXT, openCore, retagLlm, rowsOf, setClock, tabsWith, volumeOf, type Modules } from "../../../sdk/testing.ts";
import { friendMapReads, type TestReads } from "../testing/reads.ts";
import { archiveOf } from "./tabs/reads.ts";
import { viewerHandler } from "../testing/routes.ts";
import { setCallNote } from "./calls.ts";
import { openArchive } from "./db.ts";
import { ManualCalls } from "./manualCalls.ts";
import { People } from "./people.ts";
import { CALLS } from "./tabs/callsTab.ts";
import { HANGOUTS } from "./tabs/hangoutsTab.ts";
import { MESSAGES } from "./tabs/messagesTab.ts";
import { PEOPLE } from "./tabs/peopleTab.ts";
import { applyChats, ImportSession } from "./write.ts";

/** The core's tabs and friend map's, as the server lists them with the module on. */
const TABS = tabsWith(moduleTabs({ on: [{ id: "friend-map", definition: { tabs: [MESSAGES, CALLS, HANGOUTS, PEOPLE] } }] } as unknown as Modules));

let dataDir: string;
let db: Db;
let core: Db;
let viewer: TestReads;
let server: Server;
let port: number;
let available = true;
const ids: Record<string, number> = {};

/** The calendar's own id of a row (what a tab's rows are keyed by), by its kind and the source's own id. */
const calendarId = (kind: string, nativeId: string): string =>
  String((viewer.reads.calendar.prepare("SELECT id FROM event WHERE kind = ? AND native_id = ?").get(kind, nativeId) as { id: number }).id);

/** A time on a Melbourne day (AEDT in March). */
const at = (date: string, time: string) => Date.parse(`${date}T${time}:00+11:00`);
const PHONE = "+61491570006";
const TEXT = "made-up words an app writes for a call";
const RECORD_NOTE = "a made-up note on a call record";
const LOGGED_NOTE = "a made-up note on a logged call";
const HANGOUT_NOTE = "a made-up note on a hangout";

function importEvents(platform: string, events: ArchiveEvent[]): void {
  // An agent's into the core's event index, beside the archive, as the host writes them.
  if (!isPlatform(platform)) {
    transaction(core, () => {
      const source = Number(core.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'export', 'test', 0, 'ok')").run(platform).lastInsertRowid);
      coreLedger(core).apply(events, { id: source, platform, kind: "export", seenAt: 0, folder: dataDir });
    });
    return;
  }
  transaction(db, () => {
    const source = Number(
      db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'export', 'test', 0, 'ok')").run(platform).lastInsertRowid,
    );
    // A chat platform's into the archive's chats, as the host writes them.
    applyChats(events, db, { id: source, platform, kind: "export", seenAt: 0, folder: dataDir }, () => {});
  });
}

/**
 * Two made-up LLM sessions on 6 March: one in a terminal in garden-planner (a prompt of 40 characters, its reply of 900
 * that used 3 tools, and a notification's reply of 120), one run by a program in recipe-box (a prompt and its reply).
 */
const LLM_EVENTS: ArchiveEvent[] = (() => {
  const t = (time: string) => at("2026-03-06", time);
  const turn = (id: string, session: string, role: "prompt" | "reply", time: string, chars: number, more: Partial<LlmTurnEvent> = {}): LlmTurnEvent =>
    ({ kind: "llm-turn", id, session, role, at: t(time), model: "claude-opus-5-5", chars, line: 1, offset: 0, length: 10, ...more });
  return [
    { kind: "device", key: "computer:sample-mac", name: "sample-mac", deviceKind: "computer" },
    { kind: "llm-session", id: "s1", entrypoint: "cli", device: "computer:sample-mac", project: "/home/sample/Projects/garden-planner", file: "/home/sample/s1.jsonl",
      version: "2.1.0", model: "claude-opus-5-5", startedAt: t("09:00"), endedAt: t("09:30"), bytes: 5000 },
    turn("p1", "s1", "prompt", "09:00", 40),
    turn("r1", "s1", "reply", "09:01", 900, { answers: "human", replyTo: "p1", endAt: t("09:05"), toolCalls: 3 }),
    turn("r2", "s1", "reply", "09:20", 120, { answers: "task-notification", endAt: t("09:21") }),
    { kind: "llm-session", id: "s2", entrypoint: "sdk-cli", project: "/home/sample/Projects/recipe-box", file: "/home/sample/s2.jsonl", startedAt: t("14:00"), endedAt: t("14:02"), bytes: 800 },
    turn("p2", "s2", "prompt", "14:00", 10, { model: undefined }),
    turn("r3", "s2", "reply", "14:01", 50, { answers: "human", replyTo: "p2", endAt: t("14:02"), model: undefined }),
  ];
})();

const account = (key: string, isSelf = false): ArchiveEvent => ({ kind: "account", key, keyKind: "name", displayName: key, isSelf });
let next = 0;
function call(conversation: string, sender: string, sentAt: number, callSeconds?: number): ArchiveEvent {
  return {
    kind: "message", id: `call${next++}`, idKind: "platform", conversation, sender, isFromSelf: sender === "Me", sentAt, type: "call", text: TEXT,
    ...(callSeconds === undefined ? {} : { callSeconds }), raw: {},
  };
}

/**
 * Ada on Messenger and the phone, one person, and Bea on Messenger: on 1 March a 3-minute Messenger call from Ada, an
 * unanswered one to her and a 2.5-minute phone call to her; on 2 March a 10-minute one from Bea; in April a WeChat-less
 * Messenger call of no known length from Bea; a 20-minute call in a group chat (no one's: who was on it is not known);
 * and on 5 April a 30-minute Discord call the captain logged with both, carrying a note.
 */
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "life-archive-viewer-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  core = openCore(join(dataDir, CORE_FILE));
  const people = new People(db);
  importEvents("messenger", [
    account("Me", true), account("Ada"), account("Bea"),
    { kind: "conversation", id: "ada", type: "direct", title: "Ada", members: ["Me", "Ada"] },
    { kind: "conversation", id: "bea", type: "direct", title: "Bea", members: ["Me", "Bea"] },
    { kind: "conversation", id: "trio", type: "group", title: "Trio", members: ["Me", "Ada", "Bea"] },
    call("ada", "Ada", at("2026-03-01", "19:00"), 180),
    call("ada", "Me", at("2026-03-01", "21:00"), 0),
    call("bea", "Bea", at("2026-03-02", "19:00"), 600),
    call("bea", "Bea", at("2026-04-03", "19:00")),
    call("trio", "Ada", at("2026-03-04", "19:00"), 1200),
  ]);
  importEvents("phone", [
    { kind: "account", key: PHONE, keyKind: "id", displayName: PHONE, handle: PHONE },
    { kind: "call", id: "P1", with: PHONE, at: at("2026-03-01", "18:00"), durationSeconds: 150, direction: "outgoing", answered: true, service: "phone", raw: {} },
  ]);
  people.runRules();
  const accountOf = (platform: string, key: string) => (db.prepare("SELECT id, person_id FROM import_person WHERE platform = ? AND key = ?").get(platform, key) as { id: number; person_id: number });
  ids.ada = accountOf("messenger", "Ada").person_id;
  ids.bea = accountOf("messenger", "Bea").person_id;
  people.link(accountOf("phone", PHONE).id, ids.ada);
  people.setName(ids.ada, "Ada Sample");
  people.setName(ids.bea, "Bea Placeholder");
  const manualCalls = new ManualCalls(db);
  ids.logged = manualCalls.insert({
    people: [{ personId: ids.ada, accountId: null, app: "discord" }, { personId: ids.bea, accountId: null, app: "discord" }],
    day: "2026-04-05", time: "20:00", minutes: 30, note: LOGGED_NOTE,
  });
  const record = (db.prepare("SELECT id FROM message WHERE type = 'call' AND sent_at = ?").get(at("2026-03-01", "19:00")) as { id: number }).id;
  setCallNote(db, manualCalls, { kind: "record", id: record }, RECORD_NOTE);
  ids.dinner = people.addCatchUp({ day: "2026-03-07", time: "18:30", hours: 2, personIds: [ids.ada, ids.bea], others: 3, note: HANGOUT_NOTE });
  ids.walk = people.addCatchUp({ day: "2026-04-10", hours: 1.5, personIds: [ids.bea] });
  importEvents("claude-code", LLM_EVENTS);
  // The LLM warehouse's rules over them, so its tables have tags to show.
  retagLlm(core, NO_LLM_CONTEXT);
  people.setTags(ids.bea, ["work"]);

  viewer = friendMapReads(db, core);
  const api = viewerHandler(() => (available ? viewer.reads : new Error("no archive here")));
  server = archiveServer({
    hosts: ["mac.tailnet.example"],
    viewer: { api, page: (req, res) => sendJson(res, 200, { page: req.url }), mounts: [{ path: "/api/archive", handler: async (req, res) => sendJson(res, 200, { archive: req.url }) }] },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  viewer.close();
  core.close();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Everything said, in order, so a test can check none of it is content. */
const said: string[] = [];

function send(path: string, { method = "GET", headers = {} }: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const out = request({ host: "127.0.0.1", port, path, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        said.push(body);
        resolve({ status: res.statusCode!, body, location: res.headers.location });
      });
    });
    out.on("error", reject);
    out.end();
  });
}

async function json<T>(path: string): Promise<T> {
  const { status, body } = await send(path);
  expect(status, body).toBe(200);
  return JSON.parse(body) as T;
}

const rows = (query = "") => json<RowsAnswer>(`/life-archive/api/calls/rows${query ? `?${query}` : ""}`);

describe("the viewer's door", () => {
  it("keeps the archive's routes and the viewer's apart, sends the root to the viewer, and 404s the rest", async () => {
    expect(JSON.parse((await send("/api/archive/people")).body)).toEqual({ archive: "/api/archive/people" });
    expect(JSON.parse((await send("/life-archive/calls?app=phone")).body)).toEqual({ page: "/life-archive/calls?app=phone" });
    expect((await send("/life-archive/api/kinds")).status).toBe(200);
    expect(await send("/")).toMatchObject({ status: 302, location: "/life-archive/" });
    expect(await send("/life-archive")).toMatchObject({ status: 302, location: "/life-archive/" });
    expect((await send("/api/settings")).status).toBe(404);
    expect((await send("/life-archive-other")).status).toBe(404);
  });

  it("refuses a Host it does not know, the viewer as the archive", async () => {
    expect((await send("/life-archive/api/kinds", { headers: { host: "mac.tailnet.example" } })).status).toBe(200);
    expect((await send("/life-archive/api/kinds", { headers: { host: "rebound.example" } })).status).toBe(403);
    expect((await send("/life-archive/calls", { headers: { host: "rebound.example" } })).status).toBe(403);
  });
});

describe("the calendar's day summaries", () => {
  const DAYS = "/life-archive/api/calendar/days";

  it("say each day's messages and whom he messaged, to the day before `to`, naming them", async () => {
    const answer = await json<CalendarDaysAnswer>(`${DAYS}?from=2026-03-01&to=2026-03-03`);
    expect(answer.days.find((day) => day.day === "2026-03-01")).toMatchObject({ messages: 2, messaged: [{ id: ids.ada, count: 2 }] });
    expect(answer.days.find((day) => day.day === "2026-03-02")).toMatchObject({ messages: 1, messaged: [{ id: ids.bea, count: 1 }] });
    expect(answer.people).toEqual({ [ids.ada]: "Ada Sample", [ids.bea]: "Bea Placeholder" });
    expect((await json<CalendarDaysAnswer>(`${DAYS}?from=2026-03-01&to=2026-03-02`)).days.map((day) => day.day)).not.toContain("2026-03-02");
  });

  it("with a person, say only their messages", async () => {
    expect(await json<CalendarDaysAnswer>(`${DAYS}?from=2026-03-01&to=2026-03-03&person=${ids.ada}`)).toEqual({
      days: [{ day: "2026-03-01", messages: 2, messaged: [], agentMessages: 0, rituals: null }],
      people: {},
      hidden: [],
    });
  });

  it("refuse a range that is not one, and a person who is not a number", async () => {
    for (const query of ["from=2026-03-02&to=2026-03-02", "from=2026-03-03&to=2026-03-02", "to=2026-03-02", "from=March&to=2026-03-02", "from=2026-03-01&to=2026-03-02&person=ada"]) {
      expect((await send(`${DAYS}?${query}`)).status, query).toBe(400);
    }
  });
});

describe("the viewer's routes", () => {
  it("list the tabs, without their SQL", async () => {
    const { kinds } = await json<KindsAnswer>("/life-archive/api/kinds");
    expect(kinds.map((k) => k.kind)).toEqual(["messages", "calls", "hangouts", "llm", "prompts", "agent-sessions", "llm-tags", "people", "tags"]);
    expect(kinds.find((k) => k.kind === "people")).toMatchObject({ search: "Find by name", sort: "last", splits: ["hidden"] });
    // Friend map's tables say they are the module's; the agents' sessions are the core's.
    expect(kinds.map((k) => k.module ?? null)).toEqual(["friend-map", "friend-map", "friend-map", null, null, null, null, "friend-map", "friend-map"]);
    const calls = kinds[1];
    expect(calls).toMatchObject({ label: "Calls", sort: "when", measures: [{ key: "calls" }, { key: "minutes" }], splits: ["app", "way", "answered"] });
    expect(calls.filters.map((f) => f.key)).toEqual(["app", "answered", "way", "caller", "person"]);
    expect(JSON.stringify(kinds)).not.toMatch(/SELECT|person_call/);
  });

  it("list each call once, newest first, everyone on it by name, the group chat's not at all", async () => {
    const answer = await rows();
    expect(answer.total).toBe(6);
    expect(answer.rows.map((row) => [row.cells.app, row.cells.way, row.cells.answered, row.cells.length, row.cells.origin])).toEqual([
      ["Discord", "Logged", "Yes", 1800, "You logged it"],
      ["Messenger", "They called", "Not known", null, "Chat"],
      ["Messenger", "They called", "Yes", 600, "Chat"],
      ["Messenger", "You called", "No", 0, "Chat"],
      ["Messenger", "They called", "Yes", 180, "Chat"],
      ["Phone", "You called", "Yes", 150, "Call history"],
    ]);
    expect(answer.rows[0].cells.with).toEqual({ ids: [ids.ada, ids.bea].sort((a, b) => a - b), others: 0 });
    // A row is keyed by the calendar's own id; the call's own key (logged:…) is the calendar's native id.
    expect(answer.rows[0].id).toMatch(/^\d+$/);
    expect(viewer.reads.calendar.prepare("SELECT native_id FROM event WHERE id = ?").get(Number(answer.rows[0].id))).toMatchObject({ native_id: expect.stringMatching(/^logged:/) });
    expect(answer.people).toEqual({ [ids.ada]: "Ada Sample", [ids.bea]: "Bea Placeholder" });
  });

  it("page and sort them", async () => {
    const page = await rows("offset=1&limit=2");
    expect(page).toMatchObject({ total: 6, offset: 1 });
    expect(page.rows.map((r) => r.cells.length)).toEqual([null, 600]);
    const longest = await rows("sort=length&dir=desc");
    expect(longest.rows.map((r) => r.cells.length)).toEqual([1800, 600, 180, 150, 0, null]);
    const shortest = await rows("sort=length&dir=asc&limit=2");
    expect(shortest.rows.map((r) => r.cells.length)).toEqual([0, 150]);
  });

  it("filter them by app, answer, way, person and time, together", async () => {
    expect((await rows("app=phone")).rows.map((r) => r.cells.app)).toEqual(["Phone"]);
    expect((await rows("app=phone&app=discord")).total).toBe(2);
    expect((await rows("answered=unknown")).rows.map((r) => r.cells.length)).toEqual([null]);
    expect((await rows("answered=no&answered=yes")).total).toBe(5);
    expect((await rows("way=outgoing")).total).toBe(2);
    expect((await rows(`person=${ids.bea}`)).total).toBe(3);
    expect((await rows(`person=${ids.ada}&app=messenger`)).total).toBe(2);
    const march = `from=${dayStart("2026-03-01")}&to=${dayStart("2026-03-02")}`;
    expect((await rows(march)).rows.map((r) => r.cells.app)).toEqual(["Messenger", "Messenger", "Phone"]);
    expect((await rows(`${march}&answered=yes`)).total).toBe(2);
  });

  it("tell a known caller from an unknown one: a call none of whose people has a name but a number is unknown's", async () => {
    expect((await rows("caller=unknown")).total).toBe(0);
    const people = new People(db);
    people.setName(ids.bea, "+61 491 570 110");
    // A name is an edit, which pushes friend map's calls again (calendarPush.ts's afterPeople); here, by hand.
    viewer.calendar.rebuild();
    try {
      // Bea's two Messenger calls are unknown's now; the logged call with Ada and her is still known, by Ada.
      expect((await rows("caller=unknown")).rows.map((r) => r.cells.with)).toEqual([{ ids: [ids.bea], others: 0 }, { ids: [ids.bea], others: 0 }]);
      expect((await rows("caller=known")).total).toBe(4);
      const year = await json<VolumeAnswer>("/life-archive/api/calls/volume?caller=known");
      expect(year.total).toBe(4);
    } finally {
      people.setName(ids.bea, "Bea Placeholder");
      viewer.calendar.rebuild();
    }
  });

  it("chart them by the finest grain that fits, Melbourne days, counted or in minutes, following the filters", async () => {
    const days = await json<VolumeAnswer>("/life-archive/api/calls/volume");
    expect(days.grain).toBe("day");
    expect(days.buckets[0]).toEqual({ start: dayStart("2026-03-01"), day: "2026-03-01", value: 3 });
    expect(days.buckets.at(-1)).toMatchObject({ day: "2026-04-05", value: 1 });
    expect(days.end).toBe(dayStart("2026-04-06"));
    expect(days.total).toBe(6);
    const months = await json<VolumeAnswer>("/life-archive/api/calls/volume?grain=month&measure=minutes");
    expect(months.buckets.map((b) => [b.day, b.value])).toEqual([["2026-03-01", (180 + 600 + 150) / 60], ["2026-04-01", 30]]);
    const bea = await json<VolumeAnswer>(`/life-archive/api/calls/volume?grain=month&person=${ids.bea}`);
    expect(bea.buckets.map((b) => b.value)).toEqual([1, 2]);
    // A range sets the chart's span, though no call falls at its edges.
    const april = await json<VolumeAnswer>(`/life-archive/api/calls/volume?grain=week&from=${dayStart("2026-03-30")}&to=${dayStart("2026-04-13")}`);
    expect(april.buckets.map((b) => [b.day, b.value])).toEqual([["2026-03-30", 2], ["2026-04-06", 0]]);
    const none = await json<VolumeAnswer>("/life-archive/api/calls/volume?app=signal");
    expect(none).toMatchObject({ buckets: [], total: 0 });
  });

  it("split the chart by a filter's values, each bar's parts adding up to it", async () => {
    const byWay = await json<VolumeAnswer>("/life-archive/api/calls/volume?grain=month&split=way");
    expect(byWay.series).toEqual([{ value: "incoming", label: "They called", slot: 0 }, { value: "outgoing", label: "You called", slot: 1 }, { value: "logged", label: "Logged", slot: 2 }]);
    expect(byWay.buckets.map((b) => [b.day, b.value, b.parts])).toEqual([["2026-03-01", 4, [2, 2, 0]], ["2026-04-01", 2, [1, 0, 1]]]);
    const minutes = await json<VolumeAnswer>("/life-archive/api/calls/volume?grain=month&measure=minutes&split=app");
    // In the tab's order of apps, each keeping its place (its colour) whichever are there.
    expect(minutes.series.map((s) => [s.label, s.slot])).toEqual([["Phone", 0], ["Messenger", 3], ["Discord", 8]]);
    expect(minutes.buckets[0].parts).toEqual([150 / 60, (180 + 600) / 60, 0]);
    expect((await send("/life-archive/api/calls/volume?split=person")).status).toBe(400);
  });

  it("count each filter's values under the others, keeping a value chosen", async () => {
    const { facets } = await json<FacetsAnswer>(`/life-archive/api/calls/facets?app=phone&app=signal`);
    // The app facet ignores the app filter; the others follow it.
    expect(facets.app).toEqual([
      { value: "messenger", label: "Messenger", count: 4 },
      { value: "discord", label: "Discord", count: 1 },
      { value: "phone", label: "Phone", count: 1 },
      { value: "signal", label: "Signal", count: 0 },
    ]);
    expect(facets.answered).toEqual([{ value: "yes", label: "Yes", count: 1 }]);
    expect(facets.person).toEqual([{ value: String(ids.ada), label: "Ada Sample", count: 1 }]);
    const all = await json<FacetsAnswer>("/life-archive/api/calls/facets");
    expect(all.facets.person).toEqual([
      { value: String(ids.ada), label: "Ada Sample", count: 4 },
      { value: String(ids.bea), label: "Bea Placeholder", count: 3 },
    ]);
  });

  it("answer what they cannot read with 400, an unknown tab or route with 404, a write with 405, and no archive with 503", async () => {
    for (const bad of ["from=soon", "from=5&to=4", "person=ada", "offset=-1", "limit=0", "limit=501", "sort=app", "dir=up"]) {
      expect((await send(`/life-archive/api/calls/rows?${bad}`)).status, bad).toBe(400);
    }
    expect((await send("/life-archive/api/calls/volume?grain=hour")).status).toBe(400);
    expect((await send("/life-archive/api/calls/volume?measure=hours")).status).toBe(400);
    expect((await send(`/life-archive/api/calls/rows?${Array.from({ length: 31 }, (_, i) => `app=a${i}`).join("&")}`)).status).toBe(400);
    expect((await send("/life-archive/api/texts/rows")).status).toBe(404);
    expect((await send("/life-archive/api/calls/everything")).status).toBe(404);
    expect((await send("/life-archive/api/kinds", { method: "POST" })).status).toBe(405);
    expect((await send("/life-archive/api/kinds", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    available = false;
    try {
      expect((await send("/life-archive/api/calls/rows")).status).toBe(503);
    } finally {
      available = true;
    }
  });
});

const get = <T>(kind: string, route: string, query = "") => json<T>(`/life-archive/api/${kind}/${route}${query ? `?${query}` : ""}`);
const cellsOf = (answer: RowsAnswer, ...keys: string[]) => answer.rows.map((row) => keys.map((key) => row.cells[key]));

describe("the Hangouts tab", () => {
  it("lists each hangout, newest first, one with no time on its date alone, without its note", async () => {
    const answer = await get<RowsAnswer>("hangouts", "rows");
    expect(answer.total).toBe(2);
    expect(cellsOf(answer, "when", "hours", "size")).toEqual([
      ["10 Apr 2026", 5400, 1],
      [at("2026-03-07", "18:30"), 7200, 5],
    ]);
    // Every one is in person, so none says how: a call is in the Calls tab.
    expect(answer.rows.every((row) => !("how" in row.cells))).toBe(true);
    expect(answer.rows[1].cells.with).toEqual({ ids: [ids.ada, ids.bea].sort((a, b) => a - b), others: 3 });
    expect(answer.people).toEqual({ [ids.ada]: "Ada Sample", [ids.bea]: "Bea Placeholder" });
  });

  it("filters by how many and a person, and charts hangouts or hours", async () => {
    expect((await get<RowsAnswer>("hangouts", "rows", "size=group")).rows.map((r) => r.id)).toEqual([calendarId("hangout", String(ids.dinner))]);
    expect((await get<RowsAnswer>("hangouts", "rows", `person=${ids.bea}`)).total).toBe(2);
    expect((await get<RowsAnswer>("hangouts", "rows", `person=${ids.ada}`)).total).toBe(1);
    const hours = await get<VolumeAnswer>("hangouts", "volume", "grain=month&measure=hours");
    expect(hours.buckets.map((b) => [b.day, b.value])).toEqual([["2026-03-01", 120], ["2026-04-01", 90]]);
    const bySize = await get<VolumeAnswer>("hangouts", "volume", "grain=month&split=size");
    expect(bySize.series.map((x) => x.label)).toEqual(["One person", "Several"]);
    expect(bySize.buckets.map((b) => b.parts)).toEqual([[0, 1], [1, 0]]);
    expect((await send("/life-archive/api/hangouts/volume?grain=month&split=how")).status).toBe(400);
  });

  it("charts days that begin at 06:00, one with no time on its own date", async () => {
    const day = (from: string, to: string) => `grain=day&begins=06:00&from=${wallClock(from, "06:00")}&to=${wallClock(to, "06:00")}`;
    const april = await get<VolumeAnswer>("hangouts", "volume", day("2026-04-09", "2026-04-11"));
    expect(april.buckets.map((b) => [b.day, b.value])).toEqual([["2026-04-09", 0], ["2026-04-10", 1]]);
    expect(april.buckets[0].start).toBe(wallClock("2026-04-09", "06:00"));
    const march = await get<VolumeAnswer>("hangouts", "volume", day("2026-03-07", "2026-03-08"));
    expect(march.buckets.map((b) => [b.day, b.value])).toEqual([["2026-03-07", 1]]);
    expect((await send("/life-archive/api/hangouts/volume?grain=day&begins=25:00")).status).toBe(400);
  });

  it("opens one in the drawer, with when it started, the unnamed and the way to everyone at it", async () => {
    const detail = await get<RowDetail>("hangouts", "row", `id=${calendarId("hangout", String(ids.dinner))}`);
    expect(detail.more).toEqual([{ label: "Started", kind: "text", value: "18:30" }, { label: "Others not named", kind: "count", value: 3 }]);
    expect(detail.views.map((v) => [v.label, v.kind, v.filters.person])).toEqual([
      ["Messages that day", "messages", null], ["Hangouts with Ada Sample", "hangouts", ids.ada], ["Hangouts with Bea Placeholder", "hangouts", ids.bea],
    ]);
    expect(detail.views[0].filters).toMatchObject({ from: dayStart("2026-03-07"), to: dayStart("2026-03-08") });
  });
});

describe("the LLM tab", () => {
  it("lists every session, prompt and reply, newest first, a session's characters its turns'", async () => {
    const answer = await get<RowsAnswer>("llm", "rows");
    expect(answer.total).toBe(7);
    expect(cellsOf(answer, "kind", "how", "project", "model", "chars")).toEqual([
      ["Reply", "To a prompt", "recipe-box", null, 50],
      ["Prompt", "—", "recipe-box", null, 10],
      ["Session", "Run by a program", "recipe-box", null, 60],
      ["Reply", "To a notification", "garden-planner", "claude-opus-5-5", 120],
      ["Reply", "To a prompt", "garden-planner", "claude-opus-5-5", 900],
      ["Prompt", "—", "garden-planner", "claude-opus-5-5", 40],
      ["Session", "In a terminal", "garden-planner", "claude-opus-5-5", 1060],
    ]);
    expect(answer.rows[4].cells.length).toBe(240);
    expect(answer.rows[0].cells.session).toMatchObject({ filter: "session", label: "recipe-box · 2026-03-06" });
  });

  it("filters by kind, how, project and session, and charts events or characters, split by kind", async () => {
    expect((await get<RowsAnswer>("llm", "rows", "kind=llm_prompt")).total).toBe(2);
    expect((await get<RowsAnswer>("llm", "rows", "how=task-notification")).total).toBe(1);
    expect((await get<RowsAnswer>("llm", "rows", `project=${encodeURIComponent("/home/sample/Projects/recipe-box")}`)).total).toBe(3);
    const { facets } = await get<FacetsAnswer>("llm", "facets");
    expect(facets.session.map((f) => [f.label, f.count])).toEqual([["garden-planner · 2026-03-06", 4], ["recipe-box · 2026-03-06", 3]]);
    expect(facets.project.map((f) => f.label)).toEqual(["garden-planner", "recipe-box"]);
    const session = facets.session[0].value;
    expect((await get<RowsAnswer>("llm", "rows", `session=${session}`)).total).toBe(4);
    const unseen = await get<FacetsAnswer>("llm", "facets", `session=${session}&kind=llm_session&how=sdk-cli`);
    expect(unseen.facets.session.find((f) => f.value === session)).toEqual({ value: session, label: "garden-planner · 2026-03-06", count: 0 });
    expect((await get<VolumeAnswer>("llm", "volume", "measure=characters")).total).toBe(40 + 900 + 120 + 10 + 50);
    const byKind = await get<VolumeAnswer>("llm", "volume", "split=kind");
    expect(byKind.series.map((x) => x.label)).toEqual(["Session", "Prompt", "Reply"]);
    expect(byKind.buckets[0].parts).toEqual([2, 2, 3]);
  });

  it("opens a session in the drawer, with its turns, file and device, and the way to the rest of it", async () => {
    const { rows: [session] } = await get<RowsAnswer>("llm", "rows", "kind=llm_session&project=%2Fhome%2Fsample%2FProjects%2Fgarden-planner");
    const detail = await get<RowDetail>("llm", "row", `id=${session.id}`);
    expect(Object.fromEntries(detail.more.map((f) => [f.label, f.value]))).toMatchObject({
      App: "Claude Code", Prompts: 1, Replies: 2, "Its file's size": "5,000 bytes", "Session file": "/home/sample/s1.jsonl", Device: "sample-mac",
    });
    expect(detail.views[0]).toMatchObject({ label: "This session", kind: "llm", filters: { choices: { session: [expect.any(String)] } } });
  });

  it("opens the conversation of a row by the archive's event, never by the calendar's own id", async () => {
    // The sessions' rows pushed again, so the calendar's ids are not the event index's by chance.
    viewer.calendar.sink.replace("core", []);
    viewer.calendar.rebuild();
    const archiveEventOf = (calendarId: string) => {
      const { origin, native_id } = viewer.reads.calendar.prepare("SELECT origin, native_id FROM event WHERE id = ?").get(Number(calendarId)) as { origin: string; native_id: string };
      return (core.prepare("SELECT id FROM event WHERE origin = ? AND native_id = ?").get(origin, native_id) as { id: number }).id;
    };
    const { rows } = await get<RowsAnswer>("llm", "rows");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const event = archiveEventOf(row.id);
      expect(event).not.toBe(Number(row.id));
      expect((await get<RowDetail>("llm", "row", `id=${row.id}`)).content).toBe(event);
    }
    // A message's row is the archive's own, so its drawer has no other id to give.
    const { rows: [message] } = await get<RowsAnswer>("messages", "rows");
    expect((await get<RowDetail>("messages", "row", `id=${message.id}`)).content).toBeUndefined();
  });
});

describe("a module's table", () => {
  /** A made-up module's tab over the calendar (sdk/server.ts's `tabs`), as the exercise module's Workouts is. */
  const MADE_UP = sourceTab({
    kind: "made-up", label: "Made up", noun: ["made-up event", "made-up events"], module: "made-up",
    columns: [{ key: "when", label: "When", kind: "time", width: 100, sortable: true }],
    sort: "when", splits: [], sorts: { when: "at" }, source: "SELECT id, origin, native_id, kind, at FROM event WHERE kind = 'made-up'", filters: [],
    measures: [{ key: "events", label: "Events", unit: "count", expr: "count(r.id)" }],
    row: (raw) => ({ id: String(raw.id), cells: { when: raw.at } }),
  });

  it("is listed after the core's tables, saying whose it is, and keeps its own definition", () => {
    const [tab] = moduleTabs({ on: [{ id: "made-up", definition: { tabs: [MADE_UP] } }] } as unknown as Modules);
    expect(tab.spec).toEqual({ ...MADE_UP.spec, module: "made-up" });
    expect(tab.rows).toBe(MADE_UP.rows);
    expect(TABS.map((t) => t.spec.kind)).toEqual(["messages", "calls", "hangouts", "llm", "prompts", "agent-sessions", "llm-tags", "people"]);
    expect(tabsWith([...TABS.filter((t) => t.spec.module), tab]).map((t) => t.spec.kind)).toEqual(["messages", "calls", "hangouts", "llm", "prompts", "agent-sessions", "llm-tags", "people", "made-up"]);
  });
});

describe("a table over the calendar", () => {
  it("gives each row its time, for the Calendar to place it", async () => {
    const answer = await rows();
    expect(answer.rows.every((row) => typeof row.at === "number")).toBe(true);
  });
});

describe("the People tab, around midnight", () => {
  const beforeMidnight = Date.parse("2026-01-15T18:20:00Z");
  const afterMidnight = Date.parse("2026-01-15T18:40:00Z");
  const zone = { timeZone: TIME_ZONE, locale: LOCALE };
  const page = { offset: 0, limit: 10, sort: "name", direction: "asc", after: null } as const;
  let folder: string;
  let own: Db;
  let connection: TestReads;

  /** Two made-up messages from Ada in one UTC hour, `seed` messages more a year away to tell this archive's activity from another's. */
  function messages(seed: number): void {
    transaction(own, () => {
      const source = Number(own.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('messenger', 'test', 'export', 'test', 0, 'ok')").run().lastInsertRowid);
      const session = new ImportSession(own, "messenger", source, "export");
      for (const event of [
        account("Me", true), account("Ada"),
        { kind: "conversation", id: "ada", type: "direct", title: "Ada", members: ["Me", "Ada"] },
        ...[beforeMidnight, afterMidnight, ...Array.from({ length: seed }, (_, i) => Date.parse("2025-01-15T00:00:00Z") + i * 60_000)].map((sentAt, i) => ({
          kind: "message", id: `midnight${i}`, idKind: "platform", conversation: "ada", sender: "Ada", isFromSelf: false, sentAt, type: "text", text: TEXT, raw: {},
        })),
      ] as ArchiveEvent[]) session.apply(event);
    });
    new People(own).runRules();
  }

  const messagesBetween = (from: number, to: number) => PEOPLE.rows(connection.reads, { ...NO_FILTERS, from, to }, page);

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "life-archive-viewer-midnight-"));
    own = openArchive(join(folder, "archive.sqlite"));
    connection = friendMapReads(own);
  });

  afterEach(async () => {
    setClock(zone);
    connection.close();
    own.close();
    await rm(folder, { recursive: true, force: true });
  });

  it("counts each message on its own day in a zone on the half hour", async () => {
    messages(1);
    setClock({ timeZone: "Asia/Kolkata", locale: "en-IN" });
    const days = [Date.parse("2026-01-15T00:00:00+05:30"), Date.parse("2026-01-16T00:00:00+05:30"), Date.parse("2026-01-17T00:00:00+05:30")];
    expect(cellsOf(await messagesBetween(days[0], days[1]), "messages")).toEqual([[1]]);
    expect(cellsOf(await messagesBetween(days[1], days[2]), "messages")).toEqual([[1]]);
  });

  it("keeps a whole UTC hour together, at its first message, in a zone on the hour", async () => {
    messages(2);
    expect(cellsOf(await messagesBetween(beforeMidnight, afterMidnight + 1), "messages")).toEqual([[2]]);
    expect((await messagesBetween(Date.parse("2026-01-15T18:30:00Z"), Date.parse("2026-01-15T19:00:00Z"))).total).toBe(0);
  });
});

describe("the People tab", () => {
  it("lists everyone but the captain, with their messages, calls and hangouts, the last in touch first", async () => {
    const answer = await get<RowsAnswer>("people", "rows");
    expect(answer.total).toBe(2);
    expect(cellsOf(answer, "name", "platforms", "accounts", "tags", "hidden", "messages", "calls", "hangouts")).toEqual([
      ["Bea Placeholder", "Messenger", 1, "work", null, 2, 3, 2],
      ["Ada Sample", "Messenger, Phone", 2, null, null, 3, 4, 1],
    ]);
    expect(cellsOf(answer, "first", "last")).toEqual([
      [at("2026-03-02", "19:00"), dayStart("2026-04-10")],
      // The call Ada and Bea were logged on, at 8 pm on 5 April, Melbourne's clocks back an hour that morning.
      [at("2026-03-01", "18:00"), wallClock("2026-04-05", "20:00")],
    ]);
    expect(cellsOf(await get<RowsAnswer>("people", "rows", "sort=messages&dir=asc"), "name")).toEqual([["Bea Placeholder"], ["Ada Sample"]]);
    expect(cellsOf(await get<RowsAnswer>("people", "rows", "sort=name&dir=asc"), "name")).toEqual([["Ada Sample"], ["Bea Placeholder"]]);
  });

  it("finds them by any part of a name, and filters by tag, platform, hidden and who was active in a range", async () => {
    expect(cellsOf(await get<RowsAnswer>("people", "rows", "q=bea%20p"), "name")).toEqual([["Bea Placeholder"]]);
    expect((await get<RowsAnswer>("people", "rows", "q=SAMPLE")).total).toBe(1);
    expect(cellsOf(await get<RowsAnswer>("people", "rows", "tag=work"), "name")).toEqual([["Bea Placeholder"]]);
    expect(cellsOf(await get<RowsAnswer>("people", "rows", "tag=-"), "name")).toEqual([["Ada Sample"]]);
    expect(cellsOf(await get<RowsAnswer>("people", "rows", "platform=phone"), "name")).toEqual([["Ada Sample"]]);
    expect((await get<RowsAnswer>("people", "rows", "hidden=you")).total).toBe(0);
    // On 2 March only Bea was in touch: her call, which is a message too, counted in the range alone.
    const second = await get<RowsAnswer>("people", "rows", `from=${dayStart("2026-03-02")}&to=${dayStart("2026-03-03")}`);
    expect(cellsOf(second, "name", "messages", "calls", "hangouts")).toEqual([["Bea Placeholder", 1, 1, 0]]);
    const { facets } = await get<FacetsAnswer>("people", "facets", "q=bea");
    expect(facets.tag).toEqual([{ value: "work", label: "work", count: 1 }]);
    expect(facets.hidden).toEqual([{ value: "shown", label: "Shown", count: 1 }]);
  });

  it("charts the people active in each bucket, or new, each counted once over the chart", async () => {
    const active = await get<VolumeAnswer>("people", "volume", "grain=month");
    expect(active.buckets.map((b) => [b.day, b.value])).toEqual([["2026-03-01", 2], ["2026-04-01", 2]]);
    expect(active.total).toBe(2);
    const fresh = await get<VolumeAnswer>("people", "volume", "grain=month&measure=new");
    expect(fresh.buckets.map((b) => b.value)).toEqual([2, 0]);
    const split = await get<VolumeAnswer>("people", "volume", "grain=week&split=hidden");
    expect(split.series).toEqual([{ value: "shown", label: "Shown", slot: 0 }]);
    expect(split.seriesTotals).toEqual([2]);
    expect(split.total).toBe(2);
    expect((await get<VolumeAnswer>("people", "volume", "grain=month&tag=work")).buckets.map((b) => b.value)).toEqual([1, 1]);
  });

  it("opens one in the drawer, with their accounts and hours of hangouts, and the way to their messages, calls and hangouts", async () => {
    const detail = await get<RowDetail>("people", "row", `id=${ids.ada}`);
    expect(detail.row.cells.name).toBe("Ada Sample");
    expect(detail.more).toEqual([
      { label: "Also called", kind: "text", value: null, key: "aliases" },
      { label: "Reach out", kind: "text", value: "No", key: "reach" },
      { label: "Messenger", kind: "text", value: "Ada" },
      { label: "Phone", kind: "text", value: PHONE },
      { label: "Hours of hangouts", kind: "duration", value: 7200 },
    ]);
    expect(detail.views.map((v) => [v.kind, v.filters.person])).toEqual([["messages", ids.ada], ["calls", ids.ada], ["hangouts", ids.ada]]);
  });
});

describe("the drawer", () => {
  it("opens a message and a call by their ids, and answers an unknown id with 404 and none with 400", async () => {
    const { rows: [message] } = await get<RowsAnswer>("messages", "rows", "limit=1");
    const detail = await get<RowDetail>("messages", "row", `id=${message.id}`);
    expect(detail.row).toEqual(message);
    expect(detail.more.find((f) => f.label === "Chat kind")?.value).toBeDefined();
    expect(detail.views.map((v) => v.label)).toContain("This chat");
    const { rows: [call] } = await get<RowsAnswer>("calls", "rows", "limit=1");
    expect((await get<RowDetail>("calls", "row", `id=${encodeURIComponent(call.id)}`)).row).toEqual(call);
    for (const kind of ["messages", "calls", "hangouts", "llm", "prompts", "agent-sessions", "llm-tags", "people", "tags"]) {
      expect((await send(`/life-archive/api/${kind}/row?id=999999`)).status, kind).toBe(404);
      expect((await send(`/life-archive/api/${kind}/row`)).status, kind).toBe(400);
    }
    // The merged Events table is gone: each table answers for itself.
    expect((await send("/life-archive/api/events/rows")).status).toBe(404);
  });
});

describe("the viewer's privacy", () => {
  it("runs every tab's rows, chart and facets on the read-only connections", () => {
    for (const tab of TABS) {
      const filters = { from: null, to: null, choices: {}, person: null, search: null };
      expect(rowsOf(viewer.reads, tab, filters, { offset: 0, limit: 500, sort: tab.spec.sort, direction: "desc", after: null }).total).toBeGreaterThan(0);
      for (const measure of tab.spec.measures) {
        for (const split of [null, ...tab.spec.splits]) expect(volumeOf(viewer.reads, tab, filters, { grain: null, measure: measure.key, split }).buckets.length).toBeGreaterThan(0);
      }
      expect(Object.keys(facetsOf(viewer.reads, tab, filters))).toEqual(tab.spec.filters.map((f) => f.key));
    }
  });

  it("cannot read content on the archive's connection, which the owners answer on, nor write on either", () => {
    const archive = archiveOf(viewer.reads);
    const { calendar } = viewer.reads;
    expect(() => archive.prepare("SELECT text FROM message").all()).toThrow(/is prohibited/);
    expect(() => archive.prepare("SELECT note FROM manual_call").all()).toThrow(/is prohibited/);
    expect(() => archive.prepare("SELECT note FROM call_note").all()).toThrow(/is prohibited/);
    expect(() => archive.prepare("SELECT length(note) FROM catch_up").all()).toThrow(/is prohibited/);
    expect(() => archive.exec("DELETE FROM call")).toThrow();
    expect(() => calendar.exec("DELETE FROM event")).toThrow();
  });

  it("keeps no text, note or name in the calendar: a row's people are ids, named by the owner at read time", () => {
    const everything = JSON.stringify(viewer.reads.calendar.prepare("SELECT * FROM event").all());
    for (const text of [TEXT, RECORD_NOTE, LOGGED_NOTE, HANGOUT_NOTE, "Ada Sample", "Bea Placeholder"]) expect(everything).not.toContain(text);
    expect(everything).toContain(`[${[ids.ada, ids.bea].sort((a, b) => a - b).join(",")}]`);
  });

  it("never sends a message's text, a call's note or a hangout's", () => {
    expect(said.length).toBeGreaterThan(20);
    for (const body of said) {
      expect(body).not.toContain(TEXT);
      expect(body).not.toContain(RECORD_NOTE);
      expect(body).not.toContain(LOGGED_NOTE);
      expect(body).not.toContain(HANGOUT_NOTE);
    }
  });
});
