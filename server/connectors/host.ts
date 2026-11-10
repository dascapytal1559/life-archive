// The archive host's side of the connector contract (see contract.ts).
//
// - Connectors are found by listing server/connectors/*/manifest.ts. A manifest
//   that fails to load marks only that connector broken.
// - Each connector is switched on or off by data/connectors/<id>.json
//   (`{"enabled": true, ...settings}`); a missing file means off.
// - A history import runs the connector in its own child process with a
//   memory cap and a time limit, checks every event it writes, and applies
//   them to its ledger in one transaction only if the whole run succeeded.
//   Checked events wait in a spool file on disk (data/archive/.spool/), not
//   in memory, so an export of any size imports in bounded memory.
//   A crash, hang or malformed event fails that import alone: the ledger is
//   left as it was and the connector is marked with the error and a backoff,
//   while every other connector carries on.
// - A connector's ledger (ConnectorLedger) is where its runs are recorded
//   (its `source` and `connector_state` rows) and its events applied: the
//   core's database for the core's connectors (archive/coreWrite.ts), and for a module's connectors
//   (sdk/server.ts's ModuleConnectors, registered by server/modules/loader.ts)
//   the module's database, its `apply` in a transaction of that, the calendar
//   rows it gives back pushed once the transaction has committed.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, createReadStream, createWriteStream, openSync, readSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Data, Effect, Fiber, Stream } from "effect";
import type { AppliedSource } from "../../sdk/server.ts";
import type { ConnectorStatus } from "../../src/archive.ts";
import { transaction, type Db } from "../archive/db.ts";
import { EXPORTS_FOLDER } from "../archive/mediaPaths.ts";
import { coreLedger } from "../archive/coreWrite.ts";
import type { ImportCounts } from "./counts.ts";
import { spawnScoped } from "../childProcess.ts";
import { runBackground, runPromise } from "../effectRuntime.ts";
import { atomicWrite, isMissingFile } from "../files.ts";
import { isSyncEvent, validateEvent, type ArchiveEvent, type ConnectorManifest, type ProgressEvent } from "./contract.ts";
import { expandHome, jsonLines } from "./lines.ts";
import { keepLiveBridges, liveOwner, makeLiveLock, type LiveLock } from "./liveLock.ts";
import { LLM_FOLDER } from "./sessionCopies.ts";
import { SyncRunner, type LiveState, type SyncRunnerOptions } from "./sync.ts";

const CONNECTORS_DIR = fileURLToPath(new URL(".", import.meta.url));
const HISTORY_TIMEOUT_MS = 60 * 60_000;
const MEMORY_CAP_MB = 2048;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 60 * 60_000];
const HEARTBEAT_MS = 20_000;
const STALE_AFTER_MS = 2 * 60_000;

export interface RegisteredConnector {
  id: string;
  main: string;
  manifest: ConnectorManifest | null;
  /** Why the manifest could not be loaded. */
  loadError: string | null;
  /** The ledger its runs and events go to (the host's `ledgers`, by key); none for the core's own. */
  ledger?: string;
}


/** One import or batch as the host applies it: what a module is told (sdk/server.ts), and what the core's writer needs besides. */
export interface LedgerSource extends AppliedSource {
  readonly kind: "export" | "app-db" | "live";
  /** When its events were read. */
  readonly seenAt: number;
}

/**
 * Where a connector's imports land: the database that keeps its `source` and `connector_state` rows, and how an
 * import's checked events are applied to it, inside the host's transaction of that database (the core's own
 * ledger applies them through the event index's writer, archive/coreWrite.ts; a module's through its apply). What `afterCommit` does happens once the
 * transaction has committed (the calendar's push, in its own file). `settings` are what every connector of the ledger
 * runs with beyond its file's (the core's: none; exercise's: the tombstones of deleted workouts).
 */
export interface ConnectorLedger {
  readonly db: Db;
  readonly apply: (events: Iterable<ArchiveEvent>, source: LedgerSource) => { counts: ImportCounts; afterCommit?: () => void };
  readonly settings?: () => Record<string, unknown>;
  /** Why a connector's history import cannot run now, or null (a module's `before`, sdk/server.ts's ModuleConnectors). */
  readonly before?: (connector: string) => string | null;
}

/** Every connector folder with a manifest.ts, each loaded on its own so one broken manifest breaks only itself. */
export async function loadRegistry(connectorsDir = CONNECTORS_DIR): Promise<RegisteredConnector[]> {
  const entries = await readdir(connectorsDir, { withFileTypes: true });
  const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const found: RegisteredConnector[] = [];
  for (const id of ids) {
    const manifestPath = join(connectorsDir, id, "manifest.ts");
    try {
      await stat(manifestPath);
    } catch {
      continue;
    }
    const main = join(connectorsDir, id, "main.ts");
    try {
      const { manifest } = (await import(pathToFileURL(manifestPath).href)) as { manifest: ConnectorManifest };
      if (manifest?.id !== id) throw new Error(`its manifest id is not "${id}"`);
      found.push({ id, main, manifest, loadError: null });
    } catch (error) {
      found.push({ id, main, manifest: null, loadError: `manifest failed to load: ${(error as Error).message}` });
    }
  }
  return found;
}

export class ConnectorDisabledError extends Error {}
export class ImportFailedError extends Error {}
/** A history import's process failed, or wrote something it should not have: why, for the import's error. */
class HistoryRunFailed extends Data.TaggedError("HistoryRunFailed")<{ readonly message: string }> {}

export interface ImportResult {
  connector: string;
  platform: string;
  source: string;
  sourceId: number;
  counts: ImportCounts;
  /** When a file with the same content was imported before, if it was. */
  previouslyImportedAt: number | null;
}

export interface LiveOptions extends SyncRunnerOptions {
  /** Hears when this process takes the live bridges over, before any connector starts. */
  onOwn?: () => void;
  /** How often the owner renews its record (see liveLock.ts); 20 s by default. */
  heartbeatEveryMs?: number;
  /** How long a heartbeat may stand still before another process takes over; 2 min by default. */
  staleAfterMs?: number;
}

export interface ImportOptions {
  onProgress?: (event: ProgressEvent) => void;
  timeoutMs?: number;
  /** Settings for this import only, over the connector's own (such as the `contacts` of whatsapp-db and imessage-db). */
  settings?: Record<string, unknown>;
}

export class ConnectorHost {
  readonly dataDir: string;
  readonly configDir: string;
  /** Where connectors keep media: data/platform-exports, live copies in <platform>/live/ there (see archive/mediaPaths.ts). */
  readonly mediaDir: string;
  /** Where connectors that keep copies of their source's files keep them: data/llm, each origin's in <platform>/ (see sessionCopies.ts). */
  readonly copiesDir: string;
  private readonly spoolDir: string;
  /** The core's database, which keeps the live bridges' lock, and the core's connectors' runs. */
  private readonly db: Db;
  private readonly registry: RegisteredConnector[];
  /** The core's own ledger, and the modules' by key (RegisteredConnector.ledger). */
  private readonly core: ConnectorLedger;
  private readonly ledgers: ReadonlyMap<string, ConnectorLedger>;
  /** The sync connectors running with the server (see startLive). */
  private readonly live = new Map<string, SyncRunner>();
  /** Which process runs the live bridges (see liveLock.ts), from the first startLive. */
  private lock: LiveLock | null = null;
  /** Takes the lock and keeps the live bridges here while this process holds it (keepLiveBridges), from startLive until stopLive. */
  private keeper: Fiber.Fiber<never> | null = null;

  /**
   * `afterApply` hears the index events each of the core's own imports added or changed, once its transaction has
   * committed (the archive pushes them to the calendar, archive/index.ts); `ledgers` are the modules' (server/modules/loader.ts).
   * `spoolDir`, `mediaDir` and `copiesDir` are for a dry run (archive/dryRun.ts), whose spool, media and copies go elsewhere.
   */
  constructor(options: {
    db: Db;
    dataDir: string;
    registry: RegisteredConnector[];
    ledgers?: ReadonlyMap<string, ConnectorLedger>;
    spoolDir?: string;
    mediaDir?: string;
    copiesDir?: string;
    afterApply?: (events: readonly number[]) => void;
  }) {
    this.db = options.db;
    // By id, the core's and the modules' together, as every list of them is shown.
    this.registry = [...options.registry].sort((a, b) => a.id.localeCompare(b.id));
    this.dataDir = options.dataDir;
    this.configDir = join(options.dataDir, "connectors");
    this.mediaDir = options.mediaDir ?? join(options.dataDir, EXPORTS_FOLDER);
    this.copiesDir = options.copiesDir ?? join(options.dataDir, LLM_FOLDER);
    this.spoolDir = options.spoolDir ?? join(options.dataDir, "archive", ".spool");
    this.core = coreLedger(options.db, options.afterApply);
    this.ledgers = options.ledgers ?? new Map();
  }

  /** The ledger a connector's runs and events go to. */
  private ledgerOf(entry: RegisteredConnector): ConnectorLedger {
    if (entry.ledger === undefined) return this.core;
    const ledger = this.ledgers.get(entry.ledger);
    if (!ledger) throw new Error(`${entry.id} belongs to ${entry.ledger}, whose ledger this host was not given`);
    return ledger;
  }

  /** Every connector's manifest, the modules' among them, for the Sources tab and the documents. */
  manifests(): ConnectorManifest[] {
    return this.registry.flatMap((entry) => (entry.manifest ? [entry.manifest] : []));
  }

  /** A connector by id, or by platform when exactly one connector serves it ("imessage", "telegram"). */
  find(name: string): RegisteredConnector {
    const byId = this.registry.find((entry) => entry.id === name);
    if (byId) return byId;
    const byPlatform = this.registry.filter((entry) => entry.manifest?.platform === name);
    if (byPlatform.length === 1) return byPlatform[0];
    const known = this.registry.map((entry) => entry.id).join(", ");
    throw new Error(
      byPlatform.length > 1
        ? `more than one connector serves ${name}; name one of ${byPlatform.map((e) => e.id).join(", ")}`
        : `no connector ${name}; the connectors are ${known}`,
    );
  }

  async readConfig(id: string): Promise<{ enabled: boolean; config: Record<string, unknown> }> {
    let text: string;
    try {
      text = await readFile(join(this.configDir, `${id}.json`), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return { enabled: false, config: {} };
      throw error;
    }
    const config = JSON.parse(text) as unknown;
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new Error(`data/connectors/${id}.json must hold a JSON object`);
    }
    return { enabled: (config as Record<string, unknown>).enabled === true, config: config as Record<string, unknown> };
  }

  /**
   * A connector's settings as it runs with them: its file's, and what its ledger adds for every connector of its (the
   * exercise module's tombstones of the workouts the captain deleted, so a connector that brings workouts leaves those out).
   */
  async connectorConfig(id: string): Promise<{ enabled: boolean; config: Record<string, unknown> }> {
    const read = await this.readConfig(id);
    const added = this.ledgerOf(this.find(id)).settings?.() ?? {};
    return Object.keys(added).length === 0 ? read : { ...read, config: { ...read.config, ...added } };
  }

  /**
   * Runs `work` with the live sync of every connector of `platforms` stopped (each finishing the step it is in), and
   * starts again each that was running, with its settings as they are then, however `work` ends: so no pass under way
   * writes while `work` changes what that sync keeps (a workout's delete, exercise/delete.ts).
   */
  async pausingLive<T>(platforms: readonly string[], work: () => Promise<T>): Promise<T> {
    const paused = [...this.live.values()].filter((runner) => runner.running && platforms.includes(runner.entry.manifest?.platform ?? ""));
    await Promise.all(paused.map((runner) => runner.stop()));
    try {
      return await work();
    } finally {
      // Not when the server has stopped the live connectors meanwhile.
      if (this.keeper) for (const runner of paused) runner.start();
    }
  }

  /** Switches a connector on or off, keeping its other settings. */
  async setEnabled(name: string, enabled: boolean): Promise<string> {
    const { id } = this.find(name);
    const { config } = await this.readConfig(id);
    await mkdir(this.configDir, { recursive: true });
    await atomicWrite(join(this.configDir, `${id}.json`), `${JSON.stringify({ ...config, enabled }, null, 2)}\n`);
    return id;
  }

  async statuses(): Promise<ConnectorStatus[]> {
    return Promise.all(
      this.registry.map(async (entry) => {
        const state = this.ledgerOf(entry).db.prepare("SELECT * FROM connector_state WHERE connector = ?").get(entry.id) as
          | { status: "idle" | "running" | "error"; last_run_at: number | null; last_ok_at: number | null;
              last_error: string | null; failures: number }
          | undefined;
        let enabled = false;
        let configError: string | null = null;
        try {
          enabled = (await this.readConfig(entry.id)).enabled;
        } catch (error) {
          configError = `data/connectors/${entry.id}.json: ${(error as Error).message}`;
        }
        const brokenBy = entry.loadError ?? configError;
        return {
          id: entry.id,
          platform: entry.manifest?.platform ?? null,
          description: entry.manifest?.description ?? "",
          enabled,
          status: brokenBy ? "error" : !enabled && state?.status !== "running" ? "disabled" : (state?.status ?? "idle"),
          lastRunAt: state?.last_run_at ?? null,
          lastOkAt: state?.last_ok_at ?? null,
          lastError: brokenBy ?? state?.last_error ?? null,
          failures: state?.failures ?? 0,
          capabilities: entry.manifest?.capabilities ?? { history: false, sync: false, send: false },
          companion: entry.manifest?.companion?.name ?? null,
          live: this.live.get(entry.id)?.state ?? null,
        };
      }),
    );
  }

  /**
   * Imports a source through a connector's history mode: one export file or folder, or several files
   * that together are one export. Throws ImportFailedError, leaving the archive unchanged, if it fails.
   */
  async importHistory(name: string, sourceArgs: string | string[] | undefined, options: ImportOptions = {}): Promise<ImportResult> {
    const entry = this.find(name);
    if (!entry.manifest) throw new ImportFailedError(`${entry.id}: ${entry.loadError}`);
    const manifest = entry.manifest;
    if (!manifest.capabilities.history) throw new ImportFailedError(`${entry.id} has no history import`);
    const { enabled, config: saved } = await this.connectorConfig(entry.id);
    const config = { ...saved, ...options.settings };
    if (!enabled) {
      throw new ConnectorDisabledError(
        `${entry.id} is switched off. Switch it on with: npm run archive -- enable ${entry.id}`,
      );
    }
    const ledger = this.ledgerOf(entry);
    const db = ledger.db;
    const refused = ledger.before?.(entry.id) ?? null;
    if (refused) throw new ImportFailedError(`${entry.id}: ${refused}`);
    const named = [sourceArgs ?? []].flat();
    const sources = (named.length > 0 ? named : [(config.source as string | undefined) ?? manifest.defaultSource ?? ""])
      .filter(Boolean)
      .map(expandHome);
    if (sources.length === 0) throw new ImportFailedError(`${entry.id} needs a source to import from`);
    const stats = [];
    for (const path of sources) {
      // A live connector's source can be a service it asks (Polar's API), which is no file to look for.
      if (manifest.sourceKind === "live" && /^https?:\/\//.test(path)) continue;
      const found = await stat(path).catch(() => null);
      if (!found) throw new ImportFailedError(`${entry.id}: ${path} does not exist or cannot be read`);
      stats.push(found);
    }
    const source = sources.length === 1 ? sources[0] : `${sources[0]} and ${sources.length - 1} more`;

    // Only a single export file is fingerprinted: hashing a many-part download twice over would take minutes.
    // An export's folder is known again by where it is (its label), since its exports folder is named by date.
    const contentSha256 = manifest.sourceKind === "export" && sources.length === 1 && stats[0].isFile() ? await sha256File(sources[0]) : null;
    const label = `${this.labelOf(sources[0])}${sources.length > 1 ? ` and ${sources.length - 1} more` : ""}`;
    const previous = contentSha256
      ? (db.prepare("SELECT max(finished_at) AS at FROM source WHERE content_sha256 = ? AND status = 'ok'").get(contentSha256) as
          { at: number | null }).at
      : manifest.sourceKind === "export" && sources.length === 1
        ? (db.prepare("SELECT max(finished_at) AS at FROM source WHERE connector = ? AND label = ? AND status = 'ok'").get(entry.id, label) as
            { at: number | null }).at
        : null;
    const startedAt = Date.now();
    const sourceId = Number(
      db
        .prepare(
          `INSERT INTO source (platform, connector, kind, label, content_sha256, started_at, status)
           VALUES (?, ?, ?, ?, ?, ?, 'running')`,
        )
        .run(manifest.platform, entry.id, manifest.sourceKind, label, contentSha256, startedAt).lastInsertRowid,
    );
    this.setState(db, entry.id, { status: "running", last_run_at: startedAt });
    // A module's spool is named by its ledger too: each ledger numbers its sources on its own.
    const spool = join(this.spoolDir, `${entry.ledger ? `${entry.ledger}-` : ""}${sourceId}.jsonl`);

    try {
      await mkdir(this.mediaDir, { recursive: true });
      await this.clearStaleSpools();
      const ran = await runPromise(this.run(entry, { sources, config, spool, timeoutMs: options.timeoutMs ?? HISTORY_TIMEOUT_MS }, options.onProgress));
      let afterCommit: (() => void) | undefined;
      const counts = transaction(db, () => {
        const applied = ledger.apply(spooledEvents(spool), { id: sourceId, platform: manifest.platform, kind: manifest.sourceKind, seenAt: startedAt, folder: this.dataDir });
        if ("cursor" in ran) this.setState(db, entry.id, { cursor_json: JSON.stringify(ran.cursor) });
        db.prepare("UPDATE source SET status = 'ok', finished_at = ?, counts_json = ? WHERE id = ?").run(Date.now(), JSON.stringify(applied.counts), sourceId);
        afterCommit = applied.afterCommit;
        return applied.counts;
      });
      // Once the ledger has committed: the calendar's push, in its own file (server/calendar/push.ts).
      afterCommit?.();
      this.setState(db, entry.id, { status: "idle", last_ok_at: Date.now(), failures: 0, retry_after: null, last_error: null });
      return { connector: entry.id, platform: manifest.platform, source, sourceId, counts, previouslyImportedAt: previous };
    } catch (error) {
      const message = (error as Error).message;
      db.prepare("UPDATE source SET status = 'failed', finished_at = ?, error = ? WHERE id = ?").run(Date.now(), message, sourceId);
      const failures = ((db.prepare("SELECT failures FROM connector_state WHERE connector = ?").get(entry.id) as
        { failures: number } | undefined)?.failures ?? 0) + 1;
      this.setState(db, entry.id, {
        status: "error", last_error: message, last_error_at: Date.now(), failures, retry_after: Date.now() + backoffDelay(failures),
      });
      throw new ImportFailedError(`${entry.id}: ${message}`);
    } finally {
      await rm(spool, { force: true });
    }
  }

  /**
   * Starts every sync connector's runner (see sync.ts): each runs its
   * connector while it is switched on and its companion answers, and
   * otherwise waits quietly. For the server; after stopLive it starts them again.
   *
   * Only one process runs them on an archive (see liveLock.ts). While another
   * holds the lock, every runner shows it waiting and this process looks again
   * every `checkEveryMs`; once it takes the lock, it hears `onOwn`, starts them
   * and renews its heartbeat, stopping them again should another process take
   * the lock from it.
   */
  startLive(options: LiveOptions = {}): void {
    this.keeper?.interruptUnsafe();
    const lock = (this.lock ??= makeLiveLock(this.db, { staleAfterMs: options.staleAfterMs ?? STALE_AFTER_MS }));
    for (const entry of this.registry) {
      if (!entry.manifest?.capabilities.sync || this.live.has(entry.id)) continue;
      this.live.set(entry.id, new SyncRunner(entry, this.ledgerOf(entry), { dataDir: this.dataDir, mediaDir: this.mediaDir, copiesDir: this.copiesDir }, () => this.connectorConfig(entry.id), options));
    }
    const bridges = {
      hold: (detail: string) => {
        for (const runner of this.live.values()) runner.hold(detail);
      },
      start: () => {
        options.onOwn?.();
        for (const runner of this.live.values()) runner.start();
      },
      stop: () => this.stopRunners(),
      log: (line: string) => options.log?.(line),
    };
    this.keeper = runBackground(
      keepLiveBridges(lock, bridges, { checkEveryMs: options.checkEveryMs ?? 60_000, heartbeatEveryMs: options.heartbeatEveryMs ?? HEARTBEAT_MS }),
    );
  }

  /** Stops every sync connector, and lets the live bridges go to another process. */
  async stopLive(): Promise<void> {
    const keeper = this.keeper;
    this.keeper = null;
    if (keeper) await runPromise(Fiber.interrupt(keeper));
    await this.stopRunners();
    if (this.lock) await runPromise(this.lock.release);
  }

  /** The process running the live bridges, if any (see liveLock.ts), and whether it is this one. */
  liveOwner(): { pid: number; since: number; thisProcess: boolean } | null {
    const holder = liveOwner(this.db);
    return holder && { pid: holder.pid, since: holder.since, thisProcess: holder.id === this.lock?.id };
  }

  private async stopRunners(): Promise<void> {
    await Promise.all([...this.live.values()].map((runner) => runner.stop()));
  }

  /** The running sync connector that can send on `platform`, if there is one. */
  sender(platform: string): SyncRunner | null {
    for (const runner of this.live.values()) {
      if (runner.entry.manifest?.platform === platform && runner.entry.manifest.capabilities.send) return runner;
    }
    return null;
  }

  /** Which platforms a sync connector can send on (running or not), with how each is doing. */
  sendingPlatforms(): Array<{ platform: string; connector: string; state: LiveState }> {
    return [...this.live.values()]
      .filter((runner) => runner.entry.manifest?.capabilities.send)
      .map((runner) => ({ platform: runner.entry.manifest!.platform, connector: runner.entry.id, state: runner.state }));
  }

  /** Removes spool files left by imports that were interrupted (a crashed or killed import leaves its source 'running'). */
  /** How a source is recorded: its path in the data folder (platform-exports/messenger/2026-09-28) when it is there, else its name. */
  private labelOf(path: string): string {
    const inside = relative(resolve(this.dataDir), resolve(path));
    return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside.split(sep).join("/") : basename(path);
  }

  private async clearStaleSpools(): Promise<void> {
    await mkdir(this.spoolDir, { recursive: true });
    const running = (ledger: ConnectorLedger, id: number) =>
      ledger.db.prepare("SELECT 1 FROM source WHERE id = ? AND status = 'running' AND started_at > ?").get(id, Date.now() - 24 * 60 * 60_000);
    for (const file of await readdir(this.spoolDir)) {
      const match = /^(?:([a-z0-9-]+)-)?(\d+)\.jsonl$/.exec(file);
      const ledger = match?.[1] === undefined ? this.core : this.ledgers.get(match[1]);
      const id = Number(match?.[2]);
      // An import still running in another process keeps its spool; one that started over a day ago has died.
      if (!match || !ledger || !id || !running(ledger, id)) await rm(join(this.spoolDir, file), { force: true });
    }
  }

  /**
   * Runs the connector's child process, writing its checked events to `spool`, or fails with what went wrong; gives
   * the cursor of the checkpoint it ended with, for a connector that keeps copies. The process is held in the run's
   * scope (../childProcess.ts) and killed at once on a malformed event or at its time limit.
   */
  private run(
    entry: RegisteredConnector,
    { sources, config, spool, timeoutMs }: { sources: string[]; config: Record<string, unknown>; spool: string; timeoutMs: number },
    onProgress?: (event: ProgressEvent) => void,
  ): Effect.Effect<{ cursor?: unknown }, HistoryRunFailed> {
    const args = [
      `--max-old-space-size=${MEMORY_CAP_MB}`, "--no-warnings", entry.main,
      "--mode", "history", ...sources.flatMap((source) => ["--source", source]),
      "--media", this.mediaDir,
      ...(entry.manifest?.keepsCopies ? ["--copies", join(this.copiesDir, entry.manifest.platform)] : []),
      "--config", JSON.stringify(config),
    ];
    return Effect.scoped(
      Effect.gen(function* () {
        const running = yield* spawnScoped(() => spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] }));
        const { child } = running;
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-4000);
        });
        let problem: string | null = null;
        const fail = (why: string) => {
          problem ??= why;
          child.kill("SIGKILL");
        };
        let cursor: { value: unknown } | undefined;
        const out = yield* Effect.acquireRelease(
          Effect.sync(() => createWriteStream(spool)),
          (out) => Effect.sync(() => out.destroy()),
        );
        out.on("error", (error) => fail(`its events could not be written to the spool file: ${error.message}`));

        let line = 0;
        const take = (text: string): Effect.Effect<void> => {
          line++;
          if (problem || !text.trim()) return Effect.void;
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            return Effect.sync(() => fail(`it wrote a line that is not JSON (line ${line})`));
          }
          const checked = validateEvent(parsed);
          if ("error" in checked) return Effect.sync(() => fail(`it wrote an invalid event on line ${line}: ${checked.error}`));
          // A connector that keeps copies ends with its bookmarks (conversations.ts), stored with the import.
          if (checked.event.kind === "checkpoint" && entry.manifest?.keepsCopies) {
            cursor = { value: checked.event.cursor };
            return Effect.void;
          }
          if (isSyncEvent(checked.event)) return Effect.sync(() => fail(`it wrote a ${checked.event.kind} event on line ${line}, which only sync mode writes`));
          if (checked.event.kind === "progress") return Effect.sync(() => onProgress?.(checked.event as ProgressEvent));
          // Waiting for the disk while the file catches up holds the child back through its stdout.
          return out.write(`${JSON.stringify(checked.event)}\n`) ? Effect.void : Effect.promise(() => once(out, "drain").catch(() => undefined));
        };
        const { code, signal } = yield* Stream.fromAsyncIterable(jsonLines(child.stdout), (error) => error as Error).pipe(
          Stream.runForEach(take),
          Effect.orDie,
          Effect.andThen(running.exited),
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.sync(() => fail(`it did not finish within ${Math.round(timeoutMs / 60_000)} minutes`)).pipe(Effect.andThen(running.exited)),
          }),
        );
        out.end();
        // A failed write has already set the problem (see the error handler above).
        yield* Effect.promise(() => finished(out).catch(() => undefined));
        if (problem) return yield* new HistoryRunFailed({ message: problem });
        if (code !== 0) {
          const detail = stderr.trim().split("\n").at(-1) || (signal ? `killed by ${signal}` : `exit code ${code}`);
          return yield* new HistoryRunFailed({ message: `it stopped with an error: ${detail}` });
        }
        return cursor ? { cursor: cursor.value } : {};
      }),
    );
  }

  private setState(db: Db, connector: string, fields: Record<string, string | number | null>): void {
    db.prepare("INSERT OR IGNORE INTO connector_state (connector, status) VALUES (?, 'idle')").run(connector);
    const keys = Object.keys(fields);
    db.prepare(`UPDATE connector_state SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE connector = ?`).run(...keys.map((key) => fields[key]), connector);
  }
}

/** The events of a spool file, one a line, read as they are applied (see spooledLines). */
function* spooledEvents(spool: string): Generator<ArchiveEvent> {
  for (const line of spooledLines(spool)) yield JSON.parse(line) as ArchiveEvent;
}

/** How long to wait before running a connector again after `failures` failed runs in a row: 1 min, 5 min, 30 min, then hourly. */
export function backoffDelay(failures: number): number {
  return BACKOFF_MS[Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1];
}

/** The lines of a spool file, read synchronously in chunks so a whole import can be applied inside one transaction. */
function* spooledLines(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(1 << 20);
    // A character split across two chunks is held back until its last byte is read.
    const decoder = new StringDecoder("utf8");
    let rest = "";
    for (let read; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0; ) {
      const lines = (rest + decoder.write(chunk.subarray(0, read))).split("\n");
      rest = lines.pop()!;
      for (const line of lines) if (line) yield line;
    }
    rest += decoder.end();
    if (rest) yield rest;
  } finally {
    closeSync(fd);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
