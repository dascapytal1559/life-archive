// The viewer's Calls tab: every call with anyone, from every source (the phone's call history, the other apps' call
// records in one-to-one chats, an app's call with several people in no chat, and the calls the captain logged), one
// row each, as friend map pushed them into the calendar (../calendarRows.ts), without their notes, which are content.
// The people on a call are friend map's person ids, which its owner names. Its rows are edited in their cells and
// drawer (../tableEdits.ts): a call he logged whole, an imported one's note, whether it was answered and, when its app
// gives none, its length. A call he logged is his own, so Add call logs one here and a logged one can be deleted
// (`own`); an imported call never is. Friend Map's own Table had a Calls tab until 10 November 2026; this is it now.

import { CALL_LENGTH_MOST_MINUTES, callPlatformName, FRIEND_MAP, MANUAL_CALL_APPS, type SourceRow, sourceTab } from "../../../../sdk/server.ts";

/** Add call's "On" for each person's usual account (Their usual): the one their latest call was on, else their phone (../tableEdits.ts). */
export const USUAL = "usual";

/**
 * One row for each call, from the calendar's rows of kind `call`: when, its app (FaceTime apart from the phone's calls,
 * by its service, or a call logged on iMessage or FaceTime), which way, whether it was answered (yes, no, unknown), how
 * long in seconds (NULL when not known), where it came from, everyone on it (a JSON array of person ids), how many
 * more its app did not name, and whether anyone on it has a name the archive knows (known) or not (unknown).
 */
const SOURCE = `
  SELECT e.id, e.origin, e.native_id, e.kind, e.at, e.people AS person_ids,
    e.subkind AS app, e.facts ->> '$.service' AS service, e.facts ->> '$.way' AS way, e.facts ->> '$.answered' AS answered_word,
    e.facts ->> '$.seconds' AS seconds, e.facts ->> '$.from' AS from_word, e.facts ->> '$.others' AS others, e.facts ->> '$.caller' AS caller
  FROM event e WHERE e.kind = 'call'`;

const CALLERS: Record<string, string> = { known: "Known", unknown: "Unknown" };

const ANSWERED: Record<string, string> = { yes: "Yes", no: "No", unknown: "Not known" };
const WAYS: Record<string, string> = { incoming: "They called", outgoing: "You called", logged: "Logged" };
const ORIGINS: Record<string, string> = { history: "Call history", chat: "Chat", app: "App", logged: "You logged it" };

/** What an app is called: callPlatformName's, FaceTime and the phone apart. */
function appName(app: string): string {
  return app === "phone" ? "Phone" : callPlatformName(app);
}

/** The App cell: the app, and the kind of call when it says ("FaceTime video", "WhatsApp video"). */
function appCell(app: string, service: string | null): string {
  if (service === "facetime-video") return "FaceTime video";
  if (service === "facetime-audio") return "FaceTime audio";
  return service === "video" ? `${appName(app)} video` : appName(app);
}

export const CALLS = sourceTab({
  kind: "calls",
  label: "Calls",
  noun: ["call", "calls"],
  module: FRIEND_MAP,
  columns: [
    { key: "when", label: "When", kind: "time", width: 190, sortable: true },
    { key: "with", label: "With", kind: "people", width: 260 },
    { key: "app", label: "App", kind: "text", width: 150 },
    { key: "way", label: "Way", kind: "text", width: 120 },
    { key: "answered", label: "Answered", kind: "text", width: 100 },
    { key: "length", label: "Length", kind: "duration", width: 110, numeric: true, sortable: true },
    { key: "origin", label: "From", kind: "text", width: 130 },
  ],
  sort: "when",
  edits: [
    { key: "when", label: "When", input: "datetime" },
    { key: "length", label: "Length", input: "minutes", min: 1, max: CALL_LENGTH_MOST_MINUTES, clearable: true },
    { key: "with", label: "With", input: "people" },
    // An imported call's answer, his over its source's (a logged call was answered); the column's words for each.
    { key: "answered", label: "Answered", input: "choice", choices: [{ value: "answered", label: ANSWERED.yes! }, { value: "missed", label: ANSWERED.no! }, { value: "unknown", label: ANSWERED.unknown! }] },
    { key: "note", label: "Note", input: "note" },
  ],
  // A call he logs is his own: Add call asks its time, length, people, what it was on, and a note; only those are deleted.
  own: {
    add: [
      { key: "when", label: "When", input: "datetime" },
      { key: "length", label: "Length", input: "minutes", min: 1, max: CALL_LENGTH_MOST_MINUTES },
      { key: "with", label: "With", input: "people" },
      { key: "app", label: "On", input: "choice", choices: [{ value: USUAL, label: "Their usual" }, ...MANUAL_CALL_APPS.map((app) => ({ value: app, label: app === "other" ? "Another app" : appName(app) }))] },
      { key: "note", label: "Note", input: "note" },
    ],
    deletes: "calls you logged",
  },
  splits: ["app", "way", "answered"],
  sorts: { when: "at", length: "seconds" },
  source: SOURCE,
  filters: [
    { key: "app", label: "App", kind: "choice", expr: "app", name: appName, order: ["phone", "facetime", "whatsapp", "messenger", "wechat", "telegram", "instagram", "signal", "discord", "other"] },
    { key: "answered", label: "Answered", kind: "choice", expr: "answered_word", name: (value) => ANSWERED[value] ?? value, order: Object.keys(ANSWERED) },
    { key: "way", label: "Way", kind: "choice", expr: "way", name: (value) => WAYS[value] ?? value, order: Object.keys(WAYS) },
    { key: "caller", label: "Caller", kind: "choice", expr: "caller", name: (value) => CALLERS[value] ?? value, order: Object.keys(CALLERS) },
    { key: "person", label: "Person", kind: "person", ids: "person_ids", find: "Find a person" },
  ],
  measures: [
    { key: "calls", label: "Calls", unit: "count", expr: "count(r.id)" },
    { key: "minutes", label: "Minutes", unit: "minutes", expr: "coalesce(sum(CASE WHEN r.answered_word = 'yes' THEN r.seconds END), 0) / 60.0" },
  ],
  row: (raw: SourceRow) => ({
    id: String(raw.id),
    cells: {
      when: raw.at,
      with: { ids: JSON.parse(String(raw.person_ids)) as number[], others: Number(raw.others ?? 0) },
      app: appCell(String(raw.app), raw.service === null ? null : String(raw.service)),
      way: WAYS[String(raw.way)] ?? null,
      answered: ANSWERED[String(raw.answered_word)],
      length: raw.seconds,
      origin: ORIGINS[String(raw.from_word)] ?? null,
    },
  }),
});
