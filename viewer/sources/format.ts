// How the Sources tab words a source (viewer/sourcesWire.ts): how often it syncs, how long ago, what it brought, and
// how it stands, each in plain words.

import { countText, dateText, timeText } from "../format.ts";
import type { Cadence, SourceRow } from "../sourcesWire.ts";

const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** A clock time, "05:00". */
const clock = (hour: number, minute: number) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/** A span as people say it: "15 minutes", "3 hours", "7 days". */
export function spanText(ms: number): string {
  const units: Array<[number, string]> = [[86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"], [1000, "second"]];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size;
      return n === 1 ? `${name}` : `${n} ${name}s`;
    }
  }
  const [size, name] = units.find(([size]) => ms >= size) ?? units.at(-1)!;
  const n = Math.round(ms / size);
  return `${n} ${name}${n === 1 ? "" : "s"}`;
}

/** How often, in words: "every 15 minutes", "daily at 04:00", "Mondays at 05:00", "as files change", "on demand", "off". */
export function cadenceText(cadence: Cadence): string {
  switch (cadence.kind) {
    case "every": return `every ${spanText(cadence.ms)}`;
    case "daily": return `daily at ${clock(cadence.hour, cadence.minute)}`;
    case "weekly": return `${WEEKDAYS[cadence.weekday]} at ${clock(cadence.hour, cadence.minute)}`;
    case "files-change": return "as files change";
    case "messages-come": return "as messages come";
    case "on-demand": return "on demand";
    case "off": return "off";
  }
}

/** How long ago, roughly: "just now", "12 minutes ago", "3 hours ago", "5 days ago". */
export function agoText(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < 60_000) return "just now";
  const [size, name] = ([[86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"]] as const).find(([size]) => ms >= size)!;
  const n = Math.floor(ms / size);
  return `${n} ${name}${n === 1 ? "" : "s"} ago`;
}

/** An instant in full, local: "2 Nov 2026, 2:50 pm". */
export function instantText(at: number): string {
  return `${dateText(at)}, ${timeText(at)}`;
}

/** What each kind of the event index's events is called, many of them. */
const EVENT_NOUNS: Record<string, string> = { llm_session: "sessions", llm_prompt: "prompts", llm_reply: "replies", workout: "workouts" };

/** What it brought, the most first: "12,345 messages", "210 calls", "1,204 sessions"; "nothing yet". */
export function broughtParts(brought: SourceRow["brought"]): string[] {
  const parts: Array<[number, string]> = [
    [brought.messages, "messages"],
    [brought.calls, "calls"],
    ...Object.entries(brought.events).map(([kind, n]): [number, string] => [n, EVENT_NOUNS[kind] ?? kind]),
  ];
  const said = parts.filter(([n]) => n > 0).sort((a, b) => b[0] - a[0]).map(([n, noun]) => `${countText(n)} ${n === 1 ? noun.replace(/s$/, "") : noun}`);
  return said.length > 0 ? said : ["nothing yet"];
}

/** How a source stands, and its tone: overdue, failing, off, or as its live sync says, else fine. */
export function standing(row: SourceRow, now: number): { text: string; tone: "alert" | "warn" | "muted" | "ok" } {
  const failing = row.failing ? `failing since ${agoText(row.failing.since, now).replace(/ ago$/, "")}` : null;
  if (row.overdue) {
    const late = row.lastOkAt === null ? "Overdue: never synced" : `Overdue: due ${cadenceText(row.cadence)}`;
    return { text: failing ? `${late}; ${failing}` : late, tone: "alert" };
  }
  if (failing) return { text: failing[0].toUpperCase() + failing.slice(1), tone: "alert" };
  if (row.cadence.kind === "off") return { text: "Off", tone: "muted" };
  if (row.live && row.live.state !== "connected") return { text: liveWords(row.live.state), tone: "warn" };
  if (row.way === "by-hand") return { text: row.lastOkAt === null ? "Never imported" : "Imported", tone: "muted" };
  return { text: row.live ? "Connected" : "On schedule", tone: "ok" };
}

function liveWords(state: string): string {
  switch (state) {
    case "waiting": return "Waiting for its service";
    case "logged-out": return "Logged out of the bridge";
    case "bridge-offline": return "Bridge offline";
    case "starting":
    case "connecting": return "Starting";
    default: return state[0].toUpperCase() + state.slice(1);
  }
}
