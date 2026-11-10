// The facts the static demo's shape is worked out from (MapFacts, GET /api/archive/map-facts): what friend-map's
// server/demo-shape.ts turns into the counts and distributions of src/demo/mapShape.ts, with the score report for
// closeness and the hangouts. Counts, times and person ids only, never a name, a tag, a title or a message.
//
// People shown and archived are told apart as the app tells them (archiveReason over their tags and stored rule);
// what the messages add up to per person comes from the stored counts (import_person_stats), the group chats, the
// calls and the activity by month from small SQL sums, and when relationships started, reactions and openings from
// the map's report (MessageDerived in structure.ts).

import type { Db, MapFacts, MapFactsPerson, PersonRelationship } from "../../../sdk/server.ts";
import { archiveReason } from "./archiving.ts";
import { PERSON_CALLS } from "./calls.ts";
import { Locations } from "./locations.ts";
import { Tags } from "./tags.ts";

interface PersonRow {
  id: number;
  is_self: number;
  edited_at: number | null;
  archive_rule: string | null;
  should_reach_out: number;
  location: string | null;
}

interface AccountRow {
  id: number;
  platform: string;
  person_id: number;
  is_self: number;
  direct: number;
  group: number;
  last: number | null;
  they_direct: number;
  you_direct: number;
}

/** What the map's report counts of each person's messages, by person id. */
export type ReportPeople = Array<Pick<PersonRelationship, "id" | "firstMessageAt" | "reactions" | "openings">>;

/** The facts of the archive in `db`, with the map's report of everyone's messages. */
export function mapFacts(db: Db, report: ReportPeople): MapFacts {
  const persons = db.prepare("SELECT id, is_self, edited_at, archive_rule, should_reach_out, location FROM person").all() as unknown as PersonRow[];
  const selfPeople = new Set(persons.filter((p) => p.is_self).map((p) => p.id));
  const accounts = db
    .prepare(
      `SELECT ip.id, ip.platform, ip.person_id, ip.is_self, coalesce(s.direct_count, 0) AS direct, coalesce(s.group_count, 0) AS "group",
         s.last_message_at AS last, coalesce(s.they_direct, 0) AS they_direct, coalesce(s.you_direct, 0) AS you_direct
       FROM import_person ip LEFT JOIN import_person_stats s ON s.import_person_id = ip.id WHERE ip.person_id IS NOT NULL`,
    )
    .all() as unknown as AccountRow[];
  const byPerson = new Map<number, AccountRow[]>();
  for (const account of accounts) byPerson.set(account.person_id, [...(byPerson.get(account.person_id) ?? []), account]);
  const selfAccounts = accounts.filter((a) => a.is_self || selfPeople.has(a.person_id)).map((a) => a.id);
  const tagsOf = new Tags(db).byPerson();
  const reported = new Map(report.map((person) => [person.id, person]));
  const groupsPerPerson = new Map((db
    .prepare(
      `SELECT ip.person_id, count(DISTINCT cm.conversation_id) AS n
       FROM conversation_member cm JOIN conversation c ON c.id = cm.conversation_id AND c.type = 'group' AND c.is_marketplace = 0
       JOIN import_person ip ON ip.id = cm.account_id GROUP BY ip.person_id`,
    )
    .all() as { person_id: number; n: number }[]).map((row) => [row.person_id, row.n]));

  // Everyone the app lists (as structure.ts's summaries: with an account, or edited), told apart as it tells them.
  const people: MapFactsPerson[] = [];
  const archived: MapFacts["archived"] = { byHand: 0, byRule: {} };
  for (const person of persons) {
    if (person.is_self) continue;
    const mine = byPerson.get(person.id) ?? [];
    if (mine.length === 0 && person.edited_at === null) continue;
    const tags = tagsOf.get(person.id) ?? [];
    const reason = archiveReason({ ...person, tags });
    if (reason === "you") archived.byHand++;
    else if (reason !== null) archived.byRule[reason] = (archived.byRule[reason] ?? 0) + 1;
    if (reason !== null) continue;
    const sum = (pick: (a: AccountRow) => number) => mine.reduce((n, a) => n + pick(a), 0);
    const last = Math.max(0, ...mine.map((a) => a.last ?? 0));
    const counted = reported.get(person.id);
    people.push({
      id: person.id,
      messages: sum((a) => a.direct + a.group),
      youDirect: sum((a) => a.you_direct),
      theyDirect: sum((a) => a.they_direct),
      lastMessageAt: last > 0 ? last : null,
      platforms: [...new Set(mine.map((a) => a.platform))],
      tags: tags.filter((tag) => tag !== "archive" && tag !== "keep").length,
      groups: groupsPerPerson.get(person.id) ?? 0,
      located: person.location !== null,
      reachOut: person.should_reach_out === 1,
      report: counted ? { firstMessageAt: counted.firstMessageAt, reactions: counted.reactions, openings: counted.openings } : null,
    });
  }
  const shown = new Set(people.map((person) => person.id));

  const platformMessages: Record<string, number> = {};
  for (const row of db.prepare("SELECT platform, count(*) AS n FROM message WHERE type != 'system' GROUP BY platform").all() as { platform: string; n: number }[]) {
    platformMessages[row.platform] = row.n;
  }

  // Group chats: size as listed, how many of them the map shows, messages, and the captain's share of them.
  const shownIn = new Map<number, Set<number>>();
  for (const row of db
    .prepare(
      `SELECT cm.conversation_id AS id, ip.person_id FROM conversation_member cm JOIN conversation c ON c.id = cm.conversation_id
       JOIN import_person ip ON ip.id = cm.account_id WHERE c.type = 'group' AND c.is_marketplace = 0 AND ip.person_id IS NOT NULL`,
    )
    .all() as { id: number; person_id: number }[]) {
    if (shown.has(row.person_id)) (shownIn.get(row.id) ?? shownIn.set(row.id, new Set()).get(row.id)!).add(row.person_id);
  }
  const groups = (db
    .prepare(
      `SELECT c.id, count(cm.account_id) AS size, c.title IS NOT NULL AND c.title != '' AS titled FROM conversation c
       JOIN conversation_member cm ON cm.conversation_id = c.id
       WHERE c.type = 'group' AND c.is_marketplace = 0 GROUP BY c.id`,
    )
    .all() as { id: number; size: number; titled: number }[]).map((g) => ({ size: g.size, titled: g.titled === 1, shown: shownIn.get(g.id)?.size ?? 0 }));
  const groupMessages = (db
    .prepare(
      `SELECT count(*) AS n, sum(m.is_from_self = 1 OR m.sender_account_id IN (SELECT value FROM json_each(:self))) AS mine,
         min(m.sent_at) AS first, max(m.sent_at) AS last
       FROM message m JOIN conversation c ON c.id = m.conversation_id
       WHERE c.type = 'group' AND c.is_marketplace = 0 AND m.type != 'system' GROUP BY m.conversation_id`,
    )
    .all({ self: JSON.stringify(selfAccounts) }) as { n: number; mine: number; first: number; last: number }[])
    .map((g) => ({ messages: g.n, mine: g.mine, first: g.first, last: g.last }));

  const months = (db
    .prepare("SELECT strftime('%Y-%m', sent_at / 1000, 'unixepoch') AS month, count(*) AS n FROM message WHERE type != 'system' GROUP BY month ORDER BY month")
    .all() as { month: string; n: number }[]).map((row) => ({ month: row.month, count: row.n }));

  const calls = (db.prepare(`SELECT person_id, at, answered, duration_seconds FROM (${PERSON_CALLS})`).all() as Array<{
    person_id: number; at: number; answered: number | null; duration_seconds: number | null;
  }>).filter((row) => shown.has(row.person_id))
    .map((row) => ({ personId: row.person_id, at: row.at, answered: row.answered === null ? null : row.answered === 1, durationSeconds: row.duration_seconds }));

  return {
    people,
    archived,
    platformMessages,
    locations: new Locations(db).list().length,
    groups,
    groupMessages,
    months,
    calls,
    tagPeople: new Tags(db).list().map((tag) => tag.count),
  };
}
