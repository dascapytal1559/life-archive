import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArchiveEvent, type Db, sameName, transaction } from "../../../sdk/server.ts";
import { openArchive } from "./db.ts";
import { nameEvidence, People } from "./people.ts";
import { ArchiveStructure } from "./structure.ts";
import { ImportSession } from "./write.ts";

let dataDir: string;
let db: Db;
let people: People;
let structure: ArchiveStructure;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-people-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  people = new People(db);
  structure = new ArchiveStructure(db, people);
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * Imports a Messenger-like chat per name: each person says one thing to the captain, directly (and the
 * captain answers, so the automatic archive rules leave them on the map) or in a group (a big one, of
 * `crowd` more silent members, is too big for the small-group rule to keep anyone).
 */
function importChats(chats: Array<{ name: string; group?: string; crowd?: number }>, platform = "messenger"): void {
  const events: ArchiveEvent[] = [{ kind: "account", key: "Me", keyKind: "name", displayName: "Me", isSelf: true }];
  chats.forEach(({ name, group, crowd = 0 }, i) => {
    const others = Array.from({ length: crowd }, (_, n) => `${group} member ${n + 1}`);
    for (const key of [name, ...others]) events.push({ kind: "account", key, keyKind: "name", displayName: key });
    const conversation = group ?? `direct-${name}`;
    events.push({ kind: "conversation", id: conversation, type: group ? "group" : "direct", title: group ?? name, members: ["Me", name, ...others] });
    events.push({
      kind: "message", id: `${platform}-${name}-${i}`, idKind: "platform", conversation, sender: name, isFromSelf: false,
      sentAt: 1_700_000_000_000 + i * 1000, type: "text", text: `message ${i}`, raw: {},
    });
    if (!group) {
      events.push({
        kind: "message", id: `${platform}-${name}-${i}-reply`, idKind: "platform", conversation, sender: "Me", isFromSelf: true,
        sentAt: 1_700_000_000_500 + i * 1000, type: "text", text: `reply ${i}`, raw: {},
      });
    }
  });
  transaction(db, () => {
    const source = Number(
      db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'export', 'test', 0, 'ok')")
        .run(platform).lastInsertRowid,
    );
    const session = new ImportSession(db, platform, source, "export");
    for (const event of events) session.apply(event);
  });
}

/** Imports, then runs the rules, as an import does (Archive.importHistory). */
function importAndRun(chats: Array<{ name: string; group?: string }>, platform = "messenger"): void {
  importChats(chats, platform);
  people.runRules();
}

const names = () => structure.listPeople().people.map((p) => p.name).sort();
const personNamed = (name: string) => structure.listPeople().people.find((p) => p.name === name)!;
const accountOf = (platform: string, key: string) =>
  (db.prepare("SELECT id, person_id, link_source FROM import_person WHERE platform = ? AND key = ?").get(platform, key) as
    { id: number; person_id: number; link_source: string });

describe("people", () => {
  it("makes one person per account, keeps the captain out, and gives unknown accounts no proposals", () => {
    importAndRun([{ name: "Ada Sample" }, { name: "Facebook user" }, { name: "Gus", group: "Climbing" }]);
    const listing = structure.listPeople();
    expect(names()).toEqual(["Ada Sample", "Facebook user", "Gus"]);
    expect(listing.me?.accounts.map((a) => a.displayName)).toEqual(["Me"]);
    expect(personNamed("Facebook user").unknown).toBe(true);
    expect(personNamed("Gus")).toMatchObject({ directMessageCount: 0, groupMessageCount: 1, tags: [], aliases: [], edited: false });
    expect(personNamed("Ada Sample")).toMatchObject({ directMessageCount: 2, groupMessageCount: 0 });
    expect(personNamed("Ada Sample").accounts.map((a) => a.link)).toEqual(["import"]);
    expect(structure.proposals()).toEqual([]);
  });

  it("names, aliases and tags anyone in the table itself, with no file anywhere", async () => {
    importAndRun([{ name: "Hana Newface" }]);
    const hana = personNamed("Hana Newface").id;
    // Clearing nothing on someone never edited leaves them unedited.
    expect(people.setTags(hana, [])).toBe(hana);
    expect(structure.getPerson(hana)).toMatchObject({ edited: false });

    expect(people.setTags(hana, ["Climbing", "climbing ", "sibling"])).toBe(hana);
    people.setAliases(hana, ["Hana", " Hana ", "H.N."]);
    people.addAlias(hana, "Hanako");
    people.removeAlias(hana, "H.N.");
    people.setName(hana, "  Hana   Newface-Smith ");
    people.addTags(hana, ["work"]);
    people.removeTags(hana, ["sibling"]);
    expect(structure.getPerson(hana)).toMatchObject({
      id: hana, name: "Hana Newface-Smith", aliases: ["Hana", "Hanako"], tags: ["climbing", "work"], edited: true, messageCount: 2,
    });
    // Found by an alias, labelled by the first.
    expect(structure.listPeople({ query: "hanako" }).people.map((p) => p.id)).toEqual([hana]);

    expect(() => people.setTags(hana, ["not/ok"])).toThrow(/not a tag/);
    expect(() => people.setTags(hana, ["System-Archive"])).toThrow(/is not a tag/);
    expect(() => people.setTags(hana, ["me"])).toThrow(/This is me/);
    expect(() => people.setName(hana, "   ")).toThrow(/empty/);
    expect(() => people.setAliases(hana, "Hana")).toThrow(/list/);
    expect(() => people.removeAlias(hana, "Nobody")).toThrow(/no alias/);
    expect(() => people.setName(999, "Ghost")).toThrow(/no person 999/);
    // Nothing is written outside the archive.
    expect(await readdir(dataDir)).toEqual(expect.not.arrayContaining(["friends", "people"]));

    // A later import renames what it found, but the captain's name stays.
    importAndRun([{ name: "Hana Newface" }]);
    expect(structure.getPerson(hana)).toMatchObject({ name: "Hana Newface-Smith", aliases: ["Hana", "Hanako"] });
  });

  it("follows a renamed account's name until the captain names the person", () => {
    importAndRun([{ name: "Ada Sample" }]);
    const ada = personNamed("Ada Sample").id;
    db.prepare("UPDATE import_person SET display_name = 'Ada Sample-Jones' WHERE key = 'Ada Sample'").run();
    people.runRules();
    expect(structure.getPerson(ada)!.name).toBe("Ada Sample-Jones");
    people.setName(ada, "Ada");
    db.prepare("UPDATE import_person SET display_name = 'Ada S' WHERE key = 'Ada Sample'").run();
    people.runRules();
    expect(structure.getPerson(ada)!.name).toBe("Ada");
  });

  it("keeps every name as one list, the first their name: an alias put first is their name, and nobody is left without one", () => {
    importAndRun([{ name: "Ada Sample" }]);
    const ada = personNamed("Ada Sample").id;
    const nameSource = () => (db.prepare("SELECT name_source FROM person WHERE id = ?").get(ada) as { name_source: string }).name_source;
    // An alias added after their name leaves the name the import's, so it still follows the account.
    people.setNames(ada, ["Ada Sample", " Addy ", "Ada S", "Addy"]);
    expect(structure.getPerson(ada)).toMatchObject({ name: "Ada Sample", aliases: ["Addy", "Ada S"], edited: true });
    expect(nameSource()).toBe("import");
    // Dragged first, an alias is their name, the captain's; the name before it stays an alias, where it was dropped.
    people.setNames(ada, ["Ada S", "Ada Sample", "Addy"]);
    expect(structure.getPerson(ada)).toMatchObject({ name: "Ada S", aliases: ["Ada Sample", "Addy"] });
    expect(nameSource()).toBe("captain");
    db.prepare("UPDATE import_person SET display_name = 'Ada Sample-Jones' WHERE key = 'Ada Sample'").run();
    people.runRules();
    expect(structure.getPerson(ada)!.name).toBe("Ada S");
    // The last name can't go.
    expect(() => people.setNames(ada, [])).toThrow(/at least one name/);
    expect(() => people.setNames(ada, [" "])).toThrow(/empty/);
    expect(() => people.setNames(ada, "Ada")).toThrow(/list/);
    // set-name on one of their aliases puts it first, as a drag does; on a new name it takes the name's place.
    people.setName(ada, "Addy");
    expect(structure.getPerson(ada)).toMatchObject({ name: "Addy", aliases: ["Ada S", "Ada Sample"] });
    people.setName(ada, "Ada Lovelace");
    expect(structure.getPerson(ada)).toMatchObject({ name: "Ada Lovelace", aliases: ["Ada S", "Ada Sample"] });
    // Their name is never one of their aliases too.
    people.setAliases(ada, ["Ada Lovelace", "Ada S"]);
    expect(structure.getPerson(ada)).toMatchObject({ name: "Ada Lovelace", aliases: ["Ada S"] });
  });

  it("adds a person by hand, and joins them with the account of exactly their name when the rules run", () => {
    const cleo = people.create("Cleo Example");
    expect(structure.getPerson(cleo)).toMatchObject({ accounts: [], edited: true });
    importAndRun([{ name: "Cleo Example" }, { name: "Cléo Example" }]);
    // The hand-made person is kept and gains the account; "Cléo Example" differs by an accent, so is left alone.
    expect(structure.getPerson(cleo)).toMatchObject({ messageCount: 2, joined: { rule: "same-name" } });
    expect(structure.getPerson(cleo)!.accounts.map((a) => [a.displayName, a.link])).toEqual([["Cleo Example", "rule:same-name"]]);
    expect(names()).toEqual(["Cleo Example", "Cléo Example"]);
  });
});

describe("merging, the captain's way", () => {
  it("re-points the other's accounts to the one kept, adds its aliases and tags, and deletes it", () => {
    importAndRun([{ name: "Sam Smith" }, { name: "Samuel S" }]);
    const sam = personNamed("Sam Smith").id;
    const samuel = personNamed("Samuel S").id;
    people.setAliases(sam, ["Sammy"]);
    people.setTags(sam, ["climbing"]);
    people.setAliases(samuel, ["Sammy", "Sam S"]);
    people.setTags(samuel, ["work", "climbing"]);

    expect(people.merge(sam, samuel)).toBe(sam);
    expect(structure.getPerson(samuel)).toBeNull();
    expect(db.prepare("SELECT count(*) AS n FROM person WHERE id = ?").get(samuel)).toEqual({ n: 0 });
    expect(structure.getPerson(sam)).toMatchObject({ name: "Sam Smith", aliases: ["Sammy", "Sam S"], tags: ["climbing", "work"], messageCount: 4 });
    expect(accountOf("messenger", "Samuel S")).toMatchObject({ person_id: sam, link_source: "captain" });
    expect(accountOf("messenger", "Sam Smith")).toMatchObject({ person_id: sam, link_source: "import" });
    expect(() => people.merge(sam, sam)).toThrow(/same person/);
    expect(() => people.merge(sam, samuel)).toThrow(/no person/);
  });

  it("keeps the other's name when the captain chooses it", () => {
    importAndRun([{ name: "Bo" }, { name: "Robert Bo" }]);
    const kept = people.merge(personNamed("Bo").id, personNamed("Robert Bo").id, { name: "other" });
    expect(structure.getPerson(kept)).toMatchObject({ name: "Robert Bo", edited: true });
  });

  it("confirming a proposal keeps the person the captain edited, else the one with more messages", () => {
    importAndRun([{ name: "Bruno P" }, { name: "Bruno Ryan P" }]);
    const bruno = personNamed("Bruno Ryan P").id;
    people.setAliases(bruno, ["BTP"]);
    const [proposal] = structure.proposals();
    expect(proposal).toMatchObject({ tier: "medium", evidence: [{ rule: "name-contained" }] });
    expect(people.confirm(proposal.id)).toBe(bruno);
    expect(structure.getPerson(bruno)!.accounts.map((a) => [a.displayName, a.link]).sort()).toEqual([
      ["Bruno P", "captain"], ["Bruno Ryan P", "import"],
    ]);
    expect(structure.proposals()).toEqual([]);
  });

  it("\"Not them\" splits an account out into a fresh person, and the two are never joined or proposed again", () => {
    importAndRun([{ name: "Bruno Placeholder" }, { name: "Bruno Ryan Placeholder" }]);
    const kept = people.confirm(structure.proposals()[0].id);
    const ryan = structure.getPerson(kept)!.accounts.find((a) => a.displayName === "Bruno Ryan Placeholder")!;
    const fresh = people.detach(kept, ryan.id);
    expect(fresh).not.toBe(kept);
    expect(structure.getPerson(fresh)).toMatchObject({ name: "Bruno Ryan Placeholder", accounts: [{ id: ryan.id, link: "captain" }] });
    expect(structure.getPerson(kept)!.accounts.map((a) => a.displayName)).toEqual(["Bruno Placeholder"]);
    people.runRules();
    expect(names()).toEqual(["Bruno Placeholder", "Bruno Ryan Placeholder"]);
    expect(structure.proposals()).toEqual([]);
    expect(() => people.detach(kept, structure.getPerson(kept)!.accounts[0].id)).toThrow(/only account/);
  });

  it("rejected proposals stay rejected, and a manual merge works without one", () => {
    importAndRun([{ name: "Sam Smith" }, { name: "Sam Quorvel Smith" }, { name: "Tom" }]);
    const [proposal] = structure.proposals();
    people.reject(proposal.id);
    people.runRules();
    expect(structure.proposals()).toEqual([]);
    const merged = people.merge(personNamed("Sam Smith").id, personNamed("Tom").id);
    expect(structure.getPerson(merged)?.accounts.map((a) => a.displayName).sort()).toEqual(["Sam Smith", "Tom"]);
  });

  it("\"This is me\" gives a person's accounts to the captain", () => {
    importAndRun([{ name: "Riley Old Name" }, { name: "Ada Sample" }]);
    const riley = personNamed("Riley Old Name").id;
    const me = people.markAsMe(riley);
    expect(names()).toEqual(["Ada Sample"]);
    expect(structure.getPerson(riley)).toBeNull();
    expect(structure.listPeople().me).toMatchObject({ id: me });
    expect(structure.listPeople().me!.accounts.map((a) => [a.displayName, a.link]).sort()).toEqual([["Me", "import"], ["Riley Old Name", "captain"]]);
    // And taking it back makes them someone again.
    const fresh = people.detach(me, accountOf("messenger", "Riley Old Name").id);
    expect(structure.getPerson(fresh)).toMatchObject({ name: "Riley Old Name", archived: null });
  });

  it("deletes a person only when they have no accounts left, and never the captain", () => {
    importAndRun([{ name: "Ada Sample" }]);
    const ada = personNamed("Ada Sample");
    expect(() => people.delete(ada.id)).toThrow(/still has 1 account/);
    expect(() => people.delete(structure.listPeople().me!.id)).toThrow(/that is you/);
    const lew = people.create("Lew Example");
    people.addAlias(lew, "Ada Sample");
    people.delete(lew);
    expect(structure.getPerson(lew)).toBeNull();
    expect(names()).toEqual(["Ada Sample"]);
    expect(structure.getPerson(ada.id)).toMatchObject({ messageCount: ada.messageCount, accounts: ada.accounts });
  });
});

describe("joining a deleted or unknown account into the person it is", () => {
  // Instagram's export names every deleted account "Instagram User", one account per chat
  // (keyed "Instagram User #<chat>"), and the rules archive each as unknown.
  const events: ArchiveEvent[] = [{ kind: "account", key: "Me", keyKind: "name", displayName: "Me", isSelf: true }];
  for (const [key, name] of [["Ada Sample", "Ada Sample"], ["Bo Example", "Bo Example"], ["Instagram User #a1", "Instagram User"], ["Instagram User #b2", "Instagram User"]]) {
    events.push({ kind: "account", key, keyKind: "name", displayName: name });
    events.push({ kind: "conversation", id: `direct-${key}`, type: "direct", title: name, members: ["Me", key] });
    events.push({ kind: "message", id: `${key}-1`, idKind: "platform", conversation: `direct-${key}`, sender: key, isFromSelf: false, sentAt: 1_700_000_000_000, type: "text", text: "hi", raw: {} });
    events.push({ kind: "message", id: `${key}-2`, idKind: "platform", conversation: `direct-${key}`, sender: "Me", isFromSelf: true, sentAt: 1_700_000_001_000, type: "text", text: "hi", raw: {} });
  }
  /** Imports the export, as Archive.importHistory does: the events, then the rules. */
  const importExport = () => {
    transaction(db, () => {
      const source = Number(db.prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES ('instagram', 'test', 'export', 'test', 0, 'ok')").run().lastInsertRowid);
      const session = new ImportSession(db, "instagram", source, "export");
      for (const event of events) session.apply(event);
    });
    people.runRules();
  };
  const unknownOf = (key: string) => accountOf("instagram", key).person_id;
  /** Closes the archive and opens it again, rules and all, as a restart after an upgrade does. */
  const reopen = () => {
    db.close();
    db = openArchive(join(dataDir, "archive.sqlite"));
    people = new People(db);
    structure = new ArchiveStructure(db, people);
    people.runRules();
  };

  it("joins one the rules archived, straight from the archive, and it stays joined through a new import and a reopen", () => {
    importExport();
    const ada = personNamed("Ada Sample").id;
    const deleted = unknownOf("Instagram User #a1");
    expect(structure.getPerson(deleted)).toMatchObject({ unknown: true, archived: "unknown" });

    expect(people.merge(ada, deleted)).toBe(ada);
    const joined = () => {
      expect(structure.getPerson(deleted)).toBeNull();
      expect(accountOf("instagram", "Instagram User #a1")).toMatchObject({ person_id: ada, link_source: "captain" });
      expect(structure.getPerson(ada)).toMatchObject({ name: "Ada Sample", unknown: false, archived: null, archiveRule: null, messageCount: 4 });
      // The other chat's deleted account is someone else, still archived.
      expect(structure.getPerson(unknownOf("Instagram User #b2"))).toMatchObject({ unknown: true, archived: "unknown" });
    };
    joined();
    importExport();
    joined();
    reopen();
    joined();
  });

  it("joins one after Unarchive too, and the person kept keeps its own archive state", () => {
    importExport();
    const ada = personNamed("Ada Sample").id;
    const bo = personNamed("Bo Example").id;
    const first = unknownOf("Instagram User #a1");
    const second = unknownOf("Instagram User #b2");
    // Unarchive, as the panel does: the rule would archive them again, so "keep".
    people.setTags(first, ["keep"]);
    expect(structure.getPerson(first)).toMatchObject({ archived: null });
    people.setTags(ada, ["archive"]);
    people.setTags(second, ["archive"]);

    people.merge(ada, first);
    people.merge(bo, second);
    reopen();
    expect(structure.getPerson(ada)).toMatchObject({ archived: "you", tags: ["archive"] });
    expect(structure.getPerson(bo)).toMatchObject({ archived: null, tags: [] });
    expect(accountOf("instagram", "Instagram User #b2")).toMatchObject({ person_id: bo, link_source: "captain" });
  });
});

describe("reaching out", () => {
  it("sets and clears should reach out, marking the person edited, and lists who to reach out to", () => {
    importAndRun([{ name: "Ada Sample" }, { name: "Bea Test" }]);
    const ada = personNamed("Ada Sample").id;
    expect(personNamed("Ada Sample")).toMatchObject({ shouldReachOut: false, edited: false });
    expect(structure.listPeople({ reachOut: true }).people).toEqual([]);

    const before = people.version();
    people.setShouldReachOut(ada, true);
    expect(people.version()).not.toBe(before);
    expect(structure.getPerson(ada)).toMatchObject({ shouldReachOut: true, edited: true });
    expect(structure.listPeople({ reachOut: true }).people.map((p) => p.name)).toEqual(["Ada Sample"]);
    expect(structure.relationships().people.find((p) => p.id === ada)).toMatchObject({ shouldReachOut: true });
    expect(structure.relationships().people.find((p) => p.name === "Bea Test")).toMatchObject({ shouldReachOut: false });

    // Setting what is already there changes nothing.
    const now = people.version();
    people.setShouldReachOut(ada, true);
    expect(people.version()).toBe(now);

    expect(() => people.setShouldReachOut(ada, "yes")).toThrow(/true or false/);
    expect(() => people.setShouldReachOut(structure.listPeople().me!.id, true)).toThrow(/that is you/);

    people.setShouldReachOut(ada, false);
    expect(structure.getPerson(ada)).toMatchObject({ shouldReachOut: false });
    expect(structure.listPeople({ reachOut: true }).people).toEqual([]);
  });

  it("a merge keeps should reach out if either had it, and gives the one kept both's drafts", () => {
    importAndRun([{ name: "Sam Smith" }, { name: "Samuel S" }, { name: "Cy Other" }, { name: "Cy O" }]);
    const [sam, samuel] = [personNamed("Sam Smith").id, personNamed("Samuel S").id];
    people.drafts.add(sam, "Coffee?");
    people.setShouldReachOut(samuel, true);
    people.drafts.add(samuel, "How was Japan?");
    people.merge(sam, samuel);
    expect(structure.getPerson(sam)).toMatchObject({ shouldReachOut: true });
    expect(people.drafts.list(sam).map((d) => d.text)).toEqual(["Coffee?", "How was Japan?"]);

    // Neither flagged: nothing flagged.
    const [cy, cyO] = [personNamed("Cy Other").id, personNamed("Cy O").id];
    people.merge(cy, cyO);
    expect(structure.getPerson(cy)).toMatchObject({ shouldReachOut: false });
  });

  it("a join by name carries should reach out and the drafts into the person kept", () => {
    importAndRun([{ name: "Ada Sample" }]);
    // As the rules could find someone never edited: flagged with a draft (by an older archive, say).
    const joinedAway = personNamed("Ada Sample").id;
    db.prepare("UPDATE person SET should_reach_out = 1 WHERE id = ?").run(joinedAway);
    people.drafts.add(joinedAway, "Hi Ada");
    const ada = people.create("Ada Sample");
    people.drafts.add(ada, "Coffee?");
    people.runRules();
    expect(structure.getPerson(joinedAway)).toBeNull();
    expect(structure.getPerson(ada)).toMatchObject({ shouldReachOut: true });
    expect(people.drafts.list(ada).map((d) => d.text).sort()).toEqual(["Coffee?", "Hi Ada"]);
  });
});

describe("drafts", () => {
  it("keeps what the captain types as a note is kept, deletes one emptied, and is no edit: nobody marked edited, no new version", () => {
    importAndRun([{ name: "Ada Sample" }]);
    const ada = personNamed("Ada Sample").id;
    const version = people.version();
    expect(people.drafts.add(ada, "   ")).toBeNull();
    expect(people.drafts.list(ada)).toEqual([]);

    const draft = people.drafts.add(ada, "  Hey!\r\nLong time, no see ")!;
    expect(draft).toMatchObject({ personId: ada, text: "Hey!\nLong time, no see" });
    expect(people.drafts.set(draft.id, "Hey!\nLong time, no see")).toEqual(draft);
    const changed = people.drafts.set(draft.id, "Hey! Coffee soon?")!;
    expect(changed).toMatchObject({ id: draft.id, text: "Hey! Coffee soon?" });
    expect(changed.updatedAt).toBeGreaterThanOrEqual(draft.updatedAt);
    expect(people.drafts.list(ada).map((d) => d.text)).toEqual(["Hey! Coffee soon?"]);
    expect(structure.getPerson(ada)).toMatchObject({ edited: false, untouched: true });
    expect(people.version()).toBe(version);

    expect(people.drafts.set(draft.id, "\n ")).toBeNull();
    expect(people.drafts.list(ada)).toEqual([]);
    expect(() => people.drafts.set(draft.id, "again")).toThrow(/no draft/);
    expect(() => people.drafts.add(ada, 3)).toThrow(/a draft is text/);
    expect(() => people.drafts.add(999_999, "Hi")).toThrow(/no person/);
    expect(() => people.drafts.add(ada, "x".repeat(10_001))).toThrow(/at most 10,000/);
  });

  it("go with a person deleted", () => {
    const added = people.add({ name: "Ada Sample" });
    people.drafts.add(added, "Hi");
    people.delete(added);
    expect(db.prepare("SELECT count(*) AS n FROM draft").get()).toEqual({ n: 0 });
  });
});

describe("location", () => {
  it("sets and clears it, picking a value that exists but for case, marking the person edited, and finds people by it", () => {
    importAndRun([{ name: "Ada Sample" }, { name: "Bea Test" }]);
    const [ada, bea] = [personNamed("Ada Sample").id, personNamed("Bea Test").id];
    expect(personNamed("Ada Sample")).toMatchObject({ location: null, edited: false });

    const before = people.version();
    people.setLocation(ada, "  Brisbane ");
    expect(people.version()).not.toBe(before);
    expect(structure.getPerson(ada)).toMatchObject({ location: "Brisbane", edited: true });

    // Typed in another case, a location is written as someone already has it.
    people.setLocation(bea, "brisbane");
    expect(structure.getPerson(bea)).toMatchObject({ location: "Brisbane" });
    expect(people.locations.list()).toEqual([{ name: "Brisbane", count: 2 }]);

    // Setting what is already there changes nothing.
    const now = people.version();
    people.setLocation(ada, "BRISBANE");
    expect(people.version()).toBe(now);

    // Everywhere a person is read, and found by the search or by the value.
    people.setLocation(bea, "Tokyo");
    expect(structure.tableRows().find((p) => p.id === ada)).toMatchObject({ location: "Brisbane" });
    expect(structure.relationships().people.find((p) => p.id === ada)).toMatchObject({ location: "Brisbane" });
    expect(structure.listPeople({ query: "toky" }).people.map((p) => p.name)).toEqual(["Bea Test"]);
    expect(structure.listPeople({ query: "brisb" }).people.map((p) => p.name)).toEqual(["Ada Sample"]);
    expect(structure.listPeople({ location: "BRISBANE" }).people.map((p) => p.name)).toEqual(["Ada Sample"]);
    expect(structure.listPeople({ location: "nowhere" }).people).toEqual([]);

    people.setLocation(ada, null);
    people.setLocation(bea, "");
    expect(structure.getPerson(ada)).toMatchObject({ location: null });
    // A location nobody is at any more is gone from the list.
    expect(people.locations.list()).toEqual([]);

    expect(() => people.setLocation(ada, ["Brisbane"])).toThrow(/a location is text/);
    expect(() => people.setLocation(ada, "  -- ")).toThrow(/letter or digit/);
    expect(() => people.setLocation(structure.listPeople().me!.id, "Brisbane")).toThrow(/that is you/);
  });

  it("renames a location for everyone at it, and merges it onto another", () => {
    importAndRun([{ name: "Ada Sample" }, { name: "Bea Test" }, { name: "Cy Other" }]);
    const [ada, bea, cy] = ["Ada Sample", "Bea Test", "Cy Other"].map((name) => personNamed(name).id);
    people.setLocation(ada, "Tokyo");
    people.setLocation(bea, "Tokio");
    people.setLocation(cy, "Tokio");

    const before = people.version();
    expect(people.locations.rename("tokio", "Tokyo City")).toEqual({ name: "Tokyo City", count: 2, merged: false });
    expect(people.version()).not.toBe(before);
    expect([bea, cy].map((id) => structure.getPerson(id)!.location)).toEqual(["Tokyo City", "Tokyo City"]);

    // Onto another location someone is at: a merge, in that one's spelling.
    expect(people.locations.rename("Tokyo City", "tokyo")).toEqual({ name: "Tokyo", count: 2, merged: true });
    expect(people.locations.list()).toEqual([{ name: "Tokyo", count: 3 }]);
    expect([ada, bea, cy].map((id) => structure.getPerson(id)!.location)).toEqual(["Tokyo", "Tokyo", "Tokyo"]);

    // A new case only renames it, for everyone.
    expect(people.locations.rename("tokyo", "TOKYO")).toEqual({ name: "TOKYO", count: 3, merged: false });
    expect(people.locations.list()).toEqual([{ name: "TOKYO", count: 3 }]);
    // Renaming it to what it is changes nothing.
    const now = people.version();
    expect(people.locations.rename("TOKYO", "TOKYO")).toEqual({ name: "TOKYO", count: 0, merged: false });
    expect(people.version()).toBe(now);

    expect(() => people.locations.rename("Nowhere", "Somewhere")).toThrow(/nobody is at "Nowhere"/);
    expect(() => people.locations.rename("TOKYO", " -- ")).toThrow(/letter or digit/);
  });

  it("a merge keeps the kept person's location, the other's into the note", () => {
    importAndRun([{ name: "Sam Smith" }, { name: "Samuel S" }, { name: "Cy Other" }, { name: "Cy O" }, { name: "Di One" }, { name: "Di Two" }]);
    const [sam, samuel] = [personNamed("Sam Smith").id, personNamed("Samuel S").id];
    people.setNote(sam, "Climbs");
    people.setLocation(sam, "Tokyo");
    people.setLocation(samuel, "Brisbane");
    people.merge(sam, samuel);
    expect(structure.getPerson(sam)).toMatchObject({ location: "Tokyo", note: "Climbs\n\nLocation: Brisbane" });

    // The same value on both sides adds nothing to the note.
    const [cy, cyO] = [personNamed("Cy Other").id, personNamed("Cy O").id];
    people.setLocation(cy, "Perth");
    people.setLocation(cyO, "perth");
    people.merge(cy, cyO);
    expect(structure.getPerson(cy)).toMatchObject({ location: "Perth", note: "" });

    // Without one, the kept person takes the other's.
    const [di, diTwo] = [personNamed("Di One").id, personNamed("Di Two").id];
    people.setLocation(diTwo, "Hobart");
    people.merge(di, diTwo);
    expect(structure.getPerson(di)).toMatchObject({ location: "Hobart", note: "" });
  });

  it("a join by name carries the location into the person kept", () => {
    importAndRun([{ name: "Ada Sample" }, { name: "Bea Test" }]);
    // As the rules could find someone never edited with a value (by an older archive, say).
    const [adaAway, beaAway] = [personNamed("Ada Sample").id, personNamed("Bea Test").id];
    db.prepare("UPDATE person SET location = ? WHERE id = ?").run("Online", adaAway);
    db.prepare("UPDATE person SET location = ? WHERE id = ?").run("Brisbane", beaAway);
    const [ada, bea] = [people.create("Ada Sample"), people.create("Bea Test")];
    people.setLocation(ada, "Couchsurfing");
    people.setNote(bea, "Climbs");
    people.runRules();
    expect(structure.getPerson(adaAway)).toBeNull();
    expect(structure.getPerson(ada)).toMatchObject({ location: "Couchsurfing", note: "Location: Online" });
    expect(structure.getPerson(bea)).toMatchObject({ location: "Brisbane", note: "Climbs" });
  });
});

describe("the Table's counts by platform", () => {
  it("counts each platform's messages apart, summed over its accounts, most messages first", () => {
    importAndRun([{ name: "Kit Ng" }], "messenger");
    importAndRun([{ name: "Kit Ng" }, { name: "Kit Ng", group: "Climbing" }], "whatsapp");
    const kit = personNamed("Kit Ng");
    const row = structure.tableRows().find((p) => p.id === kit.id)!;
    const last = (platform: string) => Math.max(...kit.accounts.filter((a) => a.platform === platform).map((a) => a.lastMessageAt ?? 0));
    expect(row.platforms).toEqual(["whatsapp", "messenger"]);
    expect(row.byPlatform).toEqual([
      { platform: "whatsapp", messageCount: 3, directMessageCount: 2, groupMessageCount: 1, lastMessageAt: last("whatsapp") },
      { platform: "messenger", messageCount: 2, directMessageCount: 2, groupMessageCount: 0, lastMessageAt: last("messenger") },
    ]);
    // Together they are the person's whole counts.
    expect(row).toMatchObject({ messageCount: 5, directMessageCount: 4, groupMessageCount: 1, lastMessageAt: Math.max(last("whatsapp"), last("messenger")) });
  });
});

describe("links: stored, with where they came from", () => {
  it("the rules fill in only links nobody chose: captain's links, \"Not them\" and rejections always win", () => {
    importAndRun([{ name: "Kit Ng" }, { name: "Sam Smith" }, { name: "Tom Tom" }], "messenger");
    importAndRun([{ name: "Kit Ng" }, { name: "Sam Smith" }], "whatsapp");
    const kit = personNamed("Kit Ng").id;
    expect(accountOf("whatsapp", "Kit Ng")).toMatchObject({ person_id: kit, link_source: "rule:same-name" });

    // The captain links WhatsApp's Sam Smith to Tom Tom: rules never move it back to the other Sam Smith.
    const tom = personNamed("Tom Tom").id;
    people.link(accountOf("whatsapp", "Sam Smith").id, tom);
    // "Not them" takes WhatsApp's Kit Ng out of Kit.
    const fresh = people.detach(kit, accountOf("whatsapp", "Kit Ng").id);
    const linkedAt = db.prepare("SELECT id, person_id, link_source, linked_at FROM import_person ORDER BY id").all();

    people.runRules();
    importAndRun([{ name: "Kit Ng" }, { name: "Sam Smith" }], "imessage");
    expect(accountOf("whatsapp", "Sam Smith")).toMatchObject({ person_id: tom, link_source: "captain" });
    expect(accountOf("whatsapp", "Kit Ng")).toMatchObject({ person_id: fresh, link_source: "captain" });
    // A new account of a disputed name is left to the captain (joined with neither side, as before). Linking WhatsApp's
    // Sam Smith away from Sam Smith said the two are different, so Sam Smith's name is disputed too.
    for (const [name, sides] of [["Kit Ng", [kit, fresh]], ["Sam Smith", [personNamed("Sam Smith").id, tom]]] as const) {
      const imessage = accountOf("imessage", name);
      expect(imessage.link_source).toBe("import");
      expect(sides).not.toContain(imessage.person_id);
    }
    // Nobody's link, or when it was made, changed by running the rules again.
    const now = db.prepare("SELECT id, person_id, link_source, linked_at FROM import_person ORDER BY id").all();
    expect(now.slice(0, linkedAt.length)).toEqual(linkedAt);
  });

  it("never joins two people the captain has edited or linked: they are proposed instead", () => {
    importAndRun([{ name: "Pat Doe" }], "messenger");
    const first = personNamed("Pat Doe").id;
    people.setTags(first, ["work"]);
    const second = people.create("Pat Doe");
    importAndRun([{ name: "Pat Doe" }], "whatsapp");
    // WhatsApp's Pat Doe was nobody's choice, but two edited people share the name: nothing is joined.
    expect(structure.listPeople().people.filter((p) => p.name === "Pat Doe").map((p) => p.id).sort()).toHaveLength(3);
    expect(structure.getPerson(second)!.accounts).toEqual([]);
  });

  it("links are read, not worked out, when people load: only the rules change them", () => {
    importAndRun([{ name: "Mia Wong" }], "messenger");
    importChats([{ name: "Mia Wong" }], "whatsapp");
    // Imported but the rules not run yet: the new account has no person, and loading does not make one.
    expect(accountOf("whatsapp", "Mia Wong").person_id).toBeNull();
    expect(structure.listPeople().people.filter((p) => p.name === "Mia Wong")).toHaveLength(1);
    expect(accountOf("whatsapp", "Mia Wong").person_id).toBeNull();
    people.runRules();
    expect(personNamed("Mia Wong")).toMatchObject({ messageCount: 4, joined: { rule: "same-name" } });
  });
});

describe("joining people by name", () => {
  const accountsOf = (id: number) => structure.getPerson(id)!.accounts.map((a) => `${a.platform}:${a.displayName}`).sort();

  it("joins exactly the same name into one person, a chain of three included, but not a name in another case", () => {
    importChats([{ name: "Kit Ng" }, { name: "Mia Wong" }], "messenger");
    importChats([{ name: "Kit Ng" }, { name: "Mia Wong" }], "whatsapp");
    importChats([{ name: "Kit Ng‎ " }, { name: "KIT NG" }], "imessage");
    people.runRules();
    expect(names()).toEqual(["KIT NG", "Kit Ng", "Mia Wong"]);
    const kit = personNamed("Kit Ng");
    expect(kit).toMatchObject({ messageCount: 6, joined: { rule: "same-name" } });
    expect(accountsOf(kit.id)).toEqual(["imessage:Kit Ng‎ ", "messenger:Kit Ng", "whatsapp:Kit Ng"]);
    expect(structure.proposals()).toEqual([]);
    // Run again, nothing changes.
    people.runRules();
    expect(structure.getPerson(kit.id)).toMatchObject({ messageCount: 6, joined: { rule: "same-name" } });
  });

  it("names a person from their import exactly as the platform wrote it, stray spaces and all, and joins only the same spacing", () => {
    importChats([{ name: "Haruki  Oda " }], "messenger");
    importChats([{ name: "Haruki Oda" }], "whatsapp");
    people.runRules();
    expect(names()).toEqual(["Haruki  Oda ", "Haruki Oda"]);
    // A person follows a renamed account's name verbatim as well.
    importAndRun([{ name: "Kiara Moxie" }]);
    db.prepare("UPDATE import_person SET display_name = 'Kiara Moxie Glyn ' WHERE key = 'Kiara Moxie'").run();
    people.runRules();
    expect(names()).toContain("Kiara Moxie Glyn ");
  });

  it("joins the same name whoever chats with the captain, and whatever platform they share", () => {
    importChats([{ name: "Selma Fakeley" }, { name: "Selma FAKELEY", group: "Book club" }], "messenger");
    importChats([{ name: "Selma Fakeley" }], "whatsapp");
    people.runRules();
    // Kept on the map by the captain's link, though seen only in a group.
    const selma = personNamed("Selma Fakeley").id;
    people.link(accountOf("messenger", "Selma FAKELEY").id, selma);
    expect(names()).toEqual(["Selma Fakeley"]);
    expect(personNamed("Selma Fakeley")).toMatchObject({ messageCount: 5, joined: { rule: "same-name" } });
    expect(structure.proposals()).toEqual([]);
  });

  it("proposes the same one-word name rather than joining it, unless it is in Chinese", () => {
    importChats([{ name: "Alex" }, { name: "周伟" }, { name: "Wenjie" }], "messenger");
    importChats([{ name: "Alex" }, { name: "周伟" }, { name: "Alex Tan" }], "whatsapp");
    people.runRules();
    expect(names()).toEqual(["Alex", "Alex", "Alex Tan", "Wenjie", "周伟"]);
    expect(personNamed("周伟")).toMatchObject({ messageCount: 4, joined: { rule: "same-name" } });
    // "Alex" / "Alex Tan" is a lone first name, so it is not proposed either.
    expect(structure.proposals().map((p) => [p.people.map((person) => person.name).join(" / "), p.tier, p.evidence[0].rule])).toEqual([
      ["Alex / Alex", "low", "name-one-word"],
    ]);
  });

  it("joins into a person the captain edited, keeping their name, aliases and tags", () => {
    importAndRun([{ name: "Ada Sample" }], "messenger");
    const ada = personNamed("Ada Sample").id;
    people.setAliases(ada, ["Addy"]);
    people.setTags(ada, ["climbing"]);
    importAndRun([{ name: "Ada Sample" }], "whatsapp");
    const joined = structure.getPerson(ada)!;
    expect(joined).toMatchObject({ aliases: ["Addy"], tags: ["climbing"], messageCount: 4, joined: { rule: "same-name" } });
    // Only the account the join brought in.
    expect(joined.joined!.accountIds).toEqual([joined.accounts.find((a) => a.platform === "whatsapp")!.id]);
  });

  it("never joins people the captain said are different, but still joins the rest of the name", () => {
    importChats([{ name: "Pat Doe" }], "messenger");
    importChats([{ name: "Pat Doe" }], "whatsapp");
    importChats([{ name: "Pat Doe" }], "imessage");
    db.prepare(
      `INSERT INTO merge_proposal (left_key, right_key, rule, tier, evidence_json, status, created_at, decided_at)
       VALUES ('account:messenger:Pat Doe', 'account:whatsapp:Pat Doe', 'name-exact', 'medium', '{}', 'rejected', 0, 0)`,
    ).run();
    people.runRules();
    expect(structure.listPeople().people.map((p) => p.accounts.map((a) => a.platform).join("+")).sort()).toEqual([
      "imessage", "messenger", "whatsapp",
    ]);
    // Messenger and WhatsApp are said to be different people, so neither is joined with iMessage; those two pairs are proposed.
    expect(structure.proposals().map((p) => p.people.map((person) => person.accounts[0].platform).sort().join("+")).sort()).toEqual([
      "imessage+messenger", "imessage+whatsapp",
    ]);
  });

  it("leaves placeholder names out", () => {
    importChats([{ name: "Facebook user" }], "whatsapp");
    importChats([{ name: "Facebook user" }], "messenger");
    people.runRules();
    expect(structure.listPeople().people.filter((p) => p.joined !== null)).toEqual([]);
  });

  describe("the same full name, archived by the rules or not", () => {
    /** Imports one account per entry on a platform, keyed by `key`: in a two-way direct chat, or silent in a group too big to keep anyone. */
    function importAccounts(platform: string, accounts: Array<{ key: string; name: string; group?: boolean }>): void {
      const events: ArchiveEvent[] = [{ kind: "account", key: "me", keyKind: "id", displayName: "Me", isSelf: true }];
      const crowd = Array.from({ length: 11 }, (_, n) => `${platform} crowd ${n + 1}`);
      for (const key of crowd) events.push({ kind: "account", key, keyKind: "id", displayName: key });
      for (const { key, name } of accounts) events.push({ kind: "account", key, keyKind: "id", displayName: name });
      events.push({ kind: "conversation", id: "group", type: "group", title: "Group", members: ["me", ...crowd, ...accounts.filter((a) => a.group).map((a) => a.key)] });
      let n = 0;
      for (const { key, name, group } of accounts) {
        if (group) continue;
        events.push({ kind: "conversation", id: key, type: "direct", title: name, members: ["me", key] });
        for (const sender of [key, "me"]) {
          events.push({
            kind: "message", id: `${platform}-${n}`, idKind: "platform", conversation: key, sender, isFromSelf: sender === "me",
            sentAt: 1_700_000_000_000 + n++ * 60_000, type: "text", text: `message ${n}`, raw: {},
          });
        }
      }
      transaction(db, () => {
        const source = Number(db
          .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'export', 'test', 0, 'ok')")
          .run(platform).lastInsertRowid);
        const session = new ImportSession(db, platform, source, "export");
        for (const event of events) session.apply(event);
      });
    }
    const named = (name: string) => structure.listPeople().people.filter((p) => p.name === name);
    const platformsOf = (name: string) => named(name).map((p) => p.accounts.map((a) => a.platform).sort().join("+")).sort();

    it("joins two accounts of one platform, and accounts on several", () => {
      importAccounts("whatsapp", [{ key: "+61491571266", name: "Pat Doe" }, { key: "+61491571491", name: "Pat Doe" }]);
      importAccounts("signal", [{ key: "aci-1", name: "Ruth Roe" }]);
      importAccounts("telegram", [{ key: "101", name: "Ruth Roe" }]);
      people.runRules();
      expect(platformsOf("Pat Doe")).toEqual(["whatsapp+whatsapp"]);
      expect(platformsOf("Ruth Roe")).toEqual(["signal+telegram"]);
      expect(structure.proposals()).toEqual([]);
    });

    it("joins someone the rules archived with someone on the map, and two the rules archived, and the rules then archive or show them", () => {
      importAccounts("whatsapp", [{ key: "+61491571266", name: "Gus Grey" }]);
      importAccounts("signal", [{ key: "aci-1", name: "Gus Grey", group: true }, { key: "aci-2", name: "Ida Ink", group: true }]);
      importAccounts("imessage", [{ key: "+61491571804", name: "Ida Ink", group: true }]);
      people.runRules();
      expect(platformsOf("Gus Grey")).toEqual(["signal+whatsapp"]);
      expect(named("Gus Grey")[0]).toMatchObject({ archived: null, joined: { rule: "same-name" } });
      expect(platformsOf("Ida Ink")).toEqual(["imessage+signal"]);
      expect(named("Ida Ink")[0]).toMatchObject({ archived: "groups-silent", joined: { rule: "same-name" } });
    });

    it("joins by an account's name when the captain renamed its person, and the proposal it was waiting as goes", () => {
      importAccounts("telegram", [{ key: "101", name: "Patrice Brook" }, { key: "102", name: "Pat B" }]);
      people.runRules();
      const patrice = named("Pat B")[0].id;
      people.link(accountOf("telegram", "101").id, patrice);
      people.setName(patrice, "Patrice Bligh");
      importAccounts("signal", [{ key: "aci-1", name: "Patrice Brook", group: true }]);
      // As the rules before this left it: the two accounts' same name waiting as a proposal.
      db.prepare(
        `INSERT INTO merge_proposal (left_key, right_key, rule, tier, evidence_json, status, created_at)
         VALUES ('account:signal:aci-1', 'account:telegram:101', 'name-exact', 'medium', '{}', 'pending', 0)`,
      ).run();
      people.runRules();
      expect(platformsOf("Patrice Bligh")).toEqual(["signal+telegram+telegram"]);
      expect(named("Patrice Brook")).toEqual([]);
      expect(structure.getPerson(patrice)).toMatchObject({ archived: null, joined: { rule: "same-name" } });
      expect(structure.proposals()).toEqual([]);
      expect(db.prepare("SELECT count(*) AS n FROM merge_proposal").get()).toEqual({ n: 0 });
    });

    it("never joins someone the captain archived, or a pair he said are different, archived by the rules or not", () => {
      importAccounts("whatsapp", [{ key: "+61491571266", name: "Hal Hue" }, { key: "+61491571491", name: "Kim Key" }]);
      people.runRules();
      people.setTags(named("Hal Hue")[0].id, ["archive"]);
      importAccounts("signal", [{ key: "aci-1", name: "Hal Hue", group: true }, { key: "aci-2", name: "Kim Key", group: true }]);
      db.prepare(
        `INSERT INTO merge_proposal (left_key, right_key, rule, tier, evidence_json, status, created_at, decided_at)
         VALUES ('account:signal:aci-2', 'account:whatsapp:+61491571491', 'name-exact', 'medium', '{}', 'rejected', 0, 0)`,
      ).run();
      people.runRules();
      expect(platformsOf("Hal Hue")).toEqual(["signal", "whatsapp"]);
      expect(platformsOf("Kim Key")).toEqual(["signal", "whatsapp"]);
      expect(structure.proposals()).toEqual([]);
    });

    it("leaves the same one-word name a proposal on the map and apart when archived, but joins it in Chinese", () => {
      importAccounts("whatsapp", [{ key: "+61491571266", name: "Alex" }, { key: "+61491571491", name: "周伟" }, { key: "+61491571804", name: "Wenjie" }]);
      importAccounts("signal", [{ key: "aci-1", name: "Alex" }, { key: "aci-2", name: "周伟", group: true }, { key: "aci-3", name: "Wenjie", group: true }]);
      people.runRules();
      expect(platformsOf("Alex")).toEqual(["signal", "whatsapp"]);
      expect(structure.proposals().map((p) => [p.people.map((x) => x.name).join(" / "), p.evidence[0].rule])).toEqual([["Alex / Alex", "name-one-word"]]);
      expect(platformsOf("周伟")).toEqual(["signal+whatsapp"]);
      expect(platformsOf("Wenjie")).toEqual(["signal", "whatsapp"]);
    });
  });
});

describe("nameEvidence", () => {
  const id = (name: string) => ({ key: name, name, same: sameName(name), words: name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(" ") });
  it.each([
    ["Kit Ng", " Kit Ng‏", "name-exact"],
    ["Zoë Ng", "Zoë Ng", "name-exact"],
    ["周伟", "周伟", "name-exact"],
    ["Alex", "Alex", "name-one-word"],
    ["Kit Ng", "KIT NG", null],
    ["Cleo Example", "Cléo Example", null],
    ["Rowan Quill", "Rowan Ryan Quill", "name-contained"],
    ["Quill Rowan", "Rowan Quill", "name-contained"],
    ["Ada", "Ada Sample", null],
    ["Bruno P", "Bruno Placeholder", null],
    ["Ada Sample", "Bea Sample", null],
    ["Sample", "Ada Sample", null],
  ])("%s / %s -> %s", (a, b, rule) => {
    expect(nameEvidence(id(a), id(b))?.rule ?? null).toBe(rule);
  });
});

describe("adding someone by hand", () => {
  it("adds them with no accounts, their location, tags and note, edited, and never archived by the rules", () => {
    importChats([{ name: "Ada Lovelace" }]);
    const walt = people.add({ name: " Walt  Example ", location: "brisbane", tags: ["Uni friends"], note: "met at a wedding" });
    people.runRules();
    expect(structure.getPerson(walt)).toMatchObject({
      name: "Walt Example", location: "brisbane", tags: ["uni-friends"], note: "met at a wedding",
      accounts: [], edited: true, untouched: false, archived: null,
    });
    // On the map, with no closeness yet (Orbits' belt), and in the Table.
    expect(structure.relationships().people.map((p) => p.id)).toContain(walt);
    expect(structure.tableRows().find((p) => p.id === walt)).toMatchObject({ messageCount: 0 });
  });

  it("adds nothing when any part is wrong", () => {
    const before = structure.listPeople({}).people.length;
    expect(() => people.add({ name: "" })).toThrow(/name/);
    expect(() => people.add({ name: "Walt Example", tags: "friend" })).toThrow(/tags must be a list/);
    expect(structure.listPeople({}).people.length).toBe(before);
  });

  it("finds who already goes by a name or alias, but for case and what can't be seen, never the captain", () => {
    importChats([{ name: "Ada Lovelace" }, { name: "Bea Arthur" }]);
    people.runRules();
    const bea = structure.listPeople({}).people.find((p) => p.name === "Bea Arthur")!.id;
    people.setAliases(bea, ["Bee"]);
    const ada = structure.listPeople({}).people.find((p) => p.name === "Ada Lovelace")!.id;
    expect(people.sameNamed("ada lovelace")).toEqual([ada]);
    expect(people.sameNamed("Ada‎ Lovelace ")).toEqual([ada]);
    expect(people.sameNamed("BEE")).toEqual([bea]);
    expect(people.sameNamed("Ada")).toEqual([]);
    expect(people.sameNamed("Me")).toEqual([]);
  });
});
