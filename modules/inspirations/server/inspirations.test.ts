// The server's side of inspirations: previews (previews.ts) from made-up oEmbed answers and pages, never fetched from
// a local address; the worker (worker.ts) filling previews and then the AI's tags with a stand-in model, and telling
// no one anything of a caption that asks for something to be built; the Inspirations page's routes
// (http.ts): reads, writes as changesets with Undo, and who may write (the page's own, and from the tailnet only the
// login it names); and the share sheet's capture route. Every item and answer is made up.

import { writeFile, mkdir } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Context, Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChangesetInfo } from "../../../sdk/contract.ts";
import { decodeEntities, type Ai, type Question, UnavailableError } from "../../../sdk/server.ts";
import { serve } from "../../../sdk/testing.ts";
import { newTestInspirations, type TestInspirations } from "../testing/open.ts";
import type { InspirationDetail, InspirationList, InspirationSaved, InspirationTagsAnswer, InspirationTagsSaved } from "../wire.ts";
import { inspirationCommand } from "./cli.ts";
import { AI_TAG_INSTRUCTIONS } from "./aiTags.ts";
import type { CaptureAnswer } from "./http.ts";
import { inspirationsRoute, linkIn } from "./http.ts";
import { fetchPreview, mayFetch, metaOf } from "./previews.ts";
import { workOnce } from "./worker.ts";

const NOW = Date.parse("2026-10-18T09:00:00+11:00");

/** A fetch answering made-up pages by link, as the sites would; anything else is a 404. */
function fakeFetch(pages: Record<string, { status?: number; type?: string; body?: string; location?: string }>, asked: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const page = pages[url];
    if (!page) return new Response("no", { status: 404 });
    return new Response(page.body ?? "", { status: page.status ?? 200, headers: { "content-type": page.type ?? "text/html; charset=utf-8", ...(page.location ? { location: page.location } : {}) } });
  }) as typeof fetch;
}

const PAGE = `<!doctype html><html><head><title>Tiles &amp; grout | A made-up blog</title>
<meta property="og:title" content="Terrazzo tiles, poured by hand">
<meta name="description" content='How a small studio pours &quot;terrazzo&quot; by hand'>
<meta property="og:image" content="/images/terrazzo.jpg">
<meta name="author" content="Esme Example">
</head><body><h1>ignored</h1></body></html>`;

describe("previews", () => {
  it("read a page's meta tags, its picture made a whole link", async () => {
    const preview = await Effect.runPromise(fetchPreview({ id: 1, link: "https://blog.example.com/terrazzo", platform: "web", given: [] }, { fetch: fakeFetch({ "https://blog.example.com/terrazzo": { body: PAGE } }) }));
    expect(preview).toEqual({
      state: "done",
      preview: { title: "Terrazzo tiles, poured by hand", author: "Esme Example", description: 'How a small studio pours "terrazzo" by hand', imageUrl: "https://blog.example.com/images/terrazzo.jpg" },
    });
  });

  it("ask YouTube's and X's public oEmbed, X's with the link that names the author", async () => {
    const asked: string[] = [];
    const fetch = fakeFetch({
      "https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DAbCdEfGhIjK": {
        type: "application/json", body: JSON.stringify({ title: "Lullabies on a made-up piano", author_name: "A made-up channel", thumbnail_url: "https://i.ytimg.com/vi/AbCdEfGhIjK/hqdefault.jpg" }),
      },
      "https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=https%3A%2F%2Fx.com%2Fsomebody%2Fstatus%2F1790000000000000001%3Fs%3D20": {
        type: "application/json", body: JSON.stringify({ author_name: "Somebody", html: `<blockquote><p lang="en">Bread at 3am &amp; jam<br>by hand</p>&mdash; Somebody</blockquote>` }),
      },
    }, asked);
    expect(await Effect.runPromise(fetchPreview({ id: 1, link: "https://www.youtube.com/watch?v=AbCdEfGhIjK", platform: "youtube", given: [] }, { fetch }))).toEqual({
      state: "done", preview: { title: "Lullabies on a made-up piano", author: "A made-up channel", imageUrl: "https://i.ytimg.com/vi/AbCdEfGhIjK/hqdefault.jpg" },
    });
    expect(await Effect.runPromise(fetchPreview({ id: 2, link: "https://x.com/i/status/1790000000000000001", platform: "x", given: ["https://x.com/somebody/status/1790000000000000001?s=20"] }, { fetch }))).toEqual({
      state: "done", preview: { author: "Somebody", description: "Bread at 3am & jam\nby hand" },
    });
  });

  it("never fetch Instagram (its own slow lane does), this Mac, the local network or an address, even by a redirect", async () => {
    const asked: string[] = [];
    expect(await Effect.runPromise(fetchPreview({ id: 1, link: "https://www.instagram.com/p/AbC123xyz/", platform: "instagram", given: [] }, { fetch: fakeFetch({}, asked) }))).toEqual({ state: "none", preview: {} });
    expect(asked).toEqual([]);
    for (const link of ["http://localhost:4650/api/archive/people", "http://127.0.0.1/", "http://[::1]/", "https://your-mac.example.ts.net/life-archive", "http://your-mac.local/", "file:///etc/hosts"]) expect(mayFetch(link), link).toBe(false);
    const redirected = fakeFetch({ "https://short.example.com/x": { status: 302, location: "http://192.168.1.1/admin" } }, asked);
    const failed = await Effect.runPromise(Effect.flip(fetchPreview({ id: 1, link: "https://short.example.com/x", platform: "web", given: [] }, { fetch: redirected })));
    expect(failed.message).toBe("http://192.168.1.1/admin is not a link the archive fetches");
    expect(asked).toEqual(["https://short.example.com/x"]);
  });

  it("decode what pages write, and take each meta tag's first", () => {
    expect(decodeEntities("a &amp; b &#39;c&#39; &#x2014; &bogus;")).toBe("a & b 'c' — &bogus;");
    expect(metaOf(`<meta name="Description" content="one"><meta name="description" content="two"><meta content=x>`)).toEqual({ description: "one" });
  });
});

/** A stand-in model: answers each question with the next of `answers` (a tags list, as the model answers, a fuller answer, or an error), noting what it was asked. */
function standIn(answers: Array<string[] | { tags: string[]; ask?: boolean } | Error>, asked: Question[] = []): Ai {
  return {
    model: "made-up-model",
    ask: async (question) => {
      asked.push(question);
      const next = answers.shift();
      if (!next || next instanceof Error) throw next ?? new UnavailableError("no answer left");
      return JSON.stringify(Array.isArray(next) ? { tags: next } : next);
    },
  };
}

/** The worker's pass on `on`. It needs no notifier: nothing it does tells anyone anything. */
const pass = (on: TestInspirations["kept"], ai: Ai, options: Parameters<typeof workOnce>[2] = {}) =>
  Effect.runPromise(workOnce(on, ai, { fetch: fakeFetch({}), ...options }));

let opened: TestInspirations & { remove(): Promise<void> };
let server: Server;
let port: number;

beforeAll(async () => {
  opened = await newTestInspirations("inspirations-server");
  const handler = serve(Context.empty(), inspirationsRoute(opened.part, opened.folder));
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await opened.remove();
});

describe("the worker", () => {
  it("fills previews, then asks for the AI's tags with what is known, and keeps them with the model", async () => {
    const store = opened.part.store;
    store.capture({ link: "https://blog.example.com/terrazzo?utm_source=x", caption: "for the bathroom floor", tags: ["interior-design"], origin: "grok-bot", savedAt: NOW, now: NOW });
    store.capture({ link: "https://www.instagram.com/reel/AbC123xyz/", caption: "slow hands", title: "Throwing a tall vase", origin: "grok-bot", savedAt: NOW, now: NOW });
    const asked: Question[] = [];
    const done = await pass(opened.kept, standIn([["Interior Design", "terrazzo", "craft"], new UnavailableError("Codex is not signed in: run codex login")], asked), {
      fetch: fakeFetch({ "https://blog.example.com/terrazzo": { body: PAGE } }),
    });
    expect(done).toBe(4);
    expect(store.get(1)).toMatchObject({ title: "Terrazzo tiles, poured by hand", previewState: "done", aiTags: ["interior-design", "terrazzo", "craft"], ai: { state: "done", model: "made-up-model" } });
    expect(store.get(1)!.tags).toEqual(["interior-design"]);
    // Instagram's own slow lane asked for the reel (instagram.ts), and the made-up site has no such post; its AI tags did not wait.
    expect(store.get(2)).toMatchObject({
      previewState: "pending", previewNote: "its embed page answered 404: no such post (try 1 of 3); tried again in a day",
      aiTags: [], ai: { state: "pending", error: "Codex is not signed in: run codex login" },
    });
    expect(asked[0].instructions).toBe(AI_TAG_INSTRUCTIONS);
    expect(asked[0].prompt).toContain("His words about it: for the bathroom floor");
    expect(asked[0].prompt).toContain("Title: Terrazzo tiles, poured by hand");
    expect(asked[0].prompt).toContain("- interior-design (1)");
    expect(asked[1].prompt).toContain("AI tags in use, the most used first: craft (1), interior-design (1), terrazzo (1)");
    expect(asked[0].instructions).not.toMatch(/ask for something to be done|\bask\b/);
    // Tried again only after its wait.
    expect(await pass(opened.kept, standIn([]))).toBe(0);
  });
});

/** A shared file in a form: its name, type and bytes. */
interface FormFile {
  name: string;
  type: string;
  bytes: string;
}

/**
 * A request to the routes as a browser on `host` sends it: with the page's Origin unless `origin` is null; `body` as
 * JSON, `form` as multipart/form-data (the shortcut's), or `raw` as given.
 */
function call(method: string, path: string, { body, form, raw, host = `127.0.0.1:${port}`, origin, headers = {} }: {
  body?: unknown;
  form?: Record<string, string | FormFile>;
  raw?: string;
  host?: string;
  origin?: string | null;
  headers?: Record<string, string>;
} = {}) {
  let payload: Buffer | undefined;
  const typed: Record<string, string> = {};
  if (form) {
    const boundary = "made-up-boundary";
    const parts = Object.entries(form).map(([name, value]) =>
      typeof value === "string"
        ? `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        : `--${boundary}\r\ncontent-disposition: form-data; name="${name}"; filename="${value.name}"\r\ncontent-type: ${value.type}\r\n\r\n${value.bytes}\r\n`);
    payload = Buffer.from(`${parts.join("")}--${boundary}--\r\n`);
    typed["content-type"] = `multipart/form-data; boundary=${boundary}`;
  } else if (raw !== undefined) payload = Buffer.from(raw);
  else if (body !== undefined) {
    payload = Buffer.from(JSON.stringify(body));
    typed["content-type"] = "application/json";
  }
  return new Promise<{ status: number; body: any; type: string }>((resolve, reject) => {
    const req = request({
      port, method, path: `/life-archive/api/inspirations${path}`,
      headers: {
        host,
        ...(origin === null ? {} : { origin: origin ?? `http://${host}` }),
        ...typed,
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const type = String(res.headers["content-type"] ?? "");
        resolve({ status: res.statusCode!, type, body: type.includes("json") ? JSON.parse(text) : text });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

describe("the routes", () => {
  it("list, find and show items, his tags and the AI's apart", async () => {
    const list = (await call("GET", "?tags=interior-design", { origin: null })).body as InspirationList;
    expect(list).toMatchObject({ total: 1, items: [{ id: 1, tags: ["interior-design"], aiTags: ["interior-design", "terrazzo", "craft"] }] });
    expect(((await call("GET", "?kind=ai&tags=terrazzo")).body as InspirationList).items.map((i) => i.id)).toEqual([1]);
    expect(((await call("GET", "?q=vase")).body as InspirationList).items.map((i) => i.id)).toEqual([2]);
    expect(((await call("GET", "?untagged=1")).body as InspirationList).items.map((i) => i.id)).toEqual([2]);
    expect(((await call("GET", "?platform=instagram")).body as InspirationList).items.map((i) => i.id)).toEqual([2]);
    expect(((await call("GET", "/items/2")).body as InspirationDetail).saves).toMatchObject([{ origin: "grok-bot", link: "https://www.instagram.com/reel/AbC123xyz/" }]);
    expect((await call("GET", "/tags")).body as InspirationTagsAnswer).toMatchObject({ tags: [{ name: "interior-design", count: 1 }], platforms: [{ platform: "instagram", count: 1 }, { platform: "web", count: 1 }], untagged: 1, total: 2 });
    // The module's own address answers as its mount, the address the routes had as the core's, does.
    expect(await (await fetch(`http://127.0.0.1:${port}/life-archive/api/m/inspirations/tags`)).json()).toEqual((await call("GET", "/tags")).body);
    expect(await call("GET", "/items/99")).toMatchObject({ status: 404, body: { error: "there is no inspiration #99" } });
    expect(await call("GET", "?tags=not%20a%20tag%20because%20it%20is%20far%20too%20long%20for%20one")).toMatchObject({ status: 400 });
  });

  it("serve a kept file, an image inline", async () => {
    await mkdir(join(opened.folder, "files/ab"), { recursive: true });
    await writeFile(join(opened.folder, "files/ab/ab12.png"), "made-up bytes");
    const made = opened.part.store.capture({ files: [{ path: "files/ab/ab12.png", mime: "image/png", bytes: 13, sha256: "ab12" }], origin: "cli", savedAt: NOW, now: NOW });
    const fileId = (opened.part.store.get(made.id)!.image as { fileId: number }).fileId;
    expect(await call("GET", `/files/${fileId}`)).toMatchObject({ status: 200, type: "image/png", body: "made-up bytes" });
    expect(await call("GET", "/files/99")).toMatchObject({ status: 404 });
  });

  it("make each edit one changeset the page can undo", async () => {
    const tagged = await call("PUT", "/items/2/tags", { body: { tags: ["Craft", "art"] } });
    expect(tagged.status).toBe(200);
    const saved = tagged.body as InspirationSaved;
    expect(saved.item.tags).toEqual(["craft", "art"]);
    expect((await call("PUT", "/items/2/caption", { body: { caption: "slow hands, the wheel" } })).body).toMatchObject({ item: { caption: "slow hands, the wheel", aiState: "pending" } });
    expect((await call("PUT", "/items/2/hidden", { body: { hidden: true } })).body).toMatchObject({ item: { hidden: true } });
    const changes = (await call("GET", "/changes")).body as ChangesetInfo[];
    expect(changes.map((c) => [c.surface, c.action])).toEqual([["app", "inspiration hide #2"], ["app", "inspiration caption #2"], ["app", "inspiration tags #2"]]);
    expect((await call("POST", `/changes/${changes[0].id}/undo`, { body: {} })).body).toMatchObject({ action: `undo #${changes[0].id}` });
    expect(opened.part.store.get(2)!.hidden).toBe(false);
    expect((await call("POST", `/changes/${saved.changeset}/undo`, { body: {} })).status).toBe(200);
    expect(opened.part.store.get(2)!.tags).toEqual([]);
    expect((await call("POST", "/items/2/ai-tags", { body: {} })).body).toMatchObject({ aiState: "pending" });
  });

  it("edit the vocabulary: add, describe, move, rename onto another to merge, delete", async () => {
    // Undoing the tags above took away the tags it had made.
    expect(((await call("POST", "/tags", { body: { name: "Parenting", description: "raising kids" } })).body as InspirationTagsSaved).tags.tags.map((t) => t.name))
      .toEqual(["interior-design", "parenting"]);
    await call("PUT", "/items/1/tags", { body: { tags: ["interior-design", "craft"] } });
    await call("PUT", "/items/2/tags", { body: { tags: ["art"] } });
    expect(((await call("PUT", "/tags/parenting", { body: { position: 0, description: "raising kids, and play" } })).body as InspirationTagsSaved).tags.tags[0])
      .toEqual({ name: "parenting", description: "raising kids, and play", count: 0 });
    const merged = (await call("PUT", "/tags/craft", { body: { name: "art" } })).body as InspirationTagsSaved;
    expect(merged.tags.tags.map((t) => [t.name, t.count])).toEqual([["parenting", 0], ["interior-design", 1], ["art", 2]]);
    expect(opened.part.store.get(1)!.tags).toEqual(["interior-design", "art"]);
    expect(((await call("DELETE", "/tags/art")).body as InspirationTagsSaved).tags.tags.map((t) => t.name)).toEqual(["parenting", "interior-design"]);
    expect(opened.part.store.get(2)!.tags).toEqual([]);
    expect(await call("PUT", "/tags/nothing", { body: { description: "x" } })).toMatchObject({ status: 404 });
  });

  it("refuse a write that is not the page's own, and take one from the tailnet's own page with no login", async () => {
    expect(await call("PUT", "/items/1/hidden", { body: { hidden: true }, origin: null })).toMatchObject({ status: 403 });
    expect(await call("PUT", "/items/1/hidden", { body: { hidden: true }, origin: "https://elsewhere.example" })).toMatchObject({ status: 403 });
    expect(await call("PUT", "/items/1/hidden", { body: { hidden: true }, headers: { "sec-fetch-site": "cross-site" } })).toMatchObject({ status: 403 });
    const tailnet = "mac.example.ts.net";
    // No per-person login: the tailnet's ACL decides who reaches the viewer, and the page's own Origin is enough.
    expect(await call("PUT", "/items/1/hidden", { body: { hidden: true }, host: tailnet })).toMatchObject({ status: 200, body: { item: { hidden: true } } });
    expect(await call("PUT", "/items/1/hidden", { body: { hidden: true }, host: tailnet, origin: "https://elsewhere.example" })).toMatchObject({ status: 403 });
    // Reading needs no login either: the tailnet's ACL and the door's Host guard decide who reaches the viewer.
    expect(await call("GET", "/items/1", { host: tailnet, origin: null })).toMatchObject({ status: 200 });
  });
});

describe("the share sheet's door", () => {
  const tailnet = "mac.example.ts.net";

  it("captures a link with his words from the phone, at once, with no Origin and from the tailnet's name, his words verbatim", async () => {
    const words = "it'd be cool if we did this with the kids ✨";
    const answer = await call("POST", "/capture", { host: tailnet, origin: null, form: { link: "https://youtu.be/MadeUpId01?si=x", caption: words, origin: "share-sheet" } });
    expect(answer).toMatchObject({ status: 200, body: { created: true, saved: true, link: "https://www.youtube.com/watch?v=MadeUpId01" } });
    const { id, message } = answer.body as CaptureAnswer;
    expect(message).toBe(`Saved #${id} (new): https://www.youtube.com/watch?v=MadeUpId01`);
    expect(opened.part.store.get(id)).toMatchObject({
      caption: words, previewState: "pending", aiState: "pending", probe: null,
      saves: [{ origin: "share-sheet", link: "https://youtu.be/MadeUpId01?si=x", caption: words }],
    });
    // Shared again with other words, as text with the link in it: another save; his first words stay first, the new ones after a blank line.
    const again = await call("POST", "/capture", { host: tailnet, origin: null, body: { text: "A made-up video\nhttps://www.youtube.com/watch?v=MadeUpId01&t=4s", caption: "reproduce this" } });
    expect(again.body).toMatchObject({ id, created: false, saved: true, message: `Saved #${id} again (kept before): https://www.youtube.com/watch?v=MadeUpId01` });
    expect(opened.part.store.get(id)).toMatchObject({ caption: `${words}\n\nreproduce this`, saveCount: 2, saves: [{ caption: "reproduce this" }, { caption: words }] });
    expect(linkIn("see https://x.com/somebody/status/1790000000000000002?s=20) and more")).toBe("https://x.com/somebody/status/1790000000000000002?s=20");
  });

  it("keeps a shared photo by its hash, and shared text with no link as a text file named by its first line", async () => {
    const photo = await call("POST", "/capture", { origin: null, form: { caption: "tiles like these", file: { name: "IMG_0001.png", type: "image/png", bytes: "made-up png bytes" } } });
    expect(photo.body).toMatchObject({ created: true, link: null });
    const kept = opened.part.store.get(photo.body.id)!;
    expect(photo.body.message).toBe(`Saved #${kept.id} (new): a photo`);
    expect(kept).toMatchObject({ platform: "file", form: "image", caption: "tiles like these", files: [{ role: "item", mime: "image/png", bytes: 17 }] });
    expect(await call("GET", `/files/${kept.files[0].id}`)).toMatchObject({ status: 200, type: "image/png", body: "made-up png bytes" });
    const text = await call("POST", "/capture", { origin: null, form: { text: "Make the bread at 3am\nwith a slow fold", caption: "", file: { name: "", type: "application/octet-stream", bytes: "" } } });
    expect(opened.part.store.get(text.body.id)).toMatchObject({
      platform: "file", form: "other", title: "Make the bread at 3am", description: "Make the bread at 3am\nwith a slow fold", caption: "", files: [{ mime: "text/plain", bytes: 38 }],
    });
    expect(text.body.message).toBe(`Saved #${text.body.id} (new): Make the bread at 3am`);
  });

  it("refuses a capture with nothing in it, one that is no link, and one another site's page sent, each said for the phone", async () => {
    expect(await call("POST", "/capture", { origin: null, body: { caption: "just words" } })).toMatchObject({ status: 400, body: { error: "an inspiration needs a link, a file or some text, and words are welcome" } });
    expect(await call("POST", "/capture", { origin: null, body: { link: "not a link" } })).toMatchObject({ status: 400, body: { error: '"not a link" is not a link' } });
    expect(await call("POST", "/capture", { origin: null, body: { link: "https://example.com/x", origin: "share sheet!" } })).toMatchObject({ status: 400, body: { error: expect.stringContaining("is not an origin") } });
    expect(await call("POST", "/capture", { origin: null, raw: "x", headers: { "content-type": "text/plain" } })).toMatchObject({ status: 400, body: { error: "a capture is sent as multipart/form-data or JSON" } });
    expect(await call("POST", "/capture", { origin: "https://elsewhere.example", body: { link: "https://example.com/x" } })).toMatchObject({ status: 403 });
    expect(await call("POST", "/capture", { origin: null, headers: { "sec-fetch-site": "cross-site" }, body: { link: "https://example.com/x" } })).toMatchObject({ status: 403 });
    expect(await call("GET", "/capture", { origin: null })).toMatchObject({ status: 404 });
  });
});

describe("a caption that asks for something to be built", () => {
  // An archive of its own, so the worker's passes here meet only these items.
  let own: TestInspirations & { remove(): Promise<void> };
  beforeAll(async () => {
    own = await newTestInspirations("inspirations-no-probes");
  });
  afterAll(async () => {
    await own.remove();
  });

  it("is captioned and tagged like any other, and sends no note: nothing is asked of anyone, and no probe is marked", async () => {
    const store = own.part.store;
    const words = "it'd be cool if we reproduced this for the hallway";
    const { id } = store.capture({ link: "https://blog.example.com/hallway-lamp", caption: words, title: "A hallway lamp", origin: "share-sheet", savedAt: NOW, now: NOW });
    // Even a model that still answers the old question (ask: true) changes nothing: the extra field is not read.
    const asked: Question[] = [];
    expect(await pass(own.kept, standIn([{ tags: ["lighting", "hallway"], ask: true }], asked))).toBe(2);
    expect(asked).toHaveLength(1);
    expect(asked[0].prompt).toContain(`His words about it: ${words}`);
    expect(store.get(id)).toMatchObject({ caption: words, aiTags: ["lighting", "hallway"], ai: { state: "done", error: null }, probe: null });
    // A later save's words, tagged again: still nothing.
    store.capture({ link: "https://blog.example.com/hallway-lamp", caption: "and build this too", origin: "grok-bot", savedAt: NOW, now: NOW });
    store.queueAi(id);
    expect(await pass(own.kept, standIn([["lighting"]]))).toBe(1);
    expect(store.get(id)).toMatchObject({ caption: `${words}\n\nand build this too`, aiTags: ["lighting"], ai: { state: "done" }, probe: null });
  });

  it("comes the same way through his Grok Bot agent's door, inspiration add", async () => {
    const store = own.part.store;
    const cli = { part: own.part, folder: own.folder, values: { caption: "can you make one of these for the studio", origin: "grok-bot", title: "A made-up kiln" }, change: () => Promise.reject(new Error("no changeset here")) };
    await inspirationCommand(cli, "add", ["https://blog.example.com/kiln"]);
    const id = store.list({ tags: [], tagKind: "manual", q: "kiln", untagged: false, platform: "", hidden: false }).items[0].id;
    expect(store.get(id)!.saves).toMatchObject([{ origin: "grok-bot", caption: "can you make one of these for the studio" }]);
    expect(await pass(own.kept, standIn([["ceramics"]]))).toBe(2);
    expect(store.get(id)).toMatchObject({ aiTags: ["ceramics"], probe: null });
  });
});
