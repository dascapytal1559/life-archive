// The Grok calls job on a made-up Grok Bot cache (it was rituals' tests/voice-calls.test.ts while the job was
// rituals'). Every bot, call and word here is fictional. The tests run in Melbourne (testing-data/settings.json).
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeBase32, type Turn } from "./cache.ts";
import { collapseTurns, isoformat, logicalDate, zoneAbbreviation } from "./format.ts";
import { grokCallsRun, type RunOptions } from "./round.ts";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const encodeBase32 = (text: string): string => {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of new TextEncoder().encode(text)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >> bits) & 31];
    }
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
};

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const fileSha = (file: string) => sha(fs.readFileSync(file));
const mode = (file: string) => fs.statSync(file).mode & 0o777;

const turn = (id: string, speaker: string, text: string, atMs: number): Turn => ({ id, speaker, text, atMs });

// 2026-10-15T01:00:00+11:00, after midnight in Melbourne summer time.
const LATE = Date.UTC(2026, 9, 14, 14, 0, 0);

const call = (callId: string, startMs: number, turns: Array<Turn>) => ({
  kind: "voice-call",
  id: `voice-call-${callId}`,
  timestampMs: startMs + 60_000,
  call: { callId, durationMs: 60_000, endedAtMs: startMs + 60_000, ending: "hung-up", turnCount: turns.length },
  conversation: { turns, nudges: [], events: [], toolCalls: [], overheard: [] },
  seq: 1,
});

const writeBlob = (dir: string, key: string, value: unknown): void =>
  fs.writeFileSync(path.join(dir, encodeBase32(key) + ".blob"), JSON.stringify({ schemaVersion: 1, value }));

/** A cache folder with two bots, one of them unnamed in the roster, and one call still in progress. */
const fakeCache = (root: string): string => {
  const cache = path.join(root, "cache");
  fs.mkdirSync(cache);
  const account = "sand.client.slice.account.example%7Cuser_1";
  writeBlob(cache, `${account}.roster.last-roster`, { rows: [{ id: "agent-a", name: "Pal" }] });
  writeBlob(cache, `${account}.transcript.replicas.agent-a`, {
    entries: [
      { kind: "message", id: "m1", content: "not a call" },
      call("call-0000aaaa-1111-2222-3333-444455556666", LATE, [
        turn("t1", "user", "I walked", LATE + 1000),
        turn("t2", "user", "I walked to the park.", LATE + 2000),
        turn("t3", "user", "I walked to the park and fed ducks", LATE + 3000),
        turn("t4", "assistant", "Lovely.", LATE + 4000),
      ]),
      { ...call("call-in-progress", LATE, []), call: { callId: "call-in-progress" } },
    ],
  });
  writeBlob(cache, `${account}.transcript.replicas.agent-b`, {
    entries: [call("call-bbbb", Date.UTC(2026, 9, 15, 4, 0, 0), [turn("u1", "user", "Hello", 0)])],
  });
  return cache;
};

const listCache = (cache: string): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(cache).map((name) => [name, fileSha(path.join(cache, name))]));

const pass = (options: RunOptions) => Effect.runPromise(grokCallsRun(options));
const refusal = (options: RunOptions) => Effect.runPromise(Effect.flip(grokCallsRun(options))).then((error) => error.message);

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-calls-"));
});

afterEach(() => {
  fs.chmodSync(path.join(root), 0o700);
  if (fs.existsSync(path.join(root, "cache"))) fs.chmodSync(path.join(root, "cache"), 0o700);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the Grok calls job", () => {
  it("decodes the cache's unpadded base32 keys", () => {
    expect(decodeBase32(encodeBase32("sand.client.slice.ui-layout"))).toBe("sand.client.slice.ui-layout");
    expect(decodeBase32("not base32!")).toBeNull();
  });

  it("joins streamed partials, including a revised tail, and keeps separate turns", () => {
    const utterances = collapseTurns([
      turn("a", "user", "So today", 10),
      turn("b", "user", "So today I went.", 20),
      turn("c", "user", "So today I went to work and then", 30),
      turn("d", "assistant", "Go on.", 40),
      turn("e", "user", "Completely different topic", 50),
      turn("f", "user", "Another thing entirely", 60),
    ]);
    expect(utterances).toEqual([
      { speaker: "user", text: "So today I went to work and then", at_ms: 10, turn_ids: ["a", "b", "c"] },
      { speaker: "assistant", text: "Go on.", at_ms: 40, turn_ids: ["d"] },
      { speaker: "user", text: "Completely different topic", at_ms: 50, turn_ids: ["e"] },
      { speaker: "user", text: "Another thing entirely", at_ms: 60, turn_ids: ["f"] },
    ]);
  });

  it("files a call before 06:00 under the previous evening, in Melbourne time across DST", () => {
    expect(logicalDate(LATE).date).toBe("2026-10-14");
    expect(logicalDate(Date.UTC(2026, 9, 14, 18, 59, 59)).date).toBe("2026-10-14"); // 05:59:59 AEDT
    expect(logicalDate(Date.UTC(2026, 9, 14, 19, 0, 0)).date).toBe("2026-10-15"); // 06:00 AEDT
    expect(logicalDate(Date.UTC(2026, 9, 15, 0, 59, 59)).date).toBe("2026-10-15"); // 11:59:59 AEDT
    expect(logicalDate(Date.UTC(2026, 9, 15, 1, 0, 0)).date).toBe("2026-10-15"); // 12:00 AEDT
    expect(logicalDate(Date.UTC(2026, 5, 14, 19, 59, 0)).date).toBe("2026-06-14"); // 05:59 AEST
    expect(logicalDate(Date.UTC(2026, 5, 14, 20, 0, 0)).date).toBe("2026-06-15"); // 06:00 AEST
    expect(logicalDate(Date.UTC(2026, 9, 14, 18, 59, 59)).basis).toBe(
      "Call started 2026-10-15 05:59 Melbourne time, before that day's 06:00 close, so it belongs to the previous evening (mechanical rule; context was not read).",
    );
    expect(logicalDate(Date.UTC(2026, 9, 14, 19, 0, 0)).basis).toBe("Call started 2026-10-15 06:00 Melbourne time, from 06:00, so it belongs to that day.");
  });

  it("writes instants and the zone as rituals did (Python's isoformat and %Z), so a saved file is never seen as changed", () => {
    expect(isoformat(LATE)).toBe("2026-10-15T01:00:00+11:00");
    expect(isoformat(LATE + 123)).toBe("2026-10-15T01:00:00.123000+11:00");
    expect(isoformat(Date.UTC(2026, 5, 14, 20, 0, 0))).toBe("2026-06-15T06:00:00+10:00");
    expect(zoneAbbreviation(LATE)).toBe("AEDT");
    expect(zoneAbbreviation(Date.UTC(2026, 5, 14, 20, 0, 0))).toBe("AEST");
  });

  it("writes each call once, privately, and never touches the cache", async () => {
    const cache = fakeCache(root);
    const journals = path.join(root, "journals");
    fs.mkdirSync(path.join(journals, "raw"), { recursive: true });
    const before = listCache(cache);
    fs.chmodSync(cache, 0o500);
    const options = { cacheDir: cache, journalsDir: journals, provider: "example-bot" };
    const first = await pass(options);
    expect(first).toMatchObject({ ok: true, cached_calls: 2, unchanged: 0 });
    const folder = path.join(journals, "raw", "2026-10-14");
    const id = "voice-0000aaaa-1111-2222-3333-444455556666";
    expect(mode(folder)).toBe(0o700);
    expect(fs.readdirSync(folder).toSorted()).toEqual([`${id}.source.json`, `${id}.transcript.json`, `${id}.transcript.md`]);
    for (const name of fs.readdirSync(folder)) expect(mode(path.join(folder, name))).toBe(0o600);

    const transcript = JSON.parse(fs.readFileSync(path.join(folder, `${id}.transcript.json`), "utf8"));
    expect(transcript.bot).toEqual({ name: "Pal", agent_id: "agent-a" });
    expect(transcript.cache_entry.conversation.turns).toHaveLength(4);
    expect(transcript.utterances.map((u: { text: string }) => u.text)).toEqual(["I walked to the park and fed ducks", "Lovely."]);
    const sidecar = JSON.parse(fs.readFileSync(path.join(folder, `${id}.source.json`), "utf8"));
    expect(sidecar).toMatchObject({
      source_id: id,
      provider: "example-bot",
      channel: "voice-call",
      verbatim: true,
      sent_at: "2026-10-15T01:00:00+11:00",
      logical_ritual_date: "2026-10-14",
      raw_file: `${id}.transcript.json`,
      raw_sha256: fileSha(path.join(folder, `${id}.transcript.json`)),
    });
    const markdown = fs.readFileSync(path.join(folder, `${id}.transcript.md`), "utf8");
    expect(markdown).toContain("**User** (01:00:01): I walked to the park and fed ducks");
    expect(markdown).toContain("**Pal** (01:00:04): Lovely.");
    expect(fs.readFileSync(path.join(journals, "raw", "2026-10-15", "voice-bbbb.transcript.md"), "utf8")).toContain("# Voice call with Assistant, 2026-10-15 15:00");

    expect(await pass(options)).toEqual({ ok: true, cached_calls: 2, unchanged: 2, saved: [] });
    // A saved file is history: an edited copy is kept and only flagged, and a missing one is filled in.
    const edited = path.join(folder, `${id}.transcript.json`);
    fs.writeFileSync(edited, "kept as is\n");
    fs.rmSync(path.join(folder, `${id}.transcript.md`));
    const third = await pass(options);
    expect(third.saved).toEqual([expect.objectContaining({ source_id: id, written: [`${id}.transcript.md`], differs: true })]);
    expect(fs.readFileSync(edited, "utf8")).toBe("kept as is\n");
    fs.chmodSync(cache, 0o700);
    expect(listCache(cache)).toEqual(before);
  });

  it("refuses a journal home without raw/, a bad provider and an unsafe call id", async () => {
    const cache = fakeCache(root);
    const journals = path.join(root, "journals");
    const failure = (provider: string) => refusal({ cacheDir: cache, journalsDir: journals, provider });
    expect(await failure("example-bot")).toMatch(/No raw folder/);
    expect(fs.existsSync(journals)).toBe(false);
    fs.mkdirSync(path.join(journals, "raw"), { recursive: true });
    expect(await failure("Example Bot")).toMatch(/lowercase slug/);
    writeBlob(cache, "sand.client.slice.account.x.transcript.replicas.agent-c", { entries: [call("call-../../escape", LATE, [])] });
    expect(await failure("example-bot")).toMatch(/Unsafe call id/);
    expect(fs.readdirSync(path.join(journals, "raw"))).toEqual([]);
  });
});
