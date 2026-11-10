// The Journal page's routes (wire.ts says each), under the module's own address, on this Mac and on the tailnet with
// the rest of the viewer. They only read, and only inside the vault's Journals/ (journals.ts holds every path to it).
//
// The list of days is metadata (names and sizes) and is not logged. Everything else is the captain's journal, the
// most private content the archive keeps, and is read only as he opens it on the page: a day, a raw file of it (a
// transcript, the cleaner's edits) and a file of its assets (a recording, a picture), each kept in the trail of content
// reads (sdk/server.ts's ModuleLive.contentLog) as a viewer read before it is answered, a recording's ranges folding
// into one row as it plays and seeks. Who may ask is who may ask the viewer's other routes that answer content: a Host
// the door admits, the console's own page (fromOwnPage), and on the tailnet only the devices its ACL admits. No model
// reads a journal through them: nothing here hands a word to one.

import { Effect } from "effect";
import { ForbiddenError, fromOwnPage, InvalidInputError, NotFoundError, sendJson, sendRanged, settings, UnavailableError, type ModuleLive, type Route } from "../../../sdk/server.ts";
import { JOURNAL_API } from "../wire.ts";
import { findAsset, JournalPathError, listDays, openJournals, readDay, readRaw, type Journals } from "./journals.ts";

type RouteErrors = NotFoundError | InvalidInputError | ForbiddenError | UnavailableError;

/** A path's steps as names, each decoded; one that does not decode is refused. */
const decoded = (steps: readonly string[]): Effect.Effect<string[], InvalidInputError> =>
  Effect.try({ try: () => steps.map((step) => decodeURIComponent(step)), catch: () => new InvalidInputError("a step of the path is not a name") });

/** Runs a read of journals.ts: a refused or missing path answered 400 or 404, a file the server cannot read (iCloud's, not downloaded or not permitted) 503. */
const reading = <A>(read: () => Promise<A>): Effect.Effect<A, InvalidInputError | NotFoundError | UnavailableError> =>
  Effect.tryPromise({
    try: read,
    catch: (error) => {
      if (error instanceof JournalPathError) return error.missing ? new NotFoundError(error.message) : new InvalidInputError(error.message);
      return new UnavailableError(`the journals could not be read: ${(error as Error).message}`);
    },
  });

/** The Journal page's routes over the vault in the archive's folder `dataDir` (settings' `vault.folder`), keeping each content read in `trail`. */
export function journalRoute(dataDir: string, trail: ModuleLive["contentLog"]): Route<RouteErrors, never> {
  return (req, res) =>
    Effect.gen(function* () {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== JOURNAL_API && !url.pathname.startsWith(`${JOURNAL_API}/`)) return yield* new NotFoundError(`the journal module answers only under ${JOURNAL_API}`);
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "the journals are only read here; Obsidian edits them" });
      yield* fromOwnPage(req);
      // A HEAD reads no content, so only a GET is kept in the trail.
      const read = (what: string, scope: Record<string, string>) => req.method === "GET" && trail.record({ surface: "viewer", reader: null, what, scope });
      const folder = settings().vault.folder;
      const journals: Journals | null = yield* reading(() => openJournals(dataDir, folder));
      // As the viewer's content routes answer while the archive is not open.
      if (!journals) return sendJson(res, 503, { error: `the vault has no Journals folder (${folder} in the archive's folder)` });
      const steps = url.pathname.slice(JOURNAL_API.length).split("/").slice(1);
      if (steps.length === 1 && steps[0] === "days") return sendJson(res, 200, yield* reading(() => listDays(journals)));
      if (steps[0] !== "days" || steps.length < 2) return yield* new NotFoundError(`no route GET ${url.pathname}`);
      const [day = "", part, ...rest] = yield* decoded(steps.slice(1));
      if (part === undefined) {
        const answer = yield* reading(() => readDay(journals, day));
        read("journal-day", { day });
        return sendJson(res, 200, answer);
      }
      if (part === "raw" && rest.length === 1) {
        const answer = yield* reading(() => readRaw(journals, day, rest[0]!));
        read("journal-raw", { day, file: rest[0]! });
        return sendJson(res, 200, answer);
      }
      if (part === "assets" && rest.length > 0) {
        const asset = yield* reading(() => findAsset(journals, day, rest));
        read("journal-asset", { day, file: rest.join("/") });
        return yield* Effect.promise(() =>
          sendRanged(req, res, asset.path, asset.size, {
            "content-type": asset.type,
            "content-disposition": "inline",
            "x-content-type-options": "nosniff",
            // Journal content: never kept in a cache, so a read is always one the trail saw.
            "cache-control": "no-store",
          }),
        );
      }
      return yield* new NotFoundError(`no route GET ${url.pathname}`);
    });
}
