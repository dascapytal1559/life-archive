// The Inspirations page's tabs, addresses and words: what each tab reads of the address's query, the item open and the list's page, an old link to Recent, and how an item, its source, its link and typed tags are written.

import { describe, expect, it } from "vitest";
import { consolePath } from "../../../sdk/viewer.ts";
import { NO_INSPIRATION_FILTER, inspirationParams, readInspirationFilter } from "../wire.ts";
import { INSPIRATIONS_ASPECT, inspirationsPath, inspirationsViews, platformPath } from "./InspirationsSection.tsx";
import { instagramCode, instagramEmbed, itemName, originLabel, shortLink, sourceLabel, typedTags } from "./format.ts";
import {
  asksForRecent,
  INSPIRATIONS_TABS,
  inspirationsAddress,
  openItemOf,
  PAGE_SIZE,
  pageCount,
  pageNumbers,
  pageOf,
  tabFilter,
} from "./tabs.ts";

const tab = (key: string) => INSPIRATIONS_TABS.find((t) => t.key === key)!;

describe("the Inspirations page's tabs", () => {
  it("are Platforms first, then Recent, By tag, Search, Untagged, Tags and Changes", () => {
    expect(INSPIRATIONS_TABS.map((t) => t.label)).toEqual(["Platforms", "Recent", "By tag", "Search", "Untagged", "Tags", "Changes"]);
  });

  it("send an old link to Recent at the first tab's address on to Recent, and read a platform on Recent alone", () => {
    for (const search of ["?page=3", "?item=12", "?hidden=1", "?platform=youtube", "?page=2&item=7&theme=dark"]) expect(asksForRecent(search), search).toBe(true);
    for (const search of ["", "?theme=dark", "?tags=art"]) expect(asksForRecent(search), search).toBe(false);
    expect(tabFilter(tab("recent"), "?platform=youtube&hidden=1&tags=art")).toEqual({ ...NO_INSPIRATION_FILTER, platform: "youtube", hidden: true });
    expect(tabFilter(tab("search"), "?platform=youtube&q=kids")).toEqual({ ...NO_INSPIRATION_FILTER, q: "kids" });
    expect(tabFilter(tab(""), "?platform=youtube&hidden=1")).toEqual(NO_INSPIRATION_FILTER);
    expect(inspirationsAddress("/at/recent", tab("recent"), { ...NO_INSPIRATION_FILTER, platform: "youtube" }, null, 2)).toBe("/at/recent?platform=youtube&page=2");
  });


  it("read only what each offers from the query, and write it back with the item open", () => {
    const search = "?tags=parenting,art&kind=ai&q=kids&hidden=1&item=7";
    expect(tabFilter(tab("by-tag"), search)).toEqual({ ...NO_INSPIRATION_FILTER, tags: ["parenting", "art"], tagKind: "ai", hidden: true });
    expect(tabFilter(tab("search"), search)).toEqual({ ...NO_INSPIRATION_FILTER, q: "kids", hidden: true });
    expect(tabFilter(tab("untagged"), "?tags=art")).toEqual({ ...NO_INSPIRATION_FILTER, untagged: true });
    expect(openItemOf(search)).toBe(7);
    expect(openItemOf("?item=x")).toBeNull();
    expect(inspirationsAddress("/at/by-tag", tab("by-tag"), tabFilter(tab("by-tag"), search), 7)).toBe("/at/by-tag?tags=parenting%2Cart&kind=ai&hidden=1&item=7");
    expect(inspirationsAddress("/at/untagged", tab("untagged"), tabFilter(tab("untagged"), ""), null)).toBe("/at/untagged");
    const filter = { tags: ["music"], tagKind: "manual" as const, q: "a song", untagged: false, platform: "instagram", hidden: false };
    expect(readInspirationFilter(inspirationParams(filter))).toEqual(filter);
  });

  it("keep the list's page in the address, the first saying nothing, and offer the pages around it by number", () => {
    expect(inspirationsAddress("/at", tab("recent"), NO_INSPIRATION_FILTER, 12, 3)).toBe("/at?page=3&item=12");
    expect(inspirationsAddress("/at", tab("recent"), NO_INSPIRATION_FILTER, null, 1)).toBe("/at");
    expect(pageOf("?page=3&item=12")).toBe(3);
    for (const search of ["", "?page=0", "?page=x", "?page=-2"]) expect(pageOf(search), search).toBe(1);
    expect(PAGE_SIZE).toBe(48);
    expect([pageCount(0), pageCount(48), pageCount(49), pageCount(573)]).toEqual([1, 1, 2, 12]);
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(1, 12)).toEqual([1, 2, 3, null, 12]);
    expect(pageNumbers(6, 12)).toEqual([1, null, 4, 5, 6, 7, 8, null, 12]);
    // A gap of one page is that page, never an ellipsis.
    expect(pageNumbers(4, 12)).toEqual([1, 2, 3, 4, 5, 6, null, 12]);
    expect(pageNumbers(12, 12)).toEqual([1, null, 10, 11, 12]);
  });
});

describe("the Inspirations page's words", () => {
  it("name an item by its title, else his words' first line, else its description's, else its link", () => {
    expect(itemName({ title: "Throwing a tall vase", caption: "slow hands", description: null, link: null })).toBe("Throwing a tall vase");
    expect(itemName({ title: null, caption: "slow hands\nand more", description: "a vase", link: "https://example.com/a" })).toBe("slow hands");
    expect(itemName({ title: null, caption: "", description: "A tall vase in one pull\n#pottery", link: "https://www.instagram.com/p/MadeUp0003/" })).toBe("A tall vase in one pull");
    expect(itemName({ title: null, caption: "", description: null, link: "https://www.example.com/posts/a" })).toBe("example.com/posts/a");
    expect(itemName({ title: null, caption: "", description: null, link: null })).toBe("A kept file");
  });

  it("show a link short, and find an Instagram post's code for its embed", () => {
    expect(shortLink("https://www.instagram.com/p/MadeUp0003/")).toBe("instagram.com/p/MadeUp0003");
    expect(shortLink("https://blog.example.com/terrazzo-by-hand")).toBe("blog.example.com/terrazzo-by-hand");
    expect(shortLink("https://www.youtube.com/watch?v=MadeUpVid01")).toBe("youtube.com/watch?v=MadeUpVid01");
    expect(instagramCode({ platform: "instagram", link: "https://www.instagram.com/p/MadeUp0003/" })).toBe("MadeUp0003");
    expect(instagramCode({ platform: "instagram", link: "https://www.instagram.com/madeupaccount" })).toBeNull();
    expect(instagramCode({ platform: "youtube", link: "https://www.youtube.com/watch?v=MadeUpVid01" })).toBeNull();
    expect(instagramEmbed("MadeUp0003")).toBe("https://www.instagram.com/p/MadeUp0003/embed/");
  });

  it("say where it is from and where a save came from, and write typed tags as the archive does", () => {
    expect(sourceLabel({ platform: "youtube", form: "short" })).toBe("YouTube short");
    expect(sourceLabel({ platform: "file", form: "image" })).toBe("Kept image");
    expect(sourceLabel({ platform: "instagram", form: "other" })).toBe("Instagram");
    expect(originLabel("grok-bot")).toBe("Grok Bot");
    expect(typedTags(" Interior design, music,, music ")).toEqual(["interior-design", "music"]);
  });
});

describe("the console's addresses of Inspirations' tabs", () => {
  it("are its aspect's, each tab a step below it but the first, and Recent narrowed to a platform keeps it in the query", () => {
    expect(INSPIRATIONS_TABS.map(inspirationsPath)).toEqual(INSPIRATIONS_TABS.map((tab) => consolePath(INSPIRATIONS_ASPECT, tab.key || undefined)));
    expect(inspirationsViews().map((view) => view.label)).toEqual(INSPIRATIONS_TABS.map((tab) => tab.label));
    expect(platformPath("youtube")).toBe("/life-archive/dev/inspirations/recent?platform=youtube");
  });
});
