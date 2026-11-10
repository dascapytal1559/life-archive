// The files one Grok Bot call becomes in the journal (round.ts writes them), under `raw/<journal day>/`: the verbatim
// `voice-<id>.transcript.json` (the app's call record unchanged, with the streamed partials joined into utterances), a
// readable `voice-<id>.transcript.md`, and the `voice-<id>.source.json` record of rituals' journal contract
// (journal-source-v1, modules/rituals/HANDOFF.md's "Journal"), which the journal's agent (firstmate, where it is set
// up) and rituals' check-ins read.
//
// They keep the shape the job wrote when it was rituals' (until 8 November 2026): an instant as Python's isoformat()
// writes it (to the microsecond when it has a fraction), and the zone's name as Python's strftime('%Z') printed it. But
// a call is dated, and filed under its journal day, in the archive's time zone (`timeZone` in its settings, the SDK's
// TIME_ZONE), which now wins over RITUAL_TIME_ZONE, the zone rituals' job went by: where the two differ, a call's files
// are not what rituals' job wrote. A file already saved is never replaced, and one the cache would now render
// differently is flagged `differs`.

import { createHash } from "node:crypto";
import { Effect } from "effect";
import { TIME_ZONE, zonePlace } from "../../../../sdk/server.ts";
import { DAY_STARTS_AT, journalDay } from "../../src/day.ts";
import { type CachedCall, type GrokCallsRefused, isRecord, refused, type Turn } from "./cache.ts";

export interface Utterance {
  readonly speaker: string;
  readonly text: string;
  readonly at_ms: number;
  readonly turn_ids: ReadonlyArray<string>;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

interface ZoneFormats {
  readonly clock: Intl.DateTimeFormat;
  /** Each English locale names only its own region's zones ("AEDT" in en-AU, "EST" in en-US) and writes any other as "GMT+11". */
  readonly names: ReadonlyArray<Intl.DateTimeFormat>;
}

const formats = new Map<string, ZoneFormats>();

/** The formatters for the archive's zone, made the first time it is asked for (after the settings set it). */
function zoneFormats(): ZoneFormats {
  let made = formats.get(TIME_ZONE);
  if (!made) {
    made = {
      clock: new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      names: ["en-US", "en-GB", "en-AU", "en-CA", "en-NZ", "en-IN", "en-ZA"].map((locale) => new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, timeZoneName: "short" })),
    };
    formats.set(TIME_ZONE, made);
  }
  return made;
}

/** The zone's offset from UTC at an instant, in seconds (36000 in Melbourne's winter, 39600 in its summer). */
function offsetSeconds(ms: number): number {
  const part = Object.fromEntries(zoneFormats().clock.formatToParts(ms).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) / 1000 - Math.floor(ms / 1000);
}

/** An instant's local calendar fields in the archive's zone. */
export function localParts(ms: number): { date: string; hour: number; minute: number; second: number; millis: number; offset: number } {
  const offset = offsetSeconds(ms);
  const wall = new Date(ms + offset * 1000);
  return {
    date: wall.toISOString().slice(0, 10),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
    millis: wall.getUTCMilliseconds(),
    offset,
  };
}

/** An instant as Python's datetime.isoformat() wrote it in the archive's zone: microseconds only when nonzero, offset +HH:MM. */
export function isoformat(ms: number): string {
  const p = localParts(ms);
  const magnitude = Math.abs(p.offset);
  const offset = `${p.offset < 0 ? "-" : "+"}${pad(Math.floor(magnitude / 3600))}:${pad(Math.floor((magnitude % 3600) / 60))}${magnitude % 60 ? `:${pad(magnitude % 60)}` : ""}`;
  return `${p.date}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${p.millis ? `.${pad(p.millis * 1000, 6)}` : ""}${offset}`;
}

/** The zone's abbreviation at an instant ("AEST" or "AEDT" in Melbourne): the first English locale that names it. */
export function zoneAbbreviation(ms: number): string {
  const names = zoneFormats().names.map((format) => format.formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? "");
  return names.find((name) => name !== "" && !/^(GMT|UTC)[+-]/.test(name)) ?? (names[0] as string);
}

/**
 * Whether user turn `b` is a later streamed version of user turn `a`: longer, and agreeing with `a` except for a short
 * revised tail (the transcriber rewrites its last few words as speech goes on).
 */
export const extendsTurn = (a: string, b: string): boolean => {
  if (b.length < a.length) return false;
  let common = 0;
  while (common < a.length && a[common] === b[common]) common += 1;
  const tail = a.slice(common).trim();
  return common * 2 >= a.length && (tail === "" || tail.split(/\s+/).length <= 8);
};

/**
 * One utterance per spoken run: a user turn is dropped when the next turn is a user turn that extends it, keeping the
 * final text and the time the first partial arrived. Assistant turns stay.
 */
export const collapseTurns = (turns: ReadonlyArray<Turn>): Array<Utterance> => {
  const utterances: Array<Utterance> = [];
  let pending: { first: Turn; ids: Array<string> } | null = null;
  turns.forEach((turn, index) => {
    const next = turns[index + 1];
    if (turn.speaker === "user" && next?.speaker === "user" && extendsTurn(turn.text, next.text)) {
      pending ??= { first: turn, ids: [] };
      pending.ids.push(turn.id);
      return;
    }
    const first = pending?.first ?? turn;
    utterances.push({ speaker: turn.speaker, text: turn.text, at_ms: first.atMs, turn_ids: [...(pending?.ids ?? []), turn.id] });
    pending = null;
  });
  return utterances;
};

/** The journal day of a call: its local start date, or the day before when it starts before 06:00. */
export const logicalDate = (startMs: number): { date: string; basis: string } => {
  const parts = localParts(startMs);
  const clock = `${pad(parts.hour)}:${pad(parts.minute)}`;
  const date = journalDay(parts.date, parts.hour);
  return date === parts.date
    ? { date, basis: `Call started ${parts.date} ${clock} ${zonePlace()} time, from ${DAY_STARTS_AT}, so it belongs to that day.` }
    : {
        date,
        basis: `Call started ${parts.date} ${clock} ${zonePlace()} time, before that day's ${DAY_STARTS_AT} close, so it belongs to the previous evening (mechanical rule; context was not read).`,
      };
};

const asTurns = (value: unknown): Array<Turn> =>
  Array.isArray(value)
    ? value.filter((t): t is Turn => isRecord(t) && typeof t.id === "string" && typeof t.speaker === "string" && typeof t.text === "string" && typeof t.atMs === "number")
    : [];

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

const clock = (ms: number): string => {
  const p = localParts(ms);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
};

const duration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export interface CallFiles {
  readonly sourceId: string;
  readonly date: string;
  readonly transcriptJson: string;
  readonly transcriptMd: string;
  /** The source record for a given extraction instant (the only part that is not deterministic). */
  readonly sidecar: (extractedAt: string) => string;
}

/** The three files for one call. Fails for an id that is not safe as a file name. */
export const renderCall = (call: CachedCall, provider: string): Effect.Effect<CallFiles, GrokCallsRefused> =>
  Effect.gen(function* () {
    const record = call.entry.call as Record<string, unknown>;
    const callId = record.callId as string;
    const id = callId.replace(/^call-/, "");
    if (!SAFE_ID.test(id)) return yield* Effect.fail(refused(`Unsafe call id ${JSON.stringify(callId)}`));
    const sourceId = `voice-${id}`;
    const conversation = isRecord(call.entry.conversation) ? call.entry.conversation : {};
    const turns = asTurns(conversation.turns);
    const endedMs = record.endedAtMs as number;
    const durationMs = typeof record.durationMs === "number" ? record.durationMs : 0;
    const startMs = endedMs - durationMs;
    const { date, basis } = logicalDate(startMs);
    const utterances = collapseTurns(turns);
    const bot = call.botName ?? "Assistant";
    const transcriptJson = json({
      schema: "voice-call-transcript-v1",
      source_id: sourceId,
      provider,
      bot: { name: call.botName, agent_id: call.agentId },
      call_id: callId,
      started_at: isoformat(startMs),
      ended_at: isoformat(endedMs),
      logical_ritual_date: date,
      utterances: utterances.map((u) => ({ ...u, at: isoformat(u.at_ms) })),
      cache_schema_version: call.cacheSchemaVersion,
      cache_entry: call.entry,
    });
    const users = utterances.filter((u) => u.speaker === "user").length;
    const relays = Array.isArray(conversation.nudges) ? conversation.nudges.length : 0;
    const transcriptMd = [
      `# Voice call with ${bot}, ${localParts(startMs).date} ${clock(startMs).slice(0, 5)}–${clock(endedMs).slice(0, 5)} ${zoneAbbreviation(startMs)}`,
      "",
      `- Source: \`${sourceId}\` (${provider}, bot ${bot}, agent \`${call.agentId}\`)`,
      `- Logical ritual date: ${date}. ${basis}`,
      `- Length ${duration(durationMs)}, ended: ${String(record.ending ?? "unknown")}. ${turns.length} cached turns: ${users} user utterances after joining streamed partials, ${utterances.length - users} ${bot} turns.`,
      `- Verbatim: each line is the transcriber's final text. Every partial turn, the ${relays} message(s) the call passed to the chat, and the call record are kept unchanged in \`${sourceId}.transcript.json\`.`,
      "",
      ...utterances.flatMap((u) => [`**${u.speaker === "user" ? "User" : bot}** (${clock(u.at_ms)}): ${u.text}`, ""]),
    ].join("\n");
    const sidecar = (extractedAt: string): string =>
      json({
        schema: "journal-source-v1",
        source_id: sourceId,
        provider,
        provider_ref: { agent_id: call.agentId, bot_name: call.botName, call_id: callId },
        channel: "voice-call",
        verbatim: true,
        sent_at: isoformat(startMs),
        received_at: isoformat(endedMs),
        time_basis: `sent_at is the call's start (its end minus its duration) and received_at its end, both from the app's own call record; turn times are the app's clock. Copied from the app's local cache at ${extractedAt}.`,
        logical_ritual_date: date,
        date_basis: basis,
        continuation_of: null,
        raw_file: `${sourceId}.transcript.json`,
        raw_sha256: sha(transcriptJson),
        related_files: [`${sourceId}.transcript.md`],
        cleanup_sha256: null,
        ambiguous_transcriptions: null,
        request_ids: null,
      });
    return { sourceId, date, transcriptJson, transcriptMd, sidecar };
  });
