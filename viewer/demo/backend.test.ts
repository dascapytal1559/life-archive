// The demo's live routes (backend.ts) answer as the server does: the same code runs on both sides, so what is held
// here is the page's SQLite (sql.js, through sdk/demo.ts's DemoDatabase) giving the server's code what node:sqlite
// gives it, over the testing data's crowd, for every table's rows (each sort, a page down), filters, charts (each
// grain, measure and split) and drawers, the calendar's days, the chat a Messages row opens and the Inspirations
// page's reads. And that the demo's tables are the modules' own.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DemoDatabase, type DemoContext, type LiveRoute } from "../../sdk/demo.ts";
import { REPO } from "../../server/dataHome.ts";
import { loadModules } from "../../server/modules/loader.ts";
import type { FacetsAnswer, KindsAnswer, RowsAnswer } from "../wire.ts";
import { consoleRoutes, MODULE_DEMOS } from "./backend.ts";

let folder: string;
let SQL: SqlJsStatic;

/** A context over the made-up folder's databases: node:sqlite's (the server's) or sql.js's (the page's). */
function contextOf(open: (file: string) => DemoDatabase["sync"]): DemoContext {
  const opened = new Map<string, Promise<DemoDatabase>>();
  return {
    database: (name) => {
      if (!opened.has(name)) opened.set(name, Promise.resolve({ sync: open(join(folder, name)) } as DemoDatabase));
      return opened.get(name)!;
    },
    recorded: async () => null,
  };
}

interface Side {
  routes: readonly LiveRoute[];
  context: DemoContext;
}

const sideOf = (open: (file: string) => DemoDatabase["sync"]): Side => {
  const context = contextOf(open);
  return { routes: consoleRoutes(context), context };
};
const serverSide = () => sideOf((file) => new DatabaseSync(file, { readOnly: true }));
const pageSide = () => sideOf((file) => new DemoDatabase(new SQL.Database(readFileSync(file))).sync);

/** What `side` answers for `path`, as the demo's backend would: its JSON, or the route error it throws. */
async function answer({ routes, context }: Side, path: string): Promise<unknown> {
  const url = new URL(path, "http://demo.invalid");
  const route = routes.find((r) => r.matches(url));
  if (!route) throw new Error(`no live route for ${path}`);
  try {
    return await route.answer(url, context);
  } catch (error) {
    return { thrown: (error as { _tag?: string })._tag ?? String(error), message: (error as Error).message };
  }
}

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), "life-archive-demo-test-"));
  execFileSync(process.execPath, ["--no-warnings", join(REPO, "server", "fixtures", "testing-data.ts"), join(folder, "crowd"), "--crowd"], { stdio: "ignore" });
  folder = join(folder, "crowd");
  SQL = await initSqlJs();
  // Rituals' drawers read rituals' view from its recorded answer: none here, on both sides alike.
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ state: "unset", reason: "the test's" })));
}, 120_000);

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(join(folder, ".."), { recursive: true, force: true });
});

describe("the demo's live routes", () => {
  it("list the tables each module's module.ts lists", async () => {
    const { on } = await loadModules({ all: true });
    for (const module of on) {
      expect((MODULE_DEMOS.get(module.id)?.tabs ?? []).map((tab) => tab.spec.kind), module.id).toEqual((module.definition.tabs ?? []).map((tab) => tab.spec.kind));
    }
  });

  it("answer every table, the calendar's days, a chat and the Inspirations as the server's SQLite does", async () => {
    const server = serverSide();
    const page = pageSide();
    // The tables, as the server lists them (the Events page's /kinds is a recorded answer).
    const { viewerAnswers } = await import("../../server/viewer/http.ts");
    const { kinds } = viewerAnswers([...MODULE_DEMOS.values()].flatMap((demo) => demo.tabs ?? []))(undefined as never, new URL("http://demo.invalid/life-archive/api/kinds")) as KindsAnswer;
    expect(kinds.length).toBeGreaterThan(5);
    const paths: string[] = ["/life-archive/api/calendar/days?from=2026-10-01&to=2026-11-09", "/life-archive/api/inspirations", "/life-archive/api/inspirations/tags", "/life-archive/api/inspirations?q=garden&limit=5"];
    for (const spec of kinds) {
      const base = `/life-archive/api/${spec.kind}`;
      const facets = (await answer(server, `${base}/facets`)) as FacetsAnswer;
      const narrowed = spec.filters.flatMap((filter) => {
        const value = facets.facets[filter.key]?.[0]?.value;
        return value === undefined ? [] : [`${filter.kind === "person" ? "person" : filter.key}=${encodeURIComponent(value)}`];
      });
      for (const query of ["", "from=1788000000000&to=1792000000000", ...narrowed]) {
        const and = query ? `&${query}` : "";
        paths.push(`${base}/facets?${query}`, `${base}/rows?offset=0&limit=50${and}`, `${base}/rows?offset=40&limit=20&dir=asc${and}`);
        for (const grain of ["auto", "day", "week", "month", "year"]) paths.push(`${base}/volume?grain=${grain}${and}`);
        for (const measure of spec.measures) paths.push(`${base}/volume?measure=${measure.key}${and}`);
        for (const split of spec.splits) paths.push(`${base}/volume?split=${split}&begins=06:00${and}`);
      }
      for (const column of spec.columns.filter((c) => c.sortable)) paths.push(`${base}/rows?sort=${column.key}&dir=asc&limit=30`, `${base}/rows?sort=${column.key}&dir=desc&limit=30`);
      const rows = (await answer(server, `${base}/rows?limit=5`)) as RowsAnswer;
      for (const row of rows.rows) paths.push(`${base}/row?id=${encodeURIComponent(row.id)}`);
      if (spec.kind === "messages") for (const row of rows.rows) paths.push(`/life-archive/api/content/messages/${row.id}/chat`);
    }
    const wrong = ["/life-archive/api/nothing/rows", "/life-archive/api/messages/rows?dir=sideways", "/life-archive/api/calendar/days?from=x"];
    const refused: string[] = [];
    for (const path of [...paths, ...wrong]) {
      const theirs = await answer(server, path);
      expect(await answer(page, path), path).toEqual(theirs);
      if (typeof theirs === "object" && theirs !== null && "thrown" in theirs) refused.push(path);
    }
    // Every question asked is answered, but the wrong ones, which both refuse alike.
    expect(refused).toEqual(wrong);
    expect(paths.length).toBeGreaterThan(400);
  }, 300_000);
});
