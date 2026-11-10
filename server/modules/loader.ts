// How the core finds and loads the modules (docs/modules.md; viewer/modules.ts is the page's half): each a folder
// modules/<id>/ in the checkout whose package.json says "lifeArchive": true, with module.ts, its server half
// (sdk/server.ts's defineModule), and viewer.tsx, its page half. The folder's name is the module's id.
//
// Which are on (src/pages.ts): a module this repository ships unfinished says `"lifeArchiveReady": false` in its
// package.json and is off unless switched on by name or settings.json's `"pages": "all"`; the rest (the ready ones, and
// a private module, which says nothing) are on. settings.json's `modules` switches one on or off by name ({"health": false}; docs/settings.md): off, it is listed but not loaded. A key
// naming no installed module is said so and switches nothing, as settings.json is every checkout's and may switch a
// private module another checkout has. A folder
// whose package.json cannot be read, a module whose module.ts cannot be imported, or which names another id than its
// folder or another SDK major than this core's, is broken: listed, said so, and skipped, as a broken connector manifest
// is (connectors/host.ts); its page half is not shown. So is one whose database cannot be opened (store.ts). The NAS
// backup, which loads them with `all`, stops on one that does not load instead (nasBackup.ts's moduleKept).
//
// The server loads the modules on (serverLayer.ts: their databases, their connectors with the archive's host, their
// services, then their routes at MODULES_API/<id>); the guard's review and the testing data load every installed one,
// switched off or not (`all`), and the written documents those git tracks, since a module's privacy lines and made-up
// data are about what the archive may hold, not what runs.
//
// What a module is given (moduleContext): the archive's folder, its database when it has one, and the running archive's
// calendar and live connectors (ModuleLive), which a module reaches only while the archive is open: before it, or when
// it could not be opened, each throws the archive's error, so a module's reads still answer and its writes say why not.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Layer } from "effect";
import { MODULES_API } from "../../viewer/wire.ts";
import {
  SDK_VERSION, type AnyModuleDefinition, type ModuleCalendar, type ModuleContext, type ModuleEvents, type ModuleLive, type ModulePrivacy, type ModuleStore as ModuleStoreContext,
} from "../../sdk/server.ts";
import type { EventOwner } from "../calendar/owners.ts";
import type { TableEditor } from "../edits/editor.ts";
import type { CalendarRow } from "../calendar/rows.ts";
import type { ConnectorLedger, RegisteredConnector } from "../connectors/host.ts";
import { REPO } from "../dataHome.ts";
import type { RouteError } from "../errors.ts";
import { handler, sendJson, type ApiHandler, type Route } from "../jsonApi.ts";
import { pageOn, type PageChoice } from "../../src/pages.ts";
import type { Tab } from "../viewer/tab.ts";
import { moduleDatabaseFile, type ModuleStore, type ModuleStores } from "./store.ts";
import type { ModuleReads } from "../viewer/connection.ts";
import { installedModules, type BrokenModule, type InstalledModule } from "./installed.ts";

export { installedModules, MODULES_DIR, trackedModules, TRACKED_MODULES_ONLY, type BrokenModule, type FoundModule, type InstalledModule } from "./installed.ts";

/** A module loaded: what its module.ts declares. */
export interface LoadedModule extends InstalledModule {
  readonly definition: AnyModuleDefinition;
}

/** The modules, as the loader found them: loaded, switched off, and broken. */
export interface Modules {
  readonly on: readonly LoadedModule[];
  readonly off: readonly InstalledModule[];
  readonly broken: readonly BrokenModule[];
}

/**
 * A switch naming no installed module, said so: settings.json is every checkout's, so it may switch a module another
 * checkout has (a private module), and a value misspelled would otherwise switch nothing off without a word.
 */
function checkSwitches(switches: Readonly<Record<string, boolean>>, installed: readonly InstalledModule[]): void {
  const ids = new Set(installed.map((m) => m.id));
  const absent = Object.keys(switches).filter((id) => !ids.has(id));
  if (absent.length === 0) return;
  const have = installed.length === 0 ? "none is installed" : `the installed modules are ${installed.map((m) => m.id).join(", ")}`;
  console.error(`the settings' modules name ${absent.map((id) => `"${id}"`).join(", ")}, of a module this checkout does not have, so ${absent.length === 1 ? "it switches" : "they switch"} nothing here (${have}; docs/modules.md)`);
}

/**
 * Loads the modules installed under `root`: those on by `switches` (settings.json's `modules`), else by their ready mark
 * or `pages` (settings.json's, "all" for every one; src/pages.ts's pageOn), or every one with `all`. A module that
 * cannot be loaded is broken, not an error: the caller says so and goes on without it (but the
 * NAS backup, which stops: it cannot tell what the module keeps, nasBackup.ts's moduleKept).
 */
export async function loadModules({ root = REPO, switches = {}, pages = "ready", all = false, env = process.env }: { root?: string; switches?: Readonly<Record<string, boolean>>; pages?: PageChoice; all?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Modules> {
  const installed = installedModules(root, env);
  checkSwitches(switches, installed);
  const on: LoadedModule[] = [];
  const off: InstalledModule[] = [];
  const broken: BrokenModule[] = [];
  for (const module of installed) {
    // A package.json that cannot be read says nothing of its mark: unless switched off, the module is broken, and said so, rather than off.
    const wanted = "problem" in module ? switches[module.id] !== false : pageOn(module.ready, switches[module.id], pages);
    if (!all && !wanted) {
      off.push({ id: module.id, folder: module.folder });
      continue;
    }
    const loaded = "problem" in module ? module : await loadModule(module);
    if ("problem" in loaded) broken.push(loaded);
    else on.push(loaded);
  }
  return { on, off, broken };
}

/** Imports one module's module.ts and checks what it declares against its folder and this SDK. */
async function loadModule(module: InstalledModule): Promise<LoadedModule | BrokenModule> {
  const file = join(module.folder, "module.ts");
  let definition: unknown;
  try {
    definition = ((await import(pathToFileURL(file).href)) as { default?: unknown }).default;
  } catch (error) {
    return { ...module, problem: `${file} could not be loaded: ${(error as Error).message}` };
  }
  if (typeof definition !== "object" || definition === null || typeof (definition as AnyModuleDefinition).id !== "string") {
    return { ...module, problem: `${file} does not export a module (its default export is not defineModule's)` };
  }
  const declared = definition as AnyModuleDefinition;
  if (declared.id !== module.id) return { ...module, problem: `${file} says it is module "${declared.id}", but its folder is ${module.id}` };
  if (declared.sdk !== SDK_VERSION) return { ...module, problem: `${file} is written for SDK ${String(declared.sdk)}, and this life archive's SDK is ${SDK_VERSION}` };
  return { ...module, definition: declared };
}

/** Each module's switch as the page is told it (viewer/wire.ts's PageSettings): on, or off (switched off, or broken). */
export function moduleSwitches({ on, off, broken }: Modules): Record<string, boolean> {
  return Object.fromEntries([...on.map((m) => [m.id, true] as const), ...off.map((m) => [m.id, false] as const), ...broken.map((m) => [m.id, false] as const)]);
}

/**
 * What each module on tells its page as the page is told it (viewer/wire.ts's PageSettings' moduleSettings): its
 * `viewerSettings`, by its id. One that throws tells its page nothing, and `log` says why, rather than stop the server.
 */
export function moduleViewerSettings(modules: readonly LoadedModule[], log: (line: string) => void = console.error): Record<string, unknown> {
  const told: Record<string, unknown> = {};
  for (const { id, definition } of modules) {
    if (!definition.viewerSettings) continue;
    try {
      told[id] = definition.viewerSettings();
    } catch (error) {
      log(`[modules] ${id} tells its page nothing: ${(error as Error).message}`);
    }
  }
  return told;
}

/** A module with its store and what it is given: its context, the same object for its routes, services and hooks. */
export interface ReadyModule extends ModuleStore {
  readonly context: ModuleContext & ModuleLive & { readonly db?: unknown };
}

/** What the running archive lends the modules (ModuleLive), by module id; or the archive's error, while it is not open. */
export type Lending = ((id: string) => ModuleLive) | Error;

/**
 * Each loaded module with its context: the archive's folder, its database when it has one, and the archive's calendar
 * and live connectors from `lending`, which throw the archive's error while it is not open.
 */
export function readyModules(stores: ModuleStores, folder: string, lending: Lending): ReadyModule[] {
  return stores.on.map((store) => ({ ...store, context: moduleContext(store, folder, lending) }));
}

function moduleContext(store: ModuleStore, folder: string, lending: Lending): ReadyModule["context"] {
  const live: ModuleLive = lending instanceof Error ? notOpen(lending) : lending(store.id);
  const base: ModuleContext & ModuleLive = { folder, ...live };
  return store.db ? ({ ...base, db: store.db } satisfies ModuleStoreContext & ModuleLive) : base;
}

/** The archive's calendar and live connectors while the archive is not open: each use throws its error. */
function notOpen(error: Error): ModuleLive {
  const fail = (): never => {
    throw new Error(`the archive is not available: ${error.message}`);
  };
  const calendar: ModuleCalendar = { push: fail, replace: fail, forget: fail };
  return { calendar, pausingLive: fail, host: { statuses: fail, manifests: fail, sendingPlatforms: fail, sender: fail }, contentLog: { record: fail } };
}

/** The services every ready module offers, as one Layer (none: an empty one). */
export function moduleServices(modules: readonly ReadyModule[]): Layer.Layer<never> {
  return modules.flatMap((m) => (m.definition.services ? [m.definition.services(m.context) as Layer.Layer<never>] : [])).reduce((all, layer) => Layer.merge(all, layer), Layer.empty as Layer.Layer<never>);
}

/**
 * The work the ready modules do while the server runs (sdk/server.ts's `work`: rituals' watch on its store, Shopping's
 * morning pulls), each in a fiber of this Layer's scope, interrupted as the server stops. A module's work may yield the
 * services it offers itself, so this Layer is built above the modules' services (serverLayer.ts), which give them.
 */
export function moduleWork(modules: readonly ReadyModule[]): Layer.Layer<never> {
  const working = modules.flatMap((m) => (m.definition.work ? [{ id: m.id, run: (m.definition.work as (context: ReadyModule["context"]) => Effect.Effect<void>)(m.context) }] : []));
  return Layer.effectDiscard(Effect.forEach(working, (m) => Effect.forkScoped(m.run), { discard: true }));
}

/** What the NAS backup takes of each installed module's folder beyond a database the core opens (sdk/server.ts's `backup`), by module id. */
export function moduleBackups({ on }: Modules): Array<{ id: string; databases: readonly string[]; exclude: readonly string[] }> {
  return on.flatMap((m) => (m.definition.backup ? [{ id: m.id, databases: m.definition.backup.databases, exclude: m.definition.backup.exclude ?? [] }] : []));
}

/** Each module's privacy lines, in the modules' order. */
export function modulePrivacy({ on }: Modules): ModulePrivacy[] {
  return on.flatMap((m) => (m.definition.privacy ? [m.definition.privacy] : []));
}

/** Each ready module's answers for its calendar rows (sdk/server.ts's `events`), by module id, made once. */
export function moduleEvents(modules: readonly ReadyModule[]): Map<string, ModuleEvents> {
  return new Map(modules.flatMap((m) => (m.definition.events ? [[m.id, m.definition.events(m.context) as ModuleEvents] as const] : [])));
}

/** The calendar's owners among `events`, for the viewer's reads (server/calendar/owners.ts). */
export function moduleOwners(events: ReadonlyMap<string, ModuleEvents>): Map<string, EventOwner> {
  return new Map([...events].map(([id, own]) => [id, {
    labelPeople: (ids) => own.labelPeople(ids),
    detail: (kind, origin, nativeId) => own.detail(kind, origin, nativeId),
    hiddenPeople: (ids) => own.hiddenPeople?.(ids) ?? [],
  }]));
}

/** What each module would push into the calendar now, by module id, for the rebuild and the drift check (server/calendar/push.ts). */
export function moduleRows(events: ReadonlyMap<string, ModuleEvents>): Map<string, () => CalendarRow[]> {
  return new Map([...events].map(([id, own]) => [id, () => own.rows()]));
}

/** The tables the modules declare, in the modules' order, each saying whose it is (KindSpec's module). */
export function moduleTabs({ on }: Modules): Tab[] {
  return on.flatMap((m) => (m.definition.tabs ?? []).map((tab) => ({ ...tab, spec: { ...tab.spec, module: m.id } })));
}

/**
 * Each ready module's editors for its tables (sdk/server.ts's `edits`), made once: an editor for a table that is not
 * the module's own is refused, as only a table's owner edits it.
 */
export function moduleEditors(modules: readonly ReadyModule[]): TableEditor[] {
  return modules.flatMap((m) => {
    const editors = (m.definition.edits?.(m.context as never) ?? []) as readonly TableEditor[];
    const own = new Set((m.definition.tabs ?? []).map((tab) => tab.spec.kind));
    for (const editor of editors) if (!own.has(editor.table)) throw new Error(`the ${m.id} module gave an editor for the ${editor.table} table, which is not its own`);
    return editors;
  });
}

/** The connectors the modules declare, as the host registers them (server/connectors/host.ts), each in its module's ledger. */
export function moduleConnectors({ on }: Modules): RegisteredConnector[] {
  return on.flatMap((m) => (m.definition.connectors?.connectors ?? []).map(({ manifest, main }) => ({ id: manifest.id, main, manifest, loadError: null, ledger: m.id })));
}

/**
 * Each module's ledger for the host (server/connectors/host.ts): its database, where the host keeps its connectors' runs,
 * and how an import's events are applied to it; what the module's apply gives back is pushed into the calendar through
 * `push` once the transaction has committed.
 */
export function moduleLedgers(stores: ModuleStores, push: (module: string, rows: readonly CalendarRow[]) => void, { quiet = false }: { quiet?: boolean } = {}): Map<string, ConnectorLedger> {
  return new Map(
    stores.on.flatMap((store) => {
      const { connectors } = store.definition;
      if (!connectors || !store.db) return [];
      const db = store.db;
      const ledger: ConnectorLedger = {
        db,
        apply: (events, source) => {
          const { counts, rows, afterCommit } = connectors.apply(events, db, source);
          return {
            counts,
            afterCommit: () => {
              if (rows.length > 0) push(store.id, rows);
              // A dry run's (`quiet`) import tells the module nothing: its copy is no store of its.
              if (!quiet) afterCommit?.();
            },
          };
        },
        settings: () => connectors.settings?.(db) ?? {},
        before: (connector) => connectors.before?.(connector, db) ?? null,
      };
      return [[store.id, ledger] as const];
    }),
  );
}

/**
 * The privacy lines of the modules installed under `root`, switched off or not, of `only` those ids when given. It
 * fails closed: a module broken (one whose module.ts cannot be imported, say) has lines nobody can read, and what
 * holds them (the guard's review, the written documents) would otherwise go on without them counted, friend map's
 * messages, photos and hangout notes among them; so it throws, naming each.
 */
export async function installedPrivacy({ root = REPO, only }: { root?: string; only?: ReadonlySet<string> } = {}): Promise<ModulePrivacy[]> {
  const modules = await loadModules({ root, all: true });
  const wanted = (module: InstalledModule) => only === undefined || only.has(module.id);
  const broken = modules.broken.filter(wanted);
  if (broken.length > 0) {
    throw new Error(`the privacy lines of ${broken.length === 1 ? "a module" : `${broken.length} modules`} could not be read, so nothing that counts them can go on: ${broken.map((m) => `${m.id} (${m.problem})`).join("; ")}`);
  }
  return modulePrivacy({ ...modules, on: modules.on.filter(wanted) });
}

/** The id a request under MODULES_API names: /life-archive/api/m/health/anything is "health"; "" when none. */
export function moduleOf(pathname: string): string {
  return pathname.startsWith(`${MODULES_API}/`) ? pathname.slice(MODULES_API.length + 1).split("/")[0]! : "";
}

/**
 * A module's routes as node:http's handler, run with the services of the Effect that makes it (the server's Layer,
 * which provides every module's own services beside the core's): a route's own services, which its type names, are
 * among them, so its type is widened to the core's here, once.
 */
export const moduleHandler = (module: ReadyModule) => handler(module.definition.routes!(module.context) as Route<RouteError, never>);

/**
 * The modules' routes as one handler at MODULES_API: each request goes to the module its path names (`handlers`, by
 * id), and one naming no module answering, switched off or not there, is answered 404.
 */
export function moduleRoutes(handlers: ReadonlyMap<string, ApiHandler>): ApiHandler {
  return async (req, res) => {
    const id = moduleOf(new URL(req.url ?? "/", "http://localhost").pathname);
    const handler = handlers.get(id);
    if (handler) return handler(req, res);
    sendJson(res, 404, { error: id ? `no module ${id} answers here` : `a module's routes are under ${MODULES_API}/<module>` });
  };
}

/** A line saying what the loader found, for the server's log. */
export function modulesLine({ on, off, broken }: Modules): string {
  const parts = [
    on.length ? `on: ${on.map((m) => m.id).join(", ")}` : "none on",
    ...(off.length ? [`off: ${off.map((m) => m.id).join(", ")}`] : []),
    ...(broken.length ? [`broken: ${broken.map((m) => `${m.id} (${m.problem})`).join("; ")}`] : []),
  ];
  return `Modules ${parts.join("; ")}`;
}

/** How the viewer opens each on module's database for its tables (server/viewer/connection.ts), by id: its file and its own opener. */
export function moduleReads({ on }: ModuleStores, folder: string): Map<string, ModuleReads> {
  return new Map(on.flatMap((m) => (m.db && m.definition.database ? [[m.id, { file: moduleDatabaseFile(folder, m.id, m.definition.database), open: m.definition.database.reads }] as const] : [])));
}

/** The paths outside MODULES_API each on module's route answers too (sdk/server.ts's `mounts`), by the path. */
export function moduleMounts(modules: readonly ReadyModule[]): Array<{ path: string; id: string }> {
  return modules.flatMap((m) => (m.definition.routes ? (m.definition.mounts ?? []).map((path) => ({ path, id: m.id })) : []));
}

/** Who answers the command `name` (sdk/server.ts's `commands`): the first on module that names it, or none. */
export function moduleCommand(modules: readonly ReadyModule[], name: string): ReadyModule | undefined {
  return modules.find((m) => m.definition.commands?.names.includes(name));
}
