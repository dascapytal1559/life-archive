// Who is archived: off the map and every view, joined with anyone of exactly
// the same name of two words or more and proposed for a merge only on the same
// phone number (neither when archived by hand; see people.ts), still in People
// (under Archived), searchable, and with every message kept.
//
// The captain's choice always wins, and is kept in the person's tags:
//   tag "archive"   archived by hand, whatever the rules say
//   tag "keep"      never archived by the rules
// Otherwise a person the captain has edited (named, given aliases or tags, or
// merged; see people.ts) is shown, and anyone else is archived
// by the first rule that fits them, worked out from their messages on every
// platform (Marketplace chats count only as Marketplace):
//   unknown       every account is a deleted or unknown account ("Facebook user")
//   no-name       every account is known only by a phone number, an email, the
//                 short code or sender id it texts from or the platform's id for
//                 it, or by data a platform kept as a name ("COC7/7cGIAA=", see
//                 isUnnamed); a username such as Discord's or X's is a name
//   marketplace   their only chats are about something for sale on Marketplace
//   they-only     direct chats where only they wrote (requests, filtered chats)
//   you-only      direct chats where only the captain wrote, in a source that
//                 would hold their side
//   groups-wrote  they wrote in group chats, and have no direct chat
//   groups-silent they are in group chats and never wrote
//   no-messages   nothing either way
// which leaves everyone with a name and a direct chat where both of you wrote,
// everyone with a name the captain wrote to in a direct chat whose source holds
// only his side (Discord's data package: their silence there is not known, so
// it is not read as one-sided, and the chat counts as two-way),
// and everyone the two group rules would archive who is in a small group chat
// the captain wrote in at least once (twelve people or fewer, the captain
// included, see stats.ts), whether or not they wrote there. A small group he
// never wrote in (a spam group he was added to, say) keeps no one.
//
// The rules are worked out here from each import person's counts
// (import_person_stats, see stats.ts), when the rules run or a person's links
// change (see people.ts), and stored as person.archive_rule; loading reads them.

import { ARCHIVE_TAG, type ArchiveReason, type ArchiveRule, type Db, isEncodedName, isNumberName, isPlaceholderName, KEEP_TAG, normalizeHandle } from "../../../sdk/server.ts";
import { HIDDEN_BY_DEFAULT } from "./tags.ts";

/** What the rules read of a person: their messages on every platform, added up (see archiveRules; the static demo adds it up in the page). */
export interface Activity {
  theyDirect: number;
  theyGroup: number;
  youDirect: number;
  /** What the captain sent in direct chats with them whose source holds only his side (conversation.is_self_only). */
  youDirectSelfOnly: number;
  inDirect: boolean;
  inGroup: boolean;
  inMarketplace: boolean;
  inSmallGroup: boolean;
  allUnknown: boolean;
  allUnnamed: boolean;
}

/**
 * Whether an account has no name, only the address it writes from: a phone
 * number, an email, an SMS short code or sender id ("CommBank", "78787"), or a
 * platform's own id for it (an X, Signal or Discord user id). A connector that
 * finds no name keys such an account on that address and shows it by its key,
 * so an `id`-keyed account shown by its own key has no name; so does any name
 * that is a number or an email by shape, however it is typeset (see plainText
 * in names.ts), or an encoded message WhatsApp keeps in a name column
 * ("COC7/7cGIAA=", see isEncodedName).
 * A username or handle a person chose on an internet chat platform (Discord,
 * Telegram, X's "@ada_sample", Signal) is a name: it is never the account's key there
 * (that is the user id), so it is told apart from an address by not being the
 * key, and from a number or an email by its shape.
 * Deleted or unknown accounts are placeholders, not unnamed (the "unknown" rule).
 */
export function isUnnamed(account: { key: string; key_kind: string; display_name: string }): boolean {
  const name = account.display_name.trim();
  if (account.key_kind === "id" && name === account.key) return true;
  return isNumberName(name) || isEncodedName(name) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeHandle(name));
}

/**
 * The rule that archives each person (by person id), or null when none does:
 * every person but the captain, or just `personIds`. Read from the stored
 * counts, so it is quick enough to run whenever links change.
 */
export function archiveRules(db: Db, personIds?: number[]): Map<number, ArchiveRule | null> {
  const persons = personIds ?? (db.prepare("SELECT id FROM person WHERE is_self = 0").all() as { id: number }[]).map((r) => r.id);
  const wanted = new Set(persons);
  const activity = new Map<number, Activity>();
  const rows = db
    .prepare(
      `SELECT ip.person_id, ip.key, ip.key_kind, ip.display_name,
         coalesce(s.they_direct, 0) AS they_direct, coalesce(s.group_count, 0) AS they_group, coalesce(s.you_direct, 0) AS you_direct,
         coalesce(s.you_direct_self_only, 0) AS you_direct_self_only,
         coalesce(s.in_direct, 0) AS in_direct, coalesce(s.in_group, 0) AS in_group, coalesce(s.in_marketplace, 0) AS in_marketplace,
         coalesce(s.in_small_group, 0) AS in_small_group
       FROM import_person ip JOIN person p ON p.id = ip.person_id AND p.is_self = 0
       LEFT JOIN import_person_stats s ON s.import_person_id = ip.id
       WHERE ip.is_self = 0${personIds ? " AND ip.person_id IN (SELECT value FROM json_each(?))" : ""}`,
    )
    .all(...(personIds ? [JSON.stringify(personIds)] : [])) as Array<{
      person_id: number; key: string; key_kind: string; display_name: string;
      they_direct: number; they_group: number; you_direct: number; you_direct_self_only: number; in_direct: number; in_group: number; in_marketplace: number;
      in_small_group: number;
    }>;
  for (const row of rows) {
    if (!wanted.has(row.person_id)) continue;
    let entry = activity.get(row.person_id);
    if (!entry) {
      entry = { theyDirect: 0, theyGroup: 0, youDirect: 0, youDirectSelfOnly: 0, inDirect: false, inGroup: false, inMarketplace: false, inSmallGroup: false, allUnknown: true, allUnnamed: true };
      activity.set(row.person_id, entry);
    }
    if (!isPlaceholderName(row.display_name)) {
      entry.allUnknown = false;
      if (!isUnnamed(row)) entry.allUnnamed = false;
    }
    entry.theyDirect += row.they_direct;
    entry.theyGroup += row.they_group;
    entry.youDirect += row.you_direct;
    entry.youDirectSelfOnly += row.you_direct_self_only;
    if (row.in_marketplace) entry.inMarketplace = true;
    if (row.in_direct) entry.inDirect = true;
    if (row.in_group) entry.inGroup = true;
    if (row.in_small_group) entry.inSmallGroup = true;
  }
  return new Map(persons.map((id) => [id, ruleFor(activity.get(id))]));
}

/** The first rule that fits what a person did, or null when none does (they have a two-way direct chat, say). */
export function ruleFor(a: Activity | undefined): ArchiveRule | null {
  if (!a) return "no-messages";
  if (a.allUnknown) return "unknown";
  if (a.allUnnamed) return "no-name";
  if (a.theyDirect > 0 && a.youDirect > 0) return null;
  // Where the source cannot hold their side, the captain writing is all a two-way chat could show.
  if (a.youDirectSelfOnly > 0) return null;
  if (a.inMarketplace && !a.inDirect && !a.inGroup) return "marketplace";
  if (a.theyDirect > 0) return "they-only";
  if (a.youDirect > 0) return "you-only";
  if (a.inSmallGroup) return null;
  if (a.theyGroup > 0) return "groups-wrote";
  if (a.inGroup) return "groups-silent";
  return "no-messages";
}

/**
 * Whether a person is archived, and why: by hand (the "archive" tag), or by a rule,
 * unless they are the captain, tagged "keep", or edited by the captain.
 */
export function archiveReason(person: { is_self: number; edited_at: number | null; tags: string[]; archive_rule: string | null }): ArchiveReason | null {
  if (person.is_self) return null;
  if (person.tags.includes(ARCHIVE_TAG)) return "you";
  if (person.tags.includes(KEEP_TAG) || person.edited_at !== null) return null;
  return (person.archive_rule as ArchiveRule | null) ?? null;
}

/**
 * Of the people `ids`, those friend map's Hide leaves out as it starts (src/demos/hideChoices.ts's HIDDEN_BY_DEFAULT):
 * the archived (by hand or by the rules) and anyone with a tag Hide starts on; the Events calendar's lists of people
 * leave them out until its switch shows them (calendarRows.ts's owner, `hiddenPeople`).
 */
export function hiddenAmong(db: Db, ids: readonly number[]): number[] {
  if (ids.length === 0) return [];
  const list = JSON.stringify(ids);
  const tags = new Map<number, string[]>();
  for (const row of db
    .prepare("SELECT pt.person_id AS id, t.name FROM person_tag pt JOIN tag t ON t.id = pt.tag_id WHERE pt.person_id IN (SELECT value FROM json_each(?))")
    .all(list) as Array<{ id: number; name: string }>) tags.set(row.id, [...(tags.get(row.id) ?? []), row.name]);
  return (db.prepare("SELECT id, is_self, edited_at, archive_rule FROM person WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id").all(list) as
    Array<{ id: number; is_self: number; edited_at: number | null; archive_rule: string | null }>)
    .filter((person) => {
      const own = tags.get(person.id) ?? [];
      return archiveReason({ ...person, tags: own }) !== null || own.some((tag) => HIDDEN_BY_DEFAULT.includes(tag));
    })
    .map((person) => person.id);
}
