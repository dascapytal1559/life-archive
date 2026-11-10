// Where each connector's imports stand, for an import session
// (`npm run archive -- import-status`, and docs/import-runbook.md): for each
// one, how a fresh copy is had, when it was last imported, how far its imports
// reach, and what to do next. Which platforms the captain uses is read from the
// archive itself (a connector with an import that finished well), so nothing
// about him is kept in the code. Reads import records, coverage claims and
// message times only, never text.

import { type ConnectorStatus, dayKey, type Db, type LiveState, type ObtainStep } from "../../../sdk/server.ts";

/** How a fresh copy is had: from a live bridge (nothing to fetch), or as the connector's manifest says. */
export type ImportWay = "live" | ObtainStep["from"];

/** The ways, in the order an import session goes through them, each with its heading and its name in a word or two (the Platforms table's). */
export const IMPORT_WAYS: ReadonlyArray<{ way: ImportWay; heading: string; name: string }> = [
  { way: "live", heading: "Live, through the bridge rig: nothing to import while it is connected", name: "Live" },
  { way: "mac", heading: "Copied from an app's database on this Mac", name: "This Mac" },
  { way: "iphone-backup", heading: "Taken out of an iPhone backup", name: "iPhone backup" },
  { way: "platform", heading: "Requested from the platform, which sends its export minutes to days later", name: "Requested export" },
];

/** How a fresh copy of a connector's source is had: live when it syncs, else as its manifest's `obtain` says; null with neither. */
export function wayOf(connector: { capabilities: { sync: boolean }; obtain?: ObtainStep | null }): ImportWay | null {
  return connector.capabilities.sync ? "live" : (connector.obtain?.from ?? null);
}

export interface ImportStatusConnector extends Pick<ConnectorStatus, "id" | "platform" | "enabled" | "lastOkAt" | "lastError" | "capabilities"> {
  /** Its manifest's `obtain`; none for a live connector. */
  obtain: ObtainStep | null;
  /**
   * A live connector's state as the running server reports it: null when the server does not run it,
   * undefined when the server does not answer.
   */
  live?: LiveState | null;
}

export interface ImportStatusRow {
  connector: string;
  platform: string;
  way: ImportWay;
  enabled: boolean;
  /** When an import with it last finished well; for a live connector, its last good sync. */
  lastImportAt: number | null;
  /** How far its imports reach: the latest end of what they claim to cover. Null for a live connector. */
  coversTo: number | null;
  /** For a live connector, the newest message on its platform. */
  newestAt: number | null;
  lastError: string | null;
  /** What to do next, one line. */
  next: string;
}

export interface ImportStatusReport {
  generatedAt: number;
  /** Connectors with an import or sync that finished well: the platforms the captain uses. */
  used: ImportStatusRow[];
  /** The rest, each with how to start. */
  unused: ImportStatusRow[];
}

export function importStatus(db: Db, connectors: ImportStatusConnector[], now = Date.now()): ImportStatusReport {
  // An import that finished well, or a live connector's sync session that ended well; a session still
  // running has its last good batch only in the connector's state (lastOkAt).
  const lastOk = new Map(
    (db.prepare("SELECT connector, max(finished_at) AS at FROM source WHERE status = 'ok' GROUP BY connector").all() as
      { connector: string; at: number | null }[]).map((row) => [row.connector, row.at]),
  );
  const coversTo = new Map(
    (db.prepare(
      `SELECT s.connector, max(c.to_ms) AS to_ms FROM coverage_span c JOIN source s ON s.id = c.source_id
       WHERE s.status = 'ok' GROUP BY s.connector`,
    ).all() as { connector: string; to_ms: number }[]).map((row) => [row.connector, row.to_ms]),
  );
  const newestOn = db.prepare("SELECT max(sent_at) AS at FROM message WHERE platform = ?");
  const isLive = (c: ImportStatusConnector) => c.capabilities.sync;
  // A platform whose live connector is connected needs none of its imports but to fill a gap in it.
  const connectedLive = new Map(
    connectors.filter((c) => isLive(c) && c.live?.state === "connected" && c.platform).map((c) => [c.platform!, c.id]),
  );

  const rows = connectors
    .filter((c) => c.platform !== null && wayOf(c) !== null)
    .map((c): ImportStatusRow & { used: boolean } => {
      const platform = c.platform!;
      const live = isLive(c);
      const coverage = live ? null : (coversTo.get(c.id) ?? null);
      const lastImportAt = Math.max(lastOk.get(c.id) ?? 0, c.lastOkAt ?? 0) || null;
      return {
        used: lastImportAt !== null,
        connector: c.id,
        platform,
        way: wayOf(c)!,
        enabled: c.enabled,
        lastImportAt,
        coversTo: coverage,
        newestAt: live ? ((newestOn.get(platform) as { at: number | null }).at ?? null) : null,
        lastError: c.lastError,
        next: live ? liveNext(c) : historyNext(c.obtain!, coverage, connectedLive.get(platform)),
      };
    })
    .sort((a, b) => wayOrder(a.way) - wayOrder(b.way) || a.platform.localeCompare(b.platform) || a.connector.localeCompare(b.connector));
  const strip = ({ used: _, ...row }: ImportStatusRow & { used: boolean }): ImportStatusRow => row;
  return { generatedAt: now, used: rows.filter((r) => r.used).map(strip), unused: rows.filter((r) => !r.used).map(strip) };
}

function wayOrder(way: ImportWay): number {
  return IMPORT_WAYS.findIndex((w) => w.way === way);
}

function liveNext(c: ImportStatusConnector): string {
  if (!c.enabled) return `switched off: npm run archive -- enable ${c.id}, then restart the server`;
  if (c.live === undefined) return "the server does not answer, so how it is doing is unknown: start the server, then look again";
  if (c.live === null) return "the server does not run it: restart the server";
  if (c.live.state === "connected") return "nothing: it follows along by itself";
  return `check the bridge rig: it is ${c.live.state}${c.live.detail ? ` (${c.live.detail})` : ""}`;
}

function historyNext(obtain: ObtainStep, coversTo: number | null, liveSibling: string | undefined): string {
  if (liveSibling) return `nothing while ${liveSibling} is connected; only to fill a gap in it, or reach back before it`;
  return obtain.step.replaceAll("{since}", coversTo === null ? "the start" : dayKey(coversTo));
}
