// friend map's checks for `npm run check-data` (sdk/server.ts's `checkData`; server/check-data.ts runs them), over the
// archive opened read-only: every person has a name (but for one the import left blank, which the rules archive; see
// blankByImport), written the way the app writes names unless it is still the platform's own (asImported), their
// aliases are names (see personFields.ts), their note and drafts written as the app writes them, the captain is never
// someone to reach out to, everyone has an identicon seed (see src/identicon.ts), and every import person points at a
// person, with a link source the rules know. Every tag in the tag table is written the way the app writes tags,
// "archive", "keep" and "live-together" are there and the only ones built in, and the captain's own person has none
// (see tags.ts). Every location is written the way the app writes them, each in one spelling (not "Brisbane" for some
// and "brisbane" for others), and the captain has none (see locations.ts). Every catch-up is written the way the app
// writes them (a date no later than today, its hours, a note) and is with someone, never the captain (see
// catchUps.ts), and so is every call the captain logged (manualCalls.ts), whose calls logged as one with several people
// all start at one time, last as long and share one note and their unnamed others. Every note on an imported call is
// written as the app writes notes, and is on a call still in the archive (calls.ts). Each problem is one line.

import { BUILT_IN_TAGS, carriesCalls, dayKey, isIdenticonSeed, timeOfDay, wallClock } from "../../../sdk/server.ts";
import { archiveReason } from "./archiving.ts";
import { normalizeCallNote } from "./calls.ts";
import { CatchUps, normalizeCatchUp } from "./catchUps.ts";
import { SCHEMA_VERSION, type Db } from "./db.ts";
import { normalizeManualCall, type ManualCallRow } from "./manualCalls.ts";
import { normalizeAliases, normalizeDraft, normalizeLocation, normalizeName, normalizeNote } from "./personFields.ts";
import { storableTag, Tags } from "./tags.ts";

/** The problems in the archive `db` (opened read-only), in the archive's folder `archiveDir`. */
export function checkPeople(db: Db, archiveDir: string): string[] {
  {
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version < SCHEMA_VERSION) {
      return [`archive.sqlite is from older code (schema ${version}, now ${SCHEMA_VERSION}): bring it up to date with npm run archive -- migrate (it backs up first), then check again`];
    }
    const problems: string[] = [];
    const tags = new Tags(db);
    const tagsOf = tags.byPerson();
    for (const person of db.prepare("SELECT * FROM person").all() as unknown as PersonRow[]) {
      const check = (what: string, value: unknown, normalize: (value: unknown) => unknown) => {
        try {
          if (JSON.stringify(normalize(value)) !== JSON.stringify(value)) problems.push(`person ${person.id}: its ${what} ${what === "aliases" ? "are" : "is"} not written the way the app writes them`);
        } catch (error) {
          problems.push(`person ${person.id}: its ${what}: ${(error as Error).message}`);
        }
      };
      if (!blankByImport(person, tagsOf.get(person.id) ?? [])) check("name", person.name, asImported(person) ? (name) => (normalizeName(name), name) : normalizeName);
      check("aliases", parse(person.aliases_json), normalizeAliases);
      const aliases = parse(person.aliases_json);
      if (Array.isArray(aliases) && aliases.includes(person.name)) problems.push(`person ${person.id}: one of its aliases is its name; a name is listed once`);
      check("note", person.note, normalizeNote);
      if (person.location !== null) check("location", person.location, normalizeLocation);
      if (!isIdenticonSeed(person.identicon_seed)) problems.push(`person ${person.id}: it has no identicon seed (16 hex digits); \`npm run archive -- rules\` gives it one`);
      if (person.is_self && person.should_reach_out) problems.push(`person ${person.id}: this is you, and you are not someone to reach out to`);
      if (person.is_self && tagsOf.has(person.id)) problems.push(`person ${person.id}: this is you, and you take no tags, but you have ${tagsOf.get(person.id)!.join(", ")}`);
      if (person.is_self && person.location !== null) problems.push(`person ${person.id}: this is you, and you have no location, but you have one`);
    }
    const list = tags.list();
    for (const tag of list) {
      try {
        if (storableTag(tag.name) !== tag.name) problems.push(`tag "${tag.name}": it is not written the way the app writes tags (${storableTag(tag.name)})`);
      } catch (error) {
        problems.push(`tag "${tag.name}": ${(error as Error).message}`);
      }
      if (tag.builtIn !== BUILT_IN_TAGS.includes(tag.name)) problems.push(`tag "${tag.name}": it should${tag.builtIn ? " not" : ""} be marked built in`);
    }
    for (const name of BUILT_IN_TAGS) {
      if (!list.some((tag) => tag.name === name)) problems.push(`tag "${name}": it is missing, and is always there`);
    }
    const spellings = new Map<string, Array<{ name: string; count: number }>>();
    for (const row of db.prepare("SELECT location COLLATE BINARY AS name, count(*) AS count FROM person WHERE location IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1")
      .all() as { name: string; count: number }[]) {
      spellings.set(row.name.toLowerCase(), [...(spellings.get(row.name.toLowerCase()) ?? []), row]);
    }
    for (const [first, ...others] of spellings.values()) {
      for (const other of others) {
        problems.push(`location "${first.name}" (${first.count}) is also written "${other.name}" (${other.count}): ` +
          `npm run archive -- location rename "${other.name}" "${first.name}" makes them one`);
      }
    }
    for (const catchUp of new CatchUps(db).list()) {
      try {
        const clean = normalizeCatchUp({ ...catchUp, personIds: catchUp.people.map((p) => p.id) });
        const fields = (c: typeof clean) => JSON.stringify([c.day, c.time, c.trip, c.hours, c.note, c.others]);
        if (fields(clean) !== fields({ ...catchUp, personIds: [] })) problems.push(`catch-up #${catchUp.id}: it is not written the way the app writes catch-ups`);
      } catch (error) {
        problems.push(`catch-up #${catchUp.id}: ${(error as Error).message}`);
      }
    }
    for (const row of db
      .prepare("SELECT DISTINCT cp.catch_up_id FROM catch_up_person cp JOIN person p ON p.id = cp.person_id WHERE p.is_self = 1")
      .all() as { catch_up_id: number }[]) {
      problems.push(`catch-up #${row.catch_up_id}: you are at it, and a catch-up is with other people`);
    }
    for (const call of db
      .prepare(
        `SELECT m.*, coalesce(a.person_id, m.person_id) AS person, a.platform, coalesce(p.is_self, 0) OR coalesce(a.is_self, 0) AS is_self
         FROM manual_call m LEFT JOIN import_person a ON a.id = m.account_id LEFT JOIN person p ON p.id = coalesce(a.person_id, m.person_id)`,
      )
      .all() as unknown as Array<ManualCallRow & { platform: string | null; is_self: number }>) {
      if (call.is_self) problems.push(`logged call #${call.id}: it is with you, and a call is with someone else`);
      if (call.platform !== null && !carriesCalls(call.platform)) problems.push(`logged call #${call.id}: it is on an account on ${call.platform}, which carries no calls`);
      try {
        const clean = normalizeManualCall({
          people: [{ personId: call.person, accountId: call.account_id, app: call.app ?? undefined }], day: dayKey(call.at), time: timeOfDay(call.at), minutes: call.duration_seconds / 60,
          note: call.note, others: call.others,
        });
        if (wallClock(clean.day, clean.time) !== call.at) problems.push(`logged call #${call.id}: it does not start on a whole minute, as the app writes calls`);
        if (clean.note !== call.note) problems.push(`logged call #${call.id}: its note is not written the way the app writes notes`);
      } catch (error) {
        problems.push(`logged call #${call.id}: ${(error as Error).message}`);
      }
    }
    for (const row of db
      .prepare("SELECT call_group FROM manual_call GROUP BY call_group HAVING count(DISTINCT at) > 1 OR count(DISTINCT duration_seconds) > 1 OR count(DISTINCT note) > 1 OR count(DISTINCT others) > 1")
      .all() as { call_group: number }[]) {
      problems.push(`logged call group #${row.call_group}: its calls differ in when they started, how long they lasted, their note or their unnamed others, and one call with several people is one call`);
    }
    for (const row of db
      .prepare(
        `SELECT n.id, n.note, n.message_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE m.id = n.message_id AND m.type = 'call' AND c.type = 'direct')
           OR n.message_id IS NULL AND NOT EXISTS (SELECT 1 FROM call c WHERE c.platform = n.platform AND c.platform_call_id = n.platform_call_id) AS lost
         FROM call_note n`,
      )
      .all() as { id: number; note: string; lost: number }[]) {
      try {
        if (normalizeCallNote(row.note) !== row.note) problems.push(`call note #${row.id}: it is not written the way the app writes notes`);
      } catch (error) {
        problems.push(`call note #${row.id}: ${(error as Error).message}`);
      }
      if (row.lost) problems.push(`call note #${row.id}: its call is no longer in the archive (or no longer a call in a one-to-one chat)`);
    }
    for (const row of db
      .prepare(
        `SELECT n.id, n.message_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE m.id = n.message_id AND m.type = 'call' AND c.type = 'direct')
           OR n.message_id IS NULL AND NOT EXISTS (SELECT 1 FROM call c WHERE c.platform = n.platform AND c.platform_call_id = n.platform_call_id) AS lost
         FROM call_answered n`,
      )
      .all() as { id: number; lost: number }[]) {
      if (row.lost) problems.push(`call answered #${row.id}: its call is no longer in the archive (or no longer a call in a one-to-one chat)`);
    }
    for (const draft of db.prepare("SELECT id, person_id, text FROM draft").all() as { id: number; person_id: number; text: string }[]) {
      try {
        if (normalizeDraft(draft.text) !== draft.text || draft.text === "") problems.push(`draft #${draft.id} (person ${draft.person_id}): it is not written the way the app writes drafts`);
      } catch (error) {
        problems.push(`draft #${draft.id} (person ${draft.person_id}): ${(error as Error).message}`);
      }
    }
    for (const row of db
      .prepare(
        `SELECT ip.id, ip.link_source FROM import_person ip LEFT JOIN person p ON p.id = ip.person_id
         WHERE p.id IS NULL OR NOT (ip.link_source IN ('import', 'captain') OR ip.link_source LIKE 'rule:%')`,
      )
      .all() as { id: number; link_source: string }[]) {
      problems.push(`account ${row.id}: it points at no person, or its link source "${row.link_source}" is unknown; \`npm run archive -- rules\` links it`);
    }
    return problems;
  }
}

interface PersonRow {
  id: number;
  name: string;
  name_source: string;
  aliases_json: string;
  note: string;
  should_reach_out: number;
  is_self: number;
  edited_at: number | null;
  archive_rule: string | null;
  identicon_seed: string | null;
  location: string | null;
}

/**
 * A person with no name because the import gave none (a deleted Messenger
 * account, say), whom the captain never named or edited and the rules archive:
 * not a problem. A blank name the captain set, or on anyone shown, is.
 */
function blankByImport(person: PersonRow, tags: string[]): boolean {
  if (person.name.trim() !== "" || person.name_source !== "import" || person.edited_at !== null) return false;
  const reason = archiveReason({ ...person, tags });
  return reason !== null && reason !== "you";
}

/**
 * A name the captain never set or edited is the platform's own, stray spaces and
 * all ("Haruki  Oda"), kept for the captain to review: it must not be empty, but
 * need not be trimmed or single-spaced.
 */
function asImported(person: PersonRow): boolean {
  return person.name_source === "import" && person.edited_at === null;
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}
