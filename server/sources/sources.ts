// The Events page's Sources tab (viewer/sourcesWire.ts): for each connector the archive has, how it syncs, how often,
// when it last synced well, whether it is failing, what it has brought, and whether it is overdue. Each value is read
// from where the archive already records it, never kept here:
//
//   - what it is and, for a sync connector, how often it looks: its manifest (label, description, cadence), the
//     polling interval its settings may set (data/connectors/<id>.json, the manifest's `settingHours`);
//   - which scheduled job feeds it: the jobs' own lists, as the modules declare them (sdk/server.ts's `sources`: friend
//     map's mac imports, WhatsApp's calls and the Cua Space's exports), and how often that job runs: the launchd agent as installed on this Mac (its plist in
//     ~/Library/LaunchAgents), so a schedule changed and installed again shows here as it is;
//   - when it last synced well, and whether it fails: its runs in the archive (the source table's imports and live
//     sessions, and connector_state's last good batch and last error), and for a scheduled job's source the job's own
//     state (`checked` in its state file), since a run that finds nothing new imports nothing and leaves no run;
//   - what it brought: the messages, calls and event-index events whose first import was one of its runs; a module's
//     connectors', what the module's own hook says it holds of each (sdk/server.ts's ModuleConnectors).
//
// A source is overdue once its last good sync is older than two of its intervals (overdueAfterMs): one late or missed
// run is not yet worth a look, two are. A source with no interval (live as files change or messages come, imported by
// hand, switched off) is never overdue; its failure, or its live state, says how it is. A sync connector the server
// runs and holds connected is not overdue either, however old its last batch: a watcher writes a batch only when
// something changed, so a quiet week is not a stalled one.

import type { DatabaseSync } from "node:sqlite";
import type { ModuleConnectors } from "../../sdk/server.ts";
import type { ConnectorManifest } from "../connectors/contract.ts";
import { SYNC_WAYS, type Cadence, type SourceRow, type SyncWay } from "../../viewer/sourcesWire.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A scheduled job on this Mac that imports into some connectors: its launchd agent, and how to install it (a module's, sdk/server.ts's `sources`). */
export interface JobFeed {
  label: string;
  connectors: readonly string[];
  /** A word more on what it brings, where it brings less than the connector can. */
  note: string | null;
  install: string;
  /** Its state file, from the archive's folder, whose `checked` says when it last synced each connector well. */
  state: string;
}

/**
 * A job that asks for exports and imports them as they come (friend map's Cua Space rounds): its launchd agent, each
 * connector it asks an export of with how often, how to install and switch it on, and its round's schedule.
 */
export interface ExportFeed {
  label: string;
  connectors: ReadonlyArray<{ readonly connector: string; readonly everyDays: number }>;
  install: string;
  enable: string;
  /** Its round's schedule (its state file's), null before setup, read from the archive's folder. */
  schedule: (folder: string) => Promise<{ at: string; enabled: boolean } | null>;
}

/** What the archive records of a connector's runs. */
export interface RunFacts {
  lastOkAt: number | null;
  /** The last failure after lastOkAt, the first of them (since), and why the last failed. */
  failure: { since: number; last: number; error: string | null } | null;
  brought: SourceRow["brought"];
}

/** The kinds a ledger's `brought` names a chat platform's messages and calls by. */
export const BROUGHT_MESSAGES = "message";
export const BROUGHT_CALLS = "call";

/**
 * Each connector's run facts, read from a ledger's database on `db` (the core's or a module's: its `source` and
 * `connector_state` tables alone, the host's; metadata only), and what it brought from the ledger's `brought` (the
 * core's index, or the module's hook, its own tables being its own).
 */
export function runFacts(db: DatabaseSync, brought: ModuleConnectors["brought"]): Map<string, RunFacts> {
  const facts = new Map<string, RunFacts>();
  const of = (connector: string): RunFacts => {
    let found = facts.get(connector);
    if (!found) facts.set(connector, (found = { lastOkAt: null, failure: null, brought: { messages: 0, calls: 0, events: {} } }));
    return found;
  };
  const rows = <T>(sql: string, ...params: Array<string | number>) => db.prepare(sql).all(...params) as T[];
  for (const row of rows<{ connector: string; at: number | null }>("SELECT connector, max(finished_at) AS at FROM source WHERE status = 'ok' GROUP BY connector")) {
    of(row.connector).lastOkAt = row.at;
  }
  const states = rows<{ connector: string; last_ok_at: number | null; last_error: string | null; last_error_at: number | null }>(
    "SELECT connector, last_ok_at, last_error, last_error_at FROM connector_state",
  );
  for (const state of states) {
    const fact = of(state.connector);
    fact.lastOkAt = Math.max(fact.lastOkAt ?? 0, state.last_ok_at ?? 0) || null;
  }
  for (const [connector, fact] of facts) {
    const after = fact.lastOkAt ?? 0;
    const failed = db.prepare(
      `SELECT min(started_at) AS since, max(coalesce(finished_at, started_at)) AS last FROM source
       WHERE connector = ? AND status = 'failed' AND coalesce(finished_at, started_at) > ?`,
    ).get(connector, after) as { since: number | null; last: number | null };
    const lastError = db.prepare(
      "SELECT error FROM source WHERE connector = ? AND status = 'failed' ORDER BY coalesce(finished_at, started_at) DESC LIMIT 1",
    ).get(connector) as { error: string | null } | undefined;
    const state = states.find((s) => s.connector === connector);
    const stateFailed = state?.last_error_at != null && state.last_error_at > after ? state.last_error_at : null;
    const since = Math.min(...[failed.since, stateFailed].filter((at): at is number => at !== null));
    if (Number.isFinite(since)) {
      fact.failure = {
        since,
        last: Math.max(failed.last ?? 0, stateFailed ?? 0),
        error: oneLine(stateFailed !== null ? state!.last_error : (lastError?.error ?? null)),
      };
    }
  }
  // A chat platform's messages and calls (friend map's), and any other kind as events of the index (the core's sessions, exercise's workouts).
  for (const row of brought(db)) {
    const fact = of(row.connector).brought;
    if (row.kind === BROUGHT_MESSAGES) fact.messages = row.count;
    else if (row.kind === BROUGHT_CALLS) fact.calls = row.count;
    else fact.events[row.kind] = row.count;
  }
  return facts;
}

/** What the core's event index holds that each of its connectors first brought (llm-sessions' sessions, prompts and replies), for runFacts. */
export const indexBrought: ModuleConnectors["brought"] = (db) =>
  (db.prepare("SELECT s.connector, e.kind, count(*) AS count FROM event e JOIN source s ON s.id = e.first_source_id GROUP BY s.connector, e.kind").all() as
    Array<{ connector: string; kind: string; count: number }>);

/**
 * What changes when the run facts may have: the newest run, the last finished, and the newest live batch. Run facts
 * are kept until it changes, so counting every message is done once for each change, not each time the tab opens.
 */
export function runStamp(db: DatabaseSync): string {
  return JSON.stringify(db.prepare(
    `SELECT (SELECT max(id) FROM source) AS run, (SELECT max(finished_at) FROM source) AS finished,
            (SELECT max(max(coalesce(last_ok_at, 0), coalesce(last_error_at, 0))) FROM connector_state) AS state`,
  ).get());
}

/** An error's first line, cut to a line's length. */
function oneLine(error: string | null): string | null {
  if (!error) return null;
  const line = error.split("\n")[0].trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * How often a launchd agent runs, from its plist (as `plutil -convert json` gives it): a calendar time each week, day
 * or hour (the first, where it names several), or every StartInterval seconds; null for one that names neither.
 */
export function cadenceOfPlist(plist: Record<string, unknown>): Cadence | null {
  const calendar = Array.isArray(plist.StartCalendarInterval) ? plist.StartCalendarInterval[0] : plist.StartCalendarInterval;
  if (calendar && typeof calendar === "object") {
    const { Weekday: weekday, Hour: hour, Minute: minute } = calendar as Record<string, unknown>;
    const at = { hour: typeof hour === "number" ? hour : 0, minute: typeof minute === "number" ? minute : 0 };
    if (typeof weekday === "number") return { kind: "weekly", weekday: weekday % 7, ...at };
    if (typeof hour === "number") return { kind: "daily", ...at };
    return { kind: "every", ms: HOUR_MS };
  }
  if (typeof plist.StartInterval === "number" && plist.StartInterval > 0) return { kind: "every", ms: plist.StartInterval * 1000 };
  return null;
}

/** How long after its last good sync a source on `cadence` is overdue: two of its intervals; null for one with none. */
export function overdueAfterMs(cadence: Cadence): number | null {
  switch (cadence.kind) {
    case "every": return 2 * cadence.ms;
    case "daily": return 2 * DAY_MS;
    case "weekly": return 14 * DAY_MS;
    default: return null;
  }
}

/** A connector as the server's host reports it. */
export interface HostConnector {
  id: string;
  enabled: boolean;
  capabilities: { sync: boolean };
  live: { state: string; detail: string | null; since: number } | null;
  /** Its settings (data/connectors/<id>.json); {} when it has none or they do not read. */
  config: Record<string, unknown>;
}

export interface SourceInputs {
  connectors: readonly HostConnector[];
  manifests: readonly ConnectorManifest[];
  facts: ReadonlyMap<string, RunFacts>;
  /** Each launchd agent's plist as installed on this Mac, by label; null for one not installed. */
  plists: Readonly<Record<string, Record<string, unknown> | null>>;
  /** The modules' scheduled jobs that import into their connectors. */
  jobs?: readonly JobFeed[];
  /** The modules' jobs that ask for exports, each with its round's schedule as read (null before setup). */
  exports?: ReadonlyArray<{ feed: ExportFeed; round: { at: string; enabled: boolean } | null }>;
  /** When a scheduled job last synced each connector well, by its state file, where that is later than its last import. */
  checked?: Readonly<Record<string, number>>;
}

/** The Sources tab's rows, grouped by how each syncs (SYNC_WAYS's order), each group by label. */
export function sourceRows({ connectors, manifests, facts, plists, jobs = [], exports = [], checked = {} }: SourceInputs, now: number): SourceRow[] {
  const manifestOf = new Map(manifests.map((m) => [m.id, m]));
  const rows = connectors.map((connector): SourceRow => {
    const manifest = manifestOf.get(connector.id);
    const known = facts.get(connector.id) ?? { lastOkAt: null, failure: null, brought: { messages: 0, calls: 0, events: {} } };
    // A job's run that found nothing new synced well too, though it left no import.
    const fact = { ...known, lastOkAt: Math.max(known.lastOkAt ?? 0, checked[connector.id] ?? 0) || null };
    const how = howItSyncs(connector, manifest, plists, jobs, exports);
    const overdueAfter = overdueAfterMs(how.cadence);
    const connected = how.way === "server" && connector.live?.state === "connected";
    const failing = fact.failure && !connected ? { since: fact.failure.since, error: fact.failure.error } : null;
    return {
      connector: connector.id,
      label: manifest?.label ?? connector.id,
      description: manifest?.description ?? "",
      platform: manifest?.platform ?? null,
      ...how,
      overdueAfterMs: overdueAfter,
      lastOkAt: fact.lastOkAt,
      failing,
      live: how.way === "server" ? connector.live : null,
      enabled: connector.enabled,
      brought: fact.brought,
      overdue: overdueAfter !== null && !connected && (fact.lastOkAt === null || now - fact.lastOkAt > overdueAfter),
    };
  });
  const order = (way: SyncWay) => SYNC_WAYS.indexOf(way);
  return rows.sort((a, b) => order(a.way) - order(b.way) || a.label.localeCompare(b.label));
}

type How = Pick<SourceRow, "way" | "runner" | "note" | "cadence">;

/**
 * How a connector syncs: live in the server when it is a sync connector; else by the first scheduled job that feeds
 * it; else by the Cua Space's rounds when they ask for its export; else by hand.
 */
function howItSyncs(connector: HostConnector, manifest: ConnectorManifest | undefined, plists: SourceInputs["plists"], jobs: readonly JobFeed[], exports: NonNullable<SourceInputs["exports"]>): How {
  if (connector.capabilities.sync) {
    if (!connector.enabled) return { way: "server", runner: "the archive's server", note: null, cadence: { kind: "off", why: `switched off: npm run archive -- enable ${connector.id}` } };
    return { way: "server", runner: "the archive's server", note: null, cadence: liveCadence(manifest, connector.config) };
  }
  const job = jobs.find((feed) => feed.connectors.includes(connector.id));
  if (job) {
    const plist = plists[job.label] ?? null;
    const cadence: Cadence = plist === null
      ? { kind: "off", why: `its job is not installed on this Mac: ${job.install}` }
      : (cadenceOfPlist(plist) ?? { kind: "off", why: "its job names no schedule launchd keeps" });
    return { way: "job", runner: job.label, note: job.note, cadence };
  }
  for (const { feed, round } of exports) {
    const exported = feed.connectors.find((p) => p.connector === connector.id);
    if (!exported) continue;
    const cadence: Cadence = plists[feed.label] == null
      ? { kind: "off", why: `the Cua Space's rounds are not installed on this Mac: ${feed.install}` }
      : !round?.enabled
      ? { kind: "off", why: `the Cua Space's daily round is not on: ${feed.enable}` }
      : { kind: "every", ms: exported.everyDays * DAY_MS };
    const note = round?.enabled ? `asked for in the daily round at ${round.at}, imported when it comes; by hand too` : "by hand meanwhile";
    return { way: "cua", runner: feed.label, note, cadence };
  }
  return { way: "by-hand", runner: null, note: null, cadence: { kind: "on-demand" } };
}

/** A sync connector's cadence, from its manifest, its interval set in its settings where the manifest says it may be. */
function liveCadence(manifest: ConnectorManifest | undefined, config: Record<string, unknown>): Cadence {
  const cadence = manifest?.cadence;
  if (!cadence) return { kind: "off", why: "its manifest says no cadence" };
  if ("as" in cadence) return { kind: cadence.as };
  const hours = cadence.settingHours ? config[cadence.settingHours] : undefined;
  return { kind: "every", ms: typeof hours === "number" && hours > 0 ? Math.round(hours * HOUR_MS) : cadence.everyMs };
}
