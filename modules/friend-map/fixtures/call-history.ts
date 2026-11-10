// A small, entirely made-up copy of the phone's call history,
// CallHistory.storedata (see connectors/call-history/read.ts), for tests. Only
// the tables and columns the connector reads are made, with the real names
// and Core Data's own (Z_PK, Z_ENT, ...). Its numbers are imessage.ts's, so a
// call can land on the person who holds the number in iMessage.
//
// It has what the real one has that matters: phone calls each way, answered
// and missed; an outgoing call that was connected (which never has ZANSWERED
// set) and one that was not; a number the phone normalised and one it did not
// (written as typed, in national form); FaceTime audio by Apple ID email and
// FaceTime video by number; a number nobody holds in iMessage, with a name the
// phone kept, and one without; a short code; a withheld number; a call through
// another app; and a group FaceTime call. `copy: "later"` is a newer copy of
// the same history: every call again, one of them longer, and two since.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IM_PEOPLE } from "./imessage.ts";

/** Seconds since 2001-01-01, as Core Data stores dates. */
const at = (iso: string) => Date.parse(iso) / 1000 - 978_307_200;

export const CALL_PEOPLE = {
  /** A number nobody holds in iMessage; the phone kept a name for it. */
  plumber: "+61491575254",
  /** A number nobody holds in iMessage, without a name. */
  stranger: "+61491575789",
  shortCode: "131313",
} as const;

interface Call {
  pk: number;
  id: string;
  date: string;
  duration: number;
  originated: 0 | 1;
  answered: 0 | 1;
  address: string;
  /** The handles on the call, as [value, normalised value]; none for a withheld number. */
  handles: Array<[string, string | null]>;
  name?: string;
  provider?: string;
  type?: number;
}

const CALLS: Call[] = [
  // Ada: a long call she picked up, a short one out, one missed, and FaceTime audio by her Apple ID.
  { pk: 1, id: "A1", date: "2026-03-01T19:00:00+11:00", duration: 1830.4, originated: 0, answered: 1, address: "0491 571 266", handles: [["0491 571 266", IM_PEOPLE.ada]] },
  { pk: 2, id: "A2", date: "2026-03-02T08:15:00+11:00", duration: 95.6, originated: 1, answered: 0, address: IM_PEOPLE.ada, handles: [[IM_PEOPLE.ada, IM_PEOPLE.ada]] },
  { pk: 3, id: "A3", date: "2026-03-03T12:00:00+11:00", duration: 0, originated: 0, answered: 0, address: IM_PEOPLE.ada, handles: [[IM_PEOPLE.ada, IM_PEOPLE.ada]] },
  { pk: 4, id: "A4", date: "2026-03-04T21:00:00+11:00", duration: 600, originated: 1, answered: 0, address: "Ada@Example.com", handles: [["Ada@Example.com", null]], provider: "com.apple.FaceTime", type: 16 },
  // Bruno: a number written as typed, which the phone never normalised; an outgoing call he did not answer; FaceTime video.
  { pk: 5, id: "B1", date: "2026-03-05T18:30:00+11:00", duration: 0, originated: 1, answered: 0, address: "0491 571 491", handles: [["0491 571 491", null]] },
  { pk: 6, id: "B2", date: "2026-03-06T18:30:00+11:00", duration: 300, originated: 0, answered: 1, address: IM_PEOPLE.bruno, handles: [[IM_PEOPLE.bruno, IM_PEOPLE.bruno]], provider: "com.apple.FaceTime", type: 8 },
  // Numbers nobody holds in iMessage.
  { pk: 7, id: "P1", date: "2026-03-07T09:00:00+11:00", duration: 120, originated: 1, answered: 0, address: CALL_PEOPLE.plumber, handles: [[CALL_PEOPLE.plumber, CALL_PEOPLE.plumber]], name: "Pat the Plumber" },
  { pk: 8, id: "S1", date: "2026-03-08T09:00:00+11:00", duration: 0, originated: 0, answered: 0, address: CALL_PEOPLE.stranger, handles: [[CALL_PEOPLE.stranger, CALL_PEOPLE.stranger]] },
  { pk: 9, id: "C1", date: "2026-03-09T09:00:00+11:00", duration: 45, originated: 1, answered: 0, address: CALL_PEOPLE.shortCode, handles: [[CALL_PEOPLE.shortCode, null]] },
  // Left out: a withheld number, another app's call, a group FaceTime call.
  { pk: 10, id: "W1", date: "2026-03-10T09:00:00+11:00", duration: 0, originated: 0, answered: 0, address: "", handles: [] },
  { pk: 11, id: "X1", date: "2026-03-11T09:00:00+11:00", duration: 400, originated: 1, answered: 0, address: IM_PEOPLE.ada, handles: [[IM_PEOPLE.ada, IM_PEOPLE.ada]], provider: "net.whatsapp.WhatsApp", type: 1 },
  { pk: 12, id: "G1", date: "2026-03-12T09:00:00+11:00", duration: 900, originated: 1, answered: 0, address: IM_PEOPLE.ada, handles: [[IM_PEOPLE.ada, IM_PEOPLE.ada], [IM_PEOPLE.bruno, IM_PEOPLE.bruno]], provider: "com.apple.FaceTime", type: 8 },
];

/** The later copy: A2 went on longer than the first copy said, and two calls since. */
const LATER: Call[] = [
  ...CALLS.map((call) => (call.id === "A2" ? { ...call, duration: 125 } : call)),
  { pk: 13, id: "A5", date: "2026-03-20T19:00:00+11:00", duration: 2400, originated: 1, answered: 0, address: IM_PEOPLE.ada, handles: [[IM_PEOPLE.ada, IM_PEOPLE.ada]] },
  { pk: 14, id: "B3", date: "2026-03-21T19:00:00+11:00", duration: 60, originated: 0, answered: 1, address: IM_PEOPLE.bruno, handles: [[IM_PEOPLE.bruno, IM_PEOPLE.bruno]] },
];

/** Writes the call history into `folder` as CallHistory.storedata; returns its path. */
export async function writeCallHistoryFixture(folder: string, { copy = "first" }: { copy?: "first" | "later" } = {}): Promise<string> {
  await mkdir(folder, { recursive: true });
  const path = join(folder, "CallHistory.storedata");
  await rm(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE ZCALLRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZANSWERED INTEGER, ZCALL_CATEGORY INTEGER,
      ZCALLTYPE INTEGER, ZHANDLE_TYPE INTEGER, ZORIGINATED INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT, ZADDRESS VARCHAR,
      ZISO_COUNTRY_CODE VARCHAR, ZNAME VARCHAR, ZSERVICE_PROVIDER VARCHAR, ZUNIQUE_ID VARCHAR, ZLOCALPARTICIPANTUUID BLOB);
    CREATE TABLE ZHANDLE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZTYPE INTEGER, ZNORMALIZEDVALUE VARCHAR, ZVALUE VARCHAR);
    CREATE TABLE Z_2REMOTEPARTICIPANTHANDLES (Z_2REMOTEPARTICIPANTCALLS INTEGER, Z_4REMOTEPARTICIPANTHANDLES INTEGER,
      PRIMARY KEY (Z_2REMOTEPARTICIPANTCALLS, Z_4REMOTEPARTICIPANTHANDLES));
  `);
  const record = db.prepare(
    `INSERT INTO ZCALLRECORD (Z_PK, Z_ENT, Z_OPT, ZANSWERED, ZCALL_CATEGORY, ZCALLTYPE, ZHANDLE_TYPE, ZORIGINATED, ZDATE, ZDURATION,
       ZADDRESS, ZISO_COUNTRY_CODE, ZNAME, ZSERVICE_PROVIDER, ZUNIQUE_ID, ZLOCALPARTICIPANTUUID) VALUES (?, 2, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'au', ?, ?, ?, ?)`,
  );
  const handle = db.prepare("INSERT INTO ZHANDLE (Z_PK, Z_ENT, Z_OPT, ZTYPE, ZNORMALIZEDVALUE, ZVALUE) VALUES (?, 4, 1, ?, ?, ?)");
  const join_ = db.prepare("INSERT INTO Z_2REMOTEPARTICIPANTHANDLES VALUES (?, ?)");
  let handles = 0;
  // Each copy keeps its own row ids, as two devices' copies would.
  const offset = copy === "later" ? 100 : 0;
  for (const call of copy === "later" ? LATER : CALLS) {
    const email = call.address.includes("@");
    const type = call.type ?? 1;
    record.run(
      call.pk + offset, call.answered, type === 8 ? 2 : 1, type, call.address === "" ? 1 : email ? 3 : 2, call.originated, at(call.date),
      call.duration, call.address, call.name ?? null, call.provider ?? "com.apple.Telephony", call.id, new Uint8Array([1, 2, 3]),
    );
    for (const [value, normalized] of call.handles) {
      handle.run(++handles + offset, value.includes("@") ? 3 : 2, normalized, value);
      join_.run(call.pk + offset, handles + offset);
    }
  }
  db.close();
  return path;
}
