// friend-map's page's own small API, besides the archive's (its server's api.ts before it was a module), answered by
// the module's route (../routes.ts) under the page's path, /friend-map/api, over the page's folder
// (savedSettingsPlugin.ts's pageFolder):
//
//   POST /api/usage                {view, opened, seconds} -> 204: appends a line to usage.jsonl (see usage.ts)
//   GET  /api/settings             -> {settings, problems}: settings.json with the defaults filling any gap (see settings.ts)
//   GET  /api/view-settings        -> {settings}: the saved view settings, view-settings.json (see viewSettings.ts)
//   PUT  /api/view-settings        {<setting>: <value> | null} -> {settings}: each saved, or with null forgotten, the rest kept
//   GET  /api/me                   -> {photo}: where your photo for the sun on Orbits is shown from, or null for none (see mePhoto.ts)
//   GET  /api/me/photo             -> the photo's file (404 for none)
//   PUT  /api/me/photo             the image's bytes (JPEG, PNG, WebP or HEIC, up to 15 MB) -> {photo}: kept in me/, in place of any before it
//   DELETE /api/me/photo           -> {photo: null}: removed, so the sun is drawn again
//
// The page's own helpers throw the page's InvalidInputError (its src/invalidInput.ts), answered 400 here as the core's.

import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { InvalidInputError as PageInvalidInput } from "../../page/src/invalidInput.ts";
import { Effect, ForbiddenError, fromOwnPage, InvalidInputError, NotFoundError, readBody, readJson, sendJson } from "../../../../sdk/server.ts";
import { currentPhoto, MAX_PHOTO_BYTES, photoUrl, removePhoto, savePhoto, type HeicConverter } from "./mePhoto.ts";
import { readSettings } from "./settings.ts";
import { recordUsage, usageFile } from "./usage.ts";
import { readViewSettings, saveViewSettings } from "./viewSettings.ts";

/** A page helper's work, its InvalidInputError the core's (400), anything else a defect (500). */
const page = <T>(work: () => Promise<T>): Effect.Effect<T, InvalidInputError> =>
  Effect.tryPromise({ try: work, catch: (error) => error }).pipe(
    Effect.catch((error) => (error instanceof PageInvalidInput ? Effect.fail(new InvalidInputError(error.message)) : Effect.die(error))),
  );

/** Answers `path` (from /api on) for the page's folder `dataDir`. */
export const pageApi = (dataDir: string, path: string, req: IncomingMessage, res: ServerResponse, { convertHeic }: { convertHeic?: HeicConverter } = {}) =>
  Effect.gen(function* () {
    const method = req.method ?? "GET";
    if (path === "/api/settings") {
      if (method === "GET") return sendJson(res, 200, yield* page(() => readSettings(dataDir)));
    } else if (path === "/api/view-settings") {
      if (method === "GET") return sendJson(res, 200, { settings: yield* page(() => readViewSettings(dataDir)) });
      if (method === "PUT") {
        yield* fromOwnPage(req);
        const body = yield* readJson(req);
        return sendJson(res, 200, { settings: yield* page(() => saveViewSettings(dataDir, body)) });
      }
    } else if (path === "/api/usage") {
      if (method === "POST") {
        yield* fromOwnPage(req);
        const body = yield* readJson(req);
        yield* page(() => recordUsage(usageFile(dataDir), body));
        return void res.writeHead(204).end();
      }
    } else if (path === "/api/me") {
      if (method === "GET") return sendJson(res, 200, { photo: yield* page(() => photoUrl(dataDir)) });
    } else if (path === "/api/me/photo") {
      if (method === "GET") return yield* sendPhoto(dataDir, res);
      // PUT and DELETE are never sent cross-site without asking first, which this server never answers; fromOwnPage too.
      if (method === "PUT") {
        yield* fromOwnPage(req);
        const bytes = yield* readBody(req, MAX_PHOTO_BYTES);
        yield* page(() => savePhoto(dataDir, bytes, convertHeic));
        return sendJson(res, 200, { photo: yield* page(() => photoUrl(dataDir)) });
      }
      if (method === "DELETE") {
        yield* fromOwnPage(req);
        yield* page(() => removePhoto(dataDir));
        return sendJson(res, 200, { photo: null });
      }
    } else {
      return yield* new NotFoundError(`no route ${path}`);
    }
    sendJson(res, 405, { error: `${method} not allowed on ${path}` });
  });

const sendPhoto = (dataDir: string, res: ServerResponse): Effect.Effect<void, NotFoundError | InvalidInputError> =>
  Effect.gen(function* () {
    const photo = yield* page(() => currentPhoto(dataDir));
    if (!photo) return yield* new NotFoundError("no photo");
    // The page asks for it by an address that changes with each new photo, so it may keep it, but must check it is still there.
    res.writeHead(200, { "content-type": photo.type, "x-content-type-options": "nosniff", "cache-control": "private, no-cache" });
    yield* Effect.promise(() => pipeline(createReadStream(photo.path), res).catch(() => res.destroy()));
  });

export type PageApiError = NotFoundError | InvalidInputError | ForbiddenError;
