// A tag renamed in Events' Tags table keeps its switch in the map's Hide (hide.ts): the console tells the module of the
// edit saved (sdk/viewer.ts's `saved`), and the choices friend-map's page keeps in this browser follow the new name.

import { describe, expect, it } from "vitest";
import type { SavedEdit } from "../../../sdk/viewer.ts";
import friendMap from "../module.ts";
import { HIDE_KEYS, hides, loadHideChoices, saveHideChoices } from "../page/src/demos/hideChoices.ts";
import { TAGS } from "../server/tabs/tagsTab.ts";
import viewer from "../viewer.tsx";
import { FRIEND_MAP_MODULE, followRename, TAGS_KIND } from "./hide.ts";

/** A browser's storage, held in a map. */
function memory() {
  const kept = new Map<string, string>();
  const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value), removeItem: (key: string) => void kept.delete(key) };
  return { kept, storage: () => storage };
}

const KEY = HIDE_KEYS.table;

const renamed = (before: string, after: string, more: Partial<SavedEdit> = {}): SavedEdit =>
  ({ module: FRIEND_MAP_MODULE, kind: TAGS_KIND, field: "name", before, after, gone: false, ...more });

describe("a tag renamed in Events' Tags", () => {
  it("is the module's Tags table, as the console names it", () => {
    expect(FRIEND_MAP_MODULE).toBe(friendMap.id);
    expect(TAGS_KIND).toBe(TAGS.spec.kind);
    expect(viewer.saved).toBeDefined();
  });

  it("stays hidden under its new name, and the old name's switch goes", () => {
    const { storage } = memory();
    saveHideChoices(KEY, { climbing: true, chess: false }, storage);
    followRename(renamed("climbing", "bouldering"), storage);
    const choices = loadHideChoices(KEY, storage);
    expect(hides(choices, "bouldering")).toBe(true);
    expect("climbing" in choices).toBe(false);
    expect(hides(choices, "chess")).toBe(false);
  });

  it("keeps a tag Hide starts with on hidden under its new name, though its switch was never touched", () => {
    const { storage } = memory();
    followRename(renamed("commercial", "business"), storage);
    expect(hides(loadHideChoices(KEY, storage), "business")).toBe(true);
  });

  it("merged into a tag that exists, leaves that tag's own switch as it was", () => {
    const { storage } = memory();
    saveHideChoices(KEY, { climbing: true, chess: false }, storage);
    followRename(renamed("climbing", "chess", { gone: true }), storage);
    const choices = loadHideChoices(KEY, storage);
    expect(hides(choices, "chess")).toBe(false);
    expect("climbing" in choices).toBe(false);
  });

  it("changes nothing for a tag never switched, another field, another table or another module's", () => {
    const { kept, storage } = memory();
    followRename(renamed("climbing", "bouldering"), storage);
    expect(kept.size).toBe(0);
    saveHideChoices(KEY, { climbing: true }, storage);
    const before = kept.get(KEY);
    followRename(renamed("climbing", "bouldering", { field: "order" }), storage);
    followRename(renamed("climbing", "bouldering", { kind: "people" }), storage);
    followRename(renamed("climbing", "bouldering", { module: "inspirations" }), storage);
    expect(kept.get(KEY)).toBe(before);
  });
});
