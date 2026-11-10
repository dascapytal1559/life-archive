// Reads the phone's call history: CallHistory.storedata, the Core Data SQLite
// database the iPhone keeps its Recents in and iCloud syncs to the Mac
// (~/Library/Application Support/CallHistoryDB/; an unencrypted iPhone backup
// leaves it out). Platform "phone": phone calls and FaceTime calls alike.
//
//   ZCALLRECORD                  one row per call: ZUNIQUE_ID, ZDATE (seconds since 2001-01-01),
//                                ZDURATION (seconds connected), ZORIGINATED (1: the captain called),
//                                ZANSWERED (1: an incoming call picked up), ZADDRESS (the number
//                                or Apple ID as the phone wrote it), ZNAME (a name the phone had
//                                for them, rarely set), ZSERVICE_PROVIDER (com.apple.Telephony,
//                                com.apple.FaceTime, or another app's id), ZCALLTYPE (1 phone,
//                                8 FaceTime video, 16 FaceTime audio)
//   ZHANDLE                      each party's number or Apple ID, with ZNORMALIZEDVALUE (E.164)
//   Z_2REMOTEPARTICIPANTHANDLES  which ZHANDLE rows were on each call
//   AddressBook.sqlitedb         the iPhone's own address book (see ../addressBook.ts), optional:
//                                beside the database; or the address book the `contacts` setting
//                                names, the iPhone's or the Mac's Contacts
//
// A call is keyed on its ZUNIQUE_ID, so importing a newer copy adds only the
// calls since. The other party is an account keyed as imessage-db keys one: a
// phone number in E.164 (the handle's normalised value, else the address
// written as normalizeHandle reads it), an email in lowercase, or the short
// code as written. So the rules can put a number's calls on the person who
// already holds that number in iMessage (people.ts, "rule:same-number"). An
// account is named by ZNAME, else the address book, else shown by its handle.
//
// An outgoing call never has ZANSWERED set, so one is answered when it was
// connected (lasted any time at all), which a voicemail is too; an incoming
// call is answered when ZANSWERED says so. Calls through other apps (WhatsApp,
// say), group calls and calls from a withheld number are left out and counted.
//
// The database is copied to a temporary folder and read there, never written.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { type AccountEvent, type CallService, type Connector, type HistoryOptions, isNumberName, isPhone, normalizeHandle } from "../../../../sdk/connector.ts";
import { importAddressBook } from "../addressBook.ts";
import { columnsOf, isFile, openCopy, plain, type Row } from "../appDb.ts";
import { manifest } from "./manifest.ts";

/** Apple counts time from 2001-01-01; this is that moment in milliseconds since 1970. */
const APPLE_EPOCH_MS = 978_307_200_000;
const DATABASE = "CallHistory.storedata";
const TELEPHONY = "com.apple.Telephony";
const FACETIME = "com.apple.FaceTime";
const FACETIME_VIDEO = 8;
const FACETIME_AUDIO = 16;

/** Where an account's name came from, best first, each with the tally that counts it. */
const NAME_SOURCES = {
  call: "accounts named by the call history",
  addressBook: "accounts named from the address book",
  phone: "accounts shown by phone number",
  email: "accounts shown by email",
  handle: "accounts shown by the short code they call from",
} as const;

export const callHistory: Connector = { manifest, history: readCallHistory };

export async function readCallHistory({ sources, config, emit }: HistoryOptions): Promise<void> {
  if (sources.length !== 1) throw new Error(`name one folder (or its ${DATABASE})`);
  const [source] = sources;
  const tallies = new Map<string, number>();
  const tally = (name: string, count = 1) => tallies.set(name, (tallies.get(name) ?? 0) + count);
  const databasePath = (await isFile(source)) ? source : join(source, DATABASE);
  if (!(await isFile(databasePath))) throw new Error(`there is no ${DATABASE} in ${source}`);
  const work = await mkdtemp(join(tmpdir(), "friend-map-calls-"));
  const opened: DatabaseSync[] = [];
  try {
    const db = (await openCopy(databasePath, work))!;
    opened.push(db);
    const columns = columnsOf(db, "ZCALLRECORD");
    if (columns.length === 0) throw new Error(`the database has no ZCALLRECORD table; is it the phone's ${DATABASE}?`);
    const missing = ["Z_PK", "ZUNIQUE_ID", "ZDATE", "ZDURATION", "ZORIGINATED", "ZANSWERED", "ZADDRESS"].filter((c) => !columns.includes(c));
    if (missing.length > 0) throw new Error(`the database's ZCALLRECORD has no ${missing.join(", ")}; its schema is not one this connector knows`);

    // The address book: the one the settings name (the iPhone's or the Mac's), which must be there, else the
    // iPhone's beside the database.
    const addressBook = await importAddressBook(config.contacts, dirname(databasePath), work);

    // Each call's other parties, by their handle rows (a group FaceTime call has several).
    const parties = new Map<number, Row[]>();
    if (columnsOf(db, "Z_2REMOTEPARTICIPANTHANDLES").length > 0 && columnsOf(db, "ZHANDLE").length > 0) {
      for (const row of db
        .prepare(
          `SELECT j.Z_2REMOTEPARTICIPANTCALLS AS call, h.ZVALUE AS value, h.ZNORMALIZEDVALUE AS normalized
           FROM Z_2REMOTEPARTICIPANTHANDLES j JOIN ZHANDLE h ON h.Z_PK = j.Z_4REMOTEPARTICIPANTHANDLES`,
        )
        .all() as Row[]) {
        const call = Number(row.call);
        parties.set(call, [...(parties.get(call) ?? []), row]);
      }
    }

    const bookEntry = (key: string) =>
      !addressBook ? undefined
      : isPhone(key) ? addressBook.lookup(key.slice(1))
      : key.includes("@") ? addressBook.lookupEmail(key)
      : undefined;
    const announced = new Map<string, AccountEvent>();
    const announce = async (key: string, callName: string) => {
      if (announced.has(key)) return;
      const book = bookEntry(key)?.name;
      const [displayName, nameSource]: [string, keyof typeof NAME_SOURCES] =
        callName && !isNumberName(callName) ? [callName, "call"]
        : book && !isNumberName(book) ? [book, "addressBook"]
        : [key, isPhone(key) ? "phone" : key.includes("@") ? "email" : "handle"];
      const account: AccountEvent = {
        kind: "account", key, keyKind: "id", displayName, nameSource,
        ...(isPhone(key) || key.includes("@") ? { handle: key } : {}),
      };
      announced.set(key, account);
      tally(NAME_SOURCES[nameSource]);
      await emit(account);
    };

    const rows = db.prepare("SELECT * FROM ZCALLRECORD ORDER BY ZDATE, Z_PK").all() as Row[];
    let first = Infinity;
    let last = -Infinity;
    for (const [done, row] of rows.entries()) {
      if (done > 0 && done % 1000 === 0) await emit({ kind: "progress", done, total: rows.length, note: "calls" });
      const id = str(row.ZUNIQUE_ID);
      const at = appleSeconds(row.ZDATE);
      if (!id || at === null) {
        tally("calls without an id or a time, left out");
        continue;
      }
      const provider = str(row.ZSERVICE_PROVIDER) || TELEPHONY;
      const type = Number(row.ZCALLTYPE ?? 1);
      const service: CallService | null =
        provider === TELEPHONY ? "phone"
        : provider !== FACETIME ? null
        : type === FACETIME_AUDIO ? "facetime-audio"
        : type === FACETIME_VIDEO || Number(row.ZCALL_CATEGORY) === 2 ? "facetime-video"
        : "facetime-audio";
      if (!service) {
        tally(`calls through another app (${provider}), left out`);
        continue;
      }
      const handles = parties.get(Number(row.Z_PK)) ?? [];
      if (handles.length > 1) {
        tally("group calls, left out");
        continue;
      }
      const key = keyOf(handles[0], str(row.ZADDRESS));
      if (!key) {
        tally("calls from a withheld or unknown number, left out");
        continue;
      }
      await announce(key, str(row.ZNAME));
      const outgoing = Number(row.ZORIGINATED) === 1;
      const durationSeconds = Math.max(0, Math.round(Number(row.ZDURATION) || 0));
      const answered = outgoing ? durationSeconds > 0 : Number(row.ZANSWERED) === 1;
      tally(`${service} calls, ${answered ? "answered" : "not answered"}`);
      await emit({
        kind: "call",
        id,
        with: key,
        at,
        durationSeconds,
        direction: outgoing ? "outgoing" : "incoming",
        answered,
        service,
        raw: plain(row, []),
      });
      first = Math.min(first, at);
      last = Math.max(last, at);
    }
    await emit({ kind: "progress", done: rows.length, total: rows.length, note: "calls" });
    if (first <= last) await emit({ kind: "coverage", from: first, to: last });
    for (const [name, count] of tallies) await emit({ kind: "tally", name, count });
  } finally {
    for (const db of opened) db.close();
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * The other party's account key: the handle's E.164 form when the phone worked one out, else the number or
 * Apple ID as written, read as normalizeHandle reads any handle (an email in lowercase, a national number in
 * the settings' phone country); null for a withheld number.
 */
export function keyOf(handle: Row | undefined, address: string): string | null {
  const normalized = str(handle?.normalized);
  if (isPhone(normalized)) return normalized;
  const written = str(handle?.value) || address;
  return written ? normalizeHandle(written) : null;
}

/** Milliseconds since 1970 for a Core Data date (seconds since 2001, with a fraction), or null for none. */
export function appleSeconds(value: SQLOutputValue | undefined): number | null {
  if (typeof value !== "number" && typeof value !== "bigint") return null;
  const seconds = Number(value);
  return seconds > 0 ? Math.round(seconds * 1000) + APPLE_EPOCH_MS : null;
}

function str(value: SQLOutputValue | undefined): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "bigint" ? String(value) : "";
}
