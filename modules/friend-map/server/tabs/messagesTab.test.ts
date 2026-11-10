// The viewer's Messages tab (messagesTab.ts) over a made-up archive, through the viewer's routes and its read-only
// connection: the rows and their cells, paging by key and by skipping months, every filter alone and together, the
// chart counted and split, the filters' counts, answers kept until the archive changes, and that nothing it does reads
// or sends a message's text.

import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ArchiveEvent, dayStart, type Db, type FacetsAnswer, type Filters, isPlatform, type KindsAnswer, type LinkCell, type MessageType, type Reads, type RowsAnswer, transaction, type VolumeAnswer } from "../../../../sdk/server.ts";
import { openArchive } from "../db.ts";
import { People } from "../people.ts";
import { applyChats } from "../write.ts";
import { openTestArchive, type TestArchive } from "../../testing/archive.ts";
import { archiveOf } from "./reads.ts";
import { MESSAGES } from "./messagesTab.ts";
import { viewerHandler } from "../../testing/routes.ts";
import { facetsOf, rowsOf, tabOf, tabsWith, volumeOf } from "../../../../sdk/testing.ts";

let dataDir: string;
let db: Db;
let viewer: { reads: Reads };
let life: TestArchive;
let api: ReturnType<typeof viewerHandler>;
const ids: Record<string, number> = {};
const chats: Record<string, number> = {};

/** A time on a Melbourne day (AEDT from October to April, AEST between). */
const at = (date: string, time: string) => Date.parse(`${date}T${time}:00${date.slice(5, 7) >= "04" && date.slice(5, 7) <= "09" ? "+10:00" : "+11:00"}`);
const WORDS = "made-up words nobody wrote";
const NO_FILTERS: Filters = { from: null, to: null, choices: {}, person: null, search: null };

function importEvents(platform: string, events: ArchiveEvent[]): void {
  transaction(db, () => {
    const source = Number(
      db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'export', 'test', 0, 'ok')").run(platform).lastInsertRowid,
    );
    applyChats(events, db, { id: source, platform, kind: "export", seenAt: 0, folder: dataDir }, () => {});
  });
}

const account = (key: string, isSelf = false): ArchiveEvent => ({ kind: "account", key, keyKind: "name", displayName: key, isSelf });
let next = 0;
function message(conversation: string, sender: string | null, sentAt: number, type: MessageType = "text", extra: Partial<ArchiveEvent & { kind: "message" }> = {}): ArchiveEvent {
  return {
    kind: "message", id: `m${next++}`, idKind: "platform", conversation, sender, isFromSelf: sender === "Me", sentAt, type,
    ...(type === "text" ? { text: `${WORDS} ${next}` } : {}), raw: { words: WORDS }, ...extra,
  } as ArchiveEvent;
}

/**
 * On Messenger: a one-to-one chat with Ada (her words, with a reaction; the captain's, edited; her photos and a
 * video; one he unsent), the Trio group with Ada and Bea (and a notice from no one), an untitled group with Bea and
 * Cy (Bea writing most), and a Marketplace chat with Dana; on Telegram, a one-to-one chat with Ada again (another
 * account of hers); and a busy group of 2,600 messages through 2025, for paging deep down.
 */
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "life-archive-messages-"));
  life = await openTestArchive(dataDir);
  db = life.db;
  const people = new People(db);
  importEvents("messenger", [
    account("Me", true), account("Ada"), account("Bea"), account("Cy"), account("Dana"),
    { kind: "conversation", id: "ada", type: "direct", title: "Ada", members: ["Me", "Ada"] },
    { kind: "conversation", id: "trio", type: "group", title: "Trio", members: ["Me", "Ada", "Bea"] },
    { kind: "conversation", id: "untitled", type: "group", members: ["Me", "Bea", "Cy"] },
    { kind: "conversation", id: "lamp", type: "direct", title: "Dana · Lamp", members: ["Me", "Dana"] },
    { kind: "conversation", id: "busy", type: "group", title: "Busy", members: ["Me", "Bea", "Cy"] },
    // Groups with nothing in them: enough that "every group" is more chats than are looked up one by one (FEW_CHATS).
    ...Array.from({ length: 45 }, (_, i): ArchiveEvent => ({ kind: "conversation", id: `spare${i}`, type: "group", title: `Spare ${i}`, members: ["Me", "Cy"] })),
    message("ada", "Ada", at("2026-03-01", "09:00")),
    { kind: "reaction", message: `m${next - 1}`, actor: "Me", emoji: "👍" },
    message("ada", "Me", at("2026-03-01", "09:05"), "text", { editedAt: at("2026-03-01", "09:06") }),
    message("ada", "Ada", at("2026-03-02", "10:00"), "media"),
    { kind: "attachment", message: `m${next - 1}`, ordinal: 0, type: "image" },
    { kind: "attachment", message: `m${next - 1}`, ordinal: 1, type: "video" },
    { kind: "attachment", message: `m${next - 1}`, ordinal: 2, type: "image" },
    message("ada", "Me", at("2026-03-02", "10:30"), "text", { unsent: true, text: undefined }),
    message("trio", "Bea", at("2026-02-10", "12:00")),
    message("trio", "Ada", at("2026-02-10", "12:01"), "link"),
    message("trio", null, at("2026-02-10", "12:02"), "system"),
    message("untitled", "Bea", at("2026-01-05", "08:00")),
    message("untitled", "Bea", at("2026-01-05", "08:01"), "sticker"),
    message("untitled", "Cy", at("2026-01-05", "08:02")),
    message("lamp", "Dana", at("2026-03-03", "15:00")),
    ...Array.from({ length: 2600 }, (_, i) =>
      message("busy", ["Me", "Bea", "Cy"][i % 3], dayStart("2025-01-01") + Math.floor((i * 364 * 86_400_000) / 2600) + 3_600_000, i % 5 === 0 ? "media" : "text")),
  ]);
  importEvents("telegram", [
    account("Me", true), account("Ada"),
    { kind: "conversation", id: "ada-t", type: "direct", members: ["Me", "Ada"] },
    message("ada-t", "Ada", at("2026-03-04", "20:00")),
    message("ada-t", "Me", at("2026-03-04", "20:01")),
  ]);
  db.prepare("UPDATE conversation SET is_marketplace = 1 WHERE platform_conversation_id = 'lamp'").run();
  people.runRules();
  const personOf = (platform: string, key: string) => (db.prepare("SELECT person_id FROM import_person WHERE platform = ? AND key = ?").get(platform, key) as { person_id: number }).person_id;
  const chatOf = (key: string) => (db.prepare("SELECT id FROM conversation WHERE platform_conversation_id = ?").get(key) as { id: number }).id;
  ids.ada = personOf("messenger", "Ada");
  ids.bea = personOf("messenger", "Bea");
  ids.cy = personOf("messenger", "Cy");
  ids.dana = personOf("messenger", "Dana");
  people.link((db.prepare("SELECT id FROM import_person WHERE platform = 'telegram' AND key = 'Ada'").get() as { id: number }).id, ids.ada);
  people.setName(ids.ada, "Ada Sample");
  people.setName(ids.bea, "Bea Placeholder");
  people.setName(ids.cy, "Cy Example");
  people.setName(ids.dana, "Dana Seller");
  for (const key of ["ada", "trio", "untitled", "lamp", "busy", "ada-t"]) chats[key] = chatOf(key);

  life.calendar.rebuild();
  viewer = { reads: life.reads() };
  api = viewerHandler(() => viewer.reads);
});

afterAll(async () => {
  life.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Everything the routes said, so a test can check none of it is content. */
const said: string[] = [];

/** GET `path` from the viewer's routes, straight to its handler. */
async function get<T>(path: string): Promise<T> {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    setHeader() {},
    end(text: string) {
      body = text;
    },
  };
  await api({ method: "GET", url: path, headers: { "sec-fetch-site": "same-origin" } } as unknown as IncomingMessage, res as unknown as ServerResponse);
  said.push(body);
  expect(status, body).toBe(200);
  return JSON.parse(body) as T;
}

const rows = (query = "") => get<RowsAnswer>(`/life-archive/api/messages/rows${query ? `?${query}` : ""}`);
const volume = (query = "") => get<VolumeAnswer>(`/life-archive/api/messages/volume${query ? `?${query}` : ""}`);
const facets = async (query = "") => (await get<FacetsAnswer>(`/life-archive/api/messages/facets${query ? `?${query}` : ""}`)).facets;
/** Everything but the busy group. */
const quiet = () => `from=${dayStart("2026-01-01")}`;

describe("the Messages tab", () => {
  it("comes first of the tables, with its columns, filters, measures and splits", async () => {
    const { kinds: all } = await get<KindsAnswer>("/life-archive/api/kinds");
    expect(all[0].kind).toBe("messages");
    const kinds = all.filter((k) => k.kind === "messages");
    expect(kinds[0].columns.map((c) => c.key)).toEqual(["when", "app", "chat", "from", "type", "length", "attachments", "reactions", "changed"]);
    expect(kinds[0].filters.map((f) => f.key)).toEqual(["app", "kind", "chat", "sender", "type", "person"]);
    expect(kinds[0]).toMatchObject({ measures: [{ key: "messages" }, { key: "characters" }], splits: ["app", "kind", "sender", "type"], sort: "when" });
  });

  it("lists each message, newest first, by its metadata", async () => {
    const answer = await rows(quiet());
    expect(answer.total).toBe(13);
    const cells = answer.rows.map((r) => r.cells);
    expect(cells.map((c) => [c.app, (c.chat as LinkCell).label, c.type])).toEqual([
      ["Telegram", "with Ada Sample", "Text"],
      ["Telegram", "with Ada Sample", "Text"],
      ["Messenger", "Dana · Lamp", "Text"],
      ["Messenger", "with Ada Sample", "Text"],
      ["Messenger", "with Ada Sample", "Media"],
      ["Messenger", "with Ada Sample", "Text"],
      ["Messenger", "with Ada Sample", "Text"],
      ["Messenger", "Trio", "Notice"],
      ["Messenger", "Trio", "Link"],
      ["Messenger", "Trio", "Text"],
      ["Messenger", "Bea Placeholder, Cy Example", "Text"],
      ["Messenger", "Bea Placeholder, Cy Example", "Sticker"],
      ["Messenger", "Bea Placeholder, Cy Example", "Text"],
    ]);
    // Who sent it: the captain, a person (named in people), or no one.
    expect(cells.slice(0, 2).map((c) => c.from)).toEqual(["You", { ids: [ids.ada], others: 0 }]);
    expect(cells[7].from).toBeNull();
    expect(answer.people).toMatchObject({ [ids.ada]: "Ada Sample", [ids.bea]: "Bea Placeholder" });
    // Its length (no text, none), attachments, reactions and changes.
    const ada = cells.slice(3, 7);
    expect(ada.map((c) => [c.length, c.attachments, c.reactions, c.changed])).toEqual([
      [null, null, null, "Unsent"],
      [null, "2 images, video", null, null],
      [`${WORDS} 2`.length, null, null, "Edited"],
      [`${WORDS} 1`.length, null, 1, null],
    ]);
    expect(cells[0].chat).toEqual({ filter: "chat", value: String(chats["ada-t"]), label: "with Ada Sample" });
  });

  it("pages by key as it pages by counting, either way round", async () => {
    for (const dir of ["desc", "asc"]) {
      const whole = await rows(`dir=${dir}&limit=500`);
      const seen: string[] = [];
      let after: string | null = null;
      for (let offset = 0; offset < 600; offset += 150) {
        const page: RowsAnswer = await rows(`dir=${dir}&limit=150&offset=${offset}${after ? `&after=${after}` : ""}`);
        seen.push(...page.rows.map((r) => r.id));
        after = page.next;
      }
      expect(seen.slice(0, 500)).toEqual(whole.rows.map((r) => r.id));
    }
  });

  it("finds a page deep down by skipping whole months, as counting down would", () => {
    const tab = tabOf(tabsWith([MESSAGES]), "messages");
    const sql = (where: string, dir: string, offset: number) =>
      (db.prepare(`SELECT id FROM message m WHERE ${where} ORDER BY sent_at ${dir}, id ${dir} LIMIT 50 OFFSET ${offset}`).all() as Array<{ id: number }>).map((r) => String(r.id));
    const page = (filters: Filters, direction: "asc" | "desc", offset: number) =>
      rowsOf(viewer.reads, tab, filters, { offset, limit: 50, sort: "when", direction, after: null }).rows.map((r) => r.id);
    expect(page(NO_FILTERS, "desc", 2400)).toEqual(sql("1", "DESC", 2400));
    expect(page(NO_FILTERS, "asc", 2222)).toEqual(sql("1", "ASC", 2222));
    const texts = { ...NO_FILTERS, choices: { type: ["text"] }, to: dayStart("2026-03-02") };
    expect(page(texts, "desc", 2010)).toHaveLength(50);
    expect(page(texts, "desc", 2010)).toEqual(sql(`type = 'text' AND sent_at < ${dayStart("2026-03-02")}`, "DESC", 2010));
    expect(page(NO_FILTERS, "desc", 2620)).toEqual(sql("1", "DESC", 2620));
  });

  it("filters by app, chat kind, chat, who sent it, type, person and time, together", async () => {
    const total = async (query: string) => (await rows(`${quiet()}&${query}`)).total;
    expect(await total("app=telegram")).toBe(2);
    expect(await total("kind=direct")).toBe(6);
    expect(await total("kind=marketplace")).toBe(1);
    expect(await total("kind=group&kind=marketplace")).toBe(7);
    expect(await total(`chat=${chats.trio}`)).toBe(3);
    expect(await total(`chat=${chats.trio}&chat=${chats.untitled}`)).toBe(6);
    expect(await total(`chat=${chats.trio}&app=telegram`)).toBe(0);
    expect(await total("sender=you")).toBe(3);
    expect(await total("sender=none")).toBe(1);
    expect(await total("sender=others")).toBe(9);
    expect(await total("sender=you&sender=none")).toBe(4);
    expect(await total("type=text&type=link")).toBe(10);
    // A person: what they sent anywhere, and all of their one-to-one chats, on every app.
    expect(await total(`person=${ids.ada}`)).toBe(7);
    expect(await total(`person=${ids.ada}&sender=you`)).toBe(3);
    expect(await total(`person=${ids.bea}`)).toBe(3);
    expect(await total(`person=${ids.ada}&kind=group`)).toBe(1);
    expect((await rows(`from=${dayStart("2026-03-02")}&to=${dayStart("2026-03-03")}`)).total).toBe(2);
    // A chat that is not there leaves nothing, and is no harm beside one that is.
    expect(await total(`chat=90000&chat=${chats.trio}`)).toBe(3);
    expect(await total("chat=90000")).toBe(0);
  });

  it("charts them by month, counted or in characters, split by app, chat kind, sender or type", async () => {
    const months = await volume(`${quiet()}&grain=month`);
    expect(months.buckets.map((b) => [b.day, b.value])).toEqual([["2026-01-01", 3], ["2026-02-01", 3], ["2026-03-01", 7]]);
    expect(months.total).toBe(13);
    const all = await volume();
    expect(all.grain).toBe("week");
    expect(all.total).toBe(2613);
    const characters = await volume(`${quiet()}&grain=month&measure=characters&app=telegram`);
    expect(characters.buckets.at(-1)!.value).toBe(`${WORDS} 2612`.length + `${WORDS} 2613`.length);
    const byApp = await volume(`${quiet()}&grain=month&split=app`);
    expect(byApp.series).toEqual([{ value: "messenger", label: "Messenger", slot: 0 }, { value: "telegram", label: "Telegram", slot: 2 }]);
    expect(byApp.buckets.map((b) => b.parts)).toEqual([[3, 0], [3, 0], [5, 2]]);
    const byKind = await volume(`${quiet()}&grain=year&split=kind`);
    expect(byKind.series.map((s) => [s.label, byKind.buckets[0].parts![byKind.series.indexOf(s)]])).toEqual([["One-to-one", 6], ["Group", 6], ["Marketplace", 1]]);
    const byFrom = await volume(`${quiet()}&grain=year&split=sender`);
    expect(byFrom.series.map((s) => s.label)).toEqual(["You", "Others", "No one"]);
    expect(byFrom.buckets[0]).toMatchObject({ value: 13, parts: [3, 9, 1] });
    const byType = await volume(`${quiet()}&grain=year&split=type&person=${ids.ada}`);
    expect(Object.fromEntries(byType.series.map((s, i) => [s.label, byType.buckets[0].parts![i]]))).toEqual({ Text: 5, Media: 1, Link: 1 });
  });

  it("counts each filter's values under the others: a person by what they sent and their one-to-one chats", async () => {
    const counts = await facets(`${quiet()}&app=telegram&app=signal`);
    expect(counts.app).toEqual([
      { value: "messenger", label: "Messenger", count: 11 },
      { value: "telegram", label: "Telegram", count: 2 },
      { value: "signal", label: "Signal", count: 0 },
    ]);
    expect(counts.sender).toEqual([{ value: "others", label: "Others", count: 1 }, { value: "you", label: "You", count: 1 }]);
    expect(counts.person).toEqual([{ value: String(ids.ada), label: "Ada Sample", count: 2 }]);
    const all = await facets(quiet());
    expect(all.kind.map((v) => [v.label, v.count])).toEqual([["One-to-one", 6], ["Group", 6], ["Marketplace", 1]]);
    expect(all.person.map((v) => [v.label, v.count])).toEqual([["Ada Sample", 7], ["Bea Placeholder", 3], ["Cy Example", 1], ["Dana Seller", 1]]);
    expect(all.chat.map((v) => [v.label, v.count])).toEqual([
      ["with Ada Sample", 4], ["Trio", 3], ["Bea Placeholder, Cy Example", 3], ["with Ada Sample", 2], ["Dana · Lamp", 1],
    ]);
    expect(all.type.map((v) => v.value)).toEqual(["text", "link", "media", "sticker", "system"]);
    const chosen = await facets(`${quiet()}&chat=${chats.busy}&person=${ids.dana}`);
    expect(chosen.chat).toContainEqual({ value: String(chats.busy), label: "Busy", count: 0 });
  });

  it("keeps its answers until the archive changes", async () => {
    const query = `${quiet()}&kind=marketplace`;
    expect((await rows(query)).total).toBe(1);
    expect((await facets(quiet())).kind.at(-1)).toMatchObject({ value: "marketplace", count: 1 });
    importEvents("messenger", [message("lamp", "Me", at("2026-03-03", "15:05"))]);
    expect((await rows(query)).total).toBe(2);
    expect((await volume(`${query}&grain=year`)).total).toBe(2);
    expect((await facets(quiet())).kind.at(-1)).toMatchObject({ value: "marketplace", count: 2 });
  });

  it("refuses an after it did not give", async () => {
    let status = 0;
    const res = { writeHead: (code: number) => ((status = code), res), setHeader() {}, end() {} };
    await api({ method: "GET", url: "/life-archive/api/messages/rows?after=yesterday", headers: {} } as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(status).toBe(400);
  });
});

describe("the Messages tab's privacy", () => {
  it("answers every filter, split, measure and page on the read-only connection, which refuses a message's text", () => {
    const tab = tabOf(tabsWith([MESSAGES]), "messages");
    const choices: Record<string, string[]> = {
      app: ["messenger"], kind: ["group", "direct"], chat: [String(chats.trio), String(chats.ada)], sender: ["you", "others", "none"], type: ["text", "media"],
    };
    const everyFilter: Filters = { from: dayStart("2025-06-01"), to: dayStart("2026-06-01"), choices, person: ids.ada, search: null };
    for (const filters of [NO_FILTERS, everyFilter, ...Object.entries(choices).map(([key, values]) => ({ ...NO_FILTERS, choices: { [key]: values } }))]) {
      for (const direction of ["asc", "desc"] as const) {
        for (const offset of [0, 2100]) rowsOf(viewer.reads, tab, filters, { offset, limit: 100, sort: "when", direction, after: null });
      }
      for (const measure of ["messages", "characters"]) {
        for (const split of [null, ...tab.spec.splits]) volumeOf(viewer.reads, tab, filters, { grain: null, measure, split });
      }
      facetsOf(viewer.reads, tab, filters);
    }
    expect(() => archiveOf(viewer.reads).prepare("SELECT length(text) FROM message").all()).toThrow(/is prohibited/);
    expect(() => archiveOf(viewer.reads).prepare("SELECT raw_json FROM message").all()).toThrow(/is prohibited/);
    expect(() => archiveOf(viewer.reads).prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH 'words'").all()).toThrow();
  });

  it("never sends a message's text or record", () => {
    expect(said.length).toBeGreaterThan(30);
    for (const body of said) expect(body).not.toContain(WORDS);
  });
});
