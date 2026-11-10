// The map's Hide (page/src/demos/hideChoices.ts): the rows it lists for the people a query matches, and a tag's switch
// carried over as the tag is renamed.

import { describe, expect, it } from "vitest";
import { chooseHide, hideEntries, hides, renameHidden } from "../page/src/demos/hideChoices.ts";

const people = [{ tags: ["climbing", "chess"] }, { tags: ["climbing"] }, { tags: [] }];

describe("Hide's rows", () => {
  it("list the tags in use, most used first, then those Hide starts with on, counted", () => {
    expect(hideEntries(people)).toEqual([
      { tag: "climbing", count: 2 }, { tag: "chess", count: 1 }, { tag: "archive", count: 0 }, { tag: "commercial", count: 0 },
    ]);
  });

  it("list every tag in the tag table, in its order, so one switched on can be switched off whoever the query matches", () => {
    const table = ["travel", "climbing", "chess"];
    expect(hideEntries(people, table)).toEqual([
      { tag: "travel", count: 0 }, { tag: "climbing", count: 2 }, { tag: "chess", count: 1 }, { tag: "archive", count: 0 }, { tag: "commercial", count: 0 },
    ]);
  });

  it("list a tag only while the table has it or someone the query matches does, besides those Hide starts with on", () => {
    const tags = hideEntries([{ tags: ["climbing"] }], ["climbing"]).map((entry) => entry.tag);
    expect(tags).toEqual(["climbing", "archive", "commercial"]);
  });

  it("keep a row where it is as its switch is ticked", () => {
    const order = (choices: Record<string, boolean>) => hideEntries(people.filter((person) => !person.tags.some((tag) => hides(choices, tag))), ["climbing", "chess"]).map((entry) => entry.tag);
    expect(order(chooseHide({}, "chess", true))).toEqual(order({}));
    expect(order(chooseHide({}, "climbing", true))).toEqual(order({}));
  });
});

describe("a tag renamed", () => {
  it("takes its switch to its new name, on or off", () => {
    expect(renameHidden({ climbing: true, chess: false }, "climbing", "bouldering")).toEqual({ chess: false, bouldering: true });
    expect(renameHidden({ climbing: false }, "climbing", "bouldering")).toEqual({ bouldering: false });
  });

  it("merged into one that exists, leaves the kept tag's switch", () => {
    expect(renameHidden({ climbing: true, chess: false }, "climbing", "chess", true)).toEqual({ chess: false });
  });

  it("takes a switch on by default with it", () => {
    expect(hides(renameHidden({}, "commercial", "business"), "business")).toBe(true);
  });

  it("changes nothing for a tag never switched", () => {
    const choices = { chess: true };
    expect(renameHidden(choices, "climbing", "bouldering")).toBe(choices);
  });
});
