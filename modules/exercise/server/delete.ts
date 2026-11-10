// An activity's delete, from its page on the Fitness page (DELETE /life-archive/api/m/exercise/activities/<id>,
// http.ts): every copy of it removed for good, as the captain asked ("not even a backup of that work is kept, it's just
// completely gone").
//
// For each of its copies (every source's: the polar connector's AccessLink copy, polar-export's session):
//   - its files: the copy (AccessLink's <id>.json, or the export's training-session_*.json) and its source's own
//     recording beside it (AccessLink's <id>.fit), and the copy's entry in each of its export's zips kept beside it
//     (each such zip written again without it, through a temporary file, every other entry's bytes as they were);
//   - its rows in the core's calendar (the module's calendar, sdk/server.ts: forgotten for good) and then its rows in
//     the module's index (workoutIndex.ts), each with SQLite's secure_delete on, so their bytes are overwritten, and
//     the WAL checkpointed, so no older page of them stays in it; the calendar's first, as the index's are what a
//     delete tried again finds the copies by;
//   - what the server worked out of it (activities.ts's forgetReadings).
// What stays is a tombstone a copy (deletedWorkouts.ts): its source and id, family and times, and when, so no
// import or sync brings it back. No backup is taken first, as every change to people takes one: that would keep it.
//
// Refused, with nothing changed, when it cannot be whole: a copy transcribed by hand (health/by-hand.json, which only
// the captain edits), any activity while those copies cannot be known (the health module off, or by-hand.json not
// readable), a copy's file another workout's copy shares (an export's multisport session), a file outside the archive's
// platform exports, or a zip too big to write again in memory.
// While it runs, the live sync of its sources is stopped (the core's host, through the module's pausingLive), so no
// pass under way fetches a copy again, and started again after, with the new tombstones.
//
// What it cannot reach: the backups taken before, which hold its rows (data/backups/'s of archive.sqlite and
// exercise.sqlite, and the NAS's nightly snapshots and Time Machine's, of calendar.sqlite too), and the NAS's and Time
// Machine's copies of its files; the archive's own old rows from before the module (metadata only: a copy's index row), which stay there, and
// in the archive's backups, until `migrate friend-map-module` overwrites them (server/archive/legacy.ts); and Polar
// Flow itself, which keeps it until it is deleted there (a later account export then brings its file again, which the
// import leaves out). The module's README says so.

import { readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { DatabaseSync as Db } from "node:sqlite";
import { atomicWrite, Effect, EXPORTS_FOLDER, overwriting, transaction, UnavailableError, ZipFile, zipBytes, type ModuleLive, type ModuleStore, type ZipInput } from "../../../sdk/server.ts";
import type { ActivityDeleted } from "../wire.ts";
import { forgetReadings, type Built } from "./activities.ts";
import { layTombstones, type DeletedWorkout } from "./deletedWorkouts.ts";
import { forgetCorrections } from "./corrections.ts";
import { fileAt, WorkoutIndex, type WorkoutRow } from "./workoutIndex.ts";

/** A zip bigger than this is not written again (it is held in memory to be): the delete is refused instead. */
export const MAX_ZIP_BYTES = 1024 ** 3;

/** What a delete will remove, worked out before anything is. */
interface Plan {
  events: WorkoutRow[];
  tombstones: DeletedWorkout[];
  /** Every file of the copies, absolute. */
  files: string[];
  /** Each zip holding a copy's file, and the entries to leave out of it. */
  zips: Map<string, Set<string>>;
}

/** A delete that could not begin (the archive not open), nothing touched: the route answers 503, as it does for an archive not available. */
export class DeleteNotBegun {
  readonly _tag = "DeleteNotBegun";
  readonly message: string;

  constructor(message: string) {
    this.message = message;
  }
}

/**
 * Deletes the activity `built`, every copy of it, at `now`, over what the module is given (its database, the archive's
 * folder, the calendar and the live connectors): what was removed, or why not: refused with nothing changed, or stopped
 * after its tombstones (UnavailableError), or not begun (DeleteNotBegun).
 */
export const deleteActivity = Effect.fn("deleteActivity")(function* ({ db, folder, calendar, pausingLive }: ModuleStore & Pick<ModuleLive, "calendar" | "pausingLive">, built: Built, now: number) {
  const plan = yield* planOf(db, folder, built);
  const platforms = [...new Set(plan.events.map((event) => event.origin))];
  let begun = false;
  yield* Effect.tryPromise({
    try: () =>
      pausingLive(platforms, async () => {
        // The tombstones first: whatever stops it after this, nothing brings the copies back, and a delete tried again finishes it.
        transaction(db, () => layTombstones(db, plan.tombstones, now));
        begun = true;
        for (const [zip, names] of plan.zips) await writeZipWithout(zip, names);
        for (const file of plan.files) await rm(file, { force: true });
        calendar.forget(plan.events.map((event) => ({ origin: event.origin, nativeId: event.nativeId })));
        removeRows(db, plan.events);
        forgetReadings(folder);
      }),
    catch: (error) => (begun ? new UnavailableError(`the delete stopped part way, and can be tried again: ${(error as Error).message}`) : new DeleteNotBegun((error as Error).message)),
  });
  return { id: built.detail.id, copies: plan.events.length, files: plan.files.length + plan.zips.size } satisfies ActivityDeleted;
});

/** What deleting `built` removes, or why it cannot be deleted whole. */
const planOf = Effect.fnUntraced(function* (db: Db, dataDir: string, built: Built) {
  if (built.detail.cannotDelete) return yield* new UnavailableError(built.detail.cannotDelete);
  const index = new WorkoutIndex(db);
  const events = built.copies.map((c) => c.event).filter((event): event is WorkoutRow => event !== null);
  const ids = new Set(events.map((event) => event.id));
  const exports = resolve(dataDir, EXPORTS_FOLDER);
  const files: string[] = [];
  for (const event of events) {
    for (const stored of [event.workout.file, event.workout.rawFile]) {
      if (stored === null) continue;
      const file = resolve(fileAt(stored, dataDir));
      if (!file.startsWith(exports + sep)) {
        return yield* new UnavailableError(`a copy's file is outside the archive's platform exports (${basename(file)}), so nothing was deleted`);
      }
      const others = index.sharingFile(stored, ids);
      if (others > 0) {
        return yield* new UnavailableError(
          `its copy ${basename(file)} also holds ${others === 1 ? "another workout" : `${others} other workouts`} (a session of several sports), so nothing was deleted`,
        );
      }
      if (!files.includes(file)) files.push(file);
    }
  }
  const zips = new Map<string, Set<string>>();
  const unread = (error: unknown) => new UnavailableError(`an export's zip beside it could not be read (${(error as Error).message}), so nothing was deleted`);
  for (const file of files) {
    for (const zip of yield* Effect.tryPromise({ try: () => zipsHolding(dirname(file), basename(file)), catch: unread })) {
      if ((yield* Effect.tryPromise({ try: () => stat(zip), catch: unread })).size > MAX_ZIP_BYTES) {
        return yield* new UnavailableError(`${basename(zip)} is too big to write again without its copy, so nothing was deleted`);
      }
      zips.set(zip, (zips.get(zip) ?? new Set()).add(basename(file)));
    }
  }
  // As its source gave it, not as the captain corrected it: the tombstone matches what a connector brings again.
  const tombstones = events.map((event) => {
    const source = event.corrected?.original ?? { family: event.subkind, at: event.at, atEnd: event.atEnd };
    return { origin: event.origin, id: event.nativeId, family: source.family, at: source.at, endAt: source.atEnd };
  });
  return { events, tombstones, files, zips } satisfies Plan;
});

/** The zips in `folder` (at its top, as an export keeps them) holding an entry `name`, at their top or in a zip stored in them. */
async function zipsHolding(folder: string, name: string): Promise<string[]> {
  const zips = (await readdir(folder).catch(() => [] as string[])).filter((entry) => entry.toLowerCase().endsWith(".zip")).sort();
  const holding: string[] = [];
  for (const entry of zips) {
    const zip = await ZipFile.open(join(folder, entry));
    try {
      if (await holds(zip, new Set([name]))) holding.push(join(folder, entry));
    } finally {
      await zip.close();
    }
  }
  return holding;
}

/** Whether `zip` holds an entry of `names` at its top, or in a zip stored in it (as exports unpack reads them). */
async function holds(zip: ZipFile, names: ReadonlySet<string>): Promise<boolean> {
  for (const entry of zip.entries) {
    if (names.has(entry.name)) return true;
    if (nested(entry)) {
      const inner = await zip.openNested(entry);
      try {
        if (await holds(inner, names)) return true;
      } finally {
        await inner.close();
      }
    }
  }
  return false;
}

/** A zip stored (not compressed) at the top of another, as Meta's parts carry one and exports unpack opens it. */
const nested = (entry: ZipFile["entries"][number]) => !entry.name.includes("/") && entry.name.toLowerCase().endsWith(".zip") && entry.method === 0 && entry.size > 0;

/** `zip`'s entries less those named `names`, a zip stored in it likewise; each other entry's bytes as they were. */
async function entriesWithout(zip: ZipFile, names: ReadonlySet<string>): Promise<ZipInput> {
  const kept: ZipInput = [];
  for (const entry of zip.entries) {
    if (names.has(entry.name)) continue;
    if (nested(entry)) {
      const inner = await zip.openNested(entry);
      try {
        kept.push({ name: entry.name, data: (await holds(inner, names)) ? zipBytes(await entriesWithout(inner, names)) : await zip.read(entry), stored: true });
      } finally {
        await inner.close();
      }
      continue;
    }
    kept.push({ name: entry.name, data: entry.name.endsWith("/") ? Buffer.alloc(0) : await zip.read(entry), stored: entry.method === 0 });
  }
  return kept;
}

/** Writes `file` again without the entries `names`, through a temporary file beside it, then over it. */
async function writeZipWithout(file: string, names: ReadonlySet<string>): Promise<void> {
  const zip = await ZipFile.open(file);
  let bytes: Buffer;
  try {
    bytes = zipBytes(await entriesWithout(zip, names));
  } finally {
    await zip.close();
  }
  await atomicWrite(file, bytes);
}

/** Removes the copies' index rows, for good. */
function removeRows(db: Db, events: readonly WorkoutRow[]): void {
  overwriting(db, () =>
    transaction(db, () => {
      for (const event of events) db.prepare("DELETE FROM workout WHERE id = ?").run(event.id);
      forgetCorrections(db, events);
    }),
  );
}
