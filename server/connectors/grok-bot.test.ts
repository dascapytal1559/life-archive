import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOTS, CALL, GROK_TEXTS, juniperEntries, pebbleEntries, writeChat, writeGrokBotFixture } from "../fixtures/grok-bot.ts";
import { runPromise } from "../effectRuntime.ts";
import { type ConnectorEvent, validateEvent } from "./contract.ts";
import { blobName, keyOf } from "./grok-bot/entries.ts";
import { grokBot } from "./grok-bot/read.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "friend-map-grok-bot-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const cache = () => join(dir, "cache");
const copies = () => join(dir, "data", "llm", "grok-bot");
const copyOf = (bot: string) => join(copies(), `${bot}.jsonl`);

async function read() {
  const events: ConnectorEvent[] = [];
  await runPromise(grokBot.history({ sources: [cache()], config: {}, mediaDir: join(dir, "media"), copiesDir: copies(), emit: async (event) => void events.push(event) }));
  const of = <K extends ConnectorEvent["kind"]>(kind: K) => events.filter((e): e is Extract<ConnectorEvent, { kind: K }> => e.kind === kind);
  return { events, of, tallies: Object.fromEntries(of("tally").map((t) => [t.name, t.count])) };
}

const ms = (time: string) => Date.parse(time);
const chars = (text: string) => [...text].length;
const pebble = (id: string) => `${BOTS.pebble}/${id}`;
const call = (id: string) => `${BOTS.pebble}/${CALL}/${id}`;

describe("grok-bot", () => {
  it("names its blobs as the app does: the key in unpadded lowercase base32", () => {
    const key = "sand.client.slice.account.acct-sample.transcript.replicas.0b1c2d3e-0000-4000-8000-0000000000a1";
    expect(keyOf(blobName(key))).toBe(key);
    expect(keyOf("not base32!.blob")).toBeNull();
    expect(keyOf("abc.json")).toBeNull();
  });

  it("makes each bot's chat window, each call and each call's backstage a session, never reading a draft", async () => {
    await writeGrokBotFixture(cache());
    const { events, of, tallies } = await read();
    expect(of("llm-session").map(({ id, entrypoint, project, startedAt, endedAt }) => ({ id, entrypoint, project, startedAt, endedAt }))).toEqual([
      { id: BOTS.pebble, entrypoint: "chat", project: "Pebble", startedAt: ms("2026-03-03T09:00:00+11:00"), endedAt: ms("2026-03-03T10:10:02+11:00") },
      { id: `${BOTS.pebble}/${CALL}`, entrypoint: "call", project: "Pebble", startedAt: ms("2026-03-03T09:15:00+11:00"), endedAt: ms("2026-03-03T09:20:00+11:00") },
      { id: `${BOTS.pebble}/voice:${CALL}`, entrypoint: "backstage", project: "Pebble", startedAt: ms("2026-03-03T09:15:13+11:00"), endedAt: ms("2026-03-03T09:15:16+11:00") },
      { id: BOTS.juniper, entrypoint: "chat", project: "Juniper", startedAt: ms("2026-03-04T20:00:00+11:00"), endedAt: ms("2026-03-04T20:30:05+11:00") },
    ]);
    expect(of("llm-session")[0].file).toBe(copyOf(BOTS.pebble));
    const T = GROK_TEXTS;
    expect(of("llm-turn").map(({ id, session, role, answers, replyTo, chars }) => ({ id, session, role, answers, replyTo, chars }))).toEqual([
      // The chat window: words and a widget's question are one reply; another agent's note starts a turn that is no prompt.
      { id: pebble("a1"), session: BOTS.pebble, role: "prompt", answers: undefined, replyTo: undefined, chars: chars(T.g1) },
      { id: pebble("a2"), session: BOTS.pebble, role: "reply", answers: "human", replyTo: pebble("a1"), chars: chars(`${T.g1r}\n\n${T.widget}`) },
      { id: pebble("a8"), session: BOTS.pebble, role: "reply", answers: "agent", replyTo: undefined, chars: chars(T.afterAgent) },
      { id: pebble("a11"), session: BOTS.pebble, role: "prompt", answers: undefined, replyTo: undefined, chars: chars(T.g2) },
      { id: pebble("a12"), session: BOTS.pebble, role: "reply", answers: "human", replyTo: pebble("a11"), chars: chars(T.streaming) },
      // The call: the bot opens it; the captain's partials are one prompt, its last's words.
      { id: call("t1"), session: `${BOTS.pebble}/${CALL}`, role: "reply", answers: "call-start", replyTo: undefined, chars: chars(T.greeting) },
      { id: call("t3"), session: `${BOTS.pebble}/${CALL}`, role: "prompt", answers: undefined, replyTo: undefined, chars: chars(T.spoken) },
      { id: call("t4"), session: `${BOTS.pebble}/${CALL}`, role: "reply", answers: "human", replyTo: call("t3"), chars: chars(T.answer) },
      { id: call("t5"), session: `${BOTS.pebble}/${CALL}`, role: "prompt", answers: undefined, replyTo: undefined, chars: chars(T.more) },
      { id: call("t6"), session: `${BOTS.pebble}/${CALL}`, role: "reply", answers: "human", replyTo: call("t5"), chars: chars(T.moreAnswer) },
      // Backstage: the call agent passing his words on, and the bot's answer.
      { id: pebble("a5"), session: `${BOTS.pebble}/voice:${CALL}`, role: "prompt", answers: undefined, replyTo: undefined, chars: chars(T.relayed) },
      { id: pebble("a6"), session: `${BOTS.pebble}/voice:${CALL}`, role: "reply", answers: "human", replyTo: pebble("a5"), chars: chars(T.backstage) },
      // Juniper: a reply whose prompt dropped out of the cache before the archive saw it.
      { id: `${BOTS.juniper}/b7`, session: BOTS.juniper, role: "reply", answers: "unseen", replyTo: undefined, chars: chars(T.orphan) },
      { id: `${BOTS.juniper}/b8`, session: BOTS.juniper, role: "prompt", answers: undefined, replyTo: undefined, chars: chars(T.j1) },
      { id: `${BOTS.juniper}/b9`, session: BOTS.juniper, role: "reply", answers: "human", replyTo: `${BOTS.juniper}/b8`, chars: chars(T.j1r) },
    ]);
    expect(tallies).toEqual({ "conversations copied into the archive": 2 });
    // Every event is valid and none carries a text; the copies are the two chats alone, with no draft in them.
    for (const event of events) expect(validateEvent(event), event.kind).toEqual({ event });
    const written = JSON.stringify(events);
    for (const [name, value] of Object.entries(GROK_TEXTS)) expect(written.includes(value), name).toBe(false);
    expect((await readdir(copies())).sort()).toEqual([`${BOTS.pebble}.jsonl`, `${BOTS.juniper}.jsonl`].sort());
    for (const bot of Object.values(BOTS)) expect(await readFile(copyOf(bot), "utf8")).not.toContain(GROK_TEXTS.draft);
    expect(of("checkpoint")).toEqual([{ kind: "checkpoint", cursor: { files: { [`${BOTS.pebble}.jsonl`]: expect.any(Number), [`${BOTS.juniper}.jsonl`]: expect.any(Number) } } }]);
  });

  it("keeps every entry it has seen, as the cache moves on, and each entry again when the app changes it", async () => {
    const blobs = await writeGrokBotFixture(cache());
    await read();
    const before = await readFile(copyOf(BOTS.pebble), "utf8");
    expect(before.split("\n").filter(Boolean)).toHaveLength(12);

    // The cache's window moves past the first three entries, and the streaming reply is finished.
    await writeChat(cache(), BOTS.pebble, pebbleEntries({ finished: true }).slice(3));
    const later = await read();
    expect(later.tallies["conversations that grew, their copies brought up to date"]).toBe(1);
    const after = await readFile(copyOf(BOTS.pebble), "utf8");
    // What was there stays as it was; the finished reply is one line more.
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length).split("\n").filter(Boolean).map((line) => JSON.parse(line).id)).toEqual(["a12"]);
    // The turns of entries the cache has dropped are still read, from the copy; the finished reply is as long as it now is.
    const turns = later.of("llm-turn").filter((t) => t.session === BOTS.pebble);
    expect(turns.map((t) => t.id)).toContain(pebble("a1"));
    expect(turns.find((t) => t.id === pebble("a12"))!.chars).toBe(chars(GROK_TEXTS.streamed));

    // The app drops the bot: its copy is read as before.
    await rm(blobs.juniper);
    const gone = await read();
    expect(gone.tallies["conversations the app no longer has, read from the archive's copy"]).toBe(1);
    expect(gone.of("llm-turn").filter((t) => t.session === BOTS.juniper)).toHaveLength(3);
  });

  it("reads past the app's notice among a reply's entries, which is no turn and never splits the reply", async () => {
    await writeGrokBotFixture(cache());
    const T = GROK_TEXTS;
    await writeChat(cache(), BOTS.juniper, [
      ...juniperEntries(),
      { id: "b10", seq: 10, kind: "notice", text: T.notice, timestampMs: ms("2026-03-04T20:30:06+11:00") },
      { id: "b11", seq: 11, kind: "send-message", requestId: "q2", timestampMs: ms("2026-03-04T20:30:08+11:00"), message: { type: "text", content: T.j1rMore } },
    ]);
    const { events, of, tallies } = await read();
    expect(tallies).toEqual({ "conversations copied into the archive": 2 });
    const turns = of("llm-turn").filter((t) => t.session === BOTS.juniper);
    expect(turns.map(({ id, role, chars }) => ({ id, role, chars }))).toEqual([
      { id: `${BOTS.juniper}/b7`, role: "reply", chars: chars(T.orphan) },
      { id: `${BOTS.juniper}/b8`, role: "prompt", chars: chars(T.j1) },
      { id: `${BOTS.juniper}/b9`, role: "reply", chars: chars(`${T.j1r}\n\n${T.j1rMore}`) },
    ]);
    // The notice is kept in the copy, as every entry is, and its text is in no event.
    expect(await readFile(copyOf(BOTS.juniper), "utf8")).toContain(T.notice);
    expect(JSON.stringify(events).includes(T.notice)).toBe(false);
  });

  it("reads the bot's email draft as a reply of its own, never its subject, recipients or text", async () => {
    await writeGrokBotFixture(cache());
    const draft = { type: "email-draft", subject: "Picnic on Saturday", to: ["wren@example.com"], body: "Shall we meet at the lake?" };
    await writeChat(cache(), BOTS.juniper, [
      ...juniperEntries(),
      { id: "b10", seq: 10, kind: "message", role: "user", content: GROK_TEXTS.j1, timestampMs: ms("2026-03-04T20:31:00+11:00") },
      { id: "b11", seq: 11, kind: "send-message", requestId: "q3", timestampMs: ms("2026-03-04T20:31:05+11:00"), message: draft },
    ]);
    const { events, of, tallies } = await read();
    expect(tallies).toEqual({ "conversations copied into the archive": 2 });
    const turn = of("llm-turn").find((t) => t.id === `${BOTS.juniper}/b11`);
    expect(turn).toMatchObject({ role: "reply", chars: 0, replyTo: `${BOTS.juniper}/b10` });
    for (const text of [draft.subject, draft.to[0], draft.body]) expect(JSON.stringify(events).includes(text)).toBe(false);
  });

  it("reads the bot's connector card as part of its reply, with no words, never its fields", async () => {
    await writeGrokBotFixture(cache());
    const T = GROK_TEXTS;
    const card = { type: "connector", connector: "seed-catalogue", serverId: "server-sample-1", variant: "sample-variant" };
    await writeChat(cache(), BOTS.juniper, [
      ...juniperEntries(),
      { id: "b10", seq: 10, kind: "send-message", requestId: "q2", timestampMs: ms("2026-03-04T20:30:06+11:00"), message: card },
      { id: "b11", seq: 11, kind: "send-message", requestId: "q2", timestampMs: ms("2026-03-04T20:30:08+11:00"), message: { type: "text", content: T.j1rMore } },
      // A card alone is no turn, as an approval is not; the chat goes on after it.
      { id: "b12", seq: 12, kind: "message", role: "user", content: T.g2, timestampMs: ms("2026-03-04T20:31:00+11:00") },
      { id: "b13", seq: 13, kind: "send-message", requestId: "q3", timestampMs: ms("2026-03-04T20:31:05+11:00"), message: card },
    ]);
    const { events, of, tallies } = await read();
    expect(tallies).toEqual({ "conversations copied into the archive": 2 });
    const turns = of("llm-turn").filter((t) => t.session === BOTS.juniper);
    expect(turns.map(({ id, role, chars }) => ({ id, role, chars }))).toEqual([
      { id: `${BOTS.juniper}/b7`, role: "reply", chars: chars(T.orphan) },
      { id: `${BOTS.juniper}/b8`, role: "prompt", chars: chars(T.j1) },
      { id: `${BOTS.juniper}/b9`, role: "reply", chars: chars(`${T.j1r}\n\n${T.j1rMore}`) },
      { id: `${BOTS.juniper}/b12`, role: "prompt", chars: chars(T.g2) },
    ]);
    // Its session's end still counts the card; its fields are kept in the copy and are in no event.
    expect(of("llm-session").find((s) => s.id === BOTS.juniper)?.endedAt).toBe(ms("2026-03-04T20:31:05+11:00"));
    expect(await readFile(copyOf(BOTS.juniper), "utf8")).toContain(card.serverId);
    for (const value of [card.connector, card.serverId, card.variant]) expect(JSON.stringify(events).includes(value)).toBe(false);
  });

  it("still refuses a send-message of a type it does not know", async () => {
    await writeGrokBotFixture(cache());
    await writeChat(cache(), BOTS.juniper, [
      ...juniperEntries(),
      { id: "b10", seq: 10, kind: "send-message", requestId: "q3", timestampMs: 1, message: { type: "calendar-invite" } },
    ]);
    const { of, tallies } = await read();
    expect(tallies["conversations not read, a chat with a send-message of a type the archive does not know (calendar-invite)"]).toBe(1);
    expect(of("llm-session").map((s) => s.id)).not.toContain(BOTS.juniper);
  });

  it("keeps but does not read a chat with an entry it does not know, and never guesses", async () => {
    await writeGrokBotFixture(cache());
    await writeChat(cache(), BOTS.juniper, [...juniperEntries(), { id: "b10", seq: 10, kind: "poll", timestampMs: 1 }]);
    const { of, tallies } = await read();
    expect(tallies["conversations not read, a chat with an entry of a kind the archive does not know (poll)"]).toBe(1);
    expect(of("llm-session").map((s) => s.id)).not.toContain(BOTS.juniper);
    // Its entries are kept all the same; its bookmark is left for when the archive knows the kind.
    expect((await readFile(copyOf(BOTS.juniper), "utf8")).split("\n").filter(Boolean)).toHaveLength(4);
    expect(Object.keys((of("checkpoint")[0].cursor as { files: object }).files)).toEqual([`${BOTS.pebble}.jsonl`]);

    // A file that is no chat as the archive knows it is not even copied.
    await writeFile(join(cache(), blobName(`sand.client.slice.account.acct-sample.transcript.replicas.${BOTS.juniper}`)), JSON.stringify({ schemaVersion: 2, value: {} }));
    expect((await read()).tallies["conversations not read, a chat whose file is not as the archive knows it (schemaVersion 1, value.entries)"]).toBe(1);
  });
});
