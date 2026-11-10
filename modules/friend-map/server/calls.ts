// Calls in no chat (the archive's call table): the phone's call history (the
// call-history connector, platform "phone"), and an app's call with several
// people made in no group chat (a WhatsApp three-way call, from whatsapp-db):
// what the archive says about each person on them, for their panel, the
// closeness score and the CLI. A phone call is with one import person (an
// account on platform "phone", keyed by number or Apple ID), and so with
// whichever person that account belongs to; the rules put a number someone
// holds on iMessage on them (people.ts, linkCallsToNumbers). A call with
// several people is one row for each account its source names, sharing its
// call id, with how many more were on it unnamed (others): it is a call with
// each of them, as a call the captain logged with several people is (below).
// Calls are metadata only: when, how long, which way, answered or not, and
// over what.
//
// The other apps keep their call records among the messages (type 'call'),
// in the chat they were made in. Messenger, Instagram, WhatsApp, WeChat and
// Telegram say how long each was connected (message.call_seconds, 0 for one
// never answered), and Signal whether it was answered (0 for one that was
// not); a WeChat call whose record WeChat compressed (read only with its
// dictionary), Signal's answered ones, Messenger's phone-app export, a
// WhatsApp call answered on another device and a Telegram video chat the
// bridge says only started say nothing of its length (NULL). One
// in a one-to-one chat is a call with the person on the other side
// (PERSON_CALLS) and counts as no message (structure.ts). One whose length is
// known counts as a phone call does: the closeness score adds it to that
// day's calls with them (callDays), and their panel and the CLI add it up.
// One whose length is not known counts nothing, until the captain gives it
// one (setCallLength, kept in call_length, which imports never touch); an
// app's own length is never changed. A call made in a group chat (where who
// was on it is not known) still counts as one message there.
//
// The captain also logs calls himself (Add event's Call; manual_call, kept by
// manualCalls.ts): with one or more people, each on one of their accounts,
// connected for as long as he said (on no account, with the person and on the
// app he said, only for someone with no account that carries calls), with
// any more on it he did not name. They are read here with the rest, so each
// counts as an imported call on that account does, except that a call with
// several people gives each of them a share of its time in the closeness
// score (callDays, groupShare in src/catchUps.ts), as an imported call with
// several people does, its unnamed others counted among them. One he logged
// on the phone or FaceTime with one person may be one the phone's call
// history brings in too, at its next import: on a day with both, that
// person's logged phone calls and their calls from the call history count
// the longer, never both (callDays).
//
// Any call may carry a note, the captain's words (setCallNote): one he logged
// on its rows (manual_call.note, kept by manualCalls.ts), an imported one
// apart (call_note), so imports never touch it: a call record by its message,
// and a call in no chat by its source's own key, which every row of one with
// several people shares. Notes are content: PERSON_CALLS,
// which SQL reads as person_call, leaves them out, and they count in nothing.
//
// The captain may also say whether an imported call was answered
// (setCallAnswered, kept in call_answered by the same keys as call_note):
// answered, missed, or unknown, over what its source says, which stays as it
// was. PERSON_CALLS reads his answer in its place, so the closeness score
// follows it: a call he says was missed counts nothing whatever its length,
// one he says was answered counts its length (with none, nothing until he
// gives it one), and one he says is unknown counts nothing, as a call whose
// source says neither. A call he logged was answered, and takes none.

import { bumpMeta, type CalendarCall, CALL_LENGTH_MOST_MINUTES, type CallAnswer, type CallAnsweredSaved, type CallCounts, type CallDay, type CallLengthSaved, type CallNoteSaved, type CallRef, dayKey, type Db, InvalidInputError, type ListedCall, LOCALE, NotFoundError, type PersonCall } from "../../../sdk/server.ts";
import type { ManualCalls } from "./manualCalls.ts";

/**
 * An imported call's answered (1, 0, or NULL for not known), as PERSON_CALLS reads it: the captain's, from its
 * call_answered row `alias`, when he set one; else its source's, `source`.
 */
function answeredAs(alias: string, source: string): string {
  return `CASE ${alias}.answered WHEN 'answered' THEN 1 WHEN 'missed' THEN 0 WHEN 'unknown' THEN NULL ELSE ${source} END`;
}

/**
 * Every call with a person (never the captain, nor in a Marketplace or dropped chat): the calls in no chat (the phone's
 * call history, and an app's call with several people, each with everyone on it its source names, on their account),
 * the other apps' call records in one-to-one chats, each with the person on the other side and their account, and the
 * calls the captain logged (on an account, with its person and on its platform, or on no account, with the person and
 * on the app he said; no direction or service). A call with several people (an imported one, or one logged) has a
 * call group (a logged call's is the number of its first logged; an imported one's, minus its first row's number, so
 * the two never meet) and says how many people were on it
 * (`people`, the captain aside: those named, and its unnamed `others`); every other
 * call is with 1, in no group. The calls in no chat have a call_id, the others' a message_id, those logged a
 * manual_call_id. Another app's call is as long as the app says, else as long as the captain said (call_length); with
 * neither, answered and duration_seconds are NULL, as they are for a call in no chat of no known length (its answered
 * aside). An imported call's answered is the captain's when he set one (call_answered: ANSWERED_AS), its source's
 * otherwise; unknown is NULL. Someone a merge left twice on one call with several people has it once, the first row. Read by callDays,
 * callsOf and the person_call view (sqlRead.ts).
 */
export const PERSON_CALLS = `
  SELECT a.person_id, c.id AS call_id, NULL AS message_id, NULL AS manual_call_id, c.import_person_id AS account_id, c.platform, c.at,
    c.direction, ${answeredAs("ca", "c.answered")} AS answered, c.duration_seconds, c.service, CASE WHEN g.people + c.others > 1 THEN -g.first END AS call_group,
    g.people + c.others AS people, c.others
  FROM call c JOIN import_person a ON a.id = c.import_person_id JOIN person p ON p.id = a.person_id AND p.is_self = 0
  LEFT JOIN call_answered ca ON ca.platform = c.platform AND ca.platform_call_id = c.platform_call_id
  JOIN (
    SELECT gc.platform, gc.platform_call_id, min(gc.id) AS first, count(DISTINCT ga.person_id) AS people
    FROM call gc JOIN import_person ga ON ga.id = gc.import_person_id JOIN person gp ON gp.id = ga.person_id AND gp.is_self = 0
    GROUP BY gc.platform, gc.platform_call_id
  ) g ON g.platform = c.platform AND g.platform_call_id = c.platform_call_id
  WHERE NOT EXISTS (
    SELECT 1 FROM call o JOIN import_person oa ON oa.id = o.import_person_id
    WHERE o.platform = c.platform AND o.platform_call_id = c.platform_call_id AND o.id < c.id AND oa.person_id = a.person_id)
  UNION ALL
  SELECT p.id, NULL, NULL, mc.id, mc.account_id, coalesce(a.platform, mc.app), mc.at, NULL, 1, mc.duration_seconds, NULL, mc.call_group,
    (SELECT count(DISTINCT coalesce(ga.person_id, g.person_id)) FROM manual_call g LEFT JOIN import_person ga ON ga.id = g.account_id WHERE g.call_group = mc.call_group) + mc.others,
    mc.others
  FROM manual_call mc LEFT JOIN import_person a ON a.id = mc.account_id JOIN person p ON p.id = coalesce(a.person_id, mc.person_id) AND p.is_self = 0
  WHERE NOT EXISTS (
    SELECT 1 FROM manual_call o LEFT JOIN import_person oa ON oa.id = o.account_id
    WHERE o.call_group = mc.call_group AND o.id < mc.id AND coalesce(oa.person_id, o.person_id) = p.id)
  UNION ALL
  SELECT ip.person_id, NULL, m.id, NULL, cm.account_id, m.platform, m.sent_at,
    CASE WHEN m.is_from_self = 1 OR coalesce(sender.is_self, 0) = 1 OR coalesce(sender_person.is_self, 0) = 1 THEN 'outgoing' ELSE 'incoming' END,
    ${answeredAs("ra", "coalesce(m.call_seconds, cl.seconds) > 0")}, coalesce(m.call_seconds, cl.seconds), NULL, NULL, 1, 0
  FROM message m
  LEFT JOIN call_length cl ON cl.message_id = m.id
  LEFT JOIN call_answered ra ON ra.message_id = m.id
  JOIN conversation c ON c.id = m.conversation_id AND c.type = 'direct' AND c.is_marketplace = 0 AND c.dropped_at IS NULL
  JOIN conversation_member cm ON cm.conversation_id = c.id AND cm.removed_at IS NULL
  JOIN import_person ip ON ip.id = cm.account_id AND ip.is_self = 0
  JOIN person p ON p.id = ip.person_id AND p.is_self = 0
  LEFT JOIN import_person sender ON sender.id = m.sender_account_id
  LEFT JOIN person sender_person ON sender_person.id = sender.person_id
  WHERE m.type = 'call'`;

/**
 * PERSON_CALLS with each call's note (its own, as setCallNote keeps it; empty for none): what the panel, the Calendar
 * and the CLI read. Never for SQL, which never reads a note.
 */
const NOTED_CALLS = `
  SELECT pc.*, coalesce(mc.note, rn.note, cn.note, '') AS note
  FROM (${PERSON_CALLS}) pc
  LEFT JOIN manual_call mc ON mc.id = pc.manual_call_id
  LEFT JOIN call_note rn ON rn.message_id = pc.message_id
  LEFT JOIN call c ON c.id = pc.call_id
  LEFT JOIN call_note cn ON cn.platform = c.platform AND cn.platform_call_id = c.platform_call_id`;

interface CallRow {
  person_id: number;
  call_id: number | null;
  message_id: number | null;
  manual_call_id: number | null;
  account_id: number | null;
  platform: string;
  at: number;
  direction: PersonCall["direction"];
  answered: number;
  duration_seconds: number;
  service: PersonCall["service"];
  call_group: number | null;
  people: number;
  others: number;
  note: string;
}

/** Calls whose length is known: the phone's, the other apps' that say, those the captain gave one, and those he logged. */
const TIMED_CALLS = `SELECT * FROM (${NOTED_CALLS}) WHERE duration_seconds IS NOT NULL`;

/** A person's calls whose length is known, newest first; with `accountId`, only that account's of theirs. */
export function callsOf(db: Db, personId: number, accountId?: number): PersonCall[] {
  const rows = db
    .prepare(`${TIMED_CALLS} AND person_id = ? AND (? IS NULL OR account_id = ?) ORDER BY at DESC, call_id DESC, message_id DESC, manual_call_id DESC`)
    .all(personId, accountId ?? null, accountId ?? null) as unknown as CallRow[];
  return rows.map(personCall);
}

/** Everyone's calls whose length is known (the captain's own accounts' none), each person's newest first, by person id. */
export function everyonesCalls(db: Db): Map<number, PersonCall[]> {
  const rows = db.prepare(`${TIMED_CALLS} ORDER BY at DESC, call_id DESC, message_id DESC, manual_call_id DESC`).all() as unknown as CallRow[];
  const calls = new Map<number, PersonCall[]>();
  for (const row of rows) {
    const theirs = calls.get(row.person_id) ?? [];
    if (theirs.length === 0) calls.set(row.person_id, theirs);
    theirs.push(personCall(row));
  }
  return calls;
}

/**
 * Whether a row of PERSON_CALLS is the phone's own: a call from the phone's call history, or one the captain logged on
 * the phone or FaceTime (on a phone or iMessage account, or on no account on Phone or FaceTime).
 */
const FROM_HISTORY = "call_id IS NOT NULL AND platform = 'phone'";
const LOGGED_ON_PHONE = "manual_call_id IS NOT NULL AND platform IN ('phone', 'imessage', 'facetime')";

/**
 * Everyone's calls from the phone's call history added up, with the phone and FaceTime calls the captain logged (the
 * captain's own accounts' none), by person id; nobody without calls. The Table's Phone calls, so the other apps' calls
 * are not in it.
 */
export function callCounts(db: Db): Map<number, CallCounts> {
  const rows = db
    .prepare(
      `SELECT person_id, count(CASE WHEN answered = 1 THEN 1 END) AS answered, count(CASE WHEN answered = 0 THEN 1 END) AS unanswered,
         sum(CASE WHEN answered = 1 THEN duration_seconds ELSE 0 END) AS seconds, max(at) AS last_call_at
       FROM (${PERSON_CALLS}) WHERE (${FROM_HISTORY}) OR (${LOGGED_ON_PHONE})
       GROUP BY person_id`,
    )
    .all() as { person_id: number; answered: number; unanswered: number; seconds: number; last_call_at: number }[];
  return new Map(rows.map((row) => [row.person_id, { answered: row.answered, unanswered: row.unanswered, seconds: row.seconds, lastCallAt: row.last_call_at }]));
}

function personCall(row: CallRow): PersonCall {
  return {
    id: row.call_id ?? row.message_id ?? row.manual_call_id!,
    platform: row.platform,
    messageId: row.message_id,
    manual: row.manual_call_id !== null,
    accountId: row.account_id,
    at: row.at,
    durationSeconds: row.duration_seconds,
    direction: row.direction,
    answered: row.answered === 1,
    service: row.service,
    group: row.call_group,
    people: row.people,
    others: row.others,
    note: row.note,
  };
}

/**
 * Every local day with answered calls, per person (never the captain), with how long they were connected in
 * all, oldest first: phone and FaceTime calls from the call history, the other apps' whose length is known (in
 * one-to-one chats, and those with several people in no chat, and any the captain gave a length), and those he logged,
 * added up together, so the shortest day that counts is a day's calls on every app at once. But a call he logged on the
 * phone or FaceTime with them alone may be one the call history has too (he logged it before its next import): on a
 * day with both, those he logged so and those from the call history count whichever add up to longer, never both.
 * (The call history leaves out calls with several people, so one he
 * logged with several is never in it.) A call with several people (imported, or logged by him) is kept apart
 * (groupCalls), whole, with how many were on it (its unnamed others too), for the score to give each their share of it
 * (callDaySeconds in src/catchUps.ts), as a hangout's worth is shared out. A call whose length is not known is in none.
 * What the closeness score counts calls by (callCatchUps in src/demos/closeness.ts).
 */
export function callDays(db: Db): CallDay[] {
  const rows = db
    .prepare(
      `SELECT person_id, at, duration_seconds, people, CASE WHEN ${FROM_HISTORY} THEN 'history' WHEN ${LOGGED_ON_PHONE} AND people = 1 THEN 'logged' END AS phone
       FROM (${PERSON_CALLS}) WHERE answered = 1 AND duration_seconds IS NOT NULL ORDER BY at`,
    )
    .all() as { person_id: number; at: number; duration_seconds: number; people: number; phone: "history" | "logged" | null }[];
  const days = new Map<string, CallDay & { history: number; logged: number }>();
  for (const row of rows) {
    const day = dayKey(row.at);
    const key = `${row.person_id}:${day}`;
    const known = days.get(key) ?? days.set(key, { personId: row.person_id, day, seconds: 0, history: 0, logged: 0 }).get(key)!;
    if (row.people > 1) (known.groupCalls ??= []).push({ seconds: row.duration_seconds, people: row.people });
    else if (row.phone !== null) known[row.phone] += row.duration_seconds;
    else known.seconds += row.duration_seconds;
  }
  return [...days.values()].map(({ history, logged, ...day }) => ({ ...day, seconds: day.seconds + Math.max(history, logged) }));
}

/**
 * Gives call record `messageId` the length the captain says, in whole minutes, or takes it away (null): only a call
 * in a one-to-one chat whose app does not say how long it was. Run inside a changeset (Changes.record), so it can be
 * undone. Returns the call as the chat now reads it.
 */
export function setCallLength(db: Db, messageId: number, minutes: unknown): CallLengthSaved["call"] {
  if (minutes !== null && !(Number.isInteger(minutes) && (minutes as number) >= 1 && (minutes as number) <= CALL_LENGTH_MOST_MINUTES)) {
    throw new InvalidInputError(`minutes must be a whole number from 1 to ${CALL_LENGTH_MOST_MINUTES}, or null to take the length away`);
  }
  if (callRecord(db, messageId).call_seconds !== null) throw new InvalidInputError(`its app says how long call ${messageId} was, so it keeps that`);
  if (minutes !== null && db.prepare("SELECT 1 FROM call_answered WHERE message_id = ? AND answered = 'missed'").get(messageId)) {
    throw new InvalidInputError(`you said call ${messageId} was missed, so it has no length`);
  }
  const changed = minutes === null
    ? db.prepare("DELETE FROM call_length WHERE message_id = ?").run(messageId).changes
    : db.prepare(
      `INSERT INTO call_length (message_id, seconds, set_at) VALUES (?, ?, ?)
       ON CONFLICT (message_id) DO UPDATE SET seconds = excluded.seconds, set_at = excluded.set_at WHERE seconds != excluded.seconds`,
    ).run(messageId, (minutes as number) * 60, Date.now()).changes;
  // The closeness score counts it now (or no more): every open view works it out again.
  if (Number(changed) > 0) bumpMeta(db, "people_version");
  return callLengthOf(db, messageId);
}

/** How long call record `messageId` was, as the chat reads it: the app's own length, else the captain's, else null. */
export function callLengthOf(db: Db, messageId: number): CallLengthSaved["call"] {
  const row = db
    .prepare("SELECT coalesce(m.call_seconds, cl.seconds) AS seconds, m.call_seconds IS NULL AND cl.seconds IS NOT NULL AS given FROM message m LEFT JOIN call_length cl ON cl.message_id = m.id WHERE m.id = ?")
    .get(messageId) as { seconds: number | null; given: number };
  return { messageId, callSeconds: row.seconds, callLengthGiven: row.given === 1 };
}

/**
 * The calls in no chat (the phone's, and an app's with several people) whose length is known, and those the captain
 * logged, from `from` to before `to` (ms), in time order, each with who it was with (one row for each person on a call
 * with several; never the captain's own accounts): the Calendar's. The other apps' calls in chats are among their
 * chats' messages.
 */
export function callsBetween(db: Db, from: number, to: number): CalendarCall[] {
  const rows = db
    .prepare(`${TIMED_CALLS} AND message_id IS NULL AND at >= ? AND at < ? ORDER BY at, call_id, manual_call_id`)
    .all(from, to) as unknown as CallRow[];
  return rows.map((row) => ({ ...personCall(row), person: row.person_id }));
}

/** Logged call `id` as the person's calls list it; null when there is none (or it is with the captain). */
export function loggedCall(db: Db, id: number): PersonCall | null {
  const row = db.prepare(`SELECT * FROM (${NOTED_CALLS}) WHERE manual_call_id = ?`).get(id) as CallRow | undefined;
  return row ? personCall(row) : null;
}

/**
 * Every call with anyone (never only the captain), from every source, of known length or not, newest first: the
 * Time river's calls (once the Table's Calls tab too). A call with several people is one, with everyone on it (each once; a logged call's group, or an
 * app's call in no chat), its ref the first of its rows; a call record is one, with whoever is on the other side.
 */
export function listCalls(db: Db): ListedCall[] {
  // A call record's own length (its app's), to tell it from the captain's; what its source says of whether it was
  // answered, and whether the captain set that.
  const rows = db
    .prepare(`SELECT n.*, m.call_seconds AS app_seconds, ${SOURCE_ANSWERED} AS source_answered, coalesce(ca.answered, '') != '' AS answered_set
      FROM (${NOTED_CALLS}) n LEFT JOIN message m ON m.id = n.message_id LEFT JOIN call_length cl ON cl.message_id = n.message_id
      LEFT JOIN call c ON c.id = n.call_id
      LEFT JOIN call_answered ca ON ca.message_id = n.message_id OR (ca.platform = c.platform AND ca.platform_call_id = c.platform_call_id)
      ORDER BY n.at DESC, n.call_id, n.message_id, n.manual_call_id`)
    .all() as unknown as Array<Omit<CallRow, "answered" | "duration_seconds"> & {
      answered: number | null;
      duration_seconds: number | null;
      app_seconds: number | null;
      source_answered: number | null;
      answered_set: number;
    }>;
  const calls = new Map<string, ListedCall>();
  for (const row of rows) {
    // A call's rows (one for each person on it) share its group; a call record's, its message.
    const key = row.call_group !== null ? `${row.manual_call_id === null ? "call" : "logged"}:${row.call_group}`
      : row.message_id !== null ? `record:${row.message_id}` : row.call_id !== null ? `call:${row.call_id}` : `logged:${row.manual_call_id}`;
    const known = calls.get(key);
    if (known) {
      if (!known.people.includes(row.person_id)) known.people.push(row.person_id);
      continue;
    }
    const ref: CallRef = row.message_id !== null ? { kind: "record", id: row.message_id }
      : row.manual_call_id !== null ? { kind: "logged", id: row.manual_call_id } : { kind: "call", id: row.call_id! };
    const logged = ref.kind === "logged";
    const given = ref.kind === "record" && row.duration_seconds !== null && row.app_seconds === null;
    calls.set(key, {
      ref,
      at: row.at,
      platform: row.platform,
      service: row.service,
      source: logged ? "logged" : ref.kind === "record" ? "record" : row.platform === "phone" ? "history" : "app",
      direction: row.direction,
      answered: row.answered === null ? null : row.answered === 1,
      answeredSet: row.answered_set === 1,
      sourceAnswered: row.source_answered === null ? null : row.source_answered === 1,
      durationSeconds: row.duration_seconds,
      length: row.duration_seconds === null ? null : logged ? "logged" : given ? "given" : "source",
      // A missed call has no length, so takes none.
      lengthEditable: logged || (ref.kind === "record" && row.app_seconds === null && row.answered !== 0),
      people: [row.person_id],
      others: row.others,
      note: row.note,
    });
  }
  return [...calls.values()];
}

/**
 * What an imported call's source says of whether it was answered (1, 0, NULL), in a query with its call record `m`
 * and its call_length `cl`, or its call in no chat `c`; a logged call (neither) was.
 */
const SOURCE_ANSWERED = "CASE WHEN m.id IS NOT NULL THEN coalesce(m.call_seconds, cl.seconds) > 0 WHEN c.id IS NOT NULL THEN c.answered ELSE 1 END";

/**
 * Sets whether imported call `ref` was answered, as the captain says (answered, missed or unknown), over what its source
 * says, which stays as it was; the same as its source says takes his away (its row emptied). Missed takes away a length
 * he gave a call record, as a missed call has none (its source's own is kept, and counts nothing). A call he logged was
 * answered, and is refused. Run inside a changeset (Changes.record), so it can be undone. Returns the call as it now is.
 */
export function setCallAnswered(db: Db, ref: unknown, answer: unknown): Omit<CallAnsweredSaved, "changeset"> {
  const call = callRef(ref);
  if (answer !== "answered" && answer !== "missed" && answer !== "unknown") throw new InvalidInputError("answered is answered, missed or unknown");
  if (call.kind === "logged") throw new InvalidInputError("a call you logged was answered, so it keeps that");
  const which = importedCall(db, call);
  // A missed call has no length: the one he gave it goes (its app's own stays, and counts nothing while missed).
  const cleared = answer === "missed" && call.kind === "record" ? Number(db.prepare("DELETE FROM call_length WHERE message_id = ?").run(call.id).changes) : 0;
  const source = (db
    .prepare(`SELECT ${SOURCE_ANSWERED} AS answered FROM (SELECT 1) LEFT JOIN message m ON m.id = ? LEFT JOIN call_length cl ON cl.message_id = m.id
      LEFT JOIN call c ON c.id = (SELECT min(id) FROM call WHERE platform = ? AND platform_call_id = ?)`)
    .get(...which) as { answered: number | null }).answered;
  const sourceAnswer: CallAnswer = source === null ? "unknown" : source === 1 ? "answered" : "missed";
  const kept = answer === sourceAnswer ? "" : answer;
  const changed = keepImportedRow(db, "call_answered", "answered", which, kept);
  // The closeness score counts it as he says now: every open view works it out again.
  if (changed + cleared > 0) bumpMeta(db, "people_version");
  const now: CallAnswer = kept === "" ? sourceAnswer : kept;
  return { call, answered: now === "unknown" ? null : now === "answered", answeredSet: kept !== "" };
}

/** The longest note kept on a call. */
export const CALL_NOTE_MOST = 1000;

/** A call's note as given: text, Windows line ends made plain, space trimmed at either end; empty is none. */
export function normalizeCallNote(note: unknown): string {
  if (note === undefined || note === null) return "";
  if (typeof note !== "string") throw new InvalidInputError("a call's note is text");
  const clean = note.replace(/\r\n?/g, "\n").trim();
  if (clean.length > CALL_NOTE_MOST) throw new InvalidInputError(`a call's note is at most ${CALL_NOTE_MOST.toLocaleString(LOCALE)} characters`);
  return clean;
}

/**
 * Gives call `ref` the note the captain says, or takes it away (empty): a logged call's whole group (manualCalls.ts),
 * an imported call in no chat by its source's key (every row of one with several people shares it), or a call record
 * in a one-to-one chat. Run inside a changeset (Changes.record), so it can be undone. Returns the call and its note as
 * it now is.
 */
export function setCallNote(db: Db, manualCalls: ManualCalls, ref: unknown, note: unknown): Omit<CallNoteSaved, "changeset"> {
  const call = callRef(ref);
  const clean = normalizeCallNote(note);
  const changed = call.kind === "logged" ? manualCalls.setNote(call.id, clean) : setImportedNote(db, call, clean);
  // The panel and the chat show it: every open view loads again.
  if (changed > 0) bumpMeta(db, "people_version");
  return { call, note: clean };
}

/**
 * Gives an imported call its note in call_note, its one row there (a note taken away leaves it, emptied, so an undo
 * always finds it where it was), made with its first note: a call record by its message, a call in no chat by its
 * source's own key. How many rows changed.
 */
function setImportedNote(db: Db, call: CallRef, note: string): number {
  return keepImportedRow(db, "call_note", "note", importedCall(db, call), note);
}

/** An imported call's key in call_note and call_answered: a call record by its message, a call in no chat by its source's own key. */
type ImportedKey = [message: number | null, platform: string | null, platformCallId: string | null];

/** Imported call `call`'s key (ImportedKey), refusing one not in the archive (or not a call with someone). */
function importedCall(db: Db, call: CallRef): ImportedKey {
  if (call.kind === "call") {
    const row = db.prepare("SELECT platform, platform_call_id FROM call WHERE id = ?").get(call.id) as { platform: string; platform_call_id: string } | undefined;
    if (!row) throw new NotFoundError(`no call #${call.id}`);
    return [null, row.platform, row.platform_call_id];
  }
  callRecord(db, call.id);
  return [call.id, null, null];
}

/**
 * Sets `column` of an imported call's one row in `table` (call_note, call_answered) to `value`, making the row with its
 * first value that is not empty; empty leaves a row there emptied, so an undo always finds it where it was. How many
 * rows changed.
 */
function keepImportedRow(db: Db, table: "call_note" | "call_answered", column: "note" | "answered", which: ImportedKey, value: string): number {
  const where = "message_id IS ? AND platform IS ? AND platform_call_id IS ?";
  const changed = Number(db.prepare(`UPDATE ${table} SET ${column} = ?, set_at = ? WHERE ${where} AND ${column} != ?`).run(value, Date.now(), ...which, value).changes);
  if (changed > 0 || value === "" || db.prepare(`SELECT 1 FROM ${table} WHERE ${where}`).get(...which)) return changed;
  return Number(db.prepare(`INSERT INTO ${table} (message_id, platform, platform_call_id, ${column}, set_at) VALUES (?, ?, ?, ?, ?)`).run(...which, value, Date.now()).changes);
}

/** A call's ref as given (CallRef), checked. */
function callRef(input: unknown): CallRef {
  const { kind, id } = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  if ((kind !== "call" && kind !== "record" && kind !== "logged") || !Number.isSafeInteger(id)) {
    throw new InvalidInputError("a call is its kind (call, record or logged) and its number");
  }
  return { kind, id: id as number };
}

/** Refuses message `messageId` unless it is a call record in a one-to-one chat (the only ones that are calls with someone). */
function callRecord(db: Db, messageId: number): { call_seconds: number | null } {
  const row = db
    .prepare("SELECT m.type, m.call_seconds, c.type AS chat FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE m.id = ?")
    .get(messageId) as { type: string; call_seconds: number | null; chat: string } | undefined;
  if (!row) throw new NotFoundError(`no message ${messageId}`);
  if (row.type !== "call") throw new InvalidInputError(`message ${messageId} is not a call`);
  if (row.chat !== "direct") throw new InvalidInputError(`call ${messageId} was in a group chat, where who was on it is not known`);
  return row;
}
