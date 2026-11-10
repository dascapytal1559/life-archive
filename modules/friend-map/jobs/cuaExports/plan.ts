// What the Cua Space's export agent is asked to do each day, and what it said it did (docs/data.md's "Exports from the Cua
// Space"; docs/import-runbook.md, "Computer-use help"). The agent works in a browser in the Space; this side, on the
// Mac, plans its rounds and takes what it downloads into the archive (round.ts).
//
// The agent appends one line to events.jsonl (in the Space's folder of the Cua Volume) for each thing that happened:
// a request made, an export downloaded, a stop for the captain. This file reads those lines, refusing anything that is
// not exactly one of the shapes below, since the agent reads web pages and what a page says could be in them. It plans
// the next round from them and from how far the archive's imports reach, and words the notes firstmate is sent from
// their checked fields alone: no text the agent wrote is ever passed on.
//
// Pure: no files, no processes, no clock.

import { addDays, dayKey, isDay } from "../../../../sdk/server.ts";

export type PlatformId = "instagram" | "facebook" | "messenger" | "discord";

export interface ExportPlatform {
  id: PlatformId;
  /** What the notes call it. */
  label: string;
  /** The connector that imports its export. */
  connector: string;
  /** Its folder in platform-exports/. */
  folder: string;
  /** How often to ask for an export. */
  everyDays: number;
  /** Whether its export takes a date range (Messenger's encrypted chats and Discord's are the whole of them each time). */
  takesDates: boolean;
  /**
   * How a requested export arrives: ready later on the same page (Meta's), by an emailed link (Discord's), or made
   * while the page waits, so the round downloads it at once (Messenger's encrypted chats).
   */
  delivery: "page" | "email" | "direct";
  /** Whether it comes as zips holding media, which the import reads only unpacked. */
  unpack: boolean;
  /** The names its downloads may have; a downloaded event naming anything else is refused. */
  files: RegExp;
}

export const EXPORT_PLATFORMS: readonly ExportPlatform[] = [
  { id: "instagram", label: "Instagram messages", connector: "instagram-dyi", folder: "instagram", everyDays: 7, takesDates: true, delivery: "page", unpack: true, files: /^instagram-[A-Za-z0-9._-]+\.zip$/ },
  { id: "facebook", label: "Facebook Messenger", connector: "facebook-dyi", folder: "messenger", everyDays: 7, takesDates: true, delivery: "page", unpack: true, files: /^facebook-[A-Za-z0-9._-]+\.zip$/ },
  // Each is the whole of the encrypted chats (easily a GB zipped, and as much again unpacked), so monthly: weekly
  // would keep four times as many whole copies, and nothing is lost by waiting, as Facebook's weekly export
  // has every chat that is not encrypted.
  { id: "messenger", label: "Messenger's encrypted chats", connector: "messenger-export", folder: "messenger", everyDays: 30, takesDates: false, delivery: "direct", unpack: true, files: /^messages(-[0-9]+)?\.zip$/ },
  // Discord allows one request each 30 days.
  { id: "discord", label: "Discord", connector: "discord-package", folder: "discord", everyDays: 30, takesDates: false, delivery: "email", unpack: false, files: /^package(-[0-9]+)?\.zip$/ },
];

export const platform = (id: PlatformId): ExportPlatform => EXPORT_PLATFORMS.find((p) => p.id === id)!;

/** Days a request starts before the day the archive's imports reach, so nothing on that day is missed. */
export const OVERLAP_DAYS = 1;
/**
 * A request's range ends the day before today: the Space's Chrome keeps US Pacific time, which can be up to a day
 * behind the archive's time zone, and Meta's date picker will not save a range ending after its own today (a range to
 * the archive's today, while the browser's is still the day before, shows "Save disabled"). Early in the archive's day,
 * the browser's today can still be the archive's yesterday.
 */
export const END_DAYS_BEFORE = 1;
/** A request not downloaded after this many days is taken to have lapsed, and asked for again. */
export const LAPSE_DAYS = 30;

/** Why the agent stopped for the captain. */
export const STOPS = ["sign-in", "password", "code", "pin", "identity-check", "download-link", "browser-open", "other"] as const;
export type Stop = (typeof STOPS)[number];

/**
 * approval: Meta asked for the password again, and the round asked the Cua Keyvault to fill it (bridge.ts), which waits
 * for the captain's approval in Cua. reentered: the Keyvault filled it, and the round went on.
 */
export const EVENT_KINDS = ["requested", "pending", "downloaded", "lapsed", "needs-user", "approval", "reentered", "unavailable", "failed", "round"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface DownloadedFile {
  name: string;
  bytes: number;
  sha256: string;
}

/** One line of events.jsonl, checked. */
export interface ExportEvent {
  id: string;
  /** When, as an ISO instant. */
  at: string;
  kind: EventKind;
  /** Every kind's but round's, which says a round ended (the agent's heartbeat). */
  platform?: PlatformId;
  /** requested: the range asked for (none for Discord, or All time). */
  from?: string;
  to?: string;
  /** downloaded: the day the export was made, which names its folder; the files, in the Space's Downloads. */
  day?: string;
  files?: DownloadedFile[];
  /** needs-user: why. */
  stop?: Stop;
  /** approval: the Keyvault's request id, for the captain to find it in Cua. */
  request?: string;
  /** unavailable: the first day a request is allowed again. */
  until?: string;
  /** What the agent said, kept in the log for `status` and never sent on. */
  detail?: string;
}

export interface ParsedEvents {
  events: ExportEvent[];
  /** Lines that were not an event, each with its line number and why. */
  refused: Array<{ line: number; why: string }>;
}

const ID = /^[A-Za-z0-9-]{8,64}$/;
const KEYVAULT_REQUEST = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The events in events.jsonl, in the order written, each checked; a line that is not one is refused, never guessed at. */
export function parseEvents(text: string): ParsedEvents {
  const events: ExportEvent[] = [];
  const refused: ParsedEvents["refused"] = [];
  const ids = new Set<string>();
  text.split("\n").forEach((raw, index) => {
    if (!raw.trim()) return;
    const line = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      refused.push({ line, why: "not JSON" });
      return;
    }
    const checked = checkEvent(value);
    if (typeof checked === "string") refused.push({ line, why: checked });
    else if (ids.has(checked.id)) refused.push({ line, why: `a second event ${checked.id}` });
    else {
      ids.add(checked.id);
      events.push(checked);
    }
  });
  return { events, refused };
}

function checkEvent(value: unknown): ExportEvent | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not an object";
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !ID.test(v.id)) return "no id";
  if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return "no time";
  if (!EVENT_KINDS.includes(v.kind as EventKind)) return `kind ${JSON.stringify(v.kind)} is not one of ${EVENT_KINDS.join(", ")}`;
  const event: ExportEvent = { id: v.id, at: new Date(Date.parse(v.at)).toISOString(), kind: v.kind as EventKind };
  if (event.kind !== "round") {
    if (!EXPORT_PLATFORMS.some((p) => p.id === v.platform)) return `platform ${JSON.stringify(v.platform)} is not one of ${EXPORT_PLATFORMS.map((p) => p.id).join(", ")}`;
    event.platform = v.platform as PlatformId;
  }
  const day = (key: "from" | "to" | "day" | "until"): string | undefined | false => {
    if (v[key] === undefined || v[key] === null || v[key] === "") return undefined;
    return typeof v[key] === "string" && isDay(v[key]) ? v[key] : false;
  };
  for (const key of ["from", "to", "day", "until"] as const) {
    const found = day(key);
    if (found === false) return `${key} is not a day (YYYY-MM-DD)`;
    if (found) event[key] = found;
  }
  if (typeof v.detail === "string" && v.detail.trim()) event.detail = v.detail.trim().slice(0, 500);
  if (event.kind === "needs-user") {
    if (!STOPS.includes(v.stop as Stop)) return `stop ${JSON.stringify(v.stop)} is not one of ${STOPS.join(", ")}`;
    event.stop = v.stop as Stop;
  }
  if (event.kind === "approval") {
    if (typeof v.request !== "string" || !KEYVAULT_REQUEST.test(v.request)) return "an approval event needs the Keyvault's request id";
    event.request = v.request;
  }
  if (event.kind === "unavailable" && !event.until) return "an unavailable event needs until";
  if (event.kind === "downloaded") {
    if (!Array.isArray(v.files) || v.files.length === 0) return "a downloaded event needs its files";
    const pattern = platform(event.platform!).files;
    const files: DownloadedFile[] = [];
    for (const file of v.files as unknown[]) {
      const f = (typeof file === "object" && file !== null ? file : {}) as Record<string, unknown>;
      if (typeof f.name !== "string" || !pattern.test(f.name)) return `${JSON.stringify(f.name)} is not a ${event.platform} export's name`;
      if (typeof f.bytes !== "number" || !Number.isSafeInteger(f.bytes) || f.bytes <= 0) return `${f.name} has no size`;
      if (typeof f.sha256 !== "string" || !SHA256.test(f.sha256)) return `${f.name} has no sha256`;
      if (files.some((other) => other.name === f.name)) return `${f.name} is named twice`;
      files.push({ name: f.name, bytes: f.bytes, sha256: f.sha256 });
    }
    event.files = files;
  }
  return event;
}

/** One thing the next round is to do. */
export interface PlanTask {
  platform: PlatformId;
  /**
   * request: ask for a new export (from `from`, or All time when null, to `to`, the day before today (END_DAYS_BEFORE);
   * Messenger's and Discord's take no dates),
   * and for Messenger's encrypted chats, download it as soon as it is made.
   * check: look for the export of the request made on `requested` (for `from` to `to`), and download it when it is ready.
   */
  do: "request" | "check";
  from?: string | null;
  to?: string;
  requested?: string;
}

export interface ExportPlan {
  /** The day the plan is for, on this Mac (local). */
  today: string;
  tasks: PlanTask[];
  /** The platforms with nothing to do today, and the first day they will have. */
  next: Array<{ platform: PlatformId; on: string }>;
}

/**
 * The next round's tasks, from the events so far and how far each connector's imports reach (`coversTo`, by connector,
 * from import-status). A platform with a request not yet downloaded is checked, never asked again until it lapses; one
 * without is asked for when its cadence has come round and no `until` from the platform stands in the way.
 */
export function exportPlan(events: ExportEvent[], coversTo: Record<string, number | null>, today: string): ExportPlan {
  const plan: ExportPlan = { today, tasks: [], next: [] };
  for (const p of EXPORT_PLATFORMS) {
    const own = events.filter((e) => e.platform === p.id).sort((a, b) => a.at.localeCompare(b.at));
    const lastRequest = own.findLast((e) => e.kind === "requested");
    const requestedOn = lastRequest ? dayKey(Date.parse(lastRequest.at)) : null;
    const after = lastRequest ? own.slice(own.indexOf(lastRequest) + 1) : [];
    const downloaded = after.some((e) => e.kind === "downloaded");
    if (lastRequest && !downloaded && !after.some((e) => e.kind === "lapsed") && today < addDays(requestedOn!, LAPSE_DAYS)) {
      plan.tasks.push({
        platform: p.id, do: "check", requested: requestedOn!,
        ...(lastRequest.from ? { from: lastRequest.from } : {}), ...(lastRequest.to ? { to: lastRequest.to } : {}),
      });
      continue;
    }
    const until = own.filter((e) => e.kind === "unavailable").map((e) => e.until!).sort().at(-1);
    // The cadence runs from a request that was downloaded; one that lapsed is asked again at once.
    const due = [downloaded ? addDays(requestedOn!, p.everyDays) : null, until ?? null].filter((d): d is string => d !== null).sort().at(-1);
    if (due && today < due) {
      plan.next.push({ platform: p.id, on: due });
      continue;
    }
    const reach = coversTo[p.connector];
    const to = addDays(today, -END_DAYS_BEFORE);
    // Never a range of one day or less, which Meta may not take: an archive that reaches today still asks for two.
    const from = reach === null || reach === undefined ? null : [addDays(dayKey(reach), -OVERLAP_DAYS), addDays(to, -1)].sort()[0];
    plan.tasks.push(p.takesDates ? { platform: p.id, do: "request", from, to } : { platform: p.id, do: "request" });
  }
  return plan;
}

const STOP_WORDS: Record<Stop, string> = {
  "sign-in": "to be signed in",
  password: "the password typed again (the Cua Keyvault did not fill it: there is no saved login for that page, or the captain did not approve it)",
  code: "a code the platform sent",
  pin: "the PIN (or code) for Messenger's secure storage of encrypted chats, typed on messenger.com in the export Chrome window",
  "identity-check": "an identity check",
  "download-link": "the download link from its email opened in the Export browser",
  "browser-open": "the Export browser quit (Chrome > Quit), since a round cannot use the profile while it is open by hand",
  other: "something only the captain can do",
};

/** What every note starts with, so firstmate knows it from the captain's own. */
export const NOTE_HEAD = "[life-archive cua-exports, automated]";

/** How firstmate is to reach the Space, for a note that needs the captain. */
export interface NoteContext {
  space: string;
}

/**
 * The note firstmate is sent for an event, or null for one it need not hear about (a check that found the export still
 * being prepared, a round's end) or hears of otherwise (a download, in the note on its import). Made from the event's
 * checked fields alone, never from its `detail`.
 */
export function noteFor(event: ExportEvent, context: NoteContext): string | null {
  if (event.kind === "round" || event.kind === "pending" || event.kind === "downloaded") return null;
  const p = platform(event.platform!);
  // An export made while the page waits is downloaded in the same round: firstmate hears of it when it is imported.
  if (event.kind === "requested" && p.delivery === "direct") return null;
  const head = `${NOTE_HEAD} ${p.label}:`;
  switch (event.kind) {
    case "requested":
      return p.delivery === "page"
        ? `${head} export requested in the Cua Space (Messages, ${event.from ?? "all time"} to ${event.to ?? "today"}). The Space checks for it each day and downloads it when it is ready.`
        : `${head} data package requested in the Cua Space (Messages). ${p.label} emails a download link in a few days (up to 30): ` +
          `the captain opens it in the Export browser on the Space's Desktop (the Cua app's viewer, or \`cua sandbox view ${context.space}\`; quit it after), and the next round takes the package from the Space's Downloads.`;
    case "lapsed":
      return `${head} the last export request lapsed before it was downloaded; the next round asks again.`;
    case "needs-user":
      return `${head} the Cua Space's export round stopped for the captain: it needs ${STOP_WORDS[event.stop!]}. ` +
        `The captain does it on the Space's screen (the Cua app's viewer, or \`cua sandbox view ${context.space}\`): in the Chrome window the round left open (it waits 45 minutes), ` +
        `else in the Export browser on the Space's Desktop, quit after; then \`npm run cua-exports -- nudge\` in the life archive starts the round again (else the next daily round does).`;
    case "approval":
      return `${head} Meta asked for the password again in the Cua Space's export round, and the Cua Keyvault's request ${event.request} to fill it ` +
        `waits for the captain's approval in Cua (Touch ID); the round waits up to 45 minutes. Until he unlocks that login in Cua's Keyvault ` +
        `(Keyvault > All Items > the login > its lock), each re-entry asks him this once.`;
    case "reentered":
      return `${head} Meta asked for the password again in the Cua Space's export round; it was re-entered from the Cua Keyvault and the round went on. Nothing for the captain to do.`;
    case "unavailable":
      return `${head} the platform allows no new request until ${event.until}; the plan waits until then.`;
    case "failed":
      return `${head} the Cua Space's export round failed (\`npm run cua-exports -- status\` in the life archive shows what it said); the next round tries again.`;
  }
}

/** Days Signal's imports may fall behind before the captain is reminded, and again each as many days after. */
export const SIGNAL_REMIND_DAYS = 7;

/**
 * A reminder that Signal's export is due, or null. Signal is not exported in the Cua Space: its Desktop app's export
 * asks the OS for the captain's presence, which a virtual Mac cannot give, so it is his to do on his own Mac, and the
 * schedule only reminds him: once Signal's imports reach back a week, and each week after. Its id names the day the
 * imports reach and the week, so each reminder is sent once and an import starts the count again.
 */
export function signalReminder(coversTo: Record<string, number | null>, today: string): { id: string; text: string } | null {
  const reach = coversTo["signal-export"];
  if (reach === null || reach === undefined) return null;
  const day = dayKey(reach);
  const behind = Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000);
  if (behind < SIGNAL_REMIND_DAYS) return null;
  return {
    id: `cua-exports-signal-due-${day}-${Math.floor(behind / SIGNAL_REMIND_DAYS)}`,
    text: `${NOTE_HEAD} Signal: the archive's Signal reaches ${day}, ${behind} days ago, and its export is done on the captain's Mac, not the Cua Space: ` +
      `Signal Desktop > Settings > Chats > Export chat history (with his Mac password), saved into ~/Downloads, then imported as docs/import-runbook.md's signal-export says. ` +
      `Opening Signal Desktop also keeps it linked (Signal unlinks a desktop left unused for 45 days).`,
  };
}

export function megabytes(bytes: number): string {
  return bytes < 100_000 ? `${Math.max(1, Math.round(bytes / 1000))} kB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}
