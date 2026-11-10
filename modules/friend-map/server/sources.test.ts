import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONNECTOR_TABLES, transaction, type ArchiveEvent, type ConnectorManifest, type Db } from "../../../sdk/server.ts";
import { cadenceOfPlist, CORE_MANIFESTS, createSourcesApi, openCore, overdueAfterMs, runFacts, runStamp, sourceRows, type Archive, type HostConnector, type RunFacts, type SourceInputs, type SourceRow, type SourcesAnswer } from "../../../sdk/testing.ts";
import { DatabaseSync } from "node:sqlite";
import { MANIFESTS as CHAT_MANIFESTS } from "../connectors/connectors.ts";
import { LAUNCHD_LABEL as CUA_LABEL } from "../jobs/cuaExports/live.ts";
import { LAUNCHD_LABEL as MAC_IMPORTS_LABEL } from "../jobs/macImports/round.ts";
import { FRIEND_MAP_EXPORTS, FRIEND_MAP_JOBS } from "../jobs/sources.ts";
import { broughtChats } from "./brought.ts";
import { openArchive } from "./db.ts";
import { ImportSession } from "./write.ts";

const MANIFESTS = [...CORE_MANIFESTS, ...CHAT_MANIFESTS];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-02T10:00:00+11:00");

/** The exercise module's polar connector, whose manifest the host has with the module's (the Sources tab reads the host's). */
const POLAR: ConnectorManifest = {
  id: "polar", label: "Polar Flow workouts", platform: "polar", cadence: { everyMs: 3 * 3_600_000, settingHours: "pollEveryHours" }, sourceKind: "live",
  capabilities: { history: true, sync: true, send: false }, needs: [], description: "made up", calls: { lengths: null, how: "none" }, encrypted: null,
};
/** A made-up sync connector the server keeps connected, looking at its source every five minutes and writing a batch only when something changed. */
const LOOK_EVERY_MS = 5 * 60_000;
const WATCHER: ConnectorManifest = {
  id: "rituals", label: "A made-up watcher", platform: "polar", cadence: { everyMs: LOOK_EVERY_MS }, sourceKind: "app-db",
  capabilities: { history: true, sync: true, send: false }, needs: [], description: "made up", calls: { lengths: null, how: "none" }, encrypted: null,
};
const ALL_MANIFESTS: readonly ConnectorManifest[] = [...MANIFESTS, POLAR, WATCHER];

/** A connector as the host reports it: switched on, not a sync connector unless said. */
function host(id: string, extra: Partial<HostConnector> = {}): HostConnector {
  const manifest = ALL_MANIFESTS.find((m) => m.id === id);
  return { id, enabled: true, capabilities: { sync: manifest?.capabilities.sync ?? false }, live: null, config: {}, ...extra };
}

function facts(entries: Record<string, Partial<RunFacts>>): Map<string, RunFacts> {
  return new Map(Object.entries(entries).map(([id, fact]) => [id, { lastOkAt: null, failure: null, brought: { messages: 0, calls: 0, events: {} }, ...fact }]));
}

const EVERY_15_MINUTES = { StartInterval: 900, RunAtLoad: true };

/** The rows for `inputs`, friend map's jobs and its Cua Space rounds among them, the rounds' schedule `cuaRound` (none unless said). */
function rows({ cuaRound = null, ...inputs }: Partial<SourceInputs> & { cuaRound?: { at: string; enabled: boolean } | null }, now = NOW): SourceRow[] {
  return sourceRows({ connectors: [], manifests: ALL_MANIFESTS, facts: new Map(), plists: {}, jobs: FRIEND_MAP_JOBS, exports: FRIEND_MAP_EXPORTS.map((feed) => ({ feed, round: cuaRound })), ...inputs }, now);
}

const row = (all: SourceRow[], id: string) => all.find((r) => r.connector === id)!;

describe("a launchd agent's schedule", () => {
  it("reads a week's calendar time, a day's, an hour's and an interval, and nothing else", () => {
    expect(cadenceOfPlist({ StartCalendarInterval: { Weekday: 1, Hour: 5, Minute: 0 } })).toEqual({ kind: "weekly", weekday: 1, hour: 5, minute: 0 });
    expect(cadenceOfPlist({ StartCalendarInterval: { Weekday: 7, Hour: 5 } })).toEqual({ kind: "weekly", weekday: 0, hour: 5, minute: 0 });
    expect(cadenceOfPlist({ StartCalendarInterval: [{ Hour: 4, Minute: 30 }, { Hour: 16 }] })).toEqual({ kind: "daily", hour: 4, minute: 30 });
    expect(cadenceOfPlist({ StartCalendarInterval: { Minute: 10 } })).toEqual({ kind: "every", ms: HOUR });
    expect(cadenceOfPlist(EVERY_15_MINUTES)).toEqual({ kind: "every", ms: 15 * MINUTE });
    expect(cadenceOfPlist({ KeepAlive: true })).toBeNull();
  });
});

describe("the overdue rule", () => {
  it("is two of its intervals after the last good sync, and never for a source with no interval", () => {
    expect(overdueAfterMs({ kind: "every", ms: 15 * MINUTE })).toBe(30 * MINUTE);
    expect(overdueAfterMs({ kind: "daily", hour: 4, minute: 0 })).toBe(2 * DAY);
    expect(overdueAfterMs({ kind: "weekly", weekday: 1, hour: 5, minute: 0 })).toBe(14 * DAY);
    for (const kind of ["files-change", "messages-come", "on-demand"] as const) expect(overdueAfterMs({ kind })).toBeNull();
    expect(overdueAfterMs({ kind: "off", why: "not installed" })).toBeNull();
  });

  it("marks a scheduled job's source overdue once two of its runs have passed without a good sync, or when it never synced", () => {
    const plists = { [MAC_IMPORTS_LABEL]: EVERY_15_MINUTES };
    const connectors = [host("call-history"), host("imessage-db")];
    const at = (lastOkAt: number | null) => row(rows({ connectors, plists, facts: facts({ "call-history": { lastOkAt } }) }), "call-history");
    expect(at(NOW - 20 * MINUTE)).toMatchObject({ way: "job", runner: MAC_IMPORTS_LABEL, cadence: { kind: "every", ms: 15 * MINUTE }, overdueAfterMs: 30 * MINUTE, overdue: false });
    expect(at(NOW - 30 * MINUTE).overdue).toBe(false);
    expect(at(NOW - 31 * MINUTE).overdue).toBe(true);
    expect(at(null).overdue).toBe(true);
  });

  it("counts a job's run that found nothing new as a good sync, by the job's own state, though it left no import", () => {
    const plists = { [MAC_IMPORTS_LABEL]: EVERY_15_MINUTES };
    const quiet = facts({ "call-history": { lastOkAt: NOW - 3 * DAY } });
    const got = row(rows({ connectors: [host("call-history")], plists, facts: quiet, checked: { "call-history": NOW - 10 * MINUTE } }), "call-history");
    expect(got).toMatchObject({ lastOkAt: NOW - 10 * MINUTE, overdue: false });
    // An import after the job's last check is the later of the two.
    expect(row(rows({ connectors: [host("call-history")], plists, facts: quiet, checked: { "call-history": NOW - 4 * DAY } }), "call-history")).toMatchObject({ lastOkAt: NOW - 3 * DAY, overdue: true });
  });

  it("follows the job's schedule as installed: weekly is late only after a fortnight", () => {
    const plists = { [MAC_IMPORTS_LABEL]: { StartCalendarInterval: { Weekday: 1, Hour: 5, Minute: 0 } } };
    const at = (lastOkAt: number) => row(rows({ connectors: [host("imessage-db")], plists, facts: facts({ "imessage-db": { lastOkAt } }) }), "imessage-db");
    expect(at(NOW - 8 * DAY)).toMatchObject({ cadence: { kind: "weekly", weekday: 1, hour: 5, minute: 0 }, overdue: false });
    expect(at(NOW - 15 * DAY).overdue).toBe(true);
  });

  it("says a job that is not installed is off, how to install it, and never overdue", () => {
    const got = row(rows({ connectors: [host("call-history")] }), "call-history");
    expect(got).toMatchObject({ way: "job", cadence: { kind: "off", why: "its job is not installed on this Mac: npm run mac-imports -- install" }, overdueAfterMs: null, overdue: false });
  });

  it("holds a live connector the server keeps connected not overdue however old its last batch, and one that is not connected to its interval", () => {
    const old = facts({ rituals: { lastOkAt: NOW - 3 * DAY } });
    const connected = row(rows({ connectors: [host("rituals", { live: { state: "connected", detail: null, since: NOW - DAY } })], facts: old }), "rituals");
    expect(connected).toMatchObject({ way: "server", cadence: { kind: "every", ms: LOOK_EVERY_MS }, overdue: false, live: { state: "connected" } });
    const stopped = row(rows({ connectors: [host("rituals", { live: { state: "error", detail: "rituals did not answer", since: NOW - DAY } })], facts: old }), "rituals");
    expect(stopped.overdue).toBe(true);
  });

  it("never marks a source imported by hand, or a live one as files change, overdue", () => {
    const all = rows({ connectors: [host("signal-export"), host("llm-sessions")], facts: facts({ "signal-export": { lastOkAt: NOW - 400 * DAY } }) });
    expect(row(all, "signal-export")).toMatchObject({ way: "by-hand", cadence: { kind: "on-demand" }, overdue: false, runner: null });
    expect(row(all, "llm-sessions")).toMatchObject({ way: "server", cadence: { kind: "files-change" }, overdue: false });
  });
});

describe("the rows", () => {
  it("says how often a sync connector looks from its manifest, its settings' interval where it may set one", () => {
    expect(row(rows({ connectors: [host("polar")] }), "polar").cadence).toEqual({ kind: "every", ms: 3 * HOUR });
    expect(row(rows({ connectors: [host("polar", { config: { pollEveryHours: 1 } })] }), "polar").cadence).toEqual({ kind: "every", ms: HOUR });
    expect(row(rows({ connectors: [host("matrix-bridge")] }), "matrix-bridge").cadence).toEqual({ kind: "messages-come" });
    expect(row(rows({ connectors: [host("polar", { enabled: false })] }), "polar").cadence).toMatchObject({ kind: "off" });
  });

  it("gives every sync connector a cadence, and every manifest a label", () => {
    for (const manifest of ALL_MANIFESTS) {
      expect(manifest.label.trim(), manifest.id).not.toBe("");
      expect(manifest.cadence !== undefined, manifest.id).toBe(manifest.capabilities.sync);
    }
  });

  it("says a Cua Space export is asked for every so many days while the daily round is on, and off otherwise", () => {
    const connectors = [host("instagram-dyi"), host("discord-package")];
    const on = rows({ connectors, plists: { [CUA_LABEL]: EVERY_15_MINUTES }, cuaRound: { at: "06:00", enabled: true } });
    expect(row(on, "instagram-dyi")).toMatchObject({ way: "cua", runner: CUA_LABEL, cadence: { kind: "every", ms: 7 * DAY }, overdueAfterMs: 14 * DAY });
    expect(row(on, "discord-package").cadence).toEqual({ kind: "every", ms: 30 * DAY });
    const off = rows({ connectors, plists: { [CUA_LABEL]: EVERY_15_MINUTES }, cuaRound: { at: "06:00", enabled: false } });
    expect(row(off, "instagram-dyi")).toMatchObject({ cadence: { kind: "off" }, overdue: false });
    expect(row(rows({ connectors, cuaRound: { at: "06:00", enabled: true } }), "instagram-dyi").cadence).toMatchObject({ kind: "off" });
  });

  it("notes WhatsApp's calls job brings its calls alone", () => {
    const got = row(rows({ connectors: [host("whatsapp-db")], plists: { "local.whatsapp-calls-import": EVERY_15_MINUTES } }), "whatsapp-db");
    expect(got).toMatchObject({ way: "job", cadence: { kind: "every", ms: 15 * MINUTE }, note: expect.stringContaining("calls only") });
    expect(row(rows({ connectors: [host("whatsapp-db")] }), "whatsapp-db").cadence).toEqual({ kind: "off", why: "its job is not installed on this Mac: npm run whatsapp-mac-calls -- install" });
  });

  it("says a source is failing, since its first failure after its last good sync, but not a live one now connected", () => {
    const failure = { since: NOW - 2 * HOUR, last: NOW - HOUR, error: "no Full Disk Access" };
    const all = rows({
      connectors: [host("call-history"), host("matrix-bridge", { live: { state: "connected", detail: null, since: NOW - MINUTE } })],
      plists: { [MAC_IMPORTS_LABEL]: EVERY_15_MINUTES },
      facts: facts({ "call-history": { lastOkAt: NOW - DAY, failure }, "matrix-bridge": { lastOkAt: NOW - HOUR, failure } }),
    });
    expect(row(all, "call-history").failing).toEqual({ since: NOW - 2 * HOUR, error: "no Full Disk Access" });
    expect(row(all, "matrix-bridge").failing).toBeNull();
  });

  it("groups the rows by how they sync, live first and by hand last, each group by label", () => {
    const all = rows({ connectors: ["x-archive", "polar", "call-history", "instagram-dyi", "llm-sessions"].map((id) => host(id)) });
    expect(all.map((r) => r.connector)).toEqual(["llm-sessions", "polar", "call-history", "instagram-dyi", "x-archive"]);
  });

  it("names a connector with no manifest by its id", () => {
    expect(row(rows({ connectors: [host("made-up")] }), "made-up")).toMatchObject({ label: "made-up", way: "by-hand", platform: null });
  });
});

describe("the runs' facts", () => {
  let db: Db;
  beforeEach(() => {
    db = openArchive(":memory:");
  });
  afterEach(() => db.close());

  /** A run of `connector` that ended as `status` at `at`, applying `events`. */
  function ran(connector: string, platform: string, status: "ok" | "failed" | "running", at: number, events: ArchiveEvent[] = [], error: string | null = null): void {
    transaction(db, () => {
      const source = Number(db
        .prepare("INSERT INTO source (platform, connector, kind, label, started_at, finished_at, status, error) VALUES (?, ?, 'export', 'sample', ?, ?, ?, ?)")
        .run(platform, connector, at - MINUTE, status === "running" ? null : at, status, error).lastInsertRowid);
      const session = new ImportSession(db, platform, source, "export");
      for (const event of events) session.apply(event);
    });
  }

  const messages = (n: number): ArchiveEvent[] => [
    { kind: "account", key: "Ada Sample", keyKind: "name", displayName: "Ada Sample" },
    { kind: "conversation", id: "chat", type: "direct", members: ["Ada Sample"] },
    ...Array.from({ length: n }, (_, i): ArchiveEvent => ({ kind: "message", id: `m${i}`, idKind: "platform", conversation: "chat", sender: "Ada Sample", isFromSelf: false, sentAt: NOW - i * MINUTE, type: "text", text: "hi", raw: {} })),
  ];

  it("reads the last good sync, the failures since it, and the messages each brought", () => {
    ran("signal-export", "signal", "ok", NOW - 3 * DAY, messages(3));
    ran("signal-export", "signal", "failed", NOW - 2 * DAY, [], "the export's folder is gone");
    ran("signal-export", "signal", "failed", NOW - DAY, [], "the export's folder is gone\nat read.ts:12");
    ran("x-archive", "x", "failed", NOW - 5 * DAY, [], "not a zip");
    ran("x-archive", "x", "ok", NOW - 4 * DAY);
    const got = runFacts(db, broughtChats);
    expect(got.get("signal-export")).toEqual({
      lastOkAt: NOW - 3 * DAY,
      failure: { since: NOW - 2 * DAY - MINUTE, last: NOW - DAY, error: "the export's folder is gone" },
      brought: { messages: 3, calls: 0, events: {} },
    });
    expect(got.get("x-archive")).toMatchObject({ lastOkAt: NOW - 4 * DAY, failure: null });
  });

  it("reads a module's connectors' runs from its own database, and what they brought from its hook, whatever the runs' counts say", () => {
    const ledger = new DatabaseSync(":memory:");
    ledger.exec(CONNECTOR_TABLES);
    const run = (status: string, at: number, counts: unknown) =>
      ledger.prepare("INSERT INTO source (platform, connector, kind, label, started_at, finished_at, status, counts_json) VALUES ('polar', 'polar', 'live', 'sync', ?, ?, ?, ?)").run(at - MINUTE, at, status, JSON.stringify(counts));
    run("ok", NOW - DAY, { events: {}, tallies: {} });
    run("ok", NOW - HOUR, { events: { workout: { added: 1, updated: 2, unchanged: 3 } }, tallies: {} });
    run("failed", NOW - MINUTE, null);
    const got = runFacts(ledger, () => [{ connector: "polar", kind: "workout", count: 7 }]);
    expect(got.get("polar")).toEqual({ lastOkAt: NOW - HOUR, failure: { since: NOW - 2 * MINUTE, last: NOW - MINUTE, error: null }, brought: { messages: 0, calls: 0, events: { workout: 7 } } });
    ledger.close();
  });

  it("takes a live connector's last good batch and its last error from its state", () => {
    ran("matrix-bridge", "telegram", "running", NOW);
    db.prepare("INSERT INTO connector_state (connector, status, last_ok_at, last_error, last_error_at) VALUES ('matrix-bridge', 'error', ?, 'it stopped: exit code 1', ?)").run(NOW - HOUR, NOW - 10 * MINUTE);
    expect(runFacts(db, broughtChats).get("matrix-bridge")).toMatchObject({ lastOkAt: NOW - HOUR, failure: { since: NOW - 10 * MINUTE, error: "it stopped: exit code 1" } });
  });

  it("changes its stamp when a run is added or finishes, or a live batch lands", () => {
    const first = runStamp(db);
    ran("signal-export", "signal", "ok", NOW - DAY);
    const second = runStamp(db);
    expect(second).not.toBe(first);
    db.prepare("INSERT INTO connector_state (connector, status, last_ok_at) VALUES ('polar', 'idle', ?)").run(NOW);
    expect(runStamp(db)).not.toBe(second);
  });
});

describe("GET /life-archive/api/sources", () => {
  let db: Db;
  let url: string;
  let close: () => void;
  let dataDir: string;
  beforeEach(async () => {
    // The archive's folder, where mac-imports last found nothing new 10 minutes ago.
    dataDir = await mkdtemp(join(tmpdir(), "sources-data-"));
    await mkdir(join(dataDir, "mac-imports"), { recursive: true });
    await writeFile(join(dataDir, "mac-imports", "state.json"), JSON.stringify({ checked: { "call-history": NOW - 10 * MINUTE } }));
    // The core's database, whose ledger the route reads with the core's index.
    db = openCore(":memory:");
    db.prepare("INSERT INTO connector_state (connector, status, last_ok_at) VALUES ('polar', 'idle', ?)").run(NOW - HOUR);
    const archive = {
      host: {
        statuses: async () => [
          { id: "polar", enabled: true, capabilities: { history: true, sync: true, send: false }, live: { state: "connected", detail: null, since: NOW - DAY } },
          { id: "call-history", enabled: true, capabilities: { history: true, sync: false, send: false }, live: null },
        ],
        readConfig: async (id: string) => ({ enabled: true, config: id === "polar" ? { pollEveryHours: 6 } : {} }),
        manifests: () => ALL_MANIFESTS,
      },
      // Friend map's jobs and its Cua Space rounds, as its module.ts names them.
      modules: [{ definition: { sources: { jobs: FRIEND_MAP_JOBS, exports: FRIEND_MAP_EXPORTS } } }],
    } as unknown as Archive;
    const readPlist = async (label: string) => (label === MAC_IMPORTS_LABEL ? EVERY_15_MINUTES : null);
    const api = createSourcesApi(dataDir, { reads: () => ({ core: db, calendar: db, modules: new Map(), owners: new Map() }), archive, readPlist, now: () => NOW });
    const server = createServer(api);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/life-archive/api/sources`;
    close = () => server.close();
  });
  afterEach(async () => {
    close();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("answers a row a connector, from the host, the archive's runs and the installed jobs", async () => {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SourcesAnswer;
    expect(body.at).toBe(NOW);
    expect(body.rows.map((r) => [r.connector, r.way, r.cadence, r.lastOkAt, r.overdue])).toEqual([
      ["polar", "server", { kind: "every", ms: 6 * HOUR }, NOW - HOUR, false],
      ["call-history", "job", { kind: "every", ms: 15 * MINUTE }, NOW - 10 * MINUTE, false],
    ]);
  });

  it("refuses another site's page and anything but a read", async () => {
    expect((await fetch(url, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
  });
});

