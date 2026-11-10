// Catch-ups (src/catchUps.ts): time the captain spent with people, one row
// each in catch_up, and who was at each (catch_up_person). The only code that
// reads or writes those tables.
//
// A catch-up is time in person, on a local date no later than today, may say when it
// started (19:30 there; it places the catch-up in the chat, and the closeness
// score never reads it), lasted some hours, has a short note, and has one person at it or more, never the captain,
// and any number of others he does not name (others: a crowd, who take a share of its worth and are no one).
// A call is never one: the captain logs a call as a call (manualCalls.ts), and there is no catch-up by call.
// One may be a trip over several days (trip: a trip away together, in person): from its day at its time to its last
// day at its end time, less each day's private window, its hours then its time together in all (tripHours), which the
// archive works out. It is one row, added, changed, deleted and undone whole, and is on every date from its first to its last.
// Imports never write them, so a re-import leaves them as they are.
//
// The captain's edits (add, change, delete) go through People (people.ts),
// which checks who was at it and marks them edited. A merge or a join gives
// the one kept the other's catch-ups (combine), and deleting a person takes
// them out of theirs, a catch-up left with nobody going too (dropEmpty).

import { type CatchUp, catchUpDayCount, type CatchUpInput, dayKey, DAYS_MOST, type Db, HANGOUT, HOURS_MOST, InvalidInputError, LOCALE, NotFoundError, OTHERS_MOST, PRIVATE_FROM, PRIVATE_TO, type ScoredCatchUp, type Trip, tripHours } from "../../../sdk/server.ts";

/** The longest note kept on a catch-up. */
const NOTE_MAX = 1000;

/** The earliest date a catch-up may be on. */
const FIRST_DAY = "1900-01-01";

interface CatchUpRow {
  id: number;
  day: string;
  time: string | null;
  trip_last_day: string | null;
  trip_end_time: string | null;
  trip_private_from: string | null;
  trip_private_to: string | null;
  hours: number;
  note: string;
  others: number;
}

/**
 * A catch-up as given (by the page or the CLI), checked and written the way the archive keeps it: a real date no later
 * than `today` (YYYY-MM-DD), when it started on it (a time of day, 19:30 or 7:30, written 19:30; null when not given or
 * empty), hours (a number, or text such as "1.5", above 0 and at most HOURS_MOST, kept to two
 * decimal places), a note trimmed (empty for none), one person or more, each once, and how many unnamed others (a whole
 * number from 0 to OTHERS_MOST, or text such as "20"; 0 when not given). Whether the people exist is People's to check.
 * It is in person: byCall, from when a catch-up could be by call (gone from friend-map's contract in 1.2.0), is passed
 * over when false, and true is refused, as a call is logged as a call.
 *
 * Or a trip over several days (`trip`, null when not given): its last day (after its day, no later than `today`, at
 * most DAYS_MOST days in all, both counted), the time it ended then, and each day's private window (privateFrom to
 * privateTo, times of day, PRIVATE_FROM to PRIVATE_TO when not given). A trip needs its time (when it began), and its
 * hours are its time together in all (tripHours), whatever hours are given: more than 0, with no HOURS_MOST.
 */
export function normalizeCatchUp(input: unknown, today = dayKey(Date.now())): CatchUpInput {
  if (typeof input !== "object" || input === null) throw new InvalidInputError(`a ${HANGOUT.one} is its date, hours, note and people`);
  const { day, time, trip, hours, byCall, note, personIds, others } = input as Record<string, unknown>;
  if (byCall === true) throw new InvalidInputError(BY_CALL_REFUSED);
  const first = normalizeDay(day, today);
  const start = normalizeTime(time);
  const clean = normalizeTrip(trip, first, start, today);
  return {
    day: first, time: start, trip: clean, hours: clean === null ? normalizeHours(hours) : tripTotal(first, start, clean), note: normalizeNote(note),
    personIds: normalizePeople(personIds), others: normalizeOthers(others),
  };
}

/** Why a catch-up by call is refused, and what to do instead. */
export const BY_CALL_REFUSED = `a ${HANGOUT.one} is time in person: log a call as a call (Add event's Call, POST /api/archive/calls, or npm run archive -- call add)`;

export class CatchUps {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Every catch-up (or only those `personId` was at, or on any of the days `from` to `to`, YYYY-MM-DD, both included:
   * a trip is on each of its days, so it is among them when any of its days is), the
   * latest first (on one date, the latest time first and those without one, at the start of the day, last), each with
   * everyone at it.
   */
  list({ personId, from, to }: { personId?: number; from?: string; to?: string } = {}): CatchUp[] {
    const where = [
      ...(personId === undefined ? [] : ["c.id IN (SELECT catch_up_id FROM catch_up_person WHERE person_id = :person)"]),
      ...(from === undefined ? [] : ["coalesce(c.trip_last_day, c.day) >= :from"]),
      ...(to === undefined ? [] : ["c.day <= :to"]),
    ];
    const rows = this.db
      .prepare(`SELECT ${COLUMNS.map((column) => `c.${column}`).join(", ")} FROM catch_up c ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.day DESC, c.time IS NULL, c.time DESC, c.id DESC`)
      .all({ ...(personId === undefined ? {} : { person: personId }), ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }) as unknown as CatchUpRow[];
    const people = this.peopleOf(rows.map((row) => row.id));
    return rows.map((row) => ({ ...fromRow(row), people: people.get(row.id) ?? [] }));
  }

  /** One catch-up, with everyone at it. */
  get(id: number): CatchUp {
    if (!Number.isSafeInteger(id)) throw new InvalidInputError(`give a ${HANGOUT.one} number`);
    const row = this.db.prepare(`SELECT ${COLUMNS.join(", ")} FROM catch_up WHERE id = ?`).get(id) as CatchUpRow | undefined;
    if (!row) throw new NotFoundError(`no ${HANGOUT.one} #${id}`);
    return { ...fromRow(row), people: this.peopleOf([id]).get(id) ?? [] };
  }

  /** Every catch-up for the map's report (the closeness score), oldest first, with everyone at it by id. */
  scored(): ScoredCatchUp[] {
    const people = new Map<number, number[]>();
    for (const row of this.db.prepare("SELECT catch_up_id, person_id FROM catch_up_person ORDER BY person_id").all() as { catch_up_id: number; person_id: number }[]) {
      people.set(row.catch_up_id, [...(people.get(row.catch_up_id) ?? []), row.person_id]);
    }
    return (this.db.prepare(`SELECT ${COLUMNS.join(", ")} FROM catch_up ORDER BY day, id`).all() as unknown as CatchUpRow[])
      .map((row) => {
        const { id, day, time, trip, hours, others } = fromRow(row);
        return { id, day, time, trip, hours, others, personIds: people.get(id) ?? [] };
      });
  }

  // --- the captain's edits (People calls these inside its own transactions)

  /** Adds a catch-up, checked (normalizeCatchUp). Returns its number. */
  insert(catchUp: CatchUpInput): number {
    const id = Number(this.db
      .prepare(`INSERT INTO catch_up (${WRITTEN.join(", ")}, created_at) VALUES (${WRITTEN.map(() => "?").join(", ")}, ?)`)
      .run(...written(catchUp), Date.now()).lastInsertRowid);
    this.setPeople(id, catchUp.personIds);
    return id;
  }

  /** Makes catch-up `id` this one, checked (normalizeCatchUp), who was at it too. */
  update(id: number, catchUp: CatchUpInput): void {
    this.db
      .prepare(`UPDATE catch_up SET ${WRITTEN.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
      .run(...written(catchUp), id);
    this.setPeople(id, catchUp.personIds);
  }

  remove(id: number): void {
    this.db.prepare("DELETE FROM catch_up_person WHERE catch_up_id = ?").run(id);
    this.db.prepare("DELETE FROM catch_up WHERE id = ?").run(id);
  }

  /** Gives `intoId` every catch-up `fromId` was at (a merge or join, before `fromId` is deleted). */
  combine(intoId: number, fromId: number): void {
    this.db.prepare("INSERT OR IGNORE INTO catch_up_person (catch_up_id, person_id) SELECT catch_up_id, ? FROM catch_up_person WHERE person_id = ?").run(intoId, fromId);
    this.db.prepare("DELETE FROM catch_up_person WHERE person_id = ?").run(fromId);
  }

  /** Deletes every catch-up nobody is at any more (all its people deleted). */
  dropEmpty(): void {
    this.db.exec("DELETE FROM catch_up WHERE NOT EXISTS (SELECT 1 FROM catch_up_person WHERE catch_up_id = catch_up.id)");
  }

  // --- helpers

  /** Exactly these people at catch-up `id`. */
  private setPeople(id: number, personIds: readonly number[]): void {
    this.db.prepare("DELETE FROM catch_up_person WHERE catch_up_id = ? AND person_id NOT IN (SELECT value FROM json_each(?))").run(id, JSON.stringify(personIds));
    const add = this.db.prepare("INSERT OR IGNORE INTO catch_up_person (catch_up_id, person_id) VALUES (?, ?)");
    for (const personId of personIds) add.run(id, personId);
  }

  /** Everyone at each of these catch-ups, A to Z. */
  private peopleOf(ids: number[]): Map<number, CatchUp["people"]> {
    const people = new Map<number, CatchUp["people"]>();
    if (ids.length === 0) return people;
    for (const row of this.db
      .prepare(
        `SELECT cp.catch_up_id, p.id, p.name, p.aliases_json FROM catch_up_person cp JOIN person p ON p.id = cp.person_id
         WHERE cp.catch_up_id IN (SELECT value FROM json_each(?)) ORDER BY p.name COLLATE NOCASE, p.id`,
      )
      .all(JSON.stringify(ids)) as { catch_up_id: number; id: number; name: string; aliases_json: string }[]) {
      const person = { id: row.id, name: row.name, aliases: JSON.parse(row.aliases_json) as string[] };
      people.set(row.catch_up_id, [...(people.get(row.catch_up_id) ?? []), person]);
    }
    return people;
  }
}

/** The columns a catch-up is read from, and those the captain's edits write (all but its number and when it was added). */
const COLUMNS = ["id", "day", "time", "hours", "note", "others", "trip_last_day", "trip_end_time", "trip_private_from", "trip_private_to"] as const;
const WRITTEN = COLUMNS.filter((column) => column !== "id");

/** A checked catch-up's values for WRITTEN, in its order. */
function written({ day, time, hours, note, others, trip }: CatchUpInput): Array<string | number | null> {
  return [day, time, hours, note, others, trip?.lastDay ?? null, trip?.endTime ?? null, trip?.privateFrom ?? null, trip?.privateTo ?? null];
}

function fromRow({ id, day, time, hours, note, others, trip_last_day, trip_end_time, trip_private_from, trip_private_to }: CatchUpRow): Omit<CatchUp, "people"> {
  const trip = trip_last_day === null ? null : { lastDay: trip_last_day, endTime: trip_end_time!, privateFrom: trip_private_from!, privateTo: trip_private_to! };
  return { id, day, time, trip, hours, note, others };
}

function normalizeDay(day: unknown, today: string): string {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.trim())) throw new InvalidInputError(`a ${HANGOUT.one}'s date is written as 2026-10-04`);
  const clean = day.trim();
  const [year, month, date] = clean.split("-").map(Number);
  const real = new Date(Date.UTC(year, month - 1, date));
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== date) throw new InvalidInputError(`${clean} is not a date`);
  if (clean > today) throw new InvalidInputError(`a ${HANGOUT.one} is one that has happened: ${clean} is after today (${today})`);
  if (clean < FIRST_DAY) throw new InvalidInputError(`a ${HANGOUT.one}'s date is from ${FIRST_DAY}`);
  return clean;
}

function normalizeTrip(trip: unknown, first: string, time: string | null, today: string): Trip | null {
  if (trip === undefined || trip === null) return null;
  if (typeof trip !== "object") throw new InvalidInputError(`a ${HANGOUT.one}'s trip is its last day, end time and private hours`);
  const { lastDay, endTime, privateFrom, privateTo } = trip as Record<string, unknown>;
  const last = normalizeDay(lastDay, today);
  if (last <= first) throw new InvalidInputError(`a ${HANGOUT.one}'s last day is after its first: ${last} is not after ${first}`);
  if (time === null) throw new InvalidInputError(`a ${HANGOUT.one} over several days needs the time it began`);
  const end = normalizeTime(endTime);
  if (end === null) throw new InvalidInputError(`a ${HANGOUT.one} over several days needs the time it ended`);
  const given = (value: unknown, otherwise: string) => normalizeTime(value) ?? otherwise;
  const clean = { lastDay: last, endTime: end, privateFrom: given(privateFrom, PRIVATE_FROM), privateTo: given(privateTo, PRIVATE_TO) };
  if (catchUpDayCount({ day: first, trip: clean }) > DAYS_MOST) throw new InvalidInputError(`a ${HANGOUT.one} is on at most ${DAYS_MOST} days`);
  return clean;
}

/** A trip's hours: its time together in all, which must be some. */
function tripTotal(day: string, time: string | null, trip: Trip): number {
  const hours = tripHours(day, time, trip);
  if (hours <= 0) throw new InvalidInputError(`a ${HANGOUT.one} over several days needs some time together outside the private hours`);
  return hours;
}

function normalizeTime(time: unknown): string | null {
  if (time === undefined || time === null || (typeof time === "string" && time.trim() === "")) return null;
  const match = typeof time === "string" ? /^(\d{1,2}):(\d{2})$/.exec(time.trim()) : null;
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new InvalidInputError(`a ${HANGOUT.one}'s time is a time of day, such as 19:30, or none`);
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function normalizeHours(hours: unknown): number {
  const value = typeof hours === "string" && /^\s*(\d+(\.\d*)?|\.\d+)\s*$/.test(hours) ? Number(hours) : hours;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InvalidInputError(`a ${HANGOUT.one}'s hours are a number, such as 1 or 2.5`);
  const clean = Math.round(value * 100) / 100;
  if (clean <= 0 || clean > HOURS_MOST) throw new InvalidInputError(`a ${HANGOUT.one} lasts more than 0 hours and at most ${HOURS_MOST}`);
  return clean;
}

function normalizeNote(note: unknown): string {
  if (note === undefined || note === null) return "";
  if (typeof note !== "string") throw new InvalidInputError(`a ${HANGOUT.one}'s note is text`);
  const clean = note.replace(/\r\n?/g, "\n").trim();
  if (clean.length > NOTE_MAX) throw new InvalidInputError(`a ${HANGOUT.one}'s note is at most ${NOTE_MAX.toLocaleString(LOCALE)} characters`);
  return clean;
}

function normalizeOthers(others: unknown): number {
  if (others === undefined || others === null) return 0;
  const value = typeof others === "string" && /^\s*\d+\s*$/.test(others) ? Number(others) : others;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > OTHERS_MOST) {
    throw new InvalidInputError(`a ${HANGOUT.one}'s others are a whole number from 0 to ${OTHERS_MOST.toLocaleString(LOCALE)}`);
  }
  return value;
}

function normalizePeople(personIds: unknown): number[] {
  if (!Array.isArray(personIds) || !personIds.every(Number.isSafeInteger)) throw new InvalidInputError(`a ${HANGOUT.one}'s people are person numbers`);
  const clean = [...new Set(personIds as number[])];
  if (clean.length === 0) throw new InvalidInputError(`a ${HANGOUT.one} is with someone: give at least one person`);
  return clean;
}
