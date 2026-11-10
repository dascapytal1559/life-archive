// The archive's HTTP API, mounted under /api/archive (types in src/archive.ts).
//
// Structure (never message text):
//   GET  /api/archive/contract                    -> Contract: the handshake (friend-map's docs/contract.md): the contract
//                                                 version served, its capabilities (SERVED; never friend-map's own
//                                                 `scores`) and the time zone days are counted in
//   GET  /api/archive/people?query=&tag=&reachOut=1&location=
//                                                 -> PeopleListing (reachOut=1: only those to reach out to;
//                                                 location=: only those with that value, matched but for case)
//   GET  /api/archive/people/:id                  -> PersonSummary (404 once merged away)
//   POST /api/archive/people                      {name, location?, tags?, note?, anyway?} -> PersonAdded: someone
//                                                 added by hand, with no accounts, as one changeset (the page's chip
//                                                 undoes it); when someone already goes by that name or alias and
//                                                 anyway is not true, nobody is added and they are in sameName
//   PUT  /api/archive/people/:id/names            {names: string[]} -> PersonSaved: every name they go by, in order
//                                                 (the first their name and label, the rest their aliases; at least
//                                                 one), the person panel's chips saved, with its changeset, so the
//                                                 page can offer to undo it
//   PUT  /api/archive/people/:id/tags             {tags: string[]} -> TagsSaved: {person: PersonSummary, changeset:
//                                                 the changeset it made, or null when it changed nothing, created and
//                                                 deleted: the tags it added to the tag table or deleted, as nobody
//                                                 had them}, so the page can offer to undo an archive or a tag made
//                                                 or deleted
//   PUT  /api/archive/people/:id/note             {note} -> PersonSummary ("" for none)
//   PUT  /api/archive/people/:id/should-reach-out {shouldReachOut: boolean} -> PersonSummary
//   GET  /api/archive/people/:id/drafts           -> Draft[]: the messages the captain is writing to them, the first first
//   POST /api/archive/people/:id/drafts           {text} -> Draft | null: a new draft (null, and none kept, when empty)
//   PUT  /api/archive/drafts/:id                  {text} -> Draft | null: its text now; emptied, it is deleted (null).
//                                                 Drafts are his scratch space (drafts.ts): no changeset, and no
//                                                 `people` event
//   DELETE /api/archive/drafts/:id                -> 204
//   PUT  /api/archive/people/:id/location         {location: string | null} -> PersonSaved: {person: PersonSummary,
//                                                 changeset: the changeset it made, or null when it changed nothing}
//                                                 (null or "" for not said), so the page can offer to undo it
//   PUT  /api/archive/people/:id/identicon        {seed, hue} -> PersonSaved: their identicon drawn from seed (16 hex
//                                                 digits) in hue (whole degrees 0 to 359, null for the seed's own), the
//                                                 icon picker's draft saved, with its changeset, so the page can offer
//                                                 to undo it
//   POST /api/archive/people/:id/merge            {with: personId} -> PersonSummary of :id, which is kept
//   POST /api/archive/people/:id/accounts/:accountId/detach -> PersonSummary of :id ("Not them")
//   GET  /api/archive/catch-ups?person=           -> CatchUp[]: every catch-up (or the person's), the latest first,
//                                                 each with everyone at it
//   POST /api/archive/catch-ups                   {day, time, trip, hours, note, personIds, others} -> CatchUpSaved:
//                                                 a new catch-up, time in person, and its changeset, so the page can
//                                                 offer to undo it; byCall true, from when one could be by call, is
//                                                 refused (a call is logged as a call: POST /calls); trip ({lastDay, endTime,
//                                                 privateFrom, privateTo}, null or left out for a single day) makes it a
//                                                 trip over several days, from day at time to lastDay at endTime, its
//                                                 hours worked out (tripHours)
//   PUT  /api/archive/catch-ups/:id               {day, time, trip, hours, note, personIds, others} -> CatchUpSaved, as
//                                                 POST takes it
//   DELETE /api/archive/catch-ups/:id             -> CatchUpSaved, with catchUp null
//   POST /api/archive/catch-ups/:id/call          {people, day, time, minutes, note, others} -> ManualCallSaved: the catch-up
//                                                 made a logged call (it goes, the call comes), as one changeset; its
//                                                 unnamed others go with it unless others says
//   GET  /api/archive/calls                       -> ListedCall[]: every call with anyone, from every source, one each
//                                                 however many were on it, newest first, with its note (the Time river's calls)
//   PUT  /api/archive/call-notes                  {call: CallRef, note} -> CallNoteSaved: a call's note set, or taken
//                                                 away (empty); with its changeset
//   PUT  /api/archive/call-answered               {call: CallRef, answered: "answered" | "missed" | "unknown"} ->
//                                                 CallAnsweredSaved: whether an imported call was answered, as the
//                                                 captain says (its source's again when the same); with its changeset
//   POST /api/archive/calls                       {people: [{personId, accountId, app}], day, time, minutes, note, others} -> ManualCallSaved: a
//                                                 call the captain logs with one or more people (manualCalls.ts), and how
//                                                 many more were on it unnamed (left out: none), the first's as their
//                                                 calls list it, and its changeset
//   GET  /api/archive/calls/:id                   -> LoggedCall: logged call :id's group, everyone on it, to change it
//   PUT  /api/archive/calls/:id                   {people, day, time, minutes, note, others} -> ManualCallSaved: its whole
//                                                 group changed (others left out: as it was)
//   DELETE /api/archive/calls/:id                 -> ManualCallSaved, with call null: its whole group deleted
//   POST /api/archive/calls/:id/catch-up          {day, time, hours, note, personIds, others} -> CatchUpSaved:
//                                                 the logged call's whole group made a catch-up, as one changeset
//   PUT  /api/archive/messages/:id/call-length    {minutes: number | null} -> CallLengthSaved: a call whose app
//                                                 does not say how long it was given its length in whole
//                                                 minutes, or that taken away (null); with its changeset
//   GET  /api/archive/tags                        -> TagInfo[]: every tag, in the captain's order, with how many have it
//   POST /api/archive/tags                        {name} -> TagsChanged: {tags: TagInfo[] after, changeset}: a new
//                                                 tag, last
//   PUT  /api/archive/tags/:name                  {name} -> TagsChanged: renamed for everyone; onto a tag that
//                                                 exists, the two are merged into that one
//   PUT  /api/archive/tags/:name/position         {position} -> TagsChanged: moved in the order (0 first)
//   DELETE /api/archive/tags/:name                -> TagsChanged: taken from everyone and gone
//                                                 ("archive" and "keep" can't be renamed, merged into or deleted)
//   GET  /api/archive/locations                   -> LocationInfo[]: every location someone is at, the most
//                                                 people first, with how many are at each
//   PUT  /api/archive/locations/:name             {name} -> LocationInfo[]: renamed for everyone at it; onto another
//                                                 location someone is at, the two are merged into that one
//   GET  /api/archive/merge-proposals             -> MergeProposal[]
//   POST /api/archive/merge-proposals/:id/confirm -> PersonSummary of the person kept
//   POST /api/archive/merge-proposals/:id/reject  -> 204
//   GET  /api/archive/changes?limit=              -> ChangesetInfo[]: the change log, newest first (50 by default), each
//                                                 with its first few people; every edit above (PUT, POST, DELETE)
//                                                 is one changeset from the app (changes.ts), and the CLI's are there too
//   GET  /api/archive/changes/:id                 -> ChangesetInfo with everyone it touched
//   POST /api/archive/changes/:id/undo            {} -> ChangesetInfo of the undo, itself a changeset; 409 naming who
//                                                 when what it changed has changed since, or it was undone already
//   GET  /api/archive/events                      server-sent events: `people` whenever people change,
//                                                 here or from the CLI; `messages` when only what the
//                                                 messages add up to changed (new messages in a live chat)
//   GET  /api/archive/coverage                    -> CoverageReport
//   GET  /api/archive/relationships?q=&reveal=    -> RelationshipsReport: per person on the map (archived people only
//        counted) counts by sender, months, reactions and reopened conversations, each person's platforms, and
//        group-chat membership (for the map views); with reveal=archive, also the archived people the query
//        q (none: everyone) matches, whether the captain archived them or the rules did (the map's Hide)
//   GET  /api/archive/message-apps                -> MessageApps[]: everyone's messages (archived people too) by app
//        and local month, counted as the map views count them (the Time river's App filter)
//   GET  /api/archive/table-rows                 -> TableRow[]: everyone, archived people too, one light row each for
//        the Table view, with when they were added and first in touch (firstContact.ts), without closeness, which
//        friend-map adds (server/methodology.ts answers /api/archive/table)
//   GET  /api/archive/score-report               -> ScoreReport: what friend-map works out closeness and activity from
//        (everyone's messages by month, the group chats, the catch-ups and the calls). It and /table-rows carry an ETag,
//        and answer 304 to an If-None-Match naming it, so friend-map keeps a copy until the archive changes
//   GET  /api/archive/map-facts                  -> MapFacts: the counts, times and person ids the static demo's shape is
//        worked out from (friend-map's server/demo-shape.ts), never a name, a tag, a title or a message
//   GET  /api/archive/calendar/:month             -> CalendarMonth (month YYYY-MM): what each local day of it had, for
//        the Calendar view: each chat's messages (system messages, Marketplace and dropped chats left out), calls and
//        catch-ups (a trip on each of its days, with its hours that day), with everyone in each by person id and their tags
//        for Hide, and the first and last days with anything; 400 for anything but a month
//   GET  /api/archive/calendar/:day               -> CalendarDay (day YYYY-MM-DD): that day's catch-ups (a trip on each of
//        its days), calls and chats in time order, each chat with its messages that day, its first and
//        last, and what names it, and everyone in them; 400 for anything but a day
//   GET  /api/archive/connectors                  -> ConnectorStatus[], with each sync connector's live state
//   GET  /api/archive/people/:id/send-targets     -> SendTarget[]: the chats the composer in their panel can send into
//   GET  /api/archive/people/:id/calls?account=   -> PersonCall[]: their calls of known length (the phone's, Messenger's, Instagram's), newest
//                                                     first; with account=, only that account's of theirs
//   GET  /api/archive/people/:id/groups           -> PersonGroup[]: the group chats they are in (listed or wrote there),
//        with how many people, what they and the captain sent there, and the last message; the latest first; an
//        untitled one with the first few people in it, to name it by, and whether the captain unlinked them from it
//   PUT  /api/archive/people/:id/groups/:groupId/unlinked {unlinked: boolean} -> GroupUnlinkSaved: the group chat
//        connects them to nobody (true; they stay in it, and closeness still counts it) or again (false), the person
//        panel's break-link button, with its changeset (null when it changed nothing), so the page can offer to undo it
//   GET  /api/archive/groups/:id                  -> GroupChat: one group chat for its header in a person's panel: its
//        title, platform and size, everyone in it with what they sent there, and what came in when; 404 for a
//        direct or Marketplace chat
//   POST /api/archive/groups/:id/archive-untouched {people: personId[]} -> ArchivedUntouched: archives everyone in the
//        group who is untouched (People.untouched) and not archived, as one changeset, so the page's chip can undo it;
//        `people` is who the page showed it would archive, and when that is no longer who it is, 409 and nothing changes
//   GET  /api/archive/query?q=&hide=              -> QueryResult: the ids of everyone, archived people too, the query
//        matches (query.ts; or SQL, a SELECT run read-only in a process of its own with a time limit, sqlQuery.ts), and
//        how many of them have none of the hide tags (one hide= per tag; "archive" counts everyone archived), which the
//        map checks against its limit; 400 with what is wrong when it does not run
//   POST /api/archive/query/generate              {query, transcript} -> GeneratedQuery: a SQL query the model
//        writes from the transcript, new or changing `query`, checked to run and counted, with what it left out as the
//        note (queryWriter.ts); sends the model the views' and tables' columns, tag names, field values and counts, never
//        names, notes or messages; 409 when Codex is not running or signed in (saying which), or the model's query does
//        not run
//
// Content (message text; a stricter policy can be applied to this prefix alone). Every read here is kept in the
// trail of content reads (contentLog.ts), as the app's: a GET of an attachment's file, by its chat; a timeline, a
// chat's messages or day, and a search, each with what it read:
//   GET  /api/archive/content/people/:id/timeline?before=|after=&limit=&platform=&groups=1&marketplace=1&account=&count=1
//                                                  -> TimelinePage: one-to-one chats; what they said in group chats
//                                                     only with groups=1, Marketplace chats only with marketplace=1;
//                                                     up to 5000 a page, and `total` with count=1
//   GET  /api/archive/content/conversations/:id/messages?before=|after=&limit=&count=1  -> TimelinePage: one chat's
//        messages (a group chat opened in a person's panel), and `total` with count=1
//        Both page newest first: the newest, those older than before= (a page's nextBefore), or with after= (a page's
//        nextAfter, or a moment as <ms>:0) those just newer, with nextAfter for the next newer page (content.ts
//        PageOptions), so a chat can open at a moment (the Table's When) and scroll both ways; 400 with both
//   GET  /api/archive/content/conversations/:id/days/:day?after=&limit=  -> DayMessagesPage: one chat's messages on
//        one local day (YYYY-MM-DD), oldest first, up to 5000 a page from `after` (the Calendar view's day);
//        system messages left out
//   GET  /api/archive/content/search?q=&person=&platform=&limit=            -> SearchHit[]
//   GET  /api/archive/content/attachments/:id     -> the attachment's file (HEAD too), with its
//        MIME type and single byte ranges (206) so video and audio can seek; 404 if the file is missing
//   POST /api/archive/content/conversations/:id/send {text} -> SendResult: sends a text message into a
//        direct chat through its connector (the only way anything is sent; see send.ts); 409 while sending
//        is turned off (send.ts SENDING, off for now), and when that connector is not connected. The
//        message then arrives through sync like any other.
//
// When the archive could not be opened, every route answers 503 and the rest
// of the app works as before.

//
// Each request is one Effect program (archiveRoute), run by the server with its services (jsonApi.ts's serve): the
// archive (friendMap.ts's FriendMap) and the AI service that writes queries (AiService). The rules it calls stay plain and throw
// the route errors (errors.ts), which it answers (answering).

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Effect, Stream } from "effect";
import { AiService, answering, ARCHIVE_TAG, sendRanged, type CallAnsweredSaved, type CallLengthSaved, type CallNoteSaved, type Capability, type CatchUpSaved, type Contract, CONTRACT_VERSION, ForbiddenError, fromOwnPage, type GroupUnlinkSaved, InvalidInputError, type ListedCall, LOCALE, type LoggedCall, type ManualCallSaved, NotFoundError, type PersonAdded, type PersonSaved, readJson, type ReadScope, type Route, type RouteError, sendJson, type TagsChanged, type TagsSaved, TIME_ZONE, UnavailableError } from "../../../sdk/server.ts";
import { listCalls, loggedCall, setCallAnswered, setCallLength, setCallNote } from "./calls.ts";
import type { AttachmentFile } from "./content.ts";
import { contentRead } from "./contentReads.ts";
import type { FriendMap as Archive } from "./friendMap.ts";
import { queryResult } from "./query.ts";
import { aiQueryModel, writeQuery } from "./queryWriter.ts";
import { matchQuery } from "./sqlQuery.ts";

export const CONTENT_PREFIX = "/api/archive/content/";

/** What of friend-map's contract the archive serves: all of it but `scores`, which friend-map's server adds. */
export const SERVED: Capability[] = [
  "map", "score-report", "query", "query.sql", "query.generate", "panel", "content", "table", "calendar", "river",
  "events", "identity", "changes", "drafts", "send", "map-facts",
  "edit.people", "edit.tags", "edit.identity", "edit.hangouts", "edit.calls", "edit.groups", "edit.undo",
];

/** The handshake (friend-map's docs/contract.md): the contract version served, its capabilities, the time zone days are counted in and the locale. */
export const archiveContract = (): Contract => ({ version: CONTRACT_VERSION, capabilities: SERVED, timeZone: TIME_ZONE, locale: LOCALE });

/** The archive's routes. Generate writes its queries with the AI service. */
export const archiveRoute = (archive: Archive): Route<RouteError, AiService> => (req, res) =>
  Effect.gen(function* () {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith(CONTENT_PREFIX)) yield* contentRoute(archive, url, req, res);
    else yield* structureRoute(archive, url, req, res);
  }).pipe(answering(NotFoundError, InvalidInputError, UnavailableError, ForbiddenError));

const structureRoute = Effect.fnUntraced(function* (archive: Archive, url: URL, req: IncomingMessage, res: ServerResponse) {
  const path = url.pathname.slice("/api/archive".length);
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") yield* fromOwnPage(req);
  const { structure, people } = archive;
  const { tags } = people;
  const body = Effect.map(readJson(req), (input) => (input ?? {}) as Record<string, unknown>);
  /** Every edit from the app is one changeset in the change log (changes.ts). */
  const recorded = <T>(action: string, work: () => T) => archive.changes.record({ surface: "app", action }, work);
  const edit = <T>(action: string, work: () => T): T => recorded(action, work).value;
  /** A change to the tag table, answered with the tags after it and its changeset (for the page's chip to undo). */
  const tagsChanged = (action: string, work: () => unknown): TagsChanged => ({ changeset: recorded(action, work).changeset, tags: tags.list() });
  const summary = (id: number) => {
    const person = structure.getPerson(id);
    return person ? Effect.succeed(person) : Effect.fail(new NotFoundError(`no person ${id}`));
  };
  let match: RegExpExecArray | null;

  if (path === "/contract" && method === "GET") return sendJson(res, 200, archiveContract());
  if (path === "/people" && method === "GET") {
    return sendJson(res, 200, structure.listPeople({
      query: param(url, "query"),
      tag: param(url, "tag"),
      reachOut: param(url, "reachOut") === "1",
      location: param(url, "location"),
    }));
  }
  if (path === "/people" && method === "POST") {
    const input = yield* body;
    const sameName = input.anyway === true ? [] : yield* Effect.forEach(people.sameNamed(input.name), (id) =>
      Effect.map(summary(id), ({ name, aliases }) => ({ id, name, aliases })));
    if (sameName.length > 0) return sendJson(res, 200, { person: null, changeset: null, sameName } satisfies PersonAdded);
    const { value: id, changeset } = recorded("person new", () => people.add(input));
    return sendJson(res, 200, { person: yield* summary(id), changeset, sameName } satisfies PersonAdded);
  }
  if ((match = /^\/people\/(\d+)$/.exec(path)) && method === "GET") return sendJson(res, 200, yield* summary(Number(match[1])));
  if ((match = /^\/people\/(\d+)\/(names|tags|note|should-reach-out|location|identicon)$/.exec(path)) && method === "PUT") {
    const input = yield* body;
    const id = Number(match[1]);
    const field = match[2];
    if (field === "tags") {
      const before = new Set(tags.list().map((tag) => tag.name));
      const { value, changeset } = recorded("person tags", () => people.setTags(id, input.tags));
      const after = new Set(tags.list().map((tag) => tag.name));
      const saved: TagsSaved = {
        person: yield* summary(value),
        changeset,
        created: [...after].filter((name) => !before.has(name)),
        deleted: [...before].filter((name) => !after.has(name)),
      };
      return sendJson(res, 200, saved);
    }
    if (field === "names" || field === "location" || field === "identicon") {
      const { value, changeset } = recorded(`person ${field}`, () =>
        field === "names" ? people.setNames(id, input.names)
          : field === "location" ? people.setLocation(id, input.location)
          : people.setIdenticon(id, input.seed, input.hue));
      return sendJson(res, 200, { person: yield* summary(value), changeset } satisfies PersonSaved);
    }
    const done = edit(`person ${field}`, () => field === "note" ? people.setNote(id, input.note)
      : people.setShouldReachOut(id, input.shouldReachOut));
    return sendJson(res, 200, yield* summary(done));
  }
  if ((match = /^\/people\/(\d+)\/merge$/.exec(path)) && method === "POST") {
    const other = ((yield* readJson(req)) as { with?: unknown } | null)?.with;
    if (!Number.isSafeInteger(other)) return yield* new InvalidInputError("with must be a person id");
    return sendJson(res, 200, yield* summary(edit("merge", () => people.merge(Number(match![1]), other as number))));
  }
  if ((match = /^\/people\/(\d+)\/accounts\/(\d+)\/detach$/.exec(path)) && method === "POST") {
    edit("detach", () => people.detach(Number(match![1]), Number(match![2])));
    return sendJson(res, 200, yield* summary(Number(match[1])));
  }
  if (path === "/catch-ups" && method === "GET") {
    return sendJson(res, 200, people.catchUps.list({ personId: yield* numberParam(url, "person") }));
  }
  if (path === "/catch-ups" && method === "POST") {
    const input = yield* body;
    const { value: id, changeset } = recorded("catch-up add", () => people.addCatchUp(input));
    return sendJson(res, 200, { catchUp: people.catchUps.get(id), changeset });
  }
  if ((match = /^\/catch-ups\/(\d+)$/.exec(path)) && method === "PUT") {
    const id = Number(match[1]);
    const input = yield* body;
    const { changeset } = recorded("catch-up change", () => people.changeCatchUp(id, input));
    return sendJson(res, 200, { catchUp: people.catchUps.get(id), changeset });
  }
  if ((match = /^\/catch-ups\/(\d+)$/.exec(path)) && method === "DELETE") {
    const id = Number(match[1]);
    const { changeset } = recorded("catch-up delete", () => people.deleteCatchUp(id));
    return sendJson(res, 200, { catchUp: null, changeset });
  }
  if ((match = /^\/catch-ups\/(\d+)\/call$/.exec(path)) && method === "POST") {
    const id = Number(match[1]);
    const input = yield* body;
    const { value: made, changeset } = recorded("catch-up to call", () => people.catchUpToCall(id, input));
    return sendJson(res, 200, { call: loggedCall(archive.db, made), changeset } satisfies ManualCallSaved);
  }
  if (path === "/calls" && method === "GET") return sendJson(res, 200, listCalls(archive.db) satisfies ListedCall[]);
  if (path === "/call-notes" && method === "PUT") {
    const { call, note } = yield* body;
    const { value, changeset } = recorded("call note", () => setCallNote(archive.db, people.manualCalls, call, note));
    return sendJson(res, 200, { ...value, changeset } satisfies CallNoteSaved);
  }
  if (path === "/call-answered" && method === "PUT") {
    const { call, answered } = yield* body;
    const { value, changeset } = recorded("call answered", () => setCallAnswered(archive.db, call, answered));
    return sendJson(res, 200, { ...value, changeset } satisfies CallAnsweredSaved);
  }
  if (path === "/calls" && method === "POST") {
    const input = yield* body;
    const { value: id, changeset } = recorded("call add", () => people.addCall(input));
    return sendJson(res, 200, { call: loggedCall(archive.db, id), changeset } satisfies ManualCallSaved);
  }
  if ((match = /^\/calls\/(\d+)$/.exec(path)) && method === "GET") {
    return sendJson(res, 200, people.manualCalls.loggedCall(Number(match[1])) satisfies LoggedCall);
  }
  if ((match = /^\/calls\/(\d+)$/.exec(path)) && method === "PUT") {
    const id = Number(match[1]);
    const group = people.manualCalls.get(id).call_group;
    const input = yield* body;
    const { changeset } = recorded("call change", () => people.changeCall(id, input));
    return sendJson(res, 200, { call: loggedCall(archive.db, people.manualCalls.firstOf(group)), changeset } satisfies ManualCallSaved);
  }
  if ((match = /^\/calls\/(\d+)\/catch-up$/.exec(path)) && method === "POST") {
    const id = Number(match[1]);
    const input = yield* body;
    const { value: made, changeset } = recorded("call to catch-up", () => people.callToCatchUp(id, input));
    return sendJson(res, 200, { catchUp: people.catchUps.get(made), changeset } satisfies CatchUpSaved);
  }
  if ((match = /^\/calls\/(\d+)$/.exec(path)) && method === "DELETE") {
    const id = Number(match[1]);
    const { changeset } = recorded("call delete", () => people.deleteCall(id));
    return sendJson(res, 200, { call: null, changeset } satisfies ManualCallSaved);
  }
  if ((match = /^\/people\/(\d+)\/drafts$/.exec(path)) && method === "GET") return sendJson(res, 200, people.drafts.list(Number(match[1])));
  if ((match = /^\/people\/(\d+)\/drafts$/.exec(path)) && method === "POST") {
    const { text } = yield* body;
    return sendJson(res, 200, people.drafts.add(Number(match[1]), text));
  }
  if ((match = /^\/drafts\/(\d+)$/.exec(path)) && method === "PUT") {
    const { text } = yield* body;
    return sendJson(res, 200, people.drafts.set(Number(match[1]), text));
  }
  if ((match = /^\/drafts\/(\d+)$/.exec(path)) && method === "DELETE") {
    people.drafts.remove(Number(match[1]));
    res.writeHead(204).end();
    return;
  }
  if ((match = /^\/messages\/(\d+)\/call-length$/.exec(path)) && method === "PUT") {
    const { minutes } = yield* body;
    const { value: call, changeset } = recorded("call length", () => setCallLength(archive.db, Number(match![1]), minutes ?? null));
    return sendJson(res, 200, { call, changeset } satisfies CallLengthSaved);
  }
  if (path === "/tags" && method === "GET") return sendJson(res, 200, tags.list());
  if (path === "/tags" && method === "POST") {
    const { name } = yield* body;
    return sendJson(res, 200, tagsChanged("tag add", () => tags.create(name)));
  }
  if ((match = /^\/tags\/([^/]+)$/.exec(path)) && method === "PUT") {
    const { name } = yield* body;
    return sendJson(res, 200, tagsChanged("tag rename", () => tags.rename(decodeURIComponent(match![1]), name)));
  }
  if ((match = /^\/tags\/([^/]+)$/.exec(path)) && method === "DELETE") {
    return sendJson(res, 200, tagsChanged("tag delete", () => tags.delete(decodeURIComponent(match![1]))));
  }
  if ((match = /^\/tags\/([^/]+)\/position$/.exec(path)) && method === "PUT") {
    const { position } = yield* body;
    if (typeof position !== "number") return yield* new InvalidInputError("position must be a number");
    return sendJson(res, 200, tagsChanged("tag move", () => tags.move(decodeURIComponent(match![1]), position)));
  }
  if (path === "/locations" && method === "GET") return sendJson(res, 200, people.locations.list());
  if ((match = /^\/locations\/([^/]+)$/.exec(path)) && method === "PUT") {
    const { name } = yield* body;
    edit("location rename", () => people.locations.rename(decodeURIComponent(match![1]), name));
    return sendJson(res, 200, people.locations.list());
  }
  if (path === "/events" && method === "GET") return yield* streamChanges(archive, res);
  if (path === "/changes" && method === "GET") return sendJson(res, 200, archive.changes.list({ limit: yield* numberParam(url, "limit") }));
  if ((match = /^\/changes\/(\d+)$/.exec(path)) && method === "GET") return sendJson(res, 200, archive.changes.show(Number(match[1])));
  if ((match = /^\/changes\/(\d+)\/undo$/.exec(path)) && method === "POST") {
    // An undo can put back a great deal, so only friend-map's own page may ask.
    yield* sameSiteOnly(req);
    return sendJson(res, 200, archive.changes.undo(Number(match[1]), { surface: "app" }).value);
  }
  if (path === "/merge-proposals" && method === "GET") return sendJson(res, 200, structure.proposals());
  if ((match = /^\/merge-proposals\/(\d+)\/(confirm|reject)$/.exec(path)) && method === "POST") {
    const proposal = Number(match[1]);
    if (match[2] === "confirm") return sendJson(res, 200, yield* summary(edit(`confirm proposal ${proposal}`, () => people.confirm(proposal))));
    edit(`reject proposal ${proposal}`, () => people.reject(proposal));
    res.writeHead(204).end();
    return;
  }
  if (path === "/coverage" && method === "GET") return sendJson(res, 200, structure.coverage());
  if (path === "/relationships" && method === "GET") {
    const reveal = yield* revealParam(param(url, "reveal"));
    return sendJson(res, 200, structure.relationships(Date.now(), yield* revealed(archive, url.searchParams.get("q") ?? "", reveal)));
  }
  if (path === "/message-apps" && method === "GET") return sendJson(res, 200, structure.messageApps());
  if (path === "/table-rows" && method === "GET") return sendVersioned(req, res, archive, () => structure.tableRows());
  if (path === "/score-report" && method === "GET") return sendVersioned(req, res, archive, () => structure.scoreReport());
  if (path === "/map-facts" && method === "GET") return sendJson(res, 200, structure.mapFacts());
  if ((match = /^\/calendar\/([^/]+)$/.exec(path)) && method === "GET") {
    const when = decodeURIComponent(match[1]);
    if (/^\d{4}-\d{2}$/.test(when)) return sendJson(res, 200, archive.days.month(when));
    if (/^\d{4}-\d{2}-\d{2}$/.test(when)) return sendJson(res, 200, archive.days.day(when));
    return yield* new InvalidInputError(`give a month, written YYYY-MM, or a day, YYYY-MM-DD, not ${JSON.stringify(when)}`);
  }
  if (path === "/connectors" && method === "GET") return sendJson(res, 200, yield* Effect.promise(() => archive.live.host.statuses()));
  if ((match = /^\/people\/(\d+)\/send-targets$/.exec(path)) && method === "GET") return sendJson(res, 200, archive.sends.targets(Number(match[1])));
  if ((match = /^\/people\/(\d+)\/calls$/.exec(path)) && method === "GET") {
    const calls = structure.calls(Number(match[1]), yield* numberParam(url, "account"));
    if (!calls) return yield* new NotFoundError(`no person ${match[1]}`);
    return sendJson(res, 200, calls);
  }
  if ((match = /^\/people\/(\d+)\/groups$/.exec(path)) && method === "GET") {
    const groups = structure.groupsOf(Number(match[1]));
    if (!groups) return yield* new NotFoundError(`no person ${match[1]}`);
    return sendJson(res, 200, groups);
  }
  if ((match = /^\/people\/(\d+)\/groups\/(\d+)\/unlinked$/.exec(path)) && method === "PUT") {
    const id = Number(match[1]);
    const group = Number(match[2]);
    const { unlinked } = yield* body;
    if (typeof unlinked !== "boolean") return yield* new InvalidInputError("unlinked must be true or false");
    const { changeset } = recorded(unlinked ? "group unlink" : "group link", () =>
      unlinked ? people.unlinkFromGroup(group, id) : people.linkToGroup(group, id));
    return sendJson(res, 200, { unlinked, changeset } satisfies GroupUnlinkSaved);
  }
  if ((match = /^\/groups\/(\d+)$/.exec(path)) && method === "GET") {
    const group = structure.group(Number(match[1]));
    if (!group) return yield* new NotFoundError(`no group chat ${match[1]}`);
    return sendJson(res, 200, group);
  }
  if ((match = /^\/groups\/(\d+)\/archive-untouched$/.exec(path)) && method === "POST") {
    // It archives many at once, so only friend-map's own page may ask, as for an undo.
    yield* sameSiteOnly(req);
    const id = Number(match[1]);
    const { people: shown } = yield* body;
    if (!Array.isArray(shown) || !shown.every(Number.isSafeInteger)) return yield* new InvalidInputError("people must be the person ids shown");
    // Thrown inside the changeset, so nothing it began is kept; answered as any rule's error is.
    const { value: archived, changeset } = recorded(`archive untouched in group ${id}`, () => {
      const group = structure.group(id);
      if (!group) throw new NotFoundError(`no group chat ${id}`);
      const untouched = group.members.filter((member) => member.untouched && !member.archived).map((member) => member.id);
      const asked = new Set(shown as number[]);
      if (asked.size !== untouched.length || !untouched.every((person) => asked.has(person))) {
        throw new UnavailableError("who is untouched in this group has changed since it was shown; look again");
      }
      for (const person of untouched) people.addTags(person, [ARCHIVE_TAG]);
      return untouched.length;
    });
    return sendJson(res, 200, { archived, changeset });
  }
  if (path === "/query" && method === "GET") {
    const queryable = structure.queryable();
    const ids = yield* Effect.promise(() => matchQuery(archive.db, url.searchParams.get("q") ?? "", queryable));
    return sendJson(res, 200, queryResult(ids, queryable.people, url.searchParams.getAll("hide")));
  }
  if (path === "/query/generate" && method === "POST") {
    // It sends what the captain said to a cloud model, so only friend-map's own page may ask.
    yield* sameSiteOnly(req);
    const { query, transcript } = yield* body;
    if (typeof transcript !== "string") return yield* new InvalidInputError("transcript must be text");
    if (query !== undefined && typeof query !== "string") return yield* new InvalidInputError("query must be text");
    const model = aiQueryModel(yield* AiService);
    const queryable = structure.queryable();
    return sendJson(res, 200, yield* Effect.promise(() => writeQuery(model, { current: query ?? "", transcript, ...queryable }, (text) => matchQuery(archive.db, text, queryable))));
  }
  return yield* new NotFoundError(`no route ${method} ${url.pathname}`);
});

/** This process, in every ETag, so a copy kept from before a restart (and so from older code) is never taken as current. */
const PROCESS = randomUUID();

/**
 * Answers with `body()` as JSON, tagged with the archive's version (people and links, which change with everything
 * the score report and the table's rows hold), or 304 when the request's If-None-Match names that version. The version
 * is read before the body, so a body is never older than its tag.
 */
function sendVersioned(req: IncomingMessage, res: ServerResponse, archive: Archive, body: () => unknown): void {
  const etag = `"${PROCESS}.${archive.people.version()}.${archive.people.linksVersion()}"`;
  const headers = { etag, "cache-control": "no-cache" };
  if ((req.headers["if-none-match"] ?? "").split(",").some((tag) => tag.trim() === etag)) {
    res.writeHead(304, headers).end();
    return;
  }
  res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body()));
}

/** How often the server looks for people changed by another process (the CLI, say). */
export const WATCH_MS = 1000;

/** What the change stream compares: the archive's people and links versions. */
export interface Versions {
  people: string;
  links: string;
}

/**
 * The change stream's events, one look every WATCH_MS from the versions when it starts: `people` when anyone's people
 * changed since the last look; else `messages` when only what the messages add up to changed (a live batch with no one
 * new), which pages follow with far less than everything.
 */
export const changeEvents = (versions: () => Versions): Stream.Stream<string> =>
  Stream.tick(WATCH_MS).pipe(
    Stream.map(versions),
    Stream.mapAccum((): Versions | null => null, (seen, now): readonly [Versions, string[]] => {
      if (seen === null) return [now, []];
      if (now.people !== seen.people) return [now, [`event: people\ndata: ${JSON.stringify(now.people)}\n\n`]];
      if (now.links !== seen.links) return [now, [`event: messages\ndata: ${JSON.stringify(now.links)}\n\n`]];
      return [now, []];
    }),
  );

/** The page's change stream (an event stream of changeEvents), until the page closes it. */
const streamChanges = (archive: Archive, res: ServerResponse): Effect.Effect<void> =>
  Effect.suspend(() => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    // A comment line, so the browser sees the stream open straight away.
    res.write(": watching people\n\n");
    return changeEvents(() => ({ people: archive.people.version(), links: archive.people.linksVersion() })).pipe(
      Stream.interruptWhen(closed(res)),
      Stream.runForEach((event) => Effect.sync(() => void res.write(event))),
    );
  });

/** Done once the response has closed: sent, or its connection ended (the page closed, the server stopping). */
const closed = (res: ServerResponse): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (res.closed) return resume(Effect.void);
    const done = () => resume(Effect.void);
    res.once("close", done);
    return Effect.sync(() => void res.off("close", done));
  });

const contentRoute = Effect.fnUntraced(function* (archive: Archive, url: URL, req: IncomingMessage, res: ServerResponse) {
  const path = url.pathname.slice(CONTENT_PREFIX.length - 1);
  const method = req.method ?? "GET";
  /** Keeps a read in the trail (contentLog.ts) before it is answered: the app's page, which names no reader. */
  const read = (what: string, scope: ReadScope) => archive.live.contentLog.record({ surface: "app", reader: null, what, scope });
  let match: RegExpExecArray | null;
  if ((match = /^\/attachments\/(\d+)$/.exec(path)) && (method === "GET" || method === "HEAD")) {
    const file = yield* Effect.promise(() => archive.content.attachmentFile(Number(match![1])));
    if (!file) return yield* new NotFoundError(`attachment ${match[1]} has no file`);
    // By chat, so a chat's photos as they scroll in, or a video seeking, are one row.
    if (method === "GET") read("attachments", { conversation: file.conversation });
    return yield* Effect.promise(() => sendFile(req, res, file));
  }
  if ((match = /^\/conversations\/(\d+)\/send$/.exec(path)) && method === "POST") {
    yield* sameSiteOnly(req);
    const { text } = ((yield* readJson(req)) ?? {}) as { text?: unknown };
    return sendJson(res, 200, yield* Effect.promise(() => archive.sends.send(Number(match![1]), text)));
  }
  if (method !== "GET") return yield* new NotFoundError(`no route ${method} ${url.pathname}`);
  // The reads (a timeline, a chat, a day of it, a search), as contentReads.ts answers them, each kept in the trail first.
  const answered = contentRead(archive.content, path, url);
  if (answered === null) return yield* new NotFoundError(`no route GET ${url.pathname}`);
  read(answered.what, answered.scope);
  return sendJson(res, 200, answered.answer);
});

/**
 * Refuses a request another web site could have made the browser send. A
 * page anywhere can post a form to localhost with no preflight, so sending
 * messages takes a JSON body (which a cross-site page cannot send without
 * CORS, which this server never grants) and, when the browser names where
 * the request came from, this server itself.
 */
const sameSiteOnly = (req: IncomingMessage): Effect.Effect<void, InvalidInputError | ForbiddenError> =>
  /^application\/json\b/i.test(req.headers["content-type"] ?? "")
    ? fromOwnPage(req)
    : Effect.fail(new InvalidInputError("the body must be JSON (content-type: application/json)"));

/** Types a browser may show in the page; anything else is only offered as a download. */
const INLINE_TYPES = /^(image\/(jpeg|png|webp|gif|heic)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf)$/;

/** An attachment's file, a byte range at a time so video and audio can seek (server/byteRanges.ts). */
function sendFile(req: IncomingMessage, res: ServerResponse, file: AttachmentFile): Promise<void> {
  const inline = INLINE_TYPES.test(file.mime);
  return sendRanged(req, res, file.path, file.size, {
    "content-type": inline ? file.mime : "application/octet-stream",
    "content-disposition": inline ? "inline" : "attachment",
    "x-content-type-options": "nosniff",
    // Files are named by content hash and an attachment's file never changes once stored.
    "cache-control": "private, max-age=31536000, immutable",
  });
}

/** Whether the map's Hide shows archived people: "archive" (everyone archived, by the captain or the rules), or nothing. */
function revealParam(value: string | undefined): Effect.Effect<boolean, InvalidInputError> {
  if (value && value !== ARCHIVE_TAG) return Effect.fail(new InvalidInputError(`reveal takes ${ARCHIVE_TAG}, not ${JSON.stringify(value)}`));
  return Effect.succeed(value === ARCHIVE_TAG);
}

/**
 * The archived people the map shows with `reveal`: those query `q` matches (everyone when empty), archived by the
 * captain or by the rules. A query that does not run shows none: the Query bar says why.
 */
const revealed = (archive: Archive, q: string, reveal: boolean): Effect.Effect<Set<number>> =>
  Effect.gen(function* () {
    if (!reveal) return new Set<number>();
    const queryable = archive.structure.queryable();
    const matched = yield* Effect.promise(() => matchQuery(archive.db, q, queryable)).pipe(
      answering(InvalidInputError),
      Effect.map((ids) => new Set(ids)),
      Effect.catchTag("InvalidInputError", () => Effect.succeed(new Set<number>())),
    );
    return new Set(queryable.people
      .filter((person) => person.archived !== null && matched.has(person.id))
      .map((person) => person.id));
  });

function param(url: URL, name: string): string | undefined {
  return url.searchParams.get(name) || undefined;
}

function numberParam(url: URL, name: string): Effect.Effect<number | undefined, InvalidInputError> {
  const value = param(url, name);
  if (value === undefined) return Effect.succeed(undefined);
  if (!/^\d+$/.test(value)) return Effect.fail(new InvalidInputError(`${name} must be a whole number`));
  return Effect.succeed(Number(value));
}
