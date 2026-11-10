// The change log: every edit to people (and every group chat dropped or
// brought back, everyone taken out of one or put back, everyone unlinked from one or linked through it again, every catch-up and logged call added, changed or deleted, and every call
// given a length or had it taken away, or a note; and the logged tables of a part of the archive with a log of its own, given them: the inspirations' items and tags, said by their describer (modules/inspirations/server/changeLog.ts), and the exercise module's corrections to its workouts), from the app (its routes) or the CLI, is one changeset (the changeset table): when, where from (app or cli), what
// was done, the captain's words when an agent passed them, the backup the CLI
// took just before, and every row it changed as it was before and after
// (change_row), so it can be shown and undone exactly.
//
// The rows are written by triggers on the tables that hold what the captain
// decides (changeTables.ts's TABLES), and only while a changeset is being recorded: the
// rules, imports and live sync change those tables too, but outside a
// changeset, so they are never logged. The triggers are TEMP, made on each
// connection that opens the archive, and fire only while temp.change_context
// names the changeset being recorded. Several writes to one row in a changeset
// are kept as one (its first before and last after), and a row that ends as it
// began is dropped; an edit that changes nothing leaves no changeset.
//
// What the rules work out from those tables (a person's archive rule, the
// counts, pending proposals) is not logged: after an undo they are worked out
// again for the people it touched (People.settle). Drafts (drafts.ts) are saved
// as the captain types, outside any changeset; a merge or a delete that moves
// or takes them is logged, so its undo puts them back where it can.
//
// Undo reverts exactly what a changeset changed, as a changeset of its own (so
// it can be undone too). It refuses, naming the people, when anything the
// changeset set has been changed again since, or when putting it back would
// change anything else (a tag it added that someone has been given since, say).
// Of a row it changed, only the columns it changed are checked and put back,
// so a location set since a name was changed stays when the name change is undone.
// When a row was last edited and when an account was last linked are put back
// only when nothing has changed them since, and never refuse an undo.
//
// Changesets are kept for KEEP_DAYS days, and older ones are deleted when the
// archive opens.

import type { ChangeSurface, ChangesetInfo, FieldChange, PersonChange, Trip } from "../../src/archive.ts";
import { callDuration, callPlatformName } from "../../src/calls.ts";
import { catchUpDayCount, catchUpTitle, catchUpWhen, othersLabel, timeLabel } from "../../src/catchUps.ts";
import { HANGOUT } from "../../src/eventWords.ts";
import { dayKey, timeOfDay } from "../../src/time.ts";
import { InvalidInputError, NotFoundError, UnavailableError } from "../errors.ts";
import { installTriggers, type Row, TABLES, type TableSpec } from "./changeTables.ts";
import { transaction, type Db } from "./db.ts";

/** How long a changeset is kept. */
export const KEEP_DAYS = 90;

/** How many people a listing shows of each changeset (show gives them all). */
const LISTED_PEOPLE = 12;

/** The longest description kept. */
const DESCRIPTION_MAX = 2000;

/** One row a changeset changed: null before when it added the row, null after when it deleted it. */
interface Change {
  tbl: string;
  key: string;
  before: Row | null;
  after: Row | null;
}

/** One row a changeset changed, as a describer is shown it. */
export type LoggedChange = Readonly<Change>;

/**
 * How a change log says the changes to logged tables it is given beside the core's (`tables`), that it knows nothing
 * of itself (the inspirations module's, modules/inspirations/server/changeLog.ts): without one, a row of theirs is named by its table alone.
 */
export interface ChangeDescriber {
  /**
   * Who or what a changed row is about, for an undo that is refused (given the row as it is now, null when it is gone,
   * and the columns the changeset set that are not as it left them); null for a row of a table not its.
   */
  conflictOf(change: LoggedChange, row: Row, at: { now: Row | null; changedSince: readonly string[] }): UndoConflict | null;
  /** What an undo is refused for when a row put back in one of these tables points at something gone since, by table. */
  references?: Readonly<Record<string, UndoConflict>>;
  /** The summary's other lines for what the changeset changed of its tables. */
  lines(changes: readonly LoggedChange[]): string[];
}

/** Where an edit came from and what it was, for its changeset. */
export interface ChangeMeta {
  surface: ChangeSurface;
  /** What was done, in a few words. */
  action: string;
  /** The captain's words, when an agent passes them. */
  description?: unknown;
  /** The backup taken just before, by file name. */
  backup?: string | null;
  /**
   * Adds to this changeset rather than making one, so one instruction that
   * takes several edits is undone as one: only the newest changeset, from the
   * same surface, neither an undo nor undone.
   */
  into?: number;
}

/** What an edit returned, and the changeset it made (null when it changed nothing). */
export interface Recorded<T> {
  value: T;
  changeset: number | null;
}

/** Something a changeset changed that has been changed again since, so it can't be undone. */
export interface UndoConflict {
  /** The person, when it is about one. */
  personId: number | null;
  /** Who or what: a person's name, or "the tag x". */
  name: string;
  /** What was changed since: "tags", "location", "name"... */
  what: string;
}

/** An undo refused: what was changed since, by whom. */
export class UndoConflictError extends UnavailableError {
  readonly conflicts: UndoConflict[];
  constructor(changeset: number, conflicts: UndoConflict[], why = "changed again since") {
    super(`can't undo #${changeset}: ${why}: ${describeConflicts(conflicts)}`);
    this.conflicts = conflicts;
  }
}

interface ChangesetRow {
  id: number;
  at: number;
  surface: ChangeSurface;
  action: string;
  description: string | null;
  backup: string | null;
  summary_json: string;
  undoes: number | null;
  undone_by: number | null;
}

interface Summary {
  people: PersonChange[];
  other: string[];
}

/** What an undo asks the people rules to work out again (friend map's People.settle): for these people, their links and counts too when said. */
export type Settle = (personIds: number[], options: { links: boolean; recount: boolean }) => void;

export class Changes {
  private readonly db: Db;
  /** Works out again what the rules keep of the people an undo touched (friend map's People.settle); none for a log of no people. */
  private readonly settle: Settle | undefined;
  /** Hears the tables a changeset meaningfully changed after it is made (an undo's too), once its transaction has committed: the calendar's push (archive/index.ts). */
  private readonly afterChange: ((tables: string[]) => void) | undefined;
  /** The logged tables its database has: the archive's people and chats, or a module's own (the inspirations', the exercise module's corrections). */
  private readonly tables: ReadonlySet<string>;
  /** The logged tables' specs: the core's (TABLES), and those it is given (`tables`: a module's, the inspirations' or the exercise module's corrections). */
  private readonly specs: Readonly<Record<string, TableSpec>>;
  /** How the changes to the tables it is given are said, when they have their own words (the inspirations module's). */
  private readonly describer: ChangeDescriber | undefined;

  /** `tables`: logged tables of its own, beside the core's (TABLES), for a change log over another database; `describe`, how their changes are said. */
  constructor(db: Db, { settle, afterChange, tables = {}, describe }: {
    settle?: Settle; afterChange?: (tables: string[]) => void; tables?: Readonly<Record<string, TableSpec>>; describe?: ChangeDescriber;
  } = {}) {
    this.db = db;
    this.settle = settle;
    this.afterChange = afterChange;
    this.describer = describe;
    this.specs = { ...TABLES, ...tables };
    this.tables = installTriggers(db, this.specs);
  }

  /**
   * Runs `work` (one or more edits to people) as one changeset, in one
   * transaction: every row it changes is logged. An edit that changes nothing
   * leaves no changeset. Inside another changeset, `work` joins that one; with
   * `into`, it is added to that changeset (see ChangeMeta).
   */
  record<T>(meta: ChangeMeta & { undoes?: number }, work: () => T): Recorded<T> {
    const description = cleanDescription(meta.description);
    const action = meta.action.trim();
    if (!action) throw new InvalidInputError("a change needs an action");
    let tables: string[] = [];
    const recorded = transaction(this.db, () => {
      const current = this.current();
      if (current !== null) return { value: work(), changeset: current };
      let id: number;
      if (meta.into !== undefined) {
        const joined = this.row(meta.into);
        const newest = (this.db.prepare("SELECT max(id) AS id FROM changeset").get() as { id: number }).id;
        if (joined.id !== newest) throw new InvalidInputError(`only the newest changeset can take more, and that is #${newest}, not #${joined.id}`);
        if (joined.undone_by !== null || joined.undoes !== null || joined.surface !== meta.surface) {
          throw new InvalidInputError(`#${joined.id} can't take more: it ${joined.undone_by !== null ? "was undone" : joined.undoes !== null ? "is an undo" : `was made in the ${joined.surface}`}`);
        }
        id = joined.id;
        this.db.prepare("UPDATE changeset SET action = action || '; ' || ?, description = coalesce(?, description) WHERE id = ?").run(action, description, id);
      } else {
        id = Number(this.db
          .prepare("INSERT INTO changeset (at, surface, action, description, backup, summary_json, undoes) VALUES (?, ?, ?, ?, ?, '{}', ?)")
          .run(Date.now(), meta.surface, action, description, meta.backup ?? null, meta.undoes ?? null).lastInsertRowid);
      }
      this.db.prepare("INSERT INTO temp.change_context (changeset_id) VALUES (?)").run(id);
      let value: T;
      try {
        value = work();
      } finally {
        this.db.exec("DELETE FROM temp.change_context");
      }
      const changes = this.collapse(id);
      tables = [...new Set(changes.filter((change) => meaningful(change, this.specs)).map((change) => change.tbl))];
      if (tables.length === 0) {
        this.db.prepare("DELETE FROM changeset WHERE id = ?").run(id);
        return { value, changeset: null };
      }
      this.db.prepare("UPDATE changeset SET summary_json = ? WHERE id = ?").run(JSON.stringify(this.summarize(changes)), id);
      if (meta.undoes !== undefined) this.db.prepare("UPDATE changeset SET undone_by = ? WHERE id = ?").run(id, meta.undoes);
      return { value, changeset: id };
    });
    // Once the outermost transaction has committed, and only when something changed.
    if (recorded.changeset !== null && !this.db.isTransaction) this.afterChange?.(tables);
    return recorded;
  }

  /** The newest changesets first (each with its first few people); with `tables`, only those that changed a row of one. */
  list({ limit = 50, tables }: { limit?: number; tables?: readonly string[] } = {}): ChangesetInfo[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new InvalidInputError("limit is a whole number from 1");
    const only = tables ? "WHERE id IN (SELECT changeset_id FROM change_row WHERE tbl IN (SELECT value FROM json_each(?)))" : "";
    return (this.db.prepare(`SELECT * FROM changeset ${only} ORDER BY id DESC LIMIT ?`).all(...(tables ? [JSON.stringify(tables)] : []), limit) as unknown as ChangesetRow[])
      .map((row) => info(row, LISTED_PEOPLE));
  }

  /** The tables changeset `id` changed rows of. */
  tablesOf(id: number): string[] {
    this.row(id);
    return (this.db.prepare("SELECT DISTINCT tbl FROM change_row WHERE changeset_id = ? ORDER BY tbl").all(id) as { tbl: string }[]).map((row) => row.tbl);
  }

  /** One changeset, with everyone it touched. */
  show(id: number): ChangesetInfo {
    return info(this.row(id), Infinity);
  }

  /**
   * Whether changeset `id` stands undone now, by the changeset that undid it (which stands itself: one whose undo was
   * undone stands again), as undo's refusal reads it; null when the log no longer has it (it keeps them KEEP_DAYS).
   * The tables' record reads its edits' standing from here (server/edits/edits.ts), so the two never disagree.
   */
  standing(id: number): { undoneBy: number | null } | null {
    const undoneBy = this.undoneByOf(id);
    return undoneBy === undefined ? null : { undoneBy };
  }

  /**
   * The changeset that undid changeset `id` and stands itself (so stands undone at any depth of undoes of undoes), null
   * while `id` stands, or undefined when the log no longer has it.
   */
  private undoneByOf(id: number): number | null | undefined {
    const row = this.db.prepare("SELECT undone_by FROM changeset WHERE id = ?").get(id) as { undone_by: number | null } | undefined;
    if (!row) return undefined;
    if (row.undone_by === null) return null;
    return this.undoneByOf(row.undone_by) === null ? row.undone_by : null;
  }

  /**
   * Undoes changeset `id`: every row it changed goes back to how it was, as a
   * changeset of its own. Refuses (UndoConflictError, naming the people) when
   * anything it set has changed since, or putting it back would change anything
   * else; and when it has been undone already (undo that undo to do it again).
   */
  undo(id: number, meta: Omit<ChangeMeta, "action">): Recorded<ChangesetInfo> {
    this.row(id);
    const by = this.undoneByOf(id);
    if (by) throw new UnavailableError(`#${id} was undone by #${by}; undo #${by} to do it again`);
    const changes = this.changesOf(id);
    // A hangout by call, logged before there were none (migration 61), cannot come back: its call is the call it was.
    const byCall = changes.filter((c) => c.tbl === "catch_up" && c.before?.by_call === 1);
    if (byCall.length > 0) {
      throw new UndoConflictError(id, byCall.map((c) => ({
        personId: null,
        name: `${HANGOUT.one} #${(JSON.parse(c.key) as number[])[0]}`,
        what: "it was by call, and a hangout is in person now: log the call as a call",
      })), "it would bring back a hangout by call");
    }
    const conflicts = this.conflicts(changes);
    if (conflicts.length > 0) throw new UndoConflictError(id, conflicts);
    const done = this.record({ ...meta, action: `undo #${id}`, undoes: id }, () => {
      // Rows go back in any order; their references are checked once all are back.
      this.db.exec("PRAGMA defer_foreign_keys = ON");
      this.putBack(changes);
      this.checkPutBack(id, changes);
      const personIds = new Set<number>();
      let links = false;
      let recount = false;
      for (const change of changes) {
        for (const personId of this.peopleOf(change)) personIds.add(personId);
        if (change.tbl === "import_person" || change.tbl === "merge_proposal") links = true;
        if (change.tbl === "conversation" || change.tbl === "conversation_member") links = recount = true;
      }
      this.settle?.([...personIds], { links, recount });
    });
    if (done.changeset === null) throw new UnavailableError(`#${id} changed nothing that can be put back`);
    return { value: this.show(done.changeset), changeset: done.changeset };
  }

  /** Deletes changesets older than KEEP_DAYS. Returns how many went. */
  prune(now = Date.now()): number {
    return Number(this.db.prepare("DELETE FROM changeset WHERE at < ?").run(now - KEEP_DAYS * 24 * 60 * 60 * 1000).changes);
  }

  // --- recording

  /** The changeset being recorded on this connection, if any. */
  private current(): number | null {
    return (this.db.prepare("SELECT changeset_id FROM temp.change_context").get() as { changeset_id: number } | undefined)?.changeset_id ?? null;
  }

  /** Keeps one row per changed row, its first before and last after, and drops those that end as they began. */
  private collapse(id: number): Change[] {
    const net = new Map<string, { tbl: string; key: string; before: string | null; after: string | null }>();
    for (const row of this.db
      .prepare("SELECT tbl, row_key, before_json, after_json FROM change_row WHERE changeset_id = ? ORDER BY id")
      .all(id) as { tbl: string; row_key: string; before_json: string | null; after_json: string | null }[]) {
      const at = `${row.tbl}\n${row.row_key}`;
      const seen = net.get(at);
      if (seen) seen.after = row.after_json;
      else net.set(at, { tbl: row.tbl, key: row.row_key, before: row.before_json, after: row.after_json });
    }
    this.db.prepare("DELETE FROM change_row WHERE changeset_id = ?").run(id);
    const insert = this.db.prepare("INSERT INTO change_row (changeset_id, tbl, row_key, before_json, after_json) VALUES (?, ?, ?, ?, ?)");
    const kept: Change[] = [];
    for (const row of net.values()) {
      if (row.before === row.after) continue;
      insert.run(id, row.tbl, row.key, row.before, row.after);
      kept.push({ tbl: row.tbl, key: row.key, before: parse(row.before), after: parse(row.after) });
    }
    return kept;
  }

  private changesOf(id: number): Change[] {
    return (this.db
      .prepare("SELECT tbl, row_key, before_json, after_json FROM change_row WHERE changeset_id = ? ORDER BY id")
      .all(id) as { tbl: string; row_key: string; before_json: string | null; after_json: string | null }[])
      .map((row) => ({ tbl: row.tbl, key: row.row_key, before: parse(row.before_json), after: parse(row.after_json) }));
  }

  private row(id: number): ChangesetRow {
    if (!Number.isSafeInteger(id)) throw new InvalidInputError("give a changeset number");
    const row = this.db.prepare("SELECT * FROM changeset WHERE id = ?").get(id) as ChangesetRow | undefined;
    if (!row) throw new NotFoundError(`no changeset #${id} (they are kept for ${KEEP_DAYS} days)`);
    return row;
  }

  // --- undoing

  /** A row as it is now, with the columns a changeset logs; null when there is no such row. */
  private now(tbl: string, key: string): Row | null {
    const spec = this.specs[tbl];
    const values = JSON.parse(key) as unknown[];
    return (this.db
      .prepare(`SELECT ${[...spec.key, ...spec.columns].join(", ")} FROM ${tbl} WHERE ${spec.key.map((k) => `${k} = ?`).join(" AND ")}`)
      .get(...(values as (string | number)[])) as Row | undefined) ?? null;
  }

  /** What in `changes` is not as the changeset left it. */
  private conflicts(changes: Change[]): UndoConflict[] {
    const found: UndoConflict[] = [];
    for (const change of changes) {
      const spec = this.specs[change.tbl];
      if (!spec) {
        found.push(this.goneConflict(change));
        continue;
      }
      if (spec.lenient) continue;
      if (!same(this.now(change.tbl, change.key), change.after, checked(change, spec))) found.push(this.conflictOf(change, change.after ?? change.before!));
    }
    return found;
  }

  /** Puts every row back as it was before the changeset: added rows are deleted, changed rows set back, deleted rows made again. */
  private putBack(changes: Change[]): void {
    for (const change of changes.filter((c) => c.before === null)) {
      const spec = this.specs[change.tbl];
      if (spec.lenient && !same(this.now(change.tbl, change.key), change.after, checked(change, spec))) continue;
      const values = JSON.parse(change.key) as (string | number)[];
      this.db.prepare(`DELETE FROM ${change.tbl} WHERE ${spec.key.map((k) => `${k} = ?`).join(" AND ")}`).run(...values);
    }
    for (const change of changes.filter((c) => c.before !== null && c.after !== null)) {
      const spec = this.specs[change.tbl];
      const now = this.now(change.tbl, change.key);
      if (!now) continue;
      const before = change.before!;
      // What it changed goes back, and a loose column only if nothing has changed it since; the rest is as it is now.
      const columns = [...checked(change, spec), ...spec.loose.filter((c) => Object.hasOwn(before, c) && before[c] !== change.after![c] && now[c] === change.after![c])];
      if (columns.length === 0) continue;
      const values = JSON.parse(change.key) as (string | number)[];
      this.db
        .prepare(`UPDATE ${change.tbl} SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE ${spec.key.map((k) => `${k} = ?`).join(" AND ")}`)
        .run(...columns.map((c) => before[c]), ...values);
    }
    for (const change of changes.filter((c) => c.after === null)) {
      const spec = this.specs[change.tbl];
      const columns = [...spec.key, ...spec.columns].filter((c) => Object.hasOwn(change.before!, c));
      this.db
        .prepare(`INSERT ${spec.lenient ? "OR IGNORE " : ""}INTO ${change.tbl} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...columns.map((c) => change.before![c]));
    }
  }

  /**
   * Refuses the undo (it rolls back) when putting the rows back changed any row
   * the changeset did not (a tag it added, deleted with everyone given it since),
   * or left a reference broken (a person it added who has been given an account since).
   */
  private checkPutBack(id: number, changes: Change[]): void {
    const current = this.current()!;
    const expected = new Map(changes.map((c) => [`${c.tbl}\n${c.key}`, c]));
    const collateral: UndoConflict[] = [];
    for (const done of this.collapse(current)) {
      const spec = this.specs[done.tbl];
      if (spec.lenient) continue;
      const change = expected.get(`${done.tbl}\n${done.key}`);
      if (!change || !same(done.after, change.before, checked(change, spec))) collateral.push(this.conflictOf(done, done.before ?? done.after!));
    }
    if (collateral.length > 0) throw new UndoConflictError(id, collateral, "putting it back would also change what was done since");
    // Only the tables that point at people, tags and catch-ups: the rest could not have been broken by putting rows back.
    const references = this.describer?.references ?? {};
    const broken = ["import_person", "person_tag", "catch_up_person", "manual_call", "draft", "group_unlink", ...Object.keys(references)]
      .filter((table) => this.tables.has(table))
      .flatMap((table) => this.db.prepare(`PRAGMA foreign_key_check(${table})`).all() as { table: string; rowid: number; parent: string }[]);
    if (broken.some((row) => row.table === "catch_up_person" && row.parent === "person")) {
      // A catch-up put back with someone who has been joined into someone else, or deleted, since.
      throw new UndoConflictError(id, [{ personId: null, name: `a ${HANGOUT.one} it puts back`, what: "someone at it has been joined into someone else or deleted since" }]);
    }
    // A row of a table it was given put back that points at something deleted since (an item's tag whose tag is gone).
    const referenced = broken.find((row) => Object.hasOwn(references, row.table));
    if (referenced) throw new UndoConflictError(id, [references[referenced.table]!]);
    if (broken.some((row) => row.table === "manual_call" || row.table === "draft" || row.table === "group_unlink")) {
      // A logged call, draft or group unlink put back with someone who has been joined into someone else, or deleted, since.
      const what = broken.some((row) => row.table === "manual_call") ? "a logged call" : broken.some((row) => row.table === "draft") ? "a draft" : "a group chat unlinked";
      throw new UndoConflictError(id, [{ personId: null, name: `${what} it puts back`, what: "who it was with has been joined into someone else or deleted since" }]);
    }
    if (broken.length > 0) {
      const added = changes.filter((c) => c.tbl === "person" && c.before === null).map((c) => this.conflictOf(c, c.after!));
      throw new UndoConflictError(id, added.length > 0 ? added : [{ personId: null, name: `a ${broken[0].table} row`, what: `it points at a ${broken[0].parent} the changeset added` }],
        "someone it added has been linked to since");
    }
  }

  /** Who or what a changed row is about, for an undo that is refused. */
  private conflictOf(change: Change, row: Row): UndoConflict {
    const person = (id: number) => ({ personId: id, name: this.personName(id) ?? `person ${id}` });
    switch (change.tbl) {
      case "person": {
        const now = this.now("person", change.key);
        const what = !now ? "deleted" : change.after === null ? "made again" :
          checked(change, TABLES.person).filter((c) => now[c] !== change.after![c]).map(columnTitle).join(", ") || "changed";
        return { personId: Number(row.id), name: this.personName(Number(row.id)) ?? String(row.name), what };
      }
      case "person_tag":
        return { ...person(Number(row.person_id)), what: "tags" };
      case "group_unlink":
        // What was done since the changeset left it so.
        return { ...person(Number(row.person_id)), what: `${change.after === null ? "unlinked from" : "linked through"} ${this.groupName(Number(row.conversation_id))}` };
      case "import_person":
        return { ...person(Number(row.person_id)), what: "accounts" };
      case "tag":
        return { personId: null, name: `the tag "${row.name}"`, what: "tags" };
      case "conversation":
        // What was done to it since the changeset left it so.
        return { personId: null, name: this.groupName(Number(row.id)), what: row.dropped_at === null ? "dropped" : "brought back" };
      case "catch_up":
        return { personId: null, name: `the ${HANGOUT.one} on ${catchUpWhen(String(row.day), tripOf(row)?.lastDay ?? null)}`, what: HANGOUT.many };
      case "catch_up_person":
        return { ...person(Number(row.person_id)), what: HANGOUT.many };
      case "manual_call": {
        const personId = this.loggedCallPerson(row);
        return personId === null ? { personId: null, name: `logged call #${row.id}`, what: "logged calls" } : { ...person(personId), what: "logged calls" };
      }
      case "call_length": {
        const [personId] = this.callPeople(Number(row.message_id));
        return personId === undefined ? { personId: null, name: `call ${row.message_id}`, what: "call length" } : { ...person(personId), what: "call length" };
      }
      case "call_note":
      case "call_answered": {
        const what = change.tbl === "call_note" ? "call note" : "call answered";
        const [personId] = this.notedCall(change).people;
        return personId === undefined ? { personId: null, name: `a call`, what } : { ...person(personId), what };
      }
      case "conversation_member": {
        const personId = this.accountPerson(Number(row.account_id));
        return {
          personId,
          name: (personId === null ? null : this.personName(personId)) ?? `account ${row.account_id}`,
          what: `${row.removed_at === null ? "taken out of" : "put back in"} ${this.groupName(Number(row.conversation_id))}`,
        };
      }
      default:
        return this.describedConflict(change, row) ?? { personId: null, name: change.tbl, what: "changed" };
    }
  }

  /** Who or what a changed row of a table it was given is about, in its describer's words; null without one. */
  private describedConflict(change: Change, row: Row): UndoConflict | null {
    const spec = this.specs[change.tbl];
    if (!this.describer || !spec) return null;
    const now = this.now(change.tbl, change.key);
    const changedSince = now && change.after ? checked(change, spec).filter((c) => now[c] !== change.after![c]) : [];
    return this.describer.conflictOf(change, row, { now, changedSince });
  }

  /**
   * A row of a table the archive no longer has (the location values kept before migration 32, met's among them), which
   * an undo cannot put back.
   */
  private goneConflict(change: Change): UndoConflict {
    const row = (change.before ?? change.after)!;
    const personId = typeof row.person_id === "number" ? row.person_id : null;
    const what = typeof row.field === "string" ? `${row.field}, kept as it no longer is` : "kept as it no longer is";
    return personId === null ? { personId: null, name: `a ${change.tbl} row`, what } : { personId, name: this.personName(personId) ?? `person ${personId}`, what };
  }

  /** A group chat as the change log names it: its number, and its title when it has one. */
  private groupName(id: number): string {
    const title = (this.db.prepare("SELECT title FROM conversation WHERE id = ?").get(id) as { title: string | null } | undefined)?.title;
    return `the group chat #${id}${title ? ` "${title}"` : ""}`;
  }

  private accountPerson(id: number): number | null {
    return (this.db.prepare("SELECT person_id FROM import_person WHERE id = ?").get(id) as { person_id: number | null } | undefined)?.person_id ?? null;
  }

  /** Who a logged call's row is with: its account's person (as the account is now), or its own. */
  private loggedCallPerson(row: Row): number | null {
    return typeof row.account_id === "number" ? this.accountPerson(row.account_id) : Number(row.person_id);
  }

  /** The people a changed row is about. */
  private peopleOf(change: Change): number[] {
    const rows = [change.before, change.after].filter((r): r is Row => r !== null);
    switch (change.tbl) {
      case "person":
        return [Number(rows[0].id)];
      case "person_tag":
      case "catch_up_person":
      case "group_unlink":
        return [Number(rows[0].person_id)];
      case "manual_call":
        return [...new Set(rows.map((r) => this.loggedCallPerson(r)).filter((id): id is number => id !== null))];
      case "import_person":
        return [...new Set(rows.map((r) => r.person_id).filter((id): id is number => typeof id === "number"))];
      default:
        return [];
    }
  }

  /**
   * For each call the changeset logged, changed or deleted, a line for whoever it was with before and after (on an
   * account, its person as it is now): what it was for them ("25 min on FaceTime, 4 Oct 2026, 7:30 pm", "+2 others"
   * after when it had people unnamed) and what it is, empty where it was not with them.
   */
  private manualCallLines(rows: Change[]): Map<number, FieldChange[]> {
    const lines = new Map<number, FieldChange[]>();
    const platformOf = (row: Row) => typeof row.account_id === "number"
      ? (this.db.prepare("SELECT platform FROM import_person WHERE id = ?").get(row.account_id) as { platform: string } | undefined)?.platform ?? ""
      : String(row.app);
    const describe = (row: Row) => {
      const others = othersLabel(Number(row.others ?? 0));
      return `${callDuration(Number(row.duration_seconds))} on ${callPlatformName(platformOf(row))}, ${catchUpWhen(dayKey(Number(row.at)))}, ${timeLabel(timeOfDay(Number(row.at)))}` +
        `${others ? `, ${others}` : ""}${row.note ? `: ${String(row.note)}` : ""}`;
    };
    for (const change of rows) {
      const before = change.before && this.loggedCallPerson(change.before);
      const after = change.after && this.loggedCallPerson(change.after);
      for (const personId of new Set([before, after].filter((id): id is number => id !== null))) {
        const was = before === personId ? describe(change.before!) : "";
        const is = after === personId ? describe(change.after!) : "";
        if (was !== is) lines.set(personId, [...(lines.get(personId) ?? []), { what: "logged call", before: was, after: is }]);
      }
    }
    return lines;
  }

  private personName(id: number): string | null {
    return (this.db.prepare("SELECT name FROM person WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? null;
  }

  // --- showing

  /**
   * Each person's before and after for what changed, and what else changed, from
   * the rows and the tables as they are now (just after the changeset). Tags and
   * values renamed by the changeset show on everyone who has them.
   */
  private summarize(changes: Change[]): Summary {
    const of = (tbl: string) => changes.filter((c) => c.tbl === tbl);
    const byKey = (tbl: string) => new Map(of(tbl).map((c) => [Number((JSON.parse(c.key) as number[])[0]), c]));
    const tagRows = byKey("tag");
    const tagNow = (id: number) => this.db.prepare("SELECT name, sort_order FROM tag WHERE id = ?").get(id) as { name: string; sort_order: number } | undefined;
    const tagThen = (id: number) => {
      const row = tagRows.get(id);
      return row ? (row.before ? { name: String(row.before.name), sort_order: Number(row.before.sort_order) } : undefined) : tagNow(id);
    };

    // Everyone touched, with the rows about them.
    const touched = new Set<number>();
    for (const change of changes) for (const id of this.peopleOf(change)) touched.add(id);
    const catchUpLines = this.catchUpLines(of("catch_up"), of("catch_up_person"));
    for (const id of catchUpLines.keys()) touched.add(id);
    const callLines = this.callLengthLines(of("call_length"));
    for (const id of callLines.keys()) touched.add(id);
    const loggedLines = this.manualCallLines(of("manual_call"));
    for (const id of loggedLines.keys()) touched.add(id);
    const noteLines = this.callNoteLines(of("call_note"));
    for (const id of noteLines.keys()) touched.add(id);
    const answeredLines = this.callAnsweredLines(of("call_answered"));
    for (const id of answeredLines.keys()) touched.add(id);
    const renamedTags = [...tagRows].filter(([, c]) => c.before && c.after && c.before.name !== c.after.name).map(([id]) => id);
    if (renamedTags.length > 0) {
      for (const row of this.db.prepare("SELECT person_id FROM person_tag WHERE tag_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(renamedTags)) as
        { person_id: number }[]) touched.add(row.person_id);
    }

    const people: PersonChange[] = [];
    for (const id of touched) {
      const personRow = of("person").find((c) => JSON.parse(c.key)[0] === id);
      const now = this.db.prepare("SELECT name FROM person WHERE id = ?").get(id) as Row | undefined;
      const lines: FieldChange[] = [];
      if (personRow && personRow.before === null) lines.push({ what: "person", before: "", after: "added" });
      if (personRow && personRow.after === null) lines.push({ what: "person", before: "", after: "deleted" });
      if (personRow?.before && personRow.after) {
        for (const [column, what] of PERSON_COLUMNS) {
          const before = renderColumn(column, personRow.before[column]);
          const after = renderColumn(column, personRow.after[column]);
          if (before !== after) lines.push({ what, before, after });
        }
      }

      // Tags: now, and then (now without what the changeset gave, with what it took), each named as it was then and is now.
      const tagsNow = now ? (this.db.prepare("SELECT tag_id FROM person_tag WHERE person_id = ?").all(id) as { tag_id: number }[]).map((r) => r.tag_id) : [];
      const tagChanges = of("person_tag").filter((c) => JSON.parse(c.key)[0] === id);
      const tagsThen = new Set(tagsNow);
      for (const c of tagChanges) {
        const tagId = Number(JSON.parse(c.key)[1]);
        if (c.before === null) tagsThen.delete(tagId);
        if (c.after === null) tagsThen.add(tagId);
      }
      const tagList = (ids: Iterable<number>, name: typeof tagNow) =>
        [...ids].map((tagId) => name(tagId) ?? { name: `tag ${tagId}`, sort_order: Infinity })
          .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)).map((t) => t.name).join(", ");
      const tagsBefore = tagList(tagsThen, tagThen);
      const tagsAfter = tagList(tagsNow, tagNow);
      if (tagsBefore !== tagsAfter) lines.push({ what: "tags", before: tagsBefore, after: tagsAfter });

      // Accounts: those it gave them, and those it took.
      const accountChanges = of("import_person").filter((c) => c.before!.person_id === id || c.after!.person_id === id);
      if (accountChanges.length > 0) {
        const accountsNow = (this.db.prepare("SELECT id FROM import_person WHERE person_id = ?").all(id) as { id: number }[]).map((r) => r.id);
        const accountsThen = new Set(accountsNow);
        for (const c of accountChanges) {
          const accountId = Number(c.before!.id);
          if (c.after!.person_id === id) accountsThen.delete(accountId);
          if (c.before!.person_id === id) accountsThen.add(accountId);
        }
        const before = this.accountList([...accountsThen]);
        const after = this.accountList(accountsNow);
        if (before !== after) lines.push({ what: "accounts", before, after });
      }

      // Group chats unlinked or linked again: one line each.
      for (const c of of("group_unlink").filter((c) => JSON.parse(c.key)[0] === id)) {
        const group = this.groupName(Number(JSON.parse(c.key)[1]));
        lines.push(c.after === null ? { what: "group chat", before: `unlinked from ${group}`, after: `linked through ${group}` }
          : { what: "group chat", before: `linked through ${group}`, after: `unlinked from ${group}` });
      }

      lines.push(...(catchUpLines.get(id) ?? []), ...(callLines.get(id) ?? []), ...(loggedLines.get(id) ?? []), ...(noteLines.get(id) ?? []), ...(answeredLines.get(id) ?? []));

      if (lines.length === 0) continue;
      const name = now ? String(now.name) : String(personRow?.before?.name ?? `person ${id}`);
      people.push({ id, name, changes: lines });
    }
    people.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

    const other: string[] = [];
    for (const [id, c] of tagRows) {
      if (c.before === null) other.push(`added the tag "${c.after!.name}"`);
      else if (c.after === null) other.push(`deleted the tag "${c.before.name}"`);
      else if (c.before.name !== c.after.name) other.push(`renamed the tag "${c.before.name}" to "${c.after.name}"`);
      void id;
    }
    if ([...tagRows.values()].some((c) => c.before && c.after && c.before.sort_order !== c.after.sort_order)) other.push("changed the tag order");
    for (const c of of("merge_proposal")) {
      const was = c.before?.status ?? null;
      const is = c.after?.status ?? null;
      const row = (c.after ?? c.before)!;
      const pair = `${this.keyName(String(row.left_key))} and ${this.keyName(String(row.right_key))}`;
      if (is === "rejected" && was !== "rejected") other.push(`said ${pair} are different people`);
      else if (was === "rejected" && is !== "rejected") other.push(`took back that ${pair} are different people`);
    }
    for (const c of of("conversation")) {
      other.push(`${c.after!.dropped_at === null ? "brought back" : "dropped"} ${this.groupName(Number(c.after!.id))}`);
    }
    // One line per person and group, though they were in it by two accounts.
    const members = new Set(of("conversation_member").map((c) => {
      const personId = this.accountPerson(Number(c.after!.account_id));
      const name = (personId === null ? null : this.personName(personId)) ?? `account ${c.after!.account_id}`;
      const group = this.groupName(Number(c.after!.conversation_id));
      return c.after!.removed_at === null ? `put ${name} back in ${group}` : `took ${name} out of ${group}`;
    }));
    other.push(...members);
    other.push(...(this.describer?.lines(changes) ?? []));
    return { people, other };
  }

  /**
   * For each catch-up the changeset changed, a line for everyone at it before or after: what it was for them, and
   * what it is ("2 hours, 4 Oct 2026"), empty where they were not at it.
   */
  private catchUpLines(rows: Change[], people: Change[]): Map<number, FieldChange[]> {
    const lines = new Map<number, FieldChange[]>();
    const keyOf = (c: Change) => (JSON.parse(c.key) as number[])[0];
    for (const id of new Set([...rows, ...people].map(keyOf))) {
      const row = rows.find((c) => keyOf(c) === id);
      const now = this.db.prepare("SELECT day, time, hours, note, others, trip_last_day, trip_end_time, trip_private_from, trip_private_to FROM catch_up WHERE id = ?").get(id) as Row | undefined;
      const then = row ? row.before : (now ?? null);
      const peopleNow = new Set((this.db.prepare("SELECT person_id FROM catch_up_person WHERE catch_up_id = ?").all(id) as { person_id: number }[]).map((r) => r.person_id));
      const peopleThen = new Set(peopleNow);
      for (const c of people.filter((c) => keyOf(c) === id)) {
        const personId = (JSON.parse(c.key) as number[])[1];
        if (c.before === null) peopleThen.delete(personId);
        if (c.after === null) peopleThen.add(personId);
      }
      for (const personId of new Set([...peopleThen, ...peopleNow])) {
        const before = then && peopleThen.has(personId) ? describeCatchUp(then) : "";
        const after = now && peopleNow.has(personId) ? describeCatchUp(now) : "";
        if (before !== after) lines.set(personId, [...(lines.get(personId) ?? []), { what: HANGOUT.one, before, after }]);
      }
    }
    return lines;
  }

  /** For each call the changeset gave a length or took it from, a line for the person it was with: "call on 3 Mar 2026", "" to "25 min". */
  private callLengthLines(rows: Change[]): Map<number, FieldChange[]> {
    const lines = new Map<number, FieldChange[]>();
    for (const change of rows) {
      const messageId = (JSON.parse(change.key) as number[])[0];
      const sentAt = (this.db.prepare("SELECT sent_at FROM message WHERE id = ?").get(messageId) as { sent_at: number } | undefined)?.sent_at;
      const length = (row: Row | null) => (row ? callDuration(Number(row.seconds)) : "");
      const line = { what: sentAt === undefined ? "call" : `call on ${catchUpWhen(dayKey(sentAt))}`, before: length(change.before), after: length(change.after) };
      for (const personId of this.callPeople(messageId)) lines.set(personId, [...(lines.get(personId) ?? []), line]);
    }
    return lines;
  }

  /** For each imported call the changeset gave a note, changed it or took it away, a line for everyone on it: "call note, 3 Mar 2026", "" to "Talked about the move". */
  private callNoteLines(rows: Change[]): Map<number, FieldChange[]> {
    const lines = new Map<number, FieldChange[]>();
    for (const change of rows) {
      const { at, people } = this.notedCall(change);
      const note = (row: Row | null) => (row ? String(row.note) : "");
      const line = { what: at === undefined ? "call note" : `call note, ${catchUpWhen(dayKey(at))}`, before: note(change.before), after: note(change.after) };
      for (const personId of people) lines.set(personId, [...(lines.get(personId) ?? []), line]);
    }
    return lines;
  }

  /**
   * For each imported call the changeset said was answered, missed or unknown, or set back, a line for everyone on it:
   * "call answered, 3 Mar 2026", "as its source says" to "missed".
   */
  private callAnsweredLines(rows: Change[]): Map<number, FieldChange[]> {
    const lines = new Map<number, FieldChange[]>();
    for (const change of rows) {
      const { at, people } = this.notedCall(change);
      const answer = (row: Row | null) => (row && row.answered !== "" ? String(row.answered) : "as its source says");
      const line = { what: at === undefined ? "call answered" : `call answered, ${catchUpWhen(dayKey(at))}`, before: answer(change.before), after: answer(change.after) };
      for (const personId of people) lines.set(personId, [...(lines.get(personId) ?? []), line]);
    }
    return lines;
  }

  /** The imported call a call_note or call_answered row is about: when it was, and who was on it (never the captain). */
  private notedCall(change: Change): { at: number | undefined; people: number[] } {
    const row = (change.before ?? change.after)!;
    if (row.message_id !== null) {
      const messageId = Number(row.message_id);
      const at = (this.db.prepare("SELECT sent_at FROM message WHERE id = ?").get(messageId) as { sent_at: number } | undefined)?.sent_at;
      return { at, people: this.callPeople(messageId) };
    }
    const rows = this.db
      .prepare(
        `SELECT c.at, ip.person_id FROM call c JOIN import_person ip ON ip.id = c.import_person_id JOIN person p ON p.id = ip.person_id AND p.is_self = 0
         WHERE c.platform = ? AND c.platform_call_id = ? ORDER BY c.id`,
      )
      .all(row.platform, row.platform_call_id) as { at: number; person_id: number }[];
    return { at: rows[0]?.at, people: [...new Set(rows.map((r) => r.person_id))] };
  }

  /** Who a call record in a one-to-one chat was with: the person on the other side (never the captain). */
  private callPeople(messageId: number): number[] {
    return (this.db
      .prepare(
        `SELECT DISTINCT ip.person_id FROM message m JOIN conversation_member cm ON cm.conversation_id = m.conversation_id
         JOIN import_person ip ON ip.id = cm.account_id JOIN person p ON p.id = ip.person_id AND p.is_self = 0
         WHERE m.id = ? AND ip.is_self = 0`,
      )
      .all(messageId) as { person_id: number }[]).map((row) => row.person_id);
  }

  /** Accounts as the summary lists them: platform "name", in id order. */
  private accountList(ids: number[]): string {
    if (ids.length === 0) return "";
    return (this.db
      .prepare("SELECT platform, display_name FROM import_person WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id")
      .all(JSON.stringify(ids)) as { platform: string; display_name: string }[])
      .map((a) => `${a.platform} "${a.display_name}"`)
      .join(", ");
  }

  /** A proposal's side by name: person:<id> or account:<platform>:<key>. */
  private keyName(key: string): string {
    if (key.startsWith("person:")) return this.personName(Number(key.slice("person:".length))) ?? key;
    const [, platform, ...rest] = key.split(":");
    const row = this.db.prepare("SELECT display_name FROM import_person WHERE platform = ? AND key = ?").get(platform, rest.join(":")) as
      { display_name: string } | undefined;
    return row ? `${platform} "${row.display_name}"` : key;
  }
}

/** The person table's columns a summary shows, and what it calls each. */
const PERSON_COLUMNS: Array<[string, string]> = [
  ["name", "name"],
  ["aliases_json", "aliases"],
  ["note", "note"],
  ["should_reach_out", "reach out"],
  ["identicon_seed", "identicon"],
  ["identicon_hue", "identicon colour"],
  ["location", "location"],
];

/** Some words of the captain's, quoted for a summary line, cut at 80 characters; (none) for none. */
export function quoted(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return "(none)";
  return `"${text.length > 80 ? `${text.slice(0, 79)}…` : text}"`;
}

function columnTitle(column: string): string {
  return PERSON_COLUMNS.find(([c]) => c === column)?.[1] ?? column.replace(/_json$/, "").replace(/_/g, " ");
}

function renderColumn(column: string, value: unknown): string {
  if (column === "aliases_json") return (JSON.parse(String(value ?? "[]")) as string[]).join(", ");
  if (column === "should_reach_out") return value === 1 ? "yes" : "no";
  return value === null || value === undefined ? "" : String(value);
}

/**
 * A catch-up row as a summary shows it: "2 hours, 4 Oct 2026: dinner at Ada's",
 * "2 hours, 4 Oct 2026, 7:30 pm" with a time, "+20 others" after the date when there were, and a trip from when it
 * began to when it ended with its private hours: "34 hours over 3 days, 4–6 Oct 2026, 6:00 pm to 2:00 pm, private
 * 12:00 am–10:00 am".
 */
function describeCatchUp(row: Row): string {
  const note = row.note ? `: ${String(row.note)}` : "";
  const others = othersLabel(Number(row.others ?? 0));
  const trip = tripOf(row);
  const time = typeof row.time === "string" ? `, ${timeLabel(row.time)}` : "";
  const ran = trip === null ? time : `${time} to ${timeLabel(trip.endTime)}, private ${timeLabel(trip.privateFrom)}–${timeLabel(trip.privateTo)}`;
  const days = trip === null ? 1 : catchUpDayCount({ day: String(row.day), trip });
  return `${catchUpTitle(Number(row.hours), days)}, ${catchUpWhen(String(row.day), trip?.lastDay ?? null)}${ran}${others ? `, ${others}` : ""}${note}`;
}

/** A catch-up row's trip when it was over several days; null for one on a single day, and in rows logged before there were any. */
function tripOf(row: Row): Trip | null {
  return typeof row.trip_last_day === "string"
    ? { lastDay: row.trip_last_day, endTime: String(row.trip_end_time), privateFrom: String(row.trip_private_from), privateTo: String(row.trip_private_to) }
    : null;
}

/** Whether a change is worth a changeset: not a lenient row, nor only a loose column (when someone was last edited, say). */
function meaningful(change: Change, specs: Readonly<Record<string, TableSpec>>): boolean {
  const spec = specs[change.tbl];
  return spec !== undefined && !spec.lenient && (change.before === null || change.after === null || checked(change, spec).length > 0);
}

/**
 * The columns a change set, which an undo checks and puts back: for a row it changed, those it changed (but loose
 * ones); for a row it added or deleted, all it was logged with (but loose ones). A row logged before a column was
 * added, or made by a migration with only some columns, says nothing of the rest.
 */
function checked(change: Change, spec: TableSpec): string[] {
  const logged = (change.before ?? change.after)!;
  const columns = spec.columns.filter((c) => !spec.loose.includes(c) && Object.hasOwn(logged, c));
  return change.before && change.after ? columns.filter((c) => change.before![c] !== change.after![c]) : columns;
}

/** Whether a row now is as `then` (both there, or both not), on these columns. */
function same(now: Row | null, then: Row | null, columns: readonly string[]): boolean {
  if (now === null || then === null) return now === then;
  return columns.every((c) => now[c] === then[c]);
}

function parse(json: string | null): Row | null {
  return json === null ? null : (JSON.parse(json) as Row);
}

/** A changeset as the API gives it, with at most `people` of the people it touched. */
function info(row: ChangesetRow, people: number): ChangesetInfo {
  const summary = JSON.parse(row.summary_json) as Partial<Summary>;
  const touched = summary.people ?? [];
  return {
    id: row.id,
    at: row.at,
    surface: row.surface,
    action: row.action,
    description: row.description,
    backup: row.backup,
    undoes: row.undoes,
    undoneBy: row.undone_by,
    people: touched.slice(0, people),
    peopleCount: touched.length,
    other: summary.other ?? [],
  };
}

/** The captain's words for a changeset: trimmed, single-spaced, at most DESCRIPTION_MAX; null for none. */
function cleanDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new InvalidInputError("a description is text");
  const clean = value.trim().replace(/\s+/g, " ");
  if (clean.length > DESCRIPTION_MAX) throw new InvalidInputError(`a description is at most ${DESCRIPTION_MAX} characters`);
  return clean || null;
}

/** "Ada Sample (tags), Bruno Placeholder (location, name), the tag "x" (tags)", at most a dozen, then how many more. */
export function describeConflicts(conflicts: UndoConflict[]): string {
  const merged = new Map<string, { name: string; what: Set<string> }>();
  for (const c of conflicts) {
    const at = c.personId === null ? c.name : `person:${c.personId}`;
    const entry = merged.get(at) ?? { name: c.personId === null ? c.name : `${c.name} [person ${c.personId}]`, what: new Set<string>() };
    for (const what of c.what.split(", ")) entry.what.add(what);
    merged.set(at, entry);
  }
  const entries = [...merged.values()].map((e) => `${e.name} (${[...e.what].join(", ")})`);
  return entries.length > 12 ? `${entries.slice(0, 12).join("; ")}; and ${entries.length - 12} more` : entries.join("; ");
}
