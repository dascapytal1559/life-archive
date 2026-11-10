// People: the person table, and which person each import person is.
//
// Every import person (one identity on one platform, as an import found it)
// points at one person, and a person is everything its import people did.
// Each link says how it was made (import_person.link_source):
//
//   import           an import found this identity and made a person for it
//   rule:same-name   the rules joined it with someone of exactly the same name
//   captain          the captain linked it: a merge, a confirmed proposal,
//                    "Not them", `person link`, or an account a person file
//                    listed before the files moved into the archive
//
// Links are stored, not worked out when the archive loads. The rules
// (runRules) run after an import, when RULES_VERSION changes, and on
// `npm run archive -- rules`; they only fill in links nobody chose:
//   - an import person without a person gets one of its own (the captain's own
//     accounts go to the captain's person);
//   - a person without an identicon seed (src/identicon.ts) gets the one People
//     gives everyone it makes, from their id and when they were made;
//   - a person the captain never named follows its one import person's name,
//     exactly as the platform wrote it;
//   - a call account (platform "phone", the call-history connector) goes to the
//     person who holds its exact number or Apple ID as an iMessage account: the
//     same phone line, so no proposal (linkCallsToNumbers);
//   - people with exactly the same name, character for character, are joined
//     (findJoins), when it is two words or more or in Chinese characters; a lone
//     word such as "Alex" is proposed instead. A person's names are their own
//     and their accounts', and people the archive rules archived are joined too.
//     A join never moves a captain's link, never joins two people the captain
//     has edited or linked (they are proposed instead), never joins someone the
//     captain archived himself (the "archive" tag), and never joins people the
//     captain said are different;
//   - the automatic archive rules (archiving.ts) are stored per person;
//   - other evidence that two people may be one (the same phone number, one
//     name's words all in the other's, the same one-word name) becomes a
//     proposal the captain confirms or rejects.
//
// The captain's edits (setName, setAliases, setNames, setTags, setNote, setShouldReachOut,
// setIdenticon, setLocation, merge, detach, link, markAsMe, dropGroup,
// restoreGroup, removeFromGroup, putBackInGroup, unlinkFromGroup, linkToGroup, addCatchUp, changeCatchUp,
// deleteCatchUp, addCall, changeCall, deleteCall, callToCatchUp, catchUpToCall) are written straight to the tables and never undone by the
// rules. (Drafts, drafts.ts, are his scratch space and no edit.) A merge keeps
// one person and deletes the other: the other's import people point at the one
// kept (linked by the captain), and its aliases, tags (but "archive" and
// "keep") and note are added to it, it is to be reached out to if either was, and it
// takes the other's location where it has none (where it has another, the
// other's goes into its note, "Location: Brisbane"), and the other's catch-ups, logged calls and drafts are
// its, and the group chats it was unlinked from (unlinkFromGroup) unlink it too; so when the rules join people, but for aliases, and with "keep" too. "Not them" takes an import person out into a fresh person of
// its own, and remembers the pair so they are never joined or proposed again;
// linking an account away from someone remembers the same.
//
// A note may also be filled from the iPhone address book (addressBookNotes.ts,
// through fillAddressBookNotes), but only while it is empty or still exactly as
// the address book last wrote it (person.address_book_note): a note the
// captain has changed is never written over.
//
// People the archive rules archived (see archiving.ts) are joined by exactly
// the same name like anyone else (a Signal account seen only in groups, say,
// with the full name of someone on the map), and the joined person is then
// archived or shown by the rules. They are never proposed by name: a name
// proposal needs both sides shown on the map, which also keeps the name
// comparison, which looks at every pair, to the few hundred people an owner
// talks with. The same phone number is strong enough to propose people the
// archive rules took off the map. Someone the captain archived himself (the
// "archive" tag) is never joined or proposed.

import { type ArchiveRule, bumpMeta, type Db, getMeta, type GroupUnlink, HANGOUT, identiconSeedOf, InvalidInputError, isIdenticonHue, isIdenticonSeed, isPhone, isPlaceholderName, joinsByName, type LinkSource, nameKey, NotFoundError, sameName, setMeta, transaction } from "../../../sdk/server.ts";
import { archiveReason, archiveRules } from "./archiving.ts";
import { CatchUps, normalizeCatchUp } from "./catchUps.ts";
import { Drafts } from "./drafts.ts";
import { ManualCalls, normalizeManualCall } from "./manualCalls.ts";
import { Locations } from "./locations.ts";
import {
  combineNotes,
  normalizeAliases,
  normalizeLocation,
  normalizeName,
  normalizeNames,
  normalizeNote,
  normalizeShouldReachOut,
} from "./personFields.ts";
import { refreshStats } from "./stats.ts";
import { storableTag, Tags } from "./tags.ts";

/**
 * Bump this whenever what the rules do changes: the next open runs them again
 * (joins, archive rules and proposals; captain's links are never touched).
 */
export const RULES_VERSION = 14;

export type Tier = "high" | "medium" | "low";

export interface Evidence {
  rule: "phone-match" | "name-exact" | "name-one-word" | "name-contained";
  tier: Tier;
  /** Names and handles only, never message content. */
  detail: string;
}

/** Pending proposals between the same two people, shown as one. */
export interface ProposalGroup {
  /** The id used to confirm or reject the whole group. */
  id: number;
  personIds: [number, number];
  tier: Tier;
  evidence: Evidence[];
}

const TIER_RANK: Record<Tier, number> = { high: 3, medium: 2, low: 1 };

export interface PersonRow {
  id: number;
  name: string;
  name_source: "import" | "captain";
  aliases_json: string;
  is_self: number;
  edited_at: number | null;
  archive_rule: ArchiveRule | null;
  note: string;
  /** The note as the address book last wrote it, if it ever did. */
  address_book_note: string | null;
  /** 1 when the captain should reach out to them. */
  should_reach_out: number;
  /** What their identicon is drawn from (src/identicon.ts); null only for a row made outside People. */
  identicon_seed: string | null;
  /** The hue picked for their identicon, whole degrees (src/identicon.ts); null for the seed's own. */
  identicon_hue: number | null;
  /** Where they are, as far as the captain last knew (locations.ts); null for not said. */
  location: string | null;
  created_at: number;
}

/** What fillAddressBookNotes did. */
export interface NoteFill {
  /** People whose note the address book wrote (it was empty, or still as the address book last wrote it). */
  written: number;
  /** People whose note already said exactly that. */
  unchanged: number;
  /** People whose note the captain has changed, left as they are. */
  keptCaptains: number;
}

interface ProposalRow {
  id: number;
  left_key: string;
  right_key: string;
  rule: string;
  tier: Tier;
  evidence_json: string;
  status: "pending" | "rejected";
}

export class People {
  private readonly db: Db;
  /** The tag table, and who has which tag (tags.ts). */
  readonly tags: Tags;
  /** Everyone's locations, and who is at which (locations.ts). */
  readonly locations: Locations;
  /** Time the captain spent with people outside messages, and who was at each (catchUps.ts). */
  readonly catchUps: CatchUps;
  /** Calls the captain logged himself (manualCalls.ts). */
  readonly manualCalls: ManualCalls;
  /** Messages the captain is writing to people (drafts.ts). */
  readonly drafts: Drafts;

  constructor(db: Db) {
    this.db = db;
    this.tags = new Tags(db);
    this.locations = new Locations(db);
    this.catchUps = new CatchUps(db);
    this.manualCalls = new ManualCalls(db);
    this.drafts = new Drafts(db);
  }

  /** Whether the rules last run are this code's (they are not on the first open after an upgrade, say). */
  rulesAreCurrent(): boolean {
    return getMeta(this.db, "rules_version") === String(RULES_VERSION);
  }

  /**
   * The rules (see the top of this file): after an import, when the rules
   * change, or when asked. Scans every message once, to count what each import
   * person did (stats.ts); takes a second or two on a big archive.
   *
   * With `onlyMessages` (a live batch that added or changed no account),
   * people count as changed only if the rules changed someone (a new person,
   * a name, a join, archiving, a proposal); if they only counted the new
   * messages again, just what the messages add up to is marked as changed, so
   * open pages update their counts without reloading everyone.
   */
  runRules({ onlyMessages = false }: { onlyMessages?: boolean } = {}): void {
    transaction(this.db, () => {
      // Every row the rules write but the counts: a rule writes only what it changes, the counts are written afresh.
      const writes = () => (this.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
      const start = writes();
      this.ensurePersons();
      this.linkCallsToNumbers();
      this.seedIdenticons();
      this.followImportNames();
      const beforeCounts = writes();
      refreshStats(this.db);
      const afterCounts = writes();
      this.refreshArchive();
      const joins = this.findJoins();
      for (const join of joins) this.join(join);
      if (joins.length > 0) this.refreshArchive(joins.map((j) => j.survivor));
      this.dropEmpty();
      this.refreshProposals();
      const ruled = beforeCounts - start + writes() - afterCounts;
      setMeta(this.db, "rules_version", String(RULES_VERSION));
      this.changed({ people: !onlyMessages || ruled > 0, links: true });
    });
  }

  /** A person the captain adds by hand, with no accounts yet (`person link` gives them some). Returns their id. */
  create(name: unknown): number {
    const clean = normalizeName(name);
    return transaction(this.db, () => {
      const id = this.newPerson(clean);
      this.db.prepare("UPDATE person SET name_source = 'captain' WHERE id = ?").run(id);
      this.touch(id);
      this.changed();
      return id;
    });
  }

  /**
   * "Add person" (the Table, `person new`): `create`, then their location, tags and note when given, all or nothing.
   * Being edited by hand, they are never archived by the rules for having no messages. Returns their id.
   */
  add(input: unknown): number {
    const { name, location, tags, note } = (input ?? {}) as Record<string, unknown>;
    return transaction(this.db, () => {
      const id = this.create(name);
      if (location !== undefined) this.setLocation(id, location);
      if (tags !== undefined) this.setTags(id, tags);
      if (note !== undefined) this.setNote(id, note);
      return id;
    });
  }

  /**
   * Everyone but the captain whose name or an alias is `name` (as the rules compare names, sameName, but for case):
   * whom "Add person" offers before adding a second, as a hand-made person and an import of one name are joined.
   */
  sameNamed(name: unknown): number[] {
    const wanted = sameName(normalizeName(name)).toLowerCase();
    const rows = this.db.prepare("SELECT id, name, aliases_json FROM person WHERE is_self = 0 ORDER BY id").all() as
      { id: number; name: string; aliases_json: string }[];
    return rows
      .filter((row) => [row.name, ...(JSON.parse(row.aliases_json) as string[])].some((n) => sameName(n).toLowerCase() === wanted))
      .map((row) => row.id);
  }

  /**
   * Renames a person; the name is the captain's from now on. One of their aliases moves to the front, as dragging its
   * chip first does, and their name before it stays as their first alias; any other name takes their name's place.
   */
  setName(personId: number, name: unknown): number {
    const clean = normalizeName(name);
    const aliases = this.aliasesOf(personId);
    const kept = aliases.includes(clean) ? [this.person(personId).name] : [];
    return this.setNames(personId, [clean, ...kept, ...aliases], { captain: true });
  }

  /** Sets a person's other names, after their name, in order (their name is never one of them). */
  setAliases(personId: number, aliases: unknown): number {
    const clean = normalizeAliases(aliases);
    const { name } = this.person(personId);
    return this.setNames(personId, [name, ...clean.filter((alias) => alias !== name)], { trivial: clean.length === 0 });
  }

  /**
   * Sets every name a person goes by, in order, as the person panel's chips show them: the first is their name (their
   * label everywhere), the rest their aliases. A different first name is the captain's from now on (`captain` says so
   * even for the same one); a name moved off the front stays as an alias. At least one name; repeats are dropped.
   */
  setNames(personId: number, names: unknown, { captain = false, trivial = false } = {}): number {
    const [name, ...aliases] = normalizeNames(names);
    const before = this.person(personId);
    return this.edit(personId, () => {
      if (captain || name !== before.name) this.db.prepare("UPDATE person SET name = ?, name_source = 'captain' WHERE id = ?").run(name, personId);
      this.db.prepare("UPDATE person SET aliases_json = ? WHERE id = ?").run(JSON.stringify(aliases), personId);
    }, trivial);
  }

  addAlias(personId: number, alias: unknown): number {
    return this.setAliases(personId, [...this.aliasesOf(personId), normalizeName(alias)]);
  }

  removeAlias(personId: number, alias: unknown): number {
    const clean = normalizeName(alias);
    const aliases = this.aliasesOf(personId);
    if (!aliases.includes(clean)) throw new NotFoundError(`person ${personId} has no alias "${clean}"`);
    return this.setAliases(personId, aliases.filter((a) => a !== clean));
  }

  /**
   * Sets a person's tags ("archive" takes them off the map, "keep" out of the
   * archive rules); a tag not in the tag table yet is added to it, last.
   */
  setTags(personId: number, tags: unknown): number {
    if (!Array.isArray(tags)) throw new InvalidInputError("tags must be a list");
    const clean = [...new Set(tags.map(storableTag))];
    if (this.person(personId, { allowSelf: true }).is_self) throw new InvalidInputError("your own accounts take no tags");
    return this.edit(personId, () => this.tags.set(personId, clean), clean.length === 0);
  }

  /** Sets a person's note (empty for none); the note is the captain's from now on. */
  setNote(personId: number, note: unknown): number {
    const clean = normalizeNote(note);
    const person = this.person(personId);
    if (clean === person.note) return person.id;
    return this.edit(personId, () => {
      this.db.prepare("UPDATE person SET note = ? WHERE id = ?").run(clean, personId);
    });
  }

  /** Sets whether the captain should reach out to them (Orbits' glow). */
  setShouldReachOut(personId: number, value: unknown): number {
    const flag = normalizeShouldReachOut(value);
    const person = this.person(personId);
    if (flag === (person.should_reach_out === 1)) return person.id;
    return this.edit(personId, () => {
      this.db.prepare("UPDATE person SET should_reach_out = ? WHERE id = ?").run(flag ? 1 : 0, personId);
    });
  }

  /**
   * Sets what their identicon is drawn from (src/identicon.ts): the seed, 16 hex digits, and the hue picked for it,
   * whole degrees 0 to 359 (null: the seed's own; left out: as it is).
   */
  setIdenticon(personId: number, seed: unknown, hue?: unknown): number {
    if (!isIdenticonSeed(seed)) throw new InvalidInputError("an identicon seed is 16 hex digits, 0-9 and a-f");
    if (hue !== undefined && hue !== null && !isIdenticonHue(hue)) throw new InvalidInputError("an identicon hue is whole degrees, 0 to 359, or null");
    const person = this.person(personId);
    const picked = hue === undefined ? person.identicon_hue : hue;
    if (seed === person.identicon_seed && picked === person.identicon_hue) return person.id;
    return this.edit(personId, () => {
      this.db.prepare("UPDATE person SET identicon_seed = ?, identicon_hue = ? WHERE id = ?").run(seed, picked, personId);
    });
  }

  /** Sets where they are, as far as the captain last knew ("Brisbane"): one value, or null (or "") for not said. */
  setLocation(personId: number, value: unknown): number {
    if (value !== null && typeof value !== "string") throw new InvalidInputError("a location is text, or null for none");
    const clean = value === null || value.trim() === "" ? null : normalizeLocation(value);
    const person = this.person(personId);
    if (clean?.toLowerCase() === person.location?.toLowerCase()) return person.id;
    return this.edit(personId, () => {
      this.db.prepare("UPDATE person SET location = ? WHERE id = ?").run(clean === null ? null : this.locations.spelled(clean), personId);
    });
  }

  /**
   * Adds a catch-up (catchUps.ts: time in person, on a date no later than today, when it started if said, or a trip over several days, how many hours it lasted, a note, and one person or
   * more, never the captain); everyone at it is marked edited, so the rules never archive them.
   * Returns its number.
   */
  addCatchUp(input: unknown): number {
    const catchUp = normalizeCatchUp(input);
    for (const id of catchUp.personIds) this.person(id);
    return transaction(this.db, () => {
      const id = this.catchUps.insert(catchUp);
      for (const personId of catchUp.personIds) this.touch(personId);
      this.changed();
      return id;
    });
  }

  /**
   * Makes catch-up `id` as `input` says, who was at it too; everyone at it before or after is marked edited. Returns
   * whether it changed.
   */
  changeCatchUp(id: number, input: unknown): boolean {
    const before = this.catchUps.get(id);
    const catchUp = normalizeCatchUp(input);
    for (const personId of catchUp.personIds) this.person(personId);
    const people = before.people.map((p) => p.id);
    const same = (["day", "time", "hours", "note", "others"] as const).every((key) => before[key] === catchUp[key])
      && JSON.stringify(before.trip) === JSON.stringify(catchUp.trip)
      && people.length === catchUp.personIds.length && people.every((personId) => catchUp.personIds.includes(personId));
    if (same) return false;
    transaction(this.db, () => {
      this.catchUps.update(id, catchUp);
      for (const personId of new Set([...people, ...catchUp.personIds])) this.touch(personId);
      this.changed();
    });
    return true;
  }

  /** Deletes catch-up `id`; everyone who was at it is marked edited. */
  deleteCatchUp(id: number): void {
    const { people } = this.catchUps.get(id);
    transaction(this.db, () => {
      this.catchUps.remove(id);
      for (const person of people) this.touch(person.id);
      this.changed();
    });
  }

  /**
   * Logs a call with one or more people (manualCalls.ts: never the captain, each on one of their accounts that carries
   * calls, or on an app for someone with none; a date no later than today, when it started and how many minutes):
   * one logged call each, as one group. Everyone on it is marked edited, so the rules never archive them. Returns the
   * first's number.
   */
  addCall(input: unknown): number {
    const call = normalizeManualCall(input);
    for (const person of call.people) {
      this.person(person.personId);
      this.manualCalls.checkAccount(person, { fresh: true });
    }
    return transaction(this.db, () => {
      const id = this.manualCalls.insert(call);
      for (const person of call.people) this.touch(person.personId);
      this.changed();
      return id;
    });
  }

  /**
   * Makes logged call `id`'s whole group as `input` says (everyone on it: anyone left out is taken off, anyone new
   * put on); everyone on it before and after is marked edited. Whether it changed.
   */
  changeCall(id: number, input: unknown): boolean {
    const before = this.manualCalls.group(id);
    const call = normalizeManualCall(input);
    for (const person of call.people) {
      this.person(person.personId);
      // Someone on it on no account, from before they had an account that carries calls, may stay so.
      const onNone = before.some((row) => row.person === person.personId && row.account_id === null);
      this.manualCalls.checkAccount(person, { fresh: !onNone });
    }
    return transaction(this.db, () => {
      if (!this.manualCalls.update(id, call)) return false;
      for (const personId of new Set([...before.map((row) => row.person), ...call.people.map((p) => p.personId)])) this.touch(personId);
      this.changed();
      return true;
    });
  }

  /** Deletes logged call `id`'s whole group; everyone on it is marked edited. */
  deleteCall(id: number): void {
    const everyone = new Set(this.manualCalls.group(id).map((row) => row.person));
    transaction(this.db, () => {
      this.manualCalls.remove(id);
      for (const personId of everyone) this.touch(personId);
      this.changed();
    });
  }

  /**
   * Makes logged call `id`'s whole group a catch-up, as `input` says (as addCatchUp takes one): the call goes and the
   * catch-up comes in its place, in one transaction, so a changeset recording it undoes both. Everyone on either is
   * marked edited. Returns the catch-up's number.
   */
  callToCatchUp(id: number, input: unknown): number {
    const before = new Set(this.manualCalls.group(id).map((row) => row.person));
    const catchUp = normalizeCatchUp(input);
    for (const personId of catchUp.personIds) this.person(personId);
    return transaction(this.db, () => {
      this.manualCalls.remove(id);
      const made = this.catchUps.insert(catchUp);
      for (const personId of new Set([...before, ...catchUp.personIds])) this.touch(personId);
      this.changed();
      return made;
    });
  }

  /**
   * Makes catch-up `id` a logged call, as `input` says (as addCall takes one, each person on one of their accounts
   * that carries calls, or on an app with none; the catch-up's unnamed others, unless it says): the catch-up goes and
   * the call comes in its place, in one transaction, as callToCatchUp. Returns the call's first number.
   */
  catchUpToCall(id: number, input: unknown): number {
    const { people: before, others } = this.catchUps.get(id);
    const given = normalizeManualCall(input);
    const call = { ...given, others: given.others ?? others };
    for (const person of call.people) {
      this.person(person.personId);
      this.manualCalls.checkAccount(person, { fresh: true });
    }
    return transaction(this.db, () => {
      this.catchUps.remove(id);
      const made = this.manualCalls.insert(call);
      for (const personId of new Set([...before.map((p) => p.id), ...call.people.map((p) => p.personId)])) this.touch(personId);
      this.changed();
      return made;
    });
  }

  /**
   * The untouched among `ids` (everyone without): people the captain has never changed by hand, the one place this
   * is decided (docs/people.md "People"). Touched is anyone he has edited (edited_at: a name, aliases, tags, archiving or
   * bringing back, a location, a note, reaching out, a merge, added by hand), linked an account to
   * (a merge, `person link`, and the fresh person "Not them" makes), or taken an account from with "Not them" (the
   * pair it remembers, which a merge or join carries to the one kept). Imports, the rules and the address book's
   * notes touch nobody, and an undo puts all of these back. The captain himself is never untouched.
   */
  untouched(ids?: readonly number[]): Set<number> {
    const only = ids ? " AND p.id IN (SELECT value FROM json_each(?))" : "";
    const rows = this.db
      .prepare(
        `SELECT p.id FROM person p WHERE p.is_self = 0 AND p.edited_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM import_person ip WHERE ip.person_id = p.id AND ip.link_source = 'captain')${only}`,
      )
      .all(...(ids ? [JSON.stringify(ids)] : [])) as { id: number }[];
    const notThem = new Set(this.proposalRows("rejected").flatMap((row) => [row.left_key, row.right_key]));
    return new Set(rows.map((row) => row.id).filter((id) => !notThem.has(`person:${id}`)));
  }

  /** The people the captain should reach out to, by id (from the person table's index on the flag). */
  toReachOut(): number[] {
    return (this.db.prepare("SELECT id FROM person WHERE should_reach_out = 1 ORDER BY id").all() as { id: number }[]).map((row) => row.id);
  }

  /**
   * Writes notes from the address book (see addressBookNotes.ts), person id to
   * text, where the note is empty or still exactly as the address book last
   * wrote it; a note the captain has changed is left alone. Not an edit by the
   * captain, so the rules treat these people as before.
   */
  fillAddressBookNotes(notes: Map<number, string>): NoteFill {
    const fill: NoteFill = { written: 0, unchanged: 0, keptCaptains: 0 };
    const read = this.db.prepare("SELECT note, address_book_note, is_self FROM person WHERE id = ?");
    const write = this.db.prepare("UPDATE person SET note = ?, address_book_note = ? WHERE id = ?");
    transaction(this.db, () => {
      for (const [id, text] of notes) {
        const note = normalizeNote(text);
        const row = read.get(id) as { note: string; address_book_note: string | null; is_self: number } | undefined;
        if (!row || row.is_self) continue;
        if (row.note === note) {
          if (row.address_book_note !== note) write.run(note, note, id);
          fill.unchanged++;
        } else if (fromAddressBook(row)) {
          write.run(note, note, id);
          fill.written++;
        } else {
          fill.keptCaptains++;
        }
      }
      if (fill.written > 0) this.changed();
    });
    return fill;
  }

  addTags(personId: number, tags: string[]): number {
    return this.setTags(personId, [...this.tagsOf(personId), ...tags]);
  }

  removeTags(personId: number, tags: string[]): number {
    const drop = new Set(tags.map(storableTag));
    return this.setTags(personId, this.tagsOf(personId).filter((t) => !drop.has(t)));
  }

  /**
   * The captain says two people are one: `personId` is kept, `otherId`
   * deleted, whoever either is (archived by hand or by the rules, or a deleted
   * or unknown account). The other's import people point at the one kept (linked by the
   * captain), and its aliases, tags (but "archive" and "keep": the kept person
   * keeps its own archive state) and note are added, the kept
   * person is to be reached out to if either was, and takes its location where it has
   * none (another goes into the note, see foldLocation); the name kept is the kept
   * person's, or the other's with `name: "other"`. Returns the kept person's id.
   */
  merge(personId: number, otherId: number, { name = "kept" }: { name?: "kept" | "other" } = {}): number {
    const kept = this.person(personId);
    const other = this.person(otherId);
    if (kept.id === other.id) throw new InvalidInputError("that is the same person");
    transaction(this.db, () => {
      this.mergeNow(kept, other, name === "other" ? other.name : kept.name);
      this.refreshArchive([kept.id]);
      this.changed({ links: true });
    });
    return kept.id;
  }

  /** The captain says the two people in a proposal are one. Returns the kept person's id. */
  confirm(proposalId: number): number {
    const group = this.proposalGroups().find((g) => g.id === proposalId);
    if (!group) throw new NotFoundError(`no pending proposal ${proposalId}`);
    const [a, b] = group.personIds.map((id) => this.person(id));
    // The one the captain has edited, else the one with more messages.
    const keepA = a.edited_at !== null || (b.edited_at === null && this.messageCount(a.id) >= this.messageCount(b.id));
    return keepA ? this.merge(a.id, b.id) : this.merge(b.id, a.id);
  }

  /** The captain says the two people in a proposal are different; they are not proposed or joined again. */
  reject(proposalId: number): void {
    const group = this.proposalGroups().find((g) => g.id === proposalId);
    if (!group) throw new NotFoundError(`no pending proposal ${proposalId}`);
    const pair = group.personIds.join(":");
    const reject = this.db.prepare("UPDATE merge_proposal SET status = 'rejected', decided_at = ? WHERE id = ?");
    transaction(this.db, () => {
      for (const row of this.proposalRows("pending")) {
        if (this.pairOf(row.left_key, row.right_key)?.join(":") === pair) reject.run(Date.now(), row.id);
      }
      this.changed();
    });
  }

  /**
   * "Not them": takes an import person away from a person, into a fresh person
   * of its own, linked by the captain, and remembers that the two are
   * different, so they are never joined or proposed again. Returns the fresh person's id.
   */
  detach(personId: number, importPersonId: number): number {
    const person = this.person(personId, { allowSelf: true });
    const account = this.importPerson(importPersonId);
    if (account.person_id !== person.id) throw new NotFoundError(`person ${personId} has no account ${importPersonId}`);
    if (account.is_self) throw new InvalidInputError("the export marks this account as yours; change selfName in its settings instead");
    const others = (this.db.prepare("SELECT count(*) AS n FROM import_person WHERE person_id = ?").get(person.id) as { n: number }).n - 1;
    if (others === 0) throw new InvalidInputError("this person's only account can't be taken away");
    return transaction(this.db, () => {
      const fresh = this.newPerson(account.display_name);
      this.linkNow(importPersonId, fresh, "captain");
      this.rejectPair(accountKey(account), `person:${person.id}`, "detached");
      if (person.is_self) this.recount();
      else this.refreshArchive([person.id, fresh]);
      this.changed({ links: true });
      return fresh;
    });
  }

  /**
   * The captain says this import person is `personId` (the captain's own person makes it one of his accounts).
   * Taken from another person, it is remembered as not them, as "Not them" does.
   */
  link(importPersonId: number, personId: number): number {
    const person = this.person(personId, { allowSelf: true });
    const account = this.importPerson(importPersonId);
    if (account.is_self) throw new InvalidInputError("the export marks this account as yours; change selfName in its settings instead");
    if (account.person_id === person.id) return person.id;
    const from = account.person_id;
    transaction(this.db, () => {
      this.linkNow(importPersonId, person.id, "captain");
      this.touch(person.id);
      const wasSelf = from !== null && this.isSelf(from);
      // Taken from someone, it is not them, as with "Not them": its name joins nobody of theirs into this person.
      if (from !== null && !wasSelf) this.rejectPair(accountKey(account), `person:${from}`, "detached");
      if (from !== null) this.dropIfEmpty(from);
      if (person.is_self || wasSelf) this.recount();
      else this.refreshArchive([person.id, ...(from !== null && this.exists(from) ? [from] : [])]);
      this.changed({ links: true });
    });
    return person.id;
  }

  /** Takes an import person out into a fresh person of its own (see detach). */
  unlink(importPersonId: number): number {
    const account = this.importPerson(importPersonId);
    if (account.person_id === null) throw new NotFoundError(`account ${importPersonId} is linked to nobody`);
    return this.detach(account.person_id, importPersonId);
  }

  /** "This is me": the person's accounts are the captain's own (an old name, say); the person is merged into the captain's. */
  markAsMe(personId: number): number {
    const person = this.person(personId);
    const self = this.selfId();
    transaction(this.db, () => {
      this.db.prepare("UPDATE import_person SET person_id = ?, link_source = 'captain', linked_at = ? WHERE person_id = ?").run(self, Date.now(), person.id);
      this.foldNote(self, person.id);
      this.deletePerson(person.id, self);
      this.recount();
      this.changed({ links: true });
    });
    return self;
  }

  /**
   * Drops a group chat (a bulk message the captain sent to people who don't
   * know each other, say): it links nobody to anyone and counts in nothing
   * worked out from group chats (stats.ts, structure.ts), though its messages
   * stay. Imports never write conversation.dropped_at, so a re-import keeps it
   * dropped. Everyone is counted again, and so their archive rules and the
   * proposals. Returns whether it changed (false when it was dropped already).
   */
  dropGroup(conversationId: number): boolean {
    return this.setGroupDropped(conversationId, true);
  }

  /** Brings back a group chat dropGroup dropped. Returns whether it changed (false when it was not dropped). */
  restoreGroup(conversationId: number): boolean {
    return this.setGroupDropped(conversationId, false);
  }

  private setGroupDropped(conversationId: number, dropped: boolean): boolean {
    const chat = this.groupChat(conversationId);
    if ((chat.dropped_at !== null) === dropped) return false;
    transaction(this.db, () => {
      this.db.prepare("UPDATE conversation SET dropped_at = ? WHERE id = ?").run(dropped ? Date.now() : null, conversationId);
      this.recount();
      this.refreshProposals();
      this.changed({ links: true });
    });
    return true;
  }

  /**
   * Takes someone out of a group chat they were added to but never wrote in
   * (by mistake, say): they are no member of it in anything worked out from
   * group chats (stats.ts, structure.ts), as if the imports had never listed
   * them. Refused for the captain and for anyone who wrote there. Imports
   * never write conversation_member.removed_at, so a re-import keeps them out;
   * should a newer export have them write there, they count again by what
   * they wrote. Everyone is counted again, as for dropGroup. Returns whether it
   * changed (false when they were taken out already).
   */
  removeFromGroup(conversationId: number, personId: number): boolean {
    return this.setGroupMemberRemoved(conversationId, personId, true);
  }

  /** Puts back someone removeFromGroup took out. Returns whether it changed (false when they were not taken out). */
  putBackInGroup(conversationId: number, personId: number): boolean {
    return this.setGroupMemberRemoved(conversationId, personId, false);
  }

  private setGroupMemberRemoved(conversationId: number, personId: number, removed: boolean): boolean {
    this.groupChat(conversationId);
    const person = this.person(personId);
    const rows = this.db
      .prepare(
        `SELECT cm.account_id, cm.removed_at FROM conversation_member cm JOIN import_person ip ON ip.id = cm.account_id
         WHERE cm.conversation_id = ? AND ip.person_id = ?`,
      )
      .all(conversationId, personId) as { account_id: number; removed_at: number | null }[];
    if (rows.length === 0) throw new InvalidInputError(`${person.name} is not listed in the group chat #${conversationId}`);
    if (removed) {
      const wrote = this.db
        .prepare(
          `SELECT count(*) AS n FROM message m JOIN import_person ip ON ip.id = m.sender_account_id
           WHERE m.conversation_id = ? AND ip.person_id = ? AND m.type != 'system'`,
        )
        .get(conversationId, personId) as { n: number };
      if (wrote.n > 0) throw new InvalidInputError(`${person.name} wrote in the group chat #${conversationId}, so is in it`);
    }
    const accounts = rows.filter((row) => (row.removed_at !== null) !== removed).map((row) => row.account_id);
    if (accounts.length === 0) return false;
    transaction(this.db, () => {
      const update = this.db.prepare("UPDATE conversation_member SET removed_at = ? WHERE conversation_id = ? AND account_id = ?");
      for (const account of accounts) update.run(removed ? Date.now() : null, conversationId, account);
      this.recount();
      this.refreshProposals();
      this.changed({ links: true });
    });
    return true;
  }

  /**
   * Says a group chat does not connect someone to anyone (the person panel's
   * break-link button): they stay a member of it, counted in its size, their
   * numbers and their closeness as before, but it makes no shared group,
   * friend circle or highlight between them and its other members
   * (RelationshipsReport.unlinks). Kept by person (group_unlink),
   * which imports never write, so a re-import keeps it. Returns whether it
   * changed (false when they were unlinked already).
   */
  unlinkFromGroup(conversationId: number, personId: number): boolean {
    return this.setGroupUnlinked(conversationId, personId, true);
  }

  /** Connects someone through a group chat again, undoing unlinkFromGroup. Returns whether it changed (false when they were linked). */
  linkToGroup(conversationId: number, personId: number): boolean {
    return this.setGroupUnlinked(conversationId, personId, false);
  }

  private setGroupUnlinked(conversationId: number, personId: number, unlinked: boolean): boolean {
    this.groupChat(conversationId);
    const person = this.person(personId);
    const now = this.db.prepare("SELECT 1 FROM group_unlink WHERE person_id = ? AND conversation_id = ?").get(personId, conversationId) !== undefined;
    if (now === unlinked) return false;
    if (unlinked) {
      const member = this.db
        .prepare(
          `SELECT 1 FROM import_person ip WHERE ip.person_id = ? AND (
             EXISTS (SELECT 1 FROM conversation_member cm WHERE cm.conversation_id = ? AND cm.account_id = ip.id AND cm.removed_at IS NULL)
             OR EXISTS (SELECT 1 FROM message m WHERE m.conversation_id = ? AND m.sender_account_id = ip.id))`,
        )
        .get(personId, conversationId, conversationId);
      if (!member) throw new InvalidInputError(`${person.name} is not in the group chat #${conversationId}`);
    }
    transaction(this.db, () => {
      if (unlinked) this.db.prepare("INSERT INTO group_unlink (person_id, conversation_id, unlinked_at) VALUES (?, ?, ?)").run(personId, conversationId, Date.now());
      else this.db.prepare("DELETE FROM group_unlink WHERE person_id = ? AND conversation_id = ?").run(personId, conversationId);
      this.changed();
    });
    return true;
  }

  /** Everyone unlinked from a group chat (unlinkFromGroup), by group and person. */
  groupUnlinks(): GroupUnlink[] {
    return this.db.prepare("SELECT person_id AS personId, conversation_id AS groupId FROM group_unlink ORDER BY conversation_id, person_id").all() as unknown as GroupUnlink[];
  }

  /** A group chat (not direct, not Marketplace) by number, or why not. */
  private groupChat(conversationId: number): { dropped_at: number | null } {
    const chat = this.db.prepare("SELECT type, is_marketplace, dropped_at FROM conversation WHERE id = ?").get(conversationId) as
      { type: string; is_marketplace: number; dropped_at: number | null } | undefined;
    if (!chat) throw new NotFoundError(`no chat #${conversationId}`);
    if (chat.type !== "group" || chat.is_marketplace) throw new InvalidInputError(`chat #${conversationId} is not a group chat`);
    return chat;
  }

  /** Deletes a person with no accounts left (one added by hand, say, or emptied by "Not them"). Not the captain. */
  delete(personId: number): void {
    const person = this.person(personId);
    const accounts = (this.db.prepare("SELECT count(*) AS n FROM import_person WHERE person_id = ?").get(person.id) as { n: number }).n;
    if (accounts > 0) throw new InvalidInputError(`person ${person.id} still has ${accounts} account${accounts === 1 ? "" : "s"}; join or take them away first`);
    transaction(this.db, () => {
      this.deletePerson(person.id, null);
      this.changed();
    });
  }

  /**
   * Pending proposals grouped by the pair of people they are about, strongest first. People the captain archived
   * are left out, and so is everything but the same phone number about people the rules archived.
   */
  proposalGroups(): ProposalGroup[] {
    const rejected = new Set(
      this.proposalRows("rejected").flatMap((row) => this.pairOf(row.left_key, row.right_key)?.join(":") ?? []),
    );
    const { archived, byHand } = this.archivedPeople();
    const groups = new Map<string, ProposalGroup>();
    for (const row of this.proposalRows("pending")) {
      const pair = this.pairOf(row.left_key, row.right_key);
      if (!pair || rejected.has(pair.join(":")) || byHand.has(pair[0]) || byHand.has(pair[1])) continue;
      if ((archived.has(pair[0]) || archived.has(pair[1])) && row.rule !== "phone-match") continue;
      const evidence = { ...(JSON.parse(row.evidence_json) as Omit<Evidence, "tier">), tier: row.tier };
      const group = groups.get(pair.join(":"));
      if (!group) {
        groups.set(pair.join(":"), { id: row.id, personIds: pair, tier: row.tier, evidence: [evidence] });
        continue;
      }
      group.id = Math.min(group.id, row.id);
      if (TIER_RANK[row.tier] > TIER_RANK[group.tier]) group.tier = row.tier;
      if (!group.evidence.some((e) => e.rule === evidence.rule && e.detail === evidence.detail)) group.evidence.push(evidence);
    }
    return [...groups.values()].sort((x, y) => TIER_RANK[y.tier] - TIER_RANK[x.tier] || x.id - y.id);
  }

  /**
   * After an undo (changes.ts) has put rows back: the archive rules are stored
   * again for the people it touched (everyone's, with the counts, when the
   * captain's own person was one, or with `recount`: a group chat dropped or
   * brought back), proposals are worked out again when links changed, and open
   * pages hear of it.
   */
  settle(personIds: number[], { links, recount = false }: { links: boolean; recount?: boolean }): void {
    transaction(this.db, () => {
      if (recount || personIds.some((id) => this.isSelf(id))) this.recount();
      else this.refreshArchive(personIds.filter((id) => this.exists(id)));
      if (links) this.refreshProposals();
      this.changed({ links });
    });
  }

  /** A number that changes whenever anyone's people change (names, tags, links), for pages to notice edits from elsewhere. */
  version(): string {
    return getMeta(this.db, "people_version") ?? "0";
  }

  /**
   * A number that changes whenever which import people make up a person changes, or new messages arrive. When it
   * changes and version() does not, only what the messages add up to has changed (see runRules' `onlyMessages`).
   */
  linksVersion(): string {
    return getMeta(this.db, "links_version") ?? "0";
  }

  // --- the rules

  /** Every import person without a person gets one of its own; the captain's own accounts go to the captain's person. */
  private ensurePersons(): void {
    const self = this.selfId();
    const now = Date.now();
    this.db.prepare("UPDATE import_person SET person_id = ?, link_source = 'import', linked_at = ? WHERE is_self = 1 AND person_id IS NOT ?").run(self, now, self);
    const orphans = this.db.prepare("SELECT id, display_name FROM import_person WHERE person_id IS NULL").all() as { id: number; display_name: string }[];
    for (const orphan of orphans) this.linkNow(orphan.id, this.newPerson(orphan.display_name), "import");
  }

  /**
   * Each call account (platform "phone") goes to the person who holds the same key, its exact number in E.164 or
   * Apple ID email, as an iMessage account: one phone line, so it is linked ("rule:same-number"), not proposed. One
   * still on the person the import made for it moves only while nobody has edited that person (it then has no other
   * account, and is left to dropEmpty); one this rule linked follows the iMessage account wherever it goes ("Not
   * them" on it, say). A link the captain made is never moved. Numbers nobody holds on iMessage keep a person of
   * their own and follow the other rules (a name join, a phone-number proposal).
   */
  private linkCallsToNumbers(): void {
    const moves = this.db
      .prepare(
        `SELECT c.id, i.person_id FROM import_person c
         JOIN import_person i ON i.platform = 'imessage' AND i.key = c.key AND i.is_self = 0 AND i.person_id IS NOT NULL
         JOIN person p ON p.id = c.person_id
         WHERE c.platform = 'phone' AND c.is_self = 0 AND c.person_id IS NOT i.person_id
           AND (c.link_source = 'rule:same-number'
             OR (c.link_source = 'import' AND p.edited_at IS NULL AND p.is_self = 0
               AND (SELECT count(*) FROM import_person o WHERE o.person_id = c.person_id) = 1))`,
      )
      .all() as { id: number; person_id: number }[];
    for (const move of moves) this.linkNow(move.id, move.person_id, "rule:same-number");
  }

  /** A person the captain never named, made for one import person, keeps that import person's name. */
  private followImportNames(): void {
    this.db.exec(`
      UPDATE person SET name = (SELECT display_name FROM import_person WHERE person_id = person.id)
      WHERE name_source = 'import' AND is_self = 0
        AND (SELECT count(*) FROM import_person WHERE person_id = person.id) = 1
        AND name IS NOT (SELECT display_name FROM import_person WHERE person_id = person.id)`);
  }

  /** Stores the automatic archive rule that fits each person (everyone, or just `personIds`). */
  private refreshArchive(personIds?: number[]): void {
    const current = new Map((this.db.prepare("SELECT id, archive_rule FROM person").all() as { id: number; archive_rule: string | null }[])
      .map((row) => [row.id, row.archive_rule]));
    const update = this.db.prepare("UPDATE person SET archive_rule = ? WHERE id = ?");
    for (const [id, rule] of archiveRules(this.db, personIds)) if (current.get(id) !== rule) update.run(rule, id);
  }

  /** Counts every import person's messages again, and so everyone's archive rule: the captain's own accounts, or the group chats that count, changed. */
  private recount(): void {
    refreshStats(this.db);
    this.refreshArchive();
  }

  /** The people who are archived, by id: everyone archived, and those of them the captain archived (the "archive" tag). */
  private archivedPeople(): { archived: Set<number>; byHand: Set<number> } {
    const rows = this.db.prepare("SELECT id, is_self, edited_at, archive_rule FROM person").all() as
      { id: number; is_self: number; edited_at: number | null; archive_rule: string | null }[];
    const tags = this.tags.byPerson();
    const archived = new Set<number>();
    const byHand = new Set<number>();
    for (const row of rows) {
      const reason = archiveReason({ ...row, tags: tags.get(row.id) ?? [] });
      if (reason !== null) archived.add(row.id);
      if (reason === "you") byHand.add(row.id);
    }
    return { archived, byHand };
  }

  /**
   * People to join by name. Two people are one when a name of theirs is
   * character for character the same (sameName: only surrounding spaces and
   * invisible format characters are ignored, not case, accents or punctuation),
   * and it has two words or more or is in Chinese characters (joinsByName); a
   * lone word such as "Alex" is left to proposals. A person's names are their
   * own and each of their accounts' names, so an account the captain linked to
   * someone he renamed still joins its namesakes; and a chain of such names is
   * one person. Everyone but the captain and those he archived himself (the
   * "archive" tag) takes part, the people the archive rules archived included:
   * a join is then archived or shown by the rules as anyone else. Placeholder
   * labels ("Facebook user") never join. Anyone the captain has said is not one
   * of the others (a rejected proposal, or "Not them") is left out, even through
   * a third, and the rest join only through names they share. At most one of
   * them may be someone the captain has edited or linked an account to, and that
   * one is kept (two such are left to proposals); else the oldest is.
   */
  private findJoins(): Array<{ survivor: number; members: number[] }> {
    const { byHand } = this.archivedPeople();
    const chosen = this.chosenPeople();
    const namesOf = new Map<number, Set<string>>();
    const addName = (personId: number, name: string) => {
      if (byHand.has(personId) || isPlaceholderName(name) || !joinsByName(name)) return;
      namesOf.set(personId, (namesOf.get(personId) ?? new Set()).add(sameName(name)));
    };
    for (const row of this.db.prepare("SELECT id, name FROM person WHERE is_self = 0").all() as { id: number; name: string }[]) {
      addName(row.id, row.name);
    }
    for (const row of this.db
      .prepare("SELECT a.person_id, a.display_name FROM import_person a JOIN person p ON p.id = a.person_id WHERE p.is_self = 0 AND a.is_self = 0")
      .all() as { person_id: number; display_name: string }[]) addName(row.person_id, row.display_name);

    const rejected = this.rejectedPairs();
    const joins: Array<{ survivor: number; members: number[] }> = [];
    for (const group of sharingNames([...namesOf.keys()], namesOf)) {
      const members = group.filter((p) => !group.some((q) => rejected.has(`${p}:${q}`)));
      for (const part of sharingNames(members, namesOf)) {
        const fixed = part.filter((p) => chosen.has(p));
        if (part.length < 2 || fixed.length > 1) continue;
        joins.push({ survivor: fixed[0] ?? Math.min(...part), members: part });
      }
    }
    return joins;
  }

  /** People the captain has edited, or linked an account to: the rules never fold them into anyone. */
  private chosenPeople(): Set<number> {
    return new Set((this.db
      .prepare(
        `SELECT id FROM person WHERE edited_at IS NOT NULL
         UNION SELECT person_id FROM import_person WHERE link_source = 'captain' AND person_id IS NOT NULL`,
      )
      .all() as { id: number }[]).map((row) => row.id));
  }

  /** Every pair of people the captain has said are different, both ways round, as "a:b". */
  private rejectedPairs(): Set<string> {
    const rejected = new Set<string>();
    for (const row of this.proposalRows("rejected")) {
      const a = this.personOfKey(row.left_key);
      const b = this.personOfKey(row.right_key);
      if (a && b) rejected.add(`${a.id}:${b.id}`).add(`${b.id}:${a.id}`);
    }
    return rejected;
  }

  /** Makes a join one person, the survivor: the others' import people, tags, notes, reaching out, location, catch-ups, logged calls and drafts go to it, and they are deleted. */
  private join({ survivor, members }: { survivor: number; members: number[] }): void {
    const move = this.db.prepare("UPDATE import_person SET person_id = ?, link_source = 'rule:same-name', linked_at = ? WHERE person_id = ?");
    for (const id of members) {
      if (id === survivor) continue;
      move.run(survivor, Date.now(), id);
      this.tags.combine(survivor, id);
      this.foldNote(survivor, id);
      this.foldReachOut(survivor, id);
      this.foldLocation(survivor, id);
      this.combineEvents(survivor, id);
      this.deletePerson(id, survivor);
    }
  }

  /** People nobody chose who have no import person left are gone. */
  private dropEmpty(): void {
    for (const { id } of this.db
      .prepare("SELECT id FROM person p WHERE is_self = 0 AND edited_at IS NULL AND NOT EXISTS (SELECT 1 FROM import_person WHERE person_id = p.id)")
      .all() as { id: number }[]) this.deletePerson(id, null);
  }

  /** Recomputes pending proposals from the evidence; rejected ones stay rejected. */
  private refreshProposals(): void {
    const candidates = new Map<string, Evidence>();
    const propose = (a: string, b: string, evidence: Evidence) => {
      const key = a < b ? `${a}\n${b}` : `${b}\n${a}`;
      const known = candidates.get(key);
      if (!known || TIER_RANK[evidence.tier] > TIER_RANK[known.tier]) candidates.set(key, evidence);
    };

    // Everyone but the captain, people the captain archived and placeholder labels such as "Facebook user".
    const { archived, byHand } = this.archivedPeople();
    const accounts = (this.db
      .prepare(
        `SELECT a.platform, a.key, a.display_name, a.handle, a.person_id FROM import_person a JOIN person p ON p.id = a.person_id
         WHERE p.is_self = 0 AND a.is_self = 0`,
      )
      .all() as { platform: string; key: string; display_name: string; handle: string | null; person_id: number }[])
      .filter((account) => !isPlaceholderName(account.display_name) && !byHand.has(account.person_id));

    // The same phone number, whether or not the rules archived either side.
    const byPhone = new Map<string, string[]>();
    for (const account of accounts) {
      if (account.handle && isPhone(account.handle)) byPhone.set(account.handle, [...(byPhone.get(account.handle) ?? []), accountKey(account)]);
    }
    for (const [phone, keys] of byPhone) eachPair(keys, (x, y) => propose(x, y, { rule: "phone-match", tier: "high", detail: phone }));

    // Each shown account's name, and the name of each person the captain has edited (which may be no account's).
    const edited = (this.db.prepare("SELECT id, name FROM person WHERE edited_at IS NOT NULL AND is_self = 0").all() as
      { id: number; name: string }[]).filter((p) => !byHand.has(p.id));
    const identities = [
      ...accounts.filter((a) => !archived.has(a.person_id)).map((a) => ({ key: accountKey(a), name: a.display_name })),
      ...edited.map((p) => ({ key: `person:${p.id}`, name: p.name })),
    ]
      .map((identity) => ({ ...identity, same: sameName(identity.name), words: nameKey(identity.name).split(" ").filter(Boolean) }))
      .filter((identity) => identity.words.length > 0 && !isPlaceholderName(identity.name));
    eachPair(identities, (x, y) => {
      const evidence = nameEvidence(x, y);
      if (evidence) propose(x.key, y.key, evidence);
    });

    const existing = new Map(this.proposalRows().map((row) => [`${row.left_key}\n${row.right_key}`, row]));
    const insert = this.db.prepare(
      `INSERT INTO merge_proposal (left_key, right_key, rule, tier, evidence_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    );
    const update = this.db.prepare("UPDATE merge_proposal SET rule = ?, tier = ?, evidence_json = ? WHERE id = ?");
    for (const [key, evidence] of candidates) {
      const [left, right] = key.split("\n");
      // Proposals that are already true, or between two people the captain has edited, are left out.
      if (!this.pairOf(left, right)) continue;
      const json = JSON.stringify({ rule: evidence.rule, detail: evidence.detail });
      const row = existing.get(key);
      if (!row) insert.run(left, right, evidence.rule, evidence.tier, json, Date.now());
      else if (row.status === "pending" && (row.rule !== evidence.rule || row.evidence_json !== json)) {
        update.run(evidence.rule, evidence.tier, json, row.id);
      }
      existing.delete(key);
    }
    const drop = this.db.prepare("DELETE FROM merge_proposal WHERE id = ?");
    for (const row of existing.values()) if (row.status === "pending") drop.run(row.id);
  }

  // --- helpers

  /** Runs one of the captain's edits to a person, marking them edited unless `trivial` and they never were. Returns their id. */
  private edit(personId: number, work: () => void, trivial = false): number {
    const person = this.person(personId);
    if (trivial && person.edited_at === null && JSON.parse(person.aliases_json).length === 0 && this.tags.of(person.id).length === 0) {
      return person.id;
    }
    transaction(this.db, () => {
      work();
      this.touch(person.id);
      this.changed();
    });
    return person.id;
  }

  private mergeNow(kept: PersonRow, other: PersonRow, name: string): void {
    const union = (a: string, b: string) => JSON.stringify([...new Set([...(JSON.parse(a) as string[]), ...(JSON.parse(b) as string[])])]);
    this.db.prepare("UPDATE import_person SET person_id = ?, link_source = 'captain', linked_at = ? WHERE person_id = ?").run(kept.id, Date.now(), other.id);
    this.db
      .prepare("UPDATE person SET name = ?, name_source = 'captain', aliases_json = ? WHERE id = ?")
      .run(name, union(kept.aliases_json, other.aliases_json), kept.id);
    // The kept person keeps its own archive state: the captain picked it, so "archive" or "keep" on the other never hides or shows it.
    this.tags.combine(kept.id, other.id, { archiveState: false });
    this.foldNote(kept.id, other.id);
    this.foldReachOut(kept.id, other.id);
    this.foldLocation(kept.id, other.id);
    this.combineEvents(kept.id, other.id);
    // A group chat either was unlinked from connects the one kept through it to nobody.
    this.db
      .prepare("INSERT OR IGNORE INTO group_unlink (person_id, conversation_id, unlinked_at) SELECT ?, conversation_id, unlinked_at FROM group_unlink WHERE person_id = ?")
      .run(kept.id, other.id);
    this.touch(kept.id);
    this.deletePerson(other.id, kept.id);
  }

  /**
   * Adds `fromId`'s note to `intoId`'s (see combineNotes), before `fromId` is
   * deleted. The note stays the address book's to write again only when both
   * were the address book's (or empty); otherwise it holds the captain's words.
   */
  private foldNote(intoId: number, fromId: number): void {
    const read = this.db.prepare("SELECT note, address_book_note FROM person WHERE id = ?");
    const into = read.get(intoId) as { note: string; address_book_note: string | null };
    const from = read.get(fromId) as { note: string; address_book_note: string | null };
    const note = combineNotes(into.note, from.note);
    if (note === into.note) return;
    const bookNote = fromAddressBook(into) && fromAddressBook(from) ? note : into.address_book_note;
    this.db.prepare("UPDATE person SET note = ?, address_book_note = ? WHERE id = ?").run(note, bookNote, intoId);
  }

  /** `intoId` is to be reached out to if either was, before `fromId` is deleted. */
  private foldReachOut(intoId: number, fromId: number): void {
    this.db
      .prepare("UPDATE person SET should_reach_out = 1 WHERE id = ? AND should_reach_out = 0 AND (SELECT should_reach_out FROM person WHERE id = ?) = 1")
      .run(intoId, fromId);
  }

  /** `intoId` takes `fromId`'s catch-ups, logged calls and drafts, before `fromId` is deleted. */
  private combineEvents(intoId: number, fromId: number): void {
    this.catchUps.combine(intoId, fromId);
    this.manualCalls.combine(intoId, fromId);
    this.drafts.combine(intoId, fromId);
  }

  /**
   * `intoId` takes `fromId`'s location where it has none; a different one (not only in case) goes into its note as a
   * line ("Location: Brisbane"), as combineNotes adds notes. Before `fromId` is deleted.
   */
  private foldLocation(intoId: number, fromId: number): void {
    const read = this.db.prepare("SELECT note, location FROM person WHERE id = ?");
    const into = read.get(intoId) as { note: string; location: string | null };
    const from = read.get(fromId) as { note: string; location: string | null };
    if (from.location === null || from.location.toLowerCase() === into.location?.toLowerCase()) return;
    if (into.location === null) {
      this.db.prepare("UPDATE person SET location = ? WHERE id = ?").run(from.location, intoId);
      return;
    }
    const combined = combineNotes(into.note, `Location: ${from.location}`);
    if (combined !== into.note) this.db.prepare("UPDATE person SET note = ? WHERE id = ?").run(combined, intoId);
  }

  private linkNow(importPersonId: number, personId: number, source: LinkSource): void {
    this.db.prepare("UPDATE import_person SET person_id = ?, link_source = ?, linked_at = ? WHERE id = ?").run(personId, source, Date.now(), importPersonId);
  }

  private newPerson(name: string): number {
    const now = Date.now();
    return this.seeded(Number(this.db.prepare("INSERT INTO person (name, name_source, created_at) VALUES (?, 'import', ?)").run(name, now).lastInsertRowid), now);
  }

  /** Gives anyone without a well-formed identicon seed (only a row made outside People) the one they would have been given. */
  private seedIdenticons(): void {
    const unseeded = this.db
      .prepare("SELECT id, created_at FROM person WHERE identicon_seed IS NULL OR length(identicon_seed) != 16 OR identicon_seed GLOB '*[^0-9a-f]*'")
      .all() as { id: number; created_at: number }[];
    for (const { id, created_at } of unseeded) this.seeded(id, created_at);
  }

  /** Gives a person just made their identicon's seed (src/identicon.ts), from their id and when they were made. */
  private seeded(id: number, createdAt: number): number {
    this.db.prepare("UPDATE person SET identicon_seed = ? WHERE id = ?").run(identiconSeedOf(id, createdAt), id);
    return id;
  }

  /**
   * Deletes a person with no import people left. What was said about them is said about `into`, if given; they are
   * no longer at any catch-up, and a catch-up left with nobody goes too.
   */
  private deletePerson(id: number, into: number | null): void {
    const key = `person:${id}`;
    const rows = this.db.prepare("SELECT id, left_key, right_key, status FROM merge_proposal WHERE left_key = ? OR right_key = ?").all(key, key) as
      { id: number; left_key: string; right_key: string; status: string }[];
    for (const row of rows) {
      this.db.prepare("DELETE FROM merge_proposal WHERE id = ?").run(row.id);
      if (into === null || row.status !== "rejected") continue;
      const other = row.left_key === key ? row.right_key : row.left_key;
      if (other !== `person:${into}`) this.rejectPair(`person:${into}`, other, "merged");
    }
    this.db.prepare("DELETE FROM person WHERE id = ?").run(id);
    this.catchUps.dropEmpty();
  }

  private dropIfEmpty(personId: number): void {
    const left = (this.db.prepare("SELECT count(*) AS n FROM import_person WHERE person_id = ?").get(personId) as { n: number }).n;
    const person = this.db.prepare("SELECT edited_at, is_self FROM person WHERE id = ?").get(personId) as { edited_at: number | null; is_self: number } | undefined;
    if (left === 0 && person && person.edited_at === null && !person.is_self) this.deletePerson(personId, null);
  }

  private rejectPair(a: string, b: string, rule: string): void {
    const [left, right] = [a, b].sort();
    this.db
      .prepare(
        `INSERT INTO merge_proposal (left_key, right_key, rule, tier, evidence_json, status, created_at, decided_at)
         VALUES (?, ?, ?, 'low', '{}', 'rejected', ?, ?)
         ON CONFLICT (left_key, right_key) DO UPDATE SET status = 'rejected', decided_at = excluded.decided_at`,
      )
      .run(left, right, rule, Date.now(), Date.now());
  }

  private touch(personId: number): void {
    this.db.prepare("UPDATE person SET edited_at = ? WHERE id = ? AND is_self = 0").run(Date.now(), personId);
  }

  /** Marks people (unless `people` is false) and, with `links`, what the messages add up to per person, as changed. */
  private changed({ people = true, links = false } = {}): void {
    if (people) bumpMeta(this.db, "people_version");
    if (links) bumpMeta(this.db, "links_version");
  }

  /** The two different people a proposal is about, or null if they are one already, one is the captain, or both are edited by the captain. */
  private pairOf(left: string, right: string): [number, number] | null {
    const a = this.personOfKey(left);
    const b = this.personOfKey(right);
    if (a === null || b === null || a.id === b.id || a.is_self || b.is_self || (a.edited_at !== null && b.edited_at !== null)) return null;
    return a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  }

  private personOfKey(key: string): PersonRow | null {
    let row: PersonRow | undefined;
    if (key.startsWith("person:")) {
      row = this.db.prepare("SELECT * FROM person WHERE id = ?").get(Number(key.slice("person:".length))) as PersonRow | undefined;
    } else {
      const [, platform, ...rest] = key.split(":");
      row = this.db
        .prepare("SELECT p.* FROM import_person a JOIN person p ON p.id = a.person_id WHERE a.platform = ? AND a.key = ?")
        .get(platform, rest.join(":")) as PersonRow | undefined;
    }
    return row ?? null;
  }

  private proposalRows(status?: "pending" | "rejected"): ProposalRow[] {
    const sql = "SELECT id, left_key, right_key, rule, tier, evidence_json, status FROM merge_proposal";
    return (status
      ? this.db.prepare(`${sql} WHERE status = ? ORDER BY id`).all(status)
      : this.db.prepare(`${sql} ORDER BY id`).all()) as unknown as ProposalRow[];
  }

  private person(id: number, { allowSelf = false } = {}): PersonRow {
    if (!Number.isSafeInteger(id)) throw new InvalidInputError("give a person number");
    const row = this.db.prepare("SELECT * FROM person WHERE id = ?").get(id) as PersonRow | undefined;
    if (!row) throw new NotFoundError(`no person ${id}`);
    if (row.is_self && !allowSelf) throw new InvalidInputError("that is you");
    return row;
  }

  private importPerson(id: number): { id: number; platform: string; key: string; display_name: string; person_id: number | null; is_self: number } {
    if (!Number.isSafeInteger(id)) throw new InvalidInputError("give an account number");
    const row = this.db.prepare("SELECT id, platform, key, display_name, person_id, is_self FROM import_person WHERE id = ?").get(id) as
      ReturnType<People["importPerson"]> | undefined;
    if (!row) throw new NotFoundError(`no account ${id}`);
    return row;
  }

  private exists(personId: number): boolean {
    return this.db.prepare("SELECT 1 FROM person WHERE id = ?").get(personId) !== undefined;
  }

  private isSelf(personId: number): boolean {
    return (this.db.prepare("SELECT is_self FROM person WHERE id = ?").get(personId) as { is_self: number } | undefined)?.is_self === 1;
  }

  private selfId(): number {
    const row = this.db.prepare("SELECT id FROM person WHERE is_self = 1 ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    if (row) return row.id;
    const now = Date.now();
    return this.seeded(Number(this.db.prepare("INSERT INTO person (name, name_source, is_self, created_at) VALUES ('Me', 'import', 1, ?)").run(now).lastInsertRowid), now);
  }

  private aliasesOf(personId: number): string[] {
    return JSON.parse(this.person(personId).aliases_json) as string[];
  }

  private tagsOf(personId: number): string[] {
    return this.tags.of(this.person(personId, { allowSelf: true }).id);
  }

  private messageCount(personId: number): number {
    return (this.db
      .prepare(
        `SELECT coalesce(sum(s.direct_count + s.group_count), 0) AS n FROM import_person ip
         JOIN import_person_stats s ON s.import_person_id = ip.id WHERE ip.person_id = ?`,
      )
      .get(personId) as { n: number }).n;
  }
}

interface Identity {
  key: string;
  name: string;
  /** The name as sameName compares it. */
  same: string;
  words: string[];
}

/**
 * How alike two names are, when that is worth asking the captain about:
 *   character for character the same (see sameName)                   name-exact (medium)
 *   the same, but a lone word that isn't Chinese ("Alex" / "Alex")     name-one-word (low)
 *   two or more words, all in the other ("Rowan Quill" / "Rowan Ryan Quill") name-contained (medium)
 * Nothing looser is proposed: not names that differ only in case, accents or
 * punctuation, a lone first name, or the same first name and last initial.
 * People with the same name of two words or more, or in Chinese, are joined by
 * the rules (findJoins), shown or archived by the rules, so name-exact is left
 * for those a join can't take, such as two people the captain has edited with
 * one name, or a third with the name of two he said are different.
 */
export function nameEvidence(x: Identity, y: Identity): Evidence | null {
  const detail = `${x.name} / ${y.name}`;
  if (x.same === y.same) {
    return joinsByName(x.name) ? { rule: "name-exact", tier: "medium", detail } : { rule: "name-one-word", tier: "low", detail };
  }
  const [short, long] = x.words.length <= y.words.length ? [x.words, y.words] : [y.words, x.words];
  if (short.length < 2 || short.join(" ") === long.join(" ")) return null;
  return short.every((word) => long.includes(word)) ? { rule: "name-contained", tier: "medium", detail } : null;
}

/** Whether a note is the address book's to write: empty, or still exactly as the address book last wrote it. */
function fromAddressBook(row: { note: string; address_book_note: string | null }): boolean {
  return row.note === "" || row.note === row.address_book_note;
}

function accountKey(account: { platform: string; key: string }): string {
  return `account:${account.platform}:${account.key}`;
}

/** `people` (ids) in groups that share a name, through a chain of names if need be (each person's names in `namesOf`). */
function sharingNames(people: number[], namesOf: Map<number, Set<string>>): number[][] {
  const parent = new Map(people.map((id) => [id, id]));
  const root = (id: number): number => {
    while (parent.get(id) !== id) id = parent.get(id)!;
    return id;
  };
  const firstWithName = new Map<string, number>();
  for (const id of people) {
    for (const name of namesOf.get(id) ?? []) {
      const other = firstWithName.get(name);
      if (other === undefined) firstWithName.set(name, id);
      else parent.set(root(id), root(other));
    }
  }
  const groups = new Map<number, number[]>();
  for (const id of people) groups.set(root(id), [...(groups.get(root(id)) ?? []), id]);
  return [...groups.values()];
}

function eachPair<T>(items: T[], visit: (a: T, b: T) => void): void {
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) visit(items[i], items[j]);
}
