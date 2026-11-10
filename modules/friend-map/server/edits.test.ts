import { mkdtemp, rm } from "node:fs/promises";
import { changeLog } from "./changeLog.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Changes, type Db } from "../../../sdk/server.ts";
import { openArchive } from "./db.ts";
import { applyEdit, parseEditAction, planEdit, type Selection } from "./edits.ts";
import { People } from "./people.ts";
import { ArchiveStructure } from "./structure.ts";

let dataDir: string;
let db: Db;
let people: People;
let structure: ArchiveStructure;
let ids: Record<"ada" | "bea" | "cy", number>;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-edits-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  people = new People(db);
  structure = new ArchiveStructure(db, people);
  ids = { ada: people.create("Ada Lovelace"), bea: people.create("Bea Arthur"), cy: people.create("Cy Twombly") };
  people.setTags(ids.ada, ["friend", "commercial"]);
  people.setTags(ids.bea, ["friend"]);
  people.setLocation(ids.bea, "Tokyo");
  people.setShouldReachOut(ids.cy, true);
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** The dry run as lines, then the edit made, the dry run again showing it done. */
function edit(selection: Selection, verb: string, ...args: string[]) {
  const action = parseEditAction(verb, args);
  const plan = planEdit({ db, structure, people }, selection, action);
  const lines = {
    action: plan.action,
    change: plan.change.map((p) => `${p.name}: ${p.before} -> ${p.after}`),
    already: plan.already.map((p) => `${p.name}: ${p.value}`),
    adds: plan.adds,
  };
  applyEdit(people, action, plan.change.map((p) => p.id));
  // The same people, by number: a query may choose others once they have changed (location:x, then clear-location).
  const after = planEdit({ db, structure, people }, { people: [...plan.change, ...plan.already].map((p) => p.id) }, action);
  expect(after.change).toEqual([]);
  expect(after.already.length).toBe(plan.selected);
  return lines;
}

const everyone = { query: "untagged OR friend" };

it("gives and takes tags, archive and keep among them, listing who is that way already", () => {
  expect(edit({ query: "friend" }, "tag", "commercial")).toEqual({
    action: "tag commercial",
    change: ["Bea Arthur: friend -> friend, commercial"],
    already: ["Ada Lovelace: friend, commercial"],
    adds: [],
  });
  expect(edit(everyone, "tag", "Night Owls", "archive")).toMatchObject({
    action: "tag night-owls archive",
    change: [
      "Ada Lovelace: friend, commercial -> archive, friend, commercial, night-owls",
      "Bea Arthur: friend, commercial -> archive, friend, commercial, night-owls",
      "Cy Twombly:  -> archive, night-owls",
    ],
    adds: ['the tag "night-owls"'],
  });
  expect(edit({ people: [ids.ada, ids.cy] }, "untag", "archive", "commercial")).toEqual({
    action: "untag archive commercial",
    change: ["Ada Lovelace: archive, friend, commercial, night-owls -> friend, night-owls", "Cy Twombly: archive, night-owls -> night-owls"],
    already: [],
    adds: [],
  });
  expect(structure.getPerson(ids.bea)!.archived).toBe("you");
  expect(edit({ people: [ids.bea] }, "tag", "keep").change).toEqual(["Bea Arthur: archive, friend, commercial, night-owls -> archive, keep, friend, commercial, night-owls"]);
});

it("taking a tag from the last people who have it deletes it, and the dry run says so; commercial stays", () => {
  people.setTags(ids.cy, ["night-owls"]);
  const all = { query: "friend OR night-owls" };
  const plan = (verb: string, ...args: string[]) => planEdit({ db, structure, people }, all, parseEditAction(verb, args));
  expect(plan("untag", "friend", "night-owls", "commercial").deletes).toEqual(['the tag "friend"', 'the tag "night-owls"']);
  expect(planEdit({ db, structure, people }, { people: [ids.ada] }, parseEditAction("untag", ["friend"])).deletes).toEqual([]);
  expect(plan("tag", "friend").deletes).toEqual([]);
  edit(all, "untag", "friend", "night-owls", "commercial");
  expect(people.tags.list().map((t) => t.name)).toEqual(["archive", "keep", "live-together", "show-name", "commercial"]);
});

it("sets and clears a location, one someone is at but for case being that one", () => {
  expect(edit(everyone, "location", "tokyo")).toEqual({
    action: "location tokyo",
    change: ["Ada Lovelace:  -> Tokyo", "Cy Twombly:  -> Tokyo"],
    already: ["Bea Arthur: Tokyo"],
    adds: [],
  });
  expect(edit({ people: [ids.ada] }, "location", "New", "York")).toEqual({
    action: "location New York", change: ["Ada Lovelace: Tokyo -> New York"], already: [], adds: ['the location "New York"'],
  });
  expect(edit({ query: "location:tokyo" }, "clear-location").change).toEqual(["Bea Arthur: Tokyo -> ", "Cy Twombly: Tokyo -> "]);
  expect(edit({ people: [ids.ada] }, "clear-location").change).toEqual(["Ada Lovelace: New York -> "]);
  // Met and Lives say what they became.
  expect(() => parseEditAction("met", ["Tokyo"])).toThrow("met is gone: Met and Lives became one Location (location <value ...>)");
  expect(() => parseEditAction("clear-lives", [])).toThrow("clear-lives is gone: Met and Lives became one Location (clear-location)");
});

it("switches reaching out", () => {
  expect(edit(everyone, "reach-out")).toMatchObject({ change: ["Ada Lovelace: no -> yes", "Bea Arthur: no -> yes"], already: ["Cy Twombly: yes"] });
  expect(edit({ query: "should-reach-out" }, "no-reach-out").change.length).toBe(3);
});

it("renames one person and sets their aliases, and refuses either for more than one", () => {
  expect(edit({ people: [ids.cy] }, "name", "Cy", "Twombly", "Jr").change).toEqual(["Cy Twombly: Cy Twombly -> Cy Twombly Jr"]);
  expect(edit({ people: [ids.bea] }, "aliases", "Bea", "B. Arthur").change).toEqual(["Bea Arthur:  -> Bea, B. Arthur"]);
  expect(edit({ people: [ids.bea] }, "clear-aliases").change).toEqual(["Bea Arthur: Bea, B. Arthur -> "]);
  expect(() => planEdit({ db, structure, people }, { query: "friend" }, parseEditAction("name", ["X"]))).toThrow("a name is for one person at a time; this chooses 2");
  expect(() => planEdit({ db, structure, people }, { query: "friend" }, parseEditAction("aliases", ["X"]))).toThrow("aliases are for one person at a time; this chooses 2");
});

it("says what is wrong with an edit or a choice", () => {
  expect(() => parseEditAction("tag", [])).toThrow("tag needs a tag");
  expect(() => parseEditAction("tag", ["system-archive"])).toThrow(/is not a tag/);
  expect(() => parseEditAction("reach-out", ["yes"])).toThrow('reach-out takes nothing more, not "yes"');
  expect(() => parseEditAction("delete", [])).toThrow(/^edit what\? tag <tag \.\.\.> \| untag/);
  const plan = (selection: Selection) => planEdit({ db, structure, people }, selection, parseEditAction("reach-out", []));
  expect(() => plan({ query: " " })).toThrow(/an empty query chooses everyone/);
  expect(() => plan({ query: "frend" })).toThrow('there is no tag "frend"; did you mean friend?');
  expect(() => plan({ people: [999] })).toThrow("no person 999");
});

it("is undone as one changeset", () => {
  const changes = changeLog(db, people);
  const action = parseEditAction("tag", ["commercial"]);
  const before = structure.listPeople().people.map((p) => p.tags);
  const plan = planEdit({ db, structure, people }, everyone, action);
  const { changeset } = changes.record({ surface: "cli", action: `edit ${plan.action}` }, () => applyEdit(people, action, plan.change.map((p) => p.id)));
  expect(changes.show(changeset!).peopleCount).toBe(2);
  changes.undo(changeset!, { surface: "cli" });
  expect(structure.listPeople().people.map((p) => p.tags)).toEqual(before);
});
