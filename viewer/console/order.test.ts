import { describe, expect, it } from "vitest";
import { isDefaultOrder, layoutAfter, move, movedWords, orderAspects, orderToStore, slotOf, storedKeys, type Block } from "./order.ts";
import { ASPECTS, type Aspect } from "./registry.ts";

const aspect = (key: string): Aspect => ({ key, label: key, blurb: "", icon: "events" });
const FOUR = ["health", "events", "rituals", "shopping"].map(aspect);
const keysOf = (aspects: readonly Aspect[]) => aspects.map((a) => a.key);

describe("the rail's order", () => {
  it("is the registry's when nothing is kept, or what is kept cannot be read", () => {
    for (const kept of [null, "", "not json", "{}", '"health"', "[1, 2]"]) {
      expect(keysOf(orderAspects(storedKeys(kept), FOUR)), String(kept)).toEqual(keysOf(FOUR));
    }
  });

  it("is the kept order, each aspect once", () => {
    const kept = JSON.stringify(["shopping", "rituals", "health", "events", "health"]);
    expect(keysOf(orderAspects(storedKeys(kept), FOUR))).toEqual(["shopping", "rituals", "health", "events"]);
  });

  it("finds an aspect renamed since by its former key, in the place it was kept", () => {
    const renamed = [...FOUR.slice(0, 3), { ...aspect("garden"), formerKeys: ["garden-project"] }, FOUR[3]];
    expect(keysOf(orderAspects(["garden-project", "shopping", "rituals", "events", "health"], renamed))).toEqual(["garden", "shopping", "rituals", "events", "health"]);
  });

  it("forgets an aspect the console has since dropped", () => {
    expect(keysOf(orderAspects(["people", "events", "health", "rituals", "shopping"], FOUR))).toEqual(["events", "health", "rituals", "shopping"]);
  });

  it("puts an aspect added since after the one it follows in the registry, or first if it is first", () => {
    const kept = ["shopping", "rituals", "events"];
    // health (the registry's first) was never kept: it goes first.
    expect(keysOf(orderAspects(kept, FOUR))).toEqual(["health", "shopping", "rituals", "events"]);
    const withGarden = [...FOUR.slice(0, 3), aspect("garden"), FOUR[3]];
    expect(keysOf(orderAspects(["shopping", "rituals", "events", "health"], withGarden))).toEqual(["shopping", "rituals", "garden", "events", "health"]);
    // Two new ones in a row keep their order.
    const withTwo = [...FOUR, aspect("a"), aspect("b")];
    expect(keysOf(orderAspects(["events", "health", "rituals", "shopping"], withTwo))).toEqual(["events", "health", "rituals", "shopping", "a", "b"]);
  });

  it("keeps nothing for the registry's own order, so a new default reaches the rail", () => {
    expect(orderToStore(FOUR, FOUR)).toBeNull();
    expect(isDefaultOrder(FOUR, FOUR)).toBe(true);
    const mine = move(FOUR, 3, 0);
    expect(isDefaultOrder(mine, FOUR)).toBe(false);
    const kept = orderToStore(mine, FOUR);
    expect(kept).toBe(JSON.stringify(["shopping", "health", "events", "rituals"]));
    expect(orderAspects(storedKeys(kept), FOUR)).toEqual(mine);
  });

  it("reads back every order of the console's own aspects as kept", () => {
    const reversed = [...ASPECTS].reverse();
    expect(orderAspects(storedKeys(orderToStore(reversed, ASPECTS)), ASPECTS)).toEqual(reversed);
  });
});

describe("moving an aspect", () => {
  it("moves one item, up or down, clamped to the list", () => {
    expect(move(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(move(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(move(["a", "b", "c", "d"], 1, 1)).toEqual(["a", "b", "c", "d"]);
    expect(move(["a", "b", "c", "d"], 1, 9)).toEqual(["a", "c", "d", "b"]);
    expect(move(["a", "b", "c", "d"], 2, -3)).toEqual(["c", "a", "b", "d"]);
  });

  it("says where it went, or that it is already at an end", () => {
    expect(movedWords("Events", 0, 7)).toBe("Events moved to 1 of 7.");
    expect(movedWords("Events", 0, 7, false)).toBe("Events is already first.");
    expect(movedWords("Events", 6, 7, false)).toBe("Events is already last.");
  });
});

describe("a drag's arithmetic", () => {
  // Four blocks 36 px tall, 4 px apart from 100; the second the current aspect, 120 px with its views.
  const blocks: Block[] = [
    { top: 100, height: 36 },
    { top: 140, height: 120 },
    { top: 264, height: 36 },
    { top: 304, height: 36 },
  ];

  it("lands where the block's middle has passed the others' middles", () => {
    // The first, unmoved (its middle at 118), stays first.
    expect(slotOf(blocks, 0, 118)).toBe(0);
    // Past the tall block's middle (200) but not the third's (282): second.
    expect(slotOf(blocks, 0, 201)).toBe(1);
    expect(slotOf(blocks, 0, 283)).toBe(2);
    expect(slotOf(blocks, 0, 999)).toBe(3);
    // The last dragged up above everything.
    expect(slotOf(blocks, 3, 0)).toBe(0);
    expect(slotOf(blocks, 3, 250)).toBe(2);
  });

  it("lays the blocks out again around the slot, keeping the gap", () => {
    expect(layoutAfter(blocks, 0, 0)).toEqual([100, 140, 264, 304]);
    // The first moved to the end: the others close up, it goes after the last.
    expect(layoutAfter(blocks, 0, 3)).toEqual([304, 100, 224, 264]);
    // The tall one moved first: it at the top, the first under it.
    expect(layoutAfter(blocks, 1, 0)).toEqual([224, 100, 264, 304]);
    expect(layoutAfter([], 0, 0)).toEqual([]);
    expect(layoutAfter([{ top: 10, height: 20 }], 0, 0)).toEqual([10]);
  });
});
