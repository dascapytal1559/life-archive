// A made-up Grok Bot cache in the format of ~/Library/Application Support/Grok Bot/sand-client-persistence (see
// server/connectors/grok-bot/entries.ts), for the grok-bot connector's tests. Every text in it is made up.
//
//   <roster>.blob            the bots: pebble and juniper, by name
//   <pebble's chat>.blob     a chat-window prompt answered with words and a widget; a finished call (a greeting, the
//                            captain's streamed partials, an answer, one more thing); the call agent passing his words
//                            backstage and the bot's answer there; another agent's note and the bot's reply to it;
//                            an attachment and an app note (no turns); a prompt whose reply is still streaming
//   <juniper's chat>.blob    a reply whose prompt has already dropped out of the cache, then a prompt and its reply
//   <a draft>.blob           a composer draft: never read

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { blobName } from "../connectors/grok-bot/entries.ts";

export const ACCOUNT = "acct-sample";
export const BOTS = { pebble: "0b1c2d3e-0000-4000-8000-0000000000a1", juniper: "0b1c2d3e-0000-4000-8000-0000000000a2" };
export const CALL = "call-0000-a1";

export const GROK_TEXTS = {
  g1: "can you plan the vegetable beds for spring?",
  g1r: "Start with three raised beds along the fence.",
  widget: "which bed should get the tomatoes?",
  greeting: "hello, what are we looking at?",
  partial: "can you check",
  spoken: "can you check the watering times",
  answer: "Mornings, before eight.",
  more: "and the seedlings?",
  moreAnswer: "Every second day.",
  relayed: "the captain asks about the watering times",
  backstage: "tell him mornings before eight",
  agentNote: "the weather agent says rain on thursday",
  afterAgent: "Then skip thursday's watering.",
  g2: "write that down for me",
  streaming: "Writing it",
  streamed: "Writing it down now: mornings, every second day.",
  orphan: "That was the last of the seeds.",
  j1: "what should I read next?",
  j1r: "Try something about rivers.",
  notice: "a background task was stopped while it was still running",
  j1rMore: "Or something about mountains.",
  draft: "a draft the captain never sent",
};

const at = (time: string) => Date.parse(time);

/** Pebble's chat as the cache has it, its last reply still streaming (or finished, with `finished`). */
export function pebbleEntries({ finished = false } = {}): Array<Record<string, unknown>> {
  const T = GROK_TEXTS;
  return [
    { id: "a1", seq: 1, kind: "message", role: "user", content: T.g1, timestampMs: at("2026-03-03T09:00:00+11:00"), clientNonce: "n1" },
    { id: "a2", seq: 2, kind: "send-message", requestId: "r1", timestampMs: at("2026-03-03T09:00:04+11:00"), message: { type: "text", content: T.g1r } },
    { id: "a3", seq: 3, kind: "send-message", requestId: "r1", timestampMs: at("2026-03-03T09:00:05+11:00"), message: { type: "widget", widget: { prompt: T.widget, options: [{ label: "first", value: "1" }] } } },
    {
      id: "a4", seq: 4, kind: "voice-call", timestampMs: at("2026-03-03T09:20:00+11:00"),
      call: { callId: CALL, durationMs: 300_000, endedAtMs: at("2026-03-03T09:20:00+11:00"), turnCount: 5 },
      conversation: {
        turns: [
          { id: "t1", speaker: "assistant", text: T.greeting, atMs: at("2026-03-03T09:15:02+11:00") },
          { id: "t2", speaker: "user", text: T.partial, atMs: at("2026-03-03T09:15:10+11:00") },
          { id: "t3", speaker: "user", text: T.spoken, atMs: at("2026-03-03T09:15:12+11:00") },
          { id: "t4", speaker: "assistant", text: T.answer, atMs: at("2026-03-03T09:15:20+11:00") },
          { id: "t5", speaker: "user", text: T.more, atMs: at("2026-03-03T09:16:00+11:00") },
          { id: "t6", speaker: "assistant", text: T.moreAnswer, atMs: at("2026-03-03T09:16:05+11:00") },
        ],
        events: [], nudges: [], overheard: [], toolCalls: [],
      },
    },
    {
      id: "a5", seq: 5, kind: "message", role: "user", content: T.relayed, channel: `voice:${CALL}`, channelSender: "the call",
      fromUser: { name: "captain" }, author: { id: "u1", kind: "cursor_user", name: "the call" }, timestampMs: at("2026-03-03T09:15:13+11:00"),
    },
    { id: "a6", seq: 6, kind: "send-message", requestId: "r2", timestampMs: at("2026-03-03T09:15:16+11:00"), message: { type: "text", content: T.backstage, channel: `voice:${CALL}` } },
    { id: "a7", seq: 7, kind: "message", role: "user", content: T.agentNote, fromAgent: { id: "weather", name: "weather" }, timestampMs: at("2026-03-03T10:00:00+11:00") },
    { id: "a8", seq: 8, kind: "send-message", requestId: "r3", timestampMs: at("2026-03-03T10:00:03+11:00"), message: { type: "text", content: T.afterAgent } },
    { id: "a9", seq: 9, kind: "user-attachment", file_name: "beds.png", file_path: "/tmp/beds.png", timestampMs: at("2026-03-03T10:05:00+11:00") },
    { id: "a10", seq: 10, kind: "event", event: { type: "name-changed", from: "pebble", to: "pebble" }, timestampMs: at("2026-03-03T10:06:00+11:00") },
    { id: "a11", seq: 11, kind: "message", role: "user", content: T.g2, timestampMs: at("2026-03-03T10:10:00+11:00") },
    {
      id: "a12", seq: 12, kind: "send-message", requestId: "r4", timestampMs: at("2026-03-03T10:10:02+11:00"),
      ...(finished ? {} : { isStreaming: true }), message: { type: "text", content: finished ? T.streamed : T.streaming },
    },
  ];
}

export function juniperEntries(): Array<Record<string, unknown>> {
  const T = GROK_TEXTS;
  return [
    { id: "b7", seq: 7, kind: "send-message", requestId: "q1", timestampMs: at("2026-03-04T20:00:00+11:00"), message: { type: "text", content: T.orphan } },
    { id: "b8", seq: 8, kind: "message", role: "user", content: T.j1, timestampMs: at("2026-03-04T20:30:00+11:00") },
    { id: "b9", seq: 9, kind: "send-message", requestId: "q2", timestampMs: at("2026-03-04T20:30:05+11:00"), message: { type: "text", content: T.j1r } },
  ];
}

/** A key of the cache, for this account. */
export const keyFor = (rest: string) => `sand.client.slice.account.${ACCOUNT}.${rest}`;

/** Writes a bot's chat blob, as the app does: its entries whole. */
export async function writeChat(folder: string, bot: string, entries: Array<Record<string, unknown>>): Promise<string> {
  const file = join(folder, blobName(keyFor(`transcript.replicas.${bot}`)));
  await writeFile(file, JSON.stringify({ schemaVersion: 1, value: { entries, acceptedSequenceHint: null, persistedAt: 1 } }));
  return file;
}

/** Writes the made-up cache in `folder`; returns where each chat's blob is. */
export async function writeGrokBotFixture(folder: string): Promise<{ pebble: string; juniper: string }> {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, blobName(keyFor("roster.last-roster"))), JSON.stringify({
    schemaVersion: 1, value: { rows: [{ id: BOTS.pebble, name: "Pebble" }, { id: BOTS.juniper, name: "Juniper" }] },
  }));
  await writeFile(join(folder, blobName(keyFor("composer-drafts.0b1c2d3e-0000-4000-8000-0000000000d1"))), JSON.stringify({
    schemaVersion: 1, value: { text: GROK_TEXTS.draft },
  }));
  return { pebble: await writeChat(folder, BOTS.pebble, pebbleEntries()), juniper: await writeChat(folder, BOTS.juniper, juniperEntries()) };
}
