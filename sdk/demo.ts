// The static demo's backend, as both its pages have it (the console's, viewer/demo/, and friend-map's,
// modules/friend-map/page/demo/; docs/demo.md): plain files on a site with no server behind them, answering every route
// the pages ask as the archive's server would, from the made-up testing data alone. Two kinds of answer:
//
//   recorded  the real server's own answer, recorded as the demo was built (tools/demo/record.ts): every route whose
//             questions can all be asked beforehand (the settings, Health, an activity, a person's panel). Each is a
//             file of its own under DEMO_DATA/answers/, named by its question (answerKey, answerFile); a route that
//             answers a file (a map's tile, a kept image) is kept at its own path instead, as a static file.
//   live      the server's own code, run in the page over the made-up databases (DemoDatabase, over SQLite compiled to
//             WebAssembly): the routes whose questions are open (the Events tables' filters, a chat's pages), each a
//             LiveRoute the page's demo entry gives.
//
// Nothing writes: anything but a GET is refused with READ_ONLY. A question with neither answer is "not in the demo"
// (404), which the pages show as they show any route that has nothing.
//
// The pages reach it by the browser's own fetch, which installDemoBackend replaces, so not one view or panel knows it
// is in the demo: what it is shown is what the server would show it, over the same made-up data.
//
// A demo built for a mount (viewer/mount.ts: the main preview, under the archive's own server) has its site under
// SITE: its pages ask their routes there, and its files are fetched there. The answers were recorded at the server's
// own paths, so a question is looked up with SITE taken off; and a route asked at the server's own path (outside
// SITE) is answered by the demo all the same, so no question ever reaches the server the preview is served by. Its
// pages share their origin with that server's console, so they keep their own storage too (ownStorage).

import type { BindParams, Database, SqlJsStatic, SqlValue } from "sql.js";
import type { EventOwner } from "../server/calendar/owners.ts";
import { STATUS } from "../server/errors.ts";
import type { Tab } from "../server/viewer/tab.ts";
import { SITE } from "../viewer/mount.ts";

/** Where the build puts the recorded answers and the databases, on the demo's site (under SITE, when it has one). */
export const DEMO_DATA = "/demo-data";

/** The paths the demo answers for, on its site: the archive's routes as the console asks them, and friend-map's page's. */
export const DEMO_API_PATHS = ["/life-archive/api/", "/friend-map/api/"] as const;

/** `pathname` on the demo's site: SITE taken off (`site`), as the server answered it; any other as it is. */
export function onSite(pathname: string, site: string = SITE): string {
  return site !== "" && (pathname === site || pathname.startsWith(`${site}/`)) ? pathname.slice(site.length) || "/" : pathname;
}

/** What a change is answered with: the demo is read-only. */
export const READ_ONLY = "This is the demo, on made-up data: it is read-only, so nothing here can be changed.";

/** What a question the demo has no answer for is answered with. */
export const NOT_IN_DEMO = "not in the demo: it answers what the made-up data has, and this asks for something else";

/** A question, as the recorder files its answer and the page looks it up: the method, the path and the query, its pairs sorted. */
export function answerKey(method: string, url: URL): string {
  const pairs = [...url.searchParams].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const query = new URLSearchParams(pairs).toString();
  return `${method.toUpperCase()} ${url.pathname}${query ? `?${query}` : ""}`;
}

/** The file a recorded answer is kept in, under DEMO_DATA: named by a hash of its question (cyrb53, 53 bits). */
export function answerFile(key: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `answers/${hash.toString(16).padStart(14, "0")}.json`;
}

/** A recorded answer as its file holds it: the server's status and its JSON. */
export interface RecordedAnswer {
  status: number;
  body: unknown;
}

/** A database the page's live routes read: one of the made-up folder's, as the build copied it (DEMO_DATA/db/<name>.gz). */
export type DemoDatabaseName = string;

/** What a live route is given: the made-up databases, each opened the first time it is asked for, and the recorded answers. */
export interface DemoContext {
  database: (name: DemoDatabaseName) => Promise<DemoDatabase>;
  /** The server's recorded answer to a GET of `path` (with its query), or null when it recorded none. */
  recorded: (path: string) => Promise<RecordedAnswer | null>;
}

/**
 * A route the page answers itself, with the server's own code over the made-up databases: `answer` gives the JSON the
 * server would send, or throws what the server's code throws (a route error, server/errors.ts, answered with its
 * status as the server answers it), or `undefined` to leave the question to the recorded answers.
 */
export interface LiveRoute {
  /** What it answers, by path (and method, GET when left out). */
  matches: (url: URL) => boolean;
  answer: (url: URL, context: DemoContext) => Promise<unknown>;
}

/**
 * A module's half of the demo (its demo.ts, found by its place, modules/<id>/demo.ts, as its viewer.tsx is): what the
 * console's demo runs of the module's server in the page. Every route it does not answer here is answered from the
 * recorded answers.
 */
export interface ModuleDemo {
  /**
   * The connection its tables read (the Events page's Tables, over tab.ts's Reads.modules): its database as the build
   * copied it (modules/<id>/<file>, its module.ts's `database`), opened as its viewer's connection is (its `reads`).
   */
  readonly tablesRead?: (context: DemoContext) => Promise<import("node:sqlite").DatabaseSync>;
  /** Its tables (sdk/server.ts's `tabs`), as the Events page's Tables opens them: the same list as its module.ts's. */
  readonly tabs?: readonly Tab[];
  /** Its answers for its calendar rows (sdk/server.ts's `events`), over the made-up databases. */
  readonly owner?: (context: DemoContext) => Promise<EventOwner>;
  /** Routes of its own the console's demo answers live. */
  readonly routes?: readonly LiveRoute[];
}

/** A module's demo.ts declares its half of the demo with this. */
export const defineDemo = (demo: ModuleDemo): ModuleDemo => demo;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** A route error's status, as the server's routes answer it (server/errors.ts's STATUS); null for anything else. */
function statusOf(error: unknown): number | null {
  const tag = (error as { _tag?: unknown } | null)?._tag;
  return typeof tag === "string" && tag in STATUS ? STATUS[tag as keyof typeof STATUS] : null;
}

/** Where the build keeps a copied database `name` (gzipped), under DEMO_DATA. */
export const databaseFile = (name: DemoDatabaseName): string => `db/${name}.gz`;

/** Bytes as they were before gzip: a site may already have taken it off on the way (its own Content-Encoding). */
async function gunzipped(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

/**
 * Replaces the page's fetch with the demo's backend (see the top): the routes under DEMO_API_PATHS answered live (the
 * routes `routes` gives over the demo's context) or from the recorded answers, every other address (the page's own
 * files) fetched as before. `sqlite` loads SQLite for the databases the live routes read.
 */
export function installDemoBackend(routes: (context: DemoContext) => readonly LiveRoute[], sqlite: () => Promise<SqlJsStatic>): void {
  const fetchFile = globalThis.fetch.bind(globalThis);
  if (SITE !== "") ownStorage(SITE);
  const recorded = async (path: string, signal?: AbortSignal): Promise<RecordedAnswer | null> => {
    const question = new URL(path, globalThis.location.origin);
    question.pathname = onSite(question.pathname);
    const kept = await fetchFile(`${SITE}${DEMO_DATA}/${answerFile(answerKey("GET", question))}`, { signal });
    return kept.ok && /json/.test(kept.headers.get("content-type") ?? "") ? ((await kept.json()) as RecordedAnswer) : null;
  };
  const opened = new Map<string, Promise<DemoDatabase>>();
  const open = async (name: string): Promise<DemoDatabase> => {
    const response = await fetchFile(`${SITE}${DEMO_DATA}/${databaseFile(name)}`);
    if (!response.ok) throw new Error(`the demo's ${name} could not be fetched (${response.status})`);
    const bytes = await gunzipped(new Uint8Array(await response.arrayBuffer()));
    return new DemoDatabase(new (await sqlite()).Database(bytes));
  };
  const context: DemoContext = {
    database: (name) => {
      let database = opened.get(name);
      if (!database) opened.set(name, (database = open(name)));
      return database;
    },
    recorded,
  };
  const live = routes(context);
  const answer = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return json(403, { error: READ_ONLY });
    for (const route of live) {
      if (!route.matches(url)) continue;
      try {
        const body = await route.answer(url, context);
        if (body !== undefined) return json(200, body);
      } catch (error) {
        const status = statusOf(error);
        if (status === null) throw error;
        return json(status, { error: (error as Error).message });
      }
      break;
    }
    const kept = await recorded(`${url.pathname}${url.search}`, request.signal);
    if (kept) return json(kept.status, kept.body);
    // No recorded answer: a file kept at its own path (a tile, an image), or nothing.
    const file = await fetchFile(url, { signal: request.signal });
    if (file.ok) return file;
    console.info(`The demo has no answer for GET ${url.pathname}${url.search}`);
    return json(404, { error: NOT_IN_DEMO });
  };
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : new URL(input, globalThis.location.href), init);
    const url = new URL(request.url);
    const path = onSite(url.pathname);
    if (url.origin !== globalThis.location.origin || !DEMO_API_PATHS.some((api) => path.startsWith(api))) return fetchFile(input, init);
    // A route asked at the server's own path is asked on the demo's site: never of the server the demo is served by.
    if (path === url.pathname && SITE !== "") {
      url.pathname = `${SITE}${path}`;
      return answer(new Request(url, request));
    }
    return answer(request);
  };
}

/**
 * Keeps the page's localStorage apart under `prefix` (a mounted demo's SITE): the page shares its origin with the
 * console of the server it is served by, whose look, rail order and folded sections are kept there under the same
 * names, so the demo's are kept under its own and neither changes the other's.
 */
export function ownStorage(prefix: string): void {
  let shared: Storage;
  try {
    shared = globalThis.localStorage;
  } catch {
    return; // No storage at all (blocked): the pages already go on without it.
  }
  const mine = (key: string) => `${prefix}:${key}`;
  const keys = () => Array.from({ length: shared.length }, (_, i) => shared.key(i)).filter((key): key is string => key?.startsWith(`${prefix}:`) ?? false);
  const own: Storage = {
    get length() {
      return keys().length;
    },
    key: (index) => keys()[index]?.slice(prefix.length + 1) ?? null,
    getItem: (key) => shared.getItem(mine(key)),
    setItem: (key, value) => shared.setItem(mine(key), value),
    removeItem: (key) => shared.removeItem(mine(key)),
    clear: () => keys().forEach((key) => shared.removeItem(key)),
  };
  Object.defineProperty(globalThis, "localStorage", { value: own, configurable: true, writable: true });
}

type Value = SqlValue | bigint | undefined;

/** node:sqlite's bound values as SQLite in the page takes them: named ones under each of their prefixes. */
function bindings(params: readonly Value[]): BindParams | undefined {
  if (params.length === 0) return undefined;
  const [first] = params;
  if (params.length === 1 && first !== null && typeof first === "object" && !(first instanceof Uint8Array)) {
    const named: Record<string, SqlValue> = {};
    for (const [key, value] of Object.entries(first as Record<string, Value>)) {
      for (const prefix of [":", "$", "@"]) named[`${prefix}${key}`] = plain(value);
    }
    return named;
  }
  return params.map(plain);
}

const plain = (value: Value): SqlValue => (typeof value === "bigint" ? Number(value) : value === undefined ? null : value);

/** One statement, as node:sqlite's StatementSync has it: run afresh each time, its rows as objects (or arrays). */
class DemoStatement {
  private arrays = false;
  private readonly db: Database;
  private readonly sql: string;

  constructor(db: Database, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  setReturnArrays(on: boolean): void {
    this.arrays = on;
  }

  *iterate(...params: Value[]): Generator<unknown> {
    const statement = this.db.prepare(this.sql);
    try {
      const bound = bindings(params);
      if (bound !== undefined) statement.bind(bound);
      while (statement.step()) yield this.arrays ? statement.get() : statement.getAsObject();
    } finally {
      statement.free();
    }
  }

  all(...params: Value[]): unknown[] {
    return [...this.iterate(...params)];
  }

  get(...params: Value[]): unknown {
    for (const row of this.iterate(...params)) return row;
    return undefined;
  }

  run(...params: Value[]): { changes: number; lastInsertRowid: number } {
    this.all(...params);
    return { changes: this.db.getRowsModified(), lastInsertRowid: Number(this.db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] ?? 0) };
  }
}

/**
 * A made-up database in the page, as node:sqlite's DatabaseSync has it for the server's reads: prepare, exec and
 * function (a SQL function of the page's). Handed to the server's code where it takes a DatabaseSync (`sync`).
 */
export class DemoDatabase {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  prepare(sql: string): DemoStatement {
    return new DemoStatement(this.db, sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  function(name: string, ...rest: [unknown, ((...args: never[]) => unknown)?]): void {
    const fn = (typeof rest[0] === "function" ? rest[0] : rest[1]) as (...args: SqlValue[]) => SqlValue;
    this.db.create_function(name, fn);
  }

  close(): void {
    this.db.close();
  }

  /** This database as the server's code takes one: what it calls of a DatabaseSync, this has. */
  get sync(): import("node:sqlite").DatabaseSync {
    return this as unknown as import("node:sqlite").DatabaseSync;
  }
}
