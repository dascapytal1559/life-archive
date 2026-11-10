import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moreOfTalk, PROJECT, SESSIONS, TEXTS, writeLlmSessionsFixture } from "../fixtures/llm-sessions.ts";
import { Archive } from "./index.ts";
import { BOTS, CALL, GROK_TEXTS, writeGrokBotFixture } from "../fixtures/grok-bot.ts";
import { ContentMovedError, latestLlmSession, readLlmContent } from "./llmContent.ts";

let dir: string;
let store: string;
let archive: Archive;
let files: Awaited<ReturnType<typeof writeLlmSessionsFixture>>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-events-"));
  store = join(dir, "claude-projects");
  files = await writeLlmSessionsFixture(store);
  archive = await Archive.open(join(dir, "data"));
  await archive.host.setEnabled("llm-sessions", true);
});

afterEach(async () => {
  archive.close();
  await rm(dir, { recursive: true, force: true });
});

const importSessions = () => archive.importHistory("llm-sessions", store, { settings: { projects: [PROJECT] } });
/** The archive's copy of a session's file, and how the index names it. */
const copyOf = (session: string) => join(dir, "data", "llm", "claude-code", "-home-sample-Projects-firstmate", `${session}.jsonl`);
const stored = (session: string) => `llm/claude-code/-home-sample-Projects-firstmate/${session}.jsonl`;
const content = (event: number) => readLlmContent(archive.coreDb, join(dir, "data"), event);
const eventOf = (nativeId: string) => (archive.coreDb.prepare("SELECT id FROM event WHERE native_id = ?").get(nativeId) as { id: number }).id;
const turn = (session: string, name: string) => `${session.slice(-4)}-${name}`;

describe("the event index", () => {
  it("indexes the captain's sessions, prompts and replies by Melbourne day, in one import that runs no people rules", async () => {
    const result = await importSessions();
    expect(result.counts.events).toEqual({
      llm_session: { added: 2, updated: 0, unchanged: 0 },
      llm_prompt: { added: 5, updated: 0, unchanged: 0 },
      llm_reply: { added: 4, updated: 0, unchanged: 0 },
    });
    expect(result.counts.tallies).toMatchObject({ "sessions run headless (sdk-cli), left out": 1 });
    expect(archive.events.summary()).toEqual([
      { origin: "claude-code", kind: "llm_prompt", count: 5, firstDay: "2026-03-01", lastDay: "2026-03-02" },
      { origin: "claude-code", kind: "llm_reply", count: 4, firstDay: "2026-03-01", lastDay: "2026-03-02" },
      // <continued> begins with a line repeated from the night before.
      { origin: "claude-code", kind: "llm_session", count: 2, firstDay: "2026-03-01", lastDay: "2026-03-01" },
    ]);

    const talk = eventOf(SESSIONS.talk);
    const p1 = eventOf(turn(SESSIONS.talk, "p1"));
    const firstDay = archive.events.day("2026-03-01");
    expect(firstDay.map((e) => [e.kind, e.subkind, e.size])).toEqual([
      ["llm_session", "cli", (await readFile(files.talk)).lastIndexOf(0x0a) + 1],
      ["llm_prompt", null, [...TEXTS.p1].length],
      ["llm_reply", "human", [...`${TEXTS.r1a}\n\n${TEXTS.r1b}`].length],
      ["llm_prompt", null, [...TEXTS.p2].length],
      ["llm_session", "cli", expect.any(Number)],
      ["llm_reply", "human", [...TEXTS.r2].length],
    ]);
    expect(firstDay[0]).toMatchObject({
      id: talk, origin: "claude-code", self: true, direction: null, hasContent: true, device: expect.any(String),
      at: Date.parse("2026-03-01T23:50:00+11:00"), atEnd: Date.parse("2026-03-02T00:09:06+11:00"),
      llm: { session: talk, project: PROJECT, model: "claude-opus-5-5", prompts: 4, replies: 3 },
    });
    expect(firstDay[1]).toMatchObject({ id: p1, self: true, direction: "out", llm: { session: talk, model: "claude-opus-5-5", images: 0, toolCalls: 0 } });
    expect(firstDay[2]).toMatchObject({ self: false, direction: "in", llm: { session: talk, toolCalls: 1, replyTo: p1 } });
    expect(firstDay[3].llm).toMatchObject({ images: 1, model: "claude-sonnet-5-5" });
    // Past midnight, the same session's turns are the next day's; a reply to a notice answers no prompt.
    expect(archive.events.day("2026-03-02", { kind: "llm_reply" }).map((e) => [e.subkind, e.llm?.replyTo])).toEqual([
      ["task-notification", null],
      ["human", eventOf(turn(SESSIONS.continued, "p5"))],
    ]);
    expect(archive.events.get(p1)).toEqual(firstDay[1]);
  });

  it("changes nothing when the same sessions are imported again, and brings a session that went on up to date", async () => {
    await importSessions();
    const snapshot = () => archive.coreDb.prepare("SELECT * FROM event ORDER BY id").all();
    const before = snapshot();
    expect((await importSessions()).counts.events).toEqual({
      llm_session: { added: 0, updated: 0, unchanged: 2 },
      llm_prompt: { added: 0, updated: 0, unchanged: 5 },
      llm_reply: { added: 0, updated: 0, unchanged: 4 },
    });
    expect(snapshot()).toEqual(before);

    // The reply that was being written is finished, and the captain asked one more thing.
    const whole = (await readFile(files.talk)).lastIndexOf(0x0a) + 1;
    await truncate(files.talk, whole);
    await appendFile(files.talk, moreOfTalk());
    const again = await importSessions();
    expect(again.counts.events).toEqual({
      llm_session: { added: 0, updated: 1, unchanged: 1 },
      // The prompt answered by tools alone now has its reply's model.
      llm_prompt: { added: 1, updated: 1, unchanged: 4 },
      llm_reply: { added: 2, updated: 0, unchanged: 4 },
    });
    const p4 = archive.events.get(eventOf(turn(SESSIONS.talk, "p4")))!;
    expect(p4.llm?.model).toBe("claude-opus-5-5");
    const session = archive.coreDb.prepare("SELECT first_source_id, last_source_id, at_end FROM event WHERE native_id = ?").get(SESSIONS.talk);
    expect(session).toEqual({ first_source_id: 1, last_source_id: 3, at_end: Date.parse("2026-03-02T00:20:04+11:00") });
    // The reply is read from its first entry, the tool call, to its words.
    const r4 = archive.events.get(eventOf(turn(SESSIONS.talk, "r4-tool")))!;
    expect(r4).toMatchObject({ kind: "llm_reply", size: [...TEXTS.writing].length, llm: { replyTo: p4.id, toolCalls: 1 } });
  });

  it("keeps no text of a session anywhere in the archive", async () => {
    await importSessions();
    const tables = (archive.coreDb.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
    const everything = JSON.stringify(tables.map((name) => archive.coreDb.prepare(`SELECT * FROM "${name}"`).all()));
    expect(everything).toContain(SESSIONS.talk);
    for (const [name, value] of Object.entries(TEXTS)) expect(everything.includes(value), name).toBe(false);
  });
});

describe("the content path for an LLM's events", () => {
  it("reads a prompt's, a reply's or a whole session's text back from the archive's copy of its file", async () => {
    await importSessions();
    const talk = eventOf(SESSIONS.talk);
    const r1 = eventOf(turn(SESSIONS.talk, "r1-think"));
    expect(content(r1)).toEqual({
      event: r1, kind: "llm_reply", session: { event: talk, project: PROJECT, file: copyOf(SESSIONS.talk) }, total: 1, offset: 0,
      turns: [{ event: r1, role: "reply", at: Date.parse("2026-03-01T23:50:05+11:00"), model: "claude-opus-5-5", text: `${TEXTS.r1a}\n\n${TEXTS.r1b}`, images: 0 }],
    });
    const whole = content(talk)!;
    expect(whole.turns.map((t) => [t.role, t.text, t.images])).toEqual([
      ["prompt", TEXTS.p1, 0],
      ["reply", `${TEXTS.r1a}\n\n${TEXTS.r1b}`, 0],
      ["prompt", TEXTS.p2, 1],
      ["reply", TEXTS.r2, 0],
      ["reply", TEXTS.r3, 0],
      ["prompt", TEXTS.p3, 0],
      ["prompt", TEXTS.p4, 0],
    ]);
    expect(content(9999)).toBeNull();
  });

  it("reads a session a page of turns at a time, each reply's tool calls among its words when asked", async () => {
    await importSessions();
    const talk = eventOf(SESSIONS.talk);
    const page = readLlmContent(archive.coreDb, join(dir, "data"), talk, { offset: 1, limit: 2, parts: true })!;
    expect([page.total, page.offset]).toEqual([7, 1]);
    expect(page.turns.map((t) => [t.role, t.parts])).toEqual([
      ["reply", [{ type: "tool", name: "Bash", input: "ls" }, { type: "text", text: TEXTS.r1a }, { type: "text", text: TEXTS.r1b }]],
      ["prompt", [{ type: "text", text: TEXTS.p2 }]],
    ]);
    // Without asking, no parts: the CLI's event-content prints (and redacts) the words alone.
    expect(readLlmContent(archive.coreDb, join(dir, "data"), talk, { offset: 6 })!.turns.map((t) => [t.text, t.parts])).toEqual([[TEXTS.p4, undefined]]);
  });

  it("refuses a copy that is not as it was imported, rather than read it wrong", async () => {
    await importSessions();
    const p2 = eventOf(turn(SESSIONS.talk, "p2"));
    const copy = copyOf(SESSIONS.talk);
    const text = await readFile(copy, "utf8");
    // A line more before it: the prompt's lines are no longer where the index says.
    await writeFile(copy, `{"type":"permission-mode","permissionMode":"auto"}\n${text}`);
    expect(() => content(p2)).toThrow(ContentMovedError);
    expect(() => content(p2)).toThrow(/is not as it was imported: import it again/);
    // Its entry where it was and as many bytes, with a text of another length than the index's ("鸟" is three bytes).
    await writeFile(copy, text.replace(TEXTS.p2, TEXTS.p2.replace("bird", "鸟b")));
    expect(() => content(p2)).toThrow(ContentMovedError);
    await rm(copy);
    expect(() => content(p2)).toThrow(ContentMovedError);
  });

  it("keeps reading a session after Claude Code deletes its file, from the archive's copy", async () => {
    await importSessions();
    const p1 = eventOf(turn(SESSIONS.talk, "p1"));
    expect(archive.coreDb.prepare("SELECT file FROM llm_session ORDER BY id").all()).toEqual([
      { file: stored(SESSIONS.talk) }, { file: stored(SESSIONS.continued) },
    ]);
    await rm(files.talk);
    expect(content(p1)!.turns[0].text).toBe(TEXTS.p1);
    // Importing again reads the copy: nothing in the index changes, and the copy stays.
    const again = await importSessions();
    expect(again.counts.events).toEqual({
      llm_session: { added: 0, updated: 0, unchanged: 2 },
      llm_prompt: { added: 0, updated: 0, unchanged: 5 },
      llm_reply: { added: 0, updated: 0, unchanged: 4 },
    });
    expect(again.counts.tallies).toMatchObject({ "conversations the app no longer has, read from the archive's copy": 1 });
    expect(content(p1)!.turns[0].text).toBe(TEXTS.p1);
  });

  it("moves a session imported before the copies onto its copy at the next import, its places unchanged", async () => {
    await importSessions();
    // As the index had it before: the session file where Claude Code keeps it, by its full path, and no copy.
    archive.coreDb.prepare("UPDATE llm_session SET file = ? WHERE file = ?").run(files.talk, stored(SESSIONS.talk));
    await rm(join(dir, "data", "llm"), { recursive: true });
    const places = () => archive.coreDb.prepare("SELECT line, byte_offset, byte_length FROM llm_turn ORDER BY id").all();
    const before = places();
    const p1 = eventOf(turn(SESSIONS.talk, "p1"));
    expect(content(p1)!.session.file).toBe(files.talk);

    const result = await importSessions();
    expect(result.counts.events.llm_session).toEqual({ added: 0, updated: 1, unchanged: 1 });
    expect(archive.coreDb.prepare("SELECT file FROM llm_session ORDER BY id").all()).toEqual([
      { file: stored(SESSIONS.talk) }, { file: stored(SESSIONS.continued) },
    ]);
    expect(places()).toEqual(before);
    // The copy is the session file to its last whole line, as the index read it.
    const source = await readFile(files.talk);
    expect(await readFile(copyOf(SESSIONS.talk))).toEqual(source.subarray(0, source.lastIndexOf(0x0a) + 1));
    expect(content(p1)!.session.file).toBe(copyOf(SESSIONS.talk));
    expect(content(p1)!.turns[0].text).toBe(TEXTS.p1);
  });
});

describe("an import of an agent's conversations", () => {
  it("keeps its bookmarks with what it read, in the same transaction", async () => {
    await importSessions();
    const cursor = JSON.parse((archive.coreDb.prepare("SELECT cursor_json FROM connector_state WHERE connector = 'llm-sessions'").get() as { cursor_json: string }).cursor_json);
    expect(cursor.files[`-home-sample-Projects-firstmate/${SESSIONS.talk}.jsonl`]).toBe((await readFile(join(dir, "data", "llm", "claude-code", "-home-sample-Projects-firstmate", `${SESSIONS.talk}.jsonl`))).length);
    expect(Object.keys(cursor.files)).toHaveLength(5);
  });

  it("reads Grok Bot's turns back from the archive's copy, and finds an agent's latest session", async () => {
    const cache = join(dir, "grok-cache");
    await writeGrokBotFixture(cache);
    await archive.host.setEnabled("grok-bot", true);
    await archive.importHistory("grok-bot", cache);
    await importSessions();
    const chat = eventOf(BOTS.pebble);
    expect(content(chat)!.turns.map((t) => [t.role, t.text])).toEqual([
      ["prompt", GROK_TEXTS.g1],
      ["reply", `${GROK_TEXTS.g1r}\n\n${GROK_TEXTS.widget}`],
      ["reply", GROK_TEXTS.afterAgent],
      ["prompt", GROK_TEXTS.g2],
      ["reply", GROK_TEXTS.streaming],
    ]);
    const answer = eventOf(`${BOTS.pebble}/${CALL}/t4`);
    expect(content(answer)!.turns.map((t) => t.text)).toEqual([GROK_TEXTS.answer]);
    // The latest of an origin, or of one way it ran: by its last turn, the index alone.
    expect(latestLlmSession(archive.coreDb, "grok-bot")).toBe(eventOf(BOTS.juniper));
    expect(latestLlmSession(archive.coreDb, "grok-bot", "call")).toBe(eventOf(`${BOTS.pebble}/${CALL}`));
    expect(latestLlmSession(archive.coreDb, "claude-code")).toBe(eventOf(SESSIONS.continued));
    expect(latestLlmSession(archive.coreDb, "codex")).toBeNull();
    // A copy changed under the index is refused, as Claude Code's are.
    const copy = join(dir, "data", "llm", "grok-bot", `${BOTS.pebble}.jsonl`);
    await writeFile(copy, (await readFile(copy, "utf8")).replace(GROK_TEXTS.answer, "x"));
    expect(() => content(answer)).toThrow(ContentMovedError);
  });
});
