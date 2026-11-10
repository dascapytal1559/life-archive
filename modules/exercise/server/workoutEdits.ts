// The Workouts table's editor (sdk/server.ts's `edits`; the core's server/edits/): what the captain changes of a row
// from its drawer, opened from the Calendar or the table alike. A row is an activity (its first copy, workoutsTab.ts),
// and an edit changes every copy of it alike, so they stay one activity: its sport (and with it its family), when it
// started and ended, how far, each a correction kept beside the copies as Polar gave them (corrections.ts), and his note
// on it. Each edit is one changeset of the module's change log (the core's changes.ts over this database), which its
// undo puts back exactly, refusing when the field has been changed since; after either, the activity's rows are pushed
// into the calendar, so the Calendar, the table and the Fitness page all show it.

import {
  Changes, Effect, InvalidInputError, NotFoundError, instantOf, undoneInLog, wallText,
  type Applied, type EditRow, type EditValue, type FieldState, type ModuleLive, type ModuleStore, type TableEditor,
} from "../../../sdk/server.ts";
import { activityOf, calendarRow } from "./calendar.ts";
import { noteOf, setCorrection, setNote, type Corrected } from "./corrections.ts";
import { EXERCISE_CHANGE_TABLES } from "./db.ts";
import { WorkoutIndex, type WorkoutRow } from "./workoutIndex.ts";
import { WORKOUTS } from "./workoutsTab.ts";

/** Metres as the Distance field writes them: km, to two places. */
const km = (meters: number | null): number | null => (meters === null ? null : Math.round(meters / 10) / 100);

/** The editor of the Workouts table, over the module's database and the calendar it pushes into. */
export function workoutEditor({ db, calendar }: ModuleStore & ModuleLive): TableEditor {
  const changes = new Changes(db, { tables: EXERCISE_CHANGE_TABLES });
  changes.prune();
  const index = new WorkoutIndex(db);
  /** The activity's copies, the row's own first; none once it has gone. */
  const copiesOf = (row: EditRow): WorkoutRow[] => (row.kind === "workout" ? activityOf(index.all(), row.origin, row.nativeId) : []);
  /** The activity's rows again in the calendar: after an edit, or its undo. */
  const push = (copies: readonly WorkoutRow[]) => calendar.push(index.byIds(copies.map((copy) => copy.id)).map(calendarRow));

  const fieldsOf = (copy: WorkoutRow): Record<string, FieldState> => {
    const was = copy.corrected?.original;
    const edited = (field: Corrected) => (was && copy.corrected!.fields.includes(field)) || false;
    return {
      sport: { value: copy.workout.sport, ...(edited("sport") ? { original: was!.sport } : {}) },
      when: { value: wallText(copy.at), ...(edited("at") ? { original: wallText(was!.at) } : {}) },
      ended: { value: wallText(copy.atEnd), ...(edited("at_end") ? { original: wallText(was!.atEnd) } : {}) },
      distance: { value: km(copy.workout.distanceMeters), ...(edited("distance_m") ? { original: km(was!.distanceMeters) } : {}) },
      note: { value: null, has: noteOf(db, copy.origin, copy.nativeId) !== null },
    };
  };

  /** What `field` set to `value` writes into each copy, checked against the activity as it stands. */
  const write = (copies: readonly WorkoutRow[], field: string, value: EditValue): void => {
    const first = copies[0]!;
    for (const copy of copies) {
      switch (field) {
        case "sport":
          setCorrection(db, copy, "sport", String(value));
          break;
        case "when": {
          const at = instantOf(String(value));
          if (at >= first.atEnd) throw new InvalidInputError("a workout starts before it ends: change when it ended first");
          setCorrection(db, copy, "at", at);
          break;
        }
        case "ended": {
          const atEnd = instantOf(String(value));
          if (atEnd <= first.at) throw new InvalidInputError("a workout ends after it starts");
          setCorrection(db, copy, "at_end", atEnd);
          break;
        }
        case "distance":
          setCorrection(db, copy, "distance_m", value === null ? null : Math.round(Number(value) * 1000));
          break;
        case "note":
          setNote(db, copy, value === null ? null : String(value));
          break;
        default:
          throw new InvalidInputError(`a workout's ${JSON.stringify(field)} cannot be edited`);
      }
    }
  };

  const valueOf = (row: EditRow, field: string): EditValue => {
    const copy = copiesOf(row)[0];
    return copy ? fieldsOf(copy)[field]?.value ?? null : null;
  };

  return {
    table: WORKOUTS.spec.kind,
    state: (row) => {
      const copy = copiesOf(row)[0];
      return copy ? fieldsOf(copy) : null;
    },
    // A workout keeps nothing as it is: a page of the grid's rows needs only to know each is one, from one read of the index.
    locked: (rows) => {
      const all = index.all();
      return rows.map((row) => (row.kind === "workout" && all.some((copy) => copy.origin === row.origin && copy.nativeId === row.nativeId) ? {} : null));
    },
    undone: undoneInLog(changes, "Fitness's change log"),
    apply: (row, field, value, meta) =>
      Effect.sync((): Applied => {
        const copies = copiesOf(row);
        if (copies.length === 0) throw new NotFoundError(`the index has no workout ${row.origin}/${row.nativeId}`);
        const before = valueOf(row, field);
        const { changeset } = changes.record({ surface: meta.surface, action: `workout ${field}`, description: meta.why ?? undefined }, () => write(copies, field, value));
        push(copies);
        return { before, after: field === "note" ? null : valueOf(row, field), receipt: { changeset }, changed: changeset !== null };
      }),
    undo: (row, field, receipt, meta) =>
      Effect.sync((): Applied => {
        if (typeof receipt.changeset !== "number") throw new InvalidInputError("that edit changed nothing, so there is nothing to put back");
        const before = valueOf(row, field);
        const copies = copiesOf(row);
        const undone = changes.undo(receipt.changeset, { surface: meta.surface, description: meta.why ?? undefined });
        // The copies it touched, as they stood and as they stand now (an undo of a time moves them back).
        push([...copies, ...copiesOf(row)]);
        return { before, after: valueOf(row, field), receipt: { changeset: undone.changeset } };
      }),
    note: (row) => {
      const copy = copiesOf(row)[0];
      return copy ? noteOf(db, copy.origin, copy.nativeId) : null;
    },
  };
}
