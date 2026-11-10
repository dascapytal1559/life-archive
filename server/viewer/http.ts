// The viewer's read API, under /life-archive/api/ (the page is viewer/, served by Vite; server/archive/server.ts
// routes to both):
//
//   GET /life-archive/api/kinds                     -> KindsAnswer: every tab, its columns, filters and measures
//       (GET /life-archive/api/settings, what the page is told as it opens, is pageSettings.ts's, and answers with no archive)
//   GET /life-archive/api/:kind/rows?<filters>&offset=&limit=&sort=&dir=asc|desc&after= -> RowsAnswer: a page of rows
//       (after: the page before's RowsAnswer.next, for a tab that pages by key)
//   GET /life-archive/api/:kind/volume?<filters>&grain=auto|day|week|month|year&measure=&split=&begins=HH:MM -> VolumeAnswer:
//       the chart (begins: when its days begin, midnight when left out)
//   GET /life-archive/api/:kind/facets?<filters>   -> FacetsAnswer: each filter's values, with how many rows have each
//   GET /life-archive/api/:kind/row?id=             -> RowDetail: one row, for its drawer
//   GET /life-archive/api/calendar/days?from=&to=&person= -> CalendarDaysAnswer: the calendar's day summaries over
//       [from, to) (days; calendarDays.ts): messages, whom he messaged, agent messages and rituals, a day each
//
// <filters> are viewer/wire.ts's filterParams: from and to (ms), person (an id), q (a search) and each choice filter's values. It
// only reads, and only metadata, on its own read-only connections (tab.ts's Reads: the archive, and the calendar,
// server/calendar/, which the tabs of events read); the tailnet reaches it through
// /life-archive, as it never reaches the archive's own routes (/api/archive/). The conversations a drawer opens, which
// read content, are content.ts's, under /life-archive/api/content/. 503 while the archive cannot be opened.
// A tab with a version (tab.ts) has its charts and facets kept until the version changes, so going back to a view
// answers at once. Each request is an Effect program run by the server with its services (jsonApi.ts's serve); what it
// answers is viewerAnswers', plain code over the reads, which the static demo runs in its page too (viewer/demo/).

import { Effect } from "effect";
import { ForbiddenError, InvalidInputError, NotFoundError } from "../errors.ts";
import { answering, fromOwnPage, sendJson, type Route } from "../jsonApi.ts";
import { API_BASE, CALENDAR_DAYS_API, readFilters, type FacetsAnswer, type KindsAnswer } from "../../viewer/wire.ts";
import { calendarDays, readDaysAsk } from "./calendarDays.ts";
import { ViewerDb } from "./connection.ts";
import { Memo } from "./memo.ts";
import type { Reads } from "./tab.ts";
import { choiceKeys, detailOf, facetsOf, readBegins, readGrain, rowsOf, tabOf, tabsWith, volumeOf, type Tab } from "./tabs.ts";

/**
 * What the viewer's routes answer (see the top), over the reads, for a GET of `url`: the JSON, or a route error thrown
 * (server/errors.ts). Each tab's charts and facets are kept in the memos this makes; `modules` are the loaded modules'
 * tables (server/modules/loader.ts's moduleTabs), after the core's own.
 */
export function viewerAnswers(modules: readonly Tab[] = []): (reads: Reads, url: URL) => unknown {
  const TABS = tabsWith(modules);
  const kept = new Map(TABS.map((tab) => [tab, new Memo(200)]));
  /** `work()`, kept for the tab's version under the request's route and query when the tab has one. */
  const keep = <T>(reads: Reads, tab: Tab, url: URL, work: () => T): T => {
    if (!tab.version) return work();
    const query = [...url.searchParams].sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
    return kept.get(tab)!.get(tab.version(reads), `${url.pathname} ${JSON.stringify(query)}`, work);
  };
  return (reads, url) => {
    const path = url.pathname.slice(API_BASE.length);
    if (path === "/kinds") return { kinds: TABS.map((tab) => tab.spec) } satisfies KindsAnswer;
    if (url.pathname === CALENDAR_DAYS_API) return calendarDays(reads, readDaysAsk(url.searchParams));
    const match = /^\/([a-z-]+)\/(rows|volume|facets|row)$/.exec(path);
    if (!match) throw new NotFoundError(`no viewer route ${url.pathname}`);
    const tab = tabOf(TABS, match[1]);
    const params = url.searchParams;
    if (match[2] === "row") return detailOf(reads, tab, params.get("id"));
    let filters;
    try {
      filters = readFilters(params, choiceKeys(tab));
    } catch (error) {
      throw new InvalidInputError((error as Error).message);
    }
    if (match[2] === "rows") {
      const direction = params.get("dir") ?? "desc";
      if (direction !== "asc" && direction !== "desc") throw new InvalidInputError("dir is asc or desc");
      return rowsOf(reads, tab, filters, {
        offset: whole(params.get("offset"), 0),
        limit: whole(params.get("limit"), 100),
        sort: params.get("sort") ?? tab.spec.sort,
        direction,
        after: params.get("after"),
      });
    }
    if (match[2] === "volume") {
      const ask = { grain: readGrain(params.get("grain")), measure: params.get("measure") ?? tab.spec.measures[0].key, split: params.get("split") || null, begins: readBegins(params.get("begins")) };
      return keep(reads, tab, url, () => volumeOf(reads, tab, filters, ask));
    }
    return { facets: keep(reads, tab, url, () => facetsOf(reads, tab, filters)) } satisfies FacetsAnswer;
  };
}

/** The viewer's routes, over its reads (ViewerDb), answering what viewerAnswers does for `modules`' tables and the core's. */
export function viewerRoute(modules: readonly Tab[] = []): Route<NotFoundError | InvalidInputError | ForbiddenError, ViewerDb> {
  const answer = viewerAnswers(modules);
  return (req, res) =>
    Effect.gen(function* () {
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "the viewer only reads" });
      yield* fromOwnPage(req);
      const reads = (yield* ViewerDb).reads();
      if (reads instanceof Error) return sendJson(res, 503, { error: `the archive is not available: ${reads.message}` });
      sendJson(res, 200, answer(reads, new URL(req.url ?? "/", "http://localhost")));
    }).pipe(answering(NotFoundError, InvalidInputError, ForbiddenError));
}

/** A whole number in the query string, `fallback` when it is not there; NaN (refused by rowsOf) for anything else. */
function whole(text: string | null, fallback: number): number {
  if (text === null) return fallback;
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}
