// Calls the captain logs himself (Add event's Call): one row each in
// manual_call for each person on it, on one of their accounts that carries
// calls, with when it started and how long it lasted. A call with several
// people (a group call) is one row for each, all at the same time and as
// long, sharing a call_group (the number of the first logged); one with one
// person is a group of one. The only code that writes that table; calls.ts
// reads it with the imported calls (PERSON_CALLS), so a logged call counts as
// one imported on that account does: under the account in their panel, in
// the chat, the Table's Phone calls (one on a phone or iMessage account), the
// Calendar and the closeness score, where each on a group call takes their
// share of its time (groupShare in src/catchUps.ts). A call may have people
// on it the captain does not name, as a hangout may (others, kept on every row
// of its group as its note is): they are counted among its people, so each
// named takes a smaller share, as on an app's call whose people it could not
// all name. A hangout is never by call: a call is one of these.
//
// As an imported call is, each is with whoever its account belongs to, so it
// goes with the account through a merge, a join or a detach. Only someone with
// no account that carries calls has calls on no account: with them, on the
// app the captain said; a merge or a join gives the one kept those (combine),
// and deleting a person deletes them. Should a merge leave someone twice on one
// group call, it reads as once (calls.ts), and the next change of it keeps one.
//
// Imports never write them, so a re-import neither deletes nor repeats one.
// The captain's edits (add, change, delete) go through People (people.ts),
// which marks everyone on it edited, each a changeset; a change or delete of
// any one of a group's calls is of the whole group. So is its note, kept on
// every row of the group as its time and length are: set with the rest, or
// alone (setNote, from Events' Calls table; calls.ts setCallNote).

import { CALL_LENGTH_MOST_MINUTES, CALL_PLATFORMS, type CallPersonInput, carriesCalls, dayKey, type Db, InvalidInputError, isDay, LOCALE, type LoggedCall, MANUAL_CALL_APPS, type ManualCallApp, type ManualCallInput, NotFoundError, OTHERS_MOST, wallClock } from "../../../sdk/server.ts";
import { normalizeCallNote } from "./calls.ts";

/** The earliest date a call may be logged on. */
const FIRST_DAY = "1900-01-01";

/** A logged call as the archive keeps it, with who it was with (`person`: its account's person, or its own). */
export interface ManualCallRow {
  id: number;
  /** Its call group: the calls logged as one, with several people, share it. */
  call_group: number;
  /** On no account, who it was with; else null. */
  person_id: number | null;
  /** The account it was on; null for one on no account. */
  account_id: number | null;
  at: number;
  duration_seconds: number;
  /** On no account, the app; else null. */
  app: ManualCallApp | null;
  /** The note, the whole group's; empty for none. */
  note: string;
  /** How many more were on it, unnamed: the whole group's; 0 for none. */
  others: number;
  /** Who it was with. */
  person: number;
}

/**
 * A logged call as checked (normalizeManualCall): ManualCallInput, and how many more were on it unnamed; null when not
 * said, so a new call has none and a change keeps what it had (the page's Add event does not say).
 */
export interface LoggedCallInput extends ManualCallInput {
  others: number | null;
}

/**
 * A logged call as given (by the page or the CLI), checked: everyone on it (`people`, each once: a person number, the
 * account it was on with them (a number) or none (null) with one of MANUAL_CALL_APPS, phone when not given), a real
 * date no later than `today`, the time it started (19:30 or 7:30, written 19:30), and how many whole minutes it lasted
 * (a number, or text such as "25", from 1 to a day), a note if he likes (normalizeCallNote; empty when not given), and
 * how many more were on it unnamed (a whole number from 0 to OTHERS_MOST, or text such as "2"; null when not given).
 * Whether the people and the accounts exist, and each account is its person's, is People's to check (checkAccount).
 */
export function normalizeManualCall(input: unknown, today = dayKey(Date.now())): LoggedCallInput {
  if (typeof input !== "object" || input === null) throw new InvalidInputError("a call is who was on it, the date, time and minutes");
  const { people, day, time, minutes, note, others } = input as Record<string, unknown>;
  if (!Array.isArray(people) || people.length === 0) throw new InvalidInputError("a call is with one or more people: give each one's number and account");
  const everyone = people.map(normalizeCallPerson);
  const twice = everyone.find((p, i) => everyone.findIndex((q) => q.personId === p.personId) !== i);
  if (twice) throw new InvalidInputError(`person ${twice.personId} is on a call once`);
  if (typeof day !== "string" || !isDay(day.trim())) throw new InvalidInputError("a call's date is a real date, written as 2026-10-04");
  const cleanDay = day.trim();
  if (cleanDay > today) throw new InvalidInputError(`a call is one that has happened: ${cleanDay} is after today (${today})`);
  if (cleanDay < FIRST_DAY) throw new InvalidInputError(`a call's date is from ${FIRST_DAY}`);
  const match = typeof time === "string" ? /^(\d{1,2}):(\d{2})$/.exec(time.trim()) : null;
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new InvalidInputError("a call's time is when it started, such as 19:30");
  const value = typeof minutes === "string" && /^\s*\d+\s*$/.test(minutes) ? Number(minutes) : minutes;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > CALL_LENGTH_MOST_MINUTES) {
    throw new InvalidInputError(`a call lasts a whole number of minutes, from 1 to ${CALL_LENGTH_MOST_MINUTES}`);
  }
  return {
    people: everyone, day: cleanDay, time: `${match[1].padStart(2, "0")}:${match[2]}`, minutes: value as number, note: normalizeCallNote(note), others: normalizeOthers(others),
  };
}

/** How many more were on a call, unnamed, as given: a whole number from 0 to OTHERS_MOST, or text such as "2"; null when not given. */
function normalizeOthers(others: unknown): number | null {
  if (others === undefined || others === null) return null;
  const value = typeof others === "string" && /^\s*\d+\s*$/.test(others) ? Number(others) : others;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > OTHERS_MOST) {
    throw new InvalidInputError(`a call's others are a whole number from 0 to ${OTHERS_MOST.toLocaleString(LOCALE)}`);
  }
  return value as number;
}

/** Someone on a logged call as given: their number, and the account it was on with them, or none with the app. */
function normalizeCallPerson(input: unknown): CallPersonInput {
  if (typeof input !== "object" || input === null) throw new InvalidInputError("someone on a call is their number and the account it was on");
  const { personId, accountId = null, app = "phone" } = input as Record<string, unknown>;
  if (!Number.isSafeInteger(personId)) throw new InvalidInputError("someone on a call is a person: give their number");
  if (accountId !== null && !Number.isSafeInteger(accountId)) throw new InvalidInputError("a call is on one of their accounts: give its number, or none");
  if (accountId === null && !MANUAL_CALL_APPS.includes(app as ManualCallApp)) throw new InvalidInputError(`a call on no account is on one of ${MANUAL_CALL_APPS.join(", ")}`);
  return { personId: personId as number, accountId: accountId as number | null, app: accountId === null ? (app as ManualCallApp) : null };
}

export class ManualCalls {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get(id: number): ManualCallRow {
    if (!Number.isSafeInteger(id)) throw new InvalidInputError("give a call number");
    const row = this.db.prepare(`${ROWS} WHERE mc.id = ?`).get(id) as ManualCallRow | undefined;
    if (!row) throw new NotFoundError(`no logged call #${id}`);
    return row;
  }

  /** The first logged call still in `group` (a call_group). */
  firstOf(group: number): number {
    const { id } = this.db.prepare("SELECT min(id) AS id FROM manual_call WHERE call_group = ?").get(group) as { id: number | null };
    if (id === null) throw new NotFoundError(`no logged call in group #${group}`);
    return id;
  }

  /** Every call in logged call `id`'s group (everyone on it), first logged first. */
  group(id: number): ManualCallRow[] {
    return this.db.prepare(`${ROWS} WHERE mc.call_group = ? ORDER BY mc.id`).all(this.get(id).call_group) as unknown as ManualCallRow[];
  }

  /**
   * Logged call `id`'s group as Add event's Call changes it: when, how long, and everyone on it (the captain never;
   * someone a merge left on it twice, once) with the account it was on with them.
   */
  loggedCall(id: number): LoggedCall {
    const rows = this.db
      .prepare(
        `SELECT mc.id, mc.account_id, mc.at, mc.duration_seconds, coalesce(a.platform, mc.app) AS platform, p.id AS person_id, p.name, p.aliases_json
         FROM manual_call mc LEFT JOIN import_person a ON a.id = mc.account_id JOIN person p ON p.id = coalesce(a.person_id, mc.person_id) AND p.is_self = 0
         WHERE mc.call_group = ? ORDER BY mc.id`,
      )
      .all(this.get(id).call_group) as { id: number; account_id: number | null; at: number; duration_seconds: number; platform: string; person_id: number; name: string; aliases_json: string }[];
    const people: LoggedCall["people"] = [];
    for (const row of rows) {
      if (people.some((p) => p.person.id === row.person_id)) continue;
      people.push({ callId: row.id, person: { id: row.person_id, name: row.name, aliases: JSON.parse(row.aliases_json) as string[] }, accountId: row.account_id, platform: row.platform });
    }
    const first = this.get(id);
    return { at: first.at, durationSeconds: first.duration_seconds, note: first.note, people };
  }

  /** `personId`'s accounts that carry calls (CALL_PLATFORMS), oldest first. */
  callAccounts(personId: number): { id: number; platform: string }[] {
    return (this.db.prepare("SELECT id, platform FROM import_person WHERE person_id = ? AND is_self = 0 ORDER BY id").all(personId) as { id: number; platform: string }[])
      .filter((account) => carriesCalls(account.platform));
  }

  /**
   * Refuses a call on an account that is not one of its person's that carries calls, and a call on no account with
   * someone who has one (`fresh`: someone put on a call; one on it before they had any may stay so when it changes).
   */
  checkAccount(person: CallPersonInput, { fresh }: { fresh: boolean }): void {
    const accounts = this.callAccounts(person.personId);
    if (person.accountId === null) {
      if (fresh && accounts.length > 0) throw new InvalidInputError(`a call with person ${person.personId} is on one of their accounts: ${accounts.map((a) => `#${a.id} (${a.platform})`).join(", ")}`);
      return;
    }
    if (!accounts.some((account) => account.id === person.accountId)) {
      throw new InvalidInputError(`account #${person.accountId} is not one of person ${person.personId}'s that carry calls (on ${CALL_PLATFORMS.join(", ")})`);
    }
  }

  // --- the captain's edits (People calls these inside its own transactions)

  /** Logs a call, checked (normalizeManualCall, checkAccount): one for each person on it, as one group, with no others unless said. Returns the first's number. */
  insert(call: ManualCallInput & Partial<Pick<LoggedCallInput, "others">>): number {
    // The group is the first's number, given it here so the two are one from the start.
    const first = (this.db.prepare("SELECT coalesce(max(id), 0) + 1 AS id FROM manual_call").get() as { id: number }).id;
    const kept = { ...call, others: call.others ?? 0 };
    for (const person of call.people) this.insertOne(first, person, kept);
    return first;
  }

  /**
   * Makes logged call `id`'s group this one, checked (normalizeManualCall, checkAccount): everyone still on it keeps
   * their call, changed as it says; a call left by someone taken off goes to someone put on, and the rest are deleted
   * or added. Its others stay as they were unless said. Whether anything changed.
   */
  update(id: number, given: ManualCallInput & Partial<Pick<LoggedCallInput, "others">>): boolean {
    const before = this.group(id);
    const group = before[0].call_group;
    const call = { ...given, others: given.others ?? before[0].others };
    const kept = new Map<number, ManualCallRow>();
    for (const row of before) if (!kept.has(row.person)) kept.set(row.person, row);
    const staying = new Set(call.people.map((p) => p.personId));
    const spare = before.filter((row) => kept.get(row.person) !== row || !staying.has(row.person));
    let changed = false;
    for (const person of call.people) {
      const row = kept.get(person.personId) ?? spare.shift();
      if (row === undefined) {
        this.insertOne(group, person, call);
        changed = true;
        continue;
      }
      const after = stored(person, call);
      if ((Object.keys(after) as Array<keyof typeof after>).every((key) => row[key] === after[key])) continue;
      this.db
        .prepare("UPDATE manual_call SET person_id = ?, account_id = ?, at = ?, duration_seconds = ?, app = ?, note = ?, others = ? WHERE id = ?")
        .run(after.person_id, after.account_id, after.at, after.duration_seconds, after.app, after.note, after.others, row.id);
      changed = true;
    }
    for (const row of spare) {
      this.db.prepare("DELETE FROM manual_call WHERE id = ?").run(row.id);
      changed = true;
    }
    return changed;
  }

  /** Gives logged call `id`'s whole group the note (normalizeCallNote; empty for none). How many rows changed. */
  setNote(id: number, note: string): number {
    return Number(this.db.prepare("UPDATE manual_call SET note = ? WHERE call_group = ? AND note != ?").run(note, this.get(id).call_group, note).changes);
  }

  /** Deletes logged call `id`'s whole group. */
  remove(id: number): void {
    this.db.prepare("DELETE FROM manual_call WHERE call_group = ?").run(this.get(id).call_group);
  }

  /**
   * Gives `intoId` every call logged with `fromId` on no account (a merge or join, before `fromId` is deleted); those
   * on an account go with it already.
   */
  combine(intoId: number, fromId: number): void {
    this.db.prepare("UPDATE manual_call SET person_id = ? WHERE person_id = ?").run(intoId, fromId);
  }

  private insertOne(group: number, person: CallPersonInput, call: Resolved): void {
    const kept = stored(person, call);
    this.db
      .prepare("INSERT INTO manual_call (call_group, person_id, account_id, at, duration_seconds, app, note, others, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(group, kept.person_id, kept.account_id, kept.at, kept.duration_seconds, kept.app, kept.note, kept.others, Date.now());
  }
}

/** A logged call's row, with who it was with (`person`: its account's person, or its own). */
const ROWS = `SELECT mc.id, mc.call_group, mc.person_id, mc.account_id, mc.at, mc.duration_seconds, mc.app, mc.note, mc.others, coalesce(a.person_id, mc.person_id) AS person
  FROM manual_call mc LEFT JOIN import_person a ON a.id = mc.account_id`;

/** A logged call with its others known: as given, or as it had them. */
type Resolved = ManualCallInput & { others: number };

/** Someone's call as manual_call keeps it: on an account, no person or app of its own. */
function stored(person: CallPersonInput, call: Resolved): Pick<ManualCallRow, "person_id" | "account_id" | "at" | "duration_seconds" | "app" | "note" | "others"> {
  const onAccount = person.accountId !== null;
  return {
    person_id: onAccount ? null : person.personId,
    account_id: person.accountId,
    at: wallClock(call.day, call.time),
    duration_seconds: call.minutes * 60,
    app: onAccount ? null : person.app,
    note: call.note,
    others: call.others,
  };
}
