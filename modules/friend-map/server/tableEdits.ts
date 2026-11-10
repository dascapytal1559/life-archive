// Friend map's editors for its Calls and Hangouts tables (sdk/server.ts's `edits`; the core's server/edits/): what the
// captain changes of a row in its cell or its drawer, opened from the Calendar or the table alike, written through friend map's
// own edits, each one changeset of its change log (changes.ts), so its undo is the change log's (exact, and refused
// when what it set has changed since) and the calendar is pushed after either by the change log itself
// (calendarPush.ts's afterEdit). Whether an edit stands undone is the change log's too, so one undone from Friend
// Map's Changes is undone in the tables' record (undoneInLog).
//
//   a hangout     his own record (catch_up): when (a date, and the time it started if he says), its hours (a trip's
//                 are its times', so they are kept), who was at it, and his note (content: read only through the trail)
//   a logged call his own record too (manual_call): when, how long, who was on it (each on an account of theirs that
//                 carries calls, the one they had or their usual: src/calls.ts's defaultCallAccount), and his note
//   an imported call  its source's: when and who stay as it says (who is whom is People's: a merge or a link); his
//                 note on it (call_note), whether it was answered (call_answered: Yes, No or Not known, over what its
//                 source says), and for a call record whose app gives none, its length (call_length), kept beside the
//                 import as his own, which a re-import never touches; a logged call was answered, and keeps that
//
// A hangout and a logged call are his own records, so he adds and deletes them in the table too (`own` on each tab:
// Add hangout, Add call, and Delete in a row's drawer), each one changeset as an edit is ("catch-up add", "call
// delete", as Friend Map's own routes name them), so it is undone alike, here or from Friend Map's Changes. An imported
// call is never deleted (`kept`). A call he adds is on each person's usual account unless he says an app (USUAL).

import {
  callPlatformName, defaultCallAccount, Effect, instantOf, InvalidInputError, MANUAL_CALL_APPS, NotFoundError, undoneInLog, wallParts, wallText,
  type Applied, type CallLengthSaved, type CallRef, type EditMeta, type EditRow, type EditValue, type FieldState, type ManualCallApp, type RowValues, type TableEditor,
} from "../../../sdk/server.ts";
import { CALL, CALLS_SOURCE, FRIEND_MAP_ORIGIN, HANGOUT_KIND } from "./calendarRows.ts";
import { callLengthOf, callsOf, setCallAnswered, setCallLength, setCallNote } from "./calls.ts";
import type { FriendMap } from "./friendMap.ts";
import { CALLS, USUAL } from "./tabs/callsTab.ts";
import { HANGOUTS } from "./tabs/hangoutsTab.ts";

/** Why an imported call's time and people stay as they are, and why it is never deleted. */
const IMPORTED_WHEN = "an imported call's time is as its source says";
const IMPORTED_WITH = "who was on an imported call is whose account it was on: change that in People (a merge or a link)";
const IMPORTED_KEPT = "an imported call is its source's, so it is never deleted (its length, answer and note can be corrected)";
const LOGGED_ANSWERED = "a call you logged was answered, so it keeps that";

/** A call row's key in the calendar (calendarRows.ts's CALLS_SOURCE), as a call: logged by its group, a call record by its message, a call in no chat by its first row. */
function callOf(nativeId: string): CallRef {
  const match = /^(logged|record|call):(-?\d+)$/.exec(nativeId);
  if (!match) throw new NotFoundError(`no call ${JSON.stringify(nativeId)}`);
  return { kind: match[1] as CallRef["kind"], id: Math.abs(Number(match[2])) };
}

/** The editors of friend map's Calls and Hangouts tables, over `friendMap`. */
export function friendMapEditors(friendMap: FriendMap): TableEditor[] {
  const { db, people, changes } = friendMap;
  const { catchUps, manualCalls } = people;

  /** Runs `work` as one changeset of the change log, from where `meta` says; its number, or null when it changed nothing. */
  const recorded = (meta: EditMeta, action: string, work: () => unknown): number | null =>
    changes.record({ surface: meta.surface, action, description: meta.why ?? undefined }, work).changeset;

  /** Puts changeset `receipt.changeset` back, from where `meta` says; the undo's own changeset. */
  const undone = (receipt: Readonly<Record<string, unknown>>, meta: EditMeta): number | null => {
    if (typeof receipt.changeset !== "number") throw new InvalidInputError("that edit changed nothing, so there is nothing to put back");
    return changes.undo(receipt.changeset, { surface: meta.surface, description: meta.why ?? undefined }).changeset;
  };

  // --- calls

  /** A call's row as the calendar's are made (calendarRows.ts's CALLS_SOURCE): its people, its platform (the row's origin), and whether it was answered (1, 0, or null for not known). */
  const callOfRow = (nativeId: string) =>
    db.prepare(`SELECT person_ids, platform, answered FROM (${CALLS_SOURCE}) WHERE id = ?`).get(nativeId) as { person_ids: string; platform: string; answered: number | null } | undefined;

  const noteOfCall = (call: CallRef): string => {
    if (call.kind === "logged") return manualCalls.loggedCall(manualCalls.firstOf(call.id)).note;
    const row = call.kind === "record"
      ? db.prepare("SELECT note FROM call_note WHERE message_id = ?").get(call.id)
      : db.prepare("SELECT n.note FROM call_note n JOIN call c ON c.platform = n.platform AND c.platform_call_id = n.platform_call_id WHERE c.id = ?").get(call.id);
    return (row as { note: string } | undefined)?.note ?? "";
  };

  /**
   * What an imported call keeps as its source says, and why (a logged call keeps nothing), with a call record's length
   * as it stands: read from the call's key and its one message, never the whole of the calls, so a page of the grid's
   * rows is cheap (locked) and the drawer's state says the same.
   */
  const callKept = (call: CallRef): { locked: Record<string, string>; length: CallLengthSaved["call"] | null } => {
    if (call.kind === "logged") return { locked: { answered: LOGGED_ANSWERED }, length: null };
    const length = call.kind === "record" ? callLengthOf(db, call.id) : null;
    const appSays = call.kind === "call" || (length !== null && length.callSeconds !== null && !length.callLengthGiven);
    const locked: Record<string, string> = { when: IMPORTED_WHEN, with: IMPORTED_WITH };
    if (appSays) locked.length = call.kind === "call" ? "its source says how long it was" : "its app says how long it was, so it keeps that";
    return { locked, length };
  };

  const callState = (row: EditRow): Record<string, FieldState> | null => {
    if (row.kind !== CALL) return null;
    const call = callOf(row.nativeId);
    if (call.kind === "logged") {
      // A logged call deleted (or its add undone) is no longer a row.
      const first = gone(() => manualCalls.firstOf(call.id));
      if (first === null) return null;
      const logged = manualCalls.loggedCall(first);
      const note = { value: null, has: logged.note !== "" };
      return {
        when: { value: wallText(logged.at) },
        length: { value: Math.round(logged.durationSeconds / 60) },
        with: { value: logged.people.map((p) => p.person.id) },
        answered: { value: "answered", locked: LOGGED_ANSWERED },
        note,
      };
    }
    const kept = callOfRow(row.nativeId);
    const ids = JSON.parse(kept?.person_ids ?? "[]") as number[];
    const { locked, length } = callKept(call);
    const note = { value: null, has: noteOfCall(call) !== "" };
    return {
      when: { value: null, locked: locked.when },
      length: locked.length ? { value: null, locked: locked.length } : { value: length?.callSeconds == null ? null : Math.round(length.callSeconds / 60) },
      with: { value: ids, locked: locked.with },
      answered: { value: kept?.answered === 1 ? "answered" : kept?.answered === 0 ? "missed" : "unknown" },
      note,
    };
  };

  /** Each call row's kept fields (callKept), from its key alone: a page of the grid's in one go. */
  const callsLocked = (rows: readonly EditRow[]) => rows.map((row) => (row.kind === CALL && /^(logged|record|call):-?\d+$/.test(row.nativeId) ? callKept(callOf(row.nativeId)).locked : null));

  /** Logged call `group` as Add event's Call changes it, with `change` made: its people each on the account they had, or a new one's usual. */
  const changeLogged = (group: number, change: { at?: number; minutes?: number; people?: number[]; note?: string }) => {
    const first = manualCalls.firstOf(group);
    const logged = manualCalls.loggedCall(first);
    const at = change.at ?? logged.at;
    const { day, time } = wallParts(wallText(at));
    const platform = logged.people[0]?.platform ?? "phone";
    const personOf = (personId: number) => {
      const had = logged.people.find((p) => p.person.id === personId);
      if (had) return { personId, accountId: had.accountId, app: had.accountId === null ? had.platform : null };
      const accounts = manualCalls.callAccounts(personId);
      const account = accounts.find((a) => a.platform === platform) ?? defaultCallAccount(accounts, callsOf(db, personId));
      const app: ManualCallApp = (MANUAL_CALL_APPS as readonly string[]).includes(platform) ? (platform as ManualCallApp) : "other";
      return { personId, accountId: account?.id ?? null, app: account ? null : app };
    };
    people.changeCall(first, {
      people: (change.people ?? logged.people.map((p) => p.person.id)).map(personOf),
      day, time, minutes: change.minutes ?? Math.round(logged.durationSeconds / 60), note: change.note ?? logged.note,
    });
  };

  const callWrite = (row: EditRow, field: string, value: EditValue): void => {
    const call = callOf(row.nativeId);
    if (field === "note") return void setCallNote(db, manualCalls, call, value ?? "");
    if (field === "answered") {
      if (call.kind === "logged") throw new InvalidInputError(LOGGED_ANSWERED);
      return void setCallAnswered(db, call, value);
    }
    if (call.kind !== "logged") {
      if (field !== "length" || call.kind !== "record") throw new InvalidInputError(field === "when" ? IMPORTED_WHEN : field === "with" ? IMPORTED_WITH : "its source says how long it was");
      return void setCallLength(db, call.id, value);
    }
    if (field === "when") return changeLogged(call.id, { at: instantOfWall(String(value)) });
    if (field === "length") {
      if (value === null) throw new InvalidInputError("a call you logged has a length: give its minutes");
      return changeLogged(call.id, { minutes: Number(value) });
    }
    if (field === "with") return changeLogged(call.id, { people: value as number[] });
    throw new InvalidInputError(`a call's ${JSON.stringify(field)} cannot be edited`);
  };

  /** A call row's key now: a logged call's origin is its platform, which its people can change. */
  const callKey = (row: EditRow): Pick<EditRow, "origin" | "nativeId"> => ({ origin: callOfRow(row.nativeId)?.platform ?? row.origin, nativeId: row.nativeId });

  // --- hangouts

  const hangoutState = (row: EditRow): Record<string, FieldState> | null => {
    if (row.kind !== HANGOUT_KIND) return null;
    const catchUp = gone(() => catchUps.get(Number(row.nativeId)));
    if (catchUp === null) return null;
    return {
      when: { value: catchUp.time === null ? catchUp.day : `${catchUp.day}T${catchUp.time}` },
      hours: catchUp.trip === null ? { value: catchUp.hours } : { value: catchUp.hours, locked: "a trip's hours are its time together, from when it began and ended" },
      with: { value: catchUp.people.map((p) => p.id) },
      note: { value: null, has: catchUp.note !== "" },
    };
  };

  const hangoutWrite = (row: EditRow, field: string, value: EditValue): void => {
    const id = Number(row.nativeId);
    const { people: at, ...catchUp } = catchUps.get(id);
    const input = { ...catchUp, personIds: at.map((p) => p.id) };
    if (field === "when") {
      const { day, time } = wallParts(String(value));
      Object.assign(input, { day, time });
    } else if (field === "hours") input.hours = Number(value);
    else if (field === "with") input.personIds = value as number[];
    else if (field === "note") input.note = value === null ? "" : String(value);
    else throw new InvalidInputError(`a hangout's ${JSON.stringify(field)} cannot be edited`);
    people.changeCatchUp(id, input);
  };

  // --- the captain's own rows, added and deleted in the table: a hangout, and a call he logged (never an imported one)

  /** Someone on a call he adds, on `on`: their usual account (their usual), or their account on that app, or on no account the app itself for someone with none that carries calls. */
  const callPersonOn = (personId: number, on: string) => {
    const accounts = manualCalls.callAccounts(personId);
    if (on === USUAL) {
      const usual = defaultCallAccount(accounts, callsOf(db, personId));
      return usual ? { personId, accountId: usual.id } : { personId, accountId: null, app: "phone" };
    }
    if (accounts.length === 0) return { personId, accountId: null, app: on };
    const platform = on === "facetime" ? "imessage" : on;
    const there = defaultCallAccount(accounts.filter((account) => account.platform === platform), callsOf(db, personId));
    if (there) return { personId, accountId: there.id };
    const name = (db.prepare("SELECT name FROM person WHERE id = ?").get(personId) as { name: string } | undefined)?.name ?? `person ${personId}`;
    const theirs = [...new Set(accounts.map((account) => callPlatformName(account.platform)))].join(", ");
    throw new InvalidInputError(`${name} has no ${callPlatformName(on)} account to call on (theirs: ${theirs}): pick one of those, or their usual`);
  };

  const callAdd = (values: RowValues): Pick<EditRow, "origin" | "nativeId" | "kind"> => {
    const { day, time } = wallParts(String(values.when));
    const on = String(values.app ?? USUAL);
    const group = people.addCall({ people: (values.with as number[]).map((personId) => callPersonOn(personId, on)), day, time, minutes: values.length, note: values.note ?? "" });
    const nativeId = `logged:${group}`;
    return { origin: callOfRow(nativeId)?.platform ?? "phone", nativeId, kind: CALL };
  };

  const hangoutAdd = (values: RowValues): Pick<EditRow, "origin" | "nativeId" | "kind"> => {
    const { day, time } = wallParts(String(values.when));
    const id = people.addCatchUp({ day, time, hours: values.hours, note: values.note ?? "", personIds: values.with });
    return { origin: FRIEND_MAP_ORIGIN, nativeId: String(id), kind: HANGOUT_KIND };
  };

  /** Why a call row is never deleted: an imported one is its source's. */
  const callKeptRow = (row: EditRow): string | null => (callOf(row.nativeId).kind === "logged" ? null : IMPORTED_KEPT);

  const callRemove = (row: EditRow): void => {
    const call = callOf(row.nativeId);
    if (call.kind !== "logged") throw new InvalidInputError(IMPORTED_KEPT);
    people.deleteCall(manualCalls.firstOf(call.id));
  };

  /** What a table of his own rows adds with, deletes with and keeps (each one changeset, its undo the change log's). */
  interface OwnWrites {
    noun: string;
    add: (values: RowValues) => Pick<EditRow, "origin" | "nativeId" | "kind">;
    remove: (row: EditRow) => void;
    kept?: (row: EditRow) => string | null;
  }

  const ownRows = ({ noun, add, remove, kept }: OwnWrites): Pick<TableEditor, "add" | "remove" | "kept" | "undoRow"> => ({
    add: (values, meta) =>
      Effect.sync(() => {
        const { value: row, changeset } = changes.record({ surface: meta.surface, action: `${noun} add`, description: meta.why ?? undefined }, () => add(values));
        return { row, receipt: { changeset } };
      }),
    remove: (row, meta) => Effect.sync(() => ({ receipt: { changeset: recorded(meta, `${noun} delete`, () => remove(row)) } })),
    ...(kept ? { kept } : {}),
    undoRow: (_row, receipt, meta) => Effect.sync(() => ({ receipt: { changeset: undone(receipt, meta) } })),
  });

  /** An editor over `state` and `write`, each edit one changeset, its undo the change log's, and whether one stands the change log's too (it can be undone from Friend Map's Changes). */
  const editor = (table: string, state: (row: EditRow) => Record<string, FieldState> | null, write: (row: EditRow, field: string, value: EditValue) => void,
    { key = (row) => row, locked, own }: { key?: (row: EditRow) => Pick<EditRow, "origin" | "nativeId">; locked?: TableEditor["locked"]; own: OwnWrites }): TableEditor => {
    const valueOf = (row: EditRow, field: string): EditValue => state(row)?.[field]?.value ?? null;
    return {
      table,
      state,
      ...(locked ? { locked } : {}),
      ...ownRows(own),
      undone: undoneInLog(changes, "Friend Map's Changes"),
      apply: (row, field, value, meta) =>
        Effect.sync((): Applied => {
          const before = valueOf(row, field);
          const changeset = recorded(meta, `${table} ${field}`, () => write(row, field, value));
          const now = { ...row, ...key(row) };
          return { before, after: field === "note" ? null : valueOf(now, field), receipt: { changeset }, row: now, changed: changeset !== null };
        }),
      undo: (row, field, receipt, meta) =>
        Effect.sync((): Applied => {
          const before = valueOf(row, field);
          const changeset = undone(receipt, meta);
          const now = { ...row, ...key(row) };
          return { before, after: field === "note" ? null : valueOf(now, field), receipt: { changeset }, row: now };
        }),
      note: (row) => (row.kind === CALL ? noteOfCall(callOf(row.nativeId)) : row.kind === HANGOUT_KIND ? catchUps.get(Number(row.nativeId)).note : null) || null,
      options: (_field, query) => peopleNamed(friendMap, query),
    };
  };

  return [
    editor(CALLS.spec.kind, callState, callWrite, { key: callKey, locked: callsLocked, own: { noun: "call", add: callAdd, remove: callRemove, kept: callKeptRow } }),
    editor(HANGOUTS.spec.kind, hangoutState, hangoutWrite, { own: { noun: "catch-up", add: hangoutAdd, remove: (row) => people.deleteCatchUp(Number(row.nativeId)) } }),
  ];
}

/** `read`'s answer, or null when what it reads is gone (NotFoundError): a row deleted, or its add undone. */
function gone<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/** The instant of an edit's time, in the archive's zone. */
function instantOfWall(text: string): number {
  if (wallParts(text).time === null) throw new InvalidInputError("a call's time is a date and a time of day");
  return instantOf(text);
}

/** The people whose name or an alias holds `query`, the closest first (never the captain): what a people field can take. */
function peopleNamed({ db }: FriendMap, query: string): Array<{ value: number; label: string }> {
  const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return (db
    .prepare(`SELECT id, name FROM person WHERE is_self = 0 AND trim(coalesce(name, '')) <> '' AND (name LIKE ? ESCAPE '\\' OR aliases_json LIKE ? ESCAPE '\\')
      ORDER BY (name LIKE ? ESCAPE '\\') DESC, name COLLATE NOCASE LIMIT 20`)
    .all(like, like, `${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`) as Array<{ id: number; name: string }>).map((row) => ({ value: row.id, label: row.name }));
}
