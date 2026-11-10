// The polar-export connector: the captain's workouts from Polar's account data export (session.ts), for the
// module's index (server/workoutIndex.ts), beside the live polar connector's. The export is filed as every platform's is, unpacked in place in
// platform-exports/polar/<export date>/ (docs/data.md's "Platform exports"), and is its own copy: nothing is copied, each
// event names the session's file where it is, and the export is only read. Every training-session_*.json at the top
// of the folder is read; a file this connector cannot read is never guessed at: it is counted (tally
// polar-sessions-not-read) and left. Its events have origin polar, as the API's, under ids of their own
// (export/<id>), so an export of runs the API also brought adds copies the matcher joins to theirs, and an export
// imported again changes nothing. An exercise of a workout the captain deleted (../../server/deletedWorkouts.ts: its
// tombstones come in the settings) is left out, by its id or as the same activity, and counted (tally workouts-deleted).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { whole, type Connector } from "../../../../sdk/connector.ts";
import { DELETED_TALLY, deletedIn, isDeleted } from "../../server/deletedWorkouts.ts";
import { manifest } from "./manifest.ts";
import { workoutEvents, type PolarSession } from "./session.ts";

export const UNREAD_TALLY = "polar-sessions-not-read";

/** A training session's file in an export. */
export const SESSION_FILE = /^training-session_.+\.json$/;

export const polarExport: Connector = {
  manifest,

  history: ({ sources, config, emit }) =>
    whole(async () => {
      const deleted = deletedIn(config);
      let unread = 0;
      let left = 0;
      for (const folder of sources) {
        const names = (await readdir(folder)).filter((name) => SESSION_FILE.test(name)).sort();
        for (const name of names) {
          const file = join(folder, name);
          let events;
          try {
            const bytes = await readFile(file);
            events = workoutEvents(JSON.parse(bytes.toString("utf8")) as PolarSession, file, bytes.length);
          } catch {
            unread++;
            continue;
          }
          for (const event of events) {
            if (isDeleted(deleted, { origin: manifest.platform, id: event.id, family: event.family, at: event.at, endAt: event.endAt })) left++;
            else await emit(event);
          }
        }
      }
      if (unread > 0) await emit({ kind: "tally", name: UNREAD_TALLY, count: unread });
      if (left > 0) await emit({ kind: "tally", name: DELETED_TALLY, count: left });
    }),
};

