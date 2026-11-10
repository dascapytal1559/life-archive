// What the Events page's Sources tab and the archive's server say to each other (GET /life-archive/api/sources,
// server/sources/http.ts): a row for each connector the archive has, saying what it is, how it syncs, how often, when it
// last synced well, whether its last attempt failed and since when, how much it has brought, and whether it is overdue.
// Every value is read from where the archive records it (the connectors' manifests and settings, their run records in
// the archive, the launchd agents installed on this Mac, the Cua Space's schedule); none is kept in the page. Metadata
// only: no message, no secret.

import { API_BASE } from "./wire.ts";

export const SOURCES_API = `${API_BASE}/sources`;

/**
 * How a source syncs: live in the archive's server, by a scheduled job on this Mac (launchd), by the Cua Space's
 * export rounds (which ask the platform for an export and import it when it comes), or by hand from an export.
 */
export const SYNC_WAYS = ["server", "job", "cua", "by-hand"] as const;
export type SyncWay = (typeof SYNC_WAYS)[number];

/** Each way's name on the page, in SYNC_WAYS's order. */
export const SYNC_WAY_NAMES: Record<SyncWay, string> = {
  server: "Live in the server",
  job: "Scheduled job on this Mac",
  cua: "Cua Space export",
  "by-hand": "Imported by hand",
};

/**
 * How often it syncs: every so many milliseconds; at a time each day or week (launchd's calendar, the archive's clock on
 * this Mac); as files change or messages come (live, no interval); on demand (by hand); or off (a job not installed, a
 * connector switched off, the Cua Space's daily round not on), with why.
 */
export type Cadence =
  | { kind: "every"; ms: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "files-change" }
  | { kind: "messages-come" }
  | { kind: "on-demand" }
  | { kind: "off"; why: string };

export interface SourceRow {
  /** The connector's id. */
  connector: string;
  /** What it is, in a few words (its manifest's label). */
  label: string;
  /** Its manifest's description: what it reads, at length. */
  description: string;
  /** The chat platform it reads, or the event index's origin; null where its manifest does not load. */
  platform: string | null;
  way: SyncWay;
  /** What runs it: the server, the launchd agent's label, the Cua Space's rounds' label; null by hand. */
  runner: string | null;
  /** A word more on how, where there is one ("calls only; the rest by hand from an iPhone backup"). */
  note: string | null;
  cadence: Cadence;
  /** How long after its last good sync it counts as overdue; null when it has no schedule to be late against. */
  overdueAfterMs: number | null;
  /** When it last synced well: its last import that finished well, its job's last run that found nothing new, or its live sync's last good batch. */
  lastOkAt: number | null;
  /** Its last attempt failed: since when (the first failure after its last good sync), and why in a line. */
  failing: { since: number; error: string | null } | null;
  /** Its live sync's state while the server runs it ("connected", "waiting"...), and since when; null for the rest. */
  live: { state: string; detail: string | null; since: number } | null;
  /** Whether it is switched on in its settings (data/connectors/<id>.json). */
  enabled: boolean;
  /** What it has brought into the archive: messages, calls, and the event index's events, by what they are. */
  brought: { messages: number; calls: number; events: Record<string, number> };
  /** Its last good sync is older than overdueAfterMs. */
  overdue: boolean;
}

export interface SourcesAnswer {
  /** When it was read, ms. */
  at: number;
  rows: SourceRow[];
}
