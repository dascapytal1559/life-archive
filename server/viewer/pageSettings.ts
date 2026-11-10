// What the page is told of its archive as it opens, GET /life-archive/api/settings (viewer/wire.ts's PageSettings, read by
// viewer/main.tsx before anything of the console loads): the time zone and locale the page writes in, and where the
// pages the console embeds answer. Its own route, not the viewer's read API, so the page opens while the archive cannot.

import { Effect } from "effect";
import { ForbiddenError } from "../errors.ts";
import { answering, fromOwnPage, sendJson, type Route } from "../jsonApi.ts";
import type { PageSettings } from "../../viewer/wire.ts";

/** Answers `settings`, which do not change while the server runs. */
export const pageSettingsRoute = (settings: PageSettings): Route<ForbiddenError, never> => (req, res) =>
  Effect.gen(function* () {
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "the settings are only read here" });
    yield* fromOwnPage(req);
    sendJson(res, 200, settings);
  }).pipe(answering(ForbiddenError));
