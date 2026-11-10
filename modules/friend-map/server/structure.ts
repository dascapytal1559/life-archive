// The archive's structure read path: people, accounts, counts, dates,
// proposals and coverage. It never selects message text or original records
// (`message.text`, `message.raw_json`, `message_version`, `message_fts`); those
// are reachable only through content.ts, so organising and building work can
// be done with this path alone.
//
// Marketplace chats (conversation.is_marketplace) count in no person's numbers
// here: not in message counts, last spoke, months or openings, and not as
// group chats. Each person's own Marketplace messages are counted apart
// (PersonSummary.marketplaceMessageCount).
//
// A group chat the captain dropped (conversation.dropped_at, see
// People.dropGroup) links nobody: it is in no one's groups, no shared group
// or closeness, no count, and no query or group listing. Its messages stay,
// and its header (group) still opens, so it can be read. Someone the captain
// took out of a group they never wrote in (conversation_member.removed_at, see
// People.removeFromGroup) is no member of it here: not in its size, its
// members, their groups, shared groups or closeness. Someone the captain
// unlinked from a group (group_unlink, see People.unlinkFromGroup) is still a
// member of it, in its size, their groups and closeness alike; the report only
// lists them (unlinks), so the page links them to nobody through it.
//
// Loading people is a join: each person, the import people that point at
// them, and each import person's stored counts (import_person_stats, see
// stats.ts); nothing here scans the messages except relationships(), whose
// message-derived part is kept (in the derived table) until links or messages
// change, so the map loads without the scan.

import { type AccountSummary, countsByPlatform, type CoverageReport, daysBetween, type Db, type GroupChat, type GroupMember, type GroupMembership, type GroupPerson, identiconSeedOf, isPlaceholderName, type LinkSource, type MapFacts, type MergeProposal, type MessageApps, type MessageCounts, monthKey, NAMED_BY, nameKey, type PeopleListing, type PersonCall, type PersonGroup, type PersonRelationship, type PersonSummary, platformsOf, type RelationshipsReport, type ScoreReport, type TableRow, tagsWithRule } from "../../../sdk/server.ts";
import { archiveReason } from "./archiving.ts";
import { callCounts, callDays, callsOf } from "./calls.ts";
import { firstContacts } from "./firstContact.ts";
import { mapFacts } from "./mapFacts.ts";
import type { People, PersonRow } from "./people.ts";
import { normalizeTag } from "./personFields.ts";
import type { QueryPerson, QueryVocabulary } from "./query.ts";

/** A stretch without coverage shorter than this is not reported as a gap. */
const GAP_THRESHOLD_MS = 2 * 86_400_000;

/** A direct message after this many quiet days reopens the conversation (RelationshipsReport.openings). */
const REOPEN_AFTER_DAYS = 14;

interface AccountRow {
  id: number;
  platform: string;
  display_name: string;
  handle: string | null;
  person_id: number;
  link_source: LinkSource;
  direct: number;
  group: number;
  marketplace: number;
  last: number | null;
}

/** What relationships() works out from the messages, per person and group; kept until links or messages change. */
interface MessageDerived {
  people: Array<Omit<PersonRelationship, "name" | "aliases" | "tags" | "note" | "shouldReachOut" | "identiconSeed" | "identiconHue" | "location" | "unknown" | "platforms">>;
  groups: GroupMembership[];
  /** The same messages per person by app and month (messageApps), apart, so the map's report does not carry them. */
  apps: MessageApps[];
}

/** The captain's own accounts, as a WITH clause named self_account. */
const SELF_ACCOUNTS = `self_account AS (SELECT ip.id FROM import_person ip JOIN person p ON p.id = ip.person_id WHERE ip.is_self = 1 OR p.is_self = 1)`;
/** A message the captain sent (with SELF_ACCOUNTS in scope). */
const FROM_SELF = `m.type != 'system' AND (m.is_from_self = 1 OR m.sender_account_id IN (SELECT id FROM self_account))`;
/** The accounts in each group of :ids (a JSON array): its listed members, and anyone who wrote there. */
const GROUP_ACCOUNTS = `SELECT conversation_id, account_id FROM conversation_member
  WHERE conversation_id IN (SELECT value FROM json_each(:ids)) AND removed_at IS NULL
  UNION
  SELECT conversation_id, sender_account_id FROM message
  WHERE conversation_id IN (SELECT value FROM json_each(:ids)) AND sender_account_id IS NOT NULL AND type != 'system'`;

export class ArchiveStructure {
  private readonly db: Db;
  private readonly people: People;
  private derived: { stamp: string; value: MessageDerived } | null = null;

  constructor(db: Db, people: People) {
    this.db = db;
    this.people = people;
  }

  /**
   * Everyone (with a tag, to be reached out to, or at a location (matched but for case), or whose
   * names, note, location or accounts match the query, when asked), and every tag in
   * use, in the tag order.
   */
  listPeople(filter: { query?: string; tag?: string; reachOut?: boolean; location?: string } = {}): PeopleListing {
    const all = this.summaries(filter.reachOut ? this.people.toReachOut() : undefined);
    const self = this.db.prepare("SELECT id FROM person WHERE is_self = 1 ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    const query = nameKey(filter.query ?? "");
    const tag = filter.tag ? tagAsWritten(filter.tag) : undefined;
    const atLocation = filter.location ? this.people.locations.holders(filter.location) : null;
    const people = all.filter(
      (person) =>
        (!tag || person.tags.includes(tag)) &&
        (!atLocation || atLocation.has(person.id)) &&
        (!query ||
          [person.name, ...person.aliases].some((name) => nameKey(name).includes(query)) ||
          nameKey(person.note).includes(query) ||
          nameKey(person.location ?? "").includes(query) ||
          person.accounts.some((a) => nameKey(a.displayName).includes(query) || a.handle?.includes(filter.query!.trim()))),
    );
    return {
      people,
      me: self ? (this.summaries([self.id], { includeSelf: true })[0] ?? null) : null,
      tags: this.people.tags.list().filter((t) => t.count > 0).map((t) => ({ tag: t.name, count: t.count })),
    };
  }

  /** The person; null if there is none (a merge deletes the person merged away). */
  getPerson(id: number): PersonSummary | null {
    return this.summaries([id], { includeSelf: true })[0] ?? null;
  }

  /** Their calls (the phone's call history), newest first, with `accountId` only that account's; null if there is no such person. */
  calls(id: number, accountId?: number): PersonCall[] | null {
    if (!this.getPerson(id)) return null;
    return callsOf(this.db, id, accountId);
  }

  /**
   * The group chats a person is in, listed as a member or having written there, with how many people are in each,
   * what they and the captain sent there, its last message, and whether the captain unlinked them from it; the latest
   * first. An untitled group comes with the first few people in it to name it by. Null if there is no such person.
   */
  groupsOf(id: number): PersonGroup[] | null {
    if (!this.getPerson(id)) return null;
    const rows = this.db
      .prepare(
        `WITH theirs AS (SELECT id FROM import_person WHERE person_id = :person),
         ${SELF_ACCOUNTS},
         joined AS (
           SELECT conversation_id AS id FROM conversation_member WHERE account_id IN (SELECT id FROM theirs) AND removed_at IS NULL
           UNION
           SELECT conversation_id FROM message WHERE sender_account_id IN (SELECT id FROM theirs)
         )
         SELECT c.id, c.title, c.platform,
           (SELECT count(*) FROM message m WHERE m.conversation_id = c.id AND m.type != 'system'
              AND m.sender_account_id IN (SELECT id FROM theirs)) AS from_them,
           (SELECT count(*) FROM message m WHERE m.conversation_id = c.id AND ${FROM_SELF}) AS from_me,
           (SELECT max(m.sent_at) FROM message m WHERE m.conversation_id = c.id AND m.type != 'system') AS last,
           EXISTS (SELECT 1 FROM group_unlink u WHERE u.person_id = :person AND u.conversation_id = c.id) AS unlinked
         FROM conversation c JOIN joined ON joined.id = c.id
         WHERE c.type = 'group' AND c.is_marketplace = 0 AND c.dropped_at IS NULL`,
      )
      .all({ person: id }) as { id: number; title: string | null; platform: string; from_them: number; from_me: number; last: number | null; unlinked: number }[];
    if (rows.length === 0) return [];
    const size = this.groupSizes(rows.map((row) => row.id));
    // Only the untitled ones need their people, and only the first few.
    const members = this.groupMembers(rows.filter((row) => row.title === null).map((row) => row.id));
    return rows
      .map((row) => ({
        id: row.id,
        title: row.title,
        platform: row.platform,
        people: size.get(row.id)!,
        fromThem: row.from_them,
        fromMe: row.from_me,
        lastMessageAt: row.last,
        namedBy: (members.get(row.id) ?? []).slice(0, NAMED_BY).map(({ id, name, aliases }) => ({ id, name, aliases })),
        unlinked: row.unlinked === 1,
      }))
      .sort((a, b) => (b.lastMessageAt ?? -Infinity) - (a.lastMessageAt ?? -Infinity) || a.id - b.id);
  }

  /**
   * One group chat, for its header in a person's panel: its title, platform and size (as groupsOf counts it),
   * everyone in it but the captain with what each sent there, what the captain sent, and its first and last message.
   * Null for anything else: a direct or Marketplace chat, or no such chat.
   */
  group(id: number): GroupChat | null {
    const row = this.db
      .prepare(
        `WITH ${SELF_ACCOUNTS}
         SELECT c.id, c.title, c.platform,
           (SELECT count(*) FROM message m WHERE m.conversation_id = c.id AND m.type != 'system') AS messages,
           (SELECT count(*) FROM message m WHERE m.conversation_id = c.id AND ${FROM_SELF}) AS from_me,
           (SELECT min(m.sent_at) FROM message m WHERE m.conversation_id = c.id AND m.type != 'system') AS first,
           (SELECT max(m.sent_at) FROM message m WHERE m.conversation_id = c.id AND m.type != 'system') AS last
         FROM conversation c WHERE c.id = ? AND c.type = 'group' AND c.is_marketplace = 0`,
      )
      .get(id) as { id: number; title: string | null; platform: string; messages: number; from_me: number; first: number | null; last: number | null } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      platform: row.platform,
      people: this.groupSizes([id]).get(id)!,
      members: this.standing(this.groupMembers([id]).get(id) ?? []),
      fromMe: row.from_me,
      messageCount: row.messages,
      firstMessageAt: row.first,
      lastMessageAt: row.last,
    };
  }

  /** Group members with whether each is untouched and archived, which "Archive untouched" goes by. */
  private standing(members: Array<GroupPerson & { messages: number }>): GroupMember[] {
    const ids = members.map((member) => member.id);
    const untouched = this.people.untouched(ids);
    const tagsOf = this.people.tags.byPerson(ids);
    const rows = new Map((this.db.prepare("SELECT * FROM person WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as unknown as PersonRow[])
      .map((row) => [row.id, row]));
    return members.map((member) => ({
      ...member,
      untouched: untouched.has(member.id),
      archived: archiveReason({ ...rows.get(member.id)!, tags: tagsOf.get(member.id) ?? [] }) !== null,
    }));
  }

  /**
   * Each group's size, the captain included: its listed members with anyone who wrote there, as the archive rules
   * count it (see stats.ts), so a deleted or unknown account keyed on its name counts as one, though it may stand
   * for several.
   */
  groupSizes(ids: number[]): Map<number, number> {
    const counts = this.db
      .prepare(
        `SELECT gp.conversation_id, count(*) AS n FROM (${GROUP_ACCOUNTS}) gp
         JOIN import_person ip ON ip.id = gp.account_id LEFT JOIN person p ON p.id = ip.person_id
         WHERE ip.is_self = 0 AND coalesce(p.is_self, 0) = 0
         GROUP BY gp.conversation_id`,
      )
      .all({ ids: JSON.stringify(ids) }) as { conversation_id: number; n: number }[];
    const others = new Map(counts.map((row) => [row.conversation_id, row.n]));
    return new Map(ids.map((group) => [group, 1 + (others.get(group) ?? 0)]));
  }

  /**
   * Everyone in each group but the captain, as people (two accounts of one person are one member), with what each
   * sent there: the most first, then by name. What they sent is counted in one pass over each group's messages.
   */
  groupMembers(ids: number[]): Map<number, Array<GroupPerson & { messages: number }>> {
    const out = new Map<number, Array<GroupPerson & { messages: number }>>();
    if (ids.length === 0) return out;
    const args = { ids: JSON.stringify(ids) };
    const people = this.db
      .prepare(
        `SELECT DISTINCT gp.conversation_id, p.id, p.name, p.aliases_json FROM (${GROUP_ACCOUNTS}) gp
         JOIN import_person ip ON ip.id = gp.account_id JOIN person p ON p.id = ip.person_id
         WHERE ip.is_self = 0 AND p.is_self = 0`,
      )
      .all(args) as { conversation_id: number; id: number; name: string; aliases_json: string }[];
    const sent = this.db
      .prepare(
        `SELECT m.conversation_id, ip.person_id, count(*) AS n FROM message m JOIN import_person ip ON ip.id = m.sender_account_id
         WHERE m.conversation_id IN (SELECT value FROM json_each(:ids)) AND m.type != 'system'
         GROUP BY m.conversation_id, ip.person_id`,
      )
      .all(args) as { conversation_id: number; person_id: number; n: number }[];
    const counts = new Map(sent.map((row) => [`${row.conversation_id}:${row.person_id}`, row.n]));
    for (const person of people) {
      const list = out.get(person.conversation_id) ?? [];
      list.push({
        id: person.id,
        name: person.name,
        aliases: JSON.parse(person.aliases_json) as string[],
        messages: counts.get(`${person.conversation_id}:${person.id}`) ?? 0,
      });
      out.set(person.conversation_id, list);
    }
    for (const list of out.values()) list.sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name) || a.id - b.id);
    return out;
  }

  proposals(): MergeProposal[] {
    const groups = this.people.proposalGroups();
    const ids = [...new Set(groups.flatMap((g) => g.personIds))];
    const byId = new Map(this.summaries(ids).map((person) => [person.id, person]));
    return groups.flatMap((group) => {
      const a = byId.get(group.personIds[0]);
      const b = byId.get(group.personIds[1]);
      if (!a || !b) return [];
      // The side the captain has edited first, then the one with more messages.
      const people: [PersonSummary, PersonSummary] =
        (b.edited && !a.edited) || (!a.edited && !b.edited && b.messageCount > a.messageCount) ? [b, a] : [a, b];
      return [{ id: group.id, tier: group.tier, evidence: group.evidence, people }];
    });
  }

  coverage(now = Date.now()): CoverageReport {
    const platforms = (this.db.prepare("SELECT DISTINCT platform FROM import_person ORDER BY platform").all() as { platform: string }[])
      .map(({ platform }) => platform);
    return {
      generatedAt: now,
      platforms: platforms.map((platform) => {
        const stats = this.db
          .prepare("SELECT count(*) AS n, min(sent_at) AS first, max(sent_at) AS last FROM message WHERE platform = ?")
          .get(platform) as { n: number; first: number | null; last: number | null };
        const months = new Map<string, number>();
        for (const { sent_at } of this.db.prepare("SELECT sent_at FROM message WHERE platform = ?").iterate(platform) as
          Iterable<{ sent_at: number }>) {
          const month = monthKey(sent_at);
          months.set(month, (months.get(month) ?? 0) + 1);
        }
        const spans = this.spans(platform);
        const lastImport = this.db
          .prepare(
            `SELECT finished_at AS at, label, kind FROM source
             WHERE platform = ? AND status = 'ok' ORDER BY finished_at DESC LIMIT 1`,
          )
          .get(platform) as { at: number; label: string; kind: string } | undefined;
        return {
          platform,
          messageCount: stats.n,
          firstMessageAt: stats.first,
          lastMessageAt: stats.last,
          silentDays: stats.last === null ? null : daysBetween(stats.last, now),
          spans,
          gaps: gapsBetween(spans),
          lastImport: lastImport ?? null,
          months: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => ({ month, count })),
        };
      }),
    };
  }

  /**
   * Everyone's relationship with the captain in numbers, for the map views:
   * who sent how much where, by month, reactions, who reopens quiet
   * conversations, and which group chats people share, with who wrote how
   * much in each by month (for the closeness score). Reads message metadata
   * only (conversation, sender, time, type), never text. The counts are worked
   * out once per state of links and messages (links_version, bumped by the
   * rules and by every link the captain changes) and kept; names, tags and
   * archive state are read fresh each time. Archived people are only counted,
   * but for those in `archived` (the ones the map's Hide shows): they are most
   * of the archive, and leaving them out keeps the report small. Tags carry
   * "archive" for the rules' archive too, as the Table's do. Every catch-up
   * is in it, read fresh, for the closeness score.
   */
  /**
   * Everyone's messages by app (the platform of the chat they were in) and local month, counted as a map view
   * counts them: one-to-one both ways, and theirs in group chats. Archived people too; only people with any.
   * Structure only, for the Time river's App filter.
   */
  messageApps(): MessageApps[] {
    return this.messageDerived().apps;
  }

  relationships(now = Date.now(), archived: ReadonlySet<number> = new Set()): RelationshipsReport {
    const derived = this.messageDerived();
    const counts = new Map(derived.people.map((entry) => [entry.id, entry]));
    const everyone = this.summaries();
    const shown = everyone.filter((person) => person.archived === null || archived.has(person.id));
    return {
      generatedAt: now,
      gapDays: REOPEN_AFTER_DAYS,
      archivedCount: everyone.filter((person) => person.archived !== null).length,
      people: shown.map((person): PersonRelationship => ({
        ...(counts.get(person.id) ?? {
          id: person.id,
          totals: emptyCounts(),
          firstMessageAt: null,
          lastMessageAt: null,
          months: [],
          reactions: { fromMe: 0, fromThem: 0 },
          openings: { byMe: 0, byThem: 0 },
        }),
        name: person.name,
        aliases: person.aliases,
        tags: tagsWithRule(person),
        note: person.note,
        shouldReachOut: person.shouldReachOut,
        identiconSeed: person.identiconSeed,
        identiconHue: person.identiconHue,
        location: person.location,
        unknown: person.unknown,
        platforms: platformsOf(person.accounts),
      })),
      groups: derived.groups,
      unlinks: this.people.groupUnlinks(),
      catchUps: this.people.catchUps.scored(),
      callDays: callDays(this.db),
    };
  }

  /**
   * What friend-map works out closeness and a person's activity from (ScoreReport): everyone's messages by month
   * (archived people too), the group chats, the catch-ups and the calls, with anyone at a catch-up or on a call who has
   * no messages (someone added by hand, say) as a person with no months. Facts only: the scoring is friend-map's
   * (server/methodology.ts). Whatever it holds changes only with people.version() or linksVersion().
   */
  scoreReport(now = Date.now()): ScoreReport {
    const derived = this.messageDerived();
    const catchUps = this.people.catchUps.scored();
    const calls = callDays(this.db);
    const counted = new Set(derived.people.map((person) => person.id));
    const others = [...new Set([...catchUps.flatMap((c) => c.personIds), ...calls.map((c) => c.personId)])]
      .filter((id) => !counted.has(id)).map((id) => ({ id, months: [] }));
    return { generatedAt: now, people: [...derived.people.map(({ id, months }) => ({ id, months })), ...others], groups: derived.groups, catchUps, callDays: calls };
  }

  /** The facts the static demo's shape is worked out from (MapFacts, mapFacts.ts), with the map's report of the messages. */
  mapFacts(): MapFacts {
    return mapFacts(this.db, this.messageDerived().people);
  }

  /**
   * Everyone, archived people included, as one light row each for the Table
   * view: what People lists, less the accounts (only their platforms and each
   * platform's counts), with when they were added and first in touch (firstContact.ts).
   * friend-map adds each one's closeness (server/methodology.ts).
   */
  tableRows(): TableRow[] {
    const callsBy = callCounts(this.db);
    const firstBy = firstContacts(this.db);
    const added = new Map((this.db.prepare("SELECT id, created_at FROM person").all() as { id: number; created_at: number }[]).map((p) => [p.id, p.created_at]));
    return this.summaries().map((person) => ({
      id: person.id,
      name: person.name,
      aliases: person.aliases,
      tags: tagsWithRule(person),
      note: person.note,
      identiconSeed: person.identiconSeed,
      identiconHue: person.identiconHue,
      location: person.location,
      unknown: person.unknown,
      untouched: person.untouched,
      archived: person.archived,
      platforms: platformsOf(person.accounts),
      messageCount: person.messageCount,
      directMessageCount: person.directMessageCount,
      groupMessageCount: person.groupMessageCount,
      lastMessageAt: person.lastMessageAt,
      byPlatform: countsByPlatform(person.accounts),
      calls: callsBy.get(person.id) ?? null,
      addedAt: added.get(person.id)!,
      firstContactAt: firstBy.get(person.id) ?? null,
    }));
  }

  /**
   * What a query (query.ts) runs over: everyone, archived people too (each
   * view's Hide then leaves out whom it hides), and what there is to ask for: every tag in the tag table, and each field's
   * values: every location someone is at, the platforms
   * anyone has an account on; and the group chats, whose people are found only
   * for the chats a query names (as the group's header lists them).
   */
  queryable(): { people: QueryPerson[]; vocabulary: QueryVocabulary } {
    const everyone = this.summaries().map((person): QueryPerson => ({
      id: person.id,
      tags: person.tags,
      archived: person.archived,
      shouldReachOut: person.shouldReachOut,
      fields: { location: person.location ? [person.location] : [], platform: platformsOf(person.accounts) },
      messageCount: person.messageCount,
      directMessageCount: person.directMessageCount,
      groupMessageCount: person.groupMessageCount,
      lastMessageAt: person.lastMessageAt,
    }));
    return {
      people: everyone,
      vocabulary: {
        tags: this.people.tags.list().map((tag) => tag.name),
        fields: { location: this.people.locations.list().map((value) => value.name), platform: [...new Set(everyone.flatMap((person) => person.fields.platform))] },
        groups: {
          list: this.db.prepare("SELECT id, title FROM conversation WHERE type = 'group' AND is_marketplace = 0 AND dropped_at IS NULL ORDER BY id").all() as
            Array<{ id: number; title: string | null }>,
          members: (ids) => new Set([...this.groupMembers([...ids]).values()].flatMap((members) => members.map((m) => m.id))),
        },
      },
    };
  }

  /**
   * The group chats whose title has these words (nameKey, as People's search
   * matches names), or every one: its number (for a query's group:#ID), title,
   * platform, size as its header counts it, and last message; the latest first.
   * An untitled one comes with the first few people in it, to name it by.
   * With `dropped`, the group chats the captain dropped instead.
   */
  findGroups(words = "", { dropped = false } = {}): Array<Omit<PersonGroup, "fromThem" | "fromMe" | "unlinked">> {
    const wanted = nameKey(words);
    const rows = (this.db
      .prepare(
        `SELECT c.id, c.title, c.platform,
           (SELECT max(m.sent_at) FROM message m WHERE m.conversation_id = c.id AND m.type != 'system') AS last
         FROM conversation c WHERE c.type = 'group' AND c.is_marketplace = 0 AND c.dropped_at IS ${dropped ? "NOT " : ""}NULL`,
      )
      .all() as { id: number; title: string | null; platform: string; last: number | null }[])
      .filter((row) => !wanted || (row.title !== null && nameKey(row.title).includes(wanted)));
    const size = this.groupSizes(rows.map((row) => row.id));
    const members = this.groupMembers(rows.filter((row) => row.title === null).map((row) => row.id));
    return rows
      .map((row) => ({
        id: row.id,
        title: row.title,
        platform: row.platform,
        people: size.get(row.id)!,
        lastMessageAt: row.last,
        namedBy: (members.get(row.id) ?? []).slice(0, NAMED_BY).map(({ id, name, aliases }) => ({ id, name, aliases })),
      }))
      .sort((a, b) => (b.lastMessageAt ?? -Infinity) - (a.lastMessageAt ?? -Infinity) || a.id - b.id);
  }

  /** Everyone the captain took out of a group chat (People.removeFromGroup), with the group's number and title; the latest first. */
  removedMembers(): Array<{ groupId: number; title: string | null; personId: number; name: string; removedAt: number }> {
    return this.db
      .prepare(
        `SELECT c.id AS groupId, c.title, p.id AS personId, p.name, max(cm.removed_at) AS removedAt
         FROM conversation_member cm JOIN conversation c ON c.id = cm.conversation_id
         JOIN import_person ip ON ip.id = cm.account_id JOIN person p ON p.id = ip.person_id
         WHERE cm.removed_at IS NOT NULL
         GROUP BY c.id, p.id ORDER BY removedAt DESC, c.id, p.id`,
      )
      .all() as Array<{ groupId: number; title: string | null; personId: number; name: string; removedAt: number }>;
  }

  /** The message-derived part of relationships(), from memory, the derived table, or worked out and stored. */
  private messageDerived(): MessageDerived {
    const stamp = `relationships-5:${this.people.linksVersion()}`;
    if (this.derived?.stamp === stamp) return this.derived.value;
    const stored = this.db.prepare("SELECT json FROM derived WHERE key = 'relationships' AND stamp = ?").get(stamp) as { json: string } | undefined;
    const value = stored ? (JSON.parse(stored.json) as MessageDerived) : this.computeMessageDerived();
    if (!stored) {
      this.db
        .prepare("INSERT INTO derived (key, stamp, json) VALUES ('relationships', ?, ?) ON CONFLICT (key) DO UPDATE SET stamp = excluded.stamp, json = excluded.json")
        .run(stamp, JSON.stringify(value));
    }
    this.derived = { stamp, value };
    return value;
  }

  private computeMessageDerived(): MessageDerived {
    const persons = this.db.prepare("SELECT id FROM person WHERE is_self = 0").all() as { id: number }[];
    const people = new Map(persons.map(({ id }) => [id, {
      person: { id },
      totals: emptyCounts(),
      months: new Map<string, MessageCounts>(),
      first: null as number | null,
      last: null as number | null,
      reactions: { fromMe: 0, fromThem: 0 },
      openings: { byMe: 0, byThem: 0 },
      lastDirect: null as number | null,
      /** Messages as a map view counts them (direct both ways, theirs in groups), by app, then month. */
      apps: new Map<string, Map<string, number>>(),
    }]));
    type Entry = NonNullable<ReturnType<typeof people.get>>;

    const selfPeople = new Set((this.db.prepare("SELECT id FROM person WHERE is_self = 1").all() as { id: number }[]).map((r) => r.id));
    const accountPerson = new Map((this.db
      .prepare("SELECT id, person_id, is_self FROM import_person")
      .all() as { id: number; person_id: number | null; is_self: number }[])
      .map((a) => [a.id, a.is_self ? "self" as const : a.person_id]));
    const isSelf = (account: number | null) => {
      const person = account === null ? null : accountPerson.get(account);
      return person === "self" || (typeof person === "number" && selfPeople.has(person));
    };
    const entryFor = (account: number | null): Entry | undefined => {
      const person = account === null ? null : accountPerson.get(account);
      return typeof person === "number" ? people.get(person) : undefined;
    };

    // Conversation -> the people in it (for a direct chat, the one other person).
    const conversations = new Map<number, { type: "direct" | "group"; platform: string; selfOnly: boolean; members: Set<Entry> }>();
    for (const row of this.db
      .prepare(
        `SELECT c.id, c.type, c.platform, c.is_self_only, cm.account_id FROM conversation c JOIN conversation_member cm ON cm.conversation_id = c.id
         WHERE c.is_marketplace = 0 AND c.dropped_at IS NULL AND cm.removed_at IS NULL`,
      )
      .all() as { id: number; type: "direct" | "group"; platform: string; is_self_only: number; account_id: number }[]) {
      const conversation = conversations.get(row.id) ?? { type: row.type, platform: row.platform, selfOnly: row.is_self_only === 1, members: new Set<Entry>() };
      const entry = isSelf(row.account_id) ? undefined : entryFor(row.account_id);
      if (entry) conversation.members.add(entry);
      conversations.set(row.id, conversation);
    }
    const groupStats = new Map<number, {
      messageCount: number;
      lastMessageAt: number | null;
      months: Map<string, { messages: number; fromMe: number; fromMembers: Map<number, number> }>;
    }>();

    const count = (entry: Entry, at: number, field: keyof MessageCounts, involvesThem: boolean) => {
      entry.totals[field]++;
      const month = monthKey(at);
      const counts = entry.months.get(month) ?? emptyCounts();
      counts[field]++;
      entry.months.set(month, counts);
      // What the captain says to a group isn't talking with each member, so it doesn't date the relationship.
      if (involvesThem) {
        entry.first ??= at;
        entry.last = at;
      }
    };
    const tally = (entry: Entry, platform: string, at: number) => {
      const months = entry.apps.get(platform) ?? new Map<string, number>();
      const month = monthKey(at);
      months.set(month, (months.get(month) ?? 0) + 1);
      entry.apps.set(platform, months);
    };
    const gap = REOPEN_AFTER_DAYS * 86_400_000;
    for (const message of this.db
      .prepare(
        `SELECT conversation_id, sender_account_id, is_from_self, sent_at, type = 'call' AS call FROM message
         WHERE sender_account_id IS NOT NULL AND type != 'system' ORDER BY sent_at`,
      )
      .iterate() as Iterable<{ conversation_id: number; sender_account_id: number; is_from_self: number; sent_at: number; call: number }>) {
      const conversation = conversations.get(message.conversation_id);
      if (!conversation) continue;
      // A call in a one-to-one chat counts as a call, by its length when that is known (calls.ts, callDays), not as a message.
      if (message.call && conversation.type === "direct") continue;
      const fromMe = message.is_from_self === 1 || isSelf(message.sender_account_id);
      const at = message.sent_at;
      if (conversation.type === "direct") {
        for (const entry of conversation.members) {
          count(entry, at, fromMe ? "directFromMe" : "directFromThem", true);
          tally(entry, conversation.platform, at);
          if (fromMe && conversation.selfOnly) count(entry, at, "directFromMeSelfOnly", true);
          if (entry.lastDirect !== null && at - entry.lastDirect >= gap) entry.openings[fromMe ? "byMe" : "byThem"]++;
          entry.lastDirect = at;
        }
      } else {
        const stats = groupStats.get(message.conversation_id) ?? { messageCount: 0, lastMessageAt: null, months: new Map() };
        stats.messageCount++;
        stats.lastMessageAt = at;
        groupStats.set(message.conversation_id, stats);
        const month = monthKey(at);
        const inMonth = stats.months.get(month) ?? { messages: 0, fromMe: 0, fromMembers: new Map<number, number>() };
        inMonth.messages++;
        stats.months.set(month, inMonth);
        if (fromMe) {
          inMonth.fromMe++;
          for (const entry of conversation.members) count(entry, at, "groupFromMe", false);
        } else {
          const sender = entryFor(message.sender_account_id);
          if (sender) {
            count(sender, at, "groupFromThem", true);
            tally(sender, conversation.platform, at);
            inMonth.fromMembers.set(sender.person.id, (inMonth.fromMembers.get(sender.person.id) ?? 0) + 1);
          }
        }
      }
    }

    for (const reaction of this.db
      .prepare(
        `SELECT r.actor_account_id AS actor, m.sender_account_id AS sender, m.is_from_self AS fromSelf
         FROM reaction r JOIN message m ON m.id = r.message_id`,
      )
      .all() as { actor: number; sender: number | null; fromSelf: number }[]) {
      const messageFromMe = reaction.fromSelf === 1 || isSelf(reaction.sender);
      if (isSelf(reaction.actor)) {
        const them = messageFromMe ? undefined : entryFor(reaction.sender);
        if (them) them.reactions.fromMe++;
      } else if (messageFromMe) {
        const them = entryFor(reaction.actor);
        if (them) them.reactions.fromThem++;
      }
    }

    const groups: GroupMembership[] = [];
    for (const [id, conversation] of conversations) {
      if (conversation.type !== "group" || conversation.members.size === 0) continue;
      const stats = groupStats.get(id);
      groups.push({
        id,
        memberIds: [...conversation.members].map((entry) => entry.person.id).sort((a, b) => a - b),
        selfOnly: conversation.selfOnly,
        messageCount: stats?.messageCount ?? 0,
        lastMessageAt: stats?.lastMessageAt ?? null,
        months: [...(stats?.months ?? [])].sort(([a], [b]) => a.localeCompare(b)).map(([month, counts]) => ({
          month,
          messages: counts.messages,
          fromMe: counts.fromMe,
          fromMembers: [...counts.fromMembers].sort(([a], [b]) => a - b).map(([id, count]) => ({ id, count })),
        })),
      });
    }

    return {
      people: [...people.values()].map((entry) => ({
        id: entry.person.id,
        totals: entry.totals,
        firstMessageAt: entry.first,
        lastMessageAt: entry.last,
        months: [...entry.months].sort(([a], [b]) => a.localeCompare(b)).map(([month, counts]) => ({ month, ...counts })),
        reactions: entry.reactions,
        openings: entry.openings,
      })),
      groups: groups.sort((a, b) => b.messageCount - a.messageCount || a.id - b.id),
      apps: [...people.values()].filter((entry) => entry.apps.size > 0).map((entry) => ({
        id: entry.person.id,
        apps: [...entry.apps].sort(([a], [b]) => a.localeCompare(b)).map(([platform, months]) => ({
          platform,
          months: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, messages]) => ({ month, messages })),
        })),
      })),
    };
  }

  /** Covered stretches for a platform, overlapping spans joined, by kind of source. */
  private spans(platform: string): Array<{ from: number; to: number; kind: string }> {
    // Platform-wide claims when there are any; otherwise what the per-conversation claims add up to.
    const wide = this.db
      .prepare("SELECT from_ms, to_ms, kind FROM coverage_span WHERE platform = ? AND conversation_id IS NULL ORDER BY from_ms")
      .all(platform) as { from_ms: number; to_ms: number; kind: string }[];
    const rows = wide.length > 0 ? wide : (this.db
      .prepare("SELECT from_ms, to_ms, kind FROM coverage_span WHERE platform = ? ORDER BY from_ms")
      .all(platform) as { from_ms: number; to_ms: number; kind: string }[]);
    const merged: Array<{ from: number; to: number; kind: string }> = [];
    for (const row of rows) {
      const last = merged.at(-1);
      if (last && row.from_ms <= last.to + GAP_THRESHOLD_MS) {
        last.to = Math.max(last.to, row.to_ms);
        if (!last.kind.split("+").includes(row.kind)) last.kind += `+${row.kind}`;
      } else {
        merged.push({ from: row.from_ms, to: row.to_ms, kind: row.kind });
      }
    }
    return merged;
  }

  /**
   * Person summaries (everyone but the captain, or just `ids`), newest
   * conversation first: each person joined with their import people and their
   * stored counts. People with no import person are left out unless the captain has edited them.
   */
  private summaries(ids?: number[], { includeSelf = false } = {}): PersonSummary[] {
    const only = ids ? " WHERE id IN (SELECT value FROM json_each(?))" : "";
    const args = ids ? [JSON.stringify(ids)] : [];
    const persons = this.db.prepare(`SELECT * FROM person${only}`).all(...args) as unknown as PersonRow[];
    const tagsOf = this.people.tags.byPerson(ids);
    const untouched = this.people.untouched(ids);
    const accounts = this.db
      .prepare(
        `SELECT ip.id, ip.platform, ip.display_name, ip.handle, ip.person_id, ip.link_source,
           coalesce(s.direct_count, 0) AS direct, coalesce(s.group_count, 0) AS "group",
           coalesce(s.marketplace_count, 0) AS marketplace, s.last_message_at AS last
         FROM import_person ip LEFT JOIN import_person_stats s ON s.import_person_id = ip.id
         WHERE ip.person_id IS NOT NULL${ids ? " AND ip.person_id IN (SELECT value FROM json_each(?))" : ""}`,
      )
      .all(...args) as unknown as AccountRow[];
    const byPerson = new Map<number, Array<AccountSummary & { marketplace: number }>>();
    for (const account of accounts) {
      const list = byPerson.get(account.person_id) ?? [];
      list.push({
        id: account.id,
        platform: account.platform,
        displayName: account.display_name,
        handle: account.handle,
        link: account.link_source,
        messageCount: account.direct + account.group,
        directMessageCount: account.direct,
        groupMessageCount: account.group,
        lastMessageAt: account.last || null,
        marketplace: account.marketplace,
      });
      byPerson.set(account.person_id, list);
    }
    return persons
      .filter((person) => (includeSelf || !person.is_self) && (byPerson.has(person.id) || person.edited_at !== null))
      .map((person) => {
        const personAccounts = (byPerson.get(person.id) ?? []).sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
        const lastByPlatform = new Map<string, number>();
        for (const account of personAccounts) {
          if (account.lastMessageAt !== null && account.lastMessageAt > (lastByPlatform.get(account.platform) ?? -Infinity)) {
            lastByPlatform.set(account.platform, account.lastMessageAt);
          }
        }
        const last = [...lastByPlatform.values()];
        const sum = (pick: (a: AccountSummary & { marketplace: number }) => number) =>
          personAccounts.reduce((n, a) => n + pick(a), 0);
        const tags = tagsOf.get(person.id) ?? [];
        const joined = personAccounts.filter((a) => a.link === "rule:same-name").map((a) => a.id);
        return {
          id: person.id,
          name: person.name,
          aliases: JSON.parse(person.aliases_json) as string[],
          tags,
          note: person.note,
          noteFromContacts: person.note !== "" && person.note === person.address_book_note,
          shouldReachOut: person.should_reach_out === 1,
          // Only a row made outside People lacks one; it gets the seed People would have given it.
          identiconSeed: person.identicon_seed ?? identiconSeedOf(person.id, person.created_at),
          identiconHue: person.identicon_hue,
          location: person.location,
          edited: person.edited_at !== null,
          untouched: untouched.has(person.id),
          archived: archiveReason({ ...person, tags }),
          archiveRule: person.is_self ? null : person.archive_rule,
          accounts: personAccounts.map(({ marketplace: _m, ...account }) => account),
          messageCount: sum((a) => a.messageCount),
          directMessageCount: sum((a) => a.directMessageCount),
          groupMessageCount: sum((a) => a.groupMessageCount),
          marketplaceMessageCount: sum((a) => a.marketplace),
          lastMessageAt: last.length > 0 ? Math.max(...last) : null,
          unknown: personAccounts.length > 0 && personAccounts.every((a) => isPlaceholderName(a.displayName)),
          lastByPlatform: [...lastByPlatform].map(([platform, at]) => ({ platform, at })).sort((a, b) => b.at - a.at),
          joined: joined.length > 0 ? { rule: "same-name" as const, accountIds: joined } : null,
        };
      })
      .sort((a, b) => (b.lastMessageAt ?? -1) - (a.lastMessageAt ?? -1) || a.name.localeCompare(b.name));
  }
}

function emptyCounts(): MessageCounts {
  return { directFromMe: 0, directFromThem: 0, directFromMeSelfOnly: 0, groupFromMe: 0, groupFromThem: 0 };
}

function gapsBetween(spans: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const gaps: Array<{ from: number; to: number }> = [];
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].from - spans[i - 1].to > GAP_THRESHOLD_MS) gaps.push({ from: spans[i - 1].to, to: spans[i].from });
  }
  return gaps;
}


/** A tag asked for as the app writes tags ("Tokyo era" finds tokyo-era), or as given when it can't be one. */
function tagAsWritten(tag: string): string {
  try {
    return normalizeTag(tag);
  } catch {
    return tag;
  }
}
