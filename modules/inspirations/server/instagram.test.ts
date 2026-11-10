// Instagram's previews (instagram.ts), against a made-up Instagram (fixtures/instagramEmbeds.ts), never the real one:
// what an embed page says in each shape it comes in, the picture chosen, the pace (spacing, the day's cap, the pause
// after a refusal), what each outcome does to an item, and the worker taking one post at a time, its picture kept by
// content hash, its import's placeholder title gone, and nothing asked while Instagram's refusal pauses it.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Ai, UnavailableError } from "../../../sdk/server.ts";
import { newTestInspirations, type TestInspirations } from "../testing/open.ts";
import type { FetchRecord, InstagramWork } from "./store.ts";
import { embedPage, fakeInstagram, LOGIN_PAGE, pictureLink, SHELL_PAGE, type MadeUpPost } from "../fixtures/instagramEmbeds.ts";
import { choosePicture, INSTAGRAM_PACE, imageType, instagramCode, paceAt, readEmbed, settle, type InstagramPace, type InstagramTry } from "./instagram.ts";
import { workOnce } from "./worker.ts";

const NOW = Date.parse("2026-10-19T09:00:00+11:00");
const HOUR = 3_600_000;

const POTTER: MadeUpPost = { username: "made.up.potter", caption: "A tall vase in one pull\n#pottery", colours: [[124, 82, 58], [214, 186, 150]] };

describe("an embed page", () => {
  it("says the post's author, words and its smallest picture of 320 or more, from its contextJSON", () => {
    expect(readEmbed(embedPage("MadeUpA001", POTTER))).toEqual({
      kind: "post", author: "@made.up.potter", description: "A tall vase in one pull\n#pottery", picture: pictureLink("MadeUpA001", 320),
    });
  });

  it("says the author and picture from its HTML when it has no contextJSON", () => {
    expect(readEmbed(embedPage("MadeUpA002", { ...POTTER, htmlOnly: true }))).toEqual({
      kind: "post", author: "@made.up.potter", description: null, picture: pictureLink("MadeUpA002", 320),
    });
  });

  it("is no post when it is Instagram's empty shell, and a refusal when it is its login wall", () => {
    expect(readEmbed(SHELL_PAGE)).toEqual({ kind: "empty" });
    expect(readEmbed(LOGIN_PAGE)).toEqual({ kind: "blocked", why: "its embed page asks for a login" });
  });

  it("gives a picture only from Instagram's own picture server, the widest when none is 320 across", () => {
    const at = (host: string, width: number) => ({ src: `https://${host}/v/a_${width}.jpg`, width });
    expect(choosePicture([at("scontent.cdninstagram.com", 640), at("scontent.cdninstagram.com", 320), at("scontent.cdninstagram.com", 150)])).toBe("https://scontent.cdninstagram.com/v/a_320.jpg");
    expect(choosePicture([at("scontent.cdninstagram.com", 150), at("scontent.cdninstagram.com", 240)])).toBe("https://scontent.cdninstagram.com/v/a_240.jpg");
    expect(choosePicture([at("pictures.example.com", 320), { src: "http://scontent.cdninstagram.com/v/a.jpg", width: 320 }])).toBeNull();
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageType(new TextEncoder().encode("<html>"))).toBeNull();
  });

  it("is read only for a post's link", () => {
    expect(instagramCode("https://www.instagram.com/p/MadeUpA001/")).toBe("MadeUpA001");
    expect(instagramCode("https://www.instagram.com/madeupaccount")).toBeNull();
    expect(instagramCode("https://www.youtube.com/watch?v=MadeUpVid01")).toBeNull();
  });
});

const fetchAt = (at: number, outcome: FetchRecord["outcome"], nextAt: number): FetchRecord => ({ platform: "instagram", inspirationId: 1, at, outcome, note: null, nextAt });

describe("the pace", () => {
  it("waits out the last fetch's spacing, a pause after a refusal, and the day's cap", () => {
    expect(paceAt([], null, NOW)).toEqual({ due: true });
    expect(paceAt([NOW - 10_000], fetchAt(NOW - 10_000, "found", NOW + 12_000), NOW)).toEqual({ due: false, at: NOW + 12_000, why: "spacing" });
    expect(paceAt([NOW - 10_000], fetchAt(NOW - 10_000, "blocked", NOW + 6 * HOUR), NOW)).toEqual({ due: false, at: NOW + 6 * HOUR, why: "paused" });
    const day = Array.from({ length: INSTAGRAM_PACE.dailyCap }, (_, i) => NOW - 20 * HOUR + i * 60_000);
    expect(paceAt(day, fetchAt(day.at(-1)!, "found", day.at(-1)! + 20_000), NOW)).toEqual({ due: false, at: day[0] + 24 * HOUR, why: "cap" });
    expect(paceAt(day.slice(1), fetchAt(day.at(-1)!, "found", day.at(-1)! + 20_000), NOW)).toEqual({ due: true });
  });
});

describe("a try's outcome", () => {
  const work: InstagramWork = { id: 7, link: "https://www.instagram.com/p/MadeUpA001/", title: "Instagram save MadeUpA001", tries: 0 };
  const found: InstagramTry = { outcome: "found", author: "@made.up.potter", description: "A tall vase", picture: null, note: null, refused: null };
  const settleNow = (tried: InstagramTry, recent: FetchRecord[] = [], tries = 0) => settle({ ...work, tries }, "MadeUpA001", tried, recent, NOW, 20_000);

  it("keeps a found post's author and words, its placeholder title to go, and spaces the next", () => {
    expect(settleNow(found)).toEqual({
      state: "done",
      preview: { author: "@made.up.potter", description: "A tall vase", placeholderTitle: "Instagram save MadeUpA001" },
      progress: { tries: 1, retryAt: 0, note: null },
      record: { platform: "instagram", inspirationId: 7, at: NOW, outcome: "found", note: null, nextAt: NOW + 20_000 },
    });
  });

  it("pauses for 6 hours on a refusal, twice as long each time in a row, up to two days, the post kept for after", () => {
    const blocked: InstagramTry = { outcome: "blocked", note: "Instagram refused: it answered 429" };
    expect(settleNow(blocked)).toMatchObject({ state: "pending", progress: { tries: 0, retryAt: 0 }, record: { outcome: "blocked", nextAt: NOW + 6 * HOUR } });
    expect(settleNow(blocked).progress.note).toBe(`blocked: Instagram refused: it answered 429; paused until ${new Date(NOW + 6 * HOUR).toISOString()}`);
    expect(settleNow(blocked, [fetchAt(NOW - HOUR, "blocked", 0), fetchAt(NOW - 7 * HOUR, "blocked", 0)]).record.nextAt).toBe(NOW + 24 * HOUR);
    expect(settleNow(blocked, Array.from({ length: 6 }, () => fetchAt(NOW - HOUR, "blocked", 0))).record.nextAt).toBe(NOW + 48 * HOUR);
    // A picture refused after its page: the post is found, and the lane still pauses.
    expect(settleNow({ ...found, note: "its picture was refused: it answered 403", refused: "it answered 403" })).toMatchObject({
      state: "done", record: { outcome: "blocked", nextAt: NOW + 6 * HOUR },
    });
  });

  it("tries a post that shows nothing twice more, a day apart, then skips it; five in a row is a refusal", () => {
    const empty: InstagramTry = { outcome: "empty", note: "its embed page shows no post" };
    expect(settleNow(empty)).toMatchObject({ state: "pending", progress: { tries: 1, retryAt: NOW + 24 * HOUR, note: "its embed page shows no post (try 1 of 3); tried again in a day" } });
    expect(settleNow(empty, [], 2)).toMatchObject({ state: "none", progress: { tries: 3, note: "skipped: its embed page shows no post after 3 tries (removed, private, or not to be embedded)" } });
    const fourEmpty = Array.from({ length: 4 }, () => fetchAt(NOW - 60_000, "empty", 0));
    expect(settleNow(empty, fourEmpty)).toMatchObject({ state: "pending", progress: { tries: 0 }, record: { outcome: "blocked", nextAt: NOW + 6 * HOUR } });
    // Newest first: a post found before the run does not break it, one found within it does.
    expect(settleNow(empty, [...fourEmpty, fetchAt(NOW - HOUR, "found", 0)]).record.outcome).toBe("blocked");
    expect(settleNow(empty, [...fourEmpty.slice(1), fetchAt(NOW - HOUR, "found", 0), fourEmpty[0]]).record.outcome).toBe("empty");
  });

  it("tries a failed fetch again after a growing wait, then gives up", () => {
    const failed: InstagramTry = { outcome: "failed", note: "could not reach Instagram: offline" };
    expect(settleNow(failed)).toMatchObject({ state: "pending", progress: { tries: 1, retryAt: NOW + HOUR } });
    expect(settleNow(failed, [], 2)).toMatchObject({ state: "pending", progress: { tries: 3, retryAt: NOW + 4 * HOUR } });
    expect(settleNow(failed, [], 3)).toMatchObject({ state: "failed", progress: { tries: 4, note: "given up on: could not reach Instagram: offline" } });
  });
});

/** A model that is never asked: these tests are of previews. */
const NO_AI: Ai = { model: "made-up-model", ask: async () => { throw new UnavailableError("not in these tests"); } };

/** Quick for a test: no wait between a page and its picture, nor between posts. */
const QUICK: InstagramPace = { ...INSTAGRAM_PACE, gapMs: 0, jitterMs: 0, pictureGapMs: 0, pictureJitterMs: 0 };

let opened: TestInspirations & { remove(): Promise<void> };

beforeAll(async () => {
  opened = await newTestInspirations("instagram");
});

afterAll(async () => {
  await opened.remove();
});

describe("the worker", () => {
  it("asks only once started, one post at a time, keeps its small picture, and asks nothing while Instagram's refusal pauses it", async () => {
    const store = opened.part.store;
    // As the import left them: a placeholder title, no author, the preview given up on.
    for (const code of ["MadeUpA001", "MadeUpA002", "MadeUpA003"]) {
      const { id } = store.capture({ link: `https://www.instagram.com/p/${code}/`, title: `Instagram save ${code}`, origin: "instagram-saves-import", nativeId: code, savedAt: NOW, now: NOW });
      store.setPreview(id, "none");
    }
    const asked: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch = fakeInstagram({ MadeUpA001: POTTER, MadeUpA002: "refuse", MadeUpA003: { ...POTTER, username: "made.up.weaver" } }, asked);
    const work = () => Effect.runPromise(workOnce(opened.kept, NO_AI, { fetch, instagramPace: QUICK }));

    // Nothing is asked of Instagram before the back-fill is started.
    await work();
    expect(asked).toEqual([]);
    expect(store.instagramStatus(NOW)).toMatchObject({ notAsked: 3, waiting: 0 });

    expect(store.queueInstagram()).toBe(3);
    await work();
    expect(asked.map((a) => a.url)).toEqual(["https://www.instagram.com/p/MadeUpA001/embed/", pictureLink("MadeUpA001", 320)]);
    expect(asked[0].headers).toMatchObject({ "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" });
    for (const { headers } of asked) expect(Object.keys(headers).filter((name) => /cookie|authorization/.test(name))).toEqual([]);
    const first = store.get(1)!;
    expect(first).toMatchObject({ title: null, author: "@made.up.potter", description: "A tall vase in one pull\n#pottery", previewState: "done", previewNote: null });
    expect(first.files).toMatchObject([{ role: "preview", mime: "image/png" }]);
    expect(first.image).toEqual({ fileId: first.files[0].id });
    const kept = store.file(first.files[0].id)!;
    expect(kept.path).toMatch(/^files\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    expect(existsSync(join(opened.folder, kept.path))).toBe(true);
    expect(kept.bytes).toBeLessThan(400 * 1024);

    // Instagram refuses the next: it pauses, the post waits to be tried first after.
    await work();
    expect(asked.at(-1)!.url).toBe("https://www.instagram.com/p/MadeUpA002/embed/");
    expect(store.get(2)).toMatchObject({ previewState: "pending", title: "Instagram save MadeUpA002" });
    expect(store.get(2)!.previewNote).toMatch(/^blocked: Instagram refused: it answered 429; paused until /);
    const before = asked.length;
    await work();
    await work();
    expect(asked.length).toBe(before);
    expect(store.instagramStatus(NOW)).toMatchObject({ found: 1, waiting: 2, lastDay: 2, last: { outcome: "blocked" } });

    // Stopped, nothing waits; started again, only what has no picture is asked for.
    expect(store.stopInstagram()).toBe(2);
    expect(store.get(3)).toMatchObject({ previewState: "none", previewNote: "stopped: inspiration instagram start asks again" });
    expect(store.queueInstagram()).toBe(2);
  });

  it("never holds an Instagram item's AI tags back for its slow preview, and leaves Instagram to its own lane", async () => {
    const store = opened.part.store;
    const { id } = store.capture({ link: "https://www.instagram.com/p/MadeUpA004/", caption: "the loom", origin: "grok-bot", savedAt: NOW, now: NOW });
    expect(store.get(id)!.previewState).toBe("pending");
    expect(store.nextPreview()).toBeNull();
    // The others' AI tags failed above (this model never answers) and wait their turn; this one is due at once.
    expect(store.nextAiTags(NOW)?.id).toBe(id);
  });
});
