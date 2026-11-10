// The tables' one edit route, under EDITS_API (viewer/editWire.ts says each path and shape): a row's editable fields,
// which cells of a page of rows stay as they are, an edit, an add or a delete of a row of the captain's own, an undo,
// the record, a people field's options and a note's words, over the registry (edits.ts), which
// hands each edit to the row's own owner. Every edit and undo is a JSON POST from the page itself (fromOwnPage), as
// every write of the viewer's is; the door's Host guard and the tailnet's ACL decide who may ask at all. A note's
// words are content, so reading one is kept in the trail. 503 while the archive is not open.

import { Effect } from "effect";
import { ForbiddenError, InvalidInputError, NotFoundError, UnavailableError } from "../errors.ts";
import { answering, fromOwnPage, readJson, sendJson, type Route } from "../jsonApi.ts";
import { EDITS_API, type EditsAnswer, type LocksAnswer, type NoteAnswer, type OptionsAnswer } from "../../viewer/editWire.ts";
import type { TableEdits } from "./edits.ts";

type RouteErrors = NotFoundError | InvalidInputError | UnavailableError | ForbiddenError;

/** A query parameter that must be there. */
const needed = (url: URL, key: string): string => {
  const value = url.searchParams.get(key);
  if (value === null || value === "") throw new InvalidInputError(`${key} is needed`);
  return value;
};

/** A whole number in the query, undefined when it is not there; NaN (refused by the registry) for anything else. */
const whole = (url: URL, key: string): number | undefined => {
  const value = url.searchParams.get(key);
  return value === null ? undefined : /^\d+$/.test(value) ? Number(value) : Number.NaN;
};

/** The edit route over `edits`, or the archive's error while it is not open. */
export function editsRoute(edits: TableEdits | Error): Route<RouteErrors, never> {
  return (req, res) =>
    Effect.gen(function* () {
      yield* fromOwnPage(req);
      if (edits instanceof Error) return sendJson(res, 503, { error: `the archive is not available: ${edits.message}` });
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.slice(EDITS_API.length);
      const method = req.method ?? "GET";
      const source = { surface: "app", who: null, why: null } as const;
      let match: RegExpExecArray | null;
      if (method === "GET") {
        if (path === "/row") return sendJson(res, 200, edits.state(needed(url, "kind"), needed(url, "id")));
        if (path === "/locks") {
          const ids = url.searchParams.get("ids") ?? "";
          return sendJson(res, 200, { rows: edits.locks(needed(url, "kind"), ids === "" ? [] : ids.split(",")) } satisfies LocksAnswer);
        }
        if (path === "" || path === "/") {
          const kind = url.searchParams.get("kind") ?? undefined;
          const id = url.searchParams.get("id") ?? undefined;
          if (id !== undefined && kind === undefined) throw new InvalidInputError("a row's edits are asked with its table's kind");
          return sendJson(res, 200, { edits: edits.list({ kind, id, limit: whole(url, "limit"), before: whole(url, "before") }) } satisfies EditsAnswer);
        }
        if (path === "/options") return sendJson(res, 200, { options: edits.options(needed(url, "kind"), needed(url, "field"), url.searchParams.get("q") ?? "") } satisfies OptionsAnswer);
        if (path === "/note") return sendJson(res, 200, { note: edits.note(needed(url, "kind"), needed(url, "id"), needed(url, "field")) } satisfies NoteAnswer);
        return yield* new NotFoundError(`no route GET ${url.pathname}`);
      }
      if (method !== "POST") return sendJson(res, 405, { error: "an edit is a POST; its fields, the record and a note are a GET" });
      if (path === "" || path === "/") {
        const body = yield* readJson(req);
        const { kind, id, field, value } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
        if (typeof kind !== "string" || typeof id !== "string" || typeof field !== "string" || !("value" in (body as object))) {
          throw new InvalidInputError("an edit is {kind, id, field, value}: the table, its row, the field and its new value");
        }
        return sendJson(res, 200, yield* edits.edit(kind, id, field, value, source));
      }
      if (path === "/add") {
        const body = yield* readJson(req);
        const { kind, values, anyway } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
        if (typeof kind !== "string") throw new InvalidInputError("an add is {kind, values}: the table, and the new row's fields by key");
        return sendJson(res, 200, yield* edits.add(kind, values, source, { anyway: anyway === true }));
      }
      if (path === "/delete") {
        const body = yield* readJson(req);
        const { kind, id } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
        if (typeof kind !== "string" || typeof id !== "string") throw new InvalidInputError("a delete is {kind, id}: the table, and the row");
        return sendJson(res, 200, yield* edits.remove(kind, id, source));
      }
      if ((match = /^\/(\d+)\/undo$/.exec(path))) return sendJson(res, 200, yield* edits.undo(Number(match[1]), source));
      return yield* new NotFoundError(`no route POST ${url.pathname}`);
    }).pipe(answering(NotFoundError, InvalidInputError, UnavailableError, ForbiddenError));
}
