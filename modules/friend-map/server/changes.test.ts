import { mkdtemp, rm } from "node:fs/promises";
import { changeLog } from "./changeLog.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArchiveEvent, Changes, type Db, KEEP_DAYS, transaction, UndoConflictError } from "../../../sdk/server.ts";
import { openArchive } from "./db.ts";
import { People } from "./people.ts";
import { ArchiveStructure } from "./structure.ts";
import { ImportSession } from "./write.ts";

let dataDir: string;
let db: Db;
let people: People;
let changes: Changes;
let structure: ArchiveStructure;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-changes-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  people = new People(db);
  changes = changeLog(db, people);
  structure = new ArchiveStructure(db, people);
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Each name says one thing to the captain in a chat of their own, and the captain answers; then the rules run. */
function importPeople(names: string[], platform = "messenger"): void {
  const events: ArchiveEvent[] = [{ kind: "account", key: "Me", keyKind: "name", displayName: "Me", isSelf: true }];
  names.forEach((name, i) => {
    events.push({ kind: "account", key: name, keyKind: "name", displayName: name });
    events.push({ kind: "conversation", id: `direct-${name}`, type: "direct", title: name, members: ["Me", name] });
    for (const [sender, at] of [[name, 0], ["Me", 500]] as const) {
      events.push({
        kind: "message", id: `${platform}-${name}-${sender}`, idKind: "platform", conversation: `direct-${name}`, sender,
        isFromSelf: sender === "Me", sentAt: 1_700_000_000_000 + i * 1000 + at, type: "text", text: "hi", raw: {},
      });
    }
  });
  transaction(db, () => {
    const source = Number(db
      .prepare("INSERT INTO source (platform, connector, kind, label, started_at, status) VALUES (?, 'test', 'export', 'test', 0, 'ok')")
      .run(platform).lastInsertRowid);
    const session = new ImportSession(db, platform, source, "export");
    for (const event of events) session.apply(event);
  });
  people.runRules();
}

function id(name: string): number {
  const person = structure.listPeople().people.find((p) => p.name === name);
  if (!person) throw new Error(`nobody named ${name}`);
  return person.id;
}

/** Everything the captain decides about everyone (and the tag and location lists), to compare before and after an undo. */
function snapshot() {
  const listing = structure.listPeople().people.map((p) => ({
    id: p.id, name: p.name, aliases: p.aliases, tags: p.tags, location: p.location, note: p.note,
    shouldReachOut: p.shouldReachOut, drafts: people.drafts.list(p.id).map((d) => d.text), identiconSeed: p.identiconSeed, accounts: p.accounts.map((a) => [a.id, a.link]),
  }));
  return { people: listing, tags: people.tags.list(), locations: people.locations.list() };
}

const cli = (action: string, description?: string) => ({ surface: "cli" as const, action, description });

describe("recording", () => {
  it("logs each person's before and after for what changed, and nothing for an edit that changes nothing", () => {
    importPeople(["Ada Lovelace", "Bea Arthur"]);
    const ada = id("Ada Lovelace");
    people.setTags(ada, ["friend"]);
    const { changeset } = changes.record(cli("edit tag commercial", "tag them all commercial"), () => {
      people.addTags(ada, ["commercial"]);
      people.setLocation(ada, "Tokyo");
      people.setShouldReachOut(ada, true);
    });
    expect(changeset).not.toBeNull();
    const shown = changes.show(changeset!);
    expect(shown).toMatchObject({ surface: "cli", action: "edit tag commercial", description: "tag them all commercial", undoes: null, undoneBy: null, peopleCount: 1 });
    expect(shown.people).toEqual([{
      id: ada,
      name: "Ada Lovelace",
      changes: [
        { what: "reach out", before: "no", after: "yes" },
        { what: "location", before: "", after: "Tokyo" },
        { what: "tags", before: "friend", after: "friend, commercial" },
      ],
    }]);
    expect(shown.other).toEqual(['added the tag "commercial"']);

    // Tagging her with what she has, again, is no change.
    expect(changes.record(cli("tags"), () => people.addTags(ada, ["commercial"])).changeset).toBeNull();
    expect(changes.list().map((c) => c.id)).toEqual([changeset]);
  });

  it("adds an edit to the newest changeset when asked, so one instruction is undone as one", () => {
    importPeople(["Ada Lovelace", "Bea Arthur"]);
    const [ada, bea] = [id("Ada Lovelace"), id("Bea Arthur")];
    const before = snapshot();
    const first = changes.record(cli("edit tag commercial", "tag them commercial and hide them"), () => people.addTags(ada, ["commercial"])).changeset!;
    expect(changes.record({ ...cli("edit tag archive"), into: first }, () => {
      people.addTags(ada, ["archive"]);
      people.addTags(bea, ["archive"]);
    }).changeset).toBe(first);
    expect(changes.show(first)).toMatchObject({
      action: "edit tag commercial; edit tag archive",
      description: "tag them commercial and hide them",
      people: [
        { id: ada, changes: [{ what: "tags", before: "", after: "archive, commercial" }] },
        { id: bea, changes: [{ what: "tags", before: "", after: "archive" }] },
      ],
    });
    expect(changes.list()).toHaveLength(1);

    const other = changes.record(cli("location"), () => people.setLocation(bea, "Tokyo")).changeset!;
    expect(() => changes.record({ ...cli("tag"), into: first }, () => people.addTags(bea, ["x"]))).toThrow(`only the newest changeset can take more, and that is #${other}, not #${first}`);
    expect(() => changes.record({ surface: "app", action: "tag", into: other }, () => people.addTags(bea, ["x"]))).toThrow(`#${other} can't take more: it was made in the cli`);
    changes.undo(other, { surface: "cli" });
    changes.undo(first, { surface: "cli" });
    expect(snapshot()).toEqual(before);
    expect(() => changes.record({ ...cli("tag"), into: first }, () => people.addTags(bea, ["x"]))).toThrow(/only the newest changeset can take more/);
  });

  it("logs nothing the rules, imports or edits outside a changeset do", () => {
    importPeople(["Ada Lovelace"]);
    people.setTags(id("Ada Lovelace"), ["friend"]);
    people.runRules();
    expect(db.prepare("SELECT count(*) AS n FROM change_row").get()).toEqual({ n: 0 });
    expect(changes.list()).toEqual([]);
  });

  it("rolls the edit and its changeset back together when the edit fails", () => {
    importPeople(["Ada Lovelace"]);
    const ada = id("Ada Lovelace");
    expect(() => changes.record(cli("tags"), () => {
      people.addTags(ada, ["friend"]);
      people.addTags(ada, ["not a tag!"]);
    })).toThrow(/is not a tag/);
    expect(structure.getPerson(ada)!.tags).toEqual([]);
    expect(changes.list()).toEqual([]);
  });

  it("shows a renamed tag on everyone who has it, and a merge's accounts and deleted person", () => {
    importPeople(["Ada Lovelace", "Ada L"]);
    const [ada, other] = [id("Ada Lovelace"), id("Ada L")];
    people.setTags(ada, ["uni"]);
    const renamed = changes.show(changes.record(cli("tag rename"), () => people.tags.rename("uni", "university")).changeset!);
    expect(renamed.people).toEqual([{ id: ada, name: "Ada Lovelace", changes: [{ what: "tags", before: "uni", after: "university" }] }]);
    expect(renamed.other).toEqual(['renamed the tag "uni" to "university"']);

    const merged = changes.show(changes.record(cli("merge"), () => people.merge(ada, other)).changeset!);
    expect(merged.people).toEqual([
      { id: other, name: "Ada L", changes: [{ what: "person", before: "", after: "deleted" }, { what: "accounts", before: 'messenger "Ada L"', after: "" }] },
      { id: ada, name: "Ada Lovelace", changes: [{ what: "accounts", before: 'messenger "Ada Lovelace"', after: 'messenger "Ada Lovelace", messenger "Ada L"' }] },
    ]);
  });
});

describe("undo", () => {
  it("takes drafts back to whom they were to when a merge is undone, edited since or not, and never makes a changeset for one", () => {
    importPeople(["Ada Lovelace", "Bea Arthur"]);
    const [ada, bea] = [id("Ada Lovelace"), id("Bea Arthur")];
    const beas = people.drafts.add(bea, "Coffee?")!;
    expect(changes.list()).toEqual([]);
    const merged = changes.record(cli("merge"), () => people.merge(ada, bea));
    expect(people.drafts.list(ada).map((d) => d.text)).toEqual(["Coffee?"]);
    // Worked on since, as the panel saves it: still undone.
    people.drafts.set(beas.id, "Coffee on Friday?");
    changes.undo(merged.changeset!, { surface: "app" });
    expect(people.drafts.list(bea).map((d) => d.text)).toEqual(["Coffee on Friday?"]);
    expect(people.drafts.list(ada)).toEqual([]);
    expect(changes.list().map((c) => c.action)).toEqual([`undo #${merged.changeset}`, "merge"]);
  });

  it("puts back exactly what a changeset changed, as a changeset of its own, and undoing that does it again", () => {
    importPeople(["Ada Lovelace", "Bea Arthur", "Cy Twombly"]);
    const [ada, bea] = [id("Ada Lovelace"), id("Bea Arthur")];
    people.setTags(ada, ["friend"]);
    people.setLocation(bea, "Brisbane");
    const before = snapshot();
    const { changeset } = changes.record(cli("edit"), () => {
      people.addTags(ada, ["commercial", "archive"]);
      people.setLocation(bea, "Melbourne");
      people.setName(bea, "Beatrice Arthur");
      people.setAliases(bea, ["Bea"]);
      people.setNote(ada, "line one\nline two");
      people.setShouldReachOut(bea, true);
    });
    const after = snapshot();
    expect(after).not.toEqual(before);

    const undone = changes.undo(changeset!, { surface: "app" });
    expect(snapshot()).toEqual(before);
    expect(undone.value).toMatchObject({ action: `undo #${changeset}`, surface: "app", undoes: changeset });
    expect(changes.show(changeset!).undoneBy).toBe(undone.changeset);
    expect(() => changes.undo(changeset!, { surface: "cli" })).toThrow(`#${changeset} was undone by #${undone.changeset}`);

    const redone = changes.undo(undone.changeset!, { surface: "cli" });
    expect(snapshot()).toEqual(after);
    expect(changes.standing(changeset!)).toEqual({ undoneBy: null });

    changes.undo(redone.changeset!, { surface: "cli" });
    expect(snapshot()).toEqual(before);
    expect(changes.standing(changeset!)).toEqual({ undoneBy: undone.changeset });
    expect(() => changes.undo(changeset!, { surface: "cli" })).toThrow(`#${changeset} was undone by #${undone.changeset}`);
  });

  it("checks and puts back only what it changed of a person: their location set since stays when a name change is undone", () => {
    importPeople(["Ada Sample"]);
    const ada = id("Ada Sample");
    const renamed = changes.record(cli("person set-name"), () => people.setName(ada, "Ada Sample")).changeset!;
    const located = changes.record(cli("person location"), () => people.setLocation(ada, "Brisbane")).changeset!;
    people.setNote(ada, "Climbs");
    changes.undo(renamed, { surface: "cli" });
    expect(structure.getPerson(ada)).toMatchObject({ name: "Ada Sample", location: "Brisbane", note: "Climbs" });

    // What it set changed since, it refuses, naming what.
    people.setLocation(ada, "Hobart");
    expect(() => changes.undo(located, { surface: "cli" })).toThrow(`can't undo #${located}: changed again since: Ada Sample [person ${ada}] (location)`);
    people.setLocation(ada, "Brisbane");
    changes.undo(located, { surface: "cli" });
    expect(structure.getPerson(ada)).toMatchObject({ name: "Ada Sample", location: null, note: "Climbs" });
  });

  it("refuses, naming who, when what it set has been changed since; anything else changed since is kept", () => {
    importPeople(["Ada Lovelace", "Bea Arthur"]);
    const [ada, bea] = [id("Ada Lovelace"), id("Bea Arthur")];
    const tagged = changes.record(cli("edit tag commercial"), () => {
      people.addTags(ada, ["commercial"]);
      people.addTags(bea, ["commercial"]);
    }).changeset!;
    changes.record(cli("location"), () => people.setLocation(ada, "Tokyo"));
    changes.record(cli("tags"), () => people.addTags(ada, ["friend"]));
    changes.record(cli("tags"), () => people.removeTags(bea, ["commercial"]));

    let error: unknown;
    try {
      changes.undo(tagged, { surface: "cli" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UndoConflictError);
    expect((error as UndoConflictError).conflicts.map((c) => c.personId)).toEqual([bea]);
    expect((error as Error).message).toBe(`can't undo #${tagged}: changed again since: Bea Arthur [person ${bea}] (tags)`);
    expect(structure.getPerson(ada)!.tags).toEqual(["commercial", "friend"]);

    // Given it back, she is as the changeset left her (when it was given is not a change).
    changes.record(cli("tags"), () => people.addTags(bea, ["commercial"]));
    changes.undo(tagged, { surface: "cli" });
    expect(structure.getPerson(ada)).toMatchObject({ tags: ["friend"], location: "Tokyo" });
    expect(structure.getPerson(bea)!.tags).toEqual([]);
  });

  it("refuses when putting back would take away what was done since, such as a new tag given to someone else", () => {
    importPeople(["Ada Lovelace", "Bea Arthur"]);
    const [ada, bea] = [id("Ada Lovelace"), id("Bea Arthur")];
    const tagged = changes.record(cli("tag"), () => people.addTags(ada, ["commercial"])).changeset!;
    changes.record(cli("tag"), () => people.addTags(bea, ["commercial"]));
    expect(() => changes.undo(tagged, { surface: "cli" })).toThrow(`putting it back would also change what was done since: Bea Arthur [person ${bea}] (tags)`);
    expect(structure.getPerson(bea)!.tags).toEqual(["commercial"]);
    expect(structure.getPerson(ada)!.tags).toEqual(["commercial"]);
  });

  it("undoes a merge: the person merged away comes back with their id, accounts, tags, note and fields", () => {
    importPeople(["Ada Lovelace", "Ada L", "Bea Arthur"]);
    const [ada, other] = [id("Ada Lovelace"), id("Ada L")];
    people.setTags(other, ["uni"]);
    people.setNote(other, "met at uni");
    people.setLocation(other, "Brisbane");
    people.setLocation(ada, "Tokyo");
    const before = snapshot();
    const merged = changes.record(cli("merge"), () => people.merge(ada, other)).changeset!;
    expect(structure.getPerson(other)).toBeNull();
    changes.undo(merged, { surface: "cli" });
    expect(snapshot()).toEqual(before);
  });

  it("undoes Not them: the fresh person goes and the account and the proposals come back", () => {
    importPeople(["Ada Lovelace", "Ada L"]);
    const [ada, other] = [id("Ada Lovelace"), id("Ada L")];
    people.merge(ada, other);
    const account = structure.getPerson(ada)!.accounts.find((a) => a.displayName === "Ada L")!.id;
    const before = snapshot();
    const proposals = structure.proposals();
    const detached = changes.record(cli("detach"), () => people.detach(ada, account)).changeset!;
    expect(changes.show(detached).other).toEqual([`said messenger "Ada L" and Ada Lovelace are different people`]);
    changes.undo(detached, { surface: "cli" });
    expect(snapshot()).toEqual(before);
    expect(structure.proposals()).toEqual(proposals);
  });

  it("takes away a person added by hand, with their tags and location, and the tag it made", () => {
    importPeople(["Ada Lovelace"]);
    const before = snapshot();
    const added = changes.record(cli("person new"), () => people.add({ name: "Cy Twombly", location: "Rome", tags: ["painters"], note: "met offline" })).changeset!;
    expect(snapshot()).not.toEqual(before);
    changes.undo(added, { surface: "cli" });
    expect(snapshot()).toEqual(before);
  });

  it("refuses to take away a person it added who has been given an account since", () => {
    importPeople(["Ada Lovelace", "Bea Arthur"]);
    const added = changes.record(cli("person new"), () => people.create("Cy Twombly")).changeset!;
    const cy = id("Cy Twombly");
    const account = structure.getPerson(id("Bea Arthur"))!.accounts[0].id;
    changes.record(cli("link"), () => people.link(account, cy));
    expect(() => changes.undo(added, { surface: "cli" })).toThrow(/can't undo/);
    expect(structure.getPerson(cy)!.accounts.map((a) => a.id)).toEqual([account]);
  });

  it("undoes tag and value renames, merges, deletes and moves", () => {
    importPeople(["Ada Lovelace", "Bea Arthur"]);
    const [ada, bea] = [id("Ada Lovelace"), id("Bea Arthur")];
    people.setTags(ada, ["uni", "friend"]);
    people.setTags(bea, ["friend"]);
    people.setLocation(ada, "Tokio");
    people.setLocation(bea, "Tokyo");
    for (const edit of [
      () => people.tags.rename("uni", "friend"),
      () => people.tags.delete("friend"),
      () => people.tags.move("friend", 0),
      () => people.tags.rename("uni", "university"),
      () => people.locations.rename("Tokio", "Tokyo"),
      () => people.locations.rename("tokio", "TOKIO"),
    ]) {
      const before = snapshot();
      const { changeset } = changes.record(cli("edit"), edit);
      expect(snapshot()).not.toEqual(before);
      changes.undo(changeset!, { surface: "cli" });
      expect(snapshot()).toEqual(before);
    }
  });

  it("undoes This is me, counting the accounts as theirs again", () => {
    importPeople(["Ada Lovelace", "Bea Arthur"]);
    const before = snapshot();
    const archived = structure.listPeople().people.map((p) => [p.id, p.archived]);
    const mine = changes.record(cli("person me"), () => people.markAsMe(id("Bea Arthur"))).changeset!;
    changes.undo(mine, { surface: "cli" });
    expect(snapshot()).toEqual(before);
    expect(structure.listPeople().people.map((p) => [p.id, p.archived])).toEqual(archived);
  });
});

it(`keeps changesets for ${KEEP_DAYS} days`, () => {
  importPeople(["Ada Lovelace"]);
  const ada = id("Ada Lovelace");
  const old = changes.record(cli("tags"), () => people.addTags(ada, ["old"])).changeset!;
  const recent = changes.record(cli("tags"), () => people.addTags(ada, ["new"])).changeset!;
  db.prepare("UPDATE changeset SET at = ? WHERE id = ?").run(Date.now() - (KEEP_DAYS + 1) * 24 * 60 * 60 * 1000, old);
  expect(changes.prune()).toBe(1);
  expect(changes.list().map((c) => c.id)).toEqual([recent]);
  expect(db.prepare("SELECT DISTINCT changeset_id FROM change_row").all()).toEqual([{ changeset_id: recent }]);
  expect(() => changes.show(old)).toThrow(`no changeset #${old} (they are kept for ${KEEP_DAYS} days)`);
});
