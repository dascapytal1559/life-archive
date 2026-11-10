// One run of the Mac's side of the Cua Space's exports (docs/data.md's "Exports from the Cua Space"), every 15 minutes by the
// launchd agent local.life-archive-cua-exports (`npm run cua-exports`):
//
// 1. Reads the events the Space's agent wrote (plan.ts) and sends firstmate a note for each new one it should hear of.
// 2. Takes each export the agent downloaded out of the Space's Downloads, straight into
//    platform-exports/<platform>/<day>/ in the archive's folder (never through the Cua Volume, which keeps every
//    version of every file it is given), checks each file's SHA-256 against the agent's, and removes the Space's copy.
//    Then imports it the runbook's way: exports unpack, a backup, the import, check-data; and tells firstmate.
// 3. Writes the next round's plan for the agent, from the events and how far the archive's imports reach.
// 4. Starts the day's round once its time has come (the schedule, kept here): a Codex run in the Space that follows the
//    playbook. Tells firstmate once when a round's run failed or ended without finishing, and when the agent has not
//    reported a round for two days while the schedule is on (Codex signed out in the Space, say).
//
// What it has done is kept in platform-exports/.cua-exports.json in the archive's folder, so a note is sent once and
// an export is taken once. Nothing the agent wrote is acted on before plan.ts has checked it.

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Context, Data, Effect } from "effect";
import { ArchiveCommands, atomicWrite, dayKey, Notifier, type RunFailed, timeOfDay, wallClock } from "../../../../sdk/server.ts";
import { type ExportEvent, type ExportPlan, exportPlan, megabytes, NOTE_HEAD, noteFor, parseEvents, platform, signalReminder } from "./plan.ts";

/** The agent's files in the Space's folder of the Cua Volume (spaces/<space>/friend-map-exports/). */
export const SHARED = { events: "events.jsonl", plan: "plan.json", playbook: "PLAYBOOK.md", eventScript: "event.sh", settings: "settings.json" } as const;
/** Where the Mac's side keeps what it has done, in the archive's folder. */
export const STATE_FILE = join("platform-exports", ".cua-exports.json");
/** How long the agent may stay silent before firstmate is told. */
export const SILENT_DAYS = 2;

/** The Space the agent works in, through Cua. */
export class CuaSpace extends Context.Service<CuaSpace, {
  /** The Space's id, for the notes. */
  readonly space: string;
  /** A file of the agent's folder in the Cua Volume, or null when there is none. */
  readonly read: (name: string) => Effect.Effect<string | null, RunFailed>;
  readonly write: (name: string, text: string) => Effect.Effect<void, RunFailed>;
  /** Copies a file in the Space's Downloads to `to` on this Mac. */
  readonly copyOut: (download: string, to: string) => Effect.Effect<void, RunFailed>;
  /** Removes a file from the Space's Downloads. */
  readonly removeDownload: (download: string) => Effect.Effect<void, RunFailed>;
  /** The export rounds' runs in the Space, as Cua reports them. */
  readonly runs: Effect.Effect<AgentRun[], RunFailed>;
  /** Starts a round: a Codex run in the Space told to follow the playbook. Its run id. */
  readonly startRound: Effect.Effect<string, RunFailed>;
}>()("life-archive/CuaSpace") {}

/** A round's run in the Space. */
export interface AgentRun {
  id: string;
  /** Still working (or waiting at a stop). */
  alive: boolean;
  /** Cua says it failed: Codex did not start, say. */
  failed: boolean;
}

/** What the Mac's side has done, and its schedule, kept between runs. */
export interface CollectorState {
  /** The Space the rounds run in (setup names it). */
  space?: string;
  /** When the daily round starts; none until setup has run. */
  schedule?: Schedule;
  /** The round's browser bridge (bridge.ts): the token in its address, which setup makes once. */
  bridge?: { token: string };
  /** The events already handled, by id: noted, and for a download, taken. */
  seen: string[];
  /** Each export taken out of the Space, and how its import went. */
  imports: ImportRecord[];
  /** Each round started, newest last. */
  rounds: RoundStart[];
}

export interface Schedule {
  /** The daily round's time, HH:MM on this Mac (local). */
  at: string;
  /** Whether the daily round starts by itself (setup --enable); a nudge starts one either way. */
  enabled: boolean;
  /** The model Codex runs with. */
  model: string;
}

export interface RoundStart {
  run: string;
  /** When it was started, as an ISO instant. */
  at: string;
  why: "daily" | "nudge";
}

export interface ImportRecord {
  event: string;
  platform: string;
  /** Its folder, from the archive's folder. */
  folder: string;
  at: string;
  ok: boolean;
  /** The import's message counts, or why it failed. */
  detail: string;
}

export interface RoundOptions {
  dataDir: string;
  now: number;
  /** Say what it would do, and do nothing. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface RoundResult {
  plan: ExportPlan;
  /** The events handled this run. */
  handled: ExportEvent[];
  refused: Array<{ line: number; why: string }>;
  imported: ImportRecord[];
  /** The round this run started, if it started one. */
  started: RoundStart | null;
}

/** How many of the latest rounds are looked at for a run that failed or ended unfinished. */
const ROUNDS_WATCHED = 5;

/** Whether the day's round is due: the schedule on, its time come, and no daily round started yet that day. */
export function roundDue(schedule: Schedule | undefined, rounds: RoundStart[], now: number): boolean {
  if (!schedule?.enabled) return false;
  const today = dayKey(now);
  return now >= wallClock(today, schedule.at) && !rounds.some((r) => r.why === "daily" && dayKey(Date.parse(r.at)) === today);
}

export const exportRound = Effect.fn("exportRound")(function* (options: RoundOptions) {
  const space = yield* CuaSpace;
  const archive = yield* ArchiveCommands;
  const notifier = yield* Notifier;
  const log = options.log ?? (() => {});
  const today = dayKey(options.now);
  const state = yield* Effect.promise(() => readState(options.dataDir));
  const { events, refused } = parseEvents((yield* space.read(SHARED.events)) ?? "");
  for (const { line, why } of refused) log(`events.jsonl line ${line} refused: ${why}`);

  const handled: ExportEvent[] = [];
  const imported: ImportRecord[] = [];
  for (const event of events.filter((e) => !state.seen.includes(e.id))) {
    if (event.kind === "downloaded") {
      const record = yield* collect(event, options).pipe(
        Effect.catchTag("CollectFailed", (failed) =>
          Effect.gen(function* () {
            // Nothing was taken from the Space: tried again next run, and firstmate told once.
            log(`${event.platform}: ${failed.message}`);
            if (!options.dryRun) yield* notifier.note(`cua-exports-${event.id}-not-taken`, `${NOTE_HEAD} ${platform(event.platform!).label}: the export the Cua Space downloaded could not be taken into the archive's folder (\`npm run cua-exports -- status\` says why); the next run tries again.`);
            return null;
          })),
      );
      if (record === null) continue;
      imported.push(record);
      if (!options.dryRun) {
        state.imports.push(record);
        yield* notifier.note(`cua-exports-${event.id}`, importNote(event, record));
      }
    } else {
      const note = noteFor(event, { space: space.space });
      log(`${event.platform ?? "round"}: ${event.kind}${note ? "" : " (no note)"}`);
      if (note && !options.dryRun) yield* notifier.note(`cua-exports-${event.id}`, note);
    }
    handled.push(event);
    if (!options.dryRun) {
      state.seen.push(event.id);
      yield* Effect.promise(() => writeState(options.dataDir, state));
    }
  }

  const lastHeard = events.map((e) => Date.parse(e.at)).sort((a, b) => a - b).at(-1);
  if (state.schedule?.enabled && (lastHeard === undefined || options.now - lastHeard > SILENT_DAYS * 86_400_000)) {
    const since = lastHeard === undefined ? "ever" : `since ${dayKey(lastHeard)}`;
    log(`the agent has not reported a round ${since}`);
    if (!options.dryRun) {
      yield* notifier.note(`cua-exports-silent-${today}`, `${NOTE_HEAD} the Cua Space's export agent has not reported a round ${since}: Codex may be signed out in the Space ` +
        `(the captain signs in again there), or the Space stopped. \`npm run cua-exports -- status\` in the life archive tells which.`);
    }
  }

  const coversTo = yield* archive.coversTo;
  const plan = exportPlan(events, coversTo, today);
  const text = `${JSON.stringify(plan, null, 2)}\n`;
  // Every write to the Cua Volume is a version kept for good: only a changed plan is written.
  if ((yield* space.read(SHARED.plan)) !== text) {
    log(`plan for ${today}: ${plan.tasks.map((t) => `${t.do} ${t.platform}`).join(", ") || "nothing"}`);
    if (!options.dryRun) yield* space.write(SHARED.plan, text);
  }

  // Signal is the captain's to export on his Mac; the schedule reminds him when it is due.
  const reminder = signalReminder(coversTo, today);
  if (reminder) {
    log("Signal's export is due (on the captain's Mac)");
    if (!options.dryRun) yield* notifier.note(reminder.id, reminder.text);
  }

  // The rounds: one whose run failed or ended without reporting its end is told once, by Cua's word, never the agent's.
  const runs = yield* space.runs;
  for (const round of state.rounds.slice(-ROUNDS_WATCHED)) {
    const run = runs.find((r) => r.id === round.run);
    if (!run || run.alive) continue;
    const finished = events.some((e) => e.kind === "round" && e.at >= round.at);
    if (!run.failed && finished) continue;
    log(`the round started ${round.at} (${round.run}) ${run.failed ? "failed" : "ended without finishing"}`);
    if (!options.dryRun) {
      yield* notifier.note(`cua-exports-${round.run}-ended`, `${NOTE_HEAD} the Cua Space's export round started ${dayKey(Date.parse(round.at))} ${timeOfDay(Date.parse(round.at))} ` +
        `${run.failed ? "failed before it finished (Cua says the run failed: Codex may not have started)" : "ended without reporting its end"}; ` +
        `\`npm run cua-exports -- status\` in the life archive shows Cua's reason, and \`npm run cua-exports -- nudge\` starts another.`);
    }
  }
  let started: RoundStart | null = null;
  if (roundDue(state.schedule, state.rounds, options.now)) {
    if (runs.some((r) => r.alive)) log("the day's round is due, but a round is still running");
    else if (options.dryRun) log("would start the day's round");
    else {
      started = { run: yield* space.startRound, at: new Date(options.now).toISOString(), why: "daily" };
      state.rounds.push(started);
      yield* Effect.promise(() => writeState(options.dataDir, state));
      log(`started the day's round: ${started.run}`);
    }
  }
  return { plan, handled, refused, imported, started } satisfies RoundResult;
});


/** The export could not be taken out of the Space, which keeps it. */
export class CollectFailed extends Data.TaggedError("CollectFailed")<{ readonly message: string }> {}

/**
 * Takes a downloaded export into platform-exports/<folder>/<day>/, checked, removes the Space's copies, and imports it:
 * how the import went. Fails with CollectFailed while nothing has moved; once the files are in the archive's folder an
 * import that fails is a record of the failure, for the captain to run again by hand.
 */
const collect = Effect.fn("collect")(function* (event: ExportEvent, options: RoundOptions) {
  const space = yield* CuaSpace;
  const archive = yield* ArchiveCommands;
  const log = options.log ?? (() => {});
  const p = platform(event.platform!);
  const files = event.files!;
  const day = event.day ?? dayKey(Date.parse(event.at));
  const folder = yield* Effect.promise(() => exportFolder(options.dataDir, p.folder, day, files.map((f) => f.name)));
  const relative = folder.slice(options.dataDir.length + 1);
  log(`${p.id}: ${files.length} file${files.length === 1 ? "" : "s"} (${megabytes(files.reduce((sum, f) => sum + f.bytes, 0))}) into ${relative}`);
  if (options.dryRun) return { event: event.id, platform: p.id, folder: relative, at: new Date(options.now).toISOString(), ok: true, detail: "dry run: nothing taken" };

  yield* Effect.promise(() => mkdir(folder, { recursive: true }));
  for (const file of files) {
    const to = join(folder, file.name);
    if (existsSync(to) && (yield* Effect.promise(() => sha256(to))) === file.sha256) continue;
    const partial = `${to}.part`;
    yield* space.copyOut(file.name, partial).pipe(Effect.mapError((failed) => new CollectFailed({ message: `could not copy ${file.name} out of the Space: ${failed.message}` })));
    const got = yield* Effect.promise(() => sha256(partial));
    if (got !== file.sha256) {
      yield* Effect.promise(() => rm(partial, { force: true }));
      return yield* new CollectFailed({ message: `${file.name} copied out of the Space is not the file the agent downloaded (its SHA-256 differs)` });
    }
    yield* Effect.promise(() => rename(partial, to));
  }
  // Every file is in the archive's folder and checked: the Space's copies go, and the export is the archive's now.
  for (const file of files) {
    yield* space.removeDownload(file.name).pipe(Effect.catch((failed) => Effect.sync(() => log(`${file.name} stays in the Space's Downloads: ${failed.message}`))));
  }

  const record = (ok: boolean, detail: string): ImportRecord => ({ event: event.id, platform: p.id, folder: relative, at: new Date(options.now).toISOString(), ok, detail });
  const result = yield* Effect.gen(function* () {
    // Meta's zips hold media, which the import reads only unpacked; Discord's package is read as it is.
    if (p.unpack) yield* archive.archive(["exports", "unpack", folder]);
    yield* archive.archive(["backup", `before-import-${p.connector}`]);
    const printed = yield* archive.archive(["import", p.connector, folder]);
    const counts = printed.split("\n").find((line) => line.startsWith("Messages:")) ?? "imported";
    const check = yield* archive.checkData;
    return record(true, `${counts}${check.ok ? " check-data: fine." : ` check-data: ${check.problems} problem${check.problems === 1 ? "" : "s"}.`}`);
  }).pipe(Effect.catch((failed) => Effect.succeed(record(false, failed.message.slice(-300)))));
  log(`${p.id}: ${result.ok ? "imported" : "import failed"}: ${result.detail}`);
  return result;
});

function importNote(event: ExportEvent, record: ImportRecord): string {
  const p = platform(event.platform!);
  const head = `${NOTE_HEAD} ${p.label}:`;
  if (!record.ok) {
    return `${head} the export the Cua Space downloaded is in ${record.folder} in the archive's folder, but its import failed; ` +
      `run it by hand as docs/import-runbook.md says (\`npm run cua-exports -- status\` has the error).`;
  }
  const check = record.detail.match(/check-data: (\d+) problems?\./);
  return `${head} the export the Cua Space downloaded is imported, from ${record.folder} (a backup was taken first). ` +
    `${record.detail.match(/^Messages: \d+ new/)?.[0] ?? "Imported"}.` +
    (check ? ` check-data names ${check[1]} problem${check[1] === "1" ? "" : "s"}: run \`npm run check-data\` and fix each.` : " check-data found nothing wrong.");
}

/**
 * The export's folder: platform-exports/<folder>/<day>/, or <day>-2 and on when that is taken by another export.
 * A folder holding only this export's files (a run cut short) is this export's.
 */
async function exportFolder(dataDir: string, folder: string, day: string, names: string[]): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = join(dataDir, "platform-exports", folder, n === 1 ? day : `${day}-${n}`);
    if (!existsSync(candidate)) return candidate;
    const there = (await readdir(candidate)).filter((name) => !name.startsWith("."));
    if (there.every((name) => names.includes(name) || names.some((own) => name === `${own}.part`))) return candidate;
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

export async function readState(dataDir: string): Promise<CollectorState> {
  try {
    const state = JSON.parse(await readFile(join(dataDir, STATE_FILE), "utf8")) as Partial<CollectorState>;
    return { ...state, seen: state.seen ?? [], imports: state.imports ?? [], rounds: state.rounds ?? [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { seen: [], imports: [], rounds: [] };
    throw error;
  }
}

export async function writeState(dataDir: string, state: CollectorState): Promise<void> {
  const file = join(dataDir, STATE_FILE);
  await mkdir(join(dataDir, "platform-exports"), { recursive: true });
  await atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`);
}
