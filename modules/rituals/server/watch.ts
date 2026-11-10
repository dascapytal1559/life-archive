// The module's work while the server runs (module.ts's `work`, sdk/server.ts): keeps the calendar's rituals rows in
// step with the store, which ritualctl writes outside the server (G's logging, a replay of its queue), and with the
// clock, since rituals' view moves with it (a day closes at 06:00, and the open day's habits not reported become not
// done). Every LOOK_EVERY_MS it looks at the store's file; when that has changed, or PUSH_EVERY_MS have passed, it
// reads the view and pushes its rows whole (calendar.replace: what is new or changed goes in, what rituals no longer
// shows is forgotten), and at once as the server starts. A store that cannot be read, or a push that fails, is said
// once and the calendar left as it was, until the next look. No store at all (an archive with no rituals, or one whose
// store has not moved in yet) pushes nothing: the rows the calendar has stay until the store is there.

import { statSync } from "node:fs";
import { Clock, countsText, Effect, type ModuleContext, type ModuleLive } from "../../../sdk/server.ts";
import { ritualsRows } from "./calendar.ts";
import { readRitualsNow, storeFile } from "./view.ts";

/** How often it looks at the store's file. */
export const LOOK_EVERY_MS = 20_000;

/** How long it lets the rows stand before pushing them again whatever the file says: the view moves with the clock. */
export const PUSH_EVERY_MS = 5 * 60_000;

/** The watch over the archive kept at `folder`: `look` once, at `now`, as the loop does every LOOK_EVERY_MS. */
export function ritualsSync({ folder, calendar }: ModuleContext & ModuleLive, log: (line: string) => void = (line) => console.log(`[rituals] ${line}`)): { look: (now: number) => void } {
  const file = storeFile(folder);
  /** The store file's mtime the rows were last pushed from, null while there is no store; undefined before the first look. */
  let stamp: number | null | undefined;
  let pushedAt = 0;
  let said: string | null = null;
  /** Says a problem once each time it changes, and nothing while it goes on. */
  const say = (line: string | null) => {
    if (line === said) return;
    said = line;
    if (line !== null) log(line);
  };
  return {
    look: (now) => {
      const mtime = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null;
      if (mtime === null) {
        if (stamp !== null) say(`no store at ${file}: the calendar's rituals rows are left as they are until there is one`);
        stamp = null;
        return;
      }
      if (mtime === stamp && now - pushedAt < PUSH_EVERY_MS) return;
      try {
        const view = readRitualsNow(folder, now);
        if (!view) return;
        const counts = calendar.replace(ritualsRows(view));
        if (counts.added + counts.updated + counts.forgotten > 0) log(`the calendar's rituals rows: ${countsText(counts)}`);
      } catch (error) {
        say(`${(error as Error).message}; the calendar's rituals rows are left as they were`);
        return;
      }
      stamp = mtime;
      pushedAt = now;
      say(null);
    },
  };
}

/** The watch as the server runs it: a look now, then one every LOOK_EVERY_MS, until the fiber is interrupted. */
export function ritualsWatch(context: ModuleContext & ModuleLive, log?: (line: string) => void): Effect.Effect<void> {
  const { look } = ritualsSync(context, log);
  return Effect.gen(function* () {
    while (true) {
      look(yield* Clock.currentTimeMillis);
      yield* Effect.sleep(LOOK_EVERY_MS);
    }
  });
}
