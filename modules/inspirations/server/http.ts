// The Inspirations page's routes, under the viewer's /life-archive/api/inspirations (wire.ts's INSPIRATIONS_API, which
// module.ts mounts them at), on this Mac and on the tailnet with the rest of the viewer, over the module's database.
// They are among the viewer's few that write, scoped to inspirations alone: each edit is one changeset in the
// inspirations' change log (part.ts), which the page's Changes undoes (only an inspiration's).
//
//   GET    /inspirations?tags=&kind=manual|ai&q=&untagged=1&platform=&hidden=1&offset=&limit=  -> InspirationList, newest first
//   GET    /inspirations/tags                     -> InspirationTagsAnswer: his vocabulary, the AI tags in use, counts (each platform's too)
//   GET    /inspirations/items/:id                -> InspirationDetail, every save and file
//   GET    /inspirations/files/:id                -> a kept file (an image, inline)
//   GET    /inspirations/changes?limit=           -> ChangesetInfo[]: the change log's changesets of inspirations
//   PUT    /inspirations/items/:id/caption        {caption} -> InspirationSaved
//   PUT    /inspirations/items/:id/tags           {tags: string[]} -> InspirationSaved (exactly these, his)
//   PUT    /inspirations/items/:id/hidden         {hidden: boolean} -> InspirationSaved
//   POST   /inspirations/items/:id/ai-tags        {} -> InspirationDetail: the AI's tags asked for again (no changeset)
//   POST   /inspirations/tags                     {name, description?} -> InspirationTagsSaved
//   PUT    /inspirations/tags/:name               {name?, description?, position?} -> InspirationTagsSaved (renamed onto
//                                                 another, the two are merged; position 0 is first)
//   DELETE /inspirations/tags/:name               -> InspirationTagsSaved
//   POST   /inspirations/changes/:id/undo         {} -> ChangesetInfo of the undo; 409 when it was not of inspirations,
//                                                 or what it changed has changed since
//   POST   /inspirations/capture                  the share sheet's door (the iPhone's Inspire shortcut, docs/features.md's
//                                                 "Inspirations"): multipart/form-data with link, text, caption, origin
//                                                 and file (or JSON with link, text, caption, origin) -> Captured and a
//                                                 line for the phone; the same capture as the CLI's inspiration add,
//                                                 answered at once, its preview, AI tags and ask left to the worker
//
// Who may write: the door admits only the Hosts it knows (the core's server/allowedHosts.ts); a write must come from the page itself
// (a JSON body, and an Origin naming this server: mayWrite). Who reaches the viewer from the tailnet at all is the
// tailnet's ACL; there is no per-person login. The capture route is for the phone's shortcut, not a page, so it asks
// for no Origin: the Host guard and the tailnet's ACL are its boundary, and a browser page elsewhere is still refused
// (fromOwnPage: its Sec-Fetch-Site or Origin gives it away).

import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Effect } from "effect";
import { answering, ForbiddenError, fromOwnPage, InvalidInputError, mediaTypeOf, moduleApi, NotFoundError, readBody, readJson, sendJson, UnavailableError, type Route } from "../../../sdk/server.ts";
import { INSPIRATIONS_API, readInspirationFilter, type InspirationSaved, type InspirationTagsSaved } from "../wire.ts";
import { keepFile, keptFileAt } from "./files.ts";
import { looksLikeLink } from "./links.ts";
import type { InspirationsPart } from "./part.ts";
import { INSPIRATION_TABLES, type Captured, type Inspirations, type KeptFile } from "./store.ts";

/** The module's own address, MODULES_API/inspirations, where its routes answer too, as at INSPIRATIONS_API (its mount). */
const OWN_API = moduleApi("inspirations");

/** Types shown in the page; any other kept file is offered as a download. */
const INLINE_TYPES = /^image\/(jpeg|png|webp|gif|heic|avif)$/;

/** The most a capture may send: a phone's photo or screenshot, whole. */
const MAX_CAPTURE_BYTES = 30 * 1024 * 1024;

/** The door a capture names itself by when it does not say: the iPhone's share sheet. */
const SHARE_SHEET = "share-sheet";

/** What the share sheet's route answers: the capture, and one line for the phone. */
export interface CaptureAnswer extends Captured {
  /** The item's canonical link; null for a kept file alone. */
  link: string | null;
  message: string;
}

/** Refuses a write that is not the page's own: a JSON body, and an Origin naming this server (a browser sends one with every write). */
export const mayWrite = (req: IncomingMessage): Effect.Effect<void, ForbiddenError | InvalidInputError> =>
  Effect.gen(function* () {
    if (req.method !== "DELETE" && !/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      return yield* new InvalidInputError("the body must be JSON (content-type: application/json)");
    }
    if (req.headers.origin === undefined) return yield* new ForbiddenError("a change to inspirations comes from the Inspirations page itself");
    yield* fromOwnPage(req);
  });

export type RouteErrors = NotFoundError | InvalidInputError | ForbiddenError | UnavailableError;

/** The routes, over the inspirations `part`, their files kept in the module's folder `folder`. */
export function inspirationsRoute(part: InspirationsPart, folder: string, { now = () => Date.now() }: { now?: () => number } = {}): Route<RouteErrors, never> {
  return (req, res) =>
    Effect.gen(function* () {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.slice((url.pathname.startsWith(OWN_API) ? OWN_API : INSPIRATIONS_API).length) || "/";
      const method = req.method ?? "GET";
      yield* fromOwnPage(req);
      if (method === "GET" || method === "HEAD") return yield* read(part, folder, path, url, req, res);
      if (path === "/capture" && method === "POST") return yield* capture(part.store, folder, req, res, now());
      yield* mayWrite(req);
      return yield* write(part, method, path, req, res, now());
    }).pipe(answering(NotFoundError, InvalidInputError, ForbiddenError, UnavailableError));
}

/** What a capture sends: a link, or shared text (a link in it is the link), his words, where from, and a shared file. */
interface CaptureFields {
  link: string | null;
  text: string | null;
  caption: string;
  origin: string;
  file: { name: string; type: string; bytes: Buffer } | null;
}

/** The capture's fields, from a form (the shortcut's) or JSON. */
const readCapture = (req: IncomingMessage): Effect.Effect<CaptureFields, InvalidInputError> =>
  Effect.gen(function* () {
    const type = req.headers["content-type"] ?? "";
    const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
    if (/^application\/json\b/i.test(type)) {
      const body = yield* readJson(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return yield* new InvalidInputError("a capture is a JSON object: link or text, caption, origin");
      const { link, text: shared, caption, origin } = body as Record<string, unknown>;
      return { link: text(link), text: text(shared), caption: text(caption) ?? "", origin: text(origin) ?? SHARE_SHEET, file: null };
    }
    if (/^multipart\/form-data\b/i.test(type)) {
      const bytes = yield* readBody(req, MAX_CAPTURE_BYTES);
      const form = yield* Effect.tryPromise({
        try: () => new Request("http://localhost/", { method: "POST", headers: { "content-type": type }, body: new Uint8Array(bytes) }).formData(),
        catch: () => new InvalidInputError("the form could not be read (multipart/form-data with link, text, caption, origin and file)"),
      });
      const shared = form.get("file");
      const file = shared instanceof File && shared.size > 0
        ? { name: shared.name, type: shared.type, bytes: Buffer.from(yield* Effect.promise(() => shared.arrayBuffer())) }
        : null;
      return { link: text(form.get("link")), text: text(form.get("text")), caption: text(form.get("caption")) ?? "", origin: text(form.get("origin")) ?? SHARE_SHEET, file };
    }
    return yield* new InvalidInputError("a capture is sent as multipart/form-data or JSON");
  });

/** The first web link in shared text, if any (a share from an app often puts the link after a line or two). */
export function linkIn(text: string): string | null {
  return text.match(/https?:\/\/[^\s<>"'）)\]]+/i)?.[0] ?? null;
}

/**
 * The share sheet's capture: the link (given, or found in the shared text), a shared file kept by its hash, or the
 * shared text alone kept as a text file (its first line the title, the text its description), with his words as the
 * caption, through Inspirations.capture as every door is. Answered at once with one line for the phone.
 */
const capture = Effect.fnUntraced(function* (store: Inspirations, folder: string, req: IncomingMessage, res: ServerResponse, now: number) {
  const given = yield* readCapture(req);
  const keep = (bytes: Buffer, name: string, mime: string) =>
    Effect.tryPromise({
      try: (): Promise<KeptFile> => keepFile(folder, Readable.from([bytes]), name, mime),
      catch: (error) => new UnavailableError(`the file could not be kept: ${(error as Error).message}`),
    });
  let link: string | null = null;
  if (given.link) {
    if (!looksLikeLink(given.link)) return yield* new InvalidInputError(`"${given.link.trim().slice(0, 80)}" is not a link`);
    link = given.link.trim();
  } else if (given.text) link = linkIn(given.text);
  const files: KeptFile[] = [];
  let known: { title?: string; description?: string } = {};
  if (given.file) {
    const mime = given.file.type || mediaTypeOf(given.file.name).mime || "application/octet-stream";
    files.push(yield* keep(given.file.bytes, given.file.name || `shared${extensionFor(mime)}`, mime));
  }
  if (!link && files.length === 0) {
    const text = given.text?.trim();
    if (!text) return yield* new InvalidInputError("an inspiration needs a link, a file or some text, and words are welcome");
    const first = text.split("\n")[0].trim();
    known = { title: first.length > 120 ? `${first.slice(0, 119).trimEnd()}…` : first, description: text.length > 4000 ? `${text.slice(0, 3999).trimEnd()}…` : text };
    files.push(yield* keep(Buffer.from(text, "utf8"), "shared.txt", "text/plain"));
  }
  const made = store.capture({ link, files, caption: given.caption, origin: given.origin, ...known, savedAt: now, now });
  const item = store.existing(made.id);
  const name = item.title ?? item.link ?? (item.form === "image" ? "a photo" : "a kept file");
  const answer: CaptureAnswer = {
    ...made,
    link: item.link,
    message: made.created ? `Saved #${item.id} (new): ${name}` : made.saved ? `Saved #${item.id} again (kept before): ${name}` : `#${item.id} had this save already: ${name}`,
  };
  return sendJson(res, 200, answer);
});

/** A file's extension for its type, when its name has none. */
function extensionFor(mime: string): string {
  const known: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/heic": ".heic", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/quicktime": ".mov", "text/plain": ".txt" };
  return known[mime] ?? "";
}

/**
 * What a read of the store answers at `path` (under INSPIRATIONS_API): the list (filtered and paged), the tags, an
 * item; undefined for any other path. Plain code over the module's database, which the static demo runs in its page too (demo.ts).
 */
export function inspirationsRead(store: Inspirations, path: string, url: URL): unknown {
  let match: RegExpExecArray | null;
  if (path === "/") {
    const page = { offset: whole(url.searchParams.get("offset"), 0), limit: whole(url.searchParams.get("limit"), 60) };
    return store.list(readInspirationFilter(url.searchParams), page);
  }
  if (path === "/tags") return store.tags();
  if ((match = /^\/items\/(\d+)$/.exec(path))) return store.existing(Number(match[1]));
  return undefined;
}

const read = Effect.fnUntraced(function* (part: InspirationsPart, folder: string, path: string, url: URL, req: IncomingMessage, res: ServerResponse) {
  const { store, changes } = part;
  const answer = inspirationsRead(store, path, url);
  if (answer !== undefined) return sendJson(res, 200, answer);
  let match: RegExpExecArray | null;
  if ((match = /^\/files\/(\d+)$/.exec(path))) {
    const file = store.file(Number(match[1]));
    if (!file) return yield* new NotFoundError(`there is no kept file #${match[1]}`);
    const found = yield* Effect.promise(() => keptFileAt(folder, file.path).catch(() => null));
    if (!found) return yield* new NotFoundError(`kept file #${match[1]} is not in the archive's folder`);
    return yield* Effect.promise(() => sendFile(req, res, found, file.mime, file.bytes));
  }
  if (path === "/changes") return sendJson(res, 200, changes.list({ limit: whole(url.searchParams.get("limit"), 30), tables: INSPIRATION_TABLES }));
  return yield* new NotFoundError(`no route GET ${INSPIRATIONS_API}${path}`);
});

const write = Effect.fnUntraced(function* (part: InspirationsPart, method: string, path: string, req: IncomingMessage, res: ServerResponse, now: number) {
  const { store, changes } = part;
  const body = method === "DELETE" ? {} : (((yield* readJson(req)) ?? {}) as Record<string, unknown>);
  /** One edit as one changeset from the page, the item after and the changeset, for Undo. */
  const saved = (id: number, action: string, work: () => void): InspirationSaved => {
    const { changeset } = changes.record({ surface: "app", action }, work);
    return { item: store.existing(id), changeset };
  };
  const tagsSaved = (action: string, work: () => void): InspirationTagsSaved => {
    const { changeset } = changes.record({ surface: "app", action }, work);
    return { tags: store.tags(), changeset };
  };
  let match: RegExpExecArray | null;
  if ((match = /^\/items\/(\d+)\/(caption|tags|hidden|ai-tags)$/.exec(path))) {
    const id = Number(match[1]);
    store.existing(id);
    if (match[2] === "caption" && method === "PUT") return sendJson(res, 200, saved(id, `inspiration caption #${id}`, () => store.setCaption(id, body.caption, now)));
    if (match[2] === "tags" && method === "PUT") return sendJson(res, 200, saved(id, `inspiration tags #${id}`, () => store.setTags(id, body.tags, now)));
    if (match[2] === "hidden" && method === "PUT") {
      if (typeof body.hidden !== "boolean") return yield* new InvalidInputError("hidden is true or false");
      const hidden = body.hidden;
      return sendJson(res, 200, saved(id, `inspiration ${hidden ? "hide" : "show"} #${id}`, () => store.setHidden(id, hidden, now)));
    }
    if (match[2] === "ai-tags" && method === "POST") {
      store.queueAi(id);
      return sendJson(res, 200, store.existing(id));
    }
  }
  if (path === "/tags" && method === "POST") {
    return sendJson(res, 200, tagsSaved("inspiration tag add", () => store.createTag(body.name, body.description ?? "", now)));
  }
  if ((match = /^\/tags\/([^/]+)$/.exec(path))) {
    const name = decodeURIComponent(match[1]);
    if (method === "DELETE") return sendJson(res, 200, tagsSaved(`inspiration tag delete ${name}`, () => store.deleteTag(name)));
    if (method === "PUT") {
      const { name: to, description, position } = body;
      if (position !== undefined && (typeof position !== "number" || !Number.isSafeInteger(position))) return yield* new InvalidInputError("position is a whole number from 0");
      return sendJson(res, 200, tagsSaved(`inspiration tag ${to !== undefined ? "rename" : position !== undefined ? "move" : "describe"} ${name}`, () => {
        let current = name;
        if (description !== undefined) store.describeTag(current, description);
        if (position !== undefined) store.moveTag(current, position as number);
        if (to !== undefined) current = store.renameTag(current, to).name;
      }));
    }
  }
  if ((match = /^\/changes\/(\d+)\/undo$/.exec(path)) && method === "POST") {
    const id = Number(match[1]);
    return sendJson(res, 200, changes.undo(id, { surface: "app" }).value);
  }
  return yield* new NotFoundError(`no route ${method} ${INSPIRATIONS_API}${path}`);
});

/** A whole number in the query string, `fallback` when it is not there; NaN (refused by the store) for anything else. */
function whole(text: string | null, fallback: number): number {
  if (text === null || text === "") return fallback;
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

async function sendFile(req: IncomingMessage, res: ServerResponse, path: string, mime: string, bytes: number): Promise<void> {
  const inline = INLINE_TYPES.test(mime);
  res.writeHead(200, {
    "content-type": inline ? mime : "application/octet-stream",
    "content-disposition": inline ? "inline" : "attachment",
    "content-length": bytes,
    "x-content-type-options": "nosniff",
    // Named by content hash: a kept file never changes.
    "cache-control": "private, max-age=31536000, immutable",
  });
  if (req.method === "HEAD") return void res.end();
  await pipeline(createReadStream(path), res).catch(() => res.destroy());
}
