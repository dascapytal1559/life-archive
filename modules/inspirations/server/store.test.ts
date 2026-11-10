// The inspirations (store.ts) and their links (links.ts): canonical links joining saves, captures,
// his tags and the AI's kept apart, the vocabulary, the filters, the server's queue, and every edit of his in the
// change log with Undo. Every item is made up.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Changes, Db } from "../../../sdk/server.ts";
import { openModuleDatabase } from "../../../sdk/testing.ts";
import { NO_INSPIRATION_FILTER, type InspirationFilter } from "../wire.ts";
import { INSPIRATIONS_DATABASE } from "./db.ts";
import { canonicalLink, looksLikeLink } from "./links.ts";
import { openInspirations } from "./part.ts";
import { AI_TRIES, INSPIRATION_TABLES, Inspirations, inspirationProblems } from "./store.ts";

const NOW = Date.parse("2026-10-18T09:00:00+11:00");

describe("canonical links", () => {
  it("make every Instagram post and reel link one, and say which it was", () => {
    for (const link of [
      "https://www.instagram.com/p/AbC123xyz/?igsh=MWQ1ZGUxMzBkMA==",
      "instagram.com/p/AbC123xyz",
      "https://www.instagram.com/studio.example/p/AbC123xyz/",
    ]) expect(canonicalLink(link)).toEqual({ link: "https://www.instagram.com/p/AbC123xyz/", platform: "instagram", form: "post", nativeId: "AbC123xyz" });
    expect(canonicalLink("https://www.instagram.com/reel/AbC123xyz/?utm_source=ig_web_copy_link")).toMatchObject({ link: "https://www.instagram.com/p/AbC123xyz/", form: "reel" });
    expect(canonicalLink("https://instagram.com/reels/AbC123xyz")).toMatchObject({ link: "https://www.instagram.com/p/AbC123xyz/", form: "reel" });
  });

  it("make X and Twitter status links one, by the post's id", () => {
    for (const link of ["https://x.com/somebody/status/1790000000000000001?s=46&t=abc", "https://twitter.com/i/status/1790000000000000001", "mobile.twitter.com/x/status/1790000000000000001/photo/1"]) {
      expect(canonicalLink(link)).toEqual({ link: "https://x.com/i/status/1790000000000000001", platform: "x", form: "tweet", nativeId: "1790000000000000001" });
    }
  });

  it("make every YouTube link to a video one, a short still a short", () => {
    for (const link of ["https://youtu.be/AbCdEfGhIjK?si=xyz", "https://www.youtube.com/watch?v=AbCdEfGhIjK&t=42s", "https://m.youtube.com/watch?v=AbCdEfGhIjK", "https://www.youtube.com/embed/AbCdEfGhIjK"]) {
      expect(canonicalLink(link)).toEqual({ link: "https://www.youtube.com/watch?v=AbCdEfGhIjK", platform: "youtube", form: "video", nativeId: "AbCdEfGhIjK" });
    }
    expect(canonicalLink("https://youtube.com/shorts/AbCdEfGhIjK?feature=share")).toMatchObject({ link: "https://www.youtube.com/watch?v=AbCdEfGhIjK", form: "short" });
  });

  it("drop tracking and fragments from any other link, keeping what says what it is", () => {
    expect(canonicalLink("HTTPS://Blog.Example.COM/posts/tiles/?utm_source=x&utm_medium=y&page=2&fbclid=abc#top")).toEqual({
      link: "https://blog.example.com/posts/tiles?page=2", platform: "web", form: "article", nativeId: null,
    });
    expect(canonicalLink("https://www.tiktok.com/@someone/video/123")).toMatchObject({ platform: "tiktok", form: "post" });
  });

  it("refuse what is not a web link", () => {
    expect(() => canonicalLink("not a link")).toThrow("is not a link");
    expect(() => canonicalLink("ftp://example.com/file")).toThrow("is not a web link");
    expect(looksLikeLink("youtu.be/AbCdEfGhIjK")).toBe(true);
    expect(looksLikeLink("/Users/someone/Desktop/photo.png")).toBe(false);
  });
});

let dataDir: string;
let db: Db;
let changes: Changes;
let inspirations: Inspirations;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "life-archive-inspirations-"));
  db = openModuleDatabase(join(dataDir, "inspirations.sqlite"), INSPIRATIONS_DATABASE).db;
  ({ changes, store: inspirations } = openInspirations(db));
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const filter = (more: Partial<InspirationFilter> = {}): InspirationFilter => ({ ...NO_INSPIRATION_FILTER, ...more });
const ids = (more: Partial<InspirationFilter> = {}) => inspirations.list(filter(more)).items.map((item) => item.id);
const capture = (link: string, more: Partial<Parameters<Inspirations["capture"]>[0]> = {}) =>
  inspirations.capture({ link, origin: "cli", savedAt: NOW, now: NOW, ...more });
const edit = <T>(work: () => T) => changes.record({ surface: "cli", action: "test" }, work);

describe("a capture", () => {
  it("makes an item from a link, with his words and tags, and queues its preview and AI tags", () => {
    const made = capture("https://www.instagram.com/reel/AbC123xyz/?igsh=x", {
      caption: "the slow hands thing, I want to try this", tags: ["Craft", "art"], title: "Throwing a tall vase", author: "@studio.example", origin: "grok-bot",
    });
    expect(made).toEqual({ id: 1, created: true, saved: true });
    expect(inspirations.get(1)).toMatchObject({
      link: "https://www.instagram.com/p/AbC123xyz/", platform: "instagram", form: "reel", title: "Throwing a tall vase", author: "@studio.example",
      caption: "the slow hands thing, I want to try this", tags: ["craft", "art"], aiTags: [], aiState: "pending", previewState: "pending", saveCount: 1,
      saves: [{ origin: "grok-bot", link: "https://www.instagram.com/reel/AbC123xyz/?igsh=x", caption: "the slow hands thing, I want to try this", savedAt: NOW }],
    });
    expect(inspirations.tags().tags.map((t) => t.name)).toEqual(["craft", "art"]);
  });

  it("joins a second save of the same thing to the item: its words added, its tags too, what was known kept", () => {
    capture("https://youtu.be/AbCdEfGhIjK", { caption: "a song for the drive", title: "First title" });
    db.prepare("UPDATE inspiration SET ai_state = 'done'").run();
    const again = capture("https://www.youtube.com/watch?v=AbCdEfGhIjK&si=abc", { caption: "and the bridge at 2:10", tags: ["music"], title: "Other title", author: "A channel", origin: "grok-bot" });
    expect(again).toEqual({ id: 1, created: false, saved: true });
    expect(inspirations.get(1)).toMatchObject({
      caption: "a song for the drive\n\nand the bridge at 2:10", tags: ["music"], title: "First title", author: "A channel", saveCount: 2, aiState: "pending",
    });
    // The same words again add nothing.
    capture("https://youtu.be/AbCdEfGhIjK", { caption: "a song for the drive" });
    expect(inspirations.get(1)!.caption).toBe("a song for the drive\n\nand the bridge at 2:10");
  });

  it("keeps a file with no link as an item of its own, joined by its content hash", () => {
    const file = { path: "files/ab/ab12.png", mime: "image/png", bytes: 120, sha256: "ab12" };
    const made = inspirations.capture({ files: [file], caption: "tiles for the bathroom", origin: "cli", savedAt: NOW, now: NOW });
    expect(inspirations.get(made.id)).toMatchObject({ link: null, platform: "file", form: "image", previewState: "none", image: { fileId: 1 }, files: [{ id: 1, role: "item", mime: "image/png", bytes: 120 }] });
    expect(inspirations.capture({ files: [file], origin: "cli", savedAt: NOW, now: NOW })).toMatchObject({ id: made.id, created: false });
    expect(inspirations.file(1)).toEqual({ path: file.path, mime: "image/png", bytes: 120 });
  });

  it("adds nothing for an import's save read again, and refuses one with neither link nor file", () => {
    capture("https://example.com/a", { origin: "chrome", nativeId: "guid-1" });
    expect(capture("https://example.com/a", { origin: "chrome", nativeId: "guid-1" })).toEqual({ id: 1, created: false, saved: false });
    expect(() => inspirations.capture({ origin: "cli", savedAt: NOW, now: NOW })).toThrow("needs a link or a file");
    expect(() => capture("https://example.com/b", { origin: "Grok Bot" })).toThrow("is not an origin");
    expect(() => capture("https://example.com/b", { tags: ["a tag that is far too long to be any tag at all, really"] })).toThrow("is not a tag");
  });
});

describe("lists", () => {
  beforeEach(() => {
    capture("https://example.com/vase", { caption: "slow hands", tags: ["craft", "art"], now: NOW - 3000 });
    capture("https://example.com/lullaby", { caption: "for bedtime", tags: ["parenting", "music"], now: NOW - 2000 });
    capture("https://example.com/drawing", { caption: "drawing with the kids", title: "Paper and crayons", tags: ["parenting", "art"], now: NOW - 1000 });
    capture("https://example.com/soup", { caption: "for a cold night", now: NOW });
    inspirations.setAiTags(4, ["cooking", "Comfort Food", "a sentence is not a tag at all, the AI said", "cooking"], "a-model", NOW);
    inspirations.setAiTags(1, ["ceramics", "art"], "a-model", NOW);
  });

  it("are newest first, narrowed to every tag asked for, of his or of the AI's, never mixing the two", () => {
    expect(ids()).toEqual([4, 3, 2, 1]);
    expect(ids({ tags: ["parenting", "art"] })).toEqual([3]);
    expect(ids({ tags: ["art"] })).toEqual([3, 1]);
    expect(ids({ tags: ["art"], tagKind: "ai" })).toEqual([1]);
    expect(ids({ tags: ["cooking"] })).toEqual([]);
    expect(ids({ tags: ["comfort-food"], tagKind: "ai" })).toEqual([4]);
    expect(inspirations.get(4)!.aiTags).toEqual(["cooking", "comfort-food"]);
    expect(ids({ untagged: true })).toEqual([4]);
  });

  it("find words in his caption, what is known, the link and both kinds of tags, every word", () => {
    expect(ids({ q: "CRAYONS" })).toEqual([3]);
    expect(ids({ q: "bedtime" })).toEqual([2]);
    expect(ids({ q: "ceramics" })).toEqual([1]);
    expect(ids({ q: "parenting kids" })).toEqual([3]);
    expect(ids({ q: "lullaby" })).toEqual([2]);
    expect(ids({ q: "100%" })).toEqual([]);
  });

  it("leave hidden items out but in Hidden, and count each tag over what is shown", () => {
    edit(() => inspirations.setHidden(3, true, NOW));
    expect(ids()).toEqual([4, 2, 1]);
    expect(ids({ hidden: true })).toEqual([3]);
    expect(inspirations.tags()).toEqual({
      tags: [{ name: "craft", description: "", count: 1 }, { name: "art", description: "", count: 1 }, { name: "parenting", description: "", count: 1 }, { name: "music", description: "", count: 1 }],
      aiTags: [{ name: "art", count: 1 }, { name: "ceramics", count: 1 }, { name: "comfort-food", count: 1 }, { name: "cooking", count: 1 }],
      platforms: [{ platform: "web", count: 3 }],
      untagged: 1, total: 3, hidden: 1,
    });
    expect(inspirations.list(filter(), { limit: 2 })).toMatchObject({ total: 3, items: [{ id: 4 }, { id: 2 }] });
    expect(() => inspirations.list(filter(), { limit: 0 })).toThrow("limit is a whole number");
  });

  it("count each platform's items over what is shown, the most first, and narrow a list to one platform", () => {
    capture("https://www.youtube.com/watch?v=AbCdEfGhIjK", { now: NOW + 1000 });
    capture("https://youtu.be/ZyXwVuTsRqP", { now: NOW + 2000 });
    capture("https://x.com/i/status/1790000000000000001", { now: NOW + 3000 });
    inspirations.capture({ files: [{ path: "files/ab/ab12.png", mime: "image/png", bytes: 120, sha256: "ab12" }], origin: "cli", savedAt: NOW, now: NOW + 4000 });
    edit(() => inspirations.setHidden(6, true, NOW));
    expect(inspirations.tags().platforms).toEqual([{ platform: "web", count: 4 }, { platform: "file", count: 1 }, { platform: "x", count: 1 }, { platform: "youtube", count: 1 }]);
    expect(ids({ platform: "youtube" })).toEqual([5]);
    expect(ids({ platform: "youtube", hidden: true })).toEqual([6]);
    expect(ids({ platform: "web", q: "bedtime" })).toEqual([2]);
    expect(ids({ platform: "tiktok" })).toEqual([]);
  });
});

describe("the server's queue", () => {
  it("gives previews first, then the AI's tags once the preview has settled, filling only what is empty", () => {
    capture("https://x.com/somebody/status/1790000000000000001?s=20", { title: "Given title" });
    expect(inspirations.nextAiTags(NOW)).toBeNull();
    expect(inspirations.nextPreview()).toEqual({ id: 1, link: "https://x.com/i/status/1790000000000000001", platform: "x", given: ["https://x.com/somebody/status/1790000000000000001?s=20"] });
    inspirations.setPreview(1, "done", { title: "Preview title", author: "Somebody", description: "  a post\n\n\n\nabout tiles ", imageUrl: "javascript:alert(1)" });
    expect(inspirations.get(1)).toMatchObject({ title: "Given title", author: "Somebody", description: "a post\n\nabout tiles", image: null, previewState: "done" });
    expect(inspirations.nextPreview()).toBeNull();
    expect(inspirations.nextAiTags(NOW)).toMatchObject({ id: 1, title: "Given title", author: "Somebody", tags: [], tries: 0 });
  });

  it("tries the AI again after a growing wait, gives up after six tries, and asks again when told to", () => {
    capture("https://example.com/a");
    inspirations.setPreview(1, "none");
    let now = NOW;
    for (let i = 0; i < AI_TRIES; i++) {
      expect(inspirations.nextAiTags(now)).toMatchObject({ id: 1, tries: i });
      inspirations.aiFailed(1, "Codex is not signed in: run codex login", now);
      expect(inspirations.nextAiTags(now)).toBeNull();
      now += 31 * 60_000;
    }
    expect(inspirations.get(1)!.ai).toMatchObject({ state: "failed", error: "Codex is not signed in: run codex login" });
    expect(inspirations.nextAiTags(now)).toBeNull();
    expect(inspirations.queueFailedAi()).toBe(1);
    expect(inspirations.nextAiTags(now)).toMatchObject({ id: 1, tries: 0 });
    expect(inspirations.setAiTags(1, ["Interior Design"], "a-model", now)).toEqual(["interior-design"]);
    expect(inspirations.get(1)!.ai).toEqual({ state: "done", model: "a-model", at: now, error: null });
  });

  it("asks for the AI's tags again when a preview lands after them with more of what is known, and not otherwise", () => {
    capture("https://www.instagram.com/p/MadeUpB001/", { caption: "slow hands" });
    inspirations.setAiTags(1, ["craft"], "a-model", NOW);
    // A picture alone says nothing new of it; a preview that found nothing, or failed, neither.
    inspirations.setPreview(1, "done", { imageUrl: "https://example.com/pic.jpg" });
    inspirations.setPreview(1, "none", { author: "nobody" });
    expect(inspirations.get(1)).toMatchObject({ aiState: "done", aiTags: ["craft"], author: "nobody" });
    inspirations.setPreview(1, "done", { description: "A tall vase in one pull" });
    expect(inspirations.get(1)).toMatchObject({ aiState: "pending", aiTags: ["craft"], description: "A tall vase in one pull" });
    expect(inspirations.nextAiTags(NOW)).toMatchObject({ id: 1, description: "A tall vase in one pull" });
    inspirations.setAiTags(1, ["craft", "pottery"], "a-model", NOW);
    // What is known fills only once, so the same preview again says nothing new, and nothing is asked.
    inspirations.setPreview(1, "done", { description: "Other words" });
    expect(inspirations.get(1)).toMatchObject({ aiState: "done", aiTags: ["craft", "pottery"], description: "A tall vase in one pull" });
  });
});

describe("the probe fields an old item carries", () => {
  it("stay readable in the item and the list, though nothing sets them and no AI work waits on them; check-data wants a web link", () => {
    capture("https://example.com/lamp", { caption: "build this", origin: "share-sheet" });
    inspirations.setPreview(1, "none");
    expect(inspirations.nextAiTags(NOW)).toMatchObject({ id: 1, caption: "build this" });
    expect(inspirations.get(1)!.probe).toBeNull();
    // An item kept before: asked of firstmate, with a result, and one with a result alone.
    db.prepare("UPDATE inspiration SET probe_requested_at = ?, probe_result = ?, probe_result_at = ? WHERE id = 1").run(NOW, "https://boards.example.com/session/abc", NOW + 2);
    expect(inspirations.get(1)!.probe).toEqual({ requestedAt: NOW, result: "https://boards.example.com/session/abc", resultAt: NOW + 2 });
    expect(inspirations.list(filter()).items[0].probe).toMatchObject({ result: "https://boards.example.com/session/abc" });
    expect(inspirations.nextAiTags(NOW)).toMatchObject({ id: 1 });
    capture("https://example.com/other");
    db.prepare("UPDATE inspiration SET probe_result = ?, probe_result_at = ? WHERE id = 2").run("https://example.com/report", NOW);
    expect(inspirations.get(2)!.probe).toEqual({ requestedAt: null, result: "https://example.com/report", resultAt: NOW });
    expect(inspirationProblems(db, dataDir, () => true)).toEqual([]);
    db.prepare("UPDATE inspiration SET probe_result = 'not a link' WHERE id = 2").run();
    expect(inspirationProblems(db, dataDir, () => true)).toEqual([
      `inspiration #2: its probe's result: "not a link" is not a probe's result: a web link (http or https, up to 2000 characters) to its report or preview`,
    ]);
  });
});

describe("his edits", () => {
  beforeEach(() => {
    capture("https://example.com/vase", { caption: "slow hands", tags: ["craft"] });
    capture("https://example.com/lullaby", { tags: ["music", "crafts"] });
    db.prepare("UPDATE inspiration SET ai_state = 'done', preview_state = 'done'").run();
  });

  it("are each a changeset that Undo puts back, his caption asking for the AI's tags again", () => {
    const captioned = edit(() => inspirations.setCaption(1, "  slow hands, and the wheel  ", NOW));
    expect(inspirations.get(1)).toMatchObject({ caption: "slow hands, and the wheel", aiState: "pending" });
    const tagged = edit(() => inspirations.setTags(1, ["craft", "Art", "art"], NOW));
    expect(changes.show(tagged.changeset!).other).toEqual([
      `inspiration #1 "https://example.com/vase": tags craft -> craft, art`,
      `added the inspiration tag "art"`,
    ]);
    expect(changes.show(captioned.changeset!).other).toEqual([`inspiration #1 "https://example.com/vase": caption "slow hands" -> "slow hands, and the wheel"`]);
    changes.undo(tagged.changeset!, { surface: "cli" });
    expect(inspirations.get(1)!.tags).toEqual(["craft"]);
    expect(inspirations.tags().tags.map((t) => t.name)).toEqual(["craft", "music", "crafts"]);
    changes.undo(captioned.changeset!, { surface: "cli" });
    expect(inspirations.get(1)!.caption).toBe("slow hands");
    expect(edit(() => inspirations.setCaption(1, "slow hands", NOW)).changeset).toBeNull();
    expect(changes.list({ tables: INSPIRATION_TABLES }).map((c) => c.action)).toEqual(["undo #1", "undo #2", "test", "test"]);
    expect(changes.tablesOf(captioned.changeset!)).toEqual(["inspiration"]);
  });

  it("hide and show an item, as one changeset each", () => {
    const hidden = edit(() => inspirations.setHidden(2, true, NOW));
    expect(changes.show(hidden.changeset!).other).toEqual([`inspiration #2 "https://example.com/lullaby": hidden`]);
    expect(inspirations.get(2)!.hidden).toBe(true);
    changes.undo(hidden.changeset!, { surface: "app" });
    expect(inspirations.get(2)!.hidden).toBe(false);
  });

  it("rename a tag onto another, merging the two, and Undo splits them again", () => {
    const merged = edit(() => inspirations.renameTag("crafts", "craft"));
    expect(merged.value).toEqual({ name: "craft", merged: true });
    expect(inspirations.get(2)!.tags).toEqual(["craft", "music"]);
    expect(inspirations.tags().tags.map((t) => t.name)).toEqual(["craft", "music"]);
    expect(changes.show(merged.changeset!).other).toContain(`deleted the inspiration tag "crafts"`);
    changes.undo(merged.changeset!, { surface: "cli" });
    expect(inspirations.get(2)!.tags).toEqual(["music", "crafts"]);
    expect(inspirations.tags().tags.map((t) => t.name)).toEqual(["craft", "music", "crafts"]);
  });

  it("add, describe, move and delete tags, a tag nobody has kept until he deletes it", () => {
    const made = edit(() => inspirations.createTag("Interior design", "rooms, tiles and furniture; not buildings", NOW));
    expect(made.value).toBe("interior-design");
    edit(() => inspirations.moveTag("interior-design", 0));
    edit(() => inspirations.describeTag("craft", "made by hand"));
    edit(() => inspirations.untag(1, ["craft"], NOW));
    expect(inspirations.tags().tags).toEqual([
      { name: "interior-design", description: "rooms, tiles and furniture; not buildings", count: 0 },
      { name: "craft", description: "made by hand", count: 0 },
      { name: "music", description: "", count: 1 },
      { name: "crafts", description: "", count: 1 },
    ]);
    const deleted = edit(() => inspirations.deleteTag("crafts"));
    expect(deleted.value).toBe(1);
    expect(inspirations.get(2)!.tags).toEqual(["music"]);
    changes.undo(deleted.changeset!, { surface: "cli" });
    expect(inspirations.get(2)!.tags).toEqual(["music", "crafts"]);
    expect(() => inspirations.createTag("music", "", NOW)).toThrow(`there is already an inspiration tag "music"`);
    expect(() => inspirations.renameTag("nothing", "x")).toThrow(`there is no inspiration tag "nothing"`);
    expect(() => inspirations.setCaption(9, "x", NOW)).toThrow("there is no inspiration #9");
  });

  it("refuse an undo whose tag has been given again since, naming it", () => {
    const tagged = edit(() => inspirations.tag(1, ["art"], NOW));
    edit(() => inspirations.untag(1, ["art"], NOW));
    expect(() => changes.undo(tagged.changeset!, { surface: "cli" })).toThrow(`can't undo #${tagged.changeset}: changed again since: inspiration #1 "https://example.com/vase" (tags)`);
  });
});
