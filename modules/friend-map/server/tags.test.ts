import { mkdtemp, rm } from "node:fs/promises";
import { changeLog } from "./changeLog.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Changes, type Db, getMeta } from "../../../sdk/server.ts";
import { openArchive } from "./db.ts";
import { People } from "./people.ts";
import { ArchiveStructure } from "./structure.ts";
import type { Tags } from "./tags.ts";

let dataDir: string;
let db: Db;
let people: People;
let tags: Tags;
let structure: ArchiveStructure;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "friend-map-tags-"));
  db = openArchive(join(dataDir, "archive.sqlite"));
  people = new People(db);
  tags = people.tags;
  structure = new ArchiveStructure(db, people);
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const names = () => tags.list().map((t) => t.name);
const version = () => getMeta(db, "people_version");

describe("the tag table", () => {
  it("adds tags last, hyphenated, and keeps one nobody has", () => {
    expect(tags.create("Tokyo  Era")).toBe("tokyo-era");
    tags.create("uni");
    expect(tags.list()).toEqual([
      { name: "archive", count: 0, builtIn: true },
      { name: "keep", count: 0, builtIn: true },
      { name: "live-together", count: 0, builtIn: true },
      { name: "show-name", count: 0, builtIn: true },
      { name: "tokyo-era", count: 0, builtIn: false },
      { name: "uni", count: 0, builtIn: false },
    ]);
    expect(() => tags.create("uni")).toThrow(/already a tag "uni"/);
    expect(() => tags.create("system-archive")).toThrow(/is not a tag/);
    expect(() => tags.create("me")).toThrow(/This is me/);
    expect(() => tags.create("not/ok")).toThrow(/not a tag/);
  });

  it("a tag given to a person that is not in the table yet is added to it, last; a person's tags go in the tag order", () => {
    tags.create("uni");
    const ada = people.create("Ada");
    people.setTags(ada, ["family", "uni"]);
    expect(names()).toEqual(["archive", "keep", "live-together", "show-name", "uni", "family"]);
    expect(structure.getPerson(ada)?.tags).toEqual(["uni", "family"]);
    tags.move("family", 0);
    expect(structure.getPerson(ada)?.tags).toEqual(["family", "uni"]);
  });

  it("taking a tag from the last person who has it deletes it too, and one undo brings both back, in its place", () => {
    const changes = changeLog(db, people);
    const [ada, bea] = [people.create("Ada"), people.create("Bea")];
    people.setTags(ada, ["typo", "uni", "family"]);
    people.setTags(bea, ["uni"]);
    const { changeset } = changes.record({ surface: "app", action: "person tags" }, () => people.removeTags(ada, ["typo", "uni"]));
    expect(names()).toEqual(["archive", "keep", "live-together", "show-name", "uni", "family"]);
    expect(structure.getPerson(ada)?.tags).toEqual(["family"]);
    changes.undo(changeset!, { surface: "app" });
    expect(names()).toEqual(["archive", "keep", "live-together", "show-name", "typo", "uni", "family"]);
    expect(structure.getPerson(ada)?.tags).toEqual(["typo", "uni", "family"]);
    // A tag made after the deletion never takes the deleted one's id, so the undo still works.
    people.addTags(ada, ["famly"]);
    const { changeset: typo } = changes.record({ surface: "app", action: "person tags" }, () => people.removeTags(ada, ["famly"]));
    people.addTags(bea, ["family-friend"]);
    changes.undo(typo!, { surface: "app" });
    // Both were last when made, so they share that place, A to Z.
    expect(names()).toEqual(["archive", "keep", "live-together", "show-name", "typo", "uni", "family", "family-friend", "famly"]);
    // Setting the whole list (the person panel) does the same.
    people.setTags(ada, ["family"]);
    people.setTags(bea, []);
    expect(names()).toEqual(["archive", "keep", "live-together", "show-name", "family"]);
  });

  it("keeps a tag nobody had before, the built-in ones and those Hide starts on, when nobody has them", () => {
    tags.create("later");
    const ada = people.create("Ada");
    people.setTags(ada, ["archive", "keep", "commercial", "uni"]);
    people.setTags(ada, ["uni"]);
    people.removeTags(ada, ["later"]);
    expect(names()).toEqual(["archive", "keep", "live-together", "show-name", "later", "commercial", "uni"]);
    people.setTags(ada, []);
    expect(names()).toEqual(["archive", "keep", "live-together", "show-name", "later", "commercial"]);
  });

  it("renames a tag for everyone who has it, in one change", () => {
    const [ada, bea] = [people.create("Ada"), people.create("Bea")];
    people.setTags(ada, ["uni"]);
    people.setTags(bea, ["uni", "family"]);
    const before = version();
    expect(tags.rename("uni", "Uni Friends")).toEqual({ name: "uni-friends", merged: false });
    expect(version()).not.toBe(before);
    expect([ada, bea].map((id) => structure.getPerson(id)?.tags)).toEqual([["uni-friends"], ["uni-friends", "family"]]);
    expect(names()).toEqual(["archive", "keep", "live-together", "show-name", "uni-friends", "family"]);
    expect(structure.listPeople({ tag: "Uni friends" }).people.map((p) => p.name).sort()).toEqual(["Ada", "Bea"]);
    expect(() => tags.rename("nope", "x")).toThrow(/no tag "nope"/);
  });

  it("renaming onto a tag that exists merges the two: everyone has the one kept, in its place", () => {
    const [ada, bea, cy] = [people.create("Ada"), people.create("Bea"), people.create("Cy")];
    people.setTags(ada, ["uni"]);
    people.setTags(bea, ["uni", "family"]);
    people.setTags(cy, ["family"]);
    expect(tags.rename("uni", "family")).toEqual({ name: "family", merged: true });
    expect(names()).toEqual(["archive", "keep", "live-together", "show-name", "family"]);
    expect(tags.list().find((t) => t.name === "family")?.count).toBe(3);
    expect([ada, bea, cy].map((id) => structure.getPerson(id)?.tags)).toEqual([["family"], ["family"], ["family"]]);
  });

  it("deleting a tag takes it from everyone, and closes up the order", () => {
    const [ada, bea] = [people.create("Ada"), people.create("Bea")];
    people.setTags(ada, ["uni", "family"]);
    people.setTags(bea, ["uni"]);
    expect(tags.delete("uni")).toBe(2);
    expect(names()).toEqual(["archive", "keep", "live-together", "show-name", "family"]);
    expect([ada, bea].map((id) => structure.getPerson(id)?.tags)).toEqual([["family"], []]);
    expect(db.prepare("SELECT sort_order FROM tag ORDER BY sort_order").all().map((row) => ({ ...row }))).toEqual([
      { sort_order: 0 }, { sort_order: 1 }, { sort_order: 2 }, { sort_order: 3 }, { sort_order: 4 },
    ]);
    expect(() => tags.delete("uni")).toThrow(/no tag "uni"/);
  });

  it("archive, keep, live-together and show-name can be moved, but never renamed, merged into or deleted", () => {
    tags.create("hide");
    expect(() => tags.rename("archive", "hidden")).toThrow(/built in/);
    expect(() => tags.rename("hide", "archive")).toThrow(/built in/);
    expect(() => tags.rename("hide", "keep")).toThrow(/built in/);
    expect(() => tags.delete("keep")).toThrow(/built in/);
    expect(() => tags.rename("live-together", "housemates")).toThrow(/built in/);
    expect(() => tags.rename("hide", "live-together")).toThrow(/built in/);
    expect(() => tags.delete("live-together")).toThrow(/built in/);
    expect(() => tags.rename("show-name", "named")).toThrow(/built in/);
    expect(() => tags.rename("hide", "show-name")).toThrow(/built in/);
    expect(() => tags.delete("show-name")).toThrow(/built in/);
    tags.move("archive", 99);
    expect(names()).toEqual(["keep", "live-together", "show-name", "hide", "archive"]);
    expect(() => tags.move("hide", -1)).toThrow(/position/);
  });

  it("a person's tags go with them: a merge gives the one kept both's, and deleting a person takes theirs", () => {
    const [ada, bea] = [people.create("Ada"), people.create("Bea")];
    people.setTags(ada, ["uni"]);
    people.setTags(bea, ["family", "uni"]);
    people.merge(ada, bea);
    expect(structure.getPerson(ada)?.tags).toEqual(["uni", "family"]);
    expect(tags.list().map((t) => [t.name, t.count])).toEqual([["archive", 0], ["keep", 0], ["live-together", 0], ["show-name", 0], ["uni", 1], ["family", 1]]);
    people.delete(ada);
    expect(db.prepare("SELECT count(*) AS n FROM person_tag").get()).toEqual({ n: 0 });
  });

  it("a merge carries live-together over, as any tag but archive and keep, and it stays when nobody has it", () => {
    const [ada, bea] = [people.create("Ada"), people.create("Bea")];
    people.setTags(bea, ["live-together", "keep"]);
    people.merge(ada, bea);
    expect(structure.getPerson(ada)?.tags).toEqual(["live-together"]);
    people.setTags(ada, []);
    expect(names()).toContain("live-together");
  });

  it("the archive tag still archives, however it came", () => {
    const ada = people.create("Ada");
    tags.create("hide");
    people.setTags(ada, ["hide"]);
    expect(structure.getPerson(ada)?.archived).toBeNull();
    people.addTags(ada, ["archive"]);
    expect(structure.getPerson(ada)?.archived).toBe("you");
    expect(structure.getPerson(ada)?.tags).toEqual(["archive", "hide"]);
  });
});
