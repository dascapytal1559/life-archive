// The archive's server as one Layer (docs/effect.md, "Services and Layers"): everything it opens or runs, each a
// scoped resource, built in the order the server starts and closed in the reverse order as it stops.
//
//   1. its settings: the archive's folder, where it answers, the Host names it admits (dataHome.ts), its owner's (settings.ts)
//      and the modules (modules/loader.ts: those settings.json leaves on, loaded, and their databases opened, modules/store.ts;
//      LoadedModules); a switch naming no installed module is said so on stderr and switches nothing
//   2. the backups' prune (backups.ts), as it starts
//   3. the archive, open (OpenArchive; closed last but for the modules' databases, so its WAL is checkpointed and removed),
//      the modules' connectors registered with its host and their rows in its calendar's rebuild
//   4. the modules, ready (ReadyModules): each with what it is given, the archive's calendar and live connectors among
//      it (modules/loader.ts's readyModules), and their answers for their calendar rows
//   5. the AI service (AiService: Codex, its process stopped)
//   6. the viewer's connections (ViewerDb), the calendar's rows answered for by the core's owners and the modules'
//   7. the services the modules offer (ModuleServices), and then the work they do while the server runs (ModuleWork:
//      rituals' watch on its store, Shopping's morning pulls, the folder history's watchers, the inspirations' previews,
//      AI tags), each a fiber stopped as the server stops, before the AI service and the archive close
//   8. the HTTP server (archive/server.ts) and Vite in middleware mode for the viewer's page, then listening: the
//      modules' routes among the viewer's (MODULES_API/<id>), each with the services below, the tables' edits
//      (edits/http.ts: each handed to its row's owner, the modules' editors), and the agents' MCP door (mcp/http.ts:
//      the core's tools and the modules', with the same services)
//   9. the live connectors and the live bridges' lock (Archive.startLive; stopped, and the lock let go)
//
// server/main.ts builds one ManagedRuntime from it, and disposing that runtime (on SIGINT or SIGTERM) closes them.

import type { Server, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Data, Deferred, Effect, Layer } from "effect";
import type { ViteDevServer } from "vite";
import type { ModuleEvents } from "../sdk/server.ts";
import { AiService } from "./ai.ts";
import { admittedHosts } from "./allowedHosts.ts";
import { pruneBackups } from "./archive/backups.ts";
import { OpenArchive } from "./archive/index.ts";
import { archiveServer } from "./archive/server.ts";
import { archiveFolder, archiveUrl } from "./dataHome.ts";
import { MAIN_PREVIEW_FOLDER, mainPreviewRoute } from "./mainPreview.ts";
import { startModulePage } from "./modulePages.ts";
import { DEFAULT_OWNER, settings, type Settings, type SettingsProblem } from "./settings.ts";
import { buildDoor } from "./mcp/door.ts";
import { mcpDoor } from "./mcp/http.ts";
import { tabsWith } from "./viewer/tabs.ts";
import { handler, sendJson, type ApiHandler } from "./jsonApi.ts";
import {
  loadModules, moduleEvents, moduleHandler, moduleMounts, moduleOwners, moduleReads, moduleRoutes, moduleServices, moduleSwitches, moduleTabs, moduleViewerSettings, modulesLine, moduleWork, readyModules, type ReadyModule,
} from "./modules/loader.ts";
import { closeModuleStores, openModuleStores, type ModuleStores } from "./modules/store.ts";
import { pendingMoveLines, planModuleMoves } from "./modules/moves.ts";
import { sourcesRoute } from "./sources/http.ts";
import { ViewerDb } from "./viewer/connection.ts";
import { contentRoute } from "./viewer/content.ts";
import { tableEditsOf } from "./edits/edits.ts";
import { editsRoute } from "./edits/http.ts";
import { viewerRoute } from "./viewer/http.ts";
import { pageSettingsRoute } from "./viewer/pageSettings.ts";

/** Where the server keeps the archive and answers, the Host names it admits, and the owner's settings (see main.ts). */
export class ServerSettings extends Context.Service<ServerSettings, {
  readonly folder: string;
  readonly host: string;
  readonly port: number;
  readonly hosts: readonly string[];
  /** The archive's owner's settings (settings.ts). */
  readonly settings: Settings;
}>()("life-archive/ServerSettings") {
  static readonly layer = Layer.sync(ServerSettings, () => ({
    folder: archiveFolder(),
    host: "127.0.0.1",
    port: Number(new URL(archiveUrl()).port || 80),
    hosts: admittedHosts(),
    settings: settings(),
  }));
}

/** The server could not listen where it answers (the port taken, say); the log has said so. */
export class CouldNotListen extends Data.TaggedError("CouldNotListen")<{ readonly message: string }> {}

/**
 * The modules, as the loader found them (modules/loader.ts) and with their databases open (modules/store.ts): those on
 * loaded, those switched off and those broken listed. Their databases are closed as the server stops, after the archive.
 */
export class LoadedModules extends Context.Service<LoadedModules, ModuleStores>()("life-archive/LoadedModules") {
  /** Loads the modules settings.json leaves on and opens their databases, and says what it found; a switch naming no installed module is said so on stderr and switches nothing. */
  static readonly layer = Layer.effect(
    LoadedModules,
    Effect.gen(function* () {
      const { folder, settings } = yield* ServerSettings;
      const loaded = yield* Effect.tryPromise({ try: () => loadModules({ switches: settings.modules, pages: settings.pages }), catch: (error) => error as SettingsProblem });
      const stores = yield* Effect.acquireRelease(
        Effect.sync(() => openModuleStores(loaded, folder)),
        (stores) => Effect.sync(() => closeModuleStores(stores)),
      );
      console.log(modulesLine(stores));
      // A module's files still at their old places are read there; the move is the owner's (modules/moves.ts).
      for (const line of pendingMoveLines(folder, planModuleMoves(folder, stores.on.map((m) => ({ id: m.id, moves: m.definition.moves }))))) console.log(line);
      return stores;
    }),
  );
}

/** Backups expire with time, not only when a new one is taken (see archive/backups.ts). */
const PruneBackups = Layer.effectDiscard(
  Effect.gen(function* () {
    const { folder } = yield* ServerSettings;
    yield* Effect.tryPromise({ try: () => pruneBackups(join(folder, "backups")), catch: (error) => error as Error }).pipe(
      Effect.match({
        onSuccess: (pruned) => {
          if (pruned.length > 0) console.log(`Deleted ${pruned.length} old archive backups: ${pruned.join(", ")}`);
        },
        onFailure: (error) => console.error("Could not prune the archive backups:", error.message),
      }),
    );
  }),
);

/** If the archive can't be opened, its routes answer 503 and friend-map's page says so. */
const ArchiveLayer = Layer.effect(
  OpenArchive,
  Effect.gen(function* () {
    const { folder } = yield* ServerSettings;
    const stores = yield* LoadedModules;
    const opened = yield* OpenArchive.open(folder, { stores });
    if (opened.archive instanceof Error) console.error("The message archive is not available:", opened.archive.message);
    return opened;
  }),
);

/**
 * The modules ready: each with what it is given (sdk/server.ts: the archive's folder, its database, and the archive's
 * calendar and live connectors, which throw the archive's error while it is not open), and their answers for their
 * calendar rows (`events`), made once for the viewer's owners and the calendar's rebuild.
 */
export class ReadyModules extends Context.Service<ReadyModules, {
  readonly modules: readonly ReadyModule[];
  readonly events: ReadonlyMap<string, ModuleEvents>;
}>()("life-archive/ReadyModules") {
  static readonly layer = Layer.effect(
    ReadyModules,
    Effect.gen(function* () {
      const { folder } = yield* ServerSettings;
      const stores = yield* LoadedModules;
      const { archive } = yield* OpenArchive;
      const modules = archive instanceof Error ? readyModules(stores, folder, archive) : archive.modules;
      return { modules, events: moduleEvents(modules) };
    }),
  );
}

/** The AI service (Codex on the captain's ChatGPT plan), started now and kept running so a question never waits for it to start. */
const Ai = AiService.layer({ log: (line) => console.log(`[codex] ${line}`) });

/**
 * The viewer reads on connections of its own, read-only and unable to read content (viewer/connection.ts: the archive
 * and the calendar), the calendar's rows answered for by the core's owners and the modules that declare hooks (sdk/server.ts's `events`).
 */
const Viewer = Layer.effect(
  ViewerDb,
  Effect.gen(function* () {
    const { folder } = yield* ServerSettings;
    const stores = yield* LoadedModules;
    const { archive } = yield* OpenArchive;
    const { events } = yield* ReadyModules;
    return yield* ViewerDb.open(archive, folder, moduleOwners(events), moduleReads(stores, folder));
  }),
);

/** The services the loaded modules offer the core and one another (sdk/server.ts's `services`), as one Layer. */
const ModuleServices = Layer.unwrap(
  Effect.gen(function* () {
    const { modules } = yield* ReadyModules;
    return moduleServices(modules);
  }),
);

/**
 * The work the loaded modules do while the server runs (sdk/server.ts's `work`: rituals' watch on its store, pushing
 * its rows into the calendar as ritualctl changes it), each a fiber of this layer's scope, interrupted as the server
 * stops, before the archive closes.
 */
const ModuleWork = Layer.unwrap(
  Effect.gen(function* () {
    const { modules } = yield* ReadyModules;
    return moduleWork(modules);
  }),
);

/**
 * The HTTP server, answering once Vite has started (or failed to), and the lines saying where. Each request is its
 * route's Effect program, run with the services below this layer (the archive, the AI service, the viewer's
 * connection, the modules' services), never on the ManagedRuntime itself, which refuses to run
 * anything once its disposal has begun: a request while the live connectors stop is still answered. As it stops, it
 * stops listening and ends its connections (each change stream with its page's), then Vite closes (its hot reload's
 * sockets with it), then the server has closed.
 */
const Http = Layer.effectDiscard(
  Effect.gen(function* () {
    const { folder, host, port, hosts, settings } = yield* ServerSettings;
    const stores = yield* LoadedModules;
    const { modules, events } = yield* ReadyModules;
    const api = yield* handler(viewerRoute(moduleTabs(stores)));
    // The tables' edits (server/edits/), each handed to its row's owner, kept in the core's record; 503 with no archive.
    const opened = (yield* OpenArchive).archive;
    const edits = yield* handler(editsRoute(opened instanceof Error ? opened : tableEditsOf(opened, tabsWith(moduleTabs(stores)), events)));
    const sources = yield* handler(sourcesRoute(folder));
    const content = yield* handler(contentRoute());
    // The main branch's preview (mainPreview.ts): a built demo's files in the archive's folder, read and nothing else.
    const mainPreview = yield* handler(mainPreviewRoute(join(folder, MAIN_PREVIEW_FOLDER)));
    // The agents' MCP door (server/mcp/): the core's tools and the modules', run with the same services as the routes.
    const { archive } = yield* OpenArchive;
    const mcp = mcpDoor(buildDoor({
      archive,
      modules,
      off: [...stores.off, ...stores.broken].map((m) => m.id),
      tabs: tabsWith(moduleTabs(stores)),
      owner: settings.owner.name === DEFAULT_OWNER ? null : settings.owner.name,
      context: yield* Effect.context<never>(),
    }));
    // Each module's routes, at MODULES_API/<id> and under it, with the same services as the core's.
    const moduleHandlers = new Map<string, ApiHandler>();
    for (const module of modules) {
      if (module.definition.routes) moduleHandlers.set(module.id, yield* moduleHandler(module));
    }
    // And at the paths outside MODULES_API they mount it at (friend map's contract at /api/archive, its page's API).
    // A module that loaded but whose database could not open answers its paths 503, saying why (friend map's contract
    // while the archive's folder is missing).
    const unavailable = stores.broken.flatMap(({ id, problem, paths }) =>
      (paths ?? []).map((path) => ({ path, handler: async (_req: unknown, res: ServerResponse) => sendJson(res, 503, { error: `${id} is not available: ${problem}` }) })));
    const mounts = [...moduleMounts(modules).map(({ path, id }) => ({ path, handler: moduleHandlers.get(id)! })), ...unavailable];
    // The pages the modules serve in a frame (friend map's friend-map page), each by a Vite of its own, once started.
    const modulePages = modules.flatMap((m) => (m.definition.page ? [{ ...m.definition.page, plugins: m.definition.page.plugins?.(folder) ?? [] }] : []));
    const started = new Map<string, ViteDevServer | Error | null>(modulePages.map((page) => [page.path, null]));
    const pageSettings = yield* handler(pageSettingsRoute({
      timeZone: settings.timeZone,
      locale: settings.locale,
      modules: moduleSwitches(stores),
      moduleSettings: moduleViewerSettings(modules),
    }));
    // The viewer's page, once Vite has started (below); the archive's routes never wait for it, nor fail with it.
    let vite: ViteDevServer | Error | null = null;
    /** Done once it has stopped listening and its last connection has ended, when it listened at all. */
    let closed: Deferred.Deferred<void> | null = null;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        archiveServer({
          hosts,
          viewer: {
            mounts,
            pages: modulePages.map(({ path }) => ({
              path,
              page: (req, res) => {
                const vite = started.get(path);
                if (vite === null || vite === undefined || vite instanceof Error) return sendJson(res, 503, { error: `the page at ${path}/ is not available${vite ? `: ${vite.message}` : " yet"}` });
                vite.middlewares(req, res);
              },
            })),
            api,
            modules: moduleRoutes(moduleHandlers),
            sources,
            content,
            edits,
            settings: pageSettings,
            mcp,
            mainPreview,
            page: (req, res) => {
              if (vite === null || vite instanceof Error) return sendJson(res, 503, { error: `the viewer's page is not available${vite ? `: ${vite.message}` : " yet"}` });
              vite.middlewares(req, res);
            },
          },
        }),
      ),
      () => (closed ? Deferred.await(closed) : Effect.void),
    );
    vite = yield* Effect.acquireRelease(startVite(server, hosts), (started) => (started instanceof Error ? Effect.void : Effect.promise(() => started.close())));
    for (const page of modulePages) {
      started.set(page.path, yield* Effect.acquireRelease(Effect.promise(() => startModulePage(server, page, hosts)), (vite) => (vite instanceof Error ? Effect.void : Effect.promise(() => vite.close()))));
    }
    yield* Effect.acquireRelease(
      listen(server, port, host).pipe(
        Effect.tapError((error) => Effect.sync(() => console.error(`The archive's server could not start on ${host}:${port}:`, error.message))),
      ),
      () =>
        Effect.sync(() => {
          const done = (closed = Deferred.makeUnsafe<void>());
          server.close(() => Deferred.doneUnsafe(done, Effect.void));
          server.closeAllConnections();
        }),
    );
    console.log(`The archive's server running at http://${host}:${port}/life-archive/${modulePages.map((page) => `, and ${page.path}/`).join("")}`);
    console.log(`Archive directory: ${folder}`);
  }),
);

/**
 * Vite in middleware mode serves the page (vite.config.ts), its hot reload on this server too. Loaded here, not
 * imported, so a Vite that will not start (not installed, say) costs the viewer's page and nothing else.
 */
const startVite = (server: Server, hosts: readonly string[]): Effect.Effect<ViteDevServer | Error> =>
  Effect.promise(async () => {
    try {
      const { createServer: createViteServer } = await import("vite");
      return await createViteServer({
        configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
        server: { middlewareMode: true, ws: { server }, allowedHosts: [...hosts] },
      });
    } catch (error) {
      const failed = error instanceof Error ? error : new Error(String(error));
      console.error("The viewer's page is not available:", failed.message);
      return failed;
    }
  });

const listen = (server: Server, port: number, host: string): Effect.Effect<void, CouldNotListen> =>
  Effect.callback<void, CouldNotListen>((resume) => {
    const failed = (error: Error) => resume(Effect.fail(new CouldNotListen({ message: error.message })));
    server.once("error", failed);
    server.listen(port, host, () => {
      server.off("error", failed);
      resume(Effect.void);
    });
  });

/**
 * Live connectors (Telegram through the bridge rig, and the rest): each runs while it is switched on and its companion
 * answers, and otherwise waits quietly, saying so once (see connectors/sync.ts). Stopped first as the server stops.
 */
const Live = Layer.effectDiscard(
  Effect.gen(function* () {
    const { archive } = yield* OpenArchive;
    if (archive instanceof Error) return;
    yield* Effect.acquireRelease(
      Effect.sync(() => archive.startLive((line) => console.log(`[live] ${line}`))),
      () => Effect.promise(() => archive.stopLive()),
    );
  }),
);

/** The server: each layer below is built before the ones above it, and closed after them. */
export const serverLayer = Live.pipe(
  Layer.provideMerge(Http),
  Layer.provideMerge(ModuleWork),
  Layer.provideMerge(ModuleServices),
  Layer.provideMerge(Viewer),
  Layer.provideMerge(Ai),
  Layer.provideMerge(ReadyModules.layer),
  Layer.provideMerge(ArchiveLayer),
  Layer.provideMerge(PruneBackups),
  Layer.provideMerge(LoadedModules.layer),
  Layer.provideMerge(ServerSettings.layer),
);
