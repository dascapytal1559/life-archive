// The archive's server's door (server/main.ts): the viewer's routes (/life-archive/..., server/viewer/) and, among them,
// the modules' (/life-archive/api/m/<module>/..., server/modules/loader.ts; the Health tab's results are the health
// module's, the Fitness page's activities and the maps it draws routes on the exercise module's, the Daily rituals and
// Habits tabs' the rituals module's, friend map's contract and tables friend map's), the paths a module mounts its route
// at besides (sdk/server.ts's `mounts`: friend map's contract at /api/archive, which friend-map's page speaks, its
// page's own API under /friend-map/api, the chats a Messages row's drawer opens, Shopping's page at
// /life-archive/api/shopping and the Inspirations page's at /life-archive/api/inspirations, where they were while they
// were the core's), the pages a module serves in a frame (sdk/server.ts's `page`: friend-map's at /friend-map/), the
// Events page's Sources tab's (/life-archive/api/sources, server/sources/http.ts), the agents' conversations a drawer
// opens (/life-archive/api/content/llm/..., server/viewer/content.ts), the tables' edits (/life-archive/api/edits,
// server/edits/http.ts), the agents' MCP door (/life-archive/mcp, server/mcp/http.ts) and the main branch's preview
// (/life-archive/main, server/mainPreview.ts), and nothing else, to Host names it admits. The console's former address
// (/life-archive/console/...) is sent on to its address (/life-archive/dev/...), its query kept.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { guardHosts } from "../allowedHosts.ts";
import { sendJson, type ApiHandler } from "../jsonApi.ts";
import { MAIN_PREVIEW_PATH } from "../mainPreview.ts";
import { MCP_PATH } from "../mcp/http.ts";
import { fromFormerConsole } from "../../viewer/console/address.ts";
import { EDITS_API } from "../../viewer/editWire.ts";
import { SOURCES_API } from "../../viewer/sourcesWire.ts";
import { API_BASE, CONTENT_API, MODULES_API, SETTINGS_API, VIEWER_BASE } from "../../viewer/wire.ts";

/**
 * The viewer: its read API (server/viewer/http.ts), its page (Vite's middlewares, whose base is VIEWER_BASE) and the
 * modules' routes, answered under MODULES_API beside the read API (server/modules/loader.ts's moduleRoutes).
 */
/** A module's route at a path outside MODULES_API (sdk/server.ts's `mounts`): each request under `path` goes to `handler` whole. */
export interface Mount {
  readonly path: string;
  readonly handler: ApiHandler;
}

/** A page a module serves (sdk/server.ts's `page`), at `path` and under it, its API among the mounts. */
export interface ModulePage {
  readonly path: string;
  readonly page: (req: IncomingMessage, res: ServerResponse) => void;
}

export interface ViewerHandlers {
  api: ApiHandler;
  page: (req: IncomingMessage, res: ServerResponse) => void;
  /** The modules' routes (server/modules/loader.ts), under MODULES_API: each module's at MODULES_API/<id> and under it. */
  modules?: ApiHandler;
  /** The Events page's Sources tab: how each connector syncs (server/sources/http.ts), at SOURCES_API. */
  sources?: ApiHandler;
  /** What the page is told of its archive as it opens (server/viewer/pageSettings.ts), at SETTINGS_API, whether the archive opened or not. */
  settings?: ApiHandler;
  /** The conversations a row's drawer opens (server/viewer/content.ts), under CONTENT_API: the viewer's only reads of content. */
  content?: ApiHandler;
  /** The tables' edits (server/edits/http.ts), at EDITS_API and under it. */
  edits?: ApiHandler;
  /** The modules' routes at their mounts (sdk/server.ts's `mounts`), the longest path first. */
  mounts?: readonly Mount[];
  /** The modules' pages (sdk/server.ts's `page`). */
  pages?: readonly ModulePage[];
  /** The agents' MCP door (server/mcp/http.ts), at MCP_PATH. */
  mcp?: ApiHandler;
  /** The main branch's preview (server/mainPreview.ts), a built demo's plain files, at MAIN_PREVIEW_PATH and under it. */
  mainPreview?: ApiHandler;
}

/** Whether `path` is `at` or under it. */
const under = (path: string, at: string) => path === at || path.startsWith(`${at}/`);

/**
 * A server answering the viewer's routes at VIEWER_BASE (the root and VIEWER_BASE itself sent on to VIEWER_BASE/), the
 * modules' mounts and pages: 404 for any other path, and 403 for a Host not localhost or in `hosts` (allowedHosts.ts).
 */
export function archiveServer({ hosts, viewer }: { hosts: readonly string[]; viewer: ViewerHandlers }): Server {
  const mounts = [...(viewer.mounts ?? [])].sort((a, b) => b.path.length - a.path.length);
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const mount = mounts.find((m) => under(path, m.path));
    if (mount) return void mount.handler(req, res);
    for (const page of viewer.pages ?? []) {
      if (path === page.path) return void res.writeHead(302, { location: `${page.path}/${new URL(req.url ?? "/", "http://localhost").search}` }).end();
      if (under(path, page.path)) return page.page(req, res);
    }
    if (path === SETTINGS_API && viewer.settings) return void viewer.settings(req, res);
    if (path === MCP_PATH && viewer.mcp) return void viewer.mcp(req, res);
    if (path.startsWith(`${MODULES_API}/`) && viewer.modules) return void viewer.modules(req, res);
    if (path === SOURCES_API && viewer.sources) return void viewer.sources(req, res);
    if (path.startsWith(`${CONTENT_API}/`) && viewer.content) return void viewer.content(req, res);
    if (under(path, EDITS_API) && viewer.edits) return void viewer.edits(req, res);
    if (path.startsWith(`${API_BASE}/`)) return void viewer.api(req, res);
    const moved = fromFormerConsole(path);
    if (moved !== null) return void res.writeHead(302, { location: `${moved}${new URL(req.url ?? "/", "http://localhost").search}` }).end();
    if (under(path, MAIN_PREVIEW_PATH) && viewer.mainPreview) return void viewer.mainPreview(req, res);
    if (path === "/" || path === VIEWER_BASE) return void res.writeHead(302, { location: `${VIEWER_BASE}/` }).end();
    if (path.startsWith(`${VIEWER_BASE}/`)) return viewer.page(req, res);
    sendJson(res, 404, { error: `the archive's server answers only ${VIEWER_BASE}/ and the modules' paths (${[...mounts.map((m) => m.path), ...(viewer.pages ?? []).map((p) => p.path)].join(", ") || "none"})` });
  });
  guardHosts(server, hosts);
  return server;
}
