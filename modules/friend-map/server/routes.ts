// Friend map's route (sdk/server.ts's `routes`), answering wherever its requests come (`mounts` and its own place):
//
//   /api/archive/...                   friend-map's contract (http.ts), where friend-map's page and anything else
//   /friend-map/api/archive/...        that speaks it reach the archive: the page under its own path (/friend-map/,
//                                      the core serving it), the scoring among it (page/scoring.ts)
//   /friend-map/api/...                the page's own small API (page/pageApi.ts) over the page's folder
//   /life-archive/api/content/messages/...   the chat a Messages row's drawer opens (chat.ts)
//   /life-archive/api/m/friend-map/... the module's own place, the same routes under it (/archive/..., /api/...)
//
// A request to the contract naming another archive's folder (ARCHIVE_FOLDER_HEADER, which friend-map-frontend's own
// server sends) is answered 503, so a page on a testing folder never meets the real archive.

import type { IncomingMessage } from "node:http";
import {
  AiService, answering, ARCHIVE_FOLDER_HEADER, Effect, ForbiddenError, InvalidInputError, moduleApi, NotFoundError, sameFolder, sendJson, UnavailableError,
  type Route, type RouteError,
} from "../../../sdk/server.ts";
import { CHAT_PATH, chatRoute } from "./chat.ts";
import type { FriendMap } from "./friendMap.ts";
import { archiveRoute } from "./http.ts";
import { pageApi } from "./page/pageApi.ts";
import { PAGE_PATH, pageFolder } from "./page/savedSettingsPlugin.ts";
import { scoring } from "./page/scoring.ts";

/** Where the contract is. */
const CONTRACT = "/api/archive";

/** The module's own place, MODULES_API/friend-map. */
const OWN = moduleApi("friend-map");

/** The paths outside its own place the route answers. */
export const FRIEND_MAP_MOUNTS: readonly string[] = [CONTRACT, `${PAGE_PATH}/api`, CHAT_PATH];

/** A request's path from /api on, wherever it came: /friend-map/api/settings and MODULES_API/friend-map/api/settings are /api/settings, MODULES_API/friend-map/archive/x is /api/archive/x. */
export function pathOf(pathname: string): string | null {
  if (pathname.startsWith(`${PAGE_PATH}/api/`)) return pathname.slice(PAGE_PATH.length);
  if (pathname.startsWith(`${OWN}/archive/`)) return `/api${pathname.slice(OWN.length)}`;
  if (pathname.startsWith(`${OWN}/api/`)) return pathname.slice(OWN.length);
  if (pathname.startsWith(`${CONTRACT}/`)) return pathname;
  return null;
}

export const friendMapRoute = (archive: FriendMap): Route<RouteError, AiService> => {
  const contract = archiveRoute(archive);
  return (req, res) =>
    Effect.gen(function* () {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith(`${CHAT_PATH}/`)) return yield* chatRoute(archive, req, res);
      const path = pathOf(url.pathname);
      if (path === null) return yield* new NotFoundError(`no route ${url.pathname}`);
      if (path.startsWith(`${CONTRACT}/`)) {
        const asked = req.headers[ARCHIVE_FOLDER_HEADER];
        if (typeof asked === "string" && !sameFolder(decodeURIComponent(asked), archive.folder)) {
          return sendJson(res, 503, { error: `the archive is not available: this archive's server keeps the archive at ${archive.folder}, not ${decodeURIComponent(asked)}` });
        }
        if (yield* scoring(archive, path.slice(CONTRACT.length), url, req, res)) return;
        // The contract reads its path from /api/archive on, as friend-map's page sends it.
        return yield* contract(withPath(req, `${path}${url.search}`), res);
      }
      return yield* pageApi(pageFolder(archive.folder), path, req, res);
    }).pipe(answering(NotFoundError, InvalidInputError, UnavailableError, ForbiddenError));
};

/** `req` with its url as `url`, everything else as it came. */
function withPath(req: IncomingMessage, url: string): IncomingMessage {
  req.url = url;
  return req;
}
